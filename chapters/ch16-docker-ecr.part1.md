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
