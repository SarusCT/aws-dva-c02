## Hands-on Lab: Conditions, nested stack, custom resource, ChangeSet, drift detection và DeletionPolicy

**Mục tiêu lab:** Dựng một template CloudFormation "đời thực" gói gọn gần như mọi điểm nâng cao mà DVA-C02 hay hỏi: `Mappings` + `Fn::FindInMap`, `Conditions` + `Fn::If`, pseudo parameters, `DeletionPolicy: Retain`, `UpdateReplacePolicy`, một **nested stack** (template con deploy từ S3), một **Lambda-backed custom resource**, sau đó dùng **ChangeSet** để xem trước thay đổi, bật **termination protection**, chạy **drift detection** để phát hiện thay đổi out-of-band, và cuối cùng dọn sạch (kèm xử lý resource bị `Retain`).

**Chuẩn bị:**
- AWS CLI v2 đã cấu hình profile có quyền `cloudformation:*`, `s3:*`, `lambda:*`, `iam:*`, `dynamodb:*`. Lab phát sinh IAM role nên sẽ cần truyền capability.
- Region xuyên suốt: `ap-southeast-1`. Lấy account ID bằng `aws sts get-caller-identity`.
- Một S3 bucket để chứa template con của nested stack (CloudFormation đọc template con qua URL S3).

```bash
export AWS_REGION="ap-southeast-1"
export ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
export ART_BUCKET="dva-ch20-artifacts-${ACCOUNT_ID}"
aws s3 mb "s3://${ART_BUCKET}" --region "$AWS_REGION"
```

### Bước 1: Viết template con (nested stack) — một DynamoDB table có DeletionPolicy

Lưu file `child-ddb.yaml`. Đây là stack con sẽ được stack cha tham chiếu.

```yaml
AWSTemplateFormatVersion: "2010-09-09"
Description: Child stack - DynamoDB table
Parameters:
  TableName:
    Type: String
Resources:
  Table:
    Type: AWS::DynamoDB::Table
    DeletionPolicy: Retain          # GIỮ LẠI table khi xoá stack
    UpdateReplacePolicy: Retain     # GIỮ LẠI bản cũ nếu update buộc replace
    Properties:
      TableName: !Ref TableName
      BillingMode: PAY_PER_REQUEST
      AttributeDefinitions:
        - AttributeName: id
          AttributeType: S
      KeySchema:
        - AttributeName: id
          KeyType: HASH
Outputs:
  TableArn:
    Value: !GetAtt Table.Arn        # Output này được stack cha đọc qua Fn::GetAtt
```

Điểm thi: `DeletionPolicy` và `UpdateReplacePolicy` là **hai cờ độc lập**. `DeletionPolicy` chỉ áp dụng khi resource bị xoá lúc xoá stack; `UpdateReplacePolicy` áp dụng khi một update làm CloudFormation phải **replace** resource (tạo mới rồi xoá cũ). Đổi `TableName` chính là một thay đổi cần replacement với DynamoDB.

Upload template con lên S3:

```bash
aws s3 cp child-ddb.yaml "s3://${ART_BUCKET}/child-ddb.yaml"
```

### Bước 2: Viết Lambda cho custom resource

Custom resource gọi một Lambda; Lambda **bắt buộc** phải gửi một HTTP PUT response về `event.ResponseURL` (pre-signed S3 URL) báo `SUCCESS`/`FAILED`, nếu không stack treo tới khi timeout (mặc định ~1 giờ). Lưu `custom-resource.js`:

```javascript
// Tự gửi response thay vì dùng cfn-response để thấy rõ cơ chế
const https = require("https");
const { URL } = require("url");

function send(event, context, status, data = {}, physicalId) {
  const body = JSON.stringify({
    Status: status,
    Reason: `See logs: ${context.logStreamName}`,
    PhysicalResourceId: physicalId || context.logStreamName,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: data,
  });
  const u = new URL(event.ResponseURL);
  const req = https.request(
    { hostname: u.hostname, path: u.pathname + u.search, method: "PUT",
      headers: { "content-type": "", "content-length": body.length } },
    () => {}
  );
  return new Promise((res) => { req.on("error", () => res()); req.write(body); req.end(res); });
}

exports.handler = async (event, context) => {
  console.log("RequestType:", event.RequestType);
  // Khi DELETE: chỉ cần báo SUCCESS, đừng làm fail vòng rollback
  if (event.RequestType === "Delete") return send(event, context, "SUCCESS");
  // Create/Update: trả về một giá trị "tính toán" cho stack dùng
  const upper = (event.ResourceProperties.Input || "").toUpperCase();
  return send(event, context, "SUCCESS", { Result: upper }, "ch20-custom-1");
};
```

> Điểm thi kinh điển: Lambda của custom resource phải xử lý **cả ba** `RequestType` — `Create`, `Update`, `Delete`. Quên xử lý `Delete` (hoặc làm nó throw) khiến `DELETE_FAILED` và stack không xoá được.

### Bước 3: Template cha — gói tất cả lại

Lưu `parent.yaml`. Nó dùng `Mappings`, `Conditions`, pseudo parameter `AWS::Region`/`AWS::AccountId`, nested stack, và custom resource.

```yaml
AWSTemplateFormatVersion: "2010-09-09"
Description: Parent stack - nested + custom resource + conditions
Parameters:
  EnvType:
    Type: String
    AllowedValues: [dev, prod]
    Default: dev
  ArtifactBucket:
    Type: String
Mappings:
  EnvMap:
    dev:  { TableSuffix: "dev" }
    prod: { TableSuffix: "prod" }
Conditions:
  IsProd: !Equals [!Ref EnvType, prod]
Resources:
  CustomFnRole:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Version: "2012-10-17"
        Statement:
          - Effect: Allow
            Principal: { Service: lambda.amazonaws.com }
            Action: sts:AssumeRole
      ManagedPolicyArns:
        - arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  CustomFn:
    Type: AWS::Lambda::Function
    Properties:
      Runtime: nodejs20.x
      Handler: index.handler
      Timeout: 30
      Role: !GetAtt CustomFnRole.Arn
      Code:
        ZipFile: |
          PLACEHOLDER_REPLACED_BY_PACKAGE
  ChildDdb:
    Type: AWS::CloudFormation::Stack       # NESTED STACK
    Properties:
      TemplateURL: !Sub "https://${ArtifactBucket}.s3.${AWS::Region}.amazonaws.com/child-ddb.yaml"
      Parameters:
        TableName: !Sub
          - "ch20-${suffix}-${AWS::AccountId}"
          - suffix: !FindInMap [EnvMap, !Ref EnvType, TableSuffix]
  Greeting:
    Type: Custom::Greeting                 # CUSTOM RESOURCE
    Properties:
      ServiceToken: !GetAtt CustomFn.Arn
      Input: !If [IsProd, "production-grade", "dev-sandbox"]
Outputs:
  TableArn:
    Value: !GetAtt ChildDdb.Outputs.TableArn   # đọc Output của nested stack
  GreetingResult:
    Value: !GetAtt Greeting.Result             # đọc Data trả về từ custom resource
```

Để chèn code Lambda thật vào `ZipFile`, dùng `aws cloudformation package` (nó sẽ upload và viết lại `Code` cho function nếu bạn để Lambda trỏ tới file). Cách đơn giản nhất cho lab: thay inline bằng nội dung `custom-resource.js`:

```bash
# Nhét code Lambda inline thay placeholder (indent 10 dấu cách cho khớp YAML)
python3 - <<'PY'
code = open("custom-resource.js").read()
indented = "\n".join("          " + l for l in code.splitlines())
t = open("parent.yaml").read().replace("          PLACEHOLDER_REPLACED_BY_PACKAGE", indented)
open("parent.out.yaml","w").write(t)
PY
```

### Bước 4: Validate rồi tạo stack (truyền capability IAM)

```bash
aws cloudformation validate-template --template-body file://parent.out.yaml

aws cloudformation create-stack \
  --stack-name ch20-parent \
  --template-body file://parent.out.yaml \
  --parameters ParameterKey=EnvType,ParameterValue=dev \
               ParameterKey=ArtifactBucket,ParameterValue="$ART_BUCKET" \
  --capabilities CAPABILITY_IAM \
  --region "$AWS_REGION"
```

Vì template tạo IAM role, thiếu `--capabilities CAPABILITY_IAM` sẽ bị lỗi `InsufficientCapabilitiesException`. Nếu role có `RoleName` cố định, phải dùng `CAPABILITY_NAMED_IAM`. (Nếu dùng `AWS::Include`/SAM macro thì cần `CAPABILITY_AUTO_EXPAND`.)

Chờ tạo xong và xem Outputs:

```bash
aws cloudformation wait stack-create-complete --stack-name ch20-parent
aws cloudformation describe-stacks --stack-name ch20-parent \
  --query "Stacks[0].Outputs" --output table
```

Output mong đợi: `GreetingResult = DEV-SANDBOX` (in hoa, do Lambda) và `TableArn` là ARN của DynamoDB table do nested stack tạo. Lưu ý nested stack xuất hiện như một stack RIÊNG trong console với tên kiểu `ch20-parent-ChildDdb-XXXX`.

### Bước 5: ChangeSet — xem trước thay đổi trước khi apply

Đổi `EnvType` sang `prod`. Việc này đổi `TableSuffix` → đổi `TableName` → **replace** DynamoDB table. ChangeSet cho thấy điều đó TRƯỚC khi bạn thực thi:

```bash
aws cloudformation create-change-set \
  --stack-name ch20-parent \
  --change-set-name to-prod \
  --use-previous-template \
  --parameters ParameterKey=EnvType,ParameterValue=prod \
               ParameterKey=ArtifactBucket,UsePreviousValue=true \
  --capabilities CAPABILITY_IAM

aws cloudformation describe-change-set \
  --stack-name ch20-parent --change-set-name to-prod \
  --query "Changes[].ResourceChange.{Logical:LogicalResourceId,Action:Action,Replacement:Replacement}" \
  --output table
```

Cột `Replacement: True` trên nested stack/table là cảnh báo: dữ liệu table cũ sẽ không mất (vì `DeletionPolicy/UpdateReplacePolicy: Retain`) nhưng stack tạo table MỚI trống. Trong lab này ta **không execute** change set đó để tránh đẻ thêm table:

```bash
aws cloudformation delete-change-set --stack-name ch20-parent --change-set-name to-prod
```

> Điểm thi: tạo change set KHÔNG thay đổi gì trên stack thật. Phải `execute-change-set` mới apply. Đây là cách an toàn để review thay đổi (đặc biệt cờ `Replacement`) trong môi trường production.

### Bước 6: Bật termination protection và chạy drift detection

```bash
aws cloudformation update-termination-protection \
  --stack-name ch20-parent --enable-termination-protection
```

Giờ tạo một thay đổi out-of-band (sửa trực tiếp resource, không qua CloudFormation) để drift detection bắt được. Bật PITR trên table thật:

```bash
TABLE=$(aws cloudformation describe-stacks --stack-name ch20-parent \
  --query "Stacks[0].Outputs[?OutputKey=='TableArn'].OutputValue" --output text | awk -F/ '{print $NF}')
aws dynamodb update-continuous-backups --table-name "$TABLE" \
  --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true
```

Chạy drift detection trên stack con (nơi chứa table). Drift detect là bất đồng bộ — bạn lấy một `StackDriftDetectionId` rồi poll:

```bash
CHILD=$(aws cloudformation list-stack-resources --stack-name ch20-parent \
  --query "StackResourceSummaries[?ResourceType=='AWS::CloudFormation::Stack'].PhysicalResourceId" --output text)
DID=$(aws cloudformation detect-stack-drift --stack-name "$CHILD" --query StackDriftDetectionId --output text)
aws cloudformation describe-stack-drift-detection-status --stack-drift-detection-id "$DID"
```

Kết quả mong đợi: `DetectionStatus: DETECTION_COMPLETE`, `StackDriftStatus: DRIFTED`. Xem chi tiết property nào lệch:

```bash
aws cloudformation describe-stack-resource-drifts --stack-name "$CHILD" \
  --query "StackResourceDrifts[].{R:LogicalResourceId,Status:StackResourceDriftStatus}" --output table
```

> Điểm thi: drift detection chỉ **phát hiện**, không tự sửa. Một số resource type không hỗ trợ drift detection. Drift so sánh property hiện tại với property mong muốn trong template — thay đổi ngoài CloudFormation (console, CLI, SDK) là nguyên nhân điển hình của drift.

### Dọn dẹp tài nguyên

Termination protection đang bật nên `delete-stack` sẽ bị từ chối — phải tắt trước:

```bash
aws cloudformation update-termination-protection \
  --stack-name ch20-parent --disable-termination-protection
aws cloudformation delete-stack --stack-name ch20-parent
aws cloudformation wait stack-delete-complete --stack-name ch20-parent
```

Vì DynamoDB table có `DeletionPolicy: Retain`, table **vẫn còn** sau khi stack biến mất — phải xoá tay (nếu không sẽ tốn tiền/ô nhiễm namespace):

```bash
aws dynamodb delete-table --table-name "$TABLE"
aws s3 rm "s3://${ART_BUCKET}" --recursive
aws s3 rb "s3://${ART_BUCKET}"
```

Kiểm tra không còn stack: `aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE --query "StackSummaries[?contains(StackName,'ch20')]"` trả về rỗng.

## 💡 Exam Tips chương 20

- `DeletionPolicy: Retain | Snapshot | Delete`. `Snapshot` chỉ hợp lệ với resource hỗ trợ snapshot (RDS, EBS volume, ElastiCache, Redshift, Neptune...). Mặc định là `Delete` (trừ `AWS::RDS::DBCluster` mặc định `Snapshot`). `UpdateReplacePolicy` là cờ RIÊNG, áp dụng khi update gây replacement — muốn giữ dữ liệu cả hai trường hợp phải set CẢ HAI.
- Custom resource Lambda **bắt buộc** gửi response (SUCCESS/FAILED) về `event.ResponseURL`. Quên gửi → stack treo tới timeout (tới ~1 giờ). Luôn xử lý `Delete` request, và đừng để `Delete` fail nếu không muốn `DELETE_FAILED`.
- `CreationPolicy` + `cfn-signal`: dùng cho EC2/ASG để CloudFormation CHỜ tín hiệu "app đã sẵn sàng" thay vì coi resource done ngay khi tạo. `WaitCondition`/`WaitConditionHandle` là cơ chế cũ tương tự. `DependsOn` chỉ điều khiển THỨ TỰ tạo, không chờ ứng dụng bên trong.
- `cfn-init` đọc block `AWS::CloudFormation::Init` (packages/files/services/commands) để cấu hình instance; `cfn-hup` là daemon phát hiện thay đổi metadata và chạy lại `cfn-init` mà không cần thay instance.
- Nested stack (`AWS::CloudFormation::Stack`, dùng `TemplateURL` trỏ S3) vs cross-stack reference (`Export`/`Fn::ImportValue`): nested dùng khi component được **một** stack cha sở hữu và tái sử dụng; cross-stack khi nhiều stack độc lập cần chia sẻ giá trị. Không `ImportValue` được nếu giá trị đang được stack khác import (không xoá/sửa Export đang bị tham chiếu).
- `ChangeSet` cho xem trước thay đổi (đặc biệt cột `Replacement`) trước khi apply; tạo change set không đụng vào stack thật, phải `execute-change-set` mới có hiệu lực.
- `StackSets` deploy một template ra **nhiều account và nhiều region** một lần; cần `AWSCloudFormationStackSetAdministrationRole` + `...ExecutionRole` (self-managed) HOẶC dùng service-managed với AWS Organizations (kèm auto-deploy khi account mới gia nhập OU).
- Capabilities: `CAPABILITY_IAM` cho IAM resource không đặt tên; `CAPABILITY_NAMED_IAM` khi IAM resource có tên cố định (RoleName/UserName...); `CAPABILITY_AUTO_EXPAND` cho macro/nested-stack-từ-macro (SAM `Transform`).
- Drift detection chỉ PHÁT HIỆN thay đổi out-of-band, không sửa. Một số resource không hỗ trợ. Đây là câu trả lời cho "làm sao biết ai đó sửa tay resource do CFN quản lý".
- Pseudo parameters (`AWS::Region`, `AWS::AccountId`, `AWS::StackName`, `AWS::StackId`, `AWS::Partition`, `AWS::NoValue`) dùng trực tiếp với `!Ref`. `AWS::NoValue` kết hợp `Fn::If` để **bỏ hẳn** một property khi điều kiện không thoả.
- Stack policy (JSON gắn vào stack) bảo vệ resource khỏi bị update/replace ngoài ý muốn (`Deny` `Update:Replace`). Khác hoàn toàn termination protection (chặn xoá nguyên stack).
- Service role (`--role-arn`): CloudFormation assume role này để thao tác resource, cho phép tách quyền — user chỉ cần quyền gọi CloudFormation, không cần quyền trực tiếp lên resource bên dưới.

## Quiz chương 20 (10 câu)

**Câu 1.** Một developer cần đảm bảo dữ liệu trong một RDS instance KHÔNG bị mất khi stack CloudFormation bị xoá, nhưng vẫn có thể khôi phục lại được. Cấu hình nào phù hợp nhất?
- A. `DeletionPolicy: Delete`
- B. `DeletionPolicy: Retain`
- C. `DeletionPolicy: Snapshot`
- D. Bật termination protection cho stack

**Câu 2.** Stack của một developer ở trạng thái `CREATE_IN_PROGRESS` suốt gần một giờ tại một `Custom::` resource rồi mới fail. Nguyên nhân khả dĩ nhất?
- A. Lambda thiếu quyền `cloudformation:SignalResource`
- B. Lambda của custom resource không gửi response về `ResponseURL`
- C. Template thiếu `CAPABILITY_AUTO_EXPAND`
- D. Custom resource thiếu `DependsOn`

**Câu 3.** Một developer muốn deploy cùng một template ra 12 account trong AWS Organizations, trên 3 region, và tự động deploy vào account mới khi nó gia nhập OU. Giải pháp nào?
- A. Nested stacks
- B. Cross-stack reference với `Fn::ImportValue`
- C. StackSets service-managed với auto-deployment
- D. Một stack với `Mappings` theo region

**Câu 4.** Template tạo một IAM role có `RoleName: app-prod-role`. Lệnh `create-stack` cần capability nào?
- A. `CAPABILITY_IAM`
- B. `CAPABILITY_NAMED_IAM`
- C. `CAPABILITY_AUTO_EXPAND`
- D. Không cần capability vì là role

**Câu 5.** Một developer cần CloudFormation CHỜ ứng dụng trên EC2 instance hoàn tất cấu hình (cài package, start service) rồi mới coi resource là `CREATE_COMPLETE`. Cơ chế nào?
- A. `DependsOn`
- B. `CreationPolicy` kết hợp `cfn-signal`
- C. `UpdateReplacePolicy`
- D. `Fn::GetAtt` trên instance

**Câu 6.** Team nghi ngờ ai đó sửa Security Group trực tiếp qua console, lệch với template. Cách phát hiện?
- A. Chạy `detect-stack-drift` và đọc `describe-stack-resource-drifts`
- B. Tạo một ChangeSet rỗng
- C. Bật termination protection
- D. Đọc Outputs của stack

**Câu 7.** Developer muốn review chính xác những resource nào sẽ bị **replace** trước khi áp dụng một update production. Nên dùng gì?
- A. `update-stack` rồi rollback nếu sai
- B. `create-change-set` + `describe-change-set` xem cột `Replacement`
- C. Drift detection
- D. Stack policy

**Câu 8.** Trong template, một property `LoggingConfiguration` chỉ nên tồn tại khi `EnvType=prod`, còn `dev` thì bỏ hẳn property đó. Cách viết?
- A. `!If [IsProd, <config>, ""]`
- B. `!If [IsProd, <config>, !Ref "AWS::NoValue"]`
- C. `!FindInMap [Env, prod, Logging]`
- D. `DependsOn: IsProd`

**Câu 9.** Một bucket được export tên qua `Outputs` và đang được stack khác `Fn::ImportValue`. Điều gì đúng?
- A. Có thể xoá stack export bất cứ lúc nào
- B. Không thể xoá/sửa giá trị Export khi nó còn đang được stack khác import
- C. Import value tự động cập nhật khi export đổi
- D. Export hoạt động cross-region mặc định

**Câu 10.** Một developer cần để các thành viên team chạy `update-stack` mà KHÔNG cấp cho họ quyền IAM trực tiếp lên EC2/RDS/IAM bên dưới. Giải pháp ít quyền nhất?
- A. Cấp `AdministratorAccess` tạm thời
- B. Dùng CloudFormation **service role** (`--role-arn`) để CFN assume khi thao tác resource
- C. Dùng nested stacks
- D. Bật termination protection

### Đáp án & giải thích

**Câu 1 — Đáp án C.** `Snapshot` tạo một snapshot RDS trước khi xoá, vừa không mất dữ liệu vừa khôi phục được. A xoá luôn → mất dữ liệu. B (`Retain`) giữ instance đang chạy (vẫn tốn tiền và không phải "khôi phục từ snapshot"), không khớp yêu cầu bằng C. D chỉ chặn xoá nguyên stack, không liên quan tới dữ liệu khi resource bị xoá.

**Câu 2 — Đáp án B.** Custom resource chờ Lambda PUT response về `ResponseURL`; không gửi → CloudFormation chờ tới timeout (tới ~1 giờ) rồi fail. A sai: custom resource không dùng `SignalResource`. C dành cho macro/SAM transform. D (`DependsOn`) chỉ ảnh hưởng thứ tự, không gây treo kiểu này.

**Câu 3 — Đáp án C.** StackSets sinh ra để deploy một template ra nhiều account + nhiều region; service-managed (qua Organizations) hỗ trợ auto-deployment vào account mới của OU. A (nested) trong cùng một account/stack cha. B chia sẻ giá trị, không deploy đa account. D chỉ là mapping trong một stack đơn.

**Câu 4 — Đáp án B.** Khi IAM resource có **tên cố định** (RoleName), bắt buộc `CAPABILITY_NAMED_IAM`. A chỉ đủ khi IAM resource KHÔNG đặt tên. C cho macro/auto-expand. D sai — mọi IAM resource đều cần capability.

**Câu 5 — Đáp án B.** `CreationPolicy` khiến CloudFormation chờ số lượng `cfn-signal` mong đợi (gửi từ user data sau khi app ready) trước khi đánh dấu `CREATE_COMPLETE`. A (`DependsOn`) chỉ sắp thứ tự tạo, không chờ app bên trong. C dành cho update gây replace. D không có cơ chế chờ.

**Câu 6 — Đáp án A.** Drift detection so sánh property thực tế với template để phát hiện thay đổi out-of-band — đúng kịch bản sửa tay SG. B (change set rỗng) so với template, không so với trạng thái thực resource. C chặn xoá. D không cho biết drift.

**Câu 7 — Đáp án B.** ChangeSet liệt kê từng resource với `Action` và `Replacement` (True/False/Conditional) TRƯỚC khi apply — cách an toàn cho production. A là apply trực tiếp rồi mới sửa (rủi ro). C phát hiện drift, không dự đoán replace. D bảo vệ resource, không "xem trước".

**Câu 8 — Đáp án B.** `!Ref AWS::NoValue` trong nhánh else của `Fn::If` khiến CloudFormation **bỏ hẳn** property đó. A đặt chuỗi rỗng (property vẫn tồn tại, thường gây lỗi validation). C trả mapping, không bỏ property. D sai cú pháp hoàn toàn.

**Câu 9 — Đáp án B.** Không thể xoá hay thay đổi một Export khi nó đang được stack khác `Fn::ImportValue` — đây là cơ chế bảo vệ phụ thuộc của cross-stack. A sai vì lý do đó. C sai: import value chỉ resolve lúc create/update, không tự đồng bộ. D sai: Export là phạm vi region, không cross-region.

**Câu 10 — Đáp án B.** Service role để CloudFormation assume khi thao tác resource, nhờ đó user chỉ cần quyền gọi CloudFormation chứ không cần quyền trực tiếp lên EC2/RDS/IAM — tách quyền theo least privilege. A vi phạm least privilege nặng. C không liên quan tới phân quyền. D chỉ chặn xoá stack.

## Tóm tắt chương

- `Mappings` + `Fn::FindInMap` tra cứu giá trị tĩnh theo key (thường theo region/env); `Conditions` + `Fn::If`/`Fn::Equals`/`Fn::And`/`Fn::Or`/`Fn::Not` bật-tắt resource hoặc property; `AWS::NoValue` để bỏ hẳn một property.
- Pseudo parameters (`AWS::Region`, `AWS::AccountId`, `AWS::StackName`, `AWS::Partition`...) có sẵn không cần khai báo, dùng qua `!Ref`.
- `DeletionPolicy` (`Retain`/`Snapshot`/`Delete`) áp dụng khi xoá; `UpdateReplacePolicy` áp dụng khi update gây replacement — hai cờ độc lập, set cả hai để bảo toàn dữ liệu trong mọi trường hợp.
- Custom resource (Lambda-backed) mở rộng CloudFormation cho logic tuỳ biến; Lambda phải xử lý Create/Update/Delete và LUÔN gửi response về `ResponseURL`, nếu không stack treo.
- `CreationPolicy` + `cfn-signal` để CHỜ ứng dụng sẵn sàng; `cfn-init` cấu hình instance từ metadata; `cfn-hup` chạy lại cfn-init khi metadata đổi; `DependsOn` chỉ điều khiển thứ tự.
- Nested stacks dành cho component thuộc một stack cha; cross-stack (`Export`/`Fn::ImportValue`) chia sẻ giá trị giữa các stack độc lập trong cùng account+region — không xoá/sửa Export đang bị import.
- ChangeSets cho phép xem trước thay đổi (đặc biệt cờ `Replacement`) mà không đụng stack thật; phải `execute-change-set` mới apply.
- StackSets deploy một template ra nhiều account và nhiều region; self-managed cần admin/execution role, service-managed qua Organizations hỗ trợ auto-deploy vào account mới.
- Capabilities: `CAPABILITY_IAM` (IAM không tên), `CAPABILITY_NAMED_IAM` (IAM có tên), `CAPABILITY_AUTO_EXPAND` (macro/SAM transform).
- Drift detection phát hiện thay đổi out-of-band so với template (không tự sửa, một số resource không hỗ trợ).
- Stack policy bảo vệ resource khỏi update/replace ngoài ý muốn; termination protection chặn xoá nguyên stack; service role (`--role-arn`) tách quyền giữa người gọi CFN và resource bên dưới.
