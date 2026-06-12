# Chương 40: CodeCommit & CodeBuild

> **Trọng tâm DVA-C02:** Đây là hai mắt xích đầu của pipeline CI/CD AWS, thuộc domain Deployment (24%). Đề hay hỏi: cách xác thực với CodeCommit qua HTTPS Git Credentials / SSH / `git-remote-codecommit` (GRC) mà **không** dùng access key thường, IAM policy tối thiểu cho repo, cách kích hoạt build qua trigger/EventBridge. Phần CodeBuild ra nhiều nhất: cấu trúc `buildspec.yml` (thứ tự phases `install→pre_build→build→post_build`, vị trí `artifacts`, `cache`, `reports`), cách lấy secret từ Secrets Manager/SSM trong build, biến môi trường dựng sẵn, build trong VPC, và pattern build + push image lên ECR. Lưu ý CodeCommit đã ngừng nhận khách hàng mới (tháng 7/2024) nhưng **đề DVA-C02 vẫn hỏi** như một dịch vụ Git managed.

## Mục tiêu chương
- Phân biệt rõ Continuous Integration / Continuous Delivery / Continuous Deployment và vị trí của CodeCommit, CodeBuild trong chuỗi đó.
- Thiết lập xác thực CodeCommit đúng cách: HTTPS Git Credentials, SSH key, và `git-remote-codecommit` (GRC) — biết khi nào dùng cái nào và vì sao không dùng access key tĩnh.
- Viết IAM policy, cấu hình triggers/notifications cho CodeCommit và hiểu trạng thái dịch vụ hiện tại (no new customers) cùng đường migration sang GitHub.
- Đọc và viết được `buildspec.yml` đầy đủ: phases, `env`, `artifacts`, `cache`, `reports`, `batch`; hiểu chính xác thứ tự thực thi và hành vi khi một phase lỗi.
- Cấu hình CodeBuild environment (managed image vs custom image trên ECR), inject secret an toàn từ Secrets Manager/SSM, chạy build trong VPC, và bật caching để tăng tốc.
- Build và push Docker image lên ECR từ CodeBuild, sinh test reports, và debug build cục bộ bằng CodeBuild local agent.

## 40.1 CI/CD concepts — và vị trí của CodeCommit, CodeBuild

Trước khi vào dịch vụ, cần khóa chặt ba thuật ngữ vì đề DVA hay gài chữ "delivery" và "deployment":

- **Continuous Integration (CI):** mỗi lần dev push code, hệ thống tự build + chạy test. Mục tiêu: phát hiện lỗi merge sớm, giữ nhánh chính luôn "xanh". CodeBuild là dịch vụ CI điển hình trên AWS.
- **Continuous Delivery:** sau CI, artifact được tự động chuẩn bị tới trạng thái **sẵn sàng deploy**, nhưng bước đẩy lên production cần **người duyệt** (manual approval). 
- **Continuous Deployment:** như trên nhưng **không** có bước duyệt tay — mọi commit pass test sẽ tự ra production.

Ánh xạ sang AWS Developer Tools (gọi chung là "Code suite"):

| Giai đoạn | Dịch vụ AWS | Vai trò |
|---|---|---|
| Source (lưu code) | **CodeCommit** (hoặc GitHub, S3, ECR) | Git repository managed |
| Build & test | **CodeBuild** | Biên dịch, đóng gói, chạy unit test, build image |
| Deploy | **CodeDeploy** | Đưa artifact ra EC2/Lambda/ECS (Chương 41) |
| Orchestrate | **CodePipeline** | Nối các stage source→build→deploy (Chương 42) |

Chương này chỉ tập trung hai mắt xích đầu. CodeDeploy ở **Chương 41**, CodePipeline + CodeArtifact + CodeGuru ở **Chương 42**.

> 💡 **Exam Tip:** Từ khóa nhận diện: "automatically build and test on every commit" → CodeBuild (CI). "Requires manual approval before production" → Continuous **Delivery**. "Fully automated to production, no human" → Continuous **Deployment**. Đề thường dùng đúng các cụm này.

## 40.2 CodeCommit — Git repository managed & trạng thái dịch vụ

CodeCommit là dịch vụ host Git repository riêng tư, fully managed: không giới hạn dung lượng repo thực tế (object lưu trên S3, metadata trên DynamoDB phía sau), được mã hóa at-rest mặc định bằng KMS và in-transit qua HTTPS/SSH, scale tự động. Về tính năng Git nó tương đương GitHub/GitLab nhưng nằm trong tài khoản AWS, hưởng IAM, KMS, CloudTrail, EventBridge sẵn.

**Trạng thái dịch vụ — điểm phải nhớ cho năm 2025/2026:** Từ **28/07/2024**, AWS **ngừng nhận khách hàng mới** cho CodeCommit (no new customers). Tài khoản đã dùng vẫn tiếp tục hoạt động bình thường, nhưng AWS không phát triển tính năng mới. Hướng khuyến nghị là migrate source sang **GitHub** (hoặc GitLab/Bitbucket) và kết nối vào pipeline qua **CodeStar Connections / CodeConnections** (chi tiết ở Chương 42). Dù vậy, **DVA-C02 vẫn còn câu hỏi về CodeCommit** — bạn cần biết cơ chế auth và IAM của nó.

> 💡 **Exam Tip:** Nếu đề hỏi "fully managed, private Git repository **trong AWS**, tích hợp IAM" → CodeCommit. Nếu đề nói "kết nối repository GitHub vào CodePipeline an toàn không dùng OAuth token cá nhân" → **CodeStar/CodeConnections** chứ không phải CodeCommit.

### Tạo repo và clone bằng CLI

```bash
# Tạo repository
aws codecommit create-repository \
  --repository-name my-app \
  --repository-description "Demo repo DVA" \
  --tags Team=backend

# Lấy URL clone HTTPS
aws codecommit get-repository --repository-name my-app \
  --query 'repositoryMetadata.cloneUrlHttp' --output text
# => https://git-codecommit.ap-southeast-1.amazonaws.com/v1/repos/my-app
```

## 40.3 Xác thực với CodeCommit — ba cơ chế, không dùng access key trần

Đây là phần CodeCommit đề hỏi nhiều nhất. CodeCommit **không** dùng username/password thường và **không** cho clone bằng access key/secret key trực tiếp như gọi API. Có ba cách hợp lệ:

**1. HTTPS Git Credentials (đơn giản nhất, khuyên dùng).** Trong IAM, vào IAM user → tab Security credentials → "HTTPS Git credentials for AWS CodeCommit" → Generate. AWS sinh ra một cặp **username/password riêng cho Git** (khác hoàn toàn access key). Cắm cặp này vào Git credential helper hoặc nhập khi clone. Ưu điểm: chạy qua port 443, xuyên proxy/firewall doanh nghiệp dễ.

```bash
# Sau khi tạo HTTPS Git credentials trong IAM
git clone https://git-codecommit.ap-southeast-1.amazonaws.com/v1/repos/my-app
# Git hỏi username/password → nhập cặp Git credentials vừa tạo
```

**2. SSH keys.** Tạo cặp SSH key, upload **public key** lên IAM user (`upload-ssh-public-key`), AWS trả về một **SSH Key ID** dạng `APKA...`. Dùng Key ID này làm `User` trong `~/.ssh/config`.

```bash
aws iam upload-ssh-public-key --user-name dev-anh \
  --ssh-public-key-body file://~/.ssh/codecommit_rsa.pub
# Trả về SSHPublicKeyId, ví dụ APKAEIBAERJR2EXAMPLE
```

```sshconfig
# ~/.ssh/config
Host git-codecommit.*.amazonaws.com
  User APKAEIBAERJR2EXAMPLE
  IdentityFile ~/.ssh/codecommit_rsa
```

**3. `git-remote-codecommit` (GRC) — tốt nhất cho IAM role / federation / SSO.** Đây là Python helper cài qua pip. Nó ký request bằng **SigV4** dùng credentials chuẩn của AWS CLI (kể cả credentials tạm từ STS/role/SSO), nên **không cần tạo Git credentials hay SSH key riêng**. Đây là cách duy nhất hoạt động mượt với **temporary credentials** (assume role, MFA, IAM Identity Center).

```bash
pip install git-remote-codecommit
# Clone qua GRC — dùng đúng profile/role trong AWS CLI
git clone codecommit::ap-southeast-1://my-app
# Hoặc chỉ định profile:
git clone codecommit://my-profile@my-app
```

| Cơ chế | Cấp credential ở đâu | Phù hợp khi | Hỗ trợ temporary creds (role/SSO)? |
|---|---|---|---|
| HTTPS Git Credentials | IAM user (Git password riêng) | IAM **user** cố định, qua proxy 443 | Không |
| SSH keys | IAM user (upload public key) | Có sẵn workflow SSH | Không |
| **git-remote-codecommit (GRC)** | AWS CLI credentials (SigV4) | **IAM role, MFA, SSO, federation** | **Có** |

> 💡 **Exam Tip:** Câu hỏi kinh điển: "Developer dùng IAM role / federated SSO, không có IAM user, cần clone CodeCommit. Cách nào?" → **git-remote-codecommit (GRC)**, vì HTTPS Git Credentials và SSH key chỉ gắn được vào IAM **user**, không hoạt động với credentials tạm. Tránh bẫy "tạo access key" — CodeCommit không clone bằng access key trực tiếp.

### IAM policy cho CodeCommit

Quyền được cấp qua IAM policy chuẩn (identity-based). AWS có managed policy `AWSCodeCommitPowerUser` (mọi thứ trừ xóa repo). Policy fine-grained có thể giới hạn theo `Resource` (ARN repo) và dùng condition như `codecommit:References` để **chặn push vào nhánh** nhất định:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Deny",
    "Action": ["codecommit:GitPush", "codecommit:DeleteBranch",
               "codecommit:PutFile", "codecommit:MergeBranchesByFastForward"],
    "Resource": "arn:aws:codecommit:ap-southeast-1:111122223333:my-app",
    "Condition": {
      "StringEqualsIfExists": {
        "codecommit:References": ["refs/heads/main"]
      }
    }
  }]
}
```

Policy này deny push trực tiếp vào `main` — buộc team đi qua pull request. Đây là pattern bảo vệ nhánh hay xuất hiện trong đề security.

## 40.4 CodeCommit triggers & notifications — kích hoạt pipeline

CodeCommit có hai cơ chế phát sự kiện, đừng nhầm:

- **Triggers (cũ):** gắn trực tiếp trên repo, gửi sự kiện tới **SNS** hoặc **Lambda** khi có push/tạo branch/tạo tag. Cấu hình giới hạn ở mức repo, dùng `put-repository-triggers`.
- **EventBridge / CloudWatch Events (khuyên dùng):** CodeCommit phát event như `CodeCommit Repository State Change` (push, branch created...) và `Pull Request State Change` lên **EventBridge**. Đây là cách chuẩn để **kích hoạt CodePipeline** hoặc Lambda, linh hoạt hơn nhiều so với trigger cũ.
- **Notifications:** dùng AWS CodeStar Notifications gửi tới SNS/AWS Chatbot (Slack) khi có comment PR, merge, build status...

```bash
# Tạo trigger gọi Lambda khi có push lên main
aws codecommit put-repository-triggers --repository-name my-app \
  --triggers '[{
    "name": "on-push-main",
    "destinationArn": "arn:aws:lambda:ap-southeast-1:111122223333:function:notify",
    "branches": ["main"],
    "events": ["updateReference"]
  }]'
```

> 💡 **Exam Tip:** Muốn pipeline chạy **ngay khi commit** (không polling, độ trễ thấp) → dùng **EventBridge rule** trên event "CodeCommit Repository State Change". CodePipeline mặc định polling repo mỗi vài phút; chuyển sang EventBridge cho trigger tức thời. (Chi tiết trigger pipeline ở Chương 42.)

## 40.5 CodeBuild — kiến trúc & vòng đời một build

CodeBuild là dịch vụ build fully managed, **không có build server để quản** — bạn không phải vận hành Jenkins. Bạn định nghĩa một **build project** gồm: nguồn (source), môi trường (compute + image), và buildspec. Khi chạy, CodeBuild:

1. Cấp phát một **container tạm** (ephemeral) theo compute type bạn chọn.
2. Pull source (từ CodeCommit/GitHub/S3/ECR), pull image môi trường.
3. Chạy các **phases** trong `buildspec.yml`.
4. Đẩy **artifacts** ra S3 (nếu khai báo), **logs** ra CloudWatch Logs/S3, **reports** ra CodeBuild Reports.
5. **Hủy container** — không giữ state giữa các build (trừ cache).

Tính phí **theo phút build** nhân theo compute type — dừng build sớm để tiết kiệm. Compute types phổ biến: `BUILD_GENERAL1_SMALL` (3 GB RAM, 2 vCPU), `MEDIUM` (7 GB, 4 vCPU), `LARGE` (15 GB, 8 vCPU), và các loại lớn hơn cho ARM/GPU.

**Giới hạn cần nhớ:** build timeout mặc định 60 phút, tối đa **8 giờ**. Một project chạy được nhiều build song song (concurrency có thể đặt giới hạn). Image môi trường có thể là **managed image** của AWS (Amazon Linux 2, Ubuntu standard image kèm sẵn runtime) hoặc **custom image** bạn tự build và lưu trên ECR/Docker Hub.

```bash
# Khởi chạy build thủ công, override branch source
aws codebuild start-build --project-name my-app-build \
  --source-version main
```

> 💡 **Exam Tip:** CodeBuild **không giữ trạng thái giữa các lần build** (container bị hủy). Muốn tái dùng `node_modules`/`.m2` giữa các build phải bật **cache** (local cache hoặc S3 cache) — xem 40.8. Đây là nguồn câu hỏi "build chậm vì tải lại dependency mỗi lần".

## 40.6 buildspec.yml — cấu trúc & thứ tự phases

`buildspec.yml` đặt ở **gốc source** (mặc định), hoặc khai báo nội tuyến trong project, hoặc trỏ tới đường dẫn khác. Cấu trúc đầy đủ:

```yaml
version: 0.2

env:
  variables:                 # biến môi trường plaintext
    NODE_ENV: production
  parameter-store:           # lấy từ SSM Parameter Store
    DB_HOST: /myapp/prod/db-host
  secrets-manager:           # lấy từ Secrets Manager
    DB_PASS: prod/db:password   # secretId:jsonKey
  exported-variables:        # biến truyền sang stage sau trong pipeline
    - IMAGE_TAG

phases:
  install:
    runtime-versions:        # chọn runtime trên managed image
      nodejs: 20
    commands:
      - npm ci
  pre_build:
    commands:
      - echo "Login ECR..."
      - aws ecr get-login-password | docker login --username AWS --password-stdin $ECR_URI
  build:
    commands:
      - npm run build
      - npm test
  post_build:
    commands:
      - echo "Build hoàn tất ngày $(date)"

reports:                     # test reports
  jest-reports:
    files: ['junit.xml']
    file-format: JUNITXML

artifacts:                   # gì sẽ được đóng gói ra S3
  files:
    - '**/*'
  base-directory: dist
  name: my-app-$(date +%Y-%m-%d)

cache:
  paths:
    - 'node_modules/**/*'
```

**Thứ tự thực thi phases (PHẢI thuộc lòng):** `install` → `pre_build` → `build` → `post_build`. Đây là bốn phase cho phép `commands`. Mỗi command chạy trong **shell riêng**, nhưng các command cùng phase chia sẻ cùng môi trường (trừ việc `cd` không persist sang command kế tiếp — phải nối bằng `&&` hoặc dùng đường dẫn tuyệt đối).

**Hành vi khi lỗi — bẫy quan trọng:**
- Nếu một command trong `install`/`pre_build`/`build` thất bại (exit code ≠ 0), phase đó **fail** và build chuyển thẳng tới `post_build` rồi kết thúc với trạng thái FAILED. Tức là **`post_build` vẫn chạy dù `build` lỗi** — dùng để cleanup/logging, nhưng nhớ kiểm tra `CODEBUILD_BUILD_SUCCEEDING` nếu chỉ muốn push artifact khi build thành công.
- `artifacts` **chỉ được upload nếu build SUCCEEDED**. Nếu build fail, không có artifact ra S3.

```yaml
post_build:
  commands:
    # chỉ push image nếu build trước đó thành công
    - if [ "$CODEBUILD_BUILD_SUCCEEDING" = "1" ]; then docker push $ECR_URI:$IMAGE_TAG; fi
```

> 💡 **Exam Tip:** Hai điểm gài bẫy: (1) `post_build` **luôn chạy** kể cả khi `build` fail — kiểm `CODEBUILD_BUILD_SUCCEEDING` (1=ok, 0=đang fail) trước khi làm hành động "chỉ-khi-thành-công". (2) Mỗi command là một shell mới: `cd app` ở dòng trên **không** giữ sang dòng dưới — phải `cd app && npm ci` trên cùng một dòng.

> 💡 **Exam Tip:** Tên file mặc định là `buildspec.yml` ở **gốc** repo. Đổi tên/đường dẫn được, nhưng phải khai báo trong project (thuộc tính `buildspec`). `version: 0.2` là bản hiện hành; `0.1` chạy mỗi command trong shell tách biệt hoàn toàn (legacy).

## 40.7 Biến môi trường & secrets trong CodeBuild

CodeBuild dựng sẵn nhiều **environment variables** hữu ích, hay xuất hiện trong code mẫu đề thi:

| Biến | Ý nghĩa |
|---|---|
| `CODEBUILD_BUILD_ID` | ID đầy đủ của build (`project:uuid`) |
| `CODEBUILD_RESOLVED_SOURCE_VERSION` | Commit SHA thực được build — thường dùng làm image tag |
| `CODEBUILD_SRC_DIR` | Thư mục chứa source đã checkout |
| `CODEBUILD_BUILD_SUCCEEDING` | 1 nếu build đang thành công, 0 nếu đang fail |
| `AWS_DEFAULT_REGION`, `AWS_REGION` | Region đang chạy |
| `CODEBUILD_BUILD_ARN` | ARN build, dùng cho logging/audit |

**Inject secret — KHÔNG hardcode.** Có ba mức ưu tiên về độ an toàn:
1. **Plaintext variables** (`env.variables` hoặc trong project): KHÔNG dùng cho secret — chúng hiện rõ trong console/logs.
2. **SSM Parameter Store** (`env.parameter-store`): lấy SecureString lúc build. Cần IAM cho service role: `ssm:GetParameters` (+ `kms:Decrypt` nếu SecureString dùng CMK).
3. **Secrets Manager** (`env.secrets-manager`): cú pháp `secretId:jsonKey:versionStage:versionId`. Cần `secretsmanager:GetSecretValue` (+ `kms:Decrypt`).

```yaml
env:
  parameter-store:
    API_KEY: /myapp/api-key            # SSM SecureString
  secrets-manager:
    DB_PASSWORD: prod/db-cred:password # field "password" trong JSON secret
```

CodeBuild tự **mask** giá trị từ Secrets Manager/Parameter Store trong logs (hiển thị `***`). Service role của CodeBuild phải có quyền đọc các nguồn này — nếu thiếu, build fail ở bước resolve env với lỗi AccessDenied trước khi vào phase.

> 💡 **Exam Tip:** "Build cần DB password, không được để lộ trong buildspec/logs" → dùng `secrets-manager` (hoặc `parameter-store` SecureString) trong `env`, và cấp `secretsmanager:GetSecretValue`/`ssm:GetParameters` + `kms:Decrypt` cho **service role của CodeBuild**, chứ không phải role của developer. (So sánh Parameter Store vs Secrets Manager ở Chương 47.)

## 40.8 Caching, artifacts & CodeBuild trong VPC

**Caching** giảm thời gian build bằng cách giữ lại dependency/layer giữa các lần chạy. Hai loại:
- **S3 cache:** lưu các path khai báo (`cache.paths`) lên bucket S3 do bạn chỉ định. Bền, dùng được cho dependency lớn, nhưng tốn thời gian upload/download mạng.
- **Local cache:** cache ngay trên host build (nếu reuse được host). Có ba mode kết hợp được: `LOCAL_SOURCE_CACHE` (cache git), `LOCAL_DOCKER_LAYER_CACHE` (cache Docker layer — rất hữu ích khi build image), `LOCAL_CUSTOM_CACHE` (path tùy ý). Local cache nhanh hơn nhưng **không đảm bảo** lần build sau trúng đúng host đã cache.

```bash
aws codebuild create-project --name my-app-build \
  --source type=CODECOMMIT,location=https://git-codecommit... \
  --artifacts type=S3,location=my-artifact-bucket \
  --cache type=S3,location=my-artifact-bucket/cache \
  --environment type=LINUX_CONTAINER,image=aws/codebuild/amazonlinux2-x86_64-standard:5.0,computeType=BUILD_GENERAL1_SMALL \
  --service-role arn:aws:iam::111122223333:role/codebuild-service-role
```

**Artifacts** là output đóng gói. Type có thể là `S3` (lưu zip/folder), `NO_ARTIFACTS` (chỉ build/test, không output), hoặc do CodePipeline quản lý (`CODEPIPELINE`) khi project chạy trong pipeline. Khi trong pipeline, artifact tự chuyển giữa các stage qua S3 (chi tiết ở Chương 42).

**CodeBuild trong VPC:** mặc định container build chạy ngoài VPC của bạn, có internet. Nếu cần truy cập tài nguyên private (RDS, ElastiCache, internal service, hoặc kéo package từ CodeArtifact qua VPC endpoint), cấu hình `vpcConfig` với `vpcId`, `subnets`, `securityGroupIds`. Lưu ý quan trọng: build trong VPC mất internet trực tiếp trừ khi subnet là **private + có NAT Gateway**, hoặc dùng **VPC endpoints** (interface endpoint cho CodeBuild/ECR/S3 gateway endpoint...). Service role cần quyền tạo/xóa ENI (`ec2:CreateNetworkInterface`...).

> 💡 **Exam Tip:** "CodeBuild cần truy cập RDS trong private subnet" → bật **VPC config** (subnets + security group). "Build trong VPC không tải được package từ npm/internet" → đặt build vào **private subnet có NAT Gateway**, hoặc tải qua VPC endpoints. Public subnet **không** cấp internet cho build (CodeBuild ENI không nhận public IP).

## 40.9 Build & push Docker image lên ECR, test reports & local build

Một trong những use case CodeBuild phổ biến nhất là **build image rồi push lên ECR** để ECS/EKS/Lambda dùng. Mẫu buildspec hoàn chỉnh:

```yaml
version: 0.2
phases:
  pre_build:
    commands:
      - REPO_URI=111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/my-app
      - IMAGE_TAG=${CODEBUILD_RESOLVED_SOURCE_VERSION:-latest}
      # login ECR (password-stdin, không lộ token)
      - aws ecr get-login-password --region $AWS_REGION \
          | docker login --username AWS --password-stdin $REPO_URI
  build:
    commands:
      - docker build -t $REPO_URI:$IMAGE_TAG .
  post_build:
    commands:
      - docker push $REPO_URI:$IMAGE_TAG
      # sinh imagedefinitions.json cho CodePipeline → ECS deploy
      - printf '[{"name":"app","imageUri":"%s"}]' "$REPO_URI:$IMAGE_TAG" > imagedefinitions.json
artifacts:
  files: imagedefinitions.json
```

Hai điều kiện bắt buộc để chạy `docker build`: (1) environment phải bật cờ **privileged mode** (`privilegedMode: true`) vì cần Docker daemon trong container; (2) service role cần quyền ECR (`ecr:GetAuthorizationToken` ở Resource `*`, cộng `ecr:BatchCheckLayerAvailability`, `ecr:PutImage`, `ecr:UploadLayerPart`... trên repo). File `imagedefinitions.json` là artifact chuẩn để stage CodeDeploy/ECS trong CodePipeline biết image nào cần deploy (Chương 41–42, ECR chi tiết ở Chương 16).

> 💡 **Exam Tip:** Build Docker image trong CodeBuild báo lỗi "Cannot connect to the Docker daemon" → quên bật **privileged mode** trên environment. Đây là câu hỏi troubleshooting cổ điển.

**Test reports.** Khai báo block `reports` để CodeBuild thu kết quả test và hiển thị pass/fail, trend trong console (Report groups). Hỗ trợ format: `JUNITXML`, `NUNITXML`, `NUNIT3XML`, `CUCUMBERJSON`, `TESTNGXML`, `VISUALSTUDIOTRX` cho test results, và `CLOVERXML`/`COBERTURAXML`/`JACOCOXML`/`SIMPLECOV` cho code coverage. Service role cần quyền `codebuild:CreateReport`, `codebuild:UpdateReport`, `codebuild:BatchPutTestCases`.

**Local build với CodeBuild agent.** Để debug buildspec mà không tốn build minutes trên cloud, AWS cung cấp **CodeBuild local agent** (image `aws/codebuild/local-builds`) chạy bằng Docker trên máy bạn, dùng script `codebuild_build.sh`. Nó mô phỏng môi trường build, giúp lặp nhanh khi sửa buildspec.

```bash
# Tải agent image rồi chạy build cục bộ
docker pull public.ecr.aws/codebuild/local-builds:latest
./codebuild_build.sh -i aws/codebuild/amazonlinux2-x86_64-standard:5.0 \
  -a /tmp/artifacts -s .
```

**Batch builds.** Khối `batch` trong buildspec cho phép chạy nhiều build song song/tuần tự (ví dụ build đa nền tảng, fan-out test) trong một lần — hữu ích khi cần ma trận build (matrix). 

**Logs & metrics.** CodeBuild đẩy log ra **CloudWatch Logs** (mặc định) và/hoặc S3; phát metrics như `Builds`, `Duration`, `SucceededBuilds`, `FailedBuilds` lên CloudWatch để dựng alarm. Trạng thái build (SUCCEEDED/FAILED) phát lên **EventBridge** để trigger bước kế hoặc thông báo.

> 💡 **Exam Tip:** "Debug buildspec mà không chạy trên AWS / không tốn phí" → **CodeBuild local agent** (Docker). "Theo dõi build chậm dần / tỉ lệ fail" → CloudWatch **metrics** (`Duration`, `FailedBuilds`) + alarm. "Chạy bước tiếp theo ngay khi build xong" → **EventBridge** trên build state-change event.

## 40.10 CodeBuild vs các lựa chọn CI khác & checklist bẫy thực tế

Đề DVA thỉnh thoảng so CodeBuild với cách tự dựng CI. Nắm nhanh khi nào chọn gì:

| Tiêu chí | CodeBuild | Jenkins tự host (trên EC2) |
|---|---|---|
| Quản lý hạ tầng | Không (fully managed, serverless build) | Tự vá, tự scale, tự HA |
| Tính phí | Theo phút build | Theo EC2 chạy 24/7 dù không build |
| Tích hợp AWS (IAM, ECR, Secrets, VPC) | Gốc, không cần plugin | Cần plugin/cấu hình tay |
| Tùy biến môi trường sâu | Custom image trên ECR | Toàn quyền |
| Phù hợp | CI cloud-native, on-demand | Pipeline phức tạp/đặc thù đã có sẵn |

Từ khóa "least operational overhead" cho khâu build gần như luôn dẫn tới **CodeBuild** thay vì Jenkins-on-EC2.

**Checklist bẫy production hay gặp (và hay vào đề troubleshooting):**
- Build fail ngay khi resolve env → service role thiếu `secretsmanager:GetSecretValue` / `ssm:GetParameters` / `kms:Decrypt`.
- `docker: Cannot connect to the Docker daemon` → chưa bật **privileged mode**.
- `cd` không có tác dụng ở command kế tiếp → mỗi command là shell riêng, dùng `&&`.
- Build trong VPC treo khi tải dependency từ internet → đặt vào **private subnet + NAT**, không phải public subnet.
- Build chậm vì tải lại `node_modules` mỗi lần → bật **cache** (S3 hoặc local Docker layer cache).
- `post_build` push artifact dù build lỗi → kiểm `CODEBUILD_BUILD_SUCCEEDING`.
- Clone CodeCommit bằng IAM role/SSO không được → dùng **git-remote-codecommit (GRC)**, không phải Git credentials/SSH (chỉ gắn IAM user).
- Pipeline trễ khi có commit → chuyển từ polling sang **EventBridge** trigger.

> 💡 **Exam Tip:** Khi đề ghép cả chuỗi "commit → build → deploy" và hỏi từng mắt xích: **CodeCommit = source**, **CodeBuild = build/test (CI)**, **CodeDeploy = deploy (Chương 41)**, **CodePipeline = orchestration (Chương 42)**. Đừng để đáp án trộn vai trò — CodeBuild **không** deploy ra EC2/Lambda, đó là việc của CodeDeploy.

---

## Hands-on Lab: Build & push Docker image lên ECR bằng CodeBuild (buildspec, cache, secrets, test reports)

**Mục tiêu lab:** Dựng một CodeBuild project hoàn chỉnh lấy source từ CodeCommit (hoặc S3 nếu CodeCommit không khả dụng ở account của bạn), viết `buildspec.yml` đầy đủ các phase, inject biến môi trường từ SSM Parameter Store và Secrets Manager, bật caching để build nhanh hơn, build một Docker image rồi push lên Amazon ECR, và xuất một test report. Bạn sẽ chạy build bằng CLI, đọc log/metrics, rồi dọn dẹp. Chi phí: build trên `general1.small` Linux khoảng vài cent (free tier 100 build-minute/tháng cho `general1.small`), ECR/CodeCommit gần như miễn phí nếu xoá ngay.

**Chuẩn bị:**
- AWS CLI v2 (`aws --version` in ra `aws-cli/2.x`), profile có quyền `codecommit:*`, `codebuild:*`, `ecr:*`, `iam:*`, `ssm:*`, `secretsmanager:*`, `logs:*`.
- Đặt biến tiện dùng: `REGION=ap-southeast-1`, `ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)`.
- Git đã cài (để push code lên CodeCommit). Nếu account tạo sau 25/07/2024 không thấy CodeCommit tạo repo mới được (AWS đã ngừng cấp cho account mới), dùng nhánh "Phương án B: source từ S3" ở Bước 2.

### Bước 1: Tạo ECR repository và IAM service role cho CodeBuild

CodeBuild chạy dưới một **service role** — role này phải có quyền ghi log, kéo/đẩy ECR, đọc SSM/Secrets. Tạo role với trust policy cho `codebuild.amazonaws.com`:

```bash
aws ecr create-repository --repository-name dva-lab-app --region $REGION

cat > trust.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "codebuild.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}
EOF

aws iam create-role --role-name dva-codebuild-role \
  --assume-role-policy-document file://trust.json
```

Gắn policy quyền (lab dùng managed policy rộng cho gọn; production phải siết theo resource cụ thể):

```bash
aws iam attach-role-policy --role-name dva-codebuild-role \
  --policy-arn arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryPowerUser
aws iam attach-role-policy --role-name dva-codebuild-role \
  --policy-arn arn:aws:iam::aws:policy/CloudWatchLogsFullAccess
aws iam attach-role-policy --role-name dva-codebuild-role \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMReadOnlyAccess
aws iam attach-role-policy --role-name dva-codebuild-role \
  --policy-arn arn:aws:iam::aws:policy/SecretsManagerReadWrite
```

> Bẫy thực tế: để **push image lên ECR**, môi trường build phải bật `privileged-mode: true` (Docker daemon trong container). Quên bật → `Cannot connect to the Docker daemon`. Đây là điểm DVA hay gài.

### Bước 2: Tạo source (CodeCommit hoặc S3) với Dockerfile + buildspec

Tạo các file ứng dụng. `buildspec.yml` là trái tim của CodeBuild — đọc kỹ từng phase:

```bash
mkdir dva-app && cd dva-app

cat > Dockerfile <<'EOF'
FROM public.ecr.aws/docker/library/node:18-alpine
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY . .
CMD ["node","index.js"]
EOF

cat > index.js <<'EOF'
console.log("Hello from CodeBuild lab");
EOF

cat > package.json <<'EOF'
{ "name": "dva-app", "version": "1.0.0",
  "scripts": { "test": "node --test" } }
EOF
```

Tạo `buildspec.yml` đầy đủ — chú thích trong file giải thích từng khối:

```yaml
version: 0.2

env:
  variables:
    IMAGE_TAG: "latest"          # biến tĩnh
  parameter-store:
    APP_STAGE: /dva-lab/stage    # đọc từ SSM Parameter Store lúc build
  secrets-manager:
    API_KEY: dva-lab-secret:apikey  # đọc từ Secrets Manager (key trong JSON)

phases:
  install:
    runtime-versions:
      nodejs: 18
    commands:
      - echo "install phase - cài dependency hệ thống nếu cần"
  pre_build:
    commands:
      - echo "Login ECR..."
      - aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com
      - REPO_URI=$ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/dva-lab-app
      - npm install
  build:
    commands:
      - echo "Stage = $APP_STAGE"            # biến từ SSM
      - npm test 2>&1 | tee test-results.tap || true
      - docker build -t $REPO_URI:$IMAGE_TAG .
  post_build:
    commands:
      - docker push $REPO_URI:$IMAGE_TAG
      - echo "Pushed $REPO_URI:$IMAGE_TAG"

reports:
  unit-tests:
    files:
      - test-results.tap
    file-format: TAP             # định dạng report (TAP/JUNITXML/...)

artifacts:
  files:
    - '**/*'
  name: build-output

cache:
  paths:
    - 'node_modules/**/*'        # cache để build sau nhanh hơn
```

**Phương án A — CodeCommit** (nếu account của bạn còn tạo repo được):

```bash
aws codecommit create-repository --repository-name dva-lab-repo --region $REGION
git init && git add . && git commit -m "init"
git remote add origin codecommit::$REGION://dva-lab-repo   # cần git-remote-codecommit (GRC)
git push origin master
```

GRC (`git-remote-codecommit`, cài bằng `pip install git-remote-codecommit`) ký request bằng SigV4 từ credentials AWS CLI — không cần cấu hình SSH key hay Git credentials riêng. Đây là cách auth được AWS khuyến nghị (chi tiết các cơ chế auth ở part1).

**Phương án B — source từ S3** (account mới không có CodeCommit):

```bash
zip -r ../src.zip .
aws s3 mb s3://dva-lab-src-$ACCOUNT_ID --region $REGION
aws s3 cp ../src.zip s3://dva-lab-src-$ACCOUNT_ID/src.zip
```

### Bước 3: Tạo các tham số SSM/Secrets mà buildspec tham chiếu

Nếu thiếu các giá trị này, build fail ngay phase DOWNLOAD_SOURCE/PROVISIONING với lỗi resolve env:

```bash
aws ssm put-parameter --name /dva-lab/stage --value "dev" --type String --region $REGION
aws secretsmanager create-secret --name dva-lab-secret \
  --secret-string '{"apikey":"super-secret-123"}' --region $REGION
```

### Bước 4: Tạo CodeBuild project

Với **Phương án A (CodeCommit)** dùng `--source type=CODECOMMIT`; với **Phương án B (S3)** dùng `type=S3`. Ví dụ dùng S3:

```bash
ROLE_ARN=$(aws iam get-role --role-name dva-codebuild-role --query Role.Arn --output text)

aws codebuild create-project --region $REGION \
  --name dva-lab-build \
  --source "type=S3,location=dva-lab-src-$ACCOUNT_ID/src.zip" \
  --artifacts "type=NO_ARTIFACTS" \
  --environment "type=LINUX_CONTAINER,image=aws/codebuild/amazonlinux2-x86_64-standard:5.0,computeType=BUILD_GENERAL1_SMALL,privilegedMode=true,environmentVariables=[{name=ACCOUNT_ID,value=$ACCOUNT_ID,type=PLAINTEXT}]" \
  --service-role $ROLE_ARN \
  --cache "type=LOCAL,modes=[LOCAL_CUSTOM_CACHE,LOCAL_DOCKER_LAYER_CACHE]"
```

Giải thích các lựa chọn quan trọng cho đề thi:
- `image=aws/codebuild/amazonlinux2-x86_64-standard:5.0` — **managed image** của AWS đã có Docker, AWS CLI, nhiều runtime. Có thể thay bằng custom image trên ECR/Docker Hub.
- `computeType=BUILD_GENERAL1_SMALL` — 3 GB RAM/2 vCPU. Các mức: SMALL → MEDIUM (7 GB) → LARGE (15 GB) → 2XLARGE (145 GB).
- `privilegedMode=true` — bắt buộc để chạy `docker build`.
- `cache type=LOCAL` (layer cache) nhanh nhưng không chia sẻ giữa các host; `type=S3` cache bền vững giữa các build trên host khác nhau (chậm hơn do tải lên/xuống S3).

### Bước 5: Chạy build và theo dõi

```bash
BUILD_ID=$(aws codebuild start-build --project-name dva-lab-build \
  --region $REGION --query 'build.id' --output text)
echo $BUILD_ID

# Poll trạng thái cho đến khi xong
aws codebuild batch-get-builds --ids $BUILD_ID --region $REGION \
  --query 'builds[0].{phase:currentPhase,status:buildStatus}'
```

Output mong đợi khi xong:

```json
{ "phase": "COMPLETED", "status": "SUCCEEDED" }
```

Các phase chạy theo thứ tự: `SUBMITTED → QUEUED → PROVISIONING → DOWNLOAD_SOURCE → INSTALL → PRE_BUILD → BUILD → POST_BUILD → UPLOAD_ARTIFACTS → FINALIZING → COMPLETED`. Nếu fail, xem `phaseStatus` của từng phase trong `batch-get-builds` để biết hỏng ở đâu. Xem log chi tiết trong CloudWatch Logs group `/aws/codebuild/dva-lab-build`.

Kiểm tra image đã lên ECR:

```bash
aws ecr list-images --repository-name dva-lab-app --region $REGION
```

Xem test report đã được tạo (CodeBuild tự tạo report group `dva-lab-build-unit-tests`):

```bash
aws codebuild list-reports --region $REGION
```

### Dọn dẹp tài nguyên

```bash
aws codebuild delete-project --name dva-lab-build --region $REGION
aws ecr delete-repository --repository-name dva-lab-app --force --region $REGION
aws ssm delete-parameter --name /dva-lab/stage --region $REGION
aws secretsmanager delete-secret --secret-id dva-lab-secret \
  --force-delete-without-recovery --region $REGION
aws s3 rb s3://dva-lab-src-$ACCOUNT_ID --force --region $REGION
# Nếu dùng CodeCommit:
aws codecommit delete-repository --repository-name dva-lab-repo --region $REGION
# Xoá log group và role
aws logs delete-log-group --log-group-name /aws/codebuild/dva-lab-build --region $REGION 2>/dev/null
for p in AmazonEC2ContainerRegistryPowerUser CloudWatchLogsFullAccess AmazonSSMReadOnlyAccess SecretsManagerReadWrite; do
  aws iam detach-role-policy --role-name dva-codebuild-role \
    --policy-arn arn:aws:iam::aws:policy/$p; done
aws iam delete-role --role-name dva-codebuild-role
```

Xoá report group qua console nếu còn (report group không phát sinh phí khi rỗng). Kiểm tra Billing sau 24h để chắc không còn build phát sinh.

## 💡 Exam Tips chương 40

- **`privileged-mode: true` là điều kiện BẮT BUỘC để build Docker image trong CodeBuild.** Câu hỏi "build báo lỗi không kết nối được Docker daemon" → bật privileged mode. Đây là bẫy cực phổ biến.
- **buildspec.yml mặc định nằm ở root của source.** Có thể đặt tên khác và chỉ định qua `buildspec` override khi tạo project, hoặc nhúng inline. Nếu để sai vị trí → `YAML file does not exist`.
- **Thứ tự phase cố định: install → pre_build → build → post_build.** `post_build` LUÔN chạy kể cả khi `build` fail (giống `finally`) — dùng để dọn dẹp/đẩy log. Đừng giả định post_build chỉ chạy khi build thành công.
- **Biến môi trường nhạy cảm KHÔNG để dạng PLAINTEXT.** Dùng `parameter-store` (SSM) hoặc `secrets-manager` trong khối `env` của buildspec, hoặc `type=PARAMETER_STORE`/`SECRETS_MANAGER` khi khai báo environment variable. Service role phải có quyền đọc tương ứng.
- **CodeBuild cache có 2 loại: LOCAL và S3.** LOCAL (gồm `LOCAL_DOCKER_LAYER_CACHE`, `LOCAL_SOURCE_CACHE`, `LOCAL_CUSTOM_CACHE`) nhanh nhưng gắn với host; S3 cache bền vững, chia sẻ giữa các build khác host. Đề hỏi "tăng tốc build bằng cách cache dependency" → cấu hình `cache` trong buildspec + project.
- **CodeBuild chạy trong VPC** khi cần truy cập resource private (RDS, ElastiCache). Cấu hình `vpcConfig` (VPC, subnets, security groups). Lưu ý: build trong VPC mất khả năng tự ra internet trừ khi có NAT Gateway.
- **Timeout mặc định build là 60 phút, tối đa 8 giờ (480 phút);** queued timeout mặc định 8 giờ. Build chạy quá timeout bị `TIMED_OUT`.
- **Test reports** khai trong khối `reports` của buildspec với `file-format` (JUNITXML, CUCUMBERJSON, TESTNGXML, TAP, VISUALSTUDIOTRX) hoặc `CODE_COVERAGE`. CodeBuild gom thành report group để xem pass/fail trên console.
- **CodeBuild trigger:** project có thể được khởi động bởi CodePipeline, EventBridge (theo lịch hoặc sự kiện), webhook (với GitHub/Bitbucket), hoặc `start-build` thủ công. CodeCommit không trigger trực tiếp CodeBuild — phải qua EventBridge hoặc CodePipeline.
- **CodeCommit auth:** ưu tiên HTTPS Git credentials (IAM-generated) hoặc git-remote-codecommit (GRC, ký SigV4); SSH cần upload public key vào IAM user. Không dùng access key trực tiếp cho git. AWS đã ngừng cho account MỚI tạo repo CodeCommit (từ 25/07/2024) — đề có thể hỏi về migration sang GitHub, nhưng khái niệm auth vẫn ra.
- **Service role vs đặc quyền build:** mọi quyền AWS mà các lệnh trong buildspec cần (ECR push, S3, DynamoDB...) đều lấy từ **service role của project**, không phải credentials của người chạy. Build báo `AccessDenied` → sửa service role.
- **Local build với CodeBuild agent** (Docker image `aws/codebuild/local-builds`) cho phép test buildspec ngay trên máy trước khi đẩy lên — tiết kiệm thời gian và tiền debug.

## Quiz chương 40 (10 câu)

**Câu 1.** A developer's CodeBuild project runs `docker build` to package an application image, but every build fails at the BUILD phase with `Cannot connect to the Docker daemon`. What is the fix?
- A. Increase the compute type to BUILD_GENERAL1_LARGE
- B. Enable privileged mode in the build environment
- C. Attach AmazonEC2ContainerRegistryFullAccess to the service role
- D. Add a `runtime-versions: docker: 19` entry in the install phase

**Câu 2.** Một buildspec cần truyền database password vào quá trình build mà không lộ trong log hay project config. Cách đúng nhất là gì?
- A. Khai biến với `type=PLAINTEXT` trong environment variables của project
- B. Hard-code password trong buildspec.yml
- C. Dùng khối `env.secrets-manager` trong buildspec và cấp quyền đọc cho service role
- D. Lưu password vào artifact rồi đọc lại ở phase build

**Câu 3.** Build của một project mất ~6 phút mỗi lần do tải lại toàn bộ `node_modules`. Developer muốn các build sau nhanh hơn với ít thay đổi nhất. Nên làm gì?
- A. Chuyển compute type lên 2XLARGE
- B. Cấu hình `cache` trong buildspec (paths node_modules) và bật cache cho project
- C. Chuyển sang custom Docker image đã cài sẵn dependency
- D. Tăng build timeout

**Câu 4.** A developer needs CodeBuild to access an Amazon RDS instance in a private subnet to run integration tests. Which configuration is required?
- A. Bật privileged mode
- B. Cấu hình VPC config (VPC, subnets, security groups) cho project
- C. Gán Elastic IP cho build container
- D. Dùng compute type 2XLARGE

**Câu 5.** Trong buildspec, phase nào LUÔN chạy ngay cả khi lệnh ở phase `build` trả về exit code khác 0?
- A. install
- B. pre_build
- C. post_build
- D. Không phase nào chạy nữa

**Câu 6.** Team muốn CodeBuild xuất kết quả unit test (JUnit XML) để xem tỉ lệ pass/fail trên console AWS. Cần khai phần nào trong buildspec?
- A. `artifacts`
- B. `cache`
- C. `reports` với `file-format: JUNITXML`
- D. `env.parameter-store`

**Câu 7.** Một account AWS tạo tháng 9/2024 không tạo được CodeCommit repository mới. Đâu là lý do và hướng đi đúng theo khuyến nghị hiện tại?
- A. Thiếu quyền IAM; gán AdministratorAccess
- B. CodeCommit không còn nhận account mới; dùng repo Git bên thứ ba (GitHub) làm source
- C. Region chưa hỗ trợ CodeCommit; đổi sang us-east-1
- D. Phải bật CodeCommit trong AWS Organizations

**Câu 8.** Developer push code lên CodeCommit qua HTTPS nhưng không muốn quản lý SSH key. Cơ chế xác thực nào phù hợp và an toàn nhất, tận dụng credentials AWS CLI sẵn có?
- A. Lưu access key/secret vào file `.netrc`
- B. git-remote-codecommit (GRC) ký request bằng SigV4
- C. Tạo IAM user dùng chung cho cả team
- D. Public bucket S3 chứa credentials

**Câu 9.** Muốn CodeBuild tự chạy mỗi khi có commit mới được merge vào nhánh `main` của một CodeCommit repo. Cách triển khai đúng?
- A. CodeCommit trigger gọi trực tiếp CodeBuild project
- B. Tạo EventBridge rule khớp sự kiện CodeCommit referenceUpdated, target là CodeBuild (hoặc qua CodePipeline)
- C. Cấu hình webhook GitHub trong CodeBuild
- D. Dùng cron trong buildspec

**Câu 10.** Trong buildspec, các lệnh `aws ecr ...` push image thành công khi chạy ở máy developer nhưng trong CodeBuild báo `AccessDenied`. Nguyên nhân nhiều khả năng nhất?
- A. Region cấu hình sai
- B. Service role của CodeBuild project thiếu quyền ECR
- C. privileged mode chưa bật
- D. buildspec đặt sai vị trí

### Đáp án & giải thích

**Câu 1 — Đáp án B.** Để chạy Docker daemon bên trong container build phải bật `privilegedMode=true`. A (compute lớn hơn) không liên quan tới daemon. C cấp quyền ECR — cần cho push nhưng không giải lỗi daemon. D sai vì managed image đã có Docker; không khai runtime docker kiểu đó.

**Câu 2 — Đáp án C.** `env.secrets-manager` để CodeBuild lấy secret lúc build mà không in giá trị ra log (CodeBuild che secret trong log), service role phải có quyền đọc. A để PLAINTEXT lộ trong project config. B hard-code lộ trong source. D lưu vào artifact càng lộ rộng hơn.

**Câu 3 — Đáp án B.** Cache dependency (`cache` trong buildspec + bật cache project, LOCAL_CUSTOM_CACHE hoặc S3) là cách ít thay đổi và đúng mục tiêu. A tốn tiền không giải gốc vấn đề tải lại. C (custom image) hiệu quả nhưng thay đổi nhiều hơn và phải bảo trì image. D không làm build nhanh hơn.

**Câu 4 — Đáp án B.** Truy cập resource trong private subnet yêu cầu cấu hình VPC config cho project (VPC + subnets + security group cho phép tới RDS). A là cho Docker. C container build không gán EIP. D không liên quan kết nối mạng.

**Câu 5 — Đáp án C.** `post_build` chạy như khối `finally` — luôn thực thi kể cả `build` fail, dùng để đẩy log/dọn dẹp. install và pre_build chạy trước build nên không phải đáp án về "chạy sau khi build fail". D sai.

**Câu 6 — Đáp án C.** Khối `reports` với `file-format: JUNITXML` (hoặc TAP/TESTNGXML/CUCUMBERJSON/VISUALSTUDIOTRX) tạo report group hiển thị pass/fail. A artifacts chỉ là output file. B cache không liên quan test. D đọc tham số, không phải report.

**Câu 7 — Đáp án B.** Từ 25/07/2024 AWS ngừng cấp CodeCommit cho account mới; account hiện hữu vẫn dùng được. Hướng khuyến nghị là dùng GitHub/Git bên thứ ba làm source (CodeBuild/CodePipeline kết nối qua CodeStar/CodeConnections). A/C/D không phải nguyên nhân — không phải lỗi quyền, region hay Organizations.

**Câu 8 — Đáp án B.** GRC ký request HTTPS bằng SigV4 từ credentials AWS CLI, không cần SSH key hay Git credentials riêng — an toàn và tiện. A lưu key vào .netrc là chống chỉ định bảo mật. C dùng chung user vi phạm least privilege. D hoàn toàn sai về bảo mật.

**Câu 9 — Đáp án B.** CodeCommit phát sự kiện qua EventBridge (`CodeCommit Repository State Change`, `referenceUpdated`), rule target là CodeBuild hoặc CodePipeline. A sai vì CodeCommit "triggers" chỉ gọi được SNS/Lambda, KHÔNG gọi trực tiếp CodeBuild. C dành cho GitHub. D cron không phản ứng theo commit.

**Câu 10 — Đáp án B.** Trong CodeBuild mọi gọi AWS đều dùng **service role** của project, không phải credentials của developer; thiếu quyền ECR → AccessDenied. A region thường gây lỗi khác (repo not found). C privileged mode gây lỗi daemon, không phải AccessDenied. D sai vị trí buildspec báo lỗi YAML/source, không phải AccessDenied khi push.

## Tóm tắt chương

- **CI/CD** gồm continuous integration (merge + build + test tự động), continuous delivery (sẵn sàng deploy, có approval) và continuous deployment (tự deploy tới production). CodeCommit + CodeBuild lo phần source và build trong chuỗi này.
- **CodeCommit** là Git repo managed; auth qua HTTPS Git credentials (IAM), SSH key, hoặc git-remote-codecommit (GRC, SigV4). AWS đã ngừng cấp cho account mới (25/07/2024) nhưng kiến thức vẫn nằm trong đề DVA-C02.
- **CodeCommit triggers** chỉ gọi được SNS và Lambda; để chạy CodeBuild phải đi qua EventBridge hoặc CodePipeline.
- **CodeBuild** chạy build trong container ephemeral với managed image hoặc custom image; mọi quyền AWS lấy từ **service role** của project.
- **buildspec.yml** ở root source, phiên bản `0.2`, các phase theo thứ tự install → pre_build → build → post_build; `post_build` luôn chạy như `finally`.
- Inject cấu hình qua `env.variables` (tĩnh), `env.parameter-store` (SSM) và `env.secrets-manager` (Secrets Manager) — không hard-code secret, không để PLAINTEXT cho dữ liệu nhạy cảm.
- **privileged-mode: true** bắt buộc khi build Docker image; quên bật là lỗi "Cannot connect to the Docker daemon" kinh điển.
- **Cache**: LOCAL (Docker layer/source/custom — nhanh, gắn host) và S3 (bền vững, chia sẻ giữa host) giúp tăng tốc build.
- **Compute types** từ BUILD_GENERAL1_SMALL (3 GB) đến 2XLARGE (145 GB); timeout build mặc định 60 phút, tối đa 8 giờ.
- **Test reports** khai trong khối `reports` với các định dạng JUNITXML/TAP/TESTNGXML/CUCUMBERJSON/VISUALSTUDIOTRX hoặc CODE_COVERAGE để xem kết quả trên console.
- **CodeBuild trong VPC** cho phép truy cập resource private (RDS, ElastiCache) qua `vpcConfig`; cần NAT Gateway nếu vẫn muốn ra internet.
- Luồng điển hình: CodeCommit/GitHub → CodeBuild build & push image lên ECR → bàn giao cho CodeDeploy (Chương 41) trong một pipeline (Chương 42).
