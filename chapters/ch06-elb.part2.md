## Hands-on Lab: Triển khai ALB với path-based routing, sticky sessions và tuning deregistration delay

**Mục tiêu lab:** Dựng một Application Load Balancer đứng trước 2 EC2 instances ở 2 AZ khác nhau, cấu hình 2 target groups, listener rules định tuyến theo path (`/api/*` vs mặc định), quan sát health check loại instance lỗi, đọc header `X-Forwarded-For`, bật sticky sessions và giảm deregistration delay — đúng các điểm DVA-C02 hay hỏi.

**Chuẩn bị:**
- AWS CLI v2 đã cấu hình (profile có quyền EC2 + ELB full access).
- Dùng default VPC cho nhanh. Region ví dụ: `ap-southeast-1`.
- Chi phí: ALB ~0.0252 USD/giờ + 2 instance t3.micro — làm xong dọn ngay, tốn dưới 0.5 USD.

### Bước 1: Tạo Security Groups

Tạo 2 SG: một cho ALB (mở 80 từ internet), một cho EC2 (chỉ nhận traffic từ SG của ALB — đây là pattern "SG referencing SG" chuẩn, không mở 80 cho cả thế giới):

```bash
VPC_ID=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text)

ALB_SG=$(aws ec2 create-security-group --group-name lab06-alb-sg \
  --description "ALB SG" --vpc-id $VPC_ID --query GroupId --output text)
aws ec2 authorize-security-group-ingress --group-id $ALB_SG \
  --protocol tcp --port 80 --cidr 0.0.0.0/0

EC2_SG=$(aws ec2 create-security-group --group-name lab06-ec2-sg \
  --description "EC2 SG" --vpc-id $VPC_ID --query GroupId --output text)
# Chỉ cho phép traffic port 80 ĐẾN TỪ security group của ALB
aws ec2 authorize-security-group-ingress --group-id $EC2_SG \
  --protocol tcp --port 80 --source-group $ALB_SG
```

### Bước 2: Khởi chạy 2 EC2 instances ở 2 AZ

User data cài web server trả về instance ID và in ra header nhận được (để soi `X-Forwarded-For`):

```bash
cat > userdata.sh <<'EOF'
#!/bin/bash
dnf install -y httpd php
ID=$(curl -s -H "X-aws-ec2-metadata-token: $(curl -sX PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')" http://169.254.169.254/latest/meta-data/instance-id)
mkdir -p /var/www/html/api
echo "<?php echo 'WEB from ' . '$ID' . ' | client: ' . \$_SERVER['HTTP_X_FORWARDED_FOR'];" > /var/www/html/index.php
echo "<?php echo 'API from ' . '$ID';" > /var/www/html/api/index.php
systemctl enable --now httpd
EOF

AMI=$(aws ssm get-parameter \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --query Parameter.Value --output text)

# Lấy 2 subnet ở 2 AZ khác nhau
SUBNETS=($(aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC_ID \
  --query 'Subnets[0:2].SubnetId' --output text))

for i in 0 1; do
  aws ec2 run-instances --image-id $AMI --instance-type t3.micro \
    --security-group-ids $EC2_SG --subnet-id ${SUBNETS[$i]} \
    --user-data file://userdata.sh \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=lab06-$i}]"
done
```

Lưu lại 2 instance ID (gọi là `$I1`, `$I2`). Chờ trạng thái `running` rồi mới sang bước 3.

### Bước 3: Tạo 2 target groups

```bash
TG_WEB=$(aws elbv2 create-target-group --name lab06-tg-web \
  --protocol HTTP --port 80 --vpc-id $VPC_ID \
  --health-check-path / --health-check-interval-seconds 10 \
  --healthy-threshold-count 2 --unhealthy-threshold-count 2 \
  --query 'TargetGroups[0].TargetGroupArn' --output text)

TG_API=$(aws elbv2 create-target-group --name lab06-tg-api \
  --protocol HTTP --port 80 --vpc-id $VPC_ID \
  --health-check-path /api/index.php \
  --query 'TargetGroups[0].TargetGroupArn' --output text)

aws elbv2 register-targets --target-group-arn $TG_WEB --targets Id=$I1 Id=$I2
aws elbv2 register-targets --target-group-arn $TG_API --targets Id=$I1 Id=$I2
```

Lưu ý: một instance đăng ký được vào nhiều target group cùng lúc — mỗi target group có health check riêng.

### Bước 4: Tạo ALB và listener mặc định

```bash
ALB_ARN=$(aws elbv2 create-load-balancer --name lab06-alb \
  --subnets ${SUBNETS[0]} ${SUBNETS[1]} --security-groups $ALB_SG \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text)

LISTENER=$(aws elbv2 create-listener --load-balancer-arn $ALB_ARN \
  --protocol HTTP --port 80 \
  --default-actions Type=forward,TargetGroupArn=$TG_WEB \
  --query 'Listeners[0].ListenerArn' --output text)

DNS=$(aws elbv2 describe-load-balancers --load-balancer-arns $ALB_ARN \
  --query 'LoadBalancers[0].DNSName' --output text)
echo $DNS
```

ALB cần tối thiểu 2 subnet ở 2 AZ khác nhau — đây là lý do ta lấy 2 subnet ở bước 2. Chờ state chuyển từ `provisioning` sang `active` (1–3 phút):

```bash
aws elbv2 describe-load-balancers --load-balancer-arns $ALB_ARN \
  --query 'LoadBalancers[0].State.Code'
```

### Bước 5: Thêm listener rule định tuyến theo path

```bash
aws elbv2 create-rule --listener-arn $LISTENER --priority 10 \
  --conditions Field=path-pattern,Values='/api/*' \
  --actions Type=forward,TargetGroupArn=$TG_API
```

Rule có priority 10 được đánh giá trước default rule (default luôn đánh giá CUỐI CÙNG). Priority nhỏ hơn = ưu tiên cao hơn.

### Bước 6: Kiểm tra routing, health check và X-Forwarded-For

```bash
for i in {1..6}; do curl -s http://$DNS/ ; echo; done
```

Output mong đợi — request luân phiên (round robin) giữa 2 instance, và thấy IP public của máy bạn trong `X-Forwarded-For` (vì ALB terminate connection, IP nguồn mà EC2 thấy là private IP của ALB node):

```
WEB from i-0abc... | client: 118.70.x.x
WEB from i-0def... | client: 118.70.x.x
```

```bash
curl -s http://$DNS/api/
# API from i-0abc...
```

Xem trạng thái health check:

```bash
aws elbv2 describe-target-health --target-group-arn $TG_WEB \
  --query 'TargetHealthDescriptions[].{Id:Target.Id,State:TargetHealth.State}'
```

Output mong đợi: cả 2 target `healthy`. Giờ giả lập sự cố — SSH/SSM vào instance 1 chạy `sudo systemctl stop httpd`, chờ ~20 giây (interval 10s × unhealthy threshold 2), chạy lại lệnh trên: instance 1 chuyển `unhealthy` với Reason `Target.FailedHealthChecks`, và `curl` lúc này chỉ trả về instance 2. Bật lại `httpd`, sau 2 lần check pass nó quay lại nhận traffic. Đây chính là cơ chế "fail open có kiểm soát" mà đề thi hay mô tả.

### Bước 7: Bật sticky sessions

```bash
aws elbv2 modify-target-group-attributes --target-group-arn $TG_WEB \
  --attributes Key=stickiness.enabled,Value=true \
    Key=stickiness.type,Value=lb_cookie \
    Key=stickiness.lb_cookie.duration_seconds,Value=120
```

Test với cookie jar:

```bash
for i in {1..5}; do curl -s -c /tmp/cj -b /tmp/cj http://$DNS/ ; echo; done
```

Output mong đợi: cả 5 request đều trả về CÙNG một instance ID. Kiểm tra cookie: `grep AWSALB /tmp/cj` — bạn sẽ thấy cookie `AWSALB` (và `AWSALBCORS`) do ALB phát hành. Nếu curl không gửi cookie (bỏ `-b`), request lại round robin như cũ — sticky session hoạt động hoàn toàn dựa trên cookie phía client.

### Bước 8: Tuning deregistration delay và quan sát draining

Mặc định deregistration delay là 300 giây — quá dài cho lab. Giảm xuống 30 giây rồi deregister 1 target:

```bash
aws elbv2 modify-target-group-attributes --target-group-arn $TG_WEB \
  --attributes Key=deregistration_delay.timeout_seconds,Value=30

aws elbv2 deregister-targets --target-group-arn $TG_WEB --targets Id=$I1
aws elbv2 describe-target-health --target-group-arn $TG_WEB \
  --query 'TargetHealthDescriptions[].{Id:Target.Id,State:TargetHealth.State}'
```

Output mong đợi: instance 1 ở trạng thái `draining` trong 30 giây — không nhận request MỚI nhưng request đang dở (in-flight) vẫn được hoàn thành — rồi biến mất khỏi danh sách. Đây là connection draining (tên cũ ở CLB) / deregistration delay (tên mới ở ALB/NLB).

### Dọn dẹp tài nguyên

Thứ tự quan trọng: xoá ALB trước, rồi target groups, rồi instances, cuối cùng là SG (SG của EC2 đang reference SG của ALB nên phải xoá sau khi cả hai không còn được dùng):

```bash
aws elbv2 delete-load-balancer --load-balancer-arn $ALB_ARN
# Chờ ~1 phút cho ALB xoá xong rồi mới xoá target group
aws elbv2 delete-target-group --target-group-arn $TG_WEB
aws elbv2 delete-target-group --target-group-arn $TG_API
aws ec2 terminate-instances --instance-ids $I1 $I2
aws ec2 wait instance-terminated --instance-ids $I1 $I2
aws ec2 delete-security-group --group-id $EC2_SG
aws ec2 delete-security-group --group-id $ALB_SG
```

Kiểm tra lại console EC2 → Load Balancers và Target Groups để chắc chắn không còn gì chạy ngầm.

## 💡 Exam Tips chương 6

- **ALB = Layer 7** (HTTP/HTTPS, routing theo path/host/header/query string), **NLB = Layer 4** (TCP/UDP/TLS, hiệu năng hàng triệu rps, latency ~100ms thấp hơn ALB ~400ms). Câu hỏi nói "HTTP routing", "microservices theo path" → ALB; nói "extreme performance", "static IP", "non-HTTP protocol" → NLB.
- Chỉ **NLB có static IP** (1 IP/AZ) và gắn được **Elastic IP**. ALB chỉ có DNS name — nếu đề yêu cầu "whitelist IP cố định cho firewall đối tác" → NLB (hoặc đặt NLB trước ALB).
- Ứng dụng cần IP thật của client sau ALB: đọc header **`X-Forwarded-For`** (kèm `X-Forwarded-Proto`, `X-Forwarded-Port`). Với NLB TCP, source IP được giữ nguyên nên không cần header.
- **Sticky sessions**: ALB dùng cookie — `AWSALB` (duration-based, do LB sinh) hoặc **application-based cookie** (app tự sinh, khai báo tên cookie). Trade-off: gây mất cân bằng tải. Đề hỏi "user bị logout khi request rơi vào instance khác" → bật stickiness, hoặc giải pháp chuẩn hơn là externalize session ra ElastiCache/DynamoDB (chi tiết ở Chương 9).
- **Cross-zone load balancing**: ALB bật mặc định và **miễn phí** liên AZ; NLB/GWLB tắt mặc định, bật thì **tốn phí** data transfer liên AZ. Câu hỏi "traffic phân bố không đều giữa các AZ có số instance lệch nhau" → bật cross-zone.
- **SNI (Server Name Indication)** cho phép một listener HTTPS phục vụ **nhiều TLS certificate** cho nhiều domain — chỉ hỗ trợ trên ALB và NLB, KHÔNG có trên CLB. Đề nói "host nhiều domain với nhiều cert trên một LB" → ALB/NLB + SNI; nếu thấy CLB trong đáp án thì câu trả lời thường là "tạo nhiều CLB" (tốn kém) hoặc migrate sang ALB.
- **SSL termination tại ALB**: ALB giải mã TLS rồi forward HTTP (hoặc re-encrypt HTTPS) tới target. Nếu yêu cầu **end-to-end encryption** mà không cần LB đọc nội dung → NLB TCP listener passthrough, cert nằm trên EC2.
- **Deregistration delay** (mặc định 300s, 0–3600s): target chuyển `draining`, ngừng nhận request mới, request in-flight được chạy nốt. Đề hỏi "deployment làm rớt request đang xử lý" → tăng/kiểm tra deregistration delay; "deregister quá lâu" → giảm xuống (set 0 nếu request ngắn).
- Health check fail phổ biến vì: SG của instance không cho phép traffic **từ SG của ALB**, sai health check path/port, app trả 3xx khi check mong 200. Matcher có thể cấu hình range, ví dụ `200-299`.
- ALB target types: **instance**, **ip** (IP private — dùng cho on-premises qua VPN/DX, hoặc ECS awsvpc), **lambda** (chỉ ALB có). NLB còn nhận **alb** làm target (chain NLB → ALB để có static IP + Layer 7 routing).
- **GWLB** = Layer 3, dùng giao thức **GENEVE port 6081**, chuyên cho chuỗi appliance bảo mật (firewall, IDS/IPS) — thấy từ khoá "inspect traffic bằng third-party virtual appliance" là chọn GWLB, đừng chọn NLB.
- ALB trả **HTTP 503** khi không còn target healthy/không có target đăng ký; **504 Gateway Timeout** khi target không phản hồi trong idle timeout — phân biệt hai mã này là dạng câu troubleshooting kinh điển.

## Quiz chương 6 (10 câu)

**Câu 1.** Một công ty chạy REST API trên nhóm EC2 instances sau load balancer. Đối tác yêu cầu cung cấp địa chỉ IP cố định để cấu hình firewall outbound của họ. Giải pháp nào phù hợp nhất?
- A. Dùng ALB và cung cấp IP resolve từ DNS name của ALB
- B. Dùng NLB, gắn Elastic IP cho mỗi AZ và cung cấp các IP này
- C. Dùng CLB với sticky sessions
- D. Đặt CloudFront trước ALB và cung cấp IP của edge location

**Câu 2.** A developer needs to... định tuyến request `https://api.example.com/orders/*` đến microservice Orders và `https://api.example.com/users/*` đến microservice Users, cả hai chạy trên cùng một fleet EC2. Cách cấu hình nào đúng?
- A. Hai NLB riêng, mỗi NLB cho một service
- B. Một ALB, hai target groups, listener rules theo path pattern
- C. Một ALB, một target group, dùng health check path khác nhau
- D. Route 53 weighted routing giữa hai CLB

**Câu 3.** Ứng dụng Node.js sau ALB ghi log địa chỉ client nhưng toàn thấy IP dạng `10.0.x.x`. Developer cần IP thật của người dùng. Giải pháp?
- A. Bật cross-zone load balancing
- B. Chuyển listener từ HTTP sang TCP
- C. Đọc header `X-Forwarded-For` trong ứng dụng
- D. Bật access logs trên ALB và query sau

**Câu 4.** Một ứng dụng lưu session trong bộ nhớ local của EC2. Sau khi đặt sau ALB, user phàn nàn bị văng đăng nhập ngẫu nhiên. Cách khắc phục NHANH nhất, ít thay đổi code nhất?
- A. Bật sticky sessions trên target group
- B. Chuyển session sang DynamoDB
- C. Tăng số lượng instance
- D. Giảm deregistration delay xuống 0

**Câu 5.** Công ty có 2 AZ: AZ-a chạy 8 instances, AZ-b chạy 2 instances sau một NLB. Team nhận thấy 2 instance ở AZ-b chịu tải cao gấp 4 lần. Nguyên nhân và cách xử lý?
- A. Health check sai port; sửa health check
- B. Cross-zone load balancing đang tắt (mặc định với NLB); bật nó lên
- C. Sticky sessions đang bật; tắt đi
- D. NLB không hỗ trợ nhiều AZ; chuyển sang ALB

**Câu 6.** A developer needs to... phục vụ nhiều website với domain khác nhau (`a.com`, `b.com`), mỗi domain một TLS certificate riêng, trên MỘT load balancer duy nhất để tiết kiệm chi phí. Giải pháp?
- A. CLB với nhiều listener HTTPS
- B. ALB với một listener HTTPS, nhiều certificate, dựa vào SNI
- C. ALB với wildcard certificate `*.com`
- D. Bắt buộc phải tạo mỗi domain một ALB

**Câu 7.** Trong quá trình rolling deployment, người dùng báo lỗi vì các request đang xử lý dở bị cắt khi instance bị gỡ khỏi target group. Thuộc tính nào cần xem xét?
- A. Health check interval
- B. Idle timeout của ALB
- C. Deregistration delay (connection draining)
- D. Stickiness duration

**Câu 8.** Một game online dùng giao thức UDP custom cần xử lý hàng triệu request/giây với độ trễ cực thấp. Load balancer nào phù hợp?
- A. ALB
- B. NLB
- C. GWLB
- D. CLB

**Câu 9.** ALB trả về HTTP 503 cho mọi request dù các EC2 instances đang chạy bình thường và ứng dụng listen trên port 80. Nguyên nhân khả dĩ nhất?
- A. ALB chưa bật cross-zone load balancing
- B. Tất cả target đều unhealthy vì security group của instance không cho phép traffic từ security group của ALB
- C. Thiếu Elastic IP trên ALB
- D. Listener đang dùng HTTPS thay vì HTTP

**Câu 10.** Công ty cần kiểm tra (inspect) toàn bộ inbound traffic bằng một virtual firewall appliance của bên thứ ba trước khi traffic đến ứng dụng. Dịch vụ nào được thiết kế cho việc này?
- A. ALB với Lambda target
- B. NLB ở chế độ TLS passthrough
- C. Gateway Load Balancer (GWLB)
- D. CloudFront với field-level encryption

### Đáp án & giải thích

**Câu 1 — Đáp án B.** NLB cung cấp 1 static IP cho mỗi AZ và cho phép gắn Elastic IP — đáp ứng yêu cầu IP cố định. A sai vì IP resolve từ DNS của ALB thay đổi theo thời gian (ALB scale node bên dưới), không bao giờ được hardcode. C sai: CLB cũng không có static IP, sticky sessions không liên quan. D sai: IP edge của CloudFront rất nhiều và thay đổi, không phù hợp để whitelist từng IP cố định.

**Câu 2 — Đáp án B.** ALB là Layer 7, hỗ trợ listener rules với path pattern (`/orders/*`, `/users/*`) forward đến target groups khác nhau — đúng pattern microservices. A sai: NLB Layer 4 không nhìn thấy URL path, và 2 LB tốn gấp đôi chi phí. C sai: health check path chỉ quyết định target healthy hay không, không định tuyến request. D sai: weighted routing chia traffic theo tỉ lệ ngẫu nhiên, không theo nội dung URL; CLB cũng không hỗ trợ path routing.

**Câu 3 — Đáp án C.** ALB terminate kết nối client nên backend thấy IP private của ALB node; IP gốc nằm trong header `X-Forwarded-For`. A sai: cross-zone chỉ ảnh hưởng phân bố traffic giữa AZ. B sai: ALB không có TCP listener (đó là NLB), và đổi kiến trúc là quá mức cần thiết. D sai: access logs giúp phân tích offline nhưng không giải quyết nhu cầu ứng dụng đọc IP lúc runtime.

**Câu 4 — Đáp án A.** Sticky sessions (lb_cookie) ghim user vào đúng instance giữ session — chỉ là một thuộc tính target group, không sửa code. B là giải pháp ĐÚNG về kiến trúc lâu dài nhưng đề hỏi "nhanh nhất, ít thay đổi code nhất" — chuyển session store đòi sửa code đáng kể. C sai: thêm instance còn làm tình hình tệ hơn. D sai: deregistration delay liên quan lúc gỡ target, không liên quan session.

**Câu 5 — Đáp án B.** NLB tắt cross-zone mặc định: mỗi AZ nhận ~50% traffic (DNS chia đều theo AZ), nên 2 instance AZ-b gánh 50% traffic → mỗi con chịu 25%, gấp ~4 lần mỗi con trong 8 con của AZ-a (6.25%). Bật cross-zone để phân đều trên 10 instance (lưu ý phí liên AZ với NLB). A sai: health check sai thì target unhealthy, không gây lệch tải kiểu này. C sai: NLB stickiness (source IP) không tạo pattern lệch đều 4 lần như vậy. D sai: NLB hỗ trợ multi-AZ bình thường.

**Câu 6 — Đáp án B.** ALB hỗ trợ gắn nhiều certificate vào một listener HTTPS; SNI cho phép client gửi hostname trong TLS handshake để ALB chọn đúng cert. A sai: CLB không hỗ trợ SNI — mỗi CLB chỉ một cert, phải tạo nhiều CLB. C sai: `*.com` không phải wildcard hợp lệ (wildcard chỉ áp dụng một cấp subdomain của MỘT domain, ví dụ `*.a.com`); `a.com` và `b.com` là hai domain khác nhau. D sai vì B đã chứng minh một ALB là đủ.

**Câu 7 — Đáp án C.** Deregistration delay cho target thời gian ở trạng thái `draining` để hoàn thành request in-flight trước khi bị gỡ. Nếu set quá thấp (hoặc 0) với các request dài, kết nối bị cắt giữa chừng. A sai: health check interval quyết định tốc độ phát hiện unhealthy, không bảo vệ request đang chạy. B sai: idle timeout đóng kết nối KHÔNG có dữ liệu, khác với việc gỡ target. D sai: stickiness liên quan định tuyến session, không liên quan draining.

**Câu 8 — Đáp án B.** NLB là lựa chọn duy nhất hỗ trợ UDP, hoạt động ở Layer 4, xử lý hàng triệu request/giây với latency cực thấp. A sai: ALB chỉ HTTP/HTTPS (TCP), không hỗ trợ UDP. C sai: GWLB dành cho traffic inspection qua appliance (GENEVE), không phải load balancing ứng dụng game. D sai: CLB legacy, không hỗ trợ UDP và hiệu năng kém hơn.

**Câu 9 — Đáp án B.** 503 từ ALB nghĩa là không có target healthy để forward. Lỗi phổ biến nhất: SG của EC2 không allow inbound từ SG của ALB nên health check fail dù app chạy tốt — "instance chạy bình thường" nhưng ALB không gọi tới được. A sai: cross-zone không gây 503 toàn bộ. C sai: ALB không dùng Elastic IP. D sai: listener HTTPS sai cấu hình thường gây lỗi TLS phía client hoặc 4xx, và đề nói rõ request đã đến được ALB.

**Câu 10 — Đáp án C.** GWLB sinh ra đúng cho use case này: hoạt động Layer 3, đóng gói traffic bằng GENEVE (port 6081) gửi qua fleet appliance bảo mật để inspect rồi trả về, kết hợp Gateway Load Balancer Endpoint. A sai: Lambda target dùng để chạy code xử lý HTTP request, không phải inspect packet. B sai: NLB passthrough chỉ chuyển tiếp TCP/TLS, không có cơ chế service chaining qua appliance. D sai: field-level encryption mã hoá field nhạy cảm ở edge, không phải traffic inspection.

## Tóm tắt chương

- ELB có 4 loại: **CLB** (legacy, tránh dùng), **ALB** (Layer 7 — HTTP/HTTPS), **NLB** (Layer 4 — TCP/UDP/TLS, hiệu năng cao), **GWLB** (Layer 3 — GENEVE 6081, security appliances).
- ALB routing theo **path, host, HTTP header, query string, source IP**; listener rules đánh giá theo priority tăng dần, default rule cuối cùng; target types: instance / ip / lambda.
- NLB có **static IP per AZ + Elastic IP**, giữ nguyên source IP của client (TCP), latency thấp hơn ALB; có thể đặt ALB làm target của NLB để có cả static IP lẫn Layer 7 routing.
- Backend sau ALB lấy thông tin client qua **`X-Forwarded-For` / `X-Forwarded-Proto` / `X-Forwarded-Port`**.
- **Health checks** cấu hình ở target group (path, port, interval, threshold, matcher như `200-299`); target unhealthy bị loại khỏi rotation cho tới khi pass đủ healthy threshold; lỗi phổ biến nhất là SG của target không allow traffic từ SG của ALB.
- **Sticky sessions**: cookie `AWSALB` (duration-based) hoặc application-based cookie; giải quyết session in-memory nhưng gây lệch tải — giải pháp chuẩn là external session store (Chương 9).
- **Cross-zone load balancing**: ALB bật sẵn và miễn phí; NLB/GWLB tắt mặc định, bật thì trả phí data transfer liên AZ — câu hỏi lệch tải giữa AZ gần như luôn xoay quanh điểm này.
- **SSL/TLS termination** tại ALB/NLB với certificate từ ACM; **SNI** cho phép nhiều cert trên một listener (ALB/NLB, không có ở CLB); cần end-to-end encryption không bị LB giải mã → NLB TCP passthrough.
- **Deregistration delay** (mặc định 300s, range 0–3600s): target ở trạng thái `draining` để hoàn thành request in-flight; tune theo độ dài request của ứng dụng.
- Troubleshooting mã lỗi: **503** = không còn target healthy/không có target; **504** = target không trả lời kịp idle timeout.
- ELB kết hợp Auto Scaling Group để tự thêm/bớt target theo tải (chi tiết ở Chương 7); ALB còn là entry point phổ biến cho ECS dynamic port mapping (Chương 17) và Lambda target (Chương 30).
