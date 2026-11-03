/**
 * Chuẩn hoá chính tả / ngữ nghĩa của kết quả nhận dạng lời nói bằng một model AI nhẹ, TRƯỚC khi transcript được hiển thị.
 *
 * - AI chỉ nhận và trả CHỮ của từng câu (theo id câu); mốc thời gian không bao giờ lấy từ AI: chữ đã sửa được so khớp lại với dãy từ ASR
 *   (`alignWords`, quy hoạch động theo token) để từ trùng giữ nguyên mốc, đoạn bị thay chia đều thời gian của đoạn gốc theo độ dài chữ.
 * - Câu bị sửa quá nhiều (AI viết lại / bịa thêm) thì giữ bản ASR của câu đó.
 * - Lỗi AI (chưa có key, mất mạng, model từ chối…) KHÔNG làm hỏng nhận dạng: trả `null` kèm lý do, transcript gốc được dùng.
 */
import type { AppContext } from '../../context.js';
import { modelCandidates, modelRejection, withModelFallback } from '../../lib/ai-routing.js';
import { assembleStream } from '../ai/router.js';
import { normToken, type Transcript, type TWord } from './transcript.js';

export interface TranscriptFixInfo {
  /** Model đã dùng; null khi không chạy được. */
  model: string | null;
  /** Số từ ASR bị thay/bỏ/thêm. */
  changed_words: number;
  /** Số câu đã gửi / số câu AI sửa được chấp nhận / số câu bị từ chối vì sửa quá tay. */
  sentences: number;
  accepted: number;
  rejected: number;
  /** Lý do không chuẩn hoá được (bản ASR gốc được dùng). */
  error: string | null;
  at: string;
}

/** Thứ tự ưu tiên khi tự chọn model nhẹ trong `/models` (khớp theo tên ID, không phân biệt hoa thường). */
const FAST_MODEL_PATTERNS = [/haiku/i, /flash-lite|[-_.]lite\b/i, /[-_.]mini\b|-mini-/i, /flash/i, /nano|small/i];

/** Model nhẹ dùng để chuẩn hoá: `AI_FAST_MODEL` nếu có trong danh sách (hoặc không lấy được danh sách), không thì tự chọn theo tên, cuối cùng là `AI_MODEL`. */
export function pickFastModel(ids: string[] | null, configured: string, fallback: string): string {
  if (configured && (!ids || ids.includes(configured))) return configured;
  if (ids) {
    for (const re of FAST_MODEL_PATTERNS) {
      const hit = ids.filter((id) => re.test(id)).sort().reverse()[0]; // nhiều bản: lấy ID "mới" nhất theo tên
      if (hit) return hit;
    }
  }
  return fallback;
}

export async function resolveFastModel(ctx: AppContext): Promise<string> {
  return (await modelCandidates(ctx, { task: 'fast' }))[0] ?? (ctx.config.aiFastModel || ctx.config.aiModel);
}

// ---------------------------------------------------------------- so khớp chữ đã sửa với từ ASR

type Op = { kind: 'eq' | 'sub'; a: number; b: number } | { kind: 'del'; a: number } | { kind: 'ins'; b: number };

/** Căn hai dãy token (đã chuẩn hoá) bằng khoảng cách sửa (Levenshtein theo token). */
function alignTokens(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const d: number[][] = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      d[i]![j] = Math.min(d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1), d[i - 1]![j]! + 1, d[i]![j - 1]! + 1);
    }
  }
  const ops: Op[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i]![j] === d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)) {
      ops.push({ kind: a[i - 1] === b[j - 1] ? 'eq' : 'sub', a: i - 1, b: j - 1 });
      i--;
      j--;
    } else if (i > 0 && d[i]![j] === d[i - 1]![j]! + 1) {
      ops.push({ kind: 'del', a: i - 1 });
      i--;
    } else {
      ops.push({ kind: 'ins', b: j - 1 });
      j--;
    }
  }
  return ops.reverse();
}

export interface AlignedWord {
  w: string;
  start: number;
  end: number;
  p: number;
}

/**
 * Ghép chữ đã sửa (`corrected`, tách theo khoảng trắng) vào mốc thời gian của `orig`. Từ trùng (bỏ dấu câu, chữ thường) giữ nguyên mốc của từ gốc;
 * mỗi đoạn khác nhau liên tiếp lấy khoảng thời gian của các từ gốc trong đoạn rồi chia cho các từ mới theo độ dài chữ. Đoạn chỉ có từ thêm
 * (không có từ gốc) nằm gọn trong khe giữa hai từ kề. Trả về dãy từ mới và số từ đã đổi.
 */
export function alignWords(orig: Pick<TWord, 'w' | 'start' | 'end' | 'p'>[], corrected: string): { words: AlignedWord[]; changed: number } {
  const toks = corrected.split(/\s+/).filter(Boolean);
  const ops = alignTokens(orig.map((w) => normToken(w.w)), toks.map(normToken));
  const out: AlignedWord[] = [];
  let changed = 0;
  let k = 0;
  while (k < ops.length) {
    const op = ops[k]!;
    if (op.kind === 'eq') {
      const o = orig[op.a]!;
      out.push({ w: toks[op.b]!, start: o.start, end: o.end, p: o.p });
      k++;
      continue;
    }
    // gom một đoạn khác nhau liên tiếp
    const span: Op[] = [];
    while (k < ops.length && ops[k]!.kind !== 'eq') span.push(ops[k++]!);
    const as = span.flatMap((s) => (s.kind === 'ins' ? [] : [s.a]));
    const bs = span.flatMap((s) => (s.kind === 'del' ? [] : [s.b]));
    changed += Math.max(as.length, bs.length);
    if (bs.length === 0) continue; // chỉ bỏ từ
    let t0: number;
    let t1: number;
    let p = 1;
    if (as.length) {
      t0 = orig[as[0]!]!.start;
      t1 = orig[as[as.length - 1]!]!.end;
      p = Math.min(...as.map((x) => orig[x]!.p));
    } else {
      const prev = out[out.length - 1];
      const nextOp = ops[k];
      const next = nextOp && nextOp.kind === 'eq' ? orig[nextOp.a] : undefined;
      t0 = prev?.end ?? next?.start ?? 0;
      t1 = next?.start ?? t0;
      if (t1 <= t0) t1 = t0; // không có khe: từ thêm có thời lượng 0, buildTranscript nới tối thiểu
    }
    const lens = bs.map((b) => Math.max(1, toks[b]!.length));
    const total = lens.reduce((x, y) => x + y, 0);
    let cur = t0;
    bs.forEach((b, idx) => {
      const dur = ((t1 - t0) * lens[idx]!) / total;
      const end = idx === bs.length - 1 ? t1 : cur + dur;
      out.push({ w: toks[b]!, start: cur, end, p });
      cur = end;
    });
  }
  return { words: out, changed };
}

/** Câu bị sửa quá tay (AI diễn đạt lại / thêm bớt nội dung) thì không nhận: tỉ lệ từ đổi > ngưỡng, hoặc số từ lệch quá nhiều. */
export const MAX_CHANGED_RATIO = 0.5;
function acceptable(origCount: number, newCount: number, changed: number): boolean {
  if (newCount === 0) return false;
  if (origCount <= 3) return changed <= 2 && Math.abs(newCount - origCount) <= 2;
  return changed / origCount <= MAX_CHANGED_RATIO && newCount <= origCount * 1.5 + 2 && newCount >= origCount * 0.5;
}

// ---------------------------------------------------------------- gọi AI

const SYSTEM_PROMPT = `Bạn là biên tập viên chuẩn hoá bản ghi lời nói tiếng Việt do hệ thống nhận dạng giọng nói (ASR) tạo ra.
Nhiệm vụ với TỪNG câu:
- Sửa lỗi chính tả, lỗi dấu thanh và các từ bị nghe nhầm thành từ gần âm nhưng sai nghĩa, dựa vào ngữ cảnh các câu xung quanh.
- Viết đúng tên riêng, tên sản phẩm, thương hiệu, thuật ngữ (ưu tiên đúng cách viết trong danh sách thuật ngữ nếu có).
- Thêm dấu câu và viết hoa đúng chuẩn tiếng Việt.
KHÔNG được: tóm tắt, diễn đạt lại, đổi thứ tự, thêm ý mới, bỏ ý, gộp hay tách câu, dịch sang ngôn ngữ khác. Giữ nguyên các từ đệm/khẩu ngữ người nói thật sự nói.
Câu đã đúng thì trả lại nguyên văn (có thể thêm dấu câu).
Chỉ trả về JSON đúng dạng {"s":[{"id":<số>,"t":"<câu đã chuẩn hoá>"}]}, đủ mọi id đã nhận, không kèm giải thích.`;

const BATCH_WORDS = 1500;
const CONCURRENCY = 3;
const CALL_TIMEOUT_MS = 180_000;

class FixError extends Error {}

async function callModel(ctx: AppContext, model: string, user: string, signal: AbortSignal): Promise<string> {
  const { aiApiUrl, aiApiKey } = ctx.config;
  const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
  let res: Response;
  let raw: string;
  try {
    res = await fetch(`${aiApiUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${aiApiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ model, stream: true, temperature: 0, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: user }] }),
      signal: AbortSignal.any([signal, timeout]),
      redirect: 'error',
    });
    raw = await res.text();
  } catch {
    if (signal.aborted) throw new FixError('đã hủy');
    throw new FixError(timeout.aborted ? 'API AI không trả lời kịp' : 'không kết nối được API AI');
  }
  if (res.status === 401 || res.status === 403) throw new FixError('máy chủ AI từ chối API key');
  const rejected = modelRejection(ctx, res.status, raw, res.headers.get('retry-after'));
  if (rejected) throw rejected;
  if (!res.ok) throw new FixError(`API AI trả lỗi HTTP ${res.status} (model ${model})`);
  if (/^\s*\{/.test(raw)) {
    try {
      const body = JSON.parse(raw) as { choices?: { message?: { content?: string | null } }[] };
      return body.choices?.[0]?.message?.content ?? '';
    } catch {
      throw new FixError('API AI trả về không hợp lệ');
    }
  }
  return assembleStream(raw)?.message.content ?? '';
}

/** Lấy object JSON đầu tiên trong câu trả lời (model có thể bọc trong ```json). */
function parseReply(text: string): Map<number, string> {
  const from = text.indexOf('{');
  const to = text.lastIndexOf('}');
  if (from < 0 || to <= from) throw new FixError('AI không trả JSON');
  let body: { s?: { id?: unknown; t?: unknown }[] };
  try {
    body = JSON.parse(text.slice(from, to + 1));
  } catch {
    throw new FixError('AI trả JSON lỗi');
  }
  const out = new Map<number, string>();
  for (const x of body.s ?? []) if (typeof x.id === 'number' && typeof x.t === 'string') out.set(x.id, x.t.replace(/\s+/g, ' ').trim());
  return out;
}

/**
 * Chuẩn hoá cả transcript: chia câu thành lô (~1500 từ), gọi model nhẹ song song tối đa 3 lô, so khớp lại mốc thời gian.
 * Trả dãy từ mới (để `buildTranscript` dựng lại câu) và thông tin; `words: null` = không dùng được kết quả AI (xem `info.error`).
 */
export async function fixTranscript(
  ctx: AppContext,
  t: Pick<Transcript, 'words' | 'sentences' | 'terms'>,
  signal: AbortSignal,
): Promise<{ words: AlignedWord[] | null; info: TranscriptFixInfo }> {
  const info: TranscriptFixInfo = { model: null, changed_words: 0, sentences: t.sentences.length, accepted: 0, rejected: 0, error: null, at: ctx.now() };
  if (!ctx.config.aiApiUrl || !ctx.config.aiApiKey) return { words: null, info: { ...info, error: 'chưa có API key của máy chủ AI (nhập trong Cài đặt)' } };
  if (t.sentences.length === 0) return { words: null, info };
  const batches: Transcript['sentences'][] = [];
  let cur: Transcript['sentences'] = [];
  let count = 0;
  for (const s of t.sentences) {
    const n = s.end_word - s.start_word + 1;
    if (cur.length && count + n > BATCH_WORDS) {
      batches.push(cur);
      cur = [];
      count = 0;
    }
    cur.push(s);
    count += n;
  }
  if (cur.length) batches.push(cur);

  const fixed = new Map<number, string>();
  const terms = t.terms?.trim();
  let failure: string | null = null;
  let next = 0;
  const worker = async () => {
    while (next < batches.length && !failure && !signal.aborted) {
      const batch = batches[next++]!;
      const user =
        (terms ? `Thuật ngữ / tên riêng hay xuất hiện: ${terms}\n\n` : '') +
        `Các câu cần chuẩn hoá (JSON):\n${JSON.stringify(batch.map((s) => ({ id: s.id, t: s.text })))}`;
      try {
        const result = await withModelFallback(ctx, { task: 'fast', signal }, async (id) => ({ text: await callModel(ctx, id, user, signal), model: id }));
        info.model = result.model;
        const reply = parseReply(result.text);
        for (const [id, text] of reply) fixed.set(id, text);
      } catch (e) {
        failure ??= e instanceof FixError ? e.message : e instanceof Error ? e.message : String(e);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
  if (signal.aborted) return { words: null, info: { ...info, error: 'đã hủy' } };
  if (failure) return { words: null, info: { ...info, error: failure } };

  const words: AlignedWord[] = [];
  let wi = 0;
  for (const s of t.sentences) {
    // từ nằm ngoài mọi câu (nếu có) giữ nguyên
    for (; wi < s.start_word; wi++) words.push(pick(t.words[wi]!));
    const orig = t.words.slice(s.start_word, s.end_word + 1);
    const text = fixed.get(s.id);
    const aligned = text ? alignWords(orig, text) : null;
    if (aligned && acceptable(orig.length, aligned.words.length, aligned.changed)) {
      words.push(...aligned.words);
      info.changed_words += aligned.changed;
      info.accepted++;
    } else {
      if (aligned) info.rejected++;
      words.push(...orig.map(pick));
    }
    wi = s.end_word + 1;
  }
  for (; wi < t.words.length; wi++) words.push(pick(t.words[wi]!));
  return { words, info };
}

const pick = (w: TWord): AlignedWord => ({ w: w.w, start: w.start, end: w.end, p: w.p });
