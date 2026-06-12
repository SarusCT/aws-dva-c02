# Chương 3: AWS CLI & SDK

> **Trọng tâm DVA-C02:** Chương này là nền của domain Development (32%) và Troubleshooting (18%). Đề thi hỏi rất nhiều về credentials provider chain (thứ tự SDK/CLI tìm credentials ở đâu), SigV4 signing, exponential backoff khi gặp throttling, và cách dùng temporary credentials với MFA. Gần như mọi chương sau đều dùng lại kiến thức ở đây, nên hãy nắm chắc cơ chế thay vì học vẹt cú pháp.

## Mục tiêu chương

- Cài đặt, cấu hình AWS CLI v2 và hiểu chính xác hai file `~/.aws/config` và `~/.aws/credentials` chứa gì.
- Thuộc lòng **credentials provider chain** — thứ tự CLI/SDK tìm credentials — và giải thích được các tình huống "vì sao app dùng nhầm key".
- Dùng named profiles, profile assume-role, và MFA với CLI qua `sts get-session-token`.
- Viết code AWS SDK for JavaScript v3 (và Go SDK v2) đúng chuẩn: client, command, pagination, waiters.
- Giải thích cơ chế **SigV4 signing** và các lỗi liên quan (RequestTimeTooSkewed, SignatureDoesNotMatch).
- Cấu hình **retry & exponential backoff** (retry modes: legacy / standard / adaptive) để xử lý throttling đúng cách.

## 3.1 AWS CLI v2 — cài đặt và cấu hình

AWS CLI v2 là binary độc lập (bundle sẵn Python runtime bên trong), khác với CLI v1 vốn cài qua `pip` và phụ thuộc Python của máy. Với DVA-C02 và công việc thực tế, luôn dùng **v2** — nó có thêm SSO login, auto-prompt, output dạng `yaml`, và `aws configure import`.

```bash
# macOS
curl "https://awscli.amazonaws.com/AWSCLIV2.pkg" -o "AWSCLIV2.pkg"
sudo installer -pkg AWSCLIV2.pkg -target /

# Linux x86_64
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip && sudo ./aws/install

# Kiểm tra
aws --version
# aws-cli/2.x.x Python/3.x.x ...
```

Cấu hình lần đầu:

```bash
aws configure
# AWS Access Key ID [None]: AKIA................
# AWS Secret Access Key [None]: ****************************************
# Default region name [None]: ap-southeast-1
# Default output format [None]: json
```

Lệnh này ghi vào **hai file** — đề thi và thực tế đều hay nhầm vai trò của chúng:

| File | Nội dung | Ví dụ section |
|---|---|---|
| `~/.aws/credentials` | Chỉ chứa secrets: access key, secret key, session token | `[default]`, `[dev]` |
| `~/.aws/config` | Mọi thứ còn lại: region, output, role_arn, retry_mode, mfa_serial... | `[default]`, `[profile dev]` |

Lưu ý cú pháp dễ sai: trong `credentials` section tên profile viết trần `[dev]`, nhưng trong `config` phải có prefix `[profile dev]` (riêng `[default]` thì không cần prefix ở cả hai file).

```ini
# ~/.aws/credentials
[default]
aws_access_key_id = AKIAEXAMPLE
aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY

[dev]
aws_access_key_id = AKIADEVEXAMPLE
aws_secret_access_key = ...
```

```ini
# ~/.aws/config
[default]
region = ap-southeast-1
output = json

[profile dev]
region = us-east-1
output = table
retry_mode = standard
max_attempts = 5
```

Region được resolve theo thứ tự: tham số `--region` trên lệnh → biến môi trường `AWS_REGION` (rồi `AWS_DEFAULT_REGION`) → `region` trong profile đang dùng → với code chạy trên EC2 là region lấy từ instance metadata. Không resolve được region nào → CLI báo `You must specify a region`.

> 💡 **Exam Tip:** Câu hỏi "developer cần dùng AWS CLI trên máy local, bước đầu tiên là gì?" — đáp án là tạo access key cho IAM user rồi `aws configure`. Nhưng nếu code chạy **trên EC2/ECS/Lambda**, đáp án đúng luôn là **IAM role**, không bao giờ là copy access key lên server. Đề rất hay gài phương án "store access keys in environment variables on the EC2 instance" — sai.

## 3.2 Credentials provider chain — thứ tự tìm credentials

Đây là kiến thức bị hỏi nhiều nhất chương này. Khi bạn gọi một lệnh CLI hoặc khởi tạo SDK client **mà không truyền credentials tường minh**, nó tìm credentials theo một chuỗi cố định, dừng ở nguồn ĐẦU TIÊN tìm thấy:

1. **Command line / code**: `--profile` trên CLI, hoặc `credentials` truyền trực tiếp vào client trong code (hardcode — đừng làm).
2. **Biến môi trường**: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`.
3. **Web identity token / IAM Identity Center (SSO)**: `AWS_WEB_IDENTITY_TOKEN_FILE`, cấu hình `sso_*` trong config.
4. **Shared credentials file** `~/.aws/credentials`, rồi **config file** `~/.aws/config` (gồm cả profile assume-role).
5. **Container credentials** — biến `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` mà ECS/EKS inject để task lấy credentials của **task role**.
6. **Instance metadata service (IMDS)** trên EC2 — credentials của IAM role gắn vào instance, lấy qua `http://169.254.169.254/latest/meta-data/iam/security-credentials/<role-name>` (chi tiết IMDSv2 ở Chương 4).

Hệ quả thực tế cần nhớ:

- Biến môi trường **đè** profile file. War story kinh điển: CI/CD export `AWS_ACCESS_KEY_ID` của account staging, dev chạy script tưởng đang dùng `[default]` profile của account dev → ghi nhầm resource. Debug bằng `aws sts get-caller-identity` — lệnh này trả về Account/Arn/UserId của identity đang thực sự được dùng, không cần permission gì đặc biệt.
- Trên EC2 có gắn role nhưng trong `~/.aws/credentials` còn sót access key cũ → key trong file **thắng** role (file đứng trước IMDS trong chain). Lỗi "đã gắn role rồi mà vẫn AccessDenied" thường do nguyên nhân này.
- ECS task: SDK trong container tự động lấy credentials task role qua container credentials endpoint — bạn không cấu hình gì cả, miễn là không hardcode hoặc set env credentials đè lên.

```bash
# Lệnh debug số 1 khi gặp vấn đề credentials
aws sts get-caller-identity
# {
#   "UserId": "AIDAEXAMPLE",
#   "Account": "123456789012",
#   "Arn": "arn:aws:iam::123456789012:user/truong"
# }

# Xem CLI đang resolve credentials từ nguồn nào
aws configure list
#       Name                    Value             Type    Location
#    profile                <not set>             None    None
# access_key     ****************MPLE shared-credentials-file
# secret_key     ****************MPLE shared-credentials-file
#     region           ap-southeast-1      config-file    ~/.aws/config
```

> 💡 **Exam Tip:** Thứ tự rút gọn cần thuộc: **code/CLI options → environment variables → credentials/config file → container credentials (ECS) → instance profile (EC2)**. Best practice trong MỌI câu hỏi: workload chạy trên AWS dùng IAM role; máy dev dùng named profile; **không bao giờ** hardcode key trong source code hay AMI.

### Named profiles và profile assume-role

Khi làm nhiều account/môi trường, dùng named profiles:

```bash
aws s3 ls --profile dev          # dùng 1 lần
export AWS_PROFILE=dev           # dùng cho cả shell session
```

Profile còn có thể tự động **assume role** — CLI/SDK gọi STS AssumeRole giúp bạn, cache temporary credentials trong `~/.aws/cli/cache`:

```ini
# ~/.aws/config
[profile prod-deploy]
role_arn = arn:aws:iam::999988887777:role/DeployRole
source_profile = default        # dùng credentials của profile default để gọi AssumeRole
mfa_serial = arn:aws:iam::123456789012:mfa/truong
region = ap-southeast-1
```

Chạy `aws s3 ls --profile prod-deploy` → CLI tự hỏi MFA code, gọi AssumeRole, dùng temp credentials nhận được. Cơ chế AssumeRole, trust policy, ExternalId chi tiết ở Chương 45.

## 3.3 CLI nâng cao: --query, --output, --dry-run, pagination, CloudShell

### --output: định dạng kết quả

CLI v2 hỗ trợ `json` (mặc định), `yaml`, `yaml-stream`, `text` (tab-separated, hợp cho pipe vào script), `table` (cho người đọc). Set per-command bằng `--output`, mặc định trong config file hoặc `AWS_DEFAULT_OUTPUT`.

### --query: lọc client-side bằng JMESPath

`--query` chạy **phía client**, lọc/biến đổi JSON kết quả SAU KHI AWS đã trả về đầy đủ. Phân biệt với `--filters` (ví dụ của `ec2 describe-instances`) chạy **phía server**, giảm dữ liệu ngay từ API.

```bash
# Lấy InstanceId và State của tất cả instance, output dạng table
aws ec2 describe-instances \
  --query "Reservations[].Instances[].{ID:InstanceId,State:State.Name,Type:InstanceType}" \
  --output table

# Lấy đúng 1 giá trị dạng text để gán vào biến shell
BUCKET_REGION=$(aws s3api get-bucket-location \
  --bucket my-bucket \
  --query "LocationConstraint" --output text)

# Lọc theo điều kiện: chỉ instance đang chạy
aws ec2 describe-instances \
  --query "Reservations[].Instances[?State.Name=='running'].InstanceId" \
  --output text
```

> 💡 **Exam Tip:** Câu hỏi phân biệt: `--query` = client-side filtering (JMESPath, áp dụng cho mọi lệnh), `--filters` = server-side filtering (chỉ một số API hỗ trợ, tiết kiệm băng thông). Cả hai có thể dùng đồng thời.

### --dry-run: kiểm tra permission mà không thực thi

Nhiều API EC2 (và một số dịch vụ khác) hỗ trợ `--dry-run`: AWS kiểm tra **đầy đủ permission và tham số** nhưng không thực hiện hành động.

```bash
aws ec2 run-instances --image-id ami-0abcdef1234567890 \
  --instance-type t3.micro --dry-run
# Nếu CÓ quyền:  An error occurred (DryRunOperation) ... Request would have succeeded
# Nếu KHÔNG có quyền: An error occurred (UnauthorizedOperation) ...
```

Lưu ý ngược đời: dry-run **thành công** vẫn trả về "error" tên `DryRunOperation` — đó là kết quả mong đợi. Khi nhận `UnauthorizedOperation`, message chứa encoded authorization message, giải mã bằng:

```bash
aws sts decode-authorization-message --encoded-message <chuỗi-mã-hoá>
# Cần permission sts:DecodeAuthorizationMessage
```

### Pagination phía CLI

Mọi API list/describe của AWS đều phân trang phía server (ví dụ S3 `ListObjectsV2` tối đa **1000 keys/lần**, DynamoDB Scan tối đa **1MB/lần**). CLI mặc định **tự động phân trang**: tự gọi API nhiều lần rồi gộp kết quả. Ba tham số điều khiển:

- `--page-size`: số item mỗi lần gọi API (CLI vẫn lấy hết toàn bộ kết quả, chỉ là gọi nhiều lần với trang nhỏ hơn). Dùng khi bị **timeout/throttle** vì một trang quá lớn.
- `--max-items`: tổng số item CLI trả ra cho bạn. Nếu còn dữ liệu, CLI in `NextToken`.
- `--starting-token`: truyền `NextToken` của lần trước để lấy trang kế tiếp.

```bash
aws s3api list-objects-v2 --bucket my-bucket --max-items 100 --page-size 50
# Gọi server 2 lần (50 items/lần), trả về 100 items + NextToken nếu còn
```

> 💡 **Exam Tip:** Tình huống "CLI command times out khi list hàng trăm nghìn resources" → đáp án là dùng **`--page-size`** nhỏ hơn (giảm tải mỗi request, vẫn lấy đủ kết quả), không phải `--max-items` (cái này cắt bớt kết quả).

### AWS CloudShell

CloudShell là shell chạy trong browser từ AWS Console: có sẵn AWS CLI v2, Node.js, Python, git; **pre-authenticated** bằng chính credentials của user đang đăng nhập console (không cần access key); `$HOME` có **1 GB persistent storage per region** — file giữ lại giữa các session nhưng **không share giữa các region**. Phù hợp chạy lệnh nhanh, không thay thế môi trường dev thật. Không phải region nào cũng có CloudShell.

## 3.4 AWS SDK for JavaScript v3 (và Go SDK v2)

### Kiến trúc modular của SDK JS v3

Khác với v2 (một package `aws-sdk` khổng lồ), v3 tách **mỗi service một package** `@aws-sdk/client-*`, giúp bundle nhỏ (quan trọng với Lambda cold start — chi tiết Chương 29) và hỗ trợ tree-shaking. Pattern thống nhất: tạo **Client**, tạo **Command**, gọi `client.send(command)` — mọi lệnh trả về Promise.

```bash
npm install @aws-sdk/client-s3 @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb
```

```javascript
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

// Client nên tạo 1 lần, tái sử dụng (đặc biệt trong Lambda: tạo NGOÀI handler)
const s3 = new S3Client({
  region: "ap-southeast-1",
  // KHÔNG truyền credentials ở đây — để SDK tự resolve theo provider chain
  maxAttempts: 5,          // tổng số lần thử (1 lần đầu + 4 retry)
  retryMode: "adaptive",   // standard | adaptive
});

// Upload object
await s3.send(new PutObjectCommand({
  Bucket: "my-bucket",
  Key: "reports/2026-06.json",
  Body: JSON.stringify({ revenue: 1234 }),
  ContentType: "application/json",
}));

// Download và đọc body (v3 trả về stream, có helper transformToString)
const res = await s3.send(new GetObjectCommand({ Bucket: "my-bucket", Key: "reports/2026-06.json" }));
const text = await res.Body.transformToString(); // khác v2: không còn .promise() và Buffer sẵn
console.log(JSON.parse(text));
```

Điểm khác biệt v2 → v3 hay gặp khi đọc code cũ: v2 dùng `new AWS.S3()` + `.promise()`, v3 dùng command pattern + `send()`; v2 callback/Promise lẫn lộn, v3 thuần Promise; v3 có middleware stack cho phép can thiệp request lifecycle (thêm header, log, custom signing).

Xử lý lỗi trong v3 — error có `name` và metadata:

```javascript
try {
  await s3.send(new GetObjectCommand({ Bucket: "my-bucket", Key: "khong-ton-tai" }));
} catch (err) {
  if (err.name === "NoSuchKey") {
    console.log("Object không tồn tại");
  } else if (err.$metadata?.httpStatusCode === 403) {
    console.log("AccessDenied — kiểm tra IAM policy / bucket policy");
  } else {
    throw err; // lỗi khác: ném tiếp cho retry/alert tầng trên
  }
  console.log("RequestId để mở ticket AWS:", err.$metadata?.requestId);
}
```

### Go SDK v2 — nét chính

Go SDK v2 (`github.com/aws/aws-sdk-go-v2`) cùng triết lý: `config.LoadDefaultConfig` resolve credentials/region theo đúng provider chain, client per-service, context bắt buộc trên mọi call:

```go
package main

import (
	"context"
	"log"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

func main() {
	ctx := context.Background()
	// Tự resolve credentials theo provider chain, retry mode chỉnh được tại đây
	cfg, err := config.LoadDefaultConfig(ctx,
		config.WithRegion("ap-southeast-1"),
		config.WithRetryMaxAttempts(5),
	)
	if err != nil {
		log.Fatal(err)
	}

	client := s3.NewFromConfig(cfg)
	out, err := client.ListObjectsV2(ctx, &s3.ListObjectsV2Input{
		Bucket: aws.String("my-bucket"),
	})
	if err != nil {
		log.Fatal(err)
	}
	for _, obj := range out.Contents {
		log.Println(*obj.Key)
	}
}
```

> 💡 **Exam Tip:** "SDK không được cấu hình region thì chuyện gì xảy ra?" — SDK JS/Go **không có region mặc định**: nó tìm theo env var → config file → (trên EC2) instance metadata; không tìm thấy thì throw error khi gọi API. Riêng câu hỏi nhắc "us-east-1 is used by default" thường là bẫy — chỉ một số tool cũ làm vậy, SDK hiện đại thì không.

## 3.5 Pagination & Waiters trong SDK

### Pagination

Khác CLI, SDK **không tự gộp trang**: mỗi lần gọi API bạn nhận tối đa một trang + token (`NextToken`, `ContinuationToken`, `LastEvaluatedKey` tuỳ service). Tự viết vòng lặp được, nhưng SDK v3 cấp sẵn **paginator dạng async generator** — sạch và khó sai hơn:

```javascript
import { S3Client, paginateListObjectsV2 } from "@aws-sdk/client-s3";

const s3 = new S3Client({ region: "ap-southeast-1" });

let total = 0;
// paginator tự xử lý ContinuationToken, mỗi vòng lặp = 1 trang (tối đa 1000 keys)
for await (const page of paginateListObjectsV2(
  { client: s3, pageSize: 1000 },
  { Bucket: "my-bucket", Prefix: "logs/" }
)) {
  total += page.KeyCount ?? 0;
}
console.log("Tổng số objects:", total);
```

Go SDK v2 có pattern tương đương:

```go
p := s3.NewListObjectsV2Paginator(client, &s3.ListObjectsV2Input{
	Bucket: aws.String("my-bucket"),
})
for p.HasMorePages() {
	page, err := p.NextPage(ctx)
	if err != nil {
		log.Fatal(err)
	}
	log.Println("Trang có", len(page.Contents), "objects")
}
```

Bẫy thực tế: quên xử lý token là bug "chỉ thấy 1000 objects đầu" / "DynamoDB Scan thiếu dữ liệu" (Scan/Query dừng ở 1MB mỗi trang — chi tiết Chương 31). Nếu unit test với bucket nhỏ thì không bao giờ lộ bug này; production mới vỡ.

### Waiters

Nhiều thao tác AWS là **eventually consistent / bất đồng bộ**: tạo EC2 instance, bucket, table... API trả về ngay nhưng resource chưa sẵn sàng. Thay vì tự viết `while + sleep`, dùng **waiter** — SDK poll API với backoff sẵn cho đến khi đạt trạng thái hoặc hết `maxWaitTime`:

```javascript
import { DynamoDBClient, CreateTableCommand, waitUntilTableExists } from "@aws-sdk/client-dynamodb";

const ddb = new DynamoDBClient({ region: "ap-southeast-1" });

await ddb.send(new CreateTableCommand({
  TableName: "Orders",
  AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
  KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
  BillingMode: "PAY_PER_REQUEST",
}));

// Poll đến khi table ACTIVE, tối đa 120 giây — quá thì throw TimeoutError
await waitUntilTableExists(
  { client: ddb, maxWaitTime: 120 },
  { TableName: "Orders" }
);
console.log("Table sẵn sàng, ghi dữ liệu được rồi");
```

CLI cũng có waiter: `aws dynamodb wait table-exists --table-name Orders`, `aws ec2 wait instance-running --instance-ids i-xxx`. Trong shell script deploy, đây là cách đúng để chờ resource thay vì `sleep 30` cầu may.

## 3.6 SigV4 — cơ chế ký request

Mọi request đến AWS API (trừ vài endpoint public như S3 object công khai) phải được ký bằng **Signature Version 4 (SigV4)**. SDK/CLI làm việc này tự động — nhưng đề DVA-C02 hỏi cơ chế, và khi gọi AWS API "tay" (raw HTTP, hoặc IAM auth của API Gateway — Chương 35) bạn phải hiểu nó.

Bản chất: chứng minh bạn giữ secret key **mà không gửi secret key lên mạng**. Quy trình 4 bước:

1. **Canonical request**: chuẩn hoá HTTP method, URI, query string, headers (gồm `host`, `x-amz-date`), và SHA-256 hash của body — tất cả theo format cố định.
2. **String to sign**: ghép `AWS4-HMAC-SHA256` + timestamp + **credential scope** (`<date>/<region>/<service>/aws4_request`) + hash của canonical request.
3. **Signing key**: dẫn xuất qua chuỗi HMAC-SHA256: `kSecret → kDate → kRegion → kService → kSigning`. Vì key dẫn xuất theo ngày/region/service nên một signature lộ ra cũng không dùng được cho service/region/ngày khác.
4. **Signature** = HMAC(kSigning, stringToSign), gắn vào request theo một trong hai cách:
   - **Authorization header** (cách SDK dùng): `Authorization: AWS4-HMAC-SHA256 Credential=AKIA.../20260612/ap-southeast-1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=abc123...`
   - **Query string** (presigned URL): các tham số `X-Amz-Algorithm`, `X-Amz-Credential`, `X-Amz-Expires`, `X-Amz-Signature`... — nền tảng của S3 presigned URL (chi tiết Chương 14).

Server nhận request, lặp lại đúng phép tính với secret key nó giữ, so sánh signature. Các lỗi liên quan cần nhận diện:

- **`SignatureDoesNotMatch`**: secret key sai, hoặc request bị biến đổi giữa đường (proxy thêm header đã ký, body bị encode lại), hoặc tự ký sai canonical request.
- **`RequestTimeTooSkewed`** / "Signature expired": đồng hồ máy client lệch quá **15 phút** so với AWS. Request ký kèm timestamp, AWS từ chối request quá cũ để chống replay attack. Fix: sync NTP. Đây là câu hỏi troubleshooting kinh điển — EC2/container có đồng hồ trôi gọi API bị từ chối hàng loạt.
- Dùng temporary credentials mà **quên gửi session token** (`X-Amz-Security-Token` / `AWS_SESSION_TOKEN`) → `InvalidClientTokenId` hoặc AccessDenied. Temporary credentials luôn là BỘ BA: access key + secret key + session token.

> 💡 **Exam Tip:** Nhớ 2 con số/sự kiện: signature có thể truyền qua **header hoặc query string**; clock skew cho phép tối đa **15 phút**. Và "developer gọi API bị SignatureDoesNotMatch sau khi qua corporate proxy" → proxy đã sửa request sau khi ký.

(SigV4A — biến thể ký multi-region cho S3 Multi-Region Access Points — chỉ cần nhận diện tên, không thi sâu.)

## 3.7 Exponential backoff & retry — xử lý throttling đúng cách

AWS API có **rate limits**. Vượt limit, bạn nhận lỗi throttling: HTTP **429** / `ThrottlingException` / `Rate exceeded` / `ProvisionedThroughputExceededException` (DynamoDB). Ngoài ra lỗi server **5xx** cũng là transient. Cách xử lý chuẩn cho cả hai nhóm: **retry với exponential backoff + jitter**.

Cơ chế: lần retry thứ n chờ khoảng `min(base * 2^n, maxDelay)` cộng thêm **jitter** (độ trễ ngẫu nhiên). Vì sao phải có jitter: nếu 1000 client cùng bị throttle tại một thời điểm và cùng retry sau đúng 2s, 4s, 8s... chúng sẽ dồn cục thành từng đợt sóng đập vào API ("thundering herd") và tiếp tục bị throttle. Jitter rải đều các retry theo thời gian.

SDK/CLI **đã tích hợp sẵn** retry + backoff + jitter. Ba retry mode:

| Retry mode | Hành vi | Max attempts mặc định |
|---|---|---|
| `legacy` | Cơ chế cũ, tham số tuỳ SDK, ít tính năng | tuỳ SDK (JS v2: 3) |
| `standard` | Backoff + full jitter, **retry token bucket** (retry thất bại liên tục sẽ ăn cạn token → ngừng retry, tránh retry storm) | **3** (1 lần đầu + 2 retry) |
| `adaptive` | Như standard + **client-side rate limiting**: tự đo tỷ lệ throttle và chủ động giảm tốc độ GỬI request, không chỉ phản ứng sau lỗi | 3 |

Cấu hình ở 3 nơi (ưu tiên từ trên xuống): trong code (`maxAttempts`, `retryMode` của client) → env vars `AWS_RETRY_MODE`, `AWS_MAX_ATTEMPTS` → config file (`retry_mode`, `max_attempts`).

```javascript
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { ConfiguredRetryStrategy } from "@aws-sdk/util-retry";

const ddb = new DynamoDBClient({
  region: "ap-southeast-1",
  // Cách đơn giản: chỉnh mode + số attempts
  retryMode: "adaptive",
  maxAttempts: 6,
});

// Cách tuỳ biến sâu: tự định nghĩa hàm backoff (attempt → delay ms)
const customRetry = new ConfiguredRetryStrategy(
  6,                                       // tổng số attempts
  (attempt) => 100 + attempt * 2 ** attempt * 50  // backoff tăng theo cấp số nhân
);
```

Nguyên tắc retry an toàn mà đề hay xoáy:

- Chỉ retry lỗi **transient**: throttling (429), 5xx, timeout mạng. **Không retry 4xx** như `ValidationException`, `AccessDenied` — retry kiểu gì cũng fail, chỉ tốn quota.
- Thao tác retry phải **idempotent** (gọi lại nhiều lần kết quả như một lần). Non-idempotent (ví dụ trừ tiền) cần idempotency token/điều kiện — patterns ở Chương 30.
- Nếu vẫn throttle dù đã backoff: giảm tần suất gọi (batch API, cache), hoặc xin tăng service quota — backoff không phải thuốc chữa under-provisioning kinh niên (với DynamoDB là tăng WCU/RCU hoặc đổi sang on-demand — Chương 31).

> 💡 **Exam Tip:** Câu "application nhận ThrottlingException / ProvisionedThroughputExceededException, giải pháp ÍT thay đổi code nhất?" → **exponential backoff with jitter** (mà SDK đã có sẵn — đôi khi đáp án chỉ là tăng `maxAttempts` hoặc dùng retry mode `adaptive`). Đáp án "retry ngay lập tức trong vòng lặp while" luôn sai.

## 3.8 MFA với CLI — STS get-session-token

Khi IAM policy yêu cầu MFA (condition `aws:MultiFactorAuthPresent: true` — Chương 2), access key tĩnh của bạn không đủ: phải đổi lấy **temporary credentials gắn cờ MFA** qua `sts get-session-token`:

```bash
aws sts get-session-token \
  --serial-number arn:aws:iam::123456789012:mfa/truong \
  --token-code 123456 \
  --duration-seconds 43200
# {
#   "Credentials": {
#     "AccessKeyId": "ASIA................",        <- temp key luôn bắt đầu ASIA
#     "SecretAccessKey": "....",
#     "SessionToken": "FwoGZXIvYXdzE...",           <- BẮT BUỘC gửi kèm
#     "Expiration": "2026-06-12T18:00:00+00:00"
#   }
# }
```

Tham số cần nhớ: `--serial-number` là ARN của MFA device (virtual) hoặc serial của hardware device; `--token-code` là mã 6 số hiện tại; duration với IAM user từ **900 giây (15 phút) đến 129600 giây (36 giờ)**, mặc định **12 giờ**; với root user tối đa chỉ 1 giờ (và đừng dùng root). Đưa temp credentials vào profile để dùng:

```ini
# ~/.aws/credentials
[mfa]
aws_access_key_id = ASIA................
aws_secret_access_key = ....
aws_session_token = FwoGZXIvYXdzE...
```

```bash
aws s3 ls --profile mfa   # giờ các API yêu cầu MFA sẽ pass
```

Hết hạn thì lặp lại — thực tế nên dùng script hoặc cấu hình `mfa_serial` trong profile assume-role (mục 3.2) để CLI tự hỏi mã. Phân biệt nhanh hai API dễ lẫn:

| | `GetSessionToken` | `AssumeRole` |
|---|---|---|
| Mục đích | Lấy temp credentials cho **chính identity hiện tại**, thường để gắn MFA | Đổi sang **role khác** (cross-account, khác permission) |
| Permission nhận được | Như user hiện tại (trừ: không gọi được IAM/STS API nếu thiếu MFA) | Theo permission policy của role |
| MFA | `--serial-number` + `--token-code` | Hỗ trợ kèm MFA qua `mfa_serial` |
| Duration (IAM user) | 900s–129600s, mặc định 12h | 900s đến max session duration của role (mặc định 1h, tối đa 12h) |

Chi tiết AssumeRole, federation, ExternalId → Chương 45.

> 💡 **Exam Tip:** "Developer cần gọi AWS API được bảo vệ bằng MFA từ CLI" → đáp án: **`aws sts get-session-token` với `--serial-number` và `--token-code`**, rồi dùng bộ ba credentials trả về (nhớ session token). GetFederationToken hay AssumeRole trong ngữ cảnh này là đáp án nhiễu.

---

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
