## Hands-on Lab: Streams → Lambda → materialized view, kèm TTL và PITR

**Mục tiêu lab:** Dựng một pipeline DynamoDB hoàn chỉnh dùng đúng các tính năng trọng tâm chương 33:
- Bật **DynamoDB Streams** với view type `NEW_AND_OLD_IMAGES`.
- Gắn một **Lambda** qua **event source mapping** để xử lý stream records (tạo "materialized view" đếm số order theo từng customer trong một bảng aggregate).
- Bật **TTL** để item tự xoá sau khi hết hạn và quan sát record TTL-delete chảy vào Stream.
- Bật **Point-in-Time Recovery (PITR)** và thực hiện **export to S3**.
- Quan sát chi phí: thao tác xoá bởi TTL **không tốn WCU**, nhưng vẫn sinh stream record.

**Chuẩn bị:**
- AWS CLI v2 đã cấu hình (`aws configure`), region ví dụ `ap-southeast-1`.
- Quyền IAM tạo DynamoDB table, Lambda, IAM role, S3 bucket.
- Node.js 20 để đóng gói Lambda. Toàn bộ lệnh dùng region trong biến `$REGION`.

```bash
export REGION=ap-southeast-1
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "Account=$ACCOUNT_ID Region=$REGION"
```

### Bước 1: Tạo bảng nguồn `Orders` với Streams bật sẵn

```bash
aws dynamodb create-table \
  --table-name Orders \
  --attribute-definitions \
      AttributeName=customerId,AttributeType=S \
      AttributeName=orderId,AttributeType=S \
  --key-schema \
      AttributeName=customerId,KeyType=HASH \
      AttributeName=orderId,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST \
  --stream-specification StreamEnabled=true,StreamViewType=NEW_AND_OLD_IMAGES \
  --region $REGION
```

Đợi bảng `ACTIVE` và lấy **Stream ARN** (chú ý: ARN của stream có hậu tố timestamp, khác với table ARN):

```bash
aws dynamodb wait table-exists --table-name Orders --region $REGION
STREAM_ARN=$(aws dynamodb describe-table --table-name Orders --region $REGION \
  --query 'Table.LatestStreamArn' --output text)
echo "STREAM_ARN=$STREAM_ARN"
```

Output mong đợi: chuỗi dạng `arn:aws:dynamodb:ap-southeast-1:123...:table/Orders/stream/2026-06-12T...`.

### Bước 2: Tạo bảng aggregate `CustomerOrderCount`

Đây là "materialized view" — Lambda sẽ tăng/giảm bộ đếm tại đây.

```bash
aws dynamodb create-table \
  --table-name CustomerOrderCount \
  --attribute-definitions AttributeName=customerId,AttributeType=S \
  --key-schema AttributeName=customerId,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region $REGION
aws dynamodb wait table-exists --table-name CustomerOrderCount --region $REGION
```

### Bước 3: Tạo IAM Role cho Lambda

Lambda đọc stream cần các quyền `GetRecords`, `GetShardIterator`, `DescribeStream`, `ListStreams` trên **stream ARN**, cộng quyền ghi vào bảng aggregate và viết log.

```bash
cat > trust.json <<'EOF'
{ "Version": "2012-10-17",
  "Statement": [{ "Effect": "Allow",
    "Principal": { "Service": "lambda.amazonaws.com" },
    "Action": "sts:AssumeRole" }] }
EOF

aws iam create-role --role-name ddb-stream-lambda-role \
  --assume-role-policy-document file://trust.json

aws iam attach-role-policy --role-name ddb-stream-lambda-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

cat > inline.json <<EOF
{ "Version": "2012-10-17", "Statement": [
  { "Effect": "Allow",
    "Action": ["dynamodb:GetRecords","dynamodb:GetShardIterator",
               "dynamodb:DescribeStream","dynamodb:ListStreams"],
    "Resource": "${STREAM_ARN}" },
  { "Effect": "Allow",
    "Action": "dynamodb:UpdateItem",
    "Resource": "arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/CustomerOrderCount" }
]}
EOF

aws iam put-role-policy --role-name ddb-stream-lambda-role \
  --policy-name stream-access --policy-document file://inline.json
ROLE_ARN=$(aws iam get-role --role-name ddb-stream-lambda-role --query 'Role.Arn' --output text)
```

> Bẫy: quyền stream phải đặt trên **stream ARN** (có `/stream/<timestamp>`), KHÔNG phải table ARN. Đặt nhầm table ARN sẽ khiến event source mapping báo trạng thái `Problem: ... is not authorized`.

### Bước 4: Viết và deploy Lambda xử lý stream

```javascript
// index.mjs — Node.js 20, AWS SDK v3 (có sẵn trong runtime)
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = "CustomerOrderCount";

export const handler = async (event) => {
  for (const r of event.Records) {
    // eventName: INSERT | MODIFY | REMOVE
    // Keys luôn ở dạng DynamoDB JSON (đã unmarshall thủ công ở đây)
    const customerId = r.dynamodb.Keys.customerId.S;
    let delta = 0;
    if (r.eventName === "INSERT") delta = 1;
    else if (r.eventName === "REMOVE") delta = -1;        // gồm cả TTL-delete
    if (delta === 0) continue;                            // MODIFY: bỏ qua

    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { customerId },
      UpdateExpression: "ADD orderCount :d",
      ExpressionAttributeValues: { ":d": delta },
    }));
  }
  return { batchItemFailures: [] };   // partial batch response (chi tiết ở Chương 30)
};
```

Đóng gói và tạo function (gắn event source vào stream với `--starting-position LATEST`):

```bash
zip function.zip index.mjs
aws lambda create-function --function-name OrderAggregator \
  --runtime nodejs20.x --handler index.handler \
  --zip-file fileb://function.zip --role $ROLE_ARN \
  --region $REGION --timeout 30

# Đợi role propagate vài giây nếu báo lỗi assume role
aws lambda create-event-source-mapping \
  --function-name OrderAggregator \
  --event-source-arn $STREAM_ARN \
  --starting-position LATEST \
  --batch-size 100 \
  --maximum-batching-window-in-seconds 5 \
  --function-response-types ReportBatchItemFailures \
  --region $REGION
```

Kiểm tra mapping đã `Enabled`:

```bash
aws lambda list-event-source-mappings --function-name OrderAggregator \
  --region $REGION --query 'EventSourceMappings[0].State'
```
Output mong đợi: `"Enabled"` (lúc đầu có thể là `"Creating"`).

### Bước 5: Ghi vài order và kiểm tra materialized view

```bash
aws dynamodb put-item --table-name Orders --region $REGION \
  --item '{"customerId":{"S":"c1"},"orderId":{"S":"o1"},"amount":{"N":"100"}}'
aws dynamodb put-item --table-name Orders --region $REGION \
  --item '{"customerId":{"S":"c1"},"orderId":{"S":"o2"},"amount":{"N":"50"}}'
aws dynamodb put-item --table-name Orders --region $REGION \
  --item '{"customerId":{"S":"c2"},"orderId":{"S":"o3"},"amount":{"N":"75"}}'

sleep 10
aws dynamodb get-item --table-name CustomerOrderCount --region $REGION \
  --key '{"customerId":{"S":"c1"}}'
```
Output mong đợi: `c1` có `orderCount = 2`, `c2` có `orderCount = 1`. Đây là materialized view được dựng bất đồng bộ từ Stream.

### Bước 6: Bật TTL và quan sát record xoá chảy vào Stream

Bật TTL trên thuộc tính `expireAt` (kiểu Number, là **epoch giây** — KHÔNG phải milli-giây):

```bash
aws dynamodb update-time-to-live --table-name Orders --region $REGION \
  --time-to-live-specification "Enabled=true,AttributeName=expireAt"
```

Ghi một item hết hạn sau 60 giây:

```bash
EXP=$(($(date +%s) + 60))
aws dynamodb put-item --table-name Orders --region $REGION \
  --item "{\"customerId\":{\"S\":\"c1\"},\"orderId\":{\"S\":\"tmp\"},\"expireAt\":{\"N\":\"$EXP\"}}"
```

> Lưu ý: TTL xoá item **không đảm bảo đúng giây** — AWS thường xoá trong vòng ~vài phút tới 48 giờ sau thời điểm hết hạn (typically vài phút với table nhỏ). Khi item bị TTL xoá, một stream record `REMOVE` với `userIdentity.principalId = "dynamodb.amazonaws.com"` được phát đi — nhờ đó Lambda phân biệt được "xoá do TTL" với "xoá do app". Thao tác TTL-delete **không tiêu tốn WCU**.

Sau vài phút, kiểm tra `c1.orderCount` đã giảm về 2 (item `tmp` bị xoá, Lambda trừ 1 — nhưng vì `tmp` được cộng 1 lúc INSERT nên về lại 2).

### Bước 7: Bật PITR và export to S3

```bash
aws dynamodb update-continuous-backups --table-name Orders --region $REGION \
  --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true

# Tạo bucket nhận export
aws s3 mb s3://ddb-export-$ACCOUNT_ID-$REGION --region $REGION

aws dynamodb export-table-to-point-in-time \
  --table-arn arn:aws:dynamodb:$REGION:$ACCOUNT_ID:table/Orders \
  --s3-bucket ddb-export-$ACCOUNT_ID-$REGION \
  --export-format DYNAMODB_JSON \
  --region $REGION
```
Output mong đợi: một `ExportArn` và trạng thái `IN_PROGRESS`. Export đọc dữ liệu từ backup PITR, **không tiêu thụ RCU của bảng** và không ảnh hưởng hiệu năng production. Export chỉ chạy được khi PITR đã bật.

### Dọn dẹp tài nguyên

```bash
# Xoá event source mapping
UUID=$(aws lambda list-event-source-mappings --function-name OrderAggregator \
  --region $REGION --query 'EventSourceMappings[0].UUID' --output text)
aws lambda delete-event-source-mapping --uuid $UUID --region $REGION

aws lambda delete-function --function-name OrderAggregator --region $REGION
aws dynamodb delete-table --table-name Orders --region $REGION
aws dynamodb delete-table --table-name CustomerOrderCount --region $REGION
aws s3 rb s3://ddb-export-$ACCOUNT_ID-$REGION --force

aws iam delete-role-policy --role-name ddb-stream-lambda-role --policy-name stream-access
aws iam detach-role-policy --role-name ddb-stream-lambda-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam delete-role --role-name ddb-stream-lambda-role
rm -f trust.json inline.json index.mjs function.zip
```

> DynamoDB Streams retention là **24 giờ** — không cần dọn riêng, hết hạn tự mất khi xoá bảng. Bucket S3 export phải dọn tay (lệnh `rb --force` ở trên). PITR tắt khi xoá bảng.

## 💡 Exam Tips chương 33

- **DAX là write-through cache cho DynamoDB**, chỉ tăng tốc **eventually consistent reads** (item cache & query cache). Strongly consistent reads đi thẳng qua DAX tới DynamoDB (không cache) → không nhanh hơn. DAX dùng client SDK riêng (DAX client), endpoint cluster, chạy **trong VPC**.
- **DAX vs ElastiCache:** DAX khi cache đối tượng chính là DynamoDB API call (ít/không phải code lại, microsecond latency cho read-heavy + eventually consistent OK). ElastiCache khi cần cấu trúc dữ liệu phức tạp (sorted set, pub/sub), aggregate result tuỳ biến, hoặc cache nhiều nguồn.
- **DAX item cache** lưu kết quả `GetItem`/`BatchGetItem`; **query cache** lưu kết quả `Query`/`Scan`. Write qua DAX là write-through: ghi vào DynamoDB rồi cập nhật item cache.
- **DynamoDB Streams retention = 24 giờ**, không thay đổi được. Có **4 view types**: `KEYS_ONLY`, `NEW_IMAGE`, `OLD_IMAGE`, `NEW_AND_OLD_IMAGES`. Đổi view type phải tắt rồi bật lại stream (tạo stream ARN mới).
- **Global Tables BẮT BUỘC bật DynamoDB Streams** (view type `NEW_AND_OLD_IMAGES`) — đó là cơ chế replication. Xung đột giải quyết bằng **last-writer-wins** (dựa trên timestamp). Global Tables cho multi-region, multi-active (read+write ở mọi region).
- **TTL:** thuộc tính phải kiểu **Number**, giá trị là **Unix epoch theo giây** (không phải ms). Xoá do TTL **không tốn WCU**, nhưng có **độ trễ** (vài phút đến 48h). TTL-delete sinh stream record `REMOVE` với principal `dynamodb.amazonaws.com`.
- **Bẫy TTL kinh điển:** item đã quá hạn TTL **vẫn có thể xuất hiện** trong kết quả `Query`/`Scan` cho đến khi background process xoá. Muốn loại hẳn item hết hạn ngay → thêm **filter expression** so sánh `expireAt > now`.
- **PITR** cho phép khôi phục về bất kỳ thời điểm nào trong **35 ngày** gần nhất, độ chi tiết tới giây. Restore luôn tạo **bảng MỚI** (không ghi đè bảng cũ). On-demand backup giữ vô thời hạn tới khi xoá thủ công.
- **Export to S3** yêu cầu **PITR đã bật**, đọc từ backup nên **không tiêu thụ RCU** và không ảnh hưởng throughput bảng. Định dạng `DYNAMODB_JSON` hoặc `ION`. Khác với Scan (Scan tốn RCU, ảnh hưởng hiệu năng).
- **IAM fine-grained access:** dùng condition `dynamodb:LeadingKeys` để giới hạn user chỉ truy cập item có partition key khớp identity (ví dụ `${cognito-identity.amazonaws.com:sub}`), và `dynamodb:Attributes` để giới hạn cột được đọc/ghi — thường kết hợp Cognito Identity Pool (chi tiết ở Chương 39).
- **DynamoDB Local** là bản chạy offline để dev/test, không phải dịch vụ production; truy cập qua endpoint `http://localhost:8000`.
- Stream + Lambda dùng **event source mapping** (Lambda poll stream theo shard, giữ ordering trong shard). Lỗi xử lý có thể block shard — cấu hình `bisectBatchOnFunctionError`, `maximumRetryAttempts`, on-failure destination (chi tiết ở Chương 30).

## Quiz chương 33 (10 câu)

**Câu 1.** Một ứng dụng đọc cùng vài item DynamoDB rất nhiều lần mỗi giây, chấp nhận eventual consistency, và cần latency cỡ micro-giây mà không muốn sửa nhiều code. Giải pháp nào phù hợp nhất?
- A. Thêm ElastiCache for Redis trước DynamoDB
- B. Dùng DynamoDB Accelerator (DAX)
- C. Bật strongly consistent reads
- D. Tăng RCU provisioned lên 10 lần

**Câu 2.** Để dùng Global Tables, điều kiện tiên quyết nào phải có trên mỗi bảng?
- A. Point-in-Time Recovery
- B. DynamoDB Streams với view type NEW_AND_OLD_IMAGES
- C. Provisioned capacity mode
- D. TTL được bật

**Câu 3.** Một developer bật TTL với attribute `expireAt`. Item đặt `expireAt` cách đây 2 phút nhưng `Query` vẫn trả về nó. Vì sao?
- A. TTL chỉ hoạt động với on-demand mode
- B. `expireAt` phải là kiểu String
- C. TTL xoá có độ trễ; item hết hạn vẫn xuất hiện cho tới khi bị xoá nền — cần filter expression để loại ngay
- D. TTL không hỗ trợ bảng có sort key

**Câu 4.** Khi item bị xoá bởi TTL, điều nào ĐÚNG?
- A. Thao tác tốn 1 WCU cho mỗi item
- B. Không sinh stream record
- C. Sinh stream record REMOVE với principal là dynamodb.amazonaws.com và không tốn WCU
- D. Item bị xoá đồng bộ ngay tại thời điểm hết hạn

**Câu 5.** Team cần khôi phục bảng về trạng thái lúc 14:32 hôm qua sau khi một bản deploy lỗi ghi đè dữ liệu. Họ đã bật PITR. Cách đúng?
- A. Restore PITR ghi đè trực tiếp lên bảng hiện tại
- B. Restore PITR tạo một bảng mới tại thời điểm chỉ định, rồi chuyển traffic sang
- C. Dùng on-demand backup vì PITR không hỗ trợ chọn giờ
- D. Export to S3 rồi import ngược lại bằng Scan

**Câu 6.** Ứng dụng cần audit log mọi thay đổi item và đẩy sang một hệ thống phân tích, đảm bảo xử lý theo thứ tự trong từng partition key. Giải pháp ít vận hành nhất?
- A. Bật DynamoDB Streams + Lambda event source mapping
- B. Cron Scan định kỳ so sánh diff
- C. Ghi đồng thời vào DynamoDB và SQS từ application code
- D. Bật CloudTrail data events cho mọi PutItem

**Câu 7.** Một developer muốn DAX tăng tốc các lệnh đọc, nhưng thấy `GetItem` với `ConsistentRead=true` không nhanh hơn. Vì sao?
- A. DAX không hỗ trợ GetItem
- B. Strongly consistent read đi qua DAX nhưng phải tới DynamoDB lấy bản mới nhất, không phục vụ từ cache
- C. DAX chỉ cache Query, không cache GetItem
- D. Cần bật DAX encryption mới có cache

**Câu 8.** Cần export 500 GB từ bảng DynamoDB sang S3 cho team data lake mà KHÔNG ảnh hưởng throughput production. Cách đúng?
- A. Parallel Scan với nhiều segment
- B. Bật PITR rồi dùng Export to S3 (đọc từ backup, không tốn RCU)
- C. Tăng RCU tạm thời rồi Scan
- D. Dùng DynamoDB Streams ghi ra S3

**Câu 9.** Trong Global Table 2 region, cùng một item được ghi gần như đồng thời ở cả hai region với giá trị khác nhau. Kết quả cuối cùng được quyết định thế nào?
- A. Ghi ở region chính (primary) thắng
- B. DynamoDB từ chối cả hai ghi
- C. Last-writer-wins dựa trên timestamp
- D. Hai phiên bản cùng tồn tại, app phải tự merge

**Câu 10.** Một mobile app cho phép mỗi user chỉ đọc/ghi item của chính họ trong bảng dùng chung (partition key = userId). Cách thực thi an toàn nhất ở tầng IAM?
- A. Tạo một IAM user riêng cho mỗi end user
- B. IAM policy với condition `dynamodb:LeadingKeys` khớp `${cognito-identity.amazonaws.com:sub}`, cấp qua Cognito Identity Pool
- C. Filter expression trong mọi Query
- D. Mã hoá userId bằng KMS

### Đáp án & giải thích

**Câu 1 — Đáp án B.** DAX cho microsecond latency, write-through, gần như không phải sửa code (chỉ đổi sang DAX client) và tối ưu cho read-heavy + eventually consistent. A (ElastiCache) phải tự viết logic cache-aside, nhiều code hơn. C strongly consistent read còn chậm hơn và không phải là cache. D tăng RCU giảm throttle nhưng không đạt micro-giây và tốn kém.

**Câu 2 — Đáp án B.** Global Tables dùng Streams (NEW_AND_OLD_IMAGES) làm cơ chế replication, đây là điều kiện bắt buộc. A PITR không liên quan replication. C Global Tables hỗ trợ cả on-demand lẫn provisioned — không bắt buộc provisioned. D TTL độc lập, không cần cho replication.

**Câu 3 — Đáp án C.** TTL xoá theo background process, có độ trễ (vài phút–48h); trong thời gian đó item vẫn nằm trong bảng và xuất hiện ở Query/Scan. Muốn loại ngay phải thêm filter expression `expireAt > :now`. A sai: TTL hoạt động ở mọi billing mode. B sai: attribute TTL phải là Number (epoch giây). D sai: TTL không phụ thuộc sort key.

**Câu 4 — Đáp án C.** TTL-delete không tốn WCU và sinh stream record REMOVE với `userIdentity.principalId = dynamodb.amazonaws.com` để app phân biệt. A sai (không tốn WCU). B sai (vẫn có stream record). D sai (có độ trễ, không đồng bộ).

**Câu 5 — Đáp án B.** Restore PITR (và cả restore từ backup) luôn tạo bảng MỚI; ứng dụng chuyển traffic sang bảng mới. A sai: không ghi đè bảng hiện tại được. C sai: PITR hỗ trợ chọn tới giây trong 35 ngày. D vòng vo, không cần.

**Câu 6 — Đáp án A.** Streams + Lambda là giải pháp managed cho change data capture, giữ ordering trong từng shard (theo partition key). B Scan định kỳ tốn RCU, không real-time, dễ miss thay đổi. C ghi kép dễ mất nhất quán nếu một bên fail. D CloudTrail data events ghi API call cho audit nhưng không tiện đẩy nội dung item theo thứ tự sang hệ phân tích.

**Câu 7 — Đáp án B.** DAX không phục vụ strongly consistent read từ cache; nó phải gọi DynamoDB lấy giá trị mới nhất nên không nhanh hơn. A sai: DAX hỗ trợ GetItem (item cache). C sai: DAX cache cả GetItem (item cache) lẫn Query (query cache). D sai: encryption không liên quan caching.

**Câu 8 — Đáp án B.** Export to S3 đọc từ backup PITR, không tốn RCU và không ảnh hưởng bảng — đúng cho dataset lớn. A và C đều dùng Scan, tiêu thụ RCU và ảnh hưởng production. D Streams chỉ bắt thay đổi mới (24h), không export toàn bộ snapshot hiện có.

**Câu 9 — Đáp án C.** Global Tables giải quyết xung đột bằng last-writer-wins dựa trên timestamp. A sai: Global Tables multi-active, không có "primary". B sai: không từ chối ghi. D sai: không giữ nhiều phiên bản chờ merge (đó là mô hình của AppSync conflict resolution, không phải Global Tables).

**Câu 10 — Đáp án B.** Fine-grained access dùng condition `dynamodb:LeadingKeys` để chỉ cho phép truy cập item có partition key khớp identity, cấp credentials tạm qua Cognito Identity Pool — đúng pattern và scale. A tạo IAM user cho mỗi end user không khả thi (giới hạn 5000 user/account, sai mô hình). C filter expression vẫn cho phép app gọi đọc toàn bảng, không phải kiểm soát IAM. D mã hoá không giới hạn quyền truy cập.

## Tóm tắt chương

- **DAX** là in-memory write-through cache đặt trước DynamoDB, cho microsecond latency với **eventually consistent reads**; gồm **item cache** (GetItem/BatchGetItem) và **query cache** (Query/Scan). Chạy trong VPC, dùng DAX client riêng.
- **Strongly consistent reads không được cache** bởi DAX — chúng đi xuyên qua tới DynamoDB. Đây là điểm đề thi hay gài.
- Chọn **DAX** khi đối tượng cache chính là DynamoDB và muốn ít code; chọn **ElastiCache** khi cần cấu trúc dữ liệu/aggregate phức tạp hoặc nhiều nguồn dữ liệu.
- **DynamoDB Streams** ghi lại thay đổi item theo thứ tự trong từng shard, retention **24 giờ**, 4 view types; tích hợp Lambda qua **event source mapping** cho audit, replication, materialized view.
- **TTL**: attribute kiểu **Number = epoch giây**; xoá **không tốn WCU** nhưng **có độ trễ** (vài phút–48h); item hết hạn vẫn có thể hiện trong Query cho tới khi bị xoá → cần filter expression. TTL-delete sinh stream record REMOVE với principal `dynamodb.amazonaws.com`.
- **Global Tables**: multi-region, multi-active; **bắt buộc bật Streams (NEW_AND_OLD_IMAGES)**; giải quyết xung đột bằng **last-writer-wins**.
- **PITR**: khôi phục tới bất kỳ giây nào trong **35 ngày**; restore luôn tạo **bảng mới**. **On-demand backup** giữ vô thời hạn tới khi xoá thủ công.
- **Export to S3** cần PITR, đọc từ backup nên **không tốn RCU**, không ảnh hưởng throughput; định dạng DYNAMODB_JSON hoặc ION — khác hẳn Scan.
- **IAM fine-grained access** với `dynamodb:LeadingKeys` và `dynamodb:Attributes` giới hạn user theo partition key và cột, thường kết hợp Cognito Identity Pool.
- **DynamoDB Local** dùng để dev/test offline qua endpoint `localhost:8000`, không phải production.
- Quyền IAM cho Lambda đọc stream phải đặt trên **stream ARN** (có hậu tố `/stream/<timestamp>`), không phải table ARN — sai chỗ này là lỗi cấu hình phổ biến.
- Stream + Lambda giữ thứ tự theo shard nhưng lỗi xử lý có thể block shard; dùng partial batch response, bisect on error và on-failure destination để xử lý an toàn (chi tiết ở Chương 30).
