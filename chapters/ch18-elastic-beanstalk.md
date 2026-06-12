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

---

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
