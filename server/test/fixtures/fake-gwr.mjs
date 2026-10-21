// Tool xoá logo Veo GIẢ (CLI giống gemini-watermark-remover/bin/gwr.mjs) dùng cho test.
//   node fake-gwr.mjs --help
//   node fake-gwr.mjs remove <input> --output <out> --json [--video-bitrate-mbps N] [--video-timeout-ms MS]
// Điều khiển bằng biến môi trường:
//   FAKE_GWR_LOG        file ghi lại mỗi lần chạy (JSON một dòng: argv, cwd)
//   FAKE_GWR_MODE       ok | fail | hang | short | noaudio | missing | empty
//   FAKE_GWR_HELP       ok | fail  (kết quả của --help)
//   FAKE_GWR_CHILD_PID  file ghi pid tiến trình con "chromium giả" (chế độ hang)
//   FAKE_GWR_FFMPEG     đường dẫn ffmpeg (cho short/noaudio)
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const log = process.env.FAKE_GWR_LOG;
if (log) fs.appendFileSync(log, JSON.stringify({ argv, cwd: process.cwd(), pid: process.pid }) + '\n');

if (argv.includes('--help')) {
  if (process.env.FAKE_GWR_HELP === 'fail') {
    console.error('boom: không chạy được');
    process.exit(2);
  }
  console.log('Usage: gwr remove <input> [--output <file>] [--json]');
  process.exit(0);
}

const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const input = argv[1];
const output = arg('--output');
const mode = process.env.FAKE_GWR_MODE || 'ok';
const ffmpeg = process.env.FAKE_GWR_FFMPEG || 'ffmpeg';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const progress = (pct, n, total) => process.stderr.write(`[video] ${pct}% ${n}/${total} frames (AI ${Math.floor(n / 2)}, reused ${n - Math.floor(n / 2)})\n`);

if (mode === 'fail') {
  process.stderr.write('[video] 10% 24/240 frames (AI 12, reused 12)\n');
  console.error('Error: Chromium launch failed\nsecond line of the error');
  process.exit(1);
}

if (mode === 'hang') {
  progress(10, 24, 240);
  // "Chromium" giả: tiến trình con cháu để kiểm tra dừng cả cây
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  if (process.env.FAKE_GWR_CHILD_PID) fs.writeFileSync(process.env.FAKE_GWR_CHILD_PID, String(child.pid));
  setInterval(() => {}, 1000); // treo mãi, bỏ qua timeout của chính tool
} else {
  for (const [p, n] of [[25, 60], [50, 120], [74, 178], [100, 240]]) {
    progress(p, n, 240);
    await sleep(20);
  }
  if (mode === 'missing') {
    console.log(JSON.stringify({ input, output, kind: 'video', meta: { status: 'ok' } }));
  } else if (mode === 'empty') {
    fs.writeFileSync(output, '');
    console.log(JSON.stringify({ input, output, kind: 'video', meta: { status: 'ok' } }));
  } else {
    if (mode === 'short') spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', input, '-t', '1', '-c', 'copy', output]);
    else if (mode === 'noaudio') spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', input, '-an', '-c:v', 'copy', output]);
    else fs.copyFileSync(input, output);
    console.log(
      JSON.stringify({
        input,
        output,
        kind: 'video',
        meta: { status: 'processed', denoiseBackend: 'fake', actualControls: { videoBitrateMbps: Number(arg('--video-bitrate-mbps') || 12) }, pagePath: '/fake' },
      }),
    );
  }
}
