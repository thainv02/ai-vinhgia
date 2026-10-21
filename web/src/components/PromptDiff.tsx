import { useMemo } from 'react';
import { diffWordsWithSpace } from 'diff';

/** So sánh khác biệt theo từ giữa hai bản prompt (jsdiff). */
export function PromptDiff({ from, to }: { from: string; to: string }) {
  const parts = useMemo(() => diffWordsWithSpace(from, to), [from, to]);
  const stats = useMemo(() => {
    let added = 0;
    let removed = 0;
    const count = (t: string) => t.split(/\s+/).filter(Boolean).length;
    for (const p of parts) {
      if (p.added) added += count(p.value);
      else if (p.removed) removed += count(p.value);
    }
    return { added, removed };
  }, [parts]);

  if (from === to) return <p className="rounded-md bg-surface-2 px-3 py-3 text-[13px] text-muted">Hai phiên bản giống hệt nhau.</p>;

  return (
    <div>
      <p className="mb-1.5 flex gap-3 text-xs font-semibold">
        <span className="text-add-fg">+{stats.added} từ</span>
        <span className="text-del-fg">−{stats.removed} từ</span>
      </p>
      <div className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-surface-2 px-3 py-2.5 text-[13px] leading-relaxed">
        {parts.map((p, i) =>
          p.added ? (
            <ins key={i} className="rounded-sm bg-add-bg px-px text-add-fg no-underline">
              {p.value}
            </ins>
          ) : p.removed ? (
            <del key={i} className="rounded-sm bg-del-bg px-px text-del-fg">
              {p.value}
            </del>
          ) : (
            <span key={i}>{p.value}</span>
          ),
        )}
      </div>
    </div>
  );
}
