import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { encodeGraded, linkOrCopy, verifyGraded } from '../src/services/final-render/grade-step.js';
import { buildGradeFilter, normalizeGrade, outRanges, type Grade } from '../src/services/grade.js';
import { FFMPEG, FFPROBE, ffprobeJson, makeTestVideo } from './final-helpers.js';

const run = FFMPEG && FFPROBE ? describe : describe.skip;

/** Giải mã một khung ở thời điểm t thành RGB24 thô, trả [R,G,B] trung bình và độ lệch chuẩn của độ sáng (Rec.709 xấp xỉ). */
function frameStats(abs: string, t: number): { r: number; g: number; b: number; lumaMean: number; lumaStd: number } {
  const r = spawnSync(FFMPEG!, ['-loglevel', 'error', '-ss', String(t), '-i', abs, '-frames:v', '1', '-vf', 'scale=96:-2', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 10_000_000 });
  const buf = r.stdout as Buffer;
  let sr = 0, sg = 0, sb = 0, sl = 0, sl2 = 0;
  const n = buf.length / 3;
  for (let i = 0; i < buf.length; i += 3) {
    const R = buf[i]!, G = buf[i + 1]!, B = buf[i + 2]!;
    sr += R; sg += G; sb += B;
    const l = 0.2126 * R + 0.7152 * G + 0.0722 * B;
    sl += l; sl2 += l * l;
  }
  const m = sl / n;
  return { r: sr / n, g: sg / n, b: sb / n, lumaMean: m, lumaStd: Math.sqrt(Math.max(0, sl2 / n - m * m)) };
}

run('chỉnh màu bằng ffmpeg thật (clip ngắn)', () => {
  let root: string;
  let base: string;
  const config = () => defaultConfig(root, path.join(root, 'x.db'));
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'autovideo-grade-'));
    base = path.join(root, 'base.mp4');
    // nguồn có tương phản/bão hoà vừa phải (testsrc2 gốc đã chạm hai đầu thang nên tăng tương phản chỉ bị cắt xén)
    const raw = path.join(root, 'raw.mp4');
    makeTestVideo(raw, 4, { audio: true, size: '180x320' });
    const r = spawnSync(FFMPEG!, ['-y', '-loglevel', 'error', '-i', raw, '-vf', 'eq=contrast=0.55:saturation=0.8,format=yuv420p', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'copy', base], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  async function grade(g: Grade, edl = { scenes: [{ scene_id: 1, segments: [{ in_s: 0, out_s: 2 }] }, { scene_id: 2, segments: [{ in_s: 0, out_s: 2 }] }] }): Promise<string> {
    const filter = buildGradeFilter(g, outRanges(edl));
    expect(filter).toBeTruthy();
    const out = path.join(root, `out-${Math.random().toString(36).slice(2)}.mp4`);
    const pct: number[] = [];
    await encodeGraded({ config: config(), inAbs: base, tmpAbs: out, filter: filter!, signal: new AbortController().signal, onProgress: (p) => pct.push(p) });
    verifyGraded(config(), base, out);
    return out;
  }

  it('"ấm hơn" làm tỉ lệ R/B trung bình tăng; "lạnh hơn" làm giảm; giữ độ phân giải, fps, âm thanh (copy), thời lượng', async () => {
    const b = frameStats(base, 1);
    const warm = await grade(normalizeGrade({ temperature_k: 7500 }));
    const cool = await grade(normalizeGrade({ temperature_k: 5500 }));
    const w = frameStats(warm, 1);
    const c = frameStats(cool, 1);
    expect(w.r / w.b).toBeGreaterThan((b.r / b.b) * 1.05);
    expect(c.r / c.b).toBeLessThan((b.r / b.b) * 0.95);
    const pw = ffprobeJson(warm);
    const pb = ffprobeJson(base);
    const v = pw.streams.find((s: any) => s.codec_type === 'video');
    expect(v).toMatchObject({ codec_name: 'h264', width: 180, height: 320, r_frame_rate: '24/1', pix_fmt: 'yuv420p' });
    expect(pw.streams.find((s: any) => s.codec_type === 'audio')).toMatchObject({ codec_name: pb.streams.find((s: any) => s.codec_type === 'audio').codec_name });
    expect(Math.abs(Number(pw.format.duration) - Number(pb.format.duration))).toBeLessThan(0.1);
    expect(pw.format.tags?.major_brand ?? 'isom').toBeTruthy();
  });

  it('tương phản tăng làm độ lệch chuẩn luma tăng (giảm thì giảm); độ sáng tăng làm luma trung bình tăng; bão hoà giảm về 0,5 làm khoảng cách kênh co lại', async () => {
    const b = frameStats(base, 1);
    const hi = frameStats(await grade(normalizeGrade({ contrast: 1.4 })), 1);
    const lo = frameStats(await grade(normalizeGrade({ contrast: 0.75 })), 1);
    expect(hi.lumaStd).toBeGreaterThan(b.lumaStd * 1.1);
    expect(lo.lumaStd).toBeLessThan(b.lumaStd * 0.9);
    const bright = frameStats(await grade(normalizeGrade({ brightness: 0.15 })), 1);
    expect(bright.lumaMean).toBeGreaterThan(b.lumaMean + 10);
    const desat = frameStats(await grade(normalizeGrade({ saturation: 0.5 })), 1);
    const spread = (s: typeof b) => Math.max(s.r, s.g, s.b) - Math.min(s.r, s.g, s.b);
    expect(spread(desat)).toBeLessThan(spread(b));
  });

  it('vibrance và gamma chạy được và đổi hình', async () => {
    const b = frameStats(base, 1);
    const g = frameStats(await grade(normalizeGrade({ gamma: 0.8, vibrance: 0.6 })), 1);
    expect(Math.abs(g.lumaMean - b.lumaMean) + Math.abs(g.r - b.r) + Math.abs(g.b - b.b)).toBeGreaterThan(2);
  });

  it('chỉnh theo cảnh (enable between): chỉ cảnh 2 (giây 2–4 của video đầu ra) sáng hơn, cảnh 1 giữ nguyên', async () => {
    const edl = { scenes: [{ scene_id: 1, segments: [{ in_s: 0, out_s: 2 }] }, { scene_id: 2, segments: [{ in_s: 0, out_s: 2 }] }] };
    const out = await grade(normalizeGrade({ scenes: [{ scene_id: 2, brightness: 0.2 }] }, { sceneIds: [1, 2] }), edl);
    const b1 = frameStats(base, 1);
    const b3 = frameStats(base, 3);
    const o1 = frameStats(out, 1);
    const o3 = frameStats(out, 3);
    expect(Math.abs(o1.lumaMean - b1.lumaMean)).toBeLessThan(3);
    expect(o3.lumaMean).toBeGreaterThan(b3.lumaMean + 15);
  });

  it('hủy giữa chừng → RenderCancelled, không để lại file; không ghi đè file có sẵn (linkOrCopy)', async () => {
    const ac = new AbortController();
    const out = path.join(root, 'cancel.mp4');
    const p = encodeGraded({ config: config(), inAbs: base, tmpAbs: out, filter: buildGradeFilter(normalizeGrade({ temperature_k: 7000 }))!, signal: ac.signal, onProgress: () => undefined });
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'RenderCancelled' });
    expect(fs.existsSync(out)).toBe(false);
    const dst = path.join(root, 'link.mp4');
    expect(linkOrCopy(base, dst)).toBe('link');
    expect(fs.statSync(dst).ino).toBe(fs.statSync(base).ino);
    expect(() => linkOrCopy(base, dst)).toThrow(/không ghi đè/);
  });
});
