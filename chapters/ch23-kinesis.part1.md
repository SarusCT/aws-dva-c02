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
