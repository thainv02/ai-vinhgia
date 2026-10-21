# Kế hoạch code: Web quản lý sản xuất video theo cảnh

Tài liệu này giao cho AI code. Code vào **chính thư mục chứa file này** (thư mục hiện tại). Thư mục này đã có sẵn `storyboard/`, `video/`, `log.md` từ lần chạy tay đầu tiên, web phải đọc được dữ liệu đó (xem mục 9).

## 1. Mục tiêu

Một web chạy trên máy, để người dùng:
1. Nhập yêu cầu kịch bản và tải ảnh sản phẩm lên.
2. Xem danh sách cảnh do Claude phân tích, kèm prompt từng cảnh.
3. Duyệt, rồi theo dõi tiến trình tạo ảnh storyboard và video theo từng cảnh.
4. Xem lại ảnh và video từng cảnh, comment yêu cầu sửa hoặc tạo lại ngay trên cảnh đó.
5. Quản lý hạn mức credit, hàng đợi, lịch sử các lần tạo.

## 2. Ràng buộc quan trọng (đọc trước khi code)

- **Web không tự tạo ảnh hay video.** Việc tạo ảnh (ChatGPT) và video (Google Flow) do **Claude Code điều khiển Chrome** của người dùng, ở một phiên riêng. Web chỉ là giao diện và nơi lưu trạng thái.
- Web và Claude **giao tiếp qua cơ sở dữ liệu dùng chung** (mục 6). Không có kênh trực tiếp. Claude chỉ làm việc khi phiên Claude Code đang mở, nên hàng đợi sẽ đứng yên khi phiên đóng. Web phải hiển thị rõ điều này (chỉ báo "Worker đang online/offline").
- Mỗi video tốn credit thật. Web **không bao giờ** tự đẩy cảnh sang bước tạo video mà không có thao tác duyệt của người dùng.
- Không code gọi API ChatGPT hoặc Flow. Không lưu mật khẩu hay token của hai dịch vụ này.

## 3. Công nghệ

- **Backend:** Node.js 20 + Fastify (hoặc Express), TypeScript.
- **CSDL:** SQLite qua `better-sqlite3`, file `./data/app.db`. Bật WAL để web và Claude cùng đọc ghi.
- **Frontend:** React + Vite + TypeScript, Tailwind. Cập nhật trạng thái bằng Server-Sent Events (SSE), không cần WebSocket.
- **File tĩnh:** phục vụ `./storyboard`, `./video`, `./refs` qua đường dẫn `/files/...`, hỗ trợ Range request để tua video.
- Chạy: `npm run dev` (một lệnh chạy cả backend và frontend), `npm run build && npm start` cho bản chạy thật. Cổng mặc định 5173 (UI) và 8787 (API).

## 4. Cấu trúc thư mục

```
./PLAN-web-quan-ly-video.md
./web/            # frontend
./server/         # backend + migrations + seed
./data/app.db     # SQLite (gitignore)
./refs/           # ảnh tham chiếu người dùng tải lên: refs/<projectId>/...
./storyboard/     # <sceneCode>_storyboard.png
./video/          # <sceneCode>_v<n>.mp4 (+ _grid.jpg)
./log.md          # nhật ký, web ghi thêm dòng khi có sự kiện tạo
./WORKER.md       # hướng dẫn riêng cho Claude làm worker (mục 7)
```

## 5. Mô hình dữ liệu

Dùng migration có đánh số. Thời gian lưu ISO 8601 UTC.

**projects**: `id`, `name`, `brief` (yêu cầu kịch bản gốc), `style_lock` (văn bản khóa nhất quán: ánh sáng, mặt bếp…), `credit_budget` (tổng), `max_attempts_per_scene` (mặc định 2), `credit_per_video` (mặc định 15), `status`, `created_at`.

**project_refs**: `id`, `project_id`, `label`, `file_path`, `order_index`. Ảnh tham chiếu sản phẩm (hộp, gói stick…).

**scenes**: `id`, `project_id`, `code` (C1, C2…), `order_index`, `title`, `prompt` (bản hiện tại, để nguyên văn gửi Flow), `first_frame_desc` (dòng "Khung đầu"), `upload_refs` (JSON mảng id `project_refs` theo thứ tự upload), `use_prev_storyboard` (bool: có upload thêm storyboard C1 cho storyboard hay không), `status`, `selected_video_id`, `updated_at`.

**scene_prompt_versions**: `id`, `scene_id`, `version`, `prompt`, `reason`, `created_by` (`claude` | `user`), `created_at`. Mỗi lần sửa prompt sinh một dòng, không ghi đè.

**jobs**: hàng đợi việc cho Claude.
`id`, `scene_id`, `type` (`analyze_brief` | `storyboard` | `video` | `revise_prompt`), `status` (`queued` | `claimed` | `running` | `done` | `failed` | `cancelled`), `payload` (JSON), `result` (JSON), `error`, `claimed_by`, `claimed_at`, `heartbeat_at`, `created_at`, `finished_at`, `credits_cost`, `requires_approval` (bool), `approved_at`.

**assets**: `id`, `scene_id`, `kind` (`storyboard` | `video` | `grid`), `file_path`, `attempt` (số lần), `meta` (JSON: độ phân giải, thời lượng), `verdict` (`pass` | `fix_in_edit` | `redo` | null), `verdict_note`, `created_at`.

**comments**: `id`, `scene_id`, `asset_id` (nullable), `author` (`user` | `claude`), `body`, `timecode` (giây, nullable, để comment đúng điểm trong video), `action` (`note` | `revise_and_regenerate` | `regenerate_same` | `regenerate_storyboard`), `resolved` (bool), `created_at`.

**events**: nhật ký hệ thống. `id`, `project_id`, `scene_id`, `type`, `message`, `created_at`. Dùng cho dòng thời gian và ghi ra `log.md`.

**credit_ledger**: `id`, `project_id`, `scene_id`, `job_id`, `delta` (âm khi tốn), `note`, `created_at`. Số dư = `credit_budget` + tổng `delta`.

### Máy trạng thái của cảnh (`scenes.status`)

`draft` → `prompt_ready` (Claude viết xong prompt) → `awaiting_approval` (chờ người dùng duyệt prompt) → `storyboard_queued` → `storyboard_running` → `storyboard_review` → `video_queued` → `video_running` → `video_review` → `done`.
Nhánh phụ: `needs_revision` (có comment yêu cầu sửa), `failed`, `blocked_budget` (hết hạn mức), `cancelled`.
Mọi chuyển trạng thái đi qua **một hàm duy nhất** `transition(scene, to, reason)` có kiểm tra hợp lệ và ghi `events`.

## 6. API (REST + SSE)

Tất cả trả JSON. Lỗi theo dạng `{ "error": { "code", "message" } }`.

**Người dùng (web gọi):**
- `POST /api/projects`, `GET /api/projects`, `GET /api/projects/:id`
- `POST /api/projects/:id/refs` (multipart, lưu vào `./refs/<id>/`), `DELETE /api/refs/:id`, `PATCH /api/refs/reorder`
- `POST /api/projects/:id/brief` → tạo job `analyze_brief`
- `GET /api/projects/:id/scenes`, `GET /api/scenes/:id` (kèm assets, comments, lịch sử prompt)
- `PATCH /api/scenes/:id/prompt` → người dùng tự sửa prompt (tạo version mới `created_by=user`)
- `POST /api/scenes/:id/approve` body `{ stage: "storyboard" | "video" }` → tạo job, đặt `approved_at`. **Bước `video` kiểm tra hạn mức và số lượt trước khi tạo job**, từ chối nếu vượt.
- `POST /api/scenes/:id/comments` body `{ body, timecode?, action }`. Với `revise_and_regenerate` tự tạo job `revise_prompt` (Claude sửa prompt, chờ người dùng duyệt lại rồi mới tạo video).
- `POST /api/assets/:id/verdict`, `POST /api/scenes/:id/select-video`
- `POST /api/jobs/:id/cancel`
- `GET /api/projects/:id/budget` → tổng, đã dùng, còn lại, số lượt mỗi cảnh
- `GET /api/stream?projectId=` → SSE, đẩy sự kiện `scene.updated`, `job.updated`, `asset.created`, `comment.created`, `worker.status`

**Worker / Claude (xem `WORKER.md`):**
- `GET /api/worker/next` → trả job `queued` đã đủ điều kiện (đã duyệt nếu `requires_approval`), đồng thời `claim` nguyên tử (một giao dịch SQL).
- `POST /api/worker/jobs/:id/heartbeat`
- `POST /api/worker/jobs/:id/complete` body `{ result, assets: [{kind, file_path, meta}], credits_cost }`
- `POST /api/worker/jobs/:id/fail` body `{ error }`
- `POST /api/worker/scenes` (tạo/cập nhật hàng loạt cảnh sau `analyze_brief`)
- `POST /api/worker/comments` (Claude trả lời comment)
- `GET /api/worker/ping` → web cập nhật `worker.status` (online nếu heartbeat trong 90 giây).

Xác thực worker bằng token tĩnh trong `.env` (`WORKER_TOKEN`), header `Authorization: Bearer`. API người dùng chỉ lắng nghe `127.0.0.1`.

## 7. Giao thức worker (Claude làm việc thế nào)

Tạo file `WORKER.md` mô tả cho Claude, nội dung chính:
1. Vòng lặp: gọi `GET /api/worker/next` → xử lý → `complete` hoặc `fail` → lặp. Không có job thì chờ 20 giây.
2. `analyze_brief`: đọc `brief` và ảnh tham chiếu, chia cảnh, viết prompt theo luật trong `claude-system-prompt.md`, gọi `POST /api/worker/scenes`.
3. `storyboard`: mở ChatGPT, tạo ảnh theo quy trình trong `flow-automation-prompt.md`, lưu `storyboard/<code>_storyboard.png`, báo `complete`.
4. `video`: mở Flow, upload ảnh đúng thứ tự (`upload_refs`, rồi storyboard cuối), dán nguyên văn `prompt`, 9:16, 10 giây, **x1**, tải bản 720p, tách lưới khung hình bằng ffmpeg, ghi nhận xét, báo `complete` với `credits_cost`.
5. `revise_prompt`: đọc comment chưa `resolved`, sửa **đúng chỗ liên quan**, tạo version prompt mới kèm lý do, đặt cảnh về `awaiting_approval`. Không tự tạo video.
6. Gặp CAPTCHA, đăng nhập, hết credit hoặc giao diện lạ: `fail` với mã lỗi rõ ràng, dừng hàng đợi, web hiển thị cảnh báo.
7. Có thể chạy các job `storyboard` và `video` của các cảnh khác nhau gối đầu nhau (bấm tạo liên tiếp rồi quay lại tải), nhưng thao tác trên Chrome vẫn tuần tự. Web chỉ cần hiển thị đúng trạng thái `running` của nhiều job cùng lúc.

## 8. Giao diện

Phong cách gọn, nền sáng/tối theo hệ thống, dùng được trên máy tính (ưu tiên) và xem được trên điện thoại.

1. **Danh sách dự án.** Thẻ dự án: tên, số cảnh, thanh tiến trình, credit đã dùng.
2. **Tạo dự án.** Ô nhập yêu cầu kịch bản, kéo thả ảnh tham chiếu (sắp xếp thứ tự, đặt nhãn), ô `style_lock`, hạn mức credit. Nút "Gửi cho Claude phân tích".
3. **Bảng cảnh (trang chính).** Dạng cột theo thứ tự cảnh C1…Cn, mỗi cảnh một thẻ:
   - mã cảnh + tiêu đề, huy hiệu trạng thái có màu;
   - ảnh storyboard nhỏ và khung video dọc 9:16;
   - nút theo trạng thái: "Duyệt prompt", "Tạo storyboard", "Tạo video (15 credit)", "Tạo lại";
   - số lượt đã dùng/tối đa của cảnh.
   Thanh trên cùng: credit còn lại, số cảnh theo trạng thái, **chỉ báo worker online/offline**, nút "Duyệt tất cả cảnh đang chờ" (có hộp xác nhận ghi rõ tổng credit sắp tốn).
4. **Trang chi tiết cảnh.**
   - Trình phát video 9:16 với thanh thời gian, chuyển giữa các bản (v1, v2…), ảnh lưới khung hình.
   - Prompt hiện tại có trình soạn, so sánh khác biệt giữa các version (diff).
   - Khu comment dạng chuỗi: người dùng gõ nhận xét, chọn tùy chọn hành động (Ghi chú / Sửa prompt rồi tạo lại / Tạo lại y nguyên / Tạo lại storyboard), có thể gắn vào **thời điểm đang dừng trên video**. Bấm vào mốc thời gian của comment sẽ tua tới đúng giây.
   - Nhận xét của Claude (lỗi thấy được, kết luận Đạt / Sửa khi dựng / Tạo lại) hiển thị cạnh video, người dùng có thể đổi kết luận.
   - Dòng thời gian sự kiện của cảnh.
5. **Hàng đợi.** Bảng job: loại, cảnh, trạng thái, thời gian, credit, nút hủy. Job đang chạy hiện thời gian đã chạy.
6. **Nhật ký và credit.** Bảng `credit_ledger`, xuất CSV, xuất `log.md`.

Quy tắc UX bắt buộc:
- Mọi nút tốn credit phải ghi rõ số credit và có bước xác nhận.
- Nút bị vô hiệu hóa kèm lý do khi hết hạn mức hoặc hết lượt (ví dụ "Cảnh C1 đã dùng 2/2 lượt").
- Trạng thái cập nhật tức thì qua SSE, không cần tải lại trang.
- Trạng thái trống, đang tải, lỗi đều có giao diện riêng.

## 9. Nhập dữ liệu cũ

Có lệnh `npm run import:legacy` đọc thư mục hiện tại:
- Tạo dự án "Cacao Actiso Plus" từ `cacao-smoothie-prompts.md` (nếu có) hoặc từ `log.md`.
- Tạo 4 cảnh C1–C4 với prompt đúng nguyên văn trong `cacao-smoothie-prompts.md`; riêng C1 dùng bản prompt có kéo (xem `log.md` dòng C1 lượt 2).
- Gắn `storyboard/C*_storyboard.png` và `video/C*_v*.mp4` thành `assets`, đặt `attempt` theo hậu tố `_v<n>`.
- Dựng lại `credit_ledger` (mỗi video 15 credit) và các kết luận từ `log.md`.
Lệnh phải chạy lặp lại được mà không tạo bản ghi trùng.

## 10. Bảo mật và độ bền

- API chỉ bind `127.0.0.1`; tên file tải lên được làm sạch, chặn `..`, giới hạn loại ảnh (png, jpg, webp) và dung lượng (10 MB).
- Nhận claim job nguyên tử; job `running` mất heartbeat quá 5 phút thì trả về `queued` và đánh dấu để người dùng biết.
- Không bao giờ tự tạo job video khi chưa có `approved_at`. Kiểm tra hạn mức ở phía server, không chỉ ở giao diện.
- Sao lưu `app.db` mỗi lần khởi động vào `./data/backup/`.

## 11. Các giai đoạn thực hiện

**Giai đoạn 1: nền tảng (làm trước, kiểm thử độc lập)**
Khung dự án, migration, `transition()`, API người dùng và API worker, claim nguyên tử, SSE. Có script `npm run sim:worker` giả lập worker (đổi trạng thái, ghi file mẫu) để test không cần Claude.
*Hoàn thành khi:* test tự động chạy qua toàn bộ máy trạng thái, kể cả hết hạn mức, vượt lượt, job mất heartbeat.

**Giai đoạn 2: giao diện chính**
Danh sách dự án, tạo dự án, bảng cảnh, trang chi tiết cảnh (video, prompt, comment), hàng đợi.
*Hoàn thành khi:* với worker giả lập, đi hết luồng từ nhập kịch bản đến xem video và comment, trạng thái cập nhật trực tiếp.

**Giai đoạn 3: nhập dữ liệu cũ và WORKER.md**
Lệnh import, viết `WORKER.md` đầy đủ, thử với Claude thật trên một cảnh.
*Hoàn thành khi:* dự án Cacao hiện ra đúng 4 cảnh với video, lịch sử và credit khớp `log.md`.

**Giai đoạn 4: hoàn thiện**
Comment gắn mốc thời gian, diff prompt, xuất CSV và `log.md`, giao diện điện thoại, trạng thái lỗi.

## 12. Tiêu chí nghiệm thu

1. Nhập yêu cầu và ảnh, nhận về danh sách cảnh có prompt trong phiên Claude, hiển thị trên web.
2. Không thể tạo video khi chưa duyệt, khi hết credit, hoặc khi cảnh đã đủ số lượt; server từ chối kể cả khi gọi API trực tiếp.
3. Nhiều cảnh có thể ở trạng thái đang chạy cùng lúc; bảng cảnh và hàng đợi phản ánh đúng.
4. Comment "sửa prompt rồi tạo lại" tạo version prompt mới có lý do, chờ duyệt lại, rồi mới tạo video và giữ cả các video cũ.
5. Tắt phiên worker: web báo offline, job không mất, tiếp tục khi worker trở lại.
6. Dữ liệu và file của lần chạy tay đầu tiên hiển thị đủ trên web.

## 13. Ngoài phạm vi (không làm)

- Gọi API ChatGPT, Flow hoặc bất kỳ API tạo video nào.
- Đăng nhập, quản lý nhiều người dùng, đăng hay chia sẻ video ra ngoài.
- Tự dựng phim, ghép nhạc, thêm chữ (việc hậu kỳ làm ở công cụ khác).
- Tự động mua credit hay nâng gói.

## 14. Câu hỏi còn mở (hỏi người dùng nếu cần)

- Số cảnh chạy cùng lúc tối đa trên Flow là bao nhiêu? Mặc định đặt tối đa 4, làm thành cấu hình.
- Có cần bước duyệt prompt bắt buộc cho mọi dự án, hay cho tắt được? Mặc định bắt buộc.
- Có dùng cho nhiều sản phẩm khác không? Mô hình dữ liệu đã hỗ trợ nhiều dự án.
