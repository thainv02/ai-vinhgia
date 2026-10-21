Bạn sẽ tự động tạo toàn bộ video theo kịch bản trong `docs/video-production/cacao-smoothie-prompts.md`, bằng Chrome (Claude in Chrome): dùng ChatGPT để tạo ảnh storyboard, rồi dùng Google Flow để tạo video. Đọc kỹ toàn bộ hướng dẫn này trước khi bắt đầu.

# Tài liệu phải đọc trước

1. `docs/video-production/cacao-smoothie-prompts.md`: kịch bản, gồm prompt từng clip, dòng "Upload", dòng "Khung đầu", bảng khóa nhất quán và danh sách kiểm tra.
2. `docs/video-production/claude-system-prompt.md`: các luật viết prompt và cách tìm lỗi video. Dùng khi phải chẩn đoán lỗi.

# Trang web dùng

- ChatGPT: https://chatgpt.com, dùng để tạo ảnh storyboard.
- Google Flow: https://labs.google/fx/tools/flow, dùng để tạo video.

Người dùng đã đăng nhập sẵn cả hai trang trong Chrome.

# Thư mục kết quả

Tạo thư mục `output/cacao-smoothie/` gồm:
- `storyboard/`: ảnh khung đầu, đặt tên `C1_storyboard.png`…
- `video/`: video tải về, đặt tên `C1_v1.mp4`, `C1_v2.mp4`…
- `log.md`: nhật ký. Mỗi lần tạo ghi một dòng: clip | lần | loại (storyboard/video) | lỗi thấy được | kết luận.

File tải từ trình duyệt thường rơi vào `~/Downloads`. Chuyển file sang đúng thư mục và đổi tên ngay sau mỗi lần tải.

# Quy trình cho mỗi clip, làm lần lượt C1 → C4

## Bước 1: tạo ảnh storyboard bằng ChatGPT

1. Mở một cuộc trò chuyện **mới** trên ChatGPT.
2. Upload các ảnh ghi trong dòng "Upload" của clip, đúng thứ tự. Từ C2 trở đi, **upload thêm `output/cacao-smoothie/storyboard/C1_storyboard.png` ở cuối**, để giữ cùng mặt bếp, ánh sáng và bàn tay.
3. Gửi yêu cầu theo mẫu này, điền phần trong ngoặc vuông từ kịch bản:

```
Tạo 1 ảnh tĩnh duy nhất, khung dọc 9:16, phủ kín khung hình từ mép này sang mép kia, ảnh chụp thật (photorealistic).
Đây là khung hình MỞ ĐẦU (giây 0) của clip [mã clip].
Ảnh tham chiếu: [liệt kê: ảnh 1 = …, ảnh 2 = …]. Sản phẩm phải giữ ĐÚNG như ảnh tham chiếu: không vẽ lại nhãn, chữ, logo, màu, hình dạng.
[Nếu có ảnh storyboard C1: Giữ cùng mặt bếp, ánh sáng, bố cục đồ vật và bàn tay như ảnh storyboard C1.]
Nội dung khung hình: [dán dòng "Khung đầu" của clip] — chi tiết theo mô tả sau: [dán dòng Style và dòng chủ thể trong prompt của clip].
Không có chữ, phụ đề, khung viền, ảnh lồng trong ảnh, và không chia thành nhiều ô.
```

4. Kiểm tra ảnh ChatGPT trả về:
   - đúng khung dọc 9:16;
   - chỉ một khung hình, không chia ô, không viền;
   - không có chữ nào ngoài chữ có sẵn trên bao bì;
   - hộp và gói stick giống ảnh tham chiếu;
   - đúng đồ vật và vị trí theo bảng khóa nhất quán.
5. Ảnh chưa đạt thì yêu cầu ChatGPT sửa đúng chỗ sai, tối đa 3 lần.
   - **Nhãn sản phẩm vẫn sai sau 3 lần:** bỏ storyboard cho clip đó và tạo video chỉ với ảnh tham chiếu. Ghi lý do vào log.
6. Tải ảnh đạt về, lưu thành `output/cacao-smoothie/storyboard/<clip>_storyboard.png`.

## Bước 2: tạo video trên Flow

1. Mở Flow, tạo dự án hoặc cảnh mới cho clip.
2. Upload ảnh tham chiếu đúng thứ tự ghi trong dòng "Upload", rồi **upload ảnh storyboard sau cùng**. Flow đánh số "image 1", "image 2"… theo thứ tự upload, nên thứ tự này phải khớp với prompt.
   - Nếu Flow có chế độ khung đầu (Frames to Video, Start frame), dùng storyboard làm khung đầu.
   - Nếu không có, upload storyboard như một ảnh tham chiếu ở vị trí cuối cùng.
   - Ghi vào log chế độ đã dùng.
3. Chọn khung **9:16**, độ dài **10 giây** (hoặc dài nhất Flow cho phép), số bản **3** (hoặc nhiều nhất Flow cho phép).
4. Dán **nguyên văn** khối prompt của clip. Không sửa, không dịch, không thêm chữ.
5. Bấm tạo, chờ xong, rồi tải tất cả các bản về `output/cacao-smoothie/video/<clip>_v<n>.mp4`.

## Bước 3: kiểm tra video

1. Nếu máy có `ffmpeg`, tách khung hình mỗi video, 4 khung mỗi giây, ghép thành một ảnh lưới để xem:

```
ffmpeg -i <video> -vf "fps=4,scale=360:-1,tile=5x8" -frames:v 1 <video>_grid.jpg
```

   Không có ffmpeg thì phát video trên Flow và chụp màn hình ở các giây quan trọng.
2. Chấm theo mục "Kiểm tra mỗi clip" trong file kịch bản:
   - sản phẩm đúng;
   - đúng vật lý;
   - đồ vật không tự biến mất hay tự xuất hiện;
   - không có chữ hay phụ đề;
   - chỉ một bàn tay hoặc đúng một người.
3. Kết luận cho từng bản: **Đạt**, **Sửa khi dựng** (lỗi nhỏ), hoặc **Tạo lại**. Ghi vào log.
4. Có ít nhất một bản Đạt hoặc Sửa khi dựng thì chuyển sang clip tiếp theo.
5. Tất cả các bản đều Tạo lại:
   - Lỗi chỉ xuất hiện ở một bản, các bản khác lỗi khác nhau: tạo lại y nguyên một lượt.
   - Cùng một lỗi lặp lại ở nhiều bản: sửa prompt theo luật trong `claude-system-prompt.md`. Chỉ sửa đúng chỗ gây lỗi, ghi bản prompt mới vào log, rồi tạo lại.

# Giới hạn và quy tắc an toàn

- **Ngân sách:** mỗi clip tối đa **2 lượt tạo video** (khoảng 6 bản). Hết 2 lượt mà vẫn không đạt thì dừng clip đó, ghi rõ lỗi vào log, và làm tiếp clip sau.
- **Không** mua credit, không nâng gói, không đổi cài đặt tài khoản, không bấm vào bất kỳ thứ gì liên quan đến thanh toán. Hết credit thì dừng và báo người dùng.
- Gặp trang đăng nhập, CAPTCHA, hoặc hộp thoại xác nhận lạ thì **dừng và hỏi người dùng**.
- Không đăng, chia sẻ hay xuất bản video lên bất kỳ đâu. Chỉ tải về máy.
- Không đưa vào Flow ảnh storyboard dạng lưới nhiều ô.
- Giao diện ChatGPT hoặc Flow khác với mô tả ở đây: tự tìm cách tương đương, ghi vào log, và chỉ hỏi người dùng khi không tìm được.

# Khi xong

Báo cáo ngắn cho người dùng:
- bảng các clip: bản được chọn, kết luận, lỗi còn lại;
- clip nào không đạt sau 2 lượt, và lý do;
- đường dẫn thư mục `output/cacao-smoothie/`.
