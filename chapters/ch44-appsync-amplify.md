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

---

## Hands-on Lab: Dựng GraphQL API bằng AppSync với data source DynamoDB, JS resolver, đa cơ chế auth và test subscription real-time

**Mục tiêu lab:** Tạo một AppSync GraphQL API hoàn chỉnh bằng AWS CLI v2: định nghĩa schema (query/mutation/subscription), tạo data source DynamoDB kèm IAM service role, viết một JS resolver (APPSYNC_JS runtime) cho mutation `createTodo` và query `getTodo`, cấu hình primary auth là API key + thêm Cognito User Pools làm additional auth, chạy thử query/mutation bằng `curl`, và quan sát subscription real-time qua WebSocket. Cuối cùng dọn sạch tài nguyên.

**Chuẩn bị:**
- AWS CLI v2 đã cấu hình profile có quyền `appsync:*`, `dynamodb:*`, `iam:*` (tài khoản học tập, không phải production).
- Node.js >= 18 nếu muốn test subscription bằng client. `jq` để parse JSON.
- Region dùng xuyên suốt: `ap-southeast-1`.

```bash
export AWS_REGION="ap-southeast-1"
export API_NAME="dva-lab-ch44-api"
export TABLE_NAME="dva-lab-ch44-todos"
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
```

> Lưu ý chi phí: AppSync tính tiền theo số query/mutation ($4 / triệu request) và số phút real-time updates; DynamoDB on-demand tính theo request. Lab này chỉ vài request nên gần như $0, nhưng vẫn phải dọn dẹp.

### Bước 1: Tạo bảng DynamoDB làm data source

```bash
aws dynamodb create-table \
  --table-name "$TABLE_NAME" \
  --attribute-definitions AttributeName=id,AttributeType=S \
  --key-schema AttributeName=id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region "$AWS_REGION"
```

Đợi bảng `ACTIVE`:

```bash
aws dynamodb wait table-exists --table-name "$TABLE_NAME"
```

### Bước 2: Tạo GraphQL API với primary auth = API key

```bash
API_ID=$(aws appsync create-graphql-api \
  --name "$API_NAME" \
  --authentication-type API_KEY \
  --query 'graphqlApi.apiId' --output text)
echo "API_ID=$API_ID"
```

Tạo một API key (mặc định hết hạn sau 7 ngày, tối đa 365 ngày):

```bash
API_KEY=$(aws appsync create-api-key --api-id "$API_ID" \
  --query 'apiKey.id' --output text)
echo "API_KEY=$API_KEY"

GRAPHQL_URL=$(aws appsync get-graphql-api --api-id "$API_ID" \
  --query 'graphqlApi.uris.GRAPHQL' --output text)
echo "GRAPHQL_URL=$GRAPHQL_URL"
```

Bẫy thi: API key dùng cho prototyping hoặc public read-only, KHÔNG dùng cho production cần phân quyền theo user. Key có hạn tối đa 365 ngày — không bao giờ "vĩnh viễn".

### Bước 3: Upload schema GraphQL

Tạo file schema:

```bash
cat > schema.graphql <<'EOF'
type Todo {
  id: ID!
  title: String!
  done: Boolean!
}
input CreateTodoInput {
  id: ID!
  title: String!
  done: Boolean!
}
type Query {
  getTodo(id: ID!): Todo
}
type Mutation {
  createTodo(input: CreateTodoInput!): Todo
}
type Subscription {
  onCreateTodo: Todo
    @aws_subscribe(mutations: ["createTodo"])
}
EOF

aws appsync start-schema-creation --api-id "$API_ID" \
  --definition fileb://schema.graphql

# Đợi schema tạo xong
aws appsync get-schema-creation-status --api-id "$API_ID" \
  --query 'status'   # mong đợi "SUCCESS"
```

Điểm cốt lõi: directive `@aws_subscribe(mutations: [...])` gắn một subscription field với một hoặc nhiều mutation. AppSync tự đẩy kết quả mutation tới mọi client đang subscribe — bạn KHÔNG cần viết resolver cho subscription cơ bản.

### Bước 4: Tạo IAM service role cho AppSync gọi DynamoDB

```bash
cat > trust.json <<'EOF'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow",
"Principal":{"Service":"appsync.amazonaws.com"},
"Action":"sts:AssumeRole"}]}
EOF

ROLE_ARN=$(aws iam create-role --role-name dva-lab-ch44-appsync-role \
  --assume-role-policy-document file://trust.json \
  --query 'Role.Arn' --output text)

cat > perm.json <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow",
"Action":["dynamodb:GetItem","dynamodb:PutItem"],
"Resource":"arn:aws:dynamodb:$AWS_REGION:$ACCOUNT_ID:table/$TABLE_NAME"}]}
EOF

aws iam put-role-policy --role-name dva-lab-ch44-appsync-role \
  --policy-name ddb-access --policy-document file://perm.json
```

Bẫy: AppSync KHÔNG dùng credentials của caller để gọi DynamoDB. Nó assume service role này — quyền của resolver tới data source độc lập hoàn toàn với cơ chế auth của API.

### Bước 5: Gắn data source DynamoDB

```bash
aws appsync create-data-source --api-id "$API_ID" \
  --name TodoTable \
  --type AMAZON_DYNAMODB \
  --service-role-arn "$ROLE_ARN" \
  --dynamodb-config tableName=$TABLE_NAME,awsRegion=$AWS_REGION
```

### Bước 6: Viết JS resolver (APPSYNC_JS) cho createTodo và getTodo

AppSync JS resolver gồm hai hàm: `request` (dựng lệnh gửi tới data source) và `response` (biến đổi kết quả trả về client).

```bash
cat > createTodo.js <<'EOF'
import { util } from '@aws-appsync/utils';
export function request(ctx) {
  const item = ctx.args.input;
  return {
    operation: 'PutItem',
    key: util.dynamodb.toMapValues({ id: item.id }),
    attributeValues: util.dynamodb.toMapValues({
      title: item.title, done: item.done,
    }),
  };
}
export function response(ctx) {
  if (ctx.error) util.error(ctx.error.message, ctx.error.type);
  return ctx.result;
}
EOF

aws appsync create-resolver --api-id "$API_ID" \
  --type-name Mutation --field-name createTodo \
  --data-source-name TodoTable \
  --runtime name=APPSYNC_JS,runtimeVersion=1.0.0 \
  --code fileb://createTodo.js
```

```bash
cat > getTodo.js <<'EOF'
import { util } from '@aws-appsync/utils';
export function request(ctx) {
  return {
    operation: 'GetItem',
    key: util.dynamodb.toMapValues({ id: ctx.args.id }),
  };
}
export function response(ctx) {
  if (ctx.error) util.error(ctx.error.message, ctx.error.type);
  return ctx.result;
}
EOF

aws appsync create-resolver --api-id "$API_ID" \
  --type-name Query --field-name getTodo \
  --data-source-name TodoTable \
  --runtime name=APPSYNC_JS,runtimeVersion=1.0.0 \
  --code fileb://getTodo.js
```

Đây là **unit resolver** (1 field → 1 data source). Khi cần nhiều bước (vd: kiểm quyền bằng Lambda rồi mới ghi DynamoDB), bạn dùng **pipeline resolver** gồm nhiều function chạy tuần tự với `ctx.stash` truyền dữ liệu giữa các bước (chi tiết cơ chế ở part1).

### Bước 7: Test mutation và query bằng curl

```bash
# Mutation createTodo
curl -s -X POST "$GRAPHQL_URL" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{"query":"mutation { createTodo(input:{id:\"1\",title:\"Learn AppSync\",done:false}){ id title done } }"}' | jq
```

Output mong đợi:

```json
{ "data": { "createTodo": { "id": "1", "title": "Learn AppSync", "done": false } } }
```

```bash
# Query getTodo
curl -s -X POST "$GRAPHQL_URL" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{"query":"query { getTodo(id:\"1\"){ id title done } }"}' | jq
```

Để ý sức mạnh GraphQL: nếu bạn chỉ yêu cầu `{ id title }`, response chỉ trả về `id` và `title` — không over-fetching như REST. Header auth ở đây là `x-api-key` (API key auth). Với Cognito/OIDC bạn gửi JWT trong header `Authorization`; với IAM auth phải ký SigV4.

### Bước 8: Thêm additional auth Cognito User Pools

AppSync hỗ trợ một **primary** auth mode và nhiều **additional** auth mode. Mỗi field có thể gắn directive `@aws_api_key`, `@aws_cognito_user_pools`, `@aws_iam`... để giới hạn ai gọi được.

```bash
# (Giả sử đã có một Cognito User Pool POOL_ID — xem Chương 38)
aws appsync update-graphql-api --api-id "$API_ID" \
  --name "$API_NAME" \
  --authentication-type API_KEY \
  --additional-authentication-providers \
    "authenticationType=AMAZON_COGNITO_USER_POOLS,userPoolConfig={userPoolId=$POOL_ID,awsRegion=$AWS_REGION}"
```

Điểm thi: một AppSync API có thể trộn nhiều cơ chế auth cùng lúc — vd để guest đọc public data bằng API key nhưng yêu cầu Cognito JWT cho mutation. Đây là khác biệt lớn so với API Gateway authorizer gắn theo method.

### Bước 9: Quan sát subscription real-time (tùy chọn)

Subscription chạy qua WebSocket trên endpoint `REALTIME` (lấy từ `uris.REALTIME`). Mở một client subscribe `onCreateTodo`, rồi từ terminal khác chạy lại mutation ở Bước 7 — client sẽ nhận push ngay lập tức mà không cần polling. Trong console AppSync, tab **Queries** có sẵn UI để chạy subscription trực quan: mở subscription, để đó, chạy mutation ở tab khác và xem dữ liệu hiện ra real-time.

### Dọn dẹp tài nguyên

```bash
# Xoá AppSync API (xoá luôn resolver, data source, schema, API key)
aws appsync delete-graphql-api --api-id "$API_ID"

# Xoá IAM role
aws iam delete-role-policy --role-name dva-lab-ch44-appsync-role --policy-name ddb-access
aws iam delete-role --role-name dva-lab-ch44-appsync-role

# Xoá bảng DynamoDB
aws dynamodb delete-table --table-name "$TABLE_NAME"
```

Xoá GraphQL API sẽ cuốn theo toàn bộ resolver, data source và API key gắn với nó. Bảng DynamoDB và IAM role là tài nguyên độc lập nên phải xoá riêng.

## 💡 Exam Tips chương 44

- **AppSync = managed GraphQL.** Một endpoint, client tự chọn lấy đúng field cần — tránh over-fetching/under-fetching của REST. Câu hỏi "mobile app cần lấy dữ liệu từ nhiều bảng trong một request, tiết kiệm băng thông" → AppSync, không phải API Gateway.
- **Real-time subscriptions là điểm mạnh kinh điển của AppSync**: WebSocket-based, dùng directive `@aws_subscribe(mutations: [...])`, AppSync tự đẩy data khi mutation chạy. Tình huống "live chat / live scoreboard / cập nhật tức thì" → AppSync subscriptions, không cần tự dựng WebSocket như API Gateway WebSocket API.
- **Năm cơ chế auth của AppSync**: API key (prototyping, key tối đa 365 ngày), IAM (SigV4, dùng cho service/Identity Pool credentials), Cognito User Pools (JWT user), OIDC (IdP ngoài), và AWS Lambda authorizer (logic tùy biến). Một API có 1 primary + nhiều additional auth mode cùng lúc.
- **Directive phân quyền theo field**: `@aws_api_key`, `@aws_cognito_user_pools`, `@aws_iam`, `@aws_oidc`, `@aws_lambda` gắn vào type/field để giới hạn cơ chế nào gọi được field đó. `@aws_auth(cognito_groups: [...])` giới hạn theo group.
- **Hai loại resolver**: unit (1 field → 1 data source) và pipeline (nhiều function tuần tự, chia sẻ qua `ctx.stash`). Resolver viết bằng **JS (APPSYNC_JS runtime)** hoặc **VTL (Velocity Template)**. JS resolver là hướng hiện đại; VTL vẫn xuất hiện trong đề cũ.
- **Data sources**: DynamoDB, Lambda, HTTP, OpenSearch, RDS (qua Data API), EventBridge, và NONE (local resolver, không gọi backend — hữu ích cho subscription hoặc biến đổi pure). AppSync gọi data source bằng **service role**, không phải credentials của caller.
- **Caching**: AppSync hỗ trợ server-side cache (per-resolver hoặc full-request caching) với TTL, lưu trong cluster Redis-managed — giảm tải data source. Phân biệt với caching client-side.
- **Conflict detection & resolution** cho offline/multi-writer: Optimistic Concurrency (dùng version), Automerge, hoặc Lambda custom. Đi kèm DynamoDB `_version`, `_lastChangedAt` khi bật. Tình huống "app offline-first, đồng bộ khi online" → AppSync (trước đây qua Amplify DataStore).
- **AppSync vs API Gateway**: AppSync = GraphQL + subscription real-time + offline sync, hợp data-driven app nhiều entity quan hệ. API Gateway = REST/HTTP/WebSocket truyền thống, nhiều integration hơn (mọi AWS service, HTTP backend). Đừng chọn AppSync chỉ vì muốn "một REST endpoint".
- **Amplify** là framework full-stack (CLI + libraries + Hosting), KHÔNG phải một AWS service riêng tính tiền — nó tạo ra AppSync, Cognito, S3, Lambda... bên dưới. Amplify Hosting cho CI/CD từ Git (build + deploy SPA/SSR), khác Amplify libraries (Auth, API, Storage) dùng trong code frontend.
- **Khi nào chọn Amplify**: dev frontend muốn dựng nhanh backend (auth + GraphQL + storage) không cần chuyên sâu hạ tầng, hoặc cần CI/CD hosting cho web app từ Git. Khi cần kiểm soát hạ tầng chi tiết → IaC thuần (CDK/SAM, Chương 36–37).
- **Amplify Hosting tự build trên mỗi git push**, hỗ trợ PR previews, branch-based environments, và atomic deploy với rollback — đừng nhầm với CodePipeline (Chương 42) vốn tổng quát hơn.

## Quiz chương 44 (10 câu)

**Câu 1.** Một mobile app cần lấy dữ liệu user, danh sách bài viết và bình luận trong MỘT request mạng, chỉ lấy đúng field cần để tiết kiệm băng thông. Dịch vụ nào phù hợp nhất?
- A. REST API trên API Gateway với nhiều endpoint
- B. AWS AppSync (GraphQL)
- C. Kinesis Data Streams
- D. CloudFront với nhiều origin

**Câu 2.** Một ứng dụng "live auction" cần đẩy giá đấu mới tới tất cả client đang xem ngay khi có lệnh đặt giá, không polling. Cách ít công sức nhất?
- A. API Gateway REST với client polling mỗi 2 giây
- B. AppSync GraphQL subscription với `@aws_subscribe`
- C. SQS long polling
- D. DynamoDB Streams đọc trực tiếp từ client

**Câu 3.** Cơ chế auth nào của AppSync phù hợp cho prototyping public read-only và có hạn sử dụng tối đa 365 ngày?
- A. Cognito User Pools
- B. IAM (SigV4)
- C. API key
- D. OIDC

**Câu 4.** Một AppSync API cần cho phép guest đọc dữ liệu public bằng API key, nhưng yêu cầu user đăng nhập (Cognito JWT) cho mutation. Cấu hình đúng?
- A. Tạo hai API riêng biệt
- B. Dùng primary auth API key + additional auth Cognito User Pools, gắn directive theo field
- C. Chỉ dùng Lambda authorizer cho mọi field
- D. Không thể trộn nhiều auth trong một AppSync API

**Câu 5.** Khi AppSync resolver ghi item vào DynamoDB, AppSync dùng credentials nào để gọi DynamoDB?
- A. Credentials của user đang gọi API
- B. API key
- C. IAM service role gắn vào data source
- D. Root account credentials

**Câu 6.** Loại resolver nào cho phép chạy nhiều bước tuần tự (vd: validate bằng Lambda rồi ghi DynamoDB), chia sẻ dữ liệu giữa các bước?
- A. Unit resolver
- B. Pipeline resolver với `ctx.stash`
- C. Mapping template resolver
- D. Direct Lambda resolver

**Câu 7.** Developer muốn frontend React app được CI/CD tự động build và deploy mỗi khi push lên nhánh Git, kèm preview cho pull request, ít cấu hình nhất. Dịch vụ nào?
- A. AWS Amplify Hosting
- B. CodePipeline + CodeBuild tự cấu hình
- C. S3 static website + thủ công upload
- D. Elastic Beanstalk

**Câu 8.** Một AppSync API gọi data source backend qua HTTP REST bên ngoài AWS để lấy dữ liệu tỉ giá. Loại data source nào?
- A. AMAZON_DYNAMODB
- B. AWS_LAMBDA
- C. HTTP
- D. NONE

**Câu 9.** App offline-first cần đồng bộ dữ liệu khi mạng có lại, xử lý xung đột khi nhiều thiết bị cùng sửa một item. Tính năng nào của AppSync hỗ trợ trực tiếp?
- A. Caching server-side
- B. Conflict detection & resolution (Optimistic Concurrency / Automerge / Lambda)
- C. API key rotation
- D. Pipeline resolver

**Câu 10.** Phát biểu nào về AWS Amplify ĐÚNG?
- A. Amplify là một dịch vụ tính tiền riêng thay thế AppSync
- B. Amplify CLI/libraries tạo ra hạ tầng bên dưới như AppSync, Cognito, S3 và cung cấp client SDK (Auth, API, Storage)
- C. Amplify chỉ chạy được với REST API, không hỗ trợ GraphQL
- D. Amplify Hosting không hỗ trợ CI/CD từ Git

### Đáp án & giải thích

**Câu 1 — Đáp án B.** GraphQL của AppSync cho phép gộp dữ liệu nhiều nguồn trong một request và client chỉ lấy đúng field cần (tránh over/under-fetching). A (nhiều REST endpoint) buộc nhiều round-trip và dễ over-fetch. C (Kinesis) là streaming ingest, không phải query API. D (CloudFront) là CDN, không gộp truy vấn dữ liệu.

**Câu 2 — Đáp án B.** AppSync subscription dùng WebSocket và directive `@aws_subscribe`, tự push khi mutation chạy — không code WebSocket server. A (polling) tốn tài nguyên và trễ. C (SQS) là hàng đợi, không broadcast tới nhiều client. D sai — client không nên (và không thể an toàn) đọc DynamoDB Streams trực tiếp.

**Câu 3 — Đáp án C.** API key hợp cho prototyping/public read-only, hết hạn tối đa 365 ngày. A (Cognito) cho user-based auth, không có khái niệm "key hạn 365 ngày". B (IAM) cho service/credentials AWS. D (OIDC) cho IdP ngoài. Chỉ API key khớp mô tả.

**Câu 4 — Đáp án B.** AppSync cho phép 1 primary auth + nhiều additional auth mode, và dùng directive (`@aws_api_key`, `@aws_cognito_user_pools`) để khóa từng field. A lãng phí và phức tạp. C (chỉ Lambda authorizer) không tách được guest vs user theo yêu cầu một cách đơn giản. D sai hoàn toàn — trộn auth là tính năng có sẵn.

**Câu 5 — Đáp án C.** AppSync assume IAM service role gắn vào data source để truy cập backend; quyền này độc lập với auth mode của API. A sai — credentials caller không được dùng để gọi DynamoDB. B (API key) chỉ xác thực vào API, không phải quyền tới DynamoDB. D sai — không bao giờ dùng root credentials.

**Câu 6 — Đáp án B.** Pipeline resolver gồm nhiều function chạy tuần tự, dùng `ctx.stash` truyền dữ liệu giữa các bước. A (unit) chỉ 1 field → 1 data source, một bước. C, D không phải phân loại "nhiều bước tuần tự" — direct Lambda resolver vẫn là một bước gọi Lambda.

**Câu 7 — Đáp án A.** Amplify Hosting làm CI/CD từ Git (build + deploy) với PR previews và branch environments, ít cấu hình nhất cho frontend. B (CodePipeline tự cấu hình) làm được nhưng nhiều công hơn. C (S3 thủ công) không có CI/CD. D (Beanstalk) cho app server backend, không tối ưu cho SPA frontend.

**Câu 8 — Đáp án C.** Data source loại HTTP cho phép AppSync gọi REST endpoint bất kỳ (kể cả ngoài AWS). A là DynamoDB. B (Lambda) làm được nhưng phải viết hàm trung gian — không phải lựa chọn "trực tiếp HTTP". D (NONE) là local resolver, không gọi backend.

**Câu 9 — Đáp án B.** AppSync có conflict detection & resolution (Optimistic Concurrency, Automerge, hoặc Lambda custom) cho kịch bản offline/multi-writer. A (caching) tăng tốc đọc, không xử lý xung đột. C (API key rotation) không liên quan. D (pipeline resolver) là về luồng xử lý, không phải đồng bộ offline.

**Câu 10 — Đáp án B.** Amplify là framework full-stack: CLI/libraries dựng hạ tầng (AppSync, Cognito, S3, Lambda) và cung cấp client SDK Auth/API/Storage; Hosting làm CI/CD từ Git. A sai — Amplify không thay thế AppSync, nó dùng AppSync. C sai — Amplify hỗ trợ GraphQL (qua AppSync) lẫn REST. D sai — Hosting hỗ trợ CI/CD từ Git.

## Tóm tắt chương

- **AppSync** là managed GraphQL service: một endpoint, client tự chọn field cần, tránh over/under-fetching điển hình của REST.
- GraphQL có ba operation: **query** (đọc), **mutation** (ghi), **subscription** (nhận push real-time qua WebSocket nhờ directive `@aws_subscribe`).
- **Resolver** nối field với data source: unit (1 field → 1 source) hoặc pipeline (nhiều function tuần tự, chia sẻ qua `ctx.stash`); viết bằng JS (APPSYNC_JS) hoặc VTL.
- **Data sources** hỗ trợ: DynamoDB, Lambda, HTTP, OpenSearch, RDS (Data API), EventBridge, NONE (local). AppSync truy cập backend bằng **IAM service role**, không phải credentials caller.
- **Năm cơ chế auth**: API key, IAM (SigV4), Cognito User Pools, OIDC, Lambda authorizer — một API có 1 primary + nhiều additional, phân quyền tới từng field bằng directive.
- **Real-time subscriptions** là thế mạnh kinh điển: live chat, live scoreboard, live auction — không cần tự dựng WebSocket server.
- **Caching** server-side (per-resolver hoặc full-request) với TTL giảm tải data source; **conflict resolution** (Optimistic Concurrency / Automerge / Lambda) phục vụ app offline-first.
- **AppSync vs API Gateway**: chọn AppSync cho data-driven app nhiều entity quan hệ + real-time + offline sync; chọn API Gateway cho REST/HTTP/WebSocket truyền thống và nhiều loại integration hơn.
- **Amplify** là framework full-stack, không phải dịch vụ tính tiền riêng — CLI/libraries dựng hạ tầng (AppSync, Cognito, S3) và cung cấp client SDK (Auth, API, Storage).
- **Amplify Hosting** làm CI/CD từ Git: build + deploy SPA/SSR, PR previews, branch environments, atomic deploy với rollback.
- **Khi nào chọn Amplify**: dev frontend muốn dựng nhanh backend không cần chuyên sâu hạ tầng; cần kiểm soát chi tiết thì dùng IaC thuần (CDK/SAM).
- API key của AppSync hết hạn tối đa **365 ngày** — chỉ dùng prototyping/public read-only, không cho production cần phân quyền theo user.
