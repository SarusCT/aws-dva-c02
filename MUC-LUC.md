# Giáo trình ôn luyện AWS Certified Developer – Associate (DVA-C02)

50 chương, từ cơ bản đến nâng cao. Mỗi chương ~5000 từ gồm: lý thuyết sâu + code SDK/CLI + hands-on lab + exam tips + quiz 10 câu có giải thích.

## PHẦN I — NỀN TẢNG AWS (Chương 1–11)

### Chương 1: Tổng quan AWS & Kỳ thi DVA-C02
Phạm vi: Cloud computing & AWS Global Infrastructure (Regions, AZs, Edge Locations, Local Zones); shared responsibility model; cách chọn region; tổng quan 4 domain của đề DVA-C02 (Development 32%, Security 26%, Deployment 24%, Troubleshooting & Optimization 18%); hình thức thi, đăng ký, chi phí, lộ trình ôn theo giáo trình này; tạo AWS account, billing alarm, free tier.

### Chương 2: IAM — Identity and Access Management
Phạm vi: Users, Groups, Roles, Policies; cấu trúc policy JSON (Effect/Action/Resource/Condition); identity-based vs resource-based policy; policy evaluation logic (explicit deny); IAM Roles cho services; MFA; Access Keys; IAM best practices; password policy; Credential Report & Access Advisor. (STS, federation, permission boundaries nâng cao → Chương 45.)

### Chương 3: AWS CLI & SDK
Phạm vi: Cài đặt & cấu hình AWS CLI v2; named profiles; credentials provider chain; AWS SDK for JavaScript v3 & Go SDK v2 — cài đặt, client, pagination, waiters; SigV4 signing; exponential backoff & retry; CLI dry-run, --query/--output; CloudShell; MFA với CLI (STS get-session-token mức cơ bản).

### Chương 4: EC2 Fundamentals
Phạm vi: AMI; instance types & naming; Security Groups (stateful, rules, referencing SG); key pairs & SSH; EC2 User Data; instance metadata service IMDSv2; purchasing options (On-Demand, Reserved, Savings Plans, Spot, Dedicated); placement groups; Elastic IP; EC2 Instance Connect; IAM Role gắn EC2.

### Chương 5: EC2 Instance Storage — EBS, EFS, Instance Store
Phạm vi: EBS volumes & volume types (gp2/gp3, io1/io2, st1/sc1); EBS snapshots (archive, recycle bin, FSR); AMI tạo từ snapshot; EBS multi-attach; EBS encryption; Instance Store; EFS (performance modes, throughput modes, storage classes, EFS vs EBS); mount EFS đa AZ.

### Chương 6: Elastic Load Balancing (ELB)
Phạm vi: Vì sao cần load balancer; health checks; CLB (legacy) / ALB / NLB / GWLB; ALB: target groups, listener rules, routing theo path/host/query, X-Forwarded-For; NLB: static IP, TCP/UDP, performance; sticky sessions; cross-zone load balancing; SSL/TLS termination & SNI; connection draining / deregistration delay.

### Chương 7: Auto Scaling Groups (ASG)
Phạm vi: Launch Templates; ASG attributes, min/max/desired; scaling policies (target tracking, simple/step, scheduled, predictive); CloudWatch metrics cho scaling (CPU, RequestCountPerTarget, custom); scaling cooldowns; instance refresh; lifecycle hooks; termination policies; ASG + ALB health check.

### Chương 8: RDS & Aurora
Phạm vi: RDS engines; RDS vs tự quản DB trên EC2; storage auto scaling; Read Replicas (use cases, cross-region, async) vs Multi-AZ (sync, failover); RDS backup, snapshots, restore, point-in-time; Aurora kiến trúc (6 copies, 3 AZ), Aurora replicas & endpoints (writer/reader/custom), Aurora Serverless, Global Database; RDS Proxy; IAM database authentication; encryption at rest/in transit.

### Chương 9: ElastiCache — Redis & Memcached
Phạm vi: Vì sao cần cache; Redis vs Memcached (replication, persistence, multi-threaded); caching strategies: lazy loading / cache-aside, write-through; cache eviction & TTL; session store pattern; Redis sorted sets (gaming leaderboard), pub/sub; cluster mode; security (AUTH, TLS, SG); những điểm DVA hay hỏi về consistency cache-DB.

### Chương 10: Route 53
Phạm vi: DNS căn bản (TLD, record, TTL); hosted zones public/private; record types (A, AAAA, CNAME, NS, alias); CNAME vs Alias; routing policies: simple, weighted, latency, failover, geolocation, geoproximity, IP-based, multi-value; health checks (endpoint, calculated, CloudWatch alarm); domain registration & DNS migration.

### Chương 11: VPC cho Developer
Phạm vi: Mức độ VPC cần cho DVA-C02: VPC, CIDR, subnets public/private; Internet Gateway, NAT Gateway/Instance; Route Tables; NACL vs Security Group (stateless vs stateful); VPC Endpoints (Gateway cho S3/DynamoDB, Interface/PrivateLink); VPC Peering; VPC Flow Logs; 3-tier architecture điển hình; Site-to-Site VPN & Direct Connect (chỉ mức nhận diện).

## PHẦN II — STORAGE & CONTENT DELIVERY (Chương 12–15)

### Chương 12: Amazon S3 cơ bản
Phạm vi: Buckets & objects, key, max size, multipart bắt buộc khi nào; durability & availability; versioning; static website hosting; replication CRR/SRR; storage classes (Standard, IA, One Zone-IA, Glacier Instant/Flexible/Deep Archive, Intelligent-Tiering) & so sánh; S3 với SDK Node.js (put/get/list, presigned URL mức giới thiệu).

### Chương 13: Advanced S3
Phạm vi: Lifecycle rules & transitions; S3 Analytics; event notifications (SNS/SQS/Lambda, EventBridge); performance: request rate per prefix, multipart upload, Transfer Acceleration, byte-range fetches; S3 Select & Glacier Select; S3 Batch Operations; S3 Storage Lens; requester pays; checksums & S3 inventory.

### Chương 14: Amazon S3 Security
Phạm vi: Encryption: SSE-S3, SSE-KMS (+ bucket key, KMS limits), SSE-C, client-side; encryption in transit, bucket policy ép HTTPS/encryption; default encryption; CORS; MFA Delete; presigned URLs chi tiết; bucket policies & block public access; access points & Object Lambda; S3 Object Lock & Glacier Vault Lock; access logs.

### Chương 15: CloudFront
Phạm vi: CDN & edge locations; origins (S3 + OAC, custom/ALB); caching & cache policies, cache key, TTL, invalidation; cache behaviors theo path; geo restriction; signed URL vs signed cookies (so với S3 presigned); CloudFront + HTTPS (viewer/origin protocol policy); Origin Shield, origin failover; CloudFront Functions vs Lambda@Edge; field-level encryption; real-time logs.

## PHẦN III — CONTAINERS & PLATFORM DEPLOYMENT (Chương 16–20)

### Chương 16: Docker trên AWS & Amazon ECR
Phạm vi: Docker recap cho exam (image, container, Dockerfile, registry); các lựa chọn chạy container trên AWS (ECS, EKS, Fargate, App Runner, Lambda container); ECR: private/public repo, push/pull, IAM permissions, lifecycle policies, image scanning, cross-region/cross-account; docker login với ECR; multi-arch images.

### Chương 17: ECS & Fargate
Phạm vi: ECS architecture: cluster, task definition, task, service; launch types EC2 vs Fargate; task role vs execution role; networking modes (awsvpc); ALB integration & dynamic port mapping; service auto scaling (target tracking trên CPU/Memory/ALB request count); ECS + EFS; rolling update & deployment circuit breaker; capacity providers; environment variables & secrets trong task definition; ECS Exec; EKS mức nhận diện.

### Chương 18: AWS Elastic Beanstalk
Phạm vi: Beanstalk concepts (application, environment, version); web server vs worker environment; deployment policies: all-at-once, rolling, rolling with additional batches, immutable, traffic splitting; blue/green với swap CNAME; .ebextensions; saved configurations; cloning; EB CLI; Beanstalk + CloudFormation bên dưới; migration (RDS decouple); lifecycle policy cho versions.

### Chương 19: AWS CloudFormation cơ bản
Phạm vi: Infrastructure as Code; template anatomy: AWSTemplateFormatVersion, Parameters (types, constraints, SSM types), Resources, Outputs & cross-stack reference (Export/ImportValue), Metadata; intrinsic functions: Ref, Fn::GetAtt, Fn::Sub, Fn::Join, Fn::FindInMap, Fn::ImportValue; stack create/update/delete; rollback behavior; YAML cho CFN.

### Chương 20: AWS CloudFormation nâng cao
Phạm vi: Mappings; Conditions & Fn::If; pseudo parameters; nested stacks vs cross-stack; ChangeSets; StackSets; drift detection; stack policies; termination protection; DeletionPolicy (Retain/Snapshot/Delete) & UpdateReplacePolicy; custom resources (Lambda-backed); cfn-init/cfn-signal/cfn-hup & CreationPolicy; DependsOn; capabilities (CAPABILITY_IAM/NAMED_IAM/AUTO_EXPAND); service role; import resources.

## PHẦN IV — MESSAGING & INTEGRATION (Chương 21–23)

### Chương 21: Amazon SQS
Phạm vi: Vì sao decouple; standard queue (at-least-once, best-effort ordering, unlimited throughput); producing/consuming với SDK; visibility timeout & ChangeMessageVisibility; long polling vs short polling; Dead Letter Queue & redrive policy/redrive to source; delay queues & message timers; message size 256KB & Extended Client Library; FIFO queues (ordering, deduplication, message group ID, throughput & high-throughput mode); SQS + ASG scaling theo queue depth; SQS access policies; encryption; temporary queues.

### Chương 22: Amazon SNS
Phạm vi: Pub/sub model; topics, subscriptions & protocols; fan-out pattern SNS→SQS (vì sao, cấu hình access policy); SNS→Lambda, SNS→Kinesis Firehose; message filtering (filter policies); FIFO topics & SNS FIFO + SQS FIFO; message attributes; delivery retries & DLQ cho SNS; raw message delivery; SNS vs SQS vs EventBridge khi nào dùng gì.

### Chương 23: Amazon Kinesis
Phạm vi: Kinesis Data Streams: shards, partition key, sequence number, retention, capacity modes (provisioned vs on-demand), hot shard, resharding; producers (SDK, KPL, Agent) & ProvisionedThroughputExceeded xử lý; consumers (SDK, KCL & checkpointing với DynamoDB, Lambda, enhanced fan-out); Kinesis Data Firehose (near real-time, destinations, transformation với Lambda, buffer); Managed Service for Apache Flink; SQS vs SNS vs Kinesis bảng so sánh quyết định; ordering vào Kinesis vs SQS FIFO.

## PHẦN V — MONITORING & AUDIT (Chương 24–27)

### Chương 24: CloudWatch Metrics & Alarms
Phạm vi: Namespaces, metrics, dimensions; EC2 metrics mặc định & detailed monitoring; custom metrics (PutMetricData, resolution standard vs high-resolution, storage resolution); CloudWatch Alarms: states, evaluation period, datapoints to alarm, actions (EC2, ASG, SNS); composite alarms; alarm trên metric filter; CloudWatch Dashboards; anomaly detection; billing alarm; metric math.

### Chương 25: CloudWatch Logs & Amazon EventBridge
Phạm vi: Log groups/streams, retention; gửi log: SDK, CloudWatch Logs Agent vs Unified Agent, Lambda/ECS/EB logging; metric filters; Logs Insights; subscription filters (→Lambda, Firehose, Kinesis) & cross-account; log encryption KMS; Live Tail; EventBridge: default vs custom vs partner event bus, rules (event pattern & schedule), targets, input transformation; archive & replay; schema registry; resource-based policy cho cross-account events; EventBridge vs CloudWatch Events.

### Chương 26: AWS X-Ray
Phạm vi: Distributed tracing concepts; X-Ray daemon; instrumentation SDK (Node.js): segments, subsegments, annotations vs metadata, sampling rules; service map; X-Ray với Lambda (active tracing), API Gateway, ECS (sidecar pattern), Beanstalk; IAM permissions cho X-Ray; trace header X-Amzn-Trace-Id; X-Ray vs CloudWatch ServiceLens; OpenTelemetry/ADOT mức nhận diện; troubleshooting "không thấy trace" — checklist.

### Chương 27: AWS CloudTrail & Audit
Phạm vi: CloudTrail events: management vs data vs insights events; event history 90 ngày; trails (single/all region, org trail) → S3/CloudWatch Logs; log file integrity validation; CloudTrail vs CloudWatch vs X-Ray — bảng phân biệt kinh điển trong đề; ví dụ điều tra "ai đã xoá resource"; AWS Config mức nhận diện (so sánh vai trò); AWS Health Dashboard.

## PHẦN VI — SERVERLESS CORE (Chương 28–35)

### Chương 28: AWS Lambda cơ bản
Phạm vi: Serverless là gì; Lambda concepts: function, handler (Node.js), event & context object, runtimes; invocation: synchronous (CLI/SDK/API GW/ALB) vs asynchronous (S3/SNS/EventBridge, retries & DLQ/destinations) vs event source mapping (giới thiệu); execution environment & lifecycle (cold start, init); environment variables; memory/CPU & timeout (limits chính xác); Lambda execution role & resource-based policy; pricing; logging & metrics cơ bản; viết & deploy function đầu tiên bằng CLI.

### Chương 29: AWS Lambda nâng cao
Phạm vi: Concurrency: account limit, reserved vs provisioned concurrency, throttling (429), burst; versions & aliases, weighted alias (canary); Lambda layers; container images cho Lambda; SnapStart; /tmp storage & ephemeral storage config; Lambda + EFS; Lambda trong VPC (ENI, cần gì để ra internet); performance tuning (memory↔CPU, bundle size); Lambda@Edge & CloudFront Functions so sánh; code signing; function URLs; recursive loop detection.

### Chương 30: Lambda Integrations & Event Source Mappings
Phạm vi: Event source mapping chi tiết: SQS (batch size, batch window, partial batch response, DLQ đặt ở queue), Kinesis/DynamoDB Streams (batch, starting position, bisect on error, parallelization factor, on-failure destination, ordering theo shard); Lambda + ALB (target group, multi-header); Lambda destinations vs DLQ; idempotency patterns; error handling từng loại invocation; thiết kế retry an toàn; ví dụ pipeline S3→Lambda→DynamoDB hoàn chỉnh bằng SDK v3.

### Chương 31: Amazon DynamoDB cơ bản
Phạm vi: NoSQL vs RDBMS, khi nào chọn DynamoDB; tables, items, attributes; primary key: partition key vs partition+sort key, chọn partition key tốt (cardinality, hot partition); capacity modes: provisioned (RCU/WCU — CÁCH TÍNH chi tiết, eventually vs strongly consistent đọc tốn bao nhiêu) vs on-demand; throttling & ProvisionedThroughputExceededException; basic APIs: PutItem, GetItem, UpdateItem, DeleteItem, BatchGetItem/BatchWriteItem; Query vs Scan (filter expression, projection, pagination, parallel scan); DocumentClient/lib-dynamodb Node.js.

### Chương 32: Amazon DynamoDB nâng cao
Phạm vi: LSI vs GSI (khi tạo được, key khác gì, GSI throttling ảnh hưởng bảng chính, projection); conditional writes & ConditionExpression; optimistic locking với version number; transactions (TransactWriteItems/TransactGetItems, capacity tốn gấp đôi); PartiQL; thiết kế single-table mức giới thiệu; patterns: atomic counters, write sharding; large objects pattern (S3 + metadata); pagination đúng cách (LastEvaluatedKey); expression attribute names/values.

### Chương 33: DynamoDB DAX, Streams, TTL & Global Tables
Phạm vi: DAX: kiến trúc, item cache vs query cache, khi nào dùng DAX vs ElastiCache; DynamoDB Streams: view types, integration Lambda (event source mapping), use cases (audit, replication, materialized views); TTL (cơ chế xoá, không tốn WCU, kết hợp Streams); Global Tables (yêu cầu streams, last-writer-wins); backup: on-demand, PITR; export to S3; DynamoDB Local; IAM fine-grained access (LeadingKeys, Attributes).

### Chương 34: Amazon API Gateway cơ bản
Phạm vi: API Gateway tổng quan & endpoint types (edge-optimized, regional, private); REST API: resources, methods; integrations: Lambda proxy vs non-proxy (mapping templates VTL), HTTP, AWS service, Mock; request/response flow: method request → integration request → integration response → method response; stages & stage variables (kết hợp Lambda alias); deployments; canary deployment; models & request validation; gateway responses; binary media types; import/export OpenAPI.

### Chương 35: Amazon API Gateway nâng cao
Phạm vi: Security & auth: IAM (SigV4) vs Lambda authorizer (token/request, caching) vs Cognito User Pools authorizer — bảng chọn; resource policies (private API, IP allowlist, cross-account); usage plans & API keys (thứ tự cấu hình đúng — câu hỏi kinh điển); throttling (account limit 10000 rps, 429, per-client); caching (per stage, TTL, invalidation, encrypted); CORS với API Gateway; CloudWatch metrics (4XX/5XX/Latency/IntegrationLatency/CacheHitCount), access logs, X-Ray; WebSocket APIs (routes, connections, @connections callback); HTTP API vs REST API so sánh chi tiết; custom domain names + ACM; mutual TLS.

## PHẦN VII — SERVERLESS TOOLING & IDENTITY (Chương 36–39)

### Chương 36: AWS SAM — Serverless Application Model
Phạm vi: SAM template (Transform, Globals, resource types: Function, Api, SimpleTable, HttpApi, StateMachine); sam build / package / deploy (guided); sam local invoke / start-api / start-lambda & generate-event; SAM policy templates (DynamoDBCrudPolicy, SQSPollerPolicy...); SAM + API Gateway events, environment variables, layers; SAM + CodeDeploy (AutoPublishAlias, DeploymentPreference, canary/linear, hooks PreTraffic/PostTraffic, alarms rollback); SAM Accelerate (sam sync); SAR — Serverless Application Repository; so sánh SAM vs CloudFormation thuần.

### Chương 37: AWS CDK — Cloud Development Kit
Phạm vi: CDK vs SAM vs CloudFormation vs Terraform; CDK app structure: app, stacks, constructs (L1/L2/L3); cdk init/synth/diff/deploy/destroy; bootstrapping; CDK với TypeScript (ví dụ chính) — Lambda + API Gateway + DynamoDB stack hoàn chỉnh; assets; permissions & grants (table.grantReadWriteData); environment (account/region); CDK testing (assertions, snapshot); CDK + SAM CLI local testing; aspects & tags; context & feature flags; CDK Pipelines mức giới thiệu.

### Chương 38: Amazon Cognito User Pools
Phạm vi: Authentication vs Authorization; User Pools: sign-up/sign-in flow, user attributes, password policy, MFA; JWT tokens (ID/access/refresh — đọc & verify, JWKS); app clients & hosted UI; social & SAML/OIDC federation vào User Pool; Lambda triggers (pre sign-up, post confirmation, pre token generation...); adaptive authentication; integration: API Gateway Cognito authorizer, ALB authentication; user pool groups & role mapping; SDK flows (USER_PASSWORD_AUTH, SRP) với amazon-cognito-identity-js / Amplify Auth.

### Chương 39: Cognito Identity Pools & Cognito Sync
Phạm vi: Identity Pools (Federated Identities): cấp AWS credentials tạm cho user (qua STS), authenticated vs unauthenticated identities, identity providers (User Pool, social, SAML, developer authenticated); IAM roles & role mapping (rules, token claims); trust policy với cognito-identity; fine-grained access: policy variables ${cognito-identity.amazonaws.com:sub} với S3 prefix & DynamoDB LeadingKeys; User Pools vs Identity Pools — bảng phân biệt kinh điển; kiến trúc kết hợp cả hai; Cognito Sync (legacy) → AppSync; ví dụ end-to-end: web app upload S3 trực tiếp bằng credentials từ Identity Pool.

## PHẦN VIII — CI/CD TRÊN AWS (Chương 40–42)

### Chương 40: CodeCommit & CodeBuild
Phạm vi: CI/CD concepts (continuous integration/delivery/deployment); CodeCommit: repo, auth (SSH/HTTPS/GRC), IAM policies, triggers & notifications, trạng thái dịch vụ hiện tại & migration sang GitHub (đề vẫn hỏi); CodeBuild: build projects, buildspec.yml chi tiết (phases, env, artifacts, cache, reports), environment images & custom image, env variables & Secrets Manager/SSM trong build, local build với agent, build trong VPC, logs & metrics; CodeBuild + ECR build & push image; test reports.

### Chương 41: CodeDeploy
Phạm vi: Deployment targets: EC2/on-premises, Lambda, ECS; appspec.yml từng loại (hooks lifecycle EC2: BeforeInstall→ValidateService...; Lambda: BeforeAllowTraffic/AfterAllowTraffic; ECS); deployment configs: in-place vs blue/green (EC2), canary/linear/all-at-once (Lambda, ECS); CodeDeploy agent; rollback tự động với CloudWatch alarms; deployment groups & tags; integration ASG; troubleshooting deployment failures; CodeDeploy + SAM/Lambda alias shifting.

### Chương 42: CodePipeline & các công cụ CI/CD khác
Phạm vi: CodePipeline: stages, actions (source/build/test/deploy/approval/invoke), action providers (GitHub via CodeStar connection, S3, ECR), artifacts giữa stages (S3), manual approval + SNS, EventBridge triggers vs polling/webhooks; cross-region & cross-account actions; pipeline cho serverless (SAM + CloudFormation deploy action); CodeArtifact (npm/pip proxy, domains, repositories, upstream, EventBridge); Amazon CodeGuru (Reviewer & Profiler); CodeStar/CodeCatalyst mức nhận diện; ví dụ pipeline hoàn chỉnh: CodeCommit/GitHub → CodeBuild → CodeDeploy → ECS/Lambda.

## PHẦN IX — ADVANCED SERVERLESS, IDENTITY & SECURITY (Chương 43–48)

### Chương 43: AWS Step Functions
Phạm vi: State machine & Amazon States Language; state types: Task, Choice, Wait, Parallel, Map (inline vs distributed), Pass, Succeed, Fail; standard vs express workflows (pricing, duration, exactly-once vs at-least-once); error handling: Retry, Catch, ErrorEquals, backoff; service integrations & integration patterns: request-response, run a job (.sync), wait for callback (.waitForTaskToken); Step Functions + Lambda/SQS/SNS/DynamoDB/ECS; input/output processing (InputPath, Parameters, ResultPath, OutputPath, ResultSelector); ví dụ order-processing workflow hoàn chỉnh; X-Ray cho Step Functions; Activities (legacy).

### Chương 44: AWS AppSync & Amplify
Phạm vi: GraphQL recap (schema, query, mutation, subscription); AppSync: resolvers (unit/pipeline, JS resolvers vs VTL), data sources (DynamoDB, Lambda, HTTP, OpenSearch, RDS); real-time subscriptions (WebSocket); security: API key, IAM, Cognito User Pools, OIDC, Lambda auth; caching; offline & conflict resolution; AppSync vs API Gateway; AWS Amplify: CLI, hosting (CI/CD từ Git), Amplify libraries (Auth, API, Storage), Amplify Studio mức giới thiệu; khi nào chọn Amplify.

### Chương 45: Advanced Identity — STS, Federation & IAM nâng cao
Phạm vi: STS APIs: AssumeRole (cross-account flow chi tiết, trust policy + permission policy, ExternalId chống confused deputy), AssumeRoleWithSAML, AssumeRoleWithWebIdentity (vs Cognito Identity Pools), GetSessionToken (MFA), GetFederationToken; session duration & revoke; IAM nâng cao: policy evaluation đầy đủ (identity + resource-based + permission boundary + SCP + session policy), permission boundaries use cases, ABAC với tags (aws:PrincipalTag, aws:ResourceTag), policy variables; IAM Identity Center (SSO) mức nhận diện; Resource Access Manager mức nhận diện; câu hỏi kinh điển cross-account S3/KMS.

### Chương 46: AWS KMS & Encryption
Phạm vi: Encryption căn bản (at rest/in transit, symmetric/asymmetric); KMS keys: AWS managed vs customer managed vs AWS owned; multi-region keys; key policies (default vs custom, kết hợp IAM); Encrypt/Decrypt/GenerateDataKey APIs & limits (4KB direct encrypt); envelope encryption chi tiết — vì sao và flow; AWS Encryption SDK (data key caching); automatic key rotation vs manual; ViaService condition; grants; cross-account KMS; KMS với S3/EBS/RDS/Lambda env vars/SQS/Secrets; ThrottlingException & request quotas; CloudHSM vs KMS mức so sánh.

### Chương 47: SSM Parameter Store & AWS Secrets Manager
Phạm vi: Parameter Store: standard vs advanced tier, parameter policies (expiration, no-change notification), hierarchy & GetParametersByPath, SecureString với KMS, public parameters; IAM cho parameters; Lambda đọc parameter (cache với extension); Secrets Manager: secret rotation (managed rotation RDS, custom Lambda rotation), cross-region replication, resource policy; pricing & so sánh Parameter Store vs Secrets Manager — bảng quyết định kinh điển; CloudFormation dynamic references ({{resolve:ssm}}, {{resolve:secretsmanager}}); ECS/CodeBuild lấy secrets; cache secrets trong code đúng cách.

### Chương 48: Các dịch vụ khác trong phạm vi DVA-C02
Phạm vi: Amazon SES (transactional email, configuration sets, SDK); ACM — Certificate Manager (public/private certs, validation, renewal, dùng với ALB/CloudFront/API Gateway); OpenSearch Service (use cases, vs DynamoDB query); Amazon Athena (query S3, partitioning, federated query) & Glue mức nhận diện; Amazon MSK vs Kinesis; AWS AppConfig (feature flags, deployment strategies, validators); CloudWatch Evidently & RUM; AWS Batch vs Lambda; Amazon MQ; Macie; AWS Nitro Enclaves mức nhận diện; bảng "service nào cho tình huống nào" tổng hợp.

## PHẦN X — LUYỆN THI (Chương 49–50)

### Chương 49: Bộ đề luyện thi mô phỏng DVA-C02 (65 câu) kèm giải thích chi tiết
Phạm vi: Đề mô phỏng đủ 65 câu đúng phân bố 4 domain của DVA-C02 (Development 32%, Security 26%, Deployment 24%, Troubleshooting & Optimization 18%); dạng câu scenario "A developer needs to..."; mỗi câu có đáp án + giải thích vì sao đúng và vì sao từng phương án sai + chương tham chiếu để ôn lại.

### Chương 50: Tips làm bài & chiến lược ôn tập
Phạm vi: Phân tích cấu trúc đề DVA-C02 (65 câu/130 phút, 15 câu unscored, thang điểm 100-1000, pass 720); chiến lược thời gian & flag câu hỏi; kỹ thuật loại trừ đáp án; từ khoá nhận diện đáp án ("least operational overhead" → managed/serverless, "most cost-effective", "near real-time"...); các cặp service hay gài bẫy & cách phân biệt nhanh (bảng tổng hợp toàn giáo trình); lộ trình ôn 4 tuần & 8 tuần; checklist kiến thức từng domain; kinh nghiệm đăng ký, thi online vs test center; làm gì khi không chắc đáp án; sau khi đậu: lộ trình tiếp theo.
