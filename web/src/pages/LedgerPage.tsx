import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { buttonClass } from '../components/Button';
import { EventTimeline } from '../components/EventTimeline';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorState, Skeleton } from '../components/States';
import { useLedger, useProject } from '../hooks/queries';
import { fmtDateTimeYear, fmtSigned } from '../lib/format';
import { useDocumentTitle } from '../lib/useDocumentTitle';

type Tab = 'credit' | 'events';

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`text-xl font-bold tracking-tight ${tone ?? ''}`}>{value}</dd>
    </div>
  );
}

export default function LedgerPage() {
  const projectId = Number(useParams().projectId);
  const valid = Number.isInteger(projectId) && projectId > 0;
  const project = useProject(valid ? projectId : 0);
  const ledger = useLedger(valid ? projectId : 0);
  const [tab, setTab] = useState<Tab>('credit');
  useDocumentTitle(project.data ? `Nhật ký · ${project.data.name}` : 'Nhật ký');

  if (!valid) return <ErrorState title="Mã dự án không hợp lệ" error={new Error('Đường dẫn dự án sai.')} />;
  if (project.error && !project.data) return <ErrorState error={project.error} onRetry={() => void project.refetch()} />;

  const entries = ledger.data?.entries ?? [];
  const rows = [...entries].map((e, i) => ({ ...e, stt: i + 1 })).reverse();
  const t = ledger.data?.totals;

  return (
    <div>
      <Link to={`/projects/${projectId}`} className="mb-2 inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg">
        <Icon name="arrowLeft" size={14} /> {project.data?.name ?? 'Dự án'}
      </Link>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold tracking-tight">Nhật ký và credit</h1>
        <div className="flex flex-wrap gap-2">
          <a href={api.ledgerCsvUrl(projectId)} download className={buttonClass('secondary', 'md')}>
            <Icon name="download" /> Xuất CSV
          </a>
          <a href={api.logMdUrl(projectId)} download className={buttonClass('secondary', 'md')}>
            <Icon name="download" /> Xuất log.md
          </a>
        </div>
      </div>

      <dl className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {t ? (
          <>
            <Stat label="Đã dùng (credit)" value={t.used} />
            <Stat label="Đặt trước (credit)" value={t.reserved} tone={t.reserved > 0 ? 'text-spend' : ''} />
            {project.data && <Stat label="Credit mỗi video" value={project.data.credit_per_video} />}
          </>
        ) : (
          [0, 1, 2].map((i) => <Skeleton key={i} className="h-16" />)
        )}
      </dl>

      <div role="tablist" aria-label="Nội dung" className="mb-3 inline-flex gap-1 rounded-lg bg-surface-3 p-1">
        {(
          [
            ['credit', 'Sổ cái credit'],
            ['events', 'Nhật ký sự kiện'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={`rounded-md px-3 py-1.5 text-[13px] font-medium ${tab === k ? 'bg-surface shadow-sm' : 'text-muted hover:text-fg'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'events' ? (
        <div className="rounded-lg border border-line bg-surface p-3 sm:p-4">
          <EventTimeline projectId={projectId} showScene />
        </div>
      ) : ledger.isLoading ? (
        <Skeleton className="h-40" />
      ) : ledger.error ? (
        <ErrorState error={ledger.error} onRetry={() => void ledger.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState icon="ledger" title="Chưa có giao dịch credit">
          Mỗi video tạo xong sẽ ghi một dòng trừ credit ở đây.
        </EmptyState>
      ) : (
        <>
          <div className="hidden overflow-hidden rounded-lg border border-line bg-surface md:block">
            <table className="w-full text-left text-[13px]">
              <thead className="border-b border-line bg-surface-2 text-xs text-muted">
                <tr>
                  <th className="px-3 py-2 font-semibold">STT</th>
                  <th className="px-3 py-2 font-semibold">Thời gian</th>
                  <th className="px-3 py-2 font-semibold">Cảnh</th>
                  <th className="px-3 py-2 font-semibold">Job</th>
                  <th className="px-3 py-2 text-right font-semibold">Credit</th>
                  <th className="px-3 py-2 text-right font-semibold">Lũy kế đã dùng</th>
                  <th className="px-3 py-2 font-semibold">Ghi chú</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((e) => (
                  <tr key={e.id}>
                    <td className="px-3 py-2 text-muted">{e.stt}</td>
                    <td className="whitespace-nowrap px-3 py-2">{fmtDateTimeYear(e.created_at)}</td>
                    <td className="px-3 py-2">
                      {e.scene_id && e.scene_code ? (
                        <Link to={`/projects/${projectId}/scenes/${e.scene_id}`} className="font-semibold hover:underline">
                          {e.scene_code}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted">{e.job_id ?? '—'}</td>
                    <td className={`px-3 py-2 text-right font-semibold ${e.delta < 0 ? 'text-danger-fg' : 'text-ok-fg'}`}>{fmtSigned(e.delta)}</td>
                    <td className="px-3 py-2 text-right">{e.cumulative_used}</td>
                    <td className="px-3 py-2">{e.note ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="space-y-2 md:hidden">
            {rows.map((e) => (
              <li key={e.id} className="rounded-lg border border-line bg-surface p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-semibold">{e.scene_code ?? 'Dự án'}</span>
                  <span className={`font-bold ${e.delta < 0 ? 'text-danger-fg' : 'text-ok-fg'}`}>{fmtSigned(e.delta)} credit</span>
                </div>
                <p className="mt-0.5 text-xs text-muted">
                  #{e.stt} · {fmtDateTimeYear(e.created_at)} · lũy kế đã dùng {e.cumulative_used}
                </p>
                {e.note && <p className="mt-1 text-[13px]">{e.note}</p>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
