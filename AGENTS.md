# Autovideo

Ứng dụng local Fastify + SQLite + React; worker giao tiếp qua API. Dùng hướng dẫn này cho Codex, Claude Code và Antigravity.

- Quy tắc viết prompt/video dùng chung: `video-production-rules.md`.
- Chỉ chạy worker nhận job khi người dùng yêu cầu sản xuất video. Việc sửa mã không đồng nghĩa được phép bấm Generate.
- `WORKER.md` mô tả nghiệp vụ. `docs/ai/OPERATIONS.md` mô tả managed worker, account pool và lease. Lệnh curl legacy không dùng được cho job managed.
- Mọi thao tác tốn credit cần job đã được duyệt. Không tự tạo lại khi kết quả submit chưa rõ.
- Không đọc/in token đăng nhập vào chat; không đưa secret vào Git, checkpoint, log hoặc asset metadata.
- Không sửa migration đã chạy. Thêm migration mới và kiểm tra với DB cũ, foreign key check, integrity check.
- Sau thay đổi runtime: `npm test`, `npm run typecheck`, `npm run build`. Dùng DB/profile tạm khi kiểm thử, không gọi inference hay Flow thật từ test.
- Mốc trước account pool: tag `before-account-pool-20261021`, nhánh `main`. Xem `docs/ai/ROLLBACK.md` trước khi quay về vì schema mới cần DB backup tương ứng.
- Trang planner LAN (`LAN_ENABLED`, `server/src/lan/`) là listener riêng chỉ có route planner: không đăng ký/import route của app chính vào đó, không để nó tạo job storyboard/video (chỉ `analyze_brief` và `edit_plan`). Bước 3 (video tải lên), bản hoàn chỉnh LAN và công cụ Xoá logo Veo cũng nằm trong `server/src/lan/` + `services/lan-*.ts`; mọi việc render/xoá logo đi qua hàng đợi render chung (chạy song song tối đa `RENDER_CONCURRENCY`, mặc định 2; việc của app trước việc LAN, không ngắt việc đang chạy). Mặc định trang LAN không cần mã truy cập (`LAN_REQUIRE_CODE=false`); Host/Origin/CSP, rate limit theo IP, trần hàng đợi và danh sách file vẫn giữ. Mọi chỗ giả định "một việc đang chạy" (hủy, khởi động lại, đếm hàng đợi, idle, ưu tiên) phải đúng với N việc. Xem `docs/ai/OPERATIONS.md` (mục LAN) và `server/API.md` mục 13.
