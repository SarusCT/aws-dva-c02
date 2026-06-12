# Chương 30: Lambda Integrations & Event Source Mappings

> **Trọng tâm DVA-C02:** Đây là một trong những chương "ăn điểm" nặng nhất của domain Development và Troubleshooting. Đề thi rất hay đưa tình huống "Lambda đọc từ SQS/Kinesis/DynamoDB Streams bị duplicate/throttle/mất message, sửa thế nào?", hỏi cấu hình `batch size`/`batch window`/`partial batch response`, phân biệt đặt DLQ ở đâu (queue vs function), khi nào dùng `parallelization factor`/`bisect on error`, và cách tích hợp Lambda với ALB. Bạn phải thuộc cơ chế poll của event source mapping, các loại invocation (sync/async/poll-based) và hành vi retry tương ứng — vì đây chính là nơi câu hỏi "least operational overhead" và "no message loss" hay gài bẫy.

## Mục tiêu chương

- Phân biệt rõ 3 mô hình invoke Lambda (synchronous, asynchronous, event source mapping/poll-based) và hành vi retry + xử lý lỗi của từng loại.
- Cấu hình thành thạo event source mapping cho SQS (batch size, batch window, maximum concurrency, partial batch response) và biết đặt DLQ đúng chỗ.
- Nắm cơ chế stream-based ESM cho Kinesis Data Streams & DynamoDB Streams: starting position, batch window, bisect on error, parallelization factor, on-failure destination, ordering theo shard.
- Tích hợp Lambda sau ALB: target group, định dạng event/response, multi-value headers, health check.
- Phân biệt Lambda Destinations vs Dead Letter Queue, biết khi nào dùng cái nào.
- Thiết kế Lambda **idempotent** và retry an toàn; dựng pipeline hoàn chỉnh S3 → Lambda → DynamoDB bằng AWS SDK for JavaScript v3.

## 30.1 Ba mô hình invoke Lambda — nền tảng để hiểu integration

Trước khi nói về event source mapping, bạn phải khắc cốt 3 cách Lambda được gọi, vì **mỗi cách có hành vi retry và xử lý lỗi khác nhau hoàn toàn**. Đề thi xoáy chính vào điểm này.

| Mô hình | Ai gọi | Retry khi lỗi | Nơi xử lý lỗi cuối | Ví dụ nguồn |
|---|---|---|---|---|
| **Synchronous** (request-response) | Caller chờ kết quả | Caller tự lo (không có retry tích hợp) | Trả lỗi về caller | API Gateway, ALB, `Invoke` SDK, Cognito trigger, Step Functions |
| **Asynchronous** (event) | Lambda nhận event vào queue nội bộ | Lambda tự retry **2 lần** (tổng 3 lần) | DLQ hoặc Destinations (OnFailure) | S3, SNS, EventBridge, SES, CodeCommit |
| **Event source mapping** (poll-based) | **Lambda service tự poll** nguồn | Tùy nguồn (xem các section sau) | DLQ ở queue (SQS) / on-failure destination (stream) | SQS, Kinesis Data Streams, DynamoDB Streams, MSK/Kafka, Amazon MQ |

Điểm cốt lõi: với **event source mapping**, *không phải nguồn đẩy event vào Lambda* mà **Lambda service đứng ra poll** nguồn rồi gọi function theo kiểu **synchronous** (đồng bộ) bên trong. Tức là Lambda poll SQS, lấy một batch message, rồi gọi handler của bạn đồng bộ với batch đó. Nếu handler ném lỗi, ESM xử lý dựa trên loại nguồn — chứ không dùng retry async 2 lần.

> 💡 **Exam Tip:** Khi câu hỏi nói "Lambda được trigger bởi S3/SNS/EventBridge và xử lý lỗi", đó là **asynchronous** → retry 2 lần → cấu hình DLQ/Destinations *trên function*. Khi nói "Lambda đọc từ SQS/Kinesis/DynamoDB Streams", đó là **event source mapping** → cấu hình nằm trên **ESM**, không phải trên nguồn theo kiểu push.

Cơ chế asynchronous (chi tiết cơ bản ở Chương 28) tóm gọn: event được đưa vào một internal queue do Lambda quản lý, có **event age tối đa 6 giờ** (`MaximumEventAgeInSeconds`, từ 60s đến 21600s) và **maximum retry attempts** từ 0 đến 2. Khi hết retry mà vẫn fail → gửi tới OnFailure destination hoặc DLQ.

## 30.2 Event Source Mapping (ESM) — cơ chế chung

Event source mapping là một **resource độc lập** (`AWS::Lambda::EventSourceMapping`) gắn giữa một event source (poll-based) và một Lambda function. Bản chất nó là một fleet poller do Lambda service quản lý, liên tục gọi `ReceiveMessage`/`GetRecords` lên nguồn.

Các thuộc tính chung quan trọng:

- **BatchSize**: số record tối đa gửi cho function mỗi lần invoke. SQS standard: tối đa **10.000** (nhưng nếu có batch window > 0; payload vẫn giới hạn 6MB). SQS FIFO/standard mặc định 10. Kinesis/DynamoDB Streams: tối đa **10.000** record.
- **MaximumBatchingWindowInSeconds** (batch window): chờ gom đủ batch hoặc tới timeout (0–300s). Đánh đổi latency lấy hiệu quả.
- **Enabled**: bật/tắt ESM mà không cần xóa.
- **FilterCriteria**: event filtering — lọc bớt record ngay tại ESM trước khi invoke function (tiết kiệm cost, không tính invocation cho record bị lọc bỏ).
- **FunctionResponseTypes**: đặt `["ReportBatchItemFailures"]` để bật partial batch response.

Tạo ESM cho SQS bằng CLI:

```bash
aws lambda create-event-source-mapping \
  --function-name order-processor \
  --event-source-arn arn:aws:sqs:ap-southeast-1:111122223333:orders-queue \
  --batch-size 10 \
  --maximum-batching-window-in-seconds 20 \
  --scaling-config '{"MaximumConcurrency":50}' \
  --function-response-types ReportBatchItemFailures
```

Permission cần thiết: **execution role của Lambda** (không phải nguồn) phải có quyền đọc nguồn. Với SQS cần `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:GetQueueAttributes`. Đây là bẫy kinh điển: nhiều người tưởng phải thêm resource policy lên SQS, nhưng poll-based thì **chính Lambda đi đọc**, nên quyền nằm ở execution role.

> 💡 **Exam Tip:** Event filtering (`FilterCriteria`) áp dụng cho SQS, Kinesis, DynamoDB Streams, MQ, Kafka. Record không khớp filter bị **bỏ luôn** (với stream coi như đã xử lý, không quay lại). Dùng để giảm số invocation — câu hỏi "giảm cost xử lý event không liên quan" thường chọn event filtering thay vì lọc trong code.

## 30.3 ESM cho SQS — batch, scaling, partial batch & DLQ

SQS là nguồn ESM phổ biến nhất trong đề. Cơ chế:

**Poller scaling**: Lambda bắt đầu với 5 đồng thời (concurrent batch), và khi queue có backlog, scale **thêm tối đa 300 instance mỗi phút** (60 cho FIFO), tới giới hạn account concurrency. Với SQS standard, không có giới hạn throughput cứng ngoài account concurrency.

**MaximumConcurrency** (trong `ScalingConfig`): giới hạn số concurrent invocation mà ESM này tạo ra (2–1000). Đây là cách "đúng" để giới hạn concurrency cho consumer SQS, thay vì dùng reserved concurrency (vốn gây throttle → message quay lại queue → DLQ sớm). Đây là điểm thi mới.

**Visibility timeout**: ESM dựa vào visibility timeout của queue để retry. Khi function fail, message không bị delete → sau visibility timeout nó hiện lại → được poll lại. AWS khuyến nghị visibility timeout của queue **≥ 6 lần timeout của function** (để có chỗ cho retry + batch window).

**DLQ đặt ở đâu?** Với SQS, **DLQ là thuộc tính của queue** (redrive policy với `maxReceiveCount`), KHÔNG phải của Lambda. Sau khi message bị nhận `maxReceiveCount` lần mà vẫn không delete được (function fail), SQS tự chuyển nó sang DLQ.

> 💡 **Exam Tip:** Với SQS event source, **DLQ cấu hình trên SQS queue (redrive policy), không phải trên Lambda function**. Nếu đề hỏi "Lambda đọc SQS, message lỗi cần đi đâu để không mất" → đặt redrive policy `maxReceiveCount` trỏ tới một DLQ trên queue gốc.

**Partial batch response** — điểm cực kỳ hay thi. Mặc định, nếu handler ném lỗi khi xử lý một batch SQS, **toàn bộ batch** quay lại queue (kể cả message đã xử lý xong) → gây xử lý lặp. Để chỉ trả lại những message thật sự fail, bật `ReportBatchItemFailures` và trả về danh sách `batchItemFailures`:

```javascript
// SQS partial batch response — chỉ message lỗi mới quay lại queue
exports.handler = async (event) => {
  const batchItemFailures = [];

  for (const record of event.Records) {
    try {
      await processMessage(JSON.parse(record.body)); // xử lý từng message
    } catch (err) {
      console.error(`Lỗi message ${record.messageId}:`, err);
      // báo cho ESM: message này fail, hãy đưa lại vào queue
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  // các message KHÔNG nằm trong list này coi như thành công → bị delete khỏi queue
  return { batchItemFailures };
};
```

Lưu ý cạm bẫy của partial batch response:
- Nếu trả về `batchItemFailures` rỗng `[]` (hoặc `{ "batchItemFailures": [] }`) → toàn bộ batch coi như **thành công**.
- Nếu function ném exception (không return) → **toàn bộ batch** retry.
- Nếu `itemIdentifier` null/rỗng hoặc id sai → toàn batch retry.

Với SQS **FIFO**, khi một message trong message group fail, các message sau cùng group bị giữ lại để bảo toàn thứ tự; partial batch response vẫn dùng được nhưng phải hiểu ordering theo group ID (chi tiết SQS FIFO ở Chương 21).

## 30.4 ESM cho Kinesis Data Streams & DynamoDB Streams

Stream-based ESM khác SQS căn bản: **stream giữ ordering theo shard** và record **không bị xóa** sau khi đọc (chúng nằm lại đến hết retention). Vì vậy cơ chế retry và xử lý lỗi cũng khác.

**Đặc điểm chung của stream ESM:**
- Lambda gán **một concurrent invocation cho mỗi shard** (mặc định). Record trong cùng shard xử lý **tuần tự** để giữ thứ tự.
- **StartingPosition**: `LATEST` (chỉ record mới sau khi tạo ESM), `TRIM_HORIZON` (record cũ nhất còn trong stream), hoặc `AT_TIMESTAMP` (chỉ Kinesis).
- **Retry mặc định**: stream record retry **vô hạn** cho tới khi thành công HOẶC record hết hạn (retention) — và quan trọng: **batch lỗi chặn cả shard** (poison pill). Đây là lý do phải cấu hình error handling.

**Các thuộc tính error handling cho stream (rất hay thi):**

| Thuộc tính | Ý nghĩa | Giá trị |
|---|---|---|
| `MaximumRetryAttempts` | Số lần retry tối đa một batch lỗi | -1 (vô hạn, default) hoặc 0–10000 |
| `MaximumRecordAgeInSeconds` | Bỏ record quá tuổi | -1 hoặc 60–604800 (tối đa 7 ngày) |
| `BisectBatchOnFunctionError` | Khi batch fail, **chia đôi batch** rồi retry để cô lập record độc | true/false |
| `DestinationConfig.OnFailure` | Gửi **metadata** của batch fail tới SQS/SNS khi hết retry | ARN SQS/SNS |
| `ParallelizationFactor` | Số concurrent invoke **trên mỗi shard** | 1–10 (default 1) |
| `TumblingWindowInSeconds` | Cửa sổ gom state cho aggregation | 0–900 |

```bash
# ESM cho Kinesis với error handling đầy đủ
aws lambda create-event-source-mapping \
  --function-name stream-processor \
  --event-source-arn arn:aws:kinesis:ap-southeast-1:111122223333:stream/clickstream \
  --starting-position TRIM_HORIZON \
  --batch-size 100 \
  --maximum-batching-window-in-seconds 5 \
  --parallelization-factor 4 \
  --maximum-retry-attempts 3 \
  --bisect-batch-on-function-error \
  --maximum-record-age-in-seconds 3600 \
  --destination-config '{"OnFailure":{"Destination":"arn:aws:sqs:ap-southeast-1:111122223333:stream-dlq"}}' \
  --function-response-types ReportBatchItemFailures
```

**Bisect on error** giải bài toán "poison pill": batch 100 record có 1 record gây lỗi, mặc định cả batch fail mãi mãi và chặn shard. Bật `BisectBatchOnFunctionError` → Lambda chia 100 thành 2×50, retry; cứ chia đôi tới khi cô lập đúng record độc, rồi gửi riêng record đó tới on-failure destination, các record còn lại đi tiếp.

**ParallelizationFactor**: cho phép tới 10 invocation đồng thời **trên cùng một shard**, nhưng vẫn **giữ thứ tự theo partition key** (record cùng partition key luôn vào cùng một concurrent processor). Dùng khi một shard có nhiều partition key độc lập và bạn cần tăng throughput xử lý mà không cần resharding.

**On-failure destination (stream) ≠ DLQ truyền thống:** nó **không gửi nội dung record** mà chỉ gửi **metadata** (stream ARN, shard ID, sequence number bắt đầu/kết thúc của batch fail). Bạn dùng metadata này để đi đọc lại record từ stream nếu cần. Khác hẳn SQS DLQ (chứa nguyên message).

> 💡 **Exam Tip:** Stream on-failure destination chỉ chứa **metadata batch** (sequence numbers), không chứa payload record. Còn SQS DLQ chứa **nguyên message**. Đề hỏi "lưu lại record lỗi từ Kinesis để xử lý sau" → cấu hình `OnFailure` destination + (tùy chọn) `ReportBatchItemFailures` để cô lập record.

**Partial batch response cho stream**: stream cũng hỗ trợ `ReportBatchItemFailures`, nhưng trả về `itemIdentifier` là **sequence number** (không phải messageId). Khi báo fail record thứ N, stream sẽ retry **từ sequence number đó trở đi** (vì phải giữ ordering), nên các record sau record fail sẽ được xử lý lại — phải thiết kế idempotent.

## 30.5 Enhanced fan-out, polling Kinesis & so sánh SQS vs stream ESM

Với Kinesis, ESM mặc định dùng **shared throughput** (poll `GetRecords`, chia sẻ 2 MB/s/shard với mọi consumer). Khi nhiều consumer cùng đọc, dễ bị `ProvisionedThroughputExceededException`. Bật **enhanced fan-out (EFO)** cho ESM (`--starting-position` + consumer ARN) cho riêng mỗi consumer **2 MB/s/shard riêng** và latency thấp hơn (push qua HTTP/2). EFO chi tiết hơn nằm ở Chương 23, ở đây chỉ cần biết ESM có thể trỏ tới một registered consumer.

Bảng so sánh nhanh hành vi ESM giữa các nguồn:

| Đặc điểm | SQS Standard | SQS FIFO | Kinesis / DynamoDB Streams |
|---|---|---|---|
| Ordering | Không đảm bảo | Theo message group ID | Theo shard (partition key) |
| Xử lý record sau khi đọc | Delete khi thành công | Delete khi thành công | Giữ lại đến hết retention |
| Retry mặc định | Tới `maxReceiveCount` → DLQ | Tới `maxReceiveCount` → DLQ | Vô hạn tới retention (mặc định) |
| Poison pill chặn? | Không (chỉ message đó) | Chặn group đó | Chặn cả shard (nếu không bisect) |
| Nơi xử lý lỗi cuối | SQS DLQ (redrive policy) | SQS DLQ | OnFailure destination (metadata) |
| Tăng throughput | Tự scale (MaximumConcurrency giới hạn) | Tự scale theo group | ParallelizationFactor + resharding/EFO |
| Partial batch id | `messageId` | `messageId` | `sequenceNumber` |

> 💡 **Exam Tip:** Một câu hỏi kinh điển: "Kinesis consumer Lambda bị kẹt, một batch fail làm dừng toàn bộ shard". Đáp án thường là kết hợp `BisectBatchOnFunctionError` + `MaximumRetryAttempts` + `OnFailure` destination (hoặc `MaximumRecordAgeInSeconds`) để batch độc không chặn shard mãi mãi.

## 30.6 Lambda + ALB integration

Ngoài API Gateway (Chương 34–35), ALB có thể gọi Lambda trực tiếp qua **target group kiểu `lambda`**. Đây là cách rẻ và đơn giản để đưa Lambda ra HTTP mà không cần API Gateway, nhưng thiếu nhiều tính năng (không có usage plan, không request validation, không caching tích hợp...).

Cơ chế:
- Bạn tạo target group `--target-type lambda`, register một function (hoặc alias) vào.
- ALB tự thêm **resource-based permission** (`elasticloadbalancing.amazonaws.com`) lên function để được invoke.
- ALB gọi Lambda **đồng bộ** (synchronous) — nếu function lỗi, ALB trả 502.

```bash
# Tạo target group kiểu lambda và đăng ký function
aws elbv2 create-target-group --name lambda-tg --target-type lambda

aws lambda add-permission --function-name web-handler \
  --statement-id alb-invoke --action lambda:InvokeFunction \
  --principal elasticloadbalancing.amazonaws.com

aws elbv2 register-targets --target-group-arn <tg-arn> \
  --targets Id=arn:aws:lambda:ap-southeast-1:111122223333:function:web-handler
```

**Định dạng event ALB gửi vào Lambda** (khác API Gateway):

```json
{
  "requestContext": { "elb": { "targetGroupArn": "..." } },
  "httpMethod": "GET",
  "path": "/orders",
  "queryStringParameters": { "id": "42" },
  "headers": { "host": "...", "user-agent": "..." },
  "body": "",
  "isBase64Encoded": false
}
```

**Định dạng response function phải trả về** — bắt buộc đúng schema, nếu sai ALB trả 502:

```javascript
exports.handler = async (event) => {
  return {
    statusCode: 200,
    statusDescription: "200 OK",
    isBase64Encoded: false,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "ok" }),
  };
};
```

**Multi-value headers**: mặc định ALB gửi mỗi header một giá trị (object `headers`). Nếu một header/query param có **nhiều giá trị** (vd `?tag=a&tag=b`), bạn phải bật **Multi value headers** trên target group attribute → ALB chuyển sang `multiValueHeaders` và `multiValueQueryStringParameters` (giá trị là **mảng**). Function phải đọc đúng key tương ứng. Bật/tắt này thay đổi cả định dạng event, dễ gây bug khi quên đồng bộ code.

> 💡 **Exam Tip:** ALB → Lambda: (1) tạo target group `target-type lambda`; (2) response phải có `statusCode` (sai schema = 502); (3) bật **Multi value headers** nếu cần header/query nhiều giá trị → event đổi sang `multiValueHeaders`. ALB **không** hỗ trợ Lambda proxy "stage variables", caching, usage plan như API Gateway — chọn API Gateway khi cần những thứ đó.

ALB cũng hỗ trợ health check tới Lambda target: nếu bật, ALB gửi request health check, function phải trả `statusCode` trong khoảng cho phép. Lambda target group **chỉ register được 1 function** và không cross-zone như instance target.

## 30.7 Lambda Destinations vs Dead Letter Queue (DLQ)

Cả hai đều xử lý "lỗi sau cùng" nhưng cho các bối cảnh khác nhau, và Destinations là cơ chế mới hơn, mạnh hơn.

**Dead Letter Queue (DLQ trên function):** chỉ áp dụng cho **asynchronous invocation**. Cấu hình `DeadLetterConfig.TargetArn` trỏ tới SQS hoặc SNS. Khi event async fail hết retry (2 lần) → payload gốc đi vào DLQ. DLQ **chỉ bắt lỗi** (failure), không có thông tin context phong phú.

**Lambda Destinations:** áp dụng cho **asynchronous invocation** và **stream ESM** (Kinesis/DynamoDB). Cho phép định tuyến theo kết quả:
- `OnSuccess` → đích khi thành công (chỉ async).
- `OnFailure` → đích khi thất bại.
- Đích có thể là **SQS, SNS, Lambda, hoặc EventBridge** (DLQ chỉ SQS/SNS).
- Payload gửi đi là một **record giàu context**: request payload, response/error, thông tin invocation — hữu ích hơn DLQ nhiều.

| Tiêu chí | DLQ | Destinations |
|---|---|---|
| Áp dụng cho | Async invocation | Async invocation + stream ESM |
| Bắt success? | Không | Có (`OnSuccess`, async) |
| Đích hỗ trợ | SQS, SNS | SQS, SNS, Lambda, EventBridge |
| Nội dung | Payload gốc | Payload + response/error + context |
| Khuyến nghị của AWS | Legacy | **Ưu tiên dùng** |

```bash
# Cấu hình Destinations cho async invocation
aws lambda put-function-event-invoke-config \
  --function-name image-resizer \
  --maximum-retry-attempts 1 \
  --maximum-event-age-in-seconds 3600 \
  --destination-config '{
    "OnSuccess":{"Destination":"arn:aws:sqs:ap-southeast-1:111122223333:done-queue"},
    "OnFailure":{"Destination":"arn:aws:sns:ap-southeast-1:111122223333:failures"}
  }'
```

> 💡 **Exam Tip:** AWS khuyến nghị **Destinations thay cho DLQ** cho async vì context phong phú hơn và hỗ trợ cả thành công. Nhưng nhớ: với **SQS event source**, "DLQ" lại là redrive policy của queue — đừng nhầm với DLQ của function. Với **stream ESM**, dùng `OnFailure` destination (metadata). Với **async (S3/SNS/EventBridge)**, dùng Destinations hoặc DLQ trên function.

## 30.8 Idempotency & thiết kế retry an toàn

Vì gần như mọi integration của Lambda đều **at-least-once** (SQS standard, stream retry, async retry), function của bạn **chắc chắn sẽ bị gọi lại với cùng input**. Không thiết kế idempotent = nhân đôi đơn hàng, trừ tiền 2 lần, ghi 2 bản ghi.

**Idempotency** nghĩa là gọi nhiều lần với cùng input cho kết quả giống như gọi 1 lần. Các pattern phổ biến:

1. **Idempotency key + conditional write vào DynamoDB:** dùng một id duy nhất từ event (vd `messageId` của SQS, `eventID` của DynamoDB Streams, hoặc business key như `orderId`) làm partition key, ghi với `ConditionExpression: attribute_not_exists(pk)`. Nếu đã tồn tại → bỏ qua (đã xử lý rồi).

```javascript
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

async function processOnce(idempotencyKey, payload) {
  try {
    await ddb.send(new PutCommand({
      TableName: "processed-events",
      Item: { pk: idempotencyKey, payload, ts: Date.now() },
      // chỉ ghi nếu key CHƯA tồn tại → chống xử lý trùng
      ConditionExpression: "attribute_not_exists(pk)",
    }));
    await doBusinessLogic(payload); // tác vụ thực sự
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      console.log(`Đã xử lý ${idempotencyKey}, bỏ qua`); // idempotent
      return;
    }
    throw err; // lỗi khác → để ESM retry
  }
}
```

2. **Powertools for AWS Lambda (idempotency utility):** thư viện chính thức wrap handler, tự lưu idempotency record vào DynamoDB với TTL, tự trả về kết quả cached cho lần gọi lặp. Giảm boilerplate.

3. **TTL trên bảng dedup:** dùng DynamoDB TTL (chi tiết Chương 33) để tự dọn idempotency record cũ, tránh bảng phình.

**Nguyên tắc retry an toàn:**
- **Tách thao tác có side-effect**: đặt việc ghi DB / gọi API ngoài sau khi đã kiểm tra idempotency.
- **Đừng nuốt lỗi rồi return success** khi xử lý thật sự fail — với SQS sẽ làm message bị delete oan (mất message). Phải ném lỗi hoặc dùng `batchItemFailures`.
- **Set timeout function < visibility timeout** (SQS) để retry hoạt động đúng; visibility timeout ≥ 6× function timeout.
- **Idempotent cả phía downstream**: nếu gọi service ngoài, ưu tiên API hỗ trợ idempotency token (vd Stripe, hoặc ` clientRequestToken` của một số AWS API).

> 💡 **Exam Tip:** Bất kỳ câu hỏi nào có "duplicate processing", "exactly-once không khả thi", "SQS standard at-least-once" → đáp án gần như luôn là **làm Lambda idempotent** (conditional write DynamoDB với idempotency key). SQS FIFO có dedup 5 phút nhưng vẫn nên idempotent vì retry vẫn xảy ra.

## 30.9 Pipeline hoàn chỉnh: S3 → Lambda → DynamoDB (SDK v3)

Đây là pattern điển hình nhất của đề và thực tế: file upload lên S3 → event async trigger Lambda → Lambda parse → ghi DynamoDB. Lưu ý đây là **async invocation** (S3 → Lambda), nên áp dụng retry 2 lần + Destinations/DLQ; KHÔNG phải event source mapping.

Cấu hình S3 notification (Chương 13 đi sâu về S3 events) — ở đây phần Lambda:

```javascript
// handler.mjs — Lambda xử lý object mới trong S3, idempotent ghi DynamoDB
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.TABLE_NAME;

const streamToString = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
};

export const handler = async (event) => {
  // S3 có thể gửi nhiều record trong 1 event
  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    // key được URL-encode trong S3 event → phải decode
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
    // versionId/sequencer dùng làm idempotency key chống xử lý trùng
    const idemKey = `${bucket}/${key}#${record.s3.object.eTag}`;

    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await streamToString(obj.Body);
    const data = JSON.parse(body);

    try {
      await ddb.send(new PutCommand({
        TableName: TABLE,
        Item: { pk: idemKey, bucket, key, ...data, processedAt: Date.now() },
        ConditionExpression: "attribute_not_exists(pk)", // idempotent
      }));
    } catch (err) {
      if (err.name === "ConditionalCheckFailedException") {
        console.log(`Object ${key} đã xử lý, bỏ qua`);
        continue;
      }
      // lỗi khác → ném ra để Lambda retry (async, tối đa 2 lần) rồi vào DLQ/Destination
      throw err;
    }
  }
};
```

Execution role tối thiểu (least privilege): `s3:GetObject` trên bucket nguồn, `dynamodb:PutItem` trên bảng đích, và `logs:*` cho CloudWatch Logs. Nếu bật Destinations OnFailure tới SNS thì thêm `sns:Publish`.

Điểm cần nhớ về pipeline này cho đề thi:
- **S3 → Lambda là async** → cấu hình DLQ/Destinations *trên function* (không phải trên S3).
- Một object có thể sinh **nhiều event** trong trường hợp hiếm → idempotency vẫn cần.
- S3 event key **URL-encoded** (space thành `+`) → bug kinh điển khi quên decode.
- Nếu khối lượng lớn và cần buffer/giảm áp lực, chèn **SQS giữa S3 và Lambda** (S3 → SQS → Lambda ESM) để có retry tốt hơn, batch, và DLQ ở queue — biến nó thành poll-based.

> 💡 **Exam Tip:** Khi cần "độ bền cao, không mất event, kiểm soát concurrency consumer" cho luồng S3→Lambda, pattern tốt hơn là **S3 → SQS → Lambda (ESM)** thay vì S3 → Lambda trực tiếp: SQS cho retry rõ ràng, DLQ, batch và `MaximumConcurrency`. Còn S3 → SNS → SQS (fan-out) khi nhiều consumer.
