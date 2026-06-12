# Chương 41: AWS CodeDeploy

> **Trọng tâm DVA-C02:** CodeDeploy nằm trọn trong domain Deployment (24% đề thi). Câu hỏi điển hình ở dạng tình huống: chọn `appspec.yml` đúng cho từng compute platform (EC2/on-premises, Lambda, ECS), chọn deployment config phù hợp (in-place vs blue/green, canary vs linear vs all-at-once), đặt lifecycle hook đúng chỗ để chạy validation, cấu hình rollback tự động khi CloudWatch alarm kêu, và troubleshoot lý do deployment fail (agent không chạy, hook timeout, IAM thiếu quyền). Đề rất hay gài tên hook (`BeforeAllowTraffic` của Lambda vs `BeforeInstall` của EC2) và vị trí của file `appspec`.

## Mục tiêu chương

- Hiểu kiến trúc CodeDeploy: application, deployment group, deployment config, revision, CodeDeploy agent.
- Phân biệt 3 compute platform (EC2/on-premises, AWS Lambda, Amazon ECS) và `appspec` tương ứng của từng loại.
- Nắm chính xác thứ tự các lifecycle hook trên EC2 và biết hook nào chạy trước/sau khi traffic được chuyển.
- Chọn đúng deployment type (in-place vs blue/green) và deployment config (AllAtOnce, OneAtATime, HalfAtATime, canary, linear).
- Cấu hình rollback tự động qua CloudWatch alarm và automatic rollback on failure.
- Tích hợp CodeDeploy với ASG, ELB, và Lambda alias shifting (kết hợp SAM ở Chương 36).
- Troubleshoot các lỗi deployment thường gặp trong thực tế.

## 41.1 CodeDeploy giải quyết vấn đề gì

CodeDeploy là dịch vụ deployment tự động hoá việc đưa code/artifact lên compute target — thay cho việc bạn tự SSH vào từng server, `git pull`, restart service và cầu nguyện. Nó nằm ở stage "Deploy" trong pipeline CI/CD: thường đứng sau CodeBuild (Chương 40) trong CodePipeline (Chương 42), nhận artifact rồi roll out theo một chiến lược có kiểm soát.

Vấn đề cốt lõi mà CodeDeploy xử lý: deploy lên một fleet nhiều instance mà **không gây downtime** và **có thể rollback** khi phát hiện lỗi. Tự viết script làm việc này rất khổ — bạn phải tự xử lý: lấy instance ra khỏi load balancer trước khi update, chạy update, health check, đưa lại vào LB, làm lần lượt từng phần fleet để không sập toàn bộ, và nếu lỗi thì khôi phục version cũ. CodeDeploy đóng gói toàn bộ logic này thành một mô hình khai báo.

Điểm khác biệt cần nhớ cho thi: CodeDeploy **không build code** (đó là việc của CodeBuild) và **không cung cấp hạ tầng** (đó là CloudFormation/Beanstalk). Nó chỉ làm một việc: lấy một *revision* đã được build sẵn và roll out lên target theo chiến lược bạn chọn.

CodeDeploy hỗ trợ 3 compute platform, và **mọi thứ khác đều phụ thuộc vào platform bạn chọn** — từ format file `appspec`, tên lifecycle hook, đến các deployment config khả dụng:

| Compute platform | Target | Cần CodeDeploy agent? | Deployment type hỗ trợ |
|---|---|---|---|
| **EC2/On-premises** | EC2 instances, server on-prem | **Có** — agent chạy trên mỗi host | In-place hoặc Blue/Green |
| **AWS Lambda** | Lambda function (alias shifting) | Không | Chỉ Blue/Green (traffic shifting) |
| **Amazon ECS** | ECS service (task set mới) | Không | Chỉ Blue/Green (qua ELB) |

> 💡 **Exam Tip:** Chỉ có platform **EC2/On-premises** mới cần và chạy CodeDeploy agent. Lambda và ECS deployment do CodeDeploy điều phối qua API của các dịch vụ đó (Lambda alias, ECS task set), **không** cài agent. Nếu câu hỏi nói "agent không chạy / agent log trống" thì chắc chắn đang nói về EC2/on-premises.

## 41.2 Các khái niệm cốt lõi: Application, Deployment Group, Deployment Config, Revision

Để dùng CodeDeploy bạn cần hiểu 4 đối tượng và cách chúng lồng vào nhau.

- **Application**: một container logic đặt tên cho thứ bạn deploy. Application gắn cứng với **một compute platform** — bạn chọn EC2/On-premises, Lambda, hoặc ECS khi tạo và không đổi được. Application chỉ là cái tên + platform, không chứa cấu hình deploy.

- **Deployment Group**: tập các target để deploy vào, kèm cấu hình *cách* deploy. Đây là nơi chứa hầu hết cấu hình: với EC2 là tập instance (chọn theo **tag** hoặc theo **ASG**), với Lambda/ECS là tên function/service. Deployment group cũng giữ deployment config mặc định, rollback settings, alarm, và trigger. Một application có thể có nhiều deployment group (ví dụ `staging` và `production`).

- **Deployment Configuration**: một bộ quy tắc về tốc độ và điều kiện "thành công" khi roll out — bao nhiêu instance/traffic được update một lúc, tối thiểu bao nhiêu phải healthy. AWS có sẵn các config built-in, bạn cũng tự tạo custom config (xem 41.5).

- **Revision**: chính là thứ được deploy. Với EC2/On-premises, revision là một **application bundle** (file `appspec.yml` + source files + scripts) nén lại, đặt trên **S3** hoặc **GitHub**. Với Lambda/ECS, revision chỉ là **bản thân file appspec** (YAML/JSON) mô tả version function hoặc task definition — không có source bundle.

```bash
# Tạo application cho EC2/On-premises platform
aws deploy create-application \
  --application-name MyWebApp \
  --compute-platform Server   # Server = EC2/On-premises; Lambda; ECS

# Tạo deployment group chọn target theo EC2 tag, gắn service role
aws deploy create-deployment-group \
  --application-name MyWebApp \
  --deployment-group-name Prod \
  --service-role-arn arn:aws:iam::111122223333:role/CodeDeployServiceRole \
  --ec2-tag-filters Key=Environment,Value=Prod,Type=KEY_AND_VALUE \
  --deployment-config-name CodeDeployDefault.OneAtATime \
  --auto-rollback-configuration enabled=true,events=DEPLOYMENT_FAILURE
```

> 💡 **Exam Tip:** `--compute-platform` nhận giá trị `Server` (cho EC2/On-premises), `Lambda`, hoặc `ECS`. Đừng nhầm `Server` với "EC2" trong CLI — đề đôi khi viết `Server` để chỉ EC2/on-premises platform.

Service role (`CodeDeployServiceRole`) là IAM role mà CodeDeploy assume để thao tác trên tài nguyên của bạn — gọi ASG, đăng ký/huỷ đăng ký instance trên ELB, đọc tag... Thiếu hoặc sai trust policy của role này là nguyên nhân fail rất phổ biến (mục 41.9).

## 41.3 File appspec — trái tim của mỗi deployment

`appspec` là file khai báo CodeDeploy đọc để biết phải làm gì. Format và nội dung **khác nhau hoàn toàn** giữa 3 platform — đây là điểm thi hay đánh lừa nhất.

### EC2/On-premises: `appspec.yml`

Trên EC2, file **bắt buộc tên `appspec.yml`** và **bắt buộc nằm ở thư mục gốc** của application bundle (root của file zip). Sai tên hoặc sai vị trí → agent không tìm thấy → deployment fail ngay. Nó gồm 2 phần chính: `files` (copy file nguồn tới đâu trên đĩa) và `hooks` (chạy script ở các lifecycle event).

```yaml
version: 0.0
os: linux
files:
  - source: /                 # copy toàn bộ bundle...
    destination: /var/www/html # ...tới đây trên instance
permissions:
  - object: /var/www/html
    owner: nginx
    group: nginx
    mode: 755
hooks:
  ApplicationStop:
    - location: scripts/stop_server.sh
      timeout: 60
      runas: root
  BeforeInstall:
    - location: scripts/before_install.sh
      timeout: 300
  AfterInstall:
    - location: scripts/after_install.sh
  ApplicationStart:
    - location: scripts/start_server.sh
      timeout: 120
  ValidateService:
    - location: scripts/validate.sh
      timeout: 300
```

`version: 0.0` là giá trị duy nhất hợp lệ hiện tại — đừng đổi. `os` là `linux` hoặc `windows`. Mỗi hook là một danh sách script chạy tuần tự; `timeout` (giây) và `runas` (user chạy script, chỉ Linux) là tuỳ chọn.

### Lambda: appspec (YAML hoặc JSON)

Với Lambda, appspec không copy file gì — nó khai báo function version nào để shift traffic sang, và tuỳ chọn 2 hook Lambda chạy validation.

```yaml
version: 0.0
Resources:
  - myLambdaFunction:
      Type: AWS::Lambda::Function
      Properties:
        Name: my-function
        Alias: live
        CurrentVersion: "1"   # version đang chạy
        TargetVersion: "2"    # version mới cần chuyển sang
Hooks:
  - BeforeAllowTraffic: ValidationFn   # Lambda chạy validate TRƯỚC khi shift
  - AfterAllowTraffic: PostCheckFn     # Lambda chạy SAU khi shift xong
```

### ECS: appspec (YAML hoặc JSON)

Với ECS, appspec trỏ tới task definition mới và container/port để CodeDeploy tạo task set mới rồi shift traffic qua ELB.

```yaml
version: 0.0
Resources:
  - TargetService:
      Type: AWS::ECS::Service
      Properties:
        TaskDefinition: "arn:aws:ecs:...:task-definition/my-task:2"
        LoadBalancerInfo:
          ContainerName: "web"
          ContainerPort: 80
Hooks:
  - BeforeInstall: LambdaHookFn
  - AfterInstall: LambdaHookFn
  - AfterAllowTestTraffic: LambdaHookFn
  - BeforeAllowTraffic: LambdaHookFn
  - AfterAllowTraffic: LambdaHookFn
```

> 💡 **Exam Tip:** Với **Lambda và ECS**, các hook là tên **Lambda function** chạy validation (trả về `Succeeded`/`Failed` qua API `put-lifecycle-event-hook-execution-status`). Với **EC2/On-premises**, hook là **script** nằm trong bundle chạy bởi agent. Đây là khác biệt cốt lõi: hook EC2 = shell script; hook Lambda/ECS = Lambda function.

## 41.4 Lifecycle hooks trên EC2 — thứ tự và ý nghĩa từng hook

Đây là phần được hỏi nhiều nhất. CodeDeploy chạy các hook theo **thứ tự cố định** trong vòng đời deploy của một instance. Hiểu hook nào chạy trước/sau bước copy file và (với blue/green) trước/sau khi traffic chuyển là chìa khoá.

Thứ tự đầy đủ cho **in-place deployment** trên EC2:

1. **ApplicationStop** — dừng app version cũ. *Lưu ý quan trọng:* hook này chạy script lấy từ revision **đã deploy lần trước** (đang nằm trên đĩa), KHÔNG phải revision mới. Nếu lần deploy trước fail trước khi script kịp lên đĩa, ApplicationStop có thể bị bỏ qua.
2. **DownloadBundle** — agent tải revision về (giai đoạn này **không** đặt được hook).
3. **BeforeInstall** — chạy trước khi copy file mới (ví dụ backup, decrypt config).
4. **Install** — agent copy file theo mục `files` (không đặt được hook).
5. **AfterInstall** — sau khi copy (ví dụ đổi permission, chỉnh config).
6. **ApplicationStart** — khởi động app mới.
7. **ValidateService** — kiểm tra app chạy đúng (smoke test, curl health endpoint). Đây là cơ hội cuối để fail deploy trước khi coi là thành công.

Với **blue/green** (hoặc deployment có ELB), thứ tự thêm các hook xoay quanh việc đăng ký/huỷ đăng ký instance khỏi load balancer:

```
BeforeBlockTraffic → BlockTraffic → AfterBlockTraffic
   → ApplicationStop → DownloadBundle → BeforeInstall → Install
   → AfterInstall → ApplicationStart → ValidateService
   → BeforeAllowTraffic → AllowTraffic → AfterAllowTraffic
```

- **BeforeBlockTraffic / AfterBlockTraffic**: chạy trước/sau khi instance bị **gỡ khỏi ELB** (ngừng nhận traffic).
- **BeforeAllowTraffic / AfterAllowTraffic**: chạy trước/sau khi instance được **đưa vào ELB** trở lại.
- **BlockTraffic / AllowTraffic** (không đặt hook): CodeDeploy tự deregister/register target khỏi ELB.

> 💡 **Exam Tip:** Ghi nhớ 3 hook KHÔNG đặt script được: **DownloadBundle**, **Install**, **BlockTraffic/AllowTraffic** — đây là hành động do agent/CodeDeploy tự làm. Nếu đề hỏi "đặt validation script ở đâu để chạy sau khi cài file nhưng trước khi start app" → **AfterInstall**. "Smoke test sau khi app start" → **ValidateService**. "Kiểm tra trước khi cho traffic vào (blue/green)" → **BeforeAllowTraffic**.

Một bẫy kinh điển: **ApplicationStop chạy từ revision CŨ**. Vì vậy nếu bạn sửa script `stop_server.sh` ở revision mới, lần deploy này vẫn dùng bản cũ; bản mới chỉ có hiệu lực từ lần deploy *kế tiếp*.

## 41.5 Deployment types và deployment configurations

### In-place vs Blue/Green (EC2)

**In-place**: update trực tiếp trên các instance hiện có. Agent dừng app, cài version mới, start lại, từng instance hoặc từng nhóm theo deployment config. Ưu điểm: không tốn thêm hạ tầng. Nhược: trong lúc deploy capacity giảm (instance đang update không phục vụ traffic), và rollback là... deploy lại version cũ (chậm). Lambda **không** hỗ trợ in-place.

**Blue/Green**: tạo môi trường mới (green) song song với môi trường cũ (blue), deploy lên green, test, rồi chuyển traffic từ blue sang green qua ELB. Trên EC2, CodeDeploy provision instance mới (thường qua một ASG copy). Ưu điểm: rollback **tức thì** (chỉ cần trỏ traffic về blue, blue vẫn còn nguyên), không giảm capacity. Nhược: tốn gấp đôi hạ tầng trong lúc chuyển.

| Tiêu chí | In-place | Blue/Green |
|---|---|---|
| Hạ tầng thêm | Không | Có (môi trường green) |
| Capacity khi deploy | Giảm tạm thời | Giữ nguyên |
| Rollback | Deploy lại version cũ (chậm) | Trỏ traffic về blue (nhanh) |
| Hỗ trợ platform | EC2/On-prem | EC2, Lambda, ECS |
| On-premises | Có | **Không** (cần ASG/ELB do AWS quản lý) |

> 💡 **Exam Tip:** On-premises servers **không** dùng được blue/green (chỉ in-place), vì blue/green cần provision instance mới qua ASG mà AWS không kiểm soát được server vật lý của bạn. "Cần zero-downtime + rollback tức thì cho fleet EC2" → blue/green.

### Deployment config cho EC2/On-premises

Các config built-in kiểm soát **bao nhiêu instance update cùng lúc** và **tối thiểu bao nhiêu phải healthy**:

- `CodeDeployDefault.AllAtOnce` — update tất cả cùng lúc. Nhanh nhất, rủi ro cao nhất (downtime nếu lỗi).
- `CodeDeployDefault.HalfAtATime` — 50% một lúc; tối thiểu 50% phải healthy.
- `CodeDeployDefault.OneAtATime` — từng instance một; an toàn nhất, chậm nhất; chỉ cần lỗi 1 instance là deployment fail (trừ instance cuối).

Bạn tự tạo **custom config** bằng cách chỉ định `minimumHealthyHosts` theo số tuyệt đối (`HOST_COUNT`) hoặc phần trăm (`FLEET_PERCENT`):

```bash
aws deploy create-deployment-config \
  --deployment-config-name ThreeQuartersHealthy \
  --minimum-healthy-hosts type=FLEET_PERCENT,value=75
# Giữ tối thiểu 75% fleet healthy trong suốt deploy
```

### Deployment config cho Lambda và ECS (traffic shifting)

Lambda và ECS chỉ dùng blue/green với 3 kiểu **traffic shifting**:

- **AllAtOnce**: chuyển 100% traffic sang version mới ngay lập tức.
- **Canary**: chuyển X% trước, đợi N phút, rồi chuyển 100%. Ví dụ `Canary10Percent5Minutes` = 10% trong 5 phút rồi full.
- **Linear**: chuyển X% mỗi N phút cho tới 100%. Ví dụ `Linear10PercentEvery1Minute`.

Các config Lambda built-in (tên cố định, hay xuất hiện trong đề):

| Tên config | Hành vi |
|---|---|
| `CodeDeployDefault.LambdaAllAtOnce` | 100% ngay |
| `CodeDeployDefault.LambdaCanary10Percent5Minutes` | 10% rồi đợi 5 phút → 100% |
| `CodeDeployDefault.LambdaCanary10Percent30Minutes` | 10% rồi đợi 30 phút → 100% |
| `CodeDeployDefault.LambdaLinear10PercentEvery1Minute` | +10% mỗi phút |
| `CodeDeployDefault.LambdaLinear10PercentEvery10Minutes` | +10% mỗi 10 phút |

ECS có bộ tương đương với tiền tố `CodeDeployDefault.ECS...` (ví dụ `ECSCanary10Percent5Minutes`, `ECSAllAtOnce`, `ECSLinear10PercentEvery1Minute`).

> 💡 **Exam Tip:** **Canary** = "thử một liều nhỏ, dừng quan sát, rồi nhảy thẳng 100%". **Linear** = "tăng đều từng nấc cho tới 100%". Tên config tự mô tả: số phần trăm và khoảng thời gian. "10% trong 5 phút rồi toàn bộ" → Canary; "10% mỗi phút" → Linear.

## 41.6 CodeDeploy agent (EC2/On-premises)

Agent là tiến trình Ruby chạy trên mỗi EC2/on-prem host, **poll** CodeDeploy để nhận lệnh deploy, tải bundle về và thực thi các hook. Không có agent (hoặc agent dừng) → instance không nhận được deployment và bị báo lỗi.

Cài đặt agent (thường đặt trong User Data của Launch Template để instance mới tự có agent):

```bash
#!/bin/bash
# Amazon Linux 2 — cài codedeploy-agent
yum update -y
yum install -y ruby wget
cd /home/ec2-user
# region phải khớp với region deploy
wget https://aws-codedeploy-ap-southeast-1.s3.ap-southeast-1.amazonaws.com/latest/install
chmod +x ./install
./install auto
systemctl start codedeploy-agent
systemctl enable codedeploy-agent
```

Một số điểm về agent dễ ra trong đề/thực tế:

- Agent cần **outbound HTTPS (443)** tới CodeDeploy và tới S3 (để tải bundle). Trong private subnet phải có NAT Gateway hoặc VPC endpoint (interface endpoint cho codedeploy + gateway endpoint cho S3).
- Instance cần một **IAM instance profile** có quyền đọc bundle từ S3 (`s3:GetObject`). Đây là role **của EC2**, khác với service role của CodeDeploy.
- Log của agent nằm ở `/var/log/aws/codedeploy-agent/codedeploy-agent.log` và log từng deployment ở `/opt/codedeploy-agent/deployment-root/`. Đây là nơi đầu tiên nhìn khi troubleshoot.
- Agent tự cập nhật mặc định; bạn có thể cố định version qua `:autoupdate: false` trong config nếu cần.

> 💡 **Exam Tip:** Phân biệt **hai IAM identity**: (1) **service role** mà CodeDeploy assume (thao tác ASG/ELB), và (2) **instance profile/role** gắn trên EC2 để agent đọc bundle từ S3. Lỗi "không tải được revision từ S3" thường do thiếu `s3:GetObject` ở instance role, không phải service role.

## 41.7 Tích hợp với Auto Scaling Group và ELB

CodeDeploy hiểu ASG natively. Khi deployment group trỏ tới một ASG, CodeDeploy giải quyết một vấn đề kinh điển: **instance mới do ASG scale-out trong lúc/sau deploy phải nhận đúng version mới**.

- Khi bạn associate một ASG với deployment group, CodeDeploy gắn một **lifecycle hook** vào ASG. Mỗi khi ASG launch instance mới, hook tạm dừng instance ở trạng thái pending cho tới khi CodeDeploy chạy revision **hiện hành** lên nó. Nhờ vậy instance mới luôn có version đúng, không bị "lệch" version với phần còn lại của fleet.
- Với **blue/green trên EC2 + ASG**, CodeDeploy tạo một ASG mới (green) sao chép cấu hình ASG cũ, launch instance, deploy, đăng ký vào ELB, rồi tuỳ chọn terminate ASG cũ (blue) sau một khoảng chờ — hoặc giữ lại để rollback nhanh.
- CodeDeploy có thể đăng ký/huỷ đăng ký instance khỏi **ELB target group** trong quá trình deploy (các hook BlockTraffic/AllowTraffic). Bạn khai báo ELB info trong load balancer settings của deployment group.

Một war story thường thành câu hỏi: nếu bạn vừa tạo AMI mới đã có version mới *và* để CodeDeploy quản lý ASG, có thể xảy ra "double deploy". Best practice: tách bạch — để CodeDeploy là nguồn sự thật duy nhất cho version code, AMI chỉ chứa runtime + agent.

> 💡 **Exam Tip:** "Instance mới do ASG scale-out chạy version cũ/lệch version với fleet" → nguyên nhân là ASG chưa được associate với deployment group, nên lifecycle hook không kích deploy lên instance mới. Cách sửa: thêm ASG vào deployment group của CodeDeploy.

## 41.8 Rollback tự động với CloudWatch alarm

Rollback trong CodeDeploy về bản chất là **deploy lại revision trước đó** (last known good). Có 2 cơ chế kích hoạt rollback tự động:

1. **Automatic rollback on failure** — bật `events=DEPLOYMENT_FAILURE`: nếu deployment fail (hook lỗi, không đủ healthy host...), CodeDeploy tự deploy lại version cũ.
2. **Rollback when alarm threshold met** — gắn **CloudWatch alarm** vào deployment group; nếu trong lúc deploy alarm chuyển sang `ALARM` (ví dụ tỉ lệ 5xx vượt ngưỡng, latency tăng), CodeDeploy dừng và rollback. Đây là cách thực sự "an toàn" vì nó bắt được lỗi *logic* mà deployment vẫn báo thành công.

```bash
aws deploy update-deployment-group \
  --application-name MyWebApp \
  --current-deployment-group-name Prod \
  --auto-rollback-configuration enabled=true,events=DEPLOYMENT_FAILURE,DEPLOYMENT_STOP_ON_ALARM \
  --alarm-configuration enabled=true,alarms=[{name=High5xxAlarm},{name=HighLatencyAlarm}]
```

Các giá trị `events` hợp lệ: `DEPLOYMENT_FAILURE`, `DEPLOYMENT_STOP_ON_ALARM`, `DEPLOYMENT_STOP_ON_REQUEST`.

Với **Lambda/ECS canary/linear**, alarm-based rollback đặc biệt mạnh: trong khoảng baking time (5 phút, 10 phút...) khi mới có 10% traffic vào version mới, nếu alarm error rate kêu thì CodeDeploy shift toàn bộ traffic ngược lại version cũ — gần như zero blast radius. Trong SAM (Chương 36) đây chính là `DeploymentPreference` với `Alarms` và hook `PreTraffic`/`PostTraffic`.

> 💡 **Exam Tip:** "Deploy báo thành công nhưng app lỗi runtime / error rate tăng" → cần **CloudWatch alarm gắn vào deployment group** để rollback, vì automatic-rollback-on-failure chỉ bắt khi *deployment process* fail, không bắt lỗi logic của app sau khi traffic đã chuyển. Đáp án đúng thường là canary/linear + alarm.

Lưu ý: rollback tạo ra một deployment **mới** (revision cũ) chứ không "khôi phục" trạng thái — vì vậy các hook lại chạy. Nếu hook không idempotent có thể gây vấn đề.

## 41.9 Troubleshooting deployment failures

Bảng các lỗi hay gặp và nguyên nhân — đề thi rất thích dạng "deployment fail, tại sao":

| Triệu chứng | Nguyên nhân thường gặp |
|---|---|
| `Validation of PKCS7 signed message failed` / instance không nhận deploy | CodeDeploy agent **không chạy** hoặc version cũ → `systemctl status codedeploy-agent` |
| `The CodeDeploy agent did not find an AppSpec file` | `appspec.yml` sai tên hoặc không ở **root** của bundle |
| Hook script fail / `ScriptFailed` | Script trả exit code ≠ 0, sai `runas` user, hoặc thiếu quyền execute |
| Hook bị `ScriptTimedOut` | Script chạy lâu hơn `timeout` khai báo trong appspec |
| `HEALTH_CONSTRAINTS` | Không đủ instance healthy theo `minimumHealthyHosts` |
| Không tải được revision từ S3 | **Instance role** thiếu `s3:GetObject`, hoặc no route ra S3 (private subnet không có NAT/endpoint) |
| `Failed to access ASG/ELB` | **Service role** thiếu quyền hoặc trust policy sai |
| `ApplicationStop` script lỗi nhưng dùng version cũ | Nhớ: ApplicationStop chạy script từ **revision trước** |

Quy trình debug thực tế trên EC2:
1. Xem agent: `sudo systemctl status codedeploy-agent`.
2. Đọc log agent: `/var/log/aws/codedeploy-agent/codedeploy-agent.log`.
3. Xem log từng deployment & output hook: `/opt/codedeploy-agent/deployment-root/<deployment-group-id>/<deployment-id>/logs/scripts.log`.
4. Trong console CodeDeploy: click vào deployment → từng instance → xem hook nào fail và message.

> 💡 **Exam Tip:** Nếu **ApplicationStop hook bị lỗi treo deployment** trong khi script của bạn đã ổn ở revision mới, nguyên nhân là agent chạy phiên bản script CŨ. Cách xử lý phổ biến trong tài liệu AWS: cài lại/khởi động lại agent, hoặc tạo deployment với option bỏ qua ApplicationStop failures (`--ignore-application-stop-failures` qua CLI/`ignoreApplicationStopFailures`).

## 41.10 CodeDeploy với Lambda alias shifting (kết hợp SAM)

Đây là pattern serverless thuần được hỏi rất nhiều. Bạn deploy version mới của Lambda và dùng CodeDeploy để **shift traffic** từ version cũ sang mới qua một **alias** — thay vì cut-over cứng.

Cơ chế: Lambda **alias** (ví dụ `live`) có thể trỏ đồng thời tới 2 version với trọng số (weighted alias). CodeDeploy điều khiển trọng số này theo canary/linear: ban đầu `live` = 90% v1 + 10% v2, sau baking time chuyển 0% v1 + 100% v2 (xem versions & aliases ở Chương 29).

Trong SAM (Chương 36), bạn không viết appspec tay — chỉ khai báo `DeploymentPreference`:

```yaml
Resources:
  MyFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: index.handler
      Runtime: nodejs20.x
      AutoPublishAlias: live          # SAM tự tạo alias + version mỗi lần deploy
      DeploymentPreference:
        Type: Canary10Percent5Minutes # 10% trong 5 phút rồi 100%
        Alarms:                       # rollback nếu alarm kêu
          - !Ref HighErrorRateAlarm
        Hooks:
          PreTraffic: !Ref PreTrafficCheckFn   # validate TRƯỚC khi shift
          PostTraffic: !Ref PostTrafficCheckFn # validate SAU khi shift
```

`AutoPublishAlias: live` khiến SAM/CloudFormation tự publish version mới và trỏ alias `live` mỗi lần `sam deploy`, rồi giao cho CodeDeploy shift traffic theo `DeploymentPreference`. `PreTraffic`/`PostTraffic` map sang hook `BeforeAllowTraffic`/`AfterAllowTraffic` của CodeDeploy — là các Lambda function trả về Succeeded/Failed.

> 💡 **Exam Tip:** Với Lambda traffic shifting, **client gọi qua alias** (`live`), không gọi thẳng version. CodeDeploy chỉ thay đổi weighted routing của alias — không "deploy" code vào đâu cả vì version đã tồn tại sẵn. Hook validation cho Lambda phải gọi `aws deploy put-lifecycle-event-hook-execution-status --status Succeeded|Failed` để báo CodeDeploy tiếp tục hay rollback.

## 41.11 So sánh nhanh: CodeDeploy trên 3 platform

Bảng tổng hợp để chốt kiến thức — đây là khung trả lời nhanh cho mọi câu hỏi platform:

| Khía cạnh | EC2/On-premises | Lambda | ECS |
|---|---|---|---|
| `--compute-platform` | `Server` | `Lambda` | `ECS` |
| Revision | App bundle (S3/GitHub) | appspec YAML/JSON | appspec YAML/JSON |
| appspec gồm | `files` + `hooks` (script) | Resources + Hooks (Lambda fn) | Resources + Hooks (Lambda fn) |
| Cần agent | **Có** | Không | Không |
| Deployment type | In-place / Blue-Green | Blue/Green (shift) | Blue/Green (shift) |
| Hook đặc trưng | BeforeInstall, AfterInstall, ValidateService... | BeforeAllowTraffic, AfterAllowTraffic | + AfterAllowTestTraffic |
| Cách roll out | Update host theo config | Weighted alias | Task set mới + ELB |
| Rollback | Deploy lại revision cũ | Trỏ alias về version cũ | Giữ task set cũ, shift về |

Lưu ý ECS có thêm hook **AfterAllowTestTraffic** — cho phép test trên một test listener (cổng test riêng) trước khi mở production traffic, hữu ích để chạy integration test trên môi trường green trước khi cho user thật vào.

> 💡 **Exam Tip:** Nhớ mỏ neo theo platform: thấy "agent", "appspec.yml ở root", "BeforeInstall/ValidateService" → EC2. Thấy "alias", "version", "BeforeAllowTraffic" → Lambda. Thấy "task definition", "task set", "AfterAllowTestTraffic" → ECS. Một câu hỏi thường chỉ cần bạn nhận diện đúng platform là loại được 2-3 đáp án sai.
