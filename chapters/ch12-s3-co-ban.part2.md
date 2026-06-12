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
