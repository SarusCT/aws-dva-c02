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
