/**
 * ZIP "store" (không nén) bằng Node thuần, không thêm thư viện. Đủ cho gói ảnh png/jpg/webp (đã nén sẵn).
 * Mỗi mục được đọc lười (một file trong bộ nhớ tại một thời điểm); giới hạn của định dạng ZIP gốc (không ZIP64):
 * dưới 65535 mục, mỗi file và tổng dưới 4 GiB.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** Tên trong gói (dấu `/` làm thư mục, UTF-8). Người gọi phải làm sạch tên. */
  name: string;
  read: () => Buffer;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Sinh dần các đoạn byte của file ZIP (dùng với Readable.from để stream ra HTTP). */
export function* zipChunks(entries: ZipEntry[], when: Date = new Date()): Generator<Buffer> {
  if (entries.length >= 0xffff) throw new Error('Quá nhiều mục cho ZIP không ZIP64');
  const { time, date } = dosDateTime(when);
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = e.read();
    if (data.length >= 0xffffffff || offset >= 0xffffffff) throw new Error('ZIP vượt giới hạn 4 GiB');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // cờ: tên UTF-8
    local.writeUInt16LE(0, 8); // method 0 = store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, name]));

    yield local;
    yield name;
    yield data;
    offset += 30 + name.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  yield cdBuf;
  yield end;
}

/** Toàn bộ ZIP trong bộ nhớ (test, gói nhỏ). */
export function buildZip(entries: ZipEntry[], when?: Date): Buffer {
  return Buffer.concat([...zipChunks(entries, when)]);
}
