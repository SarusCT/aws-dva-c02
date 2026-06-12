# Chương 37: AWS CDK — Cloud Development Kit

> **Trọng tâm DVA-C02:** CDK xuất hiện trong domain Deployment dưới dạng câu hỏi "team muốn viết Infrastructure as Code bằng ngôn ngữ lập trình (TypeScript/Python) thay vì YAML thuần — chọn gì?" hoặc "lệnh nào dùng để chuẩn bị môi trường trước khi deploy CDK lần đầu?" (đáp án: `cdk bootstrap`). Đề hay phân biệt CDK vs SAM vs CloudFormation, hỏi về constructs L1/L2/L3, `grant*` methods để cấp quyền IAM tự động, và mối quan hệ "CDK synth ra CloudFormation template". Bạn cần thuộc vòng đời lệnh `synth → diff → deploy → destroy` và hiểu CDK KHÔNG phải là engine riêng — nó generate ra CloudFormation rồi để CloudFormation deploy.

## Mục tiêu chương
- Hiểu CDK là gì, vì sao dùng ngôn ngữ lập trình để định nghĩa hạ tầng, và CDK khác SAM/CloudFormation/Terraform ở đâu.
- Nắm cấu trúc một CDK app: `App` → `Stack` → `Construct`, và phân biệt construct L1 (Cfn*) / L2 / L3 (patterns).
- Thuộc vòng đời lệnh CDK: `init`, `synth`, `diff`, `deploy`, `destroy`, và đặc biệt `bootstrap`.
- Viết được một stack hoàn chỉnh Lambda + API Gateway + DynamoDB bằng TypeScript, dùng `grant*` để cấp quyền IAM tự động.
- Hiểu assets, environment (account/region), context, feature flags, aspects, tags.
- Biết cách test CDK (assertions + snapshot), test local bằng SAM CLI, và CDK Pipelines ở mức nhận diện.

## 37.1 CDK là gì và vì sao tồn tại

AWS CDK (Cloud Development Kit) là framework Infrastructure as Code (IaC) cho phép bạn định nghĩa hạ tầng AWS bằng **ngôn ngữ lập trình quen thuộc** — TypeScript, JavaScript, Python, Java, C#, Go — thay vì viết YAML/JSON thuần như CloudFormation (Chương 19–20).

Điểm mấu chốt phải khắc cốt ghi tâm cho đề thi: **CDK không phải là một deployment engine độc lập**. Khi bạn chạy `cdk synth`, CDK chạy code của bạn, dựng nên một cây construct (construct tree) trong bộ nhớ, rồi **"tổng hợp" (synthesize) ra một CloudFormation template** (file JSON trong thư mục `cdk.out/`). Sau đó `cdk deploy` đẩy template đó lên CloudFormation, và chính **CloudFormation** mới là dịch vụ tạo/sửa/xoá resource thật. Nói cách khác:

```
Code TypeScript  --(cdk synth)-->  CloudFormation template  --(cdk deploy)-->  CloudFormation Stack  -->  Resources thật
```

Vì sao điều này quan trọng? Vì mọi giới hạn của CloudFormation đều áp dụng cho CDK: rollback khi lỗi, drift detection, stack quota (500 resources/stack — lưu ý quota này khi một L3 construct sinh ra hàng chục resource), Export/ImportValue cho cross-stack reference. CDK chỉ là lớp "trình biên dịch" sinh ra template.

Vấn đề CloudFormation thuần gặp phải mà CDK giải quyết:
- **Lặp code khủng khiếp:** Tạo 3 môi trường (dev/staging/prod) gần giống nhau trong YAML phải copy-paste hoặc dùng Conditions/Mappings rối rắm. Với CDK, bạn viết một class và `new MyStack(app, 'Dev', {...})` ba lần với tham số khác nhau.
- **Không có logic:** YAML không có vòng lặp, hàm, biến thực sự. CDK có `for`, `if`, hàm, kiểu dữ liệu — tận dụng toàn bộ sức mạnh ngôn ngữ.
- **IAM khó viết đúng:** Viết policy least-privilege bằng tay rất dễ sai. CDK có `grant*` tự sinh policy chính xác (mục 37.6).
- **Sensible defaults:** L2 construct tự đặt mặc định hợp lý (ví dụ encryption bật sẵn, log retention).

> 💡 **Exam Tip:** Khi đề mô tả "developer team đã quen TypeScript/Python và muốn dùng vòng lặp, điều kiện, abstraction khi viết IaC, đồng thời tận dụng IDE autocomplete và type checking" → đáp án là **AWS CDK**, không phải CloudFormation thuần hay SAM. Nếu đề nhấn "định nghĩa serverless app tối giản bằng YAML ngắn gọn" → đó là **SAM**.

## 37.2 CDK vs SAM vs CloudFormation vs Terraform

Bốn công cụ này hay bị gài bẫy trong đề. Bảng so sánh:

| Tiêu chí | CloudFormation | SAM | CDK | Terraform |
|---|---|---|---|---|
| Ngôn ngữ | YAML/JSON | YAML (mở rộng CFN) | TS/JS/Python/Java/C#/Go | HCL |
| Bản chất | Engine gốc của AWS | Transform của CFN (chạy trên CFN) | Sinh ra CFN template | Engine riêng (state file riêng) |
| Provider | AWS only | AWS only (serverless focus) | AWS only (chính) | Đa cloud |
| Logic lập trình | Hạn chế (Conditions/Mappings) | Hạn chế (như CFN) | Đầy đủ (ngôn ngữ thật) | Hạn chế (HCL functions) |
| Quản lý state | CloudFormation lo | CloudFormation lo | CloudFormation lo | State file tự quản (S3+DynamoDB lock) |
| Test unit | Khó | Khó | Có (jest/pytest + assertions) | Có (terratest) |
| Local invoke | Không | `sam local` | Qua SAM CLI (`cdk synth` + sam) | Không |
| Abstraction tái dùng | Nested stacks/Modules | Khó | Constructs (L1/L2/L3) | Modules |

Ý chính cho đề:
- **CloudFormation** là nền tảng — cả SAM lẫn CDK cuối cùng đều ra CloudFormation. SAM dùng `Transform: AWS::Serverless-2016-10-31` (macro mở rộng), CDK dùng `cdk synth`.
- **SAM** chuyên serverless (Lambda, API GW, DynamoDB SimpleTable, Step Functions), cú pháp YAML cực ngắn, có `sam local` để test offline (Chương 36).
- **CDK** đa năng hơn SAM (làm được mọi resource AWS, kể cả VPC, ECS, RDS...), dùng ngôn ngữ lập trình thật. CDK có thể nhúng SAM/CloudFormation construct.
- **Terraform** là sản phẩm của HashiCorp, **đa cloud**, có state file riêng — đề DVA-C02 hiếm khi yêu cầu chọn Terraform (vì là third-party), nhưng nếu đề nhấn "multi-cloud" thì Terraform là gợi ý.

> 💡 **Exam Tip:** Câu hỏi kinh điển: "Tổ chức cần IaC hoạt động trên cả AWS lẫn Azure/GCP" → **Terraform** (đa cloud), KHÔNG phải CDK/SAM/CloudFormation (chỉ AWS). Nhưng nếu đề chỉ nói AWS và "least operational overhead cho serverless" → SAM; "dùng ngôn ngữ lập trình + reusable components" → CDK.

## 37.3 Cấu trúc một CDK app: App, Stack, Construct

CDK tổ chức theo cây phân cấp ba tầng khái niệm:

- **App** (`cdk.App`): gốc của cây, đại diện cho toàn bộ ứng dụng CDK. Một app chứa một hoặc nhiều stack.
- **Stack** (`cdk.Stack`): đơn vị deploy, **ánh xạ 1-1 với một CloudFormation stack**. Mọi resource trong một Stack được deploy/rollback cùng nhau.
- **Construct**: khối xây dựng cơ bản. Mọi thứ trong CDK (kể cả Stack, App) đều là construct. Construct có thể chứa construct con → tạo thành cây.

Mọi construct nhận 3 tham số khi khởi tạo: `(scope, id, props)`.
- `scope`: construct cha (thường là `this` của stack).
- `id`: định danh logic **duy nhất trong phạm vi scope đó** — CDK dùng nó để sinh **Logical ID** trong CloudFormation (kết hợp path + hash). **Đổi `id` = CloudFormation coi là resource mới → xoá cũ tạo mới**, rất nguy hiểm với resource có state (DynamoDB, S3).
- `props`: cấu hình.

File entrypoint điển hình (`bin/my-app.ts` với TypeScript):

```typescript
#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { MyServiceStack } from '../lib/my-service-stack';

const app = new cdk.App();

// Mỗi lần new Stack = một CloudFormation stack riêng
new MyServiceStack(app, 'MyServiceStack-Dev', {
  env: { account: '111122223333', region: 'ap-southeast-1' },
});

new MyServiceStack(app, 'MyServiceStack-Prod', {
  env: { account: '999988887777', region: 'us-east-1' },
});

app.synth(); // tổng hợp ra cdk.out/
```

> 💡 **Exam Tip:** Một CDK Stack = một CloudFormation Stack. Khi đề hỏi "đơn vị deploy nhỏ nhất của CDK ánh xạ tới cái gì trong AWS?" → một **CloudFormation stack**. Đổi construct `id` có thể gây thay/xoá resource — nhớ điều này cho câu troubleshooting "vì sao DynamoDB table bị xoá sau khi refactor CDK".

## 37.4 Construct levels: L1, L2, L3

Đây là kiến thức bị hỏi nhiều nhất về CDK. Construct chia 3 cấp trừu tượng:

**L1 — Cfn resources (Layer 1):** ánh xạ 1-1 với resource CloudFormation, tên luôn bắt đầu `Cfn` (ví dụ `CfnBucket`, `CfnFunction`, `CfnTable`). Đây là lớp mỏng nhất, do AWS **tự sinh từ CloudFormation Resource Specification**. Bạn phải cấu hình **mọi** thuộc tính y như viết CloudFormation, không có default. Dùng L1 khi L2 chưa hỗ trợ thuộc tính mới hoặc cần escape hatch.

```typescript
import { CfnBucket } from 'aws-cdk-lib/aws-s3';
// L1: phải khai báo thuộc tính dạng raw như CloudFormation
new CfnBucket(this, 'RawBucket', {
  bucketName: 'my-raw-bucket',
  versioningConfiguration: { status: 'Enabled' },
});
```

**L2 — Curated constructs (Layer 2):** do AWS viết tay, có **sensible defaults**, có method tiện ích (`grant*`, `addEventNotification`, `metric*`), validation lúc synth. Đây là lớp dùng hàng ngày.

```typescript
import { Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
// L2: ngắn gọn, default hợp lý, có method tiện ích
const bucket = new Bucket(this, 'MyBucket', {
  versioned: true,
  encryption: BucketEncryption.S3_MANAGED,
});
bucket.grantRead(someLambda); // tự sinh IAM policy
```

**L3 — Patterns (Layer 3):** ghép nhiều resource thành một kiến trúc hoàn chỉnh theo best practice. Ví dụ `aws-ecs-patterns.ApplicationLoadBalancedFargateService` tạo luôn ALB + Fargate service + target group + security group + task definition. Một dòng L3 có thể sinh hàng chục resource.

```typescript
import { ApplicationLoadBalancedFargateService } from 'aws-cdk-lib/aws-ecs-patterns';
// L3: một pattern = cả kiến trúc ALB + Fargate
new ApplicationLoadBalancedFargateService(this, 'Svc', {
  cluster,
  taskImageOptions: { image: ContainerImage.fromRegistry('nginx') },
});
```

| Cấp | Tên gọi | Đặc điểm | Khi nào dùng |
|---|---|---|---|
| L1 | Cfn* | 1-1 với CloudFormation, không default, auto-generated | Resource/thuộc tính L2 chưa hỗ trợ, escape hatch |
| L2 | Curated | Default hợp lý, có `grant*`/`metric*`, validation | Mặc định nên dùng |
| L3 | Patterns | Ghép nhiều resource thành kiến trúc | Dựng nhanh kiến trúc chuẩn |

**Escape hatch:** khi L2 thiếu một thuộc tính, bạn truy xuống L1 bên dưới qua `node.defaultChild`:

```typescript
const cfnBucket = bucket.node.defaultChild as CfnBucket;
cfnBucket.addPropertyOverride('AccelerateConfiguration.AccelerationStatus', 'Enabled');
```

> 💡 **Exam Tip:** Nhớ quy ước: construct bắt đầu bằng `Cfn` → **L1**, ánh xạ trực tiếp resource CloudFormation, không có default. L2 = "curated" có `grant*` methods. L3 = "patterns" ghép sẵn nhiều resource. Câu hỏi: "construct nào ánh xạ 1-1 với CloudFormation resource?" → **L1 (Cfn)**.

## 37.5 Vòng đời lệnh CDK: init, bootstrap, synth, diff, deploy, destroy

Cài CDK Toolkit: `npm install -g aws-cdk` (lệnh `cdk`). Vòng đời lệnh:

**`cdk init`** — khởi tạo project mới từ template:
```bash
# Tạo skeleton app TypeScript trong thư mục rỗng
cdk init app --language typescript
```

**`cdk bootstrap`** — **lệnh thi hay hỏi nhất**. Trước khi deploy CDK lần đầu vào một **cặp account+region**, bạn phải bootstrap. Lệnh này deploy một stack tên `CDKToolkit` tạo các tài nguyên hạ tầng mà CDK cần: một **S3 bucket** (chứa assets như Lambda code, file template lớn), một **ECR repository** (chứa Docker image assets), và các **IAM roles** (deploy role, file-publishing role, lookup role...). SSM parameter `/cdk-bootstrap/.../version` lưu version bootstrap.

```bash
# Bootstrap account 111122223333 ở region ap-southeast-1
cdk bootstrap aws://111122223333/ap-southeast-1
```

Nếu quên bootstrap, deploy sẽ báo lỗi kiểu "This stack uses assets, so the toolkit stack must be deployed... Please run 'cdk bootstrap'".

**`cdk synth`** — chạy code, sinh CloudFormation template ra `cdk.out/` và in YAML ra stdout. Không cần quyền AWS để synth (chạy offline được, trừ khi dùng context lookup).
```bash
cdk synth                      # synth tất cả stack
cdk synth MyServiceStack-Dev   # synth một stack
```

**`cdk diff`** — so sánh stack local (sau synth) với stack đã deploy trên AWS, in ra resource/IAM/security thay đổi. Rất giống `git diff` cho hạ tầng — luôn chạy trước deploy.
```bash
cdk diff MyServiceStack-Dev
```

**`cdk deploy`** — synth rồi đẩy lên CloudFormation, tạo/cập nhật stack. CDK tự upload assets lên S3/ECR bootstrap, theo dõi tiến trình CloudFormation, in Outputs.
```bash
cdk deploy MyServiceStack-Dev
cdk deploy --all                          # deploy mọi stack
cdk deploy --require-approval never       # bỏ qua prompt phê duyệt thay đổi IAM
cdk deploy --hotswap                      # cập nhật nhanh Lambda code (CHỈ dev, bỏ qua CloudFormation)
```
`--hotswap` cập nhật trực tiếp một số resource (Lambda code, Step Functions definition, ECS) **bỏ qua CloudFormation** để nhanh hơn khi dev — **tuyệt đối không dùng cho production** vì sẽ gây drift.

**`cdk destroy`** — xoá stack (gọi CloudFormation delete).
```bash
cdk destroy MyServiceStack-Dev
```

Các lệnh phụ hữu ích: `cdk ls` (liệt kê stack), `cdk watch` (auto deploy khi code đổi, dùng hotswap), `cdk doctor` (chẩn đoán môi trường).

> 💡 **Exam Tip:** **`cdk bootstrap`** là lệnh BẮT BUỘC chạy **một lần cho mỗi cặp account+region** trước khi deploy CDK app dùng assets. Nó tạo S3 bucket, ECR repo và IAM roles (stack `CDKToolkit`). Nếu đề hỏi "lỗi khi deploy CDK lần đầu nói cần toolkit stack" → chạy `cdk bootstrap`. Đừng nhầm với `cdk init` (tạo project mới).

## 37.6 Stack hoàn chỉnh: Lambda + API Gateway + DynamoDB và grants

Ví dụ chính của chương — một REST API serverless. File `lib/api-stack.ts`:

```typescript
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Table, AttributeType, BillingMode } from 'aws-cdk-lib/aws-dynamodb';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { LambdaRestApi } from 'aws-cdk-lib/aws-apigateway';

export class ApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1) DynamoDB table — L2, on-demand, encryption mặc định bật
    const table = new Table(this, 'ItemsTable', {
      partitionKey: { name: 'id', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // CHỈ cho demo — prod để RETAIN
    });

    // 2) Lambda — NodejsFunction tự bundle bằng esbuild
    const handler = new NodejsFunction(this, 'ItemsHandler', {
      runtime: Runtime.NODEJS_20_X,
      entry: 'src/handler.ts',
      handler: 'main',
      environment: {
        TABLE_NAME: table.tableName, // truyền tên table qua env var
      },
    });

    // 3) GRANT — CDK tự sinh IAM policy least-privilege cho Lambda role
    table.grantReadWriteData(handler);

    // 4) API Gateway proxy tới Lambda
    const api = new LambdaRestApi(this, 'ItemsApi', {
      handler,
      proxy: true,
    });

    // 5) Output URL
    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url });
  }
}
```

Điểm vàng ở đây là **`table.grantReadWriteData(handler)`**. Một dòng này:
- Tự thêm IAM policy statement vào **execution role của Lambda** với đúng action (`dynamodb:GetItem`, `PutItem`, `UpdateItem`, `DeleteItem`, `Query`, `Scan`, `BatchWrite...`).
- Tự giới hạn `Resource` đúng ARN của table (và index nếu cần) — **least privilege tự động**, không phải đoán wildcard.

Các method grant phổ biến: `grantRead`, `grantWrite`, `grantReadWrite`, `grantReadWriteData` (DynamoDB), `bucket.grantPut`, `queue.grantConsumeMessages`, `topic.grantPublish`, `key.grantEncryptDecrypt` (KMS). Nếu hai construct ở **khác stack/khác account**, grant còn tự thêm resource-based policy phía bị truy cập khi cần.

Tham chiếu giá trị giữa các resource (như `table.tableName`, `table.tableArn`) sẽ được CDK biên dịch thành `Ref`/`Fn::GetAtt` trong template — bạn không cần biết Logical ID.

> 💡 **Exam Tip:** `grant*` methods (ví dụ `table.grantReadWriteData(fn)`) là cách CDK **tự sinh IAM policy least-privilege** cho principal, gắn đúng action + đúng resource ARN. Khi đề hỏi "cách đơn giản nhất để cấp Lambda quyền đọc/ghi DynamoDB trong CDK" → dùng `grant*`, KHÔNG tự viết PolicyStatement bằng tay.

## 37.7 Assets, environment, context và feature flags

**Assets** là file/thư mục/Docker image cục bộ mà CDK cần upload để deploy: code Lambda (`lambda.Code.fromAsset('dist')`), file Docker (`DockerImageAsset`), file lớn cho S3 (`s3-assets`). Khi deploy, CDK upload asset lên **S3 bucket / ECR repo do bootstrap tạo ra** rồi tham chiếu trong template. Đây chính là lý do phải bootstrap — không có bucket thì không upload được asset.

**Environment (account/region):** mỗi stack có thể chỉ định `env`. Có hai chế độ:
- **Environment-agnostic** (không set `env`): CDK dùng pseudo parameters (`AWS::AccountId`, `AWS::Region`) — template deploy được vào account/region bất kỳ, NHƯNG **không dùng được context lookup** (vd `Vpc.fromLookup`).
- **Environment-specific** (set `env: { account, region }`): bắt buộc khi cần lookup tài nguyên có sẵn (VPC, AMI, hosted zone).

```typescript
new ApiStack(app, 'Prod', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT, // lấy từ credentials hiện tại
    region: process.env.CDK_DEFAULT_REGION,
  },
});
```

**Context** là cặp key-value cấu hình app, lưu trong `cdk.json` hoặc truyền `--context key=value`. Context-providing lookups (như `Vpc.fromLookup`, `ssm.StringParameter.valueFromLookup`) gọi AWS API lúc synth rồi **cache kết quả vào `cdk.context.json`** để build sau ổn định (deterministic) — bạn nên commit file này vào git.

```bash
cdk synth --context environment=staging
cdk context --clear   # xoá cache khi tài nguyên thật đã đổi
```

```typescript
const envName = this.node.tryGetContext('environment') ?? 'dev';
```

**Feature flags** là các context key dạng `@aws-cdk/...:` trong `cdk.json` bật/tắt hành vi mới của CDK (thường để giữ backward-compatible khi nâng version). Ví dụ `"@aws-cdk/core:bootstrapQualifier"`. Khi nâng cấp aws-cdk-lib, đừng tự ý xoá feature flags cũ vì có thể đổi Logical ID → thay resource.

> 💡 **Exam Tip:** Để dùng `Vpc.fromLookup()` hay tra cứu tài nguyên có sẵn, stack PHẢI khai báo `env` (account + region) cụ thể — không thể environment-agnostic. Kết quả lookup cache trong `cdk.context.json`. Câu hỏi gài: "vì sao `fromLookup` báo lỗi cần account/region?" → vì stack thiếu `env`.

## 37.8 Aspects và Tags

**Tags:** gắn tag cho mọi resource trong một scope (app/stack/construct) chỉ một dòng — CDK tự lan truyền (propagate) xuống mọi resource con hỗ trợ tagging:

```typescript
import { Tags } from 'aws-cdk-lib';
Tags.of(app).add('Project', 'Billing');     // gắn cho TẤT CẢ resource trong app
Tags.of(myStack).add('Environment', 'prod'); // chỉ stack này
```

**Aspects** là cơ chế **duyệt toàn bộ cây construct** để áp một thao tác chéo (cross-cutting) lên mọi node — dùng cho compliance, governance, kiểm tra. Aspect implement interface `IAspect` với method `visit(node)`. Ví dụ aspect ép mọi S3 bucket phải bật versioning, hoặc thêm cảnh báo nếu phát hiện resource chưa encrypt:

```typescript
import { IAspect, Annotations } from 'aws-cdk-lib';
import { IConstruct } from 'constructs';
import { CfnBucket } from 'aws-cdk-lib/aws-s3';

class BucketVersioningChecker implements IAspect {
  public visit(node: IConstruct): void {
    if (node instanceof CfnBucket) {
      const v = node.versioningConfiguration as CfnBucket.VersioningConfigurationProperty;
      if (!v || v.status !== 'Enabled') {
        // ghi cảnh báo hiện ra lúc synth
        Annotations.of(node).addError('S3 bucket phải bật versioning');
      }
    }
  }
}
Aspects.of(app).add(new BucketVersioningChecker());
```

Bản thân `Tags` cũng được hiện thực bằng Aspect bên dưới. Aspect chạy ở giai đoạn "prepare" trước synth, nên có thể vừa kiểm tra (Annotations) vừa sửa đổi (mutate) cây construct.

> 💡 **Exam Tip:** **Tags.of(scope).add()** propagate tag xuống toàn bộ resource con — cách chuẩn để gắn cost-allocation tag hàng loạt. **Aspects** dùng để áp policy/kiểm tra governance trên toàn cây construct (vd ép encryption). Đừng nhầm hai cái này với CloudFormation Conditions.

## 37.9 Testing CDK, test local với SAM CLI, và CDK Pipelines

**Testing** là điểm CDK ăn đứt YAML: bạn test hạ tầng như test code. Hai kiểu:

**Fine-grained assertions** — synth stack thành template rồi assert có resource/thuộc tính mong muốn (dùng module `aws-cdk-lib/assertions` + jest):

```typescript
import { Template } from 'aws-cdk-lib/assertions';
import { App } from 'aws-cdk-lib';
import { ApiStack } from '../lib/api-stack';

test('tạo đúng DynamoDB table on-demand', () => {
  const app = new App();
  const stack = new ApiStack(app, 'Test');
  const template = Template.fromStack(stack);

  template.resourceCountIs('AWS::DynamoDB::Table', 1);
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    BillingMode: 'PAY_PER_REQUEST',
  });
});
```

**Snapshot testing** — chụp toàn bộ template thành snapshot; lần chạy sau nếu template đổi, test fail để bạn review chủ động (chống thay đổi ngoài ý muốn):

```typescript
test('snapshot khớp', () => {
  const app = new App();
  const stack = new ApiStack(app, 'Test');
  expect(Template.fromStack(stack).toJSON()).toMatchSnapshot();
});
```

**Test local với SAM CLI:** CDK không có local invoke riêng, nhưng SAM CLI đọc được output của CDK. Quy trình: `cdk synth --no-staging` để sinh template ra `cdk.out/`, rồi `sam local invoke <LogicalId> -t cdk.out/MyStack.template.json` để chạy Lambda offline trong Docker (chi tiết SAM local ở Chương 36).

```bash
cdk synth --no-staging > /dev/null
sam local invoke ItemsHandler... -t ./cdk.out/ApiStack.template.json
sam local start-api -t ./cdk.out/ApiStack.template.json
```

**CDK Pipelines (mức giới thiệu):** module `aws-cdk-lib/pipelines` dựng một CI/CD pipeline (trên CodePipeline) **tự cập nhật chính nó** (self-mutating) và deploy CDK app qua nhiều stage/account. Bạn định nghĩa pipeline bằng CDK, nó tự lo source → build (`cdk synth`) → deploy. Đặc trưng: **self-mutation** (pipeline thêm stage mới thì tự cập nhật mình trước), hỗ trợ multi-account/region qua các `Stage`.

```typescript
import { CodePipeline, CodePipelineSource, ShellStep } from 'aws-cdk-lib/pipelines';

const pipeline = new CodePipeline(this, 'Pipeline', {
  synth: new ShellStep('Synth', {
    input: CodePipelineSource.gitHub('me/repo', 'main'),
    commands: ['npm ci', 'npm run build', 'npx cdk synth'],
  }),
});
// pipeline.addStage(new MyAppStage(this, 'Prod', { env: {...} }));
```

> 💡 **Exam Tip:** CDK hỗ trợ unit test hạ tầng qua module `assertions` (fine-grained `hasResourceProperties` + snapshot) — đây là lợi thế so với CloudFormation/SAM thuần. **CDK Pipelines** là construct tự dựng CI/CD pipeline self-mutating trên CodePipeline để deploy CDK app multi-account. Để test Lambda offline, kết hợp `cdk synth` + `sam local invoke` trên template trong `cdk.out/`.
