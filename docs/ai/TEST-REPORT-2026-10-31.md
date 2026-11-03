# Kiểm thử AI Vinh Gia — 31/10/2026

Cập nhật: 00:55:02 31/10/2026 (UTC+7).

**Kết luận: chưa đủ điều kiện phát hành.** UI và nhiều luồng chính hoạt động, nhưng capture HTML có lỗi runtime được tái hiện và bộ test tổng còn lỗi. Không sửa runtime trong lượt kiểm thử này.

## Phạm vi và cách ly

- Windows, DB/dữ liệu/profile trình duyệt tạm; không dùng DB hoặc profile sản xuất.
- Không chạy worker nhận job sản xuất, không gọi AI/Flow thật, không tiêu credit. Các test ghi tên ChatGPT/Flow dùng trang fixture được route giả lập trong profile riêng.
- Media thật chỉ dùng file mẫu cục bộ; browser cho Video HTML được tải riêng và kiểm SHA256.
- AI compose/vision/STT dùng mock/fixture; chưa đánh giá chất lượng model hoặc nhận dạng giọng nói thật.

## Kết quả

| Hạng mục | Kết quả |
|---|---|
| Smoke cơ bản | Đạt |
| Typecheck server/web/worker | Đạt |
| Build web/server/worker | Đạt |
| Cú pháp bộ cài Inno Setup (không tạo installer) | Đạt |
| Bộ test tổng (npm test, maxWorkers=2) | 1096 đạt / 11 lỗi / 9 bỏ qua; 84 file |
| UI Chrome/profile tạm | 10/10 đạt; 0 JS exception; 0 request ngoài bị phát hiện |
| HTML browser/render thật | 18 đạt / 1 lỗi / 0 bỏ qua; 3 file |
| Chạy riêng lại test cache preview | 1 đạt / 0 lỗi / 17 bỏ qua; 1 file |
| Build native Tauri | Không thực hiện được: cargo metadata báo program not found; chưa có exe mới để nghiệm thu WebView2 |

Bộ tổng còn **239 unhandled errors**; log cho thấy bộ đếm tiến trình trong lan-tools-parallel-integration gọi ps Unix rồi đọc stdout.split trong timer. Không coi bộ tổng là đạt dù nhiều assertion đã qua.


UI đã xác nhận: tên/logo/favicon mới; 5 tab; lưu nháp kế hoạch/tải lại; tạo dự án clip; form HTML (mẫu/tỉ lệ/model/chặn khi thiếu key); cài bộ dựng; đổi theme/tải lại. Không có job AI nào được tạo trong smoke UI.

## Lỗi runtime đã tái hiện: capture Video HTML

- `server/src/services/html/engine-runner.ts`: NETWORK_LOCKDOWN_ARGS dùng host-resolver-rules MAP * ~NOTFOUND nhưng chỉ loại localhost khỏi luật.
- Capture điều hướng tới HTTP 127.0.0.1:<port>/index.html và thất bại ERR_NAME_NOT_RESOLVED. MP4 fixture vẫn dựng được: h264, 720×1280, 30 fps, 2 giây; cả 4 template 3 giây cũng xuất được MP4.
- Đã chạy test độc lập với browser ghim: policy hiện tại không tải được trang test qua 127.0.0.1; phương án thử có EXCLUDE localhost, EXCLUDE 127.0.0.1 và EXCLUDE [::1] tải được cả localhost/127.0.0.1. Chỉ thử phương án trong harness, chưa sửa source.
- Ảnh hưởng: thumbnail/capture cho vision có thể bị bỏ qua hoặc báo lỗi; không được coi là pipeline đã đạt đủ.
- Preview origin riêng đã qua kiểm tra browser: chặn fetch/XHR/WebSocket/ảnh sang API khác; trang lạ không nhúng được preview. Hủy renderer thật đã đạt.

## Các test chưa đạt trong bộ tổng

| File | Trường hợp | Phân loại / ghi chú |
|---|---|---|
| server/test/account-quota.test.ts | quota collector nâng cấp management key local không chạm OAuth hoặc access key | Ràng buộc quyền file POSIX không tương đương trên Windows. |
| server/test/clips-render.test.ts | hủy, khôi phục, hàng đợi hủy giữa chừng: ffmpeg bị dừng, trạng thái cancelled, xoá file dở (mp4 tạm, srt, ass); dựng lại được với version mới | Test dùng ps Unix rồi đọc stdout trên Windows; log còn có cảnh báo EBUSY khi dọn file vừa hủy. |
| server/test/clips-render.test.ts | hủy, khôi phục, hàng đợi hàng đợi chung: concurrency 1 → bản thứ hai chờ (position 1) rồi chạy; app đứng trước LAN | Timeout 120 giây khi tạo/render các video fixture 300 giây; chưa xác định hoàn toàn do tải máy hay vòng đời tiến trình. |
| server/test/final-feedback.test.ts | hủy giữa bước chỉnh màu, thử chỉnh màu lại, khởi động lại khởi động lại giữa lúc chỉnh màu → failed + failed_stage=grade (dọn file tạm); lỗi ffmpeg → failed ở bước grade, bản cha nguyên vẹn | Fixture ffmpeg-broken.sh dùng shell Unix; Windows không chạy fixture như dự kiến và resolver có thể fallback sang ffmpeg thật. |
| server/test/final-feedback.test.ts | xem trước trước/sau chặn: grade sai 400, bản chưa ready 409, bản không tồn tại 404; bộ nhớ đệm giới hạn số ảnh | Timeout khi chạy toàn bộ; chạy riêng lại đạt. Chưa tái hiện lỗi chức năng cache. |
| server/test/lan-config.test.ts | mã truy cập LAN ensureLanAccessCode: ghi vào .env (0600) khi thiếu, giữ nguyên các dòng khác; có sẵn thì không đổi | Ràng buộc quyền file POSIX không tương đương trên Windows. |
| server/test/lan-feedback.test.ts | LAN: góp ý cho AI + chỉnh màu lỗi chỉnh màu (ffmpeg hỏng) → failed_stage=grade, thông báo không lộ đường dẫn; /regrade chạy lại | Fixture ffmpeg-broken.sh dùng shell Unix; Windows không chạy fixture như dự kiến và resolver có thể fallback sang ffmpeg thật. |
| server/test/lan-files-security.test.ts | /lan/files: danh sách cho phép mở rộng CHỈ như spec phục vụ: video lan_upload của cảnh LAN; KHÔNG phục vụ: video do worker/chủ máy tạo cho cảnh LAN, video và file bản dựng của dự án app, file mồ côi, symlink ra ngoài, traversal | Test cần quyền symlink/Developer Mode trên Windows; chưa kết luận lỗ hổng runtime. |
| server/test/lan-planner.test.ts | phục vụ file: chỉ ảnh của kế hoạch LAN và storyboard người dùng LAN tải lên file của dự án app, video/output khác, storyboard do worker tạo, file mồ côi, traversal và symlink đều 404 | Test cần quyền symlink/Developer Mode trên Windows; chưa kết luận lỗ hổng runtime. |
| server/test/lan-queue-display.test.ts | việc xoá logo LAN trong hàng đợi render song song RENDER_CONCURRENCY=2: hai việc xử lý cùng lúc (queue_state=running), việc thứ ba chờ vị trí 1; hủy một việc đang chạy thì việc chờ bắt đầu; status báo hàng đợi | Test tìm lan-tools/<id>/ trong argv dùng dấu gạch chéo ngược trên Windows; lookup không thấy rồi đọc pid. Các assertion queue trước đó đã qua. |
| server/test/lan-tools-parallel-integration.test.ts | hai tiến trình xoá logo THẬT chạy song song RENDER_CONCURRENCY=2: hai clip ngắn xử lý cùng lúc bằng tool thật, cả hai ra bản sạch hợp lệ, không lẫn file | Hai output thực tế ready; kiểm đếm tiến trình sống trả 0 nên assertion concurrency chưa đáng tin trên Windows. |

Lỗi thực tế bổ sung trong nhóm browser/render HTML:

- server/test/html-engine-render.test.ts — engine thật (cần HTML_RENDERER_BROWSER) lint đạt, dựng 720p (720x1280, 30 fps, 2 s) và chụp khung: AppError: Bộ dựng lỗi (mã 1): net::ERR_NAME_NOT_RESOLVED at http://127.0.0.1:49601/index.html.

Không coi lỗi test thiếu quyền symlink hoặc kiểm quyền POSIX là bằng chứng bảo mật đã đạt; cần sửa test phù hợp Windows và chạy lại. Các timeout và cảnh báo EBUSY khi hủy/dọn media cần kiểm tra lại với tải máy thấp.

## Bằng chứng và cách chạy lại

- Thư mục: `.build-cache/qa-2026-10-31/`.
- `all-tests.json`, `all-tests.log`: kết quả tổng và stack trace.
- `html-real.json`, `html-real.log`: fixture render/capture/browser.
- `network-results.json`: tái hiện DNS/loopback và policy thử.
- `ui-results.json`, `ui-*.png`: kiểm tra UI và ảnh chụp các tab/form.
- `retry-preview-cache.json`, `typecheck.log`, `build.log`, `native-build.log`, `installer-syntax.result.json`: kiểm tra bổ sung.
- Harness `run-check.mjs`: môi trường QA không chứa credential sản xuất, giới hạn thời gian, dừng cây tiến trình chỉ của lượt test khi quá hạn.

## Tắt máy

Đã gửi lệnh Windows shutdown /s /t 60 theo yêu cầu người dùng sau khi lưu kết quả và đóng các tiến trình kiểm thử. Đây là ghi nhận hệ điều hành đã nhận lệnh; không thể kiểm chứng trạng thái máy sau khi nguồn đã tắt.
