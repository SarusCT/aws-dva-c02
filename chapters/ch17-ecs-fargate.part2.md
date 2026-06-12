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
