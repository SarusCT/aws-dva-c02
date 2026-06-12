# Chương 17: ECS & Fargate

> **Trọng tâm DVA-C02:** ECS là dịch vụ container quan trọng nhất trong đề thi. Câu hỏi tập trung vào: phân biệt **task role vs execution role** (gần như chắc chắn xuất hiện), chọn **EC2 vs Fargate** launch type theo tiêu chí "least operational overhead", cấu hình **ALB + dynamic port mapping**, **service auto scaling** (target tracking trên CPU/Memory/ALBRequestCountPerTarget), truyền **environment variables vs secrets** (Secrets Manager/SSM) vào container, **deployment circuit breaker** để tự rollback, gắn **EFS** cho persistent storage, và dùng **ECS Exec** để debug container không có SSH. EKS chỉ ở mức nhận diện.

## Mục tiêu chương

- Hiểu kiến trúc ECS: cluster → service → task → task definition → container, và cơ chế đặt task (task placement) lên hạ tầng.
- Phân biệt rõ hai launch type **EC2** và **Fargate** — khác biệt về quản lý hạ tầng, pricing, networking, khi nào chọn loại nào.
- Nắm vững **task execution role vs task role** — điểm thi kinh điển hay gài bẫy.
- Cấu hình networking mode `awsvpc`, tích hợp ALB với dynamic port mapping, và service auto scaling bằng target tracking.
- Truyền cấu hình vào container đúng cách: environment variables, `secrets` từ Secrets Manager / SSM Parameter Store; gắn EFS cho dữ liệu bền vững.
- Hiểu rolling update, deployment circuit breaker, capacity providers; và dùng ECS Exec để vào shell container đang chạy.

## 17.1 Kiến trúc ECS: cluster, task definition, task, service

**Amazon ECS (Elastic Container Service)** là orchestrator container của AWS — nó quyết định container nào chạy ở đâu, theo dõi tình trạng, restart khi chết, và scale theo nhu cầu. Bạn cần nắm 4 khái niệm xếp tầng từ dưới lên:

- **Task Definition** — bản thiết kế (blueprint) ở dạng JSON, mô tả 1 hoặc nhiều **container definitions**: image (URI từ ECR — chi tiết ECR ở Chương 16), CPU/memory, port mappings, environment variables, secrets, log config, volume mounts, command/entrypoint. Task definition là **immutable + versioned**: mỗi lần đăng ký (register) tạo ra một **revision** mới (`my-app:1`, `my-app:2`...). Bạn không sửa được revision cũ, chỉ tạo revision mới.
- **Task** — một instance đang chạy của một task definition revision. Nếu task definition khai báo 2 container, thì 1 task = 2 container chạy cùng nhau (cùng vòng đời, cùng network namespace nếu dùng `awsvpc`). Task là đơn vị scheduling nhỏ nhất của ECS — tương tự **Pod** trong Kubernetes.
- **Service** — đảm bảo luôn có N task (desired count) chạy. Nếu một task chết, service launch task mới thay thế (giống ASG nhưng cho container). Service tích hợp với load balancer, hỗ trợ rolling deployment và auto scaling. Dùng service cho ứng dụng long-running (web API, worker).
- **Cluster** — ranh giới logic gom các task/service và (với EC2 launch type) các **container instance** (EC2 chạy ECS agent). Với Fargate, cluster chỉ là grouping logic, không có server bạn quản.

Ngoài service, bạn có thể chạy **standalone task** (`run-task`) cho job chạy một lần rồi thoát (batch, migration, cron qua EventBridge Scheduler) — không có auto-restart.

```bash
# Đăng ký một task definition mới từ file JSON → trả về revision mới
aws ecs register-task-definition --cli-input-json file://taskdef.json

# Liệt kê các revision của một family
aws ecs list-task-definitions --family-prefix my-app --sort DESC

# Chạy 1 task standalone trên Fargate
aws ecs run-task \
  --cluster my-cluster \
  --task-definition my-app:3 \
  --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[subnet-aaa],securityGroups=[sg-bbb],assignPublicIp=ENABLED}'
```

> 💡 **Exam Tip:** Task definition **immutable & versioned**. Khi deploy code mới, bạn build image mới → push lên ECR → register **revision mới** của task definition → update service trỏ vào revision mới. Update service mà giữ nguyên revision cũ sẽ không deploy code mới. Nếu đề hỏi "container chạy nhiều bản khác nhau sau khi update", thường vì service vẫn trỏ revision cũ hoặc dùng tag image `latest` mơ hồ.

## 17.2 Launch types: EC2 vs Fargate

ECS có hai cách cung cấp compute để chạy task:

- **EC2 launch type:** bạn tự vận hành một flotilla EC2 (container instances) trong cluster. Mỗi instance chạy **ECS agent** (`amazon-ecs-agent`) đăng ký với cluster. ECS đặt task lên các instance còn đủ tài nguyên. Bạn chịu trách nhiệm: chọn instance type, patch OS, scale số lượng instance (qua ASG hoặc ECS Capacity Provider), tối ưu bin-packing để tiết kiệm. Trả tiền theo **EC2 đang chạy**, kể cả khi instance trống chỗ.
- **Fargate launch type:** serverless. Bạn **không** quản EC2 nào. Chỉ khai báo task cần bao nhiêu vCPU/memory; AWS provision micro-VM (dựa trên Firecracker) chạy đúng task đó rồi tính tiền theo vCPU-giây và GB-giây **task đang chạy**. Không patch OS, không lo capacity của host.

| Tiêu chí | EC2 launch type | Fargate |
|---|---|---|
| Quản lý host | Bạn tự quản EC2, patch OS, scale instance | AWS quản hết — serverless |
| Pricing | Theo EC2 (kể cả idle) | Theo vCPU-giây + GB-giây của task |
| Operational overhead | Cao | **Thấp nhất** (từ khoá "least operational overhead") |
| GPU / instance đặc thù | Có (chọn instance type GPU, Graviton...) | Hạn chế (Fargate hỗ trợ ARM/Graviton, không GPU) |
| Daemon scheduling | Có (1 task/instance) | Không (không có host để gắn daemon) |
| Quy mô lớn, chạy 24/7 ổn định | Thường rẻ hơn khi tối ưu bin-packing | Có thể đắt hơn nếu chạy liên tục cường độ cao |
| Networking mode | bridge, host, awsvpc, none | **chỉ awsvpc** |
| Privileged container, custom kernel | Có | Không |

Về cấu hình tài nguyên Fargate: vCPU và memory phải nằm trong **các cặp hợp lệ**. Ví dụ 0.25 vCPU (256) chỉ cho phép 512MB/1GB/2GB; 1 vCPU (1024) cho 2–8GB; tối đa hiện tại lên tới 16 vCPU + 120GB. Bạn không thể đặt memory tuỳ ý — phải đúng combo. Đây là điểm hay sai khi viết task definition.

> 💡 **Exam Tip:** Câu hỏi "least operational overhead" / "no infrastructure to manage" / "don't want to manage servers" cho container → **Fargate**. Câu hỏi cần **GPU**, cần instance type cụ thể, cần **daemon** giám sát từng host, hoặc tối ưu chi phí ở quy mô lớn chạy 24/7 → **EC2 launch type**. Fargate **chỉ dùng networking mode awsvpc** — mỗi task có ENI và private IP riêng.

## 17.3 Task execution role vs task role — điểm thi kinh điển

ECS có **hai** IAM role tách biệt, gắn vào những chỗ khác nhau, phục vụ mục đích khác nhau. Đề thi gần như luôn hỏi điểm này.

- **Task Execution Role** (`executionRoleArn`): role mà **ECS agent / Fargate agent** dùng để **chuẩn bị và khởi động** task — TRƯỚC khi code app chạy. Cụ thể: kéo (pull) image private từ ECR, ghi log lên CloudWatch Logs, và **đọc secrets** từ Secrets Manager / SSM để inject vào container. Managed policy điển hình: `AmazonECSTaskExecutionRolePolicy` (cho phép `ecr:GetDownloadUrlForLayer`, `ecr:BatchGetImage`, `ecr:GetAuthorizationToken`, `logs:CreateLogStream`, `logs:PutLogEvents`). Khi dùng secrets, phải thêm quyền `secretsmanager:GetSecretValue` / `ssm:GetParameters` (+ `kms:Decrypt` nếu SecureString/CMK).
- **Task Role** (`taskRoleArn`): role mà **chính code trong container** dùng khi gọi AWS API lúc runtime — ví dụ ghi DynamoDB, đọc S3, gửi SQS. SDK trong container tự lấy credentials tạm của role này qua **task metadata endpoint** (giống IMDS nhưng cho container, biến môi trường `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`). Đây là cách đúng — **không** nhúng access key vào image.

```json
{
  "family": "my-app",
  "executionRoleArn": "arn:aws:iam::111122223333:role/ecsTaskExecutionRole",
  "taskRoleArn": "arn:aws:iam::111122223333:role/myAppTaskRole",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "containerDefinitions": [
    {
      "name": "api",
      "image": "111122223333.dkr.ecr.us-east-1.amazonaws.com/my-app:1.0.3",
      "portMappings": [{ "containerPort": 8080, "protocol": "tcp" }],
      "environment": [{ "name": "LOG_LEVEL", "value": "info" }],
      "secrets": [
        { "name": "DB_PASSWORD", "valueFrom": "arn:aws:secretsmanager:us-east-1:111122223333:secret:prod/db-AbC123" }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/my-app",
          "awslogs-region": "us-east-1",
          "awslogs-stream-prefix": "api"
        }
      }
    }
  ]
}
```

Trong code Node.js chạy bên trong container, **không cấu hình credentials** — SDK v3 tự nhặt từ container credentials provider:

```javascript
// Trong container ECS, SDK v3 tự lấy credentials của TASK ROLE qua metadata endpoint
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
const ddb = new DynamoDBClient({}); // không truyền accessKeyId/secretAccessKey
await ddb.send(new PutItemCommand({
  TableName: "Orders",
  Item: { id: { S: "o-123" }, status: { S: "NEW" } },
}));
```

> 💡 **Exam Tip:** Lỗi "**CannotPullContainerError**" hoặc "không ghi được log" khi task **không khởi động được** → vấn đề ở **Task Execution Role** (thiếu quyền ECR/logs). Lỗi container **đang chạy** nhưng gọi DynamoDB/S3 bị **AccessDenied** → vấn đề ở **Task Role**. Inject secret vào biến môi trường mà task fail lúc start → execution role thiếu `secretsmanager:GetSecretValue` (+ `kms:Decrypt`). Nhớ: execution role = "trước khi chạy" (pull/log/secrets), task role = "lúc code chạy gọi API".

## 17.4 Networking modes & awsvpc

Với **EC2 launch type**, task definition chọn được `networkMode`:

- **bridge** (mặc định trên Linux nếu không khai): dùng Docker bridge network nội bộ trên host. Container map cổng qua host. Hỗ trợ **dynamic port mapping** với ALB (xem 17.5).
- **host**: container dùng trực tiếp network của host EC2 — không có lớp NAT, hiệu năng cao nhất, nhưng không chạy được 2 task cùng cổng trên cùng host.
- **awsvpc**: mỗi task được cấp **ENI riêng** với private IP trong VPC, có security group riêng. Task xuất hiện như một "máy" độc lập trong subnet. Đây là mode **bắt buộc với Fargate** và khuyến nghị cho EC2.
- **none**: không có external network.

`awsvpc` quan trọng vì: security group ở **mức task** (kiểm soát fine-grained), VPC Flow Logs thấy từng task, dễ tích hợp với target group type `ip`. Nhược điểm EC2: mỗi instance có giới hạn số ENI (tuỳ instance type) → giới hạn số task/instance; bật **ENI trunking** để tăng mật độ.

Khi dùng Fargate `awsvpc`, bạn cấu hình `assignPublicIp`:
- Task trong **public subnet** + `assignPublicIp=ENABLED` → có public IP, ra internet trực tiếp (kéo được image ECR công khai).
- Task trong **private subnet** → cần **NAT Gateway** để ra internet, hoặc **VPC Endpoint** (Interface endpoint cho ECR/ECR-API + Gateway endpoint S3 cho layer + endpoint cho Secrets Manager/Logs) để pull image mà không qua internet (chi tiết VPC Endpoint ở Chương 11).

> 💡 **Exam Tip:** Fargate task ở **private subnet** không pull được image / không lấy được secret → thiếu **NAT Gateway** hoặc **VPC Interface Endpoints** (ecr.api, ecr.dkr, logs, secretsmanager) + **S3 Gateway Endpoint** (ECR lưu layer trên S3). Với `awsvpc`, security group gắn vào **task** chứ không phải host.

## 17.5 Tích hợp ALB & dynamic port mapping

Service ECS thường đứng sau một **Application Load Balancer** (chi tiết ALB ở Chương 6). ECS tự đăng ký/huỷ đăng ký task vào **target group** khi scale, và dùng health check của target group để quyết định task có healthy không.

Hai mô hình target group phụ thuộc networking mode:

- **awsvpc** (Fargate hoặc EC2 awsvpc): target group type = **`ip`**. ECS đăng ký **private IP của ENI** từng task vào target group. Mỗi task = một target IP, dùng đúng `containerPort`. Không có khái niệm dynamic port ở đây — mỗi task có IP riêng nên cổng cố định cũng không đụng nhau.
- **bridge** (chỉ EC2): target group type = **`instance`**, và bật **dynamic port mapping**. Bạn đặt `hostPort = 0` trong port mapping → Docker chọn một **ephemeral host port ngẫu nhiên** cho mỗi task. Nhờ đó nhiều task của cùng service chạy được trên **cùng một EC2 instance** mà không đụng cổng. ECS đăng ký cặp (instance, hostPort động) vào target group. Phải mở security group của container instance cho **dải ephemeral port (mặc định 32768–65535)** từ ALB.

```json
// EC2 bridge mode — dynamic port mapping: hostPort = 0
"portMappings": [{ "containerPort": 8080, "hostPort": 0, "protocol": "tcp" }]
```

```bash
# Tạo service gắn ALB target group (Fargate, target type ip)
aws ecs create-service \
  --cluster my-cluster \
  --service-name my-api \
  --task-definition my-app:3 \
  --desired-count 3 \
  --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[subnet-aaa,subnet-bbb],securityGroups=[sg-task],assignPublicIp=DISABLED}' \
  --load-balancers 'targetGroupArn=arn:aws:elasticloadbalancing:...:targetgroup/my-tg/abc,containerName=api,containerPort=8080' \
  --health-check-grace-period-seconds 60
```

`health-check-grace-period-seconds` rất hay thi: khoảng thời gian ECS **bỏ qua** ALB health check sau khi task khởi động, để app kịp warm-up. Nếu app cần 45s để start mà grace period = 0, ALB sẽ báo unhealthy → ECS kill task → lặp vô tận (crash loop).

> 💡 **Exam Tip:** Muốn chạy **nhiều task cùng cổng trên một EC2 instance** sau ALB → dùng **bridge mode + dynamic port mapping** (`hostPort=0`), target type `instance`. Với Fargate/awsvpc thì target type là **`ip`**. Task cứ bị kill ngay sau khi start dù app ổn → tăng **health check grace period** cho app kịp warm-up.

## 17.6 Service Auto Scaling

ECS Service Auto Scaling chỉnh **desired count** của service tự động, dùng **Application Auto Scaling** (cùng engine với DynamoDB, Aurora...). Đừng nhầm với scaling số **EC2 instance** (đó là ASG / Capacity Provider — xem 17.9). Service scaling scale **số task**.

Ba kiểu policy:

- **Target Tracking** (phổ biến nhất): chọn một metric mục tiêu, ECS tự thêm/bớt task để giữ metric quanh giá trị target. Metric dựng sẵn:
  - `ECSServiceAverageCPUUtilization`
  - `ECSServiceAverageMemoryUtilization`
  - `ALBRequestCountPerTarget` (số request mỗi target — scale theo lưu lượng, mượt nhất cho web).
- **Step Scaling**: dựa trên CloudWatch alarm, scale theo bậc tuỳ mức vượt ngưỡng.
- **Scheduled Scaling**: scale theo lịch (ví dụ tăng task giờ cao điểm).

```bash
# 1) Đăng ký service làm scalable target (min 2, max 10 task)
aws application-autoscaling register-scalable-target \
  --service-namespace ecs \
  --resource-id service/my-cluster/my-api \
  --scalable-dimension ecs:service:DesiredCount \
  --min-capacity 2 --max-capacity 10

# 2) Target tracking giữ CPU trung bình ~60%
aws application-autoscaling put-scaling-policy \
  --service-namespace ecs \
  --resource-id service/my-cluster/my-api \
  --scalable-dimension ecs:service:DesiredCount \
  --policy-name cpu60 \
  --policy-type TargetTrackingScaling \
  --target-tracking-scaling-policy-configuration '{
    "TargetValue": 60.0,
    "PredefinedMetricSpecification": {"PredefinedMetricType": "ECSServiceAverageCPUUtilization"},
    "ScaleOutCooldown": 60, "ScaleInCooldown": 120
  }'
```

`ScaleInCooldown` thường để dài hơn `ScaleOutCooldown`: scale-out nhanh để chịu tải, scale-in chậm để tránh "flapping" (lên xuống liên tục).

> 💡 **Exam Tip:** Scale **số task** = ECS Service Auto Scaling (Application Auto Scaling), metric `ECSServiceAverageCPUUtilization` / `ECSServiceAverageMemoryUtilization` / `ALBRequestCountPerTarget`. Scale **số EC2 host** trong cluster = **Cluster Auto Scaling qua Capacity Provider** (gắn ASG). Đề mô tả "spiky web traffic, scale theo số request" → target tracking trên `ALBRequestCountPerTarget`.

## 17.7 Environment variables & secrets trong task definition

Có ba cách đưa cấu hình vào container:

1. **`environment`**: cặp name/value **plaintext** ngay trong task definition. Dùng cho cấu hình không nhạy cảm (`LOG_LEVEL`, `REGION`). Nhược điểm: lộ trong console/`describe-task-definition`.
2. **`environmentFiles`**: trỏ tới file `.env` đặt trên **S3** — gom nhiều biến vào một file, container đọc lúc start (execution role cần `s3:GetObject`).
3. **`secrets`**: inject **bí mật** từ **Secrets Manager** hoặc **SSM Parameter Store** vào biến môi trường. Bạn khai `valueFrom` = ARN của secret/parameter. **ECS agent** (qua **execution role**) đọc giá trị lúc start và set vào env của container. Giá trị **không hiện** trong task definition — chỉ thấy ARN. Đây là cách đúng cho password/API key (chi tiết Secrets Manager & Parameter Store ở Chương 47).

```json
"secrets": [
  { "name": "DB_PASSWORD",
    "valueFrom": "arn:aws:secretsmanager:us-east-1:111122223333:secret:prod/db-AbC123" },
  { "name": "API_KEY",
    "valueFrom": "arn:aws:ssm:us-east-1:111122223333:parameter/prod/api-key" }
]
```

Với Secrets Manager bạn có thể lấy **một key cụ thể trong JSON** bằng cú pháp `secret-arn:json-key::` — ví dụ `...:secret:prod/db-AbC123:password::`. Lưu ý: secret chỉ được resolve **lúc task start**; nếu xoay (rotate) secret, task đang chạy vẫn giữ giá trị cũ cho tới khi được thay (deploy lại / task mới).

> 💡 **Exam Tip:** Truyền password/API key vào container → dùng **`secrets`** với `valueFrom` (Secrets Manager hoặc SSM), và **Task Execution Role** phải có `secretsmanager:GetSecretValue` hoặc `ssm:GetParameters` (+ `kms:Decrypt` nếu mã hoá bằng CMK). **Không** đặt secret trong `environment` plaintext, **không** nhúng vào image. Secret được resolve một lần lúc start — rotate xong phải deploy lại để container nhận giá trị mới.

## 17.8 ECS + EFS cho persistent storage

Container vốn **ephemeral** — ghi vào filesystem container, task chết là mất. Fargate có ephemeral storage (mặc định 20GB, cấu hình tới 200GB) nhưng vẫn mất khi task dừng. Để dữ liệu **bền vững và chia sẻ giữa các task/AZ**, gắn **Amazon EFS** (chi tiết EFS ở Chương 5).

EFS là NFS đa-AZ, nhiều task ở các AZ khác nhau mount cùng một volume → đọc/ghi chung. Phù hợp: nội dung CMS, shared config, ML model dùng chung. Cấu hình trong task definition qua `volumes` (kiểu `efsVolumeConfiguration`) và `mountPoints` trong container:

```json
"volumes": [{
  "name": "shared-data",
  "efsVolumeConfiguration": {
    "fileSystemId": "fs-0123456789abcdef0",
    "transitEncryption": "ENABLED",
    "authorizationConfig": { "accessPointId": "fsap-0abc", "iam": "ENABLED" }
  }
}],
"containerDefinitions": [{
  "name": "api",
  "image": "...",
  "mountPoints": [{ "sourceVolume": "shared-data", "containerPath": "/data" }]
}]
```

Quan trọng: **Fargate hỗ trợ EFS** (Fargate platform version ≥ 1.4.0). Security group của EFS mount target phải cho phép NFS (TCP **2049**) từ security group của task. Dùng **EFS Access Point** + `iam: ENABLED` để kiểm soát truy cập theo POSIX user và path.

> 💡 **Exam Tip:** Cần storage **bền vững, chia sẻ giữa nhiều container/AZ** cho ECS (kể cả Fargate) → **EFS** (Fargate cần platform version 1.4+). Cần block storage gắn 1 task → EBS volume gắn ECS (hỗ trợ gần đây). EFS mount fail → kiểm tra security group cho **port 2049 (NFS)** và `transitEncryption`. Ephemeral storage của Fargate **mất khi task dừng** — không dùng cho dữ liệu cần giữ.

## 17.9 Rolling update, deployment circuit breaker & capacity providers

**Deployment types** của ECS service:

- **Rolling update** (`ECS` controller, mặc định): ECS thay task cũ bằng task mới theo từng đợt, điều khiển bởi hai tham số: **`minimumHealthyPercent`** (tối thiểu % task phải healthy trong lúc deploy — thường 100) và **`maximumPercent`** (trần % task chạy đồng thời — thường 200). Ví dụ desired=4, min=100%, max=200% → ECS có thể tạm chạy tới 8 task để thay cuốn chiếu mà không tụt dưới 4 task healthy.
- **Blue/Green** (qua **CodeDeploy** controller): tạo task set mới song song, dịch traffic dần (canary/linear/all-at-once), rollback nhanh (chi tiết CodeDeploy ở Chương 41).
- **External**: bạn tự điều khiển bằng third-party.

**Deployment Circuit Breaker** (cho rolling update): nếu deployment có quá nhiều task mới fail (không đạt healthy), ECS **tự dừng deployment** và (nếu bật `rollback: true`) **tự rollback** về revision ổn định trước đó. Tránh tình huống deploy bản lỗi rồi service chết hàng loạt.

```bash
aws ecs update-service \
  --cluster my-cluster --service my-api \
  --task-definition my-app:4 \
  --deployment-configuration '{
    "minimumHealthyPercent": 100, "maximumPercent": 200,
    "deploymentCircuitBreaker": { "enable": true, "rollback": true }
  }'
```

**Capacity Providers**: trừu tượng hoá nguồn compute cho cluster. Với EC2, capacity provider gắn một **ASG** và bật **Managed Scaling** — ECS tự tăng/giảm số EC2 host theo nhu cầu task (Cluster Auto Scaling), không để task "PROVISIONING" mãi vì thiếu host. Với serverless có hai provider dựng sẵn: **`FARGATE`** và **`FARGATE_SPOT`** (rẻ hơn ~70% nhưng có thể bị thu hồi với 2 phút cảnh báo — dùng cho workload chịu gián đoạn). **Capacity Provider Strategy** cho phép trộn tỉ lệ, ví dụ "1 task FARGATE base + còn lại 80% FARGATE_SPOT".

> 💡 **Exam Tip:** Tự rollback khi deploy bản lỗi mà không dùng CodeDeploy → bật **Deployment Circuit Breaker** với `rollback: true` (cho rolling update). Cần blue/green dịch traffic theo canary/linear cho ECS → dùng **CodeDeploy**. Giảm chi phí container chịu gián đoạn → **FARGATE_SPOT** trong capacity provider strategy. Scale số **host EC2** trong cluster → **Capacity Provider + Managed Scaling** (gắn ASG).

## 17.10 ECS Exec, logging & EKS (mức nhận diện)

**ECS Exec** cho phép bạn mở shell vào một container **đang chạy** mà **không cần SSH**, không cần mở cổng, không cần bastion — kể cả trên Fargate. Nó dùng **SSM Session Manager** bên dưới. Yêu cầu: bật `enableExecuteCommand` trên service/task, **Task Role** có quyền SSM (`ssmmessages:CreateControlChannel`, `CreateDataChannel`, `OpenControlChannel`, `OpenDataChannel`), và container chạy SSM agent binary (ECS tự inject).

```bash
# Bật exec khi tạo/update service
aws ecs update-service --cluster my-cluster --service my-api --enable-execute-command --force-new-deployment

# Vào shell một task đang chạy
aws ecs execute-command \
  --cluster my-cluster --task <task-id> \
  --container api --interactive --command "/bin/sh"
```

**Logging**: dùng log driver **`awslogs`** để đẩy stdout/stderr lên CloudWatch Logs (cần execution role quyền logs — xem 17.3). Cho pipeline log nâng cao (lọc, route nhiều đích) dùng **FireLens** (sidecar Fluent Bit/Fluentd) đẩy đi Kinesis Firehose/OpenSearch... (chi tiết CloudWatch Logs ở Chương 25).

**EKS (Elastic Kubernetes Service)** — mức nhận diện cho DVA-C02: dịch vụ Kubernetes managed. Dùng khi tổ chức đã chuẩn Kubernetes / cần hệ sinh thái K8s (Helm, operators) hoặc tính khả chuyển multi-cloud. Đổi lại vận hành phức tạp hơn ECS. EKS cũng chạy được trên Fargate. Đề DVA-C02 hiếm khi hỏi sâu EKS — chỉ cần biết ECS = orchestrator riêng của AWS, đơn giản hơn; EKS = Kubernetes managed.

> 💡 **Exam Tip:** Debug / vào shell container đang chạy (cả Fargate) **không SSH, không mở cổng** → **ECS Exec** (dùng SSM Session Manager; cần quyền SSM trên **Task Role** + `enableExecuteCommand`). Đẩy log container lên CloudWatch → log driver **`awslogs`** (execution role cần quyền logs). Cần xử lý/route log phức tạp → **FireLens**. "Đã chuẩn Kubernetes, muốn managed control plane" → **EKS**, còn lại ưu tiên **ECS/Fargate** cho "least operational overhead".

---

## Hands-on Lab: Deploy một service Node.js lên ECS Fargate sau ALB, bật auto scaling và ECS Exec

**Mục tiêu lab:** Từ một image đã có trên ECR (đã build ở Chương 16), bạn sẽ tạo task definition Fargate với `awsvpc` networking, đẩy service ra sau Application Load Balancer, cấu hình **task role** (quyền runtime cho app) tách biệt **execution role** (quyền cho ECS agent kéo image + ghi log), bật **service auto scaling** target tracking theo CPU, dùng **deployment circuit breaker** để tự rollback khi deploy hỏng, và cuối cùng `exec` vào container đang chạy để debug. Toàn bộ làm bằng AWS CLI v2 để hiểu rõ từng tài nguyên.

**Chuẩn bị:**
- AWS CLI v2 đã cấu hình (`aws sts get-caller-identity` trả về account của bạn).
- Một VPC mặc định có ≥2 public subnet (lab dùng `assignPublicIp=ENABLED` cho gọn; production nên đặt task ở private subnet + NAT — chi tiết VPC ở Chương 11).
- Một image đã push lên ECR. Trong lab này ta dùng image public `public.ecr.aws/docker/library/httpd:2.4` để khỏi phụ thuộc bước build, nhưng execution role vẫn cần để kéo image qua ECR endpoint và ghi log.
- Session Manager plugin cho ECS Exec: `session-manager-plugin --version` chạy được.

Đặt biến môi trường dùng chung:

```bash
export AWS_REGION=ap-southeast-1
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export VPC_ID=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text)
export SUBNETS=$(aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC_ID \
  --query 'Subnets[0:2].SubnetId' --output text | tr '\t' ',')
echo "VPC=$VPC_ID SUBNETS=$SUBNETS"
```

### Bước 1: Tạo execution role và task role

`ecsTaskExecutionRole` cho phép ECS agent kéo image từ ECR và đẩy log sang CloudWatch. AWS có managed policy `AmazonECSTaskExecutionRolePolicy` cho đúng mục đích này.

```bash
cat > trust.json <<'EOF'
{ "Version": "2012-10-17",
  "Statement": [{ "Effect": "Allow",
    "Principal": { "Service": "ecs-tasks.amazonaws.com" },
    "Action": "sts:AssumeRole" }] }
EOF

aws iam create-role --role-name ecsTaskExecutionRole-lab \
  --assume-role-policy-document file://trust.json
aws iam attach-role-policy --role-name ecsTaskExecutionRole-lab \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy

# Task role: quyền của CHÍNH ứng dụng khi chạy (ví dụ đọc 1 bucket). Tạo riêng dù lab chưa cần nhiều.
aws iam create-role --role-name ecsApp-task-role-lab \
  --assume-role-policy-document file://trust.json
# Cho phép ECS Exec hoạt động: task role cần quyền SSM messages
cat > exec-policy.json <<'EOF'
{ "Version": "2012-10-17",
  "Statement": [{ "Effect": "Allow",
    "Action": ["ssmmessages:CreateControlChannel","ssmmessages:CreateDataChannel",
               "ssmmessages:OpenControlChannel","ssmmessages:OpenDataChannel"],
    "Resource": "*" }] }
EOF
aws iam put-role-policy --role-name ecsApp-task-role-lab \
  --policy-name ecsExecSSM --policy-document file://exec-policy.json
```

> Trùng lặp hay gặp: nhét quyền ECR/log vào **task role** rồi thắc mắc sao image vẫn kéo được — vì ECR pull do **execution role** đảm nhiệm (xảy ra TRƯỚC khi container chạy), còn task role chỉ có hiệu lực bên trong process của app. ECS Exec lại cần quyền `ssmmessages:*` ở **task role** vì kênh điều khiển chạy bằng danh tính của container.

### Bước 2: Tạo log group, cluster và security group

```bash
aws logs create-log-group --log-group-name /ecs/lab-httpd

aws ecs create-cluster --cluster-name lab-cluster \
  --capacity-providers FARGATE FARGATE_SPOT \
  --default-capacity-provider-strategy capacityProvider=FARGATE,weight=1

# SG cho ALB: mở 80 từ internet
export ALB_SG=$(aws ec2 create-security-group --group-name lab-alb-sg \
  --description "ALB SG" --vpc-id $VPC_ID --query GroupId --output text)
aws ec2 authorize-security-group-ingress --group-id $ALB_SG \
  --protocol tcp --port 80 --cidr 0.0.0.0/0

# SG cho task: chỉ nhận traffic 80 TỪ ALB SG (không mở ra internet)
export TASK_SG=$(aws ec2 create-security-group --group-name lab-task-sg \
  --description "Task SG" --vpc-id $VPC_ID --query GroupId --output text)
aws ec2 authorize-security-group-ingress --group-id $TASK_SG \
  --protocol tcp --port 80 --source-group $ALB_SG
```

### Bước 3: Đăng ký task definition Fargate

```bash
cat > taskdef.json <<EOF
{
  "family": "lab-httpd",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "executionRoleArn": "arn:aws:iam::${ACCOUNT_ID}:role/ecsTaskExecutionRole-lab",
  "taskRoleArn": "arn:aws:iam::${ACCOUNT_ID}:role/ecsApp-task-role-lab",
  "containerDefinitions": [{
    "name": "web",
    "image": "public.ecr.aws/docker/library/httpd:2.4",
    "essential": true,
    "portMappings": [{ "containerPort": 80, "protocol": "tcp" }],
    "logConfiguration": {
      "logDriver": "awslogs",
      "options": {
        "awslogs-group": "/ecs/lab-httpd",
        "awslogs-region": "${AWS_REGION}",
        "awslogs-stream-prefix": "web"
      }
    }
  }]
}
EOF

aws ecs register-task-definition --cli-input-json file://taskdef.json
```

Output mong đợi: `taskDefinition.status = ACTIVE` và `revision: 1`. Lưu ý `cpu:"256"` = 0.25 vCPU, `memory:"512"` = 0.5 GB — đây là combo hợp lệ nhỏ nhất của Fargate (Fargate ép cặp cpu/memory theo bảng cố định; chọn sai cặp sẽ bị `ClientException` ngay khi register).

### Bước 4: Tạo ALB, target group (type ip) và listener

Với `awsvpc` mỗi task có ENI riêng và IP riêng, nên target group phải là **`target-type ip`**, KHÔNG phải `instance`.

```bash
export ALB_ARN=$(aws elbv2 create-load-balancer --name lab-alb \
  --subnets $(echo $SUBNETS | tr ',' ' ') --security-groups $ALB_SG \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text)

export TG_ARN=$(aws elbv2 create-target-group --name lab-tg \
  --protocol HTTP --port 80 --vpc-id $VPC_ID --target-type ip \
  --health-check-path / \
  --query 'TargetGroups[0].TargetGroupArn' --output text)

aws elbv2 create-listener --load-balancer-arn $ALB_ARN \
  --protocol HTTP --port 80 \
  --default-actions Type=forward,TargetGroupArn=$TG_ARN
```

### Bước 5: Tạo ECS service với circuit breaker và enable-execute-command

```bash
aws ecs create-service \
  --cluster lab-cluster \
  --service-name lab-svc \
  --task-definition lab-httpd \
  --desired-count 2 \
  --launch-type FARGATE \
  --enable-execute-command \
  --deployment-configuration "deploymentCircuitBreaker={enable=true,rollback=true},maximumPercent=200,minimumHealthyPercent=100" \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$TASK_SG],assignPublicIp=ENABLED}" \
  --load-balancers "targetGroupArn=$TG_ARN,containerName=web,containerPort=80" \
  --health-check-grace-period-seconds 60
```

Theo dõi tới khi `runningCount=2`:

```bash
aws ecs describe-services --cluster lab-cluster --services lab-svc \
  --query 'services[0].{desired:desiredCount,running:runningCount,deployments:deployments[0].rolloutState}'
```

Khi `rolloutState=COMPLETED`, lấy DNS của ALB và test:

```bash
export ALB_DNS=$(aws elbv2 describe-load-balancers --load-balancer-arns $ALB_ARN \
  --query 'LoadBalancers[0].DNSName' --output text)
curl -s http://$ALB_DNS/   # Output mong đợi: <html><body><h1>It works!</h1></body></html>
```

### Bước 6: Bật service auto scaling (target tracking theo CPU)

Auto scaling cho ECS dùng **Application Auto Scaling**, không phải ASG. Phải đăng ký scalable target rồi gắn policy.

```bash
aws application-autoscaling register-scalable-target \
  --service-namespace ecs \
  --resource-id service/lab-cluster/lab-svc \
  --scalable-dimension ecs:service:DesiredCount \
  --min-capacity 2 --max-capacity 6

cat > scaling.json <<'EOF'
{ "TargetValue": 50.0,
  "PredefinedMetricSpecification": { "PredefinedMetricType": "ECSServiceAverageCPUUtilization" },
  "ScaleInCooldown": 60, "ScaleOutCooldown": 60 }
EOF

aws application-autoscaling put-scaling-policy \
  --service-namespace ecs \
  --resource-id service/lab-cluster/lab-svc \
  --scalable-dimension ecs:service:DesiredCount \
  --policy-name cpu50 --policy-type TargetTrackingScaling \
  --target-tracking-scaling-policy-configuration file://scaling.json
```

`ECSServiceAverageCPUUtilization` giữ CPU trung bình toàn service quanh 50%. Predefined metric khác: `ECSServiceAverageMemoryUtilization` và `ALBRequestCountPerTarget` (cần `ResourceLabel` trỏ ALB + target group).

### Bước 7: ECS Exec vào container đang chạy

```bash
TASK_ARN=$(aws ecs list-tasks --cluster lab-cluster --service-name lab-svc \
  --query 'taskArns[0]' --output text)

aws ecs execute-command --cluster lab-cluster --task $TASK_ARN \
  --container web --interactive --command "/bin/sh"
```

Bạn sẽ vào shell trong container; thử `cat /proc/1/cgroup` để xác nhận đang ở trong container Fargate. Nếu báo lỗi `TargetNotConnected`, kiểm tra: (1) service tạo với `--enable-execute-command`, (2) task role có 4 quyền `ssmmessages:*`, (3) task đã restart sau khi bật flag. Đây đúng là checklist mà đề DVA hay gài.

### Dọn dẹp tài nguyên

Làm theo thứ tự ngược; service phải về 0 trước khi xoá.

```bash
aws application-autoscaling deregister-scalable-target --service-namespace ecs \
  --resource-id service/lab-cluster/lab-svc --scalable-dimension ecs:service:DesiredCount
aws ecs update-service --cluster lab-cluster --service lab-svc --desired-count 0
aws ecs delete-service --cluster lab-cluster --service lab-svc --force
aws elbv2 delete-listener --listener-arn \
  $(aws elbv2 describe-listeners --load-balancer-arn $ALB_ARN --query 'Listeners[0].ListenerArn' --output text)
aws elbv2 delete-load-balancer --load-balancer-arn $ALB_ARN
sleep 30   # chờ ALB giải phóng ENI khỏi SG
aws elbv2 delete-target-group --target-group-arn $TG_ARN
aws ecs delete-cluster --cluster lab-cluster
aws logs delete-log-group --log-group-name /ecs/lab-httpd
aws ec2 delete-security-group --group-id $TASK_SG
aws ec2 delete-security-group --group-id $ALB_SG
aws iam detach-role-policy --role-name ecsTaskExecutionRole-lab \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
aws iam delete-role --role-name ecsTaskExecutionRole-lab
aws iam delete-role-policy --role-name ecsApp-task-role-lab --policy-name ecsExecSSM
aws iam delete-role --role-name ecsApp-task-role-lab
```

> Bẫy dọn dẹp: xoá SG của task/ALB thường lỗi `DependencyViolation` vì ENI của ALB chưa giải phóng. Đợi vài chục giây sau khi xoá ALB rồi thử lại — đừng tạo SG mới chỉ vì lệnh đầu lỗi.

## 💡 Exam Tips chương 17

- **Task role vs execution role** là cặp gài bẫy số một: execution role để ECS agent **kéo image từ ECR + ghi CloudWatch Logs + lấy secret** lúc khởi động; task role là quyền của **chính ứng dụng** khi gọi AWS API (S3, DynamoDB...). Lỗi "không pull được image / không ghi log" → sửa execution role, không phải task role.
- Với network mode **`awsvpc`** (mặc định và bắt buộc của Fargate), mỗi task có ENI + IP riêng → target group phải `target-type ip`. Nhớ rằng `awsvpc` còn cho phép gắn Security Group cấp task.
- **Dynamic port mapping** (containerPort cố định, hostPort = 0) chỉ áp dụng cho **EC2 launch type với `bridge` network mode**, dùng ALB để chạy nhiều task cùng port trên một host. Fargate KHÔNG có khái niệm này.
- Khi đề hỏi "ít vận hành nhất / serverless containers / không quản lý EC2" → chọn **Fargate**. Khi cần GPU, instance type đặc thù, hoặc tối ưu chi phí ở quy mô lớn với Reserved/Spot tự quản → **EC2 launch type**.
- **Deployment circuit breaker** (`rollback=true`) tự phát hiện deploy hỏng (task không vào steady state) và rollback về revision tốt trước đó — đáp án cho "tự động hồi phục khi deploy lỗi" mà không cần CodeDeploy.
- **Secrets trong task definition:** dùng field `secrets` (valueFrom = ARN của Secrets Manager hoặc SSM Parameter Store) để inject thành env var; quyền đọc secret thuộc **execution role**. Dùng `environment` cho giá trị thường (không nhạy cảm).
- **ECS service auto scaling = Application Auto Scaling**, không phải EC2 Auto Scaling Group. Predefined metrics: `ECSServiceAverageCPUUtilization`, `ECSServiceAverageMemoryUtilization`, `ALBRequestCountPerTarget`.
- **Capacity provider** `FARGATE_SPOT` rẻ hơn nhưng task có thể bị thu hồi (báo trước 2 phút qua SIGTERM); dùng `base` và `weight` trong capacity provider strategy để trộn On-Demand + Spot.
- **ECS Exec** cần: `--enable-execute-command` trên service + task role có `ssmmessages:*` + Session Manager plugin. Không cần SSH, không mở port. Đây là cách debug container production.
- **ECS + EFS:** khai báo `volumes` (efsVolumeConfiguration) + `mountPoints` trong task definition để chia sẻ dữ liệu bền vững giữa các task/AZ — Fargate hỗ trợ EFS nhưng KHÔNG hỗ trợ Docker volume thường.
- `minimumHealthyPercent` và `maximumPercent` điều khiển rolling update: `100/200` nghĩa là giữ đủ task cũ chạy trong khi bung task mới (zero-downtime, tốn gấp đôi capacity tạm thời).
- Blue/green cho ECS không tự có trong rolling update — cần **CodeDeploy** với deployment controller `CODE_DEPLOY` (chi tiết ở Chương 41).

## Quiz chương 17 (10 câu)

**Câu 1.** Một service ECS Fargate báo lỗi `CannotPullContainerError` khi khởi động task. Developer cần sửa quyền ở đâu?
- A. Task role
- B. Execution role
- C. Service-linked role của ECS
- D. Instance profile của EC2

**Câu 2.** Ứng dụng chạy trên Fargate cần đọc một bucket S3 lúc runtime. Cấu hình đúng là gì?
- A. Thêm quyền `s3:GetObject` vào execution role
- B. Thêm quyền `s3:GetObject` vào task role
- C. Gắn instance profile có quyền S3 vào Fargate
- D. Nhúng access key vào biến môi trường của container

**Câu 3.** Đội muốn chạy nhiều task của cùng một service trên một EC2 container instance, tất cả listen port 8080, và route qua ALB. Cấu hình nào cho phép điều này?
- A. Fargate với awsvpc network mode
- B. EC2 launch type, bridge network mode, hostPort = 0 (dynamic port mapping)
- C. EC2 launch type, host network mode
- D. awsvpc với target-type instance

**Câu 4.** Một developer cần inject mật khẩu DB từ Secrets Manager vào container ECS dưới dạng biến môi trường, không hardcode. Cách đúng theo chuẩn AWS là gì?
- A. Dùng field `environment` với ARN của secret
- B. Dùng field `secrets` với `valueFrom` = ARN secret, cấp quyền đọc cho execution role
- C. Dùng `secrets` với `valueFrom` = ARN secret, cấp quyền đọc cho task role
- D. Gọi Secrets Manager trong entrypoint script bằng access key

**Câu 5.** Service ECS đôi khi deploy revision mới bị crash loop, gây gián đoạn. Đội muốn ECS tự rollback về revision tốt khi deploy thất bại, không thêm dịch vụ ngoài. Giải pháp?
- A. Cấu hình CodeDeploy blue/green
- B. Bật deployment circuit breaker với rollback=true
- C. Đặt minimumHealthyPercent = 0
- D. Tạo CloudWatch alarm và xoá service thủ công khi báo động

**Câu 6.** Một service Fargate cần scale theo số request mỗi task nhận sau ALB. Predefined metric nào phù hợp cho target tracking?
- A. ECSServiceAverageCPUUtilization
- B. ALBRequestCountPerTarget
- C. RequestCount của ALB
- D. RunningTaskCount

**Câu 7.** Developer cần debug một container Fargate production: xem file cấu hình và chạy lệnh bên trong, nhưng chính sách bảo mật cấm mở cổng SSH. Cách nào đúng?
- A. Bật ECS Exec (`enable-execute-command`) và dùng `aws ecs execute-command`
- B. Gắn key pair cho task và SSH vào IP của ENI
- C. Dùng EC2 Instance Connect
- D. Bật SSM Agent thủ công trong Dockerfile và Start Session tới instance

**Câu 8.** Công ty muốn giảm chi phí cho một batch worker chạy trên ECS, chấp nhận task có thể bị gián đoạn và tự chạy lại. Lựa chọn nào tối ưu chi phí nhất?
- A. Fargate On-Demand
- B. Capacity provider FARGATE_SPOT
- C. EC2 launch type với Reserved Instances
- D. Tăng cpu/memory để chạy nhanh hơn

**Câu 9.** Hai task của cùng service cần ghi/đọc chung một thư mục dữ liệu bền vững, truy cập được từ nhiều AZ. Trên Fargate nên dùng gì?
- A. Instance store
- B. Docker volume local
- C. EFS volume khai báo trong task definition
- D. EBS gắn multi-attach vào các task

**Câu 10.** Trong rolling update, service ECS (desired=4) cấu hình `minimumHealthyPercent=100`, `maximumPercent=200`. Điều gì xảy ra khi deploy revision mới?
- A. ECS dừng cả 4 task cũ rồi mới khởi động 4 task mới
- B. ECS giữ 4 task cũ, bung thêm tối đa 4 task mới, drain task cũ dần → không downtime
- C. ECS chỉ chạy 2 task trong suốt quá trình deploy
- D. Deploy bị từ chối vì cấu hình không hợp lệ

### Đáp án & giải thích

**Câu 1 — Đáp án B.** `CannotPullContainerError` xảy ra ở giai đoạn ECS agent kéo image — việc này do **execution role** đảm nhiệm (cần `AmazonECSTaskExecutionRolePolicy` để gọi ECR + ghi log). A sai vì task role chỉ có hiệu lực sau khi container đã chạy, không liên quan pull image. C sai vì service-linked role quản lý vòng đời service (ENI, scaling), không pull image. D sai vì Fargate không có EC2 instance/instance profile.

**Câu 2 — Đáp án B.** Quyền runtime của ứng dụng (gọi S3) nằm ở **task role** — credentials được cấp qua task metadata endpoint cho process trong container. A sai vì execution role chỉ dùng lúc khởi động (pull image, log, secret), app không mượn được. C sai vì Fargate không có instance profile. D sai hoàn toàn về bảo mật: hardcode access key là anti-pattern, dễ lộ và không xoay vòng được.

**Câu 3 — Đáp án B.** Chạy nhiều task cùng container port trên một EC2 host cần **dynamic port mapping**: `bridge` network mode + hostPort=0 để ECS gán port ngẫu nhiên trên host, ALB route tới port động đó qua target group. A và D sai vì awsvpc cấp mỗi task một ENI/IP riêng — không có khái niệm "nhiều task chung một host port", và awsvpc dùng target-type ip chứ không instance. C (host mode) bind trực tiếp port host nên không thể có hai task cùng port 8080 trên một host.

**Câu 4 — Đáp án B.** Chuẩn AWS: field **`secrets`** với `valueFrom` = ARN Secrets Manager/SSM, ECS tự fetch và inject thành env var lúc khởi động; quyền đọc secret cấp cho **execution role** vì việc fetch xảy ra trước khi container chạy. A sai vì `environment` chỉ nhận giá trị literal, không resolve ARN. C sai vì fetch secret là việc của execution role, không phải task role. D là anti-pattern (hardcode key).

**Câu 5 — Đáp án B.** **Deployment circuit breaker** với `rollback=true` phát hiện task mới không vào steady state và tự rollback về revision tốt — đúng yêu cầu "không thêm dịch vụ ngoài". A dùng được nhưng cần thêm CodeDeploy (thêm dịch vụ), trái yêu cầu. C sai và nguy hiểm: minimumHealthyPercent=0 cho phép dừng hết task cũ → tăng downtime, không rollback. D thủ công, không tự động, xoá service là phá hoại.

**Câu 6 — Đáp án B.** `ALBRequestCountPerTarget` đo số request chia đều mỗi target (task) — đúng tính chất "tỉ lệ theo từng task" mà target tracking cần (phải set ResourceLabel trỏ ALB + target group). A đo CPU, không phải request. C là tổng toàn ALB, thêm task không làm metric giảm tuyến tính nên không dùng làm predefined metric cho ECS target tracking. D không phải metric scaling hợp lệ.

**Câu 7 — Đáp án A.** **ECS Exec** mở kênh qua SSM Messages, cho `execute-command` chạy lệnh trong container mà không cần mở cổng nào — đúng ràng buộc cấm SSH. B sai vì task Fargate không có key pair/SSH. C sai vì EC2 Instance Connect dành cho EC2 instance, không vào được container Fargate. D phức tạp, không cần thiết và Fargate không cho bạn SSH vào host.

**Câu 8 — Đáp án B.** Batch worker chấp nhận gián đoạn + tự retry là use case kinh điển của **FARGATE_SPOT** (rẻ hơn ~70%, báo trước 2 phút qua SIGTERM). A đắt hơn. C tối ưu cho tải ổn định dài hạn nhưng phải tự quản EC2 và cam kết — không phải "tối ưu nhất" cho workload gián đoạn được. D không giảm chi phí, thường còn tăng.

**Câu 9 — Đáp án C.** **EFS** là filesystem chia sẻ qua mạng, mount được từ nhiều task/nhiều AZ đồng thời — Fargate hỗ trợ EFS qua `efsVolumeConfiguration`. A (instance store) phù du và không có trên Fargate. B (Docker volume local) chỉ trong một task, không chia sẻ chéo. D sai vì Fargate không gắn EBS theo kiểu đó, và EBS multi-attach chỉ trong một AZ với io1/io2 (Chương 5), không hợp cho nhiều AZ.

**Câu 10 — Đáp án B.** `minimumHealthyPercent=100` buộc giữ đủ 4 task cũ chạy trong khi deploy; `maximumPercent=200` cho phép tổng tối đa 8 task → ECS bung 4 task mới, khi chúng healthy thì drain 4 task cũ — zero downtime, tốn gấp đôi capacity tạm thời. A là hành vi của minimumHealthyPercent=0. C mô tả cấu hình tiết kiệm (50/100) chứ không phải 100/200. D sai vì 100/200 là cấu hình hợp lệ và phổ biến nhất.

## Tóm tắt chương

- ECS gồm 4 khối: **cluster** (nhóm tài nguyên) → **task definition** (bản thiết kế bất biến, có revision) → **task** (instance đang chạy) → **service** (giữ desired count, gắn ALB, rolling update).
- **Fargate** = serverless containers, không quản EC2, trả tiền theo cpu/memory đã yêu cầu; **EC2 launch type** khi cần GPU, instance đặc thù, hoặc tối ưu chi phí tự quản. Từ khoá "least operational overhead" → Fargate.
- **Execution role** (kéo ECR, ghi log, fetch secret — chạy lúc khởi động) tách biệt **task role** (quyền AWS API của app lúc runtime) — đây là điểm thi bị gài nhiều nhất.
- Fargate bắt buộc **`awsvpc`**: mỗi task có ENI + IP + Security Group riêng → target group phải **`target-type ip`**.
- **Dynamic port mapping** (bridge + hostPort=0) chỉ tồn tại ở **EC2 launch type**, dùng chạy nhiều task cùng container port trên một host sau ALB; Fargate không có.
- **Service auto scaling** dùng **Application Auto Scaling** (register-scalable-target + scaling policy), predefined metrics: CPU, Memory, `ALBRequestCountPerTarget`.
- **Secrets** inject qua field `secrets` (valueFrom = ARN Secrets Manager/SSM), quyền đọc thuộc **execution role**; `environment` cho giá trị không nhạy cảm.
- **Deployment circuit breaker** (rollback=true) tự rollback khi deploy hỏng mà không cần CodeDeploy; blue/green ECS thật sự cần deployment controller `CODE_DEPLOY` (Chương 41).
- `minimumHealthyPercent` / `maximumPercent` điều khiển rolling update; 100/200 cho zero-downtime nhưng tốn gấp đôi capacity tạm thời.
- **ECS Exec** debug container không cần SSH: `--enable-execute-command` + task role có `ssmmessages:*` + Session Manager plugin.
- **Capacity providers** (FARGATE, FARGATE_SPOT, ASG-backed) với `base`/`weight` để trộn On-Demand và Spot; FARGATE_SPOT rẻ nhưng có thể bị thu hồi (SIGTERM, 2 phút).
- **ECS + EFS** cho dữ liệu bền vững, chia sẻ đa task/đa AZ; **EKS** chỉ cần nhận diện (Kubernetes managed) cho phạm vi DVA-C02.
