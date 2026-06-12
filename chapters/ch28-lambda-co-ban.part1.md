# Chương 28: AWS Lambda cơ bản

> **Trọng tâm DVA-C02:** Lambda là dịch vụ trung tâm của phần Serverless và xuất hiện cực kỳ dày trong đề thi — vừa ở dạng câu hỏi khái niệm vừa ở dạng tình huống. Bạn sẽ gặp: phân biệt ba mô hình invocation (synchronous, asynchronous, event source mapping) và hệ quả về retry/DLQ của từng loại; cơ chế execution environment & cold start (init, freeze/thaw); quan hệ memory↔CPU và cách tăng tốc bằng cách tăng RAM; các con số limits chính xác (timeout max 15 phút, payload sync 6MB, async 256KB, /tmp tối thiểu 512MB...); execution role vs resource-based policy (ai được phép invoke); cách tính giá theo GB-second; và đọc context object (`requestId`, `getRemainingTimeInMillis`). Concurrency, versions/aliases, layers, VPC, SnapStart học ở Chương 29; event source mapping chi tiết (SQS/Kinesis/DynamoDB Streams) ở Chương 30.

## Mục tiêu chương

- Hiểu serverless là gì, Lambda giải quyết bài toán gì so với chạy code trên EC2/container, và mô hình chi phí "trả theo lần chạy".
- Nắm vững anatomy của một function: handler Node.js, event object, context object, runtime, và vòng đời execution environment (cold start, init, invoke, freeze).
- Phân biệt rạch ròi ba kiểu invocation — synchronous, asynchronous, event source mapping — và cơ chế retry/DLQ/destinations đi kèm từng kiểu (đây là điểm thi kinh điển).
- Cấu hình memory/CPU, timeout, environment variables đúng cách và biết các limits/quotas con số cụ thể cho đề thi.
- Hiểu execution role (Lambda gọi service khác) vs resource-based policy (service khác gọi Lambda), logging qua CloudWatch, và metrics cơ bản.
- Viết, deploy và invoke function đầu tiên bằng AWS CLI v2 + AWS SDK for JavaScript v3.

## 28.1 Serverless là gì và Lambda nằm ở đâu

"Serverless" **không** có nghĩa là không có server — nó nghĩa là **bạn không phải quản lý server**. Bạn không provision EC2 instance, không patch OS, không cấu hình Auto Scaling Group, không lo về AZ. Bạn chỉ upload code, AWS lo phần còn lại: cấp tài nguyên, scale từ 0 đến hàng nghìn lần chạy đồng thời, rồi thu về 0 khi không có request. Đặc trưng của serverless:

- **No server management:** không có instance để SSH vào.
- **Tự động scale theo request:** mỗi request đồng thời được phục vụ bởi một execution environment riêng.
- **Scale-to-zero:** không có traffic thì không tốn tiền compute (khác EC2 luôn chạy là luôn tính tiền).
- **Trả tiền theo lượng dùng thực:** tính theo số lần invoke và thời gian chạy (GB-second), không trả cho thời gian idle.

AWS Lambda là dịch vụ **Function as a Service (FaaS)** — đơn vị triển khai là một *function* nhỏ chạy để phản hồi một *event*. Lambda là hạt nhân của hệ sinh thái serverless trên AWS, thường ghép với API Gateway (Chương 34), DynamoDB (Chương 31), S3, SQS, SNS, EventBridge, Step Functions (Chương 43) để tạo kiến trúc event-driven hoàn chỉnh.

So sánh nhanh ba mô hình compute để định vị Lambda:

| Tiêu chí | EC2 | ECS/Fargate (container) | Lambda |
|---|---|---|---|
| Đơn vị triển khai | Instance (VM) | Container/task | Function |
| Quản lý OS/patching | Bạn (EC2) / AWS (Fargate một phần) | Một phần | AWS hoàn toàn |
| Scaling | ASG, có warm-up | Service auto scaling | Tự động, từng request |
| Scale-to-zero | Không (trừ khi tự tắt) | Có với cấu hình | Có, mặc định |
| Thời gian chạy tối đa | Không giới hạn | Không giới hạn | **15 phút** |
| Mô hình giá | Theo giờ instance chạy | Theo vCPU/RAM-second | Theo invoke + GB-second |
| Phù hợp khi | Workload chạy liên tục, cần kiểm soát OS | Microservice container, chạy lâu | Event-driven, burst, tác vụ ngắn |

> 💡 **Exam Tip:** Khi đề nói "least operational overhead", "no infrastructure to manage", "event-driven", "pay only for what you use" cho tác vụ ngắn (dưới 15 phút) → nghĩ ngay đến Lambda. Nếu tác vụ chạy lâu hơn 15 phút hoặc cần chạy liên tục → Fargate/EC2. Nếu cần xử lý hàng loạt batch dài → AWS Batch (Chương 48).

## 28.2 Anatomy của một Lambda function: handler, event, context

Mỗi Lambda function gồm: **code** (deployment package), **runtime** (môi trường ngôn ngữ — Node.js, Python, Java, Go, Ruby, .NET, hoặc custom runtime qua OS-only base image), **handler** (hàm AWS gọi khi có event), và **cấu hình** (memory, timeout, env vars, role...).

Handler là điểm vào. Với Node.js (runtime `nodejs20.x` hoặc `nodejs22.x`), handler nhận hai tham số `event` và `context`. Mô hình async/await được khuyến nghị:

```javascript
// index.mjs — handler tên "handler" trong file "index"
// → cấu hình handler là "index.handler"
export const handler = async (event, context) => {
  // event: dữ liệu đầu vào, hình dạng tuỳ nguồn gọi (API GW, S3, SQS...)
  console.log("Event:", JSON.stringify(event));

  // context: thông tin runtime về lần invoke này
  console.log("RequestId:", context.awsRequestId);
  console.log("Function:", context.functionName, context.functionVersion);
  console.log("Còn lại (ms):", context.getRemainingTimeInMillis());

  // Trả về object → với invoke đồng bộ, caller nhận lại JSON này
  return { statusCode: 200, body: "Hello from Lambda" };
};
```

**Event object** là payload JSON mô tả sự kiện. Hình dạng của nó hoàn toàn phụ thuộc nguồn gọi: từ API Gateway proxy là object có `httpMethod`/`headers`/`body`; từ S3 là `Records[].s3.bucket.name`; từ SQS là `Records[].body`. Nắm được hình dạng event của từng nguồn là kỹ năng quan trọng (chi tiết integration ở Chương 30, 34).

**Context object** cung cấp metadata runtime, đây là những thuộc tính hay bị hỏi trong đề:

- `context.awsRequestId` — ID duy nhất của lần invoke, cực hữu ích để trace log và làm idempotency key.
- `context.functionName`, `context.functionVersion` — tên và version đang chạy.
- `context.getRemainingTimeInMillis()` — số mili-giây còn lại trước khi timeout. Dùng để chủ động dừng công việc gọn gàng (graceful) trước khi bị giết, ví dụ flush buffer hoặc checkpoint.
- `context.logGroupName`, `context.logStreamName` — vị trí log trong CloudWatch.
- `context.memoryLimitInMB` — RAM được cấp.

```javascript
// Dùng getRemainingTimeInMillis để dừng vòng lặp an toàn trước timeout
export const handler = async (event, context) => {
  while (coVecCanLam()) {
    if (context.getRemainingTimeInMillis() < 2000) {
      // Còn dưới 2s → dừng, lưu checkpoint để lần sau làm tiếp
      await luuCheckpoint();
      break;
    }
    await xuLyMotPhan();
  }
};
```

> 💡 **Exam Tip:** Với Node.js, **đừng** vừa dùng `async/await` vừa gọi `callback`. Nếu handler trả Promise (async), Lambda dùng giá trị resolve làm response. Nếu bạn để biến global giữ state (kết nối DB, SDK client) thì state đó **được tái sử dụng** giữa các lần invoke trên cùng execution environment — tận dụng để khởi tạo connection một lần, tránh tạo lại mỗi request.

## 28.3 Execution environment & vòng đời — cold start

Lambda chạy code trong một **execution environment** — một micro-VM dựng trên Firecracker, cô lập và an toàn. Hiểu vòng đời của nó là chìa khoá để giải thích cold start và tối ưu hiệu năng.

Một execution environment đi qua các pha:

1. **INIT (initialization):** Lambda tải code, khởi tạo runtime, rồi chạy **toàn bộ code bên ngoài handler** (import module, tạo client SDK, đọc config). Pha này xảy ra một lần khi environment mới được dựng.
2. **INVOKE:** Lambda gọi hàm handler với event. Pha này lặp lại cho mỗi request trên environment đó.
3. **SHUTDOWN:** Khi environment không còn được dùng, Lambda dọn dẹp nó.

**Cold start** là độ trễ phụ phát sinh khi một request phải chờ một execution environment **mới** được dựng và chạy xong pha INIT. Cold start xảy ra khi: lần invoke đầu tiên, sau một thời gian không có traffic (environment bị thu hồi), hoặc khi cần thêm environment để phục vụ request đồng thời (burst). Sau cold start, environment được **giữ ấm (warm)** một thời gian; request kế tiếp dùng lại environment đã init nên gọi thẳng vào handler — **warm start**, nhanh hơn nhiều.

Giữa hai lần invoke, environment bị **freeze** (đóng băng) và được **thaw** (rã đông) khi có request mới. Hệ quả thực tế:

- Biến global khởi tạo ở pha INIT được **tái sử dụng** ở warm start → khởi tạo SDK client, connection pool, đọc Secrets/SSM ở phạm vi module (ngoài handler) để chỉ trả giá một lần.
- **Background task** không await xong trước khi handler return có thể bị đóng băng và không hoàn tất → luôn `await` mọi promise trước khi return.
- Dữ liệu ghi vào `/tmp` cũng tồn tại qua các warm invoke trên cùng environment (cache file tạm).

```javascript
// ĐÚNG: tạo client SDK ở phạm vi module (chạy 1 lần ở INIT, dùng lại ở warm start)
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
const ddb = new DynamoDBClient({}); // khởi tạo 1 lần

export const handler = async (event) => {
  // dùng lại ddb đã có sẵn → tiết kiệm thời gian cold start cho request sau
  // ...
};
```

Yếu tố ảnh hưởng độ dài cold start: kích thước deployment package, ngôn ngữ runtime (Java/.NET nặng hơn Node.js/Python), số lượng init code, có cấu hình VPC hay không. Các kỹ thuật giảm cold start nghiêm túc — provisioned concurrency và SnapStart — học ở Chương 29.

> 💡 **Exam Tip:** Đề hay hỏi "function thỉnh thoảng chậm bất thường ở request đầu" → đó là **cold start**. Giải pháp giảm cold start cho workload nhạy độ trễ là **provisioned concurrency** (giữ sẵn environment đã init). Tăng RAM cũng giảm thời gian init vì được cấp nhiều CPU hơn. Đừng nhầm với reserved concurrency (giới hạn trần, không làm ấm sẵn) — chi tiết Chương 29.

## 28.4 Ba kiểu invocation và cơ chế retry

Đây là phần **quan trọng nhất** của chương về mặt thi cử. Lambda có ba cách được gọi, mỗi cách có hành vi retry và xử lý lỗi khác nhau.

### Synchronous (request-response)

Caller gọi và **chờ** response. Lambda chạy xong trả kết quả về ngay. Lỗi (exception, timeout) trả thẳng về cho caller — **Lambda KHÔNG tự retry**, caller phải tự xử lý.

Nguồn gọi synchronous điển hình: **CLI/SDK `Invoke`** (mặc định), **API Gateway**, **Application Load Balancer**, **Cognito**, **Step Functions** (task thường), **Lambda function URL**.

```bash
# Invoke đồng bộ bằng CLI (mặc định InvocationType=RequestResponse)
aws lambda invoke \
  --function-name my-func \
  --payload '{"key":"value"}' \
  --cli-binary-format raw-in-base64-out \
  response.json
# response.json chứa kết quả handler trả về; lỗi xuất hiện ở FunctionError
```

Giới hạn payload synchronous: **request và response tối đa 6 MB** mỗi chiều.

### Asynchronous (event)

Caller gửi event rồi **trả về ngay** (không chờ kết quả). Lambda **đẩy event vào một internal queue** và xử lý sau. Vì caller không chờ, **Lambda tự retry** khi function lỗi: mặc định retry **2 lần** (tổng 3 lần thử), với khoảng nghỉ tăng dần. Nếu vẫn lỗi sau hết retry, event có thể được gửi tới **Dead Letter Queue (DLQ)** hoặc **destination** (on-failure).

Nguồn gọi asynchronous điển hình: **S3 events**, **SNS**, **EventBridge**, **SES**, CloudWatch Logs, CodeCommit, và CLI/SDK khi đặt `--invocation-type Event`.

```bash
# Invoke bất đồng bộ — trả về 202 ngay, không chờ xử lý
aws lambda invoke \
  --function-name my-func \
  --invocation-type Event \
  --payload '{"key":"value"}' \
  --cli-binary-format raw-in-base64-out \
  response.json   # response.json rỗng, chỉ có status 202
```

Giới hạn payload asynchronous: **256 KB**.

Cấu hình xử lý lỗi cho async qua **destinations** (mới, khuyến nghị) — định tuyến cả on-success và on-failure tới SQS/SNS/Lambda/EventBridge; hoặc qua **DLQ** (cũ hơn, chỉ on-failure, tới SQS/SNS):

```bash
# Cấu hình async: tối đa 1 lần retry, gửi cả success/failure tới destination
aws lambda put-function-event-invoke-config \
  --function-name my-func \
  --maximum-retry-attempts 1 \
  --maximum-event-age-in-seconds 3600 \
  --destination-config '{
    "OnSuccess":{"Destination":"arn:aws:sqs:ap-southeast-1:111122223333:ok-queue"},
    "OnFailure":{"Destination":"arn:aws:sqs:ap-southeast-1:111122223333:fail-queue"}
  }'
```

`MaximumRetryAttempts` chỉnh được 0–2; `MaximumEventAgeInSeconds` 60–21600 giây (tối đa 6 giờ) — event quá tuổi bị bỏ.

### Event source mapping (poll-based)

Với các nguồn **stream/queue** — **SQS, Kinesis Data Streams, DynamoDB Streams, Amazon MQ, Kafka** — Lambda **không** được nguồn đẩy event. Thay vào đó, một thành phần do Lambda quản lý gọi là **event source mapping** **chủ động poll** nguồn, gom message thành batch rồi gọi handler đồng bộ với batch đó. Lambda đứng sau poll giúp bạn.

Hành vi retry ở đây khác hẳn và tuỳ nguồn (chi tiết đầy đủ ở **Chương 30**):

- Với **SQS**: nếu batch lỗi, message quay lại queue sau visibility timeout; DLQ đặt ở **chính queue** (không phải ở Lambda).
- Với **Kinesis/DynamoDB Streams**: retry theo record, có thể block shard cho tới khi thành công hoặc record hết hạn; cấu hình bisect-on-error, on-failure destination.

> 💡 **Exam Tip:** Bảng tổng kết phải thuộc lòng — **Sync**: không retry, lỗi trả về caller, payload 6MB (API GW, ALB, CLI mặc định). **Async**: Lambda tự retry 2 lần, DLQ/destination cho thất bại, payload 256KB (S3, SNS, EventBridge). **Event source mapping (poll)**: Lambda poll SQS/Kinesis/DynamoDB Streams, retry & DLQ theo cấu hình nguồn. Câu hỏi "S3 trigger Lambda nhưng event bị mất khi function lỗi" → đáp án là cấu hình **DLQ/on-failure destination** cho async invocation.

## 28.5 Memory, CPU và timeout — các con số phải nhớ

Bạn **chỉ cấu hình memory**; Lambda cấp **CPU tỉ lệ thuận với memory**. Đây là điểm nhiều người hiểu sai.

- Memory: từ **128 MB** đến **10240 MB (10 GB)**, bước 1 MB.
- CPU: cấp tự động theo memory. Tại **1769 MB** bạn được tương đương **1 vCPU**. Trên mức đó tới 10 GB, bạn có thể được tới ~**6 vCPU**. Nghĩa là tăng RAM cũng tăng sức mạnh CPU và băng thông mạng.
- Code CPU-bound (xử lý ảnh, nén, mã hoá) **chạy nhanh hơn** khi tăng RAM — đôi khi tăng RAM lại **giảm tổng chi phí** vì thời gian chạy giảm đủ nhiều để bù phần đơn giá GB-second cao hơn. Công cụ **AWS Lambda Power Tuning** giúp tìm điểm tối ưu giá/hiệu năng.

Timeout:

- Mặc định **3 giây**, tối đa **900 giây = 15 phút**. Quá thời gian này function bị giết, trả lỗi `Task timed out`.

```bash
# Đặt memory 512MB và timeout 30s
aws lambda update-function-configuration \
  --function-name my-func \
  --memory-size 512 \
  --timeout 30
```

Các limits/quotas khác hay bị hỏi:

| Thông số | Giá trị |
|---|---|
| Memory | 128 MB – 10240 MB (bước 1 MB) |
| Timeout | tối đa 900 giây (15 phút) |
| Payload synchronous (req/resp) | 6 MB mỗi chiều |
| Payload asynchronous (event) | 256 KB |
| `/tmp` ephemeral storage | 512 MB – 10240 MB (mặc định 512 MB) |
| Deployment package (zip, upload trực tiếp) | 50 MB |
| Deployment package qua S3 (zip) | 250 MB |
| Code + dependencies giải nén | 250 MB (zip); 10 GB (container image) |
| Environment variables (tổng kích thước) | 4 KB |
| Số layer mỗi function | 5 |
| Concurrent executions mặc định (account) | 1000 (soft limit, xin tăng được) |

> 💡 **Exam Tip:** Nhớ cặp số gây bẫy: payload **sync 6MB** vs **async 256KB**; package **zip 50MB upload trực tiếp** nhưng **250MB qua S3 / khi giải nén**; env vars tổng **4KB**; `/tmp` mặc định **512MB** nhưng cấu hình tới **10GB**. Câu "function CPU-bound chạy chậm, làm sao tăng tốc?" → **tăng memory** (vì CPU tỉ lệ theo memory), không phải sửa code.

## 28.6 Environment variables và cấu hình

Environment variables cho phép tách cấu hình khỏi code: tên bảng DynamoDB, endpoint, feature flag, log level. Truy cập qua `process.env` (Node.js). Tổng kích thước tất cả env vars **không vượt 4 KB**.

```bash
aws lambda update-function-configuration \
  --function-name my-func \
  --environment "Variables={TABLE_NAME=Orders,LOG_LEVEL=info}"
```

```javascript
const TABLE = process.env.TABLE_NAME; // đọc khi cần
```

Env vars được **mã hoá at rest bằng KMS**. Mặc định dùng AWS managed key cho Lambda; bạn có thể chỉ định **customer managed key (CMK)** để kiểm soát quyền và audit. Với secret nhạy cảm, **đừng** để giá trị thô trong env var — dùng **SSM Parameter Store (SecureString)** hoặc **Secrets Manager** và đọc lúc runtime (Chương 47). Lambda có sẵn các runtime giá trị reserved như `AWS_REGION`, `AWS_LAMBDA_FUNCTION_NAME`, `_HANDLER`, `AWS_LAMBDA_FUNCTION_MEMORY_SIZE` — không ghi đè được.

> 💡 **Exam Tip:** Để mã hoá env var bằng key riêng và kiểm soát quyền giải mã → dùng **customer managed KMS key**. Để tránh lộ secret và xoay vòng (rotation) tự động → **Secrets Manager**; để cấu hình rẻ, phân cấp → **Parameter Store**. Câu hỏi hay gài: secret để plaintext trong env var bị xem là không an toàn dù đã mã hoá at rest, vì hiện trong console/`get-function-configuration`.

## 28.7 Permissions: execution role vs resource-based policy

Hai loại quyền của Lambda dễ nhầm và là điểm thi rất hay gặp. Phân biệt theo **hướng**:

**Execution role** (IAM role) — quyền **Lambda dùng để gọi service khác**. Khi function ghi DynamoDB, đọc S3, gửi SQS, hay ghi log CloudWatch, nó **assume execution role** này. Role phải có trust policy tin `lambda.amazonaws.com`. Tối thiểu nên gắn managed policy `AWSLambdaBasicExecutionRole` để function ghi được log vào CloudWatch Logs (quyền `logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents`).

```json
// Trust policy của execution role: cho phép Lambda assume role này
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "lambda.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}
```

```bash
# Tạo role, gắn quyền ghi log cơ bản
aws iam create-role --role-name my-func-role \
  --assume-role-policy-document file://trust.json
aws iam attach-role-policy --role-name my-func-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
```

**Resource-based policy** (function policy) — quyền **cho phép principal khác gọi (invoke) function này**. Khi S3, SNS, API Gateway, EventBridge cần trigger Lambda, bạn phải cấp `lambda:InvokeFunction` cho service đó qua resource-based policy. Console thường tự thêm khi bạn cấu hình trigger; bằng CLI bạn dùng `add-permission`:

```bash
# Cho phép S3 bucket invoke function (resource-based policy)
aws lambda add-permission \
  --function-name my-func \
  --statement-id s3-invoke \
  --action lambda:InvokeFunction \
  --principal s3.amazonaws.com \
  --source-arn arn:aws:s3:::my-bucket \
  --source-account 111122223333
```

> 💡 **Exam Tip:** Phân biệt theo hướng mũi tên. **Lambda gọi ra ngoài** (DynamoDB, S3, SQS) → cần **execution role**. **Service khác gọi vào Lambda** (S3, SNS, API GW trigger) → cần **resource-based policy** (`add-permission`). Lỗi "S3 không trigger được Lambda" với `AccessDenied` → thiếu resource-based policy cho `s3.amazonaws.com`. Lỗi "function chạy nhưng không ghi được DynamoDB" → thiếu quyền trong execution role.

## 28.8 Logging, metrics và pricing

**Logging:** mọi thứ function ghi ra stdout/stderr (`console.log`) được đẩy vào **CloudWatch Logs**, vào log group `/aws/lambda/<function-name>`, mỗi execution environment là một log stream. Để ghi được, execution role cần quyền `logs:*` cơ bản (đã có trong `AWSLambdaBasicExecutionRole`). Bạn có thể bật **JSON structured logging** và đặt **log level** ngay ở cấu hình function (Advanced Logging Controls) để lọc log gọn hơn (chi tiết CloudWatch Logs ở Chương 25).

**Metrics:** Lambda tự đẩy metrics vào CloudWatch namespace `AWS/Lambda`. Những metric cần thuộc:

- `Invocations` — số lần gọi.
- `Errors` — số lần lỗi function (exception/timeout).
- `Duration` — thời gian chạy handler (ms); dùng để tinh chỉnh memory và timeout.
- `Throttles` — số lần bị từ chối do vượt concurrency (lỗi 429) — chi tiết Chương 29.
- `ConcurrentExecutions` — số environment chạy đồng thời.
- `DeadLetterErrors` / `DestinationDeliveryFailures` — lỗi khi giao tới DLQ/destination.
- `IteratorAge` — (chỉ stream) độ trễ xử lý so với record mới nhất; cao nghĩa là consumer bị tụt lại.

**Pricing** — hai thành phần cộng lại:

1. **Số request:** tính theo số lần invoke (ví dụ ~$0.20 mỗi 1 triệu request).
2. **Compute (GB-second):** memory cấp (GB) × thời gian chạy (giây), làm tròn lên tới mili-giây. Function 512 MB (0.5 GB) chạy 200 ms = 0.5 × 0.2 = 0.1 GB-second.

Có **free tier vĩnh viễn**: 1 triệu request và 400.000 GB-second mỗi tháng. Vì giá theo GB-second, tăng RAM làm đơn giá mỗi giây cao hơn — nhưng nếu thời gian chạy giảm tương ứng (CPU mạnh hơn) thì tổng chi phí có thể không đổi hoặc giảm. Lưu ý: thời gian **cold start / init** không tính tiền cho invoke thông thường (chỉ Duration của handler được tính; provisioned concurrency thì khác — Chương 29).

> 💡 **Exam Tip:** Chi phí Lambda = request + GB-second; **không** tính tiền lúc idle (scale-to-zero). Câu "giảm chi phí function chạy ngắn nhưng gọi rất nhiều lần" → cân nhắc batching, giảm Duration, hoặc chuyển sang kiến trúc phù hợp hơn. Metric `Duration` để tinh chỉnh; `Throttles` báo vượt concurrency; `IteratorAge` báo consumer stream tụt hậu.

## 28.9 Viết & deploy function đầu tiên bằng CLI và SDK

Gói deployment đơn giản nhất là một file zip. Quy trình tạo function bằng CLI:

```bash
# 1. Viết code
cat > index.mjs <<'EOF'
export const handler = async (event) => {
  const name = event?.name ?? "world";
  return { message: `Hello, ${name}!` };
};
EOF

# 2. Đóng gói zip
zip function.zip index.mjs

# 3. Tạo function (role đã tạo ở 28.7)
aws lambda create-function \
  --function-name hello \
  --runtime nodejs20.x \
  --role arn:aws:iam::111122223333:role/my-func-role \
  --handler index.handler \
  --zip-file fileb://function.zip \
  --memory-size 256 \
  --timeout 10

# 4. Invoke đồng bộ và xem kết quả
aws lambda invoke \
  --function-name hello \
  --payload '{"name":"DVA"}' \
  --cli-binary-format raw-in-base64-out \
  out.json
cat out.json   # {"message":"Hello, DVA!"}

# 5. Cập nhật code khi sửa
zip function.zip index.mjs
aws lambda update-function-code --function-name hello --zip-file fileb://function.zip
```

Invoke từ một service/ứng dụng khác bằng AWS SDK for JavaScript v3:

```javascript
// Gọi Lambda từ code khác (ví dụ một backend Node.js) bằng SDK v3
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const client = new LambdaClient({ region: "ap-southeast-1" });

const res = await client.send(new InvokeCommand({
  FunctionName: "hello",
  InvocationType: "RequestResponse",         // đồng bộ; "Event" cho async
  Payload: Buffer.from(JSON.stringify({ name: "Truong" })),
}));

// Payload trả về là Uint8Array → decode về JSON
const body = JSON.parse(Buffer.from(res.Payload).toString());
console.log(res.StatusCode, body);            // 200 { message: 'Hello, Truong!' }
// res.FunctionError != null nghĩa là handler ném lỗi → kiểm tra body để lấy chi tiết
```

Trong thực tế, hiếm ai deploy bằng zip thủ công như trên cho production — bạn sẽ dùng **AWS SAM** (Chương 36) hoặc **CDK** (Chương 37) để định nghĩa function, role, trigger như Infrastructure as Code và deploy nhất quán. Nhưng nắm quy trình CLI thô giúp hiểu đúng từng mảnh và rất hữu ích khi debug.

> 💡 **Exam Tip:** `create-function` cần `--handler` đúng định dạng `<file>.<tên hàm export>` (ví dụ `index.handler`); sai handler → lỗi `Runtime.HandlerNotFound`. `--cli-binary-format raw-in-base64-out` cần thiết với AWS CLI v2 để truyền payload JSON dạng raw. Để deploy IaC chuẩn serverless, đề ưu tiên **SAM/CDK**, không phải zip thủ công.
