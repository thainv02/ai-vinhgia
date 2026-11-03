/**
 * Nhận dạng lời nói trên máy: chạy stt-runner làm tiến trình con (bản build `<APP_DIR>/server/stt-runner.mjs`, dev: mã nguồn qua tsx),
 * đọc tiến độ/kết quả theo dòng JSON. Hủy → kill tiến trình (cả ffmpeg con của nó: dùng killTree).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_DIR } from '../../config.js';
import { killTree } from '../final-render/watermark.js';
import { SttCancelled, SttError, type SttOutcome, type SttVerbose } from './stt-client.js';
import { STT_MODEL, STT_MODEL_BYTES, sttModelStatus } from './stt-model.js';

export const STT_MODEL_MISSING = `Chưa có model nhận dạng lời nói trên máy này. Vào Cài đặt → Nhận dạng lời nói để tải (khoảng ${Math.round(STT_MODEL_BYTES / 1e6)} MB).`;

/** Lệnh chạy runner: bản build có `server/stt-runner.mjs` cạnh app; repo dev chạy mã nguồn bằng tsx. null nếu không có cả hai. */
export function runnerCommand(appDir = APP_DIR): { bin: string; args: string[] } | null {
  const bundled = path.join(appDir, 'server', 'stt-runner.mjs');
  if (fs.existsSync(bundled)) return { bin: process.execPath, args: [bundled] };
  const source = path.join(path.dirname(fileURLToPath(import.meta.url)), 'stt-runner.ts');
  if (fs.existsSync(source)) return { bin: process.execPath, args: ['--import', 'tsx', source] };
  return null;
}

export interface LocalSttOptions {
  modelsDir: string;
  ffmpeg: string;
  threads: number;
  signal: AbortSignal;
  /** Số giây âm thanh đã xử lý (báo khoảng mỗi 10 giây âm thanh). */
  onProgress?: (processedS: number) => void;
  /** Ghi đè lệnh chạy (test). */
  command?: { bin: string; args: string[] } | null;
}

export async function transcribeLocal(audioAbs: string, opts: LocalSttOptions): Promise<SttOutcome> {
  const status = sttModelStatus(opts.modelsDir);
  if (!status.installed) throw new SttError('STT_MODEL_MISSING', STT_MODEL_MISSING);
  const command = opts.command === undefined ? runnerCommand() : opts.command;
  if (!command) throw new SttError('STT_LOCAL_FAILED', 'Thiếu bộ nhận dạng lời nói của app (stt-runner); hãy cài lại AI Vinh Gia');
  if (opts.signal.aborted) throw new SttCancelled();
  const payload = JSON.stringify({ ffmpeg: opts.ffmpeg, input: audioAbs, modelDir: status.dir, threads: opts.threads, modelLabel: STT_MODEL.id });

  return new Promise<SttOutcome>((resolve, reject) => {
    const child = spawn(command.bin, [...command.args, payload], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let result: SttVerbose | null = null;
    let error: string | null = null;
    let stderr = '';
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      buf += d;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg: { type?: string; processed_s?: number; result?: SttVerbose; message?: string };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type === 'progress' && typeof msg.processed_s === 'number') opts.onProgress?.(msg.processed_s);
        else if (msg.type === 'result' && msg.result) result = msg.result;
        else if (msg.type === 'error') error = msg.message ?? 'lỗi không rõ';
      }
    });
    child.stderr.on('data', (d) => (stderr = (stderr + String(d)).slice(-2000)));
    const onAbort = () => {
      if (child.pid) killTree(child.pid);
    };
    opts.signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => {
      opts.signal.removeEventListener('abort', onAbort);
      reject(new SttError('STT_LOCAL_FAILED', `Không chạy được bộ nhận dạng lời nói: ${e.message}`));
    });
    child.on('close', (code) => {
      opts.signal.removeEventListener('abort', onAbort);
      if (opts.signal.aborted) return reject(new SttCancelled());
      if (code === 0 && result) return resolve({ result, jobId: null });
      const why = error ?? (stderr.trim().split(/\r?\n/).pop() || `thoát với mã ${code}`);
      reject(new SttError('STT_LOCAL_FAILED', `Nhận dạng lời nói trên máy lỗi: ${why.slice(0, 300)}`));
    });
  });
}
