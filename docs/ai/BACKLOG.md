# Việc tạm hoãn

## Chất lượng edit tự động bằng Gemini (22/10/2026)

- Đã sửa: edit_plan hỏng ngay với video Flow thật (dài 10,005 giây) vì vòng lặp tạo lưới khung hình chạy thêm đoạn đuôi giây 10 không có khung nào. Đã thêm `gridStarts()` trong `worker/src/runner.ts` và test.
- Lần chạy thật đầu tiên (kế hoạch LAN "Mẫu thử – Cacao Actiso", bản v2): Gemini 3.8 Flash High cắt bỏ C1 0–3 giây với lý do "nhảy máy". Thật ra đó là cú chuyển shot rộng → cận có chủ đích trong prompt, và chứa hành động chính là kéo cắt gói stick.
- Cần sửa: chỉ dẫn edit_plan phải nói rõ rằng chuyển shot đã ghi trong prompt (`Shot 1…`, `Shot 2…`, `Cut:`) không phải lỗi, và cấm cắt các hành động chính ghi ở `Action:` hay các dòng Shot. Chỉ cắt khoảng thừa và lỗi hình thật. Người dùng vẫn sửa được bằng trình chỉnh điểm cắt.

## Thùng rác dự án: việc còn lại (22/10/2026)

- Xoá dự án chỉ chuyển file bằng `rename` trong cùng ổ đĩa. Nếu `refs/` hoặc `output/.trash` nằm ở ổ khác (EXDEV) thì xoá bị hoàn tác với lỗi `TRASH_MOVE_FAILED`; chưa có đường sao chép-rồi-xoá.
- Nếu chuyển file thất bại sau khi commit, các job `queued` đã bị hủy lúc xoá không được mở lại (chủ máy bấm duyệt lại); chỉ `deleted_at` được hoàn tác.
- Xoá vĩnh viễn cũng xoá `credit_ledger` của dự án (khóa ngoại CASCADE): tổng credit đã dùng trước đây của dự án đó không còn trong sổ. Nếu cần lưu số liệu kế toán lâu dài thì xuất CSV (`GET /api/projects/:id/ledger.csv`) trước khi xoá vĩnh viễn, hoặc thêm bảng tổng hợp credit tách khỏi dự án.
- Thư mục `output/.trash/` còn sót (vd sau khi khôi phục mà còn file lạ) không có bộ dọn mồ côi; hiện chỉ thư mục của dự án đang trong thùng rác được xoá khi xoá vĩnh viễn.
- Hàng đợi/hạn mức xoá LAN (10 lần/giờ/IP) giữ trong bộ nhớ như các hạn mức LAN khác. Quyền xoá LAN dựa trên cookie client (không phải danh tính): mất cookie là mất quyền xoá kế hoạch cũ của mình.
- Trang Thùng rác không có chọn nhiều/xoá hàng loạt và không báo trước khi sắp quá hạn (chỉ hiện số ngày còn lại, đỏ khi ≤ 3 ngày).

## Góp ý cho AI và chỉnh màu (26/10/2026)

- Đã làm: góp ý → phiên bản mới + job `edit_plan` (`payload.revision`), chỉnh màu ffmpeg SAU xoá logo, chỉnh màu tay + xem trước, lịch sử phiên bản dạng chuỗi (app chính và LAN). Migration 012 dựng lại bảng `final_cuts` (CHECK `stage`/`failed_stage` thêm `grade`) và thêm `parent_id`, `feedback`, `grade`, `revision`, `base_path`.
- Chưa kiểm chứng với AI thật: bảng quy đổi "ấm hơn/tương phản/tối quá" trong `worker/src/revision.ts` chỉ được test logic thuần. Cần chạy thử vài góp ý thật (managed worker) rồi chỉnh bước số trong chỉ dẫn nếu AI đổi quá tay/quá nhẹ.
- Panel chỉnh màu tay chưa có chỉnh riêng từng cảnh (chỉ giữ và bỏ các mục `scenes` có sẵn; muốn chỉnh riêng cảnh thì viết ở ô góp ý). Có thể thêm thanh trượt theo cảnh.
- Không xoá được từng phiên bản; mỗi phiên bản chỉnh màu giữ một bản giao (~ kích thước bản gốc) cộng `_base` (hard link). Chỉ xoá cả dự án mới giải phóng. Cần "dọn các bản cũ" nếu ổ đĩa chật.
- Hard link `_base.mp4` giả định cùng ổ đĩa (đã dự phòng sao chép). Bản đã chỉnh màu mà chưa xoá logo (tool xoá logo tắt lúc dựng) không xoá logo sau được (`409 GRADED_CUT`): phải "Edit tự động" lại.
- Gamma của ffmpeg `eq` ngược thông lệ (cao hơn = sáng hơn): giao diện và prompt đã ghi rõ; nhiệt độ màu được đối xứng quanh 6500K để cao hơn = ấm hơn.
- Ảnh xem trước dùng `-ss` + `-copyts` từ bản sạch; clip rất dài sẽ chậm hơn (hiện clip ngắn ≤ ~1 phút nên nhanh).
- `sim-worker` đọc `.env` thật của repo khi chạy (không dùng trong lần kiểm thử này; smoke dùng AI giả viết bằng HTTP).

## Màu theo ảnh mẫu và file LUT (26/10/2026)

- Đã làm: `Grade.match` (ảnh mẫu hoặc LUT `.cube`) áp bằng `lut3d` trước các chỉnh khác; chuyển màu Reinhard CIELAB tất định (chế độ color/full, cường độ, khớp riêng từng cảnh); bảng `color_refs` (migration 013), API app chính + LAN, giao diện trong GradePanel, chip có thumbnail ở lịch sử, AI giữ `match`.
- **Không gian chuyển màu: lαβ (đã đổi từ CIELAB sau đánh giá 26/10/2026).** CIELAB làm vùng trắng/xám sáng ngả hồng/tím (ảnh bao bì cacao) vì vết ám nhân theo kênh trong ánh sáng tuyến tính không phải độ lệch đều của a*, b*. Đo trên 3 ảnh thật (sb37 + 2 ảnh MOCKUP_BOX) × 4 vết ám nhân tuyến tính không cắt xén (cool/warm/green/magenta), ảnh mẫu = ảnh gốc (kết quả lý tưởng = ảnh gốc), cường độ 100%, chế độ color, trung bình 12 ca: ΔE00 CIELAB 8,11 / lαβ giữ l 6,24 / **lαβ giữ Y 6,29**; ΔE chỉ sắc (a*,b*) 4,73 / 1,53 / **1,53**; |ΔL* so với nguồn| 0,07 / 3,05 / **0,07**; lệch a*,b* của vùng trung tính (C*<6, L*>70) so với ảnh gốc 5,18 / 1,67 / **1,59**. Chọn **lαβ + giữ độ chói Y + σ sắc 0,8–1,25** (bản chỉ giữ kênh `l` làm L* lệch ~3 và hỏng tiêu chí giữ độ chói; σ chặt không đổi số trên các ca này nhưng an toàn hơn khi ảnh mẫu rất ít màu hoặc rất rực). Luma Y' của YUV lệch 2,3% (L* 1,1%) trên clip thử xanh lạnh → cam. Cần biết: (1) khi vết ám làm **cắt xén vùng sáng** (kênh nhân > 1) thông tin đã mất, lαβ KHÔNG khôi phục tốt hơn CIELAB (ca g-cool: lệch trung tính 10,4 so với 4,6 của CIELAB); (2) **khác nội dung** (ảnh mẫu là cảnh khác): kết quả khớp trung bình toàn ảnh nên trắng trong cảnh ánh sáng ấm vẫn lạnh tương đối so với trung bình ấm; đây là giới hạn của chuyển thống kê toàn cục ở mọi không gian.
- Ngoài gam sRGB thì giảm độ đậm (giữ L* và hướng sắc) nên ảnh mẫu rất rực sẽ cho kết quả nhạt hơn mong đợi ở vùng sáng/tối; chưa có thanh "đẩy độ đậm".
- Xem trước 3 mốc 15/50/85% có thể không rơi vào đủ các cảnh khi khớp từng cảnh; chưa có chọn vùng ảnh mẫu (crop) hay trộn nhiều ảnh mẫu.
- LUT 33³ ghi ~0,9 MB/file dạng văn bản; khớp từng cảnh ×số cảnh (tối đa 40). Bộ nhớ đệm `luts/` dọn khi vượt 80 file (chỉ file > 1 giờ). Chưa có dọn `color-refs/` mồ côi (chỉ xoá từng ảnh bằng tay trong giao diện hoặc theo dự án).
- Thống kê video lấy từ 12 khung bằng 12 lần gọi ffmpeg (4 song song); video rất dài sẽ chậm hơn (hiện clip ≤ ~1 phút nên chưa đáng kể). Thống kê được nhớ trong bộ nhớ theo (file, kích thước, mtime) nên kéo thanh cường độ khi xem trước nhanh.
- Chưa kiểm chứng với máy LAN thật (smoke chỉ dùng trình duyệt headless trên máy dev) và với AI thật cho các góp ý "giống ảnh mẫu hơn/nhẹ thôi" (chỉ test logic thuần và đường server).
- Giao diện: dán ảnh (Ctrl/Cmd+V) bắt sự kiện ở cấp trang khi panel Chỉnh màu mở và con trỏ không ở ô nhập chữ; trên điện thoại chưa có nút "Dán" riêng.

## Cắt clip từ video dài: việc còn lại (27/10/2026)

Đợt 1 (P1–P3 + LAN cơ bản) đã xong: nhận dạng qua STT nội bộ, AI chọn đoạn (`clip_plan`), duyệt/sửa điểm cắt trên lời thoại, dựng 9:16 `center`/`fit` có phụ đề ASS chạy theo từng từ, ZIP, LAN. Chưa làm (theo `PLAN-long-video-to-shorts.md`):

- **P4 – Reframe bám mặt/người nói** (MediaPipe Face Detection + Face Mesh, tracker IoU tất định, chọn người nói theo cử động miệng + năng lượng âm, vùng chết + làm mượt, cắt cứng ở chuyển cảnh `scdet`, kẹp cả 4 cạnh, `sendcmd` trong cùng một lượt ffmpeg, xem trước khung cắt, chế độ `manual`). Dữ liệu đã chừa chỗ: `clip_cuts.reframe` là JSON `{mode, ...}`.
- **P5 – Chỉnh màu / màu theo ảnh mẫu / góp ý AI cho từng clip** (`clip_revise`, dùng lại `grade.ts`, `color-match.ts`): cột `clip_cuts.grade`, `parent_id`, `feedback` đã có sẵn nhưng chưa dùng.
- **Chế độ video ít lời** (`speech_ratio` < 0.3): chọn đoạn theo hình (cảnh từ `scdet` + lưới khung hình như `edit_plan`). Hiện chỉ có `speech_ratio` trong `source` để giao diện cảnh báo; `clip_plan` vẫn chạy theo lời thoại (kết quả kém, thậm chí `NO_SPEECH`).
- **Đổi số đọc thành chữ → chữ số** trong phụ đề ("hai mươi phần trăm" → "20%"). Hiện giữ nguyên chữ ASR vì đổi sẽ làm mất ánh xạ từ ↔ mốc thời gian (phần khôi phục dấu câu bắt buộc giữ nguyên dãy từ). Cần cơ chế gộp mốc nhiều từ thành một từ hiển thị (đã có cho từ ẩn: thời gian cộng vào từ đứng trước).
- **Chuẩn hoá tên riêng/thuật ngữ sau nhận dạng**: hiện chỉ truyền `stt_terms` làm `prompt` cho STT và cho AI chọn đoạn; sửa lỗi nghe nhầm ("a tiso" → "Actiso") làm tay ở ô sửa phụ đề.
- **ffmpeg có libass chưa có trên máy chạy thật**: ffmpeg Homebrew hiện tại không có bộ lọc `subtitles`; cần `brew install ffmpeg-full` (hoặc đặt `CLIP_FFMPEG_PATH`) thì "Dựng clip" mới cháy được phụ đề. Nên thêm bước kiểm tra này vào hướng dẫn cài đặt.
- **Phục hồi video gốc LAN đã xoá**: sau `LAN_CLIP_SOURCE_RETENTION_DAYS` ngày không dựng/chọn đoạn mới được; chưa có "tải lại đúng file để khôi phục" (tải lại cùng hash khi đã có clip hiện báo `SOURCE_EXISTS`).
- **Sửa lỗi AI chọn 0 clip đã có test hồi quy**: đo khoảng lặng thật (RMS tự điều chỉnh + silencedetect), câu mịn ≤12 s/30 từ, câu trích đầu/cuối → chỉ số từ (worker/server dùng chung bộ dò), sửa trong cùng ID, retry mạng/timeout tối đa 2 lần và viết hoa phụ đề thận trọng. Có fixture transcript 318 từ + khoảng lặng đo từ video thử trước; gateway giả kiểm chứng cả kiểm định ảnh, sửa và khôi phục dấu câu. Không đổi ID của transcript/clip cũ.
- **Kiểm định AI chưa nghiệm thu lại với Gemini thật**: prompt, cách tính `keep/standalone_score`, sửa một lần, khôi phục dấu câu mới được test bằng gateway giả. Cần chạy thử trên 1–2 video thật (livestream bán hàng và podcast) rồi chỉnh prompt; mục tiêu nghiệm thu của plan: ≥ 3/5 clip "dùng được", ≥ 80% clip mở đầu hiểu được khi không có ngữ cảnh.
- **Nhận dạng**: dịch vụ không trả %, tiến độ chỉ là ước tính; không có chia nhỏ audio nên video 3 giờ là một lần gọi (65 MB mp3). `GET /v1/stt/jobs/{id}` hiện không trả mốc từng từ nên không dùng để khôi phục giữa chừng (phải gửi lại file); nếu dịch vụ bổ sung `words` ở endpoint này thì khôi phục sẽ nhanh hơn.
- **Giấy phép gipformer** (model phía sau dịch vụ STT): README/HF ghi MIT nhưng repo không có file LICENSE và không công bố dữ liệu huấn luyện. Dùng nội bộ thì chấp nhận được; trước khi phân phối ra ngoài phải hỏi tác giả.
- Chưa có xoá từng clip/bản dựng (chỉ "Bỏ" = `rejected`); mỗi bản dựng giữ một mp4 trong `output/<slug>/clips/clips/` cho tới khi xoá dự án.
- Upload qua Vite dev proxy / trình duyệt không có tiếp tục (resume) khi đứt mạng với file nhiều GB; cần tải lại từ đầu.

