import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../api/client';
import type { SceneDetail } from '../api/types';
import { usePatchPrompt } from '../hooks/mutations';
import { fmtDateTime } from '../lib/format';
import { PROMPT_EDITABLE, sceneStatusInfo } from '../lib/status';
import { toast } from '../lib/toast';
import { Badge } from './StatusBadge';
import { Button } from './Button';
import { Icon } from './Icon';
import { PromptDiff } from './PromptDiff';
import { InlineError } from './States';

/** Prompt hiện tại (có trình soạn) và lịch sử phiên bản với diff theo từ giữa hai phiên bản bất kỳ. */
export function PromptPanel({ scene }: { scene: SceneDetail }) {
  const save = usePatchPrompt();
  const versions = scene.prompt_versions;
  const latest = versions[versions.length - 1];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(scene.prompt);
  const [reason, setReason] = useState('');
  const baseRef = useRef(scene.prompt);
  const [stale, setStale] = useState(false);
  const [fromV, setFromV] = useState<number | null>(null);
  const [toV, setToV] = useState<number | null>(null);

  // Prompt đổi từ bên ngoài (AI vừa sửa): nếu người dùng chưa gõ gì thì cập nhật, nếu đang gõ dở thì cảnh báo.
  useEffect(() => {
    if (scene.prompt === baseRef.current) return;
    if (!editing || draft === baseRef.current) {
      setDraft(scene.prompt);
      baseRef.current = scene.prompt;
      setStale(false);
    } else {
      setStale(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene.prompt]);

  const editable = PROMPT_EDITABLE.has(scene.status);
  const editReason = editable ? null : `Không sửa được khi cảnh đang ở trạng thái «${sceneStatusInfo(scene.status).label}»`;
  const changed = draft.trim() !== scene.prompt.trim();
  const saveReason = !draft.trim() ? 'Prompt không được để trống' : !changed ? 'Chưa có thay đổi nào' : null;

  const effTo = toV ?? latest?.version ?? 0;
  const effFrom = fromV ?? (versions.length > 1 ? versions[versions.length - 2]!.version : (latest?.version ?? 0));
  const vFrom = versions.find((v) => v.version === effFrom);
  const vTo = versions.find((v) => v.version === effTo);

  const startEdit = (text?: string) => {
    setDraft(text ?? scene.prompt);
    baseRef.current = scene.prompt;
    setStale(false);
    setEditing(true);
  };

  return (
    <section className="rounded-lg border border-line bg-surface p-3 sm:p-4" aria-labelledby="prompt-h">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 id="prompt-h" className="text-[15px] font-semibold">
          Prompt hiện tại
        </h2>
        <Badge tone="neutral">v{scene.prompt_version}</Badge>
        {latest && <span className="text-xs text-muted">{latest.created_by !== 'user' ? 'AI viết' : 'Bạn sửa'} · {fmtDateTime(latest.created_at)}</span>}
        {!editing && (
          <Button size="sm" className="ml-auto" icon={<Icon name="edit" size={14} />} disabledReason={editReason} onClick={() => startEdit()}>
            Sửa prompt
          </Button>
        )}
      </div>

      {editing ? (
        <div className="space-y-2">
          {stale && (
            <p role="alert" className="flex flex-wrap items-center gap-2 rounded-md bg-warn-bg px-3 py-2 text-[13px] text-warn-fg">
              Prompt vừa được cập nhật lên v{scene.prompt_version} ở nơi khác.
              <button type="button" className="underline" onClick={() => startEdit()}>
                Tải bản mới (mất phần đang gõ)
              </button>
            </p>
          )}
          <label htmlFor="prompt-edit" className="sr-only">
            Nội dung prompt
          </label>
          <textarea id="prompt-edit" rows={12} value={draft} onChange={(e) => setDraft(e.target.value)} className="font-[ui-monospace,SFMono-Regular,Menlo,monospace] text-[13px]" />
          <div>
            <label htmlFor="prompt-reason" className="mb-1 block text-xs font-semibold text-muted">
              Lý do sửa (tuỳ chọn)
            </label>
            <input id="prompt-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Vd: thêm cảnh kéo cắt gói" />
          </div>
          {save.isError && <InlineError>{errorMessage(save.error)}</InlineError>}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              loading={save.isPending}
              disabledReason={saveReason}
              onClick={() =>
                save.mutate(
                  { sceneId: scene.id, prompt: draft, reason: reason.trim() || undefined },
                  {
                    onSuccess: () => {
                      toast.success('Đã lưu prompt thành phiên bản mới');
                      setEditing(false);
                      setReason('');
                      setToV(null);
                      setFromV(null);
                    },
                  },
                )
              }
            >
              Lưu thành phiên bản mới
            </Button>
            <Button onClick={() => setEditing(false)} disabled={save.isPending}>
              Hủy
            </Button>
            <span className="text-xs text-muted">{saveReason ?? 'Không đổi trạng thái cảnh. Cần tạo lại storyboard/video để áp dụng.'}</span>
          </div>
        </div>
      ) : (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-surface-2 px-3 py-2.5 font-[ui-monospace,SFMono-Regular,Menlo,monospace] text-[13px] leading-relaxed">{scene.prompt || '(chưa có prompt)'}</pre>
      )}
      {!editing && editReason && <p className="mt-1.5 text-xs text-muted">{editReason}.</p>}

      <details className="mt-4 border-t border-line pt-3" open={versions.length > 1}>
        <summary className="w-fit text-[13px] font-semibold">Lịch sử phiên bản ({versions.length})</summary>
        <div className="mt-3 space-y-3">
          <ol className="space-y-1.5">
            {[...versions].reverse().map((v) => (
              <li key={v.id} className="rounded-md border border-line px-2.5 py-1.5 text-[13px]">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <strong>v{v.version}</strong>
                  <Badge tone={v.created_by !== 'user' ? 'violet' : 'info'}>{v.created_by !== 'user' ? 'AI' : 'Bạn'}</Badge>
                  <span className="text-xs text-muted">{fmtDateTime(v.created_at)}</span>
                  <button type="button" className="ml-auto text-xs text-muted underline hover:text-fg disabled:no-underline disabled:opacity-40" disabled={!editable} title={editReason ?? undefined} onClick={() => startEdit(v.prompt)}>
                    Đưa vào trình soạn
                  </button>
                </div>
                {v.reason && <p className="mt-0.5 text-muted">{v.reason}</p>}
              </li>
            ))}
          </ol>
          {versions.length > 1 ? (
            <div>
              <div className="mb-2 flex flex-wrap items-center gap-2 text-[13px]">
                <span className="font-semibold">So sánh</span>
                <label className="sr-only" htmlFor="diff-from">
                  Từ phiên bản
                </label>
                <select id="diff-from" value={effFrom} onChange={(e) => setFromV(Number(e.target.value))} className="w-auto!">
                  {versions.map((v) => (
                    <option key={v.id} value={v.version}>
                      v{v.version}
                    </option>
                  ))}
                </select>
                <span aria-hidden="true">→</span>
                <label className="sr-only" htmlFor="diff-to">
                  Tới phiên bản
                </label>
                <select id="diff-to" value={effTo} onChange={(e) => setToV(Number(e.target.value))} className="w-auto!">
                  {versions.map((v) => (
                    <option key={v.id} value={v.version}>
                      v{v.version}
                    </option>
                  ))}
                </select>
              </div>
              {vFrom && vTo && <PromptDiff from={vFrom.prompt} to={vTo.prompt} />}
            </div>
          ) : (
            <p className="text-xs text-muted">Mới có một phiên bản. Khi prompt được sửa, bạn sẽ so sánh được khác biệt ở đây.</p>
          )}
        </div>
      </details>
    </section>
  );
}
