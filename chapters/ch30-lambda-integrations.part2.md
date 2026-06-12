## Hands-on Lab: Pipeline S3 → Lambda → DynamoDB + Event Source Mapping SQS với partial batch response

**Mục tiêu lab:** Dựng một pipeline xử lý sự kiện hoàn chỉnh và đụng vào đúng những điểm DVA-C02 hay hỏi về integration & event source mapping (ESM):

1. **Async invocation** S3 → Lambda với Lambda destinations (on-success/on-failure) thay cho DLQ.
2. **Event source mapping SQS → Lambda** với batch size, batch window và **partial batch response** (`ReportBatchItemFailures`).
3. Lambda ghi item vào **DynamoDB** với **idempotency** bằng conditional write.
4. Quan sát retry, throttling và cách message lỗi đi vào on-failure destination.

**Chuẩn bị:**
- AWS CLI v2 (Chương 3), Node.js 20+. IAM có quyền tạo Lambda/SQS/S3/DynamoDB/IAM role.
- Region: `us-east-1`. Lấy Account ID:

```bash
export AWS_REGION=us-east-1
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export BUCKET=ch30-ingest-$ACCOUNT_ID
echo "Account=$ACCOUNT_ID Bucket=$BUCKET"
```

### Bước 1: Tạo execution role và các tài nguyên nền

```bash
# Trust policy cho Lambda
cat > trust.json <<'EOF'
{ "Version":"2012-10-17","Statement":[{"Effect":"Allow",
  "Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}
EOF

aws iam create-role --role-name ch30-lambda-role \
  --assume-role-policy-document file://trust.json

# Quyền: logs + DynamoDB + SQS (cho ESM) + gửi destination tới SQS
aws iam attach-role-policy --role-name ch30-lambda-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam attach-role-policy --role-name ch30-lambda-role \
  --policy-arn arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess
aws iam attach-role-policy --role-name ch30-lambda-role \
  --policy-arn arn:aws:iam::aws:policy/AmazonSQSFullAccess

export ROLE_ARN=$(aws iam get-role --role-name ch30-lambda-role \
  --query 'Role.Arn' --output text)
```

> Trong production dùng least-privilege (chỉ `dynamodb:PutItem` trên ARN bảng cụ thể). Ở đây dùng managed policy cho gọn lab.

Tạo bảng DynamoDB, bucket S3, SQS queue chính + DLQ, và 2 queue làm Lambda destination:

```bash
aws dynamodb create-table --table-name ch30-orders \
  --attribute-definitions AttributeName=orderId,AttributeType=S \
  --key-schema AttributeName=orderId,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST

aws s3 mb s3://$BUCKET

# Queue cho ESM + DLQ của queue (redrive ở queue level, KHÔNG ở Lambda)
DLQ_ARN=$(aws sqs create-queue --queue-name ch30-jobs-dlq \
  --query QueueUrl --output text | xargs -I{} aws sqs get-queue-attributes \
  --queue-url {} --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

JOBS_URL=$(aws sqs create-queue --queue-name ch30-jobs \
  --attributes "{\"VisibilityTimeout\":\"60\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"3\\\"}\"}" \
  --query QueueUrl --output text)
JOBS_ARN=$(aws sqs get-queue-attributes --queue-url "$JOBS_URL" \
  --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

# Destination queue cho async S3->Lambda (on-success / on-failure)
SUCCESS_URL=$(aws sqs create-queue --queue-name ch30-onsuccess --query QueueUrl --output text)
FAILURE_URL=$(aws sqs create-queue --queue-name ch30-onfailure --query QueueUrl --output text)
SUCCESS_ARN=$(aws sqs get-queue-attributes --queue-url "$SUCCESS_URL" --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)
FAILURE_ARN=$(aws sqs get-queue-attributes --queue-url "$FAILURE_URL" --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)
```

> **Điểm thi quan trọng:** với event source mapping SQS, DLQ được đặt ở **queue** (redrive policy của chính queue), KHÔNG cấu hình ở Lambda. Lambda destinations (on-success/on-failure) CHỈ áp dụng cho **async invocation** (S3/SNS/EventBridge), không áp cho ESM của SQS.

### Bước 2: Viết và deploy hàm Lambda

Hàm này nhận cả 2 loại event: object key từ S3 (async) và batch record từ SQS (ESM). Phân biệt bằng cấu trúc event:

```javascript
// index.mjs — Node.js 20, AWS SDK v3 (có sẵn trong runtime)
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = "ch30-orders";

async function saveIdempotent(order) {
  // Conditional write: chỉ ghi nếu orderId chưa tồn tại -> chống xử lý trùng
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: order,
    ConditionExpression: "attribute_not_exists(orderId)"
  }));
}

export const handler = async (event) => {
  // --- Trường hợp ESM SQS: event.Records có eventSource = aws:sqs ---
  if (event.Records && event.Records[0]?.eventSource === "aws:sqs") {
    const batchItemFailures = [];
    for (const record of event.Records) {
      try {
        const order = JSON.parse(record.body);
        if (order.poison) throw new Error("poison message");
        await saveIdempotent(order);
      } catch (err) {
        if (err.name === "ConditionalCheckFailedException") {
          // Đã ghi rồi -> coi như thành công (idempotent), KHÔNG báo lỗi
          continue;
        }
        // Báo riêng message này lỗi -> chỉ nó bị retry (partial batch response)
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  }

  // --- Trường hợp async S3: event.Records có s3 ---
  if (event.Records && event.Records[0]?.s3) {
    const key = decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, " "));
    if (key.includes("fail")) throw new Error("Cố tình lỗi để test on-failure destination");
    await saveIdempotent({ orderId: key, source: "s3", ts: Date.now() });
    return { ok: true, key };
  }

  throw new Error("Unknown event");
};
```

Đóng gói và tạo function:

```bash
zip function.zip index.mjs
FN_ARN=$(aws lambda create-function --function-name ch30-handler \
  --runtime nodejs20.x --handler index.handler \
  --role "$ROLE_ARN" --zip-file fileb://function.zip \
  --timeout 30 --memory-size 256 \
  --query 'FunctionArn' --output text)
```

### Bước 3: Cấu hình async destinations (on-success / on-failure)

```bash
aws lambda put-function-event-invoke-config \
  --function-name ch30-handler \
  --maximum-retry-attempts 1 \
  --maximum-event-age-in-seconds 3600 \
  --destination-config "{
    \"OnSuccess\":{\"Destination\":\"$SUCCESS_ARN\"},
    \"OnFailure\":{\"Destination\":\"$FAILURE_ARN\"}
  }"
```

`maximum-retry-attempts` cho async là 0–2 (mặc định 2). Sau khi hết retry mà vẫn lỗi → event (kèm response/error) được gửi tới on-failure destination. `maximum-event-age-in-seconds` (60–21600) là tuổi tối đa event nằm trong internal queue trước khi bị drop.

### Bước 4: Nối S3 → Lambda (async) và kiểm thử destination

```bash
# Cho phép S3 invoke Lambda (resource-based policy)
aws lambda add-permission --function-name ch30-handler \
  --statement-id s3invoke --action lambda:InvokeFunction \
  --principal s3.amazonaws.com \
  --source-arn arn:aws:s3:::$BUCKET --source-account $ACCOUNT_ID

aws s3api put-bucket-notification-configuration --bucket $BUCKET \
  --notification-configuration "{
    \"LambdaFunctionConfigurations\":[{
      \"LambdaFunctionArn\":\"$FN_ARN\",
      \"Events\":[\"s3:ObjectCreated:*\"]
    }]}"

# Upload object thành công và object lỗi (key chứa 'fail')
echo "{}" > ok.json && echo "{}" > order-fail.json
aws s3 cp ok.json s3://$BUCKET/order-1001.json
aws s3 cp order-fail.json s3://$BUCKET/order-fail.json
```

Đợi ~30 giây rồi kiểm tra: object lỗi sau khi retry hết sẽ vào on-failure queue:

```bash
aws sqs receive-message --queue-url "$FAILURE_URL" --wait-time-seconds 10 \
  --query 'Messages[0].Body' --output text
```

Output là một JSON chứa `requestPayload` (event S3 gốc), `responseContext` và `responsePayload` (error). Đây là điểm mạnh của destinations so với DLQ: **DLQ chỉ giữ event gốc**, còn destination giữ thêm **context lỗi** (request + response). Kiểm tra DynamoDB đã có item của object thành công:

```bash
aws dynamodb get-item --table-name ch30-orders \
  --key '{"orderId":{"S":"order-1001.json"}}' --query 'Item.orderId.S'
```

### Bước 5: Event source mapping SQS → Lambda với partial batch response

```bash
ESM_UUID=$(aws lambda create-event-source-mapping \
  --function-name ch30-handler \
  --event-source-arn "$JOBS_ARN" \
  --batch-size 10 \
  --maximum-batching-window-in-seconds 5 \
  --function-response-types ReportBatchItemFailures \
  --scaling-config '{"MaximumConcurrency":5}' \
  --query 'UUID' --output text)

aws lambda get-event-source-mapping --uuid "$ESM_UUID" \
  --query '{State:State,Batch:BatchSize,Window:MaximumBatchingWindowInSeconds}'
```

`--function-response-types ReportBatchItemFailures` BẮT BUỘC để Lambda tôn trọng `batchItemFailures` trả về. Thiếu cờ này, dù code trả về danh sách lỗi thì **cả batch** vẫn bị coi là thành công hoặc thất bại theo kiểu all-or-nothing. `MaximumConcurrency` (2–1000) giới hạn số Lambda concurrent mà ESM SQS spawn — khác `--scaling-config` này với reserved concurrency của function.

Gửi 1 batch gồm message tốt + 1 poison message:

```bash
aws sqs send-message-batch --queue-url "$JOBS_URL" --entries '[
  {"Id":"a","MessageBody":"{\"orderId\":\"J-1\"}"},
  {"Id":"b","MessageBody":"{\"orderId\":\"J-2\",\"poison\":true}"},
  {"Id":"c","MessageBody":"{\"orderId\":\"J-3\"}"}
]'
```

Lambda xử lý: J-1 và J-3 được ghi DynamoDB, J-2 (poison) được trả về trong `batchItemFailures` → CHỈ J-2 quay lại queue để retry. Sau `maxReceiveCount=3` lần, J-2 vào DLQ. Kiểm tra:

```bash
sleep 30
aws dynamodb get-item --table-name ch30-orders --key '{"orderId":{"S":"J-1"}}' --query 'Item'
aws dynamodb get-item --table-name ch30-orders --key '{"orderId":{"S":"J-3"}}' --query 'Item'
# Sau ~1-2 phút J-2 vào DLQ:
aws sqs get-queue-attributes --queue-url ch30-jobs-dlq \
  --attribute-names ApproximateNumberOfMessages 2>/dev/null || \
aws sqs get-queue-attributes --queue-url "$(aws sqs get-queue-url --queue-name ch30-jobs-dlq --query QueueUrl --output text)" \
  --attribute-names ApproximateNumberOfMessages
```

> **Bẫy kinh điển:** nếu KHÔNG dùng partial batch response, khi J-2 lỗi thì cả batch (J-1, J-2, J-3) đều quay lại queue → J-1, J-3 bị xử lý lại. Nếu code không idempotent (không có conditional write như `saveIdempotent`), bạn sẽ ghi trùng. Đây là lý do idempotency + partial batch response luôn đi cùng nhau trong câu hỏi DVA.

### Dọn dẹp tài nguyên

```bash
aws lambda delete-event-source-mapping --uuid "$ESM_UUID"
aws lambda delete-function --function-name ch30-handler
aws s3 rm s3://$BUCKET --recursive && aws s3 rb s3://$BUCKET
aws dynamodb delete-table --table-name ch30-orders
for q in ch30-jobs ch30-jobs-dlq ch30-onsuccess ch30-onfailure; do
  aws sqs delete-queue --queue-url "$(aws sqs get-queue-url --queue-name $q --query QueueUrl --output text)"
done
aws iam detach-role-policy --role-name ch30-lambda-role --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam detach-role-policy --role-name ch30-lambda-role --policy-arn arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess
aws iam detach-role-policy --role-name ch30-lambda-role --policy-arn arn:aws:iam::aws:policy/AmazonSQSFullAccess
aws iam delete-role --role-name ch30-lambda-role
```

> Xoá ESM TRƯỚC khi xoá function/queue để tránh ESM ở trạng thái lỗi giữ tài nguyên. Xoá ESM mất vài giây (`State: Deleting`).

## 💡 Exam Tips chương 30

- **Phân biệt 3 mô hình invocation** quyết định cách retry & cách "xử lý lỗi": **synchronous** (caller tự retry, ví dụ API Gateway/ALB), **asynchronous** (Lambda tự retry 2 lần mặc định, DLQ hoặc destinations), **event source mapping/poll-based** (Lambda poll service: SQS, Kinesis, DynamoDB Streams, MSK, MQ). Đề rất hay hỏi loại nào dùng cơ chế nào.
- **DLQ vs Lambda destinations (async):** DLQ chỉ lưu event gốc; destinations lưu thêm request + response + error context, và có cả **on-success** lẫn **on-failure**. AWS khuyến nghị destinations thay DLQ cho async. Nhưng destinations KHÔNG áp cho ESM.
- **ESM SQS: DLQ đặt ở queue, không ở Lambda.** Message vào DLQ sau `maxReceiveCount` lần nhận. `ReportBatchItemFailures` cho phép chỉ retry message lỗi trong batch (partial batch response) thay vì cả batch.
- **Visibility timeout của SQS dùng cho ESM nên ≥ 6× function timeout.** Nếu nhỏ hơn, message có thể tái xuất hiện và bị một invocation khác xử lý song song.
- **ESM Kinesis/DynamoDB Streams xử lý theo shard, giữ ORDER trong mỗi shard.** Một record lỗi sẽ **chặn cả shard** (poison pill) cho tới khi hết retry. Khắc phục: `BisectBatchOnFunctionError`, `MaximumRetryAttempts`, `MaximumRecordAgeInSeconds`, và `OnFailure` destination (SQS/SNS) — chỉ Kinesis/DynamoDB Streams mới có on-failure destination ở cấp ESM.
- **ParallelizationFactor (1–10)** cho phép tới 10 Lambda đồng thời xử lý cùng MỘT shard (vẫn giữ order theo partition key) — tăng throughput cho Kinesis/DynamoDB Streams. Mặc định 1.
- **Starting position** của ESM stream: `LATEST` (chỉ record mới), `TRIM_HORIZON` (từ đầu retention), `AT_TIMESTAMP` (chỉ Kinesis). Lưu ý: `LATEST` bỏ qua record cũ — bẫy hay gặp khi "Lambda không thấy dữ liệu cũ".
- **Batch window (`MaximumBatchingWindowInSeconds`, tới 300s)** gom record để giảm số invocation; batch size SQS tối đa 10.000 với window, Kinesis/DynamoDB tới 10.000 record/batch.
- **Lambda + ALB:** ALB gọi Lambda **synchronous**; cần đăng ký Lambda vào target group và ALB cần resource-based permission. Lambda phải trả về đúng format `{statusCode, headers, body, isBase64Encoded}`. Bật **multi-value headers** ở target group để nhận/trả nhiều giá trị cùng header. ALB KHÔNG có request validation/mapping template như API Gateway.
- **Idempotency là bắt buộc** khi nguồn là at-least-once (SQS standard, Kinesis, async retry). Dùng conditional write DynamoDB (`attribute_not_exists`), khoá idempotency, hoặc Powertools Idempotency. Đề thường gài: "message bị xử lý 2 lần → fix thế nào" → đáp án là idempotency, không phải "tắt retry".
- **Async retry không cấu hình được số lần cho mọi nguồn:** với async là 0–2; với ESM SQS dựa vào `maxReceiveCount`; với stream dựa vào `MaximumRetryAttempts` (0 đến 10.000 hoặc -1 = vô hạn).
- **Resource-based policy** cần thiết để service "push" gọi Lambda (S3, SNS, EventBridge, ALB) qua `add-permission`. Còn ESM (poll-based) cần **execution role** của Lambda có quyền đọc nguồn (`sqs:ReceiveMessage`, `kinesis:GetRecords`...), KHÔNG dùng resource-based policy.

## Quiz chương 30 (10 câu)

**Câu 1.** Một developer cấu hình Lambda đọc từ Kinesis Data Stream. Một record bị lỗi liên tục khiến toàn bộ processing dừng lại. Cách nào KHÔNG phù hợp để xử lý poison record này?
- A. Đặt `MaximumRetryAttempts` và `MaximumRecordAgeInSeconds`
- B. Bật `BisectBatchOnFunctionError`
- C. Cấu hình `OnFailure` destination tới SQS
- D. Cấu hình một DLQ ở chính Kinesis stream

**Câu 2.** Lambda xử lý SQS qua event source mapping. Khi 1 trong 10 message của batch lỗi, cả 10 message quay lại queue và bị xử lý lại, gây ghi trùng vào DynamoDB. Cần làm gì?
- A. Giảm batch size xuống 1
- B. Bật `ReportBatchItemFailures` và trả về `batchItemFailures`, đồng thời đảm bảo handler idempotent
- C. Tăng visibility timeout của queue
- D. Chuyển sang FIFO queue

**Câu 3.** Một ứng dụng cần ALB route request HTTP tới Lambda. Phát biểu nào ĐÚNG?
- A. ALB gọi Lambda bất đồng bộ và tự retry 2 lần
- B. ALB gọi Lambda đồng bộ; Lambda phải trả về `statusCode`, `body`, `isBase64Encoded`
- C. ALB hỗ trợ mapping template VTL như API Gateway
- D. Không cần cấp quyền; ALB tự gọi được Lambda

**Câu 4.** Event source mapping SQS có function timeout 30 giây. Visibility timeout của queue nên đặt bao nhiêu?
- A. 30 giây
- B. Nhỏ hơn 30 giây để retry nhanh
- C. Ít nhất ~180 giây (6× function timeout)
- D. Đúng 60 giây bất kể timeout

**Câu 5.** Lambda được S3 invoke (async) để xử lý ảnh upload. Yêu cầu: lưu lại event của những lần xử lý THẤT BẠI kèm thông tin lỗi để điều tra. Giải pháp tốt nhất?
- A. DLQ (SQS) gắn vào Lambda
- B. Lambda destination `OnFailure` tới SQS hoặc SNS
- C. Bật X-Ray active tracing
- D. Tăng `maximum-retry-attempts` lên 2

**Câu 6.** Developer cần tăng throughput xử lý của Lambda đọc DynamoDB Streams mà vẫn giữ thứ tự theo từng item. Cấu hình nào?
- A. Tăng số shard của bảng
- B. Đặt `ParallelizationFactor` từ 1 lên tới 10
- C. Bật reserved concurrency
- D. Đổi sang Kinesis Data Stream

**Câu 7.** Một Lambda mới gắn ESM vào Kinesis stream đã có dữ liệu từ 2 ngày trước, nhưng Lambda chỉ xử lý record mới và bỏ qua dữ liệu cũ. Nguyên nhân?
- A. `StartingPosition` đặt là `LATEST`
- B. Batch size quá nhỏ
- C. Thiếu `ReportBatchItemFailures`
- D. Stream retention đã hết

**Câu 8.** Cấu hình nào BẮT BUỘC để service S3 có thể "push" gọi Lambda?
- A. Execution role của Lambda có `s3:GetObject`
- B. Resource-based policy trên Lambda cho phép principal `s3.amazonaws.com` (qua `add-permission`)
- C. Một event source mapping trỏ tới bucket
- D. VPC endpoint cho S3

**Câu 9.** Lambda async invocation thất bại sau khi hết retry. Đội muốn xử lý lại event đó tự động bằng một Lambda khác. Lựa chọn tốt nhất?
- A. DLQ + một Lambda poll DLQ đó
- B. `OnFailure` destination trỏ thẳng tới một Lambda hoặc EventBridge/SQS để re-process
- C. Tăng `maximum-event-age-in-seconds`
- D. Bật provisioned concurrency

**Câu 10.** Một developer cấu hình ESM SQS với `MaximumConcurrency` = 5. Điều này nghĩa là gì?
- A. Tối đa 5 message mỗi batch
- B. ESM không spawn quá 5 Lambda invocation đồng thời để đọc queue đó
- C. Queue chỉ giữ tối đa 5 message
- D. Lambda retry tối đa 5 lần

### Đáp án & giải thích

**Câu 1 — Đáp án D.** Kinesis KHÔNG có khái niệm "DLQ ở stream" — bạn không cấu hình redrive policy trên Kinesis như SQS. Với stream, cơ chế xử lý poison record là ở cấp **event source mapping**: `MaximumRetryAttempts`, `MaximumRecordAgeInSeconds` (A), `BisectBatchOnFunctionError` chia đôi batch để cô lập record lỗi (B), và `OnFailure` destination gửi metadata record lỗi sang SQS/SNS (C). D mô tả một thứ không tồn tại.

**Câu 2 — Đáp án B.** Vấn đề là all-or-nothing batch: khi thiếu partial batch response, một message lỗi kéo cả batch quay lại. Bật `ReportBatchItemFailures` + trả `batchItemFailures` để chỉ message lỗi bị retry; idempotency chống ghi trùng cho phần còn lại. A (batch=1) giảm throughput mạnh và vẫn không idempotent. C (visibility) không sửa nguyên nhân. D (FIFO) thay đổi semantics, không liên quan partial failure.

**Câu 3 — Đáp án B.** ALB gọi Lambda **đồng bộ** và yêu cầu response đúng format (`statusCode`, `statusDescription`, `headers`, `body`, `isBase64Encoded`). A sai: ALB không async, không tự retry như async invocation. C sai: ALB không có VTL mapping template/request validation (đó là API Gateway). D sai: phải cấp resource-based permission cho `elasticloadbalancing` gọi Lambda.

**Câu 4 — Đáp án C.** AWS khuyến nghị visibility timeout của queue dùng cho ESM ≥ **6 lần** function timeout, để tránh message tái xuất hiện và bị xử lý song song trong lúc Lambda còn đang chạy/retry. 30s (A) hoặc nhỏ hơn (B) gây xử lý trùng. D cứng nhắc 60s không bám theo timeout.

**Câu 5 — Đáp án B.** Lambda destination `OnFailure` lưu event gốc KÈM context lỗi (request/response payload), tốt hơn DLQ vốn chỉ giữ event gốc — và đề nói rõ "kèm thông tin lỗi". A (DLQ) mất context lỗi. C (X-Ray) để trace, không lưu event để re-process. D chỉ tăng retry, không lưu lại event thất bại.

**Câu 6 — Đáp án B.** `ParallelizationFactor` (1–10) cho phép tới 10 Lambda xử lý song song cùng một shard mà vẫn giữ order theo partition key — đúng yêu cầu "tăng throughput + giữ order theo item". A: số shard DynamoDB Streams không tự đặt được. C (reserved concurrency) giới hạn chứ không tăng song song theo shard. D thay nguồn không cần thiết.

**Câu 7 — Đáp án A.** `StartingPosition = LATEST` khiến ESM chỉ đọc record xuất hiện SAU khi mapping được tạo, bỏ qua dữ liệu cũ. Muốn xử lý dữ liệu cũ dùng `TRIM_HORIZON` (từ đầu retention) hoặc `AT_TIMESTAMP`. B/C ảnh hưởng cách gom/retry, không phải lý do bỏ qua dữ liệu cũ. D sai vì dữ liệu mới 2 ngày, trong retention.

**Câu 8 — Đáp án B.** S3 là nguồn "push" (async invocation), cần **resource-based policy** trên Lambda cho phép `s3.amazonaws.com` với `source-arn` của bucket (lệnh `add-permission`). A là quyền của Lambda truy cập S3 (cần để đọc object, nhưng không phải thứ cho phép S3 invoke). C sai: S3 không dùng event source mapping (đó là cho SQS/Kinesis/streams). D không liên quan invocation.

**Câu 9 — Đáp án B.** Destinations cho phép trỏ on-failure tới Lambda, SQS, SNS hoặc EventBridge để tự động re-process, kèm context lỗi. A (DLQ + Lambda poll) làm được nhưng phải tự dựng poller và mất context lỗi — kém hơn destinations. C chỉ kéo dài tuổi event, không re-process. D liên quan cold start, không liên quan xử lý lỗi.

**Câu 10 — Đáp án B.** `MaximumConcurrency` của scaling-config ESM SQS (2–1000) giới hạn số Lambda invocation đồng thời mà ESM đó spawn để poll queue — hữu ích để không làm cạn concurrency tài khoản hoặc bảo vệ downstream. A là batch size. C/D không phải ý nghĩa của tham số này.

## Tóm tắt chương

- **Ba mô hình invocation** quyết định retry & error handling: synchronous (caller retry — API GW/ALB), asynchronous (Lambda retry mặc định 2 lần — S3/SNS/EventBridge), và event source mapping/poll-based (SQS, Kinesis, DynamoDB Streams, MSK, MQ).
- **Lambda destinations (chỉ async)** có cả on-success và on-failure, lưu event + request/response/error context — AWS khuyến nghị thay cho DLQ; DLQ chỉ lưu event gốc.
- **ESM SQS:** DLQ đặt ở **queue** (redrive `maxReceiveCount`), không ở Lambda. `ReportBatchItemFailures` + trả `batchItemFailures` = partial batch response, chỉ retry message lỗi.
- **Visibility timeout queue dùng cho ESM nên ≥ 6× function timeout** để tránh xử lý song song/trùng.
- **ESM Kinesis/DynamoDB Streams xử lý theo shard, giữ order;** một record lỗi chặn cả shard (poison pill). Công cụ: `BisectBatchOnFunctionError`, `MaximumRetryAttempts`, `MaximumRecordAgeInSeconds`, và `OnFailure` destination ở cấp ESM (chỉ stream mới có).
- **ParallelizationFactor (1–10)** tăng số Lambda song song trên cùng shard mà vẫn giữ order theo partition key.
- **Starting position:** `LATEST` (record mới), `TRIM_HORIZON` (từ đầu retention), `AT_TIMESTAMP` (chỉ Kinesis); chọn sai gây "không thấy dữ liệu cũ".
- **Batch size + batch window** gom record giảm số invocation; window tới 300s, batch SQS tới 10.000 (với window), stream tới 10.000 record.
- **Lambda + ALB:** đồng bộ; cần target group + resource-based permission; Lambda trả `{statusCode, headers, body, isBase64Encoded}`; bật multi-value headers khi cần; ALB không có mapping template/validation như API Gateway.
- **Idempotency bắt buộc** với nguồn at-least-once (SQS standard, Kinesis, async retry): conditional write DynamoDB (`attribute_not_exists`) hoặc khoá idempotency; đừng "tắt retry" để chống trùng.
- **Resource-based policy** cho push source (S3/SNS/EventBridge/ALB) qua `add-permission`; **execution role** cho poll source (SQS/Kinesis/streams) cần quyền đọc nguồn.
- **Pipeline S3→Lambda→DynamoDB** điển hình: S3 push async tới Lambda, Lambda ghi DynamoDB idempotent, lỗi đi vào on-failure destination để điều tra/re-process.
