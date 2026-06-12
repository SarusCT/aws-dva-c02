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
