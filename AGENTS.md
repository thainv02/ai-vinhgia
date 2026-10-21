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
