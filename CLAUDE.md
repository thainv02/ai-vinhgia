# Autovideo

Đọc `AGENTS.md`. Quy tắc dùng chung nằm trong `video-production-rules.md`; không duy trì một bản quy tắc riêng cho Claude.

Storyboard/video do worker nền `media-api-1` làm, việc văn bản do managed worker làm (xem `README.md`). Claude Code chỉ chạy vòng lặp worker legacy (`WORKER.md` + `WORKER-MUSE.md`/`WORKER-FLOW.md`) khi người dùng yêu cầu, sau khi kiểm tra `media-api-1` có đang chạy không. Vận hành: `docs/ai/OPERATIONS.md`.
