import fs from 'node:fs';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';

/**
 * Chrome headless RIÊNG cho test (không CDP, không profile thật). Mọi request ra ngoài bị chặn; chỉ
 * https://chatgpt.com và https://flow.google.com được giả lập bằng route fixture. Không bao giờ chạm mạng thật.
 * LƯU Ý: tải xuống bằng điều hướng (<a href=http… download>) KHÔNG đi qua context.route nên Chrome sẽ gọi mạng thật;
 * fixture luôn dùng blob: URL cho mọi lần tải.
 */
export const CHROME_BIN = process.env.TEST_CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const chromeAvailable = fs.existsSync(CHROME_BIN);

export async function launchHeadless(): Promise<Browser> {
  return chromium.launch({ executablePath: CHROME_BIN, headless: true });
}

export const MP4_BYTES = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(200, 7)]);
export const GIF_BYTES = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(200, 7)]);
export const PNG_DL = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 3)]);

export interface SiteCounters { flowGenerate: number; chatSend: number; upscale: number; blocked: string[] }

const CREDITS = '{"4":6,"6":9,"8":12,"10":15}';

/** Trang Flow giả: chip cài đặt, popover (9:16, 4/6/8/10s, x1-x4, dòng credit), ô prompt ProseMirror, Upload media, nút tạo, menu Download. */
export function flowHtml(mp4: Buffer = MP4_BYTES): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Flow fixture</title>
<style>
.is-empty::before{content:attr(data-placeholder);color:#888}
#pop{display:none;border:1px solid #999;padding:6px;margin:6px 0}#pop.open{display:block}
#menu{display:none}#menu.open{display:block}
.ProseMirror{min-height:40px;border:1px solid #ccc;padding:4px}
button,a,[role=menuitem]{display:inline-block;margin:2px;padding:4px}
</style></head><body>
<header><button aria-label="New project"><span class="material-symbols-outlined">add_2</span><span>New project</span></button> <a href="/project/other">Projects</a></header>
<main>
<ul id="attachments" aria-label="Attached media"></ul>
<div id="composer">
  <div id="prompt" class="ProseMirror" contenteditable="true" role="textbox" aria-label="Prompt"><p class="is-empty" data-placeholder="Describe your video"><br class="ProseMirror-trailingBreak"></p></div>
  <button id="upload" aria-label="Upload media"><span class="material-symbols-outlined">upload</span><span>Upload media</span></button>
  <input type="file" id="file" multiple style="display:none">
  <button id="chip" aria-haspopup="dialog"></button>
  <div id="pop" role="dialog" aria-label="Settings">
    <div role="radiogroup" aria-label="Aspect ratio"><button role="radio" data-k="aspect" data-v="16:9">16:9</button><button role="radio" data-k="aspect" data-v="9:16">9:16</button></div>
    <div role="radiogroup" aria-label="Duration"><button role="radio" data-k="duration" data-v="4">4s</button><button role="radio" data-k="duration" data-v="6">6s</button><button role="radio" data-k="duration" data-v="8">8s</button><button role="radio" data-k="duration" data-v="10">10s</button></div>
    <div role="radiogroup" aria-label="Outputs per prompt"><button role="radio" data-k="count" data-v="1">x1</button><button role="radio" data-k="count" data-v="2">x2</button><button role="radio" data-k="count" data-v="3">x3</button><button role="radio" data-k="count" data-v="4">x4</button></div>
    <p id="credit-line"></p>
  </div>
  <button id="gen"></button>
</div>
<section id="results"></section>
</main>
<script>
const q = new URLSearchParams(location.search);
const S = { aspect: q.get('aspect') || '16:9', duration: Number(q.get('duration') || 8), count: Number(q.get('count') || 1), res: Number(q.get('res') || 720) };
const CREDITS = ${CREDITS};
const $ = (s) => document.querySelector(s);
window.__submits = 0; window.__downloads = 0; window.__upscale = 0;
function creditText() {
  if (q.get('credits') === 'none') return '';
  if (q.get('credits')) return 'Generating will use ' + q.get('credits') + ' credits';
  return 'Generating will use ' + (CREDITS[S.duration] * S.count) + ' credits';
}
function render() {
  $('#chip').textContent = 'Video · ' + (q.get('chipaspect') ? S.aspect + ' · ' : '') + S.res + 'p · ' + S.duration + 's · x' + S.count;
  $('#credit-line').textContent = creditText();
  for (const b of document.querySelectorAll('#pop [data-k]')) {
    if (q.get('nostate')) continue;
    b.setAttribute('aria-checked', String(String(S[b.dataset.k]) === b.dataset.v));
  }
}
$('#chip').onclick = () => $('#pop').classList.toggle('open');
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#pop').classList.remove('open'); });
if (q.get('open')) $('#pop').classList.add('open');
for (const b of document.querySelectorAll('#pop [data-k]')) b.onclick = () => { S[b.dataset.k] = b.dataset.k === 'aspect' ? b.dataset.v : Number(b.dataset.v); render(); };
const gen = $('#gen');
if (q.get('variant') === 'icononly') gen.innerHTML = '<span class="material-symbols-outlined">arrow_forward</span>';
else { gen.setAttribute('aria-label', 'Create'); gen.innerHTML = '<span class="material-symbols-outlined">arrow_forward</span><span>Create</span>'; }
gen.onclick = () => {
  window.__submits++;
  fetch('/api/generate', { method: 'POST' });
  const card = document.createElement('div');
  card.innerHTML = '<span>Clip ready</span><button aria-label="Download"><span class="material-symbols-outlined">download</span></button><div role="menu" id="menu"><div role="menuitem">270p GIF</div><div role="menuitem">720p Original</div><div role="menuitem">1080p Upscaled</div><div role="menuitem">4K (Upgrade)</div></div>';
  $('#results').append(card);
  const menu = card.querySelector('#menu');
  card.querySelector('button').onclick = () => menu.classList.toggle('open');
  const items = card.querySelectorAll('[role=menuitem]');
  // Tải bằng blob: URL (không đi qua mạng). Tải xuống kiểu điều hướng không đi qua context.route nên không dùng URL http.
  const go = (b64, name, type) => { const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([u8], { type })); a.download = name; document.body.append(a); a.click(); a.remove(); };
  items[0].onclick = () => { window.__gif = (window.__gif || 0) + 1; go('${GIF_BYTES.toString('base64')}', 'clip.gif', 'image/gif'); };
  items[1].onclick = () => go('${mp4.toString('base64')}', 'clip_720.mp4', 'video/mp4');
  items[2].onclick = () => { window.__upscale++; fetch('/api/upscale', { method: 'POST' }); };
  items[3].onclick = () => { window.__upscale++; fetch('/api/upgrade', { method: 'POST' }); };
};
$('#upload').onclick = async () => {
  const mode = q.get('upload') || 'picker';
  if (mode === 'none') return;
  if (mode === 'input') { $('#file').click(); return; }
  try {
    const handles = await window.showOpenFilePicker({ multiple: true });
    for (const h of handles) { const f = await h.getFile(); const li = document.createElement('li'); li.textContent = f.name; li.dataset.size = String(f.size); $('#attachments').append(li); }
  } catch (e) { /* hủy */ }
};
$('#file').onchange = () => { for (const f of $('#file').files) { const li = document.createElement('li'); li.textContent = f.name; li.dataset.size = String(f.size); $('#attachments').append(li); } };
render();
</script></body></html>`;
}

/** Trang ChatGPT giả: composer ProseMirror trong form, Attach (input file ẩn), Send, ảnh sinh ra với các nhãn thật, viewer có Download. */
export function chatgptHtml(png: Buffer = PNG_DL): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>ChatGPT fixture</title>
<style>.ProseMirror{min-height:40px;border:1px solid #ccc;padding:4px}button{margin:2px;padding:4px}#viewer{display:none}#viewer.open{display:block}</style></head><body>
<ul id="attachments"></ul>
<form id="composer" action="/" onsubmit="return false">
  <div id="prompt-textarea" class="ProseMirror" contenteditable="true" role="textbox"><p><br class="ProseMirror-trailingBreak"></p></div>
  <button type="button" id="attach" aria-label="Attach files">+</button>
  <button id="tools" aria-label="Tools">Tools</button>
  <input type="file" id="file" multiple hidden>
  <button id="send" type="submit" aria-label="Send prompt" data-testid="send-button"><span>arrow_upward</span></button>
</form>
<section id="chat"></section>
<div id="viewer"><button aria-label="Download">Download</button><button aria-label="Close">x</button></div>
<script>
const $ = (s) => document.querySelector(s);
window.__submits = 0;
$('#attach').onclick = () => $('#file').click();
$('#file').onchange = () => { for (const f of $('#file').files) { const li = document.createElement('li'); li.textContent = f.name; $('#attachments').append(li); } };
$('#composer').onsubmit = (e) => {
  e.preventDefault();
  window.__submits++;
  fetch('/backend-api/conversation', { method: 'POST' });
  const m = document.createElement('div');
  m.innerHTML = '<button aria-label="Generated image 1"><img alt="" width="40" height="40"></button><button aria-label="Share generated image 1">Share</button><button aria-label="Edit generated image 1">Edit</button>';
  $('#chat').append(m);
  m.querySelector('[aria-label="Generated image 1"]').onclick = () => $('#viewer').classList.add('open');
};
$('#viewer [aria-label="Download"]').onclick = () => { const bin = atob('${png.toString('base64')}'); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([u8], { type: 'image/png' })); a.download = 'image.png'; document.body.append(a); a.click(); a.remove(); };
</script></body></html>`;
}

/** Cài route fixture cho cả hai site; mọi thứ khác bị chặn. Trả bộ đếm request "tạo" để test chứng minh có/không bấm thật. */
export async function installSites(context: BrowserContext, assets: { mp4?: Buffer; png?: Buffer } = {}): Promise<SiteCounters> {
  const c: SiteCounters = { flowGenerate: 0, chatSend: 0, upscale: 0, blocked: [] };
  await context.route('**/*', (route) => { c.blocked.push(route.request().url()); void route.abort(); });
  await context.route('https://flow.google.com/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/generate') { c.flowGenerate++; return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); }
    if (url.pathname === '/api/upscale' || url.pathname === '/api/upgrade') { c.upscale++; return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); }
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: flowHtml(assets.mp4) });
  });
  // Trang ngoài site và trang đăng nhập giả (chỉ để kiểm tra phân loại lỗi; không phải mạng thật).
  await context.route('https://accounts.google.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Sign in</title><button>Next</button>' }));
  await context.route('https://example.org/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Ngoài site</title><a href="/">link</a>' }));
  await context.route('https://chatgpt.com/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/backend-api/conversation') { c.chatSend++; return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); }
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: chatgptHtml(assets.png) });
  });
  return c;
}
