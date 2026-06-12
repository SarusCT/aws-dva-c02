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
