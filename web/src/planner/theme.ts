import { useEffect, useState } from 'react';

export type ThemeMode = 'dark' | 'light' | 'system';

const KEY = 'autovideo-theme';

export function readThemeMode(): ThemeMode {
  try {
    const v = window.localStorage.getItem(KEY);
    if (v === 'dark' || v === 'light' || v === 'system') return v;
  } catch {
    /* bị chặn lưu trữ: dùng mặc định */
  }
  return 'dark';
}

const systemDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;

/** Đặt `<html data-theme>`: "Theo Windows" thì lấy theo prefers-color-scheme. */
export function applyTheme(mode: ThemeMode): void {
  const resolved = mode === 'system' ? (systemDark() ? 'dark' : 'light') : mode;
  document.documentElement.dataset.theme = resolved;
}

export function saveThemeMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(KEY, mode);
  } catch {
    /* bỏ qua */
  }
}

// Áp ngay khi module nạp để không nháy sáng/tối.
applyTheme(readThemeMode());

/** Chế độ giao diện hiện tại; chế độ "Theo Windows" tự đổi khi hệ điều hành đổi. */
export function useTheme(): [ThemeMode, (m: ThemeMode) => void] {
  const [mode, setMode] = useState<ThemeMode>(readThemeMode);
  useEffect(() => {
    applyTheme(mode);
    if (mode !== 'system' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => applyTheme('system');
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [mode]);
  return [
    mode,
    (m) => {
      saveThemeMode(m);
      setMode(m);
    },
  ];
}
