# Autovideo

App desktop Windows: Fastify + SQLite + React. Dùng hướng dẫn này cho Codex, Claude Code và Antigravity.

- Sản phẩm chỉ là app desktop: vỏ Tauri (`src-tauri/`) chạy server Node làm sidecar ở 127.0.0.1 và hiển thị trang planner (`web/planner.html`). Không có bản web, không mở cổng ra mạng LAN, không có mã truy cập. Build: `npm run build:app`. Xem `PLAN-windows-exe.md` mục 13.
- Job AI (`analyze_brief`, `edit_plan`, `clip_plan`, `html_compose`, `revise_prompt`) do worker văn bản nhúng (`worker/src/text-main.ts`) xử lý; server tự chạy nó. Không còn worker legacy (Claude Code gọi API theo curl) hay worker điều khiển Chrome (ChatGPT/Flow).
- Giao diện app làm theo thiết kế trong `docs/design/` (đọc `docs/design/README.md` trước khi sửa `web/`): bố cục, chữ, trạng thái lấy từ thiết kế; màu lấy từ token trong `web/src/planner/desktop.css`.
- Quy tắc viết prompt/video dùng chung: `video-production-rules.md`.
- Không đọc/in token đăng nhập vào chat; không đưa secret vào Git, checkpoint, log hoặc asset metadata.
- Không sửa migration đã chạy. Thêm migration mới và kiểm tra với DB cũ, foreign key check, integrity check.
- Sau thay đổi runtime: `npm test`, `npm run typecheck`, `npm run build`. Dùng DB tạm khi kiểm thử, không gọi inference thật từ test.
- Giao diện và API của app nằm ở listener planner (`server/src/lan/`, route `/lan/api/*`, chỉ nghe 127.0.0.1): không đăng ký/import route của API chính vào đó. Mọi việc render/xoá logo đi qua hàng đợi render chung (chạy song song tối đa `RENDER_CONCURRENCY`, mặc định 2); mọi chỗ giả định "một việc đang chạy" (hủy, khởi động lại, đếm hàng đợi, idle, ưu tiên) phải đúng với N việc. Host/Origin/CSP vẫn giữ để chống DNS rebinding.
