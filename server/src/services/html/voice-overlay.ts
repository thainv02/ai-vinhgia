/** Voice/phụ đề do app dựng từ ASR, dùng cùng cách gom từ với Cắt clip. AI không viết lại timestamp. */
import { displayWords, groupWords } from '../clips/captions.js';
import { scanTags } from './variables.js';
import type { ManifestFile } from './safe-path.js';
import type { VoiceSnapshot } from './voice.js';
import { AppError } from '../../lib/errors.js';

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const strip = (s: string) => s.replace(/<!--hv-voice-(?:markup|script)-begin-->[\s\S]*?<!--hv-voice-(?:markup|script)-end-->/g, '');
const CAPTION_SCRIPT = 'assets/js/hv-voice-captions.js';
export function withVoice(files: ManifestFile[], voice: VoiceSnapshot | null, aspect: string, opts: { captionsOnly?: boolean } = {}): ManifestFile[] {
  const captionsOnly = opts.captionsOnly ?? voice?.captionsOnly ?? false;
  if (!voice) {
    if (captionsOnly && files.some((f) => f.path.endsWith('.html') && scanTags(f.content).some((t) => t.name === 'audio'))) throw new AppError('SEGMENT_AUDIO_FORBIDDEN', 'Đoạn chỉ dựng hình; voice được ghép một lần ở cuối.', 400);
    return files;
  }
  let captionScript: ManifestFile | null = null;
  const output = files.filter((f) => f.path !== CAPTION_SCRIPT).map((f) => {
    if (f.path !== 'index.html') return f;
    let html = strip(f.content);
    if (scanTags(html).some((t) => t.name === 'audio')) throw new AppError('VOICE_AUDIO_MANAGED', 'App tự chèn voice gốc. Hãy bỏ thẻ audio do AI tạo.', 400);
    const root = scanTags(html).find((t) => t.attrs.some((a) => a.name === 'data-composition-id' && a.value === 'main'));
    if (!root) return f; // canvas validator trả lỗi cụ thể cho AI
    const t = voice.transcript;
    const groups = voice.captions ? groupWords(displayWords(t, 0, t.words.length - 1, null), 'highlight') : [];
    // Một clip tĩnh cho mỗi từ, giống một Dialogue ASS: seek ngược/xuôi đều đúng, không phụ thuộc trạng thái GSAP.
    let captions = groups.flatMap((words, i) => words.map((active, n) => {
      const spans = words.map((w, k) => `<span${k === n ? ' class="hv-active-word"' : ''}>${escape(w.w)}</span>`).join(' ');
      return `<div id="hv-caption-${i}-${n}" class="clip hv-voice-caption" data-start="${active.start}" data-duration="${Math.max(.001, active.end - active.start)}" data-track-index="98">${spans}</div>`;
    })).join('');
    // Voice dài: dữ liệu gọn trong một file JS do app quản lý, tránh vượt trần 256 KB của index.html.
    if (Buffer.byteLength(html + captions, 'utf8') > 180_000) {
      const data = Buffer.from(JSON.stringify(groups.map((g) => g.map((w) => [w.w, w.start, w.end]))), 'utf8').toString('base64');
      captionScript = { path: CAPTION_SCRIPT, content: `(()=>{const root=document.querySelector('[data-composition-id="main"]');if(!root)return;const groups=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('${data}'),c=>c.charCodeAt(0))));const fragment=document.createDocumentFragment();groups.forEach((words,i)=>words.forEach((active,n)=>{const div=document.createElement('div');div.id='hv-caption-'+i+'-'+n;div.className='clip hv-voice-caption';div.dataset.start=String(active[1]);div.dataset.duration=String(Math.max(.001,active[2]-active[1]));div.dataset.trackIndex='98';words.forEach((word,k)=>{if(k)div.appendChild(document.createTextNode(' '));const span=document.createElement('span');if(k===n)span.className='hv-active-word';span.textContent=word[0];div.appendChild(span);});fragment.appendChild(div);}));root.appendChild(fragment);})();` };
      captions = `<script src="${CAPTION_SCRIPT}"></script>`;
    }
    const style = groups.length ? `<style>.hv-voice-caption{position:absolute;left:20px;right:20px;bottom:${aspect === '9:16' ? 100 : 24}px;text-align:center;z-index:9999;font:700 20px 'Be Vietnam Pro',sans-serif;color:#fff;text-shadow:0 2px 4px #000;background:rgba(0,0,0,.65);padding:8px;border-radius:8px}.hv-active-word{color:#ffe066}</style>` : '';
    const audio = captionsOnly ? '' : `<audio id="hv-voice" src="${escape(voice.path)}" data-start="0" data-duration="${voice.duration_s}" data-track-index="99" data-volume="1"></audio>`;
    const markup = `<!--hv-voice-markup-begin-->${audio}${style}${captions}<!--hv-voice-markup-end-->`;
    html = html.slice(0, root.end) + markup + html.slice(root.end);
    return { ...f, content: html };
  });
  return captionScript ? [...output, captionScript] : output;
}
