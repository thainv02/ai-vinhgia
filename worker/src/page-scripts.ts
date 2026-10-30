/**
 * Mã chạy TRONG trang (Playwright evaluate). Giữ ở dạng chuỗi JavaScript thuần: bộ biên dịch dùng keepNames (tsx) chèn
 * `__name(...)` vào hàm lồng nhau, gây ReferenceError khi hàm được tuần tự hóa vào trang. Chuỗi không bị biến đổi.
 * Không có input nào của model được đưa vào mã này: chỉ nhận phần tử và dữ liệu file đã kiểm soát.
 */

/**
 * Playwright không gọi hàm khi truyền chuỗi (\`evaluate('(x)=>x')\` trả undefined). Dựng Function từ nguồn hằng: lúc chạy nó là
 * hàm thật nên Playwright tuần tự hóa đúng, và bộ biên dịch không chèn __name vì đây không phải mã TypeScript.
 */
export const pageFn = (source: string) => new Function('arg', `return (${source})(arg)`) as (arg: any) => any;

/** (element) → mô tả điều khiển để phân loại submit/upload/download. */
export const DESCRIBE_CONTROL = `(e) => {
  const form = e.closest('form');
  const attrType = (e.getAttribute('type') || '').toLowerCase();
  let formSubmit = false;
  if (form && e.tagName === 'BUTTON' && (attrType === '' || attrType === 'submit')) {
    formSubmit = !!form.querySelector('textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]');
  }
  const text = String(e.innerText || e.textContent || '').trim().slice(0, 200);
  return {
    tag: e.tagName, text, ariaLabel: e.getAttribute('aria-label'), title: e.getAttribute('title'),
    value: e.tagName === 'INPUT' ? e.value : null, type: e.getAttribute('type'), download: e.getAttribute('download') !== null,
    formSubmit, disabled: !!e.disabled || e.getAttribute('aria-disabled') === 'true',
  };
}`;

/** (submitElement) → trạng thái khung soạn: chip cài đặt, nút chọn, ô prompt gần nút gửi, toàn bộ text trang. */
export const READ_COMPOSER = `(submitEl) => {
  const norm = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
  const visible = (e) => {
    const r = e.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(e);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const depth = (n) => { let d = 0; while (n && n.parentElement) { d++; n = n.parentElement; } return d; };
  const lcaDepth = (a, b) => {
    const seen = new Set();
    for (let n = a; n; n = n.parentElement) seen.add(n);
    for (let n = b; n; n = n.parentElement) if (seen.has(n)) return depth(n);
    return 0;
  };

  const promptSel = 'textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]';
  let cands = Array.from(document.querySelectorAll(promptSel)).filter(visible);
  cands = cands.filter((c) => !cands.some((o) => o !== c && o.contains(c)) && !c.contains(submitEl));
  let best = [], bestDepth = -1;
  for (const c of cands) {
    const d = lcaDepth(c, submitEl);
    if (d > bestDepth) { bestDepth = d; best = [c]; } else if (d === bestDepth) best.push(c);
  }
  const read = (c) => (c.tagName === 'TEXTAREA' || c.tagName === 'INPUT') ? c.value : (c.innerText || c.textContent || '');
  const prompt = { found: best.length > 0, ambiguous: best.length > 1, text: best.length === 1 ? read(best[0]) : '', candidates: best.length };

  const chipSel = 'button, [role="button"], [role="combobox"], [role="tab"], [aria-haspopup]';
  const chips = Array.from(document.querySelectorAll(chipSel)).filter(visible).map((e) => norm(e.innerText || e.textContent))
    .filter((t) => t.length > 0 && t.length <= 80 && /\\d{3,4}\\s?p\\b/i.test(t) && /(?:^|[^\\d:])\\d{1,2}\\s*(?:s|secs?|giây)\\b/i.test(t) && /(?:^|[^\\p{L}\\d])x\\s?\\d(?![\\p{L}\\d])/iu.test(t));

  const matchers = [
    ['aspect', /(\\d{1,2})\\s*:\\s*(\\d{1,2})/, (m) => m[1] + ':' + m[2], 30],
    ['duration', /^(\\d{1,2})\\s*(?:s|secs?|giây)$/i, (m) => Number(m[1]), 12],
    ['count', /^x\\s?(\\d)$/i, (m) => Number(m[1]), 6],
    ['resolution', /^(\\d{3,4})\\s?p$/i, (m) => Number(m[1]), 8],
  ];
  const readState = (n) => {
    for (const a of ['aria-selected', 'aria-checked', 'aria-pressed']) {
      const v = n.getAttribute(a);
      if (v !== null) return v === 'true';
    }
    const cur = n.getAttribute('aria-current');
    if (cur !== null) return cur !== 'false';
    const ds = n.getAttribute('data-state');
    if (ds !== null) {
      if (['on', 'active', 'checked', 'selected'].includes(ds)) return true;
      if (['off', 'inactive', 'unchecked'].includes(ds)) return false;
    }
    for (const a of ['data-selected', 'data-active', 'data-checked']) {
      const v = n.getAttribute(a);
      if (v !== null) return v !== 'false';
    }
    if (['selected', 'active', 'checked', 'is-selected', 'is-active', 'Mui-selected'].some((c) => n.classList.contains(c))) return true;
    return null;
  };
  const optionSel = 'button, [role="radio"], [role="option"], [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="switch"], [aria-pressed], [aria-checked], [aria-selected], [data-state]';
  const options = [];
  for (const e of Array.from(document.querySelectorAll(optionSel))) {
    if (!visible(e)) continue;
    const t = norm(e.innerText || e.textContent);
    if (!t) continue;
    for (const [category, re, val, max] of matchers) {
      if (t.length > max) continue;
      const m = re.exec(t);
      if (!m) continue;
      let sel = readState(e);
      if (sel === null && e.parentElement) sel = readState(e.parentElement);
      options.push({ category, value: val(m), text: t, selected: sel });
      break;
    }
  }
  return { chips, options, prompt, text: norm(document.body ? document.body.innerText : '').slice(0, 60000) };
}`;

/**
 * Cài stub showOpenFilePicker dùng một lần, trả về đúng các file được phép (do executor đọc và truyền vào).
 * arg: [{name, type, data(base64)}]. Tự khôi phục hàm gốc ngay khi bị gọi; executor cũng khôi phục nếu không ai gọi.
 */
export const INSTALL_PICKER_STUB = `(files) => {
  const toFile = (f) => {
    const bin = atob(f.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], f.name, { type: f.type, lastModified: Date.now() });
  };
  const list = files.map(toFile);
  const state = { used: false, hadOwn: Object.prototype.hasOwnProperty.call(window, 'showOpenFilePicker'), original: window.showOpenFilePicker };
  const restore = () => { if (state.hadOwn) window.showOpenFilePicker = state.original; else delete window.showOpenFilePicker; };
  state.restore = restore;
  window.__avPicker = state;
  window.showOpenFilePicker = async () => {
    if (state.used) throw new DOMException('Picker đã được dùng', 'AbortError');
    state.used = true;
    restore();
    return list.map((file) => ({
      kind: 'file', name: file.name,
      getFile: async () => file,
      queryPermission: async () => 'granted', requestPermission: async () => 'granted',
      isSameEntry: async (other) => other === file,
    }));
  };
  return true;
}`;
export const PICKER_USED = `() => !!(window.__avPicker && window.__avPicker.used)`;
export const REMOVE_PICKER_STUB = `() => {
  const s = window.__avPicker;
  if (s && !s.used) s.restore();
  delete window.__avPicker;
  return true;
}`;

export const describeControlFn = pageFn(DESCRIBE_CONTROL);
export const readComposerFn = pageFn(READ_COMPOSER);
export const installPickerStubFn = pageFn(INSTALL_PICKER_STUB);
export const pickerUsedFn = pageFn(PICKER_USED);
export const removePickerStubFn = pageFn(REMOVE_PICKER_STUB);
