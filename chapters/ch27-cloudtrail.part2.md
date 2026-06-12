## Hands-on Lab: Tạo trail đa region, bật log file integrity validation, đẩy log sang CloudWatch Logs và điều tra "ai đã xoá resource"

**Mục tiêu lab:** Dựng một CloudTrail trail ghi management events của toàn bộ tài khoản (all regions) xuống S3, bật **log file integrity validation** (digest file ký số để chống chỉnh sửa log), đưa log song song sang **CloudWatch Logs** để truy vấn nhanh, bật **data events** cho một bucket S3, sau đó dùng **Event History** và **CloudWatch Logs Insights** để truy ra danh tính principal đã thực hiện một hành động `DeleteObject`/`DeleteBucket`. Cuối cùng dùng `aws cloudtrail validate-logs` để chứng minh log chưa bị giả mạo.

**Chuẩn bị:**
- AWS CLI v2 đã cấu hình với một IAM principal có quyền `cloudtrail:*`, `s3:*`, `logs:*`, `iam:PassRole`, `iam:CreateRole`/`AttachRolePolicy`.
- Region làm việc: `us-east-1` (lab dùng region này, nhưng trail sẽ là all-region).
- Đặt biến môi trường cho tiện. CloudTrail yêu cầu tên bucket S3 unique toàn cầu nên ta gắn account ID vào tên.

```bash
export AWS_REGION=us-east-1
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export TRAIL_BUCKET="ct-audit-lab-${ACCOUNT_ID}"
export DATA_BUCKET="ct-data-lab-${ACCOUNT_ID}"
export TRAIL_NAME="org-audit-trail"
echo "Account: $ACCOUNT_ID | Trail bucket: $TRAIL_BUCKET"
```

### Bước 1: Tạo bucket S3 nhận log và gắn bucket policy cho CloudTrail

CloudTrail là một service principal (`cloudtrail.amazonaws.com`) ghi file vào bucket của bạn, nên bucket cần resource-based policy cho phép. Nếu thiếu policy này, khi tạo trail bạn sẽ nhận lỗi `InsufficientS3BucketPolicyException`.

```bash
# Tạo bucket nhận log và bucket data để test data events
aws s3api create-bucket --bucket "$TRAIL_BUCKET" --region us-east-1
aws s3api create-bucket --bucket "$DATA_BUCKET" --region us-east-1

# Chặn public access (best practice cho bucket chứa audit log)
aws s3api put-public-access-block --bucket "$TRAIL_BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

Tạo file policy. Lưu ý `aws:SourceArn` ghim đúng ARN của trail (chống confused deputy) và `s3:x-amz-acl=bucket-owner-full-control` là điều kiện bắt buộc CloudTrail tự thêm khi ghi:

```bash
cat > /tmp/ct-bucket-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AWSCloudTrailAclCheck",
      "Effect": "Allow",
      "Principal": {"Service": "cloudtrail.amazonaws.com"},
      "Action": "s3:GetBucketAcl",
      "Resource": "arn:aws:s3:::${TRAIL_BUCKET}",
      "Condition": {"StringEquals": {"aws:SourceArn": "arn:aws:cloudtrail:us-east-1:${ACCOUNT_ID}:trail/${TRAIL_NAME}"}}
    },
    {
      "Sid": "AWSCloudTrailWrite",
      "Effect": "Allow",
      "Principal": {"Service": "cloudtrail.amazonaws.com"},
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::${TRAIL_BUCKET}/AWSLogs/${ACCOUNT_ID}/*",
      "Condition": {
        "StringEquals": {
          "s3:x-amz-acl": "bucket-owner-full-control",
          "aws:SourceArn": "arn:aws:cloudtrail:us-east-1:${ACCOUNT_ID}:trail/${TRAIL_NAME}"
        }
      }
    }
  ]
}
EOF

aws s3api put-bucket-policy --bucket "$TRAIL_BUCKET" --policy file:///tmp/ct-bucket-policy.json
```

### Bước 2: Tạo trail all-region với log file integrity validation

```bash
aws cloudtrail create-trail \
  --name "$TRAIL_NAME" \
  --s3-bucket-name "$TRAIL_BUCKET" \
  --is-multi-region-trail \
  --enable-log-file-validation
```

Output mong đợi (rút gọn) — chú ý `LogFileValidationEnabled: true` và `IsMultiRegionTrail: true`:

```json
{
  "Name": "org-audit-trail",
  "S3BucketName": "ct-audit-lab-123456789012",
  "IncludeGlobalServiceEvents": true,
  "IsMultiRegionTrail": true,
  "TrailARN": "arn:aws:cloudtrail:us-east-1:123456789012:trail/org-audit-trail",
  "LogFileValidationEnabled": true
}
```

Trail mới tạo **chưa bật logging**. Phải gọi `start-logging` riêng (bẫy hay quên):

```bash
aws cloudtrail start-logging --name "$TRAIL_NAME"
aws cloudtrail get-trail-status --name "$TRAIL_NAME" --query IsLogging
# Kỳ vọng: true
```

### Bước 3: Bật data events cho bucket S3 bằng Advanced Event Selectors

Mặc định trail chỉ ghi **management events**. Để bắt thao tác đọc/ghi object (data events) trên `$DATA_BUCKET`, cấu hình advanced event selector. Data events tính phí riêng nên ta chỉ giới hạn đúng một bucket.

```bash
aws cloudtrail put-event-selectors \
  --trail-name "$TRAIL_NAME" \
  --advanced-event-selectors '[
    {
      "Name": "Log S3 data events on data bucket only",
      "FieldSelectors": [
        {"Field": "eventCategory", "Equals": ["Data"]},
        {"Field": "resources.type", "Equals": ["AWS::S3::Object"]},
        {"Field": "resources.ARN", "StartsWith": ["arn:aws:s3:::'"$DATA_BUCKET"'/"]}
      ]
    }
  ]'
```

### Bước 4: Đẩy log song song sang CloudWatch Logs

Event History trong console giữ 90 ngày và không truy vấn được kiểu SQL. Để alert/điều tra theo thời gian thực, đẩy trail sang một log group CloudWatch. CloudTrail cần một IAM role để ghi.

```bash
# Log group nhận sự kiện
aws logs create-log-group --log-group-name /aws/cloudtrail/org-audit

LOG_GROUP_ARN=$(aws logs describe-log-groups \
  --log-group-name-prefix /aws/cloudtrail/org-audit \
  --query 'logGroups[0].arn' --output text)

# Trust policy cho service cloudtrail.amazonaws.com
cat > /tmp/ct-trust.json <<'EOF'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"cloudtrail.amazonaws.com"},"Action":"sts:AssumeRole"}]}
EOF
aws iam create-role --role-name CloudTrail_CWLogs_Role \
  --assume-role-policy-document file:///tmp/ct-trust.json

# Permission policy: cho phép tạo stream và PutLogEvents
cat > /tmp/ct-perm.json <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["logs:CreateLogStream","logs:PutLogEvents"],"Resource":"${LOG_GROUP_ARN%:\*}:*"}]}
EOF
aws iam put-role-policy --role-name CloudTrail_CWLogs_Role \
  --policy-name CWLogsDelivery --policy-document file:///tmp/ct-perm.json

ROLE_ARN=$(aws iam get-role --role-name CloudTrail_CWLogs_Role --query Role.Arn --output text)

# Gắn log group + role vào trail (bỏ hậu tố :* khi truyền --cloud-watch-logs-log-group-arn)
aws cloudtrail update-trail --name "$TRAIL_NAME" \
  --cloud-watch-logs-log-group-arn "$LOG_GROUP_ARN" \
  --cloud-watch-logs-role-arn "$ROLE_ARN"
```

### Bước 5: Sinh hoạt động và điều tra "ai đã xoá object"

Tạo một object rồi xoá nó để mô phỏng hành vi cần điều tra:

```bash
echo "secret report" > /tmp/report.txt
aws s3 cp /tmp/report.txt "s3://${DATA_BUCKET}/report.txt"
aws s3api delete-object --bucket "$DATA_BUCKET" --key report.txt
```

Data events tới S3 nhanh; management events có thể trễ tới ~15 phút lên S3 và vài phút lên CloudWatch Logs. Truy vấn nhanh bằng **Logs Insights** để tìm ai gọi `DeleteObject`:

```bash
QID=$(aws logs start-query \
  --log-group-name /aws/cloudtrail/org-audit \
  --start-time $(($(date +%s) - 3600)) --end-time $(date +%s) \
  --query-string 'fields eventTime, eventName, userIdentity.arn, sourceIPAddress, requestParameters.key | filter eventName = "DeleteObject" | sort eventTime desc | limit 20' \
  --query queryId --output text)

sleep 8
aws logs get-query-results --query-id "$QID"
```

Kết quả trả về `userIdentity.arn` (chính là principal đã xoá), `sourceIPAddress`, và `requestParameters.key = report.txt`. Đây là quy trình kinh điển đề thi mô tả: dùng CloudTrail để xác định **ai (who), khi nào (when), từ đâu (sourceIP), làm gì (eventName), trên resource nào**.

Cách thay thế không cần CloudWatch Logs — `lookup-events` trên Event History (chỉ management events):

```bash
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=DeleteBucket \
  --max-results 5 \
  --query 'Events[].{Time:EventTime,User:Username,Event:EventName}'
```

### Bước 6: Chứng minh log chưa bị giả mạo

Mỗi giờ CloudTrail ghi một **digest file** (ký bằng private key của CloudTrail) liệt kê hash SHA-256 của các log file trong giờ đó, và mỗi digest tham chiếu digest trước nó tạo thành chuỗi không thể đảo. Lệnh validate-logs sẽ tải digest + log file từ S3, tính lại hash và so sánh chữ ký:

```bash
aws cloudtrail validate-logs \
  --trail-arn "arn:aws:cloudtrail:us-east-1:${ACCOUNT_ID}:trail/${TRAIL_NAME}" \
  --start-time $(date -u -v-2H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '2 hours ago' +%Y-%m-%dT%H:%M:%SZ)
```

Output kỳ vọng nếu nguyên vẹn: dòng tổng kết kiểu `Results requested ... validated N digest file(s) ... validated M log file(s)` và **không có** dòng `INVALID`. Nếu ai đó sửa/xoá một log file trong S3, lệnh sẽ báo file đó `INVALID` hoặc thiếu — đó chính là giá trị của integrity validation cho compliance.

### Dọn dẹp tài nguyên

Để tránh phí lưu trữ và phí data events tiếp tục phát sinh:

```bash
# Dừng và xoá trail
aws cloudtrail stop-logging --name "$TRAIL_NAME"
aws cloudtrail delete-trail --name "$TRAIL_NAME"

# Xoá log group
aws logs delete-log-group --log-group-name /aws/cloudtrail/org-audit

# Xoá IAM role
aws iam delete-role-policy --role-name CloudTrail_CWLogs_Role --policy-name CWLogsDelivery
aws iam delete-role --role-name CloudTrail_CWLogs_Role

# Dọn và xoá bucket (phải xoá hết object trước; nếu versioning bật cần xoá cả version)
aws s3 rm "s3://${TRAIL_BUCKET}" --recursive
aws s3 rm "s3://${DATA_BUCKET}" --recursive
aws s3api delete-bucket --bucket "$TRAIL_BUCKET"
aws s3api delete-bucket --bucket "$DATA_BUCKET"
```

> 💡 **Lưu ý dọn dẹp:** Trail bị `delete-trail` chỉ xoá cấu hình trail, KHÔNG xoá các log file đã ghi vào S3. Bạn phải tự dọn bucket. Nếu chỉ muốn tạm dừng tính phí mà giữ cấu hình, dùng `stop-logging`.

## 💡 Exam Tips chương 27

- **Event History luôn bật, miễn phí, giữ 90 ngày** chỉ cho **management events** của region hiện tại. Muốn lưu lâu hơn, sang region/account khác, hay bắt data events → phải tạo **trail**. Trên 90 ngày = trail + S3 (gần như chắc chắn là đáp án).
- **Management events** = control plane (CreateBucket, RunInstances, AssumeRole...), ghi miễn phí 1 bản copy. **Data events** = data plane khối lượng lớn (S3 GetObject/PutObject, Lambda Invoke, DynamoDB item-level) — **mặc định TẮT** và **tính phí**. Câu hỏi "không thấy S3 object-level activity trong CloudTrail" → quên bật data events.
- **Insights events** phát hiện bất thường về tần suất write API (ví dụ đột biến `RunInstances`). Phải bật riêng, tính phí riêng. Đừng nhầm với data events.
- **CloudTrail vs CloudWatch vs X-Ray** — phân biệt kinh điển: CloudTrail = *ai gọi API gì* (audit/governance); CloudWatch = *hệ thống khoẻ không* (metrics/logs/alarms); X-Ray = *request chạy qua đâu, chậm ở đâu* (tracing). "Who deleted/created/modified a resource" → CloudTrail.
- **Log file integrity validation** (`--enable-log-file-validation`) tạo **digest file** ký SHA-256 theo chuỗi hash, dùng `validate-logs` để chứng minh log không bị sửa. Đây là đáp án cho yêu cầu "tamper-proof / prove logs were not altered / compliance".
- **Một trail multi-region** rẻ và đủ cho hầu hết tình huống: tự động bao mọi region hiện tại lẫn region mới thêm sau. Đừng tạo trail riêng từng region nếu đề nói "all regions, kể cả tương lai".
- **Organization trail** tạo từ management account, áp dụng cho toàn bộ account thành viên, member account không tắt/sửa được — đáp án cho "centralized audit across all accounts in the organization".
- **Trail tạo xong chưa tự log** nếu dùng API/CLI `create-trail`; phải `start-logging`. Console thì bật sẵn.
- **Bảo vệ log khỏi xoá:** dùng **S3 Object Lock / MFA Delete / bucket policy** trên bucket log; gửi cross-account sang một "security account" để dù root account gốc bị xâm nhập cũng không xoá được log.
- **Độ trễ:** management events thường lên S3 trong ~15 phút, lên CloudWatch Logs nhanh hơn. CloudTrail **không** real-time tức thì — nếu cần phản ứng tức thì hãy kết hợp **EventBridge** (CloudTrail là nguồn event cho nhiều rule).
- **AWS Config khác CloudTrail:** Config theo dõi *trạng thái cấu hình resource theo thời gian* và *đánh giá compliance* (config rules); CloudTrail theo dõi *các lời gọi API*. Đề hỏi "track configuration changes / compliance history of a resource" → Config; "who made the API call" → CloudTrail.
- **Cross-region/global services:** sự kiện của global service (IAM, STS, CloudFront, Route 53) được ghi vào region `us-east-1` (với `IncludeGlobalServiceEvents`). Đi tìm log IAM mà nhìn nhầm region khác là bẫy.

## Quiz chương 27 (10 câu)

**Câu 1.** A developer cần điều tra một resource bị xoá cách đây 30 ngày và xác định IAM principal nào đã gọi API xoá. Trong tài khoản chưa từng tạo trail nào. Cách nhanh nhất?
- A. Bật một trail mới rồi đợi log xuất hiện
- B. Dùng CloudTrail Event History và lọc theo event name
- C. Truy vấn CloudWatch Logs Insights
- D. Dùng AWS X-Ray service map

**Câu 2.** Một ứng dụng ghi/đọc rất nhiều object vào S3. Team bảo mật muốn audit từng thao tác `GetObject`/`PutObject` ở mức object. Họ tạo trail nhưng không thấy các sự kiện này. Nguyên nhân?
- A. Trail chưa bật `start-logging`
- B. Data events cho S3 chưa được bật trong event selector
- C. Event History chỉ giữ 90 ngày
- D. Cần bật Insights events

**Câu 3.** Yêu cầu compliance: phải chứng minh được log CloudTrail trong S3 KHÔNG bị chỉnh sửa sau khi ghi. Giải pháp nào?
- A. Bật versioning trên bucket
- B. Bật log file integrity validation và dùng `validate-logs`
- C. Mã hoá log bằng SSE-KMS
- D. Bật MFA Delete

**Câu 4.** Tổ chức có 40 account trong AWS Organizations. Cần audit API tập trung, đảm bảo developer ở account thành viên không tắt được logging. Cách nào?
- A. Mỗi account tự tạo trail riêng
- B. Tạo organization trail từ management account
- C. Bật Event History ở mọi account
- D. Dùng AWS Config aggregator

**Câu 5.** Một developer cần được CẢNH BÁO gần như tức thì khi có ai gọi `DeleteTrail` hoặc `StopLogging`. Kiến trúc nào phù hợp nhất?
- A. Truy vấn Event History mỗi giờ bằng cron
- B. CloudTrail → CloudWatch Logs → metric filter → CloudWatch Alarm → SNS
- C. Bật Insights events
- D. Dùng X-Ray annotation

**Câu 6.** Đâu là phân biệt ĐÚNG giữa CloudTrail và CloudWatch?
- A. CloudTrail đo hiệu năng, CloudWatch ghi API calls
- B. CloudTrail ghi API activity (ai làm gì), CloudWatch theo dõi sức khoẻ/metric hệ thống
- C. Cả hai đều là distributed tracing
- D. CloudTrail thay thế hoàn toàn CloudWatch Logs

**Câu 7.** Team cần lưu trữ audit log trong 7 năm cho yêu cầu pháp lý, chi phí thấp nhất. Cách lưu CloudTrail log tối ưu?
- A. Để trong Event History
- B. Trail → S3 với lifecycle policy chuyển sang Glacier Deep Archive
- C. Trail → CloudWatch Logs với retention 7 năm
- D. Export Event History ra CSV hàng tháng

**Câu 8.** Một trail multi-region được tạo ở `us-east-1`. Sau đó công ty bật thêm region `ap-southeast-1` và triển khai dịch vụ ở đó. Cần làm gì để API activity ở region mới được ghi?
- A. Tạo trail mới ở `ap-southeast-1`
- B. Không cần làm gì — trail multi-region tự bao region mới
- C. Chạy lại `update-trail --is-multi-region-trail`
- D. Bật detailed monitoring

**Câu 9.** Yêu cầu: theo dõi LỊCH SỬ THAY ĐỔI CẤU HÌNH của một security group (rule nào được thêm/bớt theo thời gian) và đánh giá nó có tuân thủ chuẩn không. Service nào phù hợp NHẤT?
- A. CloudTrail data events
- B. AWS Config với config rules
- C. CloudWatch metric filter
- D. X-Ray

**Câu 10.** Đội bảo mật lo ngại nếu account chính bị xâm nhập, kẻ tấn công sẽ xoá log CloudTrail để xoá dấu vết. Biện pháp nào giảm thiểu tốt nhất?
- A. Bật Insights events
- B. Gửi log sang bucket S3 ở một account bảo mật riêng (cross-account) có Object Lock
- C. Tăng retention CloudWatch Logs
- D. Bật log file validation là đủ

### Đáp án & giải thích

**Câu 1 — Đáp án B.** Event History luôn bật, miễn phí, giữ **90 ngày** management events và cho lọc theo event name/user — 30 ngày nằm trong cửa sổ này nên là cách nhanh nhất. *A sai:* trail mới chỉ ghi từ lúc bật trở đi, không có dữ liệu quá khứ. *C sai:* nếu chưa có trail đẩy sang CloudWatch Logs thì không có log group nào để truy vấn. *D sai:* X-Ray là tracing hiệu năng, không ghi API call identity.

**Câu 2 — Đáp án B.** Mặc định trail chỉ ghi management events; thao tác object-level của S3 là **data events**, phải bật riêng qua event selector (và tính phí). *A sai:* nếu chưa start-logging thì sẽ không thấy CẢ management events, không chỉ data events. *C sai:* 90 ngày là giới hạn Event History, không liên quan vì sao thiếu data events. *D sai:* Insights events phát hiện bất thường tần suất, không phải để bắt từng GetObject.

**Câu 3 — Đáp án B.** Log file integrity validation tạo digest file ký SHA-256 theo chuỗi hash; `validate-logs` chứng minh log nguyên vẹn — đúng yêu cầu "prove not altered". *A sai:* versioning giữ phiên bản nhưng không chứng minh tính toàn vẹn/không-bị-sửa bằng chữ ký. *C sai:* SSE-KMS bảo mật nội dung khi nghỉ chứ không phát hiện chỉnh sửa. *D sai:* MFA Delete chống xoá chứ không chứng minh nội dung chưa đổi.

**Câu 4 — Đáp án B.** Organization trail tạo từ management account áp dụng cho mọi member account; member account không thể tắt/sửa — đúng yêu cầu tập trung và bất khả tắt. *A sai:* trail riêng từng account thì developer ở account đó vẫn tắt được, không tập trung. *C sai:* Event History không tập trung và chỉ 90 ngày. *D sai:* Config aggregator tổng hợp trạng thái cấu hình, không phải audit API calls.

**Câu 5 — Đáp án B.** Đẩy CloudTrail sang CloudWatch Logs rồi đặt **metric filter** bắt pattern `DeleteTrail`/`StopLogging`, gắn **alarm** → **SNS** cho cảnh báo gần thời gian thực. *A sai:* polling Event History mỗi giờ chậm và thủ công. *C sai:* Insights phát hiện bất thường khối lượng, không nhắm sự kiện cụ thể. *D sai:* X-Ray không liên quan audit.

**Câu 6 — Đáp án B.** CloudTrail = audit API activity (ai gọi gì, khi nào, từ đâu); CloudWatch = metric/log/alarm về sức khoẻ vận hành. *A sai:* đảo ngược vai trò. *C sai:* tracing là X-Ray. *D sai:* chúng bổ trợ nhau, không thay thế.

**Câu 7 — Đáp án B.** Trail → S3, đặt lifecycle chuyển object cũ sang Glacier Deep Archive cho lưu trữ dài hạn chi phí thấp nhất — chuẩn cho yêu cầu 7 năm. *A sai:* Event History chỉ 90 ngày. *C sai:* CloudWatch Logs lưu lâu được nhưng đắt hơn nhiều so với S3/Glacier cho khối lượng audit. *D sai:* export CSV thủ công không bền vững và Event History không đủ dữ liệu lâu.

**Câu 8 — Đáp án B.** Trail multi-region tự động ghi mọi region hiện có và mọi region được bật/triển khai về sau — không cần thao tác thêm. *A sai:* thừa, tạo trùng lặp và tốn phí. *C sai:* trail đã là multi-region rồi. *D sai:* detailed monitoring là khái niệm CloudWatch EC2, không liên quan.

**Câu 9 — Đáp án B.** AWS Config theo dõi *configuration item* theo thời gian (timeline thay đổi của resource) và đánh giá tuân thủ bằng config rules — đúng yêu cầu "lịch sử thay đổi cấu hình + compliance". *A sai:* CloudTrail ghi từng API call chứ không dựng timeline trạng thái resource và không có rule compliance. *C/D sai:* không liên quan đến cấu hình resource.

**Câu 10 — Đáp án B.** Gửi log cross-account sang bucket ở "security account" riêng với S3 Object Lock khiến kẻ tấn công kiểm soát account gốc vẫn không xoá/sửa được log — phòng thủ mạnh nhất. *A sai:* Insights không bảo vệ log khỏi bị xoá. *C sai:* tăng retention CloudWatch Logs không ngăn xoá nếu kẻ tấn công có quyền. *D sai:* validation chỉ *phát hiện* sửa đổi sau sự việc, không *ngăn* xoá; cần kết hợp cách ly account + Object Lock.

## Tóm tắt chương

- CloudTrail ghi lại **mọi lời gọi API** trong tài khoản: ai (userIdentity), khi nào, từ IP nào, hành động gì, trên resource nào — đây là nền tảng audit và governance, không phải công cụ giám sát hiệu năng.
- **Event History** luôn bật, miễn phí, giữ **90 ngày**, chỉ **management events** của region hiện tại. Vượt quá 90 ngày / data events / nhiều region → cần tạo **trail** đẩy xuống S3.
- Ba loại event: **management events** (control plane, free, mặc định bật), **data events** (data plane khối lượng lớn như S3 object, Lambda invoke, DynamoDB item — mặc định TẮT, tính phí), **Insights events** (phát hiện bất thường tần suất write API, tính phí).
- **Trail multi-region** tự bao mọi region hiện tại lẫn tương lai; **organization trail** từ management account audit toàn bộ account thành viên mà họ không tắt được.
- Trail tạo bằng API/CLI phải gọi **start-logging** mới thực sự ghi; bucket S3 nhận log cần **bucket policy** cho `cloudtrail.amazonaws.com`.
- **Log file integrity validation** dùng **digest file** ký SHA-256 theo chuỗi hash + lệnh `validate-logs` để chứng minh log không bị giả mạo — đáp án cho yêu cầu compliance/tamper-proof.
- Đẩy trail sang **CloudWatch Logs** để truy vấn nhanh (Logs Insights) và đặt **metric filter + alarm** cảnh báo gần real-time (ví dụ ai đó gọi StopLogging).
- CloudTrail **không tức thời**: management events lên S3 có thể trễ ~15 phút; cần phản ứng nhanh thì kết hợp **EventBridge** dùng CloudTrail làm nguồn event.
- Phân biệt kinh điển: **CloudTrail** (ai gọi API gì) vs **CloudWatch** (hệ thống khoẻ không) vs **X-Ray** (request đi qua đâu, chậm chỗ nào).
- **AWS Config** bổ trợ CloudTrail: Config theo dõi *trạng thái cấu hình resource theo thời gian* và đánh giá *compliance* qua config rules; CloudTrail theo dõi *các lời gọi API*.
- Bảo vệ tính toàn vẹn audit: gửi log cross-account sang security account, dùng **S3 Object Lock / MFA Delete / bucket policy**, bật log file validation và mã hoá SSE-KMS.
- Sự kiện của **global services** (IAM, STS, CloudFront, Route 53) được ghi ở region `us-east-1` khi `IncludeGlobalServiceEvents` bật — nhớ tìm đúng nơi. **AWS Health Dashboard** là kênh thông báo sự cố/lịch bảo trì của AWS, khác hẳn audit log của CloudTrail.
