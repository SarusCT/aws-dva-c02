# Chương 48: Các dịch vụ khác trong phạm vi DVA-C02

> **Trọng tâm DVA-C02:** Chương này gom những dịch vụ "vệ tinh" mà đề DVA-C02 hỏi ở mức nhận diện hoặc một vài chi tiết kỹ thuật cụ thể — chứ hiếm khi đào sâu cả service. Câu hỏi thường có dạng "developer cần làm X, dịch vụ nào phù hợp nhất với least operational overhead?" và bẫy bạn giữa các cặp dễ nhầm: **SES vs SNS** cho email, **ACM ở region nào** cho CloudFront, **OpenSearch vs DynamoDB** cho full-text search, **Athena vs RDS** để query dữ liệu trong S3, **MSK vs Kinesis**, **AppConfig vs Parameter Store** cho feature flag, **AWS Batch vs Lambda** cho job nặng/dài, **Amazon MQ vs SQS/SNS** khi migrate ứng dụng dùng JMS/AMQP. Bạn không cần code sâu từng cái — cần đúng "service nào cho tình huống nào" và vài limit/đặc tính chốt hạ đáp án.

## Mục tiêu chương

- Dùng **Amazon SES** gửi transactional email qua SDK, hiểu configuration sets, sandbox, DKIM, vì sao SES khác SNS.
- Hiểu **ACM**: cấp/validate/renew chứng chỉ public/private, ràng buộc region với CloudFront vs ALB/API Gateway.
- Phân biệt **OpenSearch Service** với DynamoDB/RDS — khi nào cần search engine.
- Dùng **Athena** query trực tiếp dữ liệu S3 (serverless, pay-per-scan), tối ưu bằng partition + columnar; nhận diện vai trò của **Glue**.
- So sánh **Amazon MSK vs Kinesis**, **AWS Batch vs Lambda**, **Amazon MQ vs SQS/SNS** để chọn đúng trong tình huống thi.
- Nhận diện **AppConfig** (feature flag, deployment strategy, validator), **CloudWatch Evidently & RUM**, **Macie**, **Nitro Enclaves** và đọc được bảng "service nào cho tình huống nào".

## 48.1 Amazon SES — gửi email ở quy mô lớn

**Amazon SES (Simple Email Service)** là dịch vụ gửi và nhận email. Trong phạm vi developer, bạn dùng SES để gửi **transactional email** (xác nhận đăng ký, reset mật khẩu, hóa đơn, OTP) và **bulk email** (newsletter, thông báo) từ ứng dụng — thay vì tự dựng SMTP server và vật lộn với reputation, blacklist, SPF/DKIM.

Hai cách gọi SES:

- **SMTP interface**: bạn lấy SMTP credentials (khác với IAM access key — là một cặp username/password riêng sinh ra từ IAM user), trỏ thư viện gửi mail (Nodemailer, JavaMail...) vào endpoint `email-smtp.<region>.amazonaws.com`. Phù hợp khi migrate app đang dùng SMTP sẵn.
- **SES API (HTTPS)**: gọi qua AWS SDK, ký SigV4, không cần mở port 25/587. Ưu tiên dùng API v2 (`SendEmail`) trong ứng dụng mới.

```javascript
// Gửi email transactional bằng AWS SDK v3 (SESv2)
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

const ses = new SESv2Client({ region: "us-east-1" });

await ses.send(new SendEmailCommand({
  FromEmailAddress: "no-reply@myapp.com",           // địa chỉ/domain đã verify
  Destination: { ToAddresses: ["user@example.com"] },
  Content: {
    Simple: {
      Subject: { Data: "Xác nhận đăng ký" },
      Body: { Html: { Data: "<h1>Chào mừng!</h1>" } },
    },
  },
  ConfigurationSetName: "prod-tracking",            // gắn configuration set để track
}));
```

**Verified identity:** trước khi gửi, bạn phải verify danh tính gửi — hoặc một email address (verify bằng link gửi tới hộp thư), hoặc cả một **domain** (thêm các bản ghi DNS TXT/CNAME). Verify domain kèm bật **DKIM** (DomainKeys Identified Mail) ký số mỗi email để chống giả mạo; SES còn dùng **SPF** qua MAIL FROM domain. DKIM + SPF + DMARC là bộ ba quyết định email vào inbox hay vào spam.

**Sandbox:** account mới nằm trong **SES sandbox** — chỉ gửi được tới các địa chỉ/domain *đã verify*, giới hạn 200 email/ngày và 1 email/giây. Phải mở ticket để thoát sandbox (production access) mới gửi được tới người nhận tùy ý. Đề rất hay bẫy: "developer gửi mail tới khách hàng nhưng bị từ chối" → nguyên nhân thường là **chưa rời sandbox** hoặc địa chỉ người nhận chưa verify.

**Configuration sets** là tập cấu hình gắn vào lần gửi để: định tuyến **event** (bounce, complaint, delivery, open, click, reject) tới **SNS / Kinesis Data Firehose / CloudWatch / EventBridge**; áp **dedicated IP pool**; bật **suppression list** (tự loại địa chỉ từng bounce/complaint). Xử lý **bounce & complaint** là bắt buộc về vận hành: tỉ lệ bounce/complaint cao làm SES tạm dừng tài khoản. Pattern chuẩn: SES → SNS → Lambda để gỡ địa chỉ xấu khỏi danh sách gửi.

Vài limit và đặc tính SES hay rơi vào đề hoặc vào production:

- **Sending quota** (sau khi rời sandbox) gồm hai con số: **sending rate** (email/giây) và **daily sending quota** (email/24h). Cả hai tự tăng dần khi reputation tốt; vượt quota → SES trả lỗi `Throttling` và bạn cần retry với backoff.
- **Message size** tối đa **40 MB** (gồm cả attachment, sau khi encode). Email lớn hơn nên đẩy nội dung lên S3 và gửi link.
- **MAIL FROM domain** tùy chỉnh giúp SPF align với domain của bạn, cải thiện DMARC. Không cấu hình thì SES dùng MAIL FROM mặc định của Amazon.
- SES tích hợp **email receiving** (chỉ ở một số region) để nhận mail vào S3 hoặc trigger Lambda — ít gặp trong đề developer.

> 💡 **Exam Tip:** **SES gửi email tới người dùng cuối** (HTML, attachment, marketing/transactional). **SNS gửi notification** giữa hệ thống (pub/sub, fan-out, SMS, push). Nếu đề nói "gửi email hóa đơn/HTML cho khách hàng" → SES. Nếu nói "thông báo cho nhiều subscriber/trigger Lambda/SQS" → SNS. Đừng chọn SNS để gửi email marketing có template HTML.

## 48.2 ACM — AWS Certificate Manager

**ACM** quản lý vòng đời chứng chỉ SSL/TLS: cấp, lưu trữ, và **tự động gia hạn** (auto-renewal) chứng chỉ public miễn phí, để bật HTTPS cho dịch vụ AWS mà không phải tự mua cert, tự copy private key, tự nhớ ngày hết hạn.

Hai loại cert:

- **Public certificate**: miễn phí, cấp bởi Amazon CA, dùng cho web công khai. Validate quyền sở hữu domain bằng **DNS validation** (thêm CNAME — khuyến nghị vì cho phép auto-renew) hoặc **email validation**.
- **Private certificate**: cấp từ **AWS Private CA** (ACM PCA — tính phí), dùng cho mạng nội bộ, mTLS giữa microservice.

**Tích hợp:** ACM cert dùng được với **ELB (ALB/NLB), CloudFront, API Gateway**. Điểm mấu chốt: ACM **không export được private key** với cert public — bạn không thể cài cert ACM thẳng lên EC2/web server tự quản. Muốn TLS termination ở chính EC2 thì phải dùng cert mua ngoài hoặc Private CA (export được).

**Ràng buộc region — câu hỏi kinh điển:**

| Dịch vụ dùng cert | Region phải cấp/import ACM |
|---|---|
| CloudFront | **us-east-1 (N. Virginia)** — luôn luôn |
| ALB / NLB | cùng region với load balancer |
| API Gateway (edge-optimized) | **us-east-1** |
| API Gateway (regional) | cùng region với API |

> 💡 **Exam Tip:** Cert cho **CloudFront phải nằm ở us-east-1** bất kể origin ở đâu — đây là bẫy gài thường gặp. Auto-renewal chỉ hoạt động trơn tru khi dùng **DNS validation** và cert đang được gắn (in use). Cert nhập từ bên ngoài (imported) **không tự gia hạn** — bạn phải tự import lại trước hạn.

## 48.3 OpenSearch Service — search & analytics

**Amazon OpenSearch Service** (tên cũ Elasticsearch Service) là dịch vụ managed chạy OpenSearch — một search & analytics engine. Bạn dùng khi cần **full-text search** (tìm kiếm gần đúng, fuzzy, tokenized, relevance scoring), **log analytics**, hoặc dashboard real-time (OpenSearch Dashboards, tiền thân Kibana).

Điểm cốt lõi cho đề: **DynamoDB và OpenSearch bổ sung cho nhau, không thay thế.** DynamoDB tra cứu cực nhanh theo **primary key đã biết**, nhưng dở tệ khi phải tìm "mọi item có chứa từ khóa abc ở bất kỳ field nào". OpenSearch index toàn bộ field, hỗ trợ search phức tạp. Pattern chuẩn:

```
App ghi vào DynamoDB  →  DynamoDB Streams  →  Lambda  →  index document vào OpenSearch
                         (nguồn sự thật)              (lớp search)
```

DynamoDB là **source of truth**, OpenSearch là lớp search ăn sự kiện qua Streams (chi tiết Streams ở Chương 33). Tương tự, nhiều kiến trúc đẩy log qua **Kinesis Data Firehose → OpenSearch** để phân tích.

Vài điểm vận hành đáng nhớ: OpenSearch chạy trên **cluster gồm các node** (data node, master node) trong một **domain** — nghĩa là **không hoàn toàn serverless** (có chi phí node chạy 24/7), trừ khi dùng **OpenSearch Serverless** (mô hình mới, tính theo OCU). Để bền vững, bố trí node trên nhiều AZ và bật **dedicated master nodes** cho cluster lớn. Bảo mật gồm: đặt domain trong **VPC** (chỉ truy cập nội bộ), **fine-grained access control** (FGAC) ở mức index/document/field, mã hóa at-rest (KMS) và in-transit (TLS), kết hợp Cognito để đăng nhập Dashboards.

> 💡 **Exam Tip:** Từ khóa **"full-text search", "search across fields", "relevance/autocomplete", "log analytics dashboard"** → OpenSearch. Nếu đề bảo "thêm khả năng search cho dữ liệu đang nằm trong DynamoDB" → DynamoDB Streams + Lambda đẩy sang OpenSearch, **không** chọn Scan với FilterExpression (chậm, tốn RCU, không scale).

## 48.4 Amazon Athena & AWS Glue — query S3 không cần server

**Amazon Athena** là dịch vụ query serverless cho phép chạy **SQL chuẩn (Presto/Trino)** trực tiếp trên dữ liệu nằm trong **S3** — không cần load vào database, không có server để quản. Bạn định nghĩa schema "trên đường đọc" (schema-on-read), trỏ vào prefix S3, và query. Tính tiền theo **lượng dữ liệu quét (scan) — khoảng $5/TB**.

Vì tính tiền theo dữ liệu quét, hai kỹ thuật tối ưu là điểm thi:

- **Partitioning**: tổ chức S3 theo thư mục `year=2026/month=06/day=12/` để Athena chỉ quét partition liên quan (partition pruning) thay vì cả bucket → giảm scan, giảm tiền.
- **Columnar format**: chuyển dữ liệu sang **Parquet hoặc ORC** (nén, lưu theo cột) → query chỉ đọc các cột cần, giảm scan mạnh so với CSV/JSON.

```sql
-- Athena: tạo bảng trỏ vào S3, query trực tiếp
CREATE EXTERNAL TABLE logs (
  request_id string, status int, latency double
)
PARTITIONED BY (dt string)
STORED AS PARQUET
LOCATION 's3://my-logs-bucket/app-logs/';

SELECT status, COUNT(*) FROM logs
WHERE dt = '2026-06-12' GROUP BY status;   -- chỉ quét partition dt này
```

**AWS Glue** (mức nhận diện) là dịch vụ ETL serverless. Hai phần liên quan đến Athena:

- **Glue Data Catalog**: metastore trung tâm lưu định nghĩa bảng/schema. Athena, EMR, Redshift Spectrum đều dùng chung catalog này.
- **Glue Crawler**: tự quét S3, suy ra schema và partition, tạo/cập nhật bảng trong Data Catalog → bạn không phải viết tay `CREATE TABLE`.
- **Glue ETL jobs**: chạy Spark để biến đổi dữ liệu (ví dụ CSV → Parquet).

**Federated query:** Athena còn query được nguồn ngoài S3 (DynamoDB, RDS, CloudWatch...) qua **data source connector** (Lambda-based) — gọi là federated query.

> 💡 **Exam Tip:** "Query dữ liệu trong S3 bằng SQL, serverless, ad-hoc, ít vận hành" → **Athena**. "Phân tích log lưu trong S3" → Athena. Muốn giảm chi phí Athena → **partition + chuyển sang Parquet/ORC**. Glue Data Catalog là nơi lưu schema; Glue Crawler tự dò schema. Đừng nhầm Athena (query S3) với Redshift (data warehouse cần cluster, dữ liệu load vào trong).

## 48.5 Streaming & messaging: MSK vs Kinesis, Amazon MQ vs SQS/SNS

Đề DVA-C02 hay đặt bạn vào tình huống chọn nền tảng messaging/streaming, đặc biệt khi **migrate** ứng dụng có sẵn.

**Amazon MSK (Managed Streaming for Apache Kafka)** chạy Apache Kafka được quản lý. Chọn MSK khi đội ngũ **đã dùng Kafka** hoặc cần hệ sinh thái Kafka (Kafka Connect, Kafka Streams, partition/consumer group đúng chuẩn Kafka), muốn giữ nguyên producer/consumer code khi lên cloud. Kinesis là dịch vụ AWS-native (chi tiết ở Chương 23), tích hợp sâu Lambda/Firehose, ít vận hành hơn.

| Tiêu chí | Kinesis Data Streams | Amazon MSK |
|---|---|---|
| Bản chất | AWS proprietary | Apache Kafka managed |
| Đơn vị scale | shard | partition |
| Message size | tối đa **1 MB** | mặc định ~1 MB, **cấu hình lớn hơn được** |
| Retention | 1–365 ngày | tùy cấu hình, có thể **không giới hạn** (tiered storage) |
| Vận hành | thấp nhất (serverless on-demand) | cao hơn (vẫn quản broker/topic) |
| Khi nào chọn | mới làm, AWS-native, ít overhead | đã có codebase Kafka, cần feature Kafka |

**Amazon MQ** là message broker managed chạy **Apache ActiveMQ** hoặc **RabbitMQ**, hỗ trợ các giao thức chuẩn ngành: **JMS, AMQP, MQTT, STOMP, OpenWire**. Đây là lựa chọn khi **migrate ứng dụng on-premise đang dùng broker truyền thống** lên AWS mà **không muốn viết lại code** sang API SQS/SNS. Nếu xây mới trên AWS thì SQS/SNS gần như luôn ưu việt hơn (serverless, scale gần vô hạn, ít vận hành) — nhưng SQS/SNS dùng **API riêng của AWS**, không nói được JMS/AMQP.

| Tình huống | Chọn |
|---|---|
| Xây mới trên AWS, decouple, ít vận hành | **SQS / SNS** |
| Migrate app dùng **JMS/AMQP/MQTT/STOMP** sẵn | **Amazon MQ** |
| Streaming/analytics real-time, replay, nhiều consumer đọc lại | **Kinesis** |
| Đã có hệ sinh thái **Kafka** | **MSK** |

> 💡 **Exam Tip:** Từ khóa **"migrate existing application using industry-standard messaging protocols (JMS/AMQP)"** → **Amazon MQ**. Từ khóa **"existing Apache Kafka application"** → **MSK**. "New, decoupled, serverless, minimal operations" → SQS/SNS. "Real-time data stream, multiple consumers, replay" → Kinesis. AWS thường gài đáp án Amazon MQ chỉ đúng khi có chữ "migrate" + "protocol có sẵn".

## 48.6 Compute cho job: AWS Batch vs Lambda

**AWS Batch** chạy **batch computing jobs** ở quy mô lớn: bạn submit job (đóng gói dưới dạng **Docker container**), Batch tự provision compute tối ưu (EC2 On-Demand/Spot hoặc Fargate), chạy theo hàng đợi, scale, rồi tắt. Hợp cho xử lý nặng/dài: render video, mô phỏng khoa học, ETL lớn, xử lý hàng loạt ảnh.

So với **Lambda** — điểm phân biệt là các **giới hạn**, và đây mới là chỗ đề thi chốt:

| Tiêu chí | AWS Lambda | AWS Batch |
|---|---|---|
| Thời lượng tối đa | **15 phút** | không giới hạn (chạy bao lâu cũng được) |
| Disk tạm | `/tmp` đến **10 GB** | dung lượng EBS/EFS gắn vào, lớn tùy ý |
| Đóng gói | zip hoặc container image (≤10 GB) | **Docker container** trên ECS/Fargate/EC2 |
| Mô hình | event-driven, theo request | job queue, theo batch |
| Hạ tầng | hoàn toàn không thấy server | dựa trên ECS/EC2, có quản môi trường compute |

**Cấu trúc AWS Batch** gồm: **job definition** (template mô tả container, vCPU, memory, IAM role), **job queue** (xếp hàng job theo priority, gắn với compute environment), và **compute environment** (managed — Batch tự scale EC2/Fargate; hoặc unmanaged — bạn tự quản). Batch hỗ trợ **array jobs** (chạy hàng nghìn job tương tự song song) và **job dependencies** (job B chỉ chạy sau khi A xong) — hữu ích cho pipeline xử lý nhiều giai đoạn.

> 💡 **Exam Tip:** Nếu job **chạy quá 15 phút**, cần **disk lớn**, hoặc là **long-running batch processing** → **AWS Batch** (hoặc ECS/Fargate task), KHÔNG phải Lambda. Đây là bẫy "least operational overhead" hay gài: nhiều người chọn Lambda cho serverless nhưng vướng trần 15 phút. Batch + **Spot** là đáp án khi đề nhấn "cost-effective cho khối lượng tính toán lớn không gấp". Khi đề chỉ nói "chạy task ngắn theo sự kiện" thì vẫn là Lambda; "container chạy lâu, có thể dùng Spot, theo hàng đợi job" mới là Batch.

## 48.7 AWS AppConfig — feature flags & cấu hình động

**AWS AppConfig** (một phần của AWS Systems Manager) quản lý và **triển khai cấu hình động** cho ứng dụng đang chạy — đặc biệt là **feature flags** (bật/tắt tính năng không cần deploy lại code) và cấu hình vận hành (operational config). Khác với Parameter Store/Secrets Manager vốn chỉ là kho lưu giá trị (chi tiết ở Chương 47), AppConfig thêm hai thứ quan trọng: **deployment strategy** và **validator**.

Các thành phần: **Application** → **Environment** (prod/staging) → **Configuration Profile** (nguồn cấu hình: lưu hosted trong AppConfig, hoặc trỏ Parameter Store/S3/Secrets Manager).

- **Deployment strategy**: thay vì áp config mới cho 100% ngay, AppConfig tung dần (**linear** hoặc **canary**) trong khoảng thời gian định trước (deployment duration), kèm **bake time** để theo dõi. Nếu **CloudWatch alarm** trong lúc bake bị trigger → **tự rollback** về config cũ. Đây là điểm khác biệt lớn nhất so với việc tự đọc một parameter rồi đổi đột ngột.
- **Validators**: trước khi deploy, AppConfig kiểm tra config hợp lệ bằng **JSON Schema** (kiểm cú pháp/cấu trúc) hoặc **Lambda validator** (logic tùy ý). Sai schema → chặn deploy ngay, tránh đẩy config hỏng ra production.

Ứng dụng lấy config qua **AppConfig Agent / Lambda extension** (poll và cache cục bộ, giảm latency và số lần gọi API) bằng API `GetLatestConfiguration` + `StartConfigurationSession`.

> 💡 **Exam Tip:** "Feature flag", "đổi cấu hình runtime không deploy lại", "tung config dần dần và tự rollback khi có lỗi", "validate config trước khi áp" → **AppConfig**. Nếu chỉ cần **lưu** một giá trị đơn giản → Parameter Store. Nếu cần **bí mật + rotation** → Secrets Manager. AppConfig = "safe deployment cho configuration".

## 48.8 CloudWatch Evidently & RUM

Hai dịch vụ con của CloudWatch, đề chỉ hỏi mức nhận diện.

- **CloudWatch Evidently**: chạy **feature experiments** — A/B testing và **feature launches** với phân phối traffic theo % (rollout dần một tính năng mới cho một phần người dùng), đo lường tác động bằng metric, có cả khả năng đánh giá thống kê. Khác AppConfig (tập trung deployment/validation của config), Evidently tập trung vào **thử nghiệm và đo lường** tính năng trên người dùng thật.
- **CloudWatch RUM (Real User Monitoring)**: nhúng một đoạn JS vào web app để thu thập **trải nghiệm người dùng thật ở phía client** — page load time, lỗi JavaScript, HTTP error, Core Web Vitals, theo trình duyệt/thiết bị/khu vực. Đây là **client-side monitoring**, bổ sung cho metric server-side và X-Ray.

> 💡 **Exam Tip:** **Evidently = A/B test / feature experiment với phân phối %**. **RUM = giám sát hiệu năng thật từ trình duyệt người dùng** (client-side). Đừng nhầm RUM (real user, client) với Synthetics canary (giả lập request theo lịch). Đừng nhầm Evidently (thử nghiệm/đo lường tính năng) với AppConfig (deploy cấu hình an toàn).

## 48.9 Macie, Nitro Enclaves và bảng tổng hợp

**Amazon Macie** là dịch vụ bảo mật dùng **machine learning** để **phát hiện và phân loại dữ liệu nhạy cảm trong S3** — PII (số CMND, thẻ tín dụng, thông tin sức khỏe), credential. Macie quét bucket, gắn nhãn mức nhạy cảm, cảnh báo qua EventBridge/Security Hub khi bucket bị public hoặc chứa dữ liệu nhạy cảm. Từ khóa nhận diện: **"discover/classify sensitive data (PII) in S3"** → Macie.

**AWS Nitro Enclaves** (mức nhận diện) là môi trường tính toán **cô lập, không có lưu trữ bền, không truy cập mạng, không SSH**, tách khỏi EC2 instance cha — để xử lý dữ liệu **cực kỳ nhạy cảm** (private key, dữ liệu giải mã PII) sao cho ngay cả root trên instance cũng không đọc được. Kèm **cryptographic attestation** để KMS chỉ giải mã cho đúng enclave tin cậy. Từ khóa: **"process highly sensitive data in an isolated environment"**.

Bảng "service nào cho tình huống nào" — gom các dịch vụ chương này:

| Tình huống đề mô tả | Dịch vụ |
|---|---|
| Gửi email HTML/transactional tới khách hàng | **SES** |
| HTTPS cert miễn phí, tự gia hạn cho ALB/CloudFront | **ACM** (CloudFront → us-east-1) |
| Full-text search / log analytics / dashboard | **OpenSearch Service** |
| Query SQL trên dữ liệu S3, serverless, ad-hoc | **Athena** (+ Parquet/partition) |
| Tự dò schema dữ liệu S3, metastore dùng chung | **Glue Crawler / Data Catalog** |
| Migrate app dùng JMS/AMQP/MQTT | **Amazon MQ** |
| Đã có ứng dụng Apache Kafka | **MSK** |
| Job chạy >15 phút / batch lớn / cần Spot | **AWS Batch** |
| Feature flag, deploy config an toàn có rollback | **AppConfig** |
| A/B testing, rollout tính năng theo % | **Evidently** |
| Giám sát hiệu năng phía trình duyệt người dùng thật | **RUM** |
| Phát hiện PII/dữ liệu nhạy cảm trong S3 | **Macie** |
| Xử lý dữ liệu siêu nhạy cảm trong môi trường cô lập | **Nitro Enclaves** |

> 💡 **Exam Tip:** Khi gặp dịch vụ "lạ" trong câu hỏi, đừng hoảng — phần lớn câu này giải được bằng **loại trừ** dựa trên từ khóa: "email" → SES; "certificate/HTTPS" → ACM; "search" → OpenSearch; "SQL trên S3" → Athena; "JMS/AMQP migrate" → Amazon MQ; "feature flag" → AppConfig; "PII trong S3" → Macie. Ghi nhớ một từ khóa đặc trưng cho mỗi service là đủ ăn điểm dạng nhận diện.
