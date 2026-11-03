# Thiết kế giao diện app desktop AI Vinh Gia

Bản thiết kế chuẩn cho giao diện app (trang planner, `web/src/`). Code giao diện mới hoặc sửa giao diện cũ thì làm theo thư mục này.

- Nguồn: canvas "AI Vinh Gia — Thiết kế app desktop" (claude.ai/artifact/Cm9YMkcDWZdF22h3AVfzdg), kéo về ngày 31/10/2026. Sửa thiết kế trên canvas rồi kéo lại; không sửa tay các file trong thư mục này.
- `screens/*.dc.html`: mỗi file là một màn hình (artboard) dạng Design Component. Phần giao diện nằm trong `<x-dc>…</x-dc>`. `{{tên}}` là giá trị lấy từ `renderVals()` trong khối `<script type="text/x-dc">` cuối file; `<sc-for>`/`<sc-if>` là vòng lặp/điều kiện. Dòng `support.js` là runtime của canvas, không có trong repo: đọc mã nguồn, đừng cố mở file bằng trình duyệt để xem.
- `app.css`: token và lớp dùng chung của thiết kế (`.btn`, `.bd`, `.note`, `.why`, `.tag`, `.step`, `.dlg`…). `app-dark.css`: phần ghi đè cho giao diện tối. Đây là bản tham chiếu, không import thẳng vào `web/`.
- `canvas.json`: vị trí các màn hình trên canvas và tên đầy đủ của từng màn.

## Đọc theo thứ tự

1. `screens/Foundations.dc.html`: màu, chữ, nút và các trạng thái, ô nhập, huy hiệu trạng thái, dấu loại hành động, tải lên, timeline điểm cắt, toast.
2. `screens/Sitemap.dc.html`: kiến trúc thông tin, **bảng ánh xạ chức năng cũ → mới**, bảng "Khi nào gọi AI / tạo phiên bản", danh sách ngoài phạm vi.
3. `screens/Common.dc.html`: mẫu dùng chung (hộp thoại xác nhận xoá, huỷ việc đang chạy, chưa thể xoá, toast, trạng thái rỗng, đang tải, lỗi mất kết nối).
4. Màn hình của phần đang làm (bảng dưới).

## Danh mục màn hình

| Mã | File | Màn | Code hiện tại |
|---|---|---|---|
| APP-01, PLAN-01 | `Main.dc.html` | Khung app (sidebar, gần đây, thanh trên) + danh sách kế hoạch | `web/src/planner/App.tsx`, `PlanListPage.tsx`, `RowMenu.tsx` |
| PLAN-02 | `PlanNew.dc.html` | Tạo kế hoạch | `planner/NewPlanPage.tsx` |
| PLAN-05 | `PlanPicker.dc.html` | Chọn ảnh từ thư viện | `components/LibraryPickerDialog.tsx`, `components/RefUploader.tsx` |
| PLAN-03, PLAN-06 | `PlanScene1.dc.html` | Chi tiết kế hoạch, cảnh, Bước 1 (storyboard ChatGPT) | `planner/PlanPage.tsx`, `PlanWorkspace.tsx`, `SceneCard.tsx`, `ws-ui.tsx` |
| PLAN-07 | `PlanScene2.dc.html` | Bước 2: prompt và mở Google Flow | như trên |
| PLAN-08 | `PlanScene3.dc.html` | Bước 3: tải và chọn video cảnh | `planner/VideoStep.tsx` |
| PLAN-04 | `PlanRequest.dc.html` | Sửa yêu cầu, phân tích lại | `planner/PlanPage.tsx` |
| FINAL-01 | `Final.dc.html` | Bản hoàn chỉnh: tiến trình, phiên bản | `planner/FinalBlock.tsx`, `components/VersionThread.tsx`, `components/CleanLogoView.tsx` |
| FINAL-02 | `FinalCuts.dc.html` | Chỉnh điểm cắt | `components/EdlEditor.tsx`, `components/FinalTimeline.tsx` |
| FINAL-03 | `FinalFeedback.dc.html` | Góp ý AI và lịch sử | `components/VersionThread.tsx`, `lib/revisionApi.ts` |
| FINAL-04 | `FinalColor.dc.html` | Chỉnh màu, ảnh mẫu / LUT | `components/GradePanel.tsx`, `components/ColorMatchSection.tsx` |
| CLIP-01 | `Clips.dc.html` | Danh sách và tạo dự án clip | `planner/ClipsPage.tsx`, `clips/NewProjectDialog.tsx` |
| CLIP-02 | `ClipSource.dc.html` | Video nguồn và nhận dạng lời nói | `clips/SourceBlocks.tsx`, `clips/SourcePlayer.tsx` |
| CLIP-04/05 | `ClipWorkspace.dc.html` | Không gian cắt clip | `clips/DesktopWorkspace.tsx`, `clips/Transcript.tsx`, `clips/RangeBar.tsx` |
| CLIP-03 | `ClipAI.dc.html` | AI đề xuất clip | `clips/PlanForm.tsx` |
| CLIP-06 | `ClipCaptions.dc.html` | Sửa chữ phụ đề | `clips/CaptionEditor.tsx`, `clips/SubtitleStage.tsx` |
| CLIP-07 | `ClipSettings.dc.html` | Cài đặt / xoá dự án clip | `clips/ProjectSettings.tsx` |
| HTML-01 | `Html.dc.html` | Danh sách và tạo Video đồ hoạ | `html/HtmlListPage.tsx` |
| HTML-02/03 | `HtmlDetail.dc.html` | Xem trước, chỉnh nhanh, góp ý | `html/HtmlProjectPage.tsx` |
| HTML-04 | `HtmlFiles.dc.html` | Tệp dự án và dựng MP4 | `html/HtmlProjectPage.tsx`, `html/RenderPanel.tsx` |
| TOOL-01 | `Tool.dc.html` | Xoá logo Veo | `planner/ToolPage.tsx` |
| SET-01 | `Settings.dc.html` | Cài đặt | `planner/SettingsPage.tsx` |
| SYS-01/02/03 | `System.dc.html` | Bộ cài xong, đang khởi động / lỗi khởi động, chọn thư mục dữ liệu lần đầu | `installer/autovideo.iss`, `src-tauri/splash/index.html`, `src-tauri/src/main.rs` |
| COMMON-01 | `Common.dc.html` | Xác nhận, toast, rỗng, lỗi | `components/Modal.tsx`, `components/Toaster.tsx`, `components/States.tsx` |
| (tối) | `MainDark.dc.html` | Danh sách kế hoạch ở giao diện tối | `planner/theme.ts`, `planner/desktop.css` |

## Quy tắc chung (áp dụng mọi màn)

- Mỗi màn luôn trả lời được: đang ở dự án nào, cảnh/clip/phiên bản nào, việc nào đang chạy, bước tiếp theo là gì.
- Mỗi màn chỉ có **một** nút chính (`.btn.p`).
- Nút bị khoá phải có **dòng lý do ngay dưới nút** (`.why`, biểu tượng ổ khoá), không giấu lý do trong tooltip/`title`.
- Nút có tác động luôn kèm dấu loại hành động: `AI` (gọi dịch vụ AI, vào hàng đợi AI), `TRÊN MÁY` (xử lý cục bộ: dựng, chỉnh màu tay, nhận dạng lời nói), `MỞ NGOÀI` (mở ChatGPT/Google Flow trong trình duyệt mặc định).
- Huy hiệu trạng thái luôn có chữ, không chỉ dùng màu. Kết quả đã lỗi thời dùng huy hiệu viền đứt (`.bd.old`: "Cũ vì đổi video", "Cần dựng lại", "Xem trước đã cũ").
- Tải lên đạt 100% **chưa phải xong**: hiện "Đang kiểm tra video… chưa hoàn tất" (thanh sọc) cho tới khi server trả kết quả.
- Xoá là xoá vĩnh viễn (app không có thùng rác): hộp thoại nêu rõ những gì bị xoá; xoá dự án phải gõ `XOA` để xác nhận.
- Lỗi mất kết nối với dịch vụ trên máy phải nói rõ đó **không** phải AI đang chờ, có nút Thử lại và Mở thư mục log.
- Hàng đợi AI và hàng đợi Render là hai thứ khác nhau, hiển thị tách riêng.
- Prompt và tên file dùng font mono, luôn xuống dòng, không cắt chữ.
- Truy cập được bằng bàn phím: dùng `<button>`, `<a href>`, `<input>` + `<label>` thật; có viền tiêu điểm (`:focus-visible`); nút chỉ có biểu tượng phải có `aria-label`; vùng bấm ≥ 36 px.

## Màu sắc: theo token của app, không chép mã màu

Thiết kế vẽ theo bảng màu CRM Vinh Gia: sidebar xanh đậm `#153F86`, nút chính xanh ngọc `#207D79`, thông tin `#174FA4`, AI tím `#4A3699`, và giao diện tối nền xanh than. Nhưng app hiện đã đổi màu theo yêu cầu ngày 31/10/2026 (**tối: chỉ đen, trắng, xám; sáng: chỉ xanh dương và trắng; đỏ chỉ dành cho lỗi**), token nằm trong `web/src/planner/desktop.css`.

Khi code:
- Lấy **bố cục, cấu trúc, nội dung chữ, trạng thái và hành vi** từ thiết kế.
- Lấy **màu** từ biến CSS của app (`--primary`, `--side`, `--surface`, `--line`, `--fg`, `--muted`, `--ok-*`, `--warn-*`, `--danger-*`, `--info-*`, `--sel`, `--hl`…), không chép mã hex từ `app.css`. Nếu cần thêm token (ví dụ cho dấu `AI`, `TRÊN MÁY`, huy hiệu `.old`) thì thêm vào cả hai chế độ trong `desktop.css`, giữ đúng quy tắc màu ở trên.
- Kích thước, khoảng cách và bo góc lấy theo thiết kế: bậc khoảng cách 4 px (4 · 8 · 12 · 16 · 20 · 28); bo góc 7 px cho nút/ô nhập, 10–12 px cho thẻ, 14 px cho hộp thoại; chữ Be Vietnam Pro (tiêu đề màn 20/700, tiêu đề khối 15/700, nội dung 14/400, chú thích 12,5/400), mono JetBrains Mono 12,5.

## Mục "Đề xuất"

Các chỗ gắn huy hiệu `Đề xuất` trong `Sitemap.dc.html` là thay đổi chưa được chủ sản phẩm duyệt: đổi tên "Video HTML" thành "Video đồ hoạ", thêm dự án Video đồ hoạ vào mục Gần đây, bỏ ô "Tên của bạn" ở form clip, gom tải transcript / nhận dạng lại vào menu "Lời thoại", nối nút Huỷ AI chọn đoạn, thêm lối vào thư mục dữ liệu/log trong Cài đặt. **Hỏi trước khi làm** các mục này.

## Ngoài phạm vi

Không làm khi chưa được yêu cầu (danh sách mở rộng trong `Sitemap.dc.html`): cảnh báo khi rời trang lúc đang tải lên/xử lý, form sửa tên/mô tả dự án Video đồ hoạ, bộ chọn khung fit/nền mờ/center cho clip, slider màu riêng từng cảnh, tìm/lọc Video đồ hoạ, trang quản lý thư viện ảnh riêng. Không đưa vào: account pool, ledger, worker console, timeline nhiều track, TTS, mua credit, đăng mạng xã hội.

## Khi code xong một màn

- `npm run typecheck`, `npm run build` (và `npm test` nếu đụng server).
- So lại với file thiết kế tương ứng: đủ trạng thái (rỗng, đang tải, lỗi, khoá kèm lý do, đang chạy, xong), đủ chữ, đúng nút chính.
- Kiểm tra cả giao diện sáng và tối.
