## Hands-on Lab: Khoá chặt bucket S3 — SSE-KMS, bucket policy ép HTTPS/encryption, presigned URL

**Mục tiêu lab:** Dựng một bucket S3 "production-grade" về security: bật Block Public Access, default encryption SSE-KMS kèm S3 Bucket Key, bucket policy từ chối mọi request không dùng HTTPS và mọi upload không mã hoá đúng chuẩn, sau đó cấp quyền truy cập tạm thời bằng presigned URL (cả CLI lẫn SDK JS v3) và bật server access logging để audit.

**Chuẩn bị:**
- AWS CLI v2 đã cấu hình profile có quyền `s3:*`, `kms:*` (lab dùng tài khoản cá nhân/sandbox).
- Node.js ≥ 18 và package `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`.
- Region thống nhất: `ap-southeast-1`. Thay `123456789012` bằng account ID của bạn.

### Bước 1: Tạo KMS key và 2 bucket (data + logs)

```bash
export AWS_REGION=ap-southeast-1
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export BUCKET=dva-ch14-secure-$ACCOUNT_ID
export LOG_BUCKET=dva-ch14-logs-$ACCOUNT_ID

# Customer managed key cho SSE-KMS
KEY_ID=$(aws kms create-key \
  --description "DVA ch14 S3 lab" \
  --query KeyMetadata.KeyId --output text)
aws kms create-alias --alias-name alias/dva-ch14 --target-key-id $KEY_ID

aws s3api create-bucket --bucket $BUCKET \
  --create-bucket-configuration LocationConstraint=$AWS_REGION
aws s3api create-bucket --bucket $LOG_BUCKET \
  --create-bucket-configuration LocationConstraint=$AWS_REGION
```

Output mong đợi: 2 dòng `"Location": "http://dva-ch14-....s3.amazonaws.com/"`. Lưu ý bucket name phải globally unique — đó là lý do ta nối account ID vào.

### Bước 2: Bật Block Public Access và versioning

Từ 4/2023 bucket mới đã bật sẵn cả 4 cờ Block Public Access, nhưng ta vẫn set tường minh (idempotent, và là lệnh đề thi hay nhắc):

```bash
aws s3api put-public-access-block --bucket $BUCKET \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

aws s3api put-bucket-versioning --bucket $BUCKET \
  --versioning-configuration Status=Enabled
```

Kiểm tra: `aws s3api get-public-access-block --bucket $BUCKET` phải trả về 4 giá trị `true`.

### Bước 3: Default encryption SSE-KMS + S3 Bucket Key

```bash
aws s3api put-bucket-encryption --bucket $BUCKET \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "aws:kms",
        "KMSMasterKeyID": "alias/dva-ch14"
      },
      "BucketKeyEnabled": true
    }]
  }'
```

`BucketKeyEnabled: true` là điểm ăn tiền: S3 tạo một bucket-level key ngắn hạn từ KMS key, dùng nó sinh data key cho object thay vì gọi `GenerateDataKey` cho TỪNG object — giảm tới ~99% lượng request KMS, tránh cả chi phí lẫn `ThrottlingException` khi vượt KMS request quota (mặc định 5.500–50.000 req/s tuỳ region cho symmetric key).

Upload thử và xác nhận object được mã hoá tự động dù không truyền header:

```bash
echo "hello dva" > hello.txt
aws s3api put-object --bucket $BUCKET --key hello.txt --body hello.txt
aws s3api head-object --bucket $BUCKET --key hello.txt \
  --query '{SSE:ServerSideEncryption,KMSKey:SSEKMSKeyId,BucketKey:BucketKeyEnabled}'
```

Output mong đợi:

```json
{
    "SSE": "aws:kms",
    "KMSKey": "arn:aws:kms:ap-southeast-1:123456789012:key/...",
    "BucketKey": true
}
```

### Bước 4: Bucket policy ép HTTPS và ép đúng loại encryption

```bash
cat > policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyInsecureTransport",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": ["arn:aws:s3:::$BUCKET", "arn:aws:s3:::$BUCKET/*"],
      "Condition": { "Bool": { "aws:SecureTransport": "false" } }
    },
    {
      "Sid": "DenyWrongEncryptionHeader",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::$BUCKET/*",
      "Condition": {
        "StringNotEquals": { "s3:x-amz-server-side-encryption": "aws:kms" }
      }
    }
  ]
}
EOF
aws s3api put-bucket-policy --bucket $BUCKET --policy file://policy.json
```

Hai lưu ý cơ chế:
- `aws:SecureTransport` là global condition key, áp cho cả bucket ARN lẫn `/*` (ListBucket đi trên bucket ARN — quên dòng này là policy hổng một nửa).
- Statement `DenyWrongEncryptionHeader` dùng `StringNotEquals`: nếu request KHÔNG gửi header `x-amz-server-side-encryption` thì condition key vắng mặt → `StringNotEquals` vẫn match → bị Deny. Nghĩa là từ giờ client BẮT BUỘC gửi header `aws:kms` tường minh, default encryption không "cứu" được vì policy được đánh giá trước khi default encryption áp vào. Nếu muốn cho phép request không header (để default encryption lo), phải thêm điều kiện `"Null": {"s3:x-amz-server-side-encryption": "true"}` vào statement Allow hoặc tách logic — đây chính là bẫy hay gặp trong production.

Test:

```bash
# Bị chặn: upload với SSE-S3 (AES256)
aws s3api put-object --bucket $BUCKET --key fail.txt --body hello.txt \
  --server-side-encryption AES256
# => An error occurred (AccessDenied) when calling the PutObject operation

# Thành công: SSE-KMS tường minh
aws s3api put-object --bucket $BUCKET --key ok.txt --body hello.txt \
  --server-side-encryption aws:kms
```

### Bước 5: Presigned URL — CLI và SDK JS v3

```bash
# CLI: chỉ presign được GET, mặc định hết hạn 3600s
aws s3 presign s3://$BUCKET/hello.txt --expires-in 120
```

Output là một URL dài chứa `X-Amz-Algorithm=AWS4-HMAC-SHA256`, `X-Amz-Credential`, `X-Amz-Expires=120`, `X-Amz-Signature`. Test bằng curl:

```bash
curl -s "<URL vừa in ra>"   # => hello dva
sleep 125 && curl -s "<URL>" # => <Error><Code>AccessDenied</Code>...Request has expired
```

Presigned PUT phải dùng SDK. Tạo `presign.mjs`:

```javascript
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({ region: "ap-southeast-1" });
const Bucket = process.env.BUCKET;

// Presigned PUT: nhúng sẵn header encryption để qua được bucket policy
const putUrl = await getSignedUrl(
  s3,
  new PutObjectCommand({ Bucket, Key: "upload-via-url.txt", ServerSideEncryption: "aws:kms" }),
  { expiresIn: 300 } // giây
);
console.log("PUT:", putUrl);

const getUrl = await getSignedUrl(
  s3,
  new GetObjectCommand({ Bucket, Key: "hello.txt" }),
  { expiresIn: 300 }
);
console.log("GET:", getUrl);
```

```bash
BUCKET=$BUCKET node presign.mjs
# Upload qua presigned PUT — phải gửi đúng header đã ký
curl -X PUT -H "x-amz-server-side-encryption: aws:kms" \
  --data-binary @hello.txt "<PUT URL>"
```

Cơ chế cần hiểu: URL được ký bằng SigV4 với credentials của người tạo — người dùng URL "mượn" đúng quyền của identity đó tại thời điểm REQUEST (không phải thời điểm ký). Nếu role tạo URL bị thu hồi quyền, URL chết theo. Header nào nằm trong chữ ký (như `x-amz-server-side-encryption` ở trên) thì client bắt buộc gửi đúng y nguyên, không là `SignatureDoesNotMatch`.

### Bước 6: Bật server access logging

```bash
# Cho phép logging service ghi vào log bucket
aws s3api put-bucket-policy --bucket $LOG_BUCKET --policy '{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "logging.s3.amazonaws.com"},
    "Action": "s3:PutObject",
    "Resource": "arn:aws:s3:::'"$LOG_BUCKET"'/*"
  }]
}'

aws s3api put-bucket-logging --bucket $BUCKET --bucket-logging-status '{
  "LoggingEnabled": {"TargetBucket": "'"$LOG_BUCKET"'", "TargetPrefix": "s3-access/"}
}'
```

Log xuất hiện theo cơ chế best-effort, trễ vài phút tới vài giờ — đừng hoảng khi chưa thấy ngay. Tuyệt đối KHÔNG trỏ target bucket về chính nó: log ghi vào bucket lại sinh log mới → vòng lặp phình dung lượng vô hạn.

### Dọn dẹp tài nguyên

```bash
# Xoá hết object + mọi version (bucket có versioning)
aws s3api delete-objects --bucket $BUCKET --delete "$(
  aws s3api list-object-versions --bucket $BUCKET \
    --query '{Objects: [Versions, DeleteMarkers][][].{Key:Key,VersionId:VersionId}}' \
    --output json)"
aws s3 rb s3://$BUCKET
aws s3 rm s3://$LOG_BUCKET --recursive && aws s3 rb s3://$LOG_BUCKET

# KMS key không xoá ngay được — schedule tối thiểu 7 ngày
aws kms delete-alias --alias-name alias/dva-ch14
aws kms schedule-key-deletion --key-id $KEY_ID --pending-window-in-days 7
rm -f hello.txt policy.json presign.mjs
```

## 💡 Exam Tips chương 14

- **SSE-S3** (`AES256`): key do S3 quản lý hoàn toàn, miễn phí, là default encryption tự động cho mọi bucket từ 1/2023. **SSE-KMS** (`aws:kms`): audit qua CloudTrail, kiểm soát key policy, nhưng tốn KMS API call. **SSE-C**: bạn tự gửi key trong header MỖI request, bắt buộc HTTPS, S3 không lưu key. **Client-side**: mã hoá trước khi gửi, S3 không bao giờ thấy plaintext.
- Đề hỏi "audit được ai dùng key giải mã object" hoặc "tự kiểm soát rotation/key policy" → **SSE-KMS với customer managed key**. Hỏi "encryption đơn giản nhất, không quản lý gì" → SSE-S3.
- Workload đọc/ghi cường độ cao bị **KMS ThrottlingException / chi phí KMS tăng** → bật **S3 Bucket Key** (giảm request `GenerateDataKey`/`Decrypt` tới KMS, không đổi mức bảo mật).
- SSE-KMS yêu cầu caller có CẢ quyền S3 lẫn quyền KMS: upload cần `kms:GenerateDataKey`, download cần `kms:Decrypt`. "User có s3:GetObject mà vẫn AccessDenied trên bucket SSE-KMS" → thiếu quyền KMS.
- Ép HTTPS: statement **Deny** với condition `"Bool": {"aws:SecureTransport": "false"}` áp cho cả bucket ARN và `arn:.../*`. Ép loại encryption khi upload: Deny `s3:PutObject` khi `s3:x-amz-server-side-encryption` khác giá trị mong muốn.
- **Presigned URL** thừa kế quyền của identity đã ký, hết hạn theo `--expires-in` (CLI mặc định 3600s, tối đa 7 ngày = 604800s và CHỈ khi ký bằng long-term credentials; ký bằng credentials tạm từ STS/role thì URL chết khi session hết hạn dù expires đặt dài hơn).
- **Block Public Access** thắng tất cả: bucket policy/ACL public đến đâu mà BPA bật thì vẫn bị chặn. "Bucket policy cho phép public read nhưng vẫn 403" → kiểm tra BPA ở mức bucket VÀ account.
- **MFA Delete**: chỉ root account bật được, bắt buộc bucket có versioning, và phải dùng CLI/API (không bật được qua console). Bảo vệ 2 thao tác: xoá vĩnh viễn một object version và suspend versioning.
- **S3 Object Lock** (WORM): cần versioning, chỉ bật khi TẠO bucket (hoặc nhờ AWS Support). **Compliance mode** = không ai xoá/sửa được kể cả root cho tới hết retention; **Governance mode** = ai có `s3:BypassGovernanceRetention` thì bỏ qua được. **Legal hold** = giữ vô thời hạn, độc lập với retention period. Glacier Vault Lock = WORM cho Glacier vault qua vault lock policy.
- **CORS**: lỗi browser "No 'Access-Control-Allow-Origin' header" khi web app ở domain khác gọi S3 → cấu hình CORS rules trên bucket (AllowedOrigins/Methods/Headers). CORS là cơ chế của browser — gọi bằng CLI/SDK không bao giờ dính lỗi CORS.
- **Access Points**: mỗi access point có hostname + policy riêng, gỡ rối bài toán "hàng trăm team cùng dùng 1 bucket, bucket policy phình to". **Object Lambda Access Point**: chèn Lambda biến đổi dữ liệu NGAY lúc GET (redact PII, resize, format) mà không lưu bản sao — từ khoá "transform data on retrieval without duplicating".
- Phân biệt audit: **Server access logs** = log best-effort mọi request, rẻ, vào S3; **CloudTrail data events** = log API-level gần real-time, lọc/cảnh báo được qua CloudWatch (chi tiết ở Chương 27).
