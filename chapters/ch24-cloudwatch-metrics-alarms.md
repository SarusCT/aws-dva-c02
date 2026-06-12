# Chương 24: CloudWatch Metrics & Alarms

> **Trọng tâm DVA-C02:** Đây là xương sống của domain "Monitoring & Troubleshooting" (18% đề). Câu hỏi thường xoay quanh: phân biệt metric mặc định (free) vs custom metric vs detailed monitoring (mất phí), độ phân giải standard 1 phút vs high-resolution 1 giây, cấu hình Alarm đúng `EvaluationPeriods`/`DatapointsToAlarm` và xử lý `INSUFFICIENT_DATA`, dùng metric math/anomaly detection để cảnh báo thông minh, và đặt billing alarm. Bạn sẽ gặp dạng "A developer needs to push application-level metrics..." hoặc "An alarm flaps between states, how to fix...".

## Mục tiêu chương
- Hiểu mô hình dữ liệu của CloudWatch: namespace, metric, dimension, timestamp, resolution và cách CloudWatch tổng hợp (aggregate) datapoint.
- Phân biệt rõ basic monitoring (5 phút) vs detailed monitoring (1 phút) của EC2 và khi nào nên bật.
- Publish custom metric bằng `PutMetricData` (standard vs high-resolution) và biết các giới hạn/quota quan trọng cho đề thi.
- Cấu hình CloudWatch Alarm chính xác: states, evaluation period, `DatapointsToAlarm`, treat-missing-data, các loại action.
- Dùng metric math, anomaly detection, composite alarm, và alarm trên metric filter (tham chiếu Chương 25).
- Tạo billing alarm và CloudWatch Dashboard.

## 24.1 Mô hình dữ liệu: Namespace, Metric, Dimension, Resolution

CloudWatch Metrics là một time-series database (cơ sở dữ liệu chuỗi thời gian). Mọi thứ bạn quan sát được — CPU, số request, độ trễ — đều là một **metric**: một chuỗi các điểm dữ liệu `(timestamp, value)` theo thời gian.

Bốn khái niệm gốc bạn phải nắm chắc:

- **Namespace**: không gian tên gom nhóm metric, hoạt động như một "container" để metric không đè lên nhau. AWS services dùng tiền tố `AWS/`: `AWS/EC2`, `AWS/Lambda`, `AWS/SQS`, `AWS/ApplicationELB`. Custom metric của bạn KHÔNG được đặt namespace bắt đầu bằng `AWS/` — tự đặt tên riêng, ví dụ `MyApp/Orders`. Namespace là **bắt buộc** khi gọi `PutMetricData`.
- **Metric**: biến số được theo dõi, có tên (`MetricName`) như `CPUUtilization`, `NumberOfMessagesSent`.
- **Dimension**: cặp name/value gắn vào metric để phân biệt các "phiên bản" của cùng một metric. Ví dụ `CPUUtilization` với dimension `InstanceId=i-0abc`. Một metric có tối đa **30 dimensions**. Điểm bẫy thi: **mỗi tổ hợp dimension khác nhau là một metric RIÊNG BIỆT**. Nếu bạn publish `Latency` với `{Service=checkout}` và `Latency` với `{Service=checkout, Region=us-east-1}`, đó là hai metric khác nhau, và CloudWatch KHÔNG tự cộng gộp chúng cho bạn.
- **Resolution (độ phân giải)**: khoảng thời gian nhỏ nhất giữa các datapoint.
  - **Standard resolution**: dữ liệu ghi mỗi **60 giây (1 phút)**. Đây là mặc định cho hầu hết AWS metrics.
  - **High-resolution**: ghi xuống tới **1 giây** (giá trị `StorageResolution=1`). Chỉ áp dụng cho custom metrics. Alarm trên high-resolution metric có thể kích hoạt nhanh tới **10 giây hoặc 30 giây** thay vì tối thiểu 60 giây.

> 💡 **Exam Tip:** Mỗi tổ hợp namespace + metric name + tập dimension định danh một metric duy nhất. Bạn không thể "xoá" một metric; nó tự hết hạn sau 15 tháng nếu không có dữ liệu mới. Dữ liệu được retention theo bậc: 1 giây giữ 3 giờ, 60 giây giữ 15 ngày, 5 phút giữ 63 ngày, 1 giờ giữ 455 ngày (15 tháng). CloudWatch tự "roll up" dữ liệu phân giải cao thành phân giải thấp hơn theo thời gian.

CloudWatch metrics là **regional** — metric ở `us-east-1` không thấy được từ `eu-west-1` (trừ khi dùng cross-account/cross-region observability, ngoài phạm vi DVA cơ bản). Một ngoại lệ quan trọng: **billing metrics chỉ tồn tại ở `us-east-1`** (mục 24.7).

## 24.2 EC2 Metrics: Basic vs Detailed Monitoring

EC2 gửi metrics vào namespace `AWS/EC2` theo dimension `InstanceId` (và `AutoScalingGroupName`, `InstanceType`, `ImageId`...).

| Tiêu chí | Basic Monitoring | Detailed Monitoring |
|---|---|---|
| Khoảng thời gian | 5 phút (300s) | 1 phút (60s) |
| Chi phí | Miễn phí | Tính phí (per instance/giờ) |
| Bật mặc định? | Có | Không — phải bật |
| Use case | Phù hợp đa số | ASG scaling nhạy, troubleshoot nhanh |

Bẫy kinh điển nhất của EC2: **CloudWatch KHÔNG có sẵn metric `MemoryUtilization` và disk space (used %) ở mức OS**. Hypervisor chỉ thấy được CPU, network, disk I/O ở mức block device — nó không nhìn vào bên trong guest OS. Muốn có RAM và dung lượng đĩa, bạn phải cài **CloudWatch Agent** (Unified Agent) trên instance để publish chúng dưới dạng custom metric (chi tiết agent ở Chương 25).

Bật detailed monitoring bằng CLI:

```bash
# Bật detailed monitoring (1 phút) cho instance
aws ec2 monitor-instances --instance-ids i-0123456789abcdef0

# Tắt, quay về basic 5 phút
aws ec2 unmonitor-instances --instance-ids i-0123456789abcdef0
```

> 💡 **Exam Tip:** Nếu Auto Scaling Group cần phản ứng nhanh với tải, bật detailed monitoring để có datapoint mỗi 1 phút — alarm và scaling policy sẽ kích hoạt sớm hơn nhiều so với chờ 5 phút. Khi câu hỏi nói "scaling phản ứng chậm" hay "instance bị scale trễ", nghi ngờ ngay basic monitoring 5 phút.

## 24.3 Custom Metrics với PutMetricData

Khi metric của AWS không đủ (ví dụ "số order/giây của ứng dụng", "độ sâu hàng đợi xử lý nội bộ", RAM), bạn publish **custom metric** bằng API `PutMetricData`.

Hai cách truyền dữ liệu:

1. **Value đơn lẻ**: gửi một giá trị cho một timestamp.
2. **StatisticValues**: gửi tập đã tổng hợp sẵn (`SampleCount`, `Sum`, `Minimum`, `Maximum`) — giảm số lần gọi API khi bạn có nhiều quan sát trong một phút.
3. **Values + Counts** (mảng): gửi nhiều giá trị kèm trọng số count — cũng để gộp.

Ví dụ SDK v3 (Node.js) publish custom metric:

```javascript
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";

const cw = new CloudWatchClient({ region: "us-east-1" });

await cw.send(new PutMetricDataCommand({
  Namespace: "MyApp/Orders",          // KHÔNG được bắt đầu bằng "AWS/"
  MetricData: [
    {
      MetricName: "OrdersPlaced",
      Dimensions: [
        { Name: "Service", Value: "checkout" },
        { Name: "Env", Value: "prod" },
      ],
      Unit: "Count",
      Value: 1,
      Timestamp: new Date(),          // bỏ trống => CloudWatch dùng thời điểm nhận
      StorageResolution: 60,          // 60 = standard; 1 = high-resolution
    },
  ],
}));
```

High-resolution metric chỉ cần đổi `StorageResolution: 1`:

```javascript
{
  MetricName: "RequestLatency",
  Unit: "Milliseconds",
  Value: 12.7,
  StorageResolution: 1,   // ghi xuống tới 1 giây
}
```

Với CLI:

```bash
aws cloudwatch put-metric-data \
  --namespace "MyApp/Orders" \
  --metric-name OrdersPlaced \
  --dimensions Service=checkout,Env=prod \
  --unit Count --value 1 \
  --storage-resolution 60
```

Các con số bạn nên thuộc cho đề thi:

- Một request `PutMetricData` tối đa **1000 metric data items**, payload tối đa **1 MB** (HTTP POST).
- Một metric tối đa **30 dimensions**.
- `Timestamp` của datapoint được chấp nhận trong khoảng **không quá 2 tuần trong quá khứ và 2 giờ trong tương lai**.
- Giá trị metric: tránh số quá lớn/quá nhỏ; CloudWatch từ chối giá trị nằm ngoài khoảng biểu diễn (khoảng ±1.17e±38) và `NaN`.

> 💡 **Exam Tip:** `PutMetricData` là API **asynchronous về mặt hiển thị** — dữ liệu mới publish có thể mất tới một-hai phút mới xuất hiện trên console/`GetMetricData`. Đừng kỳ vọng đọc lại ngay. Và nhớ: publish high-resolution metric tốn phí cao hơn standard, đừng bật `StorageResolution=1` bừa bãi.

Một bẫy về thiết kế: nếu bạn nhúng dimension có cardinality cao (ví dụ `UserId` hàng triệu giá trị) vào custom metric, mỗi user thành một metric riêng — chi phí bùng nổ vì CloudWatch tính tiền theo số metric custom duy nhất. Với loại telemetry này, hãy dùng **CloudWatch Logs + metric filter** (Chương 25) hoặc **Embedded Metric Format (EMF)** để chỉ trích xuất metric tổng hợp.

## 24.4 Statistics, Periods và cách CloudWatch tổng hợp

Khi đọc/biểu diễn metric, bạn không xem từng datapoint thô mà xem **statistic trên một period**.

- **Period**: cửa sổ thời gian gộp dữ liệu (60s, 300s, 3600s...). Period nhỏ nhất phụ thuộc resolution của metric (1s cho high-res, 60s cho standard).
- **Statistic**: phép tổng hợp các datapoint trong period: `Average`, `Sum`, `Minimum`, `Maximum`, `SampleCount`, và **percentile** (`p90`, `p99`, `p99.9`...).

Ví dụ phân biệt dễ sai:
- Để biết tổng số order trong một phút → dùng `Sum`.
- Để biết CPU trung bình → `Average`.
- Để biết độ trễ đuôi (tail latency) — câu chuyện thực tế nơi `Average` "đẹp" nhưng 1% user vẫn chậm — dùng **percentile `p99`**. Percentile cực kỳ hữu ích cho SLA và là điểm hay được khen trong câu hỏi tình huống.

> 💡 **Exam Tip:** Chọn sai statistic làm alarm vô dụng. Alarm trên `Average(CPUUtilization)` có thể không bao giờ kêu dù vài instance đang 100% vì trung bình bị kéo xuống. Khi đề nói "phát hiện latency cao mà số đông user không bị ảnh hưởng", đáp án thường là percentile `p99`, không phải `Average`.

## 24.5 CloudWatch Alarms: states, evaluation và treat-missing-data

Alarm theo dõi **một metric (hoặc một biểu thức metric math)** và chuyển trạng thái khi điều kiện vi phạm.

Ba state của alarm:
- **OK**: metric nằm trong ngưỡng cho phép.
- **ALARM**: metric vi phạm ngưỡng đủ lâu theo cấu hình.
- **INSUFFICIENT_DATA**: chưa đủ dữ liệu để đánh giá (mới tạo, metric ngừng publish, hoặc dữ liệu thiếu).

Cấu hình đánh giá gồm hai tham số then chốt — đề rất hay hỏi:
- **Period**: độ dài mỗi datapoint dùng để đánh giá.
- **Evaluation Periods (M)**: số period gần nhất CloudWatch xem xét.
- **Datapoints to Alarm (N)**: trong M period đó, cần bao nhiêu datapoint vi phạm thì vào ALARM. Đây gọi là mô hình **"N out of M"**.

Ví dụ: Period=60s, EvaluationPeriods=5, DatapointsToAlarm=3 nghĩa là "trong 5 phút gần nhất, nếu có 3 phút vi phạm ngưỡng thì báo động". Cấu hình này lọc nhiễu (spike nhất thời 1 phút sẽ không làm alarm kêu).

**Treat missing data** — cách alarm xử lý period thiếu dữ liệu:
- `missing` (mặc định): bỏ qua, đánh giá dựa trên dữ liệu có sẵn.
- `notBreaching`: coi datapoint thiếu là "tốt" (trong ngưỡng).
- `breaching`: coi datapoint thiếu là "xấu" (vi phạm).
- `ignore`: giữ nguyên trạng thái hiện tại.

```bash
aws cloudwatch put-metric-alarm \
  --alarm-name high-cpu-checkout \
  --namespace AWS/EC2 \
  --metric-name CPUUtilization \
  --dimensions Name=InstanceId,Value=i-0123456789abcdef0 \
  --statistic Average \
  --period 60 \
  --evaluation-periods 5 \
  --datapoints-to-alarm 3 \
  --threshold 80 \
  --comparison-operator GreaterThanThreshold \
  --treat-missing-data notBreaching \
  --alarm-actions arn:aws:sns:us-east-1:111122223333:ops-alerts
```

> 💡 **Exam Tip:** Alarm "flapping" (nhảy qua lại OK/ALARM liên tục) thường do `DatapointsToAlarm` quá nhỏ (=1) trên metric nhiễu — tăng N/M để cần nhiều datapoint vi phạm liên tiếp. Còn alarm mới tạo bị kẹt `INSUFFICIENT_DATA` thường vì metric chưa có dữ liệu hoặc app ngừng publish; nếu metric thưa, cân nhắc `treat-missing-data` cho phù hợp ngữ nghĩa (queue backlog ngừng publish nên coi là `notBreaching`, còn heartbeat ngừng nên coi là `breaching`).

## 24.6 Alarm Actions: SNS, EC2, Auto Scaling

Khi đổi state, alarm kích hoạt **action**. Bạn gắn action cho cả ba chuyển tiếp: `--alarm-actions` (vào ALARM), `--ok-actions` (về OK), `--insufficient-data-actions`.

Các loại action thi hay hỏi:
- **SNS topic**: gửi notification (email, SMS, hoặc fan-out tới Lambda/SQS — chi tiết SNS ở Chương 22). Đây là cầu nối phổ biến nhất: Alarm → SNS → Lambda để tự động remediate.
- **EC2 action**: stop / terminate / reboot / recover một instance. Lưu ý **recover** chỉ dùng cho EC2 metric `StatusCheckFailed_System` và yêu cầu instance dùng EBS-backed.
- **Auto Scaling action**: trigger scaling policy (scale out/in). Đây là cơ chế đứng sau step/simple scaling policy của ASG (target tracking thì AWS tự quản alarm — chi tiết ASG ở Chương 7).
- **Systems Manager** action (OpsItem/Incident) ở mức nhận diện.

> 💡 **Exam Tip:** Nhớ ánh xạ: cần thông báo/automation linh hoạt → SNS. Cần tự khôi phục instance hỏng phần cứng host → EC2 **recover** action trên `StatusCheckFailed_System`. Cần tự co giãn → Auto Scaling action. Một alarm có thể gắn **nhiều action** cùng lúc. Action chỉ kích hoạt khi **chuyển** state, không phải mỗi lần đánh giá khi đang ở ALARM.

CloudWatch còn có hai status check metric quan trọng của EC2:
- `StatusCheckFailed_System`: sự cố ở hạ tầng AWS (host, network, power) → dùng **recover**.
- `StatusCheckFailed_Instance`: sự cố trong instance (OS, filesystem, network config) → thường **reboot** hoặc thay instance.

## 24.7 Billing Alarm

Billing alarm cảnh báo khi chi phí ước tính vượt ngưỡng. Hai điều phải nhớ:

1. Phải bật **"Receive Billing Alerts"** trong Billing preferences (chỉ root account/được phân quyền) trước khi metric `EstimatedCharges` xuất hiện.
2. Metric `EstimatedCharges` (namespace `AWS/Billing`) **chỉ có ở Region `us-east-1`** — bạn phải tạo alarm tại đó dù tài nguyên ở region khác.

```bash
aws cloudwatch put-metric-alarm \
  --region us-east-1 \
  --alarm-name billing-over-50usd \
  --namespace "AWS/Billing" \
  --metric-name EstimatedCharges \
  --dimensions Name=Currency,Value=USD \
  --statistic Maximum \
  --period 21600 \
  --evaluation-periods 1 \
  --threshold 50 \
  --comparison-operator GreaterThanThreshold \
  --alarm-actions arn:aws:sns:us-east-1:111122223333:billing-alerts
```

> 💡 **Exam Tip:** Hai đáp án sai kinh điển: tạo billing alarm ở region khác `us-east-1`, và quên bật billing alerts preference. Lưu ý phân biệt với **AWS Budgets** — Budgets linh hoạt hơn (theo service/tag, dự báo forecast, nhiều ngưỡng) và là lựa chọn AWS khuyến nghị cho quản trị chi phí; CloudWatch billing alarm chỉ là cảnh báo đơn giản trên tổng `EstimatedCharges`.

## 24.8 Metric Math và Anomaly Detection

**Metric Math** cho phép tính toán trên một hoặc nhiều metric để tạo metric mới ngay tại thời điểm hiển thị/alarm, không cần publish thêm. Bạn tham chiếu metric bằng `id` rồi viết biểu thức.

Ví dụ tính tỉ lệ lỗi 5xx (%) của ALB và alarm trên đó:

```bash
aws cloudwatch put-metric-alarm \
  --alarm-name alb-5xx-rate \
  --evaluation-periods 3 --datapoints-to-alarm 3 \
  --threshold 5 --comparison-operator GreaterThanThreshold \
  --alarm-actions arn:aws:sns:us-east-1:111122223333:ops-alerts \
  --metrics '[
    {"Id":"e1","Expression":"(m5xx / total) * 100","Label":"5xxRate","ReturnData":true},
    {"Id":"m5xx","MetricStat":{"Metric":{"Namespace":"AWS/ApplicationELB","MetricName":"HTTPCode_Target_5XX_Count","Dimensions":[{"Name":"LoadBalancer","Value":"app/my-alb/abc"}]},"Period":60,"Stat":"Sum"},"ReturnData":false},
    {"Id":"total","MetricStat":{"Metric":{"Namespace":"AWS/ApplicationELB","MetricName":"RequestCount","Dimensions":[{"Name":"LoadBalancer","Value":"app/my-alb/abc"}]},"Period":60,"Stat":"Sum"},"ReturnData":false}
  ]'
```

Các hàm metric math hay dùng: số học (`+ - * /`), `SUM()`, `AVG()`, `RATE()`, `FILL()` (lấp dữ liệu thiếu), và đặc biệt `ANOMALY_DETECTION_BAND()`.

**Anomaly Detection**: CloudWatch huấn luyện một mô hình máy học trên lịch sử (tối đa 2 tuần), học pattern theo giờ/ngày/tuần, rồi sinh một **dải kỳ vọng (band)**. Bạn tạo alarm "khi metric ra ngoài band" thay vì đặt ngưỡng tĩnh — rất hợp với traffic có tính mùa vụ (cao điểm giờ trưa, thấp ban đêm).

```bash
aws cloudwatch put-metric-alarm \
  --alarm-name orders-anomaly \
  --comparison-operator LessThanLowerOrGreaterThanUpperThreshold \
  --evaluation-periods 2 \
  --threshold-metric-id ad1 \
  --alarm-actions arn:aws:sns:us-east-1:111122223333:ops-alerts \
  --metrics '[
    {"Id":"m1","MetricStat":{"Metric":{"Namespace":"MyApp/Orders","MetricName":"OrdersPlaced"},"Period":300,"Stat":"Sum"},"ReturnData":true},
    {"Id":"ad1","Expression":"ANOMALY_DETECTION_BAND(m1, 2)","Label":"OrdersExpected","ReturnData":false}
  ]'
```

Tham số `2` là số độ lệch (band width) — càng lớn dải càng rộng, càng ít cảnh báo sai.

> 💡 **Exam Tip:** Khi đề nói "ngưỡng tĩnh không phù hợp vì traffic biến động theo giờ/ngày" → đáp án là **anomaly detection**. Khi đề cần một metric dẫn xuất (error rate %, available memory %) mà không muốn sửa code app → đáp án là **metric math**, không phải publish thêm custom metric.

## 24.9 Composite Alarms và Alarm trên Metric Filter

**Composite Alarm** gộp nhiều alarm con bằng biểu thức logic (`ALARM`, `OK`, `AND`, `OR`, `NOT`), chỉ kích hoạt action khi tổ hợp điều kiện đúng. Lợi ích lớn nhất: **giảm noise**. Thay vì 20 alarm cùng bắn email lúc sự cố, bạn tạo một composite "service down" = (high error rate) AND (high latency) và chỉ nó gửi notification.

```bash
aws cloudwatch put-composite-alarm \
  --alarm-name checkout-service-degraded \
  --alarm-rule "ALARM('alb-5xx-rate') AND ALARM('high-cpu-checkout')" \
  --alarm-actions arn:aws:sns:us-east-1:111122223333:pager
```

Composite alarm còn hỗ trợ **suppressor alarm**: tạm "ngậm" cảnh báo trong lúc bảo trì có kế hoạch.

**Alarm trên metric filter**: bạn không thể alarm trực tiếp trên text log. Quy trình là tạo **metric filter** trên một Log Group (ví dụ đếm số dòng chứa `"ERROR"` hoặc `"500"`) để biến log thành metric, rồi đặt alarm bình thường trên metric đó. Đây là cách phổ biến để cảnh báo trên lỗi ứng dụng, sự kiện bảo mật (ví dụ root login, `ConsoleLogin` thất bại từ CloudTrail). Chi tiết cách tạo metric filter và Logs Insights ở **Chương 25**.

> 💡 **Exam Tip:** "Cảnh báo khi log xuất hiện chuỗi X" → metric filter trên Log Group → metric → alarm. "Chỉ paging khi NHIỀU điều kiện cùng xảy ra để bớt false alarm" → composite alarm. Đừng nhầm composite alarm (gộp alarm) với metric math (gộp metric).

## 24.10 CloudWatch Dashboards

Dashboard là bảng điều khiển trực quan gồm các widget (line, stacked area, number, gauge, text, alarm status, logs table). Đặc điểm cần nhớ cho đề:

- Dashboard là **global** (không gắn region) và có thể hiển thị metric từ **nhiều region và nhiều account** trên cùng một màn hình — hữu ích cho ops tập trung.
- Dashboard định nghĩa bằng **JSON** (`put-dashboard`), dễ version control và tái tạo bằng IaC.
- Có thể đặt chế độ **auto-refresh** và chia sẻ dashboard công khai (cẩn trọng bảo mật).
- Tính phí theo số dashboard (3 dashboard đầu có hạn mức free nhất định).

```bash
aws cloudwatch put-dashboard \
  --dashboard-name prod-overview \
  --dashboard-body '{
    "widgets": [
      {"type":"metric","x":0,"y":0,"width":12,"height":6,
       "properties":{"metrics":[["AWS/EC2","CPUUtilization","InstanceId","i-0123456789abcdef0"]],
       "period":60,"stat":"Average","region":"us-east-1","title":"CPU"}}
    ]
  }'
```

> 💡 **Exam Tip:** Khi đề cần "một view duy nhất cho nhiều region/account" → CloudWatch Dashboard (global). Khi cần tự động dựng lại dashboard giống hệt → mô tả bằng JSON và quản lý qua CloudFormation/CDK. Dashboard chỉ để xem; muốn hành động khi vượt ngưỡng vẫn phải dùng Alarm.

## 24.11 Metric của các service hay gặp trong đề & Embedded Metric Format

Đề DVA-C02 thường gài câu hỏi quanh việc "metric nào dùng để scale/cảnh báo service nào". Bảng dưới gom các metric đáng nhớ nhất:

| Service | Namespace | Metric chủ chốt | Ghi chú thi |
|---|---|---|---|
| Lambda | `AWS/Lambda` | `Invocations`, `Errors`, `Throttles`, `Duration`, `ConcurrentExecutions` | `Throttles` cao → chạm concurrency limit (Chương 29). Tính error rate = `Errors/Invocations` bằng metric math |
| SQS | `AWS/SQS` | `ApproximateNumberOfMessagesVisible`, `ApproximateAgeOfOldestMessage` | Backlog tăng → dùng để scale consumer/ASG. `AgeOfOldestMessage` báo hiệu xử lý không kịp |
| ALB | `AWS/ApplicationELB` | `RequestCount`, `RequestCountPerTarget`, `HTTPCode_Target_5XX_Count`, `TargetResponseTime` | `RequestCountPerTarget` là metric chuẩn cho ASG target tracking |
| DynamoDB | `AWS/DynamoDB` | `ConsumedReadCapacityUnits`, `ThrottledRequests`, `UserErrors` | Throttle → tăng capacity hoặc đổi on-demand (Chương 31) |
| API Gateway | `AWS/ApiGateway` | `4XXError`, `5XXError`, `Latency`, `IntegrationLatency`, `Count` | Latency = tổng; IntegrationLatency = phần backend (Chương 35) |

Một bẫy về độ trễ phát hành: metric của các managed service như SQS `ApproximateNumberOf...` được publish theo chu kỳ (khoảng 1 phút) và là **xấp xỉ** (approximate) — đừng kỳ vọng con số tức thời tuyệt đối chính xác.

**Embedded Metric Format (EMF)**: thay vì gọi `PutMetricData` (tốn round-trip, có thể bị throttle), ứng dụng (đặc biệt Lambda) ghi một JSON log có cấu trúc đặc biệt vào CloudWatch Logs; CloudWatch tự **trích xuất metric** từ log đó mà không cần gọi API metric. Ưu điểm: không thêm latency vào hàm, vừa giữ được log chi tiết (high-cardinality như `requestId`, `userId` nằm trong log) vừa có metric tổng hợp. Đây là pattern AWS khuyến nghị cho custom metric trong Lambda.

```javascript
// Lambda ghi một dòng EMF JSON ra stdout => CloudWatch tự tạo metric "Latency"
console.log(JSON.stringify({
  "_aws": {
    "Timestamp": Date.now(),
    "CloudWatchMetrics": [{
      "Namespace": "MyApp/Orders",
      "Dimensions": [["Service"]],
      "Metrics": [{ "Name": "Latency", "Unit": "Milliseconds" }]
    }]
  },
  "Service": "checkout",
  "Latency": 23.4,
  "requestId": "abc-123"   // high-cardinality: nằm trong log, KHÔNG thành dimension
}));
```

> 💡 **Exam Tip:** "Publish custom metric từ Lambda mà không thêm độ trễ và không gọi API riêng" → Embedded Metric Format. "Scale ECS/ASG theo tải" → metric `RequestCountPerTarget` (ALB) hoặc `ApproximateNumberOfMessagesVisible` (SQS) là các lựa chọn kinh điển.

## 24.12 IAM permissions cho CloudWatch (đủ để thực thi)

Để code publish metric và quản alarm, role/identity cần các action tương ứng. Hai nhóm hay nhầm:

- **Publish/đọc metric**: `cloudwatch:PutMetricData` (publish), `cloudwatch:GetMetricData`, `cloudwatch:GetMetricStatistics`, `cloudwatch:ListMetrics`.
- **Quản alarm**: `cloudwatch:PutMetricAlarm`, `cloudwatch:DescribeAlarms`, `cloudwatch:DeleteAlarms`, `cloudwatch:SetAlarmState` (dùng để test action thủ công).

Một chi tiết về quyền hay bị bỏ sót: `cloudwatch:PutMetricData` **không hỗ trợ resource-level permission theo từng metric**; bạn chỉ giới hạn được bằng condition key `cloudwatch:namespace`. Ví dụ chỉ cho phép publish vào namespace của app:

```json
{
  "Effect": "Allow",
  "Action": "cloudwatch:PutMetricData",
  "Resource": "*",
  "Condition": { "StringEquals": { "cloudwatch:namespace": "MyApp/Orders" } }
}
```

Ngoài ra, để alarm gửi được tới SNS topic mã hoá bằng KMS, principal `cloudwatch.amazonaws.com` cần quyền dùng key — đây là nguyên nhân phổ biến khiến "alarm vào ALARM nhưng không có email".

> 💡 **Exam Tip:** "App on EC2 không publish được metric" → kiểm tra instance role có `cloudwatch:PutMetricData` chưa (và đúng `cloudwatch:namespace` condition). "Alarm chuyển ALARM nhưng không nhận notification" → kiểm tra SNS topic policy / KMS key policy cho `cloudwatch.amazonaws.com`, hoặc subscription chưa confirm.

Bạn có thể test action của alarm mà không cần chờ metric vi phạm thật bằng `set-alarm-state` — rất hữu ích khi kiểm thử pipeline cảnh báo:

```bash
aws cloudwatch set-alarm-state \
  --alarm-name high-cpu-checkout \
  --state-value ALARM \
  --state-reason "manual test of SNS action"
```

Lưu ý: state đặt thủ công sẽ bị ghi đè ở lần đánh giá metric tiếp theo, nhưng action vẫn được kích hoạt ngay — đủ để xác nhận luồng SNS → Lambda hoạt động.

---

## Hands-on Lab: Custom metrics, Alarm với SNS, Metric Math & Composite Alarm

**Mục tiêu lab:** Đẩy một custom metric (cả standard và high-resolution) bằng `PutMetricData`, tạo một CloudWatch Alarm gửi thông báo qua SNS khi vượt ngưỡng, dùng metric math để cảnh báo theo tỉ lệ lỗi (%) thay vì số tuyệt đối, gộp nhiều alarm thành một composite alarm, và bật anomaly detection. Toàn bộ làm bằng AWS CLI v2 — đúng kiểu thao tác đề DVA-C02 mô tả.

**Chuẩn bị:**
- AWS CLI v2 đã cấu hình profile có quyền `cloudwatch:*`, `sns:*` (cấu hình CLI chi tiết ở Chương 3).
- Region ví dụ: `ap-southeast-1`. Đặt biến cho gọn:

```bash
export AWS_DEFAULT_REGION=ap-southeast-1
EMAIL="duntt232@gmail.com"   # email nhận cảnh báo
```

CloudWatch tính phí theo số custom metric/tháng, số API call `PutMetricData`, số alarm. Lab này tốn vài cent nếu chạy trong vài giờ — nhớ làm bước Dọn dẹp.

### Bước 1: Tạo SNS topic làm đích cho alarm action

Alarm không tự gửi email — nó chỉ chuyển state và kích hoạt action. Action phổ biến nhất là publish vào một SNS topic (chi tiết SNS ở Chương 22).

```bash
TOPIC_ARN=$(aws sns create-topic --name cw-lab-alarms --query TopicArn --output text)
echo $TOPIC_ARN   # arn:aws:sns:ap-southeast-1:111122223333:cw-lab-alarms

# Subscribe email — bạn phải vào hộp thư bấm "Confirm subscription"
aws sns subscribe --topic-arn $TOPIC_ARN --protocol email --notification-endpoint "$EMAIL"
```

**Output mong đợi:** `"SubscriptionArn": "pending confirmation"`. Mở email, bấm link xác nhận. Nếu chưa confirm, alarm chuyển ALARM nhưng email không tới — đây là bẫy "alarm chạy nhưng không nhận được mail" hay gặp.

### Bước 2: Đẩy custom metric bằng PutMetricData

Đẩy một metric `OrderLatency` vào namespace tùy chỉnh `MyApp/Checkout`, kèm dimension `Service=checkout`. Namespace + tên metric + tập dimension xác định DUY NHẤT một metric — đổi một dimension là tạo ra metric mới (và tính phí riêng).

```bash
# Gửi vài datapoint (đơn vị mili giây)
for v in 120 350 980 1500 1800; do
  aws cloudwatch put-metric-data \
    --namespace "MyApp/Checkout" \
    --metric-data "MetricName=OrderLatency,Dimensions=[{Name=Service,Value=checkout}],Value=$v,Unit=Milliseconds"
done
```

Lệnh `put-metric-data` không trả output khi thành công (exit code 0). Metric mới xuất hiện trong console sau ~1-2 phút (custom metric không phải đợi lâu như metric service).

Đẩy **high-resolution metric** (storage resolution 1 giây) — dùng `StorageResolution=1`. Mặc định là 60 (standard resolution):

```bash
aws cloudwatch put-metric-data \
  --namespace "MyApp/Checkout" \
  --metric-data "MetricName=ActiveCarts,Value=42,StorageResolution=1,Unit=Count"
```

> Bẫy DVA: high-resolution metric (`StorageResolution=1`) cho phép alarm period nhỏ tới 10s và 30s; standard metric chỉ alarm period tối thiểu 60s. High-resolution tính phí cao hơn và giữ độ phân giải 1s chỉ trong 3 giờ đầu.

Đẩy nhiều datapoint cùng lúc bằng `StatisticValues` (tiết kiệm API call — gửi thống kê đã gộp thay vì từng điểm):

```bash
aws cloudwatch put-metric-data --namespace "MyApp/Checkout" --metric-data '[
  {"MetricName":"OrderLatency","Dimensions":[{"Name":"Service","Value":"checkout"}],
   "StatisticValues":{"SampleCount":100,"Sum":85000,"Minimum":80,"Maximum":2100},"Unit":"Milliseconds"}
]'
```

### Bước 3: Tạo Alarm trên custom metric, action là SNS

Tạo alarm: nếu `OrderLatency` (thống kê Average) vượt 1000ms trong **3 trên 3** chu kỳ 60 giây liên tiếp thì vào ALARM và publish SNS.

```bash
aws cloudwatch put-metric-alarm \
  --alarm-name "checkout-latency-high" \
  --alarm-description "p-avg latency > 1s" \
  --namespace "MyApp/Checkout" --metric-name OrderLatency \
  --dimensions Name=Service,Value=checkout \
  --statistic Average --period 60 \
  --evaluation-periods 3 --datapoints-to-alarm 3 \
  --threshold 1000 --comparison-operator GreaterThanThreshold \
  --treat-missing-data notBreaching \
  --alarm-actions $TOPIC_ARN \
  --ok-actions $TOPIC_ARN
```

Giải thích các tham số đề hay hỏi:
- `--evaluation-periods 3 --datapoints-to-alarm 3`: cơ chế "M out of N" — cần 3/3 datapoint vi phạm. Đặt `datapoints-to-alarm 2` với `evaluation-periods 3` thành "2 trên 3" → giảm nhiễu, alarm vẫn nhạy.
- `--treat-missing-data notBreaching`: khi thiếu datapoint thì coi như BÌNH THƯỜNG. Bốn lựa chọn: `notBreaching`, `breaching`, `ignore` (giữ state cũ), `missing` (mặc định — thiếu nhiều thì về INSUFFICIENT_DATA).
- `--ok-actions`: gửi thông báo cả khi alarm trở lại OK.

Kiểm tra state:

```bash
aws cloudwatch describe-alarms --alarm-names checkout-latency-high \
  --query 'MetricAlarms[0].StateValue' --output text
# Ban đầu: INSUFFICIENT_DATA, rồi OK hoặc ALARM
```

Ép alarm vào ALARM để test SNS mà không cần đẩy số liệu thật, dùng `set-alarm-state`:

```bash
aws cloudwatch set-alarm-state --alarm-name checkout-latency-high \
  --state-value ALARM --state-reason "manual test"
```

**Output mong đợi:** Trong ~1 phút bạn nhận email từ SNS. `set-alarm-state` chỉ ép tạm thời — chu kỳ đánh giá tiếp theo sẽ ghi đè state theo dữ liệu thật.

### Bước 4: Metric Math — cảnh báo theo TỈ LỆ LỖI (%)

Cảnh báo theo số lỗi tuyệt đối là bẫy: 50 lỗi/phút lúc cao điểm 1 triệu request là bình thường, nhưng lúc thấp điểm lại nghiêm trọng. Metric math cho phép tính `errors/requests*100`. Tạo alarm dựa trên một biểu thức:

```bash
aws cloudwatch put-metric-alarm \
  --alarm-name "checkout-error-rate-high" \
  --alarm-description "error rate > 5%" \
  --evaluation-periods 3 --datapoints-to-alarm 2 \
  --threshold 5 --comparison-operator GreaterThanThreshold \
  --treat-missing-data notBreaching \
  --alarm-actions $TOPIC_ARN \
  --metrics '[
    {"Id":"errors","MetricStat":{"Metric":{"Namespace":"MyApp/Checkout","MetricName":"Errors","Dimensions":[{"Name":"Service","Value":"checkout"}]},"Period":60,"Stat":"Sum"},"ReturnData":false},
    {"Id":"requests","MetricStat":{"Metric":{"Namespace":"MyApp/Checkout","MetricName":"Requests","Dimensions":[{"Name":"Service","Value":"checkout"}]},"Period":60,"Stat":"Sum"},"ReturnData":false},
    {"Id":"errorRate","Expression":"errors/requests*100","Label":"Error Rate %","ReturnData":true}
  ]'
```

Điểm mấu chốt: khi alarm dùng `--metrics`, đúng **một** phần tử phải có `"ReturnData":true` — đó là chuỗi mà threshold so sánh. Các metric nguồn đặt `ReturnData:false`.

> 💡 **Exam Tip:** Câu hỏi "cảnh báo khi tỉ lệ lỗi/độ chính xác vượt ngưỡng, không phải số tuyệt đối" → đáp án là **metric math expression trong alarm**. Đây không phải composite alarm.

### Bước 5: Composite Alarm

Composite alarm kết hợp nhiều alarm con bằng biểu thức logic AND/OR/NOT, dựa trên STATE của alarm con (không phải metric). Dùng để giảm noise: chỉ báo khi cả latency cao VÀ error rate cao.

```bash
aws cloudwatch put-composite-alarm \
  --alarm-name "checkout-degraded" \
  --alarm-rule "ALARM(\"checkout-latency-high\") AND ALARM(\"checkout-error-rate-high\")" \
  --alarm-actions $TOPIC_ARN
```

Composite alarm **không** đẩy được vào ASG/EC2 action như alarm thường, nhưng dùng SNS tốt. Lợi ích: gửi MỘT thông báo tổng hợp thay vì spam từ từng alarm con. Có thể bật `--actions-suppressor` để nén cảnh báo khi một alarm "cha" (ví dụ "toàn site down") đang ALARM.

### Bước 6: Anomaly Detection

Anomaly detection huấn luyện một band (dải) kỳ vọng từ lịch sử metric; alarm bắn khi giá trị nằm ngoài band thay vì so với ngưỡng cố định — hợp với metric có chu kỳ ngày/tuần.

```bash
aws cloudwatch put-metric-alarm \
  --alarm-name "checkout-latency-anomaly" \
  --comparison-operator LessThanLowerOrGreaterThanUpperThreshold \
  --evaluation-periods 3 --threshold-metric-id ad1 \
  --treat-missing-data notBreaching \
  --alarm-actions $TOPIC_ARN \
  --metrics '[
    {"Id":"m1","MetricStat":{"Metric":{"Namespace":"MyApp/Checkout","MetricName":"OrderLatency","Dimensions":[{"Name":"Service","Value":"checkout"}]},"Period":60,"Stat":"Average"},"ReturnData":true},
    {"Id":"ad1","Expression":"ANOMALY_DETECTION_BAND(m1, 2)","Label":"Latency expected band","ReturnData":true}
  ]'
```

`ANOMALY_DETECTION_BAND(m1, 2)` tạo band với độ rộng 2 (số càng lớn band càng rộng, càng ít cảnh báo). Comparison operator phải là một trong các dạng `...ThanUpperThreshold` / `...LowerOrGreaterThanUpperThreshold`. Mô hình cần dữ liệu lịch sử để chính xác.

### Bước 7: (Tùy chọn) Tạo Dashboard nhanh

```bash
aws cloudwatch put-dashboard --dashboard-name checkout-lab \
  --dashboard-body '{
    "widgets":[
      {"type":"metric","x":0,"y":0,"width":12,"height":6,
       "properties":{"metrics":[["MyApp/Checkout","OrderLatency","Service","checkout",{"stat":"Average"}]],
       "period":60,"region":"ap-southeast-1","title":"Checkout Latency"}}
    ]}'
```

Dashboard global, dùng được cross-region trong một widget. Ba dashboard đầu tiên + 50 metric/tháng nằm trong free tier.

### Dọn dẹp tài nguyên

```bash
aws cloudwatch delete-alarms --alarm-names \
  checkout-latency-high checkout-error-rate-high \
  checkout-latency-anomaly checkout-degraded
# Lưu ý: composite alarm phải xóa TRƯỚC hoặc cùng lúc với alarm con nếu nó tham chiếu;
# delete-alarms ở trên đã gộp cả composite nên ổn.

aws cloudwatch delete-dashboards --dashboard-names checkout-lab
aws sns delete-topic --topic-arn $TOPIC_ARN
```

Custom metric KHÔNG xóa được thủ công — chúng tự hết hạn sau 15 tháng không có datapoint mới và ngừng phát sinh phí ngay khi bạn ngừng `PutMetricData`. Đừng lo tìm nút "delete metric" — không có.

## 💡 Exam Tips chương 24

- **Metric = Namespace + MetricName + tập Dimensions.** Đổi một dimension là tạo metric mới (và tính phí mới). Không thể xóa metric thủ công; metric tự hết hạn sau 15 tháng.
- **Detailed monitoring của EC2** = metric chu kỳ **1 phút** (có phí); basic = **5 phút** (miễn phí). EC2 KHÔNG đẩy metric memory hay disk used — phải cài **CloudWatch Agent** để có RAM/disk (chi tiết agent ở Chương 25).
- **PutMetricData** là API duy nhất để đẩy custom metric. `StorageResolution=1` → high-resolution (1s), cho alarm period 10s/30s; mặc định 60 → standard.
- **Alarm có 3 state:** OK, ALARM, INSUFFICIENT_DATA. Alarm action chỉ bắn khi STATE THAY ĐỔI, không bắn lặp lại mỗi period khi đã ở ALARM.
- **"M out of N":** `datapoints-to-alarm` (M) trên `evaluation-periods` (N) — giảm cảnh báo giả mà vẫn nhạy. Đây là từ khóa đề hay gài.
- **TreatMissingData:** `breaching` / `notBreaching` / `ignore` (giữ state) / `missing` (mặc định). Câu hỏi "alarm flapping vì thiếu data lúc thấp tải" thường giải bằng `notBreaching`.
- **Cảnh báo theo TỈ LỆ (%) hoặc kết hợp nhiều metric** → dùng **metric math** trong một alarm (đúng một biểu thức `ReturnData:true`). Đừng nhầm với composite alarm.
- **Composite alarm** kết hợp STATE của các alarm con bằng AND/OR/NOT để giảm noise; KHÔNG hỗ trợ EC2/ASG action, chỉ SNS-style.
- **Alarm action:** EC2 (stop/terminate/reboot/recover), Auto Scaling policy, SNS, Systems Manager. Để alarm tự **recover** EC2 (chuyển hardware) dùng metric `StatusCheckFailed_System`.
- **Anomaly detection** dùng `ANOMALY_DETECTION_BAND` + comparison operator dạng `LessThanLowerOrGreaterThanUpperThreshold` — hợp metric có chu kỳ, không cần ngưỡng tĩnh.
- **Billing alarm** phải tạo ở region **us-east-1** (metric `EstimatedCharges` chỉ phát ở đó) và phải bật "Receive Billing Alerts" trong Billing preferences.
- **Alarm trên metric filter:** không alarm thẳng trên log — phải tạo metric filter biến pattern trong log thành metric, rồi alarm trên metric đó (metric filter chi tiết ở Chương 25).

## Quiz chương 24 (10 câu)

**Câu 1.** Một developer cần cảnh báo khi tỉ lệ lỗi HTTP 5xx của ứng dụng vượt 1% tổng request, bất kể lưu lượng cao hay thấp. Cách nào đúng?
- A. Tạo alarm trên metric `Errors` với threshold cố định 100
- B. Tạo composite alarm gộp alarm `Errors` và alarm `Requests`
- C. Tạo alarm dùng metric math expression `errors/requests*100` với threshold 1
- D. Bật detailed monitoring rồi đặt threshold động

**Câu 2.** EC2 instance chạy app Java. Team cần alarm khi RAM sử dụng vượt 90%. Mặc định không thấy metric memory trong CloudWatch. Nguyên nhân và cách khắc phục?
- A. Phải bật detailed monitoring
- B. Memory không phải metric hypervisor nhìn thấy được; cài CloudWatch Agent để đẩy metric memory
- C. Phải tạo metric filter trên log
- D. EC2 không hỗ trợ alarm trên RAM

**Câu 3.** Một alarm có `evaluation-periods=5`, `datapoints-to-alarm=3`, period=60s. Điều nào đúng?
- A. Cần 5 datapoint liên tiếp vi phạm mới vào ALARM
- B. Trong cửa sổ 5 datapoint gần nhất, chỉ cần 3 datapoint vi phạm là vào ALARM
- C. Alarm đánh giá mỗi 5 phút
- D. Cần đúng 3 datapoint liên tiếp ngay lập tức

**Câu 4.** App đẩy metric chỉ trong giờ làm việc; ban đêm không có datapoint khiến alarm liên tục nhảy sang INSUFFICIENT_DATA rồi gửi noise. Cấu hình nào hợp lý nhất?
- A. `--treat-missing-data breaching`
- B. `--treat-missing-data notBreaching`
- C. Giảm period xuống 10s
- D. Tăng evaluation-periods lên 100

**Câu 5.** Developer muốn alarm period 10 giây cho một custom metric. Yêu cầu bắt buộc là gì?
- A. Bật detailed monitoring
- B. Đẩy metric với `StorageResolution=1` (high-resolution)
- C. Dùng composite alarm
- D. Period 10s không khả thi với bất kỳ metric nào

**Câu 6.** Cần gửi MỘT thông báo duy nhất khi đồng thời cả "CPU cao" VÀ "latency cao" để tránh spam từ hai alarm riêng lẻ. Dùng gì?
- A. Metric math
- B. Anomaly detection
- C. Composite alarm với rule `ALARM(cpu) AND ALARM(latency)`
- D. Một alarm với hai threshold

**Câu 7.** Một developer tạo billing alarm ở region `ap-southeast-1` nhưng không thấy metric `EstimatedCharges`. Vì sao?
- A. Billing metric chỉ tồn tại ở `us-east-1`; phải tạo alarm ở đó và bật Billing Alerts
- B. Cần bật detailed monitoring
- C. Billing alarm cần CloudWatch Agent
- D. Phải dùng composite alarm

**Câu 8.** Muốn EC2 tự động chuyển sang hardware khác khi underlying host của AWS gặp sự cố, không mất dữ liệu EBS. Alarm action nào?
- A. Alarm trên `CPUUtilization` với terminate action
- B. Alarm trên `StatusCheckFailed_System` với EC2 recover action
- C. Alarm trên `StatusCheckFailed_Instance` với reboot action
- D. Composite alarm với stop action

**Câu 9.** Một metric có pattern theo ngày (cao ban ngày, thấp ban đêm). Ngưỡng tĩnh hoặc báo giả ban ngày hoặc bỏ sót ban đêm. Giải pháp tối ưu?
- A. Tăng evaluation-periods
- B. Dùng CloudWatch anomaly detection với `ANOMALY_DETECTION_BAND`
- C. Tạo nhiều alarm cho từng khung giờ
- D. Dùng metric math trung bình động

**Câu 10.** Ứng dụng ghi lỗi vào CloudWatch Logs với dòng chứa "ERROR". Developer muốn alarm khi số dòng ERROR vượt 10/phút. Trình tự đúng?
- A. Tạo alarm thẳng trên log group
- B. Tạo metric filter biến pattern "ERROR" thành metric, rồi tạo alarm trên metric đó
- C. Dùng `PutMetricData` đẩy log
- D. Bật anomaly detection trên log group

### Đáp án & giải thích

**Câu 1 — Đáp án C.** Metric math `errors/requests*100` cho ra tỉ lệ %, threshold 1 độc lập với lưu lượng tuyệt đối. A sai vì threshold cố định 100 lỗi không phản ánh tỉ lệ — cao điểm 100 lỗi có thể bình thường, thấp điểm lại nghiêm trọng. B sai: composite alarm gộp STATE của alarm con, không tính được tỉ lệ giữa hai metric. D sai: detailed monitoring chỉ đổi chu kỳ thu thập, không tạo threshold động.

**Câu 2 — Đáp án B.** Hypervisor chỉ thấy CPU, network, disk I/O ở mức block — KHÔNG thấy RAM hay disk space dùng bên trong OS. Phải cài CloudWatch Agent (unified agent) đẩy `mem_used_percent`, `disk_used_percent` làm custom metric. A sai: detailed monitoring chỉ tăng tần suất metric sẵn có, không thêm RAM. C sai: metric filter dành cho log. D sai: hoàn toàn alarm được sau khi có metric từ agent.

**Câu 3 — Đáp án B.** Cơ chế "M out of N": trong N=5 datapoint gần nhất, chỉ cần M=3 vi phạm (không cần liên tiếp) là vào ALARM. A và D mô tả sai cơ chế. C sai: period=60s nghĩa đánh giá mỗi phút trên cửa sổ trượt, không phải mỗi 5 phút.

**Câu 4 — Đáp án B.** `notBreaching` coi datapoint thiếu như BÌNH THƯỜNG → alarm không nhảy state lúc không có dữ liệu, hết noise. A sai: `breaching` coi thiếu data là vi phạm → alarm kêu suốt đêm. C sai: giảm period làm nhiều khoảng trống hơn, tệ hơn. D sai: tăng evaluation-periods không xử lý gốc rễ là missing data.

**Câu 5 — Đáp án B.** Alarm period 10s/30s chỉ khả dụng với high-resolution metric, tức metric được đẩy bằng `StorageResolution=1`. A sai: detailed monitoring là khái niệm cho EC2 metric (1 phút), không liên quan custom metric resolution. C sai: composite alarm không có period riêng. D sai: 10s khả thi với high-resolution metric.

**Câu 6 — Đáp án C.** Composite alarm với alarm rule logic AND chỉ chuyển ALARM khi cả hai con đều ALARM, và gửi một SNS duy nhất → giảm noise đúng yêu cầu. A sai: metric math tính giá trị số, không kết hợp state alarm. B sai: anomaly detection không kết hợp nhiều alarm. D sai: một alarm chỉ có một metric/expression và một threshold, không AND hai metric độc lập.

**Câu 7 — Đáp án A.** Metric `EstimatedCharges` (namespace `AWS/Billing`) chỉ phát ở `us-east-1`; mọi billing alarm phải tạo ở region đó, và phải bật "Receive Billing Alerts" trong Billing preferences trước. B/C/D sai vì billing alarm không liên quan detailed monitoring, agent, hay composite alarm.

**Câu 8 — Đáp án B.** `StatusCheckFailed_System` báo lỗi hạ tầng AWS (host, network, power); EC2 **recover** action di chuyển instance sang host khỏe khác, giữ nguyên instance ID, private IP và EBS data. A sai: terminate làm mất instance. C sai: `StatusCheckFailed_Instance` là lỗi trong OS/instance, reboot không khắc phục lỗi hardware host. D sai: stop không tự chuyển host và composite alarm không hỗ trợ EC2 action.

**Câu 9 — Đáp án B.** Anomaly detection học pattern lịch sử và tạo band kỳ vọng động theo giờ/ngày; alarm bắn khi ra ngoài band. A sai: tăng evaluation-periods không giải quyết ngưỡng tĩnh không phù hợp theo giờ. C khả thi nhưng cồng kềnh và dễ sai — không tối ưu. D: metric math trung bình động không tự thích nghi theo mùa vụ tốt như anomaly detection.

**Câu 10 — Đáp án B.** CloudWatch không alarm trực tiếp trên log; phải tạo **metric filter** chuyển pattern "ERROR" thành một metric (đếm số match), rồi tạo metric alarm trên metric đó (metric filter chi tiết ở Chương 25). A sai: không alarm thẳng log group. C sai: `PutMetricData` đẩy số liệu, không đẩy log. D sai: anomaly detection áp dụng cho metric, không cho log group.

## Tóm tắt chương

- Một CloudWatch metric được định danh duy nhất bởi **namespace + metric name + tập dimensions**; đổi dimension là tạo metric mới. Metric không xóa thủ công được, tự hết hạn sau 15 tháng.
- **EC2 basic monitoring** = 5 phút (miễn phí), **detailed monitoring** = 1 phút (có phí). EC2 không có metric RAM/disk-space — phải dùng **CloudWatch Agent**.
- **PutMetricData** là API đẩy custom metric; `StorageResolution=1` cho high-resolution (1s) → mở khóa alarm period 10s/30s, còn standard tối thiểu 60s.
- **Alarm có 3 state** (OK/ALARM/INSUFFICIENT_DATA); action chỉ bắn khi state thay đổi, hỗ trợ EC2, Auto Scaling, SNS, SSM.
- Cơ chế **"M datapoints out of N evaluation periods"** giúp giảm cảnh báo giả mà vẫn nhạy với sự cố thật.
- **TreatMissingData** (breaching/notBreaching/ignore/missing) quyết định hành vi khi thiếu datapoint — `notBreaching` thường để chống flapping lúc thấp tải.
- **Metric math** dùng để cảnh báo theo tỉ lệ (%) hoặc kết hợp nhiều metric trong MỘT alarm; đúng một biểu thức đặt `ReturnData:true`.
- **Composite alarm** kết hợp STATE của nhiều alarm bằng AND/OR/NOT để giảm noise; chỉ phát SNS-style, không hỗ trợ EC2/ASG action.
- **Anomaly detection** (`ANOMALY_DETECTION_BAND`) thay ngưỡng tĩnh bằng band kỳ vọng học từ lịch sử — hợp metric có chu kỳ.
- **EC2 recover** (`StatusCheckFailed_System`) chuyển instance sang host khỏe, giữ instance ID/IP/EBS; phân biệt với `StatusCheckFailed_Instance` (lỗi trong OS).
- **Billing alarm** chỉ tạo được ở `us-east-1` (metric `EstimatedCharges`) sau khi bật Billing Alerts.
- Muốn cảnh báo từ nội dung **log** phải qua **metric filter** rồi alarm trên metric kết quả — không alarm trực tiếp trên log group (chi tiết ở Chương 25).
