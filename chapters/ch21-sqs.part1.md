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
