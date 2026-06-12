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
