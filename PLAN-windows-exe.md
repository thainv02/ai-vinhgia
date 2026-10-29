# Plan: đóng gói AutoVideo thành app .exe chạy trên Windows (máy cấu hình yếu)

Ngày lập: 29/10/2026. Trạng thái: giai đoạn 0–2 đã làm xong và đã kiểm chứng; đã bỏ Shotcut; phần probe bất đồng bộ và sao lưu trước migration của giai đoạn 5 cũng đã làm. Kết quả thực tế ở **mục 9**. Chưa commit.

> Các con số ở mục 4, 6, 7 ban đầu là giả thuyết. Số đo thật của server đóng gói (chưa có vỏ Tauri) nằm ở mục 9. Mục tiêu dung lượng đã nới theo quyết định "dung lượng không phải vấn đề lớn".

## 1. Phạm vi

**Có:**

- Một app desktop chạy trên **một máy Windows**, một người dùng, dùng trực tiếp trên app.
- Cài bằng một file installer, mở bằng shortcut, tắt là tắt hết (không để lại tiến trình chạy ngầm).
- Tối ưu cho máy yếu: khởi động nhanh, RAM thấp, giao diện không đơ khi render.

**Không có:**

- Không chia sẻ qua LAN, không truy cập từ máy khác, không đa người dùng, không quản lý tập trung, không tự cập nhật.
- Không có chức năng tự động thao tác Chrome (worker Claude in Chrome / ChatGPT / Google Flow). Không đóng gói `WORKER.md`, `jq`, prompt cho worker.

## 2. Quyết định cần chốt trước khi làm

**Bỏ worker thì dữ liệu cảnh/ảnh/video vào app bằng cách nào?**

Hiện tại chỉ worker mới tạo được cảnh (job `analyze_brief`), ảnh storyboard và video. API phía người dùng chỉ có upload ảnh tham chiếu (`POST /api/projects/:id/refs`), không có route nào để người dùng tự thêm cảnh hay tự nạp video cho cảnh. Nếu bỏ worker mà không bổ sung gì thì app chỉ còn xem lại được dữ liệu cũ và dựng bản hoàn chỉnh từ video đã có.

Các lựa chọn:

| Lựa chọn | Mô tả | Công sức thêm |
|---|---|---|
| A. Giữ nguyên API worker, chỉ không đóng gói worker | App vẫn nhận job như cũ. Sau này nếu muốn có thể chạy worker ở ngoài. Hàng đợi job sẽ đứng nếu không có worker. | 0 |
| B. Thêm nhập thủ công | Thêm các nút: tạo/sửa cảnh bằng tay, tải ảnh storyboard và video cho từng cảnh từ máy (người dùng tự tạo trên Flow rồi tải về). Ẩn các nút tạo job tự động. | khoảng 3–4 ngày |
| C. Chỉ dùng phần quản lý và dựng bản cuối | Nhập một thư mục video có sẵn thành một dự án, sắp xếp, dựng, xoá logo. Không dùng lại được `import:legacy`, vì importer đó chuyên cho dữ liệu Cacao: [legacy-import.ts](server/src/services/legacy-import.ts) hardcode tên project, file `cacao-smoothie-prompts.md`, `MOCKUP_BOX` và bản dựng có sẵn. Cần viết importer tổng quát và giao diện ánh xạ video thành cảnh. | khoảng 3 ngày |

Đề xuất: **B**. Đây là cách duy nhất để app dùng được trọn vẹn mà không cần tự động hoá Chrome. Công sức của C gần bằng B nhưng làm được ít hơn. Phần còn lại của plan áp dụng được cho cả A, B và C.

## 3. Hiện trạng liên quan đến việc đóng gói

- **Server**: Node + Fastify + `better-sqlite3` (module native) + zod.
  - Lệnh chạy production là `NODE_ENV=production tsx src/index.ts`, tức là mỗi lần khởi động lại biên dịch TypeScript. Việc này chậm, tốn RAM, và lệnh không chạy được trên cmd của Windows.
- **Web**: React 19 SPA build bằng Vite và được server phục vụ khi chạy production.
- **Công cụ ngoài**: ffmpeg/ffprobe (dựng bản cuối), gemini-watermark-remover/gwr (Node CLI, xoá logo). ~~Shotcut MCP (Python)~~: **đã bỏ** (mục 9).
- **Code hiện chỉ chạy được trên macOS**:
  - [server/src/services/media.ts](server/src/services/media.ts): hằng `SHOTCUT_BIN_DIR = '/Applications/Shotcut.app/...'` và các đường dẫn Homebrew. Phép kiểm tra `c.includes('/')` sai với đường dẫn Windows.
  - [server/src/services/final-render/watermark.ts](server/src/services/final-render/watermark.ts): `descendants()` gọi `ps -A`, mà Windows không có lệnh này.
  - [server/src/services/final-render/index.ts](server/src/services/final-render/index.ts): mở Shotcut bằng `open -a Shotcut`, chỉ có trên macOS.
  - [server/src/config.ts](server/src/config.ts) và [server/src/db/index.ts](server/src/db/index.ts): `REPO_ROOT`, `MIGRATIONS_DIR` suy ra từ `import.meta.url`, sẽ sai khi đã gom thành một file.
  - [server/src/lib/env.ts](server/src/lib/env.ts): ghi `.env` với `mode: 0o600`. Trên Windows tham số này bị bỏ qua, vô hại.
- **Thứ tự migration và sao lưu**: `buildApp()` chạy `runMigrations` ([app.ts:61](server/src/app.ts#L61)) **trước khi** [index.ts](server/src/index.ts) gọi `backupDb`. Vì vậy bản sao lưu hiện tại đã mang schema mới, không dùng được để quay về phiên bản cũ.
- **Chặn event loop**: `probeMedia()` dùng `spawnSync` với timeout 20 giây/file ([media.ts](server/src/services/media.ts)). Hàm này được gọi tuần tự cho từng đoạn trong renderer ([ffmpeg-renderer.ts:120](server/src/services/final-render/ffmpeg-renderer.ts#L120)), trong `final-cuts.ts`, `watermark.ts` và `shotcut-renderer.ts`. Trong lúc probe, API và SSE bị đứng hoàn toàn. `resolveBinary` cũng dùng `spawnSync` (timeout 8 giây), nhưng có cache nên chỉ chạy một lần.

## 4. Kiến trúc đề xuất

| Phương án | Dung lượng cài | RAM lúc rảnh | Nhận xét |
|---|---|---|---|
| Electron | khoảng 150–200MB | 250–400MB | Kèm nguyên Chromium nên **loại** |
| **Tauri v2 (WebView2) + server Node chạy sidecar** | khoảng 60–80MB (kèm ffmpeg) | khoảng 150–220MB | **Chọn** |
| Node SEA + mở Edge `--app=` | khoảng 55–75MB | tương đương | Còn cửa sổ console, khó tắt sạch, cảm giác không phải app |
| Viết lại server bằng Rust/Go | nhỏ nhất | thấp nhất | Phải viết lại khoảng 10k dòng TypeScript, không đáng |

```
AutoVideo.exe (Tauri, khoảng 5MB)
 ├─ cửa sổ WebView2  ──HTTP──▶  http://127.0.0.1:<port>
 └─ sidecar: node.exe (portable, Node 22) server/server.mjs
      ├─ Fastify API + phục vụ web/dist
      ├─ SQLite (server/node_modules/better-sqlite3)
      └─ spawn: ffmpeg.exe / ffprobe.exe / node.exe gwr.mjs
 (mọi tiến trình con nằm trong một Windows Job Object, xem giai đoạn 4)
```

Lý do chọn Tauri:

- WebView2 có sẵn trên Win10/11 (dùng chung engine với Edge), nên không phải mang theo trình duyệt.
- Cửa sổ tải thẳng URL của server cục bộ, nên **không phải sửa API**. Origin vẫn là `http://127.0.0.1:<port>`.
- Có sẵn chặn mở 2 lần, tắt sidecar khi thoát, và build installer NSIS cài theo user (không cần quyền admin).

Vì chỉ dùng trên một máy:

- Server luôn bind `127.0.0.1` (bỏ cấu hình `HOST`).
- Bỏ `EXTRA_ALLOWED_ORIGINS`. Origin cho phép chỉ còn đúng port mà app đang chạy.
- Không có tray, không chạy nền: đóng cửa sổ là thoát app.

## 5. Các giai đoạn

### Giai đoạn 0: cho code chạy được trên Windows (vẫn chạy bằng `npm`), khoảng 1 ngày

1. `resolveBinary` trong `media.ts`:
   - Thứ tự tìm: đường dẫn cấu hình → `ffmpeg.exe` nằm cạnh app → PATH. Không còn tìm trong thư mục Shotcut.
   - Kiểm tra bằng `path.isAbsolute` thay vì dò ký tự `/`.
   - Giữ các đường dẫn macOS bên trong nhánh `process.platform === 'darwin'`.
2. Dừng cây tiến trình:
   - Trên Windows dùng `taskkill /PID <pid> /T /F`.
   - Giữ `ps -A` cho macOS.
3. ~~Mở Shotcut trên Windows~~: đã bỏ cùng toàn bộ Shotcut.
4. Script `start`: bỏ cú pháp `NODE_ENV=...` (để code tự đặt, hoặc dùng `cross-env`).
5. Chạy `npm test` trên Windows và sửa các chỗ còn giả định dấu `/` hoặc `path.sep`.

### Giai đoạn 1: tách thư mục cài đặt và thư mục dữ liệu, khoảng 1 ngày

- **Thư mục cài đặt** `%LOCALAPPDATA%\Programs\AutoVideo\`: chỉ đọc. Chứa:
  - `AutoVideo.exe`, `node.exe`
  - `server/server.mjs`, `server/node_modules/better-sqlite3/` (và các dependency runtime của nó)
  - `web/` (bản build)
  - `bin/ffmpeg.exe`, `bin/ffprobe.exe`
  - `tools/gwr/`
- **Thư mục dữ liệu**: người dùng chọn lúc cài lần đầu, mặc định `D:\AutoVideo` nếu có ổ D, ngược lại là `%USERPROFILE%\AutoVideo`. Chứa:
  - `config.env`
  - `data/app.db`
  - `data/backup/`
  - `output/`, `refs/`
  - `logs/`
- `config.ts`:
  - `REPO_ROOT` tách thành `APP_DIR` và `DATA_DIR`, đọc từ tham số dòng lệnh do Tauri truyền cho sidecar.
  - Giá trị mặc định của `GWR_CLI` và `webDistDir` tính theo `APP_DIR`.
  - `ROOT_DIR` và `DB_PATH` tính theo `DATA_DIR`.
- Migrations: nhúng các file `.sql` vào bundle (esbuild loader `text`). `runMigrations` nhận danh sách `{version, sql}` thay vì đọc thư mục.
- `WORKER_TOKEN`:
  - Lựa chọn A: vẫn sinh như cũ.
  - Lựa chọn B/C: không cần nữa. Tắt các route `/api/worker/*` bằng một cờ cấu hình.

### Giai đoạn 2: build server production (lợi lớn nhất về hiệu năng), khoảng 1–2 ngày

**Cách đóng gói được chọn: `node.exe` portable + một bundle ESM + package `better-sqlite3` đầy đủ. Không dùng Node SEA.**

Lý do không dùng SEA:

- Node 22 SEA chỉ chạy được script nhúng dạng **CommonJS**. Muốn dùng thì phải build `format: 'cjs'` và thay mọi chỗ dùng `import.meta.url` (`config.ts`, `db/index.ts`, ...).
- Trong SEA, `require()` chỉ nạp được module built-in. `better-sqlite3` không chỉ có file `.node`: nó còn lớp JS (`prepare`, `transaction`, `backup`, ...) và tìm addon qua package `bindings`. Muốn chạy được thì phải gom lớp JS vào bundle, tự nạp addon bằng `process.dlopen`, rồi truyền object đó qua option `nativeBinding` của `new Database()`.
- Trong SEA, `process.execPath` là chính exe chứ không phải `node`, nên lời gọi gwr hiện tại (`spawn(process.execPath, [gwr.mjs])`) sẽ hỏng.
- SEA chính là `node.exe` nhúng thêm script, nên RAM dự kiến tương đương với `node.exe` + file `.mjs`. Dung lượng cũng dự kiến tương đương, nhưng mang package `better-sqlite3` đầy đủ vẫn làm bản cài lớn hơn một chút. **Cần đo ở mốc kiểm chứng.** Lợi ích chính của SEA là gọn thành một file, mà điều đó không quan trọng khi đã có installer.

Các bước:

1. Dùng **esbuild** gom `server/src/index.ts` thành **`server.mjs`** (`format: 'esm'`, `platform: 'node'`, `target: 'node22'`, minify, không sourcemap).
   - Không còn `tsx` và TypeScript lúc chạy.
   - `import.meta.url` vẫn chạy được (ESM thật), nhưng sau khi gom bundle nó trỏ vào `server.mjs`, không còn là vị trí file nguồn. Vì vậy **mọi đường dẫn phải lấy từ `--app-dir`/`--data-dir`** (giai đoạn 1). Rà lại để không còn chỗ nào tính đường dẫn từ `import.meta.url`.
   - Để `better-sqlite3` ở dạng external. Các dependency còn lại (fastify, zod, @fastify/*) gom vào bundle.
   - Nhiều dependency vẫn là CommonJS và gọi `require()` động (kể cả `require` module built-in). Trong bundle ESM, các lời gọi này lỗi "Dynamic require of ... is not supported". Cách sửa: thêm banner `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);`. Ở mốc kiểm chứng phải chạy thử đủ các luồng (upload multipart, phục vụ file tĩnh, SSE, render) để bắt lỗi kiểu này lúc chạy.
   - Không dùng pino transport (chạy trong worker thread, nạp file theo đường dẫn động nên dễ hỏng khi đã gom bundle). Ghi log bằng `pino.destination` vào file và tự xoay vòng trong cùng tiến trình.
2. Mang theo `better-sqlite3` kèm các dependency runtime của nó (`bindings`, `file-uri-to-path`).
   - Build script **chép từ `node_modules` đã cài bằng `npm ci`**. Phiên bản được đối chiếu với `package-lock.json`, lệch thì dừng.
   - Sau đó cắt gọn, chỉ giữ `lib/` và `build/Release/better_sqlite3.node`.
   - Addon được nạp thử bằng `node.exe` đóng gói (đúng ABI), và SHA256 của nó được ghi vào `BUILD-INFO.json`.
   - Lưu ý: file `.node` do `prebuild-install` tải từ GitHub trong lúc `npm ci`, lockfile **không** ghim hash của nó. Build chỉ phát hiện được lệch (tuỳ chọn `--expect-addon-sha256`), chưa phải build tái lập từ mã nguồn.
3. `node.exe` là bản chính thức win-x64 cùng phiên bản Node dùng để build addon (cùng ABI).
4. Chạy với `--max-old-space-size=192`, `NODE_ENV=production`.
5. Logger Fastify:
   - Mức `warn`.
   - Ghi ra `logs/server.log` có xoay vòng (giữ khoảng 5 file × 5MB), không in ra console.
6. gwr: chạy bằng chính `node.exe` này (`process.execPath`), không phải sửa. **Cần kiểm tra repo gwr trước** (thư mục này không có trong git): dependency của nó, có module native không, và có tự gọi ffmpeg không.

**Mốc kiểm chứng (bắt buộc trước giai đoạn 3):** dựng bản thử thật thô gồm `node.exe` + `server.mjs` + `better-sqlite3` + ffmpeg, chép sang **một máy hoặc VM Windows sạch** (chưa cài Node, chưa cài VS Build Tools). Bản thử phải:

- Khởi động và chạy được migrations trên DB trống.
- Mở được giao diện qua trình duyệt.
- Dựng xong **một bản hoàn chỉnh** từ 2–3 video mẫu, có xoá logo nếu dùng gwr.

Đo dung lượng thư mục, RAM, thời gian khởi động trên bản thử này rồi mới chốt các mục tiêu ở giai đoạn 7 và ước lượng ở mục 6.

### Giai đoạn 3: tối ưu frontend, khoảng 1–2 ngày

1. Chia code theo route bằng `React.lazy` cho 7 page. `FinalPage`, `EdlEditor`, `LedgerPage` và thư viện `diff` chỉ nạp khi mở tới.
2. `vite build`: đặt `target: 'es2022'` (WebView2 luôn là bản mới), không sourcemap, kiểm tra kích thước bundle bằng `rollup-plugin-visualizer`.
3. **Video, chỗ nặng nhất trên máy yếu**:
   - Lưới cảnh (`SceneCard`): đổi `preload="metadata"` thành ảnh poster (thumbnail JPG khoảng 320px tạo bằng ffmpeg khi video vào hệ thống). Chỉ tạo thẻ `<video>` khi người dùng bấm phát.
   - Mỗi lúc chỉ cho một video phát.
   - Route `/files/*` hỗ trợ HTTP Range để tua mà không tải cả file. `@fastify/static` đã hỗ trợ, cần kiểm tra lại.
4. Danh sách dài: dùng `content-visibility: auto`. Giảm hoặc bỏ hiệu ứng `backdrop-blur`, shadow lớn và animation liên tục.
5. React Query:
   - Tăng `staleTime`.
   - Tắt `refetchOnWindowFocus`, vì SSE đã đẩy thay đổi về rồi.

### Giai đoạn 4: vỏ Tauri, khoảng 2 ngày

1. Khởi động:
   1. Kiểm tra mở lần 2 thì chỉ đưa cửa sổ cũ lên trước.
   2. Chọn port trống, ưu tiên 8787.
   3. Spawn sidecar với `--app-dir`, `--data-dir`, `--port`.
   4. Chờ `/api/health` trả về OK, trong lúc đó hiện splash nhẹ (HTML tĩnh).
   5. Điều hướng cửa sổ tới `http://127.0.0.1:<port>`.
2. Lần chạy đầu: hộp thoại chọn thư mục dữ liệu, lưu lựa chọn vào `%APPDATA%\AutoVideo\settings.json`.
3. Dọn tiến trình:
   - Dùng một **Windows Job Object** có cờ `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (crate `windows`: `CreateJobObjectW`, `SetInformationJobObject`, `AssignProcessToJobObject`).
   - **Gán chính process `AutoVideo.exe` vào job ngay đầu `main()`**, trước khi spawn bất cứ thứ gì.
     - Tiến trình con sinh ra sau đó (sidecar node, rồi ffmpeg/ffprobe/gwr của sidecar) tự thuộc job ngay từ lúc tạo, nên không có khoảng hở để một tiến trình con kịp sinh tiến trình cháu nằm ngoài job.
     - Cách này không cần tạo sidecar ở trạng thái suspended (gán vào job rồi mới resume). Plugin shell của Tauri không hỗ trợ cờ suspended, nên làm theo cách đó thì phải tự gọi `CreateProcessW`.
     - Windows 8 trở lên hỗ trợ job lồng nhau, nên vẫn gán được khi app được khởi chạy từ một tiến trình đã nằm trong job khác.
     - Nếu gán thất bại thì ghi log và dựa vào lớp dự phòng stdin bên dưới.
   - Handle của job tạo **không kế thừa** (`lpJobAttributes = NULL`, tức `bInheritHandle = FALSE`) và chỉ `AutoVideo.exe` giữ. Như vậy khi `AutoVideo.exe` chết, không còn handle nào khác giữ job sống.
   - Khi `AutoVideo.exe` thoát vì **bất kỳ lý do gì** (đóng bình thường, crash, bị kill trong Task Manager), Windows đóng handle cuối cùng của job và kill toàn bộ cây. Không cần tìm cây con bằng `ps`/`taskkill`.
   - **Không** bật `JOB_OBJECT_LIMIT_BREAKAWAY_OK`, để tiến trình con không thoát được ra khỏi job.
   - Thoát bình thường:
     - Gọi `POST /api/shutdown` (route mới, chỉ nhận từ localhost) để server huỷ render đang chạy, checkpoint WAL và đóng DB gọn.
     - Quá 3 giây thì đóng job, tức là kill cả cây.
   - Lớp dự phòng phía server: sidecar giữ pipe stdin nối với Tauri. Khi stdin đóng thì tự shutdown, phòng trường hợp gán job thất bại.
4. Menu tối giản: Mở thư mục dữ liệu, Mở thư mục log, Giới thiệu/phiên bản.
5. Cấu hình Tauri:
   - Tắt devtools ở bản release.
   - `withGlobalTauri: false`.
   - Capability chỉ cho phép spawn đúng sidecar và mở thư mục.
6. Sidecar lỗi khi khởi động (port bận, DB khoá, thiếu file): hiện thông báo kèm đường dẫn file log, không để màn hình trắng.

### Giai đoạn 5: công cụ đi kèm và tác vụ nặng, khoảng 1 ngày

1. Kèm **ffmpeg + ffprobe** bản essentials static win64 (khoảng 30MB sau khi nén trong installer). Ghi rõ nguồn và phiên bản trong `THIRD_PARTY.md`, theo giấy phép LGPL/GPL tương ứng.
2. ~~`FINAL_RENDERER`~~: đã bỏ cấu hình này, chỉ còn ffmpeg (mục 9).
3. **(Đã làm)** **Bỏ mọi `spawnSync` trên đường xử lý request và render**. Đây là điều kiện để giao diện vẫn phản hồi khi đang render. Hạ ưu tiên ffmpeg không giải quyết được việc chính event loop của server bị chặn.
   - `probeMedia()` chuyển thành `async` (dùng `spawn`/`execFile`, có `AbortSignal`).
   - Sửa mọi chỗ gọi:
     - `ffmpeg-renderer.ts`: probe các đoạn bằng `Promise.all`, có giới hạn concurrency.
     - `final-cuts.ts`
     - `final-render/index.ts`
     - `watermark.ts`
   - Giới hạn chung tối đa 2 ffprobe chạy cùng lúc (hàng đợi nhỏ trong `media.ts`). Timeout 20 giây giữ nguyên.
   - Huỷ render hoặc shutdown thì abort luôn các probe đang chờ hoặc đang chạy.
   - `resolveBinary`: chạy một lần lúc khởi động, sau khi đã mở port (bất đồng bộ), rồi cache. Không gọi đồng bộ lần đầu bên trong request.
   - `legacy-import.ts` chỉ chạy từ CLI nên có thể giữ `spawnSync`.
   - Thêm test: trong lúc probe giả bị treo, `/api/health` vẫn trả lời dưới 200ms.
4. Render bản cuối và xoá logo:
   - Hạ ưu tiên tiến trình con xuống `BELOW_NORMAL` (`os.setPriority`) để máy không bị đơ.
   - Giới hạn `-threads` bằng `max(1, số nhân - 1)`.
   - Dùng preset nhanh (`veryfast`) và cho chọn chất lượng trong cài đặt.
   - Chỉ cho một lượt render chạy cùng lúc, lượt sau xếp hàng.
5. Sao lưu DB, tách thành hai loại. Phần "trước migration" **đã làm**. Phần định kỳ 1 lần/ngày **chưa làm**, hiện vẫn sao lưu mỗi lần khởi động.
   - **Sao lưu trước migration (bắt buộc, phải xong rồi mới migrate)**:
     - Trong `buildApp()`, sau `openDb` và **trước** `runMigrations`, kiểm tra có migration nào đang chờ không.
     - Nếu có và DB không rỗng: `await db.backup('data/backup/app-pre-<version>-<timestamp>.db')`, rồi mới gọi `runMigrations`. `db.backup()` của better-sqlite3 là bất đồng bộ (chép từng phần), nên ở đây chỉ **chờ** nó xong trước khi migrate, **không** chặn event loop. Lúc này server chưa mở port nên chờ cũng không ảnh hưởng request.
     - Sao lưu thất bại thì **không migrate** và báo lỗi (hiện trên cửa sổ của Tauri).
     - Bản này không tính vào giới hạn xoay vòng, giữ ít nhất 3 bản gần nhất.
   - **Sao lưu định kỳ (được hoãn)**: tối đa 1 lần/ngày, giữ 7 bản. Chạy sau khi cửa sổ đã hiện, không chặn khởi động. Thay cho lần sao lưu mỗi lần khởi động hiện nay ở `index.ts`.
6. SQLite: giữ WAL. Thêm `PRAGMA cache_size=-8000` (khoảng 8MB) và `temp_store=MEMORY`. Chạy `wal_checkpoint(TRUNCATE)` khi thoát.

### Giai đoạn 6: installer, khoảng 1 ngày

1. Installer NSIS của Tauri, cài theo user, không cần admin. Tạo shortcut ở Desktop và Start Menu.
2. WebView2: dùng chế độ `downloadBootstrapper` (chỉ tải khi máy chưa có, Win11 luôn có sẵn). Nếu máy không có internet thì dùng `offlineInstaller` (thêm khoảng 130MB). **Cần chọn một trong hai.**
3. Gỡ cài đặt **không xoá** thư mục dữ liệu, có hỏi người dùng trước.
4. Cập nhật: chạy installer bản mới đè lên bản cũ. Lần khởi động đầu tiên, server sao lưu DB trước khi chạy migration (giai đoạn 5, bước 5).
5. Ký số:
   - Không bắt buộc với dùng cá nhân.
   - Nếu không ký, SmartScreen sẽ cảnh báo lần đầu và một số antivirus có thể chặn exe chưa ký. Cần ghi hướng dẫn "More info → Run anyway" trong README.

### Giai đoạn 7: kiểm thử trên cấu hình yếu, khoảng 1–2 ngày

Tạo VM: 2 nhân, 4GB RAM, ổ HDD (hoặc giới hạn IOPS), Win10 22H2 x64 sạch. **Đây là cấu hình kiểm thử giả định**, chưa phải cấu hình máy đích thật (xem câu hỏi mở ở mục 8). Có thông tin thật thì chỉnh lại VM cho khớp.

| Chỉ số | Mục tiêu |
|---|---|
| Kích thước installer | Khoảng 100MB. Đo được: thư mục 274MB, zip khoảng 101MB, trong đó ffmpeg + ffprobe chiếm 188MB. Không tối ưu thêm theo quyết định của người dùng |
| Khởi động lạnh đến khi thấy giao diện | < 5 giây |
| RAM toàn app lúc rảnh (Tauri + WebView2 + sidecar) | < 250MB |
| CPU lúc rảnh | ≈ 0% (không có polling) |
| Dự án 50 cảnh | Cuộn mượt, không tự tải video |
| Đang render bản cuối | Giao diện vẫn phản hồi < 200ms |
| Tắt app | Không còn tiến trình `node`/`ffmpeg` nào của app |
| Kill `AutoVideo.exe` trong Task Manager khi đang render | Trong vòng 2 giây không còn tiến trình `node`/`ffmpeg` nào của app (kể cả tiến trình cháu như ffmpeg do gwr gọi) |

Các mục tiêu trong bảng sẽ được chỉnh lại theo số đo của bản thử ở mốc kiểm chứng (giai đoạn 2).

Kịch bản kiểm thử:

1. Cài mới.
2. Chọn thư mục dữ liệu.
3. Tạo dự án.
4. Nhập ảnh/video (theo lựa chọn ở mục 2).
5. Dựng bản cuối và xoá logo.
6. Tắt rồi mở lại, dữ liệu còn nguyên.
7. Kill app khi đang render, mở lại: không còn tiến trình mồ côi, bản dựng dở được đánh dấu lỗi hoặc huỷ, dựng lại được.
8. Cài bản mới có migration đè lên: có file `app-pre-<version>-*.db`, mở được bằng bản cũ, migration chạy đúng.
9. Gỡ cài đặt, thư mục dữ liệu vẫn còn.

## 6. Thứ tự và công sức

| Giai đoạn | Công sức | Phụ thuộc |
|---|---|---|
| 0. Tương thích Windows | khoảng 1 ngày | — |
| 1. Tách thư mục cài/dữ liệu | khoảng 1 ngày | 0 |
| 2. Build server (esbuild + node.exe) + **mốc kiểm chứng trên Windows sạch** | 2–3 ngày | 1 |
| 3. Tối ưu frontend | 1–2 ngày | sau mốc kiểm chứng |
| 4. Vỏ Tauri (gồm Job Object) | 2–3 ngày | mốc kiểm chứng |
| 5. Công cụ đi kèm, probe bất đồng bộ, sao lưu trước migration | 2 ngày | 2 |
| 6. Installer | khoảng 1 ngày | 4, 5 |
| 7. Kiểm thử máy yếu | 1–2 ngày | 6 |
| (Lựa chọn B) Nhập thủ công cảnh/video | 3–4 ngày | 1, làm song song được |
| (Lựa chọn C) Importer tổng quát + giao diện ánh xạ | khoảng 3 ngày | 1, làm song song được |

Tổng tạm tính: khoảng **12–16 ngày** công, cộng thêm phần của lựa chọn B hoặc C. **Con số này là giả thuyết**, chỉ chốt lại sau mốc kiểm chứng.

## 7. Môi trường build (chỉ máy dev, máy người dùng không cần)

- Node 22 LTS (trùng ABI với `better_sqlite3.node` được đóng gói).
- Rust stable + Visual Studio Build Tools (MSVC), dùng cho Tauri.
- `npm run build:win` chạy lần lượt:
  1. Build web.
  2. esbuild server.
  3. Chép `better-sqlite3` + dependency từ `node_modules` (khớp `package-lock.json`), cắt gọn, nạp thử addon bằng `node.exe` đóng gói.
  4. Chép `node.exe`, `server.mjs`, `node_modules` đã cắt, ffmpeg, gwr vào thư mục resources của Tauri.
  5. `tauri build`.
- Cấu trúc repo thêm:
  - `src-tauri/` (vỏ app)
  - `scripts/build-win.mjs`
  - `server/build/` (đầu ra, có trong `.gitignore`)

## 8. Câu hỏi mở

Không cần trả lời hết mới bắt đầu. Bản thử ở giai đoạn 0–2 (mốc kiểm chứng cách đóng gói) không phụ thuộc vào các câu hỏi này. Chỉ cần chốt câu 1 trước khi bắt đầu phần tính năng, và câu 2–4 trước giai đoạn 5–7.

1. Chọn A, B hay C ở mục 2?
2. Máy đích là Win10 hay Win11, 64-bit? Bao nhiêu RAM, ổ HDD hay SSD? Nếu có máy Win7/8 hoặc 32-bit thì WebView2 không dùng được.
3. Có cần xoá logo (gwr) trên máy đích không? Shotcut đã bỏ. Thư mục `gemini-watermark-remover/` không có trên máy dev, nên chưa kiểm chứng được gwr trên Windows.
4. Máy đích có internet lúc cài không? (Quyết định cách đóng gói WebView2.)

## 9. Kết quả triển khai (cập nhật 29/10/2026)

### Đã làm

- **Giai đoạn 0–2**:
  - Server chạy được trên Windows.
  - Tách `APP_DIR` và `DATA_DIR`, nhận tham số `--app-dir`, `--data-dir`, `--port`.
  - Migrations nhúng trong bundle. `server.mjs` build bằng esbuild (ESM, có banner `createRequire`).
  - `npm run build:win` tạo `dist-win/` gồm `node.exe`, `server/`, `web/`, `bin/ffmpeg.exe`, `bin/ffprobe.exe`, `start.cmd`, `BUILD-INFO.json`.
  - Log production ở mức `warn`, ghi vào `<DATA_DIR>/logs/server.log` và tự xoay vòng.
- **ffmpeg ghim cứng**:
  - Bản gyan.dev essentials 8.0, có libx264, libass và các filter `subtitles`/`ass`/`drawtext`.
  - URL: `https://github.com/GyanD/codexffmpeg/releases/download/8.0/ffmpeg-8.0-essentials_build.zip`.
  - SHA256: `647e467caf82b9fa200a562769b5ff4d736aaf725804ed2c64ea9752106fa569`. Hash này lấy ở lần tải đầu, vì trang phát hành không công bố hash.
- **Sao lưu trước migration**: nếu có migration đang chờ và DB không rỗng thì `await db.backup()` ra `data/backup/app-pre-<version>-<ts>.db` rồi mới migrate. Sao lưu lỗi thì không migrate.
- **Bỏ Shotcut hoàn toàn**:
  - Đã xoá renderer Shotcut, client MCP (Python), bước kiểm tra `--check`, nút và API "Mở trong Shotcut".
  - Đã xoá cấu hình `FINAL_RENDERER` và `SHOTCUT_MCP_*`. Nếu `config.env` cũ còn các khoá này thì chúng bị bỏ qua.
  - `/api/meta.final_renderer` giờ là `{ active: 'ffmpeg'|null, reason, ffmpeg }`.
  - Không sinh file `.mlt` nữa.
- **Dữ liệu cũ của Shotcut**: không xoá cột nào.
  - Bản dựng cũ có `renderer='shotcut'` vẫn liệt kê, xem và tải được. Hai trường `project_file_path` và `render_ref` được giữ làm trường lịch sử; giao diện ghi "Shotcut (bản cũ)".
  - "Render lại" một bản cũ thì dựng bằng ffmpeg.
  - File `.mlt` cũ không bị đụng tới, và số phiên bản mới không đè lên nó.
- **ffprobe bất đồng bộ**:
  - `probeMedia`, `ffmpegOf`, `ffprobeOf` đều async.
  - Tối đa 2 ffprobe chạy cùng lúc. Timeout 20 s, hết giờ thì kill tiến trình.
  - Hủy được bằng `AbortSignal`, kể cả khi đang xếp hàng.
  - Các hàm đồng bộ chạy trong transaction (`final-cuts.ts`) đọc cache do route async làm nóng trước. Kết quả rỗng (ví dụ hết giờ khi máy bận) **không** được nhớ.
  - Binary được dò sẵn ngay sau `listen`.
- **Build script**:
  - Chép dependency từ `node_modules` theo lockfile, ghi hash của addon và `node.exe`.
  - Không dùng `fs.cpSync`, vì trên Windows Node 22.20 làm hỏng tên có dấu (`Dữ liệu` thành `Dá»¯ liá»‡u`).

### Đã kiểm chứng (chạy thật trên máy dev Windows 11)

| Hạng mục | Kết quả |
|---|---|
| `npm test` | 226 đạt, 0 lỗi, 3 bỏ qua (2 test symlink cần Developer Mode, 1 test tích hợp gwr thật) |
| `npm run typecheck` (server + web) | Đạt |
| Build 2 lần liên tiếp | 33 file, SHA256 giống hệt |
| Chạy bản đóng gói ngoài repo, PATH chỉ có `System32` | Khởi động được, có giao diện, dùng đúng ffmpeg trong `bin/` |
| Thư mục cài và dữ liệu có khoảng trắng và dấu tiếng Việt (`Thử nghiệm app\AutoVideo bản thử`, `Dữ liệu thử\Dự án`) | Chạy đúng |
| Dựng bản cuối từ 4 clip 1080×1920, mỗi clip 10 s, có tiếng | Ra video 38 s, h264 1080×1920 có tiếng, thời lượng khớp tổng các đoạn EDL. Dựng mất 14,3 s, có contact sheet |
| Hủy khi đang render | Trạng thái `cancelled`; sau 2 s không còn ffmpeg nào của app, không còn file dở |
| Bản dựng Shotcut cũ (chèn vào DB như dữ liệu của phiên bản trước) | Liệt kê đủ trường, video tải được (Range trả 206). "Render lại" ra bản ffmpeg mới, file `.mlt` cũ còn nguyên |
| Nâng cấp DB (đang dừng ở migration 003) | Có file `app-pre-004_watermark-*.db` mang schema 003, DB chính lên 004 |
| ffprobe treo không chặn API | Test tự động: HTTP và timer vẫn trả lời dưới 200 ms |
| RAM của node | Lúc rảnh khoảng 57–68 MB; đỉnh khi render 1080p khoảng 72 MB (ffmpeg là tiến trình riêng) |
| Thời gian khởi động đến `/api/health` | Khoảng 0,4 s nếu đã từng chạy. Lần đầu sau khi chép file mất 2,5–4 s, khả năng do Defender quét exe mới |

### Chưa làm / chưa kiểm chứng

- Chưa thử trên máy Windows sạch thật. Máy dev có sẵn VC++ runtime.
- gwr (xoá logo): thư mục tool không có trên máy. Mới chỉ xác nhận app báo tắt chức năng này và vẫn dựng bình thường.
- Giai đoạn 3 (frontend), 4 (Tauri, Job Object, `/api/shutdown`), 6 (installer), 7 (VM cấu hình yếu).
- Sao lưu định kỳ 1 lần/ngày, hạ ưu tiên tiến trình ffmpeg.
- `start.cmd` chỉ là lối chạy tạm trước khi có Tauri:
  - Bấm đúp từ Explorer thì chạy bình thường.
  - Gọi từ chương trình khác thì phải dùng `cmd /d /s /c ""<start.cmd>" "<thư mục dữ liệu>" <cổng>"`.

### Phụ đề

Yêu cầu "điều chỉnh vị trí phụ đề đã có trong chức năng ghép video ngắn thành video dài" **chưa làm**, vì không tìm thấy phụ đề trong luồng đó:

- **Trên `main`:**
  - Trường `caption` của mỗi đoạn dựng chỉ là nhãn clip `"C3 v2 #1"`, truyền cho Shotcut MCP làm tên clip.
  - ffmpeg không ghi chữ lên hình.
  - `server/src`, `web/src` và migrations không có ASS/SRT/subtitle nào.
- **Trên nhánh `origin/feat/multi-provider-account-pool` (846e3be):** có phụ đề, nhưng thuộc chức năng **cắt video dài thành clip ngắn**. Chức năng đó nhận dạng giọng nói qua dịch vụ STT, sinh ASS rồi cháy vào hình bằng libass, và đi kèm phần LAN và worker tự động nằm ngoài phạm vi.
- Cần người dùng chọn hướng trước khi làm. ffmpeg đóng gói đã có `subtitles`/`ass`, nên không có cản trở kỹ thuật.
