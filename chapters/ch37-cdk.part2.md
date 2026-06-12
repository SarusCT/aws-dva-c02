## Hands-on Lab: Dựng stack Serverless (DynamoDB + Lambda + API Gateway) bằng CDK TypeScript

**Mục tiêu lab:** Đi trọn vòng đời một CDK app: `cdk init` → viết stack TypeScript dùng construct L2 (DynamoDB Table, Lambda Function, REST API) → `cdk bootstrap` → `cdk synth` xem CloudFormation sinh ra → `cdk diff` → `cdk deploy` → gọi thử API → viết một unit test với module `assertions` → cuối cùng `cdk destroy`. Bạn sẽ thấy rõ vì sao một dòng `table.grantReadWriteData(fn)` thay thế được cả chục dòng IAM policy JSON, và CDK assets (Lambda code) được upload lên S3 bootstrap bucket như thế nào.

**Chuẩn bị:**
- Node.js 18+ và npm. Cài CDK CLI toàn cục: `npm install -g aws-cdk` rồi kiểm tra `cdk --version` (bài này dùng v2.x — Toolkit và library cùng major version 2).
- AWS CLI v2 đã cấu hình profile có quyền Admin hoặc đủ quyền CloudFormation/IAM/Lambda/DynamoDB/APIGateway/S3 (xem Chương 3).
- Region ví dụ: `ap-southeast-1`. Chi phí gần như bằng 0 (DynamoDB on-demand + Lambda + API Gateway đều trong free tier khi test nhẹ), nhưng vẫn làm mục Dọn dẹp để tránh để rác lại.
- Xác định account ID: `aws sts get-caller-identity --query Account --output text`.

### Bước 1: Khởi tạo CDK app

```bash
mkdir cdk-notes-lab && cd cdk-notes-lab
cdk init app --language typescript
```

`cdk init` không chạy được trong thư mục đã có file, nên phải vào thư mục rỗng. Lệnh này tạo cấu trúc:

```
bin/cdk-notes-lab.ts     # entry point: khởi tạo App và Stack
lib/cdk-notes-lab-stack.ts  # nơi định nghĩa resource
test/                    # thư mục test (Jest)
cdk.json                 # cấu hình app + feature flags (context)
package.json
tsconfig.json
```

Mở `cdk.json` sẽ thấy `"app": "npx ts-node --prefer-ts-exts bin/cdk-notes-lab.ts"` và một khối `"context"` chứa hàng loạt feature flag dạng `@aws-cdk/...:enableXxx`. Các flag này quyết định hành vi mặc định của construct theo version — đừng tự ý xoá, vì xoá flag có thể làm construct sinh resource khác đi và gây replace tài nguyên khi deploy.

### Bước 2: Viết Lambda handler

Tạo thư mục `lambda/` và file handler. CDK sẽ đóng gói thư mục này thành asset.

```bash
mkdir lambda
```

```javascript
// lambda/notes.js — CommonJS để khỏi cần bundler
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, ScanCommand } =
  require("@aws-sdk/lib-dynamodb");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.TABLE_NAME; // đọc từ env do CDK inject

exports.handler = async (event) => {
  if (event.requestContext.http.method === "POST") {
    const body = JSON.parse(event.body || "{}");
    const item = { id: Date.now().toString(), text: body.text || "" };
    await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
    return { statusCode: 201, body: JSON.stringify(item) };
  }
  const res = await ddb.send(new ScanCommand({ TableName: TABLE }));
  return { statusCode: 200, body: JSON.stringify(res.Items || []) };
};
```

`@aws-sdk/*` v3 đã có sẵn trong runtime Node.js của Lambda nên không cần `npm install` cho handler này.

### Bước 3: Định nghĩa stack

Thay toàn bộ nội dung `lib/cdk-notes-lab-stack.ts`:

```typescript
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";

export class CdkNotesLabStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // L2 construct: Table — pay-per-request = on-demand, không cần khai báo RCU/WCU
    const table = new dynamodb.Table(this, "NotesTable", {
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // CHỈ dùng trong lab — prod để RETAIN
    });

    const fn = new lambda.Function(this, "NotesFn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "notes.handler",
      code: lambda.Code.fromAsset("lambda"), // asset: cả thư mục lambda/
      environment: { TABLE_NAME: table.tableName }, // tự sinh Ref tới tên bảng
    });

    // grant: CDK tự viết IAM policy least-privilege và gắn vào execution role
    table.grantReadWriteData(fn);

    const httpApi = new apigw.HttpApi(this, "NotesApi", {
      defaultIntegration: new HttpLambdaIntegration("Int", fn),
    });

    new cdk.CfnOutput(this, "ApiUrl", { value: httpApi.apiEndpoint });
  }
}
```

Vài điểm cốt lõi của lab này nằm ở đây:
- `table.tableName` là một **token** — lúc synth chưa biết tên thật, CDK chèn placeholder rồi CloudFormation thay bằng `Ref` thật khi deploy. Không bao giờ `console.log` token rồi mong thấy giá trị thật.
- `grantReadWriteData` đọc đúng các action cần (`GetItem`, `PutItem`, `Query`, `Scan`, `BatchWrite`...) và scope `Resource` về đúng ARN bảng + index — tốt hơn nhiều so với viết tay dễ thừa quyền.
- `removalPolicy: DESTROY` cho phép `cdk destroy` xoá bảng. Mặc định của Table L2 là `RETAIN` (giữ lại để chống mất dữ liệu) — nếu quên dòng này, destroy xong bảng vẫn còn và tính tiền.

### Bước 4: Bootstrap môi trường

CDK cần một "bootstrap stack" (`CDKToolkit`) chứa S3 bucket để chứa asset (code Lambda, file lớn) và ECR repo cho image, cùng các IAM role deploy. Chỉ chạy **một lần cho mỗi cặp account+region**:

```bash
cdk bootstrap aws://123456789012/ap-southeast-1
```

Output kết thúc bằng `✅  Environment aws://123456789012/ap-southeast-1 bootstrapped`. Sau đó vào CloudFormation console sẽ thấy stack `CDKToolkit` và một bucket tên `cdk-hnb659fds-assets-<account>-<region>`. Nếu bỏ qua bước này, `cdk deploy` sẽ báo lỗi kiểu *"This stack uses assets, so the toolkit stack must be deployed... Please run 'cdk bootstrap'"*.

### Bước 5: Synth và Diff

```bash
cdk synth
```

Lệnh này biên dịch TypeScript, chạy app, và in ra **CloudFormation template** (YAML) sinh ra, đồng thời ghi vào `cdk.out/CdkNotesLabStack.template.json`. Bạn sẽ thấy CDK tự tạo: `AWS::DynamoDB::Table`, `AWS::IAM::Role` cho Lambda, `AWS::IAM::Policy` (từ grant), `AWS::Lambda::Function`, `AWS::ApiGatewayV2::Api/Integration/Route/Stage`, và một `AWS::Lambda::Permission` cho phép API Gateway invoke hàm. Một dòng L2 nở ra cả chục resource — đó là giá trị của construct.

`cdk diff` so sánh template local với stack đang chạy trên AWS (lần đầu thì mọi thứ là `[+]`):

```bash
cdk diff
```

### Bước 6: Deploy

```bash
cdk deploy
```

CDK liệt kê các thay đổi IAM nhạy cảm và hỏi `Do you wish to deploy these changes (y/n)?` — gõ `y` (CI/CD thì thêm `--require-approval never`). Quá trình: upload asset Lambda lên bootstrap bucket → tạo/cập nhật CloudFormation stack → in Outputs:

```
Outputs:
CdkNotesLabStack.ApiUrl = https://abcd1234.execute-api.ap-southeast-1.amazonaws.com
```

### Bước 7: Gọi thử API

```bash
API=https://abcd1234.execute-api.ap-southeast-1.amazonaws.com

# Tạo note
curl -s -X POST "$API" -d '{"text":"hoc CDK"}'
# Output: {"id":"1718000000000","text":"hoc CDK"}

# Liệt kê
curl -s "$API"
# Output: [{"id":"1718000000000","text":"hoc CDK"}]
```

Nếu nhận `500`, mở CloudWatch Logs của hàm (CDK đặt tên log group `/aws/lambda/CdkNotesLabStack-NotesFn...`) để xem stack trace — thường là quên `grantReadWriteData` (AccessDenied) hoặc sai tên handler.

### Bước 8: Viết một unit test với `assertions`

CDK test không deploy gì cả — nó synth stack trong bộ nhớ rồi assert lên template. Tạo `test/stack.test.ts`:

```typescript
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { CdkNotesLabStack } from "../lib/cdk-notes-lab-stack";

test("Table dùng on-demand và có 1 Lambda", () => {
  const app = new cdk.App();
  const stack = new CdkNotesLabStack(app, "Test");
  const t = Template.fromStack(stack);

  t.hasResourceProperties("AWS::DynamoDB::Table", {
    BillingMode: "PAY_PER_REQUEST",
  });
  t.resourceCountIs("AWS::Lambda::Function", 1);
});
```

```bash
npm test
```

Đây là **fine-grained assertion**. CDK còn hỗ trợ **snapshot test** (`expect(t.toJSON()).toMatchSnapshot()`) để phát hiện mọi thay đổi ngoài ý muốn của template — nhưng snapshot dễ "vỡ" khi nâng version CDK.

### Dọn dẹp tài nguyên

```bash
# Xoá stack ứng dụng (bảng có RemovalPolicy.DESTROY nên bị xoá theo)
cdk destroy
# Gõ y khi được hỏi
```

`cdk destroy` chỉ xoá stack ứng dụng, **không** xoá bootstrap stack. Nếu muốn dọn sạch hoàn toàn (hiếm khi cần — bootstrap dùng lại cho mọi project):

```bash
# Làm rỗng rồi xoá bucket asset trước, vì bucket có version không tự xoá được
aws s3 rm s3://cdk-hnb659fds-assets-123456789012-ap-southeast-1 --recursive
aws cloudformation delete-stack --stack-name CDKToolkit
```

Kiểm tra không còn rác: `aws cloudformation list-stacks --query "StackSummaries[?StackStatus!='DELETE_COMPLETE'].StackName"`.

## 💡 Exam Tips chương 37

- **CDK synth ra CloudFormation.** Mọi thứ CDK làm cuối cùng đều là một CloudFormation template được deploy qua CloudFormation. Câu hỏi "công cụ nào cho phép định nghĩa hạ tầng bằng ngôn ngữ lập trình quen thuộc (TS/Python/Java/Go) rồi triển khai qua CloudFormation?" → đáp án là CDK, không phải SAM hay Terraform.
- **Phân biệt L1/L2/L3.** L1 (`Cfn*`) ánh xạ 1-1 với resource CloudFormation, phải khai báo mọi thuộc tính. L2 có default hợp lý + method tiện ích (grants, metrics). L3 (pattern) gói nhiều resource thành một use case. Đề hay hỏi "construct nào có sẵn `grant*` method" → L2.
- **`grant*` thay cho viết IAM tay.** `bucket.grantRead(fn)`, `table.grantReadWriteData(fn)`, `queue.grantSendMessages(fn)` tự sinh policy least-privilege. Đây là điểm khác biệt lớn so với CloudFormation/SAM thuần.
- **`cdk bootstrap` bắt buộc trước deploy lần đầu** trên mỗi cặp account+region khi stack dùng asset. Nó tạo stack `CDKToolkit` + S3 bucket asset + IAM deploy roles. Lỗi "must be deployed... run cdk bootstrap" là dấu hiệu quên bước này.
- **CDK vs SAM:** SAM chuyên serverless (Lambda/API GW/DynamoDB) với cú pháp YAML rút gọn + `sam local`. CDK đa năng (mọi service AWS) bằng code thật. Cả hai đều synth ra CloudFormation. "Least code, full programming language, any AWS service" → CDK.
- **Environment (account/region).** Nếu không set `env`, stack là *environment-agnostic* và một số lookup (VPC, AZ) sẽ fail. Set `env: { account, region }` để dùng được context lookup và deploy đa môi trường.
- **`removalPolicy`.** Stateful resource (DynamoDB Table, S3 Bucket, RDS) trong L2 thường default `RETAIN` để tránh mất dữ liệu — nhớ điểm này khi đề hỏi vì sao `cdk destroy` xong bảng vẫn còn.
- **CDK Pipelines** (`aws-cdk-lib/pipelines`) là construct tự dựng CodePipeline self-mutating: pipeline tự cập nhật chính nó khi định nghĩa pipeline thay đổi. Nhận diện từ khoá "self-mutating pipeline".
- **`cdk diff`** so template local với stack đã deploy — tương đương xem ChangeSet trước khi apply. Dùng trong PR review hạ tầng.
- **Testing:** module `aws-cdk-lib/assertions` (`Template.fromStack`) cho fine-grained + snapshot test, chạy bằng synth trong bộ nhớ, không cần deploy.
- **Aspects & Tags.** `Tags.of(scope).add(k,v)` gắn tag xuống mọi resource con. Aspect (`IAspect.visit`) duyệt cây construct để áp chính sách (vd: ép mọi bucket bật encryption) — dùng cho governance.
- **`cdk deploy --require-approval never`** bỏ qua prompt phê duyệt thay đổi IAM khi chạy trong CI/CD; `--hotswap` cập nhật nhanh code Lambda mà không qua CloudFormation (chỉ dùng cho dev, không dùng prod).

## Quiz chương 37 (10 câu)

**Câu 1.** Một team backend muốn định nghĩa hạ tầng bằng TypeScript với đầy đủ vòng lặp, hàm, kiểm thử đơn vị, và triển khai qua dịch vụ IaC native của AWS. Công cụ nào phù hợp nhất?
- A. AWS SAM
- B. AWS CDK
- C. Terraform
- D. CloudFormation YAML viết tay

**Câu 2.** Developer viết `table.grantReadWriteData(myFunction)` trong CDK. Kết quả khi synth là gì?
- A. Một resource-based policy gắn trực tiếp lên DynamoDB table
- B. Một IAM policy least-privilege được tạo và gắn vào execution role của Lambda
- C. Một entry trong bucket policy của asset bucket
- D. Không sinh gì cho tới khi chạy `cdk bootstrap`

**Câu 3.** Chạy `cdk deploy` lần đầu trên một account+region mới, gặp lỗi yêu cầu "the toolkit stack must be deployed". Cần làm gì?
- A. Chạy `cdk synth` lại
- B. Thêm `--force` vào lệnh deploy
- C. Chạy `cdk bootstrap aws://<account>/<region>`
- D. Tạo thủ công một S3 bucket tên bất kỳ

**Câu 4.** Một developer dùng construct L1 (`CfnBucket`) thay vì L2 (`Bucket`). Hệ quả nào đúng?
- A. L1 tự động cấu hình encryption và block public access mặc định
- B. L1 cung cấp các method tiện ích như `grantRead`
- C. L1 ánh xạ 1-1 với CloudFormation và yêu cầu khai báo mọi thuộc tính thủ công
- D. L1 không thể deploy qua CloudFormation

**Câu 5.** Sau khi `cdk destroy` một stack chứa DynamoDB Table tạo bằng L2 construct mặc định, developer thấy bảng vẫn tồn tại và vẫn tính tiền. Nguyên nhân khả dĩ nhất?
- A. CloudFormation bị lỗi rollback
- B. `RemovalPolicy` mặc định của Table là `RETAIN`
- C. Bảng đang được một stack khác tham chiếu
- D. Phải xoá bootstrap stack trước

**Câu 6.** Team muốn một CI/CD pipeline tự cập nhật chính nó khi định nghĩa pipeline thay đổi, đồng thời deploy CDK app qua nhiều stage. Giải pháp nào?
- A. CodeDeploy blue/green
- B. CDK Pipelines (self-mutating)
- C. SAM `sam deploy --guided`
- D. CloudFormation StackSets

**Câu 7.** Một developer cần kiểm chứng rằng stack CDK luôn tạo S3 bucket có bật versioning, mà KHÔNG muốn deploy lên AWS trong CI. Cách nào đúng?
- A. Deploy lên một account sandbox rồi gọi API kiểm tra
- B. Dùng `aws-cdk-lib/assertions` với `Template.fromStack` và `hasResourceProperties`
- C. Đọc tay file `cdk.json`
- D. Chạy `cdk diff` và đọc output bằng mắt

**Câu 8.** Phát biểu nào về quan hệ giữa CDK và CloudFormation là ĐÚNG?
- A. CDK thay thế hoàn toàn CloudFormation, không dùng CloudFormation bên dưới
- B. CDK synth ra template CloudFormation rồi deploy qua chính CloudFormation
- C. CDK dùng Terraform state để quản lý hạ tầng
- D. CDK chỉ deploy được tài nguyên serverless

**Câu 9.** Developer muốn gắn tag `Environment=prod` cho TẤT CẢ resource trong một stack CDK chỉ bằng một dòng. Dùng gì?
- A. `Tags.of(stack).add("Environment", "prod")`
- B. Thêm `Tags` thủ công vào từng `Cfn*` resource
- C. Đặt biến môi trường `CDK_TAGS`
- D. CDK không hỗ trợ tag cấp stack

**Câu 10.** Một developer cần test nhanh hàm Lambda trong CDK app trên máy local trước khi deploy. Cách tiếp cận đúng theo hệ sinh thái AWS?
- A. CDK có lệnh `cdk local invoke` tích hợp sẵn
- B. `cdk synth` ra template rồi dùng `sam local invoke -t cdk.out/<stack>.template.json`
- C. Phải deploy rồi mới test được, không có cách local
- D. Dùng `cdk diff` để chạy hàm

### Đáp án & giải thích

**Câu 1 — Đáp án B.** CDK cho phép viết IaC bằng ngôn ngữ lập trình thật (TS/Python/Java/Go/C#) với đầy đủ vòng lặp/hàm/test, và deploy qua CloudFormation (IaC native của AWS). A (SAM) chỉ tốt cho serverless và dùng YAML, không phải "full programming language". C (Terraform) không phải native AWS — đề DVA-C02 coi CloudFormation/CDK/SAM là native. D không có khả năng lập trình.

**Câu 2 — Đáp án B.** `grant*` method sinh một IAM identity-based policy least-privilege gắn vào role của principal được grant (ở đây là execution role của Lambda). A sai vì DynamoDB không dùng resource-based policy cho caller như vậy (grant gắn lên identity). C sai hoàn toàn (asset bucket không liên quan). D sai — grant sinh policy lúc synth, độc lập với bootstrap.

**Câu 3 — Đáp án C.** Lỗi "toolkit stack must be deployed" nghĩa là môi trường chưa được bootstrap; phải chạy `cdk bootstrap` để tạo stack `CDKToolkit` (S3 asset bucket + roles). A/B không tạo được hạ tầng bootstrap. D sai vì bucket phải đúng quy ước tên + đi kèm roles/SSM param mà CDK quản lý, không thể tạo tay tuỳ tiện.

**Câu 4 — Đáp án C.** L1 (`Cfn*`) là ánh xạ trực tiếp 1-1 với resource CloudFormation, không có default thông minh, phải khai báo mọi property. A và B là đặc tính của L2 (default an toàn + `grant*`/metrics). D sai — L1 vẫn deploy qua CloudFormation bình thường.

**Câu 5 — Đáp án B.** Các construct L2 cho resource stateful (DynamoDB Table, S3 Bucket, RDS) thường đặt `RemovalPolicy` mặc định là `RETAIN` để tránh mất dữ liệu; do đó `cdk destroy` không xoá bảng. Phải set `removalPolicy: RemovalPolicy.DESTROY` mới xoá. A không khớp triệu chứng (không có lỗi rollback). C có thể chặn xoá nhưng sẽ báo lỗi dependency, không phải "im lặng giữ lại". D không liên quan tới việc bảng bị giữ.

**Câu 6 — Đáp án B.** CDK Pipelines (`aws-cdk-lib/pipelines`) dựng CodePipeline self-mutating: pipeline tự cập nhật stage của chính nó khi code định nghĩa pipeline thay đổi, và deploy CDK app qua nhiều stage/môi trường. A là chiến lược deploy ứng dụng, không phải pipeline tự dựng hạ tầng. C là deploy thủ công một stack. D là triển khai stack ra nhiều account/region nhưng không "self-mutating".

**Câu 7 — Đáp án B.** Module `aws-cdk-lib/assertions` cho phép synth stack trong bộ nhớ (`Template.fromStack`) rồi assert property mà KHÔNG deploy — đúng yêu cầu chạy trong CI nhanh, không tốn tài nguyên. A đi ngược yêu cầu (vẫn deploy). C `cdk.json` không chứa resource property. D `cdk diff` cần kết nối tới stack đã deploy và không phải kiểm thử tự động.

**Câu 8 — Đáp án B.** CDK là lớp trừu tượng phía trên CloudFormation: `synth` sinh template, `deploy` đẩy qua CloudFormation. A sai (CDK dùng CloudFormation). C sai (CloudFormation quản state, không phải Terraform). D sai (CDK deploy mọi loại resource, không chỉ serverless).

**Câu 9 — Đáp án A.** `Tags.of(scope).add(key, value)` áp tag xuống toàn bộ construct con trong scope đó (cả stack). B đúng kỹ thuật nhưng thủ công và sai yêu cầu "một dòng". C không tồn tại. D sai — CDK hỗ trợ tag qua Tags/Aspects.

**Câu 10 — Đáp án B.** CDK không có lệnh invoke local riêng; cách chuẩn là `cdk synth` ra CloudFormation template rồi dùng SAM CLI (`sam local invoke`/`sam local start-api`) trỏ vào template trong `cdk.out`. A sai (`cdk local invoke` không tồn tại). C sai (có cách local qua SAM). D sai (`cdk diff` không chạy hàm).

## Tóm tắt chương

- CDK định nghĩa hạ tầng bằng ngôn ngữ lập trình thật (TypeScript là ví dụ chính), `synth` ra CloudFormation template và deploy **qua** CloudFormation — nó là lớp trừu tượng, không thay thế CloudFormation.
- Cấu trúc app: `App` chứa nhiều `Stack`, mỗi Stack chứa các `Construct`. Phân tầng construct: L1 (`Cfn*`, 1-1 với CloudFormation), L2 (default an toàn + `grant*`/metrics), L3 (pattern gói nhiều resource).
- Vòng đời CLI: `cdk init` → `cdk bootstrap` (một lần/account+region) → `cdk synth` → `cdk diff` → `cdk deploy` → `cdk destroy`.
- `cdk bootstrap` tạo stack `CDKToolkit` gồm S3 asset bucket, ECR repo và IAM deploy roles; bắt buộc khi stack dùng asset (code Lambda, file lớn).
- `grant*` method (vd `table.grantReadWriteData(fn)`) tự sinh IAM policy least-privilege gắn vào identity của principal — ưu thế lớn so với viết IAM JSON tay.
- Token (vd `table.tableName`) là placeholder lúc synth, được CloudFormation thay bằng `Ref`/`GetAtt` thật khi deploy; không thể đọc giá trị thật trong code synth.
- `RemovalPolicy` của resource stateful trong L2 thường default `RETAIN`; muốn `cdk destroy` xoá thì đặt `DESTROY`.
- Environment (`env: { account, region }`) cần set để dùng context lookup và deploy đa môi trường; không set thì stack là environment-agnostic.
- Testing dùng `aws-cdk-lib/assertions`: fine-grained assertion (`hasResourceProperties`, `resourceCountIs`) và snapshot, chạy bằng synth trong bộ nhớ không cần deploy.
- Local testing serverless trong CDK: `cdk synth` rồi dùng `sam local invoke` trỏ vào template trong `cdk.out`.
- Tags (`Tags.of(scope).add`) và Aspects (`IAspect.visit`) cho phép áp tag/chính sách governance lên toàn bộ cây construct.
- CDK Pipelines dựng CodePipeline self-mutating để CI/CD chính CDK app; so với SAM, CDK đa năng (mọi service) còn SAM chuyên serverless với cú pháp YAML rút gọn.
