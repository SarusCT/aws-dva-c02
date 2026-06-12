# Chương 21: Amazon SQS

> **Trọng tâm DVA-C02:** SQS là dịch vụ messaging xuất hiện dày đặc trong đề thi, thường ở dạng câu hỏi tình huống. Bạn sẽ gặp: chọn Standard vs FIFO queue (ordering, deduplication); tính và chỉnh `visibility timeout` để tránh xử lý trùng hoặc "message biến mất"; phân biệt long polling vs short polling để giảm chi phí và độ trễ; cấu hình Dead Letter Queue với `maxReceiveCount`; dùng `DelaySeconds` (delay queue) vs message timer; bẫy 256KB message size và khi nào cần Extended Client Library (S3); scale Auto Scaling Group theo `ApproximateNumberOfMessagesVisible` bằng backlog-per-instance; và access policy cho phép SNS/S3 gửi message vào queue. SNS (fan-out) học ở Chương 22, Kinesis ở Chương 23.

## Mục tiêu chương

- Hiểu vì sao decouple producer và consumer bằng queue, và SQS giải quyết bài toán gì so với gọi đồng bộ trực tiếp.
- Phân biệt rạch ròi Standard queue (at-least-once, best-effort ordering, throughput không giới hạn) và FIFO queue (exactly-once processing, ordering theo message group).
- Nắm chính xác cơ chế `visibility timeout`, `ReceiveMessage`/`DeleteMessage`/`ChangeMessageVisibility` — gốc rễ của hầu hết lỗi production với SQS.
- Cấu hình long polling, Dead Letter Queue, delay queue, message timer, và hiểu các limits/quotas con số cụ thể cho đề thi.
- Xử lý message lớn hơn 256KB bằng Extended Client Library + S3, và viết producer/consumer bằng AWS SDK for JavaScript v3 + AWS CLI v2.
- Thiết kế scaling cho consumer (ASG theo queue depth) và viết access policy / mã hoá SSE đúng chuẩn.

## 21.1 Vì sao decouple — và SQS giải quyết bài toán gì

Hãy bắt đầu từ một kiến trúc đồng bộ điển hình: web tier nhận request đặt hàng rồi gọi trực tiếp service xử lý đơn (tính thuế, trừ kho, gửi email). Vấn đề:

- **Coupling thời gian:** nếu service xử lý chậm hoặc chết, web tier treo theo, người dùng nhận lỗi 500.
- **Spike traffic:** lượng đơn dồn vào lúc cao điểm vượt năng lực xử lý → request bị drop.
- **Khó scale độc lập:** web tier và worker phải scale cùng nhau dù tải khác nhau.

Đặt một hàng đợi (queue) ở giữa giải quyết cả ba. Producer (web tier) chỉ cần đẩy message vào queue rồi trả 200 ngay; consumer (worker) lấy message ra xử lý theo nhịp của nó. Queue đóng vai trò **buffer** hấp thụ spike: lúc cao điểm message dồn lại, worker xử lý dần khi rảnh. Producer và consumer không cần biết nhau, không cần online cùng lúc.

Amazon SQS là dịch vụ message queue **fully managed**: không có server để vận hành, không có broker để patch, tự động scale tới throughput gần như không giới hạn (với Standard queue). SQS lưu message **dư thừa trên nhiều AZ** trong một region, đảm bảo độ bền cao.

Đặc điểm cốt lõi cần khắc cốt ghi tâm:

- SQS là mô hình **pull** (poll-based): consumer chủ động gọi `ReceiveMessage` để lấy message. SQS **không** đẩy message tới consumer (khác SNS). Lambda "trigger từ SQS" thực chất là một event source mapping đứng sau poll giúp bạn — chi tiết ở Chương 30.
- Message **không bị xoá tự động** khi được nhận. Consumer phải gọi `DeleteMessage` sau khi xử lý xong. Đây là thiết kế cố ý để đảm bảo "ít nhất một lần xử lý" — nếu consumer chết giữa chừng, message sẽ quay lại queue.
- Message tồn tại tối đa **14 ngày** (`MessageRetentionPeriod`, mặc định 4 ngày, min 60 giây, max 1209600 giây = 14 ngày). Hết hạn mà chưa xoá thì SQS tự xoá message.

> 💡 **Exam Tip:** Nếu đề nói "decouple", "buffer requests", "absorb traffic spikes", "process asynchronously" → nghĩ ngay đến SQS. Nếu cần "fan-out tới nhiều consumer cùng lúc" → SNS (Chương 22). Nếu cần "real-time analytics / replay / nhiều consumer đọc cùng stream" → Kinesis (Chương 23).

## 21.2 Standard queue — at-least-once & best-effort ordering

Standard queue là loại mặc định và phổ biến nhất. Đặc tính:

- **Unlimited throughput:** số lượng API call/giây (do đó số message/giây) gần như không giới hạn. Đây là điểm bán hàng chính của Standard.
- **At-least-once delivery:** mỗi message được giao **ít nhất một lần**, nhưng đôi khi **nhiều hơn một lần**. Vì SQS lưu message dư thừa trên nhiều server, đôi lúc một bản copy chưa kịp xoá nên message có thể được giao lặp. Consumer của bạn **bắt buộc phải idempotent** — xử lý cùng message hai lần phải cho kết quả như một lần (ví dụ dùng một unique ID để chống ghi trùng vào DynamoDB).
- **Best-effort ordering:** SQS cố giữ thứ tự gửi nhưng **không đảm bảo**. Message có thể được giao lệch thứ tự. Nếu thứ tự là bắt buộc → dùng FIFO.

Producer gửi message bằng `SendMessage`. Ví dụ bằng AWS SDK for JavaScript v3:

```javascript
// Gửi 1 message vào Standard queue bằng AWS SDK v3
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

const client = new SQSClient({ region: "ap-southeast-1" });

const out = await client.send(new SendMessageCommand({
  QueueUrl: "https://sqs.ap-southeast-1.amazonaws.com/111122223333/orders",
  MessageBody: JSON.stringify({ orderId: "A-1001", amount: 250000 }),
  // Message attributes: metadata tách khỏi body, không tốn parse body để filter
  MessageAttributes: {
    eventType: { DataType: "String", StringValue: "ORDER_CREATED" },
  },
}));
console.log(out.MessageId, out.MD5OfMessageBody); // SQS trả MessageId + MD5 để verify
```

Để tăng throughput và giảm chi phí, gửi theo lô bằng `SendMessageBatch` — tối đa **10 message/batch** và tổng payload cả batch không quá 256KB:

```javascript
import { SendMessageBatchCommand } from "@aws-sdk/client-sqs";

await client.send(new SendMessageBatchCommand({
  QueueUrl: queueUrl,
  Entries: [
    { Id: "1", MessageBody: "msg-1" }, // Id chỉ unique trong batch, không phải MessageId
    { Id: "2", MessageBody: "msg-2" },
  ],
}));
```

Tương ứng AWS CLI v2:

```bash
# Lấy URL queue từ tên
aws sqs get-queue-url --queue-name orders

# Gửi 1 message
aws sqs send-message \
  --queue-url https://sqs.ap-southeast-1.amazonaws.com/111122223333/orders \
  --message-body '{"orderId":"A-1001"}'
```

> 💡 **Exam Tip:** "At-least-once" của Standard queue đồng nghĩa với "có thể nhận trùng" → đáp án đúng thường nhấn mạnh consumer phải **idempotent**. Đừng chọn FIFO chỉ vì sợ trùng nếu đề không yêu cầu ordering — FIFO có giới hạn throughput, đắt hơn về độ phức tạp.

## 21.3 Consuming, visibility timeout & vòng đời message

Đây là phần hay sai nhất trong production và được hỏi nhiều nhất trong đề. Hãy hiểu cơ chế từng bước.

Khi consumer gọi `ReceiveMessage`, SQS trả về một hoặc nhiều message (tối đa **10** với tham số `MaxNumberOfMessages`). Ngay lúc đó, mỗi message được giao bị **ẩn đi** khỏi các consumer khác trong một khoảng thời gian gọi là **visibility timeout** (mặc định **30 giây**, min 0, max **12 giờ**). Message **vẫn nằm trong queue** — chỉ là không hiển thị cho lần `ReceiveMessage` tiếp theo.

Trong khoảng visibility timeout đó, consumer phải:

1. Xử lý xong message.
2. Gọi `DeleteMessage` với `ReceiptHandle` (token tạm thời gắn với lần nhận này, **không** phải MessageId).

Nếu xoá kịp → message biến mất vĩnh viễn. Nếu **không** xoá kịp (consumer chết, hoặc xử lý lâu hơn visibility timeout) → hết timeout, message **hiện lại** và một consumer khác có thể nhận lại. Đây chính là cơ chế at-least-once: lỗi consumer không làm mất message.

```javascript
import { ReceiveMessageCommand, DeleteMessageCommand } from "@aws-sdk/client-sqs";

const res = await client.send(new ReceiveMessageCommand({
  QueueUrl: queueUrl,
  MaxNumberOfMessages: 10,   // lấy tối đa 10 message 1 lần để tiết kiệm API call
  WaitTimeSeconds: 20,       // long polling (mục 21.4)
  VisibilityTimeout: 60,     // override visibility timeout riêng cho lần nhận này
}));

for (const m of res.Messages ?? []) {
  try {
    await handle(JSON.parse(m.Body)); // xử lý nghiệp vụ
    // Chỉ xoá KHI xử lý thành công
    await client.send(new DeleteMessageCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: m.ReceiptHandle, // dùng ReceiptHandle, KHÔNG dùng MessageId
    }));
  } catch (e) {
    // Không xoá → message quay lại queue sau visibility timeout, sẽ retry
    console.error("xử lý lỗi, để message retry", e);
  }
}
```

**Bẫy kinh điển 1 — visibility timeout quá ngắn.** Nếu job xử lý mất 90 giây nhưng visibility timeout là 30 giây, thì ở giây thứ 30 message hiện lại và consumer thứ hai bắt đầu xử lý song song — **xử lý trùng**. Quy tắc: đặt visibility timeout **≥ thời gian xử lý tối đa** của một message. Với Lambda event source mapping, AWS khuyến nghị visibility timeout **≥ 6 lần** function timeout.

**Bẫy kinh điển 2 — job dài không xác định.** Nếu thời gian xử lý biến thiên, đừng đặt visibility timeout cứng quá lớn (chết consumer thì message kẹt lâu). Thay vào đó gọi `ChangeMessageVisibility` để **gia hạn** heartbeat trong khi xử lý:

```javascript
import { ChangeMessageVisibilityCommand } from "@aws-sdk/client-sqs";

// Gia hạn thêm 120s cho message đang xử lý (heartbeat)
await client.send(new ChangeMessageVisibilityCommand({
  QueueUrl: queueUrl,
  ReceiptHandle: m.ReceiptHandle,
  VisibilityTimeout: 120,
}));
```

Đặt `VisibilityTimeout: 0` qua `ChangeMessageVisibility` để **trả ngay message về queue** (ví dụ khi consumer nhận ra nó không xử lý được message này, nhường cho consumer khác).

> 💡 **Exam Tip:** "Message được xử lý nhiều lần dù chỉ gửi một lần" hoặc "duplicate processing" với Standard queue → nguyên nhân số một là **visibility timeout ngắn hơn thời gian xử lý**. Giải pháp: tăng visibility timeout hoặc dùng `ChangeMessageVisibility` để gia hạn. Nhớ: `DeleteMessage` cần `ReceiptHandle`, và `ReceiptHandle` thay đổi sau mỗi lần `ReceiveMessage`.

## 21.4 Long polling vs short polling

`ReceiveMessage` có hai chế độ, quyết định bởi `WaitTimeSeconds`:

- **Short polling** (`WaitTimeSeconds = 0`, mặc định nếu không cấu hình): SQS query một **tập con** server lưu message và trả về ngay lập tức — kể cả khi tập con đó tình cờ không có message (trả về rỗng dù queue thực ra còn message). Hệ quả: nhiều response rỗng, tốn API call (tốn tiền), độ trễ phát hiện message mới cao.
- **Long polling** (`WaitTimeSeconds > 0`, tối đa **20 giây**): SQS **chờ** cho tới khi có message xuất hiện (query toàn bộ server) hoặc hết `WaitTimeSeconds` mới trả về. Giảm số response rỗng → **giảm chi phí** và **giảm độ trễ**.

Long polling gần như luôn là lựa chọn đúng. Bật bằng một trong hai cách:

```bash
# Cách 1: đặt mặc định cho queue qua thuộc tính ReceiveMessageWaitTimeSeconds
aws sqs set-queue-attributes \
  --queue-url $QUEUE_URL \
  --attributes ReceiveMessageWaitTimeSeconds=20

# Cách 2: đặt WaitTimeSeconds từng lần gọi ReceiveMessage (ưu tiên cao hơn)
aws sqs receive-message --queue-url $QUEUE_URL --wait-time-seconds 20
```

So sánh nhanh:

| Tiêu chí | Short polling | Long polling |
|---|---|---|
| `WaitTimeSeconds` | 0 | 1–20 (max 20) |
| Khi queue rỗng | Trả về rỗng ngay | Chờ tới khi có message hoặc hết wait time |
| Số response rỗng | Nhiều | Ít |
| Chi phí API | Cao | Thấp |
| Độ trễ nhận message | Cao hơn | Thấp hơn |
| Phủ server | Tập con | Toàn bộ |

> 💡 **Exam Tip:** "Giảm số empty response / giảm chi phí SQS API / giảm latency khi đọc message" → bật **long polling** bằng cách set `WaitTimeSeconds` (max 20) hoặc `ReceiveMessageWaitTimeSeconds` ở mức queue. Đừng nhầm với visibility timeout.

## 21.5 Dead Letter Queue & redrive

Một message "độc" (poison message) — sai format, gây exception mỗi lần xử lý — sẽ retry vô hạn cho tới khi hết retention, vừa lãng phí vừa che lấp message tốt. **Dead Letter Queue (DLQ)** là cơ chế đưa message lỗi sang một queue riêng sau khi nó được nhận quá số lần cho phép.

DLQ chỉ là một queue SQS bình thường bạn tạo ra, rồi gán làm nơi nhận message lỗi của queue chính (source queue) thông qua **redrive policy**:

```bash
# Tạo DLQ và lấy ARN của nó
DLQ_URL=$(aws sqs create-queue --queue-name orders-dlq --query QueueUrl --output text)
DLQ_ARN=$(aws sqs get-queue-attributes --queue-url $DLQ_URL \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)

# Gán redrive policy cho source queue: sau 5 lần nhận chưa xoá -> chuyển sang DLQ
aws sqs set-queue-attributes --queue-url $SOURCE_URL --attributes \
  "RedrivePolicy={\"deadLetterTargetArn\":\"$DLQ_ARN\",\"maxReceiveCount\":\"5\"}"
```

Cơ chế: mỗi lần message được `ReceiveMessage` mà không bị xoá (nghĩa là xử lý thất bại, hết visibility timeout lại hiện), SQS tăng `ApproximateReceiveCount`. Khi `ApproximateReceiveCount` **vượt** `maxReceiveCount`, SQS chuyển message sang DLQ ở lần kế tiếp.

Những điểm cần nhớ:

- **DLQ phải cùng loại với source queue:** Standard source → Standard DLQ; FIFO source → FIFO DLQ.
- Message trong DLQ **giữ retention period gốc** tính từ lúc nó được gửi vào source queue lần đầu, **không** reset. Nên đặt retention của DLQ **dài hơn** source queue để có thời gian điều tra (ví dụ source 4 ngày, DLQ 14 ngày).
- DLQ rất hợp để gắn **CloudWatch alarm** trên `ApproximateNumberOfMessagesVisible > 0` để được cảnh báo khi có message lỗi.
- **Redrive to source / DLQ redrive:** sau khi sửa bug, bạn có thể dùng tính năng **redrive** (console hoặc `StartMessageMoveTask` API) để chuyển message từ DLQ **trở lại** source queue và xử lý lại — không cần viết script di chuyển thủ công.

> 💡 **Exam Tip:** "Poison message retry vô hạn / cô lập message lỗi để điều tra" → **DLQ + maxReceiveCount**. Đặt retention DLQ dài hơn source. "Sau khi fix code, xử lý lại các message đã vào DLQ" → tính năng **redrive** (StartMessageMoveTask), không phải viết tay.

## 21.6 Delay queue & message timer

Đôi khi bạn muốn message **không hiển thị ngay** cho consumer sau khi gửi, mà chờ một khoảng. Có hai cấp độ:

- **Delay queue (`DelaySeconds` ở mức queue):** mọi message gửi vào queue đều bị trì hoãn cùng một số giây trước khi consumer thấy được. Đặt qua thuộc tính queue. Giá trị **0–900 giây** (tối đa **15 phút**).
- **Message timer (`DelaySeconds` ở mức từng message):** đặt `DelaySeconds` ngay trong `SendMessage` cho **riêng** message đó, override delay mức queue. Cùng dải 0–900 giây.

```javascript
// Message timer: message này ẩn 60 giây trước khi consumer thấy được
await client.send(new SendMessageCommand({
  QueueUrl: queueUrl,
  MessageBody: "delayed-job",
  DelaySeconds: 60, // 0–900 giây
}));
```

Phân biệt với **visibility timeout** — một bẫy hay gài:

| | Delay queue / message timer | Visibility timeout |
|---|---|---|
| Áp dụng khi | Ngay sau khi **gửi** message | Sau khi message được **nhận** (`ReceiveMessage`) |
| Mục đích | Trì hoãn message **lần đầu** xuất hiện | Ẩn message **đang xử lý** để chống xử lý trùng |
| Giá trị max | 15 phút (900 giây) | 12 giờ |
| Cấu hình | `DelaySeconds` | `VisibilityTimeout` |

> 💡 **Exam Tip:** "Trì hoãn việc xử lý message vài phút sau khi đưa vào queue" → **delay queue / message timer** (`DelaySeconds`, max 15 phút). "Ẩn message khi đang được xử lý" → **visibility timeout** (max 12 giờ). FIFO queue **không** hỗ trợ per-message timer (chỉ delay mức queue).

## 21.7 Message size 256KB & Extended Client Library

Một message SQS tối đa **256 KB** (262144 bytes), tính cả **body lẫn message attributes**. Đây là hard limit hay được hỏi.

Khi cần gửi payload lớn hơn 256KB (ví dụ ảnh, file, log dump), có hai cách:

1. Tách logic: lưu payload lớn vào **S3**, chỉ gửi pointer (S3 key) qua SQS. Consumer đọc S3 từ pointer. Tự code thủ công.
2. Dùng **Amazon SQS Extended Client Library** (có cho Java và một số ngôn ngữ): thư viện tự động lưu payload lớn vào S3 và gửi metadata reference qua SQS, consumer tự lấy lại từ S3 một cách trong suốt. Hỗ trợ payload tới **2 GB**.

Cơ chế Extended Client Library bên dưới: khi gửi, nếu payload vượt ngưỡng, nó PUT object lên S3 bucket bạn chỉ định và gửi một message nhỏ chứa con trỏ tới object đó; khi nhận, nó GET object từ S3 và trả về cho bạn nội dung gốc; khi `DeleteMessage`, nó cũng xoá object S3 tương ứng.

> 💡 **Exam Tip:** "Gửi message > 256KB qua SQS" → **SQS Extended Client Library + S3** (lưu payload S3, gửi reference). Con số **256KB** cho max message size và **2GB** với Extended Client là hai số hay xuất hiện. Đừng chọn "chia nhỏ message" — đáp án chuẩn là S3 offload.

## 21.8 FIFO queue — ordering, deduplication, message group

FIFO (First-In-First-Out) queue giải quyết hai thứ Standard không làm được: **thứ tự chính xác** và **không trùng lặp** (exactly-once processing). Tên FIFO queue **bắt buộc** kết thúc bằng hậu tố `.fifo`.

Ba khái niệm cốt lõi:

- **Message Group ID (`MessageGroupId`):** bắt buộc với FIFO. Message **cùng** một group ID được giao **đúng thứ tự** gửi và xử lý tuần tự (một group chỉ giao message tiếp theo khi message trước đã được xoá). Message **khác** group ID được xử lý **song song** — đây là cách FIFO đạt throughput cao mà vẫn giữ order trong từng nhóm. Ví dụ dùng `userId` làm group ID: thao tác của mỗi user giữ đúng thứ tự, các user khác nhau xử lý song song.
- **Deduplication:** FIFO chống trùng trong cửa sổ **5 phút** (deduplication interval). Hai cách:
  - **`MessageDeduplicationId`** rõ ràng: bạn tự cung cấp ID; trong 5 phút, message trùng dedup ID sẽ bị bỏ qua (không gửi vào lần hai).
  - **Content-based deduplication:** bật thuộc tính `ContentBasedDeduplication=true`, SQS tự tính SHA-256 của body làm dedup ID.
- **`SequenceNumber`:** số tăng dần SQS gán cho mỗi message FIFO.

```javascript
// Gửi vào FIFO queue (tên kết thúc .fifo)
await client.send(new SendMessageCommand({
  QueueUrl: "https://sqs.ap-southeast-1.amazonaws.com/111122223333/orders.fifo",
  MessageBody: JSON.stringify({ orderId: "A-1001" }),
  MessageGroupId: "user-42",           // bắt buộc với FIFO
  MessageDeduplicationId: "A-1001-v1", // hoặc bật ContentBasedDeduplication
}));
```

**Throughput FIFO:** mặc định **300 message/giây** (hoặc 3000 message/giây nếu batch 10 message/call). Bật **high throughput mode** (per-message-group-id deduplication scope + perMessageGroupId throughput limit) nâng lên tới **9000 message/giây** (hoặc cao hơn tuỳ region) cho mỗi queue. Standard queue không có giới hạn này.

So sánh Standard vs FIFO:

| Tiêu chí | Standard queue | FIFO queue |
|---|---|---|
| Tên queue | bất kỳ | bắt buộc hậu tố `.fifo` |
| Ordering | Best-effort (không đảm bảo) | Đảm bảo theo `MessageGroupId` |
| Delivery | At-least-once (có thể trùng) | Exactly-once (dedup 5 phút) |
| Throughput | Gần như không giới hạn | 300 msg/s (3000 với batch); cao throughput mode tới 9000+ |
| Dedup | Không có | MessageDeduplicationId / content-based |
| Per-message delay | Có (message timer) | Không (chỉ delay mức queue) |
| Giá | Rẻ hơn | Đắt hơn một chút |

> 💡 **Exam Tip:** "Phải xử lý đúng thứ tự" + "không được xử lý trùng" → **FIFO queue**. Cần ordering trong một phạm vi (per-user, per-account) mà vẫn song song giữa các phạm vi → dùng **MessageGroupId**. Dedup window là **5 phút**. Nhớ throughput FIFO mặc định **300/s** (3000 với batch) — nếu đề cần "millions of messages/second" mà không cần order → **Standard**, không phải FIFO.

## 21.9 Scaling consumer, ASG theo queue depth

Sức mạnh của decouple là scale consumer độc lập theo **độ sâu hàng đợi** (queue depth). SQS phát ra các CloudWatch metric quan trọng (namespace `AWS/SQS`):

- `ApproximateNumberOfMessagesVisible` — số message đang chờ xử lý (queue depth). Đây là metric chính để scale.
- `ApproximateNumberOfMessagesNotVisible` — message đang được xử lý (in-flight, trong visibility timeout).
- `ApproximateAgeOfOldestMessage` — tuổi message cũ nhất; tăng cao nghĩa là consumer không theo kịp.
- `NumberOfMessagesSent`, `NumberOfMessagesReceived`, `NumberOfMessagesDeleted`.

Pattern chuẩn để scale Auto Scaling Group consumer là **backlog per instance**, vì scale trực tiếp theo số message tuyệt đối sẽ sai khi đội instance thay đổi. Công thức:

```
Backlog per instance = ApproximateNumberOfMessagesVisible / số instance đang chạy
```

Bạn đặt một mục tiêu "mỗi instance ôm tối đa N message", publish metric `BacklogPerInstance` lên CloudWatch và dùng **target tracking scaling policy** trên nó (chi tiết ASG ở Chương 7). Ví dụ: nếu mỗi instance xử lý được 100 message/phút và bạn muốn dọn backlog trong 5 phút, target backlog per instance = 500.

> 💡 **Exam Tip:** Scale consumer fleet theo SQS → dùng metric **`ApproximateNumberOfMessagesVisible`**, và pattern đúng là **backlog per instance** (chia cho số instance) làm custom metric cho target tracking. `ApproximateAgeOfOldestMessage` tăng = consumer tụt lại, dấu hiệu cần scale out. **SQS in-flight limit:** Standard queue tối đa **120000** message in-flight; FIFO tối đa **20000** — vượt sẽ lỗi `OverLimit` khi `ReceiveMessage`.

## 21.10 Access policy, encryption & temporary queues

**Access policy (resource-based policy).** Queue có thể gắn policy JSON cho phép principal khác gửi/nhận message. Trường hợp kinh điển trong đề: cho phép **SNS topic** hoặc **S3 event** gửi message vào queue (fan-out pattern). Dùng condition `aws:SourceArn` để chỉ chấp nhận từ đúng nguồn:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "sns.amazonaws.com" },
    "Action": "sqs:SendMessage",
    "Resource": "arn:aws:sqs:ap-southeast-1:111122223333:orders",
    "Condition": {
      "ArnEquals": { "aws:SourceArn": "arn:aws:sns:ap-southeast-1:111122223333:order-events" }
    }
  }]
}
```

**Encryption.** Mặc định SQS mã hoá in transit qua HTTPS. Để mã hoá at rest dùng **SSE-SQS** (key do SQS quản lý, miễn phí, bật mặc định cho queue mới) hoặc **SSE-KMS** (customer-managed KMS key, kiểm soát key policy và audit qua CloudTrail). Lưu ý SSE-KMS phát sinh KMS API call (`GenerateDataKey`/`Decrypt`) nên có thể đụng KMS throttling và chi phí — dùng KMS data key reuse period để giảm gọi (chi tiết KMS ở Chương 46).

```bash
# Bật SSE-KMS cho queue
aws sqs set-queue-attributes --queue-url $QUEUE_URL --attributes \
  'KmsMasterKeyId=alias/my-sqs-key,KmsDataKeyReusePeriodSeconds=300'
```

**Temporary queues.** Cho pattern request-response (mỗi request cần một queue trả lời tạm thời, ví dụ RPC qua SQS), AWS cung cấp **Temporary Queue Client** dùng kỹ thuật **virtual queue** — nhiều hàng đợi ảo dùng chung một queue vật lý host queue, tránh tạo/xoá hàng loạt queue thật (vốn chậm và có quota). Phù hợp khi cần nhiều reply queue ngắn hạn với chi phí thấp.

> 💡 **Exam Tip:** Để SNS/S3/EventBridge gửi được vào SQS, bạn cấu hình **resource-based policy trên queue** (không phải IAM role của dịch vụ nguồn), kèm condition `aws:SourceArn`. Mã hoá at rest mặc định/miễn phí → **SSE-SQS**; cần kiểm soát key & audit → **SSE-KMS**. Nhớ giới hạn: **256KB** message, retention max **14 ngày**, delay max **15 phút**, visibility timeout max **12 giờ**, long polling max **20 giây**.

---

## Hands-on Lab: Standard queue, DLQ, long polling, FIFO và ASG scaling theo queue depth

**Mục tiêu lab:** Đi hết vòng đời SQS từ góc developer: tạo standard queue + Dead Letter Queue (DLQ) với redrive policy, gửi/nhận/xoá message bằng CLI, quan sát visibility timeout và `ChangeMessageVisibility`, bật long polling, đẩy message "độc" vào DLQ rồi redrive ngược về, tạo FIFO queue với deduplication và message group ID, và cuối cùng tạo một CloudWatch alarm trên metric backlog-per-instance để ASG scale theo độ sâu hàng đợi (chỉ phần SQS + alarm; chi tiết ASG ở Chương 7).

**Chuẩn bị:**
- AWS CLI v2 đã cấu hình (Chương 3), IAM user/role có quyền `sqs:*`, `cloudwatch:PutMetricAlarm`.
- Region dùng trong lab: `us-east-1`. Lấy Account ID để dựng ARN:

```bash
export AWS_REGION=us-east-1
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "Account: $ACCOUNT_ID"
```

### Bước 1: Tạo Dead Letter Queue trước, rồi standard queue trỏ vào nó

DLQ phải tồn tại trước vì standard queue cần ARN của DLQ trong `RedrivePolicy`. Tạo DLQ trước:

```bash
# DLQ — không có gì đặc biệt, chỉ là một queue thường được dùng làm nơi chứa message lỗi
DLQ_URL=$(aws sqs create-queue \
  --queue-name orders-dlq \
  --query QueueUrl --output text)
echo "DLQ_URL=$DLQ_URL"

# Lấy ARN của DLQ (cần cho RedrivePolicy)
DLQ_ARN=$(aws sqs get-queue-attributes \
  --queue-url "$DLQ_URL" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' --output text)
echo "DLQ_ARN=$DLQ_ARN"
```

Output mong đợi: `DLQ_ARN=arn:aws:sqs:us-east-1:<account>:orders-dlq`.

Bây giờ tạo queue chính. Lưu ý `RedrivePolicy` là JSON-trong-JSON nên phải escape; `maxReceiveCount=3` nghĩa là sau 3 lần nhận (mà không xoá) message sẽ bị chuyển sang DLQ. Đặt luôn `VisibilityTimeout=30` và `ReceiveMessageWaitTimeSeconds=10` (bật long polling 10 giây):

```bash
Q_URL=$(aws sqs create-queue \
  --queue-name orders \
  --attributes "{
    \"VisibilityTimeout\":\"30\",
    \"ReceiveMessageWaitTimeSeconds\":\"10\",
    \"MessageRetentionPeriod\":\"345600\",
    \"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"3\\\"}\"
  }" \
  --query QueueUrl --output text)
echo "Q_URL=$Q_URL"
```

`MessageRetentionPeriod=345600` là 4 ngày (mặc định); tối đa là 1.209.600 giây (14 ngày). Kiểm tra lại attribute đã set đúng:

```bash
aws sqs get-queue-attributes --queue-url "$Q_URL" \
  --attribute-names All \
  --query 'Attributes.{Vis:VisibilityTimeout,Wait:ReceiveMessageWaitTimeSeconds,Redrive:RedrivePolicy}'
```

### Bước 2: Gửi message và quan sát long polling

Gửi vài message. Với standard queue, `MessageBody` tối đa 256 KB; có thể đính kèm `MessageAttributes` (metadata không nằm trong body):

```bash
aws sqs send-message --queue-url "$Q_URL" \
  --message-body '{"orderId":"1001","amount":250}' \
  --message-attributes '{"Type":{"DataType":"String","StringValue":"NEW"}}'

# Gửi hàng loạt 3 message trong 1 call (giảm số request, rẻ hơn)
aws sqs send-message-batch --queue-url "$Q_URL" --entries '[
  {"Id":"m1","MessageBody":"{\"orderId\":\"1002\"}"},
  {"Id":"m2","MessageBody":"{\"orderId\":\"1003\"}"},
  {"Id":"m3","MessageBody":"{\"orderId\":\"1004\"}"}
]'
```

`send-message-batch` gửi tối đa 10 message/call, tổng payload ≤ 256 KB. Nhận message với long polling (`--wait-time-seconds 10`): nếu queue trống call sẽ chờ tối đa 10 giây thay vì trả về rỗng ngay — giảm số empty receive và tiết kiệm tiền:

```bash
aws sqs receive-message --queue-url "$Q_URL" \
  --max-number-of-messages 5 \
  --wait-time-seconds 10 \
  --attribute-names ApproximateReceiveCount \
  --message-attribute-names All
```

Output trả về `Messages[]`, mỗi message có `ReceiptHandle` (token để xoá/đổi visibility, KHÁC với `MessageId`) và attribute `ApproximateReceiveCount` cho biết message đã được nhận bao nhiêu lần. Trong khoảng 30 giây visibility timeout, message này "ẩn" với consumer khác.

> Lưu ý: `MessageId` cố định suốt vòng đời message; `ReceiptHandle` thay đổi mỗi lần nhận. Luôn dùng `ReceiptHandle` mới nhất khi xoá hoặc gọi `ChangeMessageVisibility`.

### Bước 3: Visibility timeout và ChangeMessageVisibility

Lưu một `ReceiptHandle` rồi xử lý mô phỏng lâu hơn dự kiến — kéo dài visibility để tránh message bị nhả lại cho consumer khác giữa chừng:

```bash
RH=$(aws sqs receive-message --queue-url "$Q_URL" --wait-time-seconds 5 \
  --query 'Messages[0].ReceiptHandle' --output text)

# Heartbeat: gia hạn thêm 60 giây vì xử lý chưa xong
aws sqs change-message-visibility --queue-url "$Q_URL" \
  --receipt-handle "$RH" --visibility-timeout 60

# Xử lý xong → xoá message để nó không quay lại queue
aws sqs delete-message --queue-url "$Q_URL" --receipt-handle "$RH"
```

Nếu KHÔNG xoá và visibility timeout hết, message tái xuất hiện và `ApproximateReceiveCount` tăng. Đây chính là cơ chế dẫn tới DLQ ở bước sau.

### Bước 4: Đẩy message "độc" vào DLQ rồi redrive về

Gửi 1 "poison message" và cố tình nhận nó 3 lần mà không xoá (mỗi lần phải đợi visibility hết để nhận lại). Để nhanh, hạ visibility xuống 0 cho lần test này bằng `ChangeMessageVisibility` ngay sau khi nhận:

```bash
aws sqs send-message --queue-url "$Q_URL" \
  --message-body '{"orderId":"BAD","corrupt":true}'

for i in 1 2 3; do
  RH=$(aws sqs receive-message --queue-url "$Q_URL" --wait-time-seconds 5 \
    --query 'Messages[0].ReceiptHandle' --output text)
  echo "Nhận lần $i, không xoá..."
  # Nhả ngay lập tức để nhận lại nhanh (set visibility = 0)
  aws sqs change-message-visibility --queue-url "$Q_URL" \
    --receipt-handle "$RH" --visibility-timeout 0
done
```

Sau lần nhận thứ 3 (vượt `maxReceiveCount=3`), SQS tự chuyển message sang DLQ. Kiểm tra DLQ có message:

```bash
aws sqs get-queue-attributes --queue-url "$DLQ_URL" \
  --attribute-names ApproximateNumberOfMessages
```

Thấy `ApproximateNumberOfMessages: "1"`. Sau khi sửa bug consumer, redrive (di chuyển message từ DLQ về queue gốc) bằng `start-message-move-task`:

```bash
TASK=$(aws sqs start-message-move-task \
  --source-arn "$DLQ_ARN" \
  --query TaskHandle --output text)

aws sqs list-message-move-tasks --source-arn "$DLQ_ARN" \
  --query 'Results[].{Status:Status,Moved:ApproximateNumberOfMessagesMoved}'
```

Output cho thấy task `RUNNING`/`COMPLETED` và số message đã di chuyển. Đây là "redrive to source" mà DVA-C02 hay hỏi — trước đây phải tự viết script, giờ là API/console native.

### Bước 5: Tạo FIFO queue với deduplication và message group ID

FIFO queue bắt buộc tên kết thúc bằng `.fifo`. Bật `ContentBasedDeduplication` để SQS tự hash body làm dedup ID (5 phút dedup window):

```bash
FIFO_URL=$(aws sqs create-queue \
  --queue-name orders.fifo \
  --attributes '{
    "FifoQueue":"true",
    "ContentBasedDeduplication":"true",
    "VisibilityTimeout":"30"
  }' \
  --query QueueUrl --output text)

# Gửi 2 message khác group → xử lý song song; cùng group → giữ thứ tự
aws sqs send-message --queue-url "$FIFO_URL" \
  --message-body '{"orderId":"A1"}' --message-group-id customer-A
aws sqs send-message --queue-url "$FIFO_URL" \
  --message-body '{"orderId":"B1"}' --message-group-id customer-B

# Gửi đúp body giống hệt trong 5 phút → bị dedup, chỉ 1 message vào queue
aws sqs send-message --queue-url "$FIFO_URL" \
  --message-body '{"orderId":"A1"}' --message-group-id customer-A
```

Nhận và xác nhận thứ tự + dedup:

```bash
aws sqs receive-message --queue-url "$FIFO_URL" \
  --max-number-of-messages 10 --wait-time-seconds 5 \
  --attribute-names MessageGroupId MessageDeduplicationId \
  --query 'Messages[].Body'
```

Bạn chỉ thấy `A1` một lần (lần gửi thứ 3 bị dedup) và `B1`. Message cùng `message-group-id` luôn được trả về theo đúng thứ tự gửi; khác group có thể xen kẽ. Nếu cần `ContentBasedDeduplication=false`, bạn phải tự truyền `--message-deduplication-id`.

### Bước 6: CloudWatch alarm cho ASG scale theo queue depth

Cách scale ASG đúng theo SQS không phải dựa thẳng vào `ApproximateNumberOfMessagesVisible`, mà dựa vào **backlog per instance** = số message chờ / số instance đang chạy, so với "acceptable backlog" (số message 1 instance xử lý kịp trong latency mục tiêu). Trong production bạn dùng một custom metric math; ở lab này ta tạo alarm đơn giản trên metric gốc để minh hoạ trigger:

```bash
aws cloudwatch put-metric-alarm \
  --alarm-name orders-backlog-high \
  --namespace AWS/SQS \
  --metric-name ApproximateNumberOfMessagesVisible \
  --dimensions Name=QueueName,Value=orders \
  --statistic Average --period 60 \
  --evaluation-periods 1 --threshold 100 \
  --comparison-operator GreaterThanThreshold \
  --treat-missing-data notBreaching
```

Trong thực tế, gắn `--alarm-actions <ASG scaling policy ARN>` để alarm này kích hoạt target-tracking/step scaling. Đọc kỹ phần backlog-per-instance ở Chương 7 — đề thi hay gài đáp án "scale theo CPU" (SAI vì consumer poll-based thường CPU thấp dù backlog cao).

### Dọn dẹp tài nguyên

```bash
aws cloudwatch delete-alarms --alarm-names orders-backlog-high
aws sqs delete-queue --queue-url "$Q_URL"
aws sqs delete-queue --queue-url "$DLQ_URL"
aws sqs delete-queue --queue-url "$FIFO_URL"
```

> Lưu ý: sau khi `delete-queue`, tên queue đó không tạo lại được trong ~60 giây. Nếu có message move task đang `RUNNING`, dừng nó bằng `aws sqs cancel-message-move-task --task-handle "$TASK"` trước khi xoá DLQ.

## 💡 Exam Tips chương 21

- **Visibility timeout mặc định 30 giây, max 12 giờ.** Nếu consumer xử lý lâu hơn timeout → message tái xuất hiện và bị xử lý 2 lần (duplicate). Khắc phục: tăng visibility timeout HOẶC gọi `ChangeMessageVisibility` định kỳ (heartbeat). Đáp án "tăng retention period" để fix duplicate là bẫy SAI.
- **Long polling (`ReceiveMessageWaitTimeSeconds` 1–20 giây) gần như luôn là đáp án đúng** khi câu hỏi nói "giảm số empty receive / giảm chi phí API / giảm latency rỗng". Short polling (giá trị 0) lấy mẫu một tập subset server nên có thể trả rỗng dù queue có message.
- **DLQ + `maxReceiveCount`:** message vào DLQ sau khi bị nhận quá `maxReceiveCount` lần mà không bị xoá — KHÔNG phải khi consumer "báo lỗi". DLQ của standard queue phải là standard; DLQ của FIFO phải là FIFO.
- **Message size tối đa 256 KB.** Payload lớn hơn → dùng SQS Extended Client Library: body thật lưu ở S3, message chỉ chứa con trỏ S3. Đây là đáp án kinh điển cho "gửi payload 1 MB qua SQS".
- **FIFO: ordering theo `MessageGroupId`**, dedup theo `MessageDeduplicationId` trong cửa sổ 5 phút. `ContentBasedDeduplication` tự hash body. Throughput FIFO mặc định 300 msg/s (3.000 với batch); high-throughput mode lên tới 70.000+ msg/s.
- **Standard vs FIFO:** standard = at-least-once + best-effort ordering + throughput gần như không giới hạn. FIFO = exactly-once processing + ordering chặt nhưng throughput giới hạn. Chọn FIFO chỉ khi thật sự cần thứ tự / chống trùng.
- **Delay queue vs message timer:** delay queue áp cho MỌI message (set `DelaySeconds` ở queue level), message timer áp cho TỪNG message khi gửi. Cả hai max 900 giây (15 phút).
- **Scale ASG theo queue:** dùng backlog-per-instance, KHÔNG dùng CPU. CPU của consumer poll-based thường thấp; đáp án "scale theo CPUUtilization" là bẫy.
- **SQS không "push" tới consumer** — consumer phải poll. Nếu cần push/fan-out tới nhiều subscriber → SNS hoặc EventBridge (Chương 22). SQS có thể là target của SNS (fan-out SNS→SQS).
- **Encryption SSE-SQS (mặc định, AWS managed key) hay SSE-KMS.** Với KMS, IAM của producer/consumer cần thêm quyền `kms:GenerateDataKey` và `kms:Decrypt`; `KmsDataKeyReusePeriodSeconds` (1 phút–24 giờ) giảm số lần gọi KMS.
- **Retention period 1 phút–14 ngày (mặc định 4 ngày).** Message quá hạn bị xoá tự động. Tăng retention KHÔNG fix lỗi xử lý — chỉ cho consumer thêm thời gian lấy message.
- **Lambda + SQS dùng event source mapping** (Lambda poll thay bạn); với standard queue có partial batch response (`ReportBatchItemFailures`). Chi tiết ở Chương 30 — đừng nhầm là "SQS gọi Lambda trực tiếp".

## Quiz chương 21 (10 câu)

**Câu 1.** Một consumer xử lý mỗi message mất ~45 giây, nhưng nhiều message đang bị xử lý hai lần. Visibility timeout đang để mặc định. Cách khắc phục TỐT NHẤT?
- A. Tăng `MessageRetentionPeriod` lên 14 ngày
- B. Tăng visibility timeout lên giá trị lớn hơn thời gian xử lý (ví dụ 90 giây) hoặc gọi `ChangeMessageVisibility` heartbeat
- C. Chuyển sang FIFO queue
- D. Bật long polling

**Câu 2.** Developer muốn giảm chi phí ReceiveMessage và tránh response rỗng khi queue thường trống. Nên làm gì?
- A. Đặt `ReceiveMessageWaitTimeSeconds` = 20
- B. Đặt `ReceiveMessageWaitTimeSeconds` = 0
- C. Tăng `MaxNumberOfMessages` lên 100
- D. Giảm visibility timeout về 0

**Câu 3.** Hệ thống cần gửi message JSON kích thước 800 KB qua SQS. Giải pháp đúng?
- A. Nén message xuống dưới 256 KB là bắt buộc, không có cách khác
- B. Dùng SQS Extended Client Library: lưu payload ở S3, message chứa con trỏ
- C. Chia thành 4 message rồi tự ghép lại ở consumer
- D. Dùng FIFO queue vì FIFO cho phép message tới 2 MB

**Câu 4.** Một message lỗi cứ được nhận lặp đi lặp lại và làm tắc consumer. Cấu hình nào tự động cô lập nó?
- A. Delay queue với `DelaySeconds` = 900
- B. Tăng visibility timeout lên 12 giờ
- C. Cấu hình redrive policy trỏ tới một DLQ với `maxReceiveCount` hợp lý
- D. Bật `ContentBasedDeduplication`

**Câu 5.** Ứng dụng thanh toán yêu cầu các giao dịch của CÙNG một tài khoản được xử lý đúng thứ tự, nhưng tài khoản khác nhau có thể xử lý song song. Lựa chọn nào phù hợp?
- A. Standard queue, dùng timestamp để sắp xếp ở consumer
- B. FIFO queue với `MessageGroupId` = accountId
- C. FIFO queue với tất cả message cùng một `MessageGroupId`
- D. Standard queue với `ContentBasedDeduplication`

**Câu 6.** ASG chạy consumer SQS. Backlog tăng vọt vào giờ cao điểm nhưng ASG không scale out vì CPU thấp. Sửa thế nào?
- A. Đổi instance type lớn hơn
- B. Tạo target-tracking/step scaling dựa trên metric backlog-per-instance từ SQS thay vì CPU
- C. Đặt min capacity = max capacity
- D. Bật detailed monitoring cho EC2

**Câu 7.** Developer gọi `DeleteMessage` nhưng nhận lỗi `ReceiptHandleIsInvalid`. Nguyên nhân thường gặp nhất?
- A. Queue đã bị mã hoá KMS
- B. Dùng `MessageId` thay vì `ReceiptHandle`, hoặc dùng `ReceiptHandle` cũ sau khi message đã tái xuất hiện
- C. Visibility timeout quá lớn
- D. Long polling chưa được bật

**Câu 8.** Queue SQS được mã hoá SSE-KMS. Consumer chạy trên EC2 báo `AccessDenied` khi `ReceiveMessage`. IAM role của consumer cần thêm quyền nào?
- A. `s3:GetObject`
- B. `kms:Decrypt` (và producer cần `kms:GenerateDataKey`)
- C. `sqs:CreateQueue`
- D. `kms:CreateGrant` cho consumer

**Câu 9.** Một message cần được trì hoãn 10 phút trước khi consumer có thể nhận, chỉ riêng message đó. Cách đúng?
- A. Đặt `DelaySeconds` = 600 ở cấp queue
- B. Đặt `DelaySeconds` = 600 trong call `SendMessage` của riêng message đó (message timer)
- C. Tăng visibility timeout lên 600 giây
- D. Dùng `ChangeMessageVisibility` = 600 ngay sau khi gửi

**Câu 10.** Nhóm cần fan-out: một sự kiện "order placed" phải được xử lý bởi 3 dịch vụ độc lập (kho, email, analytics), mỗi dịch vụ có queue riêng và tốc độ xử lý riêng. Kiến trúc tốt nhất?
- A. Một SQS queue duy nhất, cả 3 dịch vụ cùng poll
- B. SNS topic, mỗi dịch vụ subscribe bằng một SQS queue riêng (fan-out SNS→SQS)
- C. FIFO queue với 3 message group ID
- D. Kinesis Data Stream với 3 shard

### Đáp án & giải thích

**Câu 1 — Đáp án B.** Duplicate xảy ra vì xử lý (45s) dài hơn visibility timeout mặc định (30s): message tái xuất hiện và bị consumer khác lấy. Tăng visibility timeout hoặc heartbeat bằng `ChangeMessageVisibility` giải quyết gốc rễ. A (retention) chỉ ảnh hưởng thời gian message tồn tại, không liên quan duplicate. C (FIFO) cho exactly-once nhưng là thay đổi lớn không cần thiết và giảm throughput. D (long polling) chỉ ảnh hưởng cách poll, không sửa duplicate.

**Câu 2 — Đáp án A.** Long polling (wait time 1–20s, ở đây 20) khiến SQS chờ tới khi có message hoặc hết thời gian, giảm empty receive và chi phí. B (=0) là short polling — đúng cái gây ra empty response. C tăng số message/call nhưng vẫn short polling nếu wait time 0. D set visibility 0 gây xử lý trùng, không liên quan chi phí poll.

**Câu 3 — Đáp án B.** Giới hạn cứng 256 KB; payload lớn dùng Extended Client Library lưu body ở S3, message chỉ giữ con trỏ — consumer tự fetch từ S3. A sai vì có giải pháp. C tự ghép thủ công mất ordering/độ phức tạp và không phải pattern AWS khuyến nghị. D sai: FIFO cũng giới hạn 256 KB, không có chuyện 2 MB.

**Câu 4 — Đáp án C.** Redrive policy + DLQ với `maxReceiveCount` tự chuyển message lỗi sang DLQ sau số lần nhận vượt ngưỡng, gỡ tắc consumer và giữ message để điều tra. A (delay) chỉ trì hoãn, message vẫn quay lại. B (visibility 12h) chỉ giấu lâu hơn rồi vẫn lặp. D (dedup) là tính năng FIFO chống trùng khi gửi, không liên quan message lỗi.

**Câu 5 — Đáp án B.** FIFO đảm bảo thứ tự trong cùng `MessageGroupId`; đặt group = accountId giữ thứ tự per-account mà vẫn cho phép các account khác xử lý song song. A (standard + sort) không đảm bảo ordering thật. C (cùng 1 group) ép toàn bộ tuần tự, giết throughput. D standard không có ordering.

**Câu 6 — Đáp án B.** Consumer poll-based thường CPU thấp dù backlog lớn, nên scale theo CPU thất bại. Đúng là scale theo backlog-per-instance (số message chờ / số instance) so với acceptable backlog. A/D không giải quyết scale ngang. C tắt khả năng co giãn, lãng phí khi rảnh.

**Câu 7 — Đáp án B.** `DeleteMessage`/`ChangeMessageVisibility` yêu cầu `ReceiptHandle` của lần nhận gần nhất, KHÔNG phải `MessageId`. Receipt handle cũ trở nên vô hiệu sau khi message tái xuất hiện (nhận lại). A/C/D không gây lỗi `ReceiptHandleIsInvalid`.

**Câu 8 — Đáp án B.** Với SSE-KMS, consumer cần `kms:Decrypt` để giải mã data key khi nhận; producer cần `kms:GenerateDataKey`. A là quyền S3 không liên quan. C `CreateQueue` không phải quyền nhận message. D `CreateGrant` không cần thiết cho luồng đọc cơ bản và cấp dư thừa.

**Câu 9 — Đáp án B.** Trì hoãn riêng một message dùng message timer: truyền `DelaySeconds` trong `SendMessage` (max 900s). A áp delay cho mọi message (delay queue). C/D dùng visibility timeout — chỉ áp dụng SAU khi message được nhận, không trì hoãn lần xuất hiện đầu tiên.

**Câu 10 — Đáp án B.** Fan-out chuẩn: SNS topic phát một lần, mỗi dịch vụ có SQS queue riêng subscribe topic — mỗi queue buffer độc lập, tốc độ xử lý riêng, retry/DLQ riêng. A: nhiều consumer cùng poll một queue → mỗi message chỉ 1 consumer lấy được, KHÔNG fan-out. C: FIFO group không nhân bản message tới nhiều consumer. D: Kinesis dùng được nhưng nặng và đắt hơn cho use case event fan-out đơn giản; chi tiết so sánh ở Chương 22–23.

## Tóm tắt chương

- **SQS là hàng đợi pull-based** để decouple producer–consumer: producer gửi không cần biết consumer, consumer poll khi sẵn sàng, giúp chịu tải đột biến và chịu lỗi tốt hơn.
- **Standard queue:** throughput gần như không giới hạn, at-least-once delivery (có thể trùng), best-effort ordering. **FIFO queue:** exactly-once, ordering chặt theo `MessageGroupId`, throughput giới hạn (300/3.000 msg/s, high-throughput mode cao hơn).
- **Visibility timeout** (mặc định 30s, max 12h) ẩn message sau khi nhận; xử lý lâu hơn timeout gây xử lý trùng — fix bằng tăng timeout hoặc `ChangeMessageVisibility` heartbeat. Luôn xoá message bằng `ReceiptHandle` mới nhất.
- **Long polling** (`ReceiveMessageWaitTimeSeconds` 1–20s) giảm empty receive và chi phí so với short polling (=0); gần như luôn là đáp án đúng khi đề nói tối ưu poll.
- **DLQ + redrive policy** (`maxReceiveCount`) tự cô lập message lỗi sau số lần nhận vượt ngưỡng; redrive ngược về source bằng `start-message-move-task`. DLQ phải cùng loại (standard/FIFO) với queue gốc.
- **Message size tối đa 256 KB**; payload lớn hơn dùng SQS Extended Client Library (body ở S3, message chứa con trỏ).
- **Delay queue** (cấp queue) vs **message timer** (cấp từng message): cả hai max 900 giây.
- **Retention period** 1 phút–14 ngày (mặc định 4 ngày); tăng retention KHÔNG sửa lỗi xử lý.
- **FIFO dedup** theo `MessageDeduplicationId` trong cửa sổ 5 phút; `ContentBasedDeduplication` tự hash body. Ordering chỉ trong cùng message group.
- **Scale ASG theo backlog-per-instance**, không theo CPU (consumer poll-based CPU thường thấp).
- **Encryption SSE-SQS (mặc định) hoặc SSE-KMS**; với KMS, producer cần `kms:GenerateDataKey`, consumer cần `kms:Decrypt`; `KmsDataKeyReusePeriodSeconds` giảm số call KMS.
- **Fan-out không phải việc của một SQS queue** — dùng SNS→SQS để nhiều dịch vụ nhận cùng sự kiện qua queue riêng (Chương 22); Lambda tiêu thụ SQS qua event source mapping (Chương 30).
