## Hands-on Lab: Standard queue, DLQ, long polling, FIFO và ASG scaling theo queue depth

**Mục tiêu lab:** Đi hết vòng đời SQS từ góc developer: tạo standard queue + Dead Letter Queue (DLQ) với redrive policy, gửi/nhận/xoá message bằng CLI, quan sát visibility timeout và `ChangeMessageVisibility`, bật long polling, đẩy message "độc" vào DLQ rồi redrive ngược về, tạo FIFO queue với deduplication và message group ID, và cuối cùng tạo một CloudWatch alarm trên metric backlog-per-instance để ASG scale theo độ sâu hàng đợi (chỉ phần SQS + alarm; chi tiết ASG ở Chương 7).

**Chuẩn bị:**
- AWS CLI v2 đã cấu hình (Chương 3), IAM user/role có quyền `sqs:*`, `cloudwatch:PutMetricAlarm`.
- Region dùng trong lab: `us-east-1`. Lấy Account ID để dựng ARN:

```bash
export AWS_REGION=us-east-1
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "Account: $ACCOUNT_ID"
```

### Bước 1: Tạo Dead Letter Queue trước, rồi standard queue trỏ vào nó

DLQ phải tồn tại trước vì standard queue cần ARN của DLQ trong `RedrivePolicy`. Tạo DLQ trước:

```bash
# DLQ — không có gì đặc biệt, chỉ là một queue thường được dùng làm nơi chứa message lỗi
DLQ_URL=$(aws sqs create-queue \
  --queue-name orders-dlq \
  --query QueueUrl --output text)
echo "DLQ_URL=$DLQ_URL"

# Lấy ARN của DLQ (cần cho RedrivePolicy)
DLQ_ARN=$(aws sqs get-queue-attributes \
  --queue-url "$DLQ_URL" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' --output text)
echo "DLQ_ARN=$DLQ_ARN"
```

Output mong đợi: `DLQ_ARN=arn:aws:sqs:us-east-1:<account>:orders-dlq`.

Bây giờ tạo queue chính. Lưu ý `RedrivePolicy` là JSON-trong-JSON nên phải escape; `maxReceiveCount=3` nghĩa là sau 3 lần nhận (mà không xoá) message sẽ bị chuyển sang DLQ. Đặt luôn `VisibilityTimeout=30` và `ReceiveMessageWaitTimeSeconds=10` (bật long polling 10 giây):

```bash
Q_URL=$(aws sqs create-queue \
  --queue-name orders \
  --attributes "{
    \"VisibilityTimeout\":\"30\",
    \"ReceiveMessageWaitTimeSeconds\":\"10\",
    \"MessageRetentionPeriod\":\"345600\",
    \"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"3\\\"}\"
  }" \
  --query QueueUrl --output text)
echo "Q_URL=$Q_URL"
```

`MessageRetentionPeriod=345600` là 4 ngày (mặc định); tối đa là 1.209.600 giây (14 ngày). Kiểm tra lại attribute đã set đúng:

```bash
aws sqs get-queue-attributes --queue-url "$Q_URL" \
  --attribute-names All \
  --query 'Attributes.{Vis:VisibilityTimeout,Wait:ReceiveMessageWaitTimeSeconds,Redrive:RedrivePolicy}'
```

### Bước 2: Gửi message và quan sát long polling

Gửi vài message. Với standard queue, `MessageBody` tối đa 256 KB; có thể đính kèm `MessageAttributes` (metadata không nằm trong body):

```bash
aws sqs send-message --queue-url "$Q_URL" \
  --message-body '{"orderId":"1001","amount":250}' \
  --message-attributes '{"Type":{"DataType":"String","StringValue":"NEW"}}'

# Gửi hàng loạt 3 message trong 1 call (giảm số request, rẻ hơn)
aws sqs send-message-batch --queue-url "$Q_URL" --entries '[
  {"Id":"m1","MessageBody":"{\"orderId\":\"1002\"}"},
  {"Id":"m2","MessageBody":"{\"orderId\":\"1003\"}"},
  {"Id":"m3","MessageBody":"{\"orderId\":\"1004\"}"}
]'
```

`send-message-batch` gửi tối đa 10 message/call, tổng payload ≤ 256 KB. Nhận message với long polling (`--wait-time-seconds 10`): nếu queue trống call sẽ chờ tối đa 10 giây thay vì trả về rỗng ngay — giảm số empty receive và tiết kiệm tiền:

```bash
aws sqs receive-message --queue-url "$Q_URL" \
  --max-number-of-messages 5 \
  --wait-time-seconds 10 \
  --attribute-names ApproximateReceiveCount \
  --message-attribute-names All
```

Output trả về `Messages[]`, mỗi message có `ReceiptHandle` (token để xoá/đổi visibility, KHÁC với `MessageId`) và attribute `ApproximateReceiveCount` cho biết message đã được nhận bao nhiêu lần. Trong khoảng 30 giây visibility timeout, message này "ẩn" với consumer khác.

> Lưu ý: `MessageId` cố định suốt vòng đời message; `ReceiptHandle` thay đổi mỗi lần nhận. Luôn dùng `ReceiptHandle` mới nhất khi xoá hoặc gọi `ChangeMessageVisibility`.

### Bước 3: Visibility timeout và ChangeMessageVisibility

Lưu một `ReceiptHandle` rồi xử lý mô phỏng lâu hơn dự kiến — kéo dài visibility để tránh message bị nhả lại cho consumer khác giữa chừng:

```bash
RH=$(aws sqs receive-message --queue-url "$Q_URL" --wait-time-seconds 5 \
  --query 'Messages[0].ReceiptHandle' --output text)

# Heartbeat: gia hạn thêm 60 giây vì xử lý chưa xong
aws sqs change-message-visibility --queue-url "$Q_URL" \
  --receipt-handle "$RH" --visibility-timeout 60

# Xử lý xong → xoá message để nó không quay lại queue
aws sqs delete-message --queue-url "$Q_URL" --receipt-handle "$RH"
```

Nếu KHÔNG xoá và visibility timeout hết, message tái xuất hiện và `ApproximateReceiveCount` tăng. Đây chính là cơ chế dẫn tới DLQ ở bước sau.

### Bước 4: Đẩy message "độc" vào DLQ rồi redrive về

Gửi 1 "poison message" và cố tình nhận nó 3 lần mà không xoá (mỗi lần phải đợi visibility hết để nhận lại). Để nhanh, hạ visibility xuống 0 cho lần test này bằng `ChangeMessageVisibility` ngay sau khi nhận:

```bash
aws sqs send-message --queue-url "$Q_URL" \
  --message-body '{"orderId":"BAD","corrupt":true}'

for i in 1 2 3; do
  RH=$(aws sqs receive-message --queue-url "$Q_URL" --wait-time-seconds 5 \
    --query 'Messages[0].ReceiptHandle' --output text)
  echo "Nhận lần $i, không xoá..."
  # Nhả ngay lập tức để nhận lại nhanh (set visibility = 0)
  aws sqs change-message-visibility --queue-url "$Q_URL" \
    --receipt-handle "$RH" --visibility-timeout 0
done
```

Sau lần nhận thứ 3 (vượt `maxReceiveCount=3`), SQS tự chuyển message sang DLQ. Kiểm tra DLQ có message:

```bash
aws sqs get-queue-attributes --queue-url "$DLQ_URL" \
  --attribute-names ApproximateNumberOfMessages
```

Thấy `ApproximateNumberOfMessages: "1"`. Sau khi sửa bug consumer, redrive (di chuyển message từ DLQ về queue gốc) bằng `start-message-move-task`:

```bash
TASK=$(aws sqs start-message-move-task \
  --source-arn "$DLQ_ARN" \
  --query TaskHandle --output text)

aws sqs list-message-move-tasks --source-arn "$DLQ_ARN" \
  --query 'Results[].{Status:Status,Moved:ApproximateNumberOfMessagesMoved}'
```

Output cho thấy task `RUNNING`/`COMPLETED` và số message đã di chuyển. Đây là "redrive to source" mà DVA-C02 hay hỏi — trước đây phải tự viết script, giờ là API/console native.

### Bước 5: Tạo FIFO queue với deduplication và message group ID

FIFO queue bắt buộc tên kết thúc bằng `.fifo`. Bật `ContentBasedDeduplication` để SQS tự hash body làm dedup ID (5 phút dedup window):

```bash
FIFO_URL=$(aws sqs create-queue \
  --queue-name orders.fifo \
  --attributes '{
    "FifoQueue":"true",
    "ContentBasedDeduplication":"true",
    "VisibilityTimeout":"30"
  }' \
  --query QueueUrl --output text)

# Gửi 2 message khác group → xử lý song song; cùng group → giữ thứ tự
aws sqs send-message --queue-url "$FIFO_URL" \
  --message-body '{"orderId":"A1"}' --message-group-id customer-A
aws sqs send-message --queue-url "$FIFO_URL" \
  --message-body '{"orderId":"B1"}' --message-group-id customer-B

# Gửi đúp body giống hệt trong 5 phút → bị dedup, chỉ 1 message vào queue
aws sqs send-message --queue-url "$FIFO_URL" \
  --message-body '{"orderId":"A1"}' --message-group-id customer-A
```

Nhận và xác nhận thứ tự + dedup:

```bash
aws sqs receive-message --queue-url "$FIFO_URL" \
  --max-number-of-messages 10 --wait-time-seconds 5 \
  --attribute-names MessageGroupId MessageDeduplicationId \
  --query 'Messages[].Body'
```

Bạn chỉ thấy `A1` một lần (lần gửi thứ 3 bị dedup) và `B1`. Message cùng `message-group-id` luôn được trả về theo đúng thứ tự gửi; khác group có thể xen kẽ. Nếu cần `ContentBasedDeduplication=false`, bạn phải tự truyền `--message-deduplication-id`.

### Bước 6: CloudWatch alarm cho ASG scale theo queue depth

Cách scale ASG đúng theo SQS không phải dựa thẳng vào `ApproximateNumberOfMessagesVisible`, mà dựa vào **backlog per instance** = số message chờ / số instance đang chạy, so với "acceptable backlog" (số message 1 instance xử lý kịp trong latency mục tiêu). Trong production bạn dùng một custom metric math; ở lab này ta tạo alarm đơn giản trên metric gốc để minh hoạ trigger:

```bash
aws cloudwatch put-metric-alarm \
  --alarm-name orders-backlog-high \
  --namespace AWS/SQS \
  --metric-name ApproximateNumberOfMessagesVisible \
  --dimensions Name=QueueName,Value=orders \
  --statistic Average --period 60 \
  --evaluation-periods 1 --threshold 100 \
  --comparison-operator GreaterThanThreshold \
  --treat-missing-data notBreaching
```

Trong thực tế, gắn `--alarm-actions <ASG scaling policy ARN>` để alarm này kích hoạt target-tracking/step scaling. Đọc kỹ phần backlog-per-instance ở Chương 7 — đề thi hay gài đáp án "scale theo CPU" (SAI vì consumer poll-based thường CPU thấp dù backlog cao).

### Dọn dẹp tài nguyên

```bash
aws cloudwatch delete-alarms --alarm-names orders-backlog-high
aws sqs delete-queue --queue-url "$Q_URL"
aws sqs delete-queue --queue-url "$DLQ_URL"
aws sqs delete-queue --queue-url "$FIFO_URL"
```

> Lưu ý: sau khi `delete-queue`, tên queue đó không tạo lại được trong ~60 giây. Nếu có message move task đang `RUNNING`, dừng nó bằng `aws sqs cancel-message-move-task --task-handle "$TASK"` trước khi xoá DLQ.

## 💡 Exam Tips chương 21

- **Visibility timeout mặc định 30 giây, max 12 giờ.** Nếu consumer xử lý lâu hơn timeout → message tái xuất hiện và bị xử lý 2 lần (duplicate). Khắc phục: tăng visibility timeout HOẶC gọi `ChangeMessageVisibility` định kỳ (heartbeat). Đáp án "tăng retention period" để fix duplicate là bẫy SAI.
- **Long polling (`ReceiveMessageWaitTimeSeconds` 1–20 giây) gần như luôn là đáp án đúng** khi câu hỏi nói "giảm số empty receive / giảm chi phí API / giảm latency rỗng". Short polling (giá trị 0) lấy mẫu một tập subset server nên có thể trả rỗng dù queue có message.
- **DLQ + `maxReceiveCount`:** message vào DLQ sau khi bị nhận quá `maxReceiveCount` lần mà không bị xoá — KHÔNG phải khi consumer "báo lỗi". DLQ của standard queue phải là standard; DLQ của FIFO phải là FIFO.
- **Message size tối đa 256 KB.** Payload lớn hơn → dùng SQS Extended Client Library: body thật lưu ở S3, message chỉ chứa con trỏ S3. Đây là đáp án kinh điển cho "gửi payload 1 MB qua SQS".
- **FIFO: ordering theo `MessageGroupId`**, dedup theo `MessageDeduplicationId` trong cửa sổ 5 phút. `ContentBasedDeduplication` tự hash body. Throughput FIFO mặc định 300 msg/s (3.000 với batch); high-throughput mode lên tới 70.000+ msg/s.
- **Standard vs FIFO:** standard = at-least-once + best-effort ordering + throughput gần như không giới hạn. FIFO = exactly-once processing + ordering chặt nhưng throughput giới hạn. Chọn FIFO chỉ khi thật sự cần thứ tự / chống trùng.
- **Delay queue vs message timer:** delay queue áp cho MỌI message (set `DelaySeconds` ở queue level), message timer áp cho TỪNG message khi gửi. Cả hai max 900 giây (15 phút).
- **Scale ASG theo queue:** dùng backlog-per-instance, KHÔNG dùng CPU. CPU của consumer poll-based thường thấp; đáp án "scale theo CPUUtilization" là bẫy.
- **SQS không "push" tới consumer** — consumer phải poll. Nếu cần push/fan-out tới nhiều subscriber → SNS hoặc EventBridge (Chương 22). SQS có thể là target của SNS (fan-out SNS→SQS).
- **Encryption SSE-SQS (mặc định, AWS managed key) hay SSE-KMS.** Với KMS, IAM của producer/consumer cần thêm quyền `kms:GenerateDataKey` và `kms:Decrypt`; `KmsDataKeyReusePeriodSeconds` (1 phút–24 giờ) giảm số lần gọi KMS.
- **Retention period 1 phút–14 ngày (mặc định 4 ngày).** Message quá hạn bị xoá tự động. Tăng retention KHÔNG fix lỗi xử lý — chỉ cho consumer thêm thời gian lấy message.
- **Lambda + SQS dùng event source mapping** (Lambda poll thay bạn); với standard queue có partial batch response (`ReportBatchItemFailures`). Chi tiết ở Chương 30 — đừng nhầm là "SQS gọi Lambda trực tiếp".

## Quiz chương 21 (10 câu)

**Câu 1.** Một consumer xử lý mỗi message mất ~45 giây, nhưng nhiều message đang bị xử lý hai lần. Visibility timeout đang để mặc định. Cách khắc phục TỐT NHẤT?
- A. Tăng `MessageRetentionPeriod` lên 14 ngày
- B. Tăng visibility timeout lên giá trị lớn hơn thời gian xử lý (ví dụ 90 giây) hoặc gọi `ChangeMessageVisibility` heartbeat
- C. Chuyển sang FIFO queue
- D. Bật long polling

**Câu 2.** Developer muốn giảm chi phí ReceiveMessage và tránh response rỗng khi queue thường trống. Nên làm gì?
- A. Đặt `ReceiveMessageWaitTimeSeconds` = 20
- B. Đặt `ReceiveMessageWaitTimeSeconds` = 0
- C. Tăng `MaxNumberOfMessages` lên 100
- D. Giảm visibility timeout về 0

**Câu 3.** Hệ thống cần gửi message JSON kích thước 800 KB qua SQS. Giải pháp đúng?
- A. Nén message xuống dưới 256 KB là bắt buộc, không có cách khác
- B. Dùng SQS Extended Client Library: lưu payload ở S3, message chứa con trỏ
- C. Chia thành 4 message rồi tự ghép lại ở consumer
- D. Dùng FIFO queue vì FIFO cho phép message tới 2 MB

**Câu 4.** Một message lỗi cứ được nhận lặp đi lặp lại và làm tắc consumer. Cấu hình nào tự động cô lập nó?
- A. Delay queue với `DelaySeconds` = 900
- B. Tăng visibility timeout lên 12 giờ
- C. Cấu hình redrive policy trỏ tới một DLQ với `maxReceiveCount` hợp lý
- D. Bật `ContentBasedDeduplication`

**Câu 5.** Ứng dụng thanh toán yêu cầu các giao dịch của CÙNG một tài khoản được xử lý đúng thứ tự, nhưng tài khoản khác nhau có thể xử lý song song. Lựa chọn nào phù hợp?
- A. Standard queue, dùng timestamp để sắp xếp ở consumer
- B. FIFO queue với `MessageGroupId` = accountId
- C. FIFO queue với tất cả message cùng một `MessageGroupId`
- D. Standard queue với `ContentBasedDeduplication`

**Câu 6.** ASG chạy consumer SQS. Backlog tăng vọt vào giờ cao điểm nhưng ASG không scale out vì CPU thấp. Sửa thế nào?
- A. Đổi instance type lớn hơn
- B. Tạo target-tracking/step scaling dựa trên metric backlog-per-instance từ SQS thay vì CPU
- C. Đặt min capacity = max capacity
- D. Bật detailed monitoring cho EC2

**Câu 7.** Developer gọi `DeleteMessage` nhưng nhận lỗi `ReceiptHandleIsInvalid`. Nguyên nhân thường gặp nhất?
- A. Queue đã bị mã hoá KMS
- B. Dùng `MessageId` thay vì `ReceiptHandle`, hoặc dùng `ReceiptHandle` cũ sau khi message đã tái xuất hiện
- C. Visibility timeout quá lớn
- D. Long polling chưa được bật

**Câu 8.** Queue SQS được mã hoá SSE-KMS. Consumer chạy trên EC2 báo `AccessDenied` khi `ReceiveMessage`. IAM role của consumer cần thêm quyền nào?
- A. `s3:GetObject`
- B. `kms:Decrypt` (và producer cần `kms:GenerateDataKey`)
- C. `sqs:CreateQueue`
- D. `kms:CreateGrant` cho consumer

**Câu 9.** Một message cần được trì hoãn 10 phút trước khi consumer có thể nhận, chỉ riêng message đó. Cách đúng?
- A. Đặt `DelaySeconds` = 600 ở cấp queue
- B. Đặt `DelaySeconds` = 600 trong call `SendMessage` của riêng message đó (message timer)
- C. Tăng visibility timeout lên 600 giây
- D. Dùng `ChangeMessageVisibility` = 600 ngay sau khi gửi

**Câu 10.** Nhóm cần fan-out: một sự kiện "order placed" phải được xử lý bởi 3 dịch vụ độc lập (kho, email, analytics), mỗi dịch vụ có queue riêng và tốc độ xử lý riêng. Kiến trúc tốt nhất?
- A. Một SQS queue duy nhất, cả 3 dịch vụ cùng poll
- B. SNS topic, mỗi dịch vụ subscribe bằng một SQS queue riêng (fan-out SNS→SQS)
- C. FIFO queue với 3 message group ID
- D. Kinesis Data Stream với 3 shard

### Đáp án & giải thích

**Câu 1 — Đáp án B.** Duplicate xảy ra vì xử lý (45s) dài hơn visibility timeout mặc định (30s): message tái xuất hiện và bị consumer khác lấy. Tăng visibility timeout hoặc heartbeat bằng `ChangeMessageVisibility` giải quyết gốc rễ. A (retention) chỉ ảnh hưởng thời gian message tồn tại, không liên quan duplicate. C (FIFO) cho exactly-once nhưng là thay đổi lớn không cần thiết và giảm throughput. D (long polling) chỉ ảnh hưởng cách poll, không sửa duplicate.

**Câu 2 — Đáp án A.** Long polling (wait time 1–20s, ở đây 20) khiến SQS chờ tới khi có message hoặc hết thời gian, giảm empty receive và chi phí. B (=0) là short polling — đúng cái gây ra empty response. C tăng số message/call nhưng vẫn short polling nếu wait time 0. D set visibility 0 gây xử lý trùng, không liên quan chi phí poll.

**Câu 3 — Đáp án B.** Giới hạn cứng 256 KB; payload lớn dùng Extended Client Library lưu body ở S3, message chỉ giữ con trỏ — consumer tự fetch từ S3. A sai vì có giải pháp. C tự ghép thủ công mất ordering/độ phức tạp và không phải pattern AWS khuyến nghị. D sai: FIFO cũng giới hạn 256 KB, không có chuyện 2 MB.

**Câu 4 — Đáp án C.** Redrive policy + DLQ với `maxReceiveCount` tự chuyển message lỗi sang DLQ sau số lần nhận vượt ngưỡng, gỡ tắc consumer và giữ message để điều tra. A (delay) chỉ trì hoãn, message vẫn quay lại. B (visibility 12h) chỉ giấu lâu hơn rồi vẫn lặp. D (dedup) là tính năng FIFO chống trùng khi gửi, không liên quan message lỗi.

**Câu 5 — Đáp án B.** FIFO đảm bảo thứ tự trong cùng `MessageGroupId`; đặt group = accountId giữ thứ tự per-account mà vẫn cho phép các account khác xử lý song song. A (standard + sort) không đảm bảo ordering thật. C (cùng 1 group) ép toàn bộ tuần tự, giết throughput. D standard không có ordering.

**Câu 6 — Đáp án B.** Consumer poll-based thường CPU thấp dù backlog lớn, nên scale theo CPU thất bại. Đúng là scale theo backlog-per-instance (số message chờ / số instance) so với acceptable backlog. A/D không giải quyết scale ngang. C tắt khả năng co giãn, lãng phí khi rảnh.

**Câu 7 — Đáp án B.** `DeleteMessage`/`ChangeMessageVisibility` yêu cầu `ReceiptHandle` của lần nhận gần nhất, KHÔNG phải `MessageId`. Receipt handle cũ trở nên vô hiệu sau khi message tái xuất hiện (nhận lại). A/C/D không gây lỗi `ReceiptHandleIsInvalid`.

**Câu 8 — Đáp án B.** Với SSE-KMS, consumer cần `kms:Decrypt` để giải mã data key khi nhận; producer cần `kms:GenerateDataKey`. A là quyền S3 không liên quan. C `CreateQueue` không phải quyền nhận message. D `CreateGrant` không cần thiết cho luồng đọc cơ bản và cấp dư thừa.

**Câu 9 — Đáp án B.** Trì hoãn riêng một message dùng message timer: truyền `DelaySeconds` trong `SendMessage` (max 900s). A áp delay cho mọi message (delay queue). C/D dùng visibility timeout — chỉ áp dụng SAU khi message được nhận, không trì hoãn lần xuất hiện đầu tiên.

**Câu 10 — Đáp án B.** Fan-out chuẩn: SNS topic phát một lần, mỗi dịch vụ có SQS queue riêng subscribe topic — mỗi queue buffer độc lập, tốc độ xử lý riêng, retry/DLQ riêng. A: nhiều consumer cùng poll một queue → mỗi message chỉ 1 consumer lấy được, KHÔNG fan-out. C: FIFO group không nhân bản message tới nhiều consumer. D: Kinesis dùng được nhưng nặng và đắt hơn cho use case event fan-out đơn giản; chi tiết so sánh ở Chương 22–23.

## Tóm tắt chương

- **SQS là hàng đợi pull-based** để decouple producer–consumer: producer gửi không cần biết consumer, consumer poll khi sẵn sàng, giúp chịu tải đột biến và chịu lỗi tốt hơn.
- **Standard queue:** throughput gần như không giới hạn, at-least-once delivery (có thể trùng), best-effort ordering. **FIFO queue:** exactly-once, ordering chặt theo `MessageGroupId`, throughput giới hạn (300/3.000 msg/s, high-throughput mode cao hơn).
- **Visibility timeout** (mặc định 30s, max 12h) ẩn message sau khi nhận; xử lý lâu hơn timeout gây xử lý trùng — fix bằng tăng timeout hoặc `ChangeMessageVisibility` heartbeat. Luôn xoá message bằng `ReceiptHandle` mới nhất.
- **Long polling** (`ReceiveMessageWaitTimeSeconds` 1–20s) giảm empty receive và chi phí so với short polling (=0); gần như luôn là đáp án đúng khi đề nói tối ưu poll.
- **DLQ + redrive policy** (`maxReceiveCount`) tự cô lập message lỗi sau số lần nhận vượt ngưỡng; redrive ngược về source bằng `start-message-move-task`. DLQ phải cùng loại (standard/FIFO) với queue gốc.
- **Message size tối đa 256 KB**; payload lớn hơn dùng SQS Extended Client Library (body ở S3, message chứa con trỏ).
- **Delay queue** (cấp queue) vs **message timer** (cấp từng message): cả hai max 900 giây.
- **Retention period** 1 phút–14 ngày (mặc định 4 ngày); tăng retention KHÔNG sửa lỗi xử lý.
- **FIFO dedup** theo `MessageDeduplicationId` trong cửa sổ 5 phút; `ContentBasedDeduplication` tự hash body. Ordering chỉ trong cùng message group.
- **Scale ASG theo backlog-per-instance**, không theo CPU (consumer poll-based CPU thường thấp).
- **Encryption SSE-SQS (mặc định) hoặc SSE-KMS**; với KMS, producer cần `kms:GenerateDataKey`, consumer cần `kms:Decrypt`; `KmsDataKeyReusePeriodSeconds` giảm số call KMS.
- **Fan-out không phải việc của một SQS queue** — dùng SNS→SQS để nhiều dịch vụ nhận cùng sự kiện qua queue riêng (Chương 22); Lambda tiêu thụ SQS qua event source mapping (Chương 30).
