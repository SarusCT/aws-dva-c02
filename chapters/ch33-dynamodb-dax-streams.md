# Chương 33: DynamoDB DAX, Streams, TTL & Global Tables

> **Trọng tâm DVA-C02:** Đây là chương "tính năng vận hành" của DynamoDB — đề thi hay hỏi dạng tình huống: latency đọc còn microsecond thì chọn DAX hay ElastiCache; cần phản ứng theo thay đổi item (audit/replicate/materialized view) thì dùng Streams; muốn tự xoá dữ liệu hết hạn mà không tốn write capacity thì dùng TTL; cần multi-region active-active thì bật Global Tables (luôn yêu cầu Streams + last-writer-wins). Ngoài ra còn các điểm nhỏ nhưng "ăn điểm chắc": PITR khôi phục tới giây trong 35 ngày, export to S3 không tốn RCU, và IAM fine-grained với `dynamodb:LeadingKeys`.

## Mục tiêu chương
- Hiểu kiến trúc DAX, phân biệt item cache vs query cache, và biết chính xác khi nào DAX hơn ElastiCache.
- Nắm cơ chế DynamoDB Streams: view types, ordering theo shard, và cách Lambda tiêu thụ qua event source mapping.
- Cấu hình TTL đúng cách, hiểu vì sao TTL không tốn WCU và độ trễ xoá thực tế.
- Triển khai Global Tables version 2019.11.21, hiểu yêu cầu Streams và mô hình last-writer-wins.
- Phân biệt backup on-demand vs PITR, dùng export to S3 cho phân tích, và test offline với DynamoDB Local.
- Viết IAM policy fine-grained giới hạn theo `LeadingKeys` và attributes để mỗi user chỉ thấy dữ liệu của mình.

## 33.1 DynamoDB Accelerator (DAX) — kiến trúc và cơ chế cache

DynamoDB tự nó đã trả về single-digit millisecond latency (vài ms). Nhưng có những workload đọc cực nóng (read-heavy, bursty) cần tới **microsecond** latency, hoặc đang bị throttle vì đọc lặp lại cùng một item hàng triệu lần/giây. DAX (DynamoDB Accelerator) là một **write-through caching layer** in-memory, được quản lý hoàn toàn, đặt ngay trước DynamoDB và **tương thích API hoàn toàn** với DynamoDB — bạn chỉ đổi endpoint client, không phải viết lại logic cache.

Kiến trúc: DAX là một **cluster** gồm 1 node primary (read/write) và tối đa 10 node read-replica (tổng 11 node), trải trên nhiều AZ. Mỗi node là một EC2 instance được quản lý. Khi đọc qua DAX:

- **Cache hit** → DAX trả thẳng từ RAM, latency microsecond, KHÔNG chạm DynamoDB (không tốn RCU).
- **Cache miss** → DAX gọi DynamoDB, lưu kết quả vào cache rồi trả về (tốn RCU lần đó).

Khi ghi, DAX dùng **write-through**: ghi đồng thời vào DynamoDB rồi cập nhật cache. Nghĩa là sau khi write thành công, cache luôn có dữ liệu mới nhất cho item đó (write-through tránh được tình trạng cache stale ngay sau ghi).

DAX có **hai cache độc lập** — đây là điểm thi rất hay hỏi:

| Cache | Phục vụ API | Key cache | TTL mặc định |
|-------|-------------|-----------|--------------|
| **Item cache** | `GetItem`, `BatchGetItem` | theo primary key của item | 5 phút (300s) |
| **Query cache** | `Query`, `Scan` | theo tham số request (KeyConditionExpression, FilterExpression...) | 5 phút (300s) |

Item cache lưu từng item riêng lẻ. Query cache lưu **toàn bộ result set** của một câu Query/Scan, đánh key bằng các tham số của request đó. Hệ quả quan trọng: nếu bạn `UpdateItem` một item, DAX cập nhật item cache cho item đó, NHƯNG **không** vô hiệu hoá các entry trong query cache có thể chứa item đó — vì DAX không biết item này nằm trong những query result nào. Do đó query cache có thể trả về kết quả cũ cho tới khi entry hết TTL.

> 💡 **Exam Tip:** DAX phù hợp workload **đọc nhiều, eventually consistent**. Nếu ứng dụng yêu cầu **strongly consistent read**, DAX **bỏ qua cache** và đọc thẳng từ DynamoDB (pass-through) — không tăng tốc gì cả. Câu hỏi gài: "cần strongly consistent reads với microsecond latency" → DAX KHÔNG giải quyết được.

DAX chạy **trong VPC** (không có public endpoint), client phải nằm trong cùng VPC hoặc kết nối được tới VPC đó. Bạn cần DAX SDK riêng (`amazon-dax-client`) chứ không phải SDK DynamoDB thường, vì DAX dùng giao thức nhị phân riêng.

```javascript
// Node.js — dùng DAX với SDK v3. Cần package amazon-dax-client.
// DAX client wrap lại DynamoDB DocumentClient, API gọi y hệt.
const AmazonDaxClient = require('amazon-dax-client/AmazonDaxClient');
const { DynamoDBDocument } = require('@aws-sdk/lib-dynamodb');

// endpoint cluster DAX (port 8111 cho non-encrypted, 9111 cho TLS)
const dax = new AmazonDaxClient({
  endpoints: ['mycluster.abc123.dax-clusters.us-east-1.amazonaws.com:8111'],
  region: 'us-east-1',
});
const doc = DynamoDBDocument.from(dax);

// GetItem — lần đầu miss (chạm DynamoDB), lần sau hit (microsecond, không tốn RCU)
const res = await doc.get({
  TableName: 'Sessions',
  Key: { sessionId: 'abc-123' },
});
```

**DAX vs ElastiCache** — bảng quyết định kinh điển:

| Tiêu chí | DAX | ElastiCache (Redis/Memcached) |
|----------|-----|-------------------------------|
| Tương thích API DynamoDB | Có — không đổi code logic | Không — phải tự viết cache-aside |
| Loại cache | Item & query cache tự động | Tự quản lý (key tự đặt) |
| Write strategy | Write-through built-in | Tự code (lazy loading / write-through) |
| Cấu trúc dữ liệu phức tạp | Không (chỉ DynamoDB item) | Có (sorted set, list, pub/sub...) |
| Cache dữ liệu ngoài DynamoDB | Không | Có (RDS, kết quả tính toán...) |
| Consistency | Eventually consistent | Tuỳ chiến lược |

> 💡 **Exam Tip:** Từ khoá phân biệt: nếu đề nói "**cache cho DynamoDB**, ít thay đổi code, microsecond latency, read-heavy" → **DAX**. Nếu cần cache cho **dữ liệu không phải DynamoDB**, hoặc cần cấu trúc dữ liệu nâng cao (leaderboard sorted set), hoặc session store dùng chung nhiều service → **ElastiCache** (chi tiết ở Chương 9).

Bẫy thực tế: DAX **không phù hợp** cho workload write-heavy (vì mọi write đều đi qua DynamoDB như bình thường, DAX không giảm WCU), cũng không phù hợp khi mỗi key chỉ được đọc một lần (hit rate thấp, cache vô dụng). DAX cũng chỉ hỗ trợ một số API: các API ghi (Put/Update/Delete/Batch/Transact write) là write-through; `TransactGetItems` đi pass-through (không cache).

## 33.2 DynamoDB Streams — change data capture

DynamoDB Streams là một **time-ordered log** ghi lại mọi thay đổi item-level (insert, modify, remove) trên bảng, giữ trong **24 giờ**. Đây là nền tảng cho event-driven trên DynamoDB: bạn không cần poll bảng để biết "có gì thay đổi", mà subscribe vào stream và react.

Bật stream bằng cách chọn **StreamViewType** — quyết định mỗi record chứa "ảnh" nào của item:

| StreamViewType | Nội dung mỗi record |
|----------------|---------------------|
| `KEYS_ONLY` | Chỉ key của item bị thay đổi |
| `NEW_IMAGE` | Toàn bộ item SAU thay đổi |
| `OLD_IMAGE` | Toàn bộ item TRƯỚC thay đổi |
| `NEW_AND_OLD_IMAGES` | Cả trước và sau |

`NEW_AND_OLD_IMAGES` hữu ích nhất cho audit (so sánh diff) và materialized view, nhưng tốn nhiều dung lượng stream hơn. `OLD_IMAGE` cần thiết khi xử lý sự kiện xoá để biết item đã xoá chứa gì.

Cơ chế ordering: stream được chia thành **shards**, ánh xạ tương ứng với partition của bảng. Các thay đổi cho **cùng một partition key** được đưa vào cùng shard và **đảm bảo thứ tự** (ordered) — bạn nhận record theo đúng trình tự thay đổi. Giữa các partition key khác nhau (shard khác nhau) thì không đảm bảo thứ tự toàn cục. Đây là kiến trúc tương tự Kinesis Data Streams (chi tiết Kinesis ở Chương 23).

> 💡 **Exam Tip:** Mỗi thay đổi xuất hiện **đúng một lần** trong stream (exactly-once vào stream), và thứ tự thay đổi của **cùng một item** được đảm bảo. Đây là khác biệt then chốt so với việc poll bảng. Nhưng phía consumer (Lambda) thì xử lý **at-least-once** — có thể bị gọi lại record nếu lỗi, nên handler phải idempotent.

Use case điển hình:
- **Audit / change history**: stream → Lambda → ghi log thay đổi vào bảng khác hoặc S3.
- **Replication / materialized view**: cập nhật một bảng aggregate khác mỗi khi bảng gốc đổi (ví dụ đếm số order theo user).
- **Cross-region replication**: chính là cơ chế bên dưới của Global Tables (mục 33.4).
- **Trigger downstream**: gửi notification (SNS), index sang OpenSearch, đẩy vào Kinesis Firehose.

```bash
# Bật stream với view type NEW_AND_OLD_IMAGES trên bảng có sẵn
aws dynamodb update-table \
  --table-name Orders \
  --stream-specification StreamEnabled=true,StreamViewType=NEW_AND_OLD_IMAGES
```

Consumer phổ biến nhất là **Lambda qua event source mapping (ESM)**. Lambda poll stream giúp bạn (bạn không tự poll), gom record thành batch và gọi function. Một ví dụ handler:

```javascript
// Lambda xử lý DynamoDB Stream — event.Records là batch các thay đổi
exports.handler = async (event) => {
  for (const record of event.Records) {
    // eventName: INSERT | MODIFY | REMOVE
    if (record.eventName === 'INSERT') {
      // NewImage ở định dạng DynamoDB JSON (có kiểu S/N/M...)
      const newItem = record.dynamodb.NewImage;
      console.log('Item mới:', JSON.stringify(newItem));
    } else if (record.eventName === 'REMOVE') {
      const oldItem = record.dynamodb.OldImage; // cần OLD_IMAGE để có dữ liệu
      console.log('Đã xoá:', JSON.stringify(oldItem));
    }
  }
  // Trả về để báo xử lý xong cả batch (xem partial batch response ở Ch30)
  return { batchItemFailures: [] };
};
```

Các tham số ESM quan trọng cho stream: **batch size** (tối đa 10.000 record cho stream, mặc định 100), **batch window**, **starting position** (`TRIM_HORIZON` đọc từ đầu stream còn giữ, `LATEST` chỉ đọc record mới), **parallelization factor** (1–10 — chạy song song nhiều Lambda trên CÙNG một shard nhưng vẫn giữ thứ tự theo partition key), **bisect on error** (chia đôi batch khi lỗi để cô lập record hỏng), **on-failure destination** (SQS/SNS nhận record lỗi sau khi hết retry). Chi tiết đầy đủ về cấu hình ESM, ordering và xử lý lỗi ở **Chương 30** — chương này chỉ giới thiệu để bạn thấy bức tranh tổng.

> 💡 **Exam Tip:** Stream chỉ giữ **24 giờ**. Nếu cần lưu trữ thay đổi lâu hơn để phân tích, hãy đẩy từ stream sang đích bền vững (S3 qua Firehose, hoặc bảng khác). Đừng nhầm với Kinesis Data Streams (retention tới 365 ngày) — bạn cũng có thể bật **Kinesis Data Streams** cho bảng DynamoDB như một lựa chọn thay thế khi cần retention dài và nhiều consumer.

Lưu ý: một stream cho phép tối đa **2 consumer process** đọc đồng thời mỗi shard. Vượt quá sẽ bị throttle. Nếu cần fan-out nhiều consumer, cân nhắc dùng Kinesis Data Streams thay vì DynamoDB Streams native.

## 33.3 Time To Live (TTL) — tự động hết hạn dữ liệu

TTL cho phép DynamoDB **tự động xoá item** sau một thời điểm bạn định nghĩa, mà **không tốn write capacity (WCU)** cho thao tác xoá đó. Đây là cách lý tưởng để dọn session hết hạn, log tạm, dữ liệu cache trong bảng, sự kiện cũ — giảm chi phí lưu trữ và giữ bảng gọn.

Cơ chế: bạn chỉ định **một attribute kiểu Number** chứa timestamp ở định dạng **Unix epoch giây** (số giây từ 1970-01-01 UTC). Khi `thời điểm hiện tại > giá trị TTL attribute`, item trở thành **ứng viên để xoá**. DynamoDB có một background process quét và xoá các item hết hạn.

```javascript
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocument } = require('@aws-sdk/lib-dynamodb');
const doc = DynamoDBDocument.from(new DynamoDBClient({}));

// Đặt item hết hạn sau 1 giờ kể từ bây giờ
const expireAt = Math.floor(Date.now() / 1000) + 3600; // epoch SECONDS, không phải ms!
await doc.put({
  TableName: 'Sessions',
  Item: { sessionId: 'abc-123', data: '...', ttl: expireAt },
});
```

```bash
# Bật TTL, chỉ định attribute 'ttl' làm cột hết hạn
aws dynamodb update-time-to-live \
  --table-name Sessions \
  --time-to-live-specification "Enabled=true, AttributeName=ttl"
```

Những điểm BẪY và điểm thi:

- **Định dạng phải là epoch giây**, không phải milliseconds. Đây là lỗi kinh điển: nếu bạn lưu `Date.now()` (milliseconds), giá trị sẽ thành năm ~52000, item không bao giờ hết hạn. Dùng `Math.floor(Date.now()/1000)`.
- **Không xoá tức thì.** TTL chỉ đảm bảo xoá **trong vòng vài ngày** sau thời điểm hết hạn (thường vài phút đến 48 giờ tuỳ tải bảng). Tới hạn KHÔNG có nghĩa item biến mất ngay.
- Vì item có thể còn tồn tại sau thời điểm hết hạn, các thao tác `Query`/`Scan` vẫn có thể trả về item đã hết hạn nhưng **chưa bị xoá**. Nếu ứng dụng cần "không bao giờ thấy item hết hạn", phải **lọc bằng FilterExpression** trên TTL attribute trong code.
- Việc xoá bởi TTL **không tốn WCU** và **không ảnh hưởng throughput** của bảng — đây chính là lợi thế so với việc tự chạy job DeleteItem (vốn tốn WCU).
- Item bị TTL xoá **vẫn xuất hiện trong DynamoDB Streams** dưới dạng `REMOVE`, với một dấu hiệu đặc biệt: `userIdentity.principalId = "dynamodb.amazonaws.com"` và `type = "Service"`. Nhờ đó bạn phân biệt được xoá-do-TTL với xoá-do-user, ví dụ để archive item hết hạn sang S3 trước khi mất hẳn.

> 💡 **Exam Tip:** Combo kinh điển: **TTL + Streams = archive tự động**. Item hết hạn → TTL xoá → record REMOVE vào stream → Lambda đẩy `OldImage` sang S3/Glacier. Cần `OLD_IMAGE` hoặc `NEW_AND_OLD_IMAGES` để Lambda có dữ liệu item đã xoá.

> 💡 **Exam Tip:** "Cần xoá hàng triệu item hết hạn mà không tốn capacity / không viết job" → **TTL**. Nếu đề nhấn "phải xoá CHÍNH XÁC tại thời điểm" → TTL KHÔNG đảm bảo (chỉ best-effort vài ngày), cần cơ chế khác.

## 33.4 Global Tables — multi-region active-active

Global Tables biến một bảng DynamoDB thành bảng **multi-region, multi-active**: bạn có một bản sao (replica) ở mỗi region, và ứng dụng có thể **đọc VÀ ghi ở bất kỳ region nào**. DynamoDB tự replicate thay đổi giữa các region. Dùng cho ứng dụng toàn cầu cần low latency cho user ở nhiều châu lục, hoặc disaster recovery đa region.

**Yêu cầu bắt buộc**: Global Tables dựa trên **DynamoDB Streams** để replicate — vì vậy stream (`NEW_AND_OLD_IMAGES`) **phải được bật**. Mỗi region đọc stream của region kia và áp dụng thay đổi. Version mới (**2019.11.21**) còn yêu cầu các replica có cùng cấu hình (cùng tên bảng, cùng key schema) và bảng phải rỗng khi thêm region đầu tiên (với version 2019.11.21 thì linh hoạt hơn, có thể thêm replica vào bảng đã có data).

Mô hình giải quyết xung đột: **last-writer-wins**. Khi cùng một item bị ghi ở hai region gần như đồng thời, DynamoDB dùng timestamp để quyết định bản ghi nào "thắng" — bản ghi mới nhất (theo thời gian) được giữ, bản kia bị ghi đè. Không có locking xuyên region.

> 💡 **Exam Tip:** Global Tables = **eventually consistent** giữa các region (thường replicate dưới 1 giây nhưng KHÔNG đảm bảo). Trong cùng một region thì vẫn có strongly consistent read như bình thường, nhưng **đọc cross-region luôn eventually consistent**. Xung đột giải bằng **last-writer-wins**. Hai từ khoá này gần như chắc chắn xuất hiện trong câu hỏi về Global Tables.

```bash
# Tạo replica thứ hai ở us-west-2 cho bảng đang ở us-east-1
# (Bảng phải đã bật streams NEW_AND_OLD_IMAGES)
aws dynamodb update-table \
  --table-name Orders \
  --region us-east-1 \
  --replica-updates '[{"Create": {"RegionName": "us-west-2"}}]'
```

Lưu ý thiết kế: vì last-writer-wins có thể mất dữ liệu khi ghi xung đột, Global Tables phù hợp nhất với workload mà mỗi user/region ghi vào phần dữ liệu riêng (ít ghi đè chéo), ví dụ "mỗi user gắn với region gần nhất". Nếu nhiều region cùng tăng một counter chung, last-writer-wins sẽ làm sai số đếm — đó là anti-pattern.

Global Tables tính phí **replicated write request units (rWCU)** cho việc replicate, cộng với cross-region data transfer. Bạn vẫn dùng on-demand hoặc provisioned (với auto scaling khuyến nghị) cho mỗi replica.

## 33.5 Backup, Point-in-Time Recovery & Export to S3

DynamoDB có hai cơ chế backup khác hẳn nhau — đề thi rất hay so sánh:

**On-demand backup**: chụp **full backup** toàn bảng tại thời điểm bạn yêu cầu, giữ vô thời hạn cho tới khi bạn xoá. Backup hoàn tất gần như tức thì, **không tốn capacity** và không ảnh hưởng performance bảng. Dùng cho lưu trữ dài hạn, tuân thủ (compliance), hoặc snapshot trước khi thay đổi lớn. Có thể tích hợp **AWS Backup** để quản lý lịch và lifecycle tập trung.

```bash
aws dynamodb create-backup --table-name Orders --backup-name orders-2026-06-12
```

**Point-in-Time Recovery (PITR)**: khi bật, DynamoDB liên tục backup bảng và cho phép **khôi phục về bất kỳ thời điểm nào (tới từng giây) trong vòng 35 ngày gần nhất**. Đây là cứu cánh khi bị xoá/ghi nhầm dữ liệu — bạn restore về thời điểm "ngay trước khi sự cố". PITR cũng **không ảnh hưởng performance**.

```bash
# Bật PITR
aws dynamodb update-continuous-backups \
  --table-name Orders \
  --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true

# Khôi phục về một thời điểm cụ thể — LUÔN tạo bảng MỚI, không ghi đè bảng cũ
aws dynamodb restore-table-to-point-in-time \
  --source-table-name Orders \
  --target-table-name Orders-restored \
  --restore-date-time 2026-06-11T10:00:00Z
```

| | On-demand backup | PITR |
|---|---|---|
| Phạm vi | Snapshot tại một thời điểm | Bất kỳ giây nào trong 35 ngày |
| Retention | Vô hạn (tới khi xoá) | Cuộn 35 ngày |
| Mục đích | Lưu trữ dài hạn, compliance | Khôi phục lỗi vận hành gần đây |
| Restore | Tạo bảng mới | Tạo bảng mới |

> 💡 **Exam Tip:** Cả hai cơ chế **restore vào BẢNG MỚI** — không bao giờ ghi đè lên bảng gốc. Restore cũng KHÔNG mang theo các cài đặt như: TTL, auto scaling policy, Streams, IAM policy, tags (một số phải bật lại thủ công). "Xoá nhầm item 2 giờ trước, cần lấy lại chính xác trạng thái lúc đó" → **PITR**. "Giữ bản backup nhiều năm cho audit" → **on-demand backup**.

**Export to S3**: xuất dữ liệu bảng sang S3 ở định dạng **DynamoDB JSON** hoặc **Amazon Ion**, dùng để phân tích bằng Athena, Glue, EMR... Điểm quan trọng cho đề: export **YÊU CẦU PITR phải được bật**, có thể export **full** hoặc **incremental** (chỉ thay đổi trong một khoảng thời gian), và **KHÔNG tốn RCU** — vì nó đọc từ backup PITR chứ không scan bảng live. Nhờ vậy export không ảnh hưởng throughput của ứng dụng đang chạy. Bạn cũng có thể export dữ liệu của một point-in-time bất kỳ trong window PITR.

```bash
aws dynamodb export-table-to-point-in-time \
  --table-arn arn:aws:dynamodb:us-east-1:111122223333:table/Orders \
  --s3-bucket my-analytics-bucket \
  --export-format DYNAMODB_JSON
```

> 💡 **Exam Tip:** Cần phân tích dữ liệu DynamoDB bằng Athena/Spark mà **không Scan bảng** (tránh tốn RCU và ảnh hưởng app) → **Export to S3** (nhớ: phải bật PITR trước). Đây là lựa chọn "least operational overhead" so với tự viết job scan.

## 33.6 DynamoDB Local & IAM fine-grained access control

**DynamoDB Local** là phiên bản DynamoDB chạy trên máy bạn (file `.jar` hoặc Docker image `amazon/dynamodb-local`), dùng để **phát triển và test offline** mà không tốn tiền, không chạm cloud. API tương thích nên code SDK chạy y hệt, chỉ cần trỏ endpoint về `http://localhost:8000`. Rất hợp cho CI/CD và unit test.

```bash
# Chạy DynamoDB Local bằng Docker
docker run -p 8000:8000 amazon/dynamodb-local
```

```javascript
// Trỏ SDK về DynamoDB Local khi chạy test
const client = new DynamoDBClient({
  endpoint: 'http://localhost:8000',
  region: 'local',          // region tuỳ ý, không cần thật
  credentials: { accessKeyId: 'fake', secretAccessKey: 'fake' },
});
```

Lưu ý: DynamoDB Local mô phỏng hành vi nhưng **không hoàn toàn giống** production — ví dụ throttling, một số quirk của Streams hay Global Tables không tái hiện chính xác. Đừng dựa vào nó để test performance.

**IAM fine-grained access control**: ngoài việc cấp quyền theo bảng (table-level), DynamoDB cho phép giới hạn quyền tới **item-level** và **attribute-level** ngay trong IAM policy bằng `Condition`. Đây là cơ chế nền cho mô hình "mỗi user chỉ truy cập dữ liệu của mình" mà không cần lớp middleware kiểm tra.

- **`dynamodb:LeadingKeys`**: giới hạn user chỉ thao tác trên item có **partition key** khớp một giá trị (thường là user ID lấy từ identity). "Leading" = key đầu tiên (partition key).
- **`dynamodb:Attributes`** + `StringEqualsIfExists` với `dynamodb:Select`/`dynamodb:ReturnValues`: giới hạn user chỉ đọc/ghi **một số attribute** nhất định.

Ví dụ policy: user chỉ được đọc/ghi item có partition key bằng chính `UserId` của họ (kết hợp với Cognito Identity Pools — chi tiết ở Chương 39):

```json
{
  "Effect": "Allow",
  "Action": ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem"],
  "Resource": "arn:aws:dynamodb:us-east-1:111122223333:table/UserData",
  "Condition": {
    "ForAllValues:StringEquals": {
      "dynamodb:LeadingKeys": ["${cognito-identity.amazonaws.com:sub}"]
    }
  }
}
```

Ở đây `${cognito-identity.amazonaws.com:sub}` là policy variable thay bằng identity ID của user đăng nhập. Kết quả: user A query bảng `UserData` chỉ trả về item có partition key = ID của A; cố đọc item của user B sẽ bị `AccessDenied`. Toàn bộ kiểm soát nằm ở tầng IAM, không cần code kiểm tra quyền.

> 💡 **Exam Tip:** Tình huống "mobile app, mỗi user truy cập DynamoDB trực tiếp nhưng chỉ được thấy dữ liệu của chính mình" → **IAM policy với `dynamodb:LeadingKeys`** kết hợp **Cognito Identity Pools** cấp credentials tạm. Đây là pattern bảo mật chuẩn, tránh phải dựng backend trung gian chỉ để lọc quyền. Để giới hạn theo cột, dùng `dynamodb:Attributes`.

---

## Hands-on Lab: Streams → Lambda → materialized view, kèm TTL và PITR

**Mục tiêu lab:** Dựng một pipeline DynamoDB hoàn chỉnh dùng đúng các tính năng trọng tâm chương 33:
- Bật **DynamoDB Streams** với view type `NEW_AND_OLD_IMAGES`.
- Gắn một **Lambda** qua **event source mapping** để xử lý stream records (tạo "materialized view" đếm số order theo từng customer trong một bảng aggregate).
- Bật **TTL** để item tự xoá sau khi hết hạn và quan sát record TTL-delete chảy vào Stream.
- Bật **Point-in-Time Recovery (PITR)** và thực hiện **export to S3**.
- Quan sát chi phí: thao tác xoá bởi TTL **không tốn WCU**, nhưng vẫn sinh stream record.

**Chuẩn bị:**
- AWS CLI v2 đã cấu hình (`aws configure`), region ví dụ `ap-southeast-1`.
- Quyền IAM tạo DynamoDB table, Lambda, IAM role, S3 bucket.
- Node.js 20 để đóng gói Lambda. Toàn bộ lệnh dùng region trong biến `$REGION`.

```bash
export REGION=ap-southeast-1
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "Account=$ACCOUNT_ID Region=$REGION"
```

### Bước 1: Tạo bảng nguồn `Orders` với Streams bật sẵn

```bash
aws dynamodb create-table \
  --table-name Orders \
  --attribute-definitions \
      AttributeName=customerId,AttributeType=S \
      AttributeName=orderId,AttributeType=S \
  --key-schema \
      AttributeName=customerId,KeyType=HASH \
      AttributeName=orderId,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST \
  --stream-specification StreamEnabled=true,StreamViewType=NEW_AND_OLD_IMAGES \
  --region $REGION
```

Đợi bảng `ACTIVE` và lấy **Stream ARN** (chú ý: ARN của stream có hậu tố timestamp, khác với table ARN):

```bash
aws dynamodb wait table-exists --table-name Orders --region $REGION
STREAM_ARN=$(aws dynamodb describe-table --table-name Orders --region $REGION \
  --query 'Table.LatestStreamArn' --output text)
echo "STREAM_ARN=$STREAM_ARN"
```

Output mong đợi: chuỗi dạng `arn:aws:dynamodb:ap-southeast-1:123...:table/Orders/stream/2026-06-12T...`.

### Bước 2: Tạo bảng aggregate `CustomerOrderCount`

Đây là "materialized view" — Lambda sẽ tăng/giảm bộ đếm tại đây.

```bash
aws dynamodb create-table \
  --table-name CustomerOrderCount \
  --attribute-definitions AttributeName=customerId,AttributeType=S \
  --key-schema AttributeName=customerId,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region $REGION
aws dynamodb wait table-exists --table-name CustomerOrderCount --region $REGION
```

### Bước 3: Tạo IAM Role cho Lambda

Lambda đọc stream cần các quyền `GetRecords`, `GetShardIterator`, `DescribeStream`, `ListStreams` trên **stream ARN**, cộng quyền ghi vào bảng aggregate và viết log.

```bash
cat > trust.json <<'EOF'
{ "Version": "2012-10-17",
  "Statement": [{ "Effect": "Allow",
    "Principal": { "Service": "lambda.amazonaws.com" },
    "Action": "sts:AssumeRole" }] }
EOF

aws iam create-role --role-name ddb-stream-lambda-role \
  --assume-role-policy-document file://trust.json

aws iam attach-role-policy --role-name ddb-stream-lambda-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

cat > inline.json <<EOF
{ "Version": "2012-10-17", "Statement": [
  { "Effect": "Allow",
    "Action": ["dynamodb:GetRecords","dynamodb:GetShardIterator",
               "dynamodb:DescribeStream","dynamodb:ListStreams"],
    "Resource": "${STREAM_ARN}" },
  { "Effect": "Allow",
    "Action": "dynamodb:UpdateItem",
    "Resource": "arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/CustomerOrderCount" }
]}
EOF

aws iam put-role-policy --role-name ddb-stream-lambda-role \
  --policy-name stream-access --policy-document file://inline.json
ROLE_ARN=$(aws iam get-role --role-name ddb-stream-lambda-role --query 'Role.Arn' --output text)
```

> Bẫy: quyền stream phải đặt trên **stream ARN** (có `/stream/<timestamp>`), KHÔNG phải table ARN. Đặt nhầm table ARN sẽ khiến event source mapping báo trạng thái `Problem: ... is not authorized`.

### Bước 4: Viết và deploy Lambda xử lý stream

```javascript
// index.mjs — Node.js 20, AWS SDK v3 (có sẵn trong runtime)
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = "CustomerOrderCount";

export const handler = async (event) => {
  for (const r of event.Records) {
    // eventName: INSERT | MODIFY | REMOVE
    // Keys luôn ở dạng DynamoDB JSON (đã unmarshall thủ công ở đây)
    const customerId = r.dynamodb.Keys.customerId.S;
    let delta = 0;
    if (r.eventName === "INSERT") delta = 1;
    else if (r.eventName === "REMOVE") delta = -1;        // gồm cả TTL-delete
    if (delta === 0) continue;                            // MODIFY: bỏ qua

    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { customerId },
      UpdateExpression: "ADD orderCount :d",
      ExpressionAttributeValues: { ":d": delta },
    }));
  }
  return { batchItemFailures: [] };   // partial batch response (chi tiết ở Chương 30)
};
```

Đóng gói và tạo function (gắn event source vào stream với `--starting-position LATEST`):

```bash
zip function.zip index.mjs
aws lambda create-function --function-name OrderAggregator \
  --runtime nodejs20.x --handler index.handler \
  --zip-file fileb://function.zip --role $ROLE_ARN \
  --region $REGION --timeout 30

# Đợi role propagate vài giây nếu báo lỗi assume role
aws lambda create-event-source-mapping \
  --function-name OrderAggregator \
  --event-source-arn $STREAM_ARN \
  --starting-position LATEST \
  --batch-size 100 \
  --maximum-batching-window-in-seconds 5 \
  --function-response-types ReportBatchItemFailures \
  --region $REGION
```

Kiểm tra mapping đã `Enabled`:

```bash
aws lambda list-event-source-mappings --function-name OrderAggregator \
  --region $REGION --query 'EventSourceMappings[0].State'
```
Output mong đợi: `"Enabled"` (lúc đầu có thể là `"Creating"`).

### Bước 5: Ghi vài order và kiểm tra materialized view

```bash
aws dynamodb put-item --table-name Orders --region $REGION \
  --item '{"customerId":{"S":"c1"},"orderId":{"S":"o1"},"amount":{"N":"100"}}'
aws dynamodb put-item --table-name Orders --region $REGION \
  --item '{"customerId":{"S":"c1"},"orderId":{"S":"o2"},"amount":{"N":"50"}}'
aws dynamodb put-item --table-name Orders --region $REGION \
  --item '{"customerId":{"S":"c2"},"orderId":{"S":"o3"},"amount":{"N":"75"}}'

sleep 10
aws dynamodb get-item --table-name CustomerOrderCount --region $REGION \
  --key '{"customerId":{"S":"c1"}}'
```
Output mong đợi: `c1` có `orderCount = 2`, `c2` có `orderCount = 1`. Đây là materialized view được dựng bất đồng bộ từ Stream.

### Bước 6: Bật TTL và quan sát record xoá chảy vào Stream

Bật TTL trên thuộc tính `expireAt` (kiểu Number, là **epoch giây** — KHÔNG phải milli-giây):

```bash
aws dynamodb update-time-to-live --table-name Orders --region $REGION \
  --time-to-live-specification "Enabled=true,AttributeName=expireAt"
```

Ghi một item hết hạn sau 60 giây:

```bash
EXP=$(($(date +%s) + 60))
aws dynamodb put-item --table-name Orders --region $REGION \
  --item "{\"customerId\":{\"S\":\"c1\"},\"orderId\":{\"S\":\"tmp\"},\"expireAt\":{\"N\":\"$EXP\"}}"
```

> Lưu ý: TTL xoá item **không đảm bảo đúng giây** — AWS thường xoá trong vòng ~vài phút tới 48 giờ sau thời điểm hết hạn (typically vài phút với table nhỏ). Khi item bị TTL xoá, một stream record `REMOVE` với `userIdentity.principalId = "dynamodb.amazonaws.com"` được phát đi — nhờ đó Lambda phân biệt được "xoá do TTL" với "xoá do app". Thao tác TTL-delete **không tiêu tốn WCU**.

Sau vài phút, kiểm tra `c1.orderCount` đã giảm về 2 (item `tmp` bị xoá, Lambda trừ 1 — nhưng vì `tmp` được cộng 1 lúc INSERT nên về lại 2).

### Bước 7: Bật PITR và export to S3

```bash
aws dynamodb update-continuous-backups --table-name Orders --region $REGION \
  --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true

# Tạo bucket nhận export
aws s3 mb s3://ddb-export-$ACCOUNT_ID-$REGION --region $REGION

aws dynamodb export-table-to-point-in-time \
  --table-arn arn:aws:dynamodb:$REGION:$ACCOUNT_ID:table/Orders \
  --s3-bucket ddb-export-$ACCOUNT_ID-$REGION \
  --export-format DYNAMODB_JSON \
  --region $REGION
```
Output mong đợi: một `ExportArn` và trạng thái `IN_PROGRESS`. Export đọc dữ liệu từ backup PITR, **không tiêu thụ RCU của bảng** và không ảnh hưởng hiệu năng production. Export chỉ chạy được khi PITR đã bật.

### Dọn dẹp tài nguyên

```bash
# Xoá event source mapping
UUID=$(aws lambda list-event-source-mappings --function-name OrderAggregator \
  --region $REGION --query 'EventSourceMappings[0].UUID' --output text)
aws lambda delete-event-source-mapping --uuid $UUID --region $REGION

aws lambda delete-function --function-name OrderAggregator --region $REGION
aws dynamodb delete-table --table-name Orders --region $REGION
aws dynamodb delete-table --table-name CustomerOrderCount --region $REGION
aws s3 rb s3://ddb-export-$ACCOUNT_ID-$REGION --force

aws iam delete-role-policy --role-name ddb-stream-lambda-role --policy-name stream-access
aws iam detach-role-policy --role-name ddb-stream-lambda-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam delete-role --role-name ddb-stream-lambda-role
rm -f trust.json inline.json index.mjs function.zip
```

> DynamoDB Streams retention là **24 giờ** — không cần dọn riêng, hết hạn tự mất khi xoá bảng. Bucket S3 export phải dọn tay (lệnh `rb --force` ở trên). PITR tắt khi xoá bảng.

## 💡 Exam Tips chương 33

- **DAX là write-through cache cho DynamoDB**, chỉ tăng tốc **eventually consistent reads** (item cache & query cache). Strongly consistent reads đi thẳng qua DAX tới DynamoDB (không cache) → không nhanh hơn. DAX dùng client SDK riêng (DAX client), endpoint cluster, chạy **trong VPC**.
- **DAX vs ElastiCache:** DAX khi cache đối tượng chính là DynamoDB API call (ít/không phải code lại, microsecond latency cho read-heavy + eventually consistent OK). ElastiCache khi cần cấu trúc dữ liệu phức tạp (sorted set, pub/sub), aggregate result tuỳ biến, hoặc cache nhiều nguồn.
- **DAX item cache** lưu kết quả `GetItem`/`BatchGetItem`; **query cache** lưu kết quả `Query`/`Scan`. Write qua DAX là write-through: ghi vào DynamoDB rồi cập nhật item cache.
- **DynamoDB Streams retention = 24 giờ**, không thay đổi được. Có **4 view types**: `KEYS_ONLY`, `NEW_IMAGE`, `OLD_IMAGE`, `NEW_AND_OLD_IMAGES`. Đổi view type phải tắt rồi bật lại stream (tạo stream ARN mới).
- **Global Tables BẮT BUỘC bật DynamoDB Streams** (view type `NEW_AND_OLD_IMAGES`) — đó là cơ chế replication. Xung đột giải quyết bằng **last-writer-wins** (dựa trên timestamp). Global Tables cho multi-region, multi-active (read+write ở mọi region).
- **TTL:** thuộc tính phải kiểu **Number**, giá trị là **Unix epoch theo giây** (không phải ms). Xoá do TTL **không tốn WCU**, nhưng có **độ trễ** (vài phút đến 48h). TTL-delete sinh stream record `REMOVE` với principal `dynamodb.amazonaws.com`.
- **Bẫy TTL kinh điển:** item đã quá hạn TTL **vẫn có thể xuất hiện** trong kết quả `Query`/`Scan` cho đến khi background process xoá. Muốn loại hẳn item hết hạn ngay → thêm **filter expression** so sánh `expireAt > now`.
- **PITR** cho phép khôi phục về bất kỳ thời điểm nào trong **35 ngày** gần nhất, độ chi tiết tới giây. Restore luôn tạo **bảng MỚI** (không ghi đè bảng cũ). On-demand backup giữ vô thời hạn tới khi xoá thủ công.
- **Export to S3** yêu cầu **PITR đã bật**, đọc từ backup nên **không tiêu thụ RCU** và không ảnh hưởng throughput bảng. Định dạng `DYNAMODB_JSON` hoặc `ION`. Khác với Scan (Scan tốn RCU, ảnh hưởng hiệu năng).
- **IAM fine-grained access:** dùng condition `dynamodb:LeadingKeys` để giới hạn user chỉ truy cập item có partition key khớp identity (ví dụ `${cognito-identity.amazonaws.com:sub}`), và `dynamodb:Attributes` để giới hạn cột được đọc/ghi — thường kết hợp Cognito Identity Pool (chi tiết ở Chương 39).
- **DynamoDB Local** là bản chạy offline để dev/test, không phải dịch vụ production; truy cập qua endpoint `http://localhost:8000`.
- Stream + Lambda dùng **event source mapping** (Lambda poll stream theo shard, giữ ordering trong shard). Lỗi xử lý có thể block shard — cấu hình `bisectBatchOnFunctionError`, `maximumRetryAttempts`, on-failure destination (chi tiết ở Chương 30).

## Quiz chương 33 (10 câu)

**Câu 1.** Một ứng dụng đọc cùng vài item DynamoDB rất nhiều lần mỗi giây, chấp nhận eventual consistency, và cần latency cỡ micro-giây mà không muốn sửa nhiều code. Giải pháp nào phù hợp nhất?
- A. Thêm ElastiCache for Redis trước DynamoDB
- B. Dùng DynamoDB Accelerator (DAX)
- C. Bật strongly consistent reads
- D. Tăng RCU provisioned lên 10 lần

**Câu 2.** Để dùng Global Tables, điều kiện tiên quyết nào phải có trên mỗi bảng?
- A. Point-in-Time Recovery
- B. DynamoDB Streams với view type NEW_AND_OLD_IMAGES
- C. Provisioned capacity mode
- D. TTL được bật

**Câu 3.** Một developer bật TTL với attribute `expireAt`. Item đặt `expireAt` cách đây 2 phút nhưng `Query` vẫn trả về nó. Vì sao?
- A. TTL chỉ hoạt động với on-demand mode
- B. `expireAt` phải là kiểu String
- C. TTL xoá có độ trễ; item hết hạn vẫn xuất hiện cho tới khi bị xoá nền — cần filter expression để loại ngay
- D. TTL không hỗ trợ bảng có sort key

**Câu 4.** Khi item bị xoá bởi TTL, điều nào ĐÚNG?
- A. Thao tác tốn 1 WCU cho mỗi item
- B. Không sinh stream record
- C. Sinh stream record REMOVE với principal là dynamodb.amazonaws.com và không tốn WCU
- D. Item bị xoá đồng bộ ngay tại thời điểm hết hạn

**Câu 5.** Team cần khôi phục bảng về trạng thái lúc 14:32 hôm qua sau khi một bản deploy lỗi ghi đè dữ liệu. Họ đã bật PITR. Cách đúng?
- A. Restore PITR ghi đè trực tiếp lên bảng hiện tại
- B. Restore PITR tạo một bảng mới tại thời điểm chỉ định, rồi chuyển traffic sang
- C. Dùng on-demand backup vì PITR không hỗ trợ chọn giờ
- D. Export to S3 rồi import ngược lại bằng Scan

**Câu 6.** Ứng dụng cần audit log mọi thay đổi item và đẩy sang một hệ thống phân tích, đảm bảo xử lý theo thứ tự trong từng partition key. Giải pháp ít vận hành nhất?
- A. Bật DynamoDB Streams + Lambda event source mapping
- B. Cron Scan định kỳ so sánh diff
- C. Ghi đồng thời vào DynamoDB và SQS từ application code
- D. Bật CloudTrail data events cho mọi PutItem

**Câu 7.** Một developer muốn DAX tăng tốc các lệnh đọc, nhưng thấy `GetItem` với `ConsistentRead=true` không nhanh hơn. Vì sao?
- A. DAX không hỗ trợ GetItem
- B. Strongly consistent read đi qua DAX nhưng phải tới DynamoDB lấy bản mới nhất, không phục vụ từ cache
- C. DAX chỉ cache Query, không cache GetItem
- D. Cần bật DAX encryption mới có cache

**Câu 8.** Cần export 500 GB từ bảng DynamoDB sang S3 cho team data lake mà KHÔNG ảnh hưởng throughput production. Cách đúng?
- A. Parallel Scan với nhiều segment
- B. Bật PITR rồi dùng Export to S3 (đọc từ backup, không tốn RCU)
- C. Tăng RCU tạm thời rồi Scan
- D. Dùng DynamoDB Streams ghi ra S3

**Câu 9.** Trong Global Table 2 region, cùng một item được ghi gần như đồng thời ở cả hai region với giá trị khác nhau. Kết quả cuối cùng được quyết định thế nào?
- A. Ghi ở region chính (primary) thắng
- B. DynamoDB từ chối cả hai ghi
- C. Last-writer-wins dựa trên timestamp
- D. Hai phiên bản cùng tồn tại, app phải tự merge

**Câu 10.** Một mobile app cho phép mỗi user chỉ đọc/ghi item của chính họ trong bảng dùng chung (partition key = userId). Cách thực thi an toàn nhất ở tầng IAM?
- A. Tạo một IAM user riêng cho mỗi end user
- B. IAM policy với condition `dynamodb:LeadingKeys` khớp `${cognito-identity.amazonaws.com:sub}`, cấp qua Cognito Identity Pool
- C. Filter expression trong mọi Query
- D. Mã hoá userId bằng KMS

### Đáp án & giải thích

**Câu 1 — Đáp án B.** DAX cho microsecond latency, write-through, gần như không phải sửa code (chỉ đổi sang DAX client) và tối ưu cho read-heavy + eventually consistent. A (ElastiCache) phải tự viết logic cache-aside, nhiều code hơn. C strongly consistent read còn chậm hơn và không phải là cache. D tăng RCU giảm throttle nhưng không đạt micro-giây và tốn kém.

**Câu 2 — Đáp án B.** Global Tables dùng Streams (NEW_AND_OLD_IMAGES) làm cơ chế replication, đây là điều kiện bắt buộc. A PITR không liên quan replication. C Global Tables hỗ trợ cả on-demand lẫn provisioned — không bắt buộc provisioned. D TTL độc lập, không cần cho replication.

**Câu 3 — Đáp án C.** TTL xoá theo background process, có độ trễ (vài phút–48h); trong thời gian đó item vẫn nằm trong bảng và xuất hiện ở Query/Scan. Muốn loại ngay phải thêm filter expression `expireAt > :now`. A sai: TTL hoạt động ở mọi billing mode. B sai: attribute TTL phải là Number (epoch giây). D sai: TTL không phụ thuộc sort key.

**Câu 4 — Đáp án C.** TTL-delete không tốn WCU và sinh stream record REMOVE với `userIdentity.principalId = dynamodb.amazonaws.com` để app phân biệt. A sai (không tốn WCU). B sai (vẫn có stream record). D sai (có độ trễ, không đồng bộ).

**Câu 5 — Đáp án B.** Restore PITR (và cả restore từ backup) luôn tạo bảng MỚI; ứng dụng chuyển traffic sang bảng mới. A sai: không ghi đè bảng hiện tại được. C sai: PITR hỗ trợ chọn tới giây trong 35 ngày. D vòng vo, không cần.

**Câu 6 — Đáp án A.** Streams + Lambda là giải pháp managed cho change data capture, giữ ordering trong từng shard (theo partition key). B Scan định kỳ tốn RCU, không real-time, dễ miss thay đổi. C ghi kép dễ mất nhất quán nếu một bên fail. D CloudTrail data events ghi API call cho audit nhưng không tiện đẩy nội dung item theo thứ tự sang hệ phân tích.

**Câu 7 — Đáp án B.** DAX không phục vụ strongly consistent read từ cache; nó phải gọi DynamoDB lấy giá trị mới nhất nên không nhanh hơn. A sai: DAX hỗ trợ GetItem (item cache). C sai: DAX cache cả GetItem (item cache) lẫn Query (query cache). D sai: encryption không liên quan caching.

**Câu 8 — Đáp án B.** Export to S3 đọc từ backup PITR, không tốn RCU và không ảnh hưởng bảng — đúng cho dataset lớn. A và C đều dùng Scan, tiêu thụ RCU và ảnh hưởng production. D Streams chỉ bắt thay đổi mới (24h), không export toàn bộ snapshot hiện có.

**Câu 9 — Đáp án C.** Global Tables giải quyết xung đột bằng last-writer-wins dựa trên timestamp. A sai: Global Tables multi-active, không có "primary". B sai: không từ chối ghi. D sai: không giữ nhiều phiên bản chờ merge (đó là mô hình của AppSync conflict resolution, không phải Global Tables).

**Câu 10 — Đáp án B.** Fine-grained access dùng condition `dynamodb:LeadingKeys` để chỉ cho phép truy cập item có partition key khớp identity, cấp credentials tạm qua Cognito Identity Pool — đúng pattern và scale. A tạo IAM user cho mỗi end user không khả thi (giới hạn 5000 user/account, sai mô hình). C filter expression vẫn cho phép app gọi đọc toàn bảng, không phải kiểm soát IAM. D mã hoá không giới hạn quyền truy cập.

## Tóm tắt chương

- **DAX** là in-memory write-through cache đặt trước DynamoDB, cho microsecond latency với **eventually consistent reads**; gồm **item cache** (GetItem/BatchGetItem) và **query cache** (Query/Scan). Chạy trong VPC, dùng DAX client riêng.
- **Strongly consistent reads không được cache** bởi DAX — chúng đi xuyên qua tới DynamoDB. Đây là điểm đề thi hay gài.
- Chọn **DAX** khi đối tượng cache chính là DynamoDB và muốn ít code; chọn **ElastiCache** khi cần cấu trúc dữ liệu/aggregate phức tạp hoặc nhiều nguồn dữ liệu.
- **DynamoDB Streams** ghi lại thay đổi item theo thứ tự trong từng shard, retention **24 giờ**, 4 view types; tích hợp Lambda qua **event source mapping** cho audit, replication, materialized view.
- **TTL**: attribute kiểu **Number = epoch giây**; xoá **không tốn WCU** nhưng **có độ trễ** (vài phút–48h); item hết hạn vẫn có thể hiện trong Query cho tới khi bị xoá → cần filter expression. TTL-delete sinh stream record REMOVE với principal `dynamodb.amazonaws.com`.
- **Global Tables**: multi-region, multi-active; **bắt buộc bật Streams (NEW_AND_OLD_IMAGES)**; giải quyết xung đột bằng **last-writer-wins**.
- **PITR**: khôi phục tới bất kỳ giây nào trong **35 ngày**; restore luôn tạo **bảng mới**. **On-demand backup** giữ vô thời hạn tới khi xoá thủ công.
- **Export to S3** cần PITR, đọc từ backup nên **không tốn RCU**, không ảnh hưởng throughput; định dạng DYNAMODB_JSON hoặc ION — khác hẳn Scan.
- **IAM fine-grained access** với `dynamodb:LeadingKeys` và `dynamodb:Attributes` giới hạn user theo partition key và cột, thường kết hợp Cognito Identity Pool.
- **DynamoDB Local** dùng để dev/test offline qua endpoint `localhost:8000`, không phải production.
- Quyền IAM cho Lambda đọc stream phải đặt trên **stream ARN** (có hậu tố `/stream/<timestamp>`), không phải table ARN — sai chỗ này là lỗi cấu hình phổ biến.
- Stream + Lambda giữ thứ tự theo shard nhưng lỗi xử lý có thể block shard; dùng partial batch response, bisect on error và on-failure destination để xử lý an toàn (chi tiết ở Chương 30).
