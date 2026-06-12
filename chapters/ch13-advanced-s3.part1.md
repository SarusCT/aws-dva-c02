# Chương 13: Advanced S3

> **Trọng tâm DVA-C02:** Chương này phủ nhóm câu hỏi "tối ưu" rất hay gặp trong domain Troubleshooting & Optimization: chọn lifecycle rule đúng để giảm chi phí, xử lý event notification khi object được upload, và tăng tốc upload/download (multipart, Transfer Acceleration, byte-range fetch). Đề thường cho tình huống "ứng dụng upload file lớn bị chậm/timeout" hoặc "cần trigger Lambda khi có file mới" — bạn phải chọn đúng cơ chế và biết giới hạn số liệu cụ thể (5GB, 5TB, 3.500/5.500 request/s per prefix).

## Mục tiêu chương

- Thiết kế lifecycle rules chuyển storage class và expire object đúng quy tắc (thứ tự transition, minimum storage duration, object nhỏ hơn 128KB).
- Cấu hình S3 Event Notifications tới SNS/SQS/Lambda và hiểu khi nào nên chuyển sang EventBridge.
- Tối ưu performance: hiểu giới hạn request rate per prefix, dùng multipart upload đúng cách, Transfer Acceleration, byte-range fetches.
- Dùng S3 Select/Glacier Select để lọc dữ liệu phía server thay vì tải cả object về.
- Vận hành ở quy mô lớn: S3 Batch Operations, S3 Inventory, S3 Storage Lens.
- Hiểu Requester Pays và cơ chế checksum để đảm bảo toàn vẹn dữ liệu.

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
| Object < **128KB** | Mặc định KHÔNG được transition sang IA/Intelligent-Tiering (phí transition + phụ phí per-object sẽ đắt hơn tiền lưu trữ tiết kiệm được) |

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

Đừng nhầm với **S3 Intelligent-Tiering** (Chương 12): Analytics chỉ *đề xuất* để bạn tự viết lifecycle rule; Intelligent-Tiering tự động *di chuyển* object giữa các tier.

## 13.2 S3 Event Notifications

Use case kinh điển: user upload ảnh → tự động tạo thumbnail. S3 phát event khi có thay đổi trên object và đẩy tới đích xử lý. Có hai con đường:

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

**Bẫy số 3 — không phải exactly-once.** Event được gửi "typically in seconds, sometimes a minute or longer", **at least once** — consumer phải idempotent. SQS đích chỉ được là **standard queue, không hỗ trợ FIFO queue** làm đích trực tiếp (muốn FIFO thì đi qua EventBridge hoặc SNS→SQS FIFO không được — phải EventBridge).

### Đường 2 — EventBridge (khuyến nghị cho hệ mới)

Bật một công tắc trên bucket (`aws s3api put-bucket-notification-configuration` với `EventBridgeConfiguration: {}`), mọi event của bucket sẽ đổ về **default event bus** của EventBridge. Lợi thế so với notification truyền thống:

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

Lưu ý lịch sử hay bị hỏi: trước đây nếu hai bản ghi cùng key được PUT gần như đồng thời trên bucket không bật versioning, có thể chỉ một event được gửi. AWS khuyến nghị **bật versioning** để đảm bảo mỗi lần ghi thành công sinh đúng một event với version ID riêng.

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

CLI v2 (`aws s3 cp`) tự động chuyển sang multipart khi file vượt `multipart_threshold` (mặc định 8MB) — đây là lý do `aws s3 cp` upload được file 50GB còn `aws s3api put-object` thì không.

Go SDK v2 có tương đương là `feature/s3/manager` với `manager.NewUploader(client)` — cùng cơ chế.

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
