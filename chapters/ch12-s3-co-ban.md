# Chương 12: Amazon S3 cơ bản

> **Trọng tâm DVA-C02:** S3 xuất hiện dày đặc trong cả 4 domain của đề thi. Ở mức cơ bản, đề hay hỏi: giới hạn kích thước object và khi nào BẮT BUỘC dùng multipart upload, hành vi của versioning (đặc biệt là delete marker), điều kiện tiên quyết của replication CRR/SRR, và chọn storage class tối ưu chi phí cho từng access pattern. Phần bảo mật S3 (encryption, bucket policy, presigned URL chi tiết) chiếm riêng một mảng câu hỏi lớn — sẽ học ở Chương 14.

## Mục tiêu chương

- Hiểu mô hình bucket/object/key của S3: namespace phẳng, quy tắc đặt tên, quan hệ với region.
- Nắm chính xác các con số: object tối đa 5 TB, single PUT tối đa 5 GB, multipart bắt buộc khi nào, durability 11 số 9.
- Vận hành versioning đúng cách: version ID, delete marker, khôi phục object đã xoá, hệ quả chi phí.
- Cấu hình static website hosting và hiểu vì sao cần bucket policy public read.
- Phân biệt CRR vs SRR, biết các điều kiện tiên quyết và giới hạn của replication.
- So sánh đầy đủ các storage class và thao tác S3 bằng AWS SDK JS v3 + CLI v2, gồm presigned URL mức giới thiệu.

## 12.1 Buckets, Objects và Keys — mô hình dữ liệu của S3

Amazon S3 (Simple Storage Service) là **object storage**: bạn lưu nguyên một object (file + metadata) và thao tác trên toàn bộ object đó. Khác với block storage (EBS) — nơi bạn sửa từng block — S3 **không cho sửa một phần object**. Muốn thay đổi 1 byte trong file 1 GB? Upload lại toàn bộ object. Đây là điểm phân biệt nền tảng mà đề thi dùng để loại trừ đáp án: workload cần random write ở mức block → EBS/EFS, không phải S3 (chi tiết ở Chương 5).

### Bucket

- Bucket là container cấp cao nhất chứa objects. Tên bucket nằm trong **global namespace** — duy nhất trên toàn bộ AWS, mọi account, mọi region. Nếu ai đó đã đặt `my-app-assets`, bạn không tạo được tên đó nữa.
- Tuy tên là global, **bucket được tạo trong một region cụ thể** và dữ liệu nằm yên trong region đó trừ khi bạn chủ động replicate. Câu "S3 is a global service" chỉ đúng ở góc nhìn console/namespace — về mặt dữ liệu, S3 là regional.
- Quy tắc đặt tên: 3–63 ký tự, chỉ chữ thường, số, dấu chấm và gạch ngang; bắt đầu/kết thúc bằng chữ hoặc số; không được dạng IP (`192.168.1.1`); không có chữ hoa, không underscore. Khuyến nghị tránh dấu chấm trong tên nếu dùng HTTPS virtual-hosted style (chứng chỉ wildcard `*.s3.amazonaws.com` không khớp tên có dấu chấm).
- Mặc định mỗi account có quota **10.000 bucket** (general purpose, có thể xin tăng lên 1 triệu). Số object trong bucket: **không giới hạn**.

### Object và Key

Mỗi object được định danh bằng **key** — toàn bộ chuỗi đường dẫn sau tên bucket:

```
s3://my-app-assets/images/2026/06/avatar.png
                   └────────── key ──────────┘
```

Điểm quan trọng: **S3 không có thư mục thật**. Namespace là phẳng (flat); `images/2026/06/` chỉ là **prefix** — một phần của key có chứa ký tự `/`. Console hiển thị dạng cây thư mục là "ảo hoá" dựa trên delimiter `/`. Hệ quả thực tế:

- "Tạo folder" trong console thực chất tạo một zero-byte object có key kết thúc bằng `/`.
- Không có thao tác "rename folder" — phải copy từng object sang key mới rồi xoá key cũ.
- Prefix có vai trò trong performance (request rate tính theo prefix — chi tiết ở Chương 13).

Một object gồm: **key**, **value** (nội dung, có thể rỗng 0 byte), **version ID** (nếu bật versioning), **metadata** (system metadata như `Content-Type`, `Content-Length`; user metadata có prefix `x-amz-meta-`), **tags** (tối đa 10 tag/object, dùng cho phân quyền và lifecycle), và ACL/thông tin khoá (Chương 14).

```bash
# Tạo bucket ở ap-southeast-1 (ngoài us-east-1 phải có LocationConstraint)
aws s3api create-bucket \
  --bucket my-app-assets-demo-2026 \
  --region ap-southeast-1 \
  --create-bucket-configuration LocationConstraint=ap-southeast-1

# Upload kèm metadata và content-type
aws s3api put-object \
  --bucket my-app-assets-demo-2026 \
  --key images/2026/06/avatar.png \
  --body ./avatar.png \
  --content-type image/png \
  --metadata uploaded-by=duntt,env=prod
```

Bẫy thực tế: nếu không set `--content-type`, CLI/SDK gán `binary/octet-stream` (hoặc đoán theo đuôi file tuỳ tool) — browser sẽ tải file về thay vì hiển thị. Lỗi rất hay gặp khi host ảnh/HTML trên S3.

> 💡 **Exam Tip:** Tên bucket là **globally unique** nhưng bucket là **regional resource**. Khi đề hỏi "user ở region khác có thấy bucket không?" — có, vì namespace global; nhưng dữ liệu chỉ nằm ở region đã tạo, và truy cập cross-region tốn latency + phí data transfer.

## 12.2 Giới hạn kích thước & Multipart Upload

Các con số phải thuộc lòng cho đề thi:

| Giới hạn | Giá trị |
|---|---|
| Kích thước object tối đa | **5 TB** |
| Một lần PUT đơn (single PUT) tối đa | **5 GB** |
| Multipart: BẮT BUỘC khi object | **> 5 GB** |
| Multipart: AWS khuyến nghị khi object | **> 100 MB** |
| Số part tối đa trong một multipart upload | **10.000 parts** |
| Kích thước mỗi part | 5 MB – 5 GB (part cuối được nhỏ hơn 5 MB) |

**Multipart upload** chia object thành nhiều part, upload song song và độc lập. Cơ chế 3 bước ở tầng API:

1. `CreateMultipartUpload` → nhận `UploadId`.
2. `UploadPart` cho từng part (kèm `UploadId` + `PartNumber`), mỗi part trả về một `ETag`.
3. `CompleteMultipartUpload` gửi danh sách `{PartNumber, ETag}` — lúc này S3 mới ghép thành object hoàn chỉnh.

Lợi ích: throughput cao hơn (parallel), part lỗi chỉ retry part đó (quan trọng với mạng chập chờn), có thể upload khi chưa biết tổng kích thước, và pause/resume.

Bẫy chi phí kinh điển: nếu multipart bị bỏ dở (không gọi `Complete` hoặc `Abort`), **các part đã upload vẫn nằm trong bucket và TÍNH TIỀN** dù không hiển thị như object. Giải pháp chuẩn: lifecycle rule `AbortIncompleteMultipartUpload` để tự dọn (cấu hình lifecycle chi tiết ở Chương 13), hoặc gọi `AbortMultipartUpload` trong error handler.

Với SDK JS v3, đừng tự viết 3 bước trên — dùng `@aws-sdk/lib-storage`, nó tự quyết định single PUT hay multipart và xử lý song song:

```javascript
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { createReadStream } from "node:fs";

const s3 = new S3Client({ region: "ap-southeast-1" });

const upload = new Upload({
  client: s3,
  params: {
    Bucket: "my-app-assets-demo-2026",
    Key: "backups/db-dump-2026-06-12.sql.gz",
    Body: createReadStream("./db-dump.sql.gz"), // stream — không load hết vào RAM
  },
  queueSize: 4,            // 4 part upload song song
  partSize: 10 * 1024 * 1024, // 10MB/part (tối thiểu 5MB)
  leavePartsOnError: false,   // tự Abort nếu lỗi — tránh part mồ côi tính tiền
});

upload.on("httpUploadProgress", (p) => console.log(`Đã upload ${p.loaded}/${p.total} bytes`));
await upload.done();
```

CLI high-level (`aws s3 cp`) cũng tự động multipart khi file vượt `multipart_threshold` (mặc định 8 MB); còn `aws s3api put-object` thì luôn single PUT — sẽ fail với file > 5 GB.

> 💡 **Exam Tip:** Câu hỏi "developer cần upload file 6 GB nhưng bị lỗi" → đáp án là **multipart upload** (vì vượt 5 GB single PUT). Câu hỏi "upload 200 MB qua mạng không ổn định, tối ưu retry" → cũng multipart (chỉ retry part hỏng). Số 5 GB / 5 TB / 100 MB là bộ ba xuất hiện thường xuyên.

## 12.3 Durability, Availability & Consistency

**Durability (độ bền dữ liệu): 99,999999999% — "11 số 9"** — áp dụng cho MỌI storage class. Ý nghĩa thống kê: lưu 10 triệu object thì trung bình 10.000 năm mới mất 1 object. S3 đạt được bằng cách lưu dữ liệu **dư thừa trên tối thiểu 3 Availability Zone** (trừ One Zone-IA và Express One Zone — chỉ 1 AZ), kèm checksum chủ động phát hiện và tự sửa dữ liệu hỏng.

**Availability (độ sẵn sàng)** thì KHÁC NHAU theo storage class — đây là điểm đề thi hay gài:

- S3 Standard: 99,99% (SLA thiết kế)
- Standard-IA / Intelligent-Tiering: 99,9%
- One Zone-IA: 99,5%

Phân biệt rạch ròi: durability trả lời "dữ liệu có bị MẤT vĩnh viễn không", availability trả lời "ngay lúc này tôi GET có được không". One Zone-IA vẫn 11 số 9 durability trong phạm vi AZ, nhưng **nếu AZ đó bị phá huỷ thì mất dữ liệu** — vì vậy chỉ dùng cho dữ liệu tái tạo được.

**Consistency model:** từ tháng 12/2020, S3 cung cấp **strong read-after-write consistency** cho mọi thao tác PUT/DELETE của object, mọi region, không phí thêm: PUT object mới hay overwrite xong, GET/LIST ngay lập tức thấy phiên bản mới nhất. Tài liệu cũ (và một số câu hỏi luyện thi cũ) nói "eventual consistency cho overwrite PUT và DELETE" — đã lỗi thời. Lưu ý: strong consistency áp dụng cho data operations; thay đổi cấu hình bucket (versioning, policy) vẫn là eventually consistent.

> 💡 **Exam Tip:** Durability **11 số 9 cho mọi class** (trừ rủi ro mất AZ của One Zone); availability mới là thứ khác nhau. Nếu đề cho đáp án "chọn Standard vì durability cao hơn IA" — sai, durability bằng nhau, khác ở availability và phí truy xuất.

## 12.4 Versioning

Versioning là thuộc tính **cấp bucket**, bật bằng cách set trạng thái `Enabled`. Bucket có 3 trạng thái: **unversioned** (mặc định), **versioning-enabled**, **versioning-suspended**. Quan trọng: **một khi đã bật, không thể quay về unversioned** — chỉ suspend được.

Cơ chế bên dưới:

- Bucket chưa bật versioning: mọi object có version ID là `null`.
- Bật versioning: mỗi lần PUT cùng key tạo **version mới với version ID ngẫu nhiên**, version cũ vẫn còn nguyên. GET không chỉ định version → trả về version mới nhất.
- **DELETE không chỉ định version ID** → S3 KHÔNG xoá dữ liệu, mà đặt một **delete marker** làm "version mới nhất". GET sau đó trả `404 Not Found`, nhưng mọi version cũ vẫn tồn tại (và vẫn tính tiền).
- **Khôi phục object đã xoá = xoá delete marker** (`DeleteObject` kèm `VersionId` của marker).
- **Xoá vĩnh viễn một version = DELETE kèm version ID cụ thể** — thao tác này không tạo delete marker và không hoàn tác được.
- **Suspend versioning**: các version cũ giữ nguyên; object PUT mới từ đó có version ID `null` (PUT tiếp theo cùng key sẽ overwrite chính version `null` đó).

```bash
# Bật versioning
aws s3api put-bucket-versioning \
  --bucket my-app-assets-demo-2026 \
  --versioning-configuration Status=Enabled

# Xem mọi version + delete marker của một key
aws s3api list-object-versions \
  --bucket my-app-assets-demo-2026 --prefix images/2026/06/avatar.png

# Khôi phục object: xoá delete marker
aws s3api delete-object \
  --bucket my-app-assets-demo-2026 \
  --key images/2026/06/avatar.png \
  --version-id "3HL4kqtJlcpXroDTDmJ+rmSpXd3dIbrHY"
```

Hệ quả vận hành cần biết:

- **Chi phí**: mỗi version là một object đầy đủ tính tiền. App ghi đè log file 1 GB mỗi giờ trên bucket versioned = 24 GB/ngày chỉ riêng version cũ. Thực tế luôn kèm lifecycle rule expire noncurrent versions (Chương 13).
- Versioning là **điều kiện tiên quyết** của: replication (mục 12.6), MFA Delete và Object Lock (Chương 14).
- `aws s3 ls` không hiện delete marker — phải dùng `s3api list-object-versions` mới debug được "object biến đâu mất".

> 💡 **Exam Tip:** Bộ câu hỏi versioning kinh điển: (1) "User lỡ xoá file, làm sao khôi phục?" → xoá delete marker. (2) "Versioning có bật được rồi tắt hẳn không?" → không, chỉ **suspend**. (3) "Suspend rồi thì version cũ có mất không?" → không, giữ nguyên. (4) Objects tồn tại TRƯỚC khi bật versioning mang version ID **null**.

## 12.5 Static Website Hosting

S3 có thể phục vụ website tĩnh (HTML/CSS/JS/ảnh — không có server-side code) trực tiếp từ bucket. Khi bật, S3 cung cấp **website endpoint** riêng, khác với REST API endpoint:

```
Website:  http://bucket-name.s3-website-<region>.amazonaws.com
          (một số region dùng dấu chấm: s3-website.<region>)
REST API: https://bucket-name.s3.<region>.amazonaws.com
```

Khác biệt giữa hai endpoint — đề thi thích hỏi:

| | Website endpoint | REST endpoint |
|---|---|---|
| Giao thức | **chỉ HTTP** | HTTP/HTTPS |
| Index/error document | Có (`index.html`, `error.html`) | Không |
| Redirect rules | Có (object-level & bucket-level) | Không |
| Truy cập object private bằng auth | Không — chỉ public/anonymous | Có (SigV4) |

Các bước cấu hình và bẫy đi kèm:

```bash
# 1. Bật website hosting
aws s3api put-bucket-website --bucket my-site-2026 \
  --website-configuration '{
    "IndexDocument": {"Suffix": "index.html"},
    "ErrorDocument": {"Key": "error.html"}
  }'

# 2. Tắt Block Public Access (mặc định BẬT từ 2023, chặn mọi public policy)
aws s3api put-public-access-block --bucket my-site-2026 \
  --public-access-block-configuration BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false

# 3. Bucket policy cho phép đọc public
aws s3api put-bucket-policy --bucket my-site-2026 --policy '{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "PublicReadGetObject",
    "Effect": "Allow",
    "Principal": "*",
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::my-site-2026/*"
  }]
}'
```

Nếu quên bước 2 hoặc 3, mọi request trả **403 Forbidden** — đây chính là tình huống troubleshooting hay vào đề: "bật website hosting rồi nhưng vẫn 403" → kiểm tra Block Public Access + bucket policy. Lỗi 404 → sai index document hoặc thiếu object.

Muốn HTTPS + custom domain cho site tĩnh, pattern chuẩn production là đặt **CloudFront trước S3** (chi tiết ở Chương 15); Route 53 alias record trỏ thẳng website endpoint cũng được nhưng vẫn kẹt HTTP-only (Chương 10).

> 💡 **Exam Tip:** Website endpoint của S3 **không hỗ trợ HTTPS**. Đề hỏi "serve static site qua HTTPS với custom domain" → đáp án luôn có **CloudFront** đứng trước.

## 12.6 Replication — CRR & SRR

Replication tự động copy object **bất đồng bộ (asynchronous)** từ source bucket sang destination bucket. Hai biến thể, cùng cơ chế:

- **CRR (Cross-Region Replication)**: khác region. Use case: compliance yêu cầu dữ liệu ở 2 region, giảm latency cho user ở region khác, DR.
- **SRR (Same-Region Replication)**: cùng region. Use case: gom log từ nhiều bucket về một bucket, đồng bộ môi trường prod → test, replicate giữa 2 account để tách quyền sở hữu.

**Điều kiện tiên quyết — phải thuộc:**

1. **Versioning phải BẬT ở CẢ source và destination** — không versioning thì không cấu hình được replication.
2. S3 cần một **IAM role** có quyền đọc source (`s3:GetObjectVersionForReplication`...) và ghi destination (`s3:ReplicateObject`, `s3:ReplicateDelete`). S3 assume role này để copy thay bạn — đây là service role pattern (Chương 2).
3. Destination có thể thuộc **account khác** (cross-account): destination bucket policy phải cho phép role replicate ghi vào.

**Các hành vi/giới hạn hay vào đề:**

- Replication **KHÔNG hồi tố**: chỉ áp dụng cho object upload SAU khi bật rule. Muốn copy object có sẵn → dùng **S3 Batch Replication** (hoặc Batch Operations — Chương 13).
- **Delete marker replication là tuỳ chọn** (mặc định tắt). Quan trọng hơn: **DELETE kèm version ID cụ thể KHÔNG BAO GIỜ được replicate** — thiết kế chống malicious delete lan sang bản sao.
- **Không có replication chaining**: bucket A → B, B → C thì object từ A KHÔNG tự chảy sang C.
- Object mã hoá SSE-C không replicate được; SSE-KMS replicate được nhưng cần cấu hình thêm quyền KMS (Chương 14, 46).
- Replication có thể đổi storage class và đổi chủ sở hữu object (owner override) ở destination.
- Mặc định best-effort (thường trong vài phút); cần SLA 15 phút thì bật **S3 RTC (Replication Time Control)** — trả phí thêm, kèm metrics.

```bash
aws s3api put-bucket-replication --bucket source-bucket-sgn --replication-configuration '{
  "Role": "arn:aws:iam::123456789012:role/s3-replication-role",
  "Rules": [{
    "ID": "crr-to-tokyo",
    "Status": "Enabled",
    "Priority": 1,
    "Filter": {"Prefix": "logs/"},
    "DeleteMarkerReplication": {"Status": "Disabled"},
    "Destination": {
      "Bucket": "arn:aws:s3:::dest-bucket-nrt",
      "StorageClass": "STANDARD_IA"
    }
  }]
}'
```

> 💡 **Exam Tip:** Ba ý replication được hỏi đi hỏi lại: (1) **versioning bắt buộc ở cả hai bucket**; (2) **không hồi tố** — object cũ cần Batch Replication; (3) delete theo version ID **không replicate**, delete marker thì tuỳ chọn. Và không có chaining A→B→C.

## 12.7 Storage Classes — chọn đúng class, tiết kiệm đúng chỗ

Storage class gắn ở **cấp object** (không phải cấp bucket) — một bucket chứa lẫn object thuộc nhiều class. Chỉ định lúc PUT (`x-amz-storage-class`) hoặc chuyển sau bằng lifecycle/copy.

| Storage class | Availability | Số AZ | Phí truy xuất | Min duration / min size | Use case |
|---|---|---|---|---|---|
| **Standard** | 99,99% | ≥3 | Không | Không | Dữ liệu nóng, truy cập thường xuyên |
| **Intelligent-Tiering** | 99,9% | ≥3 | Không | Phí monitoring/object | Access pattern không đoán được |
| **Standard-IA** | 99,9% | ≥3 | Có (per-GB) | 30 ngày / 128 KB | Truy cập thưa nhưng cần lấy ngay (backup, DR) |
| **One Zone-IA** | 99,5% | **1** | Có | 30 ngày / 128 KB | Dữ liệu thưa, **tái tạo được** (thumbnail, bản replicate phụ) |
| **Glacier Instant Retrieval** | 99,9% | ≥3 | Có (cao hơn IA) | 90 ngày / 128 KB | Archive nhưng cần đọc **mili-giây** (ảnh y tế, media cũ) |
| **Glacier Flexible Retrieval** | 99,99% (sau restore) | ≥3 | Có + phí restore | 90 ngày | Archive, chấp nhận chờ: Expedited 1–5 phút, Standard 3–5 giờ, Bulk 5–12 giờ |
| **Glacier Deep Archive** | 99,99% (sau restore) | ≥3 | Có + phí restore | **180 ngày** | Lưu trữ 7–10 năm compliance: Standard **12 giờ**, Bulk 48 giờ |

(Tất cả đều durability 11 số 9; One Zone-IA mất dữ liệu nếu mất AZ.)

Các cơ chế cần hiểu sâu:

- **Minimum storage duration**: xoá/chuyển object Standard-IA trước 30 ngày vẫn bị tính đủ 30 ngày. Glacier IR/Flexible: 90 ngày; Deep Archive: 180 ngày. Đây là lý do "đẩy hết vào IA cho rẻ" có thể ĐẮT hơn nếu dữ liệu bị xoá/ghi đè liên tục.
- **Minimum billable size 128 KB** với các class IA/Glacier IR: object 10 KB vẫn tính tiền như 128 KB. Hàng triệu file nhỏ → IA không tiết kiệm.
- **Intelligent-Tiering**: S3 theo dõi access từng object, tự chuyển giữa các tier (Frequent → Infrequent sau 30 ngày không đụng → Archive Instant sau 90 ngày; tier Archive/Deep Archive là opt-in). **Không có phí truy xuất, không có min duration** — đổi lại phí monitoring nhỏ trên mỗi object (object < 128 KB không bị monitor, luôn ở frequent tier). Từ khoá đề thi: "unknown / unpredictable / changing access patterns" → Intelligent-Tiering.
- **Glacier Flexible/Deep Archive**: object KHÔNG đọc trực tiếp được — phải gọi `RestoreObject`, chờ theo retrieval tier, S3 tạo bản copy tạm ở Standard trong số ngày chỉ định. GET một object đang ở Glacier mà chưa restore → lỗi `InvalidObjectState (403)`.

```bash
# Upload thẳng vào Standard-IA
aws s3 cp report.pdf s3://my-app-assets-demo-2026/reports/ --storage-class STANDARD_IA

# Restore object từ Glacier Flexible, giữ bản copy 7 ngày, tier Expedited
aws s3api restore-object \
  --bucket my-app-assets-demo-2026 \
  --key archives/2020-logs.tar.gz \
  --restore-request '{"Days": 7, "GlacierJobParameters": {"Tier": "Expedited"}}'
```

Decision tree khi gặp câu hỏi chọn class: truy cập thường xuyên → Standard; pattern không biết trước → Intelligent-Tiering; thưa + cần ngay + quan trọng → Standard-IA; thưa + tái tạo được → One Zone-IA; archive cần đọc tức thì → Glacier IR; archive chờ được vài giờ → Glacier Flexible; "compliance 7 năm, rẻ nhất, chấp nhận 12 giờ" → Deep Archive. Tự động chuyển class theo tuổi object là việc của lifecycle rules (chi tiết ở Chương 13).

> 💡 **Exam Tip:** Ghi nhớ cặp số gài bẫy: Glacier Flexible **Standard retrieval = 3–5 giờ**, Deep Archive **Standard = 12 giờ**; min duration **30/90/180 ngày** cho IA / Glacier(IR+Flexible) / Deep Archive. "Cost-effective + retrieval within milliseconds + rarely accessed" → **Glacier Instant Retrieval**, không phải Standard-IA (IR rẻ hơn cho dữ liệu gần như không đọc).

## 12.8 Làm việc với S3 bằng SDK JS v3 — put/get/list & presigned URL

SDK v3 dạng modular: cài `@aws-sdk/client-s3`, mỗi thao tác là một Command gửi qua `client.send()`. Credentials lấy từ provider chain (Chương 3).

```javascript
import {
  S3Client, PutObjectCommand, GetObjectCommand,
  ListObjectsV2Command, DeleteObjectCommand,
} from "@aws-sdk/client-s3";

const s3 = new S3Client({ region: "ap-southeast-1" });
const Bucket = "my-app-assets-demo-2026";

// PUT — Body nhận string | Buffer | Uint8Array | Readable stream
await s3.send(new PutObjectCommand({
  Bucket,
  Key: "users/42/profile.json",
  Body: JSON.stringify({ name: "Trường", plan: "pro" }),
  ContentType: "application/json",
}));

// GET — Body là Readable stream, KHÔNG phải Buffer
const { Body, ContentType } = await s3.send(
  new GetObjectCommand({ Bucket, Key: "users/42/profile.json" })
);
const json = JSON.parse(await Body.transformToString()); // helper của SDK v3
```

Bẫy SDK v3 mà dev từ v2 chuyển sang hay vấp: `GetObjectCommand` trả `Body` là **stream** (Node.js `Readable`), không phải Buffer như `.promise()` của v2 — dùng `transformToString()` / `transformToByteArray()` hoặc pipe thẳng xuống response.

### List & pagination

`ListObjectsV2` trả tối đa **1.000 object/lần gọi**. Quá 1.000 → response có `IsTruncated: true` và `NextContinuationToken`. Quên pagination = bug "chỉ thấy 1000 file đầu" kinh điển:

```javascript
import { paginateListObjectsV2 } from "@aws-sdk/client-s3";

// Built-in paginator của SDK v3 — tự xử lý ContinuationToken
const paginator = paginateListObjectsV2(
  { client: s3 },
  { Bucket, Prefix: "users/", Delimiter: "/" } // Delimiter gom "thư mục con" vào CommonPrefixes
);
for await (const page of paginator) {
  for (const obj of page.Contents ?? []) {
    console.log(obj.Key, obj.Size, obj.StorageClass);
  }
}
```

Với Go SDK v2, pattern tương đương là `s3.NewListObjectsV2Paginator(client, input)` rồi loop `paginator.HasMorePages()` / `paginator.NextPage(ctx)` — đề không hỏi syntax Go nhưng hỏi khái niệm pagination.

### Presigned URL — mức giới thiệu

Mặc định bucket là private; muốn cho client (browser/mobile) upload hoặc download **không cần AWS credentials và không mở public bucket**, dùng **presigned URL**: URL chứa sẵn chữ ký SigV4 được tạo từ credentials của bạn, ai cầm URL thì thao tác được đúng MỘT operation trên đúng MỘT key, trong thời gian giới hạn. Quyền của URL = quyền của identity đã ký nó.

```javascript
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// URL download, hết hạn sau 15 phút
const downloadUrl = await getSignedUrl(
  s3,
  new GetObjectCommand({ Bucket, Key: "reports/q2.pdf" }),
  { expiresIn: 900 }
);

// URL upload — client PUT thẳng lên S3, không đi qua backend
const uploadUrl = await getSignedUrl(
  s3,
  new PutObjectCommand({ Bucket, Key: "uploads/u42/photo.jpg", ContentType: "image/jpeg" }),
  { expiresIn: 300 }
);
// Client: fetch(uploadUrl, { method: "PUT", body: file, headers: {"Content-Type": "image/jpeg"} })
```

```bash
# CLI chỉ tạo được presigned GET, mặc định hết hạn 3600s, max 604800s (7 ngày)
aws s3 presign s3://my-app-assets-demo-2026/reports/q2.pdf --expires-in 900
```

Pattern chuẩn cho app upload file lớn: backend xác thực user → tạo presigned PUT URL → client upload trực tiếp lên S3 — backend không phải gánh băng thông file. Giới hạn thời hạn, presigned URL với IAM role tạm (hết hạn theo session), POST policy, và các tình huống lỗi chi tiết → Chương 14.

> 💡 **Exam Tip:** "Mobile app cần upload file lên private bucket mà không nhúng credentials" → **presigned URL** (hoặc Cognito Identity Pool — Chương 39). Và nhớ: presigned URL chỉ mạnh bằng quyền của người ký — nếu role ký URL không có `s3:PutObject`, URL vẫn 403.

Đến đây bạn đã nắm trọn nền tảng S3: mô hình dữ liệu, giới hạn upload, versioning, hosting, replication, storage classes và SDK. Phần performance (request rate, Transfer Acceleration, byte-range), event notifications và lifecycle ở Chương 13; toàn bộ mảng security — encryption, bucket policy chi tiết, CORS, Object Lock — ở Chương 14.

---

## Hands-on Lab: Bucket S3 với versioning, static website hosting và truy cập bằng SDK Node.js

**Mục tiêu lab:** Tạo bucket S3 bằng AWS CLI v2, bật versioning và quan sát version ID khi ghi đè/xoá object, host một static website, thử nghiệm storage classes, sau đó thao tác put/get/list và tạo presigned URL bằng AWS SDK for JavaScript v3.

**Chuẩn bị:**
- AWS CLI v2 đã cấu hình profile có quyền `s3:*` (lab dùng tài khoản học tập, không dùng account production).
- Node.js >= 18, đã `npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`.
- Region dùng xuyên suốt: `ap-southeast-1`. Tên bucket phải **globally unique** — thay `<suffix>` bằng chuỗi riêng của bạn (ví dụ ngày + tên).

```bash
export BUCKET="dva-lab-ch12-<suffix>"
export AWS_REGION="ap-southeast-1"
```

### Bước 1: Tạo bucket và hiểu ràng buộc đặt tên

```bash
aws s3api create-bucket \
  --bucket "$BUCKET" \
  --region "$AWS_REGION" \
  --create-bucket-configuration LocationConstraint=ap-southeast-1
```

Output mong đợi:

```json
{
    "Location": "http://dva-lab-ch12-<suffix>.s3.amazonaws.com/"
}
```

Lưu ý hai bẫy CLI kinh điển: (1) với region khác `us-east-1` BẮT BUỘC có `--create-bucket-configuration`, nếu thiếu sẽ nhận lỗi `IllegalLocationConstraintException`; (2) nếu tên đã bị người khác dùng, bạn nhận `BucketAlreadyExists` — vì namespace bucket là toàn cầu dù bucket nằm trong một region cụ thể.

Kiểm tra bucket rỗng:

```bash
aws s3 ls "s3://$BUCKET"
# (không có output — bucket rỗng)
```

### Bước 2: Bật versioning và quan sát version ID

```bash
aws s3api put-bucket-versioning \
  --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled
```

Upload cùng một key hai lần với nội dung khác nhau:

```bash
echo "phien ban 1" > note.txt
aws s3api put-object --bucket "$BUCKET" --key docs/note.txt --body note.txt
echo "phien ban 2" > note.txt
aws s3api put-object --bucket "$BUCKET" --key docs/note.txt --body note.txt
```

Mỗi lệnh trả về một `VersionId` khác nhau. Liệt kê tất cả version:

```bash
aws s3api list-object-versions --bucket "$BUCKET" --prefix docs/ \
  --query 'Versions[].{Key:Key,VersionId:VersionId,IsLatest:IsLatest}'
```

Output mong đợi: 2 entry cho cùng key `docs/note.txt`, entry mới nhất có `IsLatest: true`. Giờ xoá object KHÔNG kèm version ID:

```bash
aws s3api delete-object --bucket "$BUCKET" --key docs/note.txt
```

Output có `"DeleteMarker": true` — S3 không xoá dữ liệu mà chèn **delete marker** làm version mới nhất. Chạy lại `list-object-versions` với `--query 'DeleteMarkers'` sẽ thấy marker này. "Khôi phục" object bằng cách xoá chính delete marker (xoá đích danh version):

```bash
aws s3api delete-object --bucket "$BUCKET" --key docs/note.txt \
  --version-id "<VersionId-cua-delete-marker>"
aws s3 ls "s3://$BUCKET/docs/"
# 2026-06-12 ...         12 note.txt   ← object "sống lại"
```

Đây chính là tình huống đề thi hay hỏi: xoá thường = thêm delete marker (khôi phục được), xoá kèm `--version-id` = xoá vĩnh viễn version đó.

### Bước 3: Host static website

Tạo 2 file và upload kèm `--content-type` đúng (S3 không tự đoán MIME khi dùng `s3api put-object`):

```bash
echo '<h1>DVA-C02 Lab Ch12</h1>' > index.html
echo '<h1>404 - khong tim thay</h1>' > error.html
aws s3api put-object --bucket "$BUCKET" --key index.html --body index.html --content-type text/html
aws s3api put-object --bucket "$BUCKET" --key error.html --body error.html --content-type text/html

aws s3 website "s3://$BUCKET" --index-document index.html --error-document error.html
```

Website endpoint có dạng `http://<bucket>.s3-website-ap-southeast-1.amazonaws.com`. Truy cập ngay lúc này sẽ nhận **403 Forbidden** vì Block Public Access đang bật mặc định. Mở public (chỉ làm trong lab):

```bash
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false

aws s3api put-bucket-policy --bucket "$BUCKET" --policy '{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "PublicRead",
    "Effect": "Allow",
    "Principal": "*",
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::'"$BUCKET"'/*"
  }]
}'
```

Kiểm tra:

```bash
curl -s "http://$BUCKET.s3-website-$AWS_REGION.amazonaws.com"
# <h1>DVA-C02 Lab Ch12</h1>
curl -s "http://$BUCKET.s3-website-$AWS_REGION.amazonaws.com/khong-ton-tai"
# <h1>404 - khong tim thay</h1>
```

Website endpoint chỉ hỗ trợ HTTP; muốn HTTPS phải đặt CloudFront phía trước (chi tiết ở Chương 15). Chi tiết bucket policy, Block Public Access và ép HTTPS ở Chương 14.

### Bước 4: Upload với storage class khác và kiểm tra

```bash
dd if=/dev/zero of=archive.bin bs=1024 count=200 2>/dev/null
aws s3 cp archive.bin "s3://$BUCKET/archive/archive.bin" --storage-class STANDARD_IA

aws s3api head-object --bucket "$BUCKET" --key archive/archive.bin \
  --query 'StorageClass'
# "STANDARD_IA"
```

Thử `--storage-class GLACIER` với một file khác rồi `get-object` ngay — bạn nhận lỗi `InvalidObjectState`: object trong Glacier Flexible Retrieval phải **restore** trước khi đọc. Đây là khác biệt thực hành quan trọng với Glacier Instant Retrieval (đọc được ngay, latency mili-giây).

### Bước 5: Put/Get/List và presigned URL bằng SDK JS v3

Tạo file `s3-lab.mjs`:

```javascript
import {
  S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const client = new S3Client({ region: "ap-southeast-1" });
const Bucket = process.env.BUCKET;

// 1. Put — Body nhận string/Buffer/stream
await client.send(new PutObjectCommand({
  Bucket, Key: "sdk/hello.json",
  Body: JSON.stringify({ msg: "xin chao tu SDK v3" }),
  ContentType: "application/json",
}));

// 2. Get — Body là stream, dùng helper transformToString
const got = await client.send(new GetObjectCommand({ Bucket, Key: "sdk/hello.json" }));
console.log("GET:", await got.Body.transformToString());

// 3. List — tối đa 1000 key/lần, phân trang bằng ContinuationToken
let token, count = 0;
do {
  const page = await client.send(new ListObjectsV2Command({
    Bucket, ContinuationToken: token,
  }));
  count += page.KeyCount;
  token = page.NextContinuationToken;
} while (token);
console.log("Tong so object:", count);

// 4. Presigned URL (giới thiệu — chi tiết ở Chương 14)
const url = await getSignedUrl(client,
  new GetObjectCommand({ Bucket, Key: "sdk/hello.json" }),
  { expiresIn: 300 }); // 5 phút
console.log("Presigned URL:", url);
```

Chạy và xác nhận:

```bash
BUCKET="$BUCKET" node s3-lab.mjs
# GET: {"msg":"xin chao tu SDK v3"}
# Tong so object: 7
# Presigned URL: https://dva-lab-ch12-...?X-Amz-Algorithm=AWS4-HMAC-SHA256&...

curl -s "<presigned-url>"   # tải được object dù bucket private cho key này
```

Để ý query string `X-Amz-Algorithm=AWS4-HMAC-SHA256` — presigned URL chính là request được ký SigV4 sẵn bằng credentials của người tạo, nên người tạo phải có quyền `s3:GetObject` thì URL mới dùng được.

### Dọn dẹp tài nguyên

Bucket có versioning **không thể xoá** khi còn version hoặc delete marker — `aws s3 rb --force` thường fail vì chỉ xoá current version. Xoá triệt để:

```bash
# Xoá mọi version
aws s3api list-object-versions --bucket "$BUCKET" \
  --query 'Versions[].{Key:Key,VersionId:VersionId}' --output json |
jq -c '.[]' | while read -r o; do
  aws s3api delete-object --bucket "$BUCKET" \
    --key "$(echo "$o" | jq -r .Key)" --version-id "$(echo "$o" | jq -r .VersionId)"
done

# Xoá mọi delete marker
aws s3api list-object-versions --bucket "$BUCKET" \
  --query 'DeleteMarkers[].{Key:Key,VersionId:VersionId}' --output json |
jq -c '.[]' | while read -r o; do
  aws s3api delete-object --bucket "$BUCKET" \
    --key "$(echo "$o" | jq -r .Key)" --version-id "$(echo "$o" | jq -r .VersionId)"
done

# Xoá bucket và file local
aws s3api delete-bucket --bucket "$BUCKET"
rm -f note.txt index.html error.html archive.bin s3-lab.mjs
```

Xác nhận: `aws s3 ls | grep dva-lab-ch12` không còn kết quả.

## 💡 Exam Tips chương 12

- S3 là **object storage** với namespace bucket toàn cầu, nhưng dữ liệu nằm trong MỘT region cụ thể. Key là đường dẫn đầy đủ — "thư mục" chỉ là prefix, không có filesystem thật.
- Kích thước object tối đa **5TB**; một lần PUT đơn tối đa **5GB**. Multipart upload **bắt buộc** với object > 5GB và **được khuyến nghị** từ ~100MB. Câu hỏi "upload file 50GB" → multipart upload, không phải tăng timeout.
- Durability **99.999999999% (11 số 9)** giống nhau cho mọi storage class; cái khác nhau giữa các class là **availability** (Standard 99.99%, IA 99.9%, One Zone-IA 99.5%) và chi phí.
- Bật versioning rồi thì chỉ có thể **Suspend**, không bao giờ tắt hẳn về Disabled. Object tồn tại TRƯỚC khi bật versioning có version ID là `null`.
- Xoá object trong bucket có versioning = thêm **delete marker**; khôi phục bằng cách xoá delete marker. Xoá kèm version ID cụ thể mới là xoá vĩnh viễn.
- Replication (CRR/SRR) yêu cầu **versioning bật ở CẢ hai bucket** + IAM role cho S3. Replication không retroactive — object có sẵn không tự replicate (phải dùng S3 Batch Replication); mặc định delete marker không được replicate (bật tuỳ chọn riêng); **không có replication chaining** (bucket A→B, B→C thì object từ A không tự sang C).
- CRR dùng cho compliance/giảm latency cross-region; SRR dùng cho gộp log, đồng bộ môi trường prod/test trong cùng region.
- Chọn storage class theo từ khoá: truy cập thường xuyên → Standard; ít truy cập nhưng cần ngay → Standard-IA; dữ liệu tái tạo được, một AZ đủ → One Zone-IA; archive cần đọc ngay (ms) → Glacier Instant Retrieval; archive chấp nhận phút–giờ → Glacier Flexible; rẻ nhất, chấp nhận 12–48 giờ → Deep Archive; **access pattern không dự đoán được / "unknown or changing"** → Intelligent-Tiering (không có retrieval fee, chỉ phí monitoring nhỏ).
- IA và Glacier có **minimum storage duration** (IA 30 ngày, Glacier Flexible 90 ngày, Deep Archive 180 ngày) và **retrieval fee** — đề hay gài "tiết kiệm chi phí" nhưng dữ liệu đọc thường xuyên thì IA lại ĐẮT hơn Standard.
- Static website hosting: endpoint dạng `http://<bucket>.s3-website-<region>.amazonaws.com`, chỉ HTTP; lỗi 403 sau khi bật website gần như chắc chắn do thiếu bucket policy public hoặc Block Public Access còn bật.
- Presigned URL kế thừa quyền của **người ký**; hết hạn theo `expiresIn`. Mức chi tiết hơn (giới hạn thời gian theo loại credentials, upload bằng presigned URL) ở Chương 14.
- Strong read-after-write consistency: từ 12/2020, S3 đọc thấy ngay dữ liệu vừa PUT/overwrite/DELETE — các đáp án nói "S3 eventual consistency cho overwrite" là đáp án SAI theo hiện hành.

## Quiz chương 12 (10 câu)

**Câu 1.** A developer needs to upload một file backup 8GB lên S3 bằng SDK. Lần gọi PutObject thất bại với lỗi `EntityTooLarge`. Cách xử lý đúng là gì?
- A. Nén file xuống dưới 5TB rồi upload lại
- B. Dùng multipart upload vì PUT đơn chỉ hỗ trợ tối đa 5GB
- C. Tăng timeout của S3Client lên 15 phút
- D. Chuyển sang storage class Glacier vì hỗ trợ file lớn hơn

**Câu 2.** Một bucket đã bật versioning. Developer chạy `aws s3api delete-object --bucket b --key app.log` (không có version ID). Điều gì xảy ra?
- A. Tất cả version của `app.log` bị xoá vĩnh viễn
- B. Version mới nhất bị xoá vĩnh viễn, các version cũ giữ nguyên
- C. Một delete marker được thêm làm version mới nhất; không version nào bị xoá
- D. Lệnh thất bại vì bucket versioning yêu cầu version ID

**Câu 3.** Công ty cần lưu log audit 7 năm theo quy định, gần như không bao giờ đọc lại, chấp nhận thời gian lấy dữ liệu tới 48 giờ, chi phí thấp nhất. Storage class nào phù hợp?
- A. S3 Standard-IA
- B. S3 Glacier Instant Retrieval
- C. S3 Glacier Deep Archive
- D. S3 Intelligent-Tiering

**Câu 4.** A developer cấu hình Cross-Region Replication từ bucket A (us-east-1) sang bucket B (ap-southeast-1) nhưng các object upload trước đó không xuất hiện ở bucket B. Nguyên nhân nào đúng nhất?
- A. CRR chỉ replicate object được tạo SAU khi rule có hiệu lực; object cũ cần S3 Batch Replication
- B. Hai bucket khác region nên phải dùng SRR thay vì CRR
- C. Bucket đích chưa bật static website hosting
- D. CRR cần tối thiểu 24 giờ để đồng bộ lần đầu

**Câu 5.** Ứng dụng lưu dữ liệu xử lý trung gian có thể tái tạo dễ dàng, cần giảm chi phí, dữ liệu ít truy cập nhưng khi cần phải đọc ngay lập tức. Lựa chọn nào rẻ nhất thoả yêu cầu?
- A. S3 Standard
- B. S3 One Zone-IA
- C. S3 Standard-IA
- D. S3 Glacier Flexible Retrieval

**Câu 6.** Team bật static website hosting cho bucket, upload `index.html`, nhưng truy cập website endpoint nhận 403 Forbidden. Nguyên nhân khả dĩ nhất?
- A. Bucket nằm sai region so với endpoint
- B. Thiếu bucket policy cho phép `s3:GetObject` public hoặc Block Public Access còn bật
- C. Website endpoint chỉ hoạt động qua HTTPS
- D. File index.html phải đặt trong thư mục `/public`

**Câu 7.** Một bucket được bật versioning sau khi đã chứa object `report.pdf`. Sau đó developer upload `report.pdf` mới. Trạng thái version của object là gì?
- A. Cả hai version đều có version ID hợp lệ do S3 sinh
- B. Version cũ có version ID `null`, version mới có version ID do S3 sinh
- C. Version cũ bị ghi đè mất vì nó tồn tại trước khi bật versioning
- D. Upload thất bại cho đến khi version cũ được gán version ID

**Câu 8.** A developer dùng SDK JS v3 tạo presigned URL `GetObject` hạn 15 phút cho khách hàng tải file từ bucket private. Khách hàng nhận `AccessDenied` ngay khi mở URL. Nguyên nhân nào hợp lý nhất?
- A. Presigned URL chỉ dùng được trong VPC
- B. IAM identity ký URL không có quyền `s3:GetObject` trên object đó
- C. Bucket phải public thì presigned URL mới hoạt động
- D. SDK v3 không hỗ trợ presigned URL, phải dùng SDK v2

**Câu 9.** Ứng dụng ghi object lên S3 rồi NGAY LẬP TỨC đọc lại chính object đó và list bucket để hiển thị. Phát biểu nào đúng về consistency?
- A. Đọc lại có thể trả 404 vì S3 là eventually consistent với object mới
- B. GET trả dữ liệu mới nhưng LIST có thể chưa thấy object trong vài phút
- C. Cả GET và LIST đều phản ánh ngay object vừa ghi nhờ strong read-after-write consistency
- D. Chỉ strong consistency nếu bucket bật versioning

**Câu 10.** Công ty muốn tối ưu chi phí cho bucket chứa dữ liệu có access pattern thay đổi liên tục và không dự đoán được, không muốn trả retrieval fee, ít công vận hành nhất. Giải pháp nào phù hợp?
- A. Chuyển toàn bộ sang Standard-IA
- B. Dùng S3 Intelligent-Tiering
- C. Viết Lambda định kỳ di chuyển object giữa các storage class theo log truy cập
- D. Dùng One Zone-IA kết hợp replication sang Standard

### Đáp án & giải thích

**Câu 1 — Đáp án B.** Một PUT đơn giới hạn 5GB; object > 5GB bắt buộc multipart upload (giới hạn object tổng là 5TB). A sai vì 8GB vốn đã dưới 5TB — vấn đề là giới hạn PUT đơn, không phải giới hạn object. C sai vì lỗi là giới hạn kích thước phía S3, không liên quan timeout client. D sai vì storage class không thay đổi giới hạn API upload.

**Câu 2 — Đáp án C.** Delete không kèm version ID trên bucket versioned chỉ chèn delete marker; mọi version cũ còn nguyên và khôi phục được bằng cách xoá marker. A và B sai vì không version nào bị xoá vĩnh viễn — muốn vậy phải delete đích danh `--version-id`. D sai vì lệnh hợp lệ, S3 xử lý bằng delete marker.

**Câu 3 — Đáp án C.** Deep Archive là class rẻ nhất, retrieval tiêu chuẩn ~12 giờ (bulk tới 48 giờ), khớp yêu cầu compliance dài hạn ít đọc. A sai vì Standard-IA đắt hơn nhiều cho 7 năm và thừa khả năng truy cập tức thì. B sai vì Glacier Instant Retrieval trả thêm tiền cho khả năng đọc mili-giây không cần đến. D sai vì Intelligent-Tiering dành cho access pattern không dự đoán được, vẫn đắt hơn Deep Archive cho dữ liệu hầu như không đọc.

**Câu 4 — Đáp án A.** Replication không retroactive — chỉ áp dụng cho object mới sau khi rule bật; object có sẵn phải dùng S3 Batch Replication (hoặc copy lại). B sai vì CRR đúng là dành cho khác region; SRR là cùng region. C sai vì website hosting không liên quan replication. D sai vì không có "delay 24 giờ" nào như vậy; replication thường diễn ra trong vài phút với object mới.

**Câu 5 — Đáp án B.** One Zone-IA rẻ hơn Standard-IA ~20%, đọc ngay lập tức, đánh đổi là dữ liệu chỉ nằm 1 AZ — chấp nhận được vì dữ liệu tái tạo được. A sai vì Standard đắt nhất trong các phương án thoả yêu cầu. C sai vì Standard-IA lưu đa AZ nên đắt hơn trong khi độ bền đa AZ không cần thiết ở đây. D sai vì Glacier Flexible không đọc ngay được (phút–giờ, phải restore).

**Câu 6 — Đáp án B.** Website endpoint trả 403 khi request không được phép đọc object — nghĩa là thiếu bucket policy `s3:GetObject` cho `Principal: "*"` hoặc Block Public Access đang chặn policy public. A sai vì sai region cho lỗi DNS/redirect, không phải 403. C sai vì website endpoint thực tế CHỈ hỗ trợ HTTP. D sai vì S3 không có khái niệm thư mục bắt buộc nào như vậy — index document được cấu hình theo key.

**Câu 7 — Đáp án B.** Object tồn tại trước khi bật versioning được gán version ID `null`; mọi PUT sau đó tạo version mới với ID do S3 sinh và version `null` được giữ lại. A sai vì version cũ không được gán lại ID. C sai vì versioning bảo toàn version cũ (đó chính là mục đích). D sai vì không có yêu cầu nào như vậy — upload hoạt động bình thường.

**Câu 8 — Đáp án B.** Presigned URL thực thi với quyền của identity đã ký; nếu identity đó không có `s3:GetObject` thì URL trả AccessDenied dù chữ ký hợp lệ. A sai vì presigned URL dùng được từ bất kỳ đâu có internet. C sai — toàn bộ ý nghĩa của presigned URL là cấp truy cập tạm vào bucket private. D sai vì SDK v3 hỗ trợ qua package `@aws-sdk/s3-request-presigner` (đã dùng trong lab).

**Câu 9 — Đáp án C.** Từ tháng 12/2020 S3 cung cấp strong read-after-write consistency cho mọi GET/LIST sau PUT (cả object mới lẫn overwrite) và DELETE. A và B mô tả mô hình eventual consistency cũ — là đáp án bẫy kinh điển dựa trên tài liệu lỗi thời. D sai vì strong consistency áp dụng cho mọi bucket, không phụ thuộc versioning.

**Câu 10 — Đáp án B.** Intelligent-Tiering tự động chuyển object giữa các access tier dựa trên pattern thực tế, không có retrieval fee, chỉ tốn phí monitoring nhỏ theo object — đúng từ khoá "unpredictable access pattern" + "least operational overhead". A sai vì Standard-IA tính retrieval fee và sẽ đắt nếu dữ liệu hoá ra được đọc nhiều. C sai vì tự viết Lambda là nhiều operational overhead nhất, đúng cái đề yêu cầu tránh. D sai vì One Zone-IA + replication vừa phức tạp vừa vẫn chịu retrieval fee, không giải quyết pattern thay đổi.

## Tóm tắt chương

- S3 lưu **object** (data + metadata) trong **bucket**; key là định danh đầy đủ, prefix tạo cảm giác thư mục nhưng không có hierarchy thật.
- Giới hạn cần thuộc lòng: object tối đa **5TB**, PUT đơn tối đa **5GB**, multipart bắt buộc > 5GB và nên dùng từ ~100MB.
- Durability 11 số 9 cho mọi class; availability mới là thứ phân biệt: Standard 99.99% → IA 99.9% → One Zone-IA 99.5%.
- S3 có **strong read-after-write consistency** cho PUT/GET/LIST/DELETE từ 12/2020 — bỏ qua mọi đáp án nói eventual consistency cho overwrite.
- Versioning bật ở mức bucket, chỉ Suspend được chứ không Disable; object trước khi bật có version ID `null`; delete thường tạo **delete marker**, xoá vĩnh viễn cần version ID đích danh.
- Static website hosting cho endpoint HTTP-only `s3-website-<region>`; cần bucket policy public + tắt Block Public Access; muốn HTTPS dùng CloudFront (Chương 15).
- Replication CRR/SRR cần versioning hai đầu + IAM role; không retroactive (dùng Batch Replication cho object cũ), không chaining, delete marker không replicate mặc định.
- Storage classes theo trục chi phí giảm dần: Standard → Standard-IA → One Zone-IA → Glacier Instant → Glacier Flexible → Deep Archive; đổi lại là retrieval fee, minimum storage duration (30/90/180 ngày) và thời gian lấy dữ liệu tăng dần.
- Intelligent-Tiering là đáp án mặc định cho "access pattern không dự đoán được" — tự chuyển tier, không retrieval fee.
- SDK JS v3: `PutObjectCommand`/`GetObjectCommand`/`ListObjectsV2Command`; GET trả Body dạng stream (`transformToString`), LIST tối đa 1000 key/lần phân trang bằng `ContinuationToken`.
- Presigned URL = request ký SigV4 sẵn, kế thừa quyền người ký, hết hạn theo `expiresIn` (chi tiết bảo mật ở Chương 14).
- Dọn bucket versioned phải xoá hết version + delete marker trước khi `delete-bucket` — `s3 rb --force` đơn thuần không đủ.
