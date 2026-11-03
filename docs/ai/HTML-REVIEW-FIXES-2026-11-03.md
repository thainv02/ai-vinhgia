# Sửa review ảnh và voice — 03/11/2026

Theo lựa chọn của người dùng: ảnh quét lỗi giữ job chờ gán nhãn/xác nhận rồi tiếp tục chính job đó; không dựng trước khi xác nhận và không đánh dấu job thất bại.

Đã sửa:

- Bắt lỗi riêng từng ảnh, lưu mã lỗi an toàn và tiếp tục quét các ảnh khác. Không có model vision, hết quota, JSON hỏng hoặc dữ liệu mô tả sai đều chuyển ảnh sang gán nhãn. Hủy/mất lease vẫn kết thúc ngay.
- Cắt summary/text còn tối đa 600 ký tự, details 400, ở worker và server trước khi lưu.
- Thêm giao diện ảnh lỗi, ô nhãn và checkbox xác nhận toàn bộ. Nút tiếp tục chỉ bật sau khi đủ nhãn và đã xác nhận; đổi nhãn hoặc danh sách ảnh thay đổi thì bỏ xác nhận. Người dùng không phải đặt lại nhãn cho ảnh quét thành công.
- Job chờ `image_labels` không chiếm worker/render slot và không tự chạy lại. Endpoint xác nhận cập nhật mô tả đúng snapshot/hash, giữ checkpoint/ID job/phiên bản rồi tiếp tục. Dữ liệu thiếu/ngoài dự án/danh sách lỗi thay đổi bị chặn.
- Voice dùng UPDATE có điều kiện project + asset + trạng thái hiện tại và request ID riêng mỗi lượt. Callback cũ không đổi cancelled thành processing; kết quả/lỗi cũ không ghi đè lượt mới, kể cả khi chọn lại cùng asset. Thời lượng dự án chỉ cập nhật sau khi nhận kết quả đúng lượt.
- Thêm migration 018; không sửa migration 017 đã có. Kiểm tra nâng DB 017 lên 018, giữ dữ liệu và foreign key/integrity sạch.

Kiểm chứng:

- Typecheck server/web/worker và build đạt.
- 102 test liên quan đạt: ảnh lỗi với dự án không voice, model không hỗ trợ ảnh/quota/JSON hỏng, mô tả quá dài, quét tiếp ảnh khác, chờ xác nhận và resume cùng job, nhãn đủ/đúng dự án, cache và các race voice (callback bắt đầu sau hủy, đổi file, chọn lại cùng file, kết quả/lỗi muộn).
- Smoke bằng Chrome thật đạt 8 bước: tải voice + 2 ảnh, sửa transcript, giả lập một ảnh đọc lỗi, nhập và xác nhận nhãn, kiểm tra reset xác nhận khi sửa nhãn, resume cùng job, sửa ảnh thành phiên bản mới, player seek, sáng/tối, xuất MP4 H.264/AAC 720×1280 đúng 2 giây. ASR/AI giả lập; render và trình duyệt thật; không dùng credit.
- Artifact: `.build-cache/voice-smoke/result.json`, `ui-image-review.png`, `voice-video.mp4`; log test `.build-cache/qa-2026-10-31/review-fix-*.log`.

Toàn bộ `npm test` đã kết thúc: **1023 đạt, 8 lỗi, 5 bỏ qua**. Các file `html-image-review`, `html-voice`, `html-compose-e2e` và migration đều đạt trong lần chạy tổng. Tám lỗi còn lại trùng các nhóm đã có trước: file-mode Windows (`account-quota`), render/hủy (`clips-render`), fixture shell ffmpeg (`final-feedback`, `lan-feedback`), symlink EPERM (`lan-files-security`, `lan-planner`), thống kê PID/Unix ps (`lan-queue-display`, `lan-tools-parallel-integration`). Không coi toàn bộ suite là xanh.

Chưa commit, chưa đóng gói bộ cài mới.
