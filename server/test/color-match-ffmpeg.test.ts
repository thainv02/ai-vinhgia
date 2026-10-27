import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveMatchLuts } from '../src/services/color-match.js';
import { LabAccumulator, parseCube, srgbToLab } from '../src/services/color-lut.js';
import { encodeGraded, verifyGraded } from '../src/services/final-render/grade-step.js';
import { buildGradeFilter, normalizeGrade, outRanges, type Grade } from '../src/services/grade.js';
import { FFMPEG, FFPROBE, ffprobeJson } from './final-helpers.js';
import { frameLightness, frameMean } from './helpers-color.js';
import { makeEnv, multipart, userClient, type Env } from './helpers.js';

/** Ảnh so sánh trước | sau | ảnh mẫu (ffmpeg hstack, cùng chiều cao) để xem bằng mắt; chỉ ghi khi đặt biến môi trường (test thường không tạo file ngoài thư mục tạm). */
function writeComparison(outPng: string | undefined, before: string, after: string, reference: string, t: number): void {
  if (!outPng) return;
  fs.mkdirSync(path.dirname(outPng), { recursive: true });
  ff(['-ss', String(t), '-i', before, '-ss', String(t), '-i', after, '-i', reference, '-filter_complex', '[0:v]scale=-2:480[a];[1:v]scale=-2:480[b];[2:v]scale=-2:480[c];[a][b][c]hstack=3', '-frames:v', '1', outPng]);
}

const run = FFMPEG && FFPROBE ? describe : describe.skip;

/** Trung bình Lab (a, b) của một khung: đo độ lệch SẮC giữa hai cảnh (chế độ color giữ L nên RGB không dùng được để so tông). */
function frameChroma(abs: string, t: number): { a: number; b: number } {
  const r = spawnSync(FFMPEG!, ['-loglevel', 'error', '-ss', String(t), '-i', abs, '-frames:v', '1', '-vf', 'scale=90:160', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 10_000_000 });
  const acc = new LabAccumulator();
  acc.addRgb24(r.stdout as Buffer, 90, 160);
  const s = acc.stats()!;
  return { a: s.mean[1], b: s.mean[2] };
}
const chromaGap = (abs: string, t1: number, t2: number): number => {
  const x = frameChroma(abs, t1);
  const y = frameChroma(abs, t2);
  return Math.hypot(x.a - y.a, x.b - y.b);
};

/** Pixel RGB24 của một khung (scale cố định 320x180) để so từng pixel giữa ảnh gốc và đầu ra. */
function rawFrame(abs: string, t: number): Buffer {
  const r = spawnSync(FFMPEG!, ['-loglevel', 'error', ...(t > 0 ? ['-ss', String(t)] : []), '-i', abs, '-frames:v', '1', '-vf', 'scale=320:180:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 10_000_000 });
  return r.stdout as Buffer;
}
/** Trung bình |a*|, |b*| (và số pixel) của vùng GẦN TRUNG TÍNH của ảnh gốc (C* < 6 và L* > 70: trắng/xám sáng) trong khung `out`. */
function neutralDrift(orig: Buffer, out: Buffer): { a: number; b: number; n: number } {
  let n = 0, a = 0, b = 0;
  for (let i = 0; i < orig.length; i += 3) {
    const l0 = srgbToLab(orig[i]! / 255, orig[i + 1]! / 255, orig[i + 2]! / 255);
    if (Math.hypot(l0[1], l0[2]) >= 6 || l0[0] <= 70) continue;
    const lo = srgbToLab(out[i]! / 255, out[i + 1]! / 255, out[i + 2]! / 255);
    n++;
    a += Math.abs(lo[1]);
    b += Math.abs(lo[2]);
  }
  return { a: a / n, b: b / n, n };
}

const ff = (args: string[]) => {
  const r = spawnSync(FFMPEG!, ['-y', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
};

/** Dải màu mượt (không nhiễu để khỏi bị cắt xén khi chuyển YUV⇄RGB): 3 màu `c0 c1 c2`. `seed` cố định vì mặc định của ffmpeg là ngẫu nhiên. */
const gradient = (size: string, c: [string, string, string], seconds: number, speed = 0.02) =>
  `gradients=size=${size}:c0=${c[0]}:c1=${c[1]}:c2=${c[2]}:nb_colors=3:seed=7:x0=0:y0=0:x1=${size.split('x')[0]}:y1=${size.split('x')[1]}:speed=${speed}:rate=24:duration=${seconds}`;

const WARM: [string, string, string] = ['0xf0b070', '0xc06020', '0xfbd9a0']; // cam ấm
const COOL: [string, string, string] = ['0x4070c0', '0x103060', '0xa0c8f0']; // xanh lạnh
const GREEN: [string, string, string] = ['0x40a060', '0x104020', '0xa8e0b0']; // xanh lá

run('màu theo ảnh mẫu bằng ffmpeg thật (ảnh mẫu cam ấm + clip xanh lạnh)', () => {
  let env: Env;
  let slug: string;
  let projectId: number;
  let refId: number;
  let cool: string; // clip lạnh 4 giây
  let two: string; // clip 2 cảnh (lạnh rồi xanh lá), mỗi cảnh 2 giây
  let work: string;
  const config = () => env.ctx.config;

  async function upload(name: string, data: Buffer, type = 'application/octet-stream'): Promise<any> {
    const m = multipart([{ name: 'file', filename: name, data, type }]);
    const res = await env.app.inject({ method: 'POST', url: `/api/projects/${projectId}/color-refs`, payload: m.payload, headers: { host: 'localhost:8787', ...m.headers } });
    expect(res.statusCode, res.body).toBeLessThan(300);
    return JSON.parse(res.body).color_ref;
  }

  beforeEach(async () => {
    env = await makeEnv();
    work = path.join(env.root, 'work');
    fs.mkdirSync(work, { recursive: true });
    const p = (await userClient(env.app).post('/api/projects', { name: 'Cacao Màu', brief: 'x' })).body;
    projectId = p.id;
    slug = p.slug;
    ff(['-f', 'lavfi', '-i', gradient('320x480', WARM, 1, 0), '-frames:v', '1', path.join(work, 'warm.png')]);
    cool = path.join(work, 'cool.mp4');
    ff(['-f', 'lavfi', '-i', gradient('180x320', COOL, 4), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', cool]);
    const a = path.join(work, 'a.mp4');
    const b = path.join(work, 'b.mp4');
    ff(['-f', 'lavfi', '-i', gradient('180x320', COOL, 2), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', a]);
    ff(['-f', 'lavfi', '-i', gradient('180x320', GREEN, 2), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', b]);
    two = path.join(work, 'two.mp4');
    ff(['-i', a, '-i', b, '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', two]);
    refId = (await upload('mau-am.png', fs.readFileSync(path.join(work, 'warm.png')), 'image/png')).id;
  });
  afterEach(async () => {
    await env.close();
  });

  const project = () => ({ id: projectId, slug });
  /** Chạy đúng đường đi của bước dựng: resolveMatchLuts → buildGradeFilter → encodeGraded → verifyGraded. */
  async function grade(g: Grade, base = cool, edl?: { scenes: { scene_id: number; segments: { in_s: number; out_s: number }[] }[] }): Promise<{ out: string; filter: string; luts: Awaited<ReturnType<typeof resolveMatchLuts>> }> {
    const ranges = edl ? outRanges(edl) : [];
    const luts = await resolveMatchLuts(env.ctx, project(), g, { baseAbs: base, ranges });
    const filter = buildGradeFilter(g, ranges, luts);
    expect(filter).toBeTruthy();
    const out = path.join(work, `out-${Math.random().toString(36).slice(2)}.mp4`);
    await encodeGraded({ config: config(), inAbs: base, tmpAbs: out, filter: filter!, signal: new AbortController().signal, onProgress: () => undefined });
    verifyGraded(config(), base, out);
    return { out, filter: filter!, luts };
  }
  const match = (extra: Record<string, unknown> = {}) => normalizeGrade({ match: { kind: 'image', ref_id: refId, ...extra } }, { matchRefs: new Map([[refId, 'image']]) });

  it('ảnh mẫu cam ấm + clip xanh lạnh: R/B trung bình tăng rõ; mode=color giữ luma (sai lệch < 3%); LUT sinh ra là .cube 33³ trong output/<slug>/final/luts', async () => {
    const before = frameMean(cool, 2);
    const { out, luts } = await grade(match({ strength: 1 }));
    const after = frameMean(out, 2);
    const ratio0 = before.r / before.b;
    const ratio1 = after.r / after.b;
    expect(ratio1).toBeGreaterThan(ratio0 * 2.5); // vốn B ≫ R (xanh lạnh) → R/B tăng mạnh
    expect(after.r).toBeGreaterThan(before.r + 20);
    expect(after.b).toBeLessThan(before.b - 20);
    // Chế độ color giữ độ chói: L* (CIELAB) trung bình sai lệch < 3% (đo ~1,1%) và luma Y' của YUV (Rec.709 trên mã gamma) cũng < 3% (đo ~2,3%).
    const l0 = frameLightness(cool, 2);
    const l1 = frameLightness(out, 2);
    expect(Math.abs(l1 - l0) / l0).toBeLessThan(0.03);
    expect(Math.abs(after.luma - before.luma) / before.luma).toBeLessThan(0.03); // cả luma Y' của YUV (đo ~2,3%): lαβ giữ độ chói Y của điểm gốc
    writeComparison(process.env.COLOR_MATCH_COMPARE_OUT, cool, out, path.join(work, 'warm.png'), 2);
    // file LUT: đúng chỗ, đúng định dạng
    expect(path.relative(env.root, luts.global!)).toMatch(new RegExp(`^output/${slug}/final/luts/[0-9a-f]{16}\\.cube$`));
    expect(parseCube(fs.readFileSync(luts.global!, 'utf8')).size).toBe(33);
    expect(luts.scenes).toEqual([]);
    // đầu ra giữ độ phân giải, fps, thời lượng
    expect(ffprobeJson(out).streams.find((s: any) => s.codec_type === 'video')).toMatchObject({ width: 180, height: 320, r_frame_rate: '24/1', pix_fmt: 'yuv420p' });
  });

  it('cường độ tăng dần → R/B tăng dần; strength=0 cho LUT đồng nhất và video gần như không đổi (< 5 mức: sai số chuyển RGB→YUV sẵn có của ffmpeg)', async () => {
    const b = frameMean(cool, 2);
    const rb = async (s: number) => {
      const o = frameMean((await grade(match({ strength: s }))).out, 2);
      return o.r / o.b;
    };
    const [r3, r7, r10] = [await rb(0.3), await rb(0.7), await rb(1)];
    expect(r3).toBeGreaterThan(b.r / b.b);
    expect(r7).toBeGreaterThan(r3);
    expect(r10).toBeGreaterThan(r7);
    const { out, luts } = await grade(match({ strength: 0 }));
    const lut = parseCube(fs.readFileSync(luts.global!, 'utf8'));
    let worst = 0;
    const N = lut.size;
    for (let i = 0; i < lut.data.length; i += 3) {
      const idx = i / 3;
      const r = idx % N, g = Math.floor(idx / N) % N, bl = Math.floor(idx / (N * N));
      worst = Math.max(worst, Math.abs(lut.data[i]! - r / (N - 1)), Math.abs(lut.data[i + 1]! - g / (N - 1)), Math.abs(lut.data[i + 2]! - bl / (N - 1)));
    }
    expect(worst).toBeLessThan(1e-5); // LUT = đồng nhất
    const o = frameMean(out, 2);
    expect(Math.max(Math.abs(o.r - b.r), Math.abs(o.g - b.g), Math.abs(o.b - b.b))).toBeLessThan(5);
  });

  it('mode=full đổi cả độ sáng/tương phản theo ảnh mẫu (luma lệch hơn mode=color); dùng lại LUT theo hash, không ghi đè', async () => {
    const l0 = frameLightness(cool, 2);
    const colorOnly = await grade(match({ strength: 1, mode: 'color' }));
    const full = await grade(match({ strength: 1, mode: 'full' }));
    const dColor = Math.abs(frameLightness(colorOnly.out, 2) - l0);
    const dFull = Math.abs(frameLightness(full.out, 2) - l0);
    expect(dColor).toBeLessThan(1.5); // color giữ L*
    expect(dFull).toBeGreaterThan(dColor + 2); // full kéo L* về phía ảnh mẫu
    expect(colorOnly.luts.global).not.toBe(full.luts.global);
    // cùng thông số → cùng file, nội dung không bị ghi đè
    const again = await resolveMatchLuts(env.ctx, project(), match({ strength: 1, mode: 'color' }), { baseAbs: cool, ranges: [] });
    expect(again.global).toBe(colorOnly.luts.global);
    const mtime = fs.statSync(again.global!).mtimeMs;
    await resolveMatchLuts(env.ctx, project(), match({ strength: 1, mode: 'color' }), { baseAbs: cool, ranges: [] });
    expect(fs.statSync(again.global!).mtimeMs).toBe(mtime);
  });

  it('lut3d chạy TRƯỚC các chỉnh khác: sau khi khớp ảnh mẫu vẫn "ấm hơn" được (R/B cao hơn chỉ-khớp); eq theo cảnh vẫn đúng khoảng', async () => {
    const g = match({ strength: 0.7 });
    const only = await grade(g);
    const warmer = await grade({ ...g, temperature_k: 7600 });
    expect(warmer.filter.indexOf('lut3d')).toBeGreaterThanOrEqual(0);
    expect(warmer.filter.indexOf('lut3d')).toBeLessThan(warmer.filter.indexOf('colortemperature'));
    const a = frameMean(only.out, 2);
    const w = frameMean(warmer.out, 2);
    expect(w.r / w.b).toBeGreaterThan((a.r / a.b) * 1.05);
  });

  it('khớp riêng từng cảnh: mỗi cảnh một LUT + enable theo khoảng, hai cảnh đồng đều tông (khoảng cách sắc a*b*) hơn so với khớp chung', async () => {
    const edl = { scenes: [{ scene_id: 1, segments: [{ in_s: 0, out_s: 2 }] }, { scene_id: 2, segments: [{ in_s: 0, out_s: 2 }] }] };
    const before = chromaGap(two, 1, 3);
    const shared = await grade(match({ strength: 1, per_scene: false }), two, edl);
    const per = await grade(match({ strength: 1, per_scene: true }), two, edl);
    expect(per.luts.global).toBeNull();
    expect(per.luts.scenes.map((s) => s.scene_id)).toEqual([1, 2]);
    expect(per.luts.scenes[0]!.path).not.toBe(per.luts.scenes[1]!.path);
    expect(per.filter).toContain("enable='between(t,0,1.999)'");
    expect(per.filter).toContain("enable='between(t,2,3.999)'");
    expect(per.filter.match(/lut3d=/g)).toHaveLength(2);
    const dShared = chromaGap(shared.out, 1, 3);
    const dPer = chromaGap(per.out, 1, 3);
    expect(before).toBeGreaterThan(30); // xanh dương vs xanh lá: rất khác tông
    expect(dShared).toBeGreaterThan(10); // khớp chung vẫn còn chênh giữa hai cảnh
    expect(dPer).toBeLessThan(dShared * 0.5); // lαβ kẹp σ sắc 0,8–1,25 nên không ép hẳn về một tông (còn dư vài đơn vị)
    // cảnh xanh lá cũng được kéo về tông cam: a*, b* dương hơn hẳn
    expect(frameChroma(per.out, 3).b).toBeGreaterThan(frameChroma(two, 3).b + 10);
  });

  it('vết ám màu: clip = cảnh ấm có mảng trắng/xám phủ tông xanh lạnh, ảnh mẫu = chính cảnh gốc → vùng trắng/xám sáng về trung tính (|a*|,|b*| nhỏ, không ngả hồng/vàng)', async () => {
    // cảnh giả kiểu ảnh sản phẩm: nền gradient ấm, mảng trắng và xám sáng (~25% diện tích)
    const scene = "gradients=size=320x180:c0=0xc89060:c1=0x6a4a30:c2=0xe8c8a0:nb_colors=3:seed=7:speed=0:rate=24:duration=2,drawbox=x=20:y=20:w=110:h=70:color=0xf2f2f2:t=fill,drawbox=x=170:y=90:w=120:h=70:color=0xb8b8b8:t=fill";
    const bars = path.join(work, 'scene.png');
    ff(['-f', 'lavfi', '-i', scene, '-frames:v', '1', bars]);
    const casted = path.join(work, 'scene-cast.mp4');
    ff(['-f', 'lavfi', '-i', scene, '-vf', 'colorchannelmixer=rr=0.5:gg=0.7:bb=1,format=yuv420p', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', casted]);
    const barsRef = await upload('scene.png', fs.readFileSync(bars), 'image/png');
    const orig = rawFrame(bars, 0);
    const before = neutralDrift(orig, rawFrame(casted, 1));
    expect(before.n).toBeGreaterThan(1000);
    expect(before.a + before.b).toBeGreaterThan(20); // trắng/xám của clip đang ám xanh rõ
    const g = normalizeGrade({ match: { kind: 'image', ref_id: barsRef.id, strength: 1 } }, { matchRefs: new Map([[barsRef.id, 'image']]) });
    const { out } = await grade(g, casted);
    const after = neutralDrift(orig, rawFrame(out, 1));
    expect(after.a).toBeLessThan(4);
    expect(after.b).toBeLessThan(4);
    expect(after.a + after.b).toBeLessThan((before.a + before.b) / 4);
  });

  it('đường dẫn LUT có dấu cách, hai chấm, nháy, phẩy, ngoặc vuông, chấm phẩy vẫn chạy được trong ffmpeg thật', async () => {
    const { luts } = await grade(match({ strength: 1 }));
    const weird = path.join(work, "thư mục lạ: a 'b', [c];d=e");
    fs.mkdirSync(weird, { recursive: true });
    const copy = path.join(weird, "lut ế: 'x',[1].cube");
    fs.copyFileSync(luts.global!, copy);
    const g = match({ strength: 1 });
    const filter = buildGradeFilter(g, [], { global: copy, scenes: [] })!;
    const out = path.join(work, 'weird.mp4');
    await encodeGraded({ config: config(), inAbs: cool, tmpAbs: out, filter, signal: new AbortController().signal, onProgress: () => undefined });
    const base = frameMean((await grade(g)).out, 2);
    const w = frameMean(out, 2);
    expect(Math.abs(w.r - base.r) + Math.abs(w.b - base.b)).toBeLessThan(1);
  });

  it('file LUT người dùng (.cube hoán đổi R↔B): tải lên → chuẩn hoá → áp được; strength trộn với đồng nhất; không lưu/ phục vụ file gốc', async () => {
    const N = 17;
    const rows = ['TITLE "đổi kênh"', `LUT_3D_SIZE ${N}`];
    for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) rows.push(`${(b / (N - 1)).toFixed(5)} ${(g / (N - 1)).toFixed(5)} ${(r / (N - 1)).toFixed(5)}`); // (R,G,B) → (B,G,R)
    const raw = Buffer.from(rows.join('\n') + '\n');
    const ref = await upload('swap.cube', raw);
    expect(ref).toMatchObject({ kind: 'lut', lut_size: 17, thumb_url: null, image_url: null });
    const stored = fs.readFileSync(path.join(env.root, `output/${slug}/final/color-refs`, fs.readdirSync(path.join(env.root, `output/${slug}/final/color-refs`)).find((f) => f.endsWith('.cube'))!), 'utf8');
    expect(stored).not.toBe(raw.toString()); // server ghi lại bản chuẩn hoá
    expect(stored).toContain('LUT_3D_SIZE 17');
    const gm = (s: number) => normalizeGrade({ match: { kind: 'lut', ref_id: ref.id, strength: s } }, { matchRefs: new Map([[ref.id, 'lut']]) });
    const b0 = frameMean(cool, 2);
    const full = frameMean((await grade(gm(1))).out, 2);
    expect(full.r).toBeGreaterThan(b0.b - 6); // R mới ≈ B cũ
    expect(full.b).toBeLessThan(b0.r + 6);
    const half = frameMean((await grade(gm(0.5))).out, 2);
    expect(half.r).toBeGreaterThan(b0.r + 10);
    expect(half.r).toBeLessThan(full.r - 10);
  });

  it('video gắn nhãn bt709: khớp màu vẫn chạy và R/B tăng (không lỗi không gian màu)', async () => {
    const tagged = path.join(work, 'tagged.mp4');
    ff(['-f', 'lavfi', '-i', gradient('180x320', COOL, 2), '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p', '-c:v', 'libx264', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', tagged]);
    const b = frameMean(tagged, 1);
    const { out } = await grade(match({ strength: 1 }), tagged);
    const a = frameMean(out, 1);
    expect(a.r / a.b).toBeGreaterThan((b.r / b.b) * 2);
    expect(Math.abs(a.luma - b.luma) / b.luma).toBeLessThan(0.04);
  });

  // Kịch bản "ảnh thật": đặt COLOR_MATCH_PHOTO=<ảnh jpg/png> và COLOR_MATCH_PHOTO_OUT=<png> để dựng ảnh so sánh trước | sau | ảnh mẫu từ ảnh thật
  // (clip nguồn = chính ảnh đó bị phủ tông xanh lạnh, ảnh mẫu = ảnh gốc ấm). Không đặt biến → bỏ qua.
  const photo = process.env.COLOR_MATCH_PHOTO;
  (photo ? it : it.skip)('ảnh thật: clip phủ tông xanh lạnh + ảnh mẫu gốc → R/B tăng, ghi ảnh so sánh', async () => {
    const src = path.join(work, 'photo-cool.mp4');
    ff(['-loop', '1', '-framerate', '24', '-t', '4', '-i', photo!, '-vf', "colorchannelmixer=rr=0.45:gg=0.65:bb=1,scale=360:640:force_original_aspect_ratio=increase,crop=360:640,format=yuv420p", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]);
    const refUp = await upload('anh-goc.jpg', fs.readFileSync(photo!), 'image/jpeg');
    const g = normalizeGrade({ match: { kind: 'image', ref_id: refUp.id, strength: 0.85 } }, { matchRefs: new Map([[refUp.id, 'image']]) });
    const b = frameMean(src, 2);
    const { out } = await grade(g, src);
    const a = frameMean(out, 2);
    expect(a.r / a.b).toBeGreaterThan((b.r / b.b) * 1.3);
    writeComparison(process.env.COLOR_MATCH_PHOTO_OUT, src, out, photo!, 2);
  });
});
