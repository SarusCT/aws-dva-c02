## Hands-on Lab: GSI, conditional writes, optimistic locking, transactions & PartiQL

**Mục tiêu lab:** Dựng một bảng `Orders` rồi đi qua toàn bộ các kỹ thuật nâng cao mà DVA-C02 hay hỏi: tạo Global Secondary Index (GSI) để query theo thuộc tính không phải primary key, dùng `ConditionExpression` để chống ghi đè và làm idempotent, triển khai optimistic locking bằng version number, chạy `TransactWriteItems` để di chuyển tồn kho nguyên tử (all-or-nothing) và quan sát chi phí gấp đôi, atomic counter với `UpdateItem ADD`, phân trang đúng cách bằng `LastEvaluatedKey`, và cuối cùng truy vấn bằng PartiQL. (Lý thuyết LSI vs GSI, transactions, single-table đã ở Part 1; capacity mode RCU/WCU cơ bản ở Chương 31; DAX/Streams/Global Tables ở Chương 33.)

**Chuẩn bị:**
- AWS CLI v2 đã cấu hình (Chương 3), IAM có quyền `dynamodb:*`.
- Region: `us-east-1`. Dùng on-demand (`PAY_PER_REQUEST`) để khỏi lo RCU/WCU trong lab.

```bash
export AWS_REGION=us-east-1
aws sts get-caller-identity --query Account --output text
```

### Bước 1: Tạo bảng Orders với GSI ngay từ đầu

Bảng chính: partition key `orderId` (S), sort key `createdAt` (S). Ta muốn query "tất cả order của một customer" — `customerId` không nằm trong key, nên cần GSI `customer-index` với partition key `customerId`, sort key `createdAt`. Lưu ý: GSI **tạo được bất cứ lúc nào** (khác LSI chỉ tạo lúc create-table), và có key space riêng hoàn toàn so với bảng chính.

```bash
aws dynamodb create-table \
  --table-name Orders \
  --attribute-definitions \
      AttributeName=orderId,AttributeType=S \
      AttributeName=createdAt,AttributeType=S \
      AttributeName=customerId,AttributeType=S \
  --key-schema \
      AttributeName=orderId,KeyType=HASH \
      AttributeName=createdAt,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST \
  --global-secondary-indexes '[{
      "IndexName": "customer-index",
      "KeySchema": [
        {"AttributeName": "customerId", "KeyType": "HASH"},
        {"AttributeName": "createdAt", "KeyType": "RANGE"}
      ],
      "Projection": {"ProjectionType": "ALL"}
  }]'

# Chờ bảng ACTIVE (waiter)
aws dynamodb wait table-exists --table-name Orders
echo "Table + GSI ready"
```

> Chỉ những attribute xuất hiện trong KeySchema (của bảng hoặc của bất kỳ index nào) mới cần khai trong `attribute-definitions`. Đừng khai thừa thuộc tính không phải key — DynamoDB sẽ báo lỗi "must contain exactly the attributes used in key schema".

### Bước 2: Conditional write — chống ghi đè item đã tồn tại

`PutItem` mặc định **ghi đè** item cùng key. Để biến PutItem thành "create-if-not-exists" (idempotent), thêm `ConditionExpression` đảm bảo partition key chưa tồn tại:

```bash
aws dynamodb put-item \
  --table-name Orders \
  --item '{
    "orderId": {"S": "O-1001"},
    "createdAt": {"S": "2026-06-12T08:00:00Z"},
    "customerId": {"S": "C-7"},
    "amount": {"N": "250"},
    "status": {"S": "NEW"},
    "version": {"N": "1"}
  }' \
  --condition-expression "attribute_not_exists(orderId)"
```

Chạy lại đúng lệnh trên lần thứ hai → trả về `ConditionalCheckFailedException`. Quan trọng cho exam: **write thất bại do condition VẪN tốn WCU** (1 WCU cho item ≤ 1KB), và lỗi này KHÔNG được retry bởi SDK (đó là lỗi 400 client-side, không phải throttle 5xx).

### Bước 3: Optimistic locking bằng version number (SDK v3)

Pattern kinh điển: đọc item kèm `version`, khi update yêu cầu version chưa đổi, đồng thời tăng version. Nếu có người ghi xen vào, condition fail → app retry với dữ liệu mới.

```javascript
// optimistic-update.mjs — chạy: node optimistic-update.mjs
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));

async function updateStatus(orderId, createdAt, newStatus, expectedVersion) {
  try {
    const res = await ddb.send(new UpdateCommand({
      TableName: "Orders",
      Key: { orderId, createdAt },
      // Tăng version + đổi status trong CÙNG một update nguyên tử
      UpdateExpression: "SET #s = :st, version = version + :one",
      ConditionExpression: "version = :ver",            // chỉ ghi nếu version chưa đổi
      ExpressionAttributeNames: { "#s": "status" },     // status là reserved word -> phải dùng name placeholder
      ExpressionAttributeValues: { ":st": newStatus, ":one": 1, ":ver": expectedVersion },
      ReturnValues: "ALL_NEW",
    }));
    console.log("OK, version mới =", res.Attributes.version);
  } catch (e) {
    if (e.name === "ConditionalCheckFailedException") {
      console.log("Có người ghi trước — cần đọc lại item và retry");
    } else { throw e; }
  }
}
await updateStatus("O-1001", "2026-06-12T08:00:00Z", "PAID", 1); // thành công, version -> 2
await updateStatus("O-1001", "2026-06-12T08:00:00Z", "SHIPPED", 1); // FAIL: version đã là 2
```

`status` là reserved keyword trong DynamoDB nên bắt buộc dùng `#s` qua `ExpressionAttributeNames` — đây là bẫy gây lỗi `ValidationException: Attribute name is a reserved keyword` rất hay bị trong thực tế.

### Bước 4: Atomic counter với UpdateItem ADD

Atomic counter dùng cho đếm view, tồn kho... — không cần đọc trước, mỗi lần `ADD` cộng dồn nguyên tử ở phía server. Khác optimistic locking: atomic counter **không idempotent** (retry sẽ cộng 2 lần), dùng khi giá trị chính xác tuyệt đối không quan trọng.

```bash
aws dynamodb update-item \
  --table-name Orders \
  --key '{"orderId":{"S":"O-1001"},"createdAt":{"S":"2026-06-12T08:00:00Z"}}' \
  --update-expression "ADD viewCount :inc" \
  --expression-attribute-values '{":inc":{"N":"1"}}' \
  --return-values UPDATED_NEW
# Lặp lại nhiều lần -> viewCount tăng dần, không cần đọc trước
```

### Bước 5: Transactions — TransactWriteItems all-or-nothing

Tạo thêm item tồn kho rồi mô phỏng "trừ kho + tạo order" trong một transaction: hoặc cả hai thành công, hoặc cả hai bị rollback. Nếu kho không đủ (`stock >= :qty` fail), `TransactionCanceledException` với `CancellationReasons` chỉ rõ item nào fail.

```bash
# Tạo item tồn kho
aws dynamodb put-item --table-name Orders --item '{
  "orderId":{"S":"PRODUCT#SKU-9"},"createdAt":{"S":"INVENTORY"},
  "stock":{"N":"5"}}'

# Transaction: trừ kho (có điều kiện) + tạo order mới, nguyên tử
aws dynamodb transact-write-items --transact-items '[
  {
    "Update": {
      "TableName": "Orders",
      "Key": {"orderId":{"S":"PRODUCT#SKU-9"},"createdAt":{"S":"INVENTORY"}},
      "UpdateExpression": "SET stock = stock - :q",
      "ConditionExpression": "stock >= :q",
      "ExpressionAttributeValues": {":q":{"N":"2"}}
    }
  },
  {
    "Put": {
      "TableName": "Orders",
      "Item": {"orderId":{"S":"O-2002"},"createdAt":{"S":"2026-06-12T09:00:00Z"},
               "customerId":{"S":"C-7"},"amount":{"N":"99"},"status":{"S":"NEW"},"version":{"N":"1"}},
      "ConditionExpression": "attribute_not_exists(orderId)"
    }
  }
]'
```

Quan trọng cho exam: transaction tiêu thụ **gấp đôi capacity** — mỗi item trong `TransactWriteItems` tốn 2 WCU (cho việc prepare + commit), `TransactGetItems` tốn 2 RCU/item. Một transaction tối đa **100 item hoặc 4MB**. Hai transaction đụng cùng item → `TransactionConflict`.

### Bước 6: Query GSI và phân trang đúng cách

Query GSI `customer-index` để lấy order của customer `C-7`. GSI **chỉ hỗ trợ eventual consistency** (`--consistent-read` không dùng được cho GSI — đây là điểm khác LSI). Để phân trang, lặp với `LastEvaluatedKey` → `ExclusiveStartKey`:

```bash
aws dynamodb query \
  --table-name Orders \
  --index-name customer-index \
  --key-condition-expression "customerId = :c" \
  --expression-attribute-values '{":c":{"S":"C-7"}}' \
  --max-items 1 \
  --query '{items: Items, next: NextToken}'
# CLI trả "NextToken" -> truyền lại bằng --starting-token để lấy trang sau
```

Trong SDK, kiểm tra `result.LastEvaluatedKey`: nếu khác `undefined` thì còn dữ liệu, truyền vào `ExclusiveStartKey` của request kế. **Sự vắng mặt của `LastEvaluatedKey` mới là dấu hiệu hết trang** — KHÔNG phải `Items.length === 0` (một trang có thể rỗng do filter mà vẫn còn trang sau).

### Bước 7: PartiQL — truy vấn kiểu SQL

PartiQL cho phép viết SELECT/INSERT/UPDATE/DELETE bằng cú pháp giống SQL. Lưu ý: `SELECT *` không có mệnh đề key trên partition key sẽ thành **Scan** (đắt). Có WHERE trên partition key → thành Query.

```bash
aws dynamodb execute-statement \
  --statement "SELECT orderId, amount FROM Orders WHERE customerId = 'C-7'" \
  --parameters '[]' 2>/dev/null || \
aws dynamodb execute-statement \
  --statement "SELECT orderId, amount, status FROM \"Orders\".\"customer-index\" WHERE customerId = 'C-7'"
```

### Dọn dẹp tài nguyên

```bash
# Xoá bảng cũng xoá luôn mọi GSI/LSI gắn với nó
aws dynamodb delete-table --table-name Orders
aws dynamodb wait table-not-exists --table-name Orders
echo "Đã xoá Orders"
```

Xoá bảng là thao tác bất khả hồi (trừ khi đã bật PITR/backup — Chương 33). On-demand bảng rỗng gần như không tốn tiền, nhưng vẫn nên xoá để giữ account sạch.

## 💡 Exam Tips chương 32

- **LSI vs GSI:** LSI **chỉ tạo lúc create-table**, dùng chung partition key với bảng, sort key khác, hỗ trợ **strongly consistent read**, chung capacity với bảng chính, giới hạn 10GB/partition key. GSI tạo/xoá **bất kỳ lúc nào**, partition key + sort key tuỳ ý, **chỉ eventual consistency**, có capacity riêng. Mỗi bảng tối đa **5 LSI và 20 GSI**.
- **GSI throttling KHÔNG lan ngược ra bảng chính cho read**, nhưng nếu **GSI bị write throttle** (capacity GSI cạn) thì **write vào bảng chính cũng bị throttle** — vì DynamoDB phải propagate. Đây là câu hỏi gài bẫy kinh điển.
- **GSI projection:** chọn `KEYS_ONLY`/`INCLUDE`/`ALL`. Query GSI mà cần attribute không được projected → DynamoDB phải fetch lại từ bảng chính (tốn thêm) — với GSI thì attribute không projected **không lấy được**, không có "fetch lại" như LSI.
- **Conditional write fail vẫn tốn WCU** và trả `ConditionalCheckFailedException` (lỗi 400, không tự retry). Dùng `attribute_not_exists(pk)` để create-if-not-exists, `attribute_exists(pk)` để update-only.
- **Optimistic locking** = version number + `ConditionExpression: version = :v`. Đây là cách DynamoDB xử lý concurrency mà KHÔNG có pessimistic lock. DynamoDBMapper/`@DynamoDbVersionAttribute` làm tự động.
- **Transactions tốn gấp đôi capacity:** mỗi item 2 WCU (write) / 2 RCU (read). Tối đa **100 item hoặc 4MB** mỗi transaction. `TransactionCanceledException` kèm `CancellationReasons` cho biết item nào và lý do (ConditionalCheckFailed, TransactionConflict, ...).
- **Atomic counter (`ADD`)** nhanh, không cần đọc trước, nhưng **không idempotent** — retry cộng nhiều lần. Optimistic locking thì idempotent nhưng tốn round-trip đọc.
- **Reserved words** (status, name, size, count, value, data...) phải dùng `ExpressionAttributeNames` (`#x`). Giá trị luôn qua `ExpressionAttributeValues` (`:y`) — không bao giờ nhúng literal vào expression.
- **Pagination:** hết trang khi `LastEvaluatedKey` **không xuất hiện**, không phải khi `Items` rỗng. Truyền nó vào `ExclusiveStartKey`. Một response Query/Scan tối đa **1MB** rồi tự cắt trang.
- **PartiQL** không có `WHERE` trên partition key = Scan toàn bảng (đắt). `BatchExecuteStatement` gom tối đa 25 statement.
- **Write sharding** (thêm suffix ngẫu nhiên vào partition key) để tránh hot partition khi ghi dồn vào ít key; đọc thì scatter-gather các shard.
- **Large object pattern:** item tối đa **400KB**. Vật thể lớn → lưu trên S3, chỉ giữ S3 key + metadata trong DynamoDB.

## Quiz chương 32 (10 câu)

**Câu 1.** A developer needs to query an existing `Users` table by `email`, which is not part of the primary key. The table is already in production. Lựa chọn nào dùng được mà không phải tạo lại bảng?
- A. Tạo một LSI với partition key là `email`
- B. Tạo một GSI với partition key là `email`
- C. Bật strongly consistent read trên một Scan có filter
- D. Đổi primary key của bảng sang `email`

**Câu 2.** Khi GSI của một bảng bị write-throttled do hết capacity của index, điều gì xảy ra với bảng chính?
- A. Không ảnh hưởng, GSI hoàn toàn độc lập
- B. Read của bảng chính bị throttle
- C. Write vào bảng chính cũng có thể bị throttle
- D. Bảng tự động chuyển sang on-demand

**Câu 3.** Một developer muốn `PutItem` chỉ thành công nếu item chưa tồn tại (idempotent create). Cách đúng?
- A. Gọi GetItem trước, nếu không có thì PutItem
- B. Dùng `ConditionExpression: attribute_not_exists(pk)`
- C. Dùng `TransactWriteItems`
- D. Bật optimistic locking

**Câu 4.** Hai luồng cùng cập nhật một item và có thể ghi đè lẫn nhau. Cần đảm bảo không mất update mà không dùng lock. Giải pháp?
- A. Atomic counter với ADD
- B. Optimistic locking bằng version number + ConditionExpression
- C. BatchWriteItem
- D. Tăng RCU/WCU

**Câu 5.** `TransactWriteItems` ghi 4 item, mỗi item ~500 bytes. Tốn bao nhiêu WCU (table provisioned)?
- A. 4 WCU
- B. 8 WCU
- C. 2 WCU
- D. 16 WCU

**Câu 6.** Đang phân trang một Query. Làm sao biết đã hết dữ liệu?
- A. `Items` array rỗng
- B. `Count` bằng 0
- C. Response không còn `LastEvaluatedKey`
- D. `ScannedCount` bằng `Count`

**Câu 7.** A developer cần đếm số lần xem mỗi sản phẩm, không quan tâm chính xác tuyệt đối, ưu tiên ít round-trip. Cách phù hợp nhất?
- A. Đọc, +1 trong code, ghi lại với optimistic locking
- B. `UpdateItem` với `ADD viewCount :one`
- C. TransactWriteItems
- D. Scan rồi đếm

**Câu 8.** Câu nào ĐÚNG về LSI?
- A. Có thể tạo sau khi bảng đã tạo
- B. Hỗ trợ strongly consistent read và dùng chung partition key với bảng chính
- C. Có capacity riêng tách biệt bảng chính
- D. Mỗi bảng được tối đa 20 LSI

**Câu 9.** Một item cần lưu file PDF 5MB cùng metadata. Thiết kế đúng?
- A. Lưu thẳng PDF vào attribute Binary của DynamoDB
- B. Tách PDF ra nhiều item rồi ghép lại
- C. Lưu PDF trên S3, chỉ giữ S3 key + metadata trong DynamoDB
- D. Dùng GSI để lưu PDF

**Câu 10.** `TransactWriteItems` trả về `TransactionCanceledException`. Developer cần biết item nào gây fail. Lấy thông tin ở đâu?
- A. CloudWatch Logs
- B. Trường `CancellationReasons` trong exception
- C. DynamoDB Streams
- D. Retry tự động sẽ tự sửa

### Đáp án & giải thích

**Câu 1 — Đáp án B.** GSI tạo được bất kỳ lúc nào trên bảng đang chạy, partition key tuỳ ý → query theo `email` được. A sai: LSI chỉ tạo được lúc create-table. C sai: Scan toàn bảng đắt và chậm, không phải cách query; strongly consistent không giải quyết vấn đề tìm theo non-key. D sai: không thể đổi primary key của bảng đã tồn tại (phải tạo bảng mới và migrate).

**Câu 2 — Đáp án C.** Khi GSI cạn write capacity, DynamoDB không thể propagate write sang index nên **back-pressure ngược bảng chính**, gây throttle write của bảng. A sai vì đúng là có ảnh hưởng. B sai: throttle là về write, không phải read của bảng chính. D sai: không có chuyện tự đổi billing mode.

**Câu 3 — Đáp án B.** `attribute_not_exists(pk)` biến PutItem thành create-if-not-exists nguyên tử, một round-trip. A sai: race condition giữa Get và Put (không nguyên tử). C dùng được nhưng thừa và tốn gấp đôi capacity cho một item đơn. D (optimistic locking) dành cho update item đã tồn tại, không phải create.

**Câu 4 — Đáp án B.** Optimistic locking: đọc version, update với `ConditionExpression: version = :v` + tăng version; nếu có người ghi xen → condition fail → retry. A (atomic counter) chỉ đúng cho phép cộng, không bảo vệ các field khác và không idempotent. C không giải quyết lost-update. D chỉ tăng throughput, không chống concurrency.

**Câu 5 — Đáp án B.** Mỗi item trong transaction tốn **2 WCU** (item ≤1KB tốn 1 WCU cho write thường, transaction nhân đôi). 4 item × 2 = **8 WCU**. A là chi phí write thường (không transaction). C là cho 1 item. D là tính nhầm ×4.

**Câu 6 — Đáp án C.** Hết dữ liệu khi response **không còn `LastEvaluatedKey`**. A/B sai: một trang có thể `Items` rỗng (do FilterExpression loại hết) mà vẫn còn `LastEvaluatedKey` → còn trang sau. D sai: `ScannedCount == Count` chỉ nghĩa là không có filter loại bỏ item nào ở trang đó, không liên quan hết trang.

**Câu 7 — Đáp án B.** `ADD viewCount :one` là atomic counter — một round-trip, server tự cộng, phù hợp khi chấp nhận sai số nhỏ khi retry. A tốn round-trip đọc + có thể fail condition phải retry, nặng hơn không cần thiết. C tốn gấp đôi capacity, dư thừa. D cực kỳ đắt và sai mục đích.

**Câu 8 — Đáp án B.** LSI dùng chung partition key với bảng, có sort key khác, hỗ trợ strongly consistent read. A sai: LSI chỉ tạo lúc create-table. C sai: LSI dùng chung capacity với bảng chính (GSI mới có capacity riêng). D sai: tối đa 5 LSI / bảng (GSI là 20).

**Câu 9 — Đáp án C.** Item DynamoDB tối đa 400KB nên 5MB không nhét được; pattern chuẩn là large object → S3 + metadata/S3 key trong DynamoDB. A bất khả thi (vượt 400KB). B phức tạp, dễ hỏng, vẫn vượt giới hạn tổng. D vô nghĩa: GSI không phải nơi lưu blob.

**Câu 10 — Đáp án B.** Exception `TransactionCanceledException` đính kèm mảng `CancellationReasons`, mỗi phần tử ứng với một item trong request, cho biết `Code` (ConditionalCheckFailed, TransactionConflict, ...). A sai: không tự log chi tiết item. C sai: Streams chỉ ghi thay đổi đã commit, transaction fail thì không có gì để stream. D sai: nếu fail do condition, retry cũng fail như cũ.

## Tóm tắt chương

- **GSI** tạo bất kỳ lúc nào, key tuỳ ý, capacity riêng, **chỉ eventual consistency**; **LSI** chỉ tạo lúc create-table, chung partition key, **strongly consistent được**, chung capacity. Tối đa **20 GSI** và **5 LSI** mỗi bảng.
- GSI write-throttle có thể **back-pressure throttle bảng chính**; chọn `Projection` (KEYS_ONLY/INCLUDE/ALL) cẩn thận vì attribute không projected không lấy được từ GSI.
- **ConditionExpression** cho phép ghi có điều kiện: `attribute_not_exists` (create-only), `attribute_exists` (update-only), so sánh giá trị. Write fail do condition **vẫn tốn WCU** và là lỗi 400 không tự retry.
- **Optimistic locking** = version number + condition trên version; là cách xử lý concurrency của DynamoDB (không có pessimistic lock).
- **Atomic counter** (`ADD`) nguyên tử, một round-trip, nhưng **không idempotent** (retry cộng nhiều lần).
- **Transactions** (`TransactWriteItems`/`TransactGetItems`) cho all-or-nothing, tốn **gấp đôi capacity** (2 WCU/2 RCU mỗi item), tối đa **100 item hoặc 4MB**; lỗi báo qua `CancellationReasons`.
- **PartiQL** cho cú pháp giống SQL; thiếu điều kiện partition key = Scan đắt.
- **Pagination** chuẩn: lặp với `LastEvaluatedKey` → `ExclusiveStartKey`; hết trang khi không còn `LastEvaluatedKey`; mỗi page tối đa **1MB**.
- **Expression attribute names** (`#x`) bắt buộc cho reserved words; **values** (`:y`) luôn tách khỏi expression — không nhúng literal.
- **Write sharding** chống hot partition khi ghi dồn; **large object pattern** đẩy blob >400KB sang S3, giữ metadata trong DynamoDB.
- DAX, Streams, TTL, Global Tables, PITR/backup, fine-grained access là chủ đề của **Chương 33**.
