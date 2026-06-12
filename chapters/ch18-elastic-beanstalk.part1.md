# Chương 18: AWS Elastic Beanstalk

> **Trọng tâm DVA-C02:** Beanstalk xuất hiện ở domain Deployment với mật độ cao. Đề thi gần như chắc chắn hỏi bạn phân biệt 6 deployment policy (all-at-once, rolling, rolling with additional batches, immutable, traffic splitting, blue/green) theo các tiêu chí: có downtime không, có chạy capacity vượt 100% không, rollback nhanh hay chậm, chi phí. Ngoài ra hay gặp câu về `.ebextensions` để cấu hình môi trường, tách RDS ra khỏi environment để không mất data khi terminate, worker environment xử lý job từ SQS, và lifecycle policy để dọn application version.

## Mục tiêu chương

- Hiểu kiến trúc Beanstalk: quan hệ application → application version → environment, và cách Beanstalk dựng hạ tầng EC2/ASG/ELB bên dưới bằng CloudFormation.
- Phân biệt web server tier và worker environment, hiểu cơ chế SQS daemon (sqsd) trong worker.
- Nắm vững 6 deployment policy và chọn đúng theo tiêu chí downtime / capacity / rollback / cost — đây là điểm thi quan trọng nhất chương.
- Triển khai blue/green bằng swap CNAME và phân biệt với traffic splitting.
- Dùng `.ebextensions`, saved configuration, environment manifest để cấu hình tái lập được.
- Tách RDS ra khỏi environment để tránh mất dữ liệu, và quản lý application version bằng lifecycle policy.

## 18.1 Beanstalk là gì và mô hình trách nhiệm

AWS Elastic Beanstalk là một dịch vụ PaaS (Platform as a Service): bạn đẩy code lên, Beanstalk lo việc provision EC2, gắn Auto Scaling Group, Elastic Load Balancer, cấu hình health check, cài runtime (Node.js, Python, Java, .NET, Go, PHP, Ruby) hoặc chạy container Docker. Mục tiêu là để developer tập trung vào code, không phải dựng hạ tầng thủ công.

Điểm cốt lõi cho đề thi: **Beanstalk là free** — bạn chỉ trả tiền cho tài nguyên bên dưới (EC2, EBS, ELB, RDS...). Beanstalk không phải "magic", bên dưới nó dùng **CloudFormation** để tạo stack tài nguyên. Khi bạn tạo một environment, vào CloudFormation console bạn sẽ thấy một stack tên dạng `awseb-e-xxxxx-stack` chứa ASG, Launch Template/Config, ELB, Security Group, CloudWatch alarms (chi tiết CloudFormation ở Chương 19).

Mức kiểm soát: Beanstalk nằm giữa "tự dựng EC2 thủ công" (toàn quyền nhưng vất vả) và "Lambda serverless" (managed hoàn toàn nhưng ít kiểm soát). Bạn vẫn SSH được vào EC2, vẫn chỉnh được instance type, AMI, security group — nhưng nên chỉnh qua Beanstalk config chứ không sửa tay (sửa tay sẽ bị Beanstalk ghi đè khi update, gây drift).

Ba thành phần định danh quan trọng:

| Khái niệm | Ý nghĩa |
|-----------|---------|
| **Application** | Container logic, gom nhóm các version và environment của cùng một app. Chỉ là namespace, không tốn tiền. |
| **Application Version** | Một bản build code cụ thể (file ZIP/WAR/Docker image ref), lưu trong S3, có version label duy nhất. |
| **Environment** | Tập tài nguyên đang chạy một version: web (web server tier) hoặc worker (worker tier). Có URL CNAME riêng. |

Một application có thể có nhiều environment chạy song song (ví dụ `myapp-dev`, `myapp-staging`, `myapp-prod`), mỗi environment chạy một version khác nhau.

> 💡 **Exam Tip:** "Beanstalk uses CloudFormation under the hood" — nếu câu hỏi muốn biết Beanstalk provision tài nguyên thế nào, đáp án là CloudFormation, KHÔNG phải bạn tự viết template. Và Beanstalk free, chỉ trả phí tài nguyên.

## 18.2 Platform, deploy bằng EB CLI và SDK

Beanstalk hỗ trợ hai dạng platform: **managed platform** (chọn runtime như Node.js 20, Corretto Java 17, Python 3.12...) và **Docker platform** (single-container hoặc dùng ECS để chạy multi-container — phần multi-container chi tiết ở Chương 17). Mỗi platform có **platform version** (vd `Node.js 20 running on 64bit Amazon Linux 2023`); AWS phát hành managed platform update để vá OS/runtime.

Cách deploy phổ biến nhất là **EB CLI** — công cụ dòng lệnh chuyên cho Beanstalk (khác AWS CLI thường):

```bash
# Cài EB CLI
pip install awsebcli

# Khởi tạo (chọn region, application, platform) — tạo thư mục .elasticbeanstalk/
eb init -p "node.js-20" my-app --region ap-southeast-1

# Tạo environment web server tier, dùng ALB
eb create my-app-prod --elb-type application

# Deploy code hiện tại lên environment đang active
eb deploy

# Xem trạng thái / mở app trên browser / xem log
eb status
eb open
eb logs

# Liệt kê & đổi cấu hình deployment policy, instance type...
eb config

# Terminate environment (xoá tài nguyên)
eb terminate my-app-prod
```

`eb deploy` đóng gói code (theo `.gitignore`/`.ebignore`), upload lên S3 thành application version mới rồi cập nhật environment.

**Health reporting:** Beanstalk có hai chế độ báo cáo sức khoẻ environment. **Basic health** dựa chủ yếu vào health check của ELB (instance up/down). **Enhanced health** thu thập thêm metric từ một agent trên mỗi instance (CPU, latency, mã HTTP 4xx/5xx, độ sâu request) và quy ra trạng thái màu: Green (OK), Yellow (warning), Red (severe). Enhanced health bật metric đẩy về CloudWatch và là cơ sở để Beanstalk tự rollback khi deploy hỏng. Đề thi hay phân biệt: muốn nhìn sâu hơn "tỉ lệ 5xx tăng sau deploy" thì cần **enhanced health**, không phải basic.

**Managed platform updates:** AWS phát hành bản vá OS/runtime cho platform. Bạn bật **managed platform updates** để Beanstalk tự áp dụng minor/patch update trong một **maintenance window** hàng tuần, theo cơ chế **immutable** (an toàn). Major update phải làm thủ công.

Dùng AWS SDK v3 (Node.js) khi cần tự động hoá trong pipeline:

```javascript
import {
  ElasticBeanstalkClient,
  CreateApplicationVersionCommand,
  UpdateEnvironmentCommand,
} from "@aws-sdk/client-elastic-beanstalk";

const eb = new ElasticBeanstalkClient({ region: "ap-southeast-1" });

// Tạo application version từ bundle đã upload sẵn lên S3
await eb.send(new CreateApplicationVersionCommand({
  ApplicationName: "my-app",
  VersionLabel: "v42",
  SourceBundle: { S3Bucket: "my-eb-bundles", S3Key: "builds/v42.zip" },
  Process: true, // validate bundle ngay
}));

// Trỏ environment sang version v42 -> trigger deployment theo policy đã cấu hình
await eb.send(new UpdateEnvironmentCommand({
  EnvironmentName: "my-app-prod",
  VersionLabel: "v42",
}));
```

> 💡 **Exam Tip:** Phân biệt `eb deploy` (deploy lên environment hiện có, cập nhật version) với `eb create` (tạo environment mới). Câu hỏi tình huống hay test việc bạn biết bundle code được lưu ở S3 dưới dạng application version.

## 18.3 Web server tier vs Worker environment

Beanstalk có hai loại environment tier, và đề thi rất hay hỏi phân biệt.

**Web server tier:** chạy HTTP server, đứng sau ELB, nhận request từ user trực tiếp. Đây là kiểu mặc định cho REST API, web app. Kiến trúc: ELB → ASG → các EC2 chạy app + nginx/Apache reverse proxy phía trước.

**Worker tier:** không có ELB hướng ra internet. Thay vào đó, mỗi EC2 chạy một daemon tên **sqsd** (SQS daemon). sqsd **poll một SQS queue**, mỗi message lấy về được POST tới `http://localhost/` (hoặc path cấu hình trong `cron.yaml`) của ứng dụng. Nếu app trả HTTP 200, sqsd xoá message; nếu lỗi (non-200 hoặc timeout), message quay lại queue, sau số lần thử sẽ vào Dead Letter Queue. Worker tier dùng cho **long-running / background jobs**: xử lý ảnh, gửi email hàng loạt, sinh báo cáo — những việc không nên giữ HTTP request của user chờ.

Worker còn hỗ trợ **periodic tasks** qua file `cron.yaml` ở thư mục gốc bundle:

```yaml
version: 1
cron:
  - name: "report-job"
    url: "/tasks/daily-report"
    schedule: "0 2 * * *"   # 2h sáng UTC mỗi ngày
```

Pattern kinh điển: web tier nhận request, đẩy job vào SQS (chi tiết SQS ở Chương 21), worker tier tự co giãn theo độ sâu queue để xử lý. Hai tier decouple nhau, scale độc lập.

| Tiêu chí | Web server tier | Worker tier |
|----------|-----------------|-------------|
| Có ELB hướng internet | Có | Không |
| Nguồn việc | HTTP request từ user | Message từ SQS queue (sqsd poll) |
| Use case | Web app, REST API | Background/long-running jobs, periodic tasks |
| File cấu hình đặc thù | — | `cron.yaml` cho periodic tasks |

> 💡 **Exam Tip:** Từ khoá "decouple long-running task", "process messages from SQS", "background image processing" → chọn **worker environment**. Daemon đứng giữa là **sqsd**. Web tier không tự đọc SQS.

## 18.4 Deployment policies — phần thi quan trọng nhất

Khi deploy version mới lên một web tier, Beanstalk hỗ trợ các policy sau. Bạn PHẢI thuộc bảng này.

**1. All at once (mặc định cho single instance):** deploy lên tất cả instance cùng lúc. Nhanh nhất nhưng **có downtime** (toàn bộ instance gỡ version cũ, cài version mới đồng thời). Nếu lỗi phải re-deploy version cũ. KHÔNG dùng cho production.

**2. Rolling:** deploy theo từng batch (vd 25% instance một lượt). Mỗi lúc có một phần fleet chạy version cũ, một phần chạy version mới → **không downtime nhưng giảm capacity** trong lúc deploy (ví dụ batch 25%/4 instance thì còn 75% phục vụ). App chạy ở **dưới 100% capacity**. Nếu lỗi giữa chừng, một số batch đã lên version mới, một số còn cũ → cần redeploy để khôi phục.

**3. Rolling with additional batches:** giống rolling nhưng Beanstalk **bật thêm một batch instance mới** trước, để luôn giữ **đủ 100% capacity** trong suốt quá trình deploy (chạy ở mức trên 100% lúc cao điểm). Phù hợp khi không được tụt capacity. Sau khi xong, batch phụ bị thu hồi. Tốn thêm tiền cho batch phụ trong thời gian deploy.

**4. Immutable:** an toàn nhất cho rolling-forward. Beanstalk tạo **một ASG tạm thời mới**, bật **một full set instance mới** chạy version mới song song với set cũ. Khi tất cả instance mới pass health check, chúng được chuyển vào ASG chính và instance cũ bị terminate. **Không downtime, rollback cực nhanh và sạch** (chỉ cần xoá ASG tạm). Nhược điểm: **tốn gấp đôi instance** trong lúc deploy, và lâu nhất.

**5. Traffic splitting (canary):** Beanstalk bật một set instance mới (như immutable) nhưng dùng **ALB để chia % traffic** sang version mới (vd 10%), theo dõi health/metric trong khoảng thời gian cấu hình; nếu ổn thì chuyển 100%, nếu không thì rút về 0% và terminate set mới. Đây là canary testing thực sự dựa trên % người dùng. Yêu cầu ALB.

**6. Blue/Green (không phải policy trong dropdown — làm thủ công bằng swap CNAME, xem 18.5).**

Bảng so sánh để học thuộc:

| Policy | Downtime | Capacity trong lúc deploy | Tốc độ | Rollback | Tốn thêm instance |
|--------|----------|---------------------------|--------|----------|-------------------|
| All at once | **Có** | 0% lúc deploy | Nhanh nhất | Re-deploy (chậm) | Không |
| Rolling | Không | **Dưới 100%** | Nhanh | Re-deploy | Không |
| Rolling + additional batches | Không | **100% (đỉnh >100%)** | Trung bình | Re-deploy | Có (1 batch) |
| Immutable | Không | 100% | Chậm | **Nhanh (xoá ASG mới)** | **Có (gấp đôi)** |
| Traffic splitting | Không | 100% | Chậm | **Rất nhanh (rút %)** | Có (canary set) |

Một số chi tiết hay bị gài:
- Single instance environment chỉ có **all at once** (không có ELB để rolling).
- Rolling deploy **trong cùng environment**, blue/green deploy ra **environment khác** rồi swap.
- Immutable và traffic splitting dùng **instance hoàn toàn mới** → tránh được vấn đề "version cũ và mới lẫn lộn trên cùng instance" (vd dependency bị bẩn).
- **Batch size** trong rolling có thể đặt theo phần trăm hoặc số tuyệt đối instance. Batch nhỏ → deploy chậm hơn nhưng ít rủi ro; batch lớn → nhanh nhưng tụt capacity sâu hơn.

**War story điển hình:** một team dùng `all at once` cho production, deploy giờ cao điểm, một instance fail health check do bug → toàn bộ fleet down vài phút trong lúc cài lại, khách hàng thấy 503. Bài học: production gần như không bao giờ dùng `all at once`. Nếu cần zero-downtime tuyệt đối và rollback sạch, immutable là lựa chọn an toàn nhất dù tốn gấp đôi instance trong vài phút.

Cấu hình deployment policy qua `.ebextensions` (namespace `aws:elasticbeanstalk:command`):

```yaml
option_settings:
  aws:elasticbeanstalk:command:
    DeploymentPolicy: Immutable   # AllAtOnce | Rolling | RollingWithAdditionalBatch | Immutable | TrafficSplitting
    Timeout: "600"
  aws:elasticbeanstalk:healthreporting:system:
    SystemType: enhanced          # bật enhanced health để tự rollback khi deploy lỗi
```

> 💡 **Exam Tip:** Học theo từ khoá: "zero downtime + fastest rollback + can't mix old/new code" → **Immutable**. "Maintain full capacity, không tốn gấp đôi" → **Rolling with additional batches**. "Test với % người dùng nhỏ trước" → **Traffic splitting (canary)**. "No downtime, cheapest, chấp nhận giảm capacity" → **Rolling**. "Fastest deploy nhưng có downtime" → **All at once**.

## 18.5 Blue/Green bằng swap CNAME

Các policy trên đều deploy **trong cùng environment**. Để zero-downtime tuyệt đối với khả năng rollback tức thì, dùng **blue/green deployment**:

1. Environment hiện tại (blue) đang chạy version cũ, có CNAME `myapp.ap-southeast-1.elasticbeanstalk.com`.
2. **Clone** environment blue thành environment mới (green) — Beanstalk cung cấp tính năng "Clone Environment" sao chép y nguyên cấu hình.
3. Deploy version mới lên green, test kỹ trên URL riêng của green.
4. Khi ổn, dùng **Swap Environment URLs** (swap CNAME) — Beanstalk hoán đổi CNAME giữa blue và green. Traffic người dùng chuyển sang green gần như tức thì (chỉ phụ thuộc DNS TTL).
5. Nếu green lỗi sau khi swap → swap CNAME lần nữa để **rollback ngay** về blue. Blue vẫn còn nguyên, chưa bị terminate.

```bash
# Swap URL giữa hai environment bằng EB CLI
eb swap myapp-blue --destination_name myapp-green
```

Ưu điểm: zero downtime, rollback bằng một thao tác swap. Nhược điểm: chạy **hai environment đầy đủ** trong thời gian chuyển → tốn gấp đôi tài nguyên tạm thời, và phải tự quản lý hai environment.

**Bẫy data layer:** nếu RDS nằm BÊN TRONG environment (coupled), blue và green sẽ có hai database riêng → swap xong dữ liệu không khớp. Vì vậy với blue/green, database PHẢI tách ngoài Beanstalk (xem 18.7).

| Tiêu chí | Immutable / Traffic splitting | Blue/Green (swap CNAME) |
|----------|-------------------------------|-------------------------|
| Phạm vi | Trong cùng 1 environment | Hai environment riêng |
| Rollback | Xoá ASG mới / rút % | Swap CNAME ngược lại |
| Quản lý | Beanstalk tự lo | Bạn tự tạo & swap |
| Phù hợp khi | Deploy thường ngày | Thay đổi lớn, đổi platform version |

> 💡 **Exam Tip:** "Swap CNAME / swap environment URLs" là dấu hiệu nhận diện chắc chắn của **blue/green** trên Beanstalk. Rollback của blue/green = swap lại. Phụ thuộc DNS TTL nên không phải tức thì 100% (client đang cache DNS cũ vẫn đi vào blue tới khi TTL hết).

## 18.6 `.ebextensions`, saved configuration và environment manifest

**`.ebextensions`** là cách cấu hình môi trường bằng code, đi kèm trong bundle. Đó là thư mục `.ebextensions/` ở thư mục gốc, chứa các file `.config` định dạng YAML/JSON. Beanstalk áp dụng khi deploy. Các key thường dùng:

- `option_settings`: đặt option của Beanstalk (instance type, env variables, ELB setting, autoscaling min/max...).
- `resources`: thêm tài nguyên CloudFormation tuỳ ý (vd tạo thêm SQS queue, DynamoDB table, CloudWatch alarm) — vì Beanstalk chạy trên CloudFormation nên bạn mở rộng được stack.
- `packages`, `commands`, `container_commands`, `files`, `users`, `services`: cài package OS, chạy lệnh trước/sau khi setup.

Ví dụ `.ebextensions/01-env.config`:

```yaml
option_settings:
  aws:elasticbeanstalk:application:environment:
    NODE_ENV: production
    LOG_LEVEL: info
  aws:autoscaling:asg:
    MinSize: "2"
    MaxSize: "6"
  aws:elasticbeanstalk:environment:
    EnvironmentType: LoadBalanced

resources:
  JobQueue:
    Type: AWS::SQS::Queue
    Properties:
      VisibilityTimeout: 300

container_commands:
  01_migrate:
    command: "npm run migrate"
    leader_only: true   # chỉ chạy trên 1 instance, tránh chạy migration nhiều lần
```

`leader_only: true` là chi tiết hay được hỏi: với `container_commands`, đặt cờ này để lệnh (như DB migration) chỉ chạy trên một instance duy nhất, tránh race condition khi fleet nhiều instance cùng chạy migration.

**Saved configuration:** lưu lại toàn bộ option settings của một environment thành một template tái sử dụng (lưu trong S3). Dùng để tạo environment mới với cấu hình y hệt, hoặc khôi phục cấu hình. Tạo bằng `eb config save` hoặc console "Save Configuration".

**Cloning:** sao chép một environment đang chạy (cùng config, cùng version) thành environment mới — chính là bước chuẩn bị cho blue/green ở 18.5. Khác saved configuration ở chỗ clone tạo environment chạy ngay, saved config chỉ là bản lưu cấu hình.

> 💡 **Exam Tip:** Cần thêm tài nguyên AWS (SQS, alarm) khi deploy app Beanstalk? Dùng khối `resources` trong `.ebextensions`. Cần chạy DB migration một lần duy nhất khi deploy? Dùng `container_commands` với `leader_only: true`. Cần env variable cho app? Dùng `option_settings` namespace `aws:elasticbeanstalk:application:environment`.

## 18.7 Tách RDS ra khỏi environment

Beanstalk cho phép tạo RDS **bên trong** environment (tích hợp sẵn, tiện cho dev/test). Nhưng đây là **anti-pattern cho production** và là câu hỏi kinh điển:

Khi RDS được tạo bên trong environment, vòng đời database **gắn chặt vào vòng đời environment**. Nếu bạn **terminate environment** (hoặc thao tác blue/green tạo environment mới rồi xoá cái cũ), RDS đó **bị xoá theo** → **mất toàn bộ dữ liệu**. Ngoài ra database không chia sẻ được giữa nhiều environment (blue/green mỗi cái một DB).

Giải pháp đúng: **tạo RDS riêng (standalone), ngoài Beanstalk**, rồi cho app kết nối qua security group + connection string truyền vào bằng environment variable (`option_settings`). Khi đó terminate environment không đụng tới DB.

Quy trình **decouple một RDS đang nằm trong environment** (đề hay hỏi):

1. Tạo một **DB snapshot** của RDS hiện tại (phòng hờ).
2. Bật **deletion protection** trên RDS instance để chắc chắn nó không bị xoá khi environment bị terminate.
3. Tạo environment mới, trỏ app sang RDS standalone qua env variable, KHÔNG bật RDS trong environment mới.
4. Swap/blue-green sang environment mới, rồi terminate environment cũ. Nhờ deletion protection, RDS vẫn sống.

```yaml
# .ebextensions/db.config — trỏ app sang RDS standalone bằng env var
option_settings:
  aws:elasticbeanstalk:application:environment:
    DB_HOST: mydb.abc123.ap-southeast-1.rds.amazonaws.com
    DB_NAME: appdb
    DB_USER: appuser
    DB_PASSWORD: '{{resolve:secretsmanager:prod/db:SecretString:password}}'
```

> 💡 **Exam Tip:** "Avoid losing database data when terminating environment" / "blue-green với database" → **tách RDS ra ngoài Beanstalk**, hoặc trước khi tách thì bật **deletion protection** và **snapshot**. RDS coupled bên trong environment sẽ bị xoá cùng environment.

## 18.8 Lifecycle policy cho application version và CloudFormation bên dưới

Mỗi lần deploy tạo một **application version** lưu trong S3. Beanstalk mặc định giới hạn **1000 application version** mỗi application. Nếu CI/CD deploy liên tục, bạn sẽ đụng quota này và deploy fail với lỗi "too many application versions".

Giải pháp: **Application version lifecycle policy** — tự động dọn version cũ theo:
- **Số lượng**: chỉ giữ N version gần nhất (vd 200).
- **Tuổi**: xoá version cũ hơn X ngày.

Có tuỳ chọn **"Delete source bundle from S3"** để xoá luôn file ZIP trong S3 (tiết kiệm phí) hay chỉ xoá metadata version. Lưu ý: **version đang được dùng bởi một environment sẽ không bị xoá** dù vượt ngưỡng policy — đây là cơ chế an toàn.

```bash
# Cấu hình lifecycle qua CLI (chỉ giữ 200 version mới nhất, xoá bundle S3)
aws elasticbeanstalk update-application-resource-lifecycle \
  --application-name my-app \
  --resource-lifecycle-config 'ServiceRole=arn:aws:iam::111122223333:role/aws-elasticbeanstalk-service-role,VersionLifecycleConfig={MaxCountRule={Enabled=true,MaxCount=200,DeleteSourceFromS3=true}}'
```

**Beanstalk + CloudFormation:** như đã nói ở 18.1, mỗi environment tương ứng một CloudFormation stack do Beanstalk quản lý. Hệ quả thực tế:
- Bạn **không nên sửa tay** tài nguyên trong stack đó (ASG, ELB, SG) qua EC2/CloudFormation console — Beanstalk sẽ ghi đè hoặc gây drift. Mọi thay đổi đi qua Beanstalk option settings / `.ebextensions`.
- Khi update environment lỗi, Beanstalk dựa vào CloudFormation rollback để khôi phục về trạng thái trước (chi tiết rollback của CloudFormation ở Chương 19).
- Bạn mở rộng stack bằng khối `resources` trong `.ebextensions` (đã thấy ở 18.6) thay vì sửa stack trực tiếp.

Hai role IAM quan trọng cần phân biệt:
- **Service role** (`aws-elasticbeanstalk-service-role`): Beanstalk dùng để gọi các dịch vụ khác (CloudWatch, ASG, ELB...) thay bạn — vd để monitor health, scale.
- **EC2 instance profile** (`aws-elasticbeanstalk-ec2-role`): role gắn vào EC2 instance, cấp quyền cho **app của bạn** truy cập AWS (S3, DynamoDB, SQS...). Đây là role bạn cần sửa khi app cần đọc/ghi tài nguyên AWS.

> 💡 **Exam Tip:** Lỗi "cannot deploy, reached limit of 1000 application versions" → cấu hình **application version lifecycle policy** để tự xoá version cũ. Muốn app trên EC2 truy cập S3/DynamoDB → thêm quyền vào **EC2 instance profile** (`aws-elasticbeanstalk-ec2-role`), KHÔNG phải service role. Đừng sửa tay ASG/ELB của stack Beanstalk — chỉnh qua config.
