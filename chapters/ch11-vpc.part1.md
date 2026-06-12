# Chương 11: VPC cho Developer

> **Trọng tâm DVA-C02:** VPC không phải trọng tâm số một của đề Developer Associate (đề Solutions Architect mới đào sâu), nhưng đề DVA-C02 chắc chắn có 2–4 câu xoay quanh: phân biệt Security Group vs NACL, khi nào dùng VPC Endpoint để Lambda/EC2 trong private subnet gọi S3/DynamoDB mà không ra internet, vai trò NAT Gateway, và đọc hiểu VPC Flow Logs khi troubleshoot "vì sao app không kết nối được". Dạng câu hỏi điển hình: "A developer's Lambda function in a private subnet cannot reach DynamoDB — what is the MOST cost-effective solution?"

## Mục tiêu chương

- Hiểu VPC, CIDR block, cách chia subnet public/private và vì sao một subnet được gọi là "public".
- Nắm cơ chế route table, Internet Gateway, NAT Gateway/NAT Instance — luồng traffic đi ra/vào VPC thế nào.
- Phân biệt rạch ròi Security Group (stateful) vs Network ACL (stateless) — điểm thi kinh điển.
- Biết khi nào dùng Gateway Endpoint (S3, DynamoDB) vs Interface Endpoint (PrivateLink) và cấu hình bằng CLI.
- Hiểu VPC Peering, giới hạn transitive, và dùng VPC Flow Logs để troubleshoot kết nối.
- Vẽ được kiến trúc 3-tier điển hình và nhận diện Site-to-Site VPN vs Direct Connect.

## 11.1 VPC & CIDR — mạng riêng của bạn trên AWS

**VPC (Virtual Private Cloud)** là một mạng ảo cô lập về mặt logic trong một region. Mọi resource có network interface — EC2, RDS, ElastiCache, Lambda (khi attach vào VPC), ECS task, ALB — đều phải nằm trong một VPC. Mỗi region AWS tạo sẵn một **default VPC** (CIDR `172.31.0.0/16`, mỗi AZ một public subnet) để bạn launch EC2 được ngay; nhưng production thực tế luôn dùng custom VPC để kiểm soát dải IP và phân tầng mạng.

Khi tạo VPC, bạn khai báo một **CIDR block** (Classless Inter-Domain Routing) — dải IPv4 private theo RFC 1918:

- `10.0.0.0/8` (10.0.0.0 → 10.255.255.255)
- `172.16.0.0/12` (172.16.0.0 → 172.31.255.255)
- `192.168.0.0/16`

Quy tắc đọc CIDR nhanh: `/16` nghĩa là 16 bit đầu cố định, còn 32 − 16 = 16 bit cho host → 2^16 = 65,536 địa chỉ. `/24` → 256 địa chỉ. AWS giới hạn CIDR của VPC từ **/16 (lớn nhất) đến /28 (nhỏ nhất)**. Một VPC có thể gắn thêm tối đa 4 secondary CIDR (tổng 5) nếu sau này thiếu IP — nhưng secondary CIDR không được overlap với CIDR hiện có.

**Subnet** là một lát cắt của CIDR VPC, gắn với **đúng một Availability Zone** (subnet không bao giờ trải qua nhiều AZ — đây là lý do muốn high availability phải tạo subnet ở ≥2 AZ). Trong mỗi subnet, AWS **reserve 5 địa chỉ IP** mà bạn không dùng được. Ví dụ subnet `10.0.0.0/24`:

| IP | AWS dùng làm gì |
|---|---|
| 10.0.0.0 | Network address |
| 10.0.0.1 | VPC router |
| 10.0.0.2 | DNS resolver của Amazon (Route 53 Resolver, còn gọi ".2 address") |
| 10.0.0.3 | Reserved cho tương lai |
| 10.0.0.255 | Broadcast (AWS không hỗ trợ broadcast nhưng vẫn giữ) |

Vậy subnet `/24` thực tế chỉ có **251 IP khả dụng**, không phải 256.

> 💡 **Exam Tip:** Câu hỏi "cần 29 IP cho EC2, chọn subnet size nào?" — đáp án không phải /27 (32 địa chỉ) vì trừ 5 IP reserved chỉ còn 27. Phải chọn **/26** (64 − 5 = 59 khả dụng). Luôn nhớ trừ 5.

Tạo VPC và subnet bằng CLI:

```bash
# Tạo VPC với CIDR 10.0.0.0/16
aws ec2 create-vpc \
  --cidr-block 10.0.0.0/16 \
  --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=dev-vpc}]'

# Bật DNS hostnames (cần cho Interface Endpoint private DNS sau này)
aws ec2 modify-vpc-attribute --vpc-id vpc-0abc123 --enable-dns-hostnames

# Subnet public ở AZ a, subnet private ở AZ a
aws ec2 create-subnet --vpc-id vpc-0abc123 \
  --cidr-block 10.0.1.0/24 --availability-zone ap-southeast-1a \
  --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=public-1a}]'

aws ec2 create-subnet --vpc-id vpc-0abc123 \
  --cidr-block 10.0.11.0/24 --availability-zone ap-southeast-1a \
  --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=private-1a}]'
```

Bẫy thực tế: chọn CIDR **overlap với mạng on-premises hoặc VPC khác** thì sau này không peer/VPN được — sửa cực kỳ đau vì CIDR chính của VPC không đổi được sau khi tạo. Quy ước phổ biến: mỗi môi trường (dev/staging/prod) một dải /16 riêng, ví dụ `10.0.0.0/16`, `10.1.0.0/16`, `10.2.0.0/16`.

## 11.2 Internet Gateway & Route Tables — điều gì làm một subnet thành "public"

Đây là phần nhiều người hiểu mơ hồ nhất: **không có thuộc tính "public" nào trên subnet cả**. Một subnet được gọi là public hay private hoàn toàn do **route table** gắn với nó quyết định.

**Internet Gateway (IGW)** là thành phần managed, horizontally scaled, gắn vào VPC (mỗi VPC chỉ gắn được **1 IGW**) làm hai việc: (1) là target cho route ra internet, (2) thực hiện 1:1 NAT giữa private IP của instance và public IP/Elastic IP của nó. IGW không có bandwidth limit, không phải single point of failure.

**Route table** chứa các route dạng `destination CIDR → target`. Mỗi subnet phải associate với đúng một route table (nếu không chỉ định explicit thì dùng **main route table** của VPC). Mọi route table luôn có sẵn **local route** (CIDR của VPC → local) — không xoá được, đảm bảo mọi resource trong VPC nói chuyện được với nhau. Khi traffic match nhiều route, AWS chọn theo **longest prefix match** (route cụ thể nhất thắng).

Định nghĩa chính xác:

- **Public subnet** = subnet có route `0.0.0.0/0 → igw-xxx`. Instance trong đó muốn ra internet còn cần thêm **public IP** (auto-assign hoặc Elastic IP).
- **Private subnet** = subnet KHÔNG có route trỏ IGW. Muốn ra internet phải đi qua NAT (mục 11.3).

```bash
# Tạo và gắn Internet Gateway
aws ec2 create-internet-gateway
aws ec2 attach-internet-gateway --internet-gateway-id igw-0def456 --vpc-id vpc-0abc123

# Tạo route table cho public subnet, thêm default route ra IGW
aws ec2 create-route-table --vpc-id vpc-0abc123
aws ec2 create-route --route-table-id rtb-0pub111 \
  --destination-cidr-block 0.0.0.0/0 --gateway-id igw-0def456

# Associate route table với subnet public
aws ec2 associate-route-table --route-table-id rtb-0pub111 --subnet-id subnet-0pub1a

# Bật auto-assign public IP cho subnet public
aws ec2 modify-subnet-attribute --subnet-id subnet-0pub1a --map-public-ip-on-launch
```

> 💡 **Exam Tip:** "EC2 trong public subnet có route ra IGW nhưng vẫn không truy cập được internet" — checklist theo thứ tự: (1) instance có public IP/EIP chưa? (2) route table của subnet có `0.0.0.0/0 → IGW` chưa? (3) Security Group cho phép outbound chưa? (4) NACL cho phép cả outbound LẪN inbound ephemeral ports chưa? Đề rất hay gài thiếu public IP.

Bẫy production: gắn nhầm route `0.0.0.0/0 → IGW` vào **main route table** — mọi subnet chưa associate explicit bỗng thành public. Best practice: main route table để trống (chỉ local route), mọi subnet đều associate explicit.

## 11.3 NAT Gateway & NAT Instance — private subnet ra internet

Instance trong private subnet (app server, worker, database) vẫn cần **outbound internet**: gọi API bên thứ ba, pull package npm/apt, nhận OS update. **NAT (Network Address Translation)** giải quyết việc này: cho phép traffic **đi ra** internet nhưng internet **không thể chủ động kết nối vào**.

**NAT Gateway** là dịch vụ managed, được AWS khuyến nghị:

- Đặt trong **public subnet**, gắn một **Elastic IP**.
- Băng thông bắt đầu **5 Gbps, tự scale tới 100 Gbps**.
- Resilient **trong một AZ** — muốn chịu lỗi AZ phải tạo NAT Gateway ở **mỗi AZ** và route table của private subnet mỗi AZ trỏ về NAT Gateway cùng AZ (vừa tránh cross-AZ data charge, vừa sống sót khi một AZ chết).
- Không cần quản lý SG cho NAT Gateway (nó không dùng Security Group); không cần patch, không cần disable source/destination check.
- Tính tiền theo giờ + theo GB xử lý — đây là khoản hay gây "bill shock" khi app trong private subnet tải dữ liệu lớn từ S3 qua NAT (giải pháp: Gateway Endpoint, mục 11.5).

**NAT Instance** là cách cũ: tự chạy EC2 từ AMI NAT (đã deprecated), tự chịu trách nhiệm scale, patch, failover. Điểm kỹ thuật quan trọng: phải **disable source/destination check** trên instance (mặc định EC2 drop packet không phải gửi đến/đi từ chính nó — NAT instance forward hộ nên phải tắt check này), và phải mở Security Group cho traffic từ private subnet.

| Tiêu chí | NAT Gateway | NAT Instance |
|---|---|---|
| Quản lý | AWS managed | Tự quản (patch, AMI, scale) |
| Băng thông | 5 → 100 Gbps tự scale | Phụ thuộc instance type |
| Availability | HA trong 1 AZ; multi-AZ = tạo nhiều cái | Tự dựng failover script |
| Security Group | Không dùng SG | Phải cấu hình SG |
| Source/dest check | Không liên quan | Phải **disable** |
| Bastion host kiêm nhiệm | Không | Có thể |
| Chi phí | Theo giờ + per GB | Giá EC2 (rẻ hơn cho traffic nhỏ) |

```bash
# Tạo NAT Gateway trong public subnet với Elastic IP
aws ec2 allocate-address --domain vpc
aws ec2 create-nat-gateway \
  --subnet-id subnet-0pub1a \
  --allocation-id eipalloc-0aaa111 \
  --tag-specifications 'ResourceType=natgateway,Tags=[{Key=Name,Value=nat-1a}]'

# Route table của private subnet: default route trỏ NAT Gateway
aws ec2 create-route --route-table-id rtb-0priv111 \
  --destination-cidr-block 0.0.0.0/0 --nat-gateway-id nat-0bbb222
```

Lưu ý: NAT Gateway dùng cho **IPv4**. Với IPv6, AWS không có khái niệm private IPv6 theo kiểu NAT — thay vào đó dùng **Egress-Only Internet Gateway**: cho instance IPv6 đi ra internet nhưng chặn kết nối chủ động từ ngoài vào (tương đương vai trò NAT Gateway nhưng cho IPv6, và miễn phí).

> 💡 **Exam Tip:** Từ khoá "instances in private subnet need to download OS updates / call external API" → **NAT Gateway trong public subnet + route từ private subnet**. Nếu đề thêm "highly available across AZs" → một NAT Gateway **mỗi AZ**. Nếu đề hỏi truy cập S3/DynamoDB và nhấn "most cost-effective / not traverse the internet" → KHÔNG phải NAT, mà là **VPC Gateway Endpoint** (miễn phí).

## 11.4 Security Group vs Network ACL — stateful vs stateless

Đây là câu hỏi xuất hiện gần như chắc chắn trong đề. VPC có hai lớp firewall:

**Security Group (SG)** — firewall mức **ENI/instance** (chi tiết về rules và SG referencing ở Chương 4):

- **Stateful**: nếu inbound được cho phép, response outbound **tự động được phép** bất kể outbound rules — và ngược lại. AWS track connection state.
- Chỉ có **allow rules**, không có deny. Mặc định: deny tất cả inbound, allow tất cả outbound.
- Tất cả rules được **đánh giá đồng thời** — chỉ cần một rule match là cho qua.
- Source có thể là CIDR, một SG khác (referencing), hoặc prefix list.

**Network ACL (NACL)** — firewall mức **subnet**:

- **Stateless**: KHÔNG track connection. Request vào được không có nghĩa response ra được — phải mở rule cả hai chiều, bao gồm **ephemeral ports** (cổng tạm mà client dùng để nhận response, thường 1024–65535; Linux mặc định 32768–60999).
- Có cả **allow lẫn deny rules** — NACL là công cụ duy nhất trong hai cái để **block một IP cụ thể**.
- Rules được đánh giá theo **rule number từ thấp đến cao, match đầu tiên thắng** và dừng. Cuối cùng luôn có rule `*` (implicit deny).
- Một subnet chỉ gắn **một NACL**; một NACL gắn được nhiều subnet. **Default NACL** allow tất cả hai chiều; **custom NACL mới tạo deny tất cả** hai chiều — bẫy kinh điển.

| Tiêu chí | Security Group | Network ACL |
|---|---|---|
| Cấp độ | ENI / instance | Subnet |
| State | **Stateful** (nhớ connection) | **Stateless** (mở 2 chiều thủ công) |
| Loại rule | Chỉ allow | Allow + **deny** |
| Thứ tự đánh giá | Tất cả rules cùng lúc | Theo rule number, first match wins |
| Mặc định | Deny in, allow out | Default NACL: allow all; custom: deny all |
| Block 1 IP cụ thể | Không làm được | Làm được (deny rule) |
| Áp dụng | Phải gắn explicit vào instance/ENI | Tự áp cho mọi instance trong subnet |

Ví dụ luồng đầy đủ một request HTTP từ internet vào EC2 trong public subnet: NACL inbound (port 80) → SG inbound (port 80) → app xử lý → SG outbound (**tự động pass vì stateful**) → NACL outbound (**phải có rule allow ephemeral ports 1024–65535** về IP client). Quên rule ephemeral outbound trên NACL là lỗi "connect được nhưng timeout không thấy response" rất phổ biến.

```bash
# Tạo NACL rule: deny inbound từ một IP đang tấn công, rule number 90 (trước rule allow 100)
aws ec2 create-network-acl-entry \
  --network-acl-id acl-0ccc333 \
  --rule-number 90 \
  --protocol -1 \
  --cidr-block 203.0.113.66/32 \
  --rule-action deny \
  --ingress

# Allow outbound ephemeral ports (bắt buộc vì NACL stateless)
aws ec2 create-network-acl-entry \
  --network-acl-id acl-0ccc333 \
  --rule-number 100 \
  --protocol 6 \
  --port-range From=1024,To=65535 \
  --cidr-block 0.0.0.0/0 \
  --rule-action allow \
  --egress
```

> 💡 **Exam Tip:** "Block traffic from a specific IP address" → **NACL deny rule** (SG không có deny). "Allow web tier reach app tier without hardcoding IPs" → SG referencing SG (Chương 4). Nếu đề tả "inbound hoạt động nhưng response không quay về dù SG outbound mở" → nghi ngay **NACL stateless thiếu ephemeral ports**.

## 11.5 VPC Endpoints — gọi AWS services không qua internet

Mặc định, khi EC2/Lambda trong VPC gọi `s3.ap-southeast-1.amazonaws.com` hay `dynamodb.ap-southeast-1.amazonaws.com`, traffic đi tới **public endpoint** của dịch vụ — nghĩa là instance phải có đường ra internet (public IP + IGW, hoặc NAT Gateway). Điều này vừa tốn tiền NAT, vừa khó qua audit bảo mật ("dữ liệu không được rời mạng private"). **VPC Endpoint** giải quyết: traffic tới AWS service đi hoàn toàn trong mạng AWS private, không cần IGW/NAT. Có hai loại — và phân biệt chúng là điểm thi quan trọng.

### Gateway Endpoint — chỉ cho S3 và DynamoDB

- Hoạt động bằng cách thêm một **route vào route table**: destination là **prefix list** của service (ví dụ `pl-6fa54006` cho S3), target là endpoint `vpce-xxx`.
- **Miễn phí** — không tốn tiền giờ, không tốn tiền data processing.
- Chỉ hỗ trợ **S3 và DynamoDB**, chỉ truy cập được **từ trong chính VPC đó** (không dùng được từ on-premises qua VPN/DX, không qua VPC Peering, không cross-region).
- Có thể gắn **endpoint policy** để giới hạn, ví dụ chỉ cho phép truy cập một số bucket nhất định.

```bash
# Gateway Endpoint cho S3 — gắn vào route table của private subnet
aws ec2 create-vpc-endpoint \
  --vpc-id vpc-0abc123 \
  --vpc-endpoint-type Gateway \
  --service-name com.amazonaws.ap-southeast-1.s3 \
  --route-table-ids rtb-0priv111

# Gateway Endpoint cho DynamoDB
aws ec2 create-vpc-endpoint \
  --vpc-id vpc-0abc123 \
  --vpc-endpoint-type Gateway \
  --service-name com.amazonaws.ap-southeast-1.dynamodb \
  --route-table-ids rtb-0priv111
```

Sau lệnh trên, SDK trong private subnet hoạt động **không cần đổi code** — DNS của S3 vẫn resolve ra public IP, nhưng route table match prefix list và đẩy traffic qua endpoint. Đây là điểm hay gây nhầm: Gateway Endpoint hoạt động ở tầng **routing**, không phải DNS.

### Interface Endpoint (AWS PrivateLink) — cho hầu hết mọi service còn lại

- Là một **ENI với private IP** đặt trong subnet của bạn (mỗi AZ một ENI để HA), có **Security Group** gắn vào — phải mở inbound 443 từ nguồn cần gọi.
- Hỗ trợ hàng trăm service: SQS, SNS, Kinesis, Secrets Manager, KMS, ECR, CloudWatch Logs, API Gateway (private API), Step Functions... và cả **S3/DynamoDB cũng có Interface Endpoint** (khi cần truy cập từ on-premises hoặc cross-VPC, vì Gateway Endpoint không làm được).
- Khi bật **Private DNS** (yêu cầu VPC bật `enableDnsSupport` + `enableDnsHostnames`), hostname mặc định của service (`sqs.ap-southeast-1.amazonaws.com`) resolve ra **private IP của ENI** — code SDK không phải đổi gì.
- **Tốn phí**: ~$0.01/giờ mỗi ENI mỗi AZ + per GB data processed. Nhân với số AZ và số service, chi phí cộng dồn đáng kể.

```bash
# Interface Endpoint cho SQS, đặt trong 2 private subnet, gắn SG
aws ec2 create-vpc-endpoint \
  --vpc-id vpc-0abc123 \
  --vpc-endpoint-type Interface \
  --service-name com.amazonaws.ap-southeast-1.sqs \
  --subnet-ids subnet-0priv1a subnet-0priv1b \
  --security-group-ids sg-0endpoint1 \
  --private-dns-enabled
```

Kiểm tra bằng SDK JS v3 từ instance trong private subnet (không NAT, không IGW):

```javascript
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

// Không cần endpoint override — Private DNS đã trỏ hostname SQS
// về private IP của Interface Endpoint trong VPC
const sqs = new SQSClient({ region: "ap-southeast-1" });

await sqs.send(new SendMessageCommand({
  QueueUrl: "https://sqs.ap-southeast-1.amazonaws.com/123456789012/orders",
  MessageBody: JSON.stringify({ orderId: "o-123" }),
}));
// Chạy được dù subnet không có đường ra internet
```

| Tiêu chí | Gateway Endpoint | Interface Endpoint (PrivateLink) |
|---|---|---|
| Service hỗ trợ | Chỉ **S3, DynamoDB** | Hầu hết AWS services + SaaS bên thứ ba |
| Cơ chế | Route trong route table (prefix list) | ENI + private IP trong subnet |
| Chi phí | **Miễn phí** | Tính giờ theo ENI/AZ + per GB |
| Security Group | Không dùng (dùng endpoint policy) | Có SG, phải mở inbound 443 |
| Từ on-premises (VPN/DX) | Không | **Có** |
| Qua VPC Peering | Không | Có (route được tới ENI) |

> 💡 **Exam Tip:** "Lambda/EC2 in private subnet needs to access **DynamoDB** with NO internet traffic, **most cost-effective**" → **Gateway Endpoint** (miễn phí, đừng chọn NAT Gateway hay Interface Endpoint). "Access **Secrets Manager/SQS/KMS** from private subnet without internet" → **Interface Endpoint**, vì Gateway chỉ có S3/DynamoDB. "Access S3 privately **from on-premises** through Direct Connect" → Interface Endpoint cho S3, không phải Gateway.

Bẫy thực tế khi dùng Interface Endpoint: quên mở **inbound 443 trên SG của endpoint** từ SG/CIDR của caller — triệu chứng là SDK timeout (không phải lỗi 403). Bẫy thứ hai: endpoint policy mặc định allow all, nhưng nếu team security siết policy mà quên một action (ví dụ `sqs:GetQueueUrl`), lỗi trả về là AccessDenied dù IAM role đầy đủ quyền — vì request bị chặn ở **tầng endpoint policy**, đánh giá AND với IAM policy.

## 11.6 VPC Peering — nối hai VPC

**VPC Peering** tạo kết nối network 1-1 giữa hai VPC (cùng account, khác account, cùng region hay **cross-region** đều được), cho resource hai bên nói chuyện bằng private IP như chung một mạng. Traffic đi trên backbone của AWS, không qua internet, không có single point of failure, không bottleneck băng thông.

Ba điều kiện/giới hạn phải nhớ:

1. **CIDR không được overlap.** Hai VPC cùng `10.0.0.0/16` thì không peer được — đây là lý do phải quy hoạch CIDR từ đầu (mục 11.1).
2. **Không transitive.** A peer B, B peer C **không** có nghĩa A nói chuyện được với C. Muốn N VPC full-mesh phải tạo N×(N−1)/2 peering — 10 VPC là 45 kết nối. Khi đề bài tả "hàng chục VPC cần kết nối với nhau" → đáp án là **AWS Transit Gateway** (hub-and-spoke, chỉ cần nhận diện ở mức DVA).
3. **Phải cập nhật route table ở CẢ HAI phía.** Tạo peering xong mà quên thêm route `CIDR-bên-kia → pcx-xxx` thì ping vẫn fail. Đồng thời SG/NACL hai bên phải allow; điểm hay: SG có thể **reference SG của VPC peer** nếu cùng region.

```bash
# VPC A (requester) gửi yêu cầu peering tới VPC B (accepter, có thể khác account)
aws ec2 create-vpc-peering-connection \
  --vpc-id vpc-0aaaAAA \
  --peer-vpc-id vpc-0bbbBBB \
  --peer-owner-id 222233334444 \
  --peer-region ap-northeast-1

# Bên B chấp nhận
aws ec2 accept-vpc-peering-connection --vpc-peering-connection-id pcx-0ccc999

# Route table HAI BÊN đều phải thêm route
aws ec2 create-route --route-table-id rtb-vpcA \
  --destination-cidr-block 10.1.0.0/16 --vpc-peering-connection-id pcx-0ccc999
aws ec2 create-route --route-table-id rtb-vpcB \
  --destination-cidr-block 10.0.0.0/16 --vpc-peering-connection-id pcx-0ccc999
```

> 💡 **Exam Tip:** Đề tả "VPC A peered with B, B peered with C, instance in A cannot reach C" — không phải bug, đó là **thiết kế: peering không transitive**. Phải peer trực tiếp A–C hoặc dùng Transit Gateway. Câu phụ hay gặp: "peering created but instances cannot communicate" → thiếu **route table entries** ở một hoặc cả hai phía.

## 11.7 VPC Flow Logs — troubleshoot kết nối

**VPC Flow Logs** ghi lại metadata của IP traffic (KHÔNG ghi payload/nội dung packet) đi qua network interface. Bật được ở 3 cấp: **VPC** (mọi ENI trong VPC), **Subnet** (mọi ENI trong subnet), hoặc **một ENI cụ thể**. Nó cũng bắt được traffic của managed services dùng ENI trong VPC của bạn: ELB, RDS, ElastiCache, NAT Gateway, Interface Endpoints...

Đích ghi log: **CloudWatch Logs**, **S3**, hoặc **Kinesis Data Firehose**. Bản ghi mặc định có dạng:

```
version account-id interface-id srcaddr dstaddr srcport dstport protocol packets bytes start end action log-status
2 123456789012 eni-0abc123 203.0.113.12 10.0.1.25 49152 443 6 10 840 1718150400 1718150460 ACCEPT OK
2 123456789012 eni-0abc123 198.51.100.7 10.0.1.25 49153 22 6 1 44 1718150400 1718150460 REJECT OK
```

Hai trường quan trọng nhất để troubleshoot là `action` (**ACCEPT/REJECT**) và cặp địa chỉ/cổng. Kỹ thuật đọc hiểu mà đề hay kiểm tra — suy ra ai chặn traffic từ pattern của flow logs, dựa trên việc SG stateful còn NACL stateless:

- **Inbound REJECT** → bị chặn bởi SG **hoặc** NACL inbound.
- **Inbound ACCEPT nhưng outbound (response) REJECT** → chắc chắn là **NACL outbound** chặn. Vì SG stateful: đã cho inbound vào thì response tự động được ra; chỉ NACL stateless mới chặn được chiều về.
- Tương tự chiều đi: **outbound ACCEPT, inbound response REJECT** → NACL inbound thiếu ephemeral ports.

```bash
# Bật Flow Logs cho cả VPC, ghi vào CloudWatch Logs
aws ec2 create-flow-logs \
  --resource-type VPC \
  --resource-ids vpc-0abc123 \
  --traffic-type REJECT \
  --log-group-name /vpc/dev-vpc/flow-logs \
  --deliver-logs-permission-arn arn:aws:iam::123456789012:role/flow-logs-role
```

`--traffic-type` nhận `ACCEPT`, `REJECT` hoặc `ALL` — khi chỉ cần điều tra "cái gì đang chặn app", log riêng REJECT giúp giảm noise và chi phí. Truy vấn nhanh bằng CloudWatch Logs Insights (chi tiết Logs Insights ở Chương 25):

```sql
fields @timestamp, srcAddr, dstAddr, dstPort, action
| filter action = "REJECT" and dstPort = 5432
| sort @timestamp desc
| limit 20
```

Lưu ý vận hành: Flow Logs **không real-time** (delivery trễ vài phút), và không capture một số traffic: tới Amazon DNS resolver (.2 address), instance metadata `169.254.169.254`, DHCP, Windows license activation. Flow log cũng không bật hồi tố — chỉ ghi từ lúc tạo trở đi, nên production nên bật sẵn ở mức REJECT.

> 💡 **Exam Tip:** "Developer needs to identify why connections to an instance are failing / which security layer is blocking traffic" → **VPC Flow Logs**. Phân biệt với: nội dung request HTTP → ALB access logs; ai gọi API AWS → CloudTrail (Chương 27); trace latency qua microservices → X-Ray (Chương 26).

## 11.8 Kiến trúc 3-tier điển hình, Site-to-Site VPN & Direct Connect

Ghép toàn bộ chương lại thành kiến trúc 3-tier kinh điển mà đề DVA dùng làm bối cảnh cho rất nhiều câu hỏi:

```
VPC 10.0.0.0/16 (2 AZ)
├── Public subnets  (10.0.1.0/24, 10.0.2.0/24)
│     ALB + NAT Gateway (mỗi AZ một NAT)   ← route 0.0.0.0/0 → IGW
├── Private subnets — app tier (10.0.11.0/24, 10.0.12.0/24)
│     EC2/ECS/Lambda                        ← route 0.0.0.0/0 → NAT GW cùng AZ
│     Gateway Endpoint → S3, DynamoDB; Interface Endpoint → Secrets Manager
└── Private subnets — data tier (10.0.21.0/24, 10.0.22.0/24)
      RDS Multi-AZ / ElastiCache            ← KHÔNG có route ra internet
```

Chuỗi Security Group chuẩn: SG của ALB allow 443 từ `0.0.0.0/0` → SG của app tier allow port app **từ SG của ALB** (không phải từ CIDR) → SG của RDS allow 5432/3306 **từ SG của app tier**. Cách reference SG này giúp scale in/out không phải sửa rule (chi tiết ở Chương 4). Data tier không cần NAT — RDS không cần ra internet; nếu app cần gọi S3 thì đi qua Gateway Endpoint, tiết kiệm toàn bộ phí NAT data processing.

Cuối cùng, hai dịch vụ kết nối on-premises chỉ cần **nhận diện** trong phạm vi DVA-C02:

- **Site-to-Site VPN**: kết nối **encrypted IPsec đi qua public internet** giữa on-premises (Customer Gateway — thiết bị/software phía bạn) và VPC (Virtual Private Gateway gắn vào VPC). Dựng nhanh trong vài giờ, mỗi tunnel ~1.25 Gbps, latency phụ thuộc internet. Mỗi connection có sẵn 2 tunnel để redundancy.
- **Direct Connect (DX)**: **đường truyền vật lý riêng** (dedicated 1/10/100 Gbps hoặc hosted capacity nhỏ hơn) từ datacenter của bạn vào AWS qua DX location. Băng thông ổn định, latency thấp và nhất quán, **nhưng mặc định KHÔNG encrypted** (là private connection, không phải encrypted connection — muốn mã hoá phải chạy VPN over DX) và thời gian provisioning tính bằng **tuần đến hàng tháng**.

| Tiêu chí | Site-to-Site VPN | Direct Connect |
|---|---|---|
| Đường truyền | Internet công cộng | Cáp riêng vật lý |
| Mã hoá | IPsec sẵn có | Không mặc định (cần VPN over DX) |
| Thời gian dựng | Vài giờ | Vài tuần → vài tháng |
| Băng thông/latency | ≤1.25 Gbps/tunnel, dao động | Tới 100 Gbps, ổn định |
| Chi phí | Thấp | Cao (port fee + data) |
| Use case đề thi | "quick / encrypted over internet" | "consistent low latency / large transfer / dedicated" |

> 💡 **Exam Tip:** Từ khoá "establish connectivity **quickly** / encrypted over the internet" → Site-to-Site VPN. "**Consistent network performance**, dedicated bandwidth, không đi qua internet" → Direct Connect. Cần cả nhanh-có-ngay lẫn về-sau-ổn-định → VPN trước, DX sau (VPN làm backup cho DX). Đề DVA không hỏi sâu hơn mức này.

Một lưu ý cuối cho developer: khi Lambda cần truy cập resource trong VPC (RDS, ElastiCache), Lambda sẽ attach ENI vào private subnet và chịu mọi quy tắc routing/SG của chương này — kể cả việc mất đường ra internet nếu subnet không có NAT (chi tiết cấu hình Lambda trong VPC ở Chương 29).
