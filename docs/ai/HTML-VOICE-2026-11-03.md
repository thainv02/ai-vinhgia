# Video HTML từ voice và bộ ảnh — 03/11/2026

Đã triển khai trong tab Video HTML. Khi tạo dự án, bật **Dựng theo lời đọc có sẵn**, tải audio/video có tiếng và bộ ảnh. App nhận dạng trước để người dùng nghe, kiểm tra và sửa chữ. Sau đó bấm **Để AI tạo video**; xem bản dựng, đổi ảnh từng cảnh qua trường chỉnh nhanh, rồi xuất MP4.

## Hành vi

- ASR dùng backend local/Omnix đã cấu hình của app; tái sử dụng `buildTranscript`, giữ timestamp từng từ. Sửa chữ không cho sửa thời gian. Không gọi AI viết lại phụ đề.
- Thời lượng lấy từ file voice, giữ phần thập phân. Giới hạn hiện tại 1–60 giây, theo giới hạn Video HTML đang có.
- Quét ảnh gốc bằng model vision do server chọn trước compose. Ảnh được thu nhỏ tối đa 1024px. Lưu mô tả, chữ đọc được, chi tiết sản phẩm và trạng thái không chắc chắn vào asset. Lần sau dùng cache. Tối đa 30 ảnh mới mỗi lần tạo.
- Model compose nhận mô tả ảnh và các câu ASR có timestamp để chọn ảnh, chia cảnh và viết chuyển động. Người dùng không bắt buộc đặt tên/nhãn. Prompt yêu cầu biến ảnh riêng có nhãn khoảng giây để đổi lại từng cảnh.
- App tự chèn voice và phụ đề, không giao AI viết timestamp phụ đề. Tái sử dụng `displayWords/groupWords` của chức năng Cắt clip; mỗi từ là một clip phụ đề tĩnh chứa cả cụm và tô từ đang đọc. Cách này seek xuôi/ngược không phụ thuộc trạng thái GSAP.
- Audio/phụ đề/transcript được snapshot theo phiên bản. Đổi/bỏ voice chỉ ảnh hưởng lần tạo sau. Bản cũ và bản sửa biến vẫn giữ voice cũ, kể cả file gốc đã bị xóa.
- Trích audio, ASR và thumbnail đi qua hàng đợi xử lý chung, tuân theo `RENDER_CONCURRENCY`. Có hủy, chặn xóa nguồn đang dùng, giải phóng khóa khi xong/hủy và báo thử lại nếu đóng app giữa nhận dạng.
- Migration mới `017_html_voice.sql`: thêm bảng voice và cột cache/snapshot; không sửa migration cũ.

## Kiểm chứng

- `npm run typecheck`: đạt server/web/worker.
- `npm run build`: đạt.
- Nhóm HTML/voice/migration liên quan: **139 đạt, 1 bỏ qua**, 9 file.
- Nhóm migration và dữ liệu cũ chạy lại: **65 đạt**, 5 file, sau khi cập nhật danh sách migration kỳ vọng trong test. Có kiểm tra DB 016 nâng lên 017, foreign key và integrity.
- Kiểm thử trình duyệt Chrome thật: **7 bước đạt**. Tạo dự án bằng giao diện, tải voice + 2 ảnh, nhận dạng, sửa chữ, worker quét ảnh và compose, đổi ảnh tạo phiên bản mới, player nạp thời lượng và seek được, giao diện sáng/tối không tràn ngang, xuất MP4 thật có audio.
- MP4 kiểm chứng: H.264 720×1280 + AAC, **2.000 giây**. Đã xem khung 0.2/0.6/1.2 giây: từ được tô sáng thay đổi đúng mốc ASR. ASR và AI trong smoke test dùng dịch vụ giả lập; không tốn credit và chưa đánh giá độ chính xác nhận diện/chọn ảnh của model thật trong lần triển khai này.
- Cache ảnh có test qua API AI giả: lần tạo đầu đọc ảnh, lần tạo tiếp theo chỉ compose và không quét lại.

Đã chạy toàn bộ `npm test`: kết quả thô **1004 đạt, 15 lỗi, 5 bỏ qua**. Trong 15 lỗi có 4 kỳ vọng migration cũ và 1 thiết lập test hàng đợi mới; đã sửa và các nhóm chạy lại ở trên đều đạt. Các lỗi ngoài phần này vẫn xuất hiện ở file-mode Windows, symlink EPERM, thống kê PID/Unix `ps`, fixture ffmpeg shell và render/hủy/cleanup. Không coi toàn bộ suite là xanh.

Log và artifact cục bộ: `.build-cache/qa-2026-10-31/voice-*.log`, `.build-cache/voice-smoke/result.json`, video `voice-video.mp4`, các khung `frame-*.jpg` và ảnh giao diện sáng/tối. Thư mục kiểm chứng không chứa key thật; không chạy worker trên DB dữ liệu người dùng.

Chưa commit và chưa đóng gói bộ cài Windows mới.
