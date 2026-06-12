# Chương 31: Amazon DynamoDB cơ bản

> **Trọng tâm DVA-C02:** DynamoDB là một trong những dịch vụ bị hỏi nhiều nhất trong đề. Câu hỏi tập trung vào: chọn partition key tránh hot partition, **tính RCU/WCU** cho provisioned mode (dạng số học bắt buộc tính được), phân biệt eventually vs strongly consistent read (tốn capacity khác nhau), khi nào dùng Query vs Scan, on-demand vs provisioned mode, và đọc/hiểu code SDK v3 với `lib-dynamodb` (DocumentClient). Một số câu xử lý `ProvisionedThroughputExceededException` và batch operations.

## Mục tiêu chương

- Hiểu DynamoDB là NoSQL key-value/document store như thế nào, khác RDBMS ở đâu, và khi nào chọn DynamoDB thay vì RDS.
- Nắm vững mô hình dữ liệu: table, item, attribute, primary key (partition key vs composite key), và cơ chế partitioning bên dưới quyết định performance.
- Chọn partition key tốt: cardinality cao, phân tán đều, tránh hot partition — trả lời được mọi biến thể câu hỏi thiết kế key.
- **Tính chính xác RCU/WCU** cho provisioned capacity, hiểu chi phí của strongly vs eventually consistent read và transactional read/write.
- Phân biệt provisioned vs on-demand, hiểu auto scaling, burst capacity, adaptive capacity và cách xử lý throttling.
- Dùng thành thạo các API cơ bản (PutItem, GetItem, UpdateItem, DeleteItem, Batch operations) và phân biệt Query vs Scan bằng code SDK v3 chạy được.

## 31.1 NoSQL vs RDBMS — khi nào chọn DynamoDB

DynamoDB là một **fully managed, serverless, key-value và document NoSQL database** do AWS vận hành. "Serverless" ở đây nghĩa thật: không có instance để chọn, không patching, không quản lý storage — bạn tạo table và dùng. AWS tự nhân bản dữ liệu **synchronously qua 3 Availability Zone** trong một Region, cho durability và availability rất cao mà không cần cấu hình Multi-AZ như RDS (chi tiết RDS ở Chương 8).

Khác biệt cốt lõi so với RDBMS nằm ở triết lý thiết kế:

| Tiêu chí | RDBMS (RDS/Aurora) | DynamoDB (NoSQL) |
|---|---|---|
| Schema | Cố định, định nghĩa trước (cột, kiểu) | Schema-less — mỗi item có attribute riêng (trừ primary key) |
| Quan hệ & JOIN | Có JOIN, foreign key | **Không có JOIN** — denormalize, thiết kế theo access pattern |
| Query language | SQL (linh hoạt, ad-hoc) | Query theo key + PartiQL (giới hạn, không ad-hoc tùy ý) |
| Scaling | Vertical (scale up instance) + read replica | **Horizontal** — tự phân mảnh, scale gần như vô hạn |
| Performance | Latency ms, biến động theo tải | Single-digit millisecond ổn định ở mọi quy mô |
| Mô hình giá | Theo instance-hour | Theo throughput (RCU/WCU) + storage |

Điểm mấu chốt cho đề thi và thực tế: với DynamoDB bạn **thiết kế dữ liệu theo access pattern, không theo entity-relationship**. Bạn phải biết trước "ứng dụng sẽ query gì" rồi mới thiết kế key. Đây là tư duy ngược với RDBMS (normalize trước, query sau).

Chọn DynamoDB khi: cần latency thấp ổn định ở scale lớn, traffic không đoán trước hoặc spike mạnh (on-demand), workload key-value đơn giản (session, user profile, shopping cart, IoT data, leaderboard metadata), và muốn **zero operational overhead** (từ khóa đề thi: "least operational overhead" thường trỏ về serverless như DynamoDB). Tránh DynamoDB khi cần query ad-hoc phức tạp, JOIN nhiều bảng, hoặc transaction quan hệ phức tạp với nhiều ràng buộc — lúc đó RDS/Aurora phù hợp hơn.

> 💡 **Exam Tip:** Khi đề mô tả "needs a serverless database with single-digit millisecond latency at any scale" hoặc "unpredictable, spiky traffic with no capacity planning" → DynamoDB on-demand. Nếu đề nói "complex queries with JOINs" hoặc "relational data with strong relational integrity" → RDS/Aurora, KHÔNG phải DynamoDB.

## 31.2 Tables, items, attributes — mô hình dữ liệu

Ba khái niệm nền tảng, ánh xạ lỏng sang RDBMS:

- **Table** ≈ bảng. Là tập hợp các item. Table sống trong một Region.
- **Item** ≈ một dòng (row). Mỗi item được định danh duy nhất bằng primary key. Một item tối đa **400 KB** (tính cả tên attribute lẫn giá trị) — đây là hard limit hay bị hỏi.
- **Attribute** ≈ một cột (column), nhưng schema-less: hai item trong cùng table có thể có tập attribute hoàn toàn khác nhau, miễn là cùng có primary key.

DynamoDB hỗ trợ các kiểu dữ liệu (data types):

- **Scalar**: String (S), Number (N), Binary (B), Boolean (BOOL), Null (NULL).
- **Document**: List (L), Map (M) — cho nested JSON.
- **Set**: String Set (SS), Number Set (NS), Binary Set (BS) — tập các giá trị không trùng lặp, không có thứ tự.

Ở định dạng "wire" gốc (low-level), mỗi giá trị được bọc bằng descriptor kiểu:

```json
{
  "UserId":   { "S": "u#1001" },
  "Email":    { "S": "alice@example.com" },
  "Age":      { "N": "29" },
  "IsActive": { "BOOL": true },
  "Tags":     { "SS": ["vip", "early-adopter"] },
  "Address":  { "M": { "City": { "S": "Hanoi" }, "Zip": { "S": "100000" } } }
}
```

Cái `{ "N": "29" }` — số được truyền dưới dạng **string** trong wire format để bảo toàn độ chính xác — là lý do người ta thích dùng `lib-dynamodb` (DocumentClient) để khỏi phải tự marshalling (xem 31.8).

## 31.3 Primary key: partition key vs composite key

Primary key là thứ định danh item và quyết định **cách dữ liệu được phân bố vật lý**. DynamoDB có hai loại:

**1. Partition key (simple primary key):** chỉ một attribute, ví dụ `UserId`. DynamoDB băm (hash) giá trị partition key qua một hàm hash nội bộ để quyết định item nằm ở **partition** (đơn vị lưu trữ vật lý) nào. Mỗi giá trị partition key phải **duy nhất** trong table.

**2. Composite primary key (partition key + sort key):** hai attribute, ví dụ `(UserId, OrderId)`. Tất cả item cùng partition key được lưu **cùng một partition**, sắp xếp vật lý theo sort key. Lúc này partition key có thể trùng giữa các item, nhưng cặp **(partition key, sort key) phải duy nhất**.

Sort key (còn gọi range key) là thứ mở khóa sức mạnh thật của DynamoDB: trong một partition, các item được sắp theo sort key, nên bạn có thể Query kiểu "lấy tất cả order của user `u#1001` có `OrderDate` từ `2026-01` đến `2026-03`" cực nhanh, hoặc "lấy 10 order mới nhất". Đây là pattern item collection — nhóm các item liên quan dưới cùng partition key.

```bash
# Tạo table với composite key qua AWS CLI v2
aws dynamodb create-table \
  --table-name Orders \
  --attribute-definitions \
      AttributeName=UserId,AttributeType=S \
      AttributeName=OrderId,AttributeType=S \
  --key-schema \
      AttributeName=UserId,KeyType=HASH \
      AttributeName=OrderId,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST
```

Lưu ý: `--attribute-definitions` CHỈ khai báo các attribute dùng trong key schema (và index), KHÔNG phải toàn bộ attribute của item — vì table schema-less. `KeyType=HASH` là partition key, `KeyType=RANGE` là sort key (tên di sản từ thuật ngữ hash/range key).

> 💡 **Exam Tip:** "HASH" = partition key, "RANGE" = sort key trong API/CLI. Nhớ rằng với composite key, item KHÔNG cần partition key duy nhất — chỉ cần cặp (partition + sort) duy nhất. Câu hỏi hay gài: "lấy nhiều item trong một lần Query" chỉ làm được khi chúng share cùng partition key (cùng item collection).

## 31.4 Chọn partition key tốt — hot partition và cardinality

Đây là chủ đề thiết kế quan trọng nhất của chương. DynamoDB chia table thành nhiều **partition** vật lý; mỗi partition lưu được tối đa **10 GB** dữ liệu và phục vụ tối đa **3000 RCU + 1000 WCU**. Hàm hash trên partition key quyết định item rơi vào partition nào. Throughput của table được chia đều cho các partition.

Hệ quả: nếu nhiều request dồn vào **cùng một partition key** (hoặc một nhóm nhỏ key), partition đó bị quá tải trong khi các partition khác rảnh — đây là **hot partition**. Kết quả là throttling cục bộ dù table tổng thể chưa hết capacity.

Ví dụ thiết kế tệ: dùng `Status` (`ACTIVE`/`INACTIVE`) làm partition key — chỉ 2 giá trị, mọi item active dồn về một partition. Hay dùng `Date` (`2026-06-12`) làm partition key cho log: mọi log trong ngày dồn vào một key → hot partition kinh điển.

Tiêu chí partition key tốt:

- **High cardinality** (nhiều giá trị phân biệt): `UserId`, `DeviceId`, `OrderId` thay vì `Status`, `Country`, `Gender`.
- **Phân tán đều** request theo thời gian, không tập trung vào vài key.
- Nếu access pattern bắt buộc tập trung (ví dụ ghi nhiều theo ngày), dùng **write sharding**: thêm suffix ngẫu nhiên vào key, ví dụ `2026-06-12#3` (3 là số ngẫu nhiên 0..N) để rải ra N partition (chi tiết pattern này ở Chương 32).

DynamoDB có **adaptive capacity**: tự động phân phối lại throughput cho partition nóng (isolate hot item, dồn capacity về partition đang cần). Tính năng này bật mặc định và làm cho hot partition đỡ đau hơn xưa, nhưng **không phải phép màu** — partition vẫn trần 3000 RCU/1000 WCU, và một single hot item (một giá trị key bị đọc/ghi cực mạnh) vẫn có thể bị throttle.

> 💡 **Exam Tip:** Triệu chứng "một số request bị throttled dù total provisioned capacity còn dư" → hot partition do partition key cardinality thấp hoặc access không đều. Cách sửa đúng trong đề: chọn partition key high-cardinality / dùng write sharding, KHÔNG phải "tăng provisioned capacity" (vì capacity đã dư, tăng nữa cũng vô ích).

## 31.5 Capacity modes: provisioned (RCU/WCU) vs on-demand

DynamoDB tính tiền theo **throughput**, có hai chế độ:

### Provisioned mode — bạn khai báo trước RCU và WCU

- **WCU (Write Capacity Unit):** 1 WCU = **1 write/giây cho item tối đa 1 KB**. Item lớn hơn làm tròn LÊN bội số 1 KB. Ví dụ write item 3 KB tốn 3 WCU/write; item 0.5 KB vẫn tốn 1 WCU.
- **RCU (Read Capacity Unit):** 1 RCU = **1 strongly consistent read/giây cho item tối đa 4 KB**. Item lớn hơn làm tròn LÊN bội số 4 KB.
  - **Eventually consistent read** chỉ tốn **một nửa**: 1 RCU = 2 eventually consistent reads/giây cho item ≤ 4 KB.
  - **Transactional read** tốn **gấp đôi**: 1 transactional read item ≤ 4 KB tốn **2 RCU**. Tương tự transactional write tốn **2 WCU**.

Công thức tính (phải thuộc lòng cho đề):

```
RCU (strongly consistent) = (ceil(item_size_KB / 4)) × reads_per_second
RCU (eventually consistent) = (ceil(item_size_KB / 4)) × reads_per_second / 2  → làm tròn lên
WCU = (ceil(item_size_KB / 1)) × writes_per_second
```

**Ví dụ tính RCU:** ứng dụng cần 80 strongly consistent reads/giây, mỗi item 6 KB.
`ceil(6/4) = 2` đơn vị 4KB → `2 × 80 = 160 RCU`.
Nếu eventually consistent: `160 / 2 = 80 RCU`.

**Ví dụ tính WCU:** cần 100 writes/giây, mỗi item 9 KB.
`ceil(9/1) = 9` → `9 × 100 = 900 WCU`.

**Ví dụ transactional:** cần 10 transactional writes/giây, item 3 KB.
`ceil(3/1) = 3 WCU/write` × `2` (transactional) × `10 = 60 WCU`.

```bash
aws dynamodb create-table \
  --table-name Users \
  --attribute-definitions AttributeName=UserId,AttributeType=S \
  --key-schema AttributeName=UserId,KeyType=HASH \
  --billing-mode PROVISIONED \
  --provisioned-throughput ReadCapacityUnits=80,WriteCapacityUnits=100
```

Provisioned mode có **burst capacity**: DynamoDB tích lũy capacity chưa dùng trong **300 giây** (5 phút) gần nhất để hấp thụ spike ngắn. Đừng phụ thuộc vào burst — AWS có thể tiêu nó cho việc khác (background maintenance).

**Auto Scaling** cho provisioned: bạn đặt min/max và target utilization (mặc định 70%); DynamoDB dùng CloudWatch alarm để tự tăng/giảm RCU/WCU theo tải. Phù hợp khi traffic có pattern nhưng vẫn biến động — rẻ hơn on-demand nếu tải khá đều.

### On-demand mode — pay-per-request

Không khai báo capacity; trả tiền theo **số read/write request unit thực tế** (RRU/WRU, đơn vị tính giống RCU/WCU nhưng tính theo request thay vì theo giây). DynamoDB tự scale tức thì.

| Tiêu chí | Provisioned | On-demand |
|---|---|---|
| Capacity planning | Có (đặt RCU/WCU) | Không cần |
| Giá | Rẻ hơn khi tải đều, dự đoán được | Đắt hơn mỗi request nhưng không trả khi idle |
| Spike traffic | Cần auto scaling, có thể throttle khi spike đột ngột | Hấp thụ spike tốt (tới gấp đôi peak trước trong 30 phút) |
| Use case | Workload ổn định, production có baseline | Traffic mới/không đoán được, dev/test, spiky |
| Chuyển đổi | Đổi mode tối đa 1 lần / 24 giờ | Đổi mode tối đa 1 lần / 24 giờ |

> 💡 **Exam Tip:** Câu hỏi tính capacity là điểm dễ ăn nếu thuộc công thức. Bẫy thường gặp: (1) quên eventually consistent chỉ tốn nửa RCU; (2) quên transactional tốn gấp đôi; (3) làm tròn item size — LUÔN làm tròn LÊN (ceil) tới bội số 4KB cho read, 1KB cho write. "Unpredictable workload, no capacity management" → on-demand. "Steady, predictable traffic, cost-optimize" → provisioned + auto scaling.

## 31.6 Throttling và ProvisionedThroughputExceededException

Khi request vượt capacity đã cấp (hoặc đụng trần partition), DynamoDB trả lỗi **`ProvisionedThroughputExceededException`** (HTTP 400) — kèm throttling. Với on-demand, lỗi tương ứng là `ThrottlingException` khi vượt giới hạn account/table.

Nguyên nhân thường gặp:

- Vượt RCU/WCU đã provision (chưa bật auto scaling hoặc auto scaling chưa kịp tăng).
- Hot partition (đã nói ở 31.4) — local throttle dù table chưa hết capacity.
- GSI hết capacity → ảnh hưởng ngược lên ghi bảng chính (chi tiết GSI ở Chương 32).

Cách xử lý đúng:

1. **Exponential backoff + retry**: AWS SDK v3 đã tích hợp sẵn retry với backoff cho lỗi throttling (default mode retry tới 3 lần). Bạn có thể tăng `maxAttempts`:

```javascript
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

// SDK tự retry với exponential backoff khi gặp throttling
const client = new DynamoDBClient({
  region: "ap-southeast-1",
  maxAttempts: 5, // tăng số lần thử lại (mặc định 3)
});
```

2. **Bật auto scaling** hoặc chuyển on-demand nếu tải không đoán được.
3. **Sửa partition key** nếu là hot partition (gốc rễ vấn đề, không phải tăng capacity).
4. **Phân tán write** bằng write sharding.

> 💡 **Exam Tip:** Đáp án "implement exponential backoff and retry" gần như luôn là lựa chọn đúng cho câu xử lý throttling tạm thời. Nhưng nếu đề mô tả throttling kéo dài do thiết kế (low-cardinality key), đáp án đúng chuyển sang sửa key / sharding. Phân biệt: lỗi nhất thời → backoff; lỗi hệ thống → sửa design hoặc đổi mode.

## 31.7 Các API ghi/đọc cơ bản: Put, Get, Update, Delete và Batch

DynamoDB là API-based — mọi thao tác qua HTTPS API. Nhóm thao tác trên một item:

- **PutItem**: tạo mới hoặc **ghi đè toàn bộ** item có cùng primary key. Mặc định overwrite; muốn chỉ tạo khi chưa tồn tại thì dùng `ConditionExpression: attribute_not_exists(PK)` (conditional write, chi tiết ở Chương 32).
- **GetItem**: đọc một item theo primary key. Mặc định **eventually consistent**; muốn strongly consistent thì set `ConsistentRead: true` (tốn gấp đôi RCU). Dùng `ProjectionExpression` để chỉ lấy vài attribute (tiết kiệm băng thông, KHÔNG tiết kiệm RCU — RCU tính trên kích thước item đọc từ disk).
- **UpdateItem**: cập nhật attribute của item (hoặc tạo mới nếu chưa có — upsert). Dùng `UpdateExpression` với các động từ: `SET`, `REMOVE`, `ADD`, `DELETE`. Hỗ trợ **atomic counter**: `SET views = views + :inc` (chi tiết ở Chương 32).
- **DeleteItem**: xóa item theo primary key, có thể kèm `ConditionExpression`.

Nhóm batch (giảm số round-trip):

- **BatchGetItem**: đọc tới **100 item** hoặc tối đa **16 MB** mỗi lần, từ một hoặc nhiều table. Trả về `UnprocessedKeys` cho phần chưa xử lý (do throttling) — bạn phải tự retry phần này với backoff.
- **BatchWriteItem**: tối đa **25 PutItem/DeleteItem** request hoặc tối đa **16 MB** mỗi lần. KHÔNG hỗ trợ UpdateItem, KHÔNG hỗ trợ ConditionExpression. Trả về `UnprocessedItems` cần retry. Batch KHÔNG phải transaction — các thao tác độc lập, một số có thể fail trong khi số khác thành công.

```javascript
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient, PutCommand, GetCommand,
  UpdateCommand, DeleteCommand, BatchWriteCommand,
} from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "ap-southeast-1" }));

// PutItem — tạo/ghi đè
await ddb.send(new PutCommand({
  TableName: "Users",
  Item: { UserId: "u#1001", Email: "alice@example.com", Age: 29 },
}));

// GetItem — strongly consistent, chỉ lấy Email
const got = await ddb.send(new GetCommand({
  TableName: "Users",
  Key: { UserId: "u#1001" },
  ConsistentRead: true,           // tốn gấp đôi RCU
  ProjectionExpression: "Email",
}));

// UpdateItem — atomic counter + set attribute
await ddb.send(new UpdateCommand({
  TableName: "Users",
  Key: { UserId: "u#1001" },
  UpdateExpression: "SET Age = :a ADD LoginCount :one",
  ExpressionAttributeValues: { ":a": 30, ":one": 1 },
}));

// BatchWrite — tối đa 25 request, phải tự retry UnprocessedItems
const res = await ddb.send(new BatchWriteCommand({
  RequestItems: {
    Users: [
      { PutRequest: { Item: { UserId: "u#1002", Email: "bob@example.com" } } },
      { DeleteRequest: { Key: { UserId: "u#0001" } } },
    ],
  },
}));
if (res.UnprocessedItems && Object.keys(res.UnprocessedItems).length) {
  // retry res.UnprocessedItems với exponential backoff
}
```

> 💡 **Exam Tip:** Nhớ con số: BatchGetItem = 100 item/16MB, BatchWriteItem = 25 request/16MB. BatchWriteItem KHÔNG hỗ trợ UpdateItem và KHÔNG atomic — nếu cần all-or-nothing thì dùng `TransactWriteItems` (Chương 32). `UnprocessedItems`/`UnprocessedKeys` luôn phải xử lý, đừng quên.

## 31.8 Query vs Scan và DocumentClient (lib-dynamodb)

### Query — đọc theo partition key

**Query** lấy item theo **partition key cụ thể** (bắt buộc), tùy chọn lọc thêm theo **sort key** (`=`, `<`, `>`, `BETWEEN`, `begins_with`). Query rất hiệu quả vì DynamoDB biết chính xác partition và range cần đọc — chỉ tốn RCU cho dữ liệu **thực sự khớp key condition** (tính trên tổng size item được đọc trước khi filter).

`FilterExpression` lọc thêm **SAU khi đọc** — nó KHÔNG giảm RCU. Bạn vẫn trả tiền cho item bị filter loại bỏ. Đây là bẫy chi phí kinh điển.

Query trả tối đa **1 MB dữ liệu mỗi lần**; nếu còn nữa, trả `LastEvaluatedKey` để bạn phân trang (pagination) bằng cách truyền lại làm `ExclusiveStartKey` (chi tiết pagination đúng cách ở Chương 32).

### Scan — đọc toàn bảng

**Scan** đọc **toàn bộ table** (mọi partition) rồi mới áp `FilterExpression`. Tốn kém: đọc hết bảng = tốn RCU cho mọi item, dù chỉ trả về vài cái. Scan cũng giới hạn 1 MB/lần và phân trang bằng `LastEvaluatedKey`.

**Parallel Scan**: chia table thành N segment, nhiều worker scan song song (`Segment` + `TotalSegments`) để nhanh hơn — nhưng càng ăn RCU mạnh hơn. Chỉ dùng cho bảng lớn khi thật sự cần quét hết (ETL, migration).

| Tiêu chí | Query | Scan |
|---|---|---|
| Cách truy cập | Theo partition key (+ sort key range) | Đọc toàn bộ table |
| Hiệu năng | Nhanh, tốn RCU theo dữ liệu khớp key | Chậm, tốn RCU theo toàn bảng |
| FilterExpression | Áp sau key match (không giảm RCU) | Áp sau khi đọc hết (không giảm RCU) |
| Khi nào dùng | Mặc định nên ưu tiên; biết partition key | Khi buộc phải quét hết / phân tích toàn bảng |
| Pagination | 1MB/lần, LastEvaluatedKey | 1MB/lần, LastEvaluatedKey |

Quy tắc vàng: **luôn ưu tiên Query, tránh Scan trong hot path**. Nếu thấy mình cần Scan để tìm theo attribute không phải key, dấu hiệu là cần một **GSI** (Global Secondary Index — Chương 32) để biến attribute đó thành key query được.

### DocumentClient / lib-dynamodb

Package `@aws-sdk/lib-dynamodb` bọc client gốc và **tự động marshalling/unmarshalling** giữa JavaScript object thuần và wire format có descriptor kiểu (`{S:...}`, `{N:...}`). Không có nó, bạn phải viết `{ UserId: { S: "u#1001" } }` thủ công; có nó, bạn viết `{ UserId: "u#1001" }` như JSON bình thường.

```javascript
import { QueryCommand } from "@aws-sdk/lib-dynamodb";

// Query: lấy order của user u#1001 trong tháng 2026-06
const out = await ddb.send(new QueryCommand({
  TableName: "Orders",
  KeyConditionExpression: "UserId = :u AND begins_with(OrderId, :prefix)",
  ExpressionAttributeValues: { ":u": "u#1001", ":prefix": "2026-06" },
  Limit: 25,
  // ExclusiveStartKey: lastKey,  // truyền lại để phân trang
}));
console.log(out.Items);            // object thuần, không cần unmarshall
console.log(out.LastEvaluatedKey); // có => còn trang sau
```

`ExpressionAttributeNames` (`#name`) dùng khi tên attribute trùng **reserved word** của DynamoDB (ví dụ `Name`, `Status`, `Size`, `Date`) hoặc chứa ký tự đặc biệt — chi tiết ở Chương 32.

> 💡 **Exam Tip:** Hai bẫy hay ra đề: (1) `FilterExpression` KHÔNG giảm capacity tiêu thụ — RCU tính trên dữ liệu đọc trước filter; (2) Scan kém hiệu quả và tốn kém, đáp án "thay Scan bằng Query trên một GSI phù hợp" thường là lựa chọn tối ưu. Khi đề nói "retrieve all items with a specific non-key attribute efficiently" → tạo GSI rồi Query, KHÔNG Scan + Filter.

---

## Hands-on Lab: Tạo bảng DynamoDB, thao tác CRUD và phân biệt Query vs Scan bằng CLI + SDK v3

**Mục tiêu lab:** Tạo một bảng DynamoDB có composite primary key (partition key + sort key) bằng AWS CLI v2, ghi/đọc item với `PutItem`/`GetItem`, cập nhật bằng `UpdateItem` (update expression + conditional write), so sánh đọc eventually vs strongly consistent, chạy `Query` vs `Scan` để thấy khác biệt RCU tiêu thụ, dùng `BatchWriteItem`, rồi viết lại toàn bộ bằng AWS SDK for JavaScript v3 với `lib-dynamodb` (DocumentClient) để khỏi phải gõ kiểu dữ liệu thủ công.

**Chuẩn bị:**
- AWS CLI v2 đã cấu hình profile có quyền `dynamodb:*` (dùng tài khoản học tập, không phải production).
- Node.js >= 18, đã `npm install @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb`.
- Region dùng xuyên suốt: `ap-southeast-1`.

```bash
export TABLE="OrdersLab"
export AWS_REGION="ap-southeast-1"
```

Mô hình dữ liệu: bảng `OrdersLab` lưu đơn hàng theo khách hàng. Partition key `CustomerId` (string), sort key `OrderId` (string). Cách này cho phép lấy **tất cả đơn của một khách** bằng một `Query` trên partition key — đúng kiểu single-partition access pattern mà DynamoDB tối ưu.

### Bước 1: Tạo bảng ở chế độ on-demand

```bash
aws dynamodb create-table \
  --table-name "$TABLE" \
  --attribute-definitions \
      AttributeName=CustomerId,AttributeType=S \
      AttributeName=OrderId,AttributeType=S \
  --key-schema \
      AttributeName=CustomerId,KeyType=HASH \
      AttributeName=OrderId,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST \
  --region "$AWS_REGION"
```

Output mong đợi (rút gọn):

```json
{
    "TableDescription": {
        "TableName": "OrdersLab",
        "TableStatus": "CREATING",
        "BillingModeSummary": { "BillingMode": "PAY_PER_REQUEST" },
        "KeySchema": [
            { "AttributeName": "CustomerId", "KeyType": "HASH" },
            { "AttributeName": "OrderId", "KeyType": "RANGE" }
        ]
    }
}
```

Hai bẫy kinh điển: (1) trong `--attribute-definitions` **chỉ** khai báo các thuộc tính là key (partition/sort) hoặc key của index — KHÔNG khai báo các thuộc tính thường; nếu khai báo thừa, CLI báo `One or more parameter values were invalid: Number of attributes in KeySchema does not exactly match number of attributes defined in AttributeDefinitions`. (2) `HASH` = partition key, `RANGE` = sort key — thuật ngữ API cũ, dễ nhầm.

Chờ bảng `ACTIVE` bằng built-in waiter:

```bash
aws dynamodb wait table-exists --table-name "$TABLE" --region "$AWS_REGION"
echo "Table is ACTIVE"
```

### Bước 2: PutItem — ghi item đầu tiên

DynamoDB ở tầng API thấp yêu cầu mỗi attribute kèm descriptor kiểu (`S` string, `N` number, `BOOL`, `M` map, `L` list, `SS` string set...):

```bash
aws dynamodb put-item \
  --table-name "$TABLE" \
  --item '{
    "CustomerId": {"S": "CUST#100"},
    "OrderId":    {"S": "ORD#2026-001"},
    "Amount":     {"N": "250.50"},
    "Status":     {"S": "PENDING"},
    "Items":      {"SS": ["SKU-A", "SKU-B"]}
  }' \
  --region "$AWS_REGION"
```

Không có output nghĩa là thành công (HTTP 200). `PutItem` **ghi đè toàn bộ** item nếu key đã tồn tại — đây không phải update từng phần. Ghi thêm vài item nữa cho cùng khách để có dữ liệu Query:

```bash
aws dynamodb put-item --table-name "$TABLE" --region "$AWS_REGION" \
  --item '{"CustomerId":{"S":"CUST#100"},"OrderId":{"S":"ORD#2026-002"},"Amount":{"N":"99.00"},"Status":{"S":"SHIPPED"}}'

aws dynamodb put-item --table-name "$TABLE" --region "$AWS_REGION" \
  --item '{"CustomerId":{"S":"CUST#200"},"OrderId":{"S":"ORD#2026-003"},"Amount":{"N":"500.00"},"Status":{"S":"PENDING"}}'
```

### Bước 3: GetItem — eventually vs strongly consistent

```bash
aws dynamodb get-item \
  --table-name "$TABLE" \
  --key '{"CustomerId":{"S":"CUST#100"},"OrderId":{"S":"ORD#2026-001"}}' \
  --consistent-read \
  --return-consumed-capacity TOTAL \
  --region "$AWS_REGION"
```

Output:

```json
{
    "Item": {
        "CustomerId": {"S": "CUST#100"},
        "OrderId": {"S": "ORD#2026-001"},
        "Amount": {"N": "250.50"},
        "Status": {"S": "PENDING"},
        "Items": {"SS": ["SKU-A", "SKU-B"]}
    },
    "ConsumedCapacity": { "TableName": "OrdersLab", "CapacityUnits": 1.0 }
}
```

Với `--consistent-read` (strongly consistent) item <= 4KB tốn **1.0 RCU**. Bỏ flag này (mặc định eventually consistent) item cùng kích thước chỉ tốn **0.5 RCU** — chạy lại không có `--consistent-read` để thấy `CapacityUnits: 0.5`. Đây là điểm thi cực kỳ hay hỏi.

> Lưu ý: `GetItem` BẮT BUỘC truyền **đầy đủ** primary key (cả partition lẫn sort key). Thiếu sort key trên bảng composite key sẽ lỗi `ValidationException: The provided key element does not match the schema`.

### Bước 4: UpdateItem với update expression và conditional write

Cập nhật từng thuộc tính (không ghi đè cả item) và chỉ cho phép khi đơn đang `PENDING` — optimistic guard chống cập nhật trùng:

```bash
aws dynamodb update-item \
  --table-name "$TABLE" \
  --key '{"CustomerId":{"S":"CUST#100"},"OrderId":{"S":"ORD#2026-001"}}' \
  --update-expression "SET #st = :new, Amount = Amount + :inc" \
  --condition-expression "#st = :cur" \
  --expression-attribute-names '{"#st":"Status"}' \
  --expression-attribute-values '{":new":{"S":"CONFIRMED"},":cur":{"S":"PENDING"},":inc":{"N":"10"}}' \
  --return-values ALL_NEW \
  --region "$AWS_REGION"
```

`#st` là expression attribute name vì `Status` là một reserved word của DynamoDB — dùng trực tiếp sẽ lỗi `Attribute name is a reserved keyword`. `Amount = Amount + :inc` là atomic counter chạy phía server. Chạy lại lệnh trên lần thứ hai sẽ thất bại với `ConditionalCheckFailedException` vì `Status` không còn là `PENDING` — và lần thất bại đó **vẫn tốn WCU** (mặc định) trừ khi bảng tính theo on-demand thì vẫn tính một write request.

### Bước 5: Query vs Scan — quan sát khác biệt

`Query` lấy mọi đơn của `CUST#100` bằng partition key — chỉ đọc đúng partition đó:

```bash
aws dynamodb query \
  --table-name "$TABLE" \
  --key-condition-expression "CustomerId = :c" \
  --expression-attribute-values '{":c":{"S":"CUST#100"}}' \
  --return-consumed-capacity TOTAL \
  --region "$AWS_REGION"
```

Output: trả về 2 item của `CUST#100`, `ConsumedCapacity` tỉ lệ với tổng kích thước item khớp (vài phần RCU). `Scan` thì đọc **toàn bộ bảng** rồi mới lọc:

```bash
aws dynamodb scan \
  --table-name "$TABLE" \
  --filter-expression "#st = :s" \
  --expression-attribute-names '{"#st":"Status"}' \
  --expression-attribute-values '{":s":{"S":"PENDING"}}' \
  --return-consumed-capacity TOTAL \
  --region "$AWS_REGION"
```

Điểm chốt cho đề thi: **filter expression chạy SAU khi đọc**, nên `Scan` tiêu thụ RCU cho cả những item bị lọc bỏ. `ScannedCount` (số item đã đọc) sẽ lớn hơn `Count` (số item trả về). Trên bảng lớn, Scan đắt và chậm — luôn ưu tiên Query bằng key, hoặc tạo GSI (chi tiết ở Chương 32).

### Bước 6: BatchWriteItem — ghi nhiều item một request

```bash
aws dynamodb batch-write-item --region "$AWS_REGION" \
  --request-items '{
    "OrdersLab": [
      {"PutRequest": {"Item": {"CustomerId":{"S":"CUST#300"},"OrderId":{"S":"ORD#A"},"Amount":{"N":"12"}}}},
      {"PutRequest": {"Item": {"CustomerId":{"S":"CUST#300"},"OrderId":{"S":"ORD#B"},"Amount":{"N":"34"}}}}
    ]
  }'
```

`BatchWriteItem` tối đa **25 item** hoặc **16MB** mỗi request. Luôn kiểm tra `UnprocessedItems` trong response — nếu bị throttle một phần, các item chưa xử lý nằm ở đây và bạn phải **retry với exponential backoff** (Batch API không tự retry phần unprocessed).

### Bước 7: Làm lại bằng SDK v3 với DocumentClient (lib-dynamodb)

`lib-dynamodb` tự marshalling JS object <-> DynamoDB JSON, nên không phải gõ `{"S": ...}`:

```javascript
// orders.mjs — chạy: node orders.mjs
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient, PutCommand, GetCommand,
  UpdateCommand, QueryCommand
} from "@aws-sdk/lib-dynamodb";

const TABLE = "OrdersLab";
const base = new DynamoDBClient({ region: "ap-southeast-1" });
// removeUndefinedValues: bỏ field undefined, tránh lỗi serialize
const ddb = DynamoDBDocumentClient.from(base, {
  marshallOptions: { removeUndefinedValues: true }
});

// PutItem: chỉ ghi nếu chưa tồn tại (idempotent create)
await ddb.send(new PutCommand({
  TableName: TABLE,
  Item: { CustomerId: "CUST#400", OrderId: "ORD#X", Amount: 75, Status: "PENDING" },
  ConditionExpression: "attribute_not_exists(CustomerId)"
}));

// GetItem strongly consistent
const got = await ddb.send(new GetCommand({
  TableName: TABLE,
  Key: { CustomerId: "CUST#400", OrderId: "ORD#X" },
  ConsistentRead: true
}));
console.log("Item:", got.Item); // object JS thuần, không có descriptor kiểu

// Query mọi đơn của một khách
const q = await ddb.send(new QueryCommand({
  TableName: TABLE,
  KeyConditionExpression: "CustomerId = :c",
  ExpressionAttributeValues: { ":c": "CUST#100" }
}));
console.log("Count:", q.Count, "Items:", q.Items);

// UpdateItem atomic + conditional
await ddb.send(new UpdateCommand({
  TableName: TABLE,
  Key: { CustomerId: "CUST#400", OrderId: "ORD#X" },
  UpdateExpression: "SET #st = :s ADD Amount :inc",
  ConditionExpression: "#st = :cur",
  ExpressionAttributeNames: { "#st": "Status" },
  ExpressionAttributeValues: { ":s": "CONFIRMED", ":cur": "PENDING", ":inc": 5 }
}));
```

Output mong đợi: `Item:` là object JS thuần (`{ CustomerId: 'CUST#400', Amount: 75, ... }`), và `Count: 2` cho Query. So với CLI thấy rõ vì sao trong code thực tế hầu như luôn dùng DocumentClient thay cho client thấp.

> Bẫy phân trang: `Query`/`Scan` trả tối đa **1MB** mỗi lần. Nếu kết quả còn nữa, response có `LastEvaluatedKey`; phải lặp truyền `ExclusiveStartKey` cho đến khi key này biến mất (chi tiết pagination đúng cách ở Chương 32).

### Dọn dẹp tài nguyên

```bash
aws dynamodb delete-table --table-name "$TABLE" --region "$AWS_REGION"
aws dynamodb wait table-not-exists --table-name "$TABLE" --region "$AWS_REGION"
echo "Deleted OrdersLab"
```

Xoá bảng là xoá toàn bộ item kèm theo, không tốn thêm phí. Bảng on-demand không có "provisioned capacity nằm chờ" nên không phát sinh chi phí cố định, nhưng vẫn nên xoá để tài khoản học tập sạch sẽ.

## 💡 Exam Tips chương 31

- **RCU/WCU phải thuộc lòng.** 1 WCU = 1 write/giây cho item **<= 1KB**. 1 RCU = 1 strongly consistent read/giây cho item **<= 4KB**, hoặc **2** eventually consistent read/giây cho item <= 4KB. Đọc transactional tốn **2×** RCU, ghi transactional tốn **2×** WCU (transactions chi tiết ở Chương 32).
- **Cách làm tròn:** kích thước item luôn làm tròn LÊN. Item 5KB strongly consistent read = ceil(5/4) = 2 RCU; eventually consistent = 1 RCU. Item 1.5KB write = ceil(1.5/1) = 2 WCU.
- **On-demand vs provisioned:** on-demand (`PAY_PER_REQUEST`) cho workload không đoán trước, không cần capacity planning, tự scale; provisioned rẻ hơn khi traffic ổn định và bật auto scaling. Đề thi gài "unpredictable/spiky traffic, no capacity management" → chọn on-demand.
- **Throttling = `ProvisionedThroughputExceededException`.** SDK tự retry với exponential backoff. Nguyên nhân phổ biến nhất là **hot partition** (partition key cardinality thấp) chứ không phải thiếu tổng capacity — DynamoDB chia đều capacity cho các partition.
- **Query luôn cần partition key** trong key condition; không thể Query chỉ bằng sort key. Muốn truy vấn theo thuộc tính khác → tạo GSI (Chương 32).
- **Scan đọc toàn bảng rồi mới lọc.** `FilterExpression` không giảm RCU tiêu thụ và không giảm 1MB page limit. `ScannedCount` > `Count` là dấu hiệu filter đang lãng phí capacity.
- **GetItem cần full primary key.** Thiếu sort key trên composite-key table sẽ lỗi validation, không phải trả về list.
- **PutItem ghi đè cả item**; muốn update từng phần dùng `UpdateItem` với `UpdateExpression`. Muốn create-only thì thêm `ConditionExpression: attribute_not_exists(PK)`.
- **Reserved words:** `Status`, `Name`, `Size`, `Count`... phải dùng `ExpressionAttributeNames` (`#alias`). Giá trị runtime dùng `ExpressionAttributeValues` (`:val`).
- **BatchWriteItem:** tối đa 25 item / 16MB, KHÔNG hỗ trợ `UpdateItem` (chỉ Put/Delete), KHÔNG có condition expression, và phải tự xử lý `UnprocessedItems`. BatchGetItem tối đa 100 item / 16MB.
- **Item size tối đa 400KB** (gồm tên thuộc tính + giá trị). Object lớn hơn → lưu S3, chỉ giữ metadata trong DynamoDB (Chương 32).
- **lib-dynamodb (DocumentClient)** là lựa chọn mặc định trong code thật: tự marshalling kiểu, code sạch hơn nhiều so với `@aws-sdk/client-dynamodb` thuần.

## Quiz chương 31 (10 câu)

**Câu 1.** Một bảng provisioned có 10 RCU. Mỗi item nặng 8KB. Hỏi mỗi giây đọc được tối đa bao nhiêu item ở chế độ **eventually consistent**?
- A. 5
- B. 10
- C. 20
- D. 2.5

**Câu 2.** A developer needs to lấy tất cả đơn hàng của một khách hàng cụ thể từ bảng có partition key `CustomerId` và sort key `OrderId`, với chi phí thấp nhất. Nên dùng API nào?
- A. Scan với FilterExpression trên `CustomerId`
- B. Query với KeyConditionExpression `CustomerId = :c`
- C. BatchGetItem với danh sách OrderId
- D. GetItem lặp qua từng OrderId

**Câu 3.** Ứng dụng liên tục nhận `ProvisionedThroughputExceededException` cho một số request trong khi tổng provisioned capacity còn thừa. Nguyên nhân nhiều khả năng nhất?
- A. Item vượt 400KB
- B. Hot partition do partition key có cardinality thấp
- C. Region sai
- D. Dùng eventually consistent read

**Câu 4.** Một item nặng 3KB cần được ghi. Tốn bao nhiêu WCU?
- A. 1
- B. 2
- C. 3
- D. 4

**Câu 5.** A developer cần update một thuộc tính `views` thành công như atomic counter dưới tải đồng thời cao. Cách đúng nhất?
- A. GetItem để đọc `views`, +1, rồi PutItem
- B. UpdateItem với `SET views = views + :inc`
- C. Scan rồi BatchWriteItem
- D. PutItem với ConditionExpression

**Câu 6.** Workload mới có traffic không đoán trước, có thể bùng nổ 10× bất ngờ, và team không muốn quản lý capacity. Billing mode nào phù hợp nhất?
- A. Provisioned không auto scaling
- B. Provisioned có auto scaling
- C. On-demand (PAY_PER_REQUEST)
- D. Reserved capacity

**Câu 7.** Câu lệnh `GetItem` trên bảng có composite primary key chỉ truyền partition key, không truyền sort key. Kết quả?
- A. Trả về tất cả item có partition key đó
- B. Trả về item đầu tiên
- C. ValidationException
- D. Trả về null

**Câu 8.** A developer dùng `Scan` với `FilterExpression` lọc `Status = 'ACTIVE'` trên bảng 1 triệu item nhưng chỉ 100 item ACTIVE. Nhận xét đúng về RCU?
- A. Chỉ tốn RCU cho 100 item ACTIVE
- B. Tốn RCU cho toàn bộ item bị scan trước khi lọc
- C. Không tốn RCU vì có filter
- D. Tốn đúng 1 RCU

**Câu 9.** Cần đọc 5KB item với strongly consistent read. RCU tiêu thụ là?
- A. 1
- B. 1.5
- C. 2
- D. 0.5

**Câu 10.** A developer dùng `BatchWriteItem` ghi 25 item nhưng response trả về `UnprocessedItems` không rỗng. Cách xử lý đúng?
- A. Coi như thất bại toàn bộ, dừng lại
- B. Retry các item trong UnprocessedItems với exponential backoff
- C. Tăng item size limit
- D. Chuyển sang TransactWriteItems

### Đáp án & giải thích

**Câu 1 — Đáp án B (10).** Chi phí mỗi item eventually = ceil(size/4) / 2 = ceil(8/4) / 2 = 2/2 = **1 RCU/item**. Với 10 RCU đọc được 10 item/giây. A (5) là kết quả nếu tính nhầm strongly consistent (2 RCU/item → 10/2 = 5). C (20) là nếu nhân đôi sai chiều. D sai hoàn toàn. *(Ghi nhớ: eventually = một nửa chi phí strongly; luôn làm tròn lên theo block 4KB trước khi chia 2.)*

**Câu 2 — Đáp án B.** Query bằng partition key chỉ đọc đúng partition của khách đó, RCU tỉ lệ kích thước item khớp — rẻ và nhanh. A sai vì Scan đọc toàn bảng rồi mới lọc, tốn RCU khổng lồ. C sai vì BatchGetItem cần biết trước đầy đủ primary key của từng item. D sai vì lặp GetItem cần biết trước mọi OrderId và nhiều round-trip.

**Câu 3 — Đáp án B.** Throttle dù tổng capacity còn thừa là dấu hiệu kinh điển của hot partition: DynamoDB chia capacity cho các partition theo partition key, nếu key cardinality thấp/lệch thì một partition bị dồn tải và throttle riêng. A sai (vượt 400KB là lỗi khác, ValidationException). C sai (sai region là lỗi resource-not-found). D sai (eventually read còn rẻ hơn).

**Câu 4 — Đáp án C (3).** WCU tính theo block 1KB và làm tròn lên: item 3KB = ceil(3/1) = 3 WCU. A (1) và B (2) sai vì chưa làm tròn đủ số block. D (4) là bẫy nhầm sang đơn vị 4KB — đó là đơn vị của RCU (đọc), không phải WCU (ghi).

**Câu 5 — Đáp án B.** `UpdateItem` với biểu thức cộng dồn chạy atomic phía server, an toàn dưới concurrency. A sai: read-modify-write phía client gây race condition (lost update). C sai: thừa và không atomic. D sai: PutItem ghi đè cả item, không cộng dồn.

**Câu 6 — Đáp án C.** On-demand tự scale theo traffic, không cần capacity planning, lý tưởng cho traffic spiky/không đoán trước. A sai: provisioned tĩnh sẽ throttle khi spike. B đỡ hơn nhưng auto scaling phản ứng theo CloudWatch nên trễ với spike đột ngột và vẫn cần cấu hình. D sai: DynamoDB không có "reserved capacity" theo nghĩa billing mode (chỉ có reserved capacity discount cho provisioned, không phù hợp yêu cầu "không quản lý capacity").

**Câu 7 — Đáp án C.** GetItem yêu cầu đầy đủ primary key; thiếu sort key trên bảng composite-key gây `ValidationException`. A là hành vi của Query (không phải GetItem). B/D không phải hành vi thực tế.

**Câu 8 — Đáp án B.** FilterExpression áp dụng SAU khi đọc item từ bảng, nên RCU tính cho toàn bộ item bị scan (ScannedCount), không chỉ item trả về (Count). A/C sai vì hiểu nhầm filter giảm chi phí. D sai vì Scan bảng triệu item tốn rất nhiều RCU.

**Câu 9 — Đáp án C (2).** Strongly consistent read tính theo block 4KB: ceil(5/4) = 2 RCU. A/D quên làm tròn lên; B nhầm sang cách tính phân số không tồn tại cho strongly read.

**Câu 10 — Đáp án B.** BatchWriteItem không tự retry phần bị throttle; các item chưa xử lý nằm ở `UnprocessedItems` và developer phải retry chúng với exponential backoff. A sai: phần đã xử lý vẫn thành công, không phải fail toàn bộ. C sai: không liên quan size. D sai: chuyển sang transaction không giải quyết throttling và còn tốn gấp đôi WCU.

## Tóm tắt chương

- DynamoDB là NoSQL key-value/document fully managed, single-digit millisecond latency, scale ngang theo partition; chọn nó khi cần access pattern theo key, throughput cao và không cần join phức tạp như RDBMS.
- Primary key có hai dạng: **partition key đơn** (mỗi item một key duy nhất) hoặc **partition + sort key** (composite) cho phép nhiều item cùng partition và Query theo range trên sort key.
- Chọn partition key có **cardinality cao và phân phối đều** để tránh hot partition — nguyên nhân throttle phổ biến nhất dù tổng capacity còn thừa.
- **WCU**: 1 đơn vị = 1 write/giây cho item <= 1KB, làm tròn lên theo block 1KB. **RCU**: 1 đơn vị = 1 strongly consistent read/giây item <= 4KB, hoặc 2 eventually consistent read; eventually rẻ bằng nửa strongly.
- Hai capacity mode: **provisioned** (rẻ khi traffic ổn định, nên bật auto scaling) và **on-demand/PAY_PER_REQUEST** (tự scale, hợp traffic spiky/không đoán trước, không cần capacity planning).
- Throttling phát `ProvisionedThroughputExceededException`; SDK tự retry exponential backoff, nhưng nên xử lý gốc rễ bằng thiết kế partition key và/hoặc on-demand.
- API cốt lõi: `PutItem` (ghi đè cả item), `GetItem` (cần full key), `UpdateItem` (update từng phần + atomic counter + conditional write), `DeleteItem`, cộng `BatchGetItem`/`BatchWriteItem` cho thao tác hàng loạt.
- **Query** đọc theo partition key (bắt buộc), rẻ và nhanh; **Scan** đọc toàn bảng rồi mới áp FilterExpression nên tốn RCU cho cả item bị lọc — luôn ưu tiên Query hoặc index.
- Query/Scan trả tối đa **1MB** mỗi lần; phân trang bằng `LastEvaluatedKey` / `ExclusiveStartKey`. BatchWrite tối đa 25 item/16MB, BatchGet 100 item/16MB, item tối đa 400KB.
- Reserved words dùng `ExpressionAttributeNames` (`#x`), giá trị runtime dùng `ExpressionAttributeValues` (`:v`); thiếu placeholder là lỗi thường gặp khi viết expression.
- Trong code thật dùng `@aws-sdk/lib-dynamodb` (DocumentClient) để tự marshalling JS object, sạch hơn nhiều so với client thấp với descriptor `{"S":...}`.
- LSI/GSI, conditional writes nâng cao, optimistic locking, transactions và single-table design được trình bày ở Chương 32; DAX, Streams, TTL, Global Tables ở Chương 33.
