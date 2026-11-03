import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeLanEnv, type LanEnv } from './helpers-lan.js';
import { FIXTURE_INDEX } from './helpers-html-engine.js';
import { buildTranscript } from '../src/services/clips/transcript.js';
import { displayWords, groupWords } from '../src/services/clips/captions.js';
import { startVoice, voiceSnapshot, voiceView, editVoice, cancelVoice } from '../src/services/html/voice.js';
import { withVoice } from '../src/services/html/voice-overlay.js';
import { createComposingVersion, createVariableVersion } from '../src/services/html/versions.js';
import { installHtmlValidator, lintComposition } from '../src/services/html/engine/index.js';
import { getJobRow } from '../src/services/repo.js';
import { stageVersionFiles, finalizeVersion } from '../src/services/html/compose-lifecycle.js';
import { validateManifest, writeStaging } from '../src/services/html/safe-path.js';
import { getVersionById } from '../src/services/html/repo.js';
import { imageForAnalysis, saveImageDescription } from '../src/services/html/asset-analysis.js';
import { defaultMigrations, openDb, runMigrations } from '../src/db/index.js';
import { PNG_BYTES } from './helpers.js';
import { snapshotVersionAssets } from '../src/services/html/assets.js';

const raw = { model: 'fake-asr', text: 'Xin chào Vinh Gia', duration: 2, segments: [], words: [{ word: 'xin', start: .1, end: .4 }, { word: 'chào', start: .4, end: .8 }, { word: 'Vinh', start: 1, end: 1.4 }, { word: 'Gia', start: 1.4, end: 1.9 }] };
const transcript = () => buildTranscript(raw, { contentHash: 'voice-hash', durationHintS: 2 });
const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
let L: LanEnv;
let id: number;
beforeEach(async () => {
  L = await makeLanEnv({ config: { ffmpegPath: ffmpeg, workerMode: 'managed', managedJobTypes: ['html_compose'] } });
  id = (await L.client().post('/lan/api/html-projects', { name: 'Voice', duration_s: 2, aspect: '9:16', quality: '720p' })).body.id;
});
afterEach(async () => { vi.restoreAllMocks(); await L.close(); });
function asset(kind: 'audio' | 'image' = 'audio', duration = 2) {
  const file = path.join(L.env.root, kind === 'audio' ? `test-${duration}.wav` : 'image.png');
  if (kind === 'audio') execFileSync(ffmpeg, ['-y','-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t','2',file], { windowsHide: true });
  else fs.writeFileSync(file, PNG_BYTES);
  return Number(L.env.ctx.db.prepare(`INSERT INTO html_assets(project_id,original_name,stored_path,content_hash,kind,media_type,bytes,duration_s,has_audio,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, path.basename(file), path.basename(file), `${kind}-${duration}`, kind, kind === 'audio' ? 'audio/wav' : 'image/png', fs.statSync(file).size, kind === 'audio' ? duration : null, kind === 'audio' ? 1 : 0, L.env.ctx.now()).lastInsertRowid);
}
async function readyVoice() {
  const a = asset();
  startVoice(L.env.ctx, id, a, true, async () => raw);
  await L.env.ctx.finalRender!.idle();
  expect(voiceView(L.env.ctx, id)?.status).toBe('ready');
  return a;
}

describe('voice HTML', () => {
  it('nhận dạng dùng ASR timestamp, sửa chữ không đổi thời gian; chặn file quá dài và asset khác dự án', async () => {
    const a = await readyVoice();
    expect(voiceSnapshot(L.env.ctx, id)?.transcript.words.map((w) => [w.start, w.end])).toEqual(raw.words.map((w) => [w.start, w.end]));
    const changed = editVoice(L.env.ctx, id, [{ i: 0, w: 'Xin' }], false);
    expect(changed?.transcript?.words[0]).toMatchObject({ w: 'Xin', start: .1, end: .4 });
    expect(changed?.captions).toBe(false);
    const c = L.client();
    expect((await c.del(`/lan/api/html-projects/${id}/assets/${a}`)).status).toBe(409);
    expect((await c.patch(`/lan/api/html-projects/${id}/voice`, { words: [{ i: 999, w: 'x' }], captions: true })).status).toBe(400);
    expect(() => startVoice(L.env.ctx, id, asset('audio', 421), true, async () => raw)).toThrow(/420/);
    const other = (await c.post('/lan/api/html-projects', { name: 'Khác' })).body.id;
    expect((await c.post(`/lan/api/html-projects/${other}/voice`, { asset_id: a })).status).toBe(404);
  });
  it('hủy ASR đang chạy; không ghi kết quả trễ hoặc khóa dự án sau khi hủy', async () => {
    const a = asset();
    let entered!: () => void;
    const started = new Promise<void>((r) => { entered = r; });
    startVoice(L.env.ctx, id, a, true, async (_file, signal) => { entered(); await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true })); return raw; });
    await started;
    cancelVoice(L.env.ctx, id);
    await L.env.ctx.finalRender!.idle();
    expect(voiceView(L.env.ctx, id)?.status).toBe('cancelled');
    expect(voiceView(L.env.ctx, id)?.transcript).toBeNull();
    expect((await L.client().del(`/lan/api/html-projects/${id}`)).status).toBe(200);
  });
  it.each([false, true])('callback cũ bắt đầu sau hủy/đổi file không ghi đè hàng mới (chọn lại cùng file: %s)', async (sameFile) => {
    const ctx = L.env.ctx;
    const callbacks: ((abort: AbortController) => Promise<void>)[] = [];
    vi.spyOn(ctx.finalRender!, 'enqueueHtmlTask').mockImplementation((_kind, _id, _lan, fn) => { callbacks.push(fn); });
    const transcribe = vi.fn(async () => raw);
    const first = asset();
    startVoice(ctx, id, first, true, transcribe);
    cancelVoice(ctx, id);
    await callbacks[0]!(new AbortController());
    expect(voiceView(ctx, id)?.status).toBe('cancelled');
    expect(transcribe).not.toHaveBeenCalled();
    const second = sameFile ? first : asset('audio', 3);
    startVoice(ctx, id, second, true, transcribe);
    await callbacks[0]!(new AbortController());
    expect(voiceView(ctx, id)).toMatchObject({ status: 'queued', asset_id: second });
    expect(transcribe).not.toHaveBeenCalled();
    await callbacks[1]!(new AbortController());
    expect(voiceView(ctx, id)).toMatchObject({ status: 'ready', asset_id: second });
    expect(transcribe).toHaveBeenCalledOnce();
  });
  it.each([false, true])('kết quả/lỗi ASR muộn không ghi vào request mới (lỗi: %s)', async (failure) => {
    const ctx = L.env.ctx;
    const a = asset();
    startVoice(ctx, id, a, true, async () => {
      ctx.db.prepare("UPDATE html_voice SET request_id='replacement',status='queued' WHERE project_id=?").run(id);
      if (failure) throw new Error('kết quả cũ');
      return raw;
    });
    await ctx.finalRender!.idle();
    expect(voiceView(ctx, id)).toMatchObject({ status: 'queued', error: null, transcript: null });
  });
  it('snapshot lời đọc độc lập phiên bản; overlay qua lint thật, sửa biến không nhân đôi audio/caption', async () => {
    const voiceAsset = await readyVoice();
    const ctx = L.env.ctx;
    const created = createComposingVersion(ctx, { projectId: id, prompt: 'demo', createdBy: 'ai' });
    const voice = voiceSnapshot(ctx, id)!;
    const files = [{ path: 'index.html', content: FIXTURE_INDEX.replace(/<img\b[^>]*>/g, '') }];
    const decorated = withVoice(files, voice, '9:16');
    expect(withVoice(decorated, voice, '9:16')).toEqual(decorated);
    const expectedGroups = groupWords(displayWords(voice.transcript, 0, voice.transcript.words.length - 1, null), 'highlight');
    expect(decorated[0]!.content.match(/class="clip hv-voice-caption"/g)).toHaveLength(expectedGroups.flat().length);
    expect(decorated[0]!.content).toContain('data-start="0.1"');
    const tmp = path.join(L.env.root, 'site');
    writeStaging(tmp, validateManifest(decorated));
    snapshotVersionAssets(ctx, created.version.id, tmp);
    const report = await lintComposition(tmp, { aspect: '9:16', durationS: 2 });
    expect(report.errors).toEqual([]);
    installHtmlValidator();
    // Không chạy job AI: phiên bản user-validating cho đường công bố thật.
    ctx.db.prepare("UPDATE html_versions SET status='validating' WHERE id=?").run(created.version.id);
    await stageVersionFiles(ctx, created.version.id, null, { files, variables: [] });
    ctx.tx(() => finalizeVersion(ctx, created.version.id, null));
    cancelVoice(ctx, id, true);
    expect((await L.client().del(`/lan/api/html-projects/${id}/assets/${voiceAsset}`)).status).toBe(200);
    const before = getVersionById(ctx, created.version.id).voice_json;
    ctx.db.prepare('UPDATE html_project_meta SET duration_s=10 WHERE project_id=?').run(id);
    const edit = await createVariableVersion(ctx, { projectId: id, parentId: created.version.id, values: {}, idempotencyKey: 'voice-edit-test' });
    expect(edit.version.voice_json).toBe(before);
    const content = fs.readFileSync(path.join(ctx.config.rootDir, edit.version.files_dir!, 'index.html'), 'utf8');
    expect(content.match(/id="hv-voice"/g)).toHaveLength(1);
    expect(content).toContain('data-duration="2"');
    const revision = createComposingVersion(ctx, { projectId: id, parentId: created.version.id, prompt: 'Sửa bố cục' });
    const revisionPayload = JSON.parse(getJobRow(ctx, revision.version.compose_job_id!).payload);
    expect(revisionPayload.spec.duration_s).toBe(2);
    expect(revisionPayload.assets.find((a: { id: number }) => a.id === voiceAsset)).toBeDefined();
    expect(ctx.db.pragma('foreign_key_check')).toEqual([]);
    expect(ctx.db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
  });
  it('cache mô tả ảnh thuộc snapshot job; chặn ảnh không thuộc job', async () => {
    const a = asset('image');
    const v = createComposingVersion(L.env.ctx, { projectId: id, prompt: 'test' }).version;
    const job = getJobRow(L.env.ctx, v.compose_job_id!);
    const desc = { summary: 'Hộp sản phẩm', text: '110ml', details: 'Không chắc dung tích', uncertain: true };
    expect(saveImageDescription(L.env.ctx, job, a, desc)).toEqual({ description: desc });
    expect(await imageForAnalysis(L.env.ctx, job, a)).toEqual({ description: desc });
    expect(() => saveImageDescription(L.env.ctx, job, asset('image'), desc)).toThrow(/snapshot/);
    expect(() => saveImageDescription(L.env.ctx, job, a, { summary: '' })).toThrow();
  });
  it('hủy tác vụ còn chờ giải phóng khóa dự án; đổi voice trong lúc tác vụ cũ dừng không xóa tác vụ mới', async () => {
    const ctx = L.env.ctx;
    const first = asset();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    for (let i = 0; i < ctx.finalRender!.concurrency; i++) ctx.finalRender!.enqueueHtmlTask('html-capture', `held-${i}`, true, async () => held);
    try {
      startVoice(ctx, id, first, true, async () => raw);
      expect(voiceView(ctx, id)?.status).toBe('queued');
      cancelVoice(ctx, id, true);
      expect(voiceView(ctx, id)).toBeNull();
      startVoice(ctx, id, first, true, async () => raw);
    } finally { release(); }
    await ctx.finalRender!.idle();
    expect(voiceView(ctx, id)?.status).toBe('ready');
  });
  it('migration 017 nâng DB 016 giữ dữ liệu HTML cũ và foreign key', () => {
    const db = openDb(':memory:');
    try {
      const all = defaultMigrations();
      runMigrations(db, all.filter((m) => m.version < '017_html_voice'));
      db.prepare("INSERT INTO projects(slug,name,kind,created_at,updated_at) VALUES('old','Cũ','html','x','x')").run();
      db.prepare("INSERT INTO html_project_meta(project_id,aspect,duration_s,quality,created_at) VALUES(1,'9:16',2,'720p','x')").run();
      const before = db.prepare('SELECT * FROM html_project_meta').all();
      expect(runMigrations(db, all)).toEqual(['017_html_voice', '018_html_asset_review', '019_html_long_video', '020_html_segments']);
      expect(db.prepare('SELECT * FROM html_project_meta').all()).toEqual(before);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    } finally { db.close(); }
  });
  it('phụ đề escape chữ người dùng và không chèn audio AI trùng voice', () => {
    const voice = { asset_id: 1, path: 'assets/u/1.wav', duration_s: 2, captions: true, transcript: transcript() };
    voice.transcript.words[0]!.w = '<script>alert(1)</script>';
    const html = withVoice([{ path: 'index.html', content: FIXTURE_INDEX }], voice, '9:16')[0]!.content;
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(() => withVoice([{ path: 'index.html', content: FIXTURE_INDEX.replace('</body>', '<audio src="other.wav"></audio></body>') }], voice, '9:16')).toThrow(/tự chèn/);
  });
});
