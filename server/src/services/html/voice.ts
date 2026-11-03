import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AppContext } from '../../context.js';
import { AppError, conflict } from '../../lib/errors.js';
import { ffmpegOf } from '../media.js';
import { runHtmlMedia as run } from './media-task.js';
import { sttUnavailable } from '../clips/stt.js';
import { transcribeLocal } from '../clips/local-stt.js';
import { transcribeAudio, type SttVerbose } from '../clips/stt-client.js';
import { buildTranscript, type Transcript } from '../clips/transcript.js';
import { parseJson } from '../repo.js';
import { assetPathOf } from './view.js';
import { getHtmlAsset, getHtmlProject } from './repo.js';
import { HTML_MAX_TOTAL_S } from './config.js';

export interface VoiceSnapshot { asset_id: number; path: string; duration_s: number; captions: boolean; transcript: Transcript; captionsOnly?: boolean }
interface VoiceRow { asset_id: number | null; status: string; transcript_json: string | null; captions: number; error: string | null }
const tasks = new WeakMap<AppContext, Map<number, { cancel(): void }>>();
const rowOf = (ctx: AppContext, id: number) => ctx.db.prepare('SELECT * FROM html_voice WHERE project_id=?').get(id) as VoiceRow | undefined;
export function voiceView(ctx: AppContext, id: number) {
  getHtmlProject(ctx, id);
  const r = rowOf(ctx, id);
  return r ? { asset_id: r.asset_id, status: r.status, captions: !!r.captions, error: r.error, transcript: parseJson<Transcript | null>(r.transcript_json, null) } : null;
}
export function voiceSnapshot(ctx: AppContext, id: number): VoiceSnapshot | null {
  const r = rowOf(ctx, id);
  if (!r) return null;
  if (r.status !== 'ready' || !r.asset_id) throw conflict('VOICE_NOT_READY', 'Hãy nhận dạng và kiểm tra lời đọc trước khi tạo video');
  const a = getHtmlAsset(ctx, id, r.asset_id);
  const transcript = parseJson<Transcript | null>(r.transcript_json, null);
  if (!transcript?.words.length || !a.duration_s) throw conflict('VOICE_NOT_READY', 'Lời đọc chưa có timestamp từng từ');
  return { asset_id: a.id, path: assetPathOf(a), duration_s: a.duration_s, captions: !!r.captions, transcript };
}
export function assertVoiceEditable(ctx: AppContext, id: number) {
  getHtmlProject(ctx, id);
  if (ctx.db.prepare("SELECT id FROM html_versions WHERE project_id=? AND status IN ('composing','validating') LIMIT 1").get(id)) throw conflict('PROJECT_BUSY', 'Đợi AI tạo xong hoặc hủy phiên bản đang tạo trước khi thay lời đọc');
}
export function cancelVoice(ctx: AppContext, id: number, remove = false) {
  assertVoiceEditable(ctx, id);
  tasks.get(ctx)?.get(id)?.cancel();
  if (remove) ctx.db.prepare('DELETE FROM html_voice WHERE project_id=?').run(id);
  else ctx.db.prepare("UPDATE html_voice SET status='cancelled', updated_at=? WHERE project_id=? AND status IN ('queued','processing')").run(ctx.now(), id);
  return voiceView(ctx, id);
}
export function editVoice(ctx: AppContext, id: number, words: { i: number; w: string }[], captions: boolean) {
  assertVoiceEditable(ctx, id);
  const snap = voiceSnapshot(ctx, id);
  if (!snap) throw conflict('VOICE_NOT_READY', 'Chưa chọn lời đọc');
  const t = snap.transcript;
  const edits = new Map(words.map((w) => [w.i, w.w]));
  if (words.some((w) => !t.words[w.i]) || edits.size !== words.length) throw new AppError('INVALID_WORD', 'Chỉ sửa chữ của từ đã nhận dạng, không đổi timestamp', 400);
  const changed = buildTranscript({ text: '', segments: [], words: t.words.map((w) => ({ word: edits.get(w.i) ?? w.w, start: w.start, end: w.end, probability: w.p })), model: t.model ?? undefined, duration: snap.duration_s }, { contentHash: t.content_hash, durationHintS: snap.duration_s });
  ctx.db.prepare('UPDATE html_voice SET transcript_json=?, captions=?, updated_at=? WHERE project_id=?').run(JSON.stringify(changed), captions ? 1 : 0, ctx.now(), id);
  return voiceView(ctx, id);
}

/** Audio extraction và ASR chạy trong hàng đợi chung, có hủy và giải phóng slot khi tiến trình đã thoát. */
export function startVoice(ctx: AppContext, id: number, assetId: number, captions: boolean, transcribe?: (file: string, signal: AbortSignal) => Promise<SttVerbose>) {
  assertVoiceEditable(ctx, id);
  const a = getHtmlAsset(ctx, id, assetId);
  if (a.kind === 'image' || !a.has_audio || !a.duration_s) throw new AppError('VOICE_NO_AUDIO', 'Chọn file âm thanh hoặc video có tiếng', 400);
  if (a.duration_s < 1 || a.duration_s > HTML_MAX_TOTAL_S) throw new AppError('VOICE_DURATION', `Lời đọc cần dài từ 1 đến ${HTML_MAX_TOTAL_S} giây`, 400);
  if (!transcribe) { const why = sttUnavailable(ctx); if (why) throw conflict(why.code, why.message); }
  const current = rowOf(ctx, id);
  if (current?.asset_id === assetId && ['queued', 'processing', 'ready'].includes(current.status)) return voiceView(ctx, id);
  if (current && ['queued', 'processing'].includes(current.status)) throw conflict('VOICE_BUSY', 'Hủy nhận dạng đang chạy trước khi đổi file');
  if (!ctx.finalRender) throw conflict('SERVICE_UNAVAILABLE', 'Hàng đợi xử lý chưa sẵn sàng');
  const requestId = crypto.randomUUID();
  ctx.db.prepare(`INSERT INTO html_voice(project_id,asset_id,status,captions,updated_at,request_id) VALUES(?,?,'queued',?,?,?) ON CONFLICT(project_id) DO UPDATE SET asset_id=excluded.asset_id,status='queued',captions=excluded.captions,transcript_json=NULL,error=NULL,updated_at=excluded.updated_at,request_id=excluded.request_id`).run(id, assetId, captions ? 1 : 0, ctx.now(), requestId);
  const release = ctx.beginProjectUpload(id);
  const key = `voice-${id}-${crypto.randomUUID()}`;
  let running = false;
  let released = false;
  let task: { cancel(): void };
  const finish = () => { if (!released) { released = true; release(); if (tasks.get(ctx)?.get(id) === task) tasks.get(ctx)?.delete(id); } };
  let map = tasks.get(ctx); if (!map) { map = new Map(); tasks.set(ctx, map); }
  task = { cancel: () => { ctx.finalRender?.cancelHtmlTask('html-capture', key); if (!running) finish(); } };
  map.set(id, task);
  ctx.finalRender.enqueueHtmlTask('html-capture', key, true, async (abort) => {
    running = true;
    let temp: string | null = null;
    try {
      if (abort.signal.aborted) return;
      const claimed = ctx.db.prepare("UPDATE html_voice SET status='processing',updated_at=? WHERE project_id=? AND asset_id=? AND request_id=? AND status='queued'").run(ctx.now(), id, assetId, requestId);
      if (!claimed.changes) return;
      temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-voice-'));
      const bin = await ffmpegOf(ctx.config);
      if (!bin) throw new Error('Không tìm thấy ffmpeg');
      const audio = path.join(temp, 'voice.mp3');
      await run(bin, ['-y','-hide_banner','-loglevel','error','-i',path.join(ctx.config.rootDir, a.stored_path),'-vn','-ac','1','-ar','16000','-c:a','libmp3lame','-b:a','48k',audio], abort.signal);
      const c = ctx.config;
      const raw = transcribe ? await transcribe(audio, abort.signal) : c.sttProvider === 'local'
        ? (await transcribeLocal(audio, { modelsDir: c.sttModelsDir, ffmpeg: bin, threads: c.sttThreads, signal: abort.signal })).result
        : (await transcribeAudio(audio, '', { url: c.sttUrl, tenantId: c.sttTenantId, signal: abort.signal, timeoutMs: c.sttTimeoutMs, maxRetries: c.sttMaxRetries, retryDelaysMs: c.sttRetryDelaysMs, pollMs: c.sttPollMs })).result;
      if (abort.signal.aborted) return;
      if (!raw.words?.length) throw new Error('Không nhận được lời nói có timestamp từng từ; hãy chọn file voice rõ tiếng');
      const transcript = buildTranscript(raw, { contentHash: a.content_hash, durationHintS: a.duration_s });
      if (!transcript.words.length) throw new Error('Không tìm thấy lời nói trong file');
      ctx.tx(() => {
        const changed = ctx.db.prepare("UPDATE html_voice SET status='ready',transcript_json=?,error=NULL,updated_at=? WHERE project_id=? AND asset_id=? AND request_id=? AND status IN ('queued','processing')").run(JSON.stringify(transcript), ctx.now(), id, assetId, requestId);
        if (changed.changes) ctx.db.prepare('UPDATE html_project_meta SET duration_s=? WHERE project_id=?').run(a.duration_s, id);
      });
    } catch (e) {
      if (!abort.signal.aborted) ctx.db.prepare("UPDATE html_voice SET status='failed',error=?,updated_at=? WHERE project_id=? AND asset_id=? AND request_id=? AND status IN ('queued','processing')").run(e instanceof Error ? e.message.slice(0, 500) : 'Nhận dạng lời đọc thất bại', ctx.now(), id, assetId, requestId);
    } finally { if (temp) fs.rmSync(temp, { recursive: true, force: true }); finish(); }
  });
  return voiceView(ctx, id);
}
export function closeHtmlVoice(ctx: AppContext) { for (const t of [...(tasks.get(ctx)?.values() ?? [])]) t.cancel(); }
export function recoverHtmlVoice(ctx: AppContext) {
  ctx.db.prepare("UPDATE html_voice SET status='failed', error='Nhận dạng bị gián đoạn khi đóng app. Bấm nhận dạng lại.',updated_at=? WHERE status IN ('queued','processing')").run(ctx.now());
}
