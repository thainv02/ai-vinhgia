import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Cổng đọc từ biến môi trường để chạy thử song song với bản đang dùng thật: WEB_PORT (mặc định 5173), API_PORT (mặc định 8787).
// Nếu đổi WEB_PORT thì server API cần EXTRA_ALLOWED_ORIGINS chứa http://localhost:<WEB_PORT> (kiểm tra Origin của request ghi).
const WEB_PORT = Number(process.env.WEB_PORT ?? 5173);
const API_PORT = Number(process.env.API_PORT ?? 8787);
const API = `http://127.0.0.1:${API_PORT}`;
// Trang planner LAN (planner.html) gọi listener LAN riêng của server (cổng LAN_PORT, mặc định 8790), không phải API chính.
const LAN_PORT = Number(process.env.LAN_PORT ?? 8790);
const LAN = `http://127.0.0.1:${LAN_PORT}`;

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: WEB_PORT,
    // Server API chỉ chấp nhận một số Origin cố định nên không được tự đổi sang cổng khác.
    strictPort: true,
    proxy: {
      // SSE (/api/stream) đi qua proxy này: đánh dấu không đệm và không nén để sự kiện tới trình duyệt ngay.
      '/api': {
        target: API,
        changeOrigin: false,
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (String(proxyRes.headers['content-type'] ?? '').includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache, no-transform';
              proxyRes.headers['x-accel-buffering'] = 'no';
              delete proxyRes.headers['content-length'];
            }
          });
        },
      },
      '/files': { target: API, changeOrigin: false },
      // Dev trang planner (http://localhost:<WEB_PORT>/planner.html): API và ảnh của planner nằm ở listener LAN.
      '/lan': { target: LAN, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Hai trang: app quản trị (index.html) và trang planner nhẹ cho LAN (planner.html, entry src/planner/main.tsx).
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        planner: fileURLToPath(new URL('./planner.html', import.meta.url)),
      },
    },
  },
});
