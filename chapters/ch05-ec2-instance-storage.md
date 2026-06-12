# Chương 5: EC2 Instance Storage — EBS, EFS, Instance Store

> **Trọng tâm DVA-C02:** Chủ đề storage cho EC2 xuất hiện chủ yếu dưới dạng câu hỏi tình huống "chọn loại storage nào" — đề cho yêu cầu về IOPS, độ bền dữ liệu, chia sẻ giữa nhiều instance, hoặc chi phí, và bạn phải chọn đúng giữa EBS (loại volume nào), EFS hay Instance Store. Ngoài ra đề rất hay gài về EBS encryption (mã hoá volume đã tồn tại), snapshot (incremental, copy cross-region) và đặc tính "gắn với 1 AZ" của EBS so với "đa AZ" của EFS.

## Mục tiêu chương

- Phân biệt rạch ròi ba lớp storage của EC2: EBS (block, network-attached), Instance Store (block, gắn vật lý), EFS (file, NFS, chia sẻ đa instance đa AZ).
- Nắm chính xác thông số từng loại EBS volume (gp2/gp3, io1/io2, st1/sc1): IOPS, throughput, kích thước, khi nào dùng — đủ để trả lời câu hỏi chọn volume trong đề.
- Hiểu cơ chế EBS snapshot (incremental), các tính năng Archive, Recycle Bin, Fast Snapshot Restore, và quy trình tạo AMI từ snapshot.
- Hiểu cơ chế EBS encryption với KMS và quy trình chuẩn để mã hoá một volume chưa mã hoá.
- Biết giới hạn và use case của EBS Multi-Attach và Instance Store.
- Cấu hình EFS đúng: performance mode, throughput mode, storage class, lifecycle policy, và mount đa AZ qua mount targets.

## 5.1 Bức tranh tổng thể: ba lớp storage của EC2

Khi một EC2 instance cần lưu dữ liệu, bạn có ba lựa chọn với đặc tính hoàn toàn khác nhau:

1. **EBS (Elastic Block Store)** — block storage **qua mạng**. Volume là một thiết bị block (giống ổ cứng) nằm trên hạ tầng storage riêng của AWS trong **một AZ cụ thể**, kết nối tới instance qua network. Vì là network drive nên có độ trễ nhỏ (vẫn ở mức sub-millisecond với io2 Block Express), nhưng đổi lại dữ liệu **tồn tại độc lập với instance**: stop/terminate instance, volume vẫn còn (trừ khi bật `DeleteOnTermination`).
2. **Instance Store** — block storage **gắn vật lý** vào máy chủ host. Nhanh nhất (NVMe SSD, hàng trăm nghìn đến hàng triệu IOPS), nhưng **ephemeral** (tạm thời): dữ liệu mất khi instance stop, hibernate, terminate hoặc host hỏng phần cứng.
3. **EFS (Elastic File System)** — **file storage** chuẩn NFSv4.1, mount đồng thời được vào **hàng trăm/hàng nghìn instance ở nhiều AZ** trong cùng region. Trả tiền theo dung lượng dùng thực tế, tự co giãn, không cần provision dung lượng trước.

Cách tư duy khi gặp câu hỏi trong đề:

- Cần ổ đĩa cho **một** instance, dữ liệu phải bền → **EBS**.
- Cần **nhiều instance cùng đọc/ghi một file system**, đa AZ → **EFS** (Linux). (Windows cần shared storage → FSx for Windows, ngoài phạm vi DVA, chỉ cần nhận diện.)
- Cần **IOPS cực cao, dữ liệu mất cũng được** (buffer, cache, scratch data, dữ liệu replicate ở tầng ứng dụng) → **Instance Store**.

> 💡 **Exam Tip:** EBS volume bị "khoá" trong một AZ — volume tạo ở `ap-southeast-1a` KHÔNG thể attach vào instance ở `ap-southeast-1b`. Muốn "di chuyển" volume sang AZ/region khác, cách duy nhất là **snapshot → tạo volume mới từ snapshot ở AZ đích** (snapshot không gắn với AZ, copy được cross-region). Đây là câu hỏi xuất hiện gần như chắc chắn dưới dạng nào đó.

## 5.2 EBS volumes: cơ chế và vòng đời

### Cơ chế bên dưới

EBS volume là một dải block được replicate **bên trong một AZ** để chống hỏng phần cứng đơn lẻ (durability 99.8–99.9% với hầu hết loại volume, riêng **io2 đạt 99.999%**). Instance giao tiếp với volume qua network — trên các instance thế hệ Nitro, traffic EBS đi qua kênh riêng (EBS-optimized mặc định), không tranh băng thông với network thường. Hệ quả thực tế: throughput tới volume còn bị chặn bởi **giới hạn EBS bandwidth của instance type** — gắn volume gp3 1,000 MiB/s vào instance chỉ có 600 MiB/s EBS bandwidth thì bạn chỉ đạt 600 MiB/s. Đây là bẫy production kinh điển: đo thấy IOPS thấp, đổ lỗi cho volume, nhưng thủ phạm là instance quá nhỏ.

Một instance gắn được nhiều volume; một volume (trừ Multi-Attach, xem 5.6) chỉ gắn vào **một instance tại một thời điểm**.

### Vòng đời và thao tác cơ bản

```bash
# Tạo volume gp3 50 GiB ở AZ cụ thể (phải trùng AZ với instance)
aws ec2 create-volume \
  --volume-type gp3 \
  --size 50 \
  --iops 4000 --throughput 250 \
  --availability-zone ap-southeast-1a \
  --tag-specifications 'ResourceType=volume,Tags=[{Key=Name,Value=data-vol}]'

# Attach vào instance
aws ec2 attach-volume \
  --volume-id vol-0abc1234def567890 \
  --instance-id i-0123456789abcdef0 \
  --device /dev/sdf
```

Sau khi attach, trong OS bạn vẫn phải format (`mkfs -t xfs /dev/nvme1n1`) và mount — EBS chỉ cấp thiết bị block thô.

**Elastic Volumes:** bạn có thể tăng size, đổi volume type, chỉnh IOPS/throughput **khi volume đang chạy, không cần detach**:

```bash
aws ec2 modify-volume --volume-id vol-0abc1234def567890 \
  --volume-type gp3 --size 100 --iops 6000
# Sau đó trong OS: growpart + xfs_growfs/resize2fs để filesystem nhận size mới
```

Lưu ý hai bẫy: (1) chỉ **tăng** được size, không giảm — muốn shrink phải tạo volume nhỏ hơn rồi copy dữ liệu; (2) sau khi modify, volume vào trạng thái `optimizing` và phải chờ **6 giờ cooldown** mới modify tiếp được.

**DeleteOnTermination:** root volume mặc định bị xoá khi terminate instance (`DeleteOnTermination=true`); volume gắn thêm mặc định **không** bị xoá. Đề DVA hay hỏi: "làm sao giữ lại root volume sau khi terminate?" → tắt cờ DeleteOnTermination (chỉnh được lúc launch qua block device mapping, hoặc khi instance đang chạy bằng `modify-instance-attribute` — không cần stop).

## 5.3 Các loại EBS volume — bảng số liệu phải thuộc

Sáu loại volume chia làm ba nhóm: SSD đa dụng (gp2/gp3), SSD hiệu năng cao (io1/io2), HDD (st1/sc1).

| Loại | Size | Max IOPS | Max throughput | Boot volume? | Use case |
|---|---|---|---|---|---|
| **gp3** | 1 GiB–16 TiB | 16,000 | 1,000 MiB/s | Có | Mặc định cho mọi workload chung |
| **gp2** | 1 GiB–16 TiB | 16,000 | 250 MiB/s | Có | Legacy, IOPS gắn với size |
| **io1** | 4 GiB–16 TiB | 64,000 (Nitro) | 1,000 MiB/s | Có | Database cần IOPS cao, ổn định |
| **io2 Block Express** | 4 GiB–64 TiB | 256,000 | 4,000 MiB/s | Có | DB lớn nhất, durability 99.999% |
| **st1** (Throughput Optimized HDD) | 125 GiB–16 TiB | 500 | 500 MiB/s | **Không** | Big data, log processing, tuần tự |
| **sc1** (Cold HDD) | 125 GiB–16 TiB | 250 | 250 MiB/s | **Không** | Dữ liệu ít truy cập, rẻ nhất |

### gp2 vs gp3 — điểm đề thi yêu thích

- **gp2:** IOPS **gắn cứng với dung lượng** theo tỷ lệ **3 IOPS/GiB** (tối thiểu 100, tối đa 16,000 — đạt max ở 5,334 GiB). Volume nhỏ hơn 1 TiB có cơ chế **burst credit** lên 3,000 IOPS; hết credit thì tụt về baseline — đây là nguồn gốc bug "ứng dụng chạy nhanh buổi sáng, chậm dần buổi chiều" kinh điển trong production.
- **gp3:** **tách rời IOPS/throughput khỏi size**. Mọi volume gp3, dù 1 GiB, đều có sẵn baseline **3,000 IOPS và 125 MiB/s miễn phí**; trả thêm tiền để nâng tối đa 16,000 IOPS và 1,000 MiB/s (giới hạn tỷ lệ 500 IOPS/GiB). Không còn burst credit — hiệu năng phẳng, dự đoán được, và rẻ hơn gp2 ~20%/GiB.

> 💡 **Exam Tip:** Câu hỏi "volume gp2 cần 6,000 IOPS ổn định, giải pháp ít tốn kém nhất?" — đáp án thường là **chuyển sang gp3 và provision 6,000 IOPS**, KHÔNG phải phình size gp2 lên 2,000 GiB hay nhảy sang io1. Chỉ cần io1/io2 khi vượt 16,000 IOPS, cần độ trễ ổn định sub-ms, hoặc cần **Multi-Attach**.

### io1/io2 — Provisioned IOPS (PIOPS)

Bạn khai báo IOPS độc lập với size: io1 tối đa **50 IOPS/GiB**, io2 Block Express tối đa **1,000 IOPS/GiB**. io1 đạt 64,000 IOPS chỉ trên instance **Nitro** (instance cũ chỉ 32,000). io2 Block Express nâng trần lên 256,000 IOPS, 64 TiB, độ trễ sub-millisecond — dành cho SAP HANA, Oracle, SQL Server cỡ lớn. io1/io2 là hai loại **duy nhất hỗ trợ Multi-Attach**.

### st1/sc1 — HDD

Tối ưu cho **throughput tuần tự**, không phải IOPS ngẫu nhiên (block I/O của HDD tính theo 1 MiB). st1 baseline 40 MiB/s mỗi TiB (burst 250 MiB/s/TiB, trần 500 MiB/s) — hợp với Kafka log, EMR, data warehouse streaming scan. sc1 baseline 12 MiB/s/TiB — rẻ nhất trong họ EBS, cho dữ liệu truy cập vài lần mỗi ngày trở xuống. **Cả hai không làm boot volume được** — đề hay gài đáp án nhiễu "dùng sc1 làm root volume cho rẻ".

Ví dụ kiểm tra hiệu năng volume bằng SDK JS v3:

```javascript
import { EC2Client, DescribeVolumesCommand } from "@aws-sdk/client-ec2";

const ec2 = new EC2Client({ region: "ap-southeast-1" });

// Liệt kê các volume gp2 đang attach — ứng viên migrate sang gp3
const { Volumes } = await ec2.send(new DescribeVolumesCommand({
  Filters: [
    { Name: "volume-type", Values: ["gp2"] },
    { Name: "status", Values: ["in-use"] },
  ],
}));
for (const v of Volumes) {
  // gp2: IOPS = 3 * size (min 100) — in ra để so với nhu cầu thực tế
  console.log(`${v.VolumeId}: ${v.Size} GiB, baseline ${v.Iops} IOPS`);
}
```

## 5.4 EBS Snapshots — incremental backup và các tính năng vệ tinh

### Cơ chế incremental

Snapshot là bản backup **point-in-time** của volume, lưu trên hạ tầng S3 do AWS quản lý (bạn không thấy object trong bucket của mình — khác với "export to S3", chi tiết S3 ở Chương 12). Snapshot đầu tiên copy toàn bộ block đã ghi; các snapshot sau **chỉ copy block thay đổi** kể từ snapshot trước (incremental). Điểm tinh tế hay bị hiểu nhầm: **xoá snapshot ở giữa chuỗi không làm hỏng các snapshot sau** — AWS tự gom các block còn được tham chiếu vào snapshot kế tiếp. Mỗi snapshot luôn restore được thành volume đầy đủ.

Không bắt buộc detach/stop khi chụp snapshot, nhưng để dữ liệu nhất quán (đặc biệt với database) nên freeze I/O hoặc stop ứng dụng — snapshot chụp trạng thái "crash-consistent", không phải "application-consistent".

```bash
# Chụp snapshot
aws ec2 create-snapshot \
  --volume-id vol-0abc1234def567890 \
  --description "Backup truoc khi nang cap DB" \
  --tag-specifications 'ResourceType=snapshot,Tags=[{Key=app,Value=orders}]'

# Copy snapshot sang region khác (DR) — có thể đồng thời bật encryption
aws ec2 copy-snapshot \
  --source-region ap-southeast-1 \
  --source-snapshot-id snap-0123456789abcdef0 \
  --region us-east-1 \
  --encrypted --kms-key-id alias/dr-key

# Restore: tạo volume mới TỪ snapshot ở AZ bất kỳ
aws ec2 create-volume \
  --snapshot-id snap-0123456789abcdef0 \
  --availability-zone us-east-1a --volume-type gp3
```

### Ba tính năng vệ tinh đề hay hỏi

1. **Snapshot Archive:** chuyển snapshot sang tier lưu trữ rẻ hơn **~75%**, đổi lại restore mất **24–72 giờ** và snapshot bị archive sẽ thành **full snapshot** (không còn incremental). Tối thiểu lưu **90 ngày**. Dùng cho snapshot tuân thủ/audit ít khi cần lại. Từ khoá đề: "rarely restored, reduce cost" → Archive; "must restore within minutes" → KHÔNG Archive.
2. **Recycle Bin:** quy tắc retention cho snapshot (và AMI) bị xoá — thay vì mất ngay, snapshot vào thùng rác và khôi phục được trong thời gian giữ từ **1 ngày đến 1 năm** do bạn cấu hình. Chống tai nạn "xoá nhầm snapshot production" (war story có thật ở mọi team).
3. **Fast Snapshot Restore (FSR):** bình thường, volume tạo từ snapshot bị **lazy loading** — block chỉ kéo từ S3 về lần đầu được đọc, nên I/O lần đầu chậm (độ trễ cao cho tới khi "warm" xong; cách thủ công là `dd`/`fio` đọc toàn bộ volume để pre-warm). FSR loại bỏ hoàn toàn độ trễ khởi tạo này: volume tạo ra **full performance ngay lập tức**. Bật **theo từng snapshot, từng AZ**, và **rất đắt** (tính tiền theo giờ-AZ) — đề hay hỏi trade-off này.

> 💡 **Exam Tip:** "Volume restore từ snapshot có latency cao trong lần đọc đầu" → nguyên nhân là lazy loading; giải pháp managed là **Fast Snapshot Restore**, giải pháp thủ công là pre-warm bằng cách đọc toàn bộ block. Còn tự động hoá lịch chụp snapshot → **Amazon Data Lifecycle Manager (DLM)**, không phải tự viết cron Lambda.

### AMI tạo từ snapshot

AMI (đã giới thiệu ở Chương 4) về bản chất = **metadata + một hoặc nhiều EBS snapshot** (block device mapping). Hai con đường tạo AMI:

- `aws ec2 create-image --instance-id ...` — chụp từ instance đang chạy (mặc định AWS reboot instance để đảm bảo consistency, thêm `--no-reboot` để bỏ qua, chấp nhận rủi ro filesystem không nhất quán).
- `aws ec2 register-image` — đăng ký AMI **trực tiếp từ snapshot** của root volume:

```bash
aws ec2 register-image \
  --name "golden-api-server-v2" \
  --architecture x86_64 --root-device-name /dev/xvda \
  --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"SnapshotId":"snap-0123456789abcdef0","VolumeType":"gp3"}}]' \
  --virtualization-type hvm --ena-support
```

Muốn dùng AMI ở region khác: **copy AMI cross-region** (bên dưới là copy các snapshot thành phần). Muốn chia sẻ AMI mã hoá cho account khác: phải chia sẻ cả **KMS key** (chi tiết KMS ở Chương 46).

## 5.5 EBS Encryption

EBS mã hoá bằng **AES-256** với key từ **AWS KMS** (key mặc định `aws/ebs` hoặc customer managed key). Khi volume được mã hoá, bạn có trọn gói, hoàn toàn trong suốt với OS và gần như không tổn hao hiệu năng:

- Data at rest trên volume được mã hoá.
- **Toàn bộ data in transit giữa instance và volume** được mã hoá.
- Mọi snapshot chụp từ volume mã hoá → mã hoá; mọi volume tạo từ snapshot mã hoá → mã hoá.

Quy tắc "di truyền": **snapshot của volume mã hoá luôn mã hoá; volume tạo từ snapshot mã hoá luôn mã hoá**. Chiều ngược lại — từ unencrypted có thể "nâng cấp" lên encrypted ở bước copy/create.

### Quy trình chuẩn mã hoá một volume chưa mã hoá (câu hỏi kinh điển)

Không có nút "encrypt" cho volume đang tồn tại. Quy trình 4 bước:

```bash
# 1. Snapshot volume chưa mã hoá
aws ec2 create-snapshot --volume-id vol-0unencrypted123

# 2. Copy snapshot, bật encryption (có thể chỉ định CMK riêng)
aws ec2 copy-snapshot --source-region ap-southeast-1 \
  --source-snapshot-id snap-0aaa111 \
  --encrypted --kms-key-id alias/prod-ebs-key

# 3. Tạo volume mới từ snapshot đã mã hoá
aws ec2 create-volume --snapshot-id snap-0bbb222 \
  --availability-zone ap-southeast-1a --volume-type gp3

# 4. Detach volume cũ, attach volume mới vào instance
```

(Lối tắt: bước 2 có thể bỏ — `create-volume` từ snapshot unencrypted với cờ `--encrypted` cũng ra volume mã hoá.) Ngoài ra bạn nên bật **encryption by default** ở cấp account/region: `aws ec2 enable-ebs-encryption-by-default` — mọi volume mới tự động được mã hoá, không phụ thuộc ý thức của dev.

> 💡 **Exam Tip:** Đổi KMS key của một snapshot/volume đã mã hoá cũng đi qua **copy snapshot với key mới** — không sửa tại chỗ được. Và khi chia sẻ encrypted snapshot cross-account: snapshot mã hoá bằng key mặc định `aws/ebs` **không chia sẻ được**; phải dùng **customer managed key** và grant quyền key cho account đích.

## 5.6 EBS Multi-Attach

Multi-Attach cho phép **một volume io1/io2** attach đồng thời vào **tối đa 16 instance Nitro trong cùng AZ**, mỗi instance đều có quyền đọc/ghi đầy đủ. Các ràng buộc phải nhớ:

- **Chỉ io1/io2** (Provisioned IOPS SSD). gp2/gp3/st1/sc1 không hỗ trợ.
- **Cùng AZ** — Multi-Attach KHÔNG biến EBS thành giải pháp đa AZ.
- Filesystem thường (ext4, XFS) **không dùng được an toàn** — chúng không được thiết kế cho nhiều máy ghi đồng thời, sẽ corrupt dữ liệu. Bắt buộc dùng **cluster-aware filesystem** (GFS2, OCFS2) hoặc ứng dụng tự điều phối I/O.
- Volume Multi-Attach không dùng làm boot volume.

Use case thực tế hẹp: clustered database (Oracle RAC kiểu cũ), ứng dụng HA chủ-động/chủ-bị cần failover storage trong vài giây. Đề DVA dùng Multi-Attach chủ yếu làm **đáp án nhiễu**: nếu câu hỏi nói "nhiều instance ở **nhiều AZ** cần ghi chung dữ liệu" thì Multi-Attach sai ngay vì ràng buộc cùng AZ — đáp án đúng là **EFS**.

## 5.7 Instance Store — nhanh nhất, nhưng phù du

Instance Store là ổ NVMe SSD/HDD **gắn vật lý trên máy chủ host** chạy instance. Vì không đi qua network, hiệu năng vượt xa EBS: họ instance storage-optimized như `i3en`/`i4i` đạt **hàng triệu IOPS đọc** — không loại EBS nào chạm tới.

Đổi lại, tính chất **ephemeral** là tuyệt đối. Dữ liệu **mất** khi:

- Instance **stop** hoặc **hibernate** (instance có thể chuyển sang host khác khi start lại);
- Instance **terminate**;
- **Hỏng phần cứng** ổ đĩa/host.

Dữ liệu **còn** khi **reboot** (instance vẫn nằm trên host cũ). Phân biệt stop ≠ reboot là điểm gài quen thuộc.

Các đặc điểm vận hành: dung lượng và số ổ instance store **cố định theo instance type** (không thêm bớt được sau khi launch, phải khai báo trong block device mapping lúc launch với các type cũ; NVMe đời mới tự attach); **không chụp snapshot được** bằng cơ chế EBS; muốn backup phải tự copy dữ liệu (vd. `aws s3 sync`) hoặc dựa vào replication tầng ứng dụng.

Use case đúng: buffer/cache/scratch space, tempdb, shard của hệ phân tán **tự replicate** (Cassandra, Elasticsearch/OpenSearch self-managed, Kafka broker với replication factor ≥ 3) — mất một node không mất dữ liệu, và hiệu năng đĩa local là lợi thế quyết định.

> 💡 **Exam Tip:** Từ khoá "highest possible IOPS", "very low latency", kèm dữ liệu "can be regenerated / replicated elsewhere / temporary" → **Instance Store**. Nếu đề nói dữ liệu phải "persist after stop/terminate" → loại Instance Store ngay lập tức, chọn EBS/EFS.

## 5.8 Amazon EFS — file system chia sẻ, co giãn, đa AZ

### Cơ chế và đặc tính

EFS là managed **NFSv4.1** file system cho Linux (POSIX-compliant: permissions, ownership, file locking chuẩn Unix; **không hỗ trợ Windows**). Khác biệt căn bản với EBS:

- **Mount đồng thời** vào hàng nghìn instance (EC2, ECS, EKS, Lambda — tích hợp Lambda+EFS ở Chương 29, ECS+EFS ở Chương 17), **xuyên nhiều AZ** trong region.
- **Tự co giãn** tới quy mô petabyte — không khai báo size, không resize, **trả tiền theo GB dùng thực tế** (đắt hơn gp2 trên mỗi GB ~3 lần, nhưng không trả cho phần provision thừa).
- Truy cập qua network endpoint gọi là **mount target** — mỗi AZ tạo một mount target (một ENI có IP trong subnet), instance trong AZ nào mount qua target AZ đó để tránh phí cross-AZ và giảm latency.
- Bảo mật bằng **Security Group gắn vào mount target** (mở port **NFS 2049** từ SG của instance), mã hoá at rest bằng KMS (chọn lúc tạo, không bật sau được) và in transit bằng TLS (`-o tls` qua EFS mount helper).

### Mount EFS đa AZ

```bash
# Tạo file system + bật mã hoá
aws efs create-file-system --encrypted --kms-key-id alias/aws/elasticfilesystem \
  --performance-mode generalPurpose --throughput-mode elastic \
  --tags Key=Name,Value=shared-assets

# Tạo mount target ở TỪNG AZ có instance cần mount
aws efs create-mount-target --file-system-id fs-0123abcd \
  --subnet-id subnet-aaa111 --security-groups sg-0efs2049
aws efs create-mount-target --file-system-id fs-0123abcd \
  --subnet-id subnet-bbb222 --security-groups sg-0efs2049

# Trên mỗi EC2 instance (đã cài amazon-efs-utils):
sudo mount -t efs -o tls fs-0123abcd:/ /mnt/shared
# Hoặc ghi vào /etc/fstab để mount tự động khi boot:
# fs-0123abcd:/ /mnt/shared efs _netdev,tls 0 0
```

EFS mount helper (`amazon-efs-utils`) tự resolve DNS của file system về mount target **cùng AZ** với instance — đó là lý do nên tạo mount target ở mọi AZ thay vì mount chéo AZ.

### Performance modes — chọn LÚC TẠO, không đổi được

- **General Purpose (mặc định):** độ trễ thấp nhất (vài ms), phù hợp web serving, CMS, home directories, CI/CD workspace. Trần ~35,000 read IOPS. **Dùng cho 99% trường hợp.**
- **Max I/O:** trần IOPS và throughput tổng cao hơn nhiều (hàng trăm nghìn ops/s) cho workload song song cực lớn (big data, media processing hàng trăm client), **đổi lại độ trễ từng thao tác cao hơn**. Không tương thích với Elastic throughput mode và không dùng được với One Zone.

### Throughput modes — đổi được sau khi tạo

- **Bursting:** throughput tỷ lệ với dung lượng đang lưu (baseline 50 KiB/s mỗi GiB, burst tới 100 MiB/s+ theo credit). Bẫy production kinh điển: file system **nhỏ** (vài GB) → baseline gần như bằng 0, hết burst credit là ứng dụng "đứng hình" dù chẳng ai làm gì sai.
- **Provisioned:** khai báo throughput cố định (tới 1 GiB/s+) **độc lập với dung lượng** — giải pháp cho ca "ít dữ liệu nhưng cần throughput cao", trả tiền cho phần provision.
- **Elastic (khuyến nghị mặc định hiện nay):** tự co giãn theo nhu cầu tức thời, trả tiền theo lượng đọc/ghi thực tế; đọc tới 10–60 GiB/s tuỳ region. Hợp với workload khó dự đoán, spiky.

> 💡 **Exam Tip:** Phân biệt hai trục cấu hình độc lập của EFS: **performance mode** (General Purpose vs Max I/O — chốt lúc tạo, đánh đổi latency vs quy mô song song) và **throughput mode** (Bursting vs Provisioned vs Elastic — đổi được sau). Câu "EFS chậm dù dung lượng nhỏ" → hết burst credit, chuyển sang **Provisioned** hoặc **Elastic** throughput, KHÔNG phải đổi performance mode.

### Storage classes & lifecycle policy

EFS có hai trục storage class:

- **Theo độ dư thừa:** **Standard/Regional** (replicate đa AZ — production) vs **One Zone** (một AZ, rẻ hơn ~47%, cho dev/test, dữ liệu tái tạo được; One Zone vẫn backup được bằng AWS Backup).
- **Theo tần suất truy cập:** **Standard** → **Infrequent Access (EFS-IA, rẻ hơn ~92%)** → **Archive (rẻ hơn nữa, cho dữ liệu truy cập vài lần mỗi năm)**. Đọc/ghi vào IA/Archive chịu thêm phí truy cập per-GB.

Việc chuyển tier do **lifecycle policy** đảm nhiệm: ví dụ "file không được đọc trong 30 ngày → IA, 90 ngày → Archive, đọc lại thì chuyển về Standard":

```bash
aws efs put-lifecycle-configuration --file-system-id fs-0123abcd \
  --lifecycle-policies \
    '{"TransitionToIA":"AFTER_30_DAYS"}' \
    '{"TransitionToArchive":"AFTER_90_DAYS"}' \
    '{"TransitionToPrimaryStorageClass":"AFTER_1_ACCESS"}'
```

Việc chuyển tier trong suốt với ứng dụng — vẫn cùng path, cùng API POSIX. (So sánh với lifecycle của S3 ở Chương 13 — ý tưởng giống nhau nhưng S3 là object storage.)

Ví dụ thao tác EFS bằng Go SDK v2 (kiểm tra mount target trước khi deploy app):

```go
package main

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/efs"
)

func main() {
	cfg, _ := config.LoadDefaultConfig(context.TODO())
	client := efs.NewFromConfig(cfg)

	// Liệt kê mount target — xác nhận đủ AZ trước khi scale ASG đa AZ
	out, err := client.DescribeMountTargets(context.TODO(), &efs.DescribeMountTargetsInput{
		FileSystemId: ptr("fs-0123abcd"),
	})
	if err != nil {
		panic(err)
	}
	for _, mt := range out.MountTargets {
		fmt.Printf("%s -> AZ %s, IP %s\n", *mt.MountTargetId, *mt.AvailabilityZoneName, *mt.IpAddress)
	}
}

func ptr(s string) *string { return &s }
```

## 5.9 Tổng so sánh & khung quyết định cho đề thi

| Tiêu chí | EBS | Instance Store | EFS |
|---|---|---|---|
| Loại storage | Block (network) | Block (local, vật lý) | File (NFS) |
| Phạm vi | 1 AZ (di chuyển qua snapshot) | Gắn chặt host | Region, đa AZ (Standard) |
| Số instance dùng đồng thời | 1 (io1/io2 Multi-Attach: 16, cùng AZ) | 1 | Hàng nghìn, đa AZ |
| Persist sau stop/terminate | Có (chú ý DeleteOnTermination với root) | **Mất khi stop/terminate** (còn khi reboot) | Có, độc lập với instance |
| Provision dung lượng | Có, chỉ tăng được | Cố định theo instance type | Không — tự co giãn, trả theo dùng |
| Hiệu năng đỉnh | io2 BE: 256,000 IOPS | Hàng triệu IOPS | Throughput tổng rất cao, latency per-op cao hơn EBS |
| Backup | Snapshot (incremental, DLM) | Tự lo (S3 sync / app replication) | AWS Backup, EFS Replication |
| OS | Linux/Windows | Linux/Windows | **Chỉ Linux (NFS/POSIX)** |
| Mã hoá | KMS, bật mặc định cấp account được | Tự mã hoá trên một số type (NVMe tự động) | KMS at rest (lúc tạo) + TLS in transit |

Khung quyết định nhanh khi đọc đề:

1. Dữ liệu chia sẻ giữa **nhiều instance/nhiều AZ**, cần POSIX/file path? → **EFS**. Thêm "cost optimization cho file ít đụng tới" → **lifecycle sang EFS-IA/Archive**; dev/test một AZ → **One Zone**.
2. Ổ đĩa cho **một** instance, dữ liệu bền? → **EBS**. Sau đó chọn loại: workload chung/boot → **gp3**; >16,000 IOPS hoặc Multi-Attach hoặc cần latency ổn định cho DB → **io1/io2**; tuần tự throughput lớn, giá rẻ, không boot → **st1**; lạnh nhất → **sc1**.
3. Tốc độ tối đa, dữ liệu tạm/tự replicate? → **Instance Store**.
4. Đề nói "object", "presigned URL", "static website", truy cập qua HTTP API → đó là **S3**, không phải ba loại trên (Chương 12).

> 💡 **Exam Tip:** Ba "chữ ký" giúp loại đáp án trong 5 giây: **EBS = 1 AZ**, **EFS = nhiều AZ + chỉ Linux + trả theo dung lượng dùng**, **Instance Store = mất dữ liệu khi stop**. Phần lớn đáp án nhiễu của chủ đề này vi phạm đúng một trong ba chữ ký đó — ví dụ "dùng EBS Multi-Attach cho instances ở 2 AZ" hay "dùng EFS cho Windows file share" (Windows → FSx).

Một lưu ý production cuối: chi phí EFS tính trên GB-tháng cao hơn EBS, nhưng EBS bắt bạn trả cho **dung lượng provision** còn EFS trả cho **dung lượng dùng**. Một fleet 10 instance, mỗi máy gắn volume 100 GiB nhưng chỉ dùng 20 GiB, tốn tiền 1,000 GiB EBS; chuyển dữ liệu chung đó lên một EFS 200 GiB dùng thật + lifecycle IA có thể rẻ hơn đáng kể — đề DVA-C02 thích kiểu câu "most cost-effective" như vậy ở domain Troubleshooting & Optimization.

---

## Hands-on Lab: EBS gp3 từ A–Z, snapshot mã hoá & mount EFS đa AZ

**Mục tiêu lab:** Tạo và gắn EBS gp3 volume vào EC2, tăng IOPS/throughput online bằng Elastic Volumes, tạo snapshot rồi copy thành snapshot mã hoá, restore sang AZ khác; sau đó tạo EFS file system với mount target ở 2 AZ và mount đồng thời từ 2 instance để thấy rõ khác biệt EBS (block, 1 AZ) vs EFS (file, đa AZ).

**Chuẩn bị:**
- AWS CLI v2 đã cấu hình (chi tiết ở Chương 3), region ví dụ `ap-southeast-1`.
- 2 EC2 instance Amazon Linux 2023 loại `t3.micro` ở 2 AZ khác nhau (`ap-southeast-1a` và `ap-southeast-1b`), đã gắn Security Group cho phép SSH (cách launch ở Chương 4). Gọi chúng là `instance-a` và `instance-b`.
- Lab tốn ~0.1–0.3 USD nếu dọn dẹp trong vòng 1–2 giờ. **Nhớ làm mục Dọn dẹp tài nguyên.**

Lưu instance ID và AZ vào biến để dùng xuyên suốt:

```bash
INSTANCE_A=i-0aaaa1111bbbb2222   # thay bằng ID thật của bạn
INSTANCE_B=i-0cccc3333dddd4444
AZ_A=ap-southeast-1a
AZ_B=ap-southeast-1b
```

### Bước 1: Tạo EBS gp3 volume và gắn vào instance-a

```bash
VOLUME_ID=$(aws ec2 create-volume \
  --availability-zone $AZ_A \
  --size 10 \
  --volume-type gp3 \
  --iops 3000 \
  --throughput 125 \
  --tag-specifications 'ResourceType=volume,Tags=[{Key=Name,Value=lab-ch05}]' \
  --query 'VolumeId' --output text)

aws ec2 wait volume-available --volume-ids $VOLUME_ID

aws ec2 attach-volume \
  --volume-id $VOLUME_ID \
  --instance-id $INSTANCE_A \
  --device /dev/sdf
```

Output mong đợi của `attach-volume`:

```json
{
    "AttachTime": "2026-06-12T03:15:20+00:00",
    "Device": "/dev/sdf",
    "InstanceId": "i-0aaaa1111bbbb2222",
    "State": "attaching",
    "VolumeId": "vol-0123456789abcdef0"
}
```

Lưu ý: gp3 có **baseline 3000 IOPS và 125 MiB/s miễn phí bất kể size** — khác gp2 (IOPS tỉ lệ size, 3 IOPS/GiB). Volume chỉ tạo được trong đúng 1 AZ; nếu bạn cố attach volume ở `1a` vào instance ở `1b`, API trả lỗi `InvalidVolume.ZoneMismatch`.

### Bước 2: Format và mount trên instance-a

SSH vào instance-a (hoặc dùng EC2 Instance Connect), rồi:

```bash
lsblk
# Trên Nitro instance, /dev/sdf hiện ra là /dev/nvme1n1
sudo mkfs -t xfs /dev/nvme1n1
sudo mkdir /data
sudo mount /dev/nvme1n1 /data
echo "hello ebs" | sudo tee /data/test.txt
df -h /data
```

Output mong đợi của `df -h /data`:

```
Filesystem      Size  Used Avail Use% Mounted on
/dev/nvme1n1     10G  104M  9.9G   2% /data
```

Bẫy thực tế: tên device bạn khai (`/dev/sdf`) bị NVMe driver đổi thành `/dev/nvme1n1`. Đừng hardcode tên NVMe trong `/etc/fstab` vì thứ tự enumerate có thể đổi sau reboot — dùng UUID (`sudo blkid`) thay thế.

### Bước 3: Tăng performance online với Elastic Volumes

Không cần detach, không downtime:

```bash
aws ec2 modify-volume --volume-id $VOLUME_ID \
  --size 20 --iops 4000 --throughput 250

aws ec2 describe-volumes-modifications --volume-ids $VOLUME_ID \
  --query 'VolumesModifications[0].ModificationState'
```

Output: `"optimizing"` rồi chuyển `"completed"`. Trên instance phải tự grow filesystem: `sudo xfs_growfs /data`. Bẫy hay gặp trong đề: sau khi modify volume, phải chờ **6 giờ** mới được modify tiếp volume đó (cooldown); và size chỉ tăng được, **không giảm** được.

### Bước 4: Snapshot và copy thành snapshot mã hoá

```bash
SNAP_ID=$(aws ec2 create-snapshot \
  --volume-id $VOLUME_ID \
  --description "lab ch05 snapshot" \
  --query 'SnapshotId' --output text)

aws ec2 wait snapshot-completed --snapshot-ids $SNAP_ID

# Copy + mã hoá bằng KMS key mặc định aws/ebs
ENC_SNAP_ID=$(aws ec2 copy-snapshot \
  --source-region ap-southeast-1 \
  --source-snapshot-id $SNAP_ID \
  --encrypted \
  --query 'SnapshotId' --output text)
```

Snapshot là **incremental** và lưu trên S3 (do AWS quản lý, bạn không thấy bucket). Đây chính là cách chuẩn để mã hoá một volume unencrypted: snapshot → copy có `--encrypted` → tạo volume mới từ snapshot mã hoá. Không có cách "bật encryption tại chỗ" cho volume đang chạy.

### Bước 5: Restore volume mã hoá sang AZ khác

```bash
aws ec2 wait snapshot-completed --snapshot-ids $ENC_SNAP_ID

NEW_VOL=$(aws ec2 create-volume \
  --availability-zone $AZ_B \
  --snapshot-id $ENC_SNAP_ID \
  --volume-type gp3 \
  --query 'VolumeId' --output text)

aws ec2 describe-volumes --volume-ids $NEW_VOL \
  --query 'Volumes[0].{AZ:AvailabilityZone,Encrypted:Encrypted,State:State}'
```

Output mong đợi:

```json
{
    "AZ": "ap-southeast-1b",
    "Encrypted": true,
    "State": "available"
}
```

Đây là pattern thi hay hỏi: **snapshot là cách duy nhất "di chuyển" EBS qua AZ/region**. Nếu cần đọc dữ liệu restore với full performance ngay (không chờ lazy-load từ S3), bật Fast Snapshot Restore — nhưng FSR tính phí theo giờ/AZ, khá đắt.

### Bước 6: Tạo EFS và mount targets ở 2 AZ

```bash
FS_ID=$(aws efs create-file-system \
  --performance-mode generalPurpose \
  --throughput-mode elastic \
  --encrypted \
  --tags Key=Name,Value=lab-ch05-efs \
  --query 'FileSystemId' --output text)

# Lấy subnet của từng instance
SUBNET_A=$(aws ec2 describe-instances --instance-ids $INSTANCE_A \
  --query 'Reservations[0].Instances[0].SubnetId' --output text)
SUBNET_B=$(aws ec2 describe-instances --instance-ids $INSTANCE_B \
  --query 'Reservations[0].Instances[0].SubnetId' --output text)

# Security Group cho EFS: mở TCP 2049 (NFS) từ SG của instances
EFS_SG=$(aws ec2 create-security-group --group-name lab-efs-sg \
  --description "NFS for lab" --query 'GroupId' --output text)
INSTANCE_SG=$(aws ec2 describe-instances --instance-ids $INSTANCE_A \
  --query 'Reservations[0].Instances[0].SecurityGroups[0].GroupId' --output text)
aws ec2 authorize-security-group-ingress --group-id $EFS_SG \
  --protocol tcp --port 2049 --source-group $INSTANCE_SG

# Mount target mỗi AZ một cái
aws efs create-mount-target --file-system-id $FS_ID \
  --subnet-id $SUBNET_A --security-groups $EFS_SG
aws efs create-mount-target --file-system-id $FS_ID \
  --subnet-id $SUBNET_B --security-groups $EFS_SG
```

Chờ mount target sang `available`:

```bash
aws efs describe-mount-targets --file-system-id $FS_ID \
  --query 'MountTargets[].{AZ:AvailabilityZoneName,State:LifeCycleState}'
```

Điểm cốt lõi: EFS là dịch vụ regional, nhưng instance kết nối qua **mount target** — một ENI trong subnet của từng AZ. Cổng giao tiếp là NFS 4.1, TCP 2049. Quên mở port 2049 trên SG của mount target là lỗi "mount hangs" kinh điển.

### Bước 7: Mount đồng thời từ 2 instance ở 2 AZ

Trên **cả instance-a và instance-b** (cài amazon-efs-utils để mount qua helper, hỗ trợ TLS):

```bash
sudo dnf -y install amazon-efs-utils
sudo mkdir -p /shared
sudo mount -t efs -o tls fs-0123456789abcdef0:/ /shared   # thay FS_ID của bạn
```

Trên instance-a: `echo "from A" | sudo tee /shared/a.txt`. Trên instance-b: `cat /shared/a.txt` → in ra `from A` ngay lập tức. Đây là điều EBS **không làm được** (trừ io1/io2 Multi-Attach trong cùng AZ với cluster-aware filesystem — không phải POSIX sharing thông thường).

### Dọn dẹp tài nguyên

Làm đúng thứ tự, tránh bị phí treo:

```bash
# 1. Unmount trên cả 2 instance: sudo umount /shared /data

# 2. Xoá EFS (phải xoá mount targets trước)
for MT in $(aws efs describe-mount-targets --file-system-id $FS_ID \
  --query 'MountTargets[].MountTargetId' --output text); do
  aws efs delete-mount-target --mount-target-id $MT
done
sleep 60
aws efs delete-file-system --file-system-id $FS_ID
aws ec2 delete-security-group --group-id $EFS_SG

# 3. Detach & xoá volumes
aws ec2 detach-volume --volume-id $VOLUME_ID
aws ec2 wait volume-available --volume-ids $VOLUME_ID
aws ec2 delete-volume --volume-id $VOLUME_ID
aws ec2 delete-volume --volume-id $NEW_VOL

# 4. Xoá snapshots
aws ec2 delete-snapshot --snapshot-id $SNAP_ID
aws ec2 delete-snapshot --snapshot-id $ENC_SNAP_ID

# 5. Terminate instances nếu không dùng tiếp cho chương sau
aws ec2 terminate-instances --instance-ids $INSTANCE_A $INSTANCE_B
```

Kiểm tra lại bằng `aws ec2 describe-volumes --filters Name=tag:Name,Values=lab-ch05` — kết quả phải rỗng.

## 💡 Exam Tips chương 5

- **gp2 → gp3**: gp3 cho phép cấu hình IOPS (3000–16000) và throughput (125–1000 MiB/s) **độc lập với size**; gp2 thì IOPS gắn với size (3 IOPS/GiB, burst tới 3000). Câu "tăng IOPS mà không tăng dung lượng, chi phí thấp nhất" → gp3.
- Cần **> 16.000 IOPS** hoặc latency dưới mili giây cho database → io1/io2 (Provisioned IOPS, tối đa 64.000 IOPS trên Nitro, io2 Block Express tới 256.000). gp3 không bao giờ vượt 16.000.
- **st1/sc1** là HDD throughput-optimized/cold: không làm boot volume được, không phù hợp small random I/O; dùng cho big data, log processing tuần tự.
- EBS volume **bị khoá trong 1 AZ**. Di chuyển qua AZ/region = snapshot rồi tạo volume mới (copy snapshot nếu sang region khác). Đề hỏi "move volume to another AZ" → snapshot, không có đáp án "detach rồi attach".
- Mã hoá volume đang unencrypted: snapshot → **copy snapshot với encryption bật** → create volume từ snapshot mới. Snapshot của volume mã hoá thì tự động mã hoá; không thể "unencrypt".
- Bật **Encryption by default** ở cấp region thì mọi volume/snapshot mới tự mã hoá; encryption dùng KMS (chi tiết KMS ở Chương 46) và trong suốt với ứng dụng, không ảnh hưởng đáng kể latency.
- **EBS Multi-Attach** chỉ cho io1/io2, tối đa 16 Nitro instances, **cùng AZ**, và cần cluster-aware filesystem — không phải giải pháp shared file system thông thường. "Shared POSIX file system across AZs" → EFS.
- **Instance Store**: ephemeral, mất dữ liệu khi stop/hibernate/terminate (reboot thì còn); IOPS rất cao (hàng trăm nghìn đến hàng triệu); dùng cho buffer/cache/scratch data. Không snapshot trực tiếp được.
- **EFS chỉ cho Linux** (NFS 4.1), pay-per-use, scale tự động, mount đa AZ qua mount target + SG mở TCP 2049. Windows shared storage → FSx (ngoài phạm vi chương).
- EFS performance modes: **General Purpose** (latency thấp, mặc định, dùng cho web/CMS) vs **Max I/O** (throughput/IOPS tổng cao hơn nhưng latency cao hơn, big data). Chọn lúc tạo, không đổi được (Max I/O không khả dụng với Elastic throughput).
- EFS throughput modes: **Elastic** (mặc định, auto scale — chọn khi workload khó đoán), **Provisioned** (cố định throughput bất kể size), **Bursting** (theo size). EFS storage classes + lifecycle policy (IA, Archive) tiết kiệm tới ~90% chi phí cho file ít truy cập.
- Snapshot tiết kiệm chi phí dài hạn: **EBS Snapshots Archive** (rẻ hơn ~75%, restore mất 24–72 giờ) và **Recycle Bin** (giữ snapshot đã xoá theo retention rule 1 ngày–1 năm). **FSR** = restore không cần warm-up nhưng đắt.

## Quiz chương 5 (10 câu)

**Câu 1.** Một ứng dụng database trên EC2 cần 10.000 IOPS ổn định trên volume 200 GiB. Giải pháp **chi phí thấp nhất**?
- A. gp2 200 GiB
- B. gp3 200 GiB với provisioned 10.000 IOPS
- C. io1 200 GiB với 10.000 IOPS
- D. io2 200 GiB với 10.000 IOPS

**Câu 2.** A developer needs to move một EBS volume từ AZ `us-east-1a` sang `us-east-1b`. Cách đúng?
- A. Detach volume và attach vào instance ở `us-east-1b`
- B. Dùng EBS Multi-Attach để gắn vào instance ở cả hai AZ
- C. Tạo snapshot, rồi tạo volume mới từ snapshot trong `us-east-1b`
- D. Bật cross-AZ replication trên volume

**Câu 3.** Một volume gp2 đang chứa dữ liệu nhạy cảm nhưng **chưa mã hoá**. Yêu cầu: dữ liệu phải được mã hoá at rest. Quy trình đúng?
- A. Bật encryption trong tab cài đặt của volume
- B. Snapshot volume → copy snapshot với encryption → tạo volume từ snapshot mã hoá → swap volume
- C. Dùng lệnh `aws ec2 encrypt-volume`
- D. Attach volume vào instance có IMDSv2 và bật encryption qua user data

**Câu 4.** Ứng dụng xử lý video cần **scratch space tạm** với IOPS cực cao; dữ liệu có thể tạo lại nếu mất. Storage nào phù hợp nhất?
- A. io2 Block Express
- B. Instance Store
- C. EFS Max I/O
- D. gp3 với 16.000 IOPS

**Câu 5.** A developer needs một shared file system POSIX cho fleet EC2 Linux chạy ở **3 AZ**, ghi/đọc đồng thời. Chọn gì?
- A. EBS io2 Multi-Attach
- B. EBS gp3 gắn lần lượt từng instance
- C. Amazon EFS với mount target ở mỗi AZ
- D. Instance Store chia sẻ qua NFS tự dựng

**Câu 6.** Team mount EFS từ EC2 nhưng lệnh mount bị **treo (hang)** rồi timeout. Nguyên nhân khả dĩ nhất?
- A. EFS chưa bật encryption
- B. Security group của mount target không cho phép inbound TCP 2049 từ instance
- C. Instance dùng IMDSv1 thay vì IMDSv2
- D. EFS đang ở chế độ Bursting throughput nên hết burst credits

**Câu 7.** Sau khi tạo volume 500 GiB từ snapshot, ứng dụng bị **latency cao ở lần đọc đầu tiên** từng block. Cách loại bỏ hoàn toàn hiện tượng này cho các lần restore sau?
- A. Đổi volume sang io2
- B. Bật Fast Snapshot Restore (FSR) cho snapshot ở AZ đích
- C. Tăng throughput gp3 lên 1000 MiB/s
- D. Bật EBS encryption

**Câu 8.** Yêu cầu lưu snapshot tuân thủ audit, hiếm khi restore, giảm tối đa chi phí lưu trữ; chấp nhận thời gian restore tính bằng **giờ**. Chọn gì?
- A. EBS Snapshots Archive
- B. Fast Snapshot Restore
- C. Recycle Bin với retention 1 năm
- D. Copy snapshot sang region rẻ hơn

**Câu 9.** Một web app trên EFS có hàng nghìn file ít khi đọc lại sau 30 ngày. Cách **giảm chi phí** ít công sức vận hành nhất?
- A. Cron job copy file cũ sang S3 Glacier
- B. Bật EFS lifecycle policy chuyển sang EFS Infrequent Access sau 30 ngày
- C. Chuyển sang EBS sc1
- D. Giảm provisioned throughput của EFS

**Câu 10.** A developer cần 2 instance trong **cùng một AZ** cùng ghi vào một volume cho cluster database có cluster-aware filesystem. Chọn gì?
- A. gp3 với Multi-Attach
- B. io2 với Multi-Attach
- C. EFS performance mode Max I/O
- D. st1 attach vào cả hai instance

### Đáp án & giải thích

**Câu 1 — Đáp án B.** gp3 cho provision IOPS độc lập với size: 200 GiB + 10.000 IOPS nằm trong trần 16.000 của gp3 và rẻ hơn io1/io2 đáng kể. **A sai:** gp2 200 GiB chỉ có baseline 600 IOPS (3 IOPS/GiB), burst 3000 không ổn định ở mức 10.000. **C, D sai:** io1/io2 đáp ứng được nhưng giá per-IOPS cao hơn gp3 nhiều — đề hỏi "chi phí thấp nhất".

**Câu 2 — Đáp án C.** Snapshot lưu trên S3 và không gắn AZ, nên restore được sang AZ bất kỳ trong region. **A sai:** volume bị khoá trong AZ tạo ra nó, attach cross-AZ trả lỗi `ZoneMismatch`. **B sai:** Multi-Attach chỉ hoạt động trong **cùng** AZ và chỉ với io1/io2. **D sai:** không tồn tại tính năng cross-AZ replication cho EBS volume.

**Câu 3 — Đáp án B.** Không thể bật mã hoá tại chỗ; flow chuẩn là snapshot → copy có `--encrypted` → tạo volume mới → detach volume cũ, attach volume mới. **A, C sai:** không có toggle/API như vậy. **D sai:** IMDSv2 và user data không liên quan gì đến encryption at rest của EBS.

**Câu 4 — Đáp án B.** Instance Store là physically attached NVMe, IOPS cao nhất trong các lựa chọn, miễn phí kèm instance type, và "dữ liệu tạo lại được" khớp với tính ephemeral. **A sai:** io2 Block Express rất nhanh nhưng đắt và thừa độ bền cho scratch data. **C sai:** EFS là network file system, latency cao hơn hẳn local NVMe. **D sai:** gp3 trần 16.000 IOPS, vẫn là network storage, không "cực cao".

**Câu 5 — Đáp án C.** EFS là managed NFS regional, mount đồng thời từ hàng trăm/nghìn instance qua mount target ở mỗi AZ — đúng yêu cầu POSIX + đa AZ. **A sai:** Multi-Attach giới hạn cùng AZ, tối đa 16 instances, cần cluster filesystem. **B sai:** EBS chỉ attach một instance tại một thời điểm (trừ Multi-Attach), không phải shared. **D sai:** Instance Store mất dữ liệu khi stop, tự dựng NFS là single point of failure và overhead vận hành lớn.

**Câu 6 — Đáp án B.** Triệu chứng mount treo/timeout với EFS gần như luôn do SG của mount target chặn NFS port 2049 (hoặc NACL). **A sai:** encryption không ảnh hưởng khả năng mount. **C sai:** IMDS phục vụ metadata, không liên quan NFS. **D sai:** hết burst credits gây throughput chậm, không làm mount fail.

**Câu 7 — Đáp án B.** Volume restore từ snapshot lazy-load block từ S3 → first-read penalty; FSR khởi tạo sẵn (pre-warm) toàn bộ block ở AZ được bật nên volume đạt full performance ngay. **A, C sai:** đổi volume type hay tăng throughput không loại bỏ việc block chưa được hydrate từ S3. **D sai:** encryption không liên quan đến lazy loading.

**Câu 8 — Đáp án A.** Snapshots Archive đưa snapshot sang tier lưu trữ rẻ hơn ~75%, đổi lại restore mất 24–72 giờ — khớp "hiếm restore, chấp nhận chờ". **B sai:** FSR là tính năng tăng tốc restore và **tốn thêm tiền**, ngược yêu cầu. **C sai:** Recycle Bin là lưới an toàn chống xoá nhầm, không giảm chi phí lưu trữ. **D sai:** copy cross-region nhân đôi chi phí lưu và thêm phí transfer.

**Câu 9 — Đáp án B.** Lifecycle policy của EFS tự chuyển file không truy cập sau N ngày sang EFS-IA (rẻ hơn tới ~92%), zero code, file vẫn trong cùng namespace. **A sai:** cron + Glacier là tự chế, thay đổi đường dẫn truy cập file, nhiều công vận hành. **C sai:** sc1 là block storage 1 AZ, mất tính shared file system. **D sai:** throughput không phải thành phần chi phí lưu trữ chính ở đây, và giảm nó ảnh hưởng performance.

**Câu 10 — Đáp án B.** Multi-Attach chỉ hỗ trợ io1/io2, cho tối đa 16 Nitro instances cùng AZ, đúng kịch bản cluster-aware filesystem. **A sai:** gp3 không hỗ trợ Multi-Attach. **C sai:** EFS là file storage NFS, không phải block volume mà cluster database yêu cầu. **D sai:** st1 không hỗ trợ Multi-Attach và HDD không phù hợp database.

## Tóm tắt chương

- EBS là **network block storage gắn 1 AZ**, persist độc lập với instance; Instance Store là **local NVMe ephemeral** — nhanh nhất nhưng mất dữ liệu khi stop/terminate.
- Volume types: **gp3** (mặc định nên dùng, 3000 IOPS/125 MiB/s baseline, provision tới 16.000 IOPS độc lập size), **gp2** (IOPS = 3×GiB, burst 3000), **io1/io2** (>16.000 IOPS, sub-ms, Multi-Attach), **st1/sc1** (HDD tuần tự, không boot được).
- **Elastic Volumes**: tăng size/IOPS/throughput online, không downtime; chỉ tăng size không giảm; cooldown 6 giờ giữa 2 lần modify.
- **Snapshots** là incremental, lưu trên S3, là cơ chế duy nhất di chuyển volume qua AZ/region và là nền tảng tạo AMI; restore bị first-read latency do lazy loading — FSR khắc phục (có phí).
- Tiết kiệm snapshot: **Archive** (rẻ ~75%, restore 24–72h), **Recycle Bin** (chống xoá nhầm theo retention rule).
- **Encryption**: bật khi tạo hoặc qua flow snapshot → encrypted copy → volume mới; mọi thứ sinh ra từ resource mã hoá đều mã hoá; có thể bật encryption-by-default cấp region.
- **Multi-Attach**: chỉ io1/io2, ≤16 Nitro instances, cùng AZ, cần cluster-aware filesystem — không phải shared file system thông thường.
- **EFS**: managed NFS 4.1 cho Linux, regional, scale tự động, pay-per-use, mount đa AZ qua mount target (mỗi AZ một ENI, SG mở TCP 2049).
- EFS performance modes (General Purpose vs Max I/O — chọn lúc tạo) và throughput modes (Elastic/Provisioned/Bursting); storage classes Standard/IA/Archive + lifecycle policy để giảm chi phí.
- Quy tắc chọn nhanh: block 1 instance → EBS; scratch/cache cực nhanh → Instance Store; shared POSIX đa AZ Linux → EFS; cluster cùng AZ ghi chung block → io1/io2 Multi-Attach.
