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
