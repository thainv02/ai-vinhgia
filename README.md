# Autovideo

Web chạy trên máy chủ (Fastify + SQLite + React) để sản xuất video quảng cáo dọc 9:16 theo cảnh bằng AI. Ngoài luồng chính còn có: highlight từ video dài, công cụ xoá logo Veo và trang LAN cho đồng nghiệp.

Tài liệu này mô tả **luồng đang chạy thật** (đối chiếu mã, `.env` và lịch sử job ngày 09/11/2026). Chi tiết nằm ở các tài liệu trong mục [Bản đồ tài liệu](#bản-đồ-tài-liệu).

## Ai làm việc gì

| Việc | Do ai làm | Gọi tới |
|---|---|---|
| Duyệt prompt, duyệt tạo ảnh/video, chấm video, chọn video dùng | Người dùng trên web | — |
| `analyze_brief`, `revise_prompt`, `edit_plan`, `clip_plan` (văn bản, EDL, chọn clip) | Managed worker `antigravity-worker-1` (`npm run worker:start`) | AI API dùng chung (`AI_API_URL`, model `AI_API_MODEL`, hiện `gemini-3.8-flash-high`) |
| `storyboard`, `video` | Worker nền `media-api-1` (`npm run worker:media`) | Muse2API hoặc Flow2API, theo dịch vụ người dùng chọn |
| Render bản hoàn chỉnh, xoá logo, chỉnh màu, dựng clip | Server (hàng đợi render) | Shotcut MCP hoặc ffmpeg, tool `gwr` |
| Nhận dạng lời nói cho highlight | Server | Dịch vụ STT nội bộ Omnix (`STT_URL`) |

`.env` đang chạy: `WORKER_MODE=managed`, `MANAGED_JOB_TYPES=analyze_brief,revise_prompt,edit_plan,clip_plan`. Vì vậy `storyboard` và `video` thuộc làn **legacy** và worker nền `media-api-1` nhận chúng qua API legacy (`?worker=media-api-1&types=storyboard,video`). Không có job nào cần mở Chrome, ChatGPT hay Flow trên trình duyệt.

Phiên Claude Code hoặc Codex **không** chạy vòng lặp worker trừ khi người dùng yêu cầu. Lần cuối Claude làm worker là 21/10/2026.

## Luồng video theo cảnh

1. **Tạo dự án** (`/projects/new`): kịch bản, ảnh tham chiếu, khóa nhất quán (`style_lock`). Dịch vụ ảnh storyboard chọn theo dự án trong «Cài đặt dự án»: Muse (`muse-image`) hoặc Google Flow (`gemini-3.1-flash-image-portrait`).
2. **Chia cảnh**: job `analyze_brief`. Managed worker đọc `video-production-rules.md`, trả cảnh `C1, C2, …` với prompt tiếng Anh, mô tả khung đầu và thứ tự ảnh. Cảnh về `awaiting_approval`.
3. **Duyệt prompt** từng cảnh hoặc hàng loạt. Người dùng sửa tay, hoặc ghi comment để AI sửa (job `revise_prompt`).
4. **Storyboard**: duyệt → job `storyboard` → `media-api-1` gửi `payload.chatgpt_message` cùng ảnh tham chiếu tới dịch vụ đã chọn. Ảnh Google Flow có logo Gemini; server tự xoá logo khi worker `complete` (`server/src/services/storyboard-logo.ts`).
5. **Video**: người dùng chọn dịch vụ mỗi lần bấm «Tạo video», rồi duyệt. Job `video` gửi prompt nguyên văn cùng ảnh sản phẩm và storyboard (storyboard ở cuối).

   | Dịch vụ | Model | Độ dài | Ảnh tối đa | Credit Flow |
   |---|---|---|---|---|
   | Muse (mặc định) | `muse-video` | 10 giây | 4 | — (hạn mức tài khoản Muse) |
   | Google Flow · Veo 3.1 Fast | `veo-3.1-fast-r2v-8s-portrait` | 8 giây | 3 | 20 |
   | Google Flow · Veo 3.1 Lite | `veo-3.1-lite-r2v-8s-portrait` | 8 giây | 3 | 10 |
   | Google Flow · Omni 1.1 Flash | `omni-1.1-flash-10s-portrait` | 10 giây | 3 | 15 |

   Nguồn: `server/src/services/generators.ts`. Từ 05/11/2026 phần lớn job chạy qua Google Flow: storyboard bằng Gemini 3.1 Flash Image, video bằng Omni 1.1 Flash. Veo Fast/Lite chưa dùng qua autovideo.
6. **Xem và chấm**: worker nền không chấm chất lượng; ảnh/video về trạng thái chờ xem kèm lưới khung hình. Người dùng chấm `pass` / `fix_in_edit` / `redo`, tạo lại hoặc chọn video dùng. Mỗi cảnh có giới hạn số lượt video (`max_attempts_per_scene`). Hệ thống không còn tính credit.
7. **Bản hoàn chỉnh** (`/projects/:id/final`): khi mọi cảnh có video được chọn, server tạo job `edit_plan`. AI trả EDL (đoạn giữ/bỏ). Server render bằng Shotcut MCP hoặc ffmpeg (`FINAL_RENDERER=auto`), xoá logo Veo bằng `gwr`, chỉnh màu nếu có, rồi lưu `output/<slug>/final/<slug>_final_v<n>.mp4`. Phiên bản cũ không bị ghi đè.
8. **Sửa bản dựng**: chỉnh điểm cắt, góp ý cho AI (job `edit_plan` có `payload.revision`), chỉnh màu tay, màu theo ảnh mẫu hoặc LUT. Mỗi lần tạo một phiên bản mới. Chỉnh màu luôn chạy sau bước xoá logo.

## Các luồng khác

- **Highlight từ video dài** (`/clips`): tải video → STT Omnix → `clip_plan` chọn đoạn → `clip_plan` chế độ `cleanup` làm gọn lời nói (bắt buộc) → người dùng sửa điểm cắt và phụ đề → server dựng clip 9:16 có phụ đề → tải MP4/SRT/ZIP. Phụ đề cần ffmpeg có libass (`CLIP_FFMPEG_PATH`).
- **Trang LAN** (`http://<IP máy>:8790`, listener riêng, mặc định không cần mã):
  - Kế hoạch prompt (`lan_mode='plan'`): AI chia cảnh, đồng nghiệp tự tạo ảnh/video bằng tài khoản của họ rồi tải video lên. Không tạo job storyboard/video.
  - Autovideo (`lan_mode='auto'`): đồng nghiệp tạo storyboard/video bằng Muse/Flow **của chủ máy** qua `media-api-1`. Có công tắc `LAN_AUTOVIDEO`, hạn mức theo IP và trần 20 job; việc của chủ máy luôn được nhận trước.
  - Highlight và Xoá logo Veo là hai tab riêng; mọi bản dựng, clip và việc xoá logo dùng chung hàng đợi render với app chính.
- **Thùng rác** (`/trash`): xoá dự án là xoá mềm 30 ngày, khôi phục được.

## Tiến trình cần chạy

| Thành phần | Cách chạy | Địa chỉ / log |
|---|---|---|
| Server + web (dev) | `npm run dev` | API `127.0.0.1:8787`, web `localhost:5173`, LAN `0.0.0.0:8790` (cùng tiến trình server) |
| Managed worker (văn bản/EDL/clip) | `nohup npm run worker:start >> data/worker-managed.log 2>&1 &` | khóa `~/.local/share/autovideo/managed-worker.lock` |
| Worker nền ảnh/video | `nohup npm run worker:media > data/worker-media.log 2>&1 &` | khóa `~/.local/share/autovideo/media-worker.lock`, nhật ký job `data/media-worker/` |
| Muse2API | container Docker `muse2api-muse2api-1`, repo `/Users/thainv/code/muse/muse2api` | `http://127.0.0.1:18610` (dashboard `/dashboard`) |
| Flow2API | container Docker `flow2api-local-flow2api-1`, repo `/Users/thainv/code/muse/flow2api` | `http://127.0.0.1:8020` (quản lý `/manage`) |
| STT Omnix | dịch vụ nội bộ | `STT_URL` |

Hai worker **không** tự khởi động cùng server. Job storyboard/video nằm mãi ở hàng đợi thì kiểm tra `media-api-1` còn chạy không; job văn bản kẹt thì kiểm tra `antigravity-worker-1`. Cách dừng/khởi động lại và xử lý lỗi: [docs/ai/OPERATIONS.md](docs/ai/OPERATIONS.md).

## Kiểm thử

Sau mọi thay đổi runtime: `npm test`, `npm run typecheck`, `npm run build`. Test dùng DB/thư mục tạm, không gọi AI, Muse hay Flow thật.

## Bản đồ tài liệu

| Tài liệu | Nội dung |
|---|---|
| [AGENTS.md](AGENTS.md) | Luật cho agent (Codex, Claude Code, Antigravity); `CLAUDE.md`, `GEMINI.md` trỏ về đây |
| [video-production-rules.md](video-production-rules.md) | Luật viết prompt và chẩn đoán video. Managed worker nạp nguyên văn file này vào mỗi job văn bản |
| [docs/ai/OPERATIONS.md](docs/ai/OPERATIONS.md) | Vận hành: worker, hàng đợi, LAN, bản hoàn chỉnh, màu, highlight, thùng rác |
| [server/API.md](server/API.md) | Hợp đồng API, biến môi trường, trạng thái |
| [WORKER.md](WORKER.md) | Nghiệp vụ từng loại job và API worker legacy (curl) |
| [WORKER-MUSE.md](WORKER-MUSE.md), [WORKER-FLOW.md](WORKER-FLOW.md) | Luật storyboard/video qua Muse2API và Flow2API. `media-api-1` cài đặt đúng các luật này; vòng lặp tay chỉ dùng khi người dùng yêu cầu |
| [docs/ai/BACKLOG.md](docs/ai/BACKLOG.md) | Việc còn lại, giới hạn đã biết |
| [docs/ai/VALIDATION.md](docs/ai/VALIDATION.md) | Nhật ký kiểm chứng theo ngày |
| [docs/ai/ROLLBACK.md](docs/ai/ROLLBACK.md) | Quay về mốc trước account pool |
| [autovideo-quy-trinh.md](autovideo-quy-trinh.md) | Sơ đồ quy trình (draw.io, HTML, PNG) |
| [docs/plans/](docs/plans/) | Kế hoạch thiết kế ban đầu, giữ để tham khảo; mã và các tài liệu trên được ưu tiên khi khác nhau |
| [docs/archive/](docs/archive/) | Tài liệu của giai đoạn làm tay trên Chrome, không còn dùng |

`cacao-smoothie-prompts.md` và `output/cacao-smoothie/` là dữ liệu của lần chạy tay đầu tiên; `npm run import:legacy` đọc file này nên giữ nguyên ở thư mục gốc.
