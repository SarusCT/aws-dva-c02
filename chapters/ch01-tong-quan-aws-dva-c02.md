# Chương 1: Tổng quan AWS & Kỳ thi DVA-C02

> **Trọng tâm DVA-C02:** Đề thi không hỏi trực tiếp "Region là gì" nhưng kiến thức về Global Infrastructure, shared responsibility model và cách chọn region là nền cho hàng loạt câu hỏi tình huống (latency, compliance, multi-AZ, edge caching). Ngoài ra, hiểu đúng cấu trúc 4 domain của đề giúp bạn phân bổ thời gian ôn tập chính xác — Development và Security chiếm 58% tổng điểm.

## Mục tiêu chương

- Hiểu cloud computing và các mô hình dịch vụ IaaS / PaaS / SaaS / FaaS, định vị các service AWS theo từng mô hình.
- Nắm chắc AWS Global Infrastructure: Region, Availability Zone (AZ), Edge Location, Local Zone, Wavelength Zone — và cơ chế liên kết giữa chúng.
- Biết 4 tiêu chí chọn region và phân biệt regional service vs global service.
- Thuộc shared responsibility model — AWS chịu phần nào, bạn chịu phần nào, theo từng loại service.
- Hiểu cấu trúc đề DVA-C02: 4 domain, tỷ trọng, hình thức thi, cách đăng ký, chi phí, thang điểm.
- Tạo AWS account đúng cách, bật billing alarm, hiểu giới hạn Free Tier để lab toàn giáo trình không tốn tiền oan.

## 1.1 Cloud computing và các mô hình dịch vụ

Cloud computing là việc cung cấp tài nguyên tính toán (compute, storage, network, database...) **on-demand qua internet, trả tiền theo mức dùng (pay-as-you-go)**. Với một backend developer, điểm khác biệt cốt lõi so với hạ tầng truyền thống không nằm ở "máy chủ của ai" mà ở **API hoá toàn bộ hạ tầng**: mọi tài nguyên trên AWS — từ một EC2 instance đến một rule firewall — đều tạo/sửa/xoá được qua API call. Đây chính là lý do kỳ thi dành cho developer tồn tại: bạn sẽ thao tác hạ tầng bằng SDK và CLI nhiều hơn bằng console.

5 đặc tính của cloud theo định nghĩa NIST (đề không hỏi trực tiếp nhưng giúp bạn suy luận đáp án):

- **On-demand self-service** — tự cấp phát tài nguyên, không cần ticket cho ops.
- **Broad network access** — truy cập qua mạng chuẩn (HTTPS API).
- **Resource pooling** — multi-tenant, AWS gom tài nguyên vật lý phục vụ nhiều khách hàng.
- **Rapid elasticity** — scale ra/vào nhanh, gần như "vô hạn" từ góc nhìn một khách hàng.
- **Measured service** — đo lường chi tiết để tính tiền theo mức dùng.

### Các mô hình dịch vụ — và service AWS tương ứng

| Mô hình | Bạn quản lý | Provider quản lý | Ví dụ AWS |
|---|---|---|---|
| **IaaS** | OS, runtime, app, data | Ảo hoá, server, network vật lý | EC2, EBS, VPC |
| **PaaS** | App, data | OS, runtime, scaling, patching | Elastic Beanstalk, RDS, ECS Fargate |
| **SaaS** | Chỉ dùng | Toàn bộ | Amazon WorkMail, QuickSight |
| **FaaS / Serverless** | Code (function), data | Mọi thứ còn lại, kể cả capacity | Lambda, DynamoDB, S3, SQS |

Trong đề DVA-C02, dải phổ này xuất hiện dưới dạng từ khoá **"least operational overhead"** — khi câu hỏi yêu cầu giảm tối đa công vận hành, đáp án gần như luôn nghiêng về phía serverless/managed (Lambda thay vì EC2, DynamoDB thay vì MongoDB tự cài, Fargate thay vì ECS on EC2).

> 💡 **Exam Tip:** Gặp cụm "least operational overhead" hoặc "minimal management" → loại ngay các đáp án yêu cầu tự quản EC2/cài agent/tự patch OS. Gặp "most cost-effective for unpredictable, spiky traffic" → nghiêng về Lambda/DynamoDB on-demand thay vì tài nguyên provisioned chạy 24/7.

## 1.2 AWS Global Infrastructure

Đây là phần nền tảng nhất của toàn giáo trình. Mọi quyết định kiến trúc về high availability, latency, disaster recovery đều quy về 4 khái niệm: Region, AZ, Edge Location, Local Zone.

### Region

**Region** là một khu vực địa lý chứa một cụm data center, hoàn toàn độc lập với các region khác về điện, mạng, và — quan trọng nhất với developer — **độc lập về dữ liệu và API endpoint**. Hiện AWS có 30+ region (con số tăng dần, đề không hỏi số chính xác). Mỗi region có mã định danh dạng `ap-southeast-1` (Singapore), `us-east-1` (N. Virginia), `ap-southeast-2` (Sydney)...

Các điểm developer phải nắm:

- Tài nguyên mặc định là **region-scoped**: một EC2 instance tạo ở `ap-southeast-1` không hiện ra khi bạn gọi API ở `us-east-1`. Lỗi kinh điển của người mới: "mất" resource vì CLI đang trỏ sai region.
- Mỗi service trong mỗi region có **endpoint riêng**, dạng `<service>.<region>.amazonaws.com`, ví dụ `dynamodb.ap-southeast-1.amazonaws.com`. SDK chọn endpoint dựa trên region bạn cấu hình.
- Dữ liệu **không tự rời khỏi region** — AWS không tự replicate dữ liệu của bạn sang region khác trừ khi bạn cấu hình (S3 CRR, DynamoDB Global Tables, Aurora Global Database...).
- `us-east-1` là region đặc biệt: nơi đặt billing metrics cho CloudWatch, nơi bắt buộc cấp ACM certificate cho CloudFront, và nơi các global service "neo" control plane.

### Availability Zone (AZ)

Mỗi region gồm **tối thiểu 3 AZ** (một số region cũ có 2, chuẩn hiện tại là 3–6). Một AZ là **một hoặc nhiều data center riêng biệt** với nguồn điện, làm mát, mạng độc lập, đặt cách nhau đủ xa để một thảm hoạ cục bộ (cháy, ngập, mất điện) không quật ngã nhiều AZ cùng lúc, nhưng đủ gần để liên kết bằng mạng riêng **độ trễ thấp (single-digit millisecond), băng thông cao, mã hoá**.

Mã AZ dạng `ap-southeast-1a`, `ap-southeast-1b`... Lưu ý cơ chế ít người biết: **chữ cái AZ được map ngẫu nhiên theo từng account** — `ap-southeast-1a` của account bạn có thể là data center khác với `1a` của account đồng nghiệp (AWS làm vậy để phân tán tải). Muốn xác định AZ vật lý thật, dùng **AZ ID** (`apse1-az1`, `apse1-az2`...) — quan trọng khi hai account cần đặt tài nguyên cùng AZ vật lý (ví dụ chia sẻ VPC subnet, giảm cross-AZ data transfer).

```bash
# Liệt kê AZ kèm AZ ID của region hiện tại (AWS CLI v2)
aws ec2 describe-availability-zones \
  --region ap-southeast-1 \
  --query 'AvailabilityZones[].[ZoneName,ZoneId,State]' \
  --output table
```

AZ là đơn vị thiết kế **high availability**: Multi-AZ RDS đặt standby ở AZ khác, ALB rải target qua nhiều AZ, ASG phân bố instance đều các AZ. Khi đề nói "the application must survive the failure of a data center" → trải qua **nhiều AZ**; "must survive a regional outage / disaster recovery" → **nhiều region**.

### Edge Location & Regional Edge Cache

**Edge Location** là các điểm hiện diện (PoP — Point of Presence) đặt tại 400+ thành phố, **nhiều hơn và phân tán hơn region rất nhiều**. Chúng không chạy EC2 hay RDS; nhiệm vụ là đưa nội dung và tiếp nhận traffic **gần người dùng nhất**:

- **CloudFront** cache content tại edge (chi tiết ở Chương 15).
- **Route 53** trả lời DNS query từ edge (Chương 10).
- **AWS Global Accelerator** đưa traffic vào backbone của AWS từ edge gần nhất.
- **S3 Transfer Acceleration** upload qua edge rồi chạy backbone về bucket (Chương 13).
- **Lambda@Edge / CloudFront Functions** chạy code tại edge (Chương 29).

Giữa edge location và origin còn có lớp **Regional Edge Cache** — cache lớn hơn, giữ object lâu hơn, giảm số lần về origin.

### Local Zone, Wavelength Zone, Outposts

- **Local Zone**: phần mở rộng của một region, đặt compute/storage (EC2, EBS, một số service) sát các đô thị lớn xa region cha — phục vụ ứng dụng cần **latency single-digit ms tới end-user** (game server, realtime media). Local Zone gắn vào VPC của region cha như một subnet bình thường.
- **Wavelength Zone**: hạ tầng AWS nhúng trong data center của nhà mạng 5G — latency cực thấp cho thiết bị di động.
- **Outposts**: rack phần cứng AWS đặt trong data center **của bạn**, chạy API AWS on-premises — phục vụ yêu cầu data residency/latency nội bộ.

| Thành phần | Phạm vi | Dùng khi |
|---|---|---|
| Region | Khu vực địa lý, ≥3 AZ | Triển khai mặc định |
| AZ | Cụm data center trong region | High availability trong region |
| Edge Location | 400+ PoP toàn cầu | Cache/CDN, DNS, vào backbone gần user |
| Local Zone | Mở rộng region tới đô thị | Compute latency thấp tới end-user |
| Wavelength | Trong mạng 5G của carrier | Ứng dụng 5G ultra-low latency |
| Outposts | Trong DC của khách hàng | Data residency, hybrid |

> 💡 **Exam Tip:** Phân biệt nhanh: nội dung tĩnh cần đến gần user toàn cầu → **CloudFront (edge location)**; compute cần latency thấp tại một thành phố cụ thể → **Local Zone**; ứng dụng 5G → **Wavelength**. Đề hay gài đáp án "tạo thêm region" — bạn không thể tạo region, chỉ AWS làm được.

## 1.3 Chọn region và regional vs global services

### 4 tiêu chí chọn region

1. **Compliance / data residency** — yêu cầu pháp lý buộc dữ liệu nằm trong lãnh thổ (GDPR, luật dữ liệu cá nhân). Đây là tiêu chí **phủ quyết**: nếu luật yêu cầu, các tiêu chí khác vô nghĩa.
2. **Latency tới người dùng** — chọn region gần user chính. User ở Việt Nam → `ap-southeast-1` (Singapore) thường cho RTT ~30–40ms.
3. **Service availability** — không phải service/feature/instance type nào cũng có ở mọi region. Service mới thường ra `us-east-1`, `us-west-2`, `eu-west-1` trước.
4. **Pricing** — giá khác nhau theo region với cùng tài nguyên. `us-east-1` thường rẻ nhất; São Paulo, một số region châu Á đắt hơn đáng kể (chênh 20–50% cho EC2).

Kiểm tra service có ở region nào bằng CLI (dữ liệu lấy từ SSM public parameters):

```bash
# Các region có AWS X-Ray
aws ssm get-parameters-by-path \
  --path /aws/service/global-infrastructure/services/xray/regions \
  --query 'Parameters[].Value' --output text

# Liệt kê region đang enabled cho account
aws ec2 describe-regions \
  --query 'Regions[].RegionName' --output table
```

Với SDK JavaScript v3, region khai báo khi khởi tạo client — mỗi client trỏ một region:

```javascript
// AWS SDK for JavaScript v3
import { EC2Client, DescribeRegionsCommand } from "@aws-sdk/client-ec2";

// Mỗi client gắn với 1 region; không set thì lấy từ env AWS_REGION / config file
const client = new EC2Client({ region: "ap-southeast-1" });

const { Regions } = await client.send(new DescribeRegionsCommand({}));
Regions.forEach((r) => console.log(r.RegionName, r.Endpoint));
```

Go SDK v2 tương tự, region nằm trong `config`:

```go
// Go SDK v2 — load config với region tường minh
cfg, err := config.LoadDefaultConfig(context.TODO(),
    config.WithRegion("ap-southeast-1"))
if err != nil { log.Fatal(err) }
client := ec2.NewFromConfig(cfg)
```

(Cấu hình credentials, profiles, provider chain chi tiết ở Chương 3.)

### Regional service vs global service

Đa số service là **regional** — bạn phải chọn region và tài nguyên sống trong region đó: EC2, Lambda, SQS, DynamoDB, RDS... Một số ít là **global** — một namespace duy nhất cho toàn account:

| Global service | Ghi chú |
|---|---|
| IAM | User/role/policy dùng được mọi region (Chương 2) |
| Route 53 | DNS là hệ toàn cầu (Chương 10) |
| CloudFront | Distribution phục vụ từ mọi edge (Chương 15) |
| WAF (cho CloudFront) | Scope global khi gắn CloudFront |

Lưu ý bẫy thực tế: **S3 bucket name là globally unique** nhưng **bucket vẫn là tài nguyên regional** — dữ liệu nằm trong region bạn chọn lúc tạo (Chương 12). Tương tự, IAM là global nhưng **STS endpoint có cả regional endpoints** để giảm latency (Chương 45).

> 💡 **Exam Tip:** ACM certificate dùng cho **CloudFront bắt buộc cấp ở `us-east-1`**; dùng cho ALB/API Gateway thì cấp tại region của tài nguyên đó. Đây là câu gài rất phổ biến khi đề nói "certificate không hiện ra trong dropdown của CloudFront".

## 1.4 Shared Responsibility Model

Mô hình trách nhiệm chia sẻ trả lời câu hỏi: **khi có sự cố bảo mật, lỗi của ai?** Nguyên tắc gốc:

- **AWS chịu trách nhiệm bảo mật CỦA cloud** (security **of** the cloud): phần cứng, network vật lý, hypervisor, cơ sở vật chất, và phần mềm của các managed service.
- **Khách hàng chịu trách nhiệm bảo mật TRONG cloud** (security **in** the cloud): dữ liệu, cấu hình, quyền truy cập, mã hoá, code.

Ranh giới **dịch chuyển theo loại service**:

| Trách nhiệm | EC2 (IaaS) | RDS / Beanstalk (managed) | Lambda / S3 / DynamoDB (serverless) |
|---|---|---|---|
| Phần cứng, DC, network vật lý | AWS | AWS | AWS |
| Hypervisor / virtualization | AWS | AWS | AWS |
| Patch OS | **Bạn** | AWS | AWS |
| Patch runtime / DB engine | **Bạn** | AWS (bạn chọn maintenance window) | AWS |
| Cấu hình network (SG, NACL) | **Bạn** | **Bạn** | Bạn (nếu trong VPC) |
| Application code | **Bạn** | **Bạn** | **Bạn** |
| IAM, quyền truy cập | **Bạn** | **Bạn** | **Bạn** |
| Mã hoá & phân loại dữ liệu | **Bạn** | **Bạn** | **Bạn** |

Những điểm hay nhầm trong đề:

- **Khách hàng LUÔN chịu trách nhiệm về dữ liệu và IAM** — kể cả với service "managed" nhất. S3 bucket public lộ dữ liệu là lỗi của bạn, không phải AWS.
- Với EC2, **bạn patch guest OS**; AWS chỉ patch hypervisor. Với RDS thì ngược lại — bạn không SSH được vào instance RDS, AWS patch giúp.
- **Bật mã hoá là trách nhiệm của khách hàng** (chọn SSE-KMS, bật EBS encryption...), còn cơ chế mã hoá hoạt động đúng là trách nhiệm AWS.
- Một số trách nhiệm là **shared đúng nghĩa**: patch management (AWS patch hạ tầng, bạn patch OS/app), configuration management, awareness & training.

> 💡 **Exam Tip:** Câu hỏi dạng "Who is responsible for X?" — nếu X dính tới **data, IAM, cấu hình bảo mật, mã hoá phía bạn bật/tắt** → khách hàng. Nếu X là **hạ tầng vật lý, hypervisor, phần mềm nền của managed service** → AWS. Từ khoá "operating system patching on EC2" → khách hàng; "operating system patching on Lambda" → AWS.

## 1.5 Kỳ thi DVA-C02: cấu trúc đề và 4 domain

### Thông số kỳ thi

| Hạng mục | Chi tiết |
|---|---|
| Mã đề | DVA-C02 (thay DVA-C01 từ 02/2023) |
| Số câu | **65 câu** (multiple choice — 1 đáp án đúng/4, và multiple response — 2+ đáp án đúng, đề ghi rõ "Choose TWO/THREE") |
| Câu unscored | **15 câu** thử nghiệm không tính điểm, trộn lẫn, không phân biệt được |
| Thời gian | **130 phút** (~2 phút/câu) |
| Thang điểm | 100–1000, **pass ≥ 720** — scaled score, không phải % câu đúng |
| Chi phí | **150 USD** (có thể mua practice exam chính thức ~20 USD) |
| Hình thức | Test center (Pearson VUE) hoặc **online proctored** tại nhà |
| Ngôn ngữ | Tiếng Anh, Nhật, Hàn, Trung giản thể... (chưa có tiếng Việt) |
| Hiệu lực | Chứng chỉ 3 năm; thi lại sau 14 ngày nếu trượt |
| Điều kiện | Không yêu cầu prerequisite; AWS khuyến nghị ~1 năm kinh nghiệm |

Lưu ý có lợi cho người không nói tiếng Anh bản ngữ: bạn có thể request accommodation **"ESL +30"** (thêm 30 phút) **trước khi** đặt lịch thi — làm một lần, áp dụng các lần thi sau.

### 4 domain và tỷ trọng

| Domain | Tỷ trọng | Nội dung chính | Chương trong giáo trình |
|---|---|---|---|
| 1. Development with AWS Services | **32%** | Lambda, API Gateway, DynamoDB, SQS/SNS/Kinesis, Step Functions, SDK patterns, idempotency, fault-tolerant code | 21–23, 28–35, 43–44 |
| 2. Security | **26%** | IAM, Cognito, KMS, Secrets Manager/Parameter Store, mã hoá, presigned URL, cross-account | 2, 14, 38–39, 45–47 |
| 3. Deployment | **24%** | SAM, CloudFormation, CDK, Beanstalk, CodeBuild/Deploy/Pipeline, canary/blue-green | 18–20, 36–37, 40–42 |
| 4. Troubleshooting & Optimization | **18%** | CloudWatch, X-Ray, CloudTrail, caching, tối ưu Lambda/DynamoDB, root cause analysis | 9, 15, 24–27, 29, 33 |

Đọc bảng này theo hướng chiến lược ôn: **Development + Security = 58%** — nếu bạn chắc Lambda, DynamoDB, API Gateway, IAM, KMS và bộ messaging, bạn đã đi quá nửa đường. Domain 4 tuy chỉ 18% nhưng câu hỏi thường dễ ăn điểm nếu thuộc bảng phân biệt CloudWatch vs CloudTrail vs X-Ray (Chương 27).

Dạng câu hỏi đặc trưng của DVA-C02 là **scenario**: "A developer is building... The application must... Which solution meets these requirements?" — luôn có 2 đáp án sai rõ và 2 đáp án "đều chạy được", phân thắng bại bằng ràng buộc trong đề (cost, latency, operational overhead, "MOST secure"). Kỹ thuật làm bài chi tiết ở Chương 50.

### Đăng ký thi

1. Tạo account tại **aws.training** (đăng nhập bằng Amazon account hoặc công ty).
2. Vào **Certmetrics / AWS Certification** → Schedule exam → chọn DVA-C02 → chọn Pearson VUE.
3. Chọn test center hoặc online proctored (online cần webcam, phòng riêng, bàn trống; check-in sớm 30 phút).
4. Thanh toán 150 USD. Nếu đã có chứng chỉ AWS khác, dùng **voucher giảm 50%** trong benefit của chứng chỉ cũ.

> 💡 **Exam Tip (meta):** Điểm pass 720/1000 là scaled — thực tế tương đương trả lời đúng khoảng 65–72% số câu được tính điểm. Không có điểm trừ cho câu sai → **không bao giờ bỏ trống câu nào**; flag câu khó và quay lại sau.

## 1.6 Tạo AWS account và Free Tier

### Tạo account đúng cách

Quy trình: vào `aws.amazon.com` → Create an AWS Account → cần **email duy nhất** (mẹo: dùng alias `ten+aws-lab@gmail.com` để tách account lab), **thẻ tín dụng/ghi nợ quốc tế** (bị hold ~1 USD để xác minh), và xác thực số điện thoại. Account mới sinh ra một **root user** — identity gắn với email đăng ký, có quyền tuyệt đối không thể bị policy nào giới hạn.

Việc cần làm ngay sau khi tạo account (sẽ thực hành ở lab part 2 và đào sâu ở Chương 2):

1. **Bật MFA cho root user** — root bị lộ là mất cả account.
2. **Không tạo access key cho root.** Root chỉ dùng cho vài việc bắt buộc: đổi support plan, đóng account, một số thiết lập billing/tax.
3. Tạo **IAM user/role admin** riêng để làm việc hằng ngày (chi tiết Chương 2).
4. Bật **IAM user access to billing** (mặc định IAM user không xem được billing console dù có policy AdministratorAccess — phải bật bằng root tại Account settings).
5. Tạo **billing alarm / budget** (mục 1.7).

### Free Tier — 3 loại, đừng nhầm

| Loại | Cơ chế | Ví dụ |
|---|---|---|
| **12-month free** | Miễn phí 12 tháng kể từ ngày tạo account, trong hạn mức | EC2 750 giờ/tháng (t2.micro hoặc t3.micro tuỳ region), RDS 750 giờ/tháng db.t2/t3/t4g.micro, S3 5GB Standard, EBS 30GB |
| **Always free** | Miễn phí vĩnh viễn, mọi account, trong hạn mức tháng | **Lambda 1 triệu request + 400.000 GB-giây/tháng**, **DynamoDB 25GB + 25 RCU/25 WCU**, SQS 1 triệu request, SNS 1 triệu publish, CloudWatch 10 metrics + 10 alarms |
| **Trials** | Dùng thử ngắn hạn khi kích hoạt lần đầu | SageMaker, Redshift, Inspector... |

(AWS đang chuyển dần account mới sang Free Plan dạng credit — kiểm tra điều khoản hiện hành khi đăng ký; cơ chế always-free cho Lambda/DynamoDB vẫn là kiến thức nên nhớ.)

Hệ quả thực tế cho giáo trình này: phần lớn lab serverless (Lambda, DynamoDB, SQS, SNS, API Gateway 1 triệu call/tháng trong 12 tháng đầu) **gần như miễn phí**. Thứ tốn tiền âm thầm là: **NAT Gateway (~0.045 USD/giờ + data)**, **Elastic IP không gắn instance**, **RDS/ElastiCache quên tắt**, **EBS volume/snapshot mồ côi**, và **data transfer ra internet** (free 100GB/tháng, sau đó ~0.09 USD/GB). 750 giờ EC2 = đúng 1 instance chạy 24/7 — chạy 2 instance là vượt sau nửa tháng.

> 💡 **Exam Tip:** Data transfer **vào** AWS (ingress) miễn phí; **ra internet** (egress) tính tiền; **giữa các AZ trong cùng region** cũng tính tiền (~0.01 USD/GB mỗi chiều) — chi tiết này xuất hiện trong câu hỏi tối ưu chi phí kiến trúc multi-AZ.

## 1.7 Billing alarm, Budgets và theo dõi chi phí

Có hai cơ chế cảnh báo chi phí, đề và thực tế đều cần phân biệt:

### CloudWatch billing alarm

Metric `EstimatedCharges` (namespace `AWS/Billing`) **chỉ tồn tại ở `us-east-1`**, cập nhật vài lần mỗi ngày. Phải bật trước "Receive Billing Alerts" trong Billing preferences (làm bằng root hoặc user có quyền billing). Tạo bằng CLI:

```bash
# 1) Tạo SNS topic nhận cảnh báo (PHẢI ở us-east-1)
aws sns create-topic --name billing-alarm --region us-east-1
aws sns subscribe --region us-east-1 \
  --topic-arn arn:aws:sns:us-east-1:123456789012:billing-alarm \
  --protocol email --notification-endpoint duntt232@gmail.com
# → mở email bấm Confirm subscription

# 2) Alarm khi ước tính chi phí vượt 5 USD
aws cloudwatch put-metric-alarm --region us-east-1 \
  --alarm-name billing-over-5usd \
  --namespace AWS/Billing --metric-name EstimatedCharges \
  --dimensions Name=Currency,Value=USD \
  --statistic Maximum --period 21600 \
  --evaluation-periods 1 --threshold 5 \
  --comparison-operator GreaterThanThreshold \
  --alarm-actions arn:aws:sns:us-east-1:123456789012:billing-alarm
```

(Cơ chế alarm, states, evaluation periods chi tiết ở Chương 24.)

### AWS Budgets

Linh hoạt hơn billing alarm: đặt ngân sách theo tháng, cảnh báo theo **actual** lẫn **forecasted** (dự báo sẽ vượt), lọc theo service/tag, thậm chí gắn action tự động (ví dụ detach policy). 2 budget đầu tiên loại cost budget miễn phí.

```bash
aws budgets create-budget --account-id 123456789012 \
  --budget '{
    "BudgetName": "monthly-10usd",
    "BudgetLimit": {"Amount": "10", "Unit": "USD"},
    "TimeUnit": "MONTHLY",
    "BudgetType": "COST"
  }' \
  --notifications-with-subscribers '[{
    "Notification": {
      "NotificationType": "FORECASTED",
      "ComparisonOperator": "GREATER_THAN",
      "Threshold": 80,
      "ThresholdType": "PERCENTAGE"
    },
    "Subscribers": [{"SubscriptionType": "EMAIL", "Address": "duntt232@gmail.com"}]
  }]'
```

| | CloudWatch billing alarm | AWS Budgets |
|---|---|---|
| Vị trí | Chỉ `us-east-1` | Global (billing console) |
| Cảnh báo theo dự báo | Không | **Có (forecasted)** |
| Lọc theo service/tag | Không (chỉ tổng + per-service dimension) | Có, linh hoạt |
| Action tự động | Qua SNS → tự viết | Built-in budget actions |
| Chi phí | Free tier 10 alarms | 2 budgets đầu free |

Thói quen nên có khi học: cuối mỗi buổi lab mở **Cost Explorer** (bật lần đầu mất ~24h mới có data) lọc theo ngày, và luôn làm bước "Dọn dẹp tài nguyên" trong lab part 2 của mỗi chương.

> 💡 **Exam Tip:** "Developer cần được cảnh báo TRƯỚC KHI chi phí vượt ngân sách" → **AWS Budgets với forecasted alert**, không phải CloudWatch billing alarm (chỉ báo khi đã vượt). Và nhớ: billing metric chỉ có ở **us-east-1**.

## 1.8 Lộ trình ôn theo giáo trình này

Giáo trình 50 chương ánh xạ thẳng vào 4 domain (bảng ở mục 1.5). Gợi ý cách dùng:

**Trình tự**: học tuần tự Phần I–II (nền tảng — IAM, CLI/SDK, EC2, ELB/ASG, RDS, Route 53, VPC, S3) vì mọi chương sau đều giả định bạn đã nắm. Từ Phần III trở đi có thể đảo thứ tự theo nhu cầu, nhưng cụm **Chương 28–35 (Lambda, DynamoDB, API Gateway)** là trái tim của đề — đầu tư nhiều thời gian nhất, làm lab đầy đủ.

**Cách học mỗi chương**: đọc lý thuyết (part 1) → làm lab tay trên account thật (part 2) → làm quiz 10 câu, đọc kỹ giải thích cả đáp án sai → ghi lại limit/quota quan trọng vào flashcard (Lambda timeout 15 phút, SQS message 256KB, API Gateway timeout 29 giây... — mỗi chương sẽ nhấn các con số này).

**Hai mốc tổng duyệt**: Chương 49 là đề mô phỏng 65 câu đúng phân bố domain — làm như thi thật, 130 phút, chấm điểm theo domain để biết lỗ hổng; Chương 50 cho chiến lược làm bài, bảng từ khoá nhận diện đáp án và lộ trình ôn 4/8 tuần chi tiết.

**Nguyên tắc quan trọng nhất**: DVA-C02 là đề thi của người **đã từng gõ lệnh** — câu hỏi mô tả lỗi thực tế (429 throttling, AccessDenied, trace không hiện trên X-Ray, deployment bị rollback). Đọc suông không đủ; 20 phút lab đáng giá hơn 2 giờ đọc lại lý thuyết. Account free tier + billing alarm bạn vừa thiết lập ở mục 1.6–1.7 chính là "phòng gym" cho 49 chương còn lại.

> 💡 **Exam Tip:** Khi ôn, ưu tiên học **sự khác biệt giữa các service tương tự** (SQS vs SNS vs Kinesis, ALB vs NLB, RDS Read Replica vs Multi-AZ, Parameter Store vs Secrets Manager...) — phần lớn câu hỏi DVA-C02 thực chất là bài toán "chọn đúng service/feature cho ràng buộc cho trước", và các bảng so sánh trong giáo trình này được viết đúng cho kiểu câu hỏi đó.

---

## Hands-on Lab: Thiết lập AWS account chuẩn, khám phá Global Infrastructure và dựng billing alarm

**Mục tiêu lab:** Sau lab này bạn có một AWS account được bảo vệ bằng MFA, một IAM user làm việc hằng ngày, biết dùng AWS CLI để liệt kê Regions/AZs (tự kiểm chứng kiến thức Global Infrastructure), và quan trọng nhất: có billing alarm + AWS Budget để không bao giờ bị "cháy ví" khi làm các lab ở những chương sau.

**Chuẩn bị:**
- Một email chưa từng dùng cho AWS và một thẻ credit/debit quốc tế (AWS sẽ tạm giữ ~1 USD để xác minh).
- Điện thoại cài app TOTP (Google Authenticator, Authy...) để bật MFA.
- Máy đã cài AWS CLI v2 (`aws --version` phải in ra `aws-cli/2.x.x`). Cách cài chi tiết ở Chương 3 — ở đây chỉ cần cài xong là được.

### Bước 1: Tạo AWS account và khoá root user lại

1. Vào `https://aws.amazon.com` → **Create an AWS Account**. Nhập email, đặt account name (ví dụ `dva-lab`), xác minh email bằng mã OTP.
2. Đặt password cho **root user**. Đây là identity có toàn quyền tuyệt đối trên account — kể cả đóng account và đổi phương thức thanh toán — nên nguyên tắc là: tạo xong, bật MFA, rồi **không bao giờ dùng root cho công việc hằng ngày**.
3. Chọn plan **Basic support (Free)**. Hoàn tất xác minh thẻ và số điện thoại.
4. Đăng nhập console bằng root → góc phải trên chọn tên account → **Security credentials** → **Assign MFA device** → chọn **Authenticator app**, quét QR, nhập 2 mã OTP liên tiếp.

**Output mong đợi:** Trang Security credentials hiển thị `MFA device: Assigned` cho root user. Mục **Access keys** của root phải trống — đừng bao giờ tạo access key cho root.

### Bước 2: Tạo IAM user làm việc hằng ngày

Chi tiết về IAM (policies, groups, roles) ở Chương 2 — ở đây chỉ làm tối thiểu để có credentials chạy CLI:

1. Console → **IAM** → **Users** → **Create user**, đặt tên `dva-admin`, tick **Provide user access to the AWS Management Console**.
2. Ở bước permissions: **Attach policies directly** → chọn `AdministratorAccess` (chấp nhận được cho account học cá nhân; môi trường công ty thì không — Chương 2 giải thích least privilege).
3. Sau khi tạo user → tab **Security credentials** → **Create access key** → chọn use case **Command Line Interface (CLI)** → lưu lại `Access key ID` và `Secret access key` (secret chỉ hiển thị một lần duy nhất).

Cấu hình CLI:

```bash
aws configure
# AWS Access Key ID [None]: AKIA................
# AWS Secret Access Key [None]: ****************************
# Default region name [None]: ap-southeast-1
# Default output format [None]: json
```

Kiểm tra credentials hoạt động:

```bash
aws sts get-caller-identity
```

**Output mong đợi:**

```json
{
    "UserId": "AIDAEXAMPLEUSERID123",
    "Account": "123456789012",
    "Arn": "arn:aws:iam::123456789012:user/dva-admin"
}
```

Nếu `Arn` kết thúc bằng `:root` nghĩa là bạn đang dùng access key của root — quay lại xoá ngay.

### Bước 3: Khám phá Regions và Availability Zones bằng CLI

Tự kiểm chứng những gì đã học ở part 1. Liệt kê toàn bộ Regions account của bạn thấy được:

```bash
aws ec2 describe-regions \
  --query "Regions[].RegionName" \
  --output table
```

**Output mong đợi:** bảng ~17–20 region (các region mặc định enabled; những region mới như `ap-southeast-3` phải opt-in mới hiện). Thêm `--all-regions` để thấy cả region chưa opt-in kèm trạng thái `not-opted-in`.

Xem các AZ của region Singapore:

```bash
aws ec2 describe-availability-zones \
  --region ap-southeast-1 \
  --query "AvailabilityZones[].{Name:ZoneName,Id:ZoneId,Type:ZoneType,State:State}" \
  --output table
```

**Output mong đợi:** 3 AZ (`ap-southeast-1a/1b/1c`) với `ZoneType: availability-zone`, `State: available`. Để ý cột `Id` (ví dụ `apse1-az1`): **AZ name được map ngẫu nhiên khác nhau giữa các account** — `ap-southeast-1a` của bạn có thể là datacenter khác với `1a` của đồng nghiệp; chỉ `ZoneId` mới là định danh vật lý nhất quán. Đây là chi tiết hay gặp khi phối hợp tài nguyên cross-account.

Đếm nhanh số AZ mỗi region (chạy được trên macOS/Linux):

```bash
for r in us-east-1 ap-southeast-1 ap-northeast-1; do
  n=$(aws ec2 describe-availability-zones --region "$r" \
      --query "length(AvailabilityZones)" --output text)
  echo "$r: $n AZ"
done
```

**Output mong đợi:** `us-east-1: 6 AZ`, `ap-southeast-1: 3 AZ`, `ap-northeast-1: 4 AZ` (con số có thể tăng theo thời gian — đề thi không hỏi số AZ của region cụ thể, chỉ cần nhớ quy tắc mỗi region có **tối thiểu 3 AZ** với các region mới).

### Bước 4: Bật billing alerts và tạo CloudWatch billing alarm

Billing metric (`EstimatedCharges`) **chỉ tồn tại ở `us-east-1`** bất kể bạn dùng tài nguyên ở region nào — bẫy kinh điển cả trong thực tế lẫn đề thi.

1. Bật billing alerts (làm một lần, bằng console vì cần root hoặc IAM user được cấp quyền billing): đăng nhập → **Billing and Cost Management** → **Billing preferences** → tick **Receive CloudWatch billing alerts** → Save. Lưu ý: nếu IAM user không thấy trang Billing, root phải bật **IAM user and role access to Billing information** trong Account settings trước.
2. Tạo SNS topic ở `us-east-1` và subscribe email:

```bash
aws sns create-topic --name billing-alarm-topic --region us-east-1
# Lưu lại TopicArn trong output

aws sns subscribe \
  --topic-arn arn:aws:sns:us-east-1:123456789012:billing-alarm-topic \
  --protocol email \
  --notification-endpoint duntt232@gmail.com \
  --region us-east-1
```

**Output mong đợi:** `"SubscriptionArn": "pending confirmation"` — mở email và bấm **Confirm subscription**, nếu không alarm sẽ bắn vào hư không.

3. Tạo alarm cảnh báo khi chi phí ước tính vượt 5 USD:

```bash
aws cloudwatch put-metric-alarm \
  --alarm-name billing-over-5-usd \
  --alarm-description "Canh bao khi chi phi uoc tinh vuot 5 USD" \
  --namespace AWS/Billing \
  --metric-name EstimatedCharges \
  --dimensions Name=Currency,Value=USD \
  --statistic Maximum \
  --period 21600 \
  --evaluation-periods 1 \
  --threshold 5 \
  --comparison-operator GreaterThanThreshold \
  --alarm-actions arn:aws:sns:us-east-1:123456789012:billing-alarm-topic \
  --region us-east-1
```

Kiểm tra:

```bash
aws cloudwatch describe-alarms \
  --alarm-names billing-over-5-usd \
  --region us-east-1 \
  --query "MetricAlarms[].{Name:AlarmName,State:StateValue}" \
  --output table
```

**Output mong đợi:** state `INSUFFICIENT_DATA` trong vài giờ đầu (metric `EstimatedCharges` chỉ được ghi ~6 tiếng/lần), sau đó chuyển `OK`.

### Bước 5: Tạo AWS Budget (lớp bảo vệ thứ hai)

Billing alarm dựa trên metric ước tính; AWS Budgets mạnh hơn vì cảnh báo được theo **forecast** (dự báo sẽ vượt) chứ không chỉ actual. Hai budget đầu tiên miễn phí.

```bash
cat > /tmp/budget.json <<'EOF'
{
  "BudgetName": "monthly-10-usd",
  "BudgetLimit": { "Amount": "10", "Unit": "USD" },
  "TimeUnit": "MONTHLY",
  "BudgetType": "COST"
}
EOF

cat > /tmp/notifications.json <<'EOF'
[
  {
    "Notification": {
      "NotificationType": "ACTUAL",
      "ComparisonOperator": "GREATER_THAN",
      "Threshold": 80,
      "ThresholdType": "PERCENTAGE"
    },
    "Subscribers": [
      { "SubscriptionType": "EMAIL", "Address": "duntt232@gmail.com" }
    ]
  },
  {
    "Notification": {
      "NotificationType": "FORECASTED",
      "ComparisonOperator": "GREATER_THAN",
      "Threshold": 100,
      "ThresholdType": "PERCENTAGE"
    },
    "Subscribers": [
      { "SubscriptionType": "EMAIL", "Address": "duntt232@gmail.com" }
    ]
  }
]
EOF

aws budgets create-budget \
  --account-id 123456789012 \
  --budget file:///tmp/budget.json \
  --notifications-with-subscribers file:///tmp/notifications.json
```

**Output mong đợi:** lệnh trả về rỗng (exit code 0). Xác nhận bằng `aws budgets describe-budgets --account-id 123456789012 --query "Budgets[].BudgetName"` → thấy `monthly-10-usd`. Bạn sẽ nhận email khi chi tiêu thực tế chạm 8 USD hoặc khi AWS dự báo cả tháng sẽ vượt 10 USD.

### Bước 6: Kiểm tra mức dùng Free Tier

```bash
aws freetier get-free-tier-usage \
  --query "freeTierUsages[?actualUsageAmount>\`0\`].{Service:service,Used:actualUsageAmount,Limit:limit,Unit:unit}" \
  --output table \
  --region us-east-1
```

**Output mong đợi:** bảng các dịch vụ đang tiêu free tier (mới tạo account thường rỗng). Quay lại lệnh này sau mỗi lab để biết mình còn bao nhiêu "quota miễn phí" — ví dụ Lambda 1 triệu request/tháng là **always free**, còn 750 giờ EC2 t2.micro/t3.micro chỉ áp dụng 12 tháng đầu.

### Dọn dẹp tài nguyên

Lab này gần như không tốn tiền (SNS topic, CloudWatch alarm đầu tiên, 2 budget đầu đều free), và billing alarm + budget thì **nên giữ lại suốt giáo trình**. Nếu vẫn muốn xoá sạch:

```bash
# Xoá alarm
aws cloudwatch delete-alarms --alarm-names billing-over-5-usd --region us-east-1

# Xoá SNS topic (tự xoá luôn các subscription)
aws sns delete-topic \
  --topic-arn arn:aws:sns:us-east-1:123456789012:billing-alarm-topic \
  --region us-east-1

# Xoá budget
aws budgets delete-budget --account-id 123456789012 --budget-name monthly-10-usd

# Xoá file tạm
rm /tmp/budget.json /tmp/notifications.json
```

Giữ lại IAM user `dva-admin` và MFA của root — các chương sau dùng tiếp.

## 💡 Exam Tips chương 1

- **Region = cụm địa lý gồm nhiều AZ; AZ = một hoặc nhiều datacenter riêng biệt** có điện, mạng, làm mát độc lập, nối với nhau bằng đường truyền low-latency. Câu hỏi "high availability trong một region" → trải tài nguyên ra **nhiều AZ**, không phải nhiều region.
- **Edge Locations** (hơn 400 điểm) phục vụ CloudFront/Route 53/Global Accelerator — nhiều hơn hẳn số region. Câu hỏi "giảm latency cho người dùng toàn cầu với static content" → Edge Locations/CloudFront, không phải tạo thêm region.
- **Local Zones** = mở rộng của một region đặt gần người dùng cuối cho workload cần single-digit millisecond latency (game, video editing). Phân biệt với Edge Location: Local Zone chạy được EC2/EBS, Edge Location thì không.
- **Shared responsibility model:** AWS chịu trách nhiệm security **OF** the cloud (hạ tầng vật lý, hypervisor, phần mềm của managed service); khách hàng chịu security **IN** the cloud (data, IAM, cấu hình SG, patching guest OS trên EC2, encryption phía mình). Với managed service (Lambda, DynamoDB), patching OS chuyển sang AWS nhưng IAM và data vẫn luôn là của bạn.
- 4 tiêu chí chọn region, theo thứ tự ưu tiên đề hay gài: **compliance/data residency** (luật buộc data ở đâu thì chọn đó — thắng mọi tiêu chí khác) → **latency tới người dùng** → **service availability** (dịch vụ mới không có ở mọi region) → **pricing** (giá khác nhau giữa region).
- Phân bố domain DVA-C02: **Development 32%, Security 26%, Deployment 24%, Troubleshooting & Optimization 18%**. Security đứng thứ hai — đừng học lướt IAM/KMS/Cognito.
- Hình thức thi: **65 câu / 130 phút**, trong đó **15 câu unscored** (không biết câu nào), thang điểm **100–1000, pass 720**. Điểm tính theo scaled score, không phải "đúng 72% số câu".
- Không có điểm trừ cho câu sai → **không bao giờ bỏ trống câu nào**, kể cả phải đoán.
- Billing alarm dùng metric `EstimatedCharges` trong namespace `AWS/Billing` và **chỉ có ở us-east-1**. AWS Budgets cảnh báo được theo cả ACTUAL lẫn FORECASTED.
- AZ name (`us-east-1a`) được **map ngẫu nhiên theo từng account**; muốn trỏ đúng cùng một datacenter giữa các account phải dùng **AZ ID** (`use1-az1`).
- Root user: chỉ dùng cho các tác vụ bắt buộc (đổi support plan, đóng account, một số thiết lập billing); luôn bật MFA, **không tạo access key**. Làm việc hằng ngày bằng IAM user/role.
- Free tier có 3 loại: **12 tháng** (EC2 750h, RDS 750h, S3 5GB), **always free** (Lambda 1M request, DynamoDB 25GB), **trial ngắn hạn**. Đề ít hỏi trực tiếp nhưng nhầm loại free tier là cách "cháy ví" nhanh nhất khi tự học.

## Quiz chương 1 (10 câu)

**Câu 1.** Một công ty fintech tại Đức bị luật yêu cầu toàn bộ dữ liệu khách hàng phải lưu trữ trên lãnh thổ Đức. Ứng dụng có người dùng ở cả châu Âu và châu Á. Developer nên chọn region theo tiêu chí nào TRƯỚC TIÊN?
- A. Region có giá rẻ nhất để tối ưu chi phí
- B. Region có latency thấp nhất tới phần lớn người dùng
- C. Region thoả mãn yêu cầu compliance/data residency (eu-central-1)
- D. Region có nhiều AZ nhất để tăng tính sẵn sàng

**Câu 2.** Một ứng dụng cần đạt high availability: nếu một datacenter mất điện, ứng dụng vẫn chạy. Chi phí và độ phức tạp phải thấp nhất. Kiến trúc nào phù hợp?
- A. Triển khai ở hai region khác nhau với Route 53 failover
- B. Triển khai trên nhiều AZ trong cùng một region
- C. Triển khai trên nhiều Edge Location
- D. Triển khai hai instance trong cùng một AZ

**Câu 3.** Theo shared responsibility model, với một ứng dụng chạy trên EC2, trách nhiệm nào thuộc về KHÁCH HÀNG? (Chọn đáp án đúng nhất)
- A. Bảo trì phần cứng vật lý của host
- B. Patch hypervisor
- C. Patch guest OS và cấu hình Security Group
- D. An ninh vật lý của datacenter

**Câu 4.** Một developer muốn nhận email cảnh báo khi chi phí ước tính của account vượt 50 USD, dùng CloudWatch alarm. Alarm phải được tạo ở đâu?
- A. Ở region nơi phát sinh nhiều chi phí nhất
- B. Ở mọi region đang dùng, mỗi region một alarm
- C. Ở us-east-1, vì metric EstimatedCharges chỉ có ở đó
- D. Ở bất kỳ region nào, vì billing metric là global

**Câu 5.** Đề thi DVA-C02 có cấu trúc nào sau đây?
- A. 65 câu, 130 phút, pass 750/1000
- B. 65 câu, 130 phút, 15 câu không tính điểm, pass 720/1000
- C. 75 câu, 180 phút, pass 720/1000
- D. 65 câu, 90 phút, trừ điểm câu sai

**Câu 6.** Một studio game cần chạy game server EC2 với latency một-chữ-số millisecond cho người chơi tại một thành phố lớn không có region AWS. Giải pháp nào phù hợp?
- A. CloudFront Edge Location tại thành phố đó
- B. AWS Local Zone gắn với region gần nhất
- C. Tạo thêm một Availability Zone mới
- D. Route 53 latency-based routing giữa hai region xa

**Câu 7.** Hai team dùng hai AWS account khác nhau cần đặt tài nguyên vào CÙNG một datacenter vật lý để tối thiểu latency nội bộ. Họ nên dựa vào thông tin nào?
- A. AZ name giống nhau, ví dụ cùng chọn ap-southeast-1a
- B. AZ ID giống nhau, ví dụ cùng chọn apse1-az1
- C. Region name giống nhau là đủ
- D. Subnet CIDR giống nhau

**Câu 8.** Một developer vừa tạo AWS account cá nhân để học. Thứ tự hành động nào đúng với best practice?
- A. Tạo access key cho root để dùng CLI ngay cho tiện
- B. Bật MFA cho root, tạo IAM user có quyền admin, tạo access key cho IAM user đó để dùng CLI
- C. Dùng root đăng nhập console hằng ngày vì account chỉ có một người dùng
- D. Tắt MFA để tránh rắc rối khi mất điện thoại

**Câu 9.** Trong kỳ thi DVA-C02, domain nào chiếm tỷ trọng cao thứ HAI?
- A. Development with AWS Services
- B. Deployment of Application Code
- C. Security
- D. Troubleshooting and Optimization

**Câu 10.** Một developer muốn được cảnh báo TRƯỚC KHI chi phí tháng này thực sự vượt ngân sách 20 USD, dựa trên xu hướng chi tiêu hiện tại. Công cụ nào đáp ứng trực tiếp nhất?
- A. CloudWatch billing alarm trên EstimatedCharges với threshold 20 USD
- B. AWS Budgets với notification type FORECASTED
- C. Cost Explorer xem báo cáo cuối tháng
- D. CloudTrail ghi lại mọi API call tạo tài nguyên

### Đáp án & giải thích

**Câu 1 — Đáp án C.** Compliance/data residency là ràng buộc pháp lý, không thể đánh đổi — nó luôn được xét trước mọi tiêu chí kỹ thuật. A sai vì giá rẻ không giúp gì nếu vi phạm luật. B sai vì latency là tiêu chí thứ cấp, có thể giải quyết bằng CloudFront cho người dùng châu Á. D sai vì số AZ liên quan đến HA, không liên quan yêu cầu pháp lý đặt ra.

**Câu 2 — Đáp án B.** Mỗi AZ là một (cụm) datacenter độc lập về điện/mạng; multi-AZ trong một region chính là mức HA tiêu chuẩn chống sự cố datacenter, với độ phức tạp thấp (cùng VPC, latency thấp giữa AZ). A sai vì multi-region là disaster recovery cấp cao hơn, đắt và phức tạp hơn nhiều — đề yêu cầu chi phí thấp nhất. C sai vì Edge Location không chạy workload tuỳ ý (chỉ phục vụ CDN/DNS). D sai vì hai instance cùng AZ vẫn chết chung khi datacenter đó mất điện.

**Câu 3 — Đáp án C.** Với EC2 (IaaS), khách hàng chịu trách nhiệm từ guest OS trở lên: patching OS, cấu hình firewall (Security Group), data, IAM. A, B, D đều là "security OF the cloud" — phần cứng, hypervisor, an ninh vật lý — thuộc trách nhiệm AWS.

**Câu 4 — Đáp án C.** Metric `EstimatedCharges` (namespace `AWS/Billing`) là dữ liệu billing hợp nhất toàn account và chỉ được phát ở us-east-1, nên alarm bắt buộc tạo ở đó. A và B sai vì metric không tồn tại ở region khác — alarm sẽ mãi INSUFFICIENT_DATA. D sai vì tuy chi phí mang tính global, CloudWatch metric vẫn là tài nguyên regional và AWS chỉ ghi nó ở us-east-1.

**Câu 5 — Đáp án B.** DVA-C02: 65 câu / 130 phút, 15 câu unscored trộn ngẫu nhiên, scaled score 100–1000, pass 720. A sai ở mức điểm pass (750 là của một số đề Specialty/Professional cũ). C sai cả số câu lẫn thời gian. D sai vì không có trừ điểm câu sai và thời gian là 130 phút.

**Câu 6 — Đáp án B.** Local Zone là phần mở rộng của region đặt tại các đô thị lớn, chạy được EC2/EBS/một số dịch vụ, thiết kế đúng cho use case latency single-digit ms như game server. A sai vì Edge Location chỉ phục vụ CloudFront/Route 53, không host EC2. C sai vì khách hàng không thể "tạo AZ". D sai vì routing giữa hai region xa không thể tạo ra latency một-chữ-số millisecond.

**Câu 7 — Đáp án B.** AZ ID (`apse1-az1`) là định danh vật lý nhất quán giữa mọi account; AZ name được AWS map ngẫu nhiên từng account để dàn tải. A sai vì `ap-southeast-1a` của account này có thể là datacenter khác với account kia. C sai vì cùng region vẫn có thể rơi vào AZ khác nhau. D sai vì CIDR là dải IP logic, không liên quan vị trí vật lý.

**Câu 8 — Đáp án B.** Best practice: khoá root bằng MFA, không tạo access key cho root, mọi thao tác hằng ngày qua IAM user (hoặc tốt hơn nữa là IAM Identity Center — Chương 45). A sai vì access key của root là rủi ro lớn nhất có thể tạo ra: lộ key = mất toàn bộ account, không chặn được bằng policy. C sai vì root không thể bị giới hạn quyền và khó audit. D sai hiển nhiên — MFA là lớp bảo vệ bắt buộc cho root.

**Câu 9 — Đáp án C.** Phân bố: Development 32% (cao nhất), **Security 26% (thứ hai)**, Deployment 24%, Troubleshooting & Optimization 18%. A sai vì Development đứng thứ nhất. B và D lần lượt đứng thứ ba và thứ tư.

**Câu 10 — Đáp án B.** AWS Budgets có notification type FORECASTED: dựa trên tốc độ chi tiêu hiện tại, AWS dự báo tổng chi cuối kỳ và cảnh báo khi dự báo vượt ngưỡng — tức là cảnh báo TRƯỚC khi thực sự vượt. A sai vì billing alarm trên EstimatedCharges chỉ bắn khi chi phí thực tế (ước tính tích luỹ) đã vượt 20 USD — quá muộn so với yêu cầu. C sai vì Cost Explorer là công cụ phân tích thụ động, xem cuối tháng thì tiền đã tiêu rồi. D sai vì CloudTrail phục vụ audit API call (chi tiết ở Chương 27), không có chức năng cảnh báo chi phí.

## Tóm tắt chương

- AWS Global Infrastructure phân cấp: **Region** (cụm địa lý, tối thiểu 3 AZ với region mới) → **Availability Zone** (datacenter độc lập điện/mạng, nối nhau bằng đường truyền low-latency) → **Edge Location** (400+ điểm, phục vụ CloudFront/Route 53) → **Local Zone** (mở rộng region tới gần người dùng cho workload cần latency ms).
- High availability trong một region = multi-AZ; disaster recovery cấp cao = multi-region; tăng tốc nội dung toàn cầu = Edge Location/CloudFront.
- AZ name được map ngẫu nhiên theo account; **AZ ID** mới là định danh vật lý dùng để phối hợp cross-account.
- Chọn region theo thứ tự: compliance/data residency → latency → service availability → giá.
- Shared responsibility model: AWS lo security **of** the cloud, khách hàng lo security **in** the cloud; ranh giới dịch chuyển theo loại dịch vụ (EC2 bạn phải patch OS, Lambda thì không — nhưng IAM và data luôn là của bạn).
- DVA-C02: 4 domain — Development 32%, Security 26%, Deployment 24%, Troubleshooting & Optimization 18%; 65 câu / 130 phút / 15 câu unscored / pass 720 trên thang 100–1000; không trừ điểm câu sai.
- Account mới: bật MFA cho root ngay, không tạo access key cho root, tạo IAM user cho công việc hằng ngày và dùng `aws sts get-caller-identity` để xác minh mình đang chạy bằng identity nào.
- Billing alarm dùng metric `EstimatedCharges` namespace `AWS/Billing`, chỉ tồn tại ở **us-east-1**, metric cập nhật ~6 tiếng/lần; phải bật "Receive CloudWatch billing alerts" trong Billing preferences trước.
- AWS Budgets bổ sung cho billing alarm: cảnh báo theo ACTUAL lẫn FORECASTED, hai budget đầu miễn phí — nên dựng cả hai lớp ngay từ ngày đầu học.
- Free tier có 3 loại (12 tháng / always free / trial); theo dõi bằng `aws freetier get-free-tier-usage` sau mỗi lab để tránh chi phí bất ngờ.
- CLI hữu ích của chương: `aws ec2 describe-regions`, `aws ec2 describe-availability-zones`, `aws cloudwatch put-metric-alarm`, `aws budgets create-budget` — nắm pattern `--query`/`--output` ngay từ giờ (đào sâu ở Chương 3).
