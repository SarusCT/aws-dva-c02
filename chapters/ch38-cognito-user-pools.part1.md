# Chương 38: Amazon Cognito User Pools

> **Trọng tâm DVA-C02:** Cognito User Pools là dịch vụ identity provider được hỏi rất nhiều ở domain Security (26% đề). Câu hỏi điển hình: chọn auth flow phù hợp (USER_PASSWORD_AUTH vs SRP vs ADMIN flow), phân biệt 3 loại JWT token (ID/access/refresh) và cách verify chữ ký bằng JWKS, dùng Lambda trigger nào cho yêu cầu nào (chặn email rác, tự confirm user, thêm custom claim), và cách gắn User Pool làm authorizer cho API Gateway hoặc bật authentication trên ALB. Đề hay gài bẫy giữa User Pools (xác thực ra JWT) và Identity Pools (cấp AWS credentials — Chương 39).

## Mục tiêu chương
- Phân biệt rõ Authentication vs Authorization và xác định User Pools nằm ở đâu trong bức tranh đó.
- Nắm luồng sign-up/sign-in, cấu hình user attributes, password policy, MFA và account recovery.
- Đọc và verify được ID token, access token, refresh token (cấu trúc JWT, JWKS, claim quan trọng).
- Cấu hình app client, hosted UI, federation (social, SAML, OIDC) vào User Pool.
- Dùng Lambda triggers để tùy biến luồng auth; hiểu adaptive authentication.
- Tích hợp User Pool với API Gateway authorizer, ALB authentication, và dùng SDK để gọi các auth flow từ code.

## 38.1 Authentication vs Authorization — Cognito đứng ở đâu

Hai khái niệm này hay bị lẫn nhưng đề thi phân biệt rất rạch ròi:

- **Authentication (AuthN — "bạn là ai?")**: xác minh danh tính người dùng. Trả lời: user này có đúng là người họ tự nhận không? Bằng chứng là username + password, MFA code, hoặc token từ một IdP đáng tin (Google, SAML).
- **Authorization (AuthZ — "bạn được làm gì?")**: sau khi biết user là ai, quyết định họ được truy cập tài nguyên nào.

Cognito có **hai thành phần tách biệt**, đừng nhầm:

| Thành phần | Vai trò chính | Output |
|---|---|---|
| **User Pool** (chương này) | Authentication — directory người dùng, sign-up/sign-in, MFA, federation | **JWT tokens** (ID/access/refresh) |
| **Identity Pool** (Chương 39) | Authorization vào AWS — đổi token lấy **AWS credentials tạm** qua STS | AccessKeyId/SecretKey/SessionToken |

User Pool **không cấp AWS credentials** và **không cho phép gọi trực tiếp S3/DynamoDB**. Nó là một user directory + OIDC/OAuth2 identity provider được quản lý. Khi app cần user gọi thẳng tới dịch vụ AWS (ví dụ upload S3 từ trình duyệt), bạn phải đưa token của User Pool vào **Identity Pool** để đổi lấy credentials (Chương 39). Còn khi app chỉ cần xác thực để gọi **API của chính bạn** (REST API sau API Gateway, hoặc một ALB), thì JWT từ User Pool là đủ.

> 💡 **Exam Tip:** Câu hỏi "user cần truy cập trực tiếp tài nguyên AWS (S3 bucket) với quyền giới hạn" → cần **Identity Pool** để lấy IAM credentials. Câu hỏi "bảo vệ REST API của tôi, chỉ user đã đăng nhập mới gọi được" → **User Pool authorizer** trên API Gateway là đủ, không cần Identity Pool.

## 38.2 User Pool: cấu trúc, attributes và password policy

Một **User Pool** là một directory chứa user profile. Mỗi user có một `sub` (subject) — UUID bất biến, là định danh duy nhất thật sự của user (không phải username, vì username có thể thay đổi tùy cấu hình).

**User attributes** chia hai loại:
- **Standard attributes**: theo chuẩn OpenID Connect — `email`, `phone_number`, `given_name`, `family_name`, `address`, `birthdate`... Mỗi attribute có thể đánh dấu **required** (bắt buộc khi sign-up) và **mutable** (cho phép sửa sau).
- **Custom attributes**: bạn tự định nghĩa, prefix `custom:` (ví dụ `custom:tenant_id`). Tối đa **50 custom attributes** mỗi pool. **Không xóa được** sau khi tạo và **không đổi được kiểu**. Có thể đặt mutable hoặc immutable.

Điểm bẫy quan trọng: **một số quyết định không sửa được sau khi tạo pool**:
- Chọn **sign-in alias** (đăng nhập bằng `username`, `email`, `phone_number`, hoặc preferred username) là **vĩnh viễn**.
- Đánh dấu attribute là `required` là vĩnh viễn.
- Đặt custom attribute là immutable là vĩnh viễn.

Muốn đổi → phải tạo pool mới và migrate user.

**Password policy** cấu hình được: độ dài tối thiểu (mặc định 8, min 6, max 99), bắt buộc chữ hoa/thường/số/ký tự đặc biệt, và **temporary password validity** (mặc định 7 ngày — khi admin tạo user, password tạm hết hạn sau bao lâu).

```bash
# Tạo User Pool với password policy và auto-verify email
aws cognito-idp create-user-pool \
  --pool-name my-app-users \
  --policies '{
    "PasswordPolicy": {
      "MinimumLength": 12,
      "RequireUppercase": true,
      "RequireLowercase": true,
      "RequireNumbers": true,
      "RequireSymbols": true,
      "TemporaryPasswordValidityDays": 3
    }
  }' \
  --auto-verified-attributes email \
  --username-attributes email \
  --mfa-configuration OFF
```

> 💡 **Exam Tip:** `--username-attributes email` cho phép user đăng nhập bằng email thay vì username riêng. `--alias-attributes` (khác) cho phép một alias trỏ tới username gốc. Cả hai phải set lúc tạo pool, không sửa được. Nếu đề nói "không thể đổi cách đăng nhập sau khi triển khai" → đó là lý do.

## 38.3 Luồng sign-up / confirm / sign-in

Luồng chuẩn của một self-service user (không qua admin):

1. **SignUp** — client gọi `SignUp` với username + password + attributes. User được tạo ở trạng thái `UNCONFIRMED`.
2. **Confirm** — Cognito gửi mã xác nhận (qua email/SMS). User gọi `ConfirmSignUp` với mã đó → trạng thái `CONFIRMED`.
3. **SignIn (InitiateAuth)** — client gọi `InitiateAuth` với flow đã chọn → nhận về tokens.

```javascript
// AWS SDK for JavaScript v3 — sign-up rồi confirm
import {
  CognitoIdentityProviderClient,
  SignUpCommand,
  ConfirmSignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";

const client = new CognitoIdentityProviderClient({ region: "ap-southeast-1" });
const CLIENT_ID = "xxxxxxxxxxxxxxxxxxxxxxxxxx";

// Đăng ký user mới
await client.send(new SignUpCommand({
  ClientId: CLIENT_ID,
  Username: "alice@example.com",
  Password: "Str0ng!Passw0rd",
  UserAttributes: [
    { Name: "email", Value: "alice@example.com" },
    { Name: "custom:tenant_id", Value: "acme-corp" },
  ],
}));

// User nhập mã 6 số nhận qua email
await client.send(new ConfirmSignUpCommand({
  ClientId: CLIENT_ID,
  Username: "alice@example.com",
  ConfirmationCode: "123456",
}));
```

**Admin tạo user** (bỏ qua self sign-up — dùng cho hệ thống nội bộ):

```bash
# Admin tạo user, gửi password tạm; user phải đổi password lần đầu
aws cognito-idp admin-create-user \
  --user-pool-id ap-southeast-1_aBcDeFgHi \
  --username bob@example.com \
  --user-attributes Name=email,Value=bob@example.com Name=email_verified,Value=true \
  --desired-delivery-mediums EMAIL
```

Khi admin tạo user, lần đăng nhập đầu user vào trạng thái `FORCE_CHANGE_PASSWORD` và `InitiateAuth` trả về challenge `NEW_PASSWORD_REQUIRED` — client phải gọi `RespondToAuthChallenge` để đặt password mới trước khi nhận token.

> 💡 **Exam Tip:** Trạng thái user: `UNCONFIRMED` (chưa verify), `CONFIRMED`, `FORCE_CHANGE_PASSWORD` (admin tạo), `RESET_REQUIRED`, `ARCHIVED`, `DISABLED`. Nếu đề mô tả "user mới do admin tạo phải đổi mật khẩu lần đầu" → đó là `FORCE_CHANGE_PASSWORD` + challenge `NEW_PASSWORD_REQUIRED`.

## 38.4 Auth flows: USER_PASSWORD_AUTH, USER_SRP_AUTH, ADMIN flows

Đây là phần **được hỏi nhiều nhất** trong chương. Cognito hỗ trợ nhiều `AuthFlow`, bật/tắt từng cái ở **app client** (field `ExplicitAuthFlows`):

| Auth flow | Password gửi lên? | Dùng khi | API gọi |
|---|---|---|---|
| `USER_SRP_AUTH` | Không — dùng SRP, password không bao giờ rời client | Web/mobile app công khai, an toàn nhất | `InitiateAuth` |
| `USER_PASSWORD_AUTH` | Có — gửi plaintext qua TLS | Đơn giản, migrate từ hệ cũ; cần khi không dùng được SRP | `InitiateAuth` |
| `ADMIN_USER_PASSWORD_AUTH` | Có — server-side | Backend tin cậy (có AWS credentials) thay user đăng nhập | `AdminInitiateAuth` |
| `REFRESH_TOKEN_AUTH` | Không | Lấy token mới từ refresh token | `InitiateAuth` |
| `CUSTOM_AUTH` | Tùy | Custom challenge (passwordless, captcha) qua Lambda triggers | `InitiateAuth` |

**SRP (Secure Remote Password)** là giao thức mật mã cho phép xác thực password mà **password không bao giờ truyền qua mạng**, kể cả ở dạng mã hóa. Client và server trao đổi các giá trị toán học để chứng minh client biết password mà không tiết lộ nó. Vì cài đặt SRP phức tạp, AWS cung cấp thư viện `amazon-cognito-identity-js` và **Amplify Auth** làm sẵn.

```javascript
// USER_PASSWORD_AUTH — đơn giản nhất, password đi qua TLS
import { InitiateAuthCommand } from "@aws-sdk/client-cognito-identity-provider";

const res = await client.send(new InitiateAuthCommand({
  ClientId: CLIENT_ID,
  AuthFlow: "USER_PASSWORD_AUTH",
  AuthParameters: {
    USERNAME: "alice@example.com",
    PASSWORD: "Str0ng!Passw0rd",
  },
}));
// res.AuthenticationResult: { IdToken, AccessToken, RefreshToken, ExpiresIn, TokenType }
console.log(res.AuthenticationResult.IdToken);
```

Phân biệt **Admin flow vs Client flow**:
- **Client flow** (`InitiateAuth`): gọi từ frontend, **không cần AWS credentials**, dùng `ClientId`. Đây là cách app người dùng đăng nhập.
- **Admin flow** (`AdminInitiateAuth`): gọi từ backend tin cậy **có IAM permission** `cognito-idp:AdminInitiateAuth`, dùng cả `UserPoolId` lẫn `ClientId`. Dùng khi server tự đăng nhập thay user (ví dụ một backend proxy auth).

> 💡 **Exam Tip:** Nếu đề nói "không bao giờ gửi password qua network" → `USER_SRP_AUTH`. "Backend server-side authenticate user, có IAM role" → `ADMIN_USER_PASSWORD_AUTH` (qua `AdminInitiateAuth`). Bẫy hay gặp: bật `USER_PASSWORD_AUTH` nhưng quên thêm vào `ExplicitAuthFlows` của app client → lỗi `InvalidParameterException: USER_PASSWORD_AUTH flow not enabled`.

## 38.5 JWT tokens: ID, Access, Refresh — verify bằng JWKS

Khi đăng nhập thành công, User Pool trả về **3 token** (trừ refresh trong một số luồng). Tất cả là JWT, **trừ refresh token là opaque** (chuỗi mã hóa nội bộ, không decode được).

| Token | Mục đích | Chứa gì | Thời hạn mặc định / cấu hình |
|---|---|---|---|
| **ID token** | Chứng minh danh tính user cho **app của bạn** | Tất cả user attributes (email, name, custom claims, groups) | 1 giờ (5 phút – 1 ngày) |
| **Access token** | Authorize gọi **resource** (API GW, hoặc Cognito user-info, OAuth scopes) | `sub`, `scope`, `client_id`, `username`, `cognito:groups` — **KHÔNG có email/profile attributes** | 1 giờ (5 phút – 1 ngày) |
| **Refresh token** | Lấy ID + access token mới mà không đăng nhập lại | Opaque, không decode | 30 ngày (1 giờ – 10 năm / 3650 ngày) |

**Khác biệt cốt lõi ID vs Access token** (đề hay hỏi): ID token chứa **thông tin về user** (dùng để hiển thị tên, email trong app frontend). Access token chứa **quyền truy cập** (scope, group) và **không có** thông tin cá nhân. Khi bảo vệ API, dùng access token; khi cần hiển thị profile, dùng ID token.

Cấu trúc JWT: `header.payload.signature`, mỗi phần base64url. Token được ký bằng **RS256** (RSA). Để verify, bạn cần public key của pool, lấy từ **JWKS endpoint**:

```
https://cognito-idp.{region}.amazonaws.com/{userPoolId}/.well-known/jwks.json
```

Các bước verify một token (khi tự build backend không dùng API GW authorizer):
1. Decode header → lấy `kid` (key ID).
2. Tải JWKS, tìm key có `kid` khớp.
3. Verify chữ ký RS256 bằng public key đó.
4. Kiểm tra `exp` (chưa hết hạn), `iss` (= URL pool của bạn), `aud` (= app client id, với ID token) hoặc `client_id` (access token), và `token_use` (`id` hoặc `access`).

```javascript
// Verify access token bằng aws-jwt-verify (thư viện chính thức của AWS)
import { CognitoJwtVerifier } from "aws-jwt-verify";

const verifier = CognitoJwtVerifier.create({
  userPoolId: "ap-southeast-1_aBcDeFgHi",
  tokenUse: "access",          // "id" hoặc "access"
  clientId: "xxxxxxxxxxxxxxxxxxxxxxxxxx",
});

try {
  const payload = await verifier.verify(accessToken); // tự cache JWKS
  console.log("user sub:", payload.sub, "groups:", payload["cognito:groups"]);
} catch {
  // Token sai chữ ký / hết hạn / sai aud → 401
}
```

> 💡 **Exam Tip:** Hai bẫy kinh điển: (1) "API cần đọc email của user trong token" → email chỉ có ở **ID token**, không có ở access token. (2) "Verify token mà không gọi Cognito mỗi request" → tải **JWKS một lần, cache public key**, verify offline; không có API "validate token" nào phải gọi mỗi lần. Refresh token **không decode được** — nếu đề hỏi "đọc claim từ refresh token" thì sai.

## 38.6 App clients, Hosted UI và OAuth 2.0 flows

**App client** là một entry point để ứng dụng tương tác với User Pool. Một pool có nhiều app client (web, mobile, server). Mỗi app client cấu hình: auth flows được phép, token expiry, OAuth scopes, callback/logout URLs, và quan trọng — **có client secret hay không**.

- **Public client** (SPA, mobile): **không có client secret** (không thể giữ bí mật trên client).
- **Confidential client** (backend server): **có client secret** — phải gửi kèm khi gọi token endpoint.

> 💡 **Exam Tip:** Bẫy hay gặp: tạo app client **có** secret rồi dùng cho SPA/mobile với `amazon-cognito-identity-js` → thư viện này **không hỗ trợ client secret**, sẽ lỗi. SPA/mobile phải dùng app client **không có secret**.

**Hosted UI** là trang đăng nhập/đăng ký do Cognito host sẵn ở domain `https://{domain}.auth.{region}.amazoncognito.com`. Bạn cấu hình một **domain prefix** (hoặc custom domain + ACM cert). Hosted UI hỗ trợ sẵn OAuth 2.0:

- **Authorization Code Grant** (`response_type=code`): an toàn nhất — trình duyệt nhận `code`, backend đổi `code` lấy token ở token endpoint. Khuyên dùng cho web app có backend.
- **Implicit Grant** (`response_type=token`): token trả thẳng về URL fragment. **Đã lỗi thời**, kém an toàn, chỉ dùng khi không có backend (nhưng PKCE + code grant nay là chuẩn cho SPA).
- **Client Credentials**: machine-to-machine, không có user — app dùng client id + secret lấy access token với custom scopes. Chỉ dùng được với app client **có secret** và **không** dùng cho luồng có user.

OAuth scopes Cognito: `openid`, `email`, `profile`, `aws.cognito.signin.user.admin` (cho phép token gọi các self-service API như đổi attribute), và **custom scopes** từ resource server bạn định nghĩa.

Endpoint chính của Hosted UI / OAuth:
- `/oauth2/authorize` — bắt đầu login
- `/oauth2/token` — đổi code lấy token / refresh
- `/oauth2/userInfo` — lấy user attributes từ access token
- `/logout` — đăng xuất

```
# Authorization Code Grant — redirect user tới:
https://my-app.auth.ap-southeast-1.amazoncognito.com/oauth2/authorize?
  client_id=xxxx&response_type=code&scope=openid+email&
  redirect_uri=https://myapp.com/callback
```

## 38.7 MFA, account recovery và adaptive authentication

**MFA configuration** của pool có 3 mức: `OFF`, `OPTIONAL` (user tự bật), `ON` (bắt buộc mọi user). Hai phương thức:
- **SMS MFA**: gửi mã qua SMS (cần cấu hình SNS + IAM role; tốn phí SMS).
- **TOTP (Software token MFA)**: app authenticator (Google Authenticator...), chuẩn TOTP. Không tốn phí, an toàn hơn SMS.

Khi MFA bật, sau khi pass password, `InitiateAuth` trả về challenge `SMS_MFA` hoặc `SOFTWARE_TOKEN_MFA`; client gọi `RespondToAuthChallenge` với mã.

**Account recovery**: cấu hình kênh khôi phục password (verified email và/hoặc verified phone), có thứ tự ưu tiên. `ForgotPassword` → gửi mã → `ConfirmForgotPassword` đặt password mới.

**Advanced security features (adaptive authentication)** — tính năng nâng cao (có tính phí theo MAU):
- **Compromised credentials**: Cognito so khớp username/password với danh sách credential đã lộ; có thể chặn đăng nhập/đăng ký bằng credential đã bị rò rỉ.
- **Adaptive authentication**: Cognito chấm **risk score** mỗi lần đăng nhập (dựa trên IP, thiết bị, vị trí, hành vi bất thường). Theo risk level (low/medium/high) bạn cấu hình hành động: allow, **require MFA**, hoặc block. Sự kiện được log để phân tích.

> 💡 **Exam Tip:** "Tự động yêu cầu MFA khi phát hiện đăng nhập đáng ngờ (IP lạ, đăng nhập bất thường)" → **adaptive authentication** (advanced security). "Chặn user dùng password đã bị lộ trong các vụ data breach" → **compromised credentials detection**. Cả hai thuộc Advanced Security Features và có phí riêng.

## 38.8 Lambda triggers — tùy biến luồng auth

Cognito cho phép gắn **Lambda function** vào các điểm trong luồng để can thiệp. Đây là điểm thi rất hay ra: cho một yêu cầu, chọn đúng trigger.

| Trigger | Khi nào chạy | Use case điển hình |
|---|---|---|
| **Pre Sign-up** | Trước khi user được tạo | Chặn domain email không hợp lệ; **auto-confirm** user (`autoConfirmUser=true`) |
| **Post Confirmation** | Sau khi user confirm | Ghi user vào DB nội bộ; thêm vào group; gửi welcome email |
| **Pre Authentication** | Trước khi xác thực password | Chặn đăng nhập theo điều kiện (ví dụ user bị khóa nội bộ) |
| **Post Authentication** | Sau khi đăng nhập thành công | Audit log, cập nhật last-login |
| **Pre Token Generation** | Ngay trước khi phát hành token | **Thêm/sửa claim** trong ID token; thêm/bớt group; suppress group |
| **Custom Auth (3 trigger)** | Define/Create/Verify Auth Challenge | Passwordless, OTP qua email, captcha (luồng `CUSTOM_AUTH`) |
| **Migrate User** | Khi user không có trong pool lúc đăng nhập/quên mật khẩu | **Di trú user "lười"** từ hệ thống cũ sang Cognito |
| **Custom Message** | Trước khi gửi email/SMS | Tùy biến nội dung email xác nhận, mã OTP |

```javascript
// Pre Sign-up trigger: chỉ cho email công ty, và auto-confirm
export const handler = async (event) => {
  const email = event.request.userAttributes.email || "";
  if (!email.endsWith("@acme-corp.com")) {
    // Ném lỗi → Cognito chặn sign-up
    throw new Error("Chỉ chấp nhận email @acme-corp.com");
  }
  // Bỏ qua bước confirm thủ công
  event.response.autoConfirmUser = true;
  event.response.autoVerifyEmail = true;
  return event; // BẮT BUỘC trả về event đã sửa
};
```

```javascript
// Pre Token Generation: thêm custom claim vào ID token (v1)
export const handler = async (event) => {
  event.response = {
    claimsOverrideDetails: {
      claimsToAddOrOverride: {
        "tier": "premium",
        "tenant": event.request.userAttributes["custom:tenant_id"],
      },
      groupOverrideDetails: {
        groupsToOverride: ["readers"], // ghi đè groups trong token
      },
    },
  };
  return event;
};
```

> 💡 **Exam Tip:** Ghi nhớ 3 trigger hay hỏi: **Pre Sign-up** = chặn/auto-confirm. **Pre Token Generation** = thêm custom claim hoặc đổi group trong token. **Migrate User** = di trú user dần dần từ DB cũ mà không yêu cầu reset password hàng loạt. Lambda trigger luôn phải `return event` (sửa `event.response`), không phải trả object mới.

## 38.9 Tích hợp: API Gateway authorizer, ALB authentication, groups & role mapping

**API Gateway — Cognito User Pools authorizer:** gắn một authorizer kiểu COGNITO_USER_POOLS vào REST API; client gửi token ở header `Authorization`. API Gateway tự verify JWT (chữ ký, exp, iss) — bạn **không cần viết code verify**. Theo mặc định API Gateway authorizer kiểm tra **ID token** hợp lệ; có thể dùng access token với scope. So sánh chi tiết IAM vs Lambda authorizer vs Cognito authorizer ở Chương 35; HTTP API dùng **JWT authorizer** native.

```yaml
# Ví dụ (rút gọn) OpenAPI cho REST API với Cognito authorizer
securityDefinitions:
  CognitoAuth:
    type: apiKey
    name: Authorization
    in: header
    x-amazon-apigateway-authtype: cognito_user_pools
    x-amazon-apigateway-authorizer:
      type: cognito_user_pools
      providerARNs:
        - arn:aws:cognito-idp:ap-southeast-1:111122223333:userpool/ap-southeast-1_aBcDeFgHi
```

**ALB authentication:** Application Load Balancer có thể **tự xác thực user trước khi forward request** tới target (Lambda/EC2/ECS) qua một listener rule action `authenticate-cognito`. ALB redirect user chưa đăng nhập tới Hosted UI; sau khi đăng nhập, ALB đặt session cookie (`AWSELBAuthSessionCookie`) và chuyển các claim vào header `x-amzn-oidc-data`, `x-amzn-oidc-accesstoken`, `x-amzn-oidc-identity` cho backend. Backend không cần tự xử lý OAuth.

> 💡 **Exam Tip:** "Bảo vệ web app sau ALB bằng đăng nhập mà không sửa code app" → dùng **ALB + authenticate-cognito action** (yêu cầu HTTPS listener). "Bảo vệ REST API không viết code verify token" → **API Gateway Cognito authorizer**. Cả hai đều không yêu cầu Identity Pool.

**Groups & role mapping:** trong User Pool bạn tạo **groups** (ví dụ `admins`, `readers`), mỗi group có thể gắn một **IAM role** và một **precedence** (số nhỏ = ưu tiên cao khi user thuộc nhiều group). Group của user xuất hiện trong claim `cognito:groups` của cả ID lẫn access token — backend đọc claim này để phân quyền theo role.

Lưu ý ranh giới: phần **đổi token + group sang IAM credentials qua role mapping của Identity Pool** thuộc Chương 39. Trong phạm vi User Pool, group chỉ là một tập claim trong JWT để app/authorizer của bạn dùng cho RBAC.

```bash
# Tạo group và gán user vào group
aws cognito-idp create-group \
  --user-pool-id ap-southeast-1_aBcDeFgHi \
  --group-name admins --precedence 1 \
  --role-arn arn:aws:iam::111122223333:role/CognitoAdminRole

aws cognito-idp admin-add-user-to-group \
  --user-pool-id ap-southeast-1_aBcDeFgHi \
  --username alice@example.com --group-name admins
```

## 38.10 Federation vào User Pool: social, SAML, OIDC

User Pool có thể đóng vai **broker**: cho phép user đăng nhập bằng IdP bên ngoài (Google, Facebook, Apple, hoặc SAML 2.0 / OIDC enterprise IdP như Okta, Azure AD), nhưng vẫn **trả về token của User Pool** (không phải token của Google). Đây gọi là **federation vào User Pool** — khác với Identity Pool federation (Chương 39).

Cách hoạt động: bạn khai báo IdP trong pool, cấu hình **attribute mapping** (map claim của IdP → attribute của Cognito user), rồi user đăng nhập qua Hosted UI → chọn nhà cung cấp → Cognito tạo/cập nhật một user "federated" trong pool và phát token bình thường.

| Loại federation vào User Pool | IdP | Giao thức |
|---|---|---|
| Social | Google, Facebook, Amazon, Apple | OAuth/OIDC |
| Enterprise SAML | Okta, Azure AD, ADFS | SAML 2.0 |
| Enterprise OIDC | Bất kỳ OIDC provider | OIDC |

```bash
# Thêm Google làm IdP cho User Pool
aws cognito-idp create-identity-provider \
  --user-pool-id ap-southeast-1_aBcDeFgHi \
  --provider-name Google \
  --provider-type Google \
  --provider-details client_id=xxx.apps.googleusercontent.com,client_secret=yyy,authorize_scopes="openid email profile" \
  --attribute-mapping email=email,username=sub
```

> 💡 **Exam Tip:** Phân biệt rạch ròi: **User Pool federation** = user đăng nhập bằng Google/SAML nhưng app nhận **Cognito JWT** (một directory thống nhất, một loại token). **Identity Pool federation** (Chương 39) = đổi token (kể cả của Google trực tiếp) lấy **AWS credentials**. Nếu đề muốn "đăng nhập bằng tài khoản công ty qua SAML rồi gọi REST API của tôi" → SAML federation **vào User Pool** + Cognito authorizer.

## 38.11 Quotas, giới hạn và bẫy thực tế

Một số con số và giới hạn hay xuất hiện hoặc cần nhớ khi vận hành:

- **Custom attributes**: tối đa 50/pool; không xóa được, không đổi kiểu.
- **Groups**: tối đa 10.000/pool (soft limit).
- **App clients**: tối đa 1.000/pool.
- **Token expiry**: ID/access token 5 phút – 1 ngày; refresh token 1 giờ – 3650 ngày.
- **SignUp/InitiateAuth** và các API có **rate limit theo category**; đăng nhập burst lớn có thể bị throttle (`TooManyRequestsException`) — cần exponential backoff.
- **SMS** dùng SNS, mặc định trong SMS sandbox và có spending limit — bẫy production khi SMS MFA không gửi được vì chưa thoát sandbox.
- **Email mặc định** gửi qua Cognito có giới hạn thấp (vài chục email/ngày); production nên cấu hình **Amazon SES** để gửi email xác nhận với hạn mức cao.

> 💡 **Exam Tip:** "Email xác nhận sign-up không gửi được khi lượng đăng ký lớn" → email mặc định của Cognito bị giới hạn; chuyển sang **SES** trong cấu hình message. "SMS MFA không tới user thật trong production" → SNS còn trong **SMS sandbox**, phải request thoát sandbox và set spending limit.

Bẫy thực tế khác:
- Bật flow `USER_PASSWORD_AUTH`/`ADMIN_USER_PASSWORD_AUTH` nhưng quên liệt kê trong `ExplicitAuthFlows` của app client → lỗi flow not enabled.
- Dùng app client **có secret** cho SPA → `amazon-cognito-identity-js` không gửi secret → lỗi `SecretHash` / `NotAuthorized`.
- Verify token sai `token_use` (dùng ID token ở nơi cần access token và ngược lại) → API GW/JWT verifier reject.
- Đổi `username-attributes` sau khi tạo pool → không thể; phải tạo pool mới.
