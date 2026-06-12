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
