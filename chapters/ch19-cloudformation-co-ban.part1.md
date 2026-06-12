# Chương 19: AWS CloudFormation cơ bản

> **Trọng tâm DVA-C02:** CloudFormation thuộc domain Deployment (24%) và xuất hiện dày trong các câu hỏi về Infrastructure as Code. Đề hay hỏi: chọn intrinsic function đúng cho một tình huống (`Ref` vs `Fn::GetAtt` vs `Fn::Sub`), cách chia sẻ giá trị giữa stack qua `Export`/`Fn::ImportValue`, hành vi rollback khi create/update thất bại, kiểu Parameter (đặc biệt SSM parameter types), và phân biệt resource bị replace vs update tại chỗ. Bạn cần đọc hiểu một template YAML và dự đoán điều gì xảy ra.

## Mục tiêu chương
- Hiểu Infrastructure as Code (IaC) là gì và CloudFormation giải quyết vấn đề nào so với tạo tài nguyên thủ công.
- Nắm trọn vẹn cấu trúc một template: `AWSTemplateFormatVersion`, `Description`, `Metadata`, `Parameters`, `Resources`, `Outputs`.
- Dùng thành thạo các intrinsic function cốt lõi: `Ref`, `Fn::GetAtt`, `Fn::Sub`, `Fn::Join`, `Fn::FindInMap`, `Fn::ImportValue`.
- Chia sẻ giá trị giữa các stack bằng cross-stack reference (`Export` / `Fn::ImportValue`).
- Thực hiện vòng đời stack: create, update, delete và hiểu cơ chế rollback.
- Đọc và viết template bằng YAML đúng chuẩn, tránh các bẫy thụt lề và kiểu dữ liệu.

## 19.1 Infrastructure as Code và mô hình hoạt động của CloudFormation

**Infrastructure as Code (IaC)** nghĩa là mô tả hạ tầng (server, database, queue, IAM role...) bằng file văn bản có thể version-control, review qua Git, và tái tạo y hệt ở nhiều môi trường. Thay vì click chuột trong Console — vốn không lặp lại được, không có lịch sử, dễ "drift" giữa dev và prod — bạn khai báo trạng thái mong muốn (declarative) rồi để CloudFormation lo cách đạt được trạng thái đó.

CloudFormation là dịch vụ IaC native của AWS, **miễn phí** (bạn chỉ trả tiền cho tài nguyên nó tạo ra). Hai khái niệm trung tâm:

- **Template**: file JSON hoặc YAML mô tả các tài nguyên. Đây là "bản thiết kế".
- **Stack**: một instance đã được triển khai từ template. Stack quản lý toàn bộ tài nguyên như một đơn vị — tạo cùng nhau, xoá cùng nhau, cập nhật cùng nhau.

Cơ chế bên dưới khi bạn `create-stack`:
1. CloudFormation parse template, kiểm tra cú pháp và resolve các intrinsic function.
2. Nó dựng **dependency graph**: phân tích `Ref`, `Fn::GetAtt`, `DependsOn` để biết tài nguyên nào phụ thuộc tài nguyên nào. Những gì độc lập sẽ được tạo **song song**; những gì phụ thuộc sẽ tạo theo thứ tự topo.
3. Mỗi resource được tạo qua đúng API của service tương ứng (ví dụ `RunInstances` cho EC2, `CreateBucket` cho S3). CloudFormation là một orchestrator gọi các API này thay bạn.
4. Trạng thái mỗi resource được ghi lại; stack chuyển sang `CREATE_COMPLETE` khi mọi resource xong.

> 💡 **Exam Tip:** CloudFormation **declarative** (mô tả "cái gì"), khác với script imperative (mô tả "làm thế nào"). Bạn không cần viết logic "nếu chưa có thì tạo, có rồi thì bỏ qua" — CloudFormation tự so sánh trạng thái hiện tại với template để quyết định create/update/delete.

Một stack có giới hạn cần nhớ: tối đa **500 resource** mỗi stack (giới hạn này từng là 200, đã được nâng), template size tối đa **1 MB** khi upload qua S3 (51.200 byte nếu truyền trực tiếp), tối đa **200 parameter**, **200 mapping**, **200 output** mỗi template. Khi chạm trần resource, bạn tách thành nested stack hoặc cross-stack reference (nested stack chi tiết ở Chương 20).

## 19.2 Cấu trúc (anatomy) của một template

Một template gồm nhiều section ở cấp cao nhất. Chỉ **`Resources` là bắt buộc**; mọi section khác đều tuỳ chọn nhưng thứ tự logic thường như sau:

```yaml
AWSTemplateFormatVersion: "2010-09-09"   # tuỳ chọn nhưng nên có
Description: "VPC + EC2 web server cho môi trường dev"  # chuỗi <= 1024 ký tự
Metadata: {}        # dữ liệu bổ sung cho template
Parameters: {}      # input người dùng truyền vào khi deploy
Mappings: {}        # bảng tra cứu key-value (chi tiết ở Chương 20)
Conditions: {}      # logic điều kiện (chi tiết ở Chương 20)
Resources: {}       # BẮT BUỘC — các tài nguyên AWS
Outputs: {}         # giá trị xuất ra sau khi deploy
```

- **`AWSTemplateFormatVersion`**: hiện chỉ có một giá trị hợp lệ duy nhất là `"2010-09-09"`. Đây KHÔNG phải phiên bản API; nếu bỏ qua, CloudFormation mặc định dùng version mới nhất. Đừng nhầm với ngày tháng tuỳ ý.
- **`Description`**: chuỗi mô tả, hiển thị trong Console. Nếu có, phải đặt **ngay sau** `AWSTemplateFormatVersion`.
- **`Metadata`**: chứa thông tin bổ sung. Hai key đặc biệt: `AWS::CloudFormation::Interface` (gom nhóm và đặt nhãn parameter trong Console) và `AWS::CloudFormation::Init` (dùng với cfn-init — chi tiết ở Chương 20).
- **`Resources`**: trái tim của template. Mỗi resource có **logical ID** (tên bạn tự đặt, duy nhất trong template), một `Type`, và `Properties`.
- **`Outputs`**: khai báo giá trị muốn lấy ra sau khi deploy (ví dụ URL endpoint, ID của bucket) và/hoặc export để stack khác dùng.

Cấu trúc một resource:

```yaml
Resources:
  MyBucket:                          # Logical ID — chỉ A-Za-z0-9, duy nhất
    Type: "AWS::S3::Bucket"          # định danh service::resource
    Properties:
      BucketName: "my-app-logs-2026"
      VersioningConfiguration:
        Status: Enabled
```

Cần phân biệt 3 loại ID:
- **Logical ID**: tên trong template (`MyBucket`). Dùng để tham chiếu nội bộ qua `Ref`/`Fn::GetAtt`.
- **Physical ID**: tên thật AWS gán sau khi tạo (ví dụ `my-app-logs-2026` hoặc một tên do AWS sinh ra như `mystack-mybucket-1ab2c3d4`). Nếu không khai báo `BucketName`, CloudFormation tự sinh physical name dựa trên stack name + logical ID + chuỗi ngẫu nhiên.
- **Resource type**: theo định dạng `AWS::Service::Resource`.

> 💡 **Exam Tip:** Nếu bạn đặt cứng một thuộc tính name (như `BucketName`, `TableName`) thì resource đó **không replace được mà không xoá tên cũ** — và nhiều khi update đòi replacement sẽ thất bại vì trùng tên. Để CloudFormation tự sinh name khi không cần tên cố định, giúp update mượt hơn.

## 19.3 Parameters — tham số đầu vào

`Parameters` cho phép truyền giá trị vào lúc deploy, biến template thành reusable cho nhiều môi trường. Mỗi parameter có `Type` và các thuộc tính ràng buộc:

```yaml
Parameters:
  EnvName:
    Type: String
    Default: dev
    AllowedValues: [dev, staging, prod]
    Description: "Tên môi trường"
  InstanceType:
    Type: String
    Default: t3.micro
    AllowedValues: [t3.micro, t3.small, t3.medium]
  DesiredCapacity:
    Type: Number
    MinValue: 1
    MaxValue: 10
    Default: 2
  DbPassword:
    Type: String
    NoEcho: true          # không hiển thị giá trị trong Console/log
    MinLength: 8
    MaxLength: 41
    AllowedPattern: "[a-zA-Z0-9]+"
  SubnetIds:
    Type: List<AWS::EC2::Subnet::Id>   # AWS-specific type: validate có thật
```

Các kiểu parameter cốt lõi cho đề thi:

| Type | Mô tả | Lợi ích |
|------|-------|---------|
| `String` / `Number` / `CommaDelimitedList` | kiểu cơ bản | đơn giản |
| `AWS::EC2::KeyPair::KeyName` | tên key pair | Console hiện dropdown, validate tồn tại |
| `AWS::EC2::VPC::Id`, `AWS::EC2::Subnet::Id`, `AWS::EC2::SecurityGroup::Id` | ID tài nguyên hiện có | chống nhập sai ID |
| `List<AWS::EC2::Subnet::Id>` | danh sách ID | chọn nhiều subnet |
| `AWS::SSM::Parameter::Value<String>` | đọc giá trị từ SSM Parameter Store **tại thời điểm deploy** | tách config khỏi template |
| `AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>` | lấy AMI ID mới nhất từ SSM public parameter | không hard-code AMI |

**SSM parameter types** là điểm hay bị hỏi: bạn truyền *tên* của một SSM parameter, CloudFormation **resolve giá trị thật của nó lúc deploy**. Ví dụ kinh điển lấy AMI Amazon Linux 2023 mới nhất mà không cần biết AMI ID:

```yaml
Parameters:
  LatestAmiId:
    Type: "AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>"
    Default: "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
Resources:
  Web:
    Type: AWS::EC2::Instance
    Properties:
      ImageId: !Ref LatestAmiId      # resolve thành AMI ID đúng region
      InstanceType: t3.micro
```

> 💡 **Exam Tip:** Phân biệt `AWS::SSM::Parameter::Value<...>` (resolve **lúc deploy**, dùng trong `Parameters`) với **dynamic reference** `{{resolve:ssm:/path:version}}` (resolve trong `Resources`, chi tiết Secrets/SSM ở Chương 47). Dynamic reference `{{resolve:secretsmanager:...}}` dùng để lấy password DB mà không lộ ra template — KHÔNG dùng SSM Parameter type cho secret vì `NoEcho` chỉ áp cho parameter thường.

Tham chiếu parameter bằng `!Ref TênParameter`. CLI truyền parameter:

```bash
aws cloudformation create-stack \
  --stack-name web-dev \
  --template-body file://web.yaml \
  --parameters ParameterKey=EnvName,ParameterValue=dev \
               ParameterKey=InstanceType,ParameterValue=t3.small
```

Khi update mà muốn giữ giá trị parameter cũ, dùng `UsePreviousValue=true` thay cho `ParameterValue`.

## 19.4 Pseudo parameters và intrinsic functions cốt lõi

**Pseudo parameters** là biến do CloudFormation cung cấp sẵn, tham chiếu bằng `Ref`, không cần khai báo:

| Pseudo parameter | Giá trị |
|------------------|---------|
| `AWS::Region` | region đang deploy, ví dụ `ap-southeast-1` |
| `AWS::AccountId` | account ID 12 số |
| `AWS::StackName` | tên stack |
| `AWS::StackId` | ARN đầy đủ của stack |
| `AWS::Partition` | `aws`, `aws-cn`, hoặc `aws-us-gov` |
| `AWS::NoValue` | khi return giá trị này, thuộc tính bị **loại bỏ** (dùng với `Fn::If`) |
| `AWS::URLSuffix` | `amazonaws.com` (hoặc `.com.cn` ở China) |

**Intrinsic functions** là các hàm CloudFormation chạy lúc deploy. YAML có hai cú pháp: dạng đầy đủ `Fn::Tên` và shorthand `!Tên`. Lưu ý không lồng hai shorthand trực tiếp (`!Sub !Ref X` sai) — phải dùng dạng đầy đủ khi lồng.

### `Ref`
Trả về "giá trị mặc định" của một parameter hoặc resource. Với parameter, trả về giá trị đã truyền. Với resource, **tuỳ resource** — thường là physical ID:

```yaml
!Ref EnvName            # -> giá trị parameter, ví dụ "dev"
!Ref MyBucket           # -> tên bucket (physical ID)
!Ref MyVPC              # -> VPC ID, ví dụ "vpc-0a1b2c3d"
```

### `Fn::GetAtt`
Lấy **một attribute cụ thể** của resource (không phải physical ID mặc định). Mỗi resource type có danh sách attribute riêng trong tài liệu (mục "Return values" → "Fn::GetAtt"):

```yaml
!GetAtt MyBucket.Arn                    # ARN của bucket
!GetAtt MyBucket.DomainName             # bucket.s3.amazonaws.com
!GetAtt MyLoadBalancer.DNSName          # DNS của ALB
!GetAtt MyInstance.PublicIp             # IP public của EC2
# Dạng đầy đủ:
Fn::GetAtt: [ MyBucket, Arn ]
```

> 💡 **Exam Tip:** Câu hỏi kinh điển: "cần lấy ARN của bucket/table" → `Fn::GetAtt`, KHÔNG phải `Ref` (vì `Ref MyBucket` trả về tên, không phải ARN). Còn "cần lấy ID của VPC/Subnet/SecurityGroup" → thường `Ref` là đủ. Nhớ: `Ref` trả về một giá trị mặc định; `GetAtt` trả về attribute bạn chỉ định.

### `Fn::Sub`
Thay thế biến `${...}` trong chuỗi — sạch và dễ đọc hơn `Fn::Join`:

```yaml
# Tham chiếu parameter/resource/pseudo param bằng ${}
!Sub "arn:${AWS::Partition}:s3:::${EnvName}-app-logs"
# Lấy attribute với dấu chấm:
!Sub "https://${MyLoadBalancer.DNSName}/health"
# Map biến cục bộ (dạng list 2 phần tử):
!Sub
  - "Endpoint: ${Url} ở region ${Reg}"
  - Url: !GetAtt MyLoadBalancer.DNSName
    Reg: !Ref AWS::Region
# Escape literal ${} bằng ${!Literal}
!Sub "Giá trị literal: ${!NotResolved}"
```

### `Fn::Join`
Nối list chuỗi với một delimiter. Cú pháp `[delimiter, [list]]`:

```yaml
!Join [ "", [ "arn:aws:s3:::", !Ref MyBucket, "/*" ] ]
!Join [ ",", !Ref SubnetIds ]          # nối list thành CSV
```

`Fn::Sub` thường rõ ràng hơn `Fn::Join` cho việc dựng chuỗi có biến; `Join` hợp khi nối các phần tử của một list động.

### `Fn::FindInMap`
Tra giá trị từ section `Mappings` (chi tiết Mappings ở Chương 20). Cú pháp `[MapName, TopLevelKey, SecondLevelKey]`, thường để chọn AMI theo region:

```yaml
Mappings:
  RegionAMI:
    ap-southeast-1: { AMI: ami-0abc111 }
    us-east-1:      { AMI: ami-0def222 }
Resources:
  Web:
    Type: AWS::EC2::Instance
    Properties:
      ImageId: !FindInMap [ RegionAMI, !Ref "AWS::Region", AMI ]
```

### `Fn::ImportValue`
Nhập một giá trị mà stack khác đã `Export` (xem mục 19.5).

Ngoài ra còn `Fn::Select`, `Fn::Split`, `Fn::GetAZs`, `Fn::Cidr`, `Fn::Base64` (dùng cho UserData), `Fn::ToJsonString`, và `Fn::If`/`Fn::Equals` (Conditions — Chương 20). `Fn::Base64` hay đi cùng `Fn::Sub` cho EC2 UserData:

```yaml
UserData:
  Fn::Base64: !Sub |
    #!/bin/bash
    yum install -y httpd
    echo "Region: ${AWS::Region}" > /var/www/html/index.html
    systemctl enable --now httpd
```

## 19.5 Outputs và cross-stack reference (Export / ImportValue)

`Outputs` trả về giá trị sau khi deploy. Hai mục đích: (1) hiển thị/đọc nhanh (URL, ID), (2) **export** để stack khác import.

```yaml
Outputs:
  BucketArn:
    Description: "ARN của bucket logs"
    Value: !GetAtt MyBucket.Arn
  VpcId:
    Value: !Ref MyVPC
    Export:
      Name: !Sub "${AWS::StackName}-VpcId"   # tên export PHẢI duy nhất trong region
```

Stack khác import bằng `Fn::ImportValue` với đúng **tên export** (không phải logical ID):

```yaml
Resources:
  AppSubnet:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !ImportValue network-stack-VpcId
```

Quy tắc quan trọng của cross-stack reference (hay ra đề):
- Tên export **duy nhất trong mỗi region** của một account. Trùng tên export sẽ lỗi.
- **Không xoá hoặc sửa** một output đang được stack khác import. CloudFormation chặn update/delete stack export nếu còn stack đang ImportValue giá trị đó → phải xoá phía import trước.
- Không thể import cross-region và cross-account bằng `Fn::ImportValue` (chỉ cùng region, cùng account).
- `Fn::ImportValue` **không nhận** giá trị từ `Ref`/`GetAtt` của parameter cùng template làm tên export (tên export phải resolve được lúc build dependency).

> 💡 **Exam Tip:** Khi đề hỏi cách "chia sẻ VPC ID/Subnet từ một network stack sang nhiều app stack" → **Export trong Outputs + Fn::ImportValue**. Khi cần chia sẻ nhưng muốn lifecycle gắn chặt cha-con và truyền giá trị linh hoạt hơn → **nested stack** (so sánh chi tiết ở Chương 20). Điểm phân biệt: cross-stack reference tạo **ràng buộc cứng** ngăn xoá stack nguồn khi còn người dùng.

## 19.6 Vòng đời stack: create, update, delete

### Create
`create-stack` tạo mới. Stack chuyển qua `CREATE_IN_PROGRESS` → `CREATE_COMPLETE`. Theo dõi bằng `wait`:

```bash
aws cloudformation create-stack \
  --stack-name web-dev \
  --template-body file://web.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameters ParameterKey=EnvName,ParameterValue=dev

aws cloudformation wait stack-create-complete --stack-name web-dev
aws cloudformation describe-stacks --stack-name web-dev \
  --query "Stacks[0].Outputs"
```

`--capabilities` bắt buộc khi template tạo IAM resource (`CAPABILITY_IAM` hoặc `CAPABILITY_NAMED_IAM` nếu IAM resource có tên cố định). Đây là cơ chế "bạn xác nhận template có thể tạo quyền" — chi tiết capabilities ở Chương 20.

### Update
Có hai cách: `update-stack` (áp dụng ngay) hoặc **change set** (xem trước thay đổi rồi mới execute — chi tiết ChangeSets ở Chương 20). CloudFormation so sánh template mới với trạng thái hiện tại và xác định mỗi resource sẽ:

| Hành động update | Ý nghĩa |
|------------------|---------|
| **No interruption** | cập nhật tại chỗ, không gián đoạn (ví dụ đổi tag) |
| **Some interruption** | cập nhật, có gián đoạn ngắn (ví dụ đổi InstanceType → EC2 stop/start) |
| **Replacement** | tạo resource MỚI với physical ID mới rồi xoá cái cũ |

Việc một thuộc tính gây replacement hay không được ghi rõ trong tài liệu mỗi resource ("Update requires: Replacement / No interruption / Some interruptions"). Ví dụ đổi `BucketName` của S3 hay `AvailabilityZone` của EC2 → replacement.

> 💡 **Exam Tip:** **Replacement** là bẫy kinh điển. Đổi tên một DynamoDB table, hay `DBInstanceIdentifier` của RDS → CloudFormation tạo resource mới và **xoá cái cũ cùng dữ liệu**. Để chống mất dữ liệu khi resource bị replace/delete, dùng `DeletionPolicy: Retain` hoặc `Snapshot` (chi tiết DeletionPolicy ở Chương 20). Khi thấy "data was lost after a stack update", nghĩ ngay tới replacement.

```bash
aws cloudformation update-stack \
  --stack-name web-dev \
  --template-body file://web.yaml \
  --parameters ParameterKey=EnvName,UsePreviousValue=true \
               ParameterKey=InstanceType,ParameterValue=t3.medium
```

Nếu update không có thay đổi nào, CloudFormation trả lỗi `No updates are to be performed`.

### Delete
`delete-stack` xoá toàn bộ resource theo thứ tự **ngược** dependency graph. Resource có `DeletionPolicy: Retain` sẽ được giữ lại. Nếu một resource không xoá được (ví dụ S3 bucket còn object), stack vào `DELETE_FAILED` — bạn xử lý rồi xoá lại, hoặc dùng `--retain-resources` để bỏ qua resource lỗi.

```bash
aws cloudformation delete-stack --stack-name web-dev
aws cloudformation wait stack-delete-complete --stack-name web-dev
```

Gọi cùng vòng đời bằng SDK JS v3:

```javascript
import {
  CloudFormationClient, CreateStackCommand,
  DescribeStacksCommand, DeleteStackCommand,
} from "@aws-sdk/client-cloudformation";
import { readFileSync } from "node:fs";

const cfn = new CloudFormationClient({ region: "ap-southeast-1" });

// Tạo stack từ template trên đĩa
await cfn.send(new CreateStackCommand({
  StackName: "web-dev",
  TemplateBody: readFileSync("web.yaml", "utf8"),
  Parameters: [{ ParameterKey: "EnvName", ParameterValue: "dev" }],
  Capabilities: ["CAPABILITY_NAMED_IAM"],
}));

// Đọc outputs
const out = await cfn.send(new DescribeStacksCommand({ StackName: "web-dev" }));
console.log(out.Stacks[0].Outputs);
```

## 19.7 Rollback — cơ chế và các bẫy thường gặp

CloudFormation mặc định **transactional**: nếu create/update thất bại, nó tự rollback về trạng thái trước đó. Đây là điểm rất hay ra đề.

**Khi CREATE thất bại** (một resource lỗi): stack → `CREATE_FAILED` → `ROLLBACK_IN_PROGRESS` → `ROLLBACK_COMPLETE`. Ở trạng thái `ROLLBACK_COMPLETE`, stack **không update được nữa** — bạn chỉ có thể **xoá** rồi tạo lại. Mọi resource đã tạo trong lần create hỏng đó bị xoá (trừ resource có `DeletionPolicy: Retain`).

- Muốn giữ resource đã tạo để debug nguyên nhân lỗi, dùng `--disable-rollback` (hoặc `--on-failure DO_NOTHING`). Khi đó stack ở `CREATE_FAILED` và bạn xem được resource nào dựng tới đâu.
- `--on-failure` có 3 giá trị: `ROLLBACK` (mặc định), `DELETE` (xoá luôn), `DO_NOTHING` (giữ nguyên để debug).

```bash
aws cloudformation create-stack \
  --stack-name web-dev \
  --template-body file://web.yaml \
  --on-failure DO_NOTHING          # giữ resource để điều tra khi lỗi
```

**Khi UPDATE thất bại**: stack → `UPDATE_ROLLBACK_IN_PROGRESS` → `UPDATE_ROLLBACK_COMPLETE`, các resource đã đổi được khôi phục về cấu hình cũ. Nhưng nếu chính việc rollback cũng lỗi (ví dụ resource cũ không khôi phục được), stack vào `UPDATE_ROLLBACK_FAILED`. Lúc này dùng `continue-update-rollback` (có thể `--resources-to-skip` để bỏ qua resource kẹt):

```bash
aws cloudformation continue-update-rollback \
  --stack-name web-dev \
  --resources-to-skip MyStuckResource
```

> 💡 **Exam Tip:** Nhớ kỹ: `ROLLBACK_COMPLETE` (sau create lỗi) → chỉ **delete** được, không update. `UPDATE_ROLLBACK_COMPLETE` (sau update lỗi) → stack vẫn dùng tiếp được. Đây là cặp dễ gây nhầm. Nguyên nhân update rollback hay gặp: thiếu quyền IAM, vượt service quota, security group rule trùng, hoặc CreationPolicy/cfn-signal không nhận signal kịp (Chương 20).

CloudFormation còn có **rollback triggers / monitoring**: khi update, bạn gắn CloudWatch alarm; nếu alarm kích trong "monitoring period", CloudFormation tự rollback dù resource đã `UPDATE_COMPLETE`. Hữu ích để bắt lỗi runtime sau khi đổi hạ tầng.

## 19.8 YAML cho CloudFormation — cú pháp và bẫy định dạng

CloudFormation chấp nhận cả JSON và YAML. **YAML được ưa dùng** vì hỗ trợ comment (`#`), gọn hơn, và có shorthand intrinsic function. Những điểm cần nắm để tránh lỗi parse:

- **Thụt lề bằng space, KHÔNG dùng tab.** Tab gây lỗi parse khó hiểu.
- Chuỗi chứa ký tự đặc biệt (`: { } [ ] , & * # ? | - < > = ! % @`) nên đặt trong nháy. `"2010-09-09"` nên để nháy để không bị hiểu thành phép tính ngày.
- Block scalar `|` giữ nguyên xuống dòng (dùng cho UserData/script); `>` gộp dòng thành một.
- **Shorthand không lồng trực tiếp được**: `!Sub !Ref X` sai cú pháp YAML. Phải dùng dạng đầy đủ ở hàm ngoài: `Fn::Sub: ...` rồi bên trong `${X}`, hoặc viết `!Join [ "", [ !Ref A, !Ref B ] ]` (mỗi phần tử là một shorthand riêng — hợp lệ).

So sánh JSON vs YAML cùng một resource:

```json
{ "MyBucket": { "Type": "AWS::S3::Bucket",
    "Properties": { "BucketName": { "Fn::Sub": "${EnvName}-logs" } } } }
```

```yaml
MyBucket:
  Type: AWS::S3::Bucket
  Properties:
    BucketName: !Sub "${EnvName}-logs"
```

Validate template trước khi deploy để bắt lỗi cú pháp sớm:

```bash
# Kiểm tra cú pháp cơ bản (parse + intrinsic function hợp lệ)
aws cloudformation validate-template --template-body file://web.yaml

# Linter mạnh hơn của AWS (kiểm tra property, resource type, best practice)
cfn-lint web.yaml
```

`validate-template` chỉ kiểm cú pháp và intrinsic function — **không** kiểm tra property có hợp lệ với từng resource type hay không. Muốn kiểm sâu (sai tên property, thiếu required), dùng `cfn-lint`. Đề thi có thể hỏi công cụ nào bắt lỗi "InstanceTpe" viết sai chính tả → đó là `cfn-lint`, không phải `validate-template`.

> 💡 **Exam Tip:** Template lưu trực tiếp qua `--template-body` giới hạn ~51 KB; template lớn hơn phải upload lên S3 rồi dùng `--template-url`. Giới hạn tổng template (sau khi đọc từ S3) là **1 MB**. Khi đề nói "template quá lớn để truyền qua CLI", câu trả lời là đẩy lên S3.
