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
