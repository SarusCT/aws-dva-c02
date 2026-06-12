# Chương 49: Bộ đề luyện thi mô phỏng DVA-C02 (65 câu)

> **Trọng tâm DVA-C02:** Đây là bộ đề mô phỏng đầy đủ 65 câu, mô phỏng sát kỳ thi thật về cả độ khó, văn phong scenario lẫn phân bố 4 domain. Mục tiêu của chương là giúp bạn tự đánh giá năng lực trước khi bước vào phòng thi, đồng thời rèn phản xạ loại trừ đáp án nhiễu — thứ quyết định 70% kết quả thi thật.

## Cách dùng bộ đề này

Kỳ thi DVA-C02 thật có **65 câu trắc nghiệm**, làm trong **130 phút**. Trong đó **15 câu là unscored** (câu thử nghiệm, không tính điểm — bạn không biết câu nào), nên thực chất bạn được chấm trên 50 câu. Thang điểm là **100–1000**, ngưỡng pass là **720/1000**. Đề thi phân bố theo 4 domain:

| Domain | Tên | Tỷ trọng |
|--------|-----|----------|
| 1 | Development with AWS Services | 32% |
| 2 | Security | 26% |
| 3 | Deployment | 24% |
| 4 | Troubleshooting and Optimization | 18% |

Bộ đề 65 câu này được chia đúng tỷ lệ trên (≈21 câu Development, ≈17 câu Security, ≈16 câu Deployment, ≈11 câu Troubleshooting). Phần 1 (chương này) gồm **câu 1–33**, phần 2 gồm câu 34–65 cùng bảng tổng kết tự chấm.

**Cách tự chấm và quy đổi:**
1. Làm hết 65 câu trong **130 phút**, KHÔNG xem đáp án giữa chừng. Bấm giờ thật — quản lý thời gian là một kỹ năng phải luyện.
2. Đánh dấu (flag) các câu bạn đoán hoặc phân vân; sau khi làm xong mới đối chiếu.
3. Đếm số câu đúng. Quy đổi tương đối: thang 720/1000 tương đương khoảng **72% câu đúng**, tức cần đúng **≥ 47/65 câu**. Nếu bạn đúng 47–52 câu: ở ngưỡng pass mong manh, cần ôn thêm. Đúng ≥ 55 câu: an toàn để đăng ký thi.
4. Với MỌI câu sai, hãy đọc kỹ phần "vì sao từng phương án còn lại sai" và nhảy về đúng chương được tham chiếu để ôn lại cơ chế — đừng chỉ học thuộc đáp án.

> 💡 **Exam Tip:** Trong đề thật, mỗi câu thường có 2 đáp án "gần đúng". Từ khóa định hướng như *least operational overhead*, *most cost-effective*, *near real-time*, *without modifying application code* chính là chìa khóa chọn giữa 2 đáp án đó. Luyện nhận diện từ khóa song song với luyện kiến thức.

---

## Câu 1 — Domain 1 (Development)

Một developer cần xây dựng một REST endpoint trả về dữ liệu sản phẩm. Lượng truy cập rất bất thường — có lúc 0 request trong nhiều giờ, có lúc đột biến lên hàng nghìn request/giây trong vài phút. Yêu cầu: chi phí thấp nhất khi nhàn rỗi và không phải quản lý server. Kiến trúc nào phù hợp nhất?

- A. Một Application Load Balancer trỏ tới một Auto Scaling Group các EC2 instance chạy ứng dụng.
- B. Amazon API Gateway tích hợp với một AWS Lambda function (Lambda proxy integration).
- C. Một EC2 instance dạng Reserved Instance chạy web server với Nginx.
- D. Amazon ECS trên launch type EC2 với service auto scaling.

**Đáp án: B.** API Gateway + Lambda là kiến trúc serverless điển hình cho workload có traffic bất thường: khi không có request, bạn không trả tiền cho compute (Lambda chỉ tính tiền theo số lần invoke và thời gian chạy), và Lambda tự scale gần như tức thì theo burst. Không có server để quản lý.

- A sai vì ALB + ASG luôn cần ít nhất một EC2 instance chạy 24/7 (ALB còn tính phí theo giờ kể cả khi nhàn rỗi), nên không tối ưu chi phí lúc 0 request và vẫn phải quản lý OS/instance.
- C sai vì Reserved Instance là cam kết chạy liên tục — bạn trả tiền kể cả khi không có request, hoàn toàn ngược với yêu cầu "chi phí thấp nhất khi nhàn rỗi". Lại còn phải tự quản lý server.
- D sai vì ECS trên EC2 vẫn cần các instance trong cluster chạy nền, và developer phải quản lý capacity provider/cluster. Operational overhead cao hơn hẳn so với serverless.

(Ôn lại: Chương 28, 34)

---

## Câu 2 — Domain 1 (Development)

Một developer thiết kế bảng DynamoDB lưu đơn hàng. Truy vấn phổ biến nhất là "lấy tất cả đơn hàng của một customer, sắp xếp theo thời gian tạo giảm dần". Cách thiết kế primary key nào hỗ trợ truy vấn này hiệu quả nhất?

- A. Partition key = `OrderId`, không có sort key.
- B. Partition key = `CustomerId`, sort key = `CreatedAt`.
- C. Partition key = `CreatedAt`, sort key = `CustomerId`.
- D. Partition key = `OrderId`, sort key = `CustomerId`.

**Đáp án: B.** Để query "tất cả đơn của một customer", `CustomerId` phải là partition key (Query yêu cầu cung cấp giá trị partition key chính xác). Dùng `CreatedAt` làm sort key cho phép DynamoDB lưu các item của cùng customer theo thứ tự `CreatedAt`, và bạn dùng tham số `ScanIndexForward=false` để lấy giảm dần — tất cả trong một Query duy nhất, hiệu quả và rẻ.

- A sai vì với partition key là `OrderId` (duy nhất mỗi đơn), muốn lấy mọi đơn của một customer bạn buộc phải Scan toàn bảng + filter — tốn RCU và chậm.
- C sai vì partition key `CreatedAt` (giá trị thời gian) phân tán đơn của cùng customer khắp các partition, không thể Query theo customer; ngoài ra `CreatedAt` cardinality cao theo thời điểm có thể gây hot partition.
- D sai vì partition key vẫn là `OrderId`, không truy vấn được theo customer mà không Scan.

(Ôn lại: Chương 31)

---

## Câu 3 — Domain 2 (Security)

Một developer cần cấp cho một ứng dụng chạy trên EC2 quyền đọc một object cụ thể trong S3. Theo best practice bảo mật của AWS, cách cấp credentials nào là đúng?

- A. Tạo IAM user, sinh access key/secret key rồi hardcode vào file cấu hình trên instance.
- B. Lưu access key trong một biến môi trường trên EC2 user data.
- C. Gắn một IAM Role vào EC2 instance (instance profile) với policy chỉ cho phép `s3:GetObject` trên object đó.
- D. Tạo một bucket policy cho phép mọi principal đọc object, rồi để ứng dụng gọi không cần credentials.

**Đáp án: C.** IAM Role gắn vào EC2 instance cung cấp credentials tạm thời, tự động xoay vòng (rotate), được phân phối qua Instance Metadata Service (IMDS). SDK tự lấy credentials này. Đây là best practice tuyệt đối: không có secret tĩnh nào để lộ, và bạn áp dụng least privilege bằng cách giới hạn policy xuống đúng `s3:GetObject` trên ARN object cụ thể.

- A sai vì hardcode access key là lỗi bảo mật nghiêm trọng: key tĩnh dễ bị lộ qua source control/log, không tự rotate.
- B sai vì user data lưu plaintext và truy cập được qua IMDS, không khác gì lộ key; cũng là long-term credential.
- D sai vì mở object cho mọi principal (`Principal: "*"`) là public exposure — vi phạm least privilege nghiêm trọng và có thể rò rỉ dữ liệu.

(Ôn lại: Chương 2, 4)

---

## Câu 4 — Domain 1 (Development)

Một ứng dụng đẩy message vào một Amazon SQS standard queue. Consumer xử lý mất khoảng 2 phút mỗi message. Developer phát hiện thỉnh thoảng một message bị xử lý 2 lần bởi hai consumer khác nhau. Nguyên nhân khả dĩ nhất là gì?

- A. SQS standard queue không đảm bảo ordering nên message bị nhân đôi.
- B. Visibility timeout đang nhỏ hơn thời gian xử lý message.
- C. Long polling chưa được bật trên queue.
- D. Message size vượt quá 256 KB.

**Đáp án: B.** Khi một consumer nhận message, SQS đặt message vào trạng thái "invisible" trong khoảng *visibility timeout* (mặc định 30 giây). Nếu xử lý mất 2 phút nhưng visibility timeout chỉ 30 giây, message sẽ trở lại visible trước khi consumer đầu tiên xử lý xong và xóa nó — consumer thứ hai nhặt được và xử lý lại. Khắc phục: tăng visibility timeout lên lớn hơn thời gian xử lý (hoặc gọi `ChangeMessageVisibility` để gia hạn).

- A sai vì standard queue có cơ chế at-least-once và đôi khi duplicate, nhưng đó không phải nguyên nhân của duplicate *có hệ thống* khi processing time > visibility timeout; mô tả "thỉnh thoảng bị xử lý 2 lần đúng khi xử lý lâu" chỉ thẳng vào visibility timeout.
- C sai vì long polling chỉ giảm số empty response và chi phí API, không liên quan tới duplicate processing.
- D sai vì message > 256 KB sẽ bị từ chối khi gửi, không gây xử lý lặp.

(Ôn lại: Chương 21)

---

## Câu 5 — Domain 3 (Deployment)

Một team dùng AWS SAM để deploy một Lambda function phục vụ production. Họ muốn mỗi lần release chỉ chuyển 10% traffic sang version mới trong 10 phút đầu, nếu CloudWatch alarm không kêu thì chuyển nốt 100%. Cấu hình SAM nào thực hiện điều này?

- A. Đặt `DeploymentPreference.Type: AllAtOnce` với `Alarms`.
- B. Đặt `AutoPublishAlias` và `DeploymentPreference.Type: Canary10Percent10Minutes` kèm `Alarms`.
- C. Dùng `Canary10Percent10Minutes` nhưng bỏ `AutoPublishAlias`.
- D. Dùng CodePipeline blue/green deployment trên EC2.

**Đáp án: B.** SAM tích hợp CodeDeploy cho Lambda traffic shifting. `AutoPublishAlias` bảo SAM publish version mới và trỏ alias vào đó mỗi lần deploy. `DeploymentPreference.Type: Canary10Percent10Minutes` shift 10% traffic trong 10 phút rồi mới chuyển 100%. Kèm `Alarms` để CodeDeploy tự rollback nếu alarm chuyển sang ALARM.

- A sai vì `AllAtOnce` chuyển 100% ngay lập tức, không có giai đoạn canary 10%.
- C sai vì thiếu `AutoPublishAlias` thì không có alias nào để CodeDeploy shift traffic — traffic shifting Lambda hoạt động trên alias, nên cấu hình này không chạy.
- D sai vì đây là Lambda, không phải EC2; blue/green EC2 là deployment type khác hoàn toàn.

(Ôn lại: Chương 36, 41)

---

## Câu 6 — Domain 2 (Security)

Một developer muốn cho phép một ứng dụng frontend chạy trên trình duyệt upload file trực tiếp lên một S3 bucket private, mà không lộ AWS credentials trong code JavaScript phía client. Giải pháp nào phù hợp?

- A. Embed access key của một IAM user vào JavaScript với quyền `s3:PutObject`.
- B. Backend sinh một S3 presigned URL (PUT) và trả về cho frontend để upload.
- C. Bật public write trên bucket để ai cũng upload được.
- D. Dùng bucket ACL cấp quyền write cho `AuthenticatedUsers`.

**Đáp án: B.** Presigned URL được backend ký bằng credentials của nó, mã hóa quyền `s3:PutObject` cho một object key cụ thể và có thời hạn (expiry). Frontend chỉ nhận URL đã ký và PUT trực tiếp lên S3 — không hề thấy credentials. Đây là pattern chuẩn cho upload trực tiếp từ browser.

- A sai vì nhúng access key vào JS phía client là lộ credentials hoàn toàn — bất kỳ ai mở DevTools đều thấy.
- C sai vì public write là lỗ hổng nghiêm trọng, ai cũng ghi đè/đổ rác vào bucket.
- D sai vì `AuthenticatedUsers` trong S3 ACL nghĩa là *bất kỳ AWS account nào* (mọi user đã đăng nhập AWS), không phải user của riêng bạn — vẫn là public exposure thực tế.

(Ôn lại: Chương 12, 14)

---

## Câu 7 — Domain 1 (Development)

Một Lambda function cần lưu một database password để kết nối tới RDS. Yêu cầu: password được mã hóa, tự động rotate định kỳ, và quản lý vòng đời rotation tự động cho RDS. Dịch vụ nào nên dùng?

- A. SSM Parameter Store standard tier dạng String.
- B. AWS Secrets Manager với managed rotation cho RDS.
- C. Biến môi trường Lambda lưu plaintext password.
- D. Hardcode password trong code và mã hóa bằng KMS thủ công.

**Đáp án: B.** Secrets Manager hỗ trợ **managed rotation tích hợp sẵn cho RDS**: nó tạo/quản lý một Lambda rotation function, đổi password trong RDS và cập nhật secret theo lịch (ví dụ 30 ngày) mà không cần bạn viết code rotation. Secret được mã hóa bằng KMS.

- A sai vì Parameter Store standard String không mã hóa (phải dùng SecureString) và **không có rotation tích hợp sẵn** — bạn phải tự xây dựng. (Parameter Store rẻ hơn nhưng không đáp ứng yêu cầu auto-rotation.)
- C sai vì biến môi trường plaintext không an toàn và không rotate.
- D sai vì hardcode + mã hóa thủ công là anti-pattern, không có cơ chế rotate tự động và dễ lỗi.

(Ôn lại: Chương 47)

---

## Câu 8 — Domain 4 (Troubleshooting)

Một Lambda function trong VPC cần gọi DynamoDB và một REST API công khai trên internet. Function gọi DynamoDB thành công nhưng gọi REST API bị timeout. Nguyên nhân khả dĩ nhất?

- A. Lambda trong VPC không bao giờ truy cập được DynamoDB.
- B. Subnet của Lambda là private và không có NAT Gateway nên không ra được internet.
- C. Execution role của Lambda thiếu quyền `dynamodb:GetItem`.
- D. Lambda timeout đặt quá lớn.

**Đáp án: B.** Lambda đặt trong private subnet không có đường ra internet trừ khi subnet đó route qua NAT Gateway (hoặc dùng VPC endpoint cho dịch vụ AWS). DynamoDB gọi được vì có thể đi qua **Gateway VPC Endpoint** cho DynamoDB (lưu lượng nội bộ AWS, không cần internet), nhưng REST API công khai cần ra internet nên timeout do thiếu NAT Gateway.

- A sai vì Lambda trong VPC truy cập DynamoDB được qua Gateway Endpoint — và thực tế đề nói nó gọi DynamoDB thành công.
- C sai vì nếu thiếu quyền `dynamodb:GetItem` thì lỗi là AccessDenied, không phải timeout, và DynamoDB đã gọi thành công.
- D sai vì timeout lớn không gây ra lỗi timeout khi gọi API ngoài; ngược lại timeout lớn còn cho phép chờ lâu hơn.

(Ôn lại: Chương 29, 11)

---

## Câu 9 — Domain 1 (Development)

Một developer cần fan-out: khi một order được tạo, ba hệ thống độc lập (inventory, billing, analytics) đều phải nhận được thông báo, và mỗi hệ thống xử lý theo tốc độ riêng với khả năng retry độc lập. Kiến trúc nào phù hợp nhất?

- A. Gửi message vào một SQS queue duy nhất cho cả ba consumer cùng poll.
- B. Publish message lên một SNS topic, mỗi hệ thống subscribe bằng một SQS queue riêng (SNS fan-out).
- C. Ghi vào một DynamoDB table và cho ba hệ thống poll table.
- D. Gọi đồng bộ ba REST API của ba hệ thống lần lượt.

**Đáp án: B.** Pattern SNS fan-out: publisher gửi 1 message lên SNS topic, mỗi consumer có một SQS queue riêng subscribe topic đó. Mỗi hệ thống có buffer riêng, xử lý theo tốc độ riêng, retry và DLQ độc lập. Đây là kiến trúc decoupled chuẩn cho fan-out.

- A sai vì với một queue chung, mỗi message chỉ được MỘT consumer nhận và xóa — ba hệ thống không thể đều nhận cùng một message.
- C sai vì DynamoDB không phải hệ messaging; poll table tốn kém, không có cơ chế retry/DLQ per-consumer và khó scale.
- D sai vì gọi đồng bộ làm coupling chặt: nếu một hệ thống chậm/lỗi, toàn bộ flow bị ảnh hưởng, không có buffer hay retry độc lập.

(Ôn lại: Chương 22)

---

## Câu 10 — Domain 3 (Deployment)

Một developer dùng CloudFormation để deploy stack có một S3 bucket chứa dữ liệu quan trọng. Khi xóa stack, họ KHÔNG muốn bucket bị xóa theo. Cấu hình nào đạt được điều này?

- A. Đặt `DeletionPolicy: Retain` trên resource S3 bucket.
- B. Bật termination protection cho stack.
- C. Dùng `UpdateReplacePolicy: Snapshot`.
- D. Đặt `DependsOn` trên bucket.

**Đáp án: A.** `DeletionPolicy: Retain` bảo CloudFormation giữ lại resource khi stack bị xóa hoặc khi resource bị remove khỏi template. Bucket sẽ tồn tại độc lập sau khi stack biến mất.

- B sai vì termination protection chỉ ngăn việc *xóa cả stack*, không kiểm soát hành vi của từng resource khi stack bị xóa; nếu vẫn xóa stack thì bucket vẫn bị xóa.
- C sai vì `UpdateReplacePolicy` chỉ áp dụng khi resource bị *thay thế trong lúc update*, không áp dụng khi xóa stack; và `Snapshot` không hợp lệ cho S3 bucket (chỉ một số resource như RDS/EBS hỗ trợ Snapshot).
- D sai vì `DependsOn` chỉ điều khiển thứ tự tạo/xóa resource, không ngăn việc xóa.

(Ôn lại: Chương 20)

---

## Câu 11 — Domain 2 (Security)

Một REST API trên API Gateway cần xác thực người dùng đã đăng nhập qua một Amazon Cognito User Pool. Developer muốn API Gateway tự kiểm tra JWT token mà không phải viết code authorizer. Cách nào đúng?

- A. Dùng IAM authorizer (SigV4).
- B. Dùng Cognito User Pools authorizer trên method.
- C. Dùng Lambda authorizer kiểm tra token thủ công.
- D. Dùng API key trong usage plan.

**Đáp án: B.** API Gateway có **Cognito User Pools authorizer** tích hợp sẵn: bạn gắn user pool vào authorizer, client gửi ID/access token trong header `Authorization`, API Gateway tự verify chữ ký và hạn token với user pool — không cần viết code.

- A sai vì IAM authorizer dùng SigV4 dựa trên AWS credentials, không phải JWT từ Cognito User Pool; phù hợp cho gọi nội bộ giữa các service AWS chứ không cho người dùng đăng nhập qua user pool.
- C sai vì Lambda authorizer *cũng* xác thực được nhưng yêu cầu bạn tự viết code verify JWT — trái yêu cầu "không phải viết code authorizer".
- D sai vì API key chỉ để định danh client cho usage plan/throttling, KHÔNG phải cơ chế authentication người dùng.

(Ôn lại: Chương 35, 38)

---

## Câu 12 — Domain 1 (Development)

Một developer cần xử lý các bản ghi clickstream với tốc độ rất cao (hàng trăm nghìn record/giây), cần giữ ordering theo từng user, và cho phép nhiều ứng dụng consumer đọc lại dữ liệu trong vòng 24 giờ qua. Dịch vụ nào phù hợp nhất?

- A. Amazon SQS standard queue.
- B. Amazon SNS topic.
- C. Amazon Kinesis Data Streams với partition key là user ID.
- D. Amazon SES.

**Đáp án: C.** Kinesis Data Streams thiết kế cho streaming throughput cao. Dùng partition key = user ID đảm bảo các record của cùng user vào cùng shard → giữ ordering theo user. Dữ liệu lưu trong stream theo retention (mặc định 24 giờ, có thể tới 365 ngày), cho phép nhiều consumer độc lập đọc/đọc lại cùng dữ liệu.

- A sai vì SQS standard không đảm bảo ordering và mỗi message chỉ được một consumer xử lý rồi xóa — không "đọc lại" được, không hỗ trợ nhiều consumer độc lập đọc cùng data.
- B sai vì SNS là pub/sub push, không lưu trữ để replay, không có khái niệm ordering theo key kiểu shard.
- D sai vì SES là dịch vụ gửi email, không liên quan streaming.

(Ôn lại: Chương 23)

---

## Câu 13 — Domain 4 (Troubleshooting)

Một Lambda function được trigger bởi DynamoDB Streams. Một record gây lỗi khiến cả batch bị retry liên tục, làm tắc nghẽn xử lý các record sau. Developer muốn cô lập record lỗi và không chặn các record còn lại. Cấu hình nào hữu ích nhất?

- A. Tăng batch size để xử lý nhanh hơn.
- B. Bật `BisectBatchOnFunctionError` và cấu hình `MaximumRetryAttempts` cùng on-failure destination.
- C. Đổi sang invocation đồng bộ.
- D. Xóa stream và tạo lại.

**Đáp án: B.** Với event source mapping cho DynamoDB/Kinesis Streams, `BisectBatchOnFunctionError` chia đôi batch khi lỗi để khoanh vùng record gây lỗi, kết hợp `MaximumRetryAttempts` để giới hạn số lần retry, và `OnFailure` destination (SQS/SNS) để đẩy record lỗi đi nơi khác. Nhờ đó record lỗi bị cô lập, các record còn lại tiếp tục được xử lý.

- A sai vì tăng batch size làm vấn đề nặng hơn — batch lớn hơn càng dễ chứa record lỗi và bị retry cả batch.
- C sai vì event source mapping cho stream luôn theo cơ chế poll/batch; "đồng bộ" không phải lựa chọn cấu hình và không giải quyết poison record.
- D sai vì xóa/tạo lại stream làm mất dữ liệu và không giải quyết gốc rễ.

(Ôn lại: Chương 30)

---

## Câu 14 — Domain 1 (Development)

Một developer viết code SDK gọi DynamoDB và thỉnh thoảng nhận lỗi `ProvisionedThroughputExceededException`. Cách xử lý đúng và được AWS SDK hỗ trợ sẵn là gì?

- A. Bỏ qua lỗi và tiếp tục.
- B. Áp dụng exponential backoff với jitter để retry (SDK đã tích hợp sẵn).
- C. Chuyển ngay sang SQL database.
- D. Tăng timeout của request lên 5 phút.

**Đáp án: B.** `ProvisionedThroughputExceededException` là lỗi throttling tạm thời. Cách chuẩn là retry với **exponential backoff + jitter**. AWS SDK đã tích hợp retry logic này mặc định (có thể tinh chỉnh `maxRetries`). Nếu throttle xảy ra thường xuyên, mới cân nhắc tăng provisioned capacity hoặc chuyển on-demand.

- A sai vì bỏ qua lỗi làm mất dữ liệu ghi/đọc.
- C sai vì đây là phản ứng thái quá; throttling giải quyết bằng retry/điều chỉnh capacity, không cần đổi cả công nghệ DB.
- D sai vì tăng timeout không giảm throttling; lỗi vẫn xảy ra do vượt RCU/WCU.

(Ôn lại: Chương 3, 31)

---

## Câu 15 — Domain 3 (Deployment)

Một developer dùng AWS Elastic Beanstalk cho ứng dụng web. Yêu cầu: deploy version mới với zero downtime, và trong lúc deploy luôn giữ đủ full capacity để phục vụ traffic. Deployment policy nào nên chọn?

- A. All at once.
- B. Rolling.
- C. Rolling with additional batches.
- D. Immutable.

**Đáp án: C (hoặc D đều giữ full capacity; ở đây chọn C theo mô tả).** "Rolling with additional batches" khởi tạo thêm một batch instance MỚI trước, nên trong suốt quá trình deploy luôn giữ đủ full capacity (không giảm capacity như Rolling thường). Phù hợp khi cần luôn đủ năng lực phục vụ.

- A sai vì All at once deploy lên tất cả instance cùng lúc → có downtime, không zero downtime.
- B sai vì Rolling thường lấy bớt instance hiện có ra để cập nhật theo batch → trong lúc deploy capacity bị giảm dưới mức full.
- D *cũng* giữ full capacity (tạo hẳn tập instance mới song song) và an toàn nhất, nhưng tốn tài nguyên gấp đôi và lâu hơn; mô tả "thêm batch để giữ full capacity" mô tả chính xác policy "rolling with additional batches". (Immutable và traffic-splitting cũng zero downtime — đây là điểm cần phân biệt kỹ.)

(Ôn lại: Chương 18)

---

## Câu 16 — Domain 2 (Security)

Một developer cần cho một Lambda function ở account A đọc một object S3 ở account B. Cách thiết lập quyền cross-account đúng là gì?

- A. Chỉ cần gắn IAM policy `s3:GetObject` cho execution role của Lambda ở account A.
- B. Gắn policy `s3:GetObject` cho execution role của Lambda (account A) VÀ thêm bucket policy ở account B cho phép principal là role đó.
- C. Bật public access trên bucket ở account B.
- D. Tạo IAM user ở account B rồi hardcode key vào Lambda.

**Đáp án: B.** Truy cập cross-account S3 cần CẢ HAI phía cho phép: (1) identity-based policy trên Lambda role (account A) cho `s3:GetObject`, và (2) resource-based policy (bucket policy) trên bucket account B cấp quyền cho principal là ARN của role đó. Thiếu một trong hai sẽ bị từ chối.

- A sai vì chỉ có policy phía account A là chưa đủ — account B chưa cho phép principal lạ truy cập, mặc định bị deny cross-account.
- C sai vì public access mở dữ liệu cho cả internet, vi phạm least privilege.
- D sai vì dùng IAM user + hardcode key là anti-pattern bảo mật; cross-account nên dùng role/bucket policy.

(Ôn lại: Chương 14, 45)

---

## Câu 17 — Domain 1 (Development)

Một developer cần đảm bảo idempotency: khi cùng một message SQS được giao 2 lần (do at-least-once delivery), thao tác ghi vào DynamoDB không bị thực hiện trùng. Kỹ thuật nào phù hợp?

- A. Dùng `PutItem` với `ConditionExpression: attribute_not_exists(MessageId)`.
- B. Tăng visibility timeout lên tối đa.
- C. Đổi sang SQS FIFO và bỏ qua idempotency.
- D. Xóa DynamoDB table sau mỗi lần ghi.

**Đáp án: A.** Conditional write với `attribute_not_exists(MessageId)` đảm bảo item chỉ được tạo nếu chưa tồn tại — nếu message trùng tới lần hai, điều kiện thất bại (ConditionalCheckFailed) và không ghi đè/ghi trùng. Đây là pattern idempotency kinh điển với DynamoDB.

- B sai vì tăng visibility timeout giảm khả năng duplicate do timeout nhưng KHÔNG đảm bảo idempotency: SQS standard vẫn có thể giao trùng do bản chất at-least-once.
- C sai vì FIFO có deduplication trong cửa sổ 5 phút, nhưng không phải mọi trường hợp đều dùng được FIFO (throughput thấp hơn) và mô tả vẫn cần đảm bảo idempotency phía ghi; "bỏ qua idempotency" là sai về nguyên tắc.
- D sai hoàn toàn — xóa table làm mất dữ liệu.

(Ôn lại: Chương 32, 30)

---

## Câu 18 — Domain 4 (Troubleshooting)

Một developer bật X-Ray active tracing trên Lambda nhưng không thấy bất kỳ trace nào trong service map. Code đã chạy bình thường. Nguyên nhân khả dĩ nhất?

- A. Lambda không bao giờ hỗ trợ X-Ray.
- B. Execution role của Lambda thiếu quyền ghi vào X-Ray (`xray:PutTraceSegments`, `xray:PutTelemetryRecords`).
- C. X-Ray chỉ hoạt động với EC2.
- D. Phải bật CloudTrail trước.

**Đáp án: B.** Để gửi trace, Lambda execution role cần các quyền `xray:PutTraceSegments` và `xray:PutTelemetryRecords` (managed policy `AWSXRayDaemonWriteAccess`). Khi bật active tracing qua console/SAM, các quyền này thường được thêm tự động — nhưng nếu role bị tùy chỉnh hoặc deploy qua IaC thiếu policy, trace sẽ không xuất hiện dù code chạy bình thường.

- A sai vì Lambda hỗ trợ X-Ray qua active tracing.
- C sai vì X-Ray hoạt động với nhiều dịch vụ (Lambda, API Gateway, ECS, Beanstalk...), không chỉ EC2.
- D sai vì CloudTrail (audit API calls) không liên quan tới việc gửi trace X-Ray.

(Ôn lại: Chương 26)

---

## Câu 19 — Domain 1 (Development)

Một developer cần điều phối một workflow nhiều bước: gọi Lambda A, nếu thành công thì rẽ nhánh theo kết quả để gọi Lambda B hoặc C, có retry/backoff per-step và có thể chờ một tác vụ thủ công callback. Dịch vụ nào phù hợp nhất?

- A. Viết toàn bộ logic trong một Lambda lớn với if/else.
- B. AWS Step Functions với các state Task, Choice, và pattern wait-for-callback (`.waitForTaskToken`).
- C. Amazon SQS với nhiều queue nối tiếp.
- D. CloudWatch Events scheduled rules.

**Đáp án: B.** Step Functions sinh ra để orchestrate workflow: state `Task` gọi Lambda, `Choice` rẽ nhánh theo kết quả, mỗi state có `Retry`/`Catch` riêng với backoff, và integration pattern `.waitForTaskToken` cho phép tạm dừng chờ callback từ tác vụ thủ công/bên ngoài rồi mới đi tiếp. Logic được mô tả khai báo, dễ quan sát và bảo trì.

- A sai vì nhồi toàn bộ orchestration vào một Lambda tạo "Lambda quái vật": khó retry per-step, khó chờ callback (Lambda max 15 phút), khó debug và observability kém.
- C sai vì chuỗi SQS có thể truyền message nhưng không có cơ chế rẽ nhánh điều kiện, retry/backoff per-step hay wait-for-callback một cách khai báo.
- D sai vì scheduled rules chỉ kích hoạt theo lịch, không orchestrate workflow nhiều bước.

(Ôn lại: Chương 43)

---

## Câu 20 — Domain 3 (Deployment)

Một team cần một pipeline CI/CD trên AWS: source từ GitHub, build/test, rồi deploy. Họ muốn dịch vụ quản lý orchestration toàn bộ pipeline và kết nối GitHub theo cách được khuyến nghị hiện nay. Tổ hợp nào đúng?

- A. CodePipeline với CodeStar connection tới GitHub, stage build dùng CodeBuild.
- B. Chỉ dùng CodeBuild với webhook GitHub, không cần CodePipeline.
- C. Jenkins tự host trên EC2 là lựa chọn duy nhất.
- D. CodeDeploy làm orchestrator chính cho cả build và deploy.

**Đáp án: A.** CodePipeline là dịch vụ orchestration pipeline. Cách kết nối GitHub được khuyến nghị hiện nay là **CodeStar connection** (AWS CodeConnections) thay cho OAuth token cũ. Stage build dùng CodeBuild, stage deploy dùng CodeDeploy/CloudFormation. Đây là tổ hợp chuẩn.

- B sai vì CodeBuild chỉ là build service; tuy có thể trigger qua webhook nhưng không orchestrate multi-stage pipeline (source → build → test → deploy → approval).
- C sai vì Jenkins là một lựa chọn nhưng không phải "duy nhất"; câu hỏi yêu cầu giải pháp managed trên AWS.
- D sai vì CodeDeploy chỉ phụ trách deployment, không orchestrate cả pipeline.

(Ôn lại: Chương 42, 40)

---

## Câu 21 — Domain 2 (Security)

Một developer cần mã hóa các object lớn (vài GB) trước khi lưu lên S3, dùng KMS nhưng tránh giới hạn 4 KB của API `Encrypt` trực tiếp. Cơ chế nào KMS cung cấp cho việc này?

- A. Tăng giới hạn `Encrypt` lên vài GB qua quota request.
- B. Envelope encryption: dùng `GenerateDataKey` lấy data key, mã hóa dữ liệu bằng data key (cục bộ), lưu kèm encrypted data key.
- C. Dùng SSE-C và tự quản lý key.
- D. Chia object thành các block 4 KB rồi gọi `Encrypt` cho từng block.

**Đáp án: B.** KMS `Encrypt` chỉ mã hóa trực tiếp tối đa 4 KB. Với dữ liệu lớn, dùng **envelope encryption**: gọi `GenerateDataKey` để nhận một plaintext data key + encrypted data key. Dùng plaintext data key mã hóa dữ liệu cục bộ (AES), xóa plaintext key khỏi bộ nhớ, lưu encrypted data key kèm ciphertext. Khi đọc, gọi `Decrypt` để lấy lại data key. Đây là cơ chế nền tảng của SSE-KMS.

- A sai vì giới hạn 4 KB của `Encrypt` là cứng, không tăng được; KMS không dùng để mã hóa khối dữ liệu lớn trực tiếp.
- C sai vì SSE-C nghĩa là bạn tự cung cấp và quản lý key, không liên quan tới việc vượt giới hạn 4 KB của KMS, và không phải điều câu hỏi yêu cầu.
- D sai vì chia thành block 4 KB rồi gọi `Encrypt` nhiều lần là vừa kém hiệu năng vừa tốn quota KMS khủng khiếp — sai thiết kế.

(Ôn lại: Chương 46)

---

## Câu 22 — Domain 1 (Development)

Một developer cần giảm cold start cho một Lambda function nhạy về latency, đảm bảo có sẵn execution environment "ấm" để phục vụ ngay. Tính năng nào nên dùng?

- A. Reserved concurrency.
- B. Provisioned concurrency.
- C. Tăng timeout của function.
- D. Tăng memory lên tối đa 10 GB.

**Đáp án: B.** **Provisioned concurrency** giữ sẵn một số lượng execution environment đã được khởi tạo (init xong), nên request đến được phục vụ ngay không phải chịu cold start. Phù hợp cho function nhạy latency và lưu lượng dự đoán được.

- A sai vì reserved concurrency chỉ *giới hạn/đảm bảo* số concurrency tối đa dành riêng cho function, KHÔNG giữ environment ấm — request mới vẫn có thể cold start.
- C sai vì timeout chỉ giới hạn thời gian chạy tối đa, không liên quan cold start.
- D sai vì tăng memory cấp thêm CPU và có thể rút ngắn thời gian init đôi chút, nhưng KHÔNG loại bỏ cold start; provisioned concurrency mới là giải pháp đúng.

(Ôn lại: Chương 29)

---

## Câu 23 — Domain 4 (Troubleshooting)

Một ứng dụng đọc/ghi DynamoDB với access pattern đọc rất nhiều một số item "nóng" (hot keys), gây throttling và latency cao. Yêu cầu: thêm caching microsecond mà thay đổi code tối thiểu. Giải pháp nào phù hợp nhất?

- A. Đặt Amazon ElastiCache for Redis trước DynamoDB và viết lại logic cache-aside.
- B. Dùng DynamoDB Accelerator (DAX) — in-memory cache tương thích API DynamoDB.
- C. Tăng RCU lên rất cao vĩnh viễn.
- D. Bật DynamoDB Streams.

**Đáp án: B.** DAX là cache in-memory được quản lý, **tương thích API DynamoDB**: bạn chỉ đổi client sang DAX client, hầu như không phải viết lại logic. Nó cung cấp đọc microsecond cho item cache/query cache, giảm tải đọc lên bảng và xử lý hot read tốt. "Thay đổi code tối thiểu" là từ khóa chỉ thẳng DAX.

- A sai vì ElastiCache cũng cache được nhưng phải tự viết logic cache-aside (đọc cache, miss thì đọc DB rồi set cache) — code thay đổi đáng kể, trái yêu cầu.
- C sai vì tăng RCU vĩnh viễn tốn kém và không giải quyết hot partition (một partition vẫn bị giới hạn throughput nội bộ).
- D sai vì Streams dùng để capture thay đổi, không phải caching đọc.

(Ôn lại: Chương 33)

---

## Câu 24 — Domain 1 (Development)

Một developer cần ghi log có cấu trúc từ Lambda và sau đó truy vấn nhanh các log đó để tìm các request có `statusCode = 500`. Dịch vụ/tính năng nào hỗ trợ truy vấn này?

- A. CloudWatch Logs Insights query trên log group.
- B. CloudTrail event history.
- C. X-Ray annotations.
- D. S3 Select trên access log của ALB.

**Đáp án: A.** Lambda tự ghi log vào CloudWatch Logs. **CloudWatch Logs Insights** cho phép viết query (ví dụ `fields @message | filter statusCode = 500`) để lọc/aggregate log nhanh chóng. Đây là công cụ chuẩn để truy vấn log Lambda.

- B sai vì CloudTrail ghi lại API call quản trị/dữ liệu trên AWS account, không phải application log của Lambda.
- C sai vì X-Ray annotations giúp filter trace (latency/error theo segment), không phải truy vấn nội dung log text tùy ý.
- D sai vì S3 Select dùng cho object trong S3; access log ALB không phải log ứng dụng Lambda.

(Ôn lại: Chương 25)

---

## Câu 25 — Domain 2 (Security)

Một developer cần cấp quyền cho một mobile app (đăng nhập qua Cognito User Pool) gọi trực tiếp AWS service (ví dụ upload S3) bằng temporary AWS credentials, với quyền giới hạn theo từng user. Thành phần nào cấp credentials AWS tạm thời?

- A. Cognito User Pool token được dùng trực tiếp làm AWS credentials.
- B. Cognito Identity Pool đổi token (từ User Pool) lấy temporary AWS credentials qua STS.
- C. API key của API Gateway.
- D. Một IAM user dùng chung cho mọi mobile user.

**Đáp án: B.** **Cognito Identity Pool** (Federated Identities) nhận token từ identity provider (ví dụ User Pool) và đổi lấy **temporary AWS credentials** thông qua STS (`AssumeRoleWithWebIdentity`). Bạn gán IAM role với policy dùng policy variable `${cognito-identity.amazonaws.com:sub}` để giới hạn quyền theo từng user (ví dụ chỉ ghi vào prefix S3 của chính họ).

- A sai vì token của User Pool (JWT) dùng để authenticate/authorize ứng dụng của bạn, KHÔNG phải AWS credentials và không gọi trực tiếp AWS service được.
- C sai vì API key chỉ định danh client cho usage plan, không cấp AWS credentials.
- D sai vì dùng chung một IAM user cho mọi mobile user là anti-pattern bảo mật (không phân biệt được user, không least privilege, key dễ lộ).

(Ôn lại: Chương 39, 38)

---

## Câu 26 — Domain 3 (Deployment)

Một developer muốn template CloudFormation tham chiếu giá trị secret từ Secrets Manager tại thời điểm deploy mà không hardcode secret vào template. Cú pháp nào đúng?

- A. `!Ref MySecret`.
- B. `{{resolve:secretsmanager:MySecret:SecretString:password}}` (dynamic reference).
- C. `Fn::GetAtt [MySecret, Value]`.
- D. Hardcode secret rồi mã hóa base64.

**Đáp án: B.** CloudFormation hỗ trợ **dynamic references** dạng `{{resolve:secretsmanager:...}}` (và `{{resolve:ssm:...}}`, `{{resolve:ssm-secure:...}}`) để lấy giá trị secret/parameter tại thời điểm deploy mà không lưu plaintext trong template. Đây là cách an toàn để inject secret vào resource (ví dụ RDS MasterUserPassword).

- A sai vì `!Ref` tới một resource secret trả về ARN của secret, không phải giá trị bên trong.
- C sai vì `Fn::GetAtt` không lấy được giá trị secret plaintext; không có attribute `Value` kiểu đó.
- D sai vì hardcode + base64 không phải mã hóa, secret vẫn lộ trong template — anti-pattern.

(Ôn lại: Chương 47, 19)

---

## Câu 27 — Domain 1 (Development)

Một developer dùng `Query` trên DynamoDB và kết quả trả về bị cắt bớt (không đủ tất cả item khớp). Cách lấy phần còn lại đúng chuẩn là gì?

- A. Tăng RCU rồi gọi lại từ đầu.
- B. Dùng `LastEvaluatedKey` từ response làm `ExclusiveStartKey` cho lần Query tiếp theo (pagination).
- C. Chuyển sang `Scan` toàn bảng.
- D. Dùng `ConsistentRead=true`.

**Đáp án: B.** DynamoDB giới hạn mỗi page kết quả ở 1 MB. Khi còn dữ liệu, response trả về `LastEvaluatedKey`. Bạn lặp lại Query với `ExclusiveStartKey = LastEvaluatedKey` cho tới khi `LastEvaluatedKey` không còn — đó là pagination chuẩn.

- A sai vì tăng RCU không bỏ giới hạn 1 MB/page; gọi lại từ đầu lặp lại cùng page.
- C sai vì Scan đọc toàn bảng, tốn kém hơn nhiều và cũng vẫn bị giới hạn 1 MB/page (vẫn phải paginate).
- D sai vì `ConsistentRead` chỉ ảnh hưởng tính nhất quán đọc, không liên quan tới việc lấy đủ tất cả item qua nhiều page.

(Ôn lại: Chương 31, 32)

---

## Câu 28 — Domain 4 (Troubleshooting)

Một API Gateway REST API tích hợp Lambda proxy. Client báo lỗi `502 Bad Gateway`. Nguyên nhân thường gặp nhất là gì?

- A. Lambda function trả về response không đúng định dạng mà Lambda proxy integration yêu cầu.
- B. API Gateway hết quota account.
- C. Client gửi sai API key.
- D. CloudWatch Logs bị tắt.

**Đáp án: A.** Với Lambda proxy integration, function phải trả về object đúng cấu trúc: `{ statusCode, headers, body (string) }`. Nếu trả về sai định dạng (ví dụ trả object thô, hoặc body không phải string), API Gateway không parse được và trả `502 Bad Gateway`. Đây là lỗi cấu trúc response kinh điển.

- B sai vì vượt quota account thường gây `429 Too Many Requests`, không phải 502.
- C sai vì sai API key gây `403 Forbidden`, không phải 502.
- D sai vì tắt logging không gây lỗi 502; nó chỉ khiến bạn khó debug.

(Ôn lại: Chương 34)

---

## Câu 29 — Domain 1 (Development)

Một developer cần một event bus để nhận sự kiện từ nhiều SaaS partner và AWS service, lọc theo nội dung sự kiện (event pattern) rồi route tới nhiều target khác nhau, có thể lưu trữ và replay. Dịch vụ nào phù hợp nhất?

- A. Amazon SQS.
- B. Amazon EventBridge.
- C. Amazon SNS standard topic.
- D. AWS Step Functions.

**Đáp án: B.** EventBridge là event bus serverless: hỗ trợ default/custom/partner event bus, **rule với event pattern** lọc theo nội dung JSON của event, route tới nhiều target (Lambda, SQS, SNS, Step Functions...), và có **archive & replay**. Phù hợp tuyệt đối cho event-driven routing từ SaaS partner và AWS service.

- A sai vì SQS là queue point-to-point, không có content-based routing tới nhiều target hay replay theo kiểu archive.
- C sai vì SNS có message filtering nhưng không có khái niệm partner event bus, archive & replay, và event pattern matching phong phú như EventBridge.
- D sai vì Step Functions orchestrate workflow, không phải event bus đa nguồn với filtering/routing.

(Ôn lại: Chương 25)

---

## Câu 30 — Domain 2 (Security)

Một bucket policy cần đảm bảo mọi request tới bucket đều dùng HTTPS (mã hóa in transit), từ chối request HTTP. Điều kiện (Condition) nào trong policy thực hiện điều này?

- A. `"Bool": {"aws:SecureTransport": "false"}` với Effect `Deny`.
- B. `"StringEquals": {"s3:x-amz-server-side-encryption": "AES256"}`.
- C. `"IpAddress": {"aws:SourceIp": "0.0.0.0/0"}`.
- D. `"Bool": {"aws:MultiFactorAuthPresent": "true"}`.

**Đáp án: A.** Để ép HTTPS, ta thêm một statement `Deny` với điều kiện `"Bool": {"aws:SecureTransport": "false"}` — nghĩa là từ chối mọi request KHÔNG dùng TLS. `aws:SecureTransport` là global condition key cho biết request có qua HTTPS hay không.

- B sai vì điều kiện này ép server-side encryption header (mã hóa at rest), không liên quan in-transit/HTTPS.
- C sai vì điều kiện IP không kiểm soát giao thức HTTP/HTTPS.
- D sai vì MFA condition kiểm soát yêu cầu xác thực đa yếu tố, không liên quan tới việc ép HTTPS.

(Ôn lại: Chương 14)

---

## Câu 31 — Domain 3 (Deployment)

Một developer dùng CodeBuild để build ứng dụng. Trong quá trình build cần lấy một secret (ví dụ token registry). Cách an toàn để inject secret vào build environment là gì?

- A. Ghi secret trực tiếp vào `buildspec.yml` dạng plaintext.
- B. Tham chiếu secret từ Secrets Manager/SSM Parameter Store trong phần `env.secrets-manager`/`env.parameter-store` của buildspec.
- C. Lưu secret vào source code repository.
- D. Truyền secret qua tên artifact.

**Đáp án: B.** Buildspec hỗ trợ khai báo `env.secrets-manager` (lấy từ Secrets Manager) và `env.parameter-store` (lấy SecureString từ SSM Parameter Store). Secret được inject vào biến môi trường lúc build runtime, không lộ plaintext trong file cấu hình. CodeBuild role cần quyền đọc các secret/parameter đó.

- A sai vì plaintext trong buildspec (thường nằm trong repo) làm lộ secret cho mọi người đọc được repo.
- C sai vì lưu secret trong repo là lỗi bảo mật nghiêm trọng, dễ rò rỉ qua lịch sử git.
- D sai vì artifact name không phải kênh truyền secret và cũng không an toàn.

(Ôn lại: Chương 40, 47)

---

## Câu 32 — Domain 1 (Development)

Một developer cần một bảng DynamoDB cho phép truy vấn theo một thuộc tính KHÔNG phải primary key (ví dụ tra cứu order theo `status`). Yêu cầu: tạo được sau khi bảng đã có dữ liệu, và partition key của index khác primary key của bảng. Cấu trúc nào phù hợp?

- A. Local Secondary Index (LSI).
- B. Global Secondary Index (GSI) với partition key là `status`.
- C. Thêm sort key vào bảng gốc.
- D. Tạo bảng mới và copy dữ liệu.

**Đáp án: B.** GSI cho phép partition key (và sort key) **khác hoàn toàn** primary key của bảng gốc, và quan trọng là **tạo được sau khi bảng đã tồn tại và có dữ liệu**. GSI có RCU/WCU riêng và là eventually consistent. Phù hợp để query theo `status`.

- A sai vì LSI phải **chia sẻ cùng partition key** với bảng gốc (chỉ khác sort key) và **chỉ tạo được lúc tạo bảng**, không thêm sau được — không đáp ứng yêu cầu.
- C sai vì thêm sort key không cho phép query theo `status` như một partition key, và bạn không thể đổi key schema của bảng đã tồn tại.
- D sai vì tạo bảng mới + copy là tốn kém, gián đoạn, và không cần thiết khi GSI giải quyết được.

(Ôn lại: Chương 32)

---

## Câu 33 — Domain 4 (Troubleshooting)

Một ECS service trên Fargate liên tục bị task khởi động rồi dừng. Developer kiểm tra và thấy task không kéo được image từ Amazon ECR (lỗi pull image). Nguyên nhân quyền khả dĩ nhất là gì?

- A. Task role thiếu quyền `dynamodb:*`.
- B. Task execution role thiếu quyền pull ECR (`ecr:GetAuthorizationToken`, `ecr:BatchGetImage`...).
- C. Task definition thiếu environment variable.
- D. Container port không khớp ALB.

**Đáp án: B.** Trong ECS, **task execution role** là role mà ECS agent dùng để kéo image từ ECR và ghi log vào CloudWatch (khác với **task role** mà code ứng dụng dùng để gọi AWS service). Nếu execution role thiếu các quyền ECR (`ecr:GetAuthorizationToken`, `ecr:BatchCheckLayerAvailability`, `ecr:GetDownloadUrlForLayer`, `ecr:BatchGetImage`), task không pull được image và liên tục fail. Managed policy `AmazonECSTaskExecutionRolePolicy` cấp các quyền này.

- A sai vì `dynamodb:*` thuộc quyền runtime của task role cho code ứng dụng, không liên quan tới việc pull image.
- C sai vì thiếu env variable có thể làm container crash sau khi chạy, nhưng lỗi mô tả là **không pull được image** — xảy ra trước cả khi container start.
- D sai vì port mismatch ảnh hưởng health check/registration với ALB sau khi container chạy, không gây lỗi pull image.

(Ôn lại: Chương 17, 16)

---

---

## Câu 34–65

> Phần này tiếp nối nửa đầu (Câu 1–33). Cấu trúc mỗi câu giữ nguyên: tình huống "A developer needs to..." dịch sang tiếng Việt, 4 phương án A–D, sau đó là **Đáp án: X.** kèm giải thích vì sao đúng và vì sao từng phương án còn lại sai, cuối cùng là gợi ý chương ôn lại. Hãy tự làm hết câu rồi mới đọc đáp án — đừng nhìn lướt.

---

**Câu 34.** Một developer xây dựng API đọc rất nhiều cho profile người dùng. Dữ liệu nằm trong RDS PostgreSQL Multi-AZ. Dưới tải cao, ứng dụng đọc lặp đi lặp lại cùng một vài chục nghìn profile và độ trễ p99 tăng vọt do DB phải scan index liên tục. Developer cần giảm tải đọc và độ trễ với thay đổi code tối thiểu, chấp nhận dữ liệu trễ vài giây.

- A. Bật Multi-AZ failover để DB standby phục vụ đọc.
- B. Đặt một cụm Amazon ElastiCache for Redis trước DB theo pattern cache-aside (lazy loading) với TTL.
- C. Tăng kích thước instance RDS lên gấp đôi.
- D. Bật RDS Storage Auto Scaling.

**Đáp án: B.** ElastiCache for Redis với cache-aside (lazy loading) là pattern kinh điển cho read-heavy workload: ứng dụng đọc cache trước, miss thì query DB rồi ghi kết quả vào cache với TTL. Vài chục nghìn profile được đọc lặp lại là ứng viên hoàn hảo cho cache vì hit rate sẽ rất cao, giảm hẳn tải lên RDS và đưa độ trễ đọc xuống sub-millisecond. "Chấp nhận trễ vài giây" chính là tín hiệu TTL.

- A sai: standby của Multi-AZ KHÔNG phục vụ traffic đọc — nó chỉ đứng chờ failover. Muốn scale đọc trên RDS phải dùng Read Replica, nhưng replica vẫn không nhanh bằng cache và cần đổi connection string.
- C sai: scale-up tốn tiền liên tục và chỉ trì hoãn vấn đề, không giải quyết bản chất là đọc lặp.
- D sai: Storage Auto Scaling chỉ tăng dung lượng đĩa, không liên quan đến CPU/IO đọc.

(Ôn lại: Chương 9, Chương 8)

---

**Câu 35.** Một developer dùng ElastiCache for Redis để lưu session. Yêu cầu: nếu node chính fail, session không được mất và hệ thống tự bầu node mới làm primary. Cấu hình nào đáp ứng?

- A. Memcached cluster với nhiều node.
- B. Redis (cluster mode disabled) một node duy nhất.
- C. Redis với Multi-AZ và automatic failover bật, có ít nhất một replica.
- D. Redis với cluster mode enabled nhưng chỉ 1 shard, 0 replica.

**Đáp án: C.** Để dữ liệu session sống sót qua sự cố node và tự bầu primary mới, cần Redis có replica + Multi-AZ + automatic failover. Khi primary chết, một replica được promote tự động, ứng dụng vẫn truy cập qua primary endpoint.

- A sai: Memcached không có replication, không persistence — mất node là mất data.
- B sai: một node Redis không có replica nên không có failover; node chết là mất session.
- D sai: 0 replica thì không có gì để promote khi primary fail.

(Ôn lại: Chương 9)

---

**Câu 36.** Một developer cần phân giải tên miền `api.example.com` trỏ tới một Application Load Balancer. Yêu cầu: dùng tên gốc của zone (apex/zone root) `example.com` cũng trỏ tới ALB, không phát sinh phí truy vấn DNS cho các record này, và không hard-code IP.

- A. Tạo CNAME record cho cả `example.com` và `api.example.com` trỏ tới DNS name của ALB.
- B. Tạo Alias record (type A) cho `example.com` và `api.example.com` trỏ tới ALB.
- C. Đăng ký Elastic IP cho ALB rồi tạo A record trỏ tới IP đó.
- D. Tạo A record với TTL=0 trỏ tới IP hiện tại của ALB.

**Đáp án: B.** Route 53 Alias record cho phép map cả apex domain (`example.com`) lẫn subdomain tới một AWS resource như ALB, và Route 53 KHÔNG tính phí cho truy vấn alias trỏ tới AWS resource. Alias tự cập nhật khi IP của ALB thay đổi.

- A sai: chuẩn DNS không cho phép CNAME tại zone apex (`example.com`) vì apex đã có các record NS/SOA. Alias là giải pháp riêng của Route 53 cho vấn đề này.
- C sai: ALB không hỗ trợ gán Elastic IP (chỉ NLB mới có static/EIP). IP của ALB cũng thay đổi.
- D sai: hard-code IP của ALB là sai vì IP đó đổi liên tục; TTL=0 cũng tốn truy vấn.

(Ôn lại: Chương 10, Chương 6)

---

**Câu 37.** Một dịch vụ web đa vùng cần định tuyến người dùng tới endpoint gần nhất về mặt mạng để giảm độ trễ, đồng thời nếu endpoint một region bị down (theo health check) thì tự loại bỏ khỏi kết quả. Routing policy nào của Route 53 phù hợp nhất?

- A. Weighted routing với trọng số bằng nhau.
- B. Geolocation routing theo quốc gia người dùng.
- C. Latency-based routing kết hợp health check.
- D. Simple routing với nhiều giá trị IP.

**Đáp án: C.** Latency-based routing chọn endpoint cho độ trễ thấp nhất từ vị trí người dùng tới region, đúng yêu cầu "gần nhất về mạng". Gắn health check vào record để Route 53 loại endpoint unhealthy khỏi câu trả lời.

- A sai: weighted chia traffic theo tỉ lệ, không tối ưu độ trễ.
- B sai: geolocation định tuyến theo vị trí địa lý (quốc gia/châu lục), không phản ánh độ trễ mạng thực tế và khó xử lý vùng không khai báo.
- D sai: simple routing không hỗ trợ health check để loại endpoint hỏng (multivalue answer thì có health check nhưng không tối ưu latency).

(Ôn lại: Chương 10)

---

**Câu 38.** Một ứng dụng web chạy trên Auto Scaling Group sau ALB. Khi scale-in, các instance đang xử lý request dài (vài chục giây) bị terminate đột ngột làm rớt request của user. Developer cần đảm bảo instance hoàn thành request đang xử lý trước khi bị gỡ.

- A. Tăng health check grace period của ASG.
- B. Bật connection draining / deregistration delay trên target group và dùng lifecycle hook ASG khi terminate.
- C. Đổi termination policy sang OldestInstance.
- D. Bật cross-zone load balancing.

**Đáp án: B.** Deregistration delay (connection draining) của target group giữ kết nối hiện hữu cho tới khi hoàn thành (mặc định 300s) trước khi gỡ instance khỏi ALB. Kết hợp lifecycle hook `EC2_INSTANCE_TERMINATING` cho ASG để giữ instance ở trạng thái `Terminating:Wait` trong lúc xử lý nốt, sau đó complete hook.

- A sai: health check grace period chỉ cho instance thời gian khởi động trước khi bị đánh dấu unhealthy, không liên quan đến lúc terminate.
- C sai: termination policy chỉ quyết định CHỌN instance nào để gỡ, không giúp request đang chạy hoàn thành.
- D sai: cross-zone load balancing chỉ cân bằng tải giữa AZ, không liên quan graceful shutdown.

(Ôn lại: Chương 7, Chương 6)

---

**Câu 39.** Một ASG cần thêm node khi backlog của một SQS queue tăng và bớt node khi backlog giảm, giữ mỗi node xử lý khoảng một lượng message cố định. Cách scale nào đúng?

- A. Target tracking trên metric `CPUUtilization` = 50%.
- B. Target tracking trên custom metric backlog-per-instance (ApproximateNumberOfMessagesVisible / số instance InService).
- C. Scheduled scaling theo giờ.
- D. Simple scaling khi NetworkIn vượt ngưỡng.

**Đáp án: B.** Pattern chuẩn AWS: publish custom metric "backlog per instance" = số message visible chia cho số instance đang chạy, rồi target tracking giữ giá trị này ở mức mong muốn (ví dụ mỗi instance gánh 100 message). Đây là cách scale theo queue depth chính xác nhất.

- A sai: consumer SQS thường I/O-bound, CPU không phản ánh backlog; queue có thể đầy mà CPU thấp.
- C sai: scheduled scaling chỉ hợp khi tải có lịch dự đoán được, không phản ứng theo backlog thực.
- D sai: NetworkIn không phản ánh số message tồn đọng.

(Ôn lại: Chương 7, Chương 21)

---

**Câu 40.** Một trang web tĩnh trên S3 phục vụ toàn cầu cần giảm độ trễ và bảo vệ origin: chỉ CloudFront được phép đọc bucket, người dùng không truy cập trực tiếp S3. Cấu hình nào đúng và hiện đại nhất?

- A. Bật S3 static website hosting và để bucket public.
- B. Dùng CloudFront với Origin Access Control (OAC) và bucket policy chỉ cho phép service principal CloudFront.
- C. Tạo presigned URL cho từng object và phát cho user.
- D. Dùng CloudFront với origin là public S3 website endpoint.

**Đáp án: B.** Origin Access Control (OAC) là cơ chế hiện hành (thay thế OAI cũ) để CloudFront ký SigV4 truy cập S3; bucket được giữ private và bucket policy chỉ cho phép principal `cloudfront.amazonaws.com` với điều kiện source ARN của distribution. User chỉ vào được qua CloudFront.

- A sai: bucket public vi phạm yêu cầu "không truy cập trực tiếp S3" và không có CDN.
- C sai: presigned URL không phù hợp cho website tĩnh phục vụ ẩn danh số lượng lớn; phải sinh URL từng object, có hạn dùng.
- D sai: dùng website endpoint buộc bucket phải public, mất khả năng khoá origin bằng OAC (website endpoint không hỗ trợ OAC/SigV4).

(Ôn lại: Chương 15, Chương 14)

---

**Câu 41.** Một ứng dụng dùng CloudFront trước API động. Developer vừa deploy bản fix nhưng client vẫn nhận nội dung cũ do bị cache ở edge. Cần ép CloudFront lấy lại nội dung mới ngay cho một vài path cụ thể, nhanh nhất.

- A. Tạo invalidation cho các path bị ảnh hưởng (ví dụ `/api/config*`).
- B. Xoá rồi tạo lại distribution.
- C. Đổi TTL mặc định về 0 và đợi cache hết hạn.
- D. Đổi tên file để có URL mới (cache busting) — nhưng client đã hard-code URL cũ.

**Đáp án: A.** Invalidation buộc CloudFront xoá object khỏi cache edge ngay; chọn đúng path bị ảnh hưởng để lấy bản mới. Lưu ý 1.000 path invalidation/tháng miễn phí, vượt thì tính phí, và nên invalidation thưa.

- B sai: xoá/tạo lại distribution gây downtime lớn và mất thời gian propagate, hoàn toàn không cần thiết.
- C sai: hạ TTL chỉ áp dụng cho object lấy về SAU đó; object đã cache vẫn còn tới khi hết hạn — không "ngay".
- D sai: cache busting bằng đổi URL chỉ dùng khi kiểm soát được URL phía client; ở đây client hard-code URL cũ nên không hiệu lực.

(Ôn lại: Chương 15)

---

**Câu 42.** Một developer cần chạy logic AWS theo lịch cron mỗi ngày 02:00 UTC để dọn dữ liệu, không muốn quản lý server. Cách ít vận hành nhất?

- A. EC2 với crontab.
- B. EventBridge Scheduler (hoặc rule schedule expression) trigger một Lambda function.
- C. Một Lambda tự gọi lại bằng `setTimeout`.
- D. CodeBuild project chạy bằng tay mỗi sáng.

**Đáp án: B.** EventBridge cho phép tạo rule với schedule expression (`cron(0 2 * * ? *)`) hoặc dùng EventBridge Scheduler, target là Lambda. Hoàn toàn serverless, không cần server, có retry và DLQ.

- A sai: phải quản lý EC2 (patch, chi phí 24/7) cho một job mỗi ngày — overhead cao.
- C sai: Lambda timeout tối đa 15 phút và execution kết thúc là dừng; không thể "ngủ" tới hôm sau.
- D sai: chạy tay mỗi sáng không phải tự động hoá.

(Ôn lại: Chương 25)

---

**Câu 43.** Hệ thống e-commerce phát event `OrderPlaced`. Nhiều dịch vụ (inventory, billing, analytics) cần nhận event này, mỗi dịch vụ lọc theo loại sự kiện riêng và có thể thêm consumer mới sau này mà không sửa producer. Kiến trúc nào phù hợp nhất?

- A. SQS queue duy nhất cho mọi consumer cùng poll.
- B. EventBridge custom event bus với nhiều rule, mỗi rule có event pattern lọc và target riêng.
- C. Kinesis Data Stream với mỗi consumer đọc cùng shard.
- D. Gọi trực tiếp HTTP tới từng dịch vụ từ producer.

**Đáp án: B.** EventBridge custom bus là lựa chọn cho event-driven nhiều consumer dạng "thêm tự do": producer chỉ PutEvents một lần, mỗi consumer tạo rule riêng với event pattern lọc (ví dụ `detail-type: OrderPlaced`, `detail.region: ...`) và target tới Lambda/SQS của mình. Thêm consumer = thêm rule, không đụng producer.

- A sai: một SQS queue chỉ giao mỗi message cho MỘT consumer (cạnh tranh), không fan-out; lọc theo loại cũng không native.
- C sai: Kinesis hợp cho streaming throughput cao theo thứ tự, không phải routing/filter theo nội dung nhiều consumer độc lập; quản lý shard phức tạp hơn.
- D sai: gọi HTTP trực tiếp gây coupling chặt — thêm consumer phải sửa producer, không có buffering/retry tốt.

(Ôn lại: Chương 25, Chương 22)

---

**Câu 44.** Một developer cần lưu mật khẩu DB cho RDS và phải tự động xoay vòng (rotate) định kỳ 30 ngày, có sẵn rotation cho RDS mà không phải tự viết logic. Dịch vụ nào?

- A. SSM Parameter Store SecureString.
- B. AWS Secrets Manager với managed rotation cho RDS.
- C. Biến môi trường Lambda mã hoá bằng KMS.
- D. S3 object mã hoá SSE-KMS.

**Đáp án: B.** Secrets Manager hỗ trợ rotation tự động có sẵn (managed rotation) cho RDS/Aurora/Redshift/DocumentDB: bật rotation, đặt chu kỳ (ví dụ 30 ngày), Secrets Manager dùng Lambda rotation do AWS cung cấp để đổi mật khẩu cả ở DB lẫn secret. Đây là đặc tính phân biệt chính so với Parameter Store.

- A sai: Parameter Store KHÔNG có rotation tích hợp; phải tự xây bằng EventBridge + Lambda.
- C sai: biến môi trường Lambda không rotate được và không nên chứa secret nhạy cảm dài hạn.
- D sai: S3 không phải kho secret và không có rotation.

(Ôn lại: Chương 47)

---

**Câu 45.** Một ứng dụng cần đọc nhiều tham số cấu hình không nhạy cảm theo cấu trúc phân cấp `/app/prod/...` với chi phí thấp nhất và một lần gọi lấy được cả nhánh. Lựa chọn nào tối ưu chi phí?

- A. Secrets Manager, một secret cho mỗi tham số.
- B. SSM Parameter Store standard tier, dùng `GetParametersByPath` với hierarchy.
- C. DynamoDB table tra cứu từng key.
- D. Hard-code trong code và deploy lại khi đổi.

**Đáp án: B.** Parameter Store standard tier miễn phí cho lưu trữ tham số và hỗ trợ hierarchy; `GetParametersByPath /app/prod/ --recursive` lấy cả nhánh trong một lần gọi. Đây là lựa chọn rẻ nhất cho config không nhạy cảm.

- A sai: Secrets Manager tính phí mỗi secret/tháng và mỗi 10.000 API call — đắt cho config thường, thừa tính năng rotation.
- C sai: DynamoDB thêm chi phí và độ phức tạp; không có khái niệm hierarchy path native như Parameter Store.
- D sai: hard-code khiến đổi config phải redeploy, vi phạm tách config khỏi code.

(Ôn lại: Chương 47)

---

**Câu 46.** Một developer triển khai Lambda function mới qua alias `prod`. Yêu cầu: dịch 10% traffic sang version mới trong 5 phút, nếu CloudWatch alarm báo lỗi thì tự rollback về version cũ. Cấu hình nào đạt được?

- A. Publish version mới và trỏ thẳng alias `prod` 100% sang version mới.
- B. CodeDeploy với deployment config canary (10% rồi 100%) trên Lambda alias, gắn CloudWatch alarm để auto-rollback.
- C. Tạo Lambda thứ hai và đổi DNS thủ công.
- D. Dùng provisioned concurrency cho version mới.

**Đáp án: B.** CodeDeploy hỗ trợ traffic shifting cho Lambda alias theo kiểu canary/linear (ví dụ `Canary10Percent5Minutes`): chuyển 10% trong 5 phút rồi 100%. Gắn CloudWatch alarm (ví dụ Errors > 0) vào deployment group để CodeDeploy tự rollback nếu alarm kích hoạt. SAM cấu hình điều này qua `DeploymentPreference`.

- A sai: trỏ thẳng 100% là big-bang, không canary, không auto-rollback theo alarm.
- C sai: Lambda alias không dùng DNS; đổi DNS thủ công không áp dụng và không tự động.
- D sai: provisioned concurrency chỉ giảm cold start, không liên quan đến traffic shifting hay rollback.

(Ôn lại: Chương 41, Chương 36, Chương 29)

---

**Câu 47.** Một pipeline CodePipeline build và deploy ứng dụng. Source là GitHub. Developer muốn pipeline tự chạy ngay khi có commit, không dùng cơ chế polling tốn thời gian và không lỡ commit. Cấu hình nào đúng?

- A. Dùng CodeStar connection (GitHub) — webhook/EventBridge tự kích hoạt pipeline khi có thay đổi.
- B. Bật polling mỗi 60 giây trên source action.
- C. Chạy pipeline bằng tay sau mỗi commit.
- D. Đặt scheduled rule kích hoạt pipeline mỗi 5 phút.

**Đáp án: A.** Source action GitHub qua CodeStar connection dùng webhook/EventBridge để kích hoạt pipeline gần như tức thì khi có commit — không polling, không lỡ commit. Đây là cách AWS khuyến nghị hiện nay.

- B sai: polling có độ trễ và bị giới hạn tần suất, kém hiệu quả; AWS khuyến nghị event-based.
- C sai: chạy tay không phải CI/CD tự động.
- D sai: scheduled rule kích hoạt theo giờ, không phản ứng theo commit, có thể chạy thừa hoặc trễ.

(Ôn lại: Chương 42)

---

**Câu 48.** Trong một buildspec.yml của CodeBuild, developer cần inject một API key bí mật vào biến môi trường lúc build, không để lộ trong log và không hard-code. Cách đúng?

- A. Ghi key trực tiếp trong section `env/variables` của buildspec.
- B. Dùng `env/secrets-manager` (hoặc `parameter-store`) tham chiếu tới secret/parameter, CodeBuild tự lấy lúc build.
- C. Truyền key qua artifact của stage trước.
- D. Lưu key trong file `.env` commit vào repo.

**Đáp án: B.** CodeBuild buildspec hỗ trợ `env/secrets-manager` và `env/parameter-store` để map biến môi trường tới secret trong Secrets Manager hoặc parameter trong SSM; giá trị được nạp lúc runtime và CodeBuild che (mask) trong log. IAM role của project cần quyền đọc.

- A sai: `variables` là plaintext, lộ trong console và log.
- C sai: truyền qua artifact không phải cơ chế quản lý secret và dễ lộ.
- D sai: commit `.env` chứa secret vào repo là lỗi bảo mật nghiêm trọng.

(Ôn lại: Chương 40, Chương 47)

---

**Câu 49.** Một frontend cần một API GraphQL cho mobile app: truy vấn linh hoạt nhiều bảng, có real-time subscription khi dữ liệu đổi, backend là DynamoDB, ít vận hành. Dịch vụ nào phù hợp nhất?

- A. API Gateway REST API + Lambda cho mỗi endpoint.
- B. AWS AppSync với data source DynamoDB và subscription qua WebSocket.
- C. ALB + ECS chạy GraphQL server tự quản.
- D. CloudFront + S3 phục vụ GraphQL.

**Đáp án: B.** AppSync là dịch vụ GraphQL managed: định nghĩa schema, gắn resolver tới DynamoDB (JS resolver hoặc VTL), và hỗ trợ subscription real-time qua WebSocket sẵn có. Ít vận hành nhất cho yêu cầu GraphQL + real-time.

- A sai: REST không phải GraphQL; muốn truy vấn linh hoạt và subscription phải tự xây nhiều, overhead lớn.
- C sai: tự chạy GraphQL server trên ECS = quản lý hạ tầng, ngược yêu cầu "ít vận hành".
- D sai: CloudFront + S3 phục vụ nội dung tĩnh, không xử lý GraphQL/subscription.

(Ôn lại: Chương 44, Chương 34)

---

**Câu 50.** Một AppSync API dùng để mobile app gọi. Yêu cầu xác thực: user đăng nhập bằng Cognito User Pool, và mỗi field có thể giới hạn theo group của user. Authorization mode nào phù hợp?

- A. API key cho mọi request.
- B. AWS_IAM với SigV4.
- C. Amazon Cognito User Pools authorization mode.
- D. Không cần auth, để public.

**Đáp án: C.** AppSync hỗ trợ Cognito User Pools làm authorization mode: token JWT từ User Pool được validate, và có thể dùng group claims với directive `@aws_auth(cognito_groups: [...])` để giới hạn truy cập theo group ở mức field/type.

- A sai: API key chỉ hợp cho truy cập public/demo có hạn dùng, không gắn danh tính user hay group.
- B sai: IAM/SigV4 hợp cho service-to-service hoặc Identity Pool credentials, không tự nhiên cho user đăng nhập bằng username/password và phân quyền theo group claim.
- D sai: để public vi phạm yêu cầu xác thực.

(Ôn lại: Chương 44, Chương 38)

---

**Câu 51.** Một developer build container image trong CodeBuild và cần push lên Amazon ECR private repository, sau đó ECS Fargate kéo image về chạy. Việc cấu hình nào là BẮT BUỘC để push thành công?

- A. Bật public access cho repository.
- B. `aws ecr get-login-password | docker login` (xác thực ECR) và IAM role của CodeBuild có quyền `ecr:PutImage`, `ecr:UploadLayerPart`, `BatchCheckLayerAvailability`, `GetAuthorizationToken`.
- C. Đặt image vào S3 rồi cấu hình ECS đọc từ S3.
- D. Chỉ cần `docker push`, ECR không yêu cầu xác thực.

**Đáp án: B.** Push lên ECR cần lấy token xác thực (`aws ecr get-login-password` rồi `docker login`) và IAM role có các quyền ECR cần thiết (`GetAuthorizationToken`, `BatchCheckLayerAvailability`, `InitiateLayerUpload`, `UploadLayerPart`, `CompleteLayerUpload`, `PutImage`). Đây là quy trình chuẩn.

- A sai: không cần public; repo private là đúng cho image nội bộ.
- C sai: ECS Fargate kéo image từ registry (ECR), không từ S3 theo cách đó.
- D sai: ECR luôn yêu cầu xác thực, không push ẩn danh được.

(Ôn lại: Chương 16, Chương 17, Chương 40)

---

**Câu 52.** Một Lambda trong VPC cần gọi DynamoDB và S3 mà không đi ra internet (không NAT Gateway, để tiết kiệm chi phí và giữ traffic private). Cấu hình nào đúng?

- A. Thêm NAT Gateway cho subnet của Lambda.
- B. Tạo Gateway VPC Endpoint cho S3 và DynamoDB, cập nhật route table của subnet.
- C. Gán Elastic IP cho Lambda.
- D. Tạo Interface Endpoint (PrivateLink) cho S3 và DynamoDB.

**Đáp án: B.** S3 và DynamoDB hỗ trợ Gateway VPC Endpoint (miễn phí), thêm vào route table của subnet để traffic tới hai dịch vụ này đi private qua endpoint thay vì internet. Đúng nhu cầu private + tiết kiệm (NAT Gateway tốn phí giờ + phí dữ liệu).

- A sai: NAT Gateway cho phép ra internet nhưng tốn phí và không phải traffic private tới AWS service; trái yêu cầu.
- C sai: Lambda không gán Elastic IP; và ở đây mục tiêu là private, không ra internet.
- D sai: S3 và DynamoDB dùng GATEWAY endpoint, không phải interface endpoint (interface endpoint tốn phí và dùng cho phần lớn dịch vụ KHÁC; S3 nay có cả interface endpoint nhưng gateway là lựa chọn rẻ và đúng kinh điển cho cặp S3/DynamoDB).

(Ôn lại: Chương 11, Chương 29)

---

**Câu 53.** Một nhóm container ECS chạy trên nhiều task ở nhiều AZ cần một hệ thống file dùng chung, đọc/ghi đồng thời, tự co giãn dung lượng, mount được vào tất cả task. Giải pháp nào?

- A. EBS volume gp3 multi-attach.
- B. Amazon EFS mount vào các task qua task definition.
- C. Instance Store của host EC2.
- D. S3 mount như filesystem bằng object key.

**Đáp án: B.** EFS là NFS shared file system, mount đồng thời từ nhiều task/AZ, đọc/ghi song song, tự co giãn dung lượng. ECS hỗ trợ EFS volume trong task definition (cả Fargate). Đúng cho shared storage đa AZ.

- A sai: EBS gắn theo một AZ; multi-attach chỉ trong cùng AZ và chỉ với io1/io2, không phải cơ chế chia sẻ đa AZ cho nhiều task tuỳ ý.
- C sai: Instance Store ephemeral, mất khi instance dừng và không chia sẻ giữa host.
- D sai: S3 là object store, không phải POSIX filesystem mount native; mục đích khác.

(Ôn lại: Chương 5, Chương 17)

---

**Câu 54.** Một developer cần Lambda function ghi log có cấu trúc và truy vấn nhanh các lỗi theo mẫu (ví dụ đếm số request có statusCode=500 trong 1 giờ) mà không dựng hệ thống log riêng. Cách nào?

- A. Ghi log ra /tmp rồi tải về phân tích.
- B. Dùng CloudWatch Logs Insights để truy vấn log group của Lambda, và/hoặc metric filter để tạo metric đếm 500.
- C. Gửi log qua email mỗi lần lỗi.
- D. Tắt logging để tiết kiệm.

**Đáp án: B.** Log của Lambda tự vào CloudWatch Logs. CloudWatch Logs Insights cho phép truy vấn ad-hoc (lọc, đếm, stats theo thời gian). Để theo dõi liên tục, tạo metric filter trên pattern (ví dụ `statusCode=500`) thành CloudWatch metric rồi đặt alarm.

- A sai: /tmp là ephemeral và cục bộ từng execution; không tổng hợp được.
- C sai: email mỗi lỗi gây spam, không truy vấn/đếm theo cửa sổ thời gian được.
- D sai: tắt log làm mất khả năng quan sát — sai hoàn toàn.

(Ôn lại: Chương 25, Chương 24)

---

**Câu 55.** Một API Gateway REST API gọi Lambda. Developer thấy độ trễ p99 cao bất thường và muốn biết thời gian nằm ở đâu (API Gateway, Lambda hay downstream DynamoDB). Công cụ nào cho cái nhìn end-to-end theo từng request?

- A. CloudTrail event history.
- B. Bật AWS X-Ray active tracing trên API Gateway và Lambda, xem service map và trace.
- C. VPC Flow Logs.
- D. S3 access logs.

**Đáp án: B.** X-Ray cung cấp distributed tracing: bật active tracing cho API Gateway stage và Lambda, instrument SDK để trace call tới DynamoDB. Service map và trace chia nhỏ thời gian theo segment/subsegment, chỉ ra nút thắt cổ chai.

- A sai: CloudTrail ghi API quản trị (ai gọi gì), không đo độ trễ từng request ứng dụng.
- C sai: VPC Flow Logs ghi metadata traffic mạng, không phân tích latency tầng ứng dụng.
- D sai: S3 access logs không liên quan đến API/Lambda latency.

(Ôn lại: Chương 26, Chương 35)

---

**Câu 56.** Một bảng DynamoDB cần truy vấn theo một attribute không phải partition key (ví dụ tìm tất cả order theo `customerId` trong khi primary key là `orderId`). Cách hiệu quả nhất, tránh Scan toàn bảng?

- A. Dùng Scan với FilterExpression theo `customerId`.
- B. Tạo Global Secondary Index (GSI) với partition key `customerId` rồi Query trên GSI.
- C. Tạo Local Secondary Index (LSI) với partition key `customerId`.
- D. Bật DAX để Scan nhanh hơn.

**Đáp án: B.** GSI cho phép một partition key (và sort key) khác bảng gốc — đặt `customerId` làm partition key của GSI rồi Query để lấy mọi order của một khách hàng, không cần Scan. GSI có throughput riêng và là eventually consistent.

- A sai: Scan đọc toàn bảng rồi mới lọc — tốn RCU và chậm; tránh trên dữ liệu lớn.
- C sai: LSI phải DÙNG CHUNG partition key với bảng gốc (`orderId`), chỉ đổi sort key — không giải quyết truy vấn theo `customerId`. LSI cũng chỉ tạo được lúc tạo bảng.
- D sai: DAX cache đọc nhưng không thay đổi bản chất Scan tốn kém; truy vấn theo attribute khác vẫn cần index.

(Ôn lại: Chương 32, Chương 31)

---

**Câu 57.** Một bảng DynamoDB cần đảm bảo hai người dùng không vô tình ghi đè lên nhau khi cùng cập nhật một item (cập nhật chỉ thành công nếu phiên bản chưa đổi). Kỹ thuật nào?

- A. Strongly consistent read trước khi ghi.
- B. Optimistic locking: thêm attribute `version`, dùng `ConditionExpression` kiểm tra version khớp khi UpdateItem.
- C. Bật DynamoDB Streams.
- D. Tăng WCU.

**Đáp án: B.** Optimistic locking: mỗi item có `version`; khi cập nhật, gửi `ConditionExpression: version = :expected` và tăng version. Nếu ai đó đã đổi item (version khác), điều kiện fail (`ConditionalCheckFailedException`) và client phải đọc lại rồi thử lại. Đây là cách chống lost update chuẩn của DynamoDB.

- A sai: strongly consistent read chỉ đảm bảo đọc giá trị mới nhất tại thời điểm đọc, không ngăn được ghi đè giữa hai client xảy ra sau đó.
- C sai: Streams ghi nhận thay đổi, không thực thi điều kiện ghi.
- D sai: tăng WCU chỉ tăng throughput, không liên quan đến tính nhất quán logic.

(Ôn lại: Chương 32)

---

**Câu 58.** Một REST API Gateway cần áp giới hạn 100 request/giây và 1.000.000 request/tháng cho mỗi khách hàng, phân biệt khách hàng qua API key. Cấu hình đúng theo thứ tự là gì?

- A. Tạo API key, gắn trực tiếp throttle vào key.
- B. Tạo Usage Plan (đặt throttle & quota), gắn API stage vào plan, tạo API key và associate key với usage plan.
- C. Bật WAF rate-based rule cho mỗi khách hàng.
- D. Đặt throttle ở account level cho toàn bộ.

**Đáp án: B.** Quy trình kinh điển DVA: tạo Usage Plan (cấu hình rate/burst throttle + quota tháng), gắn stage của API vào plan, tạo API key, rồi associate API key với usage plan. Method phải bật "API Key Required". Throttle và quota áp theo key qua usage plan.

- A sai: throttle/quota không gắn trực tiếp vào API key; phải qua usage plan.
- C sai: WAF rate-based rule giới hạn theo IP, không theo API key từng khách hàng, và không có quota tháng kiểu này.
- D sai: account-level throttle áp chung cho toàn account, không phân biệt từng khách hàng.

(Ôn lại: Chương 35)

---

**Câu 59.** Một Lambda được gọi đồng bộ qua API Gateway. Khi traffic tăng đột biến, client nhận lỗi 429 và Lambda bị throttle. Developer cần đảm bảo function quan trọng này luôn có một lượng concurrency dành riêng, không bị các function khác trong account "ăn" hết.

- A. Tăng memory của function.
- B. Cấu hình reserved concurrency cho function đó.
- C. Bật provisioned concurrency = 0.
- D. Bật X-Ray.

**Đáp án: B.** Reserved concurrency đặt một phần concurrency của account dành riêng cho function — đảm bảo function luôn có sẵn lượng concurrency này và đồng thời giới hạn trần của nó. Function khác không thể chiếm phần reserved này.

- A sai: tăng memory tăng CPU/throughput mỗi invocation nhưng không bảo lưu concurrency.
- C sai: provisioned concurrency giảm cold start (khởi tạo sẵn), nhưng =0 thì vô nghĩa; nó không phải cơ chế bảo lưu concurrency khỏi function khác.
- D sai: X-Ray để trace, không liên quan throttling concurrency.

(Ôn lại: Chương 29)

---

**Câu 60.** Một Lambda consumer đọc từ SQS standard queue qua event source mapping. Một số message lỗi liên tục khiến cả batch bị xử lý lại nhiều lần, làm nghẽn. Developer muốn message lỗi sau N lần được chuyển sang nơi khác để điều tra, không chặn message tốt.

- A. Tăng visibility timeout lên 12 giờ.
- B. Cấu hình Dead Letter Queue (DLQ) trên queue với `maxReceiveCount`, và bật partial batch response để chỉ retry message lỗi.
- C. Xoá queue và tạo lại.
- D. Đặt batch size = 1 và bỏ qua DLQ.

**Đáp án: B.** DLQ với redrive policy (`maxReceiveCount`) chuyển message vượt quá số lần nhận sang DLQ để điều tra, không kẹt queue chính. Với Lambda + SQS, bật partial batch response (`ReportBatchItemFailures`) để chỉ trả lại các message lỗi, không reprocess toàn batch.

- A sai: tăng visibility timeout chỉ trì hoãn message hiện lại, không tách message độc và không có nơi chứa lỗi.
- C sai: xoá/tạo lại queue làm mất message và không giải quyết bản chất.
- D sai: batch size=1 giảm hiệu năng và vẫn retry vô hạn message lỗi nếu thiếu DLQ.

(Ôn lại: Chương 30, Chương 21)

---

**Câu 61.** Một ứng dụng cần lưu file người dùng tải lên (vài MB tới vài trăm MB) rồi cho phép tải về, với độ bền cao và chi phí thấp. Đồng thời cần cho phép upload trực tiếp từ trình duyệt mà không qua server backend. Cách nào đúng?

- A. Lưu file vào DynamoDB item.
- B. Lưu vào S3; backend tạo presigned URL (PUT) để trình duyệt upload trực tiếp lên S3, presigned URL (GET) để tải về.
- C. Lưu file vào RDS BLOB column.
- D. Lưu file vào EFS và expose qua public IP.

**Đáp án: B.** S3 là nơi đúng cho object lớn với độ bền 11 số 9 và chi phí thấp. Presigned URL cho phép client upload/download trực tiếp tới S3, giảm tải backend và không cần lộ credentials. Backend chỉ ký URL có hạn dùng.

- A sai: DynamoDB item tối đa 400 KB — không chứa file vài MB+; pattern đúng là lưu metadata ở DynamoDB, file ở S3.
- C sai: lưu BLOB lớn trong RDS tốn kém, phình DB, hại hiệu năng.
- D sai: EFS không nên expose public và không hợp pattern upload trực tiếp từ trình duyệt theo cách này.

(Ôn lại: Chương 12, Chương 14)

---

**Câu 62.** Một developer cần cập nhật một CloudFormation stack đang chạy production và muốn xem trước chính xác những tài nguyên nào bị tạo/sửa/xoá trước khi áp dụng, tránh thay đổi ngoài ý muốn (như thay thế DB). Công cụ nào?

- A. Chạy `update-stack` thẳng và theo dõi events.
- B. Tạo Change Set, xem danh sách thay đổi rồi mới execute.
- C. Bật drift detection.
- D. Xoá stack rồi tạo lại.

**Đáp án: B.** Change Set hiển thị trước các thay đổi (Add/Modify/Remove) và quan trọng là cờ "Replacement" cho biết tài nguyên nào sẽ bị thay thế (ví dụ đổi thuộc tính bất biến của RDS). Review rồi mới execute, an toàn cho production.

- A sai: `update-stack` thẳng áp dụng ngay, không có bước xem trước; rủi ro thay thế tài nguyên ngoài ý muốn.
- C sai: drift detection so sánh trạng thái thực tế với template, không dự đoán thay đổi của một update sắp tới.
- D sai: xoá/tạo lại gây mất dữ liệu và downtime — cực kỳ rủi ro với production.

(Ôn lại: Chương 20, Chương 19)

---

**Câu 63.** Một ứng dụng đọc secret từ Secrets Manager trong mỗi Lambda invocation, làm tăng độ trễ và số lần gọi API (có thể bị throttle, tăng phí). Developer cần giảm số lần gọi mà vẫn lấy được secret mới sau khi rotate. Cách tốt nhất?

- A. Gọi Secrets Manager trong handler mỗi lần như cũ.
- B. Dùng AWS Parameters and Secrets Lambda Extension (cache có TTL) hoặc cache secret trong biến ngoài handler với TTL hợp lý.
- C. Hard-code secret vào biến môi trường plaintext.
- D. Lưu secret trong /tmp.

**Đáp án: B.** Cache secret để giảm gọi API: dùng AWS Parameters and Secrets Lambda Extension (cache cục bộ qua HTTP localhost với TTL), hoặc cache trong biến global ngoài handler (tận dụng execution environment reuse) kèm TTL để vẫn refresh sau rotate. Giảm latency, chi phí và tránh throttle.

- A sai: gọi mỗi invocation chính là nguyên nhân của vấn đề.
- C sai: hard-code plaintext không an toàn và không nhận được giá trị mới sau rotate.
- D sai: /tmp ephemeral và không có cơ chế refresh/TTL chuẩn; cũng không an toàn hơn.

(Ôn lại: Chương 47, Chương 28)

---

**Câu 64.** Một Aurora cluster phục vụ ứng dụng có nhiều kết nối ngắn (Lambda mở/đóng connection liên tục) gây cạn connection pool và lỗi "too many connections". Developer cần gộp/quản lý connection mà ít sửa code, tăng khả năng chịu tải và hỗ trợ failover nhanh.

- A. Tăng `max_connections` lên rất cao.
- B. Đặt Amazon RDS Proxy trước Aurora và cho Lambda kết nối qua proxy endpoint.
- C. Chuyển sang một Aurora replica để đọc.
- D. Mở một connection toàn cục và chia sẻ giữa các Lambda.

**Đáp án: B.** RDS Proxy gộp (pool) và tái sử dụng connection tới DB, giảm áp lực khi hàng nghìn Lambda mở connection, đồng thời rút ngắn thời gian failover và quản lý credentials qua Secrets Manager. Lambda chỉ đổi endpoint sang proxy — ít sửa code.

- A sai: tăng `max_connections` tiêu tốn bộ nhớ DB và chỉ trì hoãn vấn đề, không pool connection.
- C sai: replica để scale đọc, không giải quyết bùng nổ connection từ Lambda.
- D sai: Lambda execution environment độc lập, không chia sẻ connection toàn cục giữa các môi trường; cách này không khả thi và dễ rò rỉ.

(Ôn lại: Chương 8, Chương 29)

---

**Câu 65.** Một developer cần mã hoá at-rest cho dữ liệu nhạy cảm trong S3 và muốn kiểm soát chi tiết ai được phép giải mã (qua key policy + IAM), có audit mỗi lần dùng key qua CloudTrail. Lựa chọn mã hoá nào đáp ứng?

- A. SSE-S3 (khoá do S3 quản lý hoàn toàn).
- B. SSE-KMS với customer managed key (CMK).
- C. Không mã hoá, dựa vào bucket policy.
- D. SSE-C (client cung cấp key mỗi request).

**Đáp án: B.** SSE-KMS với customer managed key cho phép kiểm soát truy cập giải mã chi tiết qua key policy kết hợp IAM, và mỗi lần Encrypt/Decrypt/GenerateDataKey đều được ghi vào CloudTrail để audit. Đáp ứng đủ "kiểm soát ai giải mã" + "audit".

- A sai: SSE-S3 mã hoá nhưng khoá do AWS quản lý hoàn toàn — không có key policy riêng để kiểm soát chi tiết hay audit từng lần dùng key.
- C sai: không mã hoá vi phạm yêu cầu at-rest.
- D sai: SSE-C buộc client tự quản lý và gửi key mỗi request, không có key policy/CloudTrail của KMS; vận hành nặng và không đáp ứng nhu cầu audit qua KMS.

(Ôn lại: Chương 14, Chương 46)

---

## Bảng phân bố câu hỏi theo domain

Đề DVA-C02 thực tế có 65 câu, phân bố 4 domain: **Development with AWS Services (32%)**, **Security (26%)**, **Deployment (24%)**, **Troubleshooting & Optimization (18%)**. Bộ đề mô phỏng này (Câu 1–65, gộp cả nửa đầu và nửa sau) bám sát tỉ lệ đó. Bảng dưới map từng câu vào domain để bạn biết mình yếu mảng nào. (Các câu 1–33 thuộc nửa đầu; mapping dưới đây phản ánh phân bố tổng thể của cả đề.)

| Domain | Số câu (mục tiêu) | Câu hỏi tiêu biểu (nửa sau) |
|---|---|---|
| **1. Development with AWS Services (≈32%, ~21 câu)** | 21 | 34, 35, 39, 43, 49, 50, 51, 53, 56, 57, 61, 64 |
| **2. Security (≈26%, ~17 câu)** | 17 | 40, 44, 45, 48, 50, 52, 58, 65 |
| **3. Deployment (≈24%, ~15 câu)** | 15 | 42, 46, 47, 48, 51, 62 |
| **4. Troubleshooting & Optimization (≈18%, ~12 câu)** | 12 | 36, 37, 38, 41, 54, 55, 59, 60, 63 |

Lưu ý: nhiều câu giao thoa hai domain (ví dụ Câu 65 vừa là Security vừa là Development). Khi tự phân loại, hãy gán câu vào domain mà "ý chính" của câu kiểm tra. Phân bố mục tiêu theo từng domain (21/17/15/12) là con số tròn xấp xỉ tỉ lệ phần trăm chính thức của AWS trên tổng ~65 câu.

Gợi ý chi tiết theo domain (dùng để truy ngược chương khi sai):

- **Domain 1 – Development:** Lambda (Ch28–30), DynamoDB (Ch31–33), API Gateway (Ch34–35), SQS/SNS/Kinesis (Ch21–23), Step Functions (Ch43), AppSync (Ch44), ElastiCache (Ch9), ECR/ECS (Ch16–17).
- **Domain 2 – Security:** IAM (Ch2), Cognito (Ch38–39), KMS (Ch46), Secrets Manager/Parameter Store (Ch47), S3 security (Ch14), STS/federation (Ch45), VPC endpoints (Ch11).
- **Domain 3 – Deployment:** CloudFormation/SAM/CDK (Ch19–20, 36–37), CodeBuild/CodeDeploy/CodePipeline (Ch40–42), Elastic Beanstalk (Ch18), ECS deploy (Ch17).
- **Domain 4 – Troubleshooting & Optimization:** CloudWatch Metrics/Logs (Ch24–25), X-Ray (Ch26), CloudTrail (Ch27), tối ưu hiệu năng/độ trễ (Ch9, 15, 29, 33), ASG/ELB scaling (Ch6–7).

## Hướng dẫn tự chấm & đọc kết quả

Đề thật DVA-C02 có 65 câu nhưng chỉ **50 câu được tính điểm** (15 câu là câu thử nghiệm/unscored, bạn không biết câu nào), thang điểm scaled **100–1000**, **pass = 720**. Vì bộ đề này không phân biệt câu unscored, hãy quy đổi theo số câu đúng trên tổng 65.

Cách tính: đếm số câu trả lời đúng (X) trên 65, lấy tỉ lệ phần trăm `X/65 × 100%`.

| Số câu đúng / 65 | Tỉ lệ | Mức độ sẵn sàng | Hành động đề xuất |
|---|---|---|---|
| 56–65 | ≥ 86% | Rất sẵn sàng | Đặt lịch thi. Chỉ ôn lướt các câu sai và đọc Chương 50 (chiến lược làm bài). |
| 49–55 | 75–85% | Đủ ngưỡng đậu, nhưng mỏng | Có thể thi sau 1 tuần. Ôn kỹ 2 domain yếu nhất theo bảng trên trước khi thi. |
| 42–48 | 65–74% | Cận biên, rủi ro trượt | Chưa nên thi. Ôn lại toàn bộ các chương của domain bạn sai nhiều nhất, làm lại đề sau 1–2 tuần. |
| 33–41 | 51–64% | Chưa sẵn sàng | Quay lại học lý thuyết các phần yếu (đặc biệt Serverless và Security — chiếm nhiều điểm), làm hands-on lab từng chương. |
| ≤ 32 | < 51% | Cần học lại nền tảng | Ôn tuần tự từ đầu giáo trình; ưu tiên Lambda, DynamoDB, IAM, API Gateway, CI/CD. |

**Đọc kết quả theo domain (quan trọng hơn tổng điểm):** AWS chấm pass/fail trên tổng, nhưng để chắc chắn, bạn nên đúng **≥ 70% trong MỖI domain**, không chỉ tổng. Một thí sinh đúng 80% tổng nhưng chỉ đúng 40% domain Security vẫn rất rủi ro vì câu hỏi thật có thể rơi nhiều vào điểm yếu đó.

Cách tự soi điểm yếu:

1. Phân loại các câu bạn SAI theo bảng domain phía trên.
2. Domain nào có tỉ lệ sai cao nhất → đó là ưu tiên ôn số một.
3. Với mỗi câu sai, mở đúng chương ghi trong dòng "(Ôn lại: Chương YY)" của câu đó, đọc lại section liên quan và làm lại hands-on lab ở part2 của chương.
4. Đặc biệt chú ý các cặp dễ nhầm mà đề hay gài: **Multi-AZ vs Read Replica** (Ch8), **Gateway vs Interface Endpoint** (Ch11), **LSI vs GSI** (Ch32), **reserved vs provisioned concurrency** (Ch29), **Parameter Store vs Secrets Manager** (Ch47), **SSE-S3 vs SSE-KMS vs SSE-C** (Ch14/46), **Alias vs CNAME** (Ch10), **canary/linear/all-at-once** trong CodeDeploy (Ch41), **SQS vs SNS vs EventBridge vs Kinesis** (Ch21–23, 25), **OAC vs OAI vs presigned URL** (Ch15).

**Mẹo lần làm lại:** đừng học thuộc đáp án. Sau khi sai, hãy diễn đạt lại bằng lời của bạn vì sao đáp án đúng đúng VÀ vì sao ba phương án kia sai — kỹ năng loại trừ này (chi tiết ở Chương 50) là thứ thực sự kéo điểm lên trong phòng thi, nơi câu chữ sẽ khác đề mô phỏng nhưng bản chất kỹ thuật thì không đổi.

Sau khi đạt ổn định ≥ 86% và đều các domain qua 2–3 lần làm đề khác nhau, hãy chuyển sang Chương 50 để nắm chiến lược thời gian, kỹ thuật flag câu, và các từ khoá nhận diện đáp án ("least operational overhead" → managed/serverless, "most cost-effective", "near real-time"...). Chúc bạn thi tốt.
