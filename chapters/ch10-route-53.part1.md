# Chương 10: Route 53

> **Trọng tâm DVA-C02:** Route 53 xuất hiện trong đề chủ yếu ở dạng câu hỏi chọn routing policy đúng cho tình huống (failover giữa hai region, chia traffic theo tỷ lệ để canary test, định tuyến theo vị trí người dùng), phân biệt CNAME vs Alias record, và cách health check hoạt động — đặc biệt là health check cho resource nằm trong private VPC. Đây là chương "dễ ăn điểm" nếu bạn nắm chắc bảng routing policies và vài con số then chốt.

## Mục tiêu chương

- Hiểu cơ chế phân giải DNS từ browser đến authoritative name server, vai trò của TTL và caching.
- Phân biệt public hosted zone và private hosted zone, biết khi nào dùng loại nào.
- Nắm vững các record types và trả lời được câu hỏi kinh điển: CNAME vs Alias khác nhau thế nào, khi nào bắt buộc dùng Alias.
- Chọn đúng routing policy (simple, weighted, latency, failover, geolocation, geoproximity, IP-based, multi-value) cho từng tình huống trong đề.
- Cấu hình health checks: endpoint, calculated, và CloudWatch alarm — hiểu giới hạn của health checker với private resource.
- Biết quy trình đăng ký domain và migrate DNS từ provider khác sang Route 53 mà không gây downtime.

## 10.1 DNS căn bản — cơ chế phân giải tên miền

Trước khi đụng vào Route 53, cần hiểu DNS hoạt động thế nào, vì nhiều câu hỏi trong đề thực chất là kiểm tra hiểu biết DNS chứ không phải Route 53.

DNS (Domain Name System) là hệ thống phân tán dịch tên miền (`api.example.com`) thành địa chỉ IP (`54.23.11.9`). Cấu trúc tên miền là một cây phân cấp đọc từ phải sang trái:

- **Root** (`.`) — đỉnh của cây, được quản lý bởi 13 cụm root server toàn cầu.
- **TLD (Top Level Domain)** — `.com`, `.org`, `.vn`, `.io`... do các TLD registry quản lý (ví dụ Verisign quản lý `.com`).
- **SLD (Second Level Domain)** — `example.com`, phần bạn mua từ registrar.
- **Subdomain** — `api.example.com`, `www.example.com` — bạn tự tạo trong DNS của mình.
- **FQDN (Fully Qualified Domain Name)** — tên đầy đủ kết thúc bằng dấu chấm: `api.example.com.`

Luồng phân giải khi user gõ `api.example.com` vào browser:

1. Browser kiểm tra cache cục bộ của OS. Nếu có và TTL chưa hết → dùng luôn.
2. Nếu không có, query được gửi đến **recursive resolver** (DNS resolver của ISP, hoặc 8.8.8.8 của Google, hoặc Amazon-provided DNS trong VPC).
3. Resolver hỏi **root server**: "ai quản lý `.com`?" → root trả về địa chỉ TLD name server của `.com`.
4. Resolver hỏi TLD server: "ai quản lý `example.com`?" → TLD trả về **NS records** trỏ tới authoritative name server — nếu domain dùng Route 53, đây chính là 4 name server của Route 53 (dạng `ns-123.awsdns-45.com`).
5. Resolver hỏi authoritative name server của Route 53: "IP của `api.example.com` là gì?" → Route 53 trả về record (ví dụ A record `54.23.11.9`) kèm **TTL**.
6. Resolver cache kết quả trong TTL giây, trả về cho browser.

Route 53 đóng vai trò **authoritative DNS** — nơi giữ "sự thật" về các record của domain. Route 53 cũng đồng thời là **domain registrar** (mục 10.8), nhưng hai vai trò này độc lập: bạn có thể mua domain ở GoDaddy mà dùng Route 53 làm DNS, và ngược lại.

**TTL (Time To Live)** là số giây resolver được phép cache câu trả lời. TTL là con dao hai lưỡi:

- TTL cao (ví dụ 86400 = 24h): ít query đến Route 53 → rẻ hơn (Route 53 tính tiền theo số query với non-alias record), nhưng khi bạn đổi IP, client có thể vẫn dùng IP cũ tới 24h.
- TTL thấp (ví dụ 60s): record cập nhật lan truyền nhanh, nhưng tốn query và tăng độ trễ phân giải.

Pattern thực tế: trước khi migrate hoặc đổi hạ tầng, **hạ TTL xuống thấp (60–300s) trước ít nhất bằng TTL cũ**, đợi cache cũ hết hạn, thực hiện thay đổi, rồi nâng TTL trở lại. Đề thi rất hay hỏi tình huống "đổi record rồi mà user vẫn vào server cũ" — đáp án gần như luôn liên quan đến TTL caching.

> 💡 **Exam Tip:** Route 53 không phải là DNS resolver cho internet — nó là authoritative DNS. Trong VPC, resolver mặc định là Amazon-provided DNS (địa chỉ VPC CIDR + 2, ví dụ `10.0.0.2` với CIDR `10.0.0.0/16`). Route 53 cam kết SLA 100% availability — dịch vụ AWS duy nhất có SLA này.

## 10.2 Hosted Zones — public và private

**Hosted zone** là container chứa các record của một domain (và subdomain của nó). Mỗi hosted zone tốn **$0.50/tháng** (giảm dần khi nhiều zone). Khi tạo hosted zone, Route 53 tự sinh hai record không được xoá:

- **NS record**: 4 name server mà bạn phải khai báo với registrar để thế giới biết Route 53 là authoritative DNS của domain.
- **SOA (Start of Authority) record**: metadata về zone (serial, refresh...).

Có hai loại hosted zone:

**Public hosted zone** — trả lời query từ internet công cộng. Dùng cho website, API public: `api.mycompany.com` → ALB, `www.mycompany.com` → CloudFront (chi tiết CloudFront ở Chương 15).

**Private hosted zone** — chỉ trả lời query từ bên trong các VPC được gắn (associate) với zone. Dùng để đặt tên nội bộ: `db.internal.company` → IP của RDS instance, `cache.internal.company` → ElastiCache endpoint. Bên ngoài VPC không phân giải được — đây là cách che giấu kiến trúc nội bộ.

Điều kiện bắt buộc để private hosted zone hoạt động: VPC phải bật cả hai thuộc tính `enableDnsHostnames` và `enableDnsSupport`. Quên một trong hai là query nội bộ trả về `NXDOMAIN` — bẫy troubleshooting kinh điển.

Tạo private hosted zone bằng CLI:

```bash
# Tạo private hosted zone gắn với VPC
aws route53 create-hosted-zone \
  --name internal.company \
  --caller-reference "internal-zone-$(date +%s)" \
  --hosted-zone-config Comment="Private zone cho microservices",PrivateZone=true \
  --vpc VPCRegion=ap-southeast-1,VPCId=vpc-0abc123def456

# Gắn thêm VPC thứ hai vào cùng zone (kể cả VPC khác region)
aws route53 associate-vpc-with-hosted-zone \
  --hosted-zone-id Z0123456789ABCDEF \
  --vpc VPCRegion=us-east-1,VPCId=vpc-0fff999888777
```

Một private hosted zone có thể gắn với nhiều VPC, kể cả VPC ở account khác (cần thêm bước authorize cross-account). Đây là cách phổ biến để các microservice ở nhiều VPC dùng chung không gian tên nội bộ.

Về billing: ngoài phí zone, Route 53 tính phí theo số query — **trừ query đến alias record trỏ tới AWS resource thì miễn phí** (chi tiết ở 10.4, và là một lý do chọn alias thay vì CNAME).

> 💡 **Exam Tip:** Câu hỏi "ứng dụng trong VPC cần phân giải tên DNS nội bộ, không expose ra internet" → đáp án là **private hosted zone** + bật `enableDnsHostnames` và `enableDnsSupport` trên VPC.

## 10.3 Record types

Mỗi record trong hosted zone gồm: tên (name), loại (type), giá trị (value), TTL và routing policy. Các loại record cần nắm cho DVA-C02:

| Record type | Trỏ tới | Ghi chú thi |
|---|---|---|
| **A** | IPv4 address | Loại phổ biến nhất: `api.example.com → 54.23.11.9` |
| **AAAA** | IPv6 address | Tương tự A nhưng cho IPv6 |
| **CNAME** | Một hostname khác | KHÔNG được dùng ở zone apex (`example.com`) |
| **NS** | Name servers của zone | Dùng để delegate subdomain hoặc khai với registrar |
| **Alias** | AWS resource | Không phải record type chuẩn DNS — là extension của Route 53, "đội lốt" A/AAAA |
| MX | Mail server | Nhận diện: liên quan email |
| TXT | Text tuỳ ý | Verify domain ownership, SPF/DKIM |
| SOA | Zone metadata | Tự sinh, ít khi đụng |
| CAA | CA được phép cấp cert | Liên quan ACM/SSL |
| SRV, PTR, NAPTR, DS, SPF | — | Chỉ cần nhận diện tên |

Ghi record bằng CLI dùng `change-resource-record-sets` — API này nhận một **change batch** (UPSERT/CREATE/DELETE) và có tính atomic: cả batch thành công hoặc thất bại cùng nhau:

```bash
aws route53 change-resource-record-sets \
  --hosted-zone-id Z0123456789ABCDEF \
  --change-batch '{
    "Comment": "Tro api ve IP cua server moi",
    "Changes": [{
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "api.example.com",
        "Type": "A",
        "TTL": 300,
        "ResourceRecords": [{"Value": "54.23.11.9"}]
      }
    }]
  }'
```

Cùng thao tác với AWS SDK for JavaScript v3:

```javascript
import {
  Route53Client,
  ChangeResourceRecordSetsCommand,
  GetChangeCommand,
} from "@aws-sdk/client-route-53";

const client = new Route53Client({}); // Route 53 là global service, không cần region

const res = await client.send(new ChangeResourceRecordSetsCommand({
  HostedZoneId: "Z0123456789ABCDEF",
  ChangeBatch: {
    Comment: "UPSERT record A cho api",
    Changes: [{
      Action: "UPSERT",
      ResourceRecordSet: {
        Name: "api.example.com",
        Type: "A",
        TTL: 300,
        ResourceRecords: [{ Value: "54.23.11.9" }],
      },
    }],
  },
}));

// Thay đổi ở trạng thái PENDING cho đến khi lan ra toàn bộ name servers (~60s)
console.log(res.ChangeInfo.Status); // "PENDING" -> poll bằng GetChangeCommand đến "INSYNC"
const change = await client.send(new GetChangeCommand({ Id: res.ChangeInfo.Id }));
console.log(change.ChangeInfo.Status);
```

Lưu ý thực tế: `ChangeResourceRecordSets` trả về `PENDING` ngay lập tức; trạng thái `INSYNC` nghĩa là thay đổi đã lan đến tất cả authoritative name server của Route 53 (thường dưới 60 giây). Nhưng client toàn cầu vẫn có thể thấy giá trị cũ cho đến khi TTL trong cache resolver của họ hết hạn — hai khái niệm này khác nhau và đề hay gài.

**Delegate subdomain bằng NS record:** nếu team khác muốn tự quản `dev.example.com`, bạn tạo hosted zone riêng cho `dev.example.com`, rồi trong zone cha `example.com` tạo NS record tên `dev.example.com` trỏ tới 4 name server của zone con. Đây là pattern tách quyền quản trị DNS giữa các team/account.

## 10.4 CNAME vs Alias — câu hỏi kinh điển

Đây là điểm thi xuất hiện gần như chắc chắn. Cả hai đều dùng để trỏ một hostname tới một hostname khác, nhưng khác nhau căn bản:

**CNAME** là record type chuẩn DNS: `app.example.com CNAME my-alb-123.ap-southeast-1.elb.amazonaws.com`. Khi resolver hỏi `app.example.com`, Route 53 trả về tên ALB, resolver phải thực hiện thêm một vòng phân giải nữa để ra IP. Hạn chế chí mạng: **chuẩn DNS cấm CNAME ở zone apex** (root domain) — bạn không thể tạo CNAME cho `example.com` trần (vì apex đã có NS và SOA record, mà CNAME không được tồn tại cùng record khác trên cùng tên).

**Alias** là extension riêng của Route 53, không phải chuẩn DNS. Với bên ngoài, alias record trông như một A (hoặc AAAA) record bình thường — Route 53 tự phân giải target AWS resource ra IP và trả thẳng IP cho client trong một bước. Vì là "A record giả", **alias dùng được ở zone apex**: `example.com` → ALB là chuyện bình thường.

| Tiêu chí | CNAME | Alias |
|---|---|---|
| Chuẩn DNS | Có | Không (Route 53 riêng) |
| Dùng ở zone apex (`example.com`) | **Không** | **Có** |
| Target | Bất kỳ hostname nào (AWS hay ngoài AWS) | Chỉ một số AWS resource + record khác trong cùng zone |
| Phí query | Tính phí | **Miễn phí** khi trỏ tới AWS resource |
| TTL | Bạn tự đặt | Route 53 tự quản (thường 60s), **không chỉnh được** |
| Tự bám theo IP thay đổi của target | Qua phân giải tiếp | Có, native (ALB đổi IP thì alias tự đúng) |
| Health check tích hợp | Không | Có `EvaluateTargetHealth` |

Các alias target hợp lệ cần thuộc lòng: **Elastic Load Balancer, CloudFront distribution, API Gateway, Elastic Beanstalk environment, S3 website endpoint (bucket bật static website hosting, tên bucket phải trùng tên record), VPC interface endpoint, AWS Global Accelerator, và một record khác trong cùng hosted zone**. Đặc biệt lưu ý hai thứ **KHÔNG** làm alias target được: **EC2 public DNS name** và **RDS endpoint** — muốn trỏ tới chúng phải dùng CNAME (với subdomain) hoặc A record với IP (dở, vì IP đổi).

Tạo alias record trỏ apex domain về ALB:

```bash
aws route53 change-resource-record-sets \
  --hosted-zone-id Z0123456789ABCDEF \
  --change-batch '{
    "Changes": [{
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "example.com",
        "Type": "A",
        "AliasTarget": {
          "HostedZoneId": "Z1LMS91P8CMLE5",
          "DNSName": "my-alb-123.ap-southeast-1.elb.amazonaws.com",
          "EvaluateTargetHealth": true
        }
      }
    }]
  }'
```

Hai điểm dễ vấp trong code trên: (1) `HostedZoneId` trong `AliasTarget` **không phải** zone của bạn — nó là hosted zone ID của dịch vụ target (mỗi loại resource mỗi region có ID riêng, ví dụ ALB ở ap-southeast-1 là `Z1LMS91P8CMLE5`; tra trong docs hoặc lấy từ `aws elbv2 describe-load-balancers` trường `CanonicalHostedZoneId`). (2) Alias record không có trường `TTL` — đặt vào là lỗi validation.

`EvaluateTargetHealth: true` nghĩa là Route 53 dùng trạng thái health của chính target (ví dụ ALB còn target healthy hay không) như một health check ngầm — không cần tạo health check riêng, không tốn phí.

> 💡 **Exam Tip:** Thấy từ khoá "zone apex" / "root domain" / "naked domain" trỏ tới ALB, CloudFront, API Gateway → đáp án là **Alias record**, loại CNAME ngay. Thấy "trỏ tới RDS endpoint" hoặc "hostname ngoài AWS" → **CNAME** (và không được ở apex).

## 10.5 Routing policies — trái tim của chương

Routing policy quyết định Route 53 trả lời query như thế nào. Lưu ý quan trọng về bản chất: Route 53 **không nằm trên đường đi của traffic** — nó chỉ trả lời câu hỏi "IP nào?". Khác hẳn load balancer (Chương 6) là thứ traffic thật sự chảy qua.

### Simple

Một record, một hoặc nhiều giá trị. Nếu nhiều giá trị, Route 53 trả về **tất cả** theo thứ tự ngẫu nhiên, client tự chọn (thường lấy cái đầu). **Không gắn health check được** — nếu một IP chết, client vẫn có thể nhận IP chết đó. Dùng khi: một endpoint duy nhất, không cần thông minh.

### Weighted

Chia traffic theo trọng số. Tạo nhiều record **cùng tên, cùng type**, mỗi record một `Weight` (0–255) và một `SetIdentifier` (bắt buộc, để phân biệt các record cùng tên). Tỷ lệ traffic = weight của record / tổng weight — không cần cộng lại bằng 100.

- Weight = 0 cho một record: ngừng gửi traffic tới record đó (cách "tắt" một biến thể).
- Tất cả record đều weight 0: chia đều.

Use case kinh điển trong đề: **canary/blue-green testing** — gửi 5% traffic sang version mới (`Weight: 5` vs `Weight: 95`), regional load shifting, A/B testing.

```bash
# 90% traffic ve fleet cu, 10% ve fleet moi (canary)
aws route53 change-resource-record-sets --hosted-zone-id Z0123456789ABCDEF \
  --change-batch '{
    "Changes": [
      {"Action": "UPSERT", "ResourceRecordSet": {
        "Name": "api.example.com", "Type": "A", "TTL": 60,
        "SetIdentifier": "stable", "Weight": 90,
        "ResourceRecords": [{"Value": "54.23.11.9"}]}},
      {"Action": "UPSERT", "ResourceRecordSet": {
        "Name": "api.example.com", "Type": "A", "TTL": 60,
        "SetIdentifier": "canary", "Weight": 10,
        "ResourceRecords": [{"Value": "54.23.11.10"}]}}
    ]
  }'
```

Bẫy thực tế: weighted routing dựa trên DNS nên độ chính xác tỷ lệ phụ thuộc TTL và caching — với TTL cao, một resolver lớn (ví dụ của một ISP) cache một câu trả lời và hàng nghìn user phía sau cùng nhận một IP. Muốn tỷ lệ chính xác hơn → hạ TTL, hoặc dùng weighted target group của ALB (Chương 6).

### Latency-based

Route 53 trả về record của **region có độ trễ mạng thấp nhất** tới resolver của user — dựa trên dữ liệu đo đạc của AWS giữa các vị trí internet và AWS regions, **không phải khoảng cách địa lý**. Mỗi record gán với một region (`Region: ap-southeast-1`...) + `SetIdentifier`. User ở Đức có thể được trả về us-east-1 nếu routing internet lúc đó tới us-east-1 nhanh hơn eu-west-1.

Use case: ứng dụng deploy multi-region, muốn user được phục vụ từ region nhanh nhất. Kết hợp được với health check — region fail thì tự trả region nhanh nhì.

### Failover

Active-passive disaster recovery. Đúng hai vai trò: **PRIMARY** (bắt buộc gắn health check) và **SECONDARY** (DR site, health check tuỳ chọn). Khi health check của primary fail, Route 53 tự động trả về secondary. Pattern kinh điển: primary là ALB ở region chính, secondary là S3 static website "We'll be back" hoặc stack ở region DR.

```javascript
// Failover pair voi SDK v3
const changes = [
  {
    Action: "UPSERT",
    ResourceRecordSet: {
      Name: "app.example.com", Type: "A",
      SetIdentifier: "primary", Failover: "PRIMARY",
      HealthCheckId: "11111111-aaaa-bbbb-cccc-222222222222", // bat buoc cho PRIMARY
      AliasTarget: {
        HostedZoneId: "Z1LMS91P8CMLE5",
        DNSName: "alb-main.ap-southeast-1.elb.amazonaws.com",
        EvaluateTargetHealth: true,
      },
    },
  },
  {
    Action: "UPSERT",
    ResourceRecordSet: {
      Name: "app.example.com", Type: "A",
      SetIdentifier: "secondary", Failover: "SECONDARY",
      AliasTarget: {
        HostedZoneId: "Z3AQBSTGFYJSTF", // S3 website endpoint us-east-1
        DNSName: "s3-website-us-east-1.amazonaws.com",
        EvaluateTargetHealth: false,
      },
    },
  },
];
```

### Geolocation

Định tuyến theo **vị trí địa lý của user** (continent, country, hoặc state của Mỹ) — khác latency-based vốn dựa trên độ trễ. Use case: nội dung bản địa hoá (user Việt Nam vào server tiếng Việt), tuân thủ pháp lý/data residency (user EU phải vào hạ tầng EU), chặn/giới hạn phân phối theo nước. Quy tắc match: cụ thể nhất thắng (state > country > continent). **Luôn tạo một default record** cho user không match location nào — không có default, user "lạ" nhận `NXDOMAIN` (lỗi hay gặp).

### Geoproximity

Định tuyến theo **khoảng cách địa lý giữa user và resource**, kèm tham số **bias** (−99 đến +99) để co giãn "vùng ảnh hưởng" của từng resource: bias dương kéo thêm traffic về resource đó, bias âm đẩy bớt đi. Dùng được với cả AWS resource (gán region) lẫn non-AWS resource (gán toạ độ lat/long). Yêu cầu dùng **Route 53 Traffic Flow** (công cụ visual editor + traffic policy versioning). Use case nhận diện trong đề: "shift dần traffic từ region này sang region kia bằng cách điều chỉnh một tham số" → bias → geoproximity.

### IP-based

Định tuyến dựa trên **CIDR của resolver gửi query**. Bạn tạo CIDR collection (danh sách block IP) rồi map từng block tới record. Use case: biết trước dải IP của từng ISP/đối tác và muốn ép họ vào endpoint nhất định (ví dụ ISP A đi đường peering riêng), tối ưu chi phí network. Đây là policy mới hơn, đề chỉ cần nhận diện đúng use case.

### Multi-value answer

Trả về **tối đa 8 record healthy** ngẫu nhiên trong số các record cùng tên. Khác simple ở chỗ: mỗi record gắn health check riêng được — record fail bị loại khỏi câu trả lời. Là dạng "client-side load balancing thô" nhưng **không thay thế được ELB** (không biết tải, không sticky, không L7) — đề hay gài câu "có phải substitute cho ELB không": **không**.

Bảng quyết định nhanh:

| Từ khoá trong đề | Policy |
|---|---|
| Chia % traffic, canary, A/B test | Weighted |
| "Lowest latency", multi-region performance | Latency-based |
| Active-passive DR, "failover to static site" | Failover |
| Theo quốc gia user, data residency, nội dung bản địa | Geolocation |
| Dịch chuyển traffic giữa region bằng "bias" | Geoproximity |
| Theo dải CIDR/ISP của client | IP-based |
| Trả nhiều IP healthy, client tự chọn, không cần LB | Multi-value answer |
| Một endpoint, không cần gì đặc biệt | Simple |

> 💡 **Exam Tip:** Phân biệt nhanh ba policy "địa lý": **Latency** = nhanh nhất về mạng (không quan tâm user ở đâu); **Geolocation** = user Ở ĐÂU thì vào đó (compliance, localization); **Geoproximity** = khoảng cách + chỉnh bias để dịch chuyển traffic. Và nhớ: simple routing KHÔNG hỗ trợ health check; multi-value CÓ.

## 10.6 Health Checks

Health check là thành phần làm cho failover/multi-value/latency routing trở nên "tự chữa lành". Route 53 có ba loại:

### 1. Health check giám sát endpoint

Một đội ~15 health checker toàn cầu của Route 53 chủ động gửi request tới endpoint của bạn (theo IP hoặc domain name; giao thức HTTP, HTTPS hoặc TCP). Các con số phải nhớ:

- **Interval:** 30 giây (standard) hoặc **10 giây (fast health check, tốn thêm phí)**.
- **Threshold:** mặc định **3** lần liên tiếp fail → unhealthy, 3 lần pass → healthy (chỉnh được).
- Endpoint được coi là **healthy khi > 18% số checker** báo healthy.
- HTTP/HTTPS: status **2xx hoặc 3xx** là pass; có thể bật **string matching** — tìm chuỗi trong **5120 bytes đầu tiên** của response body.
- Timeout: phải nhận response nhanh (mặc định 4s connect với HTTP).

Lưu ý hạ tầng quan trọng: health checker nằm **ngoài VPC của bạn, trên internet công cộng**. Hệ quả: (1) Security Group/NACL của endpoint phải cho phép IP range của Route 53 health checkers (AWS công bố danh sách IP); (2) **health checker không thể gọi vào private endpoint trong VPC** — dẫn tới loại thứ 3 bên dưới.

```bash
# Tao health check HTTPS co string matching
aws route53 create-health-check \
  --caller-reference "hc-api-$(date +%s)" \
  --health-check-config '{
    "Type": "HTTPS_STR_MATCH",
    "FullyQualifiedDomainName": "api.example.com",
    "ResourcePath": "/healthz",
    "Port": 443,
    "RequestInterval": 30,
    "FailureThreshold": 3,
    "SearchString": "\"status\":\"ok\""
  }'
```

### 2. Calculated health check

Health check "cha" tổng hợp trạng thái của **tối đa 256 health check con**, kết hợp bằng logic AND / OR / "ít nhất N trong M healthy". Use case: website phụ thuộc 3 microservice — chỉ coi là healthy khi ít nhất 2/3 service sống; hoặc muốn maintain mà không kích hoạt failover (ép trạng thái cha).

### 3. Health check dựa trên CloudWatch alarm

Giải pháp cho **private resource**: vì checker không vào được VPC, bạn tạo CloudWatch alarm giám sát metric của resource (ví dụ `StatusCheckFailed` của EC2 instance private, hoặc custom metric ứng dụng tự push — chi tiết CloudWatch ở Chương 24), rồi tạo health check loại `CLOUDWATCH_METRIC` bám theo trạng thái alarm: alarm `ALARM` → unhealthy. Đây là đáp án chuẩn cho câu "làm sao health check một instance trong private subnet".

Cách dùng health check trong record: gắn `HealthCheckId` vào record (weighted/failover/latency/multi-value...), hoặc với alias record dùng `EvaluateTargetHealth: true` để mượn health của chính AWS target (ALB tự biết target group còn ai healthy). Health check còn có thể **invert** (đảo trạng thái) và **disable** tạm thời. Mỗi health check có metric trong CloudWatch và có thể gắn alarm + SNS để báo on-call.

> 💡 **Exam Tip:** Ba tình huống — health check tự gọi endpoint public → **endpoint health check**; tổng hợp nhiều health check với logic AND/OR → **calculated**; resource nằm trong **private VPC** → **CloudWatch alarm health check** (vì health checker sống ngoài internet, không vào VPC được). Con số hay hỏi: interval 30s (fast: 10s), threshold mặc định 3, pass khi >18% checkers báo healthy, string match trong 5120 bytes đầu.

## 10.7 Route 53 Resolver cho hybrid DNS (mức nhận diện)

Khi doanh nghiệp có data center on-premises nối với VPC (qua VPN/Direct Connect — Chương 11), nhu cầu phát sinh: server on-prem phân giải tên trong private hosted zone, và EC2 phân giải tên nội bộ của on-prem. Route 53 Resolver endpoints giải quyết việc này:

- **Inbound endpoint:** cho phép DNS query từ on-premises đi VÀO resolver của VPC (on-prem phân giải được private hosted zone).
- **Outbound endpoint + resolver rules:** chuyển tiếp query từ VPC RA DNS server on-premises (EC2 phân giải được `*.corp.local`).

DVA-C02 chỉ cần nhận diện inbound vs outbound theo chiều query; cấu hình chi tiết thuộc phạm vi đề khác.

## 10.8 Domain registration & DNS migration

**Đăng ký domain với Route 53:** Route 53 kiêm luôn registrar — mua domain trực tiếp (`Registered domains` trong console), phí theo năm, tự động tạo public hosted zone cùng tên. Route 53 quản lý auto-renew, transfer lock, WHOIS privacy.

Hai vai trò tách biệt — bảng tình huống đề hay hỏi:

| Tình huống | Cách làm |
|---|---|
| Mua domain ở Route 53, DNS ở Route 53 | Mặc định, không làm gì thêm |
| Mua domain ở GoDaddy, muốn DNS bằng Route 53 | Tạo public hosted zone ở Route 53 → copy 4 NS record → cập nhật name servers tại GoDaddy |
| Mua domain ở Route 53, DNS ở provider khác | Vào Registered domains → sửa name servers trỏ về provider kia |

**Quy trình migrate DNS từ provider khác sang Route 53 không downtime** — thứ tự các bước là điểm thi:

1. **Lấy toàn bộ record hiện tại** từ provider cũ (export zone file nếu có).
2. **Hạ TTL** của các record tại provider cũ xuống thấp (ví dụ 300s, đặc biệt NS record nếu chỉnh được) — rồi **đợi hết TTL cũ** để cache toàn cầu xả ra.
3. Tạo **public hosted zone** trên Route 53, tái tạo đầy đủ record (Route 53 hỗ trợ import zone file qua console; CLI thì dùng `change-resource-record-sets` theo batch).
4. **Kiểm tra** zone mới trả lời đúng bằng cách query thẳng name server Route 53: `dig @ns-123.awsdns-45.com api.example.com`.
5. **Cập nhật NS tại registrar** trỏ về 4 name server của Route 53.
6. Theo dõi trong tối đa 2 ngày (TTL của NS record ở TLD thường 172800s = 48h) — giữ zone cũ chạy song song trong thời gian này, đừng xoá vội.
7. Sau khi traffic chuyển hẳn: nâng TTL trở lại, huỷ dịch vụ DNS cũ. (Tuỳ chọn) transfer luôn domain registration về Route 53 nếu muốn gom một mối.

Bẫy production có thật: xoá zone ở provider cũ ngay sau khi đổi NS → một phần resolver toàn cầu vẫn cache NS cũ trong tới 48h và nhận `SERVFAIL` → mất traffic ngắt quãng rất khó debug. Luôn chạy song song qua hết TTL của NS record.

> 💡 **Exam Tip:** "Company registered domain with a third-party registrar and wants Route 53 to manage DNS" → tạo public hosted zone + **update NS records at the registrar**. Ngược lại, migrate registrar mà giữ DNS thì không đụng đến hosted zone. Hai việc độc lập nhau — đề rất thích kiểm tra bạn có lẫn lộn registrar và DNS service không.

Phần tiếp theo (part 2) gồm hands-on lab dựng failover routing với health check, exam tips tổng hợp, quiz 10 câu và tóm tắt chương.
