## Hands-on Lab: Failover routing với health check trên Route 53

**Mục tiêu lab:** Tạo public hosted zone, dựng hai web endpoint (primary/secondary) trên EC2, cấu hình health check + failover routing policy, rồi tự tay "giết" primary để quan sát Route 53 chuyển traffic sang secondary. Bonus: thử weighted routing để hiểu cơ chế phân phối theo trọng số.

**Chuẩn bị:**
- AWS CLI v2 đã cấu hình profile có quyền `route53:*`, `ec2:*`.
- Công cụ `dig` (có sẵn trên macOS/Linux; Windows dùng `nslookup` hoặc cài BIND tools).
- KHÔNG cần sở hữu domain thật. Mẹo: bạn có thể tạo hosted zone cho bất kỳ tên nào (ví dụ `devlab-12345.com`) và test bằng cách query **trực tiếp vào name server của hosted zone** với `dig @ns-xxx...`. Resolver công cộng sẽ không phân giải được (vì chưa delegation từ registrar), nhưng query thẳng NS thì hoạt động đầy đủ — đủ để kiểm chứng mọi routing policy.
- Chi phí: hosted zone $0.50/tháng (tính tròn tháng, nhưng xoá trong 12 giờ đầu sẽ được hoàn), health check endpoint AWS ~$0.50/tháng, 2 EC2 t3.micro vài giờ — tổng dưới $1 nếu dọn dẹp ngay.

### Bước 1: Tạo public hosted zone

```bash
# Caller reference phải unique cho mỗi lần gọi (idempotency token)
aws route53 create-hosted-zone \
  --name devlab-12345.com \
  --caller-reference "lab-$(date +%s)" \
  --hosted-zone-config Comment="DVA-C02 lab chapter 10"
```

Output mong đợi (rút gọn):

```json
{
  "HostedZone": {
    "Id": "/hostedzone/Z0123456789ABCDEFGHIJ",
    "Name": "devlab-12345.com.",
    "ResourceRecordSetCount": 2
  },
  "DelegationSet": {
    "NameServers": [
      "ns-1234.awsdns-56.org",
      "ns-789.awsdns-01.net",
      "ns-345.awsdns-22.com",
      "ns-678.awsdns-33.co.uk"
    ]
  }
}
```

Lưu lại ID và một name server:

```bash
export ZONE_ID=Z0123456789ABCDEFGHIJ
export NS=ns-1234.awsdns-56.org
```

Để ý `ResourceRecordSetCount: 2` — Route 53 tự tạo sẵn 1 record NS và 1 record SOA. Hai record này KHÔNG xoá được và không tính phí query.

### Bước 2: Dựng hai web endpoint

Tạo 2 EC2 instance chạy web server trả về tên endpoint (cách launch EC2 với user data — chi tiết ở Chương 4). User data cho primary:

```bash
#!/bin/bash
dnf install -y httpd
echo "PRIMARY endpoint" > /var/www/html/index.html
echo "OK" > /var/www/html/health
systemctl enable --now httpd
```

Secondary tương tự, đổi nội dung thành `SECONDARY endpoint`. Security group phải mở inbound TCP 80 từ `0.0.0.0/0` — health checker của Route 53 gọi từ **bên ngoài**, qua public IP, từ nhiều IP range của AWS (publish trong file ip-ranges.json, service `ROUTE53_HEALTHCHECKS`). Đây là bẫy lab kinh điển: SG chỉ mở cho IP của bạn → health check báo Unhealthy dù curl từ máy bạn vẫn chạy.

Lấy public IP của hai instance:

```bash
aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=r53-primary,r53-secondary" \
  --query "Reservations[].Instances[].[Tags[?Key=='Name']|[0].Value,PublicIpAddress]" \
  --output table
export IP_PRIMARY=3.91.10.20
export IP_SECONDARY=54.220.30.40
```

### Bước 3: Tạo health check cho primary

```bash
aws route53 create-health-check \
  --caller-reference "hc-$(date +%s)" \
  --health-check-config '{
    "Type": "HTTP",
    "IPAddress": "'"$IP_PRIMARY"'",
    "Port": 80,
    "ResourcePath": "/health",
    "RequestInterval": 30,
    "FailureThreshold": 3
  }'
export HC_ID=<HealthCheck.Id từ output>
```

Giải thích tham số: `RequestInterval` 30s (standard, mặc định) hoặc 10s (fast, tốn thêm tiền); `FailureThreshold` 3 nghĩa là cần 3 lần check fail liên tiếp mới chuyển sang Unhealthy → thời gian phát hiện ≈ 30 × 3 = ~90 giây. Health checker chạy từ **nhiều region**, endpoint được coi là healthy khi ≥ 18% checker báo OK.

Chờ ~1 phút rồi kiểm tra:

```bash
aws route53 get-health-check-status --health-check-id $HC_ID \
  --query "HealthCheckObservations[].StatusReport.Status" --output text
```

Output mong đợi: nhiều dòng `Success: HTTP Status Code 200, OK`.

### Bước 4: Tạo cặp record failover

```bash
cat > failover.json <<'EOF'
{
  "Changes": [
    {
      "Action": "CREATE",
      "ResourceRecordSet": {
        "Name": "app.devlab-12345.com",
        "Type": "A",
        "SetIdentifier": "primary",
        "Failover": "PRIMARY",
        "TTL": 60,
        "HealthCheckId": "HC_ID_PLACEHOLDER",
        "ResourceRecords": [{ "Value": "IP_PRIMARY_PLACEHOLDER" }]
      }
    },
    {
      "Action": "CREATE",
      "ResourceRecordSet": {
        "Name": "app.devlab-12345.com",
        "Type": "A",
        "SetIdentifier": "secondary",
        "Failover": "SECONDARY",
        "TTL": 60,
        "ResourceRecords": [{ "Value": "IP_SECONDARY_PLACEHOLDER" }]
      }
    }
  ]
}
EOF
sed -i '' "s/HC_ID_PLACEHOLDER/$HC_ID/; s/IP_PRIMARY_PLACEHOLDER/$IP_PRIMARY/; s/IP_SECONDARY_PLACEHOLDER/$IP_SECONDARY/" failover.json

aws route53 change-resource-record-sets \
  --hosted-zone-id $ZONE_ID --change-batch file://failover.json
```

Output trả về `"Status": "PENDING"` kèm change ID. Đợi propagate sang toàn bộ name server (thường < 60 giây):

```bash
aws route53 wait resource-record-sets-changed --id <ChangeInfo.Id>
```

Hai điểm cần khắc sâu: (1) hai record cùng tên cùng type phân biệt bằng `SetIdentifier`; (2) TTL đặt 60 giây — TTL cao (ví dụ 86400) sẽ khiến client cache IP cũ rất lâu sau khi failover, vô hiệu hoá toàn bộ cơ chế.

### Bước 5: Test failover

Query trực tiếp name server của zone:

```bash
dig +short @$NS app.devlab-12345.com A
```

Output mong đợi: `3.91.10.20` (IP primary). Giờ giết primary:

```bash
aws ec2 stop-instances --instance-ids <id-primary>
```

Theo dõi health check chuyển trạng thái (mất ~90–120 giây với cấu hình 30s × 3):

```bash
watch -n 15 "aws route53 get-health-check-status --health-check-id $HC_ID \
  --query 'HealthCheckObservations[0].StatusReport.Status' --output text"
```

Khi status chuyển sang `Failure: Connection timed out`, query lại:

```bash
dig +short @$NS app.devlab-12345.com A
# Output: 54.220.30.40  ← Route 53 đã trả về secondary
```

Khởi động lại primary (`start-instances`) — lưu ý public IP sẽ ĐỔI nếu không dùng Elastic IP, phải cập nhật record và health check; đây chính là lý do production luôn trỏ failover vào Elastic IP hoặc alias tới ELB. Sau khi health check Healthy trở lại, `dig` sẽ trả về primary.

### Bước 6 (bonus): Weighted routing

Xoá cặp failover (Action `DELETE`, change batch giống hệt lúc CREATE) rồi tạo 2 record weighted: primary `Weight: 80`, secondary `Weight: 20`, TTL 0–10. Chạy thử:

```bash
for i in $(seq 1 20); do dig +short @$NS app.devlab-12345.com A; done | sort | uniq -c
```

Output mong đợi xấp xỉ tỷ lệ 8:2 (ví dụ `16 3.91.10.20` / `4 54.220.30.40`). Lưu ý weighted là **xác suất trên mỗi query DNS**, không phải trên mỗi request HTTP — DNS caching ở resolver/client làm tỷ lệ traffic thực tế lệch khỏi 80/20. Đặt `Weight: 0` cho một record để tạm rút nó khỏi rotation mà không xoá.

### Dọn dẹp tài nguyên

Thứ tự quan trọng: **không thể xoá hosted zone khi còn record do bạn tạo** (trừ NS/SOA mặc định).

```bash
# 1. Xoá toàn bộ record tự tạo (Action DELETE với change batch y hệt lúc tạo)
aws route53 change-resource-record-sets --hosted-zone-id $ZONE_ID \
  --change-batch file://delete-records.json

# 2. Xoá health check
aws route53 delete-health-check --health-check-id $HC_ID

# 3. Xoá hosted zone (trong 12h đầu sẽ được hoàn phí $0.50)
aws route53 delete-hosted-zone --id $ZONE_ID

# 4. Terminate EC2
aws ec2 terminate-instances --instance-ids <id-primary> <id-secondary>
```

Kiểm tra lại: `aws route53 list-hosted-zones` và `aws route53 list-health-checks` phải trống.

## 💡 Exam Tips chương 10

- **CNAME vs Alias** là câu hỏi xuất hiện gần như chắc chắn: CNAME KHÔNG dùng được ở zone apex (`example.com`); Alias dùng được ở apex, miễn phí query, chỉ trỏ tới tài nguyên AWS (ELB, CloudFront, S3 website endpoint, API Gateway, Global Accelerator, record khác trong cùng zone). Thấy "root domain trỏ tới ALB" → Alias A record.
- Alias record KHÔNG thể trỏ tới EC2 public DNS name hay endpoint on-premises — chỉ tài nguyên AWS được hỗ trợ. Trỏ EC2 thì dùng A record với Elastic IP.
- TTL: thấp → failover/chuyển đổi nhanh nhưng nhiều query (tốn tiền hơn); cao → rẻ nhưng client cache lâu. Trước khi migrate DNS, hạ TTL xuống trước (ví dụ 60s) và đợi hết TTL cũ rồi mới đổi record.
- Routing policy theo từ khoá: "tỷ lệ % traffic / canary / A-B testing" → **weighted**; "độ trễ thấp nhất cho user" → **latency**; "nội dung theo quốc gia / tuân thủ pháp lý dữ liệu" → **geolocation**; "dịch chuyển traffic dần theo bán kính, có bias" → **geoproximity** (cần Traffic Flow); "active-passive DR" → **failover**; "trả nhiều IP healthy, client tự chọn" → **multi-value answer**.
- Multi-value answer trả tối đa **8 record healthy** mỗi query và hỗ trợ health check per record — nhưng nó KHÔNG phải load balancer thay thế ELB (không biết connection state, không SSL termination).
- Simple routing KHÔNG gắn được health check; nếu simple record chứa nhiều giá trị, Route 53 trả tất cả theo thứ tự ngẫu nhiên và client chọn một.
- Health check có 3 loại: **endpoint** (HTTP/HTTPS/TCP), **calculated** (tổng hợp tối đa 256 child health checks với logic AND/OR/threshold), **CloudWatch alarm**. Health check KHÔNG thể gọi trực tiếp vào endpoint private/VPC — muốn theo dõi resource private phải đi đường vòng qua **CloudWatch alarm health check**.
- HTTP health check coi endpoint healthy khi status code **2xx hoặc 3xx**; có thể bật string matching (tìm chuỗi trong 5120 byte đầu của body). Geolocation nên luôn có record **Default** — không có thì user ngoài các vùng đã định nghĩa nhận NXDOMAIN/no answer.
- Failover PRIMARY bắt buộc gắn health check (hoặc là alias với "Evaluate Target Health = Yes"); SECONDARY không bắt buộc nhưng nên có.
- Private hosted zone yêu cầu VPC bật `enableDnsSupport` và `enableDnsHostnames`; câu hỏi "resolve tên nội bộ trong VPC, không expose ra internet" → private hosted zone.
- Route 53 là **registrar và DNS service tách biệt**: có thể mua domain ở GoDaddy nhưng dùng Route 53 làm DNS (tạo hosted zone rồi cập nhật NS record tại registrar), hoặc ngược lại mua domain ở Route 53 nhưng dùng DNS bên thứ ba.
- Health checker của Route 53 gọi từ internet công cộng — security group/firewall của endpoint phải allow IP range của Route 53 health checkers, nếu không sẽ Unhealthy "oan".

## Quiz chương 10 (10 câu)

**Câu 1.** Một developer cần trỏ root domain `example.com` tới một Application Load Balancer. Cách nào đúng?
- A. Tạo CNAME record `example.com` trỏ tới DNS name của ALB
- B. Tạo Alias A record `example.com` trỏ tới ALB
- C. Tạo A record `example.com` với static IP của ALB
- D. Tạo NS record trỏ tới ALB

**Câu 2.** Công ty muốn chạy canary release: 5% traffic vào phiên bản mới, 95% vào phiên bản cũ, hai phiên bản chạy sau hai ALB khác nhau. Routing policy nào phù hợp?
- A. Latency
- B. Multi-value answer
- C. Weighted
- D. Geoproximity

**Câu 3.** "A developer needs to" cấu hình DNS sao cho user ở Pháp luôn thấy nội dung phiên bản tiếng Pháp (yêu cầu pháp lý), bất kể độ trễ tới server nào thấp hơn. Chọn gì?
- A. Latency routing
- B. Geolocation routing
- C. Geoproximity routing
- D. Failover routing

**Câu 4.** Một ứng dụng active-passive: primary ở us-east-1, standby ở eu-west-1. Khi primary sập, DNS phải tự động trỏ về standby. Cấu hình tối thiểu cần gì?
- A. Hai record failover PRIMARY/SECONDARY, health check gắn vào record PRIMARY
- B. Hai record weighted 100/0, đổi weight thủ công khi sự cố
- C. Hai record latency, Route 53 tự tránh region lỗi
- D. Một record multi-value answer chứa cả hai IP

**Câu 5.** Health check của Route 53 báo Unhealthy cho một web server EC2, nhưng developer `curl` từ máy mình vào public IP thì nhận 200 OK. Nguyên nhân khả dĩ nhất?
- A. TTL của record quá cao
- B. Security group chỉ allow port 80 từ IP văn phòng, chặn IP range của Route 53 health checkers
- C. Health check chỉ hỗ trợ HTTPS, không hỗ trợ HTTP
- D. EC2 chưa gắn IAM role cho Route 53

**Câu 6.** Một team cần Route 53 theo dõi sức khoẻ của một endpoint nằm trong **private subnet**, không có public IP. Giải pháp đúng?
- A. Tạo endpoint health check trỏ vào private IP
- B. Tạo CloudWatch alarm giám sát endpoint (qua custom metric/health probe nội bộ) rồi tạo health check loại CloudWatch alarm
- C. Gắn Elastic IP tạm thời để health check truy cập
- D. Dùng calculated health check với 0 child

**Câu 7.** Sau khi đổi A record từ IP cũ sang IP mới, nhiều user vẫn truy cập IP cũ suốt nhiều giờ. Nguyên nhân và bài học?
- A. Route 53 propagate chậm giữa các edge location
- B. Record cũ có TTL cao, resolver/client còn cache; lẽ ra phải hạ TTL từ trước khi đổi
- C. Phải tạo hosted zone mới thì record mới có hiệu lực
- D. Thiếu health check nên Route 53 không cập nhật

**Câu 8.** Khác biệt nào giữa CNAME và Alias record là ĐÚNG?
- A. Alias tính phí query, CNAME miễn phí
- B. CNAME trỏ được tới mọi hostname kể cả ngoài AWS; Alias chỉ trỏ tới một số tài nguyên AWS nhưng dùng được ở zone apex và query miễn phí
- C. Alias chỉ hỗ trợ type A, không hỗ trợ AAAA
- D. CNAME dùng được ở zone apex nếu bật "Evaluate Target Health"

**Câu 9.** Ứng dụng có 6 instance ở nhiều region, mỗi instance có health check riêng. Yêu cầu: mỗi DNS query trả về danh sách các IP đang healthy (tối đa 8) để client tự chọn, không cần load balancer. Routing policy nào?
- A. Simple với 6 giá trị trong 1 record
- B. Weighted với weight bằng nhau
- C. Multi-value answer
- D. IP-based routing

**Câu 10.** Một developer tạo private hosted zone `internal.corp` và associate với VPC, nhưng EC2 trong VPC không resolve được `api.internal.corp`. Nguyên nhân khả dĩ nhất?
- A. Private hosted zone cần delegation từ registrar
- B. VPC chưa bật `enableDnsSupport` và `enableDnsHostnames`
- C. Phải mở port 53 trong security group của EC2
- D. Private hosted zone chỉ hoạt động với CNAME record

### Đáp án & giải thích

**Câu 1 — Đáp án B.** Alias A record là cách duy nhất trỏ zone apex tới ALB: hoạt động ở apex, query miễn phí, tự cập nhật khi IP của ALB thay đổi. A sai vì chuẩn DNS cấm CNAME ở zone apex (apex đã có SOA/NS record, CNAME không được tồn tại cùng record khác cùng tên). C sai vì ALB không có static IP — IP của nó thay đổi (NLB mới có static IP, chi tiết ở Chương 6). D sai vì NS record dùng để delegation name server, không liên quan.

**Câu 2 — Đáp án C.** Weighted routing chia traffic theo trọng số tuỳ ý (95/5), đúng kịch bản canary. A sai: latency chọn theo độ trễ đo được, không kiểm soát được tỷ lệ. B sai: multi-value trả về tập IP healthy ngẫu nhiên, không phân bổ theo tỷ lệ định trước. D sai: geoproximity dịch traffic theo vị trí địa lý và bias, không phải tỷ lệ phần trăm chính xác.

**Câu 3 — Đáp án B.** Geolocation định tuyến dựa trên **vị trí của user** (quốc gia/lục địa/bang Mỹ) — đúng cho yêu cầu nội dung bản địa hoá/tuân thủ pháp lý. A sai: latency chọn region có độ trễ thấp nhất, user Pháp có thể bị đẩy sang server khác nếu nhanh hơn — vi phạm yêu cầu. C sai: geoproximity dựa trên khoảng cách tới resource kèm bias để dịch chuyển traffic, không đảm bảo ranh giới quốc gia chính xác. D sai: failover là cho DR active-passive.

**Câu 4 — Đáp án A.** Failover routing sinh ra đúng cho active-passive: PRIMARY bắt buộc có health check; khi Unhealthy, Route 53 tự trả về SECONDARY. B sai vì "đổi thủ công" không phải tự động, vi phạm yêu cầu. C sai: latency routing kết hợp health check có thể tránh endpoint lỗi nhưng nó là active-active theo độ trễ, không phải mô hình primary/standby được yêu cầu. D sai: multi-value trả cả hai IP khi cùng healthy — standby sẽ nhận traffic ngay cả khi primary sống.

**Câu 5 — Đáp án B.** Health checker của Route 53 gọi từ IP range công cộng của AWS ở nhiều region; nếu SG chỉ allow IP văn phòng thì checker bị chặn → Unhealthy, trong khi curl từ văn phòng vẫn OK. A sai: TTL ảnh hưởng caching ở resolver, không ảnh hưởng trạng thái health check. C sai: health check hỗ trợ HTTP, HTTPS và TCP. D sai: health check không liên quan IAM role của EC2.

**Câu 6 — Đáp án B.** Health checker nằm ngoài VPC, không thể chạm vào private IP — pattern chuẩn là: giám sát endpoint bằng CloudWatch (custom metric, alarm), rồi tạo Route 53 health check loại **CloudWatch alarm** dựa trên trạng thái alarm đó. A sai vì checker không có đường mạng vào private subnet. C là workaround phá vỡ yêu cầu bảo mật (expose public). D sai: calculated health check tổng hợp các child health check khác, không tự kiểm tra endpoint, và "0 child" vô nghĩa.

**Câu 7 — Đáp án B.** DNS resolver và OS/browser cache record theo TTL; TTL 24h nghĩa là tới 24h sau client mới hỏi lại. Quy trình đúng: hạ TTL xuống thấp (60s) TRƯỚC, đợi qua hết TTL cũ, đổi record, rồi nâng TTL lại. A sai: thay đổi record trên Route 53 propagate tới các name server của nó trong ~60 giây — chậm là do cache phía resolver, không phải Route 53. C vô nghĩa. D sai: health check không liên quan tới việc cập nhật giá trị record.

**Câu 8 — Đáp án B.** Đây là bảng phân biệt chuẩn: CNAME trỏ tới hostname bất kỳ nhưng không dùng được ở apex và bị tính phí query; Alias chỉ trỏ tới tài nguyên AWS được hỗ trợ, dùng được ở apex, miễn phí query, hỗ trợ Evaluate Target Health. A ngược hoàn toàn. C sai: Alias hỗ trợ cả A và AAAA (và CNAME trong một số trường hợp). D sai: không gì cho phép CNAME ở apex; "Evaluate Target Health" là thuộc tính của Alias.

**Câu 9 — Đáp án C.** Multi-value answer routing trả về tối đa 8 record healthy mỗi query, mỗi record gắn health check riêng — đúng mô tả "client-side load balancing đơn giản". A sai: simple routing không hỗ trợ health check, IP chết vẫn được trả về. B sai: weighted mỗi query trả về MỘT record được chọn theo trọng số, không phải danh sách. D sai: IP-based routing định tuyến dựa trên **CIDR của resolver gửi query** (ví dụ ISP nào về endpoint nào), không phải trả danh sách IP healthy.

**Câu 10 — Đáp án B.** Private hosted zone chỉ hoạt động khi VPC bật cả hai DNS attribute: `enableDnsSupport` (dùng resolver Route 53 của VPC tại .2 address) và `enableDnsHostnames`. A sai: private zone không cần (và không thể) delegation public — nó chỉ resolve bên trong VPC đã associate. C sai: query DNS trong VPC đi tới Amazon-provided resolver (169.254.169.253 / VPC CIDR+2), không bị security group của EC2 chặn outbound mặc định (SG stateful, allow all outbound mặc định). D sai: private hosted zone hỗ trợ đầy đủ record types.

## Tóm tắt chương

- Route 53 là DNS service (authoritative) kiêm domain registrar; hai vai trò độc lập — có thể dùng riêng từng phần.
- Hosted zone public phục vụ internet, private chỉ resolve trong các VPC được associate (cần `enableDnsSupport` + `enableDnsHostnames`).
- CNAME: trỏ hostname bất kỳ, KHÔNG dùng được ở zone apex, tính phí query. Alias: chỉ trỏ tài nguyên AWS (ELB, CloudFront, S3 website, API Gateway...), dùng được ở apex, miễn phí query, hỗ trợ Evaluate Target Health.
- TTL quyết định thời gian resolver/client cache record — hạ TTL trước khi migrate/failover; TTL cao tiết kiệm phí query nhưng đổi record "ngấm" chậm.
- 8 routing policies cần thuộc theo từ khoá: simple (mặc định, không health check), weighted (tỷ lệ %, canary, weight 0 để rút khỏi rotation), latency (độ trễ thấp nhất), failover (active-passive DR), geolocation (vị trí user, compliance, nhớ record Default), geoproximity (khoảng cách + bias, cần Traffic Flow), IP-based (theo CIDR của resolver), multi-value (trả ≤8 IP healthy).
- Health check 3 loại: endpoint (HTTP/HTTPS/TCP, 2xx/3xx là healthy, có string matching), calculated (gộp ≤256 child với AND/OR/threshold), CloudWatch alarm (cách duy nhất giám sát endpoint private).
- Health checker gọi từ IP công cộng của AWS ở nhiều region — firewall/SG của endpoint phải allow các range này; ngưỡng healthy mặc định: ≥18% checker báo OK.
- Failover PRIMARY bắt buộc có health check (hoặc alias bật Evaluate Target Health); phát hiện lỗi mất khoảng RequestInterval × FailureThreshold (mặc định ~90 giây).
- Multi-value answer KHÔNG thay thế ELB: không giữ connection state, không SSL termination — chỉ là DNS trả nhiều đáp án healthy.
- Migrate DNS sang Route 53: tạo hosted zone, copy record từ provider cũ, hạ TTL trước, cập nhật NS tại registrar, đợi hết TTL cũ rồi mới tắt DNS cũ.
- Trỏ EC2: dùng A record + Elastic IP (alias không hỗ trợ EC2); trỏ ELB/CloudFront: luôn ưu tiên alias (chi tiết ELB ở Chương 6, CloudFront ở Chương 15).
- Chi phí cần nhớ: $0.50/hosted zone/tháng, phí theo triệu query (alias query tới tài nguyên AWS miễn phí), health check tính phí theo tháng theo loại endpoint.
