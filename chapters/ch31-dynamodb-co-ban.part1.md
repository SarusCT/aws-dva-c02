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
