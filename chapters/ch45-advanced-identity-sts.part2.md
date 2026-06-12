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
