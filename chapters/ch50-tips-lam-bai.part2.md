## Bảng phân biệt nhanh các cặp service hay gài bẫy

Đây là bảng "tra cứu ngược" được rút gọn từ toàn bộ giáo trình. Cách dùng: khi đọc câu hỏi, bắt lấy **dấu hiệu (keyword)** trong đề rồi nhảy ngay tới dòng tương ứng để biết **chọn gì**. Trong phòng thi, 80% các cặp dưới đây quyết định bằng đúng một keyword.

### Messaging: SQS vs SNS vs Kinesis vs EventBridge

| Dịch vụ | Dấu hiệu nhận biết trong câu hỏi | Chọn khi |
|---|---|---|
| **SQS Standard** | "decouple", "buffer", "1 consumer xử lý rồi xoá message", "tránh mất việc khi worker chết" | Hàng đợi điểm-tới-điểm, mỗi message được xử lý một lần bởi một consumer; cần retry + DLQ |
| **SQS FIFO** | "exactly-once processing", "strict ordering", "deduplication" | Cần thứ tự tuyệt đối + chống trùng; throughput thấp (300 msg/s, 3000 với batch) |
| **SNS** | "fan-out", "1 message tới nhiều subscriber", "push notification/email/SMS", "thông báo" | Pub/sub đẩy (push) tới nhiều endpoint cùng lúc; kết hợp SNS→nhiều SQS cho fan-out bền |
| **Kinesis Data Streams** | "real-time analytics", "ordering theo partition key", "nhiều consumer đọc lại cùng data", "replay", "retention nhiều giờ/ngày", "clickstream", "IoT" | Streaming dữ liệu lớn, nhiều consumer độc lập, cần đọc lại (replay), giữ data tới 365 ngày |
| **Kinesis Data Firehose** | "near real-time", "load vào S3/Redshift/OpenSearch", "không cần code consumer", "buffer rồi ghi" | Nạp dữ liệu vào kho lưu trữ, fully managed, không quản shard, latency ~tối thiểu 60s |
| **EventBridge** | "schedule (cron)", "event-driven theo pattern", "SaaS/partner event", "routing theo nội dung event", "archive & replay" | Định tuyến event giữa nhiều AWS service/SaaS bằng rule; lịch cron; có schema registry |

> Bẫy kinh điển: "near real-time" + "deliver to S3" → **Firehose**, KHÔNG phải Data Streams. "Replay" hoặc "multiple consumers reading the same records" → **Data Streams**, KHÔNG phải SQS (SQS xoá message sau khi xử lý).

### Load Balancer: ALB vs NLB vs GWLB

| | Dấu hiệu | Chọn |
|---|---|---|
| **ALB** | "HTTP/HTTPS", "path-based / host-based routing", "WebSocket", "redirect", "Lambda target", "X-Forwarded-For" | Layer 7, định tuyến theo URL/host/header |
| **NLB** | "millions of requests", "ultra-low latency", "static IP / Elastic IP", "TCP/UDP", "PrivateLink endpoint service" | Layer 4, hiệu năng cực cao, IP tĩnh |
| **GWLB** | "third-party virtual appliance", "firewall/IDS/IPS inline", "GENEVE 6081" | Chèn appliance bảo mật vào đường đi traffic |

### S3 Encryption: SSE-S3 vs SSE-KMS vs SSE-C vs Client-side

| | Dấu hiệu | Chọn |
|---|---|---|
| **SSE-S3** (`AES256`) | "mã hoá at rest", "không cần quản key", "không yêu cầu audit" | Mặc định đơn giản, AWS quản key hoàn toàn |
| **SSE-KMS** (`aws:kms`) | "audit ai dùng key (CloudTrail)", "kiểm soát quyền dùng key", "key rotation", "tự quản CMK" | Cần audit + kiểm soát; lưu ý quota KMS gây throttling → bật **S3 Bucket Key** để giảm gọi KMS |
| **SSE-C** | "khách tự giữ key", "AWS không lưu key" | Client cung cấp key mỗi request (qua HTTPS) |
| **Client-side** | "mã hoá TRƯỚC khi gửi lên S3", "AWS không bao giờ thấy plaintext" | Mã hoá tại client bằng Encryption SDK |

> Bẫy: "phải biết ai đã giải mã object và khi nào" → **SSE-KMS** (vì có CloudTrail log mỗi lần Decrypt). SSE-S3 không cho bạn audit cấp key.

### Cấu hình / Secret: Parameter Store vs Secrets Manager

| | Dấu hiệu | Chọn |
|---|---|---|
| **Parameter Store** | "config value", "feature flag đơn giản", "rẻ/miễn phí (standard)", "không cần tự rotate" | Lưu config & secret cơ bản, miễn phí ở standard tier |
| **Secrets Manager** | "automatic rotation", "rotate DB credential bằng Lambda managed", "cross-region replication của secret", "tạo random password" | Cần **tự động rotate** (đặc biệt RDS) hoặc generate secret; tốn phí/secret/tháng |

> Bẫy: chỉ riêng từ **"automatic rotation"** đã đẩy đáp án về **Secrets Manager**. Parameter Store advanced tier có rotation đâu — nó chỉ có parameter policy (expiration/notification).

### Cognito: User Pools vs Identity Pools

| | Dấu hiệu | Chọn |
|---|---|---|
| **User Pools** | "sign-up/sign-in", "JWT token (ID/access)", "hosted UI", "authenticate user", "authorizer cho API Gateway" | **Xác thực** (authentication) — quản lý user directory, trả JWT |
| **Identity Pools** | "cấp AWS credentials tạm", "cho phép truy cập S3/DynamoDB trực tiếp từ app", "STS", "fine-grained IAM theo user" | **Authorize vào AWS** — đổi token lấy IAM credentials tạm qua STS |

> Bẫy: "web app upload thẳng vào S3 từ trình duyệt với quyền theo từng user" → **Identity Pools** (lấy AWS credentials). "Bảo vệ REST API" → **User Pools** authorizer.

### Cache: DAX vs ElastiCache

| | Dấu hiệu | Chọn |
|---|---|---|
| **DAX** | "DynamoDB", "microsecond latency", "không đổi code (API tương thích)", "read-heavy DynamoDB" | Cache chuyên cho DynamoDB, drop-in, item + query cache |
| **ElastiCache** | "Redis/Memcached", "session store", "leaderboard (sorted set)", "pub/sub", "cache kết quả RDS" | Cache đa năng cho RDS/tính toán/session; cần sửa code app |

### DynamoDB index: GSI vs LSI

| | Dấu hiệu | Chọn |
|---|---|---|
| **GSI** | "khác partition key", "tạo bất kỳ lúc nào", "throughput riêng", "eventually consistent" | Query theo attribute khác hẳn key gốc; **chỉ eventually consistent** |
| **LSI** | "cùng partition key, khác sort key", "phải tạo lúc create table", "strongly consistent" | Cùng PK nhưng sort theo attribute khác; giới hạn 10GB/partition |

> Bẫy: "cần strongly consistent read trên index" → chỉ **LSI** làm được. "Đã có bảng rồi mới muốn thêm index" → bắt buộc **GSI** (LSI phải tạo khi create table).

### S3 presigned URL vs CloudFront signed URL/cookie

| | Dấu hiệu | Chọn |
|---|---|---|
| **S3 presigned URL** | "cấp quyền tạm truy cập 1 object", "upload/download trực tiếp S3", "hết hạn sau X phút" | Truy cập một object S3 không cần IAM, dùng quyền của người tạo URL |
| **CloudFront signed URL** | "qua CDN", "1 file", "edge", "kèm restriction IP/thời gian" | Phát qua CloudFront, kiểm soát từng URL |
| **CloudFront signed cookie** | "nhiều file", "không đổi URL", "phát video streaming nhiều segment" | Cấp quyền cho nhiều object mà giữ nguyên URL |

### API Gateway auth: Lambda authorizer vs Cognito authorizer vs IAM

| | Dấu hiệu | Chọn |
|---|---|---|
| **Cognito authorizer** | "user trong Cognito User Pool", "JWT", "không muốn viết code auth" | User đã ở User Pool → authorizer kiểm JWT sẵn |
| **Lambda authorizer** | "OAuth/JWT của bên thứ ba", "custom logic", "token format riêng", "trả về IAM policy" | Logic xác thực tuỳ biến (token hoặc request-based), có cache theo TTL |
| **IAM (SigV4)** | "service-to-service trong AWS", "IAM user/role gọi API" | Caller là principal AWS, ký SigV4 |

### Lambda concurrency: Reserved vs Provisioned

| | Dấu hiệu | Chọn |
|---|---|---|
| **Reserved concurrency** | "giới hạn tối đa concurrency của 1 function", "bảo vệ DB downstream", "đảm bảo function khác không ăn hết pool" | Đặt **trần** (và sàn riêng) số concurrency; không tốn thêm tiền |
| **Provisioned concurrency** | "loại bỏ cold start", "latency ổn định", "khởi tạo sẵn instance" | Giữ sẵn execution environment warm; tốn phí; kết hợp Application Auto Scaling |

> Bẫy: "tránh cold start để latency thấp/ổn định" → **Provisioned**. "Đừng để function này làm sập RDS vì quá nhiều connection" → **Reserved** (giới hạn trần).

### Observability: CloudTrail vs CloudWatch vs X-Ray

| | Dấu hiệu | Chọn |
|---|---|---|
| **CloudTrail** | "ai đã làm gì", "API call nào được gọi", "audit", "ai xoá resource", "compliance" | Log **API activity** (who/what/when) trên account |
| **CloudWatch** | "metric", "alarm", "log của ứng dụng", "CPU/Memory", "dashboard" | Giám sát **hiệu năng & log nội dung** |
| **X-Ray** | "trace request qua nhiều service", "tìm bottleneck latency", "service map", "phân tích nơi chậm" | **Distributed tracing** end-to-end |

> Bẫy kinh điển: "An EC2 instance was terminated, who did it?" → **CloudTrail**. "Request đi qua API Gateway→Lambda→DynamoDB và chỗ nào chậm?" → **X-Ray**.

### Step Functions: Standard vs Express

| | Dấu hiệu | Chọn |
|---|---|---|
| **Standard** | "long-running (tới 1 năm)", "exactly-once", "human approval / wait for callback", "audit từng bước" | Workflow dài, đáng tin cậy, exactly-once |
| **Express** | "high-volume event", "ngắn (<5 phút)", "rẻ theo số lần chạy", "IoT/streaming ingest" | Tần suất cao, ngắn; at-least-once (sync) hoặc at-most-once (async) |

## Checklist kiến thức theo domain

Đề DVA-C02 chia 4 domain. Trước khi thi, tự chấm từng dòng "nắm chắc / cần ôn lại". Số chương để bạn nhảy về ôn nhanh.

### Domain 1 — Development with AWS Services (32%)
- [ ] Lambda: invocation types (sync/async/event source mapping), cold start, env vars, timeout 15 phút, memory 128MB–10GB, /tmp tới 10GB (Ch28–30).
- [ ] Concurrency: reserved vs provisioned, throttling 429, account limit 1000 (Ch29).
- [ ] DynamoDB: cách tính RCU/WCU, eventually vs strongly consistent, Query vs Scan, GSI/LSI, conditional write + optimistic locking, transactions (Ch31–33).
- [ ] API Gateway: proxy vs non-proxy, stage variables, request validation, caching, usage plan + API key (Ch34–35).
- [ ] S3 SDK: multipart (>5GB bắt buộc, khuyến nghị >100MB), presigned URL, byte-range (Ch12–13).
- [ ] SQS/SNS/Kinesis: chọn đúng theo pattern; visibility timeout; DLQ; fan-out (Ch21–23).
- [ ] Step Functions: ASL, error Retry/Catch, integration patterns (.sync, .waitForTaskToken) (Ch43).
- [ ] Idempotency, exponential backoff & jitter, pagination (Ch3, Ch30).

### Domain 2 — Security (26%)
- [ ] IAM: policy evaluation (explicit deny thắng), identity vs resource-based, roles cho service (Ch2, Ch45).
- [ ] STS: AssumeRole cross-account + trust policy + ExternalId chống confused deputy (Ch45).
- [ ] Cognito: User Pools (JWT) vs Identity Pools (AWS credentials) (Ch38–39).
- [ ] KMS: envelope encryption, GenerateDataKey, 4KB direct limit, key policy + IAM, bucket key (Ch46).
- [ ] S3 security: SSE-S3/KMS/C, bucket policy ép HTTPS (`aws:SecureTransport`), Block Public Access (Ch14).
- [ ] Secrets Manager vs Parameter Store; dynamic references trong CloudFormation (Ch47).
- [ ] Encryption in transit, ACM cho ALB/CloudFront/API GW (Ch48).

### Domain 3 — Deployment (24%)
- [ ] CloudFormation: intrinsic functions, cross-stack Export/ImportValue, DeletionPolicy, ChangeSets, nested vs cross-stack (Ch19–20).
- [ ] SAM: template, `sam build/deploy`, AutoPublishAlias + DeploymentPreference canary/linear (Ch36).
- [ ] CDK: constructs L1/L2/L3, grants, `cdk synth/deploy` (Ch37).
- [ ] Beanstalk: deployment policies (all-at-once, rolling, immutable, traffic splitting), blue/green swap CNAME (Ch18).
- [ ] CodeBuild buildspec, CodeDeploy appspec + hooks, CodePipeline stages (Ch40–42).
- [ ] Lambda versions/aliases, weighted alias canary (Ch29).
- [ ] ECS rolling update, deployment circuit breaker; blue/green qua CodeDeploy (Ch17, Ch41).

### Domain 4 — Troubleshooting & Optimization (18%)
- [ ] X-Ray: instrument, sampling, annotations vs metadata, "không thấy trace" checklist (Ch26).
- [ ] CloudWatch Logs Insights, metric filter, subscription filter (Ch25).
- [ ] Lambda errors: throttling (429), timeout, DLQ/destinations, retry async (Ch28–30).
- [ ] DynamoDB ProvisionedThroughputExceeded, hot partition, adaptive capacity (Ch31).
- [ ] Kinesis ProvisionedThroughputExceeded, hot shard, resharding (Ch23).
- [ ] Caching để tối ưu chi phí/latency: DAX, ElastiCache, API GW cache, CloudFront (Ch9, Ch15, Ch33, Ch35).
- [ ] X-Forwarded-For, 502/504 ở ALB/API GW (integration timeout 29s) (Ch6, Ch34).

## Lộ trình ôn 4 tuần và 8 tuần

Lộ trình bám đúng 50 chương của giáo trình này. Giả định bạn dành ~10–12 giờ/tuần (4 tuần) hoặc ~6 giờ/tuần (8 tuần). Mỗi chương: đọc part1 → làm lab part2 → làm quiz 10 câu → ghi lại câu sai.

### Lộ trình 4 tuần (nước rút, đã có nền dev)

**Tuần 1 — Nền tảng + Storage (Ch1–15).** Đọc nhanh Ch1–11 (IAM, EC2, ELB, ASG, RDS, ElastiCache, Route53, VPC — phần bạn đã quen có thể lướt). Tập trung kỹ Ch2 (IAM policy), Ch6 (ALB vs NLB), Ch8 (Multi-AZ vs Read Replica), Ch12–15 (S3 + CloudFront, đặc biệt S3 encryption Ch14).

**Tuần 2 — Containers, IaC, Messaging, Monitoring (Ch16–27).** ECS/Fargate (Ch17), Beanstalk deployment policies (Ch18), CloudFormation (Ch19–20 — học kỹ). SQS/SNS/Kinesis (Ch21–23, làm bảng so sánh thuộc lòng). CloudWatch/EventBridge/X-Ray/CloudTrail (Ch24–27).

**Tuần 3 — Serverless core (Ch28–39).** Đây là phần nặng điểm nhất. Lambda (Ch28–30), DynamoDB (Ch31–33 — luyện tính RCU/WCU), API Gateway (Ch34–35), SAM/CDK (Ch36–37), Cognito (Ch38–39). Mỗi ngày 1–2 chương + quiz.

**Tuần 4 — CI/CD, Advanced, Luyện đề (Ch40–50).** CodePipeline/Deploy/Build (Ch40–42), Step Functions (Ch43), AppSync (Ch44), STS/KMS/Secrets (Ch45–47), Ch48. Hai ngày cuối: làm trọn bộ 65 câu Ch49 bấm giờ, đọc lại Ch50, ôn các câu sai.

### Lộ trình 8 tuần (chắc chắn, vừa học vừa làm)

- **Tuần 1:** Ch1–6 (tổng quan, IAM, CLI/SDK, EC2, EBS/EFS, ELB).
- **Tuần 2:** Ch7–11 (ASG, RDS/Aurora, ElastiCache, Route53, VPC).
- **Tuần 3:** Ch12–15 (S3 cơ bản → security → CloudFront). Làm kỹ lab presigned URL & encryption.
- **Tuần 4:** Ch16–20 (ECR, ECS/Fargate, Beanstalk, CloudFormation cơ bản + nâng cao).
- **Tuần 5:** Ch21–27 (SQS, SNS, Kinesis, CloudWatch, EventBridge, X-Ray, CloudTrail).
- **Tuần 6:** Ch28–33 (Lambda x3, DynamoDB x3). Phần điểm cao nhất — đi chậm, làm hết lab.
- **Tuần 7:** Ch34–42 (API Gateway, SAM, CDK, Cognito, CI/CD). 
- **Tuần 8:** Ch43–48 (Step Functions, AppSync, STS, KMS, Secrets, Ch48) + Ch49 (bộ đề 65 câu, làm 2 lần) + Ch50 (chiến lược). 

Quy tắc chung cho cả hai lộ trình: duy trì một "sổ lỗi" — mỗi câu quiz sai ghi lại keyword + service đúng + lý do. Tuần cuối chỉ đọc sổ lỗi và bảng phân biệt ở đầu chương này. Đặt mục tiêu đạt ≥80% trên bộ đề Ch49 trước khi đăng ký thi thật.

## Quiz tổng hợp nhanh (10 câu)

**Câu 1.** Một ứng dụng cần nạp clickstream gần real-time vào S3 và OpenSearch mà không phải viết/quản lý code consumer. Chọn gì?
- A. Kinesis Data Streams + Lambda
- B. Kinesis Data Firehose
- C. SQS Standard
- D. EventBridge

**Câu 2.** Developer cần đảm bảo một Lambda function không bao giờ vượt 50 concurrent execution để bảo vệ RDS phía sau. Dùng gì?
- A. Provisioned concurrency = 50
- B. Reserved concurrency = 50
- C. Tăng timeout
- D. RDS Proxy

**Câu 3.** Cần audit chính xác ai đã gọi `DeleteBucket` và lúc nào. Dịch vụ nào?
- A. CloudWatch Logs
- B. X-Ray
- C. CloudTrail
- D. AWS Config

**Câu 4.** Web SPA cần cho phép mỗi user đã đăng nhập upload file thẳng vào prefix S3 riêng của họ. Cấu phần nào cấp quyền AWS?
- A. Cognito User Pools
- B. Cognito Identity Pools
- C. API Gateway Lambda authorizer
- D. IAM user cho mỗi người

**Câu 5.** Bảng DynamoDB đã chạy production cần query theo `email` (không phải key gốc), chấp nhận eventually consistent. Tạo gì?
- A. LSI
- B. GSI
- C. Scan với filter
- D. Tạo lại bảng với sort key mới

**Câu 6.** Cần rotate tự động mật khẩu RDS mỗi 30 ngày với ít công sức vận hành nhất.
- A. Parameter Store SecureString
- B. Secrets Manager với managed rotation
- C. Lưu trong env var Lambda
- D. KMS GenerateDataKey

**Câu 7.** API Gateway REST API trả lỗi `504` khi tích hợp một backend HTTP chạy lâu. Nguyên nhân giới hạn nào?
- A. Lambda timeout 15 phút
- B. Integration timeout tối đa 29 giây
- C. Throttling 10000 rps
- D. Payload 10MB

**Câu 8.** Cần phát một video streaming gồm nhiều segment qua CloudFront, kiểm soát truy cập theo thời gian, không muốn đổi URL từng file.
- A. S3 presigned URL
- B. CloudFront signed URL
- C. CloudFront signed cookies
- D. Bucket policy public

**Câu 9.** Object S3 phải mã hoá at rest và bắt buộc audit được mỗi lần object bị decrypt.
- A. SSE-S3
- B. SSE-KMS
- C. SSE-C
- D. Không mã hoá, dùng bucket policy

**Câu 10.** Cần loại bỏ cold start để giữ latency p99 ổn định cho một API Lambda quan trọng.
- A. Reserved concurrency
- B. Provisioned concurrency
- C. Tăng memory lên 10GB
- D. Đổi sang SnapStart cho Node.js

### Đáp án & giải thích

**Câu 1 — B.** Firehose là "near real-time", fully managed, nạp thẳng vào S3/OpenSearch/Redshift, không cần code consumer hay quản shard. A đúng về mặt kỹ thuật nhưng đòi viết Lambda và quản Data Streams (vi phạm "không quản code"). SQS không phải streaming và không tự nạp vào kho. EventBridge để routing event, không phải buffer-and-load streaming.

**Câu 2 — B.** Reserved concurrency đặt **trần** concurrency cho function → bảo vệ RDS khỏi quá nhiều connection. Provisioned concurrency chỉ giữ instance warm (chống cold start), không giới hạn trần. RDS Proxy giúp pool connection nhưng câu hỏi yêu cầu giới hạn concurrency của function.

**Câu 3 — C.** CloudTrail ghi lại API call (who/what/when) → trả lời "ai gọi DeleteBucket". CloudWatch Logs là log nội dung ứng dụng. X-Ray là tracing. AWS Config theo dõi trạng thái/compliance cấu hình, không phải nhật ký ai-gọi-API.

**Câu 4 — B.** Identity Pools đổi token đăng nhập lấy **AWS credentials tạm** (qua STS) với IAM policy fine-grained theo `${cognito-identity.amazonaws.com:sub}` → upload thẳng S3 theo prefix riêng. User Pools chỉ xác thực và trả JWT, không cấp AWS credentials. Tạo IAM user cho mỗi người không scale và sai mô hình.

**Câu 5 — B.** Bảng đã chạy production nên không thể thêm LSI (LSI bắt buộc tạo khi create table). GSI tạo được bất kỳ lúc nào, có key riêng, eventually consistent — đúng yêu cầu. Scan tốn kém và chậm. Tạo lại bảng là gián đoạn không cần thiết.

**Câu 6 — B.** Secrets Manager hỗ trợ managed rotation cho RDS gần như zero-code → ít vận hành nhất. Parameter Store không có automatic rotation. Env var Lambda không rotate và lộ secret. KMS GenerateDataKey là API mã hoá, không liên quan rotation credential.

**Câu 7 — B.** API Gateway có integration timeout tối đa **29 giây**; backend chạy lâu hơn → `504 Gateway Timeout`. Lambda timeout 15 phút không cứu được vì API GW đã cắt ở 29s. Throttling trả 429, payload limit trả 413/400 — không phải 504.

**Câu 8 — C.** Signed cookies cấp quyền cho **nhiều object** mà giữ nguyên URL → hợp video nhiều segment. Signed URL chỉ cho một file. S3 presigned URL truy cập trực tiếp S3, không qua CDN. Public bucket mất kiểm soát truy cập.

**Câu 9 — B.** SSE-KMS ghi mỗi lần Encrypt/Decrypt vào CloudTrail → audit được "ai decrypt khi nào". SSE-S3 không cho audit ở cấp key. SSE-C bắt client giữ key (không audit qua KMS). Bucket policy không mã hoá data.

**Câu 10 — B.** Provisioned concurrency giữ sẵn execution environment đã khởi tạo → loại bỏ cold start, latency p99 ổn định. Reserved chỉ giới hạn trần, không chống cold start. Tăng memory giảm thời gian chạy nhưng vẫn cold start. SnapStart hỗ trợ cho Java (không phải Node.js ở thời điểm kinh điển của đề), nên D sai trong ngữ cảnh này.

## Sau khi đậu

Có chứng chỉ DVA-C02 rồi, đây là các hướng đi tiếp hợp lý cho một backend developer:

- **AWS Certified Solutions Architect – Associate (SAA-C03):** chồng lấn ~40% kiến thức với DVA, bổ sung mảng thiết kế kiến trúc, networking sâu, chi phí. Học tiếp ngay sau DVA là rẻ nhất về thời gian.
- **AWS Certified DevOps Engineer – Professional (DOP-C02):** bước nhảy tự nhiên từ Developer nếu bạn thiên về CI/CD, IaC, observability. Yêu cầu nền vững về CodePipeline, CloudFormation, monitoring — vốn đã có trong giáo trình này.
- **AWS Certified Solutions Architect – Professional (SAP-C02):** nặng nhất, nên đi sau khi có SAA + kinh nghiệm thực tế.
- **Specialty:** Security Specialty (nếu làm nhiều KMS/IAM/Cognito), Data Engineer Associate (nếu thiên về Kinesis/Glue/Athena).

Lời khuyên thực tế: chứng chỉ có hiệu lực **3 năm**. Quan trọng hơn tấm bằng là biến kiến thức thành sản phẩm — dựng một dự án serverless thật (API Gateway + Lambda + DynamoDB + Cognito + CI/CD bằng SAM/CDK) để đưa vào portfolio. Nhà tuyển dụng tin "đã build" hơn "đã thi".

## Tóm tắt chương

- Phần nửa sau chương 50 cung cấp công cụ tra cứu nhanh và lộ trình hoàn thiện cho việc ôn thi — dùng song song với bộ đề ở Chương 49.
- **Bảng phân biệt cặp service** là tài sản giá trị nhất: học thuộc keyword → service. Trong phòng thi, một keyword như "near real-time", "automatic rotation", "audit", "exactly-once", "fan-out" thường quyết định đáp án.
- Nhớ các bẫy kinh điển: Firehose vs Data Streams (near real-time + load), Reserved vs Provisioned concurrency (trần vs chống cold start), User Pools vs Identity Pools (JWT vs AWS credentials), LSI vs GSI (strongly consistent + tạo lúc create table vs eventually + tạo bất kỳ lúc nào).
- CloudTrail = ai gọi API; CloudWatch = metric/log; X-Ray = trace latency. Đây là bộ ba luôn xuất hiện ở domain Troubleshooting.
- **Checklist theo domain** giúp tự đánh giá độ phủ: Development 32%, Security 26%, Deployment 24%, Troubleshooting 18% — phân bổ thời gian ôn theo trọng số này.
- **Lộ trình 4 tuần** cho người có nền và cần nước rút; **8 tuần** cho người muốn chắc chắn. Cả hai bám đúng 50 chương và đều dành tuần cuối cho bộ đề Ch49 + sổ lỗi.
- Quy tắc bất biến: duy trì "sổ lỗi" và đạt ≥80% trên đề mô phỏng trước khi đăng ký thi thật.
- Một số limit hay bị hỏi tổng hợp lại: API Gateway integration timeout 29s, Lambda timeout 15 phút / memory 10GB / 1000 concurrency mặc định, KMS direct encrypt 4KB, SQS message 256KB, S3 multipart bắt buộc >5GB.
- Sau khi đậu: hướng tự nhiên là SAA-C03 (chồng lấn nhiều) rồi DOP-C02; quan trọng hơn cả là build một dự án serverless thật để chứng minh năng lực.
