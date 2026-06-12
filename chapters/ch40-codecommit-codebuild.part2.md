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
