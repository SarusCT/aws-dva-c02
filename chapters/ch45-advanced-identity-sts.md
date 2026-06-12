# Chương 45: Advanced Identity — STS, Federation & IAM nâng cao

> **Trọng tâm DVA-C02:** Đây là một trong những chủ đề Security "nặng đô" nhất của đề thi. Bạn sẽ gặp nhiều câu scenario về cross-account access (account A truy cập S3/KMS của account B), về cách một mobile/web app lấy được AWS credentials tạm, về `AssumeRole` + trust policy + `ExternalId` chống confused deputy, về thứ tự đánh giá policy khi có cả permission boundary + SCP + session policy, và về ABAC (attribute-based access control) dùng tag. Từ khóa nhận diện: "temporary credentials", "cross-account", "assume a role", "federated users", "permission boundary", "least privilege at scale". Nắm chắc cơ chế STS và policy evaluation logic là ăn điểm chắc cả domain Security.

## Mục tiêu chương
- Hiểu 5 API chính của **AWS STS** (`AssumeRole`, `AssumeRoleWithSAML`, `AssumeRoleWithWebIdentity`, `GetSessionToken`, `GetFederationToken`) — mỗi API dùng cho kịch bản nào.
- Thực hiện được **cross-account access** đúng cách: trust policy + permission policy + `ExternalId`, và biết bẫy "confused deputy".
- Phân biệt các kiểu **federation** (SAML 2.0, OIDC/web identity, custom broker) và khi nào chọn STS trực tiếp vs Cognito Identity Pools (chi tiết Identity Pools ở Chương 39).
- Nắm **policy evaluation logic đầy đủ**: identity-based + resource-based + permission boundary + SCP + session policy — thứ tự và quy tắc "explicit deny luôn thắng".
- Thiết kế **permission boundaries** để giới hạn quyền tối đa khi delegate quyền tạo IAM, và áp dụng **ABAC** với `aws:PrincipalTag`/`aws:ResourceTag`.
- Nhận diện vai trò của **IAM Identity Center (SSO)** và **AWS RAM (Resource Access Manager)** ở mức câu hỏi đề thi.

## 45.1 AWS STS — bộ não cấp credentials tạm thời

**AWS Security Token Service (STS)** là dịch vụ phát hành **temporary security credentials** (credentials tạm thời, có thời hạn). Khác với access key dài hạn của IAM user (tồn tại tới khi bạn xóa), credentials từ STS gồm **3 phần** và tự hết hạn:

- `AccessKeyId`
- `SecretAccessKey`
- `SessionToken` — phần đặc trưng của credentials tạm; mọi request ký bằng credentials tạm BẮT BUỘC kèm `X-Amz-Security-Token`.

Vì sao temporary credentials an toàn hơn? Vì nó **hết hạn tự động** (15 phút đến 12 giờ tùy ngữ cảnh), nên dù rò rỉ thì thiệt hại giới hạn theo thời gian. Đây là nền tảng của hầu hết pattern bảo mật hiện đại trên AWS: EC2 instance role, Lambda execution role, cross-account access, mobile app federation... tất cả đều lấy credentials qua STS bên dưới (cho dù SDK ẩn đi việc gọi STS).

STS có **endpoint global** (`sts.amazonaws.com`) và **endpoint theo region** (`sts.<region>.amazonaws.com`). Best practice là dùng **regional endpoint** để giảm latency và tránh single point of failure. SDK v3 mặc định đã ưu tiên regional endpoint. Một bẫy thực tế: token phát hành từ regional endpoint của một region mới (region phải được kích hoạt) chỉ hợp lệ nếu region đó active.

Năm API quan trọng (sẽ đào sâu từng cái ở các section sau):

| API | Dùng cho | Principal gọi cần |
|-----|----------|-------------------|
| `AssumeRole` | Cross-account, hoặc IAM user/role lấy quyền của role khác | IAM credentials hợp lệ |
| `AssumeRoleWithSAML` | Enterprise federation qua SAML 2.0 IdP (AD FS, Okta) | SAML assertion, KHÔNG cần IAM credentials |
| `AssumeRoleWithWebIdentity` | Federation qua OIDC (Google, Facebook, Cognito, OIDC provider) | OIDC token, KHÔNG cần IAM credentials |
| `GetSessionToken` | Lấy credentials tạm cho chính IAM user, thường kèm **MFA** | IAM credentials của chính user |
| `GetFederationToken` | Cấp credentials tạm cho federated user qua một custom broker | IAM user (thường là proxy/broker) |

> 💡 **Exam Tip:** Hai API `AssumeRoleWithSAML` và `AssumeRoleWithWebIdentity` là API **không cần ký bằng AWS credentials** — chúng đổi một token bên ngoài (SAML assertion / OIDC JWT) lấy AWS credentials. Đây là cách app không nhúng AWS key vẫn truy cập được AWS. Nếu câu hỏi nói "mobile app, không muốn nhúng AWS credentials" → nghĩ ngay tới `AssumeRoleWithWebIdentity` (hoặc Cognito Identity Pools đứng trước nó).

## 45.2 AssumeRole & cross-account access — trust policy vs permission policy

`AssumeRole` là API cốt lõi nhất. Cơ chế: một principal (IAM user hoặc role) "đóng vai" (assume) một **IAM role** khác và nhận về credentials tạm mang quyền của role đó. Mỗi IAM role có **HAI policy độc lập**, đề thi cực hay gài chỗ này:

1. **Trust policy** (= `AssumeRolePolicyDocument`): trả lời câu hỏi **"AI được phép assume role này?"**. Đây là một **resource-based policy** gắn vào chính role, với `Principal` chỉ ra ai được vào. Action luôn là `sts:AssumeRole`.
2. **Permission policy** (identity-based policy gắn vào role): trả lời câu hỏi **"Role này LÀM ĐƯỢC GÌ sau khi được assume?"**.

Để một cross-account assume thành công cần ĐỦ CẢ HAI phía:

- Phía **account chứa role** (account B): trust policy của role phải cho phép principal của account A.
- Phía **account gọi** (account A): IAM user/role phải có quyền `sts:AssumeRole` trỏ tới ARN của role bên B (identity-based policy).

Thiếu một trong hai → fail. Đây là lý do nhiều câu hỏi đáp án sai vì "chỉ cấu hình một phía".

Ví dụ kịch bản kinh điển: **Account A (Dev) cần đọc một bucket S3 ở Account B (Prod)**.

Trust policy của role `S3ReadRole` trong Account B (`111122223333` là Account A):

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "AWS": "arn:aws:iam::111122223333:root" },
    "Action": "sts:AssumeRole",
    "Condition": {
      "StringEquals": { "sts:ExternalId": "Dev-To-Prod-2026" }
    }
  }]
}
```

`Principal` để `:root` nghĩa là "tin toàn bộ account A" — nhưng account A vẫn phải tự cấp `sts:AssumeRole` cho user cụ thể bên trong nó. Đây là mô hình delegate phổ biến: account B tin account A, account A tự quản ai trong nội bộ được dùng.

Permission policy của role (cấp ở Account B):

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:GetObject", "s3:ListBucket"],
    "Resource": [
      "arn:aws:s3:::prod-data-bucket",
      "arn:aws:s3:::prod-data-bucket/*"
    ]
  }]
}
```

Phía Account A, IAM user/role gọi assume:

```javascript
// AWS SDK for JavaScript v3 — assume role cross-account
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

const sts = new STSClient({ region: "ap-southeast-1" });

const { Credentials } = await sts.send(new AssumeRoleCommand({
  RoleArn: "arn:aws:iam::444455556666:role/S3ReadRole", // role bên Account B
  RoleSessionName: "dev-read-session",   // tên session, xuất hiện trong CloudTrail
  ExternalId: "Dev-To-Prod-2026",        // phải khớp condition trong trust policy
  DurationSeconds: 3600                   // 1 giờ
}));

// Dùng credentials tạm để gọi S3 của Account B
const s3 = new S3Client({
  region: "ap-southeast-1",
  credentials: {
    accessKeyId: Credentials.AccessKeyId,
    secretAccessKey: Credentials.SecretAccessKey,
    sessionToken: Credentials.SessionToken
  }
});
const out = await s3.send(new ListObjectsV2Command({ Bucket: "prod-data-bucket" }));
console.log(out.Contents?.map(o => o.Key));
```

Tương đương bằng CLI:

```bash
# Lấy credentials tạm rồi export vào biến môi trường
aws sts assume-role \
  --role-arn arn:aws:iam::444455556666:role/S3ReadRole \
  --role-session-name dev-read-session \
  --external-id Dev-To-Prod-2026 \
  --query 'Credentials' --output json
```

Một cách tiện hơn trong thực tế là khai báo role trong `~/.aws/config` rồi để SDK/CLI tự assume:

```ini
[profile prod-reader]
role_arn = arn:aws:iam::444455556666:role/S3ReadRole
source_profile = dev
external_id = Dev-To-Prod-2026
```

> 💡 **Exam Tip:** Phân biệt thật chắc: **trust policy = AI được vào** (resource-based, có `Principal`), **permission policy = role làm được gì** (identity-based, không có `Principal`). Câu hỏi mô tả "đã cấp đủ quyền S3 cho role nhưng vẫn AccessDenied khi assume" → gần như chắc chắn thiếu/sai **trust policy**.

## 45.3 ExternalId & bài toán "confused deputy"

`ExternalId` là một chuỗi bí mật được dùng để chống **confused deputy** — một dạng tấn công khi một bên thứ ba (deputy) bị lừa dùng quyền của nó để hành động thay kẻ tấn công.

Kịch bản: bạn là khách hàng của một SaaS (ví dụ một tool monitoring) cần truy cập tài nguyên AWS của bạn. Bạn tạo một role và cho account của SaaS đó assume. Vấn đề: account SaaS đó phục vụ NHIỀU khách hàng. Nếu kẻ tấn công (cũng là khách hàng của SaaS) biết hoặc đoán được ARN role của bạn, hắn có thể "nhờ" SaaS assume role của bạn — SaaS vô tình trở thành "confused deputy" dùng quyền của chính nó để vào tài nguyên của bạn.

Giải pháp: SaaS sinh một `ExternalId` **duy nhất cho mỗi khách hàng** (thường là customer ID không đoán được), và bạn đặt nó vào condition của trust policy. Khi SaaS assume role, nó phải truyền đúng `ExternalId` của bạn. Kẻ tấn công không biết `ExternalId` này nên không thể nhờ SaaS assume role của bạn.

Điểm quan trọng cho đề thi:

- `ExternalId` **không phải password bảo mật cao** — nó không bí mật tuyệt đối, mục đích chỉ là ngăn confused deputy, không phải ngăn brute force. Đừng nhầm nó với credential.
- `ExternalId` chỉ áp dụng cho **third-party cross-account** (khi bên kia là một tổ chức khác bạn không kiểm soát). Cross-account trong CÙNG tổ chức của bạn thì thường không cần.
- Trong cùng trust policy, có thể thay/bổ sung bằng condition `aws:SourceAccount` / `aws:SourceArn` cho các service principal (ví dụ chống confused deputy khi một AWS service assume role thay bạn).

> 💡 **Exam Tip:** Câu hỏi có cụm "third-party / SaaS / external vendor cần truy cập tài nguyên AWS của bạn" + "ngăn confused deputy" → đáp án là dùng **`ExternalId`** trong condition của trust policy. Còn nếu là một AWS service (như CloudTrail, Config) assume role thì dùng `aws:SourceArn`/`aws:SourceAccount`.

## 45.4 Federation qua SAML & Web Identity (OIDC)

**Federation** cho phép người dùng đã có danh tính ở nơi khác (corporate directory, Google, Facebook...) truy cập AWS mà KHÔNG cần tạo IAM user riêng. AWS không lưu mật khẩu của họ; thay vào đó AWS tin một **Identity Provider (IdP)** bên ngoài.

**1) SAML 2.0 federation — dành cho doanh nghiệp.** Dùng khi công ty đã có một SAML IdP như Active Directory Federation Services (AD FS), Okta, Ping. Luồng:

1. User đăng nhập vào IdP nội bộ (AD FS).
2. IdP trả về một **SAML assertion** (XML đã ký).
3. Ứng dụng gọi `sts:AssumeRoleWithSAML` truyền assertion + ARN của role + ARN của SAML provider.
4. STS xác thực assertion (dựa trên metadata IdP đã đăng ký trong IAM) và trả credentials tạm.

Phía AWS bạn phải tạo một **IAM SAML identity provider** (upload metadata XML của IdP) và một role có trust policy tin provider đó với action `sts:AssumeRoleWithSAML`.

**2) Web Identity / OIDC federation — dành cho web/mobile public.** Dùng khi user đăng nhập bằng Google/Facebook/Amazon/Apple hoặc bất kỳ OIDC provider. Luồng:

1. User đăng nhập với provider OIDC → app nhận một **JWT (OIDC token)**.
2. App gọi `sts:AssumeRoleWithWebIdentity` truyền token + ARN role.
3. STS xác thực token với provider và trả credentials tạm.

Phía AWS tạo một **IAM OIDC identity provider** và role với trust policy chứa condition kiểm tra `<provider>:aud` (audience/app id) và `<provider>:sub` (subject/user id) để giới hạn đúng app.

```json
{
  "Effect": "Allow",
  "Principal": { "Federated": "arn:aws:iam::444455556666:oidc-provider/accounts.google.com" },
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringEquals": { "accounts.google.com:aud": "my-google-client-id.apps.googleusercontent.com" }
  }
}
```

**STS trực tiếp vs Cognito Identity Pools:** Bạn CÓ THỂ gọi `AssumeRoleWithWebIdentity` trực tiếp, nhưng AWS khuyến nghị dùng **Cognito Identity Pools** làm lớp trung gian cho mobile/web vì Cognito: hỗ trợ nhiều provider cùng lúc, tự xử lý token refresh, hỗ trợ unauthenticated identities, và làm role mapping mịn hơn. (Identity Pools chi tiết ở **Chương 39**.)

> 💡 **Exam Tip:** Map nhanh: **doanh nghiệp + Active Directory/SAML IdP** → `AssumeRoleWithSAML` (hoặc IAM Identity Center). **App public + đăng nhập Google/Facebook** → `AssumeRoleWithWebIdentity`, mà cách "AWS recommend" cho mobile là **Cognito Identity Pools**. Đừng chọn tạo IAM user cho từng end-user — đó luôn là đáp án SAI cho federation.

## 45.5 GetSessionToken (MFA) & GetFederationToken

Hai API còn lại phục vụ kịch bản khác hẳn assume-role.

**`GetSessionToken`** — IAM user lấy credentials tạm cho **chính mình**, phổ biến nhất khi cần **MFA** cho các thao tác nhạy cảm. Pattern: policy của user dùng condition `aws:MultiFactorAuthPresent: true` để chặn thao tác nguy hiểm trừ khi credentials có MFA. User dùng access key dài hạn (không có MFA context) chỉ để gọi `GetSessionToken` kèm mã MFA, nhận về credentials tạm CÓ context MFA, rồi dùng credentials đó cho thao tác nhạy cảm.

```bash
# Lấy credentials tạm có MFA context
aws sts get-session-token \
  --serial-number arn:aws:iam::111122223333:mfa/duy \
  --token-code 123456 \
  --duration-seconds 3600
```

Đặc điểm quan trọng:
- `GetSessionToken` **KHÔNG đổi quyền** — credentials trả về có CÙNG quyền với user gọi (chỉ thêm context MFA). Khác hẳn `AssumeRole` (đổi sang quyền của role).
- Thời hạn: 15 phút đến **36 giờ** với IAM user (mặc định 12 giờ); **tối đa 1 giờ** nếu gọi bằng root account (và AWS khuyến cáo không dùng root).

**`GetFederationToken`** — một IAM user (thường đóng vai **identity broker** chạy trên server của bạn) cấp credentials tạm cho federated user khi bạn dùng hệ thống xác thực riêng (custom). Credentials trả về có quyền là **giao của** permission policy của user gọi VÀ một **session policy** bạn truyền vào lúc gọi. Đây là cách giới hạn quyền per-user khi tự xây broker. Thời hạn 15 phút đến 36 giờ (root: tối đa 1 giờ).

| API | Đổi danh tính/quyền? | Cần IAM credentials để gọi? | Dùng MFA điển hình? | Thời hạn |
|-----|----------------------|------------------------------|---------------------|----------|
| `AssumeRole` | Có (sang role) | Có | Có thể | 15 phút – 12 giờ |
| `AssumeRoleWithSAML` | Có | Không (dùng SAML assertion) | IdP lo | 15 phút – 12 giờ |
| `AssumeRoleWithWebIdentity` | Có | Không (dùng OIDC token) | IdP lo | 15 phút – 12 giờ |
| `GetSessionToken` | Không (giữ quyền user) | Có | Có (phổ biến nhất) | 15 phút – 36 giờ |
| `GetFederationToken` | Thu hẹp (giao session policy) | Có | Hiếm | 15 phút – 36 giờ |

> 💡 **Exam Tip:** Nhớ con số **session duration của `AssumeRole`: max 12 giờ**, mặc định 1 giờ — và **role chaining** (assume role rồi từ đó assume tiếp role khác) bị giới hạn cứng **1 giờ**, không thể kéo dài hơn dù role cho phép 12 giờ. Còn `GetSessionToken`/`GetFederationToken` đi tới **36 giờ**. Câu hỏi về MFA cho IAM user → `GetSessionToken`.

## 45.6 Revoke session & các bẫy về thời hạn

Credentials tạm **không thể "thu hồi" trực tiếp** bằng một nút bấm — chúng hợp lệ tới khi hết hạn. Nhưng khi credentials bị lộ, bạn vẫn vô hiệu hóa được bằng cách đính thêm một **inline policy "deny all"** với condition `aws:TokenIssueTime` vào chính role (tính năng **Revoke active sessions** trong console):

```json
{
  "Effect": "Deny",
  "Action": "*",
  "Resource": "*",
  "Condition": {
    "DateLessThan": { "aws:TokenIssueTime": "2026-06-12T08:00:00Z" }
  }
}
```

Mọi credentials phát hành TRƯỚC thời điểm này lập tức bị từ chối ở mọi request, trong khi session mới (sau khi user assume lại) vẫn hoạt động. Đây là cách "kill switch" cho session đang chạy.

Vài bẫy thời hạn hay gặp:
- Đặt `DurationSeconds` lớn hơn `MaxSessionDuration` của role → lỗi. Phải tăng `MaxSessionDuration` của role trước (tối đa 12 giờ).
- **Role chaining giới hạn 1 giờ** — bỏ qua `DurationSeconds` lớn hơn.
- Credentials EC2 instance role / Lambda được SDK tự refresh; đừng cache cứng credentials trong code.

## 45.7 Policy evaluation logic đầy đủ

Đây là phần lý thuyết "xương sống" của domain Security. Khi một request tới, IAM đánh giá tổ hợp tới **6 loại policy**:

1. **Identity-based policy** — gắn vào user/group/role (cấp quyền).
2. **Resource-based policy** — gắn vào tài nguyên (S3 bucket policy, KMS key policy, SQS/SNS/Lambda policy), có `Principal`.
3. **Permission boundary** — trần quyền tối đa cho một IAM entity (không tự cấp quyền).
4. **Service Control Policy (SCP)** — guardrail ở cấp AWS Organizations, áp cho toàn account (không tự cấp quyền).
5. **Session policy** — policy truyền vào lúc `AssumeRole`/`GetFederationToken`, thu hẹp quyền session.
6. **Resource control policy (RCP)** — guardrail Organizations áp cho resource (mới hơn, ít gặp trong đề cũ).

**Quy tắc vàng — không thể nhầm:**

- Mọi request **mặc định bị từ chối (implicit deny)**.
- Một **explicit `Deny`** ở BẤT KỲ policy nào → từ chối ngay, không gì ghi đè được. "Explicit deny always wins."
- Để được phép, request phải có **explicit `Allow`** VÀ KHÔNG bị explicit deny ở mọi tầng áp dụng.
- **SCP** và **permission boundary** chỉ **giới hạn** (intersect), KHÔNG bao giờ tự cấp quyền. Nếu SCP không cho một action thì dù identity policy Allow vẫn bị chặn.

Quy tắc đặc biệt cho **cross-account** (account A truy cập resource account B):
- Cần **CẢ HAI**: identity-based policy bên A cho phép, VÀ resource-based policy bên B cho phép principal của A. Đây là khác biệt then chốt với same-account.
- Trong **same-account**, identity-based HOẶC resource-based cho phép là đủ (chỉ cần một bên Allow, miễn không có deny).

Hiệu lực của từng tầng có thể tóm bằng phép giao: quyền hiệu lực = (Identity ∪ Resource trong cùng account) ∩ Permission Boundary ∩ SCP ∩ Session policy, trừ đi mọi explicit Deny.

> 💡 **Exam Tip:** Hai câu thần chú: (1) **"An explicit deny always overrides any allow."** (2) **SCP/permission boundary/session policy chỉ thu hẹp, không cấp quyền** — phải có một Allow thật từ identity hoặc resource policy. Câu hỏi "user có AdministratorAccess nhưng vẫn không làm được X" → thường do SCP hoặc permission boundary chặn, hoặc explicit deny.

## 45.8 Permission boundaries — delegate an toàn

**Permission boundary** là một managed policy đính vào một IAM user/role để định nghĩa **trần quyền tối đa** mà entity đó có thể có. Quyền hiệu lực = **giao** của (identity-based policy) ∩ (permission boundary). Permission boundary **không tự cấp quyền** — nó chỉ giới hạn.

Use case kinh điển: bạn muốn cho một developer quyền **tự tạo IAM role/user cho ứng dụng của họ**, nhưng không muốn họ tự cấp cho mình `AdministratorAccess` (privilege escalation). Giải pháp: cấp cho developer quyền `iam:CreateRole`, nhưng kèm condition **bắt buộc** mọi role/user họ tạo phải đính một permission boundary cụ thể:

```json
{
  "Effect": "Allow",
  "Action": ["iam:CreateUser", "iam:CreateRole", "iam:PutRolePolicy", "iam:AttachRolePolicy"],
  "Resource": "*",
  "Condition": {
    "StringEquals": {
      "iam:PermissionsBoundary": "arn:aws:iam::111122223333:policy/DevBoundary"
    }
  }
}
```

Như vậy developer chỉ tạo được entity bị "đóng khung" trong `DevBoundary` — dù họ gắn `AdministratorAccess`, quyền thực tế vẫn bị giao với boundary.

So sánh nhanh để tránh nhầm trong đề:

| Cơ chế | Phạm vi | Tự cấp quyền? | Áp dụng cho |
|--------|---------|---------------|-------------|
| Permission boundary | Một IAM user/role | Không (chỉ trần) | Entity được gắn |
| SCP | Toàn bộ account trong OU | Không (guardrail) | Mọi principal trong account (trừ root quản lý) |
| Session policy | Một session STS | Không (thu hẹp) | Credentials của session đó |
| Identity policy | User/group/role | Có | Entity được gắn |

> 💡 **Exam Tip:** "Cho developer tự tạo IAM role nhưng không cho leo thang đặc quyền / giới hạn quyền tối đa" → **permission boundary** + condition `iam:PermissionsBoundary`. SCP là cấp tổ chức (cần AWS Organizations), không dùng để delegate per-developer trong một account.

## 45.9 ABAC, policy variables & các dịch vụ identity ở mức nhận diện

**ABAC (Attribute-Based Access Control)** cấp quyền dựa trên **tag** thay vì viết policy riêng cho từng resource/user (RBAC). Ý tưởng: gắn tag cho principal (qua `aws:PrincipalTag`) và cho resource (qua `aws:ResourceTag`), rồi viết MỘT policy so khớp chúng. Lợi ích: số lượng policy không tăng theo số team/project; thêm người mới chỉ cần gán tag đúng.

Ví dụ: cho phép user thao tác chỉ trên các tài nguyên cùng `Project` với mình:

```json
{
  "Effect": "Allow",
  "Action": ["ec2:StartInstances", "ec2:StopInstances"],
  "Resource": "*",
  "Condition": {
    "StringEquals": {
      "aws:ResourceTag/Project": "${aws:PrincipalTag/Project}"
    }
  }
}
```

`${aws:PrincipalTag/Project}` là một **policy variable** — được thay bằng giá trị tag `Project` của principal lúc request. Một user tag `Project=Falcon` chỉ start/stop được EC2 có tag `Project=Falcon`. Khi mở rộng sang team mới chỉ cần gán tag, không sửa policy.

Các policy variable hay gặp khác: `${aws:username}`, `${aws:userid}`, và đặc biệt với S3/DynamoDB fine-grained access từ Cognito: `${cognito-identity.amazonaws.com:sub}` (chi tiết ở **Chương 39**). Với SAML, tag có thể đến từ session qua `sts:AssumeRoleWithSAML` mang principal tag.

**IAM Identity Center (trước là AWS SSO)** — mức nhận diện cho đề: là dịch vụ quản lý **truy cập tập trung cho nhiều AWS account** (trong AWS Organizations) và cho các ứng dụng SaaS. Người dùng đăng nhập một lần, chọn account + permission set (về bản chất là một role được Identity Center tạo trong mỗi account). Có identity store tích hợp sẵn, hoặc kết nối AD/external IdP. Khi câu hỏi nói "centralized access to multiple accounts, single sign-on cho workforce" → **IAM Identity Center**, không phải tạo IAM user ở từng account.

**AWS Resource Access Manager (RAM)** — mức nhận diện: chia sẻ **resource** (không phải quyền) giữa các account, ví dụ chia sẻ một VPC subnet, Transit Gateway, Route 53 Resolver rule, License. RAM khác cross-account IAM ở chỗ nó chia sẻ chính tài nguyên để account khác dùng như của mình, không phải assume role để thao tác. Câu hỏi "share a subnet / Transit Gateway across accounts" → **RAM**.

> 💡 **Exam Tip:** ABAC = "scale bằng tag". Khi đề nhấn "least operational overhead để cấp quyền cho hàng trăm project/team đang tăng" → ABAC với `aws:PrincipalTag`/`aws:ResourceTag` thay vì viết policy cho từng cái. Phân biệt RAM (chia sẻ tài nguyên) với STS AssumeRole (mượn quyền) — đây là cặp dễ gài.

---

## Hands-on Lab: Cross-account AssumeRole + ExternalId, ABAC bằng tag và permission boundary

**Mục tiêu lab:** Dựng kịch bản cross-account kinh điển của đề DVA-C02: account A (caller/dev) assume một role ở account B (resource owner) để đọc/ghi một bucket S3, bảo vệ bằng `ExternalId` chống confused deputy. Sau đó áp một **permission boundary** để chặn quyền vượt mức, và thử **ABAC** với `aws:PrincipalTag`/`s3:ExistingObjectTag`. Cuối cùng đọc claim của session bằng `sts:GetCallerIdentity` và quan sát session credentials hết hạn.

**Chuẩn bị:**
- Hai AWS account: `ACCOUNT_A` (trusted — nơi user/principal gọi) và `ACCOUNT_B` (trusting — nơi có role và bucket). Nếu chỉ có một account, vẫn chạy được cả lab vì AssumeRole trong cùng account hợp lệ — chỉ thay account id cho khớp.
- AWS CLI v2 đã cấu hình profile admin cho cả hai account: `aws sts get-caller-identity --profile A` và `--profile B` phải trả về đúng account id.
- Region cố định cho S3, ví dụ `ap-southeast-1`. STS là endpoint regional (xem Exam Tips về regional vs global endpoint).

Đặt biến cho gọn:

```bash
A=111111111111   # ACCOUNT_A (caller)
B=222222222222   # ACCOUNT_B (resource owner)
EXT_ID="dva-lab-secret-9f3a"   # ExternalId chia sẻ riêng giữa hai bên
BUCKET=xacct-lab-$B
```

### Bước 1: (Account B) Tạo bucket và role cross-account với trust policy + ExternalId

Tạo bucket ở account B:

```bash
aws s3 mb s3://$BUCKET --region ap-southeast-1 --profile B
echo "from account B" > b.txt
aws s3 cp b.txt s3://$BUCKET/b.txt --profile B
```

Trust policy nói "ai được assume". Ta cho phép **toàn bộ account A** (`root` ARN nghĩa là bất kỳ principal nào ở A đã được IAM của A cho phép gọi sts:AssumeRole) nhưng **bắt buộc** kèm `ExternalId`. Lưu `trust.json`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::111111111111:root" },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": { "sts:ExternalId": "dva-lab-secret-9f3a" }
      }
    }
  ]
}
```

Permission policy của role — chỉ cho đọc/ghi đúng bucket này. Lưu `perm.json`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::xacct-lab-222222222222",
        "arn:aws:s3:::xacct-lab-222222222222/*"
      ]
    }
  ]
}
```

Tạo role và gắn policy:

```bash
aws iam create-role --role-name CrossAcctS3Role \
  --assume-role-policy-document file://trust.json \
  --max-session-duration 3600 --profile B

aws iam put-role-policy --role-name CrossAcctS3Role \
  --policy-name S3Access --policy-document file://perm.json --profile B
```

`--max-session-duration 3600` đặt trần thời gian session là 1 giờ (mặc định cũng 1h, max 12h = 43200s). Đây là trần cho `--duration-seconds` khi assume.

### Bước 2: (Account A) Cấp quyền cho user của A được gọi AssumeRole

Cross-account cần **cả hai phía** cho phép: trust policy ở B (đã làm) VÀ identity-based policy ở A. Nếu thiếu phía A, lỗi là `AccessDenied` khi gọi `sts:AssumeRole` ngay từ phía caller. Lưu `a-assume.json`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": "arn:aws:iam::222222222222:role/CrossAcctS3Role"
    }
  ]
}
```

```bash
aws iam put-user-policy --user-name dev-thao \
  --policy-name AllowAssumeB \
  --policy-document file://a-assume.json --profile A
```

(Giả sử user `dev-thao` đã tồn tại ở account A — nếu chưa, tạo như Chương 2.)

### Bước 3: Assume role và quan sát temporary credentials

Gọi từ phía A. Bắt buộc kèm `--external-id`, nếu thiếu sẽ `AccessDenied` do condition trong trust policy:

```bash
CREDS=$(aws sts assume-role \
  --role-arn arn:aws:iam::$B:role/CrossAcctS3Role \
  --role-session-name thao-xacct \
  --external-id $EXT_ID \
  --duration-seconds 3600 \
  --profile A)
echo "$CREDS"
```

Output mong đợi (rút gọn):

```json
{
  "Credentials": {
    "AccessKeyId": "ASIA...",
    "SecretAccessKey": "....",
    "SessionToken": "FwoGZX...",
    "Expiration": "2026-06-12T03:00:00+00:00"
  },
  "AssumedRoleUser": {
    "AssumedRoleId": "AROA...:thao-xacct",
    "Arn": "arn:aws:sts::222222222222:assumed-role/CrossAcctS3Role/thao-xacct"
  }
}
```

Ba điểm cần để ý: AccessKeyId bắt đầu bằng `ASIA` (temporary, khác `AKIA` của key tĩnh); có thêm `SessionToken` bắt buộc; ARN của caller giờ là `assumed-role/.../thao-xacct` — chính cái session name này xuất hiện trong CloudTrail để truy vết "ai đã làm gì". Xuất credentials ra biến môi trường để dùng:

```bash
export AWS_ACCESS_KEY_ID=$(echo "$CREDS" | jq -r '.Credentials.AccessKeyId')
export AWS_SECRET_ACCESS_KEY=$(echo "$CREDS" | jq -r '.Credentials.SecretAccessKey')
export AWS_SESSION_TOKEN=$(echo "$CREDS" | jq -r '.Credentials.SessionToken')

aws sts get-caller-identity   # Arn phải là assumed-role/CrossAcctS3Role/thao-xacct
aws s3 cp s3://$BUCKET/b.txt -   # đọc được object của account B => cross-account thành công
```

Tương đương trong AWS SDK for JavaScript v3:

```javascript
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

const sts = new STSClient({ region: "ap-southeast-1" });
const { Credentials } = await sts.send(new AssumeRoleCommand({
  RoleArn: "arn:aws:iam::222222222222:role/CrossAcctS3Role",
  RoleSessionName: "thao-xacct",
  ExternalId: "dva-lab-secret-9f3a",
  DurationSeconds: 3600,
}));

// Dùng credentials tạm cho client S3 trỏ vào account B
const s3 = new S3Client({
  region: "ap-southeast-1",
  credentials: {
    accessKeyId: Credentials.AccessKeyId,
    secretAccessKey: Credentials.SecretAccessKey,
    sessionToken: Credentials.SessionToken,   // BẮT BUỘC, thiếu là InvalidAccessKeyId
  },
});
const obj = await s3.send(new GetObjectCommand({ Bucket: "xacct-lab-222222222222", Key: "b.txt" }));
console.log(await obj.Body.transformToString());
```

Trong thực tế production bạn không tự gọi AssumeRole rồi gắn tay như trên — chỉ cần khai báo profile dạng `role_arn` + `source_profile` (CLI) hoặc dùng `fromTemporaryCredentials()` của SDK v3, nó tự assume và tự refresh khi gần hết hạn.

### Bước 4: Thêm session policy để thu hẹp quyền lúc assume

`assume-role` cho phép truyền `--policy` (session policy) để **cắt bớt** quyền của session — kết quả là **giao** (intersection) giữa permission policy của role và session policy, không bao giờ mở rộng thêm. Thử cấp session chỉ được đọc, không được ghi:

```bash
aws sts assume-role \
  --role-arn arn:aws:iam::$B:role/CrossAcctS3Role \
  --role-session-name thao-readonly \
  --external-id $EXT_ID \
  --policy '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:GetObject","Resource":"arn:aws:s3:::xacct-lab-222222222222/*"}]}' \
  --profile A
```

Dù role có quyền `s3:PutObject`, session này sẽ KHÔNG ghi được vì session policy không cho phép — giao của hai tập quyền chỉ còn `GetObject`. Đây là cách một broker cấp quyền hẹp cho từng request mà không phải tạo nhiều role.

### Bước 5: Áp permission boundary (demo cơ chế giới hạn trần quyền)

Permission boundary đặt **trần quyền tối đa** cho một principal: quyền hiệu lực = giao của (identity policy) và (boundary). Tạo một boundary cho phép tối đa S3 và CloudWatch, rồi gắn vào một user mới:

```bash
cat > boundary.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:*", "cloudwatch:*"], "Resource": "*" }
  ]
}
EOF

aws iam create-policy --policy-name DevBoundary \
  --policy-document file://boundary.json --profile B

aws iam create-user --user-name junior-dev \
  --permissions-boundary arn:aws:iam::$B:policy/DevBoundary --profile B

# Gắn AdministratorAccess cho user — nhưng boundary chặn trần
aws iam attach-user-policy --user-name junior-dev \
  --policy-arn arn:aws:iam::aws:policy/AdministratorAccess --profile B
```

Dù user có `AdministratorAccess`, quyền thực tế chỉ còn S3 + CloudWatch vì boundary là trần. Gọi `iam:CreateUser` hay `ec2:*` sẽ `AccessDenied`. Đây là cơ chế delegate an toàn: cho phép junior-dev tự tạo role/user nhưng không thể leo thang vượt boundary (thường kèm điều kiện ép gắn cùng boundary cho mọi principal họ tạo).

### Bước 6: ABAC nhanh — gán quyền theo tag

ABAC dựa trên so khớp tag thay vì liệt kê ARN. Ví dụ một policy cho phép thao tác object S3 chỉ khi tag `project` của principal khớp tag `project` của resource:

```json
{
  "Effect": "Allow",
  "Action": ["s3:GetObject", "s3:PutObject"],
  "Resource": "arn:aws:s3:::xacct-lab-222222222222/*",
  "Condition": {
    "StringEquals": {
      "s3:ExistingObjectTag/project": "${aws:PrincipalTag/project}"
    }
  }
}
```

Khi assume role, có thể truyền session tag: `aws sts assume-role ... --tags Key=project,Value=apollo` (cần trust policy cho phép `sts:TagSession`). Lúc đó `${aws:PrincipalTag/project}` = `apollo`, và principal chỉ chạm được object có tag `project=apollo`. Thêm developer mới chỉ cần gán đúng tag — không sửa policy. Đây là khác biệt cốt lõi RBAC (sửa policy theo từng role) vs ABAC (sửa tag, policy giữ nguyên), điểm đề rất thích hỏi với từ khóa "scale without changing policies".

### Bước 7: Quan sát session hết hạn

Sau khi `Expiration` trôi qua, mọi lệnh dùng bộ credentials tạm sẽ trả `ExpiredToken`:

```bash
# sau >1h hoặc giả lập bằng cách dùng credentials cũ
aws s3 ls s3://$BUCKET --debug 2>&1 | grep -i ExpiredToken
# => An error occurred (ExpiredToken) ... The provided token has expired.
```

Phải gọi lại `assume-role` để lấy bộ mới. SDK tự xử lý việc này nếu dùng credential provider thay vì gắn cứng. Lưu ý: STS không có API "revoke session token" — muốn vô hiệu session đang chạy phải gắn inline policy `AWSRevokeOlderSessions` (Deny mọi action với condition `aws:TokenIssueTime` trước thời điểm hiện tại) vào role.

### Dọn dẹp tài nguyên

```bash
# Xóa biến môi trường credentials tạm để quay lại profile thường
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN

# Account B: detach + xóa user, role, policy, bucket
aws iam detach-user-policy --user-name junior-dev \
  --policy-arn arn:aws:iam::aws:policy/AdministratorAccess --profile B
aws iam delete-user --user-name junior-dev --profile B
aws iam delete-policy --policy-arn arn:aws:iam::$B:policy/DevBoundary --profile B
aws iam delete-role-policy --role-name CrossAcctS3Role --policy-name S3Access --profile B
aws iam delete-role --role-name CrossAcctS3Role --profile B
aws s3 rb s3://$BUCKET --force --profile B

# Account A: gỡ inline policy
aws iam delete-user-policy --user-name dev-thao --policy-name AllowAssumeB --profile A
```

STS và IAM không tính phí, nhưng dọn role/user thừa để không sót đường vào account.

## 💡 Exam Tips chương 45

- **AssumeRole = cross-account hoặc đổi vai trong cùng account.** Đầu ra là temporary credentials (`ASIA...` + SessionToken + Expiration). Bất cứ tình huống nào nói "temporary", "cross-account access", "switch role" → STS AssumeRole.
- Cross-account cần **cả hai phía**: trust policy ở account đích cho phép principal nguồn assume, VÀ identity policy ở account nguồn cho phép gọi `sts:AssumeRole`. Thiếu một bên là `AccessDenied`. Đề hay cho thấy chỉ một bên và hỏi "vì sao vẫn lỗi".
- **ExternalId** dùng khi giao quyền cho **bên thứ ba** (third-party SaaS, ví dụ tool monitoring) để chống *confused deputy*. Third-party đặt ExternalId vào trust policy + bắt mọi khách hàng truyền đúng giá trị, nên một khách không thể bị lừa để vendor assume role của khách khác. ExternalId KHÔNG phải secret bảo mật mạnh, chỉ chống confused deputy.
- **AssumeRoleWithWebIdentity**: federation với OIDC IdP (Google, Facebook, Cognito User Pool, hoặc IRSA cho EKS). **AssumeRoleWithSAML**: federation với SAML 2.0 IdP doanh nghiệp (AD FS, Okta). Cả hai trả về temporary credentials, KHÔNG cần tạo IAM user cho từng người dùng ngoài.
- **GetSessionToken** dùng để có credentials tạm có MFA cho **chính IAM user đang gọi** (không đổi vai). **GetFederationToken** cấp credentials tạm cho federated user mà không cần IAM user riêng (thường từ một service đáng tin). Phân biệt với AssumeRole: GetSessionToken/GetFederationToken không assume role.
- **Session duration**: AssumeRole mặc định 1h, max = `MaxSessionDuration` của role (tối đa 12h). **Role chaining** (assume role từ một role khác) bị giới hạn cứng **1 giờ**, không nâng được. GetSessionToken: 15 phút–36 giờ (mặc định 12h), riêng root chỉ tối đa 1h.
- **Permission boundary** đặt **trần quyền** cho user/role: quyền hiệu lực = giao của identity policy và boundary. Nó KHÔNG tự cấp quyền; chỉ giới hạn. Dùng để cho dev tự tạo role/user mà không leo thang đặc quyền. Đề ra JSON boundary + identity policy rồi hỏi "làm được gì" → lấy giao.
- **Session policy** (`--policy` lúc assume) cũng là phép giao, chỉ thu hẹp quyền của role cho session đó. Không bao giờ mở rộng thêm quyền.
- **Policy evaluation đầy đủ** (cross-account, có Organizations): request được phép chỉ khi qua HẾT các tầng — (1) không có explicit Deny ở đâu, (2) SCP cho phép, (3) resource policy hoặc identity policy cho phép, (4) permission boundary cho phép, (5) session policy cho phép. Bất kỳ tầng nào Deny/không-Allow là chặn. Cross-account còn cần cả hai account đồng ý.
- **ABAC bằng tag**: `aws:PrincipalTag/<key>`, `aws:ResourceTag/<key>`, `aws:RequestTag`, `aws:TagKeys`. Ưu thế: scale khi thêm người/resource mà không sửa policy. Từ khóa đề: "grant access based on tags", "minimize number of policies", "scale to many teams".
- **Cross-account S3/KMS bẫy kinh điển**: assume role ở account B đọc bucket B được, nhưng nếu object mã hóa SSE-KMS bằng customer managed key thì còn cần **key policy của KMS key** cho phép principal đó `kms:Decrypt`. Quyền IAM của S3 đủ mà thiếu quyền KMS vẫn `AccessDenied` (chi tiết KMS ở Chương 46).
- **STS regional vs global endpoint**: mặc định SDK mới dùng regional endpoint (`sts.<region>.amazonaws.com`) — nhanh, chịu lỗi tốt hơn global `sts.amazonaws.com`. Token từ regional endpoint dài hơn; code cũ giới hạn độ dài SessionToken có thể vỡ. Có thể bật/tắt qua `AWS_STS_REGIONAL_ENDPOINTS`.
- **IAM Identity Center (SSO)** và **Resource Access Manager (RAM)** chỉ ở mức nhận diện: Identity Center quản lý SSO + permission set cho nhiều account trong Organization (workforce identity); RAM chia sẻ resource (subnet, Transit Gateway, License...) giữa account mà không cần copy. Đừng nhầm RAM với cross-account IAM role.

## Quiz chương 45 (10 câu)

**Câu 1.** Một SaaS monitoring tool (account của vendor) cần đọc CloudWatch metrics trong account khách hàng. Vendor yêu cầu khách tạo IAM role và cung cấp một chuỗi định danh duy nhất cho mỗi khách. Cơ chế bảo mật nào đang được dùng và để chống lại điều gì?
- A. MFA, chống brute-force
- B. ExternalId trong trust policy, chống confused deputy
- C. Session policy, chống privilege escalation
- D. Permission boundary, chống leo thang đặc quyền

**Câu 2.** Ứng dụng ở account A (111111111111) gọi `sts:AssumeRole` để lấy quyền truy cập bucket S3 ở account B. Trust policy của role ở B đã cho phép account A. Cuộc gọi vẫn trả `AccessDenied` ngay tại bước AssumeRole. Nguyên nhân khả dĩ nhất?
- A. Bucket S3 chưa bật versioning
- B. Identity policy của principal ở account A chưa cho phép `sts:AssumeRole` trên role đó
- C. Role ở B chưa gắn `AmazonS3ReadOnlyAccess`
- D. STS chưa được kích hoạt cho region đó

**Câu 3.** Một developer assume role `RoleX` (có permission `s3:*`) và truyền session policy chỉ cho phép `s3:GetObject`. Trong session đó họ gọi `s3:PutObject`. Kết quả?
- A. Thành công, vì role có `s3:*`
- B. Thành công, vì session policy bổ sung thêm quyền cho role
- C. `AccessDenied`, vì quyền hiệu lực là giao của role policy và session policy
- D. `AccessDenied`, vì session policy ghi đè hoàn toàn role policy thành chỉ đọc

**Câu 4.** Công ty muốn cho phép developer tự tạo IAM role cho ứng dụng của họ, nhưng tuyệt đối không để họ tạo role có quyền vượt quá S3 và DynamoDB. Giải pháp ít rủi ro leo thang đặc quyền nhất?
- A. Gắn `AdministratorAccess` rồi tin tưởng developer
- B. Cấp quyền `iam:CreateRole` kèm điều kiện ép gắn permission boundary giới hạn S3+DynamoDB cho mọi role họ tạo
- C. Dùng SCP chặn toàn bộ IAM
- D. Bắt developer mở ticket để admin tạo role

**Câu 5.** Một web app cho phép người dùng đăng nhập bằng Google rồi upload file trực tiếp lên S3 từ trình duyệt. Cách lấy AWS credentials tạm cho từng người dùng mà KHÔNG tạo IAM user?
- A. `sts:GetSessionToken`
- B. `sts:AssumeRoleWithWebIdentity` (qua Cognito Identity Pool hoặc trực tiếp OIDC)
- C. `sts:AssumeRoleWithSAML`
- D. Tạo sẵn một IAM user dùng chung cho mọi người dùng

**Câu 6.** Role `AppRole` có `MaxSessionDuration` = 12h. Một process assume `AppRole`, rồi từ session đó assume tiếp `AppRole2` (role chaining). Thời lượng tối đa của session thứ hai là?
- A. 12 giờ
- B. 36 giờ
- C. 1 giờ (giới hạn cứng của role chaining)
- D. 15 phút

**Câu 7.** Principal có identity policy Allow `ec2:*` và `s3:*`. Permission boundary của principal chỉ Allow `s3:*`. Người này gọi `ec2:RunInstances`. Kết quả?
- A. Thành công, vì identity policy cho phép `ec2:*`
- B. `AccessDenied`, vì permission boundary không cho phép `ec2`, quyền hiệu lực là giao
- C. Thành công, vì boundary chỉ áp cho role không áp cho user
- D. `AccessDenied`, vì boundary là một explicit deny cho `ec2`

**Câu 8.** Nhiều team chia sẻ một account, mỗi team chỉ được thao tác resource có tag `team` khớp với team mình. Công ty muốn thêm team mới mà không phải viết policy mới mỗi lần. Cách tiếp cận đúng?
- A. RBAC: tạo một managed policy riêng cho mỗi team
- B. ABAC: một policy dùng condition `aws:ResourceTag/team` khớp `aws:PrincipalTag/team`
- C. Tạo một account riêng cho mỗi team
- D. Dùng permission boundary cho mỗi team

**Câu 9.** Một role assume thành công và đọc được bucket cross-account, nhưng các object mã hóa SSE-KMS bằng customer managed key của account đích thì trả `AccessDenied` khi GetObject. Thiếu gì?
- A. Bật versioning trên bucket
- B. Quyền `kms:Decrypt` cho principal trong key policy của KMS key
- C. Tăng `MaxSessionDuration` của role
- D. Thêm `s3:GetObjectVersion` vào policy

**Câu 10.** Một IAM user cần lấy temporary credentials đã xác thực MFA để gọi các API nhạy cảm trong chính account của mình (không đổi vai trò). API STS nào phù hợp?
- A. `AssumeRole`
- B. `GetSessionToken` (kèm `--serial-number` và `--token-code` MFA)
- C. `GetFederationToken`
- D. `AssumeRoleWithWebIdentity`

### Đáp án & giải thích

**Câu 1 — Đáp án B.** Chuỗi định danh duy nhất mỗi khách chính là `ExternalId`, đặt trong trust policy với condition `sts:ExternalId`, chống *confused deputy*: vendor (deputy) không thể bị một khách lừa để assume role của khách khác vì mỗi khách bắt buộc một ExternalId riêng. A sai: không liên quan MFA. C sai: session policy thu hẹp quyền của session, không phải cơ chế tin cậy cross-account. D sai: permission boundary giới hạn trần quyền của một principal, không phải điều kiện assume cross-account.

**Câu 2 — Đáp án B.** Cross-account assume cần CẢ HAI phía: trust policy ở B (đã có) và identity policy ở A cho phép `sts:AssumeRole` trên ARN role. Thiếu phía A thì lỗi xảy ra ngay tại bước AssumeRole, trước khi đụng tới S3. A sai: versioning không liên quan quyền. C sai: nếu thiếu permission policy thì assume vẫn thành công, chỉ lỗi khi gọi S3 sau đó — không phải tại bước assume. D sai: STS bật mặc định ở mọi region thương mại.

**Câu 3 — Đáp án C.** Session policy chỉ THU HẸP: quyền hiệu lực = giao của permission policy của role và session policy. Role có `s3:*` nhưng session chỉ cho `GetObject`, nên `PutObject` bị `AccessDenied`. A sai: session policy đã cắt `PutObject`. B sai: session policy không bao giờ thêm quyền. D sai: nó không "ghi đè" mà lấy giao — diễn đạt D sai về cơ chế dù kết quả tình cờ giống (đọc-only); cách hiểu đúng là intersection.

**Câu 4 — Đáp án B.** Cấp `iam:CreateRole` kèm điều kiện ép `iam:PermissionsBoundary` phải là một boundary giới hạn S3+DynamoDB khiến mọi role developer tạo ra không thể vượt trần đó — chống privilege escalation mà vẫn delegate được. A sai: AdministratorAccess là leo thang không kiểm soát. C sai: chặn toàn bộ IAM thì developer không tạo được gì, không đáp ứng yêu cầu. D sai: giải pháp được nhưng tăng vận hành thủ công, không phải "ít rủi ro leo thang" theo hướng tự phục vụ mà đề nhắm tới.

**Câu 5 — Đáp án B.** Đăng nhập bằng Google là OIDC web identity → `AssumeRoleWithWebIdentity`, thường qua Cognito Identity Pool đổi token IdP lấy AWS credentials tạm (chi tiết ở Chương 39), không cần IAM user. A sai: GetSessionToken chỉ cho IAM user sẵn có lấy credentials tạm, không federate người dùng ngoài. C sai: SAML dành cho IdP doanh nghiệp SAML 2.0, không phải social login OIDC. D sai: user dùng chung phá vỡ audit và least privilege.

**Câu 6 — Đáp án C.** Role chaining (assume role từ một role thay vì từ user) bị giới hạn CỨNG 1 giờ, bất kể `MaxSessionDuration` đặt bao nhiêu; truyền `--duration-seconds` lớn hơn sẽ lỗi. A sai: 12h chỉ áp khi assume trực tiếp từ user, không qua chain. B sai: 36h là trần của GetSessionToken, không liên quan. D sai: 15 phút là sàn của duration, không phải trần chaining.

**Câu 7 — Đáp án B.** Permission boundary đặt trần; quyền hiệu lực = giao của identity policy (`ec2:*`,`s3:*`) và boundary (`s3:*`) = chỉ `s3:*`. `ec2:RunInstances` ngoài giao nên `AccessDenied`. A sai: identity Allow chưa đủ khi boundary không cho. C sai: boundary áp cho cả user lẫn role. D sai về cơ chế: boundary không phải explicit Deny mà là giới hạn Allow tối đa (implicit deny cho thứ ngoài boundary) — phân biệt này hay bị hỏi.

**Câu 8 — Đáp án B.** ABAC: một policy duy nhất dùng condition so khớp `aws:ResourceTag/team` với `aws:PrincipalTag/team`; thêm team mới chỉ cần gán tag, không viết policy mới — đúng yêu cầu "scale without new policies". A sai: RBAC tạo policy mỗi team là chính cái phải tránh. C sai: tách account là quá nặng cho yêu cầu phân quyền theo tag trong một account. D sai: permission boundary giới hạn trần quyền, không phải cơ chế khớp tag resource-principal để cấp quyền.

**Câu 9 — Đáp án B.** SSE-KMS với customer managed key cần principal được key policy (và/hoặc IAM) cho phép `kms:Decrypt`. Quyền S3 đủ nhưng thiếu quyền KMS thì GetObject vẫn `AccessDenied` — bẫy cross-account kinh điển kết hợp S3 + KMS. A sai: versioning không liên quan giải mã. C sai: session duration không gây lỗi quyền KMS. D sai: thiếu `GetObjectVersion` chỉ ảnh hưởng khi truy cập version cụ thể, không phải nguyên nhân lỗi giải mã.

**Câu 10 — Đáp án B.** `GetSessionToken` cấp temporary credentials cho CHÍNH IAM user đang gọi, kèm context MFA khi truyền `--serial-number` và `--token-code` — đúng nhu cầu MFA mà không đổi vai. A sai: AssumeRole là để đổi vai/cross-account, không phải mục tiêu ở đây. C sai: GetFederationToken cấp cho federated user (không phải bản thân user gọi với MFA). D sai: WithWebIdentity dành cho OIDC federation, không liên quan.

## Tóm tắt chương

- **STS** cấp temporary security credentials (`ASIA...` + SessionToken + Expiration); là nền tảng cho cross-account access, role switching và federation — luôn ưu tiên hơn key tĩnh.
- **AssumeRole** đổi vai/cross-account trong AWS; **AssumeRoleWithSAML** federation SAML 2.0 doanh nghiệp; **AssumeRoleWithWebIdentity** federation OIDC/social (qua Cognito Identity Pool — Chương 39); **GetSessionToken** lấy credentials tạm + MFA cho chính user; **GetFederationToken** cấp cho federated user không cần IAM user.
- **Cross-account cần cả hai phía**: trust policy ở account đích cho phép principal nguồn assume, và identity policy ở account nguồn cho phép gọi `sts:AssumeRole`; thiếu một bên là `AccessDenied`.
- **ExternalId** chống *confused deputy* khi delegate cho bên thứ ba; đặt trong trust policy bằng condition `sts:ExternalId`, mỗi khách một giá trị riêng.
- **Session duration**: AssumeRole mặc định 1h, max 12h theo `MaxSessionDuration`; **role chaining giới hạn cứng 1 giờ**; GetSessionToken 15 phút–36 giờ (root tối đa 1h).
- **Session policy** (lúc assume) và **permission boundary** (gắn vào principal) đều là phép **giao** — chỉ thu hẹp, không bao giờ mở rộng quyền.
- **Permission boundary** đặt trần quyền tối đa, dùng để delegate việc tạo role/user an toàn mà không cho leo thang đặc quyền; thường ép gắn boundary cho mọi entity con được tạo.
- **Policy evaluation đầy đủ**: explicit deny ở bất kỳ tầng nào (identity, resource, SCP, boundary, session) đều chặn; được phép chỉ khi qua hết các tầng Allow cần thiết.
- **ABAC** dùng `aws:PrincipalTag`/`aws:ResourceTag`/`aws:RequestTag` để cấp quyền theo tag — mở rộng quy mô khi thêm người/resource mà không sửa policy (khác RBAC).
- **Bẫy cross-account S3 + KMS**: đọc object SSE-KMS bằng customer managed key còn cần `kms:Decrypt` trong key policy của account đích, ngoài quyền S3 (chi tiết Chương 46).
- **STS regional endpoint** mặc định nhanh và chịu lỗi tốt hơn global; token regional dài hơn nên code cũ giả định độ dài cố định có thể vỡ.
- **IAM Identity Center (SSO)** quản lý SSO + permission set cho nhiều account; **Resource Access Manager (RAM)** chia sẻ resource giữa account — cả hai chỉ ở mức nhận diện cho DVA-C02.
