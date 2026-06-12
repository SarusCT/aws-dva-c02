## Hands-on Lab: Deploy ứng dụng Node.js lên Elastic Beanstalk, đổi deployment policy và kiểm chứng .ebextensions

**Mục tiêu lab:** Dựng một application + environment web server bằng EB CLI, deploy một app Node.js đơn giản, xem CloudFormation/ASG/ELB mà Beanstalk tạo bên dưới, đổi deployment policy từ mặc định sang **rolling** rồi **immutable** và quan sát hành vi, dùng `.ebextensions` để set environment variable + cấu hình ASG, cấu hình **lifecycle policy** cho application versions, và cuối cùng dọn dẹp sạch. Lab bám đúng phạm vi Chương 18 và dùng cả EB CLI lẫn AWS CLI v2 — đúng cách đề DVA-C02 mô tả thao tác.

**Chuẩn bị:**
- AWS CLI v2 đã cấu hình profile có quyền `elasticbeanstalk:*`, kèm các quyền tạo EC2/ELB/ASG/S3/CloudFormation/IAM (cấu hình CLI ở Chương 3). Nếu account chưa từng dùng EB, cần có service role `aws-elasticbeanstalk-service-role` và instance profile `aws-elasticbeanstalk-ec2-role` — EB Console tạo tự động; với CLI bạn tạo trước (Bước 0).
- EB CLI: `pip install awsebcli --upgrade` rồi kiểm tra `eb --version` (ví dụ `EB CLI 3.20.x`).
- Region ví dụ: `ap-southeast-1`. Platform `Node.js 20 running on 64bit Amazon Linux 2023`.
- Node.js cài sẵn để chạy thử local (không bắt buộc).

### Bước 0: Tạo instance profile và service role (nếu chưa có)

Beanstalk cần 2 IAM identity: **instance profile** gắn vào EC2 (cho app truy cập AWS) và **service role** cho chính dịch vụ EB (gọi CloudWatch, ASG…). Tạo nhanh instance profile từ managed policy:

```bash
# Trust policy cho EC2
cat > ec2-trust.json <<'EOF'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow",
"Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}
EOF

aws iam create-role --role-name aws-elasticbeanstalk-ec2-role \
  --assume-role-policy-document file://ec2-trust.json
aws iam attach-role-policy --role-name aws-elasticbeanstalk-ec2-role \
  --policy-arn arn:aws:iam::aws:policy/AWSElasticBeanstalkWebTier
aws iam create-instance-profile \
  --instance-profile-name aws-elasticbeanstalk-ec2-role
aws iam add-role-to-instance-profile \
  --instance-profile-name aws-elasticbeanstalk-ec2-role \
  --role-name aws-elasticbeanstalk-ec2-role
```

> Bẫy hay gặp: nếu thiếu instance profile, `eb create` sẽ báo lỗi `Environment ... has launched ... but ... health is Severe` vì instance không lấy được instance profile hợp lệ. Luôn kiểm tra instance profile trước.

### Bước 1: Tạo source code và khởi tạo EB application

```bash
mkdir eb-lab && cd eb-lab
cat > package.json <<'EOF'
{ "name": "eb-lab", "version": "1.0.0",
  "scripts": { "start": "node app.js" } }
EOF

cat > app.js <<'EOF'
const http = require('http');
const port = process.env.PORT || 8080;       // EB proxy forward về PORT
const msg = process.env.GREETING || 'default';
http.createServer((_, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`Hello from EB — GREETING=${msg}\n`);
}).listen(port);
EOF
```

> 💡 Với platform Node.js trên Amazon Linux 2023, nginx (reverse proxy) lắng nghe cổng 80 và forward về app của bạn ở cổng `PORT` (mặc định 8080). Đừng cố bind cổng 80 trong code — sẽ bị từ chối quyền.

Khởi tạo application bằng EB CLI (tạo thư mục `.elasticbeanstalk/config.yml`):

```bash
eb init eb-lab-app --platform "Node.js 20 running on 64bit Amazon Linux 2023" \
  --region ap-southeast-1
```

### Bước 2: Tạo environment web server và deploy lần đầu

```bash
eb create eb-lab-dev \
  --instance-types t3.micro \
  --elb-type application \
  --min-instances 2 --max-instances 4
```

EB CLI zip source, upload lên một S3 bucket do EB quản lý (`elasticbeanstalk-<region>-<account-id>`), tạo một **application version** rồi triển khai qua một **CloudFormation stack**. Theo dõi tới khi `Health: Green`. Lấy URL:

```bash
eb status        # In ra CNAME: eb-lab-dev.xxxx.ap-southeast-1.elasticbeanstalk.com
curl http://$(eb status | awk '/CNAME/{print $2}')
# Kỳ vọng: Hello from EB — GREETING=default
```

Xem **bên dưới Beanstalk thực chất là gì** — đây là điểm DVA hay hỏi:

```bash
# Beanstalk tạo một CloudFormation stack tên awseb-e-xxxx-stack
aws cloudformation list-stacks \
  --query "StackSummaries[?contains(StackName,'awseb')].StackName" --output text
# Trong stack có ASG, Launch Template, ALB, Listener, SG... do EB sinh ra
aws autoscaling describe-auto-scaling-groups \
  --query "AutoScalingGroups[?contains(AutoScalingGroupName,'awseb')].[AutoScalingGroupName,MinSize,MaxSize]" \
  --output table
```

### Bước 3: Dùng .ebextensions set env var và tinh chỉnh ASG

Tạo thư mục `.ebextensions` ở gốc source. File `.config` (định dạng YAML) dùng namespace `option_settings`:

```bash
mkdir .ebextensions
cat > .ebextensions/01-options.config <<'EOF'
option_settings:
  aws:elasticbeanstalk:application:environment:
    GREETING: "from-ebextensions"
  aws:autoscaling:asg:
    MinSize: "2"
    MaxSize: "4"
  aws:elasticbeanstalk:command:
    DeploymentPolicy: Rolling
    BatchSizeType: Fixed
    BatchSize: "1"
EOF

eb deploy
curl http://$(eb status | awk '/CNAME/{print $2}')
# Kỳ vọng: Hello from EB — GREETING=from-ebextensions
```

> 💡 **Exam Tip:** Thứ tự ưu tiên cấu hình (precedence) khi cùng một option set ở nhiều nơi: **Settings áp trực tiếp lên environment (API/Console/`eb setenv`)** > `.ebextensions` > **saved configuration** > default. Vì vậy một env var đặt bằng `eb setenv` sẽ **đè** giá trị trong `.ebextensions`.

### Bước 4: Đổi deployment policy sang Immutable và quan sát

Đổi policy bằng AWS CLI (thay vì `.ebextensions`) để thấy `update-environment` hoạt động:

```bash
aws elasticbeanstalk update-environment \
  --environment-name eb-lab-dev \
  --option-settings \
    Namespace=aws:elasticbeanstalk:command,OptionName=DeploymentPolicy,Value=Immutable
```

Giờ sửa `app.js` (đổi text), `eb deploy` lại và quan sát: với **immutable**, EB tạo một **ASG tạm** với một full set instance mới, chỉ swap khi tất cả pass health check, rồi gỡ instance cũ. Bạn sẽ thấy số instance tạm thời tăng vọt. So với **rolling** (Bước 3) chỉ thay từng batch trên chính ASG hiện tại.

```bash
eb deploy
# Trong lúc deploy, ở terminal khác:
aws autoscaling describe-auto-scaling-groups \
  --query "AutoScalingGroups[?contains(AutoScalingGroupName,'awseb')].DesiredCapacity"
```

### Bước 5: Lifecycle policy cho application versions

Mỗi `eb deploy` tạo một version mới; quota mặc định **1000 application versions/region**. Đụng quota là deploy fail. Đặt lifecycle policy để tự xoá version cũ:

```bash
aws elasticbeanstalk update-application-resource-lifecycle \
  --application-name eb-lab-app \
  --resource-lifecycle-config '{
    "ServiceRole":"arn:aws:iam::ACCOUNT_ID:role/aws-elasticbeanstalk-service-role",
    "VersionLifecycleConfig":{
      "MaxCountRule":{"Enabled":true,"MaxCount":10,"DeleteSourceFromS3":true}}}'
```

> 💡 `DeleteSourceFromS3:true` xoá luôn bundle trong S3 — tránh phình chi phí lưu trữ. Lifecycle policy KHÔNG xoá version đang được deploy ở bất kỳ environment nào.

### Bước 6 (tuỳ chọn): Blue/green bằng swap CNAME

Blue/green thật sự trên EB = tạo environment thứ hai (green), deploy version mới lên green, test, rồi **swap CNAME**:

```bash
eb clone eb-lab-dev --clone-name eb-lab-green   # nhân bản cấu hình
# ... deploy version mới, test trên URL của green ...
aws elasticbeanstalk swap-environment-cnames \
  --source-environment-name eb-lab-dev \
  --destination-environment-name eb-lab-green
```

Swap CNAME đổi DNS gần như tức thì, rollback chỉ cần swap ngược lại. Đây là cách zero-downtime + dễ rollback nhất, nhưng tốn gấp đôi tài nguyên trong lúc chạy song song.

### Dọn dẹp tài nguyên

```bash
# Xoá environment (kéo theo CFN stack, ASG, ALB, EC2 do EB tạo)
eb terminate eb-lab-dev --force
eb terminate eb-lab-green --force 2>/dev/null   # nếu đã tạo ở Bước 6

# Xoá application (kèm mọi version + cấu hình)
aws elasticbeanstalk delete-application \
  --application-name eb-lab-app --terminate-env-by-force

# Dọn IAM tạo ở Bước 0 (nếu account chỉ dùng cho lab)
aws iam remove-role-from-instance-profile \
  --instance-profile-name aws-elasticbeanstalk-ec2-role \
  --role-name aws-elasticbeanstalk-ec2-role
aws iam delete-instance-profile --instance-profile-name aws-elasticbeanstalk-ec2-role
aws iam detach-role-policy --role-name aws-elasticbeanstalk-ec2-role \
  --policy-arn arn:aws:iam::aws:policy/AWSElasticBeanstalkWebTier
aws iam delete-role --role-name aws-elasticbeanstalk-ec2-role
```

> Kiểm tra trên S3 bucket `elasticbeanstalk-ap-southeast-1-<account-id>` còn version bundle nào không (xoá thủ công nếu lifecycle policy chưa kịp dọn). `eb terminate` KHÔNG xoá bucket này.

## 💡 Exam Tips chương 18

- **Beanstalk free, chỉ trả tiền tài nguyên bên dưới** (EC2, ELB, RDS…). Câu hỏi "least operational overhead để deploy một web app mà vẫn kiểm soát hạ tầng" thường trỏ về Beanstalk.
- Nắm chắc 5 **deployment policy** và đặc tính: **All-at-once** (downtime, không thêm instance), **Rolling** (giảm capacity trong lúc deploy, không thêm cost), **Rolling with additional batches** (giữ full capacity, thêm batch tạm), **Immutable** (full set instance mới trên ASG tạm, an toàn nhất, dễ rollback), **Traffic splitting** (canary — chia % traffic sang version mới trên instance tạm).
- **Immutable vs Rolling with additional batches**: cả hai đều giữ đủ capacity, nhưng immutable tạo ASG mới hoàn toàn nên rollback chỉ là gỡ instance mới (nhanh, sạch); rolling-with-batches sửa trên ASG hiện có nên rollback phải redeploy.
- **Blue/green trên EB = swap CNAME giữa 2 environment**, KHÔNG phải một deployment policy. Dùng khi cần zero-downtime + rollback tức thì, đặc biệt khi đổi platform version lớn hoặc DB migration.
- **.ebextensions** là các file `.config` (YAML/JSON) trong thư mục `.ebextensions/`, xử lý theo thứ tự alphabet. `option_settings` set cấu hình; `Resources` cho phép thêm tài nguyên CloudFormation tuỳ ý.
- **RDS launched trong environment sẽ bị xoá khi terminate environment** — production phải tạo RDS riêng (decouple) rồi truyền connection qua environment variable. Đây là câu hỏi kinh điển.
- **Precedence cấu hình:** direct environment settings > `.ebextensions` > saved configuration > default. Nhớ `eb setenv` đè `.ebextensions`.
- Bên dưới Beanstalk là **CloudFormation** — nó sinh ASG, ELB, Launch Template, SG. Biết điều này để debug và để phân biệt với câu hỏi "muốn full control IaC" (→ CloudFormation thuần, Chương 19).
- **Worker environment** đọc message từ **SQS** (qua sqsd daemon POST vào `localhost`); dùng cho tác vụ nền/long-running. Web environment phục vụ HTTP.
- **Lifecycle policy** giới hạn số application version để không đụng quota **1000 versions/region**; bật `DeleteSourceFromS3` để dọn bundle.
- **Single instance vs Load balanced**: single instance (1 EC2, Elastic IP, không ELB) rẻ cho dev; load balanced có ALB/NLB + ASG cho production.
- **Saved configuration** lưu snapshot option settings vào S3, dùng để clone cấu hình sang environment khác — khác với cloning (nhân bản cả environment đang chạy).

## Quiz chương 18 (10 câu)

**Câu 1.** A developer needs to deploy a new application version to an Elastic Beanstalk environment with **zero downtime** and the ability to **roll back instantly** by changing DNS only. Which approach should they use?
- A. Rolling deployment policy
- B. All-at-once deployment policy
- C. Immutable deployment policy
- D. Create a second environment, deploy the new version, then swap CNAMEs

**Câu 2.** Trong một deployment, yêu cầu là giữ **full capacity** suốt quá trình và nếu version mới lỗi thì rollback phải **nhanh và sạch nhất**. Chọn deployment policy nào?
- A. Rolling
- B. Rolling with additional batches
- C. Immutable
- D. All-at-once

**Câu 3.** Một environment Beanstalk được tạo với RDS launched bên trong environment. Khi terminate environment để tiết kiệm chi phí, chuyện gì xảy ra với dữ liệu?
- A. RDS được giữ lại tự động
- B. RDS instance và dữ liệu bị xoá cùng environment
- C. RDS chuyển sang trạng thái stopped
- D. RDS được snapshot tự động và giữ vĩnh viễn

**Câu 4.** Developer muốn set một biến môi trường `LOG_LEVEL=debug` cho mọi instance trong environment, commit cùng source code. Cách đúng?
- A. Sửa file `/etc/environment` qua SSH
- B. Thêm `option_settings` với namespace `aws:elasticbeanstalk:application:environment` trong file `.ebextensions/*.config`
- C. Hardcode trong user data của Launch Template
- D. Tạo một parameter trong S3 bucket của EB

**Câu 5.** Cùng một option vừa được set bằng `eb setenv` vừa set trong `.ebextensions`. Giá trị nào có hiệu lực?
- A. Giá trị trong `.ebextensions`
- B. Giá trị set trực tiếp bằng `eb setenv`
- C. Báo lỗi xung đột, deploy fail
- D. Giá trị nào nhỏ hơn theo thứ tự alphabet

**Câu 6.** Sau nhiều tháng CI/CD, một environment báo lỗi không deploy được version mới do **đạt giới hạn application versions**. Giải pháp ít thao tác nhất, tự động về sau?
- A. Tạo application mới
- B. Cấu hình application version lifecycle policy (MaxCount hoặc MaxAge)
- C. Đổi sang CodeDeploy
- D. Tăng quota bằng Service Quotas request

**Câu 7.** A developer needs to run **background jobs** triggered by messages, with long-running processing, on Elastic Beanstalk. Loại environment nào phù hợp?
- A. Web server environment với ALB
- B. Worker environment đọc từ SQS queue
- C. Single instance environment
- D. Web server environment với NLB

**Câu 8.** Team muốn **canary deployment**: đẩy 10% traffic sang version mới, theo dõi, rồi mới chuyển 100%. Deployment policy nào của Beanstalk hỗ trợ trực tiếp?
- A. Immutable
- B. Rolling with additional batches
- C. Traffic splitting
- D. Blue/green swap CNAME

**Câu 9.** Khi Beanstalk tạo một environment load-balanced, nó dựng các tài nguyên hạ tầng bên dưới bằng cách nào?
- A. Gọi trực tiếp EC2/ELB API và lưu state nội bộ
- B. Tạo một CloudFormation stack quản lý ASG, ELB, Launch Template, SG
- C. Dùng Terraform managed
- D. Tạo một CDK app

**Câu 10.** Một environment đang dùng **All-at-once** và bị downtime mỗi lần deploy. Yêu cầu mới: không downtime nhưng **không được tăng chi phí** bằng cách thêm instance tạm thời, chấp nhận giảm capacity tạm trong lúc deploy. Chọn policy nào?
- A. Immutable
- B. Rolling
- C. Rolling with additional batches
- D. Traffic splitting

### Đáp án & giải thích

**Câu 1 — Đáp án D.** Blue/green qua swap CNAME giữa hai environment cho zero-downtime và rollback tức thì chỉ bằng cách swap DNS ngược lại. A (rolling) thay tại chỗ, rollback phải redeploy. B (all-at-once) gây downtime. C (immutable) zero-downtime nhưng rollback là gỡ instance mới và redeploy, không phải chỉ "đổi DNS" — không khớp yêu cầu "roll back by changing DNS only".

**Câu 2 — Đáp án C.** Immutable tạo một ASG tạm với full set instance mới; nếu lỗi chỉ cần xoá ASG/instance mới, không động đến instance cũ → rollback nhanh và sạch nhất, đồng thời giữ full capacity. B cũng giữ full capacity nhưng sửa trên ASG hiện có nên rollback phức tạp hơn. A (rolling) giảm capacity và rollback phải redeploy. D gây downtime.

**Câu 3 — Đáp án B.** RDS được tạo *trong* environment có vòng đời gắn với environment: terminate environment thì RDS và dữ liệu bị xoá (trừ khi đổi DeletionPolicy). Best practice production là tạo RDS độc lập rồi truyền endpoint qua env var (decouple). A/C/D đều sai vì mặc định không giữ/stop/snapshot vĩnh viễn.

**Câu 4 — Đáp án B.** `.ebextensions` với namespace `aws:elasticbeanstalk:application:environment` là cách chuẩn, version-controlled để set env var áp lên mọi instance. A không bền (instance thay là mất, không reproducible). C lạm dụng user data, EB quản lý launch template nên dễ bị ghi đè. D không phải cơ chế cấu hình env var của EB.

**Câu 5 — Đáp án B.** Precedence: settings áp trực tiếp lên environment (như `eb setenv`/Console/API) cao hơn `.ebextensions`. Vì vậy `eb setenv` thắng. A sai vì ngược precedence. C sai vì không gây lỗi, chỉ áp theo thứ tự ưu tiên. D là quy tắc xử lý thứ tự *file* trong `.ebextensions`, không phải precedence giữa các nguồn.

**Câu 6 — Đáp án B.** Application version lifecycle policy tự xoá version cũ theo MaxCount/MaxAge (kèm DeleteSourceFromS3) — giải quyết triệt để và tự động. A tạo application mới chỉ né tạm, mất lịch sử. C đổi hẳn công cụ deploy là quá mức. D: giới hạn 1000 versions là quota có thể tăng nhưng không phải giải pháp "ít thao tác, tự động về sau" và vẫn sẽ đầy lại.

**Câu 7 — Đáp án B.** Worker environment của Beanstalk gắn với một SQS queue; daemon sqsd kéo message và POST vào ứng dụng — đúng cho background/long-running jobs. A/D là web environment phục vụ HTTP đồng bộ. C single instance không có cơ chế tiêu thụ queue tích hợp.

**Câu 8 — Đáp án C.** Traffic splitting là deployment policy canary gốc của Beanstalk: deploy lên instance tạm rồi chia % traffic qua ALB, tăng dần. A (immutable) chuyển 100% sau khi healthy, không chia %. B không có cơ chế chia % traffic. D (blue/green) chuyển toàn bộ qua swap CNAME, không phải canary theo %.

**Câu 9 — Đáp án B.** Beanstalk dùng CloudFormation bên dưới để provision ASG, ELB, Launch Template, Security Group… (tên stack `awseb-e-...`). A/C/D sai: EB không tự giữ state ngoài CFN, không dùng Terraform/CDK.

**Câu 10 — Đáp án B.** Rolling thay version theo từng batch ngay trên ASG hiện tại, **không** thêm instance tạm (không tăng cost) nhưng chấp nhận giảm capacity trong lúc deploy — đúng yêu cầu. A và C đều thêm instance tạm (tăng cost tạm). D (traffic splitting) cũng dùng instance tạm.

## Tóm tắt chương

- Elastic Beanstalk là **PaaS** giúp deploy web app nhanh: bạn đưa code, EB lo provisioning, load balancing, auto scaling, health monitoring. Dịch vụ miễn phí, chỉ trả tiền tài nguyên bên dưới.
- Ba khái niệm cốt lõi: **Application** (logical container) → **Application Version** (một bundle code đã version hoá) → **Environment** (nơi một version đang chạy, có CNAME riêng).
- Hai loại environment: **Web server** (phục vụ HTTP, có thể single instance hoặc load balanced) và **Worker** (đọc job từ **SQS** qua sqsd, cho tác vụ nền/long-running).
- Năm **deployment policy**: All-at-once (downtime, rẻ), Rolling (giảm capacity tạm, không tăng cost), Rolling with additional batches (giữ full capacity, thêm batch tạm), Immutable (ASG mới hoàn toàn, an toàn & rollback sạch nhất), Traffic splitting (canary theo % traffic).
- **Blue/green** không phải một policy mà là tạo environment thứ hai rồi **swap CNAME** — zero-downtime, rollback tức thì, phù hợp đổi platform lớn hoặc DB migration.
- **.ebextensions** (`*.config`, YAML/JSON) cấu hình environment qua `option_settings` và thêm tài nguyên qua `Resources`; xử lý theo thứ tự alphabet của tên file.
- **Precedence cấu hình:** direct environment settings (`eb setenv`/API/Console) > `.ebextensions` > saved configuration > default.
- Bên dưới Beanstalk là **CloudFormation**, sinh ra ASG, ELB, Launch Template, Security Group — biết điều này giúp debug và phân biệt với CloudFormation thuần (full control IaC).
- **RDS tạo trong environment bị xoá khi terminate environment** → production phải decouple RDS, truyền connection qua environment variable.
- **Lifecycle policy** cho application versions (MaxCount/MaxAge + DeleteSourceFromS3) tránh đụng quota **1000 versions/region** và dọn bundle trong S3.
- **Saved configuration** lưu snapshot cấu hình (S3) để tái dùng; **cloning** nhân bản nguyên environment đang chạy.
- **EB CLI** (`eb init/create/deploy/status/setenv/clone/terminate`) là công cụ chính cho developer; các thao tác tương đương có trên AWS CLI (`aws elasticbeanstalk ...`).
