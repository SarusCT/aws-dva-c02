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
