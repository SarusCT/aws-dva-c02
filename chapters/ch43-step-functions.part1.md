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
