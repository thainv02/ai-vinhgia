# API Autovideo (server) — hợp đồng cho frontend và worker

Tài liệu này khớp với code trong `server/src` (kiểm chứng bằng `npm test`). Tên trường JSON là snake_case và đúng như server trả về.
Tất cả thông báo lỗi cho người dùng bằng tiếng Việt.

- [1. Quy ước chung](#1-quy-ước-chung)
- [2. Cấu hình (.env)](#2-cấu-hình-env)
- [3. Enum và máy trạng thái](#3-enum-và-máy-trạng-thái)
- [4. Kiểu dữ liệu (object)](#4-kiểu-dữ-liệu-object)
- [5. API người dùng (web)](#5-api-người-dùng-web)
- [6. API worker (Claude / sim-worker)](#6-api-worker-claude--sim-worker)
- [7. SSE `GET /api/stream`](#7-sse-get-apistream)
- [8. File tĩnh `/files/*`](#8-file-tĩnh-files)
- [9. Bảng mã lỗi](#9-bảng-mã-lỗi)
- [10. Nút giao diện ↔ endpoint](#10-nút-giao-diện--endpoint)
- [11. Quy tắc nghiệp vụ quan trọng](#11-quy-tắc-nghiệp-vụ-quan-trọng)
- [12. Bố cục file, script, chạy thử](#12-bố-cục-file-script-chạy-thử)
- [13. Trang planner LAN (listener riêng)](#13-trang-planner-lan-listener-riêng)
- Cắt clip từ video dài (long video → shorts): [14](#14-cắt-clip-từ-video-dài-long-video--shorts), [SSE `source.updated`/`clip.updated`/`clip_cut.updated`](#7-sse-get-apistream)
- Bản dựng hoàn chỉnh (final cut): [4.12](#412-finalcut-bản-dựng-hoàn-chỉnh), [5.7](#57-bản-dựng-hoàn-chỉnh-final-cut), [6.5](#65-job-edit_plan), [SSE `final_cut.updated`](#7-sse-get-apistream)

---

## 1. Quy ước chung

- Base URL: `http://127.0.0.1:8787` (API). Giao diện dev chạy ở `http://localhost:5173` và proxy `/api`, `/files` sang 8787 (SSE đi qua proxy không bị đệm). Ở production (`npm start`) server 8787 phục vụ luôn `web/dist` (SPA fallback: GET trang HTML lạ → `index.html`; `/api/*` và `/files/*` luôn trả JSON/file).
- Body request: `Content-Type: application/json` (trừ upload ảnh: `multipart/form-data`). Body JSON rỗng được coi là `{}`. Content-Type khác (vd `text/plain`) → `415 UNSUPPORTED_MEDIA_TYPE`. JSON hỏng → `400 INVALID_JSON`.
- Thời gian: ISO 8601 UTC, dạng `2026-01-01T00:00:00.000Z`.
- Boolean trả về là `true/false` (không phải 0/1). JSON lưu trong DB (payload, result, meta, upload_refs) được trả về đã parse.
- **Danh sách trả về mảng JSON trần** (`[...]`), không bọc `{items}`. Tài nguyên đơn trả về object trần, trừ các endpoint thao tác (approve, comment, cancel, verdict…) trả object có tên trường (`{ scene, job }`…) — xem từng endpoint.
- Id là số nguyên (INTEGER). Tham số `:id` không phải số nguyên dương → `400 VALIDATION_ERROR`.
- **Định dạng lỗi** (mọi lỗi, mọi mã HTTP ≥ 400):
  ```json
  { "error": { "code": "ATTEMPTS_EXCEEDED", "message": "Cảnh C1 đã dùng 2/2 lượt", "details": { } } }
  ```
  `details` chỉ có ở một số lỗi (`CREDITS_CHANGED`, `QUEUE_PAUSED`, `INVALID_TRANSITION`, `VALIDATION_ERROR`). Bảng mã lỗi ở [mục 9](#9-bảng-mã-lỗi).
- **Bảo vệ API cục bộ** (áp dụng cho mọi route, kể cả `/files` và SSE):
  - Header `Host` phải là `localhost`, `127.0.0.1` hoặc `[::1]` (có hoặc không kèm cổng), không thì `403 FORBIDDEN_HOST`.
  - Request ghi (`POST/PUT/PATCH/DELETE`) mà **có** header `Origin` thì Origin phải là một trong `http://localhost:5173`, `http://127.0.0.1:5173`, `http://localhost:8787`, `http://127.0.0.1:8787` (+ `EXTRA_ALLOWED_ORIGINS`), không thì `403 FORBIDDEN_ORIGIN`. Không có Origin (curl, Node fetch, worker) thì cho qua. Nghĩa là UI phải chạy ở cổng 5173 hoặc 8787 (Vite đặt `strictPort`).
  - API worker thêm token: `Authorization: Bearer <WORKER_TOKEN>` (so sánh thời gian hằng số). Thiếu/sai → `401 UNAUTHORIZED`.
- Không có xác thực người dùng, không có phân trang con trỏ (trừ `events?before=`), không có CORS (cùng origin qua proxy).

---

## 2. Cấu hình (.env)

Đọc từ `.env` ở thư mục gốc repo (xem `.env.example`) và biến môi trường (biến môi trường thắng). Lần chạy server đầu tiên nếu thiếu `WORKER_TOKEN` thì tự sinh ngẫu nhiên và ghi vào `.env`.

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | `8787` | Cổng API |
| `HOST` | `127.0.0.1` | Địa chỉ bind (đừng đổi ra ngoài máy) |
| `ROOT_DIR` | thư mục gốc repo | Nơi chứa `output/` và `refs/` (đường dẫn trong DB tính từ đây) |
| `DB_PATH` | `data/app.db` | File SQLite (tương đối so với `ROOT_DIR`). WAL, `foreign_keys=ON`, `busy_timeout=5000` |
| `WORKER_TOKEN` | tự sinh | Token worker |
| `WORKER_MODE` | `legacy` | `legacy`: mọi job do worker legacy (WORKER.md, curl). `managed`: bật managed worker (account pool, lease). Xem `MANAGED_JOB_TYPES` |
| `MANAGED_JOB_TYPES` | rỗng | Chỉ có tác dụng khi `WORKER_MODE=managed`: danh sách loại job (cách nhau dấu phẩy: `analyze_brief,revise_prompt,edit_plan,clip_plan,storyboard,video`) do managed worker nhận. Rỗng = mọi loại. Loại còn lại do worker legacy nhận (chế độ kết hợp). Loại lạ làm server không khởi động |
| `MAX_CONCURRENT_VIDEO_JOBS` | `4` | Tối đa job video ở trạng thái `claimed/running` cùng lúc (toàn hệ thống) |
| `REQUIRE_PROMPT_APPROVAL` | `true` | `true`: cảnh mới vào `awaiting_approval`. `false`: tự vào `storyboard_queued` + tạo job storyboard |
| `HEARTBEAT_STALE_MINUTES` | `5` | Job claimed/running không heartbeat quá số phút này bị trả về `queued` |
| `WORKER_ONLINE_SECONDS` | `90` | Worker online nếu có request hợp lệ trong số giây này |
| `TRASH_RETENTION_DAYS` | `30` | Số ngày dự án nằm trong thùng rác trước khi tự xoá vĩnh viễn (số nguyên ≥ 1; giá trị sai/<1 → 30, không bao giờ xoá ngay). Dọn lúc khởi động và mỗi giờ (mục 5.8) |
| `EXTRA_ALLOWED_ORIGINS` | rỗng | Origin bổ sung (cách nhau dấu phẩy) |
| `FINAL_RENDERER` | `auto` | Trình dựng bản hoàn chỉnh: `auto` (Shotcut nếu cấu hình đủ và `--check` của MCP chạy được, ngược lại ffmpeg) · `shotcut` · `ffmpeg` |
| `SHOTCUT_MCP_PYTHON` | rỗng | Đường dẫn **tuyệt đối** tới Python chạy Shotcut MCP (vd `…/cpython-3.12-macos-aarch64-none/bin/python3.12`) |
| `SHOTCUT_MCP_SERVER_SCRIPT` | rỗng | Đường dẫn tuyệt đối tới `shotcut_mcp_server.py`. Server chạy `<python> <script>` với `SHOTCUT_MCP_ALLOWED_ROOTS=<ROOT_DIR>` và `SHOTCUT_MCP_REQUIRE_ABSOLUTE_PATHS=1` |
| `WATERMARK_REMOVER` | `auto` | Xoá logo Veo trên bản dựng hoàn chỉnh: `auto` (bật nếu `GWR_CLI` tồn tại và `node <GWR_CLI> --help` chạy được) · `off` (bỏ qua bước này) |
| `GWR_CLI` | `<repo>/gemini-watermark-remover/bin/gwr.mjs` | Đường dẫn **tuyệt đối** tới `bin/gwr.mjs` của tool xoá logo Veo. Server chạy `node <GWR_CLI> remove <raw> --output <tmp> --json …` với `cwd` = thư mục repo của tool |
| `GWR_VIDEO_BITRATE_MBPS` | rỗng | Truyền `--video-bitrate-mbps N` cho tool; trống = mặc định của tool |
| `GWR_TIMEOUT_MS` | `1800000` (30 phút) | Truyền `--video-timeout-ms` cho tool; quá hạn (+30 giây) server dừng cả cây tiến trình và báo lỗi |
| `RENDER_CONCURRENCY` | `2` | Số việc render/xoá logo chạy **cùng lúc** trong hàng đợi render chung (bản dựng của app và LAN, gồm bước render + xoá logo, và việc công cụ xoá logo LAN). Số nguyên kẹp 1–4; thiếu/không phải số → 2. Việc của dự án `app` vẫn được lấy trước việc LAN đang chờ, không ngắt việc đang chạy. Mỗi render Shotcut mở một tiến trình MCP riêng; nếu `RENDER_CONCURRENCY` > 2 và `SHOTCUT_MCP_MAX_ACTIVE_RENDERS` (mặc định 2 của Shotcut MCP, 1–8, tính chung giữa các tiến trình MCP của cùng người dùng) thấp hơn, server đặt biến này bằng `RENDER_CONCURRENCY` khi mở MCP. Xem `GET /api/lan` → `render` |
| `FFMPEG_PATH` / `FFPROBE_PATH` | rỗng | Tùy chọn; mặc định tìm trong `PATH`, rồi `/Applications/Shotcut.app/Contents/MacOS/`, rồi Homebrew |
| `LAN_ENABLED` | `false` | `true`/`1`/`yes`/`on`: bật **listener LAN riêng** cho trang planner (mục 13). Giá trị khác (kể cả gõ sai) = tắt. Đổi giá trị cần khởi động lại |
| `LAN_HOST` | `0.0.0.0` | Địa chỉ bind của listener LAN |
| `LAN_PORT` | `8790` | Cổng listener LAN (phải khác `PORT`, 1–65535; sai cấu hình thì server không khởi động) |
| `LAN_REQUIRE_CODE` | `false` | `false` (mặc định): trang planner **mở ngay, không có màn đăng nhập và không có phiên** (mọi route LAN dùng được; Host, Origin, cross-site, CSP, giới hạn theo IP, trần hàng đợi, danh sách file được phép vẫn giữ). `true`: đòi mã truy cập chung như trước (mục 13). `false/0/no/off` hoặc trống = không đòi; **giá trị khác (kể cả gõ sai như `treu`) = đòi mã** để lỗi chính tả không âm thầm mở trang ra mạng. Đổi giá trị cần khởi động lại |
| `LAN_ACCESS_CODE` | tự sinh khi cần | Mã truy cập chung của trang planner (≥ 6 ký tự, không phân biệt hoa thường). **Chỉ bắt buộc khi `LAN_REQUIRE_CODE=true`**; khi đó nếu để trống và `LAN_ENABLED=true`, server sinh mã ngẫu nhiên 8 ký tự dễ đọc (bỏ I/O/0/1) và ghi vào `.env` (quyền 0600) như `WORKER_TOKEN`. Khi `LAN_REQUIRE_CODE=false` không sinh, không đòi, không kiểm tra độ dài. Không bao giờ ghi vào log |
| `LAN_ALLOWED_HOSTS` | rỗng | Hostname bổ sung (cách nhau dấu phẩy) mà listener LAN chấp nhận trong header `Host`, ngoài IP, `localhost`, `*.local`, `*.lan`, `*.internal`, `*.home.arpa` và tên một nhãn |
| `STT_PROVIDER` · `STT_URL` · `STT_TENANT_ID` · `STT_TIMEOUT_MS` · `STT_MAX_RETRIES` | `omnix` nếu có `STT_URL` (ngược lại `none`) · rỗng · `s-omnix-studio` · `3600000` · `3` | Nhận dạng lời nói cho cắt clip (mục 14.5). `STT_URL` = URL đầy đủ `…/v1/audio/transcriptions` (chỉ HTTP). `none`/thiếu URL: báo "Chưa cấu hình nhận dạng lời nói" |
| `CLIP_SOURCE_MAX_BYTES` · `CLIP_SOURCE_MAX_S` | 4 GiB · `10800` (3 giờ) | Giới hạn video nguồn ở app chính |
| `LAN_CLIP_SOURCE_MAX_BYTES` · `LAN_CLIP_SOURCE_MAX_S` · `LAN_CLIP_SOURCE_RETENTION_DAYS` | 2 GiB · `10800` (3 giờ) · `7` | Giới hạn video nguồn ở trang LAN và hạn lưu video gốc (giữ transcript, bản xem thử, clip) |
| `CLIP_MIN_FREE_GB` | `10` | Ổ đĩa phải còn trống ≥ giá trị này + 3 × dung lượng file khi tải lên (và + ước tính clip khi dựng), không thì `507 INSUFFICIENT_STORAGE` |
| `CLIP_CAPTION_FONT` · `CLIP_FONTS_DIR` | `Arial` · rỗng | Font phụ đề ASS (luôn đậm, cần đủ dấu tiếng Việt) và thư mục font cho libass; rỗng = `<thư mục DB>/clip-fonts` chứa bản chép của Arial Bold hệ thống |
| `CLIP_FFMPEG_PATH` | rỗng | ffmpeg có libass (`subtitles`) để cháy phụ đề; rỗng = tự dò (mục 14.6) |
| `AUTOVIDEO_ENV_FILE` | `<repo>/.env` | Đường dẫn file `.env` khác (chạy thử với cấu hình tạm mà không đọc/ghi `.env` thật) |
| `NODE_ENV` | | `production` (do `npm start` đặt) → phục vụ `web/dist` |

Cấu hình hiệu lực (không gồm token) có ở `GET /api/meta` → `config`.

Server làm gì khi khởi động / định kỳ: chạy migration (`server/migrations/NNN_*.sql`, bảng `schema_migrations`), sao lưu DB vào `data/backup/app-<timestamp>.db` bằng `db.backup()` (giữ 20 bản mới nhất), timer 30 giây quét job mất heartbeat, timer 10 giây phát SSE `worker.status` khi online/offline đổi, **bản dựng hoàn chỉnh đang `rendering` của tiến trình cũ được đánh dấu `failed`** ("Server khởi động lại trong lúc render; bấm Render lại"), và điền `content_hash` còn thiếu của ảnh tham chiếu. **Việc công cụ LAN** (`lan_tool_jobs`) đang `queued`/`processing` của tiến trình cũ → `failed` ("Server khởi động lại trong lúc xử lý; bấm Thử lại", giữ input, dọn file tạm); timer 1 giờ (và một lần lúc khởi động) xoá việc công cụ quá 7 ngày. (Áp dụng cho **mọi** bản/việc đang chạy hoặc chờ, kể cả khi `RENDER_CONCURRENCY` > 1.) **Bản đang `rendering` ở bước xoá logo** → `failed` với `failed_stage="clean"` ("Server khởi động lại trong lúc xoá logo Veo; bấm Thử xoá logo lại"; bản raw còn nguyên, file tạm bị dọn). Migration `014_clips.sql` thêm `projects.kind`/`stt_terms`, dựng lại bảng `jobs` (thêm `clip_plan`, theo đúng quy trình của 003) và tạo `source_videos`, `clips`, `clip_cuts` (mục 14); lúc khởi động: bản dựng clip đang `rendering` của tiến trình cũ → `failed`, video đang nhận dạng được xếp lại, timer 1 giờ xoá video gốc LAN quá hạn lưu. Migration `010_lan_tools.sql` chỉ tạo bảng `lan_tool_jobs` (+2 index). Migration `004_watermark.sql` chỉ `ALTER TABLE final_cuts ADD COLUMN` (stage, raw_video_path, failed_stage, watermark_removed, watermark_meta). Migration `003_final_cuts.sql` dựng lại bảng `jobs` (thêm `edit_plan`) — runner tắt `foreign_keys` rồi chạy `PRAGMA foreign_key_check` trước khi commit (directive `-- migrate:foreign-keys-off`).

---

## 3. Enum và máy trạng thái

### 3.1 Trạng thái cảnh `scene.status` (`GET /api/meta` → `scene_statuses` có sẵn nhãn)

| Giá trị | Nhãn | Ý nghĩa |
|---|---|---|
| `draft` | Nháp | Mới tạo, thoáng qua |
| `prompt_ready` | Prompt sẵn sàng | Claude viết xong prompt, thoáng qua |
| `awaiting_approval` | Chờ duyệt | Chờ người dùng duyệt prompt (hoặc duyệt lại sau khi sửa prompt) |
| `storyboard_queued` | Storyboard đang chờ | Có job storyboard `queued` |
| `storyboard_running` | Đang tạo storyboard | Job storyboard `claimed/running` |
| `storyboard_review` | Xem storyboard | Đã có storyboard, chờ người dùng quyết định |
| `video_queued` | Video đang chờ | Có job video `queued` (đã đặt trước credit) |
| `video_running` | Đang tạo video | Job video `claimed/running` |
| `video_review` | Xem video | Có video mới, chờ người dùng chọn / comment |
| `done` | Hoàn tất | Người dùng đã chọn video (`selected_video_id`) |
| `needs_revision` | Cần sửa prompt | Có job `revise_prompt` đang chờ/chạy |
| `failed` | Lỗi | Job gần nhất lỗi (xem `jobs[0].error`) |
| `blocked_budget` | Flow hết credit | Job video lỗi `FLOW_OUT_OF_CREDIT` (tài khoản Flow hết credit thật; KHÔNG liên quan hạn mức của web — web không còn hạn mức credit) |
| `cancelled` | Đã hủy | Dành sẵn, chưa có API tạo ra trạng thái này |

### 3.2 Bảng chuyển hợp lệ (`transition()` — nơi DUY NHẤT đổi `scenes.status`)

Ngoài bảng → `409 INVALID_TRANSITION`. Mỗi lần chuyển ghi `events` (type `scene.status`, message `"C1: storyboard_review → video_queued (lý do)"`) và phát SSE `scene.updated` sau commit. `X → cancelled` luôn hợp lệ (chưa có API).

| Từ | Sang |
|---|---|
| `draft` | `prompt_ready` |
| `prompt_ready` | `awaiting_approval` (tự động) · `storyboard_queued` (khi `REQUIRE_PROMPT_APPROVAL=false`) |
| `awaiting_approval` | `storyboard_queued` · `video_queued` (cần đã có storyboard) · `needs_revision` |
| `storyboard_queued` | `storyboard_running` (claim) · `storyboard_review` / `awaiting_approval` (hủy job) · `failed` |
| `storyboard_running` | `storyboard_queued` (mất heartbeat) · `storyboard_review` (complete) · `awaiting_approval` (hủy job) · `failed` |
| `storyboard_review` | `storyboard_queued` · `video_queued` · `needs_revision` |
| `video_queued` | `video_running` · `video_review` / `storyboard_review` (hủy job) · `failed` · `blocked_budget` |
| `video_running` | `video_queued` (mất heartbeat) · `video_review` (complete) · `storyboard_review` (hủy job) · `failed` · `blocked_budget` |
| `video_review` | `done` · `video_queued` · `storyboard_queued` · `needs_revision` |
| `done` | `video_queued` · `storyboard_queued` · `video_review` · `needs_revision` |
| `needs_revision` | `awaiting_approval` (revise_prompt complete) · `failed` |
| `failed` | `storyboard_queued` · `video_queued` · `awaiting_approval` · `needs_revision` |
| `blocked_budget` | `storyboard_queued` · `video_queued` · `awaiting_approval` |

Điều kiện đi kèm (do endpoint kiểm tra, không chỉ bảng): đi `video_queued` luôn cần có asset storyboard, đủ lượt, đủ credit, cảnh không có job đang chạy.

### 3.3 Enum khác

| Tên | Giá trị |
|---|---|
| `job.type` | `analyze_brief` · `storyboard` · `video` · `revise_prompt` · `edit_plan` (chọn điểm cắt cho bản hoàn chỉnh; không có cảnh, không tốn credit) · `clip_plan` (AI chọn đoạn clip từ video dài, mục 14.4; không có cảnh, không tốn credit) |
| `job.status` | `queued` · `claimed` · `running` · `done` · `failed` · `cancelled` |
| `job.requires_approval` | storyboard=true, video=true, analyze_brief=false, revise_prompt=false, edit_plan=false, clip_plan=false |
| `asset.kind` | `storyboard` · `video` · `grid` |
| `verdict` | `pass` (Đạt) · `fix_in_edit` (Sửa khi dựng) · `redo` (Tạo lại) · `null` (chưa đánh giá) |
| `comment.action` | `note` · `revise_and_regenerate` · `regenerate_same` · `regenerate_storyboard` |
| `comment.author` | `user` · `claude` |
| `prompt_version.created_by` | `claude` · `user` |
| `project.status` | `draft` (chưa gửi brief, hoặc phân tích lỗi/bị hủy khi chưa có cảnh) · `analyzing` (có job analyze_brief chưa xong) · `active` (đã phân tích) · `archived` (dành sẵn, chưa có API đặt) |
| `final_cut.status` | `planning` (Claude đang chọn điểm cắt) · `rendering` (server đang render / đang xếp hàng render) · `ready` · `failed` · `cancelled` |
| `final_cut.created_by` | `claude` (tự kích hoạt hoặc `POST /final-cuts`, EDL do Claude; phiên bản tạo từ góp ý khi `edit_plan` do worker legacy) · `agent` (như `claude` khi `edit_plan` do managed worker) · `user` (`rerender`, EDL do người dùng chỉnh; `grade`, chỉnh màu tay; bản thử nhập từ dữ liệu cũ) |
| `final_cut.renderer` | `shotcut` · `ffmpeg` · `null` (chưa render) |
| `final_cut.stage` | khi `status="rendering"`: `render` (đang dựng) · `clean` (đang xoá logo Veo); `null` ở mọi trạng thái khác |
| `final_cut.failed_stage` | khi `failed` (hoặc `cancelled` giữa bước xoá logo): `render` · `clean`; `null` nếu không lỗi/hủy ở bước nào |
| mã lỗi worker `fail.code` | `CAPTCHA` · `LOGIN_REQUIRED` · `FLOW_OUT_OF_CREDIT` · `UI_CHANGED` (4 mã này tạm dừng hàng đợi) · `OTHER` |

---

## 4. Kiểu dữ liệu (object)

### 4.1 Project summary (danh sách dự án, `project.updated`, `POST /brief`)
```json
{
  "id": 1, "slug": "cacao-actiso-plus", "name": "Cacao Actiso Plus",
  "brief": "…", "style_lock": "…",
  "max_attempts_per_scene": 2, "credit_per_video": 15,
  "status": "active", "source": "app", "created_by_name": null,
  "created_at": "…", "updated_at": "…",
  "scene_count": 4, "done_count": 1,
  "status_counts": { "done": 1, "awaiting_approval": 3 },
  "credits_used": 15, "credits_reserved": 0,
  "latest_final_cut": { "id": 3, "version": 2, "status": "ready", "progress": 100, "stage": null, "failed_stage": null, "watermark_removed": true, "url": "/files/output/…/<slug>_final_v2.mp4", "duration_s": 38.2, "outdated": false, "error": null },
  "final_cut_block": null
}
```
`status_counts` chỉ có các trạng thái hiện có (khóa vắng = 0). `credits_used` = credit đã tiêu (−SUM ledger.delta); `credits_reserved` = `credit_per_video` × số job video queued/claimed/running. **Không còn** `credit_budget` / `credits_remaining` (đã bỏ hạn mức credit; cột `projects.credit_budget` vẫn nằm trong DB nhưng server không đọc/hiển thị/nhận nữa). `latest_final_cut` = bản dựng hoàn chỉnh có version cao nhất (gọn; `null` nếu chưa có; `url` = bản đã xoá logo, chỉ có khi `status="ready"`; `stage`/`failed_stage`/`watermark_removed` như ở 4.12; `outdated`: lựa chọn video của dự án đã khác lúc dựng). `final_cut_block` = lý do chưa bấm được "Dựng bản mới" (`null` = được): `{code:"SCENES_NOT_READY", message:"Còn C2, C3 chưa chọn video"}` hoặc `{code:"FINAL_CUT_ACTIVE", message:"Đang chọn điểm cắt cho bản hoàn chỉnh v2"}`. `slug` sinh từ tên lúc tạo (bỏ dấu, `a-z0-9-`, thêm `-2`, `-3` nếu trùng) và **không đổi** khi đổi tên. `source` = `"app"` (tạo từ app chính) hoặc `"lan"` (kế hoạch do người dùng LAN tạo qua trang planner, mục 13); `created_by_name` = tên người tạo do chính người dùng LAN tự nhập (không xác thực), `null` với dự án `app`. Web hiện nhãn **LAN · tên người tạo** ở thẻ dự án và tiêu đề bảng cảnh; chủ máy sản xuất từ dự án `lan` như dự án thường.

### 4.2 Project detail (`GET /api/projects/:id`, `POST`/`PATCH /api/projects`)
Project summary + 
```json
{
  "refs": [ /* Ref[] theo order_index */ ],
  "budget": { /* Credit đã dùng/đặt trước + lượt, xem 4.9 */ },
  "requeued_jobs": [ /* Job[]: job queued/claimed/running đã từng bị trả về do mất heartbeat (banner cảnh báo) */ ]
}
```

### 4.3 Ref (ảnh tham chiếu)
```json
{ "id": 1, "project_id": 1, "label": "Hộp 3/4", "file_path": "refs/1/box.png", "original_name": "box.png",
  "order_index": 0, "content_hash": "db8531bd…(64 ký tự hex)", "created_at": "…", "url": "/files/refs/1/box.png" }
```
`content_hash` = sha256 (hex) nội dung file; server điền khi upload/chép từ thư viện và tự backfill cho ảnh cũ lúc khởi động (`null` nếu file mất). Dùng để gom ảnh trùng nội dung ở nhiều dự án (thư viện ảnh, [5.2](#52-ảnh-tham-chiếu)).

### 4.4 Asset
```json
{ "id": 3, "scene_id": 1, "job_id": 3, "kind": "video",
  "file_path": "output/cacao-actiso-plus/video/C1_v1.mp4", "url": "/files/output/cacao-actiso-plus/video/C1_v1.mp4",
  "attempt": 1, "meta": { "duration_s": 10, "width": 720, "height": 1280 },
  "verdict": "fix_in_edit", "verdict_note": "Chữ trên gói bị méo", "created_at": "…" }
```
`file_path` luôn tương đối từ `ROOT_DIR`; dùng `url` để hiển thị. `job_id` là `null` với asset nhập từ dữ liệu cũ. `grid` (ảnh lưới khung hình) cùng `attempt` với video của nó. Storyboard cũng có thể có `verdict`/`verdict_note` (từ `result.note` của worker).

### 4.5 Job
```json
{
  "id": 3, "project_id": 1, "project_name": "Cacao Actiso Plus", "scene_id": 1, "scene_code": "C1",
  "type": "video", "status": "claimed",
  "payload": { }, "result": null, "error": null, "error_code": null,
  "claimed_by": "w1", "claimed_at": "…", "heartbeat_at": "…", "created_at": "…", "finished_at": null,
  "credits_cost": 0, "requires_approval": true, "approved_at": "…",
  "requeue_count": 0, "last_requeued_at": null,
  "worker_mode": "legacy", "wait_reason": null, "action_state": null, "reconcile_required": false
}
```
`worker_mode` = chế độ của job (`managed` sau khi managed worker claim). `wait_reason` ∈ `ai_quota|needs_reconciliation|browser_offline` (job `queued` đang chờ). `action_state` = trạng thái thao tác tạo bên ngoài hiện hành (`intent|uncertain|submitted|downloaded`, `null` nếu chưa có hoặc đã `abandoned`). `reconcile_required=true`: worker đã dừng và báo `needs_reconciliation` trong khi còn action sống; người dùng cần đối soát (`POST /api/jobs/:id/reconcile`), hủy bị chặn. Job `queued` có action sống nhưng không có `wait_reason` (vd sau `retry_download`, hoặc mất heartbeat khi đã `submitted`) đang chờ worker tiếp tục: vẫn không hủy được và vẫn đối soát được.
`scene_id`/`scene_code` là `null` với `analyze_brief`, `edit_plan` và `clip_plan`. `payload` của job `queued` chỉ là bản sơ bộ; bản đầy đủ được **tính lại lúc claim** (xem [6.3](#63-payload-theo-loại-job)). Thời gian đã chạy = `now − claimed_at` (tính ở client).

### 4.6 Scene summary (`GET /api/projects/:id/scenes`, SSE `scene.updated`, `scene` trong các response thao tác)
```json
{
  "id": 1, "project_id": 1, "code": "C1", "order_index": 0, "title": "Mở đầu",
  "prompt": "…", "first_frame_desc": "…", "upload_refs": [1], "use_prev_storyboard": false,
  "status": "video_review", "selected_video_id": null, "created_at": "…", "updated_at": "…",
  "prompt_version": 2,
  "attempts_used": 1, "max_attempts": 2,
  "storyboard_count": 1, "video_count": 1,
  "storyboard": { /* Asset | null — storyboard mới nhất */ },
  "video":      { /* Asset | null — video được chọn (selected_video_id), nếu chưa chọn thì video mới nhất */ },
  "grid":       { /* Asset | null — ảnh lưới của `video` */ },
  "active_job": { /* Job | null — job queued/claimed/running của cảnh */ },
  "waiting_reason": null,
  "open_comments": 0,
  "storyboard_block": null,
  "video_block": null
}
```
- `attempts_used`: số asset video + job video đang queued/claimed/running + job video failed có `credits_cost>0`. UI hiển thị `attempts_used/max_attempts` ("Cảnh C1 đã dùng 2/2 lượt").
- `waiting_reason` (chuỗi | null): lý do job `queued` của cảnh chưa được worker nhận, vd `"Đang chờ storyboard của C1"`, `"Đã có 4/4 video chạy cùng lúc"`, `"Hàng đợi đang tạm dừng"`.
- `storyboard_block` / `video_block`: `null` nếu bây giờ gọi `approve` stage tương ứng sẽ qua; nếu không là `{ "code": "...", "message": "..." }` đúng với lỗi server sẽ trả (`JOB_ACTIVE`, `INVALID_STATE`, `ATTEMPTS_EXCEEDED`; không còn `BUDGET_EXCEEDED`). **Dùng `message` làm lý do vô hiệu hóa nút**. Lưu ý `video_block` cũng khác `null` khi trạng thái chưa hợp lệ (vd cảnh `awaiting_approval` chưa có storyboard) — UI chỉ hiện nút "Tạo video" ở các trạng thái phù hợp (xem [mục 10](#10-nút-giao-diện--endpoint)) và dùng `video_block` để biết bật/tắt.
- `upload_refs`: mảng id `project_refs` theo thứ tự upload.

### 4.7 Scene detail (`GET /api/scenes/:id`)
Scene summary + 
```json
{
  "project": { "id": 1, "slug": "…", "name": "…", "style_lock": "…", "credit_per_video": 15, "max_attempts_per_scene": 2 },
  "assets": [ /* Asset[] theo id tăng, gồm storyboard/video/grid mọi lượt */ ],
  "comments": [ /* Comment[] theo id tăng */ ],
  "prompt_versions": [ /* PromptVersion[] theo version tăng */ ],
  "jobs": [ /* Job[] mới nhất trước, tối đa 100 */ ],
  "prev_scene_id": null, "next_scene_id": 2
}
```
Comment: `{ "id", "scene_id", "asset_id" (null|số), "author": "user"|"claude", "body", "timecode" (giây, số thực | null), "action", "resolved": false, "created_at" }`.
PromptVersion: `{ "id", "scene_id", "version", "prompt", "reason", "created_by": "claude"|"user", "created_at" }`.

### 4.8 Event (dòng thời gian)
`{ "id", "project_id", "scene_id" (null|số), "scene_code" (null|"C1"), "type", "message", "created_at" }`.
`type` gồm: `scene.status` (message `"C1: storyboard_review → video_queued (lý do)"`), `scene.created`, `scene.prompt`, `scene.video_selected`, `comment.created`, `asset.verdict`, `job.failed`, `job.cancelled`, `job.requeued` (cảnh báo mất heartbeat), `queue.paused`, `queue.resumed`, `project.created`, `project.updated`, `project.brief`, `project.analyzed`.

### 4.9 Budget (`GET /api/projects/:id/budget`) — chỉ còn credit đã dùng/đặt trước và lượt
```json
{
  "used": 15, "reserved": 15,
  "credit_per_video": 15, "max_attempts": 2,
  "scenes": [ { "scene_id": 1, "code": "C1", "attempts_used": 1, "max_attempts": 2 } ]
}
```
`used = −SUM(credit_ledger.delta)`; `reserved = credit_per_video × số job video đang queued/claimed/running`. **Không còn** `budget`, `remaining` (đã bỏ hạn mức credit; server không chặn theo credit ở bất cứ đâu, không còn lỗi `BUDGET_EXCEEDED`). Giới hạn duy nhất khi tạo video là số lượt mỗi cảnh (`ATTEMPTS_EXCEEDED`).

### 4.10 Ledger entry (`credit_ledger`)
`{ "id", "project_id", "scene_id", "scene_code", "job_id", "delta" (âm khi tốn), "note", "created_at" }` (+ `cumulative_used` trong `GET /ledger`: tổng credit đã tiêu lũy kế tới dòng đó, theo thứ tự `created_at, id`; không còn `balance`).

### 4.11 WorkerStatus
```json
{ "online": true, "last_seen_at": "…", "worker_id": "w1",
  "queue_paused": true, "pause_reason": "CAPTCHA: Gặp CAPTCHA", "pause_code": "CAPTCHA", "paused_at": "…" }
```
`pause_code` có thể là `CAPTCHA|LOGIN_REQUIRED|FLOW_OUT_OF_CREDIT|UI_CHANGED` (worker) hoặc `MANUAL` (người dùng). `GET /api/worker/status` thêm `server_time`.

### 4.12 FinalCut (bản dựng hoàn chỉnh)
```json
{
  "id": 3, "project_id": 1, "version": 2, "status": "ready",
  "selection": [ { "scene_id": 1, "code": "C1", "asset_id": 5, "attempt": 2, "video_url": "/files/output/…/C1_v2.mp4", "duration_s": 10.005 } ],
  "selection_signature": "<sha256 hex>",
  "edl": { "scenes": [ { "scene_id": 1, "asset_id": 5, "segments": [ { "in_s": 0, "out_s": 9.5 } ],
                          "removed": [ { "from_s": 9.5, "to_s": 10.005, "reason": "Cuối khung đứng yên" } ], "note": "" } ] },
  "renderer": "shotcut",
  "video_path": "output/<slug>/final/<slug>_final_v2.mp4", "video_url": "/files/output/<slug>/final/<slug>_final_v2.mp4",
  "raw_video_path": "output/<slug>/final/<slug>_final_v2_raw.mp4", "raw_video_url": "/files/output/<slug>/final/<slug>_final_v2_raw.mp4",
  "stage": null, "failed_stage": null, "watermark_removed": true,
  "watermark_meta": { "input": "…", "output": "…", "kind": "video", "meta": { "status": "processed", "denoiseBackend": "…", "actualControls": { "videoBitrateMbps": 12 } } },
  "project_file_path": "output/<slug>/final/shotcut/<slug>_final_v2.mlt",
  "contact_sheet_path": "output/<slug>/final/<slug>_final_v2_contact.png", "contact_sheet_url": "/files/output/<slug>/final/<slug>_final_v2_contact.png",
  "duration_s": 38.2, "job_id": 41, "render_ref": "e1b9…", "progress": 100,
  "created_by": "claude", "note": null, "summary": "Cắt khoảng đứng yên đầu/cuối mỗi cảnh…", "error": null,
  "created_at": "…", "finished_at": "…", "outdated": false,
  "queue_state": null, "queue_position": null, "running_count": null, "concurrency": null, "ai_queue": null
}
```
- **Hàng đợi (trường mới 22/10/2026, chỉ thêm, không đổi trường cũ):**
  - `queue_state`, `queue_position`, `running_count`, `concurrency`: chỉ khác `null` khi `status="rendering"` và việc nằm trong hàng đợi render chung. `queue_state="waiting"` = **đã `rendering` trong DB nhưng CHƯA bắt đầu** (đang đợi chỗ trống; `progress=null`, `renderer=null`), `queue_position` 1 = sẽ chạy tiếp theo (việc của app đứng trước việc LAN); `queue_state="running"` = đang chạy (`queue_position=null`). `running_count` = số việc đang chạy lúc này (bản dựng và việc công cụ), `concurrency` = `RENDER_CONCURRENCY`. Cả bước render lẫn bước xoá logo dùng chung hàng đợi; bước xoá logo chạy tiếp ngay sau render (không xếp hàng lại), nhưng `POST …/clean` xếp hàng riêng nên cũng có thể `waiting` với `stage="clean"`.
  - `ai_queue`: chỉ khác `null` khi `status="planning"` — vị trí job `edit_plan` trong hàng đợi của **worker AI (một worker, tuần tự)**: `{ "state": "waiting"|"running", "position": 2|null, "ahead": 1, "running": {"type":"analyze_brief","own":false}|null, "worker": {"online":true,"paused":false}, "wait_reason": null }`. `position` 1 = job kế tiếp worker nhận (`null` khi `running`); `ahead` = số job **đủ điều kiện, cùng làn worker** (managed hoặc legacy theo `MANAGED_JOB_TYPES`) đứng trước (không tính job worker đang bận); `running` = job worker đang bận (`own=true` nếu chính job này; không lộ id/dự án); `worker.online` false = máy chủ AI chưa sẵn sàng, `paused` = hàng đợi tạm dừng; `wait_reason` (vd `ai_quota`) = job đang bị hoãn. Không có `ai_queue` ở server cũ (trường vắng).
  - `latest_final_cut` (4.1) có thêm `queue_state`, `queue_position`, `ai_queue` cùng ý nghĩa.
  - SSE: `final_cut.updated` được phát thêm khi vị trí hàng đợi đổi (có gộp, tối thiểu ~300 ms giữa hai lượt cho hàng đợi render; hàng đợi AI so sánh mỗi 3 giây khi có người nghe).
- **Góp ý cho AI và chỉnh màu (migration 012, chỉ thêm trường):** `parent_id`, `parent_version` (bản đã được góp ý/chỉnh màu để tạo ra bản này; `null` với bản dựng gốc), `feedback` (góp ý của người dùng, chỉ phiên bản tạo từ góp ý), `grade` (Grade đã áp, `null` = chưa chỉnh màu), `grade_chips` (thông số khác mặc định dạng chữ ngắn: `["Ấm 7200K","Tương phản 1.15"]`), `revision` (`{kind:"ai"|"manual", edl_changed, summary, not_done:[string]}` — trả lời của AI hoặc ghi chú chỉnh tay; `null` khi chưa có), `base_path` (bản sạch **chưa chỉnh màu**, chỉ có khi grade không trung tính; `null` qua LAN). `stage`/`failed_stage` thêm giá trị `"grade"`. `created_by="agent"|"claude"` cho phiên bản tạo từ góp ý, `"user"` cho chỉnh màu tay.
- **Màu theo ảnh mẫu (migration 013, chỉ thêm trường):** `color_ref` = `{id, kind:"image"|"lut", original_name, thumb_url}` của `grade.match` (`null` nếu không dùng; `thumb_url=null` với LUT; qua LAN là URL `/lan/files/…`), để lịch sử phiên bản hiện chip kèm ảnh thu nhỏ.
- **Grade** `{brightness -0.25..0.25 (0), contrast 0.7..1.5 (1), saturation 0.5..1.8 (1), gamma 0.7..1.4 (1), temperature_k 4000..9000 (6500), vibrance -0.5..1 (0), scenes?:[{scene_id, brightness?, contrast?, saturation?, gamma?, temperature_k?}]}`. Server **kẹp** giá trị ngoài khoảng (không báo lỗi), làm tròn 2 chữ số (nhiệt độ: số nguyên), thiếu trường = trung tính, sai kiểu → `400 INVALID_GRADE`. `temperature_k` cao hơn = **ấm hơn**; filter `colortemperature` của ffmpeg ngược lại nên server dùng `13000 − temperature_k`. `scenes[]` là chỉnh THÊM cho riêng một cảnh (áp chồng lên chỉnh chung, `scene_id` phải thuộc bản dựng), khoảng thời gian của cảnh trên video đầu ra = cộng độ dài các đoạn giữ lại của EDL theo thứ tự cảnh, dùng `enable='between(t,a,b)'`. Grade trung tính = không chạy bước chỉnh màu.
- **`grade.match` — Màu theo ảnh mẫu / file LUT (migration 013):** `match?: { kind: "image"|"lut", ref_id, strength 0..1 (0.7), mode: "color"|"full" ("color"), per_scene: bool (false) }`. `ref_id` là id trong `color_refs` của **chính dự án** (mục 5.9) và phải đúng loại, sai → `400 INVALID_GRADE`; `strength` kẹp 0–1 (2 chữ số); `kind="lut"` luôn `mode="color"`, `per_scene=false`; `match: null`/thiếu = không dùng. Có `match` thì grade KHÔNG trung tính (kể cả `strength=0`), tính vào `canonicalGrade`/`gradeHash`/`grade_chips` (chip đầu tiên `"Màu theo ảnh mẫu 70%"`, `"Màu theo file LUT 70%"`, thêm `"Giống cả độ sáng"`, `"Khớp từng cảnh"`; grade cũ không có match giữ nguyên chuỗi chuẩn và hash). **Thuật toán (tất định, không AI):** thống kê trong không gian **lαβ của Reinhard** (sRGB → tuyến tính → LMS → log10 → trực giao hoá; bỏ pixel L*<3 hoặc >97 tính theo CIELAB và viền đen) của ảnh mẫu (1 khung ~256px) và của **bản sạch chưa chỉnh màu** (12 khung rải đều; `per_scene`: 4 khung mỗi cảnh); chuyển Reinhard từng kênh `out = (in − μ_src)·clamp(σ_ref/σ_src) + μ_ref`, tỉ lệ σ của hai kênh sắc kẹp **0,8–1,25** (kênh sáng 0,6–1,6). Lý do chọn lαβ thay vì CIELAB: vết ám màu nhân theo kênh trong ánh sáng tuyến tính (sai cân bằng trắng) thành độ lệch HẰNG của α, β nên chuyển trung bình đưa vùng gần trung tính (bao bì trắng, nền xám) về trung tính; ở CIELAB cùng vết ám phụ thuộc độ sáng nên trắng ngả hồng/vàng (số đo trong `docs/ai/BACKLOG.md`). `mode="color"` chỉ chuyển hai kênh sắc và **giữ nguyên độ chói Y** của điểm gốc (⇔ L*; nhân đều RGB tuyến tính sau khi chuyển), `"full"` chuyển cả kênh sáng `l`; `strength` nội suy trong lαβ giữa màu gốc và màu đã chuyển; ngoài gam sRGB thì giảm độ đậm (giữ độ sáng và hướng sắc). Ghi LUT 3D 33³ `.cube` vào `output/<slug>/final/luts/<hash16>.cube` (hash theo không gian + thống kê ảnh mẫu + video + chế độ + cường độ; dùng lại nếu đã có, không ghi đè; bộ nhớ đệm: giữ ≤ 80 file mỗi dự án, chỉ xoá file cũ hơn 1 giờ). **Grade chỉ lưu thông số, KHÔNG lưu đường dẫn LUT**: LUT được tính lại theo hash khi dựng/xem trước (kết quả tái lập vì ảnh mẫu bất biến và bản sạch của một phiên bản bất biến). `per_scene=true`: mỗi cảnh một LUT riêng áp bằng `lut3d … enable='between(t,a,b)'` theo `outRanges`. File LUT người dùng: lưới LUT đọc lại từ bản chuẩn hoá của server rồi trộn với đồng nhất theo `strength`.
- **Thứ tự filter (`buildGradeFilter`):** (1) xoá logo (đã xong ở bản sạch) → (2) `lut3d=file='…':interp=tetrahedral` (chung, hoặc từng cảnh với `enable`) → (3) `eq` → `colortemperature` → `vibrance` → các chỉnh theo cảnh → (4) `format=yuv420p`. Nhờ LUT đứng trước nên sau khi khớp ảnh mẫu vẫn góp ý "ấm hơn" được. Đường dẫn `file=` được thoát ký tự cho ffmpeg (dấu cách, `:`, `'`, `,`, `[`, `]`, `;`).
- **File của phiên bản chỉnh màu:** bản giao vẫn là `<slug>_final_v<n>.mp4` (đã chỉnh màu). Bản sạch chưa chỉnh màu là `<slug>_final_v<n>_base.mp4` (CHỈ khi grade không trung tính). Phiên bản chỉ đổi màu **không render, không xoá logo lại**: bản sạch của nó là **hard link** (dự phòng sao chép) tới bản sạch của bản cha (`base_path` của bản cha, hoặc `video_path` nếu bản cha chưa chỉnh màu) nên mọi vòng chỉnh màu đều chạy từ bản gốc, không chỉnh chồng. Không bao giờ ghi đè file có sẵn. Lưới khung hình của bản đã chỉnh màu: `<slug>_final_v<n>_contact_graded.png` (nếu bước render đã có `_contact.png`). Ảnh xem trước nằm ở `output/<slug>/final/preview/`.
- **Thứ tự bắt buộc: xoá logo Veo TRƯỚC, chỉnh màu SAU** (gwr tính ngược alpha từ màu gốc của logo). Pipeline: `render → clean → grade` (bước `grade` có `stage="grade"`, `progress` riêng, hủy được, dùng chung hàng đợi render/`RENDER_CONCURRENCY`).
- `selection` = video đang được chọn của từng cảnh **lúc tạo bản dựng**, theo thứ tự cảnh (`video_url`, `duration_s` là phần bổ sung để vẽ timeline/trình phát nguồn; `duration_s` có thể `null` nếu không đọc được). `selection_signature` = sha256 của danh sách `(scene_id, asset_id)`.
- `outdated` = `selection_signature` khác lựa chọn video **hiện tại** của dự án (đã đổi video được chọn sau khi dựng).
- `edl` là `null` khi còn `planning` (và ở bản `failed`/`cancelled` trước bước chọn điểm cắt). Dạng đã **chuẩn hóa** (số làm tròn mili giây, luôn có `removed` và `note`; nếu EDL gửi lên không có `removed` thì server suy ra từ khoảng trống giữa các đoạn với lý do "Bỏ khi chỉnh tay").
- **Xoá logo Veo** (bước bắt buộc sau render, trừ khi `WATERMARK_REMOVER=off`): `raw_video_path` = bản render còn logo (`<slug>_final_v<n>_raw.mp4`), `video_path` = bản ĐÃ xoá logo (tên chính `<slug>_final_v<n>.mp4`, là bản hiển thị và tải về). `watermark_removed` = `true` khi `video_path` là bản sạch. `watermark_meta` = JSON stdout của tool (`null` nếu không có). `raw_video_url` có khi có `raw_video_path` (kể cả bản `failed` ở bước clean — dùng cho link nhỏ "Tải bản gốc còn logo"); **không bao giờ hiển thị raw như bản hoàn chỉnh**. `.mlt` và contact sheet giữ như cũ (dựng từ video gốc còn logo, nên dự án Shotcut vẫn còn logo).
- `stage`: trong lúc `status="rendering"` cho biết đang `render` hay `clean`; `progress` 0–100 **riêng cho từng bước** (bước clean bắt đầu lại từ 0, ghi tối đa mỗi 1 giây); `null` khi xong. Hai bước dùng chung một hàng đợi render chạy song song tối đa `RENDER_CONCURRENCY` việc (mặc định 2).
- Thất bại ở bước clean: `status="failed"`, `failed_stage="clean"`, `error="Xoá logo Veo thất bại: …"` (rút gọn stderr của tool), `video_path=null`/`video_url=null`, **giữ `raw_video_path`**. Tắt tool (`off`) hoặc không có tool: bỏ bước clean — `video_path` = bản render, `raw_video_path=null`, `watermark_removed=false` (UI ghi "chưa xoá logo"). Bản `ready` cũ (render trước khi có bước này) có `watermark_removed=false`, `raw_video_path=null`.
- `video_url`/`contact_sheet_url` chỉ có khi `status="ready"`; `video_path`/`contact_sheet_path` cũng chỉ được ghi khi render xong. `project_file_path` (.mlt) được ghi ngay khi Shotcut tạo xong file dự án (kể cả khi sau đó render lỗi); **ffmpeg không có `.mlt`** (`null`).
- `progress`: `null` khi `planning` hoặc đang xếp hàng render; 0–100 khi `rendering` (ghi tối đa mỗi 1 giây); `100` khi `ready`. `render_ref` = mã job render của Shotcut MCP (`null` với ffmpeg). `error` có khi `failed` (vd "Server khởi động lại trong lúc render; bấm Render lại", "Xoá logo Veo thất bại: …"). `job_id` = job `edit_plan` (`null` với bản `rerender` và bản nhập từ dữ liệu cũ).
- Bản thử nhập từ dữ liệu cũ (Cacao): `created_by="user"`, `renderer="shotcut"`, `note="Bản thử Shotcut MCP, điểm cắt đặt tay (chưa qua Claude phân tích)"`, `summary=null`.

---

## 5. API người dùng (web)

Không cần token. Lỗi chung: `400 VALIDATION_ERROR`, `404 NOT_FOUND`, `403 FORBIDDEN_*`.

### 5.1 Dự án

**`POST /api/projects`** → `201` Project detail. Trường `credit_budget` (nếu client cũ còn gửi) bị **bỏ qua**.
Body: `{ "name": string (bắt buộc), "brief"?: string, "style_lock"?: string, "max_attempts_per_scene"?: int 1–20 (mặc định 2), "credit_per_video"?: int ≥0 (mặc định 15) }`.

**`GET /api/projects`** → `Project summary[]`, mới tạo trước.

**`GET /api/projects/:id`** → Project detail.

**`PATCH /api/projects/:id`** → Project detail. Body (mọi trường tùy chọn): `name, brief, style_lock, max_attempts_per_scene, credit_per_video` (`credit_budget` nếu gửi thì bị bỏ qua). Không đổi `slug`. Nâng `max_attempts_per_scene` để mở khóa cảnh bị `ATTEMPTS_EXCEEDED`.

**`DELETE /api/projects/:id`** — chuyển dự án vào **thùng rác** (mục 5.8), KHÔNG xoá cứng. Body bắt buộc `{ "confirm_name": string }` phải trùng tên dự án (NFC, bỏ khoảng trắng đầu/cuối, phân biệt hoa thường). `200 { ok, id, name, restorable_days }`. Lỗi: `400 VALIDATION_ERROR` (thiếu `confirm_name`), `400 CONFIRM_MISMATCH`, `404`, `409 PROJECT_BUSY` (đang bị chặn, `details.reasons[]={code,message}`), `500 TRASH_MOVE_FAILED` (đã hoàn tác). `GET /api/projects/:id` có thêm `delete_block` (`null` hoặc `{code,message,reasons[]}`) để giao diện báo trước.

**`POST /api/projects/:id/brief`** → `201 { "project": ProjectSummary, "job": Job }`. Body tùy chọn `{ "brief"?: string }` (cập nhật brief trước khi gửi). Tạo job `analyze_brief`, `project.status='analyzing'`. Lỗi: `400 VALIDATION_ERROR` (brief rỗng), `409 JOB_ACTIVE` (đang có job analyze_brief chưa xong). Gửi lại khi đã có cảnh được phép (Claude upsert theo mã cảnh).

### 5.2 Ảnh tham chiếu

**`POST /api/projects/:id/refs`** — `multipart/form-data` → `201 Ref[]` (các ảnh vừa tạo, theo thứ tự gửi).
- Trường `file` (có thể nhiều file). Trường tùy chọn `label` **phải đứng ngay trước** `file` mà nó gắn nhãn. Không có `label` thì nhãn = tên file bỏ đuôi.
- Kiểm tra bằng **magic bytes** (png/jpg/webp), không tin Content-Type/đuôi. Tối đa 10MB/file, 20 file/lần. File lưu `refs/<projectId>/<tên-đã-làm-sạch>.<png|jpg|webp>` (đuôi theo loại thật; trùng tên thêm `-2`, `-3`), `content_hash` được ghi luôn. Upload **không** tự khử trùng (khác `from-library`). Cả lô tất-cả-hoặc-không.
- Lỗi: `415 UNSUPPORTED_FILE_TYPE`, `413 FILE_TOO_LARGE`, `400 INVALID_FILENAME` (tên có `..`, `/`, `\`), `400 NO_FILE`, `404`.

**`GET /api/ref-library?projectId=<id tùy chọn>`** — thư viện ảnh tham chiếu dùng lại giữa các dự án → mảng, mỗi phần tử là MỘT ảnh duy nhất theo `content_hash` (gom các ref trùng nội dung ở nhiều dự án), **mới nhất trước** (theo `created_at` của bản ghi được chọn, rồi `ref_id` giảm dần):
```json
[ { "ref_id": 12, "file_path": "refs/2/Hop-3-4.png", "url": "/files/refs/2/Hop-3-4.png",
    "label": "Hộp 3/4", "original_name": "Hộp 3-4.png", "content_hash": "db8531bd…",
    "created_at": "2026-10-19T09:59:01.107Z",
    "projects": [ { "id": 2, "name": "Dự án B" }, { "id": 1, "name": "Cacao Actiso Plus" } ],
    "in_project": false } ]
```
- `ref_id`/`file_path`/`url`/`label`/`original_name`/`created_at` lấy từ bản ghi **mới nhất mà file còn tồn tại**; ảnh mà mọi bản ghi đều mất file bị bỏ hẳn. `projects` = mọi dự án có ảnh cùng hash (mới nhất trước). `url` là phần bổ sung (dùng làm thumbnail `<img src>`).
- `in_project`: `true` nếu dự án `projectId` đã có ảnh cùng hash (UI hiện "Đã có" và không cho chọn); `false` khi không truyền `projectId`. `projectId` không tồn tại → `404`, không phải số → `400`. Thư viện trống = `[]`.
- Ảnh cũ chưa có `content_hash` được backfill (đọc file) trước khi liệt kê.

**`POST /api/projects/:id/refs/from-library`** body `{ "ref_ids": int[] (1–20), "labels"?: { "<ref_id>": "nhãn mới" } }` → `201 Ref[]` (cùng hình dạng như upload, **đúng thứ tự `ref_ids`**). Với mỗi ref nguồn: **chép file** vào `refs/<id>/` qua cùng đường với upload (tên đã làm sạch, trùng tên thêm `-2`…; không dùng chung đường dẫn nên xóa ở dự án này không hỏng dự án kia), giữ nhãn nguồn (hoặc `labels[ref_id]`), nối vào cuối danh sách (`order_index` kế tiếp) theo thứ tự `ref_ids`. **Idempotent theo `content_hash`**: dự án đã có ảnh cùng hash thì không chép, trả lại ref sẵn có (nhãn hiện có giữ nguyên); `ref_id` lặp trong một lô cho cùng một ref. Dữ liệu tất-cả-hoặc-không. Lỗi: `404` (dự án hoặc bất kỳ ref nguồn nào không tồn tại — không ảnh nào được thêm), `409 FILE_MISSING` (file nguồn mất và dự án chưa có ảnh cùng hash), `400 VALIDATION_ERROR` (`ref_ids` rỗng / >20 / sai kiểu).
Mọi thay đổi ảnh tham chiếu (upload, chép từ thư viện, đổi nhãn, sắp xếp, xóa) phát SSE `project.updated`.

**`GET /api/projects/:id/refs`** → `Ref[]`.
**`PATCH /api/refs/:id`** body `{ "label": string }` → Ref.
**`PATCH /api/refs/reorder`** body `{ "project_id": int, "ids": int[] }` (đúng bằng tập id ảnh của dự án) → `Ref[]` đã sắp xếp; sai tập → `400 INVALID_REFS`.
**`DELETE /api/refs/:id`** → `{ "ok": true }`. Xóa cả file và gỡ id khỏi `upload_refs` của các cảnh.

### 5.3 Cảnh

**`GET /api/projects/:id/scenes`** → `Scene summary[]` theo `order_index`.

**`GET /api/scenes/:id`** → Scene detail.

**`PATCH /api/scenes/:id/prompt`** body `{ "prompt": string, "reason"?: string }` → `{ "scene": SceneSummary }`. Tạo `scene_prompt_versions` mới (`created_by='user'`, reason mặc định "Người dùng sửa tay"), cập nhật `scenes.prompt`, **không đổi trạng thái**. Prompt không đổi → không tạo version. Chỉ khi trạng thái ∈ {`draft, prompt_ready, awaiting_approval, storyboard_review, video_review, done, failed, blocked_budget`}, ngược lại `409 INVALID_STATE`.

**`POST /api/scenes/:id/approve`** body `{ "stage": "storyboard" | "video" }` → `{ "scene": SceneSummary, "job": Job }`.
- `storyboard` (không tốn credit): từ `awaiting_approval | storyboard_review | video_review | done | failed | blocked_budget` → tạo job storyboard (`requires_approval=true`, `approved_at=now`), cảnh → `storyboard_queued`.
- `video` (**tốn credit**, đường duy nhất tạo job video): kiểm tra theo thứ tự trong một transaction `BEGIN IMMEDIATE`: không có job đang queued/claimed/running (`409 JOB_ACTIVE`) → trạng thái ∈ {`awaiting_approval, storyboard_review, video_review, done, failed, blocked_budget`} (`409 INVALID_STATE`) → cảnh đã có asset storyboard (`409 INVALID_STATE`, "chưa có storyboard") → lượt `< max_attempts_per_scene` (`409 ATTEMPTS_EXCEEDED`, "Cảnh C1 đã dùng 2/2 lượt"). **Không kiểm tra hạn mức credit** (đã bỏ). Qua hết → job video, cảnh → `video_queued`, credit được **đặt trước** (`reserved`, chỉ để hiển thị).
- Flow vẫn trừ credit thật nên giao diện phải hỏi xác nhận (ghi rõ số credit sắp tiêu và lượt, vd 1/2 → 2/2) trước khi gọi `stage:"video"`.

**`POST /api/scenes/:id/comments`** body `{ "body": string, "timecode"?: number ≥0 (giây), "action"?: "note"|"revise_and_regenerate"|"regenerate_same"|"regenerate_storyboard" (mặc định note), "asset_id"?: int }` → `201 { "comment": Comment, "job": Job | null, "scene": SceneSummary }`.
- `note`: chỉ lưu comment.
- `revise_and_regenerate`: cảnh → `needs_revision` + job `revise_prompt` (`requires_approval=false`). **Không tạo job video.** Sau khi Claude sửa xong: cảnh → `awaiting_approval` với version prompt mới (`created_by='claude'` kèm lý do), video cũ được giữ; người dùng duyệt lại rồi mới tạo video. Cần trạng thái ∈ {`storyboard_review, video_review, done, awaiting_approval, failed`} và không có job đang chạy.
- `regenerate_same`: gọi `approveVideo` (cùng kiểm tra credit/lượt như trên). UI phải xác nhận credit trước khi gửi.
- `regenerate_storyboard`: gọi `approveStoryboard`.
- Với các action có tác dụng phụ, nếu bị từ chối (409) thì **comment cũng không được lưu** (một transaction).
- `asset_id` phải thuộc cảnh (`404`/`400 INVALID_ASSET`).

**`PATCH /api/comments/:id`** body `{ "resolved": boolean }` → Comment.

**`POST /api/scenes/:id/select-video`** body `{ "asset_id"?: int }` → `{ "scene": SceneSummary }`. Chỉ khi cảnh `video_review` (→ `done`) hoặc `done` (chỉ đổi `selected_video_id`). `asset_id` phải là asset `video` của cảnh (`400 INVALID_ASSET`); bỏ trống = video đang chọn hoặc mới nhất. Sai trạng thái → `409 INVALID_STATE`.

**`POST /api/scenes/:id/reset`** (không body) → `{ "scene": SceneSummary }`. Cảnh `failed`/`blocked_budget` → `awaiting_approval` (để sửa prompt hoặc duyệt lại). Sai trạng thái → `409 INVALID_STATE`.

**`POST /api/assets/:id/verdict`** body `{ "verdict": "pass"|"fix_in_edit"|"redo"|null, "verdict_note"?: string|null }` (alias `note`) → `{ "asset": Asset, "scene": SceneSummary }`. Chỉ storyboard/video (grid → `400 INVALID_ASSET`). Khi `verdict` khác null thì append một dòng ghi chú vào `output/<slug>/log.md` ("… (kết luận của người dùng)"). Phát SSE `asset.updated` + `scene.updated`.

### 5.4 Duyệt hàng loạt

**`GET /api/projects/:id/approve-all/preview?stage=storyboard|video`** →
```json
{ "stage": "video", "count": 2,
  "scenes": [ { "scene_id": 1, "code": "C1", "title": "…", "status": "storyboard_review", "credits": 15 } ],
  "skipped": [ { "scene_id": 3, "code": "C3", "reason_code": "ATTEMPTS_EXCEEDED", "message": "Cảnh C3 đã dùng 2/2 lượt" } ],
  "total_credits": 30, "credit_per_video": 15 }
```
Cảnh đủ điều kiện: `stage=storyboard` → cảnh `awaiting_approval`; `stage=video` → cảnh `storyboard_review`. Cảnh đúng trạng thái nhưng không qua kiểm tra (đủ lượt, đang có job…) nằm trong `skipped`.  Không còn `remaining`/`affordable` (đã bỏ hạn mức).

**`POST /api/projects/:id/approve-all`** body `{ "stage": "storyboard"|"video", "expectedCredits": int }` → `{ "stage", "count", "total_credits", "jobs": [ { "scene_id", "code", "job_id" } ] }`.
`expectedCredits` = tổng credit người dùng đã xác nhận trong hộp thoại (bắt buộc với `video`; `storyboard` mặc định 0). **Tất-cả-hoặc-không** trong một transaction:
`409 NOTHING_TO_APPROVE` (không có cảnh nào) · `409 CREDITS_CHANGED` (`details: {expected, actual}`: tổng thực tế khác `expectedCredits` — hiển thị lại preview).

### 5.5 Hàng đợi, job, worker status

**`GET /api/jobs?projectId=&status=&type=&limit=`** → `Job[]` mới nhất trước (id giảm dần). `status` và `type` nhận nhiều giá trị cách nhau dấu phẩy (`status=queued,claimed,running`); giá trị sai → `400`. `limit` mặc định 200, tối đa 1000.
**`GET /api/jobs/:id`** → Job.
**`POST /api/jobs/:id/cancel`** → `{ "job": Job, "scene": SceneSummary | null }`. Hủy job `queued/claimed/running` (đã `done/failed/cancelled` → `409 INVALID_STATE`). Job **managed** đã có action `intent|uncertain|submitted|downloaded` → `409 RECONCILIATION_REQUIRED` (dùng `reconcile` bên dưới để credit/lượt được ghi đúng). Cảnh về trạng thái ổn định: job storyboard → có storyboard ? `storyboard_review` : `awaiting_approval`; job video → có video ? `video_review` : `storyboard_review`; job revise_prompt → `awaiting_approval`; job analyze_brief → project `draft`/`active`. Credit đặt trước được giải phóng. Worker đang chạy job sẽ nhận `409 JOB_CANCELLED` ở heartbeat/complete/fail kế tiếp.
**`POST /api/jobs/:id/reconcile`** body `{ "outcome": "retry_download"|"nothing_created"|"charge_and_fail", "note"?: string(≤500) }` → `{ "job": Job, "scene": SceneSummary | null, "replay": boolean }`. Đối soát job **managed** đã gửi lệnh tạo sang Flow/ChatGPT mà chưa rõ kết quả (thường `reconcile_required`): job `queued` (không có worker giữ) với action `intent|uncertain|submitted|downloaded`. Một transaction, idempotent (lặp lại cùng `outcome` → `replay:true`, không ghi sổ thêm), ghi event `job.reconciled` và bảng `job_reconciliations`.
- `retry_download`: kết quả đã tạo bên ngoài → action `intent|uncertain` → `submitted`, xóa `wait_reason`; worker resume giữ checkpoint, **không thể submit lại** (journal chỉ cho phép một action sống mỗi job).
- `nothing_created`: người dùng xác nhận không có gì được tạo → action `abandoned`, xóa checkpoint; job chạy lại từ đầu với action id mới `media-<job>-<n>`. Từ chối (`409 RECONCILE_DOWNLOADED`) nếu action đã `downloaded`.
- `charge_and_fail` (chỉ job `video`, ngược lại `400 INVALID_OUTCOME`): đã tốn credit nhưng không lấy được kết quả → job `failed`, `credits_cost = payload.credits_expected`, ledger ghi **một lần**, tính một lượt. Từ chối nếu action đã `downloaded`.
Lỗi: `409 INVALID_STATE` (job không chờ đối soát / đang do worker giữ) · `409 ALREADY_RECONCILED` (đã đối soát bằng lựa chọn khác) · `404` · `400`.
**`POST /api/ai/jobs/:id/resume`** (quản trị AI, cần phiên) bỏ chờ `ai_quota/browser_offline` của job `queued`; job `needs_reconciliation` → `409 RECONCILIATION_REQUIRED`.
**`GET /api/worker/status`** (không cần token) → WorkerStatus + `server_time`.
**`POST /api/queue/resume`** → WorkerStatus. Bỏ tạm dừng (nút "Tiếp tục hàng đợi"). Cảnh đã `failed` vẫn giữ nguyên, người dùng duyệt lại thủ công.
**`POST /api/queue/pause`** body `{ "reason"?: string }` → WorkerStatus. Người dùng chủ động tạm dừng (`pause_code="MANUAL"`).
**`GET /api/meta`** → `{ final_renderer: {…}, watermark_remover: {…}, config: {…}, scene_statuses: [{value,label}], job_types, job_statuses, verdicts: [{value,label}], comment_actions, fail_codes }`. `final_renderer` = trình dựng bản hoàn chỉnh đang dùng và lý do (kết quả được nhớ 60 giây):
```json
{ "mode": "auto", "active": "shotcut", "reason": "Tự động: Shotcut MCP sẵn sàng, dựng bằng Shotcut",
  "shotcut": { "configured": true, "ready": true, "detail": null },
  "ffmpeg": { "available": true, "path": "ffmpeg" } }
```
`watermark_remover` = tool xoá logo Veo (kết quả được nhớ 60 giây):
```json
{ "mode": "auto", "active": true, "reason": "Tự động: tool xoá logo Veo sẵn sàng", "cli": "/…/gemini-watermark-remover/bin/gwr.mjs" }
```
`mode` ∈ `auto|off`; `active=false` khi `off`, chưa cấu hình/thiếu `GWR_CLI`, hoặc `--help` lỗi (`reason` nêu rõ; bản dựng khi đó ra thẳng bản còn logo). `active` (trình dựng) ∈ `shotcut|ffmpeg|null` (null = không có trình dựng khả dụng; `reason` nói rõ vì sao). `shotcut.detail` giải thích khi chưa cấu hình / `--check` hỏng (vd "Chưa cấu hình SHOTCUT_MCP_PYTHON và SHOTCUT_MCP_SERVER_SCRIPT").
**`GET /api/health`** → `{ ok: true, time }`.

**`GET /api/lan`** (chỉ app chính) → `{ enabled, listening, error, host, port, urls: string[], require_code: boolean, access_code: string|null, plan_count, tool_jobs_24h, queue: {cuts, tools, total, cap}, render: {running_count, waiting_count, concurrency}|null }` (`require_code` = `LAN_REQUIRE_CODE`; **`access_code` chỉ khác `null` khi `require_code=true`** và có mã; `tool_jobs_24h` = số việc xoá logo tạo trong 24 giờ; `queue` = việc từ LAN đang trong hàng đợi và trần 6; `render` = hàng đợi render chung: đang chạy / đang chờ / `RENDER_CONCURRENCY`). Dữ liệu cho khối **Chia sẻ LAN** (nút trên header web): trạng thái, các URL `http://<IP LAN>:<LAN_PORT>` (IPv4 không loopback của máy), "Không cần mã truy cập" hoặc (khi `require_code`) mã truy cập (ẩn/hiện + sao chép), hướng dẫn bật bằng `.env`. Chỉ báo cáo, không sửa `.env`. Mã truy cập chỉ trả khi `enabled` và `require_code`; route này không tồn tại trên listener LAN (mục 13).

### 5.6 Dòng thời gian, sổ cái, xuất file

**`GET /api/projects/:id/events?sceneId=&limit=&before=`** → `Event[]` mới nhất trước. `sceneId` lọc theo cảnh (dòng thời gian trang chi tiết cảnh); `before=<event id>` để lấy trang cũ hơn; `limit` mặc định 200, tối đa 1000.
**`GET /api/projects/:id/ledger`** → `{ "totals": { "used", "reserved" }, "entries": [ LedgerEntry + cumulative_used ] }` (sắp theo `created_at, id`; `cumulative_used` = tổng credit đã tiêu lũy kế tới dòng đó, vd `[15, 30, 45]`). Không còn `balance`/`budget`/`remaining`.
**`GET /api/projects/:id/budget`** → Budget (4.9).
**`GET /api/projects/:id/ledger.csv`** → `text/csv; charset=utf-8` có BOM, `Content-Disposition: attachment; filename="ledger-<slug>.csv"`. Cột: `STT,Thời gian,Cảnh,Job,Credit,Lũy kế đã dùng,Ghi chú`.
**`GET /api/projects/:id/log.md`** → `text/markdown`, tải về (`log-<slug>.md`), sinh từ assets theo bảng `| clip | lần | loại | lỗi thấy được | kết luận |` (grid không có dòng riêng). Khác với file `output/<slug>/log.md` trên đĩa (worker append dòng khi có asset mới).

### 5.7 Bản dựng hoàn chỉnh (final cut)

Khi **mọi cảnh có video được chọn**, Claude (job `edit_plan`) xem video từng cảnh và trả **EDL** (đoạn giữ / đoạn cắt); **server tự render nền** (không cần worker) ra `output/<slug>/final/<slug>_final_v<n>.mp4`. Chuyển cảnh là **cắt thẳng**, giữ âm thanh (ffmpeg thêm afade 20ms ở mỗi chỗ nối). Lỗi chung: `404`, `403 FORBIDDEN_*`.

**Tự kích hoạt**: ngay sau khi người dùng chọn video (`select-video`) mà MỌI cảnh của dự án đều `done` có `selected_video_id`, và chưa có bản dựng nào (không tính `failed`/`cancelled`) cho lựa chọn video hiện tại → server tạo final_cut `planning` (created_by `claude`) + job `edit_plan` (không cần duyệt, không tốn credit). Idempotent và an toàn với race (một transaction `BEGIN IMMEDIATE`); đổi video được chọn sang video khác thì tự tạo bản mới. Không có kích hoạt lúc khởi động server, và `import:legacy` không bao giờ kích hoạt.

**`GET /api/projects/:id/final-cuts`** → `FinalCut[]` (version giảm dần, mới nhất trước).
**`GET /api/final-cuts/:id`** → FinalCut.

**`POST /api/projects/:id/final-cuts`** (body `{}`) → `201 { "final_cut": FinalCut, "job": Job }`. Dựng bản MỚI (version kế tiếp) + job `edit_plan`, kể cả khi đã có bản cũ ("Dựng bản mới"). Lỗi: `409 SCENES_NOT_READY` (message liệt kê mã cảnh: "Còn C2, C3 chưa chọn video"; hoặc "Dự án chưa có cảnh nào") · `409 FINAL_CUT_ACTIVE` (đang có bản `planning`/`rendering` của dự án).

**`POST /api/final-cuts/:id/rerender`** body `{ "edl": Edl, "note"?: string }` → `201 { "final_cut": FinalCut }`. Người dùng chỉnh điểm cắt: tạo version **MỚI** (`created_by="user"`, cùng `selection`/`selection_signature` như bản gốc nên có thể `outdated=true`), `status="rendering"`, render ngay, **không qua worker, không tốn credit**; bản cũ giữ nguyên. Lỗi: `400 INVALID_EDL` (không tạo version nào) · `409 FINAL_CUT_ACTIVE` (đang có bản `rendering` của dự án — render lần lượt từng bản).

**`POST /api/final-cuts/:id/cancel`** (không body) → `{ "final_cut": FinalCut }` (`status="cancelled"`). `planning`: hủy luôn job `edit_plan` (worker đang giữ nhận `409 JOB_CANCELLED`); `rendering`: dừng ffmpeg / gọi `cancel_render` của Shotcut, bản dở bị xóa; **đang ở bước xoá logo**: dừng cả cây tiến trình của tool (node + Chromium), xóa file tạm, **giữ bản raw** và ghi `failed_stage="clean"` để còn bấm `clean`; **đang ở bước chỉnh màu**: dừng ffmpeg, xóa file tạm, giữ bản sạch và ghi `failed_stage="grade"` để còn bấm `regrade`. `ready/failed/cancelled` → `409 INVALID_STATE`. Hủy job edit_plan ở trang hàng đợi (`POST /api/jobs/:id/cancel`) cũng hủy bản dựng.

**`POST /api/final-cuts/:id/clean`** (không body) → `{ "final_cut": FinalCut }` (`status="rendering"`, `stage="clean"`, `progress=0`, `video_path=null`). Chạy lại **riêng bước xoá logo Veo** (không render lại, không tốn credit): ("Thử xoá logo lại" / "Xoá logo Veo"). Cho phép khi `failed_stage="clean"` (bản `failed`, hoặc `cancelled` giữa bước xoá logo) hoặc khi `ready` mà `watermark_removed=false`. Bản cũ chưa có `raw_video_path` (render trước khi có bước này): server **đổi tên** `<slug>_final_v<n>.mp4` → `<slug>_final_v<n>_raw.mp4` trước (nguyên tử, cập nhật DB), rồi xoá logo ra tên chính. Lỗi: `409 INVALID_STATE` (trạng thái khác, hoặc đã xoá logo rồi) · `409 WATERMARK_REMOVER_UNAVAILABLE` (tool tắt/không chạy được; `message` có lý do) · `409 RAW_EXISTS` (đã có file `_raw.mp4`, không ghi đè) · `409 FILE_MISSING` (mất bản gốc) · `404`.

**`POST /api/final-cuts/:id/feedback`** body `{ "feedback": string }` (1–1000 ký tự, đã cắt khoảng trắng) → `201 { "final_cut": FinalCut, "job": Job }`. Góp ý cho AI trên bản `ready`: tạo phiên bản **MỚI** (`parent_id` = bản đang xem, `feedback`, `status="planning"`, cùng `selection`) + job `edit_plan` mang `payload.revision` (mục 6.5); bản cũ giữ nguyên. Lỗi: `400 VALIDATION_ERROR` · `409 INVALID_STATE` (bản chưa `ready`) · `409 FINAL_CUT_ACTIVE` (dự án đang có bản `planning`/`rendering`) · `409 LOGO_NOT_REMOVED` (tool xoá logo đang bật mà bản này còn logo: phải `clean` trước) · `409 FILE_MISSING` · `404` (kể cả dự án trong thùng rác).

**`POST /api/final-cuts/:id/grade`** body `{ "grade": Grade, "note"?: string(≤500) }` → `201 { "final_cut": FinalCut }`. Chỉnh màu tay: phiên bản mới `created_by="user"`, `status="rendering"`, `stage="grade"`, `revision.kind="manual"`, **không job, không AI, không credit, không render/xoá logo**. Lỗi như `/feedback` cộng `400 INVALID_GRADE`.

**`POST /api/final-cuts/:id/grade-preview`** body `{ "grade": Grade }` → `{ "hash": string, "items": [ { "t": 0.3, "before_url": "/files/…", "after_url": "/files/…" } ×3 ] }`. Ba mốc ở 15% / 50% / 85% thời lượng; mỗi ảnh là một khung JPEG rộng 360 px dựng bằng ffmpeg từ bản sạch (chưa chỉnh màu) của bản đang xem. Cache theo (bản dựng, mốc, hash grade) trong `output/<slug>/final/preview/`, tối đa 120 ảnh mỗi dự án (xoá ảnh cũ nhất), tối đa 2 lượt chạy ffmpeg cùng lúc toàn server. Chỉ bản `ready` (`409 INVALID_STATE`). Có `grade.match` thì dùng đúng LUT như bước dựng thật (lấy mẫu bản sạch trong lượt này, thống kê được nhớ trong bộ nhớ nên kéo thanh cường độ nhanh); ảnh mẫu mất file → `409 COLOR_MATCH_FAILED`; hash khác khi đổi ảnh/cường độ/chế độ/từng cảnh.

**`POST /api/final-cuts/:id/regrade`** (không body) → `{ "final_cut": FinalCut }` (`status="rendering"`, `stage="grade"`). Chạy lại RIÊNG bước chỉnh màu của bản `failed`/`cancelled` có `failed_stage="grade"` (bản sạch hoặc bản cha còn nguyên). Lỗi: `409 INVALID_STATE` · `409 FINAL_CUT_ACTIVE`.

**`POST /api/final-cuts/:id/open-in-shotcut`** (không body) → `{ "ok": true, "project_file_path": "…" }`. macOS: `open -a Shotcut <file .mlt>`. Lỗi: `409 NO_PROJECT_FILE` (bản dựng bằng ffmpeg không có .mlt, hoặc file đã mất) · `409 SHOTCUT_UNAVAILABLE` (không mở được Shotcut).

**EDL** (`edl` trong `rerender`, `result.edl` của job `edit_plan`):
```json
{ "scenes": [ { "scene_id": 1, "asset_id": 5,
                "segments": [ { "in_s": 0, "out_s": 9.5 } ],
                "removed": [ { "from_s": 9.5, "to_s": 10.0, "reason": "Cuối khung đứng yên" } ],
                "note": "" } ] }
```
Server kiểm tra (sai → `400 INVALID_EDL`, message dạng `EDL không hợp lệ — cảnh C2, đoạn 2: in_s = 6 chồng lên đoạn trước (kết thúc ở 6.2)`, `details` có `scene` (mã cảnh) và `segment` (số thứ tự đoạn, từ 1) khi xác định được; lỗi cấu trúc thì `details.path`):
- đủ MỌI cảnh trong `selection`, đúng thứ tự, đúng `scene_id` và `asset_id`;
- mỗi cảnh ≥ 1 đoạn; mỗi đoạn `0 ≤ in_s < out_s ≤ duration` (`out_s` vượt nguồn quá 0,05 s thì lỗi; lệch ít hơn thì cắt về `duration`; nếu không đọc được thời lượng nguồn thì bỏ qua kiểm tra cận trên), **dài ≥ 0,3 giây**, các đoạn **tăng dần, không chồng nhau** (được chạm nhau);
- `removed` (tùy chọn): mỗi mục `from_s < to_s`, `reason` là chuỗi; không ghi thì server suy ra.
`rerender` thiếu `edl` cũng là `400 INVALID_EDL`.

**Render (server, nền, hàng đợi trong tiến trình: tối đa `RENDER_CONCURRENCY` việc chạy cùng lúc, mặc định 2)**
0. Hàng đợi chung cho bản dựng (render và `clean`) của app + LAN và việc công cụ xoá logo LAN. Việc của dự án `app` được lấy trước mọi việc LAN đang chờ (FIFO trong từng nhóm); việc đang chạy không bị ngắt. Hủy chỉ dừng đúng việc đó (việc khác vẫn chạy); hủy rồi xếp lại ngay cùng một việc thì việc mới đợi việc cũ dừng hẳn. Vị trí và số việc đang chạy: `queue_state`/`queue_position`/`running_count`/`concurrency` (4.12).
1. Bản → `rendering` ngay khi có EDL (`progress=null` và `queue_state="waiting"` đến khi có chỗ trống), rồi `queue_state="running"`, `progress=0` và `renderer` được ghi.
2. **Shotcut** (qua MCP stdio): `create_project` (kích thước/fps lấy từ video đầu, mỗi đoạn là một clip theo thứ tự, caption `"C1 v2 #1"`) → `render_contact_sheet` → `start_render` preset `h264-high` → poll `render_status` mỗi 2 giây (timeout 20 phút) → `progress`. Sinh `.mlt` (kèm `.render-<id>.mlt` và `.guard` do MCP tạo, để nguyên).
3. **ffmpeg**: trim + concat (cắt thẳng, giữ âm thanh, afade 20ms ở chỗ nối; nguồn không có âm thanh được chèn im lặng), contact sheet bằng `tile`; không có `.mlt`.
4. **Xoá logo Veo** (bước `clean`, nếu `watermark_remover.active`): bước 1–3 ghi video ra `…_final_v<n>_raw.mp4`; rồi chạy tool ra file tạm `.<tên>.tmp.mp4` cùng thư mục (tiến độ đọc từ stderr `[video] 74% …`), kiểm tra bằng ffprobe (có video, thời lượng lệch ≤ 0,25 s so với raw, có âm thanh nếu raw có) và **đổi tên nguyên tử** sang `…_final_v<n>.mp4`. Tool tắt/không có → bỏ bước này, ghi thẳng tên chính.
5. Xong: `duration_s` bằng ffprobe → `ready`, event `final_cut.ready` (ghi "đã xoá logo Veo" hoặc "chưa xoá logo Veo"), dòng `| FINAL | v<n> | bản dựng (<renderer>, cắt thẳng; đã xoá logo Veo) | <summary hoặc note> | Sẵn sàng |` vào `output/<slug>/log.md` (không có phần "; đã xoá logo Veo" khi chưa xoá; `clean` riêng lẻ thêm dòng `| FINAL | v<n> | xoá logo Veo | … | Sẵn sàng |`). Lỗi ở bước render → `failed` + `error`, `failed_stage="render"`; lỗi ở bước clean → `failed_stage="clean"` (event `final_cut.failed`). Không có trình dựng khả dụng → `failed` ("Không có trình dựng khả dụng: …").
6. **Không bao giờ ghi đè**: version kế tiếp luôn lớn hơn mọi version trong DB và mọi file `<slug>_final_v<n>*` có sẵn trên đĩa (kể cả `.mlt` và `_raw.mp4`), nên `…_final_v<n>.mp4` và `…_final_v<n>_raw.mp4` luôn là file mới. `rerender` đi qua đủ render → clean.

### 5.8 Thùng rác dự án (xoá mềm 30 ngày)

Video trong dự án tốn credit thật nên **không có xoá cứng tức thì**: `DELETE /api/projects/:id` chuyển dự án vào thùng rác; chỉ `DELETE /api/trash/:id` (gõ lại tên) hoặc bộ dọn sau `TRASH_RETENTION_DAYS` ngày mới xoá vĩnh viễn.

**Xoá (`DELETE /api/projects/:id`, hoặc `DELETE /lan/api/plans/:id` cho người tạo ở LAN):**
1. Một transaction: kiểm tra điều kiện chặn → hủy mọi job `queued` bằng `cancelJob` (cảnh/ledger/bản dựng đúng) → đặt `projects.deleted_at`, `deleted_by` (`app`|`lan`), `trash_path` → ghi event `project.deleted`.
2. Sau commit, chuyển file bằng `rename` (cùng ổ): `output/<slug>/` → `output/.trash/<id>-<slug>-<yyyymmddThhmmssZ>/output/`, `refs/<id>/` → `…/refs/` (thư mục không có thì bỏ qua). Lỗi giữa chừng → hoàn tác các thư mục đã chuyển, đặt lại `deleted_at=NULL`, ghi event `project.delete_failed`, trả `500 TRASH_MOVE_FAILED` (dự án giữ nguyên; job queued đã hủy thì không mở lại, bấm duyệt lại được). Khởi động lại sau khi chết giữa commit và chuyển file: bộ dọn hoàn tất việc chuyển dở.

**Điều kiện chặn (`409 PROJECT_BUSY`, lý do tiếng Việt trong `message` và `details.reasons[]`):**
- `JOB_RUNNING`: có job `claimed`/`running`;
- `FINAL_CUT_ACTIVE`: có bản dựng `planning`/`rendering`, hoặc bản dựng còn trong hàng đợi render (kể cả bản vừa hủy mà tiến trình chưa dừng) — gồm cả việc LAN của dự án đang trong hàng đợi;
- `ACTION_LIVE`: job (`queued`/`claimed`/`running`) có thao tác ngoài còn sống (`intent`/`uncertain`/`submitted`/`downloaded`): phải đối soát (4.5, `POST /api/jobs/:id/reconcile`) trước;
- `UPLOAD_ACTIVE`: đang có video LAN được tải lên dự án.
Job `queued` còn lại KHÔNG chặn (bị hủy); job done/failed/cancelled không chặn.

**Dự án đã xoá biến mất ở mọi nơi:** `404` ở mọi API theo id (dự án, cảnh, job, asset, comment, ảnh, bản dựng, `ai-policy`, `/api/stream?projectId=`), không có trong `GET /api/projects`, `/api/jobs`, `/api/ref-library` (cả bản LAN), `GET /lan/api/plans`, `GET /api/lan` (`plan_count`), trần hàng đợi LAN; `/files/*` và `/lan/files/*` không phục vụ file của nó (kể cả `output/.trash/**`); `GET /api/worker/next` không giao job của nó và các API worker theo id job trả 404. **Slug** của dự án trong thùng rác vẫn bị giữ (không cấp lại cho dự án mới) cho tới khi xoá vĩnh viễn. Cơ chế: mọi getter trong `services/repo.ts` nối `projects` và loại `deleted_at IS NOT NULL`; chỉ `getProjectAny` và `services/trash.ts` thấy dự án đã xoá.

**`GET /api/trash`** → `TrashItem[]` (xoá gần nhất trước): `{id,name,slug,source,created_by_name,status,created_at,deleted_at,deleted_by:'app'|'lan',purge_at,days_left,retention_days,size_bytes|null,scene_count,done_count,credits_used,restore_block:string|null}`.

**`POST /api/trash/:id/restore`** → Project detail. Chuyển file về đúng chỗ cũ rồi bỏ đánh dấu xoá, ghi event `project.restored`. **Không bao giờ ghi đè**: nếu `output/<slug>/` hoặc `refs/<id>/` đã có nội dung → `409 RESTORE_CONFLICT` và không đổi gì (cây thư mục rỗng thì được thay). Lỗi di chuyển → hoàn tác, `500 RESTORE_FAILED`. Dự án không ở trong thùng rác → `404`.

**`DELETE /api/trash/:id`** body `{ "confirm_name" }` → `200 { ok, id, name }`. Xoá thư mục thùng rác rồi `DELETE FROM projects`: mọi bảng tham chiếu `projects`/`scenes`/`jobs`/`assets` đều `ON DELETE CASCADE` hoặc `SET NULL` (đã kiểm tra mọi migration; test `project-trash.test.ts` khoá điều này và chạy `PRAGMA foreign_key_check`), nên không cần dựng lại bảng. Sổ credit và nhật ký của dự án mất theo; `ai_attempts.job_id` về NULL. Lỗi: `400 CONFIRM_MISMATCH`, `404`, `500 PURGE_FAILED` (dự án vẫn trong thùng rác).

**Tự dọn:** lúc khởi động và mỗi giờ, xoá vĩnh viễn dự án có `deleted_at` quá `TRASH_RETENTION_DAYS` ngày.

**SSE:** `project.deleted` `{project_id,name,deleted_by}`, `project.restored` `{project}`, `project.purged` `{project_id}` (mục 7).

---

### 5.9 Ảnh mẫu / file LUT cho "Màu theo ảnh mẫu" (`color_refs`, migration 013)
Bảng `color_refs`: `id, project_id (FK CASCADE), kind ('image'|'lut'), file_path, thumb_path, original_name, content_hash, width, height, lut_size, created_by_name, created_at`, `UNIQUE (project_id, content_hash)`. File ở `output/<slug>/final/color-refs/<hash16>.<đuôi>` (+ `<hash16>_thumb.jpg` cho ảnh), đi theo thư mục dự án vào/ra thùng rác; xoá vĩnh viễn dự án xoá luôn dòng (CASCADE).
- `GET /api/projects/:id/color-refs` → `{ "items": ColorRef[], "sources": { "refs": [{id,label,url}], "assets": [{id,scene_code,url}] } }`. `ColorRef` = `{id, kind, original_name, thumb_url, image_url, width, height, lut_size, created_by_name, created_at, used_by:[version]}` (LUT: `thumb_url=image_url=null`, server không phục vụ file LUT). `sources` = ảnh tham chiếu (`project_refs`) và storyboard (mỗi cảnh một ảnh mới nhất) có thể chép làm ảnh mẫu.
- `POST /api/projects/:id/color-refs` multipart: một trường `file` (+ `created_by_name` tuỳ chọn) → `201 { color_ref, existing:false }`; **trùng nội dung trong dự án → `200 { color_ref, existing:true }`** (không thêm dòng/file). Ảnh: png/jpg/webp nhận bằng **magic bytes** (không tin Content-Type/đuôi; GIF/BMP/văn bản đổi đuôi → `415 UNSUPPORTED_FILE_TYPE`), ≤ **15 MB** (`413 FILE_TOO_LARGE`), ffprobe đọc được và tạo được thumb 256px (không thì `400 INVALID_IMAGE`, không để lại file/dòng), cạnh dài ≤ 16384 px. File `.cube` (đuôi `.cube`): ≤ **5 MB**, `LUT_3D_SIZE` 2–65, đọc chặt (từ chối `LUT_1D_SIZE`, từ khoá lạ, thiếu/thừa dòng, số hỏng hoặc ngoài 0–1 ± 0,05, `DOMAIN` khác 0–1, ký tự điều khiển → `400 INVALID_LUT`), server **ghi lại bản chuẩn hoá** (không lưu file gốc; hash tính trên bản chuẩn hoá nên cùng LUT khác định dạng thì trùng). Tên file có `..`/dấu phân cách → `400 INVALID_FILENAME`.
- `POST /api/projects/:id/color-refs/from-asset` body `{ "asset_id" | "ref_id" }` (đúng một): chép ảnh tham chiếu của dự án hoặc storyboard (`assets.kind='storyboard'`) sang `color_refs` (chép, không di chuyển) → `201`/`200 existing` như trên; id của dự án khác hoặc sai loại → `404`; file nguồn mất → `409 FILE_MISSING`.
- `DELETE /api/projects/:id/color-refs/:refId` → `{ok:true}` (xoá dòng + file + thumb); **đang được bản dựng nào dùng (`grade.match.ref_id`) → `409 COLOR_REF_IN_USE`** (thông báo nêu `v2, v3…`); id không thuộc dự án → `404`. Dự án trong thùng rác → mọi route `404`.

## 6. API worker (Claude / sim-worker)

Mọi route dưới đây (trừ `GET /api/worker/status`) cần `Authorization: Bearer <WORKER_TOKEN>`. Mỗi request hợp lệ cập nhật `last_seen_at` của worker (online nếu trong `WORKER_ONLINE_SECONDS`). Định danh worker: query `?worker=<id>` (hoặc header `X-Worker-Id`, hoặc trường `worker` trong body JSON).

### 6.1 Vòng lặp

1. `GET /api/worker/next?worker=<id>` → `200 Job` | `204` (không có việc, chờ rồi gọi lại) | `503 QUEUE_PAUSED` (hàng đợi đang tạm dừng; chờ người dùng bấm tiếp tục).
2. Làm việc, gọi `POST /api/worker/jobs/:id/heartbeat` thường xuyên (mỗi ≤ 60 giây; quá `HEARTBEAT_STALE_MINUTES` job bị trả về hàng đợi).
3. `POST …/complete` hoặc `POST …/fail`.
4. **Mọi `409` ở heartbeat/complete/fail nghĩa là: dừng việc đang làm với job đó** (đã hủy / mất heartbeat và bị giao lại / đã xong).

Worker **không bao giờ** tự tạo job video; chỉ người dùng duyệt (`POST /api/scenes/:id/approve`) mới tạo.

**`GET /api/worker/next`** chọn job `queued` cũ nhất (theo id) đủ điều kiện, trong `BEGIN IMMEDIATE`:
`requires_approval=0 hoặc có approved_at` · hàng đợi không tạm dừng · (job video: số job video `claimed/running` toàn hệ thống `< MAX_CONCURRENT_VIDEO_JOBS`) · (job storyboard của cảnh có `use_prev_storyboard`: cảnh đầu tiên của dự án đã có asset storyboard; cảnh đầu tiên không phụ thuộc chính nó) · cảnh không có job khác `claimed/running`. Claim: `status='claimed'`, `claimed_by`, `claimed_at`, `heartbeat_at`, **payload được tính lại**, cảnh → `*_running` (storyboard/video; revise_prompt giữ `needs_revision`). Job có cảnh không còn ở trạng thái `*_queued` tương ứng bị tự hủy (không giao). Thư mục đầu ra (`output/<slug>/storyboard|video`) được tạo sẵn.
Trả về Job (xem 4.5) với `payload` đầy đủ và `status: "claimed"`.

**`POST /api/worker/jobs/:id/heartbeat`** (body tùy chọn `{}`) → `{ "ok": true, "status": "running", "heartbeat_at": "…" }`. Lần đầu chuyển job `claimed` → `running`. `409 JOB_CANCELLED` nếu job không còn `claimed/running` (đã hủy, bị trả về hàng đợi, đã xong) hoặc đang thuộc worker khác (khi có `?worker=` khác `claimed_by`).

**`GET /api/worker/jobs/:id`** → Job (để kiểm tra trạng thái).
**`GET /api/worker/ping`** → `{ ok: true, server_time, ...WorkerStatus }` (chỉ để báo online).

### 6.2 `complete` và `fail`

**`POST /api/worker/jobs/:id/complete`**
```json
{ "result": { }, "assets": [ { "kind": "video", "file_path": "output/…/C1_v1.mp4", "meta": { "duration_s": 10 } } ], "credits_cost": 15 }
```
→ `200 { "job": Job }` (status `done`). Job phải đang `claimed/running`; không thì `409 JOB_CANCELLED` (job đã hủy) hoặc `409 INVALID_STATE` (queued/done/failed).
`file_path`: tương đối **dưới `output/`**, file phải tồn tại và là file thường (symlink trỏ ra ngoài bị từ chối); sai → `400 INVALID_PATH` / `400 FILE_NOT_FOUND`. Asset được tạo với `attempt = payload.attempt`. Loại asset cho phép theo job: storyboard→`storyboard`; video→`video`,`grid`; hai loại còn lại không nhận asset (`400 INVALID_ASSET_KIND`); thiếu asset chính → `400 ASSET_REQUIRED`.

Theo loại job:
- `storyboard`: ≥1 asset `storyboard`. `result.note`/`result.verdict_note`/`result.verdict` (tùy chọn) gán vào asset. Cảnh → `storyboard_review`. Append dòng vào `output/<slug>/log.md`.
- `video`: ≥1 asset `video` (+ `grid`). `result: { "verdict"?: "pass"|"fix_in_edit"|"redo", "verdict_note"?: string }` gán cho asset video (verdict sai → `400`). Ghi sổ cái `delta = −credits_cost` (`credits_cost` thiếu ⇒ `credit_per_video`; `0` ⇒ không ghi sổ cái). `jobs.credits_cost` = số đó. Cảnh → `video_review`. Append dòng log.md (grid không có dòng riêng).
- `revise_prompt`: `result: { "prompt": string, "reason": string (bắt buộc), "resolved_comment_ids"?: int[] }` (thiếu `prompt`/`reason` → `400`). Tạo `scene_prompt_versions` (created_by `claude`), cập nhật `scenes.prompt`, đánh dấu các comment `resolved` (mặc định tất cả comment trong `payload.comments`), cảnh → `awaiting_approval`. Không tạo video.
- `edit_plan`: xem [6.5](#65-job-edit_plan). Không nhận `assets` (`400 INVALID_ASSET_KIND`), `credits_cost` bị bỏ qua.
- `analyze_brief`: phải đã gọi `POST /api/worker/scenes` (chưa có cảnh nào → `409 NO_SCENES`). Project → `active`.

**`POST /api/worker/jobs/:id/fail`** `{ "error": string, "code"?: "CAPTCHA"|"LOGIN_REQUIRED"|"FLOW_OUT_OF_CREDIT"|"UI_CHANGED"|"OTHER", "credits_cost"?: int }` → `200 { "job": Job, "worker": WorkerStatus }`.
- Job → `failed` (`error`, `error_code`; `code` mặc định `OTHER`). Cảnh → `failed` (job `video` với `FLOW_OUT_OF_CREDIT` → `blocked_budget`). Job analyze_brief: project về `draft`/`active`.
- 4 mã đầu **tạm dừng hàng đợi** (`worker.queue_paused=true`, `pause_reason="<CODE>: <error>"`) và phát SSE `worker.status`; `GET /next` trả `503 QUEUE_PAUSED` cho tới khi người dùng `POST /api/queue/resume`. `OTHER` không tạm dừng.
- `credits_cost > 0` (chỉ job video): ghi sổ cái, và job này **vẫn tính một lượt** (attempts_used).

### 6.3 Payload theo loại job

`requeued` = `requeue_count > 0`: job từng bị trả về do mất heartbeat — worker phải kiểm tra Flow/ChatGPT xem đã tạo chưa trước khi bấm tạo lại để tránh tốn credit hai lần. Mọi đường dẫn là tương đối từ `ROOT_DIR`.

`video`:
```json
{ "project": { "id": 1, "slug": "cacao-actiso-plus", "name": "…", "style_lock": "…" },
  "scene": { "id": 1, "code": "C1", "title": "…", "prompt": "…", "first_frame_desc": "…" },
  "upload_files": [ "refs/1/box.png", "output/cacao-actiso-plus/storyboard/C1_storyboard.png" ],
  "storyboard_path": "output/cacao-actiso-plus/storyboard/C1_storyboard.png",
  "attempt": 1,
  "output": { "video_path": "output/cacao-actiso-plus/video/C1_v1.mp4", "grid_path": "output/cacao-actiso-plus/video/C1_v1_grid.jpg" },
  "settings": { "aspect": "9:16", "duration_s": 10, "count": 1, "resolution": "720p" },
  "credits_expected": 15, "requeued": false }
```
`upload_files` = các ref theo thứ tự `scene.upload_refs`, rồi storyboard mới nhất ở cuối. `attempt` = số video đã có + job video failed có tốn credit + 1.

`storyboard`:
```json
{ "project": { … }, "scene": { … },
  "upload_files": [ "refs/1/box.png", "output/…/storyboard/C1_storyboard.png" ],
  "chatgpt_message": "Tạo 1 ảnh tĩnh duy nhất, khung dọc 9:16, …\nĐây là khung hình MỞ ĐẦU (giây 0) của clip C1.\n…",
  "attempt": 1,
  "output": { "storyboard_path": "output/cacao-actiso-plus/storyboard/C1_storyboard.png" },
  "requeued": false }
```
`chatgpt_message` = lời nhắn gửi ChatGPT dựng sẵn bằng `buildStoryboardMessage` (`server/src/services/plan.ts`, template của WORKER.md 4.2), nhãn ảnh theo đúng thứ tự `upload_files`; worker gửi **nguyên văn**. Trang planner LAN dùng cùng hàm này. `upload_files` = ref theo `upload_refs`, + storyboard mới nhất của **cảnh đầu tiên** nếu `use_prev_storyboard` (và cảnh này không phải cảnh đầu). `attempt` = số storyboard đã có + 1; tên file lượt 1 `C1_storyboard.png`, lượt n≥2 `C1_storyboard_v<n>.png`.

`analyze_brief`:
```json
{ "project": { "id": 1, "slug": "…", "name": "…", "brief": "…", "style_lock": "…", "credit_per_video": 15, "max_attempts_per_scene": 2 },
  "refs": [ { "id": 1, "label": "Hộp 3/4", "file_path": "refs/1/box.png" } ],
  "rules_file": "claude-system-prompt.md", "requeued": false }
```

`revise_prompt`:
```json
{ "project": { … },
  "scene": { "id": 1, "code": "C1", "title": "…", "prompt": "…", "first_frame_desc": "…", "version": 2 },
  "comments": [ { "id": 1, "scene_id": 1, "asset_id": 3, "author": "user", "body": "Thêm kéo cắt gói", "timecode": 1.5, "action": "revise_and_regenerate", "resolved": false, "created_at": "…" } ],
  "requeued": false }
```
`comments` = mọi comment chưa `resolved` của cảnh.

`clip_plan`: xem [14.4](#144-ai-chọn-đoạn-job-clip_plan) (payload gồm `sentences`, `windows`, `duration_preset`, `focus`, `existing`; kết quả `{clips, summary, not_found_reason?}`; AI chỉ trả ID câu). Payload đầy đủ chỉ có ở `claim` và `GET /api/worker/jobs/:id`; `GET /api/jobs`, `GET /api/jobs/:id` và SSE `job.updated` trả bản gọn (`sentence_count`, `window_count`).

### 6.4 Tạo cảnh và comment

**`POST /api/worker/scenes`** (sau `analyze_brief`)
```json
{ "project_id": 1, "scenes": [ { "code": "C1", "order_index": 0, "title": "…", "prompt": "…", "first_frame_desc": "…", "upload_refs": [1, 2], "use_prev_storyboard": false } ] }
```
→ `200 { "created": ["C1"], "updated": [], "skipped": [ { "code", "reason" } ], "scenes": SceneSummary[] }` (toàn bộ cảnh của dự án).
Upsert theo `(project_id, code)`; cả lô tất-cả-hoặc-không. Cảnh mới: `scene_prompt_versions` v1 (`claude`), `draft → prompt_ready → awaiting_approval` (hoặc → `storyboard_queued` + job storyboard khi `REQUIRE_PROMPT_APPROVAL=false`). Cảnh đã có: cập nhật tiêu đề/thứ tự/khung đầu/upload_refs/use_prev; nếu `prompt` khác thì thêm version mới — trừ cảnh đang `*_queued/*_running/needs_revision` (giữ prompt, ghi vào `skipped`). Lỗi: `400 INVALID_REFS` (ref không thuộc dự án), `400 VALIDATION_ERROR` (mã lặp, mã sai định dạng `[A-Za-z0-9_-]{1,16}`, `scenes` rỗng), `404` (dự án).

**Dự án `source='lan'`** (mục 13) có ba khác biệt, vẫn qua endpoint này: (1) **mã cảnh được chuẩn hóa về `C1, C2, …`** (`normalizeSceneCodes`): mọi mã đọc được số thứ tự và khác nhau (`scene_01`, `Scene 2`, `S3`, `04`…) → `C<số>`; có mã không đọc được (`intro`) hoặc hai mã trùng số → đánh số lại `C1..Cn` theo `order_index`. Không bao giờ từ chối vì mã sai dạng, không bao giờ để hai cảnh cùng mã; response thêm `"renamed": [{"from","to"}]` khi có đổi (và ghi event `scene.codes_normalized`); (2) cảnh mới **luôn** vào `awaiting_approval`, **không bao giờ** tự tạo job storyboard kể cả khi `REQUIRE_PROMPT_APPROVAL=false`; (3) phân tích lại thay kế hoạch: cảnh cũ không còn trong kết quả mới, đang `draft/prompt_ready/awaiting_approval` và không có job đang chạy thì bị bỏ (response thêm `"pruned": ["C4"]`); cảnh chủ máy đã duyệt/đang sản xuất được giữ. Dự án `app`: không đổi gì.

**`POST /api/worker/comments`** `{ "scene_id": int, "asset_id"?: int|null, "body": string, "action"?: …, "timecode"?: number|null }` → `201 { "comment": Comment }` với `author="claude"`. Luôn là ghi chú (`action` bị bỏ qua, không có tác dụng phụ).

### 6.5 Job `edit_plan`

Job do server tạo (tự kích hoạt hoặc `POST /api/projects/:id/final-cuts`): `scene_id=null`, `requires_approval=false`, không tốn credit. Chỉ giao khi bản dựng còn `planning` (nếu không, job bị hủy lúc claim).

Payload (tính lúc claim; đường dẫn tương đối từ `ROOT_DIR`):
```json
{ "final_cut_id": 3, "version": 2,
  "project": { "id": 1, "slug": "cacao-smoothie", "name": "…", "style_lock": "…" },
  "scenes": [ { "scene_id": 1, "code": "C1", "title": "…", "prompt": "…", "asset_id": 5, "attempt": 2,
                "video_path": "output/cacao-smoothie/video/C1_v2.mp4", "abs_path": "/…/output/cacao-smoothie/video/C1_v2.mp4",
                "duration_s": 10.005, "fps": 24, "width": 720, "height": 1280,
                "grid_path": "output/cacao-smoothie/video/C1_v2_grid.jpg", "verdict": "pass", "verdict_note": "…",
                "comments": [ { "id": 7, "body": "Chữ méo giây 3", "timecode": 3.2, "…": "Comment" } ] } ],
  "constraints": { "aspect": "9:16", "transition": "cut", "min_segment_s": 0.3, "keep_scene_order": true },
  "output": { "video_path": "output/<slug>/final/<slug>_final_v2.mp4", "project_file_path": "output/<slug>/final/shotcut/<slug>_final_v2.mlt", "contact_sheet_path": "output/<slug>/final/<slug>_final_v2_contact.png" },
  "requeued": false }
```
`scenes` theo thứ tự cảnh. `duration_s/fps/width/height` đọc bằng ffprobe (không có thì lấy từ `asset.meta`, hoặc `null`). `grid_path`/`verdict`/`verdict_note` có thể `null`. `comments` chỉ gồm comment **chưa xử lý có `timecode`**. `output.*` chỉ để biết (worker không ghi file).

`POST /api/worker/jobs/:id/complete` với `{ "result": { "edl": Edl, "summary": "1–3 câu tiếng Việt" } }` (không `assets`, không `credits_cost`):
- hợp lệ → `200 { "job": Job }` (`status="done"`, `credits_cost=0`); final_cut → `rendering` và server render nền (SSE `final_cut.updated`);
- EDL sai → `400 INVALID_EDL` (message nêu cảnh/đoạn); **job vẫn `claimed`/`running` để worker sửa và gọi lại**; thiếu `summary` → `400 VALIDATION_ERROR`;
- job đã bị hủy (bản dựng bị hủy) → `409 JOB_CANCELLED`.
`fail` job `edit_plan` → final_cut `failed` (`error` = nội dung lỗi). Mất heartbeat → job về `queued` như các job khác (`requeued=true`).

**Job `edit_plan` góp ý (`payload.revision`).** Tạo bởi `POST /api/final-cuts/:id/feedback` (cùng loại job `edit_plan`, nên không đổi bảng `jobs`); phân biệt bằng `payload.revision`. Payload là payload thường (vẫn có `scenes[]` với video nguồn) cộng:
```json
"revision": { "parent_cut_id": 3, "parent_version": 2, "feedback": "Màu ấm hơn, tương phản cao hơn",
  "parent_edl": { "scenes": [ … ] }, "parent_grade": { "brightness": 0, "contrast": 1, "saturation": 1, "gamma": 1, "temperature_k": 6500, "vibrance": 0 },
  "grade_ranges": { "temperature_k": { "min": 4000, "max": 9000, "neutral": 6500, "digits": 0 }, "…": {} },
  "feedback_history": [ { "version": 2, "kind": "ai", "feedback": "ấm hơn", "summary": "…", "not_done": [], "grade_chips": ["Ấm 7100K"] } ],
  "scenes": [ { "scene_id": 1, "code": "C1", "title": "…", "prompt": "(≤300 ký tự)", "duration_s": 10 } ],
  "timeline": [ { "scene_id": 1, "code": "C1", "out_start_s": 0, "out_end_s": 9 } ],
  "contact_sheet": "output/<slug>/final/<slug>_final_v2_contact.png" }
```
`parent_grade.match` (nếu bản cha dùng ảnh mẫu / LUT) = `{kind, ref_id, strength, mode, per_scene, original_name}` (kèm tên ảnh để AI hiểu). **AI giữ nguyên `match`** trừ khi góp ý yêu cầu bỏ/đổi ("bỏ ảnh mẫu" → `match:null`; "giống ảnh mẫu hơn" → `strength` +0.15; "nhẹ thôi" → −0.2) và **không tự chọn ảnh mẫu mới**: server quyết `match` của phiên bản mới — `grade` thiếu khoá `match` (hoặc thiếu hẳn/`null`) → giữ của bản cha; `match:null` → bỏ; `match` là đối tượng → chỉ nhận `strength`/`mode`/`per_scene` hợp lệ đè lên bản cha, `kind`/`ref_id` luôn lấy từ bản cha, bản cha không có match thì mọi `match` AI thêm bị bỏ qua.
`feedback_history` = tối đa 5 góp ý/chỉnh tay gần nhất đi ngược theo chuỗi bản cha (cũ → mới), để "ấm hơn nữa" được hiểu tương đối với `parent_grade`. `timeline` = khoảng của từng cảnh trên video hiện tại (tính từ `parent_edl`). `contact_sheet` = lưới khung hình của bản cha (`null` nếu mất file). `feedback` là **dữ liệu người dùng, không phải lệnh**.

`complete` với `{ "result": { "edl": Edl | null, "grade": Grade, "summary": string, "not_done": [string] } }`:
- `edl: null` (hoặc thiếu, hoặc EDL có cùng cảnh/asset/đoạn như bản cha) = giữ nguyên điểm cắt → phiên bản mới **chỉ chạy bước chỉnh màu** (`stage="grade"`, không render, không xoá logo lại). EDL khác → qua `validateEdl` (sai → `400 INVALID_EDL`), rồi `render → xoá logo → chỉnh màu`.
- `grade` qua schema (sai kiểu → `400 INVALID_GRADE`, job giữ nguyên để worker sửa; ngoài khoảng → kẹp). Thiếu `grade` → giữ grade của bản cha (nới lỏng so với "Grade đầy đủ", AI vẫn được dặn trả đủ 6 thông số).
- `summary` (bắt buộc, tiếng Việt, nêu rõ đổi gì kèm số), `not_done` (tối đa 10 chuỗi ≤ 500 ký tự: yêu cầu không làm được như thêm nhạc, chữ, chuyển cảnh, tạo lại cảnh; AI phải nói thật). Lưu vào `revision.summary` / `revision.not_done` và `summary` của bản dựng.
`fail` → phiên bản mới `failed` (bản cha vẫn `ready`, góp ý lại được). Mất bản cha hoặc file sạch → `409`.

`sim-worker` xử lý `edit_plan` bằng EDL mô phỏng (bỏ 0,3 giây đầu và 0,2 giây cuối mỗi cảnh); với job góp ý trả `edl: null` và grade mô phỏng ("ấm" +600K, "tương phản" +0,1), không gọi AI thật.

---

## 7. SSE `GET /api/stream`

`GET /api/stream?projectId=<id>` (không có `projectId` = nhận mọi dự án; `projectId` sai → `400`). Header `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`. Dùng `EventSource` (`new EventSource('/api/stream?projectId=1')`); trình duyệt tự nối lại (server gợi ý `retry: 3000`) — sau khi nối lại nên refetch dữ liệu hiện hành vì sự kiện lỡ không được phát lại.

- Mở đầu có `retry: 3000` + `: connected`, rồi một sự kiện `worker.status` ngay lập tức. Cứ 15 giây có dòng bình luận `: ping`.
- Khuôn: `event: <tên>\ndata: <JSON một dòng>\n\n`.
- Sự kiện **chỉ phát sau khi transaction commit** (thao tác bị từ chối/rollback không phát gì). Nhiều thay đổi cùng cảnh/job trong một transaction được gộp thành một sự kiện.
- Sự kiện có gắn dự án chỉ gửi cho người nghe cùng `projectId` (hoặc người nghe không lọc). `worker.status` là toàn cục: luôn tới mọi người nghe.

| Sự kiện | Payload | Khi nào |
|---|---|---|
| `scene.updated` | `{ "scene": SceneSummary }` | cảnh đổi trạng thái / prompt / asset / comment chưa xử lý / job active / kết luận … (tạo cảnh cũng dùng sự kiện này) |
| `job.updated` | `{ "job": Job }` | job tạo mới, claimed, running (heartbeat đầu), done, failed, cancelled, bị trả về hàng đợi |
| `asset.created` | `{ "asset": Asset }` | worker complete tạo asset |
| `asset.updated` | `{ "asset": Asset }` | người dùng đổi kết luận (đi kèm `scene.updated`) — *ngoài danh sách gốc* |
| `comment.created` | `{ "comment": Comment }` | comment của người dùng hoặc Claude |
| `comment.updated` | `{ "comment": Comment }` | đổi `resolved` (kể cả khi revise_prompt hoàn thành) — *ngoài danh sách gốc* |
| `worker.status` | `{ online, last_seen_at, worker_id, queue_paused, pause_reason, pause_code, paused_at }` | online/offline đổi (timer 10 giây), worker vừa online lại, tạm dừng/tiếp tục hàng đợi, và ngay khi kết nối |
| `budget.updated` | `{ "project_id": 1 }` | job video tạo/hủy/xong/lỗi, ledger đổi, sửa dự án → refetch `GET /budget` (hoặc project) |
| `event.created` | `{ "event": Event }` | mỗi dòng mới ở dòng thời gian |
| `final_cut.updated` | `{ "final_cut": FinalCut }` | final_cut tạo/đổi trạng thái (`planning` → `rendering` [stage `render` → `clean`] → `ready`/`failed`/`cancelled`), `stage`, `progress` đổi (ghi tối đa 1 lần/giây), có `.mlt`/`render_ref`, **vị trí hàng đợi đổi** (`queue_state`/`queue_position`/`running_count`/`ai_queue`, xem 4.12); kèm `project.updated` khi đổi trạng thái (để cập nhật `latest_final_cut`) |
| `project.deleted` · `project.restored` · `project.purged` | `{project_id,name,deleted_by}` · `{project}` · `{project_id}` | dự án vào thùng rác (từ app hoặc LAN) / khôi phục / xoá vĩnh viễn (mục 5.8) — danh sách dự án và thùng rác cần refetch |
| `source.updated` · `clip.updated` · `clip.deleted` (dành sẵn, chưa có endpoint xoá clip nên chưa phát) · `clip_cut.updated` | `{ "source": SourceVideo }` · `{ "clip": Clip }` · `{ "clip_id" }` · `{ "cut": ClipCut }` | cắt clip từ video dài (mục 14): tiến độ/trạng thái nhận dạng và vị trí hàng đợi STT; clip tạo/sửa/ảnh đại diện xong/có bản dựng mới; tiến độ, giai đoạn, vị trí hàng đợi của bản dựng clip. Luôn dạng app chính (URL `/files/...`); trang LAN không có SSE |
| `project.updated` | `{ "project": ProjectSummary }` | gửi brief, phân tích xong/lỗi/hủy, sửa dự án, thay đổi ảnh tham chiếu (upload/chép từ thư viện/nhãn/thứ tự/xóa) — *ngoài danh sách gốc* |

Gợi ý frontend: `scene.updated` ghi đè cảnh trong cache theo `scene.id` (SceneSummary đầy đủ, không có `assets/comments/jobs` — với trang chi tiết, invalidate `GET /api/scenes/:id` khi nhận `scene.updated`/`asset.*`/`comment.*` của cảnh đó). `job.updated` cập nhật trang Hàng đợi.

---

## 8. File tĩnh `/files/*`

`GET /files/<đường dẫn tương đối>` (đúng `file_path` của asset/ref; trường `url` có sẵn) — chỉ phục vụ prefix `output/` và `refs/`. Chặn `..` (kể cả `%2e%2e`), đường dẫn tuyệt đối, backslash và symlink trỏ ra ngoài (đều `404`). Hỗ trợ `Range` (video tua được: `206 Partial Content`, `Content-Range`, `Accept-Ranges: bytes`; Range sai → `416`), `ETag`/`Last-Modified`, `Cache-Control: no-cache`, `X-Content-Type-Options: nosniff`. Thẻ `<video src="/files/output/…/C1_v1.mp4" controls>` dùng được trực tiếp. Dự án đã xoá (thùng rác): file của nó (`output/<slug>/**`, `refs/<id>/**`) và mọi thứ dưới `output/.trash/**` → `404`. Route này **chỉ có ở app chính (localhost)**; listener LAN có route file riêng `/lan/files/*` (mục 13).

---

## 9. Bảng mã lỗi

| HTTP | `code` | Khi nào |
|---|---|---|
| 400 | `VALIDATION_ERROR` | body/query/param sai (`details` = danh sách lỗi zod) |
| 400 | `BAD_REQUEST` | request sai khác (vd không phải multipart) |
| 400 | `INVALID_JSON` | JSON hỏng |
| 400 | `INVALID_PATH` · `FILE_NOT_FOUND` | `file_path` của worker sai / không tồn tại |
| 400 | `INVALID_ASSET_KIND` · `ASSET_REQUIRED` | asset không phù hợp loại job / thiếu asset chính |
| 400 | `INVALID_ASSET` | asset không thuộc cảnh / không đúng loại |
| 400 | `INVALID_REFS` | ref không thuộc dự án / reorder sai tập |
| 400 | `INVALID_FILENAME` · `NO_FILE` | upload |
| 401 | `UNAUTHORIZED` | thiếu/sai `WORKER_TOKEN` |
| 403 | `FORBIDDEN_HOST` · `FORBIDDEN_ORIGIN` | Host/Origin lạ |
| 404 | `NOT_FOUND` | không có tài nguyên/đường dẫn |
| 409 | `INVALID_TRANSITION` | chuyển trạng thái ngoài bảng (`details: {from,to}`) |
| 409 | `INVALID_STATE` | trạng thái cảnh/job không cho phép thao tác (kể cả "chưa có storyboard") |
| 409 | `JOB_ACTIVE` | cảnh/dự án đang có job chưa xong |
| 409 | `ATTEMPTS_EXCEEDED` | "Cảnh C1 đã dùng 2/2 lượt" |
| 409 | `CREDITS_CHANGED` | approve-all: tổng credit khác `expectedCredits` (`details: {expected, actual}`) |
| 409 | `NOTHING_TO_APPROVE` | approve-all không có cảnh đủ điều kiện |
| 409 | `JOB_CANCELLED` | worker: job đã hủy / không còn thuộc worker này → dừng ngay |
| 409 | `RECONCILIATION_REQUIRED` | hủy/resume job managed đã gửi lệnh tạo bên ngoài: phải đối soát |
| 409 | `ALREADY_RECONCILED` · `RECONCILE_DOWNLOADED` | đối soát: đã đối soát bằng lựa chọn khác · action đã `downloaded` (chỉ `retry_download`) |
| 409 | `MANAGED_REQUIRED` | request ghi không có `X-Job-Lease` cho loại job/job do managed worker xử lý |
| 409 | `ACTION_CONFLICT` | journal: đã có action sống (chưa đối soát) hoặc chuyển trạng thái không hợp lệ |
| 400 | `INVALID_OUTCOME` | `charge_and_fail` cho job không phải video |
| 409 | `FILE_MISSING` | thêm ảnh từ thư viện: file nguồn của ref không còn tồn tại |
| 400 | `INVALID_EDL` | EDL sai (thiếu cảnh, sai thứ tự/asset_id, đoạn chồng nhau/quá ngắn/ngoài thời lượng…); message nêu cảnh/đoạn, `details.scene`/`details.segment`; với job `edit_plan` job vẫn được giữ |
| 409 | `SCENES_NOT_READY` | dựng bản hoàn chỉnh khi còn cảnh chưa chọn video (message liệt kê mã cảnh) |
| 409 | `FINAL_CUT_ACTIVE` | đang có bản dựng `planning`/`rendering` (tạo mới) hoặc `rendering` (render lại) |
| 409 | `WATERMARK_REMOVER_UNAVAILABLE` | `POST /final-cuts/:id/clean` khi tool xoá logo Veo tắt/không chạy được |
| 400 | `INVALID_GRADE` | `grade` sai kiểu / `scene_id` lạ hoặc lặp (`POST /final-cuts/:id/grade`, `/grade-preview`, hoặc `complete` job góp ý); giá trị ngoài khoảng KHÔNG báo lỗi mà bị kẹp |
| 400 | `INVALID_LUT` | file `.cube` tải lên không hợp lệ (1D, cỡ ngoài 2–65, thiếu/thừa dòng, số hỏng, từ khoá lạ, DOMAIN khác 0–1) |
| 400 | `INVALID_IMAGE` | ảnh mẫu qua magic bytes nhưng ffprobe không đọc được / không tạo được thumb / quá lớn |
| 409 | `COLOR_REF_IN_USE` | xoá ảnh mẫu/LUT đang được phiên bản bản dựng dùng |
| 409 | `COLOR_MATCH_FAILED` | `grade-preview` không áp được màu theo ảnh mẫu (ảnh mẫu mất file, video/ảnh toàn đen...) |
| 409 | `LOGO_NOT_REMOVED` | góp ý/chỉnh màu trên bản còn logo Veo khi tool xoá logo đang bật (chỉnh màu luôn chạy SAU xoá logo) |
| 409 | `GRADED_CUT` | `clean` bản đã chỉnh màu mà không còn bản gốc còn logo |
| 409 | `RAW_EXISTS` · `FILE_MISSING` | `clean`: file `_raw.mp4` đã tồn tại (không ghi đè) · mất video/bản gốc cần xử lý |
| 409 | `NO_PROJECT_FILE` | `open-in-shotcut` khi bản dựng không có file .mlt |
| 409 | `SHOTCUT_UNAVAILABLE` | `open-in-shotcut` mà không mở được Shotcut |
| 409 | `NO_SCENES` | complete analyze_brief khi chưa có cảnh |
| 413 | `FILE_TOO_LARGE` · `BODY_TOO_LARGE` · `TOO_MANY_FILES` | upload quá giới hạn (10MB/file) |
| 415 | `UNSUPPORTED_FILE_TYPE` | ảnh không phải png/jpg/webp (theo magic bytes) |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Content-Type không hỗ trợ |
| 500 | `INTERNAL` | lỗi không lường trước |
| 503 | `QUEUE_PAUSED` | worker `GET /next` khi hàng đợi tạm dừng (`details: {pause_code, pause_reason}`) |
| 401 | `UNAUTHENTICATED` | (listener LAN) chưa đăng nhập hoặc phiên hết hạn |
| 401 | `INVALID_CODE` | (listener LAN) mã truy cập sai |
| 403 | `FORBIDDEN_HOST` | (LAN) header `Host` không phải IP/tên máy trong LAN |
| 403 | `FORBIDDEN_ORIGIN` | (LAN) request ghi thiếu `Origin` hoặc `Origin` ≠ `http://<Host>`; hoặc `Sec-Fetch-Site: cross-site` ở route cần phiên |
| 409 | `TOO_MANY_REFS` | (LAN) quá 12 ảnh tham chiếu mỗi kế hoạch |
| 409 | `TOO_MANY_UPLOADS` | (LAN) quá 8 lần tải storyboard / quá 5 video cho một cảnh |
| 409 | `SCENE_BUSY` | (LAN) cảnh đang được chủ máy sản xuất (có job), chưa tải storyboard/video lên được |
| 409 | `PROJECT_BUSY` | không xoá được dự án: job đang chạy, đang dựng/render, thao tác Flow chưa đối soát, đang tải video; `details.reasons[]` |
| 400 | `CONFIRM_MISMATCH` | `confirm_name` không trùng tên dự án |
| 409 | `RESTORE_CONFLICT` | khôi phục: chỗ cũ đã có thư mục cùng tên chứa file (không ghi đè) |
| 500 | `TRASH_MOVE_FAILED` · `RESTORE_FAILED` · `PURGE_FAILED` | lỗi file khi vào thùng rác / khôi phục / xoá vĩnh viễn (đã hoàn tác, dự án giữ nguyên trạng thái trước) |
| 403 | `NOT_PLAN_OWNER` | (LAN) xoá kế hoạch không phải của trình duyệt này |
| 429 | `RATE_LIMITED` | (LAN) vượt giới hạn tốc độ; `details.retry_after_s` và header `Retry-After` |
| 429 | `QUEUE_FULL` | (LAN) hàng đợi việc từ LAN đã đủ 6: "Hàng đợi đang đầy, thử lại sau" |
| 429 | `UPLOAD_BUSY` | (LAN) quá nhiều video đang được tải lên cùng lúc (2/IP, 4 toàn listener) |
| 413 | `FILE_TOO_LARGE` | (LAN) video vượt 200 MB |
| 415 | `UNSUPPORTED_FILE_TYPE` | (LAN) video không phải mp4/mov (thiếu `ftyp`) |
| 422 | `INVALID_VIDEO` · `VIDEO_DURATION` | (LAN) ffprobe không đọc được / không có luồng video · thời lượng ngoài 1–60 giây (cảnh) hoặc 1–120 giây (xoá logo) |
| 409 | `SCENES_NOT_READY` · `FILE_MISSING` · `FINAL_CUT_ACTIVE` | (LAN) điều kiện dựng: "Còn C2 chưa có video", mất file video nguồn, đang có bản chạy |

---

## 10. Nút giao diện ↔ endpoint

| Nút / hành động | Endpoint | Hiện khi (`scene.status`) | Vô hiệu hóa khi |
|---|---|---|---|
| Gửi cho Claude phân tích | `POST /api/projects/:id/brief` | project `draft`/`active` | có `analyze_brief` đang chạy (`JOB_ACTIVE`) |
| Duyệt prompt (& tạo storyboard) | `POST /api/scenes/:id/approve` `{stage:"storyboard"}` | `awaiting_approval` | `storyboard_block != null` |
| Tạo storyboard (lại) | `POST …/approve` `{stage:"storyboard"}` hoặc comment `regenerate_storyboard` | `storyboard_review`, `video_review`, `done`, `failed`, `blocked_budget` | `storyboard_block != null` |
| Tạo video (15 credit) — **hộp xác nhận bắt buộc** | `POST …/approve` `{stage:"video"}` | `storyboard_review`; `awaiting_approval` nếu `storyboard != null` (sau khi sửa prompt) | `video_block != null` → hiện `video_block.message` (vd "Cảnh C1 đã dùng 2/2 lượt") |
| Tạo lại y nguyên (credit) | comment `regenerate_same` (hoặc `approve` video) | `video_review`, `done`, `failed`, `blocked_budget` | như trên |
| Sửa prompt rồi tạo lại | comment `revise_and_regenerate` (kèm `timecode`, `asset_id`) | `storyboard_review`, `video_review`, `done`, `awaiting_approval`, `failed` | có `active_job` |
| Ghi chú / comment gắn mốc thời gian | comment `note` `{timecode}` | mọi trạng thái | — |
| Đánh dấu comment đã xử lý | `PATCH /api/comments/:id` | — | — |
| Sửa prompt tay + diff | `PATCH /api/scenes/:id/prompt`; lịch sử ở `prompt_versions` | `awaiting_approval`, `storyboard_review`, `video_review`, `done`, `failed`, `blocked_budget` | đang `*_queued/*_running/needs_revision` |
| Chọn video này | `POST …/select-video` `{asset_id}` | `video_review`, `done` | — |
| Đổi kết luận Đạt/Sửa khi dựng/Tạo lại | `POST /api/assets/:id/verdict` | có asset | — |
| Hủy job | `POST /api/jobs/:id/cancel` (`scene.active_job.id`) | `*_queued`, `*_running`, `needs_revision` | job managed đã gửi lệnh tạo (`RECONCILIATION_REQUIRED`) |
| Đối soát | `POST /api/jobs/:id/reconcile` (`scene.active_job.reconcile_required`) | `*_queued/*_running` có `active_job.reconcile_required` | — |
| Thử lại / Quay về chờ duyệt | `POST …/approve` (storyboard hoặc video theo `jobs[0].type`) hoặc `POST /api/scenes/:id/reset` | `failed`, `blocked_budget` | |
| Duyệt tất cả cảnh đang chờ | `GET …/approve-all/preview` → hộp xác nhận ghi `total_credits` → `POST …/approve-all {stage, expectedCredits: total_credits}` | thanh trên cùng | `count=0`; nhận `CREDITS_CHANGED` thì tải lại preview |
| Tiếp tục hàng đợi | `POST /api/queue/resume` | banner khi `worker.queue_paused` (kèm `pause_reason`) | — |
| Banner "job bị trả về do mất heartbeat" | `GET /api/projects/:id` → `requeued_jobs`; SSE `event.created` type `job.requeued` | | |
| Chỉ báo Worker online/offline | `GET /api/worker/status` + SSE `worker.status` | luôn | |
| Thẻ dự án (số cảnh, tiến trình, credit) | `GET /api/projects` (`scene_count`, `done_count`, `status_counts`, `credits_used`) | | |
| Thanh trên cùng bảng cảnh | `GET /api/projects/:id` (`credits_used`, `credits_reserved`, `credit_per_video`, `status_counts`, `budget`) — hiển thị "Đã dùng X credit" (+ "đặt trước Y" nếu > 0) và "15 credit/video" | | |
| Sửa ngân sách / số lượt / credit-per-video | `PATCH /api/projects/:id` | | |
| Ảnh tham chiếu: tải, nhãn, thứ tự, xóa | `POST /api/projects/:id/refs`, `PATCH /api/refs/:id`, `PATCH /api/refs/reorder`, `DELETE /api/refs/:id` | | |
| "Chọn từ thư viện" (ảnh của dự án trước) | `GET /api/ref-library?projectId=` (lưới thumbnail `url`, nhãn, `projects[].name` = "Đã dùng ở", `in_project` → "Đã có", không chọn được) → `POST /api/projects/:id/refs/from-library {ref_ids, labels?}` (thứ tự chọn = thứ tự `ref_ids`) | trang tạo dự án / mục Ảnh tham chiếu của dự án | `in_project=true` |
| Hàng đợi (bảng job) | `GET /api/jobs?status=…` + SSE `job.updated` | | |
| Khối "Bản hoàn chỉnh" ở bảng cảnh | `GET /api/projects/:id` → `latest_final_cut` (trạng thái, `progress`, `queue_state`/`queue_position`/`ai_queue`, `duration_s`, `outdated`, `error`) + `final_cut_block`; SSE `final_cut.updated` / `project.updated` | luôn | "Dựng bản mới" khóa khi `final_cut_block != null` (hiện `message`) |
| "Dựng bản mới" | `POST /api/projects/:id/final-cuts` | khi `final_cut_block == null` | `SCENES_NOT_READY` / `FINAL_CUT_ACTIVE` |
| Trang `/projects/:id/final`: trình phát, chọn version, tải, timeline giữ/cắt | `GET /api/projects/:id/final-cuts` (`video_url` = bản đã xoá logo, `watermark_removed`, `contact_sheet_url`, `edl.scenes[].segments/removed`, `selection[].duration_s`, `created_by`, `note`, `renderer`, `summary`); tải = `video_url` | có bản `ready` | — |
| Trạng thái xoá logo ("Đang xoá logo Veo 42%") | `latest_final_cut.stage` / `final_cut.stage` + `progress` (riêng từng bước) | `status="rendering"` | — |
| "Thử xoá logo lại" (lỗi ở bước clean) / "Xoá logo Veo" (bản `ready` còn logo) | `POST /api/final-cuts/:id/clean` | `failed_stage="clean"`, hoặc `ready` với `watermark_removed=false` | `WATERMARK_REMOVER_UNAVAILABLE` (xem `/api/meta.watermark_remover.reason`) |
| Link nhỏ "Tải bản gốc còn logo" | `raw_video_url` | khi `raw_video_url != null` | — |
| "Mở trong Shotcut" | `POST /api/final-cuts/:id/open-in-shotcut` | chỉ khi `project_file_path != null` | `NO_PROJECT_FILE` |
| Trình chỉnh EDL → "Render lại (không tốn credit)" | `POST /api/final-cuts/:id/rerender {edl, note?}`; `INVALID_EDL` hiện đúng cảnh/đoạn từ `error.details` / `message` | bản `ready`/`failed` | `FINAL_CUT_ACTIVE` |
| Hủy khi đang chọn điểm cắt / render | `POST /api/final-cuts/:id/cancel` | `planning`, `rendering` | — |
| "Gửi góp ý cho AI" | `POST /api/final-cuts/:id/feedback {feedback}` | bản `ready`, không có bản nào đang chạy | `FINAL_CUT_ACTIVE` / `LOGO_NOT_REMOVED` |
| Panel "Chỉnh màu" → "Màu theo ảnh mẫu": tải ảnh / chọn từ ảnh dự án / tải file LUT / bỏ | `POST …/color-refs` · `POST …/color-refs/from-asset` · `DELETE …/color-refs/:refId` · (chọn/bỏ = sửa `grade.match` trong bản nháp) | dự án còn tồn tại | `INVALID_LUT` / `INVALID_IMAGE` / `FILE_TOO_LARGE` / `COLOR_REF_IN_USE` |
| Panel "Chỉnh màu": "Xem trước" / "Tạo phiên bản" / "Thử chỉnh màu lại" | `POST …/grade-preview {grade}` / `POST …/grade {grade,note?}` / `POST …/regrade` | bản `ready` (regrade: `failed_stage="grade"`) | `INVALID_GRADE` / `FINAL_CUT_ACTIVE` |
| Nhật ký & credit; xuất | `GET …/ledger`, `GET …/ledger.csv`, `GET …/log.md` | | |
| Dòng thời gian của cảnh | `GET /api/projects/:id/events?sceneId=` | | |

Thông báo "Cảnh C1 đã dùng 2/2 lượt" lấy từ `scene.video_block.message` (hoặc tự dựng từ `attempts_used/max_attempts`).

---

## 11. Quy tắc nghiệp vụ quan trọng

- **Không bao giờ tạo video khi chưa duyệt**: job video chỉ tạo bởi `approveVideo` (qua `approve stage=video`, comment `regenerate_same`, hoặc `approve-all stage=video`). Server từ chối kể cả khi gọi API trực tiếp; `worker/next` còn bỏ qua mọi job `requires_approval` mà chưa có `approved_at`.
- **Credit**: ledger `delta` âm khi tốn. `used = −SUM(delta)`; `reserved = credit_per_video × job video queued/claimed/running`. **Không có hạn mức credit**: server không bao giờ từ chối vì credit (không còn `BUDGET_EXCEEDED`); chỉ giới hạn số lượt mỗi cảnh. Trạng thái `blocked_budget` chỉ do worker báo `FLOW_OUT_OF_CREDIT` (Flow hết credit thật). Job video `done` ghi `−credits_cost` (mặc định `credit_per_video`); job video `failed` có `credits_cost>0` cũng ghi sổ cái.
- **Lượt** của cảnh = số asset video + job video đang hoạt động + job video failed có tốn credit; tối đa `max_attempts_per_scene` (mặc định 2). Lượt storyboard không giới hạn và miễn phí.
- **Một cảnh một job**: cảnh có job `queued/claimed/running` thì mọi `approve`/comment hành động đều `409 JOB_ACTIVE`; worker không nhận job thứ hai cùng cảnh.
- **Job mất heartbeat**: sau `HEARTBEAT_STALE_MINUTES`, tác vụ quét (30 giây) trả job về `queued` (`requeue_count+1`, `last_requeued_at`, xóa `claimed_*`), cảnh `*_running` → `*_queued`, ghi event `job.requeued`, phát SSE. Lần claim kế tiếp `payload.requeued=true`. Worker cũ nếu quay lại sẽ nhận `409`.
- **Hàng đợi tạm dừng** chỉ chặn `GET /api/worker/next` (503); heartbeat/complete/fail của job đang chạy vẫn hoạt động.
- Mỗi asset storyboard/video mới từ worker → append một dòng vào `output/<slug>/log.md` (`| clip | lần | loại | lỗi thấy được | kết luận |`; tạo file + header nếu chưa có). Cập nhật kết luận của người dùng cũng append một dòng. Verdict → chữ: pass="Đạt", fix_in_edit="Sửa khi dựng", redo="Tạo lại" (chưa có = "Chưa đánh giá").
- **Bản dựng hoàn chỉnh**: version tăng dần theo dự án và không bao giờ ghi đè (kiểm tra DB và đĩa); `edit_plan` và render không tốn credit; tối đa `RENDER_CONCURRENCY` bản render cùng lúc (hàng đợi trong tiến trình, mặc định 2; mỗi dự án vẫn chỉ một bản `planning`/`rendering`); server tắt giữa lúc render thì **mọi** bản đang `rendering` thành `failed` ở lần khởi động sau; job `edit_plan` có `scene_id=null` nên không đổi trạng thái cảnh. Mỗi bản `ready` thêm một dòng `| FINAL | v<n> | bản dựng (<renderer>, cắt thẳng) | <summary> | Sẵn sàng |` vào `output/<slug>/log.md` (và vào `GET …/log.md`).
- Import dữ liệu cũ dùng `transition(..., {force:true})`, cột `ext_key` (UNIQUE) của `assets`, `credit_ledger`, `comments`, `events`, `scene_prompt_versions` để chạy lặp không trùng — chưa có API HTTP cho việc này (chạy bằng script `npm run import:legacy`, xem mục 12).

---

## 12. Bố cục file, script, chạy thử

**File sinh ra** (đường dẫn trong DB tương đối từ `ROOT_DIR`):
- `output/<slug>/storyboard/<code>_storyboard.png` (lượt 1), `<code>_storyboard_v<n>.png` (n ≥ 2)
- `output/<slug>/video/<code>_v<n>.mp4` và `<code>_v<n>_grid.jpg`
- `output/<slug>/log.md`
- `output/<slug>/final/<slug>_final_v<n>.mp4`, `…_final_v<n>_contact.png`, `output/<slug>/final/shotcut/<slug>_final_v<n>.mlt` (chỉ khi dựng bằng Shotcut; Shotcut MCP còn tạo `.render-<id>.mlt` và `.guard` cạnh đó)
- `output/<slug>/video/<code>_v<n>.mp4` cũng là nơi lưu video người dùng LAN tải lên (`meta.source='lan_upload'`); `output/lan-tools/<id>/{input.<mp4|mov>,clean.mp4}` và `output/lan-tools/.incoming/` (file tải dở) cho công cụ xoá logo LAN
- `refs/<projectId>/<tên-đã-làm-sạch>.<png|jpg|webp>`
- `data/app.db` (+ `-wal`, `-shm`), `data/backup/app-<timestamp>.db`

**Script (chạy ở thư mục gốc repo):**

| Lệnh | Việc |
|---|---|
| `npm run dev` | server (`tsx watch`, cổng 8787) + Vite (5173) cùng lúc |
| `npm run build` | build web (`web/dist`) + typecheck server |
| `npm start` | `NODE_ENV=production`: server 8787 phục vụ API + `web/dist` |
| `npm test` | vitest cho server (DB và ROOT tạm, không đụng `data/app.db` hay `output/`) |
| `npm run typecheck` | `tsc --noEmit` cho server và web |
| `npm run sim:worker -- [flags]` | worker giả lập (xem dưới) |
| `npm run import:legacy -- [--dir output/cacao-smoothie] [--db data/app.db]` (`--budget` không còn dùng: in cảnh báo rồi bỏ qua) | nhập dữ liệu lần chạy tay đầu tiên (dự án Cacao Actiso Plus); chạy lặp lại không tạo bản ghi trùng; `--dir`/`--db` tương đối tính từ `ROOT_DIR` (code: `src/services/legacy-import.ts`) |

**`npm run sim:worker`** — vòng lặp `GET /api/worker/next` bằng `WORKER_TOKEN` (từ `.env`), heartbeat khi "làm việc", ghi file mẫu rồi `complete`:
`--once` (xử lý tối đa một job rồi thoát; không có job/hàng đợi tạm dừng thì thoát ngay) · `--delay <ms>` (thời gian "làm việc" mỗi job, mặc định 3000) · `--fail-rate <0..1>` (báo lỗi giả, mã `--fail-code`, mặc định `OTHER`) · `--api <url>` (mặc định `http://127.0.0.1:8787`) · `--poll <ms>` (chờ khi không có job, mặc định 2000) · `--worker <id>` · `--root <dir>` (cùng `ROOT_DIR` của server) · `--token <t>` · `--mixed-verdicts` (verdict video ngẫu nhiên).
`analyze_brief` → 3–4 cảnh giả qua `POST /api/worker/scenes`; `storyboard` → PNG hợp lệ 180×320; `video` → mp4 + ảnh lưới bằng ffmpeg (`testsrc` 360×640, 3 giây; thiếu ffmpeg thì file giả); `revise_prompt` → thêm một dòng `[Mô phỏng chỉnh sửa] …` vào prompt kèm lý do; `edit_plan` → EDL mô phỏng (bỏ 0,3 giây đầu / 0,2 giây cuối mỗi cảnh). Không bao giờ tự tạo job video.
Thử nhanh: `npm run dev`; tạo dự án trên UI/curl, `POST /api/projects/:id/brief`, rồi `npm run sim:worker -- --once` lặp lại (hoặc không `--once` để chạy liên tục).

**Chạy thử bằng curl** (Host/Origin hợp lệ; thêm `-H 'Content-Type: application/json'`):
```
curl -s -X POST localhost:8787/api/projects -H 'Content-Type: application/json' -d '{"name":"Demo","brief":"Quảng cáo sinh tố"}'
curl -s -X POST localhost:8787/api/projects/1/brief -H 'Content-Type: application/json' -d '{}'
curl -s -H "Authorization: Bearer $WORKER_TOKEN" 'localhost:8787/api/worker/next?worker=me'
```


---

## 13. Trang planner LAN (listener riêng)

**Mục đích:** đồng nghiệp trong cùng mạng nhập yêu cầu + ảnh tham chiếu, AI chia cảnh, trang hiển thị **kế hoạch prompt** cho từng cảnh để họ tự tạo ảnh (ChatGPT) và video (Google Flow) bằng tay trên tài khoản của họ. Trang LAN **không bao giờ** tạo job storyboard/video và không tốn credit Flow của máy chủ: job AI nó tạo là `analyze_brief` và `edit_plan` (chọn điểm cắt cho bản hoàn chỉnh, không tốn credit). Từ đợt 22/10/2026 trang còn có **Bước 3** (tải video đã tạo lên), **Bản hoàn chỉnh** (AI chọn điểm cắt → Shotcut/ffmpeg render → xoá logo Veo, người dùng chỉnh điểm cắt rồi render lại) và công cụ độc lập **Xoá logo Veo** (13.2–13.4).

**Cô lập (bắt buộc, có test `lan-security`, `lan-listener`):**
- Cùng tiến trình, **Fastify instance thứ hai** (`server/src/lan/`), chung `AppContext` (DB, SSE, đồng hồ). Bật bằng `LAN_ENABLED=true` (mặc định tắt). App chính vẫn chỉ nghe `127.0.0.1:8787`, vẫn kiểm tra Host/Origin như cũ, **không** có route `/lan/*`.
- Listener LAN **chỉ** đăng ký: `GET /` và `/planner.html` (trang), `GET /assets/:file` (bundle build, tên file kiểm tra chặt), `/lan/api/*` (dưới đây) và `GET /lan/files/*`. Mọi đường dẫn khác, gồm toàn bộ `/api/*`, `/api/worker/*`, `/api/ai/*`, approve, jobs, `/files/*`, `index.html` của app quản trị: **404** (hoặc 401 nếu chưa có phiên). Code `server/src/lan/` không import route của app chính (test quét import). Bài test dựng bảng route hai bên và kiểm tra không route nào của app chính tồn tại trên LAN.
- **Phiên (chỉ khi `LAN_REQUIRE_CODE=true`):** `POST /lan/api/login {code}` → cookie `autovideo_lan` (`HttpOnly; SameSite=Strict; Path=/lan; Max-Age=43200`, 12 giờ, token 256 bit lưu băm trong bộ nhớ; khởi động lại server thì đăng nhập lại). Mọi route cần phiên, trừ trang, assets, `login` và `GET /lan/api/session`. **Mặc định (`LAN_REQUIRE_CODE=false`) không có đăng nhập và không có phiên**: mọi route dùng được ngay (không còn `401 UNAUTHENTICATED`), `GET /lan/api/session` luôn trả `{authenticated:true, code_required:false, expires_at:null}`, `POST /lan/api/login` (bản trang cũ còn mở) trả `{ok:true, code_required:false, expires_at:null}` không tạo phiên và không đọc mã, `POST /lan/api/logout` chỉ xoá cookie phiên còn sót. Vẫn áp dụng: Host, Origin, cross-site, CSP, giới hạn theo IP (trừ giới hạn sai mã), trần hàng đợi, danh sách file được phép.
- **Host:** chỉ IP, `localhost`, `*.local/.lan/.internal/.home.arpa`, tên một nhãn hoặc `LAN_ALLOWED_HOSTS` (chặn DNS rebinding bằng tên miền công cộng). **Origin:** request `POST/PUT/PATCH/DELETE` bắt buộc có `Origin` đúng bằng `http://<Host>` (thiếu cũng 403).
- **Giới hạn theo IP** (`LAN_RATE` trong `lan/routes.ts`; **xoá kế hoạch 10 lần/giờ**): đăng nhập sai 10 lần/15 phút (chỉ khi đòi mã; kể cả mã đúng cũng bị chặn trong thời gian đó); phân tích 6 lượt/giờ (phân tích lại cũng tính; lỗi nghiệp vụ không tính); tạo kế hoạch 20/giờ; tải ảnh 60 ảnh/giờ; **tải video cảnh 30 lần/giờ** (lần tải thành công); **dựng bản hoàn chỉnh + render lại 6 lần/giờ** (dùng chung một hạn mức); **xoá logo 6 lần/giờ** (việc công cụ mới, thử lại việc công cụ và `/clean` một bản dựng, dùng chung). Vượt → `429 RATE_LIMITED` kèm `Retry-After`. **Trần hàng đợi toàn cục 6** cho việc từ LAN (bản dựng của dự án LAN đang `planning`/`rendering` + việc công cụ `queued`/`processing`; việc của app chính không tính): chạm trần → `429 QUEUE_FULL` "Hàng đợi đang đầy, thử lại sau" (kiểm tra trước khi nhận file). Tải video: tối đa 2 luồng đồng thời mỗi IP và 4 toàn listener (`429 UPLOAD_BUSY`). Ảnh ≤ 10 MB (png/jpg/webp, kiểm tra magic bytes, `files ≤ 12` mỗi request), tối đa 12 ảnh mỗi kế hoạch, body JSON ≤ 2 MB.
- **File:** `GET /lan/files/<path>` chỉ phục vụ (a) ảnh tham chiếu (`project_refs.file_path`) của dự án `source='lan'`, (b) storyboard **và video** người dùng LAN tự tải lên (`assets.meta.source='lan_upload'`) của cảnh thuộc dự án `lan`, (c) file bản dựng của dự án `lan`: mp4 sạch (`video_path`), bản raw còn logo (`raw_video_path`), lưới khung hình (`contact_sheet_path`) — **không bao giờ file `.mlt`**, (d) bản sạch (`clean.mp4`) của việc công cụ `ready` **chỉ cho đúng chủ** (cookie client, mục 13.4). Mọi thứ khác (refs/output của dự án `app`, bản dựng của dự án `app`, storyboard/video do worker hoặc chủ máy tạo, input của việc công cụ, file mồ côi, `..`, symlink) → 404. Có hỗ trợ `Range` (video tua được).
- **Header:** CSP `default-src 'self'`, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` cho API. **Log:** không ghi mã truy cập (nếu có), cookie hay nội dung ảnh (đăng nhập sai chỉ ghi IP).

### 13.1 Endpoint (JSON, lỗi dạng `{error:{code,message}}` như mục 9)

| Method + đường dẫn | Việc |
|---|---|
| `POST /lan/api/login` `{code}` | Đòi mã: `200 {ok, code_required:true, expires_at}` + `Set-Cookie`; `401 INVALID_CODE`; `429 RATE_LIMITED`. Không đòi mã (mặc định): `200 {ok:true, code_required:false, expires_at:null}`, không cookie |
| `POST /lan/api/logout` | hủy phiên |
| `GET /lan/api/session` | công khai: đòi mã → `{authenticated:false, code_required:true}` hoặc `{authenticated:true, code_required:true, expires_at}`; không đòi mã (mặc định) → luôn `{authenticated:true, code_required:false, expires_at:null}`. (Server cũ không có `code_required`.) |
| `GET /lan/api/status` | `{worker:{online,queue_paused}, code_required, limits, rate, analyze_remaining, remaining:{analyze,upload_video,create_final,remove_logo}, queue:{cuts,tools,total,cap}, render:{running_count,waiting_count,concurrency}, server_time}` (rút gọn từ trạng thái worker; không lộ `worker_id`/lý do tạm dừng; `remaining` = hạn mức còn lại của CHÍNH người gọi theo IP) |
| `GET /lan/api/plans` | danh sách kế hoạch LAN (mới nhất trước, không có kế hoạch đã xoá): `{id,name,created_by_name,status,scene_count,ref_count,created_at,updated_at,analysis,can_delete,delete_block}` |
| `DELETE /lan/api/plans/:id` | xoá kế hoạch = chuyển vào thùng rác của chủ máy (5.8). CHỈ trình duyệt đã tạo kế hoạch: băm SHA-256 của cookie client `autovideo_lan_client` phải trùng `projects.lan_client_hash` (ghi lúc `POST /lan/api/plans`, so sánh thời gian hằng số). Kế hoạch cũ (không có băm) hoặc của người khác → `403 NOT_PLAN_OWNER` "Chỉ người tạo (trình duyệt đã tạo kế hoạch) mới xoá được; nhờ chủ máy xoá". `409 PROJECT_BUSY` khi đang dựng/render/tải video; `404` nếu không có/đã xoá; `429` quá 10 lần/giờ/IP (tính cả lần bị từ chối). `200 {ok,id,restorable_days}`. LAN không có khôi phục hay xoá vĩnh viễn |
| `POST /lan/api/plans` `{name, created_by_name, brief?, style_lock?}` | tạo dự án `source='lan'` → `201 {plan}`; cấp cookie client nếu chưa có và lưu băm của nó để chỉ trình duyệt này xoá được (`can_delete`) |
| `GET /lan/api/plans/:id` | chi tiết: `plan` (+`brief`,`style_lock`,`credit_per_video`), `refs[]`, `settings`, `scenes[]` (mỗi cảnh có `videos`), `markdown`, `worker`, `analysis`, `limits` (+`scene_video`), `final` = `{block:{code,message}\|null, active, latest:{id,version,status}\|null, watermark:{active,reason}}` |
| `POST /lan/api/plans/:id/refs` (multipart: `label` rồi `file`, lặp lại) | thêm ảnh → `201 [{id,label,url,file_name,order_index}]`; `409 TOO_MANY_REFS`, `409 JOB_ACTIVE` (đang phân tích) |
| `GET /lan/api/ref-library[?planId=]` | thư viện ảnh **chỉ của các kế hoạch LAN** (không có ảnh của dự án `app`) |
| `POST /lan/api/plans/:id/refs/from-library` `{ref_ids, labels?}` | chép ảnh từ thư viện LAN (ảnh của dự án `app` hoặc không tồn tại → 404) |
| `POST /lan/api/plans/:id/analyze` `{brief?, style_lock?}` | cập nhật yêu cầu rồi tạo job `analyze_brief` (chạy bằng worker hiện có) → `201 {plan, rate:{analyze_remaining}}`; `409 JOB_ACTIVE`, `400` thiếu brief, `429` |
| `POST /lan/api/plans/:id/scenes/:sceneId/storyboard` (multipart `file`) | lưu ảnh storyboard người dùng vừa tạo: asset `storyboard` bình thường (`output/<slug>/storyboard/<code>_storyboard_lan_v<n>.<ext>`, `job_id=NULL`, `meta.source="lan_upload"`). **Không đổi trạng thái cảnh** (bảng chuyển không cho `awaiting_approval → storyboard_review`) và không tạo job. `409 SCENE_BUSY` khi chủ máy đang có job ở cảnh đó; `409 TOO_MANY_UPLOADS` |
| `GET /lan/api/plans/:id/plan.md` | tải Markdown kế hoạch (`Content-Disposition: attachment`) |
| `GET /lan/api/plans/:id/refs.zip` | gói ảnh tham chiếu (ZIP store viết bằng Node thuần, `NN-nhan.ext`); 404 nếu chưa có ảnh |
| `POST /lan/api/plans/:id/scenes/:sceneId/video` (multipart `file`) | Bước 3, mục 13.2 |
| `POST /lan/api/plans/:id/scenes/:sceneId/video/select` `{asset_id}` | chọn lại video khác của cảnh (mục 13.2) |
| `GET/POST /lan/api/plans/:id/final-cuts` · `GET …/final-cuts/:cutId` · `POST …/:cutId/rerender` `{edl,note?}` · `…/cancel` · `…/clean` | bản hoàn chỉnh (mục 13.3) |
| `GET /lan/api/tools/status` · `GET/POST /lan/api/tools/jobs` · `GET …/jobs/:id` · `POST …/jobs/:id/cancel` · `…/retry` | công cụ Xoá logo Veo (mục 13.4) |
| `GET /lan/files/*` | ảnh tham chiếu / storyboard / video tải lên / file bản dựng / bản sạch của việc công cụ (xem trên) |

Dự án không phải `source='lan'` trả **404** ở mọi route `/lan/api/plans/:id/*`.

**`plan.status`:** `draft` (chưa phân tích), `analyzing` (có job `analyze_brief` queued/claimed/running), `ready` (có cảnh, lần phân tích gần nhất xong), `failed` (lần gần nhất lỗi/bị hủy; cảnh cũ nếu có vẫn hiện). `analysis` = `{state: idle|queued|running|done|failed, job_id, waiting, error, created_at, finished_at, queue}`; `queue` (thêm 22/10/2026) = vị trí job `analyze_brief` trong hàng đợi của worker AI khi `state` là `queued`/`running`, cùng dạng `ai_queue` của 4.12 (`{state, position, ahead, running, worker:{online,paused}, wait_reason}`; `null` khi `idle/done/failed`); `waiting` là thông báo tiếng Việt khi job `queued` ("Máy chủ AI chưa sẵn sàng, yêu cầu đang xếp hàng.", hàng đợi tạm dừng, hết hạn mức AI…); `error` chung chung, chi tiết kỹ thuật chỉ có trên app chính.

**Mỗi cảnh** trong `scenes[]`: `{id, code, title, order_index, use_prev_storyboard, step1, step2, storyboard, storyboard_uploads, upload_block, videos}`; `videos` = `{items:[{id,attempt,url,file_name,uploaded_at,duration_s,width,height,bytes,has_audio,selected}], selected_id, count, max:5, block}` (xem 13.2).
- `step1` (ChatGPT) = `{message, attachments[], warnings[]}`. `message` dựng bằng `buildStoryboardMessage` (template WORKER.md 4.2: khung 9:16, khung MỞ ĐẦU giây 0, danh sách "ảnh N = nhãn", dòng "Giữ cùng…" khi `use_prev_storyboard`, `first_frame_desc` + dòng Style + dòng chủ thể, câu "Không có chữ…"). `attachments` = ảnh theo `upload_refs`, rồi storyboard của **cảnh đầu** nếu `use_prev_storyboard` (cảnh đầu không tự đính kèm chính nó).
- `step2` (Google Flow) = `{prompt, attachments[], settings, notes[], warnings[]}`. `prompt` = `scene.prompt` nguyên văn. `attachments` = ảnh theo `upload_refs` (gọi "image 1…" trong prompt), rồi storyboard của chính cảnh ở cuối (không đánh số). `settings` = `{aspect:"9:16", duration_s:10, count:1, resolution:"720p", estimated_credits: credit_per_video}`. `notes` gồm lưu ý giao diện Flow mới (ảnh vào "Tệp tải lên" chưa tự đính kèm vào ô prompt, xem `docs/ai/BACKLOG.md`).
- Mỗi attachment: `{order, kind: ref|storyboard_prev|storyboard_self, label, ref_id, scene_code, url, file_name, available, prompt_label, note}`; `available=false` khi storyboard chưa được tải lên.
- `warnings`: ảnh đã bị xóa khỏi kế hoạch; prompt nhắc `image N` vượt số ảnh đính kèm. `storyboard.stale=true` khi prompt cảnh đã đổi sau lúc tải ảnh lên.

### 13.2 Bước 3: tải video cảnh lên

`POST /lan/api/plans/:id/scenes/:sceneId/video` (multipart, MỘT `file`; trường văn bản nếu có phải đứng trước file) → `201 {video, videos, rate:{upload_video_remaining}}`.
- **Stream xuống đĩa, không đọc cả file vào RAM** (`lib/video-upload.ts`): pipeline có backpressure vào file tạm ẩn `output/<slug>/video/.lan-upload-<hex>.tmp`; từ chối sớm theo `Content-Length` (> 200 MB + 256 KB) và theo số byte thực nhận (client nói dối vẫn bị cắt, `413 FILE_TOO_LARGE`); kiểm tra magic bytes `ftyp` ở byte 4–8 của chunk đầu (`415 UNSUPPORTED_FILE_TYPE`, nhận mp4/mov); sau khi nhận xong mới ffprobe (bất đồng bộ, không chặn event loop): phải có luồng video đọc được (`422 INVALID_VIDEO`), thời lượng **1–60 giây** (`422 VIDEO_DURATION`). Lỗi ở bất kỳ bước nào đều xoá file tạm; phần thân còn lại được xả bỏ (tối đa 32 MB rồi cắt kết nối) để kết nối không kẹt.
- Lưu thành asset `kind='video'` của cảnh, `job_id=NULL`, `file_path=output/<slug>/video/<code>_v<n>.mp4` (n = max(attempt, số video)+1; gắn tên cuối bằng hard link nguyên tử, **không bao giờ ghi đè**), `meta={source:'lan_upload', original_name, bytes, duration_s, width, height, fps, has_audio, ffprobe:{format_name, video_codec, audio_codec, video_streams}}`. Video vừa tải **trở thành video được chọn** (`scenes.selected_video_id`). **Không đổi trạng thái cảnh** (không qua `transition()`; bảng chuyển không thêm đường đi nào), không tạo job, không tốn credit, **không tự kích hoạt dựng**. Video LAN không tính vào lượt/credit của chủ máy (`attemptsUsed` bỏ qua `lan_upload`).
- Lỗi nghiệp vụ: `409 SCENE_BUSY` (chủ máy đang có job/đang sản xuất cảnh, báo trước khi nhận file) · `409 TOO_MANY_UPLOADS` (đã đủ 5 video của cảnh) · `404` (cảnh không thuộc kế hoạch LAN) · `429 RATE_LIMITED` (30 lần/giờ) · `429 UPLOAD_BUSY` (đủ luồng tải đồng thời).
`POST …/video/select {asset_id}` → `{video, videos}`: chọn lại một video `lan_upload` của chính cảnh đó (asset khác → `404`).
Phân tích lại kế hoạch giữ nguyên cảnh đã có video tải lên (không bị prune).

### 13.3 Bản hoàn chỉnh của kế hoạch LAN

Dùng lại nguyên pipeline của app chính (`services/final-cuts.ts`, `services/final-render/*`: job `edit_plan` → EDL → Shotcut/ffmpeg → xoá logo Veo `watermark.ts` → `ready`), qua lớp bọc `services/lan-final.ts`. JSON là `FinalCut` của mục 4.12 với: URL qua `/lan/files/…`; `video_path`, `raw_video_path`, `contact_sheet_path`, `project_file_path`, `render_ref`, `watermark_meta` = `null` (không lộ `.mlt`/đường dẫn); `selection[].video_url` chỉ có cho video `lan_upload`; `error` che đường dẫn tuyệt đối (thông báo chung); thêm `queue_ahead` (**cũ, giữ để tương thích**: 0 = đang chạy, n = `running_count + queue_position`, null = không ở trong hàng đợi render) và các trường hàng đợi của 4.12 (`queue_state`, `queue_position`, `running_count`, `concurrency`, `ai_queue`; `ai_queue` không lộ id job/dự án của người khác). Giao diện: `planning` chờ worker → "Đang xếp hàng chờ AI (vị trí N)", worker nhận → "AI đang chọn điểm cắt"; `rendering` chưa bắt đầu → "Đang xếp hàng render (vị trí N · đang chạy X/Y việc)", rồi "Đang render N%" / "Đang xoá logo N%". Không có "Mở trong Shotcut" cho LAN. Cập nhật bằng polling 3 giây.

**Điều kiện dựng của kế hoạch `lan`:** có cảnh và **mọi cảnh có video được chọn** (file còn trên đĩa), chưa có bản `planning`/`rendering`. Không phụ thuộc trạng thái `done` của máy trạng thái app (cảnh LAN giữ nguyên trạng thái; `createFinalCutManual` của app vốn chỉ kiểm tra `selected_video_id`, nên dự án `app` không đổi hành vi). Thông báo khóa: `409 SCENES_NOT_READY` "Còn C2 chưa có video" · `409 FILE_MISSING` · `409 FINAL_CUT_ACTIVE`. Dự án `lan` **không bao giờ tự dựng**: `maybeAutoFinalCut` trả `null` cho `source='lan'`.
- `POST /lan/api/plans/:id/final-cuts` → `201 {final_cut, rate:{create_final_remaining}}` (version kế tiếp + job `edit_plan`; 6 lần/giờ dùng chung với rerender; trần hàng đợi 6).
- `GET …/final-cuts` (version giảm dần) · `GET …/final-cuts/:cutId`.
- `POST …/final-cuts/:cutId/rerender {edl, note?}` → `201 {final_cut}` (như 5.7: version MỚI `created_by='user'`, `400 INVALID_EDL` kèm `details.scene/segment`, `409 FINAL_CUT_ACTIVE`).
- **Góp ý và chỉnh màu (cùng nghiệp vụ mục 5.7, JSON an toàn như trên: `base_path=null`, ảnh/video qua `/lan/files`):** `POST …/final-cuts/:cutId/feedback {feedback}` → `201 {final_cut, rate:{feedback_remaining}}` (**20 lần/giờ/IP**) · `POST …/:cutId/grade {grade, note?}` → `201 {final_cut, rate:{grade_remaining}}` (**30 lần/giờ/IP**) · `POST …/:cutId/regrade` → `{final_cut, rate:{grade_remaining}}` (dùng chung hạn mức chỉnh màu) · `POST …/:cutId/grade-preview {grade}` → `{hash, items:[{t, before_url, after_url}], rate:{grade_preview_remaining}}` (**60 lần/giờ/IP**, không vào hàng đợi). `feedback`, `grade`, `regrade` **tính vào trần hàng đợi LAN 6** (`429 QUEUE_FULL`); hết hạn mức → `429 RATE_LIMITED` + `Retry-After`. Bản của dự án khác/dự án `app`/dự án trong thùng rác → `404`. File mới nằm trong danh sách cho phép của `/lan/files`: `<slug>_final_v<n>.mp4`, `_contact.png`, `_contact_graded.png` và ảnh xem trước `output/<slug>/final/preview/*.jpg` của kế hoạch LAN; **bản sạch `_base.mp4` KHÔNG phục vụ qua LAN**. `GET /lan/api/status` thêm `remaining.{feedback, grade, grade_preview}` và `rate.{feedback, grade, gradePreview}`.
- **Ảnh mẫu / LUT của kế hoạch LAN (cùng nghiệp vụ mục 5.9, dịch vụ dùng chung):** `GET /lan/api/plans/:id/color-refs` → `{items, sources}` (URL qua `/lan/files`; `sources.assets` chỉ gồm storyboard do CHÍNH người dùng LAN tải lên) · `POST …/color-refs` (multipart `file`) → `201 {color_ref, existing:false, rate:{color_ref_remaining}}` hoặc `200 {…, existing:true}` · `POST …/color-refs/from-asset {asset_id|ref_id}` (storyboard không do LAN tải lên → `404`) · `DELETE …/color-refs/:refId` (đang dùng → `409 COLOR_REF_IN_USE`). **Tải lên và chép: 20 lần/giờ/IP** (`LAN_RATE.colorRef`; chỉ lượt tạo mới tính, tải trùng nội dung thì không) → `429 RATE_LIMITED` + `Retry-After`; dùng chung cổng tải đồng thời. Kế hoạch đã xoá (thùng rác)/không phải kế hoạch LAN/id của kế hoạch khác → `404`. **Allowlist `/lan/files` thêm ảnh mẫu (ảnh gốc và `_thumb.jpg`) của kế hoạch LAN còn tồn tại; file `.cube` KHÔNG BAO GIỜ phục vụ** (cả LUT chuẩn hoá lẫn LUT sinh ra trong `luts/`). `grade`, `grade-preview` nhận `grade.match` (`ref_id` phải thuộc kế hoạch). `GET /lan/api/status` thêm `remaining.color_ref` và `rate.colorRef`; JSON bản dựng LAN có `color_ref` với URL `/lan/files`.
- `POST …/final-cuts/:cutId/cancel` → `{final_cut}` · `POST …/final-cuts/:cutId/clean` → `{final_cut, rate:{remove_logo_remaining}}` (chạy lại riêng bước xoá logo; `409 WATERMARK_REMOVER_UNAVAILABLE` với lý do đã che đường dẫn; tính vào hạn mức xoá logo).
- Bản dựng của id thuộc dự án khác (kể cả `app`) dùng với kế hoạch này → `404`.
- Hàng đợi render là CHUNG và chạy song song tối đa `RENDER_CONCURRENCY` việc (mặc định 2): việc của dự án `app` (chủ máy) được lấy **trước** mọi việc LAN đang chờ (FIFO trong từng nhóm; việc đang chạy không bị ngắt). Trần LAN 6 việc (bản dựng + việc công cụ) giữ nguyên, không phụ thuộc `RENDER_CONCURRENCY`.

### 13.4 Công cụ "Xoá logo Veo" độc lập

Không cần kế hoạch. Bảng `lan_tool_jobs` (migration 010): `id, kind='remove_logo', status queued|processing|ready|failed|cancelled|expired, progress, input_path, output_path, original_name, client_id_hash, created_by_name, error, meta, created_at, finished_at`. File nằm trong `output/lan-tools/<id>/` (`input.mp4|mov`, `clean.mp4`); file tải dở trong `output/lan-tools/.incoming/`.
- **Quyền xem:** cookie client ẩn danh `autovideo_lan_client` (`HttpOnly; SameSite=Strict; Path=/lan; Max-Age=34560000` = **400 ngày**, mức tối đa trình duyệt chấp nhận, vì mặc định không có phiên nên cookie này là thứ duy nhất giữ quyền xem việc cũ; 256 bit ngẫu nhiên, **cấp lười** ở route công cụ đầu tiên, không cấp lúc đăng nhập; việc vẫn tự xoá sau 7 ngày dù cookie còn); DB chỉ lưu `SHA-256` của giá trị. Chỉ trình duyệt tạo việc thấy/tải/hủy/thử lại; việc của người khác (kể cả cùng IP) → `404`. `GET /lan/files/output/lan-tools/<id>/clean.mp4` cũng kiểm tra đúng chủ; `input.*` không bao giờ được phục vụ.
- `GET /lan/api/tools/status` → `{remove_logo:{available, reason, max_bytes, min_s:1, max_s:120, remaining, rate}, queue, render:{running_count,waiting_count,concurrency}, retention_days:7}` (`available=false` khi `watermark_remover.active=false`, lý do đã che đường dẫn; UI khóa nút).
- `GET /lan/api/tools/jobs` → việc của mình (mới nhất trước, tối đa 30) · `GET …/jobs/:id`. Job JSON: `{id, kind, status, progress, original_name, created_by_name, error, created_at, finished_at, expires_at, input:{bytes,duration_s,width,height,has_audio}, output:{url,bytes,duration_s}|null, queue_ahead, queue_state, queue_position, running_count, concurrency, can_retry}`. `queue_state`: `waiting` (xếp hàng, **chưa bắt đầu**; `status="queued"`) | `running` (`status="processing"`) | `null` (không ở trong hàng đợi); `queue_position` 1 = chạy tiếp theo (`null` khi chạy); `running_count`/`concurrency` như 4.12. `queue_ahead` là trường cũ (0 = đang chạy, n = `running_count + queue_position`).
- `POST /lan/api/tools/jobs` (multipart: `created_by_name` tùy chọn rồi `file`) → `201 {job, rate}`: stream xuống đĩa như 13.2 nhưng thời lượng **1–120 giây**, ≤ 200 MB; xếp vào **cùng hàng đợi render** (`FinalRenderService.enqueueTool`), chạy `runWatermarkCli` + `verifyCleaned` (đúng như bước clean của bản dựng: ra file tạm `.clean.tmp.mp4`, ffprobe kiểm tra, đổi tên nguyên tử). Lỗi: `409 WATERMARK_REMOVER_UNAVAILABLE` · `429 RATE_LIMITED` (6/giờ) · `429 QUEUE_FULL` · `415/413/422` như 13.2.
- `POST …/jobs/:id/cancel` (đang chờ: bỏ khỏi hàng đợi; đang chạy: dừng cả cây tiến trình của tool; giữ input) · `POST …/jobs/:id/retry` (`failed`/`cancelled`; chịu hạn mức xoá logo và trần hàng đợi; `409 FILE_MISSING`/`INVALID_STATE`).
- Vòng đời: server khởi động lại giữa lúc `queued`/`processing` (nhiều việc cùng lúc cũng vậy) → `failed` (giữ input để thử lại); việc **quá 7 ngày** (tính từ lúc tạo, chỉ ready/failed/cancelled) bị timer 1 giờ xoá file và đánh dấu `expired`; file tải dở > 1 giờ bị dọn.

**Hàm thuần (có test `plan.test.ts`):** `server/src/services/plan.ts` (`buildStoryboardMessage`, `extractFrameLines`, `buildScenePlans`, `buildPlan`, `planToMarkdown`, `fenceFor`) và `services/zip.ts`. `GET /api/lan` (app chính, localhost) trả `{enabled, listening, error, host, port, urls[], require_code, access_code, plan_count, tool_jobs_24h, queue, render}` cho khối **Chia sẻ LAN** trên header web; chỉ báo cáo, bật/tắt bằng `.env` + khởi động lại.

**Giao diện:** `web/planner.html` + `web/src/planner/*` (thêm `VideoStep.tsx` = Bước 3, `FinalBlock.tsx` = khối Bản hoàn chỉnh dùng lại `EdlEditor`/`FinalTimeline`/`CleanLogoView` qua props, `ToolPage.tsx` = tab "Xoá logo Veo" ở `#/tools/remove-logo`; tải video bằng XHR có tiến độ) (bundle Vite riêng, không có react-router/API của app chính). Dev: `npm run dev` rồi mở `http://localhost:5173/planner.html` (Vite proxy `/lan` → `LAN_PORT`, cần `LAN_ENABLED=true`). Nút sao chép dùng `document.execCommand('copy')` khi không có `navigator.clipboard` (trang LAN chạy HTTP, không phải secure context).

---

## 14. Cắt clip từ video dài (long video → shorts)

Người dùng tải một video dài (livestream, podcast, review… tiếng Việt) lên một dự án `kind='clips'`; server nhận dạng lời nói, AI chọn các đoạn hay, người dùng duyệt và sửa điểm cắt trên lời thoại, rồi server dựng clip 9:16 có phụ đề chạy theo từng từ. Không tốn credit Flow. Kế hoạch gốc: `PLAN-long-video-to-shorts.md` (phần nhận dạng lời nói đã đổi sang dịch vụ STT nội bộ, xem 14.5).

**Luồng**: tạo dự án → tải video (`source`, tự xếp nhận dạng) → `transcribed` → `clip-plan` (AI) hoặc tạo clip tay từ khoảng từ → duyệt/sửa → `render` → tải mp4/srt hoặc ZIP.

Cùng bộ endpoint, cùng JSON ở **app chính** (`/api/...`) và **listener LAN** (`/lan/api/...`, mục 14.8). Bảng dưới ghi đường dẫn của app chính; LAN thay `/api` bằng `/lan/api`.

### 14.1 Kiểu dữ liệu

```
ClipProjectDetail = {
  project: { id, name, slug, kind:'clips', source:'app'|'lan', stt_terms, created_at, created_by_name },
  source: SourceVideo | null,                 // đợt 1: mỗi dự án một video nguồn
  clips: Clip[],                              // theo id (K1, K2…)
  plan_job: PlanJob | null,                   // job clip_plan mới nhất
  delete_block?: { code, message, reasons[] } | null    // app chính (như 5.8): lý do chưa xoá được
  // LAN: can_delete (trình duyệt này là người tạo) và delete_block là chuỗi | null (chỉ khi can_delete)
}

SourceVideo = {
  id, project_id, original_name, bytes, duration_s, width, height, fps,
  status: 'uploaded'|'transcribing'|'transcribed'|'failed'|'cancelled',
  progress,                                   // 0–100, ƯỚC TÍNH theo thời gian (dịch vụ STT không trả %), kẹp 95 tới khi xong; null khi không chạy
  error, error_code,                          // tiếng Việt; error_code: STT_NOT_CONFIGURED | STT_UNAVAILABLE | STT_REJECTED | STT_TIMEOUT | STT_BAD_RESPONSE | AUDIO_EXTRACT_FAILED | STT_ERROR…
  queue: { state: 'waiting'|'running'|null, position: number|null },   // hàng đợi nhận dạng (một việc một lúc)
  video_url,                                  // app: /files/… (video gốc, có Range). LAN: bản xem thử 480p /lan/files/… (null tới khi tạo xong)
  poster_url, word_count, speech_ratio,       // 0–1: tỉ lệ thời gian có lời; < 0.3 = video ít lời (kết quả AI kém)
  source_deleted,                             // true: video gốc đã bị xoá sau hạn lưu (LAN); status vẫn 'transcribed'
  created_at
}

Clip = {
  id, project_id, code, status: 'proposed'|'approved'|'rejected',
  start_s, end_s, duration_s,                 // đã bám khoảng lặng (14.4)
  start_word, end_word,                       // chỉ số từ toàn cục (gồm hai đầu), cũng là khóa để sửa điểm cắt
  start_sentence, end_sentence,
  title, hook, score (0–100|null), reason, content_type,
  verify: { status:'kept'|'unverified'|'repaired', standalone_score, diagnosis, keep? } | null,
  created_by: 'agent'|'user',
  thumb_url,                                  // ảnh khung ở 40% clip (có ?v=<mtime> để làm mới cache), null tới khi tạo xong
  transcript_excerpt,                         // ≤ 400 ký tự (chữ phụ đề hiện tại, từ ẩn bỏ qua)
  caption_edited,                             // true nếu người dùng sửa tay chữ phụ đề
  caption_words: [{i, w}] | null,             // (bổ sung hợp đồng) chữ phụ đề hiện tại: đã khôi phục dấu câu (AI) hoặc sửa tay; null = dùng chữ ASR
  captions: {preset, layout: {left, width, bottom} | null},  // kiểu phụ đề đã lưu (PATCH captions); captions_outdated: bản dựng gần nhất (ready) dùng kiểu khác kiểu đang lưu
  latest_cut: ClipCut | null, cuts_count
}

ClipCut = {
  id, clip_id, project_id, version, status: 'rendering'|'ready'|'failed'|'cancelled',
  stage: 'prepare'|'render'|null, progress (0–100|null), error,
  aspect: '9:16'|'1:1'|'16:9'|'source',
  reframe: { mode: 'fit'|'center', native?: true },   // native: nguồn đã đúng tỉ lệ, chỉ scale
  captions: { preset: 'highlight'|'karaoke'|'minimal'|'none' },
  start_s, end_s, duration_s,
  video_url, srt_url,                         // chỉ khi ready
  queue_state: 'waiting'|'running'|null, queue_position, running_count, concurrency,   // như 4.12
  created_at, finished_at
}

PlanJob = {
  id, status: 'queued'|'claimed'|'running'|'done'|'failed'|'cancelled',
  queue: { state, position, ahead } | null,   // hàng đợi worker AI (như 4.12 ai_queue)
  wait_reason, worker, error, summary, not_found_reason, created_clips, created_at, finished_at
}
```

### 14.2 Endpoint

| Endpoint | Kết quả / ghi chú |
|---|---|
| `POST /api/clip-projects {name, stt_terms?}` | `201 ClipProjectDetail`. `stt_terms` ≤ 500 ký tự: tên riêng/thuật ngữ, gửi làm `prompt` cho STT (chỉ khi có) |
| `GET /api/projects` | mỗi dự án thêm `kind`; dự án `clips` thêm `clip_count`, `source_video:{duration_s,status}\|null`, `stt_terms` |
| `GET /api/clip-projects/:id` | `ClipProjectDetail` (dự án `kind='scenes'` → 404) |
| `PATCH /api/clip-projects/:id {name?, stt_terms?}` | `ClipProjectDetail`. Đổi `stt_terms` không tự nhận dạng lại (xem `transcribe`) |
| `POST /api/projects/:id/source` | multipart `file` (stream xuống đĩa, không giữ RAM) → `201 {source}`. Nhận mp4/mov/mkv/avi theo magic bytes; `ffprobe` phải thấy hình + tiếng; thời lượng ≤ `CLIP_SOURCE_MAX_S`, dung lượng ≤ `CLIP_SOURCE_MAX_BYTES` (LAN: `LAN_CLIP_SOURCE_*`); ổ đĩa trống ≥ `CLIP_MIN_FREE_GB` + 3 × dung lượng. Trùng `content_hash` trong dự án → dùng lại (không nhận dạng lại; nếu bản cũ `failed/cancelled` thì chạy lại). Video khác khi dự án đã có video: thay được nếu chưa có clip và không đang nhận dạng (bản cũ bị xoá, transcript cũ lưu thành `transcript.v<k>.json`), không thì `409 SOURCE_EXISTS`. Xong thì server tự xếp nhận dạng. Chưa cấu hình STT: vẫn nhận file nhưng `status:'failed', error_code:'STT_NOT_CONFIGURED'` |
| `POST /api/sources/:id/transcribe` | `{source}`. Chạy lại khi `failed`/`cancelled`/`uploaded`, hoặc khi `transcribed` mà `stt_terms` đã đổi so với lần nhận dạng (bản transcript cũ được lưu, không ghi đè); có clip rồi thì `409 CLIPS_EXIST` (chỉ số từ sẽ đổi). Khác → `409 INVALID_STATE`; chưa cấu hình → `409 STT_NOT_CONFIGURED` |
| `POST /api/sources/:id/cancel` | `{source}` (`cancelled`); chỉ khi `transcribing`/`uploaded`. Dừng ffmpeg/fetch, kết quả muộn không ghi đè |
| `GET /api/sources/:id/transcript?from=&limit=` | `{total, sentences:[{id,start,end,words:[{i,w,start,end}]}]}`; phân trang theo CÂU, `from` bắt đầu từ 0, `limit` mặc định 200 tối đa 500. Chữ thường, không dấu câu (đúng như ASR). Chưa xong → `409 NOT_TRANSCRIBED` |
| `GET /api/sources/:id/transcript.srt` · `.txt` | tải về: SRT theo câu (viết hoa chữ đầu câu) · mỗi câu một dòng `[hh:mm:ss] nội dung` |
| `POST /api/projects/:id/clip-plan {count?, duration_preset?, focus?, exclude_existing?}` | `201 {job: PlanJob}`. `count` 1–15 (mặc định 5); `duration_preset` ∈ `15_30`\|`30_60` (mặc định)\|`60_90`\|`90_180`; `focus` ≤ 300 ký tự (là DỮ LIỆU cho AI, không phải lệnh); `exclude_existing` loại các đoạn trùng clip đã có. Chỉ khi `transcribed`, còn file video, có lời (`409 NO_SPEECH`), chưa có job `clip_plan` đang chạy (`409 JOB_ACTIVE`), video gốc chưa bị xoá (`409 SOURCE_DELETED`) |
| `PATCH /api/clips/:id {status?, title?, start_word?, end_word?}` | `{clip}`. Đổi điểm cắt bằng chỉ số từ: server tính lại câu và giây (14.4); độ dài 3–300 giây (`400 CLIP_LENGTH`), chỉ số sai `400 INVALID_WORD_RANGE`. Chữ phụ đề đã sửa của các từ còn trong khoảng mới được giữ |
| `POST /api/projects/:id/clips {start_word, end_word, title?}` | `201 {clip}` tạo tay (`created_by:'user'`, `status:'approved'`) |
| `PUT /api/clips/:id/captions {words:[{i, w}]}` | `{clip}`. Sửa chữ từng từ, giữ mốc thời gian; `w:""` = ẩn từ (thời gian cộng vào từ hiển thị đứng trước, nên "ca cao a tiso" → `ca="Cacao"`, `cao=""`, `a="Actiso"`, `tiso=""`). Gửi một phần cũng được (server gộp với chữ hiện có); `i` ngoài clip → `400 INVALID_WORD_RANGE`; mỗi chữ ≤ 60 ký tự |
| `POST /api/clips/:id/render {aspect?, reframe_mode?, captions_preset?, captions_layout?}` | `201 {cut: ClipCut}`. `aspect` mặc định `9:16`; `reframe_mode` ∈ `fit`(nền mờ, mặc định khi nguồn ngang)\|`center`, bỏ qua khi nguồn đã đúng tỉ lệ; `captions_preset`/`captions_layout` vắng = dùng kiểu đã lưu của clip (`clip.captions`; mặc định `highlight`, không layout), `captions_layout:null` = vị trí mặc định. Bản dựng ghi lại `captions` = `{preset}` hoặc `{preset, layout}`. Xếp vào hàng đợi render chung (app trước LAN, `RENDER_CONCURRENCY`) |
| `PATCH /api/clips/:id {captions: {preset?, layout?}}` | `{clip}`. Lưu kiểu phụ đề của clip. `layout` = `{left, width, bottom}` là tỉ lệ 0–1 của khung đầu ra (mép trái, bề rộng hộp, khoảng cách từ đáy khung tới đáy hộp); kiểm tra `left ≥ 0`, `0.25 ≤ width ≤ 1`, `left + width ≤ 1`, `0 ≤ bottom ≤ 0.9` (sai → `400`); `layout:null` xoá về căn giữa-dưới mặc định; trường vắng giữ nguyên. ASS: `Alignment 2`, `MarginL = round(left·W)`, `MarginR = round((1−left−width)·W)`, `MarginV = round(bottom·H)`, `WrapStyle 0` (chỉ khi có layout) |
| `POST /api/clips/:id/preview-frame {at?, captions?: {preset?, layout?}}` | `200 {url, at, width, height}`. Dựng MỘT khung jpg (ffmpeg + ASS + font như bản dựng) ở giây `at` tính từ đầu clip (mặc định 40%); `captions` chưa lưu chỉ để xem thử, vắng thì dùng kiểu đã lưu. Tối đa 1 ffmpeg xem thử cùng lúc: yêu cầu mới thay yêu cầu đang chạy (cái cũ → `409 PREVIEW_STALE`). Ảnh ở `output/<slug>/clips/frames/<code>_<mã>.jpg`, giữ 6 ảnh gần nhất. LAN: tính vào hạn mức sửa clip |

| `POST /api/clip-cuts/:id/cancel` | `{cut}`: hủy bản đang dựng, kill ffmpeg, xoá file dở |
| `GET /api/projects/:id/clips.zip` | ZIP: mọi clip có bản `ready` mới nhất (`K1_<tieu-de>_v2.mp4` + `.srt`); không có gì → `404` |
| `GET /api/projects/:id/clips` · `GET /api/clips/:id` · `GET /api/clips/:id/cuts` | (bổ sung) danh sách clip · một clip `{clip}` · mọi phiên bản dựng của clip (mới nhất trước) |
| `GET /api/clip-status` | (bổ sung) giới hạn và khả năng: `{max_bytes, max_s, retention_days, stt:{configured}, captions:{available, reason, font}, plan:{min_count,max_count}, duration_presets, caption_presets, aspects, reframe_modes}`; cũng có ở `GET /api/meta` → `clips` |

Xoá dự án/thùng rác dùng lại `DELETE /api/projects/:id` (5.8). Đang nhận dạng, đang dựng clip, job `clip_plan` đang chạy hoặc đang tải video lên → `409 PROJECT_BUSY` (`reasons[].code` gồm `CLIP_ACTIVE`).

### 14.3 Mã lỗi riêng

| HTTP | `code` | Khi nào |
|---|---|---|
| 409 | `NOT_TRANSCRIBED` · `NO_SOURCE` · `NO_SPEECH` | video chưa nhận dạng xong · dự án chưa có video · transcript không có từ nào |
| 409 | `SOURCE_EXISTS` · `SOURCE_DELETED` · `CLIPS_EXIST` | dự án đã có video khác và clip · video gốc đã bị xoá · không nhận dạng lại khi đã có clip |
| 409 | `STT_NOT_CONFIGURED` | `POST transcribe` khi chưa cấu hình STT |
| 409 | `CUT_ACTIVE` | clip đang dựng một bản khác |
| 409 | `CAPTIONS_UNAVAILABLE` | ffmpeg trên máy chủ thiếu libass mà chọn phụ đề (chọn `none` vẫn dựng được) |
| 409 | `NO_FFMPEG` | không tìm thấy ffmpeg |
| 400 | `INVALID_WORD_RANGE` · `CLIP_LENGTH` | chỉ số từ sai · độ dài clip ngoài 3–300 giây |
| 400 | `INVALID_CLIP_PLAN` | (worker) có đề xuất mà tất cả đều không hợp lệ (job được giữ để sửa) |
| 422 | `INVALID_VIDEO` · `NO_AUDIO` · `VIDEO_DURATION` | ffprobe không đọc được · video không có âm thanh · thời lượng vượt giới hạn |
| 413 · 415 | `FILE_TOO_LARGE` · `UNSUPPORTED_FILE_TYPE` | vượt dung lượng · không phải video (magic bytes) |
| 507 | `INSUFFICIENT_STORAGE` | ổ đĩa trống < `CLIP_MIN_FREE_GB` + 3 × dung lượng (khi dựng: + ước tính clip) |

### 14.4 AI chọn đoạn: job `clip_plan`

Một job nằm trong hàng đợi AI chung (managed worker, hoặc worker legacy theo WORKER.md 4.6). Thời gian cắt **không bao giờ lấy từ số giây AI viết**: AI trả **ID câu + câu trích đầu/cuối**; server dò chỉ số từ ASR rồi ánh xạ từ → giây (có thể cắt giữa câu).

**Payload** (tính lúc claim; API/SSE chỉ trả `sentence_count`/`window_count` thay cho mảng câu, worker nhận đủ qua `claim` và `GET /api/worker/jobs/:id`):
```
{ project:{id,slug,name}, source_id, source:{id,path,duration_s,width,height},
  sentences:[{id,start,end,start_word,text,words:[{i,start,end}]}], // text chữ thường, ID = chỉ số câu tuyệt đối của video
  windows:[{from_id,to_id}],                       // cửa sổ 15–20 phút, chồng ~60 s, tính theo ID câu
  count, duration_preset:{key,min_s,max_s,ideal_min_s,ideal_max_s}, focus, exclude_existing,
  existing:[{start_id,end_id,title}],              // chỉ khi exclude_existing
  content_hint, speech_ratio, requeued }
```
Preset (cứng / lý tưởng, giây): `15_30` 15–30 / 18–28; `30_60` 30–60 / 38–55; `60_90` 60–90 / 65–85; `90_180` 90–180 / 100–160.

**Kết quả** `POST /api/worker/jobs/:id/complete`: `{result:{ clips:[{start_id,end_id,start_quote?,end_quote?,start_word?,end_word?,title,hook,score,reason,content_type,verify,caption_words?}], summary, diagnostics?, not_found_reason? }}` (không asset, không credit).
- Server kiểm tra lại TỪNG đề xuất: ID tồn tại, `start_id ≤ end_id`, độ dài (sau bám khoảng lặng) trong khoảng cứng của preset **±20%** và 3–300 giây, không chồng > 60% đề xuất đã nhận (và clip có sẵn khi `exclude_existing`), tối đa `count`. Đề xuất sai bị loại riêng (`job.result.rejected` = số bị loại, `created` = số clip tạo); mảng rỗng là hợp lệ ("không có đoạn nào đạt", kèm `not_found_reason`); có đề xuất mà TẤT CẢ sai → `400 INVALID_CLIP_PLAN` và job giữ nguyên.
- `start_quote`/`end_quote`: 4–8 từ đầu/cuối clip, dò theo thứ tự từ trong ID ±1 câu, không phân biệt dấu/hoa thường, khớp ≥70%. `start_word`/`end_word` (nếu gửi) phải khớp câu trích và nằm trong cửa sổ ID ±1; server tự tính lại giây. Không dò được câu trích thì dùng cả câu nếu độ dài hợp lệ, ghi `verify.boundary='sentence_fallback'`; dò được cả hai thì `word_quote`. Worker cũ không gửi các trường mới vẫn dùng điểm theo câu.
- `diagnostics:{proposed,rejected:[{start_id,end_id,reason}]}` ghi số đề xuất thô và lý do worker loại trước kiểm định, lưu cả khi kết quả rỗng và trong checkpoint. Không lẫn với `job.result.rejected` (số đề xuất server loại).
- `verify` mặc định `{status:'unverified'}` nếu AI không kiểm định được (KHÔNG tự coi là đạt).
- `caption_words` (chữ thường/dấu câu đã khôi phục) chỉ được nhận nếu **giữ nguyên dãy từ** ASR (đủ từ, từng từ bỏ dấu câu và chữ thường trùng ASR); sai thì bỏ riêng phần này, clip dùng chữ ASR.
- **Bám khoảng lặng** (`snapBounds`): `start_s = start của từ đầu − 0.15 s`, không lùi quá `end của từ trước + 0.02 s`; `end_s = end của từ cuối + 0.30 s`, không quá `start của từ sau − 0.02 s` và ≤ thời lượng video. Không bao giờ cắt vào giữa một từ.

Quy trình của worker: (1) phân loại nội dung (~3000 ký tự đầu); (2) đề xuất theo từng cửa sổ (~2×count ứng viên, tiêu chí: hook 3 giây đầu, cảm xúc, quan điểm mạnh, tiết lộ, câu đáng trích, mẹo thực dụng, livestream bán hàng thêm công dụng/chốt giá/phản hồi khách; câu mở phải hiểu được khi không có ngữ cảnh); (3) kiểm tra (`start_quote` + `end_quote` ≥70% theo thứ tự từ, dò ±1 câu; worker và server dùng chung bộ dò); (4) khử trùng (chồng > 60%, Jaccard title+reason ≥ 0.33); (5) kiểm định "đứng một mình" theo lô 4 kèm lưới 4 khung hình thật (`keep`, `standalone_score`, `diagnosis`, sửa và chấm lại một lần; lỗi gọi → `unverified`); (6) top `count` theo điểm (ưu tiên đã kiểm định); (7) khôi phục chữ hoa/thường + dấu câu cho từng clip. Có checkpoint (`checkpoint.clip_plan`) sau mỗi bước tốn kém nên hết hạn mức AI giữa chừng chỉ chờ rồi chạy tiếp. Lỗi mạng/timeout ở từng lời gọi inference được thử lại tối đa 2 lần, chờ 1 rồi 2 giây; mất lease/hủy/hết tài khoản (`AI_UNAVAILABLE`) đi theo cơ chế chờ/hủy sẵn có, không thử lại mù. Không đổi timeout 120 giây của gateway.

### 14.5 Nhận dạng lời nói (STT nội bộ, Omnix)

- Cấu hình: `STT_PROVIDER` (`omnix`|`none`, mặc định `omnix` nếu có `STT_URL`), `STT_URL`, `STT_TENANT_ID` (`s-omnix-studio`), `STT_TIMEOUT_MS` (1 giờ), `STT_MAX_RETRIES` (3). Chỉ HTTP.
- Hàng đợi **một việc một lúc** trong tiến trình (app chính trước LAN), vị trí ở `source.queue`. Mỗi việc: `ffmpeg -vn -ac 1 -ar 16000 -c:a libmp3lame -b:a 48k` ra file tạm (3 giờ ≈ 65 MB) → `POST /v1/audio/transcriptions` (multipart `file`, `response_format=verbose_json`, `timestamp_granularities[]=word`, `prompt`=`stt_terms` nếu có, header `X-Tenant-ID`) → `X-Job-Id` lưu ngay vào `source_videos.stt_job_id`.
- Lỗi `retryable:true` (502/503 `no_capacity`, `fetch_failed`, `runtime_*`) và lỗi mạng → thử lại với backoff 10 s / 30 s / 90 s. 504 `transcription_timeout` hoặc đứt kết nối SAU khi có `X-Job-Id` → hỏi `GET /v1/stt/jobs/{id}` (header `X-Tenant-ID`) thay vì gửi lại file. Phản hồi thật của endpoint này (đã thử): `{job_id, tenant_id, state:"succeeded", platform_state, attempt_state, task_id, text, segments, duration_seconds, model, error, created_at, updated_at}` — **không có `words`**, nên thiếu mốc từng từ thì coi là lỗi tạm (`STT_JOB_NO_WORDS`) và gửi lại file. Lỗi khác → `failed` kèm `error_code` và thông báo tiếng Việt.
- Audio không có lời: `text` rỗng, không lỗi → `transcribed` với 0 từ (`409 NO_SPEECH` khi chọn đoạn).
- Khởi động lại server: việc `transcribing` có `stt_job_id` → thử lấy kết quả theo job id, không được (hoặc thiếu words) thì chạy lại từ đầu; chưa cấu hình dịch vụ → `failed STT_NOT_CONFIGURED`.
- Cache theo `content_hash` + `stt_terms`: video giống hệt (ở dự án khác) đã có transcript thì chép lại, không gọi dịch vụ.
- `transcript.json` (`output/<slug>/clips/`): `{version, model, duration_s, terms, content_hash, words:[{i,w,start,end,p}], sentences:[{id,start_word,end_word,start,end,text}], segments, speech_ratio}`. Từ có `end ≤ start` sửa thành `start + 0.08`. Thêm `pauses:[{start,end}]` và `pause_detect:{threshold_db,floor_db,speech_db,min_s,method}`: ffmpeg đo RMS cửa sổ 50 ms, ngưỡng = p5 + 35% × (p90 − p5), kẹp [−55,−25] dB, rồi `silencedetect` ≥0,15 s. Khoảng ngừng ≥0,3 s được gán vào ranh giới từ gần nhất để chia câu; đoạn dài hơn 12 s hoặc 30 từ chia tiếp, ưu tiên khoảng lặng và độ dài ~5 s. Siết cuối từ tại đầu khoảng lặng nằm trong từ và bám điểm cắt vào khoảng lặng gần ≤0,4 s (vẫn giữ ràng buộc từ lân cận). Lỗi đo audio thì giữ cách cũ (segment STT/khe ≥0,7 s, giới hạn 25 s/60 từ). Cache cũ thiếu `pauses` được đo lại cục bộ khi dùng cho dự án mới, không gọi STT lại và không sửa ID của transcript/clip dự án cũ. Phụ đề ASR chỉ viết hoa đầu clip, sau dấu kết câu hoặc ngừng ≥0,6 s; không viết hoa ở ranh giới chỉ do giới hạn độ dài.
- Thử tay với dịch vụ thật: `server/src/scripts/stt-smoke.ts <file> ["thuật ngữ"]` (KHÔNG chạy trong `npm test`; test dùng server STT giả).

### 14.6 Dựng clip

Một lượt ffmpeg: `-ss start -i src -t dur` (mã hoá lại nên cắt chính xác) → reframe → `subtitles` (ASS) → `afade` 0.06 s hai đầu → libx264 crf 18 preset medium + aac 160k + `+faststart`.
- Khung: `9:16` 1080×1920, `1:1` 1080×1080, `16:9` 1920×1080, `source` (giữ kích thước nguồn). Nguồn đã đúng tỉ lệ (sai lệch < 2%) → chỉ scale (`reframe.native=true`). `fit`: nền = phóng phủ khung, làm mờ (ở 1/4 độ phân giải, `boxblur`), giảm sáng nhẹ; lớp chính giữ tỉ lệ, overlay giữa. `center`: cắt giữa khung theo tỉ lệ đích.
- Phụ đề ASS sinh bằng TypeScript (`services/clips/captions.ts`; ý tưởng từng-từ-một-`Dialogue` theo clipify `build_ass.py`, MIT): PlayRes = độ phân giải đầu ra, `WrapStyle 2`, alignment 2, MarginV 300 (9:16), viền 8, bóng 3, chữ đậm. `highlight` (vàng) / `karaoke` (xanh lá): cụm 3 từ, mỗi từ một `Dialogue` hiển thị cả cụm và tô từ đang nói; `minimal`: cụm ≤ 8 từ / 42 ký tự / 3.2 giây, không tô; `none`: không phụ đề. Ngắt cứng ở khoảng lặng ≥ 0.6 s, ngắt mềm ở dấu phẩy hoặc khoảng lặng ≥ 0.35 s. Chữ lấy từ `caption_words` (đã khôi phục/sửa tay) nếu có, không thì ASR viết hoa đầu câu. `{ } \` trong chữ bị thay bằng `( ) /` (cả ASS lẫn SRT). Sinh kèm `.srt` (cụm kiểu `minimal`).
- **Font**: mặc định `Arial` đậm (`CLIP_CAPTION_FONT`); server chép `Arial Bold.ttf` của macOS vào `<thư mục DB>/clip-fonts` làm `fontsdir` (hoặc dùng `CLIP_FONTS_DIR`). Đã kiểm chứng bằng render thật câu "Ưu đãi đặc biệt hôm nay: giảm giá sốc, mua ngay!" (đủ dấu tiếng Việt) với Arial Bold, Helvetica Neue Bold, Verdana Bold, Tahoma Bold, Trebuchet MS Bold: cả năm đều đủ dấu; chọn Arial Bold vì có sẵn trên mọi máy macOS và rõ nét ở cỡ 72.
- **Yêu cầu ffmpeg có libass**: ffmpeg của Homebrew trên máy này KHÔNG có bộ lọc `subtitles`/`drawtext`; Shotcut cũng không. Server dò (theo thứ tự) `CLIP_FFMPEG_PATH`, ffmpeg mặc định, `/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg`, `/usr/local/opt/ffmpeg-full/bin/ffmpeg`, `/opt/homebrew/bin/ffmpeg`…; cái nào có `subtitles` + `boxblur` + `overlay` + libx264/aac thì dùng cho bản dựng có phụ đề. Không có → `409 CAPTIONS_UNAVAILABLE` (kèm hướng dẫn), `GET /api/clip-status` → `captions.available=false`; chọn "Không phụ đề" vẫn dựng bằng ffmpeg mặc định.
- Tiến độ theo `-progress`; hủy = kill ffmpeg + xoá file dở (`.K1_v1.tmp.mp4`, `.srt`, `.ass`); file chỉ xuất hiện khi hoàn tất (đổi tên nguyên tử), không bao giờ ghi đè (version kế tiếp bỏ qua tên đã có trên đĩa). Server khởi động lại giữa lúc dựng → bản đó `failed` ("Server khởi động lại trong lúc dựng"), file dở được dọn.

### 14.7 File

```
output/<slug>/clips/
  source/<hash16>.<ext>        video gốc (sha256 nội dung); source/preview_480p.mp4 (chỉ LAN)
  transcript.json              (+ transcript.v<k>.json: bản cũ khi nhận dạng lại / thay video)
  clips/K1_v1.mp4 .srt .ass    bản dựng (.ass chỉ khi có phụ đề)
  thumbs/K1.jpg, poster.jpg    ảnh đại diện clip (thay thế khi điểm cắt đổi) và poster video
```
Đi theo thư mục dự án vào thùng rác và khôi phục đúng chỗ cũ (`trash.ts` không đổi). `/files/*` phục vụ mọi thứ (Range cho video gốc). File tạm: `.stt-<id>.mp3` (tách audio), `.lan-upload-*.tmp` (tải dở, dọn sau 1 giờ).

### 14.8 Trang LAN

Cùng bộ endpoint dưới `/lan/api/...` (mục 13: Host, Origin, CSP, cookie client). Thêm: `GET /lan/api/clip-projects` (danh sách dự án cắt clip của LAN, `can_delete` theo cookie), `DELETE /lan/api/clip-projects/:id` (chỉ người tạo; vào thùng rác 30 ngày; `DELETE /lan/api/plans/:id` cũng dùng được cho dự án cắt clip), `GET /lan/api/clip-status`. `POST /lan/api/clip-projects` nhận thêm `created_by_name`.
- Dự án LAN và dự án app tách nhau (chéo → 404); kế hoạch prompt và dự án cắt clip không lẫn trong danh sách của nhau.
- Hạn mức theo IP mỗi giờ: tạo dự án 10, video nguồn 3 (cũng tính nhận dạng lại), AI chọn đoạn 6, dựng clip 30, sửa (duyệt/điểm cắt/phụ đề/tên) 120; tối đa **1 lượt tải video đồng thời mỗi IP** (2 toàn listener); chỉ lượt thành công mới tính. Vượt → `429 RATE_LIMITED`/`UPLOAD_BUSY`.
- Tính vào trần hàng đợi LAN (6, `queue.clips`): video đang chờ/chạy nhận dạng, job `clip_plan` đang chờ/chạy, bản dựng clip đang dựng. Đầy → `429 QUEUE_FULL`.
- `GET /lan/api/status` thêm `remaining.clip_project|clip_source|clip_plan|clip_render|clip_edit`, `rate.clip*`, `queue.clips`, và `clip` (giới hạn như `/api/clip-status`).
- Giới hạn riêng: `LAN_CLIP_SOURCE_MAX_BYTES` (2 GiB), `LAN_CLIP_SOURCE_MAX_S` (3 giờ).
- **Không phục vụ video gốc qua LAN.** Sau khi tải, server sinh `source/preview_480p.mp4` (H.264 480p, CRF 28, trong hàng đợi render, xếp sau việc của app) làm `video_url`. Allowlist `/lan/files`: bản xem thử, poster, ảnh clip `thumbs/K<n>.jpg`, và clip `ready` (`clips/K<n>_v<m>.mp4|.srt`) của dự án LAN còn tồn tại; `.ass`, `transcript.json`, video gốc, file của bản chưa `ready`, file của dự án app → `404`.
- Lỗi trong JSON LAN được lọc đường dẫn máy chủ (như mục 13).
- Tự xoá video gốc sau `LAN_CLIP_SOURCE_RETENTION_DAYS` (7) ngày (timer mỗi giờ; bỏ qua video đang nhận dạng/dựng): giữ transcript, bản xem thử và clip; `source.status` vẫn `transcribed`, `source_deleted:true`; không dựng clip mới / chọn đoạn mới (`409 SOURCE_DELETED`), vẫn xem transcript và tải clip đã dựng.
