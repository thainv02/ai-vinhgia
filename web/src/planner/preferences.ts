export const LAN_NAME_KEY = 'autovideo-lan-name';
export const readLanName = (): string => { try { return window.localStorage.getItem(LAN_NAME_KEY) ?? ''; } catch { return ''; } };
export const saveLanName = (name: string): void => { try { window.localStorage.setItem(LAN_NAME_KEY, name); } catch { /* storage may be unavailable */ } };
