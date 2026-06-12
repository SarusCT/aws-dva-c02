# Chương 47: SSM Parameter Store & AWS Secrets Manager

> **Trọng tâm DVA-C02:** Đây là chương "Security" kinh điển — đề thi luôn có vài câu dạng "lưu config/secret ở đâu cho đúng và rẻ nhất" hoặc "tự động xoay (rotate) mật khẩu DB như thế nào". Bạn phải phân biệt được khi nào dùng Parameter Store, khi nào dùng Secrets Manager, hiểu cơ chế SecureString + KMS, dynamic references trong CloudFormation (`{{resolve:...}}`), cách ECS/CodeBuild/Lambda nạp secret, và cơ chế rotation tự động của Secrets Manager.

## Mục tiêu chương
- Nắm vững kiến trúc Parameter Store: standard vs advanced tier, hierarchy, `GetParametersByPath`, SecureString với KMS, parameter policies và public parameters.
- Hiểu Secrets Manager: cấu trúc secret, rotation tự động (managed rotation cho RDS và custom Lambda rotation 4 bước), cross-region replication, resource policy.
- So sánh chính xác Parameter Store vs Secrets Manager để chọn đúng trong câu hỏi tình huống và tối ưu chi phí.
- Sử dụng dynamic references `{{resolve:ssm}}` / `{{resolve:secretsmanager}}` trong CloudFormation đúng cách (kể cả bẫy với `NoEcho`).
- Nạp secret/parameter vào ECS task, CodeBuild, và Lambda (Parameters and Secrets Lambda Extension) một cách an toàn, có cache.
- Tránh các bẫy production: cache sai cách gây ThrottlingException, để lộ secret trong log/env, nhầm tier khiến tốn tiền.

## 47.1 Vì sao cần tách config & secret ra khỏi code

Một quy tắc bất di bất dịch của 12-factor app: **config nằm trong môi trường, không nằm trong code**. Hardcode connection string, API key hay password vào source là sai cả về bảo mật (lộ khi push lên Git) lẫn vận hành (đổi giá trị phải build/deploy lại). Trên AWS có hai dịch vụ chuyên trách việc này, đều thuộc phạm vi DVA-C02:

- **SSM Parameter Store** (một phần của AWS Systems Manager): kho lưu key-value phân cấp, miễn phí ở standard tier. Hợp với *configuration data* và cả secret đơn giản.
- **AWS Secrets Manager**: dịch vụ chuyên cho secret, điểm khác biệt cốt lõi là **rotation tự động** và tích hợp sẵn với RDS/Redshift/DocumentDB. Tính phí theo secret.

Cả hai đều dựa trên **AWS KMS** để mã hoá at-rest (chi tiết KMS ở Chương 46). Điểm bạn cần khắc cốt: Parameter Store là dịch vụ *generic* lưu mọi loại tham số; Secrets Manager là dịch vụ *chuyên dụng* cho secret cần xoay vòng. Đề thi rất hay gài chỗ này — đọc kỹ phần 47.6.

> 💡 **Exam Tip:** Từ khoá "automatically rotate", "rotation", "managed credentials for RDS" → gần như chắc chắn là **Secrets Manager**. Từ khoá "store configuration", "cheapest", "free", "license code", "database connection string (không cần rotate)" → nghiêng về **Parameter Store SecureString**.

## 47.2 Parameter Store — kiến trúc, hierarchy và các kiểu tham số

Parameter Store lưu tham số dưới dạng key-value. **Key chính là một đường dẫn phân cấp** dùng dấu `/`, ví dụ `/myapp/prod/db/url`. Phân cấp này không chỉ để gọn mắt — nó cho phép bạn:

- Phân quyền IAM theo nhánh (cho role chỉ đọc được `/myapp/prod/*`).
- Lấy hàng loạt tham số cùng nhánh bằng một lời gọi `GetParametersByPath`.

Có **3 kiểu (type) tham số**:

| Type | Mô tả | Mã hoá |
|------|-------|--------|
| `String` | Chuỗi thường (text, số, ARN...) | Không |
| `StringList` | Nhiều giá trị phân tách bởi dấu phẩy | Không |
| `SecureString` | Giá trị nhạy cảm, mã hoá bằng KMS | Có (KMS) |

Tạo và đọc tham số bằng CLI:

```bash
# Tạo tham số String thường
aws ssm put-parameter \
  --name "/myapp/prod/db/url" \
  --value "prod-db.abc123.ap-southeast-1.rds.amazonaws.com" \
  --type String

# Tạo SecureString — mặc định dùng KMS key alias/aws/ssm (AWS managed)
aws ssm put-parameter \
  --name "/myapp/prod/db/password" \
  --value "S3cr3tP@ss" \
  --type SecureString

# Dùng customer managed key (CMK) thay vì AWS managed key
aws ssm put-parameter \
  --name "/myapp/prod/db/password" \
  --value "S3cr3tP@ss" \
  --type SecureString \
  --key-id "alias/my-cmk" \
  --overwrite

# Đọc 1 tham số — SecureString trả về dạng mã hoá nếu KHÔNG có --with-decryption
aws ssm get-parameter --name "/myapp/prod/db/password" --with-decryption
```

Lấy cả nhánh — đây là API hay được hỏi vì nó giúp app load toàn bộ config một lần:

```bash
# Lấy mọi tham số dưới /myapp/prod/ (đệ quy), giải mã SecureString
aws ssm get-parameters-by-path \
  --path "/myapp/prod/" \
  --recursive \
  --with-decryption
```

Đọc bằng AWS SDK for JavaScript v3 — pattern điển hình trong Lambda/ECS:

```javascript
import { SSMClient, GetParametersByPathCommand } from "@aws-sdk/client-ssm";

const ssm = new SSMClient({});

// Nạp toàn bộ config dưới 1 nhánh, trả về object { key: value }
async function loadConfig(prefix) {
  const config = {};
  let NextToken;
  do {
    const res = await ssm.send(new GetParametersByPathCommand({
      Path: prefix,
      Recursive: true,
      WithDecryption: true, // giải mã SecureString
      NextToken,            // phân trang: tối đa 10 param/lần
    }));
    for (const p of res.Parameters) {
      // bỏ prefix cho gọn: /myapp/prod/db/url -> db/url
      config[p.Name.replace(prefix, "")] = p.Value;
    }
    NextToken = res.NextToken;
  } while (NextToken);
  return config;
}
```

Lưu ý: `GetParametersByPath` trả tối đa **10 tham số mỗi lần gọi** (dùng `NextToken` để phân trang). `GetParameters` (số nhiều, không theo path) nhận tối đa **10 tên** mỗi request. Còn `GetParameter` (số ít) lấy đúng 1 tham số.

> 💡 **Exam Tip:** SecureString chỉ được giải mã khi bạn truyền `--with-decryption` (CLI) hoặc `WithDecryption: true` (SDK). Nếu quên, app nhận về ciphertext và "không hiểu password sai chỗ nào". Đồng thời role gọi phải có quyền `kms:Decrypt` trên key đã mã hoá tham số — thiếu quyền KMS là nguyên nhân `AccessDeniedException` rất hay gặp.

### Parameter versions

Mỗi lần `put-parameter --overwrite` tạo ra một **version mới** (số nguyên tăng dần). Bạn có thể đọc version cụ thể bằng `name:version`, hoặc gắn **label** rồi đọc bằng `name:label`:

```bash
# Đọc đúng version 3
aws ssm get-parameter --name "/myapp/prod/db/url:3"
# Gắn label "production" cho version hiện tại rồi đọc theo label
aws ssm label-parameter-version --name "/myapp/prod/db/url" --labels production
aws ssm get-parameter --name "/myapp/prod/db/url:production"
```

## 47.3 Standard tier vs Advanced tier & parameter policies

Parameter Store có hai tier. Khác biệt nằm ở quota và tính năng:

| Tiêu chí | Standard | Advanced |
|----------|----------|----------|
| Số parameter / account / region | 10,000 | 100,000 |
| Kích thước giá trị tối đa | 4 KB | 8 KB |
| Parameter policies | Không | Có |
| Chi phí lưu trữ | Miễn phí | $0.05 / param / tháng |
| Phí API tương tác cao throughput | Standard throughput miễn phí | Higher throughput tính phí |

Bạn có thể nâng từ standard lên advanced trên một tham số, nhưng **không hạ ngược lại được** (phải xoá tạo lại). Mặc định account dùng standard; muốn tham số mới tự là advanced thì set `--tier Advanced` hoặc bật setting cấp account.

**Parameter policies** (chỉ có ở advanced tier) cho phép gắn hành vi tự động dạng JSON, gồm 3 loại:

- **Expiration**: tự xoá tham số tại thời điểm chỉ định (ISO 8601). Hữu ích cho secret tạm.
- **ExpirationNotification**: đẩy event lên EventBridge trước khi hết hạn N ngày/giờ — để bạn kịp gia hạn.
- **NoChangeNotification**: đẩy event nếu tham số **không** được cập nhật trong khoảng thời gian đặt ra (phát hiện secret "ôi thiu" không ai rotate).

```bash
aws ssm put-parameter \
  --name "/myapp/temp/token" \
  --value "abc" \
  --type SecureString \
  --tier Advanced \
  --policies '[
    {"Type":"Expiration","Version":"1.0","Attributes":{"Timestamp":"2026-12-31T00:00:00Z"}},
    {"Type":"ExpirationNotification","Version":"1.0","Attributes":{"Before":"15","Unit":"Days"}},
    {"Type":"NoChangeNotification","Version":"1.0","Attributes":{"After":"30","Unit":"Days"}}
  ]'
```

> 💡 **Exam Tip:** Câu hỏi "tham số > 4 KB" hoặc "cần policy expiration/notification" → bắt buộc **Advanced tier**. Câu "cần 100,000 tham số" cũng là Advanced. Nhưng nhớ: parameter policies **không phải** rotation — chúng chỉ thông báo/hết hạn, không tự sinh giá trị mới. Muốn rotation thật sự thì là Secrets Manager.

## 47.4 SecureString & KMS — cơ chế mã hoá bên dưới

SecureString **không tự nó mã hoá** — nó nhờ KMS. Khi bạn `put-parameter --type SecureString`:

1. Parameter Store gọi KMS `GenerateDataKey` (hoặc Encrypt) trên key chỉ định.
2. Mặc định dùng AWS managed key `alias/aws/ssm`. Nếu truyền `--key-id` thì dùng CMK của bạn.
3. Plaintext value được mã hoá bằng data key (envelope encryption — chi tiết ở Chương 46); ciphertext được lưu.

Khi đọc với `--with-decryption`, Parameter Store gọi KMS `Decrypt`. Vì vậy **principal đọc tham số cần CẢ HAI quyền**: `ssm:GetParameter*` và `kms:Decrypt` trên đúng key. Đây là điểm nhiều người vấp:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["ssm:GetParameter", "ssm:GetParametersByPath", "ssm:GetParameters"],
      "Resource": "arn:aws:ssm:ap-southeast-1:111122223333:parameter/myapp/prod/*"
    },
    {
      "Effect": "Allow",
      "Action": "kms:Decrypt",
      "Resource": "arn:aws:kms:ap-southeast-1:111122223333:key/abcd-1234..."
    }
  ]
}
```

Dùng AWS managed key `alias/aws/ssm` thì bạn không sửa được key policy của nó, nhưng IAM identity policy như trên vẫn cần `kms:Decrypt`. Dùng CMK cho phép kiểm soát chặt hơn (key policy + grant + cross-account) — chọn CMK khi cần audit/phân quyền KMS riêng.

> 💡 **Exam Tip:** Bẫy resource ARN: với tham số phân cấp `/myapp/prod/db/url`, ARN là `.../parameter/myapp/prod/db/url` — **dấu `/` đầu tiên của tên bị "nuốt"** vào sau `parameter`. Viết `parameter//myapp/...` (hai gạch) là sai. Khi dùng wildcard cho cả nhánh: `arn:...:parameter/myapp/prod/*`.

## 47.5 Public parameters — danh mục công khai của AWS

AWS publish sẵn nhiều giá trị thường thay đổi dưới namespace `/aws/service/...` để bạn không phải hardcode. Hữu dụng nhất cho developer:

- **AMI mới nhất**: `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64`. Dùng trong CloudFormation/Launch Template để luôn lấy AMI Amazon Linux 2023 mới nhất.
- Region list, AZ, danh sách dịch vụ, ECS-optimized AMI, Windows AMI...

```bash
# Lấy AMI ID Amazon Linux 2023 mới nhất (x86_64)
aws ssm get-parameter \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --query "Parameter.Value" --output text
```

Trong CloudFormation, dùng parameter type đặc biệt để CFN tự resolve AMI mới nhất khi tạo stack:

```yaml
Parameters:
  LatestAmiId:
    Type: AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>
    Default: /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64
```

> 💡 **Exam Tip:** "Luôn deploy với AMI mới nhất mà không cần sửa template" → dùng **public parameter** `/aws/service/ami-amazon-linux-latest/...` qua CloudFormation parameter type `AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>`.

## 47.6 AWS Secrets Manager — kiến trúc & API

Secrets Manager lưu secret dưới dạng JSON key-value (hoặc plaintext). Mỗi secret có:

- **SecretString** (hoặc SecretBinary): nội dung, thường là JSON như `{"username":"admin","password":"..."}`.
- **Version** với **staging labels**: `AWSCURRENT` (giá trị đang dùng), `AWSPREVIOUS` (giá trị trước), `AWSPENDING` (giá trị mới trong lúc rotate). Cơ chế label này là nền tảng để rotation không gây downtime.
- Mã hoá at-rest bằng KMS (mặc định `aws/secretsmanager`, hoặc CMK).

```bash
# Tạo secret JSON
aws secretsmanager create-secret \
  --name prod/myapp/db \
  --secret-string '{"username":"admin","password":"S3cr3t","host":"db.internal","port":5432}'

# Đọc secret (mặc định trả AWSCURRENT)
aws secretsmanager get-secret-value --secret-id prod/myapp/db --query SecretString --output text
```

Đọc trong Node.js, parse JSON và cache trong process (cực kỳ quan trọng để tránh gọi API mỗi lần và tránh phí + throttling):

```javascript
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const client = new SecretsManagerClient({});
let cached;            // cache ở scope module → sống qua nhiều invocation Lambda
let cachedAt = 0;
const TTL_MS = 5 * 60 * 1000; // cache 5 phút

export async function getDbSecret() {
  if (cached && Date.now() - cachedAt < TTL_MS) return cached; // dùng lại
  const res = await client.send(new GetSecretValueCommand({ SecretId: "prod/myapp/db" }));
  cached = JSON.parse(res.SecretString); // { username, password, host, port }
  cachedAt = Date.now();
  return cached;
}
```

**Bẫy cache + rotation:** nếu cache vĩnh viễn (không TTL) thì sau khi secret được rotate, app vẫn cầm password cũ → lỗi auth. Cách đúng: cache có TTL ngắn (vài phút), và khi gặp lỗi auth thì **invalidate cache rồi đọc lại** `AWSCURRENT`. Đây chính là lý do AWS phát hành thư viện `aws-secrets-cache` và Lambda extension (47.10).

> 💡 **Exam Tip:** Secrets Manager hỗ trợ **resource policy** (gắn trực tiếp lên secret) — dùng cho **cross-account access**: account khác đọc secret của bạn. Kết hợp với KMS key policy cho phép `kms:Decrypt` từ account đó. Parameter Store standard **không** có resource policy theo kiểu này; advanced tier mới hỗ trợ cross-account chia sẻ qua RAM/policy. Câu "share secret sang account khác" → Secrets Manager resource policy.

## 47.7 Secret rotation — managed (RDS) và custom Lambda

Đây là tính năng "đắt giá" nhất của Secrets Manager và là lý do tồn tại của nó.

**Managed rotation cho RDS/Aurora/Redshift/DocumentDB:** Khi bạn tạo secret kiểu "credentials for RDS database", Secrets Manager cung cấp sẵn một Lambda rotation function (template AWS soạn). Bạn chỉ cần bật rotation và đặt lịch (ví dụ mỗi 30 ngày). Có hai chiến lược:

- **Single-user rotation**: rotate ngay trên chính user đó. Đơn giản nhưng có một "khe" ngắn lúc đổi password mà connection mới có thể fail → hợp DB ít kết nối.
- **Alternating-users (two-user) rotation**: dùng một user "clone" — rotate user B trong khi app vẫn dùng user A, rồi switch. Không downtime, khuyến nghị cho production. Cần cung cấp một secret "superuser/admin" để Lambda tạo/đổi user.

**Custom Lambda rotation — 4 bước (steps):** Với secret không phải RDS managed (API key bên thứ ba, DB tự quản...), bạn viết rotation Lambda implement đúng 4 step mà Secrets Manager gọi qua event `Step`:

1. **createSecret**: sinh giá trị mới (ví dụ password mới), lưu vào version có label `AWSPENDING`.
2. **setSecret**: đẩy giá trị `AWSPENDING` vào hệ thống đích (đổi password trên DB / gọi API provider).
3. **testSecret**: thử dùng giá trị `AWSPENDING` để xác nhận nó hoạt động (connect thử).
4. **finishSecret**: dời label `AWSCURRENT` sang version `AWSPENDING` (và `AWSPREVIOUS` sang current cũ). Từ đây app đọc `AWSCURRENT` sẽ nhận giá trị mới.

```javascript
// Khung rotation Lambda — Secrets Manager truyền event.Step
export const handler = async (event) => {
  const { SecretId, ClientRequestToken, Step } = event;
  switch (Step) {
    case "createSecret":  return createSecret(SecretId, ClientRequestToken);
    case "setSecret":     return setSecret(SecretId, ClientRequestToken);
    case "testSecret":    return testSecret(SecretId, ClientRequestToken);
    case "finishSecret":  return finishSecret(SecretId, ClientRequestToken);
    default: throw new Error(`Unknown step ${Step}`);
  }
};
```

Bật rotation bằng CLI:

```bash
aws secretsmanager rotate-secret \
  --secret-id prod/myapp/db \
  --rotation-lambda-arn arn:aws:lambda:ap-southeast-1:111122223333:function:MyRotation \
  --rotation-rules '{"AutomaticallyAfterDays": 30}'
```

> 💡 **Exam Tip:** Rotation Lambda thao tác trên staging label `AWSPENDING`, và bước cuối **finishSecret** mới chuyển `AWSCURRENT`. Nếu rotation lỗi giữa chừng, `AWSCURRENT` không đổi → app vẫn chạy với secret cũ (an toàn). Nếu Lambda rotation nằm trong VPC để gọi RDS private, nó cần **đường ra Secrets Manager endpoint** (VPC interface endpoint hoặc NAT) — thiếu cái này là lỗi rotation kinh điển.

## 47.8 Cross-region replication & high availability

Với app multi-region hoặc DR, Secrets Manager hỗ trợ **replicate secret sang region khác**. Replica là bản sao read; rotation vẫn xảy ra ở region primary rồi đồng bộ. Mỗi replica được mã hoá bằng KMS key của region đích (phải tồn tại key ở đó).

```bash
aws secretsmanager replicate-secret-to-regions \
  --secret-id prod/myapp/db \
  --add-replica-regions Region=us-east-1,KmsKeyId=alias/aws/secretsmanager
```

Parameter Store không có replication tự động — bạn tự copy bằng script hoặc dùng EventBridge để sync. Đây là một điểm cộng nữa của Secrets Manager cho kiến trúc multi-region.

## 47.9 CloudFormation dynamic references — `{{resolve:...}}`

Bạn **không bao giờ** muốn viết password thẳng vào template CloudFormation. Dynamic references cho phép CFN đọc giá trị từ SSM/Secrets Manager **lúc deploy**, không lưu plaintext trong template. Ba dạng:

- `{{resolve:ssm:parameter-name:version}}` — đọc Parameter Store **String/StringList** (KHÔNG dùng cho SecureString trong hầu hết resource).
- `{{resolve:ssm-secure:parameter-name:version}}` — đọc **SecureString** (chỉ một số resource hỗ trợ; CFN tự giải mã).
- `{{resolve:secretsmanager:secret-id:SecretString:json-key:version-stage:version-id}}` — đọc Secrets Manager, có thể trích đúng một json key.

Ví dụ tạo RDS instance lấy password từ Secrets Manager (pattern chuẩn, AWS khuyến nghị):

```yaml
Resources:
  DBSecret:
    Type: AWS::SecretsManager::Secret
    Properties:
      Name: prod/myapp/db
      GenerateSecretString:                 # Secrets Manager tự sinh password ngẫu nhiên
        SecretStringTemplate: '{"username":"admin"}'
        GenerateStringKey: password
        PasswordLength: 32
        ExcludeCharacters: '"@/\'
  DBInstance:
    Type: AWS::RDS::DBInstance
    Properties:
      Engine: mysql
      DBInstanceClass: db.t3.micro
      AllocatedStorage: "20"
      MasterUsername: !Sub "{{resolve:secretsmanager:${DBSecret}:SecretString:username}}"
      MasterUserPassword: !Sub "{{resolve:secretsmanager:${DBSecret}:SecretString:password}}"
```

Ví dụ đọc SecureString:

```yaml
DbUrl:
  Type: String
  Default: "{{resolve:ssm-secure:/myapp/prod/db/password:1}}"
```

> 💡 **Exam Tip:** Có một construct riêng `AWS::SecretsManager::SecretTargetAttachment` để "đính" secret với RDS instance (điền host/port vào secret sau khi DB tạo xong) và bật rotation gọn gàng. Và nhớ: dynamic reference `{{resolve:ssm-secure}}` chỉ được hỗ trợ ở **một tập resource property nhất định** — không phải mọi chỗ. Khi đề hỏi "tránh hardcode password trong CFN" → câu trả lời là **dynamic reference tới Secrets Manager** (hoặc `ssm-secure`), thường kèm `GenerateSecretString`.

## 47.10 Nạp secret vào Lambda, ECS, CodeBuild

**Lambda — Parameters and Secrets Lambda Extension:** Thay vì gọi SDK mỗi lần, AWS cung cấp một **Lambda extension** (layer) tạo một HTTP cache cục bộ trong execution environment. Function của bạn gọi `http://localhost:2773/...`; extension cache lại, giảm số lần gọi API thật và độ trễ. Bật bằng cách thêm layer ARN và biến môi trường:

```bash
# Trong code Lambda — gọi extension qua localhost (đã cache)
curl "http://localhost:2773/secretsmanager/get?secretId=prod/myapp/db" \
  -H "X-Aws-Parameters-Secrets-Token: $AWS_SESSION_TOKEN"
```

Cấu hình qua env: `SSM_PARAMETER_STORE_TTL`, `SECRETS_MANAGER_TTL` (mặc định 300s), `PARAMETERS_SECRETS_EXTENSION_CACHE_SIZE`. Đây là cách cache "đúng chuẩn" mà AWS khuyến nghị — tránh tự cache sai gây stale.

**ECS / Fargate — secrets trong task definition:** Bạn không đặt password vào `environment` (plaintext, lộ qua `describe-task-definition`). Thay vào đó dùng khối `secrets`, ECS sẽ resolve từ SSM/Secrets Manager lúc khởi động container và inject thành env var (chi tiết ECS ở Chương 17):

```json
"secrets": [
  { "name": "DB_PASSWORD", "valueFrom": "arn:aws:secretsmanager:ap-southeast-1:111122223333:secret:prod/myapp/db-AbCdEf:password::" },
  { "name": "API_URL",     "valueFrom": "arn:aws:ssm:ap-southeast-1:111122223333:parameter/myapp/prod/api/url" }
]
```

Để ECS làm được điều này, **task execution role** (không phải task role) cần quyền `secretsmanager:GetSecretValue` / `ssm:GetParameters` và `kms:Decrypt`.

**CodeBuild — secrets trong buildspec:** Tham chiếu qua env var kiểu `SECRETS_MANAGER` hoặc `PARAMETER_STORE` (chi tiết CodeBuild ở Chương 40):

```yaml
env:
  parameter-store:
    DB_URL: /myapp/prod/db/url
  secrets-manager:
    DB_PASS: prod/myapp/db:password
```

> 💡 **Exam Tip:** Với ECS, quyền đọc secret nằm ở **execution role**, vì agent ECS (không phải code app) là bên fetch secret để chuẩn bị container. Nhầm sang task role là sai và container sẽ không start (lỗi `ResourceInitializationError`). Tuyệt đối không nhét secret vào `environment` plaintext — đề hay gài câu này.

## 47.11 So sánh quyết định: Parameter Store vs Secrets Manager

Đây là bảng "kinh điển" của chương — học thuộc cách chọn:

| Tiêu chí | Parameter Store (SecureString) | Secrets Manager |
|----------|-------------------------------|-----------------|
| Chi phí | Standard: **miễn phí**; Advanced: $0.05/param/tháng | **$0.40 / secret / tháng** + $0.05 / 10,000 API calls |
| Rotation tự động | **Không** (advanced policy chỉ notify, không sinh giá trị) | **Có**, native + managed cho RDS/Redshift/DocumentDB |
| Tích hợp RDS sẵn | Không | **Có** (managed rotation) |
| Resource policy / cross-account | Hạn chế (advanced) | **Có**, đầy đủ |
| Cross-region replication | Không native | **Có** |
| Sinh password ngẫu nhiên | Không | **Có** (`get-random-password`, `GenerateSecretString`) |
| Kích thước giá trị | 4 KB (std) / 8 KB (adv) | **64 KB** |
| Phân cấp + GetByPath | **Có** | Không có hierarchy kiểu path |
| Public parameters (AMI...) | **Có** | Không |
| Mã hoá KMS | Có (SecureString) | Có (luôn mã hoá) |

Cách chọn nhanh trong phòng thi:
- Cần **rotation tự động** hoặc **managed RDS credentials** → **Secrets Manager**.
- Chỉ lưu config / feature flag / license / connection string không cần rotate, ưu tiên **rẻ/miễn phí** → **Parameter Store SecureString**.
- Cần **chia sẻ secret cross-account** hoặc **multi-region replica** → **Secrets Manager**.
- Cần lấy **AMI mới nhất** / danh mục AWS → **Parameter Store public parameters**.
- Mẹo hay: Secrets Manager **có thể tham chiếu một parameter của Parameter Store** (Parameter Store cho phép tham chiếu secret của Secrets Manager qua tên `/aws/reference/secretsmanager/<secret>`), nên đôi khi bạn dùng Parameter Store làm "mặt tiền" thống nhất nhưng vẫn để Secrets Manager rotate.

> 💡 **Exam Tip:** Từ khoá **"most cost-effective"** + **"không cần rotation"** → Parameter Store. Từ khoá **"automatically rotate every 30/60/90 days"** hoặc **"RDS credentials"** → Secrets Manager, kể cả khi đắt hơn. Đừng chọn Secrets Manager chỉ vì "nghe bảo mật hơn" khi đề nhấn mạnh chi phí và không nhắc rotation.

## 47.12 Throttling, quotas & bẫy production

- **Parameter Store throughput**: standard throughput mặc định giới hạn (khoảng 40 TPS cho `GetParameter`); bật **higher throughput** (tính phí) lên ~10,000 TPS nếu app gọi dày. App gọi parameter trong vòng lặp nóng mà không cache → `ThrottlingException`. **Luôn cache** giá trị ở scope process.
- **Secrets Manager**: `GetSecretValue` cũng có rate limit; mỗi call tính tiền ($0.05/10k). Cache bắt buộc. Đây là lý do Lambda extension tồn tại.
- **KMS request quota**: SecureString/secret đọc nhiều kéo theo `kms:Decrypt` nhiều → có thể chạm KMS throttling (chi tiết ở Chương 46). Cache giải quyết luôn vấn đề này.
- **Bẫy log**: đừng `console.log` cả object secret; đừng để secret rò vào CloudWatch Logs hay X-Ray annotations. Trong CloudFormation, output chứa giá trị resolve cũng có thể lộ — dùng `NoEcho: true` cho parameter nhạy cảm và **không** xuất secret ra `Outputs`.
- **Bẫy xoá secret**: Secrets Manager mặc định có **recovery window 7–30 ngày** khi `delete-secret` (không xoá ngay) để tránh mất nhầm. Muốn xoá ngay phải `--force-delete-without-recovery`. Đề có thể hỏi "vì sao xoá rồi vẫn còn / tạo lại cùng tên báo lỗi".

> 💡 **Exam Tip:** "App gọi Parameter Store/Secrets Manager bị ThrottlingException dưới tải cao" → câu trả lời gần như luôn là **cache trong code** (hoặc dùng Lambda extension / bật higher throughput cho Parameter Store), KHÔNG phải "tăng IAM permission". Phân biệt rõ throttling (giới hạn rate) với AccessDenied (thiếu quyền).

---

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
