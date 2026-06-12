# Chương 36: AWS SAM — Serverless Application Model

> **Trọng tâm DVA-C02:** SAM xuất hiện đều đặn ở domain Deployment (24%) và Development (32%). Đề hay hỏi: phần `Transform` bắt buộc trong template, ý nghĩa các resource rút gọn (`AWS::Serverless::Function`, `Api`, `SimpleTable`), khác biệt giữa `sam build`/`package`/`deploy`, cách `sam local invoke` mô phỏng Lambda bằng Docker, policy templates (DynamoDBCrudPolicy...) thay cho viết IAM policy tay, và đặc biệt là **canary/linear deployment cho Lambda alias qua `DeploymentPreference` + CodeDeploy** với hook PreTraffic/PostTraffic và rollback theo CloudWatch alarm. Câu hỏi thường ở dạng "deploy Lambda mới mà giảm rủi ro, tự rollback khi lỗi tăng — chọn gì?".

## Mục tiêu chương
- Hiểu SAM là **CloudFormation extension** (macro `AWS::Serverless-2016-10-31`) chứ không phải một dịch vụ riêng, và vì sao nó rút ngắn template serverless tới 80%.
- Viết được SAM template với `Globals`, `Function`, `Api`/`HttpApi`, `SimpleTable`, `StateMachine`; gắn event sources (API, S3, SQS, Schedule).
- Thành thạo vòng đời `sam build → package → deploy --guided` và test cục bộ với `sam local invoke / start-api / start-lambda / generate-event`.
- Dùng **policy templates** thay vì viết IAM JSON tay, và biết khi nào phải fallback về policy thường.
- Cấu hình **safe deployment** cho Lambda: `AutoPublishAlias` + `DeploymentPreference` (Canary/Linear) + CodeDeploy hooks + alarm rollback.
- Hiểu **SAM Accelerate (`sam sync`)**, **SAR (Serverless Application Repository)**, và quyết định khi nào dùng SAM vs CloudFormation thuần vs CDK (chi tiết CDK ở Chương 37).

## 36.1 SAM là gì — một macro CloudFormation, không phải dịch vụ riêng

AWS SAM (Serverless Application Model) gồm hai thứ tách biệt mà người mới hay nhầm:

1. **SAM template specification** — một tập cú pháp YAML/JSON *mở rộng* CloudFormation, khai báo bằng dòng `Transform: AWS::Serverless-2016-10-31`. Đây là một **CloudFormation macro** chạy phía AWS: khi bạn submit stack, CloudFormation gọi transform để "nở" (expand) các resource `AWS::Serverless::*` thành tài nguyên CloudFormation thật (`AWS::Lambda::Function`, `AWS::IAM::Role`, `AWS::ApiGateway::RestApi`, `AWS::Lambda::Permission`...).
2. **SAM CLI** — công cụ dòng lệnh (`sam`) chạy trên máy bạn để build, test cục bộ bằng Docker, đóng gói và deploy. SAM CLI **không** bắt buộc — bạn có thể deploy SAM template bằng `aws cloudformation deploy` thuần, nhưng mất các tính năng build/local.

Điểm cốt lõi cho đề thi: **SAM template CHÍNH LÀ CloudFormation template**. Bạn được phép trộn resource SAM rút gọn với resource CloudFormation đầy đủ trong cùng một file. Mọi intrinsic function (`Ref`, `Fn::GetAtt`, `Fn::Sub`, `!ImportValue`...) đều dùng được (chi tiết CloudFormation ở Chương 19–20).

Ví dụ kinh điển — một function HTTP đầy đủ chỉ vài dòng:

```yaml
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31      # BẮT BUỘC — biến file thành SAM template
Description: Hello API bằng SAM

Resources:
  HelloFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: src/                          # thư mục chứa code
      Handler: app.lambdaHandler             # file app.js, export lambdaHandler
      Runtime: nodejs20.x
      Events:
        GetHello:
          Type: Api                          # tạo luôn API Gateway + permission
          Properties:
            Path: /hello
            Method: get
```

Khi transform nở ra, AWS tự sinh: Lambda function, IAM execution role (kèm `AWSLambdaBasicExecutionRole`), REST API, deployment, stage, và `AWS::Lambda::Permission` cho API Gateway gọi function. Viết tay CloudFormation cho từng cái này tốn khoảng 80–100 dòng. Đó là toàn bộ giá trị của SAM.

> 💡 **Exam Tip:** Nếu thiếu dòng `Transform: AWS::Serverless-2016-10-31`, CloudFormation sẽ báo lỗi *"Invalid template resource property 'Type'... Unrecognized resource type AWS::Serverless::Function"*. Dòng `Transform` là dấu hiệu nhận diện một SAM template trong câu hỏi.

## 36.2 Globals và các resource type cốt lõi

### Section Globals — DRY cho thuộc tính lặp lại

`Globals` là section *chỉ có ở SAM* (không phải CloudFormation chuẩn), cho phép đặt thuộc tính dùng chung cho mọi resource cùng loại, tránh lặp lại. Hỗ trợ cho `Function`, `Api`, `HttpApi`, `SimpleTable`, `StateMachine`.

```yaml
Globals:
  Function:
    Runtime: nodejs20.x
    Timeout: 10                    # giây — mọi function mặc định 10s nếu không override
    MemorySize: 256
    Tracing: Active                # bật X-Ray active tracing cho TẤT CẢ function
    Environment:
      Variables:
        TABLE_NAME: !Ref OrdersTable
  Api:
    Cors:
      AllowMethods: "'GET,POST,OPTIONS'"
      AllowOrigin: "'*'"
```

Quy tắc merge: thuộc tính ở resource **override** Globals; với map (như `Environment.Variables`) thì merge theo key; với danh sách thì resource **thay thế hoàn toàn**, không nối thêm.

### Các resource type SAM cần nhớ

| Resource SAM | Nở ra (CloudFormation) | Dùng khi |
|---|---|---|
| `AWS::Serverless::Function` | Lambda Function + IAM Role + EventSourceMapping + Permission | Mọi Lambda |
| `AWS::Serverless::Api` | API Gateway **REST API** + Deployment + Stage | REST API có VTL, usage plan, WAF |
| `AWS::Serverless::HttpApi` | API Gateway **HTTP API** (v2) | API nhẹ, rẻ, latency thấp, JWT auth |
| `AWS::Serverless::SimpleTable` | DynamoDB table (chỉ primary key, on-demand mặc định) | Table đơn giản, không GSI/LSI |
| `AWS::Serverless::StateMachine` | Step Functions state machine + IAM role | Workflow (chi tiết Chương 43) |
| `AWS::Serverless::LayerVersion` | Lambda LayerVersion | Chia sẻ thư viện chung |
| `AWS::Serverless::Application` | Nested stack từ SAR/file | Tái dùng app từ SAR |

> 💡 **Exam Tip:** `SimpleTable` chỉ tạo được table với primary key đơn giản (hash + optional range), mặc định **billing mode on-demand (PAY_PER_REQUEST)**. Cần GSI, LSI, stream, hay provisioned capacity tinh chỉnh → dùng `AWS::DynamoDB::Table` thường (vẫn hợp lệ trong SAM template).

`Api` vs `HttpApi` là điểm dễ bị gài: HTTP API rẻ hơn ~70%, latency thấp hơn, hỗ trợ JWT authorizer native; nhưng REST API mới có request validation, API keys/usage plans, VTL mapping templates, edge-optimized endpoint (so sánh chi tiết ở Chương 35).

## 36.3 Events — gắn trigger cho Function

`Events` trong `AWS::Serverless::Function` là nơi SAM tỏa sáng: khai báo event source, SAM tự tạo cả trigger lẫn IAM permission/resource cần thiết.

```yaml
Resources:
  ProcessorFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: src/processor/
      Handler: index.handler
      Events:
        # 1. API Gateway
        ApiEvent:
          Type: Api
          Properties: { Path: /orders, Method: post }
        # 2. S3 — SAM tự cấu hình bucket notification + permission
        S3Upload:
          Type: S3
          Properties:
            Bucket: !Ref UploadBucket
            Events: s3:ObjectCreated:*
        # 3. SQS — tạo EventSourceMapping, role poll queue
        QueueConsumer:
          Type: SQS
          Properties:
            Queue: !GetAtt JobQueue.Arn
            BatchSize: 10
        # 4. Schedule — EventBridge rule cron/rate
        DailyJob:
          Type: Schedule
          Properties:
            Schedule: rate(1 day)
```

Mỗi `Type` (Api, HttpApi, S3, SQS, SNS, Kinesis, DynamoDB, Schedule, EventBridgeRule, Cognito...) sinh tài nguyên tương ứng. Với S3, SAM còn xử lý vòng phụ thuộc tuần hoàn (bucket cần biết function, function cần permission từ bucket) — một bài toán khó nếu viết CloudFormation tay.

> 💡 **Exam Tip:** Với event `Type: S3`, **bucket phải được khai báo trong cùng template** (SAM cần sửa NotificationConfiguration của bucket). Không thể trỏ event S3 tới bucket đã tồn tại bên ngoài stack — đó là bẫy hay gặp; trường hợp bucket có sẵn, dùng EventBridge hoặc cấu hình notification riêng.

## 36.4 Policy templates — IAM gọn gàng không cần viết JSON

Mặc định mỗi `AWS::Serverless::Function` được cấp một execution role với `AWSLambdaBasicExecutionRole` (ghi log CloudWatch). Để cấp thêm quyền, thay vì viết IAM policy JSON, SAM cung cấp **policy templates** — các khuôn quyền có sẵn, nhận tham số (thường là tên/ARN resource) và sinh ra least-privilege policy.

```yaml
  OrderFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: src/
      Handler: app.handler
      Policies:
        # Policy template — chỉ cần tên table
        - DynamoDBCrudPolicy:
            TableName: !Ref OrdersTable
        - SQSPollerPolicy:
            QueueName: !GetAtt JobQueue.QueueName
        - S3ReadPolicy:
            BucketName: !Ref UploadBucket
        # Trộn được policy JSON thường khi template không có sẵn
        - Statement:
            - Effect: Allow
              Action: kms:Decrypt
              Resource: !GetAtt MyKey.Arn
        # Hoặc gắn managed policy ARN
        - arn:aws:iam::aws:policy/AmazonSESFullAccess
```

Các policy template hay gặp trong đề: `DynamoDBCrudPolicy`, `DynamoDBReadPolicy`, `SQSPollerPolicy`, `SQSSendMessagePolicy`, `S3ReadPolicy`, `S3CrudPolicy`, `SNSPublishMessagePolicy`, `KMSDecryptPolicy`, `SSMParameterReadPolicy`, `LambdaInvokePolicy`, `VPCAccessPolicy`. Mỗi template ánh xạ sang một bộ action least-privilege — ví dụ `DynamoDBCrudPolicy` cấp GetItem, PutItem, UpdateItem, DeleteItem, Query, Scan, BatchGet/Write... *chỉ trên đúng table ARN* (kèm cả index ARN `table/*/index/*`).

> 💡 **Exam Tip:** `Policies` là property của Function. Bạn có thể trộn 3 dạng trong cùng một list: policy template (map có tham số), IAM statement thô (`Statement:`), và managed policy ARN (chuỗi). Nếu đề hỏi "cách least-privilege gọn nhất để function đọc/ghi DynamoDB", đáp án là **DynamoDBCrudPolicy với TableName**, không phải `AmazonDynamoDBFullAccess`.

## 36.5 Vòng đời SAM CLI: init → build → package → deploy

### sam init

`sam init` tạo scaffold project từ template mẫu (Hello World, theo runtime). Sinh `template.yaml`, code mẫu, và file cấu hình.

### sam build — biên dịch & gom dependency

```bash
sam build                      # build mọi function, output ra .aws-sam/build/
sam build --use-container      # build TRONG Docker giống môi trường Lambda
```

`sam build` đọc `template.yaml`, với mỗi function: cài dependency (npm install, pip install...), copy code vào `.aws-sam/build/<FunctionName>/`, và sinh một `template.yaml` mới trong `.aws-sam/build/` đã trỏ `CodeUri` tới thư mục build. **`--use-container`** dùng image `public.ecr.aws/sam/build-<runtime>` để build trong môi trường giống Lambda — bắt buộc khi có native dependency (ví dụ thư viện compile C như `bcrypt`, `sharp`) để tránh lỗi "works on my machine".

### sam package — upload artifact lên S3

```bash
sam package \
  --output-template-packaged.yaml packaged.yaml \
  --s3-bucket my-sam-artifacts
```

`package` zip code, upload lên S3, rồi thay `CodeUri: src/` (đường dẫn cục bộ) bằng `CodeUri: s3://bucket/key`. CloudFormation **không** đọc được code cục bộ — phải nằm trên S3 (hoặc ECR với container image). Bước này tương đương `aws cloudformation package`.

### sam deploy — tạo/cập nhật stack

```bash
sam deploy --guided        # lần đầu — hỏi tương tác, lưu vào samconfig.toml
sam deploy                 # các lần sau dùng lại samconfig.toml
```

`sam deploy` thực chất gọi CloudFormation tạo **ChangeSet** rồi execute. `--guided` hỏi: stack name, region, có cho phép tạo IAM role không (`CAPABILITY_IAM`), confirm changeset, lưu config. Kết quả ghi vào `samconfig.toml` để lần sau chạy `sam deploy` gọn.

Điểm hay quên: SAM template tạo IAM role nên deploy cần **capabilities**. SAM CLI tự thêm `CAPABILITY_IAM`; nếu function đặt tên role rõ ràng cần `CAPABILITY_NAMED_IAM`; nếu dùng macro/nested cần `CAPABILITY_AUTO_EXPAND`.

| Lệnh | Làm gì | Tương đương CloudFormation |
|---|---|---|
| `sam build` | Cài dependency, gom code vào `.aws-sam/build` | (không có) |
| `sam package` | Zip + upload S3, rewrite CodeUri | `aws cloudformation package` |
| `sam deploy` | ChangeSet + execute | `aws cloudformation deploy` |

> 💡 **Exam Tip:** `sam deploy` (không `--guided`) tự động chạy package bên trong nếu phát hiện CodeUri cục bộ, nên thực tế chỉ cần `sam build && sam deploy`. Nhưng đề có thể tách rõ 3 bước; nhớ thứ tự **build → package → deploy** và rằng **deploy = tạo và execute ChangeSet qua CloudFormation**, không phải gọi thẳng Lambda API.

## 36.6 Test cục bộ: sam local & generate-event

SAM CLI mô phỏng Lambda **bằng Docker** trên máy bạn — đây là khác biệt lớn so với CloudFormation thuần. Yêu cầu: Docker phải chạy.

```bash
# Invoke 1 lần với event giả lập
sam local invoke ProcessorFunction --event events/sqs.json

# Sinh sample event đúng schema của service
sam local generate-event sqs receive-message > events/sqs.json
sam local generate-event s3 put > events/s3.json
sam local generate-event apigateway aws-proxy > events/api.json

# Chạy local API Gateway tại http://127.0.0.1:3000
sam local start-api

# Giả lập Lambda service endpoint để SDK gọi Invoke
sam local start-lambda
```

- **`sam local invoke`**: chạy function một lần trong container, đọc event từ `--event` (hoặc stdin), in kết quả + log. Hữu ích cho event-driven function (SQS/S3/Kinesis).
- **`sam local generate-event <service> <event>`**: in ra JSON mẫu đúng cấu trúc payload thật của service — tránh phải bịa tay event S3/SQS/API.
- **`sam local start-api`**: dựng HTTP server cục bộ map các `Events: Type: Api/HttpApi` thành route thật, mỗi request khởi một container.
- **`sam local start-lambda`**: dựng một endpoint giả lập Lambda Invoke API; bạn trỏ AWS SDK tới `http://127.0.0.1:3001` (qua `endpoint`) để test code gọi Lambda, hoặc dùng cho integration test.

Hạn chế quan trọng cho đề: local emulation **không mô phỏng IAM/permission, network VPC, hay quota chính xác**; cold start và timing khác production. Nó test logic + tích hợp, không thay thế test trên cloud.

```javascript
// Gọi local Lambda từ test bằng SDK v3 — trỏ endpoint về start-lambda
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const client = new LambdaClient({
  endpoint: "http://127.0.0.1:3001",   // sam local start-lambda
  region: "us-east-1",
});
const res = await client.send(new InvokeCommand({
  FunctionName: "ProcessorFunction",
  Payload: Buffer.from(JSON.stringify({ key: "value" })),
}));
console.log(Buffer.from(res.Payload).toString());
```

> 💡 **Exam Tip:** `sam local *` **cần Docker**. Nếu câu hỏi nói "test Lambda cục bộ trước khi deploy, mô phỏng API Gateway endpoint" → `sam local start-api`. "Sinh event mẫu để test" → `sam local generate-event`.

## 36.7 Safe deployment cho Lambda: AutoPublishAlias + DeploymentPreference + CodeDeploy

Đây là **section nặng điểm thi nhất** của chương. Bài toán: bạn deploy code Lambda mới. Nếu version mới có bug, mọi traffic dính ngay lập tức. SAM giải quyết bằng cách tích hợp **CodeDeploy** để dịch chuyển traffic dần dần (traffic shifting) trên một **alias**, kèm rollback tự động theo CloudWatch alarm.

Cơ chế bên dưới: SAM tạo Lambda **version** mới mỗi lần deploy (qua `AutoPublishAlias`), gắn alias trỏ tới version đó, rồi tạo một **CodeDeploy application + deployment group** dùng `DeploymentConfig` kiểu Canary/Linear để dời `routing weight` của alias từ version cũ sang version mới (chi tiết CodeDeploy ở Chương 41).

```yaml
Resources:
  ApiFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: src/
      Handler: app.handler
      Runtime: nodejs20.x
      AutoPublishAlias: live                # tạo & quản lý alias "live", publish version mới mỗi deploy
      DeploymentPreference:
        Type: Canary10Percent5Minutes       # 10% traffic trong 5 phút, rồi 100%
        Alarms:                              # rollback nếu alarm vào trạng thái ALARM
          - !Ref ApiErrorAlarm
        Hooks:
          PreTraffic: !Ref PreTrafficHook    # Lambda chạy TRƯỚC khi shift traffic
          PostTraffic: !Ref PostTrafficHook  # Lambda chạy SAU khi shift xong
      Events:
        Api:
          Type: Api
          Properties: { Path: /, Method: get }

  ApiErrorAlarm:
    Type: AWS::CloudWatch::Alarm
    Properties:
      MetricName: Errors
      Namespace: AWS/Lambda
      Dimensions:
        - Name: Resource
          Value: ApiFunction:live            # giám sát đúng alias
      Statistic: Sum
      Period: 60
      EvaluationPeriods: 2
      Threshold: 1
      ComparisonOperator: GreaterThanOrEqualToThreshold
```

### Các kiểu DeploymentPreference.Type

| Type | Hành vi |
|---|---|
| `Canary10Percent5Minutes` | 10% trong 5 phút → 100% |
| `Canary10Percent30Minutes` | 10% trong 30 phút → 100% |
| `Linear10PercentEvery1Minute` | +10% mỗi 1 phút (10 bước) |
| `Linear10PercentEvery10Minutes` | +10% mỗi 10 phút |
| `AllAtOnce` | Dời 100% ngay (không có canary) |

**Canary** = hai bước nhảy (một phần nhỏ rồi toàn bộ). **Linear** = tăng đều theo từng nấc. **AllAtOnce** = không an toàn, dùng cho dev.

### Hooks PreTraffic / PostTraffic

Hooks là **Lambda function của riêng bạn** mà CodeDeploy gọi trong lifecycle deployment:
- **PreTraffic**: chạy *trước* khi bất kỳ traffic nào tới version mới — dùng để smoke test version mới (gọi thử, kiểm tra kết quả). Hook **phải** báo lại kết quả cho CodeDeploy qua `codedeploy.putLifecycleEventHookExecutionStatus` (Succeeded/Failed). Failed → hủy deployment, không shift.
- **PostTraffic**: chạy *sau* khi đã shift 100% — dùng kiểm thử end-to-end, integration test, cleanup.

```javascript
// PreTraffic hook — bắt buộc gọi putLifecycleEventHookExecutionStatus
import { CodeDeployClient, PutLifecycleEventHookExecutionStatusCommand }
  from "@aws-sdk/client-codedeploy";

const cd = new CodeDeployClient({});

export const handler = async (event) => {
  const { DeploymentId, LifecycleEventHookExecutionId } = event;
  let status = "Succeeded";
  try {
    // ... smoke test version mới ở đây (invoke, kiểm tra response) ...
  } catch (e) {
    status = "Failed";               // Failed => CodeDeploy rollback
  }
  await cd.send(new PutLifecycleEventHookExecutionStatusCommand({
    deploymentId: DeploymentId,
    lifecycleEventHookExecutionId: LifecycleEventHookExecutionId,
    status,                          // Succeeded | Failed
  }));
  return status;
};
```

### Rollback qua Alarms

Trong khi traffic đang được shift, nếu bất kỳ alarm nào trong `Alarms` chuyển sang `ALARM`, CodeDeploy **tự động rollback**: dời 100% traffic về version cũ. Đây chính là pattern an toàn mà đề mô tả: "deploy Lambda giảm rủi ro, tự rollback khi error rate tăng".

> 💡 **Exam Tip:** Khi câu hỏi nêu "shift traffic gradually to new Lambda version, automatically roll back if errors spike" — đáp án là **SAM `DeploymentPreference` với Canary/Linear + CodeDeploy + CloudWatch Alarms**. `AutoPublishAlias` là điều kiện bắt buộc đi kèm (phải có alias để CodeDeploy dịch traffic). PreTraffic hook = validate *trước* khi cho traffic vào; PostTraffic = *sau* khi đã shift.

## 36.8 SAM Accelerate (sam sync), SAR và so sánh với CloudFormation thuần

### sam sync — vòng lặp dev nhanh (SAM Accelerate)

`sam build && sam deploy` qua ChangeSet mất hàng phút — quá chậm khi đang code. **`sam sync`** (SAM Accelerate) rút ngắn vòng lặp bằng cách bỏ qua ChangeSet và cập nhật trực tiếp khi có thể.

```bash
sam sync --watch --stack-name dev-app
```

- `--watch`: theo dõi file thay đổi, tự đồng bộ.
- Nếu chỉ **code Lambda** đổi → `sam sync` gọi thẳng **Lambda UpdateFunctionCode API**, bỏ qua CloudFormation hoàn toàn (vài giây).
- Nếu **infrastructure** (template) đổi → fallback về CloudFormation deploy.
- `--code` để chỉ đồng bộ code, không động tới hạ tầng.

> 💡 **Exam Tip:** `sam sync --watch` là công cụ **inner-loop development** — cập nhật cực nhanh nhưng làm stack **drift** so với CloudFormation (vì cập nhật trực tiếp Lambda). **Không dùng cho production**; production deploy bằng `sam deploy` (qua ChangeSet) trong pipeline.

### SAR — Serverless Application Repository

SAR là "kho ứng dụng serverless" công khai/riêng tư. Bạn publish một SAM application (template + code) lên SAR; người khác deploy nó vào account của họ chỉ bằng vài click hoặc tham chiếu trong template qua `AWS::Serverless::Application`.

```yaml
Resources:
  MyNestedApp:
    Type: AWS::Serverless::Application
    Properties:
      Location:
        ApplicationId: arn:aws:serverlessrepo:us-east-1:123456789012:applications/my-app
        SemanticVersion: 1.2.0
      Parameters:
        TableName: orders
```

SAR application có thể **public** (ai cũng deploy được) hoặc **private/shared** trong org. `AWS::Serverless::Application` thực chất tạo một **nested stack** từ template của app đó. Đây là cách tái sử dụng kiến trúc serverless đã đóng gói (ví dụ: một app gửi alert Slack, một auth layer).

### So sánh SAM vs CloudFormation thuần vs CDK

| Tiêu chí | SAM | CloudFormation thuần | CDK (Chương 37) |
|---|---|---|---|
| Ngôn ngữ | YAML/JSON + macro | YAML/JSON | TypeScript/Python/Java... |
| Độ dài cho serverless | Rất ngắn (transform nở ra) | Dài, lặp | Ngắn, lập trình được |
| Local testing | `sam local` (Docker) tốt nhất | Không | Dùng được SAM CLI qua `cdk synth` |
| Traffic shifting Lambda | `DeploymentPreference` built-in | Phải tự ghép CodeDeploy | Construct hoặc dùng SAM |
| Phạm vi | Tập trung serverless | Mọi resource AWS | Mọi resource AWS |
| Phía sau | Là CloudFormation | — | Synth ra CloudFormation |

Kết luận chọn lựa: dùng **SAM** khi stack chủ yếu là Lambda/API Gateway/DynamoDB/Step Functions và muốn local test + safe deploy nhanh gọn. Dùng **CloudFormation thuần** khi không phải serverless hoặc cần kiểm soát mọi resource thô. Dùng **CDK** khi muốn viết hạ tầng bằng ngôn ngữ lập trình thật, có vòng lặp/điều kiện phức tạp, tái dùng construct (CDK vẫn synth ra CloudFormation và có thể test local qua SAM CLI).

> 💡 **Exam Tip:** Nhớ ba điều dễ bị gài: (1) SAM template **là** CloudFormation — trộn resource thường được; (2) SAM **không** phải dịch vụ deploy riêng, nó dùng CloudFormation bên dưới; (3) thế mạnh độc nhất của SAM so với CloudFormation thuần là **local testing (`sam local`)** và **gradual deployment built-in (`DeploymentPreference`)**.

### Một template hoàn chỉnh gói gọn cả chương

```yaml
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Globals:
  Function:
    Runtime: nodejs20.x
    Timeout: 15
    Tracing: Active
    Environment:
      Variables: { TABLE: !Ref OrdersTable }
Resources:
  OrdersTable:
    Type: AWS::Serverless::SimpleTable        # DynamoDB on-demand, PK đơn giản
    Properties:
      PrimaryKey: { Name: orderId, Type: String }
  ApiFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: src/
      Handler: app.handler
      AutoPublishAlias: live                   # bật alias cho safe deploy
      DeploymentPreference:
        Type: Linear10PercentEvery1Minute
        Alarms: [ !Ref ErrAlarm ]
      Policies:
        - DynamoDBCrudPolicy: { TableName: !Ref OrdersTable }
      Events:
        Post: { Type: Api, Properties: { Path: /orders, Method: post } }
  ErrAlarm:
    Type: AWS::CloudWatch::Alarm
    Properties:
      MetricName: Errors
      Namespace: AWS/Lambda
      Dimensions: [ { Name: Resource, Value: ApiFunction:live } ]
      Statistic: Sum
      Period: 60
      EvaluationPeriods: 1
      Threshold: 1
      ComparisonOperator: GreaterThanOrEqualToThreshold
Outputs:
  ApiUrl:
    Value: !Sub "https://${ServerlessRestApi}.execute-api.${AWS::Region}.amazonaws.com/Prod/orders"
```

Template này gói: SimpleTable, Function với least-privilege qua policy template, X-Ray tracing qua Globals, REST API tự sinh, và linear safe deployment có rollback theo alarm — toàn bộ trong ~35 dòng mà CloudFormation thuần cần hàng trăm. Đó là lý do SAM là lựa chọn mặc định cho serverless trên AWS.

---

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
