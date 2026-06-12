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
