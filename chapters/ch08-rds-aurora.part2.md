## Hands-on Lab: RDS MySQL với Multi-AZ, Read Replica, IAM Database Authentication và failover thử nghiệm

**Mục tiêu lab:** Tạo một RDS MySQL instance bằng AWS CLI v2 với storage auto scaling và IAM database authentication; kết nối bằng auth token thay vì password; tạo Read Replica; chụp manual snapshot; ép failover Multi-AZ và quan sát endpoint không đổi. Lab này cover gần như toàn bộ phạm vi thi của chương (Aurora-specific như endpoints/Serverless chỉ mô phỏng được bằng console nên ta dùng RDS MySQL cho rẻ).

**Chuẩn bị:**
- AWS CLI v2 đã cấu hình profile có quyền `rds:*`, `ec2:Describe*`, `ec2:CreateSecurityGroup`, `ec2:AuthorizeSecurityGroupIngress`, `iam:*` mức lab (chi tiết IAM ở Chương 2).
- `mysql` client cài sẵn (`brew install mysql-client` hoặc `apt install mysql-client`).
- **Chi phí:** `db.t3.micro` Single-AZ nằm trong free tier; bật Multi-AZ và Read Replica sẽ TÍNH TIỀN (~vài cent/giờ mỗi instance). Làm xong dọn ngay — phần Dọn dẹp ở cuối là bắt buộc.

### Bước 1: Tạo security group cho database

```bash
# Lấy default VPC
VPC_ID=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text)

SG_ID=$(aws ec2 create-security-group \
  --group-name lab-rds-sg \
  --description "Lab RDS ch08" \
  --vpc-id $VPC_ID \
  --query 'GroupId' --output text)

# Mở port 3306 từ IP máy bạn (đừng mở 0.0.0.0/0 với DB thật)
MY_IP=$(curl -s https://checkip.amazonaws.com)
aws ec2 authorize-security-group-ingress \
  --group-id $SG_ID --protocol tcp --port 3306 --cidr ${MY_IP}/32
```

Lưu ý production: RDS nên nằm ở private subnet và chỉ nhận traffic từ SG của app tier (referencing SG — Chương 4), nhưng lab này dùng publicly accessible cho nhanh.

### Bước 2: Tạo RDS MySQL instance với storage auto scaling + IAM auth

```bash
aws rds create-db-instance \
  --db-instance-identifier lab-mysql \
  --engine mysql \
  --engine-version 8.0.39 \
  --db-instance-class db.t3.micro \
  --master-username admin \
  --master-user-password 'Lab12345!' \
  --allocated-storage 20 \
  --max-allocated-storage 50 \
  --storage-type gp3 \
  --vpc-security-group-ids $SG_ID \
  --backup-retention-period 7 \
  --enable-iam-database-authentication \
  --publicly-accessible \
  --no-multi-az
```

Giải mã các flag quan trọng cho đề thi:
- `--max-allocated-storage 50` chính là **storage auto scaling**: RDS tự tăng dung lượng khi free space < 10% kéo dài ≥ 5 phút và đã qua ≥ 6 giờ kể từ lần tăng trước. Chỉ tăng, **không bao giờ tự giảm**.
- `--backup-retention-period 7`: bật automated backup 7 ngày → cho phép **point-in-time recovery (PITR)**. Đặt 0 là TẮT backup (và là điều kiện bắt buộc phải ≥ 1 nếu muốn tạo Read Replica từ MySQL).
- `--enable-iam-database-authentication`: bật IAM DB auth ngay từ đầu (có thể modify sau, không cần downtime).

Chờ instance available (mất 5–10 phút):

```bash
aws rds wait db-instance-available --db-instance-identifier lab-mysql

ENDPOINT=$(aws rds describe-db-instances --db-instance-identifier lab-mysql \
  --query 'DBInstances[0].Endpoint.Address' --output text)
echo $ENDPOINT
# Output mong đợi: lab-mysql.xxxxxxxxxxxx.ap-southeast-1.rds.amazonaws.com
```

### Bước 3: Kết nối và tạo user cho IAM authentication

```bash
mysql -h $ENDPOINT -u admin -p'Lab12345!' -e "
CREATE USER 'iam_user' IDENTIFIED WITH AWSAuthenticationPlugin AS 'RDS';
GRANT SELECT, INSERT ON *.* TO 'iam_user';
CREATE DATABASE labdb;
CREATE TABLE labdb.notes (id INT PRIMARY KEY AUTO_INCREMENT, body VARCHAR(255));
INSERT INTO labdb.notes (body) VALUES ('hello from primary');
"
```

Điểm mấu chốt: user MySQL được tạo với plugin `AWSAuthenticationPlugin` — **không có password trong DB**. Việc xác thực được uỷ quyền cho IAM.

### Bước 4: Tạo IAM policy và kết nối bằng auth token

IAM principal cần quyền `rds-db:connect` trên resource ARN dạng `arn:aws:rds-db:<region>:<account>:dbuser:<DbiResourceId>/<db-username>`:

```bash
RESOURCE_ID=$(aws rds describe-db-instances --db-instance-identifier lab-mysql \
  --query 'DBInstances[0].DbiResourceId' --output text)
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=$(aws configure get region)

aws iam put-user-policy --user-name <your-iam-user> --policy-name rds-connect \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Effect\": \"Allow\",
      \"Action\": \"rds-db:connect\",
      \"Resource\": \"arn:aws:rds-db:${REGION}:${ACCOUNT_ID}:dbuser:${RESOURCE_ID}/iam_user\"
    }]
  }"
```

Sinh auth token và kết nối:

```bash
TOKEN=$(aws rds generate-db-auth-token \
  --hostname $ENDPOINT --port 3306 --username iam_user)

mysql -h $ENDPOINT -u iam_user --password="$TOKEN" \
  --enable-cleartext-plugin --ssl-mode=REQUIRED \
  -e "SELECT * FROM labdb.notes;"
# Output mong đợi:
# +----+--------------------+
# | id | body               |
# +----+--------------------+
# |  1 | hello from primary |
# +----+--------------------+
```

Ba điều đề thi hay xoáy: (1) token do **client tự ký bằng SigV4** — `generate-db-auth-token` là phép tính local, không gọi API nào; (2) token sống **15 phút**, dùng để mở connection, connection đã mở không bị cắt khi token hết hạn; (3) **bắt buộc TLS** khi dùng IAM auth.

### Bước 5: Tạo Read Replica

```bash
aws rds create-db-instance-read-replica \
  --db-instance-identifier lab-mysql-rr \
  --source-db-instance-identifier lab-mysql \
  --db-instance-class db.t3.micro

aws rds wait db-instance-available --db-instance-identifier lab-mysql-rr

RR_ENDPOINT=$(aws rds describe-db-instances --db-instance-identifier lab-mysql-rr \
  --query 'DBInstances[0].Endpoint.Address' --output text)

# Đọc được trên replica (replication ASYNC nên có thể trễ vài giây)
mysql -h $RR_ENDPOINT -u admin -p'Lab12345!' -e "SELECT * FROM labdb.notes;"

# Ghi vào replica sẽ FAIL — replica là read-only
mysql -h $RR_ENDPOINT -u admin -p'Lab12345!' \
  -e "INSERT INTO labdb.notes (body) VALUES ('fail');"
# Output mong đợi: ERROR 1290 (HY000): ... --read-only option ...
```

Quan sát replication lag bằng CloudWatch metric `ReplicaLag` (đơn vị giây) — đây là metric kinh điển trong đề khi hỏi "user phàn nàn đọc dữ liệu cũ trên replica".

### Bước 6: Bật Multi-AZ và ép failover

```bash
# Convert sang Multi-AZ — chạy ngầm, không downtime, nhưng có spike I/O do snapshot
aws rds modify-db-instance --db-instance-identifier lab-mysql \
  --multi-az --apply-immediately
aws rds wait db-instance-available --db-instance-identifier lab-mysql

# Ép failover để quan sát
aws rds reboot-db-instance --db-instance-identifier lab-mysql --force-failover
```

Trong lúc failover, chạy lặp `mysql ... -e "SELECT 1"` bạn sẽ thấy connection lỗi khoảng 60–120 giây rồi tự hoạt động lại — **endpoint DNS không đổi**, RDS chỉ flip DNS record sang standby. Đây là điểm khác biệt then chốt với Read Replica (mỗi replica có endpoint riêng, muốn "failover" sang replica phải promote thủ công và sửa connection string).

### Bước 7: Manual snapshot và kiểm tra PITR window

```bash
aws rds create-db-snapshot \
  --db-instance-identifier lab-mysql --db-snapshot-identifier lab-mysql-snap1
aws rds wait db-snapshot-available --db-snapshot-identifier lab-mysql-snap1

# Xem mốc PITR muộn nhất có thể restore
aws rds describe-db-instances --db-instance-identifier lab-mysql \
  --query 'DBInstances[0].LatestRestorableTime'
# Output mong đợi: "2026-06-12T03:21:00+00:00" (thường trễ ~5 phút so với hiện tại)
```

Nhớ cơ chế: restore (từ snapshot hay PITR) luôn tạo ra **instance MỚI với endpoint MỚI** — không bao giờ ghi đè instance cũ. Manual snapshot tồn tại vô hạn; automated backup bị xoá theo retention và khi xoá instance.

### Dọn dẹp tài nguyên

```bash
# Xoá replica trước, rồi instance chính
aws rds delete-db-instance --db-instance-identifier lab-mysql-rr \
  --skip-final-snapshot
aws rds delete-db-instance --db-instance-identifier lab-mysql \
  --skip-final-snapshot --delete-automated-backups

aws rds wait db-instance-deleted --db-instance-identifier lab-mysql-rr
aws rds wait db-instance-deleted --db-instance-identifier lab-mysql

# Xoá manual snapshot (KHÔNG tự xoá theo instance)
aws rds delete-db-snapshot --db-snapshot-identifier lab-mysql-snap1

# Xoá security group và IAM policy
aws ec2 delete-security-group --group-id $SG_ID
aws iam delete-user-policy --user-name <your-iam-user> --policy-name rds-connect
```

Kiểm tra lại bằng `aws rds describe-db-instances` và `aws rds describe-db-snapshots --snapshot-type manual` để chắc chắn không còn gì tính tiền.

## 💡 Exam Tips chương 8

- **Multi-AZ vs Read Replica** — câu hỏi số 1 của chương: Multi-AZ = **synchronous**, một standby KHÔNG đọc được, mục đích **availability/DR**, failover tự động ~60–120 giây, cùng endpoint. Read Replica = **asynchronous**, đọc được, mục đích **scale read**, endpoint riêng, muốn thay primary phải promote thủ công. Từ khoá "improve read performance" → Read Replica; "withstand AZ failure / high availability" → Multi-AZ.
- Read Replica hỗ trợ **cross-region** và replica của replica; tối đa **15 replicas** cho RDS (MySQL/PostgreSQL/MariaDB). Replication traffic cùng region giữa các AZ **không mất phí**, cross-region thì mất phí data transfer.
- Failover Multi-AZ là **DNS flip** — app không cần đổi connection string, nhưng phải cài retry logic và đừng cache DNS vô hạn (JVM hay dính bẫy này; Node.js mặc định ổn).
- **Aurora lưu 6 bản copy dữ liệu trên 3 AZ**; ghi cần quorum 4/6, đọc cần 3/6. Storage tự grow tới **128 TiB**. Tối đa **15 Aurora Replicas**, failover sang replica < 30 giây.
- **Aurora endpoints:** writer (cluster) endpoint → instance đang là writer; **reader endpoint** → load-balance connection (không phải per-query) qua các replica; custom endpoint → nhóm instance chỉ định (ví dụ vài replica to cho analytics). Câu "direct analytics queries away from production traffic" → custom endpoint hoặc reader endpoint.
- **Aurora Global Database:** replication storage-level cross-region, lag điển hình **< 1 giây**, RTO promote secondary region **< 1 phút**, tối đa 5 secondary regions. Từ khoá "low-latency global reads / cross-region DR với RPO ~1s" → Global Database, không phải cross-region Read Replica.
- **RDS Proxy** dành cho bài toán "Lambda mở quá nhiều connection làm cạn max_connections" → connection pooling, multiplexing, giảm failover time tới ~66%, **bắt buộc cùng VPC** (không truy cập public được). Proxy còn tích hợp IAM auth và Secrets Manager (chi tiết Secrets Manager ở Chương 47).
- **IAM database authentication:** token 15 phút, sinh local bằng SigV4 (`generate-db-auth-token`), bắt buộc SSL/TLS, quyền IAM là `rds-db:connect`. Phù hợp app trên EC2/Lambda dùng role thay vì lưu password. Không thay thế authorization trong DB (GRANT vẫn ở tầng engine).
- **Encryption at rest:** bật **lúc tạo instance**; muốn mã hoá DB đang chạy unencrypted → snapshot → **copy snapshot với KMS key** → restore từ snapshot copy. Replica của instance encrypted phải encrypted. Snapshot của DB encrypted thì encrypted. Cross-region copy phải chỉ định KMS key ở region đích (KMS key là regional — Chương 46).
- **Storage auto scaling:** chỉ tăng không giảm, trigger khi free < 10% trong ≥ 5 phút, cooldown 6 giờ; đặt `--max-allocated-storage`. Câu "database sắp đầy disk, least operational overhead" → bật storage auto scaling, không phải migrate.
- Backup: automated backup retention **0–35 ngày**, cho PITR tới `LatestRestorableTime` (trễ ~5 phút); manual snapshot giữ vô hạn. Restore luôn tạo **instance mới**. Xoá instance: automated backup mất (trừ khi retain), manual snapshot ở lại.
- **Aurora Serverless v2:** scale theo ACU (0.5 ACU step), phù hợp workload không đoán trước/intermittent; v2 scale tại chỗ không gián đoạn connection (khác v1 phải tìm scaling point). Từ khoá "infrequent, intermittent, unpredictable workload" → Aurora Serverless.

## Quiz chương 8 (10 câu)

**Câu 1.** Một ứng dụng e-commerce dùng RDS MySQL đang bị chậm vì các báo cáo BI chạy SELECT nặng vào giờ cao điểm. Developer cần giảm tải cho database chính với ít thay đổi kiến trúc nhất. Giải pháp nào đúng?
- A. Bật Multi-AZ và trỏ các query báo cáo vào standby instance
- B. Tạo Read Replica và trỏ các query báo cáo vào endpoint của replica
- C. Tăng instance class của database chính
- D. Bật storage auto scaling

**Câu 2.** RDS PostgreSQL Multi-AZ gặp sự cố AZ và failover sang standby. Ứng dụng cần làm gì để tiếp tục hoạt động?
- A. Cập nhật connection string sang endpoint của standby
- B. Promote standby thành primary bằng API
- C. Không cần làm gì ngoài retry connection — DNS endpoint không đổi
- D. Restore từ snapshot mới nhất sang instance mới

**Câu 3.** Một Lambda function scale lên hàng trăm concurrent executions và làm RDS MySQL hết connection (`Too many connections`). Cách khắc phục được AWS khuyến nghị với ít thay đổi code nhất?
- A. Tăng max_connections trong parameter group lên giá trị rất lớn
- B. Chuyển sang DynamoDB
- C. Dùng RDS Proxy giữa Lambda và RDS
- D. Tạo thêm Read Replica để chia connection

**Câu 4.** Công ty cần ứng dụng đọc dữ liệu Aurora MySQL từ 3 region khác nhau với độ trễ thấp, đồng thời có khả năng DR với RPO khoảng 1 giây. Giải pháp nào phù hợp?
- A. Aurora Read Replicas trong cùng cluster đặt ở 3 region
- B. Aurora Global Database với secondary clusters ở các region cần đọc
- C. RDS cross-region Read Replica cho từng region
- D. DynamoDB Global Tables

**Câu 5.** Một RDS MySQL instance đang chạy KHÔNG bật encryption. Yêu cầu compliance buộc dữ liệu phải được mã hoá at rest. Developer phải làm gì?
- A. Modify instance và tick "Enable encryption", apply immediately
- B. Tạo snapshot, copy snapshot với KMS key, restore instance mới từ snapshot đã mã hoá, trỏ app sang endpoint mới
- C. Bật default encryption ở account level, RDS sẽ tự mã hoá
- D. Tạo encrypted Read Replica rồi promote

**Câu 6.** Ứng dụng Node.js trên EC2 dùng IAM database authentication với RDS MySQL. Thỉnh thoảng kết nối mới bị lỗi "Access denied" dù IAM policy đúng. Nguyên nhân khả dĩ nhất?
- A. Auth token đã quá 15 phút kể từ khi sinh ra, app cache token quá lâu
- B. IAM auth chỉ hoạt động với Aurora, không hoạt động với RDS MySQL
- C. Connection đang mở bị cắt khi token hết hạn
- D. RDS chỉ cho tối đa 20 connection qua IAM auth

**Câu 7.** Một Aurora cluster có 1 writer và 4 replicas. Team analytics muốn chạy query nặng chỉ trên 2 replica cấu hình lớn, không ảnh hưởng 2 replica đang phục vụ traffic người dùng. Cách cấu hình đúng?
- A. Dùng reader endpoint vì nó tự định tuyến query nặng sang replica lớn
- B. Tạo custom endpoint chứa 2 replica lớn và cho team analytics dùng endpoint đó
- C. Kết nối thẳng vào instance endpoint của writer
- D. Tạo cluster Aurora thứ hai và bật binlog replication

**Câu 8.** Database admin lỡ chạy lệnh DELETE sai lúc 14:32. RDS MySQL có automated backup với retention 7 ngày và LatestRestorableTime là 14:55. Cách khôi phục dữ liệu về thời điểm 14:31?
- A. Restore point-in-time về 14:31 — RDS sẽ ghi đè dữ liệu lên instance hiện tại
- B. Restore point-in-time về 14:31 thành instance MỚI, sau đó trỏ ứng dụng/migrate dữ liệu cần thiết
- C. Failover Multi-AZ vì standby chưa nhận lệnh DELETE
- D. Restore manual snapshot gần nhất là đủ chính xác đến từng phút

**Câu 9.** Một startup có workload database "chạy vài giờ mỗi ngày, lưu lượng không đoán trước, có ngày không dùng". Họ muốn tối ưu chi phí với ít vận hành nhất. Lựa chọn nào hợp lý?
- A. RDS MySQL trên db.r6g.4xlarge Reserved Instance
- B. Aurora Serverless v2
- C. Aurora provisioned với 15 replicas
- D. RDS Multi-AZ với storage auto scaling

**Câu 10.** Ứng dụng đọc từ RDS Read Replica báo cáo người dùng thấy dữ liệu cũ vài giây sau khi ghi. Developer cần theo dõi vấn đề này bằng metric nào và bản chất là gì?
- A. CPUUtilization — replica quá tải CPU nên trả dữ liệu cũ
- B. ReplicaLag — replication của Read Replica là asynchronous nên dữ liệu cũ là hành vi bình thường
- C. FreeStorageSpace — replica hết disk nên dừng nhận dữ liệu
- D. DatabaseConnections — quá nhiều connection làm replication dừng

### Đáp án & giải thích

**Câu 1 — Đáp án B.** Read Replica sinh ra đúng cho use case offload read-heavy workload (báo cáo/BI): replication async, replica đọc được, app chỉ cần trỏ query báo cáo sang endpoint replica. **A sai** vì standby của Multi-AZ KHÔNG nhận read traffic (với RDS truyền thống). **C sai** vì scale-up giải quyết tạm thời, tốn tiền hơn và vẫn để báo cáo cạnh tranh tài nguyên với OLTP. **D sai** vì storage auto scaling chỉ giải quyết dung lượng disk, không liên quan query load.

**Câu 2 — Đáp án C.** Failover Multi-AZ là tự động: RDS flip DNS của endpoint sang standby, app chỉ cần retry và mở connection mới. **A sai** vì standby không có endpoint riêng cho app, endpoint cluster giữ nguyên. **B sai** vì "promote" là thao tác của Read Replica, không phải Multi-AZ standby. **D sai** vì restore tạo instance mới, mất thời gian và mất dữ liệu sau snapshot — hoàn toàn không cần khi đã có Multi-AZ.

**Câu 3 — Đáp án C.** RDS Proxy được thiết kế chính xác cho pattern Lambda + RDS: pool và multiplex connections, app chỉ đổi hostname sang proxy endpoint. **A sai** vì tăng max_connections chỉ đẩy giới hạn lên — memory của instance vẫn cạn, và mỗi cold start Lambda vẫn mở connection mới. **B sai** vì migrate sang DynamoDB là thay đổi kiến trúc khổng lồ, không phải "ít thay đổi code nhất". **D sai** vì Read Replica giải quyết read scaling, không giải quyết số lượng connection tới writer (mỗi replica còn thêm endpoint phải quản lý).

**Câu 4 — Đáp án B.** Aurora Global Database replicate ở tầng storage cross-region với lag dưới 1 giây, cho phép đọc local ở từng region và promote secondary trong < 1 phút khi DR. **A sai** vì Aurora Replicas trong cùng cluster chỉ nằm trong 1 region (Global Database mới trải nhiều region). **C sai** vì RDS cross-region replica dùng logical replication, lag cao và không đoán trước, RPO ~1s khó đảm bảo. **D sai** vì DynamoDB Global Tables là NoSQL — đổi cả data model, đề bài đang dùng Aurora MySQL.

**Câu 5 — Đáp án B.** Không thể bật encryption trên instance đang chạy; con đường chuẩn là snapshot → copy snapshot kèm KMS key (bước copy mới cho phép đổi trạng thái encryption) → restore thành instance mới → cutover. **A sai** vì console/API không có option modify encryption cho instance tồn tại. **C sai** vì không tồn tại "account-level default encryption" tự áp lên RDS đang chạy. **D sai** vì không thể tạo encrypted replica từ source unencrypted (RDS yêu cầu replica cùng trạng thái encryption với source).

**Câu 6 — Đáp án A.** Auth token chỉ có hiệu lực 15 phút để **mở** connection; nếu app sinh token một lần rồi cache để mở connection mới mãi về sau thì các connection mở sau 15 phút sẽ bị từ chối. Fix: sinh token mới mỗi lần mở connection (đó là phép tính local, rất rẻ). **B sai** vì IAM auth hỗ trợ RDS MySQL/PostgreSQL/MariaDB và Aurora. **C sai** ngược cơ chế — connection đã mở KHÔNG bị cắt khi token hết hạn. **D sai** vì không có giới hạn 20 connection; chỉ có khuyến nghị giới hạn ~200 lần mở connection mới/giây qua IAM auth.

**Câu 7 — Đáp án B.** Custom endpoint cho phép gom một tập instance chỉ định (2 replica lớn) vào một DNS endpoint riêng — đúng cho bài toán tách workload analytics. **A sai** vì reader endpoint load-balance qua TẤT CẢ replicas, không phân biệt to nhỏ và không định tuyến theo độ nặng query. **C sai** vì dồn query nặng vào writer là điều cần tránh nhất. **D sai** vì cluster thứ hai + binlog là giải pháp tự chế tốn kém, Aurora đã có sẵn custom endpoint.

**Câu 8 — Đáp án B.** PITR replay transaction logs trên nền automated backup để dựng dữ liệu tại 14:31, nhưng kết quả luôn là một **instance mới với endpoint mới** — sau đó bạn tự cutover hoặc copy dữ liệu về. **A sai** vì restore không bao giờ ghi đè instance hiện tại. **C sai** vì Multi-AZ replication là synchronous — lệnh DELETE đã sang standby ngay lập tức; Multi-AZ không phải backup. **D sai** vì manual snapshot chỉ khôi phục đúng thời điểm chụp, không đến được mốc 14:31 tuỳ ý như PITR.

**Câu 9 — Đáp án B.** "Intermittent, unpredictable, có lúc idle" là từ khoá chuẩn của Aurora Serverless: tự scale ACU theo tải, trả tiền theo capacity dùng thực tế. **A sai** vì Reserved Instance cỡ lớn là cam kết trả tiền 24/7 — ngược hoàn toàn với workload chạy vài giờ/ngày. **C sai** vì 15 replicas là giải pháp read scaling cho tải lớn liên tục, đắt và thừa. **D sai** vì Multi-AZ + storage auto scaling giải quyết availability và dung lượng, không giải quyết chi phí compute khi idle.

**Câu 10 — Đáp án B.** Read Replica replication là **asynchronous**, nên đọc thấy dữ liệu cũ vài giây (eventual consistency) là hành vi thiết kế; metric theo dõi là `ReplicaLag` (giây) trong CloudWatch, alarm khi lag vượt ngưỡng (CloudWatch Alarms chi tiết ở Chương 24). **A sai** vì CPU cao có thể làm lag tăng nhưng metric trực tiếp đo độ trễ replication là ReplicaLag. **C sai** vì hết disk gây lỗi rõ ràng chứ không phải "dữ liệu cũ vài giây" đều đặn. **D sai** vì số connection không phải thước đo độ trễ replication.

## Tóm tắt chương

- RDS là managed relational database (MySQL, PostgreSQL, MariaDB, Oracle, SQL Server, Db2 + Aurora): AWS lo patching, backup, failover; bạn không có SSH vào host.
- **Multi-AZ** = synchronous standby cùng region khác AZ, phục vụ availability; failover tự động ~60–120 giây bằng DNS flip, endpoint không đổi, standby không đọc được.
- **Read Replica** = asynchronous, tối đa 15 (RDS), có endpoint riêng, hỗ trợ cross-region, dùng để scale read; theo dõi bằng metric `ReplicaLag`; promote thủ công khi cần biến thành DB độc lập.
- Automated backup (retention 0–35 ngày) cho **PITR** tới `LatestRestorableTime`; manual snapshot giữ vô hạn; mọi restore tạo instance MỚI với endpoint mới.
- **Storage auto scaling** chỉ tăng (free < 10% trong ≥ 5 phút, cooldown 6 giờ, trần `max-allocated-storage`), không bao giờ giảm.
- **Aurora**: storage 6 copies/3 AZ, quorum ghi 4/6, tự grow tới 128 TiB; 15 replicas, failover < 30 giây; replicas dùng chung storage nên lag thường ~ms.
- **Aurora endpoints**: writer (ghi), reader (load-balance connection qua replicas), custom (nhóm instance chỉ định), instance endpoint (debug/trường hợp đặc biệt).
- **Aurora Serverless v2** scale theo ACU cho workload intermittent/unpredictable; **Aurora Global Database** cho global reads + DR cross-region với lag < 1s, promote < 1 phút.
- **RDS Proxy**: connection pooling/multiplexing cho Lambda và app nhiều connection ngắn, giảm failover time, chỉ truy cập trong VPC, tích hợp IAM auth + Secrets Manager.
- **IAM database authentication**: token 15 phút sinh local bằng SigV4, quyền `rds-db:connect`, bắt buộc TLS; thay password bằng IAM credentials/role.
- **Encryption at rest** (KMS) phải bật lúc tạo; mã hoá DB đang chạy = snapshot → copy có KMS key → restore mới; replica/snapshot kế thừa trạng thái encryption. In transit dùng TLS với CA bundle của RDS.
- Bẫy chọn dịch vụ: "scale read" → Read Replica; "high availability" → Multi-AZ; "global read + DR" → Aurora Global; "Lambda hết connection" → RDS Proxy; "unpredictable workload" → Aurora Serverless.
