/** Fixture Video HTML 2 giây ở canvas gốc 360x640 (9:16) cho test engine. */
import fs from 'node:fs';
import path from 'node:path';
import { PNG_BYTES } from './helpers.js';

export const FIXTURE_INDEX = `<!doctype html>
<html lang="vi">
  <head>
    <meta charset="UTF-8" />
    <title>Fixture 2s</title>
    <script src="__hf/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 360px; height: 640px; overflow: hidden; background: #101020; font-family: "Be Vietnam Pro", sans-serif; }
      #root { position: relative; width: 360px; height: 640px; overflow: hidden; background: linear-gradient(160deg, #1b1b3a, #3a1b5c); }
      #title { position: absolute; left: 20px; right: 20px; top: 60px; color: #fff; font-size: 32px; font-weight: 700; line-height: 1.2; text-align: center; }
      #sub { position: absolute; left: 20px; right: 20px; top: 180px; color: #ffd36b; font-size: 17px; font-weight: 400; text-align: center; }
      #logo { position: absolute; left: 130px; top: 235px; width: 100px; height: 100px; background: #ff5a3c; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="2" data-width="360" data-height="640">
      <h1 id="title" class="clip" data-start="0" data-duration="2">Ưu đãi đặc biệt – Giảm 30%</h1>
      <p id="sub" class="clip" data-start="0.2" data-duration="1.8">Ăn ngon, ngủ khỏe: ơ, ế, ữ, ỵ, ẳ, ồ, ũ, đ</p>
      <img id="logo" class="clip" data-start="0.3" data-duration="1.7" src="assets/u/1.png" alt="logo" />
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      tl.from("#title", { y: -40, opacity: 0, duration: 0.5, ease: "power3.out" }, 0);
      tl.from("#sub", { opacity: 0, y: 15, duration: 0.4 }, 0.2);
      tl.from("#logo", { scale: 0, duration: 0.5, ease: "back.out(1.7)" }, 0.3);
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;

export function writeFixture(dir: string): void {
  fs.mkdirSync(path.join(dir, 'assets', 'u'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), FIXTURE_INDEX);
  fs.writeFileSync(path.join(dir, 'assets', 'u', '1.png'), PNG_BYTES);
}

