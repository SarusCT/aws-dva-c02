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
