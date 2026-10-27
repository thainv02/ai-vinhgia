/**
 * Máy khách của dịch vụ nhận dạng lời nói nội bộ (Omnix, chuẩn OpenAI `POST /v1/audio/transcriptions`). Không phụ thuộc DB/AppContext để test được
 * bằng server giả.
 *
 * Hợp đồng đã thử với dịch vụ thật (xem server/src/scripts/stt-smoke.ts):
 *   - gửi multipart: `file`, `response_format=verbose_json`, `timestamp_granularities[]=word`, `prompt` (chỉ khi người dùng nhập tên riêng/thuật ngữ);
 *   - phản hồi 200 `{task, language, duration, text, segments:[{id,start,end,text}], words:[{word,start,end,probability}], elapsed_ms, model}` kèm header `X-Job-Id`;
 *   - chữ thường, không dấu câu, số đọc thành chữ; audio không có lời → `text` rỗng, không lỗi;
 *   - lỗi `{error:{message,type,code,retryable,details}}`: `retryable:true` (502/503 `no_capacity`, `fetch_failed`, `runtime_*`) → thử lại có backoff;
 *     504 `transcription_timeout` → lấy kết quả theo `details.job_id` ở `GET /v1/stt/jobs/{job_id}` (header `X-Tenant-ID`);
 *   - dịch vụ xử lý MỘT file một lúc (các file khác xếp hàng trong dịch vụ), tốc độ ~20× thời gian thực.
 *
 * Phản hồi THỰC TẾ của `GET /v1/stt/jobs/{id}` (đã thử với dịch vụ thật): `{job_id, tenant_id, state:"succeeded", platform_state, attempt_state, task_id, text, segments,
 * duration_seconds, model, error, created_at, updated_at}` — có `text` + `segments` nhưng KHÔNG có `words`. Thiếu mốc từng từ thì không dùng được (`STT_JOB_NO_WORDS`,
 * lỗi tạm: gửi lại file; dịch vụ ~20× thời gian thực nên rẻ). Vẫn đọc LỎNG (`extractResult`): bản verbose_json trần hoặc bọc trong `result`/`response`/`output`/`data`;
 * trạng thái ở `status`/`state`. Không đoán được thì coi là lỗi tạm (thử lại / hỏi lại), không bao giờ coi là thành công.
 */
import fs from 'node:fs';

export interface SttWord {
  word: string;
  start: number;
  end: number;
  probability?: number;
}
export interface SttSegment {
  id?: number;
  start: number;
  end: number;
  text: string;
}
export interface SttVerbose {
  language?: string;
  duration?: number;
  text: string;
  segments: SttSegment[];
  words: SttWord[];
  elapsed_ms?: number;
  model?: string;
}

export class SttError extends Error {
  constructor(
    /** Mã gọn để lưu `source_videos.error_code`. */
    readonly code: string,
    /** Thông báo tiếng Việt cho người dùng. */
    message: string,
    readonly retryable = false,
    readonly status?: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'SttError';
  }
}

/** Người dùng hủy (abort) việc nhận dạng. */
export class SttCancelled extends Error {
  constructor() {
    super('Đã hủy nhận dạng lời nói');
    this.name = 'SttCancelled';
  }
}

export interface SttCallOptions {
  /** URL đầy đủ của `/v1/audio/transcriptions`. */
  url: string;
  tenantId: string;
  signal: AbortSignal;
  timeoutMs: number;
  /** Số lần thử lại và backoff (ms) giữa các lần. */
  maxRetries: number;
  retryDelaysMs: number[];
  pollMs: number;
  /** Gọi ngay khi biết `X-Job-Id` (để lưu DB, lấy lại kết quả sau khi server khởi động lại). */
  onJobId?: (id: string) => void;
  /** Gọi khi đang chờ thử lại (để hiển thị). */
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  fetchImpl?: typeof fetch;
}

export interface SttOutcome {
  result: SttVerbose;
  jobId: string | null;
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

/** Thư mục gốc của dịch vụ (`http://host:port`) từ URL `/v1/audio/transcriptions`. */
export const sttOrigin = (url: string): string => new URL(url).origin;
export const sttJobUrl = (url: string, jobId: string): string => `${sttOrigin(url)}/v1/stt/jobs/${encodeURIComponent(jobId)}`;

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Phản hồi đã giống verbose_json (có `words` hoặc cặp `text` + `segments`). */
function looksVerbose(v: unknown): v is Record<string, unknown> {
  return isRec(v) && (Array.isArray(v.words) || (typeof v.text === 'string' && Array.isArray(v.segments)) || (typeof v.text === 'string' && typeof v.duration === 'number'));
}

/** Rút kết quả verbose_json từ phản hồi `GET /v1/stt/jobs/{id}` (bản trần hoặc bọc trong `result`/`response`/`output`/`data`). null = chưa có. */
export function extractResult(body: unknown): Record<string, unknown> | null {
  if (looksVerbose(body)) return body;
  if (isRec(body)) {
    for (const key of ['result', 'response', 'output', 'data', 'transcription']) {
      const inner = body[key];
      if (looksVerbose(inner)) return inner;
      if (isRec(inner)) {
        const deeper = extractResult(inner);
        if (deeper) return deeper;
      }
    }
  }
  return null;
}

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Chuẩn hoá phản hồi về `SttVerbose` (bỏ phần tử hỏng, ép số). */
export function toVerbose(raw: Record<string, unknown>): SttVerbose {
  const words: SttWord[] = [];
  if (Array.isArray(raw.words)) {
    for (const w of raw.words) {
      if (!isRec(w) || typeof w.word !== 'string') continue;
      const word = w.word.trim();
      if (!word) continue;
      words.push({ word, start: num(w.start), end: num(w.end), probability: typeof w.probability === 'number' ? w.probability : undefined });
    }
  }
  const segments: SttSegment[] = [];
  if (Array.isArray(raw.segments)) {
    for (const s of raw.segments) {
      if (!isRec(s) || typeof s.text !== 'string') continue;
      segments.push({ id: typeof s.id === 'number' ? s.id : segments.length, start: num(s.start), end: num(s.end), text: s.text.trim() });
    }
  }
  return {
    language: typeof raw.language === 'string' ? raw.language : undefined,
    duration: typeof raw.duration === 'number' ? raw.duration : typeof raw.duration_seconds === 'number' ? raw.duration_seconds : undefined,
    text: typeof raw.text === 'string' ? raw.text : segments.map((s) => s.text).join(' '),
    segments,
    words,
    elapsed_ms: typeof raw.elapsed_ms === 'number' ? raw.elapsed_ms : undefined,
    model: typeof raw.model === 'string' ? raw.model : undefined,
  };
}

interface ParsedError {
  message: string;
  code: string | null;
  retryable: boolean;
  details: Record<string, unknown> | null;
}

function parseErrorBody(text: string): ParsedError {
  try {
    const j = JSON.parse(text) as unknown;
    const e = isRec(j) && isRec(j.error) ? j.error : isRec(j) && isRec(j.detail) ? j.detail : null;
    if (e) {
      return {
        message: typeof e.message === 'string' ? e.message : text.slice(0, 200),
        code: typeof e.code === 'string' ? e.code : typeof e.type === 'string' ? e.type : null,
        retryable: e.retryable === true,
        details: isRec(e.details) ? e.details : null,
      };
    }
    if (isRec(j) && typeof j.detail === 'string') return { message: j.detail, code: null, retryable: false, details: null };
  } catch {
    /* không phải JSON */
  }
  return { message: text.slice(0, 200), code: null, retryable: false, details: null };
}

const NETWORK_MESSAGE = 'Không kết nối được dịch vụ nhận dạng lời nói';

function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  return `${err.message}${cause?.code ? ` (${cause.code})` : ''}`.slice(0, 200);
}

/**
 * Gửi một file audio và trả kết quả. Lỗi `retryable` và lỗi mạng thử lại tối đa `maxRetries` lần theo backoff; đứt kết nối hoặc hết thời gian SAU KHI
 * đã biết `X-Job-Id` (hoặc 504 `transcription_timeout`) thì hỏi kết quả theo job id thay vì gửi lại file. Hủy (abort) → `SttCancelled`.
 */
export async function transcribeAudio(audioPath: string, terms: string | null, o: SttCallOptions): Promise<SttOutcome> {
  const f = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? defaultSleep;
  let jobId: string | null = null;
  const deadline = Date.now() + o.timeoutMs;
  for (let attempt = 0; ; attempt++) {
    if (o.signal.aborted) throw new SttCancelled();
    try {
      const form = new FormData();
      form.append('file', await fs.openAsBlob(audioPath, { type: 'audio/mpeg' }), 'audio.mp3');
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'word');
      if (terms && terms.trim()) form.append('prompt', terms.trim());
      const remaining = Math.max(1000, deadline - Date.now());
      const res = await f(o.url, {
        method: 'POST',
        headers: { 'X-Tenant-ID': o.tenantId },
        body: form,
        signal: AbortSignal.any([o.signal, AbortSignal.timeout(remaining)]),
      });
      const headerJob = res.headers.get('x-job-id');
      if (headerJob) {
        jobId = headerJob;
        o.onJobId?.(headerJob);
      }
      if (res.ok) {
        let body: unknown;
        try {
          body = await res.json();
        } catch (err) {
          // đứt kết nối giữa chừng khi đọc thân: kết quả có thể đã sẵn ở dịch vụ
          if (o.signal.aborted) throw new SttCancelled();
          if (jobId) return { result: await pollJob(jobId, o), jobId };
          throw new SttError('STT_UNAVAILABLE', `${NETWORK_MESSAGE}: phản hồi bị cắt (${describe(err)})`, true);
        }
        const raw = extractResult(body);
        if (!raw) throw new SttError('STT_BAD_RESPONSE', 'Dịch vụ nhận dạng lời nói trả dữ liệu không đúng định dạng', false, res.status);
        return { result: toVerbose(raw), jobId };
      }
      const text = await res.text().catch(() => '');
      const err = parseErrorBody(text);
      const timeoutJob: string | null = typeof err.details?.job_id === 'string' ? err.details.job_id : jobId;
      if (res.status === 504 && (err.code === 'transcription_timeout' || timeoutJob)) {
        if (timeoutJob) {
          jobId = timeoutJob;
          o.onJobId?.(timeoutJob);
          return { result: await pollJob(timeoutJob, o), jobId };
        }
      }
      if (err.retryable || res.status === 502 || res.status === 503 || res.status === 504) {
        throw new SttError('STT_UNAVAILABLE', `Dịch vụ nhận dạng lời nói đang bận hoặc tạm lỗi (${err.code ?? res.status}: ${err.message})`, true, res.status, err.details);
      }
      throw new SttError('STT_REJECTED', `Dịch vụ nhận dạng lời nói từ chối file: ${err.message}`, false, res.status, err.details);
    } catch (e) {
      if (o.signal.aborted) throw new SttCancelled();
      if (e instanceof SttCancelled) throw e;
      let error: SttError;
      if (e instanceof SttError) error = e;
      else if (e instanceof DOMException && e.name === 'TimeoutError') {
        // hết thời gian chờ: có job id thì hỏi kết quả, không thì coi là lỗi cuối (đã chờ hết STT_TIMEOUT_MS)
        if (jobId) return { result: await pollJob(jobId, o), jobId };
        throw new SttError('STT_TIMEOUT', 'Dịch vụ nhận dạng lời nói không trả kết quả trong thời gian cho phép', false);
      } else {
        // lỗi mạng (ECONNRESET, ECONNREFUSED, đứt kết nối...)
        if (jobId) {
          try {
            return { result: await pollJob(jobId, o), jobId };
          } catch (pe) {
            if (pe instanceof SttCancelled) throw pe;
            if (!(pe instanceof SttError && pe.retryable)) throw pe;
          }
        }
        error = new SttError('STT_UNAVAILABLE', `${NETWORK_MESSAGE} (${describe(e)})`, true);
      }
      if (!error.retryable) throw error;
      if (attempt >= o.maxRetries) {
        throw new SttError(error.code, `${error.message}. Đã thử lại ${o.maxRetries} lần; bấm "Thử lại" sau.`, false, error.status, error.details);
      }
      const delay = o.retryDelaysMs[Math.min(attempt, o.retryDelaysMs.length - 1)] ?? 10_000;
      o.onRetry?.({ attempt: attempt + 1, delayMs: delay, reason: error.message });
      await sleep(delay, o.signal);
    }
  }
}

/**
 * Hỏi kết quả theo job id cho tới khi xong, lỗi hoặc hết `timeoutMs`. Dịch vụ không biết job (404) → `STT_JOB_LOST` (lỗi tạm: người gọi gửi lại file).
 * Trạng thái lạ/chưa rõ thì tiếp tục hỏi; không bao giờ coi phản hồi không có kết quả là thành công.
 */
export async function pollJob(jobId: string, o: SttCallOptions): Promise<SttVerbose> {
  const f = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? defaultSleep;
  const url = sttJobUrl(o.url, jobId);
  const deadline = Date.now() + o.timeoutMs;
  let failures = 0;
  for (;;) {
    if (o.signal.aborted) throw new SttCancelled();
    if (Date.now() > deadline) throw new SttError('STT_TIMEOUT', 'Dịch vụ nhận dạng lời nói không trả kết quả trong thời gian cho phép', false);
    try {
      const res = await f(url, { headers: { 'X-Tenant-ID': o.tenantId }, signal: AbortSignal.any([o.signal, AbortSignal.timeout(30_000)]) });
      if (res.status === 404) throw new SttError('STT_JOB_LOST', 'Dịch vụ nhận dạng lời nói không còn nhớ việc này', true, 404);
      const text = await res.text();
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        /* không phải JSON */
      }
      if (res.ok) {
        failures = 0;
        const raw = extractResult(body);
        if (raw) {
          const v = toVerbose(raw);
          // Phản hồi thật của GET /v1/stt/jobs/{id} có `text` + `segments` nhưng KHÔNG có `words`: thiếu mốc từng từ thì không dùng được (câu và điểm cắt cần mốc từ).
          if (!v.words.length && v.text.trim()) throw new SttError('STT_JOB_NO_WORDS', 'Kết quả lấy lại theo job id không có mốc thời gian từng từ', true);
          return v;
        }
        const status = isRec(body) ? String(body.status ?? body.state ?? '').toLowerCase() : '';
        if (['failed', 'error', 'errored', 'cancelled', 'canceled'].includes(status)) {
          const e = isRec(body) && isRec(body.error) ? body.error : null;
          const msg = e && typeof e.message === 'string' ? e.message : isRec(body) && typeof body.error === 'string' ? body.error : 'không rõ lý do';
          throw new SttError('STT_FAILED', `Nhận dạng lời nói thất bại: ${msg}`, e?.retryable === true);
        }
        // queued / running / processing / không rõ: hỏi tiếp
      } else {
        const err = parseErrorBody(text);
        if (!(err.retryable || res.status >= 500)) throw new SttError('STT_REJECTED', `Dịch vụ nhận dạng lời nói từ chối truy vấn kết quả: ${err.message}`, false, res.status);
        failures++;
        if (failures > 5) throw new SttError('STT_UNAVAILABLE', `${NETWORK_MESSAGE} (${err.message})`, true, res.status);
      }
    } catch (e) {
      if (o.signal.aborted) throw new SttCancelled();
      if (e instanceof SttError) throw e;
      failures++;
      if (failures > 5) throw new SttError('STT_UNAVAILABLE', `${NETWORK_MESSAGE} (${describe(e)})`, true);
    }
    await sleep(o.pollMs, o.signal);
  }
}

/** Chỉ lấy kết quả theo job id (khôi phục sau khi server khởi động lại). */
export async function fetchJobResult(jobId: string, o: SttCallOptions): Promise<SttOutcome> {
  o.onJobId?.(jobId);
  return { result: await pollJob(jobId, o), jobId };
}
