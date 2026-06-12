# Chương 2: IAM — Identity and Access Management

> **Trọng tâm DVA-C02:** IAM xuất hiện ở khắp 4 domain nhưng tập trung nặng nhất vào Security (26%). Đề thi hay hỏi: đọc một policy JSON và xác định request bị allow hay deny; chọn giữa IAM Role và Access Key cho ứng dụng chạy trên EC2/Lambda/ECS; và policy evaluation logic khi có cả Allow lẫn explicit Deny. Nắm chắc chương này là nền cho Chương 45 (STS, cross-account, permission boundaries).

## Mục tiêu chương

- Hiểu mô hình authentication/authorization của IAM và vì sao root user gần như không bao giờ được dùng hàng ngày.
- Phân biệt và biết khi nào dùng User, Group, Role; hiểu cơ chế role assumption và instance profile.
- Đọc, viết và debug được policy JSON: Effect, Action, Resource, Condition, wildcard, policy variables.
- Phân biệt identity-based vs resource-based policy và cách hai loại kết hợp khi evaluate một request.
- Thuộc lòng policy evaluation logic: explicit deny → allow → implicit deny (default deny).
- Vận hành an toàn: MFA, access key rotation, password policy, Credential Report, Access Advisor.

## 2.1 IAM là gì và mô hình hoạt động

IAM là dịch vụ quản lý **danh tính** (identity) và **quyền** (permission) cho toàn bộ AWS account. Hai điểm cốt lõi cần khắc cốt ghi tâm:

1. **IAM là global service.** Users, groups, roles, policies không thuộc về region nào — tạo một lần, dùng ở mọi region. Trong CLI bạn không bao giờ cần `--region` cho lệnh `aws iam ...` (thực tế mọi request IAM đều đi tới endpoint global `iam.amazonaws.com`).
2. **Mọi request tới AWS API đều đi qua IAM.** Khi bạn gọi `s3:PutObject`, request được ký bằng SigV4 (chi tiết ở Chương 3), AWS xác định **principal** (ai đang gọi), rồi chạy policy evaluation để quyết định allow/deny. Không có chuyện "bypass" IAM — kể cả console cũng chỉ là một client gọi API.

Phân biệt hai khái niệm hay bị nhập nhằng:

- **Authentication** — chứng minh bạn là ai: username/password (console), access key + secret (CLI/SDK), hoặc temporary credentials từ role.
- **Authorization** — bạn được làm gì: do policies quyết định. Một user authenticate thành công nhưng không có policy nào attach thì **không làm được gì cả** (default deny).

### Root user — dùng một lần rồi cất đi

Root user là identity sinh ra cùng account (đăng nhập bằng email). Root **không bị giới hạn bởi IAM policy** — không thể viết policy nào để chặn root. Vì vậy best practice: bật MFA cho root, **không tạo access key cho root**, và chỉ dùng root cho vài tác vụ bắt buộc (đổi account settings, đóng account, một số thao tác billing/support plan). Mọi việc hàng ngày làm qua IAM user/role.

> 💡 **Exam Tip:** Câu hỏi "developer mới vào team cần quyền truy cập AWS, làm thế nào đúng best practice?" — đáp án luôn là tạo IAM user (hoặc dùng IAM Identity Center), KHÔNG bao giờ là chia sẻ root credentials hay chia sẻ access key giữa nhiều người.

## 2.2 Users, Groups và Roles

### IAM User

Đại diện cho **một** người hoặc một ứng dụng cần credentials dài hạn. User có thể có:

- **Console password** — đăng nhập web console.
- **Access keys** (tối đa **2 cặp** mỗi user) — gọi API qua CLI/SDK.

Limits đáng nhớ: tối đa **5.000 users** mỗi account; một user thuộc tối đa **10 groups**.

```bash
# Tạo user, gắn vào group, tạo access key
aws iam create-user --user-name dev-truong
aws iam add-user-to-group --user-name dev-truong --group-name Developers
aws iam create-access-key --user-name dev-truong
# Output chứa AccessKeyId + SecretAccessKey — secret CHỈ hiện 1 lần duy nhất
```

### IAM Group

Group là **tập hợp users** để gắn policy chung — thuần tuý là công cụ quản lý quyền. Ba điều đề thi hay gài:

- Group **không phải identity** — bạn không thể "đăng nhập bằng group", không thể đặt group làm Principal trong resource-based policy.
- Group **không lồng nhau được** (no nesting) — group chỉ chứa users, không chứa group khác.
- Một user có thể thuộc nhiều group; quyền cuối cùng là **hợp (union)** của mọi policy từ tất cả group + policy gắn trực tiếp vào user.

### IAM Role

Role là identity **không có credentials dài hạn**. Thay vào đó, một principal (user, service, account khác) **assume** role và nhận **temporary credentials** (access key + secret + session token, có thời hạn). Role có hai loại policy gắn vào:

1. **Trust policy** (assume role policy) — resource-based policy quy định **AI được phép assume** role này.
2. **Permission policies** — role assume xong thì **được làm gì**.

Thiếu một trong hai là không hoạt động. Đây là lỗi debug kinh điển: gắn đủ permission nhưng quên sửa trust policy (hoặc ngược lại).

| | User | Group | Role |
|---|---|---|---|
| Là identity (đăng nhập/gọi API)? | Có | Không | Có (qua assume) |
| Credentials | Dài hạn (password, access key) | Không có | Tạm thời, tự xoay vòng |
| Dành cho | Một người/ứng dụng cụ thể | Gom quyền cho nhiều user | Service, cross-account, federation |
| Gắn policy được? | Có | Có | Có (permission + trust) |

> 💡 **Exam Tip:** Bất cứ khi nào đề hỏi "ứng dụng chạy trên EC2/ECS/Lambda cần gọi AWS API, cách cấp quyền AN TOÀN NHẤT?" — đáp án là **IAM Role**, không bao giờ là hardcode access key vào code, environment variable hay file config trên instance.

## 2.3 Cấu trúc Policy JSON

Policy là tài liệu JSON gồm một hoặc nhiều **statement**. Mỗi statement trả lời: ai (Principal — chỉ có trong resource-based policy), được/không được (Effect), làm gì (Action), trên cái gì (Resource), trong điều kiện nào (Condition).

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowReadMyBucket",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::my-app-bucket",
        "arn:aws:s3:::my-app-bucket/*"
      ],
      "Condition": {
        "IpAddress": { "aws:SourceIp": "203.0.113.0/24" }
      }
    }
  ]
}
```

Mổ xẻ từng thành phần:

- **Version** — luôn dùng `"2012-10-17"`. Phiên bản cũ `2008-10-17` không hỗ trợ policy variables; viết `${aws:username}` với version cũ thì biến bị hiểu là chuỗi literal — bug khó tìm.
- **Sid** — định danh statement, optional, hữu ích khi debug.
- **Effect** — chỉ `Allow` hoặc `Deny`.
- **Action** — định dạng `service:Operation`, hỗ trợ wildcard: `s3:Get*`, `s3:*`, thậm chí `*`. Action names KHÔNG phân biệt hoa thường.
- **Resource** — ARN, hỗ trợ wildcard. Định dạng ARN: `arn:partition:service:region:account-id:resource`. Lưu ý S3 bucket ARN không có region/account (`arn:aws:s3:::bucket`), và IAM ARN không có region (`arn:aws:iam::123456789012:user/truong`).
- **Condition** — khối điều kiện dạng `{ "operator": { "key": "value" } }`. Operators hay gặp: `StringEquals`, `StringLike`, `IpAddress`, `Bool` (vd `aws:MultiFactorAuthPresent`), `DateGreaterThan`, `ArnLike`. Nhiều condition trong một statement là **AND**; nhiều value trong một key là **OR**.

Cái bẫy ARN kinh điển với S3: `s3:ListBucket` tác động lên **bucket** (`arn:aws:s3:::my-bucket`), còn `s3:GetObject`/`s3:PutObject` tác động lên **object** (`arn:aws:s3:::my-bucket/*`). Viết policy chỉ có `my-bucket/*` rồi thắc mắc vì sao `aws s3 ls` bị AccessDenied là lỗi tuần đầu đi làm của rất nhiều người.

### NotAction, NotResource — đọc cho kỹ

`NotAction` + `Allow` nghĩa là "allow mọi action TRỪ những cái này" — rất rộng, hiếm khi nên dùng. `NotAction` + `Deny` nghĩa là "deny mọi thứ trừ danh sách này" — pattern phổ biến để ép buộc, ví dụ deny tất cả nếu không có MFA:

```json
{
  "Effect": "Deny",
  "NotAction": ["iam:ChangePassword", "iam:CreateVirtualMFADevice",
                "iam:EnableMFADevice", "iam:ListMFADevices", "sts:GetSessionToken"],
  "Resource": "*",
  "Condition": { "BoolIfExists": { "aws:MultiFactorAuthPresent": "false" } }
}
```

### Policy variables

Biến được thay giá trị lúc evaluate. Hữu dụng nhất: `${aws:username}` — cho phép viết **một** policy dùng chung cho cả team, mỗi người chỉ đụng được "ngăn" của mình:

```json
{
  "Effect": "Allow",
  "Action": "s3:*",
  "Resource": "arn:aws:s3:::team-bucket/home/${aws:username}/*"
}
```

### Managed policy vs Inline policy

| | AWS managed | Customer managed | Inline |
|---|---|---|---|
| Ai tạo/sửa | AWS | Bạn | Bạn |
| Tái sử dụng | Attach nhiều identity | Attach nhiều identity | Dính chặt 1 identity |
| Versioning | Có (AWS tự cập nhật) | Có, tối đa **5 versions**, rollback được | Không |
| Khi xoá identity | Policy còn nguyên | Policy còn nguyên | Bị xoá theo |
| Size limit | — | **6.144 ký tự**/policy | Tổng inline: user 2.048, group 5.120, role 10.240 ký tự |

Mặc định mỗi user/group/role attach được tối đa **10 managed policies** (quota nâng được lên 20). Best practice: dùng customer managed policy cho mọi thứ tái sử dụng; inline policy chỉ khi quyền phải "sống chết" cùng đúng một identity (vd trust quan hệ 1-1 đặc thù).

```bash
# Tạo customer managed policy và attach vào group
aws iam create-policy --policy-name S3ReadMyApp \
  --policy-document file://s3-read.json
aws iam attach-group-policy --group-name Developers \
  --policy-arn arn:aws:iam::123456789012:policy/S3ReadMyApp

# Inline policy gắn thẳng vào user
aws iam put-user-policy --user-name dev-truong \
  --policy-name TempDynamoAccess --policy-document file://dynamo.json
```

> 💡 **Exam Tip:** Đề hay cho một policy JSON kèm câu hỏi "user có thực hiện được hành động X không?". Quy trình đọc: (1) tìm explicit Deny match trước, (2) kiểm tra Action có match wildcard không, (3) soi ARN trong Resource — đặc biệt phân biệt bucket ARN vs object ARN, (4) kiểm tra Condition. Sai một trong bốn bước là chọn nhầm đáp án.

## 2.4 Identity-based vs Resource-based Policy

**Identity-based policy** gắn vào identity (user/group/role), trả lời "identity này được làm gì". Không có trường `Principal` — principal chính là identity được gắn.

**Resource-based policy** gắn vào resource (S3 bucket policy, SQS queue policy, SNS topic policy, Lambda function policy, KMS key policy, API Gateway resource policy...), trả lời "AI được làm gì trên resource này". **Bắt buộc có `Principal`**:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "AWS": "arn:aws:iam::111122223333:role/ReportWriter" },
    "Action": "s3:PutObject",
    "Resource": "arn:aws:s3:::reports-bucket/*"
  }]
}
```

Cách hai loại kết hợp:

- **Cùng account:** request được allow nếu identity-based **HOẶC** resource-based policy allow (union) — và không có explicit deny ở đâu cả. Tức là một role không có quyền S3 nào trong identity policy vẫn ghi được vào bucket nếu bucket policy allow đích danh role đó.
- **Cross-account:** cần **CẢ HAI** bên allow — identity policy ở account A allow gọi sang, VÀ resource policy ở account B allow principal từ account A (chi tiết cross-account và confused deputy ở Chương 45).

Lưu ý: trust policy của role chính là một resource-based policy (resource ở đây là role). `"Principal": {"Service": "lambda.amazonaws.com"}` trong trust policy nghĩa là "service Lambda được assume role này".

| | Identity-based | Resource-based |
|---|---|---|
| Gắn vào | User / Group / Role | S3, SQS, SNS, Lambda, KMS, ECR... |
| Có `Principal`? | Không | Bắt buộc |
| Inline hay managed? | Cả hai | Luôn là inline trên resource |
| Cross-account trực tiếp? | Không (phải assume role) | Có (allow principal account khác) |

> 💡 **Exam Tip:** "Account B cần đọc S3 bucket của account A mà KHÔNG muốn assume role" → bucket policy (resource-based) ở account A allow principal của account B + identity policy ở B allow action S3. Ngược lại, dịch vụ không hỗ trợ resource-based policy (vd DynamoDB trước đây, EC2) thì cross-account bắt buộc qua role.

## 2.5 Policy Evaluation Logic — explicit deny thắng tất cả

Khi một request tới, IAM evaluate theo thứ tự logic sau (phạm vi chương này — single account, chưa tính SCP/permission boundary/session policy, xem Chương 45):

1. **Mặc định là DENY** (implicit deny). Không có policy nào nhắc tới action → từ chối.
2. Gom **tất cả** policies áp dụng: mọi identity-based policy (từ user + mọi group user thuộc về, hoặc của role) + resource-based policy của resource đích.
3. Có bất kỳ statement **explicit `Deny`** match → **DENY ngay**, kết thúc. Không có Allow nào gỡ được explicit deny.
4. Không có deny, có ít nhất một **`Allow`** match → **ALLOW**.
5. Không match gì → quay về implicit deny.

Hệ quả thực dụng:

- **Explicit deny dùng làm guardrail.** Ví dụ gắn vào group Developers một statement `Deny iam:*` — dù sau này ai đó lỡ attach `AdministratorAccess` cho một dev, dev vẫn không đụng được IAM.
- **Deny + Condition là pattern ép buộc:** deny `s3:PutObject` khi `"Null": {"s3:x-amz-server-side-encryption": "true"}` để ép upload phải mã hoá (chi tiết Chương 14); deny mọi action khi không có MFA (ví dụ ở mục 2.3).
- Lỗi **AccessDenied** trong thực tế: đọc message để biết action + resource bị chặn, kiểm tra theo đúng thứ tự — có explicit deny nào không (kể cả từ group khác mà user thuộc về), rồi mới kiểm tra thiếu allow.

Debug bằng **IAM Policy Simulator** — không cần gọi API thật:

```bash
# Mô phỏng: user dev-truong có được PutObject vào bucket không?
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::123456789012:user/dev-truong \
  --action-names s3:PutObject \
  --resource-arns arn:aws:s3:::my-app-bucket/report.csv
# EvalDecision: allowed | explicitDeny | implicitDeny
```

> 💡 **Exam Tip:** Câu hỏi dạng "user thuộc Group A (allow s3:*) và Group B (deny s3:DeleteObject), user xoá object được không?" — KHÔNG. Explicit deny luôn thắng, bất kể allow đến từ đâu, kể cả từ resource-based policy hay admin policy. Và nếu đề nói "không có policy nào đề cập action X" → implicit deny.

## 2.6 IAM Roles cho AWS Services

Đây là phần developer dùng nhiều nhất. Cơ chế bên dưới đáng hiểu kỹ vì đề thi hỏi cả "vì sao", không chỉ "là gì".

### Cơ chế: service assume role hộ bạn

Khi gắn role cho EC2/Lambda/ECS, service đó gọi STS `AssumeRole` thay mặt bạn và đưa temporary credentials vào môi trường chạy code:

- **EC2:** credentials phân phối qua **instance metadata service** (IMDSv2 — chi tiết ở Chương 4) tại `http://169.254.169.254/latest/meta-data/iam/security-credentials/<role-name>`. SDK/CLI tự lấy và **tự refresh trước khi hết hạn** — bạn không phải làm gì.
- **Lambda:** credentials inject vào env vars `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` của execution environment.
- **ECS:** task role lấy qua endpoint `169.254.170.2` (biến `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`); phân biệt task role vs execution role ở Chương 17.

Điểm tinh tế với EC2: console "gắn role vào instance" thực chất gắn qua **instance profile** — container chứa đúng **1 role**. Console tự tạo instance profile cùng tên với role; làm bằng CLI/CloudFormation thì phải tự tạo và liên kết:

```bash
# 1. Tạo role với trust policy cho EC2
aws iam create-role --role-name App-EC2-Role \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": { "Service": "ec2.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }]
  }'

# 2. Gắn quyền
aws iam attach-role-policy --role-name App-EC2-Role \
  --policy-arn arn:aws:iam::aws:policy/AmazonDynamoDBReadOnlyAccess

# 3. Instance profile (bước hay quên khi không dùng console)
aws iam create-instance-profile --instance-profile-name App-EC2-Profile
aws iam add-role-to-instance-profile \
  --instance-profile-name App-EC2-Profile --role-name App-EC2-Role
```

Trong code, **không bao giờ truyền credentials thủ công** — để credential provider chain tự tìm (chi tiết chain ở Chương 3):

```javascript
// Node.js — AWS SDK v3. Chạy trên EC2/Lambda có role:
// SDK tự lấy temporary credentials, tự refresh. KHÔNG hardcode key.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetItemCommand } from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient({ region: "ap-southeast-1" }); // không có credentials trong code

const res = await client.send(new GetItemCommand({
  TableName: "Orders",
  Key: { orderId: { S: "ord-123" } },
}));
console.log(res.Item);
```

Go SDK v2 tương tự: `config.LoadDefaultConfig(ctx)` tự đi qua chain — env vars → shared config → IMDS.

### Service-linked roles

Một số service (ELB, ECS, Auto Scaling...) tạo **service-linked role** — role do AWS định nghĩa sẵn, trust policy khoá cứng cho service đó, bạn không sửa được permission. Chỉ cần nhận diện khái niệm cho đề thi.

> 💡 **Exam Tip:** "Ứng dụng trên EC2 đang dùng access key trong file config, cần cải thiện bảo mật" → tạo IAM role, gắn vào instance, xoá access key khỏi code. Nếu đề hỏi thêm "credentials lấy từ đâu trên EC2" → instance metadata service. Nếu role gắn rồi mà vẫn AccessDenied → kiểm tra permission policy của role VÀ trust policy (Principal phải là `ec2.amazonaws.com`).

## 2.7 Access Keys và MFA

### Access Keys

Cặp `AccessKeyId` (bắt đầu `AKIA...`) + `SecretAccessKey` — credentials **dài hạn** cho CLI/SDK. Nguyên tắc sống còn:

- Secret chỉ xem được **một lần duy nhất** lúc tạo. Mất là phải tạo cặp mới.
- Mỗi user tối đa **2 cặp** active — chính là để phục vụ **rotation không downtime**: tạo key mới → deploy key mới → verify (`aws iam get-access-key-last-used`) → deactivate key cũ → theo dõi → xoá.
- **Không bao giờ commit key vào Git.** Key lộ trên GitHub bị bot quét trong vài phút và dùng để đào coin — war story có thật ở mọi công ty. AWS có thể tự gắn policy quarantine (`AWSCompromisedKeyQuarantineV2`) khi phát hiện.
- Trên compute của AWS (EC2/Lambda/ECS/CodeBuild) → dùng role, không dùng access key. Access key chỉ hợp lý cho máy dev local hoặc hệ thống ngoài AWS (mà ngày nay cũng nên ưu tiên OIDC federation — Chương 45).

```bash
# Quy trình rotate key bằng CLI
aws iam create-access-key --user-name dev-truong            # tạo key mới
aws iam get-access-key-last-used --access-key-id AKIAOLD... # key cũ còn được dùng không?
aws iam update-access-key --user-name dev-truong \
  --access-key-id AKIAOLD... --status Inactive              # tắt trước, chưa xoá
aws iam delete-access-key --user-name dev-truong --access-key-id AKIAOLD...
```

### MFA — Multi-Factor Authentication

MFA thêm yếu tố "thứ bạn có" bên cạnh password. Các loại device IAM hỗ trợ:

- **Virtual MFA device** — app TOTP (Google Authenticator, Authy). Phổ biến nhất.
- **FIDO2/Passkey security key** — YubiKey, Touch ID.
- **Hardware TOTP token**.

Một user gắn được tối đa **8 MFA devices**. MFA bảo vệ console login trực tiếp; với API/CLI, MFA chỉ có tác dụng khi policy yêu cầu condition `aws:MultiFactorAuthPresent` — lúc đó user phải lấy temporary credentials qua `sts:GetSessionToken` kèm mã MFA (cách làm cụ thể ở Chương 3, lý thuyết STS sâu ở Chương 45).

Lưu ý condition hay gài: dùng `BoolIfExists` thay vì `Bool` khi viết deny-without-MFA, vì request bằng access key dài hạn **không có** key `aws:MultiFactorAuthPresent` trong context — `Bool: false` sẽ không match key vắng mặt, còn `BoolIfExists` xử lý đúng cả trường hợp đó.

> 💡 **Exam Tip:** "Bảo vệ thao tác nhạy cảm (xoá S3 object, terminate EC2) ngay cả khi credentials bị lộ" → yêu cầu MFA qua condition `aws:MultiFactorAuthPresent` trong policy (hoặc MFA Delete cho S3 — Chương 14). MFA không tự áp dụng cho API calls nếu policy không ép.

## 2.8 Password Policy, Credential Report & Access Advisor

### Password policy

Account-level setting cho console password của IAM users: độ dài tối thiểu (mặc định AWS hiện yêu cầu ≥ 8), bắt buộc các loại ký tự, **password expiration** (ép đổi sau N ngày), **prevent reuse** (nhớ tối đa 24 password cũ), cho phép user tự đổi password.

```bash
aws iam update-account-password-policy \
  --minimum-password-length 14 \
  --require-symbols --require-numbers \
  --require-uppercase-characters --require-lowercase-characters \
  --max-password-age 90 \
  --password-reuse-prevention 24 \
  --allow-users-to-change-password
```

### Credential Report — audit toàn account

CSV liệt kê **mọi user** trong account và trạng thái credentials: password enabled/last used/last changed, MFA active, access key 1/2 active/last rotated/last used. Tạo lại tối đa 4 giờ một lần (gọi sớm hơn thì trả report cached).

```bash
aws iam generate-credential-report
aws iam get-credential-report --query Content --output text | base64 -d > report.csv
```

Use case đề thi: "tìm tất cả user chưa bật MFA / access key không xoay vòng 90 ngày" → Credential Report (account-level, mọi user).

### Access Advisor — quyền thừa của một identity

Tab "Last Accessed" trên từng user/group/role: liệt kê các **service** mà identity có quyền truy cập và **lần cuối thực sự dùng** (data lưu tới 400 ngày). Đây là công cụ thực thi **least privilege**: thấy role có quyền 30 services nhưng 400 ngày chỉ đụng 3 → cắt 27 cái còn lại.

```bash
# API tương ứng của Access Advisor
aws iam generate-service-last-accessed-details \
  --arn arn:aws:iam::123456789012:role/App-EC2-Role
aws iam get-service-last-accessed-details --job-id <job-id-từ-lệnh-trên>
```

| | Credential Report | Access Advisor |
|---|---|---|
| Phạm vi | Toàn account, mọi user | Một identity cụ thể |
| Nội dung | Trạng thái credentials (password, key, MFA) | Service-level last accessed |
| Use case | Audit hygiene: MFA, key rotation | Thu hẹp quyền (least privilege) |
| Định dạng | CSV download | Console tab / API |

> 💡 **Exam Tip:** Hai công cụ này là cặp đối chiếu kinh điển. "Audit credentials của TẤT CẢ users" → Credential Report. "Xác định những permission KHÔNG được sử dụng của một role để thu hẹp quyền" → Access Advisor (Last Accessed). Đề thường nhét thêm đáp án nhiễu là CloudTrail (đúng cho "ai đã làm gì, khi nào" — Chương 27) và AWS Config.

## 2.9 IAM Best Practices — checklist cho developer

Tổng hợp những nguyên tắc AWS chính thức khuyến nghị, cũng là "đáp án mẫu" cho rất nhiều câu hỏi security:

1. **Khoá root user:** MFA bật, không access key, không dùng hàng ngày.
2. **Least privilege:** bắt đầu từ quyền tối thiểu, mở rộng khi cần (dựa trên Access Advisor), không bắt đầu từ `*` rồi "tính sau". Tránh `"Action": "*", "Resource": "*"` trong mọi policy tự viết.
3. **Ưu tiên temporary credentials:** role cho mọi workload trên AWS; con người thì ưu tiên IAM Identity Center/federation (Chương 45) hơn IAM user thuần.
4. **Không chia sẻ credentials:** mỗi người một identity — vừa bảo mật vừa truy vết được trên CloudTrail.
5. **Group để quản lý quyền cho user**, không attach policy lẻ tẻ từng user.
6. **Rotate access keys định kỳ**, xoá credentials không dùng (soi Credential Report).
7. **MFA cho mọi human user**, đặc biệt user có quyền cao; cân nhắc condition MFA cho action nhạy cảm.
8. **Dùng condition keys siết phạm vi:** `aws:SourceIp`, `aws:RequestedRegion`, `aws:SecureTransport`, tag-based conditions.
9. **Policy versioning:** customer managed policy giữ tối đa 5 versions — sửa quyền hỏng thì `set-default-policy-version` rollback ngay thay vì viết lại.
10. **Validate trước khi deploy:** IAM Policy Simulator, `aws accessanalyzer validate-policy`, và đọc kỹ AccessDenied message (giờ đã ghi rõ policy type nào chặn).

> 💡 **Exam Tip:** Khi đề cho 4 phương án cấp quyền, hãy chấm điểm theo thứ tự ưu tiên: role + temporary credentials > IAM user + group policy > inline policy > hardcoded access key (gần như luôn sai). Phương án nào có chữ "share credentials", "store secret key in source code", "use root user" thì loại ngay lập tức.

---

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
