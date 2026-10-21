import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { FFPROBE, ffprobeJson } from './final-helpers.js';
import { claimEditPlan, makeEnv, setupAllDone, type Env } from './helpers.js';

/**
 * Tích hợp THẬT với Shotcut + Shotcut MCP (bỏ qua nếu máy không có). Media nằm trong thư mục tạm; chỉ ĐỌC 2 video Cacao
 * có sẵn trong output/cacao-smoothie/video/ (copy sang thư mục tạm, không ghi vào đó).
 * Ghi đè bằng biến môi trường nếu cần: SHOTCUT_MCP_PYTHON, SHOTCUT_MCP_SERVER_SCRIPT.
 */
const PYTHON = process.env.SHOTCUT_MCP_PYTHON || '/Users/thainv/.local/share/uv/python/cpython-3.12-macos-aarch64-none/bin/python3.12';
const SCRIPT = process.env.SHOTCUT_MCP_SERVER_SCRIPT || '/Users/thainv/code/shotcut-mcp/scripts/shotcut_mcp_server.py';
const SRC_DIR = fileURLToPath(new URL('../../output/cacao-smoothie/video', import.meta.url));
const SRC = [path.join(SRC_DIR, 'C1_v2.mp4'), path.join(SRC_DIR, 'C2_v1.mp4')];
const available =
  fs.existsSync('/Applications/Shotcut.app') && fs.existsSync(PYTHON) && fs.existsSync(SCRIPT) && SRC.every((f) => fs.existsSync(f)) && !!FFPROBE;

let env: Env;
afterEach(async () => {
  await env?.close();
});

(available ? describe : describe.skip)('Shotcut MCP thật', () => {
  it('2 video Cacao → edit_plan → render bằng Shotcut: có .mlt, contact sheet, mp4 đúng thời lượng (cắt thẳng)', async () => {
    env = await makeEnv({
      config: { finalRenderer: 'shotcut', shotcutMcpPython: PYTHON, shotcutMcpServerScript: SCRIPT },
      finalRender: { progressThrottleMs: 0, shotcut: { pollMs: 1000, timeoutMs: 5 * 60_000 } },
    });
    const status = await env.ctx.finalRender!.status(true);
    expect(status, JSON.stringify(status)).toMatchObject({ active: 'shotcut', shotcut: { ready: true } });

    const sc = await setupAllDone(env, { scenes: 2 });
    // thay file giả bằng bản sao video thật (nằm trong thư mục tạm của test)
    ['C1', 'C2'].forEach((code, i) => fs.copyFileSync(SRC[i]!, path.join(env.root, `output/cacao-actiso-plus/video/${code}_v1.mp4`)));
    const job = await claimEditPlan(sc);
    const cut = (await sc.user.get(`/api/final-cuts/${job.payload.final_cut_id}`)).body;
    expect(job.payload.scenes.map((s: any) => [s.code, Math.round(s.duration_s * 10) / 10, s.width, s.height])).toEqual([['C1', 10, 720, 1280], ['C2', 10, 720, 1280]]);

    // điểm cắt của bản thử người dùng đã duyệt: C1 [0–9.5], C2 [0.3–9.6]
    const [s1, s2] = cut.selection;
    const edl = {
      scenes: [
        { scene_id: s1.scene_id, asset_id: s1.asset_id, segments: [{ in_s: 0, out_s: 9.5 }], removed: [{ from_s: 9.5, to_s: 10, reason: 'Cuối khung đứng yên' }], note: '' },
        { scene_id: s2.scene_id, asset_id: s2.asset_id, segments: [{ in_s: 0.3, out_s: 9.6 }], removed: [{ from_s: 0, to_s: 0.3, reason: 'Đầu chưa có hành động' }], note: '' },
      ],
    };
    const r = await sc.worker.post(`/api/worker/jobs/${job.id}/complete`, { result: { edl, summary: 'Cắt đầu/cuối.' } });
    expect(r.status, r.raw).toBe(200);
    await env.ctx.finalRender!.idle();

    const done = (await sc.user.get(`/api/final-cuts/${cut.id}`)).body;
    expect(done, JSON.stringify(done.error)).toMatchObject({ status: 'ready', renderer: 'shotcut', progress: 100, error: null });
    expect(done.render_ref).toBeTruthy();
    const expected = 9.5 + (9.6 - 0.3); // 18.8 giây
    const video = path.join(env.root, done.video_path);
    const probe = ffprobeJson(video);
    const dur = Number(probe.format.duration);
    process.stderr.write(`[shotcut-integration] duration=${dur}s (kỳ vọng ${expected}s), duration_s trong DB=${done.duration_s}\n`);
    expect(Math.abs(dur - expected)).toBeLessThan(0.25);
    expect(Math.abs(done.duration_s - expected)).toBeLessThan(0.25);
    expect(probe.streams.find((s: any) => s.codec_type === 'video')).toMatchObject({ codec_name: 'h264', width: 720, height: 1280 });
    expect(probe.streams.some((s: any) => s.codec_type === 'audio')).toBe(true);
    expect(done.project_file_path).toBe('output/cacao-actiso-plus/final/shotcut/cacao-actiso-plus_final_v1.mlt');
    const mlt = fs.readFileSync(path.join(env.root, done.project_file_path), 'utf8');
    expect(mlt).toContain('<mlt');
    expect(mlt).toContain('C1 v1 #1');
    expect(fs.readFileSync(path.join(env.root, done.contact_sheet_path)).subarray(1, 4).toString()).toBe('PNG');
    // Range qua /files
    const range = await env.app.inject({ method: 'GET', url: done.video_url, headers: { host: 'localhost', range: 'bytes=0-1023' } });
    expect(range.statusCode).toBe(206);
    // Toàn bộ file nằm dưới thư mục dự án tạm (không đụng output/ thật)
    expect(fs.realpathSync(video).startsWith(fs.realpathSync(env.root))).toBe(true);
  }, 240_000);
});
