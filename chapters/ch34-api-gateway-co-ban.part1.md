# Chương 34: Amazon API Gateway cơ bản

> **Trọng tâm DVA-C02:** API Gateway là service "trục" của serverless và xuất hiện dày đặc trong domain Development. Đề thi xoáy vào: phân biệt **Lambda proxy vs non-proxy integration** (ai chịu trách nhiệm map request/response?), hiểu **flow 4 chặng** method request → integration request → integration response → method response, dùng **mapping template VTL** để biến đổi payload, **stage variables** trỏ tới Lambda alias để tách dev/prod, **canary deployment** chia traffic theo phần trăm, **request validation** với models, và **binary media types**. Câu hỏi hay gài: "developer thay đổi cấu hình API nhưng client vẫn thấy hành vi cũ" → quên **deploy stage**; hoặc "Lambda nhận event không có header/query" → dùng nhầm non-proxy mà không viết mapping template.

## Mục tiêu chương

- Hiểu API Gateway giải quyết bài toán gì, ba **endpoint type** (edge-optimized, regional, private) khác nhau ra sao và khi nào chọn cái nào.
- Nắm cấu trúc **REST API**: resources, methods, và **flow xử lý request 4 chặng** từ client tới backend và ngược lại.
- Phân biệt rạch ròi các kiểu **integration**: Lambda proxy, Lambda non-proxy, HTTP, AWS service, Mock — và biết khi nào ai phải map dữ liệu.
- Viết **mapping template VTL** cho integration request/response, dùng `$input`, `$context`, `$stageVariables`.
- Sử dụng **stages & stage variables** để quản lý môi trường và trỏ tới **Lambda alias**; thực hiện **deployment** và **canary deployment**.
- Cấu hình **models + request validation**, **gateway responses**, **binary media types**, và **import/export OpenAPI**.

## 34.1 API Gateway là gì và endpoint types

API Gateway là một **managed front door** (cửa ngõ được quản lý) cho API: nó nhận HTTP request từ client, làm các việc cross-cutting (xác thực, throttling, caching, transform, logging) rồi chuyển tiếp tới backend — thường là Lambda, nhưng cũng có thể là HTTP endpoint bất kỳ, một AWS service, hoặc trả mock. Bạn không phải tự dựng và scale một reverse proxy: API Gateway tự lo phần đó, tính tiền theo số request và lượng data (với REST API còn có option cache trả phí theo giờ).

Có ba "họ" API trong dịch vụ này, đề DVA hay gài:

| Loại API | Mục đích | Đặc điểm |
|---|---|---|
| **REST API** | API request/response truyền thống, nhiều tính năng nhất | Mapping template VTL, request validation, API keys/usage plans, caching, WAF... |
| **HTTP API** | API gọn nhẹ, rẻ hơn ~70%, độ trễ thấp | Ít tính năng hơn REST (chi tiết so sánh ở **Chương 35**) |
| **WebSocket API** | Two-way real-time (chat, notification) | Routes theo message, `@connections` (chi tiết ở **Chương 35**) |

Chương này tập trung vào **REST API** vì đó là nơi đề thi hỏi sâu nhất về integration và VTL.

Với mỗi REST API bạn chọn một **endpoint type** — quyết định DNS và đường đi của traffic:

- **Edge-optimized** (mặc định): request đi qua **CloudFront edge location** gần client nhất rồi mới về region chứa API. Tốt cho client phân tán toàn cầu. Lưu ý: CloudFront distribution này do AWS quản lý, không nằm trong account bạn.
- **Regional**: client gọi thẳng vào endpoint trong region, không qua CloudFront của AWS. Dùng khi client cùng region, hoặc khi bạn muốn **tự đặt CloudFront riêng** phía trước để kiểm soát cache/WAF.
- **Private**: API chỉ truy cập được **từ trong VPC** qua **interface VPC endpoint** (PrivateLink). Không expose ra internet. Dùng cho internal microservices.

> 💡 **Exam Tip:** "API chỉ được gọi từ bên trong VPC, không ra internet" → **Private endpoint** + interface VPC endpoint + resource policy giới hạn theo `aws:SourceVpce`. "Client toàn cầu, muốn giảm latency" → **Edge-optimized**. "Muốn tự gắn CloudFront/WAF riêng phía trước" → **Regional**.

Bạn có thể đổi endpoint type sau khi tạo, nhưng đó là thao tác thay đổi hạ tầng (đặc biệt edge ↔ regional làm đổi domain) nên thường gắn với re-deploy và cập nhật DNS.

## 34.2 Cấu trúc REST API: resources và methods

Một REST API được mô hình hóa thành **cây resource**. Mỗi resource là một path segment, ví dụ `/users`, `/users/{userId}`, `/users/{userId}/orders`. Phần `{userId}` là **path parameter** — bạn bắt được giá trị này trong integration.

Trên mỗi resource bạn định nghĩa **methods** (HTTP verb: GET, POST, PUT, DELETE, PATCH, hoặc `ANY` để bắt mọi verb). Mỗi method gắn với đúng một **integration** trỏ tới backend.

Có một resource đặc biệt là **greedy path / proxy resource**: `{proxy+}`. Nó bắt **mọi sub-path** còn lại. Ví dụ resource `/{proxy+}` với method `ANY` integration Lambda proxy sẽ chuyển *toàn bộ* `/a/b/c?x=1` vào một Lambda duy nhất — pattern phổ biến để đặt một framework (Express, Gin) sau API Gateway và để framework tự định tuyến.

Tạo nhanh một REST API bằng CLI:

```bash
# Tạo REST API regional
API_ID=$(aws apigateway create-rest-api \
  --name demo-api \
  --endpoint-configuration types=REGIONAL \
  --query 'id' --output text)

# Lấy root resource id ("/")
ROOT_ID=$(aws apigateway get-resources --rest-api-id $API_ID \
  --query 'items[?path==`/`].id' --output text)

# Tạo resource /users
USERS_ID=$(aws apigateway create-resource --rest-api-id $API_ID \
  --parent-id $ROOT_ID --path-part users --query 'id' --output text)

# Tạo method GET /users (chưa cần auth)
aws apigateway put-method --rest-api-id $API_ID --resource-id $USERS_ID \
  --http-method GET --authorization-type NONE
```

> 💡 **Exam Tip:** `{proxy+}` + method `ANY` + Lambda proxy = "catch-all", một Lambda nhận hết mọi route. Đề hay mô tả tình huống "deploy một app Express/Flask hiện có lên serverless với ít thay đổi nhất" → đây chính là đáp án.

## 34.3 Flow 4 chặng: method request → integration request → integration response → method response

Đây là **mô hình tinh thần quan trọng nhất** của REST API và là gốc của rất nhiều câu hỏi. Mỗi request đi qua bốn chặng:

```
Client
  │  (1) Method Request   ─ kiểm soát phía client: auth, validation,
  │                          required query/header/path, API key
  ▼
  │  (2) Integration Request ─ map dữ liệu client → backend:
  │                          chọn backend, mapping template VTL,
  │                          set header/path/query gửi đi backend
  ▼
Backend (Lambda/HTTP/AWS service/Mock)
  ▲
  │  (3) Integration Response ─ map dữ liệu backend → client:
  │                          mapping theo status, transform body,
  │                          set header trả về
  │
  │  (4) Method Response  ─ "hợp đồng" với client: khai báo status code,
  │                          response header, response model
  ▼
Client
```

- **Method Request** (chặng vào): nơi khai báo authorization type, có yêu cầu API key không, validate request không, và liệt kê các query string/header/path parameter "hợp lệ" (để dùng làm input mapping).
- **Integration Request**: chọn integration type + endpoint, và — với **non-proxy** — viết **mapping template** biến request thành đúng JSON backend cần.
- **Integration Response**: bắt response từ backend theo regex của status, áp mapping template để nặn thành body trả client, set header.
- **Method Response**: khai báo trước những status code có thể trả (200, 400, 500...) và các header/model tương ứng. Đây là "schema đầu ra".

Điểm mấu chốt đề thi: với **proxy integration**, các chặng (2) và (3) gần như **bị bỏ qua** — API Gateway truyền nguyên request vào và lấy nguyên response ra. Với **non-proxy integration**, bạn **phải tự cấu hình** mapping ở (2) và (3), nếu không backend sẽ nhận thiếu dữ liệu hoặc client nhận sai format.

> 💡 **Exam Tip:** "Lambda không nhận được query string / header / path parameter" trong khi code đọc `event.queryStringParameters` → khả năng cao integration đang là **non-proxy** và thiếu mapping template, hoặc ngược lại code viết cho non-proxy nhưng integration là proxy. Luôn khớp **kiểu integration** với **cách code đọc event**.

## 34.4 Integration types: Lambda proxy vs non-proxy, HTTP, AWS service, Mock

API Gateway hỗ trợ các integration type sau:

| Integration | Backend | Ai map request/response | Khi nào dùng |
|---|---|---|---|
| **Lambda proxy** (`AWS_PROXY`) | Lambda | API Gateway (tự động, format cố định) | Mặc định, đơn giản, để Lambda tự xử lý |
| **Lambda (non-proxy)** (`AWS`) | Lambda | Bạn (mapping template VTL) | Cần transform payload, ẩn cấu trúc backend |
| **HTTP proxy** (`HTTP_PROXY`) | HTTP endpoint bất kỳ | API Gateway (pass-through) | Đặt API Gateway trước service HTTP có sẵn |
| **HTTP (non-proxy)** (`HTTP`) | HTTP endpoint | Bạn | Transform khi gọi backend HTTP |
| **AWS** | Gọi thẳng AWS service API | Bạn | Gọi DynamoDB/SQS/SNS/Kinesis... không cần Lambda |
| **Mock** | Không có backend | Bạn (template tĩnh) | Trả response cố định, test, CORS preflight |

### Lambda proxy (`AWS_PROXY`)

Toàn bộ request được đóng gói thành một event JSON **format chuẩn** và đẩy vào Lambda. Lambda **bắt buộc** trả về đúng cấu trúc, nếu không API Gateway báo `502 Bad Gateway` (Malformed Lambda proxy response).

Event Lambda nhận (rút gọn):

```json
{
  "resource": "/users/{userId}",
  "path": "/users/42",
  "httpMethod": "GET",
  "headers": { "Host": "..." },
  "queryStringParameters": { "verbose": "true" },
  "pathParameters": { "userId": "42" },
  "requestContext": { "identity": { "sourceIp": "1.2.3.4" } },
  "body": "...",
  "isBase64Encoded": false
}
```

Handler bắt buộc trả đúng shape này:

```javascript
// Lambda proxy: phải trả statusCode + headers + body (string)
export const handler = async (event) => {
  const userId = event.pathParameters?.userId;       // "42"
  const verbose = event.queryStringParameters?.verbose; // "true"
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, verbose }), // body PHẢI là string
  };
};
```

Sai phổ biến: trả `body` là object (không `JSON.stringify`) → API Gateway báo malformed → client nhận `502`.

### Lambda non-proxy (`AWS`)

API Gateway gọi Lambda nhưng bạn **kiểm soát hoàn toàn** event đi vào và response đi ra qua mapping template. Lambda chỉ nhận đúng JSON bạn dựng trong integration request, và chỉ cần `return` một object thuần — API Gateway sẽ nặn lại ở integration response.

```javascript
// Lambda non-proxy: nhận đúng input từ mapping template, return object thuần
export const handler = async (event) => {
  // event đúng bằng JSON mà mapping template tạo ra, ví dụ { userId: "42" }
  return { id: event.userId, name: "Alice" };
};
```

Đổi lại sự gọn gàng đó, bạn phải tự cấu hình mapping (mục 34.5) và tự map error thành status code (qua **integration response** với regex trên error message).

### AWS service integration

API Gateway có thể gọi thẳng một AWS service mà **không cần Lambda** — ví dụ `PutItem` vào DynamoDB, `SendMessage` vào SQS. Bạn cấu hình một **IAM role** cho API Gateway assume, và viết mapping template tạo đúng payload của service đó. Pattern này giảm latency và bỏ được một lớp Lambda, thường xuất hiện trong câu hỏi "least operational overhead / không cần compute".

```bash
# Ví dụ method GET tích hợp thẳng DynamoDB Scan (AWS service integration)
aws apigateway put-integration --rest-api-id $API_ID --resource-id $USERS_ID \
  --http-method GET --type AWS \
  --integration-http-method POST \
  --uri arn:aws:apigateway:ap-southeast-1:dynamodb:action/Scan \
  --credentials arn:aws:iam::111122223333:role/APIGatewayDynamoDBRole
```

### Mock integration

Không có backend — API Gateway trả response từ chính mapping template tĩnh. Hữu ích để stub API khi backend chưa sẵn sàng, hoặc để xử lý **CORS preflight (OPTIONS)** trả header cố định (CORS chi tiết ở **Chương 35**).

> 💡 **Exam Tip:** "Trả về DynamoDB item trực tiếp, không dùng Lambda, ít chi phí vận hành nhất" → **AWS service integration** + IAM role + mapping template. "Lambda proxy trả body là JSON object" → lỗi `502`, phải `JSON.stringify`. "Stub endpoint không cần backend" → **Mock**.

## 34.5 Mapping template VTL: $input, $context, $stageVariables

Mapping template viết bằng **VTL (Velocity Template Language)**, dùng cho **non-proxy** integration để biến đổi payload. Có hai vị trí: **integration request** (client → backend) và **integration response** (backend → client). Mỗi template gắn với một **Content-Type** (ví dụ `application/json`).

Các biến chính:

- **`$input`**: truy cập request/response body.
  - `$input.json('$')` — lấy nguyên body JSON.
  - `$input.path('$.items[0].name')` — lấy giá trị theo JSONPath (trả object để duyệt tiếp).
  - `$input.params('userId')` — lấy param (path/query/header) theo tên.
- **`$context`**: thông tin runtime — `$context.requestId`, `$context.identity.sourceIp`, `$context.httpMethod`, `$context.stage`, `$context.authorizer.claims...`.
- **`$stageVariables`**: đọc stage variable (mục 34.6) — `$stageVariables.lambdaAlias`.
- **`$util`**: tiện ích — `$util.escapeJavaScript()`, `$util.parseJson()`, `$util.base64Encode()`.

Ví dụ integration request template biến request thành đúng input Lambda non-proxy cần:

```vtl
## Content-Type: application/json — integration request
{
  "userId": "$input.params('userId')",
  "sourceIp": "$context.identity.sourceIp",
  "stage": "$context.stage",
  "payload": $input.json('$')
}
```

Ví dụ integration response template nặn output backend thành body client:

```vtl
## Content-Type: application/json — integration response
#set($root = $input.path('$'))
{
  "id": "$root.id",
  "displayName": "$root.name"
}
```

Một bẫy về **passthrough behavior**: khi request tới với Content-Type **không khớp** template nào đã định nghĩa, hành vi phụ thuộc cấu hình `passthroughBehavior` — `WHEN_NO_MATCH` (mặc định, cho qua nếu không khớp), `WHEN_NO_TEMPLATES` (chỉ cho qua khi *không có* template nào), hoặc `NEVER` (từ chối với `415 Unsupported Media Type`). Đề thi đôi khi hỏi vì sao một request bị `415` — câu trả lời thường là `passthroughBehavior: NEVER` cộng Content-Type không khớp.

> 💡 **Exam Tip:** Mapping template chỉ áp dụng cho **non-proxy** (`AWS` / `HTTP`). Với **proxy** (`AWS_PROXY` / `HTTP_PROXY`), template bị bỏ qua hoàn toàn — đừng kỳ vọng VTL chạy. `$input.json('$')` lấy nguyên body; `$context` chứa identity/stage; `$stageVariables` để chọn backend theo môi trường.

## 34.6 Stages, deployments và stage variables

Một thay đổi cấu hình API (thêm method, đổi integration, sửa mapping) **không có hiệu lực** cho tới khi bạn tạo một **deployment** và gắn nó vào một **stage**. Đây là nguồn gốc của câu hỏi kinh điển: "developer sửa API nhưng client vẫn thấy hành vi cũ" → **chưa deploy**.

- **Deployment**: một snapshot bất biến của cấu hình API tại một thời điểm.
- **Stage**: một "phiên bản đang chạy" được đặt tên (`dev`, `test`, `prod`), trỏ tới một deployment. URL invoke có dạng:
  `https://{api-id}.execute-api.{region}.amazonaws.com/{stage}/{resource}`.

Bạn có thể có nhiều stage cùng lúc trỏ tới các deployment khác nhau — đó là cách tách dev/prod trên cùng một API.

```bash
# Tạo deployment và gắn vào stage prod
aws apigateway create-deployment --rest-api-id $API_ID --stage-name prod

# Cập nhật deployment cho stage dev
aws apigateway create-deployment --rest-api-id $API_ID --stage-name dev
```

### Stage variables — cấu hình theo môi trường

**Stage variables** là cặp key-value gắn vào *stage*, hoạt động như biến môi trường cho API. Dùng phổ biến để:

1. Trỏ integration tới **endpoint backend khác nhau** theo stage (ví dụ Lambda alias `dev` vs `prod`).
2. Truyền giá trị vào mapping template qua `$stageVariables`.

Pattern quan trọng nhất: kết hợp stage variable với **Lambda alias** (chi tiết alias/version ở **Chương 29**). Trong cấu hình integration URI bạn dùng biến:

```
arn:aws:lambda:region:acct:function:myFn:${stageVariables.lambdaAlias}
```

Sau đó stage `dev` đặt `lambdaAlias=dev`, stage `prod` đặt `lambdaAlias=prod`. Cùng một API, mỗi stage gọi đúng phiên bản Lambda của nó.

```bash
# Đặt stage variable lambdaAlias=prod cho stage prod
aws apigateway update-stage --rest-api-id $API_ID --stage-name prod \
  --patch-operations op=replace,path=/variables/lambdaAlias,value=prod
```

Bẫy IAM hay quên: khi dùng stage variable trỏ tới Lambda alias, bạn **phải cấp resource-based policy** (`lambda:InvokeFunction`) cho API Gateway trên *từng alias* — nếu chỉ cấp trên function gốc, gọi qua alias sẽ bị `Internal server error` / `403`.

> 💡 **Exam Tip:** Stage variables + `${stageVariables.x}` trong integration URI = một API phục vụ nhiều môi trường, mỗi stage trỏ Lambda alias riêng. Đừng quên cấp `lambda:InvokeFunction` cho từng alias. Và nhớ: sửa gì cũng phải **deploy** mới có tác dụng.

## 34.7 Canary deployment — chia traffic an toàn

Khi deploy phiên bản mới vào stage `prod`, bạn không muốn dồn 100% traffic ngay. **Canary deployment** của API Gateway cho phép định tuyến một **phần trăm traffic** sang phiên bản mới (canary) trong khi phần còn lại vẫn chạy phiên bản hiện tại (base), trên **cùng một stage**.

Cơ chế:

- Bạn bật canary trên stage với `percentTraffic` (ví dụ 10%).
- API Gateway có **hai bộ cấu hình** trên stage: deployment hiện tại và canary deployment.
- Stage variables cũng tách: stage variables thường và **canary stage variables** (`stageVariableOverrides`) — cho phép canary trỏ backend khác base.
- Theo dõi metric/log riêng cho canary, nếu ổn thì **promote** (canary thành base, 100%); nếu lỗi thì xóa canary, traffic về base.

```bash
# Bật canary 10% traffic trên stage prod
aws apigateway update-stage --rest-api-id $API_ID --stage-name prod \
  --patch-operations \
    op=replace,path=/canarySettings/percentTraffic,value=10.0

# Promote canary (đưa 100% sang canary) — thực hiện qua deployment + update canary
aws apigateway update-stage --rest-api-id $API_ID --stage-name prod \
  --patch-operations op=replace,path=/canarySettings/percentTraffic,value=100.0
```

> 💡 **Exam Tip:** **Canary deployment của API Gateway** chia traffic ở tầng *API Gateway stage* (base vs canary, có canary stage variables riêng). Khác với **canary/linear của CodeDeploy + Lambda alias** (chi tiết ở **Chương 41**) chia traffic ở tầng *Lambda alias*. Cả hai đều "shift traffic dần", nhưng đề phân biệt theo tầng nào điều khiển việc chia.

## 34.8 Models và request validation

API Gateway có thể **validate request ngay tại method request** trước khi gọi backend — chặn request rác ngay ở cửa, không tốn invocation Lambda. Có ba mức validation:

1. **Validate body** theo một **model** (JSON Schema).
2. **Validate required request parameters** (query string, header, path).
3. **Validate cả hai**.

**Model** là một định nghĩa JSON Schema gắn vào API, mô tả cấu trúc body hợp lệ. Khi gắn model vào method request và bật validator, request body sai schema sẽ bị trả `400 Bad Request` mà *không* tới backend.

```bash
# Tạo model User (JSON Schema draft-04)
aws apigateway create-model --rest-api-id $API_ID \
  --name User --content-type application/json \
  --schema '{
    "$schema": "http://json-schema.org/draft-04/schema#",
    "title": "User",
    "type": "object",
    "required": ["name", "email"],
    "properties": {
      "name":  { "type": "string", "minLength": 1 },
      "email": { "type": "string" }
    }
  }'

# Tạo request validator (validate cả body + parameters)
VALIDATOR_ID=$(aws apigateway create-request-validator --rest-api-id $API_ID \
  --name validate-all --validate-request-body --validate-request-parameters \
  --query 'id' --output text)
```

Lợi ích kép: giảm tải backend, trả lỗi sớm và nhất quán, và model cũng dùng để **generate SDK** và sinh tài liệu. Hạn chế: validation của API Gateway chỉ ở mức JSON Schema (kiểu, required, pattern, range) — logic nghiệp vụ phức tạp vẫn phải ở backend.

> 💡 **Exam Tip:** "Chặn request body sai format trước khi tốn tiền gọi Lambda, ít code nhất" → **request validation + model (JSON Schema)** tại method request, trả `400`. Đây là cách rẻ và nhanh hơn validate trong Lambda. Lưu ý request validation chỉ áp dụng cho **REST API**.

## 34.9 Gateway responses, binary media types và import/export OpenAPI

### Gateway responses

**Gateway responses** là các response do **chính API Gateway** sinh ra *trước khi* (hoặc thay vì) gọi backend — ví dụ `4xx`/`5xx` khi: thiếu authentication (`UNAUTHORIZED`), bị throttle (`THROTTLED`), request không validate được (`BAD_REQUEST_BODY`), không tìm thấy resource (`RESOURCE_NOT_FOUND`), `DEFAULT_4XX`, `DEFAULT_5XX`... Bạn có thể **customize** status code, body và header của chúng. Đây là chỗ thường được dùng để **thêm CORS header vào response lỗi** (vì lỗi do gateway sinh sẽ không qua integration response của bạn — chi tiết CORS ở **Chương 35**).

```bash
# Thêm CORS header vào gateway response mặc định cho lỗi 4xx
aws apigateway put-gateway-response --rest-api-id $API_ID \
  --response-type DEFAULT_4XX \
  --response-parameters '{"gatewayresponse.header.Access-Control-Allow-Origin":"'"'"'*'"'"'"}'
```

### Binary media types

Mặc định API Gateway xử lý payload như **text/UTF-8**. Để truyền **binary** (ảnh, PDF, file nén), bạn khai báo **binary media types** trên API (ví dụ `image/png`, `application/octet-stream`, hoặc `*/*`). Khi đó:

- API Gateway quyết định encode/decode dựa trên header `Content-Type` (request) và `Accept` (response) so với danh sách binary media types.
- Với **Lambda proxy**, bạn set `isBase64Encoded: true` và đặt `body` là chuỗi **base64**; API Gateway sẽ giải mã về binary cho client. Chiều vào cũng tương tự: binary request được base64-encode trước khi đẩy vào Lambda.
- Có cài đặt **`contentHandling`** trên integration: `CONVERT_TO_BINARY` hoặc `CONVERT_TO_TEXT` để ép chuyển đổi.

> 💡 **Exam Tip:** Trả ảnh/file từ Lambda qua API Gateway mà client nhận file hỏng → thiếu khai báo **binary media types** trên API và/hoặc quên `isBase64Encoded: true` + `body` base64. Dùng `*/*` cho binary media types là cách "bắt hết" nhanh nhưng nhớ test cả text.

### Import/export OpenAPI (Swagger)

Toàn bộ định nghĩa REST API có thể **import từ** và **export ra** file **OpenAPI 2.0 (Swagger) / 3.0**. AWS dùng các extension `x-amazon-apigateway-*` để mô tả phần riêng của API Gateway (integration, authorizer, request validator...). Đây là cách versioning API bằng code và tái tạo API qua môi trường.

```bash
# Import định nghĩa API từ file OpenAPI
aws apigateway import-rest-api --body fileb://openapi.yaml

# Export stage prod ra OpenAPI 3.0 kèm extension AWS
aws apigateway get-export --rest-api-id $API_ID --stage-name prod \
  --export-type oas30 --parameters extensions=integrations \
  openapi-export.json
```

> 💡 **Exam Tip:** "Tái tạo y hệt một API ở region/account khác, hoặc quản lý API như code" → **export/import OpenAPI** (với `x-amazon-apigateway-integration` cho phần integration). Đây cũng là cách nhanh để bootstrap một API từ spec có sẵn thay vì click từng resource.
