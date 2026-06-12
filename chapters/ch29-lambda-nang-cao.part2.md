## Hands-on Lab: Versions & weighted alias (canary), reserved + provisioned concurrency, ephemeral storage và quan sát throttling

**Mục tiêu lab:** Deploy một hàm Lambda, publish hai **version** bất biến, tạo một **alias** trỏ tới chúng theo tỉ lệ **weighted (canary)** để dịch chuyển traffic 90/10, cấu hình **reserved concurrency** để giới hạn và cô lập hàm, bật **provisioned concurrency** trên alias để khử cold start, chỉnh **ephemeral storage** (`/tmp`) lên trên mặc định 512 MB, rồi cố tình **ép throttling (429)** để quan sát hành vi và metric. Đây đúng là cụm điểm DVA-C02 hay xoáy: canary qua alias, hai loại concurrency, và đọc lỗi `TooManyRequestsException`.

**Chuẩn bị:**
- AWS CLI v2 với profile có `lambda:*`, `iam:*`, `cloudwatch:*`, `logs:*`.
- Node.js 18+ để đóng gói. Không cần dependency ngoài.
- Region xuyên suốt: `ap-southeast-1`. Lab này phát sinh phí provisioned concurrency khi bật — nhớ chạy phần Dọn dẹp.

```bash
export AWS_REGION="ap-southeast-1"
export ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
export FN="dva-ch29-fn"
export ROLE="dva-ch29-role"
```

### Bước 1: Tạo IAM role và hàm Lambda phiên bản đầu (v1)

```bash
cat > trust.json <<'EOF'
{ "Version": "2012-10-17", "Statement": [
  { "Effect": "Allow", "Principal": { "Service": "lambda.amazonaws.com" }, "Action": "sts:AssumeRole" } ] }
EOF

aws iam create-role --role-name "$ROLE" --assume-role-policy-document file://trust.json
aws iam attach-role-policy --role-name "$ROLE" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
sleep 10   # chờ IAM role propagate
```

Code v1 trả về `VERSION` đọc từ biến môi trường và ghi nhận `/tmp` còn trống bao nhiêu (để chứng minh ephemeral storage):

```javascript
// index.mjs
import { statfsSync, writeFileSync } from 'node:fs';

export const handler = async (event) => {
  // Cố tình ghi file vào /tmp để minh hoạ ephemeral storage tái dùng giữa các lần warm
  const path = '/tmp/marker.txt';
  writeFileSync(path, `invoked at ${Date.now()}\n`, { flag: 'a' });
  // Giữ container "bận" để dễ ép throttling ở Bước 6
  if (event.busyMs) {
    const end = Date.now() + event.busyMs;
    while (Date.now() < end) { /* spin */ }
  }
  return {
    version: process.env.VERSION || 'unset',
    tmpFreeMB: undefined  // /tmp size do cấu hình EphemeralStorage quyết định
  };
};
```

```bash
zip fn.zip index.mjs > /dev/null

aws lambda create-function \
  --function-name "$FN" \
  --runtime nodejs20.x \
  --handler index.handler \
  --role "arn:aws:iam::${ACCOUNT_ID}:role/${ROLE}" \
  --zip-file fileb://fn.zip \
  --environment "Variables={VERSION=v1}" \
  --memory-size 256 \
  --timeout 30

aws lambda wait function-active-v2 --function-name "$FN"
```

Publish version 1 (đóng băng code + cấu hình thành snapshot bất biến):

```bash
V1=$(aws lambda publish-version --function-name "$FN" \
  --query Version --output text)
echo "Version 1 = $V1"
```

> `$LATEST` là con trỏ tới code mới nhất, có thể đổi. **Version** là snapshot **immutable** — code và cấu hình (memory, env, timeout) đóng băng. Khi publish, môi trường biến `VERSION=v1` cũng bị đóng băng trong v1. Đây là nền tảng để canary an toàn.

### Bước 2: Sửa code/biến môi trường rồi publish version 2

```bash
aws lambda update-function-configuration --function-name "$FN" \
  --environment "Variables={VERSION=v2}"
aws lambda wait function-updated-v2 --function-name "$FN"

V2=$(aws lambda publish-version --function-name "$FN" \
  --query Version --output text)
echo "Version 2 = $V2"
```

Bây giờ v1 vẫn trả `version: v1`, v2 trả `version: v2`, dù cùng một code base — vì env var được đóng băng theo version.

### Bước 3: Tạo alias canary trỏ 90% v1, 10% v2

```bash
aws lambda create-alias --function-name "$FN" \
  --name prod \
  --function-version "$V1" \
  --routing-config "AdditionalVersionWeights={\"$V2\"=0.10}"
```

Gọi alias nhiều lần và đếm phân bố version (kỳ vọng ~90% v1, ~10% v2):

```bash
for i in $(seq 1 40); do
  aws lambda invoke --function-name "$FN:prod" \
    --payload '{}' --cli-binary-format raw-in-base64-out /tmp/o.json > /dev/null
  cat /tmp/o.json | python3 -c "import sys,json;print(json.load(sys.stdin)['version'])"
done | sort | uniq -c
```

Output mong đợi (xấp xỉ — phân phối ngẫu nhiên theo trọng số):

```
  36 v1
   4 v2
```

> **Weighted alias** là cách AWS-native làm **canary/linear deployment** cho Lambda. Trọng số đặt qua `AdditionalVersionWeights`; phần còn lại đi về `FunctionVersion` chính của alias. CodeDeploy với SAM (`AutoPublishAlias` + `DeploymentPreference`) thực chất tự động hoá việc dịch trọng số này theo thời gian (chi tiết ở Chương 36 và 41).

"Promote" canary thành 100% v2 = bỏ trọng số và đặt alias trỏ thẳng v2:

```bash
aws lambda update-alias --function-name "$FN" --name prod \
  --function-version "$V2" --routing-config '{}'
```

### Bước 4: Reserved concurrency — giới hạn và cô lập

```bash
# Giới hạn alias/hàm này tối đa 5 execution đồng thời
aws lambda put-function-concurrency \
  --function-name "$FN" --reserved-concurrent-executions 5

aws lambda get-function-concurrency --function-name "$FN"
```

Output:

```json
{ "ReservedConcurrentExecutions": 5 }
```

> **Reserved concurrency** làm 2 việc cùng lúc: (1) **đảm bảo** hàm luôn có 5 slot kể cả khi account bận; (2) **giới hạn trần** — hàm KHÔNG vượt quá 5, dù account còn dư. Nó trừ thẳng vào **unreserved concurrency pool** của account (mặc định tổng 1000/region). Đặt = 0 là cách "tắt mềm" một hàm (throttle 100%).

### Bước 5: Provisioned concurrency — khử cold start (đặt trên version/alias)

```bash
# Provisioned concurrency CHỈ gắn được vào version cụ thể hoặc alias, KHÔNG gắn $LATEST
aws lambda put-provisioned-concurrency-config \
  --function-name "$FN" --qualifier prod \
  --provisioned-concurrent-executions 2

# Theo dõi trạng thái cho tới READY
aws lambda get-provisioned-concurrency-config \
  --function-name "$FN" --qualifier prod \
  --query '{Status:Status,Allocated:AllocatedProvisionedConcurrentExecutions}'
```

Lúc đầu `Status: IN_PROGRESS`, sau ~1-2 phút thành `READY`:

```json
{ "Status": "READY", "Allocated": 2 }
```

> **Provisioned concurrency** giữ sẵn N môi trường thực thi đã **init xong** (đã chạy code khởi tạo ngoài handler), nên request đầu KHÔNG cold start. Khác reserved: provisioned tốn phí theo thời gian giữ sẵn (kể cả idle), còn reserved miễn phí. Provisioned **phải** trỏ qua qualifier (version/alias), không trỏ `$LATEST` được — đây là bẫy thi. Lưu ý: reserved concurrency của hàm phải ≥ provisioned đã cấu hình.

### Bước 6: Cấu hình ephemeral storage (`/tmp`) và ép throttling

Tăng `/tmp` từ mặc định **512 MB** lên 1024 MB (tối đa 10240 MB = 10 GB):

```bash
aws lambda update-function-configuration --function-name "$FN" \
  --ephemeral-storage '{"Size":1024}'
aws lambda wait function-updated-v2 --function-name "$FN"
aws lambda get-function-configuration --function-name "$FN" \
  --query EphemeralStorage
```

Output: `{ "Size": 1024 }`

Ép throttling: gọi 20 request song song với `busyMs=4000` (giữ container bận 4 giây) trong khi reserved concurrency chỉ = 5 → các request thừa bị throttle:

```bash
for i in $(seq 1 20); do
  aws lambda invoke --function-name "$FN:prod" \
    --payload '{"busyMs":4000}' --cli-binary-format raw-in-base64-out \
    /tmp/o$i.json --query StatusCode --output text 2>/tmp/e$i.txt &
done
wait

# Đếm số lần bị throttle
grep -l "TooManyRequestsException\|429" /tmp/e*.txt 2>/dev/null | wc -l
```

Với **synchronous invoke**, request vượt concurrency trả lỗi `TooManyRequestsException` (HTTP 429) — caller chịu trách nhiệm retry. Xem metric `Throttles`:

```bash
START=$(date -u -v-5M +%FT%TZ 2>/dev/null || date -u -d '5 min ago' +%FT%TZ)
END=$(date -u +%FT%TZ)
aws cloudwatch get-metric-statistics \
  --namespace AWS/Lambda --metric-name Throttles \
  --dimensions Name=FunctionName,Value="$FN" \
  --start-time "$START" --end-time "$END" \
  --period 300 --statistics Sum \
  --query 'Datapoints[].Sum'
```

> Khác biệt theo loại invoke: **synchronous** → 429 trả ngay cho caller. **Asynchronous** (S3/SNS/EventBridge) → Lambda tự **retry** event bị throttle trong tối đa ~6 giờ rồi mới đẩy vào DLQ/destination. **Event source mapping** (SQS/Kinesis) → poller tự backoff, message ở lại queue/stream (chi tiết ở Chương 30). Câu hỏi "throttle thì ai retry" phụ thuộc loại invoke này.

### Dọn dẹp tài nguyên

```bash
# Xoá provisioned concurrency TRƯỚC (đang tính phí theo giờ)
aws lambda delete-provisioned-concurrency-config --function-name "$FN" --qualifier prod
aws lambda delete-alias --function-name "$FN" --name prod
aws lambda delete-function-concurrency --function-name "$FN"
aws lambda delete-function --function-name "$FN"

aws iam detach-role-policy --role-name "$ROLE" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam delete-role --role-name "$ROLE"

rm -f trust.json index.mjs fn.zip /tmp/o*.json /tmp/e*.txt /tmp/o.json
```

> Thứ tự quan trọng: phải xoá **provisioned concurrency config** trước (hoặc nó vẫn tính phí), rồi mới xoá alias/function. Reserved concurrency miễn phí nhưng nên xoá để trả slot về unreserved pool của account.

## 💡 Exam Tips chương 29

- **Reserved vs Provisioned concurrency** — cặp gài bẫy số 1: *Reserved* = đặt **trần + sàn** số execution đồng thời cho 1 hàm, **miễn phí**, trừ vào pool 1000 của account, đặt = 0 để tắt hàm. *Provisioned* = giữ sẵn môi trường đã init để **khử cold start**, **tốn phí** theo thời gian, **phải** gắn vào version/alias (không phải `$LATEST`).
- **Account concurrency mặc định = 1000/region** (soft limit, xin tăng được). **Burst concurrency** ban đầu 500–3000 tuỳ region rồi tăng dần +500/phút. Vượt → `TooManyRequestsException` (HTTP **429**).
- **Throttle thì ai retry?** Synchronous → caller nhận 429 và tự retry. Asynchronous → Lambda retry tự động (tới ~6 giờ) rồi DLQ/destination. Event source mapping (SQS/Kinesis) → message ở lại nguồn, poller backoff.
- **Version vs alias:** version là snapshot **immutable** (code + config + env đóng băng), có ARN với số (`:1`); `$LATEST` là con trỏ thay đổi được. **Alias** là con trỏ có tên (`:prod`) trỏ tới 1 version, **canary** được nhờ `AdditionalVersionWeights`.
- **Weighted alias** là canary/linear native của Lambda. Provisioned concurrency và event source mapping nên trỏ vào **alias**, không trỏ `$LATEST`, để dịch traffic không gián đoạn.
- **Lambda layers:** tối đa **5 layer/hàm**, tổng unzip của function + tất cả layer ≤ **250 MB**. Layer giải nén vào `/opt`. Dùng để chia sẻ dependency/runtime, KHÔNG để tăng giới hạn package.
- **Container image cho Lambda:** tối đa **10 GB**, push lên ECR, phải tuân Lambda Runtime API. Zip thì giới hạn 50 MB (nén, qua API) / 250 MB (giải nén). Image > 250 MB unzip → bắt buộc dùng container image.
- **Ephemeral storage `/tmp`:** mặc định **512 MB**, cấu hình **512–10240 MB**. Là nơi duy nhất ghi được trong execution environment và **được tái dùng giữa các lần warm**; KHÔNG bền vững giữa các cold start.
- **Lambda trong VPC:** dùng Hyperplane ENI (đỡ cold start so với trước). Trong VPC, hàm **mất internet mặc định** — cần **NAT Gateway** (subnet private) để ra internet, hoặc **VPC Endpoint** để gọi AWS service không qua internet. Cần `ec2:CreateNetworkInterface...` trong role (managed `AWSLambdaVPCAccessExecutionRole`).
- **SnapStart** (Java, mở rộng cho Python/.NET): chụp **snapshot** môi trường đã init sau khi publish version → giảm cold start tới ~10x, **miễn phí** cho Java. Chỉ áp dụng cho **version đã publish**, không cho `$LATEST`. Cẩn thận uniqueness (random seed/connection) sau khi khôi phục snapshot.
- **Lambda@Edge vs CloudFront Functions:** CloudFront Functions = JS thuần, sub-millisecond, chỉ viewer request/response, header/URL nhẹ, cực rẻ. Lambda@Edge = Node/Python, tới 5–30s, gọi được AWS service/network, chạy ở Regional Edge Cache, cho cả origin request/response. "Header manipulation đơn giản, throughput cực cao" → CloudFront Functions.
- **Function URL** = HTTPS endpoint tích hợp sẵn (`AWS_IAM` hoặc `NONE` auth), không cần API Gateway — dùng webhook/đơn giản. **Recursive loop detection:** Lambda tự phát hiện vòng lặp Lambda↔SQS/SNS và dừng sau ~16 lần để chặn chi phí runaway. **Code signing** ép chỉ chạy artifact đã ký qua AWS Signer.

## Quiz chương 29 (10 câu)

**Câu 1.** Một developer muốn dịch dần 10% traffic sang phiên bản mới của Lambda để canary, phần còn lại giữ version cũ, không cần CodeDeploy. Cách native đơn giản nhất?
- A. Tạo hai hàm Lambda riêng và chia traffic bằng Route 53
- B. Dùng alias với `AdditionalVersionWeights` đặt 0.10 cho version mới
- C. Đặt provisioned concurrency cho cả hai version
- D. Bật SnapStart trên version mới

**Câu 2.** Hàm A bị spike và "ăn" hết concurrency khiến hàm B trong cùng account bị throttle. Cách cô lập để B luôn có capacity?
- A. Bật provisioned concurrency cho B
- B. Đặt reserved concurrency cho A (và/hoặc B)
- C. Tăng memory của B
- D. Chuyển B sang container image

**Câu 3.** Developer cấu hình provisioned concurrency để loại bỏ cold start nhưng nhận lỗi khi trỏ vào `$LATEST`. Vì sao?
- A. Provisioned concurrency chỉ gắn vào version đã publish hoặc alias
- B. `$LATEST` không hỗ trợ runtime Node.js
- C. Phải bật SnapStart trước
- D. Account chưa đủ unreserved concurrency

**Câu 4.** Một hàm cần 3 GB dung lượng tạm để giải nén và xử lý file lớn trong khi chạy. Cấu hình đúng?
- A. Mount EFS rồi ghi vào đó
- B. Tăng memory lên 3 GB
- C. Đặt ephemeral storage (`/tmp`) Size = 3072 MB
- D. Dùng container image 10 GB

**Câu 5.** Hàm Lambda được gọi **bất đồng bộ** từ S3 và đang bị throttle. Điều gì xảy ra với các event bị throttle?
- A. Caller nhận ngay lỗi 429
- B. Event bị mất ngay lập tức
- C. Lambda tự retry event trong tối đa ~6 giờ rồi đưa vào DLQ/destination nếu vẫn lỗi
- D. Event được ghi vào CloudTrail

**Câu 6.** Một hàm cần gọi RDS trong subnet private VÀ gọi một public API bên ngoài. Cấu hình mạng đúng?
- A. Đặt hàm trong VPC subnet private + NAT Gateway cho lối ra internet
- B. Đặt hàm trong VPC public subnet với public IP
- C. Bỏ hàm khỏi VPC để có internet
- D. Dùng Internet Gateway gắn trực tiếp vào Lambda

**Câu 7.** Team cần biến đổi đơn giản HTTP header tại CloudFront edge với throughput cực cao, latency sub-millisecond và chi phí thấp nhất. Chọn gì?
- A. Lambda@Edge origin request
- B. CloudFront Functions (viewer request)
- C. Lambda trong VPC
- D. API Gateway custom authorizer

**Câu 8.** Một package Lambda zip giải nén lên 600 MB do thư viện ML lớn. Cách deploy hợp lệ?
- A. Tách thành nhiều layer cho đủ
- B. Dùng container image (tối đa 10 GB)
- C. Tăng ephemeral storage lên 1 GB
- D. Bật provisioned concurrency

**Câu 9.** Hàm Java có cold start cao do init nặng. Yêu cầu: giảm cold start mà không trả thêm phí giữ sẵn môi trường. Lựa chọn phù hợp NHẤT?
- A. Provisioned concurrency
- B. SnapStart cho version đã publish
- C. Tăng reserved concurrency
- D. Chuyển sang Node.js

**Câu 10.** Một developer cần endpoint HTTPS đơn giản cho webhook gọi thẳng Lambda, không muốn dựng API Gateway, và muốn dùng IAM để xác thực. Giải pháp?
- A. Lambda Function URL với AuthType `AWS_IAM`
- B. Lambda Function URL với AuthType `NONE`
- C. ALB target group
- D. CloudFront Function

### Đáp án & giải thích

**Câu 1 — Đáp án B.** Alias với `AdditionalVersionWeights={newVersion=0.10}` là cơ chế canary native của Lambda: 10% đi version mới, 90% đi version chính của alias, dịch trọng số tuỳ ý mà không cần hạ tầng ngoài. A sai: hai hàm + Route 53 phức tạp, không phải cách Lambda khuyến nghị và Route 53 cân bằng theo DNS, thô. C sai: provisioned concurrency liên quan cold start, không chia traffic. D sai: SnapStart giảm cold start, không canary.

**Câu 2 — Đáp án B.** Reserved concurrency vừa **giới hạn trần** của A (chặn nó ăn hết pool) vừa **đảm bảo sàn** capacity; đặt reserved cho A để A không vượt mức, hoặc cho B để B luôn có slot dành riêng. A sai: provisioned chỉ giữ sẵn môi trường, không bảo vệ B khỏi A ăn hết unreserved pool. C sai: memory không liên quan cô lập concurrency. D sai: container image không thay đổi cơ chế concurrency.

**Câu 3 — Đáp án A.** Provisioned concurrency **chỉ** gắn vào một version đã publish hoặc một alias, không bao giờ trỏ `$LATEST` (vì `$LATEST` thay đổi được, không có snapshot ổn định để giữ sẵn). B sai: runtime không liên quan. C sai: SnapStart độc lập, không phải tiền đề. D sai: thiếu unreserved sẽ báo lỗi khác, không phải lỗi do trỏ `$LATEST`.

**Câu 4 — Đáp án C.** `/tmp` (ephemeral storage) cấu hình 512–10240 MB; đặt 3072 MB là cách đơn giản, đúng mục đích cho dung lượng tạm trong một lần chạy. A sai: EFS dùng cho dữ liệu chia sẻ/bền vững, thừa thãi cho scratch tạm và thêm cấu hình VPC. B sai: tăng memory không tăng `/tmp` (chúng là hai cấu hình tách biệt). D sai: container image liên quan kích thước code, không phải dung lượng runtime tạm.

**Câu 5 — Đáp án C.** Với invoke **bất đồng bộ**, Lambda đưa event vào internal queue và **tự retry** khi bị throttle/lỗi trong tối đa ~6 giờ; hết retry mới đẩy vào DLQ/destination. A sai: 429 trả về caller là hành vi của invoke đồng bộ. B sai: event không mất ngay — async có retry. D sai: CloudTrail ghi API call, không phải nơi chứa event bị throttle.

**Câu 6 — Đáp án A.** Lambda trong VPC mất internet mặc định; để vừa gọi RDS private vừa ra public API cần **NAT Gateway** ở public subnet và route từ subnet private của hàm. B sai: Lambda ENI trong VPC không nhận public IP nên public subnet không giúp ra internet. C sai: bỏ khỏi VPC thì mất khả năng gọi RDS trong subnet private. D sai: không gắn Internet Gateway trực tiếp vào Lambda được; lối ra cần NAT.

**Câu 7 — Đáp án B.** CloudFront Functions chạy JS thuần ngay tại edge location, latency sub-millisecond, throughput rất cao, rẻ, phù hợp thao tác header/URL nhẹ ở viewer request/response. A sai: Lambda@Edge nặng hơn, latency cao hơn, đắt hơn — dùng khi cần network/AWS SDK. C sai: Lambda trong VPC không liên quan edge. D sai: API Gateway authorizer không chạy tại CloudFront edge.

**Câu 8 — Đáp án B.** Zip giải nén có trần **250 MB**; 600 MB vượt nên phải dùng **container image** (tới 10 GB). A sai: layer cũng tính vào tổng 250 MB unzip nên không vượt được giới hạn này. C sai: ephemeral storage là runtime scratch, không phải kích thước package. D sai: provisioned concurrency không liên quan kích thước deploy.

**Câu 9 — Đáp án B.** SnapStart chụp snapshot môi trường Java đã init sau khi publish version, khôi phục nhanh → giảm cold start mạnh và **miễn phí** cho Java. A sai: provisioned concurrency giảm cold start nhưng **tốn phí** giữ sẵn. C sai: reserved concurrency không ảnh hưởng cold start. D sai: đổi ngôn ngữ là thay đổi lớn, không phải giải pháp tối ưu cho yêu cầu.

**Câu 10 — Đáp án A.** Lambda Function URL cho HTTPS endpoint tích hợp sẵn; chọn AuthType `AWS_IAM` để xác thực bằng SigV4/IAM. B sai: `NONE` là public không xác thực, trái yêu cầu IAM auth. C sai: ALB thêm hạ tầng không cần thiết cho một webhook đơn. D sai: CloudFront Function không phải endpoint gọi thẳng Lambda.

## Tóm tắt chương

- **Version** là snapshot immutable (code + config + env), `$LATEST` là con trỏ thay đổi được; **alias** là con trỏ có tên trỏ tới version và hỗ trợ **weighted routing** để canary.
- **Weighted alias** (`AdditionalVersionWeights`) là cơ chế canary/linear native; CodeDeploy/SAM tự động hoá việc dịch trọng số theo thời gian.
- **Reserved concurrency**: miễn phí, đặt trần + sàn cho một hàm, trừ vào pool account 1000/region; đặt = 0 để tắt mềm hàm.
- **Provisioned concurrency**: tốn phí, giữ sẵn môi trường đã init để khử cold start, **bắt buộc** trỏ version/alias (không `$LATEST`); reserved phải ≥ provisioned.
- Vượt concurrency → `TooManyRequestsException` (429); cách retry khác nhau theo loại invoke: sync (caller retry), async (Lambda retry tới ~6h rồi DLQ), event source mapping (message ở lại nguồn).
- **Ephemeral storage `/tmp`**: mặc định 512 MB, cấu hình 512–10240 MB; tái dùng giữa các lần warm, không bền vững qua cold start.
- **Layers**: tối đa 5/hàm, tổng unzip ≤ 250 MB, giải nén vào `/opt`; **container image**: tới 10 GB, dùng khi package > 250 MB unzip.
- **Lambda trong VPC**: mất internet mặc định, cần NAT Gateway để ra internet hoặc VPC Endpoint để gọi AWS service; cần quyền tạo ENI.
- **SnapStart** (Java) giảm cold start ~10x, miễn phí, chỉ cho version đã publish; chú ý uniqueness sau khôi phục snapshot.
- **CloudFront Functions** (JS, sub-ms, viewer-only, rẻ) vs **Lambda@Edge** (Node/Python, network/AWS SDK, viewer+origin) — chọn theo độ phức tạp và nhu cầu network.
- **Function URL** cho HTTPS endpoint đơn giản (`AWS_IAM`/`NONE`); **recursive loop detection** chặn vòng lặp tốn kém; **code signing** ép chạy artifact đã ký qua AWS Signer.
