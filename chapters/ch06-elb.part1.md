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
