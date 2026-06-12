## Hands-on Lab: Canary deploy một Lambda bằng CodeDeploy + alias shifting

**Mục tiêu lab:** Dùng AWS CodeDeploy "thuần" (không qua SAM) để hiểu rõ cơ chế bên dưới của một **Lambda deployment**: CodeDeploy không copy code mà chỉ **dịch traffic (traffic shifting)** giữa hai version của một Lambda thông qua một **alias** có weighted routing. Bạn sẽ tạo `Application` và `DeploymentGroup` kiểu compute platform `Lambda`, viết `appspec.yaml` khai báo version cũ → version mới, gắn **deployment config** `Canary10Percent5Minutes`, thêm một **PreTraffic validation hook** (Lambda kiểm thử trước khi mở traffic), và quan sát **rollback tự động** khi hook báo `Failed` hoặc khi một **CloudWatch alarm** chuyển sang `ALARM`. Phần EC2 in-place/blue-green và ECS blue/green nằm trong lý thuyết part1 và được nhắc trong Exam Tips — lab này chọn nền tảng Lambda vì nó dựng nhanh, không cần EC2/agent, mà vẫn chạm đủ các khái niệm cốt lõi của CodeDeploy.

**Chuẩn bị:**
- AWS CLI v2 đã cấu hình (`aws sts get-caller-identity` chạy được). Region lab: `us-east-1`.
- IAM principal đủ quyền tạo: Lambda function, IAM role, CodeDeploy application/deployment group/deployment, CloudWatch alarm.
- CodeDeploy với Lambda **không cần CodeDeploy agent** (agent chỉ dùng cho EC2/on-premises). Cũng không cần S3 — appspec gửi trực tiếp qua API.

```bash
export AWS_REGION=us-east-1
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "Account=$ACCOUNT_ID Region=$AWS_REGION"
```

### Bước 1: Tạo IAM role cho Lambda và cho CodeDeploy

CodeDeploy cần một **service role** với managed policy `AWSCodeDeployRoleForLambda` để được phép gọi `lambda:UpdateAlias`, đọc alias, và publish CloudWatch — đây là quyền tối thiểu cho compute platform Lambda.

```bash
# Trust policy cho Lambda execution role
cat > trust-lambda.json <<'EOF'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}
EOF
aws iam create-role --role-name lab41-lambda-exec \
  --assume-role-policy-document file://trust-lambda.json
aws iam attach-role-policy --role-name lab41-lambda-exec \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

# Trust policy cho CodeDeploy service role
cat > trust-cd.json <<'EOF'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"codedeploy.amazonaws.com"},"Action":"sts:AssumeRole"}]}
EOF
aws iam create-role --role-name lab41-codedeploy \
  --assume-role-policy-document file://trust-cd.json
aws iam attach-role-policy --role-name lab41-codedeploy \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSCodeDeployRoleForLambda
```

### Bước 2: Tạo Lambda, publish version 1 và một alias `live`

CodeDeploy dịch traffic giữa các **version bất biến** trỏ qua một alias. Vì vậy phải bật versioning bằng `--publish` và tạo alias trỏ vào version đầu tiên.

```bash
cat > index.js <<'EOF'
exports.handler = async () => ({ statusCode: 200, body: "v1" });
EOF
zip fn.zip index.js

aws lambda create-function --function-name lab41-fn \
  --runtime nodejs20.x --handler index.handler --zip-file fileb://fn.zip \
  --role arn:aws:iam::$ACCOUNT_ID:role/lab41-lambda-exec --publish
# -> ghi nho "Version": "1"

aws lambda create-alias --function-name lab41-fn \
  --name live --function-version 1
```

> Output mong đợi: lệnh `create-alias` trả về `AliasArn` dạng `...:function:lab41-fn:live`. Đây là ARN mà client (API Gateway, SDK) nên gọi — không bao giờ gọi thẳng `$LATEST` trong production.

### Bước 3: Cập nhật code và publish version 2 (chưa nhận traffic)

```bash
cat > index.js <<'EOF'
exports.handler = async () => ({ statusCode: 200, body: "v2" });
EOF
zip -f fn.zip index.js
aws lambda update-function-code --function-name lab41-fn --zip-file fileb://fn.zip --publish
# -> ghi nho "Version": "2"
```

Lúc này version 2 đã tồn tại nhưng alias `live` vẫn 100% trỏ version 1. CodeDeploy sẽ là thứ dịch dần traffic 1 → 2.

### Bước 4: Tạo PreTraffic validation hook (tùy chọn nhưng nên có)

Hook là một Lambda riêng. CodeDeploy gọi nó trong lifecycle event `BeforeAllowTraffic`; hook **bắt buộc** phải gọi `codedeploy:PutLifecycleEventHookExecutionStatus` để báo `Succeeded`/`Failed`, nếu không deployment treo tới timeout rồi fail.

```bash
cat > hook.js <<'EOF'
const { CodeDeployClient, PutLifecycleEventHookExecutionStatusCommand } = require("@aws-sdk/client-codedeploy");
const cd = new CodeDeployClient({});
exports.handler = async (event) => {
  // event chua deploymentId & lifecycleEventHookExecutionId
  let status = "Succeeded";          // doi thanh "Failed" de test rollback
  await cd.send(new PutLifecycleEventHookExecutionStatusCommand({
    deploymentId: event.DeploymentId,
    lifecycleEventHookExecutionId: event.LifecycleEventHookExecutionId,
    status,
  }));
  return status;
};
EOF
zip hook.zip hook.js
# Trong môi trường thật cần bundle SDK; nodejs20.x KHÔNG còn aws-sdk v3 sẵn trong runtime
aws lambda create-function --function-name lab41-prehook \
  --runtime nodejs20.x --handler hook.handler --zip-file fileb://hook.zip \
  --timeout 30 --role arn:aws:iam::$ACCOUNT_ID:role/lab41-lambda-exec --publish

# Cho hook quyen bao status ve CodeDeploy
aws iam put-role-policy --role-name lab41-lambda-exec --policy-name cd-hook \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"codedeploy:PutLifecycleEventHookExecutionStatus","Resource":"*"}]}'
```

### Bước 5: Tạo CloudWatch alarm để rollback tự động

```bash
aws cloudwatch put-metric-alarm --alarm-name lab41-errors \
  --namespace AWS/Lambda --metric-name Errors \
  --dimensions Name=FunctionName,Value=lab41-fn Name=Resource,Value=lab41-fn:live \
  --statistic Sum --period 60 --evaluation-periods 1 --threshold 1 \
  --comparison-operator GreaterThanOrEqualToThreshold --treat-missing-data notBreaching
```

### Bước 6: Tạo CodeDeploy application và deployment group

```bash
aws deploy create-application --application-name lab41-app \
  --compute-platform Lambda

aws deploy create-deployment-group --application-name lab41-app \
  --deployment-group-name lab41-dg \
  --service-role-arn arn:aws:iam::$ACCOUNT_ID:role/lab41-codedeploy \
  --deployment-config-name CodeDeployDefault.LambdaCanary10Percent5Minutes \
  --alarm-configuration enabled=true,alarms=[{name=lab41-errors}] \
  --auto-rollback-configuration enabled=true,events=DEPLOYMENT_FAILURE,DEPLOYMENT_STOP_ON_ALARM
```

> 💡 Lưu ý tên config: với Lambda là `CodeDeployDefault.LambdaCanary10Percent5Minutes`, `LambdaLinear10PercentEvery1Minute`, `LambdaAllAtOnce`. Với ECS đổi tiền tố thành `ECS...`. Đặt sai tiền tố là lỗi `InvalidDeploymentConfigNameException` — bẫy hay gặp.

### Bước 7: Viết appspec và tạo deployment

Với Lambda, `appspec` khai báo resource `AWS::Lambda::Function` cần shift: alias nào, từ version nào sang version nào, và hook nào chạy ở `BeforeAllowTraffic`/`AfterAllowTraffic`. CodeDeploy API nhận appspec dưới dạng chuỗi YAML/JSON trong `revision`.

```bash
APPSPEC=$(cat <<EOF
{"version":0.0,"Resources":[{"myFn":{"Type":"AWS::Lambda::Function","Properties":{
  "Name":"lab41-fn","Alias":"live","CurrentVersion":"1","TargetVersion":"2"}}}],
"Hooks":[{"BeforeAllowTraffic":"lab41-prehook"}]}
EOF
)
aws deploy create-deployment --application-name lab41-app \
  --deployment-group-name lab41-dg \
  --revision "revisionType=AppSpecContent,appSpecContent={content='$APPSPEC'}"
# -> tra ve deploymentId, vi du d-XXXXXXXXX
```

### Bước 8: Theo dõi traffic shifting và rollback

```bash
DID=<deploymentId>
aws deploy get-deployment --deployment-id $DID \
  --query 'deploymentInfo.{status:status,config:deploymentConfigName,roll:rollbackInfo}'
# Trong 5 phut: alias 'live' co RoutingConfig 90% v1 / 10% v2, sau do 100% v2
aws lambda get-alias --function-name lab41-fn --name live \
  --query '{ver:FunctionVersion,routing:RoutingConfig}'
```

Sau khi `Succeeded`, `get-alias` cho thấy `FunctionVersion: "2"` và `RoutingConfig` rỗng (100% v2). Để **chứng kiến rollback**: ở Bước 4 đổi `status = "Failed"`, deploy lại — CodeDeploy sẽ báo `Stopped`/`Failed` ở `BeforeAllowTraffic`, alias bị trả về 100% version 1, và `rollbackInfo` ghi nguyên nhân. Tương tự, nếu bạn ép alarm `lab41-errors` sang ALARM trong cửa sổ canary, deployment dừng và rollback do `DEPLOYMENT_STOP_ON_ALARM`.

### Dọn dẹp tài nguyên

```bash
aws deploy delete-deployment-group --application-name lab41-app --deployment-group-name lab41-dg
aws deploy delete-application --application-name lab41-app
aws cloudwatch delete-alarms --alarm-names lab41-errors
aws lambda delete-function --function-name lab41-fn
aws lambda delete-function --function-name lab41-prehook
aws iam delete-role-policy --role-name lab41-lambda-exec --policy-name cd-hook
aws iam detach-role-policy --role-name lab41-lambda-exec \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam delete-role --role-name lab41-lambda-exec
aws iam detach-role-policy --role-name lab41-codedeploy \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSCodeDeployRoleForLambda
aws iam delete-role --role-name lab41-codedeploy
rm -f index.js hook.js *.zip trust-*.json
```

> CodeDeploy application/deployment group và deployment history **không tính phí**. Chi phí phát sinh duy nhất là vài invocation Lambda — gần như $0. Dọn dẹp chủ yếu để tránh rác tài nguyên.

## 💡 Exam Tips chương 41

- **Compute platform quyết định mọi thứ:** CodeDeploy có 3 nền tảng — **EC2/On-premises**, **Lambda**, **ECS**. EC2/on-prem cần **CodeDeploy agent**; Lambda và ECS **không cần agent** (CodeDeploy gọi API trực tiếp). Câu hỏi "deploy lên Fargate cần cài agent không?" → KHÔNG.
- **In-place vs Blue/Green:** chỉ **EC2/on-premises** mới có in-place (vá tại chỗ trên instance hiện tại). **Lambda và ECS LUÔN là blue/green** — không có in-place. On-premises **không hỗ trợ** blue/green (vì CodeDeploy không cấp được fleet mới).
- **Deployment config theo nền tảng:** Lambda/ECS dùng traffic-shifting **`Canary`** (2 bước: x% rồi 100%), **`Linear`** (tăng đều mỗi N phút), **`AllAtOnce`**. EC2 in-place dùng config dựa trên số host khỏe: `OneAtATime`, `HalfAtATime`, `AllAtOnce`, hoặc custom `minimum-healthy-hosts`.
- **appspec lifecycle hooks EC2** (thứ tự): ApplicationStop → DownloadBundle → BeforeInstall → Install → AfterInstall → **ApplicationStart** → **ValidateService**. Lưu ý **DownloadBundle và Install KHÔNG gắn hook script được** (CodeDeploy tự làm). `AllowTraffic`/`BeforeAllowTraffic`/`AfterAllowTraffic` chỉ xuất hiện khi blue/green hoặc có ELB.
- **appspec hooks Lambda chỉ có 2:** `BeforeAllowTraffic` và `AfterAllowTraffic`. **ECS có thêm** `BeforeInstall`, `AfterInstall`, `AfterAllowTestTraffic`, `BeforeAllowTraffic`, `AfterAllowTraffic`. Hook là **Lambda function**, phải tự gọi `PutLifecycleEventHookExecutionStatus`.
- **Vị trí & định dạng appspec:** EC2 dùng **`appspec.yml`** đặt ở **gốc** bundle. Lambda/ECS thường dùng `appspec.yaml`/JSON và CodeDeploy chấp nhận nội dung trực tiếp qua API. Sai vị trí → lỗi "AppSpec file not found".
- **Rollback** thực chất là **redeploy bản tốt cuối cùng** (last known good revision), KHÔNG phải "undo". Bật qua `auto-rollback-configuration` với event `DEPLOYMENT_FAILURE` và/hoặc `DEPLOYMENT_STOP_ON_ALARM` (gắn CloudWatch alarm). Manual rollback = tạo deployment mới với revision cũ.
- **Deployment group nhắm target bằng tag** (EC2 tag, ASG name, hoặc EC2 Tag Set — AND nhiều tag). Tích hợp **ASG**: khi ASG scale-out, CodeDeploy tự deploy revision hiện tại lên instance mới — đây là lý do dùng deployment group gắn ASG thay vì tag tĩnh.
- **Blue/Green trên EC2** cần ASG/ELB: CodeDeploy tạo fleet "green" mới, deploy, ELB chuyển traffic, rồi terminate "blue" (có thể giữ lại theo `terminationWaitTimeInMinutes`). Tốn gấp đôi compute trong lúc chuyển → đề hay hỏi đánh đổi chi phí vs zero-downtime.
- **SAM/Lambda alias shifting:** `AutoPublishAlias` + `DeploymentPreference.Type` trong SAM **tự sinh** CodeDeploy application/deployment group cho bạn — không phải viết tay (chi tiết ở Chương 36). Đề hay gài: "canary 10% trong 10 phút cho Lambda" → dùng CodeDeploy traffic shifting, KHÔNG phải Route 53 weighted.
- **Đừng nhầm vai trò:** CodeDeploy = **deploy/shift traffic**. CodePipeline = **orchestrate** (Chương 42). CodeBuild = **build** (Chương 40). Câu hỏi "tự động hóa toàn pipeline" → CodePipeline gọi CodeDeploy ở stage Deploy.
- **Troubleshooting EC2:** "deployment fail ngay BeforeInstall/ApplicationStop" thường do **agent không chạy**, **IAM instance profile thiếu quyền S3** (tải bundle), hoặc **script hook exit code ≠ 0 / timeout**. Mỗi hook có timeout riêng; script treo → cả deployment fail.

## Quiz chương 41 (10 câu)

**Câu 1.** Một team deploy ứng dụng container lên **Amazon ECS Fargate** và muốn dịch dần 10% traffic sang task mới trong 5 phút, có thể rollback. Họ hỏi cần cài CodeDeploy agent ở đâu?
- A. Trên mỗi Fargate task qua sidecar
- B. Trên một EC2 instance trung gian
- C. Không cần agent — CodeDeploy điều khiển ECS/ELB qua API
- D. Trên container host của cluster

**Câu 2.** Trên nền tảng **EC2 in-place**, lifecycle event nào KHÔNG cho phép gắn hook script trong `appspec.yml`?
- A. BeforeInstall
- B. Install
- C. ApplicationStart
- D. ValidateService

**Câu 3.** Một developer cần **blue/green deployment** zero-downtime cho ứng dụng chạy trên **EC2 phía sau ALB**. Yêu cầu cấu hình tối thiểu là gì?
- A. Chỉ cần CodeDeploy agent, không cần ASG hay ELB
- B. ASG/ELB để CodeDeploy tạo fleet mới và chuyển traffic
- C. Một Lambda alias với weighted routing
- D. Route 53 failover routing policy

**Câu 4.** Trong appspec cho **Lambda deployment**, hai lifecycle hook hợp lệ là gì?
- A. BeforeInstall và AfterInstall
- B. BeforeAllowTraffic và AfterAllowTraffic
- C. ApplicationStart và ValidateService
- D. AfterAllowTestTraffic và BeforeAllowTraffic

**Câu 5.** Một PreTraffic hook Lambda chạy nhưng deployment cứ treo rồi fail sau timeout. Nguyên nhân khả dĩ nhất?
- A. Hook thiếu lệnh gọi `PutLifecycleEventHookExecutionStatus`
- B. Deployment config sai tên
- C. Alias chưa được tạo
- D. CodeDeploy agent chưa cài

**Câu 6.** Team muốn **rollback tự động** một Lambda deployment khi tỉ lệ lỗi tăng đột biến trong cửa sổ canary. Cấu hình đúng?
- A. Bật versioning trên function
- B. Gắn CloudWatch alarm vào deployment group + auto-rollback `DEPLOYMENT_STOP_ON_ALARM`
- C. Dùng Route 53 health check
- D. Đặt reserved concurrency = 0

**Câu 7.** Khi một **Auto Scaling Group** gắn với deployment group scale-out thêm instance mới, điều gì xảy ra?
- A. Instance mới chạy AMI gốc, không có code app
- B. CodeDeploy tự deploy revision hiện hành lên instance mới
- C. Deployment group bị vô hiệu cho tới lần deploy kế tiếp
- D. Phải deploy thủ công lại toàn bộ fleet

**Câu 8.** Deployment config nào hợp lệ cho **ECS** blue/green?
- A. CodeDeployDefault.OneAtATime
- B. CodeDeployDefault.HalfAtATime
- C. CodeDeployDefault.ECSLinear10PercentEvery1Minute
- D. CodeDeployDefault.LambdaCanary10Percent5Minutes

**Câu 9.** Một deployment EC2 fail ngay ở **DownloadBundle** với lỗi quyền. Khắc phục đúng nhất?
- A. Thêm hook ApplicationStop vào appspec
- B. Cấp cho IAM instance profile quyền đọc S3 chứa bundle
- C. Đổi deployment config sang AllAtOnce
- D. Bật blue/green deployment

**Câu 10.** "Manual rollback" trong CodeDeploy thực chất là gì?
- A. Một thao tác undo nguyên tử trên revision hiện tại
- B. Xóa deployment group rồi tạo lại
- C. Tạo một deployment mới trỏ về revision tốt đã biết trước đó
- D. Khởi động lại CodeDeploy agent trên các instance

### Đáp án & giải thích

**Câu 1 — Đáp án C.** ECS (và Lambda) là nền tảng managed, CodeDeploy gọi API ECS/ELB để tạo task set mới và shift traffic — **không có agent**. A/B/D đều sai vì agent chỉ tồn tại cho **EC2/on-premises**; Fargate thậm chí không cho bạn truy cập host.

**Câu 2 — Đáp án B.** **Install** (và DownloadBundle) do CodeDeploy tự thực hiện copy file, **không gắn hook**. BeforeInstall, ApplicationStart, ValidateService đều là hook hợp lệ để chạy script — nên A/C/D sai.

**Câu 3 — Đáp án B.** Blue/green trên EC2 yêu cầu CodeDeploy cấp một fleet mới (qua ASG/launch template) và chuyển traffic qua **ELB**. A sai vì agent không tự tạo fleet. C là cơ chế của Lambda, không áp dụng cho EC2 host. D (Route 53) không phải cách CodeDeploy làm blue/green và chuyển DNS chậm, không zero-downtime đúng nghĩa.

**Câu 4 — Đáp án B.** Lambda chỉ có **BeforeAllowTraffic** và **AfterAllowTraffic**. A là hook của EC2/ECS install phase. C là hook EC2. D — `AfterAllowTestTraffic` là hook của **ECS**, không phải Lambda.

**Câu 5 — Đáp án A.** Hook Lambda **bắt buộc** gọi `PutLifecycleEventHookExecutionStatus` với `Succeeded`/`Failed`; nếu không, CodeDeploy chờ tới timeout rồi coi là fail. B sai sẽ lỗi ngay khi tạo deployment, không "treo". C — nếu thiếu alias, deployment fail sớm chứ không treo ở hook. D — Lambda không dùng agent.

**Câu 6 — Đáp án B.** Auto-rollback dựa trên **CloudWatch alarm** gắn vào deployment group cùng event `DEPLOYMENT_STOP_ON_ALARM`. A (versioning) là điều kiện cần để deploy nhưng không gây rollback. C/D không liên quan cơ chế rollback của CodeDeploy.

**Câu 7 — Đáp án B.** Khi deployment group gắn ASG, CodeDeploy hook vào sự kiện launch và **tự deploy revision hiện hành** lên instance mới, đảm bảo instance vừa scale-out có code đúng. A là điều xảy ra nếu KHÔNG gắn ASG vào deployment group. C/D sai về cơ chế.

**Câu 8 — Đáp án C.** Tên config phải đúng tiền tố nền tảng: **`CodeDeployDefault.ECSLinear10PercentEvery1Minute`**. A/B là config **EC2 in-place** (theo số host). D có tiền tố **Lambda**, không dùng cho ECS — sai nền tảng gây `InvalidDeploymentConfigNameException`.

**Câu 9 — Đáp án B.** DownloadBundle là bước agent tải artifact từ **S3**; lỗi quyền nghĩa là **IAM instance profile** thiếu `s3:GetObject` lên bucket bundle. A vô nghĩa vì lỗi xảy ra trước ApplicationStop của bản mới. C/D không liên quan tới quyền tải bundle.

**Câu 10 — Đáp án C.** Rollback trong CodeDeploy = **tạo deployment mới** trỏ về revision tốt trước đó (redeploy), không phải undo nguyên tử. A mô tả sai bản chất. B phá hủy cấu hình, không phải rollback. D chỉ khởi động lại agent, không phục hồi code.

## Tóm tắt chương

- CodeDeploy hỗ trợ 3 compute platform: **EC2/On-premises** (cần agent), **Lambda** và **ECS** (không cần agent, dịch traffic qua API).
- **In-place** chỉ có ở EC2/on-prem; **Lambda và ECS luôn blue/green**; on-premises không hỗ trợ blue/green.
- **`appspec.yml`** (EC2, đặt ở gốc bundle) khai báo files + hooks lifecycle theo thứ tự: ApplicationStop → BeforeInstall → AfterInstall → ApplicationStart → ValidateService; **DownloadBundle và Install không gắn hook**.
- **appspec Lambda** chỉ có 2 hook: `BeforeAllowTraffic`, `AfterAllowTraffic`; **ECS** có thêm `AfterAllowTestTraffic` và các hook install. Hook là Lambda phải gọi `PutLifecycleEventHookExecutionStatus`.
- **Deployment config** khác nhau theo nền tảng: EC2 theo host khỏe (OneAtATime/HalfAtATime/AllAtOnce/custom); Lambda/ECS theo traffic shifting (Canary/Linear/AllAtOnce) với tiền tố `Lambda`/`ECS` trong tên.
- **Canary** = shift x% rồi nhảy 100%; **Linear** = tăng đều mỗi N phút.
- **Rollback** là redeploy revision tốt cuối, kích hoạt bởi `DEPLOYMENT_FAILURE` hoặc **CloudWatch alarm** (`DEPLOYMENT_STOP_ON_ALARM`); rollback thủ công = tạo deployment mới với revision cũ.
- **Deployment group** nhắm target bằng EC2 tag, EC2 Tag Set hoặc **ASG**; gắn ASG để instance scale-out tự nhận revision hiện hành.
- **Blue/green EC2** cần ASG/ELB, tốn gấp đôi compute tạm thời nhưng đạt zero-downtime; `terminationWaitTimeInMinutes` giữ fleet cũ để rollback nhanh.
- **SAM** tự sinh CodeDeploy cho Lambda qua `AutoPublishAlias` + `DeploymentPreference` (Chương 36); CodeDeploy chỉ là stage Deploy trong CodePipeline (Chương 42).
- Troubleshooting EC2 hay gặp: agent không chạy, IAM instance profile thiếu quyền S3 (DownloadBundle), hook script exit ≠ 0 hoặc timeout.
- Phân biệt vai trò: CodeBuild = build, CodeDeploy = deploy/shift traffic, CodePipeline = orchestrate.
