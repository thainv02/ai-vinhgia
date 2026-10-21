# Quay về bản trước account pool

Mốc local: `before-account-pool-20261021` → commit `fbde9e2`, nhánh `main`.

Đã lưu trước khi sửa mã:

- Mã nguồn, package lock, ảnh mockup và font trong Git.
- Archive `/Users/thainv/code/autovideo-local-backups/before-account-pool-20261021/workspace.tar.gz`: cả workspace, bao gồm `.env`, `data/`, `refs/`, `output/` và nguồn watermark tool; loại dependencies, build output, nested `.git` và bộ release upstream.
- SQLite snapshot nhất quán `/Users/thainv/code/autovideo-local-backups/before-account-pool-20261021/app.db`, được tạo bằng SQLite backup API.
- Dependencies dựng lại bằng npm; watermark checkout gốc vẫn giữ tại chỗ.

## Kiểm tra trước khi quay lại

`npm run rollback:check` chỉ kiểm tra tag, archive và DB backup; không thay đổi dữ liệu.

Git không lưu runtime database/token/video. **Chỉ chuyển Git branch không đủ** khi ứng dụng đã chạy migration mới.

## Các bước khôi phục

1. Dừng worker nhận job mới. Đối soát mọi lượt tạo ảnh/video đã submit; lưu kết quả cần giữ. Quay Git không hủy generation đang chạy trên Flow.
2. Dừng server và các tiến trình `npm run dev`/watch đang giữ cổng 8787. Dừng proxy nếu muốn ngừng inference. Không chuyển branch trong khi watch server còn chạy.
3. Lưu thêm bản sao database, `.env`, refs/output hiện tại nếu muốn giữ công việc sau mốc baseline. Không ghi đè backup ban đầu.
4. Xác nhận working tree sạch bằng `git status`. Các thay đổi triển khai được commit trên `feat/multi-provider-account-pool`.
5. Chạy `git switch main` hoặc `git switch --detach before-account-pool-20261021`.
6. Khi chắc chắn mọi kết nối SQLite đã đóng, đổi tên `data/app.db`, `data/app.db-wal`, `data/app.db-shm` hiện tại sang thư mục lưu riêng (nếu chúng tồn tại); chép SQLite snapshot ở trên thành `data/app.db`.
7. Nếu đã đổi `.env`, khôi phục bản cũ trong archive hoặc bỏ các biến mới sau khi đối chiếu. Token trong archive là secret; không in ra terminal/chat.
8. Giữ refs/output hiện tại để không mất file mới. Nếu muốn khôi phục đúng tập file ban đầu, giải nén archive vào thư mục khác rồi đối chiếu; không xóa hàng loạt output hiện tại.
9. `npm install`, `npm run build`, `npm test`, rồi `npm start` hoặc `npm run dev`.

Baseline có 217 test pass tại thời điểm commit. Nhánh triển khai vẫn giữ nguyên để chuyển lại sau này. Không dùng `git reset --hard` hay `git clean` cho quy trình khôi phục này.

`after-account-pool.db` cùng thư mục backup giữ schema mới và metadata account sau triển khai. Khi quay lại nhánh mới, dùng snapshot tương ứng nếu muốn giữ mapping account/store. Không tạo account ID trùng vào store cũ sau restore; ứng dụng sẽ từ chối ghi đè credential. Có thể chọn AI_HOME mới khi muốn tạo pool mới hoàn toàn.
