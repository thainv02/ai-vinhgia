import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';

export interface RotatingLog {
  /** Stream cho pino/Fastify (`logger: { stream }`). */
  stream: { write(msg: string): void };
  close(): void;
}

/**
 * Ghi log ra file bằng `pino.destination` (không dùng transport/worker thread) và tự xoay vòng trong cùng tiến trình:
 * quá `maxBytes` thì đổi tên server.log → server.log.1 → … → server.log.<files-1>, bỏ file cũ nhất.
 * Dùng ghi đồng bộ vì log ở mức warn rất thưa, đổi lại không mất dòng cuối khi tiến trình bị kill.
 */
export function createRotatingLog(file: string, maxBytes = 5 * 1024 * 1024, files = 5): RotatingLog {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const open = () => pino.destination({ dest: file, sync: true, mkdir: true });
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    /* chưa có file */
  }
  let dest = open();

  const rotate = () => {
    dest.end();
    try {
      fs.rmSync(`${file}.${files - 1}`, { force: true });
      for (let i = files - 2; i >= 1; i--) {
        if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
      }
      fs.renameSync(file, `${file}.1`);
    } catch {
      /* không đổi tên được (file đang bị khoá): cứ ghi tiếp vào file hiện tại */
    }
    dest = open();
    size = 0;
  };

  return {
    stream: {
      write(msg: string) {
        if (size > 0 && size + Buffer.byteLength(msg) > maxBytes) rotate();
        size += Buffer.byteLength(msg);
        dest.write(msg);
      },
    },
    close() {
      dest.end();
    },
  };
}
