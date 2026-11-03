# Mẫu Video HTML

Mỗi thư mục `<id>/` gồm `meta.json` (`id`, `label`, `description`, `aspects`, `variables`) và `index.html` (+ tuỳ chọn `compositions/*.html`, `assets/css|js`).
Một bộ file dùng cho cả ba tỉ lệ: server thay chỗ giữ chỗ khi dựng payload job (`services/html/templates.ts`):
`{{w}}` `{{h}}` (canvas gốc 360×640 / 640×360 / 360×360), `{{aspect}}` (lớp CSS `a-p` | `a-l` | `a-s`), `{{d}}` thời lượng, `{{d:0.4}}` = d×0.4, `{{r:0.4}}` = d − làm tròn(d×0.4).
CSS rẽ nhánh theo lớp `a-*` của phần tử gốc. Văn bản có `data-hf-var` phải trùng giá trị của biến trong `meta.json` (test kiểm tra). Mẫu chỉ là điểm xuất phát cho AI;
đường dẫn `__hf/gsap.min.js` do server cấp. Test: `server/test/html-compose-templates.test.ts` (lint cả 3 tỉ lệ; dựng MP4 thật khi có `HTML_RENDERER_BROWSER`).
