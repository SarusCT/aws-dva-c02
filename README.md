# Giáo trình ôn luyện AWS Certified Developer – Associate (DVA-C02)

Giáo trình tiếng Việt 50 chương (~250.000 từ), từ cơ bản đến nâng cao: lý thuyết sâu + code AWS SDK JS v3 / CLI v2 + hands-on lab + exam tips + quiz 10 câu mỗi chương + bộ đề mô phỏng 65 câu.

## Cấu trúc

```
aws-dva-c02/
├── MUC-LUC.md          # Mục lục 50 chương kèm phạm vi chi tiết
├── STYLE-GUIDE.md      # Quy chuẩn biên soạn
├── chapters/           # Nội dung: ch01-*.md → ch50-*.md
└── web/                # Trang web đọc giáo trình
```

## Đọc trên web

```bash
cd aws-dva-c02
python3 -m http.server 8386
# rồi mở http://localhost:8386/web/
```

Tính năng: sidebar 10 phần / 50 chương, tìm kiếm (`/`), dark/light, đánh dấu chương đã học, đáp án quiz tự gập, chuyển chương bằng phím `←` `→`, nút ⎙ để in/xuất PDF từng chương.

## Xuất PDF toàn bộ (tuỳ chọn, cần pandoc)

```bash
brew install pandoc basictex   # lần đầu
cd aws-dva-c02
pandoc chapters/ch*.md -o giao-trinh-aws-dva-c02.pdf \
  --toc --toc-depth=2 -V geometry:margin=2cm \
  --pdf-engine=xelatex -V mainfont="Times New Roman"
```
