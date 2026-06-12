# Chương 44: AWS AppSync & Amplify

> **Trọng tâm DVA-C02:** Chương này xuất hiện trong domain Development và Security. Đề thường hỏi: khi nào chọn AppSync (GraphQL) thay vì API Gateway (REST), 5 chế độ authorization của AppSync và cách kết hợp nhiều mode, real-time subscription qua WebSocket cho ứng dụng kiểu chat/dashboard, chọn data source (DynamoDB/Lambda/HTTP), cơ chế conflict resolution khi offline, và vai trò của Amplify trong việc dựng nhanh backend serverless + hosting CI/CD. Câu hỏi hay ở dạng "A developer needs to build a mobile app with real-time updates and offline sync — which service...".

## Mục tiêu chương
- Hiểu mô hình GraphQL (schema, query, mutation, subscription) và vì sao nó giải quyết over-fetching/under-fetching của REST.
- Nắm kiến trúc AppSync: resolver (unit vs pipeline, JS resolver vs VTL), data source, và mapping request/response.
- Cấu hình 5 authorization mode (API key, IAM, Cognito User Pools, OIDC, Lambda) và kết hợp nhiều mode trên một API.
- Triển khai real-time subscription qua WebSocket và hiểu cơ chế kích hoạt từ mutation.
- Phân biệt AppSync vs API Gateway để chọn đúng trong tình huống thi.
- Biết Amplify CLI/Hosting/Libraries làm gì và khi nào nên dùng Amplify thay vì dựng tay.

## 44.1 GraphQL recap — schema, query, mutation, subscription

GraphQL là một query language cho API, do Facebook tạo ra. Khác với REST (mỗi resource một endpoint, server quyết định trả về gì), GraphQL có **một endpoint duy nhất** và client tự khai báo chính xác trường dữ liệu nó cần. Điều này giải quyết hai vấn đề kinh điển của REST:

- **Over-fetching**: REST trả về cả object dù client chỉ cần `name`. GraphQL chỉ trả đúng field yêu cầu.
- **Under-fetching (N+1 round-trip)**: REST muốn lấy user + posts + comments phải gọi 3 endpoint. GraphQL gộp thành một query.

Trái tim của GraphQL là **schema** viết bằng SDL (Schema Definition Language). Có 3 root type:

- `Query` — đọc dữ liệu (tương đương GET).
- `Mutation` — ghi/sửa/xóa dữ liệu (tương đương POST/PUT/DELETE).
- `Subscription` — nhận dữ liệu real-time khi có thay đổi (push qua WebSocket).

```graphql
# schema.graphql — AppSync dùng đúng SDL này
type Post {
  id: ID!
  title: String!
  content: String
  author: String!
}

type Query {
  getPost(id: ID!): Post
  listPosts: [Post]
}

type Mutation {
  createPost(title: String!, content: String, author: String!): Post
}

type Subscription {
  # subscription được kích hoạt khi mutation createPost chạy xong
  onCreatePost: Post
    @aws_subscribe(mutations: ["createPost"])
}
```

Dấu `!` nghĩa là non-null (bắt buộc). `[Post]` là list. Directive `@aws_subscribe` là phần riêng của AppSync — nó nối subscription với mutation: mỗi khi `createPost` trả kết quả thành công, AppSync tự push payload tới mọi client đang subscribe `onCreatePost`. Đây là điểm AppSync khác GraphQL thuần — bạn không phải tự viết pub/sub.

Một query phía client trông như sau, và response có cấu trúc **giống hệt** query:

```graphql
query {
  getPost(id: "123") {
    id
    title      # chỉ lấy 2 field này, không lấy content/author
  }
}
```

> 💡 **Exam Tip:** Nếu đề nhấn mạnh "mobile/web app cần lấy đúng dữ liệu mình muốn, giảm số lần gọi API, và cần real-time updates" → đó là tín hiệu chọn **AppSync (GraphQL)** chứ không phải API Gateway REST.

## 44.2 Kiến trúc AppSync: API, schema, resolver, data source

AWS AppSync là dịch vụ **managed GraphQL** — bạn không phải tự vận hành GraphQL server. AppSync lo scaling, caching, authorization, và real-time WebSocket. Một AppSync API gồm 4 thành phần:

1. **GraphQL API** — endpoint, có authorization config và endpoint type (GraphQL endpoint + real-time endpoint).
2. **Schema** — file SDL định nghĩa type/query/mutation/subscription.
3. **Data sources** — nơi dữ liệu thực sự nằm: DynamoDB, Lambda, HTTP endpoint, Amazon OpenSearch, Aurora (qua RDS Data API), hoặc `NONE` (local resolver).
4. **Resolvers** — "chất keo" map một field trong schema sang một data source và biến đổi dữ liệu qua lại.

Luồng xử lý một request:

```
Client → GraphQL query → AppSync (auth check) → Resolver
  → Request mapping (biến GraphQL args thành lệnh cho data source)
  → Data source (vd DynamoDB GetItem)
  → Response mapping (biến kết quả data source thành GraphQL response)
  → Client
```

Mỗi field trong `Query`/`Mutation` có thể gắn một resolver riêng. Ví dụ `getPost` gắn vào data source DynamoDB và resolver sinh ra `GetItem`, còn `listPosts` sinh ra `Scan`/`Query`.

Tạo API và data source bằng CLI:

```bash
# Tạo GraphQL API với auth mode mặc định API_KEY
aws appsync create-graphql-api \
  --name BlogAPI \
  --authentication-type API_KEY

# Gắn DynamoDB làm data source (cần service role cho phép AppSync gọi DynamoDB)
aws appsync create-data-source \
  --api-id <API_ID> \
  --name PostTable \
  --type AMAZON_DYNAMODB \
  --service-role-arn arn:aws:iam::111122223333:role/AppSyncDDBRole \
  --dynamodb-config tableName=Posts,awsRegion=ap-southeast-1
```

> 💡 **Exam Tip:** AppSync gọi data source bằng một **service role** (IAM role mà AppSync assume), không phải bằng credentials của người dùng cuối. Người dùng cuối chỉ bị kiểm tra ở lớp authorization của AppSync. Đây là lý do bạn có thể cấp quyền fine-grained ngay trong resolver (vd chỉ cho user đọc item của chính họ).

## 44.3 Resolver: VTL vs JS resolver, unit vs pipeline

Resolver là nơi quyết định AppSync "nói gì" với data source. Có hai ngôn ngữ viết resolver:

- **VTL (Velocity Template Language)** — cách cũ, dùng Apache Velocity. Có 2 template: **request mapping** (build lệnh data source) và **response mapping** (build kết quả). Cú pháp dùng `$context`, `$util`. Khó debug, nhưng vẫn còn nhiều câu thi nhắc tới.
- **JS resolver (APPSYNC_JS runtime)** — cách mới, viết bằng JavaScript (một subset). Mỗi resolver export hai hàm `request(ctx)` và `response(ctx)`. Dễ đọc hơn VTL rất nhiều và là hướng AWS khuyến nghị hiện tại.

Object `$context` (VTL) hay `ctx` (JS) chứa: `arguments` (args của field), `identity` (thông tin user đã auth), `source` (object cha trong nested resolver), `result`, `error`, `stash` (chia sẻ dữ liệu giữa các bước pipeline).

Ví dụ JS resolver cho `getPost` trên DynamoDB:

```javascript
// getPost.js — JS resolver runtime APPSYNC_JS
import { util } from '@aws-appsync/utils';

export function request(ctx) {
  // build lệnh GetItem từ argument id
  return {
    operation: 'GetItem',
    key: util.dynamodb.toMapValues({ id: ctx.args.id }),
  };
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  return ctx.result; // map thẳng item DynamoDB ra Post
}
```

VTL tương đương (để bạn nhận diện khi gặp trong đề):

```vtl
## Request mapping template (VTL)
{
  "version": "2018-05-29",
  "operation": "GetItem",
  "key": { "id": $util.dynamodb.toDynamoDBJson($ctx.args.id) }
}
## Response mapping template: $util.toJson($ctx.result)
```

**Unit resolver vs Pipeline resolver:**

| | Unit resolver | Pipeline resolver |
|---|---|---|
| Số data source | 1 | Nhiều (chuỗi function) |
| Cấu trúc | 1 request + 1 response | Before mapping → nhiều **function** → After mapping |
| Khi nào dùng | Thao tác đơn (1 GetItem) | Cần nhiều bước: kiểm tra quyền ở Lambda rồi mới ghi DynamoDB; gọi 2 bảng tuần tự |
| Chia sẻ dữ liệu giữa bước | — | qua `ctx.stash` |

Pipeline resolver chạy danh sách **AppSync Function** tuần tự. Mỗi function gắn vào một data source. Ví dụ: function 1 gọi Lambda để authorize, function 2 ghi DynamoDB nếu pass. Dữ liệu truyền giữa các function qua `ctx.stash`.

> 💡 **Exam Tip:** Cần "validate hoặc enrich dữ liệu rồi mới ghi vào nhiều data source trong một GraphQL operation" → **pipeline resolver**. Một thao tác đơn giản ánh xạ 1-1 với data source → **unit resolver**. Đừng nhầm pipeline resolver với việc gọi nhiều Lambda — pipeline có thể trộn DynamoDB + Lambda + HTTP.

## 44.4 Data sources: DynamoDB, Lambda, HTTP, OpenSearch, RDS, NONE

AppSync hỗ trợ nhiều loại data source, mỗi loại có thế mạnh riêng:

- **Amazon DynamoDB** — phổ biến nhất. AppSync sinh trực tiếp lệnh GetItem/Query/PutItem/DeleteItem/TransactWriteItems mà KHÔNG cần Lambda trung gian. Đây là pattern serverless rẻ và nhanh nhất (chi tiết DynamoDB ở Chương 31-33).
- **AWS Lambda** — khi cần business logic phức tạp, gọi API bên thứ ba, hoặc tổng hợp nhiều nguồn. Resolver chỉ việc `invoke` Lambda với payload chứa `ctx.arguments`/`ctx.identity`. Linh hoạt nhất nhưng thêm cold start và chi phí.
- **HTTP endpoint** — gọi REST API bất kỳ (public hoặc qua VPC) ngay trong resolver, không qua Lambda. AppSync có thể ký SigV4 nếu gọi service AWS khác.
- **Amazon OpenSearch Service** — cho full-text search, query phức tạp mà DynamoDB không làm tốt (chi tiết OpenSearch ở Chương 48).
- **Amazon Aurora (RDS Data API)** — chạy SQL qua relational database.
- **NONE (local resolver)** — không gọi data nguồn ngoài. Dùng để biến đổi dữ liệu thuần local, hoặc — quan trọng — **publish một subscription** mà không ghi DB. Đây là mẹo gửi notification real-time qua AppSync (vd "pub-sub thuần").
- **EventBridge** — đẩy custom event lên event bus.

```bash
# Data source kiểu Lambda
aws appsync create-data-source \
  --api-id <API_ID> --name OrderLogic --type AWS_LAMBDA \
  --service-role-arn arn:aws:iam::111122223333:role/AppSyncLambdaRole \
  --lambda-config lambdaFunctionArn=arn:aws:lambda:ap-southeast-1:111122223333:function:OrderFn
```

> 💡 **Exam Tip:** "Cần GraphQL nhưng business logic phức tạp / gọi service ngoài" → data source **Lambda**. "CRUD đơn giản, ít vận hành nhất" → **DynamoDB direct** (không cần Lambda). "Full-text search" → **OpenSearch**. Local resolver kiểu **NONE** thường xuất hiện trong câu hỏi về gửi subscription mà không lưu DB.

## 44.5 Real-time subscriptions qua WebSocket

Đây là điểm bán hàng lớn nhất của AppSync và là chủ đề thi yêu thích. AppSync hỗ trợ subscription real-time **out-of-the-box** qua WebSocket (giao thức MQTT-over-WebSocket trước đây, nay là pure WebSocket). Bạn không phải tự dựng WebSocket server như khi dùng API Gateway WebSocket API (Chương 35).

Cơ chế:

1. Client gọi `subscription { onCreatePost { ... } }`. AppSync mở một kết nối WebSocket riêng (real-time endpoint, khác với endpoint HTTPS của query/mutation).
2. Field subscription được gắn directive `@aws_subscribe(mutations: ["createPost"])`.
3. Khi **bất kỳ client nào** gọi mutation `createPost` thành công, AppSync tự động push kết quả mutation tới mọi subscriber.

Bạn có thể **lọc** subscription để client chỉ nhận event liên quan, dùng filter (vd chỉ nhận post của một author cụ thể) thông qua enhanced subscription filtering hoặc argument trên subscription field:

```graphql
type Subscription {
  onCreatePostByAuthor(author: String!): Post
    @aws_subscribe(mutations: ["createPost"])
}
```

Khi client subscribe với `author: "alice"`, AppSync chỉ đẩy post có author khớp. Giới hạn: mỗi WebSocket connection và payload subscription có quota (payload subscription tối đa 240 KB).

**Lưu ý vận hành quan trọng:** subscription chỉ được kích hoạt khi mutation chạy **qua AppSync**. Nếu bạn ghi thẳng vào DynamoDB bằng SDK (bỏ qua AppSync), subscriber sẽ KHÔNG nhận được event — vì AppSync không "biết" có thay đổi. Đây là bẫy thiết kế hay gặp: muốn real-time thì mọi đường ghi phải đi qua mutation của AppSync, hoặc bạn phải dùng local resolver (NONE) để publish thủ công, hoặc bắc cầu DynamoDB Streams → Lambda → gọi mutation AppSync.

Một điểm nữa: payload của subscription chính là **kết quả trả về của mutation**. Nếu mutation chỉ `return { id }` thì subscriber chỉ nhận field `id`. Muốn subscriber nhận đủ field, mutation phải trả về đủ field đó (và subscription field phải khai báo các field tương ứng).

> 💡 **Exam Tip:** Câu hỏi kiểu "real-time chat / live dashboard / collaborative app, ít vận hành nhất" → **AppSync subscription**. So với API Gateway WebSocket (bạn phải tự quản connection ID, tự lưu vào DynamoDB, tự gọi `@connections` để push), AppSync subscription gần như zero-code phía hạ tầng — chỉ cần directive `@aws_subscribe`. Bẫy thường gặp: subscriber không nhận event vì dữ liệu được ghi **không qua mutation AppSync**.

## 44.6 Authorization — 5 mode và kết hợp nhiều mode

AppSync có **5 chế độ authorization**. Phải thuộc đủ 5 cho phần Security:

| Mode | Dùng cho | Cơ chế |
|---|---|---|
| **API_KEY** | Public/dev, demo | Key tĩnh, tối đa **365 ngày**, gửi qua header `x-api-key`. Không phải auth thật. |
| **AWS_IAM** | Backend, service-to-service, hoặc client có credentials qua Cognito Identity Pool | Ký request SigV4. |
| **AMAZON_COGNITO_USER_POOLS** | App có người dùng đăng nhập | Client gửi JWT từ User Pool; AppSync verify token, dùng group/claim để phân quyền (chi tiết Cognito ở Chương 38). |
| **OPENID_CONNECT** | OIDC provider bên ngoài (Auth0, Okta...) | Verify JWT theo issuer/JWKS. |
| **AWS_LAMBDA** | Logic auth tùy biến | Lambda authorizer trả `isAuthorized` + `resolverContext` + `deniedFields`. |

Điểm hay nhất: **AppSync cho phép nhiều authorization mode trên cùng một API**. Một mode là primary (default), các mode khác là additional. Bạn dùng directive trên từng type/field để chỉ định mode nào áp cho phần nào:

```graphql
type Query {
  # public — ai cũng đọc được qua API key
  listPublicPosts: [Post] @aws_api_key

  # chỉ user đã đăng nhập Cognito mới gọi được
  getMyDrafts: [Post] @aws_cognito_user_pools

  # chỉ admin group
  adminStats: Stats
    @aws_cognito_user_pools(cognito_groups: ["admin"])
}
```

Các directive tương ứng: `@aws_api_key`, `@aws_iam`, `@aws_cognito_user_pools`, `@aws_oidc`, `@aws_lambda`. `@aws_auth(cognito_groups: [...])` giới hạn theo group.

Trong resolver, bạn truy cập danh tính qua `ctx.identity`: với Cognito có `ctx.identity.sub`, `ctx.identity.username`, `ctx.identity.groups`, `ctx.identity.claims`. Dùng nó để fine-grained — ví dụ chỉ trả về item mà `owner == ctx.identity.username`.

```javascript
export function request(ctx) {
  return {
    operation: 'Query',
    query: {
      expression: 'owner = :o',
      expressionValues: util.dynamodb.toMapValues({
        ':o': ctx.identity.username, // chỉ lấy data của chính user
      }),
    },
    index: 'owner-index',
  };
}
```

**AWS_IAM kết hợp Cognito Identity Pool:** một pattern thi hay gặp là client web/mobile chưa đăng nhập (guest) vẫn cần gọi API. Bạn dùng Cognito Identity Pool cấp credentials tạm cho unauthenticated identity (qua STS — Chương 39), rồi AppSync dùng mode `AWS_IAM` để kiểm tra. IAM policy gắn vào role guest quyết định field/operation nào được phép qua action `appsync:GraphQL` trên ARN dạng `arn:aws:appsync:region:acct:apis/<apiId>/types/Query/fields/<field>`. Đây là cách phân quyền cực mịn tới từng field bằng IAM.

**Lambda authorizer** nhận token từ header `Authorization`, trả về object:

```json
{ "isAuthorized": true, "resolverContext": { "userId": "u-1" }, "deniedFields": ["Query/adminStats"], "ttlOverride": 300 }
```

`resolverContext` được đẩy vào `ctx.identity.resolverContext` cho resolver dùng; `deniedFields` chặn field cụ thể; `ttlOverride` cache kết quả auth để giảm số lần gọi Lambda.

> 💡 **Exam Tip:** Ghi nhớ các quota: **API key tối đa 365 ngày** (không phải vĩnh viễn — câu bẫy về key hết hạn gây 401). "App có user đăng nhập" → **Cognito User Pools** authorizer. "Guest/unauthenticated access có kiểm soát" → **IAM + Identity Pool**. "Cần một public field và một protected field trên cùng API" → bật **multiple authorization modes** + directive per-field. Lambda authorizer dùng khi logic auth không khớp 4 mode còn lại.

## 44.7 Caching, conflict resolution & offline

**Server-side caching:** AppSync có caching tích hợp (dùng cụm ElastiCache do AppSync quản lý). Hai chế độ:

- **FULL_REQUEST_CACHING** — cache toàn bộ kết quả query theo tất cả các tham số/identity.
- **PER_RESOLVER_CACHING** — bật cache cho từng resolver, tự chọn caching key (vd cache theo `ctx.args.id` và `ctx.identity.sub`).

Cache giảm tải data source và giảm latency cho dữ liệu đọc nhiều ít đổi. TTL cấu hình được; có thể bật encryption at-rest và in-transit cho cache.

**Conflict detection & resolution (offline sync):** AppSync hỗ trợ ghi từ client offline rồi đồng bộ lại, kết hợp với thư viện DataStore của Amplify. Khi đồng bộ, có thể xảy ra xung đột (hai client sửa cùng item). AppSync cung cấp các chiến lược:

- **Optimistic concurrency** — dùng một field version; ghi chỉ thành công nếu version client khớp version server, nếu không trả conflict để client retry (giống optimistic locking trong DynamoDB — Chương 32).
- **Automerge** — AppSync tự gộp thay đổi theo quy tắc field-level không xung đột.
- **Lambda conflict handler** — gọi Lambda để bạn tự quyết định resolve thế nào.

Cơ chế này dựa trên **Conflict Detection = VERSION** trên data source DynamoDB (AppSync tự thêm field `_version`, `_lastChangedAt`, `_deleted` và bật delta sync table).

> 💡 **Exam Tip:** "Mobile app cần hoạt động offline rồi sync khi có mạng, tự giải quyết xung đột" → **AppSync + Amplify DataStore** với conflict resolution (Automerge / Optimistic / Lambda). Đây là tổ hợp AWS đặc trưng cho offline-first; API Gateway không có sẵn cơ chế này.

## 44.8 AppSync vs API Gateway — chọn cái nào

Đây gần như chắc chắn xuất hiện trong đề. Bảng so sánh quyết định:

| Tiêu chí | AppSync (GraphQL) | API Gateway (REST/HTTP) |
|---|---|---|
| Mô hình API | GraphQL, 1 endpoint, client chọn field | REST/HTTP, nhiều endpoint, server định nghĩa response |
| Real-time | **Subscription qua WebSocket có sẵn** | Phải dùng WebSocket API + tự quản connection |
| Over/under-fetching | Tránh được, gộp nhiều nguồn 1 request | Dễ over-fetch / nhiều round-trip |
| Data source trực tiếp | DynamoDB/Lambda/HTTP/OpenSearch/RDS không cần code keo | Chủ yếu qua Lambda hoặc HTTP integration |
| Offline & conflict resolution | Có (DataStore) | Không có sẵn |
| Caching | Server-side per-resolver/full-request | Stage caching |
| Auth | API key, IAM, Cognito UP, OIDC, Lambda | IAM, Cognito UP, Lambda authorizer, API key (usage plan) |
| Use case điển hình | Mobile/web data-driven, real-time, nhiều nguồn dữ liệu | Microservice REST, webhook, public REST API |

Quy tắc nhanh: **dữ liệu phức tạp/nhiều nguồn/real-time/offline → AppSync; REST truyền thống, webhook, đơn giản → API Gateway.** (Chi tiết API Gateway ở Chương 34-35.)

> 💡 **Exam Tip:** Từ khóa "GraphQL", "real-time subscription", "offline sync", "flexible data queries from multiple data sources" gần như luôn dẫn tới **AppSync**. Từ khóa "REST API", "webhook", "throttle per API key with usage plans" dẫn tới **API Gateway**.

## 44.9 AWS Amplify — CLI, Hosting, Libraries & Studio

AWS Amplify là bộ công cụ giúp frontend/mobile developer dựng nhanh backend serverless và deploy app, mà không cần viết tay từng resource. Amplify thực chất sinh ra CloudFormation/CDK bên dưới, và rất hay đi đôi với AppSync.

**Amplify CLI** — dựng backend bằng lệnh tương tác:

```bash
amplify init                 # khởi tạo project, tạo IAM/S3 cho deploy
amplify add auth             # tạo Cognito User Pool + Identity Pool
amplify add api              # tạo AppSync GraphQL API (hoặc API Gateway REST)
amplify add storage          # tạo S3 bucket / DynamoDB table
amplify push                 # deploy toàn bộ qua CloudFormation
```

Khi `amplify add api` chọn GraphQL, bạn khai schema và Amplify tự sinh AppSync API, resolver, và bảng DynamoDB qua các directive như `@model` (sinh CRUD + table), `@auth` (sinh authorization rule), `@index`, `@hasMany`. Đây là cách nhanh nhất để có backend GraphQL hoàn chỉnh.

**Amplify Hosting** — CI/CD cho frontend (React/Vue/Angular/Next.js, static & SSR). Kết nối repo Git (GitHub/CodeCommit/GitLab/Bitbucket); mỗi `git push` tự build và deploy. Hỗ trợ branch-based environments (feature branch → môi trường preview riêng), atomic deploy (rollback nhanh), custom domain qua ACM, password protection, redirects. Bản chất là CDN (CloudFront) + build pipeline managed.

**Amplify Libraries** — thư viện client (JS, iOS, Android, Flutter) bọc các category:

- **Auth** — bọc Cognito (sign-up/sign-in, MFA, social login) — chi tiết Cognito ở Chương 38-39.
- **API** — gọi AppSync GraphQL hoặc API Gateway REST kèm tự ký auth.
- **Storage** — upload/download S3 (public/protected/private prefix).
- **DataStore** — offline-first store đồng bộ với AppSync (mục 44.7).

```javascript
// Amplify Library v6 — gọi AppSync từ React
import { generateClient } from 'aws-amplify/api';
const client = generateClient();

await client.graphql({
  query: `mutation { createPost(title:"Hi", author:"alice"){ id } }`,
});
```

**Amplify Studio** — giao diện visual để quản lý data model, auth, và build UI component (Figma-to-code), bổ trợ cho CLI mà không cần code.

> 💡 **Exam Tip:** Câu hỏi kiểu "front-end developer cần dựng nhanh full-stack app (auth + API + storage) và CI/CD hosting từ Git với ít công sức nhất" → **AWS Amplify**. Amplify không phải dịch vụ hạ tầng mới — nó **điều phối** Cognito/AppSync/S3/DynamoDB/CloudFront bên dưới. Trong đề, nếu nhấn "least development effort to build and host a web/mobile app" thì nghĩ tới Amplify; còn nếu hỏi cụ thể về cơ chế GraphQL/subscription/resolver thì nghĩ tới AppSync.
