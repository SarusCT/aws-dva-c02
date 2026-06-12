# Chương 32: Amazon DynamoDB nâng cao

> **Trọng tâm DVA-C02:** DynamoDB nâng cao là một trong những vùng câu hỏi đậm đặc nhất của phần Development. Bạn sẽ gặp: phân biệt LSI và GSI (khi nào tạo được, key khác nhau ra sao, vì sao GSI bị throttle lại làm hỏng write vào bảng chính); dùng `ConditionExpression` cho conditional write và optimistic locking bằng version number; `TransactWriteItems`/`TransactGetItems` và bẫy "capacity tốn gấp đôi"; PartiQL khi nào tiện khi nào không; phân trang ĐÚNG bằng `LastEvaluatedKey`; các pattern kinh điển atomic counter, write sharding để né hot partition, và large object pattern (S3 + metadata). Phần capacity mode (RCU/WCU), Query vs Scan, kiểu primary key đã học ở Chương 31; DAX, Streams, TTL, Global Tables, PITR, fine-grained IAM access học ở Chương 33.

## Mục tiêu chương

- Phân biệt rạch ròi Local Secondary Index (LSI) và Global Secondary Index (GSI): điều kiện tạo, kiểu key, projection, và mô hình capacity riêng của GSI.
- Hiểu cơ chế GSI throttling lan ngược làm hỏng write vào base table, và cách tránh.
- Viết conditional writes với `ConditionExpression`, và cài đặt optimistic locking bằng version number để chống lost update.
- Dùng transactions (`TransactWriteItems`/`TransactGetItems`) đúng chỗ, nắm con số limit và chi phí capacity gấp đôi.
- Truy vấn bằng PartiQL và biết khi nào nên/không nên dùng so với API thường.
- Áp dụng các pattern: atomic counter, write sharding, single-table design (mức giới thiệu), large object (S3 + metadata) và phân trang an toàn với `LastEvaluatedKey`.

## 32.1 Secondary Index — vì sao cần, và LSI vs GSI

Trên một DynamoDB table, bạn chỉ có thể `Query` hiệu quả theo **primary key** (partition key, hoặc partition + sort key). Mọi truy vấn theo thuộc tính khác đều phải `Scan` toàn bảng rồi lọc — tốn RCU và chậm. Secondary index sinh ra để bạn query theo một key khác mà không phải Scan.

Có hai loại index, khác nhau ở bản chất:

**Local Secondary Index (LSI):** giữ nguyên **partition key** của base table, nhưng đổi **sort key** sang một thuộc tính khác. LSI "local" theo nghĩa nó chia sẻ cùng partition với item gốc — dữ liệu của một partition key nằm cùng chỗ. Vì thế LSI hỗ trợ **strongly consistent read** (đọc nhất quán mạnh), điều GSI không làm được.

**Global Secondary Index (GSI):** chọn **partition key mới và sort key mới (tuỳ chọn)** hoàn toàn khác base table. GSI là một "bảng phụ" được DynamoDB tự nhân bản và duy trì ngầm, có **partitioning riêng**, **capacity riêng** (provisioned mode), và chỉ hỗ trợ **eventually consistent read**.

Bảng so sánh phải thuộc nằm lòng cho đề thi:

| Đặc điểm | LSI | GSI |
|---|---|---|
| Partition key | **Bắt buộc** giống base table | Bất kỳ thuộc tính nào |
| Sort key | Thuộc tính khác (bắt buộc có) | Tuỳ chọn |
| Thời điểm tạo | **Chỉ khi tạo table**, không thêm/xoá sau | **Bất kỳ lúc nào**, thêm/xoá tự do |
| Số lượng tối đa | **5** trên mỗi table | **20** trên mỗi table (mặc định, có thể tăng) |
| Consistency khi đọc | Eventual **hoặc** strong | **Chỉ eventual** |
| Capacity (provisioned) | Dùng chung RCU/WCU của base table | **Riêng biệt** RCU/WCU của index |
| Giới hạn dung lượng | Tổng item + index cho 1 partition key ≤ **10 GB** | Không giới hạn 10 GB |
| Key có cần unique | Không | Không |

> 💡 **Exam Tip:** Hai từ khoá quyết định trong đề: "tạo index SAU KHI table đã có dữ liệu / production" → **GSI** (LSI không thể thêm sau). "Cần strongly consistent read trên index" → **LSI** (GSI chỉ eventually consistent). "Đổi cả partition key" → bắt buộc **GSI**.

Ví dụ một bảng `Orders` với primary key `customerId` (PK) + `orderDate` (SK). Bạn muốn query "tất cả đơn theo `status`": tạo GSI với partition key `status`, sort key `orderDate`. Tạo bằng CLI khi tạo table:

```bash
# Tạo table Orders kèm 1 GSI tên status-index
aws dynamodb create-table \
  --table-name Orders \
  --attribute-definitions \
    AttributeName=customerId,AttributeType=S \
    AttributeName=orderDate,AttributeType=S \
    AttributeName=status,AttributeType=S \
  --key-schema \
    AttributeName=customerId,KeyType=HASH \
    AttributeName=orderDate,KeyType=RANGE \
  --global-secondary-indexes \
    '[{"IndexName":"status-index",
       "KeySchema":[{"AttributeName":"status","KeyType":"HASH"},
                    {"AttributeName":"orderDate","KeyType":"RANGE"}],
       "Projection":{"ProjectionType":"ALL"}}]' \
  --billing-mode PAY_PER_REQUEST
```

Lưu ý: chỉ những attribute **xuất hiện trong key** mới cần khai báo trong `attribute-definitions`. Các thuộc tính khác của item là schemaless, không khai báo.

## 32.2 Projection — chọn thuộc tính nào đi vào index

Khi DynamoDB nhân item sang index, bạn quyết định **những thuộc tính nào được copy** qua `Projection`. Đây là điểm ảnh hưởng trực tiếp chi phí lưu trữ và số RCU khi query index. Ba loại:

- `KEYS_ONLY`: chỉ copy key của index + key của base table. Nhẹ nhất, rẻ nhất.
- `INCLUDE`: copy key + một danh sách thuộc tính bạn liệt kê (`NonKeyAttributes`).
- `ALL`: copy toàn bộ thuộc tính của item. Query index không phải "với lại" base table, nhanh nhất nhưng tốn storage và WCU nhất.

Cơ chế bẫy: nếu query một index mà cần thuộc tính **không nằm trong projection**, DynamoDB phải thực hiện một **fetch ngược về base table** cho từng item — tốn thêm RCU và độ trễ. Với GSI, điều này còn tệ hơn vì fetch ngược là eventually consistent. Vì vậy thiết kế projection nên bám sát access pattern: chỉ project đúng thuộc tính cần đọc qua index.

> 💡 **Exam Tip:** Nếu đề than phiền "query GSI tốn nhiều RCU bất ngờ / chậm", một nguyên nhân kinh điển là projection thiếu thuộc tính nên DynamoDB phải fetch ngược base table. Cách sửa: dùng `INCLUDE`/`ALL` cho các attribute hay đọc qua index.

## 32.3 GSI throttling — cái bẫy lan ngược vào base table

Đây là một trong những câu hỏi "khó" hay xuất hiện. Với **provisioned mode**, GSI có **WCU riêng**. Mỗi khi bạn ghi vào base table, DynamoDB phải đồng thời ghi cập nhật vào mọi GSI có liên quan (item rơi vào key range của GSI). Nếu WCU của GSI **không đủ**, write vào GSI bị throttle.

Hệ quả nguy hiểm: với GSI, khi index bị throttle, **write vào base table cũng bị throttle hoặc thất bại** (đối với GSI; còn LSI thì throttle dùng chung capacity base nên cũng ảnh hưởng nhưng cùng pool). DynamoDB không thể để base table và GSI lệch nhau quá xa, nên áp lực dội ngược. Một GSI under-provisioned có thể làm sập write của cả bảng chính dù bảng chính dư WCU.

Cách tránh:
- Cấp đủ WCU cho GSI (ít nhất bằng base table nếu mọi write đều ảnh hưởng GSI).
- Hoặc dùng **on-demand (PAY_PER_REQUEST)** — GSI tự scale theo, né hẳn bài toán này.
- Chọn partition key của GSI có cardinality cao để write trải đều, tránh hot partition trên GSI.

> 💡 **Exam Tip:** "Writes to the base table are being throttled even though the table has enough write capacity" → nghi ngay **GSI thiếu WCU**. Đáp án thường là tăng WCU cho GSI hoặc chuyển sang on-demand.

Khác biệt với LSI: ghi LSI dùng chung WCU với base table và **không** gây throttle dội ngược kiểu GSI; nhưng LSI lại ràng buộc giới hạn 10 GB cho mỗi partition key value.

## 32.4 Expression attribute names & values — nền tảng mọi expression nâng cao

Trước khi vào conditional write và transaction, cần nắm vững cú pháp expression — vì đề thi rất hay đưa snippet và hỏi "tại sao lỗi".

- **Expression attribute values** (`:placeholder`): dùng để truyền giá trị vào expression, tránh inject và tránh lỗi kiểu dữ liệu. Khai báo trong `ExpressionAttributeValues`.
- **Expression attribute names** (`#placeholder`): dùng để tham chiếu tên thuộc tính khi tên đó là **reserved word** (ví dụ `status`, `name`, `size`, `timestamp`, `data`) hoặc chứa ký tự đặc biệt/dấu chấm. Khai báo trong `ExpressionAttributeNames`.

```javascript
// UpdateItem dùng cả #name (reserved word "status") và :val
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "ap-southeast-1" }));

await ddb.send(new UpdateCommand({
  TableName: "Orders",
  Key: { customerId: "C-1", orderDate: "2026-06-12" },
  UpdateExpression: "SET #st = :s",
  ExpressionAttributeNames: { "#st": "status" }, // "status" là reserved word
  ExpressionAttributeValues: { ":s": "SHIPPED" },
}));
```

> 💡 **Exam Tip:** Nếu snippet trong đề báo lỗi `ValidationException: Attribute name is a reserved keyword` thì cách sửa là dùng **expression attribute name** (`#alias`) thay cho tên trực tiếp. Đây là bẫy cú pháp cực phổ biến.

Lưu ý: `lib-dynamodb` (DocumentClient) tự marshalling JS object ↔ DynamoDB JSON (`{S:..}`, `{N:..}`), nên trong code bạn dùng `"SHIPPED"` thay vì `{S:"SHIPPED"}`. Mọi ví dụ dưới đây dùng DocumentClient cho gọn.

## 32.5 Conditional writes & ConditionExpression

Mặc định `PutItem`/`UpdateItem`/`DeleteItem` ghi đè vô điều kiện. **Conditional write** chỉ thực hiện thao tác **nếu điều kiện đúng**; nếu sai, DynamoDB ném `ConditionalCheckFailedException` và **không ghi** gì. Đây là nền tảng để xây các thao tác an toàn trong môi trường concurrent.

Các use case kinh điển:

**1. Chỉ tạo item nếu chưa tồn tại** (chống ghi đè bản ghi đã có):

```javascript
await ddb.send(new PutCommand({
  TableName: "Users",
  Item: { userId: "u-100", email: "a@b.com" },
  // Chỉ put nếu chưa có item với userId này
  ConditionExpression: "attribute_not_exists(userId)",
}));
```

**2. Chỉ update nếu giá trị hiện tại thoả điều kiện** (ví dụ giảm tồn kho chỉ khi còn hàng):

```javascript
await ddb.send(new UpdateCommand({
  TableName: "Inventory",
  Key: { sku: "ABC" },
  UpdateExpression: "SET stock = stock - :qty",
  ConditionExpression: "stock >= :qty", // tránh tồn kho âm
  ExpressionAttributeValues: { ":qty": 3 },
}));
```

Các hàm/toán tử dùng trong ConditionExpression: `attribute_exists`, `attribute_not_exists`, `attribute_type`, `begins_with`, `contains`, `size`, các phép so sánh `= <> < <= > >=`, `BETWEEN`, `IN`, và logic `AND/OR/NOT`.

Chi phí: conditional write **vẫn tốn WCU dù điều kiện thất bại**. Một write thất bại do condition vẫn tính phí như một write (theo kích thước item). Đây là điểm hay bị hỏi.

> 💡 **Exam Tip:** "Prevent overwriting an existing item" → `attribute_not_exists(PK)`. "Ensure data hasn't changed before update" → so sánh giá trị trong ConditionExpression. Conditional write thất bại **vẫn tiêu WCU** — nhớ điều này khi đề hỏi về chi phí.

## 32.6 Optimistic locking với version number

DynamoDB không có pessimistic lock (khoá bi quan) trên item. Để chống **lost update** (hai client cùng đọc → cùng sửa → ghi đè lẫn nhau), ta dùng **optimistic locking**: mỗi item mang một thuộc tính `version`. Khi update, client gửi kèm điều kiện "version hiện tại phải bằng version tôi vừa đọc", rồi tăng version lên.

```javascript
// Đọc item, lấy version hiện tại = 7
// Khi ghi: chỉ thành công nếu version vẫn = 7, rồi đặt version = 8
await ddb.send(new UpdateCommand({
  TableName: "Accounts",
  Key: { accountId: "acc-1" },
  UpdateExpression: "SET balance = :b, version = :newV",
  ConditionExpression: "version = :curV",
  ExpressionAttributeValues: { ":b": 500, ":curV": 7, ":newV": 8 },
}));
// Nếu client khác đã update trước (version đã thành 8),
// điều kiện version = 7 sai → ConditionalCheckFailedException → retry
```

Khi gặp `ConditionalCheckFailedException`, client đọc lại item (lấy version mới), tính lại và thử lại. Đây là pattern mà AWS SDK cho Java/`DynamoDBMapper` làm tự động qua annotation `@DynamoDBVersionAttribute`; với SDK JS v3 bạn tự cài đặt như trên.

> 💡 **Exam Tip:** "Multiple clients update the same item, prevent overwriting each other's changes / lost update" → **optimistic locking với version number + ConditionExpression**. Đừng nhầm với transactions — optimistic locking nhẹ và rẻ hơn cho trường hợp một item.

## 32.7 Transactions — TransactWriteItems & TransactGetItems

Khi cần thao tác **all-or-nothing trên nhiều item** (thậm chí nhiều table), conditional write một item là không đủ. DynamoDB transactions cung cấp **ACID** trong một region: hoặc tất cả thành công, hoặc rollback toàn bộ.

Hai API:

- **`TransactWriteItems`**: nhóm tối đa **100 action** (Put, Update, Delete, **ConditionCheck**). `ConditionCheck` kiểm tra điều kiện trên một item mà không ghi nó — hữu ích để "chốt" một điều kiện liên quan. Toàn bộ là một đơn vị nguyên tử.
- **`TransactGetItems`**: đọc tối đa **100 item** dưới dạng snapshot nhất quán (không bị item nào đang trong transaction khác làm nửa vời).

Con số limit phải nhớ: **tối đa 100 item** mỗi transaction, tổng dữ liệu ≤ **4 MB**. Một item không được xuất hiện hai lần trong cùng transaction.

Chi phí — bẫy lớn: transaction tiêu **gấp đôi capacity**. Mỗi Put/Update/Delete trong transaction tốn **2× WCU** so với write thường; mỗi read trong `TransactGetItems` tốn **2× RCU**. Lý do: DynamoDB thực hiện hai pha (prepare + commit) ngầm.

```javascript
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

// Chuyển 100 từ tài khoản A sang B, all-or-nothing
await ddb.send(new TransactWriteCommand({
  TransactItems: [
    { Update: {
        TableName: "Accounts",
        Key: { accountId: "A" },
        UpdateExpression: "SET balance = balance - :amt",
        ConditionExpression: "balance >= :amt", // A phải đủ tiền
        ExpressionAttributeValues: { ":amt": 100 },
    }},
    { Update: {
        TableName: "Accounts",
        Key: { accountId: "B" },
        UpdateExpression: "SET balance = balance + :amt",
        ExpressionAttributeValues: { ":amt": 100 },
    }},
  ],
}));
```

Nếu bất kỳ điều kiện nào sai (A không đủ tiền), toàn bộ transaction bị huỷ với `TransactionCanceledException`, trong đó `CancellationReasons` cho biết item nào gây fail. Transaction cũng fail nếu hai transaction đụng cùng item đồng thời (transaction conflict) — client phải retry.

> 💡 **Exam Tip:** "Multiple items must succeed or fail together / all-or-nothing across tables" → **TransactWriteItems**. Nhớ: transaction tốn **2× capacity** và giới hạn **100 item / 4 MB**. Nếu chỉ cần đảm bảo điều kiện trên MỘT item → dùng conditional write thường (rẻ hơn), đừng chọn transaction.

So sánh nhanh để chọn đúng công cụ:

| Nhu cầu | Công cụ |
|---|---|
| Cập nhật 1 item với điều kiện | Conditional write (`ConditionExpression`) |
| Chống lost update trên 1 item | Optimistic locking (version + condition) |
| All-or-nothing trên nhiều item/table | `TransactWriteItems` |
| Đọc nhất quán nhiều item như snapshot | `TransactGetItems` |
| Ghi/đọc nhiều item KHÔNG cần nguyên tử | `BatchWriteItem`/`BatchGetItem` (Chương 31) |

Đừng nhầm `BatchWriteItem` với transaction: batch **không nguyên tử** — từng item có thể thành công/thất bại độc lập (`UnprocessedItems`), và batch **không hỗ trợ ConditionExpression**.

## 32.8 PartiQL — SQL-compatible query cho DynamoDB

PartiQL cho phép viết câu lệnh kiểu SQL (`SELECT`/`INSERT`/`UPDATE`/`DELETE`) lên DynamoDB, tiện cho người quen SQL hoặc thao tác nhanh trong console/CLI.

```bash
# Query bằng PartiQL qua CLI
aws dynamodb execute-statement \
  --statement "SELECT * FROM Orders WHERE customerId = 'C-1'"
```

```javascript
import { ExecuteStatementCommand } from "@aws-sdk/lib-dynamodb";

await ddb.send(new ExecuteStatementCommand({
  Statement: "UPDATE Orders SET status = ? WHERE customerId = ? AND orderDate = ?",
  Parameters: ["SHIPPED", "C-1", "2026-06-12"],
}));
```

Điểm cốt tử cần hiểu: PartiQL **không** vượt qua được mô hình dữ liệu của DynamoDB. Một `SELECT ... WHERE` mà mệnh đề lọc **không trỏ vào partition key** sẽ biến thành **Scan toàn bảng** dưới capô — tốn RCU y như Scan. PartiQL chỉ là cú pháp; engine bên dưới vẫn là Query hoặc Scan. Không có JOIN. PartiQL có `BatchExecuteStatement` (tối đa 25 statement) và cũng hỗ trợ transaction qua `ExecuteTransaction`.

> 💡 **Exam Tip:** PartiQL **không** làm DynamoDB nhanh hơn hay rẻ hơn; nó chỉ là lớp cú pháp SQL. `SELECT` không có điều kiện trên partition key vẫn là **Scan đắt đỏ**. Đừng chọn PartiQL như cách "tối ưu hiệu năng".

## 32.9 Patterns: atomic counter & write sharding

**Atomic counter:** dùng `UpdateItem` với `SET x = x + :n` (hoặc `ADD`) để tăng/giảm một số mà **không cần đọc trước**. DynamoDB thực hiện cộng nguyên tử phía server. Phù hợp cho đếm lượt xem, like — nơi mất vài đơn vị do retry không nghiêm trọng. Lưu ý: atomic counter **không idempotent** (retry sẽ cộng lại); nếu cần chính xác tuyệt đối, dùng conditional write thay vì atomic counter.

```javascript
// Tăng view count nguyên tử, không cần đọc trước
await ddb.send(new UpdateCommand({
  TableName: "Posts",
  Key: { postId: "p-1" },
  UpdateExpression: "SET viewCount = if_not_exists(viewCount, :zero) + :inc",
  ExpressionAttributeValues: { ":inc": 1, ":zero": 0 },
}));
```

**Write sharding (chống hot partition):** khi nhiều write dồn vào cùng một partition key value (ví dụ một sự kiện nóng, một feature flag được mọi request ghi), partition đó bị **hot** và throttle dù bảng dư capacity (vì capacity chia theo partition). Giải pháp: thêm một **shard suffix** ngẫu nhiên/băm vào partition key để trải write ra nhiều partition.

```javascript
// Thay vì PK = "GLOBAL_COUNTER", dùng "GLOBAL_COUNTER#<0..9>"
const shard = Math.floor(Math.random() * 10);
const pk = `GLOBAL_COUNTER#${shard}`;
// Khi đọc tổng: query/scan cả 10 shard rồi cộng lại
```

Đánh đổi: write phân tán tốt hơn nhưng **đọc tổng phải gom nhiều shard**. Chọn số shard cân bằng giữa độ "nóng" write và chi phí đọc.

> 💡 **Exam Tip:** "Throttling on a single hot partition / one partition key receives most traffic" → **write sharding** (thêm suffix vào partition key). "Counter tăng nguyên tử không cần đọc trước" → **atomic counter** với `ADD`/`SET x = x + :n`.

## 32.10 Single-table design (giới thiệu) & large object pattern

**Single-table design:** thay vì mô hình hoá nhiều entity thành nhiều table như RDBMS, người ta thường nhồi **nhiều loại entity vào MỘT table** DynamoDB, dùng partition key/sort key **generic** (ví dụ `PK`, `SK`) cùng các tiền tố để phân biệt entity (`USER#123`, `ORDER#456`). Mục tiêu: phục vụ nhiều access pattern trong **một query duy nhất**, giảm số round-trip và tận dụng GSI overloading (một GSI phục vụ nhiều pattern). Đây là chủ đề thiết kế sâu; với DVA-C02 bạn chỉ cần **nhận diện khái niệm** và hiểu vì sao nó tồn tại (tối ưu cho access pattern đã biết, tránh JOIN). Chi tiết thiết kế nâng cao nằm ngoài phạm vi đề.

**Large object pattern (S3 + metadata):** một item DynamoDB tối đa **400 KB** (tính cả tên thuộc tính + giá trị). Khi cần lưu dữ liệu lớn hơn (ảnh, file, JSON khổng lồ), pattern chuẩn là: **lưu object lên S3**, rồi chỉ lưu **metadata + đường dẫn S3** trong DynamoDB.

```javascript
// 1) Upload file lớn lên S3
// 2) Lưu metadata + S3 key vào DynamoDB
await ddb.send(new PutCommand({
  TableName: "Documents",
  Item: {
    docId: "d-1",
    title: "Báo cáo Q2",
    s3Bucket: "my-docs",
    s3Key: "docs/d-1.pdf",   // chỉ lưu con trỏ, không lưu file
    sizeBytes: 5242880,
  },
}));
```

Pattern này vừa né giới hạn 400 KB, vừa rẻ hơn (S3 lưu rẻ hơn DynamoDB), vừa cho phép dùng presigned URL để client tải trực tiếp từ S3 (chi tiết S3 ở Chương 12–14).

> 💡 **Exam Tip:** Item DynamoDB tối đa **400 KB**. Lưu file/blob lớn → **để trên S3, chỉ lưu metadata + pointer (bucket/key) trong DynamoDB**. Đây là đáp án "đúng nhất" cho mọi tình huống dữ liệu vượt 400 KB.

## 32.11 Phân trang đúng cách với LastEvaluatedKey

Một `Query` hoặc `Scan` trả về tối đa **1 MB dữ liệu** mỗi lần gọi (trước khi áp `FilterExpression`). Nếu kết quả còn nữa, response chứa `LastEvaluatedKey` — con trỏ tới item cuối cùng đã trả. Để lấy trang tiếp, truyền giá trị đó vào `ExclusiveStartKey` của lần gọi sau. Khi response **không còn** `LastEvaluatedKey`, bạn đã đọc hết.

```javascript
import { QueryCommand } from "@aws-sdk/lib-dynamodb";

let lastKey = undefined;
const all = [];
do {
  const res = await ddb.send(new QueryCommand({
    TableName: "Orders",
    KeyConditionExpression: "customerId = :c",
    ExpressionAttributeValues: { ":c": "C-1" },
    ExclusiveStartKey: lastKey,   // undefined ở lần đầu
  }));
  all.push(...res.Items);
  lastKey = res.LastEvaluatedKey; // undefined khi hết trang
} while (lastKey);
```

Bẫy quan trọng về `FilterExpression`: filter được áp **sau khi** đọc 1 MB, **trước khi** trả về. Nghĩa là một trang có thể trả về **mảng `Items` rỗng nhưng vẫn có `LastEvaluatedKey`** (1 MB đọc lên đều bị filter loại). Code phân trang phải lặp đến khi `LastEvaluatedKey` biến mất, **không** được dừng chỉ vì `Items` rỗng. Đây là lỗi production kinh điển khiến "thiếu dữ liệu". Đồng thời, filter **không giảm RCU** — bạn vẫn trả tiền cho 1 MB đọc lên rồi mới lọc.

> 💡 **Exam Tip:** Mỗi Query/Scan trả tối đa **1 MB**, dùng `LastEvaluatedKey` → `ExclusiveStartKey` để phân trang. Lặp đến khi **không còn** `LastEvaluatedKey`, đừng dừng vì `Items` rỗng. `FilterExpression` lọc SAU khi tiêu RCU, **không tiết kiệm capacity** — muốn rẻ phải thiết kế key/index để query đúng, không Scan + filter.

---

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
