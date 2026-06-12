# Chương 8: RDS & Aurora

> **Trọng tâm DVA-C02:** RDS/Aurora xuất hiện chủ yếu ở dạng câu hỏi tình huống: phân biệt Read Replica (scale read, async) với Multi-AZ (high availability, sync, failover tự động); chọn endpoint Aurora đúng cho từng loại traffic; khi nào dùng RDS Proxy với Lambda; và cấu hình encryption/IAM authentication. Đề ít hỏi tham số tuning DB, nhưng hỏi rất kỹ về **kiến trúc** và **hệ quả của từng lựa chọn** (connection string có đổi không, downtime có không, dữ liệu lag bao nhiêu).

## Mục tiêu chương

- Hiểu RDS là gì, quản lý giúp bạn những gì và đánh đổi gì so với tự cài DB trên EC2.
- Phân biệt rạch ròi Read Replica vs Multi-AZ — cặp khái niệm bị gài bẫy nhiều nhất trong đề.
- Nắm cơ chế backup tự động, snapshot thủ công, point-in-time restore và các hệ quả khi restore.
- Hiểu kiến trúc storage của Aurora (6 bản sao, 3 AZ), các loại endpoint và khi nào dùng Aurora Serverless / Global Database.
- Biết RDS Proxy giải quyết bài toán gì (đặc biệt với Lambda) và cách bật IAM database authentication.
- Cấu hình encryption at rest (KMS) và in transit (TLS) đúng cách, biết các giới hạn khi bật/tắt encryption.

## 8.1 RDS tổng quan: managed relational database

**Amazon RDS (Relational Database Service)** là dịch vụ database quan hệ được AWS quản lý. Bạn không SSH vào được instance bên dưới — AWS lo phần OS patching, cài đặt engine, backup tự động, monitoring, và failover. Bạn chỉ làm việc qua endpoint (hostname:port) như với bất kỳ DB server nào.

Các engine RDS hỗ trợ: **MySQL, PostgreSQL, MariaDB, Oracle, Microsoft SQL Server, IBM Db2**, và **Aurora** (engine riêng của AWS, tương thích MySQL/PostgreSQL — chi tiết ở mục 8.5). Với DVA-C02 bạn không cần nhớ version, chỉ cần nhận diện engine nào là RDS và Aurora khác gì.

### RDS vs tự quản DB trên EC2

Câu hỏi "vì sao dùng RDS thay vì cài MySQL lên EC2" là dạng so sánh trách nhiệm vận hành:

| Tiêu chí | RDS | DB tự cài trên EC2 |
|---|---|---|
| OS access (SSH) | Không | Có (toàn quyền) |
| Patching OS & engine | AWS làm (maintenance window) | Bạn tự làm |
| Backup tự động + PITR | Có sẵn, bật mặc định | Tự dựng (cron + snapshot script) |
| Multi-AZ failover | Tích hợp, 1 click | Tự dựng replication + health check |
| Read Replica | Tích hợp | Tự cấu hình binlog/streaming replication |
| Tuning sâu ở tầng OS, extension lạ | Bị giới hạn (parameter groups) | Tự do hoàn toàn |
| Chi phí | Cao hơn EC2 thuần một chút | Rẻ hơn phần infra, đắt hơn phần công sức |

Quy tắc chọn nhanh trong đề: cụm từ **"least operational overhead"** hoặc **"minimize administrative effort"** → RDS/Aurora. Chỉ chọn EC2 khi đề nói cần engine không được hỗ trợ, cần root access vào OS, hoặc cần feature mà RDS chặn.

### Storage và Storage Auto Scaling

RDS chạy trên EBS (chi tiết EBS ở Chương 5). Ba lựa chọn storage:

- **General Purpose SSD (gp2/gp3)**: workload thông thường; gp3 cho phép set IOPS và throughput độc lập với dung lượng.
- **Provisioned IOPS SSD (io1/io2)**: workload OLTP cần IOPS cao, ổn định, latency thấp.
- **Magnetic**: legacy, chỉ gặp trong đề dạng "đáp án sai".

**RDS Storage Auto Scaling**: khi bật, RDS tự tăng dung lượng storage khi gần đầy — bạn đặt **Maximum Storage Threshold** (trần dung lượng). Điều kiện trigger: free space dưới 10% dung lượng được cấp, tình trạng thiếu kéo dài ít nhất 5 phút, và đã qua ít nhất 6 giờ kể từ lần scale trước. Quan trọng: auto scaling chỉ tăng, **không bao giờ tự giảm** dung lượng (muốn giảm phải migrate sang instance mới).

```bash
# Tạo RDS PostgreSQL với storage auto scaling (trần 500 GiB)
aws rds create-db-instance \
  --db-instance-identifier app-db \
  --engine postgres \
  --db-instance-class db.t4g.medium \
  --allocated-storage 100 \
  --max-allocated-storage 500 \
  --storage-type gp3 \
  --master-username appadmin \
  --manage-master-user-password \
  --backup-retention-period 7 \
  --no-publicly-accessible
```

Cờ `--manage-master-user-password` để Secrets Manager quản lý và rotate password master (chi tiết Secrets Manager ở Chương 47). `--max-allocated-storage` chính là cách bật storage auto scaling qua CLI.

> 💡 **Exam Tip:** Đề hỏi "ứng dụng sắp hết disk trên RDS, làm sao tránh can thiệp thủ công?" → bật Storage Auto Scaling với Maximum Storage Threshold. Nhớ: chỉ scale **lên**, không scale xuống, và scale storage **không gây downtime** (khác với đổi instance class — có downtime trừ khi Multi-AZ failover).

Kết nối từ ứng dụng: RDS nằm trong VPC, ứng dụng kết nối qua endpoint DNS, được bảo vệ bằng Security Group (mở port 3306/5432... từ SG của app tier — chi tiết VPC ở Chương 11).

## 8.2 Read Replicas — scale read traffic

**Read Replica** là bản sao **chỉ đọc** của DB instance, được đồng bộ bằng **asynchronous replication** (replication bất đồng bộ): primary ghi xong là trả về client ngay, thay đổi được đẩy sang replica *sau đó*. Hệ quả trực tiếp: replica có **replication lag** — đọc từ replica là **eventually consistent** (nhất quán "rồi sẽ đến", không phải ngay lập tức).

Đặc điểm cần nhớ:

- Tối đa **15 Read Replica** cho mỗi RDS instance (con số áp dụng cho MySQL/PostgreSQL/MariaDB).
- Replica có thể nằm **cùng AZ, khác AZ, hoặc khác region** (cross-region replica — phục vụ read gần user nước khác hoặc làm nền cho DR).
- Mỗi replica có **endpoint riêng** — ứng dụng phải tự sửa connection string / tự cân bằng read sang replica. RDS thuần không có "reader endpoint" gộp (đó là tính năng của Aurora, mục 8.6).
- Replica có thể được **promote** thành DB instance độc lập (đọc-ghi đầy đủ). Sau khi promote, nó tách khỏi chuỗi replication — dùng cho DR thủ công hoặc tách môi trường.
- Để tạo được replica, primary phải bật automated backups (backup retention > 0).

Use case kinh điển trong đề: *"Ứng dụng production đang chịu tải; team analytics muốn chạy report query nặng mà không ảnh hưởng production"* → tạo Read Replica, trỏ tool analytics vào endpoint của replica.

```javascript
// AWS SDK JS v3 — tạo read replica và lấy endpoint
import {
  RDSClient,
  CreateDBInstanceReadReplicaCommand,
  DescribeDBInstancesCommand,
} from "@aws-sdk/client-rds";

const rds = new RDSClient({ region: "ap-southeast-1" });

// Tạo replica từ primary "app-db"
await rds.send(new CreateDBInstanceReadReplicaCommand({
  DBInstanceIdentifier: "app-db-replica-1",
  SourceDBInstanceIdentifier: "app-db",
  DBInstanceClass: "db.t4g.medium",   // replica được phép khác class với primary
}));

// Mỗi replica có endpoint RIÊNG — app tự route read query sang đây
const { DBInstances } = await rds.send(new DescribeDBInstancesCommand({
  DBInstanceIdentifier: "app-db-replica-1",
}));
console.log(DBInstances[0].Endpoint); // { Address, Port, HostedZoneId }
```

**Chi phí network**: replication **trong cùng region** (kể cả khác AZ) **miễn phí** phí truyền dữ liệu; replication **cross-region** tính phí data transfer. Đây là chi tiết đề thi thích hỏi ở dạng "most cost-effective".

> 💡 **Exam Tip:** Bẫy hay gặp — đề mô tả ứng dụng cần dữ liệu đọc *tuyệt đối mới nhất* (ví dụ đọc lại ngay sau khi ghi). Read Replica là **sai** vì async replication gây lag; phải đọc từ primary. Ngược lại, report/analytics/dashboard chấp nhận trễ vài giây → Read Replica là đáp án đúng.

## 8.3 Multi-AZ — high availability, không phải scaling

**Multi-AZ deployment** giải quyết bài toán khác hẳn: **tính sẵn sàng (availability)**, không phải hiệu năng đọc. RDS duy trì một **standby replica** ở AZ khác, đồng bộ bằng **synchronous replication**: mỗi write phải được ghi xuống cả primary lẫn standby rồi mới báo thành công. Standby ở chế độ thường **không nhận bất kỳ traffic nào** — không đọc được, không ghi được.

Cơ chế failover:

- Khi primary gặp sự cố (instance lỗi, AZ outage, storage failure) hoặc khi bạn chủ động (đổi instance class, OS patching), RDS **tự động failover** sang standby — thường mất **60–120 giây**.
- Failover hoạt động bằng cách **trỏ lại DNS record của endpoint** sang standby. Ứng dụng **không cần đổi connection string** — chỉ cần reconnect. Lưu ý thực tế: connection pool phía app phải tôn trọng DNS TTL; pool giữ connection cũ/cache DNS quá lâu sẽ "treo" vào IP chết sau failover.
- Chuyển single-AZ → Multi-AZ là thao tác **không downtime**: RDS snapshot primary, restore snapshot thành standby ở AZ khác, rồi thiết lập sync replication.

Biến thể cần phân biệt:

- **Multi-AZ DB instance** (1 standby): standby hoàn toàn passive, không đọc được.
- **Multi-AZ DB cluster** (2 readable standby): biến thể mới hơn cho MySQL/PostgreSQL — 2 standby **đọc được**, failover nhanh hơn (thường dưới 35 giây). Trong đề, nếu không nói gì thêm thì "Multi-AZ" mặc định hiểu là loại standby không đọc được.

Bảng so sánh phải thuộc lòng:

| | Read Replica | Multi-AZ (instance) |
|---|---|---|
| Mục đích | Scale **read**, giảm tải primary | **High availability** / failover |
| Replication | **Asynchronous** | **Synchronous** |
| Đọc được không? | Có (eventually consistent) | Không (standby passive) |
| Endpoint | Mỗi replica 1 endpoint riêng | 1 endpoint duy nhất, DNS tự trỏ lại khi failover |
| Failover tự động | Không (phải promote thủ công) | Có (60–120s) |
| Cross-region | Có | Không (chỉ trong 1 region, 2 AZ) |
| Số lượng | Tối đa 15 | 1 standby (hoặc 2 readable với DB cluster) |

Hai tính năng **không loại trừ nhau**: production chuẩn thường bật Multi-AZ trên primary **và** có Read Replica; thậm chí bản thân Read Replica cũng có thể được cấu hình Multi-AZ (làm nền cho DR: replica vừa chịu read vừa sẵn sàng promote với HA).

> 💡 **Exam Tip:** Từ khóa quyết định đáp án: "improve **read** performance / offload reporting" → Read Replica. "Survive **AZ failure** / automatic **failover** / high availability" → Multi-AZ. "Disaster recovery sang **region khác**" → cross-region Read Replica (RDS) hoặc Global Database (Aurora). Multi-AZ **không** tăng hiệu năng đọc dù chữ "replica" xuất hiện trong tên standby.

## 8.4 Backup, snapshot, restore & Point-in-Time Recovery

### Automated backups

RDS bật backup tự động mặc định: mỗi ngày một bản full snapshot trong **backup window**, cộng với **transaction logs được đẩy lên S3 mỗi 5 phút**. Nhờ transaction logs, bạn restore được về **bất kỳ thời điểm nào** trong khoảng retention — gọi là **Point-in-Time Recovery (PITR)**, với **RPO thực tế ~5 phút** (mất tối đa 5 phút dữ liệu gần nhất).

- **Retention**: 0–**35 ngày**. Đặt 0 = tắt automated backup (và mất khả năng tạo Read Replica). Aurora không cho tắt — retention tối thiểu 1 ngày.
- Automated backup **bị xóa theo retention** và mặc định bị xóa khi xóa instance (có tùy chọn giữ lại).
- Trên single-AZ, backup gây I/O suspension ngắn; với Multi-AZ, backup chạy từ standby nên không ảnh hưởng primary.

### Manual snapshots

**Manual snapshot** do bạn chủ động tạo, **tồn tại vô thời hạn** đến khi bạn xóa — kể cả sau khi DB instance đã bị xóa. Use case đề hay hỏi: *"DB chỉ dùng vài giờ mỗi tháng, làm sao tiết kiệm?"* → snapshot rồi **xóa instance**, khi cần thì restore (RDS không "stop" được quá 7 ngày — instance bị stop sẽ tự khởi động lại sau 7 ngày, nên snapshot+delete là đáp án tiết kiệm triệt để).

Snapshot có thể **copy sang region khác** và **share cho account khác** (snapshot encrypted muốn share phải dùng customer managed KMS key và share cả key — chi tiết KMS ở Chương 46; snapshot mã hóa bằng key AWS managed mặc định không share được).

### Restore — điểm bẫy lớn nhất

Mọi thao tác restore (từ snapshot hay PITR) đều tạo ra **DB instance MỚI với endpoint MỚI**. Không có chuyện "restore đè" lên instance cũ. Quy trình thực tế: restore → kiểm tra dữ liệu → đổi connection string của app (hoặc đổi DNS CNAME nội bộ) sang endpoint mới. Instance mới nhận default parameter group và security group nếu bạn không chỉ định — một nguồn lỗi production kinh điển: restore xong app không kết nối được vì SG mới không mở port.

```bash
# Restore về thời điểm cụ thể (PITR) — tạo instance MỚI
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier app-db \
  --target-db-instance-identifier app-db-restored \
  --restore-time 2026-06-11T15:30:00Z \
  --db-instance-class db.t4g.medium \
  --vpc-security-group-ids sg-0abc123def456 \
  --no-publicly-accessible

# Hoặc restore về thời điểm muộn nhất có thể
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier app-db \
  --target-db-instance-identifier app-db-latest \
  --use-latest-restorable-time

# Snapshot thủ công trước một đợt migration rủi ro
aws rds create-db-snapshot \
  --db-instance-identifier app-db \
  --db-snapshot-identifier app-db-before-migration-20260612
```

> 💡 **Exam Tip:** Ba con số/sự thật hay vào đề: (1) automated backup retention tối đa **35 ngày** — cần giữ lâu hơn thì dùng manual snapshot hoặc AWS Backup; (2) PITR dựa trên transaction log đẩy S3 **mỗi 5 phút**; (3) restore luôn tạo **instance mới, endpoint mới** — đáp án nào nói "restore in place" là sai.

## 8.5 Aurora — kiến trúc storage tách rời compute

**Amazon Aurora** là engine quan hệ do AWS xây, **tương thích wire-protocol với MySQL và PostgreSQL** (app dùng driver mysql2/pg bình thường, không đổi code), nhưng tầng storage được thiết kế lại hoàn toàn. AWS quảng cáo throughput gấp ~5x MySQL, ~3x PostgreSQL trên cùng phần cứng — con số này thỉnh thoảng xuất hiện trong đề ở mức nhận diện.

Điểm khác biệt cốt lõi: Aurora **tách compute khỏi storage**. Storage là một cluster volume phân tán, tự động replicate dữ liệu thành **6 bản sao trên 3 Availability Zones** (2 bản/AZ). Cơ chế quorum:

- **Write** cần **4/6** bản sao xác nhận.
- **Read** (ở tầng storage) cần **3/6**.
- Nhờ đó storage chịu được mất **2 bản sao mà vẫn ghi được**, mất **3 bản sao vẫn đọc được** — tức chịu được nguyên một AZ down kèm thêm một node hỏng mà vẫn đọc được.
- Storage **self-healing**: block hỏng được tự sửa từ các bản sao còn lại, liên tục ở chế độ nền.

Hệ quả kiến trúc quan trọng:

- Cluster volume **tự động grow theo mức 10 GiB**, tối đa **128 TiB** — không có khái niệm "provision storage" hay storage auto scaling threshold như RDS.
- Vì mọi compute node cùng đọc chung một storage phân tán, **replica không phải copy dữ liệu** — chỉ cần áp dụng redo log. **Replication lag của Aurora replica thường dưới ~10–20 ms**, so với hàng giây của RDS Read Replica truyền thống.
- Backup của Aurora là **continuous, incremental lên S3**, không gây ảnh hưởng hiệu năng, PITR trong retention 1–35 ngày.
- **Backtrack** (chỉ Aurora MySQL): "tua lui" cluster về thời điểm trước đó (tối đa 72 giờ) **tại chỗ, không tạo cluster mới** — khác bản chất với restore. Đề hay dùng làm đáp án cho tình huống "undo một câu lệnh chạy nhầm nhanh nhất".

```bash
# Tạo Aurora cluster: 1 cluster + các instance gắn vào
aws rds create-db-cluster \
  --db-cluster-identifier app-aurora \
  --engine aurora-mysql \
  --engine-version 8.0.mysql_aurora.3.05.2 \
  --master-username appadmin \
  --manage-master-user-password \
  --storage-encrypted

# Writer instance (instance đầu tiên trong cluster trở thành writer)
aws rds create-db-instance \
  --db-cluster-identifier app-aurora \
  --db-instance-identifier app-aurora-writer \
  --db-instance-class db.r6g.large \
  --engine aurora-mysql
```

Lưu ý mô hình API: với Aurora, bạn tạo **DB cluster** trước rồi thêm **DB instance** vào — khác RDS thuần chỉ có instance.

> 💡 **Exam Tip:** Bộ số của Aurora phải nhớ chính xác: **6 copies / 3 AZ, write quorum 4/6, read quorum 3/6, storage tự grow đến 128 TiB, tối đa 15 replicas, replica lag ~ms**. Đề thích hỏi "Aurora vẫn ghi được khi mất tối đa bao nhiêu bản sao?" → 2.

## 8.6 Aurora replicas, endpoints, Serverless & Global Database

### Replicas và failover

Một Aurora cluster có **1 writer** và tối đa **15 Aurora Replicas** (reader). Vì reader dùng chung storage với writer, failover rất nhanh: khi writer chết, một reader được promote làm writer mới, thường trong **dưới 30 giây**. Bạn gán **failover priority (tier 0–15)** cho từng replica để kiểm soát thứ tự promote. Reader có thể bật auto scaling (thêm/bớt replica theo CPU hoặc số connection).

### Endpoints — phần đề hỏi nhiều nhất về Aurora

Aurora cung cấp sẵn các DNS endpoint ở mức cluster:

| Endpoint | Trỏ tới | Dùng cho |
|---|---|---|
| **Cluster (writer) endpoint** | Writer hiện tại; tự trỏ lại khi failover | Mọi câu **write** và read cần dữ liệu mới nhất |
| **Reader endpoint** | Load-balance (DNS round-robin) qua **tất cả replicas** | Read traffic — không cần tự quản lý danh sách replica như RDS |
| **Custom endpoint** | Tập instance do bạn chọn | Tách workload: ví dụ nhóm replica class to cho analytics, nhóm nhỏ cho web read |
| **Instance endpoint** | Một instance cụ thể | Debug/chẩn đoán; tránh dùng trong app |

```javascript
// Pattern điển hình trong app Node.js: 2 pool, write vs read
import mysql from "mysql2/promise";

const writer = mysql.createPool({
  host: "app-aurora.cluster-cabc123.ap-southeast-1.rds.amazonaws.com", // cluster endpoint
  user: "appadmin", password: process.env.DB_PASS, database: "app",
});
const reader = mysql.createPool({
  host: "app-aurora.cluster-ro-cabc123.ap-southeast-1.rds.amazonaws.com", // reader endpoint (-ro-)
  user: "appadmin", password: process.env.DB_PASS, database: "app",
});

await writer.execute("INSERT INTO orders SET ?", [order]); // write → writer
const [rows] = await reader.query("SELECT * FROM orders WHERE user_id = ?", [uid]); // read → replicas
```

> 💡 **Exam Tip:** "Ứng dụng cần phân phối read query qua nhiều Aurora replica với **ít công sức nhất**" → dùng **reader endpoint**, KHÔNG phải tự liệt kê instance endpoint, không cần dựng load balancer. "Chạy báo cáo nặng trên một nhóm replica riêng để không ảnh hưởng read thường" → **custom endpoint**.

### Aurora Serverless

**Aurora Serverless v2** tự scale compute theo đơn vị **ACU (Aurora Capacity Unit, ~2 GiB RAM kèm CPU/network tương ứng)**: bạn đặt min/max ACU, capacity tăng giảm **theo từng bước nhỏ trong vài giây, không gián đoạn connection**. Phù hợp workload thất thường, spiky, môi trường dev/test, hoặc multi-tenant khó dự đoán. Serverless v2 instance trộn được với provisioned instance trong cùng cluster (ví dụ writer provisioned + reader serverless). Aurora Serverless v1 (scale theo bước lớn, có thể pause về 0, chỉ phiên bản engine cũ) đã deprecated — trong đề mới, "Aurora Serverless" mặc định hiểu là v2; điểm cần nhớ là **trả tiền theo ACU-giây thay vì instance chạy 24/7**.

### Aurora Global Database

**Global Database** cho bài toán DR đa region và read gần user toàn cầu:

- 1 **primary region** (đọc + ghi) và tối đa **5 secondary region** (chỉ đọc), mỗi secondary có tới 16 replica.
- Replication ở **tầng storage**, lag điển hình **< 1 giây** cross-region.
- Khi primary region sự cố: promote một secondary thành primary với **RTO < 1 phút, RPO ~1 giây** — bộ số này là "chữ ký" của Global Database trong đề.
- **Write forwarding**: cho phép app ở secondary region gửi câu write tới endpoint local, Aurora tự chuyển tiếp về primary — giảm việc app phải biết region nào là primary.

> 💡 **Exam Tip:** Phân biệt 3 đáp án DR: RDS cross-region Read Replica (lag giây-phút, promote thủ công), Aurora Global Database (**RPO ~1s, RTO <1 phút** — chọn khi đề đòi con số khắt khe), và backup copy cross-region (RPO/RTO tệ nhất, rẻ nhất).

## 8.7 RDS Proxy — connection pooling cho Lambda và app nhiều kết nối

Database quan hệ chịu kém khi bị mở/đóng connection ồ ạt: mỗi connection tốn RAM và CPU cho handshake + auth. Vấn đề bùng phát với **Lambda**: 1000 concurrent execution = tiềm năng 1000 connection mới cùng lúc (mỗi execution environment một connection riêng — chi tiết Lambda ở Chương 28–29), dễ làm DB cạn `max_connections`.

**RDS Proxy** là proxy được quản lý hoàn toàn, đứng giữa app và RDS/Aurora:

- **Connection pooling & multiplexing**: proxy giữ một pool connection "ấm" tới DB, nhiều client connection chia sẻ (multiplex) số ít DB connection thật → DB không bị connection storm.
- **Giảm failover time tới ~66%**: app kết nối tới proxy endpoint; khi DB failover, proxy giữ client connection và tự nối lại với instance mới — app gần như không thấy gián đoạn.
- **Bảo mật**: tích hợp Secrets Manager để giữ DB credentials (proxy tự lấy secret để auth với DB), và có thể **ép buộc IAM authentication** từ client tới proxy.
- Proxy **chỉ truy cập được từ trong VPC** — không có public endpoint. Hỗ trợ RDS MySQL/PostgreSQL/MariaDB/SQL Server và Aurora.
- App chỉ cần **đổi connection string sang proxy endpoint** — không đổi code, không đổi driver.

```bash
# Tạo RDS Proxy trỏ tới Aurora cluster, credentials lấy từ Secrets Manager
aws rds create-db-proxy \
  --db-proxy-name app-proxy \
  --engine-family MYSQL \
  --auth '[{"AuthScheme":"SECRETS","SecretArn":"arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:app-db-cred-AbCdEf","IAMAuth":"REQUIRED"}]' \
  --role-arn arn:aws:iam::123456789012:role/rds-proxy-secrets-role \
  --vpc-subnet-ids subnet-aaa subnet-bbb \
  --require-tls

aws rds register-db-proxy-targets \
  --db-proxy-name app-proxy \
  --db-cluster-identifiers app-aurora
```

Lưu ý vận hành: với transaction giữ session state (temp table, session variable, prepared statement kiểu session-level), proxy phải **pin** connection cho riêng client đó — pinning nhiều làm mất lợi ích multiplexing. CloudWatch metric `DatabaseConnectionsCurrentlySessionPinned` giúp phát hiện.

> 💡 **Exam Tip:** Tổ hợp "**Lambda + RDS + lỗi too many connections / connection exhaustion**" → đáp án gần như chắc chắn là **RDS Proxy**. Phương án "tăng max_connections" hoặc "tăng instance size" là mồi nhử — không giải quyết gốc rễ connection storm.

## 8.8 IAM Database Authentication

**IAM database authentication** cho phép kết nối MySQL/PostgreSQL (RDS và Aurora) **không cần password lưu trong app**: thay vào đó, app gọi API lấy **authentication token** — một chuỗi được ký bằng SigV4, **sống 15 phút** — và dùng token đó làm "password" khi mở connection.

Cơ chế gồm 3 mảnh ghép:

1. **Bật trên DB**: `--enable-iam-database-authentication` khi create/modify instance/cluster.
2. **Tạo DB user map với IAM**: trong MySQL: `CREATE USER 'app_user' IDENTIFIED WITH AWSAuthenticationPlugin AS 'RDS';` — trong PostgreSQL: tạo user và `GRANT rds_iam TO app_user;`.
3. **IAM policy** cho phép action `rds-db:connect` trên resource `arn:aws:rds-db:<region>:<account>:dbuser:<DbiResourceId>/<db_user>` (chú ý: dùng **DbiResourceId** dạng `db-ABCDEFGH...`, không phải tên instance — bẫy kinh điển khi viết policy).

```javascript
// AWS SDK JS v3 — lấy IAM auth token rồi kết nối PostgreSQL qua TLS
import { Signer } from "@aws-sdk/rds-signer";
import pg from "pg";

const signer = new Signer({
  region: "ap-southeast-1",
  hostname: "app-db.cabc123.ap-southeast-1.rds.amazonaws.com",
  port: 5432,
  username: "app_user",
});

const token = await signer.getAuthToken(); // token SigV4, hết hạn sau 15 phút

const client = new pg.Client({
  host: "app-db.cabc123.ap-southeast-1.rds.amazonaws.com",
  port: 5432,
  user: "app_user",
  password: token,                  // token đóng vai trò password
  database: "app",
  ssl: { rejectUnauthorized: true } // IAM auth BẮT BUỘC dùng TLS
});
await client.connect();
```

Tương đương CLI:

```bash
TOKEN=$(aws rds generate-db-auth-token \
  --hostname app-db.cabc123.ap-southeast-1.rds.amazonaws.com \
  --port 5432 --username app_user)
psql "host=app-db.cabc123.ap-southeast-1.rds.amazonaws.com port=5432 \
      dbname=app user=app_user password=$TOKEN sslmode=verify-full"
```

Lợi ích đúng kiểu câu hỏi DVA: **không lưu password** trong code/config; credential gắn với IAM role (EC2 instance role, Lambda execution role, ECS task role) — xoay vòng tự nhiên; kết nối **bắt buộc TLS**; audit tập trung qua IAM/CloudTrail. Giới hạn: token sống 15 phút (connection đã mở thì không bị cắt khi token hết hạn — chỉ cần token hợp lệ lúc **mở** connection), và IAM auth khuyến nghị cho mức dưới ~200 connection mới/giây (việc ký token có chi phí) — workload mở connection dồn dập nên kết hợp RDS Proxy.

> 💡 **Exam Tip:** "Developer muốn kết nối RDS **không hard-code credentials**, dùng IAM role sẵn có" → IAM database authentication với `generate-db-auth-token`. Nhớ 2 con số: token **15 phút**, và chỉ hỗ trợ **MySQL/MariaDB/PostgreSQL** (không có Oracle/SQL Server). Nếu đề nhấn "tự động **rotate** password cho engine bất kỳ" → đó là Secrets Manager rotation (Chương 47), không phải IAM auth.

## 8.9 Encryption at rest & in transit

### At rest — KMS

RDS/Aurora mã hóa at rest bằng **AWS KMS** (chi tiết KMS ở Chương 46). Khi bật, mã hóa phủ: storage của instance, **automated backups, snapshots, và Read Replicas**. Các quy tắc "luật cứng" hay vào đề:

- Encryption chỉ bật được **lúc tạo** instance. **Không bật được trên instance đang chạy.** Con đường duy nhất để mã hóa DB unencrypted: **snapshot → copy snapshot với tùy chọn encryption (chỉ định KMS key) → restore từ snapshot đã mã hóa** → trỏ app sang instance mới.
- **Snapshot của DB encrypted thì encrypted; restore từ snapshot encrypted ra instance encrypted.** Không thể restore snapshot encrypted thành instance unencrypted (không có đường "giải mã").
- Read Replica của primary encrypted phải encrypted. Trong cùng region, replica dùng cùng KMS key với primary; replica **cross-region** phải chỉ định KMS key của **region đích** (KMS key là tài nguyên theo region).
- Share snapshot encrypted cross-account: phải dùng **customer managed key** và grant quyền dùng key cho account đích; snapshot mã hóa bằng default AWS managed key (`aws/rds`) **không share được**.

```bash
# Quy trình mã hóa một DB đang unencrypted (tạo instance MỚI)
aws rds create-db-snapshot \
  --db-instance-identifier legacy-db --db-snapshot-identifier legacy-snap

aws rds copy-db-snapshot \
  --source-db-snapshot-identifier legacy-snap \
  --target-db-snapshot-identifier legacy-snap-encrypted \
  --kms-key-id alias/app-rds-key          # copy + encrypt tại bước này

aws rds restore-db-instance-from-db-snapshot \
  --db-instance-identifier legacy-db-encrypted \
  --db-snapshot-identifier legacy-snap-encrypted
```

### In transit — TLS

Mọi engine RDS/Aurora hỗ trợ **TLS** giữa client và DB. Endpoint trình chứng chỉ ký bởi CA của AWS — client cần **RDS CA bundle** (tải từ AWS, ví dụ `global-bundle.pem`) để verify. Có thể **ép buộc TLS** ở tầng DB: PostgreSQL qua parameter `rds.force_ssl = 1` trong parameter group; MySQL qua `require_secure_transport = ON` hoặc `CREATE USER ... REQUIRE SSL`. Với Go SDK v2, việc lấy IAM token tương tự qua package `feature/rds/auth`:

```go
// Go SDK v2 — lấy IAM auth token (in transit bắt buộc TLS)
token, err := auth.BuildAuthToken(ctx,
    "app-db.cabc123.ap-southeast-1.rds.amazonaws.com:5432",
    "ap-southeast-1", "app_user", cfg.Credentials)
```

> 💡 **Exam Tip:** Câu kinh điển: "Công ty yêu cầu DB hiện có phải được mã hóa at rest. Làm thế nào?" — Đáp án đúng luôn là chuỗi **snapshot → copy có encrypt → restore**; mọi đáp án "enable encryption on the existing instance" đều sai vì RDS không cho bật encryption tại chỗ. Đừng nhầm encryption at rest (KMS, storage) với in transit (TLS, certificate) — đề có thể trộn cả hai trong một câu.

---

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
