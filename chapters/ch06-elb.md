# Chương 6: Elastic Load Balancing (ELB)

> **Trọng tâm DVA-C02:** ELB xuất hiện trong đề thi chủ yếu dưới dạng câu hỏi tình huống: chọn đúng loại load balancer (ALB vs NLB), cấu hình routing theo path/host, xử lý sticky sessions làm lệch tải, lấy IP gốc của client qua X-Forwarded-For, SSL termination với SNI, và hành vi của health check / deregistration delay khi deploy. Bạn cũng cần hiểu ELB là nền cho các chương sau: ASG (Chương 7), ECS (Chương 17), Lambda target (Chương 30).

## Mục tiêu chương

- Hiểu cơ chế hoạt động của Elastic Load Balancing: listener, target group, health check, và đường đi của một request từ client đến target.
- Phân biệt rõ 4 loại load balancer (CLB, ALB, NLB, GWLB) — layer hoạt động, tính năng, và tình huống nào chọn loại nào.
- Cấu hình được ALB với listener rules routing theo host, path, query string, HTTP header bằng CLI và SDK JS v3.
- Nắm vững các cơ chế hay thi: sticky sessions, cross-zone load balancing, SSL/TLS termination + SNI, connection draining / deregistration delay.
- Biết cách ứng dụng backend (Node.js/Go) đọc đúng client IP và protocol gốc qua các header `X-Forwarded-*`.
- Tránh được các bẫy thực tế: security group cho ELB, health check sai port, mất session khi scale-in.

## 6.1 Vì sao cần load balancer và ELB hoạt động thế nào

Khi bạn chạy ứng dụng trên nhiều EC2 instance (hoặc container, Lambda), bạn cần một điểm vào duy nhất để:

1. **Phân tải (load distribution):** chia request đến nhiều backend, tránh một máy bị quá tải.
2. **Che giấu hạ tầng:** client chỉ biết một DNS name duy nhất; bạn thêm/bớt instance phía sau tuỳ ý mà không đổi endpoint.
3. **Health check & fault tolerance:** tự động ngừng gửi traffic đến instance hỏng — đây là nền tảng của high availability đa AZ.
4. **SSL termination:** giải mã HTTPS tại load balancer, backend chỉ xử lý HTTP — giảm tải CPU cho instance và quản lý certificate tập trung.
5. **Tách biệt public/private:** ELB nằm ở public subnet, instance nằm ở private subnet không có public IP (kiến trúc 3-tier — chi tiết VPC ở Chương 11).

**Elastic Load Balancing** là dịch vụ managed: AWS lo việc scale chính load balancer, vá lỗi, đảm bảo availability. Bạn không SSH được vào ELB, không chỉnh OS — chỉ cấu hình qua API.

### Các khái niệm cốt lõi

- **Listener:** quy định ELB nhận traffic ở protocol/port nào (ví dụ HTTPS:443). Mỗi listener có một tập **rules** quyết định request được chuyển đi đâu.
- **Target group:** nhóm các đích nhận traffic. Target type có thể là `instance` (EC2 instance ID), `ip` (private IP — dùng cho container, on-premises qua VPN/Direct Connect), `lambda` (chỉ ALB), hoặc `alb` (NLB trỏ vào ALB). Health check được cấu hình **ở mức target group**, không phải ở listener.
- **Availability Zone & ELB nodes:** khi tạo ELB bạn chọn ít nhất 2 AZ (ALB bắt buộc ≥2 AZ; NLB cho phép 1 nhưng không nên). Trong mỗi AZ, AWS dựng các **load balancer node**. DNS name của ELB resolve ra IP của các node này. Hiểu mô hình node-per-AZ là chìa khoá để hiểu cross-zone load balancing ở mục 6.7.

Đường đi của một request qua ALB: client resolve DNS name của ALB → kết nối TCP/TLS đến một ALB node → node parse HTTP request → áp listener rules → chọn target group → chọn một target healthy (thuật toán round robin hoặc least outstanding requests) → mở kết nối riêng đến target và forward request. Lưu ý: với ALB, kết nối client→ALB và ALB→target là **hai kết nối TCP độc lập** (connection termination tại ALB). Với NLB thì khác — xem mục 6.4.

```bash
# Xem DNS name và các AZ của một ALB
aws elbv2 describe-load-balancers \
  --names my-alb \
  --query 'LoadBalancers[0].{DNS:DNSName,AZs:AvailabilityZones[].ZoneName,Scheme:Scheme}'
```

`Scheme` có hai giá trị: `internet-facing` (node có public IP, nằm ở public subnet) và `internal` (chỉ private IP — dùng cho tier nội bộ, ví dụ web tier gọi app tier).

> 💡 **Exam Tip:** ELB luôn được truy cập qua **DNS name** (ví dụ `my-alb-1234567890.us-east-1.elb.amazonaws.com`). ALB **không có static IP** — IP của node thay đổi theo thời gian. Nếu đề bài yêu cầu "static IP per AZ" hoặc "whitelist IP cố định ở firewall đối tác" → đáp án là **NLB** (hoặc đặt NLB trước ALB). Muốn gắn ELB vào apex domain (`example.com`) → dùng **Alias record** của Route 53, không dùng CNAME (chi tiết ở Chương 10).

## 6.2 Bốn loại load balancer: CLB, ALB, NLB, GWLB

AWS có 4 thế hệ/loại load balancer. Để hiểu sự khác nhau, bám vào **OSI layer** mà chúng hoạt động:

| Tiêu chí | CLB (legacy) | ALB | NLB | GWLB |
|---|---|---|---|---|
| Layer | 4 & 7 (lẫn lộn) | 7 (HTTP/HTTPS) | 4 (TCP/UDP/TLS) | 3 (IP packets) |
| Protocol listener | HTTP, HTTPS, TCP, SSL | HTTP, HTTPS, gRPC, WebSocket | TCP, UDP, TLS | IP (GENEVE port 6081) |
| Static IP / Elastic IP | Không | Không | **Có** (1 IP/AZ, gắn EIP được) | Không |
| Routing theo path/host/header | Không | **Có** | Không | Không |
| Target types | Instance | instance, ip, **lambda** | instance, ip, **alb** | instance, ip (appliance) |
| Preserve source IP đến target | Không (dùng header/proxy protocol) | Không (dùng X-Forwarded-For) | **Có** (mặc định với instance target) | Có |
| Hiệu năng | Trung bình | Tốt, scale tự động | **Cực cao, hàng triệu req/s, latency ~100ms → ~µs thấp hơn ALB** | Cao |
| Use case | Hệ thống cũ — AWS khuyên migrate | Web app, microservices, container | Game server, IoT, TCP/UDP thuần, cần IP tĩnh | Firewall, IDS/IPS, deep packet inspection của bên thứ ba |
| Security Group gắn vào LB | Có | **Có** | Có (hỗ trợ từ 2023) | Không |

Chi tiết từng loại:

- **Classic Load Balancer (CLB):** thế hệ cũ (2009), không còn xuất hiện nhiều trong đề ngoài vai trò "đáp án sai". Không hỗ trợ target group — đăng ký instance trực tiếp vào LB; không routing theo path/host; chỉ 1 SSL certificate (không SNI). Nhận diện để loại trừ.
- **Application Load Balancer (ALB):** layer 7, hiểu HTTP. Đây là loại quan trọng nhất với developer — toàn bộ mục 6.3 dành cho nó.
- **Network Load Balancer (NLB):** layer 4, forward TCP/UDP ở tốc độ rất cao. Chi tiết ở mục 6.4.
- **Gateway Load Balancer (GWLB):** layer 3, dùng để chèn các **virtual appliance** của bên thứ ba (firewall, IDS/IPS) vào đường đi của traffic. Hoạt động trên protocol **GENEVE (port 6081)** — đóng gói nguyên IP packet gửi đến fleet appliance, appliance kiểm tra xong trả lại, GWLB forward tiếp về đích. GWLB vừa là transparent gateway (một entry/exit point) vừa là load balancer cho fleet appliance. Với DVA-C02 chỉ cần nhận diện: thấy từ khoá "third-party security appliances", "traffic inspection", "GENEVE" → GWLB.

> 💡 **Exam Tip:** Bảng quyết định nhanh: HTTP routing thông minh / Lambda target / WebSocket / gRPC → **ALB**. Static IP, TCP/UDP thuần, hàng triệu request/giây, latency cực thấp, preserve source IP ở tầng mạng → **NLB**. Firewall/IDS appliance của hãng thứ ba, GENEVE → **GWLB**. Một combo hay gặp: **NLB với target group type `alb`** — khi cần vừa static IP (NLB) vừa HTTP routing (ALB), hoặc dùng cho **AWS PrivateLink** (PrivateLink yêu cầu NLB làm entry point).

## 6.3 ALB chi tiết: target groups, listener rules và routing

### Target groups

Một ALB có thể route đến nhiều target group — đây là cơ sở cho kiến trúc microservices: một ALB duy nhất phục vụ nhiều service, tiết kiệm chi phí so với mỗi service một LB.

Target type của ALB:

- `instance`: đăng ký bằng EC2 instance ID, traffic gửi đến **primary private IP** của instance. Hỗ trợ port override per-target — nền tảng cho dynamic port mapping của ECS (chi tiết ở Chương 17).
- `ip`: đăng ký private IP (trong CIDR của VPC hoặc dải RFC 1918 qua peering/VPN). Không đăng ký được public IP.
- `lambda`: ALB invoke Lambda function với event chứa request HTTP (chi tiết ở Chương 30).

```bash
# Tạo target group cho ALB
aws elbv2 create-target-group \
  --name api-tg \
  --protocol HTTP --port 8080 \
  --vpc-id vpc-0abc123 \
  --target-type instance \
  --health-check-path /healthz \
  --health-check-interval-seconds 15 \
  --healthy-threshold-count 2 \
  --unhealthy-threshold-count 2

# Đăng ký target
aws elbv2 register-targets \
  --target-group-arn arn:aws:elasticloadbalancing:...:targetgroup/api-tg/abc \
  --targets Id=i-0123456789abcdef0,Port=8080
```

### Listener rules — bộ não routing của ALB

Mỗi listener có một danh sách rule được đánh giá theo **priority tăng dần** (số nhỏ chạy trước); rule đầu tiên match sẽ thắng. Luôn có một **default rule** chạy cuối cùng khi không rule nào match.

**Conditions** (điều kiện match) hỗ trợ:

- `host-header`: routing theo hostname — `api.example.com` vs `admin.example.com` (hỗ trợ wildcard `*.example.com`).
- `path-pattern`: routing theo URL path — `/api/*`, `/images/*`.
- `http-request-method`: GET, POST...
- `query-string`: ví dụ `?env=beta`.
- `http-header`: header bất kỳ, ví dụ `X-Tenant: acme`.
- `source-ip`: CIDR của client.

**Actions** (hành động khi match):

- `forward`: chuyển đến 1 hoặc nhiều target group, có thể gán **weight** cho từng group (weighted target groups — dùng cho blue/green hoặc canary ở tầng LB).
- `redirect`: trả HTTP 301/302 — kinh điển là redirect HTTP→HTTPS.
- `fixed-response`: trả response tĩnh (ví dụ 503 + JSON maintenance) mà không cần backend.
- `authenticate-cognito` / `authenticate-oidc`: ALB tự xử lý authentication trước khi forward (Cognito chi tiết ở Chương 38).

```bash
# Rule: path /api/* → target group api-tg, priority 10
aws elbv2 create-rule \
  --listener-arn arn:aws:elasticloadbalancing:...:listener/app/my-alb/xxx/yyy \
  --priority 10 \
  --conditions '[{"Field":"path-pattern","PathPatternConfig":{"Values":["/api/*"]}}]' \
  --actions '[{"Type":"forward","TargetGroupArn":"arn:aws:elasticloadbalancing:...:targetgroup/api-tg/abc"}]'

# Listener HTTP:80 chỉ làm một việc: redirect sang HTTPS
aws elbv2 create-listener \
  --load-balancer-arn arn:aws:elasticloadbalancing:...:loadbalancer/app/my-alb/xxx \
  --protocol HTTP --port 80 \
  --default-actions '[{"Type":"redirect","RedirectConfig":{"Protocol":"HTTPS","Port":"443","StatusCode":"HTTP_301"}}]'
```

Cùng thao tác bằng SDK JS v3:

```javascript
// npm i @aws-sdk/client-elastic-load-balancing-v2
import {
  ElasticLoadBalancingV2Client,
  CreateRuleCommand,
} from "@aws-sdk/client-elastic-load-balancing-v2";

const elbv2 = new ElasticLoadBalancingV2Client({ region: "ap-southeast-1" });

// Canary: 90% traffic vào blue, 10% vào green (weighted target groups)
await elbv2.send(new CreateRuleCommand({
  ListenerArn: listenerArn,
  Priority: 5,
  Conditions: [
    { Field: "host-header", HostHeaderConfig: { Values: ["api.example.com"] } },
  ],
  Actions: [{
    Type: "forward",
    ForwardConfig: {
      TargetGroups: [
        { TargetGroupArn: blueTgArn, Weight: 90 },   // bản ổn định
        { TargetGroupArn: greenTgArn, Weight: 10 },  // bản mới (canary)
      ],
    },
  }],
}));
```

### X-Forwarded-For — lấy thông tin client gốc

Vì ALB terminate kết nối của client rồi mở kết nối mới đến target, **target nhìn thấy source IP là private IP của ALB node**, không phải IP client. ALB bù lại bằng cách chèn 3 header:

- `X-Forwarded-For`: IP thật của client (nếu có proxy phía trước thì là danh sách, IP client đứng trước).
- `X-Forwarded-Proto`: protocol client dùng (`http` hoặc `https`) — quan trọng khi ALB terminate SSL và nói chuyện HTTP với backend; app dựa vào header này để biết có cần redirect HTTPS hay build URL đúng scheme.
- `X-Forwarded-Port`: port client kết nối vào.

```javascript
// Express trên EC2/ECS sau ALB
app.set("trust proxy", true); // để req.ip đọc từ X-Forwarded-For

app.get("/whoami", (req, res) => {
  res.json({
    clientIp: req.headers["x-forwarded-for"]?.split(",")[0].trim(),
    proto: req.headers["x-forwarded-proto"], // "https" nếu client vào qua TLS
  });
});
```

> 💡 **Exam Tip:** Câu hỏi "ứng dụng sau ALB cần log IP thật của client" → đáp án **X-Forwarded-For**. Nếu là **NLB** với target type `instance` thì source IP được giữ nguyên ở tầng TCP — app đọc trực tiếp từ socket, không cần header. Với NLB listener TLS hoặc target type `ip` trong một số cấu hình, dùng **Proxy Protocol v2** để truyền IP gốc.

Hai chi tiết vận hành đáng nhớ với ALB:

- **Security group hai tầng:** SG của target chỉ nên allow port app **từ SG của ALB** (source = sg-của-ALB), không mở 0.0.0.0/0. Đây là pattern chuẩn và là đáp án đúng cho các câu "secure traffic between ALB and instances".
- **HTTP 503 từ ALB** nghĩa là không có target healthy nào trong target group (hoặc rule trỏ vào target group rỗng). **HTTP 502** thường do target trả response không hợp lệ hoặc đóng kết nối đột ngột. Phân biệt 5xx do ALB sinh ra (metric `HTTPCode_ELB_5XX_Count`) với 5xx do target (`HTTPCode_Target_5XX_Count`) là kỹ năng troubleshooting hay thi.

## 6.4 NLB: static IP, TCP/UDP và hiệu năng

NLB hoạt động ở layer 4 — nó không đọc HTTP, chỉ forward TCP/UDP segment. Hệ quả:

- **Hiệu năng cực cao:** xử lý hàng triệu request/giây, latency thấp hơn ALB rõ rệt (NLB ~100µs vs ALB ~400ms ở mức so sánh tương đối thường được trích dẫn — điểm cần nhớ cho đề: NLB = "ultra-low latency, millions of requests per second").
- **Static IP:** NLB có **một IP tĩnh cho mỗi AZ**, và bạn có thể gắn **Elastic IP** của mình vào từng AZ. Đây là điểm khác biệt lớn nhất so với ALB trong đề thi: đối tác cần whitelist IP cố định → NLB.
- **Protocol:** TCP, UDP, TLS. UDP listener phục vụ game server, DNS, syslog, IoT.
- **Flow hashing:** NLB chọn target dựa trên hash của 5-tuple (protocol, source IP/port, dest IP/port) — mọi packet của **cùng một TCP connection** luôn đến cùng một target trong suốt vòng đời connection. Đổi connection mới có thể sang target khác.
- **Preserve source IP:** với target type `instance`, source IP của client được giữ nguyên đến tận target — backend thấy IP thật mà không cần header. Vì vậy security group của target phải allow traffic **từ IP client** (hoặc từ 0.0.0.0/0 đối với dịch vụ public), chứ không phải từ NLB.
- **TLS listener:** NLB cũng terminate TLS được (offload cho backend) với certificate từ ACM, hỗ trợ SNI như ALB.

```bash
# Tạo NLB với Elastic IP cố định mỗi AZ
aws elbv2 create-load-balancer \
  --name game-nlb --type network --scheme internet-facing \
  --subnet-mappings \
    SubnetId=subnet-aaa,AllocationId=eipalloc-111 \
    SubnetId=subnet-bbb,AllocationId=eipalloc-222

# Listener UDP cho game server
aws elbv2 create-listener \
  --load-balancer-arn <nlb-arn> \
  --protocol UDP --port 7777 \
  --default-actions Type=forward,TargetGroupArn=<tg-arn>
```

NLB **không có listener rules** kiểu ALB — mỗi listener forward thẳng vào một target group. Health check của NLB hỗ trợ TCP, HTTP, HTTPS (dù listener là TCP, health check vẫn có thể là HTTP đến endpoint `/healthz` — nên dùng để kiểm tra sâu hơn việc port mở).

> 💡 **Exam Tip:** Từ khoá chọn NLB trong đề: "static IP address per AZ", "Elastic IP", "millions of requests per second", "extreme low latency", "UDP", "TCP passthrough" (backend tự terminate TLS, ví dụ cần mutual TLS end-to-end), "PrivateLink endpoint service". Từ khoá chọn ALB: "path-based routing", "host-based routing", "Lambda target", "redirect HTTP to HTTPS", "authenticate users at the load balancer".

## 6.5 Health checks — cơ chế và tham số

Health check quyết định target có nhận traffic hay không. Cấu hình ở **target group**:

- `HealthCheckProtocol` / `HealthCheckPort` / `HealthCheckPath`: mặc định port là `traffic-port` (chính port của target). Bẫy thực tế: app listen 8080 nhưng health check trỏ port 80 → tất cả target unhealthy → ALB trả 503 toàn bộ.
- `HealthCheckIntervalSeconds`: khoảng cách giữa 2 lần check (mặc định 30s, min 5s).
- `HealthCheckTimeoutSeconds`: chờ response bao lâu.
- `HealthyThresholdCount` / `UnhealthyThresholdCount`: số lần liên tiếp pass/fail để chuyển trạng thái. Ví dụ interval 30s, unhealthy threshold 2 → mất tối đa ~60s để phát hiện instance chết.
- `Matcher`: với ALB, HTTP code được coi là healthy (mặc định `200`, có thể đặt `200-299`).

Trạng thái target (`describe-target-health`): `initial` (đang check lần đầu sau khi đăng ký), `healthy`, `unhealthy`, `draining` (đang deregister — xem 6.9), `unused`, `unavailable`.

```bash
aws elbv2 describe-target-health \
  --target-group-arn <tg-arn> \
  --query 'TargetHealthDescriptions[].{Id:Target.Id,State:TargetHealth.State,Reason:TargetHealth.Reason}'
```

```javascript
// Endpoint health check đúng cách: kiểm tra dependency thiết yếu, trả nhanh
app.get("/healthz", async (req, res) => {
  try {
    await db.ping();              // chỉ check dependency sống còn
    res.status(200).send("ok");   // ALB matcher mặc định: 200
  } catch {
    res.status(503).send("db unreachable");
  }
});
```

Lưu ý thiết kế: đừng nhồi quá nhiều dependency vào health check (gọi cả 5 service downstream) — một service phụ chết kéo cả fleet bị đánh unhealthy, gây outage dây chuyền. Health check của ELB nên trả lời câu hỏi "instance NÀY có phục vụ được request không", không phải "toàn hệ thống có khoẻ không".

Một hành vi quan trọng: nếu **tất cả** target trong một target group đều unhealthy, ALB/NLB chuyển sang chế độ **fail-open** — gửi traffic đến tất cả target (vì gửi đại còn hơn chặn hết). Gặp hiện tượng "target unhealthy mà vẫn nhận request" thì đây là lý do.

> 💡 **Exam Tip:** ELB health check chỉ đánh dấu instance unhealthy và ngừng gửi traffic — **ELB không tự terminate hay thay thế instance**. Việc thay instance hỏng là của **Auto Scaling Group** khi ASG được cấu hình dùng ELB health check (chi tiết ở Chương 7).

## 6.6 Sticky sessions (session affinity)

Mặc định ELB phân phối request không quan tâm client là ai. Nếu app lưu session **trong memory của instance** (stateful), request tiếp theo rơi vào instance khác sẽ mất session. **Sticky sessions** ép mọi request của một client về cùng một target.

Cơ chế trên ALB — bật ở **target group attribute**, dựa trên cookie:

- **Duration-based cookie (`lb_cookie`):** ALB tự sinh cookie tên **`AWSALB`** (CLB dùng `AWSELB`), chứa thông tin target đã mã hoá. `stickiness.lb_cookie.duration_seconds`: từ **1 giây đến 7 ngày (604800s)**, mặc định 1 ngày. Hết hạn → request được phân lại như mới.
- **Application-based cookie (`app_cookie`):** app tự phát cookie với tên do bạn đặt (không được dùng các tên reserved `AWSALB`, `AWSALBAPP`, `AWSALBTG`); ALB sinh kèm cookie `AWSALBAPP-*` để track. Dùng khi cần kiểm soát vòng đời sticky từ phía ứng dụng.

```bash
# Bật duration-based stickiness 1 giờ trên target group
aws elbv2 modify-target-group-attributes \
  --target-group-arn <tg-arn> \
  --attributes \
    Key=stickiness.enabled,Value=true \
    Key=stickiness.type,Value=lb_cookie \
    Key=stickiness.lb_cookie.duration_seconds,Value=3600
```

NLB cũng có stickiness nhưng theo **source IP** (`stickiness.type = source_ip`) vì layer 4 không có cookie.

Trade-off phải nhớ:

- Sticky sessions gây **lệch tải (imbalance)**: vài client "nặng" dính vào một instance làm nó quá tải trong khi instance khác rảnh.
- Khi instance bị scale-in hoặc chết, session trên nó **mất sạch** — sticky không phải giải pháp bền.
- Kiến trúc đúng cho production: **externalize session** ra ElastiCache Redis hoặc DynamoDB (session store pattern — chi tiết ở Chương 9), app trở thành stateless, tắt sticky sessions luôn.

> 💡 **Exam Tip:** Đề tả "users lose their session when instances scale in/out" sẽ có 2 hướng đáp án: (1) bật sticky sessions — chữa cháy nhanh nhưng kèm caveat lệch tải; (2) chuyển session ra **ElastiCache/DynamoDB** — đáp án đúng khi câu hỏi nhấn "most resilient/scalable solution". Đọc kỹ đề hỏi gì.

## 6.7 Cross-zone load balancing

Nhớ lại mô hình node-per-AZ ở mục 6.1. Câu hỏi: một node ở AZ-a nhận request thì nó chia cho target ở AZ nào?

- **Cross-zone BẬT:** mỗi node phân phối đều cho **tất cả target ở mọi AZ**. Kết quả: mỗi target nhận lượng traffic bằng nhau bất kể phân bố instance giữa các AZ.
- **Cross-zone TẮT:** node chỉ gửi cho target **trong AZ của nó**. Nếu AZ-a có 2 instance, AZ-b có 8 instance, mà DNS chia đều 50/50 cho 2 node → mỗi instance ở AZ-a gánh 25% tổng traffic, mỗi instance ở AZ-b chỉ 6.25% — lệch 4 lần.

Cấu hình mặc định và chi phí — bảng phải thuộc:

| | ALB | NLB / GWLB | CLB |
|---|---|---|---|
| Mặc định | **Bật** (ở mức LB, có thể tắt ở mức target group) | **Tắt** | Tắt (API) / Bật (Console) |
| Phí data transfer liên AZ khi bật | **Miễn phí** | **Tính phí** | Miễn phí |

```bash
# Bật cross-zone cho NLB (attribute mức load balancer)
aws elbv2 modify-load-balancer-attributes \
  --load-balancer-arn <nlb-arn> \
  --attributes Key=load_balancing.cross_zone.enabled,Value=true
```

Với ALB, cross-zone mặc định bật ở mức load balancer; từ 2022 có thể override **tắt ở mức target group** (`load_balancing.cross_zone.enabled = false`) cho các kiến trúc muốn cô lập traffic theo AZ (giảm latency liên AZ, zonal isolation).

> 💡 **Exam Tip:** Câu hỏi kinh điển: "instances ở các AZ nhận traffic không đều" → bật **cross-zone load balancing**. Cặp số phải nhớ: ALB mặc định **bật + free**, NLB mặc định **tắt + bật lên thì trả phí inter-AZ data transfer**.

## 6.8 SSL/TLS termination và SNI

### Termination tại load balancer

Mô hình phổ biến: client ↔ ALB dùng HTTPS (listener 443 + certificate từ **AWS Certificate Manager — ACM**, chi tiết ACM ở Chương 48), ALB ↔ target dùng HTTP trong VPC. Lợi ích: backend không tốn CPU cho TLS handshake, certificate quản lý và renew tập trung một chỗ. Nếu compliance yêu cầu mã hoá end-to-end, cấu hình target group protocol HTTPS — ALB sẽ TLS đến target (ALB không validate certificate của target, nên backend dùng self-signed cert được).

```bash
# Listener HTTPS với certificate ACM và security policy TLS hiện đại
aws elbv2 create-listener \
  --load-balancer-arn <alb-arn> \
  --protocol HTTPS --port 443 \
  --certificates CertificateArn=arn:aws:acm:ap-southeast-1:111122223333:certificate/abc-123 \
  --ssl-policy ELBSecurityPolicy-TLS13-1-2-2021-06 \
  --default-actions Type=forward,TargetGroupArn=<tg-arn>
```

`--ssl-policy` (security policy) quy định phiên bản TLS và cipher suite được chấp nhận — đề có thể hỏi "ép tối thiểu TLS 1.2" → chọn security policy phù hợp trên listener, không phải sửa backend.

### SNI — Server Name Indication

Bài toán: một ALB phục vụ nhiều domain (`api.example.com`, `shop.khac.vn`) — mỗi domain một certificate. Làm sao ALB biết trình certificate nào khi TLS handshake xảy ra **trước khi** có HTTP request? **SNI** là extension của TLS: client gửi hostname nó muốn kết nối ngay trong bước ClientHello của handshake; ALB nhìn hostname đó để chọn đúng certificate trong danh sách đã gắn vào listener.

- Một HTTPS listener có **1 default certificate** + nhiều certificate bổ sung qua SNI. ALB hỗ trợ tối đa **25 certificates mỗi listener** (không tính default).
- SNI hoạt động trên **ALB và NLB (TLS listener)**. **CLB không hỗ trợ SNI** — mỗi CLB chỉ 1 certificate; muốn nhiều cert thời CLB phải tạo nhiều CLB.

```bash
# Thêm certificate thứ hai vào listener HTTPS (SNI)
aws elbv2 add-listener-certificates \
  --listener-arn <listener-arn> \
  --certificates CertificateArn=arn:aws:acm:...:certificate/cert-cho-domain-khac
```

> 💡 **Exam Tip:** "Host multiple websites with different TLS certificates on a single load balancer" → **SNI trên ALB/NLB**. Phương án thay thế là 1 certificate chứa nhiều domain (SAN/wildcard), nhưng khi đề nhấn "separate certificates" thì SNI là đáp án. Thấy CLB trong các lựa chọn → sai, vì CLB không có SNI.

## 6.9 Connection draining / Deregistration delay

Khi một target bị **deregister** khỏi target group (do scale-in, deploy, hoặc bạn gọi `deregister-targets`), nếu cắt ngay lập tức thì các request **đang xử lý dở (in-flight)** sẽ chết giữa chừng — client nhận lỗi 5xx. Cơ chế chống việc này:

- Tên gọi: **Connection draining** (thuật ngữ của CLB) = **Deregistration delay** (thuật ngữ của ALB/NLB/target group). Đề dùng lẫn cả hai — hiểu là một.
- Hành vi: khi deregister, target chuyển sang trạng thái **`draining`**: ELB **ngừng gửi request MỚI** đến target ngay lập tức, nhưng giữ các kết nối hiện có để request in-flight chạy nốt, tối đa bằng thời gian deregistration delay.
- Giá trị: mặc định **300 giây**, cấu hình **0–3600 giây**. Đặt 0 = cắt ngay (chỉ phù hợp request siêu ngắn hoặc test). Hết delay, target bị loại hẳn dù connection còn mở (ALB đóng; NLB có thêm attribute connection termination riêng).

```bash
# App xử lý request dài ~90s: hạ delay từ 300s xuống 120s để deploy nhanh hơn
aws elbv2 modify-target-group-attributes \
  --target-group-arn <tg-arn> \
  --attributes Key=deregistration_delay.timeout_seconds,Value=120
```

Chọn giá trị thế nào: lấy thời gian xử lý request **dài nhất** cộng biên an toàn. Request ngắn 1–5s → đặt 30–60s cho deploy/scale-in nhanh; long-polling hoặc upload lớn → giữ cao. Delay quá dài làm scale-in và rolling deploy chậm (mỗi batch chờ hết delay); quá ngắn làm rớt request của user.

Liên quan nhưng khác nhau — đừng nhầm 3 timeout:

| Cơ chế | Mặc định | Ý nghĩa |
|---|---|---|
| Deregistration delay (target group) | 300s | Chờ request in-flight khi target rời nhóm |
| Idle timeout (ALB attribute) | 60s | ALB đóng kết nối không có data qua lại; backend nên đặt keep-alive timeout **lớn hơn** idle timeout của ALB để tránh race condition gây 502 |
| Slow start (target group) | 0 (tắt) | Target mới vào nhận traffic tăng dần trong 30–900s để warm-up cache/JIT |

> 💡 **Exam Tip:** "Users report errors during deployments/scale-in events because in-flight requests are terminated" → **tăng/cấu hình deregistration delay (connection draining)**. "Random 502 errors under normal traffic" → nghi vấn keep-alive timeout của backend **nhỏ hơn** idle timeout của ALB. Hai tình huống khác nhau, hai đáp án khác nhau.

Đến đây bạn đã có đủ lý thuyết ELB cho cả kỳ thi lẫn thực tế. ELB hiếm khi đứng một mình trong đề — nó đi cặp với ASG (health check, scale-in — Chương 7), ECS (dynamic port mapping — Chương 17) và Lambda (ALB target — Chương 30). Phần 2 của chương sẽ là hands-on lab dựng ALB hoàn chỉnh, exam tips tổng hợp và quiz 10 câu.

---

## Hands-on Lab: Triển khai ALB với path-based routing, sticky sessions và tuning deregistration delay

**Mục tiêu lab:** Dựng một Application Load Balancer đứng trước 2 EC2 instances ở 2 AZ khác nhau, cấu hình 2 target groups, listener rules định tuyến theo path (`/api/*` vs mặc định), quan sát health check loại instance lỗi, đọc header `X-Forwarded-For`, bật sticky sessions và giảm deregistration delay — đúng các điểm DVA-C02 hay hỏi.

**Chuẩn bị:**
- AWS CLI v2 đã cấu hình (profile có quyền EC2 + ELB full access).
- Dùng default VPC cho nhanh. Region ví dụ: `ap-southeast-1`.
- Chi phí: ALB ~0.0252 USD/giờ + 2 instance t3.micro — làm xong dọn ngay, tốn dưới 0.5 USD.

### Bước 1: Tạo Security Groups

Tạo 2 SG: một cho ALB (mở 80 từ internet), một cho EC2 (chỉ nhận traffic từ SG của ALB — đây là pattern "SG referencing SG" chuẩn, không mở 80 cho cả thế giới):

```bash
VPC_ID=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text)

ALB_SG=$(aws ec2 create-security-group --group-name lab06-alb-sg \
  --description "ALB SG" --vpc-id $VPC_ID --query GroupId --output text)
aws ec2 authorize-security-group-ingress --group-id $ALB_SG \
  --protocol tcp --port 80 --cidr 0.0.0.0/0

EC2_SG=$(aws ec2 create-security-group --group-name lab06-ec2-sg \
  --description "EC2 SG" --vpc-id $VPC_ID --query GroupId --output text)
# Chỉ cho phép traffic port 80 ĐẾN TỪ security group của ALB
aws ec2 authorize-security-group-ingress --group-id $EC2_SG \
  --protocol tcp --port 80 --source-group $ALB_SG
```

### Bước 2: Khởi chạy 2 EC2 instances ở 2 AZ

User data cài web server trả về instance ID và in ra header nhận được (để soi `X-Forwarded-For`):

```bash
cat > userdata.sh <<'EOF'
#!/bin/bash
dnf install -y httpd php
ID=$(curl -s -H "X-aws-ec2-metadata-token: $(curl -sX PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')" http://169.254.169.254/latest/meta-data/instance-id)
mkdir -p /var/www/html/api
echo "<?php echo 'WEB from ' . '$ID' . ' | client: ' . \$_SERVER['HTTP_X_FORWARDED_FOR'];" > /var/www/html/index.php
echo "<?php echo 'API from ' . '$ID';" > /var/www/html/api/index.php
systemctl enable --now httpd
EOF

AMI=$(aws ssm get-parameter \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --query Parameter.Value --output text)

# Lấy 2 subnet ở 2 AZ khác nhau
SUBNETS=($(aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC_ID \
  --query 'Subnets[0:2].SubnetId' --output text))

for i in 0 1; do
  aws ec2 run-instances --image-id $AMI --instance-type t3.micro \
    --security-group-ids $EC2_SG --subnet-id ${SUBNETS[$i]} \
    --user-data file://userdata.sh \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=lab06-$i}]"
done
```

Lưu lại 2 instance ID (gọi là `$I1`, `$I2`). Chờ trạng thái `running` rồi mới sang bước 3.

### Bước 3: Tạo 2 target groups

```bash
TG_WEB=$(aws elbv2 create-target-group --name lab06-tg-web \
  --protocol HTTP --port 80 --vpc-id $VPC_ID \
  --health-check-path / --health-check-interval-seconds 10 \
  --healthy-threshold-count 2 --unhealthy-threshold-count 2 \
  --query 'TargetGroups[0].TargetGroupArn' --output text)

TG_API=$(aws elbv2 create-target-group --name lab06-tg-api \
  --protocol HTTP --port 80 --vpc-id $VPC_ID \
  --health-check-path /api/index.php \
  --query 'TargetGroups[0].TargetGroupArn' --output text)

aws elbv2 register-targets --target-group-arn $TG_WEB --targets Id=$I1 Id=$I2
aws elbv2 register-targets --target-group-arn $TG_API --targets Id=$I1 Id=$I2
```

Lưu ý: một instance đăng ký được vào nhiều target group cùng lúc — mỗi target group có health check riêng.

### Bước 4: Tạo ALB và listener mặc định

```bash
ALB_ARN=$(aws elbv2 create-load-balancer --name lab06-alb \
  --subnets ${SUBNETS[0]} ${SUBNETS[1]} --security-groups $ALB_SG \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text)

LISTENER=$(aws elbv2 create-listener --load-balancer-arn $ALB_ARN \
  --protocol HTTP --port 80 \
  --default-actions Type=forward,TargetGroupArn=$TG_WEB \
  --query 'Listeners[0].ListenerArn' --output text)

DNS=$(aws elbv2 describe-load-balancers --load-balancer-arns $ALB_ARN \
  --query 'LoadBalancers[0].DNSName' --output text)
echo $DNS
```

ALB cần tối thiểu 2 subnet ở 2 AZ khác nhau — đây là lý do ta lấy 2 subnet ở bước 2. Chờ state chuyển từ `provisioning` sang `active` (1–3 phút):

```bash
aws elbv2 describe-load-balancers --load-balancer-arns $ALB_ARN \
  --query 'LoadBalancers[0].State.Code'
```

### Bước 5: Thêm listener rule định tuyến theo path

```bash
aws elbv2 create-rule --listener-arn $LISTENER --priority 10 \
  --conditions Field=path-pattern,Values='/api/*' \
  --actions Type=forward,TargetGroupArn=$TG_API
```

Rule có priority 10 được đánh giá trước default rule (default luôn đánh giá CUỐI CÙNG). Priority nhỏ hơn = ưu tiên cao hơn.

### Bước 6: Kiểm tra routing, health check và X-Forwarded-For

```bash
for i in {1..6}; do curl -s http://$DNS/ ; echo; done
```

Output mong đợi — request luân phiên (round robin) giữa 2 instance, và thấy IP public của máy bạn trong `X-Forwarded-For` (vì ALB terminate connection, IP nguồn mà EC2 thấy là private IP của ALB node):

```
WEB from i-0abc... | client: 118.70.x.x
WEB from i-0def... | client: 118.70.x.x
```

```bash
curl -s http://$DNS/api/
# API from i-0abc...
```

Xem trạng thái health check:

```bash
aws elbv2 describe-target-health --target-group-arn $TG_WEB \
  --query 'TargetHealthDescriptions[].{Id:Target.Id,State:TargetHealth.State}'
```

Output mong đợi: cả 2 target `healthy`. Giờ giả lập sự cố — SSH/SSM vào instance 1 chạy `sudo systemctl stop httpd`, chờ ~20 giây (interval 10s × unhealthy threshold 2), chạy lại lệnh trên: instance 1 chuyển `unhealthy` với Reason `Target.FailedHealthChecks`, và `curl` lúc này chỉ trả về instance 2. Bật lại `httpd`, sau 2 lần check pass nó quay lại nhận traffic. Đây chính là cơ chế "fail open có kiểm soát" mà đề thi hay mô tả.

### Bước 7: Bật sticky sessions

```bash
aws elbv2 modify-target-group-attributes --target-group-arn $TG_WEB \
  --attributes Key=stickiness.enabled,Value=true \
    Key=stickiness.type,Value=lb_cookie \
    Key=stickiness.lb_cookie.duration_seconds,Value=120
```

Test với cookie jar:

```bash
for i in {1..5}; do curl -s -c /tmp/cj -b /tmp/cj http://$DNS/ ; echo; done
```

Output mong đợi: cả 5 request đều trả về CÙNG một instance ID. Kiểm tra cookie: `grep AWSALB /tmp/cj` — bạn sẽ thấy cookie `AWSALB` (và `AWSALBCORS`) do ALB phát hành. Nếu curl không gửi cookie (bỏ `-b`), request lại round robin như cũ — sticky session hoạt động hoàn toàn dựa trên cookie phía client.

### Bước 8: Tuning deregistration delay và quan sát draining

Mặc định deregistration delay là 300 giây — quá dài cho lab. Giảm xuống 30 giây rồi deregister 1 target:

```bash
aws elbv2 modify-target-group-attributes --target-group-arn $TG_WEB \
  --attributes Key=deregistration_delay.timeout_seconds,Value=30

aws elbv2 deregister-targets --target-group-arn $TG_WEB --targets Id=$I1
aws elbv2 describe-target-health --target-group-arn $TG_WEB \
  --query 'TargetHealthDescriptions[].{Id:Target.Id,State:TargetHealth.State}'
```

Output mong đợi: instance 1 ở trạng thái `draining` trong 30 giây — không nhận request MỚI nhưng request đang dở (in-flight) vẫn được hoàn thành — rồi biến mất khỏi danh sách. Đây là connection draining (tên cũ ở CLB) / deregistration delay (tên mới ở ALB/NLB).

### Dọn dẹp tài nguyên

Thứ tự quan trọng: xoá ALB trước, rồi target groups, rồi instances, cuối cùng là SG (SG của EC2 đang reference SG của ALB nên phải xoá sau khi cả hai không còn được dùng):

```bash
aws elbv2 delete-load-balancer --load-balancer-arn $ALB_ARN
# Chờ ~1 phút cho ALB xoá xong rồi mới xoá target group
aws elbv2 delete-target-group --target-group-arn $TG_WEB
aws elbv2 delete-target-group --target-group-arn $TG_API
aws ec2 terminate-instances --instance-ids $I1 $I2
aws ec2 wait instance-terminated --instance-ids $I1 $I2
aws ec2 delete-security-group --group-id $EC2_SG
aws ec2 delete-security-group --group-id $ALB_SG
```

Kiểm tra lại console EC2 → Load Balancers và Target Groups để chắc chắn không còn gì chạy ngầm.

## 💡 Exam Tips chương 6

- **ALB = Layer 7** (HTTP/HTTPS, routing theo path/host/header/query string), **NLB = Layer 4** (TCP/UDP/TLS, hiệu năng hàng triệu rps, latency ~100ms thấp hơn ALB ~400ms). Câu hỏi nói "HTTP routing", "microservices theo path" → ALB; nói "extreme performance", "static IP", "non-HTTP protocol" → NLB.
- Chỉ **NLB có static IP** (1 IP/AZ) và gắn được **Elastic IP**. ALB chỉ có DNS name — nếu đề yêu cầu "whitelist IP cố định cho firewall đối tác" → NLB (hoặc đặt NLB trước ALB).
- Ứng dụng cần IP thật của client sau ALB: đọc header **`X-Forwarded-For`** (kèm `X-Forwarded-Proto`, `X-Forwarded-Port`). Với NLB TCP, source IP được giữ nguyên nên không cần header.
- **Sticky sessions**: ALB dùng cookie — `AWSALB` (duration-based, do LB sinh) hoặc **application-based cookie** (app tự sinh, khai báo tên cookie). Trade-off: gây mất cân bằng tải. Đề hỏi "user bị logout khi request rơi vào instance khác" → bật stickiness, hoặc giải pháp chuẩn hơn là externalize session ra ElastiCache/DynamoDB (chi tiết ở Chương 9).
- **Cross-zone load balancing**: ALB bật mặc định và **miễn phí** liên AZ; NLB/GWLB tắt mặc định, bật thì **tốn phí** data transfer liên AZ. Câu hỏi "traffic phân bố không đều giữa các AZ có số instance lệch nhau" → bật cross-zone.
- **SNI (Server Name Indication)** cho phép một listener HTTPS phục vụ **nhiều TLS certificate** cho nhiều domain — chỉ hỗ trợ trên ALB và NLB, KHÔNG có trên CLB. Đề nói "host nhiều domain với nhiều cert trên một LB" → ALB/NLB + SNI; nếu thấy CLB trong đáp án thì câu trả lời thường là "tạo nhiều CLB" (tốn kém) hoặc migrate sang ALB.
- **SSL termination tại ALB**: ALB giải mã TLS rồi forward HTTP (hoặc re-encrypt HTTPS) tới target. Nếu yêu cầu **end-to-end encryption** mà không cần LB đọc nội dung → NLB TCP listener passthrough, cert nằm trên EC2.
- **Deregistration delay** (mặc định 300s, 0–3600s): target chuyển `draining`, ngừng nhận request mới, request in-flight được chạy nốt. Đề hỏi "deployment làm rớt request đang xử lý" → tăng/kiểm tra deregistration delay; "deregister quá lâu" → giảm xuống (set 0 nếu request ngắn).
- Health check fail phổ biến vì: SG của instance không cho phép traffic **từ SG của ALB**, sai health check path/port, app trả 3xx khi check mong 200. Matcher có thể cấu hình range, ví dụ `200-299`.
- ALB target types: **instance**, **ip** (IP private — dùng cho on-premises qua VPN/DX, hoặc ECS awsvpc), **lambda** (chỉ ALB có). NLB còn nhận **alb** làm target (chain NLB → ALB để có static IP + Layer 7 routing).
- **GWLB** = Layer 3, dùng giao thức **GENEVE port 6081**, chuyên cho chuỗi appliance bảo mật (firewall, IDS/IPS) — thấy từ khoá "inspect traffic bằng third-party virtual appliance" là chọn GWLB, đừng chọn NLB.
- ALB trả **HTTP 503** khi không còn target healthy/không có target đăng ký; **504 Gateway Timeout** khi target không phản hồi trong idle timeout — phân biệt hai mã này là dạng câu troubleshooting kinh điển.

## Quiz chương 6 (10 câu)

**Câu 1.** Một công ty chạy REST API trên nhóm EC2 instances sau load balancer. Đối tác yêu cầu cung cấp địa chỉ IP cố định để cấu hình firewall outbound của họ. Giải pháp nào phù hợp nhất?
- A. Dùng ALB và cung cấp IP resolve từ DNS name của ALB
- B. Dùng NLB, gắn Elastic IP cho mỗi AZ và cung cấp các IP này
- C. Dùng CLB với sticky sessions
- D. Đặt CloudFront trước ALB và cung cấp IP của edge location

**Câu 2.** A developer needs to... định tuyến request `https://api.example.com/orders/*` đến microservice Orders và `https://api.example.com/users/*` đến microservice Users, cả hai chạy trên cùng một fleet EC2. Cách cấu hình nào đúng?
- A. Hai NLB riêng, mỗi NLB cho một service
- B. Một ALB, hai target groups, listener rules theo path pattern
- C. Một ALB, một target group, dùng health check path khác nhau
- D. Route 53 weighted routing giữa hai CLB

**Câu 3.** Ứng dụng Node.js sau ALB ghi log địa chỉ client nhưng toàn thấy IP dạng `10.0.x.x`. Developer cần IP thật của người dùng. Giải pháp?
- A. Bật cross-zone load balancing
- B. Chuyển listener từ HTTP sang TCP
- C. Đọc header `X-Forwarded-For` trong ứng dụng
- D. Bật access logs trên ALB và query sau

**Câu 4.** Một ứng dụng lưu session trong bộ nhớ local của EC2. Sau khi đặt sau ALB, user phàn nàn bị văng đăng nhập ngẫu nhiên. Cách khắc phục NHANH nhất, ít thay đổi code nhất?
- A. Bật sticky sessions trên target group
- B. Chuyển session sang DynamoDB
- C. Tăng số lượng instance
- D. Giảm deregistration delay xuống 0

**Câu 5.** Công ty có 2 AZ: AZ-a chạy 8 instances, AZ-b chạy 2 instances sau một NLB. Team nhận thấy 2 instance ở AZ-b chịu tải cao gấp 4 lần. Nguyên nhân và cách xử lý?
- A. Health check sai port; sửa health check
- B. Cross-zone load balancing đang tắt (mặc định với NLB); bật nó lên
- C. Sticky sessions đang bật; tắt đi
- D. NLB không hỗ trợ nhiều AZ; chuyển sang ALB

**Câu 6.** A developer needs to... phục vụ nhiều website với domain khác nhau (`a.com`, `b.com`), mỗi domain một TLS certificate riêng, trên MỘT load balancer duy nhất để tiết kiệm chi phí. Giải pháp?
- A. CLB với nhiều listener HTTPS
- B. ALB với một listener HTTPS, nhiều certificate, dựa vào SNI
- C. ALB với wildcard certificate `*.com`
- D. Bắt buộc phải tạo mỗi domain một ALB

**Câu 7.** Trong quá trình rolling deployment, người dùng báo lỗi vì các request đang xử lý dở bị cắt khi instance bị gỡ khỏi target group. Thuộc tính nào cần xem xét?
- A. Health check interval
- B. Idle timeout của ALB
- C. Deregistration delay (connection draining)
- D. Stickiness duration

**Câu 8.** Một game online dùng giao thức UDP custom cần xử lý hàng triệu request/giây với độ trễ cực thấp. Load balancer nào phù hợp?
- A. ALB
- B. NLB
- C. GWLB
- D. CLB

**Câu 9.** ALB trả về HTTP 503 cho mọi request dù các EC2 instances đang chạy bình thường và ứng dụng listen trên port 80. Nguyên nhân khả dĩ nhất?
- A. ALB chưa bật cross-zone load balancing
- B. Tất cả target đều unhealthy vì security group của instance không cho phép traffic từ security group của ALB
- C. Thiếu Elastic IP trên ALB
- D. Listener đang dùng HTTPS thay vì HTTP

**Câu 10.** Công ty cần kiểm tra (inspect) toàn bộ inbound traffic bằng một virtual firewall appliance của bên thứ ba trước khi traffic đến ứng dụng. Dịch vụ nào được thiết kế cho việc này?
- A. ALB với Lambda target
- B. NLB ở chế độ TLS passthrough
- C. Gateway Load Balancer (GWLB)
- D. CloudFront với field-level encryption

### Đáp án & giải thích

**Câu 1 — Đáp án B.** NLB cung cấp 1 static IP cho mỗi AZ và cho phép gắn Elastic IP — đáp ứng yêu cầu IP cố định. A sai vì IP resolve từ DNS của ALB thay đổi theo thời gian (ALB scale node bên dưới), không bao giờ được hardcode. C sai: CLB cũng không có static IP, sticky sessions không liên quan. D sai: IP edge của CloudFront rất nhiều và thay đổi, không phù hợp để whitelist từng IP cố định.

**Câu 2 — Đáp án B.** ALB là Layer 7, hỗ trợ listener rules với path pattern (`/orders/*`, `/users/*`) forward đến target groups khác nhau — đúng pattern microservices. A sai: NLB Layer 4 không nhìn thấy URL path, và 2 LB tốn gấp đôi chi phí. C sai: health check path chỉ quyết định target healthy hay không, không định tuyến request. D sai: weighted routing chia traffic theo tỉ lệ ngẫu nhiên, không theo nội dung URL; CLB cũng không hỗ trợ path routing.

**Câu 3 — Đáp án C.** ALB terminate kết nối client nên backend thấy IP private của ALB node; IP gốc nằm trong header `X-Forwarded-For`. A sai: cross-zone chỉ ảnh hưởng phân bố traffic giữa AZ. B sai: ALB không có TCP listener (đó là NLB), và đổi kiến trúc là quá mức cần thiết. D sai: access logs giúp phân tích offline nhưng không giải quyết nhu cầu ứng dụng đọc IP lúc runtime.

**Câu 4 — Đáp án A.** Sticky sessions (lb_cookie) ghim user vào đúng instance giữ session — chỉ là một thuộc tính target group, không sửa code. B là giải pháp ĐÚNG về kiến trúc lâu dài nhưng đề hỏi "nhanh nhất, ít thay đổi code nhất" — chuyển session store đòi sửa code đáng kể. C sai: thêm instance còn làm tình hình tệ hơn. D sai: deregistration delay liên quan lúc gỡ target, không liên quan session.

**Câu 5 — Đáp án B.** NLB tắt cross-zone mặc định: mỗi AZ nhận ~50% traffic (DNS chia đều theo AZ), nên 2 instance AZ-b gánh 50% traffic → mỗi con chịu 25%, gấp ~4 lần mỗi con trong 8 con của AZ-a (6.25%). Bật cross-zone để phân đều trên 10 instance (lưu ý phí liên AZ với NLB). A sai: health check sai thì target unhealthy, không gây lệch tải kiểu này. C sai: NLB stickiness (source IP) không tạo pattern lệch đều 4 lần như vậy. D sai: NLB hỗ trợ multi-AZ bình thường.

**Câu 6 — Đáp án B.** ALB hỗ trợ gắn nhiều certificate vào một listener HTTPS; SNI cho phép client gửi hostname trong TLS handshake để ALB chọn đúng cert. A sai: CLB không hỗ trợ SNI — mỗi CLB chỉ một cert, phải tạo nhiều CLB. C sai: `*.com` không phải wildcard hợp lệ (wildcard chỉ áp dụng một cấp subdomain của MỘT domain, ví dụ `*.a.com`); `a.com` và `b.com` là hai domain khác nhau. D sai vì B đã chứng minh một ALB là đủ.

**Câu 7 — Đáp án C.** Deregistration delay cho target thời gian ở trạng thái `draining` để hoàn thành request in-flight trước khi bị gỡ. Nếu set quá thấp (hoặc 0) với các request dài, kết nối bị cắt giữa chừng. A sai: health check interval quyết định tốc độ phát hiện unhealthy, không bảo vệ request đang chạy. B sai: idle timeout đóng kết nối KHÔNG có dữ liệu, khác với việc gỡ target. D sai: stickiness liên quan định tuyến session, không liên quan draining.

**Câu 8 — Đáp án B.** NLB là lựa chọn duy nhất hỗ trợ UDP, hoạt động ở Layer 4, xử lý hàng triệu request/giây với latency cực thấp. A sai: ALB chỉ HTTP/HTTPS (TCP), không hỗ trợ UDP. C sai: GWLB dành cho traffic inspection qua appliance (GENEVE), không phải load balancing ứng dụng game. D sai: CLB legacy, không hỗ trợ UDP và hiệu năng kém hơn.

**Câu 9 — Đáp án B.** 503 từ ALB nghĩa là không có target healthy để forward. Lỗi phổ biến nhất: SG của EC2 không allow inbound từ SG của ALB nên health check fail dù app chạy tốt — "instance chạy bình thường" nhưng ALB không gọi tới được. A sai: cross-zone không gây 503 toàn bộ. C sai: ALB không dùng Elastic IP. D sai: listener HTTPS sai cấu hình thường gây lỗi TLS phía client hoặc 4xx, và đề nói rõ request đã đến được ALB.

**Câu 10 — Đáp án C.** GWLB sinh ra đúng cho use case này: hoạt động Layer 3, đóng gói traffic bằng GENEVE (port 6081) gửi qua fleet appliance bảo mật để inspect rồi trả về, kết hợp Gateway Load Balancer Endpoint. A sai: Lambda target dùng để chạy code xử lý HTTP request, không phải inspect packet. B sai: NLB passthrough chỉ chuyển tiếp TCP/TLS, không có cơ chế service chaining qua appliance. D sai: field-level encryption mã hoá field nhạy cảm ở edge, không phải traffic inspection.

## Tóm tắt chương

- ELB có 4 loại: **CLB** (legacy, tránh dùng), **ALB** (Layer 7 — HTTP/HTTPS), **NLB** (Layer 4 — TCP/UDP/TLS, hiệu năng cao), **GWLB** (Layer 3 — GENEVE 6081, security appliances).
- ALB routing theo **path, host, HTTP header, query string, source IP**; listener rules đánh giá theo priority tăng dần, default rule cuối cùng; target types: instance / ip / lambda.
- NLB có **static IP per AZ + Elastic IP**, giữ nguyên source IP của client (TCP), latency thấp hơn ALB; có thể đặt ALB làm target của NLB để có cả static IP lẫn Layer 7 routing.
- Backend sau ALB lấy thông tin client qua **`X-Forwarded-For` / `X-Forwarded-Proto` / `X-Forwarded-Port`**.
- **Health checks** cấu hình ở target group (path, port, interval, threshold, matcher như `200-299`); target unhealthy bị loại khỏi rotation cho tới khi pass đủ healthy threshold; lỗi phổ biến nhất là SG của target không allow traffic từ SG của ALB.
- **Sticky sessions**: cookie `AWSALB` (duration-based) hoặc application-based cookie; giải quyết session in-memory nhưng gây lệch tải — giải pháp chuẩn là external session store (Chương 9).
- **Cross-zone load balancing**: ALB bật sẵn và miễn phí; NLB/GWLB tắt mặc định, bật thì trả phí data transfer liên AZ — câu hỏi lệch tải giữa AZ gần như luôn xoay quanh điểm này.
- **SSL/TLS termination** tại ALB/NLB với certificate từ ACM; **SNI** cho phép nhiều cert trên một listener (ALB/NLB, không có ở CLB); cần end-to-end encryption không bị LB giải mã → NLB TCP passthrough.
- **Deregistration delay** (mặc định 300s, range 0–3600s): target ở trạng thái `draining` để hoàn thành request in-flight; tune theo độ dài request của ứng dụng.
- Troubleshooting mã lỗi: **503** = không còn target healthy/không có target; **504** = target không trả lời kịp idle timeout.
- ELB kết hợp Auto Scaling Group để tự thêm/bớt target theo tải (chi tiết ở Chương 7); ALB còn là entry point phổ biến cho ECS dynamic port mapping (Chương 17) và Lambda target (Chương 30).
