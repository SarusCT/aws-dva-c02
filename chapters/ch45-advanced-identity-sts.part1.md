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
