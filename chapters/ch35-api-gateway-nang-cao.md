# Chương 35: Amazon API Gateway nâng cao

> **Trọng tâm DVA-C02:** Đây là một trong những chương "nặng điểm" nhất của domain Security (26%) và Development (32%). Đề hay hỏi: chọn cơ chế auth nào cho từng tình huống (IAM/SigV4 vs Lambda authorizer vs Cognito User Pools), thứ tự cấu hình Usage Plan + API Key (câu hỏi kinh điển dễ sai), throttling 429 đến từ đâu, caching ở stage level, CORS preflight bị lỗi, và khi nào chọn HTTP API thay vì REST API. WebSocket API và custom domain + mutual TLS cũng xuất hiện dạng câu tình huống.

## Mục tiêu chương
- Phân biệt và chọn đúng 3 cơ chế authentication/authorization: IAM (SigV4), Lambda authorizer (TOKEN vs REQUEST, caching), Cognito User Pools authorizer.
- Hiểu resource policy để tạo private API, IP allowlist, cross-account access và cách nó kết hợp với IAM auth.
- Cấu hình Usage Plan + API Key đúng thứ tự, hiểu mô hình throttling nhiều tầng (account → stage → method → per-key) và mã 429.
- Bật caching ở stage, cấu hình TTL, cache key theo parameter, invalidation và encryption.
- Xử lý CORS đúng cách (proxy vs non-proxy, preflight OPTIONS).
- Giám sát bằng CloudWatch metrics (4XX/5XX/Latency/IntegrationLatency/CacheHitCount), access logs và X-Ray.
- Xây WebSocket API (routes, connection lifecycle, @connections callback) và so sánh HTTP API vs REST API.
- Cấu hình custom domain name + ACM và mutual TLS (mTLS).

## 35.1 Authentication & Authorization: ba cơ chế và cách chọn

API Gateway REST API hỗ trợ nhiều cách kiểm soát ai được gọi method. Ba cơ chế trọng tâm thi:

**1. IAM authorization (SigV4).** Caller phải ký request bằng AWS Signature Version 4 với access key/secret (hoặc temporary credentials từ STS). API Gateway xác thực chữ ký rồi đánh giá IAM policy của caller xem có quyền `execute-api:Invoke` trên ARN của method không. Dùng khi caller là dịch vụ AWS khác, ứng dụng nội bộ có IAM credentials, hoặc identity từ Cognito Identity Pool (cấp credentials tạm — chi tiết ở Chương 39). Ưu điểm: không cần code, tận dụng IAM. Nhược: client phải biết ký SigV4 (khó cho browser/mobile thuần).

**2. Lambda authorizer (trước đây gọi custom authorizer).** Một Lambda function bạn viết, nhận token/request, trả về IAM policy (Allow/Deny) cộng `principalId` và optional `context`. Dùng khi auth dùng bearer token bên thứ ba (OAuth, JWT của hệ thống riêng), hoặc logic ủy quyền phức tạp. Có 2 loại:
- **TOKEN authorizer:** lấy token từ một header duy nhất (ví dụ `Authorization`). Cấu hình `identitySource` = `method.request.header.Authorization`.
- **REQUEST authorizer:** nhận toàn bộ ngữ cảnh request (headers, query string, path, stage variables, context). Dùng khi cần nhiều nguồn để quyết định.

**3. Cognito User Pools authorizer.** API Gateway tự verify JWT (ID hoặc access token) do Cognito User Pool phát hành, không cần code. Bạn gắn User Pool làm authorizer, client gửi token qua header (mặc định `Authorization`). Dùng khi đã có User Pool quản lý đăng nhập (chi tiết User Pool ở Chương 38).

Bảng chọn nhanh:

| Tiêu chí | IAM (SigV4) | Lambda authorizer | Cognito User Pools |
|---|---|---|---|
| Caller điển hình | AWS service, app có IAM creds, Identity Pool | Bất kỳ (bearer token bên thứ 3, OAuth) | App dùng User Pool đăng nhập |
| Viết code | Không | Có (Lambda) | Không |
| Token | SigV4 signature | Tùy bạn (JWT, opaque...) | Cognito JWT (ID/access) |
| Caching kết quả auth | N/A | Có (TTL tới 3600s) | Không cấu hình riêng (verify mỗi request) |
| Linh hoạt logic | Thấp (IAM policy) | Cao nhất | Trung bình |
| Chi phí thêm | Không | Lambda invocation | Không |

> 💡 **Exam Tip:** Tình huống "công ty đã có Cognito User Pool, muốn bảo vệ REST API với ít code nhất" → Cognito User Pools authorizer. Tình huống "token JWT do hệ thống bên thứ ba phát, cần logic kiểm tra tùy biến" → Lambda authorizer (REQUEST hoặc TOKEN). Tình huống "service-to-service trong AWS" → IAM/SigV4.

## 35.2 Lambda authorizer: cơ chế output policy và caching

Lambda authorizer phải trả về một object đúng định dạng. Với TOKEN authorizer điển hình:

```javascript
// Lambda authorizer (Node.js, SDK v3 không bắt buộc — chỉ trả object)
export const handler = async (event) => {
  // event.authorizationToken với TOKEN type, hoặc event.headers với REQUEST type
  const token = event.authorizationToken; // ví dụ "Bearer abc123"
  const methodArn = event.methodArn;      // arn:aws:execute-api:region:acct:apiId/stage/METHOD/resourcePath

  // Tự verify token (gọi JWKS, kiểm chữ ký...) — ở đây minh hoạ đơn giản
  const effect = token === "Bearer allow-me" ? "Allow" : "Deny";

  return {
    principalId: "user-123",              // định danh caller
    policyDocument: {
      Version: "2012-10-17",
      Statement: [{
        Action: "execute-api:Invoke",
        Effect: effect,
        Resource: methodArn               // hoặc wildcard để cache dùng chung nhiều method
      }]
    },
    context: {                            // truyền xuống integration qua $context.authorizer.*
      org: "acme",
      tier: "gold"
    }
  };
};
```

Cơ chế caching rất hay bị hỏi: API Gateway cache **policy trả về** theo key là giá trị `identitySource` (ví dụ chính token), với TTL cấu hình bởi **Authorizer TTL** (mặc định 300s, tối đa 3600s, đặt 0 để tắt cache). Khi cache còn hiệu lực, request có cùng token sẽ **không** gọi lại Lambda authorizer — tiết kiệm tiền và độ trễ.

Bẫy thực tế: nếu authorizer trả `Resource` là ARN cụ thể của một method, mà bạn bật cache, thì policy cache lại được áp cho **mọi** method (vì cache theo token, không theo method ARN). Caller có token hợp lệ cho `/orders` có thể vô tình được Allow ở `/admin` nếu policy cache dùng wildcard. Giải pháp: trả `Resource` dạng wildcard chính xác bạn muốn, hoặc tắt cache nếu logic per-method khác nhau.

Giá trị `context` (chỉ string/number/boolean, KHÔNG nhận object/array lồng) được truyền vào integration qua mapping template `$context.authorizer.org` hoặc với Lambda proxy là `event.requestContext.authorizer.org`. Đây là cách "đẩy" thông tin đã xác thực (tenant, role) xuống backend mà không cần verify lại.

> 💡 **Exam Tip:** Lambda authorizer cache theo `identitySource`. Nếu API trả 403 cho user vừa bị thu hồi quyền nhưng token cũ vẫn còn trong TTL → giảm Authorizer TTL hoặc đặt 0. Với REQUEST authorizer, identitySource có thể gồm nhiều thành phần (header + query), cache key là tổ hợp tất cả.

## 35.3 Resource policies: private API, IP allowlist, cross-account

Resource policy là JSON policy gắn trực tiếp lên API (giống bucket policy của S3), quyết định ai được invoke trước cả khi authorizer chạy. Ba use case chính:

**IP allowlist / denylist:** dùng condition `aws:SourceIp`.

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": "*",
    "Action": "execute-api:Invoke",
    "Resource": "arn:aws:execute-api:ap-southeast-1:111122223333:abc123/*/*/*"
  }, {
    "Effect": "Deny",
    "Principal": "*",
    "Action": "execute-api:Invoke",
    "Resource": "arn:aws:execute-api:ap-southeast-1:111122223333:abc123/*/*/*",
    "Condition": { "NotIpAddress": { "aws:SourceIp": ["203.0.113.0/24"] } }
  }]
}
```

**Cross-account access:** đặt `Principal` là ARN của account/role được phép gọi, kết hợp method dùng IAM auth.

**Private API:** API endpoint type = PRIVATE, chỉ truy cập được qua **Interface VPC Endpoint** (`execute-api`). Resource policy bắt buộc phải allow `aws:SourceVpce` (hoặc `aws:SourceVpc`) của endpoint đó, nếu không mọi request đều 403.

```json
{
  "Effect": "Allow",
  "Principal": "*",
  "Action": "execute-api:Invoke",
  "Resource": "...",
  "Condition": { "StringEquals": { "aws:SourceVpce": "vpce-1a2b3c4d" } }
}
```

Bẫy: với private API, sau khi sửa resource policy bạn phải **deploy lại** (redeploy stage) thì policy mới có hiệu lực — quên bước này là lỗi kinh điển. Ngoài ra, kết hợp resource policy với IAM/Lambda authorizer tuân theo logic: nếu cả hai đều phải Allow thì request mới qua; resource policy Deny luôn thắng.

> 💡 **Exam Tip:** "API chỉ được gọi từ trong VPC, không qua internet" → Private REST API + Interface VPC Endpoint + resource policy lọc `aws:SourceVpce`. Đừng nhầm với edge-optimized/regional (đều public).

## 35.4 Usage Plans & API Keys — thứ tự cấu hình đúng (câu hỏi kinh điển)

API Key dùng để định danh và đo lường client (B2B partner, các tier khác nhau), KHÔNG phải để xác thực bảo mật — đừng dùng API key thay cho auth thật. Usage Plan gắn throttling và quota cho từng key.

**Thứ tự cấu hình ĐÚNG (rất hay bị hỏi):**
1. Bật **API Key Required** trên từng method (`apiKeyRequired: true`).
2. Deploy API tới một **stage**.
3. Tạo **Usage Plan**, đặt throttle (rate + burst) và quota (ví dụ 10.000 request/tháng).
4. **Associate stage** vào usage plan (gắn API + stage cụ thể).
5. Tạo **API Key**.
6. **Add API key vào usage plan** (gắn key với plan).
7. Client gửi key qua header `x-api-key`.

Nếu thiếu bước "associate stage vào usage plan" hoặc "add key vào plan", client gửi key vẫn bị 403 (Forbidden) vì key chưa liên kết với plan/stage.

```bash
# Tạo usage plan với throttle & quota
aws apigateway create-usage-plan \
  --name "gold-tier" \
  --throttle rateLimit=100,burstLimit=200 \
  --quota limit=1000000,period=MONTH \
  --api-stages apiId=abc123,stage=prod

# Tạo API key
aws apigateway create-api-key --name "partner-acme" --enabled

# Gắn key vào usage plan
aws apigateway create-usage-plan-key \
  --usage-plan-id usageplan-xyz \
  --key-id apikey-123 \
  --key-type API_KEY
```

API key có thể lấy theo nhiều nguồn (`apiKeySourceType`): `HEADER` (mặc định, `x-api-key`) hoặc `AUTHORIZER` (Lambda authorizer trả về `usageIdentifierKey`). Cái sau dùng khi muốn dùng chính token đã verify làm định danh usage plan.

> 💡 **Exam Tip:** Quota là per-key (theo DAY/WEEK/MONTH). Throttle trong usage plan là per-key. Khi client vượt quota → 429 với message khác throttling. Nhớ: API key KHÔNG mã hóa/bảo mật — luôn kèm authorizer hoặc IAM nếu cần bảo vệ thật.

## 35.5 Throttling nhiều tầng và mã 429

API Gateway throttle theo mô hình **token bucket** với hai tham số: **rate** (số request ổn định/giây, steady-state) và **burst** (dung lượng bucket, số request đồng thời tối đa trong một thời điểm). Các tầng throttle, áp dụng theo thứ tự ưu tiên từ cụ thể đến chung:

1. **Per-client per-method** (trong usage plan, method-level override) — cụ thể nhất.
2. **Per-client** (usage plan rate/burst cho key).
3. **Per-method** (stage-level method throttling).
4. **Stage-level** default.
5. **Account-level**: mặc định **10.000 rps** và **burst 5.000** cho mỗi region (soft limit, xin tăng được).

Khi vượt → HTTP **429 Too Many Requests** với header và body chỉ ra throttling. Client nên retry với exponential backoff.

```bash
# Đặt throttle ở stage + override per-method
aws apigateway update-stage \
  --rest-api-id abc123 --stage-name prod \
  --patch-operations \
    op=replace,path=/throttle/rateLimit,value=500 \
    op=replace,path=/throttle/burstLimit,value=1000 \
    op=replace,path=/~1orders/GET/throttle/rateLimit,value=50
```

Bẫy hay gặp: account-level 10.000 rps là **dùng chung** cho tất cả API trong region của account. Một API "ăn" hết quota có thể làm API khác bị 429. Khi thấy 429 mà không cấu hình usage plan nào → nghĩ tới account-level limit hoặc một API khác đang ngốn.

Burst vs rate hay nhầm: với rate=100, burst=200, client có thể gửi một "đợt" tối đa 200 request gần như tức thời (xài hết bucket), nhưng tốc độ nạp lại bucket là 100 token/giây. Gửi liên tục >100 rps sẽ dần cạn bucket và bị 429. Đây là lý do một spike ngắn vẫn qua được dù rate thấp.

> 💡 **Exam Tip:** Phân biệt 429 (throttling/quota — do API Gateway, client cần backoff) với 504 Integration Timeout (backend chậm, REST API max integration timeout 29 giây — không nâng được cao hơn). Đề rất hay gài 504: Lambda chạy 40 giây → API Gateway vẫn cắt ở 29 giây. Lưu ý cập nhật: integration timeout của REST API có thể nâng quá 29 giây qua quota request riêng, nhưng mặc định và mức đề thi vẫn nhớ là 29 giây.

## 35.6 Caching ở stage level

API Gateway REST API có thể bật **cache** ở mức stage để giảm số lần gọi backend. Đặc điểm và limit cần nhớ:

- Cache **per-stage**, dung lượng chọn từ **0.5GB đến 237GB**.
- **Default TTL 300 giây**, cấu hình từ **0 đến 3600 giây**. TTL = 0 nghĩa là tắt cache cho response đó.
- Cache key mặc định là toàn bộ request; bạn chọn parameter (path/query/header) làm **cache key** để cache theo từng giá trị (đánh dấu parameter là "cache key").
- Có thể bật **encrypt cache data**.
- **Invalidation:** client gửi header `Cache-Control: max-age=0` để buộc bỏ qua cache cho request đó — nhưng phải cấp quyền `execute-api:InvalidateCache` qua resource policy, nếu không cấu hình "require authorization" thì bất kỳ ai cũng có thể invalidate (gây tốn backend).
- Caching là **per-method**: bật ở stage rồi override từng method (GET nên cache, POST/PUT/DELETE thường không).

```bash
# Bật cache 1.6GB, TTL 600s, mã hoá
aws apigateway update-stage \
  --rest-api-id abc123 --stage-name prod \
  --patch-operations \
    op=replace,path=/cacheClusterEnabled,value=true \
    op=replace,path=/cacheClusterSize,value=1.6 \
    op=replace,path=/~1products/GET/caching/enabled,value=true \
    op=replace,path=/~1products/GET/caching/ttlInSeconds,value=600 \
    op=replace,path=/~1products/GET/caching/dataEncrypted,value=true
```

Bẫy: cache có chi phí riêng theo giờ (không nằm trong free tier). Và nếu không chọn cache key đúng (ví dụ quên thêm query `?category=` vào cache key), mọi user nhận chung một response cache sai.

> 💡 **Exam Tip:** "Giảm tải backend cho endpoint GET đọc nhiều, dữ liệu ít đổi" → bật stage cache + chọn cache key phù hợp + TTL. Metric `CacheHitCount` và `CacheMissCount` cho biết hiệu quả cache.

## 35.7 CORS trong API Gateway

CORS (Cross-Origin Resource Sharing) cần khi web app ở domain A gọi API ở domain B. Browser gửi **preflight OPTIONS** request trước, server phải trả `Access-Control-Allow-Origin`, `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers`.

- **Non-proxy / mock integration:** API Gateway tự tạo được method OPTIONS với mapping template trả các header CORS — "Enable CORS" trong console làm việc này.
- **Lambda proxy integration:** "Enable CORS" trong console **chỉ** tạo method OPTIONS (preflight). Còn các header CORS cho request thực (GET/POST...) **phải do Lambda tự trả về** trong response, vì với proxy integration API Gateway truyền nguyên response của Lambda.

```javascript
// Lambda proxy: phải tự thêm header CORS
export const handler = async () => ({
  statusCode: 200,
  headers: {
    "Access-Control-Allow-Origin": "https://app.example.com",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  },
  body: JSON.stringify({ ok: true })
});
```

Bẫy kinh điển: developer "Enable CORS" trong console với Lambda proxy nhưng quên thêm header trong code Lambda → preflight OK nhưng request thực bị browser chặn vì thiếu `Access-Control-Allow-Origin`. Lỗi hiện ở browser console chứ không phải lỗi 4xx của API.

> 💡 **Exam Tip:** Với **HTTP API**, CORS cấu hình tập trung ở API level (`corsConfiguration`) — đơn giản hơn REST API nhiều. Đề có thể dùng điều này làm lý do chọn HTTP API.

## 35.8 Monitoring: CloudWatch metrics, access logs, X-Ray

API Gateway phát các metric vào namespace `AWS/ApiGateway` (dimension `ApiName`, `Stage`, optionally `Method`/`Resource`):

| Metric | Ý nghĩa | Điểm chú ý |
|---|---|---|
| `Count` | Tổng số request | Tính throughput |
| `4XXError` | Lỗi phía client (400, 403, 429...) | Auth sai, throttle |
| `5XXError` | Lỗi phía server gateway | Integration lỗi/timeout |
| `Latency` | Thời gian từ nhận request → trả response (gồm cả integration) | Trải nghiệm end-to-end |
| `IntegrationLatency` | Chỉ thời gian backend xử lý | So với Latency để biết nghẽn ở đâu |
| `CacheHitCount` / `CacheMissCount` | Hiệu quả cache | Tối ưu cache key/TTL |

Cách đọc: nếu `Latency` cao mà `IntegrationLatency` cũng cao → backend chậm. Nếu `Latency` cao nhưng `IntegrationLatency` thấp → nghẽn ở chính API Gateway (ví dụ authorizer, mapping).

**Execution logs** (ghi chi tiết request flow vào CloudWatch Logs) bật ở stage qua log level ERROR/INFO — cần một IAM role cấp account cho API Gateway ghi log (`AmazonAPIGatewayPushToCloudWatchLogs`). **Access logs** là log có cấu trúc bạn tự định nghĩa format bằng `$context` variables, ghi vào một log group riêng:

```bash
aws apigateway update-stage \
  --rest-api-id abc123 --stage-name prod \
  --patch-operations \
    op=replace,path=/accessLogSettings/destinationArn,value=arn:aws:logs:ap-southeast-1:111122223333:log-group:apigw-access \
    op=replace,path=/accessLogSettings/format,value='{"requestId":"$context.requestId","ip":"$context.identity.sourceIp","status":"$context.status","latency":"$context.responseLatency"}'
```

**X-Ray:** bật active tracing ở stage để API Gateway tạo trace segment, nối với segment của Lambda/backend → xem service map (chi tiết X-Ray ở Chương 26). Lưu ý: X-Ray tracing cho API Gateway chỉ hỗ trợ REST API (không phải HTTP API/WebSocket theo cùng cách).

> 💡 **Exam Tip:** Để debug "request chậm", so sánh `Latency` vs `IntegrationLatency`. Để biết "ai gọi, status gì" dùng access logs với `$context`. Execution logs vs access logs: execution = chi tiết internal flow (debug), access = bản ghi gọn từng request (audit/phân tích).

## 35.9 WebSocket APIs

WebSocket API cho phép giao tiếp 2 chiều, server chủ động đẩy message tới client (chat, real-time dashboard, ticker). Khác REST: định tuyến theo **route** dựa trên **route selection expression** (ví dụ `$request.body.action`).

Ba route đặc biệt (predefined):
- **`$connect`** — chạy khi client mở kết nối (nơi xác thực, lưu `connectionId` vào DynamoDB).
- **`$disconnect`** — khi client đóng (dọn `connectionId`). Best-effort, không đảm bảo luôn chạy.
- **`$default`** — khi không khớp route nào.

Cùng custom routes như `sendmessage`, `subscribe`...

Mỗi kết nối có **`connectionId`** duy nhất (lấy từ `event.requestContext.connectionId`). Để server gửi message ngược về client, gọi **@connections** callback API qua endpoint `https://{api-id}.execute-api.{region}.amazonaws.com/{stage}`:

```javascript
import { ApiGatewayManagementApiClient, PostToConnectionCommand }
  from "@aws-sdk/client-apigatewaymanagementapi";

export const handler = async (event) => {
  const { domainName, stage, connectionId } = event.requestContext;
  const client = new ApiGatewayManagementApiClient({
    endpoint: `https://${domainName}/${stage}`   // endpoint @connections
  });
  // Đẩy dữ liệu về client đang kết nối
  await client.send(new PostToConnectionCommand({
    ConnectionId: connectionId,
    Data: Buffer.from(JSON.stringify({ msg: "hello" }))
  }));
  return { statusCode: 200 };
};
```

Nếu client đã ngắt, `PostToConnection` trả **410 Gone** → backend nên xoá `connectionId` khỏi store. Auth cho WebSocket thường gắn Lambda/IAM authorizer ở route `$connect`. Limit cần nhớ: idle connection timeout **10 phút**, connection duration tối đa **2 giờ**.

Pattern điển hình cho chat/broadcast: ở `$connect` lưu `connectionId` vào DynamoDB (kèm userId/room); khi có message cần broadcast, Scan/Query lấy danh sách connectionId của room rồi `PostToConnection` cho từng cái, bắt 410 để xoá connection chết. Route khác `$connect/$disconnect/$default` được chọn theo `routeSelectionExpression`, ví dụ `$request.body.action` khớp với field `action` trong JSON client gửi lên.

> 💡 **Exam Tip:** "Server cần đẩy thông báo real-time tới nhiều client browser" → WebSocket API + lưu connectionId + PostToConnection. Đừng nhầm với SNS (push tới endpoint đã đăng ký) hay polling REST. Quyền gọi @connections cần action `execute-api:ManageConnections` trong IAM role của Lambda.

## 35.10 HTTP API vs REST API & custom domain + mTLS

**HTTP API** là phiên bản gọn, rẻ, độ trễ thấp hơn, ra sau REST API. So sánh trọng tâm thi:

| Tính năng | REST API | HTTP API |
|---|---|---|
| Giá | Cao hơn | Rẻ hơn ~70% |
| Độ trễ | Cao hơn | Thấp hơn |
| Lambda/HTTP proxy | Có | Có |
| Auth JWT (Cognito/OIDC) native | Qua Cognito authorizer | JWT authorizer built-in (OIDC, Cognito) |
| Lambda authorizer | Có | Có (kể cả simple response) |
| IAM auth | Có | Có |
| API keys & usage plans | Có | **Không** |
| Request/response mapping (VTL) | Có | **Không** |
| Caching | Có | **Không** |
| Private endpoint | Có | Không (chỉ regional) |
| Edge-optimized | Có | Không |
| WebSocket | Riêng (WebSocket API) | Không |
| X-Ray | Có | Không |

Chọn **HTTP API** khi cần proxy đơn giản tới Lambda/HTTP backend, dùng JWT auth, ưu tiên chi phí và độ trễ. Chọn **REST API** khi cần API keys/usage plans, caching, request validation/VTL mapping, private endpoint, hoặc edge-optimized.

> 💡 **Exam Tip:** Câu "cần API keys + usage plans cho đối tác" hoặc "cần caching ở gateway" hoặc "cần private API trong VPC" → bắt buộc REST API (HTTP API không có những thứ này). Câu "least cost, lowest latency, chỉ proxy Lambda với JWT" → HTTP API.

**Custom domain name + ACM:** thay vì `https://abc123.execute-api...`, bạn dùng `api.example.com`. Cần một chứng chỉ ACM:
- **Edge-optimized** custom domain → chứng chỉ phải ở **us-east-1** (vì dùng CloudFront).
- **Regional** custom domain → chứng chỉ ở **cùng region** với API.

Sau khi tạo custom domain, bạn map **base path** tới (API, stage) qua API mappings, rồi trỏ DNS (Route 53 alias) tới target domain name của custom domain. (ACM chi tiết ở Chương 48, Route 53 alias ở Chương 10.)

**Mutual TLS (mTLS):** bật trên custom domain để **client cũng phải xuất trình chứng chỉ** (2 chiều), không chỉ server. Dùng cho B2B/IoT yêu cầu xác thực mạnh phía client. Cấu hình: upload một **truststore** (bundle CA chứng chỉ tin cậy) lên S3, trỏ custom domain tới đó. mTLS chỉ hỗ trợ trên **regional** custom domain (REST và HTTP API), không cho edge-optimized.

```bash
# Tạo regional custom domain với mTLS
aws apigateway create-domain-name \
  --domain-name api.example.com \
  --regional-certificate-arn arn:aws:acm:ap-southeast-1:111122223333:certificate/abc \
  --endpoint-configuration types=REGIONAL \
  --mutual-tls-authentication truststoreUri=s3://my-truststore/ca-bundle.pem
```

> 💡 **Exam Tip:** mTLS = client xuất trình cert (xác thực client mạnh, ví dụ partner/IoT). Yêu cầu **regional** custom domain + truststore trên S3. Edge-optimized custom domain dùng ACM ở **us-east-1**; regional dùng ACM **cùng region**. Đây là cặp số liệu hay bị hỏi.

---

## Hands-on Lab: Bảo vệ REST API với Lambda authorizer, usage plan + API key, throttling và caching

**Mục tiêu lab:** Dựng một REST API có một Lambda backend, gắn **Lambda authorizer** kiểu `TOKEN` (kiểm tra Bearer token, trả về IAM policy + cache theo TTL), tạo **usage plan + API key** theo đúng thứ tự cấu hình mà đề thi hay gài, bật **method throttling** và **stage caching**, rồi quan sát CloudWatch metrics. Lab làm hoàn toàn bằng AWS CLI v2 để bạn nắm cơ chế bên dưới console.

**Chuẩn bị:**
- AWS CLI v2 đã cấu hình profile có quyền `apigateway:*`, `lambda:*`, `iam:CreateRole/AttachRolePolicy`, `logs:*`.
- Region xuyên suốt: `ap-southeast-1`.
- `jq` để lọc JSON cho gọn (không bắt buộc nhưng tiện).

```bash
export AWS_REGION="ap-southeast-1"
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
```

### Bước 1: Tạo Lambda backend và Lambda authorizer

Tạo IAM role cho Lambda trước (cả backend và authorizer dùng chung role học tập này):

```bash
cat > trust.json <<'EOF'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}
EOF
ROLE_ARN=$(aws iam create-role --role-name dva-ch35-lambda-role \
  --assume-role-policy-document file://trust.json --query Role.Arn --output text)
aws iam attach-role-policy --role-name dva-ch35-lambda-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
sleep 10   # chờ IAM role propagate, nếu vội sẽ bị InvalidParameterValueException
```

Backend function (trả về JSON đơn giản):

```bash
mkdir -p fn && cat > fn/backend.mjs <<'EOF'
export const handler = async (event) => ({
  statusCode: 200,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ message: "Hello from backend", caller: event.requestContext?.authorizer?.principalId })
});
EOF
(cd fn && zip -q backend.zip backend.mjs)
BACKEND_ARN=$(aws lambda create-function --function-name dva-ch35-backend \
  --runtime nodejs20.x --handler backend.handler --role "$ROLE_ARN" \
  --zip-file fileb://fn/backend.zip --query FunctionArn --output text)
```

Authorizer function — kiểu `TOKEN`: nhận token ở header `Authorization`, trả về IAM policy `Allow`/`Deny`. Đây là cơ chế cốt lõi: authorizer KHÔNG trả `true/false` mà trả một **IAM policy document** API Gateway dùng để cho/chặn truy cập.

```bash
cat > fn/authz.mjs <<'EOF'
export const handler = async (event) => {
  const token = event.authorizationToken; // "Bearer xxx"
  const effect = token === "Bearer let-me-in" ? "Allow" : "Deny";
  return {
    principalId: "user-123",
    policyDocument: {
      Version: "2012-10-17",
      Statement: [{ Action: "execute-api:Invoke", Effect: effect, Resource: event.methodArn }]
    },
    context: { tier: "gold" } // truyền xuống backend qua $context.authorizer.tier
  };
};
EOF
(cd fn && zip -q authz.zip authz.mjs)
AUTHZ_ARN=$(aws lambda create-function --function-name dva-ch35-authz \
  --runtime nodejs20.x --handler authz.handler --role "$ROLE_ARN" \
  --zip-file fileb://fn/authz.zip --query FunctionArn --output text)
```

> Bẫy: trả `Resource: event.methodArn` nghĩa là policy chỉ áp cho đúng method đang gọi. Nếu bạn bật authorizer caching (TTL > 0) mà trả wildcard `arn:.../*`, một token cache lại được áp cho mọi route — vừa là tính năng vừa là lỗ hổng tuỳ ý đồ.

### Bước 2: Tạo REST API, resource, method và integration

```bash
API_ID=$(aws apigateway create-rest-api --name dva-ch35-api \
  --endpoint-configuration types=REGIONAL --query id --output text)
ROOT_ID=$(aws apigateway get-resources --rest-api-id "$API_ID" \
  --query 'items[0].id' --output text)
RES_ID=$(aws apigateway create-resource --rest-api-id "$API_ID" \
  --parent-id "$ROOT_ID" --path-part hello --query id --output text)
```

Tạo authorizer (request tới Lambda authorizer, cache 300 giây theo `identitySource`):

```bash
AUTHORIZER_ID=$(aws apigateway create-authorizer --rest-api-id "$API_ID" \
  --name lambda-token-authz --type TOKEN \
  --authorizer-uri "arn:aws:apigateway:${AWS_REGION}:lambda:path/2015-03-31/functions/${AUTHZ_ARN}/invocations" \
  --identity-source "method.request.header.Authorization" \
  --authorizer-result-ttl-in-seconds 300 \
  --query id --output text)
```

Gắn method `GET /hello` yêu cầu authorizer này VÀ yêu cầu API key:

```bash
aws apigateway put-method --rest-api-id "$API_ID" --resource-id "$RES_ID" \
  --http-method GET --authorization-type CUSTOM --authorizer-id "$AUTHORIZER_ID" \
  --api-key-required

aws apigateway put-integration --rest-api-id "$API_ID" --resource-id "$RES_ID" \
  --http-method GET --type AWS_PROXY --integration-http-method POST \
  --uri "arn:aws:apigateway:${AWS_REGION}:lambda:path/2015-03-31/functions/${BACKEND_ARN}/invocations"
```

Cấp quyền cho API Gateway gọi cả hai Lambda (resource-based policy trên function):

```bash
for FN in dva-ch35-backend dva-ch35-authz; do
  aws lambda add-permission --function-name "$FN" \
    --statement-id apigw-invoke --action lambda:InvokeFunction \
    --principal apigateway.amazonaws.com \
    --source-arn "arn:aws:execute-api:${AWS_REGION}:${ACCOUNT_ID}:${API_ID}/*"
done
```

### Bước 3: Deploy stage và bật caching + throttling

```bash
aws apigateway create-deployment --rest-api-id "$API_ID" --stage-name prod
INVOKE_URL="https://${API_ID}.execute-api.${AWS_REGION}.amazonaws.com/prod/hello"
```

Bật cache cluster cho stage (0.5GB) và method-level throttling bằng patch operations:

```bash
aws apigateway update-stage --rest-api-id "$API_ID" --stage-name prod \
  --patch-operations \
    op=replace,path=/cacheClusterEnabled,value=true \
    op=replace,path=/cacheClusterSize,value=0.5 \
    op=replace,path=/*/*/throttling/rateLimit,value=5 \
    op=replace,path=/*/*/throttling/burstLimit,value=10 \
    op=replace,path=/*/*/caching/enabled,value=true \
    op=replace,path=/*/*/caching/ttlInSeconds,value=60
```

`/*/*/` nghĩa là áp cho mọi method + mọi resource. Cache cluster mất 2-4 phút để khởi tạo — kiểm tra:

```bash
aws apigateway get-stage --rest-api-id "$API_ID" --stage-name prod \
  --query '{cache:cacheClusterStatus,size:cacheClusterSize}'
# {"cache":"AVAILABLE","size":"0.5"} khi sẵn sàng
```

### Bước 4: Tạo usage plan + API key (thứ tự đúng — câu hỏi kinh điển)

Thứ tự BẮT BUỘC: (1) tạo API key → (2) tạo usage plan có gắn stage → (3) gắn key vào usage plan. Đề thi hay hỏi "tại sao API key không có tác dụng" — câu trả lời gần như luôn là **quên gắn key vào usage plan** hoặc **usage plan chưa gắn stage**.

```bash
KEY_ID=$(aws apigateway create-api-key --name client-A --enabled \
  --query id --output text)
KEY_VALUE=$(aws apigateway get-api-key --api-key "$KEY_ID" --include-value \
  --query value --output text)

PLAN_ID=$(aws apigateway create-usage-plan --name basic-plan \
  --throttle rateLimit=10,burstLimit=20 \
  --quota limit=1000,period=DAY \
  --api-stages "apiId=${API_ID},stage=prod" \
  --query id --output text)

aws apigateway create-usage-plan-key --usage-plan-id "$PLAN_ID" \
  --key-id "$KEY_ID" --key-type API_KEY
```

### Bước 5: Test

```bash
# Thiếu API key -> 403 Forbidden
curl -s -o /dev/null -w "%{http_code}\n" "$INVOKE_URL"          # 403

# Có key nhưng token sai -> authorizer trả Deny -> 403
curl -s -o /dev/null -w "%{http_code}\n" "$INVOKE_URL" \
  -H "x-api-key: $KEY_VALUE" -H "Authorization: Bearer wrong"   # 403

# Đủ key + token đúng -> 200
curl -s "$INVOKE_URL" -H "x-api-key: $KEY_VALUE" \
  -H "Authorization: Bearer let-me-in"
# {"message":"Hello from backend","caller":"user-123"}
```

Gọi lặp nhanh để chạm rate limit method-level (5 rps) — bạn sẽ thấy một số request trả `429 Too Many Requests` với body `{"message":"Too Many Requests"}`. Đây là throttling, KHÁC `403` của thiếu quyền và KHÁC `5XX` của lỗi backend.

### Bước 6: Quan sát metrics

```bash
aws cloudwatch get-metric-statistics --namespace AWS/ApiGateway \
  --metric-name CacheHitCount --dimensions Name=ApiName,Value=dva-ch35-api Name=Stage,Value=prod \
  --start-time $(date -u -v-15M +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) --period 300 --statistics Sum
```

Gọi `GET /hello` hai lần liên tiếp với cùng query string: lần đầu `CacheMiss`, lần sau `CacheHit` (trong 60s TTL). Lưu ý cache key mặc định dựa trên path; muốn cache theo header/query phải khai báo chúng là **cache key parameters**.

### Dọn dẹp tài nguyên

Cache cluster và cả Lambda đều tính tiền nếu để quên — dọn ngay:

```bash
aws apigateway delete-usage-plan-key --usage-plan-id "$PLAN_ID" --key-id "$KEY_ID"
aws apigateway delete-usage-plan --usage-plan-id "$PLAN_ID"
aws apigateway delete-api-key --api-key "$KEY_ID"
aws apigateway delete-rest-api --rest-api-id "$API_ID"   # xoá luôn stage + cache cluster
aws lambda delete-function --function-name dva-ch35-backend
aws lambda delete-function --function-name dva-ch35-authz
aws iam detach-role-policy --role-name dva-ch35-lambda-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam delete-role --role-name dva-ch35-lambda-role
rm -rf fn trust.json
```

> Bẫy dọn dẹp: phải xoá `usage-plan-key` trước khi xoá usage plan, và phải xoá stage (qua `delete-rest-api`) thì cache cluster mới biến mất — cache cluster để quên là khoản phí "ẩn" hay gặp nhất với API Gateway.

## 💡 Exam Tips chương 35

- **Chọn cơ chế auth:** IAM (SigV4) cho client là AWS service/account khác cùng tổ chức; **Cognito User Pools authorizer** khi đã có user pool và muốn API Gateway tự verify JWT; **Lambda authorizer** khi cần logic tuỳ biến (OAuth bên thứ ba, kiểm DB, token format riêng). Nếu câu hỏi nói "third-party OIDC/custom token" → Lambda authorizer.
- **Lambda authorizer trả IAM policy document**, không trả boolean. Có 2 kiểu: `TOKEN` (token ở một header) và `REQUEST` (dùng được header + query + path + stage variables). Kết quả cache theo `authorizer-result-ttl-in-seconds` (mặc định 300s, max 3600s); với `REQUEST` mà có nhiều identity source thì cache key là tổ hợp tất cả.
- **Thứ tự usage plan:** tạo API key → tạo usage plan (gắn stage) → liên kết key vào plan → method bật `apiKeyRequired`. Thiếu bất kỳ bước nào thì API key vô tác dụng. API key KHÔNG phải cơ chế authentication — chỉ để định danh client cho quota/throttling.
- **Throttling 2 tầng:** account-level mặc định **10.000 rps** + burst **5.000** trên toàn region (soft limit, tăng được); rồi đến per-stage/per-method và per-client (qua usage plan). Vượt → `429 Too Many Requests`. Phân biệt rõ 429 (throttle) vs 403 (auth/WAF) vs 503.
- **Caching ở stage level**, dung lượng 0.5GB–237GB, TTL mặc định 300s (0–3600s, 0 = tắt). Bỏ qua cache cho một request bằng header `Cache-Control: max-age=0` (cần cấp quyền `InvalidateCache` qua IAM, nếu không sẽ 403). Cache key dựa trên cache key parameters bạn khai báo.
- **Resource policy** dùng cho: **private API** (giới hạn theo VPC endpoint qua `aws:SourceVpce`), IP allowlist/denylist, và cross-account access. Private API BẮT BUỘC có resource policy cho phép VPC endpoint, nếu không sẽ bị từ chối hết.
- **CORS:** với Lambda **proxy** integration, header CORS phải do code Lambda trả về (API Gateway không tự thêm); chỉ preflight `OPTIONS` mới được Enable CORS sinh tự động (MOCK integration). Với non-proxy, có thể cấu hình ở integration response.
- **CloudWatch metrics quan trọng:** `Count`, `4XXError`, `5XXError`, `Latency` (tổng, gồm cả API Gateway overhead), `IntegrationLatency` (chỉ backend), `CacheHitCount`/`CacheMissCount`. Nếu `Latency` cao mà `IntegrationLatency` thấp → nghẽn ở API Gateway/authorizer, không phải backend.
- **HTTP API vs REST API:** HTTP API rẻ hơn (~70%), độ trễ thấp hơn, hỗ trợ JWT authorizer native (OIDC/Cognito) nhưng KHÔNG có: API keys/usage plans, request/response validation theo model, caching, WAF tích hợp, mapping templates VTL, edge-optimized endpoint. Cần các thứ đó → REST API.
- **WebSocket API:** route dựa trên `routeSelectionExpression`; có route đặc biệt `$connect`, `$disconnect`, `$default`. Server đẩy message tới client qua **`@connections` callback URL** (`POST https://.../@connections/{connectionId}`) cần quyền `execute-api:ManageConnections`.
- **Custom domain name** cần chứng chỉ ACM: edge-optimized phải ở **us-east-1**; regional dùng cert cùng region. **mTLS** (mutual TLS) chỉ hỗ trợ trên custom domain regional, cần truststore (bundle CA) đặt trong S3.
- **X-Ray:** bật active tracing ở stage để thấy trace gồm cả segment API Gateway + Lambda; service map giúp định vị authorizer chậm hay backend chậm.

## Quiz chương 35 (10 câu)

**Câu 1.** Một developer cần expose REST API cho các client là mobile app dùng token JWT phát hành bởi một Identity Provider OIDC bên thứ ba (không phải Cognito). Cần kiểm tra claim `scope` trước khi cho gọi. Cách nào ít overhead nhất nhưng đáp ứng yêu cầu?
- A. IAM authorization (SigV4)
- B. Cognito User Pools authorizer
- C. Lambda authorizer kiểu REQUEST verify JWT và đọc claim
- D. API key required

**Câu 2.** API key của một client không có tác dụng: client vẫn gọi được API không giới hạn dù bạn đã đặt quota. Nguyên nhân khả dĩ nhất?
- A. Quên bật `apiKeyRequired` trên method
- B. API key chưa được liên kết vào usage plan
- C. Usage plan chưa gắn stage
- D. Bất kỳ nguyên nhân A, B hoặc C

**Câu 3.** Sau khi gọi `GET /items?category=books` hai lần liên tiếp trong vòng 30s, request thứ hai vẫn gọi xuống backend. Stage đã bật caching TTL 300s. Vì sao?
- A. TTL quá ngắn
- B. `category` chưa được khai báo là cache key parameter
- C. Cache cluster chưa AVAILABLE
- D. API key khác nhau giữa 2 request

**Câu 4.** CloudWatch cho thấy `Latency` trung bình 1200ms nhưng `IntegrationLatency` chỉ 80ms. Khả năng cao nhất là gì?
- A. Backend Lambda bị cold start
- B. Lambda authorizer chậm hoặc bị throttle
- C. DynamoDB throttling
- D. Client mạng chậm

**Câu 5.** Bạn cần một **private** REST API chỉ truy cập được từ trong VPC qua interface endpoint. Yếu tố nào BẮT BUỘC?
- A. Custom domain name với ACM
- B. Resource policy cho phép `aws:SourceVpce` của endpoint
- C. Edge-optimized endpoint type
- D. WAF Web ACL

**Câu 6.** Một developer chuyển từ REST API sang HTTP API để giảm chi phí, nhưng phát hiện mất một tính năng đang dùng. Tính năng nào KHÔNG có trên HTTP API?
- A. JWT authorizer
- B. Lambda proxy integration
- C. Usage plans và API keys
- D. CORS configuration

**Câu 7.** Trong WebSocket API, server cần chủ động đẩy thông báo tới một client đang kết nối. Developer phải làm gì?
- A. Trả response trong route `$default`
- B. Gọi `POST @connections/{connectionId}` với quyền `execute-api:ManageConnections`
- C. Publish lên SNS topic gắn với API
- D. Dùng `$disconnect` route

**Câu 8.** API trả `429 Too Many Requests` khi traffic tăng đột biến dù backend còn rảnh. Cấu hình nào giải quyết đúng trọng tâm?
- A. Tăng memory Lambda
- B. Tăng rate/burst limit ở account-level (request quota increase) và/hoặc usage plan
- C. Bật caching
- D. Đổi sang edge-optimized

**Câu 9.** Một developer muốn dùng mTLS (mutual TLS) để xác thực client bằng certificate. Cấu hình nào đúng?
- A. Bật mTLS trên edge-optimized custom domain, truststore trong S3
- B. Bật mTLS trên regional custom domain, truststore (CA bundle) trong S3
- C. Bật mTLS trực tiếp ở stage, không cần custom domain
- D. Dùng Lambda authorizer để verify certificate

**Câu 10.** API dùng Lambda **proxy** integration. Browser báo lỗi CORS khi gọi từ web app khác origin, dù request `OPTIONS` đã trả đúng header. Khắc phục?
- A. Bật lại Enable CORS trên console
- B. Thêm header `Access-Control-Allow-Origin` vào response trả về từ code Lambda
- C. Thêm resource policy
- D. Bật caching cho OPTIONS

### Đáp án & giải thích

**Câu 1 — Đáp án C.** OIDC bên thứ ba (không phải Cognito) + cần kiểm claim tuỳ biến → **Lambda authorizer REQUEST** verify JWT và đọc `scope`. A (IAM/SigV4) dùng cho caller là AWS principal, không hợp JWT của mobile. B chỉ verify token do chính Cognito User Pool phát hành, không nhận IdP ngoài. D (API key) không phải authentication, chỉ định danh client cho quota.

**Câu 2 — Đáp án D.** Cả ba lỗi đều khiến API key vô tác dụng: thiếu `apiKeyRequired` thì gateway không kiểm key; key chưa gắn vào usage plan thì không có quota áp; usage plan chưa gắn stage thì không có hiệu lực trên stage đó. Đây là lý do câu hỏi nhấn mạnh đúng thứ tự cấu hình.

**Câu 3 — Đáp án B.** Cache key mặc định chỉ gồm path; muốn cache phân biệt theo query string `category` phải khai báo nó là **cache key parameter**. A sai vì 300s đủ dài. C sai vì nếu chưa AVAILABLE thì caching chưa hoạt động hoàn toàn nhưng triệu chứng ở đây là cache không phân biệt key, không phải cluster lỗi. D không liên quan: API key không nằm trong cache key mặc định.

**Câu 4 — Đáp án B.** `Latency` đo tổng (gồm authorizer + overhead gateway), `IntegrationLatency` chỉ đo backend. Backend 80ms nhưng tổng 1200ms → chênh lệch nằm ở khâu API Gateway xử lý, điển hình là **Lambda authorizer chậm/throttle** (đặc biệt khi cache TTL=0). A/C sẽ làm `IntegrationLatency` cao. D không phản ánh vào hai metric server-side này.

**Câu 5 — Đáp án B.** Private API BẮT BUỘC có **resource policy** cho phép VPC endpoint (`aws:SourceVpce`/`aws:SourceVpc`), nếu không mọi request bị từ chối. A là tuỳ chọn không bắt buộc. C sai — private API dùng endpoint type `PRIVATE`, không phải edge-optimized. D (WAF) không bắt buộc cho truy cập private.

**Câu 6 — Đáp án C.** HTTP API **không có** usage plans và API keys (cũng không có request validation theo model, caching, WAF tích hợp, mapping template VTL). Nó VẪN có JWT authorizer, Lambda proxy integration và CORS — nên A, B, D đều còn.

**Câu 7 — Đáp án B.** Server đẩy message qua **`@connections` callback**: `POST https://{api}.execute-api.../{stage}/@connections/{connectionId}` với IAM permission `execute-api:ManageConnections`. A chỉ trả về cho request hiện tại, không chủ động đẩy. C không phải cơ chế của WebSocket API. D là route khi client ngắt kết nối.

**Câu 8 — Đáp án B.** 429 là throttling. Backend rảnh nghĩa là nghẽn ở giới hạn rate/burst của API Gateway — account-level (mặc định 10.000 rps / burst 5.000) và/hoặc usage plan/method. Giải pháp đúng là tăng các giới hạn này (account cần request quota increase). A/C/D không động đến nguyên nhân throttle.

**Câu 9 — Đáp án B.** mTLS chỉ hỗ trợ trên **regional custom domain**, với truststore là bundle CA đặt trong **S3**. A sai vì không hỗ trợ edge-optimized. C sai vì mTLS gắn với custom domain, không bật trực tiếp ở stage. D không phải cách AWS triển khai mTLS.

**Câu 10 — Đáp án B.** Với Lambda **proxy** integration, API Gateway không tự chèn header CORS vào response thực — chỉ preflight `OPTIONS` được sinh tự động. Vì vậy code Lambda PHẢI tự trả `Access-Control-Allow-Origin` (và các header liên quan) trong actual response. A không có tác dụng cho proxy. C/D không liên quan đến CORS.

## Tóm tắt chương

- API Gateway có 3 cơ chế auth: **IAM/SigV4** (caller là AWS principal), **Cognito User Pools authorizer** (verify JWT do chính user pool phát hành), **Lambda authorizer** (logic tuỳ biến cho token/OIDC bên ngoài). Chọn theo nguồn token và nhu cầu logic.
- Lambda authorizer trả về **IAM policy document** (Allow/Deny) chứ không phải boolean; có kiểu `TOKEN` và `REQUEST`; kết quả cache theo TTL (mặc định 300s, max 3600s) để giảm số lần gọi authorizer.
- **API key + usage plan** dùng cho quota và throttling per-client, KHÔNG phải authentication. Thứ tự đúng: tạo key → tạo usage plan gắn stage → liên kết key → bật `apiKeyRequired`.
- Throttling nhiều tầng: account-level mặc định **10.000 rps / burst 5.000** (soft limit) → per-stage/method → per-client; vượt trả **429**. Phân biệt 429 (throttle) với 403 (auth) và 5XX (backend).
- **Caching** ở stage level (0.5–237GB, TTL 0–3600s, mặc định 300s); cache key dựa trên cache key parameters khai báo; có thể bỏ qua cache bằng `Cache-Control: max-age=0` nếu được cấp quyền invalidate.
- **Resource policy** kiểm soát private API (theo VPC endpoint), IP allowlist/denylist, cross-account; private API bắt buộc có resource policy hợp lệ.
- **CORS** với Lambda proxy phải được code backend trả header; chỉ preflight OPTIONS được API Gateway sinh tự động.
- Metric chẩn đoán: `Latency` (tổng) vs `IntegrationLatency` (chỉ backend) giúp tách biệt nghẽn ở gateway/authorizer hay ở backend; thêm `4XXError`, `5XXError`, `CacheHitCount/CacheMissCount`.
- **HTTP API** rẻ và nhanh hơn nhưng thiếu API keys/usage plans, model validation, caching, WAF, VTL, edge-optimized; **REST API** đầy đủ tính năng hơn.
- **WebSocket API** route theo `$connect`/`$disconnect`/`$default`/custom; server đẩy message qua **`@connections`** callback với quyền `ManageConnections`.
- **Custom domain** cần ACM (edge-optimized: cert ở **us-east-1**; regional: cert cùng region); **mTLS** chỉ trên regional custom domain với truststore CA trong S3.
- Bật **X-Ray active tracing** ở stage để có service map xuyên suốt API Gateway → authorizer → backend, hỗ trợ định vị điểm chậm.
