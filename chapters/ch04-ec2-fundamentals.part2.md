## Hands-on Lab: Launch EC2 instance hoàn chỉnh bằng CLI — Security Group, User Data, IAM Role, IMDSv2

**Mục tiêu lab:** Dựng một web server trên EC2 hoàn toàn bằng AWS CLI v2: tạo key pair, Security Group, IAM Role gắn instance, launch instance Amazon Linux 2023 với User Data cài nginx, bắt buộc IMDSv2, truy vấn metadata bằng token, gắn Elastic IP, rồi dọn sạch toàn bộ. Đây chính là chuỗi thao tác mà đề DVA-C02 hay cắt lát ra hỏi từng bước.

**Chuẩn bị:**
- AWS CLI v2 đã cấu hình profile có quyền EC2 + IAM (xem Chương 3).
- Region mặc định: `ap-southeast-1` (đổi tuỳ bạn). Mọi lệnh dưới giả định region này.
- Tài khoản còn free tier hoặc chấp nhận chi phí vài cent cho `t3.micro` (~0.0132 USD/giờ ở Singapore).

### Bước 1: Tìm AMI Amazon Linux 2023 mới nhất qua SSM public parameter

Đừng hardcode AMI ID — mỗi region có ID khác nhau và AMI được patch liên tục. AWS publish AMI mới nhất qua SSM public parameter:

```bash
AMI_ID=$(aws ssm get-parameter \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --query 'Parameter.Value' --output text)
echo $AMI_ID
```

Output mong đợi (ID thay đổi theo thời điểm):

```
ami-0c1907b6d738188e5
```

### Bước 2: Tạo key pair

```bash
aws ec2 create-key-pair \
  --key-name dva-lab-key \
  --key-type ed25519 \
  --query 'KeyMaterial' --output text > dva-lab-key.pem
chmod 400 dva-lab-key.pem
```

Lưu ý: private key CHỈ trả về một lần duy nhất tại thời điểm tạo — AWS không lưu. Mất file `.pem` là mất luôn, phải tạo key pair mới (hoặc dùng EC2 Instance Connect như Bước 7).

### Bước 3: Tạo Security Group

Dùng default VPC cho gọn:

```bash
VPC_ID=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true \
  --query 'Vpcs[0].VpcId' --output text)

SG_ID=$(aws ec2 create-security-group \
  --group-name dva-lab-sg \
  --description "Lab chapter 4" \
  --vpc-id $VPC_ID \
  --query 'GroupId' --output text)

# Mở HTTP cho cả thế giới, SSH chỉ cho IP của bạn
MY_IP=$(curl -s https://checkip.amazonaws.com)
aws ec2 authorize-security-group-ingress --group-id $SG_ID \
  --protocol tcp --port 80 --cidr 0.0.0.0/0
aws ec2 authorize-security-group-ingress --group-id $SG_ID \
  --protocol tcp --port 22 --cidr ${MY_IP}/32
```

Để ý: ta KHÔNG tạo outbound rule nào — SG mặc định allow all outbound, và vì SG là stateful, response của inbound request tự động được phép quay ra, không cần rule chiều về.

### Bước 4: Tạo IAM Role cho instance

Một instance muốn gọi AWS API thì gắn role, không bao giờ copy access key vào máy. Role cho EC2 cần trust policy cho `ec2.amazonaws.com` và phải bọc trong **instance profile** (console tự tạo giúp, CLI phải tự làm — điểm hay quên):

```bash
cat > trust.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "ec2.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}
EOF

aws iam create-role --role-name dva-lab-role \
  --assume-role-policy-document file://trust.json
aws iam attach-role-policy --role-name dva-lab-role \
  --policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess

aws iam create-instance-profile --instance-profile-name dva-lab-profile
aws iam add-role-to-instance-profile \
  --instance-profile-name dva-lab-profile --role-name dva-lab-role
```

### Bước 5: Viết User Data và launch instance (ép IMDSv2)

```bash
cat > userdata.sh <<'EOF'
#!/bin/bash
dnf install -y nginx
echo "<h1>DVA-C02 lab - $(hostname -f)</h1>" > /usr/share/nginx/html/index.html
systemctl enable --now nginx
EOF

INSTANCE_ID=$(aws ec2 run-instances \
  --image-id $AMI_ID \
  --instance-type t3.micro \
  --key-name dva-lab-key \
  --security-group-ids $SG_ID \
  --iam-instance-profile Name=dva-lab-profile \
  --user-data file://userdata.sh \
  --metadata-options "HttpTokens=required,HttpPutResponseHopLimit=1,HttpEndpoint=enabled" \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=dva-lab}]' \
  --query 'Instances[0].InstanceId' --output text)

aws ec2 wait instance-running --instance-ids $INSTANCE_ID
PUBLIC_IP=$(aws ec2 describe-instances --instance-ids $INSTANCE_ID \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
echo "http://$PUBLIC_IP"
```

Ba điểm thi nằm ngay trong lệnh này:
- `--user-data` chạy bằng **root**, chỉ chạy **một lần lúc first boot** (mặc định), và phải bắt đầu bằng shebang `#!/bin/bash`. CLI tự base64-encode; gọi raw API thì bạn phải tự encode. Giới hạn 16 KB.
- `HttpTokens=required` = bắt buộc IMDSv2 (session-oriented). `HttpPutResponseHopLimit=1` chặn container/relay phía sau lấy token.
- IAM role gắn qua `--iam-instance-profile`, có thể attach/replace khi instance đang chạy mà không cần stop.

Mở `http://$PUBLIC_IP` sau ~1–2 phút (user data cần thời gian chạy), thấy trang "DVA-C02 lab". Nếu trang không lên: kiểm tra SG port 80 trước, rồi SSH vào xem log user data tại `/var/log/cloud-init-output.log` — đây là file đầu tiên cần xem khi user data "không chạy".

### Bước 6: Truy vấn IMDSv2 và xác nhận credentials từ role

SSH vào instance:

```bash
ssh -i dva-lab-key.pem ec2-user@$PUBLIC_IP
```

Trong instance, thử kiểu IMDSv1 (GET thẳng) — phải bị từ chối vì ta đã ép `required`:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://169.254.169.254/latest/meta-data/
# Output: 401
```

Đúng bài IMDSv2: PUT lấy token trước, rồi GET kèm header:

```bash
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \
  http://169.254.169.254/latest/meta-data/iam/security-credentials/
# Output: dva-lab-role
curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \
  http://169.254.169.254/latest/meta-data/iam/security-credentials/dva-lab-role
```

Output là JSON chứa `AccessKeyId`, `SecretAccessKey`, `Token`, `Expiration` — chính là temporary credentials mà SDK/CLI tự lấy qua credentials provider chain (Chương 3). Xác nhận bằng:

```bash
aws s3 ls   # chạy được nhờ role, không cần aws configure
aws s3 mb s3://test-$RANDOM 2>&1 | tail -1   # AccessDenied — role chỉ có ReadOnly
```

Cùng cơ chế đó trong Node.js SDK v3 — không truyền credentials, provider chain tự rơi xuống IMDS:

```javascript
import { S3Client, ListBucketsCommand } from "@aws-sdk/client-s3";
const s3 = new S3Client({ region: "ap-southeast-1" }); // không hardcode key
console.log(await s3.send(new ListBucketsCommand({})));
```

### Bước 7: EC2 Instance Connect (không cần file .pem)

Thoát SSH, từ máy local:

```bash
aws ec2-instance-connect ssh --instance-id $INSTANCE_ID
```

CLI push một public key tạm (sống 60 giây) vào instance qua API `SendSSHPublicKey` rồi SSH bằng key đó. Quyền được kiểm soát bằng IAM action `ec2-instance-connect:SendSSHPublicKey` thay vì bằng việc giữ file `.pem` — đây là điểm phân biệt đề hay hỏi.

### Bước 8: Elastic IP — IP công khai cố định

Public IP hiện tại sẽ ĐỔI nếu bạn stop/start instance. Gắn Elastic IP để cố định:

```bash
ALLOC_ID=$(aws ec2 allocate-address --domain vpc \
  --query 'AllocationId' --output text)
aws ec2 associate-address --instance-id $INSTANCE_ID --allocation-id $ALLOC_ID
```

Thử `aws ec2 stop-instances` rồi `start-instances`: Elastic IP vẫn giữ nguyên, trong khi private IP cũng giữ nhưng public IP động (nếu không có EIP) đã đổi. Nhớ: EIP **miễn phí khi đang gắn vào instance đang chạy**, nhưng **tính tiền khi nằm không** hoặc gắn vào instance đã stop (và từ 2024 AWS tính phí mọi public IPv4 ~0.005 USD/giờ — thêm lý do để dọn dẹp).

### Dọn dẹp tài nguyên

Làm đúng thứ tự, vì SG và instance profile không xoá được khi còn bị tham chiếu:

```bash
# 1. Trả Elastic IP (disassociate tự xảy ra khi terminate, nhưng release phải tự làm)
aws ec2 disassociate-address --allocation-id $ALLOC_ID
aws ec2 release-address --allocation-id $ALLOC_ID

# 2. Terminate instance và CHỜ xong
aws ec2 terminate-instances --instance-ids $INSTANCE_ID
aws ec2 wait instance-terminated --instance-ids $INSTANCE_ID

# 3. Security Group, key pair
aws ec2 delete-security-group --group-id $SG_ID
aws ec2 delete-key-pair --key-name dva-lab-key && rm -f dva-lab-key.pem

# 4. IAM: gỡ theo thứ tự ngược lúc tạo
aws iam remove-role-from-instance-profile \
  --instance-profile-name dva-lab-profile --role-name dva-lab-role
aws iam delete-instance-profile --instance-profile-name dva-lab-profile
aws iam detach-role-policy --role-name dva-lab-role \
  --policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess
aws iam delete-role --role-name dva-lab-role
```

Kiểm tra lại bằng `aws ec2 describe-addresses` và `aws ec2 describe-instances --filters Name=tag:Name,Values=dva-lab` — không còn gì là sạch.

## 💡 Exam Tips chương 4

- **Security Group là stateful**: response của connection đã được allow tự động đi qua chiều ngược lại, không cần rule. NACL mới là stateless (chi tiết ở Chương 11). SG chỉ có **allow rule**, không có deny.
- SG có thể **reference một SG khác** làm source — pattern chuẩn cho tier architecture: SG của app tier chỉ allow inbound từ SG của load balancer, không hardcode CIDR.
- Đổi SG rule có hiệu lực **ngay lập tức**, không cần restart instance. "Timeout khi SSH/connect" → nghĩ ngay đến SG hoặc NACL; "connection refused" → SG đã cho qua, lỗi nằm ở application/service chưa chạy.
- **User Data** chạy với quyền **root**, chỉ một lần lúc **first boot**, giới hạn **16 KB**, phải base64-encode khi gọi API trực tiếp. Debug user data: `/var/log/cloud-init-output.log`.
- **IMDSv2**: PUT `http://169.254.169.254/latest/api/token` (TTL tối đa 21600 giây = 6 giờ) → GET kèm header `X-aws-ec2-metadata-token`. `HttpTokens=required` tắt hẳn IMDSv1. Câu hỏi "credentials của role bị lộ qua SSRF" → đáp án là enforce IMDSv2 + hop limit 1.
- Lấy credentials của role trên instance: path `iam/security-credentials/<role-name>` trong metadata — nhưng câu trả lời "đúng chuẩn" trong đề luôn là **để SDK/CLI tự lấy qua provider chain**, không bao giờ hardcode access key vào AMI, user data hay code.
- **Spot**: rẻ nhất (tới ~90%), bị reclaim với **cảnh báo 2 phút** (rebalance recommendation có thể đến sớm hơn) — chỉ cho workload chịu được gián đoạn (batch, CI). **Spot block** đã ngừng; **Spot Fleet/Instance** không dành cho database production.
- "Steady-state, chạy 24/7, cam kết 1–3 năm" → **Reserved Instances / Savings Plans**; Compute Savings Plans linh hoạt hơn (đổi family, region, sang Fargate/Lambda được) nhưng discount thấp hơn EC2 Instance Savings Plans. Yêu cầu license/compliance tách phần cứng → **Dedicated Host** (per-host, hỗ trợ BYOL) khác **Dedicated Instance** (per-instance, không kiểm soát placement).
- **Placement groups**: *cluster* = cùng rack, network thấp nhất độ trễ — HPC, nhưng rủi ro AZ fail cả cụm; *spread* = mỗi instance một rack riêng, **tối đa 7 instance/AZ** — app nhỏ critical; *partition* = tối đa 7 partition/AZ, nhiều instance mỗi partition — Hadoop/Kafka/Cassandra.
- **Elastic IP**: cố định, tối đa **5/region** (soft limit, xin tăng được), tính phí khi không gắn vào instance đang chạy. Đề hỏi "tránh IP đổi sau stop/start với ít thay đổi nhất" → EIP; nhưng best practice câu "thiết kế đúng" thường là DNS/Route 53 hoặc load balancer thay vì EIP.
- **EC2 Instance Connect** dùng IAM permission + key tạm 60 giây đẩy qua API, không cần quản lý file `.pem`; vẫn cần SG mở port 22 (từ IP range của dịch vụ EIC nếu dùng console).
- IAM Role **attach/detach được khi instance đang chạy**; một instance chỉ gắn **một instance profile** tại một thời điểm. CLI tạo role xong phải tự tạo instance profile + add role vào — console làm hộ nên nhiều người không biết bước này.

## Quiz chương 4 (10 câu)

**Câu 1.** Một developer SSH được vào EC2 instance nhưng gọi `curl http://localhost` thấy web app trả lời, còn từ internet thì browser quay vòng rồi timeout. Nguyên nhân khả dĩ nhất?
- A. Web app chưa chạy trên instance
- B. Security Group chưa có inbound rule cho port của web app
- C. Security Group thiếu outbound rule cho response trả về
- D. Instance cần gắn Elastic IP mới nhận được traffic

**Câu 2.** Ứng dụng Node.js chạy trên EC2 cần đọc object từ S3. Cách cấp quyền đúng chuẩn bảo mật nhất?
- A. Tạo IAM user, sinh access key, lưu vào file `~/.aws/credentials` trên instance
- B. Nhúng access key vào User Data để app đọc lúc boot
- C. Gắn IAM Role có policy S3 read vào instance, SDK tự lấy credentials qua IMDS
- D. Đặt access key vào biến môi trường trong AMI dùng chung

**Câu 3.** Security team yêu cầu mọi truy cập instance metadata phải dùng IMDSv2 và chặn IMDSv1 hoàn toàn. Cấu hình nào đáp ứng?
- A. `HttpEndpoint=disabled`
- B. `HttpTokens=required`
- C. `HttpTokens=optional` với `HttpPutResponseHopLimit=1`
- D. Xoá IAM role khỏi instance

**Câu 4.** Một batch job xử lý ảnh chạy hàng đêm khoảng 3 giờ, có checkpoint nên dừng giữa chừng cũng chạy lại được, cần tối ưu chi phí tối đa. Chọn purchasing option nào?
- A. On-Demand
- B. Reserved Instances 1 năm
- C. Spot Instances
- D. Dedicated Hosts

**Câu 5.** Một developer launch instance với User Data script cài đặt web server, nhưng sau khi instance running, web server không tồn tại. Việc ĐẦU TIÊN nên làm để debug?
- A. Kiểm tra CloudTrail xem ai sửa script
- B. SSH vào instance, xem `/var/log/cloud-init-output.log`
- C. Reboot instance để User Data chạy lại
- D. Kiểm tra outbound rule của Security Group

**Câu 6.** Ứng dụng HPC cần độ trễ network giữa các node thấp nhất có thể, throughput cao, chấp nhận rủi ro cùng chịu lỗi phần cứng. Chọn cấu hình nào?
- A. Spread placement group trải trên 3 AZ
- B. Cluster placement group trong một AZ
- C. Partition placement group với 7 partitions
- D. Launch instances ở nhiều region để giảm latency

**Câu 7.** Công ty có 8 instance critical, yêu cầu mỗi instance nằm trên phần cứng riêng biệt để một rack hỏng chỉ mất đúng 1 instance, tất cả trong cùng region. Vì sao spread placement group một AZ KHÔNG đáp ứng được?
- A. Spread group không hỗ trợ instance type lớn
- B. Spread group giới hạn 7 instance mỗi AZ — cần trải sang AZ thứ hai
- C. Spread group bắt buộc tối thiểu 10 instance
- D. Spread group chỉ dùng được với Dedicated Hosts

**Câu 8.** Một instance đang chạy web app, public IPv4 là 54.x.x.x. Sau khi stop rồi start để đổi instance type, khách hàng báo không truy cập được bằng IP cũ. Giải pháp nào tránh việc này lặp lại với ít thay đổi kiến trúc nhất?
- A. Dùng private IP để khách truy cập
- B. Gắn Elastic IP vào instance
- C. Chuyển sang instance store-backed AMI
- D. Không bao giờ stop instance nữa

**Câu 9.** Một developer cần SSH vào instance nhưng team không muốn phát hành và quản lý file private key `.pem` cho từng người; quyền truy cập phải kiểm soát tập trung bằng IAM. Dịch vụ/tính năng nào phù hợp?
- A. Bật password authentication trong sshd
- B. EC2 Instance Connect
- C. Chia sẻ một file .pem chung qua S3 presigned URL
- D. Tạo key pair mới mỗi tuần và rotate thủ công

**Câu 10.** App tier (SG-App) chỉ được nhận traffic port 8080 từ các instance phía sau ALB dùng SG-LB. Inbound rule đúng cho SG-App?
- A. Allow TCP 8080, source = CIDR của VPC
- B. Allow TCP 8080, source = SG-LB
- C. Allow TCP 8080, source = 0.0.0.0/0 vì SG là stateful
- D. Deny tất cả trừ SG-LB trên port 8080

### Đáp án & giải thích

**Câu 1 — Đáp án B.** App trả lời trên localhost nghĩa là app đang chạy (loại A). Timeout từ ngoài là dấu hiệu kinh điển của firewall drop packet — tức SG chưa mở inbound port đó. C sai vì SG stateful: inbound đã allow thì response tự ra được, và mặc định SG allow all outbound. D sai: public IP động vẫn nhận traffic bình thường, EIP chỉ giải quyết chuyện IP đổi, không liên quan reachability.

**Câu 2 — Đáp án C.** IAM Role + instance profile cấp temporary credentials tự rotate qua IMDS, SDK lấy tự động qua provider chain — không có secret tĩnh nào để lộ. A và D dùng long-term access key trên máy/AMI — chống chỉ định, key bị lộ là mất quyền vĩnh viễn cho tới khi revoke. B tệ nhất: User Data lưu plaintext, đọc được qua API `DescribeInstanceAttribute` bởi bất kỳ ai có quyền describe.

**Câu 3 — Đáp án B.** `HttpTokens=required` buộc mọi request metadata phải kèm session token (PUT trước, GET sau) — IMDSv1 (GET không token) trả 401. A sai vì tắt hẳn metadata endpoint làm SDK không lấy được role credentials, app hỏng. C sai: `optional` nghĩa là IMDSv1 vẫn dùng được. D sai: xoá role không chặn IMDSv1, chỉ làm mất chức năng.

**Câu 4 — Đáp án C.** Workload gián đoạn được (có checkpoint) + cần rẻ nhất = Spot, giảm tới ~90% so với On-Demand; bị reclaim có cảnh báo 2 phút thì checkpoint xử lý được. A đắt nhất, không có lý do dùng khi chịu được gián đoạn. B sai vì RI cam kết 1–3 năm cho workload steady-state 24/7, job 3 giờ/đêm lãng phí 87% thời gian commit. D dành cho compliance/BYOL, đắt nhất trong các phương án.

**Câu 5 — Đáp án B.** User Data chạy qua cloud-init; toàn bộ stdout/stderr nằm ở `/var/log/cloud-init-output.log` — đọc file này thấy ngay lỗi (sai package name, thiếu shebang, network lỗi...). A sai: CloudTrail ghi API call, không ghi việc script chạy trong OS. C sai: mặc định User Data chỉ chạy first boot, reboot không chạy lại (và terminate/launch lại mà chưa biết lỗi gì thì vô ích). D có thể liên quan (script cần internet tải package) nhưng không phải bước đầu — log mới cho biết có phải lỗi network không.

**Câu 6 — Đáp án B.** Cluster placement group đặt instance trên cùng rack/cụm phần cứng trong một AZ, cho latency thấp nhất và throughput 10 Gbps+ giữa các node — đúng yêu cầu HPC, và đề đã nói chấp nhận rủi ro cùng chịu lỗi. A ngược mục tiêu: spread tối đa hoá khoảng cách phần cứng, latency cao hơn. C dành cho distributed system cần fault isolation theo partition. D sai hẳn: cross-region latency là hàng chục–trăm ms.

**Câu 7 — Đáp án B.** Spread placement group giới hạn cứng **7 running instance mỗi AZ mỗi group**; 8 instance phải trải qua ≥2 AZ (vẫn cùng region, vẫn thoả yêu cầu). A sai — không có giới hạn instance type kiểu đó. C bịa — không có minimum. D sai — spread chạy trên shared hardware bình thường.

**Câu 8 — Đáp án B.** Stop/start làm instance đổi host vật lý nên public IPv4 động bị cấp lại; Elastic IP là địa chỉ static gắn với account, giữ nguyên qua stop/start — đúng "ít thay đổi nhất". A sai: private IP không route được từ internet. C sai và còn phản tác dụng: instance store-backed không stop được (chỉ terminate), dữ liệu mất. D không phải giải pháp — resize bắt buộc phải stop với EBS-backed instance.

**Câu 9 — Đáp án B.** EC2 Instance Connect push public key tạm (60 giây) qua API `SendSSHPublicKey`; quyền kiểm soát bằng IAM policy, audit qua CloudTrail, không có file key dài hạn để quản lý. A giảm bảo mật (brute-force password). C là anti-pattern: key chung không truy vết được ai dùng, presigned URL còn có thể bị forward. D vẫn phải phân phối file key, đúng cái team muốn tránh.

**Câu 10 — Đáp án B.** SG referencing: source là SG-LB nghĩa là "mọi ENI đang gắn SG-LB", tự đúng khi ALB scale/đổi IP — không phải bảo trì CIDR. A quá rộng: mọi resource trong VPC đều gọi được app tier. C mở cho cả internet — stateful không liên quan gì đến việc thu hẹp source. D sai về nguyên lý: Security Group không có deny rule, mọi thứ không được allow thì mặc định bị chặn.

## Tóm tắt chương

- AMI là template launch instance (OS + software + cấu hình), theo region; lấy AMI mới nhất qua SSM public parameter thay vì hardcode ID.
- Instance type đọc theo naming: family + generation + size (vd `t3.micro`, `c7g.xlarge` — `g` = Graviton); chọn family theo workload (compute/memory/storage optimized).
- Security Group: stateful, chỉ có allow rule, áp dụng thay đổi ngay lập tức, reference được SG khác làm source — pattern chuẩn cho multi-tier. Timeout = nghi SG; connection refused = nghi app.
- Key pair: AWS chỉ giữ public key, private key tải về một lần duy nhất; thay thế việc quản lý `.pem` bằng EC2 Instance Connect (key tạm 60 giây, kiểm soát qua IAM).
- User Data: chạy bằng root, một lần lúc first boot, max 16 KB, base64 khi gọi API; debug tại `/var/log/cloud-init-output.log`; tuyệt đối không nhét secret vào (đọc được qua DescribeInstanceAttribute).
- IMDSv2: PUT lấy token (TTL ≤ 6 giờ) rồi GET kèm header; `HttpTokens=required` + hop limit 1 chặn SSRF lấy trộm role credentials.
- IAM Role gắn EC2 qua instance profile (CLI phải tự tạo profile); credentials tạm tự rotate, SDK/CLI tự lấy qua provider chain — không bao giờ đặt access key trên instance.
- Purchasing options: On-Demand (linh hoạt, đắt) — Reserved/Savings Plans (steady 24/7, cam kết 1–3 năm) — Spot (rẻ tới 90%, cảnh báo reclaim 2 phút, workload chịu gián đoạn) — Dedicated Host/Instance (compliance, BYOL).
- Placement groups: cluster (latency thấp nhất, 1 AZ, rủi ro chung), spread (7 instance/AZ, fault isolation từng máy), partition (7 partition/AZ, cho Hadoop/Kafka/Cassandra).
- Elastic IP: public IPv4 static, mặc định 5/region, tính phí khi không gắn instance đang chạy; giải quyết "IP đổi sau stop/start" nhưng thiết kế tốt hơn thường là DNS hoặc load balancer (Chương 6, 10).
- Stop/start đổi host vật lý và public IP động; private IP giữ nguyên trong vòng đời instance; resize instance type yêu cầu stop (EBS-backed — chi tiết storage ở Chương 5).
