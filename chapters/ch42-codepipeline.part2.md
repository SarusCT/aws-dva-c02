## Hands-on Lab: Dựng pipeline 3 stage Source → Build → Deploy bằng CLI, thêm manual approval + SNS, dùng CodeArtifact làm npm proxy

**Mục tiêu lab:** Tự tay tạo một CodePipeline hoàn chỉnh cho một ứng dụng Node.js nhỏ: lấy source từ S3 (đóng vai trò source artifact), build bằng CodeBuild có kéo dependency qua CodeArtifact, chèn một stage **manual approval** gắn SNS để gửi email duyệt, rồi deploy artifact ra một bucket S3 đích. Bạn sẽ thấy rõ cách artifact đi qua từng stage qua S3 artifact store, cách pipeline tự chạy lại khi source thay đổi (EventBridge), và cách dọn sạch để khỏi tốn tiền.

**Chuẩn bị:**
- AWS CLI v2 đã cấu hình (`aws sts get-caller-identity` chạy được). Region dùng `ap-southeast-1`.
- IAM principal có quyền tạo IAM role, S3, CodePipeline, CodeBuild, CodeArtifact, SNS.
- `jq`, `zip`, và Node.js cài sẵn (để test buildspec cục bộ nếu muốn).
- Thư mục làm việc: `mkdir -p ~/cp-lab && cd ~/cp-lab`. Đặt biến chung:

```bash
export AWS_REGION=ap-southeast-1
export ACCT=$(aws sts get-caller-identity --query Account --output text)
export SUFFIX=$RANDOM
export SRC_BUCKET=cp-src-$ACCT-$SUFFIX
export ART_BUCKET=cp-artifacts-$ACCT-$SUFFIX     # artifact store của pipeline
export DEPLOY_BUCKET=cp-deploy-$ACCT-$SUFFIX     # bucket đích của stage Deploy
```

### Bước 1: Tạo các S3 bucket

CodePipeline **bắt buộc** có một artifact store (mặc định là S3) để truyền output của stage này thành input của stage sau. Bật versioning cho source bucket — đây là điều kiện để dùng S3 làm source action có trigger tự động.

```bash
for B in $SRC_BUCKET $ART_BUCKET $DEPLOY_BUCKET; do
  aws s3api create-bucket --bucket $B --region $AWS_REGION \
    --create-bucket-configuration LocationConstraint=$AWS_REGION
done
aws s3api put-bucket-versioning --bucket $SRC_BUCKET \
  --versioning-configuration Status=Enabled
```

### Bước 2: Tạo CodeArtifact domain + repository (npm proxy)

CodeArtifact là package manager được quản lý. Ta tạo một domain và một repository có **upstream** là npmjs để build kéo package qua proxy (kiểm soát được package, cache lại, audit).

```bash
aws codeartifact create-domain --domain cp-domain
aws codeartifact create-repository --domain cp-domain --repository app-repo \
  --description "npm proxy cho lab"
# Gắn upstream public npm
aws codeartifact associate-external-connection --domain cp-domain \
  --repository app-repo --external-connection public:npmjs
```

**Output mong đợi:** JSON mô tả repository với `externalConnections` chứa `public:npmjs`, trạng thái `AVAILABLE`.

### Bước 3: Chuẩn bị source code + buildspec, nén và upload

Tạo ứng dụng tối giản:

```bash
cat > app.js <<'EOF'
const lodash = require("lodash");
console.log("Build OK:", lodash.capitalize("hello pipeline"));
EOF

cat > package.json <<'EOF'
{ "name": "cp-app", "version": "1.0.0", "dependencies": { "lodash": "^4.17.21" } }
EOF
```

Viết `buildspec.yml`. Phase `pre_build` đăng nhập CodeArtifact (lệnh `login` ghi token vào `.npmrc`), `build` cài dependency và chạy app, `artifacts` đóng gói output:

```yaml
version: 0.2
phases:
  pre_build:
    commands:
      - aws codeartifact login --tool npm --domain cp-domain --repository app-repo
  build:
    commands:
      - npm install
      - node app.js
      - echo "Deployed at $(date)" > deployed.txt
artifacts:
  files:
    - app.js
    - deployed.txt
```

Nén toàn bộ thành source artifact và upload:

```bash
zip source.zip app.js package.json buildspec.yml
aws s3 cp source.zip s3://$SRC_BUCKET/source.zip
```

### Bước 4: Tạo IAM role cho CodeBuild và CodePipeline

CodeBuild cần role để đọc artifact, ghi log, và đọc CodeArtifact. CodePipeline cần role để điều phối các action. Tạo trust policy chung rồi gắn policy.

```bash
cat > cb-trust.json <<'EOF'
{ "Version":"2012-10-17","Statement":[{"Effect":"Allow",
 "Principal":{"Service":"codebuild.amazonaws.com"},"Action":"sts:AssumeRole"}]}
EOF
aws iam create-role --role-name cp-build-role \
  --assume-role-policy-document file://cb-trust.json
aws iam attach-role-policy --role-name cp-build-role \
  --policy-arn arn:aws:iam::aws:policy/AdministratorAccess   # CHỈ cho lab; production dùng least-privilege

cat > pl-trust.json <<'EOF'
{ "Version":"2012-10-17","Statement":[{"Effect":"Allow",
 "Principal":{"Service":"codepipeline.amazonaws.com"},"Action":"sts:AssumeRole"}]}
EOF
aws iam create-role --role-name cp-pipeline-role \
  --assume-role-policy-document file://pl-trust.json
aws iam attach-role-policy --role-name cp-pipeline-role \
  --policy-arn arn:aws:iam::aws:policy/AdministratorAccess
```

> Trong production tuyệt đối KHÔNG dùng `AdministratorAccess`. CodeBuild chỉ cần `s3:GetObject/PutObject` trên artifact bucket, `logs:*` cho log group, và `codeartifact:GetAuthorizationToken` + `sts:GetServiceBearerToken`. Đây là điểm hay bị hỏi: muốn build đọc CodeArtifact phải có cả `sts:GetServiceBearerToken`.

### Bước 5: Tạo CodeBuild project

```bash
cat > cb-project.json <<EOF
{
  "name": "cp-build",
  "source": { "type": "CODEPIPELINE" },
  "artifacts": { "type": "CODEPIPELINE" },
  "environment": {
    "type": "LINUX_CONTAINER",
    "image": "aws/codebuild/amazonlinux2-x86_64-standard:5.0",
    "computeType": "BUILD_GENERAL1_SMALL"
  },
  "serviceRole": "arn:aws:iam::$ACCT:role/cp-build-role"
}
EOF
aws codebuild create-project --cli-input-json file://cb-project.json
```

Lưu ý `source.type` và `artifacts.type` đều là `CODEPIPELINE` — nghĩa là input/output của build do pipeline cấp, không phải tự CodeBuild lấy source.

### Bước 6: Tạo SNS topic cho manual approval

```bash
export TOPIC_ARN=$(aws sns create-topic --name cp-approval --query TopicArn --output text)
aws sns subscribe --topic-arn $TOPIC_ARN --protocol email \
  --notification-endpoint duntt232@gmail.com
# Vào email bấm Confirm subscription trước khi chạy pipeline
```

### Bước 7: Định nghĩa pipeline (4 stage) và tạo

```bash
cat > pipeline.json <<EOF
{
 "pipeline": {
  "name": "cp-lab-pipeline",
  "roleArn": "arn:aws:iam::$ACCT:role/cp-pipeline-role",
  "artifactStore": { "type": "S3", "location": "$ART_BUCKET" },
  "stages": [
   { "name": "Source", "actions": [{
      "name": "SourceAction",
      "actionTypeId": {"category":"Source","owner":"AWS","provider":"S3","version":"1"},
      "configuration": {"S3Bucket":"$SRC_BUCKET","S3ObjectKey":"source.zip","PollForSourceChanges":"false"},
      "outputArtifacts": [{"name":"SourceOutput"}]
   }]},
   { "name": "Build", "actions": [{
      "name": "BuildAction",
      "actionTypeId": {"category":"Build","owner":"AWS","provider":"CodeBuild","version":"1"},
      "configuration": {"ProjectName":"cp-build"},
      "inputArtifacts": [{"name":"SourceOutput"}],
      "outputArtifacts": [{"name":"BuildOutput"}]
   }]},
   { "name": "Approval", "actions": [{
      "name": "ManualApproval",
      "actionTypeId": {"category":"Approval","owner":"AWS","provider":"Manual","version":"1"},
      "configuration": {"NotificationArn":"$TOPIC_ARN","CustomData":"Duyet deploy ban moi?"}
   }]},
   { "name": "Deploy", "actions": [{
      "name": "DeployToS3",
      "actionTypeId": {"category":"Deploy","owner":"AWS","provider":"S3","version":"1"},
      "configuration": {"BucketName":"$DEPLOY_BUCKET","Extract":"true"},
      "inputArtifacts": [{"name":"BuildOutput"}]
   }]}
  ]
 }
}
EOF
aws codepipeline create-pipeline --cli-input-json file://pipeline.json
```

Khi `create-pipeline` xong, pipeline **tự chạy lần đầu**. Đặt `PollForSourceChanges:false` vì với S3 source nên dùng EventBridge trigger thay vì polling — nhưng để EventBridge bắt được thay đổi, bạn cần bật CloudTrail data events trên bucket hoặc dùng quy tắc EventBridge. Trong lab này ta cứ kích thủ công ở Bước 9.

### Bước 8: Theo dõi pipeline tới stage Approval

```bash
aws codepipeline get-pipeline-state --name cp-lab-pipeline \
  --query "stageStates[].{Stage:stageName,Status:latestExecution.status}" --output table
```

**Output mong đợi:** Source `Succeeded`, Build `Succeeded`, Approval `InProgress`. Bạn nhận email từ SNS với link mở console để duyệt. Duyệt bằng CLI cũng được — cần `token` lấy từ state:

```bash
TOKEN=$(aws codepipeline get-pipeline-state --name cp-lab-pipeline \
  --query "stageStates[?stageName=='Approval'].actionStates[0].latestExecution.token" --output text)
aws codepipeline put-approval-result --pipeline-name cp-lab-pipeline \
  --stage-name Approval --action-name ManualApproval \
  --result summary="OK lab",status=Approved --token $TOKEN
```

Sau khi approve, stage Deploy chạy. Kiểm tra bucket đích:

```bash
aws s3 ls s3://$DEPLOY_BUCKET/    # thấy app.js và deployed.txt do Extract:true giải nén
```

### Bước 9: Kích pipeline chạy lại

Sửa code, nén lại, upload đè — rồi start execution thủ công:

```bash
echo 'console.log("v2");' >> app.js
zip source.zip app.js package.json buildspec.yml
aws s3 cp source.zip s3://$SRC_BUCKET/source.zip
aws codepipeline start-pipeline-execution --name cp-lab-pipeline
```

Quan sát artifact mới được tạo trong `$ART_BUCKET` dưới một thư mục execution-id riêng — mỗi lần chạy là một bộ artifact riêng, immutable.

### Dọn dẹp tài nguyên

```bash
aws codepipeline delete-pipeline --name cp-lab-pipeline
aws codebuild delete-project --name cp-build
aws sns delete-topic --topic-arn $TOPIC_ARN
aws codeartifact delete-repository --domain cp-domain --repository app-repo
aws codeartifact delete-domain --domain cp-domain
for B in $SRC_BUCKET $ART_BUCKET $DEPLOY_BUCKET; do
  aws s3 rm s3://$B --recursive
  aws s3api delete-bucket --bucket $B
done
for R in cp-build-role cp-pipeline-role; do
  aws iam detach-role-policy --role-name $R \
    --policy-arn arn:aws:iam::aws:policy/AdministratorAccess
  aws iam delete-role --role-name $R
done
```

Kiểm tra `aws codepipeline list-pipelines` không còn `cp-lab-pipeline`, và S3 bucket đã biến mất. CodePipeline tính phí theo pipeline active/tháng (V1) nên xoá là quan trọng.

## 💡 Exam Tips chương 42

- CodePipeline truyền dữ liệu giữa các stage qua **artifacts lưu trên S3** (artifact store). Output của một action là input của action sau qua tên artifact. Nếu artifact bucket bị mã hoá KMS, role của pipeline/build phải có quyền `kms:Decrypt` — lỗi "access denied" giữa các stage thường do thiếu quyền KMS này.
- Để tích hợp **GitHub/Bitbucket**, dùng **CodeConnections** (trước là CodeStar Connections) chứ không nhúng OAuth token. Đây là cách AWS khuyến nghị cho source bên ngoài.
- Trigger source: với GitHub/CodeConnections và S3 nên dùng **webhook/EventBridge** (gần như tức thì) thay vì **polling** (chậm, tốn API). Polling là mặc định cũ; muốn tắt thì đặt `PollForSourceChanges:false`.
- **Manual approval action** không cần output artifact. Gắn `NotificationArn` (SNS) để báo người duyệt; phê duyệt cần quyền `codepipeline:PutApprovalResult`. Approval treo sẽ timeout sau **7 ngày**.
- **Cross-region action**: pipeline có thể có action ở region khác, nhưng AWS yêu cầu mỗi region đó có **một artifact bucket riêng** (artifact được copy sang). Cross-account action thì action dùng **role ở account kia**.
- Deploy serverless: action provider **CloudFormation** với `ChangeSet` (CreateChangeSet → ExecuteChangeSet) là cách chuẩn deploy SAM/CFN; cần `capabilities` CAPABILITY_IAM/AUTO_EXPAND.
- **CodeArtifact**: `aws codeartifact login` lấy token (hết hạn mặc định 12 giờ, tối đa cấu hình được). Build kéo package cần `codeartifact:GetAuthorizationToken` + `sts:GetServiceBearerToken` + quyền đọc repo. **Upstream** cho phép chuỗi repo proxy npmjs/PyPI/Maven.
- **CodeGuru Reviewer** = phân tích tĩnh source (security/quality) tích hợp pull request; **CodeGuru Profiler** = phân tích runtime (CPU/heap) trên app đang chạy. Đừng lẫn: Reviewer cho code review, Profiler cho hiệu năng production.
- Một **stage** có thể chứa nhiều **action chạy song song** (cùng `runOrder`) hoặc tuần tự (runOrder tăng dần). Pipeline fail ở một stage thì các stage sau không chạy.
- Pipeline **type V2** tính phí theo phút thực thi (action-minutes) + có tham số pipeline-level; **V1** tính theo pipeline active/tháng. Đề mới có thể hỏi mô hình giá V2.
- **EventBridge** là cách bắt sự kiện pipeline (state change) để báo Slack/Lambda; còn **CloudWatch** xem metrics. CodePipeline tự phát event khi stage/action đổi trạng thái.
- **CodeCatalyst** là nền tảng DevOps hợp nhất (project, source, CI/CD, issue) — chỉ cần nhận diện ở mức "thay thế CodeStar". CodeStar (cũ) đã bị deprecate.

## Quiz chương 42 (10 câu)

**Câu 1.** Một developer cần pipeline lấy source từ một repo GitHub. Cách AWS khuyến nghị để CodePipeline kết nối GitHub là gì?
- A. Lưu personal access token GitHub trong stage configuration
- B. Dùng CodeConnections (CodeStar Connections) làm source action
- C. Mirror repo sang CodeCommit rồi dùng làm source
- D. Cài CodeDeploy agent lên GitHub runner

**Câu 2.** Pipeline có artifact bucket được mã hoá bằng customer managed KMS key. Stage Build báo lỗi không đọc được input artifact dù IAM policy cho phép S3. Nguyên nhân khả dĩ nhất?
- A. CodeBuild không hỗ trợ artifact mã hoá
- B. Role của CodeBuild thiếu quyền kms:Decrypt trên key đó
- C. Artifact bucket phải nằm ở region khác
- D. Phải bật versioning trên artifact bucket

**Câu 3.** Một developer muốn người quản lý duyệt trước khi deploy production. Cấu hình nào đúng?
- A. Thêm một action category Approval, provider Manual, gắn NotificationArn là một SNS topic
- B. Thêm một Lambda invoke action chặn pipeline
- C. Dùng deployment policy "manual" trong CodeDeploy
- D. Bật MFA trên pipeline role

**Câu 4.** Tổ chức cần các team kéo npm package qua một proxy được quản lý, có cache và audit, đồng thời chặn package không hợp lệ. Dịch vụ nào?
- A. CodeBuild cache
- B. CodeArtifact với upstream public:npmjs
- C. ECR
- D. S3 làm npm registry

**Câu 5.** Pipeline cần deploy một SAM application (Lambda + API Gateway). Cách deploy chuẩn trong stage Deploy?
- A. S3 deploy action với Extract=true
- B. CodeDeploy EC2 in-place
- C. CloudFormation action dùng CreateChangeSet rồi ExecuteChangeSet với capability CAPABILITY_IAM
- D. ECS deploy action

**Câu 6.** Source là một bucket S3. Developer muốn pipeline tự chạy ngay khi object mới được upload, độ trễ thấp, không polling. Cách nào?
- A. Để PollForSourceChanges=true
- B. Dùng EventBridge rule trigger pipeline (cần CloudTrail data events trên bucket)
- C. Tạo cron Lambda gọi start-pipeline-execution mỗi phút
- D. Bật S3 Transfer Acceleration

**Câu 7.** Một action trong pipeline cần chạy ở region us-east-1 trong khi pipeline ở ap-southeast-1. Yêu cầu bắt buộc là gì?
- A. Không thể — pipeline chỉ một region
- B. Phải có artifact bucket riêng tại us-east-1 để pipeline copy artifact sang
- C. Phải tạo pipeline thứ hai ở us-east-1
- D. Phải bật cross-region replication trên artifact bucket

**Câu 8.** Team muốn tự động review chất lượng và bảo mật của code trong pull request, đề xuất sửa. Dịch vụ?
- A. CodeGuru Profiler
- B. CodeGuru Reviewer
- C. X-Ray
- D. CodeBuild reports

**Câu 9.** Trong một stage có 3 action cùng giá trị runOrder = 1. Điều gì xảy ra?
- A. Báo lỗi cấu hình trùng runOrder
- B. Ba action chạy song song
- C. Chạy tuần tự theo thứ tự khai báo
- D. Chỉ action đầu tiên chạy

**Câu 10.** Một developer cần nhận thông báo Slack mỗi khi bất kỳ stage nào của pipeline FAILED. Cách ít overhead nhất?
- A. Polling get-pipeline-state bằng cron
- B. EventBridge rule khớp event "CodePipeline Stage Execution State Change" (state FAILED) → target SNS/Lambda → Slack
- C. Đọc CloudTrail mỗi 5 phút
- D. Bật detailed monitoring CloudWatch

### Đáp án & giải thích

**Câu 1 — Đáp án B.** CodeConnections (tên cũ CodeStar Connections) là cơ chế chính thức để kết nối GitHub/Bitbucket/GitLab an toàn qua OAuth được AWS quản lý. A nhúng token thủ công — không khuyến nghị, dễ lộ. C tốn công và CodeCommit không còn nhận khách hàng mới. D vô nghĩa — CodeDeploy agent không liên quan source.

**Câu 2 — Đáp án B.** Khi artifact store mã hoá bằng customer managed KMS key, mọi role đọc/ghi artifact (CodeBuild, CodeDeploy, pipeline role) phải có `kms:Decrypt`/`kms:GenerateDataKey` trên key đó, và key policy phải cho phép. A sai — hỗ trợ tốt. C sai — không bắt buộc khác region. D sai — versioning không liên quan lỗi giải mã.

**Câu 3 — Đáp án A.** Manual approval là một action category Approval / provider Manual; `NotificationArn` trỏ tới SNS để báo người duyệt. B Lambda invoke không phải cơ chế approval chuẩn. C "manual" không phải deployment policy của CodeDeploy. D MFA không phải cơ chế chặn stage.

**Câu 4 — Đáp án B.** CodeArtifact là package repository được quản lý, có **upstream** proxy tới npmjs/PyPI/Maven, cache lại artifact và cho audit/kiểm soát. A chỉ cache build cục bộ. C ECR cho Docker image, không cho npm. D S3 không phải npm registry hợp chuẩn.

**Câu 5 — Đáp án C.** Deploy CFN/SAM trong pipeline dùng provider CloudFormation theo mẫu CreateChangeSet → (Approval tuỳ chọn) → ExecuteChangeSet, kèm capability CAPABILITY_IAM/CAPABILITY_AUTO_EXPAND cho SAM. A chỉ copy file ra S3, không tạo resource. B/D sai target — SAM không deploy bằng CodeDeploy EC2 hay ECS action trực tiếp ở đây.

**Câu 6 — Đáp án B.** Với S3 source, trigger gần real-time dùng EventBridge; để EventBridge nhận sự kiện "object created" cần bật CloudTrail data events (hoặc EventBridge notification trên bucket). A polling chậm và tốn. C cron Lambda chạy lãng phí, độ trễ tới 1 phút. D không liên quan trigger.

**Câu 7 — Đáp án B.** Cross-region action cần một artifact bucket ở mỗi region phụ; CodePipeline copy artifact sang đó để action region kia đọc. A sai — pipeline hỗ trợ cross-region action. C không bắt buộc tạo pipeline mới. D replication không phải cơ chế CodePipeline dùng.

**Câu 8 — Đáp án B.** CodeGuru Reviewer phân tích tĩnh source code (bảo mật, chất lượng) và đề xuất ngay trong pull request. A Profiler là phân tích runtime hiệu năng. C X-Ray là tracing. D CodeBuild reports là kết quả test/coverage, không phải review code.

**Câu 9 — Đáp án B.** Các action cùng `runOrder` trong một stage chạy song song; runOrder tăng dần thì chạy tuần tự. A sai — trùng runOrder hợp lệ. C/D mô tả sai hành vi.

**Câu 10 — Đáp án B.** CodePipeline phát event lên EventBridge khi đổi trạng thái stage/action; tạo rule khớp detail-type "CodePipeline Stage Execution State Change" với state FAILED rồi đẩy tới SNS/Lambda/Slack là cách event-driven, ít overhead nhất. A/C polling tốn và trễ. D detailed monitoring không tạo thông báo.

## Tóm tắt chương

- CodePipeline điều phối CI/CD qua các **stage** (Source/Build/Test/Deploy/Approval/Invoke), mỗi stage gồm một hoặc nhiều **action**; cùng runOrder thì song song, khác runOrder thì tuần tự.
- Dữ liệu chảy giữa stage bằng **artifacts trên S3 artifact store**; output action này là input action sau qua tên artifact, mỗi lần execution là một bộ artifact immutable riêng.
- Source providers gồm S3, ECR, CodeCommit, và GitHub/Bitbucket/GitLab qua **CodeConnections**; trigger nên dùng **webhook/EventBridge** thay vì polling để gần real-time.
- **Manual approval** là action provider Manual, gắn SNS để báo, treo tối đa 7 ngày, duyệt cần quyền PutApprovalResult; không có output artifact.
- **Cross-region** action cần artifact bucket riêng ở mỗi region; **cross-account** action dùng role ở account đích.
- Deploy serverless (SAM/CFN) qua action **CloudFormation** với CreateChangeSet/ExecuteChangeSet và capabilities phù hợp; deploy ECS/Lambda/EC2 qua action CodeDeploy hoặc ECS (chi tiết ở Chương 41).
- Lỗi access giữa stage khi artifact bucket mã hoá KMS thường do role thiếu `kms:Decrypt` — luôn kiểm tra cả IAM policy lẫn key policy.
- **CodeArtifact**: domain + repository, upstream proxy npmjs/PyPI/Maven, login lấy token (mặc định 12 giờ); build cần `codeartifact:GetAuthorizationToken` + `sts:GetServiceBearerToken`.
- **CodeGuru Reviewer** review code tĩnh trong PR; **CodeGuru Profiler** phân tích hiệu năng runtime — không lẫn vai trò.
- **CodeStar** đã deprecate; **CodeCatalyst** là nền tảng DevOps hợp nhất (nhận diện mức tổng quan).
- Quan sát pipeline qua **EventBridge** (state change events → SNS/Lambda/Slack) và CloudWatch metrics; giá V2 tính theo action-minutes, V1 theo pipeline active/tháng.
- Luôn cấp **least-privilege** cho role pipeline/build trong production và **dọn dẹp** pipeline + bucket sau khi thử nghiệm để tránh chi phí.
