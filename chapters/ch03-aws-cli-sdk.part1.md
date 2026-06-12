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
