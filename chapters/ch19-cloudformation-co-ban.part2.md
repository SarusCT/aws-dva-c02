## Hands-on Lab: Viết template VPC + EC2 + S3, dùng Parameters, intrinsic functions, Outputs/Export, deploy & update bằng CLI

**Mục tiêu lab:** Viết một template YAML hoàn chỉnh thể hiện gần như toàn bộ phạm vi chương: `Parameters` (có constraint và SSM type), `Mappings` để chọn AMI theo region, `Resources` (VPC, Subnet, Security Group, EC2 Instance, S3 Bucket), các intrinsic functions `Ref`/`Fn::GetAtt`/`Fn::Sub`/`Fn::Join`/`Fn::FindInMap`, và `Outputs` có `Export` để stack khác `Fn::ImportValue`. Sau đó tạo stack, quan sát update behavior, gây ra một lỗi để thấy automatic rollback, rồi dọn dẹp.

**Chuẩn bị:**
- AWS CLI v2 đã cấu hình (`aws sts get-caller-identity` chạy được). Region dùng `ap-southeast-1` (Singapore) trong lab này.
- IAM principal có quyền tạo VPC, EC2, S3, và CloudFormation. CloudFormation gọi service API **bằng quyền của bạn** (trừ khi gắn service role), nên thiếu quyền nào thì stack sẽ fail ở resource đó.
- Một thư mục làm việc: `mkdir -p ~/cfn-lab && cd ~/cfn-lab` (các lệnh dưới giả định bạn đang ở đây, nhưng dùng đường dẫn tuyệt đối khi cần).

### Bước 1: Viết template chính `network.yaml`

Tạo file `~/cfn-lab/network.yaml`:

```yaml
AWSTemplateFormatVersion: "2010-09-09"
Description: >
  Lab Chuong 19 - VPC + EC2 + S3 minh hoa Parameters, Mappings,
  intrinsic functions va Outputs/Export.

Parameters:
  EnvName:
    Type: String
    Default: dev
    AllowedValues: [dev, staging, prod]
    Description: Ten moi truong, dung de dat ten tai nguyen.
  InstanceType:
    Type: String
    Default: t3.micro
    AllowedValues: [t3.micro, t3.small]
    ConstraintDescription: Chi cho phep t3.micro hoac t3.small.
  LatestAmiId:
    # SSM parameter type: CFN tu resolve gia tri tu Parameter Store luc deploy,
    # khong can hardcode AMI ID -> luon lay Amazon Linux 2023 moi nhat.
    Type: AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>
    Default: /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64

Mappings:
  EnvToCidr:
    dev:    { Vpc: "10.10.0.0/16", Subnet: "10.10.1.0/24" }
    staging:{ Vpc: "10.20.0.0/16", Subnet: "10.20.1.0/24" }
    prod:   { Vpc: "10.30.0.0/16", Subnet: "10.30.1.0/24" }

Resources:
  Vpc:
    Type: AWS::EC2::VPC
    Properties:
      CidrBlock: !FindInMap [EnvToCidr, !Ref EnvName, Vpc]
      EnableDnsSupport: true
      EnableDnsHostnames: true
      Tags:
        - Key: Name
          Value: !Sub "${EnvName}-vpc"

  Subnet:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref Vpc
      CidrBlock: !FindInMap [EnvToCidr, !Ref EnvName, Subnet]
      MapPublicIpOnLaunch: false
      Tags:
        - Key: Name
          Value: !Join ["-", [!Ref EnvName, "subnet"]]

  InstanceSg:
    Type: AWS::EC2::SecurityGroup
    Properties:
      GroupDescription: !Sub "SG cho ${EnvName} instance - khong mo port nao tu internet"
      VpcId: !Ref Vpc
      Tags:
        - Key: Name
          Value: !Sub "${EnvName}-sg"

  AppInstance:
    Type: AWS::EC2::Instance
    Properties:
      InstanceType: !Ref InstanceType
      ImageId: !Ref LatestAmiId
      SubnetId: !Ref Subnet
      SecurityGroupIds:
        - !Ref InstanceSg
      Tags:
        - Key: Name
          Value: !Sub "${EnvName}-app"

  AppBucket:
    Type: AWS::S3::Bucket
    Properties:
      # Ten bucket phai global-unique; ghep AccountId + Region (pseudo params)
      BucketName: !Sub "${EnvName}-app-${AWS::AccountId}-${AWS::Region}"
      PublicAccessBlockConfiguration:
        BlockPublicAcls: true
        BlockPublicPolicy: true
        IgnorePublicAcls: true
        RestrictPublicBuckets: true

Outputs:
  VpcId:
    Description: ID cua VPC vua tao
    Value: !Ref Vpc
    Export:
      Name: !Sub "${EnvName}-VpcId"      # ten export phai unique trong region
  InstancePrivateIp:
    Description: Private IP cua EC2 (lay bang GetAtt)
    Value: !GetAtt AppInstance.PrivateIp
  BucketArn:
    Description: ARN cua S3 bucket
    Value: !GetAtt AppBucket.Arn
    Export:
      Name: !Sub "${EnvName}-BucketArn"
```

Vài điểm cần nắm:
- `!Ref` trên `AWS::EC2::VPC` trả về **VPC ID**; trên một `Parameter` trả về **giá trị tham số**. Mỗi resource type có "return value của Ref" khác nhau — phải tra tài liệu, đây là chỗ đề hay bẫy.
- `!GetAtt AppInstance.PrivateIp` lấy thuộc tính không trả qua `Ref` (vì `Ref AppInstance` chỉ trả Instance ID).
- `!Sub` cho phép nội suy `${EnvName}`, `${AWS::AccountId}`, `${AWS::Region}` ngay trong chuỗi — gọn hơn `Fn::Join` rất nhiều.
- `AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>` là kiểu tham số SSM: lúc deploy, CloudFormation đọc Parameter Store và validate giá trị là một AMI ID hợp lệ.

### Bước 2: Validate template trước khi deploy

```bash
aws cloudformation validate-template \
  --template-body file://~/cfn-lab/network.yaml \
  --region ap-southeast-1
```

Output mong đợi liệt kê `Parameters` (EnvName, InstanceType, LatestAmiId) và `Description`. Lưu ý: `validate-template` chỉ kiểm cú pháp template và intrinsic functions — **không** kiểm logic resource (ví dụ CIDR trùng, bucket name đã tồn tại). Những lỗi đó chỉ lộ ra lúc deploy.

### Bước 3: Tạo stack

```bash
aws cloudformation create-stack \
  --stack-name ch19-lab \
  --template-body file://~/cfn-lab/network.yaml \
  --parameters ParameterKey=EnvName,ParameterValue=dev \
               ParameterKey=InstanceType,ParameterValue=t3.micro \
  --region ap-southeast-1
```

Output trả về `StackId` (ARN của stack). Chờ stack hoàn tất bằng waiter:

```bash
aws cloudformation wait stack-create-complete \
  --stack-name ch19-lab --region ap-southeast-1
echo "Exit code: $?"   # 0 = CREATE_COMPLETE
```

Trong lúc chờ, theo dõi tiến trình tạo từng resource:

```bash
aws cloudformation describe-stack-events \
  --stack-name ch19-lab --region ap-southeast-1 \
  --query "StackEvents[*].[Timestamp,LogicalResourceId,ResourceStatus]" \
  --output table
```

Bạn sẽ thấy thứ tự: `Vpc` (CREATE_IN_PROGRESS → CREATE_COMPLETE) trước, rồi `Subnet`, `InstanceSg` (phụ thuộc Vpc qua `!Ref Vpc`), cuối cùng `AppInstance` (phụ thuộc Subnet + Sg). CloudFormation **tự suy ra thứ tự** từ các tham chiếu `Ref`/`GetAtt` — không cần `DependsOn` thủ công ở đây.

### Bước 4: Đọc Outputs và Exports

```bash
aws cloudformation describe-stacks \
  --stack-name ch19-lab --region ap-southeast-1 \
  --query "Stacks[0].Outputs" --output table

aws cloudformation list-exports --region ap-southeast-1 \
  --query "Exports[?starts_with(Name, 'dev-')]" --output table
```

Bạn thấy `dev-VpcId` và `dev-BucketArn` trong danh sách exports — đây là dữ liệu mà stack khác có thể `Fn::ImportValue`.

### Bước 5: Cross-stack reference — consumer stack dùng ImportValue

Tạo `~/cfn-lab/consumer.yaml` để tạo thêm một subnet trong **chính VPC** mà stack trước đã export:

```yaml
AWSTemplateFormatVersion: "2010-09-09"
Description: Consumer stack - import VpcId tu ch19-lab.
Resources:
  ExtraSubnet:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !ImportValue dev-VpcId        # lay tu export cua stack kia
      CidrBlock: "10.10.2.0/24"
      Tags:
        - Key: Name
          Value: extra-subnet
```

```bash
aws cloudformation create-stack \
  --stack-name ch19-lab-consumer \
  --template-body file://~/cfn-lab/consumer.yaml \
  --region ap-southeast-1
aws cloudformation wait stack-create-complete \
  --stack-name ch19-lab-consumer --region ap-southeast-1
```

Điểm quan trọng cho đề thi: **một khi `dev-VpcId` đang được import bởi `ch19-lab-consumer`, bạn KHÔNG thể xoá stack `ch19-lab` cũng như không thể sửa/xoá giá trị export đó** — CloudFormation sẽ chặn với lỗi kiểu `Export dev-VpcId cannot be deleted as it is in use by ...`. Phải xoá consumer trước. Đây là lý do nhiều người gặp `DELETE_FAILED`.

### Bước 6: Update stack — quan sát update behavior

Sửa `network.yaml`: đổi `InstanceType` default không quan trọng, thay vào đó thêm một tag mới vào `AppInstance`:

```yaml
      Tags:
        - Key: Name
          Value: !Sub "${EnvName}-app"
        - Key: Owner
          Value: platform-team
```

Update:

```bash
aws cloudformation update-stack \
  --stack-name ch19-lab \
  --template-body file://~/cfn-lab/network.yaml \
  --parameters ParameterKey=EnvName,UsePreviousValue=true \
               ParameterKey=InstanceType,UsePreviousValue=true \
  --region ap-southeast-1
aws cloudformation wait stack-update-complete \
  --stack-name ch19-lab --region ap-southeast-1
```

Thêm tag là **update without interruption** (instance không restart). Ngược lại, nếu bạn đổi `InstanceType` từ `t3.micro` sang `t3.small`, đó là **update with some interruption** (EC2 stop/start). Còn nếu đổi `AppBucket` `BucketName` thì đó là **replacement** — CloudFormation tạo bucket mới rồi xoá bucket cũ (vì BucketName là thuộc tính không-update-được tại chỗ). Phân biệt 3 mức No interruption / Some interruption / Replacement là điểm thi kinh điển.

> Nếu update không có gì thay đổi, CLI trả lỗi `No updates are to be performed.` — đó là hành vi bình thường, không phải bug.

### Bước 7: Cố tình gây lỗi để thấy automatic rollback

Update với một CIDR không hợp lệ để resource fail. Thêm tạm một resource sai vào template (ví dụ một Subnet CIDR nằm ngoài VPC):

```yaml
  BadSubnet:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref Vpc
      CidrBlock: "192.168.0.0/24"   # khong nam trong 10.10.0.0/16 -> loi
```

```bash
aws cloudformation update-stack \
  --stack-name ch19-lab \
  --template-body file://~/cfn-lab/network.yaml \
  --parameters ParameterKey=EnvName,UsePreviousValue=true \
               ParameterKey=InstanceType,UsePreviousValue=true \
  --region ap-southeast-1
aws cloudformation wait stack-update-complete \
  --stack-name ch19-lab --region ap-southeast-1
echo "Exit code: $?"   # khac 0 vi update that bai
```

Xem events: bạn sẽ thấy `BadSubnet CREATE_FAILED` (CIDR ngoài range), sau đó stack chuyển `UPDATE_ROLLBACK_IN_PROGRESS` → `UPDATE_ROLLBACK_COMPLETE`. CloudFormation **tự rollback toàn bộ thay đổi của lần update này** về trạng thái trước đó. Với `create-stack` thất bại, mặc định stack vào `ROLLBACK_COMPLETE` và phải **xoá** rồi tạo lại (không update được từ trạng thái này) — trừ khi bạn dùng `--on-failure DO_NOTHING` hoặc `--disable-rollback` để giữ lại resource mà debug.

Nhớ xoá `BadSubnet` khỏi template trước khi sang bước dọn dẹp (hoặc bỏ qua vì ta sẽ delete stack).

### Dọn dẹp tài nguyên

Thứ tự bắt buộc: xoá consumer trước (vì nó import export), rồi xoá stack chính.

```bash
# 1. Xoa consumer truoc
aws cloudformation delete-stack \
  --stack-name ch19-lab-consumer --region ap-southeast-1
aws cloudformation wait stack-delete-complete \
  --stack-name ch19-lab-consumer --region ap-southeast-1

# 2. S3 bucket co object se chan delete-stack. Lab nay bucket rong nen OK,
#    nhung neu da upload file thi phai empty truoc:
# aws s3 rm s3://dev-app-<ACCOUNT_ID>-ap-southeast-1 --recursive

# 3. Xoa stack chinh
aws cloudformation delete-stack \
  --stack-name ch19-lab --region ap-southeast-1
aws cloudformation wait stack-delete-complete \
  --stack-name ch19-lab --region ap-southeast-1
echo "Da xoa xong, exit code: $?"
```

Bẫy dọn dẹp thường gặp: **S3 bucket không rỗng** sẽ làm `delete-stack` báo `DELETE_FAILED` (mặc định `DeletionPolicy` của bucket là `Delete` nhưng CloudFormation không tự xoá object bên trong). Phải `aws s3 rm --recursive` trước. Nếu stack kẹt `DELETE_FAILED`, bạn có thể `delete-stack --retain-resources <LogicalId>` để bỏ qua resource gây kẹt.

## 💡 Exam Tips chương 19

- **`Ref` vs `Fn::GetAtt`:** `Ref` trên một parameter trả giá trị tham số; `Ref` trên một resource trả "default identifier" (thường là physical ID, ví dụ Instance ID, VPC ID). `Fn::GetAtt` lấy các thuộc tính khác (PrivateIp, Arn, DNSName...). Khi đề hỏi "lấy ARN/DNS/endpoint của resource" → gần như luôn là `Fn::GetAtt`.
- **`Fn::Sub` thay cho `Fn::Join`:** Khi cần nội suy biến vào chuỗi, `!Sub "arn:aws:s3:::${Bucket}/*"` gọn và dễ đọc hơn `Fn::Join`. Đề hay đưa cả hai và hỏi cách nào đúng/ngắn gọn nhất.
- **SSM Parameter type cho AMI:** `AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>` với `/aws/service/ami-amazon-linux-latest/...` để luôn lấy AMI mới nhất mà không hardcode. Đây là cách "đúng chuẩn" thay cho `Mappings` AMI tĩnh (vốn lỗi thời và phải maintain theo region).
- **Cross-stack reference cần `Export` + `Fn::ImportValue`:** Export name unique trong region. Không thể xoá/sửa export đang được stack khác import — phải xoá stack consumer trước. Nested stack (Chương 20) là lựa chọn thay thế khi muốn ràng buộc vòng đời chặt hơn.
- **Update behavior 3 mức:** No interruption (đổi tag, thêm output), Some interruption (đổi InstanceType → EC2 reboot), Replacement (đổi thuộc tính bất biến như BucketName, KeyName → tạo mới + xoá cũ, mất dữ liệu nếu không cẩn thận). Câu hỏi "what happens when..." rất hay xuất hiện.
- **Rollback mặc định bật:** create thất bại → `ROLLBACK_COMPLETE` (phải delete rồi tạo lại); update thất bại → tự rollback về state cũ. Muốn debug thì dùng `--disable-rollback` hoặc `--on-failure DO_NOTHING` (chỉ với create-stack).
- **CloudFormation gọi API bằng quyền của caller** trừ khi bạn gắn **service role** (`--role-arn`). Tạo IAM resource trong template cần `--capabilities CAPABILITY_IAM` (hoặc `CAPABILITY_NAMED_IAM` nếu đặt tên cố định) — chi tiết ở Chương 20.
- **`Parameters` không lưu được giá trị mặc định nhạy cảm dạng plaintext an toàn:** dùng `NoEcho: true` để che giá trị trong console/events, và dùng SSM SecureString hoặc dynamic reference `{{resolve:ssm-secure:...}}` cho secret (chi tiết Secrets ở Chương 47).
- **`validate-template` chỉ kiểm cú pháp**, không kiểm logic (CIDR trùng, tên trùng, thiếu quyền). Lỗi logic chỉ lộ lúc deploy — đừng tin "validate pass = deploy chắc chắn thành công".
- **`UsePreviousValue=true`** khi update để giữ giá trị parameter cũ mà không phải gõ lại. Quên truyền parameter (không có default, không UsePreviousValue) → update fail.
- **YAML short form (`!Ref`, `!Sub`) chỉ dùng được trong YAML, không dùng trong JSON.** JSON phải viết `{ "Ref": "X" }`, `{ "Fn::GetAtt": ["R", "Attr"] }`. Không lồng hai short form trực tiếp (`!GetAtt !Ref ...` sai cú pháp).
- **Stack có thể tham chiếu tài nguyên qua `Ref`/`GetAtt` nhưng tham chiếu vòng (circular dependency) sẽ làm deploy fail** — CloudFormation báo `Circular dependency between resources`. Gỡ bằng cách bỏ bớt một chiều phụ thuộc.

## Quiz chương 19 (10 câu)

**Câu 1.** A developer needs to output the public DNS name of an EC2 instance created in a template so other tools can read it. Which intrinsic function should be used in the `Outputs` section?
- A. `!Ref MyInstance`
- B. `!GetAtt MyInstance.PublicDnsName`
- C. `!Sub "${MyInstance}"`
- D. `!FindInMap [DNS, MyInstance, Value]`

**Câu 2.** Một template tạo S3 bucket với `DeletionPolicy` mặc định. Stack bị xoá nhưng `delete-stack` báo `DELETE_FAILED` ở bucket. Nguyên nhân khả dĩ nhất?
- A. Bucket name không hợp lệ
- B. Bucket còn chứa object
- C. `DeletionPolicy: Retain` được đặt
- D. Thiếu `CAPABILITY_IAM`

**Câu 3.** Bạn muốn template luôn dùng AMI Amazon Linux 2023 mới nhất mà không cần sửa template theo từng region. Cách tốt nhất?
- A. Hardcode AMI ID vào `Mappings` theo region
- B. Dùng parameter type `AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>` trỏ tới public SSM parameter
- C. Dùng `Fn::ImportValue` từ một stack khác
- D. Để trống ImageId, CloudFormation tự chọn

**Câu 4.** Stack A export `Prod-VpcId`. Stack B đang `Fn::ImportValue Prod-VpcId`. Developer cố `delete-stack` Stack A. Điều gì xảy ra?
- A. Stack A xoá thành công, Stack B mất tham chiếu
- B. Cả hai stack bị xoá cùng lúc
- C. `delete-stack` Stack A thất bại vì export đang được import
- D. CloudFormation tự xoá Stack B trước rồi xoá Stack A

**Câu 5.** A developer updates a running stack and changes an EC2 instance's `InstanceType` from `t3.micro` to `t3.large`. What is the update behavior?
- A. No interruption
- B. Some interruption (instance stop/start)
- C. Replacement (new instance created, old deleted)
- D. Update fails, InstanceType cannot be changed

**Câu 6.** `create-stack` thất bại ở một resource. Mặc định stack sẽ ở trạng thái nào và bạn phải làm gì để thử lại?
- A. `CREATE_FAILED`, gọi `update-stack` để sửa
- B. `ROLLBACK_COMPLETE`, phải `delete-stack` rồi tạo lại
- C. `UPDATE_ROLLBACK_COMPLETE`, gọi `continue-update-rollback`
- D. Stack tự xoá hoàn toàn, tạo lại từ đầu

**Câu 7.** Trong YAML template, cách viết nào đúng để tạo chuỗi ARN bucket gồm tên bucket từ một resource?
- A. `!Join ["", ["arn:aws:s3:::", !Ref MyBucket]]`
- B. `!Sub "arn:aws:s3:::${MyBucket}"`
- C. Cả A và B đều đúng
- D. `!GetAtt MyBucket.Arn` không bao giờ trả ARN

**Câu 8.** Developer muốn che giá trị một parameter password để không hiển thị plaintext trong CloudFormation console và stack events. Thuộc tính nào dùng?
- A. `NoEcho: true`
- B. `Encrypted: true`
- C. `Hidden: true`
- D. `SecureString: true`

**Câu 9.** Một template tạo IAM Role inline. Khi `create-stack` qua CLI, lệnh báo lỗi `Requires capabilities : [CAPABILITY_IAM]`. Cách sửa đúng?
- A. Thêm `--capabilities CAPABILITY_IAM` vào lệnh create-stack
- B. Gắn `DeletionPolicy: Retain` cho role
- C. Đổi sang JSON template
- D. Thêm `AWSTemplateFormatVersion` mới hơn

**Câu 10.** A developer wants `update-stack` to keep the existing value of a parameter that has no default, without re-typing it. Which approach is correct?
- A. Bỏ parameter đó khỏi lệnh update
- B. `ParameterKey=X,UsePreviousValue=true`
- C. `ParameterKey=X,ParameterValue=""`
- D. Xoá parameter khỏi template

### Đáp án & giải thích

**Câu 1 — Đáp án B.** `Fn::GetAtt MyInstance.PublicDnsName` lấy thuộc tính DNS công khai. A sai vì `Ref` trên EC2 instance chỉ trả về Instance ID, không phải DNS. C (`!Sub "${MyInstance}"`) cũng chỉ nội suy Instance ID. D vô nghĩa — `FindInMap` đọc từ `Mappings` tĩnh chứ không lấy thuộc tính runtime của resource.

**Câu 2 — Đáp án B.** CloudFormation không tự xoá object trong bucket; bucket còn object thì `Delete` thất bại → `DELETE_FAILED`. Phải `aws s3 rm --recursive` trước. A sai vì bucket đã tạo được thì name hợp lệ. C có thể gây bucket bị "giữ lại" nhưng `Retain` làm stack xoá **thành công** (bucket được bỏ lại), không phải `DELETE_FAILED`. D liên quan IAM capability lúc create, không liên quan delete.

**Câu 3 — Đáp án B.** Parameter type SSM `AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>` trỏ tới public parameter `/aws/service/ami-amazon-linux-latest/...` để CloudFormation tự resolve AMI mới nhất theo region lúc deploy. A là cách cũ, phải maintain bảng AMI theo region và dễ lỗi thời. C dùng cho cross-stack value khác, không phải AMI mới nhất. D sai — `ImageId` là bắt buộc, CloudFormation không tự chọn.

**Câu 4 — Đáp án C.** Export đang được import thì không thể xoá stack chứa export (cũng không sửa/xoá export). `delete-stack` Stack A sẽ fail cho tới khi xoá Stack B trước. A, B, D đều sai vì CloudFormation không phá vỡ ràng buộc import và không tự động xoá stack phụ thuộc.

**Câu 5 — Đáp án B.** Đổi `InstanceType` là **update with some interruption**: instance bị stop/start (giữ nguyên Instance ID, EBS root). A sai (có gián đoạn). C sai — không tạo instance mới, không đổi Instance ID. D sai — InstanceType hoàn toàn update được. (So sánh: đổi `AvailabilityZone` hay `KeyName` mới là Replacement.)

**Câu 6 — Đáp án B.** Mặc định rollback bật, create fail → `ROLLBACK_COMPLETE`. Từ trạng thái này **không update được**, phải `delete-stack` rồi `create-stack` lại. A sai vì không thể update một stack ở `ROLLBACK_COMPLETE`. C là trạng thái của update fail, không phải create fail. D sai — stack không tự biến mất, nó nằm lại ở `ROLLBACK_COMPLETE` chờ bạn xoá.

**Câu 7 — Đáp án C.** Cả `Fn::Join` và `Fn::Sub` đều tạo được chuỗi ARN đúng; `!Sub` ngắn gọn và dễ đọc hơn. D sai vì với S3 bucket `!GetAtt MyBucket.Arn` thực ra **có** trả ARN — nhưng câu hỏi yêu cầu ghép chuỗi nên A/B vẫn là cách hợp lệ minh hoạ intrinsic functions.

**Câu 8 — Đáp án A.** `NoEcho: true` trên parameter làm CloudFormation che giá trị (hiển thị `****`) trong console, CLI describe và stack events. B/C/D không phải thuộc tính hợp lệ của parameter. Lưu ý: NoEcho chỉ che hiển thị, không mã hoá — secret thật nên để ở SSM SecureString/Secrets Manager và dùng dynamic reference (Chương 47).

**Câu 9 — Đáp án A.** Tạo IAM resource yêu cầu acknowledge bằng `--capabilities CAPABILITY_IAM` (hoặc `CAPABILITY_NAMED_IAM` nếu đặt tên role cố định). Đây là cơ chế bảo vệ để bạn xác nhận template tạo quyền. B/C/D không liên quan tới lỗi capability. (Chi tiết capabilities ở Chương 20.)

**Câu 10 — Đáp án B.** `UsePreviousValue=true` giữ nguyên giá trị parameter hiện tại mà không cần nhập lại. A sai — bỏ hẳn parameter (không default, không UsePreviousValue) làm update fail vì thiếu giá trị. C đặt chuỗi rỗng, có thể vi phạm constraint hoặc đổi giá trị ngoài ý muốn. D xoá parameter khỏi template là thay đổi cấu trúc, không phải mục tiêu giữ giá trị cũ.

## Tóm tắt chương

- CloudFormation là **Infrastructure as Code** của AWS: mô tả hạ tầng bằng template (YAML/JSON), CloudFormation lo việc tạo/cập nhật/xoá theo đúng thứ tự phụ thuộc và miễn phí (chỉ trả tiền cho resource được tạo).
- Template có các section chính: `AWSTemplateFormatVersion`, `Description`, `Parameters`, `Mappings`, `Resources` (bắt buộc, duy nhất bắt buộc), `Outputs`, `Metadata`.
- `Parameters` hỗ trợ constraint (`AllowedValues`, `AllowedPattern`, `Min/MaxLength`), `NoEcho` để che secret, và **SSM parameter types** để resolve giá trị động (ví dụ AMI mới nhất) lúc deploy.
- Intrinsic functions cốt lõi: `Ref` (giá trị param hoặc physical ID), `Fn::GetAtt` (thuộc tính khác như Arn/DNS/IP), `Fn::Sub` (nội suy chuỗi), `Fn::Join`, `Fn::FindInMap` (đọc `Mappings`), `Fn::ImportValue` (đọc export của stack khác).
- Cross-stack reference cần `Outputs` có `Export` (name unique trong region) ở stack producer và `Fn::ImportValue` ở stack consumer; **export đang bị import thì không xoá/sửa được** — đây là nguyên nhân `DELETE_FAILED` phổ biến.
- CloudFormation tự suy ra thứ tự tạo từ tham chiếu `Ref`/`GetAtt`; chỉ cần `DependsOn` khi không có tham chiếu trực tiếp (chi tiết Chương 20).
- Update behavior chia 3 mức: **No interruption**, **Some interruption** (EC2 reboot), **Replacement** (tạo mới + xoá cũ, rủi ro mất dữ liệu) — phân biệt theo thuộc tính nào thay đổi.
- Rollback mặc định bật: create fail → `ROLLBACK_COMPLETE` (phải delete & tạo lại); update fail → tự rollback về state cũ; dùng `--disable-rollback`/`--on-failure DO_NOTHING` để debug.
- YAML short form (`!Ref`, `!Sub`, `!GetAtt`) chỉ dùng trong YAML; JSON phải dùng full form (`{ "Ref": ... }`); không lồng trực tiếp hai short form.
- `validate-template` chỉ kiểm cú pháp, không kiểm logic — lỗi CIDR/tên trùng/thiếu quyền chỉ lộ lúc deploy.
- CloudFormation gọi API bằng quyền của caller trừ khi gắn service role; tạo IAM resource cần `CAPABILITY_IAM`/`CAPABILITY_NAMED_IAM` (sâu hơn ở Chương 20).
- Luôn dọn dẹp đúng thứ tự: empty S3 bucket → xoá consumer stack import export → xoá stack producer, để tránh `DELETE_FAILED` và tốn phí.
