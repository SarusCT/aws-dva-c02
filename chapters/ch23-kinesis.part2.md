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
