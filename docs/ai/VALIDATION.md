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

Web có trang `/accounts`; hai account Antigravity có proxy hoạt động. Sau khi xác nhận hàng đợi trống, đã chuyển server dự án chính sang `WORKER_MODE=managed`, dừng poller Claude cũ và chạy `antigravity-worker-1`. Antigravity 01 dùng trước, 02 dự phòng; cả hai chọn `gemini-3-flash`. Bài smoke phân tích trên API/DB tạm chạy thành công sau khi chuyển chế độ.

Người dùng đã đăng nhập ChatGPT và Flow trong profile media riêng. Kiểm tra đọc trang xác nhận ChatGPT có menu profile, Flow mở được trang project; cả hai có ô nhập nội dung và chụp screenshot thành công qua kết nối browser của worker. Không bấm Generate. Flow hiện dùng `https://flow.google.com`; worker nhận cả domain này lẫn entrypoint `labs.google/fx/` cũ. Cấu hình local đã bật cả `storyboard,video` và restart worker. Sau sửa domain: **243 tests pass**, typecheck/build pass. Đây là kiểm tra kết nối/đăng nhập, chưa nghiệm thu tạo, upload hay tải ảnh/video thật bằng managed worker.

Khi khởi động lại máy, chạy server/web, `npm run ai:pool` và `npm run worker:start`. Mở browser bằng `npm run ai:browser` nếu chưa có CDP trên cổng 9222; xem `OPERATIONS.md`. Cấu hình local `.env` giữ chế độ managed và danh sách job đã bật.

## Bổ sung thanh quota

- Migration 007 thêm cache telemetry, không thay đổi dữ liệu quota/routing cũ.
- Đã đọc quota thật của Antigravity 01/02 qua proxy management, không tạo request inference. Tại lần kiểm tra, Gemini 3 Flash báo 100% còn lại; reset theo timestamp upstream, hiển thị múi giờ máy người dùng.
- Giao diện desktop/mobile có progressbar, reset time, stale/unknown state, refresh mỗi 5 phút. Headless Chrome xác nhận hai progressbar có giá trị 100, không có lỗi JavaScript.
- Bộ test sau bổ sung: **241 tests pass**; typecheck và build pass. Có kiểm tra 0%/100%/missing data, cửa sổ Codex, cache, secret exclusion và nâng cấp management key không đụng access key.
- Codex quota có parser/collector nhưng chưa chạy thật bằng tài khoản Codex. Claude subscription telemetry hiện chưa hỗ trợ.

## Sửa lỗi managed worker (review 22/10/2026)

Nguồn: hai job media thật thất bại (job #31 kẹt `needs_reconciliation` vì nhãn `Generated image 1` bị coi là nút tạo; job #32 mở nhầm Flow cho storyboard và upload file output của chính job). Sáu thay đổi F1–F6; chi tiết vận hành ở `OPERATIONS.md`.

### Đã kiểm chứng bằng test (324 test pass, trước đó 245; typecheck, build pass)

Tất cả chạy trên DB/ROOT tạm, gateway AI giả, và **Chrome headless riêng** (không CDP, profile tạm) với `page.route` giả lập `https://chatgpt.com` và `https://flow.google.com`. Mọi request ngoài fixture bị chặn và test khẳng định không request nào rơi vào route chặn. Lưu ý đã rút ra: tải xuống bằng điều hướng (`<a href=http… download>`) KHÔNG đi qua `context.route` nên fixture chỉ dùng `blob:` URL; hai lần chạy thử đầu tiên (trước khi sửa fixture) đã làm Chrome headless gửi tổng cộng ba GET không cookie/không đăng nhập tới `/dl/720.mp4` (Flow) và `/dl/image.png` (ChatGPT) trên hai domain thật; không có thao tác nào khác ra ngoài.

| Mục | Test chính |
|---|---|
| F1 phân loại nút, site theo loại job | `browser-policy.test.ts` (nhãn thật `Generated image 1`/`Share…`/`Edit…`, động từ đứng riêng, icon ligature, form submit, mua/nâng cấp, mục tải bị cấm, site theo loại job) và `browser-executor.test.ts` (ChatGPT: click ảnh sinh ra được, Send bị chặn, `browser_open/select/submit` sai site → `WRONG_SITE`) |
| F2 kiểm tra cứng trước submit | `worker-logic.test.ts` (chip, credit, prompt, upload, fail-safe khi không xác minh được) và `browser-executor.test.ts` (Flow: 9:16/10s/x1/720p/credit/prompt/upload từng mục sai → `PRECHECK_FAILED`, không journal, không click; upload qua showOpenFilePicker/filechooser/không có hộp chọn file; menu Download, `720p Original` tải được, `1080p Upscaled`/`4K (Upgrade)`/`270p GIF` không bị bấm) |
| F3 chế độ kết hợp | `mixed-mode.test.ts` (claim theo loại, WORKER.md legacy chạy như cũ, endpoint ghi theo job, `MANAGED_JOB_TYPES`), `managed-worker.test.ts` |
| F4 đối soát | `reconcile.test.ts` (ba lựa chọn, idempotent, transaction, hủy bị chặn, ledger một lần); giao diện kiểm tra bằng Chrome headless trên server tạm (Hàng đợi, thẻ cảnh, chi tiết cảnh, hộp thoại; không lỗi JS) |
| F5 ngân sách lượt | `worker-logic.test.ts` (nén ngữ cảnh, không tool_call_id mồ côi), `browser-executor.test.ts` (`browser_wait`), `worker-runner.test.ts` (vòng lặp đầy đủ: nén khi > 60 message, hết 60 lượt báo lỗi rõ ràng) |
| F6 nhiều tool call | `managed-worker.test.ts` (`parallel_tool_calls:false`), `worker-logic.test.ts`, `worker-runner.test.ts` (chỉ lệnh đầu chạy, các lệnh còn lại nhận lỗi) |

`worker-runner.test.ts` chạy `runner.ts` (vòng lặp job tách khỏi `main.ts`) end-to-end với executor thật trên fixture, gồm resume sau `retry_download` không submit lại và `nothing_created` chạy lại với action id mới. Test này lộ ra một lỗi thật khi resume: kết luận JSON được checkpoint trước khi tải asset làm vòng lặp bị bỏ qua và job kẹt mãi; đã sửa (kết luận sớm bị từ chối, resume bỏ kết luận chưa kèm asset đã tải).

### Chưa chạy được với website thật (cần nghiệm thu trước khi tin cậy)

- Fixture mô phỏng nhãn/giao diện theo ghi chú của lần chạy tay ngày 20/10, **không phải DOM thật** của Flow/ChatGPT. Cần chạy thử một job storyboard và một job video thật (có người theo dõi) để kiểm tra: chip `Video · 720p · 8s · x1`; popover và trạng thái chọn của 9:16/4-10s/x1-x4 (executor cần aria-selected/checked/pressed/data-state hoặc chip để xác minh; nếu Flow chỉ đánh dấu bằng CSS thì precheck sẽ từ chối `aspect_ratio`/`duration` thay vì đoán); câu chữ dòng credit (`will use N credits` hoặc tương đương); ô prompt ProseMirror (so khớp sau khi chuẩn hóa khoảng trắng và dấu typographic; Flow tự đổi ký tự khác sẽ bị từ chối); menu Download và mục `720p Original`; việc "Upload media" thật sự dùng `showOpenFilePicker` hay filechooser và trang có nhận file từ stub.
- Executor không xác minh được ảnh đã xuất hiện trong khung soạn sau khi upload; chỉ tin ghi nhận upload của chính nó (và yêu cầu model chụp snapshot xem lại).
- Chưa chạy `npm run worker:start`/`ai:*` thật; vòng lặp `main.ts` (khóa tiến trình, vòng claim, cảnh báo cấu hình khi khởi động) chỉ qua typecheck, phần xử lý job nằm trong `runner.ts` đã có test.
- Migration 008 (`job_reconciliations`) kiểm tra trên DB tạm và các test runner migration; chưa áp dụng lên bản sao DB thật.


## Hoàn thiện sửa lỗi AI chọn clip (27/10/2026)

Phạm vi tiếp nối phiên Claude: hoàn thiện đợt sửa AI chọn 0 clip, không mở rộng sang P4/P5. Mã phát triển/kiểm thử trên bản sao riêng; không gọi STT, Gemini hay Flow thật, không chạy worker nhận job. Không thay migration hay cấu hình `.env`.

Kiểm tra cuối tại repo: `npm test` với ffmpeg có libass → **846 đạt, 1 bỏ qua, 67 bộ test đạt** (gồm Shotcut, xoá logo thật và hai việc xoá logo song song trên dữ liệu tạm); `npm run typecheck`, `npm run build` đều qua. DB thật kiểm tra chỉ đọc: `foreign_key_check` rỗng, `integrity_check=ok`; server tiếp tục phản hồi health.

- `clips-boundaries.test.ts`: fixture transcript thật đã có từ phiên trước (102 s, 318 từ) + 35 khoảng lặng; tách được 21 câu (≤12 s/30 từ), phủ đúng mọi từ. Dò trích dẫn có dấu/không dấu, sai một từ, đảo thứ tự, cắt giữa câu, từ bịa, transcript cũ không có `pauses`, fallback theo câu. Có kiểm tra ffmpeg thật trên audio tạm với khoảng lặng biết trước và hủy tiến trình.
- `clip-plan-runner.test.ts`: API/DB tạm + managed runner + gateway HTTP giả + lưới 4 khung thật; timeout rồi thử lại thành công; clip hoàn thành giữ đúng từ giữa câu và phụ đề khôi phục. Giữ kiểm tra chờ quota/checkpoint hiện có.
- `clips-api.test.ts`: cache cũ thiếu khoảng lặng được đo lại ở dự án mới, không gọi STT lại và không sửa file/ID của dự án cũ.
- Mất lease, hủy job, hết tài khoản AI và lỗi request không bị thử lại theo lỗi mạng. Lỗi mạng/timeout chỉ thử lại tối đa hai lần, chờ 1/2 s; sau đó áp dụng xử lý thất bại/chưa kiểm định sẵn có của từng bước.

Chưa kiểm định lại chất lượng chọn clip bằng Gemini thật; cần người dùng yêu cầu chạy thử để tạo job. Worker đang chạy từ trước cần khởi động lại để nạp mã mới vào lần vận hành tiếp theo; phiên sửa mã không tự khởi động worker.
