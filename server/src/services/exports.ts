import type { AppContext } from '../context.js';
import type { LedgerRow } from '../db/types.js';
import { getProject, ledgerJson } from './repo.js';
import { budgetNumbers } from './budget.js';

export function ledgerEntries(ctx: AppContext, projectId: number) {
  const rows = ctx.db
    .prepare(
      `SELECT l.*, s.code AS scene_code FROM credit_ledger l LEFT JOIN scenes s ON s.id = l.scene_id
       WHERE l.project_id = ? ORDER BY l.created_at, l.id`,
    )
    .all(projectId) as (LedgerRow & { scene_code: string | null })[];
  return rows.map(ledgerJson);
}

/** Sổ cái credit (`GET /api/projects/:id/ledger`): tổng đã dùng/đặt trước + dòng kèm `cumulative_used` (lũy kế đã tiêu). */
export function ledgerView(ctx: AppContext, projectId: number) {
  const project = getProject(ctx, projectId);
  const entries = ledgerEntries(ctx, projectId);
  let cumulative = 0;
  const withCumulative = entries.map((e) => {
    cumulative -= e.delta;
    return { ...e, cumulative_used: cumulative };
  });
  const { used, reserved } = budgetNumbers(ctx, project);
  return { totals: { used, reserved }, entries: withCumulative };
}

const csvCell = (v: string | number | null): string => {
  const s = v === null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV UTF-8 có BOM để Excel đọc đúng tiếng Việt. */
export function ledgerCsv(ctx: AppContext, projectId: number): string {
  const { entries } = ledgerView(ctx, projectId);
  const lines = [['STT', 'Thời gian', 'Cảnh', 'Job', 'Credit', 'Lũy kế đã dùng', 'Ghi chú'].map(csvCell).join(',')];
  entries.forEach((e, i) => {
    lines.push([i + 1, e.created_at, e.scene_code, e.job_id, e.delta, e.cumulative_used, e.note].map(csvCell).join(','));
  });
  return '﻿' + lines.join('\r\n') + '\r\n';
}
