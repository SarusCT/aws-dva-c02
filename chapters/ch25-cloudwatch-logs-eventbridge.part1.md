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
