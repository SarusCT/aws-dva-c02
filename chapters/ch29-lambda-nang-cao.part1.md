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
