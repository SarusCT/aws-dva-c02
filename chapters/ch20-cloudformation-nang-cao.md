# Chương 20: AWS CloudFormation nâng cao

> **Trọng tâm DVA-C02:** CloudFormation nâng cao là mỏ câu hỏi trong domain Deployment. Đề hay hỏi: chọn `DeletionPolicy`/`UpdateReplacePolicy` để không mất dữ liệu khi xoá/replace stack; vì sao stack update cần ChangeSet; khi nào dùng nested stack vs cross-stack (Export/ImportValue); custom resource Lambda-backed để gọi tới dịch vụ CloudFormation chưa hỗ trợ; `CreationPolicy` + `cfn-signal` để stack chờ ứng dụng khởi động xong; và lỗi `InsufficientCapabilitiesException` khi template tạo IAM resource mà thiếu `CAPABILITY_IAM`. Đây là dạng câu "least operational overhead" và "không được mất dữ liệu".

## Mục tiêu chương
- Dùng thành thạo **Mappings**, **Conditions + Fn::If**, **pseudo parameters** để viết template linh hoạt theo region/môi trường.
- Phân biệt và chọn đúng giữa **nested stacks** và **cross-stack reference** (Export/ImportValue).
- Hiểu **ChangeSets**, **drift detection**, **stack policies**, **termination protection** — các cơ chế an toàn khi update production.
- Bảo vệ dữ liệu khi xoá/replace bằng **DeletionPolicy** (Retain/Snapshot/Delete) và **UpdateReplacePolicy**.
- Viết **custom resource** Lambda-backed và hiểu vòng đời Create/Update/Delete + response signed URL.
- Dùng **CreationPolicy + cfn-signal**, **cfn-init/cfn-hup**, **DependsOn**, đúng **capabilities** (IAM/NAMED_IAM/AUTO_EXPAND), **service role**, và **StackSets**.

---

## 20.1 Mappings — bảng tra cứu tĩnh trong template

`Mappings` là một dictionary hai cấp khoá cố định, định nghĩa ngay trong template, giúp bạn tra giá trị mà không cần truyền parameter. Use case kinh điển: chọn AMI ID theo region (mỗi region có AMI ID khác nhau cho cùng một bản OS), hoặc chọn instance size theo môi trường `dev`/`prod`.

```yaml
Mappings:
  RegionAMIMap:
    us-east-1:
      HVM64: ami-0abcdef1234567890
    ap-southeast-1:
      HVM64: ami-0fedcba9876543210
  EnvConfig:
    dev:
      InstanceType: t3.micro
    prod:
      InstanceType: m6i.large

Resources:
  MyInstance:
    Type: AWS::EC2::Instance
    Properties:
      # Fn::FindInMap [ MapName, TopLevelKey, SecondLevelKey ]
      ImageId: !FindInMap [ RegionAMIMap, !Ref "AWS::Region", HVM64 ]
      InstanceType: !FindInMap [ EnvConfig, !Ref EnvType, InstanceType ]
```

Cơ chế: `Fn::FindInMap` được giải (resolve) lúc CloudFormation xử lý template, trước khi tạo resource. Top-level key thường là `AWS::Region` (pseudo parameter) để map tự động đổi giá trị theo region đang deploy — đây chính là lý do Mappings được sinh ra: tránh viết một template riêng cho mỗi region.

Khác biệt với Parameters: Mappings là **tĩnh, bất biến lúc runtime** (người deploy không sửa được), còn Parameters là input người dùng nhập. Khi giá trị "phải cố định và phụ thuộc region/môi trường" → Mappings. Khi giá trị "do người deploy quyết định" → Parameters.

Giới hạn cần nhớ: tối đa **200 mappings/template**, mỗi mapping tối đa **64 top-level keys** và **64 second-level keys**. `Fn::FindInMap` chỉ nhận literal string hoặc `Ref`/pseudo parameter làm key — **không lồng được** các hàm phức tạp khác ở vị trí key trong phiên bản cổ điển (CFN đã nới lỏng dần nhưng đề thi vẫn coi key là literal/Ref).

So sánh nhanh ba cách chọn AMI theo region để khỏi nhầm trong đề:

| Cách | Khi nào dùng | Đặc điểm |
|---|---|---|
| `Mappings` + `Fn::FindInMap` | AMI ID cố định, biết trước, ít đổi | Phải tự cập nhật map khi có AMI mới |
| Parameter type `AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>` | Muốn luôn lấy AMI mới nhất (Amazon Linux) | CFN tự resolve từ public SSM parameter lúc deploy |
| Parameter thường (người nhập AMI) | Người deploy tự quyết | Dễ nhập sai, ít dùng cho multi-region |

> 💡 **Exam Tip:** Câu hỏi kiểu "template phải deploy được ở nhiều region mà không sửa code, AMI khác nhau mỗi region" → đáp án là **Mappings + Fn::FindInMap với key là `AWS::Region`**. Nếu đề nói "luôn dùng AMI Amazon Linux mới nhất, không phải maintain" → dùng **SSM public parameter** (`/aws/service/ami-amazon-linux-latest/...`) qua parameter type `AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>`.

---

## 20.2 Conditions & Fn::If — tạo resource có điều kiện

`Conditions` cho phép tạo/bỏ qua resource hoặc gán property khác nhau tuỳ điều kiện boolean. Đây là cách một template duy nhất phục vụ cả `dev` lẫn `prod`.

```yaml
Parameters:
  EnvType:
    Type: String
    AllowedValues: [ dev, prod ]
    Default: dev

Conditions:
  IsProd: !Equals [ !Ref EnvType, prod ]
  # Kết hợp logic: And / Or / Not
  CreateReadReplica: !And
    - !Equals [ !Ref EnvType, prod ]
    - !Not [ !Equals [ !Ref EnvType, dev ] ]

Resources:
  DBReplica:
    Type: AWS::RDS::DBInstance
    Condition: CreateReadReplica   # resource chỉ tồn tại khi điều kiện = true
    Properties:
      SourceDBInstanceIdentifier: !Ref PrimaryDB

  AppInstance:
    Type: AWS::EC2::Instance
    Properties:
      # Fn::If [ ConditionName, ValueIfTrue, ValueIfFalse ]
      InstanceType: !If [ IsProd, m6i.large, t3.micro ]
      Monitoring: !If [ IsProd, true, false ]
```

Các hàm điều kiện: `Fn::Equals`, `Fn::And`, `Fn::Or`, `Fn::Not`, và đặc biệt `AWS::NoValue` — dùng với `Fn::If` để **xoá hẳn một property** khi điều kiện sai (không phải để rỗng, mà như thể property đó không tồn tại):

```yaml
      # Nếu không phải prod thì bỏ hẳn property SnapshotIdentifier
      SnapshotIdentifier: !If [ IsProd, !Ref SnapshotId, !Ref "AWS::NoValue" ]
```

Bẫy thực tế: khi một resource gắn `Condition` và bị loại (condition = false), mọi tham chiếu `Ref`/`GetAtt` tới nó trong các resource khác sẽ **lỗi template validation** trừ khi tham chiếu đó cũng được bọc trong `Fn::If`. Vì vậy nếu resource A optional, mọi nơi dùng A đều phải `!If [ConditionA, !Ref A, !Ref "AWS::NoValue"]`.

> 💡 **Exam Tip:** "Một template dùng cho cả dev và prod, prod thì có read replica, dev thì không" → dùng **Conditions** gắn vào resource + `Fn::If` cho property. Nhớ `AWS::NoValue` là cách remove property — đề hay hỏi cách "không set property này khi điều kiện sai".

---

## 20.3 Pseudo parameters — biến môi trường có sẵn

Pseudo parameters là tham số AWS cung cấp sẵn, không cần khai báo trong `Parameters`, dùng qua `Ref`. Chúng làm template portable (không hardcode account/region):

| Pseudo parameter | Giá trị trả về |
|---|---|
| `AWS::AccountId` | 12 số account ID đang deploy |
| `AWS::Region` | Region đang deploy (vd `ap-southeast-1`) |
| `AWS::StackName` | Tên stack |
| `AWS::StackId` | ARN đầy đủ của stack |
| `AWS::Partition` | `aws`, `aws-cn`, hoặc `aws-us-gov` |
| `AWS::URLSuffix` | `amazonaws.com` (đổi ở China/GovCloud) |
| `AWS::NotificationARNs` | List ARN SNS notification của stack |
| `AWS::NoValue` | "Không có giá trị" (xoá property, xem 20.2) |

Ví dụ tạo ARN portable cho IAM policy (không hardcode partition/region/account):

```yaml
      Resource: !Sub "arn:${AWS::Partition}:s3:::${AWS::AccountId}-my-bucket/*"
```

`AWS::Partition` và `AWS::URLSuffix` đặc biệt quan trọng nếu template cần chạy ở AWS China hoặc GovCloud — hardcode `arn:aws:` sẽ hỏng ở `arn:aws-cn:`.

> 💡 **Exam Tip:** Khi cần ARN/tên duy nhất theo account và region mà không hardcode → dùng `Fn::Sub` kết hợp `AWS::AccountId` + `AWS::Region`. Đây là cách tạo tên bucket/log group không bị trùng giữa các account.

---

## 20.4 Nested stacks vs cross-stack reference

Khi hệ thống lớn, bạn không nhồi tất cả vào một template. Có hai cách chia nhỏ — đề thi rất hay so sánh.

**Cross-stack reference (Export/ImportValue):** Stack A export một output, stack B import. Dùng khi nhiều stack độc lập cần chia sẻ một giá trị bền vững (vd: VPC ID, subnet ID dùng chung).

```yaml
# Stack network (producer)
Outputs:
  VpcId:
    Value: !Ref MyVPC
    Export:
      Name: prod-vpc-id    # tên export phải duy nhất trong 1 region/account

# Stack app (consumer)
Resources:
  AppSG:
    Type: AWS::EC2::SecurityGroup
    Properties:
      VpcId: !ImportValue prod-vpc-id
```

Ràng buộc của Export: **không xoá/sửa được output đang được stack khác import** — CloudFormation chặn để tránh hỏng phụ thuộc. Bạn phải bỏ import ở consumer trước, rồi mới sửa được export. Export name duy nhất trong phạm vi region + account.

**Nested stacks:** Stack cha chứa resource `AWS::CloudFormation::Stack` trỏ tới template con đặt trên S3. Dùng khi muốn **tái sử dụng component** (vd một template "security-group chuẩn") nhiều lần, hoặc gom nhóm để vượt giới hạn resource/template.

```yaml
Resources:
  NetworkStack:
    Type: AWS::CloudFormation::Stack
    Properties:
      TemplateURL: https://s3.amazonaws.com/my-templates/network.yaml
      Parameters:
        CidrBlock: 10.0.0.0/16
      TimeoutInMinutes: 20
```

| Tiêu chí | Cross-stack (Export/Import) | Nested stacks |
|---|---|---|
| Mục đích | Chia sẻ giá trị giữa các stack **đời sống độc lập** | **Tái sử dụng** component, gom nhóm |
| Quản lý vòng đời | Mỗi stack update/xoá riêng | Cha quản lý con; xoá cha xoá con |
| Lấy giá trị | `Fn::ImportValue` | `Fn::GetAtt NestedStack.Outputs.X` |
| Ràng buộc | Không xoá export đang bị import | Cập nhật con qua cập nhật cha |
| Khi nào dùng | Layer hạ tầng dùng chung lâu dài (VPC) | Module hoá template, lặp lại pattern |

> 💡 **Exam Tip:** "Tái sử dụng component nhiều lần" → **nested stacks**. "Chia sẻ một giá trị (VPC ID) cho nhiều stack tồn tại độc lập" → **cross-stack với Export/ImportValue**. Nhớ: không thể xoá stack đang export giá trị bị stack khác import.

---

## 20.5 ChangeSets, stack policies & rollback

**ChangeSet** là bản xem trước (preview) những thay đổi mà một stack update sẽ gây ra **trước khi thực thi**. Quan trọng vì một số update là *replacement* — CloudFormation xoá resource cũ tạo resource mới (đổi ID, có thể mất dữ liệu/downtime). ChangeSet cho bạn thấy cột `Replacement: True/False` để biết resource nào sẽ bị thay.

```bash
# Tạo change set
aws cloudformation create-change-set \
  --stack-name my-app \
  --change-set-name update-db-size \
  --template-body file://template.yaml \
  --capabilities CAPABILITY_NAMED_IAM

# Xem chi tiết (chú ý field Replacement)
aws cloudformation describe-change-set \
  --stack-name my-app --change-set-name update-db-size

# Đồng ý thì execute, không thì xoá change set
aws cloudformation execute-change-set \
  --stack-name my-app --change-set-name update-db-size
```

**Stack policy:** JSON gắn vào stack để **bảo vệ resource khỏi bị update vô tình**. Khác hoàn toàn IAM policy: stack policy chỉ kiểm soát hành động update *thông qua CloudFormation*, không liên quan quyền API. Mặc định khi chưa set stack policy, mọi resource update được. Khi đã set, mọi resource bị **Deny ngầm** trừ khi Allow rõ.

```json
{
  "Statement": [
    { "Effect": "Allow", "Action": "Update:*", "Principal": "*", "Resource": "*" },
    { "Effect": "Deny", "Action": "Update:Replace", "Principal": "*",
      "Resource": "LogicalResourceId/ProductionDatabase" }
  ]
}
```

Để cố ý update resource đang bị stack policy chặn, bạn phải truyền **stack policy tạm thời** (`--stack-policy-during-update-body`) lúc update.

Về **rollback**: mặc định, nếu một resource tạo/update lỗi, stack tự **rollback** về trạng thái trước đó (`UPDATE_ROLLBACK_COMPLETE` hoặc `ROLLBACK_COMPLETE`). Một stack `ROLLBACK_COMPLETE` (lỗi ngay lần create đầu) **không update được** — phải xoá rồi tạo lại. Bạn có thể tắt rollback bằng `--disable-rollback` để debug resource lỗi (CFN giữ nguyên trạng thái để bạn xem).

> 💡 **Exam Tip:** "Muốn xem trước thay đổi của stack update mà chưa áp dụng" → **ChangeSet**. "Bảo vệ database production khỏi bị xoá/replace do update nhầm" → **stack policy** với `Deny Update:Replace`/`Update:Delete`. Đừng nhầm stack policy với IAM policy.

---

## 20.6 DeletionPolicy & UpdateReplacePolicy — chống mất dữ liệu

Đây là **điểm thi nặng nhất** của chương. Mặc định khi xoá stack, CloudFormation xoá luôn mọi resource — kể cả S3 bucket có data, RDS có dữ liệu. Hai attribute sau ghi đè hành vi đó.

**`DeletionPolicy`** — quyết định điều gì xảy ra với resource khi **xoá stack** (hoặc khi resource bị remove khỏi template):
- `Delete` (mặc định cho hầu hết): xoá resource.
- `Retain`: giữ resource lại, CloudFormation "buông" nó (không quản lý nữa).
- `Snapshot`: tạo snapshot trước khi xoá (chỉ áp dụng resource hỗ trợ snapshot: EBS Volume, RDS DBInstance/DBCluster, ElastiCache, Redshift...).

**`UpdateReplacePolicy`** — quyết định điều gì xảy ra với resource **cũ** khi một update gây **replacement** (CFN phải tạo resource mới thay resource cũ). Giá trị giống hệt: `Delete`/`Retain`/`Snapshot`.

```yaml
Resources:
  ProdDatabase:
    Type: AWS::RDS::DBInstance
    DeletionPolicy: Snapshot         # xoá stack → chụp snapshot rồi mới xoá
    UpdateReplacePolicy: Snapshot    # update gây replace → snapshot resource cũ
    Properties:
      Engine: postgres
      AllocatedStorage: 100

  AppBucket:
    Type: AWS::S3::Bucket
    DeletionPolicy: Retain           # giữ bucket khi xoá stack
    UpdateReplacePolicy: Retain
```

Bẫy kinh điển: nhiều người chỉ set `DeletionPolicy: Retain` rồi tưởng an toàn. Nhưng nếu update gây **replacement** (vd đổi tên bucket — một property immutable), data resource cũ vẫn bị xoá vì đó không phải "delete stack" mà là "replace" → cần thêm `UpdateReplacePolicy: Retain`. Hai attribute **độc lập**, set cả hai mới chặn được mọi đường mất dữ liệu.

Một lưu ý S3: `DeletionPolicy: Delete` chỉ xoá được bucket **rỗng** — nếu bucket còn object, xoá stack sẽ **fail** ở resource bucket (trừ khi dùng custom resource để empty bucket trước, xem 20.8).

Thêm vài chi tiết hay bị hỏi: với `DeletionPolicy: Snapshot`, sau khi stack xoá, **snapshot vẫn nằm lại và bạn vẫn bị tính phí lưu trữ** — CFN không tự dọn snapshot đó. Với `Retain`, resource bị "mồ côi" khỏi stack: lần sau muốn quản lý lại phải dùng tính năng import (20.9). Và lưu ý `DeletionPolicy` chỉ có hiệu lực khi resource thực sự bị xoá vì lệnh delete-stack hoặc bị remove khỏi template — nó **không** can thiệp vào replacement (đó là việc của `UpdateReplacePolicy`).

Một số resource (vd `AWS::RDS::DBCluster`, `AWS::RDS::DBInstance` không thuộc cluster) mặc định `DeletionPolicy` là `Snapshot` chứ không phải `Delete` — nên xoá stack có thể vẫn để lại snapshot tính phí ngoài ý muốn. Luôn khai báo tường minh thay vì dựa vào mặc định.

> 💡 **Exam Tip:** Câu "phải giữ lại dữ liệu database/S3 khi xoá stack" → `DeletionPolicy: Retain` (hoặc `Snapshot` nếu muốn backup). Câu "đảm bảo không mất dữ liệu cả khi xoá lẫn khi update gây replace" → set **CẢ** `DeletionPolicy` **VÀ** `UpdateReplacePolicy`.

---

## 20.7 CreationPolicy, cfn-signal, cfn-init & cfn-hup

Mặc định CloudFormation coi một EC2 instance là "tạo xong" ngay khi instance ở trạng thái `running` — nhưng lúc đó ứng dụng bên trong **chưa chắc đã khởi động**. `CreationPolicy` buộc CloudFormation **chờ tín hiệu** từ bên trong instance trước khi đánh dấu resource thành công.

```yaml
Resources:
  AppServer:
    Type: AWS::EC2::Instance
    CreationPolicy:
      ResourceSignal:
        Count: 1
        Timeout: PT15M        # chờ tối đa 15 phút (ISO 8601 duration)
    Properties:
      ImageId: !Ref AmiId
      UserData:
        Fn::Base64: !Sub |
          #!/bin/bash
          # cài app...
          # gửi tín hiệu thành công về CFN
          /opt/aws/bin/cfn-signal -e $? \
            --stack ${AWS::StackName} \
            --resource AppServer \
            --region ${AWS::Region}
```

Bộ helper scripts (`aws-cfn-bootstrap`):
- **`cfn-init`**: đọc metadata `AWS::CloudFormation::Init` để cài package, ghi file, tạo user, start service một cách khai báo (declarative) — sạch hơn viết shell dài trong UserData.
- **`cfn-signal`**: gửi success/failure về `CreationPolicy` (hoặc về ASG khi dùng với `UpdatePolicy`).
- **`cfn-hup`**: daemon theo dõi thay đổi metadata; khi bạn update stack đổi `Metadata::Init`, cfn-hup chạy lại cfn-init để áp cấu hình mới **mà không cần replace instance**.

```yaml
    Metadata:
      AWS::CloudFormation::Init:
        config:
          packages:
            yum: { httpd: [] }
          files:
            /var/www/html/index.html:
              content: "Hello from CFN"
          services:
            sysvinit:
              httpd: { enabled: true, ensureRunning: true }
```

Phân biệt `CreationPolicy` với `WaitCondition`: cả hai đều "chờ tín hiệu", nhưng `CreationPolicy` gắn trực tiếp vào EC2 instance/ASG (gọn, được khuyến nghị), còn `AWS::CloudFormation::WaitCondition` + `WaitConditionHandle` là cặp resource riêng (cách cũ, dùng khi cần chờ tín hiệu từ thứ không phải EC2/ASG). Khi dùng với ASG, `cfn-signal` kết hợp `UpdatePolicy` để rolling update đợi từng instance mới healthy mới thay tiếp.

`Timeout` dùng định dạng ISO 8601 duration: `PT15M` = 15 phút, `PT1H` = 1 giờ, `PT5M30S` = 5 phút 30 giây. Hết timeout mà chưa đủ `Count` tín hiệu thành công → stack fail và rollback. Bẫy hay gặp: UserData lỗi giữa chừng nên `cfn-signal` không bao giờ chạy → stack treo đến hết timeout rồi rollback, log lỗi nằm trong `/var/log/cloud-init-output.log` trên instance.

> 💡 **Exam Tip:** "Stack báo CREATE_COMPLETE nhưng ứng dụng chưa sẵn sàng / muốn CFN chờ app khởi động xong" → **CreationPolicy + cfn-signal**. Nếu đề hỏi "cập nhật cấu hình instance khi update stack mà không tạo lại instance" → **cfn-hup**. "Cài package, ghi file, start service một cách khai báo" → **cfn-init + Metadata AWS::CloudFormation::Init**. `WaitCondition` là cách cũ; với EC2 ưu tiên `CreationPolicy`.

---

## 20.8 DependsOn & custom resources (Lambda-backed)

**`DependsOn`** ép thứ tự tạo resource. CloudFormation tự suy ra phụ thuộc qua `Ref`/`GetAtt`, nhưng khi không có tham chiếu trực tiếp mà vẫn cần thứ tự (vd EC2 phải đợi NAT Gateway/route ra internet xong mới boot để cài package) thì khai báo tay:

```yaml
  AppInstance:
    Type: AWS::EC2::Instance
    DependsOn: NatGatewayRoute   # hoặc list: [ A, B ]
```

**Custom resources** cho phép CloudFormation gọi logic tuỳ ý khi dịch vụ/tính năng chưa được CFN hỗ trợ native, hoặc cần chạy thao tác (vd empty S3 bucket trước khi xoá, lookup AMI mới nhất, đăng ký với hệ thống bên ngoài). Backing thường là **Lambda** (`AWS::CloudFormation::CustomResource` hoặc `Custom::<Tên>`).

Cơ chế: CFN gửi event JSON tới Lambda với `RequestType` là `Create`/`Update`/`Delete`, kèm `ResponseURL` (presigned S3 URL). Lambda **bắt buộc** PUT một response (`SUCCESS`/`FAILED`) về URL này — nếu không, CFN treo tới khi timeout (mặc định khá lâu) rồi fail.

```javascript
// Lambda custom resource (Node.js) — phải luôn gửi response về ResponseURL
exports.handler = async (event) => {
  const respond = async (status, data = {}, physicalId) => {
    const body = JSON.stringify({
      Status: status,                       // SUCCESS | FAILED
      Reason: "Xem CloudWatch Logs để biết chi tiet",
      PhysicalResourceId: physicalId || event.LogicalResourceId,
      StackId: event.StackId,
      RequestId: event.RequestId,
      LogicalResourceId: event.LogicalResourceId,
      Data: data,
    });
    // PUT lên presigned URL của CFN — KHÔNG cần ký SigV4
    await fetch(event.ResponseURL, { method: "PUT", body });
  };

  try {
    if (event.RequestType === "Delete") {
      // dọn dẹp (vd: empty bucket) rồi báo SUCCESS
      return respond("SUCCESS");
    }
    // Create/Update: làm việc, trả Data để stack đọc qua GetAtt
    return respond("SUCCESS", { ApiId: "abc123" });
  } catch (err) {
    return respond("FAILED");               // luôn báo về, tránh treo stack
  }
};
```

Bẫy số 1 trong production: Lambda lỗi/timeout mà **không** gửi response → stack kẹt ở `CREATE_IN_PROGRESS`/`DELETE_IN_PROGRESS` rất lâu. Luôn bọc `try/catch` và gửi response trong cả nhánh lỗi. Khi xoá stack, đừng quên xử lý `RequestType === "Delete"`, nếu không stack `DELETE_FAILED`.

> 💡 **Exam Tip:** "CloudFormation chưa hỗ trợ tài nguyên/thao tác X" hoặc "cần chạy code lúc create/delete stack (vd empty bucket trước khi xoá)" → **custom resource Lambda-backed**. Nhớ Lambda phải PUT kết quả về **presigned ResponseURL**, xử lý đủ Create/Update/Delete.

---

## 20.9 Capabilities, service role, StackSets, drift & import

**Capabilities** — chốt chặn an toàn khi template tạo resource nhạy cảm:
- `CAPABILITY_IAM`: template tạo IAM resource (role, policy) **không đặt tên cụ thể**.
- `CAPABILITY_NAMED_IAM`: template tạo IAM resource **có đặt tên** (set `RoleName`, `PolicyName`...). Tên cố định có thể gây xung đột → cần xác nhận mạnh hơn.
- `CAPABILITY_AUTO_EXPAND`: template dùng **macro** hoặc **Transform** (như `AWS::Serverless` của SAM, hay `AWS::Include`) sinh thêm resource lúc deploy.

Thiếu capability → lỗi `InsufficientCapabilitiesException`. Trên CLI phải truyền `--capabilities CAPABILITY_NAMED_IAM` (có thể liệt kê nhiều).

```bash
aws cloudformation deploy \
  --template-file template.yaml \
  --stack-name my-app \
  --capabilities CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND \
  --role-arn arn:aws:iam::111122223333:role/cfn-service-role
```

**Service role:** mặc định CloudFormation dùng **quyền của người đang gọi** để tạo resource. Truyền `--role-arn` (CloudFormation service role) để CFN dùng role đó thay vì quyền user — hữu ích khi muốn giới hạn: developer được phép *chạy* stack nhưng bản thân không có quyền tạo trực tiếp các resource đó. Đây là pattern phân tách quyền (least privilege) hay gặp trong câu hỏi security.

**StackSets:** deploy **một template ra nhiều account và nhiều region** cùng lúc từ một thao tác. Có hai mô hình quyền: **self-managed** (bạn tự tạo admin role + execution role) và **service-managed** (tích hợp AWS Organizations, tự động deploy vào account mới khi gia nhập org). Dùng StackSets cho governance/baseline (vd bật CloudTrail, IAM role chuẩn cho toàn org).

**Drift detection:** phát hiện resource đã bị thay đổi **ngoài CloudFormation** (ai đó sửa tay qua console/CLI). CFN so sánh trạng thái thực tế với template và báo `DRIFTED`/`IN_SYNC` cho từng resource và property.

```bash
aws cloudformation detect-stack-drift --stack-name my-app
aws cloudformation describe-stack-resource-drifts --stack-name my-app
```

**Termination protection:** bật cờ để chặn lệnh `delete-stack` (kể cả vô tình). Phải tắt mới xoá được — khác `DeletionPolicy` (cái này bảo vệ *resource bên trong* khi stack bị xoá; termination protection bảo vệ *cả stack* khỏi bị xoá).

```bash
aws cloudformation update-termination-protection \
  --stack-name my-app --enable-termination-protection
```

**Import resources:** đưa resource **có sẵn** (tạo tay ngoài CFN) vào quản lý bởi stack mà **không tạo lại/không downtime**. Khai báo resource trong template kèm `DeletionPolicy` (bắt buộc với mọi resource import), gắn `--resources-to-import` ánh xạ logical ID với resource thật qua identifier (vd bucket name). Use case điển hình: hệ thống dựng tay từ lâu, giờ muốn đưa về IaC mà không dám xoá tạo lại.

```bash
aws cloudformation create-change-set \
  --stack-name my-app --change-set-name import-bucket \
  --change-set-type IMPORT \
  --resources-to-import '[{"ResourceType":"AWS::S3::Bucket",
      "LogicalResourceId":"AppBucket",
      "ResourceIdentifier":{"BucketName":"my-existing-bucket"}}]' \
  --template-body file://template-with-bucket.yaml
```

Phân biệt nhanh bốn cơ chế "bảo vệ" hay bị gài lẫn lộn trong đề:

| Cơ chế | Bảo vệ cái gì | Chống điều gì |
|---|---|---|
| `DeletionPolicy` | Resource bên trong stack | Mất resource khi **xoá stack** |
| `UpdateReplacePolicy` | Resource bên trong stack | Mất resource khi **update gây replace** |
| Stack policy | Resource trong stack | **Update** vô tình lên resource quan trọng |
| Termination protection | Cả stack | Lệnh **delete-stack** vô tình |

> 💡 **Exam Tip:** "Đưa tài nguyên tạo thủ công vào quản lý bởi CloudFormation mà không gây downtime" → **resource import** (change set type `IMPORT`). Đừng chọn xoá rồi tạo lại bằng template (mất dữ liệu/downtime).

> 💡 **Exam Tip:** Lỗi `InsufficientCapabilitiesException` khi deploy template có IAM role → thiếu `CAPABILITY_IAM`/`CAPABILITY_NAMED_IAM`. Deploy SAM/macro → cần `CAPABILITY_AUTO_EXPAND`. "Deploy chuẩn an ninh ra mọi account trong Organization" → **StackSets (service-managed)**. "Phát hiện ai sửa tay resource ngoài IaC" → **drift detection**. "Chặn xoá nhầm cả stack" → **termination protection**.

---

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
