# WORKER-MUSE: tạo storyboard và video qua Muse2API

File này **thay mục 4.2 (`storyboard`) và 4.3 (`video`) của [WORKER.md](WORKER.md)** khi tạo ảnh/video bằng API Muse2API thay vì điều khiển ChatGPT và Google Flow trên Chrome. **Không mở Chrome, ChatGPT hay Flow.**

Phần còn lại của WORKER.md vẫn áp dụng nguyên văn: luật cứng, API worker (mục 2), vòng lặp chính (mục 3), các loại job khác, cách kiểm tra chất lượng. Khi file này và WORKER.md khác nhau về storyboard/video thì **làm theo file này**.

Tài liệu gốc của API: `/Users/thainv/code/muse/muse2api/docs/API_GUIDE_VI.md`. Chỉ cần đọc lại khi gặp mã lỗi không có trong mục 6.

**Người dùng chọn dịch vụ trên web** (video: khi bấm «Tạo video»; ảnh storyboard: trong «Cài đặt dự án»). Job storyboard và video mang `payload.generator` (`id`, `provider`, `model`, `label`, `max_images`; storyboard thêm `remove_logo`):
- `provider = "muse"` (hoặc job cũ không có `generator`): làm theo file này.
- `provider = "flow"`: làm theo [WORKER-FLOW.md](WORKER-FLOW.md). Video: thay mục 5.1–5.4, rồi quay lại 5.5–5.6. Storyboard: mục 9 của file đó (server tự xoá logo Gemini trên ảnh khi `complete`, worker không tự xoá).

**Ai dùng file này.** Từ 05/11/2026 worker nền `media-api-1` (`npm run worker:media`, mã `worker/src/media/media.ts`) tự làm mọi job storyboard/video theo đúng các luật dưới đây, trừ việc xem và chấm chất lượng: worker nền không gửi `verdict`, người dùng chấm trên web. Các khối lệnh curl/python bên dưới dành cho vòng lặp tay của Codex/Claude, chỉ chạy khi người dùng yêu cầu (vd worker nền đang tắt hoặc cần người xem chất lượng ảnh). Server giao mỗi job cho đúng một worker, nhưng tài khoản Muse chỉ chạy một task một lúc nên chạy song song với worker nền dễ gặp `no_account_available`.

## 0. Hiện trạng đã kiểm chứng (đọc trước)

Đối chiếu `API_GUIDE_VI.md` bản 04/11/2026 và các job chạy thật của dự án "7/11" (job 110–120).

| Hạng mục | Trạng thái |
|---|---|
| Storyboard: tạo ảnh async kèm 1–2 ảnh tham chiếu | Chạy thật, đạt (job 110–115). Muse trả **WebP khoảng 1152×2048**; bước tải ở mục 4 chuyển sang PNG |
| Video kèm 2 ảnh (sản phẩm + storyboard), 9:16, 10 giây | Chạy thật, đạt (job 116–120): **720×1280, 10,0 giây, h264**, task ghi `requested.reference_image_count=2` |
| Video kèm 1 ảnh (chỉ storyboard) | Chạy thật, đạt (job 119) |
| Gửi 3–4 ảnh trong một request | Muse2API nhận (có test), chưa chạy thật với Muse. Làm bình thường, nhưng kiểm tra `reference_image_count` như mục 5.4 |
| Khung 9:16, độ dài 10 giây | Muse2API tự diễn đạt `size` và `duration` vào prompt (`parameters_enforced=false`). Chỉ gửi hai trường này, không sửa prompt; đọc kích thước thật từ file |
| Video dài hơn 10 giây | Muse từ chối 15 giây; giữ đúng 10 giây |
| Thời gian | Ảnh khoảng 1 phút; video khoảng 1,5–3 phút |
| Worker nền `media-api-1` (từ 05/11/2026) | Storyboard Muse: 5 job xong. Video Muse: 2 xong, 1 lỗi. Phần lớn job sau đó chạy qua Google Flow (WORKER-FLOW.md) |

Mỗi tài khoản Muse chạy **một task một lúc**. Làm tuần tự từng job: chờ task trước xong (hoặc lỗi) rồi mới POST task tiếp. Gửi ảnh khi video khác đang chạy trên cùng tài khoản có thể lỗi `no_account_available`.

## 1. Điều kiện trước khi nhận job

Người dùng chuẩn bị các điều kiện dưới đây. Codex chỉ kiểm tra, **không tự sửa `.env`, không khởi động lại server hay worker**.

1. **Muse2API đang chạy** ở `http://127.0.0.1:18610` (container Docker `muse2api-muse2api-1`), có tài khoản Muse đã đăng nhập trong dashboard, driver `browser`.
2. **Job `storyboard` và `video` thuộc làn legacy:** cả hai **không** nằm trong `MANAGED_JOB_TYPES` của `.env` (kiểm tra bằng lệnh `ping` bên dưới). Nếu `storyboard` còn trong danh sách thì managed worker vẫn đang nhận nó: báo người dùng, vòng lặp tay chỉ nhận `video`.
3. Server autovideo ở `http://127.0.0.1:8787`, có `ffmpeg`, `ffprobe`, `jq`, `curl`, `python3`.

Kiểm tra (không tạo gì, không tốn hạn mức):

```bash
MUSE=http://127.0.0.1:18610
MKEY=$(cat /Users/thainv/code/muse/muse2api/data/api_key)
curl -sS -o /dev/null -w 'healthz %{http_code}\n' "$MUSE/healthz"
curl -sS -o /dev/null -w 'readyz %{http_code}\n' "$MUSE/readyz"
curl -sS -H "Authorization: Bearer $MKEY" "$MUSE/v1/models" | jq -r '[.data[].id] | map(select(.=="muse-image" or .=="muse-video")) | join(",")'
# healthz 200 · readyz 200 · muse-image,muse-video
API=http://127.0.0.1:8787
TOKEN=$(sed -n 's/^WORKER_TOKEN=//p' .env)
curl -sS "$API/api/health"; echo
curl -sS -H "Authorization: Bearer $TOKEN" "$API/api/worker/ping?worker=codex-1" | jq -c '.managed_job_types'   # không được có storyboard, video
```

`readyz` khác 200, hoặc thiếu model nào: không nhận job, báo người dùng mở dashboard Muse2API (`http://127.0.0.1:18610/dashboard`) để kiểm tra tài khoản.

## 2. Biến dùng trong mọi lệnh

Mỗi lần gọi shell là một phiên mới, nên **mọi khối lệnh bắt đầu bằng các dòng này**. Không in `TOKEN`, `MKEY` hay signed URL ra chat; không ghi chúng vào file, comment hay `result`.

```bash
API=http://127.0.0.1:8787
TOKEN=$(sed -n 's/^WORKER_TOKEN=//p' .env)
W=codex-1
MUSE=http://127.0.0.1:18610
MKEY=$(cat /Users/thainv/code/muse/muse2api/data/api_key)
mkdir -p /tmp/autovideo-worker
```

**Tên worker là `codex-1`**, thay cho `worker-1` trong ví dụ của WORKER.md. Khi nhận job, chỉ nhận đúng hai loại này:

```bash
code=$(curl -sS -o /tmp/autovideo-worker/job.json -w '%{http_code}' -H "Authorization: Bearer $TOKEN" \
  "$API/api/worker/next?worker=$W&types=storyboard,video")
echo "HTTP $code"
# 200: chép ngay ra file riêng theo id, vì các khối lệnh sau đọc file này
[ "$code" = 200 ] && JOB=$(jq -r .id /tmp/autovideo-worker/job.json) && cp /tmp/autovideo-worker/job.json /tmp/autovideo-worker/job-$JOB.json && echo "job $JOB $(jq -r .type /tmp/autovideo-worker/job.json)"
```

Sau đó heartbeat ngay, đúng như WORKER.md mục 3. Heartbeat, complete và fail đều dùng `?worker=codex-1`.

## 3. Luật riêng khi dùng Muse

1. **Video: mỗi job đúng một lần tạo.**
   - Gửi `POST /v1/videos` với `Idempotency-Key: autovideo-video-<job.id>`. Key này cố định theo mã job, không sinh ngẫu nhiên.
   - Gửi lại cùng key **và cùng body** thì Muse2API trả về task cũ, không tạo video mới. Nhờ vậy, mất mạng hay job bị trả về hàng đợi thì cứ gửi lại cùng body là an toàn.
   - Body được dựng lại giống hệt từ cùng payload và cùng file storyboard (mục 5.2).
   - **Không** dùng key khác cho cùng một job.
   - **Không** gọi `POST /v1/videos/{id}/retry`, không gọi `/admin/*`. Tạo lại là quyết định của người dùng trên web, sẽ thành một job mới với số lượt mới.
2. **Ảnh không có idempotency.**
   - Luôn gửi chế độ bất đồng bộ (`"async": true`).
   - Ngay sau khi nhận task id, ghi một comment vào cảnh: `[muse] storyboard lượt <attempt>, lần <k>: <task id>`.
   - Không POST ảnh lần nữa khi chưa chắc task trước đã `failed`. POST ảnh bị timeout hay mất mạng thì **không gửi lại ngay**: xem mục 6.
3. Ảnh đầu vào luôn gửi bằng **data URL** (`data:image/png;base64,…`). Không gửi đường dẫn file, không gửi URL `127.0.0.1`/LAN (Muse2API chặn). Giới hạn: mỗi ảnh khoảng 20 MiB, **cả request 30 MiB** (base64 làm file to thêm khoảng 1/3), nên ảnh lớn hơn 5 MB được thu nhỏ trước khi gửi (khối lệnh ở mục 4 và 5.2 làm sẵn).
4. **Prompt gửi nguyên văn**, như luật 6 của WORKER.md:
   - Storyboard: dùng `payload.chatgpt_message`.
   - Video: dùng `payload.scene.prompt`.
   - Ngoại lệ duy nhất: đoạn "Sửa so với lần trước" khi tạo lại ảnh storyboard (mục 4, bước 7).
5. Hệ thống không còn credit: `complete` không gửi `credits_cost` (server bỏ qua nếu có). Ghi `provider:"muse2api"` và task id vào `result`.
6. Poll mỗi 5 giây, heartbeat job autovideo **ít nhất mỗi 60 giây** trong lúc chờ (khối lệnh ở mục 5.3 làm sẵn cả hai). Gặp `409` ở heartbeat thì dừng job ngay, như WORKER.md mục 2.7.
7. Chỉ ghi file vào `payload.output.*`. File tạm (body JSON, ảnh thu nhỏ, trạng thái task) để trong `/tmp/autovideo-worker/`.

## 4. Job `storyboard`

**Trước tiên xem `payload.generator.provider`.** Là `"flow"` thì làm theo [WORKER-FLOW.md](WORKER-FLOW.md) mục 9, không làm mục này.

Payload giống WORKER.md mục 4.2: `upload_files` (đúng thứ tự), `chatgpt_message`, `attempt`, `output.storyboard_path`, `requeued`.

1. Nếu `payload.requeued = true`: đọc mục 7 trước.
2. Kiểm tra mọi file trong `upload_files` đều tồn tại. Thiếu thì `fail` mã `OTHER`.
3. **Muse nhận tối đa 4 ảnh tham chiếu.** `upload_files` có hơn 4 file thì `fail` mã `OTHER`, ghi rõ: "Muse nhận tối đa 4 ảnh tham chiếu; giảm ảnh của cảnh này rồi tạo lại". Không tự bỏ bớt ảnh, vì lời nhắn đánh số "ảnh 1, ảnh 2…" theo đúng thứ tự.
4. Dựng body. Ảnh lớn hơn 5 MB được thu nhỏ vào thư mục tạm để tổng request dưới 30 MiB:

```bash
JOB=42   # id job đang giữ
python3 - "$JOB" <<'PY'
import base64, json, mimetypes, os, subprocess, sys
job_id = sys.argv[1]
p = json.load(open(f"/tmp/autovideo-worker/job-{job_id}.json"))["payload"]
def data_url(path, k):
    if os.path.getsize(path) > 5 * 1024 * 1024:
        small = f"/tmp/autovideo-worker/ref-{job_id}-{k}.jpg"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", path, "-vf", "scale='min(2048,iw)':-2", "-q:v", "3", "-frames:v", "1", "-update", "1", "-map_metadata", "-1", small], check=True)
        path = small
    mime = mimetypes.guess_type(path)[0]
    assert mime in ("image/png", "image/jpeg", "image/webp"), f"định dạng ảnh không hỗ trợ: {path}"
    return f"data:{mime};base64," + base64.b64encode(open(path, "rb").read()).decode()
files = p["upload_files"]
assert 1 <= len(files) <= 4, "Muse nhận tối đa 4 ảnh tham chiếu"
body = {"model": "muse-image", "prompt": p["chatgpt_message"], "n": 1, "size": "9:16",
        "response_format": "url", "async": True, "image": [data_url(f, k) for k, f in enumerate(files, 1)]}
out = f"/tmp/autovideo-worker/sb-{job_id}-body.json"
open(out, "w").write(json.dumps(body, ensure_ascii=False))
print(out, round(os.path.getsize(out) / 1e6, 1), "MB")
PY
```

5. Gửi task, rồi ghi task id vào comment của cảnh:

```bash
JOB=42
SCENE=$(jq -r .scene_id /tmp/autovideo-worker/job-$JOB.json); ATT=$(jq -r .payload.attempt /tmp/autovideo-worker/job-$JOB.json); K=1   # K: lần tạo ảnh thứ mấy của job này
code=$(curl -sS -o /tmp/autovideo-worker/sb-$JOB-task.json -w '%{http_code}' -X POST "$MUSE/v1/images/generations" \
  -H "Authorization: Bearer $MKEY" -H 'Content-Type: application/json' --data-binary @/tmp/autovideo-worker/sb-$JOB-body.json)
echo "HTTP $code"; jq '{id, status, error}' /tmp/autovideo-worker/sb-$JOB-task.json
TASK=$(jq -r '.id // empty' /tmp/autovideo-worker/sb-$JOB-task.json)
[ -n "$TASK" ] && jq -n --argjson s "$SCENE" --arg b "[muse] storyboard lượt $ATT, lần $K: $TASK" '{scene_id:$s, body:$b}' \
  | curl -sS -o /dev/null -w 'comment HTTP %{http_code}\n' -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$API/api/worker/comments" -d @-
```

   HTTP khác 200 hoặc không có `id`: xử lý theo mục 6. Không POST lại khi chưa đọc mục đó.
6. Chờ bằng khối lệnh ở mục 5.3, với `KIND=images/generations` và `TASK` vừa nhận. Khi `status=succeeded`, ảnh nằm ở `result.data[0].url` (không phải `result.url`). URL này hết hạn sau 1 giờ và không được ký lại khi poll, nên khối dưới tải qua `/v1/media/<tên file>` kèm key; cách này dùng được trong 14 ngày Muse2API giữ file:

```bash
JOB=42
S=$(jq -r .payload.output.storyboard_path /tmp/autovideo-worker/job-$JOB.json)
NAME=$(jq -r '.result.data[0].url' /tmp/autovideo-worker/muse-$JOB-status.json | sed -E 's#^.*/v1/media/([^?]+).*$#\1#')
curl --fail-with-body -sS -H "Authorization: Bearer $MKEY" "$MUSE/v1/media/$NAME" -o /tmp/autovideo-worker/sb-$JOB-raw
mkdir -p "$(dirname "$S")"
ffmpeg -y -loglevel error -i /tmp/autovideo-worker/sb-$JOB-raw "$S"          # luôn lưu PNG đúng output.storyboard_path
ffprobe -v error -show_entries stream=width,height -of csv=p=0 "$S"         # tỉ lệ rộng/cao phải gần 0,5625 (9:16)
```

7. Kiểm tra ảnh bằng công cụ đọc ảnh, theo danh sách ở WORKER.md mục 4.2 bước 6: đúng 9:16, một khung, không chữ lạ, sản phẩm giống ảnh tham chiếu, đúng `first_frame_desc`. Ảnh chưa đạt thì được **tạo lại tối đa 2 lần nữa** (tổng 3 lần cho mỗi job).
   - Mỗi lần dựng lại body như bước 4.
   - Sau `chatgpt_message`, nối thêm một đoạn: `\n\nSửa so với lần trước: <lỗi cụ thể, ví dụ "nhãn trên hộp bị vẽ sai chữ, phải giữ đúng như ảnh 1">`.
   - Gửi như bước 5 với `K` tăng dần.
   - Mỗi lần tạo tốn hạn mức Muse, nên đừng tạo lại vì lỗi nhỏ có thể sửa khi dựng.
   - Ảnh mới không tốt hơn thì lưu ảnh tốt nhất vào `output.storyboard_path`.
8. `complete`:

```bash
JOB=42
S=$(jq -r .payload.output.storyboard_path /tmp/autovideo-worker/job-$JOB.json)
WH=$(ffprobe -v error -show_entries stream=width,height -of json "$S" | jq -c '{width:.streams[0].width, height:.streams[0].height}')
jq -n --arg path "$S" --argjson wh "$WH" --arg note 'Tạo qua Muse2API, 1 lần, đạt: đúng 9:16, nhãn hộp đúng.' --argjson tasks '["task_…"]' \
  '{result:{verdict:"pass", note:$note, provider:"muse2api", muse_task_ids:$tasks}, assets:[{kind:"storyboard", file_path:$path, meta:$wh}]}' \
| curl -sS -w '\nHTTP %{http_code}\n' -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    "$API/api/worker/jobs/$JOB/complete?worker=$W" -d @-
```

   `verdict` ∈ `pass` / `fix_in_edit` / `redo`. Sau 3 lần mà nhãn sản phẩm vẫn sai: lưu ảnh tốt nhất, `verdict:"redo"`, `note` nêu rõ lỗi.

## 5. Job `video`

Payload giống WORKER.md mục 4.3: `scene.prompt`, `upload_files` (storyboard ở cuối), `storyboard_path`, `output.video_path`, `output.grid_path`, `settings` (`9:16`, `10`, `count:1`, `720p`), `generator`, `requeued`.

**Trước tiên xem `payload.generator.provider`.** Là `"flow"` thì chuyển sang [WORKER-FLOW.md](WORKER-FLOW.md) ngay, không làm 5.1–5.4 dưới đây.

### 5.1 Kiểm tra

1. File `storyboard_path` tồn tại và `settings` đúng `9:16`, `10` giây, `count: 1`. Sai thì `fail` mã `UI_CHANGED`, mô tả cấu hình nhận được.
2. Nếu `requeued = true`: đọc mục 7 trước. Lưu ý quan trọng: **POST lại cùng key và cùng body không tạo video mới**, nên với video có thể làm tiếp bình thường từ 5.2.

3. **Gửi ảnh nào.** Video gửi **đủ `upload_files` đúng thứ tự** (ảnh sản phẩm trước, storyboard cuối cùng), giống cách upload lên Flow, để "image 1", "image 2" trong prompt khớp đúng ảnh. Trường `image` luôn là **danh sách**, kể cả khi chỉ có 1 ảnh.
   - `upload_files` có hơn 4 ảnh thì `fail` `OTHER` ("Muse nhận tối đa 4 ảnh cho video; giảm ảnh của cảnh này"), không tự bỏ ảnh. Muse2API cũng trả `400` cho danh sách trên 4 ảnh.
   - Đổi thứ tự ảnh cũng làm đổi body: gửi lại cùng key sẽ nhận `409`, xem 5.2.

### 5.2 Gửi task (đúng một lần cho mỗi job)

```bash
JOB=42
SCENE=$(jq -r .scene_id /tmp/autovideo-worker/job-$JOB.json)
python3 - "$JOB" <<'PY'
import base64, json, mimetypes, os, subprocess, sys
job_id = sys.argv[1]
p = json.load(open(f"/tmp/autovideo-worker/job-{job_id}.json"))["payload"]
def data_url(path, k):
    if os.path.getsize(path) > 5 * 1024 * 1024:
        # ffmpeg cho ra cùng byte với cùng file đầu vào, nên chạy lại vẫn ra đúng body cũ
        small = f"/tmp/autovideo-worker/vref-{job_id}-{k}.jpg"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", path, "-vf", "scale='min(2048,iw)':-2", "-q:v", "3", "-frames:v", "1", "-update", "1", "-map_metadata", "-1", small], check=True)
        path = small
    mime = mimetypes.guess_type(path)[0] or "image/png"
    assert mime in ("image/png", "image/jpeg", "image/webp"), f"định dạng ảnh không hỗ trợ: {path}"
    return f"data:{mime};base64," + base64.b64encode(open(path, "rb").read()).decode()
files = p["upload_files"]   # ảnh sản phẩm trước, storyboard cuối
assert 1 <= len(files) <= 4, "Muse nhận tối đa 4 ảnh cho video"
body = {"model": "muse-video", "prompt": p["scene"]["prompt"], "image": [data_url(f, k) for k, f in enumerate(files, 1)],
        "size": p["settings"]["aspect"], "duration": p["settings"]["duration_s"]}
# sort_keys + không đổi file ảnh: chạy lại cho ra đúng từng byte, nên idempotency key trả về task cũ
out = f"/tmp/autovideo-worker/video-{job_id}-body.json"
open(out, "w").write(json.dumps(body, ensure_ascii=False, sort_keys=True))
assert os.path.getsize(out) < 30 * 1024 * 1024, "body vượt 30 MiB"
print(len(files), "ảnh:", ", ".join(files), "·", round(os.path.getsize(out) / 1e6, 1), "MB")
PY
code=$(curl -sS -o /tmp/autovideo-worker/video-$JOB-task.json -w '%{http_code}' -X POST "$MUSE/v1/videos" \
  -H "Authorization: Bearer $MKEY" -H 'Content-Type: application/json' -H "Idempotency-Key: autovideo-video-$JOB" \
  --data-binary @/tmp/autovideo-worker/video-$JOB-body.json)
echo "HTTP $code"; jq '{id, status, stage, error}' /tmp/autovideo-worker/video-$JOB-task.json
TASK=$(jq -r '.id // empty' /tmp/autovideo-worker/video-$JOB-task.json)
[ -n "$TASK" ] && jq -n --argjson s "$SCENE" --arg b "[muse] video job $JOB: $TASK (key autovideo-video-$JOB)" '{scene_id:$s, body:$b}' \
  | curl -sS -o /dev/null -w 'comment HTTP %{http_code}\n' -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$API/api/worker/comments" -d @-
```

- `HTTP 200` + `id`: đã nhận (có thể là task cũ, nếu key đã dùng). Sang 5.3.
- Lỗi mạng hoặc `000`: chạy lại **đúng khối lệnh này**. Cùng key và cùng body nên không tạo video thứ hai.
- `409`: cùng key nhưng body khác, nghĩa là ảnh, thứ tự ảnh hoặc prompt đã đổi so với lần gửi trước. **Không đổi key.** `fail` mã `OTHER`: "Muse báo trùng idempotency key với nội dung khác; kiểm tra task cũ trên dashboard Muse2API".
- Lỗi khác: mục 6.

### 5.3 Chờ kết quả (dùng chung cho ảnh và video)

Khối này poll mỗi 5 giây, heartbeat job mỗi 60 giây, và dừng sau 9 phút để không vượt giới hạn thời gian của một lệnh. Hết 9 phút mà task còn `queued`/`running` thì **chạy lại khối này**, không POST lại. Tổng thời gian chờ video tối đa 20 phút.

```bash
API=http://127.0.0.1:8787; TOKEN=$(sed -n 's/^WORKER_TOKEN=//p' .env); W=codex-1
MUSE=http://127.0.0.1:18610; MKEY=$(cat /Users/thainv/code/muse/muse2api/data/api_key)
JOB=42; TASK=task_xxx; KIND=videos        # KIND=videos cho video, images/generations cho ảnh
OUT=/tmp/autovideo-worker/muse-$JOB-status.json
last_hb=0; prev=""; end=$(( $(date +%s) + 540 ))
while :; do
  now=$(date +%s)
  if [ $((now - last_hb)) -ge 60 ]; then
    hb=$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" "$API/api/worker/jobs/$JOB/heartbeat?worker=$W")
    [ "$hb" = 409 ] && { echo "HEARTBEAT 409: job đã bị hủy/trả về; dừng job này"; break; }
    last_hb=$now
  fi
  code=$(curl -sS -o "$OUT" -w '%{http_code}' -H "Authorization: Bearer $MKEY" "$MUSE/v1/$KIND/$TASK")
  st=$(jq -r '.status // empty' "$OUT" 2>/dev/null); stage=$(jq -r '.stage // ""' "$OUT" 2>/dev/null)
  [ "$st/$stage" != "$prev" ] && echo "$(date +%T) HTTP $code status=$st stage=$stage" && prev="$st/$stage"
  case "$code" in 401|404) echo "Lỗi HTTP $code: $(jq -c .error "$OUT")"; break;; 429) sleep 15;; esac
  case "$st" in succeeded|failed|cancelled|unknown) break;; esac
  [ "$now" -ge "$end" ] && { echo "Đã chờ 9 phút: chạy lại khối này để chờ tiếp (KHÔNG POST lại)"; break; }
  sleep 5
done
# Không in signed URL: bỏ result.url (video) và result.data[].url (ảnh)
jq '{status, stage, progress, error, result: (.result | if . == null then null else (del(.url) | if .data then .data |= map(del(.url)) else . end) end)}' "$OUT"
```

`status=failed`, `cancelled` hoặc `unknown`: xem mục 6.

### 5.4 Tải video và kiểm tra

Chỉ tải khi `status=succeeded`. Muse2API đã kiểm tra file bằng ffprobe trước khi báo `succeeded`. Khối dưới tải qua `/v1/media/<result.media_name>` kèm key, không phụ thuộc chữ ký của `result.url`.

```bash
JOB=42
V=$(jq -r .payload.output.video_path /tmp/autovideo-worker/job-$JOB.json)
N=$(jq '.payload.upload_files | length' /tmp/autovideo-worker/job-$JOB.json)
OUT=/tmp/autovideo-worker/muse-$JOB-status.json
jq -e '.status=="succeeded" and .result.synthetic==false' "$OUT" >/dev/null || { echo "Chưa xong hoặc là kết quả giả (driver mock): KHÔNG dùng"; exit 1; }
echo "Muse nhận $(jq -r '.requested.reference_image_count // "?"' "$OUT")/$N ảnh"
mkdir -p "$(dirname "$V")"
curl --fail-with-body -sS -H "Authorization: Bearer $MKEY" "$MUSE/v1/media/$(jq -r .result.media_name "$OUT")" -o "$V.part" && mv "$V.part" "$V"
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,codec_name:format=duration -of default=noprint_wrappers=1 "$V"
```

- `result.synthetic == true` nghĩa là Muse2API đang chạy driver `mock`. `fail` mã `OTHER`, báo người dùng.
- Số ảnh Muse nhận khác `N`: vẫn kiểm tra chất lượng như bình thường, nhưng ghi lệch số ảnh vào `verdict_note`.
- Kỳ vọng video dọc (cao > rộng), khoảng 10 giây.
  - Muse trả video ngang (ví dụ 1280×720): ghi kích thước thật vào `verdict_note`, kết luận theo chất lượng như bình thường. **Không tạo lại.**
  - Độ dài lệch nhiều so với 10 giây: ghi vào `verdict_note`.

### 5.5 Lưới khung hình, kiểm tra chất lượng, kết luận

Làm đúng WORKER.md mục 4.3, bước 9 đến 11:
- Tách lưới vào `output.grid_path` bằng đúng lệnh `fps=2,scale=270:-2,tile=5x4`.
- Xem lưới, đối chiếu `scene.prompt` và danh sách kiểm tra.
- Kết luận `pass` / `fix_in_edit` / `redo`.
- Gặp `redo` thì thêm comment chẩn đoán.

Video ngang thì lưới cũng ngang, không sao.

### 5.6 Hoàn thành

```bash
API=http://127.0.0.1:8787; TOKEN=$(sed -n 's/^WORKER_TOKEN=//p' .env); W=codex-1
JOB=42
V=$(jq -r .payload.output.video_path /tmp/autovideo-worker/job-$JOB.json)
G=$(jq -r .payload.output.grid_path /tmp/autovideo-worker/job-$JOB.json)
OUT=/tmp/autovideo-worker/muse-$JOB-status.json
META=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height:format=duration -of json "$V" \
  | jq -c '{width:.streams[0].width, height:.streams[0].height, duration_s:(.format.duration|tonumber|.*100|round/100)}')
GWH=$(ffprobe -v error -show_entries stream=width,height -of json "$G" | jq -c '{width:.streams[0].width, height:.streams[0].height}')
jq -n --arg v "$V" --arg g "$G" --argjson meta "$META" --argjson gwh "$GWH" \
  --arg task "$(jq -r .id "$OUT")" --arg note 'Tạo qua Muse2API (ảnh sản phẩm + storyboard). Sản phẩm đúng, rót nước đúng giây 3–5; xem qua lưới 2 khung/giây.' \
  '{result:{verdict:"pass", verdict_note:$note, provider:"muse2api", muse_task_id:$task},
    assets:[{kind:"video", file_path:$v, meta:$meta}, {kind:"grid", file_path:$g, meta:$gwh}]}' \
| curl -sS -w '\nHTTP %{http_code}\n' -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    "$API/api/worker/jobs/$JOB/complete?worker=$W" -d @-
```

Thay `verdict`/`verdict_note` theo kết luận thật. Xong là xong: dù `redo` cũng **không tạo lại**.

## 6. Lỗi và cách xử lý

| Gặp | Xử lý |
|---|---|
| Muse2API không kết nối được, `readyz` khác 200 | Chưa gửi task: `fail` `OTHER` "Muse2API không chạy". Đã gửi task: chờ 1 phút rồi poll lại; vẫn không được thì `fail` `OTHER`, ghi task id |
| HTTP `401 invalid_api_key` | Đọc lại `data/api_key`. Vẫn lỗi thì `fail` `OTHER` và dừng vòng lặp |
| HTTP `400 invalid_request` | Đọc `error.message` (ảnh sai định dạng, prompt rỗng…). Sửa được phía mình thì sửa rồi gửi lại; không thì `fail` `OTHER` |
| HTTP `413 request_too_large` | Khối lệnh ở mục 4 và 5.2 đã thu nhỏ ảnh trên 5 MB nên hiếm gặp. Vẫn gặp thì `fail` `OTHER` ("ảnh tham chiếu quá lớn"), báo người dùng giảm ảnh; không tự đổi body video |
| HTTP `429 rate_limited` | Chờ theo `Retry-After`, giảm tần suất poll |
| HTTP `404 not_found` khi poll hoặc tải | Poll bằng đúng key đã tạo task (`data/api_key`). File media bị xoá sau 14 ngày. Không POST lại; `fail` `OTHER`, ghi task id |
| HTTP `503 no_account_available` | Nếu còn task Muse khác của mình đang `queued`/`running` (tài khoản chạy một task một lúc): chờ task đó xong rồi gửi lại, vì lần đó chưa gửi prompt lên Muse. Với ảnh async, lỗi này có thể nằm trong `task.error` của task vừa tạo. Nếu không: tài khoản bị tắt, đang cooldown, hoặc bị giữ bởi task `unknown`. `fail` mã **`LOGIN_REQUIRED`** (hàng đợi tạm dừng), nhắn người dùng mở dashboard Muse2API |
| `error.code` `upstream_auth_failed` | Hết phiên đăng nhập Muse: `fail` mã **`LOGIN_REQUIRED`**, nhắn người dùng nhập lại session qua dashboard |
| `error.code` `upstream_access_denied` | Muse cần xác minh thủ công: `fail` mã **`CAPTCHA`** |
| `error.code` `upstream_quota_exhausted` | Hết hạn mức Muse. Job video: `fail` mã **`FLOW_OUT_OF_CREDIT`** (web hiện "Hết hạn mức tạo video"). Job storyboard: `fail` `OTHER`, ghi "hết hạn mức Muse", rồi **dừng vòng lặp** và nhắn người dùng |
| `error.message` `failed to attach all reference images` hoặc `Reference image upload was not confirmed` | Muse2API không xác nhận được ảnh tham chiếu đã đính, **prompt chưa được gửi** nên không tốn lượt. Đây là lỗi phía Muse2API (đính ảnh), không phải do ảnh của job. `fail` `OTHER`, ghi task id, rồi **dừng vòng lặp** và báo người dùng kiểm tra Muse2API; không thử lại job khác cho tới khi Muse2API được sửa |
| `error.code` `upstream_refused` | Muse từ chối (nội dung, độ dài…): `fail` `OTHER`, chép nguyên `error.message` |
| `error.code` `invalid_media` | Muse ra file hỏng: `fail` `OTHER` |
| `status=unknown` hoặc `error.code` `submission_unknown` | Muse **có thể vẫn đang tạo**. Không POST lại. `fail` `OTHER` "Muse chưa rõ kết quả task <id>; kiểm tra trên dashboard Muse2API trước khi tạo lại" |
| `status=failed` (lỗi khác) / `cancelled` | `fail` `OTHER`, ghi task id và `error.message`. Không tự retry. Lỗi upstream nằm trong `task.error` dù HTTP là 200, nên luôn đọc `status` |
| POST ảnh bị timeout hoặc mất mạng, không có task id | **Không gửi lại ngay** (có thể đã tạo task). Mở `http://127.0.0.1:18610/dashboard` hoặc nhờ người dùng xem có task ảnh mới không. Không xác định được thì `fail` `OTHER` |
| Quá 20 phút chưa xong video | `fail` `OTHER` "Muse task <id> chưa xong sau 20 phút; có thể vẫn đang chạy". Lần sau người dùng tạo lại (job mới) thì kiểm tra task cũ trước |

Mã `fail` vẫn chỉ gồm `CAPTCHA`, `LOGIN_REQUIRED`, `FLOW_OUT_OF_CREDIT`, `UI_CHANGED`, `OTHER` như WORKER.md mục 2.4. Ba mã `CAPTCHA`, `LOGIN_REQUIRED`, `FLOW_OUT_OF_CREDIT` làm hàng đợi tạm dừng: dừng vòng lặp và chờ người dùng. `fail` job video **không gửi `credits_cost`** và mặc định không gửi `attempt_used` (lần lỗi không chiếm lượt của cảnh).

## 7. Job bị trả về hàng đợi (`payload.requeued = true`)

- **`video`:**
  1. Kiểm tra `output.video_path`. Đã có file hợp lệ thì làm tiếp từ 5.5.
  2. Chưa có thì chạy lại 5.2 y nguyên. Cùng key `autovideo-video-<job.id>` và cùng body nên Muse2API trả về task cũ, nếu có, rồi chờ và tải như bình thường. **Không đổi key.**
  3. Nhận `409` thì làm như mục 5.2.
- **`storyboard`:**
  1. Kiểm tra `output.storyboard_path` đã có ảnh chưa.
  2. Đọc comment của cảnh (`GET /api/scenes/<scene_id>`, tìm dòng `[muse] storyboard lượt <attempt>`) để lấy task id cũ, rồi poll task đó (mục 5.3 với `KIND=images/generations`).
     - `succeeded`: tải và dùng.
     - Còn `queued`/`running`: chờ tiếp.
     - `failed`: mới được tạo task mới.
     - Không tìm thấy task id: tạo mới.

## 8. Tóm tắt

```
kiểm tra Muse (1) → next?types=storyboard,video → heartbeat
  storyboard/video có generator.provider = "flow" → WORKER-FLOW.md (Flow2API, không gửi lại cùng lượt; ảnh: server tự xoá logo)
  storyboard: body (≤4 ảnh, async) → POST ảnh → comment task id → chờ (5.3) → tải → PNG → kiểm tra → [tạo lại ≤2] → complete
  video:      body (ảnh sản phẩm + storyboard, prompt nguyên văn) → POST /v1/videos với key autovideo-video-<job> → comment → chờ (5.3) → tải → lưới → kết luận → complete
lỗi → bảng mục 6
```

Trước `complete`, kiểm tra lại:
- File nằm đúng `output.*`.
- Video có kèm lưới.
- `verdict` hợp lệ.
- `result` có `provider:"muse2api"` và task id.
- Không in key/token ra đâu.
- Mỗi job video chỉ có đúng một idempotency key.
