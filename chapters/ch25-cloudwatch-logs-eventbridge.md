# Chương 25: CloudWatch Logs & Amazon EventBridge

> **Trọng tâm DVA-C02:** Đây là hai dịch vụ "xương sống" của domain Troubleshooting (18%) và một phần Development. Đề thi hay hỏi: cách stream log từ EC2/Lambda/ECS vào CloudWatch Logs, dùng **metric filter** để biến log thành alarm, **subscription filter** để đẩy log real-time sang Lambda/Firehose/Kinesis, **Logs Insights** để truy vấn, và đặc biệt là **EventBridge** với event pattern, schedule rule, input transformer, archive & replay, cross-account event bus. Bẫy kinh điển: phân biệt "EventBridge (Events) vs CloudWatch Logs subscription" và "schedule rule vs cron của OS".

## Mục tiêu chương
- Hiểu mô hình log group → log stream → log event, retention, và quyền IAM tối thiểu để ghi log.
- Biết chọn đúng cơ chế gửi log: SDK trực tiếp, CloudWatch Agent (Unified Agent), hay log tự động của Lambda/ECS/Beanstalk.
- Dùng metric filter để tạo metric từ log, dùng Logs Insights để truy vấn log nhanh, dùng subscription filter để stream log real-time.
- Cấu hình mã hoá log bằng KMS và dùng Live Tail để debug trực tiếp.
- Nắm vững EventBridge: event bus (default/custom/partner), rule với event pattern và schedule, target, input transformation, archive & replay, schema registry, resource-based policy cho cross-account.
- Phân biệt rõ EventBridge với CloudWatch Logs subscription, SNS và SQS trong các tình huống đề thi.

## 25.1 CloudWatch Logs — mô hình dữ liệu và vòng đời

CloudWatch Logs lưu log theo cấu trúc 3 tầng:

- **Log group**: container logic, thường gắn với một ứng dụng/service (ví dụ `/aws/lambda/order-service`, `/ecs/payment`). Retention, KMS encryption, metric filter, subscription filter đều cấu hình ở **mức log group**.
- **Log stream**: một chuỗi log event đến từ **một nguồn duy nhất** — ví dụ một instance EC2, một execution environment của Lambda, một container. Tên stream Lambda có dạng `2026/06/12/[$LATEST]abc123...`.
- **Log event**: một dòng log, gồm `timestamp` (epoch milliseconds) và `message` (UTF-8).

Một vài quota cần nhớ cho đề thi:

- Kích thước tối đa một batch khi gọi `PutLogEvents`: **1 MB** (tối đa **10.000 log event**/lần gọi).
- Kích thước tối đa một log event: **256 KB** (sau đó bị cắt/từ chối).
- **Retention mặc định là "Never Expire" (vô thời hạn)** — đây là bẫy chi phí kinh điển. Bạn phải chủ động set retention (1 ngày đến 10 năm: 1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1827, 2192, 2557, 2922, 3288, 3653 ngày).
- Log event đến **trễ tối đa 14 ngày** hoặc **sớm tối đa 2 giờ** so với hiện tại sẽ bị từ chối.

Ghi log trực tiếp bằng SDK v3:

```javascript
// Ghi log event vào CloudWatch Logs bằng SDK v3
import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  CreateLogStreamCommand,
  PutLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";

const client = new CloudWatchLogsClient({ region: "ap-southeast-1" });
const logGroupName = "/app/payment";
const logStreamName = "worker-1";

// Tạo group + stream (bỏ qua nếu đã tồn tại)
await client.send(new CreateLogGroupCommand({ logGroupName })).catch(() => {});
await client.send(new CreateLogStreamCommand({ logGroupName, logStreamName })).catch(() => {});

// Đẩy log event — timestamp là epoch millisecond
await client.send(new PutLogEventsCommand({
  logGroupName,
  logStreamName,
  logEvents: [
    { timestamp: Date.now(), message: JSON.stringify({ level: "ERROR", orderId: 42, msg: "charge failed" }) },
  ],
}));
```

> 💡 **Exam Tip:** Trước đây `PutLogEvents` yêu cầu truyền `sequenceToken` đúng thứ tự, nếu sai trả về `InvalidSequenceTokenException`. AWS đã **bỏ yêu cầu sequence token** — bạn không còn cần truyền nó. Nhưng nếu đề thi cũ nhắc `InvalidSequenceTokenException`, nó liên quan ghi log đồng thời nhiều thread vào cùng một stream.

IAM tối thiểu để một service ghi log: `logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents`. Đây chính xác là các quyền nằm trong managed policy `AWSLambdaBasicExecutionRole`.

## 25.2 Gửi log từ EC2, Lambda, ECS và Beanstalk

Khác biệt cốt lõi: **service nào managed thì AWS tự push log, service nào bạn tự quản (EC2) thì phải cài agent**.

**Lambda**: Lambda runtime tự động ghi mọi `console.log` / stdout / stderr vào log group `/aws/lambda/<function-name>`. Điều kiện duy nhất: execution role có quyền `logs:CreateLogStream` + `logs:PutLogEvents`. Nếu function chạy nhưng **không thấy log**, 90% là thiếu quyền logs trong execution role.

**ECS**: dùng **`awslogs` log driver** trong task definition để đẩy stdout container vào CloudWatch Logs. Với Fargate có thể dùng **FireLens** (Fluent Bit/Fluentd) để route log linh hoạt hơn (sang Firehose, OpenSearch...).

```json
{
  "logConfiguration": {
    "logDriver": "awslogs",
    "options": {
      "awslogs-group": "/ecs/payment",
      "awslogs-region": "ap-southeast-1",
      "awslogs-stream-prefix": "ecs",
      "awslogs-create-group": "true"
    }
  }
}
```

**Elastic Beanstalk**: bật "Log streaming to CloudWatch Logs" trong cấu hình environment; EB sẽ stream application & web server log lên CloudWatch Logs (chi tiết Beanstalk ở Chương 18).

**EC2**: instance **không tự đẩy log** — bạn phải cài agent. Có hai agent, và đề thi rất hay phân biệt:

| | CloudWatch Logs Agent (legacy) | **Unified CloudWatch Agent** (khuyến nghị) |
|---|---|---|
| Đẩy log | Có | Có |
| Đẩy **metric** (RAM, disk, swap, procstat) | **Không** | **Có** |
| Cấu hình | file `awslogs.conf` | file JSON + tích hợp SSM Parameter Store |
| Trạng thái | deprecated | hiện hành |

Điểm thi quan trọng: **CloudWatch không thu thập được RAM, disk usage, swap của EC2 bằng metric mặc định** — đây là "guest OS-level metrics", chỉ lấy được khi cài Unified CloudWatch Agent. (Chi tiết metric mặc định ở Chương 24.)

Để EC2 đẩy log/metric, **instance role** phải có policy `CloudWatchAgentServerPolicy`. Agent thường được triển khai và cấu hình qua **SSM** (lưu config trong Parameter Store, deploy bằng `AmazonCloudWatch-ManageAgent` document).

> 💡 **Exam Tip:** Câu hỏi "developer cần monitor memory utilization của EC2" → đáp án luôn là **cài CloudWatch Agent (Unified) và publish memory như custom metric**, KHÔNG phải bật detailed monitoring (detailed monitoring chỉ giảm chu kỳ metric hypervisor-level từ 5 phút xuống 1 phút, không thêm RAM/disk).

## 25.3 Metric filter — biến log thành metric và alarm

**Metric filter** quét log event đến trong một log group, khớp **filter pattern**, và phát ra một **CloudWatch metric**. Đây là cách bạn alarm dựa trên nội dung log (ví dụ "đếm số dòng ERROR", "đếm 404").

Cơ chế quan trọng cần nhớ:

- Metric filter **chỉ áp dụng cho log event đến SAU khi filter được tạo** — không hồi tố log cũ.
- Nếu trong khoảng thời gian không có log nào khớp, metric **không phát ra datapoint** (không phải 0). Vì vậy khi tạo alarm trên metric filter, thường phải set **`defaultValue`** (ví dụ 0) cho metric, hoặc xử lý "missing data" trong alarm, nếu không alarm có thể `INSUFFICIENT_DATA`.

Filter pattern hỗ trợ:
- Text thường: `ERROR`, `"connection refused"`.
- Cú pháp JSON: `{ $.level = "ERROR" }`, `{ $.statusCode = 500 }`.
- Space-delimited với điều kiện: `[ip, id, user, ..., status_code=4*, size]`.

Tạo metric filter và alarm "có ≥5 ERROR trong 5 phút":

```bash
# Tạo metric filter: đếm log JSON có level=ERROR
aws logs put-metric-filter \
  --log-group-name /app/payment \
  --filter-name ErrorCount \
  --filter-pattern '{ $.level = "ERROR" }' \
  --metric-transformations \
      metricName=PaymentErrors,metricNamespace=PaymentApp,metricValue=1,defaultValue=0

# Tạo alarm trên metric đó
aws cloudwatch put-metric-alarm \
  --alarm-name payment-errors-high \
  --namespace PaymentApp --metric-name PaymentErrors \
  --statistic Sum --period 300 --evaluation-periods 1 \
  --threshold 5 --comparison-operator GreaterThanOrEqualToThreshold \
  --alarm-actions arn:aws:sns:ap-southeast-1:111122223333:ops-alerts
```

> 💡 **Exam Tip:** "Cần gửi cảnh báo khi xuất hiện log có chữ NullPointerException / ERROR" → **metric filter + CloudWatch alarm → SNS**. Đừng nhầm với subscription filter (subscription filter dùng để *stream toàn bộ log* sang đích xử lý, không phải để alarm).

## 25.4 CloudWatch Logs Insights — truy vấn log

Logs Insights là engine truy vấn tương tác trên log đã ngấm vào CloudWatch Logs. Nó dùng cú pháp riêng (không phải SQL), tự động khám phá field cho log dạng JSON.

```
fields @timestamp, @message, level, orderId
| filter level = "ERROR"
| sort @timestamp desc
| limit 20
```

Các lệnh chính: `fields`, `filter`, `stats` (aggregate như `count()`, `avg()`, `pct()`), `sort`, `limit`, `parse` (trích field từ text không cấu trúc), `dedup`.

Ví dụ tính p95 latency và đếm lỗi theo phút:

```
filter @message like /latencyMs/
| stats avg(latencyMs), pct(latencyMs, 95) as p95, count(*) as reqs by bin(1m)
```

Đặc điểm thi hay hỏi:
- Logs Insights truy vấn được **nhiều log group cùng lúc** (đến 50 log group, hoặc dùng query definition).
- Có **field hệ thống** tự động: `@timestamp`, `@message`, `@logStream`, `@log`, và với Lambda là `@duration`, `@billedDuration`, `@maxMemoryUsed`, `@initDuration` (rất hữu ích để phân tích cold start).
- Kết quả query mặc định trả tối đa 10.000 dòng; query timeout 60 phút (15 phút cho một số region cũ).
- Có thể chạy Logs Insights qua API `StartQuery`/`GetQueryResults` để tự động hoá.

> 💡 **Exam Tip:** Khi đề hỏi "ad-hoc analysis / tìm nhanh pattern trong log không cần dựng hạ tầng" → **CloudWatch Logs Insights**. Khi cần dashboard phân tích lớn, full-text search mạnh, hoặc visualize bằng Kibana → cân nhắc stream sang **OpenSearch** (qua subscription filter, chi tiết OpenSearch ở Chương 48).

## 25.5 Subscription filter — stream log real-time

Trong khi metric filter tạo metric, **subscription filter** đẩy **bản thân các log event** (đã khớp pattern) real-time tới một đích để xử lý/lưu trữ. Đích hợp lệ:

- **AWS Lambda** — xử lý/chuyển đổi log (ví dụ parse và ghi vào DynamoDB).
- **Amazon Kinesis Data Streams** — buffer cho consumer tuỳ biến, throughput cao.
- **Amazon Data Firehose** (trước là Kinesis Firehose) — đẩy vào S3, OpenSearch, Redshift, Splunk gần real-time.

Log event đi qua subscription được **gzip-compressed và base64-encoded**, bọc trong message JSON có field `logEvents[]`. Khi target là Lambda, bạn phải **gunzip payload** trước khi đọc:

```javascript
// Lambda nhận log từ subscription filter — phải giải nén gzip
import { gunzipSync } from "node:zlib";

export const handler = async (event) => {
  const payload = Buffer.from(event.awslogs.data, "base64");
  const json = JSON.parse(gunzipSync(payload).toString("utf8"));
  // json.logGroup, json.logStream, json.logEvents[].message
  for (const e of json.logEvents) {
    console.log("forwarding:", e.message);
  }
};
```

Giới hạn quan trọng: **một log group chỉ gắn được tối đa 2 subscription filter** (trước đây là 1; nay quota mặc định 2). Subscription filter cũng **chỉ tác động lên log event mới**, không hồi tố.

**Cross-account / cross-region**: bạn có thể đẩy log từ account A sang Kinesis/Firehose của account B. Account đích tạo **destination** (`PutDestination`) với **destination policy** (resource-based policy) cho phép account nguồn `logs:PutSubscriptionFilter`. Đây là pattern tập trung log (centralized logging).

So sánh nhanh metric filter vs subscription filter:

| | Metric filter | Subscription filter |
|---|---|---|
| Output | CloudWatch **metric** (số) | **Log event** thật (real-time stream) |
| Đích | metric → alarm/dashboard | Lambda / Kinesis DS / Firehose |
| Dùng để | alarm, đếm | xử lý, lưu trữ, phân tích, centralize |
| Hồi tố log cũ | Không | Không |

> 💡 **Exam Tip:** "Stream tất cả log của nhiều account về một nơi tập trung / index lên OpenSearch / lưu S3 để phân tích" → **subscription filter → (cross-account destination) → Kinesis Data Streams hoặc Firehose**. Firehose là lựa chọn "least operational overhead" để đổ vào S3/OpenSearch.

## 25.6 Export, mã hoá KMS và Live Tail

**Export sang S3**: API `CreateExportTask` xuất log của một group ra S3 (batch, không real-time, có thể mất tới 12 giờ để hoàn tất). Dùng cho lưu trữ dài hạn/audit, KHÔNG dùng khi cần real-time (real-time thì dùng subscription filter).

**Mã hoá bằng KMS**: log trong CloudWatch luôn được mã hoá at-rest. Bạn có thể dùng **customer managed KMS key** thay key mặc định bằng `AssociateKmsKey`. Điều kiện bắt buộc: **key policy của CMK phải cho phép service principal `logs.<region>.amazonaws.com`** thực hiện `kms:Encrypt*`, `kms:Decrypt*`, `kms:GenerateDataKey*`, `kms:Describe*`. Thiếu phần này là lý do phổ biến khiến associate KMS thất bại.

```bash
# Gắn CMK cho log group
aws logs associate-kms-key \
  --log-group-name /app/payment \
  --kms-key-id arn:aws:kms:ap-southeast-1:111122223333:key/abcd-1234
```

**Live Tail**: stream log event của một log group **gần như tức thời** ngay trên console/CLI (`aws logs start-live-tail`), có highlight & filter. Dùng để debug trực tiếp thay vì F5 console. Lưu ý đây là tính năng **tính phí theo phút streaming**, nên tắt sau khi debug xong.

> 💡 **Exam Tip:** Phân biệt: **Export to S3** = batch, lưu trữ, có độ trễ; **Subscription filter** = real-time stream; **Live Tail** = xem trực tiếp khi debug. Đề hay gài "real-time" để loại Export.

**War story — chi phí log "ngầm":** một nguyên nhân hoá đơn CloudWatch tăng vọt là log group để retention "Never Expire" tích luỹ hàng trăm GB, cộng thêm ingestion cost (tính theo GB log đưa vào). Hai biện pháp thực tế: (1) đặt retention hợp lý cho mọi log group ngay từ đầu (dùng SCP hoặc một Lambda quét định kỳ `PutRetentionPolicy`); (2) giảm khối lượng log ingest — đừng `console.log` toàn bộ payload/object lớn trong vòng lặp nóng. Lambda còn có thêm chi phí ẩn là `INIT`/cold-start log; dùng Logs Insights field `@initDuration` để soi.

Phân loại nhanh ba con đường đưa log "ra khỏi" CloudWatch Logs để khỏi nhầm trong đề:

| Mục đích | Cơ chế | Real-time? |
|---|---|---|
| Lưu trữ dài hạn rẻ vào S3 | `CreateExportTask` (Export to S3) | Không (batch, có thể trễ giờ) |
| Xử lý/định tuyến/centralize liên tục | Subscription filter → Lambda/Kinesis/Firehose | Có |
| Xem log trực tiếp khi đang debug | Live Tail | Gần tức thời (streaming UI) |

## 25.7 Amazon EventBridge — event bus, rule, target

**EventBridge** (tiền thân là **CloudWatch Events** — cùng một service, EventBridge là tên mới và là siêu tập) là serverless event bus: nhận event, khớp **rule**, và định tuyến tới **target**.

Các loại **event bus**:
- **Default event bus**: nhận event từ **AWS services** (ví dụ EC2 đổi state, S3 object created qua EventBridge, CodePipeline state change, Console sign-in...).
- **Custom event bus**: bạn tự tạo cho ứng dụng của mình; code phát event bằng `PutEvents`.
- **Partner event bus**: nhận event từ SaaS partner (Datadog, Zendesk, Auth0, Shopify...) qua partner event source.

Một **rule** gồm:
- **Event pattern** (rule dạng event-driven) HOẶC **schedule** (rule dạng cron/rate) — một rule là một trong hai loại.
- **Target(s)**: tối đa **5 target/rule**. Hơn 200 loại target: Lambda, SQS, SNS, Kinesis, Step Functions, ECS task, CodeBuild, SSM, API destination (HTTP endpoint), Lambda khác bus...

Phát một custom event:

```javascript
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";

const eb = new EventBridgeClient({ region: "ap-southeast-1" });

await eb.send(new PutEventsCommand({
  Entries: [{
    EventBusName: "orders-bus",          // custom bus
    Source: "com.myshop.orders",         // namespace ứng dụng
    DetailType: "OrderPlaced",
    Detail: JSON.stringify({ orderId: 42, amount: 199000, country: "VN" }),
  }],
}));
```

Quota cần nhớ:
- `PutEvents`: tối đa **10 entry/lần gọi**, mỗi entry **≤ 256 KB** (kích thước event).
- Mỗi rule tối đa **5 target**.
- EventBridge giao event **at-least-once** (có thể trùng) và **không bảo đảm thứ tự**.
- Retry mặc định tới **24 giờ** với exponential backoff cho async target; có thể gắn **Dead-Letter Queue (SQS)** cho target lỗi.

> 💡 **Exam Tip:** EventBridge **không bảo đảm ordering** và là **at-least-once**. Nếu đề yêu cầu strict ordering hoặc exactly-once cho event, EventBridge không phải đáp án (cân nhắc SQS FIFO / Kinesis — Chương 21, 23).

Một chi tiết IAM hay gài: để **AWS service** tự phát event vào default bus thì không cần cấu hình gì thêm — đó là hành vi mặc định. Nhưng để **code của bạn** gọi `PutEvents`, principal cần quyền `events:PutEvents` trên ARN của bus đích. Và để một rule **gọi được target**, EventBridge cần quyền tới target: với Lambda là **resource-based policy** trên function (`lambda:InvokeFunction` cho principal `events.amazonaws.com`); với SQS/SNS là resource policy của queue/topic; với target cần đẩy dữ liệu (Kinesis, Step Functions, ECS RunTask...) bạn phải gắn **IAM role cho rule**. Lỗi "rule khớp nhưng target không chạy" thường do thiếu một trong các quyền này — kiểm tra metric `FailedInvocations` của rule.

## 25.8 Event pattern, schedule, input transformer

**Event pattern** là JSON khớp với cấu trúc event. Event AWS luôn có khung: `source`, `detail-type`, `detail`, `region`, `account`, `time`, `resources`. Pattern chỉ cần liệt kê field muốn khớp; field không liệt kê coi như "match bất kỳ".

```json
{
  "source": ["aws.ec2"],
  "detail-type": ["EC2 Instance State-change Notification"],
  "detail": {
    "state": ["stopped", "terminated"]
  }
}
```

Pattern hỗ trợ **content filtering** mạnh: `prefix`, `suffix`, `anything-but`, `numeric` (`[">", 100]`), `exists`, `cidr`, `equals-ignore-case`, và `$or`. Ví dụ "amount > 1.000.000":

```json
{ "detail": { "amount": [{ "numeric": [">", 1000000] }] } }
```

**Schedule rule** chạy target theo lịch — thay thế cron server:
- `rate(5 minutes)`, `rate(1 hour)`, `rate(1 day)`.
- `cron(0 9 * * ? *)` — **giờ UTC**, gồm 6 trường: phút, giờ, ngày-tháng, tháng, ngày-tuần, năm. Lưu ý không được điền cả "day-of-month" và "day-of-week" cùng lúc (một trong hai phải là `?`).

> 💡 **Exam Tip:** Cron của EventBridge chạy theo **UTC**, không theo timezone local. Đề hay gài "chạy 9h sáng giờ Việt Nam" → phải đổi sang UTC (2h sáng UTC). Với nhu cầu lịch phức tạp (timezone, one-time, flexible window) → **EventBridge Scheduler** (dịch vụ mới, tách riêng, hỗ trợ timezone và hơn 1 triệu schedule).

**Input transformation**: trước khi gửi tới target, EventBridge có thể biến đổi event. Bốn chế độ input cho target:
- *Matched event* (mặc định): gửi nguyên event.
- *Part of the matched event* (Input Path): chỉ gửi một nhánh JSON.
- *Constant*: gửi JSON cố định.
- **Input Transformer**: trích biến từ event (`InputPaths`) rồi nhồi vào template tuỳ ý (`InputTemplate`) — ví dụ tạo message dễ đọc cho Slack/SNS.

```json
{
  "InputPathsMap": { "instance": "$.detail.instance-id", "state": "$.detail.state" },
  "InputTemplate": "\"Instance <instance> changed to <state>\""
}
```

## 25.9 Archive & replay, schema registry, cross-account & resource policy

**Archive & Replay**: bạn có thể tạo **archive** trên một event bus (kèm filter pattern + retention) để **lưu lại event**. Khi cần, dùng **replay** để bơm lại các event đã lưu vào bus trong một khoảng thời gian — phục vụ test, recovery sau sự cố, hoặc reprocess. Đây là khả năng độc đáo của EventBridge so với SNS/SQS.

> 💡 **Exam Tip:** "Cần lưu lại event để sau này phát lại / reprocess / debug pipeline event-driven" → **EventBridge archive + replay**. SNS không lưu event; SQS chỉ giữ tối đa 14 ngày và không replay tới nhiều consumer như vậy.

**Schema Registry & Discovery**: EventBridge có thể **tự khám phá schema** của event chảy qua bus (schema discovery) và lưu vào **schema registry** (định dạng OpenAPI/JSONSchema). Từ schema, sinh **code binding** (TypeScript, Python, Java...) để developer code với strongly-typed event object thay vì đọc JSON thô.

**Cross-account events & resource-based policy**: để account A gửi event vào event bus của account B, **event bus của B phải có resource-based policy** cho phép principal của A thực hiện `events:PutEvents`. Đây là pattern hub-and-spoke (nhiều account con đẩy event về bus trung tâm).

```json
{
  "Sid": "AllowAccountAPutEvents",
  "Effect": "Allow",
  "Principal": { "AWS": "arn:aws:iam::111122223333:root" },
  "Action": "events:PutEvents",
  "Resource": "arn:aws:events:ap-southeast-1:999988887777:event-bus/central-bus"
}
```

**API destinations**: target là một HTTP endpoint bên ngoài (SaaS, webhook), kèm **connection** lưu credential (API key/OAuth/Basic) — EventBridge tự ký request và có rate-limit. Cho phép tích hợp event ra ngoài AWS mà không cần viết Lambda proxy.

**EventBridge vs CloudWatch Events**: hoàn toàn cùng một service và cùng API/quota — EventBridge chỉ là tên thương hiệu mới, bổ sung custom bus, partner bus, schema registry, archive/replay. Tên `cloudwatch:Events` cũ vẫn xuất hiện trong vài tài liệu nhưng quy về EventBridge.

Cuối cùng, khi nào dùng gì (so sánh nhanh — chi tiết SNS/SQS ở Chương 21–22):

| Tình huống | Dịch vụ |
|---|---|
| Phản ứng theo **sự kiện AWS/SaaS**, định tuyến tới >200 loại target, filter nội dung phức tạp, archive/replay | **EventBridge** |
| **Fan-out** broadcast tới nhiều subscriber (SQS/Lambda/HTTP/email/SMS), throughput cực cao, độ trễ thấp | **SNS** |
| **Decouple** producer-consumer, buffer, retry, đảm bảo xử lý từng message bởi 1 consumer | **SQS** |
| **Stream toàn bộ log** real-time sang Lambda/Firehose/Kinesis | **CloudWatch Logs subscription filter** |

> 💡 **Exam Tip:** Nếu đề nhấn "react to AWS service events" + "routing rules" + "scheduled" → **EventBridge**. Nếu nhấn "multiple subscribers, fan-out, push" → **SNS**. Nếu nhấn "buffer, decouple, process once" → **SQS**. Ba từ khoá này phân biệt 90% câu hỏi integration.

---

## Hands-on Lab: Logs metric filter + alarm, Logs Insights, subscription filter và EventBridge rule (schedule + event pattern + archive/replay)

**Mục tiêu lab:** Dựng một pipeline observability "thực chiến" gom đủ điểm thi hay hỏi nhất của chương: (1) tạo log group có retention, đẩy log bằng `put-log-events`, (2) tạo **metric filter** đếm số dòng `ERROR` rồi gắn **CloudWatch alarm** bắn ra SNS, (3) chạy **Logs Insights** query thống kê lỗi, (4) tạo **subscription filter** stream log realtime sang Lambda, (5) tạo **EventBridge rule** dạng schedule (cron) và dạng event pattern (bắt sự kiện EC2 instance state change) đẩy ra SNS với **input transformation**, (6) bật **archive & replay** trên event bus.

**Chuẩn bị:**
- AWS CLI v2 đã cấu hình profile có quyền `logs:*`, `cloudwatch:*`, `events:*`, `sns:*`, `lambda:*`, `iam:*` (dùng tài khoản học tập, KHÔNG chạy trên production).
- Region thống nhất: lab dùng `ap-southeast-1`. Đổi lại trong mọi lệnh nếu bạn dùng region khác.
- `jq` để đọc JSON output cho dễ.

### Bước 1: Tạo log group, đặt retention và đẩy log

```bash
export AWS_REGION=ap-southeast-1
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export LG=/dva/ch25/app

# Tạo log group; mặc định retention = Never Expire (lưu mãi, tốn tiền) nên LUÔN đặt retention
aws logs create-log-group --log-group-name $LG
aws logs put-retention-policy --log-group-name $LG --retention-in-days 7

# Tạo log stream rồi đẩy vài dòng log
aws logs create-log-stream --log-group-name $LG --log-stream-name app-1

TS=$(($(date +%s) * 1000))   # CloudWatch Logs yêu cầu timestamp tính bằng mili-giây
aws logs put-log-events --log-group-name $LG --log-stream-name app-1 \
  --log-events \
    timestamp=$TS,message="INFO user login userId=42" \
    timestamp=$((TS+1000)),message="ERROR db timeout userId=42" \
    timestamp=$((TS+2000)),message="ERROR db timeout userId=99"
```

> 💡 Retention hợp lệ là tập giá trị rời rạc: 1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1827, 3653 ngày (và "Never expire"). Đặt 10 ngày sẽ lỗi `InvalidParameterException`. Đề hay gài "đặt retention 45 ngày" — không có giá trị 45.

### Bước 2: Metric filter — biến log thành metric

Metric filter quét pattern trong log và publish một custom metric vào CloudWatch. Pattern `ERROR` (term filter) khớp mọi dòng chứa từ ERROR:

```bash
aws logs put-metric-filter --log-group-name $LG \
  --filter-name count-errors \
  --filter-pattern "ERROR" \
  --metric-transformations \
     metricName=AppErrorCount,metricNamespace=DVA/Ch25,metricValue=1,defaultValue=0
```

Đẩy thêm log rồi kiểm tra metric xuất hiện:

```bash
aws cloudwatch list-metrics --namespace DVA/Ch25
```

> 💡 **Bẫy quan trọng:** metric filter CHỈ áp dụng cho log đẩy vào SAU khi filter được tạo — nó không quét lại log cũ. Muốn truy vấn log đã có thì dùng Logs Insights (Bước 4). Đặt `defaultValue=0` để metric vẫn publish điểm 0 khi không có lỗi, nếu không alarm có thể rơi vào trạng thái `INSUFFICIENT_DATA` thay vì `OK`.

### Bước 3: SNS topic + Alarm trên metric filter

```bash
export TOPIC_ARN=$(aws sns create-topic --name dva-ch25-alerts --query TopicArn --output text)
# (Tuỳ chọn) subscribe email để nhận cảnh báo:
# aws sns subscribe --topic-arn $TOPIC_ARN --protocol email --notification-endpoint you@example.com

aws cloudwatch put-metric-alarm \
  --alarm-name app-errors-high \
  --namespace DVA/Ch25 --metric-name AppErrorCount \
  --statistic Sum --period 60 \
  --evaluation-periods 1 --datapoints-to-alarm 1 \
  --threshold 2 --comparison-operator GreaterThanOrEqualToThreshold \
  --treat-missing-data notBreaching \
  --alarm-actions $TOPIC_ARN
```

Alarm sẽ chuyển sang `ALARM` khi tổng số dòng ERROR trong 1 phút ≥ 2 và bắn message vào SNS. Kiểm tra trạng thái:

```bash
aws cloudwatch describe-alarms --alarm-names app-errors-high \
  --query 'MetricAlarms[0].StateValue' --output text
```

### Bước 4: CloudWatch Logs Insights — truy vấn log đã có

Logs Insights chạy được trên log đã tồn tại (khác metric filter). Query đếm số lỗi theo `userId`:

```bash
QID=$(aws logs start-query --log-group-name $LG \
  --start-time $(($(date +%s) - 3600)) --end-time $(date +%s) \
  --query-string 'fields @timestamp, @message | filter @message like /ERROR/ | parse @message "userId=*" as uid | stats count(*) as errors by uid | sort errors desc' \
  --query queryId --output text)

# start-query trả về queryId; phải poll get-query-results cho tới khi status = Complete
aws logs get-query-results --query-id $QID
```

Output mong đợi (sau khi `status` = `Complete`):

```json
{
  "results": [
    [ {"field": "uid", "value": "42"}, {"field": "errors", "value": "1"} ],
    [ {"field": "uid", "value": "99"}, {"field": "errors", "value": "1"} ]
  ],
  "status": "Complete"
}
```

> 💡 Logs Insights tính phí theo **lượng dữ liệu quét** (GB scanned), không theo số query — luôn thu hẹp khoảng thời gian và lọc sớm. Lệnh `stats`, `parse`, `filter`, `sort`, `fields`, `limit` là các command hay xuất hiện trong đề.

### Bước 5: Subscription filter — stream log realtime sang Lambda

Subscription filter đẩy log gần realtime ra Lambda / Kinesis Data Streams / Firehose. Ở đây dùng Lambda.

```bash
# 5a. Tạo execution role cho Lambda
cat > /tmp/trust.json <<'EOF'
{ "Version":"2012-10-17","Statement":[{"Effect":"Allow",
  "Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}
EOF
aws iam create-role --role-name dva-ch25-lambda --assume-role-policy-document file:///tmp/trust.json
aws iam attach-role-policy --role-name dva-ch25-lambda \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
sleep 10   # đợi IAM propagate

# 5b. Lambda nhận log: payload bị gzip + base64, phải giải nén
cat > /tmp/index.mjs <<'EOF'
import { gunzipSync } from 'zlib';
export const handler = async (event) => {
  const payload = Buffer.from(event.awslogs.data, 'base64');
  const decoded = JSON.parse(gunzipSync(payload).toString('utf8'));
  console.log('logGroup=%s events=%d', decoded.logGroup, decoded.logEvents.length);
  for (const e of decoded.logEvents) console.log('LINE:', e.message);
};
EOF
( cd /tmp && zip -q fn.zip index.mjs )

export FN_ARN=$(aws lambda create-function --function-name dva-ch25-logsink \
  --runtime nodejs20.x --handler index.handler \
  --role arn:aws:iam::$ACCOUNT_ID:role/dva-ch25-lambda \
  --zip-file fileb:///tmp/fn.zip --query FunctionArn --output text)

# 5c. CloudWatch Logs phải được PHÉP gọi Lambda (resource-based policy)
aws lambda add-permission --function-name dva-ch25-logsink \
  --statement-id logs-invoke --action lambda:InvokeFunction \
  --principal logs.$AWS_REGION.amazonaws.com \
  --source-arn "arn:aws:logs:$AWS_REGION:$ACCOUNT_ID:log-group:$LG:*"

# 5d. Tạo subscription filter — chỉ stream dòng ERROR
aws logs put-subscription-filter --log-group-name $LG \
  --filter-name errors-to-lambda --filter-pattern "ERROR" \
  --destination-arn $FN_ARN
```

Đẩy thêm một dòng ERROR rồi xem log của Lambda để xác nhận:

```bash
aws logs put-log-events --log-group-name $LG --log-stream-name app-1 \
  --log-events timestamp=$(($(date +%s)*1000)),message="ERROR payment failed userId=7"

sleep 8
aws logs tail /aws/lambda/dva-ch25-logsink --since 2m
```

> 💡 Mỗi log group chỉ gắn được tối đa **2 subscription filter**. Nếu cần fan-out nhiều consumer hơn, stream qua Kinesis Data Streams rồi cho nhiều consumer đọc. Để stream log **cross-account**, account đích phải tạo **destination** (logical ARN) kèm access policy cho account nguồn — không dùng resource policy trực tiếp như Lambda.

### Bước 6: EventBridge — scheduled rule (cron)

Tạo rule chạy theo lịch, target là SNS. Cron của EventBridge có 6 trường `(min hour day-of-month month day-of-week year)`:

```bash
# Cho phép EventBridge publish vào SNS topic (resource policy của SNS)
cat > /tmp/sns-policy.json <<EOF
{ "Version":"2012-10-17","Statement":[{
  "Sid":"AllowEventBridge","Effect":"Allow",
  "Principal":{"Service":"events.amazonaws.com"},
  "Action":"sns:Publish","Resource":"$TOPIC_ARN"}]}
EOF
aws sns set-topic-attributes --topic-arn $TOPIC_ARN \
  --attribute-name Policy --attribute-value file:///tmp/sns-policy.json

aws events put-rule --name dva-ch25-cron \
  --schedule-expression "cron(0/5 * * * ? *)" \
  --description "Chạy mỗi 5 phút"

aws events put-targets --rule dva-ch25-cron \
  --targets "Id=sns,Arn=$TOPIC_ARN"
```

> 💡 `cron(0/5 * * * ? *)` = mỗi 5 phút. Lưu ý ô day-of-month và day-of-week không được CÙNG là `*` — một trong hai phải là `?`. Schedule rule chỉ chạy được trên **default event bus**. Dùng `rate(5 minutes)` cho lịch đơn giản. (EventBridge Scheduler là dịch vụ riêng, mạnh hơn — nhận diện ở phạm vi này.)

### Bước 7: EventBridge — event pattern + input transformer

Rule bắt sự kiện EC2 thay đổi trạng thái sang `stopped`/`terminated`, biến đổi nội dung trước khi gửi SNS:

```bash
cat > /tmp/pattern.json <<'EOF'
{
  "source": ["aws.ec2"],
  "detail-type": ["EC2 Instance State-change Notification"],
  "detail": { "state": ["stopped", "terminated"] }
}
EOF
aws events put-rule --name dva-ch25-ec2state \
  --event-pattern file:///tmp/pattern.json

# Input transformer: ánh xạ field từ event vào một message gọn gàng
cat > /tmp/targets.json <<EOF
[{
  "Id": "sns",
  "Arn": "$TOPIC_ARN",
  "InputTransformer": {
    "InputPathsMap": { "id": "\$.detail.instance-id", "st": "\$.detail.state" },
    "InputTemplate": "\"Instance <id> chuyển sang trạng thai <st>\""
  }
}]
EOF
aws events put-targets --rule dva-ch25-ec2state --targets file:///tmp/targets.json
```

Test bằng cách bắn một event giả lên bus (không cần dựng EC2 thật):

```bash
aws events put-events --entries '[{
  "Source":"aws.ec2",
  "DetailType":"EC2 Instance State-change Notification",
  "Detail":"{\"instance-id\":\"i-0abc123\",\"state\":\"stopped\"}"
}]'
```

> Bẫy: `put-events` tự đặt event lên **default bus**; nhưng event do BẠN tự bắn có `source` bắt đầu bằng `aws.` thì EventBridge KHÔNG chặn (chỉ service AWS thật mới sinh được `account`/`region` chuẩn), nên dùng để test rule là chấp nhận được trong lab. Trong production, custom event nên đặt `source` riêng (vd `com.myapp.orders`).

### Bước 8: Archive & Replay

Bật archive trên default bus để lưu event và phát lại sau:

```bash
aws events create-archive --archive-name dva-ch25-archive \
  --event-source-arn "arn:aws:events:$AWS_REGION:$ACCOUNT_ID:event-bus/default" \
  --retention-days 7 \
  --event-pattern '{"source":["aws.ec2"]}'
```

Sau khi archive đã bắt được event (đợi vài phút rồi bắn lại `put-events` ở Bước 7), replay:

```bash
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
START=$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ)

aws events start-replay --replay-name dva-ch25-replay \
  --event-source-arn "arn:aws:events:$AWS_REGION:$ACCOUNT_ID:archive/dva-ch25-archive" \
  --event-start-time $START --event-end-time $NOW \
  --destination "Arn=arn:aws:events:$AWS_REGION:$ACCOUNT_ID:event-bus/default,FilterArns=arn:aws:events:$AWS_REGION:$ACCOUNT_ID:rule/dva-ch25-ec2state"
```

### Dọn dẹp tài nguyên

```bash
# EventBridge
aws events start-replay >/dev/null 2>&1 || true
aws events remove-targets --rule dva-ch25-cron --ids sns
aws events remove-targets --rule dva-ch25-ec2state --ids sns
aws events delete-rule --name dva-ch25-cron
aws events delete-rule --name dva-ch25-ec2state
aws events delete-archive --archive-name dva-ch25-archive

# CloudWatch alarm + Logs
aws cloudwatch delete-alarms --alarm-names app-errors-high
aws logs delete-subscription-filter --log-group-name $LG --filter-name errors-to-lambda
aws logs delete-metric-filter --log-group-name $LG --filter-name count-errors
aws logs delete-log-group --log-group-name $LG
aws logs delete-log-group --log-group-name /aws/lambda/dva-ch25-logsink

# Lambda + IAM + SNS
aws lambda delete-function --function-name dva-ch25-logsink
aws iam detach-role-policy --role-name dva-ch25-lambda \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam delete-role --role-name dva-ch25-lambda
aws sns delete-topic --topic-arn $TOPIC_ARN

rm -f /tmp/trust.json /tmp/index.mjs /tmp/fn.zip /tmp/*.json
```

Xác nhận `aws logs describe-log-groups --log-group-name-prefix /dva/ch25` trả về danh sách rỗng là đã dọn sạch. Replay và archive bị xoá sẽ không còn tính phí lưu trữ event.

## 💡 Exam Tips chương 25

- **Retention mặc định của log group là "Never expire"** — log lưu mãi và tính tiền vô thời hạn. Đề hay hỏi "tại sao chi phí Logs tăng dần" → chưa đặt retention policy. Giá trị retention là tập rời rạc (1/3/5/7/14/30/60/90/120/150/180/365/400/545/731/1827/3653 ngày), không có 45 ngày.
- **Metric filter chỉ áp dụng cho log MỚI** (không quét log cũ) và biến log thành CloudWatch metric → gắn alarm để cảnh báo theo pattern (vd đếm `ERROR`, đếm `404`). Cần truy vấn/phân tích log ĐÃ CÓ → dùng **Logs Insights**.
- Đặt `defaultValue=0` cho metric filter để metric vẫn publish khi không match, tránh alarm kẹt ở `INSUFFICIENT_DATA`; hoặc dùng `--treat-missing-data notBreaching` trên alarm.
- **Subscription filter**: stream log gần realtime tới **Lambda, Kinesis Data Streams, Kinesis Data Firehose**. Tối đa **2 subscription filter / log group**. Payload tới Lambda bị **gzip + base64** — phải giải nén. Cross-account cần tạo **destination** (logical resource) ở account đích, không dùng resource policy Lambda trực tiếp.
- **Logs Insights** tính phí theo GB dữ liệu **quét** — thu hẹp time range và filter sớm. Command hay thi: `fields`, `filter`, `parse`, `stats`, `sort`, `limit`, `display`.
- **Unified CloudWatch Agent** thay thế CloudWatch Logs Agent (legacy, đã deprecated): gửi cả **logs VÀ metrics** (gồm metric ở mức OS như RAM, disk — EC2 mặc định KHÔNG có metric RAM). Câu "cần memory utilization của EC2" → cài Unified Agent đẩy custom metric.
- EC2 muốn đẩy log/metric lên CloudWatch phải có **IAM role** với quyền `logs:PutLogEvents`, `logs:CreateLogStream`, `cloudwatch:PutMetricData` (managed policy `CloudWatchAgentServerPolicy`).
- **EventBridge schedule** dùng `cron(...)` (6 trường, có year) hoặc `rate(...)`; trong cron, day-of-month và day-of-week không cùng là `*` (một cái phải là `?`). Scheduled rule chỉ chạy trên **default event bus**.
- **Event bus**: `default` (nhận event từ service AWS), **custom bus** (cho ứng dụng của bạn), **partner bus** (SaaS như Datadog, Zendesk). Cross-account: gắn **resource-based policy** lên event bus đích cho phép account nguồn `events:PutEvents`.
- **Input transformation** (InputPathsMap + InputTemplate) biến đổi nội dung event trước khi gửi target. **Archive & Replay** lưu event và phát lại để debug/recover — feature riêng của EventBridge mà CloudWatch Events cũ và SNS/SQS không có. **Schema registry** tự suy schema event để sinh code binding.
- **EventBridge vs CloudWatch Events**: cùng API/cùng dịch vụ, EventBridge là tên mới và là superset (thêm custom/partner bus, schema registry, archive/replay, hơn 20 target). Câu hỏi mới luôn dùng "EventBridge".
- Phân biệt nhanh: cần **route/filter sự kiện theo nội dung tới nhiều target, có schedule, có replay** → EventBridge; cần **fan-out pub/sub độ trễ thấp tới nhiều subscriber** → SNS; cần **buffer/decouple, xử lý lại khi lỗi** → SQS (chi tiết ở Chương 21–22).

## Quiz chương 25 (10 câu)

**Câu 1.** A developer muốn nhận cảnh báo khi ứng dụng ghi ra hơn 5 dòng chứa `OutOfMemoryError` trong 5 phút vào CloudWatch Logs. Cách tốn ít công vận hành nhất?
- A. Lambda định kỳ gọi FilterLogEvents rồi tự gửi SNS
- B. Tạo metric filter trên log group cho pattern, rồi CloudWatch alarm bắn SNS
- C. Chạy Logs Insights query theo lịch và gửi email kết quả
- D. Bật subscription filter đẩy toàn bộ log sang Kinesis để phân tích

**Câu 2.** Sau khi tạo metric filter `ERROR`, developer thấy nó không đếm các lỗi đã ghi từ hôm qua. Vì sao?
- A. Metric filter cần bật detailed monitoring trước
- B. Metric filter chỉ áp dụng cho log events đẩy vào SAU khi tạo filter
- C. Pattern phải là `?ERROR` mới khớp
- D. Phải đặt retention dài hơn 1 ngày thì filter mới quét được

**Câu 3.** Công ty cần stream realtime log từ một log group sang một hệ thống phân tích bên thứ ba qua Kinesis Data Firehose, đồng thời vẫn cho phép một Lambda xử lý cùng log đó. Giải pháp đúng?
- A. Không thể — mỗi log group chỉ có 1 destination
- B. Tạo 2 subscription filter trên log group: một tới Firehose, một tới Lambda
- C. Export log ra S3 rồi cấu hình S3 event
- D. Dùng 2 metric filter trỏ tới Firehose và Lambda

**Câu 4.** A developer cần truy vấn ad-hoc trên hàng triệu dòng log đã có để tìm 10 request có latency cao nhất, mà không phải dựng hạ tầng. Dịch vụ phù hợp nhất?
- A. CloudWatch Metric Filter
- B. CloudWatch Logs Insights với `sort` và `limit`
- C. Athena query trực tiếp trên log group
- D. EventBridge rule với event pattern lọc latency

**Câu 5.** Chi phí CloudWatch Logs của một account tăng đều mỗi tháng dù lưu lượng log ổn định. Nguyên nhân khả dĩ nhất?
- A. Log group chưa đặt retention policy nên log lưu vô thời hạn
- B. Có quá nhiều log stream trong mỗi log group
- C. Detailed monitoring đang bật
- D. Subscription filter đang nhân đôi dữ liệu log

**Câu 6.** A developer cần chạy một Lambda dọn dẹp mỗi ngày lúc 18:00 UTC. Cấu hình nào đúng?
- A. EventBridge rule với `rate(1 day)` target là Lambda
- B. EventBridge rule với `cron(0 18 * * ? *)` target là Lambda
- C. CloudWatch alarm theo lịch gọi Lambda
- D. SQS delay queue 24 giờ trigger Lambda

**Câu 7.** Team muốn khi một order event được publish, ba hệ thống độc lập (inventory, billing, analytics) đều nhận và xử lý theo điều kiện riêng (chỉ event có `amount > 100`), đồng thời lưu lại event để phát lại khi cần debug. Chọn giải pháp ít vận hành nhất?
- A. SNS topic fan-out tới 3 SQS queue, mỗi consumer tự lọc
- B. EventBridge custom bus với 3 rule có event pattern lọc `amount`, target riêng, và bật archive & replay
- C. Kinesis Data Stream với 3 consumer dùng KCL
- D. SQS FIFO queue với 3 consumer group

**Câu 8.** Một EC2 instance cần đẩy custom log file `/var/log/app.log` lên CloudWatch Logs và đồng thời báo cáo memory utilization (RAM) — metric mà EC2 không cung cấp mặc định. Cách nào?
- A. Cài CloudWatch Logs Agent (legacy) cho log và bật detailed monitoring cho RAM
- B. Cài Unified CloudWatch Agent, gắn IAM role có CloudWatchAgentServerPolicy
- C. Dùng metric filter để suy ra RAM từ log
- D. Bật EC2 detailed monitoring (1 phút) để có metric RAM

**Câu 9.** Một Lambda gắn làm target của subscription filter nhận được `event.awslogs.data` nhưng không đọc được nội dung. Lý do?
- A. Payload là gzip + base64, phải giải nén trước khi parse JSON
- B. Lambda thiếu quyền logs:GetLogEvents
- C. Subscription filter chỉ gửi metadata, không gửi nội dung log
- D. Cần bật X-Ray để decode payload

**Câu 10.** Một công ty có account A (security) cần thu thập log từ account B và C vào một nơi tập trung qua subscription filter realtime. Thành phần bắt buộc ở phía account A?
- A. Một metric filter cross-account
- B. Một CloudWatch Logs **destination** với access policy cho phép account B, C
- C. Một bucket S3 với bucket policy
- D. VPC peering giữa các account

### Đáp án & giải thích

**Câu 1 — Đáp án B.** Metric filter biến pattern trong log thành metric, alarm theo dõi metric và bắn SNS — fully managed, không cần code. A sai: Lambda + FilterLogEvents là tự xây lại đúng thứ AWS đã có sẵn, tốn công vận hành và có độ trễ polling. C sai: Logs Insights không chạy theo lịch native và tính phí theo GB quét, không phải cơ chế alerting. D sai: đẩy toàn bộ log sang Kinesis để chỉ đếm một pattern là quá mức, vẫn phải tự viết logic cảnh báo.

**Câu 2 — Đáp án B.** Metric filter chỉ đánh giá các log event được ghi vào SAU khi filter tồn tại; nó không quét lại log lịch sử. Muốn phân tích log cũ phải dùng Logs Insights hoặc FilterLogEvents. A sai: detailed monitoring là khái niệm của CloudWatch metrics EC2, không liên quan metric filter. C sai: `ERROR` là term filter hợp lệ, khớp mọi dòng chứa ERROR; `?` chỉ là toán tử OR cho nhiều term. D sai: retention không quyết định filter quét log cũ hay không.

**Câu 3 — Đáp án B.** Mỗi log group hỗ trợ tối đa 2 subscription filter, đủ cho một tới Firehose và một tới Lambda chạy song song. A sai: giới hạn là 2 destination chứ không phải 1. C sai: export ra S3 là batch (không realtime) và thêm độ trễ. D sai: metric filter chỉ sinh metric, không stream nội dung log ra destination.

**Câu 4 — Đáp án B.** Logs Insights là công cụ truy vấn ad-hoc native trên CloudWatch Logs, dùng `sort by ... desc | limit 10` để lấy top-N, không cần hạ tầng. A sai: metric filter tạo metric đếm theo pattern, không truy vấn/sắp xếp được latency. C sai: Athena query trên S3, không query trực tiếp log group (phải export trước) — phức tạp hơn. D sai: EventBridge xử lý event realtime, không phải công cụ truy vấn log lịch sử.

**Câu 5 — Đáp án A.** Log group mặc định "Never expire"; không đặt retention thì log tích luỹ mãi và phí storage tăng đều — đây là nguyên nhân kinh điển. B sai: số lượng log stream gần như không ảnh hưởng chi phí (phí tính theo GB ingest + storage). C sai: detailed monitoring là phí metrics EC2, không phải Logs. D sai: subscription filter không lưu thêm bản sao trong cùng log group; nó stream ra ngoài.

**Câu 6 — Đáp án B.** `cron(0 18 * * ? *)` chạy 18:00 UTC mỗi ngày; lưu ý day-of-week để `?` vì day-of-month đã là `*`. A gần đúng về ý nhưng `rate(1 day)` chạy mỗi 24h kể từ lúc tạo rule, KHÔNG cố định đúng 18:00 — sai yêu cầu "lúc 18:00". C sai: CloudWatch alarm phản ứng theo metric/threshold, không có cơ chế chạy theo lịch. D sai: SQS delay tối đa 15 phút, không thể 24 giờ, và không phải scheduler.

**Câu 7 — Đáp án B.** EventBridge cho phép nhiều rule với event pattern lọc theo nội dung (`amount > 100` qua numeric matching), mỗi rule một target độc lập, và archive & replay để lưu/phát lại event — đúng toàn bộ yêu cầu, ít vận hành. A sai: SNS fan-out được nhưng không lọc theo nội dung phức tạp ở phía bus (filter policy hạn chế hơn) và KHÔNG có archive & replay. C sai: Kinesis + KCL phải tự quản consumer/checkpoint, vận hành nặng, không có replay theo pattern kiểu EventBridge. D sai: SQS FIFO không có pub/sub fan-out tới 3 hệ thống độc lập và không lọc nội dung.

**Câu 8 — Đáp án B.** Unified CloudWatch Agent gửi cả log file tuỳ chỉnh lẫn metric mức OS (RAM, disk) mà EC2 không có sẵn; instance cần IAM role với `CloudWatchAgentServerPolicy`. A sai: CloudWatch Logs Agent là legacy (deprecated), chỉ gửi log không gửi metric RAM; detailed monitoring cũng không cung cấp RAM. C sai: không thể "suy ra" RAM thật từ log. D sai: detailed monitoring chỉ tăng tần suất các metric SẴN CÓ (lên 1 phút), không thêm metric RAM (RAM nằm trong guest OS, hypervisor không thấy).

**Câu 9 — Đáp án A.** CloudWatch Logs gửi tới Lambda subscription target dưới dạng JSON đã gzip rồi base64-encode trong `event.awslogs.data`; phải `base64 decode` + `gunzip` rồi mới `JSON.parse`. B sai: Lambda được invoke bởi Logs, không cần GetLogEvents để đọc payload đã được đẩy vào. C sai: subscription filter gửi đầy đủ nội dung log event, không chỉ metadata. D sai: X-Ray là tracing, không liên quan giải mã payload.

**Câu 10 — Đáp án B.** Cross-account log subscription yêu cầu account đích (A) tạo một **CloudWatch Logs destination** (resource logical có ARN) gắn access policy cho phép account nguồn (B, C) `logs:PutSubscriptionFilter`; account nguồn trỏ subscription filter tới destination ARN này. A sai: metric filter không stream cross-account. C sai: S3 bucket là cơ chế export batch, không phải subscription realtime. D sai: subscription dùng IAM/resource policy, không cần VPC peering.

## Tóm tắt chương

- CloudWatch Logs tổ chức theo **log group → log stream**; retention mặc định là "Never expire" nên LUÔN đặt retention (tập giá trị rời rạc, không có 45 ngày) để tránh phí tích luỹ.
- **Metric filter** biến pattern trong log thành custom metric (chỉ áp dụng log MỚI) → gắn alarm để cảnh báo theo pattern; đặt `defaultValue=0` tránh alarm kẹt `INSUFFICIENT_DATA`.
- **CloudWatch Logs Insights** truy vấn ad-hoc trên log ĐÃ CÓ với cú pháp `fields/filter/parse/stats/sort/limit`; tính phí theo GB quét nên cần thu hẹp time range.
- **Subscription filter** stream log gần realtime tới Lambda / Kinesis Data Streams / Firehose; tối đa 2 filter/log group; payload tới Lambda là gzip+base64.
- Cross-account log streaming dùng **CloudWatch Logs destination** (ARN + access policy) ở account đích, không dùng resource policy Lambda trực tiếp.
- **Unified CloudWatch Agent** (thay Logs Agent legacy) gửi cả log lẫn metric mức OS như RAM/disk mà EC2 không có mặc định; EC2 cần IAM role `CloudWatchAgentServerPolicy`.
- **EventBridge** định tuyến event qua **rule** với event pattern (lọc theo nội dung) hoặc schedule (`cron`/`rate`); hơn 20 loại target; schedule chỉ chạy trên default bus.
- Ba loại event bus: **default** (service AWS), **custom** (ứng dụng của bạn), **partner** (SaaS); cross-account cần resource-based policy trên bus đích.
- **Input transformation** biến đổi event trước khi gửi target; **archive & replay** lưu và phát lại event để debug/recover; **schema registry** sinh code binding — các tính năng riêng của EventBridge.
- **EventBridge = CloudWatch Events** (cùng dịch vụ, cùng API) nhưng là superset; câu hỏi DVA mới luôn dùng tên "EventBridge".
- Quy tắc chọn nhanh: route/filter sự kiện theo nội dung + schedule + replay → **EventBridge**; pub/sub fan-out độ trễ thấp → **SNS**; buffer/decouple + retry → **SQS** (Chương 21–22).
- Alarm và metric nền tảng ở Chương 24; X-Ray tracing ở Chương 26; CloudTrail audit ở Chương 27.
