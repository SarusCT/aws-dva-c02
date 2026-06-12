# Chương 4: EC2 Fundamentals

> **Trọng tâm DVA-C02:** EC2 không còn là "ngôi sao" của đề Developer Associate như bên Solutions Architect, nhưng vẫn xuất hiện đều ở dạng câu hỏi nền tảng: Security Group hoạt động thế nào, IMDSv2 khác gì IMDSv1, vì sao phải dùng IAM Role thay vì access key trên instance, và chọn purchasing option nào cho workload cụ thể. Đặc biệt, IMDSv2 và IAM Role gắn EC2 là hai chủ đề thuộc domain Security (26% đề thi) — gần như chắc chắn gặp ít nhất 1-2 câu.

## Mục tiêu chương

- Hiểu AMI là gì, cấu tạo bên trong, và vòng đời một EC2 instance từ lúc launch.
- Đọc được tên instance type (ví dụ `m5.2xlarge`, `c7gn.large`) và chọn đúng family cho workload.
- Nắm chắc cơ chế **stateful** của Security Group, cách reference SG lẫn nhau để xây kiến trúc nhiều tầng.
- Dùng được User Data, key pair, EC2 Instance Connect để bootstrap và truy cập instance.
- Truy vấn Instance Metadata Service đúng chuẩn **IMDSv2** và hiểu vì sao IMDSv1 là lỗ hổng SSRF.
- Gắn IAM Role cho EC2 đúng cách và hiểu SDK lấy credentials từ đâu.
- So sánh On-Demand / Reserved / Savings Plans / Spot / Dedicated và 3 loại placement group.

## 4.1 EC2 và AMI — đơn vị triển khai cơ bản

**Amazon EC2 (Elastic Compute Cloud)** là dịch vụ máy ảo theo yêu cầu. Khi bạn launch một instance, bên dưới AWS cấp phát một VM chạy trên hypervisor **Nitro** (thế hệ mới) hoặc Xen (thế hệ cũ), gắn vào một subnet trong VPC, cấp ENI (network interface) và đĩa boot.

Đĩa boot và toàn bộ "khuôn" của instance đến từ **AMI (Amazon Machine Image)**. Một AMI gồm 3 thành phần:

1. **EBS snapshots** (hoặc instance store template) chứa OS, packages, code đã cài sẵn — chi tiết về EBS/snapshot ở Chương 5.
2. **Launch permissions** — quyết định account nào được dùng AMI (private mặc định, có thể share cho account khác hoặc public).
3. **Block device mapping** — khai báo volume nào gắn vào device nào khi launch.

Điểm hay bị quên: **AMI là tài nguyên theo region**. AMI tạo ở `ap-southeast-1` không launch được ở `us-east-1`; muốn dùng cross-region phải copy:

```bash
# Copy AMI từ Singapore sang Virginia
aws ec2 copy-image \
  --source-region ap-southeast-1 \
  --source-image-id ami-0abc1234def567890 \
  --region us-east-1 \
  --name "my-app-v1.2-copy"
```

Ba nguồn AMI: **AWS-provided** (Amazon Linux 2023, Ubuntu...), **Marketplace** (vendor đóng gói, tính thêm phí), và **custom AMI** do bạn tự tạo. Pattern thực tế quan trọng là **golden AMI**: thay vì để mỗi instance tự cài Node.js, nginx, agent... qua User Data (chậm, dễ fail giữa chừng), bạn cài sẵn mọi thứ rồi "nướng" thành AMI. Instance launch từ golden AMI boot nhanh hơn nhiều — yếu tố sống còn khi Auto Scaling cần thêm máy gấp (chi tiết ASG ở Chương 7).

```bash
# Tạo AMI từ instance đang chạy
aws ec2 create-image \
  --instance-id i-0123456789abcdef0 \
  --name "golden-nodejs-20-v3" \
  --no-reboot   # không reboot instance, nhưng risk filesystem không nhất quán
```

> 💡 **Exam Tip:** Câu hỏi "ứng dụng cần scale out nhanh, giảm thời gian bootstrap" → đáp án là **tạo custom/golden AMI cài sẵn dependencies**, không phải "viết User Data dài hơn". User Data chạy MỖI LẦN launch instance mới, còn AMI đã đóng gói sẵn.

Vòng đời instance cũng hay được hỏi gián tiếp: `pending → running → stopping → stopped → terminated`. **Stop** chỉ có với instance dùng EBS boot — đĩa EBS giữ nguyên, RAM mất, không tính tiền compute (vẫn tính tiền EBS), và khi start lại instance **có thể đổi public IPv4**. **Terminate** xoá instance vĩnh viễn. Ngoài ra có **stop-hibernate**: RAM được ghi xuống EBS root volume (phải mã hoá, RAM tối đa 150 GB), khi start lại process tiếp tục như chưa hề tắt — dùng cho app khởi động chậm.

## 4.2 Instance types — đọc tên và chọn đúng family

Tên instance type mã hoá đầy đủ thông tin. Lấy `c7gn.xlarge` làm ví dụ:

- **`c`** — family: **C**ompute optimized.
- **`7`** — thế hệ (generation) thứ 7, càng mới càng rẻ/khoẻ hơn trên mỗi đơn vị hiệu năng.
- **`g`** — hậu tố khả năng: chip **G**raviton (ARM). Các hậu tố hay gặp: `a` = AMD, `i` = Intel, `n` = **n**etwork tăng cường, `d` = có NVMe instance store (**d**isk), `e` = extra memory/storage.
- **`xlarge`** — size: mỗi nấc size gấp đôi vCPU/RAM nấc dưới (`large` = 2 vCPU, `xlarge` = 4, `2xlarge` = 8...).

Các family cần nhớ cho đề thi:

| Family | Ví dụ | Tối ưu cho | Workload điển hình |
|---|---|---|---|
| General purpose | `t3`, `t4g`, `m5`, `m7g` | Cân bằng CPU/RAM/network | Web server, API backend, repo code |
| Compute optimized | `c5`, `c7g` | CPU mạnh / vCPU | Batch processing, encode video, game server, HPC |
| Memory optimized | `r5`, `r7g`, `x2`, `z1d` | RAM lớn | In-memory cache, database, real-time analytics |
| Storage optimized | `i3`, `i4i`, `d3` | Local NVMe IOPS cao | NoSQL DB, data warehouse, OLTP I/O nặng |
| Accelerated | `p4`, `g5`, `inf2` | GPU/ASIC | ML training/inference, đồ hoạ |

Riêng **T-family (t3, t4g) là burstable**: bạn được mức CPU baseline (ví dụ t3.micro baseline 10%/vCPU) và tích **CPU credits** khi chạy dưới baseline; khi cần burst thì tiêu credits. Hết credits → CPU bị ghìm về baseline (app đột nhiên ì ạch — war story kinh điển: web "chạy ngon lúc demo, chết lúc traffic thật"). Bật **T unlimited mode** thì không bị ghìm nhưng trả thêm tiền cho phần vượt.

> 💡 **Exam Tip:** Thấy "ứng dụng CPU tăng vọt từng đợt ngắn, còn lại idle, chi phí thấp" → T-family burstable. Thấy "in-memory database / cần RAM lớn" → R-family. Thấy "batch/transcoding CPU-bound" → C-family.

## 4.3 Security Groups — firewall stateful ở mức instance

**Security Group (SG)** là firewall ảo gắn vào **ENI** của instance (một instance có thể gắn tối đa 5 SG theo quota mặc định). Bốn tính chất phải nắm chắc:

1. **Chỉ có ALLOW rules** — không có deny. Mặc định mọi thứ bị chặn, bạn mở dần. (Muốn deny tường minh phải dùng NACL — chi tiết ở Chương 11.)
2. **Stateful**: nếu inbound rule cho phép request đi vào, response tự động được đi ra **bất kể outbound rules**, và ngược lại. SG theo dõi connection tracking nên bạn không cần mở "port trả lời".
3. Mặc định khi tạo SG mới: **chặn toàn bộ inbound, cho phép toàn bộ outbound** (`0.0.0.0/0`).
4. Rule có thể trỏ đến: CIDR (`203.0.113.0/24`), **một SG khác**, hoặc prefix list.

Khả năng **reference SG khác** là nền tảng của kiến trúc nhiều tầng: thay vì hard-code IP, bạn nói "tầng database chỉ nhận kết nối port 5432 từ những instance đang đeo SG của tầng app":

```bash
# sg-app: SG của tầng application, sg-db: SG của database
aws ec2 authorize-security-group-ingress \
  --group-id sg-0db1111111111 \
  --protocol tcp --port 5432 \
  --source-group sg-0app222222222
# Bất kỳ instance nào gắn sg-app đều gọi được DB, không cần biết IP
```

Instance scale out/in, IP đổi liên tục — rule vẫn đúng. Đây là lý do trong đề, đáp án "reference security group" gần như luôn thắng đáp án "thêm CIDR của từng instance".

Với SDK JS v3:

```javascript
import { EC2Client, AuthorizeSecurityGroupIngressCommand } from "@aws-sdk/client-ec2";

const ec2 = new EC2Client({ region: "ap-southeast-1" });
await ec2.send(new AuthorizeSecurityGroupIngressCommand({
  GroupId: "sg-0db1111111111",
  IpPermissions: [{
    IpProtocol: "tcp", FromPort: 5432, ToPort: 5432,
    // cho phép theo SG nguồn thay vì CIDR
    UserIdGroupPairs: [{ GroupId: "sg-0app222222222" }],
  }],
}));
```

Bẫy thực tế khi debug "không SSH/connect được":

- **Timeout** khi kết nối → gần như chắc chắn là SG (hoặc NACL) chặn. SG drop lặng lẽ, không gửi reject.
- **Connection refused** → traffic ĐÃ qua SG, nhưng không có process nào listen trên port đó (app chưa chạy, sai port).
- SG áp dụng ở mức ENI nên **traffic giữa hai instance cùng subnet vẫn bị SG lọc** — khác NACL chỉ lọc khi qua ranh giới subnet.

> 💡 **Exam Tip:** "Security groups are **stateful**, NACLs are **stateless**" là câu phân biệt kinh điển. Stateful = return traffic tự động được phép. Và nhớ: SG **không thể** tạo deny rule.

## 4.4 Key pairs, SSH và EC2 Instance Connect

**Key pair** là cặp khoá public/private (RSA 2048-bit hoặc ED25519). AWS **chỉ giữ public key** — private key tải về đúng một lần lúc tạo (`.pem` cho OpenSSH, `.ppk` cho PuTTY). Khi launch, public key được cloud-init chép vào `~/.ssh/authorized_keys` của user mặc định. Mất file private key = mất quyền SSH bằng key đó (workaround: tạo AMI rồi launch lại với key mới, hoặc dùng EC2 Instance Connect/SSM).

```bash
aws ec2 create-key-pair --key-name dev-key \
  --key-type ed25519 \
  --query 'KeyMaterial' --output text > dev-key.pem
chmod 400 dev-key.pem   # bắt buộc, không SSH sẽ từ chối "unprotected key"
ssh -i dev-key.pem ec2-user@<public-ip>
```

Hai lỗi SSH gặp hằng ngày:

- `Permission denied (publickey)` → thường do **sai username**: Amazon Linux dùng `ec2-user`, Ubuntu dùng `ubuntu`, Debian dùng `admin`, RHEL dùng `ec2-user`/`root`.
- `WARNING: UNPROTECTED PRIVATE KEY FILE` → quên `chmod 400`.

**EC2 Instance Connect** là cách SSH không cần quản lý private key dài hạn: bạn gọi API (hoặc bấm Connect trên console), AWS **push một public key dùng một lần, hiệu lực 60 giây** vào instance metadata, rồi mở phiên SSH bằng key đó. Quyền được kiểm soát bằng IAM (`ec2-instance-connect:SendSSHPublicKey`), nên audit được qua CloudTrail. Yêu cầu: instance chạy Amazon Linux 2/2023 hoặc Ubuntu có gói `ec2-instance-connect`, và SG vẫn phải mở port 22 — nếu connect từ browser console thì phải allow dải IP của dịch vụ EC2_INSTANCE_CONNECT theo region (lấy từ `ip-ranges.json`).

```bash
aws ec2-instance-connect ssh --instance-id i-0123456789abcdef0
```

Một lựa chọn hiện đại hơn là **SSM Session Manager** — không cần mở port 22, không cần key, chỉ cần SSM Agent + IAM Role; đề DVA thỉnh thoảng đưa vào như đáp án "least operational overhead" cho truy cập shell.

## 4.5 EC2 User Data — bootstrap lúc boot đầu tiên

**User Data** là script bạn đính kèm khi launch; **cloud-init** thực thi nó **với quyền root, đúng một lần ở first boot** (mặc định — muốn chạy lại mỗi boot phải dùng cloud-init directive `#cloud-boothook` hoặc MIME multipart). Giới hạn kích thước: **16 KB** (trước khi base64-encode). Log thực thi nằm ở `/var/log/cloud-init-output.log` — nơi đầu tiên cần xem khi bootstrap fail.

```bash
cat > userdata.sh <<'EOF'
#!/bin/bash
dnf install -y nodejs nginx
systemctl enable --now nginx
echo "booted at $(date)" > /var/www/html/index.html
EOF

aws ec2 run-instances \
  --image-id ami-0abc1234def567890 \
  --instance-type t3.micro \
  --key-name dev-key \
  --security-group-ids sg-0web333333333 \
  --user-data file://userdata.sh \
  --iam-instance-profile Name=app-instance-profile \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=web-01}]'
```

Lưu ý bảo mật quan trọng: User Data **không được mã hoá** và đọc được từ instance metadata bởi bất kỳ process nào trên máy → **tuyệt đối không nhét secret/password/access key vào User Data**. Secret để ở SSM Parameter Store hoặc Secrets Manager (Chương 47), instance lấy về bằng IAM Role.

> 💡 **Exam Tip:** Bộ ba dữ kiện về User Data hay ra thi: chạy **as root**, chạy **một lần lúc first boot**, và **không phải chỗ chứa secrets**. Câu hỏi "script cài đặt không chạy khi reboot" → đúng hành vi mặc định, không phải bug.

## 4.6 Instance Metadata Service — IMDSv2 là bắt buộc phải hiểu

Mọi instance có thể tự hỏi "tôi là ai" qua **IMDS** tại địa chỉ link-local `http://169.254.169.254/latest/meta-data/`. Metadata gồm: instance-id, instance-type, AZ, local/public IP, security groups, MAC, và quan trọng nhất — **temporary credentials của IAM Role** tại `iam/security-credentials/<role-name>`.

**IMDSv1** là request/response GET đơn thuần — và chính sự đơn giản đó là lỗ hổng: nếu app của bạn dính **SSRF** (server-side request forgery — kẻ tấn công lừa server tự gửi request đến URL tuỳ ý), attacker chỉ cần một GET tới `169.254.169.254` là cuỗm được credentials của role. Vụ rò rỉ dữ liệu Capital One 2019 chính là kịch bản này.

**IMDSv2** chặn kịch bản đó bằng cơ chế **session-oriented**, hai bước:

```bash
# Bước 1: xin session token bằng PUT (SSRF điển hình chỉ làm được GET)
TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")   # TTL tối đa 6 giờ

# Bước 2: mọi request metadata phải kèm token
curl -H "X-aws-ec2-metadata-token: $TOKEN" \
  http://169.254.169.254/latest/meta-data/instance-id

# Lấy temporary credentials của IAM Role
curl -H "X-aws-ec2-metadata-token: $TOKEN" \
  http://169.254.169.254/latest/meta-data/iam/security-credentials/app-role
```

Vì sao cách này chống SSRF hiệu quả:

- Bước xin token dùng **PUT** — đa số lỗ hổng SSRF chỉ ép được GET.
- Response token mang header yêu cầu, WAF/proxy thường không forward header tuỳ biến.
- Gói tin trả token có **IP TTL (hop limit) mặc định = 1** — token không thể đi xuyên qua một hop mạng nào, nên container/NAT phía sau không nhận được. Đây cũng là bẫy thực tế: app chạy trong **Docker container trên EC2** gọi IMDSv2 bị timeout vì docker bridge tính là 1 hop → fix bằng tăng hop limit lên 2:

```bash
aws ec2 modify-instance-metadata-options \
  --instance-id i-0123456789abcdef0 \
  --http-tokens required \          # ép buộc IMDSv2, tắt hẳn IMDSv1
  --http-put-response-hop-limit 2 \ # cho container gọi được
  --http-endpoint enabled
```

`--http-tokens required` là cách "enforce IMDSv2"; từ Amazon Linux 2023 AMI trở đi, IMDSv2 là mặc định. Bạn cũng có thể ép ở mức launch bằng AMI setting hoặc IAM condition `ec2:MetadataHttpTokens`.

Phân biệt nhanh: **metadata** (`/meta-data/`) là thông tin AWS sinh ra về instance; **user data** (`/user-data/`) là script bạn cung cấp; **dynamic data** (`/dynamic/instance-identity/document`) chứa identity document có chữ ký.

> 💡 **Exam Tip:** Câu "làm sao để code trên EC2 biết region/instance-id/lấy credentials mà không hard-code?" → IMDS. Câu "tăng cường bảo vệ credentials trên EC2 chống SSRF" → **enforce IMDSv2** (`HttpTokens=required`). Nhớ con số: token TTL tối đa **21600 giây (6 giờ)**, hop limit mặc định **1**.

## 4.7 IAM Role gắn EC2 — không bao giờ để access key trên instance

Quy tắc số một của domain Security: code chạy trên EC2 cần gọi AWS API thì **gắn IAM Role**, không bao giờ copy access key vào `~/.aws/credentials` hay biến môi trường trên instance. Cơ chế bên dưới:

1. Bạn tạo IAM Role với trust policy cho phép `ec2.amazonaws.com` assume.
2. Role được bọc trong **instance profile** — "vỏ chứa" để gắn role vào EC2 (console tự tạo, CLI/CFN phải tạo tường minh). Một instance chỉ gắn được **một role tại một thời điểm**, nhưng có thể thay role khi instance đang chạy không cần stop.
3. EC2 service tự gọi STS AssumeRole định kỳ và phơi **temporary credentials** (AccessKeyId/SecretAccessKey/Token, tự xoay vòng trước khi hết hạn) qua IMDS.
4. AWS SDK/CLI theo **credentials provider chain** (Chương 3) tự tìm tới IMDS — bạn không viết thêm dòng code nào:

```javascript
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
// KHÔNG truyền credentials — SDK tự lấy từ IMDS qua instance role
const s3 = new S3Client({ region: "ap-southeast-1" });
const out = await s3.send(new ListObjectsV2Command({ Bucket: "my-app-assets" }));
console.log(out.Contents?.map(o => o.Key));
```

```bash
# Tạo role + instance profile rồi gắn vào instance đang chạy
aws iam create-instance-profile --instance-profile-name app-instance-profile
aws iam add-role-to-instance-profile \
  --instance-profile-name app-instance-profile --role-name app-role
aws ec2 associate-iam-instance-profile \
  --instance-id i-0123456789abcdef0 \
  --iam-instance-profile Name=app-instance-profile
```

Vì sao role thắng access key tuyệt đối: credentials là **tạm thời và tự rotate**, không nằm trên đĩa, thu hồi tức thì bằng cách gỡ policy/role, và mọi API call ghi rõ role session trong CloudTrail. Trong đề, bất kỳ đáp án nào "store access keys on the instance / in the AMI / in user data" đều **sai**.

> 💡 **Exam Tip:** "Application on EC2 needs to access DynamoDB/S3 — what is the MOST secure way?" → **Attach an IAM Role (instance profile)**. Nhớ thêm: 1 instance = 1 role; role thay được lúc runtime; SDK đọc credentials từ IMDS tự động.

## 4.8 Purchasing options — trả tiền kiểu nào cho workload nào

| Option | Giảm giá | Cam kết | Phù hợp |
|---|---|---|---|
| On-Demand | 0% | Không | Workload ngắn, khó đoán, dev/test |
| Reserved Instances (RI) | tới ~72% | 1 hoặc 3 năm, instance family + region/AZ | Workload ổn định (DB chạy 24/7) |
| Savings Plans | tới ~72% (Compute ~66%) | 1/3 năm theo **$/giờ chi tiêu** | Như RI nhưng linh hoạt hơn |
| Spot | tới ~90% | Không — bị thu hồi với **2 phút** cảnh báo | Batch, CI, xử lý ảnh, job chịu được gián đoạn |
| Dedicated Hosts | — | On-demand hoặc reservation | License theo socket/core (BYOL), compliance |
| Dedicated Instances | — | — | Hardware riêng, không kiểm soát placement |
| Capacity Reservations | 0% (giá on-demand) | Không, theo AZ | Đảm bảo có capacity cho sự kiện lớn |

Chi tiết đáng nhớ từng loại:

- **On-Demand**: tính tiền theo giây (Linux, tối thiểu 60 giây). Baseline để so mọi option khác.
- **Reserved Instances**: chọn **Standard** (giảm sâu nhất, không đổi family) hoặc **Convertible** (đổi được family/OS/tenancy, giảm ít hơn). Payment: All Upfront > Partial > No Upfront (giảm dần). Scope **regional** (áp mọi AZ, không giữ chỗ) vs **zonal** (giữ capacity trong 1 AZ).
- **Savings Plans**: cam kết mức chi `$X/giờ`. **Compute Savings Plans** áp cho mọi EC2 family/region và cả Fargate, Lambda; **EC2 Instance Savings Plans** khoá vào family + region nhưng giảm sâu như RI. Xu hướng đề thi mới chuộng Savings Plans làm đáp án "linh hoạt".
- **Spot Instances**: bạn dùng capacity dư của AWS, giá spot dao động theo cung cầu. Khi AWS cần lại capacity, instance nhận **interruption notice trước 2 phút** (qua IMDS `spot/instance-action` hoặc EventBridge) rồi bị stop/terminate. Spot Fleet/EC2 Fleet trộn nhiều instance type + AZ để giảm xác suất bị thu hồi đồng loạt. Request kiểu **one-time** vs **persistent** (persistent tự xin lại sau khi bị thu hồi — muốn tắt hẳn phải cancel request TRƯỚC rồi terminate instance, không thì nó cứ mọc lại).
- **Dedicated Hosts vs Dedicated Instances**: Host = bạn thấy và kiểm soát physical server (socket, core, host affinity) → dùng cho **BYOL license per-core** và compliance khắt khe; Dedicated Instances chỉ đảm bảo "hardware không chia với account khác", không cho visibility vào host. Host đắt nhất trong mọi option.
- **Capacity Reservations**: giữ chỗ capacity trong 1 AZ, trả giá on-demand dù không chạy — kết hợp với RI/Savings Plans để vừa giữ chỗ vừa được giảm giá.

> 💡 **Exam Tip:** Map từ khoá → đáp án: "fault-tolerant, can be interrupted, cheapest" → **Spot**. "Steady-state 24/7 trong 1-3 năm" → **Reserved/Savings Plans**. "Per-socket/per-core software license" → **Dedicated Hosts**. "Cần chắc chắn có máy trong AZ cho đợt sale" → **Capacity Reservation**. Và con số 2 phút interruption notice của Spot rất hay được gài.

## 4.9 Placement Groups và Elastic IP

### Placement Groups

Placement group là cách bạn "gợi ý" EC2 đặt các instance tương đối với nhau trên hạ tầng vật lý. Ba chiến lược:

| Strategy | Cách đặt | Ưu | Nhược / Giới hạn |
|---|---|---|---|
| **Cluster** | Dồn vào cùng rack, **cùng 1 AZ** | Network latency thấp nhất, throughput 10 Gbps+ giữa các node | Rack chết = chết cả cụm; chỉ 1 AZ |
| **Spread** | Mỗi instance một rack riêng biệt | Cô lập lỗi tối đa, đa AZ được | **Tối đa 7 instances / AZ / group** |
| **Partition** | Chia thành các partition, mỗi partition một bộ rack riêng | Scale lớn (hàng trăm instance), partition-aware | Tối đa **7 partitions / AZ**; app phải hiểu topology |

Use case chuẩn để nhận diện trong đề: **Cluster** cho HPC/big data cần node-to-node cực nhanh; **Spread** cho số ít instance tối quan trọng (primary + standby) không được chết cùng nhau; **Partition** cho hệ phân tán tự quản replication như **Hadoop HDFS, Kafka, Cassandra** — app đọc partition number từ instance metadata để rải replica.

```bash
aws ec2 create-placement-group --group-name kafka-pg \
  --strategy partition --partition-count 3
aws ec2 run-instances --placement "GroupName=kafka-pg,PartitionNumber=0" \
  --image-id ami-0abc1234def567890 --instance-type r5.large --count 2
```

Nếu launch vào cluster placement group bị lỗi **insufficient capacity**, cách xử lý là stop/start toàn bộ instances trong group để AWS tìm chỗ mới — hoặc đơn giản thử lại sau.

### Elastic IP

Public IPv4 mặc định của instance **thay đổi mỗi lần stop/start**. **Elastic IP (EIP)** là địa chỉ public IPv4 tĩnh thuộc về account, bạn associate vào instance/ENI và **remap sang instance khác trong vài giây** — pattern failover thủ công cổ điển: instance chính chết, gắn EIP sang máy standby.

```bash
ALLOC=$(aws ec2 allocate-address --domain vpc --query AllocationId --output text)
aws ec2 associate-address --instance-id i-0123456789abcdef0 --allocation-id $ALLOC
# Failover: associate lại sang instance khác — mặc định tự "cướp" mapping cũ
```

Giới hạn và chi phí: quota mặc định **5 EIP/region** (tăng được qua Service Quotas); từ 2/2024 AWS tính phí **mọi địa chỉ public IPv4** (~$0.005/giờ) kể cả đang gắn vào instance chạy — EIP để cấp phát mà *không* gắn vào đâu càng tốn tiền vô ích. Quan điểm kiến trúc (và cũng là quan điểm của đề thi): EIP là dấu hiệu thiết kế kém linh hoạt — ưu tiên DNS name qua Route 53 (Chương 10) hoặc Load Balancer (Chương 6) thay vì IP cứng.

> 💡 **Exam Tip:** Spread placement group **tối đa 7 instances mỗi AZ** — con số này xuất hiện thường xuyên. Và "ứng dụng cần IP cố định nhưng kiến trúc tốt hơn?" → đáp án đẹp thường là Route 53/ELB, không phải EIP; NLB mới là thứ có static IP cho production (Chương 6).

Đến đây bạn đã có đủ nền EC2 để vào các chương hạ tầng tiếp theo: storage cho instance (EBS/EFS — Chương 5), phân tải (ELB — Chương 6) và tự co giãn (ASG — Chương 7). Phần 2 của chương này sẽ là hands-on lab launch instance hoàn chỉnh bằng CLI kèm quiz 10 câu.
