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
