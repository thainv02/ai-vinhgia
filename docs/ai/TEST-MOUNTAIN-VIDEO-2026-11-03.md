# Kiểm thử video miền núi Việt Nam 5 phút — 03/11/2026

Kết quả: xuất MP4 thành công qua luồng thật, từ thao tác tải voice + ảnh trên giao diện đến ASR, đọc ảnh, compose, kiểm tra vision và render.

## Thành phẩm và dữ liệu đầu vào

- Video: `output/mountain-vietnam-5min-2026-11-03/mien-nui-viet-nam-5-phut.mp4`.
- 300.000 giây; H.264, 1280×720, 30 fps; âm thanh AAC; 179.266.567 byte (khoảng 179 MB).
- 6 ảnh AI tạo bằng built-in image_gen: núi đá/sông, ruộng bậc thang, biển mây, thác nước, đồi chè, bản nhà sàn. Đã sao chép vào `inputs/photo-01.png` đến `photo-06.png`; dùng tên trung tính để model tự đọc nội dung.
- Prompt đầy đủ và đường dẫn ảnh lưu ở `inputs/image-prompts.json`. Ảnh là minh họa lấy cảm hứng từ cảnh quan, không phải ảnh chụp xác nhận địa điểm cụ thể; có nhãn “Ảnh minh họa AI” trên video.
- Lời đọc: `inputs/narration.txt`. Voice mẫu tiếng Việt Hoài My được chuẩn bị qua [edge-tts](https://github.com/rany2/edge-tts/blob/master/README.md), điều chỉnh nhịp và lưu thành WAV 300 giây (`inputs/voice-nguoidung.wav`), rồi tải lên app như file voice người dùng đã có sẵn.

## Luồng đã chạy

1. Dùng Chrome và giao diện Video HTML tạo dự án khung ngang, tải 6 ảnh và voice 300 giây.
2. ASR local thật gipformer 1.5 nhận 1243 từ, 62 câu; giữ timestamp. Không thay bằng transcript dựng sẵn hoặc dùng phản hồi AI/ASR giả.
3. Sonnet đọc cả 6 ảnh thành công. Không cần nhãn thủ công.
4. Opus tạo HTML 12 cảnh bám lời đọc; Sonnet kiểm tra khung hình. Tổng 8 lời gọi API AI: 6 đọc ảnh, 1 compose, 1 vision; không cần lượt sửa lint. Policy: compose `claude-opus-5-5-high`, vision `claude-sonnet-4-6`.
5. Player trong app nhận 5 phút, seek được ở giữa video. Không có pageerror.
6. Render thật hoàn thành; xem các khung 5/55/105/155/180/205/255/295 giây: ảnh minh họa hiện theo chủ đề cảnh, chữ tiếng Việt đọc được, phụ đề tô từ đang đọc, có cảnh kết. Có cảnh báo lint về ảnh lặp trong nhiều cảnh; không có lỗi lint và không thấy ảnh bị thiếu trong các khung đã kiểm tra.
7. So âm thanh giải mã từ MP4 với WAV đầu vào: tương quan 0.999968 ở độ trễ 0 mẫu trong phép dò bước 5 ms. Voice được giữ trong đầu ra; không phát hiện lệch tổng thể bằng phép kiểm này.

So ASR với văn bản dùng tạo voice: 16 phép sửa từ / 1246 từ chuẩn, tỷ lệ khoảng 1.28%. Video giữ bản ASR thật để phản ánh chất lượng thử nghiệm; vài từ vẫn cần người dùng rà lại. Kết quả trên một giọng TTS này không đại diện mọi bản ghi âm.

Thời gian riêng render: khoảng 18 phút 11 giây, 1 renderer worker. Trong phiên còn chạy test FFmpeg song song; đây là số đo phiên thử, không phải benchmark độc lập.

## Điều chỉnh để hỗ trợ video dài

- Thêm migration 019 (không sửa migration cũ): giới hạn HTML/voice tối đa 600 giây, thời lượng REAL, nâng DB cũ giữ meta/FK/integrity.
- Đồng bộ giới hạn API và UI.
- Phụ đề dài dùng file JS dữ liệu gọn do app quản lý: index 8367 byte, file phụ đề 43104 byte, đều dưới trần 256 KB/file. Tiếp tục dùng logic gom từ Cắt clip và timestamp ASR; tạo DOM bằng textContent, seek tất định.

## Kiểm tra mã nguồn

- Typecheck và build đạt.
- 130 test liên quan đạt (10 file), gồm migration cũ, voice/ảnh và 2000 từ trên video 5 phút không vượt giới hạn manifest.
- Toàn bộ npm test: 1023 đạt, 10 lỗi, 5 bỏ qua. Các nhóm HTML dài, HTML core, voice và migration đều đạt. Lỗi còn lại thuộc các nhóm Windows/filemode/symlink/PID, fixture shell FFmpeg và timeout render/preview đã có trước; toàn suite chưa xanh.
- Artifact máy: `test-result.json`, `audit.json`, `audio-check.json`, transcript ASR, ảnh giao diện và khung trích nằm cạnh MP4. DB kiểm thử riêng tại `.build-cache/mountain-video/data`; không chạy job trong DB người dùng, không lưu key vào artifact.

Chưa commit hoặc đóng gói bộ cài Windows mới.
