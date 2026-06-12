# Chương 43: AWS Step Functions

> **Trọng tâm DVA-C02:** Step Functions xuất hiện ổn định trong domain Development và Troubleshooting. Đề thi rất hay đưa tình huống "điều phối nhiều Lambda/microservice thành workflow, xử lý lỗi và retry mà không nhúng logic vào code", hỏi phân biệt **Standard vs Express workflow** (giá, thời lượng, exactly-once vs at-least-once), chọn **integration pattern** đúng (request-response vs `.sync` "run a job" vs `.waitForTaskToken` callback), cấu hình **Retry/Catch** với `ErrorEquals` và backoff, và xử lý input/output (`InputPath`, `Parameters`, `ResultSelector`, `ResultPath`, `OutputPath`). Bạn phải đọc được một state machine viết bằng Amazon States Language (ASL) và biết khi nào dùng `Map` thường vs Distributed Map. Đây là nơi câu hỏi "least operational overhead khi orchestrate workflow" và "long-running job có human approval" hay gài bẫy.

## Mục tiêu chương

- Hiểu state machine và Amazon States Language (ASL): cấu trúc JSON, `StartAt`, `States`, `Next`, `End`.
- Phân biệt và sử dụng đúng các state type: `Task`, `Choice`, `Wait`, `Parallel`, `Map` (inline vs distributed), `Pass`, `Succeed`, `Fail`.
- Chọn đúng giữa **Standard** và **Express** workflow dựa trên duration, giá, semantics thực thi.
- Nắm 3 service integration pattern: **request-response**, **run a job (`.sync`)**, **wait for callback (`.waitForTaskToken`)** và khi nào dùng cái nào.
- Cấu hình error handling chuyên nghiệp: `Retry` (backoff, `MaxAttempts`, `IntervalSeconds`, `BackoffRate`, `JitterStrategy`), `Catch`, các predefined error như `States.TaskFailed`, `States.Timeout`, `States.ALL`.
- Xử lý dữ liệu chảy qua workflow với `InputPath`, `Parameters`, `ResultSelector`, `ResultPath`, `OutputPath`; tích hợp X-Ray; phân biệt với Activities (legacy).

## 43.1 Step Functions là gì và vì sao cần orchestration

Khi bạn có một quy trình nghiệp vụ gồm nhiều bước — ví dụ xử lý đơn hàng: kiểm tra tồn kho → trừ tiền → tạo vận đơn → gửi email — bạn có hai cách ghép chúng lại. Cách thứ nhất là **orchestration nhúng trong code**: viết một Lambda "điều phối" gọi lần lượt các Lambda khác, tự `try/catch`, tự `sleep` để chờ, tự lưu trạng thái vào DynamoDB khi cần resume. Cách này nhanh lúc đầu nhưng nhanh chóng trở thành "spaghetti": logic retry rải khắp nơi, không thấy được workflow đang ở bước nào, và Lambda điều phối phải chạy chờ (tốn tiền vô ích) hoặc tự dựng cơ chế state phức tạp.

**AWS Step Functions** là dịch vụ serverless để định nghĩa workflow dưới dạng **state machine** (máy trạng thái). Bạn mô tả các bước và luồng chuyển tiếp bằng JSON (Amazon States Language), Step Functions lo phần "động cơ": chạy từng state, lưu trạng thái, retry khi lỗi, chờ callback, ghi lại lịch sử thực thi từng bước. Logic điều phối tách hẳn khỏi business logic — Lambda của bạn chỉ làm đúng một việc, còn "ai gọi ai, lỗi thì làm gì" nằm trong state machine.

Lợi ích cốt lõi cho đề thi:

- **Tách orchestration khỏi code** → ít operational overhead, dễ bảo trì.
- **Visual workflow**: console hiển thị đồ thị từng state, mỗi lần execution thấy rõ bước nào pass/fail và input/output từng bước — vàng ròng khi debug.
- **Built-in error handling**: retry với exponential backoff, catch, fallback — không cần tự viết.
- **Chờ không tốn tiền compute**: state `Wait` hay `.waitForTaskToken` có thể chờ hàng giờ/ngày mà không có Lambda nào "đứng canh".
- **Tích hợp 200+ AWS service** qua AWS SDK integration, không cần Lambda trung gian để gọi `PutItem` DynamoDB hay `SendMessage` SQS.

> 💡 **Exam Tip:** Khi đề mô tả "cần điều phối nhiều bước/microservice với retry và error handling, không muốn quản lý hạ tầng orchestration" → đáp án gần như chắc chắn là **Step Functions**, không phải nhồi logic vào một Lambda lớn. Từ khóa "visual workflow", "coordinate multiple Lambda functions", "long-running process with human approval" đều trỏ về Step Functions.

## 43.2 Amazon States Language (ASL) và cấu trúc state machine

State machine được định nghĩa bằng **Amazon States Language (ASL)** — một cấu trúc JSON. Khung tối thiểu gồm:

```json
{
  "Comment": "Workflow xử lý đơn hàng đơn giản",
  "StartAt": "CheckInventory",
  "States": {
    "CheckInventory": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:ap-southeast-1:111122223333:function:check-inventory",
      "Next": "ChargePayment"
    },
    "ChargePayment": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:ap-southeast-1:111122223333:function:charge-payment",
      "End": true
    }
  }
}
```

Các phần tử cốt lõi:

- **`StartAt`**: tên state khởi đầu (bắt buộc, phải khớp một key trong `States`).
- **`States`**: object chứa tất cả state, mỗi key là tên state.
- **`Type`**: loại state (bắt buộc cho mỗi state).
- **`Next`**: tên state tiếp theo. State kết thúc nhánh phải có **`"End": true`** thay vì `Next`. Một state không thể có cả hai.
- **`Comment`**: chú thích (tùy chọn).

Step Functions chạy execution: bắt đầu ở `StartAt`, chạy từng state, theo `Next` cho đến khi gặp `End: true`, một `Succeed`/`Fail` state, hoặc lỗi không bắt được. Mỗi state nhận một JSON input và tạo ra một JSON output, output của state này là input của state kế tiếp.

Bạn viết ASL trực tiếp, hoặc dùng **Workflow Studio** (drag-and-drop trên console sinh ra ASL), hoặc dùng **CDK/SAM** (định nghĩa bằng code). Trong SAM, state machine khai báo qua `AWS::Serverless::StateMachine` với `DefinitionUri` trỏ tới file ASL (chi tiết SAM ở Chương 36).

> 💡 **Exam Tip:** Mỗi state hoặc có `Next` (trỏ state kế) hoặc có `End: true` — ngoại lệ là các state "terminal" (`Succeed`, `Fail`) và `Choice` (dùng `Default`/`Choices`, không có `Next`/`End` ở cấp ngoài). Lỗi ASL phổ biến: thiếu `End` ở state cuối nhánh → validation fail.

## 43.3 Các state type

ASL có 8 loại state. Phải nhớ rõ vai trò từng loại vì đề hay hỏi "loại state nào dùng để rẽ nhánh / chạy song song / lặp qua mảng".

| State Type | Vai trò | Có làm "việc" không |
|---|---|---|
| **Task** | Thực hiện một đơn vị công việc: gọi Lambda, AWS service, Activity | Có |
| **Choice** | Rẽ nhánh dựa trên điều kiện (if/else) | Không |
| **Wait** | Tạm dừng một khoảng thời gian hoặc tới một timestamp | Không |
| **Parallel** | Chạy nhiều nhánh song song, chờ tất cả xong | Không (điều phối) |
| **Map** | Lặp qua một mảng, xử lý từng phần tử (có thể song song) | Không (điều phối) |
| **Pass** | Truyền input sang output (có thể chèn dữ liệu tĩnh), không gọi gì | Không |
| **Succeed** | Kết thúc execution thành công | Không (terminal) |
| **Fail** | Kết thúc execution thất bại với `Error`/`Cause` | Không (terminal) |

**Task** là state quan trọng nhất — đây là nơi công việc thực sự xảy ra. `Resource` là ARN của Lambda, ARN dạng integration của service (`arn:aws:states:::dynamodb:putItem`), hoặc ARN của Activity.

**Choice** rẽ nhánh:

```json
"CheckAmount": {
  "Type": "Choice",
  "Choices": [
    {
      "Variable": "$.order.total",
      "NumericGreaterThan": 1000,
      "Next": "ManualReview"
    },
    {
      "Variable": "$.order.total",
      "NumericLessThanEquals": 1000,
      "Next": "AutoApprove"
    }
  ],
  "Default": "AutoApprove"
}
```

`Choice` dùng comparison operators: `NumericEquals`, `NumericGreaterThan`, `StringEquals`, `BooleanEquals`, `TimestampGreaterThan`, `IsPresent`, `IsNull`... và logic `And`/`Or`/`Not`. **Luôn nên có `Default`** — nếu không khớp Choice nào và không có `Default`, execution fail với `States.NoChoiceMatched`.

**Wait** tạm dừng:

```json
"WaitOneHour": { "Type": "Wait", "Seconds": 3600, "Next": "SendReminder" }
```

Có thể dùng `Seconds`, `Timestamp` (chờ tới mốc thời gian tuyệt đối), hoặc `SecondsPath`/`TimestampPath` (lấy giá trị từ input). Với **Standard workflow**, `Wait` không tốn compute và có thể chờ tới **1 năm** — cực kỳ hữu ích cho quy trình như "chờ 7 ngày rồi gửi email nhắc".

**Pass** truyền dữ liệu, thường dùng để chèn dữ liệu tĩnh hoặc reshape JSON khi test:

```json
"Inject": {
  "Type": "Pass",
  "Result": { "status": "validated" },
  "ResultPath": "$.validation",
  "Next": "NextStep"
}
```

**Succeed/Fail** là terminal — dừng nhánh ngay. `Fail` cho phép đặt `Error` và `Cause` để báo lý do (và **không** dùng được `InputPath`/`OutputPath`).

> 💡 **Exam Tip:** Phân biệt nhanh cho đề: rẽ nhánh = **Choice**; chờ thời gian = **Wait**; song song nhiều việc khác nhau = **Parallel**; lặp cùng một việc trên từng phần tử mảng = **Map**; chèn/biến đổi dữ liệu không gọi service = **Pass**.

## 43.4 Parallel và Map — xử lý song song và lặp

**Parallel** chạy nhiều nhánh độc lập **đồng thời**, mỗi nhánh là một sub-workflow hoàn chỉnh, và chờ **tất cả** nhánh hoàn thành trước khi đi tiếp. Output là một **mảng** kết quả của từng nhánh theo thứ tự khai báo.

```json
"FanOut": {
  "Type": "Parallel",
  "Branches": [
    { "StartAt": "Resize", "States": { "Resize": { "Type": "Task", "Resource": "...:resize", "End": true } } },
    { "StartAt": "Thumbnail", "States": { "Thumbnail": { "Type": "Task", "Resource": "...:thumb", "End": true } } }
  ],
  "Next": "Combine"
}
```

Dùng `Parallel` khi bạn có **các tác vụ khác nhau** chạy song song (resize ảnh + tạo thumbnail + trích metadata). Nếu một nhánh fail và không bắt được lỗi, cả `Parallel` state fail.

**Map** lặp qua một **mảng** input, áp dụng cùng một sub-workflow (`ItemProcessor`) cho **từng phần tử**, mặc định chạy song song. Dùng khi số lượng phần tử động (xử lý 1 đơn hàng có N line items, hay xử lý N file). Có hai chế độ:

- **Inline Map (mặc định)**: chạy trong chính state machine execution. Giới hạn **tối đa 40 phần tử chạy song song đồng thời** và state history bị giới hạn (toàn bộ vẫn trong 25.000 events của execution Standard). Phù hợp dataset nhỏ-vừa.
- **Distributed Map**: chế độ cho **xử lý dữ liệu quy mô lớn** — đọc trực tiếp từ S3 (CSV/JSON/manifest), hỗ trợ **tối đa 10.000 child execution chạy song song**, mỗi item/batch chạy như một **child workflow execution riêng** (không chiếm 25.000 events history của parent). Có tham số `MaxConcurrency`, `ItemBatcher`, `ToleratedFailurePercentage` (cho phép một tỷ lệ item fail mà execution vẫn coi là thành công), và ghi kết quả ra S3.

```json
"ProcessItems": {
  "Type": "Map",
  "ItemProcessor": {
    "ProcessorConfig": { "Mode": "DISTRIBUTED", "ExecutionType": "STANDARD" },
    "StartAt": "ProcessOne",
    "States": { "ProcessOne": { "Type": "Task", "Resource": "...:process", "End": true } }
  },
  "ItemReader": {
    "Resource": "arn:aws:states:::s3:getObject",
    "ReaderConfig": { "InputType": "CSV", "CSVHeaderLocation": "FIRST_ROW" },
    "Parameters": { "Bucket": "my-data", "Key": "items.csv" }
  },
  "MaxConcurrency": 1000,
  "ToleratedFailurePercentage": 5,
  "End": true
}
```

> 💡 **Exam Tip:** "Lặp qua hàng triệu object trong S3 / một file lớn, xử lý song song quy mô lớn" → **Distributed Map** (tới 10.000 parallel child executions). "Lặp qua một mảng nhỏ trong input" → **Inline Map** (max 40 concurrency). `Parallel` ≠ `Map`: Parallel là các nhánh **khác nhau** cố định; Map là **cùng một** logic lặp trên mảng.

## 43.5 Standard vs Express workflows

Đây là một trong những điểm thi quan trọng nhất của chương. Step Functions có hai loại workflow, chọn sai là sai tiền và sai semantics.

| Tiêu chí | **Standard** | **Express** |
|---|---|---|
| Thời lượng tối đa | **1 năm** | **5 phút** |
| Execution semantics | **Exactly-once** | **At-least-once** |
| Giá tính theo | Số **state transition** | Số request **+ duration × memory** (GB-second) |
| Execution rate | ~2.000 start/giây | **>100.000** start/giây |
| Execution history | Lưu đầy đủ trên console + API (90 ngày) | **Không** lưu chi tiết; gửi log qua CloudWatch Logs (nếu bật) |
| Hỗ trợ `.sync` (run a job) | Có | **Không** |
| Hỗ trợ `.waitForTaskToken` | Có | Có (nhưng giới hạn 5 phút tổng) |
| Use case điển hình | Workflow dài, có human approval, xử lý nghiệp vụ quan trọng cần audit | Stream/event processing tần suất cao, ngắn, IoT ingestion, microservice orchestration |

Điểm cốt lõi về **semantics**:

- **Standard = exactly-once**: mỗi state được thực thi đúng một lần (Step Functions đảm bảo không double-execute logic điều phối). Phù hợp khi mỗi bước có side-effect quan trọng (trừ tiền, tạo đơn) và không được lặp.
- **Express = at-least-once**: một state có thể chạy **nhiều hơn một lần** trong tình huống nhất định. Do đó task trong Express workflow **phải idempotent** (chạy lại không gây hậu quả). Đổi lại, Express rẻ và throughput cực cao.

Về **giá**: Standard tính **mỗi state transition** ($0.025 / 1.000 transitions ở mức tham khảo) — workflow nhiều bước, chạy nhiều lần sẽ đắt. Express tính theo **số lần invoke + thời lượng × bộ nhớ** giống Lambda — với workflow ngắn chạy hàng triệu lần, Express **rẻ hơn nhiều lần** so với Standard.

Express còn chia làm hai kiểu invoke: **Asynchronous Express** (gọi xong trả ngay, không chờ kết quả, dùng cho fire-and-forget/event processing) và **Synchronous Express** (gọi và chờ kết quả trả về — dùng đứng sau API Gateway để trả response cho client).

> 💡 **Exam Tip:** Câu hỏi "high-volume, short-duration, event-processing workflow, cost-effective" → **Express**. Câu hỏi "long-running, human approval, exactly-once, cần audit từng bước" → **Standard**. Nhớ: chỉ **Standard** hỗ trợ `.sync` (run a job). Express chạy tối đa **5 phút** — nếu workflow có thể vượt 5 phút, bắt buộc **Standard**.

## 43.6 Service integrations và ba integration pattern

`Task` state gọi service bên ngoài. Step Functions tích hợp với hơn 200 service AWS theo hai cách: **Optimized integrations** (cú pháp gọn cho các service phổ biến như Lambda, SNS, SQS, DynamoDB, ECS, Glue, SageMaker...) và **AWS SDK integrations** (gọi gần như mọi API của mọi service, ARN dạng `arn:aws:states:::aws-sdk:serviceName:apiAction`). Nhờ vậy bạn **không cần Lambda trung gian** chỉ để `PutItem` hay `Publish`.

Ba **integration pattern** quyết định Step Functions chờ Task như thế nào — đây là điểm thi cốt lõi:

**1. Request-Response (mặc định)** — gọi service và đi tiếp **ngay khi nhận HTTP response**, không chờ công việc bên dưới hoàn tất.

```json
"NotifyUser": {
  "Type": "Task",
  "Resource": "arn:aws:states:::sns:publish",
  "Parameters": { "TopicArn": "arn:aws:sns:...:alerts", "Message.$": "$.msg" },
  "Next": "Done"
}
```

**2. Run a Job — `.sync`** — gọi một job và **chờ cho tới khi job hoàn tất** rồi mới đi tiếp. Dùng cho job chạy lâu: ECS task, AWS Batch, Glue job, EMR step. ARN có hậu tố `.sync` (hoặc `.sync:2`). Step Functions tự poll trạng thái job; bạn không phải tự viết vòng lặp kiểm tra.

```json
"RunBatch": {
  "Type": "Task",
  "Resource": "arn:aws:states:::ecs:runTask.sync",
  "Parameters": { "Cluster": "my-cluster", "TaskDefinition": "etl-task" },
  "Next": "AfterJob"
}
```

**3. Wait for Callback — `.waitForTaskToken`** — Step Functions gửi một **task token** vào payload, **dừng lại** (có thể tới 1 năm với Standard) cho đến khi có ai đó gọi `SendTaskSuccess`/`SendTaskFailure` với token đó. Đây là cơ chế cho **human approval** hoặc tích hợp hệ thống bên ngoài bất đồng bộ.

```json
"WaitForApproval": {
  "Type": "Task",
  "Resource": "arn:aws:states:::lambda:invoke.waitForTaskToken",
  "Parameters": {
    "FunctionName": "request-approval",
    "Payload": {
      "taskToken.$": "$$.Task.Token",
      "orderId.$": "$.orderId"
    }
  },
  "Next": "Approved"
}
```

`$$.Task.Token` lấy token từ **context object** (`$$`). Lambda `request-approval` gửi email/Slack chứa link kèm token; khi người duyệt bấm Approve, hệ thống gọi:

```javascript
import { SFNClient, SendTaskSuccessCommand } from "@aws-sdk/client-sfn";
const sfn = new SFNClient({});
// gọi khi người dùng phê duyệt — token nhận từ payload đã gửi trước đó
await sfn.send(new SendTaskSuccessCommand({
  taskToken: token,
  output: JSON.stringify({ approved: true, approver: "alice" })
}));
```

Có thể đặt `HeartbeatSeconds` và `TimeoutSeconds` trên Task waitForTaskToken: nếu không nhận callback trong timeout → state fail với `States.Timeout` (bắt được bằng `Catch`).

> 💡 **Exam Tip:** Ba pattern là câu hỏi kinh điển. "Gọi xong đi tiếp ngay" = **request-response**. "Chờ job (ECS/Batch/Glue) chạy xong" = **`.sync`**. "Chờ phê duyệt của con người / hệ thống bên ngoài trả về sau" = **`.waitForTaskToken`** + `SendTaskSuccess`/`SendTaskFailure`. `.sync` **không** dùng được trong Express workflow.

## 43.7 Error handling — Retry và Catch

Mọi Task/Parallel/Map đều có thể lỗi. Step Functions cung cấp hai cơ chế built-in: **Retry** (thử lại tại chỗ) và **Catch** (chuyển sang state xử lý lỗi). Đây là lý do lớn để dùng Step Functions thay vì tự code.

**Predefined error codes** (đề hay hỏi):

- `States.ALL` — bắt mọi lỗi (phải để **cuối cùng** trong danh sách).
- `States.TaskFailed` — Task fail (lỗi từ Lambda/service).
- `States.Timeout` — vượt `TimeoutSeconds` hoặc không có heartbeat.
- `States.Permissions` — thiếu IAM quyền gọi resource.
- `States.DataLimitExceeded` — output vượt **256 KB**.
- `States.Runtime`, `States.HeartbeatTimeout`... Ngoài ra, lỗi custom do code ném ra (ví dụ Lambda throw `InventoryError`) có thể match bằng đúng tên đó.

**Retry** — thử lại cùng state với exponential backoff:

```json
"ChargePayment": {
  "Type": "Task",
  "Resource": "arn:aws:lambda:...:charge",
  "Retry": [
    {
      "ErrorEquals": ["States.Timeout", "ServiceUnavailable"],
      "IntervalSeconds": 2,
      "MaxAttempts": 4,
      "BackoffRate": 2.0,
      "MaxDelaySeconds": 30,
      "JitterStrategy": "FULL"
    },
    {
      "ErrorEquals": ["States.ALL"],
      "MaxAttempts": 1
    }
  ],
  "Catch": [
    {
      "ErrorEquals": ["States.ALL"],
      "ResultPath": "$.error",
      "Next": "RefundAndAlert"
    }
  ],
  "Next": "CreateShipment"
}
```

Cơ chế backoff: lần chờ đầu = `IntervalSeconds` (mặc định 1), mỗi lần nhân với `BackoffRate` (mặc định 2.0). Với cấu hình trên: chờ 2s, 4s, 8s, 16s (giới hạn bởi `MaxDelaySeconds: 30`). `MaxAttempts` mặc định 3, đặt 0 để **không** retry. `JitterStrategy: FULL` thêm độ ngẫu nhiên để tránh thundering herd. Step Functions duyệt mảng `Retry` theo thứ tự, dùng **retrier đầu tiên** khớp `ErrorEquals`.

**Catch** — khi retry cạn (hoặc không có retry khớp), Catch chuyển execution sang state khác thay vì fail toàn bộ. `ResultPath` trong Catch quyết định lỗi (`Error`, `Cause`) được chèn vào đâu trong input để state xử lý lỗi đọc được — ví dụ `"ResultPath": "$.error"` giữ nguyên input gốc và thêm field `error`.

Thứ tự xử lý: khi Task lỗi → kiểm tra `Retry` trước → nếu hết attempt hoặc không khớp → kiểm tra `Catch` → nếu không Catch nào khớp → state (và execution) fail.

> 💡 **Exam Tip:** `States.ALL` phải nằm **cuối** mảng Retry/Catch (nó match mọi thứ nên đặt trước sẽ nuốt hết). Retry = thử lại **cùng** state; Catch = **rẽ** sang state khác. Để chuyển dữ liệu lỗi cho bước xử lý, dùng `ResultPath` trong Catch (vd `$.error`). Đề thường hỏi "Lambda gặp lỗi transient (throttling) → tự thử lại với backoff" → đáp án là cấu hình **Retry** trong state machine, không sửa code Lambda.

## 43.8 Input và output processing

Hiểu dữ liệu chảy qua state là phần khó nhưng hay bị hỏi. Mỗi state xử lý JSON qua một chuỗi filter theo đúng thứ tự: **`InputPath` → `Parameters` → (Task chạy) → `ResultSelector` → `ResultPath` → `OutputPath`**.

- **`InputPath`**: chọn một phần của input thô để dùng (JSONPath). `InputPath: "$.order"` chỉ lấy nhánh `order`. `null` = input rỗng `{}`.
- **`Parameters`**: dựng **payload** gửi tới resource. Field kết thúc bằng `.$` lấy giá trị từ input/context; field thường là hằng. Đây là nơi đặt `taskToken.$`, hằng số cấu hình, v.v.
- **`ResultSelector`**: lọc/reshape **kết quả thô** trả về từ resource trước khi đưa vào `ResultPath` (vd chỉ lấy `Payload` từ response Lambda).
- **`ResultPath`**: quyết định kết quả được **đặt vào đâu** trong input. `ResultPath: "$.result"` → giữ nguyên input gốc, thêm `result`. `ResultPath: "$"` (mặc định) → kết quả **thay thế toàn bộ** input. `ResultPath: null` → bỏ kết quả, giữ nguyên input.
- **`OutputPath`**: lọc lần cuối để chọn phần nào của JSON trở thành **output** truyền sang state kế.

Ví dụ minh họa giữ lại input gốc và bổ sung kết quả:

```json
"Validate": {
  "Type": "Task",
  "Resource": "arn:aws:states:::lambda:invoke",
  "Parameters": {
    "FunctionName": "validate-order",
    "Payload.$": "$.order"
  },
  "ResultSelector": { "valid.$": "$.Payload.valid" },
  "ResultPath": "$.validation",
  "OutputPath": "$",
  "Next": "Decide"
}
```

Ở đây: gửi `$.order` cho Lambda; lấy `Payload.valid` từ response (bỏ metadata Lambda); đặt vào `$.validation`; output giữ toàn bộ input + `validation`. Bẫy kinh điển: khi gọi `lambda:invoke`, response bọc trong `Payload` (cùng `StatusCode`, `ExecutedVersion`...) — quên `ResultSelector`/`$.Payload` là lỗi rất hay gặp.

**Context object `$$`**: ngoài input, bạn truy cập metadata execution qua `$$`: `$$.Execution.Id`, `$$.Execution.Input`, `$$.State.Name`, `$$.Task.Token` (cho callback), `$$.Map.Item.Value` (phần tử hiện tại trong Map). `$$.Map.Item.Value` đặc biệt hữu ích để lấy item đang xử lý trong vòng Map.

> 💡 **Exam Tip:** Nhớ thứ tự filter: **InputPath → Parameters → ResultSelector → ResultPath → OutputPath**. Câu hỏi "giữ lại input ban đầu nhưng thêm kết quả của Task" → dùng **`ResultPath`** (vd `$.taskResult`); nếu để mặc định `$` thì output sẽ **ghi đè** input. Output mỗi state tối đa **256 KB** — vượt thì `States.DataLimitExceeded`; với payload lớn dùng pattern lưu S3 rồi truyền reference (giống large object pattern ở Chương 32).

## 43.9 X-Ray, giám sát và Activities (legacy)

**X-Ray tracing** (chi tiết X-Ray ở Chương 26): bật trace cho state machine để thấy bản đồ end-to-end của workflow — mỗi Task, mỗi service integration thành một segment, giúp xác định bước nào chậm/lỗi. Bật bằng `--tracing-configuration enabled=true` khi tạo state machine; execution role cần quyền `xray:PutTraceSegments`, `xray:PutTelemetryRecords`. Đây là cách trả lời câu hỏi "trace toàn bộ workflow đa service".

**CloudWatch**: Step Functions phát metric như `ExecutionsStarted`, `ExecutionsSucceeded`, `ExecutionsFailed`, `ExecutionsTimedOut`, `ExecutionThrottled`. Với **Express**, vì không lưu execution history, bạn **phải** bật **CloudWatch Logs** (chọn log level `ALL`/`ERROR`/`FATAL`) để debug — đây là khác biệt vận hành quan trọng so với Standard. Standard lưu lịch sử đầy đủ trên console và qua `GetExecutionHistory` API trong 90 ngày.

**Activities (legacy)**: trước khi có `.waitForTaskToken`, Step Functions dùng **Activity** — một worker (chạy trên EC2, on-prem, container, mobile) tự **poll** Step Functions bằng `GetActivityTask`, làm việc, rồi gọi `SendTaskSuccess`/`SendTaskFailure`. Activity hữu ích khi công việc chạy trên hạ tầng tự quản (không phải Lambda/AWS service) và bạn muốn chính worker đi lấy task. Tạo bằng `aws stepfunctions create-activity`, Task tham chiếu ARN activity. Lưu ý: **Activities chỉ dùng được với Standard workflow**, không hỗ trợ Express, và ngày nay đa số use case "task callback" được giải bằng `.waitForTaskToken` linh hoạt hơn.

Khởi chạy execution bằng SDK v3:

```javascript
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
const sfn = new SFNClient({ region: "ap-southeast-1" });

const res = await sfn.send(new StartExecutionCommand({
  stateMachineArn: "arn:aws:states:ap-southeast-1:111122223333:stateMachine:OrderProcessing",
  name: `order-${Date.now()}`,          // tên duy nhất → idempotency cho Standard
  input: JSON.stringify({ orderId: "A-1001", total: 1500 })
}));
console.log(res.executionArn);
```

Với **Standard**, dùng `StartExecution` có `name` trùng trong **90 ngày** sẽ bị coi là idempotent (không tạo execution mới) — tận dụng để chống tạo trùng. Với **Synchronous Express**, dùng `StartSyncExecution` để gọi-và-chờ-kết-quả (lý tưởng đứng sau API Gateway).

> 💡 **Exam Tip:** Express workflow **không** lưu execution history → muốn debug phải bật **CloudWatch Logs**; đây là bẫy "tại sao không thấy chi tiết execution". Khi cần worker trên hạ tầng tự quản tự kéo task → **Activity** (chỉ Standard). Trace đa-service toàn workflow → bật **X-Ray**. Idempotency của Standard dựa trên `name` trùng trong 90 ngày.

---

## Hands-on Lab: Order-processing workflow với Step Functions (Task, Choice, Retry/Catch, Map, .waitForTaskToken, X-Ray)

**Mục tiêu lab:** Dựng một state machine **Standard** mô phỏng luồng xử lý đơn hàng: kiểm tra tồn kho bằng một Lambda (Task), rẽ nhánh theo kết quả (Choice), nếu đơn giá trị cao thì chờ người phê duyệt qua callback token (`.waitForTaskToken`), xử lý từng line-item bằng `Map`, có `Retry`/`Catch` chuẩn, rồi ghi DynamoDB bằng **optimized integration** (không cần Lambda). Bạn sẽ deploy bằng AWS CLI, chạy execution, đọc execution history, bật X-Ray để xem service map, và so sánh hành vi giữa Standard và Express. Chi phí gần như $0 nếu xoá ngay: Standard tính theo state transition ($0.025 / 1000 transition, 4000 transition đầu/tháng free).

**Chuẩn bị:**
- AWS CLI v2 (`aws --version` ra `aws-cli/2.x`), profile có quyền `states:*`, `lambda:*`, `iam:*`, `dynamodb:*`, `logs:*`, `xray:*`.
- Đặt biến: `REGION=ap-southeast-1`, `ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)`.
- Node.js để zip Lambda (không bắt buộc cài runtime cục bộ).

### Bước 1: Tạo bảng DynamoDB và Lambda kiểm tra tồn kho

```bash
aws dynamodb create-table --table-name dva-orders \
  --attribute-definitions AttributeName=orderId,AttributeType=S \
  --key-schema AttributeName=orderId,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST --region $REGION
```

Lambda `checkInventory` trả về `inStock` true/false. Lưu ý: nếu hàng "OUT_OF_STOCK" thì **throw** một lỗi có tên cụ thể để minh hoạ `Catch`:

```javascript
// index.mjs
export const handler = async (event) => {
  // event là object đầu vào của Task (sau Parameters nếu có)
  const qty = event.quantity ?? 0;
  if (event.sku === "BROKEN") {
    const err = new Error("Inventory service unavailable");
    err.name = "InventoryError";   // ErrorEquals sẽ khớp tên này
    throw err;
  }
  return { inStock: qty <= 100, available: 100 - qty };
};
```

```bash
mkdir fn && cd fn && cp ../index.mjs . && zip -r ../fn.zip . && cd ..

cat > lambda-trust.json <<'EOF'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow",
 "Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}
EOF
aws iam create-role --role-name dva-sfn-lambda-role \
  --assume-role-policy-document file://lambda-trust.json
aws iam attach-role-policy --role-name dva-sfn-lambda-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
sleep 10

aws lambda create-function --function-name checkInventory \
  --runtime nodejs20.x --handler index.handler \
  --role arn:aws:iam::$ACCOUNT_ID:role/dva-sfn-lambda-role \
  --zip-file fileb://fn.zip --region $REGION
```

### Bước 2: Tạo IAM role cho state machine

State machine cần role với trust cho `states.amazonaws.com` và quyền gọi Lambda, ghi DynamoDB, và (cho X-Ray) ghi trace.

```bash
cat > sfn-trust.json <<'EOF'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow",
 "Principal":{"Service":"states.amazonaws.com"},"Action":"sts:AssumeRole"}]}
EOF
aws iam create-role --role-name dva-sfn-role \
  --assume-role-policy-document file://sfn-trust.json

cat > sfn-perms.json <<EOF
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":"lambda:InvokeFunction",
  "Resource":"arn:aws:lambda:$REGION:$ACCOUNT_ID:function:checkInventory*"},
 {"Effect":"Allow","Action":["dynamodb:PutItem","dynamodb:UpdateItem"],
  "Resource":"arn:aws:dynamodb:$REGION:$ACCOUNT_ID:table/dva-orders"},
 {"Effect":"Allow","Action":["xray:PutTraceSegments","xray:PutTelemetryRecords",
  "xray:GetSamplingRules","xray:GetSamplingTargets"],"Resource":"*"}
]}
EOF
aws iam put-role-policy --role-name dva-sfn-role \
  --policy-name sfn-inline --policy-document file://sfn-perms.json
```

> Bẫy thi: state machine **không tự thừa hưởng** quyền của bạn — mọi service integration chạy dưới role này. Thiếu `lambda:InvokeFunction` → Task lỗi `States.TaskFailed` với cause `AccessDenied`. Với optimized integration kiểu `.sync` (ví dụ ECS `runTask.sync`) còn cần thêm quyền EventBridge (`events:PutRule`) để Step Functions tạo rule theo dõi job — đây là điểm rất hay bị quên.

### Bước 3: Viết Amazon States Language (ASL)

Định nghĩa đầy đủ: Task (Lambda) → Choice → (Map xử lý items song song) → Pass ghi metadata → DynamoDB optimized integration. Có `Retry` backoff và `Catch` chuyển sang state `HandleFailure`.

```bash
cat > orders.asl.json <<EOF
{
  "Comment": "Order processing",
  "StartAt": "CheckInventory",
  "States": {
    "CheckInventory": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:$REGION:$ACCOUNT_ID:function:checkInventory",
      "Retry": [
        { "ErrorEquals": ["Lambda.TooManyRequestsException","States.Timeout"],
          "IntervalSeconds": 2, "MaxAttempts": 3, "BackoffRate": 2.0 }
      ],
      "Catch": [
        { "ErrorEquals": ["InventoryError"], "ResultPath": "\$.error",
          "Next": "HandleFailure" }
      ],
      "ResultPath": "\$.inventory",
      "Next": "InStock?"
    },
    "InStock?": {
      "Type": "Choice",
      "Choices": [
        { "Variable": "\$.inventory.inStock", "BooleanEquals": true,
          "Next": "ProcessItems" }
      ],
      "Default": "HandleFailure"
    },
    "ProcessItems": {
      "Type": "Map",
      "ItemsPath": "\$.items",
      "MaxConcurrency": 5,
      "ItemProcessor": {
        "ProcessorConfig": { "Mode": "INLINE" },
        "StartAt": "PriceItem",
        "States": {
          "PriceItem": { "Type": "Pass",
            "Parameters": { "sku.\$": "\$.sku", "lineTotal.\$":
              "States.MathAdd(\$.price, 0)" },
            "End": true }
        }
      },
      "ResultPath": "\$.priced",
      "Next": "SaveOrder"
    },
    "SaveOrder": {
      "Type": "Task",
      "Resource": "arn:aws:states:::dynamodb:putItem",
      "Parameters": {
        "TableName": "dva-orders",
        "Item": { "orderId": { "S.\$": "\$.orderId" },
                  "status": { "S": "CONFIRMED" } }
      },
      "ResultPath": null,
      "Next": "Done"
    },
    "Done":          { "Type": "Succeed" },
    "HandleFailure": { "Type": "Fail", "Error": "OrderFailed",
                       "Cause": "Inventory check failed or out of stock" }
  }
}
EOF
```

Vài chi tiết đáng chú ý cho đề thi:
- `Resource` của Lambda là **ARN function** → đây là pattern *request-response* (gọi xong nhận kết quả ngay). Còn `arn:aws:states:::dynamodb:putItem` là **optimized integration** — Step Functions gọi DynamoDB trực tiếp, không tốn một Lambda.
- `ResultPath: "$.inventory"` chèn kết quả Task vào input gốc (giữ nguyên `orderId`, `items`). `ResultPath: null` ở SaveOrder vứt kết quả PutItem, giữ nguyên state. Hiểu rõ chuỗi **InputPath → Parameters → ResultSelector → ResultPath → OutputPath** là điểm thi gần như chắc chắn.
- `Catch` đặt `ResultPath: "$.error"` để giữ lại input và bọc thêm thông tin lỗi (`Error`, `Cause`) thay vì thay thế toàn bộ.

### Bước 4: Tạo state machine (bật X-Ray + logging)

```bash
aws logs create-log-group --log-group-name /aws/sfn/dva-orders --region $REGION
LG_ARN=$(aws logs describe-log-groups --log-group-name-prefix /aws/sfn/dva-orders \
  --query 'logGroups[0].arn' --output text --region $REGION)

aws stepfunctions create-state-machine \
  --name dva-orders \
  --definition file://orders.asl.json \
  --role-arn arn:aws:iam::$ACCOUNT_ID:role/dva-sfn-role \
  --type STANDARD \
  --tracing-configuration enabled=true \
  --logging-configuration "level=ALL,includeExecutionData=true,destinations=[{cloudWatchLogsLogGroup={logGroupArn=$LG_ARN}}]" \
  --region $REGION
```

> Bẫy: với **Express workflow**, execution history KHÔNG lưu trong Step Functions console — bạn BẮT BUỘC bật CloudWatch Logs để debug. Với **Standard**, history giữ 90 ngày và xem được trực tiếp trên console. Tham số `--type` không sửa được sau khi tạo — đổi loại phải tạo state machine mới.

### Bước 5: Chạy execution và đọc kết quả

```bash
SM_ARN=$(aws stepfunctions list-state-machines \
  --query "stateMachines[?name=='dva-orders'].stateMachineArn" \
  --output text --region $REGION)

aws stepfunctions start-execution --state-machine-arn $SM_ARN \
  --input '{"orderId":"O-1001","sku":"BOOK","quantity":3,
            "items":[{"sku":"BOOK","price":10},{"sku":"PEN","price":2}]}' \
  --region $REGION
```

Output là `executionArn` + `startDate`. Xem trạng thái và lịch sử:

```bash
EXEC=$(aws stepfunctions list-executions --state-machine-arn $SM_ARN \
  --query 'executions[0].executionArn' --output text --region $REGION)
aws stepfunctions describe-execution --execution-arn $EXEC \
  --query '{status:status,output:output}' --region $REGION
```

Mong đợi `status: SUCCEEDED`, output chứa `inventory.inStock=true` và bản ghi đã vào DynamoDB (`aws dynamodb get-item --table-name dva-orders --key '{"orderId":{"S":"O-1001"}}'`).

**Thử nhánh lỗi + Catch:** gửi `"sku":"BROKEN"` để Lambda throw `InventoryError`:

```bash
aws stepfunctions start-execution --state-machine-arn $SM_ARN \
  --input '{"orderId":"O-1002","sku":"BROKEN","quantity":1,"items":[]}' \
  --region $REGION
```

Execution kết thúc `FAILED` với error `OrderFailed` (Catch đã bắt `InventoryError` → đi tới state Fail `HandleFailure`). Xem chi tiết từng transition:

```bash
aws stepfunctions get-execution-history --execution-arn $EXEC \
  --max-results 20 --query 'events[].type' --output text --region $REGION
```

### Bước 6: Xem X-Ray service map

Mở console X-Ray → Service map, hoặc:

```bash
aws xray get-trace-summaries --region $REGION \
  --start-time $(date -u -v-10M +%s) --end-time $(date -u +%s) \
  --query 'TraceSummaries[].Id' --output text
```

Bạn sẽ thấy node Step Functions nối tới Lambda `checkInventory` và DynamoDB — đúng những integration trong ASL. Trace giúp tìm Task chậm/nhiều lỗi.

### Dọn dẹp tài nguyên

```bash
aws stepfunctions delete-state-machine --state-machine-arn $SM_ARN --region $REGION
aws lambda delete-function --function-name checkInventory --region $REGION
aws dynamodb delete-table --table-name dva-orders --region $REGION
aws logs delete-log-group --log-group-name /aws/sfn/dva-orders --region $REGION
aws iam delete-role-policy --role-name dva-sfn-role --policy-name sfn-inline
aws iam delete-role --role-name dva-sfn-role
aws iam detach-role-policy --role-name dva-sfn-lambda-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam delete-role --role-name dva-sfn-lambda-role
rm -rf fn fn.zip *.json index.mjs orders.asl.json
```

> Lưu ý: `delete-state-machine` chạy **bất đồng bộ** — state machine chuyển trạng thái `DELETING`, các execution đang chạy vẫn tiếp tục cho xong. State machine không tính phí khi tồn tại (chỉ tính theo execution), nên không cần lo về phí nếu xoá chậm.

## 💡 Exam Tips chương 43

- **Standard vs Express là câu hỏi đinh.** Standard: tối đa **1 năm**, *exactly-once*, tính phí theo **state transition**, history 90 ngày, hợp cho workflow dài/cần audit. Express: tối đa **5 phút**, async là *at-least-once* (sync là at-most-once), tính phí theo **số lần chạy + thời gian + bộ nhớ**, throughput rất cao (>100k/s), hợp cho event streaming/IoT/ingest tần suất cao. "High-volume, short-duration" → Express; "long-running, exactly-once, human approval" → Standard.
- Ba **integration pattern** phải thuộc: *Request-Response* (mặc định, gọi xong đi tiếp), *Run a Job* hậu tố `.sync` (chờ job thật sự xong — ECS task, Glue, Batch, EMR), *Wait for Callback* hậu tố `.waitForTaskToken` (chờ tới khi có `SendTaskSuccess/Failure` mang token — dùng cho human approval, hệ thống ngoài).
- `.waitForTaskToken`: token nằm ở `$$.Task.Token` (context object). Quên gọi `SendTaskSuccess` → execution treo tới khi `HeartbeatSeconds`/timeout. Đây là cách làm **human-in-the-loop** đúng chuẩn (không phải Wait state hay polling).
- **Error handling thứ tự:** `Retry` chạy trước, hết `MaxAttempts` mới tới `Catch`. Backoff = `IntervalSeconds * BackoffRate^(attempt-1)`. `States.ALL` bắt mọi lỗi nhưng phải đặt **cuối cùng** trong mảng. `States.TaskFailed` bắt lỗi do resource, `States.Timeout` cho hết giờ.
- **Wrap lỗi không nuốt input:** đặt `ResultPath: "$.error"` trong `Catch` để giữ input gốc; nếu bỏ trống, output chỉ còn object lỗi.
- **Input/Output processing đúng thứ tự:** `InputPath` → `Parameters` → (Task chạy) → `ResultSelector` → `ResultPath` → `OutputPath`. `Parameters` dùng `"key.$"` để lấy giá trị động; `ResultPath` quyết định nhét kết quả vào đâu (`null` = bỏ kết quả, giữ input).
- **Map: inline vs distributed.** Inline Map giới hạn **40 concurrency**, dữ liệu nằm trong state (giới hạn payload 256KB). **Distributed Map** đọc dữ liệu lớn từ S3, tới **10.000 concurrency**, dùng cho xử lý hàng triệu item (big-data fan-out). Thấy "process millions of S3 objects" → Distributed Map.
- **Parallel** chạy nhiều nhánh tĩnh song song và đợi tất cả; output là **mảng** theo thứ tự nhánh. Khác Map (lặp trên collection động).
- **Giới hạn cần nhớ:** payload state tối đa **256KB** (vượt → dùng S3 + truyền ARN, pattern "claim check"). Tên execution unique trong 90 ngày. API throttle (`StartExecution`, `StateTransition`) có quota theo region.
- State machine chạy dưới **IAM role riêng**; mọi integration cần quyền tương ứng. `.sync` integration cần thêm quyền EventBridge để Step Functions tạo managed rule theo dõi job.
- **X-Ray:** bật `tracingConfiguration.enabled=true` để có service map. Standard cũng cần CloudWatch Logs để log; Express thì gần như BẮT BUỘC bật logging vì không có history trên console.
- **Activities (legacy):** worker tự poll `GetActivityTask` rồi gọi `SendTaskSuccess`. Ngày nay ưu tiên `.waitForTaskToken` qua service integration thay cho Activity.

## Quiz chương 43 (10 câu)

**Câu 1.** Một workflow cần chờ con người phê duyệt (có thể mất nhiều giờ) trước khi tiếp tục. Cách triển khai đúng chuẩn Step Functions?
- A. Dùng Wait state với Seconds=86400 rồi kiểm tra lại
- B. Dùng Task với `.waitForTaskToken`; hệ thống phê duyệt gọi `SendTaskSuccess` kèm token
- C. Dùng Choice state poll DynamoDB trong vòng lặp
- D. Dùng Activity với `.sync`

**Câu 2.** Một developer cần xử lý 2 triệu file trong S3, mỗi file chạy qua một sub-workflow, với độ song song rất cao. Chọn gì?
- A. Inline Map state
- B. Parallel state với 2 triệu nhánh
- C. Distributed Map state đọc từ S3
- D. Một Lambda lặp tuần tự qua tất cả file

**Câu 3.** Ứng dụng cần xử lý hàng trăm nghìn event/giây, mỗi luồng chạy dưới vài giây, không cần audit dài hạn, tối ưu chi phí. Loại workflow nào?
- A. Standard
- B. Express
- C. Standard với Distributed Map
- D. Activity-based

**Câu 4.** Trong một Task gọi Lambda, bạn muốn retry tối đa 3 lần với backoff khi gặp `Lambda.TooManyRequestsException`, nhưng nếu lỗi `ValidationError` thì chuyển ngay sang state xử lý lỗi. Cấu hình nào đúng?
- A. Chỉ dùng Catch cho cả hai
- B. Retry cho `Lambda.TooManyRequestsException`, Catch cho `ValidationError`
- C. Chỉ dùng Retry với `States.ALL`
- D. Dùng Choice state để kiểm tra lỗi

**Câu 5.** Một Task PutItem vào DynamoDB nhưng bạn muốn output của state giữ nguyên input ban đầu, không kèm response của DynamoDB. Đặt gì?
- A. `OutputPath: "$"`
- B. `ResultSelector: {}`
- C. `ResultPath: null`
- D. `InputPath: null`

**Câu 6.** State machine báo lỗi `States.TaskFailed` với cause chứa `is not authorized to perform: lambda:InvokeFunction` ở Task đầu tiên. Nguyên nhân?
- A. Lambda function bị xoá
- B. IAM role của state machine thiếu quyền InvokeFunction
- C. Sai vùng region của Lambda
- D. Payload vượt 256KB

**Câu 7.** Bạn dùng Express workflow nhưng không tìm thấy execution history trong console Step Functions để debug. Vì sao và làm sao xem?
- A. Express không lưu history trong console; bật CloudWatch Logs để xem
- B. Phải đợi 90 ngày
- C. Express không hỗ trợ logging
- D. Phải đổi sang Activities

**Câu 8.** Workflow điều phối một ECS task và phải đợi task chạy xong mới sang state kế. Integration nào?
- A. `arn:aws:states:::ecs:runTask` (request-response)
- B. `arn:aws:states:::ecs:runTask.sync`
- C. `arn:aws:states:::ecs:runTask.waitForTaskToken` nhưng không gửi token
- D. Gọi Lambda để poll ECS

**Câu 9.** Một state có nhiều quy tắc Retry và bạn muốn một quy tắc bắt MỌI lỗi còn lại. Đặt `States.ALL` ở đâu trong mảng Retry?
- A. Phần tử đầu tiên
- B. Phần tử cuối cùng
- C. Bất kỳ vị trí nào
- D. Không được dùng States.ALL trong Retry

**Câu 10.** Một Task cần truyền payload 500KB giữa các state. Execution lỗi với `States.DataLimitExceeded`. Giải pháp tối ưu?
- A. Tăng quota payload qua support ticket
- B. Lưu dữ liệu lớn vào S3, chỉ truyền ARN/key giữa các state (claim-check)
- C. Đổi sang Express workflow
- D. Chia state machine làm hai

### Đáp án & giải thích

**Câu 1 — Đáp án B.** `.waitForTaskToken` tạm dừng workflow tới khi nhận `SendTaskSuccess/SendTaskFailure` kèm token — đúng pattern human-in-the-loop, không tốn tài nguyên chờ. A lãng phí và Wait tối đa cũng có giới hạn, không phản ứng tức thì khi duyệt xong. C polling tốn kém và phản thiết kế. D sai: Activity không kết hợp `.sync`, và bản thân Activity là cách cũ.

**Câu 2 — Đáp án C.** Distributed Map đọc dataset lớn từ S3, hỗ trợ tới 10.000 concurrency và vượt giới hạn payload 256KB. A inline Map tối đa 40 concurrency và giữ data trong state (256KB). B Parallel dùng cho nhánh tĩnh, không lặp dữ liệu động và không scale tới triệu nhánh. D tuần tự sẽ vượt timeout Lambda 15 phút và quá chậm.

**Câu 3 — Đáp án B.** Express tối ưu cho high-throughput, short-duration (≤5 phút), tính phí theo lần chạy + duration nên rẻ ở volume lớn. A Standard tính theo state transition → đắt khủng khiếp ở volume này và giới hạn throughput thấp hơn. C vẫn là Standard. D Activity không liên quan throughput.

**Câu 4 — Đáp án B.** Retry xử lý lỗi tạm thời (throttling) với backoff; Catch chuyển hướng lỗi nghiệp vụ sang state khác. A bỏ retry sẽ fail ngay khi throttle. C `States.ALL` retry cả ValidationError là vô nghĩa (lỗi không tự khỏi). D Choice không bắt được lỗi runtime của Task.

**Câu 5 — Đáp án C.** `ResultPath: null` loại bỏ kết quả của Task và giữ nguyên input làm output. A `OutputPath: "$"` vẫn để ResultPath mặc định (`$`) ghi đè input bằng result. B `ResultSelector: {}` lọc result thành rỗng nhưng vẫn theo ResultPath mặc định. D `InputPath: null` biến input thành rỗng — sai mục tiêu.

**Câu 6 — Đáp án B.** State machine chạy dưới IAM role của nó; thiếu `lambda:InvokeFunction` → AccessDenied gói trong `States.TaskFailed`. A sẽ là `ResourceNotFoundException` chứ không phải "not authorized". C region sai cũng ra ResourceNotFound. D vượt payload ra `States.DataLimitExceeded`.

**Câu 7 — Đáp án A.** Express không lưu execution history trong Step Functions; phải bật CloudWatch Logs (level ALL) để debug. B nhầm với retention của Standard. C sai: Express hỗ trợ logging. D không liên quan.

**Câu 8 — Đáp án B.** `.sync` (Run a Job) làm Step Functions chờ ECS task hoàn tất rồi mới đi tiếp, và tự dọn nếu execution dừng. A request-response trả về ngay sau khi *khởi động* task, không đợi xong. C thiếu gửi token → treo, và runTask không phải pattern token điển hình. D Lambda polling tốn kém, phản thiết kế. (Lưu ý `.sync` cần quyền EventBridge cho role.)

**Câu 9 — Đáp án B.** `States.ALL` là matcher bao trùm, theo ASL phải nằm ở phần tử Retry/Catch **cuối cùng**, nếu không các quy tắc sau sẽ không bao giờ được đánh giá (lỗi validate). A/C sai vị trí gây lỗi định nghĩa. D sai: `States.ALL` hợp lệ trong cả Retry và Catch.

**Câu 10 — Đáp án B.** Giới hạn payload giữa state là 256KB cứng, không nâng được. Pattern chuẩn là "claim check": lưu object lên S3, truyền key/ARN nhỏ qua các state, Task nào cần thì đọc S3. A không có cách nâng quota này. C Express cũng giới hạn 256KB. D chia state machine không giải quyết bản chất payload lớn.

## Tóm tắt chương

- **Step Functions** điều phối workflow bằng state machine viết bằng **Amazon States Language (ASL)** JSON; các state chính: Task, Choice, Wait, Parallel, Map, Pass, Succeed, Fail.
- **Standard** (≤1 năm, exactly-once, phí theo state transition, history 90 ngày) vs **Express** (≤5 phút, async at-least-once, phí theo run+duration+memory, throughput cực cao) — chọn theo độ dài, throughput, nhu cầu audit.
- Ba **integration pattern**: Request-Response (mặc định), Run a Job `.sync` (đợi job thật xong), Wait for Callback `.waitForTaskToken` (đợi `SendTaskSuccess` mang token — human approval).
- **Error handling:** `Retry` (backoff = `IntervalSeconds * BackoffRate^(n-1)`) chạy trước, hết lượt mới tới `Catch`; `States.ALL` luôn đặt cuối; `Catch` nên đặt `ResultPath` để không nuốt input.
- **Input/Output:** thứ tự `InputPath → Parameters → ResultSelector → ResultPath → OutputPath`; `"key.$"` lấy giá trị động; `ResultPath: null` bỏ result giữ input.
- **Map** lặp trên collection: inline (≤40 concurrency, data trong state) vs **Distributed Map** (đọc S3, ≤10.000 concurrency) cho khối lượng cực lớn.
- **Parallel** chạy nhánh tĩnh song song, đợi tất cả, output là mảng theo thứ tự nhánh.
- **Optimized integration** (vd `dynamodb:putItem`, `sns:publish`) cho phép gọi service trực tiếp, tiết kiệm một Lambda trung gian.
- Payload tối đa **256KB** giữa các state → vượt thì dùng claim-check qua S3; state machine chạy dưới **IAM role riêng**, mọi integration phải có quyền tương ứng (`.sync` cần thêm quyền EventBridge).
- **X-Ray** (`tracingConfiguration`) cho service map; Express gần như bắt buộc bật **CloudWatch Logs** để debug vì không lưu history trên console.
- **Activities** là cách cũ (worker poll `GetActivityTask` + `SendTaskSuccess`); ngày nay ưu tiên `.waitForTaskToken` qua service integration.
