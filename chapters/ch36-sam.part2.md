## Hands-on Lab: Build, deploy và canary một serverless API bằng AWS SAM

**Mục tiêu lab:** Đi trọn vòng đời một ứng dụng serverless bằng AWS SAM CLI: viết `template.yaml` dùng `Globals`, `AWS::Serverless::Function`, `AWS::Serverless::Api` và `AWS::Serverless::SimpleTable`; gắn quyền bằng **policy templates** (`DynamoDBCrudPolicy`) thay vì viết IAM thủ công; test cục bộ với `sam local invoke` và `sam local start-api` (dùng Docker); deploy guided với `sam deploy --guided`; bật **AutoPublishAlias** + **DeploymentPreference** để CodeDeploy shift traffic kiểu **canary** kèm **PreTraffic hook** và **CloudWatch alarm rollback**; cuối cùng thử `sam sync` (SAM Accelerate) cho vòng lặp dev nhanh. So sánh chi tiết SAM vs CloudFormation thuần, và CodeDeploy lifecycle hooks chi tiết thuộc Chương 41 — ở đây chỉ dùng ở mức SAM tự sinh.

**Chuẩn bị:**
- AWS CLI v2 + **AWS SAM CLI** đã cài (`sam --version`), **Docker** đang chạy (bắt buộc cho `sam local` và `sam build --use-container`).
- IAM principal có quyền tạo CloudFormation stack, Lambda, API Gateway, DynamoDB, IAM role, S3 (bucket staging), CodeDeploy. Region lab: `us-east-1`.

```bash
export AWS_REGION=us-east-1
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
sam --version && docker info >/dev/null && echo "SAM + Docker OK"
```

### Bước 1: Khởi tạo project và đọc cấu trúc

```bash
sam init --name lab36-api --runtime nodejs20.x --architecture x86_64 \
  --app-template hello-world --package-type Zip
cd lab36-api
```

`sam init` sinh khung: `template.yaml`, thư mục code `hello-world/`, và `samconfig.toml` (sẽ tạo khi deploy guided). Ta sẽ thay `template.yaml` bằng bản đầy đủ hơn ở bước sau.

### Bước 2: Viết template SAM hoàn chỉnh

Tạo `template.yaml`. Lưu ý dòng `Transform: AWS::Serverless-2016-10-09` — đây là thứ biến file này thành SAM template: CloudFormation chạy macro `Transform` để **nở (expand)** các resource `AWS::Serverless::*` thành resource CloudFormation gốc (Lambda function, IAM role, API Gateway, DynamoDB table...) trước khi tạo stack.

```yaml
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-09
Description: lab36 - serverless API voi canary deploy

Globals:                      # ap dung cho MOI Serverless::Function ben duoi
  Function:
    Runtime: nodejs20.x
    Timeout: 10
    MemorySize: 256
    Environment:
      Variables:
        TABLE_NAME: !Ref ItemsTable

Resources:
  ItemsTable:
    Type: AWS::Serverless::SimpleTable   # tao DynamoDB table PK 'id', PAY_PER_REQUEST
    Properties:
      PrimaryKey:
        Name: id
        Type: String

  PutItemFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: hello-world/
      Handler: app.handler
      AutoPublishAlias: live            # tao version moi + alias 'live' moi lan deploy
      DeploymentPreference:
        Type: Canary10Percent5Minutes   # 10% traffic 5 phut, roi 100%
        Hooks:
          PreTraffic: !Ref PreHookFunction
        Alarms:
          - !Ref ErrorsAlarm            # alarm bao dong -> CodeDeploy rollback
      Policies:
        - DynamoDBCrudPolicy:           # POLICY TEMPLATE - khong viet IAM tay
            TableName: !Ref ItemsTable
      Events:
        Api:
          Type: Api
          Properties:
            Path: /items
            Method: post

  PreHookFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: hooks/
      Handler: pretraffic.handler
      Policies:
        - Version: '2012-10-17'
          Statement:
            - Effect: Allow
              Action: codedeploy:PutLifecycleEventHookExecutionStatus
              Resource: '*'

  ErrorsAlarm:
    Type: AWS::CloudWatch::Alarm
    Properties:
      AlarmName: lab36-put-errors
      Namespace: AWS/Lambda
      MetricName: Errors
      Dimensions:
        - Name: Resource
          Value: !Sub "${PutItemFunction}:live"
        - Name: FunctionName
          Value: !Ref PutItemFunction
      Statistic: Sum
      Period: 60
      EvaluationPeriods: 1
      Threshold: 1
      ComparisonOperator: GreaterThanOrEqualToThreshold
      TreatMissingData: notBreaching

Outputs:
  ApiUrl:
    Value: !Sub "https://${ServerlessRestApi}.execute-api.${AWS::Region}.amazonaws.com/Prod/items"
```

> So với CloudFormation thuần: chỉ resource `PutItemFunction` này khi nở ra sẽ thành ~8 resource gốc (function, version, alias, execution role, API, deployment, stage, CodeDeploy DeploymentGroup, permission). SAM viết ~25 dòng thay cho ~200 dòng CFN — đó là giá trị cốt lõi của Transform.

### Bước 3: Viết code handler và PreTraffic hook

```bash
mkdir -p hooks
cat > hello-world/app.js <<'EOF'
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
exports.handler = async (event) => {
  const body = JSON.parse(event.body || "{}");
  const id = body.id || Date.now().toString();
  await ddb.send(new PutCommand({ TableName: process.env.TABLE_NAME, Item: { id, ...body } }));
  return { statusCode: 200, body: JSON.stringify({ saved: id }) };
};
EOF

cat > hooks/pretraffic.js <<'EOF'
// PreTraffic hook: chay TRUOC khi shift traffic. Phai bao status ve CodeDeploy.
const { CodeDeployClient, PutLifecycleEventHookExecutionStatusCommand } =
  require("@aws-sdk/client-codedeploy");
const cd = new CodeDeployClient({});
exports.handler = async (event) => {
  // ... o day ban chay smoke test goi version moi truoc khi mo traffic ...
  const status = "Succeeded"; // hoac "Failed" de chan deploy
  await cd.send(new PutLifecycleEventHookExecutionStatusCommand({
    deploymentId: event.DeploymentId,
    lifecycleEventHookExecutionId: event.LifecycleEventHookExecutionId,
    status,
  }));
  return status;
};
EOF
```

> Bẫy kinh điển: nếu PreTraffic/PostTraffic hook **không gọi** `PutLifecycleEventHookExecutionStatus`, CodeDeploy treo cho tới khi timeout rồi coi như **Failed** và rollback. Đây là lý do số 1 khiến canary deploy "kẹt" trong thực tế.

### Bước 4: Build

```bash
sam build --use-container
```

`sam build` đọc `template.yaml`, với mỗi function chạy build theo runtime (Node.js: copy code + `npm install` dependencies), đặt artifact vào `.aws-sam/build/`, và sinh `template.yaml` đã chuẩn hoá trong đó. `--use-container` build trong Docker image giống môi trường Lambda (quan trọng khi có native dependency). Output mong đợi kết thúc bằng `Build Succeeded` kèm gợi ý `sam local invoke` / `sam deploy --guided`.

### Bước 5: Test cục bộ với sam local

`generate-event` tạo payload mẫu cho nhiều nguồn sự kiện; `local invoke` chạy function trong Docker, không cần deploy:

```bash
sam local generate-event apigateway aws-proxy --body '{"id":"a1","name":"test"}' \
  > event.json
sam local invoke PutItemFunction --event event.json
```

Chạy cả API cục bộ (mô phỏng API Gateway tại `http://127.0.0.1:3000`):

```bash
sam local start-api &      # chay nen
sleep 5
curl -s -XPOST http://127.0.0.1:3000/items -d '{"id":"local-1"}'
kill %1
```

> `sam local` mô phỏng Lambda + API Gateway nhưng **gọi tới AWS thật** cho các service khác (DynamoDB...) bằng credentials hiện hành. Muốn DynamoDB cũng cục bộ thì trỏ endpoint tới DynamoDB Local (Chương 33). `sam local start-lambda` dựng một endpoint giả lập Lambda service để SDK test gọi vào — khác với `start-api`.

### Bước 6: Deploy guided

```bash
sam deploy --guided
```

Trả lời prompt: Stack name `lab36-api`, Region `us-east-1`, `Confirm changes before deploy` = Y, `Allow SAM CLI IAM role creation` = **Y** (SAM cần `CAPABILITY_IAM` vì nó tạo IAM role), lưu vào `samconfig.toml`. SAM sẽ: đóng gói code, **upload lên S3 bucket staging** (`aws-sam-cli-managed-default-...` tự tạo), tạo **ChangeSet**, hiển thị diff, rồi thực thi. Lần deploy đầu, `DeploymentPreference` chưa shift gì (chưa có version cũ) — alias `live` trỏ thẳng version 1.

```bash
API_URL=$(aws cloudformation describe-stacks --stack-name lab36-api \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)
curl -s -XPOST "$API_URL" -d '{"id":"prod-1","name":"hi"}'
# mong doi: {"saved":"prod-1"}
```

### Bước 7: Trigger một canary deploy và quan sát rollback

Sửa code (ví dụ đổi message trả về) rồi deploy lại không guided:

```bash
sed -i.bak 's/saved/stored/' hello-world/app.js
sam build && sam deploy
```

Lần này có version cũ → CodeDeploy tạo deployment kiểu `Canary10Percent5Minutes`: alias `live` cho 10% traffic sang version mới trong 5 phút, chạy PreTraffic hook trước. Theo dõi:

```bash
aws deploy list-deployments --query 'deployments[0]' --output text
# Lay deployment-id roi:
aws deploy get-deployment --deployment-id <id> \
  --query 'deploymentInfo.status'   # InProgress -> Succeeded
```

Nếu trong 5 phút canary mà `ErrorsAlarm` chuyển `ALARM` (có ≥1 lỗi), CodeDeploy **tự rollback** alias `live` về version cũ và đánh dấu deployment `Stopped`/`Failed`. Đây chính là điểm thi hay hỏi: SAM + CodeDeploy + CloudWatch alarm = safe deployment tự động.

### Bước 8 (tuỳ chọn): sam sync — SAM Accelerate

Cho vòng lặp dev nhanh, `sam sync --watch` theo dõi file và **đẩy thẳng** thay đổi code (qua `UpdateFunctionCode`) không qua CloudFormation ChangeSet, chỉ rơi về deploy hạ tầng khi `template.yaml` đổi:

```bash
sam sync --stack-name lab36-api --watch
# Sua hello-world/app.js -> SAM tu update code trong ~giay, khong tao changeset
# Ctrl+C de thoat
```

> `sam sync` bỏ qua an toàn của ChangeSet/rollback để đổi lấy tốc độ → chỉ dùng cho **dev/test stack**, KHÔNG dùng production. Đề có thể hỏi "công cụ nào tăng tốc inner-loop development cho serverless" → `sam sync` / SAM Accelerate.

### Dọn dẹp tài nguyên

```bash
sam delete --stack-name lab36-api --no-prompts
# sam delete xoa stack + artifact tren S3 staging do SAM quan ly
rm -f event.json hello-world/app.js.bak
```

> `sam delete` gọi `cloudformation delete-stack` rồi dọn artifact S3. DynamoDB table tạo qua SimpleTable bị xoá theo stack (mặc định không Retain) — đảm bảo không còn data quan trọng. CloudWatch alarm và CodeDeploy application/deployment group cũng do stack quản nên xoá theo.

## 💡 Exam Tips chương 36

- **`Transform: AWS::Serverless-2016-10-09`** là dòng BẮT BUỘC nhận diện SAM template. Không có nó, CloudFormation không hiểu `AWS::Serverless::*`. SAM là **superset của CloudFormation** — mọi resource CFN gốc đều dùng được trong SAM template.
- **`AWS::Serverless::Function`** nở ra: Lambda function + execution role + (nếu có `Events`) trigger/permission + (nếu có `AutoPublishAlias`) version, alias, CodeDeploy. Biết nó nở ra cái gì là điểm thi.
- **Policy templates** (`DynamoDBCrudPolicy`, `SQSPollerPolicy`, `S3ReadPolicy`, `SNSPublishMessagePolicy`...) sinh IAM policy least-privilege gắn vào execution role — tránh viết IAM tay. Hay hỏi "cách đơn giản nhất cấp quyền least-privilege cho Lambda trong SAM".
- **`sam build`** đóng gói code + dependencies vào `.aws-sam/build/`. **`sam deploy --guided`** lần đầu tạo S3 bucket staging + `samconfig.toml`; nó luôn upload code lên S3 trước khi tạo stack (zip > 50 MB không upload trực tiếp được — Chương 28).
- **`sam local invoke` / `start-api` / `start-lambda`** cần **Docker**. `start-api` mô phỏng API Gateway, `start-lambda` dựng endpoint giả Lambda service. `sam local generate-event <service>` tạo payload mẫu (s3, sqs, apigateway...).
- **`AutoPublishAlias: live`** = mỗi deploy publish version mới và trỏ alias; là TIỀN ĐỀ để `DeploymentPreference` (CodeDeploy traffic shifting) hoạt động. Không có alias thì không canary được.
- **`DeploymentPreference.Type`**: `Canary10Percent5Minutes` (10% rồi 100% sau 5 phút), `Linear10PercentEvery1Minute`, `AllAtOnce`. Kèm `Alarms` để auto-rollback và `Hooks` (PreTraffic/PostTraffic Lambda) để smoke test.
- **Hook bắt buộc** gọi `codedeploy:PutLifecycleEventHookExecutionStatus` báo `Succeeded`/`Failed`; quên gọi → deploy treo tới timeout rồi rollback.
- **`sam sync` / SAM Accelerate**: tăng tốc inner-loop dev bằng cách đẩy thẳng code (bỏ ChangeSet). Chỉ dùng dev/test, không production.
- **`sam deploy` cần capabilities**: SAM tự tạo IAM role nên cần `CAPABILITY_IAM` (hoặc `CAPABILITY_NAMED_IAM` nếu đặt tên role); nếu template có macro/nested → `CAPABILITY_AUTO_EXPAND`.
- **SAR — Serverless Application Repository**: nơi publish/discover ứng dụng serverless đóng gói SAM; nhúng app công khai bằng `AWS::Serverless::Application`. Khác với việc tự deploy stack.
- **`AWS::Serverless::SimpleTable`** chỉ tạo DynamoDB table khoá đơn giản (PK, tuỳ chọn SK qua... không có — chỉ PK); cần GSI/LSI/stream phải dùng `AWS::DynamoDB::Table` đầy đủ.

## Quiz chương 36 (10 câu)

**Câu 1.** Dòng nào BẮT BUỘC để CloudFormation hiểu các resource `AWS::Serverless::Function`?
- A. `AWSTemplateFormatVersion: '2010-09-09'`
- B. `Transform: AWS::Serverless-2016-10-09`
- C. `Type: AWS::Lambda::Function`
- D. `Globals:` block

**Câu 2.** Một developer cần cấp cho Lambda quyền read/write một DynamoDB table với least-privilege, ít công nhất trong SAM. Cách nào?
- A. Viết IAM policy JSON đầy đủ trong `Policies`
- B. Dùng policy template `DynamoDBCrudPolicy` với `TableName`
- C. Gắn managed policy `AmazonDynamoDBFullAccess`
- D. Tạo IAM user và embed access key vào env var

**Câu 3.** Lệnh `sam local start-api` báo lỗi không kết nối được. Nguyên nhân thường gặp nhất?
- A. Chưa chạy `sam deploy`
- B. Docker không chạy
- C. Region chưa cấu hình
- D. Thiếu `samconfig.toml`

**Câu 4.** Developer muốn deploy Lambda dịch chuyển 10% traffic sang version mới trong 5 phút, tự rollback nếu lỗi. Cấu hình SAM nào?
- A. `DeploymentPreference.Type: AllAtOnce`
- B. `AutoPublishAlias` + `DeploymentPreference.Type: Canary10Percent5Minutes` + `Alarms`
- C. Chỉ cần `AutoPublishAlias: live`
- D. Đặt `ReservedConcurrentExecutions`

**Câu 5.** Một canary deployment bằng SAM/CodeDeploy bị "kẹt" ở trạng thái InProgress rồi rollback dù code đúng. Có PreTraffic hook. Nguyên nhân khả dĩ nhất?
- A. Alarm chưa cấu hình
- B. Hook function không gọi `PutLifecycleEventHookExecutionStatus`
- C. Memory function quá thấp
- D. Thiếu `AutoPublishAlias`

**Câu 6.** `sam deploy` trả lỗi `Requires capabilities: [CAPABILITY_IAM]`. Vì sao?
- A. Template sai cú pháp
- B. SAM tạo IAM role nên phải xác nhận capability
- C. Region không hỗ trợ
- D. Thiếu S3 bucket

**Câu 7.** Đội dev muốn rút ngắn vòng lặp sửa code → thấy thay đổi trên AWS, không chờ ChangeSet mỗi lần. Công cụ SAM nào?
- A. `sam build --use-container`
- B. `sam sync --watch` (SAM Accelerate)
- C. `sam local invoke`
- D. `sam package`

**Câu 8.** `sam build` thực hiện việc gì?
- A. Tạo CloudFormation stack
- B. Đóng gói code + dependencies vào `.aws-sam/build/` và chuẩn hoá template
- C. Shift traffic theo canary
- D. Xoá stack cũ

**Câu 9.** Developer cần một DynamoDB table có **GSI và stream** trong template SAM. Resource nào phù hợp?
- A. `AWS::Serverless::SimpleTable`
- B. `AWS::DynamoDB::Table`
- C. `AWS::Serverless::Function`
- D. `AWS::Serverless::Api`

**Câu 10.** Tổ chức muốn publish một ứng dụng serverless đóng gói SAM để các team khác discover và deploy lại. Dịch vụ nào?
- A. AWS CodeArtifact
- B. AWS Serverless Application Repository (SAR)
- C. Amazon ECR
- D. AWS Service Catalog Connector

### Đáp án & giải thích

**Câu 1 — Đáp án B.** `Transform: AWS::Serverless-2016-10-09` kích hoạt macro SAM để nở `AWS::Serverless::*` thành resource CFN gốc. A là phiên bản format của mọi template CFN, không đặc trưng SAM. C là resource Lambda thô (không phải dòng kích hoạt). D là tuỳ chọn, không bắt buộc.

**Câu 2 — Đáp án B.** Policy template `DynamoDBCrudPolicy` sinh đúng các action CRUD trên đúng table ARN — least-privilege, một dòng. A đúng kỹ thuật nhưng nhiều công nhất, dễ sai ARN. C vi phạm least-privilege (full access mọi table). D là anti-pattern bảo mật, không bao giờ embed key.

**Câu 3 — Đáp án B.** `sam local *` chạy function trong container nên **Docker bắt buộc**; Docker không chạy là lỗi phổ biến nhất. A sai: local không cần deploy. C/D không gây lỗi kết nối local API (region/samconfig liên quan deploy).

**Câu 4 — Đáp án B.** Canary cần `AutoPublishAlias` (tạo version+alias) làm nền, `DeploymentPreference.Type: Canary10Percent5Minutes` để CodeDeploy shift, và `Alarms` để auto-rollback. A shift toàn bộ ngay, không canary. C mới chỉ publish alias, chưa shift theo % hay rollback. D không liên quan traffic shifting.

**Câu 5 — Đáp án B.** Hook PHẢI gọi `PutLifecycleEventHookExecutionStatus` báo `Succeeded`; nếu không, CodeDeploy chờ tới timeout, coi như Failed và rollback — đúng triệu chứng. A sai: đề nói có hook, và thiếu alarm không gây kẹt. C không gây treo deployment. D thì sẽ không có canary ngay từ đầu chứ không "kẹt".

**Câu 6 — Đáp án B.** SAM tạo IAM execution role nên CloudFormation yêu cầu xác nhận `CAPABILITY_IAM` (hoặc `CAPABILITY_NAMED_IAM`). A sai: lỗi cú pháp báo khác. C/D không phải nguyên nhân của thông báo capabilities này.

**Câu 7 — Đáp án B.** `sam sync --watch` (SAM Accelerate) đẩy thẳng code qua `UpdateFunctionCode`, bỏ ChangeSet, rút ngắn inner-loop dev. A chỉ build. C test cục bộ một lần, không sync lên AWS liên tục. D chỉ đóng gói/upload, không deploy nhanh.

**Câu 8 — Đáp án B.** `sam build` cài dependencies và đóng gói artifact vào `.aws-sam/build/`, sinh template chuẩn hoá để deploy. A là `sam deploy`. C là việc của CodeDeploy khi deploy. D là `sam delete`.

**Câu 9 — Đáp án B.** `SimpleTable` chỉ tạo table khoá đơn giản, không hỗ trợ GSI/LSI/stream → phải dùng `AWS::DynamoDB::Table` đầy đủ (SAM cho phép trộn resource CFN gốc). A không đủ. C/D là function/api, không phải table.

**Câu 10 — Đáp án B.** SAR là kho publish/discover ứng dụng serverless đóng gói bằng SAM; nhúng lại qua `AWS::Serverless::Application`. A quản lý package npm/pip (Chương 42). C cho container image. D không phải dịch vụ publish app serverless.

## Tóm tắt chương

- **SAM** là framework IaC chuyên serverless, là **superset của CloudFormation**; dòng `Transform: AWS::Serverless-2016-10-09` biến template thành SAM và nở các resource ngắn gọn thành CFN gốc khi deploy.
- Resource cốt lõi: `AWS::Serverless::Function`, `::Api`, `::HttpApi`, `::SimpleTable`, `::StateMachine`; `Globals` đặt thuộc tính dùng chung (Runtime, Timeout, Memory, Env) cho mọi function.
- `Events` (Api/HttpApi, S3, SQS, SNS, Schedule...) khai báo trigger ngay trong function; SAM tự tạo permission/integration tương ứng.
- **Policy templates** (`DynamoDBCrudPolicy`, `SQSPollerPolicy`, `S3ReadPolicy`...) cấp IAM least-privilege gọn gàng — cách ưu tiên để cấp quyền cho function.
- Vòng đời CLI: `sam build` (đóng gói vào `.aws-sam/build/`) → `sam deploy --guided` (upload S3 staging, tạo ChangeSet, cần `CAPABILITY_IAM`) → `sam delete`.
- `sam local invoke` / `start-api` / `start-lambda` test cục bộ qua **Docker**; `sam local generate-event` sinh payload mẫu cho nhiều nguồn sự kiện.
- **Safe deployment**: `AutoPublishAlias` tạo version+alias; `DeploymentPreference` (Canary/Linear/AllAtOnce) để CodeDeploy shift traffic; `Hooks` (PreTraffic/PostTraffic) smoke test; `Alarms` auto-rollback.
- Lifecycle hook PHẢI gọi `codedeploy:PutLifecycleEventHookExecutionStatus`; quên gọi khiến deploy treo rồi rollback — bẫy thực tế hàng đầu.
- **`sam sync` (SAM Accelerate)** đẩy thẳng code bỏ ChangeSet, tăng tốc inner-loop dev — chỉ cho dev/test, không production.
- **SAR (Serverless Application Repository)** để publish/discover và tái dùng ứng dụng SAM qua `AWS::Serverless::Application`.
- So với CloudFormation thuần: SAM viết ngắn hơn nhiều lần cho serverless và tích hợp sẵn traffic shifting; vẫn dùng được mọi resource CFN gốc khi cần (ví dụ DynamoDB có GSI/stream dùng `AWS::DynamoDB::Table`).
- CodeDeploy lifecycle hooks và deployment config chi tiết ở Chương 41; CDK (so sánh với SAM) ở Chương 37.
