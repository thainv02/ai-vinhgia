import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import type { Config } from '../../config.js';
import { probeMedia } from '../media.js';
import { RenderCancelled } from './types.js';

/** Trạng thái bước xoá logo Veo cho `GET /api/meta` → `watermark_remover`. */
export interface WatermarkStatus {
  mode: 'auto' | 'off';
  /** true = bản dựng sẽ được chạy qua tool xoá logo trước khi `ready`. */
  active: boolean;
  /** Lý do (tiếng Việt) để giao diện hiển thị. */
  reason: string;
  cli: string | null;
}

/** `auto`: bật nếu GWR_CLI là đường dẫn tuyệt đối tồn tại và `node <GWR_CLI> --help` chạy được; `off`: bỏ qua. */
export function computeWatermarkStatus(config: Pick<Config, 'watermarkRemover' | 'gwrCli'>): Promise<WatermarkStatus> {
  const cli = config.gwrCli;
  if (config.watermarkRemover === 'off') {
    return Promise.resolve({ mode: 'off', active: false, reason: 'WATERMARK_REMOVER=off: bỏ qua bước xoá logo Veo (video ra còn logo)', cli });
  }
  const off = (reason: string): WatermarkStatus => ({ mode: 'auto', active: false, reason, cli });
  if (!cli) return Promise.resolve(off('Chưa cấu hình GWR_CLI: không xoá logo Veo'));
  if (!path.isAbsolute(cli)) return Promise.resolve(off('GWR_CLI phải là đường dẫn tuyệt đối'));
  if (!fs.existsSync(cli)) return Promise.resolve(off(`Không thấy tool xoá logo Veo tại ${cli}`));
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, '--help'], { timeout: 30_000, cwd: toolCwd(cli), maxBuffer: 1024 * 1024 }, (err) => {
      if (err) resolve(off(`Tool xoá logo Veo không chạy được (${String(err.message).split('\n')[0]!.slice(0, 160)})`));
      else resolve({ mode: 'auto', active: true, reason: 'Tự động: tool xoá logo Veo sẵn sàng', cli });
    });
  });
}

/** Thư mục chạy tool = thư mục repo của tool (cha của bin/). */
export const toolCwd = (cli: string): string => path.resolve(path.dirname(cli), '..');

// ------------------------------------------------------------------ chạy CLI

export interface CleanRequest {
  config: Config;
  inputAbs: string;
  /** File tạm cùng thư mục (`.<tên>.tmp.mp4`); bước sau mới đổi tên nguyên tử. */
  tmpAbs: string;
  signal: AbortSignal;
  /** 0–100 */
  onProgress(pct: number): void;
  /** Thời gian chờ thêm ngoài GWR_TIMEOUT_MS trước khi server tự dừng tool (mặc định 30 giây). */
  graceMs?: number;
}

export class WatermarkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WatermarkError';
  }
}

/** Rút gọn stderr của tool cho thông báo lỗi. */
export const shortStderr = (s: string, max = 300): string => {
  const lines = s
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => l && !/^\[video\]\s+\d/.test(l));
  const t = lines.slice(-4).join(' | ');
  return t.length > max ? '…' + t.slice(-max) : t;
};

/** Liệt kê mọi tiến trình con cháu của `root` (ps -A: pid, ppid). */
export function descendants(root: number): number[] {
  try {
    const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000 });
    const children = new Map<number, number[]>();
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (!m) continue;
      const pid = Number(m[1]);
      const ppid = Number(m[2]);
      (children.get(ppid) ?? children.set(ppid, []).get(ppid)!).push(pid);
    }
    const result: number[] = [];
    const stack = [root];
    while (stack.length) {
      for (const c of children.get(stack.pop()!) ?? []) {
        result.push(c);
        stack.push(c);
      }
    }
    return result;
  } catch {
    return [];
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Dừng cả cây tiến trình (node + Chromium + các tiến trình con): SIGTERM, 3 giây sau SIGKILL phần còn sống. */
export function killTree(rootPid: number): void {
  const pids = [rootPid, ...descendants(rootPid)];
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* đã thoát */
    }
  }
  setTimeout(() => {
    for (const pid of [...pids, ...descendants(rootPid)]) if (alive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* đã thoát */
      }
    }
  }, 3000).unref();
}

/**
 * Chạy `node <GWR_CLI> remove <input> --output <tmp> --json [--video-bitrate-mbps N] [--video-timeout-ms MS]` với cwd = thư mục repo của tool.
 * stdout: JSON `{input, output, kind, meta}`; stderr: tiến độ `[video] 74% 169/240 frames (...)`. Trả về `meta`/JSON của tool.
 * Hủy (signal) hoặc quá thời gian: dừng cả cây tiến trình con.
 */
export function runWatermarkCli(req: CleanRequest): Promise<unknown> {
  const cli = req.config.gwrCli;
  if (!cli) return Promise.reject(new WatermarkError('Chưa cấu hình GWR_CLI'));
  const args = [cli, 'remove', req.inputAbs, '--output', req.tmpAbs, '--json'];
  if (req.config.gwrVideoBitrateMbps) args.push('--video-bitrate-mbps', String(req.config.gwrVideoBitrateMbps));
  args.push('--video-timeout-ms', String(req.config.gwrTimeoutMs));
  return new Promise((resolve, reject) => {
    if (req.signal.aborted) return reject(new RenderCancelled());
    const child = spawn(process.execPath, args, { cwd: toolCwd(cli), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let errBuf = '';
    let timedOut = false;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.signal.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => {
      if (child.pid) killTree(child.pid);
    };
    req.signal.addEventListener('abort', onAbort, { once: true });
    // Tool tự có timeout (--video-timeout-ms); đây là lưới an toàn ngoài, rộng hơn 30 giây
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
    }, req.config.gwrTimeoutMs + (req.graceMs ?? 30_000));
    child.stdout.on('data', (d: Buffer) => {
      stdout = (stdout + d.toString()).slice(-200_000);
    });
    child.stderr.on('data', (d: Buffer) => {
      const text = d.toString();
      stderr = (stderr + text).slice(-8000);
      errBuf += text;
      const parts = errBuf.split(/[\r\n]+/);
      errBuf = parts.pop() ?? '';
      for (const line of parts) {
        const m = /\[video\]\s+(\d+(?:\.\d+)?)%/.exec(line);
        if (m) req.onProgress(Math.min(99, Number(m[1])));
      }
    });
    child.on('error', (err) => finish(() => reject(new WatermarkError(`Không chạy được tool xoá logo Veo: ${err.message}`))));
    child.on('close', (code, signal) =>
      finish(() => {
        if (req.signal.aborted) return reject(new RenderCancelled());
        if (timedOut) return reject(new WatermarkError(`Quá thời gian xoá logo Veo (${Math.round(req.config.gwrTimeoutMs / 60_000)} phút)`));
        if (code !== 0) {
          return reject(new WatermarkError(`tool thoát với mã ${code ?? signal}${stderr.trim() ? `: ${shortStderr(stderr)}` : ''}`));
        }
        let meta: unknown = null;
        const text = stdout.trim();
        try {
          meta = JSON.parse(text);
        } catch {
          const last = text.split('\n').reverse().find((l) => l.trim().startsWith('{'));
          try {
            meta = last ? JSON.parse(last) : null;
          } catch {
            meta = null;
          }
        }
        resolve(meta);
      }),
    );
  });
}

/**
 * Kiểm tra file sau khi xoá logo bằng ffprobe: có video, thời lượng lệch ≤ 0,25 giây so với bản raw, có âm thanh nếu raw có.
 * Ném WatermarkError nếu sai.
 */
export function verifyCleaned(config: Pick<Config, 'ffprobePath'>, rawAbs: string, cleanAbs: string): number | null {
  if (!fs.existsSync(cleanAbs) || fs.statSync(cleanAbs).size === 0) throw new WatermarkError('tool không tạo ra file kết quả');
  const out = probeMedia(config, cleanAbs);
  if (!out || !out.width) throw new WatermarkError('file kết quả không đọc được hoặc không có luồng video');
  const raw = probeMedia(config, rawAbs);
  if (raw?.duration_s != null && out.duration_s != null && Math.abs(out.duration_s - raw.duration_s) > 0.25) {
    throw new WatermarkError(`file kết quả dài ${out.duration_s.toFixed(2)}s, lệch quá 0,25s so với bản gốc (${raw.duration_s.toFixed(2)}s)`);
  }
  if (raw?.has_audio && !out.has_audio) throw new WatermarkError('file kết quả mất âm thanh');
  return out.duration_s;
}
