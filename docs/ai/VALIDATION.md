# Nhật ký kiểm chứng

Ghi theo đợt và theo ngày; mỗi mục phản ánh trạng thái tại thời điểm ghi. Hiện trạng vận hành: [OPERATIONS.md](OPERATIONS.md) mục Hiện trạng.

## Mốc khôi phục (account pool, 21/10/2026)

- Baseline: `fbde9e2`, tag `before-account-pool-20261021`, nhánh `main`; 217 test pass trước thay đổi.
- Archive workspace và SQLite snapshot nhất quán nằm trong `../autovideo-local-backups/before-account-pool-20261021/`, quyền owner-only.
- `after-account-pool.db` cùng thư mục là snapshot sau triển khai, gồm metadata hai tài khoản mới. Credential OAuth nằm riêng ngoài repo; không nằm trong Git.
- Thử migration 005 trên bản sao DB baseline thật: giữ nguyên dữ liệu của 11 bảng gốc, `foreign_key_check` sạch, `integrity_check=ok`. Migration 006 chỉ bổ sung fingerprint identity; các test runner kiểm tra thứ tự và tính idempotent.

## Gateway và tài khoản thật (account pool, 21/10/2026)

- Cài CLIProxyAPI v8.0.37, commit `ce07d189`, darwin aarch64; `--help` và local API hoạt động.
- Archive SHA256 được kiểm tra với checksums release: `7f2432cf34e587bc0e49e8e96247e797928dc6219b5f76b6f2b85835bd64c42f`.
- Antigravity 01 và 02 đăng nhập bằng hai tài khoản Google khác nhau, store/cổng/refresh owner riêng.
- Catalog tại thời điểm probe có 8 model; chọn `gemini-3-flash` cho hai tài khoản. Catalog không được coi là bằng chứng quyền truy cập model khác.
- Cả hai account đều hoàn thành bài thử phân tích một brief: job `done`, một cảnh `awaiting_approval`. Không tạo ảnh/video, không tiêu credit Flow.
- Bài thử `npm run ai:smoke -- 2 --fallback`: gateway A giả lập trả 429/quota, account 02 thực hiện inference thật và hoàn thành job. Bằng chứng attempts: `quota_exhausted → ok → ok` (lượt ok thứ hai sửa định dạng JSON). Không cố đốt hết quota của tài khoản thật để kích hoạt lỗi.
- API/database của smoke được tạo tạm và xóa khi xong; không thêm cảnh thử vào dự án đang chạy. Báo cáo local gần nhất: `.ai-local/last-smoke.json` (ignored).

## Kiểm tra tự động và giao diện (account pool, 21/10/2026)

- `npm test`: 235 tests, gồm các test cũ và kiểm tra failover, shared quota scope, lease fencing, checkpoint, action intent, complete idempotent, chống ghi credit hai lần, duplicate login, bảo vệ admin session và chống click Generate qua tool upload/download.
- `npm run typecheck`: server, web, worker.
- `npm run build`: web production build và kiểm tra server/worker.
- Headless Chrome mở `/accounts` ở 1440px và 390px; trang tải được hai account, không có lỗi JavaScript. Form responsive; bảng dùng cuộn ngang ở màn hình nhỏ.
- Các kiểm tra Shotcut/FFmpeg/watermark hiện có vẫn chạy trong bộ test.

## Phạm vi chưa xác nhận bằng chạy thật (account pool, 21/10/2026)

- Codex: đã có adapter, CLI login/device flow và store riêng; chưa đăng nhập/chạy inference Codex thật trong phiên triển khai này.
- Claude: giữ đường worker native legacy; gateway/API credential bên ngoài có contract hỗ trợ. Không chạy thử proxy subscription Claude.
- Browser managed cho ChatGPT/Flow: đã có executor, profile riêng và action journal; **chưa chạy tạo ảnh/video thật** bằng worker mới. Upload, download và thay đổi UI của website cần nghiệm thu trước khi dùng cho một dự án lớn.
- EDL managed đã có ảnh lưới 4 fps có quy ước thời gian; pipeline render backend cũ có test. Chưa nghiệm thu chất lượng điểm cắt qua model thật trên dự án hiện tại.
- Pool tài khoản ChatGPT/Flow và chuyển credit media thuộc P6, chưa triển khai. Inference pool không tự bổ sung credit Flow.
- Khả năng quota độc lập giữa hai Google accounts chưa được khẳng định. Nếu provider dùng chung quota scope, cần cấu hình scope tương ứng.
- Refresh token dài hạn sau nhiều giờ/ngày và qua hết một chu kỳ reset quota chưa được nghiệm thu.

## Trạng thái vận hành ngày 21/10/2026 (đã cũ)

> Đã thay đổi: inference đi qua AI API dùng chung, trang `/accounts` đã bỏ, storyboard/video do worker nền `media-api-1` làm qua API. Đoạn dưới giữ làm lịch sử.

Web có trang `/accounts`; hai account Antigravity có proxy hoạt động. Sau khi xác nhận hàng đợi trống, đã chuyển server dự án chính sang `WORKER_MODE=managed`, dừng poller Claude cũ và chạy `antigravity-worker-1`. Antigravity 01 dùng trước, 02 dự phòng; cả hai chọn `gemini-3-flash`. Bài smoke phân tích trên API/DB tạm chạy thành công sau khi chuyển chế độ.

Người dùng đã đăng nhập ChatGPT và Flow trong profile media riêng. Kiểm tra đọc trang xác nhận ChatGPT có menu profile, Flow mở được trang project; cả hai có ô nhập nội dung và chụp screenshot thành công qua kết nối browser của worker. Không bấm Generate. Flow hiện dùng `https://flow.google.com`; worker nhận cả domain này lẫn entrypoint `labs.google/fx/` cũ. Cấu hình local đã bật cả `storyboard,video` và restart worker. Sau sửa domain: **243 tests pass**, typecheck/build pass. Đây là kiểm tra kết nối/đăng nhập, chưa nghiệm thu tạo, upload hay tải ảnh/video thật bằng managed worker.

Khi khởi động lại máy, chạy server/web, `npm run ai:pool` và `npm run worker:start`. Mở browser bằng `npm run ai:browser` nếu chưa có CDP trên cổng 9222; xem `OPERATIONS.md`. Cấu hình local `.env` giữ chế độ managed và danh sách job đã bật.

## Bổ sung thanh quota (account pool, 21/10/2026)

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
| F2 kiểm tra cứng trước submit | `worker-logic.test.ts` (chip, prompt, upload, fail-safe khi không xác minh được; từ 04/11/2026 không còn đối chiếu dòng credit) và `browser-executor.test.ts` (Flow: 9:16/10s/x1/720p/prompt/upload từng mục sai → `PRECHECK_FAILED`, không journal, không click; upload qua showOpenFilePicker/filechooser/không có hộp chọn file; menu Download, `720p Original` tải được, `1080p Upscaled`/`4K (Upgrade)`/`270p GIF` không bị bấm) |
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

## Làm gọn lời nói trong clip (2026-10-27)

Bổ sung đề xuất tiếng đệm/nói vấp/nói lại, nghe thử và duyệt riêng; render cắt cả hình/tiếng và tính lại ASS/SRT. Không chạy worker sản xuất, không gọi inference/Flow thật, không dựng lại video cúm.

- `clips-cleanup.test.ts`: 16 kiểm tra gồm ID/câu trích/độ chắc chắn, từ có nội dung bị gán nhầm filler, khoảng chồng, phần nói lại cần giữ, giới hạn tổng bỏ, retime cả từ gộp/ẩn; API + managed runner với inference giả, worker cũ không nhận cleanup, checkpoint/complete replay không ghi đè lựa chọn đã duyệt, undo và chống stale/ABA. Video ffmpeg thật kiểm tra hình đã bỏ ở giữa, có/không audio; snapshot hàng đợi giữ đúng điểm bỏ và chữ phụ đề dù người dùng đổi trước khi ffmpeg chạy, bản v1 giữ nguyên khi dựng v2.
- `clips-lan.test.ts`: thêm kiểm tra cách ly app/LAN, hạn mức AI và trần hàng đợi, đề xuất chưa tự áp dụng, duyệt riêng, không lộ file nguồn/đường dẫn máy chủ.
- Migration 015: DB 014 tạm có clip/cut cũ giữ nguyên dữ liệu. Kiểm tra thêm trên bản sao riêng của DB hiện tại: hash các cột cũ của cả 24 bảng không đổi, `foreign_key_check` rỗng, `integrity_check=ok`; bản sao đã được xoá sau kiểm tra.
- Chrome headless riêng, API/DB/video tạm và chặn mọi request ngoài localhost: desktop/mobile, nghe thử, duyệt, tải lại trang giữ lựa chọn, hoàn tác, không tràn ngang; không lỗi JavaScript hoặc request ngoài. Nghe thử trên nguồn dùng thao tác tua qua đoạn bỏ, không thay thế kiểm tra file dựng.
- Kiểm tra cuối tại workspace: `AUTOVIDEO_TEST_LIBASS_FFMPEG=/Users/thainv/miniconda3/envs/lab-adsvideo/bin/ffmpeg npm test -- -- --maxWorkers=4` → **863 đạt, 1 bỏ qua, 68 bộ test đạt**. `npm run typecheck`, `npm run build`, `git diff --check` đều qua. Các bài tích hợp Shotcut/xoá logo thật chạy trên media/DB tạm cũng qua.
- Hai lượt chạy mặc định trước đó có lỗi phụ thuộc tải máy ở test có sẵn: dò PID con trong `final-watermark.test.ts`, rồi timeout 30s khi dựng ba bản trong `clips-render.test.ts`. Lượt giới hạn 4 worker hoàn tất sạch; không đổi renderer xoá logo, timeout hay nội dung các bài kiểm tra này.

Ở mốc kiểm thử ban đầu này chưa chạy model thật; lần chạy thực tế 2026-10-28 được ghi bên dưới. AI chỉ thấy những gì STT nhận dạng, nên có thể bỏ sót âm đệm bị STT lược bỏ. Cần khởi động lại server/managed worker để nạp mã mới khi dùng; server sao lưu DB trước migration, worker mới quảng bá `features=clip_cleanup`.

## Làm gọn bắt buộc và timeline chỉnh tay (2026-10-28)

- Tạo clip tự nối cleanup tuần tự, complete tự áp dụng, render chặn clip chưa xử lý; lỗi không retry vô hạn, endpoint tiếp tục xử lý clip cũ.
- Chỉnh điểm bỏ theo chỉ số từ, từ chối ngoài clip/phần nói lại được bảo vệ; lưu/khôi phục, stale revision, snapshot dựng và ZIP loại bản cũ.
- Bộ test dùng inference giả, DB/video tạm; xử lý 3 clip cúm thật được chạy riêng theo yêu cầu người dùng.

Kết quả hoàn tất 2026-10-28:

- `AUTOVIDEO_TEST_LIBASS_FFMPEG=… npm test -- -- --maxWorkers=4`: 68 file, 866 đạt, 1 bỏ qua; `npm run typecheck`, `npm run build`, `git diff --check` đạt. DB thật: integrity `ok`, không có lỗi foreign key.
- Chrome headless với DB/video tạm: clip pending bị ẩn; complete tự hiện timeline; kéo điểm cuối, lưu/tải lại, khôi phục/lưu/tải lại; preview bỏ qua khoảng đã cắt; viewport 390px không tràn ngang, không có lỗi JavaScript.
- Theo yêu cầu người dùng, dự án cúm #15 chạy cleanup thật #69–71: K1 bỏ 1 chỗ (0,489s), K2 bỏ 5 chỗ (3,174s), K3 bỏ 1 chỗ (0,200s). Bản v2 #7–9 đều ready, có video/audio, thời lượng thực 51,817 / 55,283 / 41,717s; mọi cue SRT nằm trong đồng hồ mới. ZIP gồm 3 MP4 + 3 SRT, CRC hợp lệ; v1 vẫn giữ.
- Đã cập nhật app, khởi động lại server/worker và account proxy supervisor đang tắt. Manifest và ảnh giao diện thật: `output/ung-pho-voi-cum-cat-clip/clips/cleanup-run-20261028.json`, `cleanup-timeline.png`, `cleanup-K2.png`.

## Sửa lỗi sau review làm gọn (2026-10-28)

- `npm test -- -- --maxWorkers=4` với ffmpeg libass chỉ định: 68 file, 878 đạt, 1 bỏ qua; `npm run typecheck`, `npm run build`, `git diff --check` đạt. Test dùng DB/video/inference giả; không tạo thêm job sản xuất.
- Regression: worker cũ/legacy không nhận cleanup → hết hạn 5 phút, mở khóa chọn clip; worker hỗ trợ/backlog, quota wait và queue pause không hết hạn. Chặn lưu lựa chọn cũ trong cùng clip đang chạy AI; giữ revision, dấu job mới và polling.
- ASR zero-duration giữ ở khoảng giữ, loại ở khoảng bỏ và không nhân đôi mối nối; SRT/ASS giữ chữ. Clip cũ dùng đúng source/transcript ngay cả khi dự án có nguồn mới; range/caption edits cũng theo nguồn clip.
- 25 fps/31 đoạn: trường hợp không tiếng trước sửa chỉ còn 3,72s thay vì 4,619s; sau sửa video 4,60s, có tiếng 4,619s. Đã chạy qua API với 30 điểm bỏ thật trên video tạm và kiểm tra cả hình/tiếng.
- Polling nhiều clip và payload chọn đoạn lớn: một truy vấn cleanup cho dự án; EXPLAIN xác nhận partial index. Server trả retained_segments; cùng thuật toán dùng cho render/timeline, jobIsActive dùng chung. Nút làm gọn lấy quota plan. Cờ stale tồn tại sau đổi phụ đề và mở kết nối khác, kể cả bản legacy.
- Chrome headless: kéo/lưu/tải lại, khôi phục, preview bỏ khoảng cắt; viewport 390px không tràn; chạy lại AI khóa chỉnh sửa, complete cập nhật lựa chọn của job mới và vẫn polling, reload giữ đúng; không lỗi JavaScript.
- Migration 016 từ DB 015 giữ nguyên job/worker cũ. Chạy thử trên bản sao DB thật: 72 jobs, 6 clips, 9 clip_cuts giữ nguyên; integrity ok, foreign key check sạch. Giữ nguyên migration 015 đã áp dụng.

## Gọn giao diện LAN desktop (2026-10-28)

- Sửa đo lời thoại khi khung bị ẩn/chiều cao bằng 0. Chrome headless dùng lời thoại dài thật của dự án #18, đổi tab và chiều rộng 390/640/768/1023/1024/1440px: không còn React #185 hoặc lỗi JavaScript. Không làm các thay đổi giao diện chỉ dành cho điện thoại.
- Thẻ clip thu gọn phần làm gọn, lý do/lời thoại và bản dựng; một điểm AI, nút Duyệt & dựng, menu phụ, gợi ý thêm clip. Cùng ba clip ở 1440px, chiều cao trang giảm từ khoảng 2690px xuống 1696px. Kiểm tra mở lại timeline, duyệt lỗi không gọi render, duyệt thành công trước render, dựng hàng loạt dừng khi lỗi và tiếp tục không xếp lại clip đã nhận. Mọi request ghi trong kiểm tra trình duyệt đều giả lập, không gửi sang ứng dụng thật.
- Kế hoạch dùng thanh bước chung, nút chính dẫn đúng cảnh/bước, nhãn ảnh rõ hơn; danh sách có tiến độ, thumbnail, bước tiếp theo, tìm kiếm và lọc theo tên đã lưu. Form điền ngày, đổi nhãn nhất quán; công cụ xoá logo tách cảnh báo cookie. Thẻ dự án clip có poster và số clip đã dựng.
- Regression API trên DB/media tạm: tiến độ theo storyboard/video LAN, loại asset nội bộ, phục vụ thumbnail đúng quyền; bản hoàn chỉnh cũ trở thành stale sau đổi lựa chọn, không tạo job sản xuất. Thêm xử lý lỗi mutation cho LAN để lỗi duyệt/dựng được hiển thị.
- `AUTOVIDEO_TEST_LIBASS_FFMPEG=… npm test -- -- --maxWorkers=4`: **68 file, 879 đạt, 1 bỏ qua**. `npm run typecheck`, `npm run build`, `git diff --check` đạt. Không gọi inference/Flow thật, không thêm migration.
- Sau cập nhật và khởi động lại web/server: kiểm tra đọc trên cả sáu trang LAN, metadata thật, mở timeline, dẫn tới cảnh tiếp theo và đổi chiều rộng; không lỗi JavaScript, không request ghi. Ảnh desktop: `/private/tmp/autovideo-desktop-ux-results-live/`.

## Worker nền ảnh/video chạy thật (05–09/11/2026)

Đối chiếu bảng `jobs` của DB chạy thật ngày 09/11/2026 (chỉ đọc). Mọi job storyboard/video từ 05/11/2026 do `media-api-1` nhận; việc văn bản do `antigravity-worker-1` (AI API).

| Loại | Dịch vụ / model | Xong | Lỗi |
|---|---|---|---|
| storyboard | Flow · `gemini-3.1-flash-image-portrait` | 37 | 11 |
| storyboard | Muse · `muse-image` | 5 | 0 |
| video | Flow · `omni-1.1-flash-10s-portrait` | 29 | 3 |
| video | Muse · `muse-video` | 2 | 1 |

- Video Omni mất khoảng 2 phút mỗi job (vd job 244: 116 giây).
- Veo 3.1 Fast/Lite chưa chạy qua autovideo.
- 05/11/2026: lần chạy Flow đầu tiên lỗi `LOGIN_REQUIRED` vì mọi tài khoản trong Flow2API bị tắt/hết hạn. Sau đó worker có cơ chế chờ, gửi lại trước khi Flow nhận lệnh và tự bật lại hàng đợi khi `/health` của Flow2API có tài khoản hoạt động (test `server/test/media-worker.test.ts`).
- 09/11/2026: mọi job Flow lỗi CAPTCHA ("Failed to obtain reCAPTCHA token for image upload") do Flow đổi frontend. Flow2API được cập nhật lên upstream + PR #195; một yêu cầu ảnh có ảnh tham chiếu chạy thật thành công trong 60 giây, hàng đợi chạy lại bình thường.
