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
