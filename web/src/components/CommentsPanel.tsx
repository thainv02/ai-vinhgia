import { useEffect, useState } from 'react';
import { errorMessage } from '../api/client';
import type { Asset, Comment, CommentAction, SceneDetail } from '../api/types';
import { useAddComment, useResolveComment } from '../hooks/mutations';
import { fmtDateTime, fmtTimecode } from '../lib/format';
import { COMMENT_ACTION_LABEL, REVISE_ALLOWED, sceneStatusInfo } from '../lib/status';
import { toast } from '../lib/toast';
import { Badge } from './StatusBadge';
import { Button } from './Button';
import { Icon } from './Icon';
import { ConfirmDialog } from './Modal';
import { VideoCostSummary } from './SceneActions';
import { InlineError } from './States';

interface Props {
  scene: SceneDetail;
  videos: Asset[];
  /** Video đang xem trong trình phát. */
  activeVideo: Asset | null;
  /** Thời điểm đang dừng trên video (giây); null nếu video đang phát hoặc chưa có. */
  stopTime: number | null;
  getTime: () => number;
  onSeek: (assetId: number | null, t: number) => void;
}

const ACTIONS: CommentAction[] = ['note', 'revise_and_regenerate', 'regenerate_same', 'regenerate_storyboard'];
const ACTION_HINT: Record<CommentAction, string> = {
  note: 'Chỉ lưu nhận xét, không chạy gì.',
  revise_and_regenerate: 'AI sửa đúng chỗ liên quan trong prompt, bạn duyệt lại rồi mới tạo video.',
  regenerate_same: 'Tạo video mới với đúng prompt hiện tại.',
  regenerate_storyboard: 'Tạo lại ảnh storyboard, không tốn credit.',
};

function CommentItem({ c, scene, videos, onSeek }: { c: Comment; scene: SceneDetail; videos: Asset[]; onSeek: Props['onSeek'] }) {
  const resolve = useResolveComment();
  const asset = videos.find((v) => v.id === c.asset_id) ?? null;
  const fromAI = c.author !== 'user';
  return (
    <li className={`rounded-lg border px-3 py-2 ${fromAI ? 'ml-5 border-line bg-surface-2' : 'border-line-strong bg-surface'} ${c.resolved ? 'opacity-70' : ''}`}>
      <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <Badge tone={fromAI ? 'violet' : 'info'}>{fromAI ? 'AI' : 'Bạn'}</Badge>
        {c.action !== 'note' && <Badge tone={c.action === 'regenerate_same' ? 'warn' : 'neutral'}>{COMMENT_ACTION_LABEL[c.action]}</Badge>}
        {c.timecode !== null && (
          <button
            type="button"
            onClick={() => onSeek(c.asset_id, c.timecode!)}
            className="inline-flex items-center gap-1 rounded bg-surface-3 px-1.5 py-0.5 font-semibold hover:bg-line-strong"
            title="Tua video tới mốc này"
          >
            <Icon name="clock" size={11} />
            {asset ? `v${asset.attempt} · ` : ''}
            {fmtTimecode(c.timecode)}
          </button>
        )}
        <span className="text-muted">{fmtDateTime(c.created_at)}</span>
        <label className="ml-auto inline-flex items-center gap-1 text-muted">
          <input
            type="checkbox"
            checked={c.resolved}
            disabled={resolve.isPending}
            onChange={(e) => resolve.mutate({ commentId: c.id, sceneId: scene.id, resolved: e.target.checked })}
          />
          Đã xử lý
        </label>
      </div>
      <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{c.body}</p>
    </li>
  );
}

/** Chuỗi nhận xét + ô soạn nhận xét với tuỳ chọn hành động và mốc thời gian gắn vào video. */
export function CommentsPanel({ scene, videos, activeVideo, stopTime, getTime, onSeek }: Props) {
  const add = useAddComment({ silent: true });
  const [body, setBody] = useState('');
  const [action, setAction] = useState<CommentAction>('note');
  const [withTime, setWithTime] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const creditPerVideo = scene.project.credit_per_video;
  const status = sceneStatusInfo(scene.status);

  // Lý do vô hiệu hóa từng hành động (lấy từ server cho video/storyboard).
  const reasons: Record<CommentAction, string | null> = {
    note: null,
    revise_and_regenerate: scene.active_job
      ? 'Cảnh đang có job chạy, hãy chờ job xong hoặc hủy job.'
      : !REVISE_ALLOWED.has(scene.status)
        ? `Không dùng được khi cảnh đang ở trạng thái «${status.label}».`
        : null,
    regenerate_same: scene.video_count === 0 ? 'Cảnh chưa có video để tạo lại. Dùng nút «Tạo video».' : (scene.video_block?.message ?? null),
    regenerate_storyboard: scene.storyboard_block?.message ?? null,
  };
  const effective: CommentAction = reasons[action] ? 'note' : action;

  useEffect(() => {
    if (reasons[action]) setAction('note');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reasons[action]]);

  const canAttachTime = !!activeVideo;
  const attach = withTime && canAttachTime;
  const bodyReason = body.trim() ? null : 'Nhập nội dung nhận xét';

  const submit = () => {
    const t = attach ? Math.round(getTime() * 100) / 100 : undefined;
    add.mutate(
      { sceneId: scene.id, body: body.trim(), action: effective, timecode: t, asset_id: activeVideo?.id },
      {
        onSuccess: () => {
          setBody('');
          setWithTime(false);
          setConfirm(false);
          setAction('note');
          toast.success(
            effective === 'revise_and_regenerate'
              ? 'Đã gửi. AI sẽ sửa prompt, bạn sẽ duyệt lại trước khi tạo video.'
              : effective === 'regenerate_same'
                ? `Đã gửi và đặt trước ${creditPerVideo} credit cho video mới.`
                : effective === 'regenerate_storyboard'
                  ? 'Đã gửi. Storyboard sẽ được tạo lại.'
                  : 'Đã lưu nhận xét.',
          );
        },
      },
    );
  };

  const onSubmit = () => {
    if (bodyReason) return;
    if (effective === 'regenerate_same') {
      add.reset();
      setConfirm(true);
    } else {
      add.reset();
      submit();
    }
  };

  return (
    <section className="rounded-lg border border-line bg-surface p-3 sm:p-4" aria-labelledby="cm-h">
      <h2 id="cm-h" className="mb-2 flex items-center gap-2 text-[15px] font-semibold">
        Nhận xét
        {scene.open_comments > 0 && <Badge tone="info">{scene.open_comments} chưa xử lý</Badge>}
      </h2>

      {scene.comments.length === 0 ? (
        <p className="mb-3 rounded-md bg-surface-2 px-3 py-3 text-[13px] text-muted">
          Chưa có nhận xét nào. Ghi lại điều bạn thấy trên video, hoặc nhờ AI sửa prompt rồi tạo lại.
        </p>
      ) : (
        <ol className="mb-3 max-h-[28rem] space-y-2 overflow-y-auto pr-1">
          {scene.comments.map((c) => (
            <CommentItem key={c.id} c={c} scene={scene} videos={videos} onSeek={onSeek} />
          ))}
        </ol>
      )}

      <form
        className="space-y-2.5 border-t border-line pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <label htmlFor="cm-body" className="sr-only">
          Nội dung nhận xét
        </label>
        <textarea id="cm-body" rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Viết nhận xét về cảnh này..." />

        <fieldset className="grid gap-1.5 sm:grid-cols-2">
          <legend className="sr-only">Hành động kèm theo</legend>
          {ACTIONS.map((a) => {
            const reason = reasons[a];
            const selected = effective === a;
            const credit = a === 'regenerate_same';
            return (
              <label
                key={a}
                className={`flex items-start gap-2 rounded-md border px-2.5 py-2 text-[13px] ${
                  reason ? 'cursor-not-allowed border-line opacity-60' : selected ? 'cursor-pointer border-fg bg-surface-2' : 'cursor-pointer border-line hover:bg-surface-2'
                }`}
                title={reason ?? undefined}
              >
                <input type="radio" name="cm-action" value={a} checked={selected} disabled={!!reason} onChange={() => setAction(a)} className="mt-0.5" />
                <span className="min-w-0">
                  <span className="font-semibold">{COMMENT_ACTION_LABEL[a]}</span>
                  {credit && <span className="spend-chip">{creditPerVideo} credit</span>}
                  <span className={`block text-xs ${reason ? 'text-warn-fg' : 'text-muted'}`}>{reason ?? ACTION_HINT[a]}</span>
                </span>
              </label>
            );
          })}
        </fieldset>

        <label className={`flex items-center gap-2 text-[13px] ${canAttachTime ? '' : 'opacity-60'}`}>
          <input type="checkbox" checked={attach} disabled={!canAttachTime} onChange={(e) => setWithTime(e.target.checked)} />
          <span>
            Gắn vào thời điểm đang dừng
            {canAttachTime ? (
              <strong className="ml-1">{stopTime === null ? '(video đang phát, tạm dừng để chọn khung)' : `${fmtTimecode(stopTime)} · v${activeVideo!.attempt}`}</strong>
            ) : (
              <span className="ml-1 text-muted">(cảnh chưa có video)</span>
            )}
          </span>
        </label>

        {add.isError && !confirm && <InlineError>{errorMessage(add.error)}</InlineError>}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" loading={add.isPending && !confirm} disabledReason={bodyReason} credit={effective === 'regenerate_same' ? creditPerVideo : undefined}>
            {effective === 'note'
              ? 'Gửi nhận xét'
              : effective === 'revise_and_regenerate'
                ? 'Gửi và nhờ AI sửa prompt'
                : effective === 'regenerate_same'
                  ? 'Gửi và tạo lại video'
                  : 'Gửi và tạo lại storyboard'}
          </Button>
          {bodyReason && <span className="text-xs text-muted">{bodyReason}</span>}
        </div>
      </form>

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Tạo lại video cho ${scene.code}?`}
        confirmLabel="Xác nhận tạo lại video"
        credit={creditPerVideo}
        pending={add.isPending}
        error={add.isError ? errorMessage(add.error) : null}
        confirmDisabledReason={scene.video_block?.message ?? null}
        onConfirm={submit}
      >
        <VideoCostSummary scene={scene} creditPerVideo={creditPerVideo} />
        <p className="rounded-md bg-surface-2 px-3 py-2 text-[13px]">
          <span className="font-semibold">Nhận xét sẽ được lưu kèm:</span> {body.trim()}
        </p>
      </ConfirmDialog>
    </section>
  );
}
