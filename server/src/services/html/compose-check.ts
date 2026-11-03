/**
 * Kiểm tra giữa chừng cho worker `html_compose` (`POST /api/worker/jobs/:id/html-check`): manifest + biến + (ghi vào thư mục tạm) lint của engine,
 * tùy chọn chụp vài khung hình để model vision xem. KHÔNG đổi trạng thái phiên bản/job và không công bố gì: chỉ trả báo cáo để worker sửa tiếp.
 * Kết quả cuối vẫn do `/complete` kiểm tra lại (hook `validateComposition`) nên endpoint này chỉ là phản hồi sớm.
 * Hủy: poll job/phiên bản còn active mỗi ~1,5 giây và hủy chụp khung; thư mục tạm luôn bị xoá.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import type { JobRow } from '../../db/types.js';
import { AppError } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { parseJson } from '../repo.js';
import { snapshotVersionAssets } from './assets.js';
import { versionAssetIds, versionOfJob } from './repo.js';
import { validateManifest, writeStaging } from './safe-path.js';
import { checkVariables, normalizeVariable, variablesSchema } from './variables.js';
import type { HtmlAspect, LintReport } from './view.js';
import { withVoice } from './voice-overlay.js';
import type { VoiceSnapshot } from './voice.js';
import { prefixSegmentVariables } from './segment-files.js';

export const checkBody = z.object({
  files: z.unknown(),
  summary: z.string().max(2000).optional(),
  variables: z.unknown().optional(),
  capture: z.boolean().default(false),
});

export interface CheckFrame {
  t: number;
  png_base64: string;
}
export interface HtmlCheckResult {
  report: LintReport;
  frames?: CheckFrame[];
}

/** Điểm tựa của engine (W1a lint) và chụp khung (W1b), thay được trong test. */
export interface CheckEngine {
  lint(dir: string, o: { aspect: HtmlAspect; durationS: number }): Promise<LintReport>;
  capture(ctx: AppContext, o: { projectId: number; aspect: HtmlAspect; durationS: number; stagingDir: string; times: number[]; signal: AbortSignal }): Promise<Buffer[]>;
}
let injected: CheckEngine | null = null;
export const setCheckEngine = (e: CheckEngine | null): void => {
  injected = e;
};
const defaultEngine: CheckEngine = {
  lint: async (dir, o) => (await import('./engine/index.js')).lintComposition(dir, o),
  capture: async (ctx, o) => (await import('./render.js')).captureForVision(ctx, o),
};

/** Tối đa số khung gửi cho vision. */
export const MAX_FRAMES = 5;

/**
 * Các mốc chụp (giây): 0,2d / 0,5d / 0,85d (tránh khung mở và khung cuối) cùng tối đa 2 mốc ngay sau điểm bắt đầu của các phần tử `data-start`
 * (chuyển cảnh) nếu cách mốc có sẵn ≥ 0,6 giây. Luôn trong (0, d).
 */
export function captureTimes(durationS: number, files: { path: string; content: string }[]): number[] {
  const d = durationS;
  const base = [0.2 * d, 0.5 * d, 0.85 * d];
  const starts = new Set<number>();
  for (const f of files) {
    if (f.path !== 'index.html' && !f.path.startsWith('compositions/')) continue;
    for (const m of f.content.matchAll(/data-start\s*=\s*["']?(\d+(?:\.\d+)?)/g)) {
      const s = Number(m[1]) + 0.3;
      if (s > 0.5 && s < d - 0.5) starts.add(Math.round(s * 10) / 10);
    }
  }
  const out = [...base];
  for (const s of [...starts].sort((a, b) => a - b)) {
    if (out.length >= MAX_FRAMES) break;
    if (out.every((t) => Math.abs(t - s) >= 0.6)) out.push(s);
  }
  return out.map((t) => Math.round(Math.min(Math.max(t, 0.1), d - 0.1) * 100) / 100).sort((a, b) => a - b);
}

const failReport = (code: string, message: string, checks: string[]): LintReport => ({ ok: false, errors: [{ code, message }], warnings: [], checks });

export async function runHtmlCheck(ctx: AppContext, job: JobRow, rawBody: unknown, o: { signal?: AbortSignal } = {}): Promise<HtmlCheckResult> {
  const body = parse(checkBody, rawBody ?? {});
  const version = versionOfJob(ctx, job.id);
  const active = () => {
    const v = versionOfJob(ctx, job.id);
    const j = ctx.db.prepare('SELECT status FROM jobs WHERE id = ?').get(job.id) as { status: string } | undefined;
    return !!v && (v.status === 'composing' || v.status === 'validating') && (j?.status === 'claimed' || j?.status === 'running');
  };
  const assertActive = () => {
    if (!active()) throw new AppError('JOB_CANCELLED', 'Job/phiên bản không còn hoạt động; bỏ kiểm tra', 409);
  };
  if (!version) throw new AppError('VERSION_NOT_ACTIVE', 'Không còn phiên bản Video HTML ứng với job này', 409);
  assertActive();
  const spec = parseJson<{ spec?: { aspect?: HtmlAspect; duration_s?: number } }>(job.payload, {}).spec ?? {};
  const aspect = spec.aspect ?? '9:16';
  const durationS = spec.duration_s ?? 10;

  // 1. manifest + biến: lỗi dữ liệu trả thành báo cáo (worker coi như lỗi lint để sửa), không ném
  let checked;
  try {
    const idx = parseJson<{segment?:{idx:number}}>(job.payload,{}).segment?.idx;
    const prefixed = prefixSegmentVariables(validateManifest(body.files), parse(variablesSchema,body.variables ?? [],'Biến'),idx);
    checked = validateManifest(withVoice(prefixed.files, parseJson<VoiceSnapshot | null>(version.voice_json ?? null, null), aspect, {captionsOnly:!!version.segment_owner_id}));
    const vars = prefixed.variables.map((v) => normalizeVariable(v, versionAssetIds(ctx, version.id)));
    checkVariables(checked, vars);
  } catch (err) {
    if (err instanceof AppError && err.status === 400) return { report: failReport(err.code, err.message, ['manifest']) };
    throw err;
  }
  assertActive();

  // 2. ghi vào thư mục tạm (cùng đường đi an toàn như staging) rồi lint
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-check-'));
  const abort = new AbortController();
  const onOuter = () => abort.abort();
  o.signal?.addEventListener('abort', onOuter);
  const poll = setInterval(() => {
    if (!active()) abort.abort();
  }, 1500);
  try {
    const dir = path.join(tmp, 'site');
    writeStaging(dir, checked);
    snapshotVersionAssets(ctx, version.id, dir);
    const engine = injected ?? defaultEngine;
    const report = await engine.lint(dir, { aspect, durationS });
    assertActive();
    report.checks = [...new Set([...(report.checks ?? []), 'manifest', 'lint'])];
    if (!body.capture || !report.ok) return { report };

    // 3. chụp khung (không chặn: thiếu trình duyệt/lỗi chụp → cảnh báo, bỏ vision)
    try {
      const times = captureTimes(durationS, checked);
      const pngs = await engine.capture(ctx, { projectId: version.project_id, aspect, durationS, stagingDir: dir, times, signal: abort.signal });
      assertActive();
      report.checks.push('capture');
      return { report, frames: pngs.map((p, i) => ({ t: times[i]!, png_base64: p.toString('base64') })) };
    } catch (err) {
      if (abort.signal.aborted || (err instanceof AppError && err.code === 'JOB_CANCELLED')) throw new AppError('JOB_CANCELLED', 'Job/phiên bản đã bị hủy trong lúc chụp khung', 409);
      const missing = err instanceof AppError && err.code === 'HTML_RENDERER_MISSING';
      report.warnings.push({
        code: missing ? 'CAPTURE_SKIPPED_NO_BROWSER' : 'CAPTURE_FAILED',
        message: missing ? 'Chưa cài Bộ dựng Video HTML nên bỏ bước chụp khung hình và vision (Cài đặt > Bộ dựng Video HTML).' : `Không chụp được khung hình, bỏ bước vision: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
      });
      return { report };
    }
  } finally {
    clearInterval(poll);
    o.signal?.removeEventListener('abort', onOuter);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
