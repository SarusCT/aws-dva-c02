# Chương 7: Auto Scaling Groups (ASG)

> **Trọng tâm DVA-C02:** ASG xuất hiện trong đề ở các câu hỏi về chọn scaling policy đúng cho tình huống (target tracking vs step vs scheduled vs predictive), xử lý instance bị ALB báo unhealthy, dùng lifecycle hooks để chạy script trước khi instance bị terminate, và scale theo custom metric. Đây là chủ đề thuộc cả domain Deployment lẫn Troubleshooting & Optimization — câu hỏi thường ở dạng tình huống "ứng dụng bị quá tải vào 9h sáng mỗi ngày, developer nên làm gì?".

## Mục tiêu chương

- Hiểu cơ chế hoạt động của ASG: min/max/desired capacity, cách ASG quyết định launch/terminate instance.
- Viết và quản lý Launch Templates (và biết vì sao Launch Configurations đã bị thay thế).
- Chọn đúng scaling policy cho từng tình huống: target tracking, simple/step, scheduled, predictive.
- Cấu hình scaling dựa trên CloudWatch metrics: CPU, ALBRequestCountPerTarget, custom metrics.
- Nắm cooldown, instance warmup, termination policies và scale-in protection.
- Dùng lifecycle hooks để can thiệp vào quá trình launch/terminate, và instance refresh để rolling update cả fleet.

## 7.1 ASG là gì và cơ chế hoạt động bên dưới

Auto Scaling Group là một logical group các EC2 instances được AWS quản lý số lượng tự động. Bản thân ASG **miễn phí** — bạn chỉ trả tiền cho EC2 instances (và EBS, data transfer...) mà nó tạo ra.

ASG hoạt động dựa trên 3 con số:

| Thuộc tính | Ý nghĩa | Ai thay đổi nó |
|---|---|---|
| `MinSize` | Số instance tối thiểu luôn chạy | Bạn (cấu hình) |
| `MaxSize` | Trần số instance — scaling không bao giờ vượt | Bạn (cấu hình) |
| `DesiredCapacity` | Số instance ASG **đang cố duy trì** tại thời điểm hiện tại | Scaling policies, scheduled actions, hoặc bạn set tay |

Ràng buộc luôn đúng: `MinSize ≤ DesiredCapacity ≤ MaxSize`. Mọi scaling policy về bản chất chỉ làm một việc: **thay đổi DesiredCapacity**. Sau đó vòng lặp điều khiển (control loop) của ASG so sánh số instance healthy hiện có với DesiredCapacity:

- Thiếu → launch instance mới từ Launch Template, chọn AZ sao cho phân bố đều (AZ rebalancing).
- Thừa → terminate instance theo termination policy (xem 7.7).
- Instance bị đánh dấu unhealthy → terminate rồi launch instance **mới** thay thế (ASG không bao giờ "sửa" hay reboot instance hỏng — luôn thay mới).

Điểm quan trọng nhiều người mới hiểu sai: ASG là **declarative**. Bạn không ra lệnh "thêm 2 instance", mà scaling policy thay đổi desired capacity, rồi ASG tự hội tụ về trạng thái đó. Nếu bạn terminate tay một instance thuộc ASG (qua console EC2), ASG sẽ phát hiện thiếu so với desired và lập tức launch instance mới — đây là câu hỏi kinh điển: *"Developer terminate instance nhưng nó cứ xuất hiện lại"* → vì instance thuộc ASG.

ASG trải instance qua nhiều AZ (bạn chỉ định danh sách subnets). Khi một AZ gặp sự cố, ASG launch bù ở AZ khác — đây là lý do ASG + ALB (Chương 6) là pattern chuẩn cho high availability.

```bash
# Tạo ASG bằng AWS CLI v2
aws autoscaling create-auto-scaling-group \
  --auto-scaling-group-name web-asg \
  --launch-template "LaunchTemplateName=web-lt,Version=\$Latest" \
  --min-size 2 --max-size 10 --desired-capacity 2 \
  --vpc-zone-identifier "subnet-aaa111,subnet-bbb222" \
  --target-group-arns arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:targetgroup/web-tg/abc123 \
  --health-check-type ELB \
  --health-check-grace-period 120 \
  --tags "Key=Env,Value=prod,PropagateAtLaunch=true"
```

Lưu ý `PropagateAtLaunch=true`: tag chỉ tự gắn lên instance mới nếu bật flag này.

> 💡 **Exam Tip:** ASG tự thay thế instance unhealthy bằng instance MỚI — không bao giờ restart instance cũ. Và nếu câu hỏi nói "instance bị terminate nhưng lại tự xuất hiện", đáp án gần như chắc chắn liên quan đến ASG đang duy trì desired capacity.

## 7.2 Launch Templates (và vì sao Launch Configurations đã chết)

Launch Template (LT) là "bản thiết kế" instance: AMI ID, instance type, key pair, security groups, EBS mapping, User Data, IAM instance profile, IMDSv2 settings... Khi ASG cần launch, nó đọc LT.

Trước đây có **Launch Configuration (LC)** — bạn vẫn gặp trong đề vì AWS hỏi so sánh:

| | Launch Configuration (legacy) | Launch Template (dùng cái này) |
|---|---|---|
| Versioning | Không — immutable, muốn sửa phải tạo LC mới | Có — mỗi lần sửa tạo version mới, ASG trỏ vào `$Latest`, `$Default` hoặc số version cụ thể |
| Nhiều instance type / mixed instances | Không | Có (mixed instances policy: trộn On-Demand + Spot, nhiều instance types) |
| Spot + On-Demand cùng group | Không | Có |
| Dùng ngoài ASG (RunInstances trực tiếp) | Không | Có |
| Tính năng EC2 mới (T2/T3 Unlimited, Dedicated Hosts, EFA...) | Không hỗ trợ | Hỗ trợ đầy đủ |
| Trạng thái | Deprecated — AWS đã ngừng cho tạo mới trên account mới | Khuyến nghị chính thức |

```bash
# Tạo Launch Template
aws ec2 create-launch-template \
  --launch-template-name web-lt \
  --launch-template-data '{
    "ImageId": "ami-0abcdef1234567890",
    "InstanceType": "t3.small",
    "SecurityGroupIds": ["sg-0123456789abcdef0"],
    "IamInstanceProfile": {"Name": "web-instance-profile"},
    "MetadataOptions": {"HttpTokens": "required"},
    "UserData": "IyEvYmluL2Jhc2gKc3lzdGVtY3RsIHN0YXJ0IG5naW54Cg=="
  }'

# Sửa = tạo version mới (version cũ vẫn giữ nguyên)
aws ec2 create-launch-template-version \
  --launch-template-name web-lt \
  --source-version 1 \
  --launch-template-data '{"InstanceType": "t3.medium"}'
```

Cơ chế version rất quan trọng cho thực tế: khi deploy AMI mới, bạn tạo LT version mới rồi chạy **instance refresh** (7.8) — không cần tạo ASG mới. Nếu ASG trỏ `$Latest`, instance mới launch sẽ tự dùng version mới nhất; nếu trỏ version số cụ thể, bạn kiểm soát chặt hơn (khuyến nghị cho production để tránh ai đó tạo version lỗi và ASG tự ăn ngay).

Một bẫy thực tế: User Data trong LT phải **base64-encoded** khi gọi API trực tiếp (CLI `create-launch-template` với JSON), nhưng console tự encode cho bạn. Script User Data chỉ chạy **một lần lúc first boot** — instance do ASG scale ra sau này đều chạy User Data, nhưng instance đang sống không bao giờ chạy lại khi bạn đổi LT (chi tiết User Data ở Chương 4).

> 💡 **Exam Tip:** Câu hỏi "cần ASG trộn Spot và On-Demand instances với nhiều instance types để tối ưu chi phí" → bắt buộc Launch Template (mixed instances policy), Launch Configuration không làm được. "Cần update AMI cho ASG" → tạo Launch Template version mới + instance refresh.

## 7.3 Health checks: EC2 vs ELB, và pattern ASG + ALB

ASG quyết định một instance healthy hay không qua `HealthCheckType`:

- **EC2 (mặc định):** dựa trên EC2 status checks (system + instance status). Chỉ phát hiện vấn đề hạ tầng/OS — instance treo kernel, host hỏng. **Không biết gì về ứng dụng**: nginx chết nhưng OS vẫn chạy → ASG vẫn coi là healthy.
- **ELB:** ASG dùng thêm kết quả health check của target group (HTTP GET /health trả 200 — cấu hình ở Chương 6). Instance fail ELB health check → ASG đánh dấu unhealthy → terminate và thay thế.

Đây là pattern chuẩn production: **ASG attach vào target group của ALB + HealthCheckType=ELB**. Khi đó luồng đầy đủ:

1. ALB health check fail → target chuyển `unhealthy` → ALB ngừng route traffic tới nó.
2. ASG (vì health check type ELB) thấy instance unhealthy → set instance state `Unhealthy`.
3. ASG terminate instance (ALB drain connections theo deregistration delay — Chương 6) và launch instance mới.
4. Instance mới pass health check → nhận traffic.

Tham số đi kèm cực hay bị quên: **health check grace period** (mặc định **300 giây**). Trong khoảng này sau khi instance vào trạng thái `InService`, ASG bỏ qua kết quả health check — để app có thời gian boot. Nếu app khởi động 4 phút mà grace period để 60 giây, ASG sẽ giết instance trước khi nó kịp sống → vòng lặp launch–terminate vô tận, tiền bay và service không bao giờ lên. Đây là một troubleshooting scenario có thật trong đề lẫn production.

```bash
# Bật ELB health check cho ASG đang chạy
aws autoscaling update-auto-scaling-group \
  --auto-scaling-group-name web-asg \
  --health-check-type ELB \
  --health-check-grace-period 300

# Tự tay đánh dấu instance unhealthy (test cơ chế thay thế)
aws autoscaling set-instance-health \
  --instance-id i-0abc123 --health-status Unhealthy
```

> 💡 **Exam Tip:** "ALB báo instance unhealthy nhưng ASG không thay thế nó" → vì HealthCheckType vẫn là EC2 (mặc định). Đổi sang ELB. Ngược lại, "ASG liên tục terminate instance mới launch" → health check grace period quá ngắn so với thời gian boot của app.

## 7.4 Dynamic scaling policies: target tracking, simple và step

### Target tracking — lựa chọn mặc định

Target tracking hoạt động như cái điều hoà nhiệt độ: bạn đặt giá trị đích cho một metric, ASG tự tính cần bao nhiêu instance để giữ metric quanh giá trị đó. AWS **tự tạo và quản lý 2 CloudWatch alarms** (scale-out và scale-in) — bạn không đụng vào chúng (xoá tay alarm này là policy hỏng).

Predefined metrics hỗ trợ:

| Predefined metric | Ý nghĩa |
|---|---|
| `ASGAverageCPUUtilization` | CPU trung bình của cả group |
| `ASGAverageNetworkIn` / `ASGAverageNetworkOut` | Bytes vào/ra trung bình |
| `ALBRequestCountPerTarget` | Số request ALB chia cho mỗi target — metric "đúng nghĩa tải" nhất cho web app |

```bash
# Target tracking: giữ CPU trung bình ở 50%
aws autoscaling put-scaling-policy \
  --auto-scaling-group-name web-asg \
  --policy-name cpu-50 \
  --policy-type TargetTrackingScaling \
  --target-tracking-configuration '{
    "PredefinedMetricSpecification": {
      "PredefinedMetricType": "ASGAverageCPUUtilization"
    },
    "TargetValue": 50.0
  }'
```

Với `ALBRequestCountPerTarget` phải chỉ định `ResourceLabel` (định danh ALB + target group):

```bash
aws autoscaling put-scaling-policy \
  --auto-scaling-group-name web-asg \
  --policy-name rps-per-target \
  --policy-type TargetTrackingScaling \
  --target-tracking-configuration '{
    "PredefinedMetricSpecification": {
      "PredefinedMetricType": "ALBRequestCountPerTarget",
      "ResourceLabel": "app/web-alb/50dc6c495c0c9188/targetgroup/web-tg/943f017f100becff"
    },
    "TargetValue": 1000.0
  }'
```

Đặc tính cần nhớ: target tracking scale-out **nhanh và mạnh** khi metric vượt đích, nhưng scale-in **từ tốn** (chủ đích, để tránh flapping). Bạn có thể đặt `"DisableScaleIn": true` để policy chỉ scale out, còn scale in do bạn tự quản (ví dụ bằng scheduled action). Metric dùng cho target tracking phải **tỷ lệ nghịch với số instance** — thêm instance thì metric trung bình phải giảm. CPU, request per target đạt điều kiện này; còn ví dụ số user đăng nhập toàn hệ thống thì không (thêm instance không làm giảm số user) → target tracking sẽ hành xử sai.

### Simple scaling và step scaling

Cả hai đều gắn vào một **CloudWatch alarm do bạn tạo**, khác target tracking ở chỗ bạn kiểm soát toàn bộ.

- **Simple scaling:** alarm trigger → thực hiện MỘT điều chỉnh (ví dụ +1 instance) → **chờ hết cooldown** mới nhận tiếp bất kỳ scaling activity nào. Cơ chế cổ nhất, phản ứng chậm.
- **Step scaling:** định nghĩa nhiều bậc theo mức độ vi phạm alarm — vi phạm càng nặng, điều chỉnh càng lớn. Không bị khoá bởi cooldown; tiếp tục phản ứng kể cả khi đang có scaling activity chạy.

```bash
# Step scaling: CPU 70-85% thêm 1, trên 85% thêm 3
aws autoscaling put-scaling-policy \
  --auto-scaling-group-name web-asg \
  --policy-name cpu-step-out \
  --policy-type StepScaling \
  --adjustment-type ChangeInCapacity \
  --metric-aggregation-type Average \
  --step-adjustments \
    "MetricIntervalLowerBound=0,MetricIntervalUpperBound=15,ScalingAdjustment=1" \
    "MetricIntervalLowerBound=15,ScalingAdjustment=3"
# (Bounds tính tương đối so với threshold alarm = 70)
```

`AdjustmentType` có 3 kiểu: `ChangeInCapacity` (±n instance), `PercentChangeInCapacity` (±n%), `ExactCapacity` (set thẳng desired).

| | Target tracking | Step scaling | Simple scaling |
|---|---|---|---|
| Ai tạo alarm | AWS tự tạo | Bạn | Bạn |
| Độ phức tạp cấu hình | Thấp nhất | Trung bình | Thấp |
| Phản ứng theo mức độ vi phạm | Tự động | Có (nhiều bậc) | Không (1 bậc) |
| Bị cooldown khoá | Không (dùng warmup) | Không (dùng warmup) | Có |
| Khi nào dùng | Mặc định cho hầu hết case | Cần kiểm soát chi tiết từng ngưỡng | Legacy, hiếm khi nên chọn |

> 💡 **Exam Tip:** "Least effort / simplest way to keep average CPU at X%" → **target tracking**. "Scale với mức độ khác nhau tuỳ ngưỡng metric" → **step scaling**. Đề thích đưa simple scaling làm distractor — gần như không bao giờ là đáp án đúng cho yêu cầu mới.

## 7.5 Scheduled và predictive scaling

### Scheduled scaling

Khi tải **biết trước theo lịch** (batch job 9h sáng, flash sale 20h thứ Sáu), đừng đợi metric tăng rồi mới scale — đặt lịch thay đổi min/max/desired:

```bash
# Mỗi ngày 8:45 sáng giờ VN nâng sẵn capacity trước giờ cao điểm 9h
aws autoscaling put-scheduled-update-group-action \
  --auto-scaling-group-name web-asg \
  --scheduled-action-name morning-rush \
  --recurrence "45 8 * * *" \
  --time-zone "Asia/Ho_Chi_Minh" \
  --min-size 4 --max-size 20 --desired-capacity 8

# Hạ về đêm
aws autoscaling put-scheduled-update-group-action \
  --auto-scaling-group-name web-asg \
  --scheduled-action-name night-scale-down \
  --recurrence "0 22 * * *" \
  --time-zone "Asia/Ho_Chi_Minh" \
  --min-size 2 --max-size 10 --desired-capacity 2
```

Scheduled action **kết hợp được** với dynamic policy: lịch nâng min-size lên 4, target tracking vẫn tiếp tục scale từ 4 lên cao hơn nếu tải vượt dự kiến. Cron trong recurrence là UTC nếu không khai `--time-zone` — bẫy lệch 7 tiếng kinh điển với giờ Việt Nam.

### Predictive scaling

Predictive scaling dùng machine learning phân tích lịch sử metric (cần **tối thiểu 24 giờ dữ liệu**, học tốt nhất trên dữ liệu 14 ngày) để **dự báo tải 48 giờ tới** và launch instance **trước** khi tải đến. Phù hợp tải có chu kỳ lặp (daily/weekly pattern) nhưng giờ giấc không cố định tuyệt đối để đặt cron cứng.

Hai chế độ:
- `ForecastOnly` — chỉ dự báo, không hành động (để bạn quan sát độ chính xác trước).
- `ForecastAndScale` — dự báo và scale thật.

Predictive scaling **chỉ scale out** theo dự báo; scale in vẫn do dynamic policy đảm nhiệm. Nên chạy kèm target tracking làm lưới an toàn cho tải đột biến ngoài dự báo.

| Tình huống trong đề | Policy đúng |
|---|---|
| Giữ CPU/RPS quanh một giá trị | Target tracking |
| Ngưỡng vi phạm khác nhau → hành động khác nhau | Step scaling |
| Tải tăng đúng giờ cố định, biết trước | Scheduled |
| Tải lặp theo chu kỳ, muốn scale TRƯỚC bằng ML | Predictive |
| Scale theo độ sâu SQS queue | Target tracking trên custom metric backlog-per-instance (chi tiết ở Chương 21) |

## 7.6 Scale theo CloudWatch metrics — kể cả custom metric

Mọi dynamic scaling đều đứng trên CloudWatch (chi tiết về metrics/alarms ở Chương 24). Vài điểm developer cần nắm chắc:

**CPUUtilization mặc định là 5-minute metric.** EC2 basic monitoring gửi metric mỗi 5 phút — scaling phản ứng chậm. Bật **detailed monitoring** (1 phút, tốn phí) trên Launch Template để scaling nhạy hơn:

```json
{"Monitoring": {"Enabled": true}}
```

**CPU không phải lúc nào cũng là proxy tốt cho tải.** App Node.js gọi API ngoài và chờ I/O có thể nghẽn ở 30% CPU. Với web app sau ALB, `ALBRequestCountPerTarget` thường phản ánh tải thật hơn. Với worker, độ sâu queue mới là tải thật.

**Custom metric:** khi metric có sẵn không đủ (số connection WebSocket đang mở, độ trễ xử lý job...), app tự đẩy metric bằng `PutMetricData` rồi target tracking trỏ vào `CustomizedMetricSpecification`:

```javascript
// AWS SDK for JavaScript v3 — app tự publish custom metric
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";

const cw = new CloudWatchClient({ region: "ap-southeast-1" });

// Gửi số kết nối WebSocket hiện tại mỗi 60 giây
await cw.send(new PutMetricDataCommand({
  Namespace: "MyApp",
  MetricData: [{
    MetricName: "ActiveConnections",
    Dimensions: [{ Name: "AutoScalingGroupName", Value: "ws-asg" }],
    Value: getCurrentConnectionCount(), // hàm của app
    Unit: "Count",
    Timestamp: new Date(),
  }],
}));
```

```bash
# Target tracking trên custom metric
aws autoscaling put-scaling-policy \
  --auto-scaling-group-name ws-asg \
  --policy-name conn-per-instance \
  --policy-type TargetTrackingScaling \
  --target-tracking-configuration '{
    "CustomizedMetricSpecification": {
      "MetricName": "ActiveConnections",
      "Namespace": "MyApp",
      "Dimensions": [{"Name": "AutoScalingGroupName", "Value": "ws-asg"}],
      "Statistic": "Average"
    },
    "TargetValue": 500.0
  }'
```

Điều kiện để custom metric dùng được cho target tracking: metric phải thay đổi **tỷ lệ nghịch với capacity** (như đã nói ở 7.4) và nên là giá trị "per instance" hoặc average. Đây cũng là nền của pattern scale SQS: metric = số message trong queue ÷ số instance (backlog per instance) — chi tiết ở Chương 21.

> 💡 **Exam Tip:** "Scale ASG dựa trên metric mà CloudWatch không có sẵn" → app gọi `PutMetricData` đẩy custom metric, rồi tạo scaling policy/alarm trên metric đó. IAM role của instance cần quyền `cloudwatch:PutMetricData`.

## 7.7 Cooldown, instance warmup và termination policies

### Cooldown vs warmup

**Scaling cooldown** (mặc định **300 giây**) áp dụng cho **simple scaling**: sau một scaling activity, ASG từ chối mọi yêu cầu scaling tiếp theo cho đến hết cooldown. Mục đích: instance mới cần thời gian boot và "gánh" bớt tải; nếu không chờ, metric vẫn cao → scale tiếp → over-provision.

Target tracking và step scaling **không dùng cooldown** mà dùng **instance warmup**: trong thời gian warmup, instance mới đã được tính vào capacity của group (để không scale-out trùng lặp) nhưng metric của nó **chưa được tính** vào aggregate (để CPU cao lúc boot không gây nhiễu). Từ 2021 ASG có thêm thuộc tính **default instance warmup** áp dụng thống nhất cho mọi policy và instance refresh:

```bash
aws autoscaling update-auto-scaling-group \
  --auto-scaling-group-name web-asg \
  --default-instance-warmup 180
```

Thực tế nên đặt default instance warmup = thời gian từ lúc instance launch đến lúc nó phục vụ traffic ổn định. App boot 3 phút mà warmup 30 giây → metric nhiễu → scale thừa. Ngược lại warmup 10 phút cho app boot 1 phút → scale-out đợt sau bị trễ oan.

### Termination policies — instance nào bị giết khi scale in?

Khi desired giảm, ASG chọn "nạn nhân" theo termination policy. **Default policy** chạy tuần tự:

1. Chọn AZ có **nhiều instance nhất** (để giữ cân bằng AZ).
2. Trong AZ đó, ưu tiên instance dùng **Launch Configuration cũ nhất**; nếu toàn Launch Template thì instance dùng **LT version cũ nhất**.
3. Nếu vẫn hoà: instance **gần mốc billing hour kế tiếp nhất**.
4. Vẫn hoà: chọn random.

Các policy đặt được (có thể xếp chuỗi nhiều policy): `Default`, `OldestInstance`, `NewestInstance`, `OldestLaunchTemplate`, `OldestLaunchConfiguration`, `ClosestToNextInstanceHour`, `AllocationStrategy`, hoặc custom bằng Lambda (termination policy dạng function).

`OldestInstance` hữu ích khi muốn đào thải dần instance cũ (dù instance refresh làm việc này bài bản hơn). `NewestInstance` dùng khi test cấu hình mới — scale in sẽ bỏ bản mới trước.

### Scale-in protection

Worker đang xử lý job dài 30 phút mà bị scale-in chọn trúng → mất job. Hai lớp bảo vệ:

```bash
# Bật protection mặc định cho instance MỚI launch
aws autoscaling update-auto-scaling-group \
  --auto-scaling-group-name worker-asg \
  --new-instances-protected-from-scale-in

# App tự bật/tắt protection cho chính nó khi bắt đầu/kết thúc job
aws autoscaling set-instance-protection \
  --auto-scaling-group-name worker-asg \
  --instance-ids i-0abc123 \
  --protected-from-scale-in
```

Pattern thực tế cho worker: instance lấy job → gọi `SetInstanceProtection` bật → xử lý xong → tắt protection. Lưu ý scale-in protection **chỉ chặn scale-in events** — không chặn: terminate tay qua EC2 API, health check replacement, hay max instance lifetime. Đây là bẫy đề hay gài.

> 💡 **Exam Tip:** "Đảm bảo instance đang xử lý job không bị terminate khi scale in" → instance scale-in protection (`SetInstanceProtection` từ trong app). Nếu cần chạy script dọn dẹp TRƯỚC khi terminate (dù vì lý do gì) → lifecycle hook (mục 7.8) — phân biệt rõ hai cái này.

## 7.8 Lifecycle hooks — can thiệp vào launch và terminate

Mặc định, instance launch xong là vào `InService` ngay, và khi terminate là chết ngay. Lifecycle hooks chèn trạng thái **chờ** vào hai thời điểm đó để bạn chạy logic riêng:

- **Launch hook:** `Pending` → `Pending:Wait` (hook giữ ở đây) → `Pending:Proceed` → `InService`. Use case: cài agent, warm cache, đăng ký vào hệ thống nội bộ, kéo config — trước khi nhận traffic.
- **Terminate hook:** `Terminating` → `Terminating:Wait` → `Terminating:Proceed` → `Terminated`. Use case: đẩy log còn lại lên S3/CloudWatch, drain job khỏi worker, deregister khỏi service discovery.

Cơ chế bên dưới: khi instance vào trạng thái `:Wait`, ASG phát notification qua **EventBridge** (khuyến nghị), **SNS** hoặc **SQS**. Consumer (thường là Lambda) nhận event, làm việc của mình, rồi gọi `CompleteLifecycleAction` với kết quả `CONTINUE` (đi tiếp) hoặc `ABANDON` (với launch hook: terminate instance đó luôn; với terminate hook: cứ terminate như kế hoạch). Script chạy **trên chính instance** cũng có thể tự gọi API này.

Số liệu phải nhớ:
- **Heartbeat timeout:** 30–7200 giây, **mặc định 3600 giây (1 giờ)**. Hết timeout mà chưa ai gọi complete → thực hiện default result.
- Cần thêm thời gian: gọi `RecordLifecycleActionHeartbeat` để reset đồng hồ. Tổng thời gian giữ tối đa = **48 giờ** hoặc 100 × heartbeat timeout, lấy số nhỏ hơn.
- **Default result:** `ABANDON` (mặc định) hoặc `CONTINUE`. Với terminate hook, `ABANDON` và `CONTINUE` đều dẫn đến terminate — khác nhau ở chỗ ABANDON cắt ngắn các hook còn lại.

```bash
# Tạo terminate hook: giữ instance 5 phút để drain
aws autoscaling put-lifecycle-hook \
  --auto-scaling-group-name worker-asg \
  --lifecycle-hook-name drain-before-kill \
  --lifecycle-transition autoscaling:EC2_INSTANCE_TERMINATING \
  --heartbeat-timeout 300 \
  --default-result CONTINUE
```

```javascript
// Lambda (SDK JS v3) nhận EventBridge event của lifecycle hook,
// drain xong thì cho phép terminate tiếp tục
import {
  AutoScalingClient,
  CompleteLifecycleActionCommand,
} from "@aws-sdk/client-auto-scaling";

const asClient = new AutoScalingClient({});

export const handler = async (event) => {
  const d = event.detail; // event từ aws.autoscaling
  await drainJobsFrom(d.EC2InstanceId); // logic drain của bạn

  await asClient.send(new CompleteLifecycleActionCommand({
    AutoScalingGroupName: d.AutoScalingGroupName,
    LifecycleHookName: d.LifecycleHookName,
    LifecycleActionToken: d.LifecycleActionToken,
    InstanceId: d.EC2InstanceId,
    LifecycleActionResult: "CONTINUE", // hoặc "ABANDON"
  }));
};
```

EventBridge rule pattern tương ứng: `source: ["aws.autoscaling"]`, `detail-type: ["EC2 Instance-terminate Lifecycle Action"]` (chi tiết EventBridge ở Chương 25).

War story thường gặp: log của instance bị mất khi ASG scale in vào ban đêm — vì agent chưa kịp flush. Terminate hook + script flush log + `CompleteLifecycleAction` giải quyết gọn. Đề DVA-C02 rất thích kịch bản này: *"Developer cần copy logs từ instance lên S3 trước khi ASG terminates nó"* → lifecycle hook trên `EC2_INSTANCE_TERMINATING`.

> 💡 **Exam Tip:** Nhớ cặp trạng thái `Pending:Wait` / `Terminating:Wait` và API `CompleteLifecycleAction`. Heartbeat timeout mặc định 1 giờ, kéo dài bằng `RecordLifecycleActionHeartbeat`, trần tổng 48 giờ. Hook phát notification qua EventBridge/SNS/SQS — Lambda là consumer phổ biến nhất.

## 7.9 Instance refresh — rolling update cả fleet

Khi có AMI mới hoặc LT version mới, bạn cần thay toàn bộ instance đang chạy. Làm tay (terminate từng con để ASG launch bản mới) vừa chậm vừa rủi ro. **Instance refresh** tự động hoá: thay thế instance theo đợt (rolling), đảm bảo luôn đủ capacity phục vụ.

```bash
aws autoscaling start-instance-refresh \
  --auto-scaling-group-name web-asg \
  --desired-configuration '{
    "LaunchTemplate": {"LaunchTemplateName": "web-lt", "Version": "7"}
  }' \
  --preferences '{
    "MinHealthyPercentage": 90,
    "InstanceWarmup": 180,
    "SkipMatching": true,
    "AutoRollback": true
  }'
```

Các tham số quyết định hành vi:

- **MinHealthyPercentage** (mặc định **90%**): tỷ lệ instance healthy tối thiểu phải duy trì trong suốt quá trình. 90% với group 10 instance nghĩa là mỗi đợt chỉ thay 1 con. Đặt thấp hơn → thay nhanh hơn nhưng capacity hụt nhiều hơn. Có thể kết hợp `MaxHealthyPercentage` (100–200%) để ASG launch instance mới TRƯỚC rồi mới terminate cũ — gần giống blue/green thu nhỏ.
- **InstanceWarmup**: thời gian chờ instance mới "chín" trước khi tính nó healthy và sang đợt kế (mặc định lấy default instance warmup của group, không có thì lấy health check grace period).
- **SkipMatching**: bỏ qua instance đã đúng cấu hình đích — refresh lần hai sau khi fail giữa chừng không thay lại những con đã mới.
- **AutoRollback**: nếu refresh fail (instance mới không pass health check, hoặc CloudWatch alarm gắn kèm chuyển ALARM) → tự quay về cấu hình cũ. Kết hợp `--preferences '{"AlarmSpecification": {"Alarms": ["high-5xx-alarm"]}}'` để alarm 5XX của ALB làm cò rollback.
- **Checkpoints** (`CheckpointPercentages` + `CheckpointDelay`): dừng ở các mốc (ví dụ 20%, 50%) chờ một khoảng thời gian để bạn quan sát — canary thủ công.

Theo dõi và hủy:

```bash
aws autoscaling describe-instance-refreshes --auto-scaling-group-name web-asg
aws autoscaling cancel-instance-refresh --auto-scaling-group-name web-asg
# Rollback tay khi đang chạy:
aws autoscaling rollback-instance-refresh --auto-scaling-group-name web-asg
```

Lưu ý vận hành: instance refresh **tôn trọng lifecycle hooks** (mỗi instance bị thay vẫn đi qua terminate hook — fleet lớn + hook 1 giờ = refresh rất lâu), và instance đang bật scale-in protection sẽ làm refresh treo ở trạng thái chờ. Một bẫy nữa: nếu ASG trỏ LT `$Latest` và bạn push LT version lỗi, instance refresh kế tiếp (hoặc một lần scale-out bất kỳ) sẽ rải bản lỗi ra fleet — lý do nên pin version số trong production.

So sánh nhanh với các cách deploy khác để khỏi lẫn trong đề:

| Cách | Bản chất | Khi nào |
|---|---|---|
| Instance refresh | Rolling replace trong CÙNG một ASG | Update AMI/LT cho fleet đang chạy |
| CodeDeploy in-place/blue-green trên EC2/ASG | Deploy code lên instance, hoặc tạo ASG mới rồi chuyển traffic | Deploy ứng dụng có pipeline (Chương 41) |
| Beanstalk deployment policies | Nền tảng quản lý hộ, nhiều chiến lược | App chạy trên Beanstalk (Chương 18) |

> 💡 **Exam Tip:** "Cần áp dụng AMI mới cho toàn bộ instance trong ASG với downtime tối thiểu và ít công sức nhất" → tạo Launch Template version mới + **instance refresh** (nhớ MinHealthyPercentage mặc định 90%). Distractor thường là "tạo ASG mới rồi xoá ASG cũ" — làm được nhưng không phải "least effort".

## 7.10 Các giới hạn, chi tiết vận hành và bẫy tổng hợp

Những con số và hành vi hay bị hỏi hoặc hay gây sự cố:

- **Quota mặc định mỗi region:** 200 ASG, 200 launch configurations (đều nâng được qua Service Quotas). Mỗi ASG: tối đa 500 scheduled actions, 50 scaling policies, 50 lifecycle hooks.
- **Cooldown mặc định 300s** (simple scaling); **health check grace period mặc định 300s**; **heartbeat timeout mặc định 3600s**; **MinHealthyPercentage mặc định 90%**.
- **Max instance lifetime:** ép instance bị thay sau tối đa N giây (tối thiểu 86400 = 1 ngày) — dùng cho yêu cầu compliance "instance không sống quá X ngày". Khác termination policy: đây là thay thế chủ động, không phải tiêu chí chọn khi scale in.
- **AZ rebalancing:** ASG luôn cố cân bằng số instance giữa các AZ; khi rebalance nó launch mới TRƯỚC rồi mới terminate (có thể tạm vượt desired tới 10%).
- **Suspend processes:** tạm dừng từng tiến trình con của ASG (`Launch`, `Terminate`, `HealthCheck`, `ReplaceUnhealthy`, `AZRebalance`, `AlarmNotification`, `ScheduledActions`, `InstanceRefresh`, `AddToLoadBalancer`) — ví dụ suspend `HealthCheck` + `ReplaceUnhealthy` khi cần SSH vào debug một instance lỗi mà không bị ASG giết mất "hiện trường":

```bash
aws autoscaling suspend-processes \
  --auto-scaling-group-name web-asg \
  --scaling-processes HealthCheck ReplaceUnhealthy
# Debug xong nhớ resume:
aws autoscaling resume-processes --auto-scaling-group-name web-asg
```

- **Detach / standby:** `DetachInstances` rút instance khỏi ASG (tuỳ chọn giảm desired tương ứng); `EnterStandby` đưa instance vào trạng thái Standby — vẫn thuộc ASG, vẫn tính tiền, nhưng không nhận traffic và không bị health check thay thế. Standby là cách "mượn" một instance production ra để điều tra sự cố rồi `ExitStandby` trả lại.

Với Go SDK v2, các thao tác tương tự nằm trong package `github.com/aws/aws-sdk-go-v2/service/autoscaling` — ví dụ set desired capacity:

```go
// Go SDK v2: chỉnh desired capacity thủ công
client := autoscaling.NewFromConfig(cfg)
_, err := client.SetDesiredCapacity(ctx, &autoscaling.SetDesiredCapacityInput{
    AutoScalingGroupName: aws.String("web-asg"),
    DesiredCapacity:      aws.Int32(6),
    HonorCooldown:        aws.Bool(false), // bỏ qua cooldown của simple scaling
})
```

Checklist tư duy khi gặp câu hỏi ASG trong đề: (1) vấn đề là *chọn policy* → tra bảng ở 7.5; (2) vấn đề là *instance bị giết oan / không bị thay* → nghĩ ngay health check type, grace period, scale-in protection; (3) vấn đề là *làm gì đó trước khi instance sống/chết* → lifecycle hook; (4) vấn đề là *update fleet* → launch template version + instance refresh; (5) vấn đề là *scale theo queue* → custom metric backlog per instance (Chương 21).

---

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
