## Hands-on Lab: Feature flag với AWS AppConfig (validator + deployment strategy) và gửi email với Amazon SES

**Mục tiêu lab:** Dựng một luồng feature flag hoàn chỉnh bằng AWS AppConfig qua AWS CLI v2: tạo application, environment, configuration profile kiểu `AWS.AppConfig.FeatureFlags`, gắn một JSON Schema validator để chặn config sai, định nghĩa deployment strategy kiểu canary (bake time + tốc độ tăng), deploy và poll config từ phía "ứng dụng" bằng API `StartConfigurationSession` + `GetLatestConfiguration`. Sau đó dùng Amazon SES gửi một email transactional bằng SDK JavaScript v3 để thấy cách hai dịch vụ "phụ" này xuất hiện trong đề DVA-C02. Cuối cùng dọn sạch tài nguyên.

**Chuẩn bị:**
- AWS CLI v2 đã cấu hình profile có quyền `appconfig:*`, `ses:*`, `iam:PassRole` (tài khoản học tập, KHÔNG phải production).
- Node.js >= 18 và `jq`.
- Region dùng xuyên suốt: `ap-southeast-1`.
- Một email cá nhân bạn truy cập được (để verify trong SES sandbox).

```bash
export AWS_REGION="ap-southeast-1"
export APP_NAME="dva-lab-ch48-app"
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export MY_EMAIL="ban-thay-bang-email-that@example.com"
```

> Lưu ý chi phí: AppConfig tính theo số lần `GetLatestConfiguration` (~$0.0008/1000 request) và "configuration received" — lab này vài request nên gần như $0. SES trong sandbox miễn phí cho 200 email/ngày từ EC2/Lambda; gửi vài email test gần như $0. Vẫn phải dọn dẹp.

### Bước 1: Tạo AppConfig application và environment

```bash
APP_ID=$(aws appconfig create-application \
  --name "$APP_NAME" \
  --query Id --output text --region "$AWS_REGION")

ENV_ID=$(aws appconfig create-environment \
  --application-id "$APP_ID" \
  --name "production" \
  --query Id --output text --region "$AWS_REGION")

echo "APP_ID=$APP_ID ENV_ID=$ENV_ID"
```

Output mong đợi: hai chuỗi 7 ký tự (ví dụ `APP_ID=ab12cd3 ENV_ID=ef45gh6`). `application` là không gian logic; `environment` là nơi config được triển khai (dev/staging/prod) và là cấp gắn CloudWatch alarm để auto-rollback.

### Bước 2: Tạo configuration profile kiểu Feature Flags kèm validator

AppConfig hỗ trợ profile kiểu `AWS.Freeform` (JSON/YAML/text tuỳ ý) và `AWS.AppConfig.FeatureFlags` (cấu trúc cờ chuẩn hoá). Ta dùng feature flags và gắn một JSON Schema validator để AppConfig **từ chối** config sai ngay khi tạo version — đây là điểm thi hay hỏi: validator chạy lúc `StartDeployment`, nếu fail thì deployment không bắt đầu.

```bash
# Validator dạng JSON Schema: bắt buộc flag "new_checkout" phải có thuộc tính boolean "enabled"
cat > /tmp/validator.json <<'EOF'
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["flags", "values", "version"],
  "properties": {
    "version": { "type": "string" }
  }
}
EOF

PROFILE_ID=$(aws appconfig create-configuration-profile \
  --application-id "$APP_ID" \
  --name "feature-flags" \
  --location-uri "hosted" \
  --type "AWS.AppConfig.FeatureFlags" \
  --validators "Type=JSON_SCHEMA,Content=$(cat /tmp/validator.json | jq -c . | jq -Rs .)" \
  --query Id --output text --region "$AWS_REGION")

echo "PROFILE_ID=$PROFILE_ID"
```

`location-uri=hosted` nghĩa là config lưu trong AppConfig Hosted Configuration Store (không cần S3/SSM Parameter Store). Ngoài JSON_SCHEMA, AppConfig còn hỗ trợ validator kiểu `LAMBDA` (gọi một Lambda trả về pass/fail) — dùng khi cần logic kiểm tra phức tạp hơn schema tĩnh.

### Bước 3: Tạo phiên config (version) bật flag

```bash
cat > /tmp/flags.json <<'EOF'
{
  "flags": {
    "new_checkout": { "name": "new_checkout" }
  },
  "values": {
    "new_checkout": { "enabled": true }
  },
  "version": "1"
}
EOF

VERSION=$(aws appconfig create-hosted-configuration-version \
  --application-id "$APP_ID" \
  --configuration-profile-id "$PROFILE_ID" \
  --content-type "application/json" \
  --content fileb:///tmp/flags.json \
  --query VersionNumber --output text --region "$AWS_REGION" \
  /tmp/version-out.json)

echo "VERSION=$VERSION"
```

Nếu JSON không khớp validator, lệnh này (hoặc bước deploy) sẽ trả `BadRequestException` với lý do schema mismatch — đó là cơ chế chặn config hỏng trước khi tới production.

### Bước 4: Tạo deployment strategy kiểu canary

```bash
STRATEGY_ID=$(aws appconfig create-deployment-strategy \
  --name "dva-canary-10pct" \
  --deployment-duration-in-minutes 5 \
  --growth-factor 10 \
  --growth-type EXPONENTIAL \
  --final-bake-time-in-minutes 2 \
  --replicate-to NONE \
  --query Id --output text --region "$AWS_REGION")

echo "STRATEGY_ID=$STRATEGY_ID"
```

Giải nghĩa các tham số (đề hay hỏi ý nghĩa từng cái):
- `deployment-duration-in-minutes`: tổng thời gian roll out đến 100% client.
- `growth-factor` + `growth-type`: tốc độ tăng phần trăm client nhận config mới. `EXPONENTIAL` với factor 10 → 10%, rồi 10×2=20%... thực tế AppConfig diễn giải theo công thức tăng dần.
- `final-bake-time-in-minutes`: sau khi đạt 100%, "nướng" thêm 2 phút để CloudWatch alarm kịp kích hoạt rollback nếu lỗi.
- `replicate-to NONE`: không sao chép strategy sang SSM. AWS cũng có sẵn các strategy dựng sẵn như `AppConfig.AllAtOnce`, `AppConfig.Linear50PercentEvery30Seconds`, `AppConfig.Canary10Percent20Minutes`.

### Bước 5: Bắt đầu deployment

```bash
DEPLOY_NUM=$(aws appconfig start-deployment \
  --application-id "$APP_ID" \
  --environment-id "$ENV_ID" \
  --deployment-strategy-id "$STRATEGY_ID" \
  --configuration-profile-id "$PROFILE_ID" \
  --configuration-version "$VERSION" \
  --query DeploymentNumber --output text --region "$AWS_REGION")

aws appconfig get-deployment \
  --application-id "$APP_ID" --environment-id "$ENV_ID" \
  --deployment-number "$DEPLOY_NUM" \
  --query 'State' --output text --region "$AWS_REGION"
```

Output ban đầu: `DEPLOYING`. Sau ~7 phút (5 phút roll out + 2 phút bake) sẽ thành `COMPLETE`. Trong lúc đó client có thể đã nhận config (canary), không cần đợi 100%.

### Bước 6: Đọc config từ phía ứng dụng (data plane)

Đây là phần quan trọng nhất về API: ứng dụng KHÔNG gọi `get-deployment`; nó dùng cặp API data plane `StartConfigurationSession` → `GetLatestConfiguration`. Token trả về là one-time, lần sau phải dùng `NextPollConfigurationToken` từ response trước.

```bash
SESSION_TOKEN=$(aws appconfigdata start-configuration-session \
  --application-identifier "$APP_ID" \
  --environment-identifier "$ENV_ID" \
  --configuration-profile-identifier "$PROFILE_ID" \
  --query InitialConfigurationToken --output text --region "$AWS_REGION")

aws appconfigdata get-latest-configuration \
  --configuration-token "$SESSION_TOKEN" \
  --region "$AWS_REGION" \
  /tmp/config-out.bin >/tmp/get-config-meta.json

cat /tmp/config-out.bin | jq .
```

Output mong đợi: nội dung JSON feature flag, ví dụ `{"new_checkout": {"enabled": true}}`. Lưu ý: nếu config CHƯA đổi so với lần poll trước, `GetLatestConfiguration` trả về body RỖNG (0 byte) để tiết kiệm băng thông — ứng dụng phải xử lý trường hợp body rỗng = "giữ config cũ trong cache". Đây là bẫy kinh điển. Trong production thực tế bạn dùng AppConfig Agent (Lambda extension/sidecar) để poll giúp và cache, code chỉ gọi `http://localhost:2772/...`.

### Bước 7: Verify email và gửi transactional email bằng SES (SDK v3)

```bash
aws ses verify-email-identity --email-address "$MY_EMAIL" --region "$AWS_REGION"
```

Mở hộp thư, click link verify. Kiểm tra:

```bash
aws ses get-identity-verification-attributes \
  --identities "$MY_EMAIL" --region "$AWS_REGION" \
  --query "VerificationAttributes.\"$MY_EMAIL\".VerificationStatus"
```

Output mong đợi: `"Success"`. Vì tài khoản đang ở SES sandbox, cả người gửi VÀ người nhận đều phải là identity đã verify (ở đây gửi cho chính mình). Để thoát sandbox phải mở case yêu cầu production access.

```javascript
// send-email.mjs — Amazon SES v2 với AWS SDK for JavaScript v3
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

const client = new SESv2Client({ region: "ap-southeast-1" });
const ADDR = process.env.MY_EMAIL;

const cmd = new SendEmailCommand({
  FromEmailAddress: ADDR,
  Destination: { ToAddresses: [ADDR] },
  Content: {
    Simple: {
      Subject: { Data: "DVA Lab Ch48 - SES test" },
      Body: { Text: { Data: "Email transactional gui qua Amazon SES v2." } },
    },
  },
});

const res = await client.send(cmd);
console.log("MessageId:", res.MessageId);
```

```bash
npm install @aws-sdk/client-sesv2
node send-email.mjs
```

Output mong đợi: `MessageId: 0100018f...`. Email về hộp thư bạn. Nếu thấy lỗi `MessageRejected: Email address is not verified` nghĩa là sandbox + người nhận chưa verify.

### Dọn dẹp tài nguyên

```bash
# AppConfig: xoá theo thứ tự ngược (deployment tự kết thúc, không cần xoá)
aws appconfig delete-configuration-profile \
  --application-id "$APP_ID" --configuration-profile-id "$PROFILE_ID" --region "$AWS_REGION"
aws appconfig delete-environment \
  --application-id "$APP_ID" --environment-id "$ENV_ID" --region "$AWS_REGION"
aws appconfig delete-deployment-strategy \
  --deployment-strategy-id "$STRATEGY_ID" --region "$AWS_REGION"
aws appconfig delete-application --application-id "$APP_ID" --region "$AWS_REGION"

# SES: gỡ verified identity
aws ses delete-identity --identity "$MY_EMAIL" --region "$AWS_REGION"

# Xoá file tạm
rm -f /tmp/validator.json /tmp/flags.json /tmp/config-out.bin /tmp/*-out.json /tmp/get-config-meta.json
```

> Bẫy dọn dẹp: nếu xoá `configuration-profile` khi đang có hosted version, AppConfig vẫn cho xoá và dọn luôn version. Nhưng nếu bạn đã gắn CloudWatch alarm vào environment cho auto-rollback (production), nhớ xoá alarm riêng — nó không tự mất khi xoá environment.

## 💡 Exam Tips chương 48

- **AppConfig vs Parameter Store:** AppConfig dành cho thay đổi config "an toàn có kiểm soát" (feature flags, kill switch) với validator + deployment strategy + auto-rollback bằng CloudWatch alarm. Parameter Store/Secrets Manager (Chương 47) chỉ là kho lưu giá trị — không có rollout từ từ. Từ khoá đề: "gradually roll out a feature flag with automatic rollback" → AppConfig.
- **AppConfig data plane API:** ứng dụng đọc config bằng `StartConfigurationSession` + `GetLatestConfiguration` (dịch vụ `appconfigdata`), KHÔNG dùng `GetConfiguration` cũ (đã deprecated). `GetLatestConfiguration` trả body rỗng khi config không đổi.
- **SES sandbox:** mặc định mọi tài khoản ở sandbox — chỉ gửi/nhận giữa các email/domain đã verify, giới hạn ~200 email/ngày. Muốn gửi cho khách hàng bất kỳ phải request production access. Đề hay gài: "emails to verified addresses only" = vẫn ở sandbox.
- **SES configuration sets:** dùng để theo dõi bounce, complaint, delivery, open/click qua event publishing tới SNS/Kinesis Firehose/CloudWatch. Khi cần "track bounce/complaint rate" → configuration set + event destination, không phải tự parse log.
- **ACM với CloudFront:** chứng chỉ public dùng cho CloudFront PHẢI tạo/import ở Region **us-east-1** (N. Virginia), bất kể CloudFront là global. Với ALB/API Gateway regional thì cert ở cùng region với resource. Đây là bẫy region kinh điển.
- **ACM auto-renewal:** chỉ áp dụng cho cert do ACM phát hành (managed renewal), và chỉ tự gia hạn khi dùng **DNS validation** với record CNAME còn nguyên trong Route 53. Cert **imported** (bên ngoài) KHÔNG được ACM tự gia hạn — bạn tự chịu trách nhiệm.
- **OpenSearch vs DynamoDB:** DynamoDB query nhanh theo key đã biết; OpenSearch dành cho **full-text search**, fuzzy, faceted, log analytics. Pattern hay gặp: DynamoDB là source of truth + DynamoDB Streams → Lambda → index sang OpenSearch để tìm kiếm tự do.
- **Athena:** query trực tiếp dữ liệu trên S3 bằng SQL, serverless, tính tiền theo TB quét. Giảm chi phí/tăng tốc bằng **partitioning** và đổi sang định dạng cột nén (Parquet/ORC). Glue Data Catalog cung cấp schema/metadata. "Query S3 logs with SQL, no infrastructure" → Athena.
- **MSK vs Kinesis:** MSK = Apache Kafka được quản lý, chọn khi đã có app Kafka/cần API Kafka. Kinesis Data Streams ít vận hành hơn (serverless on-demand), tích hợp sâu với Lambda/Firehose. "Migrate existing Kafka workload, keep Kafka API" → MSK.
- **AWS Batch vs Lambda:** Batch chạy job container chạy lâu/nặng (không bị giới hạn 15 phút và 10GB như Lambda), trên EC2/Fargate, có job queue + dependency. "Long-running batch jobs > 15 minutes" → AWS Batch (hoặc ECS/Fargate task), không phải Lambda.
- **Amazon MQ vs SQS/SNS:** Amazon MQ (ActiveMQ/RabbitMQ được quản lý) chọn khi migrate hệ thống cũ dùng giao thức chuẩn (AMQP, MQTT, STOMP, JMS). App mới trên AWS thì ưu tiên SQS/SNS. "Lift-and-shift app using JMS/AMQP" → Amazon MQ.
- **Macie vs GuardDuty vs Inspector:** Macie dùng ML phát hiện **PII/dữ liệu nhạy cảm trong S3**. GuardDuty là threat detection. Inspector quét lỗ hổng (EC2, ECR image, Lambda). "Discover sensitive data like credit cards in S3" → Macie.

## Quiz chương 48 (10 câu)

**Câu 1.** A developer needs to roll out a new feature flag to 10% of users first, monitor a CloudWatch alarm, and automatically roll back if errors spike — without redeploying the application. Which service fits best?
- A. AWS Systems Manager Parameter Store
- B. AWS Secrets Manager
- C. AWS AppConfig
- D. AWS CloudFormation StackSets

**Câu 2.** An application uses AppConfig. After the first successful `GetLatestConfiguration` call, subsequent polls return an empty response body. What does this mean?
- A. The session token has expired and must be recreated
- B. The configuration has not changed since the last poll
- C. The deployment failed validation
- D. The application lacks `appconfig:GetConfiguration` permission

**Câu 3.** A company wants TLS for a CloudFront distribution using a custom domain with an ACM-issued public certificate. In which Region must the certificate exist?
- A. The Region closest to the origin
- B. Any Region; CloudFront is global
- C. us-east-1 (N. Virginia)
- D. The same Region as the S3 origin bucket

**Câu 4.** An ACM certificate was imported from a third-party CA and is attached to an ALB. What happens as the certificate nears expiry?
- A. ACM automatically renews it via DNS validation
- B. ACM automatically renews it via email validation
- C. ACM does not auto-renew imported certificates; the team must re-import a new one
- D. ALB falls back to a default AWS certificate

**Câu 5.** A team stores product data in DynamoDB but users complain they cannot do typo-tolerant full-text search across product descriptions. What is the recommended pattern?
- A. Add a GSI on the description attribute and use Query
- B. Run a parallel Scan with filter expressions on every search
- C. Stream changes via DynamoDB Streams to Lambda and index into Amazon OpenSearch Service
- D. Migrate the table to RDS and use LIKE queries

**Câu 6.** A developer must run an ad-hoc SQL analysis over years of JSON access logs stored in S3, with no servers to manage and pay only for data scanned. Which service and which optimization reduce cost the most?
- A. Amazon Athena; convert data to Parquet and partition by date
- B. Amazon Redshift; load all logs into a cluster
- C. Amazon EMR; run a Spark job over raw JSON
- D. Amazon RDS; import logs into a PostgreSQL table

**Câu 7.** A company is migrating an on-premises application that relies on the JMS and AMQP messaging protocols. They want minimal code changes. Which AWS service should they use?
- A. Amazon SQS FIFO
- B. Amazon SNS
- C. Amazon MQ
- D. Amazon Kinesis Data Streams

**Câu 8.** A data pipeline must run containerized jobs that each take 30–60 minutes and require 16 GB of memory, with job dependencies and a queue. Which compute service is most appropriate?
- A. AWS Lambda with provisioned concurrency
- B. AWS Batch
- C. Amazon API Gateway with Lambda integration
- D. AWS Step Functions Express workflow

**Câu 9.** A security team wants to automatically discover and classify sensitive data such as credit-card numbers and personal information stored across hundreds of S3 buckets. Which service should they enable?
- A. Amazon GuardDuty
- B. Amazon Inspector
- C. Amazon Macie
- D. AWS Security Hub

**Câu 10.** An application needs to send transactional emails (password resets) and track bounce and complaint rates, publishing those events to an SNS topic. Which combination is correct?
- A. Amazon SNS email subscriptions with CloudWatch alarms
- B. Amazon SES with a configuration set whose event destination is SNS
- C. Amazon SQS with a Lambda consumer that emails users
- D. Amazon Pinpoint journeys with manual log parsing

### Đáp án & giải thích

**Câu 1 — Đáp án C.** AppConfig là dịch vụ duy nhất ở đây hỗ trợ deployment strategy (canary 10%), validator, và auto-rollback gắn CloudWatch alarm mà không cần redeploy code. A/B chỉ là kho lưu giá trị, không có rollout từ từ hay rollback. D (StackSets) triển khai stack CloudFormation ra nhiều account/region — không liên quan feature flag runtime.

**Câu 2 — Đáp án B.** `GetLatestConfiguration` trả body rỗng (0 byte) khi config KHÔNG thay đổi so với lần poll trước, để tiết kiệm băng thông; ứng dụng phải giữ config đã cache. A sai: token vẫn xoay vòng qua `NextPollConfigurationToken` chứ không "hết hạn" gây rỗng. C sai: validation fail xảy ra lúc `StartDeployment`, không phải lúc poll. D sai: thiếu quyền sẽ ném AccessDenied, không phải body rỗng (và API đúng là `appconfigdata:GetLatestConfiguration`).

**Câu 3 — Đáp án C.** CloudFront yêu cầu cert public từ ACM nằm ở **us-east-1**, bất kể distribution là global. A/B/D đều sai về region. Đây là bẫy kinh điển — với ALB/API Gateway regional thì cert phải ở cùng region resource, riêng CloudFront cố định us-east-1.

**Câu 4 — Đáp án C.** ACM chỉ tự gia hạn cert do chính ACM phát hành (managed renewal, ưu tiên DNS validation). Cert **imported** từ CA bên ngoài KHÔNG được auto-renew; team phải tự import cert mới trước khi hết hạn. A/B sai vì managed renewal không áp dụng cho imported cert. D sai: ALB không tự thay cert mặc định, kết nối TLS sẽ lỗi khi cert hết hạn.

**Câu 5 — Đáp án C.** Pattern chuẩn: DynamoDB là source of truth, dùng DynamoDB Streams → Lambda để đẩy thay đổi sang OpenSearch phục vụ full-text/fuzzy search. A sai: GSI + Query không làm được tìm kiếm typo-tolerant/full-text, chỉ match theo key. B sai: parallel Scan tốn kém và filter chỉ là substring đơn giản, không relevance ranking. D sai: chuyển sang RDS LIKE không scale và mất lợi ích NoSQL.

**Câu 6 — Đáp án A.** Athena query S3 bằng SQL, serverless, trả tiền theo TB quét; tối ưu chi phí lớn nhất là chuyển sang định dạng cột nén (Parquet) và partition theo ngày để quét ít dữ liệu. B/C/D đều phải dựng/load hạ tầng (cluster, EMR, RDS) — trái yêu cầu "no servers, pay per scan".

**Câu 7 — Đáp án C.** Amazon MQ (ActiveMQ/RabbitMQ managed) hỗ trợ các giao thức chuẩn JMS/AMQP/MQTT/STOMP, lý tưởng cho lift-and-shift app cũ với ít sửa code. A/B/D dùng API riêng của AWS, buộc viết lại tầng messaging — trái yêu cầu "minimal code changes".

**Câu 8 — Đáp án B.** AWS Batch chạy job container nặng/lâu (vượt giới hạn 15 phút & 10GB của Lambda), có job queue và dependency, trên EC2/Fargate. A sai: Lambda tối đa 15 phút và 10GB RAM, không phù hợp job 30–60 phút. C sai: API Gateway là HTTP front-end, không phải batch compute. D sai: Express workflow tối đa 5 phút và để điều phối, không phải để chạy container nặng.

**Câu 9 — Đáp án C.** Amazon Macie dùng ML để phát hiện và phân loại dữ liệu nhạy cảm (PII, thẻ tín dụng) trong S3. A (GuardDuty) là threat detection. B (Inspector) quét lỗ hổng phần mềm/EC2/ECR/Lambda. D (Security Hub) tổng hợp finding từ các dịch vụ khác, không tự classify dữ liệu trong S3.

**Câu 10 — Đáp án B.** SES gửi email transactional; configuration set với event destination = SNS sẽ publish các sự kiện bounce/complaint/delivery để giám sát. A sai: SNS không phải dịch vụ gửi email phong phú và không track bounce theo địa chỉ. C sai: SQS chỉ là hàng đợi, vẫn cần một dịch vụ email. D sai: Pinpoint thiên về marketing/journey và "manual log parsing" trái với mục tiêu publish event tự động.

## Tóm tắt chương

- Chương 48 gom các dịch vụ "phụ" nhưng vẫn xuất hiện trong DVA-C02 dưới dạng câu scenario chọn-đúng-dịch-vụ; nắm "khi nào dùng cái nào" quan trọng hơn cấu hình chi tiết.
- **AppConfig** = feature flags/config có kiểm soát: configuration profile (Freeform hoặc FeatureFlags), validator (JSON Schema hoặc Lambda), deployment strategy (canary/linear/all-at-once + bake time), auto-rollback bằng CloudWatch alarm; client đọc qua `StartConfigurationSession` + `GetLatestConfiguration` (body rỗng = không đổi).
- **Amazon SES** gửi email transactional; mặc định ở **sandbox** (chỉ identity đã verify, ~200 email/ngày) đến khi xin production access; **configuration set** để track bounce/complaint/delivery qua SNS/Firehose/CloudWatch.
- **ACM**: cert public miễn phí, auto-renew chỉ cho cert do ACM phát hành + DNS validation; cert **imported** không tự gia hạn; cert cho **CloudFront phải ở us-east-1**, còn ALB/API Gateway dùng cert cùng region.
- **OpenSearch Service** cho full-text/fuzzy search và log analytics; pattern phổ biến là DynamoDB Streams → Lambda → OpenSearch để bổ sung khả năng tìm kiếm cho DynamoDB.
- **Athena** query S3 bằng SQL serverless, trả tiền theo dữ liệu quét; tối ưu bằng partitioning + Parquet/ORC; **Glue Data Catalog** cung cấp schema/metadata.
- **MSK** (Kafka managed) chọn khi cần API Kafka/migrate Kafka; **Kinesis** ít vận hành hơn và tích hợp sâu với Lambda/Firehose cho luồng dữ liệu thuần AWS.
- **AWS Batch** cho job container chạy lâu/nặng vượt giới hạn Lambda (15 phút, 10GB); có job queue + dependency, chạy trên EC2/Fargate.
- **Amazon MQ** (ActiveMQ/RabbitMQ) cho lift-and-shift hệ thống dùng JMS/AMQP/MQTT/STOMP; app mới ưu tiên SQS/SNS.
- **Macie** phát hiện PII trong S3 (khác GuardDuty = threat detection, Inspector = lỗ hổng, Security Hub = tổng hợp finding).
- **CloudWatch Evidently** dùng cho A/B testing và feature launch có đo lường, **RUM** thu thập trải nghiệm người dùng thật trên web (frontend monitoring) — bổ trợ cho AppConfig khi cần đo tác động tính năng.
- **Nitro Enclaves** tạo môi trường tính toán cô lập để xử lý dữ liệu cực nhạy cảm (không có storage/network bền vững, không SSH); chỉ cần nhận diện mục đích ở mức DVA-C02.
