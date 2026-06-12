# Chương 29: AWS Lambda nâng cao

> **Trọng tâm DVA-C02:** Đây là một trong những chương nặng điểm nhất của domain Development và Troubleshooting. Câu hỏi xoáy vào: **concurrency** (phân biệt reserved vs provisioned concurrency, hiện tượng throttling `429`/`TooManyRequestsException`, burst limit), **versions & aliases** với **weighted alias** để làm canary/blue-green, **Lambda layers** và **container images**, **SnapStart** giảm cold start, cấu hình **ephemeral storage `/tmp`** và gắn **EFS**, đặt Lambda **trong VPC** (ENI, Hyperplane, cần gì để ra internet), **performance tuning** (memory↔CPU tỉ lệ thuận), so sánh **Lambda@Edge vs CloudFront Functions**, **code signing**, **function URLs**, và **recursive loop detection**. Phần lớn câu hỏi ở dạng tình huống "least cold start", "guarantee throughput", "shift 10% traffic".

## Mục tiêu chương

- Hiểu sâu mô hình **concurrency** của Lambda: account concurrency limit, burst quota, cách reserved và provisioned concurrency hoạt động, vì sao và khi nào bị throttle.
- Dùng **versions, aliases và weighted alias** để triển khai canary/blue-green an toàn, kết hợp với CodeDeploy (chi tiết shifting ở Chương 41).
- Đóng gói code bằng **Lambda layers** và **container images**; biết giới hạn kích thước và khi nào chọn cái nào.
- Giảm cold start bằng **provisioned concurrency** và **SnapStart**; tinh chỉnh **memory↔CPU**, bundle size để tối ưu hiệu năng và chi phí.
- Cấu hình **ephemeral storage `/tmp`**, gắn **EFS**, và đặt Lambda **trong VPC** đúng cách (ENI, NAT Gateway để ra internet).
- Phân biệt **Lambda@Edge vs CloudFront Functions**, dùng **function URLs**, bật **code signing** và hiểu **recursive loop detection**.

## 29.1 Concurrency: account limit, reserved & provisioned concurrency

**Concurrency** là số lần thực thi (execution environment) chạy **đồng thời** tại một thời điểm — không phải số request/giây. Một execution environment xử lý đúng **một** event tại một thời điểm; xử lý xong mới nhận event tiếp theo. Công thức xấp xỉ:

```
Concurrency = (số request mỗi giây) × (thời gian xử lý trung bình tính bằng giây)
```

Ví dụ: 100 request/giây, mỗi request chạy 200ms (0.2s) → cần `100 × 0.2 = 20` concurrent executions. Nếu mỗi request chạy 2 giây → cần `100 × 2 = 200`. Cùng một tải request nhưng hàm chạy lâu hơn thì ngốn concurrency nhiều hơn — đây là điểm bẫy hay gặp.

**Account concurrency limit** mặc định là **1000** concurrent executions cho mỗi account/region (số này có thể request tăng qua Service Quotas). Đây là **pool dùng chung** cho tất cả hàm trong region đó. Khi tổng concurrency của mọi hàm chạm 1000, các invocation tiếp theo bị **throttle**.

Có hai cơ chế cấp phát concurrency cho từng hàm:

**Reserved concurrency** — bạn "khoanh" một phần của pool 1000 cho riêng một hàm. Ví dụ đặt reserved = 100 cho hàm `payment`:
- `payment` được **đảm bảo** tối đa 100 concurrent (không bị hàm khác cướp mất).
- Đồng thời `payment` bị **giới hạn cứng** ở 100 — vượt 100 sẽ throttle, dù pool còn trống.
- Pool dùng chung cho các hàm còn lại giảm xuống `1000 − 100 = 900`.
- Reserved concurrency **miễn phí**. Nó vừa là sàn đảm bảo, vừa là trần giới hạn.

> 💡 **Exam Tip:** Đặt **reserved concurrency = 0** là cách "tắt" một hàm (kill switch) — mọi invocation đều bị throttle ngay, hữu ích khi cần khẩn cấp ngừng một hàm đang gây hại mà không xoá nó.

**Provisioned concurrency** — bạn yêu cầu Lambda **khởi tạo sẵn** N execution environment, init code đã chạy xong, sẵn sàng nhận request **không có cold start**. Khác biệt cốt lõi:
- Reserved concurrency: chỉ giới hạn/đảm bảo *số lượng*, environment vẫn cold-start khi cần.
- Provisioned concurrency: environment đã **warm sẵn**, độ trễ thấp và ổn định ngay từ request đầu.
- Provisioned concurrency **tốn tiền** kể cả khi không có request (trả cho dung lượng giữ ấm) — đây là điểm phân biệt quan trọng.

Provisioned concurrency phải gắn vào một **version hoặc alias cụ thể** (không gắn được vào `$LATEST`). Thường kết hợp **Application Auto Scaling** để scale số provisioned theo lịch hoặc theo utilization.

```bash
# Đặt reserved concurrency = 50 cho hàm (vừa đảm bảo vừa giới hạn)
aws lambda put-function-concurrency \
  --function-name payment \
  --reserved-concurrent-executions 50

# Cấu hình provisioned concurrency = 20 cho alias "prod" (đã trỏ tới version cố định)
aws lambda put-provisioned-concurrency-config \
  --function-name payment \
  --qualifier prod \
  --provisioned-concurrent-executions 20
```

> 💡 **Exam Tip:** Đề hay hỏi "giảm cold start cho một API nhạy độ trễ" → **provisioned concurrency**. "Đảm bảo một hàm critical luôn có đủ slot và không bị hàm khác chiếm" → **reserved concurrency**. "Cách rẻ nhất chấp nhận cold start thỉnh thoảng" → không dùng provisioned, để mặc định.

## 29.2 Throttling, burst limit và scaling behavior

Khi vượt giới hạn concurrency, Lambda trả lỗi throttle. Hành vi sau throttle **phụ thuộc loại invocation** (chi tiết các loại ở Chương 28):

- **Synchronous** (API Gateway, ALB, SDK gọi trực tiếp): trả ngay `429 TooManyRequestsException`. Caller phải tự retry với exponential backoff.
- **Asynchronous** (S3, SNS, EventBridge): Lambda **tự retry** event bị throttle trong tối đa ~6 giờ với backoff; quá hạn thì gửi sang DLQ/destination (chi tiết ở Chương 28 & 30).
- **Event source mapping** (SQS, Kinesis, DynamoDB Streams — chi tiết Chương 30): Lambda poller tự điều tiết và retry theo cơ chế của từng nguồn.

**Burst concurrency** — Lambda không nhảy thẳng từ 0 lên 1000 ngay lập tức. Khi có spike đột ngột, account được cấp một **burst** ban đầu (tuỳ region, thường **500–3000** concurrent ngay lập tức), sau đó tăng thêm **500 concurrent mỗi phút** cho đến khi chạm account limit. Nếu spike vượt tốc độ scale này, phần dư bị throttle tạm thời cho tới khi pool kịp mở rộng.

> 💡 **Exam Tip:** Nếu thấy `429`/throttling dù chưa chạm 1000 → thường do **burst limit** (tải tăng quá nhanh) hoặc **reserved concurrency của hàm đặt quá thấp**. Cách khắc phục: dùng provisioned concurrency để có sẵn slot warm, hoặc request tăng account limit, hoặc đặt nguồn đệm bằng SQS để hấp thụ spike.

CloudWatch metrics cần nhớ để troubleshoot: `Throttles` (số invocation bị throttle), `ConcurrentExecutions`, `ProvisionedConcurrencyUtilization`, `ProvisionedConcurrencySpilloverInvocations` (số request tràn ra ngoài provisioned, phải cold-start).

## 29.3 Versions & aliases, weighted alias (canary)

Mặc định mỗi hàm có version `$LATEST` — luôn trỏ tới code mới nhất, **có thể sửa**. Khi **publish** một version (`publish-version`), Lambda chụp lại snapshot bất biến của code + cấu hình, gán số version tăng dần (`1`, `2`, `3`...). Version đã publish là **immutable** — không sửa được nữa. ARN có dạng `...:function:my-fn:3`.

**Alias** là con trỏ có tên (`prod`, `dev`, `staging`) trỏ tới một version. ARN: `...:function:my-fn:prod`. Lợi ích: client gọi qua alias ổn định, bạn chỉ cần đổi alias trỏ sang version mới khi deploy mà không phải đổi cấu hình client.

**Weighted alias (traffic shifting / canary)** — một alias có thể trỏ tới **hai version cùng lúc** với tỉ trọng. Ví dụ alias `prod` trỏ 90% version 1 và 10% version 2 — Lambda định tuyến ngẫu nhiên theo tỉ trọng. Đây là cơ chế **canary deployment** native của Lambda.

```bash
# Publish version mới từ $LATEST
aws lambda publish-version --function-name my-fn   # → trả về Version: "2"

# Tạo alias prod trỏ version 1
aws lambda create-alias --function-name my-fn --name prod --function-version 1

# Shift 10% traffic sang version 2 (canary), 90% giữ ở version 1
aws lambda update-alias --function-name my-fn --name prod \
  --function-version 1 \
  --routing-config '{"AdditionalVersionWeights": {"2": 0.1}}'

# Khi ổn → cắt 100% sang version 2
aws lambda update-alias --function-name my-fn --name prod --function-version 2 \
  --routing-config '{}'
```

> 💡 **Exam Tip:** Weighted alias **không** dùng được với `$LATEST` — cả hai phía phải là version đã publish. Provisioned concurrency cũng chỉ gắn được vào version/alias đã publish, không gắn vào `$LATEST`. Nếu đề nói "shift traffic dần 10% mỗi phút và tự rollback khi có lỗi" → đó là **CodeDeploy + Lambda alias** (linear/canary, hooks PreTraffic/PostTraffic — chi tiết Chương 41 & SAM ở Chương 36), CodeDeploy điều khiển weighted alias bên dưới.

## 29.4 Lambda layers và container images

**Lambda layers** là gói `.zip` chứa thư viện, dependency, runtime tuỳ biến hoặc dữ liệu dùng chung, được tách khỏi code hàm. Khi hàm chạy, nội dung layer được giải nén vào `/opt`. Lợi ích: tách dependency nặng khỏi code, tái sử dụng giữa nhiều hàm, giảm dung lượng deploy package của từng hàm.

Quy tắc cần nhớ:
- Một hàm gắn tối đa **5 layers**.
- Tổng dung lượng (function code + tất cả layers) sau giải nén **không vượt 250 MB** (unzipped). Đây là limit hay bị hỏi.
- Layer được version hoá; gắn theo ARN có số version cụ thể.
- Layer có thể share cross-account qua resource policy.

```bash
# Publish một layer từ file zip (chứa nodejs/node_modules/...)
aws lambda publish-layer-version \
  --layer-name shared-deps \
  --zip-file fileb://layer.zip \
  --compatible-runtimes nodejs20.x

# Gắn layer vào hàm
aws lambda update-function-configuration --function-name my-fn \
  --layers arn:aws:lambda:ap-southeast-1:111122223333:layer:shared-deps:1
```

**Container images cho Lambda** — đóng gói hàm thành Docker image (dựa trên AWS base image hoặc base tuỳ chỉnh implement Lambda Runtime API), push lên **ECR** (chi tiết ECR ở Chương 16), rồi Lambda chạy trực tiếp image đó.

| Tiêu chí | ZIP (+ layers) | Container image |
|---|---|---|
| Giới hạn kích thước | 50 MB (zipped upload trực tiếp), 250 MB unzipped | **Tối đa 10 GB** |
| Lưu trữ | S3 (do Lambda quản) | **ECR** (bạn quản, IAM pull) |
| Build pipeline | Đơn giản, zip code | Dockerfile, build/push image |
| Khi nào dùng | Hàm nhỏ/vừa, dependency gọn | Dependency lớn (ML model, binary nặng), muốn dùng Docker tooling sẵn có |
| Layers | Hỗ trợ | Không — gói mọi thứ vào image |

> 💡 **Exam Tip:** Khi deployment package vượt **250 MB** unzipped (ví dụ thư viện ML như numpy/pandas/torch) → chọn **container image** (lên tới 10 GB). Đề thường đặt bẫy "dependency 2GB" để loại trừ ZIP/layers.

## 29.5 SnapStart: giảm cold start không tốn phí giữ ấm

**SnapStart** giảm cold start bằng cách: trong lúc bạn publish version, Lambda khởi tạo execution environment một lần, chạy xong phase Init, rồi chụp lại một **snapshot Firecracker microVM** (gồm memory + disk state) đã được mã hoá và cache. Khi có invocation cold, Lambda **khôi phục từ snapshot** thay vì init lại từ đầu — cắt phần lớn thời gian init (thường giảm cold start hàng giây xuống mức mili-giây).

Điểm khác biệt then chốt với provisioned concurrency: SnapStart **không tính phí giữ ấm**, không cần giữ environment chạy sẵn — nó tối ưu chính phase Init. Tuy nhiên SnapStart ban đầu chỉ hỗ trợ một số runtime (Java rồi mở rộng sang Python, .NET); cần kiểm tra runtime hỗ trợ.

Bẫy lập trình với SnapStart — vì snapshot được chụp một lần và tái dùng cho nhiều environment:
- **Uniqueness/randomness:** giá trị sinh trong phase Init (random seed, UUID, token) sẽ giống nhau trên mọi environment khôi phục từ snapshot → phải sinh lại trong handler hoặc dùng runtime hooks (`afterRestore`).
- **Connection ôi thiu:** kết nối DB/network mở trong Init có thể chết khi snapshot khôi phục sau đó → nên mở lại trong hook `afterRestore`.

> 💡 **Exam Tip:** SnapStart vs Provisioned Concurrency: cả hai giảm cold start. SnapStart **không tốn phí thêm** (chỉ tối ưu init, hợp khi muốn rẻ), nhưng có ràng buộc runtime và bẫy uniqueness. Provisioned concurrency tốn phí giữ ấm nhưng đảm bảo độ trễ thấp tuyệt đối và hỗ trợ mọi runtime. Không bật đồng thời SnapStart và provisioned concurrency trên cùng version.

## 29.6 Ephemeral storage /tmp và Lambda + EFS

Mỗi execution environment có thư mục ghi tạm **`/tmp`**. Mặc định 512 MB, có thể cấu hình **`EphemeralStorage`** từ **512 MB đến 10 GB** (10240 MB). Đặc điểm:
- `/tmp` tồn tại theo vòng đời environment — nhiều invocation trên cùng environment **dùng chung** dữ liệu `/tmp` (tận dụng để cache file, nhưng nhớ dọn để tránh rò rỉ giữa các lần gọi).
- Đây là disk cục bộ, **không** chia sẻ giữa các environment khác nhau.

```bash
# Tăng ephemeral storage /tmp lên 2 GB
aws lambda update-function-configuration --function-name my-fn \
  --ephemeral-storage '{"Size": 2048}'
```

**Lambda + EFS** — gắn một **EFS Access Point** vào hàm để có **shared persistent storage** dùng chung giữa các invocation và cả các hàm/dịch vụ khác (chi tiết EFS ở Chương 5). Yêu cầu:
- Hàm phải nằm **trong VPC** cùng các mount target của EFS.
- Dùng **EFS Access Point** (định nghĩa POSIX user/permission và root directory) — Lambda mount tại đường dẫn bạn chọn (ví dụ `/mnt/data`).
- Hữu ích khi cần dataset lớn dùng chung, ghi state bền vững, hoặc nhiều hàm cùng thao tác trên một bộ file.

| Tiêu chí | `/tmp` (ephemeral) | EFS |
|---|---|---|
| Bền vững | Mất khi environment bị thu hồi | **Bền vững**, tồn tại độc lập |
| Chia sẻ giữa các hàm | Không | **Có** (qua mount chung) |
| Dung lượng | 512 MB – 10 GB | Gần như không giới hạn |
| Yêu cầu VPC | Không | **Có** |
| Độ trễ | Thấp nhất (local disk) | Cao hơn (network filesystem) |

> 💡 **Exam Tip:** "Lưu file lớn dùng chung giữa nhiều Lambda và bền vững" → **EFS**. "Cần thêm chỗ ghi tạm trong một invocation (giải nén, xử lý ảnh)" → tăng **ephemeral storage `/tmp`** (rẻ và đơn giản hơn EFS, không cần VPC).

## 29.7 Lambda trong VPC: ENI, Hyperplane và ra internet

Mặc định Lambda chạy trong VPC do AWS quản, có sẵn internet — nhưng **không** truy cập được tài nguyên private của bạn (RDS private, ElastiCache, EC2 trong subnet riêng). Để truy cập, bạn cấu hình hàm **trong VPC** bằng cách chỉ định **subnets** và **security groups**.

Cơ chế bên dưới: Lambda tạo **Hyperplane ENI** (Elastic Network Interface) — ENI dùng chung được Lambda quản, ánh xạ nhiều execution environment qua một ENI nên không tốn ENI cho mỗi concurrent execution (kiến trúc cũ trước đây tạo ENI/environment gây cold start lâu; Hyperplane đã khắc phục). ENI được tạo lần đầu khi hàm vào VPC; sau đó tái dùng.

**Bẫy lớn nhất — mất internet:** khi đặt Lambda trong VPC, hàm **mất quyền ra internet mặc định**. Để gọi public API/dịch vụ AWS qua internet, bạn phải:
- Đặt hàm trong **private subnet** + route tới **NAT Gateway** ở public subnet (Lambda **không** có public IP nên không dùng được Internet Gateway trực tiếp).
- Hoặc dùng **VPC Endpoint** (Gateway endpoint cho S3/DynamoDB; Interface/PrivateLink cho dịch vụ khác — chi tiết Chương 11) để gọi dịch vụ AWS mà không qua internet.

> 💡 **Exam Tip:** "Lambda trong VPC cần gọi S3 / DynamoDB" → dùng **VPC Gateway Endpoint** (miễn phí, không qua NAT). "Lambda trong VPC cần gọi public internet hoặc API ngoài" → cần **NAT Gateway** (Lambda không dùng IGW trực tiếp vì không có public IP). Câu hỏi kinh điển: "Lambda truy cập được RDS private nhưng gọi external API bị timeout" → thiếu NAT Gateway.

Cần IAM permission `ec2:CreateNetworkInterface`, `DescribeNetworkInterfaces`, `DeleteNetworkInterface` trong execution role (đã có sẵn trong managed policy `AWSLambdaVPCAccessExecutionRole`).

## 29.8 Performance tuning: memory↔CPU, bundle size

Trong Lambda bạn **chỉ cấu hình memory** (từ **128 MB đến 10240 MB**, bước 1 MB). CPU được cấp **tỉ lệ thuận** với memory: ở ~1769 MB hàm nhận tương đương **1 vCPU đầy đủ**; cấp tối đa 10240 MB ứng với khoảng 6 vCPU. Network bandwidth cũng tăng theo memory.

Hệ quả tuning quan trọng: tăng memory không chỉ cho nhiều RAM mà còn **nhiều CPU hơn → chạy nhanh hơn**. Với hàm CPU-bound, tăng memory có thể khiến hàm chạy nhanh đến mức **tổng chi phí giảm** (chi phí = GB-giây = memory × thời gian; nếu thời gian giảm nhiều hơn mức memory tăng thì rẻ hơn). Dùng **AWS Lambda Power Tuning** (state machine Step Functions) để tìm điểm memory tối ưu giữa tốc độ và chi phí.

Các kỹ thuật giảm cold start & tăng tốc khác:
- **Giảm bundle size:** chỉ đóng gói dependency cần thiết, tree-shaking, dùng layer cho phần dùng chung. Package nhỏ → init nhanh.
- **Khởi tạo client SDK ngoài handler:** đặt việc tạo client (DynamoDB, S3...) ở scope module, ngoài handler, để tái dùng qua các invocation trên cùng environment (chi tiết execution environment lifecycle ở Chương 28).
- **Tận dụng connection reuse:** với SDK v3, đặt `AWS_NODEJS_CONNECTION_REUSE_ENABLED=1` (v3 bật keep-alive mặc định) để tái dùng TCP/TLS connection.
- **SnapStart / provisioned concurrency** cho phần init nặng (mục 29.5).

```javascript
// GIỮ client ở scope module → tái dùng qua các invocation (warm start)
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
const ddb = new DynamoDBClient({}); // chạy 1 lần trong phase Init

export const handler = async (event) => {
  // handler nhẹ, chỉ dùng lại client đã có
  return { statusCode: 200 };
};
```

> 💡 **Exam Tip:** Memory là "núm vặn" duy nhất ảnh hưởng CPU. Hàm chậm và CPU-bound mà bạn **tăng memory** thì có thể vừa nhanh hơn vừa **rẻ hơn** — đây là tình huống phản trực giác hay được hỏi. Đừng nghĩ "tăng memory = tốn tiền hơn" một cách máy móc.

## 29.9 Lambda@Edge vs CloudFront Functions, Function URLs, code signing & recursive loop detection

**Function URLs** — endpoint HTTPS chuyên dụng (`https://<id>.lambda-url.<region>.on.aws/`) gắn trực tiếp vào hàm/alias, không cần API Gateway. Hỗ trợ auth `AWS_IAM` (ký SigV4) hoặc `NONE` (public), cấu hình CORS. Dùng cho webhook đơn giản, microservice nhẹ — nhưng thiếu tính năng nâng cao của API Gateway (usage plan, request validation, WebSocket... — Chương 34 & 35).

**Lambda@Edge vs CloudFront Functions** — cả hai chạy code tại edge của CloudFront (chi tiết CDN ở Chương 15), nhưng khác hẳn:

| Tiêu chí | CloudFront Functions | Lambda@Edge |
|---|---|---|
| Runtime | **JavaScript** (môi trường riêng, nhẹ) | Node.js / Python (Lambda thật) |
| Trigger | Viewer Request / Viewer Response | Cả 4: Viewer + Origin Request/Response |
| Thời gian chạy tối đa | **< 1 ms** | 5s (viewer) / 30s (origin) |
| Khả năng | Header/URL/cookie manipulation, redirect, A/B nhẹ | Gọi external/AWS service, xử lý nặng, network access |
| Scale & chi phí | Triệu req/s, rất rẻ | Thấp hơn, đắt hơn |
| Truy cập network/SDK | **Không** | Có |

> 💡 **Exam Tip:** "Sửa header / redirect / URL rewrite đơn giản ở mọi viewer request với chi phí cực thấp, quy mô triệu req/s" → **CloudFront Functions**. "Cần gọi DynamoDB/S3 hoặc xử lý logic phức tạp tại Origin Request" → **Lambda@Edge**. CloudFront Functions chỉ chạy ở viewer-side; Lambda@Edge chạy được cả origin-side.

**Code signing** — bắt buộc code deploy lên Lambda phải được ký bởi **AWS Signer** thông qua một **Code Signing Configuration** (chỉ định danh sách signing profile được tin cậy và chính sách khi chữ ký không hợp lệ: `Warn` hay `Enforce`). Đảm bảo tính toàn vẹn và nguồn gốc code — chỉ artifact đã ký và chưa bị sửa mới deploy được. Chỉ áp dụng cho deployment package **ZIP** (container image dùng cơ chế ký riêng của ECR).

**Recursive loop detection** — Lambda tự phát hiện vòng lặp đệ quy vô tận, ví dụ Lambda ghi vào SQS rồi SQS lại trigger chính Lambda đó, hoặc Lambda → SNS → Lambda. Khi phát hiện qua một số vòng lặp nhất định (mặc định ngưỡng ~16 lần với SQS/SNS), Lambda **tự dừng** invocation để chặn vòng lặp gây tốn chi phí khổng lồ và gửi thông báo. Hỗ trợ với các nguồn được tích hợp (SQS, SNS). Đây là cơ chế an toàn chi phí — nhưng vẫn nên thiết kế tránh vòng lặp ngay từ đầu (idempotency, tách queue đầu vào/đầu ra — chi tiết patterns ở Chương 30).

```bash
# Gắn code signing config vào hàm (chỉ deploy artifact đã ký AWS Signer)
aws lambda update-function-configuration --function-name my-fn \
  --code-signing-config-arn arn:aws:lambda:ap-southeast-1:111122223333:code-signing-config:csc-0abc123

# Tạo function URL với auth IAM và CORS
aws lambda create-function-url-config --function-name my-fn \
  --auth-type AWS_IAM \
  --cors '{"AllowOrigins":["https://app.example.com"],"AllowMethods":["GET","POST"]}'
```

> 💡 **Exam Tip:** Function URL khác API Gateway: rẻ và đơn giản nhưng **không** có usage plan/API key, request validation, custom domain dễ dàng, hay WebSocket. Khi đề nhấn "least overhead cho một webhook đơn giản" → function URL; khi cần auth phức tạp/throttle per-client/transform → API Gateway (Chương 35). Recursive loop detection là **lưới an toàn**, không thay thế cho thiết kế idempotent.

---

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
