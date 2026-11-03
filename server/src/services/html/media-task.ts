import { execFile } from 'node:child_process';
import { mediaEnv } from './config.js';

/** FFmpeg trên dữ liệu người dùng: không kế thừa key, có timeout, đóng cửa sổ và chờ tiến trình thoát khi hủy. */
export function runHtmlMedia(bin: string, args: string[], signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { signal, timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true, env: mediaEnv() }, (err) => err ? reject(err) : resolve());
  });
}
