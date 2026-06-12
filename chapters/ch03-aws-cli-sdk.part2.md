## Hands-on Lab: Làm chủ AWS CLI v2, named profiles, --query và SDK JS v3 (pagination + waiter + retry)

**Mục tiêu lab:** Cấu hình AWS CLI v2 với nhiều named profile, kiểm chứng credentials provider chain, dùng `--query`/`--output` để xử lý output, thử `--dry-run`, lấy session token MFA bằng STS, rồi viết một script Node.js dùng SDK v3 có pagination, waiter và custom retry config. Toàn bộ lab chỉ tạo 1 S3 bucket và 1 IAM user — chi phí gần như bằng 0 nếu dọn dẹp đúng.

**Chuẩn bị:**
- AWS CLI v2 đã cài (`aws --version` phải in ra `aws-cli/2.x.x`). Nếu in `1.x` là bạn đang dùng CLI v1 — gỡ và cài lại v2.
- Node.js >= 18 và npm.
- Một IAM user/role có quyền admin (hoặc đủ quyền IAM, S3, STS, EC2 describe) để thực hiện lab — đã cấu hình sẵn làm profile `default` (chi tiết tạo user ở Chương 2).

### Bước 1: Kiểm tra CLI và cấu hình profile thứ hai

Tạo một IAM user mới tên `dva-lab-cli` để thực hành profile (trong thực tế bạn nên dùng role, nhưng access key minh hoạ provider chain rõ nhất):

```bash
aws iam create-user --user-name dva-lab-cli
aws iam attach-user-policy \
  --user-name dva-lab-cli \
  --policy-arn arn:aws:iam::aws:policy/AmazonS3FullAccess
aws iam create-access-key --user-name dva-lab-cli
```

Output của `create-access-key` chứa `AccessKeyId` và `SecretAccessKey` — **đây là lần duy nhất** AWS trả về secret, copy ngay. Cấu hình thành named profile:

```bash
aws configure --profile dva-lab
# AWS Access Key ID: <AccessKeyId vừa tạo>
# AWS Secret Access Key: <SecretAccessKey vừa tạo>
# Default region name: ap-southeast-1
# Default output format: json
```

Kiểm tra hai file cấu hình mà CLI vừa ghi:

```bash
cat ~/.aws/credentials   # chứa access key theo từng [profile]
cat ~/.aws/config        # chứa region/output, profile ghi là [profile dva-lab]
```

Lưu ý cú pháp khác nhau: trong `~/.aws/config`, section phải là `[profile dva-lab]`; trong `~/.aws/credentials` chỉ là `[dva-lab]`. Viết sai là CLI báo `ProfileNotFound`.

Xác nhận identity từng profile bằng STS:

```bash
aws sts get-caller-identity
aws sts get-caller-identity --profile dva-lab
```

Output mong đợi của lệnh thứ hai:

```json
{
    "UserId": "AIDAEXAMPLE123",
    "Account": "123456789012",
    "Arn": "arn:aws:iam::123456789012:user/dva-lab-cli"
}
```

### Bước 2: Kiểm chứng credentials provider chain

Provider chain ưu tiên biến môi trường TRƯỚC file credentials. Chứng minh:

```bash
export AWS_ACCESS_KEY_ID=AKIAFAKEFAKEFAKEFAKE
export AWS_SECRET_ACCESS_KEY=fakefakefakefakefakefakefakefakefakefake
aws sts get-caller-identity
```

Output mong đợi: lỗi `InvalidClientTokenId` — dù `~/.aws/credentials` có key hợp lệ, CLI vẫn dùng biến môi trường vì chúng đứng trước trong chain. Nhưng nếu chỉ định profile tường minh:

```bash
aws sts get-caller-identity --profile dva-lab
```

thì lại chạy được, vì `--profile` ép CLI đọc từ file. Dọn biến môi trường trước khi tiếp tục:

```bash
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
```

### Bước 3: Thực hành --query và --output

Tạo bucket làm dữ liệu thực hành (tên bucket phải unique toàn cầu — thay `<suffix>` bằng số ngẫu nhiên):

```bash
aws s3 mb s3://dva-lab-cli-<suffix> --profile dva-lab --region ap-southeast-1
for i in 1 2 3 4 5; do echo "file $i" > /tmp/f$i.txt; \
  aws s3 cp /tmp/f$i.txt s3://dva-lab-cli-<suffix>/ --profile dva-lab; done
```

`--query` dùng cú pháp JMESPath, chạy **client-side** (lọc sau khi API trả về, không giảm dữ liệu truyền từ server — khác `--filter` của một số lệnh là server-side):

```bash
# Chỉ lấy tên và size, output dạng bảng
aws s3api list-objects-v2 --bucket dva-lab-cli-<suffix> --profile dva-lab \
  --query 'Contents[].{Key:Key,Size:Size}' --output table

# Lấy object lớn hơn 5 byte, chỉ in Key, output text (dễ pipe vào xargs)
aws s3api list-objects-v2 --bucket dva-lab-cli-<suffix> --profile dva-lab \
  --query 'Contents[?Size > `5`].Key' --output text
```

Output mong đợi của lệnh thứ hai: danh sách key phân tách bằng tab trên một dòng, ví dụ `f1.txt  f2.txt ...`. Để thấy server-side pagination của CLI, ép page size nhỏ:

```bash
aws s3api list-objects-v2 --bucket dva-lab-cli-<suffix> --profile dva-lab \
  --page-size 2 --query 'length(Contents)'
```

Output vẫn là `5` — CLI tự động gọi API 3 lần (mỗi lần 2 object) và gộp kết quả; `--page-size` chỉ đổi kích thước mỗi request, còn `--max-items` mới giới hạn tổng số item trả về (kèm `NextToken` để lấy tiếp).

### Bước 4: --dry-run với EC2

`--dry-run` chỉ tồn tại ở một số API (chủ yếu EC2), dùng kiểm tra quyền mà không tạo tài nguyên:

```bash
aws ec2 run-instances --image-id ami-12345678 --instance-type t2.micro \
  --dry-run --profile dva-lab
```

Output mong đợi: lỗi `UnauthorizedOperation` — vì profile `dva-lab` chỉ có quyền S3. Nếu chạy bằng profile admin (bỏ `--profile`), bạn nhận `DryRunOperation: Request would have succeeded, but DryRun flag is set` — nghĩa là ĐỦ quyền. Cả hai đều là "lỗi" theo exit code, phải đọc message để phân biệt.

### Bước 5: MFA với CLI qua STS get-session-token

Giả sử user của bạn có MFA device (tạo ở Chương 2). Lấy temporary credentials 1 giờ:

```bash
aws sts get-session-token \
  --serial-number arn:aws:iam::123456789012:mfa/your-mfa-device \
  --token-code 123456 \
  --duration-seconds 3600
```

Output trả về bộ ba `AccessKeyId`, `SecretAccessKey`, `SessionToken` cùng `Expiration`. Điểm hay quên: temporary credentials phải dùng **đủ cả ba** — thiếu `aws_session_token` là API trả `InvalidClientTokenId`. Cấu hình thành profile tạm:

```bash
aws configure set aws_access_key_id <ASIA...> --profile mfa
aws configure set aws_secret_access_key <secret> --profile mfa
aws configure set aws_session_token <token> --profile mfa
aws sts get-caller-identity --profile mfa
```

(Nếu account không bật MFA, đọc hiểu bước này là đủ cho lab.)

### Bước 6: SDK JS v3 — pagination, waiter, retry

Tạo project:

```bash
mkdir /tmp/dva-ch03 && cd /tmp/dva-ch03 && npm init -y
npm install @aws-sdk/client-s3 @aws-sdk/credential-providers
```

Tạo file `lab.mjs`:

```javascript
import {
  S3Client, ListObjectsV2Command, CreateBucketCommand, PutObjectCommand,
  waitUntilBucketExists, paginateListObjectsV2,
} from "@aws-sdk/client-s3";
import { fromIni } from "@aws-sdk/credential-providers";

// Client dùng named profile + custom retry:
// adaptive mode tự thêm client-side rate limiting khi gặp throttle
const s3 = new S3Client({
  region: "ap-southeast-1",
  credentials: fromIni({ profile: "dva-lab" }),
  maxAttempts: 5,            // mặc định là 3 (1 lần gọi + 2 retry)
  retryMode: "adaptive",     // mặc định là "standard"
});

const bucket = "dva-lab-sdk-<suffix>"; // thay suffix của bạn

// 1. Tạo bucket rồi dùng WAITER chờ đến khi bucket sẵn sàng
await s3.send(new CreateBucketCommand({
  Bucket: bucket,
  CreateBucketConfiguration: { LocationConstraint: "ap-southeast-1" },
}));
await waitUntilBucketExists(
  { client: s3, maxWaitTime: 60 },  // poll HeadBucket tối đa 60s
  { Bucket: bucket }
);
console.log("Bucket sẵn sàng");

// 2. Upload 7 object để có dữ liệu phân trang
for (let i = 1; i <= 7; i++) {
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: `item-${i}.txt`, Body: `noi dung ${i}`,
  }));
}

// 3. PAGINATION kiểu thủ công với ContinuationToken
let token, total = 0;
do {
  const page = await s3.send(new ListObjectsV2Command({
    Bucket: bucket, MaxKeys: 3, ContinuationToken: token,
  }));
  total += page.KeyCount;
  token = page.NextContinuationToken; // undefined khi hết trang
} while (token);
console.log(`Thủ công: ${total} objects`);

// 4. PAGINATION kiểu paginator (async iterator) — cách nên dùng
const paginator = paginateListObjectsV2(
  { client: s3, pageSize: 3 },
  { Bucket: bucket }
);
const keys = [];
for await (const page of paginator) {
  keys.push(...(page.Contents ?? []).map((o) => o.Key));
}
console.log(`Paginator: ${keys.length} objects`, keys);
```

Chạy:

```bash
node lab.mjs
```

Output mong đợi:

```text
Bucket sẵn sàng
Thủ công: 7 objects
Paginator: 7 objects [ 'item-1.txt', ..., 'item-7.txt' ]
```

Mở rộng: bật debug để thấy SigV4 và retry hoạt động — thêm biến môi trường khi chạy CLI: `aws s3api list-buckets --profile dva-lab --debug 2>&1 | grep -i "signature\|retry" | head`. Bạn sẽ thấy header `Authorization: AWS4-HMAC-SHA256 Credential=.../ap-southeast-1/s3/aws4_request, SignedHeaders=..., Signature=...` — chính là SigV4 signing mà SDK/CLI làm tự động.

### Dọn dẹp tài nguyên

```bash
# Xoá objects rồi xoá 2 bucket (bucket phải rỗng mới xoá được)
aws s3 rb s3://dva-lab-cli-<suffix> --force --profile dva-lab
aws s3 rb s3://dva-lab-sdk-<suffix> --force --profile dva-lab

# Xoá access key, detach policy, xoá user (phải đúng thứ tự này)
KEY_ID=$(aws iam list-access-keys --user-name dva-lab-cli \
  --query 'AccessKeyMetadata[0].AccessKeyId' --output text)
aws iam delete-access-key --user-name dva-lab-cli --access-key-id $KEY_ID
aws iam detach-user-policy --user-name dva-lab-cli \
  --policy-arn arn:aws:iam::aws:policy/AmazonS3FullAccess
aws iam delete-user --user-name dva-lab-cli

# Xoá profile khỏi máy local
aws configure set aws_access_key_id "" --profile dva-lab  # hoặc sửa tay ~/.aws/credentials
rm -rf /tmp/dva-ch03 /tmp/f*.txt
```

Kiểm tra lại: `aws iam get-user --user-name dva-lab-cli` phải trả về `NoSuchEntity`.

## 💡 Exam Tips chương 3

- **Credentials provider chain (CLI):** command-line options → biến môi trường (`AWS_ACCESS_KEY_ID`...) → `~/.aws/credentials` → `~/.aws/config` → container credentials (ECS) → instance profile (EC2 metadata). Đề rất hay hỏi "code trên EC2 dùng credentials nào" — đáp án gần như luôn là **IAM role qua instance profile**, và nếu biến môi trường tồn tại thì nó **thắng** role.
- **KHÔNG BAO GIỜ** chọn đáp án nhúng access key vào code, AMI, hay biến môi trường khi có lựa chọn IAM role — đây là pattern loại trừ kinh điển.
- Temporary credentials từ STS gồm **3 thành phần**: access key id (bắt đầu `ASIA`), secret key, **session token**. Lỗi thiếu session token → `InvalidClientTokenId`.
- `aws sts get-session-token` dùng cho MFA với IAM user; `assume-role` dùng cho cross-account (chi tiết ở Chương 45). Credentials từ `get-session-token` **không thể** gọi IAM API trừ khi kèm MFA context.
- SigV4 ký request bằng secret key + ngày + region + service (derived key), không gửi secret lên mạng. Có thể đưa chữ ký qua **header Authorization** hoặc **query string** (presigned URL — Chương 14). Lỗi lệch giờ máy > 5 phút → `SignatureDoesNotMatch`/`RequestTimeTooSkewed`.
- Exponential backoff **kèm jitter** là cách xử lý chuẩn cho throttling (HTTP 429/503, `ThrottlingException`, `ProvisionedThroughputExceededException`). SDK tự retry (mặc định 3 attempts, mode `standard`); chỉ tự viết backoff khi gọi API trực tiếp không qua SDK. Retry mà **không** backoff/jitter là đáp án sai.
- `--query` là **client-side** filtering (JMESPath, chạy sau khi nhận response); `--filter`/filter parameter của API là **server-side**. Muốn giảm dữ liệu truyền về → server-side.
- `--page-size` chỉ đổi số item mỗi API call (chống timeout, CLI vẫn lấy hết); `--max-items` giới hạn tổng item trả về và phát `NextToken`.
- `--dry-run` (EC2) kiểm tra **quyền** mà không thực thi: đủ quyền → `DryRunOperation`, thiếu quyền → `UnauthorizedOperation`.
- Waiter = polling có sẵn trong SDK/CLI chờ resource đạt trạng thái (`aws ec2 wait instance-running`, `waitUntilBucketExists`). Câu hỏi "chờ resource sẵn sàng với ít code nhất" → waiter, không phải vòng lặp sleep tự viết.
- CloudShell: shell trên browser, có sẵn CLI v2, credentials lấy theo user đang đăng nhập console, 1GB persistent storage **per region**, miễn phí — đáp án cho "chạy CLI không cần cài đặt/không cần access key".
- Decode message lỗi authorization bị mã hoá (ví dụ từ EC2): `aws sts decode-authorization-message` — cần quyền `sts:DecodeAuthorizationMessage`.

## Quiz chương 3 (10 câu)

**Câu 1.** Một ứng dụng Node.js chạy trên EC2 instance đã gắn IAM role với đủ quyền DynamoDB, nhưng SDK liên tục báo `AccessDenied` khi gọi DynamoDB. Developer kiểm tra thấy trên instance có set `AWS_ACCESS_KEY_ID` và `AWS_SECRET_ACCESS_KEY` trong biến môi trường từ một dự án cũ. Nguyên nhân khả dĩ nhất là gì?
- A. IAM role không tương thích với SDK v3, phải dùng access key.
- B. Biến môi trường đứng trước instance profile trong credentials provider chain nên SDK dùng cặp key cũ thay vì role.
- C. EC2 instance phải reboot để IAM role có hiệu lực.
- D. SDK v3 yêu cầu khai báo credentials tường minh trong code.

**Câu 2.** Developer gọi API DynamoDB và thỉnh thoảng nhận `ProvisionedThroughputExceededException`. Cách xử lý ĐÚNG theo best practice của AWS là gì?
- A. Retry ngay lập tức liên tục cho đến khi thành công.
- B. Retry với khoảng chờ cố định 1 giây giữa các lần.
- C. Retry với exponential backoff và jitter, tận dụng cơ chế retry sẵn có của SDK.
- D. Bắt exception và trả lỗi 500 cho người dùng ngay lần đầu.

**Câu 3.** Một developer cần kiểm tra IAM permissions có cho phép tạo EC2 instance hay không mà KHÔNG thực sự tạo instance (không tốn chi phí). Cách nào đúng?
- A. Gọi `run-instances` với `--dry-run`; nếu nhận `DryRunOperation` nghĩa là đủ quyền.
- B. Gọi `run-instances` rồi `terminate-instances` ngay lập tức.
- C. Dùng `--query` để lọc response trước khi instance được tạo.
- D. Gọi `aws ec2 validate-permissions`.

**Câu 4.** Lệnh `aws dynamodb scan --table-name Orders` bị timeout vì bảng quá lớn, nhưng developer vẫn cần duyệt TOÀN BỘ dữ liệu. Tham số CLI nào phù hợp nhất?
- A. `--max-items 100` để chỉ lấy 100 item đầu.
- B. `--page-size 100` để CLI gọi nhiều request nhỏ nhưng vẫn trả đủ kết quả.
- C. `--query 'Items[0:100]'` để cắt bớt kết quả.
- D. `--output text` để giảm kích thước response.

**Câu 5.** Một IAM user bật MFA cần gọi AWS CLI với các API yêu cầu MFA. Bộ credentials user này phải dùng sau khi gọi `aws sts get-session-token --serial-number <mfa-arn> --token-code <code>` gồm những gì?
- A. Chỉ AccessKeyId và SecretAccessKey mới.
- B. AccessKeyId, SecretAccessKey và SessionToken.
- C. AccessKeyId cũ và SessionToken mới.
- D. Chỉ SessionToken.

**Câu 6.** Request gửi từ một server on-premises tới S3 bị lỗi `RequestTimeTooSkewed`. Nguyên nhân là gì?
- A. Secret key đã bị rotate.
- B. Đồng hồ hệ thống của server lệch quá 5 phút so với thời gian thực, làm SigV4 signature bị từ chối.
- C. Region trong signature không khớp với region của bucket.
- D. Session token đã hết hạn.

**Câu 7.** A developer needs to chạy vài lệnh AWS CLI khẩn cấp từ một máy mượn, không được phép cài phần mềm và không muốn tạo access key mới. Giải pháp ít công sức nhất?
- A. Cài AWS CLI v2 bản portable vào thư mục home.
- B. Dùng AWS CloudShell từ AWS Management Console.
- C. SSH vào một EC2 instance có sẵn CLI.
- D. Viết Lambda function thực thi các lệnh tương đương.

**Câu 8.** Script Node.js (SDK v3) liệt kê object trong bucket có hơn 10.000 object nhưng chỉ nhận về 1.000 kết quả. Cách sửa ĐÚNG và gọn nhất?
- A. Tăng `MaxKeys` lên 10000 trong một lần gọi `ListObjectsV2Command`.
- B. Dùng `paginateListObjectsV2` với `for await...of` để duyệt qua tất cả các trang.
- C. Gọi `ListObjectsV2Command` trong vòng lặp với cùng tham số cho đến khi đủ.
- D. Chuyển sang `ListBucketsCommand`.

**Câu 9.** Trong file `~/.aws/config` có `[profile prod]` với `region = eu-west-1`. Developer chạy `AWS_REGION=us-east-1 aws s3api list-buckets --profile prod`. CLI dùng region nào và vì sao?
- A. `eu-west-1`, vì profile được chỉ định tường minh nên luôn thắng.
- B. `us-east-1`, vì biến môi trường `AWS_REGION` có độ ưu tiên cao hơn cấu hình trong file config.
- C. CLI báo lỗi conflict region.
- D. `us-east-1` chỉ khi profile không có region.

**Câu 10.** Một script CI cần lấy danh sách InstanceId của tất cả EC2 instance đang chạy, mỗi ID một giá trị phân tách bằng tab để pipe vào lệnh khác. Tổ hợp tham số nào đúng?
- A. `--query 'Reservations[].Instances[].InstanceId' --output text`
- B. `--filter 'InstanceId' --output json`
- C. `--query 'Reservations[].Instances[].InstanceId' --output table`
- D. `--output text` không cần `--query` vì CLI tự rút gọn.

### Đáp án & giải thích

**Câu 1 — Đáp án B.** Provider chain của SDK kiểm tra biến môi trường TRƯỚC instance profile; cặp key cũ trong env (có thể đã bị thu hồi hoặc thiếu quyền) được dùng thay vì role → `AccessDenied`. Xoá biến môi trường là SDK fallback về role. A sai: SDK v3 hỗ trợ role đầy đủ. C sai: role gắn vào instance có hiệu lực gần như ngay, không cần reboot. D sai: SDK v3 tự resolve credentials qua chain, không bắt buộc khai báo tường minh.

**Câu 2 — Đáp án C.** Exponential backoff + jitter giãn dần khoảng retry và tránh các client retry đồng loạt (thundering herd); SDK đã tích hợp sẵn (mode `standard`/`adaptive`). A sai: retry dồn dập làm throttling tệ hơn. B sai: khoảng chờ cố định không giảm áp lực khi hệ thống quá tải và thiếu jitter. D sai: throttling là lỗi tạm thời (retryable), trả 500 ngay là bỏ qua cơ hội thành công.

**Câu 3 — Đáp án A.** `--dry-run` yêu cầu EC2 kiểm tra quyền rồi dừng: đủ quyền → `DryRunOperation`, thiếu → `UnauthorizedOperation`; không tài nguyên nào được tạo. B sai: vẫn tạo instance thật, tốn chi phí và rủi ro. C sai: `--query` chỉ lọc response client-side, không ngăn API thực thi. D sai: lệnh `validate-permissions` không tồn tại (kiểm tra policy tổng quát thì dùng IAM Policy Simulator).

**Câu 4 — Đáp án B.** `--page-size` làm CLI chia nhỏ mỗi API call (ví dụ 100 item/call) tránh timeout, nhưng vẫn tự động phân trang để trả đủ toàn bộ kết quả. A sai: `--max-items` cắt bớt tổng kết quả — không thoả yêu cầu duyệt toàn bộ. C sai: `--query` chạy sau khi response về, không giải quyết timeout khi gọi. D sai: đổi định dạng output không thay đổi lượng dữ liệu API trả về mỗi call.

**Câu 5 — Đáp án B.** Temporary credentials từ STS luôn gồm đủ ba thành phần: AccessKeyId (dạng `ASIA...`), SecretAccessKey và SessionToken; thiếu token → `InvalidClientTokenId`. A sai vì thiếu session token. C sai: không được trộn key cũ với token mới — chúng không khớp signature. D sai: session token một mình không đủ để ký SigV4.

**Câu 6 — Đáp án B.** SigV4 nhúng timestamp vào chữ ký; AWS từ chối request có thời gian lệch quá 5 phút để chống replay attack → sửa bằng đồng bộ NTP. A sai: secret key sai cho lỗi `SignatureDoesNotMatch`/`InvalidClientTokenId`, không phải TimeTooSkewed. C sai: sai region trong signature cho `SignatureDoesNotMatch` kèm thông báo credential scope. D sai: token hết hạn trả `ExpiredToken`.

**Câu 7 — Đáp án B.** CloudShell chạy ngay trên browser sau khi đăng nhập console, có sẵn CLI v2, kế thừa credentials của user đang đăng nhập — không cài đặt, không tạo key. A sai: vẫn là cài phần mềm, vi phạm ràng buộc. C sai: cần key pair/cấu hình SSH và một instance phù hợp — nhiều công sức hơn. D sai: viết và deploy Lambda cho vài lệnh ad-hoc là quá phức tạp.

**Câu 8 — Đáp án B.** `ListObjectsV2` trả tối đa 1.000 object mỗi call; paginator của SDK v3 (`paginateListObjectsV2` + `for await`) tự xử lý `ContinuationToken` qua tất cả các trang. A sai: `MaxKeys` không thể vượt trần 1.000 của API. C sai: lặp với cùng tham số mà không truyền `ContinuationToken` sẽ nhận đi nhận lại trang đầu. D sai: `ListBuckets` liệt kê bucket, không liên quan object.

**Câu 9 — Đáp án B.** Thứ tự resolve region: tham số `--region` → biến môi trường (`AWS_REGION`) → region trong profile → cấu hình mặc định. `AWS_REGION=us-east-1` thắng `eu-west-1` trong file config dù profile được chỉ định. A sai: `--profile` chọn bộ cấu hình nhưng không nâng độ ưu tiên của region trong file lên trên env var. C sai: không có lỗi conflict, CLI chỉ resolve theo thứ tự ưu tiên. D sai: env var thắng kể cả khi profile CÓ region.

**Câu 10 — Đáp án A.** JMESPath `Reservations[].Instances[].InstanceId` flatten đúng cấu trúc lồng của `describe-instances`, và `--output text` in giá trị phân tách bằng tab — chuẩn để pipe vào `xargs`/script. B sai: `--filter` không có cú pháp như vậy (EC2 dùng `--filters Name=...,Values=...` và đó là lọc server-side, không định dạng output). C sai: `table` vẽ khung ASCII cho người đọc, không pipe được. D sai: thiếu `--query` thì output text vẫn chứa toàn bộ field, không chỉ InstanceId.

## Tóm tắt chương

- AWS CLI v2 cấu hình qua `aws configure`, lưu ở `~/.aws/credentials` (key) và `~/.aws/config` (region, output, section ghi `[profile <tên>]`); named profiles cho phép nhiều bộ credentials, chọn bằng `--profile` hoặc `AWS_PROFILE`.
- Credentials provider chain (thứ tự thi hay hỏi): CLI options → env vars → credentials/config file → container credentials → EC2 instance profile. Best practice: trên EC2/ECS/Lambda luôn dùng IAM role, không hardcode key.
- Temporary credentials (STS) gồm 3 phần: access key (`ASIA...`), secret, session token — thiếu token là lỗi. `get-session-token` phục vụ MFA cơ bản; assume-role chi tiết ở Chương 45.
- SigV4 ký mọi API request bằng derived key (secret + date + region + service); secret không bao giờ rời máy client; lệch đồng hồ >5 phút → `RequestTimeTooSkewed`.
- SDK retry mặc định 3 attempts với exponential backoff + jitter; mode `adaptive` thêm client-side rate limiting; chỉ retry lỗi retryable (throttling 429, 5xx) — không retry 4xx logic như `ValidationException`.
- `--query` = JMESPath, lọc client-side; `--output` có `json`/`text`/`table`/`yaml`; `text` dành cho scripting/pipe.
- Pagination CLI: `--page-size` chia nhỏ từng API call nhưng vẫn trả đủ; `--max-items` giới hạn tổng và trả `NextToken`. Pagination SDK v3: paginator (`paginateXxx` + `for await`) thay vì tự quản `ContinuationToken`.
- Waiters (`aws ec2 wait ...`, `waitUntilBucketExists`) là cơ chế polling có sẵn để chờ resource đạt trạng thái mong muốn — chọn thay vì tự viết vòng lặp sleep.
- `--dry-run` (EC2) kiểm tra quyền không thực thi: `DryRunOperation` = đủ quyền, `UnauthorizedOperation` = thiếu quyền.
- CloudShell: terminal trên browser, CLI v2 cài sẵn, credentials theo console user, 1GB storage per region, miễn phí.
- SDK JS v3 dùng kiến trúc modular (`@aws-sdk/client-*`, gọi qua `client.send(new XxxCommand(...))`); Go SDK v2 tương tự với `config.LoadDefaultConfig` — cả hai resolve credentials theo cùng provider chain với CLI.
