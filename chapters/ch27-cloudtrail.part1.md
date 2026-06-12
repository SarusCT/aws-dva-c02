# Chương 27: AWS CloudTrail & Audit

> **Trọng tâm DVA-C02:** CloudTrail là dịch vụ "audit log" của AWS — ghi lại MỌI API call ai gọi, gọi từ đâu, lúc nào, lên resource nào. Trong đề thi, chủ đề này gần như luôn xuất hiện dưới hai dạng: (1) câu hỏi điều tra kiểu "ai đã xoá/sửa một resource — dùng dịch vụ nào để tìm ra?" và (2) câu hỏi phân biệt vai trò giữa **CloudTrail vs CloudWatch vs X-Ray vs Config** (bảng so sánh kinh điển). Bạn cũng cần nắm: management events vs data events vs insights events, event history 90 ngày (miễn phí) vs trail (lưu lâu dài vào S3), log file integrity validation, và cách tích hợp trail → CloudWatch Logs để tạo alarm gần thời gian thực.

## Mục tiêu chương
- Hiểu CloudTrail ghi lại cái gì: cấu trúc một event record, ba loại event (management, data, insights) và khác biệt về chi phí/mặc định.
- Phân biệt **Event History** (90 ngày, miễn phí, chỉ management events) với **Trail** (lưu vô thời hạn vào S3, cấu hình được data events).
- Tạo trail single-region/all-region/organization, deliver tới S3 và CloudWatch Logs; hiểu độ trễ delivery.
- Bật và kiểm tra **log file integrity validation** (digest file, SHA-256/RSA) để chứng minh log không bị giả mạo.
- Thuộc lòng bảng phân biệt **CloudTrail vs CloudWatch vs X-Ray vs Config** — câu hỏi gần như chắc chắn ra.
- Biết quy trình điều tra "ai đã xoá resource" và nhận diện vai trò của **AWS Config** và **AWS Health Dashboard**.

## 27.1 CloudTrail là gì và ghi lại cái gì

CloudTrail trả lời đúng một câu hỏi: **"Ai đã gọi API nào, lúc nào, từ đâu, lên resource nào, kết quả ra sao?"**. Mỗi khi có một hành động trên AWS — qua Console, CLI, SDK, hay một service tự gọi service khác — phần lớn đều đi qua AWS API. CloudTrail chặn (intercept) các API call đó và ghi lại thành **event record** dạng JSON.

Điểm quan trọng nhất phải khắc cốt: **CloudTrail được bật MẶC ĐỊNH cho mọi tài khoản AWS**. Khi tạo account, AWS đã ghi sẵn 90 ngày management events gần nhất vào **Event History** mà bạn không phải làm gì — và không mất phí. Bạn chỉ phải cấu hình thêm khi muốn lưu lâu hơn 90 ngày, muốn data events, hoặc muốn deliver log đi nơi khác để phân tích.

Một event record điển hình (rút gọn) trông như sau:

```json
{
  "eventVersion": "1.09",
  "userIdentity": {
    "type": "IAMUser",
    "principalId": "AIDAEXAMPLE",
    "arn": "arn:aws:iam::111122223333:user/alice",
    "accountId": "111122223333",
    "accessKeyId": "AKIAEXAMPLE",
    "userName": "alice"
  },
  "eventTime": "2026-06-12T03:14:07Z",
  "eventSource": "s3.amazonaws.com",
  "eventName": "DeleteBucket",
  "awsRegion": "ap-southeast-1",
  "sourceIPAddress": "203.0.113.42",
  "userAgent": "aws-cli/2.15.0",
  "requestParameters": { "bucketName": "my-prod-data" },
  "responseElements": null,
  "eventType": "AwsApiCall",
  "readOnly": false,
  "managementEvent": true,
  "eventCategory": "Management",
  "recipientAccountId": "111122223333"
}
```

Những trường bạn sẽ thực sự dùng khi điều tra:
- **`userIdentity`** — ai gọi. Có thể là `IAMUser`, `AssumedRole` (kèm `sessionContext` cho biết role nào và ai assume), `Root`, `AWSService`, hoặc `AWSAccount`. Khi thấy `AssumedRole`, bạn phải lần theo `sessionContext.sessionIssuer.arn` để biết role gốc, và `sourceIPAddress`/`accessKeyId` để truy ai dùng nó.
- **`eventName`** + **`eventSource`** — API gì, của service nào (`DeleteBucket` của `s3.amazonaws.com`).
- **`eventTime`** — luôn theo giờ **UTC**.
- **`sourceIPAddress`**, **`userAgent`** — gọi từ đâu, bằng công cụ gì.
- **`errorCode`/`errorMessage`** — nếu API bị từ chối (ví dụ `AccessDenied`), CloudTrail vẫn ghi lại cả lần gọi thất bại. Đây là cách phát hiện hành vi dò quyền (reconnaissance).

> 💡 **Exam Tip:** CloudTrail ghi cả những API call **bị từ chối** (errorCode `AccessDenied`, `UnauthorizedOperation`). Nếu đề hỏi "làm sao phát hiện ai đó liên tục thử gọi API mà không có quyền", đáp án là phân tích CloudTrail (qua CloudWatch Logs metric filter để tạo alarm), KHÔNG phải VPC Flow Logs hay GuardDuty cấu hình tay.

CloudTrail KHÔNG ghi: nội dung dữ liệu bên trong (ví dụ payload thực của một object S3 hay nội dung một row DynamoDB — nó chỉ ghi metadata của API), không ghi traffic mạng mức packet (đó là VPC Flow Logs), không đo hiệu năng/latency của request giữa các microservice (đó là X-Ray).

## 27.2 Ba loại event: Management, Data, Insights

CloudTrail phân loại event thành ba nhóm. Phân biệt được ba nhóm này là điểm thi rất hay gặp vì chúng khác nhau về **mặc định bật/tắt** và **chi phí**.

**1. Management events (control plane)** — các thao tác quản lý resource: tạo/sửa/xoá/cấu hình. Ví dụ: `RunInstances` (EC2), `CreateBucket` (S3), `AttachRolePolicy` (IAM), `CreateTable` (DynamoDB), `AssumeRole` (STS), `ConfigureLogging`. Đây là loại **bật mặc định** và **miễn phí** cho bản ghi đầu tiên (first copy). Management events còn chia thành **read** (mô tả/list, ví dụ `DescribeInstances`) và **write** (thay đổi, ví dụ `TerminateInstances`); khi tạo trail bạn có thể chọn ghi cả hai, chỉ read, hoặc chỉ write.

**2. Data events (data plane)** — các thao tác trên DỮ LIỆU bên trong resource, có tần suất rất cao. Ví dụ:
- S3 object-level: `GetObject`, `PutObject`, `DeleteObject`.
- Lambda: `Invoke` của một function.
- DynamoDB item-level: `PutItem`, `GetItem`, `DeleteItem`.

Data events **mặc định TẮT** và **tính phí** (vì khối lượng khổng lồ — một bucket có thể có hàng triệu `GetObject`/ngày). Bạn phải bật riêng trên trail và thường thu hẹp phạm vi bằng **advanced event selectors** (ví dụ chỉ ghi `PutObject`/`DeleteObject` của một prefix nhất định) để khỏi tốn tiền.

**3. Insights events** — CloudTrail tự học baseline tần suất các write management API và phát hiện **bất thường về số lượng** (ví dụ đột nhiên `RunInstances` tăng vọt gấp 10 lần, hoặc tỉ lệ `AccessDenied` tăng đột biến). Phải **bật riêng** và **tính phí**. Insights ghi ra một event riêng (`eventCategory: Insight`) cho biết khoảng thời gian bất thường và baseline so với giá trị quan sát.

| Loại event | Mặc định | Chi phí | Ví dụ |
|---|---|---|---|
| Management (write/read) | **Bật** | First copy miễn phí | `CreateBucket`, `TerminateInstances`, `AssumeRole` |
| Data | **Tắt** | Tính phí (theo số event) | S3 `GetObject`, Lambda `Invoke`, DynamoDB `PutItem` |
| Insights | **Tắt** | Tính phí (theo số event phân tích) | Phát hiện spike bất thường write API |

> 💡 **Exam Tip:** Nếu đề nói "developer KHÔNG thấy `GetObject`/`PutObject` của S3 trong CloudTrail" — nguyên nhân gần như chắc chắn là **data events chưa được bật** (mặc định tắt). Còn `CreateBucket`/`DeleteBucket` là management events nên có sẵn. Phân biệt rõ object-level (data) vs bucket-level (management) cho S3.

## 27.3 Event History vs Trail

Đây là cặp khái niệm dễ nhầm nhất.

**Event History** là cái có sẵn trong mọi account: một bản ghi **90 ngày** gần nhất của **management events** ở từng region, xem/tìm kiếm/lọc/tải về (CSV/JSON) ngay trong Console hoặc qua API `LookupEvents`. Đặc điểm:
- Miễn phí, không cần cấu hình.
- Chỉ chứa **management events**, KHÔNG có data events.
- Chỉ giữ **90 ngày** — sau đó tự rơi rớt.
- Không thể tuỳ biến nơi lưu, không có integrity validation, không liên tục chảy ra S3.

**Trail** là cấu hình bạn tạo để CloudTrail **deliver event liên tục ra ngoài** — vào một **S3 bucket** (lưu vô thời hạn) và/hoặc **CloudWatch Logs**. Trail cho phép:
- Lưu log **lâu hơn 90 ngày** (tuỳ S3 lifecycle, có thể nhiều năm).
- Bật **data events** và **insights events**.
- Bật **log file integrity validation**.
- Áp dụng cho **tất cả regions** hoặc **toàn organization**.
- Mã hoá log bằng **SSE-KMS** và gửi sang **account khác** (centralized logging).

Truy vấn Event History 90 ngày bằng CLI (không cần trail):

```bash
# Tìm mọi lần xoá bucket trong 90 ngày qua, lọc theo eventName
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=DeleteBucket \
  --max-results 10 \
  --region ap-southeast-1
```

```javascript
// AWS SDK for JavaScript v3 — tra Event History theo username
import { CloudTrailClient, LookupEventsCommand } from "@aws-sdk/client-cloudtrail";

const client = new CloudTrailClient({ region: "ap-southeast-1" });

// Tìm mọi event do user 'alice' thực hiện
const res = await client.send(new LookupEventsCommand({
  LookupAttributes: [
    { AttributeKey: "Username", AttributeValue: "alice" }
  ],
  MaxResults: 50,
}));

for (const e of res.Events ?? []) {
  // CloudTrailEvent là chuỗi JSON, phải parse mới đọc được chi tiết
  const detail = JSON.parse(e.CloudTrailEvent);
  console.log(e.EventTime, e.EventName, detail.sourceIPAddress);
}
```

> 💡 **Exam Tip:** Câu hỏi rất hay gài: "Cần audit log giữ được **1 năm** (hoặc 'long-term', 'compliance')". Event History chỉ 90 ngày → KHÔNG đủ. Đáp án đúng là **tạo Trail deliver vào S3** (rồi dùng S3 lifecycle chuyển sang Glacier nếu cần rẻ). `LookupEvents` chỉ áp dụng cho 90 ngày management events, không tra cứu được S3 log cũ hơn.

## 27.4 Tạo Trail và deliver tới S3 / CloudWatch Logs

Một trail có thể là:
- **Single-region trail**: chỉ ghi event của region tạo trail.
- **Multi-region (all-region) trail**: ghi event của **mọi region** — đây là khuyến nghị (best practice) và là mặc định khi tạo qua Console. Khi AWS ra region mới, trail multi-region tự động bao luôn.
- **Organization trail**: tạo từ **management account** của AWS Organizations, áp dụng cho **toàn bộ member account**; member account thấy được trail (read-only) nhưng không sửa/xoá được. Lý tưởng cho governance tập trung.

Tạo trail multi-region, deliver tới S3, bật integrity validation và data events S3 bằng CLI:

```bash
# 1) Tạo trail multi-region, có integrity validation
aws cloudtrail create-trail \
  --name org-audit-trail \
  --s3-bucket-name my-cloudtrail-logs-111122223333 \
  --is-multi-region-trail \
  --enable-log-file-validation

# 2) Bắt đầu ghi (trail tạo xong KHÔNG tự chạy — phải start)
aws cloudtrail start-logging --name org-audit-trail

# 3) Bật data events cho S3 (mặc định tắt) — chỉ ghi write trên 1 prefix
aws cloudtrail put-event-selectors \
  --trail-name org-audit-trail \
  --advanced-event-selectors '[
    {
      "Name": "Log S3 PutObject/DeleteObject on sensitive prefix",
      "FieldSelectors": [
        {"Field": "eventCategory", "Equals": ["Data"]},
        {"Field": "resources.type", "Equals": ["AWS::S3::Object"]},
        {"Field": "readOnly", "Equals": ["false"]}
      ]
    }
  ]'
```

> 💡 **Exam Tip:** Bẫy thường gặp: tạo trail xong nhưng **quên `start-logging`**, hoặc S3 bucket policy không cho phép service principal `cloudtrail.amazonaws.com` ghi (`s3:PutObject` với điều kiện `bucket-owner-full-control`). Trên Console, AWS tự thêm bucket policy; làm bằng CLI/CloudFormation thì bạn phải tự gắn. Nếu log không xuất hiện trong S3, kiểm tra hai điều này trước.

**Độ trễ delivery:** CloudTrail KHÔNG real-time. Event thường được deliver tới S3 trong vòng **~15 phút** sau khi API call xảy ra. Nếu cần phản ứng nhanh hơn, dùng **EventBridge** (CloudTrail là một nguồn event cho EventBridge — bạn bắt được API call gần như tức thời để trigger Lambda; chi tiết EventBridge ở Chương 25), hoặc đẩy trail sang CloudWatch Logs để alarm.

**Tích hợp CloudWatch Logs** cho phép biến audit thành cảnh báo gần thời gian thực: trail gửi event vào một log group, bạn tạo **metric filter** trên pattern (ví dụ `{ ($.eventName = "DeleteBucket") }`) rồi gắn **CloudWatch Alarm** + SNS.

```bash
# Bật delivery sang CloudWatch Logs cho trail
aws cloudtrail update-trail \
  --name org-audit-trail \
  --cloud-watch-logs-log-group-arn arn:aws:logs:ap-southeast-1:111122223333:log-group:CloudTrail/AuditLogs:* \
  --cloud-watch-logs-role-arn arn:aws:iam::111122223333:role/CloudTrail_CloudWatchLogs_Role

# Metric filter: đếm các lần TerminateInstances
aws logs put-metric-filter \
  --log-group-name CloudTrail/AuditLogs \
  --filter-name TerminateInstancesCount \
  --filter-pattern '{ ($.eventName = "TerminateInstances") }' \
  --metric-transformations \
    metricName=TerminateInstancesCount,metricNamespace=AuditMetrics,metricValue=1
```

Sau đó tạo alarm trên metric `TerminateInstancesCount` để nhận SNS notification mỗi khi có ai đó hủy EC2 (chi tiết metric filter & alarm ở Chương 24/25).

> 💡 **Exam Tip:** Khi đề muốn **cảnh báo gần thời gian thực** dựa trên một API call cụ thể (ví dụ "gửi email khi có ai sửa Security Group"), có hai đáp án đúng tuỳ ngữ cảnh: (1) CloudTrail → **CloudWatch Logs** → metric filter → alarm → SNS; hoặc (2) **EventBridge rule** match event pattern của CloudTrail → SNS/Lambda. EventBridge nhanh hơn và đơn giản hơn cho một event đơn lẻ; metric filter mạnh hơn khi cần đếm/ngưỡng (ví dụ ">5 lần trong 5 phút").

## 27.5 Log file integrity validation

Khi audit log dùng cho mục đích pháp lý/compliance, bạn phải chứng minh **log không bị ai sửa hay xoá** sau khi ghi. CloudTrail giải quyết bằng **log file integrity validation**.

Cơ chế: khi bật `--enable-log-file-validation`, mỗi giờ CloudTrail tạo thêm một **digest file** đặt trong cùng bucket (thư mục `CloudTrail-Digest/`, tách khỏi log files). Digest file chứa:
- **Hash SHA-256** của từng log file đã deliver trong khoảng thời gian đó.
- Một **chữ ký số** (digital signature) của digest file, ký bằng **private key RSA** của CloudTrail.
- Tham chiếu tới **digest file của giờ trước** → tạo thành một **chuỗi (hash chain)**: nếu ai đó xoá một digest file giữa chuỗi, mắt xích bị đứt và validation phát hiện ngay.

Nhờ vậy bạn có thể chứng minh: (a) một log file cụ thể không bị sửa từ lúc deliver (so hash), (b) không log file nào bị xoá (chuỗi liên tục), (c) không digest file nào bị giả mạo hay xoá.

Kiểm tra tính toàn vẹn bằng CLI:

```bash
# Validate toàn bộ log trong một khoảng thời gian
aws cloudtrail validate-logs \
  --trail-arn arn:aws:cloudtrail:ap-southeast-1:111122223333:trail/org-audit-trail \
  --start-time 2026-06-01T00:00:00Z \
  --end-time 2026-06-12T00:00:00Z
```

Để bảo vệ thêm, người ta thường kết hợp:
- **S3 Object Lock** (compliance mode) hoặc **bucket policy chặn delete** trên bucket chứa log → ngay cả admin cũng không xoá được object.
- **SSE-KMS** mã hoá log; quản lý quyền decrypt qua key policy.
- Bucket log đặt ở **account riêng** (log archive account) mà developer thường không có quyền ghi/xoá.

> 💡 **Exam Tip:** Câu hỏi compliance kinh điển: "Làm sao đảm bảo và CHỨNG MINH được CloudTrail log không bị giả mạo (tampered)?" → Đáp án: **bật log file integrity validation** (digest file + SHA-256 + chữ ký RSA), kết hợp **S3 Object Lock** để chống xoá. Đừng chọn đáp án chỉ nói "bật versioning" hay "encrypt log" — encrypt chống đọc trộm chứ không chứng minh toàn vẹn.

## 27.6 CloudTrail vs CloudWatch vs X-Ray vs Config — bảng phân biệt

Đây là bảng so sánh ra đề gần như mỗi kỳ. Bốn dịch vụ này nghe na ná "monitoring" nhưng trả lời bốn câu hỏi hoàn toàn khác nhau.

| Dịch vụ | Trả lời câu hỏi | Bản chất dữ liệu | Ví dụ điển hình |
|---|---|---|---|
| **CloudTrail** | **AI** đã làm gì (API call), lúc nào, từ đâu | Audit log của API call | "Ai đã xoá bucket này lúc 3h sáng?" |
| **CloudWatch** | Hệ thống đang **khoẻ hay yếu** ra sao (metrics, logs) | Metric chuỗi thời gian + application log | "CPU/error rate đang cao bất thường, alarm" |
| **X-Ray** | Một request **chạy qua đâu, chậm ở đâu** | Distributed trace giữa microservice | "API trả chậm — nghẽn ở Lambda hay DynamoDB?" |
| **AWS Config** | Resource **được cấu hình thế nào và đổi ra sao theo thời gian**; có tuân thủ rule không | Snapshot cấu hình + lịch sử thay đổi | "SG này từng mở port 22 ra 0.0.0.0/0 khi nào?" |

Cách nhớ nhanh bằng từ khoá:
- "**who** / **API call** / **audit** / **deleted/created by whom**" → **CloudTrail**.
- "**metric** / **alarm** / **CPU** / **logs of application** / **threshold**" → **CloudWatch**.
- "**trace** / **latency** / **service map** / **bottleneck** / **end-to-end request**" → **X-Ray** (chi tiết ở Chương 26).
- "**configuration** / **compliance** / **resource history** / **conformance** / **drift của resource**" → **AWS Config**.

Một điểm tinh tế hay gài: **CloudTrail vs Config**. Cả hai đều "theo dõi thay đổi", nhưng:
- CloudTrail = **hành động (verb)**: ghi lại *sự kiện* API "ai gọi `ModifySecurityGroupRules`".
- Config = **trạng thái (state)**: ghi lại *cấu hình hiện tại* của SG và *lịch sử các trạng thái*, đánh giá *tuân thủ* (ví dụ "SG không được mở port 22 ra internet"). Config trả lời "resource trông như thế nào tại thời điểm X" còn CloudTrail trả lời "ai đã thay đổi nó". Hai cái bổ trợ nhau: thấy SG bị mở port qua Config → tra CloudTrail để biết ai làm.

> 💡 **Exam Tip:** Nếu đề hỏi "ghi lại **cấu hình** resource và đánh giá **compliance/tuân thủ** theo rule (ví dụ: tất cả EBS phải được mã hoá)" → **AWS Config** (không phải CloudTrail). Nếu hỏi "ai đã **thực hiện** thay đổi đó" → **CloudTrail**. Từ khoá "compliance/configuration history" nghiêng về Config; "who/API call" nghiêng về CloudTrail.

## 27.7 Điều tra "ai đã xoá resource" — quy trình thực tế

Tình huống war story rất hay ra đề: sáng ra phát hiện một bảng DynamoDB production biến mất, hoặc một bucket bị xoá. Quy trình điều tra chuẩn:

**Bước 1 — Khoanh vùng nhanh bằng Event History (90 ngày).** Nếu sự việc trong 90 ngày và là management event (`DeleteTable`, `DeleteBucket`, `TerminateInstances`), dùng `LookupEvents` lọc theo `EventName` hoặc `ResourceName`:

```bash
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=ResourceName,AttributeValue=my-prod-table \
  --start-time 2026-06-10T00:00:00Z \
  --end-time 2026-06-12T00:00:00Z
```

**Bước 2 — Đọc `userIdentity`.** Nếu là `IAMUser` → có ngay `userName`. Nếu là `AssumedRole` → lần theo `sessionContext.sessionIssuer.arn` (role nào) và `sessionContext.attributes` (lúc nào assume, có MFA không), kết hợp `sourceIPAddress` để biết gọi từ EC2/Lambda/máy cá nhân nào.

**Bước 3 — Nếu cũ hơn 90 ngày hoặc là data event**, Event History không đủ; phải truy vấn log đã lưu trong **S3** bằng **Amazon Athena** (CloudTrail tích hợp sẵn, tạo bảng Athena trỏ vào prefix log để chạy SQL trên hàng triệu event — chi tiết Athena ở Chương 48). Đây chính là lý do phải tạo trail từ trước; nếu chưa từng tạo trail và sự việc ngoài 90 ngày thì **không còn cách nào** lấy lại log.

```sql
-- Truy vấn CloudTrail log trong Athena: tìm ai gọi DeleteTable
SELECT eventtime, useridentity.arn, sourceipaddress, requestparameters
FROM cloudtrail_logs
WHERE eventname = 'DeleteTable'
  AND eventtime BETWEEN '2026-03-01T00:00:00Z' AND '2026-03-31T23:59:59Z';
```

> 💡 **Exam Tip:** "Cần phân tích **lượng lớn** CloudTrail log đã lưu trong S3 bằng **SQL**" → **Amazon Athena** (rẻ, serverless, query trực tiếp trên S3). Đừng chọn "load vào Redshift" hay "viết script tải hết về parse" — Athena là đáp án chuẩn cho query ad-hoc trên CloudTrail log trong S3.

## 27.8 AWS Config và AWS Health Dashboard (mức nhận diện)

Hai dịch vụ này nằm trong phạm vi chương ở mức **nhận diện vai trò** để không nhầm với CloudTrail.

**AWS Config** đánh giá và ghi lại **cấu hình resource theo thời gian**. Các khái niệm cần nhận diện:
- **Configuration Item (CI)**: snapshot cấu hình một resource tại một thời điểm.
- **Configuration Recorder**: thành phần liên tục ghi lại CI khi resource thay đổi.
- **Config Rules**: quy tắc đánh giá tuân thủ — **managed rules** (AWS dựng sẵn, ví dụ `encrypted-volumes`, `s3-bucket-public-read-prohibited`) hoặc **custom rules** (Lambda-backed). Resource được đánh dấu `COMPLIANT`/`NON_COMPLIANT`.
- **Remediation**: tự động sửa khi non-compliant (qua SSM Automation).
- Config trả lời: "Resource này có tuân thủ chính sách không? Nó đã từng được cấu hình thế nào?". Config thường **dùng chung với CloudTrail**: Config phát hiện *trạng thái sai*, CloudTrail cho biết *ai đã gây ra*.

**AWS Health Dashboard** (trước đây gọi Personal Health Dashboard) cho biết **tình trạng dịch vụ AWS ảnh hưởng tới TÀI KHOẢN của bạn**: sự cố region, lịch bảo trì (maintenance) ảnh hưởng EC2/RDS của bạn, EBS volume cần thay phần cứng, cảnh báo deprecation. Phân biệt với **Service Health Dashboard** (public, tình trạng dịch vụ chung toàn AWS, không gắn account). Health Dashboard phát event ra **EventBridge** để bạn tự động hoá phản ứng (ví dụ nhận thông báo khi EC2 của bạn sắp bị retire).

| Dịch vụ | Vai trò gọn | Ra đề khi đề nói... |
|---|---|---|
| **AWS Config** | Theo dõi cấu hình & compliance của resource | "configuration history", "compliance rule", "resource đã đổi cấu hình thế nào" |
| **AWS Health Dashboard** | Tình trạng sức khoẻ dịch vụ AWS ảnh hưởng account bạn | "scheduled maintenance", "EC2 retirement", "AWS service event ảnh hưởng tài khoản tôi" |
| **CloudTrail** | Ai gọi API gì | "who did", "audit API activity", "deleted by whom" |

> 💡 **Exam Tip:** Đừng nhầm **AWS Health Dashboard** (sức khoẻ dịch vụ, maintenance, retirement của tài khoản bạn) với **CloudWatch** (metric/alarm của resource bạn) hay **CloudTrail** (audit API). Khi đề nhắc "**scheduled maintenance**", "**instance retirement notification**", "**AWS-side event**" → AWS Health Dashboard (và route qua EventBridge để tự động hoá).

CuốI cùng, một sự thật hữu ích cho cả thi lẫn thực tế: CloudTrail là **global service trong console nhưng event delivery theo region** — trail multi-region gom toàn bộ về một bucket, nhưng một số global service (IAM, STS, CloudFront, Route 53) phát event chung và CloudTrail ghi chúng vào region **us-east-1** (chính xác là gắn cờ `Global Service Events`). Vì vậy khi điều tra hành vi IAM/STS, hãy nhớ event đó nằm ở us-east-1 trong trail multi-region — đây là chi tiết hay bị bỏ sót khi tra cứu thủ công.
