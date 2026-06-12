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
