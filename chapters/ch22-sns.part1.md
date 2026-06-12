# Chương 22: Amazon SNS

> **Trọng tâm DVA-C02:** SNS xuất hiện trong domain Development và Deployment dưới dạng câu hỏi kiến trúc event-driven: chọn SNS hay SQS hay EventBridge, thiết kế fan-out SNS→SQS (kèm access policy đúng), lọc message bằng filter policy để giảm Lambda invocation thừa, dùng FIFO topic để giữ thứ tự, và xử lý delivery failure bằng DLQ. Đề rất hay gài bẫy "một message phải tới nhiều consumer độc lập" (→ SNS fan-out) so với "một message chỉ một consumer xử lý" (→ SQS).

## Mục tiêu chương
- Hiểu mô hình pub/sub của SNS: topic, subscription, các protocol đầu cuối và sự khác biệt với mô hình queue của SQS.
- Triển khai fan-out pattern SNS→SQS đúng chuẩn production: vì sao cần fan-out, cấu hình access policy cho phép SNS gửi vào queue.
- Cấu hình message filtering bằng filter policy (theo attribute và theo message body) để mỗi subscriber chỉ nhận message liên quan.
- Phân biệt Standard topic và FIFO topic, ghép SNS FIFO + SQS FIFO để giữ ordering và exactly-once.
- Cấu hình delivery retry, DLQ cho subscription, raw message delivery, và encryption.
- Quyết định nhanh giữa SNS, SQS, và EventBridge cho từng tình huống đề thi.

## 22.1 Mô hình pub/sub: topic, subscription, publisher, subscriber

SNS (Simple Notification Service) là dịch vụ messaging theo mô hình **pub/sub** (publish/subscribe). Khác biệt cốt lõi so với SQS (Chương 21): SQS là **queue** — message nằm chờ trong hàng đợi cho tới khi *một* consumer kéo (pull) ra và xử lý; còn SNS là **push** — publisher gửi một message vào **topic**, SNS **đẩy** ngay (push) một bản sao của message tới **mọi** subscriber đang đăng ký topic đó. Đây là cơ chế **fan-out**: một message vào, N bản sao ra cho N subscriber.

Bốn thành phần:

- **Topic**: điểm truy cập logic, là "kênh" giao tiếp. Publisher chỉ biết topic, không biết có bao nhiêu subscriber. Mỗi topic có một ARN dạng `arn:aws:sns:us-east-1:123456789012:my-topic`.
- **Publisher** (producer): gửi message tới topic qua API `Publish`. Có thể là ứng dụng của bạn, hoặc một AWS service (S3 event, CloudWatch Alarm, CodePipeline...).
- **Subscription**: liên kết giữa topic và một endpoint cụ thể, kèm một **protocol**. Một subscription phải được **confirm** trước khi nhận message (trừ các protocol nội bộ AWS như SQS/Lambda được auto-confirm khi bạn có quyền).
- **Subscriber** (consumer): endpoint nhận message — SQS queue, Lambda function, HTTP/HTTPS endpoint, email, SMS...

Điểm mấu chốt về **decoupling**: publisher và subscriber hoàn toàn không biết nhau. Bạn thêm/bớt subscriber mà không sửa code publisher. Đây là lý do SNS là xương sống của kiến trúc event-driven.

```javascript
// AWS SDK for JavaScript v3 — tạo topic và publish
import {
  SNSClient,
  CreateTopicCommand,
  PublishCommand,
} from "@aws-sdk/client-sns";

const sns = new SNSClient({ region: "us-east-1" });

// Tạo topic (idempotent: gọi lại với cùng tên trả về ARN cũ)
const { TopicArn } = await sns.send(
  new CreateTopicCommand({ Name: "order-events" })
);

// Publish một message
await sns.send(
  new PublishCommand({
    TopicArn,
    Subject: "New order", // chỉ dùng cho email protocol
    Message: JSON.stringify({ orderId: "A-1001", amount: 250 }),
  })
);
```

> 💡 **Exam Tip:** Từ khoá quyết định: nếu đề nói "**a single message must be delivered to multiple consumers**" / "fan-out" / "send notification to several systems at once" → SNS. Nếu "one consumer processes each message" / "decouple producer from a single worker" → SQS. Nếu "**multiple subscribers, each with independent retry and processing**" → SNS→SQS fan-out (xem 22.3).

## 22.2 Protocols & subscriptions

Một subscription gắn topic với một endpoint qua một protocol. Các protocol SNS hỗ trợ:

| Protocol | Endpoint | Confirm? | Ghi chú |
|---|---|---|---|
| `sqs` | ARN của SQS queue | Auto (nếu có quyền) | Phổ biến nhất cho fan-out |
| `lambda` | ARN của Lambda function | Auto | SNS tự thêm permission được nếu dùng console |
| `http` / `https` | URL | Có (SubscriptionConfirmation) | Endpoint phải trả lời confirm token |
| `email` / `email-json` | địa chỉ email | Có (click link) | `email` gửi text; `email-json` gửi JSON |
| `sms` | số điện thoại | Không | Gửi SMS, không tạo subscription cố định khi publish trực tiếp số |
| `application` | endpoint của mobile push | — | APNS, FCM/GCM, ADM (mobile push notification) |
| `firehose` | ARN của Kinesis Data Firehose delivery stream | Auto | Archive message vào S3/Redshift/OpenSearch |

Luồng **confirm** cho HTTP/HTTPS và email là điểm hay quên: khi `Subscribe` được gọi, subscription ở trạng thái **`PendingConfirmation`**. SNS gửi tới endpoint một message loại `SubscriptionConfirmation` chứa `Token`. Endpoint phải gọi `ConfirmSubscription` với token đó (hoặc với email là click link xác nhận). Trước khi confirm, subscription **không** nhận message thường.

```bash
# AWS CLI v2 — đăng ký một SQS queue vào topic
aws sns subscribe \
  --topic-arn arn:aws:sns:us-east-1:123456789012:order-events \
  --protocol sqs \
  --notification-endpoint arn:aws:sqs:us-east-1:123456789012:order-queue

# Đăng ký email (sẽ ở trạng thái PendingConfirmation cho tới khi click link)
aws sns subscribe \
  --topic-arn arn:aws:sns:us-east-1:123456789012:order-events \
  --protocol email \
  --notification-endpoint ops@example.com
```

Giới hạn cần nhớ: mỗi topic chịu được tới **12,500,000 subscription** (Standard), và một account mặc định tạo được tới **100,000 topic**. Message size tối đa khi publish là **256 KB** (giống SQS), tính cả message attributes; SNS không có Extended Client Library chính thức như SQS nên với payload lớn, pattern là gửi con trỏ S3 trong message.

> 💡 **Exam Tip:** Nếu một HTTP subscriber "không nhận được message", checklist đầu tiên: subscription đã được **confirm** chưa (trạng thái `PendingConfirmation`)? Endpoint có xử lý đúng message type `SubscriptionConfirmation` và gọi `ConfirmSubscription` không?

## 22.3 Fan-out pattern: SNS → SQS

Đây là pattern *kinh điển nhất* của SNS trong đề DVA-C02. Ý tưởng: publisher gửi một message vào SNS topic; topic có nhiều SQS queue subscribe; mỗi queue nhận một bản sao và được một consumer (microservice) độc lập xử lý.

**Vì sao fan-out qua SQS thay vì subscribe trực tiếp Lambda/HTTP vào SNS?**

1. **Đảm bảo không mất message (durability/buffering)**: SQS lưu message bền vững. Nếu consumer (ví dụ Lambda hay một fleet EC2) đang chết hoặc bị quá tải, message vẫn nằm trong queue chờ. Nếu subscribe HTTP trực tiếp vào SNS mà endpoint down, SNS chỉ retry theo policy rồi bỏ (hoặc đẩy DLQ) — dễ mất.
2. **Decouple tốc độ**: SQS hấp thụ burst. Consumer xử lý theo nhịp của nó (pull), không bị SNS dội (push) gây throttle.
3. **Retry/visibility độc lập**: mỗi queue có visibility timeout, DLQ, redrive riêng. Một service hỏng không ảnh hưởng service khác.
4. **Replay/inspect**: message còn trong queue, có thể xem, đếm `ApproximateNumberOfMessages`.

**Cấu hình bắt buộc — access policy trên SQS queue**: SNS là một service ngoài, nó cần quyền `sqs:SendMessage` vào queue của bạn. Bạn phải gắn **resource-based policy** (queue policy) cho phép principal `sns.amazonaws.com` gửi, và giới hạn bằng condition `aws:SourceArn` = ARN của topic để tránh "confused deputy" (topic lạ gửi vào queue bạn).

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowSNSToSendToQueue",
      "Effect": "Allow",
      "Principal": { "Service": "sns.amazonaws.com" },
      "Action": "sqs:SendMessage",
      "Resource": "arn:aws:sqs:us-east-1:123456789012:order-queue",
      "Condition": {
        "ArnEquals": {
          "aws:SourceArn": "arn:aws:sns:us-east-1:123456789012:order-events"
        }
      }
    }
  ]
}
```

Thiếu policy này là lỗi #1 khi dựng fan-out thủ công: subscription tạo OK nhưng message **âm thầm không vào queue** (SNS không có quyền send, drop). Khi dùng console hoặc CDK `topic.addSubscription(new SqsSubscription(queue))`, policy được tự thêm; nhưng khi dựng bằng CLI/CloudFormation thủ công thì phải tự viết.

```bash
# Gắn policy vào queue bằng CLI (cần escape JSON như một attribute)
aws sqs set-queue-attributes \
  --queue-url https://sqs.us-east-1.amazonaws.com/123456789012/order-queue \
  --attributes file://queue-policy.json
```

**Cross-account / cross-region fan-out**: SNS topic ở account A có thể đẩy sang SQS queue ở account B (queue policy phải cho phép topic của A) và sang Region khác — SNS hỗ trợ cross-region delivery cho SQS/Lambda. Topic phải có policy cho phép account B thực hiện `sns:Subscribe`.

> 💡 **Exam Tip:** "S3 event must trigger 3 independent processing pipelines, each retried independently" → S3 → **SNS** → 3 SQS queue (fan-out), mỗi queue một consumer. Đừng chọn S3 → SQS trực tiếp (S3 chỉ gửi tới một đích cho một event type theo prefix, và không fan-out nhiều consumer độc lập kèm retry riêng).

## 22.4 SNS → Lambda và SNS → Kinesis Data Firehose

Ngoài SQS, hai đích push trực tiếp hay gặp:

**SNS → Lambda**: SNS gọi Lambda **asynchronously**. SNS đẩy event vào Lambda; nếu Lambda lỗi, *Lambda* (không phải SNS) sẽ retry theo cơ chế async invocation của nó (mặc định 2 lần retry, kèm khả năng cấu hình DLQ/destination ở phía Lambda — chi tiết ở Chương 28/30). SNS coi việc handoff vào Lambda là thành công khi Lambda nhận event, nên DLQ của *subscription SNS* chỉ bắt lỗi khi SNS không đẩy được vào Lambda (ví dụ Lambda bị throttle hết retry ở tầng SNS). Cần resource-based policy trên Lambda cho phép `sns.amazonaws.com` invoke (console tự thêm; thủ công phải `aws lambda add-permission`).

**SNS → Kinesis Data Firehose**: dùng để **archive/analytics** — Firehose buffer message và đẩy vào S3, Redshift, OpenSearch, hoặc HTTP endpoint (chi tiết Firehose ở Chương 23). Pattern hay gặp: mọi notification gửi qua topic được lưu lại S3 để audit, song song với việc đẩy tới các consumer realtime. Subscription firehose cần một IAM role cho SNS để ghi vào delivery stream.

```bash
aws sns subscribe \
  --topic-arn arn:aws:sns:us-east-1:123456789012:order-events \
  --protocol firehose \
  --notification-endpoint arn:aws:firehose:us-east-1:123456789012:deliverystream/archive-stream \
  --attributes '{"SubscriptionRoleArn":"arn:aws:iam::123456789012:role/SNSFirehoseRole"}'
```

> 💡 **Exam Tip:** "Persist all published notifications to S3 for compliance/audit, near real-time" → subscribe **Kinesis Data Firehose** vào topic. Đừng nhầm với Kinesis Data Streams — SNS không subscribe trực tiếp Data Streams; đích Kinesis của SNS là **Firehose**.

## 22.5 Message filtering với filter policy

Mặc định mọi subscriber của một topic nhận **mọi** message. Filtering cho phép mỗi subscription chỉ nhận message thoả một **filter policy** — nhờ đó bạn dùng **một topic** cho nhiều loại event, và route bằng policy thay vì tạo nhiều topic. Lợi ích lớn nhất về chi phí/hiệu năng: tránh gọi Lambda/đẩy vào SQS những message không liên quan.

Có hai chế độ filter scope:

- **MessageAttributes** (mặc định): filter dựa trên **message attributes** (metadata) bạn gắn khi publish, *không* nhìn vào body.
- **MessageBody**: filter dựa trên nội dung JSON của message body — không cần gắn attributes, nhưng body phải là JSON hợp lệ.

Filter policy là JSON: mỗi key map tới một **mảng** các giá trị/điều kiện được chấp nhận; subscriber nhận message khi *tất cả* key trong policy khớp (AND giữa các key, OR trong mảng giá trị mỗi key).

```json
{
  "event_type": ["order_placed", "order_cancelled"],
  "amount": [{ "numeric": [">=", 100] }],
  "region": ["us-east-1", "eu-west-1"]
}
```

Filter policy hỗ trợ các toán tử: khớp chính xác string, **anything-but** (loại trừ), prefix matching (`{"prefix": "ord_"}`), **numeric** với so sánh `>`, `>=`, `<`, `<=`, `=` và khoảng `[">", 0, "<=", 150]`, **exists** (`{"exists": true}`), và IP address matching (`cidr`). Một message **không** khớp sẽ bị bỏ qua cho subscriber đó (không tính là lỗi, không vào DLQ).

```javascript
// Publish kèm attributes để filter theo MessageAttributes
await sns.send(
  new PublishCommand({
    TopicArn,
    Message: JSON.stringify({ orderId: "A-1001" }),
    MessageAttributes: {
      event_type: { DataType: "String", StringValue: "order_placed" },
      amount: { DataType: "Number", StringValue: "250" },
      region: { DataType: "String", StringValue: "us-east-1" },
    },
  })
);
```

```bash
# Gắn filter policy cho một subscription (mặc định scope = MessageAttributes)
aws sns set-subscription-attributes \
  --subscription-arn arn:aws:sns:us-east-1:123456789012:order-events:abc-123 \
  --attribute-name FilterPolicy \
  --attribute-value '{"event_type":["order_placed"],"amount":[{"numeric":[">=",100]}]}'

# Đổi scope sang lọc theo body JSON
aws sns set-subscription-attributes \
  --subscription-arn arn:aws:sns:us-east-1:123456789012:order-events:abc-123 \
  --attribute-name FilterPolicyScope \
  --attribute-value MessageBody
```

**Bẫy thực tế với MessageAttributes filtering + raw delivery**: khi filter scope là `MessageAttributes`, nếu bạn bật **raw message delivery** vào SQS (xem 22.7), attributes vẫn được map sang SQS message attributes nên filter vẫn hoạt động. Nhưng nhiều người gắn attribute kiểu `Number` rồi viết filter dạng string — không khớp. Số phải khớp bằng toán tử `numeric`.

> 💡 **Exam Tip:** "Reduce unnecessary Lambda invocations / avoid processing irrelevant messages, use a single topic" → **filter policy** trên subscription. Đây là phương án thay cho việc tạo nhiều topic hoặc cho consumer tự lọc rồi bỏ (lãng phí invocation). Nhớ: message không khớp **bị drop cho subscriber đó**, không phải lỗi.

## 22.6 FIFO topics: ordering & deduplication

Standard topic cho **best-effort ordering** và có thể giao một message **nhiều hơn một lần** (at-least-once delivery, vì retry). Khi đề yêu cầu **strict ordering** và **không trùng**, dùng **FIFO topic**.

Đặc điểm FIFO topic:

- Tên topic phải kết thúc bằng hậu tố `.fifo`.
- Mỗi message cần **MessageGroupId**: ordering được đảm bảo *trong cùng một group*; các group khác nhau xử lý song song. Đây là cơ chế song song hoá có kiểm soát giống SQS FIFO.
- **Deduplication**: hoặc bật **content-based deduplication** (SNS hash body làm dedup ID), hoặc cung cấp **MessageDeduplicationId** thủ công. Trong **dedup interval 5 phút**, message trùng ID bị bỏ.
- FIFO topic **chỉ** subscribe được **SQS FIFO queue** (không subscribe được Lambda/HTTP/email/SMS trực tiếp). Đây là điểm hay bị hỏi.
- Throughput: tới **300 messages/giây** mỗi topic theo mặc định (hoặc 30 MB/s nếu nhỏ hơn); có chế độ high throughput cho phép cao hơn nhiều.

Để giữ ordering end-to-end, ghép **SNS FIFO → SQS FIFO**: dùng cùng `MessageGroupId` qua suốt chuỗi.

```bash
# Tạo FIFO topic với content-based dedup
aws sns create-topic \
  --name order-events.fifo \
  --attributes '{"FifoTopic":"true","ContentBasedDeduplication":"true"}'

# Publish vào FIFO topic (bắt buộc MessageGroupId)
aws sns publish \
  --topic-arn arn:aws:sns:us-east-1:123456789012:order-events.fifo \
  --message '{"orderId":"A-1001"}' \
  --message-group-id customer-42
```

> 💡 **Exam Tip:** "Ordered processing of events per customer, no duplicates, fan-out to multiple ordered consumers" → **SNS FIFO topic → nhiều SQS FIFO queue**, dùng `MessageGroupId = customerId`. Nhớ hai ràng buộc thi hay gài: (1) FIFO topic chỉ nhận SQS FIFO làm subscriber; (2) raw message delivery **bắt buộc bật** khi FIFO topic → SQS FIFO.

## 22.7 Raw message delivery & message attributes

Mặc định khi SNS đẩy message vào SQS/HTTP, nó **bọc** message gốc trong một JSON envelope của SNS gồm các field như `Type`, `MessageId`, `TopicArn`, `Message` (payload thật nằm trong field `Message` dưới dạng string), `Timestamp`, `MessageAttributes`... Consumer phải parse hai lớp: parse envelope SQS, rồi parse `body.Message`.

Bật **Raw Message Delivery** (`RawMessageDelivery = true` trên subscription) khiến SNS gửi **chỉ payload gốc**, không có envelope. Lợi ích:

- Consumer đỡ một lớp parse; message giống hệt khi publish trực tiếp vào SQS.
- Giảm kích thước message (đỡ overhead envelope).
- **Message attributes** của SNS được map thẳng sang **SQS message attributes** (thay vì nằm lồng trong envelope) — quan trọng nếu downstream lọc/định tuyến theo attributes.

Raw delivery chỉ áp dụng cho protocol **SQS** và **HTTP/HTTPS**. Với FIFO topic → SQS FIFO, raw delivery là **bắt buộc**.

```bash
aws sns set-subscription-attributes \
  --subscription-arn arn:aws:sns:us-east-1:123456789012:order-events:abc-123 \
  --attribute-name RawMessageDelivery \
  --attribute-value true
```

**Message attributes** là cặp key-value metadata (DataType: `String`, `Number`, `Binary`, `String.Array`) gắn kèm message. Dùng cho: filtering (22.5), truyền metadata mà không nhét vào body, và một số tích hợp (ví dụ SMS dùng attribute `AWS.SNS.SMS.SMSType` để chọn Transactional/Promotional). Tối đa **10 attributes** nếu route tới SQS qua một số đường, nhưng giới hạn tổng vẫn nằm trong 256 KB cùng body.

> 💡 **Exam Tip:** "Consumer code đang nhận JSON lồng JSON / phải parse `body.Message`" hoặc "filter/route theo attribute ở phía SQS không hoạt động" → bật **Raw Message Delivery**. Và nhớ: FIFO topic → SQS FIFO yêu cầu raw delivery bật.

## 22.8 Delivery retries & Dead Letter Queue cho SNS

SNS có **delivery policy** với retry tự động khi đẩy message thất bại, và chính sách retry khác nhau theo protocol:

- **AWS-managed endpoints (SQS, Lambda, Firehose)**: SNS retry rất bền — tới **100,015 lần** trong tối đa **23 ngày** với backoff, vì các lỗi này thường là throttle tạm thời.
- **HTTP/HTTPS**: theo delivery policy bạn cấu hình — số lần retry, backoff (linear/geometric/exponential), khoảng delay min/max. Mặc định khoảng 3 retry nhanh + vài retry với backoff; bạn tuỳ chỉnh được tới tối đa định nghĩa trong policy.

Khi **hết retry**, message bị bỏ — trừ khi bạn cấu hình **Dead Letter Queue** cho subscription. DLQ của SNS là một **SQS queue** gắn vào *subscription* (không phải vào topic) qua thuộc tính **RedrivePolicy**. Message thất bại giao (sau khi cạn retry) được chuyển vào DLQ kèm metadata lỗi để bạn điều tra/redrive.

```bash
# Gắn DLQ cho một subscription
aws sns set-subscription-attributes \
  --subscription-arn arn:aws:sns:us-east-1:123456789012:order-events:abc-123 \
  --attribute-name RedrivePolicy \
  --attribute-value '{"deadLetterTargetArn":"arn:aws:sqs:us-east-1:123456789012:sns-dlq"}'
```

DLQ queue cần policy cho phép `sns.amazonaws.com` `sqs:SendMessage` (giống fan-out). Lưu ý phân biệt hai loại lỗi: **delivery failure** (SNS không đẩy được tới endpoint — đây là cái DLQ của SNS bắt) khác với **processing failure** (endpoint nhận được nhưng xử lý lỗi — cái này thuộc về DLQ của *consumer*, ví dụ DLQ của SQS hoặc của Lambda async). Đề rất hay gài chỗ này.

> 💡 **Exam Tip:** Message "bị mất sau khi endpoint HTTP của bên thứ ba down nhiều giờ" → cấu hình **DLQ cho subscription SNS** (RedrivePolicy) để bắt message giao thất bại; song song điều chỉnh delivery retry policy. Nhưng nếu endpoint là **Lambda nhận được rồi xử lý lỗi**, thì cần DLQ/destination ở phía **Lambda**, không phải SNS.

## 22.9 Encryption, access control & SNS vs SQS vs EventBridge

**Encryption**: SNS hỗ trợ encryption **at rest** bằng **SSE** với KMS key (AWS managed `aws/sns` hoặc customer managed key — CMK). In transit luôn là HTTPS. Bẫy fan-out hay gặp: nếu topic *và/hoặc* queue bật SSE-KMS với CMK, **key policy của KMS phải cho phép** `sns.amazonaws.com` (và service liên quan) gọi `kms:GenerateDataKey`/`kms:Decrypt`; thiếu là message drop âm thầm.

**Access control**: topic có **resource-based policy** (access policy) kiểm soát ai được `Publish`/`Subscribe`. Đây là cách cho cross-account publisher (ví dụ S3 ở account khác, hay CloudWatch) gửi vào topic, dùng condition `aws:SourceArn`/`aws:SourceAccount`.

So sánh ba dịch vụ messaging hay bị nhầm trong đề:

| Tiêu chí | SNS | SQS | EventBridge |
|---|---|---|---|
| Mô hình | Pub/sub, push tới nhiều subscriber | Queue, pull, một consumer/message | Event bus, rule định tuyến tới target |
| Fan-out | Có (native) | Không (cần SNS phía trước) | Có (nhiều rule/target) |
| Buffering bền | Không (push); cần SQS phía sau | Có | Không (push tới target) |
| Filtering | Filter policy (attr/body) | Không | Event pattern (mạnh hơn, content-based) |
| Ordering/FIFO | FIFO topic | FIFO queue | Không đảm bảo ordering |
| Số target/consumer | Nhiều subscriber | Nhiều consumer poll chung | ~5 target/rule, nhiều rule |
| Schema/registry, replay | Không | Không | Có (schema registry, archive & replay) |
| Tích hợp SaaS/AWS event | Hạn chế | Không | Rất rộng (90+ AWS service, partner) |
| Latency | Rất thấp (ms) | Thấp | Thấp (cao hơn SNS chút) |

Quy tắc chọn nhanh: **SNS** khi cần fan-out đơn giản, độ trễ thấp, nhiều subscriber dạng SQS/Lambda/HTTP. **SQS** khi cần buffer/decouple một worker, đảm bảo không mất, xử lý theo nhịp consumer. **EventBridge** khi cần định tuyến nhiều loại event theo content phức tạp, tích hợp event từ AWS service/SaaS, cần archive & replay, schema registry (chi tiết EventBridge ở Chương 25). Kinesis (Chương 23) cho streaming throughput cao, nhiều consumer đọc lại theo offset, ordering theo shard.

> 💡 **Exam Tip:** "Route events to different targets based on **content of the event**, with replay and many AWS service integrations" → **EventBridge**, không phải SNS. "Simple fan-out to several SQS/Lambda with lowest latency" → **SNS**. "Decouple and buffer work for a single set of workers" → **SQS**. Nắm chắc bảng này: gần như mỗi đề DVA có 1-2 câu so ba dịch vụ.
