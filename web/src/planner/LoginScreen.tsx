import { useState } from 'react';
import { errorMessage } from '../api/errors';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { InlineError } from '../components/States';
import { planner } from './api';

/** Màn nhập mã truy cập (mã do chủ máy cung cấp). */
export function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!code.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await planner.login(code.trim());
      onSuccess();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="w-full max-w-sm rounded-xl border border-line bg-surface p-6 shadow-sm"
      >
        <div className="mb-5 flex items-center gap-3">
          <span aria-hidden="true" className="grid size-10 place-items-center rounded-lg bg-ink text-ink-fg">
            <Icon name="film" size={20} />
          </span>
          <div>
            <h1 className="text-lg font-bold leading-tight tracking-tight">Lập kế hoạch prompt</h1>
            <p className="text-[13px] text-muted">Autovideo · mạng LAN</p>
          </div>
        </div>
        <label htmlFor="lan-code" className="mb-1 block text-[13px] font-semibold">
          Mã truy cập
        </label>
        <input
          id="lan-code"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          autoFocus
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={64}
          placeholder="VD: K7M2QX9P"
          disabled={busy}
          aria-invalid={!!error}
          aria-describedby={error ? 'lan-code-error' : 'lan-code-hint'}
          className="text-center font-mono text-xl tracking-[0.25em]"
        />
        <p id="lan-code-hint" className="mt-1.5 text-xs text-muted">
          Hỏi chủ máy để lấy mã (thường 8 ký tự).
        </p>
        {error && (
          <div id="lan-code-error" className="mt-3">
            <InlineError>{error}</InlineError>
          </div>
        )}
        <Button type="submit" variant="primary" size="md" className="mt-4 w-full" loading={busy} disabledReason={code.trim() ? null : 'Nhập mã truy cập'}>
          Vào
        </Button>
        <p className="mt-4 text-xs text-muted">
          Trang này chỉ lập kế hoạch: tách cảnh và viết prompt. Bạn tự tạo ảnh trên ChatGPT và video trên Google Flow bằng tài khoản của mình.
        </p>
      </form>
    </main>
  );
}
