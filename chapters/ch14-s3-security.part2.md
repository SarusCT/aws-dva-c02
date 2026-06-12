## Hands-on Lab: Khóa chặt một bucket S3 — ép HTTPS, ép SSE-KMS, presigned URL và Object Lock

**Mục tiêu lab:** Dựng một bucket "production-grade" về bảo mật: bật default encryption SSE-KMS với Bucket Key, viết bucket policy ép HTTPS và ép đúng loại encryption khi upload, chứng minh các điều kiện chặn hoạt động, phát hành presigned URL có thời hạn, và bật Object Lock để chống xóa/sửa. Lab gom đúng các điểm thi của Chương 14 vào một luồng thực tế.

**Chuẩn bị:**
- AWS CLI v2 đã cấu hình (`aws --version` ≥ 2.x), một IAM user/role có quyền `s3:*`, `kms:*` trong tài khoản sandbox.
- Node.js ≥ 18 nếu muốn chạy phần presigned URL bằng SDK v3 (`npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`).
- Đặt biến môi trường cho gọn (tên bucket S3 phải globally unique):

```bash
export AWS_REGION=ap-southeast-1
export BKT=dva-ch14-lab-$(aws sts get-caller-identity --query Account --output text)
echo "Bucket: $BKT"
```

### Bước 1: Tạo KMS key và bucket có Object Lock

Object Lock **chỉ bật được lúc tạo bucket** (cần versioning, và versioning sẽ tự bật theo). Nếu quên, bạn phải mở ticket hoặc tạo lại bucket — đây là bẫy hay gặp.

```bash
# Tạo customer managed KMS key cho S3
export KEY_ARN=$(aws kms create-key \
  --description "ch14-s3-lab" \
  --query KeyMetadata.Arn --output text)
echo "KMS key: $KEY_ARN"

# Tạo bucket với Object Lock bật sẵn (versioning tự bật theo)
aws s3api create-bucket \
  --bucket "$BKT" \
  --region "$AWS_REGION" \
  --create-bucket-configuration LocationConstraint="$AWS_REGION" \
  --object-lock-enabled-for-bucket
```

> Lưu ý: ở `us-east-1` KHÔNG truyền `--create-bucket-configuration` (region mặc định sẽ lỗi `InvalidLocationConstraint`).

### Bước 2: Bật default encryption SSE-KMS + Bucket Key

```bash
aws s3api put-bucket-encryption \
  --bucket "$BKT" \
  --server-side-encryption-configuration "{
    \"Rules\": [{
      \"ApplyServerSideEncryptionByDefault\": {
        \"SSEAlgorithm\": \"aws:kms\",
        \"KMSMasterKeyID\": \"$KEY_ARN\"
      },
      \"BucketKeyEnabled\": true
    }]
  }"

# Kiểm tra lại
aws s3api get-bucket-encryption --bucket "$BKT"
```

**Output mong đợi:** JSON có `"SSEAlgorithm": "aws:kms"` và `"BucketKeyEnabled": true`. Từ giờ object upload mà không khai báo encryption sẽ tự được mã hóa bằng key này.

### Bước 3: Bật Block Public Access (mặc định đã bật, xác nhận lại)

```bash
aws s3api put-public-access-block \
  --bucket "$BKT" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

**Bẫy:** `BlockPublicPolicy=true` sẽ **từ chối** mọi `put-bucket-policy` nào bị đánh giá là "public". Bucket policy ở Bước 4 không public (chỉ chứa Deny có điều kiện) nên vẫn áp được. Nếu bạn cố thêm `"Principal": "*"` với `Allow` mà không có Condition giới hạn, lệnh sẽ bị chặn.

### Bước 4: Bucket policy ép HTTPS và ép SSE-KMS đúng key

```bash
cat > /tmp/policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyInsecureTransport",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": ["arn:aws:s3:::$BKT", "arn:aws:s3:::$BKT/*"],
      "Condition": { "Bool": { "aws:SecureTransport": "false" } }
    },
    {
      "Sid": "DenyMissingEncryption",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::$BKT/*",
      "Condition": {
        "StringNotEquals": { "s3:x-amz-server-side-encryption": "aws:kms" }
      }
    }
  ]
}
EOF

aws s3api put-bucket-policy --bucket "$BKT" --policy file:///tmp/policy.json
```

Statement 2 chặn mọi `PutObject` mà header `x-amz-server-side-encryption` **khác** `aws:kms`. Lưu ý: object upload **không kèm header nào** vẫn được S3 mã hóa bằng default encryption (Bước 2) — nhưng condition `StringNotEquals` khi key vắng mặt sẽ **đánh giá là true** (key không tồn tại ≠ "aws:kms"), nên request không gửi header cũng bị Deny. Đây chính là lý do người ta dùng condition này để **bắt buộc client khai báo encryption tường minh**.

### Bước 5: Chứng minh các điều kiện hoạt động

```bash
echo "secret data" > /tmp/file.txt

# (a) Upload KHÔNG kèm header encryption -> bị Deny bởi statement 2
aws s3api put-object --bucket "$BKT" --key no-enc.txt --body /tmp/file.txt
# Output mong đợi: An error occurred (AccessDenied) when calling the PutObject operation

# (b) Upload kèm header SSE-KMS đúng -> THÀNH CÔNG
aws s3api put-object --bucket "$BKT" --key ok.txt --body /tmp/file.txt \
  --server-side-encryption aws:kms --ssekms-key-id "$KEY_ARN"
# Output: trả về ETag + "ServerSideEncryption": "aws:kms"
```

CLI luôn dùng HTTPS nên statement 1 (`aws:SecureTransport=false`) khó tái hiện qua CLI — chỉ cần hiểu nó chặn mọi request HTTP plaintext.

### Bước 6: Đặt Object Lock retention cho một object (Governance mode)

```bash
# Retain-until 1 ngày, mode GOVERNANCE (admin có quyền bypass)
aws s3api put-object-retention \
  --bucket "$BKT" --key ok.txt \
  --retention "Mode=GOVERNANCE,RetainUntilDate=$(date -u -v+1d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '+1 day' +%Y-%m-%dT%H:%M:%SZ)"

# Thử xóa version hiện tại -> bị chặn bởi Object Lock
VID=$(aws s3api list-object-versions --bucket "$BKT" --prefix ok.txt \
  --query 'Versions[0].VersionId' --output text)
aws s3api delete-object --bucket "$BKT" --key ok.txt --version-id "$VID"
# Output mong đợi: AccessDenied (Object Lock) — trừ khi dùng --bypass-governance-retention + quyền s3:BypassGovernanceRetention
```

`COMPLIANCE` mode thì **không ai** (kể cả root) bypass được cho tới khi hết hạn — lab dùng `GOVERNANCE` để còn dọn dẹp được.

### Bước 7: Phát hành presigned URL bằng SDK v3 (Node.js)

```javascript
// presign.mjs
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({ region: process.env.AWS_REGION });
const cmd = new GetObjectCommand({ Bucket: process.env.BKT, Key: "ok.txt" });

// URL hết hạn sau 300 giây; quyền = quyền của credentials ký URL
const url = await getSignedUrl(s3, cmd, { expiresIn: 300 });
console.log(url);
```

```bash
node presign.mjs > /tmp/url.txt
curl -s "$(cat /tmp/url.txt)"   # tải được object trong 5 phút, không cần credentials
```

Nhớ: presigned URL kế thừa quyền của identity đã ký. Nếu ký bằng IAM user thì max `expiresIn` là 7 ngày (604800s); ký bằng role/STS thì URL hết hiệu lực khi session token hết hạn, dù `expiresIn` dài hơn.

### Dọn dẹp tài nguyên

```bash
# Với GOVERNANCE ta bypass được retention nếu có quyền, để xóa object
VID=$(aws s3api list-object-versions --bucket "$BKT" --prefix ok.txt \
  --query 'Versions[0].VersionId' --output text)
aws s3api delete-object --bucket "$BKT" --key ok.txt --version-id "$VID" \
  --bypass-governance-retention

# Xóa hết mọi version + delete marker rồi xóa bucket
aws s3api delete-objects --bucket "$BKT" --delete "$(aws s3api list-object-versions \
  --bucket "$BKT" \
  --query '{Objects: [Versions[].{Key:Key,VersionId:VersionId}, DeleteMarkers[].{Key:Key,VersionId:VersionId}][]}' \
  --output json)" 2>/dev/null

aws s3api delete-bucket --bucket "$BKT"

# Lên lịch xóa KMS key (tối thiểu 7 ngày, không xóa ngay được)
aws kms schedule-key-deletion --key-id "$KEY_ARN" --pending-window-in-days 7
```

> Lưu ý chi phí: KMS customer managed key tốn ~1 USD/tháng tính theo tỷ lệ tới khi xóa. Object Lock không tốn phí thêm, nhưng object bị lock thì không xóa sớm được — đừng bật COMPLIANCE trên dữ liệu test.

## 💡 Exam Tips chương 14

- "Cần audit mỗi lần encryption key được dùng + tự kiểm soát rotation" → **SSE-KMS với customer managed key**. SSE-S3 không có CloudTrail trail cho key; AWS managed key `aws/s3` không cho cấu hình rotation tùy ý.
- "Ứng dụng upload hàng chục nghìn object/giây với SSE-KMS bị `ThrottlingException`" → bật **S3 Bucket Key** (giảm ~99% KMS request) hoặc xin tăng KMS request quota. Đừng nhầm sang tăng S3 request rate.
- "Khách hàng phải tự giữ và cung cấp key, AWS không lưu key" → **SSE-C**. Bắt buộc dùng HTTPS; S3 lưu HMAC của key chứ không lưu key; mất key = mất data.
- Ép HTTPS: bucket policy `Deny` với `Condition: Bool { aws:SecureTransport: false }`. Đề rất hay hỏi nguyên văn condition key này.
- Ép encryption khi upload: `Deny s3:PutObject` với `StringNotEquals s3:x-amz-server-side-encryption` (hoặc `Null` để bắt header vắng mặt). Request không gửi header cũng bị chặn.
- Default encryption (từ 1/2023) khiến **mọi object mới luôn được mã hóa** tối thiểu bằng SSE-S3 — câu "đảm bảo mã hóa với ít công nhất" thường là "không cần làm gì / bật default encryption", không phải viết policy.
- Presigned URL: thừa kế quyền của identity ký URL. Ký bằng IAM user max 7 ngày; ký bằng STS/role hết hạn theo session token. AccessDenied khi credentials ký không có quyền hoặc URL đã hết hạn.
- Lỗi CORS chỉ xảy ra ở **trình duyệt** (cross-origin), không xảy ra khi gọi từ server/CLI. Sửa bằng CORS configuration trên bucket, không phải bằng IAM/bucket policy.
- Block Public Access ở **account level đè account**, ở **bucket level đè bucket**; `RestrictPublicBuckets` chặn cả truy cập public qua bucket policy. BPA luôn thắng — bật BPA thì policy public vô hiệu.
- Object Lock: **COMPLIANCE** không ai bypass kể cả root tới khi hết hạn; **GOVERNANCE** cho phép bypass nếu có `s3:BypassGovernanceRetention`. Legal Hold độc lập với retention, không có thời hạn.
- Object Lock & MFA Delete chỉ áp cho **versioned bucket**; Object Lock phải bật **lúc tạo bucket**. MFA Delete chỉ bật/tắt được bằng **root account** qua CLI/API (không làm được trên Console).
- Cross-account đọc object SSE-KMS cần đủ 3 lớp: bucket policy/quyền object, IAM cho người gọi, **và key policy của KMS key** cho phép `kms:Decrypt`. Thiếu key policy là nguyên nhân AccessDenied kinh điển (chi tiết KMS ở Chương 46).

## Quiz chương 14 (10 câu)

**Câu 1.** Một công ty fintech phải chứng minh với auditor rằng mỗi lần dữ liệu được giải mã đều có log "ai, khi nào". Họ cũng muốn tự quản lý vòng đời rotation của key. Loại encryption nào phù hợp nhất?
- A. SSE-S3
- B. SSE-KMS với AWS managed key `aws/s3`
- C. SSE-KMS với customer managed key
- D. SSE-C

**Câu 2.** Ứng dụng upload ~40.000 object/giây vào S3 dùng SSE-KMS và bắt đầu nhận `ThrottlingException` từ KMS. Cách khắc phục ít thay đổi kiến trúc nhất là gì?
- A. Chuyển toàn bộ sang SSE-S3
- B. Bật S3 Bucket Key trên bucket
- C. Tạo nhiều prefix để tăng request rate của S3
- D. Bật S3 Transfer Acceleration

**Câu 3.** Developer cần bucket policy bắt buộc mọi request tới bucket phải dùng HTTPS. Condition nào đúng?
- A. `"Bool": { "aws:SecureTransport": "true" }` với Effect Allow
- B. `"Bool": { "aws:SecureTransport": "false" }` với Effect Deny
- C. `"StringEquals": { "s3:x-amz-server-side-encryption": "aws:kms" }`
- D. `"IpAddress": { "aws:SourceIp": "0.0.0.0/0" }`

**Câu 4.** Một web app chạy ở `https://app.example.com` gọi `fetch()` tải file từ S3 và bị lỗi "blocked by CORS policy". Server-side test bằng curl thì tải bình thường. Cần sửa ở đâu?
- A. Thêm quyền `s3:GetObject` vào IAM policy
- B. Thêm CORS configuration cho phép origin `https://app.example.com` trên bucket
- C. Tắt Block Public Access
- D. Đổi sang SSE-KMS

**Câu 5.** Một presigned URL để GET object được tạo bằng SDK với `expiresIn: 86400` (24 giờ), ký bằng credentials lấy từ một IAM Role (STS, session 1 giờ). Sau khoảng 1 giờ URL không còn dùng được. Vì sao?
- A. S3 giới hạn presigned URL tối đa 1 giờ
- B. URL hết hiệu lực khi session token tạm thời của role hết hạn (1 giờ)
- C. Object đã bị Object Lock
- D. CORS chặn sau 1 giờ

**Câu 6.** Yêu cầu: mọi `PutObject` không khai báo server-side encryption phải bị từ chối. Statement nào đúng?
- A. `Allow s3:PutObject` với `StringEquals s3:x-amz-server-side-encryption = aws:kms`
- B. `Deny s3:PutObject` với `Null s3:x-amz-server-side-encryption = true`
- C. `Deny s3:GetObject` với `aws:SecureTransport false`
- D. Bật versioning trên bucket

**Câu 7.** Một bộ phận compliance yêu cầu object lưu trong S3 không được xóa hay ghi đè trong 7 năm, **kể cả tài khoản root cũng không được phép**. Cấu hình nào đáp ứng?
- A. S3 Object Lock ở GOVERNANCE mode, retain 7 năm
- B. S3 Object Lock ở COMPLIANCE mode, retain 7 năm
- C. Bật MFA Delete
- D. Bucket policy Deny `s3:DeleteObject`

**Câu 8.** Tài khoản A sở hữu bucket mã hóa bằng SSE-KMS (customer managed key của A). Tài khoản B đã được cấp `s3:GetObject` qua bucket policy và IAM, nhưng vẫn nhận AccessDenied khi tải object. Nguyên nhân khả dĩ nhất?
- A. Bucket chưa bật versioning
- B. Key policy của KMS key không cho phép principal của B `kms:Decrypt`
- C. Block Public Access đang bật
- D. Object đang ở Glacier Deep Archive

**Câu 9.** Developer muốn áp một chính sách truy cập (và network origin) khác nhau cho nhiều ứng dụng dùng chung một bucket lớn, mỗi app chỉ truy cập một prefix, mà không phải viết một bucket policy khổng lồ. Giải pháp nào phù hợp nhất?
- A. Tạo nhiều bucket riêng cho từng app
- B. Dùng S3 Access Points, mỗi access point có policy và network origin riêng
- C. Dùng SSE-C cho từng app
- D. Bật S3 Object Lambda

**Câu 10.** Công ty muốn bật MFA Delete trên một versioned bucket để chống xóa version do nhầm hoặc bị lộ credential. Phát biểu nào ĐÚNG?
- A. MFA Delete bật được trên AWS Console bởi bất kỳ IAM admin nào
- B. MFA Delete chỉ bật/tắt được bằng root account thông qua CLI/API, kèm thiết bị MFA
- C. MFA Delete áp dụng được cho cả bucket chưa bật versioning
- D. MFA Delete yêu cầu Object Lock COMPLIANCE mode

### Đáp án & giải thích

**Câu 1 — Đáp án C.** SSE-KMS với customer managed key vừa ghi mọi lần `Decrypt`/`GenerateDataKey` vào CloudTrail (audit "ai, khi nào"), vừa cho phép tự cấu hình rotation. A (SSE-S3) không có audit trail cho key. B dùng AWS managed key `aws/s3` — có CloudTrail nhưng không cho tùy chỉnh rotation policy. D (SSE-C) đẩy việc quản key cho khách hàng và không tạo CloudTrail trail của KMS.

**Câu 2 — Đáp án B.** S3 Bucket Key giảm tới ~99% số KMS request bằng cách dùng một bucket-level key sinh data key cho nhiều object, loại bỏ throttling. A đánh đổi mất tính năng kiểm soát/audit key của KMS nên không đáp ứng yêu cầu giữ SSE-KMS. C giải quyết throttling của S3 chứ không phải KMS. D tăng tốc upload đường dài, không liên quan KMS quota.

**Câu 3 — Đáp án B.** Cách chuẩn là `Deny` khi `aws:SecureTransport` bằng `false`. A dùng Allow với SecureTransport true không **chặn** được request HTTP (thiếu Allow ≠ Deny; chỉ explicit Deny mới đảm bảo). C ép encryption, không phải HTTPS. D cho phép mọi IP, không liên quan transport.

**Câu 4 — Đáp án B.** CORS chỉ phát sinh ở trình duyệt khi origin khác nhau; curl/server không bị. Khắc phục bằng cách thêm CORS configuration trên bucket khai báo `AllowedOrigins` chứa `https://app.example.com`. A không phải vấn đề quyền (curl tải được). C/D không liên quan CORS.

**Câu 5 — Đáp án B.** Presigned URL ký bằng STS credentials chỉ hợp lệ tới khi session token hết hạn, bất kể `expiresIn`. Role session ở đây 1 giờ nên URL chết sau ~1 giờ. A sai: presigned URL ký bằng IAM user có thể tới 7 ngày. C/D không phù hợp tình huống.

**Câu 6 — Đáp án B.** `Null s3:x-amz-server-side-encryption = true` khớp khi header **vắng mặt** → Deny đúng yêu cầu "không khai báo encryption thì từ chối". A chỉ Allow khi có header nhưng không chủ động Deny trường hợp thiếu (và một Allow không loại trừ request khác). C ép HTTPS chứ không phải encryption. D không liên quan.

**Câu 7 — Đáp án B.** Chỉ COMPLIANCE mode mới đảm bảo **không ai, kể cả root**, xóa/ghi đè được tới khi hết retention. A (GOVERNANCE) cho phép bypass nếu có quyền `s3:BypassGovernanceRetention`. C (MFA Delete) chống xóa version nhưng người có MFA root vẫn xóa được. D (bucket policy Deny) có thể bị chính chủ chỉnh sửa lại.

**Câu 8 — Đáp án B.** Đọc object SSE-KMS cross-account cần cả quyền S3 lẫn `kms:Decrypt` trên key. Key policy (và/hoặc grant) của tài khoản A phải cho phép principal của B; thiếu nó gây AccessDenied dù S3 đã mở. A/C không gây lỗi giải mã. D chỉ làm object cần restore trước, lỗi sẽ là InvalidObjectState chứ không phải AccessDenied.

**Câu 9 — Đáp án B.** S3 Access Points cho mỗi app một endpoint với access point policy và VPC/network origin riêng, gắn vào prefix tương ứng — tránh bucket policy khổng lồ. A tốn kém và phá vỡ shared bucket. C/D không giải quyết phân vùng truy cập theo prefix/app.

**Câu 10 — Đáp án B.** MFA Delete chỉ bật/tắt được bởi **root account** qua CLI/API kèm thiết bị MFA; không làm được trên Console và IAM admin thường không bật được. C sai: cần versioned bucket. D sai: MFA Delete độc lập với Object Lock.

## Tóm tắt chương

- S3 có 4 lớp bảo mật: encryption at rest, encryption in transit, access control, và data protection/audit — đề thi thường mô tả yêu cầu rồi bắt chọn đúng lớp/cơ chế.
- Bốn phương án encryption at rest: **SSE-S3** (AES-256, S3 quản key, không audit key), **SSE-KMS** (audit + kiểm soát rotation, chịu KMS quota), **SSE-C** (khách tự cung cấp key, bắt buộc HTTPS), **client-side** (mã hóa trước khi rời máy).
- **S3 Bucket Key** giảm ~99% KMS request → chống `ThrottlingException` và giảm chi phí khi dùng SSE-KMS ở quy mô lớn.
- Từ 1/2023 mọi object mới được mã hóa mặc định tối thiểu SSE-S3; câu "đảm bảo mã hóa, ít công nhất" thường là "không cần làm gì / bật default encryption".
- Ép HTTPS bằng `Deny` + `aws:SecureTransport: false`; ép encryption upload bằng `Deny s3:PutObject` + điều kiện trên `s3:x-amz-server-side-encryption` (hoặc `Null` để bắt header vắng mặt).
- **Block Public Access** luôn thắng và có thể bật ở account hoặc bucket; `RestrictPublicBuckets` vô hiệu hóa cả truy cập public qua bucket policy.
- **Presigned URL** thừa kế quyền của identity ký: ký bằng IAM user tối đa 7 ngày; ký bằng STS/role hết hạn theo session token.
- **CORS** là vấn đề chỉ của trình duyệt (cross-origin); sửa bằng CORS configuration trên bucket, không phải IAM/bucket policy.
- **Object Lock** (WORM) cần versioning và phải bật lúc tạo bucket: COMPLIANCE không ai bypass kể cả root; GOVERNANCE bypass được nếu có `s3:BypassGovernanceRetention`; Legal Hold độc lập, không thời hạn.
- **MFA Delete** chỉ bật/tắt bởi root qua CLI/API kèm MFA, chỉ cho versioned bucket — bảo vệ chống xóa version.
- Cross-account đọc object SSE-KMS cần đủ ba lớp quyền: bucket policy, IAM của người gọi, và **key policy KMS** cho `kms:Decrypt` — thiếu key policy là nguyên nhân AccessDenied kinh điển (chi tiết KMS ở Chương 46).
- **S3 Access Points** tách chính sách/network origin theo từng app trên một bucket lớn; **Object Lambda** biến đổi dữ liệu khi GET; **Glacier Vault Lock** là WORM cho Glacier vault.
