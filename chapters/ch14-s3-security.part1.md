# Chương 14: Amazon S3 Security

> **Trọng tâm DVA-C02:** S3 Security là một trong những chủ đề xuất hiện dày đặc nhất ở domain Security (26% đề thi). Dạng câu hỏi điển hình: chọn đúng loại server-side encryption cho yêu cầu cụ thể (audit trail → SSE-KMS, tự quản key → SSE-C), viết/đọc bucket policy ép HTTPS hoặc ép encryption header, xử lý lỗi CORS, presigned URL hết hạn hoặc bị AccessDenied, và phân biệt Object Lock retention modes. Bạn cần thuộc chính xác các header `x-amz-server-side-encryption` và cơ chế đánh giá quyền khi nhiều lớp policy chồng nhau.

## Mục tiêu chương

- Phân biệt rạch ròi 4 phương án encryption at rest của S3 (SSE-S3, SSE-KMS, SSE-C, client-side encryption): cơ chế bên dưới, header bắt buộc, ưu nhược điểm và bẫy thi.
- Hiểu S3 Bucket Key giảm chi phí KMS như thế nào và vì sao SSE-KMS có thể gây throttling.
- Viết được bucket policy ép HTTPS (`aws:SecureTransport`) và ép encryption khi upload; hiểu thứ tự đánh giá với Block Public Access.
- Nắm cơ chế presigned URL: ai ký, quyền của ai, thời hạn tối đa theo từng loại credentials, và các lỗi kinh điển.
- Cấu hình CORS đúng và chẩn đoán lỗi preflight; hiểu MFA Delete bảo vệ versioned bucket.
- Sử dụng Access Points, Object Lambda, Object Lock (Compliance vs Governance) và access logs đúng tình huống.

## 14.1 Bức tranh tổng thể: các lớp bảo vệ dữ liệu trên S3

Trước khi đi vào chi tiết, hãy xếp các cơ chế bảo mật S3 thành 4 lớp — đề thi thường mô tả một yêu cầu và bắt bạn chọn đúng lớp:

1. **Encryption at rest** — dữ liệu nằm trên đĩa của AWS được mã hóa: SSE-S3, SSE-KMS (kèm DSSE-KMS), SSE-C, hoặc client-side encryption.
2. **Encryption in transit** — dữ liệu trên đường truyền: HTTPS/TLS, ép buộc bằng bucket policy với condition `aws:SecureTransport`.
3. **Access control** — ai được làm gì: IAM policies (identity-based), bucket policies (resource-based), ACLs (legacy, nên disable), Block Public Access, Access Points.
4. **Data protection & audit** — chống xóa/sửa và truy vết: versioning, MFA Delete, Object Lock, server access logs, CloudTrail data events.

Một nguyên tắc nền tảng cần nhớ: với server-side encryption (SSE), **việc mã hóa xảy ra ở phía S3 sau khi nhận object và giải mã trước khi trả về** — ứng dụng của bạn không phải viết code mã hóa. Với client-side encryption, dữ liệu được mã hóa **trước khi rời máy bạn** và S3 chỉ lưu ciphertext mà không hề biết nội dung.

> 💡 **Exam Tip:** Từ tháng 1/2023, S3 **tự động mã hóa mọi object mới bằng SSE-S3** làm mặc định cho tất cả bucket — không thể tắt encryption hoàn toàn, chỉ có thể đổi sang SSE-KMS/DSSE-KMS. Câu hỏi "làm sao đảm bảo mọi object được mã hóa với ít effort nhất" → đáp án thường là "không cần làm gì / bật default encryption", không phải viết bucket policy phức tạp.

## 14.2 Server-Side Encryption: SSE-S3, SSE-KMS và DSSE-KMS

### SSE-S3 (SSE với key do S3 quản lý)

- Thuật toán **AES-256**. Key do S3 tạo, quản lý và rotate hoàn toàn tự động — bạn không bao giờ thấy key.
- Header khi upload: `x-amz-server-side-encryption: AES256`. Đây là mặc định, nên thực tế không cần gửi header cũng được mã hóa.
- Mỗi object được mã hóa bằng một data key riêng; data key lại được mã hóa bằng root key mà S3 rotate định kỳ (envelope encryption ở mức S3 tự lo).
- **Không có audit trail riêng cho việc dùng key**, không kiểm soát được ai được "dùng key" — quyền truy cập object đồng nghĩa quyền giải mã.

```bash
# Upload với SSE-S3 (chỉ định tường minh)
aws s3api put-object \
  --bucket my-secure-bucket \
  --key docs/report.pdf \
  --body report.pdf \
  --server-side-encryption AES256
```

### SSE-KMS (SSE với key trong AWS KMS)

- Header: `x-amz-server-side-encryption: aws:kms`, kèm tùy chọn `x-amz-server-side-encryption-aws-kms-key-id` để chỉ định customer managed key. Nếu không chỉ định key, S3 dùng **AWS managed key `aws/s3`**.
- Cơ chế: khi upload, S3 gọi KMS API `GenerateDataKey` để lấy data key; khi download, S3 gọi `Decrypt` để giải mã data key rồi giải mã object. (Chi tiết về envelope encryption và KMS APIs ở Chương 46.)
- Lợi ích so với SSE-S3: **kiểm soát key độc lập với quyền object** (user phải có cả quyền S3 lẫn quyền `kms:Decrypt` mới đọc được), **audit trail trong CloudTrail** mỗi lần key được dùng, tự chọn rotation policy với customer managed key.
- Nhược điểm: tốn phí KMS API call và **chịu KMS request quota** — mặc định 5.500 / 10.000 / 50.000 requests/giây tùy region (có thể xin tăng qua Service Quotas). Bucket có traffic rất cao dùng SSE-KMS có thể nhận `ThrottlingException` từ KMS dù S3 vẫn khỏe.

```javascript
// AWS SDK JS v3 — upload object với SSE-KMS dùng customer managed key
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({ region: "ap-southeast-1" });

await s3.send(new PutObjectCommand({
  Bucket: "my-secure-bucket",
  Key: "invoices/2026/inv-001.json",
  Body: JSON.stringify({ total: 1200 }),
  ServerSideEncryption: "aws:kms",                       // chọn SSE-KMS
  SSEKMSKeyId: "arn:aws:kms:ap-southeast-1:111122223333:key/1234abcd-...",
  BucketKeyEnabled: true,                                // bật S3 Bucket Key (giảm phí KMS)
}));
```

### S3 Bucket Key — giảm 99% chi phí KMS

Bình thường, **mỗi object** dùng SSE-KMS sinh ít nhất một call `GenerateDataKey` (upload) và `Decrypt` (download). Với **S3 Bucket Key**, S3 gọi KMS một lần để lấy một **bucket-level key có thời hạn ngắn**, rồi dùng key đó sinh data key cho nhiều object **mà không phải gọi KMS lại mỗi lần**. Kết quả: giảm tới ~99% lượng request đến KMS → giảm chi phí lẫn nguy cơ throttling. Bật bằng thuộc tính `BucketKeyEnabled` ở mức bucket (default encryption) hoặc từng request. Trade-off duy nhất đáng nhớ: CloudTrail sẽ ghi ít event KMS hơn (event mang context của bucket thay vì từng object), nên audit trail per-object thưa hơn.

### DSSE-KMS (Dual-layer SSE)

`x-amz-server-side-encryption: aws:kms:dsse` — mã hóa **hai lớp độc lập** ở phía server, đáp ứng chuẩn compliance khắt khe (CNSSP-15). Với DVA-C02 chỉ cần nhận diện: "dual-layer encryption at rest theo yêu cầu compliance" → DSSE-KMS.

> 💡 **Exam Tip:** Câu hỏi gài kinh điển: "công ty cần audit lại việc sử dụng encryption key và tự kiểm soát rotation" → **SSE-KMS với customer managed key** (SSE-S3 không có CloudTrail trail cho key, AWS managed key `aws/s3` không tự cấu hình rotation được). Còn "ứng dụng upload hàng chục nghìn object/giây dùng SSE-KMS bị throttle" → bật **S3 Bucket Key** hoặc xin tăng KMS quota.

## 14.3 SSE-C và Client-Side Encryption

### SSE-C (SSE với key do khách hàng cung cấp)

Bạn tự quản lý key, nhưng **việc mã hóa vẫn diễn ra phía AWS**: bạn gửi key kèm theo **từng request** (cả upload lẫn download), S3 dùng key đó mã hóa/giải mã rồi **không lưu key** — chỉ lưu một HMAC ngẫu nhiên hóa để xác thực key trong các request sau. Mất key = mất dữ liệu vĩnh viễn.

Yêu cầu kỹ thuật phải thuộc:

- **Bắt buộc HTTPS** — gửi key qua HTTP sẽ bị từ chối.
- Headers mỗi request: `x-amz-server-side-encryption-customer-algorithm: AES256`, `x-amz-server-side-encryption-customer-key` (base64), `x-amz-server-side-encryption-customer-key-MD5`.
- **Không dùng được qua S3 Console** để đọc object (console không có chỗ nhập key); presigned URL cho object SSE-C phải kèm key trong header khi client gọi.

```bash
# Upload với SSE-C bằng CLI v2
aws s3 cp secret.db s3://my-secure-bucket/secret.db \
  --sse-c AES256 \
  --sse-c-key fileb://./my-32-byte-key.bin

# Download: PHẢI cung cấp lại đúng key đó
aws s3 cp s3://my-secure-bucket/secret.db ./secret.db \
  --sse-c AES256 \
  --sse-c-key fileb://./my-32-byte-key.bin
```

### Client-Side Encryption (CSE)

Ứng dụng **tự mã hóa trước khi gửi** và tự giải mã sau khi nhận — S3 chỉ thấy ciphertext. Thường dùng **AWS Encryption SDK** hoặc S3 Encryption Client, kết hợp KMS làm key provider hoặc key tự quản hoàn toàn. Chọn CSE khi yêu cầu là "dữ liệu phải được mã hóa **trước khi rời môi trường của công ty**" hoặc "AWS không bao giờ được thấy plaintext".

### Bảng so sánh 4 phương án encryption

| Tiêu chí | SSE-S3 | SSE-KMS | SSE-C | Client-side |
|---|---|---|---|---|
| Ai quản lý key | S3 | KMS (AWS hoặc bạn tạo CMK) | Bạn (gửi kèm request) | Bạn (hoặc KMS) |
| Nơi mã hóa | Server | Server | Server | Client |
| Header chính | `AES256` | `aws:kms` | `...customer-key` ×3 | Không (S3 thấy bytes thường) |
| Audit dùng key (CloudTrail) | Không | **Có** | Không | Tùy (có nếu dùng KMS) |
| Phí/quota thêm | Không | Phí + quota KMS API | Không | Không (trừ KMS calls) |
| Bắt buộc HTTPS | Không | Không | **Có** | N/A |
| Rủi ro chính | Ít kiểm soát | KMS throttling | Mất key = mất data | Tự code, dễ sai |

> 💡 **Exam Tip:** Ghi nhớ nhanh theo từ khóa đề: "AWS handles everything" → SSE-S3; "audit key usage / control rotation / extra permission layer" → SSE-KMS; "company must manage keys but doesn't want to write encryption code / key must not be stored on AWS" → SSE-C; "data must be encrypted before leaving the application" → client-side.

## 14.4 Encryption in transit, default encryption và bucket policy ép buộc

### Ép HTTPS với `aws:SecureTransport`

S3 expose cả endpoint HTTP lẫn HTTPS. Để ép mọi truy cập đi qua TLS, dùng bucket policy **Deny** với condition `aws:SecureTransport: false`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyInsecureTransport",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::my-secure-bucket",
        "arn:aws:s3:::my-secure-bucket/*"
      ],
      "Condition": { "Bool": { "aws:SecureTransport": "false" } }
    }
  ]
}
```

Lưu ý cú pháp hay bị gài: phải là **Deny + SecureTransport=false**, không phải Allow + SecureTransport=true (Allow không chặn được đường HTTP nếu một policy khác đã cho phép — nhớ lại policy evaluation logic Chương 2: explicit deny thắng tất cả).

### Ép encryption header khi upload

Trước thời default encryption, pattern kinh điển là deny `s3:PutObject` nếu thiếu header. Đề thi vẫn hỏi dạng này, ví dụ ép mọi upload phải dùng SSE-KMS:

```json
{
  "Sid": "DenyWrongEncryptionHeader",
  "Effect": "Deny",
  "Principal": "*",
  "Action": "s3:PutObject",
  "Resource": "arn:aws:s3:::my-secure-bucket/*",
  "Condition": {
    "StringNotEquals": { "s3:x-amz-server-side-encryption": "aws:kms" }
  }
}
```

Cẩn thận bẫy thực tế: condition `StringNotEquals` ở trên **không match khi header vắng mặt hoàn toàn** trong một số biến thể policy — nếu muốn chặn cả request không gửi header, cần thêm statement dùng `"Null": { "s3:x-amz-server-side-encryption": "true" }`. Tuy nhiên với default encryption hiện tại, object thiếu header vẫn được mã hóa theo cấu hình mặc định của bucket, nên policy ép header chủ yếu để **ép đúng loại** encryption (ví dụ bắt buộc KMS thay vì SSE-S3).

### Default encryption ở mức bucket

```bash
aws s3api put-bucket-encryption \
  --bucket my-secure-bucket \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "aws:kms",
        "KMSMasterKeyID": "arn:aws:kms:ap-southeast-1:111122223333:key/1234abcd-..."
      },
      "BucketKeyEnabled": true
    }]
  }'
```

Default encryption áp cho **object mới**; object đã tồn tại trước đó không tự được mã hóa lại (muốn vậy phải copy-in-place hoặc dùng S3 Batch Operations — chi tiết ở Chương 13). Header trong request luôn **override** cấu hình mặc định.

## 14.5 Bucket Policies, Block Public Access và logic đánh giá quyền

### Bucket policy — resource-based policy của S3

Bucket policy là JSON policy gắn vào bucket, có `Principal` (khác với identity-based policy). Ba use case lớn: (1) cấp public read cho static website, (2) **cross-account access** mà không cần tạo role, (3) ép điều kiện bảo mật (HTTPS, encryption, source VPC/IP) bằng Deny.

Logic quyết định một request có được phép (đầy đủ ở Chương 2 và 45), rút gọn cho S3:

1. Có **explicit Deny** ở bất kỳ đâu (IAM policy, bucket policy, SCP) → từ chối, hết chuyện.
2. Cùng account: chỉ cần **một** Allow ở IAM policy *hoặc* bucket policy là đủ.
3. Cross-account: cần Allow ở **cả hai phía** — IAM policy của account gọi *và* bucket policy của account sở hữu bucket.

### Block Public Access (BPA)

BPA là "cầu dao tổng" chặn public access, **mặc định bật cả 4 cờ** cho bucket mới, hoạt động ở 2 cấp: account và bucket. Bốn cờ:

| Cờ | Tác dụng |
|---|---|
| `BlockPublicAcls` | Từ chối PUT object/bucket kèm public ACL |
| `IgnorePublicAcls` | Bỏ qua (vô hiệu hóa) mọi public ACL đang tồn tại |
| `BlockPublicPolicy` | Từ chối PUT bucket policy có yếu tố public |
| `RestrictPublicBuckets` | Bucket có public policy chỉ còn truy cập được bởi principal trong account/AWS services |

Điểm then chốt: BPA **override mọi Allow public** trong policy/ACL. Đây là đáp án cho câu "đã thêm bucket policy public read mà vẫn AccessDenied" — kiểm tra BPA ở cả mức bucket **và mức account** (cờ account thắng cờ bucket).

```bash
# Tắt BPA mức bucket (chỉ làm khi thật sự cần public, vd static website)
aws s3api put-public-access-block \
  --bucket my-website-bucket \
  --public-access-block-configuration \
  BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false
```

Về **ACLs**: từ tháng 4/2023 bucket mới mặc định `Object Ownership = Bucket owner enforced`, tức **ACL bị disable hoàn toàn** — mọi quyền quản bằng policy. Best practice và cũng là đáp án thi: giữ ACL disabled, dùng bucket policy.

> 💡 **Exam Tip:** "Objects uploaded by another account are not accessible to the bucket owner" — câu hỏi cũ về ACL ownership; đáp án hiện đại là bật **Bucket owner enforced** (Object Ownership) để bucket owner sở hữu mọi object, thay cho yêu cầu `bucket-owner-full-control` ACL ngày xưa.

## 14.6 Presigned URLs — chi tiết cơ chế và bẫy

Presigned URL là URL chứa sẵn chữ ký **SigV4**, cho phép người cầm URL thực hiện đúng **một operation trên một object** (GET để chia sẻ download, PUT để cho phép upload) trong thời gian giới hạn — không cần AWS credentials. (Giới thiệu cơ bản ở Chương 12; phần này đi sâu phần đề thi hay xoáy.)

Cơ chế cốt lõi: **URL thừa hưởng quyền của credentials đã ký nó**. S3 không "cấp quyền mới" — khi request đến, S3 xác minh chữ ký rồi đánh giá quyền **của người ký tại thời điểm request**. Suy ra ba hệ quả thi hay hỏi:

1. Người ký không có `s3:GetObject` → URL trả về AccessDenied dù chữ ký hợp lệ.
2. **Revoke quyền của người ký (hoặc xóa IAM user/role) → mọi URL đã ký vô hiệu ngay**, kể cả chưa hết hạn.
3. URL ký bởi **temporary credentials** (role, STS) chết khi **session hết hạn**, dù `expiresIn` đặt dài hơn.

Giới hạn thời hạn phải thuộc:

| Loại credentials ký | Thời hạn tối đa hiệu lực |
|---|---|
| IAM user (long-term access key) | **7 ngày** (604800 giây) với SigV4 |
| IAM role / temporary credentials | Đến khi **session credentials hết hạn** (role mặc định 1h, max 12h) |
| Console tạo presigned URL | Tối đa 12 giờ |

```javascript
// SDK JS v3 — tạo presigned URL cho GET và PUT
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({ region: "ap-southeast-1" });

// URL download, hết hạn sau 15 phút
const downloadUrl = await getSignedUrl(
  s3,
  new GetObjectCommand({ Bucket: "my-secure-bucket", Key: "reports/q1.pdf" }),
  { expiresIn: 900 }
);

// URL upload — client PHẢI gửi đúng Content-Type đã ký
const uploadUrl = await getSignedUrl(
  s3,
  new PutObjectCommand({
    Bucket: "my-secure-bucket",
    Key: "uploads/avatar.png",
    ContentType: "image/png",   // tham số nào đưa vào lệnh ký thì request thật phải khớp
  }),
  { expiresIn: 300 }
);
```

```bash
# CLI chỉ tạo được URL GET
aws s3 presign s3://my-secure-bucket/reports/q1.pdf --expires-in 3600
```

Bẫy thực tế khi presigned PUT: mọi tham số nằm trong chữ ký (Content-Type, metadata, `x-amz-server-side-encryption`...) **phải được client gửi lại y nguyên** dưới dạng header, nếu không sẽ `SignatureDoesNotMatch`. Và nếu bucket policy ép SSE-KMS, lệnh ký phải kèm `ServerSideEncryption: "aws:kms"` để client upload không bị deny.

> 💡 **Exam Tip:** Phân biệt presigned URL với **CloudFront signed URL** (Chương 15): presigned URL gắn với một object S3 và quyền người ký, phù hợp chia sẻ tạm thời/upload trực tiếp; CloudFront signed URL/cookies phục vụ phân phối nội dung qua CDN với key pair riêng. Câu "cho phép user upload trực tiếp lên S3 không qua backend, không lộ credentials" → presigned PUT URL (hoặc Identity Pool credentials — Chương 39).

## 14.7 CORS — Cross-Origin Resource Sharing

CORS là cơ chế **của trình duyệt**: khi JavaScript ở origin A (`https://app.example.com`) gọi tài nguyên ở origin B (`https://bucket.s3.ap-southeast-1.amazonaws.com`), trình duyệt yêu cầu origin B phải trả về header `Access-Control-Allow-Origin` khớp origin A, nếu không sẽ chặn response. Với request "không đơn giản" (PUT, custom header...), trình duyệt gửi trước **preflight request** `OPTIONS` kèm `Origin` và `Access-Control-Request-Method` — S3 phải trả về các header CORS tương ứng thì request thật mới được gửi.

Hai điểm hay nhầm:

- CORS **không phải cơ chế bảo mật phía server** — nó không chặn curl/Postman; nó chỉ là quy tắc trình duyệt. Lỗi CORS không phải lỗi quyền IAM.
- Cấu hình CORS đặt ở **bucket bị gọi chéo origin** (bucket B), không phải ở web origin A.

```json
[
  {
    "AllowedOrigins": ["https://app.example.com"],
    "AllowedMethods": ["GET", "PUT"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag", "x-amz-version-id"],
    "MaxAgeSeconds": 3600
  }
]
```

```bash
aws s3api put-bucket-cors --bucket my-assets-bucket \
  --cors-configuration file://cors.json
```

`AllowedOrigins` phải khớp **chính xác scheme + host + port** (`https://app.example.com` ≠ `http://app.example.com`); wildcard chỉ được một dấu `*`. `ExposeHeaders` cần khai báo nếu JS muốn đọc header như `ETag` (quan trọng khi làm multipart upload từ browser). `MaxAgeSeconds` cho phép trình duyệt cache kết quả preflight, giảm số request OPTIONS.

Tình huống kinh điểu trong đề và thực tế: web app upload thẳng lên S3 bằng presigned PUT URL bị lỗi *"blocked by CORS policy: Response to preflight request doesn't pass access control check"* → thêm CORS configuration cho bucket với `AllowedMethods: ["PUT"]` và đúng origin. Presigned URL hợp lệ **không miễn trừ** CORS.

> 💡 **Exam Tip:** Thấy từ khóa "web application hosted on one domain fetches resources from an S3 bucket" + lỗi trên browser → đáp án là cấu hình CORS trên bucket đích. Đừng chọn bucket policy hay IAM — đề cố tình đặt các lựa chọn đó để gài.

## 14.8 MFA Delete

MFA Delete là lớp bảo vệ bổ sung cho **versioned bucket**: yêu cầu mã MFA cho hai thao tác phá hủy:

- **Xóa vĩnh viễn một object version** (`DeleteObject` kèm `versionId`).
- **Tắt (suspend) versioning** trên bucket.

Các thao tác không cần MFA: bật versioning, xóa object *không kèm versionId* (chỉ tạo delete marker — khôi phục được), list versions.

Ràng buộc vận hành phải nhớ vì đề rất hay hỏi:

- Chỉ bật/tắt được bởi **root account** của bucket owner, và **chỉ qua CLI/API/SDK** — không có nút trên console.
- Bucket **bắt buộc đã bật versioning** (MFA Delete là thuộc tính của versioning configuration).

```bash
# Bật MFA Delete — chạy với credentials của ROOT, kèm serial MFA + mã hiện tại
aws s3api put-bucket-versioning \
  --bucket my-critical-bucket \
  --versioning-configuration Status=Enabled,MFADelete=Enabled \
  --mfa "arn:aws:iam::111122223333:mfa/root-mfa-device 123456"
```

> 💡 **Exam Tip:** "Prevent accidental permanent deletion of objects, requiring extra verification" → MFA Delete. Nhưng nếu đề nói "prevent deletion or modification for a fixed period / regulatory compliance (WORM)" → đó là **Object Lock** (mục 14.10), không phải MFA Delete.

## 14.9 S3 Access Points và Object Lambda

### Access Points

Khi một bucket dữ liệu chung phục vụ hàng chục ứng dụng/team, bucket policy phình to và khó quản. **Access Point** giải quyết bằng cách tạo nhiều "cửa vào" cho cùng một bucket, mỗi cửa có:

- **Hostname/ARN riêng** (`arn:aws:s3:ap-southeast-1:111122223333:accesspoint/finance-ap`).
- **Access point policy riêng** — giống bucket policy nhưng scope theo access point, thường giới hạn prefix (`/finance/*`) và principal cụ thể.
- Tùy chọn **giới hạn network origin vào một VPC** (`--vpc-configuration`) — chỉ truy cập được từ trong VPC đó, kết hợp VPC endpoint (Chương 11).

Để mọi quyền thực sự dồn về access point, đặt bucket policy **delegate**: cho phép mọi action khi `s3:DataAccessPointAccount` = account của bạn, từ đó việc phân quyền chi tiết chỉ còn nằm ở từng access point policy.

```bash
aws s3control create-access-point \
  --account-id 111122223333 \
  --name finance-ap \
  --bucket my-data-lake \
  --vpc-configuration VpcId=vpc-0abc1234

# Dùng access point ARN thay bucket name trong API call
aws s3api get-object \
  --bucket arn:aws:s3:ap-southeast-1:111122223333:accesspoint/finance-ap \
  --key finance/2026/ledger.csv ledger.csv
```

### S3 Object Lambda

Object Lambda đặt một **Lambda function chắn giữa GET/LIST/HEAD và object gốc**: client gọi qua **Object Lambda Access Point**, S3 lấy object qua một supporting access point, đưa cho Lambda **biến đổi nội dung on-the-fly**, rồi Lambda trả kết quả về client bằng API `WriteGetObjectResponse`. Use case kinh điển trong đề:

- **Redact/mask PII** trước khi trả cho ứng dụng analytics (cùng một object gốc, app khác thấy dữ liệu khác).
- Convert format (XML→JSON), resize ảnh theo caller, enrich dữ liệu từ nguồn khác.

Giá trị cốt lõi để chọn đáp án: **không cần tạo và duy trì bản sao dữ liệu cho từng consumer** — một bản gốc, nhiều "view" qua nhiều Object Lambda Access Point. Kiến trúc chuỗi: Client → Object Lambda Access Point → Lambda → Supporting Access Point → Bucket.

> 💡 **Exam Tip:** "Return a modified/redacted version of the object to specific applications **without duplicating data**" → S3 Object Lambda. Nếu đề chỉ cần lọc *bớt dòng/cột* của file CSV/JSON bằng SQL đơn giản → cân nhắc S3 Select (Chương 13) — rẻ và đơn giản hơn; Object Lambda dành cho biến đổi tùy ý bằng code.

## 14.10 S3 Object Lock, Glacier Vault Lock và Server Access Logs

### S3 Object Lock — WORM cho object

Object Lock cung cấp mô hình **WORM (Write Once Read Many)**: object version không thể bị xóa hay ghi đè trong thời gian quy định. Điều kiện tiên quyết: **chỉ bật được lúc tạo bucket** (hoặc nhờ AWS Support bật cho bucket có sẵn) và **bắt buộc versioning**. Lock áp lên **từng object version**, gồm hai cơ chế:

**Retention period** (khoảng thời gian giữ) với 2 mode:

| | Governance mode | Compliance mode |
|---|---|---|
| Ai có thể xóa/ghi đè trong kỳ retention | User có quyền đặc biệt `s3:BypassGovernanceRetention` (kèm header `x-amz-bypass-governance-retention:true`) | **Không một ai — kể cả root account** |
| Rút ngắn retention / đổi mode | Được (với quyền bypass) | **Không thể** đến khi hết hạn |
| Use case | Chống xóa nhầm nội bộ, vẫn cần lối thoát | Quy định pháp lý (SEC, FINRA), bất biến tuyệt đối |

**Legal Hold**: cờ giữ vô thời hạn, độc lập với retention period, bật/tắt bằng quyền `s3:PutObjectLegalHold` — dùng khi có vụ kiện/điều tra chưa biết kéo dài bao lâu.

```bash
# Đặt retention compliance 1 năm cho một object version
aws s3api put-object-retention \
  --bucket my-worm-bucket --key contracts/c-001.pdf \
  --version-id 3HL4kqtJlcpXroDTDmJ+rmSpXd3dIbrHY+MTRCxf3vjVBH40Nr8X8gdRQBpUMLUo \
  --retention '{"Mode":"COMPLIANCE","RetainUntilDate":"2027-06-12T00:00:00Z"}'
```

### Glacier Vault Lock

Cơ chế tương đương cho **S3 Glacier (vault-based, dịch vụ Glacier gốc)**: viết **vault lock policy** (ví dụ "deny delete-archive trong 5 năm"), khởi tạo lock → có 24 giờ ở trạng thái `InProgress` để test/abort → gọi `complete-vault-lock` thì policy **đóng băng vĩnh viễn, không sửa không xóa được**. Phân biệt với Object Lock: Vault Lock khóa **policy của cả vault**, Object Lock khóa **từng object version** trong S3.

### Server Access Logs

S3 server access logging ghi **mọi request** đến bucket (cả request bị từ chối) thành log file dạng text giao **best-effort** (có thể trễ vài giờ) vào một bucket đích **cùng region**. Hai quy tắc sống còn:

- **Không bao giờ trỏ log vào chính bucket được log** → vòng lặp ghi log vô hạn, bill tăng phi mã. Đây là câu hỏi gài có thật trong đề.
- Bucket đích cần cho phép service principal `logging.s3.amazonaws.com` ghi log (S3 tự thêm bucket policy khi bật qua console).

```bash
aws s3api put-bucket-logging --bucket my-app-bucket \
  --bucket-logging-status '{
    "LoggingEnabled": {
      "TargetBucket": "my-log-bucket",
      "TargetPrefix": "access-logs/my-app-bucket/"
    }
  }'
```

So với **CloudTrail data events** (Chương 27): CloudTrail ghi API-level event dạng JSON, near real-time, tích hợp EventBridge, tính phí theo event; access logs rẻ (chỉ tốn tiền lưu trữ), chi tiết hơn về HTTP (bytes, latency, requester) nhưng best-effort và trễ. Câu hỏi "audit ai đã gọi API xóa object, cần alert" → CloudTrail; "phân tích request patterns/billing, chấp nhận trễ" → access logs (phân tích bằng Athena).

> 💡 **Exam Tip:** Chuỗi từ khóa quyết định nhanh: "regulatory requirement, no one can delete, not even root" → **Object Lock Compliance mode**; "protect from deletion but admins can override" → **Governance mode**; "indefinite protection during litigation" → **Legal Hold**; "lock retention policy for Glacier vault permanently" → **Vault Lock**. Và mọi phương án Object Lock đều cần **versioning bật từ lúc tạo bucket**.
