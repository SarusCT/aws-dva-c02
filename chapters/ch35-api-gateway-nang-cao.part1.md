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
