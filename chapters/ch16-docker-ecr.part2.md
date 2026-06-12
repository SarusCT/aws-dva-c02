## Hands-on Lab: Build image, push lên Amazon ECR, lifecycle policy, image scanning và multi-arch

**Mục tiêu lab:** Tạo một private ECR repository bằng AWS CLI v2, build một Docker image nhỏ, đăng nhập registry bằng cơ chế token tạm thời, push/pull image, bật và đọc kết quả image scanning, gắn lifecycle policy để tự dọn image cũ, tạo một SDK JS v3 nhỏ để liệt kê image, và build multi-arch image bằng `docker buildx`. Sau cùng dọn sạch tài nguyên.

**Chuẩn bị:**
- AWS CLI v2 đã cấu hình profile có quyền `ecr:*` (lab dùng tài khoản học tập). Lấy account ID bằng `aws sts get-caller-identity`.
- Docker Desktop / Docker Engine đang chạy (`docker info` không lỗi). Có `docker buildx` (mặc định trong Docker hiện đại).
- Node.js >= 18, đã `npm install @aws-sdk/client-ecr`.
- Region dùng xuyên suốt: `ap-southeast-1`.

```bash
export AWS_REGION="ap-southeast-1"
export ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
export REPO="dva-lab-ch16"
export REGISTRY="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
echo "Registry: $REGISTRY"
```

### Bước 1: Tạo private repository

```bash
aws ecr create-repository \
  --repository-name "$REPO" \
  --region "$AWS_REGION" \
  --image-tag-mutability IMMUTABLE \
  --image-scanning-configuration scanOnPush=true
```

Output mong đợi (rút gọn):

```json
{
  "repository": {
    "repositoryArn": "arn:aws:ecr:ap-southeast-1:123456789012:repository/dva-lab-ch16",
    "registryId": "123456789012",
    "repositoryName": "dva-lab-ch16",
    "repositoryUri": "123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/dva-lab-ch16",
    "imageTagMutability": "IMMUTABLE",
    "imageScanningConfiguration": { "scanOnPush": true }
  }
}
```

Hai tham số đáng nhớ cho đề thi: `IMMUTABLE` chặn ghi đè một tag đã tồn tại (an toàn cho production, ngăn ai đó đẩy `latest` mới đè lên build đã deploy); `scanOnPush=true` bật basic scanning tự động mỗi lần push. Ghi nhớ ECR là registry **per-region, per-account** — `repositoryUri` chính là phần `REGISTRY/REPO`.

### Bước 2: Đăng nhập registry bằng token tạm thời

ECR không dùng username/password tĩnh. Bạn lấy một authorization token (hợp lệ **12 giờ**) rồi đưa cho Docker:

```bash
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY"
```

Output mong đợi:

```
Login Succeeded
```

Bẫy kinh điển: username LUÔN là chuỗi `AWS` (không phải IAM user của bạn); password chính là token do `get-login-password` sinh ra. Đừng dùng lệnh `aws ecr get-login` cũ — nó đã bị bỏ. Token gắn với danh tính IAM gọi lệnh, nên IAM principal phải có quyền `ecr:GetAuthorizationToken` (quyền này ở cấp registry, Resource phải là `*`).

### Bước 3: Viết Dockerfile và build image

```bash
mkdir -p /tmp/dva-ch16 && cd /tmp/dva-ch16
cat > app.js <<'EOF'
const http = require("http");
http.createServer((_, res) => res.end("hello ECR\n")).listen(8080);
EOF
cat > Dockerfile <<'EOF'
FROM node:20-alpine
WORKDIR /app
COPY app.js .
EXPOSE 8080
CMD ["node", "app.js"]
EOF
docker build -t "$REPO:1.0.0" .
```

`docker build` đọc Dockerfile, tải base image `node:20-alpine`, tạo các layer rồi gộp thành image với tag cục bộ `dva-lab-ch16:1.0.0`. Kiểm tra: `docker images | grep dva-lab-ch16`.

### Bước 4: Tag và push lên ECR

Image phải được tag bằng full URI có registry thì Docker mới biết đẩy đi đâu:

```bash
docker tag "$REPO:1.0.0" "$REGISTRY/$REPO:1.0.0"
docker push "$REGISTRY/$REPO:1.0.0"
```

Output mong đợi kết thúc bằng dòng digest:

```
1.0.0: digest: sha256:ab12... size: 1573
```

`digest` (sha256) là định danh bất biến của image; tag chỉ là con trỏ. Trong production nên deploy theo digest (`$REPO@sha256:...`) để chắc chắn không bị đổi nội dung dưới chân.

### Bước 5: Đọc kết quả image scanning

Vì đã bật `scanOnPush`, ECR tự quét ngay sau push. Lấy kết quả:

```bash
aws ecr describe-image-scan-findings \
  --repository-name "$REPO" \
  --image-id imageTag=1.0.0 \
  --region "$AWS_REGION" \
  --query 'imageScanFindings.findingSeverityCounts'
```

Output ví dụ:

```json
{ "MEDIUM": 2, "LOW": 5 }
```

Nếu chưa quét xong sẽ thấy `ScanStatus=IN_PROGRESS`. Basic scanning dùng CVE database CVEs (Clair); muốn quét liên tục theo CVE mới và quét cả OS + dependency của ngôn ngữ thì bật **Enhanced scanning** (dùng Amazon Inspector) ở cấp registry — đây là điểm so sánh hay gặp trong đề.

### Bước 6: Push thêm tag và gắn lifecycle policy

Push một image nữa để có dữ liệu cho policy dọn dẹp:

```bash
docker tag "$REPO:1.0.0" "$REGISTRY/$REPO:1.0.1"
docker push "$REGISTRY/$REPO:1.0.1"
```

Lifecycle policy chỉ giữ 1 image gần nhất, xoá các image cũ hơn (tiết kiệm chi phí lưu trữ ECR tính theo GB/tháng):

```bash
cat > lifecycle.json <<'EOF'
{
  "rules": [
    {
      "rulePriority": 1,
      "description": "Chi giu 1 image moi nhat",
      "selection": {
        "tagStatus": "any",
        "countType": "imageCountMoreThan",
        "countNumber": 1
      },
      "action": { "type": "expire" }
    }
  ]
}
EOF
aws ecr put-lifecycle-policy \
  --repository-name "$REPO" \
  --lifecycle-policy-text file://lifecycle.json \
  --region "$AWS_REGION"
```

Lifecycle policy chạy bất đồng bộ (không tức thì). Dùng preview để xem image NÀO sẽ bị xoá trước khi áp thật:

```bash
aws ecr start-lifecycle-policy-preview \
  --repository-name "$REPO" \
  --region "$AWS_REGION"
```

Bẫy: `countType` còn loại `sinceImagePushed` (xoá theo tuổi, dùng với `countUnit=days`). `tagStatus` có `tagged` (bắt buộc kèm `tagPrefixList`), `untagged`, hoặc `any`. Khi nhiều rule cùng khớp, ECR xét theo `rulePriority` tăng dần và một image bị expire ở rule đầu sẽ không bị rule sau xét lại.

### Bước 7: Liệt kê image bằng AWS SDK for JavaScript v3

```javascript
// list-images.js — liet ke image trong repo bang SDK v3
import { ECRClient, DescribeImagesCommand } from "@aws-sdk/client-ecr";

const client = new ECRClient({ region: process.env.AWS_REGION });

const res = await client.send(
  new DescribeImagesCommand({ repositoryName: "dva-lab-ch16" })
);

for (const img of res.imageDetails) {
  console.log(img.imageTags ?? "<untagged>", img.imageDigest, img.imageSizeInBytes);
}
```

Chạy: `node list-images.js`. Lưu ý `DescribeImagesCommand` trả metadata image (digest, tag, size, ngày push); muốn kéo bytes thật về thì Docker mới làm, SDK không pull image.

### Bước 8: Build multi-arch image với buildx

App container cần chạy cả trên Graviton (arm64, ví dụ Fargate Graviton) lẫn x86_64. Một manifest list duy nhất phục vụ cả hai:

```bash
docker buildx create --use --name dva-builder 2>/dev/null || true
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t "$REGISTRY/$REPO:multi" \
  --push .
```

`buildx` build cho từng platform rồi push một **image index / manifest list**. Khi node arm64 pull tag `multi`, ECR trả manifest arm64; node amd64 nhận manifest amd64 — cùng một tag, đúng kiến trúc. Lưu ý lệnh này push thẳng (`--push`) vì manifest list không nạp được vào docker engine cục bộ.

### Dọn dẹp tài nguyên

```bash
# Xoa repository va TAT CA image ben trong (--force)
aws ecr delete-repository \
  --repository-name "$REPO" \
  --region "$AWS_REGION" \
  --force

# Don builder va image cuc bo
docker buildx rm dva-builder 2>/dev/null || true
docker rmi "$REGISTRY/$REPO:1.0.0" "$REGISTRY/$REPO:1.0.1" "$REPO:1.0.0" 2>/dev/null || true
rm -rf /tmp/dva-ch16
```

Bẫy hay quên: không có `--force` mà repo còn image thì `delete-repository` trả `RepositoryNotEmptyException`. ECR tính tiền theo dung lượng image lưu trữ và data transfer — quên xoá repo là một khoản chi âm thầm.

## 💡 Exam Tips chương 16

- ECR authorization token sống **12 giờ**; lấy bằng `aws ecr get-login-password` (lệnh `get-login` cũ đã bị bỏ). Username Docker LUÔN là `AWS`, không phải IAM user.
- `ecr:GetAuthorizationToken` là quyền cấp **registry**, Resource phải là `*`; còn `ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer` (để pull) và `ecr:PutImage`, `ecr:UploadLayerPart` (để push) áp lên ARN repository cụ thể.
- ECS task kéo image từ ECR cần quyền ECR gắn vào **task execution role** (không phải task role) — đây là lỗi "CannotPullContainerError" kinh điển (chi tiết ở Chương 17).
- `IMMUTABLE` tag ngăn ghi đè tag đã tồn tại; deploy production nên tham chiếu image theo **digest** (`@sha256:...`) thay vì tag `latest`.
- Lifecycle policy: `imageCountMoreThan` giữ N image mới nhất, `sinceImagePushed` xoá theo tuổi (days); chạy bất đồng bộ; dùng `start-lifecycle-policy-preview` để thử khô trước.
- Basic scanning (Clair, CVE) bật bằng `scanOnPush` hoặc quét thủ công; **Enhanced scanning** dùng Amazon Inspector quét liên tục cả OS lẫn package ngôn ngữ — chọn enhanced khi đề nói "continuous/automated vulnerability scanning".
- Cross-account/cross-region pull: dùng **repository policy** (resource-based) để cấp quyền cho account khác; ECR **replication** tự sao chép image sang region/account khác để giảm latency pull.
- ECR Public (gallery.ecr.aws) khác private: ai cũng pull được, token public lấy từ region `us-east-1` qua `ecr-public get-login-password`.
- Mã hoá at-rest: mặc định AES-256 (SSE-S3 style); có thể chọn **KMS** (customer managed key) khi tạo repo cho yêu cầu compliance.
- Multi-arch: dùng `docker buildx --platform` tạo manifest list để một tag phục vụ cả amd64 và arm64 (Graviton).
- Các cách chạy container trên AWS và khi nào chọn gì: ECS/Fargate (serverless container, ít overhead), EKS (Kubernetes), App Runner (web app từ image/source, đơn giản nhất), Lambda container image (event-driven, image tối đa 10 GB) — nhận diện theo từ khoá đề (chi tiết ECS/Fargate ở Chương 17).
- VPC private subnet không NAT muốn pull ECR cần **VPC interface endpoints** cho `ecr.api` và `ecr.dkr`, cộng **gateway endpoint S3** (layer image nằm trên S3) — thiếu S3 endpoint là pull treo dù endpoint ECR đã có.

## Quiz chương 16 (10 câu)

**Câu 1.** A developer runs `docker push` to a private ECR repo and gets `denied: Your authorization token has expired`. What is the correct fix?
- A. Tạo lại repository với `--image-tag-mutability MUTABLE`
- B. Chạy lại `aws ecr get-login-password | docker login` để lấy token mới
- C. Gắn policy `AmazonEC2ContainerRegistryFullAccess` vào EC2
- D. Bật `scanOnPush` trên repository

**Câu 2.** Một ECS task trên Fargate báo `CannotPullContainerError` khi khởi động. Image nằm trong ECR private cùng account. Nguyên nhân khả năng cao nhất?
- A. Task role thiếu quyền `s3:GetObject`
- B. Task execution role thiếu quyền pull ECR
- C. Repository đang ở chế độ IMMUTABLE
- D. Image chưa được scan

**Câu 3.** A developer wants to keep only the 5 most recent images and automatically delete older ones to reduce storage cost. Cách tốn ít công vận hành nhất?
- A. Viết Lambda chạy theo cron gọi `batch-delete-image`
- B. Bật ECR Enhanced scanning
- C. Cấu hình ECR lifecycle policy với `imageCountMoreThan = 5`
- D. Bật S3 lifecycle rule trên bucket ECR

**Câu 4.** Account A muốn cho account B pull image từ một ECR repo. Cách đúng và hẹp quyền nhất?
- A. Gắn repository (resource-based) policy cho phép principal của account B các action `ecr:GetDownloadUrlForLayer`, `ecr:BatchGetImage`
- B. Tạo IAM user trong account A rồi chia sẻ access key cho B
- C. Đổi repo sang public
- D. Bật cross-region replication sang account B

**Câu 5.** Ứng dụng cần chạy container trên cả Fargate x86_64 và Fargate Graviton (arm64) từ cùng một tag. Cách phù hợp?
- A. Push hai repo riêng cho từng kiến trúc
- B. Dùng `docker buildx --platform linux/amd64,linux/arm64` để tạo manifest list rồi push một tag
- C. Bật ECR replication
- D. Dùng ECR Public

**Câu 6.** A security team requires continuous vulnerability scanning của image bao gồm cả OS packages và application language dependencies, tự quét lại khi có CVE mới. Chọn gì?
- A. Basic scanning với `scanOnPush=true`
- B. Enhanced scanning (Amazon Inspector) ở cấp registry
- C. Macie trên repository
- D. CloudTrail data events cho ECR

**Câu 7.** Token để `docker login` vào ECR private có thời hạn bao lâu?
- A. 1 giờ
- B. 12 giờ
- C. 15 phút
- D. 36 giờ

**Câu 8.** Lambda function đóng gói dưới dạng container image. Giới hạn kích thước image tối đa là?
- A. 250 MB
- B. 512 MB
- C. 10 GB
- D. Không giới hạn

**Câu 9.** ECS tasks chạy trong private subnet KHÔNG có NAT Gateway, kéo image từ ECR thì bị treo timeout. Cần thêm gì? (chọn nhiều nhất phù hợp)
- A. Interface endpoint cho `ecr.dkr` và `ecr.api`, cộng gateway endpoint cho S3
- B. Chỉ cần interface endpoint cho `ecr.api`
- C. Internet Gateway gắn vào private subnet
- D. NAT Instance ở private subnet

**Câu 10.** A developer needs deployments to be reproducible và không bao giờ pull nhầm một image khác dù tag bị đẩy lại. Cách tốt nhất?
- A. Luôn dùng tag `latest`
- B. Tham chiếu image theo digest `repo@sha256:...` và bật IMMUTABLE tags
- C. Bật versioning trên ECR
- D. Dùng ECR Public

### Đáp án & giải thích

**Câu 1 — Đáp án B.** Token ECR hết hạn sau 12 giờ; chỉ cần đăng nhập lại để lấy token mới. A (tag mutability) không liên quan tới auth. C cấp quyền nhưng EC2 không phải nguyên nhân lỗi token hết hạn, và over-privileged. D (scan) không ảnh hưởng push.

**Câu 2 — Đáp án B.** Trên Fargate, agent kéo image dùng **task execution role**; thiếu quyền ECR (`ecr:GetAuthorizationToken`, `BatchGetImage`, `GetDownloadUrlForLayer`) gây `CannotPullContainerError`. A nhầm role và action; layer trên S3 do AWS xử lý nội bộ, không cần `s3:GetObject` của bạn. C (IMMUTABLE) chỉ chặn ghi đè tag, không chặn pull. D (scan) không liên quan.

**Câu 3 — Đáp án C.** Lifecycle policy là cơ chế native của ECR, không cần code, ít vận hành nhất. A hoạt động nhưng phải tự viết và bảo trì Lambda — nhiều overhead. B là scanning, không xoá image. D sai vì bạn không truy cập trực tiếp bucket S3 backing của ECR.

**Câu 4 — Đáp án A.** Cross-account pull dùng **repository policy** (resource-based) cấp đúng action pull cho principal account B — hẹp quyền, đúng chuẩn. B chia sẻ access key là anti-pattern bảo mật. C (public) lộ image cho cả thế giới. D (replication) sao chép image chứ không phải cơ chế cấp quyền pull.

**Câu 5 — Đáp án B.** `docker buildx` với nhiều `--platform` tạo một manifest list; mỗi node nhận manifest đúng kiến trúc từ cùng một tag. A tốn công và dễ deploy nhầm. C/D không giải quyết vấn đề đa kiến trúc.

**Câu 6 — Đáp án B.** Enhanced scanning dùng Amazon Inspector quét liên tục cả OS lẫn dependency ngôn ngữ, tự quét lại theo CVE mới. A (basic) chỉ quét OS packages bằng Clair, không liên tục. C (Macie) dành cho dữ liệu nhạy cảm trong S3. D (CloudTrail) ghi audit API, không quét lỗ hổng.

**Câu 7 — Đáp án B.** Authorization token ECR private hợp lệ 12 giờ. Các con số khác là bẫy (1 giờ là STS default, 15 phút là tối thiểu STS, 36 giờ không tồn tại ở đây).

**Câu 8 — Đáp án C.** Container image cho Lambda tối đa 10 GB (so với 250 MB unzipped của zip package). A là limit zip. B/D sai.

**Câu 9 — Đáp án A.** Không có route ra internet, ECS cần interface endpoint cho cả `ecr.api` (call API) và `ecr.dkr` (Docker registry), VÀ gateway endpoint S3 vì layer image lưu trên S3 — thiếu S3 endpoint là pull treo. B thiếu `ecr.dkr` và S3. C sai vì IGW gắn cho public subnet, và đề muốn giữ private. D NAT Instance phải đặt ở public subnet mới có tác dụng.

**Câu 10 — Đáp án B.** Tham chiếu theo digest đảm bảo nội dung bất biến; IMMUTABLE chặn đẩy lại tag trùng. A (`latest`) là phản ví dụ kinh điển gây deploy không nhất quán. C: ECR không có "versioning" kiểu S3. D không liên quan tính tái lập.

## Tóm tắt chương

- Docker đóng gói app + dependency thành **image** (bất biến, gồm các layer); container là instance đang chạy của image; Dockerfile mô tả cách build; registry lưu và phân phối image.
- AWS có nhiều nơi chạy container: **ECS/Fargate** (serverless, ít overhead nhất), **EKS** (Kubernetes), **App Runner** (web app đơn giản từ image/source), **Lambda container image** (event-driven, tối đa 10 GB).
- **Amazon ECR** là registry private/public, per-region per-account; `repositoryUri` = `REGISTRY/REPO`; image định danh bất biến bằng **digest sha256**, tag chỉ là con trỏ.
- Đăng nhập ECR bằng **token tạm 12 giờ**: `aws ecr get-login-password | docker login --username AWS`; username luôn là `AWS`.
- Quyền IAM tách hai nhóm: `GetAuthorizationToken` ở cấp registry (Resource `*`), còn pull/push action áp lên ARN repository; ECS pull cần quyền gắn vào **task execution role**.
- **IMMUTABLE tags** chặn ghi đè; production nên deploy theo digest để tái lập chính xác.
- **Lifecycle policy** tự dọn image cũ (`imageCountMoreThan` hoặc `sinceImagePushed`), chạy bất đồng bộ, có chế độ preview — giảm chi phí lưu trữ mà không cần code.
- **Image scanning**: basic (Clair, CVE, theo `scanOnPush`) vs **enhanced** (Amazon Inspector, liên tục, OS + dependency) — chọn enhanced khi đề yêu cầu quét liên tục/tự động.
- **Cross-account** pull dùng repository policy (resource-based); **replication** sao chép image sang region/account khác để giảm latency.
- **Multi-arch** image dùng `docker buildx --platform` tạo manifest list, một tag phục vụ cả x86_64 và arm64/Graviton.
- Pull ECR từ private subnet không NAT cần **interface endpoint** `ecr.api` + `ecr.dkr` và **gateway endpoint S3** (layer nằm trên S3).
- Luôn `delete-repository --force` khi dọn lab; repo còn image mà thiếu `--force` sẽ báo `RepositoryNotEmptyException` và tiếp tục tính phí lưu trữ.
