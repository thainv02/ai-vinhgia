import type { AppContext } from '../../context.js';
import type { JobRow } from '../../db/types.js';
import { conflict } from '../../lib/errors.js';
import { emitJob, parseJson } from '../repo.js';
import { getHtmlProject, projectAssets } from './repo.js';

export const pendingImageLabels = (ctx: AppContext, id: number) => projectAssets(ctx, id).filter((a) => a.kind === 'image' && a.scan_error_code && !a.label_confirmed);
export function assertImageLabels(ctx: AppContext, id: number) {
  if (pendingImageLabels(ctx, id).length) throw conflict('IMAGE_LABELS_REQUIRED', 'Có ảnh chưa đọc được nội dung. Hãy gán nhãn và xác nhận trước khi tạo video.');
}
/** Nhãn + xác nhận lưu nguyên tử; chỉ tiếp tục job chờ ảnh, giữ checkpoint và id job. */
export function confirmImageLabels(ctx: AppContext, id: number, labels: { id: number; label: string }[]) {
  return ctx.tx(() => {
    getHtmlProject(ctx, id);
    if (ctx.db.prepare("SELECT id FROM jobs WHERE project_id=? AND type='html_compose' AND status IN ('claimed','running') LIMIT 1").get(id)) throw conflict('IMAGE_SCAN_BUSY', 'Đợi quét ảnh xong trước khi xác nhận nhãn');
    const pending = pendingImageLabels(ctx, id);
    const provided = new Map(labels.map((a) => [a.id, a.label.trim()]));
    if (!pending.length || provided.size !== labels.length || provided.size !== pending.length || pending.some((a) => !provided.get(a.id))) throw conflict('IMAGE_LABELS_CHANGED', 'Danh sách ảnh cần gán nhãn đã thay đổi. Hãy kiểm tra lại và xác nhận đủ các ảnh.');
    for (const a of pending) {
      const label = provided.get(a.id)!;
      ctx.db.prepare('UPDATE html_assets SET manual_label=?,label_confirmed=1,description_json=? WHERE id=? AND project_id=?').run(label, JSON.stringify({ summary: label, text: '', details: 'Nhãn do người dùng kiểm tra và xác nhận', uncertain: false }), a.id, id);
    }
    const assets = new Map(projectAssets(ctx, id).map((a) => [a.id, a]));
    const jobs = ctx.db.prepare("SELECT * FROM jobs WHERE project_id=? AND type='html_compose' AND status='queued'").all(id) as JobRow[];
    let resumed = 0;
    for (const job of jobs) {
      const payload = parseJson<{ assets?: { id: number; description?: unknown }[] }>(job.payload, {});
      const version = ctx.db.prepare('SELECT id FROM html_versions WHERE compose_job_id=?').get(job.id) as { id: number } | undefined;
      for (const asset of payload.assets ?? []) {
        const a = assets.get(asset.id);
        const snapshot = ctx.db.prepare('SELECT content_hash FROM html_version_assets WHERE version_id=? AND asset_ref=?').get(version?.id ?? -1, asset.id) as { content_hash: string } | undefined;
        if (a?.description_json && snapshot?.content_hash === a.content_hash) asset.description = parseJson(a.description_json, null);
      }
      ctx.db.prepare('UPDATE jobs SET payload=? WHERE id=?').run(JSON.stringify(payload), job.id);
      if (job.wait_reason === 'image_labels') {
        ctx.db.prepare("UPDATE jobs SET wait_reason=NULL,next_attempt_at=NULL WHERE id=? AND status='queued' AND wait_reason='image_labels'").run(job.id);
        emitJob(ctx, job.id, id);
        resumed++;
      }
    }
    ctx.publish('project.updated', id, { project_id: id });
    return { ok: true, resumed };
  });
}
