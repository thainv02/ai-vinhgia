import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { LanInfo } from '../api/types';
import { copyText } from '../lib/clipboard';
import { Button } from './Button';
import { Icon } from './Icon';
import { Modal } from './Modal';
import { ErrorState, LoadingBlock } from './States';

function CopyField({ label, value, secret }: { label: string; value: string; secret?: boolean }) {
  const [shown, setShown] = useState(!secret);
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="mb-1 text-xs font-semibold text-muted">{label}</div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md border border-line bg-surface-2 px-3 py-2 font-mono text-[15px]" aria-label={label}>
          {shown ? value : '•'.repeat(value.length)}
        </code>
        {secret && (
          <Button size="sm" aria-pressed={shown} onClick={() => setShown((s) => !s)} icon={<Icon name="eye" size={14} />}>
            {shown ? 'Ẩn' : 'Hiện'}
          </Button>
        )}
        <Button
          size="sm"
          onClick={() => {
            void copyText(value).then((ok) => {
              setCopied(ok);
              if (ok) window.setTimeout(() => setCopied(false), 2000);
            });
          }}
          icon={<Icon name={copied ? 'check' : 'copy'} size={14} />}
        >
          {copied ? 'Đã chép' : 'Sao chép'}
        </Button>
      </div>
    </div>
  );
}

function LanSettings({ info }: { info: LanInfo }) {
  // server cũ không trả `require_code`: coi như cần mã
  const requireCode = info.require_code !== false;
  if (!info.enabled) {
    return (
      <div className="space-y-3 text-sm">
        <p>
          Chia sẻ qua LAN <strong>đang tắt</strong>. Khi bật, đồng nghiệp trong cùng mạng mở một trang riêng để nhập yêu cầu và ảnh tham chiếu, nhận prompt cho ChatGPT (storyboard) và Google Flow (video), rồi tự tạo ảnh/video bằng tài khoản của họ.
        </p>
        <p className="text-muted">Trang đó chỉ lập kế hoạch: không tạo storyboard hay video trên máy này, không tốn credit Flow của bạn.</p>
        <div>
          <div className="mb-1 text-xs font-semibold text-muted">Để bật: thêm vào file .env rồi khởi động lại server</div>
          <pre className="whitespace-pre-wrap break-words rounded-md border border-line bg-surface-2 p-3 font-mono text-[13px] leading-relaxed">{`LAN_ENABLED=true
# LAN_PORT=8790
# Mặc định KHÔNG cần mã truy cập. Muốn đòi mã:
# LAN_REQUIRE_CODE=true
# LAN_ACCESS_CODE=
# (để trống: server tự sinh mã và ghi vào .env)`}</pre>
        </div>
        <p className="text-xs text-muted">Ứng dụng không tự sửa .env. App chính vẫn chỉ nghe ở 127.0.0.1; cổng LAN là listener riêng, chỉ có trang planner.</p>
      </div>
    );
  }
  return (
    <div className="space-y-4 text-sm">
      <p className="flex items-center gap-2">
        <span aria-hidden="true" className={`size-2.5 rounded-full ${info.listening ? 'bg-ok-fg' : 'bg-danger-fg'}`} />
        {info.listening ? <strong>Đang chạy</strong> : <strong className="text-danger-fg">Đã bật nhưng chưa chạy</strong>}
        <span className="text-muted">· cổng {info.port}</span>
      </p>
      {info.error && <p className="rounded-md bg-danger-bg px-3 py-2 text-danger-fg">Không mở được cổng LAN: {info.error}. Kiểm tra LAN_PORT rồi khởi động lại server.</p>}
      {info.urls.length > 0 ? (
        <div className="space-y-3">
          {info.urls.map((u) => (
            <CopyField key={u} label="Địa chỉ gửi cho đồng nghiệp" value={u} />
          ))}
        </div>
      ) : (
        <p className="text-muted">Không tìm thấy địa chỉ IP LAN của máy. Kiểm tra kết nối mạng.</p>
      )}
      {requireCode ? (
        info.access_code && <CopyField label="Mã truy cập" value={info.access_code} secret />
      ) : (
        <p className="rounded-md bg-surface-2 px-3 py-2" role="status">
          <strong>Không cần mã truy cập.</strong> <span className="text-muted">Ai trong cùng mạng LAN mở địa chỉ trên là dùng được ngay. Giới hạn theo máy, trần hàng đợi và các lớp bảo vệ khác vẫn giữ nguyên.</span>
        </p>
      )}
      <ul className="list-disc space-y-1 pl-5 text-muted">
        <li>{requireCode ? 'Mọi người dùng chung một mã truy cập; mỗi người nhập tên của mình khi tạo kế hoạch.' : 'Không có đăng nhập: mỗi người nhập tên của mình khi tạo kế hoạch (tên không được xác thực) và thấy kế hoạch của nhau.'}</li>
        <li>Giới hạn mỗi máy mỗi giờ: 6 lượt phân tích, 30 video tải lên (mp4/mov ≤ 200 MB), 6 lần dựng/render lại, 6 lần xoá logo. Ảnh ≤ 10 MB, 12 ảnh mỗi kế hoạch. Hàng đợi LAN tối đa 6 việc.</li>
        <li>Kế hoạch của họ hiện trong danh sách dự án với nhãn <strong className="text-fg">LAN · tên người tạo</strong>; bạn vẫn sản xuất từ đó như dự án thường. Video họ tải lên và bản hoàn chỉnh họ dựng cũng hiện ở trang Bản hoàn chỉnh của dự án.</li>
        <li>{requireCode ? 'Tắt hoặc đổi mã: sửa .env (LAN_ENABLED, LAN_ACCESS_CODE) rồi khởi động lại server.' : 'Tắt chia sẻ, hoặc bật lại mã truy cập: sửa .env (LAN_ENABLED, LAN_REQUIRE_CODE=true + LAN_ACCESS_CODE) rồi khởi động lại server.'}</li>
      </ul>
      {info.plan_count > 0 && <p className="text-xs text-muted">Hiện có {info.plan_count} kế hoạch tạo từ LAN.</p>}
      <dl className="grid grid-cols-2 gap-3 rounded-md border border-line bg-surface-2 p-3 text-[13px]" aria-label="Hoạt động từ LAN">
        <div>
          <dt className="text-xs text-muted">Xoá logo Veo (24 giờ qua)</dt>
          <dd className="text-base font-semibold">{info.tool_jobs_24h} video</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Việc LAN trong hàng đợi</dt>
          <dd className={`text-base font-semibold ${info.queue.total >= info.queue.cap ? 'text-warn-fg' : ''}`}>
            {info.queue.total}/{info.queue.cap}
            {info.queue.total >= info.queue.cap && <span className="ml-1.5 text-xs font-normal">(đầy)</span>}
          </dd>
          <dd className="text-xs text-muted">
            {info.queue.cuts} bản dựng · {info.queue.tools} xoá logo. Việc của bạn luôn chạy trước việc LAN đang chờ.
          </dd>
        </div>
        {info.render && (
          <div className="col-span-2">
            <dt className="text-xs text-muted">Hàng đợi render (bản dựng + xoá logo, cả của bạn và LAN)</dt>
            <dd className="text-base font-semibold">
              Đang chạy {info.render.running_count}/{info.render.concurrency} việc
              <span className="ml-1.5 text-xs font-normal text-muted">· {info.render.waiting_count} việc đang chờ</span>
            </dd>
            <dd className="text-xs text-muted">Chạy song song tối đa {info.render.concurrency} việc (RENDER_CONCURRENCY). Việc của bạn được lấy trước việc LAN đang chờ, không ngắt việc đang chạy.</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

/** Nút "Chia sẻ LAN" trên header + hộp thoại hiển thị trạng thái, địa chỉ và mã truy cập (cấu hình bằng .env, chỉ hướng dẫn). */
export function LanShareButton() {
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['lan-info'], queryFn: api.lanInfo, staleTime: 10_000, refetchInterval: open ? 5000 : 60_000 });
  const live = !!q.data?.listening;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium text-header-fg/70 transition-colors hover:bg-white/10 hover:text-white"
      >
        <Icon name="lan" size={15} />
        <span className="max-[420px]:hidden">Chia sẻ LAN</span>
        <span aria-hidden="true" className={`size-1.5 rounded-full ${live ? 'bg-[#4ade80]' : 'bg-white/30'}`} />
        <span className="sr-only">{live ? '(đang chạy)' : '(đang tắt)'}</span>
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Chia sẻ qua LAN" wide footer={<Button onClick={() => setOpen(false)}>Đóng</Button>}>
        {q.isLoading ? <LoadingBlock /> : q.error ? <ErrorState title="Không đọc được trạng thái LAN" error={q.error} onRetry={() => void q.refetch()} /> : q.data ? <LanSettings info={q.data} /> : null}
      </Modal>
    </>
  );
}
