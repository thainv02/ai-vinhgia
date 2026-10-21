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
| `MAX_CONCURRENT_VIDEO_JOBS` | `4` | Tối đa job video ở trạng thái `claimed/running` cùng lúc (toàn hệ thống) |
| `REQUIRE_PROMPT_APPROVAL` | `true` | `true`: cảnh mới vào `awaiting_approval`. `false`: tự vào `storyboard_queued` + tạo job storyboard |
| `HEARTBEAT_STALE_MINUTES` | `5` | Job claimed/running không heartbeat quá số phút này bị trả về `queued` |
| `WORKER_ONLINE_SECONDS` | `90` | Worker online nếu có request hợp lệ trong số giây này |
| `EXTRA_ALLOWED_ORIGINS` | rỗng | Origin bổ sung (cách nhau dấu phẩy) |
| `FINAL_RENDERER` | `auto` | Trình dựng bản hoàn chỉnh: `auto` (Shotcut nếu cấu hình đủ và `--check` của MCP chạy được, ngược lại ffmpeg) · `shotcut` · `ffmpeg` |
| `SHOTCUT_MCP_PYTHON` | rỗng | Đường dẫn **tuyệt đối** tới Python chạy Shotcut MCP (vd `…/cpython-3.12-macos-aarch64-none/bin/python3.12`) |
| `SHOTCUT_MCP_SERVER_SCRIPT` | rỗng | Đường dẫn tuyệt đối tới `shotcut_mcp_server.py`. Server chạy `<python> <script>` với `SHOTCUT_MCP_ALLOWED_ROOTS=<ROOT_DIR>` và `SHOTCUT_MCP_REQUIRE_ABSOLUTE_PATHS=1` |
| `WATERMARK_REMOVER` | `auto` | Xoá logo Veo trên bản dựng hoàn chỉnh: `auto` (bật nếu `GWR_CLI` tồn tại và `node <GWR_CLI> --help` chạy được) · `off` (bỏ qua bước này) |
| `GWR_CLI` | `<repo>/gemini-watermark-remover/bin/gwr.mjs` | Đường dẫn **tuyệt đối** tới `bin/gwr.mjs` của tool xoá logo Veo. Server chạy `node <GWR_CLI> remove <raw> --output <tmp> --json …` với `cwd` = thư mục repo của tool |
| `GWR_VIDEO_BITRATE_MBPS` | rỗng | Truyền `--video-bitrate-mbps N` cho tool; trống = mặc định của tool |
| `GWR_TIMEOUT_MS` | `1800000` (30 phút) | Truyền `--video-timeout-ms` cho tool; quá hạn (+30 giây) server dừng cả cây tiến trình và báo lỗi |
| `FFMPEG_PATH` / `FFPROBE_PATH` | rỗng | Tùy chọn; mặc định tìm trong `PATH`, rồi `/Applications/Shotcut.app/Contents/MacOS/`, rồi Homebrew |
| `NODE_ENV` | | `production` (do `npm start` đặt) → phục vụ `web/dist` |

Cấu hình hiệu lực (không gồm token) có ở `GET /api/meta` → `config`.

Server làm gì khi khởi động / định kỳ: chạy migration (`server/migrations/NNN_*.sql`, bảng `schema_migrations`), sao lưu DB vào `data/backup/app-<timestamp>.db` bằng `db.backup()` (giữ 20 bản mới nhất), timer 30 giây quét job mất heartbeat, timer 10 giây phát SSE `worker.status` khi online/offline đổi, **bản dựng hoàn chỉnh đang `rendering` của tiến trình cũ được đánh dấu `failed`** ("Server khởi động lại trong lúc render; bấm Render lại"), và điền `content_hash` còn thiếu của ảnh tham chiếu. **Bản đang `rendering` ở bước xoá logo** → `failed` với `failed_stage="clean"` ("Server khởi động lại trong lúc xoá logo Veo; bấm Thử xoá logo lại"; bản raw còn nguyên, file tạm bị dọn). Migration `004_watermark.sql` chỉ `ALTER TABLE final_cuts ADD COLUMN` (stage, raw_video_path, failed_stage, watermark_removed, watermark_meta). Migration `003_final_cuts.sql` dựng lại bảng `jobs` (thêm `edit_plan`) — runner tắt `foreign_keys` rồi chạy `PRAGMA foreign_key_check` trước khi commit (directive `-- migrate:foreign-keys-off`).

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
| `job.type` | `analyze_brief` · `storyboard` · `video` · `revise_prompt` · `edit_plan` (chọn điểm cắt cho bản hoàn chỉnh; không có cảnh, không tốn credit) |
| `job.status` | `queued` · `claimed` · `running` · `done` · `failed` · `cancelled` |
| `job.requires_approval` | storyboard=true, video=true, analyze_brief=false, revise_prompt=false, edit_plan=false |
| `asset.kind` | `storyboard` · `video` · `grid` |
| `verdict` | `pass` (Đạt) · `fix_in_edit` (Sửa khi dựng) · `redo` (Tạo lại) · `null` (chưa đánh giá) |
| `comment.action` | `note` · `revise_and_regenerate` · `regenerate_same` · `regenerate_storyboard` |
| `comment.author` | `user` · `claude` |
| `prompt_version.created_by` | `claude` · `user` |
| `project.status` | `draft` (chưa gửi brief, hoặc phân tích lỗi/bị hủy khi chưa có cảnh) · `analyzing` (có job analyze_brief chưa xong) · `active` (đã phân tích) · `archived` (dành sẵn, chưa có API đặt) |
| `final_cut.status` | `planning` (Claude đang chọn điểm cắt) · `rendering` (server đang render / đang xếp hàng render) · `ready` · `failed` · `cancelled` |
| `final_cut.created_by` | `claude` (tự kích hoạt hoặc `POST /final-cuts`, EDL do Claude) · `user` (`rerender`, EDL do người dùng chỉnh; bản thử nhập từ dữ liệu cũ) |
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
  "status": "active", "created_at": "…", "updated_at": "…",
  "scene_count": 4, "done_count": 1,
  "status_counts": { "done": 1, "awaiting_approval": 3 },
  "credits_used": 15, "credits_reserved": 0,
  "latest_final_cut": { "id": 3, "version": 2, "status": "ready", "progress": 100, "stage": null, "failed_stage": null, "watermark_removed": true, "url": "/files/output/…/<slug>_final_v2.mp4", "duration_s": 38.2, "outdated": false, "error": null },
  "final_cut_block": null
}
```
`status_counts` chỉ có các trạng thái hiện có (khóa vắng = 0). `credits_used` = credit đã tiêu (−SUM ledger.delta); `credits_reserved` = `credit_per_video` × số job video queued/claimed/running. **Không còn** `credit_budget` / `credits_remaining` (đã bỏ hạn mức credit; cột `projects.credit_budget` vẫn nằm trong DB nhưng server không đọc/hiển thị/nhận nữa). `latest_final_cut` = bản dựng hoàn chỉnh có version cao nhất (gọn; `null` nếu chưa có; `url` = bản đã xoá logo, chỉ có khi `status="ready"`; `stage`/`failed_stage`/`watermark_removed` như ở 4.12; `outdated`: lựa chọn video của dự án đã khác lúc dựng). `final_cut_block` = lý do chưa bấm được "Dựng bản mới" (`null` = được): `{code:"SCENES_NOT_READY", message:"Còn C2, C3 chưa chọn video"}` hoặc `{code:"FINAL_CUT_ACTIVE", message:"Đang chọn điểm cắt cho bản hoàn chỉnh v2"}`. `slug` sinh từ tên lúc tạo (bỏ dấu, `a-z0-9-`, thêm `-2`, `-3` nếu trùng) và **không đổi** khi đổi tên.

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
  "requeue_count": 0, "last_requeued_at": null
}
```
`scene_id`/`scene_code` là `null` với `analyze_brief` và `edit_plan`. `payload` của job `queued` chỉ là bản sơ bộ; bản đầy đủ được **tính lại lúc claim** (xem [6.3](#63-payload-theo-loại-job)). Thời gian đã chạy = `now − claimed_at` (tính ở client).

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
  "created_at": "…", "finished_at": "…", "outdated": false
}
```
- `selection` = video đang được chọn của từng cảnh **lúc tạo bản dựng**, theo thứ tự cảnh (`video_url`, `duration_s` là phần bổ sung để vẽ timeline/trình phát nguồn; `duration_s` có thể `null` nếu không đọc được). `selection_signature` = sha256 của danh sách `(scene_id, asset_id)`.
- `outdated` = `selection_signature` khác lựa chọn video **hiện tại** của dự án (đã đổi video được chọn sau khi dựng).
- `edl` là `null` khi còn `planning` (và ở bản `failed`/`cancelled` trước bước chọn điểm cắt). Dạng đã **chuẩn hóa** (số làm tròn mili giây, luôn có `removed` và `note`; nếu EDL gửi lên không có `removed` thì server suy ra từ khoảng trống giữa các đoạn với lý do "Bỏ khi chỉnh tay").
- **Xoá logo Veo** (bước bắt buộc sau render, trừ khi `WATERMARK_REMOVER=off`): `raw_video_path` = bản render còn logo (`<slug>_final_v<n>_raw.mp4`), `video_path` = bản ĐÃ xoá logo (tên chính `<slug>_final_v<n>.mp4`, là bản hiển thị và tải về). `watermark_removed` = `true` khi `video_path` là bản sạch. `watermark_meta` = JSON stdout của tool (`null` nếu không có). `raw_video_url` có khi có `raw_video_path` (kể cả bản `failed` ở bước clean — dùng cho link nhỏ "Tải bản gốc còn logo"); **không bao giờ hiển thị raw như bản hoàn chỉnh**. `.mlt` và contact sheet giữ như cũ (dựng từ video gốc còn logo, nên dự án Shotcut vẫn còn logo).
- `stage`: trong lúc `status="rendering"` cho biết đang `render` hay `clean`; `progress` 0–100 **riêng cho từng bước** (bước clean bắt đầu lại từ 0, ghi tối đa mỗi 1 giây); `null` khi xong. Hai bước dùng chung một hàng đợi (mỗi lúc một việc).
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
**`POST /api/jobs/:id/cancel`** → `{ "job": Job, "scene": SceneSummary | null }`. Hủy job `queued/claimed/running` (đã `done/failed/cancelled` → `409 INVALID_STATE`). Cảnh về trạng thái ổn định: job storyboard → có storyboard ? `storyboard_review` : `awaiting_approval`; job video → có video ? `video_review` : `storyboard_review`; job revise_prompt → `awaiting_approval`; job analyze_brief → project `draft`/`active`. Credit đặt trước được giải phóng. Worker đang chạy job sẽ nhận `409 JOB_CANCELLED` ở heartbeat/complete/fail kế tiếp.
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

**`POST /api/final-cuts/:id/cancel`** (không body) → `{ "final_cut": FinalCut }` (`status="cancelled"`). `planning`: hủy luôn job `edit_plan` (worker đang giữ nhận `409 JOB_CANCELLED`); `rendering`: dừng ffmpeg / gọi `cancel_render` của Shotcut, bản dở bị xóa; **đang ở bước xoá logo**: dừng cả cây tiến trình của tool (node + Chromium), xóa file tạm, **giữ bản raw** và ghi `failed_stage="clean"` để còn bấm `clean`. `ready/failed/cancelled` → `409 INVALID_STATE`. Hủy job edit_plan ở trang hàng đợi (`POST /api/jobs/:id/cancel`) cũng hủy bản dựng.

**`POST /api/final-cuts/:id/clean`** (không body) → `{ "final_cut": FinalCut }` (`status="rendering"`, `stage="clean"`, `progress=0`, `video_path=null`). Chạy lại **riêng bước xoá logo Veo** (không render lại, không tốn credit): ("Thử xoá logo lại" / "Xoá logo Veo"). Cho phép khi `failed_stage="clean"` (bản `failed`, hoặc `cancelled` giữa bước xoá logo) hoặc khi `ready` mà `watermark_removed=false`. Bản cũ chưa có `raw_video_path` (render trước khi có bước này): server **đổi tên** `<slug>_final_v<n>.mp4` → `<slug>_final_v<n>_raw.mp4` trước (nguyên tử, cập nhật DB), rồi xoá logo ra tên chính. Lỗi: `409 INVALID_STATE` (trạng thái khác, hoặc đã xoá logo rồi) · `409 WATERMARK_REMOVER_UNAVAILABLE` (tool tắt/không chạy được; `message` có lý do) · `409 RAW_EXISTS` (đã có file `_raw.mp4`, không ghi đè) · `409 FILE_MISSING` (mất bản gốc) · `404`.

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

**Render (server, nền, mỗi lúc chỉ một bản — hàng đợi trong tiến trình)**
1. Bản → `rendering` ngay khi có EDL (`progress=null` đến khi tới lượt), rồi `progress=0` và `renderer` được ghi.
2. **Shotcut** (qua MCP stdio): `create_project` (kích thước/fps lấy từ video đầu, mỗi đoạn là một clip theo thứ tự, caption `"C1 v2 #1"`) → `render_contact_sheet` → `start_render` preset `h264-high` → poll `render_status` mỗi 2 giây (timeout 20 phút) → `progress`. Sinh `.mlt` (kèm `.render-<id>.mlt` và `.guard` do MCP tạo, để nguyên).
3. **ffmpeg**: trim + concat (cắt thẳng, giữ âm thanh, afade 20ms ở chỗ nối; nguồn không có âm thanh được chèn im lặng), contact sheet bằng `tile`; không có `.mlt`.
4. **Xoá logo Veo** (bước `clean`, nếu `watermark_remover.active`): bước 1–3 ghi video ra `…_final_v<n>_raw.mp4`; rồi chạy tool ra file tạm `.<tên>.tmp.mp4` cùng thư mục (tiến độ đọc từ stderr `[video] 74% …`), kiểm tra bằng ffprobe (có video, thời lượng lệch ≤ 0,25 s so với raw, có âm thanh nếu raw có) và **đổi tên nguyên tử** sang `…_final_v<n>.mp4`. Tool tắt/không có → bỏ bước này, ghi thẳng tên chính.
5. Xong: `duration_s` bằng ffprobe → `ready`, event `final_cut.ready` (ghi "đã xoá logo Veo" hoặc "chưa xoá logo Veo"), dòng `| FINAL | v<n> | bản dựng (<renderer>, cắt thẳng; đã xoá logo Veo) | <summary hoặc note> | Sẵn sàng |` vào `output/<slug>/log.md` (không có phần "; đã xoá logo Veo" khi chưa xoá; `clean` riêng lẻ thêm dòng `| FINAL | v<n> | xoá logo Veo | … | Sẵn sàng |`). Lỗi ở bước render → `failed` + `error`, `failed_stage="render"`; lỗi ở bước clean → `failed_stage="clean"` (event `final_cut.failed`). Không có trình dựng khả dụng → `failed` ("Không có trình dựng khả dụng: …").
6. **Không bao giờ ghi đè**: version kế tiếp luôn lớn hơn mọi version trong DB và mọi file `<slug>_final_v<n>*` có sẵn trên đĩa (kể cả `.mlt` và `_raw.mp4`), nên `…_final_v<n>.mp4` và `…_final_v<n>_raw.mp4` luôn là file mới. `rerender` đi qua đủ render → clean.

---

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
  "attempt": 1,
  "output": { "storyboard_path": "output/cacao-actiso-plus/storyboard/C1_storyboard.png" },
  "requeued": false }
```
`upload_files` = ref theo `upload_refs`, + storyboard mới nhất của **cảnh đầu tiên** nếu `use_prev_storyboard` (và cảnh này không phải cảnh đầu). `attempt` = số storyboard đã có + 1; tên file lượt 1 `C1_storyboard.png`, lượt n≥2 `C1_storyboard_v<n>.png`.

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

### 6.4 Tạo cảnh và comment

**`POST /api/worker/scenes`** (sau `analyze_brief`)
```json
{ "project_id": 1, "scenes": [ { "code": "C1", "order_index": 0, "title": "…", "prompt": "…", "first_frame_desc": "…", "upload_refs": [1, 2], "use_prev_storyboard": false } ] }
```
→ `200 { "created": ["C1"], "updated": [], "skipped": [ { "code", "reason" } ], "scenes": SceneSummary[] }` (toàn bộ cảnh của dự án).
Upsert theo `(project_id, code)`; cả lô tất-cả-hoặc-không. Cảnh mới: `scene_prompt_versions` v1 (`claude`), `draft → prompt_ready → awaiting_approval` (hoặc → `storyboard_queued` + job storyboard khi `REQUIRE_PROMPT_APPROVAL=false`). Cảnh đã có: cập nhật tiêu đề/thứ tự/khung đầu/upload_refs/use_prev; nếu `prompt` khác thì thêm version mới — trừ cảnh đang `*_queued/*_running/needs_revision` (giữ prompt, ghi vào `skipped`). Lỗi: `400 INVALID_REFS` (ref không thuộc dự án), `400 VALIDATION_ERROR` (mã lặp, mã sai định dạng `[A-Za-z0-9_-]{1,16}`, `scenes` rỗng), `404` (dự án).

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

`sim-worker` xử lý `edit_plan` bằng EDL mô phỏng (bỏ 0,3 giây đầu và 0,2 giây cuối mỗi cảnh).

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
| `final_cut.updated` | `{ "final_cut": FinalCut }` | final_cut tạo/đổi trạng thái (`planning` → `rendering` [stage `render` → `clean`] → `ready`/`failed`/`cancelled`), `stage`, `progress` đổi (ghi tối đa 1 lần/giây), có `.mlt`/`render_ref`; kèm `project.updated` khi đổi trạng thái (để cập nhật `latest_final_cut`) |
| `project.updated` | `{ "project": ProjectSummary }` | gửi brief, phân tích xong/lỗi/hủy, sửa dự án, thay đổi ảnh tham chiếu (upload/chép từ thư viện/nhãn/thứ tự/xóa) — *ngoài danh sách gốc* |

Gợi ý frontend: `scene.updated` ghi đè cảnh trong cache theo `scene.id` (SceneSummary đầy đủ, không có `assets/comments/jobs` — với trang chi tiết, invalidate `GET /api/scenes/:id` khi nhận `scene.updated`/`asset.*`/`comment.*` của cảnh đó). `job.updated` cập nhật trang Hàng đợi.

---

## 8. File tĩnh `/files/*`

`GET /files/<đường dẫn tương đối>` (đúng `file_path` của asset/ref; trường `url` có sẵn) — chỉ phục vụ prefix `output/` và `refs/`. Chặn `..` (kể cả `%2e%2e`), đường dẫn tuyệt đối, backslash và symlink trỏ ra ngoài (đều `404`). Hỗ trợ `Range` (video tua được: `206 Partial Content`, `Content-Range`, `Accept-Ranges: bytes`; Range sai → `416`), `ETag`/`Last-Modified`, `Cache-Control: no-cache`, `X-Content-Type-Options: nosniff`. Thẻ `<video src="/files/output/…/C1_v1.mp4" controls>` dùng được trực tiếp.

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
| 409 | `FILE_MISSING` | thêm ảnh từ thư viện: file nguồn của ref không còn tồn tại |
| 400 | `INVALID_EDL` | EDL sai (thiếu cảnh, sai thứ tự/asset_id, đoạn chồng nhau/quá ngắn/ngoài thời lượng…); message nêu cảnh/đoạn, `details.scene`/`details.segment`; với job `edit_plan` job vẫn được giữ |
| 409 | `SCENES_NOT_READY` | dựng bản hoàn chỉnh khi còn cảnh chưa chọn video (message liệt kê mã cảnh) |
| 409 | `FINAL_CUT_ACTIVE` | đang có bản dựng `planning`/`rendering` (tạo mới) hoặc `rendering` (render lại) |
| 409 | `WATERMARK_REMOVER_UNAVAILABLE` | `POST /final-cuts/:id/clean` khi tool xoá logo Veo tắt/không chạy được |
| 409 | `RAW_EXISTS` · `FILE_MISSING` | `clean`: file `_raw.mp4` đã tồn tại (không ghi đè) · mất video/bản gốc cần xử lý |
| 409 | `NO_PROJECT_FILE` | `open-in-shotcut` khi bản dựng không có file .mlt |
| 409 | `SHOTCUT_UNAVAILABLE` | `open-in-shotcut` mà không mở được Shotcut |
| 409 | `NO_SCENES` | complete analyze_brief khi chưa có cảnh |
| 413 | `FILE_TOO_LARGE` · `BODY_TOO_LARGE` · `TOO_MANY_FILES` | upload quá giới hạn (10MB/file) |
| 415 | `UNSUPPORTED_FILE_TYPE` | ảnh không phải png/jpg/webp (theo magic bytes) |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Content-Type không hỗ trợ |
| 500 | `INTERNAL` | lỗi không lường trước |
| 503 | `QUEUE_PAUSED` | worker `GET /next` khi hàng đợi tạm dừng (`details: {pause_code, pause_reason}`) |

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
| Hủy job | `POST /api/jobs/:id/cancel` (`scene.active_job.id`) | `*_queued`, `*_running`, `needs_revision` | — |
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
| Khối "Bản hoàn chỉnh" ở bảng cảnh | `GET /api/projects/:id` → `latest_final_cut` (trạng thái, `progress`, `duration_s`, `outdated`, `error`) + `final_cut_block`; SSE `final_cut.updated` / `project.updated` | luôn | "Dựng bản mới" khóa khi `final_cut_block != null` (hiện `message`) |
| "Dựng bản mới" | `POST /api/projects/:id/final-cuts` | khi `final_cut_block == null` | `SCENES_NOT_READY` / `FINAL_CUT_ACTIVE` |
| Trang `/projects/:id/final`: trình phát, chọn version, tải, timeline giữ/cắt | `GET /api/projects/:id/final-cuts` (`video_url` = bản đã xoá logo, `watermark_removed`, `contact_sheet_url`, `edl.scenes[].segments/removed`, `selection[].duration_s`, `created_by`, `note`, `renderer`, `summary`); tải = `video_url` | có bản `ready` | — |
| Trạng thái xoá logo ("Đang xoá logo Veo 42%") | `latest_final_cut.stage` / `final_cut.stage` + `progress` (riêng từng bước) | `status="rendering"` | — |
| "Thử xoá logo lại" (lỗi ở bước clean) / "Xoá logo Veo" (bản `ready` còn logo) | `POST /api/final-cuts/:id/clean` | `failed_stage="clean"`, hoặc `ready` với `watermark_removed=false` | `WATERMARK_REMOVER_UNAVAILABLE` (xem `/api/meta.watermark_remover.reason`) |
| Link nhỏ "Tải bản gốc còn logo" | `raw_video_url` | khi `raw_video_url != null` | — |
| "Mở trong Shotcut" | `POST /api/final-cuts/:id/open-in-shotcut` | chỉ khi `project_file_path != null` | `NO_PROJECT_FILE` |
| Trình chỉnh EDL → "Render lại (không tốn credit)" | `POST /api/final-cuts/:id/rerender {edl, note?}`; `INVALID_EDL` hiện đúng cảnh/đoạn từ `error.details` / `message` | bản `ready`/`failed` | `FINAL_CUT_ACTIVE` |
| Hủy khi đang chọn điểm cắt / render | `POST /api/final-cuts/:id/cancel` | `planning`, `rendering` | — |
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
- **Bản dựng hoàn chỉnh**: version tăng dần theo dự án và không bao giờ ghi đè (kiểm tra DB và đĩa); `edit_plan` và render không tốn credit; mỗi lúc chỉ render một bản (hàng đợi trong tiến trình); server tắt giữa lúc render thì bản đó thành `failed` ở lần khởi động sau; job `edit_plan` có `scene_id=null` nên không đổi trạng thái cảnh. Mỗi bản `ready` thêm một dòng `| FINAL | v<n> | bản dựng (<renderer>, cắt thẳng) | <summary> | Sẵn sàng |` vào `output/<slug>/log.md` (và vào `GET …/log.md`).
- Import dữ liệu cũ dùng `transition(..., {force:true})`, cột `ext_key` (UNIQUE) của `assets`, `credit_ledger`, `comments`, `events`, `scene_prompt_versions` để chạy lặp không trùng — chưa có API HTTP cho việc này (chạy bằng script `npm run import:legacy`, xem mục 12).

---

## 12. Bố cục file, script, chạy thử

**File sinh ra** (đường dẫn trong DB tương đối từ `ROOT_DIR`):
- `output/<slug>/storyboard/<code>_storyboard.png` (lượt 1), `<code>_storyboard_v<n>.png` (n ≥ 2)
- `output/<slug>/video/<code>_v<n>.mp4` và `<code>_v<n>_grid.jpg`
- `output/<slug>/log.md`
- `output/<slug>/final/<slug>_final_v<n>.mp4`, `…_final_v<n>_contact.png`, `output/<slug>/final/shotcut/<slug>_final_v<n>.mlt` (chỉ khi dựng bằng Shotcut; Shotcut MCP còn tạo `.render-<id>.mlt` và `.guard` cạnh đó)
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
