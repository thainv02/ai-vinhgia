import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev giao diện (npm run dev, mở http://localhost:<WEB_PORT>/planner.html): Vite proxy /lan tới listener giao diện của server
// (cổng LAN_PORT, mặc định 8790). Bản cài không dùng Vite: server phục vụ thẳng web/dist.
const WEB_PORT = Number(process.env.WEB_PORT ?? 5173);
const LAN_PORT = Number(process.env.LAN_PORT ?? 8790);
const LAN = `http://127.0.0.1:${LAN_PORT}`;

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: WEB_PORT,
    strictPort: true,
    proxy: {
      '/lan': { target: LAN, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Một trang duy nhất: giao diện planner (planner.html, entry src/planner/main.tsx) của app desktop.
    rollupOptions: {
      input: {
        planner: fileURLToPath(new URL('./planner.html', import.meta.url)),
      },
    },
  },
});
