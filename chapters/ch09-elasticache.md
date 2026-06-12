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

## 9.6 Session Store — pattern stateless hóa web tier

Đây là use case ElastiCache xuất hiện nhiều nhất trong đề, thường gắn với ELB/ASG (Chương 6–7).

Vấn đề: ứng dụng web lưu session (user đang đăng nhập, giỏ hàng) trong **memory của chính instance**. Khi đặt sau load balancer, request tiếp theo của user có thể rơi vào instance khác → mất session. Hai cách xử lý:

1. **Sticky sessions** trên ALB: ELB ghim user vào 1 instance bằng cookie. Hoạt động, nhưng phá vỡ cân bằng tải, và **instance chết / bị ASG scale-in là session mất** — không phải đáp án "best practice".
2. **Externalize session ra ElastiCache**: mọi instance đọc/ghi session vào Redis qua session ID (lấy từ cookie). Web tier trở thành **stateless** — instance nào phục vụ cũng được, scale in/out hay thay instance thoải mái.

Vì sao chọn Redis (chứ không Memcached) cho session production: cần **replication + Multi-AZ failover** để node cache chết không log out toàn bộ user. Memcached chỉ chấp nhận được khi mất session hàng loạt là chuyện chấp nhận được. DynamoDB cũng là lựa chọn session store hợp lệ (durable hơn, latency cao hơn một bậc) — đề phân biệt bằng từ khóa "sub-millisecond" (→ ElastiCache) vs "serverless/durable" (→ DynamoDB).

```javascript
// Express + Redis session store
import session from "express-session";
import { RedisStore } from "connect-redis";
import Redis from "ioredis";
import express from "express";

const redis = new Redis({
  host: process.env.CACHE_HOST,
  port: 6379,
  tls: {},
  password: process.env.REDIS_AUTH_TOKEN,
});

const app = express();
app.use(session({
  store: new RedisStore({ client: redis, prefix: "sess:" }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 60 * 1000 },   // 30 phút — đồng bộ với TTL key trong Redis
}));

app.get("/cart", (req, res) => {
  req.session.views = (req.session.views || 0) + 1;
  res.json({ views: req.session.views });
});
```

Lưu ý kỹ thuật: session TTL trong Redis nên khớp với cookie maxAge; mỗi key session là một hash/string nhỏ vài KB — node `cache.t3.small` đã chứa được hàng trăm nghìn session.

> 💡 **Exam Tip:** "Company muốn web tier stateless để dùng Auto Scaling, session hiện lưu local" → đáp án chuẩn là **ElastiCache (Redis)** hoặc DynamoDB; **sticky session là đáp án nhiễu** vì không chịu được instance termination. Nếu đề thêm "must survive cache node failure" → Redis Multi-AZ, loại Memcached.

## 9.7 Redis Sorted Sets (leaderboard) & Pub/Sub

### Sorted Sets — real-time gaming leaderboard

**Sorted set (ZSET)** là cấu trúc dữ liệu chỉ Redis có: tập hợp member duy nhất, mỗi member gắn một **score**; Redis duy trì thứ tự theo score bằng skip list + hash table → thêm/sửa score là `O(log N)`, lấy top-N hoặc rank của một member là `O(log N)`. Nghĩa là **bảng xếp hạng tự sắp xếp, real-time, atomic** — không cần `ORDER BY` quét bảng SQL mỗi lần hiển thị, không cần job tính lại định kỳ.

Vì Redis single-threaded, hai player cộng điểm cùng lúc không bao giờ race nhau — `ZINCRBY` là atomic. Đây là câu trả lời cho dạng đề "leaderboard must be consistent and ordered across all game servers".

```javascript
// Leaderboard với sorted set
const LB = "leaderboard:season-3";

// Cộng điểm cho player — atomic, không cần lock
await redis.zincrby(LB, 50, "player:1234");

// Top 10 kèm điểm (cao → thấp)
const top10 = await redis.zrevrange(LB, 0, 9, "WITHSCORES");

// Hạng của một player (0-based, theo chiều giảm dần)
const rank = await redis.zrevrank(LB, "player:1234");

// Điểm hiện tại
const score = await redis.zscore(LB, "player:1234");

// Số player trong khoảng điểm 1000–2000
const count = await redis.zcount(LB, 1000, 2000);
```

Tương đương CLI (nối qua redis-cli từ EC2 cùng VPC):

```bash
redis-cli -h app-cache.xxxxxx.apse1.cache.amazonaws.com --tls -a "$AUTH_TOKEN" \
  ZADD leaderboard:season-3 1500 player:1234
redis-cli ... ZREVRANGE leaderboard:season-3 0 9 WITHSCORES
```

### Pub/Sub

Redis có cơ chế **publish/subscribe**: client SUBSCRIBE vào channel, client khác PUBLISH message — mọi subscriber đang kết nối nhận message ngay lập tức. Đặc tính phải nhớ: **fire-and-forget, không persistence** — subscriber offline lúc publish là mất message vĩnh viễn, không có retry, không có acknowledgement. Phù hợp cho: chat/notification real-time tốc độ cao giữa các instance, invalidation broadcast ("xóa cache key X trên mọi node app"). Không phù hợp khi cần delivery guarantee — lúc đó là SQS/SNS (Chương 21–22) hoặc Redis Streams.

```javascript
// Subscriber (chạy trên mọi app instance) — nhận lệnh invalidate cache local
const sub = redis.duplicate();
await sub.subscribe("cache-invalidation");
sub.on("message", (channel, key) => localCache.delete(key));

// Publisher — sau khi update DB
await redis.publish("cache-invalidation", `product:42`);
```

> 💡 **Exam Tip:** "Real-time leaderboard with millions of players, scores update constantly, must show current rank instantly" → **Redis sorted sets**, không phải DynamoDB + GSI hay RDS + ORDER BY. "Broadcast message tới mọi instance ngay lập tức, mất message khi offline chấp nhận được" → Redis **pub/sub**; nếu cần durable → SNS/SQS.

## 9.8 Bảo mật ElastiCache: AUTH, TLS, RBAC, IAM, Security Group

Lớp mạng trước tiên: ElastiCache **chỉ chạy trong VPC**, deploy vào **private subnet** qua cache subnet group. Kiểm soát truy cập bằng **Security Group**: chỉ mở port 6379 (Redis) / 11211 (Memcached) cho SG của application tier — pattern SG-references-SG chuẩn (Chương 4). Không bao giờ có chuyện truy cập ElastiCache từ internet trực tiếp.

Các lớp bảo mật của **Redis**:

1. **Encryption in transit (TLS)**: bật `--transit-encryption-enabled` lúc tạo (với Redis 7+ có thể bật trên cluster đang chạy với chế độ migration). Client phải connect bằng TLS (`tls: {}` trong ioredis, `--tls` với redis-cli).
2. **Encryption at rest**: mã hóa data trên disk (snapshot, swap, sync file) bằng KMS key. Chỉ bật được **lúc tạo** cluster.
3. **Redis AUTH**: token (password) đặt qua `--auth-token`, client gửi lệnh `AUTH <token>` sau khi connect. Yêu cầu: 16–128 ký tự, **bắt buộc phải bật in-transit encryption mới dùng được AUTH** — bẫy hay gặp. Token rotate được bằng `modify-replication-group --auth-token ... --auth-token-update-strategy ROTATE` (hỗ trợ 2 token song song trong lúc rotate).
4. **RBAC (Redis 6+)**: thay vì 1 token chung, tạo **users** và **user groups** với access string giới hạn lệnh và key pattern, ví dụ `on ~app:* +@read` (chỉ đọc các key prefix `app:`). Gắn user group vào replication group. Đây là cách chuẩn hiện nay thay cho AUTH đơn lẻ.
5. **IAM authentication (Redis 7+)**: user RBAC có thể auth bằng **IAM credentials** — client tạo token ký SigV4 (tương tự IAM database authentication của RDS, Chương 8), hết cảnh hard-code password. Token có hiệu lực ngắn (15 phút cho việc connect).

```bash
# RBAC: tạo user chỉ-đọc trên prefix app:* rồi gắn vào user group
aws elasticache create-user \
  --user-id app-readonly \
  --user-name app-readonly \
  --engine redis \
  --access-string "on ~app:* -@all +@read" \
  --authentication-mode Type=iam        # auth bằng IAM thay vì password

aws elasticache create-user-group \
  --user-group-id app-users --engine redis \
  --user-ids default app-readonly

aws elasticache modify-replication-group \
  --replication-group-id app-cache \
  --user-group-ids-to-add app-users
```

Lưu ý phân quyền: IAM policy của ElastiCache (action `elasticache:*`) chỉ kiểm soát **control plane** (tạo/xóa/sửa cluster qua API AWS). Truy cập **data plane** (đọc/ghi key) đi qua SG + AUTH/RBAC/TLS — trừ trường hợp IAM authentication ở trên. Memcached khiêm tốn hơn: có TLS và SASL authentication từ version 1.6.12, không có RBAC.

> 💡 **Exam Tip:** "Developer cần thêm authentication cho Redis cluster" → **Redis AUTH / RBAC**, và nhớ điều kiện đi kèm: **in-transit encryption phải được bật**. "Encrypt data at rest" → chỉ cấu hình được **khi tạo cluster** (kèm KMS). Câu nhiễu thường gặp là "attach IAM role to ElastiCache" — không tồn tại khái niệm gắn role cho data access kiểu đó (trừ IAM auth cho RBAC user trên Redis 7+).

## 9.9 Chọn giải pháp cache đúng trong đề: ElastiCache vs các lựa chọn khác

Tổng kết tư duy chọn service — dạng câu hỏi "A developer needs to reduce latency / offload reads, which solution?":

| Tình huống / từ khóa | Chọn | Vì sao |
|---|---|---|
| Cache cho **DynamoDB**, "no application code changes", microsecond | **DAX** (Chương 33) | API-compatible, drop-in trước DynamoDB |
| Cache kết quả query RDS/Aurora, dữ liệu tổng hợp, object tùy ý | **ElastiCache** | Cache đa dụng, nhưng phải sửa code app |
| Session store, sub-millisecond, HA | **ElastiCache Redis** | Replication + Multi-AZ |
| Cache đơn giản nhất, multi-threaded, chấp nhận mất data | **Memcached** | Không replication/persistence |
| Leaderboard, rank real-time | **Redis sorted sets** | ZADD/ZRANK atomic O(log N) |
| Cache response API ở edge cho client toàn cầu | **CloudFront** (Chương 15) / API Gateway cache (Chương 35) | Cache ở tầng HTTP, gần client hơn |
| Scale read SQL queries phức tạp, data luôn mới | **Read Replica** (Chương 8) | Vẫn là SQL engine, không stale theo TTL |

Vài war story để chốt chương:

- **Hot key**: một key duy nhất (config chung, sản phẩm viral) chiếm 80% traffic — cluster mode enabled không cứu được vì 1 key chỉ nằm trên 1 shard. Giải pháp thực tế: thêm **local in-memory cache** (vài giây) trong app trước Redis, hoặc nhân bản key ra nhiều bản (`key:1..N`) đọc ngẫu nhiên.
- **Connection storm**: Lambda scale ra hàng nghìn execution environment, mỗi cái mở connection Redis riêng → `CurrConnections` vọt, engine nghẽn. Khởi tạo client **ngoài handler** để tái dùng connection theo execution environment (Chương 28), và cân nhắc giới hạn concurrency.
- **Serialize cẩn thận**: lưu JSON.stringify của object lớn (vài trăm KB) vào 1 key khiến mỗi GET kéo cả khối qua network và block engine single-thread. Tách thành hash (`HSET product:42 name ... price ...`) và `HGET` đúng field cần.

> 💡 **Exam Tip:** Khi đề có cả ElastiCache và DAX trong đáp án, nhìn nguồn dữ liệu: **DynamoDB → DAX**, **RDS/Aurora hoặc nguồn hỗn hợp → ElastiCache**. Khi đề nhấn "minimal/no code changes" với DynamoDB → DAX thắng tuyệt đối, vì ElastiCache luôn đòi viết logic cache trong application.

---

## Hands-on Lab: Dựng Redis cache cho ứng dụng Node.js — cache-aside & leaderboard

**Mục tiêu lab:** Tạo một Redis cache cluster bằng AWS CLI, kết nối từ EC2 trong cùng VPC, cài đặt pattern **cache-aside (lazy loading)** bằng Node.js (ioredis), làm leaderboard bằng **sorted set**, và quan sát TTL/eviction hoạt động thực tế.

**Chuẩn bị:**
- AWS CLI v2 đã cấu hình (chương 3), quyền `elasticache:*`, `ec2:*` ở mức lab.
- Một EC2 instance Amazon Linux 2023 (t3.micro, free tier) đang chạy trong VPC default — ElastiCache **không có public endpoint**, bắt buộc truy cập từ trong VPC (đây cũng là điểm thi hay hỏi).
- Node.js 20 trên EC2 (`sudo dnf install -y nodejs`).
- Chi phí: node `cache.t3.micro` khoảng $0.017/giờ — làm xong nhớ dọn dẹp.

### Bước 1: Tạo Security Group cho Redis

Redis nghe port **6379** (Memcached là **11211**). Best practice: chỉ mở 6379 cho Security Group của EC2 app, không mở theo CIDR rộng.

```bash
# Lấy VPC default và SG của EC2 app (giả sử tên sg là app-sg)
VPC_ID=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text)

APP_SG=$(aws ec2 describe-security-groups \
  --filters Name=group-name,Values=app-sg \
  --query 'SecurityGroups[0].GroupId' --output text)

# Tạo SG riêng cho Redis
REDIS_SG=$(aws ec2 create-security-group \
  --group-name redis-lab-sg \
  --description "ElastiCache Redis lab" \
  --vpc-id $VPC_ID --query GroupId --output text)

# Chỉ cho phép app-sg gọi vào port 6379 (SG reference, không dùng IP)
aws ec2 authorize-security-group-ingress \
  --group-id $REDIS_SG --protocol tcp --port 6379 \
  --source-group $APP_SG
```

Output mong đợi: JSON có `"Return": true` và một `SecurityGroupRules` entry với `ReferencedGroupId` trỏ về `$APP_SG`.

### Bước 2: Tạo cache subnet group

ElastiCache đặt node trong subnet bạn chỉ định qua **cache subnet group** (tương tự DB subnet group của RDS — chi tiết ở Chương 8).

```bash
SUBNETS=$(aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC_ID \
  --query 'Subnets[].SubnetId' --output text)

aws elasticache create-cache-subnet-group \
  --cache-subnet-group-name redis-lab-subnets \
  --cache-subnet-group-description "Lab subnets" \
  --subnet-ids $SUBNETS
```

### Bước 3: Tạo Redis cluster (cluster mode disabled, 1 node)

```bash
aws elasticache create-cache-cluster \
  --cache-cluster-id redis-lab \
  --engine redis \
  --engine-version 7.1 \
  --cache-node-type cache.t3.micro \
  --num-cache-nodes 1 \
  --cache-subnet-group-name redis-lab-subnets \
  --security-group-ids $REDIS_SG
```

Output: JSON với `"CacheClusterStatus": "creating"`. Chờ available (3–5 phút):

```bash
aws elasticache wait cache-cluster-available --cache-cluster-id redis-lab

aws elasticache describe-cache-clusters \
  --cache-cluster-id redis-lab --show-cache-node-info \
  --query 'CacheClusters[0].CacheNodes[0].Endpoint'
```

Output mong đợi:

```json
{
    "Address": "redis-lab.xxxxxx.0001.apse1.cache.amazonaws.com",
    "Port": 6379
}
```

Lưu ý: lab này tạo cluster **không TLS, không AUTH** cho đơn giản. Trong production bạn dùng `create-replication-group` với `--transit-encryption-enabled --auth-token <chuỗi ≥16 ký tự>` — nhớ rằng **AUTH token chỉ bật được khi transit encryption bật**, và phải bật **ngay lúc tạo** (với Redis cũ không bật in-transit encryption sau khi tạo bằng cách đơn giản được; bản mới hỗ trợ chuyển qua trạng thái `preferred` rồi `required`).

### Bước 4: Kiểm tra kết nối từ EC2

SSH vào EC2 (hoặc dùng EC2 Instance Connect), cài redis-cli:

```bash
sudo dnf install -y redis6
REDIS_HOST=redis-lab.xxxxxx.0001.apse1.cache.amazonaws.com

redis6-cli -h $REDIS_HOST ping
# Output mong đợi: PONG

redis6-cli -h $REDIS_HOST set greeting "hello dva-c02" EX 60
# OK
redis6-cli -h $REDIS_HOST ttl greeting
# (integer) 58   <- TTL đang đếm ngược, hết 60s key tự biến mất
```

Nếu lệnh `ping` treo rồi timeout: 99% là Security Group — kiểm tra EC2 có thuộc `app-sg` không, và rule 6379 có source đúng SG không. Đây chính là kịch bản troubleshooting kinh điển trong đề thi.

### Bước 5: Cache-aside (lazy loading) bằng Node.js

```bash
mkdir ~/cache-lab && cd ~/cache-lab && npm init -y && npm install ioredis
```

Tạo `cache-aside.js`:

```javascript
import Redis from "ioredis";
const redis = new Redis({ host: process.env.REDIS_HOST, port: 6379 });

// Giả lập query DB chậm 200ms (thực tế là RDS/DynamoDB)
async function queryDatabase(userId) {
  await new Promise((r) => setTimeout(r, 200));
  return { userId, name: "Truong", plan: "pro" };
}

async function getUser(userId) {
  const key = `user:${userId}`;
  const t0 = Date.now();

  // 1. Đọc cache trước
  const cached = await redis.get(key);
  if (cached) {
    console.log(`CACHE HIT  (${Date.now() - t0}ms)`);
    return JSON.parse(cached);
  }

  // 2. Cache miss -> đọc DB
  const user = await queryDatabase(userId);

  // 3. Ghi ngược vào cache, LUÔN kèm TTL để tránh stale vĩnh viễn
  await redis.set(key, JSON.stringify(user), "EX", 300);
  console.log(`CACHE MISS (${Date.now() - t0}ms)`);
  return user;
}

await getUser(42); // lần 1: miss
await getUser(42); // lần 2: hit
redis.disconnect();
```

```bash
REDIS_HOST=$REDIS_HOST node cache-aside.js
```

Output mong đợi:

```text
CACHE MISS (203ms)
CACHE HIT  (1ms)
```

Chênh lệch 200ms vs 1ms chính là lý do tồn tại của ElastiCache. Hãy thử thêm: sửa "DB" trả về `plan: "free"` rồi chạy lại — bạn vẫn nhận `pro` từ cache trong 300 giây. Đó là **stale data**, cái giá của lazy loading; muốn cache luôn mới thì kết hợp **write-through** (update cache ngay khi ghi DB) hoặc chủ động `DEL user:42` khi update.

### Bước 6: Leaderboard với sorted set

```bash
redis6-cli -h $REDIS_HOST zadd leaderboard 1500 "an" 2300 "binh" 1800 "chi"
redis6-cli -h $REDIS_HOST zincrby leaderboard 600 "an"
redis6-cli -h $REDIS_HOST zrevrange leaderboard 0 2 WITHSCORES
```

Output mong đợi:

```text
1) "binh"   2) "2300"
3) "an"     4) "2100"
5) "chi"    6) "1800"
```

`ZADD`/`ZINCRBY` là O(log N), ranking realtime không cần `ORDER BY` quét bảng — đây là đáp án mẫu cho câu hỏi "gaming leaderboard" trong đề.

### Bước 7: Quan sát eviction policy

```bash
redis6-cli -h $REDIS_HOST config get maxmemory-policy
# 1) "maxmemory-policy"  2) "volatile-lru"
```

Mặc định ElastiCache Redis dùng `volatile-lru`: khi đầy memory chỉ evict các key **có TTL**. Nếu app của bạn set key không TTL và cache đầy, Redis trả lỗi ghi `OOM command not allowed` — đổi sang `allkeys-lru` qua **parameter group** (không sửa runtime bằng `CONFIG SET` được trên ElastiCache, lệnh này bị chặn).

### Dọn dẹp tài nguyên

```bash
# 1. Xoá cache cluster (mất vài phút)
aws elasticache delete-cache-cluster --cache-cluster-id redis-lab
aws elasticache wait cache-cluster-deleted --cache-cluster-id redis-lab

# 2. Xoá subnet group (chỉ xoá được sau khi cluster đã xoá xong)
aws elasticache delete-cache-subnet-group \
  --cache-subnet-group-name redis-lab-subnets

# 3. Xoá Security Group
aws ec2 delete-security-group --group-id $REDIS_SG

# 4. Stop/terminate EC2 nếu tạo riêng cho lab
```

Kiểm tra lại: `aws elasticache describe-cache-clusters` phải trả về danh sách rỗng (hoặc không còn `redis-lab`).

## 💡 Exam Tips chương 9

- **Redis vs Memcached** — chọn Redis khi cần: replication/Multi-AZ failover, persistence (backup/restore), sorted sets, pub/sub, transactions, AUTH/TLS. Chọn Memcached khi cần: cache thuần KV đơn giản nhất, **multi-threaded** tận dụng nhiều core, scale ngang bằng cách thêm node (không replication, **không backup**).
- **Lazy loading (cache-aside):** chỉ cache dữ liệu được đọc → tiết kiệm memory, nhưng cache miss tốn 3 bước (đọc cache, đọc DB, ghi cache) và dữ liệu có thể **stale**. Từ khoá đề thi: "only cache data that is requested".
- **Write-through:** ghi cache đồng thời khi ghi DB → dữ liệu luôn mới, đọc nhanh, nhưng **write penalty** (mỗi write tốn 2 thao tác) và cache chứa cả dữ liệu không ai đọc (**cache churn**). Thực tế thường kết hợp cả hai + TTL.
- **TTL là lưới an toàn cho mọi strategy** — đề hỏi "đảm bảo dữ liệu cache không cũ quá X phút với ít thay đổi code nhất" → đặt TTL, không phải đổi sang write-through.
- **AUTH token (Redis AUTH) yêu cầu in-transit encryption (TLS) được bật**, và cấu hình khi tạo replication group. Câu hỏi "require a password trước khi cho execute commands" → Redis AUTH, không phải IAM, không phải Security Group.
- ElastiCache nằm **trong VPC, không có public endpoint** — app on-premises hoặc Lambda ngoài VPC không gọi trực tiếp được. Lỗi connect timeout → nghĩ ngay Security Group/subnet trước.
- **Cluster mode disabled:** 1 shard, 1 primary + tối đa 5 replicas, toàn bộ data trên mỗi node — scale **đọc**. **Cluster mode enabled:** tối đa 500 shards, data **partition** theo slot — scale **ghi** và vượt giới hạn memory 1 node. Đề nói "dataset lớn hơn memory của node lớn nhất" hoặc "scale writes" → cluster mode enabled.
- **Session store:** câu hỏi "user bị logout khi instance bị terminate / ASG scale-in" hoặc "stateless tier" → lưu session vào ElastiCache (Redis), KHÔNG dùng sticky sessions (sticky sessions làm tải lệch và mất session khi node chết).
- **Leaderboard realtime** → Redis **sorted set** (ZADD/ZRANGE). **Pub/sub** Redis cho messaging fire-and-forget nội bộ (không bền — subscriber offline là mất message; cần bền thì SQS/SNS, chương 21–22).
- ElastiCache phù hợp dữ liệu **đọc nhiều, ghi ít, chịu được stale trong TTL**. Dữ liệu thay đổi liên tục hoặc yêu cầu strong consistency → đọc thẳng DB. Cache cho DynamoDB mà muốn "không đổi code, microsecond latency" → DAX (chi tiết ở Chương 33).
- Eviction mặc định `volatile-lru` chỉ evict key có TTL; thấy lỗi OOM khi ghi dù tưởng LRU sẽ dọn → đổi `maxmemory-policy` sang `allkeys-lru` qua **parameter group**.
- Redis hỗ trợ **backup/snapshot và Multi-AZ auto-failover**; Memcached thì không — câu "cache must survive node failure / cần khả năng restore" loại Memcached ngay.

## Quiz chương 9 (10 câu)

**Câu 1.** Một ứng dụng đọc product catalog từ RDS rất nặng. Team muốn thêm cache nhưng memory cache có hạn, chỉ muốn cache những sản phẩm thực sự được người dùng xem. Strategy nào phù hợp?
- A. Write-through
- B. Lazy loading (cache-aside)
- C. Write-behind
- D. Bật Multi-AZ cho RDS

**Câu 2.** A developer needs to ensure cached data is always consistent with the database ngay sau mỗi lần update, chấp nhận tăng độ trễ khi ghi. Chọn gì?
- A. Lazy loading với TTL 1 giờ
- B. Write-through: update cache trong cùng luồng với update DB
- C. Tăng số read replica của RDS
- D. Đặt TTL = 0 cho mọi key

**Câu 3.** Ứng dụng game cần leaderboard realtime, hiển thị top 10 người chơi, cập nhật điểm liên tục. Giải pháp ít công sức nhất?
- A. DynamoDB Scan + sort phía client
- B. RDS với `ORDER BY score DESC` mỗi request
- C. ElastiCache Redis sorted set với ZADD/ZREVRANGE
- D. ElastiCache Memcached với key per player

**Câu 4.** Yêu cầu compliance: cache layer phải mã hoá dữ liệu khi truyền và yêu cầu client xác thực bằng token trước khi chạy lệnh. Cấu hình nào đáp ứng?
- A. Memcached + Security Group chỉ mở port 11211
- B. Redis với in-transit encryption + Redis AUTH token
- C. Redis với at-rest encryption + IAM policy
- D. Redis trong private subnet là đủ

**Câu 5.** Web app chạy trên ASG sau ALB. User phàn nàn bị logout ngẫu nhiên mỗi khi hệ thống scale-in. Cách xử lý đúng theo best practice?
- A. Bật sticky sessions trên ALB
- B. Tăng cooldown của ASG để giảm tần suất scale-in
- C. Lưu session state vào ElastiCache Redis, app tier trở thành stateless
- D. Lưu session vào EBS volume của mỗi instance

**Câu 6.** Dataset cache đã vượt memory của node lớn nhất và lưu lượng **ghi** vào Redis đang quá tải một primary node. Giải pháp?
- A. Thêm read replica vào replication group hiện tại
- B. Chuyển sang Redis cluster mode enabled để shard dữ liệu trên nhiều node
- C. Đổi sang node type nhiều memory hơn nữa
- D. Chuyển sang Memcached vì nó multi-threaded

**Câu 7.** Một developer triển khai cache-aside, sau đó user báo thấy giá sản phẩm cũ tới vài giờ sau khi admin đã cập nhật giá trong DB. Cách khắc phục ÍT thay đổi kiến trúc nhất?
- A. Chuyển toàn bộ sang write-through và xoá hết code lazy loading
- B. Đặt TTL ngắn hợp lý cho key, và/hoặc invalidate (DEL) key khi update DB
- C. Tắt cache, đọc thẳng DB
- D. Bật Multi-AZ cho ElastiCache

**Câu 8.** Team chỉ cần cache key-value đơn giản nhất có thể, muốn tận dụng instance nhiều vCPU bằng xử lý multi-threaded, không cần replication hay backup. Engine nào?
- A. Redis cluster mode enabled
- B. Redis cluster mode disabled
- C. Memcached
- D. DynamoDB Accelerator (DAX)

**Câu 9.** EC2 app không kết nối được tới Redis endpoint, lệnh `redis-cli ping` bị timeout. Cluster status là `available`. Nguyên nhân khả dĩ nhất?
- A. Chưa bật Redis AUTH nên Redis từ chối kết nối
- B. Security Group của cluster không cho phép inbound 6379 từ Security Group của EC2
- C. ElastiCache cần public IP mà chưa gán
- D. Phải dùng IAM role mới connect được Redis

**Câu 10.** A developer needs a caching solution cho bảng DynamoDB read-heavy, yêu cầu **độ trễ microsecond** và **không muốn sửa logic caching trong code** (API tương thích DynamoDB). Đồng thời một service khác cần cache kết quả aggregation từ Aurora. Chọn cặp nào?
- A. DAX cho DynamoDB; ElastiCache Redis cho Aurora
- B. ElastiCache Redis cho cả hai
- C. DAX cho cả hai
- D. ElastiCache Memcached cho DynamoDB; DAX cho Aurora

### Đáp án & giải thích

**Câu 1 — Đáp án B.** Lazy loading chỉ ghi vào cache khi có cache miss, nghĩa là chỉ dữ liệu **được đọc** mới chiếm memory — đúng yêu cầu "chỉ cache sản phẩm được xem". A sai: write-through ghi mọi bản ghi vào cache kể cả thứ không ai đọc, lãng phí memory đang có hạn. C sai: write-behind (ghi cache trước, ghi DB sau bất đồng bộ) không phải pattern ElastiCache hỗ trợ sẵn và không giải quyết yêu cầu. D sai: Multi-AZ là high availability cho RDS, không giảm tải đọc.

**Câu 2 — Đáp án B.** Write-through cập nhật cache cùng lúc với DB nên cache không bao giờ stale (trong giới hạn của pattern), đổi lại mỗi write tốn thêm một thao tác — đề bài đã chấp nhận. A sai: TTL 1 giờ nghĩa là chấp nhận stale tới 1 giờ. C sai: read replica giải quyết throughput đọc của DB, không liên quan consistency của cache. D sai: TTL = 0 trong Redis nghĩa là key hết hạn ngay/không cache được gì — vô hiệu hoá cache chứ không phải giải pháp.

**Câu 3 — Đáp án C.** Sorted set của Redis được thiết kế đúng cho use case này: `ZINCRBY` cập nhật điểm O(log N), `ZREVRANGE 0 9` lấy top 10 tức thì — đây là ví dụ chữ ký của ElastiCache Redis trong đề DVA. A sai: Scan DynamoDB đắt, chậm, không realtime. B sai: ORDER BY mỗi request đè tải lên DB, chính là vấn đề cần cache. D sai: Memcached không có cấu trúc dữ liệu sorted set, tự cài ranking trên KV thuần rất phức tạp.

**Câu 4 — Đáp án B.** "Mã hoá in transit" → TLS; "xác thực bằng token trước khi chạy lệnh" → Redis AUTH (và AUTH yêu cầu in-transit encryption bật). A sai: Memcached truyền thống không có AUTH token kiểu này và SG không phải là "xác thực". C sai: at-rest encryption không mã hoá đường truyền; IAM không chặn được lệnh Redis ở tầng protocol cho yêu cầu này. D sai: private subnet là network isolation, không phải encryption cũng không phải authentication.

**Câu 5 — Đáp án C.** Đưa session ra external store (ElastiCache) làm app tier stateless — instance nào chết, user vẫn còn session. A sai: sticky sessions giữ user dính một instance; khi instance đó bị scale-in thì session vẫn mất — chỉ giảm triệu chứng, đồng thời gây lệch tải. B sai: trì hoãn scale-in không sửa gốc rễ và phá tính elastic. D sai: EBS gắn riêng từng instance, instance terminate là session đi theo.

**Câu 6 — Đáp án B.** Hai tín hiệu: dataset vượt memory một node + nghẽn **write** → cần **sharding**, tức cluster mode enabled (tối đa 500 shards, mỗi shard có primary riêng nhận write). A sai: replica chỉ scale đọc, mọi write vẫn dồn về một primary. C sai: scale dọc có trần (đề nói đã vượt node lớn nhất). D sai: Memcached scale ngang được nhưng mất replication/persistence và việc migrate đổi engine không phải câu trả lời cho bài toán Redis sharding.

**Câu 7 — Đáp án B.** Stale data là hệ quả tự nhiên của lazy loading; fix chuẩn và rẻ nhất là TTL hợp lý + invalidate key khi nguồn thay đổi — vài dòng code. A sai về "ít thay đổi nhất": chuyển hẳn sang write-through là refactor lớn và phải sửa mọi đường ghi DB. C sai: bỏ cache làm mất luôn lợi ích hiệu năng. D sai: Multi-AZ là failover, hoàn toàn không liên quan độ tươi của dữ liệu.

**Câu 8 — Đáp án C.** "Đơn giản nhất + multi-threaded + không cần replication/backup" là mô tả nguyên văn của Memcached. A và B sai: Redis (mọi mode) chủ yếu single-threaded cho command execution và mang theo các tính năng (replication, persistence) mà đề nói không cần. D sai: DAX là cache chuyên cho DynamoDB, không phải general-purpose KV cache.

**Câu 9 — Đáp án B.** Timeout (không phải connection refused / auth error) trong VPC gần như luôn là Security Group hoặc NACL chặn — kiểm tra rule inbound TCP 6379 với source là SG của EC2. A sai: thiếu AUTH cho lỗi `NOAUTH Authentication required` ngay sau khi kết nối, không phải timeout. C sai: ElastiCache không bao giờ có public IP — truy cập luôn từ trong VPC. D sai: kết nối Redis ở tầng TCP/Redis protocol, không qua IAM (trừ tính năng IAM authentication của Redis 7 — nhưng đó vẫn không gây timeout).

**Câu 10 — Đáp án A.** DAX là cache **chuyên dụng cho DynamoDB**: API-compatible (đổi endpoint là xong, không sửa logic), latency microseconds (chi tiết ở Chương 33). Aurora không dùng DAX được → cache tầng ứng dụng bằng ElastiCache Redis. B sai: Redis cho DynamoDB buộc bạn tự viết logic cache-aside — vi phạm "không sửa code". C sai: DAX không cache được cho Aurora. D sai: Memcached cho DynamoDB vẫn phải tự code caching; DAX không dùng cho Aurora.

## Tóm tắt chương

- ElastiCache là managed in-memory cache (Redis & Memcached), latency sub-millisecond, dùng để giảm tải đọc cho RDS/Aurora/DynamoDB và làm session store/leaderboard/pub-sub.
- Redis: replication + Multi-AZ failover, persistence/backup-restore, cấu trúc dữ liệu giàu (sorted set, hash, list), pub/sub, AUTH + TLS. Memcached: multi-threaded, KV thuần, scale ngang đơn giản, **không** replication, **không** backup.
- **Lazy loading (cache-aside):** chỉ cache dữ liệu được đọc; nhược điểm là miss penalty 3 bước và dữ liệu stale. **Write-through:** cache luôn mới nhưng tốn write penalty và memory cho dữ liệu không ai đọc. Production thường kết hợp cả hai.
- TTL là cơ chế chống stale rẻ nhất — luôn set TTL; muốn dữ liệu mới ngay thì invalidate (DEL) key khi ghi DB.
- Eviction mặc định `volatile-lru` chỉ evict key có TTL; key không TTL + cache đầy → lỗi OOM khi ghi; đổi policy qua parameter group (không dùng được `CONFIG SET` trên ElastiCache).
- Cluster mode disabled = 1 shard (primary + ≤5 replicas, scale đọc); cluster mode enabled = sharding tới 500 shards (scale ghi + vượt giới hạn memory một node).
- Session store trên Redis biến app tier thành stateless — đáp án chuẩn thay cho sticky sessions trong các câu hỏi ASG/ALB.
- Sorted set (ZADD/ZINCRBY/ZREVRANGE) = leaderboard realtime; Redis pub/sub là messaging không bền (subscriber offline mất message).
- Security: ElastiCache chỉ truy cập trong VPC (không public endpoint); chặn ở Security Group theo SG reference; Redis AUTH yêu cầu in-transit encryption (TLS); có cả at-rest encryption.
- Connect timeout tới endpoint → kiểm tra Security Group/subnet trước tiên; lỗi `NOAUTH` → thiếu AUTH token, là chuyện khác.
- Cache phù hợp dữ liệu đọc nhiều, chịu stale trong TTL; dữ liệu cần strong consistency thì đọc thẳng DB; cache riêng cho DynamoDB không-sửa-code → DAX (Chương 33).
- Port nhớ cho thi: Redis **6379**, Memcached **11211**.
