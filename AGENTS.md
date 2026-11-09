# Autovideo

Ứng dụng local Fastify + SQLite + React; mọi worker giao tiếp với server qua API. Hướng dẫn này dùng chung cho Codex, Claude Code và Antigravity. Luồng đang chạy thật và bản đồ tài liệu: `README.md`.

## Luồng hiện tại

- Việc văn bản (`analyze_brief`, `revise_prompt`, `edit_plan`, `clip_plan`) do managed worker `npm run worker:start` làm qua AI API dùng chung. Giao thức lease: `docs/ai/OPERATIONS.md`.
- Storyboard và video do worker nền `npm run worker:media` (`worker/src/media/`, id `media-api-1`) làm qua API, theo dịch vụ người dùng chọn (`payload.generator.provider`): `muse` → luật trong `WORKER-MUSE.md`, `flow` → `WORKER-FLOW.md` (Flow2API không có idempotency: không gửi lại cùng lượt). Không dùng Chrome, ChatGPT hay Flow trên trình duyệt.
- Ảnh storyboard Google Flow được server xoá logo Gemini khi worker `complete` (`services/storyboard-logo.ts`); worker không tự xoá.
- Agent chỉ chạy vòng lặp worker tay (`WORKER.md` + `WORKER-MUSE.md`/`WORKER-FLOW.md`) khi người dùng yêu cầu. Server giao mỗi job cho đúng một worker, nhưng tài khoản Muse chỉ chạy một task một lúc nên chạy song song với `media-api-1` dễ lỗi. Lệnh curl legacy không dùng được cho job managed.
- `video-production-rules.md` được managed worker nạp nguyên văn vào mọi job văn bản. Sửa file này là đổi hành vi AI khi chạy thật.

## Luật

- Chỉ chạy worker nhận job khi người dùng yêu cầu sản xuất video. Việc sửa mã không đồng nghĩa được phép bấm Generate.
- Mọi thao tác tạo ảnh/video cần job đã được duyệt. Không tự tạo lại khi kết quả submit chưa rõ.
- Không đọc/in token đăng nhập hay API key vào chat; không đưa secret vào Git, checkpoint, log hoặc asset metadata.
- Không sửa migration đã chạy. Thêm migration mới và kiểm tra với DB cũ, foreign key check, integrity check.
- Sau thay đổi runtime: `npm test`, `npm run typecheck`, `npm run build`. Dùng DB/profile tạm khi kiểm thử, không gọi inference, Muse hay Flow thật từ test.
- App chạy `tsx watch` từ repo: sửa mã server là khởi động lại server và chạy migration trên DB thật. Sửa lớn thì làm trên bản sao và chỉ đồng bộ về khi hàng đợi rảnh.
- Mốc trước account pool: tag `before-account-pool-20261021`, nhánh `main`. Xem `docs/ai/ROLLBACK.md` trước khi quay về vì schema mới cần DB backup tương ứng.

## Trang LAN

- Listener riêng (`LAN_ENABLED`, `server/src/lan/`) chỉ có route LAN: không đăng ký/import route của app chính vào đó.
- Kế hoạch prompt (`lan_mode='plan'`) không được tạo job storyboard/video; chỉ `analyze_brief` và `edit_plan`.
- Tab Autovideo (`lan_mode='auto'`, `services/lan-auto.ts`, `lan/routes-auto.ts`) tạo job storyboard/video qua đúng dịch vụ duyệt của app chính, có công tắc `LAN_AUTOVIDEO`, hạn mức theo IP, trần 20 job và luôn xếp sau việc của chủ máy (`LAN_MEDIA_LAST`).
- Bước tải video lên, bản hoàn chỉnh LAN và công cụ Xoá logo Veo nằm trong `server/src/lan/` + `services/lan-*.ts`. Mọi việc render/xoá logo đi qua hàng đợi render chung (song song tối đa `RENDER_CONCURRENCY`, mặc định 2; việc của app trước việc LAN, không ngắt việc đang chạy).
- Mặc định không cần mã truy cập (`LAN_REQUIRE_CODE=false`); Host/Origin/CSP, rate limit theo IP, trần hàng đợi và danh sách file vẫn giữ.
- Mọi chỗ giả định "một việc đang chạy" (hủy, khởi động lại, đếm hàng đợi, idle, ưu tiên) phải đúng với N việc.
- Chi tiết: `docs/ai/OPERATIONS.md` (mục Trang LAN) và `server/API.md` mục 13.
