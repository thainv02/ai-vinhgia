#!/usr/bin/env node
/**
 * Xoá logo Veo trên video cho app: chỉ dùng phần video của @pilio/gemini-watermark-remover (API công khai `/video`).
 * Tương thích dòng lệnh mà server gọi (`services/final-render/watermark.ts`):
 *   gwr.mjs --help                 → in cách dùng; mã 0 nếu máy có trình duyệt Edge/Chrome, mã 4 nếu không
 *   gwr.mjs remove <video> --output <file> [--json] [--overwrite] [--video-bitrate-mbps N] [--video-timeout-ms MS]
 * stdout (`--json`): `{input, output, kind:"video", meta}`; stderr: tiến độ `[video] 74% 169/240 frames (AI 150, reused 19)`.
 */
import { register } from 'node:module';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NO_BROWSER, findBrowser } from './browser.mjs';

const USAGE = 'Usage: gwr remove <video> --output <file> [--json] [--overwrite] [--video-timeout-ms <ms>] [--video-bitrate-mbps <Mbps>]';
const VIDEO_EXT = /\.(mp4|mov|m4v|webm)$/i;

function parseArgs(argv) {
  const o = { input: null, output: null, json: false, overwrite: false, timeoutMs: null, bitrateMbps: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Thiếu giá trị cho ${t}`);
      return v;
    };
    if (t === '--output') o.output = value();
    else if (t === '--json') o.json = true;
    else if (t === '--overwrite') o.overwrite = true;
    else if (t === '--video-timeout-ms') o.timeoutMs = Number(value());
    else if (t === '--video-bitrate-mbps') o.bitrateMbps = Number(value());
    else if (t.startsWith('--')) throw new Error(`Tham số không hỗ trợ: ${t}`);
    else if (o.input === null) o.input = t;
    else throw new Error(`Thừa tham số: ${t}`);
  }
  if (!o.input || !o.output) throw new Error(USAGE);
  if (!VIDEO_EXT.test(o.input)) throw new Error('Chỉ hỗ trợ video (.mp4, .mov, .m4v, .webm)');
  for (const [k, v] of [['--video-timeout-ms', o.timeoutMs], ['--video-bitrate-mbps', o.bitrateMbps]]) {
    if (v !== null && !(Number.isFinite(v) && v > 0)) throw new Error(`${k} phải là số dương`);
  }
  return o;
}

/** Như CLI gốc: in khi đổi giai đoạn hoặc tăng ≥ 5%. */
function progressReporter(stderr) {
  let lastPercent = -1;
  let lastPhase = null;
  return (p = {}) => {
    const percent = Number.isFinite(p.progress) ? Math.max(0, Math.min(100, Math.round(p.progress * 100))) : null;
    const phaseChanged = p.phase && p.phase !== lastPhase;
    const percentChanged = percent !== null && (percent === 100 || percent >= lastPercent + 5);
    if (!phaseChanged && !percentChanged) return;
    const frames = Number.isFinite(p.processedFrames) ? ` ${p.processedFrames}${Number.isFinite(p.frameEstimate) ? `/${p.frameEstimate}` : ''} frames` : '';
    const ai = Number.isFinite(p.aiDenoiseFrames) || Number.isFinite(p.aiReuseFrames) ? ` (AI ${p.aiDenoiseFrames || 0}, reused ${p.aiReuseFrames || 0})` : '';
    stderr.write(`[video] ${percent ?? '?'}%${frames}${ai}\n`);
    if (percent !== null) lastPercent = percent;
    lastPhase = p.phase || lastPhase;
  };
}

async function main(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(`${USAGE}\n`);
    const browser = findBrowser();
    if (!browser) {
      process.stderr.write(`${NO_BROWSER}\n`);
      return 4;
    }
    return 0;
  }
  if (argv[0] !== 'remove') {
    process.stderr.write(`Lệnh không hỗ trợ: ${argv[0]}\n${USAGE}\n`);
    return 2;
  }
  let o;
  try {
    o = parseArgs(argv.slice(1));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
  const input = path.resolve(o.input);
  const output = path.resolve(o.output);
  if (!(await stat(input).catch(() => null))?.isFile()) {
    process.stderr.write(`Input not found: ${o.input}\n`);
    return 3;
  }
  if ((await stat(output).catch(() => null)) && !o.overwrite) {
    process.stderr.write(`Output already exists: ${output}. Use --overwrite to replace it.\n`);
    return 2;
  }
  await mkdir(path.dirname(output), { recursive: true });

  register('./hooks.mjs', import.meta.url);
  const { removeVideoWatermarkFromFile, inferVideoMimeTypeFromPath } = await import('@pilio/gemini-watermark-remover/video');
  const result = await removeVideoWatermarkFromFile(input, {
    outputPath: output,
    mimeType: inferVideoMimeTypeFromPath(output),
    ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
    ...(o.bitrateMbps ? { videoBitrate: o.bitrateMbps * 1_000_000 } : {}),
    onProgress: progressReporter(process.stderr),
  });
  const out = { input: o.input, output, kind: 'video', meta: result.meta };
  process.stdout.write(o.json ? `${JSON.stringify(out)}\n` : `${output}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}

export { main, parseArgs };
