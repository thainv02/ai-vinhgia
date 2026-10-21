# Vận hành account pool

## Trạng thái và phạm vi

Managed worker là workspace `worker/`. Server mặc định giữ `WORKER_MODE=legacy` để không tự thay cách chạy dự án hiện có. Màn hình `/accounts` dùng được trong cả hai chế độ.

Đã có account routing theo priority, cooldown bền vững, policy per project, claim có lease, checkpoint, action journal và complete idempotent. Chờ quota được biểu diễn bằng `jobs.status=queued` + `wait_reason/next_attempt_at`, thay vì thêm enum mới; scheduler claim chỉ lấy job tới hạn. Cách này giữ tương thích các màn hình/state machine cũ. Scene đang chạy được giữ để ngăn sửa prompt giữa một job đang chờ.

Worker mặc định xử lý analyze_brief/revise_prompt/edit_plan; thêm storyboard/video khi có `BROWSER_CDP_URL`. Browser executor đang cần kiểm chứng UI thực tế ChatGPT/Flow; account pool inference không bảo đảm website automation luôn thành công.

## Thêm Antigravity hoặc Codex

1. Chạy server/web và mở `/accounts`. Thêm một dòng cho mỗi tài khoản; alias tùy chọn, priority số nhỏ được dùng trước. Model ID phải lấy từ gateway/tài khoản, không suy từ tên gói.
2. `npm run ai:setup` cài proxy v8.0.37 từ GitHub release và xác minh SHA256. Trên máy hiện tại đã cài và chạy kiểm tra binary.
3. `npm run ai:login -- <id>` mở OAuth riêng. Người dùng hoàn tất đăng nhập của provider. Không lấy token từ auth file global của IDE.
4. `npm run ai:proxy -- <id>` giữ proxy chạy. Mỗi account có cổng, key và auth-dir riêng. Không đăng nhập hai account vào cùng một auth-dir; thêm account mới trên web trước.
5. Bấm Kiểm tra. Nếu chưa biết model khi thêm tài khoản, có thể để trống rồi chọn ở bước này. Chọn model thực tế từ danh sách gateway trả về. Model có trong catalog chưa chứng minh entitlement; inference thành công mới xác nhận lượt đó dùng được.
6. Thêm account thứ hai theo cùng quy trình. Dùng `npm run ai:pool` để tự giữ các proxy đã đăng nhập hoạt động thay vì mở từng terminal; supervisor bỏ qua proxy đang được chạy riêng. Một account hết quota → router thử account kế tiếp theo policy. Store bị lỗi auth cần đăng nhập lại; không tự sửa auth file của IDE.

Proxy và autovideo cùng dùng config `AI_HOME`. Mặc định store nằm ngoài repo: `~/.local/share/autovideo/accounts/<hash-của-db-path>/<id>/`, quyền owner-only. Không đổi DB_PATH/AI_HOME giữa lệnh login và server nếu muốn dùng cùng account metadata.

Proxy CLI sẽ hiển thị URL/tiến độ OAuth trong terminal. `process.lock` ngăn login và proxy cùng refresh một store. Dừng proxy trước khi đăng nhập lại. Có thể cần chọn lại tài khoản trong Google account chooser nếu trình duyệt còn phiên cũ.

Claude/OpenAI API qua gateway ngoài: nhập loopback `base_url` và **tên biến môi trường** chứa API key. Server đọc giá trị từ môi trường; không nhập raw token vào form. Managed Claude subscription proxy không phải đường mặc định. Claude Code nguyên bản vẫn dùng được ở legacy mode.

## Bật managed worker

Đổi `.env` rồi restart server:

```dotenv
WORKER_MODE=managed
# AI_HOME=/absolute/private/account-store  # tùy chọn, ngoài repo
```

Chạy worker văn bản/EDL trong terminal khác:

```sh
npm run worker:start
```

Chạy đúng một job rồi thoát:

```sh
npm run worker:start -- --once
```

Không đồng thời chạy worker legacy. Server từ chối claim sai chế độ; các kết quả managed cần lease hiện hành. Đổi chế độ chỉ khi đã drain/đối soát job đang chạy.

Để tạo ảnh/video trên browser riêng:

```sh
npm run ai:browser
# Đăng nhập ChatGPT và Flow trong cửa sổ profile media vừa mở.
BROWSER_CDP_URL=http://127.0.0.1:9222 npm run worker:start
```

Nếu `.env` có `WORKER_TYPES` từ giai đoạn chỉ chạy văn bản, đổi thành `analyze_brief,revise_prompt,edit_plan,storyboard,video` rồi restart worker để nhận cả job media. Browser dùng ChatGPT và Flow tại `https://flow.google.com`; entrypoint `https://labs.google/fx/tools/flow` cũ vẫn được chấp nhận.

Browser tool chỉ mở ChatGPT/Google Flow, chỉ upload file được payload cho phép và chỉ ghi output path của job. Không có tool thực thi shell/JS tùy ý từ model. Một managed worker trên máy giữ process lock; không bật nhiều process cùng profile.

Giao diện ChatGPT/Flow có thể thay đổi. Nếu tool không tìm được thao tác hoặc không có bằng chứng về kết quả, worker báo lỗi/chờ đối soát thay vì bấm Generate lại. Không dùng production video để test retry.

## Quota và retry

Trang `/accounts` có thanh **hạn mức còn lại**, thời điểm reset và thời điểm quan sát dữ liệu. Antigravity hiển thị theo model; Codex hiển thị các cửa sổ provider trả về, ví dụ 5 giờ/7 ngày khi có dữ liệu tương ứng. Đây là quota %, không phải số token còn lại hoặc context window.

Quota được đọc khi mở trang, sau đó mỗi 5 phút; nút Cập nhật hạn mức có cache tối thiểu 60 giây để tránh gọi dồn. Không có dữ liệu thì để unknown, không mặc định 100%. Khi cập nhật lỗi, giữ snapshot trước và đánh dấu dữ liệu cũ. Mốc reset đã qua không tự làm thanh tăng về 100%.

Collector dùng management API của từng proxy local; provider OAuth vẫn do proxy giữ/refresh, không trả về frontend. Với store cũ, lần đọc đầu lưu management key local vào file riêng và cập nhật cấu hình management key; có bản `config.before-quota.yaml` trong store. Không sửa access key inference hoặc file OAuth. Gateway không reload key kịp thì giao diện yêu cầu restart proxy.

Antigravity đọc quotaInfo từ fetchAvailableModels. Codex ưu tiên tín hiệu quota quan sát gần đây, rồi thử usage qua gateway; adapter Codex chưa được xác nhận trên tài khoản thật trong phiên này. Claude/API gateway ngoài hiện không có nguồn quota subscription và hiển thị chưa có dữ liệu. Việc có quota của một model không chứng minh model đó được gateway hỗ trợ.

Collector chỉ phục vụ hiển thị, không thay đổi policy chọn tài khoản, cooldown hay credit ledger. Nguồn tham khảo: [Codex rate-limit fields](https://learn.chatgpt.com/docs/app-server), [proxy management API](https://github.com/router-for-me/CLIProxyAPI/blob/ce07d189b3de2a39d37fd68ae093b102ce3aabee/internal/api/handlers/management/api_tools.go).

- Theo priority, giữ cùng provider/model; mở fallback provider/model trên `/accounts` cho từng project nếu muốn.
- Tối đa 3 lần thử inference ở một bước; retry nội bộ proxy tắt. Đây không phải giới hạn số token hay credit Flow.
- `429` dùng Retry-After nếu có; thời điểm probe lại không được trình bày là thời điểm quota reset chắc chắn.
- `401` sau khi proxy đã xử lý refresh cần đăng nhập lại. `403` loại account khỏi routing cho đến khi người dùng kiểm tra quyền.
- `quota_scope_key` cấu hình qua API khi biết tài khoản cùng nhóm hạn mức; không mặc định các account có quota riêng.
- Thiếu telemetry thì giữ trạng thái chưa rõ. Không bật paid fallback/overage tự động.
- Hết tài khoản → lưu checkpoint, trả job về chờ; không tính thành video attempt mới, không tăng ledger.

## Giao thức managed worker

- Claim: `GET /api/worker/next?mode=managed&types=...` với Bearer WORKER_TOKEN, X-Worker-Id; response có lease_id và lease_epoch.
- Mọi mutation job thêm X-Job-Lease. Upsert scenes/comments thêm X-Job-Id và phải thuộc phạm vi job.
- Heartbeat supervisor mỗi 20s, độc lập với inference.
- Checkpoint: `POST /api/worker/jobs/:id/checkpoint`.
- Inference và checkpoint nhận tối đa 32 MiB JSON để chứa nhiều ảnh tham chiếu base64; các API ghi thông thường vẫn giữ giới hạn 2 MiB. Giới hạn này áp dụng cho toàn bộ context, không phải từng ảnh.
- Wait: `POST /api/worker/jobs/:id/wait`, reason `ai_quota|needs_reconciliation|browser_offline`, retry_at là ISO tương lai hoặc NULL để chờ xử lý thủ công.
- Tool dùng browser-lease và actions API. Intent được ghi trước submit; mất phản hồi không có nghĩa chưa submit.
- Complete cần Idempotency-Key. Cùng key/body trả kết quả cũ; body/key khác bị từ chối, không ghi asset/ledger lần nữa.
- Public jobs API không trả lease_id. Lease không đưa vào prompt/model context.

Action journal: intent → submitted → downloaded → committed. Nếu crash khi intent chưa có kết quả chắc chắn, job chờ `needs_reconciliation`. Mở đúng profile/project để kiểm tra generation; không xóa intent để thử lại tự động. Có thể hủy job qua web và chỉ tạo job mới sau khi đã xác nhận kết quả bên ngoài.

## Kiểm chứng và rollback

`npm test`, `npm run typecheck`, `npm run build`.

`npm run ai:smoke -- <id>` chạy một job phân tích inference thật trên API/DB tạm riêng (không tạo ảnh/video). Thêm `--fallback` để giả lập gateway A trả quota rồi chuyển sang account được chọn để inference thật. Lệnh này sử dụng quota AI; không nằm trong bộ test mặc định. Test gateway dùng HTTP local giả lập quota; không sử dụng token/tài khoản thật. Xem `docs/ai/VALIDATION.md` để phân biệt phần đã kiểm tra với phần còn cần chạy thật.

Rollback: `docs/ai/ROLLBACK.md`. Không chạy code baseline trên DB đã migrate mà chưa restore backup tương ứng.
