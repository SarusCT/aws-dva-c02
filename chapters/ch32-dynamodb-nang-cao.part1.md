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
