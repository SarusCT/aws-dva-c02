# Chương 9: ElastiCache — Redis & Memcached

> **Trọng tâm DVA-C02:** ElastiCache xuất hiện trong đề chủ yếu dưới dạng câu hỏi tình huống: chọn Redis hay Memcached cho yêu cầu cụ thể (HA, persistence, multi-thread), chọn caching strategy (lazy loading vs write-through) cho bài toán consistency/latency, và chọn cấu trúc dữ liệu Redis cho use case kinh điển (sorted sets cho leaderboard, session store cho web tier stateless). Ngoài ra có vài câu về bảo mật in-transit/at-rest và Redis AUTH.

## Mục tiêu chương

- Hiểu cơ chế caching giảm tải database như thế nào, và khi nào cache gây hại nhiều hơn lợi.
- Phân biệt rạch ròi Redis vs Memcached trên từng tiêu chí: replication, persistence, threading, data structures — trả lời được mọi biến thể câu hỏi so sánh trong đề.
- Nắm vững hai chiến lược caching chính (lazy loading / cache-aside và write-through), ưu nhược điểm, và cách kết hợp với TTL để xử lý stale data.
- Hiểu kiến trúc Redis trên ElastiCache: node, shard, replication group, cluster mode disabled vs enabled, primary/reader endpoint, failover.
- Triển khai session store, leaderboard (sorted sets), pub/sub bằng code Node.js chạy được.
- Cấu hình bảo mật đúng: Redis AUTH, encryption in-transit/at-rest, Security Group, IAM authentication.

## 9.1 Vì sao cần cache, và ElastiCache là gì

Bài toán gốc: database quan hệ (RDS/Aurora — chi tiết ở Chương 8) xử lý read query tốn CPU, I/O và connection. Khi traffic tăng, các query đọc lặp đi lặp lại (trang chủ, profile user, danh sách sản phẩm hot) chiếm phần lớn tải, trong khi kết quả gần như không đổi giữa các lần gọi. Cách giải quyết rẻ nhất không phải scale database lên — mà là **đừng hỏi database câu đã có đáp án**.

Cache là một lớp lưu trữ key-value **in-memory** đặt giữa application và database. Đọc từ RAM có latency sub-millisecond (thường < 1ms), so với hàng chục ms của một query SQL chạm disk. Cơ chế bên dưới rất đơn giản: dữ liệu được serialize (thường là JSON hoặc string) và lưu theo key; mọi truy cập là hash lookup O(1) trong bộ nhớ, không có query planner, không có disk seek.

**Amazon ElastiCache** là dịch vụ managed cho hai engine cache phổ biến nhất: **Redis** (bao gồm cả Valkey — fork mã nguồn mở của Redis mà AWS hỗ trợ từ 2024, với đề thi cứ coi tương đương Redis) và **Memcached**. "Managed" nghĩa là AWS lo provisioning, patching, monitoring, failover, backup — bạn lo phần khó nhất: **application code phải tự xử lý logic cache** (đọc/ghi cache, invalidation, xử lý cache miss). Đây là điểm đề thi rất thích nhấn: ElastiCache đòi hỏi *heavy application code changes*, khác với DAX của DynamoDB là drop-in API-compatible (chi tiết ở Chương 33).

Khi nào **không** nên cache:

- Dữ liệu thay đổi liên tục và mọi lần đọc đều cần giá trị mới nhất (số dư tài khoản ngân hàng, inventory lúc checkout) — cache chỉ thêm một nguồn stale data.
- Access pattern phân tán đều, ít key nào được đọc lại (cache hit ratio thấp) — bạn trả tiền RAM để lưu thứ không ai đọc lần hai.
- Workload chủ yếu là write — cache không giúp gì cho write vào database.

Quy tắc thực tế: cache đáng giá khi dữ liệu **đọc nhiều, ghi ít, chấp nhận được độ trễ cập nhật** (eventual consistency giữa cache và DB), và việc tính ra dữ liệu đó tốn kém (query phức tạp, join nhiều bảng, gọi API ngoài).

> 💡 **Exam Tip:** Câu hỏi "database đang quá tải vì read traffic, giải pháp nào giảm tải?" thường có hai đáp án hợp lệ trông giống nhau: **Read Replica** và **ElastiCache**. Phân biệt bằng từ khóa: cần latency **microsecond/sub-millisecond** hoặc dữ liệu lặp lại nhiều → ElastiCache; cần chạy **query SQL phức tạp trên dữ liệu mới** → Read Replica. Nếu đề nói "store session data" hoặc "leaderboard" thì chắc chắn là ElastiCache.

## 9.2 Redis vs Memcached — bảng so sánh phải thuộc

Đây là bảng kinh điển nhất của chương, đề DVA-C02 hỏi đi hỏi lại dưới nhiều biến thể:

| Tiêu chí | Redis | Memcached |
|---|---|---|
| Data structures | Phong phú: strings, hashes, lists, sets, **sorted sets**, streams, geospatial, HyperLogLog | Chỉ strings (key-value đơn giản) |
| Replication | Có — Multi-AZ với auto-failover, tối đa **5 read replicas** mỗi shard | **Không có replication** |
| Persistence | Có — AOF (Append Only File) và snapshot RDB | **Không** — mất hết data khi node restart |
| Backup & restore | Có (snapshot, export S3) | Serverless có; self-designed cluster: không |
| Threading | **Single-threaded** cho lệnh xử lý data (I/O có thể multi-thread ở bản mới) | **Multi-threaded** — tận dụng nhiều core |
| Sharding | Cluster mode enabled: tối đa 500 nodes/cluster | Sharding phía client (tối đa 40 nodes/cluster mặc định) |
| Pub/Sub | Có | Không |
| Transactions (MULTI/EXEC) | Có | Không |
| Auto Discovery | Không cần (dùng configuration endpoint của cluster) | Có — Auto Discovery cho client tự tìm node |
| HA (High Availability) | Có (Multi-AZ, failover < ~ vài chục giây) | Không — node chết là mất data |
| Encryption, AUTH | TLS in-transit, at-rest, Redis AUTH, RBAC, IAM auth | TLS và SASL auth (bản 1.6.12+), không có at-rest cho self-designed |
| Geospatial, Lua scripting | Có | Không |

Cách nhớ nhanh: **Memcached = đơn giản, multi-threaded, không bền** — cache thuần túy, mất là chấp nhận mất, scale ngang bằng cách thêm node và để client tự shard. **Redis = giàu tính năng, bền, HA** — vừa là cache vừa có thể là datastore phụ (session, queue nhẹ, leaderboard).

Cơ chế bên dưới đáng hiểu:

- **Redis single-threaded**: mọi lệnh thao tác data chạy tuần tự trên một thread → mỗi lệnh là atomic một cách tự nhiên, không cần lock. Đổi lại, một lệnh chậm (ví dụ `KEYS *` trên triệu key, hay Lua script nặng) sẽ block toàn bộ các lệnh khác. Đây là lý do production cấm `KEYS`, dùng `SCAN` thay thế.
- **Memcached multi-threaded**: nhiều worker thread xử lý request song song trên cùng bộ nhớ → một node to nhiều core cho throughput rất cao với workload key-value đơn giản.
- **Redis persistence**: RDB snapshot ghi toàn bộ dataset xuống disk định kỳ (fork process, copy-on-write); AOF ghi log từng lệnh write. ElastiCache dùng cơ chế này cho backup/restore. Memcached không có gì tương đương — restart là về số 0, và "cold cache" sau restart có thể dồn toàn bộ traffic xuống database (hiện tượng **thundering herd / cache stampede**).

> 💡 **Exam Tip:** Từ khóa quyết định: "**multi-threaded**" hoặc "simplest caching model" hoặc "scale out/in dễ dàng, không cần replication/backup" → **Memcached**. "**High availability**", "**persistence/durability**", "**sorted sets / pub-sub / leaderboard / complex data types**", "**backup and restore**" → **Redis**. Gặp câu "cần cache survive node failure" — Memcached loại ngay lập tức.

## 9.3 Kiến trúc Redis trên ElastiCache: node, shard, cluster mode

Thuật ngữ ElastiCache hay gây rối, nắm chắc các tầng sau:

- **Node**: một instance chạy engine, có RAM cố định theo node type (ví dụ `cache.t3.micro` 0.5 GiB, `cache.r7g.large` ~13 GiB).
- **Shard (node group)**: 1 primary node + 0–5 read replicas. Write chỉ vào primary; replica nhận data qua **asynchronous replication** (giống Read Replica của RDS — nghĩa là đọc từ replica có thể thấy data cũ vài ms).
- **Cluster (replication group)**: tập hợp các shard.

Hai chế độ Redis bạn **phải** phân biệt:

**Cluster Mode Disabled (CMD)**: đúng 1 shard — 1 primary + tối đa 5 replicas. Toàn bộ dataset nằm trên 1 node (giới hạn bởi RAM của node type). Scale read bằng cách thêm replica, scale write/memory chỉ có cách **scale up** node type. Application dùng:
- **Primary endpoint** cho write (endpoint này không đổi khi failover — DNS tự trỏ sang primary mới).
- **Reader endpoint** load-balance read qua các replica.

**Cluster Mode Enabled (CME)**: dataset được **shard** ra 1–500 node (tối đa 500 shard nếu không replica, hoặc ví dụ 100 shard × 5 replica). Redis chia keyspace thành **16384 hash slots**, mỗi shard giữ một dải slot; client tính `CRC16(key) mod 16384` để biết key nằm shard nào. Application dùng một **configuration endpoint** duy nhất, client library (cluster-aware) tự discover topology. CME cho phép scale **write throughput và dung lượng** vượt giới hạn 1 node, và chịu lỗi tốt hơn (mất 1 shard chỉ mất 1/N dữ liệu).

**Multi-AZ & auto-failover**: bật Multi-AZ (yêu cầu ít nhất 1 replica), khi primary chết ElastiCache promote replica có replication lag thấp nhất thành primary và cập nhật DNS. Với CMD, failover thường mất vài chục giây đến vài phút; ứng dụng chỉ cần retry và resolve lại DNS. Lưu ý replication là async → failover **có thể mất vài write cuối cùng**.

Ngoài self-designed cluster còn có **ElastiCache Serverless**: AWS tự scale, bạn trả theo data stored (GB-hour) và ECPU; phù hợp workload không đoán trước được. Cho đề thi chỉ cần nhận diện ở mức "không phải quản lý node".

Tạo replication group bằng CLI:

```bash
# Redis cluster mode disabled: 1 primary + 2 replicas, Multi-AZ, TLS + AUTH
aws elasticache create-replication-group \
  --replication-group-id app-cache \
  --replication-group-description "Cache cho app chinh" \
  --engine redis \
  --engine-version 7.1 \
  --cache-node-type cache.r7g.large \
  --num-cache-clusters 3 \
  --automatic-failover-enabled \
  --multi-az-enabled \
  --transit-encryption-enabled \
  --at-rest-encryption-enabled \
  --auth-token "MatKhauManh-ItNhat16KyTu" \
  --cache-subnet-group-name private-cache-subnets \
  --security-group-ids sg-0123456789abcdef0

# Lấy endpoint sau khi available
aws elasticache describe-replication-groups \
  --replication-group-id app-cache \
  --query "ReplicationGroups[0].NodeGroups[0].[PrimaryEndpoint.Address,ReaderEndpoint.Address]"
```

ElastiCache **luôn nằm trong VPC, không có public endpoint** — application phải ở cùng VPC (hoặc peered VPC / VPN). Đây là khác biệt với DynamoDB/DAX về mặt vận hành.

> 💡 **Exam Tip:** "Ứng dụng cần tăng write throughput cho Redis vượt khả năng 1 node" → bật **cluster mode enabled** (sharding), không phải thêm read replica (replica chỉ giúp read). Ngược lại "tăng read throughput" → thêm **read replicas** và đọc qua **reader endpoint**.

## 9.4 Caching strategies: Lazy Loading vs Write-Through

Đây là phần "Development" đúng nghĩa của DVA-C02 — đề hỏi bạn chọn strategy nào cho yêu cầu nào, và hiểu trade-off.

### Lazy Loading (Cache-Aside)

Cơ chế: application **chỉ ghi vào cache khi cache miss**.

1. Đọc cache trước (GET key).
2. **Cache hit** → trả luôn, không chạm DB.
3. **Cache miss** → query DB, ghi kết quả vào cache (kèm TTL), trả về.

```javascript
// Node.js + ioredis + RDS (MySQL). Cache-aside pattern.
import Redis from "ioredis";
import mysql from "mysql2/promise";

const redis = new Redis({
  host: "app-cache.xxxxxx.apse1.cache.amazonaws.com",
  port: 6379,
  tls: {},                              // bắt buộc khi transit-encryption-enabled
  password: process.env.REDIS_AUTH_TOKEN,
});
const db = await mysql.createPool({ /* config RDS */ });

const TTL_SECONDS = 300; // 5 phút — chốt chặn cuối cho stale data

async function getProduct(productId) {
  const cacheKey = `product:${productId}`;

  const cached = await redis.get(cacheKey);
  if (cached !== null) return JSON.parse(cached);   // cache hit

  // cache miss → đọc DB rồi populate cache
  const [rows] = await db.query("SELECT * FROM products WHERE id = ?", [productId]);
  if (rows.length === 0) return null;

  // SET kèm EX (TTL) — atomic, tránh key sống mãi
  await redis.set(cacheKey, JSON.stringify(rows[0]), "EX", TTL_SECONDS);
  return rows[0];
}

async function updateProduct(productId, fields) {
  await db.query("UPDATE products SET ? WHERE id = ?", [fields, productId]);
  // Invalidate thay vì update cache — lần đọc sau sẽ lazy-load bản mới
  await redis.del(`product:${productId}`);
}
```

**Ưu điểm:**
- Chỉ data **thực sự được đọc** mới vào cache → tiết kiệm RAM.
- Node cache chết không gây lỗi nghiêm trọng — chỉ tăng latency và tải DB tạm thời (cache miss hàng loạt), data tự được nạp lại.

**Nhược điểm:**
- **Cache miss penalty**: mỗi miss tốn 3 chuyến (đọc cache, đọc DB, ghi cache) → request đầu tiên chậm.
- **Stale data**: nếu DB được update mà cache chưa invalidate, người đọc nhận data cũ cho tới khi TTL hết. Đây chính là vấn đề "consistency cache–DB" mà đề hay xoáy.

### Write-Through

Cơ chế: **mỗi lần write vào DB, đồng thời write (update) vào cache**. Cache luôn có bản mới nhất của data đã từng được ghi.

```javascript
async function updateProductWriteThrough(productId, product) {
  await db.query("UPDATE products SET ? WHERE id = ?", [product, productId]);
  // Ghi thẳng bản mới vào cache — reader tiếp theo hit ngay data mới
  await redis.set(`product:${productId}`, JSON.stringify(product), "EX", 3600);
}
```

**Ưu điểm:**
- Data trong cache **không bao giờ stale** (đối với các write đi qua application path này).
- Read luôn nhanh — không có miss penalty cho data đã ghi.

**Nhược điểm:**
- **Write penalty**: mỗi write tốn 2 chuyến (DB + cache) → tăng write latency.
- **Cache churn**: ghi cả data không ai đọc → tốn RAM ("cache pollution"). Vì vậy thực tế hay kết hợp write-through + TTL.
- Data mới thêm vào DB qua đường khác (batch job, migration, console) **không có trong cache** → vẫn cần lazy loading làm fallback. Hai strategy không loại trừ nhau — **kết hợp cả hai** là pattern phổ biến nhất.

| Tiêu chí | Lazy Loading | Write-Through |
|---|---|---|
| Khi nào data vào cache | Lúc đọc (cache miss) | Lúc ghi DB |
| Stale data | Có thể (đến khi TTL hết / invalidate) | Không (với write qua app) |
| Read latency | Miss đầu tiên chậm | Luôn nhanh (nếu data đã ghi) |
| Write latency | Bình thường | Chậm hơn (2 lần ghi) |
| RAM | Tiết kiệm (chỉ chứa data được đọc) | Tốn (chứa cả data không ai đọc) |
| Node failure | Miss tăng tạm, tự hồi | Mất data cache đến khi được ghi lại |

Còn một biến thể đề thỉnh thoảng nhắc: **write-behind / write-back** (ghi cache trước, ghi DB async sau) — latency write thấp nhất nhưng rủi ro mất data; ElastiCache không có sẵn cơ chế này, phải tự code, và hầu như không bao giờ là đáp án đúng trong DVA-C02.

### Consistency cache–DB: các bẫy thực tế

- **Update DB rồi update cache** (2 write song song) có race condition: hai request update gần nhau có thể ghi cache theo thứ tự ngược với DB → cache giữ bản cũ vĩnh viễn. An toàn hơn: **update DB rồi DELETE cache key** (như code trên) — bản chất là ép lazy load lại.
- **TTL là lưới an toàn bắt buộc**, kể cả khi đã invalidate chủ động: nếu lệnh DEL thất bại (network blip) thì TTL bảo đảm stale data có hạn sử dụng.
- **Cache stampede**: key hot hết TTL → hàng nghìn request miss cùng lúc, cùng đập vào DB. Giải pháp: TTL có jitter ngẫu nhiên (ví dụ 300 ± 30 giây), hoặc lock nhẹ (`SET lock:key NX EX 10`) cho phép 1 request đi nạp data, số còn lại đợi/dùng bản cũ.

> 💡 **Exam Tip:** Đề mô tả "users complain they see outdated data after updates" với hệ thống đang dùng lazy loading → đáp án là thêm **write-through** hoặc **invalidate cache khi write** hoặc **giảm TTL**. Ngược lại đề than "write latency tăng và cache đầy data không dùng" → vấn đề của **write-through**, chuyển sang lazy loading + TTL. Nhớ câu thần chú: lazy loading tối ưu cho **read**, write-through tối ưu cho **freshness** và trả giá bằng **write**.

## 9.5 TTL & Eviction — chuyện gì xảy ra khi cache đầy

**TTL (Time To Live)** là thời gian sống gắn cho từng key: `SET key value EX 300` hoặc `EXPIRE key 300`. Redis xóa key hết hạn theo hai cơ chế: **lazy expiration** (kiểm tra lúc key được truy cập) và **active expiration** (background job lấy mẫu ngẫu nhiên các key có TTL, xóa key hết hạn). Hệ quả: key hết hạn có thể vẫn chiếm RAM một lúc cho tới khi bị quét trúng.

Khi bộ nhớ chạm trần (`maxmemory` — ElastiCache đặt qua parameter group), Redis phải **evict** key theo policy `maxmemory-policy`:

- `volatile-lru` (mặc định trên ElastiCache Redis): evict key **có TTL** ít được dùng gần đây nhất (LRU — Least Recently Used). Bẫy thực tế: nếu **không key nào có TTL** thì không evict được gì → write mới bị lỗi OOM.
- `allkeys-lru`: LRU trên **mọi** key, kể cả không TTL — lựa chọn an toàn cho cache thuần túy.
- `volatile-lfu` / `allkeys-lfu`: theo tần suất dùng (LFU — Least Frequently Used).
- `volatile-ttl`: evict key sắp hết hạn nhất.
- `volatile-random` / `allkeys-random`: ngẫu nhiên.
- `noeviction`: từ chối write khi đầy (trả lỗi) — dùng khi Redis là datastore không được phép tự mất data.

Memcached đơn giản hơn: luôn LRU (trong từng slab class), không có lựa chọn policy phong phú như Redis.

Tín hiệu vận hành cần biết (CloudWatch — chi tiết ở Chương 24): `Evictions` tăng đều nghĩa là cache thiếu RAM — hoặc scale up/thêm shard, hoặc giảm TTL/lượng data cache; `CacheHitRate` thấp nghĩa là cache không hiệu quả (key design sai hoặc TTL quá ngắn); `DatabaseMemoryUsagePercentage`, `CPUUtilization`, `EngineCPUUtilization` (Redis single-thread nên EngineCPU quan trọng hơn CPU tổng trên node nhiều core), `CurrConnections`.

> 💡 **Exam Tip:** "ElastiCache metric nào cho biết cache đang quá nhỏ / cần scale?" → **Evictions**. "Ứng dụng dùng `volatile-lru` nhưng memory đầy và write lỗi dù còn nhiều key" → các key đó **không có TTL**, đổi sang `allkeys-lru` hoặc thêm TTL.
