import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/config.js';
import {
  assertPromptVerbatim,
  ffprobeMeta,
  formatSummary,
  hasFfprobe,
  importLegacy,
  parseLogMd,
  parsePromptsMarkdown,
  scanLegacyFiles,
  tableCounts,
  verdictFromConclusion,
  type LegacyImportOptions,
} from '../src/services/legacy-import.js';
import { JPG_BYTES, PNG_BYTES, claim, client, makeEnv, userClient, writeFile, type Env } from './helpers.js';

const FIX = fileURLToPath(new URL('./fixtures/legacy/', import.meta.url));
const PROMPTS_MD = fs.readFileSync(path.join(FIX, 'cacao-smoothie-prompts.md'), 'utf8');
const LOG_MD = fs.readFileSync(path.join(FIX, 'log.md'), 'utf8');
const DIR = 'output/cacao-smoothie';
const STICK_PNG = Buffer.concat([PNG_BYTES, Buffer.from('stick')]);

/** Dựng ROOT tạm giống repo thật: file md thật + file media giả (rất nhỏ). */
function seedLegacyRoot(root: string): void {
  writeFile(root, 'cacao-smoothie-prompts.md', PROMPTS_MD);
  writeFile(root, `${DIR}/log.md`, LOG_MD);
  for (const c of ['C1', 'C2', 'C3', 'C4']) writeFile(root, `${DIR}/storyboard/${c}_storyboard.png`, PNG_BYTES);
  for (const f of ['C1_v1', 'C1_v2', 'C2_v1', 'C3_v1', 'C4_v1']) {
    writeFile(root, `${DIR}/video/${f}.mp4`, `fake-mp4 ${f}`);
    writeFile(root, `${DIR}/video/${f}_grid.jpg`, JPG_BYTES);
  }
  writeFile(root, 'MOCKUP_BOX/2.png', PNG_BYTES);
  writeFile(root, 'MOCKUP_BOX/MOCKUP-STICK.png', STICK_PNG);
}

/** Băm toàn bộ file dưới một thư mục (đường dẫn + nội dung + mtime) để chứng minh import không đụng vào dữ liệu cũ. */
function fingerprint(dir: string): string {
  const h = createHash('sha256');
  const walk = (d: string) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else h.update(`${path.relative(dir, p)}|${st.size}|${st.mtimeMs}|`).update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex');
}

const NO_PROBE: LegacyImportOptions = { probe: false };
const sum = (o: Record<string, number>): number => Object.values(o).reduce((a, b) => a + Math.abs(b), 0);

describe('parser', () => {
  it('prompts md: 4 cảnh, brief, style_lock, upload, khung đầu, prompt nguyên văn', () => {
    const p = parsePromptsMarkdown(PROMPTS_MD);
    expect(p.scenes.map((s) => s.code)).toEqual(['C1', 'C2', 'C3', 'C4']);
    expect(p.scenes.map((s) => s.title)).toEqual(['pha cốt cacao', 'cho nguyên liệu vào máy xay', 'xay và rót ra ly', 'trang trí và thưởng thức']);
    expect(p.scenes.map((s) => s.order_index)).toEqual([0, 1, 2, 3]);
    expect(p.scenes[0]!.upload_files).toEqual(['2.png', 'MOCKUP-STICK-front.png']);
    expect(p.scenes[1]!.upload_files).toEqual([]);
    expect(p.scenes[3]!.upload_files).toEqual(['2.png']);
    expect(p.scenes[0]!.first_frame_desc).toMatch(/^toàn cảnh mặt bếp sáng/);
    expect(p.brief.startsWith('# Video Cacao Actiso Plus')).toBe(true);
    expect(p.brief).not.toContain('## C1');
    expect(p.style_lock).toContain('Nắng sớm từ cửa sổ phía sau bên trái');
    expect(p.style_lock).not.toContain('## ');
    for (const s of p.scenes) assertPromptVerbatim(PROMPTS_MD, s); // ném lỗi nếu sai
  });

  it('prompt giữ nguyên dòng trống, dấu cách cuối dòng và xuống dòng CRLF; chỉ bỏ newline sát hai dấu ```', () => {
    const body = ['Style: a  ', '', 'Shot 1: x', '', ''].join('\r\n') + 'last line';
    const md = `intro\r\n\r\n## C1: tiêu đề (cảnh 1)\r\n\r\n**Upload:** không có ảnh tham chiếu.\r\n\r\n**Khung đầu:** mô tả\r\n\r\n\`\`\`\r\n${body}\r\n\`\`\`\r\n`;
    const [s] = parsePromptsMarkdown(md).scenes;
    expect(s!.prompt).toBe(body);
    assertPromptVerbatim(md, s!);
  });

  it('assertPromptVerbatim bắt được prompt bị sửa dù chỉ một ký tự', () => {
    const [s] = parsePromptsMarkdown(PROMPTS_MD).scenes;
    expect(() => assertPromptVerbatim(PROMPTS_MD, { ...s!, prompt: s!.prompt + ' ' })).toThrow(/nguyên văn/);
    expect(() => assertPromptVerbatim(PROMPTS_MD, { ...s!, prompt: s!.prompt.slice(1), prompt_range: [s!.prompt_range[0] + 1, s!.prompt_range[1]] })).toThrow();
  });

  it('log.md: 9 dòng, ánh xạ kết luận → verdict, bỏ qua tiêu đề/phân cách', () => {
    const { entries, warnings } = parseLogMd(LOG_MD);
    expect(warnings).toEqual([]);
    expect(entries).toHaveLength(9);
    expect(entries.filter((e) => e.kind === 'storyboard')).toHaveLength(4);
    expect(entries.filter((e) => e.kind === 'video')).toHaveLength(5);
    const find = (clip: string, attempt: number, kind: string) => entries.find((e) => e.clip === clip && e.attempt === attempt && e.kind === kind)!;
    expect(find('C1', 1, 'video').verdict).toBe('fix_in_edit');
    expect(find('C1', 2, 'video').verdict).toBe('pass');
    expect(find('C4', 1, 'storyboard').verdict).toBe('pass'); // "Đạt sau sửa"
    expect(find('C3', 1, 'video').conclusion).toBe('Đạt (lỗi nhỏ về bọt, có thể bỏ qua khi dựng)');
  });

  it('verdictFromConclusion', () => {
    expect(verdictFromConclusion('Đạt')).toBe('pass');
    expect(verdictFromConclusion('đạt (chọn v2 thay v1)')).toBe('pass');
    expect(verdictFromConclusion('Sửa khi dựng (không tạo lại theo yêu cầu)')).toBe('fix_in_edit');
    expect(verdictFromConclusion('Tạo lại')).toBe('redo');
    expect(verdictFromConclusion('Chưa đánh giá')).toBeNull();
    expect(verdictFromConclusion('Đạt'.normalize('NFD'))).toBe('pass'); // Unicode dựng sẵn/tổ hợp đều nhận
  });
});

describe('importLegacy (ROOT tạm)', () => {
  let env: Env;
  beforeEach(async () => {
    env = await makeEnv();
    seedLegacyRoot(env.root);
  });
  afterEach(async () => {
    await env.close();
  });

  const run = (opts: LegacyImportOptions = NO_PROBE) => importLegacy(env.ctx, opts);
  const q = <T = any>(sql: string, ...args: unknown[]): T[] => env.ctx.db.prepare(sql).all(...args) as T[];

  it('nhập đúng 4 cảnh, prompt nguyên văn, 4 storyboard + 5 video + 5 lưới, 75 credit', () => {
    const s = run();
    expect(s.project).toMatchObject({ slug: 'cacao-smoothie', name: 'Cacao Actiso Plus', created: true });
    expect(s.counts).toMatchObject({ scenes: 4, storyboards: 4, videos: 5, grids: 5, refs: 2, ledger_entries: 5, comments: 1 });
    expect(s.credits).toEqual({ used: 75, reserved: 0, per_video: 15 });
    expect(s.prompts_verbatim).toBe(true);

    // prompt nguyên văn: so với cách cắt độc lập (tách theo ```), chỉ bỏ newline sát hai dấu ```
    const blocks = PROMPTS_MD.split('```').filter((_, i) => i % 2 === 1).map((b) => b.replace(/^\n/, '').replace(/\n$/, ''));
    expect(blocks).toHaveLength(4);
    const scenes = q<{ code: string; prompt: string; status: string }>('SELECT * FROM scenes ORDER BY order_index');
    expect(scenes.map((r) => r.code)).toEqual(['C1', 'C2', 'C3', 'C4']);
    scenes.forEach((r, i) => {
      expect(r.prompt).toBe(blocks[i]);
      expect(PROMPTS_MD.includes(r.prompt)).toBe(true);
      expect(r.status).toBe('done');
    });
    expect(blocks[0]!.startsWith('Style: bright morning lifestyle recipe footage')).toBe(true);
    expect(blocks[0]).toContain('Avoid the powder billowing into a cloud'); // bản gốc, chưa có kéo
    expect(blocks[0]).not.toMatch(/scissors/i); // không bịa prompt lượt 2

    // brief / style_lock
    const [p] = q<{ brief: string; style_lock: string; status: string }>('SELECT * FROM projects');
    expect(p!.brief).toBe(PROMPTS_MD.slice(0, PROMPTS_MD.indexOf('## C1:')).trim());
    expect(p!.style_lock).toContain('Mặt đá trắng ấm');
    expect(p).toMatchObject({ status: 'active' });
  });

  it('assets: đúng loại, lượt, đường dẫn tới file sẵn có; kết luận từ log.md', () => {
    run();
    const rows = q<any>(
      `SELECT s.code, a.kind, a.attempt, a.file_path, a.verdict, a.verdict_note, a.meta, a.job_id
       FROM assets a JOIN scenes s ON s.id = a.scene_id ORDER BY s.order_index, a.attempt, a.id`,
    );
    const pick = (kind: string) => rows.filter((r) => r.kind === kind).map((r) => `${r.code}#${r.attempt}`);
    expect(pick('storyboard')).toEqual(['C1#1', 'C2#1', 'C3#1', 'C4#1']);
    expect(pick('video')).toEqual(['C1#1', 'C1#2', 'C2#1', 'C3#1', 'C4#1']);
    expect(pick('grid')).toEqual(['C1#1', 'C1#2', 'C2#1', 'C3#1', 'C4#1']);
    for (const r of rows) {
      expect(r.job_id).toBeNull();
      expect(fs.existsSync(path.join(env.root, r.file_path))).toBe(true); // trỏ đúng file có sẵn (không copy)
      expect(r.file_path.startsWith('output/cacao-smoothie/')).toBe(true);
    }
    const byKey = (code: string, kind: string, attempt: number) => rows.find((r) => r.code === code && r.kind === kind && r.attempt === attempt);
    expect(byKey('C1', 'video', 1)!.file_path).toBe('output/cacao-smoothie/video/C1_v1.mp4');
    expect(byKey('C1', 'grid', 2)!.file_path).toBe('output/cacao-smoothie/video/C1_v2_grid.jpg');
    expect(byKey('C1', 'storyboard', 1)!.file_path).toBe('output/cacao-smoothie/storyboard/C1_storyboard.png');

    expect(byKey('C1', 'video', 1)).toMatchObject({ verdict: 'fix_in_edit' });
    expect(byKey('C1', 'video', 1)!.verdict_note).toContain('CRILIO ASOY');
    expect(JSON.parse(byKey('C1', 'video', 1)!.meta)).toMatchObject({
      legacy_conclusion: 'Sửa khi dựng (không tạo lại theo yêu cầu: 1 video/cảnh)',
    });
    expect(JSON.parse(byKey('C1', 'video', 1)!.meta).legacy_type).toMatch(/^video \(Flow Omni 1\.1 Flash/);
    expect(byKey('C1', 'video', 2)).toMatchObject({ verdict: 'pass' });
    expect(byKey('C2', 'video', 1)).toMatchObject({ verdict: 'pass' });
    expect(byKey('C3', 'video', 1)).toMatchObject({ verdict: 'pass' });
    expect(byKey('C4', 'storyboard', 1)).toMatchObject({ verdict: 'pass' });
    expect(JSON.parse(byKey('C4', 'storyboard', 1)!.meta).legacy_conclusion).toBe('Đạt sau sửa');
    expect(byKey('C1', 'grid', 1)!.verdict).toBeNull(); // lưới không có kết luận riêng
  });

  it('refs được copy vào refs/<projectId>/, nhãn đúng, upload_refs và use_prev_storyboard đúng', () => {
    run();
    const [proj] = q<{ id: number }>('SELECT id FROM projects');
    const refs = q<any>('SELECT * FROM project_refs ORDER BY order_index');
    expect(refs.map((r) => r.label)).toEqual(['Hộp 3/4', 'Gói stick (2 mặt)']);
    expect(refs.map((r) => r.file_path)).toEqual([`refs/${proj!.id}/2.png`, `refs/${proj!.id}/MOCKUP-STICK.png`]);
    expect(fs.readFileSync(path.join(env.root, refs[0].file_path))).toEqual(PNG_BYTES);
    expect(fs.readFileSync(path.join(env.root, refs[1].file_path))).toEqual(STICK_PNG);
    expect(fs.existsSync(path.join(env.root, 'MOCKUP_BOX/2.png'))).toBe(true); // nguồn còn nguyên
    const sc = q<any>('SELECT code, upload_refs, use_prev_storyboard, first_frame_desc FROM scenes ORDER BY order_index');
    const [box, stick] = [refs[0].id, refs[1].id];
    expect(sc.map((r) => JSON.parse(r.upload_refs))).toEqual([[box, stick], [], [], [box]]);
    expect(sc.map((r) => r.use_prev_storyboard)).toEqual([0, 1, 1, 1]);
    expect(sc[3].first_frame_desc).toBe('cận từ trên xuống mặt bọt sinh tố trong ly cao, tay chuẩn bị rắc yến mạch.');
  });

  it('video được chọn: C1 = v2, C2–C4 = v1; prompt version 1 cho mọi cảnh; sổ cái −15 mỗi video', () => {
    const s = run();
    expect(s.scenes.map((x) => [x.code, x.status, x.attempts_used, x.selected_attempt, x.prompt_version])).toEqual([
      ['C1', 'done', 2, 2, 1],
      ['C2', 'done', 1, 1, 1],
      ['C3', 'done', 1, 1, 1],
      ['C4', 'done', 1, 1, 1],
    ]);
    const sel = q<any>(
      'SELECT s.code, a.attempt FROM scenes s JOIN assets a ON a.id = s.selected_video_id ORDER BY s.order_index',
    );
    expect(sel.map((r) => `${r.code}:v${r.attempt}`)).toEqual(['C1:v2', 'C2:v1', 'C3:v1', 'C4:v1']);
    const ver = q<any>('SELECT * FROM scene_prompt_versions');
    expect(ver).toHaveLength(4);
    expect(ver.every((v) => v.version === 1 && v.created_by === 'claude')).toBe(true);
    const led = q<any>('SELECT * FROM credit_ledger ORDER BY id');
    expect(led.map((l) => l.delta)).toEqual([-15, -15, -15, -15, -15]);
    expect(led.map((l) => l.note)).toContain('Nhập từ log.md: C1 lượt 1');
    expect(led.every((l) => l.job_id === null && l.scene_id !== null)).toBe(true);
  });

  it('events: tạo cảnh, chuyển trạng thái (force) có lý do "Nhập dữ liệu cũ"', () => {
    run();
    const st = q<any>("SELECT message FROM events WHERE type = 'scene.status' ORDER BY id");
    expect(st.map((e) => e.message)).toEqual([
      'C1: draft → done (Nhập dữ liệu cũ)',
      'C2: draft → done (Nhập dữ liệu cũ)',
      'C3: draft → done (Nhập dữ liệu cũ)',
      'C4: draft → done (Nhập dữ liệu cũ)',
    ]);
    expect(q("SELECT 1 FROM events WHERE type = 'scene.created'")).toHaveLength(4);
    expect(q("SELECT 1 FROM events WHERE type = 'project.created'")).toHaveLength(1);
  });

  it('thiếu prompt C1 lượt 2: tạo comment ghi chú (không bịa prompt) + cảnh báo', () => {
    const s = run();
    const c = q<any>('SELECT c.*, s.code, a.attempt AS asset_attempt FROM comments c JOIN scenes s ON s.id = c.scene_id LEFT JOIN assets a ON a.id = c.asset_id');
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ code: 'C1', author: 'claude', action: 'note', resolved: 0, timecode: null, asset_attempt: 2 });
    expect(c[0].body).toBe(
      'Lượt 2 dùng bản prompt có kéo (theo log.md) nhưng nguyên văn chưa được lưu; hãy dán lại bằng trình sửa prompt hoặc đặt vào legacy/C1_prompt_v2.txt rồi chạy lại import.',
    );
    expect(s.warnings.some((w) => w.includes('C1') && w.includes('legacy/C1_prompt_v2.txt'))).toBe(true);
    expect(s.warnings.some((w) => w.includes('MOCKUP-STICK-front.png'))).toBe(true);
    expect(q('SELECT 1 FROM scene_prompt_versions v JOIN scenes s ON s.id = v.scene_id WHERE s.code = ?', 'C1')).toHaveLength(1);
  });

  it('chạy lần hai: không tạo thêm bản ghi nào ở bất kỳ bảng nào', () => {
    const first = run();
    expect(sum(first.created)).toBeGreaterThan(40);
    const before = tableCounts(env.ctx);
    const dump = () => JSON.stringify(['assets', 'scenes', 'credit_ledger', 'comments', 'events', 'scene_prompt_versions', 'project_refs', 'projects'].map((t) => q(`SELECT * FROM ${t} ORDER BY id`)));
    const snapshot = dump();
    const second = run();
    expect(tableCounts(env.ctx)).toEqual(before);
    expect(sum(second.created)).toBe(0);
    expect(second.project.created).toBe(false);
    expect(dump()).toBe(snapshot); // cả nội dung hàng cũng không đổi
    expect(second.credits).toEqual(first.credits);
    expect(second.counts).toEqual(first.counts);
    expect(run().created).toEqual(second.created); // lần ba
    expect(fs.readdirSync(path.join(env.root, 'refs', String(first.project.id)))).toEqual(['2.png', 'MOCKUP-STICK.png']); // không sinh file -2
  });

  it('không đụng vào dữ liệu cũ (output/cacao-smoothie, MOCKUP_BOX, file md ở gốc)', () => {
    const watched = [path.join(env.root, 'output'), path.join(env.root, 'MOCKUP_BOX')];
    const before = watched.map(fingerprint);
    const md = fs.readFileSync(path.join(env.root, 'cacao-smoothie-prompts.md'), 'utf8');
    run();
    run();
    expect(watched.map(fingerprint)).toEqual(before);
    expect(fs.readFileSync(path.join(env.root, 'cacao-smoothie-prompts.md'), 'utf8')).toBe(md);
  });

  it('API nhất quán sau khi nhập: credit, scene detail, danh sách cảnh, dự án, ledger, /files có Range', async () => {
    const s = run();
    const user = userClient(env.app);
    const pid = s.project.id;

    const b = (await user.get(`/api/projects/${pid}/budget`)).body;
    expect(b).toMatchObject({ used: 75, reserved: 0, credit_per_video: 15, max_attempts: 2 });
    expect(b).not.toHaveProperty('remaining');
    expect(b.scenes.map((x: any) => [x.code, x.attempts_used, x.max_attempts])).toEqual([
      ['C1', 2, 2],
      ['C2', 1, 2],
      ['C3', 1, 2],
      ['C4', 1, 2],
    ]);

    const list = (await user.get(`/api/projects/${pid}/scenes`)).body;
    expect(list.map((x: any) => x.code)).toEqual(['C1', 'C2', 'C3', 'C4']);
    const c1 = (await user.get(`/api/scenes/${list[0].id}`)).body;
    expect(c1).toMatchObject({ code: 'C1', status: 'done', attempts_used: 2, max_attempts: 2, storyboard_count: 1, video_count: 2, prompt_version: 1, open_comments: 1 });
    expect(c1.assets.map((a: any) => `${a.kind}#${a.attempt}`)).toEqual(['storyboard#1', 'video#1', 'grid#1', 'video#2', 'grid#2']);
    const v2 = c1.assets.find((a: any) => a.kind === 'video' && a.attempt === 2);
    expect(c1.selected_video_id).toBe(v2.id);
    expect(c1.video.id).toBe(v2.id);
    expect(c1.grid.attempt).toBe(2);
    expect(v2.url).toBe('/files/output/cacao-smoothie/video/C1_v2.mp4');
    expect(c1.assets.find((a: any) => a.kind === 'video' && a.attempt === 1).verdict).toBe('fix_in_edit');
    expect(v2.verdict).toBe('pass');
    expect(c1.prompt_versions).toHaveLength(1);
    expect(c1.prompt_versions[0].prompt).toBe(c1.prompt);
    expect(c1.comments).toHaveLength(1);
    expect(c1.comments[0]).toMatchObject({ author: 'claude', action: 'note', resolved: false, asset_id: v2.id });
    expect(c1.video_block).toMatchObject({ code: 'ATTEMPTS_EXCEEDED', message: 'Cảnh C1 đã dùng 2/2 lượt' });
    expect(c1.project).toMatchObject({ slug: 'cacao-smoothie', credit_per_video: 15, max_attempts_per_scene: 2 });
    expect(c1.upload_refs).toHaveLength(2);
    expect(c1.next_scene_id).toBe(list[1].id);
    const c2 = (await user.get(`/api/scenes/${list[1].id}`)).body;
    expect(c2.video_block).toBeNull(); // C2 còn 1 lượt

    const proj = (await user.get(`/api/projects/${pid}`)).body;
    expect(proj).toMatchObject({ scene_count: 4, done_count: 4, status: 'active', credits_used: 75, credits_reserved: 0 });
    expect(proj.refs.map((r: any) => r.label)).toEqual(['Hộp 3/4', 'Gói stick (2 mặt)']);
    expect((await user.get(proj.refs[0].url)).status).toBe(200);

    const ledger = (await user.get(`/api/projects/${pid}/ledger`)).body;
    expect(ledger.totals).toEqual({ used: 75, reserved: 0 });
    expect(ledger.entries.map((e: any) => e.cumulative_used)).toEqual([15, 30, 45, 60, 75]);
    const csv = (await user.get(`/api/projects/${pid}/ledger.csv`)).raw;
    expect(csv).toContain('Nhập từ log.md: C1 lượt 2');

    // log.md sinh từ assets giữ nguyên chữ gốc của log cũ
    const logMd = (await user.get(`/api/projects/${pid}/log.md`)).raw;
    expect(logMd).toContain('| C1 | 2 | video (theo yêu cầu: cắt gói bằng kéo;');
    expect(logMd).toContain('| Đạt (chọn v2 thay v1) |');

    // file tĩnh: Range → 206
    const r = await env.app.inject({ method: 'GET', url: v2.url, headers: { host: 'localhost:8787', range: 'bytes=0-3' } });
    expect(r.statusCode).toBe(206);
    expect(r.headers['content-range']).toMatch(/^bytes 0-3\//);
    expect(r.rawPayload).toHaveLength(4);
  });

  it('sau khi nhập, luồng thường vẫn chạy: tạo lại video C2 (lượt 2), C1 bị từ chối vì đủ lượt', async () => {
    const s = run();
    const user = userClient(env.app);
    const worker = client(env.app, { authorization: 'Bearer test-worker-token' });
    const list = (await user.get(`/api/projects/${s.project.id}/scenes`)).body;
    const [c1, c2] = [list[0], list[1]];

    const bad = await user.post(`/api/scenes/${c1.id}/approve`, { stage: 'video' });
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe('ATTEMPTS_EXCEEDED');
    expect(bad.body.error.message).toBe('Cảnh C1 đã dùng 2/2 lượt');

    const ok = await user.post(`/api/scenes/${c2.id}/approve`, { stage: 'video' });
    expect(ok.status).toBe(200);
    expect((await user.get(`/api/projects/${s.project.id}/budget`)).body).toMatchObject({ used: 75, reserved: 15 });
    const job = await claim({ worker } as any, 'w1');
    expect(job.type).toBe('video');
    expect(job.payload.attempt).toBe(2);
    expect(job.payload.upload_files).toEqual(['output/cacao-smoothie/storyboard/C2_storyboard.png']);
    expect(job.payload.output.video_path).toBe('output/cacao-smoothie/video/C2_v2.mp4');
    expect(job.payload.requeued).toBe(false);

    // storyboard C3 dùng lại storyboard C1 làm ảnh cuối (use_prev_storyboard)
    await worker.post(`/api/worker/jobs/${job.id}/fail`, { error: 'thử', code: 'OTHER' });
    const c3 = list[2];
    expect((await user.post(`/api/scenes/${c3.id}/approve`, { stage: 'storyboard' })).status).toBe(200);
    const sb = await claim({ worker } as any, 'w1');
    expect(sb.payload.upload_files).toEqual(['output/cacao-smoothie/storyboard/C1_storyboard.png']);
    expect(sb.payload.attempt).toBe(2);
    expect(sb.payload.output.storyboard_path).toBe('output/cacao-smoothie/storyboard/C3_storyboard_v2.png');
  });

  it('có legacy/C1_prompt_v2.txt: nhập làm version 2 (user), thành prompt hiện tại, không có comment ghi chú', async () => {
    const v2 = 'Style: bright morning ... (bản có kéo do người dùng dán lại)\n\nShot 1: the scissors cut across the top of the stick.\n';
    writeFile(env.root, 'legacy/C1_prompt_v2.txt', v2);
    const s = run();
    expect(s.counts).toMatchObject({ prompt_versions: 5, comments: 0 });
    expect(s.warnings.some((w) => w.includes('legacy/C1_prompt_v2.txt'))).toBe(false);
    const user = userClient(env.app);
    const list = (await user.get(`/api/projects/${s.project.id}/scenes`)).body;
    const c1 = (await user.get(`/api/scenes/${list[0].id}`)).body;
    expect(c1.prompt_version).toBe(2);
    expect(c1.prompt).toBe(v2.trimEnd());
    expect(c1.prompt_versions.map((v: any) => [v.version, v.created_by])).toEqual([
      [1, 'claude'],
      [2, 'user'],
    ]);
    expect(c1.prompt_versions[1].reason).toMatch(/^video \(theo yêu cầu: cắt gói bằng kéo; prompt sửa:/); // lấy từ cột loại của log.md
    expect(c1.prompt_versions[0].prompt).toContain('Avoid the powder billowing into a cloud'); // v1 vẫn là bản gốc
    expect(c1.comments).toHaveLength(0);
    // các cảnh khác không đổi; chạy lại không tạo thêm hàng
    expect((await user.get(`/api/scenes/${list[1].id}`)).body.prompt_version).toBe(1);
    const before = tableCounts(env.ctx);
    expect(sum(run().created)).toBe(0);
    expect(tableCounts(env.ctx)).toEqual(before);
  });

  it('thêm legacy/C1_prompt_v2.txt sau lần nhập đầu: chạy lại thêm đúng version 2 và tự đóng comment ghi chú', async () => {
    const first = run();
    expect(first.counts).toMatchObject({ prompt_versions: 4, comments: 1 });
    writeFile(env.root, 'legacy/C1_prompt_v2.txt', 'prompt v2 do người dùng dán\r\n');
    const second = run();
    expect(second.created).toMatchObject({ scene_prompt_versions: 1, comments: 0, assets: 0, credit_ledger: 0, scenes: 0 });
    const [c] = q<any>('SELECT resolved FROM comments');
    expect(c.resolved).toBe(1);
    const [sc] = q<any>("SELECT prompt FROM scenes WHERE code = 'C1'");
    expect(sc.prompt).toBe('prompt v2 do người dùng dán');
    expect(sum(run().created)).toBe(0);
  });

  it('prompt người dùng đã sửa tay không bị ghi đè khi nhập lại với file v2', async () => {
    const first = run();
    const user = userClient(env.app);
    const list = (await user.get(`/api/projects/${first.project.id}/scenes`)).body;
    const edited = await user.patch(`/api/scenes/${list[0].id}/prompt`, { prompt: 'bản người dùng tự sửa', reason: 'thử' });
    expect(edited.status).toBe(200); // cảnh done cho phép sửa tay → version 2 (user)
    writeFile(env.root, 'legacy/C1_prompt_v3.txt', 'prompt v3 từ file');
    const second = run();
    expect(second.warnings.some((w) => w.includes('đã được sửa tay'))).toBe(true);
    expect(q<any>("SELECT prompt FROM scenes WHERE code = 'C1'")[0].prompt).toBe('bản người dùng tự sửa');
    expect(q("SELECT 1 FROM scene_prompt_versions v JOIN scenes s ON s.id = v.scene_id WHERE s.code = 'C1'")).toHaveLength(3);
  });

  it('ảnh tham chiếu nhập vào có content_hash (sha256 nội dung file); chạy lại điền hash còn thiếu', () => {
    run();
    const hashOf = (rel: string) => createHash('sha256').update(fs.readFileSync(path.join(env.root, rel))).digest('hex');
    const refs = q<any>('SELECT * FROM project_refs ORDER BY id');
    expect(refs).toHaveLength(2);
    for (const r of refs) expect(r.content_hash).toBe(hashOf(r.file_path));
    env.ctx.db.prepare('UPDATE project_refs SET content_hash = NULL').run();
    run();
    for (const r of q<any>('SELECT * FROM project_refs ORDER BY id')) expect(r.content_hash).toBe(hashOf(r.file_path));
  });

  describe('bản dựng thử có sẵn → final_cut v1', () => {
    const TRIAL = `${DIR}/final/cacao-smoothie_final_v1`;
    const seedTrial = (mlt = true, contact = true) => {
      writeFile(env.root, `${TRIAL}.mp4`, 'fake-final-mp4');
      if (contact) writeFile(env.root, `${TRIAL}_contact.png`, PNG_BYTES);
      if (mlt) writeFile(env.root, `${DIR}/final/shotcut/cacao-smoothie_final_v1.mlt`, '<mlt/>');
    };
    const probeDur: LegacyImportOptions = {
      probe: (abs, kind) => (kind === 'video' ? { width: 720, height: 1280, duration_s: abs.includes('/final/') ? 38.2 : 10 } : { width: 941, height: 1672 }),
    };

    it('không có file bản thử → không đăng ký gì', () => {
      const s = run();
      expect(s.counts.final_cuts).toBe(0);
      expect(q('SELECT * FROM final_cuts')).toEqual([]);
    });

    it('đăng ký final_cut v1: ready, shotcut, user, ghi chú, EDL theo điểm cắt, selection = video đang chọn, đường dẫn 3 file, duration bằng probe', () => {
      seedTrial();
      const before = fingerprint(path.join(env.root, DIR));
      const s = run(probeDur);
      expect(s.counts.final_cuts).toBe(1);
      expect(s.created.final_cuts).toBe(1);
      const [c] = q<any>('SELECT * FROM final_cuts');
      expect(c).toMatchObject({
        version: 1,
        status: 'ready',
        renderer: 'shotcut',
        created_by: 'user',
        note: 'Bản thử Shotcut MCP, điểm cắt đặt tay (chưa qua Claude phân tích)',
        ext_key: 'legacy:cacao-smoothie:final:v1',
        video_path: 'output/cacao-smoothie/final/cacao-smoothie_final_v1.mp4',
        contact_sheet_path: 'output/cacao-smoothie/final/cacao-smoothie_final_v1_contact.png',
        project_file_path: 'output/cacao-smoothie/final/shotcut/cacao-smoothie_final_v1.mlt',
        duration_s: 38.2,
        progress: 100,
        job_id: null,
        summary: null,
      });
      // selection = video đang chọn của 4 cảnh (C1 dùng v2)
      const sel = JSON.parse(c.selection);
      expect(sel.map((x: any) => [x.code, x.attempt])).toEqual([['C1', 2], ['C2', 1], ['C3', 1], ['C4', 1]]);
      const chosen = q<any>('SELECT s.code, s.selected_video_id FROM scenes s ORDER BY s.order_index');
      expect(sel.map((x: any) => x.asset_id)).toEqual(chosen.map((r) => r.selected_video_id));
      // EDL: điểm cắt đã chốt; phần bị bỏ ghi lý do "cắt thử"
      const edl = JSON.parse(c.edl);
      expect(edl.scenes.map((x: any) => x.segments)).toEqual([[{ in_s: 0, out_s: 9.5 }], [{ in_s: 0.3, out_s: 9.6 }], [{ in_s: 0, out_s: 9.7 }], [{ in_s: 0.2, out_s: 9.8 }]]);
      expect(edl.scenes[1].removed).toEqual([{ from_s: 0, to_s: 0.3, reason: 'cắt thử' }, { from_s: 9.6, to_s: 10, reason: 'cắt thử' }]);
      expect(edl.scenes[0].removed).toEqual([{ from_s: 9.5, to_s: 10, reason: 'cắt thử' }]);
      // không ghi vào thư mục dữ liệu cũ và KHÔNG tự kích hoạt edit_plan
      expect(fingerprint(path.join(env.root, DIR))).toBe(before);
      expect(q("SELECT * FROM jobs WHERE type = 'edit_plan'")).toEqual([]);
    });

    it('chạy lặp lại không tạo thêm hàng nào; API trả bản ready, không outdated; chọn lại video không kích hoạt edit_plan', async () => {
      seedTrial();
      run(probeDur);
      const second = run(probeDur);
      expect(second.created.final_cuts).toBe(0);
      expect(sum(second.created)).toBe(0);
      expect(q('SELECT COUNT(*) AS n FROM final_cuts')[0].n).toBe(1);
      const user = userClient(env.app);
      const pid = second.project.id;
      const list = (await user.get(`/api/projects/${pid}/final-cuts`)).body;
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        version: 1,
        status: 'ready',
        outdated: false,
        video_url: '/files/output/cacao-smoothie/final/cacao-smoothie_final_v1.mp4',
        contact_sheet_url: '/files/output/cacao-smoothie/final/cacao-smoothie_final_v1_contact.png',
      });
      expect((await user.get(`/api/projects/${pid}`)).body.latest_final_cut).toMatchObject({ version: 1, status: 'ready', outdated: false, duration_s: 38.2 });
      // người dùng chọn lại cùng video cảnh C1 → vẫn không tạo edit_plan (đã có final_cut cho lựa chọn này)
      const scenes = (await user.get(`/api/projects/${pid}/scenes`)).body;
      await user.post(`/api/scenes/${scenes[0].id}/select-video`, {});
      expect(q("SELECT * FROM jobs WHERE type = 'edit_plan'")).toEqual([]);
      expect(q('SELECT COUNT(*) AS n FROM final_cuts')[0].n).toBe(1);
      expect((await user.get(`/api/projects/${pid}/log.md`)).raw).toContain('| FINAL | v1 | bản dựng (shotcut, cắt thẳng) | Bản thử Shotcut MCP');
      // file thật được phát qua /files
      expect((await user.get(list[0].video_url)).status).toBe(200);
    });

    it('chỉ có mp4 (thiếu .mlt / contact) → đăng ký với đường dẫn null; thiếu mp4 → bỏ qua; đã có bản v1 do server tạo → bỏ qua kèm cảnh báo', () => {
      seedTrial(false, false);
      run(probeDur);
      expect(q<any>('SELECT project_file_path, contact_sheet_path FROM final_cuts')[0]).toEqual({ project_file_path: null, contact_sheet_path: null });
      env.ctx.db.prepare("DELETE FROM final_cuts WHERE ext_key IS NOT NULL").run();
      env.ctx.db
        .prepare("INSERT INTO final_cuts (project_id, version, status, selection_signature, created_by, created_at) VALUES (1, 1, 'failed', 'x', 'claude', 'now')")
        .run();
      const s = run(probeDur);
      expect(s.warnings.some((w) => w.includes('đã có bản dựng v1'))).toBe(true);
      expect(q('SELECT COUNT(*) AS n FROM final_cuts')[0].n).toBe(1);
      fs.rmSync(path.join(env.root, `${TRIAL}.mp4`));
      env.ctx.db.prepare('DELETE FROM final_cuts').run();
      expect(run(probeDur).created.final_cuts).toBe(0);
    });
  });

  it('meta asset lấy từ probe (ffprobe giả): video có width/height/duration_s, ảnh có width/height', () => {
    run({
      probe: (_abs, kind) => (kind === 'video' ? { width: 720, height: 1280, duration_s: 10 } : { width: 941, height: 1672 }),
    });
    const metas = q<any>("SELECT kind, meta FROM assets WHERE kind IN ('video','storyboard') ORDER BY id");
    for (const m of metas) {
      const meta = JSON.parse(m.meta);
      if (m.kind === 'video') expect(meta).toMatchObject({ width: 720, height: 1280, duration_s: 10, legacy: true });
      else expect(meta).toMatchObject({ width: 941, height: 1672 });
      expect(meta.size_bytes).toBeGreaterThan(0);
    }
  });

  it.skipIf(!hasFfprobe())('meta bằng ffprobe thật trên ảnh PNG nhỏ', () => {
    const f = path.join(env.root, DIR, 'storyboard', 'C1_storyboard.png');
    expect(ffprobeMeta(f, 'storyboard')).toEqual({ width: 1, height: 1 });
    expect(ffprobeMeta(path.join(env.root, DIR, 'video', 'C1_v1.mp4'), 'video')).toBeNull(); // file giả không đọc được → null, không ném lỗi
  });

  it('thiếu ảnh mockup hoặc log.md: vẫn nhập được, kèm cảnh báo', () => {
    fs.rmSync(path.join(env.root, 'MOCKUP_BOX/MOCKUP-STICK.png'));
    fs.rmSync(path.join(env.root, DIR, 'log.md'));
    const s = run();
    expect(s.counts).toMatchObject({ scenes: 4, videos: 5, refs: 1, comments: 0 });
    expect(s.warnings.some((w) => w.includes('log.md'))).toBe(true);
    expect(s.warnings.some((w) => w.includes('Gói stick (2 mặt)'))).toBe(true);
    expect(q<any>("SELECT verdict FROM assets WHERE kind = 'video'").every((r) => r.verdict === null)).toBe(true);
    expect(q<any>("SELECT status, selected_video_id FROM scenes ORDER BY order_index").map((r) => r.status)).toEqual(['done', 'done', 'done', 'done']);
    // video được chọn khi không có log: bản mới nhất → C1 chọn v2
    expect(q<any>('SELECT a.attempt FROM scenes s JOIN assets a ON a.id = s.selected_video_id WHERE s.code = ?', 'C1')[0].attempt).toBe(2);
  });

  it('báo lỗi rõ ràng khi sai --dir hoặc thiếu file prompt', () => {
    expect(() => run({ dir: '..' })).toThrow(/thư mục con trực tiếp/);
    expect(() => run({ dir: 'output/khong-co' })).toThrow(/Không thấy thư mục/);
    fs.rmSync(path.join(env.root, 'cacao-smoothie-prompts.md'));
    expect(() => run()).toThrow(/Không thấy file prompt/);
    expect(tableCounts(env.ctx).projects).toBe(0); // lỗi trước khi ghi gì
  });

  it('scanLegacyFiles nhận storyboard lượt n ≥ 2 và bỏ qua file lạ', () => {
    writeFile(env.root, `${DIR}/storyboard/C2_storyboard_v2.png`, PNG_BYTES);
    writeFile(env.root, `${DIR}/video/ghi-chu.txt`, 'x');
    const files = scanLegacyFiles(env.root, path.join(env.root, DIR));
    expect(files.filter((f) => f.kind === 'storyboard').map((f) => `${f.code}#${f.attempt}`)).toEqual(['C1#1', 'C2#1', 'C2#2', 'C3#1', 'C4#1']);
    expect(files.some((f) => f.rel.endsWith('ghi-chu.txt'))).toBe(false);
    const s = run();
    expect(s.counts.storyboards).toBe(5);
    expect(s.warnings.some((w) => w.includes('C2_storyboard_v2.png') && w.includes('log.md'))).toBe(true);
  });

  it('formatSummary in đủ thông tin chính', () => {
    const text = formatSummary(run(), 'data/test.db');
    expect(text).toContain('4 cảnh, 4 storyboard, 5 video, 5 ảnh lưới');
    expect(text).toContain('đã dùng 75');
    expect(text).toContain('đặt trước 0 (15 credit/video)');
    expect(text).not.toContain('còn lại');
    expect(text).toContain('C1: done, lượt 2/2, video chọn v2');
    expect(text).toContain('Cảnh báo (2)');
  });
});

describe('CLI npm run import:legacy', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'autovideo-import-cli-'));
    seedLegacyRoot(root);
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const tsx = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
  const cli = path.join(REPO_ROOT, 'server', 'src', 'scripts', 'import-legacy.ts');
  const exec = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(tsx, [cli, ...args], {
      encoding: 'utf8',
      cwd: path.join(REPO_ROOT, 'server'),
      env: { ...process.env, ROOT_DIR: root, DB_PATH: 'data/env.db', WORKER_TOKEN: 'x', ...env },
      timeout: 60_000,
    });

  it('--db / --dir, in tóm tắt, chạy hai lần không tạo thêm bản ghi', () => {
    const a = exec(['--db', 'data/cli.db']);
    expect(a.stderr).toBe('');
    expect(a.status).toBe(0);
    expect(a.stdout).toContain('"Cacao Actiso Plus"');
    expect(a.stdout).toContain('4 cảnh, 4 storyboard, 5 video, 5 ảnh lưới, 2 ảnh tham chiếu');
    expect(a.stdout).toContain('đã dùng 75, đặt trước 0 (15 credit/video)');
    expect(a.stdout).not.toContain('còn lại');
    expect(a.stdout).not.toContain('ngân sách');
    expect(a.stdout).toContain('Cảnh báo');
    expect(fs.existsSync(path.join(root, 'data', 'cli.db'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'data', 'env.db'))).toBe(false); // --db thắng DB_PATH

    const b = exec(['--db=data/cli.db', '--dir', 'output/cacao-smoothie']);
    expect(b.status).toBe(0);
    expect(b.stdout).toContain('không có (dữ liệu đã được nhập trước đó)');
    expect(fs.readdirSync(path.join(root, 'data', 'backup')).length).toBe(1); // sao lưu trước lần chạy thứ hai

    const db = new Database(path.join(root, 'data', 'cli.db'), { readonly: true });
    try {
      expect((db.prepare('SELECT COUNT(*) AS n FROM assets').get() as { n: number }).n).toBe(14);
      expect((db.prepare('SELECT COUNT(*) AS n FROM scenes').get() as { n: number }).n).toBe(4);
    } finally {
      db.close();
    }
  });

  it('mặc định lấy DB_PATH từ môi trường; tham số sai → mã thoát 1 kèm thông báo', () => {
    expect(exec([]).status).toBe(0);
    expect(fs.existsSync(path.join(root, 'data', 'env.db'))).toBe(true);
    // --budget không còn dùng: cảnh báo rồi bỏ qua (kể cả giá trị không hợp lệ), vẫn nhập bình thường
    const budget = exec(['--budget', 'abc']);
    expect(budget.status).toBe(0);
    expect(budget.stderr).toContain('--budget không còn dùng');
    expect(exec(['--budget=90']).stderr).toContain('--budget không còn dùng');
    const unknown = exec(['--foo']);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('Tham số lạ');
    const missing = exec(['--dir', 'output/khong-co']);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('Không thấy thư mục');
  });
});
