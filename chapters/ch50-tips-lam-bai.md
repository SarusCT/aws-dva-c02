# Chương 50: Tips làm bài & chiến lược ôn tập

> **Trọng tâm DVA-C02:** Chương này không dạy thêm dịch vụ AWS nào — nó dạy cách *đọc đề* và *giành điểm*. Đề DVA-C02 hiếm khi hỏi định nghĩa thuần; nó cho một tình huống "A developer needs to..." rồi đưa 4 đáp án trong đó thường có 2-3 đáp án *về mặt kỹ thuật đều chạy được*, và bạn phải chọn cái khớp nhất với ràng buộc ẩn trong câu chữ (chi phí, độ trễ, công sức vận hành). Biết loại trừ và bắt từ khoá nhiều khi quan trọng hơn biết thêm một dịch vụ.

## Mục tiêu chương

- Hiểu chính xác cấu trúc đề DVA-C02: số câu, thời gian, câu unscored, thang điểm, ngưỡng đậu, và 4 domain hỏi gì.
- Có một chiến lược quản lý thời gian cụ thể cho 130 phút và biết khi nào nên flag câu hỏi.
- Thành thạo kỹ thuật loại trừ đáp án — biến câu 4 lựa chọn thành câu 2 lựa chọn rồi thành câu chắc chắn.
- Nhận diện được bộ từ khoá tín hiệu ("least operational overhead", "most cost-effective", "near real-time", "in transit/at rest"...) và suy ra ngay nhóm dịch vụ AWS muốn nghe.
- Nắm quy trình đăng ký thi, phân biệt thi online (Pearson VUE / PSI) với thi tại test center, và chuẩn bị để không bị loại vì lỗi kỹ thuật/quy chế.

> 💡 **Exam Tip:** Phần này (Chương 50) là chiến lược chung và kinh nghiệm thi. Bộ 65 câu mô phỏng đầy đủ kèm giải thích nằm ở Chương 49 — hãy làm Chương 49 *sau khi* đọc xong các kỹ thuật ở đây để áp dụng ngay. Bảng "cặp dịch vụ hay gài bẫy", lộ trình ôn 4 tuần / 8 tuần, checklist từng domain và lộ trình sau khi đậu nằm ở **nửa sau Chương 50** (part2).

## 50.1 Mổ xẻ cấu trúc đề DVA-C02

Trước khi bàn chiến thuật, phải hiểu rõ "luật chơi". Mọi con số dưới đây lấy theo *Exam Guide* chính thức của AWS cho mã đề **DVA-C02** (phiên bản đang hành dụng).

| Thuộc tính | Giá trị | Hệ quả khi làm bài |
|---|---|---|
| Tổng số câu | **65 câu** | Trong đó chỉ 50 câu tính điểm |
| Câu tính điểm (scored) | **50 câu** | Mỗi câu nặng như nhau; không có câu nào "nặng điểm" hơn |
| Câu thử nghiệm (unscored) | **15 câu** | AWS dùng để hiệu chỉnh đề tương lai, KHÔNG tính điểm — nhưng bạn KHÔNG biết câu nào là unscored nên phải làm hết |
| Thời gian | **130 phút** | ≈ 2 phút/câu nếu chia đều |
| Dạng câu | Multiple choice (1 đúng/4) & multiple response (2+ đúng/5+) | Câu multiple response yêu cầu chọn *đúng số lượng* được hỏi |
| Thang điểm | **100–1000** | Thang chuẩn hoá (scaled score), KHÔNG phải phần trăm thô |
| Ngưỡng đậu | **720/1000** | Là điểm "compensatory" — đậu/rớt tính trên tổng, không cần đậu từng domain |
| Phí thi | **150 USD** (associate-level) | Có voucher giảm 50% nếu đã đậu một chứng chỉ AWS trước đó |
| Ngôn ngữ | Có tiếng Anh, Nhật, Hàn, TQ giản thể... | DVA-C02 thường KHÔNG có tiếng Việt — chuẩn bị đọc đề tiếng Anh |
| Hiệu lực | **3 năm** | Recert miễn phí trước khi hết hạn |

Vài điểm thường bị hiểu sai, cần ghim chặt:

**Điểm là thang chuẩn hoá 100–1000, không phải phần trăm thô.** Bạn KHÔNG cần đúng 72% số câu để được 720 điểm. AWS dùng một mô hình quy đổi độ khó (mỗi đề có độ khó khác nhau, được "cân" lại để công bằng giữa các thí sinh thi các phiên bản đề khác nhau). Hệ quả thực dụng: đừng cố tự tính "mình làm được bao nhiêu câu thì đậu". Ước lượng an toàn trong thực tế là nhắm đúng khoảng **75–80%** số câu bạn *chắc chắn* để có biên an toàn, vì luôn có vài câu bạn tưởng đúng mà sai.

**15 câu unscored là "ẩn".** Bạn không có cách nào biết câu nào không tính điểm. Đừng phí thời gian đoán. Hệ quả: một câu cực kỳ lạ/khó bất thường *có thể* là câu thử nghiệm — nếu gặp câu kỳ quặc tới mức không giống bất kỳ dạng nào bạn ôn, đừng hoảng, cứ chọn đáp án hợp lý nhất rồi đi tiếp, rất có thể nó không tính điểm.

**Pass là compensatory.** Bạn có thể yếu hẳn một domain (ví dụ Troubleshooting) mà vẫn đậu nếu các domain khác bù lại. Bảng kết quả cuối chỉ ghi PASS/FAIL kèm điểm tổng; phần "section feedback" (Meets/Needs Improvement từng domain) chỉ mang tính tham khảo, KHÔNG phải điều kiện đậu riêng.

> 💡 **Exam Tip:** Câu "multiple response" (chọn 2 hoặc chọn 3) chấm theo kiểu *all-or-nothing* — chọn đúng 2/3 đáp án đúng vẫn 0 điểm câu đó. Đọc kỹ "(Choose TWO)" / "(Choose THREE)" và chọn đúng số lượng. Đừng chọn thiếu, cũng đừng chọn thừa.

### Bốn domain — trọng số và "hỏi gì"

DVA-C02 chia kiến thức thành 4 domain với trọng số cố định. Trọng số này quyết định bạn nên dồn thời gian ôn vào đâu.

| Domain | Trọng số | Nội dung cốt lõi hay hỏi |
|---|---|---|
| **1. Development with AWS Services** | **32%** | Viết code dùng Lambda, DynamoDB, API Gateway, SQS/SNS/Kinesis, Step Functions; idempotency; retry/backoff; SDK pagination; data store phù hợp; event-driven |
| **2. Security** | **26%** | IAM policy (least privilege), roles cho service, STS AssumeRole cross-account, KMS & envelope encryption, Secrets Manager vs Parameter Store, Cognito (User Pool vs Identity Pool), encryption in transit/at rest |
| **3. Deployment** | **24%** | CI/CD (CodePipeline/Build/Deploy), SAM/CloudFormation/CDK, Beanstalk deployment policies, blue/green & canary, Lambda versions/aliases & traffic shifting, container deploy ECS |
| **4. Troubleshooting & Optimization** | **18%** | Đọc CloudWatch Logs/Metrics/X-Ray, throttling (429/ProvisionedThroughputExceeded), cold start, DLQ, caching để tối ưu chi phí/độ trễ, root cause khi deploy fail |

Đọc bảng này theo hướng *đầu tư thời gian*: Domain 1 (Development, 32%) cộng Domain 2 (Security, 26%) chiếm gần **60%** đề. Nếu thời gian ôn có hạn, Lambda + DynamoDB + API Gateway + IAM + KMS/Secrets + Cognito là "xương sống" — nắm chắc 6 cụm này là đã chạm phần lớn số câu. Domain 4 chỉ 18% nhưng lại là phần *khó đoán* nhất vì nó trộn nhiều dịch vụ trong một tình huống debug.

> 💡 **Exam Tip:** Đề DVA-C02 là đề *developer*, không phải *architect*. Khi phân vân, nghiêng về đáp án liên quan đến **code/SDK/serverless/managed service** hơn là đáp án thiên về hạ tầng (đặt thêm EC2, tự dựng cluster, tự cài agent...). AWS muốn thấy bạn nghĩ như developer dùng dịch vụ được-quản-lý, không phải sysadmin dựng máy.

## 50.2 Quản lý thời gian & cơ chế flag câu hỏi

130 phút cho 65 câu = trung bình **2 phút/câu**. Nhưng đừng làm đều — phân bố thực tế nên là:

- **Pha 1 (lượt đầu, ~85–95 phút):** Đi tuần tự từ câu 1 đến 65. Với mỗi câu, đặt ngưỡng cứng **~75 giây**. Nếu trong 75 giây bạn đã ra đáp án chắc → chọn, đi tiếp. Nếu chưa → chọn đáp án "có vẻ đúng nhất" ngay lúc đó (để không bao giờ bỏ trống), **flag** câu đó, rồi đi tiếp NGAY. Tuyệt đối không sa lầy.
- **Pha 2 (lượt review, ~25–35 phút):** Quay lại các câu đã flag. Lúc này đầu óc đã "ấm", và quan trọng hơn: nhiều câu sau trong đề sẽ *gợi nhớ* hoặc thậm chí *tiết lộ* kiến thức giúp bạn trả lời câu trước. Xử lý từng câu flag, dùng kỹ thuật loại trừ (50.3) một cách bài bản.
- **Pha 3 (đệm, ~5–10 phút):** Soát nhanh toàn bộ để chắc chắn không có câu nào *bỏ trống* và các câu multiple-response đã chọn *đúng số lượng*.

Vì sao "luôn chọn một đáp án trước khi flag"? Vì DVA-C02 **không trừ điểm câu sai** (không có negative marking). Một câu bỏ trống và một câu sai cho cùng 0 điểm — nhưng câu bạn đã đoán thì có xác suất 25–50% đúng. Nguyên tắc sắt: **không bao giờ rời một câu mà chưa tô đáp án**, kể cả khi định flag để xem lại.

Cơ chế flag ("Mark for Review") có trong cả giao diện Pearson VUE và PSI: một checkbox/nút trên màn hình câu hỏi. Cuối bài có màn hình tổng quan (review screen) liệt kê tất cả câu, đánh dấu câu nào đã flag, câu nào *chưa trả lời* (incomplete). Dùng màn hình này ở Pha 3 để săn câu incomplete.

> 💡 **Exam Tip:** Đừng flag quá nhiều. Nếu bạn flag 30/65 câu, Pha 2 sẽ không đủ thời gian. Mục tiêu thực tế: flag khoảng **10–18 câu**. Câu nào bạn *chắc 90%* thì cứ chốt luôn ở Pha 1, đừng flag "cho chắc" — bạn sẽ không có thời gian xem lại hết.

**Đồng hồ và checkpoint thời gian.** Màn hình thi luôn hiển thị thời gian còn lại. Đặt 2 mốc kiểm tra trong đầu:
- Khi làm xong câu ~33 (nửa đề), đồng hồ nên còn **> 75 phút**. Nếu còn ít hơn, bạn đang quá chậm — siết ngưỡng 75 giây xuống 60 giây và bớt do dự.
- Khi xong lượt đầu (câu 65), nên còn **> 30 phút** cho review.

**Bẫy tâm lý về độ dài câu.** Câu DVA-C02 đôi khi có đoạn mở đầu rất dài mô tả kiến trúc (3-4 dòng). Mẹo: đọc **câu hỏi thật (dòng cuối, thường sau dấu hỏi)** TRƯỚC, rồi mới đọc lại phần mô tả với đúng thứ cần tìm. Ví dụ câu hỏi cuối là "...which solution requires the LEAST operational overhead?" — biết trước bạn đang săn từ khoá "least operational overhead" thì khi đọc thân câu bạn sẽ lọc thông tin nhanh hơn nhiều.

## 50.3 Kỹ thuật loại trừ đáp án (Process of Elimination)

Đây là kỹ năng *quan trọng nhất* để qua DVA-C02. Mục tiêu: từ 4 đáp án, loại 2 đáp án sai chắc chắn để còn xác suất 50%, rồi loại tiếp 1 để còn đáp án đúng. Dưới đây là các kỹ thuật cụ thể, mỗi cái kèm ví dụ.

### Kỹ thuật 1 — Loại đáp án sai về mặt kỹ thuật (technically impossible)

Tìm đáp án mô tả điều mà dịch vụ AWS *không làm được*. Đây là loại dễ gạch nhất nếu bạn nắm chắc giới hạn dịch vụ.

> **Ví dụ:** *Một developer cần lưu file 500 MB như payload cho mỗi message gửi vào hàng đợi để Lambda xử lý. Giải pháp nào phù hợp?*
> - A. Gửi thẳng file 500 MB vào SQS message — *loại ngay*: SQS giới hạn message **256 KB**, không thể.
> - B. Gửi thẳng 500 MB vào SNS rồi fan-out — *loại*: SNS cũng giới hạn 256 KB.
> - C. Upload file lên S3, gửi S3 object key (qua SQS Extended Client) vào SQS, Lambda đọc lại từ S3 — *đúng*.
> - D. Encode base64 file rồi nhét vào DynamoDB item — *loại*: DynamoDB item tối đa **400 KB**.

Chỉ cần nhớ 3 con số (SQS/SNS 256 KB, DynamoDB item 400 KB) là gạch được A, B, D mà không cần nghĩ thêm. Đây là lý do Chương các dịch vụ luôn nhấn mạnh limits — chúng là "dao mổ" loại đáp án.

### Kỹ thuật 2 — Loại đáp án vi phạm best practice rõ ràng

AWS có những "giáo điều" gần như tuyệt đối. Bất kỳ đáp án nào vi phạm chúng đều gần như chắc chắn sai:
- **Hardcode access key** trong code/EC2/Lambda → luôn sai. Đáp án đúng dùng **IAM Role**.
- **Lưu secret dạng plaintext** trong biến môi trường/code → sai. Đáp án đúng dùng **Secrets Manager / Parameter Store SecureString**.
- **Gán quyền `*:*` (admin)** cho một function chỉ cần đọc 1 bảng → sai (vi phạm least privilege).
- **Mở Security Group `0.0.0.0/0`** cho cổng DB → sai.

> **Ví dụ:** *Lambda cần đọc một bảng DynamoDB. Cách cấp quyền nào đúng?*
> - A. Tạo IAM user, sinh access key, đặt vào biến môi trường của Lambda — *loại* (hardcode credential).
> - B. Gắn IAM execution role cho Lambda với policy chỉ cho `dynamodb:GetItem`, `Query` trên đúng bảng đó — *đúng*.
> - C. Gắn policy `AdministratorAccess` cho Lambda role — *loại* (vi phạm least privilege).
> - D. Lưu credential vào S3 rồi Lambda tải về — *loại* (vẫn là quản lý credential thủ công + vòng vo).

### Kỹ thuật 3 — Loại đáp án "lạc đề" (right service, wrong job)

Đáp án nhắc đúng một dịch vụ AWS có thật và hợp lý *nói chung*, nhưng dùng sai vai trò trong tình huống này. Đây là loại bẫy tinh vi nhất.

> **Ví dụ:** *Cần lưu trace của một request đi qua API Gateway → Lambda → DynamoDB để tìm bottleneck độ trễ. Dùng gì?*
> - A. CloudTrail — *loại*: CloudTrail ghi *API call quản lý* (ai gọi gì), KHÔNG đo latency từng segment của một request ứng dụng.
> - B. X-Ray — *đúng*: distributed tracing, đo thời gian từng subsegment.
> - C. VPC Flow Logs — *loại*: ghi lưu lượng IP, không liên quan trace ứng dụng.
> - D. CloudWatch Logs Insights — *gần đúng nhưng không tối ưu*: query log được, nhưng không vẽ service map / không đo latency theo segment như X-Ray.

Cặp **CloudTrail vs X-Ray vs CloudWatch** là bẫy kinh điển. Bảng phân biệt đầy đủ các cặp như vậy nằm ở nửa sau chương này.

### Kỹ thuật 4 — Dùng từ khoá ràng buộc để chọn giữa các đáp án "đều đúng"

Khi đã loại còn 2 đáp án mà *cả hai đều chạy được*, hãy quay lại câu hỏi tìm **từ khoá ràng buộc** — đó chính là tín hiệu AWS dùng để tách hai đáp án. Đây là cầu nối sang mục 50.4.

> **Ví dụ:** *Cần chạy một job xử lý ảnh mỗi khi file upload lên S3, lưu lượng thất thường, muốn **least operational overhead**. Chọn gì giữa:*
> - C. Cấu hình S3 event notification trigger **Lambda** xử lý ảnh.
> - D. Cho một **EC2** instance trong ASG poll S3 list mỗi phút và xử lý.
>
> Cả hai *đều xử lý được ảnh*. Nhưng từ khoá **"least operational overhead"** + **"lưu lượng thất thường"** → chọn **C (Lambda)**: không quản server, tự scale theo event, trả tiền theo lượt. D phải quản EC2, patch OS, tự scale → nhiều overhead hơn.

### Kỹ thuật 5 — Cảnh giác với "từ tuyệt đối" và đáp án quá dài/quá phức tạp

- Đáp án chứa **"always", "never", "only", "all", "every"** có rủi ro sai cao hơn — thực tế AWS hiếm khi tuyệt đối. (Không phải luật cứng, nhưng là tín hiệu để soi kỹ.)
- Khi hai đáp án gần giống nhau, **khác biệt chỉ một chi tiết** → câu hỏi gần như chắc đang test đúng chi tiết đó. Tập trung vào điểm khác biệt.
- Đáp án mô tả một kiến trúc *cầu kỳ nhiều bước* trong khi đề hỏi "least overhead/simplest" → thường là mồi nhử. Nhưng cẩn thận: nếu đề hỏi "most secure" hoặc "most reliable", đôi khi đáp án phức tạp hơn lại đúng vì nó thêm lớp bảo vệ.

> 💡 **Exam Tip:** Nếu sau khi loại còn đúng 2 đáp án mà thực sự không phân biệt được, hãy chọn đáp án **"AWS-native / managed / serverless"** hơn là đáp án "tự làm/EC2/third-party". Thống kê kinh nghiệm: trong đề developer, đáp án thiên về dịch vụ được quản lý thắng nhiều hơn.

## 50.4 Từ khoá tín hiệu — đọc đề như đọc requirement của khách hàng

Mỗi câu DVA-C02 nhét vào một hoặc nhiều **từ khoá ràng buộc** (constraint keyword) — chính là tiêu chí mà đáp án đúng phải thoả. Học thuộc bộ từ khoá này và *ánh xạ* nó sang nhóm dịch vụ là cách tăng tốc lớn nhất. Dưới đây là bộ từ khoá quan trọng nhất, mỗi cái kèm: nó báo hiệu gì, câu hỏi mẫu, và cách suy luận.

### "least operational overhead" / "minimal management" / "fully managed"

**Báo hiệu:** AWS muốn đáp án **serverless / fully-managed**, tránh thứ bạn phải tự vận hành (patch OS, quản cluster, tự scale).

> **Câu mẫu:** *A developer needs to run a backend API with unpredictable traffic and wants the LEAST operational overhead.*
> **Suy luận:** "least operational overhead" + "unpredictable traffic" → **API Gateway + Lambda** (auto-scale, no server) thắng "ALB + EC2 trong ASG" hay "ECS trên EC2". Nếu trong các đáp án có cả **Fargate** và **EC2 launch type**, chọn Fargate (không quản EC2 host).

Ánh xạ nhanh khi gặp "least operational overhead":
- Compute → **Lambda > Fargate > EC2/ECS-on-EC2**
- Database → **DynamoDB / Aurora Serverless > RDS > self-managed DB trên EC2**
- Cache → **DAX / ElastiCache (managed) > tự dựng Redis trên EC2**
- ETL/stream → **Kinesis Data Firehose > tự quản consumer trên EC2**

### "most cost-effective" / "minimize cost" / "reduce cost"

**Báo hiệu:** Tối ưu *chi phí*, thường đối lập với "performance bằng mọi giá". Chú ý ngữ cảnh: chi phí compute, chi phí storage, hay chi phí truy vấn?

> **Câu mẫu:** *Logs được ghi liên tục nhưng chỉ truy vấn ad-hoc vài lần mỗi tháng. Lưu trữ và query sao cho cost-effective nhất?*
> **Suy luận:** ghi nhiều, query hiếm → đẩy log vào **S3** (rẻ) rồi query bằng **Athena** (trả tiền theo lượng data quét), thay vì giữ trong CloudWatch Logs đắt hoặc dựng OpenSearch luôn chạy.

Ánh xạ "cost-effective" thường gặp:
- Lưu data ít truy cập → **S3 Standard-IA / Glacier**, đặt **Lifecycle policy** chuyển class.
- Query data trong S3 không thường xuyên → **Athena** (pay-per-query) thay vì cụm phân tích luôn chạy.
- Workload chịu được gián đoạn, không gấp → **Spot Instances**.
- Traffic ổn định dài hạn → **Savings Plans / Reserved**, không phải On-Demand.
- Giảm read tốn kém lặp lại trên DynamoDB → **DAX**; trên RDS → **ElastiCache** / **Read Replica**.
- DynamoDB lưu lượng *không đoán được, có lúc bằng 0* → **on-demand**; lưu lượng *ổn định, đoán được* → **provisioned** (rẻ hơn nhiều ở mức tải đều).

> 💡 **Exam Tip:** "Cost-effective" + "spiky/unpredictable/intermittent" gần như luôn nghiêng về **pay-per-use** (Lambda, DynamoDB on-demand, Athena, Fargate). "Cost-effective" + "steady/predictable/24x7" nghiêng về **commitment** (Reserved, Savings Plans, DynamoDB provisioned).

### "real-time" vs "near real-time"

Đây là cặp bẫy *cực kỳ* hay xuất hiện và rất nhiều người chọn nhầm.

- **"real-time"** (xử lý ngay theo từng record, cần ordering theo shard, độ trễ mili giây) → **Kinesis Data Streams** (hoặc **Kinesis Data Streams + Lambda / KCL**). Cũng có thể là **Amazon MSK** nếu đề nhắc Kafka.
- **"near real-time"** (chấp nhận trễ vài chục giây tới vài phút, gom buffer rồi nạp vào đích) → **Kinesis Data Firehose**. Firehose buffer theo size/time (tối thiểu cỡ 60 giây) rồi mới đẩy vào S3/Redshift/OpenSearch.

> **Câu mẫu:** *Cần nạp clickstream vào S3 để phân tích, chấp nhận độ trễ tới ~1 phút, ít công vận hành nhất.*
> **Suy luận:** "near real-time" + "vào S3" + "least ops" → **Kinesis Data Firehose** (managed, tự buffer & nạp S3). Nếu đề viết "process each record in real time with custom logic and strict ordering" → **Kinesis Data Streams**.

### "decouple" / "asynchronous" / "buffer" / "smooth out spikes"

**Báo hiệu:** cần **SQS** (hoặc SNS + SQS fan-out). "Decouple producer khỏi consumer", "absorb traffic spikes", "process later" → hàng đợi.

> **Câu mẫu:** *Frontend ghi đơn hàng dồn dập lúc flash-sale, backend xử lý chậm hơn, không được mất đơn.*
> **Suy luận:** "không mất đơn" + "dồn dập" + "backend chậm hơn" → đặt **SQS** giữa để buffer; backend (Lambda/EC2/ECS) poll theo nhịp của nó. Nếu cần **nhiều consumer khác nhau cùng nhận mỗi message** → **SNS fan-out tới nhiều SQS**.
> Nếu đề thêm "must process in exact order, no duplicates" → **SQS FIFO**.

### "in transit" và "at rest" (encryption)

**Báo hiệu:** câu Security về mã hoá. Phân biệt rạch ròi:
- **Encryption at rest** (dữ liệu lưu trên đĩa): **SSE-S3 / SSE-KMS** cho S3, **KMS** cho EBS/RDS/DynamoDB, **SecureString** cho Parameter Store.
- **Encryption in transit** (dữ liệu trên đường truyền): **TLS/HTTPS**, ép bằng **bucket policy `aws:SecureTransport`**, dùng **ACM** cấp cert cho ALB/CloudFront/API Gateway.

> **Câu mẫu:** *Yêu cầu mọi truy cập tới bucket phải mã hoá in transit.*
> **Suy luận:** "in transit" → bucket policy có `Condition: { Bool: { "aws:SecureTransport": "false" } }` với `Effect: Deny` (chặn mọi request không-HTTPS). Nếu đề nói "at rest with my own key, full control over rotation/audit" → **SSE-KMS với customer managed key** (không phải SSE-S3, vì SSE-S3 bạn không kiểm soát key).

### "highly available" / "fault tolerant" / "survive AZ failure"

**Báo hiệu:** trải dịch vụ qua **nhiều AZ** / dùng tính năng dự phòng.
- RDS chịu được mất 1 AZ → **Multi-AZ** (đồng bộ, tự failover) — *không phải* Read Replica (async, không tự failover, dùng cho scale read).
- Trải compute → **ASG qua nhiều AZ** sau **ALB**.
- "survive Region failure" (mạnh hơn AZ) → **cross-Region**: DynamoDB Global Tables, S3 CRR, Aurora Global Database, Route 53 failover routing.

> 💡 **Exam Tip:** Phân biệt **Multi-AZ** (high availability, failover) với **Read Replica** (read scaling, async) là một trong những bẫy bị gài nhiều nhất ở domain phủ RDS. "Availability/failover" → Multi-AZ; "offload read / scale read" → Read Replica.

### "strongly consistent" vs "eventually consistent"

**Báo hiệu:** câu DynamoDB. "Must read the latest written value immediately" → **strongly consistent read** (`ConsistentRead: true`, tốn gấp đôi RCU, không dùng được trên GSI). Mặc định là **eventually consistent** (rẻ hơn, có thể đọc trễ vài trăm ms).

### "serverless" / "no servers to manage"

Loại thẳng mọi đáp án có EC2/ECS-on-EC2. Nghiêng về **Lambda, DynamoDB, S3, API Gateway, Step Functions, SQS/SNS, EventBridge, Aurora Serverless, Fargate**.

### "automatically" / "without code changes" / "managed rotation"

**Báo hiệu:** dùng tính năng *tích hợp sẵn* thay vì tự code.

> **Câu mẫu:** *Cần xoay (rotate) mật khẩu RDS định kỳ, tự động, ít công nhất.*
> **Suy luận:** "automatic rotation" của credential DB → **Secrets Manager** với **managed rotation cho RDS** (Lambda rotation có sẵn). Parameter Store *không* tự xoay secret → loại. Đây là điểm phân biệt kinh điển Secrets Manager vs Parameter Store: cần **rotation tự động + cross-region replication** → Secrets Manager; chỉ cần lưu config/secret tĩnh rẻ → Parameter Store.

### "blue/green" / "canary" / "linear" / "zero downtime"

**Báo hiệu:** câu Deployment.
- "shift một phần nhỏ traffic, theo dõi rồi tăng dần" → **canary** (Lambda alias weighted / CodeDeploy canary) hoặc **linear**.
- "không downtime, đổi hẳn môi trường mới rồi swap" → **blue/green** (Beanstalk swap CNAME, CodeDeploy blue/green).
- "rollback tự động khi lỗi" → gắn **CloudWatch alarm** vào deployment (CodeDeploy / SAM DeploymentPreference).

### Bảng tra nhanh từ khoá → nhóm dịch vụ

| Từ khoá trong đề | Nghiêng về |
|---|---|
| least operational overhead / fully managed | Lambda, Fargate, DynamoDB, managed services |
| most cost-effective + spiky | pay-per-use: Lambda, DynamoDB on-demand, Athena |
| most cost-effective + steady 24x7 | Reserved / Savings Plans / DynamoDB provisioned |
| near real-time | Kinesis Data **Firehose** |
| real-time, per-record, ordered | Kinesis Data **Streams** / MSK |
| decouple / buffer / absorb spikes | **SQS** (FIFO nếu cần order/dedup) |
| fan-out tới nhiều consumer | **SNS → nhiều SQS** |
| in transit | TLS/HTTPS, `aws:SecureTransport`, ACM |
| at rest, own key, audit/rotate | **SSE-KMS customer managed key** |
| highly available / failover (DB) | RDS **Multi-AZ** |
| scale read (DB) | **Read Replica** / DAX / ElastiCache |
| survive Region failure | Global Tables / CRR / Aurora Global / Route 53 failover |
| read latest value immediately (DDB) | **strongly consistent read** |
| automatic secret rotation | **Secrets Manager** |
| cache để giảm latency/cost đọc | DAX (DynamoDB) / ElastiCache (RDS) / CloudFront (edge) |
| trace latency qua nhiều service | **X-Ray** |
| ai đã gọi/xoá API nào | **CloudTrail** |
| canary / linear / blue-green | CodeDeploy / Lambda alias / Beanstalk |

> 💡 **Exam Tip:** Khi một câu có *nhiều* từ khoá, ưu tiên từ khoá *ràng buộc mạnh nhất*. Ví dụ "near real-time" + "least operational overhead" + "load vào S3": cả ba đều chỉ về **Firehose** — đáp án phải thoả *tất cả*. Nếu một đáp án thoả "least ops" nhưng vi phạm "near real-time" (ví dụ batch mỗi giờ), nó vẫn sai.

## 50.5 Đăng ký thi & chọn hình thức: online (Pearson VUE / PSI) vs test center

### Quy trình đăng ký

1. Tạo (hoặc đăng nhập) tài khoản **AWS Certification** tại trang `aws.training` / **AWS Skill Builder**, vào mục **AWS Certification → Certification Account**. Tài khoản này là *trung tâm* quản lý lịch thi, kết quả, voucher, badge — tách biệt với AWS Console account thông thường.
2. Từ Certification Account, chọn **Schedule new exam → AWS Certified Developer – Associate (DVA-C02)**. Hệ thống đẩy bạn sang nhà cung cấp khảo thí: hiện tại AWS dùng **Pearson VUE** (và trước đây **PSI**; một số khu vực/thời điểm còn thấy PSI cho online proctored).
3. Chọn **ngôn ngữ đề** (English, 日本語, 한국어, 简体中文... — thường KHÔNG có tiếng Việt), chọn **hình thức**: *online proctored* (thi tại nhà, giám thị từ xa) hoặc *test center* (đến trung tâm khảo thí).
4. Chọn ngày giờ, thanh toán **150 USD** (hoặc dùng voucher 50% / 100% nếu có). Có thể yêu cầu **ESL +30 phút** (extended time cho người không nói tiếng Anh bản ngữ) — *phải đăng ký trước khi đặt lịch*, không bù được sau.

> 💡 **Exam Tip:** Nếu tiếng Anh không phải tiếng mẹ đẻ, hãy xin **ESL accommodation (+30 phút)** trong Certification Account TRƯỚC khi schedule. Nó nâng thời gian từ 130 lên 160 phút và rất đáng giá để đọc kỹ các câu scenario dài.

### So sánh hai hình thức

| Tiêu chí | Online proctored (Pearson VUE / PSI) | Test center |
|---|---|---|
| Địa điểm | Tại nhà/phòng riêng của bạn | Trung tâm khảo thí được uỷ quyền |
| Yêu cầu phòng | Phòng kín, *một mình*, bàn sạch, không giấy/bút/điện thoại/màn hình phụ | Trung tâm lo sẵn |
| Thiết bị | Máy bạn: webcam, mic, đường truyền ổn định; cài app **OnVUE** (Pearson) | Máy của trung tâm |
| Check-in | Chụp ảnh CMND/hộ chiếu + ảnh khuôn mặt + quét 360° căn phòng, có người giám thị xem qua webcam suốt buổi | Xuất trình giấy tờ tại quầy |
| Giấy tờ tuỳ thân | **2 giấy tờ**, ít nhất 1 có ảnh, tên *khớp chính xác* tên đăng ký | Tương tự |
| Rủi ro chính | Mạng rớt, webcam/mic lỗi, có tiếng động/người vào phòng → bị *dừng thi* | Phải di chuyển; lịch phụ thuộc slot trung tâm |
| Linh hoạt giờ | Cao (gần như 24/7 tuỳ khu vực) | Theo giờ mở cửa trung tâm |
| Ghi chú nháp | Một số cho **online whiteboard** trong app; KHÔNG được dùng giấy thật | Có thể được phát bảng xoá/giấy nháp (theo quy định trung tâm) |

### Kinh nghiệm thi online (để không bị loại oan)

- **Vào sớm 30 phút.** Cửa check-in OnVUE mở trước giờ thi ~30 phút. Quá trình chụp giấy tờ + quét phòng + chờ giám thị có thể mất 15–25 phút. Vào trễ → bị huỷ, mất tiền.
- **Test máy trước** bằng công cụ **system test** của Pearson VUE (có link trong email xác nhận) — kiểm tra webcam, mic, băng thông, và *quan trọng*: tắt phần mềm chặn (VPN doanh nghiệp, firewall, antivirus) có thể chặn OnVUE.
- **Dọn bàn trống tuyệt đối.** Không sách, giấy, bút, điện thoại (kể cả úp xuống), không tai nghe, không màn hình thứ hai (rút cáp/tắt hẳn). Giám thị sẽ bắt bạn quét cả gầm bàn và tường.
- **Một mình trong phòng, đóng cửa.** Có người đi ngang qua webcam, hoặc bạn *nói to/đọc đề thành tiếng*, có thể bị cảnh cáo hoặc dừng thi. Không rời khung hình webcam — không có giải lao.
- **Đường truyền:** ưu tiên cắm dây LAN thay vì Wi-Fi; tắt các thiết bị khác đang ngốn băng thông; nếu mạng chập chờn, chọn **test center** cho chắc.
- **Dùng laptop có pin đầy + cắm sạc**; tắt thông báo hệ điều hành (Do Not Disturb) để popup không làm OnVUE hiểu nhầm bạn mở app khác.

> 💡 **Exam Tip:** Lý do trượt phổ biến *không phải vì kiến thức* mà vì **lỗi quy chế thi online**: bàn còn vật cấm, có người vào phòng, nhìn ra khỏi màn hình quá lâu, hoặc mạng rớt giữa chừng. Nếu bạn không có phòng riêng yên tĩnh và mạng ổn, hãy chọn **test center** — đừng đánh đổi công ôn nhiều tuần lấy rủi ro môi trường.

### Sau khi nộp bài

- Khi submit, màn hình thường hiện **PASS/FAIL sơ bộ ngay** (preliminary). Kết quả chính thức + điểm scaled (100–1000) + section feedback gửi về **Certification Account** trong **vòng ~5 ngày làm việc** (thường nhanh hơn, có khi vài giờ).
- Đậu rồi: **digital badge** (qua Credly) và **voucher giảm 50%** cho lần thi chứng chỉ AWS kế tiếp xuất hiện trong tài khoản. Chứng chỉ có hiệu lực **3 năm**.
- Rớt: phải chờ **14 ngày** mới được đăng ký thi lại (và trả phí lại, trừ khi có voucher). Dùng section feedback (Needs Improvement) để biết domain nào yếu mà ôn lại.

> 💡 **Exam Tip:** Đừng lên lịch thi lại quá sát ngay sau khi rớt — quy định buộc chờ 14 ngày, và bạn cần thời gian đó để vá đúng lỗ hổng theo section feedback. Quay lại Chương 49 làm lại đề mô phỏng, đối chiếu domain yếu, rồi mới đặt lịch.

*(Lộ trình ôn 4 tuần & 8 tuần, checklist kiến thức từng domain, bảng "cặp dịch vụ hay gài bẫy" tổng hợp toàn giáo trình, "làm gì khi không chắc đáp án", và lộ trình sau khi đậu — tiếp tục ở **nửa sau Chương 50**.)*

---

## Bảng phân biệt nhanh các cặp service hay gài bẫy

Đây là bảng "tra cứu ngược" được rút gọn từ toàn bộ giáo trình. Cách dùng: khi đọc câu hỏi, bắt lấy **dấu hiệu (keyword)** trong đề rồi nhảy ngay tới dòng tương ứng để biết **chọn gì**. Trong phòng thi, 80% các cặp dưới đây quyết định bằng đúng một keyword.

### Messaging: SQS vs SNS vs Kinesis vs EventBridge

| Dịch vụ | Dấu hiệu nhận biết trong câu hỏi | Chọn khi |
|---|---|---|
| **SQS Standard** | "decouple", "buffer", "1 consumer xử lý rồi xoá message", "tránh mất việc khi worker chết" | Hàng đợi điểm-tới-điểm, mỗi message được xử lý một lần bởi một consumer; cần retry + DLQ |
| **SQS FIFO** | "exactly-once processing", "strict ordering", "deduplication" | Cần thứ tự tuyệt đối + chống trùng; throughput thấp (300 msg/s, 3000 với batch) |
| **SNS** | "fan-out", "1 message tới nhiều subscriber", "push notification/email/SMS", "thông báo" | Pub/sub đẩy (push) tới nhiều endpoint cùng lúc; kết hợp SNS→nhiều SQS cho fan-out bền |
| **Kinesis Data Streams** | "real-time analytics", "ordering theo partition key", "nhiều consumer đọc lại cùng data", "replay", "retention nhiều giờ/ngày", "clickstream", "IoT" | Streaming dữ liệu lớn, nhiều consumer độc lập, cần đọc lại (replay), giữ data tới 365 ngày |
| **Kinesis Data Firehose** | "near real-time", "load vào S3/Redshift/OpenSearch", "không cần code consumer", "buffer rồi ghi" | Nạp dữ liệu vào kho lưu trữ, fully managed, không quản shard, latency ~tối thiểu 60s |
| **EventBridge** | "schedule (cron)", "event-driven theo pattern", "SaaS/partner event", "routing theo nội dung event", "archive & replay" | Định tuyến event giữa nhiều AWS service/SaaS bằng rule; lịch cron; có schema registry |

> Bẫy kinh điển: "near real-time" + "deliver to S3" → **Firehose**, KHÔNG phải Data Streams. "Replay" hoặc "multiple consumers reading the same records" → **Data Streams**, KHÔNG phải SQS (SQS xoá message sau khi xử lý).

### Load Balancer: ALB vs NLB vs GWLB

| | Dấu hiệu | Chọn |
|---|---|---|
| **ALB** | "HTTP/HTTPS", "path-based / host-based routing", "WebSocket", "redirect", "Lambda target", "X-Forwarded-For" | Layer 7, định tuyến theo URL/host/header |
| **NLB** | "millions of requests", "ultra-low latency", "static IP / Elastic IP", "TCP/UDP", "PrivateLink endpoint service" | Layer 4, hiệu năng cực cao, IP tĩnh |
| **GWLB** | "third-party virtual appliance", "firewall/IDS/IPS inline", "GENEVE 6081" | Chèn appliance bảo mật vào đường đi traffic |

### S3 Encryption: SSE-S3 vs SSE-KMS vs SSE-C vs Client-side

| | Dấu hiệu | Chọn |
|---|---|---|
| **SSE-S3** (`AES256`) | "mã hoá at rest", "không cần quản key", "không yêu cầu audit" | Mặc định đơn giản, AWS quản key hoàn toàn |
| **SSE-KMS** (`aws:kms`) | "audit ai dùng key (CloudTrail)", "kiểm soát quyền dùng key", "key rotation", "tự quản CMK" | Cần audit + kiểm soát; lưu ý quota KMS gây throttling → bật **S3 Bucket Key** để giảm gọi KMS |
| **SSE-C** | "khách tự giữ key", "AWS không lưu key" | Client cung cấp key mỗi request (qua HTTPS) |
| **Client-side** | "mã hoá TRƯỚC khi gửi lên S3", "AWS không bao giờ thấy plaintext" | Mã hoá tại client bằng Encryption SDK |

> Bẫy: "phải biết ai đã giải mã object và khi nào" → **SSE-KMS** (vì có CloudTrail log mỗi lần Decrypt). SSE-S3 không cho bạn audit cấp key.

### Cấu hình / Secret: Parameter Store vs Secrets Manager

| | Dấu hiệu | Chọn |
|---|---|---|
| **Parameter Store** | "config value", "feature flag đơn giản", "rẻ/miễn phí (standard)", "không cần tự rotate" | Lưu config & secret cơ bản, miễn phí ở standard tier |
| **Secrets Manager** | "automatic rotation", "rotate DB credential bằng Lambda managed", "cross-region replication của secret", "tạo random password" | Cần **tự động rotate** (đặc biệt RDS) hoặc generate secret; tốn phí/secret/tháng |

> Bẫy: chỉ riêng từ **"automatic rotation"** đã đẩy đáp án về **Secrets Manager**. Parameter Store advanced tier có rotation đâu — nó chỉ có parameter policy (expiration/notification).

### Cognito: User Pools vs Identity Pools

| | Dấu hiệu | Chọn |
|---|---|---|
| **User Pools** | "sign-up/sign-in", "JWT token (ID/access)", "hosted UI", "authenticate user", "authorizer cho API Gateway" | **Xác thực** (authentication) — quản lý user directory, trả JWT |
| **Identity Pools** | "cấp AWS credentials tạm", "cho phép truy cập S3/DynamoDB trực tiếp từ app", "STS", "fine-grained IAM theo user" | **Authorize vào AWS** — đổi token lấy IAM credentials tạm qua STS |

> Bẫy: "web app upload thẳng vào S3 từ trình duyệt với quyền theo từng user" → **Identity Pools** (lấy AWS credentials). "Bảo vệ REST API" → **User Pools** authorizer.

### Cache: DAX vs ElastiCache

| | Dấu hiệu | Chọn |
|---|---|---|
| **DAX** | "DynamoDB", "microsecond latency", "không đổi code (API tương thích)", "read-heavy DynamoDB" | Cache chuyên cho DynamoDB, drop-in, item + query cache |
| **ElastiCache** | "Redis/Memcached", "session store", "leaderboard (sorted set)", "pub/sub", "cache kết quả RDS" | Cache đa năng cho RDS/tính toán/session; cần sửa code app |

### DynamoDB index: GSI vs LSI

| | Dấu hiệu | Chọn |
|---|---|---|
| **GSI** | "khác partition key", "tạo bất kỳ lúc nào", "throughput riêng", "eventually consistent" | Query theo attribute khác hẳn key gốc; **chỉ eventually consistent** |
| **LSI** | "cùng partition key, khác sort key", "phải tạo lúc create table", "strongly consistent" | Cùng PK nhưng sort theo attribute khác; giới hạn 10GB/partition |

> Bẫy: "cần strongly consistent read trên index" → chỉ **LSI** làm được. "Đã có bảng rồi mới muốn thêm index" → bắt buộc **GSI** (LSI phải tạo khi create table).

### S3 presigned URL vs CloudFront signed URL/cookie

| | Dấu hiệu | Chọn |
|---|---|---|
| **S3 presigned URL** | "cấp quyền tạm truy cập 1 object", "upload/download trực tiếp S3", "hết hạn sau X phút" | Truy cập một object S3 không cần IAM, dùng quyền của người tạo URL |
| **CloudFront signed URL** | "qua CDN", "1 file", "edge", "kèm restriction IP/thời gian" | Phát qua CloudFront, kiểm soát từng URL |
| **CloudFront signed cookie** | "nhiều file", "không đổi URL", "phát video streaming nhiều segment" | Cấp quyền cho nhiều object mà giữ nguyên URL |

### API Gateway auth: Lambda authorizer vs Cognito authorizer vs IAM

| | Dấu hiệu | Chọn |
|---|---|---|
| **Cognito authorizer** | "user trong Cognito User Pool", "JWT", "không muốn viết code auth" | User đã ở User Pool → authorizer kiểm JWT sẵn |
| **Lambda authorizer** | "OAuth/JWT của bên thứ ba", "custom logic", "token format riêng", "trả về IAM policy" | Logic xác thực tuỳ biến (token hoặc request-based), có cache theo TTL |
| **IAM (SigV4)** | "service-to-service trong AWS", "IAM user/role gọi API" | Caller là principal AWS, ký SigV4 |

### Lambda concurrency: Reserved vs Provisioned

| | Dấu hiệu | Chọn |
|---|---|---|
| **Reserved concurrency** | "giới hạn tối đa concurrency của 1 function", "bảo vệ DB downstream", "đảm bảo function khác không ăn hết pool" | Đặt **trần** (và sàn riêng) số concurrency; không tốn thêm tiền |
| **Provisioned concurrency** | "loại bỏ cold start", "latency ổn định", "khởi tạo sẵn instance" | Giữ sẵn execution environment warm; tốn phí; kết hợp Application Auto Scaling |

> Bẫy: "tránh cold start để latency thấp/ổn định" → **Provisioned**. "Đừng để function này làm sập RDS vì quá nhiều connection" → **Reserved** (giới hạn trần).

### Observability: CloudTrail vs CloudWatch vs X-Ray

| | Dấu hiệu | Chọn |
|---|---|---|
| **CloudTrail** | "ai đã làm gì", "API call nào được gọi", "audit", "ai xoá resource", "compliance" | Log **API activity** (who/what/when) trên account |
| **CloudWatch** | "metric", "alarm", "log của ứng dụng", "CPU/Memory", "dashboard" | Giám sát **hiệu năng & log nội dung** |
| **X-Ray** | "trace request qua nhiều service", "tìm bottleneck latency", "service map", "phân tích nơi chậm" | **Distributed tracing** end-to-end |

> Bẫy kinh điển: "An EC2 instance was terminated, who did it?" → **CloudTrail**. "Request đi qua API Gateway→Lambda→DynamoDB và chỗ nào chậm?" → **X-Ray**.

### Step Functions: Standard vs Express

| | Dấu hiệu | Chọn |
|---|---|---|
| **Standard** | "long-running (tới 1 năm)", "exactly-once", "human approval / wait for callback", "audit từng bước" | Workflow dài, đáng tin cậy, exactly-once |
| **Express** | "high-volume event", "ngắn (<5 phút)", "rẻ theo số lần chạy", "IoT/streaming ingest" | Tần suất cao, ngắn; at-least-once (sync) hoặc at-most-once (async) |

## Checklist kiến thức theo domain

Đề DVA-C02 chia 4 domain. Trước khi thi, tự chấm từng dòng "nắm chắc / cần ôn lại". Số chương để bạn nhảy về ôn nhanh.

### Domain 1 — Development with AWS Services (32%)
- [ ] Lambda: invocation types (sync/async/event source mapping), cold start, env vars, timeout 15 phút, memory 128MB–10GB, /tmp tới 10GB (Ch28–30).
- [ ] Concurrency: reserved vs provisioned, throttling 429, account limit 1000 (Ch29).
- [ ] DynamoDB: cách tính RCU/WCU, eventually vs strongly consistent, Query vs Scan, GSI/LSI, conditional write + optimistic locking, transactions (Ch31–33).
- [ ] API Gateway: proxy vs non-proxy, stage variables, request validation, caching, usage plan + API key (Ch34–35).
- [ ] S3 SDK: multipart (>5GB bắt buộc, khuyến nghị >100MB), presigned URL, byte-range (Ch12–13).
- [ ] SQS/SNS/Kinesis: chọn đúng theo pattern; visibility timeout; DLQ; fan-out (Ch21–23).
- [ ] Step Functions: ASL, error Retry/Catch, integration patterns (.sync, .waitForTaskToken) (Ch43).
- [ ] Idempotency, exponential backoff & jitter, pagination (Ch3, Ch30).

### Domain 2 — Security (26%)
- [ ] IAM: policy evaluation (explicit deny thắng), identity vs resource-based, roles cho service (Ch2, Ch45).
- [ ] STS: AssumeRole cross-account + trust policy + ExternalId chống confused deputy (Ch45).
- [ ] Cognito: User Pools (JWT) vs Identity Pools (AWS credentials) (Ch38–39).
- [ ] KMS: envelope encryption, GenerateDataKey, 4KB direct limit, key policy + IAM, bucket key (Ch46).
- [ ] S3 security: SSE-S3/KMS/C, bucket policy ép HTTPS (`aws:SecureTransport`), Block Public Access (Ch14).
- [ ] Secrets Manager vs Parameter Store; dynamic references trong CloudFormation (Ch47).
- [ ] Encryption in transit, ACM cho ALB/CloudFront/API GW (Ch48).

### Domain 3 — Deployment (24%)
- [ ] CloudFormation: intrinsic functions, cross-stack Export/ImportValue, DeletionPolicy, ChangeSets, nested vs cross-stack (Ch19–20).
- [ ] SAM: template, `sam build/deploy`, AutoPublishAlias + DeploymentPreference canary/linear (Ch36).
- [ ] CDK: constructs L1/L2/L3, grants, `cdk synth/deploy` (Ch37).
- [ ] Beanstalk: deployment policies (all-at-once, rolling, immutable, traffic splitting), blue/green swap CNAME (Ch18).
- [ ] CodeBuild buildspec, CodeDeploy appspec + hooks, CodePipeline stages (Ch40–42).
- [ ] Lambda versions/aliases, weighted alias canary (Ch29).
- [ ] ECS rolling update, deployment circuit breaker; blue/green qua CodeDeploy (Ch17, Ch41).

### Domain 4 — Troubleshooting & Optimization (18%)
- [ ] X-Ray: instrument, sampling, annotations vs metadata, "không thấy trace" checklist (Ch26).
- [ ] CloudWatch Logs Insights, metric filter, subscription filter (Ch25).
- [ ] Lambda errors: throttling (429), timeout, DLQ/destinations, retry async (Ch28–30).
- [ ] DynamoDB ProvisionedThroughputExceeded, hot partition, adaptive capacity (Ch31).
- [ ] Kinesis ProvisionedThroughputExceeded, hot shard, resharding (Ch23).
- [ ] Caching để tối ưu chi phí/latency: DAX, ElastiCache, API GW cache, CloudFront (Ch9, Ch15, Ch33, Ch35).
- [ ] X-Forwarded-For, 502/504 ở ALB/API GW (integration timeout 29s) (Ch6, Ch34).

## Lộ trình ôn 4 tuần và 8 tuần

Lộ trình bám đúng 50 chương của giáo trình này. Giả định bạn dành ~10–12 giờ/tuần (4 tuần) hoặc ~6 giờ/tuần (8 tuần). Mỗi chương: đọc part1 → làm lab part2 → làm quiz 10 câu → ghi lại câu sai.

### Lộ trình 4 tuần (nước rút, đã có nền dev)

**Tuần 1 — Nền tảng + Storage (Ch1–15).** Đọc nhanh Ch1–11 (IAM, EC2, ELB, ASG, RDS, ElastiCache, Route53, VPC — phần bạn đã quen có thể lướt). Tập trung kỹ Ch2 (IAM policy), Ch6 (ALB vs NLB), Ch8 (Multi-AZ vs Read Replica), Ch12–15 (S3 + CloudFront, đặc biệt S3 encryption Ch14).

**Tuần 2 — Containers, IaC, Messaging, Monitoring (Ch16–27).** ECS/Fargate (Ch17), Beanstalk deployment policies (Ch18), CloudFormation (Ch19–20 — học kỹ). SQS/SNS/Kinesis (Ch21–23, làm bảng so sánh thuộc lòng). CloudWatch/EventBridge/X-Ray/CloudTrail (Ch24–27).

**Tuần 3 — Serverless core (Ch28–39).** Đây là phần nặng điểm nhất. Lambda (Ch28–30), DynamoDB (Ch31–33 — luyện tính RCU/WCU), API Gateway (Ch34–35), SAM/CDK (Ch36–37), Cognito (Ch38–39). Mỗi ngày 1–2 chương + quiz.

**Tuần 4 — CI/CD, Advanced, Luyện đề (Ch40–50).** CodePipeline/Deploy/Build (Ch40–42), Step Functions (Ch43), AppSync (Ch44), STS/KMS/Secrets (Ch45–47), Ch48. Hai ngày cuối: làm trọn bộ 65 câu Ch49 bấm giờ, đọc lại Ch50, ôn các câu sai.

### Lộ trình 8 tuần (chắc chắn, vừa học vừa làm)

- **Tuần 1:** Ch1–6 (tổng quan, IAM, CLI/SDK, EC2, EBS/EFS, ELB).
- **Tuần 2:** Ch7–11 (ASG, RDS/Aurora, ElastiCache, Route53, VPC).
- **Tuần 3:** Ch12–15 (S3 cơ bản → security → CloudFront). Làm kỹ lab presigned URL & encryption.
- **Tuần 4:** Ch16–20 (ECR, ECS/Fargate, Beanstalk, CloudFormation cơ bản + nâng cao).
- **Tuần 5:** Ch21–27 (SQS, SNS, Kinesis, CloudWatch, EventBridge, X-Ray, CloudTrail).
- **Tuần 6:** Ch28–33 (Lambda x3, DynamoDB x3). Phần điểm cao nhất — đi chậm, làm hết lab.
- **Tuần 7:** Ch34–42 (API Gateway, SAM, CDK, Cognito, CI/CD). 
- **Tuần 8:** Ch43–48 (Step Functions, AppSync, STS, KMS, Secrets, Ch48) + Ch49 (bộ đề 65 câu, làm 2 lần) + Ch50 (chiến lược). 

Quy tắc chung cho cả hai lộ trình: duy trì một "sổ lỗi" — mỗi câu quiz sai ghi lại keyword + service đúng + lý do. Tuần cuối chỉ đọc sổ lỗi và bảng phân biệt ở đầu chương này. Đặt mục tiêu đạt ≥80% trên bộ đề Ch49 trước khi đăng ký thi thật.

## Quiz tổng hợp nhanh (10 câu)

**Câu 1.** Một ứng dụng cần nạp clickstream gần real-time vào S3 và OpenSearch mà không phải viết/quản lý code consumer. Chọn gì?
- A. Kinesis Data Streams + Lambda
- B. Kinesis Data Firehose
- C. SQS Standard
- D. EventBridge

**Câu 2.** Developer cần đảm bảo một Lambda function không bao giờ vượt 50 concurrent execution để bảo vệ RDS phía sau. Dùng gì?
- A. Provisioned concurrency = 50
- B. Reserved concurrency = 50
- C. Tăng timeout
- D. RDS Proxy

**Câu 3.** Cần audit chính xác ai đã gọi `DeleteBucket` và lúc nào. Dịch vụ nào?
- A. CloudWatch Logs
- B. X-Ray
- C. CloudTrail
- D. AWS Config

**Câu 4.** Web SPA cần cho phép mỗi user đã đăng nhập upload file thẳng vào prefix S3 riêng của họ. Cấu phần nào cấp quyền AWS?
- A. Cognito User Pools
- B. Cognito Identity Pools
- C. API Gateway Lambda authorizer
- D. IAM user cho mỗi người

**Câu 5.** Bảng DynamoDB đã chạy production cần query theo `email` (không phải key gốc), chấp nhận eventually consistent. Tạo gì?
- A. LSI
- B. GSI
- C. Scan với filter
- D. Tạo lại bảng với sort key mới

**Câu 6.** Cần rotate tự động mật khẩu RDS mỗi 30 ngày với ít công sức vận hành nhất.
- A. Parameter Store SecureString
- B. Secrets Manager với managed rotation
- C. Lưu trong env var Lambda
- D. KMS GenerateDataKey

**Câu 7.** API Gateway REST API trả lỗi `504` khi tích hợp một backend HTTP chạy lâu. Nguyên nhân giới hạn nào?
- A. Lambda timeout 15 phút
- B. Integration timeout tối đa 29 giây
- C. Throttling 10000 rps
- D. Payload 10MB

**Câu 8.** Cần phát một video streaming gồm nhiều segment qua CloudFront, kiểm soát truy cập theo thời gian, không muốn đổi URL từng file.
- A. S3 presigned URL
- B. CloudFront signed URL
- C. CloudFront signed cookies
- D. Bucket policy public

**Câu 9.** Object S3 phải mã hoá at rest và bắt buộc audit được mỗi lần object bị decrypt.
- A. SSE-S3
- B. SSE-KMS
- C. SSE-C
- D. Không mã hoá, dùng bucket policy

**Câu 10.** Cần loại bỏ cold start để giữ latency p99 ổn định cho một API Lambda quan trọng.
- A. Reserved concurrency
- B. Provisioned concurrency
- C. Tăng memory lên 10GB
- D. Đổi sang SnapStart cho Node.js

### Đáp án & giải thích

**Câu 1 — B.** Firehose là "near real-time", fully managed, nạp thẳng vào S3/OpenSearch/Redshift, không cần code consumer hay quản shard. A đúng về mặt kỹ thuật nhưng đòi viết Lambda và quản Data Streams (vi phạm "không quản code"). SQS không phải streaming và không tự nạp vào kho. EventBridge để routing event, không phải buffer-and-load streaming.

**Câu 2 — B.** Reserved concurrency đặt **trần** concurrency cho function → bảo vệ RDS khỏi quá nhiều connection. Provisioned concurrency chỉ giữ instance warm (chống cold start), không giới hạn trần. RDS Proxy giúp pool connection nhưng câu hỏi yêu cầu giới hạn concurrency của function.

**Câu 3 — C.** CloudTrail ghi lại API call (who/what/when) → trả lời "ai gọi DeleteBucket". CloudWatch Logs là log nội dung ứng dụng. X-Ray là tracing. AWS Config theo dõi trạng thái/compliance cấu hình, không phải nhật ký ai-gọi-API.

**Câu 4 — B.** Identity Pools đổi token đăng nhập lấy **AWS credentials tạm** (qua STS) với IAM policy fine-grained theo `${cognito-identity.amazonaws.com:sub}` → upload thẳng S3 theo prefix riêng. User Pools chỉ xác thực và trả JWT, không cấp AWS credentials. Tạo IAM user cho mỗi người không scale và sai mô hình.

**Câu 5 — B.** Bảng đã chạy production nên không thể thêm LSI (LSI bắt buộc tạo khi create table). GSI tạo được bất kỳ lúc nào, có key riêng, eventually consistent — đúng yêu cầu. Scan tốn kém và chậm. Tạo lại bảng là gián đoạn không cần thiết.

**Câu 6 — B.** Secrets Manager hỗ trợ managed rotation cho RDS gần như zero-code → ít vận hành nhất. Parameter Store không có automatic rotation. Env var Lambda không rotate và lộ secret. KMS GenerateDataKey là API mã hoá, không liên quan rotation credential.

**Câu 7 — B.** API Gateway có integration timeout tối đa **29 giây**; backend chạy lâu hơn → `504 Gateway Timeout`. Lambda timeout 15 phút không cứu được vì API GW đã cắt ở 29s. Throttling trả 429, payload limit trả 413/400 — không phải 504.

**Câu 8 — C.** Signed cookies cấp quyền cho **nhiều object** mà giữ nguyên URL → hợp video nhiều segment. Signed URL chỉ cho một file. S3 presigned URL truy cập trực tiếp S3, không qua CDN. Public bucket mất kiểm soát truy cập.

**Câu 9 — B.** SSE-KMS ghi mỗi lần Encrypt/Decrypt vào CloudTrail → audit được "ai decrypt khi nào". SSE-S3 không cho audit ở cấp key. SSE-C bắt client giữ key (không audit qua KMS). Bucket policy không mã hoá data.

**Câu 10 — B.** Provisioned concurrency giữ sẵn execution environment đã khởi tạo → loại bỏ cold start, latency p99 ổn định. Reserved chỉ giới hạn trần, không chống cold start. Tăng memory giảm thời gian chạy nhưng vẫn cold start. SnapStart hỗ trợ cho Java (không phải Node.js ở thời điểm kinh điển của đề), nên D sai trong ngữ cảnh này.

## Sau khi đậu

Có chứng chỉ DVA-C02 rồi, đây là các hướng đi tiếp hợp lý cho một backend developer:

- **AWS Certified Solutions Architect – Associate (SAA-C03):** chồng lấn ~40% kiến thức với DVA, bổ sung mảng thiết kế kiến trúc, networking sâu, chi phí. Học tiếp ngay sau DVA là rẻ nhất về thời gian.
- **AWS Certified DevOps Engineer – Professional (DOP-C02):** bước nhảy tự nhiên từ Developer nếu bạn thiên về CI/CD, IaC, observability. Yêu cầu nền vững về CodePipeline, CloudFormation, monitoring — vốn đã có trong giáo trình này.
- **AWS Certified Solutions Architect – Professional (SAP-C02):** nặng nhất, nên đi sau khi có SAA + kinh nghiệm thực tế.
- **Specialty:** Security Specialty (nếu làm nhiều KMS/IAM/Cognito), Data Engineer Associate (nếu thiên về Kinesis/Glue/Athena).

Lời khuyên thực tế: chứng chỉ có hiệu lực **3 năm**. Quan trọng hơn tấm bằng là biến kiến thức thành sản phẩm — dựng một dự án serverless thật (API Gateway + Lambda + DynamoDB + Cognito + CI/CD bằng SAM/CDK) để đưa vào portfolio. Nhà tuyển dụng tin "đã build" hơn "đã thi".

## Tóm tắt chương

- Phần nửa sau chương 50 cung cấp công cụ tra cứu nhanh và lộ trình hoàn thiện cho việc ôn thi — dùng song song với bộ đề ở Chương 49.
- **Bảng phân biệt cặp service** là tài sản giá trị nhất: học thuộc keyword → service. Trong phòng thi, một keyword như "near real-time", "automatic rotation", "audit", "exactly-once", "fan-out" thường quyết định đáp án.
- Nhớ các bẫy kinh điển: Firehose vs Data Streams (near real-time + load), Reserved vs Provisioned concurrency (trần vs chống cold start), User Pools vs Identity Pools (JWT vs AWS credentials), LSI vs GSI (strongly consistent + tạo lúc create table vs eventually + tạo bất kỳ lúc nào).
- CloudTrail = ai gọi API; CloudWatch = metric/log; X-Ray = trace latency. Đây là bộ ba luôn xuất hiện ở domain Troubleshooting.
- **Checklist theo domain** giúp tự đánh giá độ phủ: Development 32%, Security 26%, Deployment 24%, Troubleshooting 18% — phân bổ thời gian ôn theo trọng số này.
- **Lộ trình 4 tuần** cho người có nền và cần nước rút; **8 tuần** cho người muốn chắc chắn. Cả hai bám đúng 50 chương và đều dành tuần cuối cho bộ đề Ch49 + sổ lỗi.
- Quy tắc bất biến: duy trì "sổ lỗi" và đạt ≥80% trên đề mô phỏng trước khi đăng ký thi thật.
- Một số limit hay bị hỏi tổng hợp lại: API Gateway integration timeout 29s, Lambda timeout 15 phút / memory 10GB / 1000 concurrency mặc định, KMS direct encrypt 4KB, SQS message 256KB, S3 multipart bắt buộc >5GB.
- Sau khi đậu: hướng tự nhiên là SAA-C03 (chồng lấn nhiều) rồi DOP-C02; quan trọng hơn cả là build một dự án serverless thật để chứng minh năng lực.
