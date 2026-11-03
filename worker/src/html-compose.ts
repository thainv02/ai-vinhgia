/**
 * Vòng compose của job `html_compose`: worker điều phối DUY NHẤT (server chỉ kiểm tra qua `html-check` và công bố khi `/complete`).
 *
 *   compose → check(lint) → [≤ 2 lượt sửa lint] → [có model vision: check(capture) → 1 lượt vision → nếu có vấn đề: 1 lượt sửa] → check(lint) lần cuối → kết quả
 *
 * Trần cứng: ≤ 2 lượt sửa lint (mọi lần sửa do lint/JSON hỏng/`/complete` từ chối), ≤ 1 lượt vision, ≤ 6 infer TỔNG (kể cả vision). Checkpoint sau MỖI infer
 * (`ComposeState`, JSON thuần); resume tiếp từ trạng thái đã lưu, không gọi lại infer đã có kết quả. Logic thuần: mọi IO qua `deps` (test dùng đồ giả).
 */
import {
  composeSystemPrompt, composeUserText, jsonRepairText, lintFixText, visionFixText, visionMessages,
  type Frame, type HtmlComposePayload, type HtmlFile, type HtmlVar, type ReportLike, type VisionIssue,
} from './html-prompts.js';

export const MAX_INFERS = 6;
export const MAX_LINT_FIXES = 2;
export const MAX_VISION = 1;

export type ChatPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export interface ChatMsg {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatPart[];
}
export type InferPurpose = 'compose' | 'vision';

export interface ComposeResult {
  files: HtmlFile[];
  summary: string;
  variables: HtmlVar[];
}
export interface CheckReport extends ReportLike {
  ok: boolean;
  checks?: string[];
}
export interface CheckOut {
  report: CheckReport;
  frames?: Frame[];
}

export interface ComposeDeps {
  infer(messages: ChatMsg[], purpose: InferPurpose): Promise<{ content: string }>;
  check(candidate: ComposeResult, capture: boolean): Promise<CheckOut>;
  checkpoint(state: ComposeState): Promise<void>;
  alive(): Promise<void>;
  log(message: string): void;
}

export type ComposeStage = 'compose' | 'lint' | 'vision' | 'vision_fix' | 'final' | 'done';
export interface ComposeState {
  version: 1;
  stage: ComposeStage;
  /** Tổng lượt infer đã THÀNH CÔNG (kể cả vision). */
  infers: number;
  lint_fixes: number;
  vision_infers: number;
  candidate: ComposeResult | null;
  /** Bộ file gần nhất đã qua lint (dự phòng nếu lượt sửa vision làm hỏng và hết ngân sách sửa). */
  good: ComposeResult | null;
  vision_issues: VisionIssue[] | null;
}
export const freshState = (): ComposeState => ({ version: 1, stage: 'compose', infers: 0, lint_fixes: 0, vision_infers: 0, candidate: null, good: null, vision_issues: null });

export class HtmlComposeError extends Error {
  readonly code = 'HTML_COMPOSE_FAILED';
  constructor(message: string, readonly report?: ReportLike) {
    super(message);
    this.name = 'HtmlComposeError';
  }
}

// ---------------------------------------------------------------- đọc JSON chắc chắn

/** Tìm đối tượng JSON `{…}` cân bằng bắt đầu tại `from` (tôn trọng chuỗi/escape). */
function balancedObject(text: string, from: number): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(from, i + 1);
  }
  return null;
}

/** Rút một đối tượng JSON từ phản hồi model: chịu được ```json fence, lời dẫn trước/sau, BOM. Ưu tiên đối tượng có `files`. Ném Error nếu không có. */
export function extractJson(raw: string): Record<string, unknown> {
  const text = raw.replace(/^﻿/, '').trim();
  const cands: string[] = [text];
  for (const m of text.matchAll(/```(?:json|JSON)?\s*\n?([\s\S]*?)```/g)) cands.push(m[1]!.trim());
  let found: Record<string, unknown> | null = null;
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const v: unknown = JSON.parse(s);
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  for (const c of cands) {
    const direct = tryParse(c);
    if (direct) {
      if ('files' in direct) return direct;
      found ??= direct;
      continue;
    }
    let at = c.indexOf('{');
    for (let n = 0; at >= 0 && n < 12; n++) {
      const obj = balancedObject(c, at);
      const v = obj ? tryParse(obj) : null;
      if (v) {
        if ('files' in v) return v;
        found ??= v;
        at = c.indexOf('{', at + obj!.length); // bỏ qua cả đối tượng vừa đọc (không có files), tìm tiếp
      } else at = c.indexOf('{', at + 1);
    }
  }
  if (found) return found;
  throw new Error('không tìm thấy đối tượng JSON');
}

/** Chuẩn hoá `{files, summary, variables}`: `files` là mảng {path, content} (hoặc map path → content). Ném Error nếu thiếu/sai kiểu. */
export function parseComposeResult(raw: string): ComposeResult {
  const o = extractJson(raw);
  let files: HtmlFile[];
  if (Array.isArray(o.files)) {
    files = o.files.map((f, i) => {
      const r = f as { path?: unknown; content?: unknown };
      if (!r || typeof r.path !== 'string' || typeof r.content !== 'string') throw new Error(`files[${i}] cần {path, content} dạng chuỗi`);
      return { path: r.path.replace(/^\.\//, ''), content: r.content };
    });
  } else if (o.files && typeof o.files === 'object') {
    files = Object.entries(o.files as Record<string, unknown>).map(([p, c]) => {
      if (typeof c !== 'string') throw new Error(`files["${p}"] phải là chuỗi`);
      return { path: p.replace(/^\.\//, ''), content: c };
    });
  } else throw new Error('thiếu "files"');
  if (!files.length) throw new Error('"files" rỗng');
  const variables = Array.isArray(o.variables) ? (o.variables as HtmlVar[]) : [];
  return { files, summary: typeof o.summary === 'string' ? o.summary.trim().slice(0, 2000) : '', variables };
}

/** Nhận xét vision: lỏng, không đọc được → coi như không có vấn đề. Chỉ giữ high/medium (low bỏ qua). */
export function parseVisionIssues(raw: string): VisionIssue[] {
  let o: Record<string, unknown>;
  try {
    o = extractJson(raw);
  } catch {
    return [];
  }
  const arr = Array.isArray(o.issues) ? (o.issues as Record<string, unknown>[]) : [];
  const out: VisionIssue[] = [];
  for (const i of arr) {
    if (!i || typeof i.problem !== 'string' || !i.problem.trim()) continue;
    const sev = i.severity === 'high' || i.severity === 'low' ? i.severity : 'medium';
    if (sev === 'low') continue;
    out.push({ severity: sev, ...(typeof i.time === 'number' ? { time: i.time } : {}), problem: i.problem.trim().slice(0, 300), ...(typeof i.fix === 'string' ? { fix: i.fix.trim().slice(0, 300) } : {}) });
  }
  return o.ok === true && !out.some((i) => i.severity === 'high') ? [] : out;
}

// ---------------------------------------------------------------- vòng chạy

const compact = (c: ComposeResult): string => JSON.stringify({ files: c.files, summary: c.summary, variables: c.variables });
const wantsVision = (p: HtmlComposePayload): boolean => !!p.policy?.vision && p.policy.vision !== 'none';
const errCode = (e: unknown): string | undefined => (e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : undefined);

export interface ComposeOutcome {
  result: ComposeResult;
  state: ComposeState;
}

/**
 * Chạy (hoặc tiếp tục) vòng compose. `opts.rejection`: `/complete` của server từ chối bộ file (400) → tính là một lượt sửa lint nếu còn ngân sách
 * (hết ngân sách → HtmlComposeError). Ném `HtmlComposeError` (code HTML_COMPOSE_FAILED) khi bộ file cuối còn lỗi; lỗi của `deps.infer`
 * (AI_UNAVAILABLE…) được ném nguyên để runner xếp job chờ.
 */
export async function runHtmlCompose(payload: HtmlComposePayload, deps: ComposeDeps, resume?: ComposeState | null, opts: { rejection?: ReportLike } = {}): Promise<ComposeOutcome> {
  const st: ComposeState = resume?.version === 1 ? { ...freshState(), ...resume } : freshState();
  const system = composeSystemPrompt(payload);
  const base = (): ChatMsg[] => [{ role: 'system', content: system }, { role: 'user', content: composeUserText(payload) }];
  const withFix = (c: ComposeResult, userText: string): ChatMsg[] => [...base(), { role: 'assistant', content: compact(c) }, { role: 'user', content: userText }];
  let lastReport: ReportLike | undefined;

  const fail = (why: string): never => {
    throw new HtmlComposeError(`${why}${lastReport ? `. Lỗi còn lại: ${lastReport.errors.slice(0, 5).map((e) => `[${e.code}] ${e.message}`).join('; ')}` : ''}`.slice(0, 1500), lastReport);
  };
  const save = () => deps.checkpoint(st);

  /** Một lượt infer: kiểm tra trần TRƯỚC khi gọi, tăng bộ đếm SAU khi thành công. */
  const infer = async (messages: ChatMsg[], purpose: InferPurpose): Promise<string> => {
    if (st.infers >= MAX_INFERS) fail(`Đã dùng hết ${MAX_INFERS} lượt gọi AI`);
    await deps.alive();
    const r = await deps.infer(messages, purpose);
    st.infers++;
    return r.content ?? '';
  };

  /** Sinh bộ file mới từ `messages`; JSON hỏng → xin lại (mỗi lần tính một lượt sửa lint). */
  const produce = async (messages: ChatMsg[]): Promise<ComposeResult> => {
    let msgs = messages;
    for (;;) {
      const text = await infer(msgs, 'compose');
      try {
        const r = parseComposeResult(text);
        return r;
      } catch (e) {
        const why = e instanceof Error ? e.message : 'JSON hỏng';
        deps.log(`phản hồi compose không hợp lệ: ${why}`);
        await save();
        if (st.lint_fixes >= MAX_LINT_FIXES) fail(`Model không trả JSON hợp lệ (${why})`);
        st.lint_fixes++;
        msgs = [...base(), { role: 'assistant', content: text.slice(0, 4000) }, { role: 'user', content: jsonRepairText(why) }];
      }
    }
  };

  const check = async (capture: boolean): Promise<CheckOut> => {
    await deps.alive();
    const out = await deps.check(st.candidate!, capture);
    if (!out.report.ok) lastReport = out.report;
    return out;
  };

  /** Bảo đảm `st.candidate` qua check(không chụp); lỗi → sửa tới hết ngân sách. `first` = báo cáo có sẵn (bị /complete từ chối hoặc lần chụp phát hiện lỗi). */
  const lintLoop = async (first?: ReportLike): Promise<void> => {
    let report: ReportLike = first ?? (await check(false)).report;
    let ok = first ? false : (report as CheckReport).ok;
    while (!ok) {
      lastReport = report;
      if (st.lint_fixes >= MAX_LINT_FIXES) fail(`Đã sửa ${MAX_LINT_FIXES} lượt nhưng bộ file vẫn chưa đạt kiểm tra`);
      st.lint_fixes++;
      st.candidate = await produce(withFix(st.candidate!, lintFixText(report)));
      await save();
      const r = (await check(false)).report;
      report = r;
      ok = r.ok;
    }
    st.good = st.candidate;
  };

  if (opts.rejection && st.candidate) {
    st.stage = 'lint';
    st.vision_issues = null;
  }
  let pendingRejection = opts.rejection && st.candidate ? opts.rejection : undefined;

  for (;;) {
    switch (st.stage) {
      case 'compose': {
        st.candidate = await produce(base());
        st.stage = 'lint';
        await save();
        break;
      }
      case 'lint': {
        const first = pendingRejection;
        pendingRejection = undefined;
        await lintLoop(first);
        st.stage = wantsVision(payload) && st.vision_infers < MAX_VISION ? 'vision' : 'done';
        await save();
        break;
      }
      case 'vision': {
        const out = await check(true);
        if (!out.report.ok) {
          st.stage = 'lint'; // lần chụp phát hiện lỗi lint (hiếm): quay lại vòng lint
          pendingRejection = out.report;
          break;
        }
        if (!out.frames?.length) {
          deps.log(`bỏ vision: ${out.report.warnings.find((w) => /CAPTURE/.test(w.code))?.message ?? 'không có khung hình'}`);
          st.vision_infers = MAX_VISION; // không thử lại
          st.stage = 'done';
          await save();
          break;
        }
        let text = '';
        try {
          text = await infer(visionMessages(payload, st.candidate!.summary, out.frames) as ChatMsg[], 'vision');
        } catch (e) {
          if (errCode(e) !== 'AI_INVALID_REQUEST') throw e;
          deps.log('model vision từ chối request: bỏ qua bước vision');
          st.vision_infers = MAX_VISION;
          st.stage = 'done';
          await save();
          break;
        }
        st.vision_infers++;
        const issues = parseVisionIssues(text);
        st.vision_issues = issues.length ? issues : null;
        st.stage = issues.length ? 'vision_fix' : 'done';
        deps.log(`vision: ${issues.length} vấn đề`);
        await save();
        break;
      }
      case 'vision_fix': {
        const issues = st.vision_issues ?? [];
        st.candidate = await produce(withFix(st.candidate!, visionFixText(issues)));
        st.stage = 'final';
        await save();
        break;
      }
      case 'final': {
        try {
          await lintLoop();
        } catch (e) {
          // lượt sửa vision làm hỏng và hết ngân sách: dùng lại bộ file đã qua lint trước đó (vision chỉ là gợi ý)
          if (!(e instanceof HtmlComposeError) || !st.good) throw e;
          deps.log('bộ file sau sửa vision không đạt lint, dùng lại bản đã đạt trước đó');
          st.candidate = st.good;
        }
        st.stage = 'done';
        await save();
        break;
      }
      case 'done': {
        if (!st.candidate) fail('Không có bộ file');
        return { result: st.candidate!, state: st };
      }
    }
  }
}
