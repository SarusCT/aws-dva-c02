# Chương 42: CodePipeline & các công cụ CI/CD khác

> **Trọng tâm DVA-C02:** CodePipeline là "nhạc trưởng" gắn kết toàn bộ chuỗi CI/CD trên AWS — đề thi rất hay hỏi về cấu trúc stage/action, cách artifact đi qua S3, cơ chế trigger (EventBridge vs webhook vs polling), manual approval kèm SNS, cross-region/cross-account, và pipeline cho serverless (CloudFormation/SAM deploy action). Ngoài ra thường gặp câu hỏi nhận diện vai trò của CodeArtifact (proxy package), CodeGuru (review & profiler), CodeStar Connections (kết nối GitHub) và CodeCatalyst. Dạng câu hỏi điển hình: "A developer needs to orchestrate build → test → deploy with a manual approval and notify a team..." — bạn phải chọn đúng kết hợp dịch vụ và cách cấu hình.

## Mục tiêu chương
- Hiểu mô hình **stage → action → artifact** của CodePipeline và cách dữ liệu chảy qua S3 artifact store.
- Phân biệt 3 cơ chế trigger source (EventBridge, webhook, polling) và biết khi nào dùng cái nào.
- Cấu hình **manual approval** kèm thông báo SNS và cổng phê duyệt giữa các stage.
- Thiết kế pipeline **cross-region** và **cross-account** đúng cách (artifact bucket + KMS key + role).
- Xây pipeline deploy serverless dùng action **CloudFormation/SAM** và pipeline container CodeBuild → ECS/Lambda.
- Nhận diện vai trò **CodeArtifact**, **CodeGuru (Reviewer & Profiler)**, **CodeStar Connections**, **CodeCatalyst** trong hệ sinh thái CI/CD AWS.

## 42.1 CodePipeline: kiến trúc stage → action → artifact

CodePipeline là dịch vụ **orchestration** (điều phối) cho continuous delivery. Bản thân nó KHÔNG build code, KHÔNG deploy code — nó chỉ định nghĩa thứ tự các bước và gọi các dịch vụ khác (CodeBuild để build, CodeDeploy/CloudFormation/ECS để deploy) thực thi từng bước. Hãy nghĩ về nó như một state machine có hướng: định nghĩa luồng, chuyển trạng thái, truyền dữ liệu.

Cấu trúc phân cấp gồm 3 tầng:

- **Pipeline**: toàn bộ workflow CI/CD cho một ứng dụng.
- **Stage**: một nhóm logic các bước (ví dụ: `Source`, `Build`, `Staging`, `Production`). Pipeline tối thiểu phải có **2 stage**, stage đầu tiên bắt buộc là stage chứa source action. Mỗi stage có tên duy nhất trong pipeline.
- **Action**: một tác vụ cụ thể trong stage. Action có **6 category**: `Source`, `Build`, `Test`, `Deploy`, `Approval`, `Invoke`.

Trong một stage, các action chạy **tuần tự (sequential)** hoặc **song song (parallel)** tùy vào thuộc tính `runOrder`. Action cùng `runOrder` chạy song song; `runOrder` nhỏ chạy trước. Đây là điểm hay nhầm: nhiều action trong một stage không mặc định là song song — bạn điều khiển bằng `runOrder`.

Cơ chế **artifact** là cốt lõi cần hiểu cho đề thi. Mỗi action có thể có **input artifacts** và **output artifacts**. Khi pipeline chạy, CodePipeline lưu output artifact của action này vào một **S3 bucket** (gọi là artifact store), rồi truyền tên artifact đó làm input cho action sau. Ví dụ: Source action xuất `SourceArtifact` (mã nguồn nén .zip), Build action nhận `SourceArtifact` làm input và xuất `BuildArtifact` (đã build), Deploy action nhận `BuildArtifact`.

Vài quy tắc quan trọng về artifact mà đề hay gài:

- Artifact store là một **S3 bucket** do CodePipeline tạo (hoặc bạn chỉ định). Mỗi region trong pipeline cần **một bucket riêng**.
- Artifact luôn được **mã hóa** trong bucket — mặc định dùng AWS managed KMS key; cross-account thì bắt buộc dùng **customer managed KMS key**.
- Tên input artifact của một action phải khớp tên output artifact mà một action TRƯỚC ĐÓ đã tạo. Không khớp tên là một lỗi cấu hình kinh điển.

```bash
# Xem cấu trúc một pipeline đang chạy
aws codepipeline get-pipeline --name my-app-pipeline

# Khởi động thủ công một lần chạy pipeline (không cần thay đổi source)
aws codepipeline start-pipeline-execution --name my-app-pipeline

# Xem trạng thái stage/action gần nhất
aws codepipeline get-pipeline-state --name my-app-pipeline
```

> 💡 **Exam Tip:** CodePipeline tự bản thân không build cũng không deploy — nó **điều phối**. Khi câu hỏi mô tả "cần build code" hãy nghĩ CodeBuild, "cần deploy" hãy nghĩ CodeDeploy/CloudFormation/ECS, còn CodePipeline là thứ "nối chúng lại theo thứ tự, có cổng phê duyệt".

## 42.2 Action providers: source, build, test, deploy, approval, invoke

Mỗi action category có nhiều **provider** (nhà cung cấp action). Bạn cần thuộc các provider phổ biến vì đề hay hỏi "dịch vụ nào đặt ở stage nào".

**Source actions** (lấy mã nguồn / artifact đầu vào):
- **AWS CodeCommit** — repo Git của AWS (chi tiết ở Chương 40). Trigger qua EventBridge.
- **GitHub / GitHub Enterprise / Bitbucket / GitLab** — qua **CodeStar Connections** (xem 42.5).
- **Amazon S3** — lấy file/zip từ bucket (versioning bắt buộc bật). Trigger qua EventBridge khi object thay đổi.
- **Amazon ECR** — kích hoạt khi có image mới push lên repository (dùng cho pipeline deploy container).

**Build/Test actions**:
- **AWS CodeBuild** — provider chính cho cả build và test, dùng `buildspec.yml` (chi tiết ở Chương 40). CodeBuild có thể vừa build vừa chạy test và xuất test reports.
- **Jenkins** — provider build/test bên thứ ba.

**Deploy actions** (đây là phần đề thi tập trung nhiều):
- **AWS CodeDeploy** — deploy lên EC2/on-prem, Lambda, ECS (chi tiết ở Chương 41).
- **AWS CloudFormation** — tạo/cập nhật stack; nền tảng cho deploy serverless/SAM (xem 42.7).
- **Amazon ECS** — ECS standard deploy (rolling) hoặc **ECS (Blue/Green)** thông qua CodeDeploy.
- **AWS Elastic Beanstalk** — deploy lên môi trường EB.
- **AWS Service Catalog**, **Amazon S3** (deploy static website), **AWS AppConfig**.

**Approval action**: chỉ có một provider — **Manual approval** (xem 42.4).

**Invoke action**:
- **AWS Lambda** — gọi một hàm Lambda để chạy logic tùy ý (integration test, smoke test, gọi API ngoài, gắn cổng kiểm tra tùy biến). Hàm phải gọi `PutJobSuccessResult` hoặc `PutJobFailureResult` để báo kết quả về pipeline.
- **AWS Step Functions** — chạy một state machine như một action.

```javascript
// Lambda invoke action: phải báo kết quả về CodePipeline, nếu không pipeline treo tới timeout
import { CodePipelineClient, PutJobSuccessResultCommand, PutJobFailureResultCommand }
  from "@aws-sdk/client-codepipeline";

const cp = new CodePipelineClient({});

export const handler = async (event) => {
  // CodePipeline truyền jobId trong event["CodePipeline.job"].id
  const jobId = event["CodePipeline.job"].id;
  try {
    // ... chạy smoke test / kiểm tra tùy biến của bạn ở đây ...
    await cp.send(new PutJobSuccessResultCommand({ jobId }));
  } catch (err) {
    // failureDetails.type: JobFailed | ConfigurationError | PermissionError | RevisionUnavailable
    await cp.send(new PutJobFailureResultCommand({
      jobId,
      failureDetails: { type: "JobFailed", message: err.message },
    }));
  }
};
```

> 💡 **Exam Tip:** Nếu cần chạy **logic tùy biến** (gọi API ngoài, kiểm tra điều kiện custom, integration test phức tạp) trong pipeline, đáp án là **Lambda invoke action**. Nhớ rằng hàm Lambda PHẢI gọi `PutJobSuccessResult`/`PutJobFailureResult`, nếu không action sẽ treo cho đến khi timeout.

## 42.3 Triggers: EventBridge vs webhook vs polling

Pipeline khởi động lại mỗi khi source thay đổi. Có **3 cơ chế phát hiện thay đổi**, và đề thi rất hay so sánh:

| Cơ chế | Dùng cho | Độ trễ | Trạng thái |
|--------|----------|--------|------------|
| **Amazon EventBridge** | CodeCommit, S3, ECR | Gần như tức thì | **Khuyến nghị mặc định** |
| **Webhook** | GitHub/Bitbucket (qua CodeStar Connections) | Tức thì | Push-based, không poll |
| **Polling** | Nguồn bên thứ ba (legacy) | Tới ~ vài phút | **Không khuyến nghị**, kém hiệu năng |

- **EventBridge** là cách mặc định và tối ưu cho source AWS (CodeCommit, S3, ECR). Khi tạo pipeline qua console, AWS tự tạo một EventBridge rule lắng nghe event thay đổi của source và `StartPipelineExecution`. Đây là **push-based**, độ trễ thấp.
- **Webhook**: với GitHub/Bitbucket qua CodeStar Connections, nhà cung cấp Git gửi webhook tới AWS khi có commit → pipeline chạy ngay. Cũng push-based.
- **Polling**: CodePipeline tự định kỳ gọi source kiểm tra thay đổi. Chậm, tốn tài nguyên, là cách CŨ. AWS khuyến cáo migrate khỏi polling. Nếu đề hỏi "pipeline khởi động chậm / cách tối ưu trigger" → chuyển từ polling sang EventBridge/webhook.

```json
// EventBridge rule kích hoạt pipeline khi CodeCommit có commit lên nhánh main
{
  "source": ["aws.codecommit"],
  "detail-type": ["CodeCommit Repository State Change"],
  "resources": ["arn:aws:codecommit:ap-southeast-1:111122223333:my-repo"],
  "detail": {
    "event": ["referenceCreated", "referenceUpdated"],
    "referenceType": ["branch"],
    "referenceName": ["main"]
  }
}
```

Target của rule là pipeline ARN, với một IAM role cho phép `codepipeline:StartPipelineExecution`.

> 💡 **Exam Tip:** Mặc định và khuyến nghị cho source AWS (CodeCommit/S3/ECR) là **EventBridge**. Nếu thấy đáp án nói "use periodic checks / polling để phát hiện thay đổi", đó thường là đáp án SAI vì kém hiệu năng. Với GitHub thì cơ chế là **webhook qua CodeStar (Developer Tools) Connection**.

## 42.4 Manual approval & thông báo SNS

**Manual approval action** tạo một cổng dừng pipeline lại, chờ con người bấm "Approve" hoặc "Reject" trên console (hoặc qua API/CLI) rồi mới đi tiếp. Đây là cách triển khai **continuous delivery** (có cổng người duyệt) khác với **continuous deployment** (tự động hoàn toàn).

Cơ chế hoạt động:
- Khi pipeline chạy tới approval action, stage chuyển sang trạng thái chờ và **dừng** lại — không tự timeout nhanh, mặc định chờ tối đa **7 ngày**; quá hạn thì action thất bại.
- Bạn có thể cấu hình một **SNS topic** để gửi thông báo khi cần duyệt — người duyệt nhận email kèm link tới pipeline.
- Bạn có thể đính kèm một URL để review (ví dụ link tới staging environment) và một comment.

Quyền cần thiết để người dùng duyệt: action `codepipeline:PutApprovalResult` trên pipeline đó.

```bash
# Phê duyệt một manual approval action qua CLI
aws codepipeline put-approval-result \
  --pipeline-name my-app-pipeline \
  --stage-name Approval \
  --action-name ManualApproval \
  --result summary="Looks good, ship it",status=Approved \
  --token <approval-token-lay-tu-get-pipeline-state>
```

Cấu hình action (trong JSON định nghĩa pipeline):

```json
{
  "name": "ManualApproval",
  "actionTypeId": {
    "category": "Approval",
    "owner": "AWS",
    "provider": "Manual",
    "version": "1"
  },
  "configuration": {
    "NotificationArn": "arn:aws:sns:ap-southeast-1:111122223333:approve-topic",
    "CustomData": "Duyet truoc khi deploy production",
    "ExternalEntityLink": "https://staging.example.com"
  },
  "runOrder": 1
}
```

> 💡 **Exam Tip:** Khi đề nói "require human approval before production deployment" + "notify the team" → đặt **Manual approval action** trước Deploy-to-Production stage và gắn **SNS topic** vào `NotificationArn`. Người duyệt cần quyền `codepipeline:PutApprovalResult`. Approval mặc định hết hạn sau **7 ngày**.

## 42.5 CodeStar Connections — kết nối GitHub, Bitbucket, GitLab

Để CodePipeline lấy source từ GitHub/GitHub Enterprise/Bitbucket/GitLab, AWS dùng **CodeStar Connections** (nay nằm dưới nhóm **Developer Tools / Connections**). Đây là một tài nguyên đại diện cho ủy quyền OAuth giữa AWS và nhà cung cấp Git.

Cơ chế:
- Bạn tạo một **connection**, rồi thực hiện handshake OAuth (bấm "Authorize" trên GitHub) để xác thực. Trước khi handshake xong, connection ở trạng thái `PENDING`; sau đó là `AVAILABLE`.
- Khi GitHub có commit, nó gửi **webhook** tới AWS → pipeline chạy (push-based, không polling).
- Cùng một connection dùng được cho nhiều pipeline và cả cho **CodeBuild** (build trực tiếp từ GitHub).

Đây là cách **được khuyến nghị hiện nay** thay cho kiểu kết nối GitHub OAuth token cũ (v1) hay personal access token. CodeStar Connections an toàn hơn (không lưu token trong pipeline) và hỗ trợ webhook.

```bash
# Tạo connection tới GitHub (sau đó phải vào console hoàn tất Authorize -> AVAILABLE)
aws codestar-connections create-connection \
  --provider-type GitHub \
  --connection-name my-github-conn

aws codestar-connections list-connections
```

Source action dùng connection (`ConnectionArn`, `FullRepositoryId`, `BranchName`, `OutputArtifactFormat: CODE_ZIP`).

> 💡 **Exam Tip:** Lấy source từ **GitHub** trong CodePipeline → dùng **CodeStar Connection** (Developer Tools Connection), không dùng polling, không nhúng access token vào pipeline. Connection mới tạo ở trạng thái `PENDING` cho tới khi hoàn tất handshake OAuth → `AVAILABLE`.

## 42.6 Cross-region & cross-account actions

**Cross-region action**: một stage có thể chứa action chạy ở region khác region của pipeline (ví dụ deploy CloudFormation stack sang us-west-2 trong khi pipeline ở ap-southeast-1). Yêu cầu:
- Mỗi region tham gia cần **một artifact S3 bucket riêng** trong region đó. CodePipeline tự sao chép (replicate) artifact sang bucket của region đích trước khi chạy action cross-region.
- Khai báo `artifactStores` map (region → bucket) trong định nghĩa pipeline thay vì một `artifactStore` đơn.

**Cross-account action**: deploy/triển khai sang một AWS account khác (mô hình phổ biến: account tooling chứa pipeline, account dev/staging/prod riêng). Yêu cầu chốt cho đề thi:
- Artifact bucket phải mã hóa bằng **customer managed KMS key** (CMK), KHÔNG dùng AWS managed key — vì AWS managed key không chia sẻ cross-account được.
- Key policy của CMK phải cho phép account đích dùng key (Decrypt/GenerateDataKey).
- Bucket policy phải cho phép account đích đọc artifact.
- Account đích phải có một **IAM role** mà pipeline (account nguồn) **AssumeRole** vào để thực thi action; trust policy của role đó tin tưởng account pipeline.

```bash
# Ý tưởng: pipeline role ở account A assume role ở account B để deploy
# Role ở account B cần trust account A và có quyền deploy (vd CloudFormation)
aws sts assume-role \
  --role-arn arn:aws:iam::444455556666:role/CrossAccountDeployRole \
  --role-session-name pipeline-deploy
```

> 💡 **Exam Tip:** Hai từ khóa vàng cho cross-account pipeline: **customer managed KMS key** (bắt buộc, vì AWS managed key không share cross-account được) và **cross-account IAM role** (pipeline AssumeRole vào account đích). Cross-region thì cần **một artifact bucket cho mỗi region**.

## 42.7 Pipeline cho serverless: CloudFormation & SAM deploy action

Để deploy ứng dụng serverless (Lambda + API Gateway + DynamoDB...) định nghĩa bằng **AWS SAM** (Chương 36) hoặc CloudFormation (Chương 19–20), pipeline dùng **CloudFormation deploy action**. Luồng điển hình:

1. **Source** (CodeCommit/GitHub) → lấy `template.yaml` (SAM) + code.
2. **Build** (CodeBuild) → chạy `sam build` rồi `sam package` (hay `aws cloudformation package`) để upload code lên S3 và sinh ra template đã "packaged" (thay code local bằng S3 URL). Output là `packaged.yaml`.
3. **Deploy** (CloudFormation action) → dùng `packaged.yaml` để tạo/cập nhật stack.

CloudFormation deploy action có nhiều **ActionMode**:
- `CHANGE_SET_REPLACE` — tạo (hoặc thay) một change set, chưa áp dụng.
- `CHANGE_SET_EXECUTE` — thực thi change set đã tạo.
- `CREATE_UPDATE` — tạo mới hoặc cập nhật stack trực tiếp.
- `REPLACE_ON_FAILURE`, `DELETE_ONLY`.

Pattern an toàn cho production: tách thành **2 action** — `CHANGE_SET_REPLACE` để tạo change set, rồi một **Manual approval**, rồi `CHANGE_SET_EXECUTE`. Người duyệt xem change set (biết tài nguyên nào bị thay/xóa) trước khi áp dụng.

```yaml
# buildspec.yml (CodeBuild) cho stage Build của pipeline SAM
version: 0.2
phases:
  install:
    runtime-versions:
      nodejs: 20
  build:
    commands:
      - sam build
      # package: upload code len S3, sinh template da packaged
      - sam package --s3-bucket $ARTIFACT_BUCKET --output-template-file packaged.yaml
artifacts:
  files:
    - packaged.yaml        # output artifact cho CloudFormation deploy action dung
```

Cấu hình CloudFormation deploy action cần: `StackName`, `TemplatePath` (trỏ tới `packaged.yaml` trong input artifact), `ActionMode`, `Capabilities` (`CAPABILITY_IAM`/`CAPABILITY_NAMED_IAM`/`CAPABILITY_AUTO_EXPAND` — SAM cần `CAPABILITY_AUTO_EXPAND` vì có Transform), và một `RoleArn` (CloudFormation service role để tạo tài nguyên).

> 💡 **Exam Tip:** Deploy SAM/serverless qua pipeline = **CodeBuild (sam build/package) → CloudFormation deploy action**. SAM template có `Transform: AWS::Serverless-2016-10-31` nên CloudFormation action cần capability **CAPABILITY_AUTO_EXPAND** (cùng `CAPABILITY_IAM`). Muốn duyệt thay đổi trước khi áp dụng: dùng **CHANGE_SET_REPLACE → Manual approval → CHANGE_SET_EXECUTE**.

## 42.8 Pipeline cho container & blue/green ECS

Pipeline deploy container điển hình: **Source (CodeCommit/GitHub) → Build (CodeBuild build & push image lên ECR) → Deploy (ECS hoặc CodeDeploy ECS blue/green)**.

Trong stage Build, CodeBuild thường xuất một file `imagedefinitions.json` (cho ECS standard rolling deploy) hoặc `imageDetail.json` + `appspec.yaml` + `taskdef.json` (cho **ECS blue/green qua CodeDeploy** — chi tiết hooks ở Chương 41):

```json
// imagedefinitions.json - dung cho "Amazon ECS" deploy action (rolling update)
[
  {
    "name": "web-container",
    "imageUri": "111122223333.dkr.ecr.ap-southeast-1.amazonaws.com/web:abc123"
  }
]
```

Hai lựa chọn deploy ECS trong pipeline:
- **Amazon ECS** deploy action → cập nhật service kiểu **rolling update** (ECS tự thay task cũ bằng task mới).
- **Amazon ECS (Blue/Green)** deploy action → thực chất gọi **CodeDeploy** để dịch traffic dần (canary/linear) giữa target group blue và green, có rollback bằng CloudWatch alarm.

ECR cũng có thể là **source** của pipeline: push image mới → EventBridge kích hoạt pipeline → deploy. Hữu ích khi tách quy trình build image (ở pipeline/repo khác) khỏi quy trình deploy.

> 💡 **Exam Tip:** ECS **rolling** deploy trong pipeline cần file output **imagedefinitions.json** từ CodeBuild. ECS **blue/green** cần CodeDeploy + bộ file **appspec.yaml + taskdef.json + imageDetail.json**. ECR có thể đóng vai trò **source action** (trigger khi có image mới).

## 42.9 CodeArtifact — package proxy & repository

**AWS CodeArtifact** là dịch vụ **artifact repository** quản lý package phần mềm (npm, PyPI/pip, Maven, NuGet, generic). Nó giải quyết hai bài toán: (1) **proxy/cache** package từ public registry (npmjs, PyPI) để build nhanh và ổn định, không phụ thuộc registry public; (2) **lưu trữ package nội bộ** của công ty một cách riêng tư.

Cấu trúc:
- **Domain**: ranh giới tổ chức, gom nhiều repository, dùng chung KMS key và storage (package chỉ lưu một bản trong domain dù nhiều repo tham chiếu).
- **Repository**: nơi chứa package theo một hoặc nhiều định dạng. Repo có thể có **upstream**: nếu không tìm thấy package, nó tìm lên upstream, và cuối chuỗi là **external connection** tới registry công khai (ví dụ `public:npmjs`).

Luồng dùng: dev/CI chạy `aws codeartifact login --tool npm --domain ... --repository ...` để cấu hình npm trỏ vào CodeArtifact; mọi `npm install` đi qua CodeArtifact (cache public package + phục vụ package nội bộ). Quyền truy cập bằng IAM + auth token tạm thời (`aws codeartifact get-authorization-token`, mặc định 12 giờ).

CodeArtifact phát **sự kiện qua EventBridge** khi package được tạo/sửa/xóa → dùng để kích hoạt pipeline khi có version package mới.

```bash
# Cau hinh npm tro vao CodeArtifact (token tam thoi)
aws codeartifact login --tool npm \
  --domain my-domain --domain-owner 111122223333 \
  --repository my-repo
# Tu day npm install di qua CodeArtifact (cache npmjs + package noi bo)
```

> 💡 **Exam Tip:** Khi đề mô tả "lưu trữ và chia sẻ package nội bộ (npm/pip/Maven) một cách riêng tư" hoặc "proxy/cache dependency từ public registry cho build reproducible" → đáp án là **CodeArtifact**. Đừng nhầm với CodeCommit (Git source) hay S3 (lưu artifact pipeline thô).

## 42.10 CodeGuru, CodeStar & CodeCatalyst (mức nhận diện)

**Amazon CodeGuru** dùng machine learning, gồm 2 thành phần:
- **CodeGuru Reviewer**: phân tích tĩnh code (Java, Python) trong pull request, đề xuất sửa về chất lượng, bug, rò rỉ tài nguyên, vấn đề bảo mật, và **phát hiện hardcoded secrets**. Tích hợp với CodeCommit/GitHub/Bitbucket qua PR.
- **CodeGuru Profiler**: phân tích **runtime** của ứng dụng đang chạy (production), tìm method tốn CPU/bộ nhớ nhất, "CPU hotspot", đề xuất tối ưu chi phí. Đây là profiling lúc chạy chứ không phải phân tích tĩnh.

> 💡 **Exam Tip:** Phân biệt nhanh: **CodeGuru Reviewer = static code review trong PR** (chất lượng/bảo mật code), **CodeGuru Profiler = runtime profiling** (tìm bottleneck CPU/bộ nhớ, tối ưu chi phí khi app chạy).

**AWS CodeStar** (thế hệ cũ): công cụ tạo nhanh project mẫu kèm sẵn toolchain CI/CD (CodeCommit + CodeBuild + CodeDeploy + CodePipeline) và dashboard. AWS đã ngừng nhận project CodeStar mới; vai trò "project management + sẵn pipeline" giờ chuyển sang CodeCatalyst.

**Amazon CodeCatalyst**: nền tảng phát triển hợp nhất (unified DevOps) — gom source repo, **workflows** (CI/CD), issue tracking, **Dev Environments** (cloud IDE), blueprints dựng nhanh project, tích hợp nhiều account qua "spaces". Dùng AWS Builder ID. Ở đề DVA-C02 chỉ cần **nhận diện**: CodeCatalyst là môi trường DevOps all-in-one, không thay thế chi tiết từng dịch vụ Code*.

Đừng nhầm **CodeStar Connections** (mục 42.5 — kết nối Git, vẫn rất thông dụng, nay gọi là Developer Tools Connections) với **AWS CodeStar** (project service cũ) — hai thứ khác hẳn nhau dù trùng tên.

> 💡 **Exam Tip:** **CodeCatalyst** = nền tảng DevOps hợp nhất (repo + workflow + dev environment + issues), mức nhận diện. **CodeStar Connections** ≠ **CodeStar**: Connections là cầu nối tới GitHub/Bitbucket (dùng trong CodePipeline/CodeBuild); CodeStar là dịch vụ project mẫu thế hệ cũ.

## 42.11 Bẫy thực tế & bảng tổng hợp toolchain

Một số lỗi production hay gặp với CodePipeline mà cũng là điểm gài trong đề thi:

- **Pipeline role thiếu quyền**: pipeline có một IAM **service role** riêng. Action gọi CodeBuild/CloudFormation/CodeDeploy mà role thiếu `iam:PassRole` (để truyền service role cho dịch vụ đích) hoặc thiếu quyền gọi dịch vụ đó → action fail với `not authorized`. Đây là nguyên nhân số 1 khi "action Deploy thất bại nhưng cấu hình trông đúng".
- **Artifact bucket khác region**: action cross-region nhưng quên khai báo `artifactStores` cho region đó → pipeline báo không tìm thấy bucket.
- **Tên artifact không khớp**: input artifact của Deploy action không trùng tên output của Build action.
- **CHANGE_SET_EXECUTE mà chưa REPLACE**: chạy execute change set trước khi change set được tạo → fail. Phải đúng thứ tự `runOrder`.
- **CodeStar Connection còn PENDING**: tạo connection bằng CLI nhưng quên vào console hoàn tất "Authorize" → source action fail vì connection chưa `AVAILABLE`.
- **S3 source không bật versioning**: S3 source action yêu cầu bucket **bật versioning**; thiếu sẽ lỗi.
- **Stage chỉ rerun từ điểm fail**: khi một action fail, bạn có thể **retry** lại stage đó mà không cần chạy lại từ Source — nhưng artifact đầu vào của stage vẫn là bản đã capture, không phải commit mới nhất.

CodePipeline phát đầy đủ **event qua EventBridge** về thay đổi trạng thái pipeline/stage/action (ví dụ `CodePipeline Stage Execution State Change`, status `FAILED`). Dùng rule này để gửi SNS/Lambda thông báo khi pipeline thất bại — đây là cách chuẩn để "alert khi deploy fail" thay vì poll trạng thái.

Bảng phân vai các dịch vụ Developer Tools (kinh điển cho đề):

| Dịch vụ | Vai trò | Nhớ nhanh |
|---------|---------|-----------|
| **CodeCommit** | Git repository | nơi chứa source (Ch40) |
| **CodeBuild** | Build & test, chạy buildspec | biên dịch, test, build image (Ch40) |
| **CodeDeploy** | Deploy lên EC2/Lambda/ECS | chiến lược deploy, rollback (Ch41) |
| **CodePipeline** | **Orchestration** CI/CD | nối các bước theo stage/action |
| **CodeArtifact** | Package repository (npm/pip/Maven) | proxy/cache + package nội bộ |
| **CodeGuru Reviewer** | Static code review trong PR | chất lượng/bảo mật code |
| **CodeGuru Profiler** | Runtime profiling | bottleneck CPU/bộ nhớ khi chạy |
| **CodeStar Connections** | Cầu nối tới GitHub/Bitbucket/GitLab | webhook source cho pipeline |
| **CodeCatalyst** | Nền tảng DevOps hợp nhất | all-in-one (nhận diện) |

> 💡 **Exam Tip:** Để **thông báo khi pipeline/stage fail**, tạo **EventBridge rule** bắt event `CodePipeline ... State Change` với status `FAILED` rồi nhắm tới **SNS topic** — đừng chọn đáp án "viết script poll get-pipeline-state". Nhớ pipeline role cần **iam:PassRole** để truyền service role cho CodeBuild/CloudFormation/CodeDeploy.

---

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
