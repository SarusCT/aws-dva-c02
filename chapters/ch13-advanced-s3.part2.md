## Hands-on Lab: Event notifications, lifecycle rules, multipart upload và S3 Select

**Mục tiêu lab:** Xây dựng một bucket "thực chiến" hội tụ các tính năng Advanced S3 hay thi nhất: (1) gắn event notification S3 → SQS để bắt sự kiện upload, (2) tạo lifecycle rule chuyển object sang Standard-IA rồi Glacier Flexible Retrieval và dọn multipart upload dở dang, (3) upload file lớn bằng multipart qua CLI, (4) truy vấn file CSV bằng S3 Select để chỉ kéo về dữ liệu cần thiết.

**Chuẩn bị:**
- AWS CLI v2 đã cấu hình profile có quyền `s3:*`, `sqs:*` (lab dùng tài khoản học tập, không chạy trên production).
- Region thống nhất: lab dùng `ap-southeast-1`. Nếu bạn dùng region khác, đổi lại trong mọi lệnh.
- `jq` (tuỳ chọn, để đọc JSON output dễ hơn).

### Bước 1: Tạo bucket và SQS queue nhận event

```bash
export AWS_REGION=ap-southeast-1
export BUCKET=dva-ch13-lab-$RANDOM$RANDOM   # tên bucket phải unique toàn cầu
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

aws s3api create-bucket \
  --bucket $BUCKET \
  --create-bucket-configuration LocationConstraint=$AWS_REGION

aws sqs create-queue --queue-name dva-ch13-events
export QUEUE_URL=$(aws sqs get-queue-url --queue-name dva-ch13-events --query QueueUrl --output text)
export QUEUE_ARN=arn:aws:sqs:$AWS_REGION:$ACCOUNT_ID:dva-ch13-events
```

Output mong đợi của `create-bucket`:

```json
{
    "Location": "http://dva-ch13-lab-xxxx.s3.amazonaws.com/"
}
```

### Bước 2: Gắn access policy cho queue — bẫy kinh điển

S3 không tự có quyền gửi message vào queue của bạn. Phải gắn **resource-based policy** lên SQS cho phép principal `s3.amazonaws.com`, kèm condition `aws:SourceArn` để chống confused deputy (bucket người khác trỏ vào queue của bạn):

```bash
cat > /tmp/queue-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "s3.amazonaws.com" },
    "Action": "sqs:SendMessage",
    "Resource": "$QUEUE_ARN",
    "Condition": {
      "ArnEquals": { "aws:SourceArn": "arn:aws:s3:::$BUCKET" }
    }
  }]
}
EOF

aws sqs set-queue-attributes --queue-url $QUEUE_URL \
  --attributes "{\"Policy\": $(jq -c '. | tojson' /tmp/queue-policy.json)}"
```

> Nếu bỏ qua bước này, bước 3 sẽ fail với lỗi `Unable to validate the following destination configurations` — S3 **kiểm tra quyền ngay lúc cấu hình notification**, không phải lúc gửi event. Đây là lỗi gặp cả trong đề thi lẫn production.

### Bước 3: Cấu hình event notification trên bucket

Chỉ bắt event `s3:ObjectCreated:*` cho object có prefix `uploads/` và suffix `.csv`:

```bash
cat > /tmp/notif.json <<EOF
{
  "QueueConfigurations": [{
    "Id": "csv-uploaded",
    "QueueArn": "$QUEUE_ARN",
    "Events": ["s3:ObjectCreated:*"],
    "Filter": {
      "Key": {
        "FilterRules": [
          { "Name": "prefix", "Value": "uploads/" },
          { "Name": "suffix", "Value": ".csv" }
        ]
      }
    }
  }]
}
EOF

aws s3api put-bucket-notification-configuration \
  --bucket $BUCKET --notification-configuration file:///tmp/notif.json
```

Lệnh thành công sẽ **không in gì** (exit code 0). Kiểm tra lại:

```bash
aws s3api get-bucket-notification-configuration --bucket $BUCKET
```

### Bước 4: Upload file CSV và xác nhận event về queue

```bash
cat > /tmp/sales.csv <<EOF
order_id,country,amount
1001,VN,250
1002,US,900
1003,VN,120
1004,JP,480
EOF

aws s3 cp /tmp/sales.csv s3://$BUCKET/uploads/sales.csv

aws sqs receive-message --queue-url $QUEUE_URL \
  --wait-time-seconds 10 --max-number-of-messages 1 \
  --query 'Messages[0].Body' --output text | jq '.Records[0].eventName, .Records[0].s3.object.key'
```

Output mong đợi:

```
"ObjectCreated:Put"
"uploads/sales.csv"
```

Thử upload `s3://$BUCKET/other/sales.csv` (sai prefix) — sẽ KHÔNG có message, chứng minh filter prefix/suffix hoạt động.

### Bước 5: Tạo lifecycle rule

Rule gồm 3 phần: transition sang Standard-IA sau 30 ngày, sang Glacier Flexible Retrieval sau 90 ngày, và **abort incomplete multipart upload sau 7 ngày** (best practice luôn nên có — phần upload dở vẫn tính tiền dù không thấy object):

```bash
cat > /tmp/lifecycle.json <<EOF
{
  "Rules": [{
    "ID": "archive-uploads",
    "Status": "Enabled",
    "Filter": { "Prefix": "uploads/" },
    "Transitions": [
      { "Days": 30, "StorageClass": "STANDARD_IA" },
      { "Days": 90, "StorageClass": "GLACIER" }
    ],
    "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 }
  }]
}
EOF

aws s3api put-bucket-lifecycle-configuration \
  --bucket $BUCKET --lifecycle-configuration file:///tmp/lifecycle.json
```

Xác nhận bằng `aws s3api get-bucket-lifecycle-configuration --bucket $BUCKET`. Lưu ý: lifecycle chạy theo batch mỗi ngày (khoảng 00:00 UTC), transition không xảy ra "đúng giây thứ N" — nhưng bạn **ngừng bị tính tiền storage class cũ ngay khi đến hạn**, kể cả khi S3 transition trễ.

### Bước 6: Multipart upload thủ công qua CLI

`aws s3 cp` tự động multipart khi file > 8MB (mặc định `multipart_threshold`), nhưng để hiểu cơ chế — và trả lời được câu hỏi thi — hãy làm thủ công với file 12MB chia 2 part:

```bash
dd if=/dev/urandom of=/tmp/bigfile bs=1m count=12
split -b 6m /tmp/bigfile /tmp/part-      # tạo part-aa (6MB), part-ab (6MB)

# 1. Khởi tạo, nhận UploadId
UPLOAD_ID=$(aws s3api create-multipart-upload \
  --bucket $BUCKET --key uploads/bigfile.bin \
  --query UploadId --output text)

# 2. Upload từng part (mỗi part tối thiểu 5MB, trừ part cuối)
ETAG1=$(aws s3api upload-part --bucket $BUCKET --key uploads/bigfile.bin \
  --part-number 1 --upload-id $UPLOAD_ID --body /tmp/part-aa --query ETag --output text)
ETAG2=$(aws s3api upload-part --bucket $BUCKET --key uploads/bigfile.bin \
  --part-number 2 --upload-id $UPLOAD_ID --body /tmp/part-ab --query ETag --output text)

# 3. Complete — phải gửi danh sách part + ETag
aws s3api complete-multipart-upload \
  --bucket $BUCKET --key uploads/bigfile.bin --upload-id $UPLOAD_ID \
  --multipart-upload "{\"Parts\":[{\"PartNumber\":1,\"ETag\":$ETAG1},{\"PartNumber\":2,\"ETag\":$ETAG2}]}"
```

Output của bước complete chứa `"ETag": "\"...-2\""` — hậu tố `-2` cho biết object được ghép từ 2 part (ETag của object multipart KHÔNG phải MD5 của toàn file). Tải lại bằng **byte-range fetch** để lấy đúng 1KB đầu:

```bash
aws s3api get-object --bucket $BUCKET --key uploads/bigfile.bin \
  --range bytes=0-1023 /tmp/first-kb.bin
```

### Bước 7: S3 Select — truy vấn CSV bằng SQL

```bash
aws s3api select-object-content \
  --bucket $BUCKET --key uploads/sales.csv \
  --expression "SELECT s.order_id, s.amount FROM s3object s WHERE s.country = 'VN'" \
  --expression-type SQL \
  --input-serialization '{"CSV": {"FileHeaderInfo": "USE"}, "CompressionType": "NONE"}' \
  --output-serialization '{"CSV": {}}' \
  /tmp/select-result.csv

cat /tmp/select-result.csv
```

Output mong đợi:

```
1001,250
1003,120
```

Chỉ 2 dòng khớp filter được trả về — client không phải tải cả file. Với file vài GB, đây là khác biệt lớn về chi phí transfer và thời gian xử lý.

### Dọn dẹp tài nguyên

```bash
# Xoá toàn bộ object (thêm --recursive); nếu bucket có versioning thì phải xoá hết versions
aws s3 rm s3://$BUCKET --recursive

# Kiểm tra không còn multipart upload treo (nếu có thì abort)
aws s3api list-multipart-uploads --bucket $BUCKET
# aws s3api abort-multipart-upload --bucket $BUCKET --key <key> --upload-id <id>

aws s3api delete-bucket --bucket $BUCKET
aws sqs delete-queue --queue-url $QUEUE_URL
rm -f /tmp/sales.csv /tmp/bigfile /tmp/part-* /tmp/*.json /tmp/select-result.csv /tmp/first-kb.bin
```

Xác nhận `aws s3api head-bucket --bucket $BUCKET` trả về lỗi 404 là đã xoá sạch.

## 💡 Exam Tips chương 13

- **3.500 PUT/COPY/POST/DELETE và 5.500 GET/HEAD request mỗi giây cho MỖI prefix** — muốn tăng throughput thì rải object ra nhiều prefix (ví dụ thêm hash prefix), không có giới hạn số prefix trong bucket.
- Multipart upload: **bắt buộc với file > 5GB** (single PUT max 5GB), **khuyến nghị khi > 100MB**; mỗi part 5MB–5GB (trừ part cuối), tối đa 10.000 part, object size max 5TB.
- Part upload dở dang vẫn **tính tiền storage** — luôn cấu hình lifecycle rule `AbortIncompleteMultipartUpload` để tự dọn.
- Lifecycle transition có ràng buộc: object phải ở Standard/Standard-IA **tối thiểu 30 ngày trước khi chuyển sang IA/One Zone-IA**; object < 128KB transition sang IA không có lợi (phí per-object). Lifecycle chỉ đi "xuống" các class lạnh hơn — muốn đưa từ Glacier về Standard phải **restore rồi copy**.
- Câu hỏi "làm sao biết nên chuyển object sang IA sau bao nhiêu ngày?" → **S3 Analytics (Storage Class Analysis)** — chỉ gợi ý cho Standard → Standard-IA, không phân tích cho Glacier/One Zone-IA.
- Event notifications truyền thống gửi tới **SNS, SQS (standard — KHÔNG hỗ trợ FIFO), Lambda**; cần fan-out nhiều đích, filter nâng cao theo metadata/size, hay archive & replay → dùng **EventBridge**. Destination cần resource-based policy cho phép S3.
- Câu "tăng tốc upload từ user ở xa về 1 bucket tập trung" → **Transfer Acceleration** (đi qua edge location, dùng endpoint `<bucket>.s3-accelerate.amazonaws.com`); câu "tăng tốc download một phần file lớn / chỉ cần header của file" → **byte-range fetches** (song song hoá, retry phần nhỏ).
- "Truy vấn một phần dữ liệu trong file CSV/JSON/Parquet trên S3 mà không tải cả file, ít thay đổi code nhất" → **S3 Select** (giảm tới ~80% chi phí, nhanh hơn ~400%). Truy vấn nhiều file + join phức tạp → Athena (chi tiết ở Chương 48).
- "Thực hiện một thao tác trên hàng tỷ object hiện có" (copy hàng loạt, restore từ Glacier, thay tag, invoke Lambda) → **S3 Batch Operations** (nhận manifest từ **S3 Inventory**, có retry + report). Event notification chỉ áp dụng cho object MỚI.
- **Requester Pays**: người tải dữ liệu trả phí request + transfer (owner vẫn trả storage); requester phải authenticated (không anonymous) và gửi header `x-amz-request-payer=requester`.
- **S3 Storage Lens** = dashboard phân tích usage/activity **toàn organization, đa account đa region**; **S3 Analytics** = phân tích 1 bucket để quyết định lifecycle; **S3 Inventory** = báo cáo danh sách object định kỳ (CSV/ORC/Parquet) — đề hay gài 3 cái này với nhau.
- Checksums: S3 hỗ trợ CRC32/CRC32C/SHA-1/SHA-256 (và CRC64NVME) để verify integrity khi upload; ETag của object multipart **không phải** MD5 toàn file nên đừng dùng ETag để so checksum.

## Quiz chương 13 (10 câu)

**Câu 1.** Một ứng dụng ghi log vào S3 với key dạng `logs/2026/06/12/app1.log`. Ứng dụng đọc đạt 5.500 GET/s và bắt đầu nhận lỗi `503 Slow Down`. Giải pháp nào tăng throughput đọc?
- A. Bật Transfer Acceleration cho bucket
- B. Thêm nhiều prefix (ví dụ hash đầu key) và rải request trên các prefix đó
- C. Nâng cấp bucket lên storage class Standard-IA
- D. Mở support ticket xin AWS nâng request limit của bucket

**Câu 2.** A developer needs to upload các file backup 50GB lên S3 từ data center, đường truyền hay chập chờn. Cách nào đáng tin cậy và hiệu quả nhất?
- A. Dùng một lệnh PutObject duy nhất với timeout dài
- B. Nén file xuống dưới 5GB rồi PutObject
- C. Dùng multipart upload, retry từng part bị lỗi
- D. Dùng S3 Batch Operations để upload song song

**Câu 3.** Team thấy chi phí S3 tăng dù tổng dung lượng object hiển thị không đổi. Bucket nhận nhiều upload file lớn qua mạng không ổn định. Nguyên nhân khả dĩ nhất và cách xử lý?
- A. Versioning đang bật; tắt versioning
- B. Các multipart upload dở dang chiếm dung lượng; thêm lifecycle rule AbortIncompleteMultipartUpload
- C. S3 Inventory tạo report tốn dung lượng; tắt Inventory
- D. Object đã chuyển sang Glacier nên tốn phí retrieval; xoá lifecycle rule

**Câu 4.** Mỗi khi có object mới vào bucket, công ty cần xử lý đồng thời bởi 3 hệ thống độc lập, đồng thời muốn lưu trữ (archive) và phát lại (replay) event khi cần. Chọn giải pháp?
- A. Cấu hình 3 event notification S3 → 3 SQS queue
- B. S3 event notification → SNS topic → 3 SQS queue
- C. Bật EventBridge trên bucket, tạo rules đẩy tới 3 target và dùng archive & replay
- D. S3 event notification → Lambda, Lambda gọi 3 hệ thống

**Câu 5.** A developer cần đọc 100 dòng cuối của các file log 2GB trên S3 để debug, băng thông hạn chế. Cách hiệu quả nhất?
- A. GetObject với tham số `--range` để lấy byte cuối file
- B. Tải cả file rồi đọc phần cuối
- C. Dùng S3 Analytics để trích xuất dòng cần thiết
- D. Bật Transfer Acceleration rồi tải cả file

**Câu 6.** Ứng dụng phân tích chỉ cần 3 cột từ các file CSV 5GB trên S3, muốn giảm tối đa dữ liệu truyền về và thay đổi code ít nhất. Chọn dịch vụ?
- A. Athena với external table
- B. S3 Select với SQL expression
- C. Glue ETL job chuyển đổi file
- D. Lambda tải file và lọc cột

**Câu 7.** Công ty có 500 triệu object đang ở S3 Standard, cần copy toàn bộ sang bucket khác và gắn thêm tag. Cách ít công sức vận hành nhất?
- A. Viết script chạy `aws s3 cp --recursive` trên EC2
- B. Bật replication CRR cho bucket
- C. Dùng S3 Batch Operations với manifest từ S3 Inventory
- D. Cấu hình event notification → Lambda copy từng object

**Câu 8.** Một dataset public lớn được nhiều đối tác bên ngoài tải về thường xuyên, chủ bucket muốn không phải trả phí data transfer cho các lượt tải đó. Giải pháp?
- A. Bật Requester Pays trên bucket
- B. Chuyển object sang One Zone-IA
- C. Bật Transfer Acceleration để giảm phí transfer
- D. Phát hành presigned URL có thời hạn

**Câu 9.** Team chưa biết pattern truy cập object và muốn có khuyến nghị dựa trên dữ liệu để quyết định sau bao nhiêu ngày nên transition object từ Standard sang Standard-IA. Dùng gì?
- A. S3 Storage Lens
- B. S3 Inventory
- C. S3 Analytics (Storage Class Analysis)
- D. CloudWatch request metrics

**Câu 10.** Lifecycle rule cấu hình transition object prefix `docs/` sang Standard-IA sau 7 ngày. Khi lưu cấu hình, một số object bị lỗi/không có lợi về chi phí. Lý do nào đúng? (Chọn đáp án đúng nhất)
- A. Lifecycle không hỗ trợ filter theo prefix
- B. Transition sang Standard-IA yêu cầu object tồn tại tối thiểu 30 ngày ở Standard, và object < 128KB transition không có lợi
- C. Standard-IA không hỗ trợ truy cập tức thì nên S3 chặn transition
- D. Phải bật versioning trước khi dùng lifecycle rule

### Đáp án & giải thích

**Câu 1 — Đáp án B.** Giới hạn 5.500 GET/s là **per prefix**, không phải per bucket. Rải object/request ra nhiều prefix nhân throughput lên tuyến tính (2 prefix → 11.000 GET/s). A sai: Transfer Acceleration tối ưu đường truyền WAN từ client xa tới bucket, không tăng request rate. C sai: storage class không liên quan request limit; IA còn tốn phí retrieval. D sai: không có cơ chế "nâng request limit bucket" qua support — scaling theo prefix là thiết kế chuẩn của S3.

**Câu 2 — Đáp án C.** Multipart upload chia file thành part độc lập, part nào fail chỉ retry part đó, các part upload song song — đúng cho file lớn trên mạng không ổn định; hơn nữa 50GB > 5GB nên multipart là **bắt buộc**. A sai: single PUT max 5GB, 50GB không thể PutObject. B sai: nén không đảm bảo xuống dưới 5GB và là giải pháp chắp vá. D sai: Batch Operations thao tác trên object **đã có sẵn trong S3** (qua manifest), không phải công cụ upload từ on-premises.

**Câu 3 — Đáp án B.** Part của multipart upload chưa complete/abort vẫn chiếm dung lượng và tính tiền nhưng **không hiện trong list object thông thường** (phải dùng `list-multipart-uploads`). Lifecycle `AbortIncompleteMultipartUpload` tự dọn sau N ngày. A sai: versioning làm tăng chi phí khi ghi đè/xoá nhiều, nhưng tình huống nêu rõ "upload file lớn qua mạng không ổn định" — chỉ điểm multipart dở dang; tắt versioning cũng không xoá version cũ. C sai: report của Inventory rất nhỏ so với data. D sai: chuyển sang Glacier làm storage RẺ hơn; phí retrieval chỉ phát sinh khi restore.

**Câu 4 — Đáp án C.** EventBridge đáp ứng cả hai yêu cầu: nhiều rule/target cho 3 hệ thống, và tính năng **archive & replay** mà event notification truyền thống không có; còn thêm filter nâng cao và 18+ loại target. A sai: notification truyền thống không cho 2 cấu hình trùng event + prefix chồng lấn tới nhiều đích kiểu này một cách linh hoạt, và không có replay. B sai: SNS fan-out giải quyết được "3 hệ thống" nhưng KHÔNG có archive & replay. D sai: tự code fan-out trong Lambda là điểm lỗi đơn, không có replay, nhiều công vận hành.

**Câu 5 — Đáp án A.** Byte-range fetch (`Range: bytes=-N` lấy N byte cuối) chỉ truyền đúng phần cần — đây chính là use case "đọc footer/header file lớn" trong đề. B sai: tải 2GB để đọc vài KB là lãng phí băng thông đang hạn chế. C sai: S3 Analytics phân tích access pattern cho storage class, không đọc nội dung file. D sai: Transfer Acceleration vẫn tải cả file, chỉ nhanh hơn về đường truyền, vẫn tốn băng thông và phí.

**Câu 6 — Đáp án B.** S3 Select chạy SQL trực tiếp trên 1 object (CSV/JSON/Parquet, kể cả GZIP), server-side filtering nên chỉ trả về 3 cột cần — giảm tới ~80% chi phí; chỉ cần đổi lời gọi GetObject thành SelectObjectContent, ít thay đổi code nhất. A sai: Athena mạnh hơn (multi-file, join) nhưng phải tạo table/schema, thay đổi kiến trúc nhiều hơn yêu cầu "ít thay đổi nhất" cho 1 file. C sai: Glue ETL là pipeline transform nặng, quá mức cần thiết. D sai: Lambda vẫn phải tải cả 5GB qua mạng (và vượt giới hạn /tmp mặc định, timeout 15 phút là rủi ro).

**Câu 7 — Đáp án C.** Batch Operations sinh ra đúng cho việc này: nhận manifest (S3 Inventory hoặc CSV), thực thi copy/tag/restore/invoke Lambda trên hàng tỷ object, có managed retry và completion report — "least operational overhead". A sai: script tự viết phải tự lo retry, theo dõi tiến độ 500 triệu object, chạy nhiều ngày. B sai: replication chỉ áp dụng cho object mới sau khi bật (muốn replicate object cũ lại phải dùng... S3 Batch Replication — bản chất vẫn là Batch Operations), và không gắn tag mới theo yêu cầu. D sai: event notification không kích hoạt cho object đã tồn tại.

**Câu 8 — Đáp án A.** Requester Pays chuyển phí request + data transfer sang người tải; owner chỉ trả phí storage. Requester phải là IAM principal authenticated và khai báo header `x-amz-request-payer`. B sai: One Zone-IA giảm phí storage (và giảm độ bền AZ), không thay đổi ai trả phí transfer. C sai: Transfer Acceleration làm TĂNG phí (phụ phí accelerate) và owner vẫn trả. D sai: presigned URL chạy với quyền và **chi phí của người ký** — ngược hoàn toàn mục tiêu.

**Câu 9 — Đáp án C.** S3 Analytics (Storage Class Analysis) theo dõi access pattern và đưa ra khuyến nghị số ngày nên transition Standard → Standard-IA (xuất report CSV, ~24–48h để có kết quả đầu tiên); lưu ý nó KHÔNG khuyến nghị cho One Zone-IA hay Glacier. A sai: Storage Lens là dashboard usage/activity tổng quan đa account, không khuyến nghị ngày transition cụ thể. B sai: Inventory chỉ liệt kê object + metadata, không phân tích access pattern. D sai: CloudWatch metrics cho số liệu request thô, bạn phải tự phân tích.

**Câu 10 — Đáp án B.** Hai ràng buộc thực tế: S3 yêu cầu object ở Standard **tối thiểu 30 ngày** trước khi transition sang Standard-IA/One Zone-IA (rule "7 ngày" sẽ bị áp hiệu lực thực tế trễ hơn), và object nhỏ hơn 128KB transition sang IA thường tốn hơn vì phí tối thiểu per-object — console còn cảnh báo điều này. A sai: lifecycle hỗ trợ filter theo prefix, tag, object size. C sai: Standard-IA vẫn là millisecond access, truy cập tức thì bình thường. D sai: lifecycle hoạt động độc lập với versioning (versioning chỉ mở thêm action cho noncurrent versions).

## Tóm tắt chương

- Lifecycle rules tự động hoá transition giữa storage classes và expiration; ràng buộc 30 ngày tối thiểu trước khi sang IA, object < 128KB không nên transition; luôn thêm `AbortIncompleteMultipartUpload` để dọn upload dở.
- S3 Analytics (Storage Class Analysis) phân tích access pattern và khuyến nghị thời điểm transition Standard → Standard-IA — input tốt để viết lifecycle rule.
- Event notifications gửi tới SNS/SQS standard/Lambda (destination cần resource-based policy cho S3); EventBridge mở rộng với filter nâng cao, 18+ target, archive & replay; chỉ áp dụng cho event MỚI.
- Request rate: 3.500 write / 5.500 read mỗi giây **per prefix**; scale bằng cách rải object ra nhiều prefix.
- Multipart upload: bắt buộc > 5GB, khuyến nghị > 100MB; part 5MB–5GB, max 10.000 part; flow create → upload-part (kèm ETag) → complete; ETag kết quả không phải MD5 toàn file.
- Transfer Acceleration tăng tốc upload/download đường dài qua edge location; byte-range fetches tải song song hoặc lấy đúng phần file cần (header/footer).
- S3 Select / Glacier Select chạy SQL server-side trên 1 object CSV/JSON/Parquet — giảm dữ liệu truyền về tới ~80%; truy vấn nhiều file/join → Athena (Chương 48).
- S3 Batch Operations thao tác hàng loạt (copy, tag, ACL, restore, invoke Lambda) trên object có sẵn, dùng manifest từ S3 Inventory, có retry và report.
- S3 Inventory xuất danh sách object + metadata định kỳ (CSV/ORC/Parquet); S3 Storage Lens là dashboard usage/activity toàn organization — phân biệt rõ Inventory vs Analytics vs Storage Lens.
- Requester Pays: requester trả phí request + transfer (phải authenticated, gửi `x-amz-request-payer`), owner vẫn trả storage — dùng cho dataset chia sẻ quy mô lớn.
- Checksums (CRC32/CRC32C/SHA-1/SHA-256) verify integrity end-to-end khi upload; đừng dựa vào ETag của object multipart để so sánh nội dung.
- Bảo mật S3 (encryption, bucket policy, presigned URL chi tiết) ở Chương 14; phân phối qua CDN ở Chương 15.
