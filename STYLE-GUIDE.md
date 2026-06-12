# STYLE GUIDE — Giáo trình AWS Certified Developer Associate (DVA-C02)

Tài liệu này là quy chuẩn BẮT BUỘC cho mọi chương trong giáo trình.

## Đối tượng người đọc
- Backend developer (Node.js, Golang) đã biết lập trình, mới hoặc đang làm quen AWS.
- Mục tiêu: thi đậu AWS Certified Developer – Associate (DVA-C02) VÀ làm việc thực tế được trên AWS.
- Người đọc thích nội dung kỹ thuật SÂU — không viết hời hợt, không liệt kê suông. Mỗi khái niệm phải giải thích cơ chế bên dưới, khi nào dùng, khi nào KHÔNG dùng, và bẫy thường gặp.

## Ngôn ngữ
- Viết bằng tiếng Việt. Thuật ngữ kỹ thuật GIỮ NGUYÊN tiếng Anh (ví dụ: "visibility timeout", "eventual consistency", "provisioned concurrency") — giải thích nghĩa bằng tiếng Việt ở lần xuất hiện đầu tiên.
- Giọng văn: như senior engineer hướng dẫn đồng nghiệp — thẳng, rõ, có ví dụ thực tế, thỉnh thoảng chỉ ra war story / lỗi hay gặp trong production.
- KHÔNG viết kiểu marketing ("AWS tuyệt vời", "dịch vụ mạnh mẽ"...). Đi thẳng vào kỹ thuật.

## Cấu trúc file mỗi chương (2 phần, do 2 agent viết)

### Phần 1 — Lý thuyết (file `chXX-<slug>.part1.md`, ~3200–3800 từ)
```markdown
# Chương XX: <Tên chương>

> **Trọng tâm DVA-C02:** <2-3 câu: chủ đề này chiếm dạng câu hỏi gì trong đề thi>

## Mục tiêu chương
- <4-6 bullet mục tiêu học được>

## XX.1 <Section lý thuyết đầu tiên>
...
## XX.2 ...
(5–9 section lý thuyết, đi từ cơ bản đến nâng cao)
```
- Mỗi section: giải thích cơ chế → ví dụ cụ thể → code/CLI minh hoạ → bẫy/lưu ý.
- Code ví dụ: ưu tiên **AWS SDK for JavaScript v3 (Node.js)** và **AWS CLI v2**. Thỉnh thoảng nhắc Go SDK v2 nếu phù hợp. Code phải chạy được, có comment tiếng Việt ngắn gọn.
- Chèn các khối exam tip ngay trong lý thuyết khi gặp điểm thi hay hỏi:
  `> 💡 **Exam Tip:** ...`
- Dùng bảng so sánh khi có ≥2 lựa chọn tương tự (ví dụ ALB vs NLB, SQS vs Kinesis).
- Số liệu limits/quotas quan trọng cho đề thi phải nêu chính xác (ví dụ: Lambda timeout max 15 phút, SQS message size 256KB...).

### Phần 2 — Lab, Quiz & Tổng kết (file `chXX-<slug>.part2.md`, ~1800–2400 từ)
```markdown
## Hands-on Lab: <tên lab>
**Mục tiêu lab:** ...
**Chuẩn bị:** ...
### Bước 1: ...
(các bước chi tiết, lệnh CLI/console cụ thể, có output mong đợi)
### Dọn dẹp tài nguyên
(luôn có — tránh tốn tiền)

## 💡 Exam Tips chương XX
- <8-12 tip cô đọng, đúng kiểu câu hỏi DVA-C02>

## Quiz chương XX (10 câu)
**Câu 1.** ...
- A. ...
- B. ...
- C. ...
- D. ...
(đủ 10 câu, độ khó tương đương đề thật, có câu tình huống "A developer needs to...")

### Đáp án & giải thích
**Câu 1 — Đáp án B.** <giải thích vì sao B đúng VÀ vì sao A/C/D sai>
...

## Tóm tắt chương
- <8-12 bullet tóm tắt ý chính>
```

## Quy tắc chống trùng lặp
- Đọc `MUC-LUC.md` để biết phạm vi chương mình viết và các chương lân cận. KHÔNG viết lấn sang phạm vi chương khác — chỉ nhắc tham chiếu: "(chi tiết ở Chương YY)".

## Định dạng
- Markdown chuẩn GitHub. Heading cấp 1 chỉ dùng 1 lần (tên chương, ở part1).
- Code block luôn ghi ngôn ngữ: ```bash, ```javascript, ```json, ```yaml.
- Không dùng emoji ngoài 💡 cho exam tip.
