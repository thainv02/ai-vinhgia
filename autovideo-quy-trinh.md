# Autovideo — sơ đồ quy trình và tính năng

Ngày đối chiếu: 09/11/2026 (vẽ 27/10/2026, cập nhật nhãn 09/11/2026: storyboard/video do worker nền gọi Muse/Google Flow, bỏ credit và account pool, thêm tab Autovideo LAN). Phạm vi: các tính năng đã có trong mã hiện tại, không khẳng định mọi tích hợp đã được nghiệm thu hoặc đang bật trong cấu hình chạy.

- [Bản xem tương tác](autovideo-quy-trinh.html): mở bằng trình duyệt, 6 tab, kéo/phóng to, tìm kiếm trong trang hiện tại, Enter chuyển kết quả. Bấm ô liên kết ở trang tổng quan để mở quy trình tương ứng. HTML tự chứa các hình và biểu tượng, không cần máy chủ.
- [Nguồn chỉnh sửa bằng Draw.io](autovideo-quy-trinh.drawio).
- [Ảnh tổng quan](autovideo-quy-trinh.png).

## Các trang

1. Tổng quan: app chủ máy, trang LAN (Autovideo, kế hoạch prompt, cắt clip, xoá logo) và ba luồng tạo video theo cảnh, highlight từ video dài, xoá logo độc lập.
2. Video theo cảnh: yêu cầu → AI chia cảnh → duyệt storyboard → worker nền tạo storyboard (Muse hoặc Google Flow) → xem → chọn dịch vụ và duyệt video → worker nền tạo video → xem/chọn video → bản hoàn chỉnh. Có sửa prompt, ghi chú theo timecode và tạo lại sau duyệt.
3. Kế hoạch prompt LAN: AI lên kế hoạch, người dùng tự thao tác ChatGPT/Flow rồi tải ảnh/video lên; chỉ dựng bản hoàn chỉnh khi người dùng bấm. Dự án kế hoạch prompt không tạo job storyboard/video. Tab Autovideo (tạo storyboard/video bằng worker nền của chủ máy) chưa có trang sơ đồ riêng; xem `docs/ai/OPERATIONS.md` mục Trang LAN.
4. Bản hoàn chỉnh: edit_plan → EDL → render → xoá logo nếu bật → chỉnh màu nếu có → phiên bản MP4. Sửa điểm cắt, góp ý AI và chỉnh màu tay/ảnh mẫu/LUT có nhánh xử lý khác nhau.
5. Video dài → clip: STT nội bộ gipformer, khoảng lặng và mốc từ, AI chọn/kiểm định đoạn hoặc chọn tay, sửa phụ đề, chọn khung, dựng và tải MP4/SRT/ZIP. Bám mặt và chỉnh màu/góp ý AI riêng cho clip là phần chưa triển khai.
6. Quản lý/vận hành: hàng đợi worker và hàng đợi render, worker managed (AI API) và worker nền ảnh/video (Muse2API/Flow2API), thư viện ảnh, lịch sử/xuất file, đối soát, thùng rác, chia sẻ LAN và cập nhật tiến độ.

## Căn cứ trong mã

| Nhóm | Nguồn đối chiếu |
|---|---|
| Trang và chức năng app | `web/src/App.tsx`, `web/src/components/Layout.tsx` |
| Trang và chức năng LAN | `web/src/planner/App.tsx`, `server/src/lan/app.ts`, `server/src/lan/routes*.ts` |
| Cảnh, duyệt và sửa | `server/src/services/scenes.ts`, `server/src/services/rules.ts`, `server/API.md` mục 5.3–5.4 |
| Planner LAN, ảnh/video tải lên | `server/src/services/lan-plans.ts`, `server/src/services/lan-video.ts`, `server/API.md` mục 13 |
| Bản dựng, màu, phiên bản | `server/src/services/final-cuts.ts`, `server/src/services/final-revisions.ts`, `server/src/services/final-render/`, `server/API.md` mục 5.7, 5.9 |
| Highlight, STT, phụ đề | `server/src/services/clips/`, `worker/src/clip-plan.ts`, `web/src/clips/`, `server/API.md` mục 14 |
| Worker, hàng đợi | `worker/src/runner.ts`, `worker/src/media/`, `server/src/services/managed.ts`, `server/src/services/ai/`, `server/src/services/job-queue.ts`, `docs/ai/OPERATIONS.md` |
| Xoá logo độc lập | `server/src/lan/routes-tools.ts`, `server/src/services/lan-tools.ts` |
| Thùng rác | `server/src/services/trash.ts`, `web/src/pages/TrashPage.tsx` |

Tạo bằng skill `drawio-skill` tại `/Users/thainv/.claude/skills-src/drawio-skill/skills/drawio-skill/SKILL.md`; xuất cục bộ bằng draw.io Desktop 31.0.2. Biểu tượng OpenAI từ lobe-icons (MIT), dùng để nhận diện ChatGPT. Không gọi inference, không tạo job và không sửa runtime ứng dụng.
