# Kiểm chứng ngày 21/10/2026

## Mốc khôi phục

- Baseline: `fbde9e2`, tag `before-account-pool-20261021`, nhánh `main`; 217 test pass trước thay đổi.
- Archive workspace và SQLite snapshot nhất quán nằm trong `../autovideo-local-backups/before-account-pool-20261021/`, quyền owner-only.
- `after-account-pool.db` cùng thư mục là snapshot sau triển khai, gồm metadata hai tài khoản mới. Credential OAuth nằm riêng ngoài repo; không nằm trong Git.
- Thử migration 005 trên bản sao DB baseline thật: giữ nguyên dữ liệu của 11 bảng gốc, `foreign_key_check` sạch, `integrity_check=ok`. Migration 006 chỉ bổ sung fingerprint identity; các test runner kiểm tra thứ tự và tính idempotent.

## Gateway và tài khoản thật

- Cài CLIProxyAPI v8.0.37, commit `ce07d189`, darwin aarch64; `--help` và local API hoạt động.
- Archive SHA256 được kiểm tra với checksums release: `7f2432cf34e587bc0e49e8e96247e797928dc6219b5f76b6f2b85835bd64c42f`.
- Antigravity 01 và 02 đăng nhập bằng hai tài khoản Google khác nhau, store/cổng/refresh owner riêng.
- Catalog tại thời điểm probe có 8 model; chọn `gemini-3-flash` cho hai tài khoản. Catalog không được coi là bằng chứng quyền truy cập model khác.
- Cả hai account đều hoàn thành bài thử phân tích một brief: job `done`, một cảnh `awaiting_approval`. Không tạo ảnh/video, không tiêu credit Flow.
- Bài thử `npm run ai:smoke -- 2 --fallback`: gateway A giả lập trả 429/quota, account 02 thực hiện inference thật và hoàn thành job. Bằng chứng attempts: `quota_exhausted → ok → ok` (lượt ok thứ hai sửa định dạng JSON). Không cố đốt hết quota của tài khoản thật để kích hoạt lỗi.
- API/database của smoke được tạo tạm và xóa khi xong; không thêm cảnh thử vào dự án đang chạy. Báo cáo local gần nhất: `.ai-local/last-smoke.json` (ignored).

## Kiểm tra tự động và giao diện

- `npm test`: 235 tests, gồm các test cũ và kiểm tra failover, shared quota scope, lease fencing, checkpoint, action intent, complete idempotent, chống ghi credit hai lần, duplicate login, bảo vệ admin session và chống click Generate qua tool upload/download.
- `npm run typecheck`: server, web, worker.
- `npm run build`: web production build và kiểm tra server/worker.
- Headless Chrome mở `/accounts` ở 1440px và 390px; trang tải được hai account, không có lỗi JavaScript. Form responsive; bảng dùng cuộn ngang ở màn hình nhỏ.
- Các kiểm tra Shotcut/FFmpeg/watermark hiện có vẫn chạy trong bộ test.

## Phạm vi chưa xác nhận bằng chạy thật

- Codex: đã có adapter, CLI login/device flow và store riêng; chưa đăng nhập/chạy inference Codex thật trong phiên triển khai này.
- Claude: giữ đường worker native legacy; gateway/API credential bên ngoài có contract hỗ trợ. Không chạy thử proxy subscription Claude.
- Browser managed cho ChatGPT/Flow: đã có executor, profile riêng và action journal; **chưa chạy tạo ảnh/video thật** bằng worker mới. Upload, download và thay đổi UI của website cần nghiệm thu trước khi dùng cho một dự án lớn.
- EDL managed đã có ảnh lưới 4 fps có quy ước thời gian; pipeline render backend cũ có test. Chưa nghiệm thu chất lượng điểm cắt qua model thật trên dự án hiện tại.
- Pool tài khoản ChatGPT/Flow và chuyển credit media thuộc P6, chưa triển khai. Inference pool không tự bổ sung credit Flow.
- Khả năng quota độc lập giữa hai Google accounts chưa được khẳng định. Nếu provider dùng chung quota scope, cần cấu hình scope tương ứng.
- Refresh token dài hạn sau nhiều giờ/ngày và qua hết một chu kỳ reset quota chưa được nghiệm thu.

## Trạng thái vận hành hiện tại

Web có trang `/accounts`; hai account Antigravity có proxy hoạt động. Server dự án chính giữ `WORKER_MODE=legacy` do video job #27 đang được worker Claude giữ và gửi heartbeat tại thời điểm triển khai. Managed smoke chạy riêng đã xác nhận code path hoạt động.

Khi đã drain/đối soát công việc cũ, đặt `WORKER_MODE=managed`, restart server, chạy `npm run ai:pool` và `npm run worker:start`. Nếu dùng browser, đăng nhập ChatGPT/Flow trong profile media riêng trước; xem `OPERATIONS.md`. Chưa bật managed browser tự tạo video trên dự án đang chạy.
