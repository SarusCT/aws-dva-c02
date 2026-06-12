# Chương 16: Docker trên AWS & Amazon ECR

> **Trọng tâm DVA-C02:** Chương này là cửa ngõ vào mảng container của đề thi. Câu hỏi thường xoay quanh: chọn dịch vụ chạy container nào cho tình huống "least operational overhead" (Fargate, App Runner, Lambda container vs ECS/EKS trên EC2); cơ chế và quyền IAM khi `docker login` rồi push/pull image lên Amazon ECR; lifecycle policy để dọn image cũ tự động; image scanning (basic vs enhanced với Inspector); cách chia sẻ image cross-account/cross-region; và bẫy kinh điển về cấu trúc lệnh `aws ecr get-login-password`. ECS chi tiết (task definition, service, networking) học ở Chương 17.

## Mục tiêu chương

- Nắm vững các khái niệm Docker cốt lõi đủ cho đề thi: image, layer, container, Dockerfile, registry — và phân biệt image với container.
- So sánh đầy đủ các lựa chọn chạy container trên AWS: ECS, EKS, Fargate, App Runner, Lambda container image — biết khi nào chọn cái nào theo tiêu chí vận hành và chi phí.
- Hiểu kiến trúc Amazon ECR: private vs public registry, repository, image tag/digest, và cơ chế xác thực bằng token tạm 12 giờ.
- Thực hiện được luồng `docker login` → `build` → `tag` → `push` → `pull` với ECR bằng AWS CLI v2, và nắm chính xác các IAM action cần thiết.
- Cấu hình lifecycle policy, image scanning, image tag immutability, encryption và replication cross-region/cross-account cho ECR.
- Hiểu multi-arch image (ARM64/Graviton vs x86) và cách image manifest list hoạt động.

## 16.1 Docker recap cho exam — image, layer, container, registry

Đề DVA-C02 không kiểm tra bạn viết Dockerfile giỏi cỡ nào, nhưng giả định bạn hiểu vài khái niệm nền tảng để không bị loại trừ sai đáp án. Ta đi nhanh nhưng đủ sâu.

**Container** là một process (hoặc nhóm process) chạy bị cô lập bằng các tính năng của Linux kernel: `namespaces` (cô lập view về process ID, network, mount, hostname) và `cgroups` (giới hạn CPU/memory). Container **không phải** là máy ảo — nó dùng chung kernel với host, nên nhẹ và khởi động nhanh hơn VM rất nhiều (mili giây tới vài giây thay vì hàng chục giây). Đây là lý do container hợp với scaling nhanh và serverless.

**Image** là một template chỉ-đọc (read-only) dùng để tạo container. Image được cấu thành từ nhiều **layer** xếp chồng. Mỗi instruction trong Dockerfile (`RUN`, `COPY`, `ADD`) tạo ra một layer mới — về bản chất là một bộ thay đổi filesystem (diff) so với layer trước. Khi chạy container, Docker thêm một **writable layer** mỏng phía trên cùng (copy-on-write); mọi thay đổi runtime nằm ở layer này và biến mất khi container bị xoá (trừ khi bạn dùng volume).

Cơ chế layer là điểm cần hiểu vì nó ảnh hưởng tới hiệu năng push/pull lên ECR:

- Layer được định danh bằng **content-addressable digest** (SHA-256 của nội dung). Hai image dùng chung một base layer thì layer đó chỉ lưu **một bản** trong registry và chỉ truyền **một lần**. Đó là lý do push image lần thứ hai (chỉ đổi vài file ở tầng trên) rất nhanh — các base layer đã có sẵn trên ECR.
- Sắp xếp Dockerfile để layer ít thay đổi (cài OS package, dependency) nằm dưới, layer hay đổi (source code) nằm trên → tối ưu cache khi build và rebuild.

**Dockerfile** là tập lệnh build image. Vài instruction hay gặp:

```dockerfile
# Base image — kéo từ một registry (mặc định Docker Hub nếu không ghi registry)
FROM public.ecr.aws/docker/library/node:20-alpine

WORKDIR /app
# COPY package trước, cài dependency → layer này được cache khi code đổi mà package không đổi
COPY package*.json ./
RUN npm ci --omit=dev

# COPY source code (layer hay đổi nhất, đặt cuối)
COPY . .

EXPOSE 3000
# CMD: lệnh mặc định khi container chạy (có thể bị override khi `docker run`)
CMD ["node", "server.js"]
```

**Registry** là nơi lưu trữ và phân phối image. Docker Hub là registry mặc định, nhưng có rate limit pull khắt khe (Docker Hub giới hạn pull theo IP cho user ẩn danh) — một nguyên nhân thực tế khiến build/deploy trên AWS thỉnh thoảng fail với lỗi `toomanyrequests`. Giải pháp AWS đưa ra là **Amazon ECR** (registry riêng cho bạn) và **Amazon ECR Public** (mirror các image phổ biến, không bị rate limit như Docker Hub). Một **repository** là một namespace trong registry chứa nhiều version (tag) của cùng một image.

> 💡 **Exam Tip:** Image là read-only template; container là instance đang chạy của image. Mỗi instruction Dockerfile tạo một layer; layer được chia sẻ qua digest nên push lần sau chỉ truyền layer mới. Nếu thấy đáp án nói "phải push lại toàn bộ image mỗi lần đổi 1 dòng code" → sai.

## 16.2 Các lựa chọn chạy container trên AWS — bức tranh tổng thể

AWS có nhiều cách chạy container, và đề thi rất thích hỏi "chọn cái nào cho ít overhead vận hành nhất". Hiểu trục phân loại sẽ giải quyết phần lớn câu hỏi.

Có hai trục cần tách bạch:

1. **Orchestrator** (cái gì điều phối container): Amazon ECS (AWS tự phát triển, đơn giản) hoặc Amazon EKS (managed Kubernetes, chuẩn open-source, phức tạp hơn).
2. **Compute/launch type** (container chạy trên đâu): **EC2** (bạn tự quản lý cụm máy ảo) hoặc **Fargate** (serverless — AWS quản lý hạ tầng, bạn chỉ khai báo CPU/memory).

Fargate **không phải** là một orchestrator — nó là launch type dùng được cho cả ECS lẫn EKS. Đây là bẫy hay gặp: câu hỏi mô tả "không muốn quản lý EC2, không muốn vá hệ điều hành" → Fargate, chứ không phải "chuyển từ ECS sang EKS".

Ngoài ra có các dịch vụ bậc cao hơn ẩn hẳn container đi:

- **AWS App Runner**: bạn đưa source code (từ GitHub) hoặc một container image (từ ECR); App Runner tự build, deploy, load balance, auto scale, cấp HTTPS endpoint. Cực ít cấu hình — hợp với web app/API stateless. Bên dưới nó chạy trên Fargate nhưng bạn không thấy gì cả.
- **AWS Lambda container image**: đóng gói function dưới dạng container image (tối đa **10 GB**) thay vì zip (zip giới hạn 250 MB unzipped). Vẫn là Lambda — invoke theo event, có cold start, timeout tối đa 15 phút. Dùng khi dependency lớn hoặc team đã quen quy trình container (chi tiết Lambda ở Chương 28–29).

Bảng so sánh để chọn nhanh:

| Dịch vụ | Orchestrator | Bạn quản lý gì | Phù hợp khi | Overhead vận hành |
|---|---|---|---|---|
| ECS trên EC2 | ECS | Cụm EC2 (patch OS, scaling node) | Cần kiểm soát instance, GPU, dùng Spot tối ưu chi phí | Cao |
| ECS trên Fargate | ECS | Chỉ task definition (CPU/RAM) | Container thường, muốn serverless, không muốn quản EC2 | Thấp |
| EKS trên EC2 | EKS (K8s) | Cụm EC2 + cấu hình K8s | Đã chuẩn hoá Kubernetes, đa cloud | Rất cao |
| EKS trên Fargate | EKS (K8s) | Pod spec (K8s) | Cần K8s nhưng không muốn quản node | Trung bình–cao |
| App Runner | (ẩn) | Gần như không gì | Web app/API stateless, deploy nhanh từ code/image | Rất thấp |
| Lambda (container) | (ẩn) | Code + image | Event-driven, short-lived, dependency lớn | Rất thấp |

> 💡 **Exam Tip:** Từ khoá "least operational overhead" + "container" + "không quản lý server" → **Fargate** (nếu đã có ECS/EKS) hoặc **App Runner** (nếu chỉ là web app deploy từ image/code). "Managed Kubernetes / open-source standard / portability across clouds" → **EKS**. "AWS-native, đơn giản, không cần Kubernetes" → **ECS**.

Một điểm chi phí đề hay gài: Fargate trả tiền theo vCPU và GB-memory **mà bạn cấp cho task**, tính theo giây (tối thiểu 1 phút). Nếu workload chạy 24/7 ổn định với mật độ cao, ECS trên EC2 (đặc biệt kết hợp Spot/Savings Plans) thường rẻ hơn Fargate. Ngược lại, workload bursty/không thường xuyên → Fargate rẻ và đỡ nhức đầu hơn vì không trả tiền cho EC2 idle.

## 16.3 Amazon ECR — kiến trúc registry riêng

**Amazon Elastic Container Registry (ECR)** là registry Docker được AWS quản lý hoàn toàn, tích hợp sẵn với IAM, KMS, ECS, EKS, Lambda. ECR có hai dạng:

- **Private registry**: mỗi AWS account có sẵn một private registry tại endpoint `<account_id>.dkr.ecr.<region>.amazonaws.com`. Truy cập phải qua IAM. Đây là nơi bạn lưu image nội bộ của ứng dụng.
- **Public registry** (ECR Public, qua `public.ecr.aws`): repository công khai, ai cũng pull được (kể cả không có AWS account). Bạn dùng để publish image cho cộng đồng, hoặc pull các base image AWS mirror sẵn mà không dính rate limit Docker Hub.

Trong một registry, bạn tạo nhiều **repository** (ví dụ `my-app/api`, `my-app/worker`). Mỗi repository chứa nhiều image, mỗi image được tham chiếu bằng:

- **Tag** — nhãn dễ đọc, có thể di chuyển (mutable), ví dụ `:v1.2.3`, `:latest`. Một tag trỏ tới một digest cụ thể.
- **Digest** — `sha256:...`, immutable, là định danh nội dung thật của image. Cùng một digest = cùng nội dung byte-for-byte.

Lưu ý: `:latest` chỉ là một tag thông thường, **không** tự động trỏ tới image mới nhất theo thời gian — nó trỏ tới image nào được push gần nhất *với tag đó*. Đừng tin cậy `:latest` cho production; pin theo tag version hoặc digest để deploy lặp lại được (reproducible).

Tạo repository bằng CLI:

```bash
# Tạo private repository với scan-on-push và tag immutable
aws ecr create-repository \
  --repository-name my-app/api \
  --image-scanning-configuration scanOnPush=true \
  --image-tag-mutability IMMUTABLE \
  --encryption-configuration encryptionType=AES256 \
  --region ap-southeast-1
```

Vài giới hạn cần nhớ: mặc định mỗi account có quota khá rộng (hàng nghìn repository/registry, hàng chục nghìn image/repository) và **kích thước layer tối đa 52 GB** khi push. ECR lưu image trong S3 do AWS quản lý phía sau và mã hoá at-rest mặc định.

> 💡 **Exam Tip:** Endpoint ECR private có dạng `aws_account_id.dkr.ecr.region.amazonaws.com`. Nhớ chữ `dkr` và thứ tự `account.dkr.ecr.region`. Câu hỏi hay đảo vị trí region/account để gài. ECR Public dùng `public.ecr.aws`.

## 16.4 Xác thực và luồng push/pull với ECR

Docker CLI không hiểu IAM. Nó cần username/password để login vào registry. ECR cấp một **authorization token tạm thời, hiệu lực 12 giờ**, đổi từ credential IAM của bạn. Luồng chuẩn với CLI v2:

```bash
# Bước 1: lấy mật khẩu tạm và pipe thẳng vào docker login
# get-login-password trả về token; username LUÔN là chữ "AWS"
aws ecr get-login-password --region ap-southeast-1 \
  | docker login --username AWS \
    --password-stdin 111122223333.dkr.ecr.ap-southeast-1.amazonaws.com
```

Đây là điểm thi RẤT hay hỏi. Cú pháp đúng là `aws ecr get-login-password | docker login --username AWS --password-stdin <registry-uri>`. Lệnh cũ `aws ecr get-login` (CLI v1, trả về cả chuỗi `docker login -u AWS -p <token>`) đã **bị loại bỏ trong CLI v2** — nếu thấy đáp án dùng `get-login` (không có `-password`), đó là sai/lỗi thời.

Sau khi login, luồng build và push:

```bash
ACCOUNT=111122223333
REGION=ap-southeast-1
REPO=my-app/api
REGISTRY=$ACCOUNT.dkr.ecr.$REGION.amazonaws.com

# Bước 2: build image
docker build -t $REPO:v1 .

# Bước 3: tag image theo định dạng <registry>/<repo>:<tag>
docker tag $REPO:v1 $REGISTRY/$REPO:v1

# Bước 4: push
docker push $REGISTRY/$REPO:v1

# Pull về (ở máy/khác account đã login):
docker pull $REGISTRY/$REPO:v1
```

Về **IAM permissions**, đây là phần đề thi gài nhiều. Quyền chia làm hai nhóm:

- `ecr:GetAuthorizationToken` — bắt buộc cho **mọi** thao tác login. Action này áp ở resource `*` (không gắn được vào repository cụ thể), vì token là cấp registry.
- Các action thao tác trên repository: `ecr:BatchCheckLayerAvailability`, `ecr:GetDownloadUrlForLayer`, `ecr:BatchGetImage` (cần để **pull**); `ecr:PutImage`, `ecr:InitiateLayerUpload`, `ecr:UploadLayerPart`, `ecr:CompleteLayerUpload` (cần để **push**).

Một lỗi production điển hình: gắn policy chỉ cho `ecr:BatchGetImage` mà quên `ecr:GetAuthorizationToken` → `docker login` thất bại ngay bước đầu. Hoặc EC2/ECS task pull được image nhưng push fail vì thiếu nhóm `Upload/PutImage`.

Ví dụ policy cho một role chỉ-pull (read-only) gắn vào ECS task execution role hoặc EC2:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EcrAuth",
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*"
    },
    {
      "Sid": "EcrPull",
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage"
      ],
      "Resource": "arn:aws:ecr:ap-southeast-1:111122223333:repository/my-app/*"
    }
  ]
}
```

AWS có sẵn managed policy `AmazonEC2ContainerRegistryReadOnly` (pull), `AmazonEC2ContainerRegistryPowerUser` (pull + push), và `AmazonEC2ContainerRegistryFullAccess`. ECS dùng **execution role** (không phải task role) để pull image từ ECR khi khởi động container — phân biệt này học kỹ ở Chương 17.

> 💡 **Exam Tip:** Token login hết hạn sau **12 giờ**. `ecr:GetAuthorizationToken` luôn cần và áp resource `*`. Nếu một CodeBuild/EC2 báo lỗi không pull được image private từ ECR, checklist: (1) thiếu `GetAuthorizationToken`? (2) thiếu nhóm pull action? (3) repository policy có cho phép principal đó? (4) đúng region của registry chưa?

## 16.5 Lifecycle policy — dọn image cũ tự động

Mỗi lần CI build sẽ push một image mới. Sau vài tháng repository phình to hàng nghìn image, tốn tiền lưu trữ (ECR tính phí theo GB-tháng) và rối. **Lifecycle policy** cho phép ECR tự động expire (xoá) image theo quy tắc, không cần script ngoài.

Lifecycle policy là một JSON gồm danh sách `rules`, mỗi rule có `rulePriority` (số nhỏ chạy trước), `selection` (chọn image nào) và `action` (luôn là `expire`). Selection chọn theo:

- `tagStatus`: `tagged` (kèm `tagPrefixList`), `untagged`, hoặc `any`.
- `countType`: `imageCountMoreThan` (giữ lại N image mới nhất) hoặc `sinceImagePushed` (xoá image cũ hơn N ngày).

Ví dụ: xoá image untagged sau 14 ngày, và chỉ giữ 10 image mới nhất có prefix `v`:

```json
{
  "rules": [
    {
      "rulePriority": 1,
      "description": "Xoa image untagged cu hon 14 ngay",
      "selection": {
        "tagStatus": "untagged",
        "countType": "sinceImagePushed",
        "countUnit": "days",
        "countNumber": 14
      },
      "action": { "type": "expire" }
    },
    {
      "rulePriority": 2,
      "description": "Giu 10 release tag moi nhat",
      "selection": {
        "tagStatus": "tagged",
        "tagPrefixList": ["v"],
        "countType": "imageCountMoreThan",
        "countNumber": 10
      },
      "action": { "type": "expire" }
    }
  ]
}
```

```bash
aws ecr put-lifecycle-policy \
  --repository-name my-app/api \
  --lifecycle-policy-text file://lifecycle.json
```

Bẫy quan trọng: **rule priority quyết định thứ tự đánh giá**, và một khi image bị một rule chọn để expire, nó không bị các rule sau xét lại. Một image **untagged** xuất hiện rất thường khi bạn push một image mới đè lên tag đang dùng (tag di chuyển sang digest mới, digest cũ trở thành untagged). Rule "xoá untagged" rất phổ biến để dọn rác này. Lưu ý lifecycle chạy bất đồng bộ — image bị đánh dấu expire có thể mất tới 24 giờ mới thực sự xoá. Bạn có thể `--dry-run` hành vi qua API preview trước khi áp.

> 💡 **Exam Tip:** Lifecycle policy chỉ làm một việc: `expire` (xoá) image theo tuổi hoặc số lượng. Nó KHÔNG chuyển storage class (ECR không có storage tier như S3). Câu hỏi "tự động dọn image cũ để tiết kiệm chi phí ECR" → lifecycle policy. "Chuyển image sang lưu trữ rẻ hơn" → bẫy, ECR không có khái niệm này.

## 16.6 Image scanning — basic vs enhanced (Inspector)

ECR quét image tìm lỗ hổng bảo mật (CVE) theo hai chế độ:

| Tiêu chí | Basic scanning | Enhanced scanning |
|---|---|---|
| Engine | CVE database (Clair open-source) | Amazon Inspector |
| Phạm vi | Lỗ hổng OS packages | OS packages **+ application dependency** (npm, pip, gem, Go modules...) |
| Khi nào quét | Scan-on-push hoặc thủ công | Liên tục (continuous) — tự quét lại khi có CVE mới |
| Chi phí | Miễn phí | Tính phí qua Amazon Inspector |
| Cấu hình | Mức registry/repository | Bật qua Amazon Inspector |

**Basic scanning** dùng dữ liệu CVE để quét lỗ hổng ở tầng hệ điều hành của image. Có thể bật `scanOnPush=true` (tự quét ngay khi push) hoặc quét manual qua `start-image-scan`. Kết quả lấy bằng `describe-image-scan-findings`.

**Enhanced scanning** bàn giao việc quét cho **Amazon Inspector** — quét sâu hơn cả application-level dependency, và quan trọng là **quét liên tục**: khi một CVE mới được công bố cho package đã có trong image bạn từng push, Inspector tự phát hiện lại mà không cần push lại. Phù hợp môi trường compliance.

```bash
# Bat scan-on-push o muc registry (basic)
aws ecr put-registry-scanning-configuration \
  --scan-type BASIC \
  --rules '[{"scanFrequency":"SCAN_ON_PUSH","repositoryFilters":[{"filter":"*","filterType":"WILDCARD"}]}]'

# Lay ket qua scan cua mot image
aws ecr describe-image-scan-findings \
  --repository-name my-app/api \
  --image-id imageTag=v1
```

Bạn có thể dùng **EventBridge** để bắt sự kiện scan hoàn tất (`ECR Image Scan` event) và trigger Lambda/SNS cảnh báo nếu phát hiện CVE mức `CRITICAL`/`HIGH` — chặn deploy image không an toàn trong pipeline.

> 💡 **Exam Tip:** "Quét lỗ hổng cả OS lẫn dependency của application, liên tục re-scan khi có CVE mới" → **Enhanced scanning với Amazon Inspector**. "Quét lỗ hổng OS cơ bản, miễn phí, scan-on-push" → **Basic scanning**. Cả hai không tự chặn deploy; muốn chặn phải kết hợp EventBridge + logic pipeline.

## 16.7 Encryption, tag immutability và repository policy

**Encryption at rest:** ECR luôn mã hoá image. Mặc định dùng `AES256` (key do ECR quản lý). Bạn có thể chọn **KMS** (AWS managed key `aws/ecr` hoặc customer managed key — CMK) để kiểm soát key và audit qua CloudTrail. Lưu ý cấu hình encryption phải đặt **lúc tạo repository**, không đổi được sau đó (in-transit luôn là HTTPS/TLS).

**Image tag immutability:** đặt `IMMUTABLE` khiến một tag, sau khi gán cho một digest, **không thể bị push đè** sang digest khác. Điều này chặn lỗi nguy hiểm: ai đó push một image khác đè lên tag `v1.0.0` đã release và deploy. Với immutable, muốn version mới phải dùng tag mới → reproducible deploy. Mặc định là `MUTABLE`.

**Repository policy** (resource-based policy) là cách cấp quyền truy cập repository cho principal — đặc biệt **cross-account**. Khác với IAM policy (gắn vào identity), repository policy gắn vào chính repository và liệt kê ai (`Principal`) được làm gì. Đây là cơ chế chuẩn để account B pull image từ ECR của account A:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowCrossAccountPull",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::444455556666:root" },
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage"
      ]
    }
  ]
}
```

```bash
aws ecr set-repository-policy \
  --repository-name my-app/api \
  --policy-text file://repo-policy.json
```

Bẫy cross-account kinh điển: repository policy ở account A cho phép account B, **nhưng** principal trong account B vẫn cần IAM policy của riêng nó cho `ecr:GetAuthorizationToken` (action này không kiểm soát được bằng repository policy vì nó áp ở cấp registry, resource `*`). Nghĩa là cross-account pull cần **cả hai**: repository policy bên A + IAM permission `GetAuthorizationToken` bên B.

> 💡 **Exam Tip:** Chia sẻ image cho account khác → **repository policy** (resource-based) cho phép principal account đó + bên nhận tự có `ecr:GetAuthorizationToken`. Bảo vệ tag release khỏi bị ghi đè → **image tag immutability = IMMUTABLE**. Kiểm soát key mã hoá và audit → tạo repo với **KMS CMK**.

## 16.8 Cross-region replication, pull-through cache và multi-arch image

**Replication:** ECR có thể tự sao chép image sang region khác hoặc account khác qua **registry-level replication configuration**. Khi bật, image push vào region nguồn được nhân bản tự động sang đích — hữu ích cho multi-region deployment (giảm latency pull và đỡ phụ thuộc một region). Replication áp ở cấp registry, lọc theo repository prefix.

```bash
aws ecr put-replication-configuration --replication-configuration '{
  "rules": [{
    "destinations": [
      { "region": "us-east-1", "registryId": "111122223333" }
    ]
  }]
}'
```

Lưu ý: replication chỉ chép image **mới push sau khi bật** (không backfill image cũ); và destination region phải có repository hoặc ECR sẽ tạo tự động (tuỳ cấu hình). Cross-account replication còn cần repository/registry permission ở phía nhận.

**Pull-through cache:** ECR có thể đóng vai cache cho upstream registry (Docker Hub, ECR Public, Quay...). Lần đầu pull một image qua pull-through cache repository, ECR kéo từ upstream và lưu lại; các lần sau pull từ ECR. Lợi ích: tránh rate limit Docker Hub, giảm latency, và image được Inspector quét. Đây là giải pháp đề thi gợi ý khi gặp tình huống "build trên AWS fail vì Docker Hub rate limit".

**Multi-arch image:** Graviton (ARM64) ngày càng phổ biến vì giá/hiệu năng tốt. Một image build cho `linux/amd64` (x86) **không chạy** trên Graviton (`linux/arm64`) và ngược lại. Giải pháp là **multi-arch image** dùng một **image manifest list** (còn gọi OCI image index): một tag (ví dụ `:v1`) trỏ tới nhiều image cụ thể theo kiến trúc; khi node pull, Docker tự chọn image khớp `os/arch` của nó.

```bash
# Build va push multi-arch trong mot lenh voi docker buildx
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t $REGISTRY/my-app/api:v1 \
  --push .
```

ECR lưu manifest list này như một image; cả ECS Fargate (chọn `runtimePlatform` ARM64/X86_64) lẫn Lambda (chọn architecture `arm64`/`x86_64`) đều pull đúng biến thể. Nếu bạn deploy task ARM64 nhưng image chỉ có biến thể amd64, container sẽ fail khởi động với lỗi exec format / no matching manifest — một lỗi thực tế hay gặp khi chuyển sang Graviton.

> 💡 **Exam Tip:** Rate limit Docker Hub khi build trên AWS → **ECR pull-through cache** hoặc dùng **ECR Public** (`public.ecr.aws`). Cần image chạy được trên cả x86 và Graviton ARM64 → **multi-arch image (manifest list)** qua `docker buildx --platform`. Cần image gần với workload ở nhiều region để giảm latency pull → **cross-region replication**.

---

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
