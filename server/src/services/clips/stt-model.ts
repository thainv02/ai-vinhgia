/**
 * Model nhận dạng lời nói chạy trên máy: gipformer 1.5 (Zipformer transducer tiếng Việt, 68M tham số, bản INT8, MIT) + VAD silero (MIT).
 * Đóng sẵn trong bản cài: scripts/build-installer.mjs tải lúc build, bộ cài chép vào `%LOCALAPPDATA%\vn.syntra.autovideo\models`; app tải bù trong Cài đặt nếu thiếu.
 * File ghim theo commit của repo HuggingFace và SHA256; tải vào `.part` rồi mới đổi tên, sai hash thì bỏ. Đủ file + đúng hash → ghi `model.json`.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const HF = 'https://huggingface.co/g-group-ai-lab/gipformer1.5-68M-rnnt/resolve/dd9227dcd8705c13f33bdbe59728d546ab94480f';

export const STT_MODEL = {
  id: 'gipformer1.5-68M-rnnt-int8',
  label: 'gipformer 1.5 (68M, INT8)',
  files: [
    { name: 'encoder.int8.onnx', url: `${HF}/encoder.int8.onnx`, bytes: 70_876_359, sha256: 'b528768939c7711a889be81a718ea7f2ee50d0d2d384d53f399e15b44bd9408c' },
    { name: 'decoder.int8.onnx', url: `${HF}/decoder.int8.onnx`, bytes: 1_308_690, sha256: 'e0a156b5454722a524230f9e35d5d928cfcdd3723437b418e5bd5e04f1c3a101' },
    { name: 'joiner.int8.onnx', url: `${HF}/joiner.int8.onnx`, bytes: 1_033_417, sha256: '12636559d135315f002a1e1b477077d415e888477378db0fd450aee5b21ac551' },
    { name: 'tokens.txt', url: `${HF}/tokens.txt`, bytes: 25_847, sha256: 'f536d03c2e95ebd2930cf0abec88e823bd17d3c1933da7ae6a82db3b80605e15' },
    {
      name: 'silero_vad.onnx',
      url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
      bytes: 643_854,
      sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
    },
  ],
} as const;

export const STT_MODEL_BYTES = STT_MODEL.files.reduce((n, f) => n + f.bytes, 0);
const MANIFEST = 'model.json';

export const sttModelDir = (modelsDir: string): string => path.join(modelsDir, STT_MODEL.id);

export interface SttModelStatus {
  installed: boolean;
  dir: string;
  /** File còn thiếu hoặc sai kích thước. */
  missing: string[];
  total_bytes: number;
}

/** Đã cài đủ chưa: có `model.json` (ghi sau khi kiểm hash) và mọi file đúng kích thước. Không băm lại (nhanh, gọi được ở mỗi request). */
export function sttModelStatus(modelsDir: string): SttModelStatus {
  const dir = sttModelDir(modelsDir);
  const missing = STT_MODEL.files.filter((f) => fileSize(path.join(dir, f.name)) !== f.bytes).map((f) => f.name);
  const installed = missing.length === 0 && fs.existsSync(path.join(dir, MANIFEST));
  return { installed, dir, missing, total_bytes: STT_MODEL_BYTES };
}

function fileSize(p: string): number | null {
  try {
    return fs.statSync(p).size;
  } catch {
    return null;
  }
}

export interface DownloadProgress {
  /** Byte đã có (gồm cả file đã tải đủ từ trước). */
  received: number;
  total: number;
  file: string;
}

export class SttModelDownloadError extends Error {}

interface DownloadOptions {
  signal?: AbortSignal;
  onProgress?: (p: DownloadProgress) => void;
  onRetry?: (p: { file: string; attempt: number; waitMs: number }) => void;
  fetchImpl?: typeof fetch;
}

// Retry only transient HTTP failures. Never retry sooner than the server requests;
// a longer cooldown is reported to the user instead of blocking setup indefinitely.
async function fetchModelFile(f: typeof STT_MODEL.files[number], opts: DownloadOptions): Promise<Response> {
  const maxAttempts = 4;
  for (let attempt = 1; ; attempt++) {
    opts.signal?.throwIfAborted();
    let res: Response;
    // HF_TOKEN (token đọc của HuggingFace) nâng giới hạn lượt tải so với tải ẩn danh; dùng khi build bộ cài bị HTTP 429.
    const token = process.env.HF_TOKEN?.trim();
    const headers = token && new URL(f.url).hostname === 'huggingface.co' ? { authorization: `Bearer ${token}` } : undefined;
    try {
      res = await (opts.fetchImpl ?? fetch)(f.url, { signal: opts.signal, redirect: 'follow', headers });
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      throw new SttModelDownloadError(`Không kết nối được để tải ${f.name} (${e instanceof Error ? e.message : String(e)})`);
    }
    if (res.ok && res.body) return res;
    await res.body?.cancel();
    const retryable = [429, 500, 502, 503, 504].includes(res.status);
    const retryAfter = res.headers.get('retry-after');
    const seconds = retryAfter !== null && /^\d+(?:\.\d+)?$/.test(retryAfter.trim()) ? Number(retryAfter) : NaN;
    const serverWait = Number.isFinite(seconds) ? seconds * 1000 : retryAfter ? Date.parse(retryAfter) - Date.now() : 0;
    // Hugging Face also communicates its reset window as RateLimit: "resolvers";r=0;t=55.
    const resetSeconds = res.status === 429
      ? [...(res.headers.get('ratelimit') ?? '').matchAll(/(?:^|;)\s*t\s*=\s*(\d+)/g)].map((m) => Number(m[1]))
      : [];
    const waitMs = Math.max(5_000 * 2 ** (attempt - 1), Number.isFinite(serverWait) ? serverWait : 0, ...resetSeconds.map((s) => s * 1000));
    if (!retryable || attempt >= maxAttempts || waitMs > 300_000) {
      const hint = res.status === 429
        ? ' Máy chủ đang giới hạn lượt tải. Hãy chờ vài phút rồi thử lại trong Cài đặt > Nhận dạng lời nói; không cần cài lại app.'
        : '';
      throw new SttModelDownloadError(`Tải ${f.name} thất bại: HTTP ${res.status}.${hint}`);
    }
    opts.onRetry?.({ file: f.name, attempt, waitMs });
    await delay(waitMs, undefined, { signal: opts.signal });
  }
}

/**
 * Tải các file còn thiếu (tuần tự), kiểm SHA256 từng file rồi ghi `model.json`. Hủy bằng `signal` (file `.part` bị xoá).
 * File đã có đúng kích thước được băm lại một lần để chắc không hỏng; sai thì tải lại.
 */
export async function downloadSttModel(
  modelsDir: string,
  opts: DownloadOptions = {},
): Promise<SttModelStatus> {
  const dir = sttModelDir(modelsDir);
  fs.mkdirSync(dir, { recursive: true });
  let received = 0;
  for (const f of STT_MODEL.files) {
    const dest = path.join(dir, f.name);
    if (fileSize(dest) === f.bytes && (await sha256File(dest)) === f.sha256) {
      received += f.bytes;
      opts.onProgress?.({ received, total: STT_MODEL_BYTES, file: f.name });
      continue;
    }
    const part = `${dest}.part`;
    fs.rmSync(part, { force: true });
    const res = await fetchModelFile(f, opts);
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(part);
    let got = 0;
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        hash.update(chunk);
        got += chunk.length;
        if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
        opts.onProgress?.({ received: received + got, total: STT_MODEL_BYTES, file: f.name });
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    } catch (e) {
      out.destroy();
      fs.rmSync(part, { force: true });
      if (opts.signal?.aborted) throw e;
      throw new SttModelDownloadError(`Mất kết nối khi tải ${f.name} (${e instanceof Error ? e.message : String(e)})`);
    }
    const digest = hash.digest('hex');
    if (got !== f.bytes || digest !== f.sha256) {
      fs.rmSync(part, { force: true });
      throw new SttModelDownloadError(`File ${f.name} tải về không đúng (kích thước ${got}/${f.bytes} byte hoặc sai SHA256)`);
    }
    fs.renameSync(part, dest);
    received += f.bytes;
  }
  fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify({ id: STT_MODEL.id, files: STT_MODEL.files.map(({ name, sha256 }) => ({ name, sha256 })) }, null, 2));
  return sttModelStatus(modelsDir);
}

function sha256File(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}
