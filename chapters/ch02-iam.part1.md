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
