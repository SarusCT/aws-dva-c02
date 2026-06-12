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
