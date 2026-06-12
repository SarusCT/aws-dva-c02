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
