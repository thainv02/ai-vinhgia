# Kế hoạch code: Cắt video dài thành clip ngắn (long video → shorts)

Ngày lập: 26/10/2026. Nguồn tham khảo: đọc code `imgly/videoclipper`, `SamurAIGPT/AI-Youtube-Shorts-Generator`, `ClipsAI/clipsai`, `louisedesadeleer/clipify`, `linzzzzzz/openclip`; đọc code và tài liệu `ggroup-ai-lab/gipformer` và sherpa-onnx. Báo cáo chi tiết nằm trong scratchpad của phiên lập plan, không thuộc repo; phần cần dùng đã chép vào đây.

> **Cập nhật 27/10/2026:** ASR dùng **dịch vụ STT nội bộ Omnix**, chạy gipformer 1.5 trên GPU:
> - endpoint `POST http://10.0.3.214:18085/v1/audio/transcriptions`, chuẩn OpenAI;
> - `verbose_json` + `timestamp_granularities[]=word`;
> - tối đa 500 MB / 3 giờ, khoảng 20× thời gian thực;
> - server đã tự VAD và chia đoạn; HTTPS không chạy, dùng HTTP.
>
> Đã gọi thử thật: 8,4 giây audio xử lý trong 1,1 giây, có mốc từng từ, chữ thường, không dấu câu.
>
> Vì vậy **bỏ spike P0 và sidecar `tools/asr`**. Chạy gipformer local bằng CPU (sherpa-onnx) chỉ còn là phương án dự phòng sau này (`STT_PROVIDER=local`).
>
> Đợt 1 triển khai P1–P3 + LAN cơ bản, reframe `center`/`fit`. Đặc tả chốt của đợt 1 nằm ở các mục API/cấu hình trong `server/API.md`.

Cập nhật sửa lỗi đợt 1 (27/10): đã bổ sung khoảng lặng ffmpeg với ngưỡng RMS tự điều chỉnh, chia câu ≤12 s/30 từ, dò `start_quote`/`end_quote` đến từng từ bằng bộ dò dùng chung worker/server, sửa trong cùng ID câu, thử lại inference timeout/mạng lỗi tối đa 2 lần và viết hoa phụ đề thận trọng. Các quy tắc chi tiết cũ ở mục 6 được thay bằng hợp đồng hiện hành tại `server/API.md` 14.4–14.5. Kiểm thử dùng transcript 318 từ của lần chạy trước và gateway giả; chưa nghiệm thu lại bằng Gemini thật.

## 1. Mục tiêu
Người dùng (app chính và trang LAN) tải lên một video dài (livestream, podcast, review, hội thảo…, tiếng Việt). Hệ thống:
1. nhận dạng lời nói bằng **gipformer** (không dùng Whisper);
2. **AI (Gemini qua Antigravity, managed worker)** đề xuất các đoạn hay, tự kiểm định và sửa điểm đầu/cuối;
3. người dùng duyệt, sửa điểm cắt ngay trên lời thoại;
4. dựng clip **9:16** bám người nói, **phụ đề tiếng Việt chạy theo từng từ**, tuỳ chọn chỉnh màu / màu theo ảnh mẫu / góp ý cho AI như bản dựng hiện có;
5. xem và tải từng clip hoặc tải cả bộ.

Không tốn credit Flow. Mọi thứ chạy trên máy chủ (Mac mini M4, 16 GB), trừ bước gọi Gemini.

## 2. Ràng buộc quan trọng (đọc trước khi code)
- **Không dùng code của `imgly/videoclipper`** (không có file LICENSE, phụ thuộc CE.SDK thương mại). Chỉ học ý tưởng.
- Được port code **MIT** (ghi nguồn ở đầu file): ClipsAI, clipify, openclip (linzzzzzz), AI-Youtube-Shorts-Generator.
- Không dùng pyannote (model gated, cần token HF) ở v1. Không gọi API trả phí (ElevenLabs, OpenAI, MuAPI).
- **Thời gian cắt không bao giờ lấy thẳng từ số giây do LLM viết ra.** LLM chỉ trả **ID câu** có trong transcript; server ánh xạ ID → mốc thời gian từ ASR (xem 6.2). Các repo dùng giây do LLM viết đều dính lỗi: nhầm `00:01:55`/`01:55:00`, bịa mốc, lệch offset khi chia chunk.
- Gipformer xuất **CHỮ HOA, không dấu câu, số đọc thành chữ**. Mốc thời gian là theo token (độ phân giải 40 ms), không phải forced alignment. Token có thể phát ra trễ so với âm thật, nên **điểm cắt phải bám khoảng lặng (VAD)**, không chỉ bám từ.
- Giấy phép gipformer: README/HF ghi MIT nhưng repo **không có file LICENSE** và **không công bố dữ liệu huấn luyện**. Dùng nội bộ thì chấp nhận được; trước khi phân phối ra ngoài phải hỏi tác giả. Ghi vào `docs/ai/BACKLOG.md`.
- Ổ đĩa còn ~49 GB. Video dài rất nặng, nên phải có kiểm tra dung lượng trống và hạn lưu trữ (mục 10).
- Giữ mọi nguyên tắc vận hành hiện có:
  - app thật chạy từ repo, phát triển trên bản sao, triển khai khi máy rảnh, sao lưu DB trước migration;
  - không đụng `data/app.db`, `output/`, `refs/`, `.env` khi test;
  - không commit khi chưa được yêu cầu.

## 3. Công nghệ
| Phần | Chọn | Ghi chú |
|---|---|---|
| ASR | **gipformer1.5-68M-rnnt** (ONNX) qua **sherpa-onnx** `OfflineRecognizer.from_transducer` | Bản demo chính thức của tác giả đọc `result.tokens` + `result.timestamps` từ chính file ONNX này, nên có mốc thời gian |
| Cắt audio dài | **Silero VAD** của sherpa-onnx | Thông số như demo: threshold 0.5, min_silence 0.2 s, min_speech 0.2 s, max_speech 20 s; gộp đoạn ≤ 20 s, cắt cứng 30 s, pad 0.1 s |
| Sidecar | Python riêng (`tools/asr/`), venv riêng, chạy `python -I` | Server Node gọi như gọi `gwr`/Shotcut MCP hiện nay, đọc tiến độ từ stderr, kết quả JSON |
| Chọn đoạn | Gemini 3.8 Flash High qua managed worker (CLIProxyAPI, Antigravity) | Chỉ text + ảnh (proxy hiện chỉ có `text`, `vision`, `tools`); không cần gửi audio |
| Dò mặt / reframe | **MediaPipe** Face Detection + Face Mesh (Python, cùng sidecar `tools/vision/`) | Thay MTCNN/Haar trong các repo. Chạy trên CPU M4 |
| Dò chuyển cảnh | ffmpeg `scdet` (hoặc PySceneDetect `AdaptiveDetector` nếu cần chính xác hơn) | |
| Dựng | ffmpeg một lượt: trim → crop động (`sendcmd`) → scale 1080×1920 → phụ đề ASS → `lut3d`/`eq` → x264 | Không render khung hình qua OpenCV (tránh mã hoá lại nhiều lần như AI-Youtube-Shorts-Generator) |
| Phụ đề | ASS sinh bằng TypeScript, highlight từng từ (port ý tưởng `build_ass.py` của clipify, MIT) | Font tiếng Việt đi kèm: **Be Vietnam Pro** (OFL), `fontsdir` cho libass |

Phiên bản: `sherpa-onnx` ghim một bản ≥ 2 tuần tuổi (2.0.0 mới ra 23/10/2026; ưu tiên 1.12.x/1.13.x đã kiểm chứng ở spike). Model: chỉ tải `encoder/decoder/joiner(.int8).onnx` + `tokens.txt` (~73 MB int8, ~270 MB fp32), không tải `model.pt`.

## 4. Cấu trúc thư mục (mới)
```
tools/asr/                  # sidecar gipformer: pyproject (uv), transcribe.py, README (nguồn, giấy phép)
tools/vision/               # sidecar MediaPipe: track_faces.py
server/src/services/clips/  # source.ts, asr.ts, transcript.ts, plan.ts (ánh xạ ID câu), reframe.ts, captions.ts, render.ts
server/src/routes/clips.ts
server/src/lan/routes-clips.ts
web/src/pages/ClipsPage.tsx, web/src/components/clips/*
web/src/planner/clips/*     # trang LAN
models/                     # (gitignore) model ASR/VAD/MediaPipe, hoặc ~/.local/share/autovideo/models
output/<slug>/clips/        # source/, transcript.json, clips/<code>_v<n>.mp4, .ass, reframe.json
```

## 5. Mô hình dữ liệu (migration 014, 015)
- `projects.kind`: `'scenes'` (mặc định, như hiện nay) | `'clips'`.
  - Dự án cắt clip là một project, nên **thùng rác, xoá vĩnh viễn, quyền LAN theo cookie** dùng lại nguyên.
  - Màn danh sách lọc theo `kind`.
- `source_videos`:
  ```
  id, project_id FK CASCADE, path, original_name, bytes, duration_s, width, height, fps,
  has_audio, status (uploaded|transcribing|transcribed|failed|cancelled), progress, error,
  transcript_path, asr_meta JSON (model, precision, decoding, rtf, speech_ratio),
  scene_cuts JSON, created_at
  ```
- `transcript.json`: file, không lưu vào DB vì lớn.
  ```
  {
    model, precision, duration_s,
    words: [{i, w, start, end, seg}],
    sentences: [{id, start_word, end_word, start, end, text, pause_after}],
    vad: [{start, end}]
  }
  ```
  - `sentences` được dựng từ VAD + khoảng lặng ≥ 0.7 s + giới hạn độ dài (mục 6.1).
  - Lưu kèm bản hiển thị đã khôi phục chữ thường/dấu câu nếu có (`display` theo từng từ, xem 6.4).
- `clips`:
  ```
  id, project_id, source_id, code (K1, K2…), status (proposed|approved|rejected|rendering|ready|failed|cancelled),
  start_sentence, end_sentence, start_s, end_s (đã bám khoảng lặng),
  title, hook, score, reason, content_type, verify JSON (keep, standalone_score, diagnosis, repaired),
  created_by (agent|user)
  ```
- `clip_cuts`: phiên bản dựng của từng clip, giống `final_cuts`.
  ```
  id, clip_id, version, parent_id, status, stage (reframe|render|grade), progress,
  aspect (9:16|1:1|16:9|source), reframe JSON (mode face|center|fit|manual, segments, keyframes),
  captions JSON (preset, words đã sửa), grade (dùng chung grade.ts + match), feedback, revision,
  video_path, base_path, error
  ```
- Bảng `jobs`: thêm loại `clip_plan` (AI chọn + kiểm định + sửa) và `clip_revise` (góp ý cho từng clip).
  - Phải dựng lại bảng `jobs` vì có CHECK type: làm như migration 003, giữ AUTOINCREMENT, `foreign_key_check` trước commit.
- ASR, reframe, render **không phải job của worker**. Chúng chạy trong hàng đợi phía server, như `FinalRenderService` (mục 8).

## 6. Pipeline chi tiết

### 6.1 Tải lên và nhận dạng lời nói
1. **Tải lên**:
   - app chính ≤ 4 GB, LAN ≤ 2 GB, thời lượng ≤ 3 giờ ở cả hai nơi;
   - stream thẳng xuống đĩa;
   - `ffprobe` kiểm tra có video và audio;
   - từ chối nếu dung lượng trống < 10 GB + 3 × kích thước file.
2. `ffmpeg -vn -ac 1 -ar 16000` ra `audio16k.wav` (xoá sau khi xong). Song song chạy `scdet` lấy mốc chuyển cảnh và tạo poster/contact sheet thưa (1 khung/30 s).
3. **Sidecar ASR**:
   - VAD → gộp đoạn ≤ 20 s → `decode_streams` theo lô 8 → tokens + timestamps;
   - ghép BPE thành từ: token bắt đầu bằng `▁` hoặc dấu cách là từ mới;
   - start của từ = mốc token đầu; end = start của từ kế, chặn ở cuối đoạn VAD;
   - cộng offset đoạn (mẫu ÷ 16000, trừ pad);
   - `len(tokens) != len(timestamps)` → đoạn đó chỉ có text, mốc nội suy đều, và ghi cảnh báo;
   - tiến độ in ra stderr theo dòng JSON; kết quả là `transcript.raw.json`.
   - Mặc định `int8`, `modified_beam_search`, 4 luồng. Spike sẽ quyết lại (mục 11, P0).
4. **Dựng câu** (TypeScript, tất định):
   - ngắt câu tại khoảng lặng ≥ 0.7 s, hoặc ranh giới đoạn VAD, hoặc khi câu > 25 giây hay > 60 từ (ngắt ở khoảng lặng lớn nhất bên trong);
   - gán ID tăng dần;
   - tính `speech_ratio` = tổng thời gian có lời ÷ thời lượng.
5. Cache theo hash nội dung + phiên bản model: tải lại cùng file thì không nhận dạng lại.

### 6.2 AI chọn đoạn: job `clip_plan` (managed worker, Gemini)
Gộp ý tưởng tốt nhất của các repo, và sửa các lỗi đã thấy trong code của chúng.
1. **Chia transcript** thành cửa sổ 15–20 phút, chồng 60 s.
   - Mỗi câu hiển thị cho AI dạng `[S0123 | 00:12:34] nội dung` (chữ thường).
   - Mốc thời gian chỉ để AI tham khảo, **AI trả về ID câu**.
   - Thời gian luôn là thời gian tuyệt đối của video. Không cộng offset lần hai: đây là lỗi của AI-Youtube-Shorts-Generator, và phải có test riêng cho nó.
2. **Nhận diện loại nội dung** (1 lời gọi, trên 3.000 ký tự đầu): `livestream_ban_hang | podcast | phong_van | review | huong_dan | hoi_thao | vlog | khac`, kèm mật độ thông tin.
3. **Đề xuất theo từng cửa sổ.** Prompt port từ shorts-gen/openclip (MIT), viết lại tiếng Việt:
   - **Tiêu chí:** hook trong 3 giây đầu, đỉnh cảm xúc, quan điểm mạnh, tiết lộ, câu nói đáng trích, mẹo thực dụng, khoảnh khắc chốt đơn/giá/ưu đãi (riêng livestream bán hàng).
   - **Câu mở phải hiểu được khi không có ngữ cảnh** (ý của imgly): không bắt đầu bằng từ nối ("thì", "rồi", "và"), đại từ không rõ chỉ ai, hay câu trả lời cho câu hỏi người xem không nghe thấy. Không kết thúc giữa ý.
   - **Đầu ra:**
     ```
     {moments: [{start_id, end_id, title, hook (6–12 từ, được viết mới), score 0–100, reason, start_quote (5 từ đầu)}]}
     ```
   - **Số lượng:** xin ~2N ứng viên. N do người dùng chọn, mặc định 5.
   - **Độ dài:** preset người dùng chọn (15–30, 30–60 mặc định, 60–90, 90–180 giây), kèm khoảng cứng và khoảng lý tưởng chèn vào prompt.
   - "Không có đoạn nào đạt thì trả mảng rỗng."
   - **Ô "Muốn tập trung vào…"** của người dùng là DỮ LIỆU, không phải lệnh hệ thống.
   - Temperature thấp (≤ 0.3).
4. **Kiểm tra phía server** (sai thì trả 400 để worker sửa, như `INVALID_EDL`):
   - ID tồn tại, `start_id ≤ end_id`, độ dài trong khoảng cứng;
   - `start_quote` khớp ≥ 60% với câu `start_id`, để bắt lỗi lệch ID.
5. **Gộp + khử trùng**:
   - sắp theo điểm;
   - bỏ ứng viên chồng > 60% đoạn ngắn hơn, hoặc trùng ý (Jaccard token của title+reason ≥ 0.33; ý của openclip).
6. **Kiểm định "đứng một mình"** (port prompt judge của openclip):
   - đưa transcript của clip + ngữ cảnh ±60 s, kèm 4 khung hình rải trong clip (lưới ảnh như `edit_plan`) để AI thấy hình có hợp không (màn đen, chuyển cảnh, không thấy người/sản phẩm);
   - trả `{keep, standalone_score, diagnosis: bad_start|bad_end|missing_premise|missing_payoff|not_fixable|none}`;
   - loại trừ khi chắc chắn tốt ("không chắc thì loại").
7. **Sửa và chấm lại một lần**:
   - với `bad_start`/`bad_end`/`missing_*`, AI chọn lại ID câu trong ngữ cảnh đã hiển thị, rồi chấm lại;
   - lời gọi kiểm định lỗi → **không tự giữ** (openclip mặc định giữ), mà đánh dấu "chưa kiểm định" để người dùng tự xem.
8. **Bám khoảng lặng** (tất định):
   - start = đầu câu `start_id` − pad 0.15 s, không lấn vào từ trước, ưu tiên rơi vào khoảng lặng VAD;
   - end = cuối câu `end_id` + 0.3 s, không lấn từ sau;
   - âm thanh `afade` 60 ms ở hai đầu.
9. **Giới hạn chi phí:** tối đa ~ (số cửa sổ + 2N + N) lời gọi; job có checkpoint như managed worker hiện có. Kết quả là các dòng `clips` trạng thái `proposed`.
10. **Video ít lời** (`speech_ratio` < 0.3): chạy chế độ hình ảnh.
    - Đoạn = các cảnh từ `scdet`; lưới khung hình như `edit_plan`; AI chọn theo hình.
    - Đây là giai đoạn sau (P5). V1 báo rõ "video ít lời, kết quả kém" thay vì làm bừa.

### 6.3 Người dùng duyệt
- Danh sách clip đề xuất dạng thẻ: tiêu đề, hook, điểm, lý do, thời lượng, ảnh đại diện, đoạn lời thoại, nhãn kiểm định.
- Phát thử đúng đoạn trên video gốc (player tua tới `start_s`, dừng ở `end_s`; video gốc phục vụ qua `/files` có Range).
- **Sửa điểm cắt trên lời thoại:** bấm vào từ để đặt đầu/cuối; kéo mở rộng theo câu; ô tìm kiếm trong transcript. Có thể tự tạo clip mới bằng cách bôi đen một khoảng lời thoại.
- "Duyệt" / "Bỏ"; "Gợi ý thêm" (chạy lại `clip_plan` với "loại trừ các đoạn đã có").

### 6.4 Phụ đề
- **Khôi phục chữ thường + dấu câu** cho lời thoại của clip đã duyệt (không cho cả video). Đây là lời gọi Gemini nằm trong `clip_plan` hoặc `clip_revise`.
  - Ràng buộc: **giữ nguyên dãy từ**, chỉ đổi hoa/thường và thêm dấu câu.
  - Server kiểm tra từng từ: bỏ dấu câu, so chữ thường. Lệch thì dùng bản chữ thường của ASR.
  - Số đọc thành chữ giữ nguyên ở v1 (đổi "hai mươi" → "20" làm mất ánh xạ từ; để BACKLOG).
- **Sửa tay** từng cụm phụ đề (lỗi ASR, vì WER 20%+ trên dữ liệu chuyên ngành là bình thường). Giữ mốc thời gian; thêm hoặc bớt từ thì chia đều thời gian trong cụm.
- **Chia cụm:**
  - ≤ 3–4 từ cho preset "Nổi bật", ≤ 8 từ / 42 ký tự / 3.2 s cho preset thường;
  - ngắt ở khoảng lặng ≥ 0.6 s; ngắt mềm ở dấu phẩy hoặc khoảng lặng ≥ 0.35 s (quy tắc của imgly, tự viết lại).
- **ASS:**
  - PlayRes 1080×1920, `WrapStyle 2`, alignment 2, MarginV ~280;
  - mỗi từ một sự kiện `Dialogue` hiển thị cả cụm, từ đang nói tô màu `{\c&H00FFFF&}` (cách của clipify, MIT);
  - font Be Vietnam Pro đậm, viền 8, bóng 3.
- **Preset:** "Nổi bật" (vàng), "Karaoke" (xanh lá), "Tối giản" (không tô), "Không phụ đề".
- Xuất thêm `.srt` cho từng clip.

### 6.5 Reframe 9:16 (sidecar `tools/vision/track_faces.py`)
- Video nguồn đã dọc thì bỏ qua bước này.
- Các chế độ: `face` (mặc định khi thấy mặt), `center`, `fit` (video gốc ở giữa, nền mờ phóng to; mặc định khi không thấy mặt), `manual` (người dùng kéo vị trí theo từng đoạn).
- **Các bước** (gộp ClipsAI và clipify, sửa lỗi đã thấy):
  1. Chia clip thành đoạn theo mốc chuyển cảnh (`scdet`, ngưỡng 0.3), như ClipsAI.
  2. Lấy mẫu 5 khung/giây ở 640 px, MediaPipe Face Detection (full-range).
     - Theo vết mặt bằng IoU tracker, tất định: không lấy mẫu ngẫu nhiên như ClipsAI.
     - Không dùng KMeans với k = số mặt tối đa: một phát hiện nhầm làm vỡ cụm.
  3. **Nhiều mặt → chọn người đang nói:**
     - điểm cử động miệng (MAR từ Face Mesh, tổng |ΔMAR|) kết hợp năng lượng âm có lời tại thời điểm đó;
     - đổi người khi người kia vượt 1.15× (hysteresis của clipify) và giữ tối thiểu 1.0 s;
     - không ai cử động miệng thì chọn mặt xuất hiện lâu nhất;
     - đã biết điểm yếu: cười/ngáp bị tính là nói. Chấp nhận ở v1, có chế độ `manual`.
  4. **Khung cắt:**
     - mục tiêu = tâm mặt (lệch lên 1/3 trên khung), có vùng chết 15% bề ngang;
     - làm mượt bằng lò xo tới hạn hoặc EMA trên keyframe;
     - **cắt cứng tại chuyển cảnh**;
     - kẹp **cả 4 cạnh** (ClipsAI chỉ kẹp trái/trên, sai ở mép phải).
  5. Xuất `reframe.json`: keyframe `{t, x}` mỗi 0.2 s, kèm đoạn và chế độ.
- **Render:** `crop` với `x` cập nhật qua `sendcmd` theo keyframe (không nhồi biểu thức `if()` dài), rồi `scale=1080:1920:flags=lanczos`, rồi `subtitles` (ASS), rồi màu, rồi encode. Tất cả trong một lượt ffmpeg.
- **Xem trước:** lưới khung hình có vẽ khung cắt, để người dùng thấy trước khi render. Chế độ `manual` cho kéo khung trên lưới đó.

### 6.6 Dựng, xoá logo, màu, góp ý
- Hàng đợi render chung (`FinalRenderService`) thêm loại việc `clip`, tôn trọng `RENDER_CONCURRENCY`, app chính ưu tiên hơn LAN, hiển thị vị trí hàng đợi như hiện nay.
- Trim chính xác: `-ss` trước `-i` để nhanh, giải mã chính xác, mã hoá lại. Không dùng `-c copy`, vì cắt không đúng khung (lỗi của clipify).
- Bước **xoá logo Veo**: tuỳ chọn, mặc định TẮT. Chỉ cần khi video dài được ghép từ clip Veo.
- **Chỉnh màu, màu theo ảnh mẫu, góp ý cho AI** dùng lại `grade.ts`, `color-match.ts`, `final-revisions` (theo từng clip, phiên bản nối tiếp).
  - Góp ý kiểu "bắt đầu sớm hơn 1 câu", "phụ đề to hơn", "ấm hơn" → job `clip_revise` trả `{start_id?, end_id?, captions?, grade?, summary, not_done}`.
- **Tải xuống:** từng clip (mp4 + srt), hoặc ZIP mọi clip `ready` (dùng `zip.ts`).

## 7. API (tóm tắt; chi tiết ghi vào `server/API.md` khi làm)
- **Dự án và nguồn:**
  - `POST /api/clip-projects` (tạo project `kind='clips'`)
  - `POST /api/projects/:id/sources` (multipart, stream)
  - `GET /api/sources/:id`
  - `POST /api/sources/:id/cancel`
- **Transcript:**
  - `GET /api/sources/:id/transcript` (phân trang theo câu)
  - `GET …/transcript.srt|.txt`
- **Clip:**
  - `POST /api/sources/:id/clip-plan {count, duration_preset, focus?}` → job `clip_plan`
  - `GET /api/projects/:id/clips`
  - `PATCH /api/clips/:id {start_word|start_sentence, end_*, title, status}`
  - `POST /api/sources/:id/clips` (tạo tay từ khoảng từ)
- **Dựng:**
  - `POST /api/clips/:id/render {aspect, reframe_mode, captions_preset, grade?, remove_logo?}`
  - `GET /api/clips/:id/cuts`
  - `POST /api/clip-cuts/:id/{cancel,feedback,grade,grade-preview,captions}`
  - `GET /api/projects/:id/clips.zip`
- **SSE:** `source.updated` (tiến độ ASR), `clip.updated`, `clip_cut.updated`.
- **LAN:**
  - các route tương ứng dưới `/lan/api/clip-projects/...`;
  - quyền theo cookie người tạo; rate limit: tải nguồn 3/giờ/IP, clip-plan 6/giờ, render 30/giờ;
  - tính vào trần hàng đợi LAN;
  - allowlist `/lan/files` cho clip `ready`, thumb, srt; **không phục vụ video nguồn dài qua LAN** trừ đoạn xem thử (sinh proxy 480p).

## 8. Hàng đợi và tài nguyên máy
- **Hàng đợi ASR riêng:** 1 việc một lúc, 4 luồng.
  - Dự kiến (chưa đo, spike sẽ đo): RTF ~0.03–0.1, tức video 1 giờ mất ~2–6 phút.
  - Nhiều video thì xếp hàng và hiển thị vị trí.
- **Hàng đợi render:** dùng chung `RENDER_CONCURRENCY` (2).
  - Reframe (MediaPipe) chạy như một stage trong việc render của clip.
  - Khi ASR đang chạy, render LAN có thể tự giảm còn 1 việc. Đo ở P3 rồi mới quyết.
- **AI:** `clip_plan`/`clip_revise` vào hàng đợi managed worker chung, tuần tự như `edit_plan`. UI hiện vị trí chờ AI.

## 9. Giao diện
- **App chính:**
  - mục mới "Cắt clip từ video dài" ở header;
  - bố cục: cột trái là player video gốc + transcript (tìm kiếm, bấm từ để tua); cột phải là danh sách clip đề xuất;
  - **các bước có stepper:** Tải lên → Nhận dạng lời nói (%) → AI đề xuất (vị trí hàng đợi AI) → Duyệt → Dựng (%) → Tải;
  - **trang chi tiết clip:**
    - player 9:16;
    - chọn khung hình (Tự bám người nói / Giữa / Nền mờ / Tự chỉnh);
    - preset phụ đề;
    - sửa phụ đề;
    - khối "Góp ý cho AI" và "Chỉnh màu" dùng lại component có sẵn;
    - lịch sử phiên bản.
- **Trang LAN:** cùng luồng, gọn hơn; giới hạn hiển thị rõ (dung lượng, thời lượng, số lượt còn lại).
- Tiếng Việt, 390 px, sáng/tối, phong cách hiện tại.

## 10. Lưu trữ, bảo mật, độ bền
- **Kiểm tra dung lượng trống** trước khi tải lên và trước khi dựng; dưới 10 GB thì chặn kèm thông báo.
- **Hạn lưu video nguồn:**
  - app chính giữ đến khi xoá dự án, có nút "Xoá video gốc, giữ clip";
  - LAN tự xoá video nguồn sau 7 ngày (giữ transcript và clip 30 ngày), cấu hình `CLIP_SOURCE_RETENTION_DAYS`.
- Dự án `clips` đi qua thùng rác như mọi dự án. Thư mục `output/<slug>/clips` được chuyển theo.
- **Tiến trình con** (sidecar, ffmpeg): kill cả cây khi hủy; dọn file tạm; khôi phục việc dở khi khởi động lại server (như render hiện nay).
- **Đầu vào người dùng** (focus, góp ý, sửa phụ đề) là dữ liệu: đi vào ASS sau khi escape `{`, `}`, `\`; đi vào prompt như dữ liệu được đánh dấu.
- **Tải lên lớn:** giới hạn đồng thời 1 upload/IP (LAN); kiểm tra magic bytes + `ffprobe`.

## 11. Các giai đoạn thực hiện
| Giai đoạn | Nội dung | Nghiệm thu chính |
|---|---|---|
| **P0 – Spike gipformer (cần chủ máy duyệt lệnh cài đặt)** | venv riêng trong scratchpad; ghim `sherpa-onnx`; tải model int8+fp32 + `silero_vad.onnx` (~350 MB); chạy `infer_onnx.py` mẫu; viết `spike_asr.py` (VAD + chunk + timestamps → JSON); thử trên 3 video thật do chủ máy chọn (livestream, podcast, review) | RTF ≤ 0.15 ở int8 hoặc fp32; RAM < 3 GB; `len(tokens)==len(timestamps)` ≥ 99% đoạn; sai lệch mốc đầu từ (so tay 50 từ) trung vị ≤ 150 ms, p95 ≤ 400 ms; WER ước lượng trên 3 đoạn 1 phút gõ tay; không lặp/mất từ ở ranh giới chunk. Chọn int8/fp32, greedy/beam. **Không đạt → dừng, báo lại, cân nhắc PhoWhisper hoặc Zipformer-30M** |
| **P1 – Nguồn + ASR + transcript** | migration 014 (`projects.kind`, `source_videos`), upload stream, sidecar `tools/asr`, hàng đợi ASR, dựng câu, trang transcript (tìm kiếm, bấm để tua, xuất SRT/TXT) | Video 60 phút → transcript đúng mốc; hủy giữa chừng sạch; cache theo hash; test với sidecar giả |
| **P2 – AI chọn đoạn** | migration 015 (job `clip_plan`, bảng `clips`), prompt/kiểm tra/khử trùng/kiểm định/sửa/bám khoảng lặng, UI duyệt + sửa điểm cắt trên lời thoại | Test: ánh xạ ID→thời gian, không double-offset khi chia cửa sổ, `start_quote` bắt lệch ID, dedupe, verify lỗi → "chưa kiểm định". Thử thật Gemini trên 1 video: ≥ 3/5 clip được chủ máy đánh giá "dùng được" |
| **P3 – Dựng cơ bản** | clip_cuts, trim chính xác, 9:16 `center`/`fit`, ASS từng từ, preset, sửa phụ đề, khôi phục dấu câu, hàng đợi render, tải mp4/srt/zip | ffmpeg một lượt; phụ đề khớp tiếng (lệch ≤ 150 ms); font tiếng Việt đủ dấu; hủy sạch |
| **P4 – Reframe bám người nói** | sidecar MediaPipe, đoạn theo chuyển cảnh, tracker, chọn người nói, làm mượt + vùng chết, `sendcmd`, xem trước khung cắt, chế độ `manual` | Test hình học (kẹp 4 cạnh, cắt cứng ở chuyển cảnh, hysteresis); thử thật video 2 người: không giật, đổi người đúng phần lớn thời gian |
| **P5 – Hoàn thiện** | LAN đầy đủ + giới hạn; màu/màu theo ảnh mẫu/góp ý `clip_revise`; chế độ hình ảnh cho video ít lời; tiêu đề hook đè 3 giây đầu; dọn nguồn theo hạn | Như các tính năng LAN hiện có; smoke trình duyệt 1440/390 |

Mỗi giai đoạn:
- làm trên bản sao repo (app thật đang chạy);
- `npm test`, `npm run typecheck`, `npm run build` qua; migration thử trên bản sao DB thật;
- smoke trình duyệt headless có ảnh;
- triển khai khi máy rảnh, sao lưu DB trước;
- test không gọi AI hoặc ASR thật (sidecar giả trả JSON cố định); thử thật có giám sát sau khi triển khai.

## 12. Tiêu chí nghiệm thu tổng
- Video tiếng Việt 60 phút: từ lúc tải xong tới lúc có danh sách đề xuất ≤ 15 phút (ASR + AI), dựng một clip 60 giây ≤ 1 phút.
- Không clip nào bắt đầu hay kết thúc giữa từ; ≥ 80% clip đề xuất bắt đầu ở câu "hiểu được khi không có ngữ cảnh" (chủ máy chấm trên 2 video).
- Phụ đề đúng tiếng Việt có dấu, chạy theo từng từ, sửa tay được.
- Hoạt động trên cả app chính và LAN với giới hạn; dự án vào thùng rác và khôi phục đúng.

## 13. Ngoài phạm vi (v1)
- Pyannote/diarization nhiều người nói chính xác, nhận dạng giọng theo người.
- Dịch phụ đề sang ngôn ngữ khác, lồng tiếng, TTS.
- Đăng thẳng lên TikTok/YouTube.
- Đổi số đọc thành chữ số trong phụ đề, chuẩn hoá chính tả nâng cao.
- Tải video từ URL (YouTube…): cân nhắc sau, vì vướng điều khoản nền tảng.

## 14. Câu hỏi còn mở (hỏi chủ máy)
1. Loại video dài dùng nhiều nhất? Livestream bán hàng, podcast, review, hội thảo hay video sản phẩm ít lời? Câu trả lời quyết định prompt mặc định và có cần chế độ hình ảnh sớm không.
2. Preset độ dài mặc định (đề xuất 30–60 s) và số clip mặc định (đề xuất 5).
3. Phụ đề bật mặc định không? Preset nào?
4. Giới hạn LAN: dung lượng, thời lượng, hạn lưu video nguồn (2 GB / 3 giờ / 7 ngày).
5. Duyệt chạy spike P0: cài `sherpa-onnx` vào venv riêng trong scratchpad và tải ~350 MB model từ Hugging Face; chọn 3 video mẫu.
6. Chấp nhận rủi ro giấy phép gipformer (không có file LICENSE, không rõ dữ liệu huấn luyện) cho dùng nội bộ?
