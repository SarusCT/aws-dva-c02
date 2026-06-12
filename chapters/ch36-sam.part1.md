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
