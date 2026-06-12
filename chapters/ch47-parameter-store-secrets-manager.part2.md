## Hands-on Lab: Quản lý cấu hình & secrets với Parameter Store và Secrets Manager (hierarchy, SecureString, rotation, dynamic references, đọc trong Lambda có cache)

**Mục tiêu lab:** Dựng một bộ cấu hình ứng dụng theo phân cấp trong SSM Parameter Store (String, StringList, SecureString mã hoá bằng KMS), gắn **parameter policy** hết hạn, đọc cả nhánh bằng `GetParametersByPath`. Sau đó tạo một secret trong Secrets Manager có **rotation tự động** (mô phỏng bằng cách rotate thủ công), bật **cross-region replication**, gắn **resource policy**. Cuối cùng viết một Lambda đọc cả tham số SSM lẫn secret đúng cách (cache trong execution environment), và minh hoạ **CloudFormation dynamic references** `{{resolve:ssm}}` / `{{resolve:secretsmanager}}`. Chi phí: Parameter Store standard tier miễn phí, advanced tier $0.05/tham số/tháng; Secrets Manager $0.40/secret/tháng + $0.05/10000 API call — xoá ngay sau lab thì chỉ vài cent.

**Chuẩn bị:**
- AWS CLI v2 (`aws --version` ra `aws-cli/2.x`), profile có quyền `ssm:*`, `secretsmanager:*`, `kms:*`, `lambda:*`, `iam:*`, `cloudformation:*`.
- Đặt biến tiện dùng: `REGION=ap-southeast-1`, `REPLICA=ap-southeast-2`, `ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)`.
- Node.js 18+ nếu muốn test code Lambda local (không bắt buộc cho lab).

### Bước 1: Tạo cấu hình phân cấp trong Parameter Store

Parameter Store dùng tên dạng đường dẫn (`/app/env/key`) để tổ chức thành cây. Tạo các tham số cho hai môi trường:

```bash
# String thường (config public)
aws ssm put-parameter --region $REGION \
  --name /myapp/dev/db/host --value "dev-db.internal" --type String

# StringList — danh sách phân tách bằng dấu phẩy
aws ssm put-parameter --region $REGION \
  --name /myapp/dev/feature/flags --value "beta,newui" --type StringList

# SecureString — mã hoá bằng KMS (mặc định dùng key alias/aws/ssm)
aws ssm put-parameter --region $REGION \
  --name /myapp/dev/db/password --value "S3cr3t-dev!" --type SecureString

# Tham số cho prod
aws ssm put-parameter --region $REGION \
  --name /myapp/prod/db/host --value "prod-db.internal" --type String
aws ssm put-parameter --region $REGION \
  --name /myapp/prod/db/password --value "S3cr3t-prod!" --type SecureString
```

Output mỗi lệnh:

```json
{ "Version": 1, "Tier": "Standard" }
```

> Bẫy thực tế: `put-parameter` mặc định **không ghi đè**. Sửa giá trị tham số đã có mà quên `--overwrite` sẽ báo `ParameterAlreadyExists`. Khi ghi đè, `Version` tăng lên — Parameter Store giữ tối đa 100 version lịch sử của mỗi tham số.

### Bước 2: Đọc cả nhánh với GetParametersByPath và giải mã SecureString

Sức mạnh của hierarchy là lấy toàn bộ cấu hình một môi trường trong một lệnh:

```bash
aws ssm get-parameters-by-path --region $REGION \
  --path /myapp/dev --recursive --with-decryption \
  --query 'Parameters[].{Name:Name,Value:Value,Type:Type}'
```

Output mong đợi (SecureString được giải mã nhờ `--with-decryption`):

```json
[
  { "Name": "/myapp/dev/db/host", "Value": "dev-db.internal", "Type": "String" },
  { "Name": "/myapp/dev/db/password", "Value": "S3cr3t-dev!", "Type": "SecureString" },
  { "Name": "/myapp/dev/feature/flags", "Value": "beta,newui", "Type": "StringList" }
]
```

> 💡 Quên `--with-decryption` thì SecureString trả về **ciphertext (chuỗi mã hoá), không phải plaintext** — đây là điểm DVA hay gài. Caller cũng cần quyền `kms:Decrypt` trên key đã mã hoá; thiếu sẽ báo `AccessDeniedException` dù có quyền `ssm:GetParameter`.

### Bước 3: Gắn parameter policy (cần advanced tier)

Parameter policies (expiration, expiration notification, no-change notification) **chỉ chạy trên advanced tier**. Chuyển một tham số lên advanced rồi gắn policy hết hạn sau 15 ngày:

```bash
aws ssm put-parameter --region $REGION \
  --name /myapp/dev/temp/token --value "tmp-123" --type SecureString \
  --tier Advanced --overwrite \
  --policies '[{"Type":"Expiration","Version":"1.0","Attributes":{"Timestamp":"2026-06-27T00:00:00.000Z"}}]'
```

Sau timestamp, Parameter Store sẽ tự xoá tham số. `ExpirationNotification` và `NoChangeNotification` phát sự kiện qua EventBridge để bạn cảnh báo trước. Advanced tier còn nâng giới hạn: value tối đa **8 KB** (standard chỉ 4 KB) và cho phép tới 100.000 tham số/account/region (standard 10.000).

### Bước 4: Tạo secret trong Secrets Manager với rotation và replication

Tạo secret kiểu key-value JSON, bật **replication sang region khác** ngay khi tạo:

```bash
aws secretsmanager create-secret --region $REGION \
  --name myapp/prod/db-credentials \
  --description "DB creds for prod" \
  --secret-string '{"username":"admin","password":"InitPass-001"}' \
  --add-replica-regions Region=$REPLICA
```

Output:

```json
{
  "ARN": "arn:aws:secretsmanager:ap-southeast-1:111122223333:secret:myapp/prod/db-credentials-AbCdEf",
  "Name": "myapp/prod/db-credentials",
  "ReplicationStatus": [{ "Region": "ap-southeast-2", "Status": "InProgress" }]
}
```

Đọc secret và lấy đúng một field bằng JMESPath:

```bash
aws secretsmanager get-secret-value --region $REGION \
  --secret-id myapp/prod/db-credentials \
  --query 'SecretString' --output text
```

Mô phỏng rotation thủ công bằng `put-secret-value` — mỗi lần ghi tạo một **version mới** gắn staging label `AWSCURRENT`, version cũ tự chuyển sang `AWSPREVIOUS`:

```bash
aws secretsmanager put-secret-value --region $REGION \
  --secret-id myapp/prod/db-credentials \
  --secret-string '{"username":"admin","password":"RotatedPass-002"}'
```

Trong production thật, bạn bật `rotate-secret` trỏ tới một **Lambda rotation function** (với RDS/Aurora/Redshift/DocumentDB dùng template rotation có sẵn của AWS). Lambda rotation chạy 4 bước: `createSecret → setSecret → testSecret → finishSecret`, thao tác trên các staging label `AWSPENDING`/`AWSCURRENT`/`AWSPREVIOUS`.

> 💡 Khác biệt nền tảng so với Parameter Store: **rotation tự động có sẵn (built-in) là đặc quyền của Secrets Manager**. Parameter Store không tự rotate. Câu hỏi "tự động xoay vòng credential database mỗi 30 ngày, ít vận hành nhất" → Secrets Manager managed rotation.

### Bước 5: Gắn resource policy cho secret (cross-account / siết truy cập)

Resource-based policy cho phép cấp quyền truy cập secret cho principal khác mà không cần đụng IAM của họ:

```bash
cat > secret-policy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "AWS": "arn:aws:iam::111122223333:role/AppRole" },
    "Action": "secretsmanager:GetSecretValue",
    "Resource": "*"
  }]
}
EOF

aws secretsmanager put-resource-policy --region $REGION \
  --secret-id myapp/prod/db-credentials \
  --resource-policy file://secret-policy.json \
  --block-public-policy
```

`--block-public-policy` chặn không cho gắn policy mở ra public (principal `*` không có điều kiện) — bật mặc định trong code an toàn.

### Bước 6: Lambda đọc parameter & secret đúng cách (cache trong execution environment)

Anti-pattern phổ biến: gọi `GetSecretValue`/`GetParameter` trong từng request → tốn tiền API, tăng latency, dễ bị throttle. Cách đúng: khởi tạo client và cache giá trị **ngoài handler** (trong init phase), tận dụng việc Lambda tái dùng execution environment.

```javascript
// index.mjs — AWS SDK for JavaScript v3
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const ssm = new SSMClient({});
const sm = new SecretsManagerClient({});

// Cache ngoài handler: chỉ fetch lần cold start, các lần warm dùng lại
let cachedConfig = null;

async function loadConfig() {
  if (cachedConfig) return cachedConfig;  // cache hit
  const p = await ssm.send(new GetParameterCommand({
    Name: "/myapp/prod/db/host"          // String thường
  }));
  const s = await sm.send(new GetSecretValueCommand({
    SecretId: "myapp/prod/db-credentials"
  }));
  const creds = JSON.parse(s.SecretString);
  cachedConfig = { dbHost: p.Parameter.Value, dbUser: creds.username };
  return cachedConfig;
}

export const handler = async () => {
  const cfg = await loadConfig();
  return { statusCode: 200, body: JSON.stringify(cfg) };
};
```

Triển khai nhanh bằng CLI (role tối thiểu cần `ssm:GetParameter`, `secretsmanager:GetSecretValue`, `kms:Decrypt` nếu SecureString):

```bash
cat > trust.json <<'EOF'
{ "Version": "2012-10-17", "Statement": [{ "Effect": "Allow",
  "Principal": { "Service": "lambda.amazonaws.com" }, "Action": "sts:AssumeRole" }] }
EOF
aws iam create-role --role-name myapp-cfg-role --assume-role-policy-document file://trust.json
aws iam attach-role-policy --role-name myapp-cfg-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam attach-role-policy --role-name myapp-cfg-role \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMReadOnlyAccess
aws iam attach-role-policy --role-name myapp-cfg-role \
  --policy-arn arn:aws:iam::aws:policy/SecretsManagerReadWrite

zip fn.zip index.mjs
sleep 10   # chờ role propagate
aws lambda create-function --region $REGION --function-name myapp-cfg \
  --runtime nodejs18.x --handler index.handler --zip-file fileb://fn.zip \
  --role arn:aws:iam::$ACCOUNT_ID:role/myapp-cfg-role
```

> 💡 Production nên dùng **AWS Parameters and Secrets Lambda Extension** thay vì SDK: extension chạy một HTTP layer cache cục bộ (localhost:2773), Lambda gọi `GET /systemsmanager/parameters/get?name=...` hoặc `/secretsmanager/get?secretId=...`, extension tự cache theo TTL (`SSM_PARAMETER_STORE_TTL`, `SECRETS_MANAGER_TTL`). Giảm số call ra AWS API → rẻ và nhanh hơn, không cần tự viết logic cache.

### Bước 7: CloudFormation dynamic references

Dynamic references để CloudFormation tự lấy giá trị từ Parameter Store/Secrets Manager lúc deploy, không hard-code secret vào template:

```yaml
Resources:
  MyDB:
    Type: AWS::RDS::DBInstance
    Properties:
      Engine: mysql
      DBInstanceClass: db.t3.micro
      AllocatedStorage: "20"
      # Lấy plaintext String từ SSM
      MasterUsername: '{{resolve:ssm:/myapp/prod/db/host:1}}'
      # Lấy field password từ secret JSON (KHÔNG hiện trong console/events)
      MasterUserPassword: '{{resolve:secretsmanager:myapp/prod/db-credentials:SecretString:password}}'
```

Cú pháp: `{{resolve:ssm:name:version}}` cho String (có `ssm-secure` cho SecureString nhưng chỉ một số resource hỗ trợ), và `{{resolve:secretsmanager:secret-id:SecretString:json-key:version-stage:version-id}}`. CloudFormation **không in giá trị resolve được ra Events/Console** cho secretsmanager — an toàn hơn nhập trực tiếp NoEcho parameter.

### Dọn dẹp tài nguyên

```bash
# Lambda + role
aws lambda delete-function --region $REGION --function-name myapp-cfg
for p in AWSLambdaBasicExecutionRole AmazonSSMReadOnlyAccess SecretsManagerReadWrite; do
  arn=$(echo $p | grep -q Basic && echo arn:aws:iam::aws:policy/service-role/$p || echo arn:aws:iam::aws:policy/$p)
  aws iam detach-role-policy --role-name myapp-cfg-role --policy-arn $arn 2>/dev/null; done
aws iam delete-role --role-name myapp-cfg-role

# Xoá toàn bộ tham số dưới /myapp (gồm cả advanced tier để ngừng tính phí)
for n in $(aws ssm get-parameters-by-path --region $REGION --path /myapp --recursive \
  --query 'Parameters[].Name' --output text); do
  aws ssm delete-parameter --region $REGION --name $n; done

# Secret: gỡ replica trước, rồi xoá (force để khỏi chờ recovery window 7-30 ngày)
aws secretsmanager remove-regions-from-replication --region $REGION \
  --secret-id myapp/prod/db-credentials --remove-replica-regions $REPLICA
aws secretsmanager delete-secret --region $REGION \
  --secret-id myapp/prod/db-credentials --force-delete-without-recovery
```

> Bẫy chi phí: secret **advanced parameter** và **secret chưa xoá** vẫn tính phí theo tháng (tính theo ngày). Secrets Manager mặc định có recovery window 7–30 ngày — secret vẫn tính phí trong thời gian này nếu không `--force-delete-without-recovery`. Kiểm tra Billing sau 24h.

## 💡 Exam Tips chương 47

- **Parameter Store vs Secrets Manager — bảng quyết định kinh điển:** cần rotation tự động built-in, cross-region replication có sẵn, resource policy → **Secrets Manager** ($0.40/secret/tháng). Chỉ cần lưu config/string, ưu tiên miễn phí, không cần rotation → **Parameter Store standard** (free). Từ khoá "automatically rotate database credentials with least effort" → Secrets Manager.
- **SecureString cần `--with-decryption` để lấy plaintext.** Thiếu cờ này trả về ciphertext. Caller còn phải có quyền `kms:Decrypt` trên key đã mã hoá — thiếu thì `AccessDeniedException` dù có `ssm:GetParameter`.
- **Standard tier: tối đa 10.000 tham số/region, value 4 KB, miễn phí, không parameter policy.** Advanced tier: 100.000 tham số, value 8 KB, $0.05/tham số/tháng, hỗ trợ parameter policies (Expiration, ExpirationNotification, NoChangeNotification).
- **Parameter Store có throughput mặc định 40 TPS** cho Get; bật "higher throughput" (tính phí) lên 10.000 TPS cho ứng dụng đọc nhiều. Đề hỏi "GetParameter bị throttle" → bật higher throughput hoặc cache.
- **`GetParametersByPath`** lấy cả nhánh (dùng `--recursive` để xuống nhánh con); là cách chuẩn nạp toàn bộ config một môi trường. `GetParameters` (số nhiều, không Path) lấy tối đa 10 tham số theo tên cụ thể.
- **Secret rotation Lambda 4 bước:** createSecret → setSecret → testSecret → finishSecret, thao tác trên staging label AWSPENDING → AWSCURRENT (cũ thành AWSPREVIOUS). RDS/Aurora/Redshift/DocumentDB có rotation template AWS dựng sẵn; DB khác hoặc API key tự dùng custom Lambda.
- **CloudFormation dynamic reference:** `{{resolve:ssm:name:version}}` (String), `{{resolve:ssm-secure:...}}` (SecureString, chỉ vài resource hỗ trợ), `{{resolve:secretsmanager:id:SecretString:key:stage:id}}`. CFN không in giá trị secretsmanager ra Events/Console — dùng để tránh hard-code secret.
- **ECS task definition** lấy secret qua `secrets` (không phải `environment`): trỏ `valueFrom` tới ARN của SSM parameter hoặc Secrets Manager secret; **execution role** (không phải task role) cần quyền đọc. CodeBuild buildspec dùng khối `env.parameter-store`/`env.secrets-manager` (chi tiết ở Chương 40).
- **Public parameters** (`/aws/service/...`, ví dụ AMI ID Amazon Linux mới nhất, region list) miễn phí, đọc qua `GetParameter`; dùng làm `AWS::SSM::Parameter::Value<...>` type trong CloudFormation để luôn lấy AMI mới nhất.
- **Cache secret trong code đúng cách:** khởi tạo và lưu giá trị ngoài handler (init phase), hoặc dùng **Parameters and Secrets Lambda Extension** (localhost:2773, TTL cấu hình được). Không gọi GetSecretValue mỗi request — tốn tiền và dễ throttle.
- **Secrets Manager mặc định mã hoá bằng KMS** (`aws/secretsmanager` hoặc CMK của bạn); mọi version đều mã hoá. Cross-region replica có thể dùng KMS key riêng ở region đích.
- **Recovery window 7–30 ngày** khi xoá secret (mặc định 30); secret vẫn tính phí trong thời gian này. `--force-delete-without-recovery` xoá ngay, không khôi phục được.

## Quiz chương 47 (10 câu)

**Câu 1.** A developer needs to store the master password for an Amazon RDS database and automatically rotate it every 30 days with the least operational overhead. Which solution is best?
- A. SSM Parameter Store SecureString với một EventBridge rule gọi Lambda tự viết để rotate
- B. AWS Secrets Manager với managed rotation cho RDS
- C. Lưu password trong biến môi trường Lambda mã hoá bằng KMS
- D. SSM Parameter Store advanced tier với parameter policy Expiration

**Câu 2.** Một developer chạy `aws ssm get-parameter --name /app/db/pass` cho một tham số kiểu SecureString nhưng nhận về một chuỗi mã hoá thay vì plaintext. Nguyên nhân?
- A. Tham số bị hỏng, cần tạo lại
- B. Thiếu cờ `--with-decryption`
- C. Phải dùng `get-parameters-by-path`
- D. KMS key đã bị xoá

**Câu 3.** Ứng dụng cần nạp ~25 tham số cấu hình thuộc cùng môi trường `/prod` trong một lời gọi. API nào phù hợp nhất?
- A. `GetParameter` gọi 25 lần
- B. `GetParameters` với 25 tên
- C. `GetParametersByPath --path /prod --recursive`
- D. `DescribeParameters`

**Câu 4.** Team muốn dùng cùng một password được lưu trong Secrets Manager ở region us-east-1 cho một ứng dụng DR chạy ở eu-west-1, không phải tự đồng bộ thủ công. Cách đúng?
- A. Bật cross-region replication cho secret
- B. Tạo lại secret thủ công ở eu-west-1
- C. Dùng Parameter Store advanced tier
- D. Bật KMS multi-region key là đủ

**Câu 5.** A developer needs a Lambda function to read a config value from Parameter Store without calling the SSM API on every invocation, minimizing cost and latency. What is the recommended approach?
- A. Gọi GetParameter trong handler mỗi request
- B. Dùng AWS Parameters and Secrets Lambda Extension với TTL cache
- C. Hard-code giá trị vào code
- D. Lưu giá trị vào /tmp mỗi request

**Câu 6.** Trong một CloudFormation template, làm sao tham chiếu field `password` của một secret JSON trong Secrets Manager để gán cho `MasterUserPassword` của RDS mà không lộ giá trị trong stack events?
- A. `!Ref MySecret`
- B. `{{resolve:secretsmanager:myapp/db:SecretString:password}}`
- C. `{{resolve:ssm:myapp/db}}`
- D. Nhập trực tiếp password vào template

**Câu 7.** Một tham số SecureString trong Parameter Store cần tự động bị xoá sau 90 ngày. Cấu hình nào đáp ứng?
- A. Gắn parameter policy Expiration (cần advanced tier)
- B. Đặt TTL trong standard tier
- C. Tạo CloudWatch alarm xoá tham số
- D. Bật versioning với giới hạn 90 ngày

**Câu 8.** Một ECS task không khởi động được, log báo không lấy được giá trị từ Secrets Manager khai trong `secrets` của task definition. IAM thay đổi nào sửa lỗi?
- A. Thêm quyền `secretsmanager:GetSecretValue` vào **task role**
- B. Thêm quyền `secretsmanager:GetSecretValue` vào **execution role**
- C. Bật `--block-public-policy` cho secret
- D. Gắn AdministratorAccess cho cluster

**Câu 9.** Ứng dụng đọc nhiều khiến `GetParameter` của Parameter Store bị throttle ở mức ~40 TPS. Giải pháp ít thay đổi code nhất, đúng theo AWS?
- A. Chuyển toàn bộ sang Secrets Manager
- B. Bật higher throughput cho Parameter Store (tính phí) và/hoặc cache phía client
- C. Tạo nhiều tham số trùng để chia tải
- D. Đổi sang advanced tier sẽ tự hết throttle

**Câu 10.** A developer wants CloudFormation to always launch EC2 with the latest Amazon Linux 2 AMI ID without hard-coding it. Which approach uses Parameter Store?
- A. Tạo SecureString chứa AMI ID và rotate hàng ngày
- B. Dùng parameter type `AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>` trỏ tới public parameter `/aws/service/ami-amazon-linux-latest/...`
- C. Hard-code AMI ID rồi cập nhật template thủ công
- D. Lưu AMI ID vào Secrets Manager

### Đáp án & giải thích

**Câu 1 — Đáp án B.** Secrets Manager có **managed rotation** dựng sẵn cho RDS — bật một lần, AWS lo Lambda rotation 4 bước, ít vận hành nhất. A phải tự viết và bảo trì Lambda rotation (nhiều việc hơn). C biến môi trường Lambda không rotate được và không phù hợp cho DB master password dùng chung. D parameter policy Expiration chỉ **xoá** tham số, không **rotate** credential.

**Câu 2 — Đáp án B.** SecureString cần `--with-decryption` mới trả plaintext; thiếu cờ → ciphertext. A sai, tham số không hỏng. C `get-parameters-by-path` cũng cần `--with-decryption`, đổi API không giải vấn đề. D nếu key bị xoá sẽ báo lỗi decrypt chứ không trả ciphertext im lặng.

**Câu 3 — Đáp án C.** `GetParametersByPath` lấy cả nhánh trong một call, đúng cho việc nạp config theo môi trường; `--recursive` để xuống nhánh con. A tốn 25 call và dễ throttle. B `GetParameters` giới hạn **10 tên** mỗi call nên 25 tham số không vừa. D `DescribeParameters` chỉ trả metadata, không trả value.

**Câu 4 — Đáp án A.** Cross-region replication của Secrets Manager tự đồng bộ secret (gồm cả rotation) sang region khác — chuẩn cho DR. B thủ công, dễ lệch. C Parameter Store không có replication built-in. D multi-region KMS key chỉ giải bài toán mã hoá, không sao chép bản thân secret giữa các region.

**Câu 5 — Đáp án B.** Parameters and Secrets Lambda Extension cung cấp HTTP cache cục bộ (localhost:2773) với TTL cấu hình được, giảm call API → rẻ và nhanh, không cần tự viết cache. A gọi mỗi request tốn tiền và latency. C hard-code mất tính linh hoạt và rủi ro khi giá trị đổi. D /tmp mỗi request vẫn phải gọi API lần đầu mỗi container và không có cơ chế TTL chuẩn.

**Câu 6 — Đáp án B.** Dynamic reference `{{resolve:secretsmanager:id:SecretString:key}}` lấy đúng field JSON và CloudFormation **không in giá trị ra events/console**. A `!Ref` một secret trả về ARN, không phải password. C `ssm` resolve từ Parameter Store, sai nguồn. D nhập trực tiếp lộ secret trong template.

**Câu 7 — Đáp án A.** Parameter policy `Expiration` tự xoá tham số sau timestamp — nhưng **chỉ chạy trên advanced tier**. B standard tier không có TTL/policy. C alarm không xoá tham số được trực tiếp và là cách vòng vo. D versioning giữ lịch sử chứ không hết hạn theo thời gian.

**Câu 8 — Đáp án B.** Trong ECS, khối `secrets` của task definition được **execution role** (vai trò để ECS agent kéo image và nạp secret/env) đọc, không phải task role (vai trò code chạy trong container dùng). A sửa sai role. C `--block-public-policy` không liên quan quyền đọc của task. D AdministratorAccess thừa quyền và sai đối tượng (gắn cho cluster không có nghĩa).

**Câu 9 — Đáp án B.** Parameter Store mặc định 40 TPS; bật **higher throughput** (tính phí) lên tới 10.000 TPS và/hoặc cache phía client là giải pháp đúng, ít thay đổi code. A chuyển sang Secrets Manager tốn tiền và không cần thiết. C tạo tham số trùng là hack bẩn, khó bảo trì. D advanced tier nâng số lượng/size tham số, **không** tự tăng throughput.

**Câu 10 — Đáp án B.** Dùng parameter type `AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>` trỏ tới public parameter AMI mới nhất, CloudFormation tự resolve AMI ID hiện hành lúc deploy. A/D dùng SecureString/Secrets Manager cho AMI ID là sai mục đích và tốn phí. C hard-code đúng thứ AWS muốn ta tránh.

## Tóm tắt chương

- **Parameter Store** lưu config & secret dạng String, StringList, SecureString (mã hoá KMS); standard tier miễn phí, 10.000 tham số/region, value 4 KB, throughput 40 TPS (bật higher throughput lên 10.000 TPS có phí).
- **Advanced tier** ($0.05/tham số/tháng) nâng lên 100.000 tham số, value 8 KB và mở khoá **parameter policies**: Expiration, ExpirationNotification, NoChangeNotification.
- **SecureString cần `--with-decryption`** để lấy plaintext, và caller phải có `kms:Decrypt`; quên là trả ciphertext hoặc AccessDenied — bẫy kinh điển.
- **Hierarchy + `GetParametersByPath --recursive`** là cách chuẩn tổ chức và nạp cả cây cấu hình theo môi trường; `GetParameters` (số nhiều) tối đa 10 tên/call.
- **Secrets Manager** tốn $0.40/secret/tháng nhưng đổi lại: **rotation tự động built-in** (managed cho RDS/Aurora/Redshift/DocumentDB, custom Lambda cho phần còn lại), **cross-region replication**, và **resource policy**.
- **Rotation Lambda 4 bước:** createSecret → setSecret → testSecret → finishSecret, vần các staging label AWSPENDING/AWSCURRENT/AWSPREVIOUS.
- **Bảng quyết định:** cần rotation/replication/resource policy → Secrets Manager; chỉ lưu config, ưu tiên miễn phí → Parameter Store. Đề thi bám từ khoá "automatically rotate", "least operational overhead".
- **CloudFormation dynamic references** `{{resolve:ssm:...}}`, `{{resolve:ssm-secure:...}}`, `{{resolve:secretsmanager:...}}` lấy giá trị lúc deploy; secretsmanager không lộ ra events/console.
- **Đọc secret/parameter đúng cách:** cache ngoài handler (init phase) hoặc dùng **Parameters and Secrets Lambda Extension** (localhost:2773, TTL cache) — không gọi API mỗi request.
- **ECS** lấy secret qua khối `secrets`/`valueFrom`, đọc bằng **execution role**; CodeBuild dùng `env.parameter-store`/`env.secrets-manager` (Chương 40).
- **Public parameters** (`/aws/service/...`) miễn phí, dùng `AWS::SSM::Parameter::Value<...>` để luôn lấy AMI/giá trị AWS mới nhất trong CloudFormation.
- **Xoá secret có recovery window 7–30 ngày** (vẫn tính phí); dùng `--force-delete-without-recovery` để xoá ngay. Advanced parameter và secret chưa xoá vẫn phát sinh phí theo ngày.
