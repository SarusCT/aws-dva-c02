## Hands-on Lab: Cấp AWS credentials tạm cho user qua Identity Pool, fine-grained S3 access bằng policy variable, và role mapping theo group

**Mục tiêu lab:** Dựng một **Cognito User Pool** (nguồn token), gắn nó làm authentication provider cho một **Cognito Identity Pool** (Federated Identities). User đăng nhập User Pool lấy ID token, đổi token đó qua Identity Pool để nhận **AWS credentials tạm** (do STS phát hành), rồi dùng chính credentials đó upload thẳng lên S3 vào đúng **prefix riêng của user** nhờ policy variable `${cognito-identity.amazonaws.com:sub}`. Cuối cùng cấu hình **role mapping** để user thuộc group `admins` nhận role mạnh hơn user thường. Toàn bộ làm bằng AWS CLI v2 để bạn thấy rõ cơ chế bên dưới console.

**Chuẩn bị:**
- AWS CLI v2 đã cấu hình profile có quyền `cognito-idp:*`, `cognito-identity:*`, `iam:CreateRole/PutRolePolicy/PassRole`, `s3:*`.
- Region xuyên suốt: `ap-southeast-1`.
- `jq` để lọc JSON (tiện nhưng không bắt buộc).

```bash
export AWS_REGION="ap-southeast-1"
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export BUCKET="dva-ch39-uploads-${ACCOUNT_ID}"
aws s3 mb "s3://${BUCKET}" --region "$AWS_REGION"
```

### Bước 1: Tạo User Pool và app client (nguồn token)

User Pool ở chương này chỉ đóng vai trò **identity provider** cho Identity Pool — chi tiết User Pool ở Chương 38. Tạo nhanh một pool + app client không secret (vì client là SPA/mobile):

```bash
POOL_ID=$(aws cognito-idp create-user-pool --pool-name dva-ch39-pool \
  --query UserPool.Id --output text)

CLIENT_ID=$(aws cognito-idp create-user-pool-client --user-pool-id "$POOL_ID" \
  --client-name dva-ch39-client --no-generate-secret \
  --explicit-auth-flows ALLOW_USER_PASSWORD_AUTH ALLOW_REFRESH_TOKEN_AUTH \
  --query UserPoolClient.ClientId --output text)

# Tạo user + đặt password vĩnh viễn (bỏ qua flow xác nhận cho gọn lab)
aws cognito-idp admin-create-user --user-pool-id "$POOL_ID" \
  --username alice --message-action SUPPRESS
aws cognito-idp admin-set-user-password --user-pool-id "$POOL_ID" \
  --username alice --password 'Passw0rd!23' --permanent

# Tạo group admins và gán alice vào (dùng cho role mapping ở Bước 6)
aws cognito-idp create-group --user-pool-id "$POOL_ID" --group-name admins
aws cognito-idp admin-add-user-to-group --user-pool-id "$POOL_ID" \
  --username alice --group-name admins
```

### Bước 2: Tạo Identity Pool và liên kết User Pool

Identity Pool nhận `cognito-idp.<region>.amazonaws.com/<userPoolId>` làm provider, với `ClientId` là app client ở trên. Đặt `AllowUnauthenticatedIdentities=false` (lab này không cần guest):

```bash
IDENTITY_POOL_ID=$(aws cognito-identity create-identity-pool \
  --identity-pool-name dva_ch39_idpool \
  --no-allow-unauthenticated-identities \
  --cognito-identity-providers \
    ProviderName="cognito-idp.${AWS_REGION}.amazonaws.com/${POOL_ID}",ClientId="${CLIENT_ID}",ServerSideTokenCheck=false \
  --query IdentityPoolId --output text)
echo "$IDENTITY_POOL_ID"   # dạng ap-southeast-1:xxxxxxxx-xxxx-...
```

> Bẫy tên provider: phải đúng định dạng `cognito-idp.<region>.amazonaws.com/<userPoolId>` (không có `https://`). Sai một ký tự là token bị từ chối ở bước `get-id`/`get-credentials-for-identity` với `NotAuthorizedException`.

### Bước 3: Tạo IAM role cho authenticated identity với trust policy `cognito-identity`

Đây là trái tim của Identity Pool. Trust policy KHÔNG tin `cognito-idp` mà tin **`cognito-identity.amazonaws.com`**, dùng `AssumeRoleWithWebIdentity`, và **lọc đúng identity pool** qua condition `aud` + chỉ nhận `authenticated`:

```bash
cat > trust-auth.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "cognito-identity.amazonaws.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "cognito-identity.amazonaws.com:aud": "${IDENTITY_POOL_ID}" },
      "ForAnyValue:StringLike": { "cognito-identity.amazonaws.com:amr": "authenticated" }
    }
  }]
}
EOF
AUTH_ROLE_ARN=$(aws iam create-role --role-name dva-ch39-auth-role \
  --assume-role-policy-document file://trust-auth.json --query Role.Arn --output text)
```

Permission policy với **fine-grained access**: user chỉ được đụng tới prefix `private/${cognito-identity.amazonaws.com:sub}/` của riêng mình. `sub` ở đây là **identity ID** do Identity Pool cấp (ổn định cho mỗi user), KHÁC `sub` trong JWT của User Pool.

```bash
cat > perm-auth.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListOwnPrefix",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::${BUCKET}",
      "Condition": { "StringLike": {
        "s3:prefix": [ "private/\${cognito-identity.amazonaws.com:sub}/*" ] } }
    },
    {
      "Sid": "RWOwnObjects",
      "Effect": "Allow",
      "Action": ["s3:GetObject","s3:PutObject","s3:DeleteObject"],
      "Resource": "arn:aws:s3:::${BUCKET}/private/\${cognito-identity.amazonaws.com:sub}/*"
    }
  ]
}
EOF
aws iam put-role-policy --role-name dva-ch39-auth-role \
  --policy-name s3-own-prefix --policy-document file://perm-auth.json
```

> Bẫy escape: trong heredoc `EOF` (không quote), `${IDENTITY_POOL_ID}` được shell thay; còn `\${cognito-identity.amazonaws.com:sub}` phải để dấu `\$` để giữ nguyên cho IAM hiểu là **policy variable**, không cho shell ăn mất. Đây là lỗi sai phổ biến nhất khi viết policy variable bằng CLI.

### Bước 4: Gắn role mặc định vào Identity Pool

```bash
aws cognito-identity set-identity-pool-roles \
  --identity-pool-id "$IDENTITY_POOL_ID" \
  --roles authenticated="$AUTH_ROLE_ARN"
```

### Bước 5: Đăng nhập, đổi token lấy AWS credentials, upload S3

Luồng đầy đủ (đây chính là kiến trúc "web app upload S3 trực tiếp"):

```bash
# 5a. Đăng nhập User Pool -> lấy ID token
ID_TOKEN=$(aws cognito-idp initiate-auth --auth-flow USER_PASSWORD_AUTH \
  --client-id "$CLIENT_ID" \
  --auth-parameters USERNAME=alice,PASSWORD='Passw0rd!23' \
  --query 'AuthenticationResult.IdToken' --output text)

# 5b. GetId: đổi ID token lấy IdentityId (lần đầu sẽ tạo identity mới)
PROVIDER="cognito-idp.${AWS_REGION}.amazonaws.com/${POOL_ID}"
IDENTITY_ID=$(aws cognito-identity get-id \
  --identity-pool-id "$IDENTITY_POOL_ID" \
  --logins "${PROVIDER}=${ID_TOKEN}" --query IdentityId --output text)

# 5c. GetCredentialsForIdentity: Identity Pool gọi STS AssumeRoleWithWebIdentity hộ bạn
CREDS=$(aws cognito-identity get-credentials-for-identity \
  --identity-id "$IDENTITY_ID" \
  --logins "${PROVIDER}=${ID_TOKEN}" --query Credentials)

export AWS_ACCESS_KEY_ID=$(echo "$CREDS" | jq -r .AccessKeyId)
export AWS_SECRET_ACCESS_KEY=$(echo "$CREDS" | jq -r .SecretKey)
export AWS_SESSION_TOKEN=$(echo "$CREDS" | jq -r .SessionToken)
```

`IDENTITY_ID` có dạng `ap-southeast-1:uuid` — đó chính là giá trị `${cognito-identity.amazonaws.com:sub}` mà policy variable nội suy. Lấy phần uuid để dựng prefix:

```bash
SUB=$IDENTITY_ID   # toàn bộ "region:uuid" chính là sub
echo "hello from alice" > /tmp/ok.txt

# Upload vào ĐÚNG prefix của mình -> thành công
aws s3 cp /tmp/ok.txt "s3://${BUCKET}/private/${SUB}/ok.txt"
# upload: ../ok.txt to s3://.../private/ap-southeast-1:uuid/ok.txt

# Thử ghi sang prefix người khác -> Access Denied (fine-grained chặn)
aws s3 cp /tmp/ok.txt "s3://${BUCKET}/private/someone-else/ok.txt"
# An error occurred (AccessDenied) ... -> ĐÚNG như mong đợi
```

Nhớ trả lại credentials gốc trước khi làm bước quản trị tiếp theo:

```bash
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
```

### Bước 6: Role mapping theo group (rules-based)

Khi user thuộc group trong User Pool, ID token chứa claim `cognito:groups`. Cấu hình Identity Pool **rules-based role mapping** trên claim đó: ai thuộc `admins` thì nhận một role mạnh hơn, còn lại nhận role mặc định.

```bash
# Tạo role admin (cùng trust policy cognito-identity, quyền rộng hơn -> ví dụ full bucket)
ADMIN_ROLE_ARN=$(aws iam create-role --role-name dva-ch39-admin-role \
  --assume-role-policy-document file://trust-auth.json --query Role.Arn --output text)
cat > perm-admin.json <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow",
 "Action":"s3:*","Resource":["arn:aws:s3:::${BUCKET}","arn:aws:s3:::${BUCKET}/*"]}]}
EOF
aws iam put-role-policy --role-name dva-ch39-admin-role \
  --policy-name s3-full --policy-document file://perm-admin.json

# Gắn role mapping: claim cognito:groups == "admins" -> admin role; còn lại -> auth role
cat > role-mapping.json <<EOF
{
  "cognito-idp.${AWS_REGION}.amazonaws.com/${POOL_ID}:${CLIENT_ID}": {
    "Type": "Rules",
    "AmbiguousRoleResolution": "AuthenticatedRole",
    "RulesConfiguration": { "Rules": [
      { "Claim": "cognito:groups", "MatchType": "Contains",
        "Value": "admins", "RoleARN": "${ADMIN_ROLE_ARN}" }
    ]}
  }
}
EOF
aws cognito-identity set-identity-pool-roles \
  --identity-pool-id "$IDENTITY_POOL_ID" \
  --roles authenticated="$AUTH_ROLE_ARN" \
  --role-mappings file://role-mapping.json
```

`AmbiguousRoleResolution=AuthenticatedRole` nghĩa là user không khớp rule nào sẽ rơi về role `authenticated` mặc định. Nếu đặt `Deny` thì user không khớp sẽ bị từ chối hẳn. Đăng nhập lại alice và lặp Bước 5 — lần này vì alice ∈ `admins`, credentials nhận được sẽ assume `dva-ch39-admin-role` (ghi được toàn bucket). Lưu ý: phải lấy **ID token mới** sau khi cấu hình role mapping để claim `cognito:groups` được map.

> Bẫy token chọn role: chỉ **ID token** mới chứa `cognito:groups`. Nếu app gửi nhầm **access token** lên `get-credentials-for-identity`, rule trên claim group sẽ không khớp và user rơi về role mặc định.

### Dọn dẹp tài nguyên

```bash
aws s3 rm "s3://${BUCKET}" --recursive
aws s3 rb "s3://${BUCKET}"
aws cognito-identity delete-identity-pool --identity-pool-id "$IDENTITY_POOL_ID"
aws cognito-idp delete-user-pool --user-pool-id "$POOL_ID"
for R in dva-ch39-auth-role dva-ch39-admin-role; do
  for P in $(aws iam list-role-policies --role-name "$R" --query 'PolicyNames[]' --output text); do
    aws iam delete-role-policy --role-name "$R" --policy-name "$P"
  done
  aws iam delete-role --role-name "$R"
done
rm -f trust-auth.json perm-auth.json perm-admin.json role-mapping.json /tmp/ok.txt
```

> Identity Pool và User Pool không tính phí lưu trữ theo giờ, nhưng cứ dọn cho sạch account. Role và inline policy không mất tiền nhưng dễ tích tụ rác.

## 💡 Exam Tips chương 39

- **User Pool vs Identity Pool — phân biệt cốt lõi:** User Pool = *authentication* (đăng nhập, phát JWT, là directory người dùng). Identity Pool (Federated Identities) = *authorization vào AWS*, đổi token (từ User Pool, social, SAML, OIDC, developer-authenticated) lấy **AWS credentials tạm** qua STS. Câu hỏi "cần truy cập trực tiếp dịch vụ AWS (S3/DynamoDB) từ client" → Identity Pool.
- **STS bên dưới:** Identity Pool gọi `sts:AssumeRoleWithWebIdentity` để cấp credentials. Trust policy của role phải tin Principal **`cognito-identity.amazonaws.com`** (KHÔNG phải `cognito-idp`), với condition `cognito-identity.amazonaws.com:aud` = identity pool ID và `amr` = `authenticated`/`unauthenticated`.
- **Authenticated vs unauthenticated identities:** Identity Pool cấp 2 role. Unauthenticated (guest) cho phép truy cập hạn chế mà không cần đăng nhập — chỉ bật khi thực sự cần và siết quyền chặt. Bật/tắt qua `AllowUnauthenticatedIdentities`.
- **Fine-grained access bằng policy variable:** `${cognito-identity.amazonaws.com:sub}` (identity ID) dùng làm **S3 prefix** hoặc DynamoDB **LeadingKeys** để mỗi user chỉ thấy dữ liệu của mình. Đây là pattern multi-tenant kinh điển trong đề. `sub` này là identity ID của Identity Pool, khác `sub` trong JWT User Pool.
- **Hai cách map role:** (1) gán role mặc định authenticated/unauthenticated; (2) **role mapping** — *rules-based* (theo claim trong token, ví dụ `cognito:groups`) hoặc *token-based* (dùng claim `cognito:preferred_role`/`cognito:roles` do User Pool group quyết định). `AmbiguousRoleResolution`: `AuthenticatedRole` (rơi về role mặc định) hoặc `Deny`.
- **User Pool groups + role mapping:** gán user vào group, mỗi group có IAM role + precedence; ID token mang `cognito:groups`, `cognito:preferred_role`, `cognito:roles`. Identity Pool dùng các claim này chọn role. Chỉ **ID token** chứa các claim group — không phải access token.
- **Identity Pool nhận nhiều provider:** User Pool, Login with Amazon, Facebook, Google, Apple/SAML, OIDC, và **developer-authenticated identities** (backend tự xác thực rồi gọi `GetOpenIdTokenForDeveloperIdentity`). Khi enhanced flow bật, client chỉ gọi `GetCredentialsForIdentity`.
- **Enhanced (simplified) flow vs basic flow:** enhanced flow = client gọi `GetId` rồi `GetCredentialsForIdentity` (Identity Pool tự gọi STS, ít round-trip, role chọn server-side, an toàn hơn). Basic (classic) flow = client tự gọi `GetOpenIdToken` rồi `sts:AssumeRoleWithWebIdentity`. Đề khuyến nghị enhanced flow.
- **Kiến trúc kết hợp:** điển hình là User Pool (login + JWT để gọi API Gateway/AppSync) **kết hợp** Identity Pool (đổi JWT lấy credentials để client thao tác trực tiếp S3/DynamoDB/Kinesis). Hai dịch vụ bổ trợ nhau, không thay thế nhau.
- **Cognito Sync là legacy** — đồng bộ user data/preferences giữa thiết bị qua dataset key-value, có push sync qua SNS. AWS khuyến nghị chuyển sang **AWS AppSync** (GraphQL + DataStore offline). Trong đề mới, nếu hỏi "đồng bộ dữ liệu app đa thiết bị, có offline" → AppSync, không phải Cognito Sync.
- **Lỗi hay gặp:** `NotAuthorizedException` ở `get-id` thường do sai `ProviderName`/`ClientId` hoặc token hết hạn; `AccessDenied` khi gọi S3 dù credentials hợp lệ thường do **policy variable sai cú pháp** hoặc dùng nhầm claim. Trust policy thiếu condition `aud` = lỗ hổng cho người khác assume role.

## Quiz chương 39 (10 câu)

**Câu 1.** Một mobile app cần cho phép người dùng (đã đăng nhập bằng Cognito User Pool) **upload ảnh trực tiếp lên S3** từ thiết bị, mỗi user chỉ ghi được vào thư mục riêng. Cách thiết kế đúng và ít overhead nhất?
- A. Backend ký presigned URL cho từng lần upload
- B. Dùng Cognito Identity Pool đổi ID token lấy AWS credentials, IAM policy giới hạn prefix bằng `${cognito-identity.amazonaws.com:sub}`
- C. Cấp mỗi user một IAM user riêng
- D. Cho app dùng một access key chung nhúng trong client

**Câu 2.** Trust policy của IAM role gắn cho authenticated identity trong Identity Pool phải tin Principal nào?
- A. `cognito-idp.amazonaws.com`
- B. `cognito-identity.amazonaws.com`
- C. `sts.amazonaws.com`
- D. `apigateway.amazonaws.com`

**Câu 3.** Một developer muốn user thuộc group `admins` (trong User Pool) nhận một IAM role mạnh hơn user thường khi lấy credentials từ Identity Pool. Cơ chế nào?
- A. Lambda pre-token-generation trigger
- B. Rules-based role mapping trên claim `cognito:groups`
- C. API Gateway Cognito authorizer
- D. SCP trong Organizations

**Câu 4.** Trong enhanced (simplified) authentication flow của Identity Pool, client gọi những API nào để có credentials?
- A. `sts:AssumeRoleWithWebIdentity` trực tiếp
- B. `GetId` rồi `GetCredentialsForIdentity`
- C. `InitiateAuth` rồi `AssumeRole`
- D. `GetOpenIdToken` rồi `AssumeRoleWithWebIdentity`

**Câu 5.** Một app cho phép **khách chưa đăng nhập** (guest) xem nội dung công khai và ghi log analytics vào một Kinesis stream, không cần tài khoản. Cấu hình Identity Pool nào phù hợp?
- A. Chỉ authenticated role
- B. Bật unauthenticated identities và gán unauthenticated role có quyền tối thiểu
- C. Tạo IAM user guest dùng chung
- D. Dùng User Pool guest account

**Câu 6.** Developer cần mỗi user chỉ đọc/ghi được các item DynamoDB có partition key bằng chính ID của họ. Dùng yếu tố nào trong IAM policy?
- A. Condition `dynamodb:LeadingKeys` với `${cognito-identity.amazonaws.com:sub}`
- B. GSI riêng cho từng user
- C. Một DynamoDB table cho mỗi user
- D. Lambda authorizer kiểm tra trong code

**Câu 7.** Hệ thống đã có cơ chế xác thực riêng (LDAP nội bộ). Họ muốn cấp AWS credentials tạm cho user mà không tạo User Pool, để client upload S3. Hướng nào của Cognito phù hợp?
- A. Social federation
- B. Developer-authenticated identities (`GetOpenIdTokenForDeveloperIdentity`)
- C. SAML federation bắt buộc
- D. Không thể, phải tạo User Pool

**Câu 8.** Một app cần đồng bộ preferences của user (theme, settings) giữa nhiều thiết bị và hoạt động cả khi offline. Giải pháp AWS được khuyến nghị hiện nay?
- A. Cognito Sync
- B. AWS AppSync với DataStore (offline)
- C. Lưu vào localStorage
- D. DynamoDB Global Tables truy cập trực tiếp từ client

**Câu 9.** Sau khi đăng nhập User Pool, app gọi `get-credentials-for-identity` nhưng role mapping theo `cognito:groups` không khớp, user luôn nhận role mặc định. Nguyên nhân khả dĩ nhất?
- A. Trust policy sai
- B. App gửi access token thay vì ID token lên Identity Pool
- C. Identity Pool chưa bật unauthenticated
- D. Bucket policy chặn

**Câu 10.** Câu hỏi phân biệt: trường hợp nào cần **Identity Pool** chứ KHÔNG phải chỉ User Pool authorizer của API Gateway?
- A. Bảo vệ REST API endpoint bằng JWT do User Pool phát hành
- B. Client cần SDK gọi thẳng S3/DynamoDB bằng AWS credentials, không qua API tự viết
- C. Đăng nhập bằng email/password và nhận JWT
- D. Bật MFA cho user

### Đáp án & giải thích

**Câu 1 — Đáp án B.** Đây là pattern kinh điển: Identity Pool đổi ID token lấy credentials tạm, IAM policy dùng policy variable `${cognito-identity.amazonaws.com:sub}` giới hạn prefix S3 cho từng user — client upload thẳng, không cần backend trung gian. A (presigned URL) có thể làm nhưng cần backend ký mỗi lần → nhiều overhead hơn cho upload liên tục. C không khả thi ở quy mô (IAM user có quota, không dành cho end-user). D nhúng access key trong client là lỗ hổng bảo mật nghiêm trọng.

**Câu 2 — Đáp án B.** Identity Pool gọi `AssumeRoleWithWebIdentity` với web identity là `cognito-identity.amazonaws.com`, nên trust policy phải tin Principal Federated này. A (`cognito-idp`) là service của User Pool, không phải nơi assume role. C (`sts`) không phải Principal trong trust của Cognito. D không liên quan.

**Câu 3 — Đáp án B.** Rules-based role mapping cho phép chọn IAM role theo claim trong token, ví dụ `cognito:groups Contains admins`. A (pre-token-generation) chỉ chỉnh claim trong token User Pool, không trực tiếp chọn role Identity Pool. C (Cognito authorizer) bảo vệ API Gateway, không cấp AWS credentials. D (SCP) là guardrail tổ chức, không map role per-user.

**Câu 4 — Đáp án B.** Enhanced flow: client gọi `GetId` lấy IdentityId rồi `GetCredentialsForIdentity` (Identity Pool tự gọi STS server-side). A và D mô tả basic/classic flow (client tự gọi STS). C là flow của User Pool (`InitiateAuth`), không phải lấy AWS credentials.

**Câu 5 — Đáp án B.** Identity Pool hỗ trợ **unauthenticated identities**: bật `AllowUnauthenticatedIdentities` và gán một unauthenticated role quyền tối thiểu (ví dụ chỉ `kinesis:PutRecord` vào đúng stream). A không cho guest. C/D đều sai cách: IAM user dùng chung là phản pattern; User Pool guest account không phải khái niệm chuẩn cho truy cập AWS ẩn danh.

**Câu 6 — Đáp án A.** DynamoDB fine-grained access dùng condition `dynamodb:LeadingKeys` so khớp partition key với `${cognito-identity.amazonaws.com:sub}` — đúng cơ chế multi-tenant một bảng. B/C tốn kém và không cần thiết. D đẩy bảo mật vào code thay vì IAM, không phải cách AWS khuyến nghị và dễ rò rỉ.

**Câu 7 — Đáp án B.** Developer-authenticated identities: backend tự xác thực (LDAP) rồi gọi `GetOpenIdTokenForDeveloperIdentity` để Identity Pool cấp token, đổi lấy AWS credentials — không cần User Pool. A (social) đòi IdP bên thứ ba. C (SAML) không bắt buộc và đây là LDAP nội bộ tự xử lý. D sai — đây chính là use case của developer-authenticated identities.

**Câu 8 — Đáp án B.** AWS khuyến nghị **AppSync (+ DataStore)** thay cho Cognito Sync (legacy) cho đồng bộ dữ liệu đa thiết bị có hỗ trợ offline và conflict resolution. A là dịch vụ cũ AWS đang chuyển dịch. C không đồng bộ giữa thiết bị. D cho client truy cập Global Tables trực tiếp là không an toàn/không có lớp offline.

**Câu 9 — Đáp án B.** Chỉ **ID token** chứa claim `cognito:groups`; nếu app gửi access token, rule role mapping trên claim group không khớp và user rơi về role mặc định. A sẽ gây lỗi assume hẳn, không "rơi về mặc định". C không liên quan tới việc map role authenticated. D là lỗi khác (S3), không phải lý do role mapping trượt.

**Câu 10 — Đáp án B.** Identity Pool cần thiết khi client phải **gọi trực tiếp dịch vụ AWS bằng AWS credentials** (S3, DynamoDB, Kinesis...) qua SDK. A/C/D đều là chức năng của User Pool: bảo vệ API bằng JWT authorizer, đăng nhập nhận JWT, bật MFA — không cần Identity Pool.

## Tóm tắt chương

- **User Pool = authentication** (directory + JWT); **Identity Pool (Federated Identities) = authorization vào AWS**, đổi token lấy **AWS credentials tạm** qua STS. Đây là cặp phân biệt kinh điển nhất của chương.
- Identity Pool gọi **`sts:AssumeRoleWithWebIdentity`**; IAM role phải có trust policy tin Principal **`cognito-identity.amazonaws.com`** với condition `aud` = identity pool ID và `amr` = authenticated/unauthenticated.
- Identity Pool cấp **2 role**: authenticated và unauthenticated (guest). Bật guest qua `AllowUnauthenticatedIdentities` và luôn siết quyền tối thiểu cho unauthenticated role.
- **Fine-grained access**: policy variable `${cognito-identity.amazonaws.com:sub}` (identity ID) dùng làm **S3 prefix** và DynamoDB **`dynamodb:LeadingKeys`** để cô lập dữ liệu từng user trong một bucket/table chung.
- **Role mapping** có 2 kiểu: *rules-based* (theo claim như `cognito:groups`) và *token-based* (theo `cognito:preferred_role`/`cognito:roles`). `AmbiguousRoleResolution` quyết định user không khớp rule sẽ rơi về role mặc định hay bị Deny.
- **User Pool groups** mang IAM role + precedence vào ID token (`cognito:groups`, `cognito:preferred_role`); chỉ **ID token** chứa các claim này, không phải access token.
- **Enhanced flow** (khuyến nghị): client chỉ gọi `GetId` + `GetCredentialsForIdentity`, Identity Pool tự gọi STS. **Basic flow**: client tự gọi `GetOpenIdToken` + `AssumeRoleWithWebIdentity`.
- Identity Pool nhận nhiều IdP: User Pool, social (Google/Facebook/Apple/Amazon), SAML, OIDC, và **developer-authenticated identities** (`GetOpenIdTokenForDeveloperIdentity`) cho hệ xác thực sẵn có.
- **Kiến trúc kết hợp** thường gặp: User Pool lo login + JWT (gọi API Gateway/AppSync), Identity Pool đổi JWT lấy credentials để client thao tác trực tiếp S3/DynamoDB/Kinesis.
- **Cognito Sync là legacy** (đồng bộ key-value đa thiết bị, push qua SNS); AWS khuyến nghị **AWS AppSync + DataStore** cho đồng bộ dữ liệu đa thiết bị có offline & conflict resolution.
- Bẫy thực tế: sai `ProviderName`/`ClientId` → `NotAuthorizedException`; policy variable escape sai → `AccessDenied`; gửi access token thay ID token → role mapping theo group trượt; trust policy thiếu condition `aud` → lỗ hổng cross-pool.
