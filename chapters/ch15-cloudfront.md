# Chương 15: CloudFront

> **Trọng tâm DVA-C02:** CloudFront là dịch vụ CDN cốt lõi trong domain Development và Security. Đề thi hay hỏi: cách dùng **OAC (Origin Access Control)** để khoá S3 origin chỉ cho CloudFront truy cập, phân biệt **signed URL vs signed cookies** và khác gì so với **S3 presigned URL**, chọn **cache policy / origin request policy** đúng để tăng cache hit ratio, khi nào dùng **CloudFront Functions** vs **Lambda@Edge**, và cấu hình **origin failover / Origin Shield** để tăng độ bền. Các con số quan trọng: TTL mặc định, giới hạn invalidation, kích thước & runtime của CloudFront Functions.

## Mục tiêu chương

- Hiểu cơ chế CDN, edge location, regional edge cache và đường đi của một request qua CloudFront.
- Cấu hình origin S3 với OAC (thay cho OAI cũ) và custom origin (ALB/EC2/HTTP server) đúng cách.
- Nắm vững caching: cache key, cache policy, origin request policy, TTL (Min/Default/Max), invalidation và giới hạn.
- Phân biệt signed URL vs signed cookies vs S3 presigned URL; biết khi nào chọn cái nào.
- Cấu hình HTTPS hai chặng (viewer ↔ CloudFront ↔ origin), geo restriction, origin failover, Origin Shield.
- So sánh CloudFront Functions vs Lambda@Edge và biết field-level encryption, real-time logs phục vụ tình huống nào.

## 15.1 CDN, edge location và đường đi của một request

Amazon CloudFront là **Content Delivery Network (CDN)** — mạng lưới máy chủ cache đặt rải rác toàn cầu để phục vụ nội dung từ vị trí gần người dùng nhất, giảm latency và giảm tải cho origin (máy chủ gốc). Origin có thể là S3 bucket, ALB, EC2, API Gateway, hay bất kỳ HTTP server nào (kể cả ngoài AWS).

CloudFront có **3 tầng** quan trọng cần phân biệt cho đề thi:

- **Edge locations (Points of Presence — PoP):** hơn 600 điểm trên toàn cầu, là nơi viewer kết nối trực tiếp. Đây là nơi cache nội dung và chạy CloudFront Functions.
- **Regional edge caches:** tầng cache trung gian lớn hơn, nằm giữa edge location và origin. Khi edge location cache miss, nó hỏi regional edge cache trước khi đi tới origin → tăng cache hit, giảm số lần chạm origin. (Lưu ý: regional edge cache **không** dùng cho proxy methods như PUT/POST/DELETE — các request này đi thẳng tới origin; và một số tính năng như dynamic content bỏ qua tầng này.)
- **Origin:** máy chủ gốc chứa bản gốc nội dung.

Đường đi một request GET điển hình:

```
Viewer → DNS resolve d1234.cloudfront.net → Edge location gần nhất
   ├─ Cache HIT  → trả về ngay từ edge (nhanh nhất)
   └─ Cache MISS → Regional Edge Cache
        ├─ HIT  → trả về + cache lại ở edge
        └─ MISS → Origin → trả về + cache ở cả 2 tầng
```

CloudFront dùng **anycast** và mạng backbone riêng của AWS giữa edge và origin, nên kết nối edge→origin thường nhanh và ổn định hơn đi qua internet công cộng. Đây là lý do CloudFront có ích **ngay cả với nội dung động (dynamic)** không cache được: nó vẫn rút ngắn đường mạng và tái sử dụng kết nối TCP/TLS đã warm tới origin.

> 💡 **Exam Tip:** Khi câu hỏi nói "giảm latency toàn cầu cho static assets" → CloudFront. Nếu nói "phân tải DNS theo latency giữa nhiều region" → đó là Route 53 latency routing (Chương 10), KHÔNG phải CloudFront. Hai dịch vụ này hay bị gài lẫn.

**Phân biệt với S3 Transfer Acceleration:** Transfer Acceleration (Chương 13) dùng edge của CloudFront để tăng tốc **upload vào S3**, còn CloudFront chủ yếu để **phân phối (download)** nội dung ra ngoài. Đừng chọn nhầm.

## 15.2 Origin: S3 với OAC, và custom origin

CloudFront chia origin thành hai loại:

- **S3 origin:** trỏ tới REST endpoint của bucket (`bucket.s3.region.amazonaws.com`). Hỗ trợ OAC để khoá truy cập.
- **Custom origin:** bất kỳ HTTP endpoint nào — ALB, EC2, API Gateway, S3 static website endpoint (lưu ý: dùng website endpoint thì S3 được xem là *custom* origin chứ không phải S3 origin), hoặc server on-premises.

### OAC — Origin Access Control (thay cho OAI)

Vấn đề kinh điển: nếu bucket S3 để private nhưng CloudFront cần đọc, làm sao cho **chỉ CloudFront** đọc được mà không mở bucket ra public? Giải pháp hiện đại là **Origin Access Control (OAC)** — bản kế nhiệm của **Origin Access Identity (OAI)** cũ.

OAC ký request từ CloudFront tới S3 bằng **SigV4**, hỗ trợ đầy đủ:
- Tất cả region (kể cả region mới chỉ hỗ trợ SigV4).
- **SSE-KMS** (OAI cũ không ký được request đọc object mã hoá bằng KMS một cách trơn tru).
- Các method PUT/POST/DELETE (dynamic uploads qua CloudFront).

Cấu hình gồm 2 phần: (1) tạo OAC và gắn vào origin trong CloudFront; (2) thêm **bucket policy** cho phép service principal `cloudfront.amazonaws.com` đọc, giới hạn theo ARN của distribution qua condition `AWS:SourceArn`:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AllowCloudFrontOACRead",
    "Effect": "Allow",
    "Principal": { "Service": "cloudfront.amazonaws.com" },
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::my-cdn-bucket/*",
    "Condition": {
      "StringEquals": {
        "AWS:SourceArn": "arn:aws:cloudfront::111122223333:distribution/E2ABCDEF12345"
      }
    }
  }]
}
```

Đồng thời nên **bật Block Public Access** trên bucket — vì với OAC, bucket không cần public chút nào.

> 💡 **Exam Tip:** Tình huống "S3 bucket private nhưng vẫn phục vụ qua CloudFront, hỗ trợ object mã hoá SSE-KMS" → **OAC**, không phải OAI. Nếu đáp án có cả OAI và OAC, OAC luôn là lựa chọn được khuyến nghị hiện nay. OAI vẫn còn trong đề như distractor (đáp án sai/lỗi thời).

### Custom origin và origin settings quan trọng

Với custom origin (ALB/EC2), một vài thiết lập hay được hỏi:
- **Origin protocol policy:** HTTP only, HTTPS only, hay Match Viewer (xem mục 15.5).
- **Custom headers:** CloudFront có thể tự thêm header bí mật vào mỗi request tới origin. Mẹo bảo mật phổ biến: thêm header `X-Origin-Verify: <secret>` và cấu hình ALB/WAF chỉ chấp nhận request có header đó → chặn người dùng đi vòng qua CloudFront để gọi thẳng ALB.
- **Origin Shield:** một regional cache bổ sung (mục 15.7).

```bash
# Tạo OAC bằng CLI v2
aws cloudfront create-origin-access-control \
  --origin-access-control-config \
  Name=my-oac,SigningProtocol=sigv4,SigningBehavior=always,OriginAccessControlOriginType=s3
```

## 15.3 Caching: cache key, cache policy và TTL

Hiệu năng và chi phí CloudFront phụ thuộc vào **cache hit ratio**. Muốn cache hit cao, phải hiểu **cache key** — chuỗi định danh mà CloudFront dùng để tra cache. Mặc định cache key chỉ gồm **domain + path của URL**. Nếu hai viewer gọi cùng path nhưng cache key khác nhau (vì khác query string/header/cookie được đưa vào key), CloudFront coi là 2 object riêng → cache phân mảnh, hit ratio giảm.

Bạn điều khiển cache key qua **Cache Policy** (chính sách cache). Cache policy quyết định:
- **Những thành phần nào của request vào cache key:** query strings (none / whitelist / all), headers (none / whitelist), cookies (none / whitelist / all).
- **TTL:** Minimum TTL, **Default TTL** (mặc định 86400 giây = 24 giờ khi origin không trả `Cache-Control`), Maximum TTL.
- **Nén:** bật Gzip/Brotli.

Phân biệt với **Origin Request Policy** (chính sách request tới origin) — đây là điểm hay nhầm:

| | Cache Policy | Origin Request Policy |
|---|---|---|
| Ảnh hưởng cache key? | **Có** | Không |
| Quyết định gì? | Cái gì vào cache key + TTL + nén | Cái gì được **chuyển tiếp** tới origin |
| Ví dụ | Chỉ đưa `?version` vào key | Forward thêm header `Authorization`, `User-Agent` tới origin nhưng KHÔNG dùng làm cache key |

Tách hai khái niệm này cho phép bạn **forward nhiều thứ tới origin để xử lý** mà **không làm phình cache key**. Ví dụ: forward `CloudFront-Viewer-Country` tới origin để origin trả nội dung theo quốc gia, nhưng nếu bạn đưa header này vào cache key thì cache sẽ phân mảnh theo từng nước.

### Cơ chế TTL và Cache-Control

CloudFront quyết định thời gian cache theo thứ tự ưu tiên:
1. Nếu origin trả `Cache-Control: max-age=<s>` hoặc `Expires`, CloudFront tôn trọng giá trị đó — **nhưng bị kẹp** trong khoảng [Minimum TTL, Maximum TTL] của cache policy.
2. Nếu origin **không** trả header cache nào → dùng **Default TTL**.
3. `Cache-Control: no-cache`/`no-store` hoặc Min TTL = 0 cho phép revalidate. CloudFront dùng `If-None-Match`/`If-Modified-Since` để hỏi origin, nếu origin trả `304 Not Modified` thì phục vụ lại bản cache mà không tải lại body.

> 💡 **Exam Tip:** Câu hỏi "object update ở S3 nhưng người dùng vẫn thấy bản cũ qua CloudFront" có 2 hướng giải: (1) tạo **invalidation** để xoá cache ngay; (2) dùng **versioned object names** (ví dụ `app.v2.js`) — cách này được AWS khuyên hơn vì không tốn phí invalidation và không có độ trễ lan truyền. Đừng chọn "giảm Default TTL về 0" cho static assets vì nó phá cache hit ratio.

### Invalidation và giới hạn

Invalidation buộc CloudFront coi object ở mọi edge là hết hạn ngay, lần gọi tới sẽ fetch lại từ origin.

```bash
# Invalidate toàn bộ
aws cloudfront create-invalidation \
  --distribution-id E2ABCDEF12345 \
  --paths "/*"

# Invalidate một số path
aws cloudfront create-invalidation \
  --distribution-id E2ABCDEF12345 \
  --paths "/images/logo.png" "/css/main.css"
```

Con số cần nhớ: **1000 path đầu mỗi tháng miễn phí**, sau đó tính phí theo path. Một path có wildcard (`/*`) vẫn tính là **1 path**. Invalidation lan truyền tới mọi edge thường mất vài giây tới vài phút.

## 15.4 Cache behaviors theo path

Một distribution có thể có nhiều **cache behavior** — mỗi behavior khớp một **path pattern** và áp dụng cấu hình riêng (origin nào, cache policy nào, có signed URL không, có gắn function không...). Luôn có một **Default (*) behavior** bắt mọi path không khớp pattern nào khác.

Cache behavior được đánh giá theo **độ ưu tiên** (precedence): CloudFront duyệt theo thứ tự bạn sắp, pattern **cụ thể hơn nên đặt trước**. Ví dụ kiến trúc phổ biến:

| Path pattern | Origin | Mục đích |
|---|---|---|
| `/api/*` | ALB (custom) | Nội dung động, cache policy `CachingDisabled`, forward `Authorization` |
| `/static/*` | S3 + OAC | Asset tĩnh, TTL dài, nén bật |
| `Default (*)` | S3 + OAC | Trang HTML/SPA |

Cấu hình này cho phép một domain duy nhất phục vụ cả static (cache mạnh từ S3) lẫn dynamic API (không cache, từ ALB) — đúng kiểu kiến trúc đề thi hay mô tả.

> 💡 **Exam Tip:** "Một CloudFront distribution phục vụ cả nội dung tĩnh từ S3 và nội dung động từ ALB" → tạo **nhiều origin + nhiều cache behavior** với path pattern. Không cần 2 distribution riêng.

Với nội dung động không nên cache, dùng **managed cache policy `CachingDisabled`** (Min/Max/Default TTL = 0, không đưa gì vào cache key). AWS cung cấp sẵn các managed policy: `CachingOptimized`, `CachingDisabled`, `Elemental-MediaPackage`, `Amplify`... dùng được ngay không phải tự định nghĩa.

## 15.5 HTTPS: viewer protocol policy và origin protocol policy

CloudFront có **hai chặng TLS** độc lập, đề thi hay hỏi tách bạch:

**Chặng viewer ↔ CloudFront — Viewer Protocol Policy:**
- `HTTP and HTTPS`: cho cả hai.
- `Redirect HTTP to HTTPS`: viewer gọi HTTP sẽ nhận 301 chuyển sang HTTPS (lựa chọn phổ biến nhất).
- `HTTPS Only`: từ chối HTTP.

**Chặng CloudFront ↔ origin — Origin Protocol Policy:**
- `HTTP Only`, `HTTPS Only`, hoặc `Match Viewer` (CloudFront gọi origin bằng đúng protocol viewer đã dùng).

Để dùng HTTPS với **tên miền riêng** (vd `cdn.example.com`), bạn cần:
- Một **alternate domain name (CNAME)** khai trên distribution.
- Một **SSL certificate** trong **ACM** (chi tiết ACM ở Chương 48). **Quan trọng:** chứng chỉ cho CloudFront phải nằm ở region **us-east-1 (N. Virginia)** — bất kể origin/viewer ở đâu. Đây là bẫy rất hay gặp.
- Record DNS (Route 53 alias) trỏ tên miền tới `d111.cloudfront.net`.

CloudFront dùng **SNI** mặc định (miễn phí); chỉ client cực cũ không hỗ trợ SNI mới cần dedicated IP (tính phí cao). Với origin là ALB/EC2 dùng HTTPS, origin cần chứng chỉ hợp lệ, **khớp domain** mà CloudFront gọi; nếu origin dùng self-signed cert, CloudFront sẽ từ chối trừ khi... thực ra CloudFront yêu cầu cert do CA tin cậy ký với HTTPS origin.

> 💡 **Exam Tip:** "ACM certificate cho CloudFront phải ở us-east-1." Nếu cert ở region khác, CloudFront **không thấy** nó để gán. Trong khi đó cert cho **ALB** phải cùng region với ALB. Phân biệt rõ hai trường hợp này.

## 15.6 Geo restriction (giới hạn theo địa lý)

CloudFront có tính năng **geographic restriction** dựa trên IP-to-country của viewer:
- **Allowlist:** chỉ các quốc gia trong danh sách được xem.
- **Blocklist:** các quốc gia trong danh sách bị chặn (nhận HTTP 403).

Tính năng này dùng cơ sở dữ liệu GeoIP của bên thứ ba, phân giải ở mức **quốc gia** (không tới mức tỉnh/thành). Khi viewer bị chặn, CloudFront trả 403 ngay tại edge mà không chạm origin.

Lưu ý phân biệt: geo restriction **tích hợp sẵn** của CloudFront chỉ ở mức quốc gia. Nếu cần luật phức tạp hơn (theo region nhỏ hơn, kết hợp nhiều điều kiện, rate limiting), dùng **AWS WAF** gắn vào CloudFront, hoặc dùng **Lambda@Edge / CloudFront Functions** đọc header `CloudFront-Viewer-Country` để tự xử lý.

> 💡 **Exam Tip:** "Chặn truy cập từ một số quốc gia vì lý do bản quyền/license" → **CloudFront Geo Restriction**. Nếu cần kết hợp với chặn theo IP/SQL injection/rate limit → **AWS WAF on CloudFront**.

## 15.7 Origin failover và Origin Shield (tăng độ bền)

### Origin Group / Origin Failover

Bạn có thể nhóm **2 origin** thành một **origin group**: một primary và một secondary. CloudFront tự **failover** sang secondary khi primary trả về một trong các status code lỗi đã cấu hình (vd 500, 502, 503, 504, hoặc 403/404 tuỳ chọn) hoặc timeout/không kết nối được.

Kiến trúc điển hình: primary là S3 bucket ở region A, secondary là bucket ở region B (đã replicate qua CRR — Chương 12). Khi region A có sự cố, viewer vẫn được phục vụ từ region B mà không đổi URL.

Lưu ý: origin failover chỉ kích hoạt với **GET/HEAD/OPTIONS**. Failover xảy ra khi primary trả lỗi nằm trong danh sách "failover criteria" bạn khai báo.

> 💡 **Exam Tip:** "High availability cho static content phục vụ qua CloudFront, tự chuyển sang bản sao khi origin chính lỗi" → **Origin Group (origin failover)** kết hợp S3 CRR sang region thứ hai.

### Origin Shield

**Origin Shield** là một lớp cache **trung tâm bổ sung** đặt tại một region bạn chọn (nên chọn gần origin nhất). Mọi cache miss từ các regional edge cache sẽ hội tụ về Origin Shield trước khi chạm origin. Lợi ích:
- **Giảm tải origin:** nhiều regional cache miss được gộp thành 1 request tới origin (request collapsing tốt hơn).
- **Tăng cache hit:** nội dung ít phổ biến vẫn có nơi tập trung cache.

Origin Shield phù hợp khi origin có khả năng chịu tải hạn chế, hoặc khi nội dung được phân phối toàn cầu nhưng origin chỉ ở một region. Nó **tính phí thêm** theo số request đi qua, nên không bật bừa.

## 15.8 Bảo vệ nội dung: signed URL, signed cookies vs S3 presigned URL

Khi cần phục vụ **nội dung private qua CloudFront** (chỉ user đã trả tiền/đăng nhập mới xem được), bạn dùng **signed URL** hoặc **signed cookies**. Cả hai dựa trên cặp khoá (key pair) gắn vào **trusted key group** của distribution; bạn ký bằng private key, CloudFront xác minh bằng public key.

Policy ký có thể là **canned** (đơn giản: 1 URL, 1 thời điểm hết hạn) hoặc **custom** (linh hoạt: khoảng thời gian hiệu lực, dải IP `IpAddress`, ngày bắt đầu...).

| | CloudFront Signed URL | CloudFront Signed Cookies | S3 Presigned URL |
|---|---|---|---|
| Cấp quyền cho | **1 file/URL** mỗi lần ký | **Nhiều file** (theo path pattern) | 1 object S3 |
| Qua CloudFront? | Có (dùng đặc tính CDN, WAF, geo...) | Có | Không — đi thẳng S3 |
| Khi dùng | Tải 1 file private, RTMP cũ | Streaming nhiều file, cả website private | Upload/download tạm 1 object |
| Cơ chế khoá | Key group + private key | Key group + private key | Quyền của IAM principal ký URL |
| Đổi URL gốc? | Có (thêm query string) | **Không** đổi URL (đặt cookie) | Có |

Quy tắc chọn:
- Cần phục vụ **một file** private và không ngại URL dài → **signed URL**.
- Cần cấp quyền **nhiều file** (toàn bộ video segment HLS, cả thư mục) mà **không muốn đổi URL** từng file → **signed cookies**.
- Muốn dùng các tính năng CDN (cache, geo, WAF) trên nội dung private → dùng CloudFront signed (URL/cookies), **không** dùng S3 presigned.
- Truy cập trực tiếp một object S3, không qua CDN, ngắn hạn → **S3 presigned URL** (chi tiết ở Chương 14).

```javascript
// Tạo CloudFront signed URL bằng SDK JS v3 (@aws-sdk/cloudfront-signer)
import { getSignedUrl } from "@aws-sdk/cloudfront-signer";

const url = getSignedUrl({
  url: "https://cdn.example.com/videos/private/lesson1.mp4",
  keyPairId: "K2ABCDEF123",           // public key ID trong key group
  privateKey: process.env.CF_PRIVATE_KEY, // PEM private key
  dateLessThan: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // hết hạn sau 1h
});
console.log(url);
```

```javascript
// Tạo signed cookies (cấp quyền cả thư mục theo wildcard)
import { getSignedCookies } from "@aws-sdk/cloudfront-signer";

const cookies = getSignedCookies({
  url: "https://cdn.example.com/videos/private/*", // áp cho mọi file dưới prefix
  keyPairId: "K2ABCDEF123",
  privateKey: process.env.CF_PRIVATE_KEY,
  dateLessThan: new Date(Date.now() + 3600 * 1000).toISOString(),
});
// Trả 3 cookie: CloudFront-Policy, CloudFront-Signature, CloudFront-Key-Pair-Id
```

> 💡 **Exam Tip:** "Cấp quyền truy cập tạm cho HÀNG LOẠT file (vd toàn bộ segment của một video) mà không phải ký từng URL" → **signed cookies**. "Một file duy nhất, link tải dùng một lần" → **signed URL**. "Truy cập thẳng object S3 không qua CloudFront" → **S3 presigned URL**.

## 15.9 Edge compute: CloudFront Functions vs Lambda@Edge

CloudFront cho phép chạy code **tại edge** để biến đổi request/response. Có hai lựa chọn, đề thi rất hay so sánh:

| Tiêu chí | CloudFront Functions | Lambda@Edge |
|---|---|---|
| Ngôn ngữ | JavaScript (ECMAScript thuần, runtime riêng) | Node.js / Python (Lambda) |
| Chạy ở | **Edge location** (PoP) | **Regional edge cache** |
| Trigger | Viewer request, Viewer response | Cả 4: Viewer request/response, Origin request/response |
| Thời gian chạy tối đa | **< 1 ms** | Viewer trigger 5s, Origin trigger 30s |
| Bộ nhớ | ~2 MB | 128 MB–10 GB tuỳ trigger |
| Truy cập network/disk? | **Không** (không gọi được dịch vụ ngoài) | Có (gọi được API, S3, DynamoDB...) |
| Kích thước code | tối đa 10 KB | tối đa 1 MB (viewer) / 50 MB (origin, zipped) |
| Truy cập request body? | Không | Có (origin trigger) |
| Chi phí | Rẻ hơn nhiều | Cao hơn |

Quy tắc chọn theo use case:
- **CloudFront Functions** — cho thao tác **siêu nhẹ, tần suất cao** ngay tại viewer: viết lại/redirect URL, kiểm tra/thêm header (vd thêm security headers), kiểm token đơn giản (vd verify JWT signature có sẵn key), A/B testing đơn giản, chuẩn hoá cache key. Chạy trên **mọi request** với chi phí cực thấp.
- **Lambda@Edge** — khi cần logic phức tạp: **gọi dịch vụ ngoài** (lookup DynamoDB, S3), **xử lý/sửa body**, thao tác ở origin request/response (vd chọn origin động, thêm header chỉ tới origin), tích hợp SDK. Lambda@Edge function phải đặt ở **us-east-1** rồi mới replicate ra edge.

> 💡 **Exam Tip:** "Viết lại URL hoặc thêm HTTP header cho mọi request với độ trễ và chi phí thấp nhất" → **CloudFront Functions**. "Cần gọi DynamoDB/đọc S3 hoặc sửa request body ở edge" → **Lambda@Edge**. "Chạy ở origin request để chọn backend động" → chỉ Lambda@Edge làm được (CloudFront Functions chỉ có viewer trigger).

### Field-level encryption

**Field-level encryption (FLE)** cho phép mã hoá các **trường dữ liệu nhạy cảm cụ thể** trong POST request (vd số thẻ tín dụng) **ngay tại edge** bằng public key bạn cung cấp, để dữ liệu đó được mã hoá suốt đường đi qua hệ thống và **chỉ** service nào có private key tương ứng mới giải mã được. Nó bảo vệ theo nguyên tắc "mã hoá càng gần nguồn càng tốt", giảm bề mặt phơi nhiễm dữ liệu nhạy cảm trong các tầng trung gian. FLE hỗ trợ tối đa 10 field/request và yêu cầu HTTPS.

> 💡 **Exam Tip:** "Mã hoá một số field nhạy cảm (số thẻ) ngay tại edge để chỉ ứng dụng cuối giải mã được" → **CloudFront field-level encryption**, không phải SSE hay TLS thông thường (TLS chỉ bảo vệ trên đường truyền, không bảo vệ ở các tầng xử lý sau khi decrypt TLS).

### Real-time logs vs standard logs

CloudFront có hai loại log:
- **Standard logs (access logs):** ghi chi tiết mỗi request, giao tới **S3**, có độ trễ (gộp theo lô, có thể chậm vài phút tới giờ). Phù hợp phân tích lịch sử, audit.
- **Real-time logs:** stream gần thời gian thực tới **Kinesis Data Streams** (Chương 23), cho phép giám sát/cảnh báo nhanh, tuỳ chỉnh field và sampling rate. Tính phí theo số log line.

> 💡 **Exam Tip:** "Cần log truy cập CloudFront gần thời gian thực để giám sát/cảnh báo" → **real-time logs → Kinesis Data Streams**. "Lưu trữ access log để phân tích sau, chi phí thấp" → **standard logs → S3**.

---

## Hands-on Lab: Phân phối S3 + ALB qua CloudFront — OAC, cache policy, signed URL, CloudFront Functions, invalidation

**Mục tiêu lab:** Dựng một CloudFront distribution thực chiến với HAI origin: một S3 bucket private (chỉ CloudFront đọc được qua Origin Access Control) cho static asset, và một custom origin (HTTP endpoint) cho `/api/*`. Bạn sẽ cấu hình cache behavior theo path, gắn managed cache policy, chặn truy cập trực tiếp bucket, ký signed URL để bảo vệ nội dung trả phí, gắn một CloudFront Function viết lại URL ở viewer-request, ép HTTPS, rồi invalidate cache. Cuối cùng dọn sạch.

**Chuẩn bị:**
- AWS CLI v2 cấu hình profile có quyền `cloudfront:*`, `s3:*`, `iam:*` (sandbox/cá nhân).
- Node.js ≥ 18, package `@aws-sdk/cloudfront-signer`.
- CloudFront là dịch vụ global — mọi API CloudFront đều ở region `us-east-1`. S3 bucket dùng `ap-southeast-1`. Thay `123456789012` bằng account ID của bạn.

### Bước 1: Tạo S3 bucket private + upload asset

```bash
export AWS_REGION=ap-southeast-1
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export BUCKET=dva-ch15-assets-$ACCOUNT_ID

aws s3api create-bucket --bucket $BUCKET \
  --region $AWS_REGION \
  --create-bucket-configuration LocationConstraint=$AWS_REGION

echo "<h1>Hello from CloudFront origin S3</h1>" > index.html
aws s3api put-object --bucket $BUCKET --key index.html \
  --body index.html --content-type text/html
```

Bucket vẫn đang Block Public Access mặc định (bật từ 4/2023) — đúng ý đồ: không ai vào trực tiếp được, chỉ CloudFront qua OAC mới đọc.

### Bước 2: Tạo Origin Access Control (OAC)

OAC là cơ chế thay thế OAI (legacy). Nó ký request CloudFront→S3 bằng SigV4, hỗ trợ cả SSE-KMS và mọi region — OAI thì không.

```bash
aws cloudfront create-origin-access-control \
  --origin-access-control-config '{
    "Name": "dva-ch15-oac",
    "OriginAccessControlOriginType": "s3",
    "SigningBehavior": "always",
    "SigningProtocol": "sigv4"
  }' --region us-east-1
```

Lưu lại `Id` trả về (dạng `E2XXXXXXXXXXXX`) vào biến `OAC_ID`. `SigningBehavior: always` = CloudFront luôn ký request gửi tới S3.

### Bước 3: Tạo distribution với 2 origin và cache behavior theo path

Tạo file `dist-config.json`. Default behavior trỏ S3 (dùng managed cache policy **CachingOptimized** = `658327ea-f89d-4fab-a63d-7e88639e58f6`); behavior `/api/*` trỏ custom origin và dùng **CachingDisabled** = `4135ea2d-6df8-44a3-9df3-4b5a84be39ad` (API không nên cache).

```bash
cat > dist-config.json <<EOF
{
  "CallerReference": "dva-ch15-$(date +%s)",
  "Comment": "DVA ch15 lab",
  "Enabled": true,
  "DefaultRootObject": "index.html",
  "Origins": {
    "Quantity": 2,
    "Items": [
      {
        "Id": "s3-origin",
        "DomainName": "$BUCKET.s3.$AWS_REGION.amazonaws.com",
        "OriginAccessControlId": "$OAC_ID",
        "S3OriginConfig": { "OriginAccessIdentity": "" }
      },
      {
        "Id": "api-origin",
        "DomainName": "httpbin.org",
        "CustomOriginConfig": {
          "HTTPPort": 80, "HTTPSPort": 443,
          "OriginProtocolPolicy": "https-only",
          "OriginSslProtocols": { "Quantity": 1, "Items": ["TLSv1.2"] }
        }
      }
    ]
  },
  "DefaultCacheBehavior": {
    "TargetOriginId": "s3-origin",
    "ViewerProtocolPolicy": "redirect-to-https",
    "CachePolicyId": "658327ea-f89d-4fab-a63d-7e88639e58f6",
    "Compress": true
  },
  "CacheBehaviors": {
    "Quantity": 1,
    "Items": [
      {
        "PathPattern": "/api/*",
        "TargetOriginId": "api-origin",
        "ViewerProtocolPolicy": "https-only",
        "CachePolicyId": "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
      }
    ]
  }
}
EOF

aws cloudfront create-distribution \
  --distribution-config file://dist-config.json \
  --region us-east-1 \
  --query '{Id:Distribution.Id,Domain:Distribution.DomainName,Status:Distribution.Status}'
```

Output mong đợi:

```json
{
    "Id": "E1XXXXXXXXXXXX",
    "Domain": "d111abcdef8.cloudfront.net",
    "Status": "InProgress"
}
```

Lưu `Id` vào `DIST_ID`, `Domain` vào `DOMAIN`. Status `InProgress` chuyển sang `Deployed` sau ~3–8 phút (CloudFront propagate config tới hàng trăm edge location). Chờ bằng waiter:

```bash
aws cloudfront wait distribution-deployed --id $DIST_ID --region us-east-1
```

### Bước 4: Gắn bucket policy cho OAC

Distribution đã tạo nhưng S3 vẫn từ chối CloudFront vì chưa có policy. Thêm policy chỉ cho service principal `cloudfront.amazonaws.com` GetObject, giới hạn bằng `AWS:SourceArn` là ARN của distribution (chống confused deputy — distribution khác không "mượn" được).

```bash
cat > oac-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AllowCloudFrontOAC",
    "Effect": "Allow",
    "Principal": { "Service": "cloudfront.amazonaws.com" },
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::$BUCKET/*",
    "Condition": {
      "StringEquals": {
        "AWS:SourceArn": "arn:aws:cloudfront::$ACCOUNT_ID:distribution/$DIST_ID"
      }
    }
  }]
}
EOF
aws s3api put-bucket-policy --bucket $BUCKET --policy file://oac-policy.json
```

Test:

```bash
curl -sL https://$DOMAIN/        # => <h1>Hello from CloudFront origin S3</h1>
curl -s  http://$DOMAIN/ -I | head -1   # => HTTP/1.1 301 (redirect-to-https)
curl -s  https://$BUCKET.s3.$AWS_REGION.amazonaws.com/index.html   # => AccessDenied
```

Dòng cuối chứng minh: truy cập trực tiếp bucket bị chặn, chỉ đường CloudFront mới qua.

### Bước 5: Kiểm tra cache hit và behavior /api/*

```bash
curl -sI https://$DOMAIN/ | grep -i x-cache       # lần 1: Miss from cloudfront
curl -sI https://$DOMAIN/ | grep -i x-cache       # lần 2: Hit from cloudfront
curl -s  https://$DOMAIN/api/get | head -c 80      # đi qua api-origin (httpbin)
```

Header `X-Cache: Hit from cloudfront` ở request thứ hai xác nhận edge đã cache object S3. `/api/*` không có header Hit vì CachingDisabled.

### Bước 6: CloudFront Function viết lại URL ở viewer-request

CloudFront Functions chạy ngay tại edge (không phải regional edge cache), cực nhẹ, dùng cho URL rewrite / header manipulation. Tạo function thêm `index.html` vào path thư mục:

```bash
cat > rewrite.js <<'EOF'
function handler(event) {
  var req = event.request;
  if (req.uri.endsWith('/')) { req.uri += 'index.html'; }
  return req;
}
EOF

FUNC_ETAG=$(aws cloudfront create-function \
  --name dva-ch15-rewrite \
  --function-config '{"Comment":"append index.html","Runtime":"cloudfront-js-2.0"}' \
  --function-code fileb://rewrite.js \
  --region us-east-1 --query ETag --output text)

aws cloudfront publish-function --name dva-ch15-rewrite \
  --if-match $FUNC_ETAG --region us-east-1
```

Để gắn vào distribution, thêm khối `FunctionAssociations` (EventType `viewer-request`) vào DefaultCacheBehavior rồi `update-distribution`. Trong lab tự động hoá hạn chế, bạn có thể kiểm thử logic bằng `test-function`:

```bash
aws cloudfront test-function --name dva-ch15-rewrite \
  --if-match $FUNC_ETAG --stage DEVELOPMENT \
  --event-object fileb://<(echo '{"version":"1.0","request":{"uri":"/blog/"}}') \
  --region us-east-1 --query 'TestResult.FunctionOutput'
# => uri trở thành "/blog/index.html"
```

> Nếu cần logic nặng (gọi network, dùng package, > 1ms CPU) thì phải dùng Lambda@Edge thay vì CloudFront Functions (chi tiết so sánh ở mục Exam Tips).

### Bước 7: Signed URL bảo vệ nội dung trả phí

Signed URL cho phép cấp quyền tạm thời truy cập một object qua CloudFront mà không mở public. Cần một **trusted key group**: tạo cặp khoá RSA, upload public key lên CloudFront, ký bằng private key.

```bash
openssl genrsa -out private_key.pem 2048
openssl rsa -pubout -in private_key.pem -out public_key.pem

PUBKEY_ID=$(aws cloudfront create-public-key \
  --public-key-config "{\"CallerReference\":\"k-$(date +%s)\",\"Name\":\"dva-ch15-key\",\"EncodedKey\":\"$(cat public_key.pem)\"}" \
  --region us-east-1 --query PublicKey.Id --output text)

aws cloudfront create-key-group \
  --key-group-config "{\"Name\":\"dva-ch15-kg\",\"Items\":[\"$PUBKEY_ID\"]}" \
  --region us-east-1
```

Sau đó gán key group vào behavior cần bảo vệ (`TrustedKeyGroups`). Ký URL bằng SDK JS v3:

```javascript
// sign.mjs
import { getSignedUrl } from "@aws-sdk/cloudfront-signer";
import { readFileSync } from "node:fs";

const url = getSignedUrl({
  url: `https://${process.env.DOMAIN}/index.html`,
  keyPairId: process.env.PUBKEY_ID,
  privateKey: readFileSync("private_key.pem", "utf8"),
  dateLessThan: new Date(Date.now() + 5 * 60 * 1000).toISOString(), // hết hạn sau 5 phút
});
console.log(url);
```

```bash
DOMAIN=$DOMAIN PUBKEY_ID=$PUBKEY_ID node sign.mjs
```

URL trả về chứa `Policy`, `Signature`, `Key-Pair-Id`. Nếu behavior đã bật TrustedKeyGroups, request không kèm chữ ký hợp lệ sẽ nhận `403 Missing Key-Pair-Id`. **Signed cookie** dùng cùng cơ chế nhưng đặt 3 cookie (`CloudFront-Policy/Signature/Key-Pair-Id`) — phù hợp khi bảo vệ NHIỀU file (cả site) mà không muốn ký từng URL.

### Bước 8: Invalidation

Sau khi cập nhật `index.html`, edge vẫn giữ bản cũ tới hết TTL. Ép xoá cache:

```bash
aws s3 cp index.html s3://$BUCKET/index.html   # phiên bản mới
aws cloudfront create-invalidation \
  --distribution-id $DIST_ID --paths "/index.html" \
  --region us-east-1 --query 'Invalidation.Status'
# => "InProgress"
```

CloudFront cho **1000 path/tháng miễn phí**; vượt là tính tiền theo path. Vì vậy production nên versioning asset (`app.v2.js`) thay vì invalidate liên tục — dùng `/*` chỉ khi thật cần.

### Dọn dẹp tài nguyên

```bash
# Disable distribution trước (bắt buộc), chờ Deployed, rồi mới xoá
ETAG=$(aws cloudfront get-distribution-config --id $DIST_ID --region us-east-1 --query ETag --output text)
aws cloudfront get-distribution-config --id $DIST_ID --region us-east-1 \
  --query DistributionConfig > cfg.json
# Sửa "Enabled": true -> false trong cfg.json rồi:
aws cloudfront update-distribution --id $DIST_ID --region us-east-1 \
  --distribution-config file://cfg.json --if-match $ETAG
aws cloudfront wait distribution-deployed --id $DIST_ID --region us-east-1

ETAG2=$(aws cloudfront get-distribution-config --id $DIST_ID --region us-east-1 --query ETag --output text)
aws cloudfront delete-distribution --id $DIST_ID --if-match $ETAG2 --region us-east-1

# Function, key group, public key, OAC
aws cloudfront delete-function --name dva-ch15-rewrite --if-match $FUNC_ETAG --region us-east-1

# S3
aws s3 rm s3://$BUCKET --recursive && aws s3 rb s3://$BUCKET
rm -f index.html dist-config.json oac-policy.json rewrite.js sign.mjs \
      private_key.pem public_key.pem cfg.json
```

Lưu ý: distribution PHẢI disable + Deployed xong mới xoá được — đây là điểm hay khiến lab "kẹt". Key group muốn xoá phải gỡ khỏi mọi behavior trước.

## 💡 Exam Tips chương 15

- **OAC vs OAI:** OAC (Origin Access Control) là chuẩn mới, ký SigV4, hỗ trợ **SSE-KMS** và mọi region; OAI (Origin Access Identity) là legacy, không dùng được với SSE-KMS. Đề hỏi "S3 bucket private chỉ cho CloudFront đọc, có mã hoá KMS" → **OAC**. Bucket policy phải cho service principal `cloudfront.amazonaws.com` với condition `AWS:SourceArn` = ARN distribution.
- **CloudFront Functions vs Lambda@Edge:** Functions chạy ở edge location, runtime JS thuần, < 1ms, dùng cho **viewer-request/viewer-response**, URL rewrite, header/cookie, A/B redirect, JWT verify đơn giản — siêu rẻ, scale tới hàng triệu req/s. Lambda@Edge chạy ở regional edge cache, hỗ trợ cả 4 event (**viewer-request, origin-request, origin-response, viewer-response**), gọi được network/AWS service, dùng package, tới 5s (viewer) / 30s (origin). Từ khoá "access external resource / heavy logic / origin-request" → Lambda@Edge; "simple URL rewrite, fastest, cheapest" → CloudFront Functions.
- **Signed URL vs Signed Cookie:** Signed URL bảo vệ MỘT file (download trả phí, link tạm). Signed Cookie bảo vệ NHIỀU file / cả thư mục, không phải đổi URL. Cả hai cần **trusted key group** (public key + key group; account-level trusted signer là legacy). So với **S3 presigned URL**: presigned đi thẳng S3, kế thừa quyền IAM của signer; CloudFront signed URL đi qua CDN (có cache, geo restriction, WAF) và ký bằng RSA key pair.
- **Cache key** quyết định một object có là "cache hit" hay không. Mặc định chỉ gồm host + path. Muốn cache theo query string / header / cookie phải khai báo trong **Cache Policy** (`CachePolicyId`). Forward nhưng KHÔNG đưa vào cache key thì dùng **Origin Request Policy**. Đưa thừa thứ vào cache key (ví dụ mọi query string) làm **cache hit ratio tụt** → mỗi biến thể là một object riêng.
- Managed cache policies cần nhớ: **CachingOptimized** (cache theo path, bỏ qua query/cookie, bật compression — cho static asset); **CachingDisabled** (TTL=0 — cho API động); **CachingOptimizedForUncompressedObjects**.
- **TTL:** `DefaultTTL` áp khi origin không gửi `Cache-Control`/`Expires`; `MinTTL`/`MaxTTL` kẹp giá trị origin gửi. Origin gửi `Cache-Control: no-cache` mà MinTTL > 0 thì CloudFront vẫn giữ tối thiểu MinTTL.
- **Invalidation** tốn tiền sau 1000 path/tháng và chậm; production nên **versioning tên file** (cache busting) thay vì invalidate. `/*` xoá toàn bộ nhưng tính là... 1 path (theo cách AWS đếm wildcard) — vẫn nên hạn chế.
- **ViewerProtocolPolicy** (viewer↔CloudFront): `allow-all` / `redirect-to-https` / `https-only`. **OriginProtocolPolicy** (CloudFront↔origin, chỉ custom origin): `http-only` / `https-only` / `match-viewer`. Đề hỏi "ép user dùng HTTPS" → viewer policy `redirect-to-https`.
- **Origin Shield:** thêm một lớp cache trung tâm trước origin, gom request từ nhiều regional edge → tăng cache hit, giảm tải origin. Dùng khi origin ở xa / chi phí origin cao. **Origin Group (origin failover):** primary + secondary, tự chuyển khi primary trả status code cấu hình (500/502/503/504, 403, 404...) — chỉ kích hoạt cho GET/HEAD/OPTIONS.
- **Geo restriction:** allowlist/blocklist theo quốc gia ngay tại CloudFront (dựa GeoIP). Cần kiểm soát chi tiết hơn (theo IP, rate limit, SQLi) thì dùng **AWS WAF** gắn vào distribution.
- **Field-level encryption:** mã hoá field nhạy cảm (số thẻ) bằng public key NGAY tại edge trước khi forward về origin; chỉ service có private key giải mã được — dữ liệu nhạy cảm không bao giờ ở dạng plaintext trong hệ thống.
- **Price Class** giới hạn tập edge location (All / 200 / 100) để giảm chi phí — đánh đổi latency ở vùng bị loại. **Real-time logs** (gửi qua Kinesis Data Streams) khác **standard logs** (vào S3, trễ): hỏi "phân tích traffic theo thời gian thực" → real-time logs.

## Quiz chương 15 (10 câu)

**Câu 1.** Một developer host static website trên S3 bucket private và phân phối qua CloudFront. Bucket bật default encryption SSE-KMS. Yêu cầu: chỉ CloudFront được đọc object, không ai vào bucket trực tiếp. Giải pháp nào ĐÚNG?
- A. Origin Access Identity (OAI) + bucket policy cho OAI
- B. Origin Access Control (OAC) + bucket policy cho service principal cloudfront.amazonaws.com với condition AWS:SourceArn
- C. Bật public read trên bucket và dựa vào CloudFront geo restriction
- D. Dùng signed URL cho mọi object

**Câu 2.** Một site bán khoá học cần cấp quyền tạm thời cho user xem hàng TRĂM video sau khi thanh toán, không muốn ký lại từng URL mỗi lần phát. Cơ chế nào phù hợp nhất?
- A. CloudFront signed URL cho từng video
- B. CloudFront signed cookie
- C. S3 presigned URL
- D. Public distribution + WAF

**Câu 3.** Developer cần viết lại URL request (thêm `index.html` vào path thư mục) với chi phí và độ trễ thấp nhất, không gọi service ngoài. Dùng gì?
- A. Lambda@Edge ở origin-request
- B. Lambda@Edge ở viewer-request
- C. CloudFront Function ở viewer-request
- D. Mapping template trong API Gateway

**Câu 4.** Một API động trả về dữ liệu cá nhân hoá theo header `Authorization`. Sau khi đưa lên CloudFront, mọi user thấy chung một response. Nguyên nhân và cách sửa?
- A. Origin lỗi — sửa code origin
- B. Cache key mặc định không gồm header Authorization; cần cache policy forward header đó hoặc dùng CachingDisabled
- C. Thiếu OAC
- D. Thiếu signed cookie

**Câu 5.** Distribution có 2 origin: ALB primary và S3 secondary. Khi ALB trả 503, muốn CloudFront tự phục vụ từ S3. Cấu hình gì?
- A. Origin Shield
- B. Weighted routing trong Route 53
- C. Origin Group (origin failover) với failover criteria gồm 503
- D. Lambda@Edge origin-response

**Câu 6.** Một developer deploy `app.js` mới lên S3 nhưng user vẫn nhận bản cũ trong 24 giờ. Cách BỀN VỮNG nhất để tránh lặp lại vấn đề?
- A. Tạo invalidation `/*` sau mỗi deploy
- B. Đặt DefaultTTL = 0
- C. Versioning tên file (app.<hash>.js) — cache busting
- D. Tắt CloudFront cho file JS

**Câu 7.** Yêu cầu: chỉ user từ Việt Nam và Singapore được truy cập, mọi quốc gia khác chặn. Cách đơn giản nhất tại CloudFront?
- A. AWS WAF với rule IP
- B. CloudFront geo restriction allowlist VN, SG
- C. Lambda@Edge kiểm tra IP
- D. Bucket policy với condition aws:SourceIp

**Câu 8.** Một developer cần mã hoá số thẻ tín dụng NGAY tại edge để origin và mọi service trung gian không bao giờ thấy plaintext, chỉ hệ thống thanh toán giải mã được. Dùng gì?
- A. SSE-KMS trên origin
- B. CloudFront field-level encryption
- C. HTTPS viewer-protocol-policy
- D. Signed URL

**Câu 9.** Team cần phân tích traffic CloudFront theo thời gian gần thực để phát hiện tấn công, đẩy log vào pipeline xử lý ngay. Chọn gì?
- A. Standard access logs vào S3
- B. CloudWatch metrics mặc định
- C. Real-time logs gửi qua Kinesis Data Streams
- D. CloudTrail data events

**Câu 10.** Một developer thấy cache hit ratio rất thấp dù nội dung tĩnh không đổi. Distribution forward TẤT CẢ query string vào cache key. Khắc phục?
- A. Bật Origin Shield
- B. Chuyển cache policy sang chỉ đưa các query string cần thiết (hoặc không) vào cache key
- C. Tăng MaxTTL
- D. Thêm origin thứ hai

### Đáp án & giải thích

**Câu 1 — Đáp án B.** OAC ký SigV4 và hỗ trợ SSE-KMS — đúng yêu cầu bucket mã hoá KMS. A sai vì OAI là legacy, KHÔNG dùng được với SSE-KMS. C sai vì mở public read phá yêu cầu "không ai vào trực tiếp", geo restriction không bảo vệ bucket. D sai: signed URL bảo vệ truy cập qua CloudFront chứ không giải quyết việc chặn truy cập trực tiếp bucket.

**Câu 2 — Đáp án B.** Signed cookie bảo vệ nhiều file / cả thư mục mà không phải đổi URL từng video — đúng nhu cầu "hàng trăm video". A đúng cơ chế nhưng phải ký từng URL, vận hành nặng. C sai: S3 presigned đi thẳng S3, mất lợi ích CDN (cache, geo, WAF) và yêu cầu là phân phối qua CloudFront. D sai: public distribution mở nội dung cho mọi người, WAF không thay được cơ chế cấp quyền theo user đã thanh toán.

**Câu 3 — Đáp án C.** CloudFront Function ở viewer-request là phương án nhẹ nhất, rẻ nhất cho URL rewrite không cần network. A/B (Lambda@Edge) dùng được nhưng nặng và tốn hơn, thừa cho tác vụ đơn giản. D sai vì API Gateway không liên quan tới việc rewrite path ở CDN.

**Câu 4 — Đáp án B.** Cache key mặc định chỉ gồm host+path, KHÔNG gồm header → mọi user dùng chung cache. Sửa bằng cách forward `Authorization` vào cache key (cache policy) hoặc tắt cache (CachingDisabled) cho nội dung cá nhân hoá. A sai vì origin đúng, vấn đề là caching. C sai: OAC chỉ liên quan truy cập S3 origin. D sai: signed cookie là cơ chế phân quyền, không liên quan cache key.

**Câu 5 — Đáp án C.** Origin Group (origin failover) chuyển sang secondary khi primary trả status code cấu hình (gồm 503), chỉ cho GET/HEAD/OPTIONS. A sai: Origin Shield tăng cache hit, không phải failover. B sai: Route 53 failover ở tầng DNS, không phải trong distribution. D sai: Lambda@Edge có thể tự code failover nhưng phức tạp và không phải cơ chế chuẩn.

**Câu 6 — Đáp án C.** Versioning tên file (cache busting) khiến mỗi deploy là URL mới → edge luôn fetch bản mới, không tốn invalidation, không chờ TTL. A tốn tiền (sau 1000 path/tháng) và chậm, phải làm thủ công mỗi lần. B làm mất hoàn toàn lợi ích cache. D phá kiến trúc CDN.

**Câu 7 — Đáp án B.** Geo restriction allowlist ngay tại CloudFront là cách đơn giản nhất theo quốc gia. A dùng được nhưng WAF rule IP phức tạp hơn cho bài toán theo quốc gia. C thừa và đắt. D sai: bucket policy không kiểm soát truy cập qua CloudFront theo quốc gia (request đến từ IP của edge).

**Câu 8 — Đáp án B.** Field-level encryption mã hoá field cụ thể bằng public key tại edge; chỉ service có private key giải mã. A bảo vệ at-rest trên origin chứ không che plaintext khỏi origin/trung gian. C chỉ mã hoá in-transit, origin vẫn thấy plaintext. D không mã hoá nội dung field.

**Câu 9 — Đáp án C.** Real-time logs đẩy qua Kinesis Data Streams cho phép xử lý gần thực — đúng nhu cầu phát hiện tấn công. A (standard logs vào S3) trễ vài phút–giờ. B chỉ là metric tổng hợp, không chi tiết request. D ghi API-level về quản trị distribution, không phải traffic viewer.

**Câu 10 — Đáp án B.** Đưa MỌI query string vào cache key tạo vô số biến thể object → hit ratio tụt. Chỉ giữ query string thực sự ảnh hưởng nội dung (hoặc loại bỏ hết) sẽ tăng hit. A giảm tải origin nhưng không sửa gốc rễ phân mảnh cache key. C tăng TTL không giúp khi mỗi URL là một key khác nhau. D không liên quan.

## Tóm tắt chương

- CloudFront là CDN: cache nội dung tại **edge location** gần user, giảm latency và tải origin; mọi API CloudFront là **global, gọi ở us-east-1**.
- **OAC** (chuẩn mới, SigV4, hỗ trợ SSE-KMS) thay **OAI** (legacy) để cho CloudFront đọc S3 bucket private; bucket policy dùng service principal `cloudfront.amazonaws.com` + condition `AWS:SourceArn`.
- Origin có thể là **S3 (S3OriginConfig + OAC)** hoặc **custom origin** (ALB/EC2/HTTP endpoint, có `OriginProtocolPolicy`).
- **Cache behavior theo path pattern** trỏ origin khác nhau và gắn cache/origin-request policy riêng; `/api/*` thường dùng **CachingDisabled**, static dùng **CachingOptimized**.
- **Cache key** quyết định hit/miss — mặc định chỉ host+path; thêm query/header/cookie qua **Cache Policy**; forward-mà-không-cache qua **Origin Request Policy**.
- **TTL:** DefaultTTL khi origin không gửi Cache-Control; MinTTL/MaxTTL kẹp giá trị origin.
- **Invalidation** chậm và tốn tiền sau 1000 path/tháng → ưu tiên **versioning tên file** (cache busting).
- **Signed URL** (một file) vs **signed cookie** (nhiều file/thư mục) qua **trusted key group**; khác **S3 presigned URL** (đi thẳng S3, quyền IAM).
- **CloudFront Functions** (edge, JS nhẹ, viewer-request/response) vs **Lambda@Edge** (regional edge, 4 event, network/package, nặng hơn).
- **Origin failover** (Origin Group, GET/HEAD/OPTIONS), **Origin Shield** (lớp cache trung tâm tăng hit), **geo restriction** (theo quốc gia), **WAF** (IP/rate/SQLi).
- **ViewerProtocolPolicy** ép HTTPS phía viewer (`redirect-to-https`); **field-level encryption** che field nhạy cảm khỏi origin.
- **Real-time logs** (qua Kinesis) cho phân tích gần thực; **standard logs** (S3) trễ; **Price Class** giới hạn edge để giảm chi phí.
