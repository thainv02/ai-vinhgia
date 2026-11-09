# WORKER-FLOW: tạo storyboard và video qua Flow2API (Google Flow)

Người dùng chọn dịch vụ trên web: video chọn khi bấm «Tạo video», ảnh storyboard chọn trong «Cài đặt dự án». Job có `payload.generator.provider = "flow"` thì làm theo file này:
- **Job `video`**: mục 1–7, **thay cho mục 5 (5.1–5.4) của [WORKER-MUSE.md](WORKER-MUSE.md)**.
- **Job `storyboard`**: mục 9, **thay cho mục 4 (bước 4–6) của WORKER-MUSE.md**.

Job có `provider = "muse"` (hoặc không có `generator`) vẫn làm theo WORKER-MUSE.md.

**Ai dùng file này.** Worker nền `media-api-1` (`npm run worker:media`) cài đặt đúng các luật dưới đây và làm mọi job Flow từ 05/11/2026; nó còn tự chờ và gửi lại khi tài khoản Flow2API lỗi trước lúc Flow nhận lệnh, xem [docs/ai/OPERATIONS.md](docs/ai/OPERATIONS.md) mục Worker nền ảnh/video. Các khối lệnh bên dưới dành cho vòng lặp tay của Codex/Claude, chỉ chạy khi người dùng yêu cầu.

Mọi thứ còn lại giữ nguyên như WORKER-MUSE.md: điều kiện chung (mục 1), biến (mục 2), cách nhận job (`types=storyboard,video`), heartbeat, lưới khung hình và kết luận (5.5), cách `complete` (5.6).

**Mã lượt gửi `R`.** Mọi file tạm của một lần gửi đặt tên theo `R`: job video dùng `R=<job.id>`; job storyboard dùng `R=<job.id>-k<lần>` (mỗi lần tạo ảnh một `R` mới). Các khối ở mục 3–4 dùng chung cho cả hai loại job.

Tài liệu gốc của API: `/Users/thainv/code/muse/flow2api/API_GUIDE_VI.md`. Tài liệu đó có chứa API key: **không chép, không in key ra chat/log/comment**. Key đã được đặt sẵn trong `.env` của autovideo (`FLOW2API_KEY`).

## 0. Hiện trạng (đọc trước)

| Hạng mục | Trạng thái |
|---|---|
Đối chiếu lịch sử job của `media-api-1` ngày 09/11/2026.

| Hạng mục | Trạng thái |
|---|---|
| Flow2API | Container `flow2api-local-flow2api-1`, `http://127.0.0.1:8020` (trang quản lý `/manage`), API kiểu OpenAI Chat Completions + SSE. Hai tài khoản Google, cookie do extension Token Updater đồng bộ từ Chrome của chủ máy |
| `omni-1.1-flash-10s-portrait` + ảnh (Omni, 10 giây, 15 credit) | **Dùng thật hằng ngày**: 29 video xong, 3 lỗi (từ 05/11/2026) |
| `gemini-3.1-flash-image-portrait` (ảnh storyboard, mục 9) | **Dùng thật hằng ngày**: 37 ảnh xong, 11 lỗi (phần lớn do tài khoản/CAPTCHA của Flow2API) |
| Xoá logo Gemini trên ảnh (server, khi `complete`) | Chạy thật trên mọi storyboard Flow |
| `veo-3.1-fast-r2v-8s-portrait` (Veo 3.1 Fast, 8 giây, 20 credit Flow) | Flow2API đã thử thật; chưa dùng qua autovideo |
| `veo-3.1-lite-r2v-8s-portrait` (Veo 3.1 Lite, 8 giây, 10 credit) | Suy ra từ bản landscape, chưa thử |

Model chưa dùng qua autovideo (Veo Fast/Lite): lượt đầu nên có người xem kết quả trên web trước khi chạy hàng loạt.

Khác biệt quan trọng so với Muse:
- **Không có idempotency.** Mỗi POST thành công là một video mới và **trừ credit Google Flow**. Mất kết nối giữa chừng thì video có thể vẫn đang được tạo. Vì vậy mỗi job **chỉ POST đúng một lần**, kể cả khi lỗi mạng.
- Kết quả trả về theo stream SSE trên chính kết nối POST (không có task id để poll lại). Lệnh POST chạy nền và ghi stream vào file; các khối lệnh sau chỉ đọc file đó.
- Tối đa **3 ảnh** (server autovideo đã chặn khi duyệt). Độ dài nằm trong tên model, không có tham số `size`/`duration`.
- URL video là link tạm của Google: tải về **ngay** khi có, **không** gửi API key khi tải.

## 1. Kiểm tra trước khi gửi (không tốn credit)

```bash
API=http://127.0.0.1:8787; TOKEN=$(sed -n 's/^WORKER_TOKEN=//p' .env); W=codex-1
FLOW=$(sed -n 's/^FLOW2API_URL=//p' .env); FKEY=$(sed -n 's/^FLOW2API_KEY=//p' .env)
JOB=42
MODEL=$(jq -r .payload.generator.model /tmp/autovideo-worker/job-$JOB.json)
[ -n "$FLOW" ] && [ -n "$FKEY" ] || echo "THIẾU FLOW2API_URL/FLOW2API_KEY trong .env"
curl -sS -o /dev/null -w 'flow2api HTTP %{http_code}\n' "$FLOW/"
curl -sS -H "Authorization: Bearer $FKEY" "$FLOW/v1/models" | jq -r --arg m "$MODEL" '[.data[].id] | if index($m) then "model OK: \($m)" else "THIẾU MODEL \($m)" end'
```

- Thiếu biến trong `.env`, Flow2API không trả 200, hoặc thiếu model: chưa gửi gì, `fail` mã `OTHER` ("Flow2API chưa sẵn sàng: …") rồi báo người dùng. **Không tự sửa `.env`.**
- `settings` phải là `9:16`, `count: 1`, `duration_s` khớp model (8 với Veo, 10 với Omni). Sai thì `fail` `UI_CHANGED`.
- `upload_files` có hơn 3 file thì `fail` `OTHER` ("Google Flow nhận tối đa 3 ảnh"). Không tự bỏ ảnh.
- Nếu `payload.requeued = true`: đọc mục 6 **trước** khi làm tiếp.

## 2. Dựng body

Prompt gửi **nguyên văn** `payload.scene.prompt` (luật 6 của WORKER.md), kể cả khi prompt viết cho 10 giây mà model chỉ tạo 8 giây. Ảnh gửi đủ `upload_files` đúng thứ tự (ảnh sản phẩm trước, storyboard cuối) để "image 1", "image 2" trong prompt khớp. Flow2API chỉ nhận PNG/JPEG: ảnh định dạng khác được chuyển sang PNG, ảnh lớn hơn 5 MB được thu nhỏ.

```bash
JOB=42
python3 - "$JOB" <<'PY'
import base64, json, mimetypes, os, subprocess, sys
job_id = sys.argv[1]
p = json.load(open(f"/tmp/autovideo-worker/job-{job_id}.json"))["payload"]
def data_url(path, k):
    mime = mimetypes.guess_type(path)[0]
    if os.path.getsize(path) > 5 * 1024 * 1024 or mime not in ("image/png", "image/jpeg"):
        big = os.path.getsize(path) > 5 * 1024 * 1024
        out = f"/tmp/autovideo-worker/fref-{job_id}-{k}.{'jpg' if big else 'png'}"
        args = ["ffmpeg", "-y", "-loglevel", "error", "-i", path, "-frames:v", "1", "-update", "1", "-map_metadata", "-1"]
        args += ["-vf", "scale='min(2048,iw)':-2", "-q:v", "3"] if big else []
        subprocess.run(args + [out], check=True)
        path, mime = out, ("image/jpeg" if big else "image/png")
    return f"data:{mime};base64," + base64.b64encode(open(path, "rb").read()).decode()
files = p["upload_files"]
assert 1 <= len(files) <= 3, "Google Flow nhận tối đa 3 ảnh"
content = [{"type": "text", "text": p["scene"]["prompt"]}]
content += [{"type": "image_url", "image_url": {"url": data_url(f, k)}} for k, f in enumerate(files, 1)]
body = {"model": p["generator"]["model"], "messages": [{"role": "user", "content": content}], "stream": True}
out = f"/tmp/autovideo-worker/flow-{job_id}-body.json"
open(out, "w").write(json.dumps(body, ensure_ascii=False))
print(p["generator"]["model"], "·", len(files), "ảnh:", ", ".join(files), "·", round(os.path.getsize(out) / 1e6, 1), "MB")
PY
```

## 3. Gửi (đúng một lần cho mỗi job)

Khối này tự từ chối nếu job đã từng được gửi trên máy này (file `flow-<job>.sse` đã có). Nó ghi comment vào cảnh **trước** khi gửi, rồi chạy POST ở nền: stream ghi vào `flow-<job>.sse`, mã thoát của curl ghi vào `flow-<job>.exit` khi kết thúc. Tiến trình nền vẫn chạy khi lệnh shell này kết thúc.

```bash
API=http://127.0.0.1:8787; TOKEN=$(sed -n 's/^WORKER_TOKEN=//p' .env)
FLOW=$(sed -n 's/^FLOW2API_URL=//p' .env); export FKEY=$(sed -n 's/^FLOW2API_KEY=//p' .env)
JOB=42; R=$JOB          # storyboard: R=$JOB-k1, $JOB-k2…
D=/tmp/autovideo-worker
SCENE=$(jq -r .scene_id $D/job-$JOB.json); MODEL=$(jq -r .payload.generator.model $D/job-$JOB.json); TYPE=$(jq -r .type $D/job-$JOB.json)
if [ -e $D/flow-$R.sse ]; then echo "Lượt $R ĐÃ GỬI trước đó: KHÔNG gửi lại, xem mục 6"
elif [ ! -s $D/flow-$R-body.json ]; then echo "Chưa có body flow-$R-body.json: dựng body trước"; else
  jq -n --argjson s "$SCENE" --arg b "[flow] $TYPE job $JOB, lượt $R: gửi lúc $(date '+%F %T'), model $MODEL" '{scene_id:$s, body:$b}' \
    | curl -sS -o /dev/null -w 'comment HTTP %{http_code}\n' -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$API/api/worker/comments" -d @-
  : > $D/flow-$R.sse
  export FLOW D R
  nohup sh -c 'curl -sS -N --max-time 1600 -X POST "$FLOW/v1/chat/completions" \
      -H "Authorization: Bearer $FKEY" -H "Content-Type: application/json" \
      --data-binary @"$D/flow-$R-body.json" -D "$D/flow-$R.hdr" >> "$D/flow-$R.sse" 2> "$D/flow-$R.err"; \
    echo $? > "$D/flow-$R.exit"' > /dev/null 2>&1 &
  echo "Đã gửi lượt $R ở nền; chờ bằng khối mục 4"
fi
```

Sau khối này **không bao giờ** chạy lại POST cho cùng `R`, kể cả khi lỗi. Video: mỗi job đúng một `R`. Mọi tình huống xử lý theo mục 4–6 (storyboard: mục 9).

## 4. Chờ kết quả

Khối này đọc file stream, heartbeat job mỗi 60 giây, và dừng sau 9 phút. Hết 9 phút mà curl chưa kết thúc (chưa có file `.exit`) thì **chạy lại khối này**, không gửi lại. Video thường xong sau 1–2 phút; curl tự dừng sau 1600 giây.

```bash
API=http://127.0.0.1:8787; TOKEN=$(sed -n 's/^WORKER_TOKEN=//p' .env); W=codex-1
JOB=42; R=$JOB; D=/tmp/autovideo-worker
[ -e $D/flow-$R.sse ] || { echo "Lượt $R chưa được gửi trên máy này: xem mục 6"; exit 1; }
last_hb=0; end=$(( $(date +%s) + 540 )); prev=""
while [ ! -e $D/flow-$R.exit ]; do
  now=$(date +%s)
  if [ $((now - last_hb)) -ge 60 ]; then
    hb=$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" "$API/api/worker/jobs/$JOB/heartbeat?worker=$W")
    [ "$hb" = 409 ] && { echo "HEARTBEAT 409: job đã bị hủy/trả về. Video Flow có thể vẫn đang tạo; dừng job này và báo người dùng"; break; }
    last_hb=$now
  fi
  pct=$(grep -o '[0-9]\{1,3\}%' $D/flow-$R.sse 2>/dev/null | tail -1)
  [ "$pct" != "$prev" ] && echo "$(date +%T) tiến độ ${pct:-?}" && prev="$pct"
  [ "$now" -ge "$end" ] && { echo "Đã chờ 9 phút: chạy lại khối này (KHÔNG gửi lại)"; break; }
  sleep 5
done
[ -e $D/flow-$R.exit ] && echo "curl kết thúc, mã $(cat $D/flow-$R.exit), HTTP $(head -1 $D/flow-$R.hdr 2>/dev/null | tr -d '\r')"
```

Khi curl đã kết thúc, đọc kết quả. Khối dưới lấy URL video (`<video src=…>`) hoặc URL ảnh (`![…](…)`) và **không in URL** (link có chữ ký), chỉ báo có hay không:

```bash
JOB=42; R=$JOB; D=/tmp/autovideo-worker
python3 - "$R" <<'PY'
import json, re, sys
job = sys.argv[1]   # mã lượt R
d = "/tmp/autovideo-worker"
text, error, done = [], None, False
for line in open(f"{d}/flow-{job}.sse", encoding="utf-8", errors="replace"):
    line = line.strip()
    if not line.startswith("data:"):
        if line.startswith("{") and '"error"' in line:  # lỗi trả về không theo SSE
            try: error = json.loads(line).get("error")
            except ValueError: pass
        continue
    data = line[5:].strip()
    if data == "[DONE]":
        done = True
        continue
    try:
        ev = json.loads(data)
    except ValueError:
        continue
    if "error" in ev:
        error = ev["error"]
    for c in ev.get("choices", []):
        text.append((c.get("delta") or {}).get("content") or (c.get("message") or {}).get("content") or "")
joined = "".join(text)
m = re.search(r"<video\b[^>]*\bsrc=['\"]([^'\"]+)['\"]", joined) or re.search(r"!\[[^\]]*\]\((\S+?)\)", joined)
url = m.group(1).replace("&amp;", "&") if m else None
exit_code = open(f"{d}/flow-{job}.exit").read().strip()
json.dump({"url": url, "error": error, "done": done, "exit": exit_code}, open(f"{d}/flow-{job}-result.json", "w"), ensure_ascii=False)
print(json.dumps({"co_url": bool(url), "done": done, "curl_exit": exit_code, "error": error,
                  "cuoi_stream": re.sub(r"(https?://|data:)[^\s)'\"]+", "<url>", joined)[-300:]}, ensure_ascii=False, indent=1))
PY
```

- Có URL (`co_url: true`): video sang mục 5 ngay; storyboard sang mục 9 bước 5.
- Có `error`, hoặc không có URL: xem mục 7.
- `curl_exit` khác 0 mà không có URL và không có `error`: kết nối đứt hoặc hết thời gian. Video có thể vẫn đang được tạo và đã trừ credit. **Không gửi lại**: mục 7.

## 5. Tải video và kiểm tra

```bash
JOB=42; R=$JOB; D=/tmp/autovideo-worker
V=$(jq -r .payload.output.video_path $D/job-$JOB.json)
URL=$(jq -r '.url // empty' $D/flow-$R-result.json)
[ -n "$URL" ] || { echo "Không có URL video"; exit 1; }
mkdir -p "$(dirname "$V")"
curl --fail -sS -L --max-time 300 "$URL" -o "$V.part" && mv "$V.part" "$V"    # KHÔNG gửi Authorization tới Google
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,codec_name:format=duration -of default=noprint_wrappers=1 "$V"
```

- Tải lỗi: chạy lại đúng khối này một lần. Vẫn lỗi (link hết hạn) thì `fail` `OTHER` "Đã tạo video trên Flow nhưng không tải được; mở Google Flow của tài khoản Flow2API để tải tay". **Không gửi lại POST.**
- Kỳ vọng video dọc (cao > rộng), độ dài khoảng `settings.duration_s`. Lệch thì ghi vào `verdict_note`, không tạo lại.

Sau đó làm **WORKER-MUSE.md mục 5.5 và 5.6** (lưới, kết luận, `complete`), với hai khác biệt trong `result`:
- `provider:"flow2api"`, thêm `model` (lấy từ `payload.generator.model`), không có `muse_task_id`.
- `verdict_note` nói rõ "Tạo qua Google Flow (<label>)".

```bash
# thay cho dòng jq -n … trong khối 5.6 của WORKER-MUSE.md
jq -n --arg v "$V" --arg g "$G" --argjson meta "$META" --argjson gwh "$GWH" \
  --arg model "$(jq -r .payload.generator.model /tmp/autovideo-worker/job-$JOB.json)" \
  --arg note 'Tạo qua Google Flow (Veo 3.1 Fast). Sản phẩm đúng; xem qua lưới 2 khung/giây.' \
  '{result:{verdict:"pass", verdict_note:$note, provider:"flow2api", model:$model},
    assets:[{kind:"video", file_path:$v, meta:$meta}, {kind:"grid", file_path:$g, meta:$gwh}]}'
```

## 6. Job bị trả về hàng đợi (`payload.requeued = true`) hoặc làm tiếp sau khi gián đoạn

Kiểm tra theo thứ tự, dừng ở bước đầu tiên khớp:

1. `output.video_path` đã có file video hợp lệ: làm tiếp từ lưới (WORKER-MUSE.md 5.5).
2. Có `flow-<job>-result.json` chứa URL: tải (mục 5).
3. Có `flow-<job>.sse` mà chưa có `flow-<job>.exit`, và tiến trình curl còn chạy (`pgrep -f "flow-$JOB-body.json"` có kết quả): chờ tiếp (mục 4).
4. Có `flow-<job>.exit`: đọc kết quả (khối thứ hai mục 4).
5. Có `flow-<job>.sse` nhưng curl không còn chạy và không có `.exit` (máy khởi động lại giữa chừng), **hoặc** cảnh đã có comment `[flow] video job <job.id>, lượt …` mà không có file trên máy này: **không gửi lại**. `fail` `OTHER` "Đã gửi job <id> lên Google Flow nhưng không rõ kết quả; kiểm tra trên Google Flow trước khi tạo lại".
6. Không có gì ở trên: job chưa từng gửi, làm bình thường từ mục 1.

Comment của cảnh đọc ở `GET /api/scenes/<scene_id>` (trường `comments`).

## 7. Lỗi và cách xử lý

Lỗi Flow2API nằm trong sự kiện `error` của stream (HTTP vẫn 200), hoặc trong body khi HTTP khác 200 (xem `flow-<job>.hdr`).

| Gặp | Xử lý |
|---|---|
| HTTP `401` từ Flow2API (key sai), chưa có stream | Key trong `.env` không đúng. `fail` `OTHER` "Flow2API từ chối API key" và dừng vòng lặp |
| `MODEL_ACCESS_DENIED` | Tài khoản Flow không được dùng model này. `fail` `OTHER`, chép nguyên thông điệp, gợi ý người dùng chọn dịch vụ khác khi tạo lại |
| `登录认证失败` hoặc `code=401` trong `error.message` | Phiên Google của Flow2API hết hạn. `fail` **`LOGIN_REQUIRED`** (hàng đợi tạm dừng), nhắn người dùng đăng nhập lại Flow2API |
| `没有可用的Token` hoặc `status_code` 503 | Tài khoản Flow bị tắt, hết hạn hoặc hết quota. Thông điệp có nhắc quota/credit thì `fail` **`FLOW_OUT_OF_CREDIT`**, không thì **`LOGIN_REQUIRED`**. Dừng vòng lặp, không thử lại |
| Thông điệp nhắc `captcha` / `recaptcha` | `fail` **`CAPTCHA`** |
| Stream đứt, hết 1600 giây, `curl_exit` khác 0 mà không có URL | Video **có thể vẫn đang được tạo và đã trừ credit**. `fail` `OTHER` "Flow chưa trả kết quả cho job <id>; kiểm tra Google Flow trước khi tạo lại". Không gửi lại |
| Stream xong (`[DONE]`) nhưng không có `<video src=…>` | `fail` `OTHER`, chép 300 ký tự cuối của stream (đã che URL) |
| Lỗi khác trong `error.message` | `fail` `OTHER`, chép nguyên thông điệp. Không tự retry |

Ba mã `CAPTCHA`, `LOGIN_REQUIRED`, `FLOW_OUT_OF_CREDIT` làm hàng đợi tạm dừng: dừng vòng lặp và chờ người dùng. `fail` không gửi `credits_cost`, mặc định không gửi `attempt_used`.

## 8. Tóm tắt

```
job video, payload.generator.provider = "flow":
  kiểm tra (1) → body ≤3 ảnh, prompt nguyên văn (2) → comment + POST nền, đúng 1 lần (3)
  → chờ file stream (4) → tải URL ngay, không kèm key (5) → lưới + kết luận + complete (WORKER-MUSE 5.5–5.6)
job storyboard, payload.generator.provider = "flow":
  body ≤4 ảnh, chatgpt_message nguyên văn (9.3) → gửi/chờ/đọc như mục 3–4 với R=<job>-k<lần>
  → tải, lưu PNG (9.5) → kiểm tra, KHÔNG tự xoá logo (9.6) → complete: server tự xoá logo Gemini (9.7)
lỗi → bảng mục 7 · requeued → mục 6 / 9.8 · không bao giờ POST lại cùng R
```

## 9. Job `storyboard` qua Google Flow

Payload giống WORKER-MUSE.md mục 4 (`upload_files`, `chatgpt_message`, `attempt`, `output.storyboard_path`, `requeued`), thêm `generator` với `provider:"flow"`, `model` (vd `gemini-3.1-flash-image-portrait`, khung dọc nằm trong tên model) và `remove_logo:true`.

**Ảnh Google Flow có logo Gemini (ngôi sao bốn cánh ở góc dưới phải). Worker KHÔNG tự xoá logo và không tạo lại ảnh vì logo.** Khi worker gọi `complete`, server tự chạy tool xoá logo trên ảnh ở `output.storyboard_path`, giữ ảnh gốc cạnh đó (`…_raw_j<job>.png`) và ghi kết quả vào `meta.logo` của asset. Ảnh mang đi tạo video là bản đã xoá logo. Xoá lỗi thì giao diện báo «Còn logo» và có nút «Xoá logo lại».

### 9.1 Kiểm tra

Chạy khối kiểm tra ở mục 1 (Flow2API sống, có model). Rồi:
- Mọi file trong `upload_files` tồn tại; thiếu thì `fail` `OTHER`.
- `upload_files` có hơn 4 file thì `fail` `OTHER` ("Storyboard nhận tối đa 4 ảnh tham chiếu"). Không tự bỏ ảnh.
- `payload.requeued = true`: đọc 9.8 trước.

### 9.2 Luật

- Mỗi lần tạo ảnh là một lượt gửi `R=<job.id>-k<K>` (K = 1, 2, 3). Không có idempotency: **không bao giờ gửi lại cùng `R`**. Tạo lại vì ảnh chưa đạt thì tăng K.
- Tối đa 3 lần cho mỗi job (K ≤ 3), như WORKER-MUSE.md mục 4 bước 7. Mỗi lần tốn hạn mức Google Flow.
- Prompt gửi nguyên văn `payload.chatgpt_message`. Ngoại lệ duy nhất: K > 1 thì nối thêm `\n\nSửa so với lần trước: <lỗi cụ thể>`.

### 9.3 Dựng body

```bash
JOB=42; K=1; R=$JOB-k$K
FIX=''   # K>1: lỗi cụ thể cần sửa, vd 'nhãn trên hộp bị vẽ sai chữ, phải giữ đúng như ảnh 1'
python3 - "$JOB" "$R" "$FIX" <<'PY'
import base64, json, mimetypes, os, subprocess, sys
job_id, run, fix = sys.argv[1], sys.argv[2], sys.argv[3]
p = json.load(open(f"/tmp/autovideo-worker/job-{job_id}.json"))["payload"]
def data_url(path, k):
    mime = mimetypes.guess_type(path)[0]
    if os.path.getsize(path) > 5 * 1024 * 1024 or mime not in ("image/png", "image/jpeg"):
        big = os.path.getsize(path) > 5 * 1024 * 1024
        out = f"/tmp/autovideo-worker/fref-{run}-{k}.{'jpg' if big else 'png'}"
        args = ["ffmpeg", "-y", "-loglevel", "error", "-i", path, "-frames:v", "1", "-update", "1", "-map_metadata", "-1"]
        args += ["-vf", "scale='min(2048,iw)':-2", "-q:v", "3"] if big else []
        subprocess.run(args + [out], check=True)
        path, mime = out, ("image/jpeg" if big else "image/png")
    return f"data:{mime};base64," + base64.b64encode(open(path, "rb").read()).decode()
files = p["upload_files"]
assert 1 <= len(files) <= 4, "Storyboard nhận tối đa 4 ảnh tham chiếu"
text = p["chatgpt_message"] + (f"\n\nSửa so với lần trước: {fix}" if fix else "")
content = [{"type": "text", "text": text}] + [{"type": "image_url", "image_url": {"url": data_url(f, k)}} for k, f in enumerate(files, 1)]
body = {"model": p["generator"]["model"], "messages": [{"role": "user", "content": content}], "stream": True}
out = f"/tmp/autovideo-worker/flow-{run}-body.json"
open(out, "w").write(json.dumps(body, ensure_ascii=False))
print(run, p["generator"]["model"], "·", len(files), "ảnh ·", round(os.path.getsize(out) / 1e6, 1), "MB")
PY
```

### 9.4 Gửi, chờ, đọc kết quả

Dùng nguyên các khối ở mục 3 và mục 4, chỉ đổi dòng đầu thành `JOB=<job.id>; R=<job.id>-k<K>`. Ảnh thường xong trong khoảng 1 phút. Khối đọc kết quả báo `co_url: true` khi có ảnh.

### 9.5 Tải ảnh, lưu PNG

URL ảnh có thể là `data:image/…;base64,…`, link Google, hoặc link file tạm của Flow2API. Tải ngay, rồi chuyển sang PNG đúng `output.storyboard_path`:

```bash
FLOW=$(sed -n 's/^FLOW2API_URL=//p' .env); FKEY=$(sed -n 's/^FLOW2API_KEY=//p' .env)
JOB=42; K=1; R=$JOB-k$K; D=/tmp/autovideo-worker
S=$(jq -r .payload.output.storyboard_path $D/job-$JOB.json)
rm -f $D/sb-$R-raw $D/sb-$R-raw.url
python3 - "$D/flow-$R-result.json" "$D/sb-$R-raw" <<'PY'
import base64, json, sys
url = json.load(open(sys.argv[1])).get("url") or ""
if url.startswith("data:"):
    open(sys.argv[2], "wb").write(base64.b64decode(url.split(",", 1)[1]))
    print("ảnh nhúng sẵn trong kết quả")
elif url:
    open(sys.argv[2] + ".url", "w").write(url)
    print("ảnh ở link, tải về")
else:
    sys.exit("không có URL ảnh")
PY
if [ -s $D/sb-$R-raw.url ]; then
  URL=$(cat $D/sb-$R-raw.url)
  case "$URL" in "$FLOW"/*) AUTH=(-H "Authorization: Bearer $FKEY");; *) AUTH=();; esac   # chỉ gửi key cho chính Flow2API
  curl --fail -sS -L --max-time 120 "${AUTH[@]}" "$URL" -o $D/sb-$R-raw
fi
mkdir -p "$(dirname "$S")"
ffmpeg -y -loglevel error -i $D/sb-$R-raw -frames:v 1 -update 1 "$S"     # luôn lưu PNG đúng output.storyboard_path
ffprobe -v error -show_entries stream=width,height -of csv=p=0 "$S"      # tỉ lệ rộng/cao phải gần 0,5625 (9:16)
```

Tải lỗi: chạy lại đúng khối này một lần. Vẫn lỗi thì coi như lượt `R` không có ảnh (không gửi lại `R`); còn lượt thì tạo lần K+1, hết lượt thì `fail` `OTHER`.

### 9.6 Kiểm tra ảnh

Làm như WORKER-MUSE.md mục 4 bước 7 (đúng 9:16, một khung, không chữ lạ, sản phẩm giống ảnh tham chiếu, đúng `first_frame_desc`). **Bỏ qua logo Gemini ở góc**: đó không phải lỗi, server sẽ xoá. Ảnh chưa đạt thì tạo lần K+1 (9.3 với `FIX` mô tả lỗi cụ thể). Ảnh mới không tốt hơn thì chuyển lại ảnh tốt nhất (`sb-<R>-raw` của lượt đó) vào `output.storyboard_path` bằng lệnh ffmpeg ở 9.5 trước khi complete.

### 9.7 `complete`

Như WORKER-MUSE.md mục 4 bước 8, với `result` ghi `provider:"flow2api"`, `model` và các mã lượt đã gửi:

```bash
API=http://127.0.0.1:8787; TOKEN=$(sed -n 's/^WORKER_TOKEN=//p' .env); W=codex-1
JOB=42
S=$(jq -r .payload.output.storyboard_path /tmp/autovideo-worker/job-$JOB.json)
MODEL=$(jq -r .payload.generator.model /tmp/autovideo-worker/job-$JOB.json)
WH=$(ffprobe -v error -show_entries stream=width,height -of json "$S" | jq -c '{width:.streams[0].width, height:.streams[0].height}')
jq -n --arg path "$S" --argjson wh "$WH" --arg model "$MODEL" --arg note 'Tạo qua Google Flow, 1 lần, đạt: đúng 9:16, nhãn hộp đúng.' --argjson runs "[\"$JOB-k1\"]" \
  '{result:{verdict:"pass", note:$note, provider:"flow2api", model:$model, flow_runs:$runs}, assets:[{kind:"storyboard", file_path:$path, meta:$wh}]}' \
| curl -sS -w '\nHTTP %{http_code}\n' -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    "$API/api/worker/jobs/$JOB/complete?worker=$W" -d @-
```

Lệnh `complete` mất thêm vài giây vì server chạy bước xoá logo. Kết quả xoá logo hiện ở trang cảnh, dưới ảnh storyboard («Đã xoá logo», «Không có logo» hoặc «Còn logo»); worker không cần làm gì thêm.

### 9.8 Job bị trả về hàng đợi

1. `output.storyboard_path` đã có ảnh và đã xem đạt: `complete` (9.7).
2. Đọc comment của cảnh (`GET /api/scenes/<scene_id>`), tìm các dòng `[flow] storyboard job <job.id>, lượt <R>`. Với từng `R` có trên máy: có `flow-<R>-result.json` chứa URL thì tải (9.5); curl còn chạy thì chờ (mục 4); còn lại là không rõ kết quả.
3. Có lượt không rõ kết quả: **không gửi lại lượt đó**. `fail` `OTHER` "Lượt <R> đã gửi lên Google Flow nhưng không rõ kết quả".
4. Không có lượt nào: làm từ đầu với K=1.

Lỗi: dùng bảng mục 7. Riêng job storyboard, hết hạn mức Flow thì `fail` `OTHER` ("hết hạn mức Google Flow"), dừng vòng lặp và nhắn người dùng.
