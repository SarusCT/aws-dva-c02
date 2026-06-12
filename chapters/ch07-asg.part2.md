## Hands-on Lab: ASG với Launch Template, ALB health check và Target Tracking Scaling

**Mục tiêu lab:** Tạo một Launch Template, dựng ASG gắn vào ALB target group (dùng health check ELB), cấu hình target tracking scaling theo CPU, kiểm chứng scale-out bằng stress test, quan sát instance refresh, và dọn dẹp toàn bộ. Lab này dùng AWS CLI v2 — đúng cách đề DVA-C02 mô tả thao tác.

**Chuẩn bị:**
- AWS CLI v2 đã cấu hình profile có quyền EC2, Auto Scaling, ELB, CloudWatch (chi tiết cấu hình CLI ở Chương 3).
- Một VPC default với ít nhất 2 subnet ở 2 AZ khác nhau (lab dùng default VPC cho gọn; kiến trúc VPC chi tiết ở Chương 11).
- Đã có ALB + target group từ lab Chương 6, hoặc tạo nhanh theo Bước 2 dưới đây.
- Region ví dụ: `ap-southeast-1`. Instance `t3.micro` thuộc free tier ở nhiều region.

### Bước 1: Tạo Security Group và Launch Template

Tạo security group cho phép HTTP từ ALB và lấy AMI Amazon Linux 2023 mới nhất qua SSM public parameter (luôn lấy AMI động, đừng hardcode — AMI ID khác nhau từng region):

```bash
# Lấy VPC default
VPC_ID=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true \
  --query 'Vpcs[0].VpcId' --output text)

# Security group cho instance
SG_ID=$(aws ec2 create-security-group --group-name asg-lab-sg \
  --description "ASG lab" --vpc-id $VPC_ID --query GroupId --output text)
aws ec2 authorize-security-group-ingress --group-id $SG_ID \
  --protocol tcp --port 80 --cidr 0.0.0.0/0

# AMI Amazon Linux 2023 mới nhất
AMI_ID=$(aws ssm get-parameter \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --query 'Parameter.Value' --output text)
echo $AMI_ID   # ami-0xxxxxxxxxxxx
```

User data cài web server trả về instance ID — để nhìn thấy load balancing và scaling bằng mắt:

```bash
cat > userdata.txt <<'EOF'
#!/bin/bash
dnf install -y httpd stress-ng
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
IID=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \
  http://169.254.169.254/latest/meta-data/instance-id)
echo "<h1>Hello from $IID</h1>" > /var/www/html/index.html
systemctl enable --now httpd
EOF

aws ec2 create-launch-template --launch-template-name asg-lab-lt \
  --launch-template-data "{
    \"ImageId\": \"$AMI_ID\",
    \"InstanceType\": \"t3.micro\",
    \"SecurityGroupIds\": [\"$SG_ID\"],
    \"UserData\": \"$(base64 -i userdata.txt)\",
    \"Monitoring\": {\"Enabled\": true},
    \"MetadataOptions\": {\"HttpTokens\": \"required\"}
  }"
```

Lưu ý: `Monitoring.Enabled=true` bật detailed monitoring (metric 1 phút thay vì 5 phút) — scaling phản ứng nhanh hơn; `HttpTokens=required` ép IMDSv2 (Chương 4). User data dùng IMDSv2 token đúng chuẩn.

**Output mong đợi:** JSON chứa `"LaunchTemplateId": "lt-0..."`, `"LatestVersionNumber": 1`.

### Bước 2: Tạo ALB và Target Group

```bash
SUBNETS=$(aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC_ID \
  --query 'Subnets[0:2].SubnetId' --output text)

TG_ARN=$(aws elbv2 create-target-group --name asg-lab-tg \
  --protocol HTTP --port 80 --vpc-id $VPC_ID \
  --health-check-path / --healthy-threshold-count 2 \
  --health-check-interval-seconds 10 \
  --query 'TargetGroups[0].TargetGroupArn' --output text)

ALB_ARN=$(aws elbv2 create-load-balancer --name asg-lab-alb \
  --subnets $SUBNETS --security-groups $SG_ID \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text)

aws elbv2 create-listener --load-balancer-arn $ALB_ARN \
  --protocol HTTP --port 80 \
  --default-actions Type=forward,TargetGroupArn=$TG_ARN
```

(Chi tiết ALB, listener rules ở Chương 6 — ở đây chỉ dựng tối thiểu để ASG có chỗ đăng ký target.)

### Bước 3: Tạo ASG gắn target group, health check ELB

```bash
SUBNET_LIST=$(echo $SUBNETS | tr ' \t' ',,')

aws autoscaling create-auto-scaling-group \
  --auto-scaling-group-name asg-lab \
  --launch-template LaunchTemplateName=asg-lab-lt,Version='$Latest' \
  --min-size 1 --max-size 4 --desired-capacity 2 \
  --vpc-zone-identifier "$SUBNET_LIST" \
  --target-group-arns $TG_ARN \
  --health-check-type ELB \
  --health-check-grace-period 90 \
  --default-instance-warmup 60
```

Ba điểm quan trọng:
- `--health-check-type ELB`: ASG thay thế instance khi target group báo unhealthy, không chỉ khi EC2 status check fail. Đây là cấu hình production chuẩn — nếu để mặc định `EC2`, app treo nhưng OS còn sống thì ASG KHÔNG thay instance.
- `--health-check-grace-period 90`: cho instance 90 giây boot + chạy user data trước khi tính health check, tránh terminate oan instance đang khởi động.
- `--default-instance-warmup 60`: instance mới khởi tạo 60 giây mới được tính đầy đủ vào aggregated metrics — tránh CPU thấp giả tạo của instance mới kéo average xuống làm scaling sai.

Kiểm tra:

```bash
aws autoscaling describe-auto-scaling-groups \
  --auto-scaling-group-names asg-lab \
  --query 'AutoScalingGroups[0].Instances[*].[InstanceId,LifecycleState,HealthStatus]' \
  --output table
```

**Output mong đợi:** 2 instance, `LifecycleState` chuyển `Pending` → `InService`, `HealthStatus: Healthy` sau ~2 phút. Lấy DNS của ALB và curl vài lần sẽ thấy instance ID luân phiên:

```bash
ALB_DNS=$(aws elbv2 describe-load-balancers --load-balancer-arns $ALB_ARN \
  --query 'LoadBalancers[0].DNSName' --output text)
for i in 1 2 3 4; do curl -s http://$ALB_DNS; done
# <h1>Hello from i-0aaa...</h1>
# <h1>Hello from i-0bbb...</h1>
```

### Bước 4: Gắn Target Tracking Scaling Policy theo CPU

```bash
aws autoscaling put-scaling-policy \
  --auto-scaling-group-name asg-lab \
  --policy-name cpu-target-50 \
  --policy-type TargetTrackingScaling \
  --target-tracking-configuration '{
    "PredefinedMetricSpecification": {
      "PredefinedMetricType": "ASGAverageCPUUtilization"
    },
    "TargetValue": 50.0
  }'
```

**Output mong đợi:** JSON trả về `PolicyARN` và mảng `Alarms` gồm **2 CloudWatch alarms** (`TargetTracking-...AlarmHigh` và `...AlarmLow`) — target tracking tự tạo và quản lý cặp alarm này; bạn không được sửa/xoá tay chúng. Alarm high trigger sau 3 datapoint vượt 50%, alarm low (scale-in) thận trọng hơn — mặc định 15 datapoint dưới ngưỡng, đúng triết lý "scale out nhanh, scale in chậm".

### Bước 5: Stress test để xem scale-out

SSH/Instance Connect vào một instance (hoặc dùng SSM Run Command cho sạch) và đốt CPU:

```bash
aws ssm send-command --document-name "AWS-RunShellScript" \
  --targets "Key=tag:aws:autoscaling:groupName,Values=asg-lab" \
  --parameters 'commands=["stress-ng --cpu 2 --timeout 600s &"]'
```

Theo dõi scaling activity:

```bash
aws autoscaling describe-scaling-activities \
  --auto-scaling-group-name asg-lab --max-items 5 \
  --query 'Activities[*].[StatusCode,Cause]' --output text
```

**Output mong đợi:** Sau ~3–4 phút (3 datapoint × 1 phút detailed monitoring + thời gian launch) sẽ thấy activity:
`Successful   At 2026-06-12T... a monitor alarm TargetTracking-asg-lab-AlarmHigh-... in state ALARM triggered policy cpu-target-50 changing the desired capacity from 2 to 3...`

Hết 10 phút stress, CPU tụt xuống; sau ~15 phút alarm low sẽ kéo desired về lại — quan sát thấy scale-in chậm hơn scale-out rõ rệt. Instance bị chọn terminate theo default termination policy: ưu tiên AZ có nhiều instance nhất → instance dùng launch template/version cũ nhất → instance gần giờ billing tròn nhất.

### Bước 6: Instance Refresh — rolling update khi đổi Launch Template

Sửa user data (ví dụ đổi nội dung trang) rồi tạo version mới và refresh:

```bash
aws ec2 create-launch-template-version --launch-template-name asg-lab-lt \
  --source-version 1 --launch-template-data '{"InstanceType":"t3.small"}'

aws autoscaling start-instance-refresh \
  --auto-scaling-group-name asg-lab \
  --preferences '{"MinHealthyPercentage": 50, "InstanceWarmup": 90}'
```

`MinHealthyPercentage: 50` nghĩa là tối đa 50% capacity được thay cùng lúc. Theo dõi:

```bash
aws autoscaling describe-instance-refreshes \
  --auto-scaling-group-name asg-lab \
  --query 'InstanceRefreshes[0].[Status,PercentageComplete]'
```

**Output mong đợi:** `["InProgress", 0]` → `["InProgress", 50]` → `["Successful", 100]`. ASG terminate dần instance cũ và launch instance theo `$Latest` version, ALB không downtime vì luôn còn ≥50% healthy. Nếu cần dừng giữa chừng: `cancel-instance-refresh` (chỉ dừng, không tự rollback — muốn auto rollback phải bật `"AutoRollback": true` trong preferences).

### Dọn dẹp tài nguyên

Thứ tự quan trọng — phải đưa ASG về 0 hoặc force-delete trước, nếu không instance sẽ bị recreate:

```bash
# Xoá ASG (force-delete terminate luôn instances)
aws autoscaling delete-auto-scaling-group \
  --auto-scaling-group-name asg-lab --force-delete

# Xoá ALB, target group, launch template
aws elbv2 delete-load-balancer --load-balancer-arn $ALB_ARN
sleep 30
aws elbv2 delete-target-group --target-group-arn $TG_ARN
aws ec2 delete-launch-template --launch-template-name asg-lab-lt

# Security group (đợi ENI của ALB giải phóng, có thể phải retry sau 1-2 phút)
aws ec2 delete-security-group --group-id $SG_ID
```

Kiểm tra lần cuối không còn instance chạy sót: `aws ec2 describe-instances --filters Name=instance-state-name,Values=running`.

## 💡 Exam Tips chương 7

- **Launch Configuration là legacy, Launch Template là chuẩn**: template hỗ trợ versioning, mixed instances (Spot + On-Demand), nhiều instance type, kế thừa. Đề hỏi "best practice tạo ASG" → Launch Template.
- **Target tracking** là đáp án mặc định cho yêu cầu "simplest / least effort để giữ CPU ~X%" — bạn chỉ đặt target value, AWS tự tạo và quản lý cặp CloudWatch alarms.
- **Step scaling vs simple scaling**: simple phải đợi cooldown xong mới phản ứng tiếp; step scaling phản ứng tiếp ngay cả khi đang scale và có nhiều bậc theo mức độ vi phạm. Yêu cầu "phản ứng theo nhiều mức breach" → step scaling.
- **Scheduled scaling** cho traffic dự đoán được theo lịch (9h sáng thứ Hai); **predictive scaling** dùng ML học pattern lịch sử (cần tối thiểu 24h dữ liệu, dùng tốt với pattern lặp lại) để scale TRƯỚC khi load đến.
- Metric scaling tốt phải tỉ lệ thuận với mỗi instance: `ASGAverageCPUUtilization`, `ALBRequestCountPerTarget`, average NetworkIn/Out, hoặc custom metric (ví dụ SQS queue depth ÷ số instance — backlog per instance, chi tiết ở Chương 21). Metric tổng (tổng request toàn ALB) không dùng trực tiếp cho target tracking được.
- **Default cooldown 300 giây** áp dụng cho simple scaling; target tracking/step scaling dùng **instance warmup** thay cho cooldown. "Scale liên tục launch thừa instance" → tăng cooldown/warmup.
- **Health check type ELB**: mặc định ASG chỉ dùng EC2 status check. Câu "app trả 500 nhưng ASG không thay instance" → bật health check type ELB. Nhớ kèm **health check grace period** để không giết instance đang boot.
- **Lifecycle hooks**: `autoscaling:EC2_INSTANCE_LAUNCHING` (cài đặt/warm-up trước khi InService) và `autoscaling:EC2_INSTANCE_TERMINATING` (copy log, drain connection trước khi terminate). Instance ở trạng thái `Pending:Wait`/`Terminating:Wait`, default timeout hook là 3600 giây (max 48 giờ), hoàn tất bằng `complete-lifecycle-action` hoặc heartbeat để gia hạn. Thông báo qua EventBridge/SNS/SQS.
- **Default termination policy**: chọn AZ nhiều instance nhất để cân bằng → instance dùng launch configuration/template version cũ nhất → instance gần billing hour kế tiếp. "Cần giữ instance X không bị terminate" → bật **instance scale-in protection**.
- **Instance refresh** là cách rolling-replace toàn bộ instance khi đổi AMI/launch template version; điều khiển bằng `MinHealthyPercentage` + `InstanceWarmup`, hỗ trợ checkpoint, skip matching và auto rollback khi kết hợp CloudWatch alarms.
- ASG **rebalance AZ** tự động: nếu một AZ lệch, ASG launch trước ở AZ thiếu rồi mới terminate ở AZ thừa (có thể tạm vượt desired capacity tới 10%).
- Đặt **desired = min = max** là cách "pin" capacity (tắt scaling tạm thời) — hoặc suspend process `Launch`/`Terminate`/`AlarmNotification` khi troubleshoot.

## Quiz chương 7 (10 câu)

**Câu 1.** A developer needs to giữ CPU trung bình của fleet quanh mức 40% với ít công sức cấu hình nhất. Giải pháp nào phù hợp?
- A. Simple scaling policy với 2 CloudWatch alarm tự tạo
- B. Step scaling policy với 3 bậc điều chỉnh
- C. Target tracking scaling policy, predefined metric ASGAverageCPUUtilization, target 40
- D. Scheduled action chạy mỗi 5 phút kiểm tra CPU

**Câu 2.** Ứng dụng web sau ALB bị treo (trả HTTP 500) nhưng instance vẫn pass EC2 status checks nên ASG không thay thế. Cách khắc phục?
- A. Giảm health check grace period về 0
- B. Đổi health check type của ASG sang ELB
- C. Tăng desired capacity để bù instance hỏng
- D. Thêm lifecycle hook EC2_INSTANCE_TERMINATING

**Câu 3.** Mỗi sáng thứ Hai 8h00, traffic tăng vọt theo lịch cố định. Developer muốn capacity sẵn sàng TRƯỚC giờ đó với cấu hình đơn giản nhất. Chọn gì?
- A. Target tracking theo request count
- B. Scheduled action tăng desired capacity lúc 7h45 thứ Hai
- C. Step scaling với ngưỡng thấp
- D. Tăng min size cố định cả tuần

**Câu 4.** ASG scale-out xong lại scale-out tiếp ngay vì instance mới chưa kịp nhận tải, CPU trung bình vẫn cao giả tạo, dẫn đến launch thừa instance. Tham số nào cần điều chỉnh?
- A. Health check grace period
- B. Deregistration delay trên target group
- C. Instance warmup / cooldown của scaling policy
- D. Max size của ASG

**Câu 5.** Trước khi instance bị terminate lúc scale-in, developer cần upload log files lên S3. Giải pháp đúng?
- A. Cấu hình termination policy OldestInstance
- B. Lifecycle hook EC2_INSTANCE_TERMINATING, hoàn tất bằng complete-lifecycle-action sau khi upload
- C. Bật instance scale-in protection cho mọi instance
- D. Dùng user data script chạy lúc shutdown

**Câu 6.** Team vừa build AMI mới và cập nhật launch template version. Cách triển khai AMI mới cho toàn bộ instance trong ASG mà vẫn duy trì tối thiểu 90% capacity?
- A. Terminate thủ công từng instance để ASG launch lại
- B. Tạo ASG mới và chuyển DNS
- C. Start instance refresh với MinHealthyPercentage = 90
- D. Đặt desired capacity = 0 rồi tăng lại

**Câu 7.** Một ASG (min 2, max 10, desired 4) trải trên AZ-a (3 instance) và AZ-b (1 instance). Khi scale-in 1 instance với default termination policy, ASG ưu tiên điều gì ĐẦU TIÊN?
- A. Instance có CPU thấp nhất
- B. Instance trong AZ có nhiều instance nhất (AZ-a)
- C. Instance launch sớm nhất bất kể AZ
- D. Instance gần billing hour nhất bất kể AZ

**Câu 8.** Developer muốn scale theo số request mà mỗi instance đang phục vụ sau ALB. Predefined metric nào dùng cho target tracking?
- A. RequestCount của ALB
- B. ALBRequestCountPerTarget
- C. HealthyHostCount
- D. ASGAverageNetworkIn

**Câu 9.** Một worker fleet xử lý job nặng; khi scale-in, ASG hay terminate đúng instance đang chạy job dài. Cách bảo vệ instance đang xử lý job với thay đổi ít nhất?
- A. Đặt termination policy NewestInstance
- B. Instance tự gọi set-instance-protection bật scale-in protection khi bắt đầu job, tắt khi xong
- C. Tăng health check grace period lên 48 giờ
- D. Suspend process Terminate vĩnh viễn

**Câu 10.** Công ty cần ASG chạy hỗn hợp Spot + On-Demand với nhiều instance type để tối ưu chi phí. Yêu cầu tiên quyết nào đúng?
- A. Phải dùng Launch Configuration vì hỗ trợ Spot
- B. Phải dùng Launch Template với mixed instances policy
- C. Phải tạo 2 ASG riêng cho Spot và On-Demand
- D. Phải dùng predictive scaling

### Đáp án & giải thích

**Câu 1 — Đáp án C.** Target tracking đúng nghĩa "giữ metric quanh một giá trị" và là lựa chọn ít công sức nhất: chỉ khai báo metric + target value, AWS tự tạo/quản lý cặp alarm. A sai vì simple scaling bắt bạn tự tạo alarm, tự định nghĩa adjustment, và phản ứng kém (cooldown cứng). B sai vì step scaling cấu hình phức tạp hơn hẳn (nhiều bậc, ngưỡng) — thừa so với yêu cầu. D sai vì scheduled action chạy theo lịch, không phản ứng theo metric, "mỗi 5 phút kiểm tra CPU" không phải cơ chế của scheduled scaling.

**Câu 2 — Đáp án B.** Mặc định ASG health check type là EC2 (chỉ xem status checks ở mức hypervisor/OS) nên app-level failure không bị phát hiện. Đổi sang ELB để ASG coi instance fail target group health check là Unhealthy và thay thế. A sai vì grace period chỉ là khoảng "miễn trừ" lúc boot, giảm về 0 không giúp phát hiện lỗi app, còn dễ giết oan instance đang khởi động. C sai vì tăng desired chỉ thêm máy, instance hỏng vẫn nhận... không, vẫn tồn tại và không được thay — không xử lý gốc rễ. D sai vì lifecycle hook TERMINATING chạy KHI instance bị terminate, không giúp phát hiện instance lỗi.

**Câu 3 — Đáp án B.** Traffic theo lịch cố định, biết trước → scheduled action là cơ chế đơn giản nhất, đặt desired/min tăng lúc 7h45 (trước giờ peak để instance kịp warm-up). A sai vì target tracking là reactive — chỉ scale SAU khi request tăng, có độ trễ vài phút (datapoints + launch time). C sai cùng lý do reactive và cấu hình phức tạp hơn. D sai vì tăng min cả tuần lãng phí chi phí cho 6 ngày còn lại.

**Câu 4 — Đáp án C.** Đây là triệu chứng kinh điển của thiếu warmup/cooldown: scaling policy đánh giá metric khi instance mới chưa nhận tải, thấy CPU trung bình vẫn cao nên tiếp tục launch. Tăng instance warmup (target tracking/step) hoặc cooldown (simple) để chờ instance mới ổn định trước khi đánh giá tiếp. A sai vì grace period thuộc health check, không ảnh hưởng quyết định scaling. B sai vì deregistration delay liên quan connection draining lúc bỏ target khỏi ALB (Chương 6), không liên quan scale-out. D sai vì giảm/tăng max chỉ chặn trần, không sửa hành vi scale thừa.

**Câu 5 — Đáp án B.** Lifecycle hook TERMINATING đưa instance vào `Terminating:Wait`, phát event qua EventBridge/SNS/SQS, script upload log rồi gọi `complete-lifecycle-action --lifecycle-action-result CONTINUE`. Đây chính là use case sách giáo khoa của lifecycle hooks. A sai vì termination policy chỉ chọn instance NÀO bị terminate, không tạo khoảng thời gian xử lý. C sai vì scale-in protection chặn vĩnh viễn việc terminate — instance không bao giờ bị thu hồi, sai mục đích. D không tin cậy: ASG terminate không đảm bảo shutdown script đủ thời gian chạy và không có cơ chế xác nhận.

**Câu 6 — Đáp án C.** Instance refresh là tính năng được sinh ra đúng cho việc này: rolling replacement theo launch template version mới, `MinHealthyPercentage=90` đảm bảo luôn còn ≥90% capacity healthy trong quá trình thay. A sai vì thủ công, dễ lỗi, không kiểm soát được tỉ lệ healthy. B là blue/green ở mức hạ tầng — làm được nhưng tốn công và chi phí gấp đôi, không phải "ít công sức nhất" và câu hỏi yêu cầu thay trong ASG hiện có. D sai vì desired = 0 gây downtime toàn phần.

**Câu 7 — Đáp án B.** Default termination policy bước đầu tiên luôn là chọn AZ có nhiều instance nhất để giữ cân bằng giữa các AZ; sau đó mới xét launch template/configuration cũ nhất, rồi đến gần billing hour. C và D sai vì các tiêu chí đó chỉ được xét SAU bước chọn AZ. A sai vì ASG không bao giờ dựa trên CPU của từng instance để chọn nạn nhân terminate.

**Câu 8 — Đáp án B.** `ALBRequestCountPerTarget` là predefined metric của target tracking, tính số request chia đều cho mỗi target — đúng tính chất "tỉ lệ theo instance" mà target tracking cần (phải chỉ định ResourceLabel trỏ tới ALB + target group). A sai vì RequestCount là tổng toàn ALB, thêm instance không làm metric giảm theo cách tuyến tính chuẩn, không phải predefined metric cho ASG target tracking. C sai vì HealthyHostCount đo số target khoẻ, không phản ánh tải. D sai vì NetworkIn không liên quan yêu cầu "số request mỗi instance".

**Câu 9 — Đáp án B.** Instance scale-in protection có thể bật/tắt động từng instance qua API `set-instance-protection` — worker bật khi nhận job, tắt khi xong; ASG sẽ chọn instance khác khi scale-in. Đây là pattern chuẩn cho worker fleet (thường kết hợp SQS — Chương 21). A sai vì NewestInstance chỉ đổi thứ tự chọn, instance đang chạy job vẫn có thể bị giết. C sai vì grace period thuộc health check, không liên quan terminate khi scale-in (và max cũng không phải 48h cho mục đích này). D sai vì suspend Terminate chặn cả việc thay instance unhealthy và scale-in hợp lệ — phá hoạt động bình thường của ASG.

**Câu 10 — Đáp án B.** Mixed instances policy (nhiều instance type, phân bổ Spot/On-Demand theo tỉ lệ, allocation strategies) CHỈ hỗ trợ với Launch Template — đây là một lý do chính AWS đẩy mọi người bỏ Launch Configuration. A sai ngược hoàn toàn: Launch Configuration là legacy, không hỗ trợ mixed instances. C sai vì một ASG duy nhất quản lý được hỗn hợp Spot + On-Demand, tách 2 ASG làm phức tạp routing và scaling. D sai vì predictive scaling là chuyện scaling policy, không liên quan purchasing options.

## Tóm tắt chương

- ASG duy trì số instance giữa **min/max/desired**, tự thay instance unhealthy và phân bổ cân bằng giữa các AZ (tự rebalance khi lệch).
- **Launch Template** thay thế Launch Configuration: có versioning (`$Latest`/`$Default`/số cụ thể), hỗ trợ mixed instances policy (Spot + On-Demand, nhiều instance type) — luôn là đáp án best practice.
- Bốn loại scaling policy: **target tracking** (giữ metric quanh target, đơn giản nhất, AWS tự quản alarm), **step/simple scaling** (gắn alarm tự tạo; step có nhiều bậc và không bị khoá cứng bởi cooldown như simple), **scheduled** (lịch biết trước), **predictive** (ML dự báo theo pattern lịch sử, scale trước khi tải đến).
- Metric tốt cho scaling phải tỉ lệ theo từng instance: CPU trung bình, `ALBRequestCountPerTarget`, custom metric kiểu backlog-per-instance; metric tổng toàn hệ thống không dùng trực tiếp được.
- **Cooldown** (mặc định 300s, simple scaling) và **instance warmup** (target tracking/step/instance refresh) ngăn scaling phản ứng dây chuyền khi instance mới chưa nhận tải.
- **Health check type ELB** + **grace period** là combo bắt buộc nhớ: phát hiện lỗi tầng ứng dụng qua target group, nhưng miễn trừ giai đoạn boot.
- **Lifecycle hooks** chèn trạng thái chờ `Pending:Wait`/`Terminating:Wait` để chạy việc trước khi InService hoặc trước khi terminate; hoàn tất bằng `complete-lifecycle-action`, gia hạn bằng heartbeat, notify qua EventBridge/SNS/SQS.
- **Default termination policy** theo thứ tự: AZ nhiều instance nhất → launch template/config cũ nhất → gần billing hour; muốn miễn terminate cho instance cụ thể dùng **scale-in protection** (bật/tắt động được).
- **Instance refresh** rolling-replace toàn fleet theo template version mới, điều khiển bằng `MinHealthyPercentage` + `InstanceWarmup`, hỗ trợ cancel, checkpoint và auto rollback theo alarm.
- Scale-out nhanh, scale-in chậm là hành vi mặc định của target tracking (alarm low cần nhiều datapoint hơn) — đây là chủ đích thiết kế, không phải bug.
- ASG miễn phí — chỉ trả tiền EC2/EBS bên dưới; pin capacity bằng min=max=desired hoặc suspend processes khi cần "đóng băng" để troubleshoot.
- ASG + ALB: gắn target group vào ASG để instance tự đăng ký/huỷ đăng ký; deregistration delay của ALB (Chương 6) và lifecycle hook TERMINATING phối hợp cho graceful shutdown.
