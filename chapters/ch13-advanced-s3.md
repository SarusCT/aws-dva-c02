# Chương 13: Advanced S3

> **Trọng tâm DVA-C02:** Chương này phủ nhóm câu hỏi "tối ưu" rất hay gặp trong domain Troubleshooting & Optimization: chọn lifecycle rule đúng để giảm chi phí, xử lý event notification khi object được upload, và tăng tốc upload/download (multipart, Transfer Acceleration, byte-range fetch). Đề thường cho tình huống "ứng dụng upload file lớn bị chậm/timeout", "cần trigger Lambda khi có file mới", hoặc "lọc dữ liệu CSV trong S3 mà không tải cả file về" — bạn phải chọn đúng cơ chế và biết giới hạn số liệu cụ thể (5GB, 5TB, 3.500/5.500 request/s per prefix, 128KB).

## Mục tiêu chương

- Thiết kế lifecycle rules chuyển storage class và expire object đúng quy tắc (thứ tự transition, minimum storage duration, object nhỏ hơn 128KB, abort multipart).
- Cấu hình S3 Event Notifications tới SNS/SQS/Lambda và hiểu khi nào nên chuyển sang EventBridge.
- Tối ưu performance: hiểu giới hạn request rate per prefix, dùng multipart upload đúng cách, Transfer Acceleration, byte-range fetches.
- Dùng S3 Select/Glacier Select để lọc dữ liệu phía server thay vì tải cả object về.
- Vận hành ở quy mô lớn: S3 Batch Operations, S3 Inventory, S3 Storage Lens.
- Hiểu Requester Pays và cơ chế checksum để đảm bảo toàn vẹn dữ liệu khi truyền.

## 13.1 Lifecycle Rules — tự động chuyển class và xoá object

Ở Chương 12 bạn đã biết các storage class và bài toán chi phí của chúng. Vấn đề thực tế: không ai ngồi gọi `CopyObject` để đổi class cho hàng triệu object bằng tay. **Lifecycle configuration** là tập rule gắn vào bucket, S3 chạy nền mỗi ngày (thường quanh nửa đêm UTC) để thực hiện hai loại action:

- **Transition actions:** chuyển object sang storage class khác sau N ngày kể từ khi tạo (hoặc kể từ khi trở thành noncurrent version).
- **Expiration actions:** xoá object (với versioned bucket là tạo delete marker), xoá noncurrent versions, xoá delete marker "mồ côi" (expired object delete markers), và **abort incomplete multipart uploads**.

### Quy tắc transition — chỗ đề thi hay gài

Transition chỉ đi "xuống" theo thứ tự waterfall, không đi ngược lên:

```
Standard → Standard-IA → Intelligent-Tiering → One Zone-IA
        → Glacier Instant Retrieval → Glacier Flexible Retrieval → Glacier Deep Archive
```

Muốn đưa object từ Glacier về Standard? Không có transition ngược — bạn phải **restore** (tạo bản copy tạm) rồi `CopyObject` sang class mới.

Các con số phải nhớ chính xác:

| Quy tắc | Số liệu |
|---|---|
| Tối thiểu ở Standard trước khi chuyển sang Standard-IA / One Zone-IA | **30 ngày** |
| Minimum storage duration: Standard-IA, One Zone-IA | 30 ngày (xoá sớm vẫn tính tiền đủ 30 ngày) |
| Minimum storage duration: Glacier Instant / Flexible Retrieval | 90 ngày |
| Minimum storage duration: Glacier Deep Archive | 180 ngày |
| Object < **128KB** | Mặc định KHÔNG được transition sang IA/Intelligent-Tiering (phí transition + phụ phí per-object đắt hơn tiền lưu trữ tiết kiệm được) |

Hệ quả của quy tắc 30 ngày: rule "chuyển sang Standard-IA sau 10 ngày" sẽ bị reject khi bạn PUT lifecycle configuration. Nhưng "chuyển thẳng sang Glacier sau 1 ngày" thì hợp lệ — Glacier không yêu cầu 30 ngày ở Standard trước.

### Lifecycle với versioning

Trên versioned bucket (Chương 12), lifecycle có thêm các action riêng cho noncurrent versions — đây là combo điển hình trong đề:

```json
{
  "Rules": [
    {
      "ID": "log-archive-rule",
      "Status": "Enabled",
      "Filter": { "Prefix": "logs/" },
      "Transitions": [
        { "Days": 30, "StorageClass": "STANDARD_IA" },
        { "Days": 90, "StorageClass": "GLACIER" }
      ],
      "NoncurrentVersionTransitions": [
        { "NoncurrentDays": 30, "StorageClass": "GLACIER" }
      ],
      "NoncurrentVersionExpiration": {
        "NoncurrentDays": 365,
        "NewerNoncurrentVersions": 5
      },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 },
      "Expiration": { "ExpiredObjectDeleteMarker": false }
    }
  ]
}
```

Áp rule bằng CLI:

```bash
aws s3api put-bucket-lifecycle-configuration \
  --bucket my-app-logs \
  --lifecycle-configuration file://lifecycle.json

# Kiểm tra lại
aws s3api get-bucket-lifecycle-configuration --bucket my-app-logs
```

Vài điểm tinh tế:

- `Filter` có thể theo prefix, tag, kích thước object (`ObjectSizeGreaterThan`/`ObjectSizeLessThan`), hoặc kết hợp bằng `And`.
- `AbortIncompleteMultipartUpload` là rule "vệ sinh" nên bật cho MỌI bucket có upload lớn: các part của multipart upload bị bỏ dở vẫn **tính tiền lưu trữ** dù bạn không thấy chúng qua `ListObjects`. Chỉ thấy qua `aws s3api list-multipart-uploads`.
- Expiration trên versioned bucket KHÔNG xoá dữ liệu — nó chỉ thêm delete marker; dữ liệu thật chỉ mất khi `NoncurrentVersionExpiration` chạy.
- Lifecycle chạy theo batch hàng ngày, nên object có thể bị tính phí thêm tối đa ~1 ngày trước khi transition thực sự xảy ra; ngược lại, kể từ thời điểm đủ điều kiện expire, S3 **không tính tiền nữa** kể cả khi việc xoá vật lý diễn ra trễ.

> 💡 **Exam Tip:** Câu hỏi "company uploads large files, storage costs increasing but bucket looks empty / chi phí cao bất thường" → đáp án gần như chắc chắn là lifecycle rule **AbortIncompleteMultipartUpload**. Câu hỏi "giảm chi phí log: cần truy cập ngay trong 30 ngày, hiếm khi đọc trong 90 ngày, giữ 5 năm cho compliance" → Standard 30 ngày → Standard-IA → Glacier Deep Archive + Expiration sau 5 năm.

### S3 Analytics — Storage Class Analysis

Bạn không biết nên đặt mốc transition bao nhiêu ngày? **S3 Analytics (Storage Class Analysis)** theo dõi access pattern của object và xuất report CSV hàng ngày vào một bucket khác, gợi ý thời điểm nên chuyển từ **Standard sang Standard-IA**. Giới hạn quan trọng:

- Chỉ đưa khuyến nghị cho cặp **Standard → Standard-IA**. KHÔNG khuyến nghị One Zone-IA hay Glacier.
- Cần **24–48 giờ** sau khi bật mới có dữ liệu đầu tiên; cần chạy ~30 ngày để khuyến nghị đáng tin.
- Report có thể đổ vào Amazon QuickSight để visualize.

Đừng nhầm với **S3 Intelligent-Tiering** (Chương 12): Analytics chỉ *đề xuất* để bạn tự viết lifecycle rule; Intelligent-Tiering tự động *di chuyển* object giữa các tier dựa trên access pattern.

## 13.2 S3 Event Notifications

Use case kinh điển: user upload ảnh → tự động tạo thumbnail. S3 phát event khi có thay đổi trên object và đẩy tới đích xử lý. Có hai con đường.

### Đường 1 — Event notification truyền thống (SNS / SQS / Lambda)

Các loại event: `s3:ObjectCreated:*` (Put/Post/Copy/CompleteMultipartUpload), `s3:ObjectRemoved:*`, `s3:ObjectRestore:*`, `s3:Replication:*`, `s3:LifecycleTransition`, `s3:LifecycleExpiration`, `s3:ObjectTagging:*`... Mỗi rule lọc được theo **prefix** và **suffix** (ví dụ `images/` + `.jpg`).

Cấu hình:

```bash
aws s3api put-bucket-notification-configuration \
  --bucket my-upload-bucket \
  --notification-configuration '{
    "QueueConfigurations": [{
      "Id": "new-image-to-sqs",
      "QueueArn": "arn:aws:sqs:ap-southeast-1:123456789012:image-queue",
      "Events": ["s3:ObjectCreated:*"],
      "Filter": {
        "Key": {
          "FilterRules": [
            {"Name": "prefix", "Value": "images/"},
            {"Name": "suffix", "Value": ".jpg"}
          ]
        }
      }
    }]
  }'
```

**Bẫy số 1 — resource policy ở phía đích.** S3 không dùng IAM role của bạn để gửi event; service principal `s3.amazonaws.com` phải được cho phép trong **resource-based policy** của đích: `SQS:SendMessage` trên queue policy, `SNS:Publish` trên topic policy, `lambda:InvokeFunction` qua resource-based policy của function. Quên policy này → lệnh put-notification trả lỗi "Unable to validate the destination configuration". Nên thêm condition `aws:SourceArn` = ARN bucket để chống confused deputy.

**Bẫy số 2 — overlap rule.** Hai rule cùng event type không được có prefix/suffix chồng lấn nhau (ví dụ cùng `ObjectCreated` cho `images/` và `images/raw/`) — S3 reject toàn bộ configuration.

**Bẫy số 3 — không phải exactly-once.** Event được gửi "typically in seconds, sometimes a minute or longer", **at least once** — consumer phải idempotent. Đích SQS chỉ được là **standard queue**; SQS **FIFO không hỗ trợ** làm đích trực tiếp của S3 notification (muốn FIFO phải đi qua EventBridge).

### Đường 2 — EventBridge (khuyến nghị cho hệ mới)

Bật một công tắc trên bucket (`put-bucket-notification-configuration` với `EventBridgeConfiguration: {}`), mọi event của bucket sẽ đổ về **default event bus** của EventBridge. Lợi thế so với notification truyền thống:

| Tiêu chí | S3 Notifications | EventBridge |
|---|---|---|
| Đích | SNS, SQS (standard), Lambda | **18+ loại target**: Step Functions, Kinesis Streams/Firehose, SQS FIFO, API destinations... |
| Lọc | Chỉ prefix/suffix | **JSON pattern trên toàn bộ event**: object size, metadata, tên object phức tạp |
| Số đích cho 1 event | 1 đích / 1 rule | Nhiều rule, nhiều target song song |
| Replay | Không | **Archive & replay** events |
| Độ tin cậy | At least once | At least once + retry/DLQ của EventBridge |
| Chi phí | Miễn phí | Tính phí theo event (rẻ) |

Chi tiết về rules, event pattern và input transformation ở Chương 25.

> 💡 **Exam Tip:** Tình huống "cần gửi event S3 tới NHIỀU đích" hoặc "lọc theo object size / metadata" hoặc "replay lại event đã qua" → chọn **EventBridge**. Tình huống đơn giản "trigger Lambda khi có file .csv trong prefix uploads/" → notification truyền thống là đủ và là đáp án "ít công cấu hình nhất".

Lưu ý lịch sử hay bị hỏi: trên bucket không bật versioning, nếu hai bản ghi cùng key được PUT gần như đồng thời, có thể chỉ một event được gửi. AWS khuyến nghị **bật versioning** để đảm bảo mỗi lần ghi thành công sinh đúng một event với version ID riêng.

## 13.3 Performance: prefix, multipart, Transfer Acceleration, byte-range

### Request rate per prefix

S3 tự động scale tới ít nhất **3.500 PUT/COPY/POST/DELETE** và **5.500 GET/HEAD request mỗi giây cho MỖI prefix** trong bucket. Số prefix không giới hạn, nên throughput tổng = số prefix × giới hạn trên. Ví dụ đọc song song từ 4 prefix `logs/2026/06/12/a/`, `…/b/`, `…/c/`, `…/d/` → lý thuyết đạt 22.000 GET/s.

"Prefix" ở đây là phần đường dẫn giữa tên bucket và tên file: object `bucket/folder1/sub1/file.txt` có prefix `folder1/sub1/`. Ngày xưa phải random hoá ký tự đầu của key để tránh hot partition — quy tắc đó **đã lỗi thời**, nhưng tư duy "rải key ra nhiều prefix khi cần throughput cực cao" vẫn đúng. Khi vượt rate, S3 trả **HTTP 503 Slow Down** — SDK tự retry với exponential backoff (Chương 3); nếu bị đều đặn, hãy rải key ra nhiều prefix hơn.

Một lưu ý liên quan KMS: nếu object mã hoá SSE-KMS, mỗi upload/download gọi thêm KMS API và chịu quota riêng của KMS (chi tiết ở Chương 14 và 46) — đôi khi nghẽn ở KMS chứ không phải S3.

### Multipart upload — cơ chế và số liệu

Multipart chia file thành nhiều part upload **song song và độc lập**, part lỗi chỉ cần retry part đó. Ba con số bắt buộc thuộc lòng:

- **Khuyến nghị** dùng khi file > **100MB**; **bắt buộc** khi file > **5GB** (giới hạn của single PUT); object tối đa **5TB**.
- Mỗi upload tối đa **10.000 parts**; part size từ **5MB đến 5GB** (part cuối được nhỏ hơn 5MB).
- Vì 10.000 × part size ≥ file size, file 5TB cần part tối thiểu ~525MB.

Flow API gồm 3 bước: `CreateMultipartUpload` (nhận `UploadId`) → `UploadPart` lặp song song (mỗi part trả ETag) → `CompleteMultipartUpload` (gửi danh sách part + ETag để S3 ghép). Có thể `AbortMultipartUpload` để huỷ và xoá part đã upload.

Với SDK JS v3, đừng tự viết flow — dùng `@aws-sdk/lib-storage` lo hết việc chia part, song song hoá và retry:

```javascript
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { createReadStream } from "node:fs";

const s3 = new S3Client({ region: "ap-southeast-1" });

const upload = new Upload({
  client: s3,
  params: {
    Bucket: "my-video-bucket",
    Key: "raw/movie-4k.mp4",
    Body: createReadStream("./movie-4k.mp4"),
  },
  queueSize: 4,                 // 4 part upload song song
  partSize: 50 * 1024 * 1024,   // 50MB mỗi part (>= 5MB)
  leavePartsOnError: false,     // tự abort nếu lỗi, tránh part rác tính tiền
});

upload.on("httpUploadProgress", (p) => {
  console.log(`Đã upload ${p.loaded}/${p.total} bytes`); // theo dõi tiến độ
});

await upload.done();
```

CLI v2 (`aws s3 cp`) tự động chuyển sang multipart khi file vượt `multipart_threshold` (mặc định 8MB) — đây là lý do `aws s3 cp` upload được file 50GB còn `aws s3api put-object` thì không. Go SDK v2 có tương đương là `feature/s3/manager` với `manager.NewUploader(client)` — cùng cơ chế.

### S3 Transfer Acceleration

Bài toán: client ở xa region của bucket (user Việt Nam upload lên bucket `us-east-1`), kết nối public internet đường dài chậm và không ổn định. **Transfer Acceleration** cho client gửi dữ liệu tới **edge location** CloudFront gần nhất, từ đó dữ liệu chạy trên **mạng backbone riêng của AWS** về bucket. Bật ở mức bucket:

```bash
aws s3api put-bucket-accelerate-configuration \
  --bucket my-global-bucket \
  --accelerate-configuration Status=Enabled

# Client dùng endpoint riêng:
# my-global-bucket.s3-accelerate.amazonaws.com
aws s3 cp big.zip s3://my-global-bucket/ --endpoint-url https://s3-accelerate.amazonaws.com
```

Với SDK JS v3: `new S3Client({ useAccelerateEndpoint: true })`. Lưu ý:

- Tên bucket phải **DNS-compliant và không chứa dấu chấm** (vì nhúng vào hostname).
- Tính thêm phí per-GB, nhưng AWS **chỉ tính khi thực sự nhanh hơn** đường thường (Speed Comparison tool có sẵn để đo).
- Kết hợp tốt với multipart: multipart giải quyết song song hoá, Transfer Acceleration giải quyết quãng đường — câu trả lời đúng cho "upload file lớn từ nhiều nơi trên thế giới" thường là **cả hai**.

### Byte-range fetches

GET với header `Range: bytes=0-1048575` chỉ tải về dải byte chỉ định. Hai use case:

1. **Tăng tốc download:** chạy nhiều GET song song, mỗi GET một dải — chính là "multipart download". Nếu một dải lỗi, chỉ retry dải đó → tăng resilience.
2. **Đọc một phần object:** ví dụ chỉ cần header 256 byte đầu của file binary để xác định loại file, không tải cả 2GB.

```javascript
import { GetObjectCommand } from "@aws-sdk/client-s3";

// Chỉ lấy 1MB đầu tiên của object
const res = await s3.send(new GetObjectCommand({
  Bucket: "my-video-bucket",
  Key: "raw/movie-4k.mp4",
  Range: "bytes=0-1048575",
}));
```

> 💡 **Exam Tip:** Phân biệt 3 đáp án tối ưu hay đứng cạnh nhau: upload chậm vì file lớn → **multipart upload**; upload chậm vì client ở xa region → **Transfer Acceleration**; download chậm / chỉ cần một phần file → **byte-range fetches**. Đề hay ghép 2 trong 3 vào cùng câu hỏi để bạn chọn combo đúng.

## 13.4 S3 Select & Glacier Select — lọc dữ liệu phía server

Bài toán: bạn có file CSV/JSON/Parquet 1GB trong S3 nhưng chỉ cần vài cột và vài dòng thoả điều kiện. Cách "ngây thơ" là GET cả object 1GB về app rồi parse — tốn băng thông, tốn RAM, chậm. **S3 Select** cho phép gửi một câu **SQL đơn giản** lên S3, S3 chạy filter ngay trên server và **chỉ trả về phần dữ liệu khớp** — giảm tới ~80% dữ liệu truyền và tăng tốc đáng kể.

Đặc điểm và giới hạn:

- Input: **CSV, JSON, hoặc Apache Parquet**; có thể nén GZIP/BZIP2 (với CSV/JSON).
- Output: CSV hoặc JSON.
- Hoạt động trên **một object duy nhất** mỗi lần gọi (không JOIN nhiều object, không aggregate phức tạp kiểu GROUP BY trên nhiều file).
- API là `SelectObjectContent`, kết quả trả về dạng **event stream** (streaming records).

```javascript
import { S3Client, SelectObjectContentCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({ region: "ap-southeast-1" });

const command = new SelectObjectContentCommand({
  Bucket: "analytics-data",
  Key: "sales/2026-q2.csv",
  ExpressionType: "SQL",
  Expression: "SELECT s.product, s.amount FROM S3Object s WHERE s.region = 'APAC'",
  InputSerialization: { CSV: { FileHeaderInfo: "USE" }, CompressionType: "NONE" },
  OutputSerialization: { CSV: {} },
});

const { Payload } = await s3.send(command);
for await (const event of Payload) {
  if (event.Records) process.stdout.write(event.Records.Payload); // chunk kết quả
}
```

**Glacier Select** là cơ chế tương tự nhưng chạy query trực tiếp trên dữ liệu đã archive ở Glacier mà không cần restore toàn bộ object trước — phù hợp tình huống "thỉnh thoảng cần lọc vài bản ghi trong archive lớn cho audit".

> 💡 **Exam Tip:** Từ khoá nhận diện S3 Select: "retrieve a subset of data", "using simple SQL", "without retrieving the entire object", "reduce data transfer / cost". Nếu câu hỏi cần **JOIN, aggregate phức tạp, query nhiều file, partitioning** → đó là **Amazon Athena** (Chương 48), KHÔNG phải S3 Select. S3 Select = một object, filter đơn giản; Athena = data lake, SQL đầy đủ trên hàng nghìn file.

## 13.5 S3 Batch Operations — thao tác hàng loạt triệu object

Bạn cần copy 50 triệu object sang bucket khác, hoặc đổi storage class, hoặc thêm tag, hoặc gọi một Lambda xử lý từng object. Viết script lặp `ListObjects` rồi gọi API tuần tự sẽ chạy nhiều ngày và phải tự lo retry/checkpoint. **S3 Batch Operations** làm việc đó ở quy mô lớn, có quản lý: bạn định nghĩa một **Job** gồm danh sách object + một action, S3 chạy song song, retry tự động, sinh **completion report** và **theo dõi tiến độ**.

Các action hỗ trợ:

- **PUT copy** (copy object, kể cả cross-region/cross-account).
- **Replace all object tags / Delete all object tags.**
- **Replace access control list (ACL).**
- **Restore** object từ Glacier (initiate restore hàng loạt).
- **Invoke AWS Lambda function** — xử lý tuỳ ý từng object (resize ảnh, re-encrypt, validate...).
- **Object Lock retention / legal hold.**

Đầu vào danh sách object lấy từ một trong hai nguồn: **S3 Inventory report** (xem 13.6) hoặc một **CSV manifest** bạn tự cung cấp (gồm cột bucket, key, optional version ID).

```bash
aws s3control create-job \
  --account-id 123456789012 \
  --operation '{"S3PutObjectCopy":{"TargetResource":"arn:aws:s3:::dest-bucket"}}' \
  --manifest '{
    "Spec": {"Format":"S3BatchOperations_CSV_20180820","Fields":["Bucket","Key"]},
    "Location": {"ObjectArn":"arn:aws:s3:::manifest-bucket/manifest.csv",
                 "ETag":"<etag-cua-manifest>"}
  }' \
  --report '{"Bucket":"arn:aws:s3:::report-bucket","Format":"Report_CSV_20180820",
             "Enabled":true,"Prefix":"batch-reports","ReportScope":"AllTasks"}' \
  --priority 10 \
  --role-arn arn:aws:iam::123456789012:role/S3BatchRole \
  --region ap-southeast-1 \
  --no-confirmation-required
```

Điểm cần nhớ: Batch Operations cần một **IAM role** để S3 thay mặt bạn thao tác lên object; job được tạo ở trạng thái cần **confirm** (trừ khi `--no-confirmation-required`); có thể đặt **priority** để xếp thứ tự nhiều job; report ghi rõ object nào fail và vì sao.

> 💡 **Exam Tip:** "Process / re-encrypt / copy millions of existing objects" hoặc "apply a Lambda function to all objects in a bucket" → **S3 Batch Operations** (lấy danh sách từ S3 Inventory). Đừng nhầm với **Event Notifications** — notification chỉ trigger cho object **mới phát sinh sự kiện**, không xử lý được object đã có sẵn từ trước. Batch Operations mới là công cụ cho "existing objects".

## 13.6 S3 Inventory — kiểm kê object định kỳ

`ListObjectsV2` ổn cho bucket vài nghìn object, nhưng với hàng trăm triệu object thì paginate qua API tốn thời gian và tiền request. **S3 Inventory** cho S3 tự xuất một **file danh sách (flat file)** định kỳ — **hàng ngày hoặc hàng tuần** — vào một bucket đích, liệt kê object và metadata của chúng.

- Định dạng output: **CSV, Apache ORC, hoặc Apache Parquet**.
- Trường có thể chọn: size, last modified, **storage class**, **ETag**, **encryption status**, **replication status**, version ID, multipart upload flag, object lock... — rất tiện để audit "có bao nhiêu object chưa mã hoá", "bao nhiêu object còn ở Standard".
- Phạm vi: cả bucket hoặc lọc theo prefix; bao gồm current version hoặc cả noncurrent versions.
- Có thể query trực tiếp inventory report bằng **Athena**.

Quan hệ với Batch Operations rất chặt: inventory report chính là **manifest đầu vào** lý tưởng cho một Batch Operations job. Quy trình kinh điển: Inventory liệt kê toàn bộ object chưa mã hoá → Batch Operations gọi PUT copy/Lambda để re-encrypt chúng.

```bash
aws s3api put-bucket-inventory-configuration \
  --bucket source-bucket \
  --id daily-inventory \
  --inventory-configuration '{
    "Destination": {"S3BucketDestination": {
      "Bucket":"arn:aws:s3:::inventory-dest","Format":"Parquet"}},
    "IsEnabled": true,
    "IncludedObjectVersions": "Current",
    "Schedule": {"Frequency": "Daily"},
    "OptionalFields": ["Size","StorageClass","EncryptionStatus","ETag"]
  }'
```

> 💡 **Exam Tip:** "Audit which objects are encrypted / which storage class / report on all objects regularly" → **S3 Inventory**. Cần thao tác lên kết quả audit đó → nối với **S3 Batch Operations**. Cần thống kê/visualize usage tổng hợp toàn tổ chức → **S3 Storage Lens** (mục 13.7) — đừng nhầm Inventory (danh sách object) với Storage Lens (analytics tổng hợp).

## 13.7 S3 Storage Lens — phân tích usage toàn tổ chức

**S3 Storage Lens** là công cụ analytics cho toàn bộ S3 ở mức **organization / account / region / bucket / prefix**: trả lời các câu "tổng dung lượng đang dùng là bao nhiêu", "bucket nào tăng nhanh nhất", "bao nhiêu % object chưa bật encryption", "incomplete multipart uploads đang chiếm bao nhiêu", "object nào không được truy cập lâu ngày". Nó tổng hợp ~30 metric và đưa **khuyến nghị tối ưu chi phí và bảo mật**.

- Có một **default dashboard** miễn phí (free metrics) cho mỗi account, dữ liệu giữ **14 ngày**.
- Bật **advanced metrics & recommendations** (tính phí) để có thêm metric (activity, prefix-level, status code) và giữ dữ liệu **15 tháng**.
- Tích hợp **AWS Organizations** để xem toàn bộ account trong org từ một dashboard duy nhất.
- Xuất metric hàng ngày ra một bucket (CSV/Parquet) để phân tích bằng Athena/QuickSight.

Phân biệt nhanh bộ ba dễ lẫn trong đề:

| Công cụ | Trả lời câu gì | Output |
|---|---|---|
| **S3 Analytics (Storage Class Analysis)** | "Object này nên chuyển Standard → Standard-IA khi nào?" | Report theo bucket/prefix, gợi ý ngày transition |
| **S3 Inventory** | "Liệt kê tất cả object + metadata (encryption, class, ETag)" | Flat file CSV/Parquet danh sách object |
| **S3 Storage Lens** | "Bức tranh tổng hợp usage & activity toàn org, khuyến nghị tối ưu" | Dashboard + metric export, 30 metric |

> 💡 **Exam Tip:** "Organization-wide visibility into storage usage and activity / cost optimization recommendations across all accounts" → **S3 Storage Lens**. "Recommend when to move objects to IA" (chỉ một cặp class, mức bucket) → **S3 Analytics**. Nhớ Storage Lens là duy nhất nhìn xuyên **toàn bộ AWS Organizations**.

## 13.8 Requester Pays & Checksums

### Requester Pays

Mặc định **chủ bucket** trả phí lưu trữ lẫn phí request và data transfer. Khi bạn chia sẻ một dataset lớn cho nhiều bên tải về, hoá đơn transfer có thể khổng lồ. Bật **Requester Pays** trên bucket: chủ bucket vẫn trả phí lưu trữ, nhưng **người gọi request trả phí request + data transfer**.

```bash
aws s3api put-bucket-request-payment \
  --bucket public-dataset \
  --request-payment-configuration Payer=Requester
```

Quy tắc thi cần nhớ:

- Người request **bắt buộc phải được authenticate** (không cho phép anonymous) và phải kèm header `x-amz-request-payer: requester` trong mọi request, nếu không sẽ nhận **403 Access Denied**. Với CLI: thêm `--request-payer requester`.
- Người request cần IAM permission từ tài khoản của họ và bucket policy của chủ phải cho phép họ truy cập.

> 💡 **Exam Tip:** "Share a large dataset but the bucket owner does not want to pay for download/transfer costs" → **Requester Pays**. Nhớ caller phải authenticated và gửi header `x-amz-request-payer`.

### Checksums — toàn vẹn dữ liệu khi truyền

Mạng có thể làm hỏng vài bit khi truyền. S3 hỗ trợ **checksum** để xác minh object nhận được đúng như object gửi đi (end-to-end integrity). Khi PUT, client tính checksum và gửi kèm; S3 tính lại phía server, **không khớp thì từ chối** ghi.

- Thuật toán hỗ trợ: **CRC32, CRC32C, SHA-1, SHA-256** (chọn qua header `x-amz-checksum-algorithm` hoặc tham số SDK `ChecksumAlgorithm`). CRC nhanh, dùng cho integrity; SHA dùng khi cần độ mạnh mật mã.
- Ngoài ra mọi object luôn có **ETag**: với single-part PUT (không mã hoá SSE-KMS/SSE-C), ETag là **MD5** của nội dung — có thể dùng để verify nhanh. Nhưng với **multipart upload**, ETag KHÔNG phải MD5 của cả file mà là hash của tập checksum các part kèm hậu tố `-<số part>` (ví dụ `...-4`) → đừng dùng ETag để so MD5 cho file multipart.

```bash
# Yêu cầu S3 tính & lưu checksum SHA-256 khi upload
aws s3api put-object --bucket my-bucket --key data.bin \
  --body data.bin --checksum-algorithm SHA256
```

```javascript
import { PutObjectCommand } from "@aws-sdk/client-s3";

await s3.send(new PutObjectCommand({
  Bucket: "my-bucket",
  Key: "data.bin",
  Body: fileBuffer,
  ChecksumAlgorithm: "CRC32C", // S3 verify integrity, từ chối nếu lệch
}));
```

> 💡 **Exam Tip:** "Ensure data integrity of uploaded objects / verify the object was not corrupted in transit" → dùng **checksum** (CRC32C/SHA-256) khi PutObject; S3 sẽ reject nếu checksum không khớp. Nhớ rằng **ETag của object multipart không phải MD5** của cả file — đây là cái bẫy hay gặp khi code tự verify integrity.

---

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
