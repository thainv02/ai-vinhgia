# Plan: tab độc lập "Video HTML"

Ngày cập nhật: 31/10/2026. Trạng thái: **đã chạy spike (trừ benchmark model và WebView2) và triển khai giai đoạn 1–3**; chờ nghiệm thu bản cài (giai đoạn 4). Kết quả và chỗ thiết kế đổi so với bản plan ở mục 13; API ở `server/API.md` mục 15.

## 1. Mục tiêu và phạm vi đã chốt

Video HTML là **chức năng mới, nằm riêng một tab** trong app desktop Windows. Người dùng mô tả video, đưa ảnh/logo/video/nhạc vào → AI viết motion graphics bằng HTML/CSS/JS → xem trước và góp ý → bấm Dựng video → nhận MP4 tại máy.

- Có danh sách dự án, asset, lịch sử phiên bản, prompt, lựa chọn model và trạng thái riêng. Không gắn việc tạo Video HTML vào luồng Kế hoạch video.
- Nội dung: giới thiệu sản phẩm, khuyến mãi, so sánh, slideshow, biểu đồ, intro/outro, lower-third.
- Tỉ lệ: 9:16 mặc định; thêm 1:1 và 16:9. Tối đa 60 giây, 30 fps. Mặc định 720p, cho chọn 1080p; cạnh ngắn lần lượt 720 hoặc 1080, kích thước chính xác theo tỉ lệ.
- Hỗ trợ chữ tiếng Việt, ảnh/logo, video và nhạc/âm thanh người dùng tải lên. Video/âm thanh phải vượt spike trước khi công bố hỗ trợ; chưa đạt thì sửa thiết kế trước triển khai lõi, không âm thầm bỏ khỏi phạm vi.
- Sửa bằng góp ý AI hoặc form chữ/màu/ảnh; mỗi lần sửa tạo phiên bản mới, bản cũ giữ nguyên.
- Xuất/tải MP4 và mở thư mục xuất. Preview/render offline sau khi đã tải bộ dựng và asset; tạo/sửa AI cần mạng.

**Ngoài bản đầu:** Veo/Flow, TTS, timeline kéo-thả, HyperFrames Studio, render cloud, nút Dùng làm cảnh. Liên kết sang Kế hoạch video chỉ là khả năng tương lai, không phải phụ thuộc hoặc tiêu chí nghiệm thu của tab này.

## 2. Các quyết định kỹ thuật

| Hạng mục | Quyết định |
|---|---|
| Framework | Ghim HyperFrames `0.8.221` trong lockfile; spike xác nhận API của gói npm thực tế |
| Browser dựng | Dùng `chrome-headless-shell` ghim phiên bản tương thích, chế độ `beginframe` nếu spike xác nhận. Edge chỉ dùng đối chiếu/chẩn đoán |
| Cài browser | Cài đặt → Bộ dựng Video HTML: tải có tiến độ/hủy/thử lại, URL/version/SHA256 ghim. Không tải ngầm lúc dựng hoặc bắt buộc tải để dùng tab khác |
| Hàng đợi | Dùng scheduler render chung, thêm loại `html`; mỗi render HTML mặc định 1 worker chụp, giữ giới hạn tổng `RENDER_CONCURRENCY` |
| Preview | Listener static riêng bind `127.0.0.1`, origin riêng, không API nghiệp vụ; iframe sandbox có script, không same-origin |
| Model AI | Tách compose và vision; chọn theo năng lực và benchmark trên API cấu hình, không buộc theo model chung của app |
| Template | Ít nhất 4 mẫu sản phẩm/khuyến mãi/so sánh/slideshow ngay từ giai đoạn lõi, trước thử AI |
| Tự sửa | Tối đa 2 lượt sửa lint, 1 lượt sửa vision; trần 6 infer cho một yêu cầu tạo/sửa, tính cả bước mô tả ảnh nếu cần |
| Quyền chạy | AI chỉ bắt đầu khi người dùng bấm tạo/sửa; dựng MP4 chỉ sau nút Dựng video. Không chạy worker/inference thật trong sửa mã hoặc test |

Signatures/options producer, lint exports, runtime player, network hooks, audio và cách chọn ffmpeg phải được xác nhận trong spike. Không coi mô tả ở plan là API đã chạy đạt.

## 3. Model AI: chọn phù hợp từ API nhiều model

### 3.1 Danh sách và năng lực

- Dùng URL/key AI đã cấu hình phía server. Tách helper `GET /models` dùng chung từ phần settings, cache danh sách và cho làm mới; không đưa key vào client, prompt, log, metadata hay renderer.
- `/models` chỉ xác nhận ID tồn tại; không suy ra vision, context/output budget, JSON schema hoặc chất lượng code chỉ từ tên.
- Có registry năng lực đã kiểm chứng: text/code, vision, context/output budget và response mode proxy thực sự hỗ trợ. Model chưa biết được thử có chủ đích trong spike, không tự gọi mọi model mỗi lần mở tab.
- Compose cần viết HTML/CSS/JS + GSAP, trả JSON files đầy đủ, sửa đúng góp ý và giữ asset/phiên bản cha. Nếu compose không có vision, model vision mô tả ảnh trước rồi compose dùng mô tả có cấu trúc.
- Vision phải nhận ảnh thật qua API. Không có model vision hợp lệ thì thông báo rõ, bỏ bước vision và để người dùng kiểm tra preview; không gửi ảnh cho model text-only.

### 3.2 Chọn model mặc định và fallback

- Spike lấy danh sách thật, shortlist 2–3 model phù hợp code và 1–2 model vision nếu có; cùng bộ brief/template/budget để so sánh contract, bố cục/chữ/chuyển động, sửa góp ý, độ trễ và usage/chi phí nếu API cung cấp.
- Chọn model chất lượng tốt nhất đáp ứng giới hạn, ghi **ID chính xác, bằng chứng và giới hạn** ở mục 13. `claude-sonnet-4-6` từ cấu hình hiện tại chỉ là ứng viên; không cố định làm model cho tab này hoặc đoán ID mạnh hơn.
- UI mặc định **Tự chọn phù hợp** theo profile đã kiểm chứng; phần nâng cao cho chọn compose/vision trong danh sách khả dụng. Lịch sử cho biết model thực dùng.
- Inference router hiện dùng `aiModel` chung ở direct API: phải thêm model override theo job/request có policy kiểm tra. Không đổi cấu hình toàn cục cho mỗi job và không ảnh hưởng tab khác. Job managed/account pool vẫn tuân thủ capability/policy/lease hiện có.
- Snapshot model/policy vào job; đổi cài đặt chỉ ảnh hưởng job mới. Lưu usage và model thực tế cho từng attempt, không lưu credential.
- Fallback chỉ trong shortlist kiểm chứng và policy cho phép. Auth/quota thì chờ/báo lỗi; không quay vòng model liên tục. Submit chưa rõ kết quả thì giữ attempt để đối soát/tiếp tục, không tự gửi lại. Mọi thao tác tính credit phải có job đã duyệt theo cơ chế hiện hành.

## 4. Kiến trúc và ranh giới desktop/LAN

```text
Planner desktop: tab Video HTML
  │ project / asset / tạo AI / góp ý / sửa biến / yêu cầu dựng
  ▼
Route desktop riêng: server/src/lan/routes-html.ts
  ├─ html-projects / html-versions / html-assets services
  ├─ html_compose → worker nhúng → inference router → API AI cấu hình
  ├─ validate → lint → chụp khung → vision → validate/lint lại
  ├─ công bố version bất biến → preview origin riêng
  └─ render → scheduler chung kind=html
               └─ html-render.mjs → headless-shell + ffmpeg → MP4
```

- Desktop hiện hiển thị planner: route mới đặt trong `server/src/lan/`, chỉ đăng ký khi `config.desktop=true`. Không import route app chính vào listener planner.
- Không đăng ký tab/API HTML trên listener LAN thật; không mở `html_compose` qua các endpoint tạo job LAN hiện có.
- Preview listener chỉ static loopback, không worker/inference/settings/API/files tổng quát. Không đăng ký route nghiệp vụ app lên đó.
- Dùng phần phù hợp của `video-production-rules.md`: thương hiệu, tiếng Việt, bố cục/vùng an toàn theo tỉ lệ, không ép mọi video thành 9:16.
- File: `output/<slug>/html/versions/v<n>/`; MP4/poster ở `output/<slug>/html/renders/<render-id>/`. Staging riêng theo attempt, không chồng lên bản đã công bố.

## 5. Dữ liệu và migration

Migration mới dự kiến `016_html_video.sql`; kiểm tra số tiếp theo tại thời điểm triển khai. Không sửa migration đã chạy.

### 5.1 Schema hiện hữu

- Thêm `html` vào `PROJECT_KINDS`, `html_compose` vào `JOB_TYPES` và các validator.
- `projects.kind` và `jobs.type` hiện có `CHECK`: cần rebuild hai bảng bằng runner hỗ trợ `-- migrate:foreign-keys-off`, không chỉ sửa enum TypeScript.
- Chép theo tên cột, giữ ID/AUTOINCREMENT, index/trigger và foreign key/dữ liệu bảng con; kiểm tra đầy đủ schema thực tế trước rebuild.
- Test DB rỗng và bản sao DB schema 015 có jobs/assets/final_cuts/clips/account pool; chạy `foreign_key_check`, `integrity_check`, test rollback và backup trước migration.

### 5.2 Bảng mới

| Bảng | Trường và ràng buộc chính |
|---|---|
| `html_versions` | `id, project_id, version, parent_id, compose_job_id, status, prompt, feedback, summary, variables_json, manifest_json, files_dir, content_hash, lint_report_json, compose_policy_json, error, error_code, created_by, created_at, published_at` |
| `html_assets` | `id, project_id, original_name, stored_path, content_hash, media_type, bytes, width, height, duration_s, has_audio, created_at` |
| `html_renders` | `id, version_id, idempotency_key, status, settings_json, source_hash, video_path, poster_path, progress, error, error_code, created_at, started_at, finished_at` |

- Version status: `composing | validating | ready | failed | cancelled`. `ready` là file HTML sẵn sàng xem/dựng, chưa đồng nghĩa có MP4.
- Render status: `queued | rendering | ready | failed | cancelled`. Mỗi lần dựng có record riêng; lịch sử theo version và chất lượng.
- Unique `(project_id, version)`; version đã cấp không tái sử dụng. FK project/job/parent, service kiểm tra parent cùng project trong transaction.
- Giới hạn một render active cho cùng version và chống request trùng bằng idempotency key. Có index cho project/version, job và render status; cascade phù hợp khi xoá project.
- Asset dùng bảng riêng vì có video/audio, không mở rộng ngầm nghiệp vụ `project_refs`. Snapshot asset vào version bằng copy/hard link cho nội dung bất biến; xoá/sửa asset gốc không phá bản cũ. AI không được ghi đè vendor/font/upload.

## 6. Job AI và phiên bản bất biến

### 6.1 Tích hợp worker đầy đủ

- Thêm `html_compose` vào server `TEXT_JOB_TYPES`, worker `text-main.ts`, danh sách mặc định `main.ts`, client types và runner dispatcher.
- Hoàn thiện payload, claim/stale checks, inference policy, complete/fail/cancel, checkpoint/resume, heartbeat/lease và trạng thái hàng đợi; không chỉ thêm enum.
- Tạo version + job + `compose_job_id` trong transaction; payload snapshot brief/template/asset/parent/model policy.
- Worker điều phối duy nhất vòng compose/sửa; server chịu trách nhiệm validation, tài nguyên và file/trạng thái. Không để hai bên cùng tự retry. Worker chờ capture phải heartbeat và hủy được.
- Checkpoint sau mỗi infer và bước đắt; resume dùng attempt cũ. Completion idempotent, chỉ được ghi khi job/lease/version còn active. Kết quả về muộn sau cancel/delete bị từ chối.

### 6.2 Prompt, file và validation

- Bundle luật HyperFrames bản ghim, nguồn/license; có ít nhất 4 template đã dựng đạt. Bundle GSAP/runtime/font Be Vietnam Pro đủ tiếng Việt cùng license/notice riêng; không suy giấy phép dependency từ license repo HyperFrames.
- JSON đầu ra `{files, summary, variables}`; giới hạn số file, byte/file, tổng byte và độ sâu, phù hợp output budget model.
- Chỉ cho `index.html`, `compositions/<safe-name>.html`, CSS/JS tại thư mục cho phép. Kiểm tra containment sau chuẩn hóa Windows; chặn absolute/UNC/drive-relative, `..`, backslash lách luật, ADS, reserved names, symlink/junction và tên trùng không phân biệt hoa thường. Không chạy npm/script do AI tạo.
- Luồng: validate manifest/asset/biến → kiểm tra bảo mật → lint contract → chụp khung → vision nếu có → kiểm tra bảo mật và lint **lại trên bộ file cuối**. Tối đa 2 lượt sửa lint, 1 sửa vision, trần 6 infer tổng.
- Chụp ít nhất 3 mốc trong video, tránh khung mở/kết trống; lấy thêm quanh chuyển cảnh trong budget. Kiểm tra chữ tràn, mất asset/font, khung trống ngoài chủ ý.
- File cuối còn lỗi thì failed, có báo cáo; không bỏ qua để chuyển ready.
- Ghi staging theo attempt; sau kiểm tra đạt và xác nhận job còn active mới rename nguyên tử để công bố. Phiên bản đã công bố giữ nguyên; mọi sửa tạo version mới.

### 6.3 Sửa nhanh bằng biến

- Biến có schema `text | color | asset`, nhãn, giá trị, target và giới hạn; server kiểm tra target/asset thuộc project/version.
- Dùng DOM an toàn cho chữ, không HTML tùy ý hoặc replace chuỗi mù; màu có validator, ảnh chỉ chọn asset đã duyệt, không nhập URL ngoài.
- Sửa biến tạo version `created_by=user`, kiểm tra lại bảo mật/contract/asset. Có test tiếng Việt, ký tự đặc biệt và biến khớp nội dung thực tế.

## 7. Preview và cô lập mã HTML

- Iframe `sandbox="allow-scripts"`, không same-origin/popup/form/download/top-navigation. Parent giới hạn `frame-src` tới preview origin hiện hành.
- Static service chỉ phục vụ manifest đúng version/session, không static cả output, directory listing, file ẩn hoặc project khác. Session ngắn hạn gắn version; không log URL truy cập nhạy cảm.
- Policy preview riêng: `frame-ancestors` cho đúng planner desktop origin, không `X-Frame-Options: DENY` tại preview service. Giữ nguyên policy của mọi route planner khác, không nới toàn bộ `registerLanSecurity`.
- CSP cho đúng runtime script/style và asset ảnh/video/audio/font; cấm connect ngoài, object/form/base URI. Dùng hash/nonce cho inline script khi khả thi; không áp `script-src 'self'` hiện tại máy móc cho GSAP inline.
- Opaque-origin sandbox cần kiểm chứng font/media/composition thật. CORS nếu cần chỉ mở trên static preview whitelist, không credential; không mở CORS API hoặc thêm `allow-same-origin` để chữa lỗi asset.
- Player/runtime bundle có bridge play/pause/seek; `postMessage` kiểm tra schema, session nonce và `event.source`. Không chỉ tin origin null; parent không nhận lệnh fetch/ghi file tùy ý từ iframe.
- Render browser dùng profile tạm, không profile đăng nhập của Edge/worker. Renderer không nhận API key/token qua env hoặc argv; giữ browser sandbox. Engine bắt buộc tắt sandbox là blocker cần đổi phương án.
- Áp dụng allowlist origin + method + normalized path trước khi JS chạy và với target/frame liên quan; chặn API localhost/app, project khác, redirect thoát allowlist, WebSocket, service worker và scheme không cần. Chỉ HTTP asset serving; không bật file access rộng.
- Cùng giới hạn áp dụng cho preview, thumbnail/vision và MP4. Có timeout load/seek/frame/toàn việc, giới hạn input/output, kill cây tiến trình khi timeout. Test localhost access, asset chéo project, điều hướng ngoài và JS vòng lặp.

## 8. MP4, queue, hủy và khôi phục

- `server/html-render.mjs` nhận snapshot manifest/version, settings và đường dẫn bộ dựng; gọi producer API đã xác nhận. JSON lines báo progress, stderr giới hạn cho log.
- Dùng ffmpeg/ffprobe đóng gói bằng đường dẫn tuyệt đối nếu engine hỗ trợ; nếu chỉ PATH thì đặt PATH tối thiểu, kiểm tra binary thực dùng. Bản build hiện dùng `bin/`, không mặc định `runtime/bin`.
- Thêm queue kind `html`, enqueue/cancel/queueInfo, SSE, đếm running/waiting, shutdown/idle và project-delete checks; namespace `kind:id` tránh đụng ID loại khác.
- Capture cho vision cũng đi scheduler chung. Một stage chỉ enqueue một lần, không chiếm slot rồi enqueue con và chờ lại chính queue.
- `capture concurrency=1` khác với concurrency toàn app; giữ ưu tiên app trước LAN, không ngắt việc đang chạy. Đo HTML song song ffmpeg/xoá logo ở `RENDER_CONCURRENCY=2` trước khi tăng capture workers.
- Hủy queued loại đúng item; hủy running abort + kill browser/ffmpeg, chờ close rồi nhả slot/dọn file. Hạ ưu tiên Windows; kiểm tra Job Object Tauri dọn mọi tiến trình khi tắt app.
- MP4 ghi tạm, ffprobe kiểm tra video/kích thước/fps/thời lượng trong sai số định trước và audio khi yêu cầu; kiểm tra seek/frame. Đạt mới rename nguyên tử/ready và tạo poster/contact sheet.
- Không đưa output HTML qua xoá logo Veo/color-grade pipeline của final cut; tái sử dụng scheduler và utility phù hợp.
- Restart: mọi render queued/rendering cũ thành failed có nút thử lại; dọn partial khi không còn writer, không tự render lại. Compose tiếp tục theo lease/checkpoint, không tạo job thay thế.
- Retry render có attempt mới, source hash/settings rõ ràng, không ghi đè MP4 ready. Render lỗi không làm mất preview/HTML version.

## 9. Asset, video và âm thanh

- Upload streaming tới file tạm, kiểm tra MIME/nội dung/probe. Trần mặc định: ảnh 20 MB/file, video/audio 200 MB/file, asset 1 GB/project; báo lỗi trước infer.
- Không tải URL ngoài theo code AI. File upload dùng ID/hash an toàn, original name chỉ làm nhãn. Manifest chứa kích thước/thời lượng/audio/mô tả; không đưa video/audio base64 vào prompt; ảnh vision có resize/budget.
- Chốt in/out, start/duration, loop, gain/mute và nguồn ngắn/dài. Composition duration là chuẩn; cắt/fade audio cuối, không kéo dài MP4 ngoài yêu cầu.
- Spike xác nhận mux audio, seek video, preview và concurrency 1/2 với nguồn có/không audio, nhạc riêng và chạy offline.

## 10. UI và API desktop

- Tab **Video HTML** giữa Cắt clip và Xoá logo Veo, route/list/detail riêng. Không lẫn project HTML vào Kế hoạch hoặc Cắt clip.
- Trang tạo: tên, brief, template/Tự chọn, tỉ lệ, thời lượng, asset, model Tự chọn phù hợp; nâng cao chọn compose/vision và chất lượng xuất.
- Detail: version history, player, form biến, góp ý, model/usage, lịch sử MP4, progress, hủy/thử lại/tải/mở thư mục xuất.
- Tách trạng thái compose/kiểm tra/chờ tài nguyên/preview ready/render queued/rendering/output ready/lỗi. Worker offline hoặc thiếu bộ dựng có hướng khắc phục.
- Endpoint dự kiến `/lan/api/html-projects`: CRUD, assets, versions/compose/revise/variables, render/cancel/outputs. Download chỉ output ready; open-folder dùng cơ chế desktop với path server kiểm soát.
- Tạo/sửa/dựng có idempotency key và trả ID phục hồi sau reload. Backend kiểm tra desktop/project kind/trạng thái, không chỉ ẩn nút.
- Xoá chặn khi compose/validation/capture/render/upload còn active hoặc đang dừng; hủy rồi đợi writer/handle đóng. Bổ sung HTML vào `projectDeleteBlocks` và cleanup, không gọi lại `deleteFromPlanner` nguyên trạng rồi coi là đủ.

## 11. Đóng gói và kiểm thử

- `build:win` đóng gói runner/dependency/runtime/template/prompt/font/GSAP; kiểm tra npm tarball/exports/dynamic import để quyết định bundle/copy. Bản cài không trỏ về source repo.
- `PUPPETEER_SKIP_DOWNLOAD=1` khi cài dependency. Browser quản lý riêng theo version/hash, download tạm rồi verify/rename; có phục hồi binary thiếu/hỏng và cache offline.
- Đo installer tăng thêm và browser trên đĩa, không khẳng định 15–30 MB khi chưa đo. Mang license/notice đúng thành phần phân phối.
- Smoke bằng node.exe đóng gói; render fixture 2 giây dùng browser đã chuẩn bị, thiếu thì báo thiếu chứ không tải ngầm. Test bản cài sạch, đường dẫn khoảng trắng/tiếng Việt, không Node/Chrome hệ thống.
- Test DB/profile/output tạm, fake inference/render: create → claim → complete, fail/cancel/resume/stale completion, model override không ảnh hưởng tab khác, validate sau vision, biến/path traversal/idempotency/concurrent version.
- Test migration cũ/rỗng, FK/integrity, queue N việc, ưu tiên app/LAN, hủy đúng item, restart/idle/shutdown/delete và không nhả slot sớm.
- Preview thật WebView2: CSP/CORS/font/media/player/postMessage/isolation. Render thật bằng composition fixture, **không inference/Flow thật từ test**.
- Runtime thay đổi phải chạy `npm test`, `npm run typecheck`, `npm run build`; nghiệm thu `npm run build:app` và bản cài. AI thật chỉ thử trong spike bằng job/approval hợp lệ; không bật worker nhận job tồn đọng để test.

## 12. Giai đoạn và điều kiện đạt

| Giai đoạn | Nội dung | Điều kiện chuyển bước |
|---|---|---|
| 0. Spike | Gói npm/API, browser, preview WebView2, isolation, media/audio, model shortlist, tài nguyên/đóng gói | Ghi bằng chứng mục 13, giải quyết blocker trước lõi |
| 1. Lõi | Migration/data/API, template, worker lifecycle, model policy, validation/version bất biến | DB cũ và worker giả trọn luồng đạt |
| 2. Preview/render | Origin riêng/player, runner/queue/capture, cancel/restart/delete, packaging | Fixture preview/render, isolation, queue N việc đạt |
| 3. Tab desktop | List/create/detail, asset/biến/góp ý/model/output/settings | Luồng độc lập đầy đủ; reload/hủy/retry đúng |
| 4. Nghiệm thu | Suite/build app/máy sạch/máy yếu/offline/tài liệu | Bản cài dùng được, không regression tab khác/LAN |

### Checklist spike bắt buộc

1. Gói npm HyperFrames `0.8.221` nạp bằng Node app; xác nhận API/options, player, lint, ffmpeg, network hooks và audio.
2. Fixture 9:16 15 giây 720p/1080p có ảnh/chữ tiếng Việt/GSAP/video/nhạc; fixture 1:1 và 16:9 ngắn. Kiểm tra đầu/giữa/chuyển cảnh/cuối, fps/duration và đồng bộ audio.
3. Preview WebView2 opaque sandbox tải font/media và seek được; fixture độc hại không truy cập API app/project khác.
4. Đo thời gian/peak RAM/CPU capture concurrency 1/2 và chia sẻ scheduler; ghi cấu hình máy. Mục tiêu 15 giây 720p dựng ≤45 giây trên máy tham chiếu. Đúng hình/tiếng/timeline và cô lập là gate cứng; không đạt hiệu năng thì điều chỉnh thiết kế/ước lượng trước lõi.
5. Model shortlist: ít nhất 5 brief cùng template/budget, gồm chữ Việt dài, nhiều asset và góp ý. Compose mặc định đạt contract cuối ≥4/5 trong giới hạn sửa; người đánh giá chất lượng hình ảnh và ghi lỗi. Vision nhận ảnh thật; ghi ID model được chọn.
6. Đo footprint, browser download/hash/cancel, timeout/kill cây tiến trình, binary đóng gói và chạy offline.

**Ước lượng sơ bộ: 12–16 ngày công**, gồm spike 2–3 ngày và nghiệm thu bản cài. Chưa phải cam kết; cập nhật sau spike theo preview/isolation/media và chất lượng model.

## 13. Kết quả spike và quyết định cuối

Spike chạy 30/10/2026 ngoài repo, không gọi AI. Máy: i5-10300H 4 nhân/8 luồng, 7,8 GB RAM, Win11, Node 22.20. Gói `@hyperframes/*` 0.8.221 phát hành **đúng ngày 30/10/2026**: coi là mã bên thứ ba chưa kiểm chứng, ghim cứng, đọc diff khi nâng cấp.

| Hạng mục | Bằng chứng / kết quả |
|---|---|
| Máy tham chiếu, Node, WebView2 | Như trên. WebView2 tương tác **chưa kiểm chứng** (chỉ chạy headless) |
| HyperFrames npm exports/options | Gói `hyperframes` KHÔNG có API dựng/lint (chỉ transcribe/removeBackground, CLI có telemetry). Dùng `@hyperframes/producer` (`createRenderJob` + `executeRenderJob(job, dir, out, progress, signal)`) và `@hyperframes/lint` (`lintProject`). Không có API chụp khung: tự làm bằng static server + runtime + `window.__player.seek(t)`. ffmpeg qua `HYPERFRAMES_FFMPEG_PATH`/`FFPROBE_PATH`, trình duyệt qua `PRODUCER_HEADLESS_SHELL_PATH` |
| Browser version/hash, capture mode | `chrome-headless-shell` 152.0.7977.30 win64 (bản HyperFrames ghim), zip 119.527.247 byte, SHA256 `5d7df999…4275e`, giải nén 270 MB. **Windows không có BeginFrame** → chế độ screenshot. Engine tự thêm `--no-sandbox` → runner vá `puppeteer.launch` bật lại sandbox (đã kiểm chứng dựng được) |
| Model API khả dụng, shortlist/năng lực | **Chưa chạy** (cần gọi AI thật, chờ người dùng cho phép). Tạm: profile kiểm chứng chỉ `claude-sonnet-4-6`; `Tự chọn` = `AI_MODEL` |
| Compose mặc định, vision, fallback | Như trên; benchmark ≥ 5 brief (checklist 5) còn nợ trước khi công bố |
| Preview/isolation/font/media | Engine không có hook mạng: composition độc hại trúng honeypot 5/5 (fetch, XHR, WebSocket, beacon, img). CSP meta chèn đầu `<head>` chặn cả 5; interception chặn HTTP nhưng **không chặn WebSocket** → CSP bắt buộc, interception là lớp phụ. Font phải là `@font-face` inline trong index.html (không thì engine tải Google Fonts). Preview opaque cần CORS `*` + CORP cross-origin + Range ở origin preview; seek/play/ended chạy đúng (headless) |
| MP4/audio/timeline | h264 yuv420p 30 fps, aac 48 kHz, đúng thời lượng/số khung; chữ Việt, ảnh, GSAP, video muted, nhạc đúng. 720→1080 bằng hệ số 1,5 bị từ chối → viết ở khung gốc 360×640 / 640×360 / 360×360, xuất ×2 (720p) hoặc ×3 (1080p). Chưa thử: video nguồn có tiếng, seek nguồn dài, cắt/fade nhạc |
| Hiệu năng/tài nguyên/queue song song | 15 s 720p: 39 s (1 worker), 23,5 s (2), 19 s (4); 1080p: 39 s / 31 s; RAM đỉnh 0,8–1,0 GB. Bản gia cố (sandbox + interception) đo 62,6 s ở 1 worker — cần đo lại. Khởi động tiến trình runner 5–10 s/việc. Chưa đo song song với ffmpeg khác ở `RENDER_CONCURRENCY=2` |
| Footprint và license notices | Producer + lint (bỏ optional) ~94 MB `node_modules`; trình duyệt tải riêng 119 MB / 270 MB. HyperFrames Apache-2.0, Be Vietnam Pro OFL-1.1, puppeteer Apache-2.0. **GSAP 3.15.0 = GreenSock Standard License, có điều khoản hạn chế công cụ cho người dùng tạo animation → cần duyệt pháp lý trước khi phát hành.** `@hyperframes/player`: LICENSE ghi Apache-2.0, README ghi MIT. Ghi trong `server/assets/html-runtime/NOTICE.md` |
| Go/no-go, ước lượng cập nhật | Go về kỹ thuật (mọi blocker có cách xử lý đã kiểm chứng). Còn nợ trước khi công bố: benchmark model, kiểm tra WebView2 thật, duyệt giấy phép GSAP, đo lại hiệu năng bản gia cố |

**Thay đổi thiết kế so với các mục trên:** bỏ BeginFrame (mục 2); phụ thuộc là `@hyperframes/producer` + `@hyperframes/lint` + `@hyperframes/core` (server) và `@hyperframes/player` (web), không phải `hyperframes`; đóng gói chép `node_modules` của producer thay vì bundle một file; CSP + `@font-face` do server chèn lúc preview/chụp/dựng (AI không viết); khung gốc 360 px rồi nhân khi xuất (mục 1).
