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
