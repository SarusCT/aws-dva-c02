# Chương 23: Amazon Kinesis

> **Trọng tâm DVA-C02:** Kinesis là mỏ câu hỏi trong domain Development và Troubleshooting. Đề hay hỏi: chọn **partition key** để phân tán đều tránh **hot shard**; xử lý lỗi `ProvisionedThroughputExceededException` ở producer; phân biệt **Kinesis Data Streams** (real-time, retention, bạn tự quản consumer/checkpoint) với **Kinesis Data Firehose** (near real-time, fully managed, không có consumer code, không tái xử lý); khi nào dùng **enhanced fan-out** thay vì shared throughput; và đặc biệt là bảng quyết định **SQS vs SNS vs Kinesis** + so sánh ordering Kinesis (theo partition key) với SQS FIFO (theo message group ID). Đây là dạng câu "near real-time", "ordered", "multiple consumers replay data".

## Mục tiêu chương
- Hiểu kiến trúc **Kinesis Data Streams (KDS)**: shard, partition key, sequence number, retention, capacity modes (provisioned vs on-demand), resharding.
- Nhận diện và xử lý **hot shard** và lỗi `ProvisionedThroughputExceededException` từ phía producer.
- Phân biệt các loại **producer** (SDK, KPL, Kinesis Agent) và **consumer** (SDK GetRecords, KCL + checkpoint DynamoDB, Lambda, enhanced fan-out).
- Dùng **Kinesis Data Firehose** để giao dữ liệu near real-time tới S3/Redshift/OpenSearch, kèm transform Lambda và buffering.
- Nhận diện **Managed Service for Apache Flink** cho phân tích streaming.
- Trả lời chính xác câu hỏi quyết định **SQS vs SNS vs Kinesis** và so sánh ordering với SQS FIFO.

---

## 23.1 Kinesis Data Streams — kiến trúc shard, record, partition key

Kinesis Data Streams (KDS) là một dịch vụ streaming dùng để **ingest** (thu nhận) khối lượng lớn dữ liệu theo thời gian thực: clickstream, log, IoT telemetry, metric, change data capture. Khác với SQS — nơi message bị xoá sau khi consumer xử lý — KDS lưu giữ dữ liệu trong một khoảng **retention** và cho phép **nhiều consumer độc lập** cùng đọc lại cùng một dòng dữ liệu, kể cả replay từ quá khứ.

Đơn vị throughput của stream là **shard**. Một stream gồm 1..N shard. Mỗi shard cho phép:

- **Ghi (ingest):** 1 MB/giây **hoặc** 1.000 record/giây (đụng cái nào trước thì giới hạn cái đó).
- **Đọc (shared throughput):** 2 MB/giây **và** tối đa 5 lệnh `GetRecords`/giây.

Throughput tổng của stream = số shard × giới hạn mỗi shard. Stream 4 shard ghi được tới 4 MB/s hoặc 4.000 record/s.

Mỗi đơn vị dữ liệu là một **record**, gồm:

- **Partition key** (string ≤ 256 byte): producer chọn. Kinesis băm MD5 partition key ra một giá trị 128-bit; giá trị này rơi vào **hash key range** của một shard cụ thể → quyết định record đi vào shard nào. Đây là cơ chế quyết định **ordering** và **phân tán tải**.
- **Sequence number:** Kinesis gán *sau khi* record được ghi (không phải do producer chọn). Trong cùng một shard, sequence number **tăng dần theo thời gian** → đảm bảo thứ tự đọc lại đúng thứ tự ghi.
- **Data blob:** payload nhị phân, tối đa **1 MB** mỗi record.

```javascript
// PutRecord vào Kinesis Data Streams — AWS SDK for JavaScript v3
import { KinesisClient, PutRecordCommand } from "@aws-sdk/client-kinesis";

const client = new KinesisClient({ region: "ap-southeast-1" });

await client.send(new PutRecordCommand({
  StreamName: "clickstream",
  // partition key quyết định shard; cùng userId -> cùng shard -> giữ thứ tự
  PartitionKey: "user-12345",
  Data: Buffer.from(JSON.stringify({ event: "click", ts: Date.now() })),
}));
```

> 💡 **Exam Tip:** Tất cả record có **cùng partition key** sẽ đi vào **cùng một shard** và được đảm bảo **thứ tự** (theo sequence number). Đây là cách Kinesis bảo đảm ordering — tương tự "message group ID" của SQS FIFO. Nếu đề nói "cần xử lý theo đúng thứ tự cho từng device/user", chọn partition key = device ID/user ID.

---

## 23.2 Retention, capacity modes & resharding

### Retention (thời gian lưu giữ)
Mặc định record được giữ **24 giờ**. Có thể tăng tối đa **365 ngày** (8.760 giờ). Trong khoảng retention, bất kỳ consumer nào cũng đọc lại được dữ liệu (replay) — điểm khác biệt cốt lõi so với SQS (message biến mất sau khi xử lý). Tăng retention quá 24 giờ phát sinh phí lưu trữ thêm.

### Capacity modes
KDS có hai chế độ capacity, chọn ở mức stream:

| Tiêu chí | Provisioned | On-Demand |
|---|---|---|
| Cách định throughput | Bạn tự khai báo **số shard** | AWS tự co giãn shard theo lưu lượng |
| Giới hạn mặc định | Tùy số shard bạn đặt | Bắt đầu 4 MB/s ghi (4 shard) hoặc 200 MB/s; tự scale tới **double** mức đỉnh quan sát 30 ngày qua |
| Cách tính tiền | Theo **shard-hour** + PUT payload unit | Theo **dung lượng dữ liệu** ghi/đọc (GB) + per-stream |
| Khi nào dùng | Tải dự đoán được, muốn tối ưu chi phí | Tải biến động mạnh, không muốn quản lý shard |
| Rủi ro throttle | Cao nếu under-provision | Thấp (auto-scale), nhưng scale có độ trễ |

> 💡 **Exam Tip:** Đề mô tả "lưu lượng không dự đoán được, không muốn quản lý capacity / least operational overhead" → chọn **On-Demand**. Đề nói "tải ổn định, tối ưu chi phí" → **Provisioned**. On-Demand không loại bỏ hoàn toàn throttle: nếu lưu lượng tăng đột biến gấp đôi mức đỉnh 30 ngày trong thời gian ngắn, vẫn có thể bị giới hạn tạm thời.

### Resharding (provisioned mode)
Khi đổi throughput ở provisioned mode, bạn **resharding**:

- **Shard split:** tách 1 shard thành 2 → tăng throughput, dùng khi một shard bị **hot** (quá tải).
- **Shard merge:** gộp 2 shard kề nhau thành 1 → giảm throughput, tiết kiệm chi phí khi tải thấp.

Resharding là thao tác **từng cặp** (không scale 1→10 trong một lệnh). Shard cũ chuyển sang trạng thái **CLOSED**: không nhận record mới nhưng vẫn giữ dữ liệu tới hết retention, để consumer đọc nốt. Shard cũ gọi là **parent**, shard mới là **child**; consumer phải đọc hết parent trước khi đọc child để giữ đúng thứ tự (KCL xử lý tự động việc này).

```bash
# Tách shard để xử lý hot shard (provisioned mode)
aws kinesis split-shard \
  --stream-name clickstream \
  --shard-to-split shardId-000000000003 \
  --new-starting-hash-key 170141183460469231731687303715884105728

# Hoặc đơn giản hơn: tăng thẳng số shard mục tiêu
aws kinesis update-shard-count \
  --stream-name clickstream \
  --target-shard-count 8 \
  --scaling-type UNIFORM_SCALING
```

> 💡 **Exam Tip:** `UpdateShardCount` giúp scale nhanh nhưng có ràng buộc: không quá **2 lần** target hiện tại trong một lệnh và tối đa **10 lần** scale/ngày trên một stream. On-Demand tránh được toàn bộ phần resharding thủ công này.

---

## 23.3 Hot shard & phân tán partition key

**Hot shard** (còn gọi hot partition) xảy ra khi quá nhiều record dồn vào **một shard** vì partition key thiếu cardinality hoặc phân bố lệch. Hậu quả: shard đó chạm trần 1 MB/s — 1.000 record/s, producer ghi vào nó nhận `ProvisionedThroughputExceededException`, trong khi các shard khác nhàn rỗi. Tăng tổng số shard **không cứu được** nếu partition key vẫn dồn về cùng giá trị băm.

Ví dụ bẫy: dùng partition key = `country` cho ứng dụng mà 90% traffic từ một quốc gia → mọi record nước đó vào một shard.

Cách xử lý:
- Chọn partition key **cardinality cao** và phân bố đều: `userId`, `deviceId`, `sessionId` thay vì `country` hay một hằng số.
- Nếu *bắt buộc* gom theo một key thô (ví dụ theo `country` để giữ thứ tự nhóm), thêm **suffix ngẫu nhiên** để rải tải — đánh đổi mất thứ tự toàn cục (write sharding).
- Bật **Enhanced (shard-level) CloudWatch metrics** để soi `IncomingBytes`/`IncomingRecords` từng shard và phát hiện shard lệch.

> 💡 **Exam Tip:** Triệu chứng "một số record bị throttle dù tổng throughput stream còn dư" gần như luôn là **hot shard do partition key kém**. Đáp án đúng thường là "chọn partition key có cardinality cao hơn / phân tán đều hơn", **không phải** chỉ tăng số shard.

---

## 23.4 Producers — SDK, KPL, Kinesis Agent & xử lý throttling

### 1. SDK (PutRecord / PutRecords)
- `PutRecord`: ghi **một** record. Đơn giản, độ trễ thấp, kiểm soát từng record.
- `PutRecords`: ghi **theo batch** (tối đa **500 record** hoặc **5 MB** mỗi request). Hiệu quả hơn nhiều cho throughput cao.

Lưu ý quan trọng về `PutRecords`: đây là thao tác **không atomic theo từng record**. Toàn bộ request có thể HTTP 200 nhưng **một phần** record bên trong vẫn thất bại (ví dụ shard đích bị throttle). Bạn phải kiểm `FailedRecordCount` và **retry riêng** các record có `ErrorCode` (thường `ProvisionedThroughputExceededException`).

```javascript
import { KinesisClient, PutRecordsCommand } from "@aws-sdk/client-kinesis";
const client = new KinesisClient({ region: "ap-southeast-1" });

const res = await client.send(new PutRecordsCommand({
  StreamName: "clickstream",
  Records: events.map((e) => ({
    PartitionKey: e.userId,
    Data: Buffer.from(JSON.stringify(e)),
  })),
}));

// PutRecords KHÔNG atomic: phải gom record lỗi để retry với exponential backoff
if (res.FailedRecordCount > 0) {
  const failed = events.filter((_, i) => res.Records[i].ErrorCode);
  // ... đẩy `failed` vào hàng đợi retry, tăng backoff dần
}
```

### 2. KPL (Kinesis Producer Library)
Thư viện Java hiệu năng cao chạy như tiến trình nền (daemon), gọi từ nhiều ngôn ngữ. Tính năng nổi bật:
- **Batching + aggregation:** gộp nhiều "user record" nhỏ vào **một** Kinesis record (≤1 MB) để vượt giới hạn 1.000 record/s mỗi shard — vì giới hạn này tính theo **Kinesis record**, không phải user record. Phía consumer dùng **KCL** để tự **de-aggregate**.
- **Retry tự động**, gom metric vào CloudWatch.
- Đánh đổi: thêm **độ trễ** (do chờ gom batch — `RecordMaxBufferedTime`). Không phù hợp khi cần latency cực thấp.

### 3. Kinesis Agent
Agent Java cài trên server/EC2, **tail file log** và đẩy lên KDS hoặc Firehose tự động, không cần viết code — hữu ích cho log forwarding.

### Xử lý `ProvisionedThroughputExceededException`
Lỗi này nghĩa là producer vượt 1 MB/s hoặc 1.000 record/s của **shard đích**. Cách xử lý đúng:
1. **Retry với exponential backoff + jitter** (SDK v3 đã có sẵn retry, nhưng nên cấu hình thêm).
2. Nếu lỗi dai dẳng và phân bố trên nhiều shard → **tăng số shard** (hoặc dùng On-Demand).
3. Nếu chỉ một shard lỗi → đây là **hot shard**, sửa **partition key** (xem 23.3).

> 💡 **Exam Tip:** Phân biệt rõ: **KPL aggregation** giải quyết giới hạn **record/giây** (gom nhiều record nhỏ); **resharding/On-Demand** giải quyết giới hạn **MB/giây** tổng; **partition key tốt** giải quyết **hot shard**. Đề hay gài lẫn ba cách này.

---

## 23.5 Consumers — SDK, KCL & checkpointing, Lambda, Enhanced Fan-Out

Consumer đọc record theo shard. Có hai mô hình throughput đọc:

### Shared (classic) fan-out
Mọi consumer **dùng chung** 2 MB/s mỗi shard và share 5 `GetRecords`/s. Nếu có 3 consumer cùng đọc một shard, chúng chia nhau 2 MB/s → mỗi consumer ~0.66 MB/s, và độ trễ tăng. Đây là chế độ mặc định (pull qua `GetRecords`).

### Enhanced fan-out (EFO)
Mỗi consumer đăng ký được cấp **2 MB/s riêng cho mỗi shard** (không chia sẻ), và Kinesis **push** record tới consumer qua HTTP/2 (`SubscribeToShard`) → độ trễ ~70 ms thay vì ~200 ms của polling. Giới hạn: tối đa **20 consumer EFO** đăng ký mỗi stream. EFO tốn thêm phí (theo data + theo consumer-shard-hour).

| Tiêu chí | Shared fan-out | Enhanced fan-out |
|---|---|---|
| Throughput đọc | 2 MB/s **chia sẻ** toàn bộ consumer / shard | 2 MB/s **riêng** mỗi consumer / shard |
| Cơ chế | Pull (`GetRecords`, 5 lệnh/s) | Push (`SubscribeToShard`, HTTP/2) |
| Độ trễ điển hình | ~200 ms | ~70 ms |
| Số consumer | Nhiều (giới hạn bởi 5 GetRecords/s) | Tối đa **20** EFO/stream |
| Chi phí | Thấp hơn | Cao hơn |

> 💡 **Exam Tip:** Cần **nhiều consumer độc lập** cùng đọc một stream với **độ trễ thấp** mà không tranh throughput của nhau → **Enhanced Fan-Out**. Chỉ một consumer hoặc không cần latency thấp → **shared** rẻ hơn.

### KCL (Kinesis Client Library) & checkpointing
KCL là thư viện consumer chuẩn (Java, có wrapper đa ngôn ngữ MultiLangDaemon). Nó lo phần khó:
- **Một worker xử lý một shard** tại một thời điểm; nhiều instance ứng dụng tự **chia shard** cho nhau (load balancing).
- **Checkpointing:** KCL ghi vị trí đã xử lý (sequence number) vào một **bảng DynamoDB** (tên = tên ứng dụng KCL). Khi worker chết và khởi động lại, nó **resume** từ checkpoint thay vì đọc lại từ đầu.
- Tự xử lý resharding (parent→child), de-aggregation cho record do KPL gom.

Bẫy production: bảng DynamoDB của KCL được cấp **provisioned capacity**. Nếu under-provision (nhiều shard, checkpoint thường xuyên) → `ProvisionedThroughputExceededException` **trên bảng DynamoDB**, không phải trên stream. Triệu chứng: consumer chậm, log lỗi DynamoDB.

> 💡 **Exam Tip:** "Consumer dùng KCL bị lỗi throttle nhưng stream còn dư throughput" → kiểm tra **DynamoDB checkpoint table** thiếu capacity. Đây là câu Troubleshooting kinh điển.

### Kinesis với Lambda (event source mapping)
Lambda là consumer KDS phổ biến nhất vì không cần KCL/EC2. Lambda poll shard và gọi function theo batch. Các tham số quan trọng (cấu hình chi tiết ở **Chương 30**):
- **Batch size**, **batch window**, **starting position** (TRIM_HORIZON / LATEST / AT_TIMESTAMP).
- **Parallelization factor** (1–10): chạy song song nhiều batch *trên cùng một shard* nhưng **vẫn giữ thứ tự theo partition key**.
- **Bisect on error**, **on-failure destination**, retry: vì KDS đảm bảo ordering theo shard, một batch lỗi sẽ **chặn** shard đó cho tới khi xử lý xong hoặc record hết retention — nên cần bisect/DLQ để không kẹt vĩnh viễn.
- Lambda hỗ trợ đăng ký **enhanced fan-out** cho stream.

```bash
# Gắn Lambda làm consumer cho Kinesis stream (event source mapping)
aws lambda create-event-source-mapping \
  --function-name process-clicks \
  --event-source-arn arn:aws:kinesis:ap-southeast-1:111122223333:stream/clickstream \
  --starting-position LATEST \
  --batch-size 100 \
  --parallelization-factor 4
```

---

## 23.6 Kinesis Data Firehose — giao dữ liệu near real-time, fully managed

Kinesis Data Firehose (nay là **Amazon Data Firehose**) là dịch vụ **fully managed** để **load** dữ liệu streaming vào điểm đến lưu trữ/phân tích. Khác biệt cốt lõi với KDS: **bạn không viết consumer code, không quản lý shard, không có replay** — Firehose tự buffer rồi tự ghi vào đích.

**Destinations** được hỗ trợ:
- **Amazon S3** (phổ biến nhất, làm data lake).
- **Amazon Redshift** (qua S3 trung gian rồi COPY).
- **Amazon OpenSearch Service**.
- **HTTP endpoint** và đối tác bên thứ ba (Datadog, Splunk, New Relic, MongoDB...).

**Buffering:** Firehose gom dữ liệu theo **buffer size** (1–128 MB) và **buffer interval** (60–900 giây). Đụng ngưỡng nào trước thì flush. Đây là lý do Firehose là **near real-time** (độ trễ tối thiểu ~60 giây), không phải real-time như KDS.

**Transformation:** Firehose gọi **Lambda** để biến đổi từng batch trước khi ghi đích (ví dụ: chuẩn hoá JSON, làm giàu dữ liệu, chuyển sang Parquet/ORC qua format conversion tích hợp). Nếu Lambda lỗi/record không hợp lệ, Firehose ghi record lỗi vào prefix S3 backup riêng.

**Nguồn input của Firehose:** ghi trực tiếp qua `PutRecord`/`PutRecordBatch`, hoặc đặt một **KDS stream làm source** (KDS để xử lý real-time + Firehose để archive sang S3 — pattern phổ biến).

```bash
# Ghi trực tiếp vào Firehose delivery stream
aws firehose put-record \
  --delivery-stream-name logs-to-s3 \
  --record '{"Data":"eyJsZXZlbCI6ImVycm9yIn0="}'   # base64 của payload
```

| Tiêu chí | Kinesis Data Streams | Kinesis Data Firehose |
|---|---|---|
| Tính chất | Real-time (~200 ms, EFO ~70 ms) | Near real-time (tối thiểu ~60 s buffer) |
| Quản lý | Bạn quản shard/consumer/scaling | Fully managed, tự scale |
| Consumer code | Cần (SDK/KCL/Lambda) | Không — Firehose tự ghi đích |
| Lưu trữ / replay | Có retention 1–365 ngày, replay được | Không lưu, không replay |
| Đích đến | Bất kỳ (tự viết consumer) | S3/Redshift/OpenSearch/HTTP cố định |
| Transform | Tự làm trong consumer | Lambda transform tích hợp + format conversion |

> 💡 **Exam Tip:** "Near real-time", "load streaming data **into S3/Redshift/OpenSearch**", "no code / no servers to manage", "transform với Lambda trước khi ghi" → **Firehose**. "Real-time", "multiple consumers", "replay/reprocess", "custom processing" → **Data Streams**. Đây là cặp gài bẫy số 1 của chương.

---

## 23.7 Managed Service for Apache Flink (Kinesis Data Analytics)

**Amazon Managed Service for Apache Flink** (tên cũ: Kinesis Data Analytics) cho phép chạy **phân tích streaming** trên dữ liệu đang chảy mà không quản lý cụm: tính toán cửa sổ thời gian (windowing), aggregation, join giữa các stream, phát hiện bất thường — theo thời gian thực.

- Input: thường là **KDS** hoặc **Firehose**; cũng đọc được từ MSK (Kafka).
- Xử lý: bạn viết job Apache Flink (Java/Scala/Python) hoặc dùng Studio notebook (SQL/Flink).
- Output: ghi kết quả ra KDS, Firehose, Lambda, hoặc đích khác.

Use case điển hình: tính "số click trong 5 phút gần nhất theo từng sản phẩm", dashboard real-time, ETL streaming, làm giàu dữ liệu trước khi đổ vào kho.

> 💡 **Exam Tip:** Khi đề nói "real-time **analytics / aggregation / SQL** trên streaming data" → **Managed Service for Apache Flink**. Đừng nhầm với Firehose (chỉ *load/transform từng record*, không làm aggregation cửa sổ qua nhiều record).

---

## 23.8 Bảo mật, mã hoá & monitoring Kinesis

- **Mã hoá in transit:** mặc định qua HTTPS (TLS) tới endpoint Kinesis.
- **Mã hoá at rest:** bật **server-side encryption với AWS KMS** cho stream → record được mã hoá khi lưu trong shard. Cần cấp quyền KMS cho producer/consumer.
- **IAM:** kiểm soát truy cập ở mức stream và action (`kinesis:PutRecord`, `kinesis:GetRecords`, `kinesis:SubscribeToShard`...). Có thể giới hạn theo từng stream ARN.
- **VPC:** dùng **Interface VPC Endpoint (PrivateLink)** để producer/consumer trong VPC private gọi Kinesis không qua internet.
- **Monitoring:** CloudWatch metric cấp stream (`IncomingBytes`, `IncomingRecords`, `WriteProvisionedThroughputExceeded`, `ReadProvisionedThroughputExceeded`, `GetRecords.IteratorAgeMilliseconds`). **`IteratorAge`** là metric vàng để phát hiện consumer **tụt hậu**: iterator age tăng dần nghĩa là consumer đọc không kịp dữ liệu vào — nguy cơ mất dữ liệu khi vượt retention.

> 💡 **Exam Tip:** `GetRecords.IteratorAgeMilliseconds` tăng liên tục → consumer chậm hơn tốc độ ingest. Khắc phục: tăng song song (parallelization factor / thêm consumer / EFO), tối ưu code xử lý, hoặc tăng retention để có thời gian xử lý. Nếu iterator age chạm gần retention → **sắp mất dữ liệu**.

---

## 23.9 SQS vs SNS vs Kinesis — bảng quyết định & ordering

Đây là phần đề DVA-C02 hỏi nhiều nhất khi gom domain Messaging (Chương 21–23). (Chi tiết SQS ở **Chương 21**, SNS ở **Chương 22**.)

| Tiêu chí | SQS | SNS | Kinesis Data Streams |
|---|---|---|---|
| Mô hình | Queue (point-to-point) | Pub/Sub (fan-out tức thời) | Streaming (real-time, replay) |
| Consumer | 1 nhóm consumer, message bị **xoá** sau xử lý | Push tới nhiều subscriber, **không lưu** | **Nhiều** consumer độc lập, đọc lại được |
| Lưu giữ / replay | Tối đa 14 ngày, **không** replay sau khi xoá | Không lưu | 1–365 ngày, **replay** trong retention |
| Ordering | Standard: best-effort; **FIFO**: theo *message group ID* | Standard: không; **FIFO**: có | Theo **partition key** (trong shard) |
| Throughput | Standard: gần như vô hạn; FIFO: 300/3.000 msg/s | Cao | Theo số shard (1 MB/s mỗi shard) |
| Scaling | Tự động | Tự động | Provisioned shard / On-Demand |
| Use case điển hình | Decouple, buffer công việc, retry độc lập | Fan-out 1→N tức thời, thông báo | Phân tích real-time, log/clickstream/IoT, nhiều consumer |

**Ordering — Kinesis vs SQS FIFO:** cả hai đều đảm bảo thứ tự *theo nhóm*. Kinesis dùng **partition key** (cùng key → cùng shard → có thứ tự); SQS FIFO dùng **message group ID**. Khác biệt: Kinesis giữ dữ liệu cho **nhiều consumer replay**, trong khi SQS FIFO xoá message sau khi xử lý và phục vụ một consumer logic. SQS FIFO giới hạn 300 msg/s (3.000 với batch / high-throughput mode); Kinesis scale theo shard nên throughput thường lớn hơn nhiều cho streaming.

> 💡 **Exam Tip:** Từ khoá nhận diện nhanh:
> - "decouple / process once / retry độc lập / buffer" → **SQS**.
> - "fan-out tới nhiều endpoint cùng lúc / notification" → **SNS** (thường SNS → nhiều SQS).
> - "real-time analytics / clickstream / IoT / **multiple consumers** / **replay** / ordered theo key" → **Kinesis Data Streams**.
> - "near real-time load **into S3/Redshift/OpenSearch**, no code" → **Firehose**.

---

## Hands-on Lab: Kinesis Data Streams end-to-end — produce, consume, resharding và Firehose → S3

**Mục tiêu lab:** Dựng một pipeline Kinesis hoàn chỉnh bằng AWS CLI v2 + SDK JS v3 để nắm chắc những điểm DVA-C02 hay hỏi: tạo stream ở chế độ provisioned, đẩy record với `partition-key` và quan sát `sequence-number`/`shard-id`, consume bằng `GetShardIterator` + `GetRecords` (cơ chế bên dưới của KCL), gây và xử lý `ProvisionedThroughputExceededException`, **reshard** (split shard) để tăng throughput, gắn một **Lambda consumer** qua event source mapping, rồi dựng **Kinesis Data Firehose** ghi xuống S3 với buffering. Cuối cùng dọn sạch.

**Chuẩn bị:**
- AWS CLI v2 đã cấu hình profile có quyền `kinesis:*`, `firehose:*`, `s3:*`, `iam:*`, `lambda:*`, `logs:*`.
- Node.js 18+ và `npm i @aws-sdk/client-kinesis`.
- Region xuyên suốt: `ap-southeast-1`.

```bash
export AWS_REGION="ap-southeast-1"
export ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
export STREAM="dva-ch23-stream"
```

### Bước 1: Tạo Kinesis Data Stream (provisioned, 1 shard)

```bash
aws kinesis create-stream \
  --stream-name "$STREAM" \
  --shard-count 1 \
  --region "$AWS_REGION"

# create-stream là bất đồng bộ → đợi ACTIVE bằng waiter
aws kinesis wait stream-exists --stream-name "$STREAM"

aws kinesis describe-stream-summary --stream-name "$STREAM" \
  --query 'StreamDescriptionSummary.{Status:StreamStatus,Shards:OpenShardCount,Mode:StreamModeDetails.StreamMode}'
```

Output mong đợi:

```json
{ "Status": "ACTIVE", "Shards": 1, "Mode": "PROVISIONED" }
```

> Với 1 shard bạn có quota ghi **1 MB/s hoặc 1000 record/s** và đọc **2 MB/s** (shared). Nhớ con số này — đề hay hỏi "cần X MB/s thì bao nhiêu shard".

### Bước 2: Đẩy record và đọc sequence number

```bash
aws kinesis put-record \
  --stream-name "$STREAM" \
  --partition-key "user-42" \
  --data "$(echo -n '{"event":"click","page":"/home"}' | base64)" \
  --cli-binary-format raw-in-base64-out \
  --query '{Shard:ShardId,Seq:SequenceNumber}'
```

Output mong đợi (sequence-number là duy nhất, tăng dần trong shard):

```json
{ "Shard": "shardId-000000000000", "Seq": "49627...8530" }
```

> `partition-key` được Kinesis **MD5-hash** ra 128-bit để chọn shard. Cùng partition key → luôn cùng shard → đảm bảo ordering cho key đó. Đây là khác biệt cốt lõi so với SQS Standard (không ordering).

### Bước 3: Consume thủ công bằng shard iterator (hiểu cơ chế KCL)

```bash
SHARD_ITER=$(aws kinesis get-shard-iterator \
  --stream-name "$STREAM" \
  --shard-id shardId-000000000000 \
  --shard-iterator-type TRIM_HORIZON \
  --query 'ShardIterator' --output text)

aws kinesis get-records --shard-iterator "$SHARD_ITER" \
  --query 'Records[].{Seq:SequenceNumber,Key:PartitionKey,Data:Data}'
```

`get-records` trả về record (Data đã base64) **và** `NextShardIterator` — bạn phải dùng iterator mới cho lần poll kế tiếp. Đây chính xác là vòng lặp mà **KCL** tự động hoá: KCL gọi `GetRecords` liên tục, lưu **checkpoint** (sequence number đã xử lý) vào một **DynamoDB table** để biết đọc tiếp từ đâu sau khi restart, và phối hợp nhiều worker qua lease.

> 💡 `TRIM_HORIZON` = từ record cũ nhất còn trong stream; `LATEST` = chỉ record mới sau thời điểm này; `AT_SEQUENCE_NUMBER`/`AFTER_SEQUENCE_NUMBER` = resume từ checkpoint.

### Bước 4: Gây ProvisionedThroughputExceededException và batch ghi

Đẩy nhiều record nhanh vào 1 shard để thấy throttling, đồng thời dùng `PutRecords` (batch tối đa **500 record / 5 MB**) đúng cách. File `producer.mjs`:

```javascript
import { KinesisClient, PutRecordsCommand } from "@aws-sdk/client-kinesis";
const client = new KinesisClient({ region: process.env.AWS_REGION });

const records = Array.from({ length: 500 }, (_, i) => ({
  PartitionKey: `user-${i % 10}`,          // 10 key → phân bố
  Data: Buffer.from(JSON.stringify({ n: i, ts: Date.now() })),
}));

const res = await client.send(new PutRecordsCommand({
  StreamName: process.env.STREAM, Records: records,
}));

// PutRecords KHÔNG fail toàn batch khi vài record bị throttle —
// phải tự kiểm FailedRecordCount và retry các record lỗi
console.log("Failed:", res.FailedRecordCount);
res.Records.forEach((r, i) => {
  if (r.ErrorCode) console.log(i, r.ErrorCode, r.ErrorMessage);
});
```

```bash
STREAM="$STREAM" node producer.mjs
```

> 💡 **Bẫy kinh điển:** `PutRecords` trả về HTTP 200 ngay cả khi một phần record bị `ProvisionedThroughputExceededException`. Bạn BẮT BUỘC đọc `FailedRecordCount` và retry riêng các record lỗi (với exponential backoff) — nếu không sẽ mất dữ liệu âm thầm.

### Bước 5: Resharding — split shard để tăng throughput

Khi 1 shard không đủ (hoặc bị **hot shard** do partition key lệch), bạn split. Cần `StartingHashKey` giữa của shard cần tách:

```bash
MID=$(aws kinesis describe-stream --stream-name "$STREAM" \
  --query 'StreamDescription.Shards[0].HashKeyRange.EndingHashKey' --output text)
MID=$(python3 -c "print(int('$MID')//2)")

aws kinesis split-shard \
  --stream-name "$STREAM" \
  --shard-to-split shardId-000000000000 \
  --new-starting-hash-key "$MID"

aws kinesis wait stream-exists --stream-name "$STREAM"
aws kinesis describe-stream-summary --stream-name "$STREAM" \
  --query 'StreamDescriptionSummary.OpenShardCount'
```

Output: `2`. Shard gốc chuyển trạng thái `CLOSED` (vẫn đọc được cho tới hết retention) và sinh 2 child shard mới mở. Throughput ghi giờ là 2 MB/s. Ngược lại có `merge-shards` để giảm chi phí khi lưu lượng thấp.

> 💡 Ở chế độ **on-demand**, Kinesis tự reshard theo lưu lượng (đến 2x peak 30 ngày qua) — bạn không phải split/merge. Provisioned thì bạn tự lo. Đây là điểm phân biệt then chốt khi câu hỏi nói "lưu lượng không đoán trước / spiky".

### Bước 6: Lambda consumer qua event source mapping (tùy chọn nhanh)

```bash
# (đã có role lambda-kinesis-role với AWSLambdaKinesisExecutionRole)
aws lambda create-event-source-mapping \
  --function-name dva-ch23-consumer \
  --event-source-arn "arn:aws:kinesis:${AWS_REGION}:${ACCOUNT_ID}:stream/${STREAM}" \
  --starting-position TRIM_HORIZON \
  --batch-size 100 \
  --maximum-batching-window-in-seconds 5
```

Lambda poll Kinesis với **1 invocation đồng thời / shard** (trừ khi tăng `ParallelizationFactor` lên tới 10). Record trong cùng shard được xử lý **tuần tự, theo thứ tự**. Lỗi xử lý sẽ retry cả batch → cấu hình chi tiết (bisect on error, on-failure destination) thuộc Chương 30.

### Bước 7: Kinesis Data Firehose → S3 với buffering

Firehose là **fully managed, near real-time** (tối thiểu ~60s buffer), không có shard, tự scale, ghi thẳng xuống đích.

```bash
aws s3 mb "s3://dva-ch23-firehose-${ACCOUNT_ID}"

aws firehose create-delivery-stream \
  --delivery-stream-name dva-ch23-fh \
  --delivery-stream-type DirectPut \
  --s3-destination-configuration \
    "RoleARN=arn:aws:iam::${ACCOUNT_ID}:role/firehose-s3-role,\
BucketARN=arn:aws:s3:::dva-ch23-firehose-${ACCOUNT_ID},\
BufferingHints={SizeInMBs=5,IntervalInSeconds=60}"
```

```bash
aws firehose put-record --delivery-stream-name dva-ch23-fh \
  --record '{"Data":"aGVsbG8gZmlyZWhvc2UK"}'
```

Sau ~60s (hoặc khi đủ 5 MB), file xuất hiện trong S3 dưới prefix `YYYY/MM/DD/HH/`. Firehose **buffer theo size HOẶC time** (đến trước thì flush). Bạn có thể gắn Lambda để transform record trước khi ghi, và đổi đích sang Redshift / OpenSearch / Splunk / HTTP endpoint — nhưng Firehose **không lưu trữ/replay** dữ liệu như Data Streams.

### Dọn dẹp tài nguyên

```bash
# Xoá event source mapping trước (lấy UUID)
UUID=$(aws lambda list-event-source-mappings --function-name dva-ch23-consumer \
  --query 'EventSourceMappings[0].UUID' --output text 2>/dev/null)
[ "$UUID" != "None" ] && aws lambda delete-event-source-mapping --uuid "$UUID"

aws firehose delete-delivery-stream --delivery-stream-name dva-ch23-fh
aws kinesis delete-stream --stream-name "$STREAM" --enforce-consumer-deletion
aws s3 rb "s3://dva-ch23-firehose-${ACCOUNT_ID}" --force
# Xoá role/lambda nếu lab tạo riêng
```

> Provisioned stream tính tiền **theo giờ / shard** kể cả không có traffic, cộng phí PUT payload unit. On-demand tính theo data + retrieval. Đừng để stream chạy quên — đây là dịch vụ tốn tiền âm thầm.

## 💡 Exam Tips chương 23

- **1 shard = ghi 1 MB/s hoặc 1000 record/s; đọc 2 MB/s (shared)**. Câu hỏi "cần ghi 5 MB/s" → tối thiểu 5 shard. Đọc bằng nhiều consumer chia nhau 2 MB/s đó, trừ khi dùng enhanced fan-out.
- **Enhanced fan-out (EFO)** cho mỗi consumer **2 MB/s/shard RIÊNG** (push qua `SubscribeToShard`, độ trễ ~70ms) thay vì chia sẻ. Chọn EFO khi có **nhiều consumer** cùng đọc 1 stream và cần throughput/latency cao.
- **Ordering:** Kinesis đảm bảo thứ tự **trong một shard** theo partition key. Cần ordering toàn cục theo một khoá → đưa các record cùng khoá vào cùng partition key. So sánh: SQS FIFO đảm bảo ordering theo Message Group ID (chi tiết Chương 21).
- **Provisioned vs On-demand:** provisioned = bạn tự chọn shard, rẻ hơn khi tải ổn định & dự đoán được; on-demand = tự scale theo lưu lượng (đến 2x peak 30 ngày), chọn khi tải spiky/khó đoán, không muốn quản shard.
- **ProvisionedThroughputExceededException** → hot shard hoặc vượt quota. Cách xử lý: retry với exponential backoff, **split shard**, hoặc chọn partition key có cardinality cao hơn để phân bố đều.
- **`PutRecords` trả 200 dù có record lỗi** → phải check `FailedRecordCount` và retry record lỗi. **KPL** (Kinesis Producer Library) tự gom batch + retry + aggregation, tăng throughput nhưng cần **KCL để de-aggregate**.
- **KCL checkpoint vào DynamoDB**: 1 lease table/ứng dụng, mỗi shard 1 lease. Nếu thiếu quyền DynamoDB hoặc table bị throttle → consumer kẹt. Mỗi shard chỉ 1 KCL worker xử lý tại một thời điểm.
- **Retention** mặc định **24 giờ**, tăng được tới **365 ngày**. Đây là điểm khác biệt lớn so với SQS (message xoá sau khi consume, max retention 14 ngày) — Kinesis cho **replay** nhiều consumer độc lập.
- **Firehose = near real-time (buffer tối thiểu ~60s / 1 MB), fully managed, không shard, không replay**. Đích: S3, Redshift, OpenSearch, Splunk, HTTP. Cần real-time thật + replay → Data Streams. Cần đổ thẳng vào datastore với ít vận hành → Firehose.
- **Firehose transform** bằng Lambda; có thể convert format sang Parquet/ORC, nén GZIP. Record lỗi transform đi vào S3 prefix lỗi, không chặn luồng.
- **Managed Service for Apache Flink** (trước là Kinesis Data Analytics) để xử lý/aggregate streaming bằng SQL/Java — nhận diện khi câu hỏi nói "phân tích/aggregate real-time trên stream".
- **SQS vs SNS vs Kinesis:** queue 1-1 decouple + xoá sau consume → SQS; pub/sub fan-out tới nhiều endpoint không cần replay → SNS; **streaming, nhiều consumer, ordering theo key, replay, analytics** → Kinesis.

## Quiz chương 23 (10 câu)

**Câu 1.** Một ứng dụng IoT cần ghi 8 MB/s vào Kinesis Data Streams ở chế độ provisioned. Số shard tối thiểu cần cấu hình là bao nhiêu?
- A. 4
- B. 8
- C. 16
- D. 2

**Câu 2.** Một developer dùng `PutRecords` để đẩy 500 record. API trả về HTTP 200 nhưng một số record không xuất hiện ở consumer. Nguyên nhân khả dĩ nhất và cách xử lý?
- A. Kinesis mất dữ liệu, phải bật versioning trên stream
- B. Một số record bị `ProvisionedThroughputExceededException`; phải kiểm `FailedRecordCount` và retry record lỗi
- C. Consumer dùng sai shard iterator; chuyển sang LATEST
- D. Cần bật server-side encryption mới ghi được

**Câu 3.** Hệ thống có 5 microservice cần đọc CÙNG một Kinesis stream với độ trễ thấp, mỗi service cần throughput cao mà không ảnh hưởng nhau. Giải pháp tốt nhất?
- A. Tạo 5 stream giống nhau và ghi song song
- B. Dùng shared throughput consumer cho cả 5 service
- C. Đăng ký mỗi service làm một **enhanced fan-out** consumer
- D. Chuyển sang SQS với 5 queue

**Câu 4.** Yêu cầu: đổ log gần real-time vào Amazon S3 dưới dạng Parquet, ít vận hành nhất, không cần replay. Dịch vụ nào?
- A. Kinesis Data Streams + KCL consumer tự ghi S3
- B. Kinesis Data Firehose với format conversion
- C. SQS + Lambda ghi S3
- D. SNS fan-out tới Lambda

**Câu 5.** Một stream provisioned 1 shard bị `ProvisionedThroughputExceededException` liên tục trên một shard dù tổng lưu lượng thấp. Nguyên nhân?
- A. Retention quá ngắn
- B. **Hot shard** do partition key có cardinality thấp dồn vào 1 shard
- C. Consumer đọc bằng TRIM_HORIZON
- D. Thiếu enhanced fan-out

**Câu 6.** Đặc điểm nào KHÁC nhau giữa Kinesis Data Streams và SQS?
- A. Cả hai đều cho replay record nhiều lần
- B. Kinesis giữ record theo retention và cho nhiều consumer replay; SQS xoá message sau khi consume
- C. SQS đảm bảo ordering toàn cục, Kinesis thì không
- D. Kinesis có message size 256KB như SQS

**Câu 7.** Lambda được gắn vào Kinesis stream có 4 shard qua event source mapping (ParallelizationFactor = 1). Có tối đa bao nhiêu invocation Lambda đồng thời xử lý stream này?
- A. 1
- B. 4
- C. 40
- D. Không giới hạn

**Câu 8.** Một developer cần đảm bảo tất cả event của cùng một `orderId` được xử lý đúng thứ tự trong Kinesis. Cách làm đúng?
- A. Dùng `orderId` làm **partition key** khi put record
- B. Tăng số shard
- C. Bật enhanced fan-out
- D. Dùng `LATEST` shard iterator

**Câu 9.** Lưu lượng vào stream rất khó đoán, lúc cao điểm gấp 20 lần bình thường, team không muốn quản lý shard. Lựa chọn?
- A. Provisioned với số shard bằng peak
- B. **On-demand capacity mode**
- C. Firehose DirectPut
- D. Provisioned + bật autoscaling thủ công qua CloudWatch alarm

**Câu 10.** KCL lưu thông tin checkpoint (record đã xử lý đến đâu) ở đâu?
- A. Trong chính Kinesis stream
- B. Trong một **DynamoDB table** do KCL quản lý
- C. Trong S3
- D. Trong CloudWatch Logs

### Đáp án & giải thích

**Câu 1 — Đáp án B (8).** Mỗi shard ghi tối đa 1 MB/s, nên 8 MB/s cần tối thiểu 8 shard. A (4) và D (2) không đủ băng thông ghi → sẽ throttle. C (16) đủ nhưng dư gấp đôi, lãng phí tiền vì provisioned tính theo shard-giờ; câu hỏi yêu cầu "tối thiểu".

**Câu 2 — Đáp án B.** `PutRecords` xử lý từng record độc lập và trả 200 cho cả batch ngay cả khi vài record bị throttle; field `FailedRecordCount` và `ErrorCode` từng record cho biết cái nào lỗi để retry. A sai: Kinesis không có "versioning". C sai: shard iterator chỉ liên quan consumer, không gây mất record ghi. D sai: encryption không liên quan tới việc record bị drop.

**Câu 3 — Đáp án C.** Enhanced fan-out cấp riêng 2 MB/s/shard cho mỗi consumer qua push (SubscribeToShard), latency ~70ms, các consumer không tranh chấp băng thông đọc shared 2 MB/s. A tốn kém và phải ghi nhiều lần, mất tính single-source. B khiến 5 service chia nhau 2 MB/s → nghẽn. D mất khả năng nhiều consumer replay cùng dữ liệu và không phải streaming.

**Câu 4 — Đáp án B.** Firehose là near real-time, fully managed, hỗ trợ format conversion sang Parquet/ORC và ghi thẳng S3, ít vận hành nhất. A đúng kỹ thuật nhưng phải tự viết/vận hành KCL + ghi S3 → nhiều vận hành. C dùng được nhưng phải tự code Lambda + buffering + Parquet. D SNS không buffer/ghi file xuống S3 trực tiếp dạng batch.

**Câu 5 — Đáp án B.** Throttle dồn vào một shard trong khi tổng lưu lượng thấp là dấu hiệu hot shard: partition key cardinality thấp khiến mọi record hash vào cùng shard. Khắc phục: chọn partition key phân tán đều hoặc split shard. A retention không liên quan ghi. C TRIM_HORIZON là chuyện consumer. D EFO cải thiện đọc, không phải ghi.

**Câu 6 — Đáp án B.** Kinesis giữ record theo retention (24h–365 ngày), cho nhiều consumer độc lập đọc/replay; SQS xoá message sau khi consumer xử lý xong (delete). A sai: SQS không replay. C sai: SQS Standard không ordering toàn cục, chỉ FIFO mới ordering theo group; Kinesis có ordering theo shard. D sai: Kinesis record tối đa 1 MB, không phải 256KB.

**Câu 7 — Đáp án B (4).** Event source mapping mặc định cho 1 invocation đồng thời/shard, nên 4 shard → tối đa 4 invocation song song. Tăng ParallelizationFactor (đến 10) mới lên 40 (đáp án C, nhưng đề nói factor = 1). A chỉ đúng nếu 1 shard. D sai vì Kinesis bị giới hạn theo shard chứ không vô hạn.

**Câu 8 — Đáp án A.** Cùng partition key → cùng shard → ordering được đảm bảo trong shard đó. Dùng `orderId` làm partition key gom mọi event của order vào một shard tuần tự. B tăng shard làm phân tán key, không giúp ordering. C EFO là chuyện throughput đọc. D shard iterator type không quyết định ordering ghi.

**Câu 9 — Đáp án B.** On-demand tự scale theo lưu lượng (tới 2x peak 30 ngày qua), không phải quản shard, lý tưởng cho tải spiky/khó đoán. A cố định theo peak rất lãng phí lúc thấp tải. C Firehose không phải lựa chọn nếu cần đặc tính stream (nhiều consumer/replay) và câu hỏi nói về Data Streams. D autoscaling shard provisioned phức tạp và chậm, đúng thứ on-demand sinh ra để thay thế.

**Câu 10 — Đáp án B.** KCL tạo và dùng một DynamoDB table để lưu lease + checkpoint (sequence number đã xử lý) của từng shard, giúp resume sau restart và điều phối worker. A sai: stream không lưu trạng thái consumer. C/D sai: KCL không dùng S3 hay CloudWatch Logs cho checkpoint (CloudWatch chỉ nhận metric).

## Tóm tắt chương

- **Kinesis Data Streams** là nền tảng streaming theo shard: 1 shard ghi 1 MB/s hoặc 1000 record/s, đọc 2 MB/s shared; record tối đa 1 MB; retention 24h (tới 365 ngày) cho phép replay.
- **Partition key** được MD5-hash để chọn shard; cùng key → cùng shard → ordering trong shard. Key lệch gây **hot shard** và `ProvisionedThroughputExceededException`.
- **Provisioned** = tự quản shard, rẻ khi tải ổn định; **On-demand** = tự scale tới 2x peak 30 ngày, hợp tải spiky, không quản shard.
- **Resharding**: `split-shard` để tăng throughput / chữa hot shard, `merge-shards` để giảm chi phí; shard cha thành CLOSED, sinh child shard mới.
- **Producers**: SDK `PutRecord`/`PutRecords` (batch 500/5 MB, phải check `FailedRecordCount`), KPL (batch + aggregation + retry, cần KCL de-aggregate), Kinesis Agent.
- **Consumers**: SDK (`GetShardIterator`+`GetRecords`), KCL (checkpoint vào **DynamoDB**, 1 worker/shard), Lambda event source mapping (1 invocation/shard, tăng bằng ParallelizationFactor tới 10), enhanced fan-out (2 MB/s/shard riêng, push, ~70ms).
- **Enhanced fan-out** giải bài toán nhiều consumer cần throughput cao mà không tranh chấp băng thông đọc shared.
- **Kinesis Data Firehose**: near real-time (buffer theo size HOẶC time, tối thiểu ~60s/1 MB), fully managed, không shard, ghi thẳng S3/Redshift/OpenSearch/Splunk/HTTP; transform & format conversion bằng Lambda; **không lưu trữ/replay**.
- **Managed Service for Apache Flink** xử lý/aggregate streaming bằng SQL/Java cho phân tích real-time trên stream.
- **Data Streams vs Firehose**: cần real-time thật + nhiều consumer + replay → Streams; cần đổ thẳng vào datastore với ít vận hành → Firehose.
- **Kinesis vs SQS vs SNS**: queue decouple + xoá sau consume → SQS; pub/sub fan-out → SNS; streaming + nhiều consumer + ordering theo key + replay + analytics → Kinesis.
- Luôn dọn `delete-stream`, `delete-delivery-stream` và bucket S3: provisioned stream tính tiền theo shard-giờ kể cả khi không có traffic.
