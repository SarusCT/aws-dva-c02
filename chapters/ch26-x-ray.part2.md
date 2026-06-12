## Hands-on Lab: Instrument một Lambda + API Gateway + DynamoDB với X-Ray, xem service map và xử lý "không thấy trace"

**Mục tiêu lab:** Dựng một pipeline serverless hoàn chỉnh `API Gateway → Lambda → DynamoDB`, bật **active tracing** trên cả API Gateway lẫn Lambda, instrument code Lambda bằng **AWS X-Ray SDK for Node.js** để gói các AWS SDK call và tạo **subsegment**, gắn **annotation** (filter được) và **metadata** (không filter), tạo một **sampling rule** tùy biến, rồi đọc **service map** + **trace** bằng AWS CLI. Phần cuối luyện đúng kỹ năng đề hay hỏi: chẩn đoán "đã code mà không thấy trace" qua một checklist IAM/header/sampling, và dọn sạch tài nguyên.

**Chuẩn bị:**
- AWS CLI v2 đã cấu hình profile có quyền `xray:*`, `lambda:*`, `apigateway:*`, `dynamodb:*`, `iam:*`, `logs:*`.
- Node.js 18+. Cài SDK trong thư mục hàm: `npm i @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb aws-xray-sdk-core`.
- Region xuyên suốt: `ap-southeast-1`.

```bash
export AWS_REGION="ap-southeast-1"
export ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
export FN="dva-ch26-fn"
export TABLE="dva-ch26-orders"
export ROLE="dva-ch26-role"
```

### Bước 1: Tạo DynamoDB table và IAM role có quyền X-Ray

```bash
aws dynamodb create-table \
  --table-name "$TABLE" \
  --attribute-definitions AttributeName=pk,AttributeType=S \
  --key-schema AttributeName=pk,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST
aws dynamodb wait table-exists --table-name "$TABLE"

# Trust policy cho Lambda
cat > trust.json <<'EOF'
{ "Version": "2012-10-17", "Statement": [
  { "Effect": "Allow", "Principal": { "Service": "lambda.amazonaws.com" }, "Action": "sts:AssumeRole" } ] }
EOF

aws iam create-role --role-name "$ROLE" --assume-role-policy-document file://trust.json
aws iam attach-role-policy --role-name "$ROLE" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
# Quyền GHI trace — BẮT BUỘC, nếu thiếu sẽ "không thấy trace"
aws iam attach-role-policy --role-name "$ROLE" \
  --policy-arn arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess
aws iam attach-role-policy --role-name "$ROLE" \
  --policy-arn arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess
```

> Managed policy `AWSXRayDaemonWriteAccess` cấp `xray:PutTraceSegments` và `xray:PutTelemetryRecords` — đây là quyền hàm cần để **gửi** segment lên X-Ray. Quyền `xray:GetSamplingRules`/`xray:GetSamplingTargets` cũng nằm trong policy này để SDK tải sampling rule về.

### Bước 2: Viết hàm Lambda có instrument X-Ray

```javascript
// index.mjs
import AWSXRay from 'aws-xray-sdk-core';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

// Gói client để mọi call DynamoDB tạo subsegment tự động
const ddb = AWSXRay.captureAWSv3Client(
  new DynamoDBClient({ region: process.env.AWS_REGION })
);
const doc = DynamoDBDocumentClient.from(ddb);

export const handler = async (event) => {
  const seg = AWSXRay.getSegment();              // segment do Lambda tạo sẵn
  const sub = seg.addNewSubsegment('business-logic');
  const orderId = `order-${Date.now()}`;
  try {
    // Annotation: index được → filter expression dùng được
    sub.addAnnotation('orderId', orderId);
    sub.addAnnotation('channel', 'web');
    // Metadata: KHÔNG index, chỉ để xem chi tiết
    sub.addMetadata('rawEvent', event);

    await doc.send(new PutCommand({
      TableName: process.env.TABLE,
      Item: { pk: orderId, status: 'NEW', ts: Date.now() }
    }));
    sub.close();
    return { statusCode: 200, body: JSON.stringify({ orderId }) };
  } catch (err) {
    sub.addError(err);   // đánh dấu subsegment là error → segment đỏ trên map
    sub.close(err);
    throw err;
  }
};
```

Đóng gói và tạo hàm với **active tracing**:

```bash
npm i @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb aws-xray-sdk-core
zip -r fn.zip index.mjs node_modules > /dev/null

aws lambda create-function \
  --function-name "$FN" \
  --runtime nodejs20.x \
  --handler index.handler \
  --role "arn:aws:iam::${ACCOUNT_ID}:role/${ROLE}" \
  --zip-file fileb://fn.zip \
  --environment "Variables={TABLE=$TABLE}" \
  --tracing-config Mode=Active     # <-- bật X-Ray active tracing
```

> `--tracing-config Mode=Active` là điểm mấu chốt. Ở chế độ Active, Lambda service tự inject biến môi trường `_X_AMZN_TRACE_ID`, tạo segment gốc và chạy daemon trong môi trường thực thi — bạn KHÔNG cần tự chạy daemon. Mode `PassThrough` (mặc định) chỉ trace tiếp khi request đến đã có sampling decision = sampled.

### Bước 3: Tạo sampling rule tùy biến

Mặc định X-Ray dùng rule "1 request/giây đầu + 5% phần còn lại" (reservoir 1, rate 0.05). Tạo rule riêng để **luôn lấy mẫu 100%** trên service của lab (tránh tình huống "request bị bỏ mẫu nên không thấy trace"):

```bash
cat > sampling.json <<'EOF'
{
  "SamplingRule": {
    "RuleName": "dva-ch26-all",
    "Priority": 1000,
    "FixedRate": 1.0,
    "ReservoirSize": 1,
    "ServiceName": "*",
    "ServiceType": "*",
    "Host": "*",
    "HTTPMethod": "*",
    "URLPath": "*",
    "ResourceARN": "*",
    "Version": 1
  }
}
EOF
aws xray create-sampling-rule --cli-input-json file://sampling.json
```

> `Priority` nhỏ hơn = ưu tiên cao hơn; X-Ray duyệt rule theo thứ tự priority tăng dần, dùng rule đầu tiên khớp. `FixedRate: 1.0` = lấy mẫu 100% sau khi reservoir đầy. Đây là cách "ép" thấy trace khi debug.

### Bước 4: Gọi hàm và tạo dữ liệu trace

```bash
aws lambda invoke --function-name "$FN" \
  --payload '{"source":"lab"}' --cli-binary-format raw-in-base64-out out.json
cat out.json   # {"statusCode":200,"body":"{\"orderId\":\"order-...\"}"}

# gọi vài lần để có nhiều trace
for i in 1 2 3 4 5; do
  aws lambda invoke --function-name "$FN" --payload '{"n":'"$i"'}' \
    --cli-binary-format raw-in-base64-out /dev/null > /dev/null
done
```

### Bước 5: Đọc service map và trace bằng CLI

```bash
START=$(date -u -v-10M +%s 2>/dev/null || date -u -d '10 min ago' +%s)
END=$(date -u +%s)

# Lấy danh sách trace ID tóm tắt
aws xray get-trace-summaries --start-time "$START" --end-time "$END" \
  --query 'TraceSummaries[].Id' --output text

# Service graph (chính là dữ liệu vẽ service map)
aws xray get-service-graph --start-time "$START" --end-time "$END" \
  --query 'Services[].{Name:Name,Type:Type,Ok:SummaryStatistics.OkCount,Err:SummaryStatistics.ErrorStatistics.TotalCount}'
```

Output service-graph mong đợi (rút gọn) — bạn thấy node Lambda function và node DynamoDB:

```json
[
  { "Name": "dva-ch26-fn", "Type": "AWS::Lambda::Function", "Ok": 6, "Err": 0 },
  { "Name": "dva-ch26-orders", "Type": "AWS::DynamoDB::Table", "Ok": 6, "Err": 0 }
]
```

Lấy chi tiết một trace (chứa segment, subsegment `business-logic`, annotation):

```bash
TID=$(aws xray get-trace-summaries --start-time "$START" --end-time "$END" \
  --query 'TraceSummaries[0].Id' --output text)
aws xray batch-get-traces --trace-ids "$TID" \
  --query 'Traces[0].Segments[].Document' --output text | python3 -m json.tool | head -40
```

Lọc trace theo annotation (đúng giá trị của filter expression trên console):

```bash
aws xray get-trace-summaries --start-time "$START" --end-time "$END" \
  --filter-expression 'annotation.channel = "web"' \
  --query 'TraceSummaries[].Id' --output text
```

> Đây là lý do dùng **annotation** thay vì **metadata**: chỉ annotation mới index và filter được bằng filter expression như `annotation.orderId = "order-123"`. Metadata chỉ hiển thị khi mở chi tiết trace.

### Bước 6: Tái hiện và chẩn đoán "không thấy trace"

Gỡ quyền X-Ray để mô phỏng lỗi kinh điển, gọi hàm, rồi quan sát:

```bash
aws iam detach-role-policy --role-name "$ROLE" \
  --policy-arn arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess
sleep 10
aws lambda invoke --function-name "$FN" --payload '{}' \
  --cli-binary-format raw-in-base64-out /dev/null
```

Hàm vẫn trả 200 nhưng segment không lên X-Ray. **Checklist chẩn đoán** (thứ tự kiểm tra trong production và trong đề):
1. Execution role có `xray:PutTraceSegments` + `xray:PutTelemetryRecords` không? (lỗi vừa tạo ra).
2. Lambda đã bật `TracingConfig.Mode = Active` chưa? (`aws lambda get-function-configuration --function-name "$FN" --query TracingConfig`).
3. Request có bị **sampling** bỏ không? Tăng FixedRate như Bước 3.
4. Khoảng thời gian truy vấn có khớp không? Trace mất tới ~30 giây mới hiển thị; query sai start/end time là nhầm phổ biến.
5. Trên ECS/EC2: daemon có chạy và mở **UDP 2000** không? Hàm gửi segment qua UDP tới `127.0.0.1:2000`.

Gắn lại quyền để xác nhận trace quay về:

```bash
aws iam attach-role-policy --role-name "$ROLE" \
  --policy-arn arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess
```

### Dọn dẹp tài nguyên

```bash
aws lambda delete-function --function-name "$FN"
aws dynamodb delete-table --table-name "$TABLE"
aws xray delete-sampling-rule --rule-name "dva-ch26-all"

for p in AWSLambdaBasicExecutionRole AWSXRayDaemonWriteAccess AmazonDynamoDBFullAccess; do
  aws iam detach-role-policy --role-name "$ROLE" \
    --policy-arn "arn:aws:iam::aws:policy/service-role/$p" 2>/dev/null
  aws iam detach-role-policy --role-name "$ROLE" \
    --policy-arn "arn:aws:iam::aws:policy/$p" 2>/dev/null
done
aws iam delete-role --role-name "$ROLE"
rm -f trust.json sampling.json fn.zip out.json index.mjs
rm -rf node_modules package*.json
```

> X-Ray tính phí theo số trace **recorded** và **retrieved/scanned**; sampling rule không bị tính storage nhưng cứ xóa rule lab để gọn. DynamoDB PAY_PER_REQUEST và Lambda không có chi phí khi idle, nhưng vẫn nên xóa để tránh rác.

## 💡 Exam Tips chương 26

- **Lambda + X-Ray = `TracingConfig.Mode=Active`** (CLI: `--tracing-config Mode=Active`). Lambda tự chạy daemon và inject `_X_AMZN_TRACE_ID`; bạn KHÔNG tự cài daemon trên Lambda. Mode `PassThrough` chỉ tiếp tục trace nếu upstream đã sampled.
- **Quyền GHI trace nằm ở execution role**, không phải permission của X-Ray service: cần `xray:PutTraceSegments` và `xray:PutTelemetryRecords` (gói sẵn trong `AWSXRayDaemonWriteAccess`). Thiếu quyền này là nguyên nhân số 1 của "không thấy trace".
- **Annotation vs Metadata:** annotation được index → filter được (`annotation.key = "..."`), tối đa 50 annotation/trace; metadata KHÔNG index, chỉ để xem chi tiết. Câu hỏi "cần search/filter trace theo giá trị" → annotation.
- **Sampling rule:** mặc định 1 req/giây (reservoir) + 5% phần còn lại, để giảm chi phí và overhead. Sửa sampling không cần deploy lại code — SDK tải rule từ X-Ray định kỳ.
- **Trace header `X-Amzn-Trace-Id`** mang `Root`, `Parent`, `Sampled`. Đây là thứ X-Ray dùng để nối các segment thành một trace xuyên service. API Gateway/ELB tự thêm header này.
- **API Gateway:** bật X-Ray ở mức **stage** (active tracing per stage). Nó tạo segment cho phần API Gateway và truyền trace header xuống integration.
- **ECS/EC2/on-prem:** phải tự chạy **X-Ray daemon** (sidecar container với ECS) lắng nghe **UDP cổng 2000**; cấp task role/instance role quyền ghi trace.
- **Service map** hiển thị màu node: xanh (ok), cam (4xx errors/throttle), đỏ (5xx faults). Node có viền chấm = downstream chưa instrument. Dùng để khoanh vùng latency/lỗi nhanh.
- **CloudWatch ServiceLens** kết hợp X-Ray traces + CloudWatch metrics + logs trong một giao diện. Câu hỏi "correlate trace với metric & log" → ServiceLens.
- **ADOT (AWS Distro for OpenTelemetry)** là cách chuẩn để gửi trace từ ứng dụng OpenTelemetry tới X-Ray; nhận diện khi đề nói "vendor-neutral / OpenTelemetry".
- **Phân biệt 3 dịch vụ:** CloudWatch = metrics/logs/alarms (cái gì sai, bao nhiêu), CloudTrail = ai gọi API gì (audit), X-Ray = request đi qua đâu, chậm/lỗi ở service nào (tracing).
- **`captureAWSv3Client`** (SDK v3) hoặc `captureAWS`/`captureHTTPsGlobal` (cho HTTP) để tự tạo subsegment cho downstream call. Không gói thì service map thiếu node downstream.

## Quiz chương 26 (10 câu)

**Câu 1.** Một developer bật X-Ray cho Lambda bằng `Mode=Active`, code đã gọi DynamoDB, nhưng X-Ray console không hiển thị trace nào. Nguyên nhân khả dĩ NHẤT?
- A. Lambda chưa được đặt trong VPC
- B. Execution role thiếu `xray:PutTraceSegments`
- C. DynamoDB table chưa bật streams
- D. Region của X-Ray khác region của Lambda

**Câu 2.** Developer muốn lọc trace theo `customerId` cụ thể trên X-Ray console. Cần làm gì trong code?
- A. Thêm `customerId` làm metadata
- B. Thêm `customerId` làm annotation
- C. Ghi `customerId` vào CloudWatch Logs
- D. Đặt `customerId` vào trace header

**Câu 3.** Ứng dụng chạy trên Amazon ECS (Fargate) cần gửi trace tới X-Ray. Cấu hình đúng?
- A. Bật `Mode=Active` trên task definition
- B. Chạy X-Ray daemon như một sidecar container, mở UDP 2000, cấp task role quyền ghi trace
- C. Cài CloudWatch agent vào container
- D. Gọi `xray:PutTraceSegments` trực tiếp từ EventBridge

**Câu 4.** Trong service map, một node Lambda hiện màu **đỏ**. Điều này nghĩa là gì?
- A. Node có nhiều fault (5xx) trong khoảng thời gian
- B. Node chưa được instrument
- C. Node đang bị throttle
- D. Node có latency cao nhưng không lỗi

**Câu 5.** Team muốn giảm chi phí X-Ray cho một service có hàng triệu request/giờ nhưng vẫn lấy mẫu đủ để chẩn đoán. Cách phù hợp NHẤT?
- A. Tắt active tracing rồi bật lại khi cần
- B. Tạo sampling rule với reservoir nhỏ và fixed rate thấp
- C. Tăng retention của trace
- D. Chuyển sang CloudTrail data events

**Câu 6.** Một REST API trên API Gateway gọi Lambda. Developer muốn thấy phần thời gian xử lý tại API Gateway trên trace. Phải làm gì?
- A. Bật X-Ray active tracing ở mức stage của API Gateway
- B. Thêm annotation trong Lambda
- C. Bật CloudWatch detailed metrics
- D. Cấu hình access logs cho stage

**Câu 7.** Header HTTP nào X-Ray dùng để truyền trace context (Root, Parent, Sampled) giữa các service?
- A. `X-Forwarded-For`
- B. `X-Amzn-Trace-Id`
- C. `X-Ray-Trace`
- D. `Authorization`

**Câu 8.** Một developer dùng AWS SDK for JavaScript v3 và muốn các call S3/DynamoDB tự xuất hiện thành subsegment trên trace. Cách đúng?
- A. Bọc client bằng `AWSXRay.captureAWSv3Client(client)`
- B. Gọi `AWSXRay.captureAWS(AWS)` như SDK v2
- C. Thêm middleware SigV4 thủ công
- D. X-Ray tự bắt mọi call mà không cần code

**Câu 9.** Tổ chức cần một giao diện duy nhất để xem trace của X-Ray cùng với metrics và logs CloudWatch để phân tích end-to-end. Nên dùng gì?
- A. CloudTrail Insights
- B. CloudWatch ServiceLens
- C. AWS Config
- D. X-Ray Analytics riêng lẻ

**Câu 10.** Một developer cần gửi trace tới X-Ray từ ứng dụng đã instrument bằng OpenTelemetry, không muốn khóa cứng vào X-Ray SDK. Lựa chọn đúng?
- A. AWS Distro for OpenTelemetry (ADOT) với X-Ray exporter
- B. CloudWatch Embedded Metric Format
- C. X-Ray daemon thuần
- D. Kinesis Data Firehose

### Đáp án & giải thích

**Câu 1 — Đáp án B.** Để gửi segment, execution role của Lambda cần `xray:PutTraceSegments` (và `xray:PutTelemetryRecords`), thường qua managed policy `AWSXRayDaemonWriteAccess`. Thiếu quyền này hàm vẫn chạy bình thường nhưng segment bị từ chối nên không có trace. A sai: VPC không liên quan đến việc gửi trace (Lambda dùng daemon nội bộ). C sai: streams không liên quan tracing. D sai: với Active tracing Lambda gửi vào X-Ray cùng region một cách tự động; đây không phải nguyên nhân điển hình.

**Câu 2 — Đáp án B.** Chỉ **annotation** được index và dùng được trong filter expression (`annotation.customerId = "..."`). A sai: metadata không index nên không filter được. C sai: log riêng không cho filter trace. D sai: trace header chỉ chứa context routing, không phải nơi đặt thuộc tính nghiệp vụ để filter.

**Câu 3 — Đáp án B.** Trên ECS/EC2/on-prem, X-Ray daemon KHÔNG tự có; phải chạy nó (sidecar với Fargate) lắng nghe UDP 2000 và cấp task role quyền `PutTraceSegments`/`PutTelemetryRecords`. A sai: `Mode=Active` là khái niệm của Lambda, không áp cho ECS task definition. C sai: CloudWatch agent là cho metrics/logs, không gửi trace X-Ray. D sai: EventBridge không phải cơ chế gửi segment.

**Câu 4 — Đáp án A.** Màu node trên service map: xanh = ok, cam = errors (4xx/throttle), **đỏ = faults (5xx)**. B sai: node chưa instrument hiển thị viền nét đứt, không phải đỏ. C sai: throttle thuộc nhóm error (cam). D sai: latency cao thể hiện ở kích thước/response time, không đổi sang đỏ nếu không có fault.

**Câu 5 — Đáp án B.** Sampling rule cho phép kiểm soát tỷ lệ lấy mẫu: reservoir (số request đảm bảo/giây) + fixed rate (% phần còn lại). Hạ cả hai để giảm chi phí mà vẫn có mẫu đại diện. A sai: tắt/bật thủ công bỏ lỡ sự cố và không kiểm soát mịn. C sai: tăng retention làm tăng chi phí. D sai: CloudTrail data events là audit, không thay tracing.

**Câu 6 — Đáp án A.** API Gateway hỗ trợ X-Ray active tracing bật ở mức **stage**; khi bật, nó tạo segment cho phần API Gateway và truyền trace header xuống Lambda, nên service map có node API Gateway với thời gian của nó. B sai: annotation trong Lambda chỉ gắn vào segment Lambda. C sai: detailed metrics là CloudWatch, không phải trace segment. D sai: access logs ghi log truy cập, không tạo segment trace.

**Câu 7 — Đáp án B.** `X-Amzn-Trace-Id` mang `Root` (trace id), `Parent` (segment cha), `Sampled` (quyết định lấy mẫu) để nối segment xuyên service. A sai: `X-Forwarded-For` là client IP. C/D sai: không phải header X-Ray dùng.

**Câu 8 — Đáp án A.** Với SDK v3, dùng `AWSXRay.captureAWSv3Client(new XxxClient())` để chèn middleware tạo subsegment cho mỗi call. B sai: `captureAWS` là API cho SDK v2 (mô-đun monolithic), không áp cho v3 modular. C sai: SigV4 không liên quan tracing. D sai: phải bọc client thì subsegment downstream mới xuất hiện.

**Câu 9 — Đáp án B.** **CloudWatch ServiceLens** hợp nhất X-Ray traces + CloudWatch metrics + logs trong một giao diện để phân tích end-to-end. A sai: CloudTrail Insights phát hiện bất thường hoạt động API, không gộp trace. C sai: AWS Config là compliance/cấu hình. D sai: X-Ray Analytics chỉ phân tích trace, không gộp metrics/logs.

**Câu 10 — Đáp án A.** **ADOT** (AWS Distro for OpenTelemetry) cho phép ứng dụng dùng OpenTelemetry chuẩn, export trace tới X-Ray qua X-Ray exporter — vendor-neutral, không khóa vào X-Ray SDK. B sai: EMF là định dạng metric trong log, không phải trace. C sai: daemon thuần cần SDK X-Ray gửi UDP, không phải OpenTelemetry. D sai: Firehose là streaming delivery, không phải pipeline trace OpenTelemetry.

## Tóm tắt chương

- X-Ray là **distributed tracing**: theo dấu một request đi qua nhiều service, xác định nơi chậm/lỗi; khác CloudWatch (metrics/logs) và CloudTrail (audit API).
- Một **trace** gồm các **segment** (mỗi service/resource) và **subsegment** (đơn vị công việc nhỏ hơn, ví dụ một call DynamoDB); chúng nối nhau qua trace header `X-Amzn-Trace-Id`.
- **Annotation** được index và filter được (tối đa 50/trace); **metadata** chỉ để xem chi tiết, không filter — đây là cặp gài bẫy kinh điển trong đề.
- **Sampling rule** (mặc định 1 req/giây + 5%) kiểm soát chi phí và overhead; sửa sampling không cần deploy lại code vì SDK tải rule từ X-Ray.
- **Lambda:** bật `TracingConfig.Mode=Active`; Lambda tự chạy daemon và inject `_X_AMZN_TRACE_ID`. Mode `PassThrough` chỉ tiếp tục khi upstream đã sampled.
- **Quyền ghi trace** ở execution/task/instance role: `xray:PutTraceSegments` + `xray:PutTelemetryRecords` (managed policy `AWSXRayDaemonWriteAccess`). Thiếu → "không thấy trace".
- **ECS/EC2/on-prem** phải tự chạy **X-Ray daemon** (sidecar với ECS), lắng nghe **UDP cổng 2000**.
- **API Gateway** bật active tracing ở mức stage để có segment cho phần API Gateway.
- **Service map** màu node: xanh (ok), cam (errors 4xx/throttle), đỏ (faults 5xx); viền nét đứt = downstream chưa instrument.
- **SDK v3** dùng `captureAWSv3Client` để tự tạo subsegment cho downstream AWS call; SDK v2 dùng `captureAWS`.
- **CloudWatch ServiceLens** gộp trace + metrics + logs; **ADOT** là đường vào X-Ray cho ứng dụng OpenTelemetry (vendor-neutral).
- Checklist "không thấy trace": kiểm tra IAM ghi trace → active tracing → sampling decision → khoảng thời gian query → daemon/UDP 2000 (cho ECS/EC2).
