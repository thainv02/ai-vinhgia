# Vận hành account pool

## Trạng thái và phạm vi

Managed worker là workspace `worker/`. Server mặc định giữ `WORKER_MODE=legacy` để không tự thay cách chạy dự án hiện có. Trang web `/accounts` đã bị bỏ (29/10/2026); account pool chỉ còn quản lý qua API `/api/ai/*`. Chế độ **kết hợp** (managed cho một số loại job, legacy cho phần còn lại) cấu hình bằng `MANAGED_JOB_TYPES`, xem bên dưới.

Đã có account routing theo priority, cooldown bền vững, policy per project, claim có lease, checkpoint, action journal và complete idempotent. Chờ quota được biểu diễn bằng `jobs.status=queued` + `wait_reason/next_attempt_at`, thay vì thêm enum mới; scheduler claim chỉ lấy job tới hạn. Cách này giữ tương thích các màn hình/state machine cũ. Scene đang chạy được giữ để ngăn sửa prompt giữa một job đang chờ.

Worker mặc định xử lý analyze_brief/revise_prompt/edit_plan; thêm storyboard/video khi có `BROWSER_CDP_URL`. Browser executor đang cần kiểm chứng UI thực tế ChatGPT/Flow; account pool inference không bảo đảm website automation luôn thành công.

## AI API dùng chung (mặc định hiện tại)

Inference không còn xoay tài khoản/model qua proxy local. Đặt trong `.env` rồi restart server:

```dotenv
AI_API_URL=https://ai.int.syntra.vn/v1   # HTTPS; thiếu /v1 thì server tự thêm
AI_API_KEY=...                           # chỉ trong .env, không commit/không in ra log
AI_API_MODEL=gemini-3.8-flash-high       # một model cố định; xem GET $AI_API_URL/models
# AI_API_TIMEOUT_MS=120000               # tối đa 125000 (worker hủy request sau 135 s)
```

- Có `AI_API_URL` → `POST /api/worker/jobs/:id/infer` gọi thẳng `$AI_API_URL/chat/completions` một lần với `AI_API_MODEL`. Account pool, policy provider/model theo dự án và cooldown không được dùng; không cần chạy `npm run ai:pool`/`ai:proxy`.
- `429`/`5xx`/mất mạng/phản hồi hỏng → `AI_UNAVAILABLE` (job chờ theo Retry-After, mặc định 60 s/30 s). `401`/`403` → job chờ 5 phút, sửa `AI_API_KEY` rồi restart. `400`/`404` (sai model/định dạng) → `AI_INVALID_REQUEST`.
- `ai_attempts.account_id = NULL` đánh dấu lượt gọi AI API; provenance ghi `provider='api'`. `/api/ai/status` trả `ai_api: { base_url, model }` (không trả key).
- Giao diện không hiển thị URL/model/tài khoản. Khi job chờ `ai_quota` và lượt gọi gần nhất là `429` (hết token trên mọi tài khoản của server), banner toàn cục báo **"Đã hết token AI trên tất cả tài khoản"** kèm giờ tự thử lại; `401/403` báo **"Key AI bị từ chối"**. Key của app là key người dùng nên không đọc được số tài khoản/token còn lại trên server.
- Sai cấu hình (URL không phải HTTPS, thiếu key) làm server không khởi động thay vì âm thầm quay về pool. Xóa `AI_API_URL` để quay lại account pool bên dưới.

## Thêm Antigravity hoặc Codex (account pool, chỉ khi không đặt `AI_API_URL`)

> Phần dưới mô tả account pool cũ. Trang web `/accounts` và CLIProxy trên máy đã bị gỡ; nếu cần quay lại phải chạy `npm run ai:setup` và gọi `/api/ai/*` trực tiếp (hoặc khôi phục trang từ git).

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

### Chế độ kết hợp: managed cho văn bản/EDL, Claude legacy cho storyboard/video

Chế độ được quyết định theo **loại job**, không theo cổng `WORKER_MODE` toàn cục:

```dotenv
WORKER_MODE=managed
MANAGED_JOB_TYPES=analyze_brief,revise_prompt,edit_plan   # storyboard,video do worker legacy (Claude, WORKER.md) làm
```

- `WORKER_MODE=legacy`: danh sách managed luôn rỗng (như trước). `WORKER_MODE=managed` không đặt `MANAGED_JOB_TYPES`: managed làm mọi loại. Loại job lạ trong danh sách làm server không khởi động.
- Claim: managed worker (`?mode=managed`) chỉ nhận loại trong danh sách (hoặc job đã từng do managed giữ, để resume không mắc kẹt khi đổi cấu hình); worker legacy (`?worker=claude-1`, không `mode=managed`) chỉ nhận các loại còn lại. Lệch chế độ không còn lỗi `WORKER_MODE`, chỉ trả `204`.
- Endpoint ghi theo chế độ của **job**: có `X-Job-Lease` → kiểm tra managed (lease hiện hành, đúng phạm vi job); không có → legacy, chỉ hợp lệ với job/loại legacy. `POST /api/worker/scenes` không lease khi `analyze_brief` là loại managed, hay `POST /api/worker/comments` không lease trên cảnh đang có job managed → `409 MANAGED_REQUIRED`. Heartbeat/complete/fail không lease trên job managed → `409 LEASE_LOST`.
- `WORKER_TYPES` của managed worker nên khớp danh sách này (vd bỏ `storyboard,video`). Server chỉ giao đúng loại managed nên cấu hình lệch không gây hại, nhưng worker sẽ không nhận được loại bị bỏ; khi khởi động worker in ra các loại sẽ nhận và cảnh báo nếu không có loại nào.
- Đổi `MANAGED_JOB_TYPES` chỉ khi đã drain/đối soát job đang chạy; restart server để áp dụng. `/accounts` hiển thị các loại do managed xử lý.

Để tạo ảnh/video trên browser riêng:

```sh
npm run ai:browser
# Đăng nhập ChatGPT và Flow trong cửa sổ profile media vừa mở.
BROWSER_CDP_URL=http://127.0.0.1:9222 npm run worker:start
```

Nếu `.env` có `WORKER_TYPES` từ giai đoạn chỉ chạy văn bản, đổi thành `analyze_brief,revise_prompt,edit_plan,storyboard,video` rồi restart worker để nhận cả job media. Browser dùng ChatGPT và Flow tại `https://flow.google.com`; entrypoint `https://labs.google/fx/tools/flow` cũ vẫn được chấp nhận.

Browser tool chỉ mở ChatGPT/Google Flow, chỉ upload file được payload cho phép và chỉ ghi output path của job. Không có tool thực thi shell/JS tùy ý từ model. Một managed worker trên máy giữ process lock; không bật nhiều process cùng profile.

Giao diện ChatGPT/Flow có thể thay đổi. Nếu tool không tìm được thao tác hoặc không có bằng chứng về kết quả, worker báo lỗi/chờ đối soát thay vì bấm Generate lại. Không dùng production video để test retry.

### Worker nền ảnh/video qua API (`media-api-1`, 05/11/2026)

Storyboard và video không cần mở Codex/Claude: tiến trình `npm run worker:media` (`worker/src/media/`) nhận job legacy `storyboard,video` (`?worker=media-api-1&types=storyboard,video`) và gọi Muse2API hoặc Flow2API theo `payload.generator.provider`, cùng luật với `WORKER-MUSE.md` / `WORKER-FLOW.md`.

```sh
nohup npm run worker:media > data/worker-media.log 2>&1 &   # một tiến trình mỗi máy (khóa ~/.local/share/autovideo/media-worker.lock)
```

- Cấu hình `.env`: `MUSE2API_URL`, `MUSE2API_KEY` hoặc `MUSE2API_KEY_FILE`, `FLOW2API_URL`, `FLOW2API_KEY`, `MEDIA_WORKER_ID` (mặc định `media-api-1`).
- Làm tuần tự từng job (mỗi tài khoản Muse/Flow chạy một task một lúc), heartbeat 60 giây, poll 5 giây.
- Video Muse gửi với `Idempotency-Key: autovideo-video-<job>` nên gửi lại an toàn. Ảnh Muse và mọi yêu cầu Flow không có idempotency: worker ghi nhật ký `data/media-worker/job-<id>.json` **trước** khi gửi; job bị trả về hàng đợi mà nhật ký cho thấy đã gửi nhưng chưa có kết quả thì worker báo lỗi "không rõ kết quả", không gửi lại.
- Worker **không kết luận** chất lượng (không gửi `verdict`): storyboard/video về trạng thái chờ xem, `verdict_note` ghi "chưa đánh giá nội dung". Người dùng xem và kết luận trên web. Video vẫn có lưới khung hình.
- Ảnh storyboard Google Flow được server xoá logo khi `complete` như mọi worker khác.
- Lỗi dịch vụ theo bảng của WORKER-MUSE/WORKER-FLOW: `LOGIN_REQUIRED`, `CAPTCHA`, `FLOW_OUT_OF_CREDIT` tạm dừng hàng đợi (bật lại trên web sau khi sửa); key sai, Muse2API không đính được ảnh, hết hạn mức ảnh thì worker báo lỗi rồi nghỉ 15 phút.
- **Tự xử lý lỗi tài khoản Flow2API (không cần bấm tay):** lỗi xảy ra TRƯỚC khi Google Flow nhận lệnh tạo ("没有可用的Token", hoặc cookie 401 ở bước tải ảnh `rpc=maseQ`, chưa có % tiến độ) thì worker giữ job, gửi lại sau 1, 2, 4, 6, 8 phút (≈ 21 phút, đủ để extension Token Updater tự đồng bộ cookie hoặc Flow2API chuyển tài khoản khác). Vẫn lỗi thì báo `LOGIN_REQUIRED` kèm `retryable: true` (hàng đợi dừng). Khi hàng đợi dừng vì lỗi Flow2API này, worker đợi 5 phút (gấp đôi sau mỗi lần bật lại mà lại dừng, tối đa 60 phút), kiểm tra `GET <FLOW2API_URL>/health` có tài khoản hoạt động rồi gọi `POST /api/worker/queue/auto-resume`: server bật lại hàng đợi và tạo lại các job `retryable` (job mới nhất của cảnh, cảnh vẫn `failed`; video giữ đúng dịch vụ). Lỗi sau khi Flow đã nhận lệnh (có tiến độ, mất stream) không bao giờ gửi lại. Dừng tay, CAPTCHA, hết credit, lỗi Muse vẫn chờ chủ máy.
- Test: `server/test/media-worker.test.ts` (server thật qua inject, Muse/Flow giả, ffmpeg và tool xoá logo thật).
- Codex/Claude vẫn có thể chạy vòng lặp `WORKER-MUSE.md` song song; server giao mỗi job cho đúng một worker.

## Quota và retry

Trang `/accounts` có thanh **hạn mức còn lại**, thời điểm reset và thời điểm quan sát dữ liệu. Antigravity hiển thị theo model; Codex hiển thị các cửa sổ provider trả về, ví dụ 5 giờ/7 ngày khi có dữ liệu tương ứng. Đây là quota %, không phải số token còn lại hoặc context window.

Quota được đọc khi mở trang, sau đó mỗi 5 phút; nút Cập nhật hạn mức có cache tối thiểu 60 giây để tránh gọi dồn. Không có dữ liệu thì để unknown, không mặc định 100%. Khi cập nhật lỗi, giữ snapshot trước và đánh dấu dữ liệu cũ. Mốc reset đã qua không tự làm thanh tăng về 100%.

Collector dùng management API của từng proxy local; provider OAuth vẫn do proxy giữ/refresh, không trả về frontend. Với store cũ, lần đọc đầu lưu management key local vào file riêng và cập nhật cấu hình management key; có bản `config.before-quota.yaml` trong store. Không sửa access key inference hoặc file OAuth. Gateway không reload key kịp thì giao diện yêu cầu restart proxy.

Antigravity đọc quotaInfo từ fetchAvailableModels. Codex ưu tiên tín hiệu quota quan sát gần đây, rồi thử usage qua gateway; adapter Codex chưa được xác nhận trên tài khoản thật trong phiên này. Claude/API gateway ngoài hiện không có nguồn quota subscription và hiển thị chưa có dữ liệu. Việc có quota của một model không chứng minh model đó được gateway hỗ trợ.

Collector chỉ phục vụ hiển thị, không thay đổi policy chọn tài khoản hay cooldown. Nguồn tham khảo: [Codex rate-limit fields](https://learn.chatgpt.com/docs/app-server), [proxy management API](https://github.com/router-for-me/CLIProxyAPI/blob/ce07d189b3de2a39d37fd68ae093b102ce3aabee/internal/api/handlers/management/api_tools.go).

- Theo priority, giữ cùng provider/model; mở fallback provider/model trên `/accounts` cho từng project nếu muốn.
- Tối đa 3 lần thử inference ở một bước; retry nội bộ proxy tắt. Đây không phải giới hạn số token hay hạn mức tạo video.
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
- Tool dùng browser-lease và actions API. Intent được ghi trước submit; mất phản hồi không có nghĩa chưa submit. Mỗi job chỉ có **một action sống** (id `media-<job>`, sau đối soát `nothing_created` là `media-<job>-<n>`): ghi `intent` mới khi còn action sống → `409 ACTION_CONFLICT`.
- Ngữ cảnh job media không còn bị cắt cứng 90 message: khi vượt 60 message, worker giữ system + payload + protocol, ~30 message gần nhất và một bản tóm tắt thao tác đã làm (từ journal và tool đã gọi); mọi `tool_call_id` luôn còn message tool tương ứng (checkpoint resume cũng được vá). Giới hạn 60 lượt inference mỗi lần claim; hết lượt → lỗi rõ ràng và (nếu đã submit) chờ đối soát.
- Gateway nhận `parallel_tool_calls:false` khi có tools. Nếu model vẫn trả nhiều tool call, chỉ lệnh đầu chạy; các lệnh còn lại nhận message tool lỗi "chỉ một thao tác mỗi lượt".
- Complete cần Idempotency-Key. Cùng key/body trả kết quả cũ; body/key khác bị từ chối, không ghi asset/ledger lần nữa.
- Public jobs API không trả lease_id. Lease không đưa vào prompt/model context.

Action journal: intent → submitted → downloaded → committed (`uncertain` khi mất phản hồi lúc bấm; `abandoned` chỉ do đối soát). Nếu crash khi intent chưa có kết quả chắc chắn, job chờ `needs_reconciliation`; worker không bao giờ xóa intent hay tự submit lại.

### Đối soát (`needs_reconciliation`)

Trên web (Hàng đợi, thẻ cảnh, trang chi tiết cảnh) job chờ đối soát hiện huy hiệu **Cần đối soát** và nút **Đối soát**. Mở Flow/ChatGPT bằng profile media, kiểm tra dự án/hội thoại của cảnh, rồi chọn (API `POST /api/jobs/:id/reconcile`, một transaction, idempotent, ghi event):

- **retry_download**: kết quả đã được tạo. Action `intent|uncertain` → `submitted`; worker resume (giữ checkpoint) tìm và tải kết quả, không submit lại.
- **nothing_created**: không có gì được tạo. Action → `abandoned`, checkpoint bị xóa, job chạy lại từ đầu với action id mới (nếu thực ra đã có lượt tạo thì sẽ tạo hai lần).
- **charge_and_fail** (video): đã tạo nhưng không lấy được kết quả. Job `failed` với `result.attempt_used = true`, tính đúng một lượt (không ghi sổ credit).

`POST /api/jobs/:id/cancel` trên job managed đã có action `intent|uncertain|submitted|downloaded` trả `409 RECONCILIATION_REQUIRED` (giao diện chuyển sang đối soát) để không mất ghi nhận lượt đã dùng. Hàng đợi còn nút **Thử lại ngay** cho job chờ tài khoản AI (`/api/ai/jobs/:id/resume`).

## Trang planner cho người dùng trong mạng LAN

Đồng nghiệp trong cùng mạng (mặc định **không cần mã truy cập**, xem bên dưới) nhập yêu cầu kịch bản + ảnh tham chiếu; managed worker hiện có (`analyze_brief`) chia cảnh; trang hiển thị cho từng cảnh **tin nhắn dán vào ChatGPT** (storyboard), **prompt Google Flow nguyên văn**, ảnh nào đính kèm theo thứ tự nào và cài đặt (9:16, 10 giây, x1, 720p). Họ tự tạo ảnh/video bằng tài khoản của mình. **Trang LAN không tạo job storyboard/video trên máy này**; job AI duy nhất là `analyze_brief` (chia cảnh) và `edit_plan` (chọn điểm cắt cho bản hoàn chỉnh, xem bên dưới), cùng dùng quota AI của account pool như mọi job văn bản/EDL.

Bật (mặc định tắt) trong `.env` rồi restart server:

```dotenv
LAN_ENABLED=true
# LAN_PORT=8790          # mặc định 8790, phải khác PORT
# LAN_REQUIRE_CODE=false # mặc định false: mở ngay, không có màn đăng nhập (22/10/2026). true: đòi mã chung như trước
# LAN_ACCESS_CODE=       # chỉ dùng khi LAN_REQUIRE_CODE=true; để trống: server tự sinh mã 8 ký tự và ghi vào .env
```

**Không cần mã truy cập (mặc định, `LAN_REQUIRE_CODE=false`).** Không có màn đăng nhập, không có phiên (nên không có hạn phiên); mọi route LAN dùng được ngay. Server không tự sinh và không đòi `LAN_ACCESS_CODE`. Vẫn giữ nguyên: listener riêng chỉ có route planner, kiểm tra `Host`, `Origin` bắt buộc cho request ghi, chặn `Sec-Fetch-Site: cross-site`, CSP và header an toàn, **toàn bộ giới hạn theo IP và trần hàng đợi LAN (6)**, danh sách file được phép của `/lan/files/*`, app chính không truy cập được từ LAN. Hệ quả cần biết: **bất kỳ máy nào trong cùng mạng đều dùng được** (và thấy kế hoạch của nhau), chỉ bị chặn bởi hạn mức theo IP; tên người tạo do họ tự nhập, không xác thực. Chỉ nên bật trong mạng tin cậy. Muốn quay lại như cũ: `LAN_REQUIRE_CODE=true` (+ `LAN_ACCESS_CODE` hoặc để trống cho server tự sinh) rồi restart; giá trị `LAN_REQUIRE_CODE` lạ/gõ sai được hiểu là `true` (không âm thầm mở trang ra mạng). Cookie client ẩn danh của công cụ Xoá logo (quyền xem việc của chính trình duyệt đó) có `Max-Age` 400 ngày; việc vẫn tự xoá sau 7 ngày.

- Server mở **listener thứ hai** (cùng tiến trình, chung DB) ở `LAN_HOST:LAN_PORT` (mặc định `0.0.0.0:8790`). App chính vẫn chỉ nghe `127.0.0.1:8787`; listener LAN chỉ có trang planner, `/lan/api/*` và `/lan/files/*`, tuyệt đối không có `/api/*`, worker, ai, approve, jobs hay file của dự án thường.
- Trên web app chính, nút **Chia sẻ LAN** (header) hiện trạng thái, các URL `http://<IP LAN>:8790` để gửi cho đồng nghiệp, số việc LAN trong hàng đợi và số việc render đang chạy/tối đa. Không cần mã: khối hiện "Không cần mã truy cập". Chỉ khi `LAN_REQUIRE_CODE=true` mới hiện mã (ẩn/hiện, sao chép; mã nằm trong `.env`, đổi mã hoặc tắt LAN bằng cách sửa `.env` rồi restart, mọi phiên cũ mất hiệu lực).
- Khi `LAN_REQUIRE_CODE=true`: đăng nhập bằng mã → cookie phiên 12 giờ (sai mã 10 lần/15 phút). Giới hạn theo IP (luôn áp dụng): sai mã 10 lần/15 phút, 6 lượt phân tích/giờ, 20 kế hoạch/giờ, 60 ảnh/giờ, 30 video tải lên/giờ, 6 lần dựng hoặc render lại bản hoàn chỉnh/giờ, 6 lần xoá logo/giờ; ảnh ≤ 10 MB, tối đa 12 ảnh mỗi kế hoạch. Mọi người thấy kế hoạch của nhau (tên người tạo do họ tự nhập, không xác thực).
- Không có HTTPS: trang chạy HTTP trong LAN, nên chỉ dùng trong mạng tin cậy; nếu đòi mã thì mã truy cập đi qua mạng không mã hóa. Nút sao chép dùng phương án dự phòng vì trình duyệt không cho `navigator.clipboard` ở HTTP.
- Kế hoạch LAN là dự án thường (`projects.source='lan'`, nhãn **LAN · tên người tạo** trên web). Chủ máy xem và sản xuất từ đó như dự án khác; cảnh đang có job của chủ máy thì LAN không tải storyboard lên được. Mã cảnh luôn là `C1, C2, …` (server chuẩn hóa `scene_01` → `C1` cho dự án LAN). Dự án LAN không bao giờ tự tạo job storyboard khi phân tích xong, kể cả khi `REQUIRE_PROMPT_APPROVAL=false`.
- Worker chưa chạy: trang hiện "Máy chủ AI chưa sẵn sàng, yêu cầu đang xếp hàng" và job chờ như mọi job `analyze_brief`. Xem thêm mục **Hàng đợi** bên dưới (vị trí chờ AI và chờ render).
- Log không ghi mã truy cập (nếu có), cookie hay nội dung ảnh (đăng nhập sai chỉ ghi IP). Lỗi mở cổng LAN (cổng bận) được ghi log và hiện ở nút Chia sẻ LAN; app chính vẫn chạy.
- Dev: `LAN_ENABLED=true npm run dev` rồi mở `http://localhost:5173/planner.html` (Vite proxy `/lan` → `LAN_PORT`). Kiểm thử thủ công dùng ROOT/DB/cổng tạm (`AUTOVIDEO_ENV_FILE`, `ROOT_DIR`, `DB_PATH`, `PORT`, `LAN_PORT`), không dùng `.env`/`data/` thật.
### LAN: tab Autovideo (05/11/2026)

Đồng nghiệp làm như chủ máy: tạo dự án (kịch bản + ảnh) → AI chia cảnh → bấm **Tạo storyboard** (Muse hoặc Google Flow, chọn theo dự án) → **Tạo video** (Muse / Flow Veo Fast / Veo Lite / Omni, chọn mỗi lần bấm, nhớ trên trình duyệt) → **Dùng video lượt n** → tab Bản hoàn chỉnh như kế hoạch prompt. Có sửa prompt, hủy việc còn chờ, tạo hàng loạt (hộp xác nhận ghi số credit Flow ước tính).

- **Tốn hạn mức của chủ máy**: job chạy bằng worker nền `media-api-1` (`npm run worker:media`) với Muse2API/Flow2API của máy này. Worker không chạy → việc xếp hàng, trang báo "Máy tạo ảnh/video chưa chạy". Hàng đợi tạm dừng (LOGIN_REQUIRED, CAPTCHA, hết credit) → trang LAN chỉ hiện câu chung; chủ máy xử lý rồi bấm tiếp tục hàng đợi.
- **Giới hạn**: 5 lượt video mỗi cảnh (lượt đầu + tạo lại, từ 05/11/2026; dự án Autovideo cũ được nâng lên 5); theo IP mỗi giờ 40 cảnh storyboard, 20 cảnh video, 10 dự án; tổng 20 job ảnh/video LAN đang chờ/chạy. Việc của chủ máy luôn được nhận trước việc Autovideo (không ngắt việc đang chạy).
- **Tắt**: `LAN_AUTOVIDEO=false` trong `.env` rồi restart: tab vẫn hiện, nút tạo bị khóa; video đã có vẫn dựng bản hoàn chỉnh được.
- Trên app chính, dự án Autovideo là dự án LAN bình thường (`lan_mode='auto'`); chủ máy xem, duyệt, hủy như dự án khác. Migration `019_lan_autovideo` chỉ thêm cột `projects.lan_mode` (mặc định `'plan'`).

### LAN: video cảnh, bản hoàn chỉnh và công cụ Xoá logo Veo (22/10/2026)

Dùng `FINAL_RENDERER`, `SHOTCUT_MCP_*`, `WATERMARK_REMOVER`, `GWR_CLI`, `RENDER_CONCURRENCY` (xem `server/API.md` mục 2); cần managed worker nhận `edit_plan` (đã có trong `WORKER_TYPES` mặc định).

- **Bước 3 (tải video đã tạo):** mỗi thẻ cảnh có khối tải video Flow lên (mp4/mov ≤ 200 MB, 1–60 giây, tối đa 5 bản mỗi cảnh, video mới tải tự thành video của cảnh). Server ghi **thẳng xuống đĩa theo luồng** (không giữ cả file trong RAM) vào `output/<slug>/video/<code>_v<n>.mp4`, ffprobe rồi gắn tên nguyên tử. Không đổi trạng thái cảnh, không tạo job.
- **Bản hoàn chỉnh:** khi mọi cảnh có video, người LAN bấm **Dựng bản hoàn chỉnh** (không tự chạy khi upload). `edit_plan` → AI chọn điểm cắt → server render (Shotcut hoặc ffmpeg) → xoá logo Veo → sẵn sàng. Họ xem/tải bản sạch, tải bản gốc còn logo, xem timeline cắt kèm lý do, chỉnh điểm cắt và render lại (version mới). Không có "Mở trong Shotcut" cho LAN. Trên app chính đây là bản dựng bình thường ở trang **Bản hoàn chỉnh** của dự án (nhãn LAN); điều kiện dựng của dự án LAN chỉ là "mọi cảnh có video được chọn", dự án `app` giữ nguyên (cảnh `done`).
- **Xoá logo Veo (tab riêng):** tải một video bất kỳ (mp4/mov ≤ 200 MB, 1–120 giây), chạy tool xoá logo, tải bản sạch. Việc xếp vào **cùng hàng đợi render chung** (chạy song song tối đa `RENDER_CONCURRENCY` việc, mặc định 2, xem mục Hàng đợi); chỉ trình duyệt tạo việc (cookie `autovideo_lan_client`, 400 ngày, DB chỉ lưu băm) thấy/tải/hủy được việc đó. File ở `output/lan-tools/<id>/`, tự xoá sau 7 ngày. Server khởi động lại giữa lúc xử lý → **mọi** việc đang xử lý hoặc chờ đều `failed`, giữ input để **Thử lại**. Tool tắt hoặc lỗi (`WATERMARK_REMOVER=off`, thiếu `GWR_CLI`) → nút bị khóa kèm lý do.
- **Tài nguyên:** trần **6 việc từ LAN** cùng lúc trong hàng đợi (bản dựng LAN + việc công cụ; vượt → "Hàng đợi đang đầy, thử lại sau"); tối đa 2 luồng tải video đồng thời mỗi IP và 4 toàn listener. Việc của **app chính** (chủ máy) luôn được lấy trước việc LAN đang chờ trong hàng đợi render (việc đang chạy không bị ngắt). Khối **Chia sẻ LAN** trên app chính hiện số việc xoá logo trong 24 giờ và số việc LAN đang trong hàng đợi.
- **Bảo mật:** các route mới chỉ có trên listener LAN, sau Host/Origin (và phiên nếu `LAN_REQUIRE_CODE=true`) như mọi route. `/lan/files` chỉ thêm: video `lan_upload` của cảnh LAN, file bản dựng của dự án LAN (mp4 sạch, raw, contact sheet; không `.mlt`), bản sạch của việc công cụ cho đúng chủ. Không có file của dự án `app`.
- Trình duyệt tải video bằng XHR có tiến độ; Range bật cho `/lan/files` nên video tua được.

- Gói giao diện: `npm run build` tạo `web/dist/planner.html` (bundle riêng, ~10 KB gzip + phần React dùng chung); listener LAN phục vụ trực tiếp từ `web/dist`, chạy lại build rồi tải lại trang là đủ (không cần restart).

### Hàng đợi: AI chọn điểm cắt tuần tự, render/xoá logo song song (22/10/2026)

Hai hàng đợi khác nhau; giao diện (LAN và app chính) hiển thị cả hai.

### Góp ý cho AI và chỉnh màu sau Edit tự động (26/10/2026)

Bản `ready` có khối **Góp ý cho AI** và panel **Chỉnh màu** (app chính: trang Bản hoàn chỉnh; LAN: khối Bản hoàn chỉnh). Mỗi góp ý/chỉnh tay tạo **phiên bản mới** (`parent_id`), bản cũ giữ nguyên. Góp ý dùng lại job `edit_plan` với `payload.revision` (managed worker nhận như `edit_plan` thường, không cần loại job mới, không có biến môi trường mới). Chỉ đổi màu: **không render, không xoá logo lại**; bản sạch của bản cha được hard link thành `<slug>_final_v<n>_base.mp4` rồi ffmpeg (`eq`, `colortemperature`, `vibrance`) chỉnh màu ra bản giao, xong sau vài giây tới vài chục giây. Đổi điểm cắt: render → xoá logo → chỉnh màu. **Chỉnh màu luôn SAU xoá logo.** Bước chỉnh màu (`stage="grade"`) chạy trong hàng đợi render chung (tôn trọng `RENDER_CONCURRENCY`, app trước LAN), hủy được (giữ bản sạch, `failed_stage="grade"`, nút «Thử chỉnh màu lại»). Server khởi động lại giữa lúc chỉnh màu → `failed` ở bước grade và dọn file tạm. Dung lượng: mỗi phiên bản chỉnh màu thêm một bản giao (re-encode crf 18); `_base.mp4` là hard link nên không tốn thêm. Ảnh xem trước nằm ở `output/<slug>/final/preview/` (tối đa 120 ảnh mỗi dự án). LAN: góp ý 20/giờ/IP, chỉnh tay 30/giờ/IP, xem trước 60/giờ/IP; góp ý/chỉnh tay tính vào trần hàng đợi 6; bản sạch `_base.mp4` không phục vụ qua LAN. Chi tiết API: `server/API.md` 5.7, 6.5, 13.3; prompt AI: `WORKER.md` 4.5.1.

**1. Bước AI chọn điểm cắt (`edit_plan`) và phân tích (`analyze_brief`): một worker, tuần tự.** Có **một** managed worker trên máy (process lock) xử lý lần lượt từng job; không chạy song song. Vị trí trong hàng đợi của một job = số job `queued` **đủ điều kiện**, **cùng làn worker** (managed hoặc legacy, theo `MANAGED_JOB_TYPES`), có id nhỏ hơn + 1; job `claimed/running` trong làn đó là "việc worker đang bận". Đủ điều kiện = không chờ duyệt, không bị hoãn (`wait_reason` với `next_attempt_at` tương lai, vd hết hạn mức AI), không lỗi thời (bản dựng không còn `planning`, cảnh lệch trạng thái) và qua `claimBlockReason` (cảnh đang có job khác, trần video...). API trả `ai_queue` trong FinalCut (khi `planning`) và `analysis.queue` của kế hoạch LAN (khi chờ). Giao diện: "Đang xếp hàng chờ AI (vị trí N)" kèm lý do (máy chủ AI chưa sẵn sàng, hàng đợi tạm dừng, hết hạn mức, đang bận việc khác); khi worker nhận thì "AI đang chọn điểm cắt". Server so sánh vị trí mỗi 3 giây (chỉ khi có người nghe SSE) và phát `final_cut.updated` khi đổi.

**2. Render + xoá logo (bản dựng của app/LAN và việc công cụ xoá logo LAN): song song tối đa `RENDER_CONCURRENCY` việc** (mặc định 2, kẹp 1–4). Việc của dự án `app` được lấy trước việc LAN đang chờ (FIFO trong từng nhóm), không ngắt việc đang chạy. Hủy chỉ ảnh hưởng đúng việc đó; "hủy rồi xếp lại ngay" cùng một việc đợi việc cũ dừng hẳn mới chạy (không dùng chung file tạm). Server khởi động lại: mọi bản `rendering` (kể cả đang ở bước xoá logo) và mọi việc công cụ `processing/queued` đều thành `failed` (giữ bản raw / input). API trả `queue_state` (`waiting` = đã xếp hàng nhưng chưa bắt đầu | `running`), `queue_position` (1 = chạy tiếp theo), `running_count`, `concurrency`; giao diện: "Đang xếp hàng render (vị trí N · đang chạy X/Y việc)" rồi "Đang render N%" / "Đang xoá logo N%".

Chọn `RENDER_CONCURRENCY`: máy hiện tại Apple M4 10 nhân, 16 GB RAM → 2 là hợp lý. Mỗi việc xoá logo là một tiến trình `gwr` (node + static server cổng ngẫu nhiên 127.0.0.1 + Chromium headless riêng, không dùng profile/cổng chung) nên chạy song song an toàn; đã kiểm chứng hai tiến trình `gwr` thật cùng lúc trên hai clip ngắn (test `lan-tools-parallel-integration`). Mỗi render Shotcut mở một tiến trình MCP riêng; Shotcut MCP tự giới hạn số render nền đang hoạt động bằng `SHOTCUT_MCP_MAX_ACTIVE_RENDERS` (mặc định 2, tính chung giữa các tiến trình MCP của cùng người dùng): server tự đặt biến này bằng `RENDER_CONCURRENCY` khi mở MCP nếu giá trị hiện có thấp hơn (chỉ khi `RENDER_CONCURRENCY` > 2). Đặt 3–4 chỉ khi còn dư RAM/CPU: render ffmpeg/Shotcut và Chromium cùng chạy rất nặng. Không có giới hạn riêng cho bước xoá logo (`CLEAN_CONCURRENCY`) vì chạy song song an toàn.


### Màu theo ảnh mẫu và file LUT (26/10/2026)

Trong panel **Chỉnh màu** có mục **Màu theo ảnh mẫu**: chọn/tải một ảnh (kéo thả, dán, chọn file, hoặc chép từ ảnh tham chiếu/storyboard của dự án) hoặc tải file LUT `.cube`; video được kéo về tông màu đó rồi vẫn chỉnh thêm bằng thanh trượt hoặc góp ý "ấm hơn". **Tất định, không dùng AI, không biến môi trường mới.**

- **Cách tính:** thống kê trong không gian lαβ (log-LMS, Reinhard) của ảnh mẫu và của bản sạch chưa chỉnh màu (12 khung), chuyển màu kiểu Reinhard (tỉ lệ σ kênh sắc kẹp 0,8–1,25, kênh sáng 0,6–1,6; bỏ pixel L*<3 hoặc >97), sinh LUT 3D 33³ và áp bằng `lut3d` TRƯỚC `eq/colortemperature/vibrance`. lαβ giữ vùng trắng/xám ở trung tính (CIELAB làm chúng ngả hồng/vàng). Chế độ mặc định chỉ lấy tông màu (giữ độ chói Y ⇔ L*), "giống cả độ sáng" chuyển luôn L*; cường độ mặc định 70%; tuỳ chọn khớp riêng từng cảnh (mỗi cảnh một LUT, áp theo `enable between(t,a,b)`).
- **File ở đâu:** ảnh mẫu/LUT đã tải ở `output/<slug>/final/color-refs/` (đặt tên theo hash nội dung; LUT là bản **chuẩn hoá do server ghi lại**, không giữ file gốc); LUT sinh ra ở `output/<slug>/final/luts/<hash>.cube` (bộ nhớ đệm: tính lại theo hash khi cần, giữ ≤ 80 file mỗi dự án, chỉ xoá file cũ hơn 1 giờ). Grade của phiên bản chỉ lưu `match {kind, ref_id, strength, mode, per_scene}`, không lưu đường dẫn LUT. Bảng mới `color_refs` (migration 013, chỉ thêm bảng/index). Các file này nằm trong `output/<slug>/` nên đi theo dự án vào/ra thùng rác và bị xoá khi xoá vĩnh viễn (dòng `color_refs` CASCADE).
- **Xoá:** ảnh mẫu/LUT chưa bản dựng nào dùng thì xoá được trong giao diện (nút x); đang dùng → 409 `COLOR_REF_IN_USE`. Dung lượng: LUT 33³ ≈ 0,9 MB mỗi file; khớp theo cảnh sinh mỗi cảnh một file.
- **Giới hạn:** ảnh ≤ 15 MB (png/jpg/webp, kiểm tra magic bytes), `.cube` ≤ 5 MB cỡ 2–65 (`DOMAIN` chỉ 0–1, từ chối LUT 1D). LAN: tải lên/chép 20 lần/giờ/IP; ảnh mẫu và thumb phục vụ qua `/lan/files`, **file `.cube` không bao giờ phục vụ**.
- **AI góp ý:** `payload.revision.parent_grade.match` có kèm `original_name`; AI giữ nguyên `match` trừ khi được bảo bỏ/đổi cường độ (server ép `kind`/`ref_id` về của bản cha, AI không tự chọn ảnh mẫu mới).
- **Rollback/DB cũ:** migration `013_color_refs.sql` chỉ thêm bảng; code cũ chạy trên DB đã lên 013 vẫn đọc được nhưng một phiên bản có `grade.match` sẽ bị code cũ bỏ qua khi chỉnh lại (zod bỏ khoá lạ): restore backup tương ứng trước khi quay lại.

## Thùng rác dự án (xoá 30 ngày, khôi phục được) — 22/10/2026

Video trong dự án là kết quả tạo thật nên xoá dự án luôn là **xoá mềm**, không có xoá cứng tức thì.

- **Xoá** (`DELETE /api/projects/:id`, gõ đúng tên; hoặc người tạo kế hoạch LAN bấm "Xoá kế hoạch"): hủy job `queued`, đặt `projects.deleted_at/deleted_by/trash_path`, rồi sau commit `rename` `output/<slug>/` và `refs/<id>/` vào `output/.trash/<id>-<slug>-<mốc>/{output,refs}/` (cùng ổ). Lỗi chuyển file thì hoàn tác file và `deleted_at=NULL`. Dự án biến khỏi mọi API/danh sách/`/files`/`/lan/files`/worker; slug vẫn bị giữ.
- **Bị chặn (409)** khi: có job `claimed`/`running`; có bản dựng `planning`/`rendering` hoặc còn trong hàng đợi render; có job managed với thao tác Flow/ChatGPT còn sống (`intent`/`uncertain`/`submitted`/`downloaded`, cần đối soát ở trang Hàng đợi trước); đang có video LAN được tải lên.
- **Khôi phục** (trang "Thùng rác" ở app chính): chuyển file về đúng chỗ cũ, **không ghi đè**; nếu `output/<slug>/` hay `refs/<id>/` đã có nội dung thì 409 và chủ máy phải tự dời thư mục đó đi. LAN không khôi phục được.
- **Xoá vĩnh viễn** (gõ lại tên, hoặc tự động): xoá thư mục thùng rác rồi `DELETE FROM projects` (cascade; nhật ký của dự án mất theo). `TRASH_RETENTION_DAYS` (mặc định 30) quyết định hạn; bộ dọn chạy lúc khởi động và mỗi giờ, đồng thời hoàn tất việc chuyển file bị gián đoạn nếu tiến trình chết giữa commit và `rename`.
- **Dung lượng:** thư mục thùng rác nằm trong `output/.trash/` và vẫn chiếm đĩa tới khi xoá vĩnh viễn; trang Thùng rác hiện dung lượng từng dự án. Đừng xoá tay `output/.trash/` khi còn dự án trong thùng rác (khôi phục sẽ không còn file).
- **Quyền LAN:** kế hoạch tạo từ giờ lưu SHA-256 của cookie client `autovideo_lan_client` (`projects.lan_client_hash`); chỉ trình duyệt đó xoá được từ trang LAN (10 lần/giờ/IP). Kế hoạch cũ chỉ xoá được từ app chính. Xoá cookie hoặc đổi trình duyệt thì mất quyền xoá.
- **Rollback/DB cũ:** migration `011_project_trash.sql` chỉ thêm 4 cột + 1 index vào `projects`. Chạy code cũ trên DB đã lên 011 vẫn đọc được nhưng thấy cả dự án trong thùng rác (không biết `deleted_at`): restore backup tương ứng trước khi quay lại.

## Highlight từ video dài (27/10/2026)

Tải video dài (livestream, podcast, review… tiếng Việt) lên mục "Highlight" của web (hoặc tab "Highlight" của trang LAN): server nhận dạng lời nói, AI chọn đoạn hay, người dùng duyệt/sửa điểm cắt trên lời thoại, server dựng clip 9:16 có phụ đề chạy theo từng từ. Hợp đồng API: `server/API.md` mục 14; kế hoạch gốc: `PLAN-long-video-to-shorts.md`.

- **Nhận dạng lời nói = dịch vụ STT nội bộ** (Omnix, chuẩn OpenAI), không chạy model trên máy này. `.env`: `STT_URL=http://10.0.3.214:18085/v1/audio/transcriptions` (chỉ HTTP; HTTPS của dịch vụ không chạy), `STT_TENANT_ID=s-omnix-studio`; `STT_PROVIDER` để trống = `omnix` nếu có `STT_URL`. Không có `STT_URL` thì tải lên vẫn nhận file nhưng video báo "Chưa cấu hình nhận dạng lời nói". Kiểm tra dịch vụ: `curl http://10.0.3.214:18085/health`; thử tích hợp thật bằng audio tổng hợp ngắn (`say -v Linh -o a.aiff "…"`): `npx tsx server/src/scripts/stt-smoke.ts a.aiff "Tên riêng, thuật ngữ"` (in job id, văn bản, số từ và hình dạng phản hồi của `GET /v1/stt/jobs/{id}`; KHÔNG chạy trong `npm test`).
- Dịch vụ xử lý **một file một lúc** (~20× thời gian thực: video 1 giờ ≈ 3 phút), nên server xếp hàng đợi một việc một lúc cho nhận dạng (app chính trước LAN) và hiện vị trí. Tiến độ là ƯỚC TÍNH theo thời gian (`duration/20 s + 5 s`, kẹp 95% tới khi xong). Lỗi tạm (502/503 `no_capacity`, `fetch_failed`, `runtime_*`, lỗi mạng) thử lại 10 s / 30 s / 90 s; timeout 504 hoặc đứt kết nối sau khi có `X-Job-Id` thì hỏi lại `GET /v1/stt/jobs/{id}` (header `X-Tenant-ID`). Lưu ý đã đo: phản hồi của endpoint này **không có mốc từng từ**, nên server gửi lại file thay vì dùng kết quả đó. Khởi động lại giữa chừng: video `transcribing` được xếp lại tự động.
- **Dung lượng**: video nguồn nặng. Giới hạn app chính 4 GiB/3 giờ, LAN 2 GiB/3 giờ (`CLIP_SOURCE_MAX_*`, `LAN_CLIP_SOURCE_MAX_*`). Tải lên bị chặn (507) nếu ổ đĩa trống < `CLIP_MIN_FREE_GB` (10) + 3 × dung lượng file; dựng clip kiểm tra tương tự. App chính giữ video gốc đến khi xoá dự án (vào thùng rác như mọi dự án, file đi theo `output/<slug>/`); **video gốc của LAN tự xoá sau `LAN_CLIP_SOURCE_RETENTION_DAYS` (7) ngày** (giữ transcript, bản xem thử 480p và clip). Ổ đĩa còn ~49 GB: theo dõi `output/*/clips/source/`.
- **ffmpeg cần libass cho phụ đề**: ffmpeg của Homebrew trên máy này **không có** bộ lọc `subtitles`/`drawtext` (Shotcut cũng không). Không có libass thì "Dựng clip" với phụ đề trả `409 CAPTIONS_UNAVAILABLE` (chọn "Không phụ đề" vẫn dựng được) và `GET /api/clip-status` báo `captions.available=false`. Cách xử lý: `brew install ffmpeg-full` (server tự dò `/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg`) hoặc đặt `CLIP_FFMPEG_PATH` tới một ffmpeg có `subtitles` + `boxblur` + `overlay` + libx264/aac (server kiểm tra đủ bộ; một số bản conda-forge thiếu `boxblur`). Việc cài đặt do chủ máy quyết định (không tự cài). ffmpeg đó chỉ dùng cho bản dựng clip có phụ đề; các bản dựng khác không đổi.
- **Font phụ đề**: `CLIP_CAPTION_FONT` mặc định `Arial` (đậm). Đã kiểm chứng bằng render thật câu "Ưu đãi đặc biệt hôm nay: giảm giá sốc, mua ngay!" ở 1080×1920 (đã xem ảnh render trực tiếp khi làm đợt này): Arial Bold, Helvetica Neue Bold, Verdana Bold, Tahoma Bold, Trebuchet MS Bold đều hiển thị đủ dấu tiếng Việt; chọn Arial Bold vì có sẵn trên mọi máy macOS. Server chép `Arial Bold.ttf` vào `<thư mục DB>/clip-fonts` (`fontsdir` của libass, không quét cả thư mục font hệ thống). Muốn font riêng (vd Be Vietnam Pro, OFL): đặt `CLIP_FONTS_DIR` và `CLIP_CAPTION_FONT` đúng tên family.
- **Hàng đợi**: AI chọn đoạn là job `clip_plan` trong hàng đợi AI chung (managed worker, hoặc worker legacy theo WORKER.md 4.6; `WORKER_TYPES` mặc định của managed worker đã có `clip_plan`; với `MANAGED_JOB_TYPES` có liệt kê thì thêm `clip_plan`). Dựng clip dùng chung hàng đợi render (`RENDER_CONCURRENCY`, app trước LAN, hiện vị trí); bản xem thử 480p của video LAN cũng nằm trong hàng đợi đó. Trần hàng đợi LAN (6) tính cả nhận dạng/AI/dựng của LAN (`/lan/api/status` → `queue.clips`).
- **Sửa lỗi AI chọn 0 clip (27/10/2026)**: nhận dạng mới đo khoảng lặng thật trong audio, không dựa vào các segment ~20 s hoặc mốc từ liền nhau của STT. Câu trích đầu/cuối xác định điểm cắt tới từng từ; kết quả và checkpoint có `diagnostics` (số đề xuất thô/lý do loại). Inference timeout/mạng lỗi thử lại tối đa 2 lần (1/2 s), giữ cơ chế chờ quota/lease hiện có. Transcript cũ vẫn đọc được; chỉ bản cache dùng cho dự án mới được nâng cấp khoảng lặng, không đổi ID của clip cũ. Cập nhật worker cần lần khởi động worker tiếp theo; việc sửa mã không tự chạy worker hay tạo job.
- **Khởi động lại**: bản dựng clip đang `rendering` → `failed` ("Server khởi động lại trong lúc dựng", dọn file dở); video đang nhận dạng được xếp lại; job `clip_plan` do cơ chế lease/checkpoint chung xử lý (resume hoặc trả về hàng đợi).
- **LAN**: tab "Highlight" cùng bộ endpoint `/lan/api/...`; hạn mức/giờ/IP: tạo dự án 10, video nguồn 3 (1 lượt tải đồng thời mỗi IP), AI chọn đoạn 6, dựng 30, sửa 120. Video gốc KHÔNG được phục vụ qua LAN (chỉ bản xem thử 480p, poster, ảnh clip, clip `ready`).
- **Triển khai**: migration `014_clips.sql` thêm `projects.kind/stt_terms`, dựng lại bảng `jobs` (loại `clip_plan`, đúng quy trình 003; đã thử trên bản sao DB thật: `foreign_key_check` rỗng, `integrity_check=ok`, số dòng mọi bảng và `sqlite_sequence` của `jobs` không đổi) và tạo `source_videos`, `clips`, `clip_cuts`. Server tự sao lưu DB trước khi migrate (`data/backup/`). **Rollback**: code cũ không biết loại `clip_plan`/bảng mới nhưng đọc được DB đã lên 014; dự án highlight sẽ hiện lẫn trong danh sách dự án (không có `kind`) — restore bản sao lưu DB tương ứng trước khi quay lại. Triển khai khi máy rảnh (không có render/job đang chạy).
- **Quy ước chung**: thời gian cắt không bao giờ lấy từ giây do AI viết (AI chỉ trả ID câu; server tự bám khoảng lặng: −0.15 s đầu, +0.30 s cuối, không cắt vào từ); phụ đề lấy chữ ASR (chữ thường, số đọc thành chữ) hoặc bản đã khôi phục dấu câu/sửa tay.

## Bỏ credit khỏi hệ thống (04/11/2026)

Video tạo qua API (Muse2API) không tốn credit Flow, nên web/server không còn khái niệm credit: không còn `credit_per_video` khi tạo/sửa dự án, không còn xác nhận tổng credit khi duyệt (approve-all bỏ qua `expectedCredits` của client cũ), không còn `credits_expected` trong payload video, không ghi `credit_ledger`, `jobs.credits_cost` luôn 0 với job mới, đã bỏ `GET /ledger` và `/ledger.csv` (trang "Nhật ký" chỉ còn dòng thời gian). Cột/bảng credit vẫn giữ trong DB, không có migration. Giới hạn duy nhất vẫn là số lượt mỗi cảnh: job video lỗi chỉ chiếm lượt khi worker `fail` kèm `attempt_used: true` (worker cũ gửi `credits_cost > 0` cũng được hiểu như vậy) hoặc khi đối soát `charge_and_fail`; hàng cũ có `credits_cost > 0` vẫn được tính. Mã lỗi `FLOW_OUT_OF_CREDIT` giữ nguyên, web hiện "Hết hạn mức tạo video". Managed worker (Flow) bỏ bước đối chiếu dòng credit trong precheck.

## Kiểm chứng và rollback

`npm test`, `npm run typecheck`, `npm run build`.

`npm run ai:smoke -- <id>` chạy một job phân tích inference thật trên API/DB tạm riêng (không tạo ảnh/video). Thêm `--fallback` để giả lập gateway A trả quota rồi chuyển sang account được chọn để inference thật. Lệnh này sử dụng quota AI; không nằm trong bộ test mặc định. Test gateway dùng HTTP local giả lập quota; không sử dụng token/tài khoản thật. Xem `docs/ai/VALIDATION.md` để phân biệt phần đã kiểm tra với phần còn cần chạy thật.

Rollback: `docs/ai/ROLLBACK.md`. Không chạy code baseline trên DB đã migrate mà chưa restore backup tương ứng.

## Làm gọn lời nói của clip

- Migration `015_clip_cleanup.sql` chỉ thêm `clips.cleanup`, `clips.edit_revision` (mặc định 0), `clip_cuts.edit_snapshot`; không đổi migration cũ, không sửa source/bản dựng cũ. Triển khai khi rảnh; server sao lưu DB trước khi migrate như cũ.
- Dùng managed `clip_plan` với `payload.mode=cleanup`; `WORKER_MODE=managed`, `MANAGED_JOB_TYPES` trống hoặc có `clip_plan`, `WORKER_TYPES` phải có `clip_plan`. **Worker cần khởi động lại để nạp mã mới**; worker mới gửi `features=clip_cleanup` khi nhận việc. Worker cũ bị bỏ qua cho yêu cầu làm gọn để không nhầm với việc chọn clip. Không tự chạy worker khi chỉ sửa mã; chờ yêu cầu sản xuất của người dùng.
- Làm gọn là bước bắt buộc sau khi tạo clip (AI hoặc thủ công). Server tự xếp từng job, tự áp dụng điểm bỏ hợp lệ, chỉ hiện clip sau khi xong; kết quả rỗng vẫn hợp lệ. Lỗi giữ clip chờ, không tự retry vô hạn. Không tự bỏ câu vì cho rằng sai kiến thức; chỉ đề xuất phần nói vấp/lặp hoặc tự sửa có phần nói lại rõ ràng. Có thể bỏ sót khi STT không ghi tiếng đệm. Không cần model STT khác để dùng chức năng này.
- Thanh thời gian hiển thị vùng giữ/bỏ, danh sách lý do và vị trí trên video dài; kéo hai đầu bám từ, nghe thử, khôi phục đoạn sai rồi lưu. Chỉnh sửa không tự render. Lần dựng sau dùng các đoạn giữ và tính lại đồng hồ phụ đề. Mỗi bản dựng chụp lựa chọn/phụ đề lúc xếp hàng; hoàn tác sau đó không làm đổi bản đang dựng. Lưu lựa chọn rỗng để khôi phục toàn bộ; đổi điểm đầu/cuối tự xếp lại bước làm gọn. Bản dựng cũ không còn khớp bị đánh dấu stale và không đưa vào ZIP.
- Clip cũ chưa làm gọn: `POST /api/projects/:id/process-clips {}` tiếp tục; `{reprocess:true}` chạy lại tất cả clip chưa bỏ trong dự án (từ chối khi đang có job). Nút “Tiếp tục xử lý clip” phục hồi lỗi/clip cũ. API không render clip chưa làm gọn (`409 CLEANUP_REQUIRED`).
- Kiểm thử bằng DB/video tạm, inference giả; không chạy inference/Flow thật hoặc worker sản xuất từ bộ test. Xem API mục 14.9.

### Bản sửa sau review làm gọn (2026-10-28)

- Triển khai migration 016 mới (capability worker + index cleanup/discovery); không sửa migration 015 đã áp dụng. Khởi động lại server khi hàng đợi rảnh, có DB backup. Worker hiện tại đã gửi `features=clip_cleanup`, không cần chạy inference để đăng ký capability.
- Job không được worker phù hợp nhận trong 5 phút chuyển failed để không khóa dự án mãi; quota wait/backlog của worker phù hợp/hàng đợi tạm dừng vẫn giữ. Cập nhật worker rồi bấm tiếp tục để retry có chủ ý.
- Lưu chỉnh sửa bị chặn ở UI/API khi cùng clip đang chạy lại AI; không làm mất revision hoặc dấu job mới. Hạn mức nút tiếp tục lấy `plan`, độc lập `render`.
- Nguồn/transcript làm gọn gắn với source_id của clip. Timeline dùng retained_segments từ server; phụ đề giữ từ ASR zero-duration ở vùng giữ. Bản dựng cũ thiếu snapshot và có phụ đề người dùng sửa được đánh dấu cần dựng lại cả sau reload/máy khác.

## Clip ghép nhiều đoạn (montage)

- Migration `017_clip_parts.sql` chỉ thêm cột `clips.parts` (NULL cho mọi clip cũ = clip một đoạn); không sửa dữ liệu hay migration cũ. Server sao lưu DB trước khi migrate như cũ; triển khai khi hàng đợi rảnh. Rollback: code cũ bỏ qua cột này nên clip ghép sẽ bị hiểu thành một đoạn liền theo khung bao — restore bản sao lưu nếu đã có clip ghép.
- Clip 2–6 đoạn, phát theo thứ tự do người dùng/AI chọn; hợp đồng ở `server/API.md` 14.10. Dựng bằng nhiều input `-ss/-t` + `concat` (đã kiểm chứng bằng ffmpeg thật: 2 đoạn đảo thứ tự, có/không tiếng, độ dài khớp tổng phần giữ). Clip một đoạn dựng y như trước.
- AI chỉ đề xuất ghép khi `allow_multi` (mặc định bật; tắt bằng ô "Cho phép AI ghép nhiều đoạn" khi nhờ AI đề xuất). **Worker managed cần khởi động lại** để nạp prompt/kiểm tra mới (cả làm gọn theo từng đoạn); worker cũ vẫn chạy được: không đề xuất clip ghép, còn làm gọn clip ghép thì server kiểm tra lại theo từng đoạn và từ chối chỗ bỏ vắt qua ranh giới.
- Video ánh xạ PTS lên đồng hồ đoạn giữ trong một nhánh streaming, audio concat riêng. Không xếp đệm toàn bộ các đoạn video tương lai; tránh sai số cộng dồn ở nguồn im lặng và giữ đồng hồ phụ đề.
