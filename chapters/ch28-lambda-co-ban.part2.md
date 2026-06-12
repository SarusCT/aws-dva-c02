## Hands-on Lab: Viết, deploy và quan sát vòng đời một Lambda function bằng CLI

**Mục tiêu lab:** Đi hết vòng đời một Lambda function từ góc developer, chỉ bằng AWS CLI v2 (không Console, không SAM — SAM ở Chương 36): tạo execution role, đóng gói code Node.js thành `.zip`, deploy bằng `create-function`, gọi **đồng bộ** (synchronous) bằng `invoke`, đọc `event`/`context`, cấu hình **environment variables**, chỉnh **memory/timeout** và quan sát ảnh hưởng tới billed duration, gọi **bất đồng bộ** (asynchronous) với DLQ để thấy cơ chế retry, cập nhật code bằng `update-function-code`, đọc log ở CloudWatch Logs và metric `Invocations`/`Errors`/`Throttles`. Event source mapping (SQS/Kinesis/DynamoDB Streams) chỉ giới thiệu — chi tiết ở Chương 30.

**Chuẩn bị:**
- AWS CLI v2 đã cấu hình (Chương 3); IAM user/role có quyền `lambda:*`, `iam:CreateRole`, `iam:AttachRolePolicy`, `iam:PassRole`, `logs:*`, `sqs:*`, `cloudwatch:GetMetricStatistics`.
- Node.js cài sẵn để test cục bộ (không bắt buộc). Region lab: `us-east-1`.

```bash
export AWS_REGION=us-east-1
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "Account: $ACCOUNT_ID"
```

### Bước 1: Tạo execution role cho Lambda

Mọi Lambda function PHẢI có một **execution role** — IAM role mà Lambda assume để lấy quyền tạm khi chạy. Trust policy phải cho `lambda.amazonaws.com` assume role (đây là điểm hay sai: nếu trust principal không đúng, `create-function` trả `InvalidParameterValueException: The role defined for the function cannot be assumed by Lambda`).

```bash
cat > trust-policy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "lambda.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}
EOF

aws iam create-role \
  --role-name lab28-lambda-role \
  --assume-role-policy-document file://trust-policy.json
```

Gắn managed policy `AWSLambdaBasicExecutionRole` — chỉ cấp 3 quyền `logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents`. Đây là quyền tối thiểu để function ghi được log ra CloudWatch. Không có nó, function vẫn chạy nhưng **không có log** — một cái bẫy troubleshooting kinh điển.

```bash
aws iam attach-role-policy \
  --role-name lab28-lambda-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

export ROLE_ARN=arn:aws:iam::${ACCOUNT_ID}:role/lab28-lambda-role
echo "ROLE_ARN=$ROLE_ARN"
```

> Đợi ~10 giây sau khi tạo role rồi mới `create-function`. IAM eventually consistent — tạo role xong gọi `create-function` ngay đôi khi vẫn báo role không assume được.

### Bước 2: Viết handler Node.js và đóng gói .zip

Tạo `index.mjs`. Handler đọc `event` (payload đầu vào) và `context` (metadata runtime: `awsRequestId`, `functionName`, `getRemainingTimeInMillis()`, `memoryLimitInMB`). Function trả về JSON cho người gọi đồng bộ.

```javascript
// index.mjs — runtime nodejs20.x, handler = index.handler
export const handler = async (event, context) => {
  console.log("EVENT:", JSON.stringify(event));
  console.log("RequestId:", context.awsRequestId);
  console.log("Remaining(ms):", context.getRemainingTimeInMillis());
  const name = event.name || process.env.GREETING_TARGET || "world";
  return {
    statusCode: 200,
    message: `Hello, ${name}! mem=${context.memoryLimitInMB}MB`,
  };
};
```

Đóng gói. Lambda nhận deployment package là `.zip`; với Node.js, file `index.mjs` phải nằm ở **gốc** của zip (không nằm trong thư mục con) thì handler `index.handler` mới resolve được.

```bash
zip function.zip index.mjs
```

### Bước 3: Deploy bằng create-function

```bash
aws lambda create-function \
  --function-name lab28-hello \
  --runtime nodejs20.x \
  --role "$ROLE_ARN" \
  --handler index.handler \
  --zip-file fileb://function.zip \
  --memory-size 128 \
  --timeout 10 \
  --environment "Variables={GREETING_TARGET=DVA}"
```

Output mong đợi (rút gọn): `"State": "Pending"` rồi chuyển `"Active"`, `"PackageType": "Zip"`, `"MemorySize": 128`, `"Timeout": 10`. Lưu ý `fileb://` (binary) chứ không phải `file://` cho zip — dùng nhầm `file://` sẽ hỏng package.

### Bước 4: Gọi đồng bộ (synchronous) và đọc response

`invoke` mặc định là `RequestResponse` (đồng bộ): CLI chờ function chạy xong và trả payload kết quả. Truyền payload qua `--payload` (cli-binary-format cần thiết với CLI v2 để nhận chuỗi JSON thô).

```bash
aws lambda invoke \
  --function-name lab28-hello \
  --cli-binary-format raw-in-base64-out \
  --payload '{"name":"Truong"}' \
  response.json

cat response.json
```

Output mong đợi: `{"statusCode":200,"message":"Hello, Truong! mem=128MB"}`. Nếu bỏ `name`, function rơi về env var: `Hello, DVA! ...`. Thử payload rỗng `'{}'` để xác nhận thứ tự ưu tiên `event.name` → `GREETING_TARGET` → `"world"`.

Để thấy log gọi và **billed duration**, thêm `--log-type Tail` rồi giải mã trường `LogResult` (base64):

```bash
aws lambda invoke \
  --function-name lab28-hello \
  --cli-binary-format raw-in-base64-out \
  --payload '{"name":"Tail"}' \
  --log-type Tail \
  --query 'LogResult' --output text out.json | base64 --decode
```

Cuối log có dòng `REPORT ... Duration: X ms Billed Duration: Y ms Memory Size: 128 MB Max Memory Used: Z MB`. Lần đầu gọi sẽ có thêm `Init Duration` — đó chính là **cold start** (khởi tạo execution environment + chạy code ngoài handler). Gọi lại ngay lần 2 sẽ không còn `Init Duration` vì environment được tái dùng (warm).

### Bước 5: Đổi memory để thấy quan hệ memory ↔ CPU ↔ giá

Lambda phân bổ CPU **tỉ lệ thuận** với memory (tuning chi tiết ở Chương 29). Tăng memory thường giảm Duration cho workload CPU-bound, nhưng giá mỗi ms lại cao hơn — có điểm tối ưu.

```bash
aws lambda update-function-configuration \
  --function-name lab28-hello \
  --memory-size 512
```

Gọi lại và so `Billed Duration`. Với handler nhẹ này khác biệt nhỏ, nhưng đây là cơ chế thi hay hỏi: "tăng memory để giảm thời gian chạy hàm CPU-bound".

### Bước 6: Gọi bất đồng bộ (asynchronous) + DLQ để thấy retry

Async invocation (`--invocation-type Event`): Lambda nhận event vào internal queue, trả `202` ngay, rồi chạy nền. Nếu function lỗi, Lambda **tự retry 2 lần** (tổng 3 lần chạy) với backoff; vẫn lỗi thì gửi event sang **DLQ** (hoặc destination — Chương 30/29). Tạo SQS làm DLQ và cấu hình `OnFailure`:

```bash
DLQ_URL=$(aws sqs create-queue --queue-name lab28-dlq --query QueueUrl --output text)
DLQ_ARN=$(aws sqs get-queue-attributes --queue-url "$DLQ_URL" \
  --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

# Cho Lambda role quyền gửi vào DLQ
aws iam put-role-policy --role-name lab28-lambda-role \
  --policy-name dlq-send --policy-document "$(cat <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"sqs:SendMessage","Resource":"$DLQ_ARN"}]}
EOF
)"

aws lambda update-function-configuration \
  --function-name lab28-hello \
  --dead-letter-config "TargetArn=$DLQ_ARN"
```

Cập nhật code để cố tình ném lỗi khi `event.fail === true`, rồi gọi async:

```bash
cat > index.mjs <<'EOF'
export const handler = async (event) => {
  if (event.fail) throw new Error("intentional failure");
  return { ok: true };
};
EOF
zip function.zip index.mjs
aws lambda update-function-code --function-name lab28-hello --zip-file fileb://function.zip

aws lambda invoke --function-name lab28-hello \
  --invocation-type Event --cli-binary-format raw-in-base64-out \
  --payload '{"fail":true}' /dev/null
```

Output `invoke`: `"StatusCode": 202` (đã nhận, chưa biết kết quả). Sau ~1 phút (qua 3 lần thử thất bại), event đến DLQ:

```bash
aws sqs receive-message --queue-url "$DLQ_URL" --wait-time-seconds 20 \
  --query 'Messages[0].Body'
```

> Phân biệt cốt lõi cho đề thi: retry tự động (2 lần) và DLQ chỉ áp dụng cho **async invocation**. Synchronous invocation KHÔNG retry — người gọi nhận lỗi và tự quyết định retry.

### Bước 7: Xem log và metric

```bash
# Log group được tạo tự động: /aws/lambda/<function-name>
aws logs tail /aws/lambda/lab28-hello --since 10m

# Metric Invocations 5 phút gần nhất (namespace AWS/Lambda)
aws cloudwatch get-metric-statistics \
  --namespace AWS/Lambda --metric-name Invocations \
  --dimensions Name=FunctionName,Value=lab28-hello \
  --start-time "$(date -u -v-15M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '15 min ago' +%Y-%m-%dT%H:%M:%SZ)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --period 300 --statistics Sum
```

Đổi `--metric-name` thành `Errors`, `Throttles`, `Duration` để xem các metric khác. Đây là các metric Lambda phát mặc định, không cần cấu hình gì thêm.

### Dọn dẹp tài nguyên

```bash
aws lambda delete-function --function-name lab28-hello
aws sqs delete-queue --queue-url "$DLQ_URL"
aws logs delete-log-group --log-group-name /aws/lambda/lab28-hello 2>/dev/null
aws iam delete-role-policy --role-name lab28-lambda-role --policy-name dlq-send
aws iam detach-role-policy --role-name lab28-lambda-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam delete-role --role-name lab28-lambda-role
rm -f index.mjs function.zip trust-policy.json response.json out.json
```

> Lambda không tính phí khi không chạy, nhưng CloudWatch Logs lưu trữ vẫn tốn tiền nếu giữ lâu — log group không tự xoá khi xoá function, phải xoá tay như trên.

## 💡 Exam Tips chương 28

- **Timeout tối đa 15 phút (900 giây)**, mặc định 3 giây. Job dài hơn 15 phút phải tách hoặc dùng Step Functions / ECS / Batch — câu hỏi "Lambda timeout sau 15 phút" rất hay xuất hiện.
- **Memory: 128 MB → 10.240 MB** (bước 1 MB). CPU phân bổ tỉ lệ thuận memory; ~1.769 MB = 1 vCPU đầy. Tăng memory để tăng CPU cho workload tính toán nặng.
- **Deployment package: zip ≤ 50 MB (zipped, upload trực tiếp), ≤ 250 MB unzipped** (gồm layers). Lớn hơn phải upload qua S3 hoặc dùng **container image (tới 10 GB)** — chi tiết Chương 29.
- **`/tmp` ephemeral storage** mặc định 512 MB, cấu hình tới 10.240 MB. Dùng cho file tạm; KHÔNG bền giữa các invocation độc lập (chỉ tái dùng khi warm).
- **Synchronous (RequestResponse)**: caller chờ kết quả, KHÔNG có retry tự động (API GW, ALB, CLI invoke, SDK). **Asynchronous (Event)**: S3/SNS/EventBridge; Lambda retry **2 lần** rồi đẩy event sang **DLQ hoặc destination**.
- **Event source mapping** (SQS, Kinesis, DynamoDB Streams): Lambda **poll** nguồn và tự gọi function — đây là kiểu thứ ba, KHÔNG phải async (chi tiết Chương 30).
- **Execution role** = quyền function được làm gì (assume bởi `lambda.amazonaws.com`). **Resource-based policy** = ai được phép gọi function (ví dụ cho S3/SNS/API GW `lambda:InvokeFunction`). Hai thứ khác nhau, hay bị gài.
- **Cold start** = thời gian tạo execution environment + chạy code init ngoài handler. Đặt code khởi tạo nặng (SDK client, kết nối) ngoài handler để tái dùng khi warm. Provisioned concurrency loại bỏ cold start (Chương 29).
- **Environment variables** mã hoá mặc định bằng KMS (AWS managed key); có thể dùng customer managed key (Chương 46). Tổng kích thước env vars ≤ 4 KB.
- **Concurrent executions** mặc định 1.000/account/region (soft limit, tăng được). Vượt → throttling, lỗi `429 TooManyRequestsException` — Chương 29.
- Nếu function "chạy nhưng không thấy log": kiểm tra execution role có `AWSLambdaBasicExecutionRole` (quyền `logs:*`) chưa.
- **Pricing** theo số request + GB-second (memory × duration làm tròn 1 ms). Free tier 1 triệu request + 400.000 GB-s/tháng.

## Quiz chương 28 (10 câu)

**Câu 1.** Một Lambda function được S3 gọi mỗi khi có object mới. Function lỗi do bug. Sau cùng AWS sẽ làm gì với event nếu KHÔNG cấu hình DLQ/destination?
- A. Lưu event vĩnh viễn trong queue nội bộ
- B. Retry 2 lần (tổng 3) rồi loại bỏ event
- C. Trả lỗi ngay cho S3, không retry
- D. Retry vô hạn cho đến khi thành công

**Câu 2.** Developer cần chạy một job xử lý video mất khoảng 25 phút mỗi lần. Lựa chọn nào phù hợp?
- A. Tăng Lambda timeout lên 30 phút
- B. Dùng Lambda với provisioned concurrency
- C. Dùng ECS/Fargate hoặc AWS Batch thay cho Lambda
- D. Chia thành nhiều Lambda chạy song song bằng `/tmp`

**Câu 3.** API Gateway gọi một Lambda đồng bộ. Function thỉnh thoảng lỗi do dependency bên ngoài. Cơ chế retry nào áp dụng?
- A. Lambda tự retry 2 lần
- B. Không có retry tự động ở phía Lambda; caller phải tự xử lý
- C. Event được đẩy vào DLQ
- D. API Gateway retry 3 lần mặc định

**Câu 4.** Một developer thấy hàm tính toán nặng chạy chậm. Cách hiệu quả nhất để giảm thời gian chạy?
- A. Giảm memory để tiết kiệm
- B. Tăng memory-size để được cấp nhiều CPU hơn
- C. Tăng timeout
- D. Tăng `/tmp` lên 10 GB

**Câu 5.** S3 cần được phép gọi một Lambda function. Cấu hình nào là đúng?
- A. Thêm S3 vào execution role của function
- B. Thêm resource-based policy cho phép `s3.amazonaws.com` `lambda:InvokeFunction`
- C. Tạo IAM user cho S3
- D. Bật provisioned concurrency

**Câu 6.** Deployment package zip của function là 120 MB (đã nén). Cách deploy hợp lệ?
- A. Upload trực tiếp qua `create-function --zip-file`
- B. Upload package lên S3 rồi tham chiếu `--code S3Bucket=...`
- C. Không thể deploy, vượt giới hạn tuyệt đối
- D. Bắt buộc dùng SAM

**Câu 7.** Trong handler Node.js, đối tượng nào cung cấp `awsRequestId` và `getRemainingTimeInMillis()`?
- A. `event`
- B. `context`
- C. `process.env`
- D. `callback`

**Câu 8.** Function cần biến môi trường chứa connection string nhạy cảm. Mặc định Lambda làm gì với environment variables?
- A. Lưu plaintext, không mã hoá
- B. Mã hoá at rest bằng KMS (AWS managed key) mặc định
- C. Từ chối lưu nếu không bật KMS
- D. Lưu trong CloudWatch Logs

**Câu 9.** Một function được gọi đột biến vượt quá concurrency limit của account. Điều gì xảy ra với các invocation đồng bộ vượt ngưỡng?
- A. Tự động xếp hàng và chạy sau
- B. Bị throttle với lỗi `429 TooManyRequestsException`
- C. Tăng limit tự động không giới hạn
- D. Chuyển sang chạy trên EC2

**Câu 10.** Developer cài đặt SDK client (ví dụ DynamoDB) trong handler, tạo mới mỗi lần gọi. Cải tiến nào giảm latency khi function warm?
- A. Tạo client bên trong handler để luôn mới
- B. Khởi tạo client một lần ngoài handler (ở phạm vi module) để tái dùng
- C. Tăng timeout
- D. Dùng async invocation

### Đáp án & giải thích

**Câu 1 — Đáp án B.** Async invocation retry 2 lần (tổng 3 lần chạy) với backoff; không cấu hình DLQ/destination thì event bị loại bỏ sau lần thử cuối. A sai: queue nội bộ chỉ giữ tạm, không vĩnh viễn. C sai: S3 gọi async, không nhận lỗi đồng bộ. D sai: chỉ event source mapping (Kinesis/DynamoDB) mới retry tới hết retention/ngày, async chỉ 2 lần.

**Câu 2 — Đáp án C.** Lambda timeout cứng 15 phút, không thể đặt 30 phút → A sai luôn vì vượt limit. Job 25 phút phải dùng ECS/Fargate hoặc Batch (hoặc orchestrate bằng Step Functions). B sai: provisioned concurrency chỉ giảm cold start, không tăng timeout. D sai: chia nhỏ phức tạp, và `/tmp` không chia sẻ giữa các function độc lập.

**Câu 3 — Đáp án B.** Synchronous invocation không có retry tự động phía Lambda; caller (API GW/client) chịu trách nhiệm retry. A sai: retry 2 lần chỉ cho async. C sai: DLQ chỉ cho async invocation và event source mapping. D sai: API Gateway không tự retry Lambda integration mặc định.

**Câu 4 — Đáp án B.** Lambda cấp CPU tỉ lệ thuận memory; workload CPU-bound chạy nhanh hơn khi tăng memory, thường còn rẻ hơn do giảm duration. A sai ngược. C sai: timeout chỉ là giới hạn tối đa, không tăng tốc. D sai: `/tmp` là disk tạm, không liên quan CPU.

**Câu 5 — Đáp án B.** Cho phép service ngoài gọi function dùng **resource-based policy** (`lambda:InvokeFunction` cho principal `s3.amazonaws.com` kèm `SourceArn` bucket). A sai: execution role là quyền function làm gì, không phải ai gọi nó. C sai: service không dùng IAM user. D sai: không liên quan.

**Câu 6 — Đáp án B.** Zip > 50 MB không upload trực tiếp được (giới hạn API `create-function --zip-file` là 50 MB nén); nhưng tới 250 MB unzipped vẫn hợp lệ nếu upload qua **S3**. A sai vì 120 MB vượt giới hạn upload trực tiếp. C sai: chưa vượt 250 MB unzipped. D sai: SAM không bắt buộc (SAM cũng chỉ stage qua S3).

**Câu 7 — Đáp án B.** `context` chứa metadata runtime: `awsRequestId`, `functionName`, `memoryLimitInMB`, `getRemainingTimeInMillis()`. A sai: `event` là payload đầu vào. C sai: `process.env` là env vars. D sai: `callback` là pattern cũ, không mang các thuộc tính này.

**Câu 8 — Đáp án B.** Environment variables được mã hoá at rest mặc định bằng KMS (AWS managed key `aws/lambda`); có thể dùng customer managed key. A sai: không lưu plaintext. C sai: KMS mặc định luôn bật. D sai: env vars không nằm trong logs.

**Câu 9 — Đáp án B.** Vượt concurrency limit, invocation đồng bộ bị throttle ngay với `429 TooManyRequestsException`; caller tự retry. A sai: chỉ async/event source mapping mới được buffer/retry khi throttle. C sai: limit là soft nhưng không tự tăng tức thì. D sai: Lambda không chuyển sang EC2.

**Câu 10 — Đáp án B.** Khởi tạo client ở phạm vi module (ngoài handler) để khi environment warm, code init không chạy lại — tái dùng kết nối, giảm latency. A sai ngược (tạo mới mỗi lần tốn thời gian). C sai: timeout không giảm latency. D sai: async không liên quan đến tái dùng client.

## Tóm tắt chương

- **Lambda** chạy code theo sự kiện, không quản server; bạn chỉ cung cấp **handler** + cấu hình memory/timeout, AWS lo execution environment.
- Mỗi function cần **execution role** (assume bởi `lambda.amazonaws.com`); tối thiểu gắn `AWSLambdaBasicExecutionRole` để ghi log.
- **Handler(event, context)**: `event` là payload, `context` mang `awsRequestId`, `getRemainingTimeInMillis()`, `memoryLimitInMB`.
- Ba kiểu invocation: **synchronous** (chờ kết quả, không retry tự động), **asynchronous** (retry 2 lần, DLQ/destination), **event source mapping** (Lambda poll nguồn — Chương 30).
- **Limits cốt lõi**: timeout ≤ 900 giây; memory 128–10.240 MB; zip ≤ 50 MB upload trực tiếp / 250 MB unzipped; container image ≤ 10 GB; env vars ≤ 4 KB; `/tmp` 512 MB–10.240 MB; concurrency mặc định 1.000/account/region.
- **Memory quyết định CPU**: tăng memory để tăng tốc workload CPU-bound, có điểm tối ưu chi phí.
- **Cold start** = init environment + code ngoài handler; đặt khởi tạo nặng ngoài handler để tái dùng khi warm.
- **Execution role** (function làm được gì) khác **resource-based policy** (ai được gọi function) — đừng nhầm.
- Async invocation thất bại sẽ tới **DLQ** (SQS/SNS) hoặc **destination**; synchronous thì caller tự xử lý lỗi.
- Lambda phát sẵn metric `Invocations`, `Errors`, `Throttles`, `Duration`, `ConcurrentExecutions` ở namespace `AWS/Lambda`; log tự ghi vào `/aws/lambda/<function>`.
- **Pricing** = số request + GB-second (memory × duration làm tròn 1 ms); free tier 1 triệu request + 400.000 GB-s/tháng.
- Concurrency, versions/aliases, provisioned concurrency, layers, container image, VPC, tuning — đào sâu ở **Chương 29**.
