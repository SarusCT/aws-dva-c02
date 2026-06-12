## Hands-on Lab: Xây VPC 2-tier với NAT Gateway và Gateway Endpoint cho S3

**Mục tiêu lab:** Tự tay dựng một VPC hoàn chỉnh bằng AWS CLI v2: 1 public subnet + 1 private subnet, Internet Gateway, NAT Gateway, route tables riêng cho từng tier, Security Group tham chiếu lẫn nhau, Gateway Endpoint cho S3 để instance private gọi S3 không qua NAT, và bật VPC Flow Logs để quan sát traffic. Đây chính là skeleton của kiến trúc 3-tier mà đề DVA-C02 hay mô tả.

**Chuẩn bị:**
- AWS CLI v2 đã cấu hình profile có quyền tạo VPC/EC2/IAM/CloudWatch Logs (xem Chương 3).
- Một EC2 key pair sẵn có (xem Chương 4). Trong lab đặt tên `lab-key`.
- Region ví dụ: `ap-southeast-1`. Chi phí phát sinh chủ yếu từ NAT Gateway (~0.059 USD/giờ + data) — nhớ làm mục Dọn dẹp.

### Bước 1: Tạo VPC và bật DNS hostnames

```bash
VPC_ID=$(aws ec2 create-vpc --cidr-block 10.0.0.0/16 \
  --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=lab-vpc}]' \
  --query 'Vpc.VpcId' --output text)
echo $VPC_ID   # vpc-0abc123...

# Bật DNS hostnames — bắt buộc nếu sau này dùng Interface Endpoint với private DNS
aws ec2 modify-vpc-attribute --vpc-id $VPC_ID --enable-dns-hostnames '{"Value":true}'
```

VPC mới luôn kèm sẵn 1 main route table, 1 default NACL (allow all) và 1 default security group (deny all inbound từ bên ngoài, allow giữa các thành viên cùng SG).

### Bước 2: Tạo public và private subnet

```bash
PUB_SUBNET=$(aws ec2 create-subnet --vpc-id $VPC_ID --cidr-block 10.0.1.0/24 \
  --availability-zone ap-southeast-1a \
  --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=lab-public-1a}]' \
  --query 'Subnet.SubnetId' --output text)

PRIV_SUBNET=$(aws ec2 create-subnet --vpc-id $VPC_ID --cidr-block 10.0.2.0/24 \
  --availability-zone ap-southeast-1a \
  --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=lab-private-1a}]' \
  --query 'Subnet.SubnetId' --output text)

# Instance launch vào public subnet tự nhận public IP
aws ec2 modify-subnet-attribute --subnet-id $PUB_SUBNET --map-public-ip-on-launch
```

Lưu ý: mỗi subnet /24 có 256 IP nhưng chỉ dùng được 251 — AWS giữ 5 IP (network, router, DNS, future, broadcast). Đề thi thỉnh thoảng hỏi con số này.

### Bước 3: Internet Gateway và route table cho public subnet

```bash
IGW_ID=$(aws ec2 create-internet-gateway \
  --tag-specifications 'ResourceType=internet-gateway,Tags=[{Key=Name,Value=lab-igw}]' \
  --query 'InternetGateway.InternetGatewayId' --output text)
aws ec2 attach-internet-gateway --internet-gateway-id $IGW_ID --vpc-id $VPC_ID

PUB_RT=$(aws ec2 create-route-table --vpc-id $VPC_ID \
  --tag-specifications 'ResourceType=route-table,Tags=[{Key=Name,Value=lab-public-rt}]' \
  --query 'RouteTable.RouteTableId' --output text)

aws ec2 create-route --route-table-id $PUB_RT \
  --destination-cidr-block 0.0.0.0/0 --gateway-id $IGW_ID
# Output mong đợi: { "Return": true }

aws ec2 associate-route-table --route-table-id $PUB_RT --subnet-id $PUB_SUBNET
```

Định nghĩa "public subnet" chính là đây: subnet có route `0.0.0.0/0 → igw-xxx`. Không có route này thì gắn bao nhiêu public IP cũng vô nghĩa.

### Bước 4: NAT Gateway và route table cho private subnet

```bash
EIP_ALLOC=$(aws ec2 allocate-address --domain vpc --query 'AllocationId' --output text)

NAT_ID=$(aws ec2 create-nat-gateway --subnet-id $PUB_SUBNET \
  --allocation-id $EIP_ALLOC \
  --tag-specifications 'ResourceType=natgateway,Tags=[{Key=Name,Value=lab-nat}]' \
  --query 'NatGateway.NatGatewayId' --output text)

# Đợi NAT Gateway sang trạng thái available (~1-2 phút)
aws ec2 wait nat-gateway-available --nat-gateway-ids $NAT_ID

PRIV_RT=$(aws ec2 create-route-table --vpc-id $VPC_ID \
  --tag-specifications 'ResourceType=route-table,Tags=[{Key=Name,Value=lab-private-rt}]' \
  --query 'RouteTable.RouteTableId' --output text)

aws ec2 create-route --route-table-id $PRIV_RT \
  --destination-cidr-block 0.0.0.0/0 --nat-gateway-id $NAT_ID

aws ec2 associate-route-table --route-table-id $PRIV_RT --subnet-id $PRIV_SUBNET
```

Bẫy kinh điển: NAT Gateway phải nằm trong **public subnet** (để chính nó ra internet qua IGW), còn route trỏ tới nó nằm ở route table của **private subnet**. Đặt NAT Gateway vào private subnet là lỗi cấu hình hay gặp nhất.

### Bước 5: Security Groups tham chiếu lẫn nhau

```bash
BASTION_SG=$(aws ec2 create-security-group --group-name lab-bastion-sg \
  --description "SSH from my IP" --vpc-id $VPC_ID --query 'GroupId' --output text)

MY_IP=$(curl -s https://checkip.amazonaws.com)
aws ec2 authorize-security-group-ingress --group-id $BASTION_SG \
  --protocol tcp --port 22 --cidr ${MY_IP}/32

APP_SG=$(aws ec2 create-security-group --group-name lab-app-sg \
  --description "SSH from bastion only" --vpc-id $VPC_ID --query 'GroupId' --output text)

# Tham chiếu SG thay vì CIDR — best practice cho tier nội bộ
aws ec2 authorize-security-group-ingress --group-id $APP_SG \
  --protocol tcp --port 22 --source-group $BASTION_SG
```

`--source-group` nghĩa là: bất kỳ ENI nào đang gắn `lab-bastion-sg` đều SSH được vào app tier, không cần biết IP. Đây là pattern đề thi rất chuộng.

### Bước 6: Launch 2 instances và kiểm chứng

```bash
AMI=$(aws ssm get-parameter \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --query 'Parameter.Value' --output text)

aws ec2 run-instances --image-id $AMI --instance-type t3.micro --key-name lab-key \
  --subnet-id $PUB_SUBNET --security-group-ids $BASTION_SG \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=lab-bastion}]'

aws ec2 run-instances --image-id $AMI --instance-type t3.micro --key-name lab-key \
  --subnet-id $PRIV_SUBNET --security-group-ids $APP_SG \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=lab-app}]'
```

SSH vào bastion bằng public IP, từ đó SSH tiếp vào private IP `10.0.2.x` của app instance (dùng agent forwarding `ssh -A`). Trên app instance kiểm tra NAT:

```bash
curl -s https://checkip.amazonaws.com
# Output mong đợi: chính là Elastic IP của NAT Gateway — chứng tỏ outbound đi qua NAT
```

### Bước 7: Gateway Endpoint cho S3

```bash
aws ec2 create-vpc-endpoint --vpc-id $VPC_ID \
  --service-name com.amazonaws.ap-southeast-1.s3 \
  --vpc-endpoint-type Gateway \
  --route-table-ids $PRIV_RT
```

Kiểm tra lại private route table sẽ thấy một route mới với destination là **prefix list** `pl-xxxx` (tập IP public của S3 trong region) trỏ tới `vpce-xxxx`. Từ app instance (cần gắn IAM role có quyền S3, xem Chương 4):

```bash
aws s3 ls --region ap-southeast-1
# Chạy được. Giờ thử tắt đường NAT để chứng minh traffic đi qua endpoint:
aws ec2 delete-route --route-table-id $PRIV_RT --destination-cidr-block 0.0.0.0/0
aws s3 ls --region ap-southeast-1   # VẪN chạy — S3 đi qua Gateway Endpoint, miễn phí
curl -s --max-time 5 https://checkip.amazonaws.com || echo "internet bị chặn"  # timeout
```

Đây là demo đắt giá nhất lab: S3 hoạt động mà không cần internet, đúng câu hỏi "private subnet cần gọi S3 với chi phí thấp nhất" trong đề.

### Bước 8: Bật VPC Flow Logs

```bash
aws logs create-log-group --log-group-name /lab/vpc-flow-logs

aws ec2 create-flow-logs --resource-type VPC --resource-ids $VPC_ID \
  --traffic-type ALL --log-group-name /lab/vpc-flow-logs \
  --deliver-logs-permission-arn arn:aws:iam::<ACCOUNT_ID>:role/lab-flowlogs-role
```

(Role cần trust `vpc-flow-logs.amazonaws.com` và quyền ghi CloudWatch Logs.) Sau vài phút, thử SSH sai port vào bastion rồi xem log: record dạng `2 123456789012 eni-xxx <src-ip> 10.0.1.x 54321 23 6 1 40 ... REJECT OK`. Trường `ACCEPT/REJECT` cho biết traffic bị SG/NACL chặn hay cho qua — công cụ troubleshoot connectivity số một.

### Dọn dẹp tài nguyên

Thứ tự quan trọng — xoá ngược với lúc tạo:

```bash
# 1. Terminate 2 instances (lấy ID từ describe-instances theo tag)
aws ec2 terminate-instances --instance-ids <i-bastion> <i-app>
aws ec2 wait instance-terminated --instance-ids <i-bastion> <i-app>

# 2. Xoá Flow Logs + log group
aws ec2 delete-flow-logs --flow-log-ids <fl-xxx>
aws logs delete-log-group --log-group-name /lab/vpc-flow-logs

# 3. Xoá VPC endpoint
aws ec2 delete-vpc-endpoints --vpc-endpoint-ids <vpce-xxx>

# 4. Xoá NAT Gateway và RELEASE Elastic IP (quên bước này là mất tiền EIP nhàn rỗi)
aws ec2 delete-nat-gateway --nat-gateway-id $NAT_ID
aws ec2 wait nat-gateway-deleted --nat-gateway-ids $NAT_ID
aws ec2 release-address --allocation-id $EIP_ALLOC

# 5. Security groups, route tables, IGW, subnets, VPC
aws ec2 delete-security-group --group-id $APP_SG
aws ec2 delete-security-group --group-id $BASTION_SG
aws ec2 delete-route-table --route-table-id $PUB_RT
aws ec2 delete-route-table --route-table-id $PRIV_RT
aws ec2 detach-internet-gateway --internet-gateway-id $IGW_ID --vpc-id $VPC_ID
aws ec2 delete-internet-gateway --internet-gateway-id $IGW_ID
aws ec2 delete-subnet --subnet-id $PUB_SUBNET
aws ec2 delete-subnet --subnet-id $PRIV_SUBNET
aws ec2 delete-vpc --vpc-id $VPC_ID
```

Nếu `delete-vpc` báo `DependencyViolation`, còn ENI hoặc resource nào đó chưa xoá — dùng `aws ec2 describe-network-interfaces --filters Name=vpc-id,Values=$VPC_ID` để truy.

## 💡 Exam Tips chương 11

- **Security Group là stateful** — response tự động được phép quay về, không cần outbound rule tương ứng. **NACL là stateless** — phải mở cả chiều về, đặc biệt là dải **ephemeral ports 1024–65535** cho response traffic. Câu hỏi "connection vào được nhưng response không ra" gần như chắc chắn là NACL thiếu outbound ephemeral.
- SG chỉ có **allow rules**; NACL có cả allow lẫn deny và đánh giá theo **rule number tăng dần, match đầu tiên thắng**. Cần chặn 1 IP cụ thể → chỉ NACL làm được, SG không deny được ai.
- Public subnet = subnet có route `0.0.0.0/0 → Internet Gateway`. Instance còn cần public IP/Elastic IP thì mới ra internet được — đủ cả hai điều kiện.
- NAT Gateway: đặt ở **public subnet**, route từ private subnet trỏ tới; managed, scale tự động tới 100 Gbps, chỉ nằm trong 1 AZ → muốn HA phải tạo NAT Gateway **mỗi AZ**. NAT Gateway không dùng/không cần Security Group. NAT instance (legacy) thì ngược lại: tự quản, có SG, phải tắt **source/dest check**.
- "Private subnet cần gọi S3/DynamoDB, ít tốn kém nhất, không qua internet" → **Gateway Endpoint** (miễn phí, chỉ hỗ trợ đúng 2 service S3 và DynamoDB, gắn vào route table). Mọi service khác (SQS, KMS, ECR, Secrets Manager...) → **Interface Endpoint/PrivateLink** (tạo ENI trong subnet, tính tiền theo giờ + GB, điều khiển bằng SG).
- Gateway Endpoint cấu hình qua **route table + endpoint policy**; Interface Endpoint cấu hình qua **Security Group + private DNS**. Phân biệt cách "gắn" này là dạng hỏi quen thuộc.
- VPC Peering: **không transitive** (A↔B, B↔C không suy ra A↔C), CIDR **không được overlap**, và phải **cập nhật route table ở cả hai phía**. Peering được cross-account, cross-region.
- VPC Flow Logs ghi metadata IP traffic (ACCEPT/REJECT) ở mức VPC/subnet/ENI, gửi tới CloudWatch Logs, S3 hoặc Firehose — dùng để troubleshoot "vì sao kết nối bị chặn". Flow Logs **không ghi payload** và không log một số traffic (Amazon DNS, metadata 169.254.169.254, DHCP).
- REJECT trong Flow Logs: nếu inbound bị reject → nghi SG hoặc NACL inbound; nếu inbound ACCEPT nhưng response outbound REJECT → chắc chắn NACL (vì SG stateful không bao giờ chặn response).
- Site-to-Site VPN: đi qua **internet công cộng**, mã hoá IPsec, dựng nhanh (giờ), cần Virtual Private Gateway + Customer Gateway. Direct Connect: **đường truyền riêng vật lý**, băng thông ổn định, độ trễ thấp, triển khai mất nhiều tuần, mặc định **không mã hoá**. Cần nhanh + mã hoá → VPN; cần ổn định băng thông lớn → DX (mức nhận diện là đủ cho DVA).
- Mỗi subnet thuộc đúng **1 AZ** và chỉ gắn được **1 route table** (1 NACL); ngược lại 1 route table/NACL phục vụ nhiều subnet. AWS giữ **5 IP mỗi subnet**.
- Kiến trúc 3-tier chuẩn: ALB ở public subnet → app instances ở private subnet (SG của app chỉ allow từ SG của ALB) → RDS/ElastiCache ở private subnet riêng (SG chỉ allow từ SG của app). Chuỗi SG-tham-chiếu-SG là đáp án mẫu.

## Quiz chương 11 (10 câu)

**Câu 1.** Một developer dựng web server EC2 trong subnet có route `0.0.0.0/0` trỏ tới Internet Gateway và đã gắn public IP. Người dùng kết nối được vào port 443, nhưng team bảo mật vừa siết NACL của subnet thì mọi response từ server không về tới client nữa, dù request vẫn đến server. Nguyên nhân khả dĩ nhất?
- A. Security Group thiếu outbound rule cho port 443
- B. NACL outbound thiếu rule allow dải ephemeral ports 1024–65535
- C. Route table thiếu route trỏ về client
- D. Server cần Elastic IP thay vì public IP thường

**Câu 2.** Ứng dụng chạy trên EC2 trong private subnet cần đọc/ghi S3 với yêu cầu: traffic không đi qua internet và chi phí thấp nhất. Giải pháp nào đúng?
- A. Tạo NAT Gateway ở public subnet và route private subnet qua đó
- B. Tạo Interface Endpoint cho S3 trong private subnet
- C. Tạo Gateway Endpoint cho S3 và thêm vào route table của private subnet
- D. Gắn Elastic IP cho instance để gọi S3 trực tiếp

**Câu 3.** Một developer cần chặn vĩnh viễn một dải IP đang tấn công brute-force vào fleet EC2, các traffic khác giữ nguyên. Cách nào đúng?
- A. Thêm deny rule vào Security Group của các instance
- B. Thêm deny rule với rule number nhỏ vào NACL của subnet
- C. Xoá route tới dải IP đó khỏi route table
- D. Bật VPC Flow Logs để tự động chặn IP REJECT

**Câu 4.** Công ty có VPC-A peered với VPC-B, VPC-B peered với VPC-C. Ứng dụng trong VPC-A không gọi được service trong VPC-C. Vì sao?
- A. Hai peering connection chưa bật DNS resolution
- B. VPC peering không transitive — cần peering trực tiếp A–C
- C. CIDR của VPC-A và VPC-C bị overlap
- D. Cần thêm Transit Gateway attachment vào VPC-B

**Câu 5.** Instance trong private subnet không tải được package update từ internet. Route table của subnet có route `0.0.0.0/0 → nat-xxxx`, NAT Gateway ở trạng thái available. Kiểm tra tiếp điều gì đầu tiên?
- A. NAT Gateway có đang nằm trong public subnet (subnet có route ra IGW) không
- B. Security Group của NAT Gateway có mở outbound không
- C. Instance đã gắn public IP chưa
- D. NACL của private subnet có allow port 22 không

**Câu 6.** Một developer cần Lambda-style microservice trên EC2 trong private subnet gọi SQS mà không đi qua internet. Lựa chọn nào đúng?
- A. Gateway Endpoint cho SQS
- B. Interface Endpoint (PrivateLink) cho SQS
- C. VPC Peering tới VPC của SQS
- D. NAT instance với source/dest check tắt

**Câu 7.** "A developer needs to" xác định vì sao kết nối từ app server tới RDS trong private subnet thỉnh thoảng bị từ chối, và cần bằng chứng ở mức network (IP nguồn, port, ACCEPT/REJECT). Dịch vụ nào phù hợp?
- A. AWS CloudTrail
- B. VPC Flow Logs
- C. AWS X-Ray
- D. CloudWatch detailed monitoring

**Câu 8.** Kiến trúc 3-tier: ALB public, app EC2 private, RDS private. Cách cấu hình Security Group cho RDS đúng best practice?
- A. Allow port 3306 từ CIDR 0.0.0.0/0 vì RDS đã ở private subnet
- B. Allow port 3306 từ CIDR của toàn VPC
- C. Allow port 3306 với source là Security Group của app tier
- D. Allow port 3306 từ Elastic IP của từng app instance

**Câu 9.** Công ty cần kết nối on-premises data center với VPC trong vài ngày tới, yêu cầu dữ liệu mã hoá khi truyền. Giải pháp phù hợp nhất?
- A. AWS Direct Connect
- B. Site-to-Site VPN với Virtual Private Gateway
- C. VPC Peering giữa data center và VPC
- D. Interface Endpoint cho data center

**Câu 10.** Một subnet /24 trong VPC được hỏi: có tối đa bao nhiêu IP khả dụng cho EC2, và một subnet trải được mấy AZ?
- A. 256 IP, trải nhiều AZ để HA
- B. 254 IP, đúng 1 AZ
- C. 251 IP, đúng 1 AZ
- D. 251 IP, tối đa 2 AZ

### Đáp án & giải thích

**Câu 1 — Đáp án B.** NACL stateless: request inbound vào 443 được allow, nhưng response đi ra từ port 443 của server tới **ephemeral port** (1024–65535) của client phải được NACL outbound allow riêng. Siết NACL mà quên dải này là lỗi kinh điển. A sai vì SG stateful — đã cho inbound 443 thì response tự động được ra, SG không bao giờ gây triệu chứng này. C sai: route `0.0.0.0/0 → IGW` đã bao trùm đường về client. D sai: public IP thường hay Elastic IP đều ra internet như nhau, khác biệt chỉ là IP có cố định hay không.

**Câu 2 — Đáp án C.** Gateway Endpoint cho S3 miễn phí, traffic đi trong mạng AWS qua prefix list trong route table, không chạm internet — thoả cả hai yêu cầu. A sai: NAT Gateway vẫn đưa traffic ra ngoài qua public endpoint của S3 và tốn phí giờ + data processing. B về kỹ thuật chạy được nhưng Interface Endpoint tính phí theo giờ và GB — không phải "chi phí thấp nhất" khi Gateway Endpoint tồn tại cho S3. D sai: vừa tốn tiền vừa đi qua internet, lại biến instance thành public.

**Câu 3 — Đáp án B.** Chỉ NACL có deny rule; đặt rule number nhỏ để nó được đánh giá trước rule allow. A sai: Security Group chỉ hỗ trợ allow — không tồn tại deny rule trong SG. C sai: route table điều khiển đường outbound, không chặn inbound theo nguồn, và xoá route ảnh hưởng mọi traffic tới dải đó. D sai: Flow Logs chỉ ghi nhận, không có khả năng chặn.

**Câu 4 — Đáp án B.** Peering là quan hệ 1-1, không transitive: traffic từ A không được phép "quá giang" qua B để tới C. Muốn A nói chuyện với C phải tạo peering A–C (hoặc dùng Transit Gateway — ngoài phạm vi DVA). A sai: DNS resolution chỉ ảnh hưởng việc phân giải tên riêng, không tạo đường đi. C là điều kiện chặn khi tạo peering trực tiếp giữa hai VPC overlap, nhưng không phải nguyên nhân của tình huống transitive này. D sai: Transit Gateway là giải pháp thay thế kiến trúc, không phải "thêm attachment vào B" là A–C tự thông trong mô hình peering.

**Câu 5 — Đáp án A.** NAT Gateway chỉ hoạt động nếu chính nó nằm ở subnet có đường ra Internet Gateway; đặt nhầm vào private subnet thì trạng thái vẫn available nhưng traffic chết. B sai: NAT Gateway **không có** Security Group — đây là điểm phân biệt với NAT instance. C sai: instance private không cần (và không nên có) public IP; NAT lo phần dịch địa chỉ. D sai: port 22 là SSH inbound, không liên quan outbound tải package (80/443 + ephemeral).

**Câu 6 — Đáp án B.** SQS không được Gateway Endpoint hỗ trợ — Gateway chỉ có S3 và DynamoDB. Mọi service khác private hoá bằng Interface Endpoint (PrivateLink), tạo ENI trong subnet và truy cập qua private DNS. A sai vì lý do trên. C vô nghĩa: SQS là managed service, không nằm trong "VPC của SQS" nào để peer. D sai: NAT instance vẫn đẩy traffic ra internet, trái yêu cầu.

**Câu 7 — Đáp án B.** Flow Logs ghi đúng những trường cần: source/dest IP, port, protocol, action ACCEPT/REJECT — bằng chứng network-layer để soi SG/NACL. A sai: CloudTrail ghi **API calls** (ai gọi DeleteTable), không ghi network traffic. C sai: X-Ray trace request ở tầng ứng dụng (latency, lỗi giữa các service đã instrument), không thấy packet bị NACL chặn. D sai: detailed monitoring chỉ tăng tần suất metric EC2 lên 1 phút, không có dữ liệu per-connection.

**Câu 8 — Đáp án C.** Tham chiếu SG của app tier nghĩa là chỉ ENI thuộc app tier mới vào được port 3306, tự thích nghi khi app instance scale in/out đổi IP. A sai: mở 0.0.0.0/0 là anti-pattern dù subnet private — defense in depth vẫn bắt buộc. B sai: cho cả VPC (kể cả bastion, ALB) chạm DB là quá rộng. D sai: app instance ở private subnet không có Elastic IP, và quản lý theo từng IP không scale được.

**Câu 9 — Đáp án B.** Site-to-Site VPN dựng trong vài giờ tới vài ngày, IPsec mã hoá sẵn — khớp cả hai yêu cầu thời gian và bảo mật. A sai: Direct Connect mất hàng tuần tới hàng tháng để provision và bản thân đường truyền không mã hoá mặc định. C sai: VPC Peering chỉ nối VPC với VPC, không nối on-premises. D sai: Interface Endpoint phục vụ truy cập private tới AWS service, không phải kết nối hybrid.

**Câu 10 — Đáp án C.** AWS giữ 5 IP mỗi subnet (network address, .1 router, .2 DNS, .3 dự phòng, broadcast) nên /24 còn 251 IP; và một subnet luôn thuộc đúng 1 AZ. A sai cả hai vế. B sai vế đầu — 254 là con số mạng truyền thống (trừ 2), AWS trừ 5. D sai vế sau — không tồn tại subnet 2 AZ; HA đạt được bằng nhiều subnet ở nhiều AZ.

## Tóm tắt chương

- VPC là mạng ảo cô lập theo region; chia thành subnets, mỗi subnet thuộc đúng 1 AZ và gắn 1 route table; AWS giữ 5 IP mỗi subnet.
- Public subnet = có route `0.0.0.0/0 → Internet Gateway`; instance cần thêm public IP/EIP mới ra internet được.
- Private subnet ra internet qua NAT Gateway (managed, đặt ở public subnet, per-AZ, không có SG) — NAT instance là legacy, tự quản, phải tắt source/dest check.
- Security Group: stateful, chỉ allow rules, gắn vào ENI, tham chiếu được SG khác. NACL: stateless, allow + deny, đánh giá theo rule number, gắn vào subnet — nhớ mở ephemeral ports 1024–65535 cho chiều response.
- Muốn chặn IP cụ thể → NACL deny; muốn cho phép theo tier → SG reference SG.
- VPC Endpoints: Gateway (chỉ S3 + DynamoDB, miễn phí, qua route table) vs Interface/PrivateLink (mọi service khác, tạo ENI, tính phí, điều khiển bằng SG + private DNS).
- VPC Peering: 1-1, không transitive, CIDR không overlap, cập nhật route table cả hai phía; hỗ trợ cross-account và cross-region.
- VPC Flow Logs ghi metadata traffic (ACCEPT/REJECT) tới CloudWatch Logs/S3/Firehose — công cụ troubleshoot connectivity; không ghi payload. Phân biệt với CloudTrail (API calls) và X-Ray (application traces).
- Kiến trúc 3-tier chuẩn: ALB public subnet → app private subnet → DB private subnet, nối bằng chuỗi SG tham chiếu SG, NAT Gateway mỗi AZ cho outbound.
- Site-to-Site VPN: qua internet, IPsec mã hoá, dựng nhanh. Direct Connect: đường riêng vật lý, ổn định, không mã hoá mặc định, provision lâu — DVA chỉ cần nhận diện đặc điểm.
- Dọn dẹp VPC luôn theo thứ tự: instances → endpoints → NAT Gateway (+ release EIP) → SG/route tables → detach + delete IGW → subnets → VPC.
