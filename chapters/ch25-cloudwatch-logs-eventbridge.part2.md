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
