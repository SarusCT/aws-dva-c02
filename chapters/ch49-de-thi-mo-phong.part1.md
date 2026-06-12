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
