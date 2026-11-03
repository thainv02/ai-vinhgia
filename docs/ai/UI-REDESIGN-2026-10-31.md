# Triển khai giao diện theo docs/design — 31/10/2026

## Phạm vi

Ba agent phụ dùng **GPT-6 Luna** thực hiện các phần độc lập: kế hoạch/hậu kỳ, cắt clip và Video HTML. Agent chính tích hợp khung ứng dụng, thành phần dùng chung, Cài đặt, Xoá logo Veo, splash và kiểm tra trình duyệt.

Tham chiếu: [README thiết kế](../design/README.md). Lấy cấu trúc, nội dung và trạng thái từ thiết kế; giữ bảng màu của `web/src/planner/desktop.css` (tối đen/trắng/xám, sáng xanh dương/trắng, đỏ cho lỗi). Không import CSS của canvas, không sửa các file thiết kế.

## Các phần đã chỉnh

| Nhóm màn | Thay đổi |
|---|---|
| Khung app / Main | Sidebar có thể thu gọn và lưu lựa chọn, điều hướng Cài đặt cùng nhóm chính, giữ Gần đây của kế hoạch/clip, trạng thái AI và render tách riêng, hiển thị số việc đang chạy/tối đa |
| Foundations / Common | Nhãn AI/TRÊN MÁY/MỞ NGOÀI; lý do khoá nút tại chỗ gắn với `aria-describedby`; nhịp chữ/khoảng cách; focus bàn phím; dialog/toast/rỗng/lỗi; xác nhận XOA khi xoá vĩnh viễn |
| PlanNew / Main | Form hai cột nội dung và ảnh, trạng thái từng bước gửi, hành động cuối form; bố trí tìm/lọc danh sách và hướng dẫn luồng ChatGPT/Flow |
| PlanScene1–3 / PlanRequest | Ngữ cảnh cảnh đang chọn, tiến độ cảnh có video, nhãn mở ngoài, giữ prompt nguyên văn, upload/kiểm tra video, lý do chưa thể dựng; cảnh báo tác động khi phân tích lại |
| Final / FinalCuts / FinalFeedback / FinalColor | Giữ player/timeline/phiên bản/điểm cắt/màu/ảnh mẫu/LUT; thêm ngữ cảnh bản cha, nhãn xử lý, badge kết quả cũ, lý do khoá và hành động phục hồi tương ứng |
| Clips / ClipSource / ClipWorkspace / ClipAI | Bố cục danh sách/workspace đáp ứng, nhãn AI/nhận dạng/dựng trên máy, giới hạn upload ưu tiên dữ liệu server, lý do khoá nút; giữ luồng transcript/chọn từ/dựng cũ |
| ClipCaptions / ClipSettings | Mốc từ và bản nhận dạng gốc rõ ràng, từ ẩn có nét đứt, khoá trường khi lưu, lưu/dựng có nhãn; XOA trước khi xoá; điều chỉnh mép hộp phụ đề bằng phím mũi tên |
| Html / HtmlDetail / HtmlFiles | Giữ tên Video HTML; form/danh sách, ba vùng xem trước/chỉnh nội dung/lịch sử; hai tab Xem trước và Tệp/xuất MP4; chọn phiên bản sẵn sàng khi xuất, dung lượng tệp, tên file mono xuống dòng; hai panel vẫn mounted khi đổi tab để giữ tiến trình |
| Tool | Vùng tải nhiều file, danh sách công việc và vùng kết quả riêng, số việc chạy/chờ, hạn lưu; phân biệt huỷ upload với huỷ việc đã vào hàng đợi |
| Settings | Các thẻ AI/STT/bộ dựng/xoá logo và hàng đợi/theme, trạng thái chỉ đọc, model select chờ kiểm tra key, lý do chưa lưu được, phân biệt thiếu bộ dựng MP4 với xem trước |
| System | Splash có tên/logo, trạng thái khởi động dịch vụ trên máy, lỗi và chi tiết kỹ thuật thu gọn được; giữ hộp thoại chọn thư mục và bộ cài Windows hiện có |

## Phần không mở rộng

Giữ các mục “Đề xuất” chưa được duyệt ngoài đợt triển khai: đổi tên Video HTML, thêm HTML vào Gần đây, bỏ ô tên người tạo clip, menu transcript mới, nối huỷ AI, thêm lối mở dữ liệu/log trong trang Cài đặt. Không thêm chức năng ở danh sách ngoài phạm vi của README.

Bộ cài và hộp thoại chọn thư mục vẫn là giao diện Windows native; chưa thay bằng các màn React mới. Bộ cài hiện đã có cách đóng gói model có sẵn, nên không đưa thông báo tải model giả trong thiết kế vào runtime. Không tạo thêm nút thử lại dịch vụ trên splash khi chưa có cơ chế khởi động lại tương ứng.

## Kiểm chứng

- `npm run typecheck`: đạt ở lượt kiểm tra tích hợp.
- `npm run build`: đạt ở lượt kiểm tra tích hợp; Vite có cảnh báo bundle lớn hơn 500 kB.
- Kiểm tra trình duyệt Edge headless với API giả, **không chạy server/worker thật và không gọi inference**: 25 ảnh chụp, không lỗi JavaScript và không request API ngoài fixture trong lượt thành công.
- Kiểm tra thu gọn sidebar, XOA trước xoá (không gửi lệnh xoá), chuyển theme, mở chỉnh màu/điểm cắt, thay bề rộng phụ đề bằng phím và lưu qua PATCH giả, tab HTML bằng phím mũi tên, hai panel HTML không bị unmount và kích thước nội dung ở viewport 1024×680. Các màn chính được chụp thêm ở 1440×900.
- `git diff --check` trong các phần giao diện đã sửa: đạt.
- `npm test -- -- --maxWorkers=2`: hoàn tất sau khoảng 617 giây với DB test tạm: **981 đạt, 10 lỗi, 10 bỏ qua** (71 file đạt, 8 lỗi, 2 bỏ qua); có thêm 405 lỗi không được bắt. Một nguồn lỗi lặp là helper `liveGwrProcesses` gọi `ps -A -o command=` rồi `.split()` trên stdout không hợp lệ trong môi trường Windows. Các lỗi khác nằm ở hậu kỳ/FFmpeg, hàng đợi, filesystem và tài khoản. Không coi đây là một bộ test đạt toàn bộ; không sửa backend/test backend trong đợt UI này. Kết quả chi tiết xem log bên dưới.

Các kiểm tra sử dụng dữ liệu giả, không thay thế việc chạy quy trình sản xuất thật trên bộ cài Windows. Chưa build/cài `.exe` mới hoặc xác nhận hành vi Tauri bằng `cargo` trong môi trường hiện tại.

## Artifact kiểm tra cục bộ

- Báo cáo trình duyệt: `.build-cache/qa-ui-redesign/report.json`.
- Ảnh màn hình: `.build-cache/qa-ui-redesign/*.png` (light/dark, màn chi tiết và viewport 1024).
- Kịch bản fixture: `.build-cache/qa-ui-redesign.cjs` (chỉ phục vụ QA cục bộ, không đưa vào app).
- Log kiểm tra: `.build-cache/qa-ui-redesign-{tests,typecheck,build}.log`.

Không commit các fixture/log/ảnh trong `.build-cache`. Chúng có thể được tạo lại bằng script QA khi Vite phục vụ `127.0.0.1:5187`.

## Bổ sung sau review (31/10/2026)

- Danh sách kế hoạch (APP-01/PLAN-01): dòng tiến độ dưới tên (`x/y cảnh đã có video`, `Phân tích lỗi · …`, `Chưa gửi phân tích`, lời chờ AI), ô "Sắp theo", ghi chú xoá vĩnh viễn dưới bảng. Server trả thêm `video_scene_count` trong tóm tắt kế hoạch.
- Thanh trạng thái: số việc AI đang chạy/chờ và "Dữ liệu: <thư mục>". `/lan/api/status` trả thêm `ai_queue { running, waiting }` và `data_dir`.
- Xoá: mọi hộp thoại xoá đều là xoá vĩnh viễn, gõ `XOA`, nút khoá có dòng lý do; bỏ nhánh thùng rác/LAN (`useIsDesktop`, `permanent`, `permanentDelete`) và các câu "chủ máy".
- Màn lỗi mất kết nối: nút "Mở thư mục log" (link `autovideo://open-logs`, cửa sổ Tauri tự mở thư mục, không cần server). Trong trình duyệt dev link này không làm gì.
- Lỗi capture Video HTML trong `TEST-REPORT-2026-10-31.md` đã sửa: `NETWORK_LOCKDOWN_ARGS` chừa cả `127.0.0.1` và `localhost`.
