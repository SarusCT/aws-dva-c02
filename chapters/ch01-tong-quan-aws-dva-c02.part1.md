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
