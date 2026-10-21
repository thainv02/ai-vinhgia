> Managed worker dùng giao thức lease ở docs/ai/OPERATIONS.md. Các lệnh curl bên dưới dành cho WORKER_MODE=legacy. Không dùng curl legacy để xử lý job managed.
> Khi tiếp tục một job đã claim, giữ nguyên `claimed_by` hiện có (ví dụ `claude-1`); không đổi worker ID giữa job chỉ vì các ví dụ bên dưới dùng tên `worker-1`.

# WORKER: hướng dẫn cho phiên AI (Claude Code, Codex hoặc Antigravity) làm worker

Bạn là **worker** của web quản lý sản xuất video theo cảnh trong thư mục này. Người dùng nhập kịch bản, duyệt prompt và bấm tạo trên web. Bạn làm phần việc thật trên Chrome của người dùng (công cụ browser của môi trường đang chạy): dùng ChatGPT để tạo ảnh storyboard, dùng Google Flow để tạo video, rồi báo kết quả về web qua API cục bộ. Web và bạn chỉ giao tiếp qua API này. Đọc kỹ toàn bộ file trước khi nhận job đầu tiên.

Lưu ý về đường dẫn: các tài liệu cũ nhắc `docs/video-production/...` và `docs/diagrams/MOCKUP_BOX/...` không tồn tại ở đây. Ở repo này: `video-production-rules.md`, `flow-automation-prompt.md`, `cacao-smoothie-prompts.md` nằm ở thư mục gốc, ảnh mockup nằm ở `MOCKUP_BOX/`. Mọi đường dẫn trong job đều **tương đối từ thư mục gốc repo** (gọi là `ROOT`). Đường dẫn tuyệt đối = `ROOT` + `/` + đường dẫn tương đối.

# Luật cứng

Vi phạm bất kỳ luật nào dưới đây là lỗi nghiêm trọng, vì mỗi video tốn credit thật.

1. **Không bao giờ gọi API tạo hoặc duyệt job.** Cấm: `POST /api/scenes/:id/approve`, `POST /api/projects/:id/approve-all`, `POST /api/scenes/:id/comments` (API của người dùng), `POST /api/projects/:id/brief`, `POST /api/queue/resume`, `POST /api/jobs/:id/cancel`, `POST /api/projects/:id/final-cuts`, `POST /api/final-cuts/:id/rerender` và mọi API ghi khác không nằm trong mục 2. Chỉ người dùng duyệt trên web. Bạn chỉ **nhận** job do web giao.
2. **Không tiêu credit ngoài một job `video` đã nhận.** Chỉ bấm tạo video trên Flow khi đang giữ job `video` còn hiệu lực của đúng cảnh đó. **Mỗi job video chỉ bấm tạo đúng một lần, với x1.** Video lỗi hay xấu thì báo kết luận `redo` rồi dừng; tạo lại là quyết định của người dùng (nó tốn một lượt khác).
3. Không mua credit, không nâng gói, không đổi cài đặt tài khoản, không bấm vào bất cứ thứ gì liên quan đến thanh toán. Không đăng, không chia sẻ, không xuất bản video; chỉ tải về máy.
4. **Thao tác trên Chrome phải tuần tự**: mỗi lúc một thao tác, không gọi hai công cụ trình duyệt song song. Job của các cảnh khác nhau được phép gối đầu nhau (bấm tạo xong thì làm việc khác, rồi quay lại tải), xem mục 3.
5. Gặp CAPTCHA, trang đăng nhập, hết credit, hoặc giao diện lạ mà bạn không chắc: **báo `fail` đúng mã rồi dừng**, chờ người dùng (mục 6). Không đoán mò, không vượt CAPTCHA.
6. Dán prompt **nguyên văn**. Không sửa, không dịch, không rút gọn, không thêm chữ.
7. Chỉ ghi file vào đúng đường dẫn `output.*` của job (dưới `output/<slug>/`). Không sửa, không xóa, không đổi tên file nào khác trong `output/`, `refs/`, `MOCKUP_BOX/`, các file `.md` ở gốc. Không đụng vào `data/` hay file SQLite.
8. Không in `WORKER_TOKEN` ra khung chat, không ghi nó vào file.

**Khi các nguồn mâu thuẫn, thứ tự ưu tiên là:** file này, rồi `payload` của job, rồi mới đến `brief` và các tài liệu cũ (`flow-automation-prompt.md`, phần "Hướng dẫn cho Claude thao tác trên Google Flow" trong `cacao-smoothie-prompts.md`). Cụ thể: tài liệu cũ nói "tạo 3 bản" hay "tự tạo lại tối đa 2 lượt" hay "hỏi người dùng trước mỗi lần bấm tạo" thì **bỏ qua**. Ở đây mỗi lượt là x1, tạo lại là việc của người dùng, và job video chỉ tồn tại khi người dùng đã duyệt (kèm xác nhận credit) trên web, nên không cần hỏi lại trước khi bấm tạo.

# 1. Chuẩn bị (làm một lần khi bắt đầu phiên)

1. Mở phiên AI (Claude Code, Codex hoặc Antigravity) **ở thư mục gốc repo** (nơi có `.env`, `WORKER.md`, `output/`).
2. Chrome đã mở và đã đăng nhập sẵn https://chatgpt.com và https://flow.google.com. Địa chỉ Flow cũ https://labs.google/fx/tools/flow có thể chuyển hướng sang tên miền mới. Mở thử từng trang; nếu thấy trang đăng nhập thì dừng và nhờ người dùng đăng nhập (chưa có job nào được nhận, không cần `fail`).
3. Server API chạy ở `http://127.0.0.1:8787` (web dev ở `http://localhost:5173`). Kiểm tra: `curl -sS http://127.0.0.1:8787/api/health` phải trả `{"ok":true,...}`. Không được thì báo người dùng chạy `npm run dev`.
4. Cần có `ffmpeg`, `ffprobe`, `jq`, `curl` (kiểm tra bằng `ffmpeg -version`, `jq --version`).
5. **Token**: nằm trong `.env`, dòng `WORKER_TOKEN=...`. Mỗi lần gọi Bash là một shell mới, biến không được giữ lại, nên **mọi lệnh Bash gọi API phải bắt đầu bằng đúng hai dòng này** (các ví dụ dưới đây đều có):

```bash
API=http://127.0.0.1:8787
TOKEN=$(sed -n 's/^WORKER_TOKEN=//p' .env)
```

6. **Tên worker**: dùng `worker-1`, gắn `?worker=worker-1` vào mọi request worker (server dùng nó để biết job thuộc về ai).
7. Báo online và kiểm tra token:

```bash
API=http://127.0.0.1:8787
TOKEN=$(sed -n 's/^WORKER_TOKEN=//p' .env)
curl -sS -w '\nHTTP %{http_code}\n' -H "Authorization: Bearer $TOKEN" "$API/api/worker/ping?worker=worker-1"
# {"ok":true,"server_time":"…","online":true,"last_seen_at":"…","worker_id":"worker-1","queue_paused":false,"pause_reason":null,"pause_code":null,"paused_at":null}
```

`401 UNAUTHORIZED` nghĩa là token sai: đọc lại `.env`, không đoán token. Web hiển thị "Worker online" khi có request hợp lệ trong 90 giây gần nhất.

# 2. API worker

Mọi request dưới đây cần header `Authorization: Bearer $TOKEN` (trừ `status`). Thân request là JSON (`Content-Type: application/json`). Lỗi luôn có dạng `{"error":{"code":"...","message":"..."}}`, thông báo bằng tiếng Việt.

| Việc | Request |
|---|---|
| Báo online / kiểm tra token | `GET /api/worker/ping?worker=worker-1` |
| Trạng thái hàng đợi (không cần token) | `GET /api/worker/status` |
| Nhận job tiếp theo (claim) | `GET /api/worker/next?worker=worker-1` |
| Xem lại một job | `GET /api/worker/jobs/:id` |
| Heartbeat | `POST /api/worker/jobs/:id/heartbeat?worker=worker-1` |
| Hoàn thành | `POST /api/worker/jobs/:id/complete?worker=worker-1` |
| Báo lỗi | `POST /api/worker/jobs/:id/fail?worker=worker-1` |
| Tạo/cập nhật cảnh (sau `analyze_brief`) | `POST /api/worker/scenes` |
| Ghi chú/trả lời vào cảnh | `POST /api/worker/comments` |

```bash
API=http://127.0.0.1:8787
TOKEN=$(sed -n 's/^WORKER_TOKEN=//p' .env)
curl -sS -w '\nHTTP %{http_code}\n' "$API/api/worker/status"                                          # không cần token
# {"online":true,"last_seen_at":"…","worker_id":"worker-1","queue_paused":false,"pause_reason":null,"pause_code":null,"paused_at":null,"server_time":"…"}
curl -sS -w '\nHTTP %{http_code}\n' -H "Authorization: Bearer $TOKEN" "$API/api/worker/jobs/42"        # xem lại job 42 (trạng thái, payload, kết quả)
```

Được phép **đọc** (không cần token, không đổi gì): `GET /api/scenes/:id` (asset, comment, lịch sử prompt của cảnh), `GET /api/projects/:id` và `GET /api/projects/:id/refs` (ảnh tham chiếu kèm nhãn), `GET /api/projects/:id/budget` (credit đã dùng/đặt trước và số lượt mỗi cảnh; web không còn hạn mức credit, chỉ giới hạn số lượt), `GET /api/jobs?status=claimed,running` (job đang giữ), và tải file qua `/files/<đường dẫn tương đối>`.

## 2.1 Nhận job: `GET /api/worker/next`

- `200` + Job: bạn **đã giữ job này** (claim nguyên tử, trạng thái `claimed`, cảnh chuyển sang `*_running`). `payload` đã được tính sẵn đầy đủ, đừng tự suy đoán gì thêm.
- `204` không có thân: chưa có việc, chờ 20 giây rồi gọi lại.
- `503` `QUEUE_PAUSED`: hàng đợi đang tạm dừng, chờ người dùng (mục 3).

Lệnh nhận job chuẩn: chờ tối đa khoảng 60 giây (3 lần cách nhau 20 giây) rồi mới trả về, để đỡ tốn lượt gọi. Nếu môi trường chặn `sleep` thì gọi một lần mỗi lượt và dùng công cụ chờ của phiên.

```bash
API=http://127.0.0.1:8787
TOKEN=$(sed -n 's/^WORKER_TOKEN=//p' .env)
mkdir -p /tmp/autovideo-worker && rm -f /tmp/autovideo-worker/job.json
for i in 1 2 3; do
  code=$(curl -sS -o /tmp/autovideo-worker/job.json -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$API/api/worker/next?worker=worker-1")
  [ "$code" != 204 ] && break
  sleep 20
done
echo "HTTP $code"
if [ -s /tmp/autovideo-worker/job.json ]; then cat /tmp/autovideo-worker/job.json; echo; fi
```

Job trả về (rút gọn, job `video`):

```json
{"id":42,"project_id":3,"project_name":"Selftest","scene_id":7,"scene_code":"C1","type":"video","status":"claimed",
 "payload":{
   "project":{"id":3,"slug":"selftest","name":"…","style_lock":"…"},
   "scene":{"id":7,"code":"C1","title":"…","prompt":"Style: …","first_frame_desc":"…"},
   "upload_files":["refs/3/box.png","output/selftest/storyboard/C1_storyboard.png"],
   "storyboard_path":"output/selftest/storyboard/C1_storyboard.png",
   "attempt":1,
   "output":{"video_path":"output/selftest/video/C1_v1.mp4","grid_path":"output/selftest/video/C1_v1_grid.jpg"},
   "settings":{"aspect":"9:16","duration_s":10,"count":1,"resolution":"720p"},
   "credits_expected":15,"requeued":false},
 "claimed_by":"worker-1","requeue_count":0,"requires_approval":true,"approved_at":"…", "…":"…"}
```

Xem một phần payload cho gọn: `jq '.payload' /tmp/autovideo-worker/job.json`; riêng prompt nguyên văn: `jq -r '.payload.scene.prompt' /tmp/autovideo-worker/job.json`.

Nếu mất ngữ cảnh giữa chừng (phiên bị nén hoặc khởi động lại), lấy lại các job đang giữ: `curl -sS "$API/api/jobs?status=claimed,running" | jq '.[] | select(.claimed_by=="worker-1")'`, rồi heartbeat ngay và làm tiếp.

## 2.2 Heartbeat

```bash
API=http://127.0.0.1:8787
TOKEN=$(sed -n 's/^WORKER_TOKEN=//p' .env)
curl -sS -w '\nHTTP %{http_code}\n' -X POST -H "Authorization: Bearer $TOKEN" "$API/api/worker/jobs/42/heartbeat?worker=worker-1"
# {"ok":true,"status":"running","heartbeat_at":"…"}   HTTP 200
```

Heartbeat đầu tiên đổi job từ `claimed` sang `running` (web hiện "đang chạy"). Quá 5 phút không heartbeat, server trả job về hàng đợi.

## 2.3 Hoàn thành: `POST /api/worker/jobs/:id/complete`

Thân: `{ "result": {…}, "assets": [{ "kind", "file_path", "meta" }], "credits_cost": số }`. `file_path` phải là đường dẫn tương đối dưới `output/` và **file phải tồn tại** trước khi gọi (không thì `400 FILE_NOT_FOUND`). Trả `200 {"job":{…,"status":"done"}}`.

Khi thân có chữ dài hay có dấu nháy (prompt, nhận xét), **đừng ghép JSON bằng tay**. Dùng `jq -n --arg` rồi chuyển thẳng vào `curl -d @-`:

```bash
API=http://127.0.0.1:8787
TOKEN=$(sed -n 's/^WORKER_TOKEN=//p' .env)
jq -n --arg note 'Không thấy lỗi; 941x1672 (9:16).' --arg path 'output/selftest/storyboard/C1_storyboard.png' \
  '{result:{verdict:"pass", note:$note}, assets:[{kind:"storyboard", file_path:$path, meta:{width:941, height:1672}}]}' \
| curl -sS -w '\nHTTP %{http_code}\n' -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    "$API/api/worker/jobs/42/complete?worker=worker-1" -d @-
```

Chi tiết từng loại job ở mục 4.

## 2.4 Báo lỗi: `POST /api/worker/jobs/:id/fail`

Thân: `{ "error": "mô tả ngắn bằng tiếng Việt", "code": "...", "credits_cost": số (tùy chọn, chỉ job video) }`. `code` ∈ `CAPTCHA` · `LOGIN_REQUIRED` · `FLOW_OUT_OF_CREDIT` · `UI_CHANGED` · `OTHER` (thiếu thì là `OTHER`). Bốn mã đầu **tạm dừng hàng đợi**.

```bash
API=http://127.0.0.1:8787
TOKEN=$(sed -n 's/^WORKER_TOKEN=//p' .env)
curl -sS -w '\nHTTP %{http_code}\n' -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  "$API/api/worker/jobs/42/fail?worker=worker-1" \
  -d '{"error":"Flow hiện CAPTCHA, cần người dùng xử lý","code":"CAPTCHA"}'
# {"job":{…,"status":"failed","error_code":"CAPTCHA"},"worker":{"queue_paused":true,"pause_code":"CAPTCHA",…}}
```

`credits_cost` chỉ điền khi Flow đã thật sự trừ credit mà không ra video dùng được (job vẫn tính một lượt).

## 2.5 Tạo/cập nhật cảnh: `POST /api/worker/scenes`

Dùng sau `analyze_brief` (mục 4.1). Upsert theo `(project_id, code)`, cả lô tất-cả-hoặc-không:

```bash
API=http://127.0.0.1:8787
TOKEN=$(sed -n 's/^WORKER_TOKEN=//p' .env)
jq -n --argjson pid 3 --arg prompt "$(cat /tmp/autovideo-worker/C1_prompt.txt)" '{
  project_id: $pid,
  scenes: [{code:"C1", order_index:0, title:"Mở hộp", prompt:$prompt,
            first_frame_desc:"Toàn cảnh mặt bàn, tay cầm hộp còn nguyên.",
            upload_refs:[5], use_prev_storyboard:false}]
}' | curl -sS -w '\nHTTP %{http_code}\n' -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    "$API/api/worker/scenes" -d @-
# {"created":["C1"],"updated":[],"skipped":[],"scenes":[{"id":7,"code":"C1","status":"awaiting_approval",…}]}
```

`upload_refs` là mảng **id** ảnh tham chiếu (lấy từ `payload.refs[].id`) theo đúng thứ tự upload: phần tử đầu là "image 1". `skipped` liệt kê cảnh đang chạy nên giữ nguyên prompt.

## 2.6 Ghi chú vào cảnh: `POST /api/worker/comments`

Comment của bạn luôn là ghi chú (không có tác dụng phụ). `asset_id`, `timecode` (giây) là tùy chọn.

```bash
API=http://127.0.0.1:8787
TOKEN=$(sed -n 's/^WORKER_TOKEN=//p' .env)
curl -sS -w '\nHTTP %{http_code}\n' -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  "$API/api/worker/comments" \
  -d '{"scene_id":7,"body":"Giả định: clip dài 10 giây, không lời thoại. Cần bạn xác nhận hộp đặt ở góc phải.","timecode":null}'
# 201 {"comment":{"id":1,"scene_id":7,"author":"claude","action":"note","resolved":false,…}}
```

## 2.7 Mã trả về cần xử lý

| HTTP / `code` | Ý nghĩa | Việc phải làm |
|---|---|---|
| `409 JOB_CANCELLED` (heartbeat/complete/fail) | Job đã bị hủy, đã trả về hàng đợi, đã giao cho worker khác hoặc đã xong | **Dừng job đó ngay**, không làm tiếp, không complete/fail lại, quay về vòng lặp |
| `409 INVALID_STATE` (complete/fail) | Job không còn `claimed/running` | Như trên |
| `409 NO_SCENES` | `complete` analyze_brief khi chưa tạo cảnh | Gọi `POST /api/worker/scenes` trước |
| `400 FILE_NOT_FOUND` / `INVALID_PATH` | `file_path` sai hoặc file chưa có | Sửa đường dẫn/ghi file đúng chỗ rồi gọi lại `complete` (job vẫn còn giữ) |
| `400 VALIDATION_ERROR` / `ASSET_REQUIRED` / `INVALID_ASSET_KIND` | Thân sai | Đọc `message`, sửa thân, gọi lại |
| `400 INVALID_EDL` (complete `edit_plan`) | EDL sai (thiếu cảnh, sai thứ tự/asset_id, đoạn chồng nhau, ngắn hơn 0,3 s, ngoài thời lượng…) | Job vẫn còn giữ: đọc `message` (nêu cảnh/đoạn), sửa EDL, gọi lại `complete` (mục 4.5) |
| `401 UNAUTHORIZED` | Token sai | Đọc lại `.env` (token không có dấu nháy; nếu `.env` bọc token trong dấu nháy thì bỏ dấu nháy khi gọi) |
| `503 QUEUE_PAUSED` (next) | Hàng đợi tạm dừng | Mục 3 |
| `000` / không kết nối được | Server tắt | Chờ 20 giây thử lại; sau 5 lần thì báo người dùng |

# 3. Vòng lặp chính

Lặp lại cho tới khi người dùng bảo dừng:

1. `GET /api/worker/next` (lệnh ở 2.1).
   - `204`: chờ 20 giây, gọi lại. Không cần nhắn gì cho người dùng.
   - `503 QUEUE_PAUSED`: hàng đợi đang bị tạm dừng (do lỗi trước đó hoặc người dùng chủ động). Nhắn một lần: "Hàng đợi đang tạm dừng: <pause_reason>. Bạn bấm 'Tiếp tục hàng đợi' trên web khi sẵn sàng." Rồi gọi lại `next` mỗi 30 giây (hoặc đọc `GET /api/worker/status` kiểm tra `queue_paused`) cho đến khi hết `503`. Bạn **không** tự bỏ tạm dừng.
   - `200`: sang bước 2.
2. **Heartbeat ngay** (job chuyển sang `running`).
3. Làm job theo loại (mục 4). Khi chờ lâu trên Chrome (Flow đang tạo, ChatGPT đang vẽ): **heartbeat ít nhất mỗi 60 giây**, ví dụ sau mỗi lần kiểm tra trạng thái. Mọi `409` ở heartbeat/complete/fail: **dừng job đó ngay** (đóng hộp thoại đang mở, nhắn người dùng một dòng nếu Flow đã bắt đầu tạo video, vì có thể đã tốn credit), rồi quay lại bước 1.
4. Xong thì `complete`; không làm được thì `fail` với đúng mã (mục 6). Sau `fail` bằng mã làm dừng hàng đợi (`CAPTCHA`, `LOGIN_REQUIRED`, `FLOW_OUT_OF_CREDIT`, `UI_CHANGED`) thì **dừng vòng lặp** và nhắn người dùng.
5. Nhắn người dùng **một dòng** cho mỗi job xong, ví dụ: `Xong C2 video lượt 1: Đạt. Tốn 15 credit.` Không dán lại dữ liệu dài.
6. Quay lại bước 1.

`fail` mã `OTHER` không dừng hàng đợi: tiếp tục job sau. Nếu `OTHER` xảy ra liên tiếp 3 lần thì dừng và hỏi người dùng.

**Gối đầu giữa các cảnh khác nhau (tùy chọn):** server không giao hai job cùng một cảnh cho bạn. Khi job A đang chờ Flow tạo video (đã bấm tạo, đang chờ), bạn được gọi `next` để nhận thêm job B (ví dụ storyboard của cảnh khác trên ChatGPT) và làm trong lúc chờ. Điều kiện: giữ **tối đa 3 job** cùng lúc, ghi nhớ danh sách job đang giữ, **heartbeat tất cả các job đó** ít nhất mỗi 60 giây, thao tác Chrome vẫn từng bước một, mỗi job video chỉ bấm tạo một lần. Khi video của job A xong thì quay lại tải và hoàn thành A trước khi nhận job mới.

# 4. Làm từng loại job

Trước mỗi job: đọc `payload.requeued`. Nếu `true`, đọc mục 5 trước khi bấm tạo bất cứ thứ gì.

## 4.1 `analyze_brief`: chia cảnh và viết prompt

Payload: `project` (có `brief`, `style_lock`, `credit_per_video`, `max_attempts_per_scene`), `refs` (`id`, `label`, `file_path`), `rules_file` (`video-production-rules.md`).

1. Đọc **toàn bộ** `video-production-rules.md`: luật viết prompt, định dạng prompt, cách chia clip. Đây là nguồn luật chính. Các điểm quan trọng nhất:
   - Prompt viết bằng tiếng Anh, đúng các dòng: `Style:`, dòng chủ thể, `Action:`, `Shot n: a–b s, …`, `Cut:`, `Camera:`, `Mood:`, rồi `No dialogue…/Focus on…/Avoid…`.
   - Ghi mốc giây cho từng shot, tả kết quả nhìn thấy được chứ không chỉ ý định; nhân quả và vật lý rõ ràng; liệt kê mọi đồ vật và vị trí ngay trong khung đầu; một người, đúng tay.
   - Gọi sản phẩm là "the … from image N"; thêm "must look exactly like image N" khi sản phẩm là trọng tâm.
   - Không để AI vẽ chữ; không viết từ ngữ quảng cáo (offer, showcase…); không nhạc nền; chữ và đồ họa làm khi dựng.
   - Avoid chỉ 2–4 mục, đúng lỗi dễ xảy ra với clip đó.
2. **Thông số của hệ thống này khác mặc định trong `video-production-rules.md`**, tuân theo cái dưới đây: khung **9:16**, mỗi clip **10 giây** (shot phủ kín 0–10 s), mỗi lượt tạo **1 bản** (x1), tối đa `max_attempts_per_scene` lượt cho mỗi cảnh.
3. Xem từng ảnh tham chiếu (mở file `ROOT/<file_path>` bằng công cụ đọc ảnh). Kiểm tra theo mục "Ảnh tham chiếu" của `video-production-rules.md`: đúng sản phẩm, rõ nhãn, chi tiết hay bị vẽ lại. Ảnh không dùng được thì ghi vào comment (bước 6), không bỏ qua.
4. Đọc `brief` và `style_lock`. `style_lock` là phần cố định phải khớp trong mọi prompt (ánh sáng, mặt bếp, trạng thái đồ vật); chép đúng ý đó vào dòng Style và dòng chủ thể của từng clip.
5. Chia cảnh và viết prompt. Mỗi cảnh gồm:
   - `code`: `C1`, `C2`, … liên tục; `order_index`: 0, 1, 2, …
   - `title`: tiêu đề ngắn tiếng Việt.
   - `prompt`: **chỉ khối prompt**, bắt đầu bằng `Style:`. Không kèm tiêu đề, dòng Upload hay dòng Khung đầu.
   - `first_frame_desc`: 1–2 câu tiếng Việt tả ảnh storyboard ở giây 0 (đồ vật nào ở đâu, tay đang làm gì), đủ để ChatGPT vẽ.
   - `upload_refs`: mảng id ảnh tham chiếu theo thứ tự upload. Prompt gọi ảnh là "image 1", "image 2" **đúng theo thứ tự mảng này**; chỉ đưa ảnh cảnh đó cần (ảnh thừa làm Flow thêm đồ vật vào cảnh). Storyboard luôn upload sau cùng và không chiếm số.
   - `use_prev_storyboard`: `false` cho cảnh đầu; `true` cho các cảnh sau nếu cùng bối cảnh (giữ cùng mặt bàn, ánh sáng, bàn tay với storyboard cảnh đầu); `false` nếu cảnh đổi hẳn bối cảnh.
6. Ghi prompt từng cảnh ra file tạm để không phải ghép chuỗi bằng tay (ví dụ `/tmp/autovideo-worker/C1_prompt.txt`), rồi gọi `POST /api/worker/scenes` (mục 2.5). Kiểm tra phản hồi: `created` có đủ mã, `skipped` rỗng, mọi cảnh `awaiting_approval`. Nếu có cảnh trùng mã đã tồn tại (phân tích lại), server cập nhật theo mã; cảnh đang chạy bị `skipped`.
7. Có điều cần người dùng xác nhận (giả định về thông số, ảnh tham chiếu không dùng được, lưu ý pháp chế theo `video-production-rules.md`): tối đa 3–4 điểm, gửi **một** comment vào cảnh đầu bằng `POST /api/worker/comments` (mục 2.6).
8. `complete` job (không cần `assets`). Chưa gọi `POST /api/worker/scenes` thì `complete` bị `409 NO_SCENES`. **Không duyệt cảnh**, người dùng sẽ duyệt prompt trên web.

```bash
API=http://127.0.0.1:8787
TOKEN=$(sed -n 's/^WORKER_TOKEN=//p' .env)
curl -sS -w '\nHTTP %{http_code}\n' -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  "$API/api/worker/jobs/42/complete?worker=worker-1" -d '{"result":{"summary":"Đã chia 1 cảnh, 10 giây."}}'
# {"job":{"id":42,"type":"analyze_brief","status":"done",…}}
```

## 4.2 `storyboard`: tạo ảnh khung đầu bằng ChatGPT

Payload: `project`, `scene` (`code`, `prompt`, `first_frame_desc`), `upload_files` (đường dẫn tương đối, **đúng thứ tự upload**; từ cảnh thứ hai có thể có thêm storyboard cảnh đầu ở cuối), `attempt`, `output.storyboard_path` (nơi **phải** lưu ảnh), `requeued`.

1. Kiểm tra mọi file trong `upload_files` đều tồn tại. Thiếu file nào thì `fail` mã `OTHER`.
2. Lấy nhãn ảnh tham chiếu để viết lời nhắn cho ChatGPT: `curl -sS "$API/api/projects/<project.id>/refs"` (đọc, không cần token). Ảnh cuối kiểu `output/<slug>/storyboard/C1_storyboard.png` là storyboard cảnh đầu.
3. Mở https://chatgpt.com, tạo cuộc trò chuyện **mới**.
4. Upload các file trong `upload_files` **đúng thứ tự** (dùng công cụ upload file của công cụ browser của môi trường đang chạy; đường dẫn tuyệt đối = `ROOT` + `/` + đường dẫn tương đối). Chờ ảnh tải lên xong hết rồi mới gửi.
5. Gửi yêu cầu theo mẫu, điền phần trong ngoặc vuông (bỏ dòng "Giữ cùng…" nếu không có storyboard cảnh đầu):

```
Tạo 1 ảnh tĩnh duy nhất, khung dọc 9:16, phủ kín khung hình từ mép này sang mép kia, ảnh chụp thật (photorealistic).
Đây là khung hình MỞ ĐẦU (giây 0) của clip [mã cảnh].
Ảnh tham chiếu: [liệt kê: ảnh 1 = …, ảnh 2 = …]. Sản phẩm phải giữ ĐÚNG như ảnh tham chiếu: không vẽ lại nhãn, chữ, logo, màu, hình dạng.
[Giữ cùng mặt bếp, ánh sáng, bố cục đồ vật và bàn tay như ảnh storyboard cảnh đầu.]
Nội dung khung hình: [dán first_frame_desc] — chi tiết theo mô tả sau: [dán dòng Style và dòng chủ thể trong scene.prompt].
Không có chữ, phụ đề, khung viền, ảnh lồng trong ảnh, và không chia thành nhiều ô.
```

6. Kiểm tra ảnh trả về (heartbeat trong lúc chờ ChatGPT vẽ):
   - đúng khung dọc 9:16;
   - chỉ một khung hình, không chia ô, không viền;
   - không có chữ nào ngoài chữ có sẵn trên bao bì;
   - sản phẩm giống ảnh tham chiếu (nhãn, màu, hình dạng);
   - đúng đồ vật và vị trí theo `style_lock` và `first_frame_desc`; trạng thái đồ vật đúng với giây 0 của prompt (ví dụ vật chỉ xuất hiện ở giây 3.5 thì chưa được có trong khung đầu).
7. Ảnh chưa đạt thì yêu cầu ChatGPT sửa **đúng chỗ sai**, tối đa **3 lần sửa**. Sau 3 lần mà nhãn sản phẩm vẫn sai: lưu ảnh tốt nhất, `complete` với `verdict:"redo"` và `note` nói rõ lỗi (không tự bỏ storyboard; người dùng sẽ quyết định tạo lại).
8. Tải ảnh đạt về (thường vào `~/Downloads`), **lưu đúng vào `output.storyboard_path`** (định dạng png). Ví dụ:

```bash
mkdir -p "$(dirname output/selftest/storyboard/C1_storyboard.png)"
ls -t ~/Downloads | head -5                       # tìm file vừa tải (tên tiếng Việt có dấu: dùng glob)
mv ~/Downloads/<file-vừa-tải>.png output/selftest/storyboard/C1_storyboard.png
ffprobe -v error -show_entries stream=width,height -of csv=p=0 output/selftest/storyboard/C1_storyboard.png   # ví dụ 941,1672
```

   Nếu file tải về là webp/jpg thì đổi sang png: `ffmpeg -y -loglevel error -i vao.webp output/selftest/storyboard/C1_storyboard.png`. Tỉ lệ không gần 9:16 thì sửa tiếp trên ChatGPT, đừng cắt ảnh.
9. `complete` (mục 2.3): `result.verdict` ∈ `pass` / `fix_in_edit` / `redo`, `result.note` là nhận xét ngắn (lỗi còn thấy, số lần sửa), `assets: [{kind:"storyboard", file_path: output.storyboard_path, meta:{width, height}}]`. Không có `credits_cost` (storyboard miễn phí).

## 4.3 `video`: tạo video trên Google Flow

Payload: `project`, `scene` (`prompt` là văn bản gửi Flow), `upload_files` (refs theo thứ tự upload, **storyboard ở cuối cùng**), `storyboard_path`, `attempt`, `output.video_path`, `output.grid_path`, `settings` (`9:16`, `10` giây, `count: 1`, `720p`), `credits_expected`, `requeued`.

1. Kiểm tra mọi file trong `upload_files` tồn tại (kể cả storyboard) và `settings` đúng như trên. Đọc `payload.requeued` (mục 5): nếu `true`, kiểm tra Flow và `output.video_path` **trước** khi tạo.
2. Mở https://flow.google.com, tạo dự án hoặc cảnh mới cho clip.
3. Upload ảnh theo `upload_files` **đúng thứ tự**, storyboard sau cùng. Flow đánh số "image 1", "image 2"… theo thứ tự upload nên thứ tự này phải khớp prompt. Nếu Flow có chế độ khung đầu (Frames to Video / Start frame) thì dùng storyboard làm khung đầu, ngược lại upload như ảnh tham chiếu cuối cùng. Lần chạy tay đầu tiên dùng model **Flow Omni 1.1 Flash**, chế độ **Ingredients** (hộp, stick, storyboard); ưu tiên giữ cấu hình đó nếu còn, và ghi chế độ đã dùng vào `verdict_note`.
4. Chọn khung **9:16**, độ dài **10 giây**, số bản **x1**. Nếu Flow không cho chọn đúng như vậy, hoặc số credit hiển thị khác `credits_expected`: **không bấm tạo**, `fail` mã `UI_CHANGED` kèm mô tả.
5. Dán **nguyên văn** `payload.scene.prompt` vào ô prompt, không thêm gì khác (không thêm `style_lock`, không thêm dòng Upload). Prompt có ký tự đặc biệt (như dấu `–` trong "0–3 s"), nên sau khi nhập hãy **đọc lại nội dung ô prompt và đối chiếu từng chữ** với prompt gốc; lệch thì xóa nhập lại.
6. Ghi lại số dư credit đang hiển thị trên Flow (nếu có). Bấm tạo **đúng một lần**, ghi nhớ giờ bấm. Từ đây không bấm tạo lần nữa cho job này. Nếu sau 20 giây thấy không có gì chạy, **đừng bấm lại**: xem lịch sử/thư viện của Flow trước, vì có thể nó đang chạy.
7. Chờ tạo xong, **heartbeat ít nhất mỗi 60 giây**. Quá 20 phút không ra kết quả: `fail` mã `OTHER`, ghi rõ trong `error` rằng Flow có thể vẫn đang tạo và người dùng nên xem thư viện Flow trước khi tạo lại (nếu Flow đã trừ credit thì điền `credits_cost`). Trong lúc chờ có thể làm job khác theo luật gối đầu (mục 3).
8. Tải bản **720p** (không tải bản nâng 1080p/4K, vì có thể tốn thêm credit). File vào `~/Downloads`; chuyển ngay sang `output.video_path`:

```bash
ls -lt ~/Downloads/*.mp4 | head -3                # file vừa tải (mtime sau giờ bấm tạo)
mkdir -p output/selftest/video
mv ~/Downloads/<file-vừa-tải>.mp4 output/selftest/video/C1_v1.mp4
ffprobe -v error -select_streams v:0 -show_entries stream=width,height:format=duration -of default=noprint_wrappers=1 output/selftest/video/C1_v1.mp4
```

   Kỳ vọng `width 720`, `height 1280`, `duration` ≈ 10. Sai khác nhiều thì kiểm tra lại bản đã tải.
9. **Tách lưới khung hình** (đúng lệnh này, cho kết quả 1350×1920, 20 khung, mỗi khung cách nhau 0,5 giây; nó khớp các lưới của lần chạy tay trước):

```bash
ffmpeg -y -loglevel error -i output/selftest/video/C1_v1.mp4 \
  -vf "fps=2,scale=270:-2,tile=5x4" -frames:v 1 -update 1 output/selftest/video/C1_v1_grid.jpg
```

   Phải lưu đúng `output.grid_path`. Cần soi kỹ đoạn hành động chính thì tạo thêm lưới dày hơn **vào thư mục tạm** (không để trong `output/`): `ffmpeg -y -loglevel error -i <video> -vf "fps=4,scale=360:-2,tile=5x8" -frames:v 1 -update 1 /tmp/autovideo-worker/C1_v1_fine.jpg`.
10. **Xem lưới** bằng công cụ đọc ảnh và đối chiếu với `scene.prompt` (từng shot, từng mốc giây) và danh sách kiểm tra:
   - sản phẩm giống ảnh tham chiếu (chữ trên bao bì, màu, hình dạng; Veo hay vẽ lại nắp, nhãn);
   - đúng vật lý (nhân quả, chất lỏng, vật rơi, mở/xé bao bì);
   - đồ vật không tự biến mất hay tự xuất hiện (đối chiếu `style_lock`);
   - không có chữ hay phụ đề lạ, không khung ghép/viền/hình lồng hình, hình phủ kín khung dọc;
   - đúng số người, đúng tay, không đổi bên trái phải;
   - đủ hành động chính theo đúng mốc giây.
11. **Kết luận** cho bản này:
   - `pass`: đạt.
   - `fix_in_edit`: có lỗi nhỏ sửa được khi dựng (cắt, che, ghép bù), vẫn dùng được.
   - `redo`: lỗi nặng (sai sản phẩm, thiếu hành động chính, vật lý sai rõ, chữ/phụ đề lớn…).
   `verdict_note` viết bằng tiếng Việt, ngắn, đúng kiểu `log.md`: nêu lỗi thấy được kèm mốc giây, cái gì đã đúng, và lỗi nào là ngẫu nhiên hay có vẻ do prompt. Chỉ nói những gì bạn thật sự thấy: bạn xem lưới 2 khung/giây, **không nghe được âm thanh**, nên đừng khẳng định về lời thoại hay tiếng động. Kết luận `redo` thì thêm một comment chẩn đoán ngắn (bảng "Thời điểm | Video đang ra | Đúng ra phải là | Nguyên nhân trong prompt", theo mục "Chẩn đoán video lỗi" của `video-production-rules.md`) bằng `POST /api/worker/comments`, để người dùng quyết định sửa prompt hay tạo lại y nguyên.
12. `complete`. Lấy `meta` từ ffprobe rồi gửi cả video và lưới; `credits_cost` là số credit **Flow thật sự đã trừ** (đọc số dư trước và sau nếu Flow hiển thị), không biết thì dùng `credits_expected`:

```bash
API=http://127.0.0.1:8787
TOKEN=$(sed -n 's/^WORKER_TOKEN=//p' .env)
V=output/selftest/video/C1_v1.mp4
G=output/selftest/video/C1_v1_grid.jpg
META=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height:format=duration -of json "$V" \
  | jq -c '{width:.streams[0].width, height:.streams[0].height, duration_s:(.format.duration|tonumber|.*100|round/100)}')
jq -n --arg v "$V" --arg g "$G" --argjson meta "$META" --arg note 'Chữ trên gói ở giây 4–6 bị méo; bột rơi mịn, rót nước đúng, không chữ/phụ đề. (Chế độ Ingredients, xem qua lưới 2 khung/giây.)' \
  '{result:{verdict:"fix_in_edit", verdict_note:$note},
    assets:[{kind:"video", file_path:$v, meta:$meta}, {kind:"grid", file_path:$g, meta:{width:1350, height:1920}}],
    credits_cost:15}' \
| curl -sS -w '\nHTTP %{http_code}\n' -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    "$API/api/worker/jobs/42/complete?worker=worker-1" -d @-
```

   Server ghi sổ cái −`credits_cost`, thêm dòng vào `output/<slug>/log.md`, cảnh sang `video_review`. Xong là xong: dù kết luận là `redo`, **không tạo lại**.

## 4.4 `revise_prompt`: sửa prompt theo comment

Payload: `project`, `scene` (`prompt` hiện tại, `version`), `comments` (mọi comment **chưa xử lý** của cảnh; mỗi comment có `id`, `author`, `body`, `timecode` giây trong video, `asset_id`, `action`). Danh sách này có thể chứa cả ghi chú cũ của chính bạn (`author: "claude"`): bỏ qua những comment đó, chỉ xử lý comment của người dùng (`author: "user"`, kể cả ghi chú `note` cũ nếu liên quan đến yêu cầu sửa).

1. Đọc kỹ từng comment của người dùng. Xem thêm bối cảnh bằng `GET /api/scenes/<scene.id>` (asset, nhận xét cũ, lịch sử prompt). Comment gắn `timecode`/`asset_id` thì mở lưới ảnh của asset đó (`asset.file_path` với video `..._grid.jpg`) để xem đúng chỗ người dùng chỉ.
2. Đọc lại các luật liên quan trong `video-production-rules.md` (mục "Luật viết prompt", "Chẩn đoán video lỗi").
3. Sửa **đúng chỗ liên quan** đến comment, giữ nguyên mọi chỗ khác từng chữ (dòng Style, shot không liên quan, Camera, Mood…). Giữ đúng định dạng prompt và các luật (mốc giây, kết quả nhìn thấy được, Avoid có trọng tâm). Nếu thay đổi làm trạng thái đồ vật khác với các cảnh khác, nói rõ trong `reason`.
4. Comment không rõ hoặc đòi thứ trái luật (ví dụ thêm chữ vào hình): đừng đoán. Gửi comment hỏi lại bằng `POST /api/worker/comments`, chỉ đưa vào `resolved_comment_ids` những comment bạn đã thật sự xử lý.
5. Ghi prompt mới ra file tạm rồi `complete` (không cần `assets`):

```bash
API=http://127.0.0.1:8787
TOKEN=$(sed -n 's/^WORKER_TOKEN=//p' .env)
jq -n --rawfile prompt /tmp/autovideo-worker/C1_new_prompt.txt --arg reason 'Thêm kéo cắt ngang đầu gói ở giây 1–3 theo comment #1; giữ nguyên phần còn lại.' \
  '{result:{prompt:($prompt|rtrimstr("\n")), reason:$reason, resolved_comment_ids:[1]}}' \
| curl -sS -w '\nHTTP %{http_code}\n' -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    "$API/api/worker/jobs/42/complete?worker=worker-1" -d @-
```

   `result.prompt` là **toàn bộ** prompt mới (không phải đoạn thay thế); `reason` bắt buộc, ngắn, tiếng Việt. Server tạo version prompt mới (`created_by=claude`), đánh dấu comment đã xử lý, đưa cảnh về `awaiting_approval` để người dùng duyệt lại, giữ nguyên các video cũ.
6. Tùy chọn: gửi một comment ngắn trả lời người dùng ("Đã sửa …, mời bạn duyệt lại").
7. **Không bao giờ tạo video** trong job này; không mở Flow.

## 4.5 `edit_plan`: chọn điểm cắt cho bản hoàn chỉnh

Khi **mọi cảnh của dự án đã có video được chọn**, web tự giao job này (hoặc người dùng bấm "Dựng bản mới"). Việc của bạn: xem kỹ video từng cảnh rồi quyết định **đoạn nào giữ, đoạn nào cắt** để ghép các cảnh thành một video hoàn chỉnh (chuyển cảnh là **cắt thẳng**, không hiệu ứng). Bạn **chỉ trả bản kế hoạch cắt (EDL)**; **server tự render** bằng Shotcut (hoặc ffmpeg) sau khi bạn `complete`. Job này **không mở Chrome/Flow/ChatGPT**, **không tốn credit**, **không có `assets`**, **không có `credits_cost`**.

Payload:

```
{ "final_cut_id":3, "version":1, "project":{ "id", "slug", "name", "style_lock" },
  "scenes":[ { "scene_id", "code", "title", "prompt", "asset_id", "attempt",
               "video_path", "abs_path", "duration_s", "fps", "width", "height", "grid_path",
               "verdict", "verdict_note", "comments":[ {id, body, timecode, …} ] } ],   // theo ĐÚNG thứ tự cảnh
  "constraints":{ "aspect":"9:16", "transition":"cut", "min_segment_s":0.3, "keep_scene_order":true },
  "output":{ "video_path", "project_file_path", "contact_sheet_path" },   // chỉ để biết, server tự ghi
  "requeued":false }
```

`comments` của mỗi cảnh chỉ gồm comment **chưa xử lý có mốc thời gian** của người dùng (họ đã chỉ đúng chỗ lỗi/thừa: đọc kỹ, ưu tiên cắt đúng những chỗ đó). `verdict_note` là nhận xét lần xem trước (vd "chữ trên gói bị méo").

**Cần cắt gì**

- *Khoảng thừa*: đầu/cuối clip chưa có hành động, khung đứng yên, tay chưa vào khung, đoạn chờ.
- *Đoạn không hợp lý*: chữ bao bì bị méo/đọc sai (vd "CAD ACTISO+"), đồ vật tự xuất hiện hoặc biến mất, vật lý sai (chất lỏng, bột), tay hoặc người biến dạng, giật hình.
- *Giữ mạch hành động nối liền giữa các cảnh*: cảnh sau phải bắt đầu ở trạng thái đồ vật khớp với cuối cảnh trước (theo `style_lock` và nội dung prompt). Cắt đầu cảnh sau hay cuối cảnh trước để hai bên ăn khớp, đừng để hộp/ly/nguyên liệu "nhảy" vị trí ở chỗ nối.
- Cắt **ở ranh giới shot** khi có thể; không cắt giữa một động tác đang diễn ra.

**Cách xem video**

1. Ảnh lưới có sẵn `grid_path` (xem nhanh), rồi lưới chi tiết 4 khung/giây bằng ffmpeg. Build ffmpeg ở máy này **không có `drawtext`** (kiểm tra: `ffmpeg -hide_banner -filters | grep -c ' drawtext '` ra `0`) nên dùng bố cục **mỗi hàng đúng 1 giây**: 4 cột = `.00 .25 .50 .75`; ô ở hàng `r`, cột `c` (đếm từ 0) = giây `ss + r + c/4`. Mỗi ảnh 5 giây:

```bash
mkdir -p /tmp/autovideo-worker
ABS=$(jq -r '.payload.scenes[0].abs_path' /tmp/autovideo-worker/job.json)      # cảnh thứ nhất; đổi chỉ số cho cảnh khác
for ss in 0 5; do   # video 10 giây → 2 ảnh: 0–5 s và 5–10 s
  ffmpeg -y -loglevel error -ss $ss -t 5 -i "$ABS" -vf "fps=4,scale=216:-1,tile=4x5:padding=2" -frames:v 1 /tmp/autovideo-worker/C1_grid_$ss.png
done
```

   Nếu `drawtext` có sẵn thì thêm mốc giây vào từng ô: `-vf "fps=4,scale=216:-1,drawtext=fontfile=/System/Library/Fonts/Supplemental/Arial.ttf:text='%{pts\:flt}':x=6:y=6:fontsize=18:fontcolor=yellow:box=1:boxcolor=black@0.6,tile=4x5:padding=2"`. Mở ảnh bằng công cụ đọc ảnh của bạn để xem.
2. Soi một khoảnh khắc: `ffmpeg -y -loglevel error -ss 3.25 -i "$ABS" -frames:v 1 /tmp/autovideo-worker/C1_3_25.png`.
3. Nếu phiên có công cụ MCP `shotcut`: được dùng `probe_media`, `analyze_media_quality`, `render_preview_batch` để soi đúng khung. **CẤM** `start_render`, `create_project`, `edit_project` và mọi công cụ Shotcut ghi/render file: server tự render, bạn làm sẽ đè bản của server.
4. Kiểm tra mạch nối giữa cảnh: xem 1 giây cuối của cảnh trước và 1 giây đầu của cảnh sau cạnh nhau.

**Luật cho EDL** (server kiểm tra, sai thì `400 INVALID_EDL` kèm cảnh/đoạn lỗi)

- Đủ **mọi cảnh**, **đúng thứ tự** `payload.scenes`, đúng `scene_id` và `asset_id` như payload. Không đổi thứ tự, không bỏ cả cảnh.
- Mỗi cảnh ≥ 1 đoạn `segments:[{in_s,out_s}]` (giây trên video nguồn): `0 ≤ in_s < out_s ≤ duration_s`, **mỗi đoạn dài ≥ 0,3 s**, các đoạn **tăng dần và không chồng nhau** (được chạm nhau). Video nối theo thứ tự cảnh rồi theo thứ tự đoạn.
- Mỗi khoảng bị bỏ ghi vào `removed:[{from_s,to_s,reason}]`, `reason` **bằng tiếng Việt kèm mốc giây** (vd `"0–0,3s đầu: khung đứng yên, tay chưa vào"`, `"6,2–7,0s: chữ trên gói méo thành CAD ACTISO+"`). Nếu bỏ thì ghi `removed`, đừng để người dùng đoán.
- `note` (tùy chọn) ghi chú ngắn cho từng cảnh. `summary` (bắt buộc, ở `result`) 1–3 câu tiếng Việt: đã cắt gì, vì sao, mạch nối thế nào.

**Gửi kết quả**

```bash
API=http://127.0.0.1:8787
TOKEN=$(sed -n 's/^WORKER_TOKEN=//p' .env)
cat > /tmp/autovideo-worker/edl.json <<'JSON'
{"scenes":[
  {"scene_id":1,"asset_id":5,"segments":[{"in_s":0,"out_s":9.5}],
   "removed":[{"from_s":9.5,"to_s":10.0,"reason":"9,5–10,0s cuối: khung đứng yên, hết hành động"}],"note":"Chữ trên gói đọc đúng ở bản này"},
  {"scene_id":2,"asset_id":8,"segments":[{"in_s":0.3,"out_s":6.2},{"in_s":7.0,"out_s":9.6}],
   "removed":[{"from_s":0,"to_s":0.3,"reason":"0–0,3s đầu: tay chưa vào khung"},{"from_s":6.2,"to_s":7.0,"reason":"6,2–7,0s: nguyên liệu tự biến mất"},{"from_s":9.6,"to_s":10.0,"reason":"9,6–10,0s cuối: khung đứng yên"}],"note":""}
]}
JSON
jq -n --slurpfile edl /tmp/autovideo-worker/edl.json --arg summary 'Cắt khoảng đứng yên đầu/cuối mỗi cảnh và bỏ 0,8 giây ở C2 vì nguyên liệu tự biến mất; cuối C1 và đầu C2 khớp trạng thái ly trống.' \
  '{result:{edl:$edl[0], summary:$summary}}' \
| curl -sS -w '\nHTTP %{http_code}\n' -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    "$API/api/worker/jobs/42/complete?worker=worker-1" -d @-
# 200 {"job":{…,"status":"done","credits_cost":0}}   → server render nền; web hiện "Đang render" rồi "Sẵn sàng"
```

Các số `scene_id`/`asset_id` ở trên chỉ là ví dụ: **luôn lấy từ payload** (`jq -r '.payload.scenes[] | "\(.code) \(.scene_id) \(.asset_id) \(.duration_s)"' /tmp/autovideo-worker/job.json`).

**Khi `400 INVALID_EDL`**: job **vẫn còn giữ** (không mất), `message` nói rõ cảnh và đoạn sai (vd `EDL không hợp lệ — cảnh C2, đoạn 2: in_s = 6 chồng lên đoạn trước (kết thúc ở 6.2)`). Sửa đúng chỗ đó trong `edl.json` rồi gọi lại `complete`; tiếp tục heartbeat trong lúc sửa. `400 VALIDATION_ERROR` là thiếu `summary`. Sau `complete` thành công thì xong việc: **không** chờ render, không gọi thêm API nào.

Không làm được (không đọc được video, file thiếu): `fail` mã `OTHER` kèm mô tả; bản hoàn chỉnh sẽ báo lỗi và người dùng bấm dựng lại được.

# 5. Job bị trả về hàng đợi (`payload.requeued = true`)

Job từng bị giao đi nhưng mất heartbeat quá 5 phút (phiên cũ đóng, máy ngủ…), nên có thể **kết quả đã được tạo mà chưa báo**. Tạo lại sẽ tốn credit hai lần, vì vậy kiểm tra trước:

- **`storyboard`**: mở lịch sử ChatGPT (cột trái), tìm cuộc trò chuyện gần đây về cảnh này (mã cảnh, nội dung "Khung đầu"). Có ảnh đạt rồi thì tải xuống và hoàn thành, không vẽ lại. Kiểm tra thêm `output.storyboard_path` đã có file chưa.
- **`video`**:
  1. `ls -la <output.video_path>`: nếu file đã có thì `ffprobe` kiểm tra; hợp lệ (720×1280, ≈10 s) thì dùng nó, làm tiếp từ bước tách lưới, không tạo lại.
  2. Mở thư viện/lịch sử của Flow, tìm video gần nhất của cảnh này (đầu prompt khớp `scene.prompt`, thời điểm tạo gần `last_requeued_at`). Có bản đã xong thì tải xuống và làm tiếp; còn đang chạy thì chờ (nhớ heartbeat); đã lỗi thì coi như chưa tạo.
  3. Tìm thêm trong `~/Downloads` file mp4 mới.
  4. Chỉ khi **chắc chắn** chưa có gì thì mới tạo mới (bấm đúng một lần).
  - Credit của video tìm lại được đã bị trừ ở phiên trước mà chưa ghi sổ: `complete` với `credits_cost` = `credits_expected` như bình thường, và ghi chú "tìm lại bản đã tạo từ phiên trước" vào `verdict_note`.
- `analyze_brief` / `revise_prompt` / `edit_plan`: không tốn credit, làm lại từ đầu bình thường (cảnh đã tạo trước đó được upsert theo mã; `edit_plan` chỉ cần gửi lại EDL).

# 6. CAPTCHA, đăng nhập, hết credit, giao diện lạ

Gặp một trong các tình huống sau thì **dừng thao tác ngay**, không thử vượt, và gọi `fail` (mục 2.4) với đúng mã:

| Tình huống | `code` | Ghi chú |
|---|---|---|
| CAPTCHA, "xác minh bạn là người", hộp thoại bảo mật | `CAPTCHA` | Không tự giải |
| Trang đăng nhập Google/ChatGPT, phiên hết hạn, yêu cầu mật khẩu/2FA | `LOGIN_REQUIRED` | Không nhập mật khẩu |
| Flow báo hết credit (tài khoản Flow hết thật, không phải hạn mức của web), không cho tạo | `FLOW_OUT_OF_CREDIT` | Chỉ với job video; cảnh sang `blocked_budget`; không bấm mua/nâng gói |
| Giao diện khác hẳn mô tả, không tìm được nút/ô cần thiết; hộp thoại xác nhận/thanh toán/nâng gói lạ; không chọn được 9:16, 10 giây, x1; số credit khác `credits_expected` | `UI_CHANGED` | Mô tả bạn thấy gì trong `error` |
| Lỗi khác: file thiếu, ffmpeg lỗi, ChatGPT từ chối, mạng, Flow tạo lỗi, quá 20 phút | `OTHER` | Không dừng hàng đợi |

Sau `fail` bằng một trong bốn mã đầu: web hiện cảnh báo, hàng đợi tạm dừng. Việc của bạn: **dừng vòng lặp**, nhắn người dùng ngắn gọn đang thấy gì và cần họ làm gì (ví dụ "Flow đang hiện CAPTCHA ở tab Flow. Bạn giải rồi bấm 'Tiếp tục hàng đợi' trên web"), rồi chờ như ở mục 3 (`next` trả `503` đến khi họ tiếp tục). Chỉ khi hết `503` mới quay lại vòng lặp; mở lại tab Chrome cần dùng và kiểm tra đã đăng nhập trước khi làm tiếp.

`fail` job video đã bấm tạo và Flow đã trừ credit nhưng không có video dùng được: điền `credits_cost` bằng số credit thật sự bị trừ.

# 7. Lưu ý khi điều khiển Chrome

- Dùng một tab cho ChatGPT, một tab cho Flow; trước khi thao tác hãy chắc đang ở đúng tab. Chụp màn hình sau mỗi bước quan trọng (upload xong, đã chọn 9:16/10 s/x1, đã bấm tạo, đã tải xong).
- Thao tác từng bước một, chờ trang phản hồi rồi mới bước tiếp. Không đóng tab hay đổi tab giữa lúc ChatGPT/Flow đang tạo.
- Giao diện ChatGPT hoặc Flow khác mô tả ở đây: tự tìm cách tương đương (đổi tên nút, vị trí menu). Chỉ `fail` `UI_CHANGED` khi không tìm được hoặc không chắc một thao tác có tốn tiền hay không.
- Lưu mọi file bằng đường dẫn tương đối đúng như `payload.output`; tạo thư mục cha nếu chưa có (`mkdir -p`).
- File tải về mặc định vào `~/Downloads`: chuyển ngay sang `output/<slug>/...` và đổi tên, tránh nhầm với file cũ. Tên file tiếng Việt có dấu có thể lệch chuẩn Unicode nên dùng glob thay vì gõ tên.

# 8. Tóm tắt một lượt làm việc

```
next (200) → heartbeat → [analyze_brief | storyboard | video | revise_prompt | edit_plan] → complete  (hoặc fail đúng mã)
          ↘ 204: chờ 20 s        ↘ 503: chờ người dùng bấm "Tiếp tục hàng đợi"        ↘ 409 ở heartbeat/complete/fail: bỏ job
```

Trước khi `complete`, tự kiểm tra: file đã nằm đúng `output.*` chưa; `file_path` trong `assets` trùng từng chữ; video có kèm lưới; `verdict` ∈ `pass|fix_in_edit|redo`; `credits_cost` đúng; bạn chưa gọi bất kỳ API duyệt nào.
