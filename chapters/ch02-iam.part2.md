## Hands-on Lab: Xây dựng mô hình phân quyền IAM hoàn chỉnh cho team dev

**Mục tiêu lab:** Tạo group `Developers` với customer managed policy giới hạn quyền S3 theo Condition; tạo user kèm console password + access key; tạo IAM Role cho EC2 đọc S3 và kiểm chứng cơ chế explicit deny; cuối cùng audit bằng Credential Report và Access Advisor.

**Chuẩn bị:**
- AWS account với user/role có quyền admin (đừng dùng root — root chỉ để tạo admin đầu tiên).
- AWS CLI v2 đã cấu hình (`aws sts get-caller-identity` phải trả về ARN của bạn). Cách cấu hình chi tiết ở Chương 3.
- Region bất kỳ — IAM là dịch vụ **global**, nhưng ta sẽ tạo 1 bucket S3 để test nên hãy cố định, ví dụ `ap-southeast-1`.

### Bước 1: Tạo group và customer managed policy

Tạo group trước — best practice là gắn policy vào group, không gắn trực tiếp vào user:

```bash
aws iam create-group --group-name Developers
```

Output mong đợi (rút gọn):

```json
{
  "Group": {
    "GroupName": "Developers",
    "Arn": "arn:aws:iam::123456789012:group/Developers",
    "CreateDate": "2026-06-12T01:00:00+00:00"
  }
}
```

Tạo policy cho phép thao tác S3 nhưng **chỉ khi request đi qua HTTPS** và chỉ trên bucket lab. Lưu file `dev-s3-policy.json`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowListBuckets",
      "Effect": "Allow",
      "Action": ["s3:ListAllMyBuckets", "s3:GetBucketLocation"],
      "Resource": "*"
    },
    {
      "Sid": "AllowLabBucketRW",
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:GetObject", "s3:PutObject"],
      "Resource": [
        "arn:aws:s3:::iam-lab-<account-id>",
        "arn:aws:s3:::iam-lab-<account-id>/*"
      ],
      "Condition": {
        "Bool": { "aws:SecureTransport": "true" }
      }
    },
    {
      "Sid": "DenyDelete",
      "Effect": "Deny",
      "Action": "s3:DeleteObject",
      "Resource": "arn:aws:s3:::iam-lab-<account-id>/*"
    }
  ]
}
```

Chú ý cấu trúc: `ListBucket` tác động lên **bucket ARN** (không có `/*`), còn `GetObject`/`PutObject` tác động lên **object ARN** (`/*`). Viết sai resource là lỗi phổ biến nhất khi policy "không hoạt động". Tạo policy và gắn vào group:

```bash
aws iam create-policy \
  --policy-name DevS3LabPolicy \
  --policy-document file://dev-s3-policy.json

aws iam attach-group-policy \
  --group-name Developers \
  --policy-arn arn:aws:iam::123456789012:policy/DevS3LabPolicy
```

`create-policy` trả về `"DefaultVersionId": "v1"` — mỗi lần update policy sẽ tạo version mới, tối đa **5 version** mỗi managed policy; muốn sửa lần thứ 6 phải xoá bớt version cũ.

### Bước 2: Tạo user, console password và access key

```bash
aws iam create-user --user-name dev-thao

aws iam add-user-to-group --user-name dev-thao --group-name Developers

# Console password, bắt đổi khi đăng nhập lần đầu
aws iam create-login-profile \
  --user-name dev-thao \
  --password 'TempP@ssw0rd-2026' \
  --password-reset-required

# Access key cho programmatic access
aws iam create-access-key --user-name dev-thao
```

Output `create-access-key` chứa `SecretAccessKey` — **chỉ hiển thị đúng một lần này**, không có API nào lấy lại được; mất là phải tạo key mới. Mỗi user tối đa **2 access keys** (để phục vụ rotation: tạo key mới → chuyển ứng dụng sang → deactivate key cũ → xoá).

Kiểm tra password policy của account (ảnh hưởng `create-login-profile`):

```bash
aws iam get-account-password-policy
```

Nếu trả về `NoSuchEntity` nghĩa là account đang dùng default policy. Đặt policy chặt hơn:

```bash
aws iam update-account-password-policy \
  --minimum-password-length 14 \
  --require-symbols --require-numbers \
  --require-uppercase-characters --require-lowercase-characters \
  --max-password-age 90 \
  --password-reuse-prevention 5
```

### Bước 3: Tạo bucket và kiểm chứng quyền bằng policy simulator

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
aws s3 mb s3://iam-lab-$ACCOUNT_ID --region ap-southeast-1
echo "hello iam" > test.txt
```

Thay vì đăng nhập bằng user mới, dùng **IAM Policy Simulator** qua CLI để kiểm tra nhanh:

```bash
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::$ACCOUNT_ID:user/dev-thao \
  --action-names s3:PutObject s3:DeleteObject \
  --resource-arns arn:aws:s3:::iam-lab-$ACCOUNT_ID/test.txt
```

Output mong đợi:

```json
{
  "EvaluationResults": [
    { "EvalActionName": "s3:PutObject", "EvalDecision": "allowed" },
    { "EvalActionName": "s3:DeleteObject", "EvalDecision": "explicitDeny" }
  ]
}
```

`explicitDeny` (không phải `implicitDeny`) — statement `DenyDelete` thắng mọi Allow, đúng logic evaluation: **explicit deny > allow > implicit deny**. Dù sau này có gắn thêm `AdministratorAccess` cho user, `DeleteObject` trên bucket này vẫn bị chặn chừng nào policy Deny còn đó.

Test thật bằng access key của `dev-thao` (dùng biến môi trường để không đụng profile chính):

```bash
AWS_ACCESS_KEY_ID=AKIA... AWS_SECRET_ACCESS_KEY=... \
  aws s3 cp test.txt s3://iam-lab-$ACCOUNT_ID/test.txt
# => upload: ./test.txt to s3://iam-lab-.../test.txt

AWS_ACCESS_KEY_ID=AKIA... AWS_SECRET_ACCESS_KEY=... \
  aws s3 rm s3://iam-lab-$ACCOUNT_ID/test.txt
# => AccessDenied (explicit deny)
```

Lưu ý: user mới tạo đôi khi mất vài giây mới dùng được — IAM là eventually consistent.

### Bước 4: Tạo IAM Role cho EC2

Role gồm 2 nửa: **trust policy** (ai được assume) và **permission policy** (assume rồi làm được gì). Lưu `ec2-trust.json`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "ec2.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

```bash
aws iam create-role \
  --role-name EC2S3ReadRole \
  --assume-role-policy-document file://ec2-trust.json

aws iam attach-role-policy \
  --role-name EC2S3ReadRole \
  --policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess

# EC2 không gắn role trực tiếp — phải qua instance profile
aws iam create-instance-profile --instance-profile-name EC2S3ReadProfile
aws iam add-role-to-instance-profile \
  --instance-profile-name EC2S3ReadProfile \
  --role-name EC2S3ReadRole
```

Tạo qua console thì instance profile được tạo ngầm cùng tên; qua CLI/CloudFormation phải tự tạo — điểm hay gây lúng túng. Nếu bạn có sẵn instance EC2, gắn thử:

```bash
aws ec2 associate-iam-instance-profile \
  --instance-id i-0abc123 \
  --iam-instance-profile Name=EC2S3ReadProfile
```

Trên instance, SDK/CLI tự lấy temporary credentials qua instance metadata (IMDSv2, chi tiết Chương 4) — không một access key nào nằm trên máy. Đây chính là đáp án mẫu cho mọi câu hỏi "EC2 cần gọi AWS service một cách an toàn".

### Bước 5: Audit với Credential Report và Access Advisor

```bash
aws iam generate-credential-report
# Đợi vài giây cho state = COMPLETE rồi:
aws iam get-credential-report --query Content --output text | base64 -d > report.csv
```

File CSV liệt kê **toàn bộ user** của account: `password_enabled`, `mfa_active`, `access_key_1_last_used_date`, `access_key_1_last_rotated`... Dòng `dev-thao` sẽ có `mfa_active = false` — trong thực tế đây là thứ bạn quét định kỳ để tìm key lâu không rotate và user chưa bật MFA.

Access Advisor xem **theo từng user/role**, trả lời "principal này đã thực sự đụng vào service nào, lần cuối khi nào":

```bash
JOB_ID=$(aws iam generate-service-last-accessed-details \
  --arn arn:aws:iam::$ACCOUNT_ID:user/dev-thao \
  --query JobId --output text)

aws iam get-service-last-accessed-details --job-id $JOB_ID
```

Output liệt kê `ServiceName: Amazon S3` với `LastAuthenticated` — các service được cấp quyền nhưng `LastAuthenticated` rỗng là ứng viên để thu hẹp policy theo nguyên tắc least privilege.

### Dọn dẹp tài nguyên

Thứ tự quan trọng — IAM không cho xoá entity còn dependency:

```bash
# User: xoá key, login profile, gỡ khỏi group trước
KEY_ID=$(aws iam list-access-keys --user-name dev-thao \
  --query 'AccessKeyMetadata[0].AccessKeyId' --output text)
aws iam delete-access-key --user-name dev-thao --access-key-id $KEY_ID
aws iam delete-login-profile --user-name dev-thao
aws iam remove-user-from-group --user-name dev-thao --group-name Developers
aws iam delete-user --user-name dev-thao

# Group: detach policy trước
aws iam detach-group-policy --group-name Developers \
  --policy-arn arn:aws:iam::$ACCOUNT_ID:policy/DevS3LabPolicy
aws iam delete-group --group-name Developers
aws iam delete-policy --policy-arn arn:aws:iam::$ACCOUNT_ID:policy/DevS3LabPolicy

# Role: gỡ khỏi instance profile, detach policy
aws iam remove-role-from-instance-profile \
  --instance-profile-name EC2S3ReadProfile --role-name EC2S3ReadRole
aws iam delete-instance-profile --instance-profile-name EC2S3ReadProfile
aws iam detach-role-policy --role-name EC2S3ReadRole \
  --policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess
aws iam delete-role --role-name EC2S3ReadRole

# Bucket
aws s3 rb s3://iam-lab-$ACCOUNT_ID --force
```

IAM miễn phí, nhưng dọn sạch để account không rác và không sót access key sống.

## 💡 Exam Tips chương 2

- **Explicit deny luôn thắng.** Bất kể bao nhiêu Allow ở identity-based hay resource-based policy, một `"Effect": "Deny"` khớp là request bị chặn. Mặc định mọi thứ là implicit deny.
- Trong cùng một account, request được phép nếu **identity-based HOẶC resource-based policy cho phép** (union). Cross-account thì cần **cả hai bên** cho phép (chi tiết ở Chương 45).
- Câu hỏi "ứng dụng trên EC2/Lambda/ECS cần gọi AWS service" → đáp án gần như luôn là **IAM Role**, không bao giờ là hardcode access key, không bỏ key vào user data/AMI/env file.
- Đề cho đoạn JSON policy và hỏi "user làm được gì?" → soi 3 thứ theo thứ tự: có statement Deny khớp không; `Action` có khớp không; `Resource` là bucket ARN hay object ARN (`s3:ListBucket` cần bucket ARN, `s3:GetObject` cần `/*`).
- IAM user dùng cho **người/định danh dài hạn**, role dùng cho **service và truy cập tạm thời**. "Temporary credentials" trong đề → role/STS.
- Group **không lồng nhau được** (không có group trong group) và group **không phải principal** — không thể đặt group vào `Principal` của resource-based policy hay trust policy.
- Inline policy gắn chết 1-1 với một user/role/group, xoá entity là mất; **customer managed policy** tái sử dụng được, có versioning (tối đa 5 versions, rollback được). Đề hỏi "reusable, dễ quản lý" → managed policy.
- MFA: đề thích tình huống ép MFA bằng condition `"aws:MultiFactorAuthPresent": "true"` cho hành động nhạy cảm (xoá object, đổi hạ tầng). Nhớ thiết bị: virtual MFA, FIDO2/passkey, hardware TOTP.
- **Credential Report** = CSV mức **toàn account** về trạng thái credentials (password, key, MFA, ngày rotate). **Access Advisor** = mức **từng principal**, service nào được phép và lần cuối truy cập — dùng để thu hẹp quyền. Đề đánh tráo hai cái này thường xuyên.
- Access key bị lộ (push lên GitHub): bước 1 là **deactivate/xoá key ngay**, sau đó kiểm tra CloudTrail xem key đã bị dùng làm gì — không phải "đổi password" hay "mở ticket support".
- Trust policy trả lời "**ai được assume role**", permission policy trả lời "**assume rồi làm được gì**". Lỗi `AccessDenied` khi assume role thường do trust policy, không phải permission policy.
- Root user: chỉ dùng cho vài tác vụ đặc thù (đổi support plan, đóng account...); bật MFA cho root và **không tạo access key cho root** — câu best practice kinh điển.

## Quiz chương 2 (10 câu)

**Câu 1.** Một developer được gắn 2 policy. Policy A: Allow `s3:*` trên `arn:aws:s3:::app-data/*`. Policy B: Deny `s3:DeleteObject` trên `arn:aws:s3:::app-data/*`. Developer gọi `DeleteObject` trên `app-data/file.txt`. Kết quả?
- A. Thành công vì Policy A có `s3:*`
- B. Thành công vì policy gắn sau ghi đè policy gắn trước
- C. Bị từ chối vì explicit deny luôn thắng allow
- D. Bị từ chối vì `s3:*` không bao gồm `DeleteObject`

**Câu 2.** Ứng dụng Node.js chạy trên EC2 cần đọc/ghi DynamoDB. Cách cấu hình credentials an toàn nhất theo best practice?
- A. Tạo IAM user, lưu access key vào file `.env` trên instance
- B. Gắn IAM Role có quyền DynamoDB vào instance qua instance profile
- C. Nhúng access key vào EC2 User Data script
- D. Dùng access key của root user vì luôn đủ quyền

**Câu 3.** Policy sau cấp quyền gì?
```json
{ "Effect": "Allow", "Action": "s3:GetObject",
  "Resource": "arn:aws:s3:::my-bucket" }
```
- A. Đọc mọi object trong `my-bucket`
- B. Không cho đọc object nào — resource phải là `arn:aws:s3:::my-bucket/*`
- C. Liệt kê object trong bucket
- D. Policy không hợp lệ, IAM từ chối lưu

**Câu 4.** Security team yêu cầu: liệt kê toàn bộ IAM user của account kèm trạng thái MFA và ngày access key được rotate gần nhất, xuất ra file để audit. Dùng gì?
- A. IAM Access Advisor
- B. IAM Credential Report
- C. AWS CloudTrail event history
- D. IAM Policy Simulator

**Câu 5.** Một developer cần thu hẹp quyền cho role `app-role` theo least privilege bằng cách xác định những service đã được cấp quyền nhưng **chưa từng được role sử dụng**. Công cụ phù hợp nhất?
- A. Credential Report
- B. Access Advisor (service last accessed data)
- C. VPC Flow Logs
- D. AWS Config

**Câu 6.** Trong trust policy của một IAM Role dành cho Lambda, trường `Principal` nên là gì?
- A. `{ "AWS": "arn:aws:iam::123456789012:group/Developers" }`
- B. `{ "Service": "lambda.amazonaws.com" }`
- C. `{ "Service": "ec2.amazonaws.com" }`
- D. `"*"` để mọi service dùng được

**Câu 7.** Một access key của IAM user vừa bị commit nhầm lên repository GitHub public. Hành động ĐẦU TIÊN nên làm?
- A. Xoá repository GitHub
- B. Deactivate/xoá access key đó ngay lập tức
- C. Đổi console password của user
- D. Gắn thêm policy Deny tất cả cho user

**Câu 8.** Công ty yêu cầu thao tác `s3:DeleteObject` trên bucket production chỉ được thực hiện khi user đã xác thực MFA. Cách triển khai?
- A. Bật MFA Delete trên từng object
- B. Thêm statement Deny `s3:DeleteObject` với condition `"BoolIfExists": {"aws:MultiFactorAuthPresent": "false"}`
- C. Tạo group MFA-Users và bỏ quyền S3 khỏi các group khác
- D. Bật default encryption trên bucket

**Câu 9.** Một developer trong group `Developers` (gắn policy Allow `dynamodb:*`) báo lỗi `AccessDenied` khi gọi `dynamodb:DeleteTable`. Nguyên nhân khả dĩ nhất?
- A. Policy của group chưa propagate, cần đợi 24 giờ
- B. Một policy khác (inline hoặc group khác) có explicit deny `dynamodb:DeleteTable` khớp với user
- C. `dynamodb:*` không bao gồm `DeleteTable`
- D. Group không thể cấp quyền DynamoDB

**Câu 10.** Team có 40 developer cần cùng một bộ quyền, bộ quyền này thay đổi vài tháng một lần và còn dùng cho team khác. Cách quản lý ít công sức nhất?
- A. Gắn inline policy giống nhau vào từng user
- B. Tạo customer managed policy, gắn vào group, đưa các user vào group
- C. Tạo 40 IAM role, mỗi developer assume một role
- D. Dùng chung 1 IAM user với 1 access key cho cả team

### Đáp án & giải thích

**Câu 1 — Đáp án C.** Logic evaluation: explicit deny > allow > implicit deny. Policy B Deny khớp action + resource nên chặn request. A sai vì Allow không bao giờ ghi đè được Deny. B sai vì IAM không có khái niệm thứ tự ưu tiên theo thời điểm gắn policy — mọi policy được đánh giá đồng thời. D sai vì wildcard `s3:*` thực tế bao gồm `DeleteObject`, nhưng điều đó không cứu được khi có Deny.

**Câu 2 — Đáp án B.** IAM Role + instance profile cấp temporary credentials tự rotate qua instance metadata, không lưu secret trên máy. A sai: key tĩnh trong `.env` dễ lộ, phải tự rotate. C sai: User Data lưu plain text, ai có quyền `DescribeInstanceAttribute` đọc được. D sai kép: root key là điều cấm kỵ số một trong best practices.

**Câu 3 — Đáp án B.** `s3:GetObject` là action mức object, cần resource dạng `arn:aws:s3:::my-bucket/*`. Khớp với bucket ARN không có `/*` nên không request đọc object nào match — kết quả là implicit deny. A sai vì thiếu `/*`. C sai: liệt kê là `s3:ListBucket` (action khác). D sai: policy vẫn hợp lệ về cú pháp, IAM lưu bình thường — nó chỉ không có tác dụng như mong muốn, đây chính là cái bẫy.

**Câu 4 — Đáp án B.** Credential Report là file CSV mức account, mỗi dòng một user với trạng thái password, access key, ngày rotate, MFA — đúng nhu cầu audit hàng loạt. A sai: Access Advisor xem theo từng principal về service đã truy cập, không nói về MFA/rotation. C sai: CloudTrail ghi API calls, không tổng hợp trạng thái credentials. D sai: Policy Simulator chỉ kiểm tra một policy cho phép/chặn action cụ thể.

**Câu 5 — Đáp án B.** Access Advisor hiển thị service được cấp quyền kèm `LastAuthenticated` — service nào trống là chưa từng dùng, ứng viên để cắt khỏi policy. A sai: Credential Report nói về credentials, không nói về service usage. C sai: Flow Logs ghi network traffic trong VPC, không liên quan IAM. D sai: AWS Config theo dõi cấu hình resource thay đổi theo thời gian, không phân tích quyền đã dùng.

**Câu 6 — Đáp án B.** Trust policy của role cho Lambda phải tin service principal `lambda.amazonaws.com` để Lambda service assume role thay function. A sai: group không phải principal, không thể xuất hiện trong trust policy. C sai: `ec2.amazonaws.com` dành cho EC2 — Lambda sẽ không assume được. D sai: `"*"` cho phép bất kỳ ai assume — lỗ hổng nghiêm trọng.

**Câu 7 — Đáp án B.** Vô hiệu hoá key là cách duy nhất chặn ngay kẻ đã clone repo; bot quét GitHub tìm key chỉ mất vài phút. A sai: xoá repo không xoá được các bản clone/cache đã tồn tại. C sai: console password độc lập với access key, đổi password không vô hiệu key. D sai: Deny-all có chặn được nhưng chậm và phức tạp hơn thao tác deactivate một lệnh; key lộ thì vòng đời của nó phải kết thúc, không chỉ bị chặn tạm.

**Câu 8 — Đáp án B.** Statement Deny với `aws:MultiFactorAuthPresent: false` (dùng `BoolIfExists` để bắt cả trường hợp key không có context MFA) chặn delete khi chưa MFA — pattern chuẩn AWS khuyến nghị. A sai: MFA Delete là tính năng versioning cấp bucket, cấu hình bởi root cho thao tác xoá version/tắt versioning, không phải condition linh hoạt theo policy (chi tiết Chương 14). C sai: phân nhóm không kiểm tra được trạng thái MFA tại thời điểm request. D sai: encryption không liên quan xác thực.

**Câu 9 — Đáp án B.** User có thể thuộc nhiều group (tối đa 10) và có inline policy; chỉ cần một explicit deny khớp ở bất kỳ đâu là `AccessDenied` dù group Developers Allow `dynamodb:*`. A sai: IAM eventually consistent ở mức giây, không phải 24 giờ. C sai: wildcard `dynamodb:*` bao gồm mọi action DynamoDB kể cả `DeleteTable`. D sai: group cấp quyền mọi service bình thường thông qua policy gắn vào nó.

**Câu 10 — Đáp án B.** Customer managed policy tái sử dụng được trên nhiều group/role, có versioning để cập nhật một chỗ áp dụng mọi nơi; group giúp thêm/bớt người chỉ bằng một lệnh. A sai: 40 inline policy là 40 chỗ phải sửa mỗi lần thay đổi, và inline không tái sử dụng được. C sai: role cho con người dùng dài hạn hằng ngày trong account là thừa phức tạp ở ngữ cảnh này, và 40 role vẫn là 40 chỗ gắn policy. D sai: dùng chung credentials vi phạm best practice cơ bản — mất khả năng audit theo từng người, một key lộ là cả team bị ảnh hưởng.

## Tóm tắt chương

- IAM là dịch vụ global, miễn phí, quản lý **authentication** (bạn là ai) và **authorization** (bạn được làm gì) cho toàn bộ AWS account.
- Bốn thực thể chính: **User** (định danh dài hạn cho người), **Group** (gom user để gắn policy, không lồng nhau, không phải principal), **Role** (định danh assume được, credentials tạm thời), **Policy** (tài liệu JSON định nghĩa quyền).
- Cấu trúc policy JSON: `Version` ("2012-10-17"), `Statement` gồm `Sid`/`Effect`/`Action`/`Resource`/`Condition`; identity-based policy không có `Principal`, resource-based policy bắt buộc có.
- Policy evaluation: mặc định **implicit deny** → một Allow khớp thì cho phép → nhưng **explicit deny khớp thì chặn tuyệt đối**, thắng mọi Allow.
- Cùng account: identity-based và resource-based policy là phép **hợp (union)** — một trong hai Allow là đủ; cross-account cần cả hai (Chương 45).
- Role có 2 policy tách biệt: **trust policy** (ai được assume — service principal như `ec2.amazonaws.com`, account, user) và **permission policy** (quyền sau khi assume). EC2 cần thêm **instance profile** làm vỏ chứa role.
- Managed policy (AWS managed / customer managed, có version tối đa 5, tái sử dụng) vs inline policy (gắn chết 1-1, dùng cho ngoại lệ đặc thù).
- Access key: tối đa 2 key/user để rotate; secret chỉ xem được lúc tạo; key lộ thì deactivate ngay rồi điều tra bằng CloudTrail; tuyệt đối không tạo key cho root.
- MFA bảo vệ console và có thể ép trong policy bằng condition `aws:MultiFactorAuthPresent`; bật MFA cho root là việc đầu tiên với account mới.
- Audit: **Credential Report** (CSV toàn account về password/key/MFA), **Access Advisor** (service last accessed theo từng principal — công cụ thu hẹp quyền), **Policy Simulator** (test policy không cần gọi API thật).
- Best practices xuyên suốt đề thi: least privilege, dùng role thay key tĩnh cho mọi workload, policy gắn qua group thay vì user lẻ, password policy chặt, rotate credentials định kỳ, một người một định danh.
- STS chi tiết, federation, permission boundaries, ABAC và policy evaluation đầy đủ với SCP → Chương 45.
