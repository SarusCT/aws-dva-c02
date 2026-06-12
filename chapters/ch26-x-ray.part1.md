# Chương 26: AWS X-Ray

> **Trọng tâm DVA-C02:** X-Ray là dịch vụ distributed tracing — chủ đề này rơi vào domain Troubleshooting & Optimization và Monitoring. Đề thi hay hỏi: muốn tìm bottleneck/latency trong kiến trúc microservice hoặc serverless thì dùng gì (đáp án: X-Ray, KHÔNG phải CloudWatch Logs hay CloudTrail), cách bật tracing cho Lambda/API Gateway/ECS, phân biệt annotation vs metadata (cái nào filter được), IAM permission cần cấp, và checklist khi "đã bật X-Ray nhưng không thấy trace".

## Mục tiêu chương
- Hiểu distributed tracing là gì và X-Ray giải quyết vấn đề "request đi qua nhiều service thì chậm ở đâu" như thế nào.
- Nắm vững mô hình dữ liệu của X-Ray: trace, segment, subsegment, annotation, metadata, và trace header `X-Amzn-Trace-Id`.
- Biết X-Ray daemon là gì, vì sao cần nó, và khi nào KHÔNG cần (Lambda, Fargate).
- Instrument code Node.js bằng X-Ray SDK v3: capture AWS SDK call, HTTP call, tạo custom subsegment, gắn annotation để filter.
- Bật và đọc trace cho các tích hợp: Lambda (active tracing), API Gateway, ECS sidecar, Beanstalk.
- Cấu hình sampling rules để kiểm soát chi phí; cấp đúng IAM permission; phân biệt X-Ray vs CloudWatch ServiceLens; nhận diện OpenTelemetry/ADOT.
- Có checklist troubleshooting "không thấy trace" để xử lý nhanh trong thực tế và trong câu hỏi tình huống của đề.

## 26.1 Distributed tracing là gì và vì sao cần X-Ray

Khi bạn còn một monolith chạy trên một server, debug latency khá đơn giản: bật log, đo thời gian từng hàm. Nhưng khi kiến trúc tách thành microservice hoặc serverless — một request từ client đi qua API Gateway → Lambda A → gọi DynamoDB → gửi message vào SQS → Lambda B xử lý → ghi S3 — thì câu hỏi "tại sao request này mất 4 giây?" trở nên rất khó. Log của từng service nằm rời rạc ở từng log group, không có cách nào nối chúng lại theo cùng MỘT request.

**Distributed tracing** giải quyết đúng vấn đề này: gắn cho mỗi request một **trace ID** duy nhất, propagate (lan truyền) trace ID đó qua mọi service mà request đi qua, rồi thu thập thời gian xử lý ở từng chặng về một nơi để dựng lại bức tranh end-to-end. Bạn nhìn vào một trace là thấy ngay: API Gateway tốn 5ms, Lambda init (cold start) 800ms, DynamoDB query 12ms, còn lại 3 giây là do một HTTP call ra service bên ngoài bị treo.

AWS X-Ray là dịch vụ distributed tracing managed của AWS. Nó làm ba việc chính:
1. **Thu thập** trace data từ application (qua SDK hoặc agent) và từ các AWS service đã tích hợp sẵn.
2. **Dựng service map** — sơ đồ đồ thị các node (service) và cạnh (lời gọi giữa chúng), kèm latency, error rate, fault rate ở từng node.
3. **Cho phép truy vấn/filter** trace theo nhiều tiêu chí (theo URL, theo annotation, theo trạng thái lỗi, theo response time) để khoanh vùng vấn đề.

> 💡 **Exam Tip:** Khi đề mô tả tình huống "a microservices application has high latency and the developer needs to identify which component is the bottleneck" hoặc "trace requests as they travel through multiple services" — đáp án gần như chắc chắn là **AWS X-Ray**. CloudWatch Logs cho bạn log rời rạc, CloudWatch Metrics cho bạn số liệu tổng hợp, CloudTrail cho bạn audit API call — không cái nào dựng được bức tranh end-to-end của MỘT request như X-Ray.

X-Ray phù hợp nhất với kiến trúc serverless và microservice trên AWS. Nó KHÔNG phải công cụ profiling chi tiết từng dòng code (việc đó là CodeGuru Profiler), cũng không phải log aggregation (việc đó là CloudWatch Logs Insights).

## 26.2 Mô hình dữ liệu: trace, segment, subsegment

Hiểu đúng bốn khái niệm này là chìa khoá để vừa làm bài thi vừa đọc được service map thực tế.

- **Trace:** tập hợp tất cả dữ liệu của MỘT request khi nó đi xuyên qua hệ thống. Mỗi trace có một `trace_id` duy nhất. Đây là đơn vị bạn nhìn thấy trong X-Ray console khi click vào một dòng.
- **Segment:** dữ liệu mà MỘT service (một node trong service map) ghi lại cho request đó. Ví dụ Lambda function của bạn tạo ra một segment chứa thời gian bắt đầu/kết thúc, tài nguyên (compute), và kết quả (ok/error/fault/throttle). Một service = một segment trong một trace.
- **Subsegment:** chia nhỏ một segment để mô tả các công việc bên trong service đó — ví dụ "thời gian gọi DynamoDB", "thời gian gọi HTTP tới service X", hoặc một đoạn business logic bạn tự đo. Các AWS service downstream mà bạn gọi sẽ tự động xuất hiện thành subsegment khi bạn instrument AWS SDK.
- **Segment document:** chính là JSON mà SDK/daemon gửi lên X-Ray. Bạn hiếm khi viết tay nó, nhưng biết nó là JSON giúp hiểu vì sao annotation/metadata được lưu khác nhau.

Cấu trúc `trace_id` của X-Ray có dạng `1-<8 hex epoch>-<24 hex random>`, ví dụ `1-581cf771-a006649127e371903a2de979`. Phần giữa là timestamp Unix dạng hex của thời điểm tạo trace — đây là lý do X-Ray chỉ giữ trace trong **30 ngày** và bạn không truy vấn được trace cũ hơn.

> 💡 **Exam Tip:** Nhớ quan hệ phân cấp: **trace chứa nhiều segment, segment chứa nhiều subsegment**. Subsegment là nơi bạn thấy chi tiết lời gọi downstream (DynamoDB, S3, HTTP bên ngoài). Nếu câu hỏi nói "developer wants to record timing of a specific function or external HTTP call within a service" thì câu trả lời là tạo **subsegment**.

## 26.3 Annotations vs Metadata vs Sampling — ba thứ rất hay bị gài

Trong mỗi segment/subsegment bạn có thể đính kèm dữ liệu bổ sung. Có hai loại, và đề thi RẤT hay hỏi phân biệt:

| Tiêu chí | Annotations | Metadata |
|---|---|---|
| Mục đích | Dữ liệu để **filter và search** trace | Dữ liệu để **debug**, chỉ để xem |
| Index | Có — được index, dùng được trong filter expression | Không index |
| Kiểu giá trị | string, number, boolean (key-value đơn giản) | Bất kỳ object/JSON tuỳ ý |
| Giới hạn | Tối đa **50 annotation** mỗi trace | Không bị giới hạn số lượng như annotation |
| Ví dụ dùng | `customer_tier = "gold"`, `order_id = "A123"` | toàn bộ request payload, object cấu hình |

Quy tắc nhớ: **Annotation = filter được; Metadata = không filter được, chỉ để đọc khi mở trace ra.** Nếu bạn muốn sau này gõ vào ô filter của X-Ray console kiểu `annotation.customer_tier = "gold"` để lọc ra mọi trace của khách VIP, bạn PHẢI dùng annotation. Nhét nó vào metadata thì không lọc được.

> 💡 **Exam Tip:** Câu hỏi kinh điển: "A developer wants to filter X-Ray traces by a custom business value such as customer ID." → Đáp án: dùng **annotations** (vì được indexed/searchable), KHÔNG dùng metadata. Đây là cặp gài bẫy phổ biến nhất của chương này.

**Sampling** là cơ chế X-Ray dùng để KHÔNG trace 100% request — tiết kiệm chi phí và overhead. Mặc định, sampling rule là: **1 request đầu tiên mỗi giây** (reservoir) **cộng 5% các request còn lại** (rate). Nghĩa là dù app nhận 10.000 req/s, X-Ray không ghi hết — nó đảm bảo tối thiểu 1 req/s được trace và lấy thêm 5% phần còn lại. Bạn có thể tạo sampling rule tuỳ chỉnh (xem 26.7) theo URL path, service name, HTTP method... để trace nhiều hơn ở endpoint quan trọng và ít hơn ở healthcheck.

## 26.4 X-Ray daemon — khi nào cần, khi nào không

X-Ray SDK trong code KHÔNG gửi segment trực tiếp lên X-Ray API. Thay vào đó nó gửi qua **UDP cổng 2000** tới một tiến trình trung gian gọi là **X-Ray daemon**. Daemon gom (buffer) các segment rồi đẩy theo batch lên X-Ray service qua API (cổng HTTPS). Thiết kế này giúp code app không bị block bởi network call lên X-Ray, và giảm số request lên API.

Hệ quả thực tế: trên các môi trường bạn TỰ quản compute, bạn phải tự chạy daemon:
- **EC2:** cài daemon như một process/agent (hoặc qua user data, hoặc package). App gửi UDP 2000 tới localhost.
- **ECS trên EC2 / Fargate:** chạy daemon như một **sidecar container** trong cùng task definition (xem 26.6).
- **On-premises:** chạy daemon binary, trỏ về region AWS.

Ngược lại, có những môi trường AWS **chạy sẵn daemon cho bạn**, bạn không cần cài gì:
- **AWS Lambda:** khi bật active tracing, môi trường Lambda đã có daemon sẵn. Bạn chỉ cần SDK (hoặc thậm chí không cần, vì Lambda tự tạo segment gốc).
- **AWS Elastic Beanstalk:** có option bật X-Ray daemon ngay trong cấu hình môi trường (hoặc qua `.ebextensions`).

> 💡 **Exam Tip:** "Application running on EC2 needs to send traces to X-Ray" → bạn cần (1) cài/chạy **X-Ray daemon** trên instance và (2) gắn **IAM role** cho EC2 có quyền `xray:PutTraceSegments`. Với **Lambda** thì KHÔNG cần cài daemon — chỉ cần bật active tracing và cấp policy. Daemon dùng **UDP port 2000**.

## 26.5 Instrument code Node.js với X-Ray SDK (AWS SDK JS v3)

Với code chạy ngoài Lambda (ví dụ Express trên EC2/ECS), bạn dùng package `aws-xray-sdk`. Có hai phần thường làm: (1) capture mọi lời gọi AWS SDK để chúng tự thành subsegment, (2) tạo custom subsegment và gắn annotation/metadata.

Capture AWS SDK v3 client (lưu ý cú pháp v3 khác v2):

```javascript
// npm i aws-xray-sdk aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb
const AWSXRay = require('aws-xray-sdk');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand } = require('@aws-sdk/lib-dynamodb');

// Bọc client SDK v3 để mọi call tự sinh subsegment trên X-Ray
const ddbClient = AWSXRay.captureAWSv3Client(new DynamoDBClient({}));
const ddb = DynamoDBDocumentClient.from(ddbClient);

async function getOrder(orderId) {
  // Lời gọi này sẽ xuất hiện thành subsegment "DynamoDB" trong trace
  const res = await ddb.send(new GetCommand({
    TableName: 'Orders',
    Key: { orderId },
  }));
  return res.Item;
}
```

Capture HTTP/HTTPS call ra ngoài (ví dụ gọi API third-party) để chúng thành subsegment:

```javascript
const AWSXRay = require('aws-xray-sdk');
// Bọc module http/https — mọi outbound request thành subsegment
const https = AWSXRay.captureHTTPs(require('https'));
```

Với Express, middleware của X-Ray mở/đóng segment cho mỗi request HTTP đến:

```javascript
const express = require('express');
const AWSXRay = require('aws-xray-sdk');
const app = express();

// Mở segment tên "my-api" ở ĐẦU chuỗi middleware
app.use(AWSXRay.express.openSegment('my-api'));

app.get('/orders/:id', async (req, res) => {
  // Lấy segment hiện tại để gắn annotation/metadata
  const seg = AWSXRay.getSegment();
  seg.addAnnotation('orderId', req.params.id);     // FILTER được
  seg.addMetadata('headers', req.headers);          // chỉ để xem

  // Tạo custom subsegment đo một đoạn business logic
  await AWSXRay.captureAsyncFunc('validate-order', async (sub) => {
    sub.addAnnotation('valid', true);
    // ... logic ...
    sub.close(); // BẮT BUỘC đóng subsegment, nếu không trace bị treo "in progress"
  });

  res.json(await getOrder(req.params.id));
});

// Đóng segment ở CUỐI chuỗi middleware (đặt sau mọi route)
app.use(AWSXRay.express.closeSegment());
```

Bẫy thực tế hay gặp: quên gọi `sub.close()` cho subsegment tự tạo → trace hiển thị mãi trạng thái "in progress" và latency bị sai. Với async/Promise, luôn dùng `captureAsyncFunc` và đóng subsegment trong cả nhánh success lẫn error (đặt trong `finally`).

> 💡 **Exam Tip:** Với code ngoài Lambda, để AWS SDK call và HTTP call tự động xuất hiện trên service map, bạn phải **chủ động instrument** bằng `captureAWSv3Client` / `captureHTTPs`. X-Ray không "tự ngửi" được lưu lượng — nó cần SDK bọc client. Đây là điểm khác biệt với CloudWatch (passive) — X-Ray cần instrumentation.

## 26.6 X-Ray với Lambda, API Gateway, ECS, Beanstalk

**Lambda — active tracing.** Bật một flag là Lambda tự tạo segment gốc và daemon đã có sẵn. Bật bằng cấu hình `TracingConfig.Mode = Active`:

```bash
# Bật active tracing cho function (đề hay hỏi đúng cờ này)
aws lambda update-function-configuration \
  --function-name processOrder \
  --tracing-config Mode=Active
```

Để Lambda gửi được trace, execution role của nó phải có quyền — AWS có sẵn managed policy `AWSXRayDaemonWriteAccess` (gồm `PutTraceSegments`, `PutTelemetryRecords`). Trong code Lambda Node.js, bạn capture SDK call tương tự mục 26.5 nhưng KHÔNG cần Express middleware (Lambda đã mở segment gốc). Lambda hiển thị thành **hai phần** trên service map: node `AWS::Lambda` (thời gian dispatch/init, gồm cold start) và node `AWS::Lambda::Function` (thời gian chạy handler) — nhìn là biết latency do cold start hay do code.

**API Gateway.** Bật X-Ray ở mức **stage**: API Gateway sẽ tạo segment đầu chuỗi và truyền trace header xuống Lambda/backend, giúp trace bắt đầu từ chính API Gateway.

```bash
# Bật tracing cho một stage của REST API
aws apigateway update-stage \
  --rest-api-id abc123 --stage-name prod \
  --patch-operations op=replace,path=/tracingEnabled,value=true
```

**ECS / Fargate — sidecar pattern.** Vì task của bạn tự quản compute, bạn chạy X-Ray daemon như một **container phụ** trong cùng task definition (image `amazon/aws-xray-daemon`). App container gửi UDP 2000 tới daemon container. Trong cùng task (network mode `awsvpc`), các container chia sẻ network nên app trỏ tới `xray-daemon` qua tên hoặc localhost. Đừng quên gắn **task role** có quyền X-Ray.

```json
{
  "containerDefinitions": [
    { "name": "app", "image": "my-app:latest",
      "environment": [{ "name": "AWS_XRAY_DAEMON_ADDRESS", "value": "xray-daemon:2000" }] },
    { "name": "xray-daemon", "image": "amazon/aws-xray-daemon",
      "cpu": 32, "memoryReservation": 256,
      "portMappings": [{ "containerPort": 2000, "protocol": "udp" }] }
  ]
}
```

**Elastic Beanstalk.** Bật daemon qua console (Configuration → Monitoring → X-Ray) hoặc `.ebextensions`:

```yaml
# .ebextensions/xray.config
option_settings:
  aws:elasticbeanstalk:xray:
    XRayEnabled: true
```

> 💡 **Exam Tip:** Ghi nhớ các "công tắc" theo từng dịch vụ: **Lambda** = active tracing (`Mode=Active`) + role `AWSXRayDaemonWriteAccess`; **API Gateway** = bật tracing ở **stage**; **ECS/Fargate** = chạy daemon dạng **sidecar container** + task role; **Beanstalk** = `XRayEnabled: true`. Câu hỏi ECS hay gài: "how to send traces from a Fargate task" → đáp án có chữ **sidecar**.

## 26.7 Sampling rules, IAM permissions và trace header

**Sampling rules tuỳ chỉnh.** Bạn tạo rule với `reservoir_size` (số trace tối thiểu mỗi giây được lấy chắc chắn) và `fixed_rate` (tỷ lệ lấy thêm các request còn lại), kèm matcher theo `host`, `url_path`, `http_method`, `service_name`. X-Ray duyệt rule theo `priority` tăng dần, rule khớp đầu tiên thắng; cuối cùng luôn có **Default rule** (1 req/s + 5%).

```bash
# Trace 100% các request /checkout (reservoir 5/s + 100% phần còn lại), priority cao
aws xray create-sampling-rule --sampling-rule '{
  "RuleName": "checkout-all",
  "Priority": 100,
  "ReservoirSize": 5,
  "FixedRate": 1.0,
  "ServiceName": "*",
  "ServiceType": "*",
  "Host": "*",
  "HTTPMethod": "POST",
  "URLPath": "/checkout",
  "ResourceARN": "*",
  "Version": 1
}'
```

**IAM permissions** — chia hai nhóm rõ ràng, đề hay tách:
- **Ghi trace (cho app/Lambda/EC2/ECS):** `xray:PutTraceSegments`, `xray:PutTelemetryRecords`. Cộng thêm `xray:GetSamplingRules`, `xray:GetSamplingTargets` nếu app cần lấy sampling rule từ X-Ray. Managed policy: **`AWSXRayDaemonWriteAccess`**.
- **Đọc/xem trace (cho developer/console):** `xray:GetTraceSummaries`, `xray:BatchGetTraces`, `xray:GetServiceGraph`, `xray:GetTraceGraph`. Managed policy: **`AWSXRayReadOnlyAccess`**.

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["xray:PutTraceSegments", "xray:PutTelemetryRecords",
               "xray:GetSamplingRules", "xray:GetSamplingTargets"],
    "Resource": "*"
  }]
}
```

Lưu ý: X-Ray action không hỗ trợ resource-level permission cho việc ghi — `Resource` để `"*"`.

**Trace header `X-Amzn-Trace-Id`.** Đây là cách trace ID được propagate giữa các service qua HTTP. Header có dạng:

```
X-Amzn-Trace-Id: Root=1-5759e988-bd862e3fe1be46a994272793;Parent=53995c3f42cd8ad8;Sampled=1
```

- `Root` = trace ID gốc, mọi service trong request dùng chung giá trị này để X-Ray nối các segment lại.
- `Parent` = ID của segment cha (giúp dựng quan hệ cha-con).
- `Sampled` = 1 nghĩa là request này được chọn để trace; 0 nghĩa là bỏ qua. Giá trị này được quyết định bởi sampling rule ở service đầu tiên rồi truyền xuống — nhờ vậy cả request hoặc được trace toàn bộ, hoặc bỏ toàn bộ, đảm bảo nhất quán.

ALB, API Gateway và các AWS service tích hợp tự chèn/đọc header này. Khi bạn viết service tự gọi nhau, X-Ray SDK đọc header đến và gắn vào header outbound giúp bạn (nếu HTTP client đã được capture).

> 💡 **Exam Tip:** Header propagate trace ID là **`X-Amzn-Trace-Id`** (Root / Parent / Sampled). Nếu một service downstream tạo trace mới thay vì nối tiếp, nguyên nhân thường là header này không được forward. Đừng nhầm với `X-Forwarded-For` (đó là IP client của ALB, thuộc Chương 6).

## 26.8 X-Ray vs CloudWatch ServiceLens, và OpenTelemetry/ADOT

**CloudWatch ServiceLens** không phải đối thủ của X-Ray — nó là lớp hợp nhất phía trên: ServiceLens gộp **traces (X-Ray) + metrics + logs (CloudWatch)** vào một service map duy nhất, cho phép từ một node bị lỗi nhảy thẳng sang xem log liên quan và metric tương ứng. Nói cách khác, X-Ray cung cấp dữ liệu trace, ServiceLens là trải nghiệm xem tích hợp end-to-end. Đề thi đôi khi gọi tên ServiceLens khi muốn "correlate traces with logs and metrics in one view".

So sánh nhanh ba dịch vụ giám sát hay bị nhầm (chi tiết CloudTrail ở Chương 27):

| Dịch vụ | Trả lời câu hỏi | Đơn vị dữ liệu |
|---|---|---|
| **X-Ray** | Request này chậm/lỗi ở **đâu** trong chuỗi service? | Trace (theo từng request) |
| **CloudWatch** | Hệ thống đang **khoẻ** không? Metric/log thế nào? | Metric, log |
| **CloudTrail** | **Ai** đã gọi API nào, lúc nào? | Sự kiện API (audit) |

**OpenTelemetry & ADOT.** OpenTelemetry (OTel) là chuẩn mở (vendor-neutral) để thu thập trace/metric. **AWS Distro for OpenTelemetry (ADOT)** là bản phân phối OTel do AWS hỗ trợ, cho phép bạn instrument một lần theo chuẩn OTel rồi xuất trace sang X-Ray (và/hoặc backend khác như Prometheus, Jaeger). Lựa chọn ADOT khi bạn muốn tránh khoá cứng vào X-Ray SDK, dùng chung một bộ instrumentation cho cả on-prem lẫn AWS, hoặc gửi dữ liệu tới nhiều backend. Với DVA-C02, bạn chỉ cần **nhận diện**: ADOT = OpenTelemetry chuẩn mở chạy được với X-Ray; X-Ray SDK = SDK riêng của AWS, đơn giản hơn nhưng gắn với X-Ray.

> 💡 **Exam Tip:** "Vendor-neutral instrumentation that can send traces to X-Ray and other backends" → **AWS Distro for OpenTelemetry (ADOT)**. "Unified view correlating X-Ray traces with CloudWatch logs/metrics" → **CloudWatch ServiceLens**.

## 26.9 Troubleshooting "không thấy trace" — checklist

Đây là dạng câu hỏi tình huống điển hình của domain Troubleshooting. Khi "đã bật X-Ray mà service map trống / thiếu node", duyệt theo thứ tự:

1. **IAM permission.** Compute (Lambda role / EC2 instance role / ECS task role) có `xray:PutTraceSegments` + `xray:PutTelemetryRecords` chưa? Thiếu quyền là nguyên nhân số 1. Gắn `AWSXRayDaemonWriteAccess`.
2. **Daemon (nếu tự quản compute).** EC2/ECS có chạy X-Ray daemon không? Daemon nghe đúng **UDP 2000** chưa? Với ECS, sidecar `amazon/aws-xray-daemon` đã thêm vào task definition chưa? App trỏ đúng `AWS_XRAY_DAEMON_ADDRESS` chưa? (Lambda không cần bước này.)
3. **Bật tracing đúng chỗ.** Lambda đã `Mode=Active` chưa? API Gateway đã bật tracing ở **stage** chưa? Beanstalk `XRayEnabled` chưa?
4. **Instrumentation trong code.** Đã `captureAWSv3Client` / `captureHTTPs` chưa? Thiếu thì subsegment downstream (DynamoDB, HTTP) sẽ KHÔNG hiện dù segment gốc có.
5. **Sampling.** Có thể request của bạn rơi vào nhóm KHÔNG được sample (đặc biệt khi traffic thấp và bạn vừa bật). Tạo sampling rule fixed_rate cao hơn để kiểm chứng, hoặc gửi nhiều request.
6. **Subsegment chưa đóng.** Custom subsegment chưa `close()` → trace kẹt "in progress", không hiển thị đầy đủ. Đóng trong `finally`.
7. **Network/region.** Daemon ra được X-Ray API endpoint chưa (security group, NAT, VPC endpoint `com.amazonaws.<region>.xray`)? Trace có đang nhìn đúng **region** không?
8. **Độ trễ & retention.** Trace mất vài giây mới hiện; và X-Ray chỉ giữ trace **30 ngày** — đừng tìm trace cũ hơn.

> 💡 **Exam Tip:** Hai nguyên nhân "không thấy trace" được hỏi nhiều nhất: **(1) thiếu IAM permission `PutTraceSegments`** và **(2) chưa chạy X-Ray daemon (trên EC2/ECS)**. Với Lambda, thủ phạm thường là **quên bật active tracing**. Ghi nhớ bộ ba này là xử lý được phần lớn câu troubleshooting.
