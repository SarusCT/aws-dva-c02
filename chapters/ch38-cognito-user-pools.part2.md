## Hands-on Lab: Dựng User Pool, đăng ký/đăng nhập bằng CLI, verify JWT và bảo vệ API Gateway bằng Cognito authorizer

**Mục tiêu lab:** Tạo một Cognito User Pool hoàn chỉnh bằng AWS CLI v2: cấu hình password policy, app client (public, không secret) cho luồng `USER_PASSWORD_AUTH`, đăng ký một user, xác nhận user bằng quyền admin, đăng nhập để lấy bộ ba JWT (ID/Access/Refresh token), tự verify chữ ký token bằng JWKS trong Node.js (SDK v3), tạo một user pool group, và cuối cùng gắn Cognito User Pool authorizer vào một REST API Gateway để chặn request không có token hợp lệ.

**Chuẩn bị:**
- AWS CLI v2 đã cấu hình profile có quyền `cognito-idp:*`, `apigateway:*` (dùng tài khoản học tập, không phải production).
- Node.js >= 18, đã `npm install aws-jwt-verify @aws-sdk/client-cognito-identity-provider`.
- Region dùng xuyên suốt: `ap-southeast-1`.

```bash
export AWS_REGION="ap-southeast-1"
export POOL_NAME="dva-lab-ch38-pool"
```

> Lưu ý chi phí: User Pool tính tiền theo MAU (Monthly Active Users), 50.000 MAU đầu tiên miễn phí ở tier truyền thống. Lab này chỉ tạo vài user nên gần như $0, nhưng vẫn nhớ dọn dẹp ở cuối.

### Bước 1: Tạo User Pool với password policy và auto-verify email

```bash
aws cognito-idp create-user-pool \
  --pool-name "$POOL_NAME" \
  --region "$AWS_REGION" \
  --policies '{"PasswordPolicy":{"MinimumLength":8,"RequireUppercase":true,"RequireLowercase":true,"RequireNumbers":true,"RequireSymbols":false}}' \
  --auto-verified-attributes email \
  --username-attributes email \
  --mfa-configuration OFF \
  --schema Name=email,Required=true,Mutable=true
```

Output (rút gọn) trả về `Id` của pool dạng `ap-southeast-1_xxxxxxxxx`:

```json
{
  "UserPool": {
    "Id": "ap-southeast-1_AbCdEf123",
    "Name": "dva-lab-ch38-pool",
    "MfaConfiguration": "OFF",
    "Arn": "arn:aws:cognito-idp:ap-southeast-1:111122223333:userpool/ap-southeast-1_AbCdEf123"
  }
}
```

Lưu lại Pool ID:

```bash
export POOL_ID="ap-southeast-1_AbCdEf123"   # thay bằng Id thật của bạn
```

Bẫy cần nhớ: khi đặt `--username-attributes email`, người dùng đăng nhập bằng email chứ không phải một username riêng. Bạn KHÔNG thể đổi cấu hình này sau khi pool đã tạo — `username-attributes` là bất biến, muốn đổi phải tạo pool mới.

### Bước 2: Tạo app client public (không có client secret)

App client dùng từ trình duyệt / mobile (SPA) PHẢI không có secret, vì secret không thể giữ bí mật ở client. Ta cũng bật explicit auth flow `ALLOW_USER_PASSWORD_AUTH` cho lab (production nên ưu tiên SRP).

```bash
aws cognito-idp create-user-pool-client \
  --user-pool-id "$POOL_ID" \
  --client-name "dva-lab-spa-client" \
  --no-generate-secret \
  --explicit-auth-flows ALLOW_USER_PASSWORD_AUTH ALLOW_REFRESH_TOKEN_AUTH \
  --region "$AWS_REGION"
```

Output trả về `ClientId`:

```json
{
  "UserPoolClient": {
    "ClientId": "1h57kf5cpq17m0eml12EXAMPLE",
    "TokenValidityUnits": {"AccessToken":"hours","IdToken":"hours","RefreshToken":"days"}
  }
}
```

```bash
export CLIENT_ID="1h57kf5cpq17m0eml12EXAMPLE"
```

Bẫy thi: nếu gọi `InitiateAuth` với flow chưa được bật trong `explicit-auth-flows`, bạn nhận lỗi `InvalidParameterException: USER_PASSWORD_AUTH flow not enabled for this client`. Mặc định app client mới KHÔNG bật `ALLOW_USER_PASSWORD_AUTH`.

### Bước 3: Đăng ký user và xác nhận bằng quyền admin

Đăng ký bình thường (luồng người dùng tự sign-up):

```bash
aws cognito-idp sign-up \
  --client-id "$CLIENT_ID" \
  --username "dev@example.com" \
  --password "Passw0rd!" \
  --user-attributes Name=email,Value=dev@example.com \
  --region "$AWS_REGION"
```

User vừa tạo ở trạng thái `UNCONFIRMED`. Bình thường user sẽ nhập code gửi qua email (`confirm-sign-up`). Trong lab không có inbox thật, ta dùng quyền admin để xác nhận thẳng:

```bash
aws cognito-idp admin-confirm-sign-up \
  --user-pool-id "$POOL_ID" \
  --username "dev@example.com" \
  --region "$AWS_REGION"
```

Giờ user ở trạng thái `CONFIRMED`. Kiểm tra:

```bash
aws cognito-idp admin-get-user \
  --user-pool-id "$POOL_ID" \
  --username "dev@example.com" \
  --query 'UserStatus'
# "CONFIRMED"
```

### Bước 4: Đăng nhập lấy JWT tokens

```bash
aws cognito-idp initiate-auth \
  --client-id "$CLIENT_ID" \
  --auth-flow USER_PASSWORD_AUTH \
  --auth-parameters USERNAME=dev@example.com,PASSWORD='Passw0rd!' \
  --region "$AWS_REGION"
```

Output (rút gọn):

```json
{
  "AuthenticationResult": {
    "AccessToken": "eyJraWQiOiJ...",
    "IdToken": "eyJraWQiOiJ...",
    "RefreshToken": "eyJjdHkiOiJ...",
    "ExpiresIn": 3600,
    "TokenType": "Bearer"
  }
}
```

Bạn nhận ba token. Dán `IdToken` vào https://jwt.io để xem payload: bạn sẽ thấy `aud` = ClientId, `iss` = `https://cognito-idp.ap-southeast-1.amazonaws.com/<POOL_ID>`, `token_use` = `id`, và claim `email`. Access token có `token_use` = `access`, `scope` = `aws.cognito.signin.user.admin`, và KHÔNG chứa các attribute hồ sơ như email.

Lưu Access token để test API Gateway sau:

```bash
export ID_TOKEN="<dán IdToken vào đây>"
```

### Bước 5: Verify chữ ký JWT bằng JWKS trong Node.js

Không bao giờ tin token chỉ vì decode được — phải verify chữ ký RS256 bằng public key từ JWKS endpoint. Thư viện `aws-jwt-verify` của AWS làm việc này chuẩn (tự cache JWKS, kiểm `iss`, `aud`/`client_id`, `token_use`, hạn `exp`).

```javascript
// verify.js — verify ID token Cognito
import { CognitoJwtVerifier } from "aws-jwt-verify";

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.POOL_ID,
  tokenUse: "id",          // "id" hoặc "access"
  clientId: process.env.CLIENT_ID,
});

try {
  const payload = await verifier.verify(process.env.ID_TOKEN);
  console.log("Token hợp lệ. sub =", payload.sub, "email =", payload.email);
} catch (err) {
  console.error("Token KHÔNG hợp lệ:", err.message);
}
```

```bash
POOL_ID=$POOL_ID CLIENT_ID=$CLIENT_ID ID_TOKEN=$ID_TOKEN node verify.js
# Token hợp lệ. sub = a1b2... email = dev@example.com
```

JWKS endpoint cố định theo công thức: `https://cognito-idp.{region}.amazonaws.com/{poolId}/.well-known/jwks.json`. Mỗi key có một `kid`; header token chỉ ra `kid` nào dùng để verify.

### Bước 6: Tạo group và quan sát claim cognito:groups

```bash
aws cognito-idp create-group \
  --user-pool-id "$POOL_ID" \
  --group-name "Admins" \
  --precedence 1 \
  --region "$AWS_REGION"

aws cognito-idp admin-add-user-to-group \
  --user-pool-id "$POOL_ID" \
  --username "dev@example.com" \
  --group-name "Admins"
```

Đăng nhập lại (lặp Bước 4) và decode ID token: payload giờ có thêm `"cognito:groups": ["Admins"]`. Claim này là cơ sở cho role mapping ở Identity Pools (chi tiết ở Chương 39) và để phân quyền trong Lambda authorizer.

### Bước 7: Gắn Cognito User Pool authorizer vào REST API Gateway

Tạo một REST API tối giản và một authorizer kiểu COGNITO_USER_POOLS:

```bash
API_ID=$(aws apigateway create-rest-api --name dva-lab-ch38-api \
  --query 'id' --output text)
ROOT_ID=$(aws apigateway get-resources --rest-api-id "$API_ID" \
  --query 'items[0].id' --output text)

AUTH_ID=$(aws apigateway create-authorizer \
  --rest-api-id "$API_ID" \
  --name CognitoAuth \
  --type COGNITO_USER_POOLS \
  --provider-arns "arn:aws:cognito-idp:$AWS_REGION:$(aws sts get-caller-identity --query Account --output text):userpool/$POOL_ID" \
  --identity-source 'method.request.header.Authorization' \
  --query 'id' --output text)
```

Tạo method GET trên `/` dùng authorizer này:

```bash
aws apigateway put-method \
  --rest-api-id "$API_ID" --resource-id "$ROOT_ID" \
  --http-method GET \
  --authorization-type COGNITO_USER_POOLS \
  --authorizer-id "$AUTH_ID"
```

Điểm thi cốt lõi: với Cognito User Pool authorizer trên REST API, bạn truyền **ID token** (mặc định) trong header `Authorization`, KHÔNG phải access token, KHÔNG có tiền tố `Bearer`. API Gateway tự verify chữ ký, `iss`, `aud`, `exp` — bạn không cần viết code verify. Nếu thiếu header hoặc token sai/hết hạn, API Gateway trả `401 Unauthorized` trước khi chạm tới integration.

### Dọn dẹp tài nguyên

```bash
# Xoá API Gateway
aws apigateway delete-rest-api --rest-api-id "$API_ID"

# Xoá user pool client, group, user rồi cả pool
aws cognito-idp delete-user-pool-client --user-pool-id "$POOL_ID" --client-id "$CLIENT_ID"
aws cognito-idp delete-group --user-pool-id "$POOL_ID" --group-name Admins 2>/dev/null
aws cognito-idp admin-delete-user --user-pool-id "$POOL_ID" --username dev@example.com 2>/dev/null
aws cognito-idp delete-user-pool --user-pool-id "$POOL_ID"
```

Xoá user pool sẽ xoá toàn bộ user, group, app client bên trong. Nếu bạn có gắn domain (hosted UI) thì phải `delete-user-pool-domain` trước khi xoá pool, nếu không nhận lỗi.

## 💡 Exam Tips chương 38

- **User Pool = authentication (định danh người dùng, cấp JWT).** Identity Pool = authorization để lấy AWS credentials tạm (chi tiết ở Chương 39). Câu hỏi "đăng nhập và nhận JWT để gọi API của tôi" → User Pool. "Cho phép user gọi thẳng S3/DynamoDB bằng AWS credentials" → Identity Pool.
- **Ba loại token:** ID token (chứa thông tin hồ sơ user — `email`, `cognito:groups`...), Access token (dùng để authorize, chứa `scope`, không có hồ sơ), Refresh token (đổi lấy ID+Access token mới mà không cần đăng nhập lại).
- **REST API Gateway Cognito authorizer dùng ID token** trong header `Authorization`, không Bearer prefix. HTTP API (JWT authorizer) thường dùng access token và có thể cấu hình audience. Phân biệt được điểm này hay bị gài.
- **App client cho web/mobile (SPA) KHÔNG được có client secret** — vì client không giấu được secret. Tạo bằng `--no-generate-secret`. App client backend confidential thì mới dùng secret.
- **SRP (Secure Remote Password) không gửi password qua mạng** — an toàn nhất, dùng `USER_SRP_AUTH`. `USER_PASSWORD_AUTH` gửi password (cần HTTPS). `ADMIN_USER_PASSWORD_AUTH` là biến thể server-side dùng `AdminInitiateAuth`.
- **Lambda triggers hay hỏi:** Pre Sign-up (auto-confirm/validate), Post Confirmation (ghi user vào DB của bạn), Pre Token Generation (thêm/sửa claim trong token, ghi đè group claims), Custom Message (tùy biến email/SMS), Migrate User (di cư từ hệ cũ).
- **Verify JWT phải kiểm chữ ký bằng JWKS** tại `https://cognito-idp.{region}.amazonaws.com/{poolId}/.well-known/jwks.json`, đồng thời kiểm `iss`, `aud`/`client_id`, `token_use`, `exp`. Dùng thư viện `aws-jwt-verify`.
- **MFA:** OPTIONAL (user tự chọn) hoặc ON (bắt buộc mọi user). Hỗ trợ SMS và TOTP (software token). Adaptive authentication (advanced security) chấm điểm rủi ro đăng nhập và có thể bắt MFA động.
- **Federation vào User Pool:** social (Google/Facebook/Apple/Amazon) và SAML 2.0 / OIDC. User từ IdP ngoài vẫn xuất hiện như user trong pool, dùng qua Hosted UI. Đừng nhầm với federation trực tiếp ở Identity Pool.
- **User pool groups + precedence** dùng để phân nhóm và (kết hợp Identity Pool) map sang IAM role; group precedence thấp hơn thắng khi chọn role mặc định.
- **Hosted UI** cung cấp trang sign-up/sign-in/social login dựng sẵn theo OAuth 2.0 (authorization code grant, implicit). Cần cấu hình domain + callback URLs + allowed OAuth scopes.
- **ALB cũng tích hợp Cognito authentication** (listener rule `authenticate-cognito`) để bảo vệ ứng dụng phía sau ALB mà không cần code — khác với API Gateway authorizer.

## Quiz chương 38 (10 câu)

**Câu 1.** Một developer xây SPA React gọi REST API qua API Gateway, muốn API Gateway tự kiểm tra token mà không viết code xác thực. Cách ít công sức nhất?
- A. Lambda authorizer kiểu TOKEN tự verify JWT
- B. Tạo Cognito User Pool authorizer và gắn vào method
- C. Bật IAM authorization (SigV4) trên method
- D. Resource policy chặn theo IP

**Câu 2.** Token nào nên gửi trong header `Authorization` tới một REST API Gateway có Cognito User Pool authorizer mặc định?
- A. Refresh token
- B. Access token có prefix `Bearer`
- C. ID token (không prefix)
- D. Client secret

**Câu 3.** App client cho ứng dụng SPA chạy trên trình duyệt nên cấu hình thế nào?
- A. Có client secret để tăng bảo mật
- B. Không có client secret
- C. Bắt buộc bật `ADMIN_USER_PASSWORD_AUTH`
- D. Tắt refresh token

**Câu 4.** Sau khi user đăng nhập thành công, developer muốn ghi bản ghi user vào bảng DynamoDB nội bộ một lần khi tài khoản được xác nhận. Trigger nào phù hợp nhất?
- A. Pre Sign-up
- B. Pre Token Generation
- C. Post Confirmation
- D. Custom Message

**Câu 5.** Developer cần thêm một custom claim `department` vào ID token để frontend hiển thị. Cách đúng?
- A. Sửa Access token bằng Pre Sign-up trigger
- B. Dùng Pre Token Generation trigger để thêm claim
- C. Bật MFA
- D. Tạo Identity Pool và map role

**Câu 6.** Luồng auth nào KHÔNG truyền password của user qua mạng?
- A. USER_PASSWORD_AUTH
- B. ADMIN_USER_PASSWORD_AUTH
- C. USER_SRP_AUTH
- D. REFRESH_TOKEN_AUTH (lần đăng nhập đầu)

**Câu 7.** Một API gọi `InitiateAuth` với `AuthFlow=USER_PASSWORD_AUTH` và nhận lỗi `USER_PASSWORD_AUTH flow not enabled for this client`. Nguyên nhân?
- A. User chưa được confirm
- B. App client chưa bật `ALLOW_USER_PASSWORD_AUTH` trong explicit auth flows
- C. Password policy quá yếu
- D. Pool chưa bật MFA

**Câu 8.** Để verify chữ ký JWT do Cognito cấp, ứng dụng cần lấy public key từ đâu?
- A. Từ Access token payload
- B. Từ Secrets Manager
- C. Từ JWKS endpoint `.../.well-known/jwks.json` của user pool
- D. Từ KMS GenerateDataKey

**Câu 9.** Developer muốn bảo vệ một web app chạy sau Application Load Balancer, yêu cầu user đăng nhập Cognito trước khi vào, mà không sửa code app. Giải pháp?
- A. API Gateway Cognito authorizer
- B. ALB listener rule với action `authenticate-cognito`
- C. CloudFront signed cookies
- D. WAF rule

**Câu 10.** Thông tin nào KHÔNG có trong Cognito Access token (mặc định)?
- A. `scope`
- B. `token_use = access`
- C. `email` của user
- D. `exp` (thời điểm hết hạn)

### Đáp án & giải thích

**Câu 1 — Đáp án B.** Cognito User Pool authorizer cho REST API là cách "no code": API Gateway tự verify chữ ký, `iss`, `aud`, `exp`. A (Lambda authorizer) phải tự viết logic verify — nhiều công hơn. C (IAM/SigV4) hợp cho client AWS có credentials, không hợp SPA dùng JWT. D (resource policy theo IP) không phải authentication người dùng.

**Câu 2 — Đáp án C.** REST API Cognito authorizer mặc định nhận ID token, không có prefix `Bearer`. A sai — refresh token chỉ để đổi token, không dùng authorize. B sai về prefix và loại token (đó là kiểu HTTP API/JWT authorizer thường dùng access token). D sai — client secret không bao giờ gửi như token.

**Câu 3 — Đáp án B.** Ứng dụng public (SPA/mobile) không thể giấu secret nên app client phải tạo không secret (`--no-generate-secret`). A sai — secret lộ ra là vô nghĩa và còn gây lỗi `SECRET_HASH`. C sai — admin flow dành cho backend tin cậy, không phải SPA. D sai — refresh token vẫn cần để tránh đăng nhập lại liên tục.

**Câu 4 — Đáp án C.** Post Confirmation chạy ngay sau khi user xác nhận tài khoản — đúng thời điểm để ghi bản ghi vào DB nội bộ. A (Pre Sign-up) chạy trước khi đăng ký, chưa có user xác nhận. B (Pre Token Generation) chạy mỗi lần phát token, không phải một lần. D (Custom Message) chỉ để tùy biến nội dung email/SMS.

**Câu 5 — Đáp án B.** Pre Token Generation trigger cho phép thêm/sửa claim (kể cả override `cognito:groups`) trong ID token. A sai — Pre Sign-up không sửa token và chạy sai thời điểm. C (MFA) không liên quan claim. D (Identity Pool) cấp AWS credentials, không thêm claim vào ID token của User Pool.

**Câu 6 — Đáp án C.** SRP (Secure Remote Password) chứng minh user biết password mà không gửi password qua mạng. A và B đều gửi password (cần TLS). D sai — refresh token flow không gửi password nhưng câu hỏi xét lần đăng nhập đầu, mà đăng nhập đầu vẫn cần password; SRP là lựa chọn chuẩn cho việc "không truyền password".

**Câu 7 — Đáp án B.** Lỗi này xảy ra khi app client chưa liệt kê `ALLOW_USER_PASSWORD_AUTH` trong `explicit-auth-flows`. Mặc định flow này tắt. A sai — user chưa confirm cho lỗi khác (`UserNotConfirmedException`). C, D không liên quan tới flow auth.

**Câu 8 — Đáp án C.** Public key (RS256) lấy từ JWKS endpoint của pool. A sai — token payload không chứa private/public key. B (Secrets Manager) và D (KMS) không phải nơi Cognito công bố khóa verify; Cognito ký bằng khóa riêng và công bố public key qua JWKS.

**Câu 9 — Đáp án B.** ALB hỗ trợ action `authenticate-cognito` trong listener rule, buộc đăng nhập trước khi forward request, không cần sửa code. A là cho API Gateway, không phải app sau ALB. C (signed cookies) là CloudFront, không xác thực người dùng Cognito. D (WAF) lọc request theo rule, không phải đăng nhập.

**Câu 10 — Đáp án C.** Access token mặc định KHÔNG chứa attribute hồ sơ như `email`; muốn email thì đọc từ ID token. A (`scope`), B (`token_use=access`), D (`exp`) đều có trong access token.

## Tóm tắt chương

- Cognito User Pool là directory người dùng cung cấp **authentication**: sign-up/sign-in, lưu attribute, password policy, MFA, và cấp JWT.
- Mỗi lần đăng nhập trả về ba token: **ID token** (hồ sơ user), **Access token** (authorize, có scope), **Refresh token** (đổi lấy token mới).
- Token là JWT ký RS256; verify phải kiểm chữ ký qua **JWKS endpoint** cộng với `iss`, `aud`/`client_id`, `token_use`, `exp` — dùng `aws-jwt-verify`.
- App client public (SPA/mobile) **không có client secret**; phải bật đúng explicit auth flow (`ALLOW_USER_PASSWORD_AUTH`/SRP) mới gọi `InitiateAuth` được.
- **SRP** là flow an toàn nhất (không gửi password); `USER_PASSWORD_AUTH` gửi password qua TLS; admin flow dùng cho backend tin cậy.
- **Lambda triggers** mở rộng vòng đời: Pre Sign-up, Post Confirmation, Pre Token Generation, Custom Message, Migrate User — biết đúng trigger cho đúng thời điểm.
- **REST API Gateway Cognito authorizer** dùng ID token trong header `Authorization` (không Bearer) và verify tự động, trả 401 nếu sai.
- **HTTP API JWT authorizer** thường dùng access token và cấu hình issuer + audience — khác với REST API.
- **ALB** có thể tự xác thực Cognito qua listener rule `authenticate-cognito`, bảo vệ app sau ALB mà không cần code.
- **User pool groups** (kèm precedence) phục vụ phân nhóm và role mapping khi kết hợp Identity Pool (Chương 39).
- **Hosted UI** + domain cho trang đăng nhập OAuth 2.0 dựng sẵn, hỗ trợ social và SAML/OIDC federation vào pool.
- Phân biệt cốt lõi cho đề thi: User Pool = ai là user (authn) → JWT; Identity Pool = user được phép làm gì trên AWS (authz) → AWS credentials tạm.
