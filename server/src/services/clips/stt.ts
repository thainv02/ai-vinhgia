/**
 * Nhận dạng lời nói cho video nguồn: hàng đợi MỘT việc một lúc (dịch vụ STT xử lý tuần tự, file khác xếp hàng trong dịch vụ), ưu tiên việc của app chính
 * trước việc LAN. Mỗi việc: ffmpeg tách audio mono 16 kHz mp3 48k → gửi dịch vụ (stt-client: thử lại có backoff, lấy lại theo job id khi đứt kết nối) →
 * chuẩn hoá thành `transcript.json` (transcript.ts) → AI nhẹ sửa chính tả/ngữ nghĩa (transcript-fix.ts, lỗi thì giữ bản ASR) → `transcribed`.
 *
 * Dịch vụ không trả %, nên tiến độ là ƯỚC TÍNH theo thời gian: `duration/20 s + 5 s` (tốc độ ~20× thời gian thực), kẹp 95% tới khi xong.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../../context.js';
import type { ProjectRow, SourceVideoRow } from '../../db/types.js';
import { run } from '../final-render/ffmpeg-renderer.js';
import { RenderCancelled } from '../final-render/types.js';
import { ffmpegOf } from '../media.js';
import { emitProject } from '../project-view.js';
import { getProject, logEvent, parseJson } from '../repo.js';
import { abs, clipsDirRel, forgetTranscript, getSourceRow, projectClips, readTranscript, transcriptRel } from './repo.js';
import { archiveTranscript } from './source.js';
import { fetchJobResult, SttCancelled, SttError, transcribeAudio, type SttCallOptions, type SttOutcome } from './stt-client.js';
import { STT_MODEL_MISSING, transcribeLocal } from './local-stt.js';
import { sttModelStatus } from './stt-model.js';
import { detectPauses } from './pauses.js';
import { buildTranscript, type Pause, type PauseDetectInfo, type Transcript } from './transcript.js';
import { fixTranscript, type AlignedWord } from './transcript-fix.js';
import { emitSource } from './view.js';

export interface SttServiceOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Chu kỳ ghi tiến độ ước tính (mặc định 2 giây). */
  progressTickMs?: number;
}

interface Item {
  id: number;
  lan: boolean;
  /** Khôi phục sau khi khởi động lại: thử lấy kết quả theo job id này trước. */
  recoverJob: string | null;
  /** Chỉ chạy lại bước AI chuẩn hoá chính tả trên transcript đã có (video vẫn `transcribed`, lời thoại cũ xem được tới khi xong). */
  aiOnly?: boolean;
}

/** Dựng lại transcript từ dãy từ AI đã sửa (giữ khoảng lặng, thuật ngữ, segment của bản trước). */
function rebuildWithWords(before: Transcript, words: AlignedWord[], durationHintS: number | null): Transcript {
  return buildTranscript(
    { model: before.model ?? undefined, duration: before.duration_s, text: '', segments: before.segments, words: words.map((w) => ({ word: w.w, start: w.start, end: w.end, probability: w.p })) },
    { terms: before.terms, contentHash: before.content_hash, durationHintS, pauses: before.pauses ?? null, pauseDetect: before.pause_detect ?? null },
  );
}

export const STT_NOT_CONFIGURED = 'Chưa cấu hình nhận dạng lời nói (đặt STT_URL trong .env rồi khởi động lại server)';

export const sttConfigured = (ctx: AppContext): boolean => ctx.config.sttProvider === 'local' || (ctx.config.sttProvider === 'omnix' && !!ctx.config.sttUrl);

/** Lý do chưa nhận dạng được ngay (chưa cấu hình / chưa có model trên máy); null = sẵn sàng. */
export function sttUnavailable(ctx: AppContext): { code: string; message: string } | null {
  if (!sttConfigured(ctx)) return { code: 'STT_NOT_CONFIGURED', message: STT_NOT_CONFIGURED };
  if (ctx.config.sttProvider === 'local' && !sttModelStatus(ctx.config.sttModelsDir).installed) return { code: 'STT_MODEL_MISSING', message: STT_MODEL_MISSING };
  return null;
}

/** Thời gian nhận dạng ước tính (giây) cho video dài `durationS` giây: ~20× thời gian thực + 5 giây. */
export const estimateSeconds = (durationS: number): number => durationS / 20 + 5;

export class SttService {
  private queue: Item[] = [];
  /** `phase`: `asr` = đang nhận dạng; `ai_fix` = AI đang chuẩn hoá chính tả (kết quả chưa hiển thị). */
  private running: { item: Item; abort: AbortController; phase: 'asr' | 'ai_fix' } | null = null;
  private closed = false;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly ctx: AppContext,
    private readonly opts: SttServiceOptions = {},
  ) {}

  // ---------------------------------------------------------------- hàng đợi

  /** Xếp nhận dạng cho video (đã ở `transcribing` trong DB). App chính đứng trước mọi việc LAN đang chờ. */
  enqueue(sourceId: number, o: { recoverJob?: string | null } = {}): void {
    if (this.closed || this.isQueued(sourceId) || (this.running?.item.id === sourceId && !this.running.abort.signal.aborted)) return;
    const lan = !!(this.ctx.db.prepare('SELECT p.source FROM source_videos s JOIN projects p ON p.id = s.project_id WHERE s.id = ?').get(sourceId) as { source: string } | undefined)?.source.startsWith('lan');
    const item: Item = { id: sourceId, lan, recoverJob: o.recoverJob ?? null };
    if (lan) this.queue.push(item);
    else {
      const firstLan = this.queue.findIndex((j) => j.lan);
      if (firstLan < 0) this.queue.push(item);
      else this.queue.splice(firstLan, 0, item);
    }
    this.pump();
  }

  /** Xếp chạy lại riêng bước AI chuẩn hoá chính tả cho video đã nhận dạng (route đã kiểm tra điều kiện). */
  enqueueAiFix(sourceId: number): void {
    if (this.closed || this.isQueued(sourceId) || this.running?.item.id === sourceId) return;
    this.queue.push({ id: sourceId, lan: false, recoverJob: null, aiOnly: true });
    this.pump();
    emitSafe(() => this.emit(sourceId));
  }

  /** Video đang chờ/đang chạy lại bước AI chuẩn hoá (chặn tạo clip: chỉ số từ sắp đổi). */
  isAiFixing(sourceId: number): boolean {
    return this.queue.some((j) => j.id === sourceId && j.aiOnly) || (this.running?.item.id === sourceId && !!this.running.item.aiOnly);
  }

  private isQueued(id: number): boolean {
    return this.queue.some((j) => j.id === id);
  }

  /** `running` | `waiting` (+ vị trí 1 = kế tiếp) | null nếu không có trong hàng đợi. */
  queueInfo(sourceId: number): { state: 'waiting' | 'running'; position: number | null; phase?: 'asr' | 'ai_fix' } | null {
    if (this.running?.item.id === sourceId) return { state: 'running', position: null, phase: this.running.phase };
    const i = this.queue.findIndex((j) => j.id === sourceId);
    return i < 0 ? null : { state: 'waiting', position: i + 1, ...(this.queue[i]!.aiOnly ? { phase: 'ai_fix' as const } : {}) };
  }

  /** Số video đang chờ + đang chạy nhận dạng (của LAN: tính vào trần hàng đợi LAN). */
  load(): { total: number; lan: number } {
    const items = [...this.queue, ...(this.running ? [this.running.item] : [])];
    return { total: items.length, lan: items.filter((i) => i.lan).length };
  }

  /** Hủy một việc đang chờ hoặc đang chạy (dừng ffmpeg / fetch). Trạng thái DB do người gọi đặt. */
  cancel(sourceId: number): void {
    this.queue = this.queue.filter((j) => j.id !== sourceId);
    if (this.running?.item.id === sourceId) this.running.abort.abort();
  }

  idle(): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  async close(): Promise<void> {
    this.closed = true;
    this.queue = [];
    this.running?.abort.abort();
    for (let i = 0; i < 200 && this.running; i++) await new Promise((r) => setTimeout(r, 10));
    for (const w of this.idleWaiters.splice(0)) w();
  }

  private pump(): void {
    if (this.closed || this.running || this.queue.length === 0) {
      if (!this.running && this.queue.length === 0) for (const w of this.idleWaiters.splice(0)) w();
      return;
    }
    const item = this.queue.shift()!;
    const abort = new AbortController();
    this.running = { item, abort, phase: item.aiOnly ? 'ai_fix' : 'asr' };
    emitSafe(() => this.emit(item.id));
    void (item.aiOnly ? this.executeAiFix(item, abort) : this.execute(item, abort))
      .catch((err) => console.error('[stt] lỗi không lường trước:', err))
      .finally(() => {
        this.running = null;
        this.pump();
      });
  }

  private emit(id: number): void {
    const row = this.ctx.db.prepare('SELECT id, project_id FROM source_videos WHERE id = ?').get(id) as Pick<SourceVideoRow, 'id' | 'project_id'> | undefined;
    if (row) emitSource(this.ctx, row);
  }

  /** Phát SSE `source.updated` cho các việc đang chờ khi vị trí đổi (gọi sau mỗi lần một việc xong). */
  private emitWaiting(): void {
    for (const j of this.queue) emitSafe(() => this.emit(j.id));
  }

  // ---------------------------------------------------------------- một việc

  private patch(id: number, patch: Partial<Pick<SourceVideoRow, 'status' | 'progress' | 'error' | 'error_code' | 'stt_job_id' | 'transcript_path' | 'stt_meta' | 'transcribed_at'>>): void {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return;
    this.ctx.db.prepare(`UPDATE source_videos SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => (patch[k] ?? null) as string | number | null), id);
  }

  private still(id: number): boolean {
    return (this.ctx.db.prepare('SELECT status FROM source_videos WHERE id = ?').get(id) as { status: string } | undefined)?.status === 'transcribing';
  }

  /**
   * Chỉ chạy lại AI chuẩn hoá chính tả trên transcript hiện tại. Video giữ `transcribed`; chỉ thay transcript khi dự án vẫn chưa có clip
   * (route chặn tạo clip lúc đang chạy). AI lỗi: giữ transcript, ghi lý do vào `stt_meta.ai_fix` nếu bản hiện tại chưa chuẩn hoá được.
   */
  private async executeAiFix(item: Item, abort: AbortController): Promise<void> {
    const ctx = this.ctx;
    try {
      const row = ctx.db.prepare('SELECT * FROM source_videos WHERE id = ?').get(item.id) as SourceVideoRow | undefined;
      if (!row || row.status !== 'transcribed' || !row.transcript_path) return;
      let project: ProjectRow;
      try {
        project = getProject(ctx, row.project_id);
      } catch {
        return;
      }
      const current = readTranscript(ctx, row);
      if (!current) return;
      const fix = await fixTranscript(ctx, current, abort.signal);
      if (abort.signal.aborted) return;
      ctx.tx(() => {
        const now = ctx.db.prepare('SELECT * FROM source_videos WHERE id = ?').get(item.id) as SourceVideoRow | undefined;
        if (!now || now.status !== 'transcribed' || now.transcript_path !== row.transcript_path) return;
        const meta = parseJson<Record<string, unknown>>(now.stt_meta, {});
        const hadFix = !!(current.ai_fix?.model && !current.ai_fix.error);
        if (!fix.words || projectClips(ctx, project.id).length) {
          const error = fix.words ? 'dự án đã có clip trong lúc chuẩn hoá nên giữ lời thoại cũ' : fix.info.error;
          // bản hiện tại đã chuẩn hoá được thì giữ thông tin đó, chỉ ghi lỗi của lần chạy lại
          this.patch(item.id, { stt_meta: JSON.stringify({ ...meta, ai_fix: hadFix ? { ...current.ai_fix, retry_error: error, at: ctx.now() } : { ...fix.info, error } }) });
          logEvent(ctx, { project_id: project.id, type: 'clip.transcript_fix_failed', message: `Chuẩn hoá lại bằng AI không thành công (giữ lời thoại hiện tại): ${error}` });
        } else {
          const next = rebuildWithWords(current, fix.words, now.duration_s);
          next.ai_fix = fix.info;
          const rel = transcriptRel(project.slug);
          const tmp = abs(ctx, `${clipsDirRel(project.slug)}/.transcript.${row.id}.tmp.json`);
          fs.writeFileSync(tmp, JSON.stringify(next));
          archiveTranscript(ctx, project.slug);
          fs.renameSync(tmp, abs(ctx, rel));
          forgetTranscript(ctx, rel);
          this.patch(item.id, { transcript_path: rel, stt_meta: JSON.stringify({ ...meta, word_count: next.words.length, ai_fix: fix.info }) });
          logEvent(ctx, { project_id: project.id, type: 'clip.transcript_fixed', message: `Chuẩn hoá lại bằng AI (${fix.info.model}): sửa ${fix.info.changed_words} từ ở ${fix.info.accepted}/${fix.info.sentences} câu` });
        }
        emitProject(ctx, project.id);
      });
    } finally {
      // `running` được pump() xoá sau khi hàm này xong; phát lại để giao diện bỏ trạng thái "đang chuẩn hoá"
      setImmediate(() => emitSafe(() => this.emit(item.id)));
    }
  }

  private async execute(item: Item, abort: AbortController): Promise<void> {
    const ctx = this.ctx;
    const row = ctx.db.prepare('SELECT * FROM source_videos WHERE id = ?').get(item.id) as SourceVideoRow | undefined;
    if (!row || row.status !== 'transcribing' || abort.signal.aborted) return;
    let project: ProjectRow;
    try {
      project = getProject(ctx, row.project_id);
    } catch {
      return; // dự án vào thùng rác
    }
    const audioRel = `${clipsDirRel(project.slug)}/.stt-${row.id}.mp3`;
    const audioAbs = abs(ctx, audioRel);
    const startedAt = Date.now();
    const local = ctx.config.sttProvider === 'local';
    let lastPct = -1;
    const setPct = (pct: number) => {
      if (pct === lastPct || abort.signal.aborted || !this.still(item.id)) return;
      lastPct = pct;
      this.patch(item.id, { progress: pct });
      emitSafe(() => this.emit(item.id));
    };
    // Dịch vụ STT không báo %: ước tính theo thời gian. Nhận dạng trên máy báo số giây đã xử lý (tiến độ thật, xem transcribeLocal).
    const est = estimateSeconds(row.duration_s ?? 0);
    const tick = setInterval(() => {
      if (!local && this.running?.phase !== 'ai_fix') setPct(Math.min(95, Math.max(1, Math.round(((Date.now() - startedAt) / 1000 / est) * 100))));
    }, this.opts.progressTickMs ?? 2000);
    tick.unref();
    try {
      // 1. Dùng lại transcript đã có cho cùng nội dung + cùng tên riêng (ở dự án khác) — không gọi dịch vụ lại.
      const cached = this.findCached(row, project);
      let outcome: SttOutcome | null = null;
      let cacheHit = false;
      if (cached) {
        cacheHit = true;
      } else if (local) {
        await this.extractAudio(row, audioAbs, abort.signal);
        if (abort.signal.aborted) throw new SttCancelled();
        const bin = await ffmpegOf(ctx.config);
        if (!bin) throw new AudioError('Không tìm thấy ffmpeg để đọc âm thanh');
        const total = row.duration_s ?? 0;
        outcome = await transcribeLocal(audioAbs, {
          modelsDir: ctx.config.sttModelsDir,
          ffmpeg: bin,
          threads: ctx.config.sttThreads,
          signal: abort.signal,
          onProgress: (s) => total > 0 && setPct(Math.min(99, Math.max(1, Math.round((s / total) * 100)))),
        });
      } else {
        const callOpts = this.callOptions(item, abort);
        // 2. Khôi phục sau khi khởi động lại: thử lấy kết quả theo job id đã lưu
        if (item.recoverJob) {
          try {
            outcome = await fetchJobResult(item.recoverJob, callOpts);
          } catch (e) {
            if (e instanceof SttCancelled) throw e;
            outcome = null; // không lấy lại được: chạy lại từ đầu
          }
        }
        if (!outcome) {
          await this.extractAudio(row, audioAbs, abort.signal);
          if (abort.signal.aborted) throw new SttCancelled();
          this.patch(item.id, { stt_job_id: null });
          outcome = await transcribeAudio(audioAbs, project.stt_terms, { ...callOpts, onJobId: (id) => this.patch(item.id, { stt_job_id: id }) });
        }
      }
      if (abort.signal.aborted || !this.still(item.id)) return;
      // 3. Chuẩn hoá và ghi transcript (không ghi đè: bản cũ được lưu thành transcript.v<k>.json)
      let pauseResult: { pauses: Pause[]; info: PauseDetectInfo } | null = null;
      if (!cacheHit || !Array.isArray(cached?.transcript.pauses)) {
        // Khoảng lặng thật (silencedetect) để dựng câu / siết cuối từ / bám điểm cắt; lỗi thì dựng câu theo cách cũ (khe giữa các từ + mốc segment)
        try {
          if (!fs.existsSync(audioAbs)) await this.extractAudio(row, audioAbs, abort.signal); // khôi phục theo job id: chưa tách audio
          const bin = await ffmpegOf(ctx.config);
          pauseResult = bin ? await detectPauses(bin, audioAbs, abort.signal) : null;
        } catch (e) {
          if (abort.signal.aborted || e instanceof RenderCancelled) throw new SttCancelled();
          logEvent(ctx, { project_id: project.id, type: 'clip.pauses_failed', message: `Không dò được khoảng lặng (dựng câu theo cách cũ): ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}` });
        }
        if (abort.signal.aborted || !this.still(item.id)) return;
      }
      const raw = cacheHit ? {
        model: cached!.transcript.model ?? undefined,
        duration: cached!.transcript.duration_s,
        text: '',
        segments: cached!.transcript.segments,
        words: cached!.transcript.words.map(({ w, start, end, p }) => ({ word: w, start, end, probability: p })),
      } : outcome!.result;
      // Upgrade only this new project's cached copy; existing clip word/sentence IDs stay intact.
      let transcript: Transcript = cacheHit && !pauseResult
        ? { ...cached!.transcript, content_hash: row.content_hash }
        : buildTranscript(raw, { terms: project.stt_terms, contentHash: row.content_hash, durationHintS: row.duration_s, pauses: pauseResult?.pauses ?? null, pauseDetect: pauseResult?.info ?? null });
      if (cacheHit && cached!.transcript.ai_fix) transcript.ai_fix = cached!.transcript.ai_fix;
      // 4. AI nhẹ chuẩn hoá chính tả / ngữ nghĩa trước khi hiển thị (bản dùng lại đã chuẩn hoá thành công thì thôi). Lỗi: giữ bản ASR, ghi lý do.
      if (ctx.config.sttAiFix && !(transcript.ai_fix?.model && !transcript.ai_fix.error)) {
        if (this.running?.item.id === item.id) this.running.phase = 'ai_fix';
        setPct(99);
        emitSafe(() => this.emit(item.id));
        const fix = await fixTranscript(ctx, transcript, abort.signal);
        if (abort.signal.aborted || !this.still(item.id)) return;
        if (fix.words) transcript = rebuildWithWords(transcript, fix.words, row.duration_s);
        transcript.ai_fix = fix.info;
        logEvent(ctx, {
          project_id: project.id,
          type: fix.words ? 'clip.transcript_fixed' : 'clip.transcript_fix_failed',
          message: fix.words
            ? `AI (${fix.info.model}) chuẩn hoá chính tả: sửa ${fix.info.changed_words} từ ở ${fix.info.accepted}/${fix.info.sentences} câu${fix.info.rejected ? `, bỏ qua ${fix.info.rejected} câu sửa quá tay` : ''}`
            : `Không chuẩn hoá được chính tả bằng AI (dùng bản nhận dạng gốc): ${fix.info.error}`,
        });
      }
      const rel = transcriptRel(project.slug);
      const tmp = abs(ctx, `${clipsDirRel(project.slug)}/.transcript.${row.id}.tmp.json`);
      fs.mkdirSync(path.dirname(tmp), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(transcript));
      ctx.tx(() => {
        if (!this.still(item.id)) {
          fs.rmSync(tmp, { force: true });
          return;
        }
        archiveTranscript(ctx, project.slug);
        fs.renameSync(tmp, abs(ctx, rel));
        forgetTranscript(ctx, rel);
        const meta = {
          model: transcript.model,
          elapsed_ms: cacheHit ? 0 : (outcome!.result.elapsed_ms ?? Date.now() - startedAt),
          word_count: transcript.words.length,
          speech_ratio: transcript.speech_ratio,
          terms: transcript.terms,
          cached: cacheHit,
          pauses: transcript.pauses?.length ?? null,
          pause_threshold_db: transcript.pause_detect?.threshold_db ?? null,
          ai_fix: transcript.ai_fix ?? null,
        };
        this.patch(item.id, { status: 'transcribed', progress: 100, error: null, error_code: null, transcript_path: rel, stt_meta: JSON.stringify(meta), transcribed_at: ctx.now() });
        logEvent(ctx, { project_id: project.id, type: 'clip.transcribed', message: `Đã nhận dạng lời nói: ${transcript.words.length} từ, ${transcript.sentences.length} câu${cacheHit ? ' (dùng lại kết quả đã có)' : ''}` });
        emitProject(ctx, project.id);
        emitSource(ctx, row);
      });
    } catch (e) {
      fs.rmSync(audioAbs, { force: true });
      if (abort.signal.aborted || e instanceof SttCancelled || e instanceof RenderCancelled) {
        // hủy: trạng thái do `cancelSource` ghi; nếu bị dừng vì tắt server thì giữ `transcribing` để khôi phục lúc khởi động lại
        return;
      }
      if (!this.still(item.id)) return;
      const code = e instanceof SttError ? e.code : e instanceof AudioError ? 'AUDIO_EXTRACT_FAILED' : 'STT_ERROR';
      const message = e instanceof SttError || e instanceof AudioError ? e.message : `Nhận dạng lời nói thất bại: ${e instanceof Error ? e.message : String(e)}`;
      ctx.tx(() => {
        this.patch(item.id, { status: 'failed', progress: null, error: message.slice(0, 500), error_code: code });
        logEvent(ctx, { project_id: project.id, type: 'clip.transcribe_failed', message: `Nhận dạng lời nói lỗi [${code}]: ${message.slice(0, 300)}` });
        emitProject(ctx, project.id);
        emitSource(ctx, row);
      });
    } finally {
      clearInterval(tick);
      fs.rmSync(audioAbs, { force: true });
      this.emitWaiting();
    }
  }

  private callOptions(item: Item, abort: AbortController): SttCallOptions {
    const c = this.ctx.config;
    return {
      url: c.sttUrl,
      tenantId: c.sttTenantId,
      signal: abort.signal,
      timeoutMs: c.sttTimeoutMs,
      maxRetries: c.sttMaxRetries,
      retryDelaysMs: c.sttRetryDelaysMs,
      pollMs: c.sttPollMs,
      sleep: this.opts.sleep,
      fetchImpl: this.opts.fetchImpl,
      onRetry: (r) => logEvent(this.ctx, { project_id: this.projectOf(item.id), type: 'clip.stt_retry', message: `Nhận dạng lời nói: thử lại lần ${r.attempt} sau ${Math.round(r.delayMs / 1000)} giây (${r.reason.slice(0, 160)})` }),
    };
  }

  private projectOf(sourceId: number): number {
    return (this.ctx.db.prepare('SELECT project_id FROM source_videos WHERE id = ?').get(sourceId) as { project_id: number }).project_id;
  }

  /** Transcript đã có của cùng nội dung (content_hash) + cùng tên riêng ở video khác; null nếu không có. */
  private findCached(row: SourceVideoRow, project: ProjectRow): { transcript: ReturnType<typeof buildTranscript> } | null {
    const others = this.ctx.db
      .prepare("SELECT * FROM source_videos WHERE content_hash = ? AND id <> ? AND status = 'transcribed' AND transcript_path IS NOT NULL ORDER BY id DESC LIMIT 5")
      .all(row.content_hash, row.id) as SourceVideoRow[];
    const want = project.stt_terms?.trim() || null;
    for (const o of others) {
      const meta = parseJson<{ terms?: string | null } | null>(o.stt_meta, null);
      if ((meta?.terms ?? null) !== want) continue;
      try {
        const t = JSON.parse(fs.readFileSync(abs(this.ctx, o.transcript_path!), 'utf8')) as ReturnType<typeof buildTranscript>;
        if (t && Array.isArray(t.words) && Array.isArray(t.sentences)) return { transcript: t };
      } catch {
        /* file mất/hỏng: bỏ qua */
      }
    }
    return null;
  }

  /** `ffmpeg -vn -ac 1 -ar 16000 -c:a libmp3lame -b:a 48k` ra file tạm (3 giờ ≈ 65 MB, dưới giới hạn 500 MB của dịch vụ). */
  private async extractAudio(row: SourceVideoRow, outAbs: string, signal: AbortSignal): Promise<void> {
    const bin = await ffmpegOf(this.ctx.config);
    if (!bin) throw new AudioError('Không tìm thấy ffmpeg để tách âm thanh');
    if (!row.path || row.deleted_at) throw new AudioError('Video nguồn đã bị xoá nên không nhận dạng được');
    const input = abs(this.ctx, row.path);
    if (!fs.existsSync(input)) throw new AudioError('Không thấy file video nguồn');
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    fs.rmSync(outAbs, { force: true });
    try {
      await run(bin, ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '48k', outAbs], signal);
    } catch (e) {
      fs.rmSync(outAbs, { force: true });
      if (e instanceof RenderCancelled) throw e;
      throw new AudioError(`Không tách được âm thanh để nhận dạng: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
    }
  }

  // ---------------------------------------------------------------- khởi động

  /**
   * Khi server khởi động: video `transcribing` của tiến trình cũ → xếp lại (có `stt_job_id` thì thử lấy kết quả theo job id trước, không được thì chạy lại);
   * dọn file tạm `.stt-*.mp3`. Chưa cấu hình dịch vụ → đánh dấu failed.
   */
  recover(): number {
    const ctx = this.ctx;
    const rows = ctx.db.prepare("SELECT s.*, p.slug FROM source_videos s JOIN projects p ON p.id = s.project_id WHERE s.status = 'transcribing' ORDER BY s.id").all() as (SourceVideoRow & { slug: string })[];
    for (const r of rows) {
      try {
        for (const f of fs.readdirSync(abs(ctx, clipsDirRel(r.slug)))) if (/^\.stt-\d+\.mp3$/.test(f)) fs.rmSync(abs(ctx, `${clipsDirRel(r.slug)}/${f}`), { force: true });
      } catch {
        /* thư mục chưa có */
      }
      const why = sttUnavailable(ctx);
      if (why) {
        this.patch(r.id, { status: 'failed', progress: null, error: why.message, error_code: why.code });
        continue;
      }
      // nhận dạng trên máy không có job id để lấy lại: chạy lại từ đầu
      this.enqueue(r.id, { recoverJob: ctx.config.sttProvider === 'local' ? null : r.stt_job_id });
    }
    return rows.length;
  }
}

class AudioError extends Error {}

function emitSafe(fn: () => void): void {
  try {
    fn();
  } catch {
    /* DB đã đóng khi tắt server */
  }
}

/** Đặt video về `transcribing` (progress 0) và xếp hàng. Gọi trong transaction của người dùng (upload/transcribe). */
export function startTranscription(ctx: AppContext, sourceId: number): void {
  ctx.tx(() => {
    const row = getSourceRow(ctx, sourceId);
    const why = sttUnavailable(ctx);
    if (why) {
      ctx.db.prepare("UPDATE source_videos SET status = 'failed', progress = NULL, error = ?, error_code = ? WHERE id = ?").run(why.message, why.code, sourceId);
      emitSource(ctx, row);
      return;
    }
    ctx.db.prepare("UPDATE source_videos SET status = 'transcribing', progress = 0, error = NULL, error_code = NULL, stt_job_id = NULL WHERE id = ?").run(sourceId);
    emitSource(ctx, row);
    emitProject(ctx, row.project_id);
    ctx.afterCommit(() => ctx.stt?.enqueue(sourceId));
  });
}
