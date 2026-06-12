# Chương 39: Cognito Identity Pools & Cognito Sync

> **Trọng tâm DVA-C02:** Identity Pools là dịch vụ cấp **AWS credentials tạm thời** (access key/secret/session token qua STS) cho user — khác hẳn User Pools chỉ lo authentication và trả JWT. Đề thi rất hay gài cặp "User Pools vs Identity Pools": câu hỏi mô tả nhu cầu "user upload thẳng lên S3 từ trình duyệt", "mobile app gọi DynamoDB trực tiếp", "guest access không cần đăng nhập" → đáp án gần như luôn là Identity Pools. Bạn cũng phải nắm cơ chế **fine-grained access** dùng policy variable `${cognito-identity.amazonaws.com:sub}` để phân tách dữ liệu theo user, và phân biệt **authenticated vs unauthenticated role**.

## Mục tiêu chương
- Hiểu rõ Identity Pool (Federated Identities) làm gì: đổi token của identity provider lấy **AWS credentials tạm** qua STS.
- Phân biệt **authenticated** và **unauthenticated (guest)** identities và 2 IAM role tương ứng.
- Cấu hình **identity providers**: Cognito User Pool, social (Google/Facebook/Apple), SAML/OIDC, và **developer authenticated identities**.
- Viết **trust policy** với `cognito-identity.amazonaws.com` và **role mapping** (rules-based, token-based).
- Áp dụng **fine-grained access** với policy variable để cô lập dữ liệu S3 prefix và DynamoDB `LeadingKeys`.
- Nắm bảng phân biệt **User Pools vs Identity Pools** và kiến trúc kết hợp cả hai; biết Cognito Sync (legacy) đã được thay bằng AppSync.

## 39.1 Identity Pool giải quyết bài toán gì

Hãy hình dung một single-page app (SPA) chạy trên trình duyệt cần upload ảnh thẳng lên S3, hoặc một mobile app cần ghi record vào DynamoDB. Cả hai đều cần **AWS credentials** để ký request SigV4. Bạn KHÔNG bao giờ được nhúng access key tĩnh vào client — ai mở DevTools cũng đọc được, và key đó không hết hạn. Đây chính xác là chỗ **Cognito Identity Pool** (tên cũ: Cognito Federated Identities) xuất hiện.

Cơ chế cốt lõi gồm 2 bước (two-step flow):

1. **GetId / GetCredentialsForIdentity** (hoặc `GetOpenIdToken` + `AssumeRoleWithWebIdentity` ở luồng "enhanced" vs "basic"): client gửi token chứng minh danh tính (JWT từ User Pool, id_token Google, SAML assertion...) lên Identity Pool.
2. Identity Pool xác thực token đó với provider, rồi **gọi STS thay bạn** để `AssumeRoleWithWebIdentity` lên một IAM Role đã cấu hình sẵn. Kết quả trả về cho client là bộ **AccessKeyId / SecretAccessKey / SessionToken** tạm thời.

Từ lúc có credentials, client gọi thẳng S3, DynamoDB, Lambda... như một principal IAM bình thường — quyền hạn bị giới hạn bởi IAM Role đó.

Điểm mấu chốt cho đề thi: **User Pool cho bạn biết "user là ai" (authentication, trả JWT — chi tiết ở Chương 38). Identity Pool cho bạn "quyền truy cập AWS resource" (authorization vào AWS API, trả credentials tạm).** Hai dịch vụ độc lập, thường ghép với nhau nhưng giải quyết hai việc khác nhau.

> 💡 **Exam Tip:** Bất cứ khi nào đề mô tả client (web/mobile) cần **gọi trực tiếp AWS service** (S3, DynamoDB, Kinesis...) → nghĩ ngay tới **Identity Pool cấp temporary AWS credentials qua STS**. Nếu đề chỉ nói "đăng nhập/đăng ký user và bảo vệ REST API" → đó là **User Pool**.

## 39.2 Enhanced flow vs Basic (Classic) flow

Identity Pool có hai luồng lấy credentials, và đề thi đôi khi nhắc tên:

- **Enhanced (simplified) flow** — khuyến nghị. Client chỉ gọi 2 API: `GetId` (lấy `IdentityId` — định danh ổn định của user trong pool) rồi `GetCredentialsForIdentity`. Việc `AssumeRoleWithWebIdentity` và **role mapping** được Cognito xử lý phía server. Đây là flow mặc định trong AWS SDK v3 (`@aws-sdk/credential-providers` → `fromCognitoIdentityPool`).
- **Basic (classic) flow** — client gọi `GetId`, rồi `GetOpenIdToken` để lấy một OpenID token do Cognito phát hành, rồi **tự gọi** `sts:AssumeRoleWithWebIdentity` với role ARN mình chọn. Flow này cho phép client chỉ định role tuỳ ý (trong giới hạn trust policy) nhưng không hỗ trợ role mapping của Identity Pool.

Trong thực tế và trong SDK hiện đại bạn dùng enhanced flow. Ví dụ lấy credentials trong trình duyệt/Node.js bằng SDK v3:

```javascript
// SDK v3: lấy AWS credentials tạm từ Identity Pool rồi gọi thẳng S3
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { fromCognitoIdentityPool } from "@aws-sdk/credential-providers";

const REGION = "ap-southeast-1";
const IDENTITY_POOL_ID = "ap-southeast-1:xxxxxxxx-1111-2222-3333-444455556666";

// idToken là JWT lấy từ Cognito User Pool sau khi user đăng nhập (xem Chương 38)
const s3 = new S3Client({
  region: REGION,
  credentials: fromCognitoIdentityPool({
    clientConfig: { region: REGION },
    identityPoolId: IDENTITY_POOL_ID,
    // logins: ánh xạ provider -> token. Bỏ logins = guest (unauthenticated)
    logins: {
      [`cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`]: idToken,
    },
  }),
});

// Credentials tạm tự động được resolve và cache; SDK sẽ refresh khi gần hết hạn
await s3.send(
  new PutObjectCommand({
    Bucket: "my-user-uploads",
    Key: `private/${identityId}/avatar.png`, // prefix theo identity — xem 39.6
    Body: fileBytes,
  })
);
```

Key format của `logins` rất hay bị hỏi sai: với User Pool là `cognito-idp.<region>.amazonaws.com/<userPoolId>`, với Google là `accounts.google.com`, Facebook là `graph.facebook.com`, Apple là `appleid.apple.com`, SAML là ARN của SAML provider.

> 💡 **Exam Tip:** Credentials từ Identity Pool là **temporary** (mặc định ~1 giờ với enhanced flow). SDK tự refresh khi còn `logins` token hợp lệ. Nếu refresh token / id_token hết hạn, user phải đăng nhập lại ở User Pool để lấy JWT mới.

## 39.3 Authenticated vs Unauthenticated identities

Mỗi Identity Pool gắn với **hai IAM Role**:

- **Authenticated role** — áp cho user đã chứng minh danh tính qua một provider (có `logins`).
- **Unauthenticated (guest) role** — áp cho khách vãng lai. Bạn phải **bật tuỳ chọn "Enable access to unauthenticated identities"** thì pool mới phát credentials cho guest. Khi bật, client gọi `GetCredentialsForIdentity` mà **không kèm `logins`** sẽ nhận credentials gắn guest role.

Use case guest: app tin tức cho người chưa đăng nhập đọc bài (read-only S3/DynamoDB), demo, hoặc thu thập analytics ẩn danh. Guest role nên cực kỳ hạn chế — chỉ `Allow` đúng vài action read-only, vì bất kỳ ai trên internet đều lấy được credentials này.

Một guest có thể "nâng cấp" thành authenticated: SDK gọi lại với cùng `IdentityId` nhưng lần này kèm `logins`, Cognito **liên kết (link)** danh tính vô danh trước đó với provider thật — giữ nguyên `IdentityId` để dữ liệu (ví dụ giỏ hàng) không mất.

```bash
# Bật/sửa role gắn cho pool qua CLI (set-identity-pool-roles)
aws cognito-identity set-identity-pool-roles \
  --identity-pool-id "ap-southeast-1:xxxx-...-6666" \
  --roles authenticated=arn:aws:iam::111122223333:role/Cognito_MyApp_Auth_Role,\
unauthenticated=arn:aws:iam::111122223333:role/Cognito_MyApp_Unauth_Role
```

> 💡 **Exam Tip:** "Allow guest/anonymous users limited read access without sign-in" → bật **unauthenticated identities** và gắn một guest role quyền tối thiểu. Đây là tính năng độc quyền của Identity Pool — User Pool không có khái niệm guest.

## 39.4 Trust policy với cognito-identity.amazonaws.com

Hai IAM Role trên phải có **trust policy** cho phép `cognito-identity.amazonaws.com` assume qua web identity. Trust policy còn dùng `Condition` để khoá role vào đúng pool và đúng loại identity (auth/unauth) — đây là điểm kỹ thuật hay bị hỏi:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "cognito-identity.amazonaws.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "cognito-identity.amazonaws.com:aud": "ap-southeast-1:xxxx-...-6666"
      },
      "ForAnyValue:StringLike": {
        "cognito-identity.amazonaws.com:amr": "authenticated"
      }
    }
  }]
}
```

Giải thích các condition key:
- `cognito-identity.amazonaws.com:aud` = **Identity Pool ID**. Khoá role vào đúng pool, chống pool khác mượn role.
- `cognito-identity.amazonaws.com:amr` (Authentication Methods Reference) = `authenticated` hoặc `unauthenticated`. Role của authenticated phải match `authenticated`, guest role match `unauthenticated`. Phải dùng `ForAnyValue:StringLike` vì `amr` là multi-value.

`Action` luôn là `sts:AssumeRoleWithWebIdentity` (không phải `sts:AssumeRole` — chi tiết các flavor AssumeRole ở Chương 45). Principal là `Federated`, không phải `Service` hay `AWS`.

> 💡 **Exam Tip:** Nếu đề hỏi vì sao Cognito báo lỗi khi cấp credentials, một nguyên nhân kinh điển là **trust policy của role thiếu/ sai** `Principal: Federated cognito-identity.amazonaws.com` hoặc `Action sts:AssumeRoleWithWebIdentity`, hoặc `aud` không khớp Pool ID.

## 39.5 Identity providers & Role Mapping

Identity Pool nhận identity từ nhiều loại provider:

| Loại provider | Token client gửi | Login key trong `logins` |
|---|---|---|
| Cognito **User Pool** | ID token (JWT) | `cognito-idp.<region>.amazonaws.com/<poolId>` |
| **Google** | OAuth id_token | `accounts.google.com` |
| **Facebook** | access token | `graph.facebook.com` |
| **Apple / Amazon** | id_token | `appleid.apple.com` / `www.amazon.com` |
| **OIDC** (provider chuẩn OpenID) | id_token | issuer URL của IdP |
| **SAML 2.0** | SAML assertion | ARN của SAML provider trong IAM |
| **Developer authenticated** | token tự sinh từ backend | tên provider tuỳ chọn (vd `login.mycorp.com`) |

**Role Mapping** quyết định user nhận role nào. Có hai chế độ chính:

- **Use default role** — mọi authenticated user nhận chung authenticated role. Đơn giản, phổ biến nhất.
- **Choose role with rules / token** — phân hoá role theo claim trong token:
  - **Rules-based**: viết rule kiểu "nếu claim `custom:dept` == `admin` thì gán `AdminRole`". Match theo `Claim`, `MatchType` (`Equals`, `Contains`, `StartsWith`, `NotEqual`), `Value`, `RoleARN`. Đánh giá từ trên xuống, rule đầu khớp thắng.
  - **Token-based (`cognito:roles` / `cognito:preferred_role`)**: User Pool **group** có thể gán sẵn IAM Role với precedence; khi user thuộc group, ID token chứa claim `cognito:roles`. Identity Pool đọc claim này để chọn role. (User Pool groups & precedence chi tiết ở Chương 38.)

Khi không match rule nào, bạn chọn behavior: dùng `AuthenticatedRole` mặc định hoặc `DENY` (từ chối cấp credentials).

```json
// RoleMapping (rules-based) gán theo claim từ token User Pool
{
  "cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_AbCdEf": {
    "Type": "Rules",
    "AmbiguousRoleResolution": "AuthenticatedRole",
    "RulesConfiguration": {
      "Rules": [{
        "Claim": "custom:department",
        "MatchType": "Equals",
        "Value": "engineering",
        "RoleARN": "arn:aws:iam::111122223333:role/Cognito_Engineering_Role"
      }]
    }
  }
}
```

> 💡 **Exam Tip:** Hai cơ chế phân quyền hay nhầm: **User Pool group → role** (claim `cognito:roles`, dùng cho cả authorizer lẫn role mapping) so với **Identity Pool rules-based mapping** (đọc claim tuỳ ý). Khi đề nói "assign different IAM permissions based on group membership", cả hai đều khả thi nhưng đường ngắn nhất là **User Pool group có Role gán sẵn → Identity Pool dùng token-based role mapping**.

## 39.6 Fine-grained access: policy variables với S3 và DynamoDB

Đây là phần kỹ thuật được hỏi nhiều nhất ở chương này. Vấn đề: nhiều user dùng **chung một IAM Role** (authenticated role), làm sao mỗi user chỉ truy cập được dữ liệu của riêng mình? Câu trả lời: **policy variable** trong IAM policy của role, thay thế động bằng identity của user lúc request.

Biến quan trọng nhất:
```
${cognito-identity.amazonaws.com:sub}
```
`sub` chính là `IdentityId` — duy nhất và ổn định cho mỗi user trong pool. IAM thay biến này bằng giá trị thật của caller khi đánh giá policy.

**S3 — cô lập theo prefix:** mỗi user chỉ đọc/ghi được folder `private/<identityId>/`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::my-user-uploads/private/${cognito-identity.amazonaws.com:sub}/*"
    },
    {
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::my-user-uploads",
      "Condition": {
        "StringLike": {
          "s3:prefix": ["private/${cognito-identity.amazonaws.com:sub}/*"]
        }
      }
    }
  ]
}
```
User A (sub = `region:guid-A`) gọi `PutObject` key `private/region:guid-A/photo.jpg` → khớp Resource → cho phép. Nếu A thử ghi vào prefix của B → IAM deny vì biến `sub` không khớp.

**DynamoDB — cô lập theo LeadingKeys:** điều kiện `dynamodb:LeadingKeys` giới hạn user chỉ thao tác item mà **partition key** bằng identity của họ:

```json
{
  "Effect": "Allow",
  "Action": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:UpdateItem"],
  "Resource": "arn:aws:dynamodb:ap-southeast-1:111122223333:table/UserData",
  "Condition": {
    "ForAllValues:StringEquals": {
      "dynamodb:LeadingKeys": ["${cognito-identity.amazonaws.com:sub}"]
    }
  }
}
```
Điều kiện này bắt buộc partition key của mọi item user đụng tới phải bằng `IdentityId` của họ. Đây là cách "row-level security" cổ điển trên DynamoDB (chi tiết IAM fine-grained DynamoDB ở Chương 33).

> 💡 **Exam Tip:** Ghi nhớ cặp: **S3 → `${cognito-identity.amazonaws.com:sub}` trong Resource ARN làm prefix**; **DynamoDB → cùng biến đó trong `Condition` với key `dynamodb:LeadingKeys`** để khoá partition key. Nếu đề cho key `${aws:userid}` hay `${cognito-idp...}` thì sai — biến đúng là `cognito-identity.amazonaws.com:sub`.

## 39.7 Developer authenticated identities

Khi bạn đã có **hệ thống đăng nhập riêng** (legacy backend, custom auth) và không muốn dùng provider công khai, dùng **developer authenticated identities**. Luồng:

1. User đăng nhập vào backend của bạn theo cách của bạn.
2. Backend (có IAM credentials đủ quyền) gọi `cognito-identity:GetOpenIdTokenForDeveloperIdentity`, truyền `IdentityPoolId`, `Logins = { "login.mycorp.com": "<your-user-id>" }` (developer provider name bạn đặt khi tạo pool) và nhận về một `IdentityId` + một **OpenID token** do Cognito ký.
3. Backend trả token này về client; client gọi `GetCredentialsForIdentity`/`AssumeRoleWithWebIdentity` để đổi lấy AWS credentials.

Điểm thi: API `GetOpenIdTokenForDeveloperIdentity` **chỉ gọi được từ server-side** với AWS credentials đáng tin (vì nó tạo trust), không bao giờ gọi từ client. Developer provider name là chuỗi tuỳ ý (vd `login.mycompany.example`) và cố định cho pool.

```javascript
// Backend (server-side) đổi user-id nội bộ -> OpenID token Cognito
import { CognitoIdentityClient, GetOpenIdTokenForDeveloperIdentityCommand }
  from "@aws-sdk/client-cognito-identity";

const client = new CognitoIdentityClient({ region: "ap-southeast-1" });
const res = await client.send(new GetOpenIdTokenForDeveloperIdentityCommand({
  IdentityPoolId: "ap-southeast-1:xxxx-...-6666",
  Logins: { "login.mycorp.com": internalUserId }, // developer provider name
  TokenDuration: 3600,
}));
// Trả res.IdentityId + res.Token về client để đổi lấy AWS credentials
```

> 💡 **Exam Tip:** "Integrate an existing custom/legacy authentication system with Cognito to grant AWS access" → **developer authenticated identities** + `GetOpenIdTokenForDeveloperIdentity` gọi từ backend tin cậy.

## 39.8 User Pools vs Identity Pools — bảng phân biệt kinh điển

Đây là bảng phải thuộc lòng. Nhiều câu hỏi DVA chỉ kiểm tra bạn có lẫn lộn hai dịch vụ không.

| Tiêu chí | **User Pool** (Chương 38) | **Identity Pool** (chương này) |
|---|---|---|
| Vai trò chính | **Authentication** — quản lý user directory, đăng ký/đăng nhập | **Authorization vào AWS** — cấp credentials tạm |
| Kết quả trả về | **JWT** (ID / access / refresh token) | **AWS temporary credentials** (AccessKey/Secret/SessionToken qua STS) |
| Dùng để gọi | REST/HTTP API qua API Gateway Cognito authorizer, ALB auth | **Trực tiếp AWS service** (S3, DynamoDB, Kinesis, Lambda...) |
| Guest/anonymous | Không có | **Có** (unauthenticated identities) |
| Có user directory? | Có (lưu user, attribute, password) | Không — chỉ ánh xạ identity → IAM role |
| Federation | Social/SAML/OIDC vào pool, vẫn cho ra JWT | Social/SAML/OIDC/User Pool/developer → ra AWS credentials |
| Phân quyền chi tiết | Group + scope cho API | **IAM policy + policy variables** (S3 prefix, DynamoDB LeadingKeys) |

**Kiến trúc kết hợp (chuẩn nhất):** User Pool làm IdP cho Identity Pool.
1. User đăng nhập User Pool → nhận ID token (JWT).
2. App đưa JWT làm `logins` cho Identity Pool.
3. Identity Pool xác thực JWT, gọi STS → trả AWS credentials.
4. App dùng credentials gọi thẳng S3/DynamoDB với quyền theo IAM role + fine-grained policy.

Cùng JWT đó cũng dùng được làm bearer token cho **API Gateway Cognito authorizer** (Chương 35) — nên một app thường vừa gọi API Gateway (bằng JWT) vừa gọi S3 trực tiếp (bằng credentials từ Identity Pool).

> 💡 **Exam Tip:** Phân biệt nhanh bằng từ khoá: "**token to authorize REST API**" → User Pool authorizer. "**temporary AWS credentials to call S3/DynamoDB directly from app**" → Identity Pool. "**guest access**" → Identity Pool unauthenticated. "**sign-up/sign-in user management**" → User Pool.

## 39.9 Cognito Sync (legacy) → AppSync

**Cognito Sync** là dịch vụ cũ cho phép đồng bộ **dữ liệu user nhỏ** (key-value, dạng "dataset" trong "identity") giữa các thiết bị của cùng một user (vd: settings, game progress), có push sync qua SNS. Nó gắn chặt với Identity Pool vì dùng `IdentityId` làm khoá định danh dữ liệu.

Điểm cần nhớ cho đề thi (nhẹ, mức nhận diện):
- Cognito Sync nay là **legacy** — AWS khuyến nghị dùng **AWS AppSync** (GraphQL, real-time subscriptions, offline/conflict resolution — chi tiết ở Chương 44) cho mọi nhu cầu đồng bộ dữ liệu đa thiết bị mới.
- Cognito Sync vẫn cần Identity Pool để có `IdentityId`; dataset giới hạn dung lượng nhỏ (mỗi identity ~20MB, dạng key/value), **không** phải nơi lưu dữ liệu lớn.

> 💡 **Exam Tip:** Câu hỏi "đồng bộ user preferences giữa các device và xử lý offline/conflict cho app mới" → đáp án hiện đại là **AWS AppSync**, không phải Cognito Sync. Nếu đề vẫn liệt kê Cognito Sync, nhớ nó là tính năng đi kèm Identity Pool và đã bị thay thế.

## 39.10 Ví dụ end-to-end: web app upload thẳng lên S3

Ghép tất cả lại thành một kịch bản hoàn chỉnh — đây đúng là dạng tình huống "A developer is building a web app where signed-in users upload files directly to S3" mà đề DVA hay mô tả. Mục tiêu: tránh đẩy file qua backend (giảm tải, giảm chi phí, tăng tốc), nhưng mỗi user chỉ ghi được vào folder riêng.

**Bước 1 — Đăng nhập User Pool, lấy JWT.** User đăng nhập bằng SDK (USER_PASSWORD_AUTH hoặc SRP — chi tiết flow ở Chương 38), nhận về `idToken`.

**Bước 2 — Đổi JWT lấy AWS credentials qua Identity Pool.** Dùng `fromCognitoIdentityPool` như ở 39.2. SDK gọi `GetId` → `GetCredentialsForIdentity` (enhanced flow), Cognito gọi STS phía sau, trả credentials tạm. SDK cache và auto-refresh.

**Bước 3 — IAM Role gắn fine-grained policy** như ở 39.6, khoá ghi vào `private/${cognito-identity.amazonaws.com:sub}/*`.

**Bước 4 — Client gọi thẳng `PutObject` (hoặc tốt hơn: tạo presigned URL phía client, rồi PUT).** Với upload file lớn, dùng multipart qua `@aws-sdk/lib-storage`:

```javascript
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { fromCognitoIdentityPool } from "@aws-sdk/credential-providers";

const region = "ap-southeast-1";
const s3 = new S3Client({
  region,
  credentials: fromCognitoIdentityPool({
    clientConfig: { region },
    identityPoolId: IDENTITY_POOL_ID,
    logins: { [`cognito-idp.${region}.amazonaws.com/${USER_POOL_ID}`]: idToken },
  }),
});

// identityId chính là giá trị thay vào ${cognito-identity.amazonaws.com:sub}
const upload = new Upload({
  client: s3,
  params: {
    Bucket: "my-user-uploads",
    Key: `private/${identityId}/${file.name}`,
    Body: file,
    ContentType: file.type,
  },
  queueSize: 4,          // 4 part song song
  partSize: 5 * 1024 * 1024, // 5MB/part (min của S3 multipart)
});
await upload.done();
```

**Bẫy thực tế thường gặp trong kịch bản này:**
- **CORS trên bucket.** Trình duyệt gọi S3 cross-origin → phải cấu hình CORS cho bucket (`AllowedMethods: PUT/POST`, `AllowedOrigins`, expose `ETag` cho multipart). Quên CORS là lỗi #1 khi upload từ SPA (chi tiết CORS S3 ở Chương 14).
- **Block Public Access vẫn bật.** Upload bằng credentials IAM **không** cần bucket public — Block Public Access nên giữ nguyên ON. Đừng nhầm "user upload trực tiếp" = "bucket phải public".
- **Lấy được `identityId` ở client.** Sau khi credentials resolve, `IdentityId` nằm trong response của `GetId`; với `fromCognitoIdentityPool` bạn có thể gọi `cognitoIdentity.send(GetIdCommand)` riêng để biết prefix cần ghi.
- **Clock skew / token hết hạn.** Nếu `idToken` hết hạn, refresh ở User Pool trước; nếu không, Cognito Identity trả `NotAuthorizedException`.

> 💡 **Exam Tip:** "Most secure / least overhead way for browser clients to upload to S3" có hai đáp án kinh điển: (1) **presigned URL** do backend phát (khi bạn vẫn có backend, không cần Cognito) — chi tiết ở Chương 14; (2) **Identity Pool credentials** khi client là app không có backend cố định và cần gọi nhiều AWS service. Đọc kỹ đề xem có backend hay không để chọn đúng.

## 39.11 Limits, bảo mật và bẫy vận hành

Một số con số và lưu ý hay xuất hiện hoặc cần để không sập production:

- **Thời hạn credentials:** enhanced flow trả credentials với thời hạn mặc định khoảng **1 giờ**. Basic flow (`AssumeRoleWithWebIdentity`) cho phép set `DurationSeconds` (15 phút → tối đa theo `MaxSessionDuration` của role, lên tới 12 giờ) — nhưng OpenID token của Cognito có hạn riêng (mặc định ~15 phút cho việc đổi role). Đừng giả định credentials sống mãi; SDK lo refresh khi còn `logins` hợp lệ.
- **`IdentityId` là định danh nội bộ của pool**, không phải `sub` của User Pool JWT. Hai giá trị khác nhau: `IdentityId` dạng `region:guid`, còn `sub` trong JWT của User Pool là một UUID khác. Khi cấu hình fine-grained S3/DynamoDB, biến `${cognito-identity.amazonaws.com:sub}` map tới **IdentityId**, không phải `sub` của User Pool — dễ nhầm.
- **Guest role là bề mặt tấn công.** Vì ai cũng lấy được credentials guest, hãy giới hạn cực chặt và cân nhắc tắt unauthenticated nếu app bắt buộc đăng nhập.
- **Một identity có thể có nhiều logins.** Cognito hỗ trợ **linking** nhiều provider vào cùng một `IdentityId` (vd cùng user đăng nhập bằng Google và Facebook được gộp). Việc gộp dựa trên cấu hình; cẩn thận khi nhiều provider trả về cùng người dùng để tránh tạo identity trùng.
- **Phân biệt với `AssumeRoleWithWebIdentity` thủ công (Chương 45).** Bạn hoàn toàn có thể bỏ qua Identity Pool và tự gọi STS `AssumeRoleWithWebIdentity` với id_token Google trực tiếp. Khác biệt: Identity Pool thêm tiện ích **role mapping, guest, linking nhiều provider, một `IdentityId` ổn định** và che giấu STS. Khi đề nhấn "manage federated identities, multiple providers, guest access" → Identity Pool; khi chỉ "exchange an OIDC token for a role" thuần → có thể là `AssumeRoleWithWebIdentity` trực tiếp.
- **Quyền gọi API quản trị:** `cognito-identity:GetOpenIdTokenForDeveloperIdentity`, `set-identity-pool-roles` là action quản trị, chỉ cấp cho backend/admin, không cho client.

> 💡 **Exam Tip:** Ghi nhớ chuỗi service phía sau Identity Pool: **token provider → Cognito Identity → STS (`AssumeRoleWithWebIdentity`) → temporary credentials → AWS service**. STS chính là service thực sự phát credentials; Cognito chỉ là "người môi giới" xác thực token và chọn role.

---

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
