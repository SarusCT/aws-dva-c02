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
