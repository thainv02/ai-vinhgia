import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lintComposition, materialize, runRender } from '../src/services/html/engine/index.js';
import { writeStaging, validateManifest } from '../src/services/html/safe-path.js';
import { checkVariables } from '../src/services/html/variables.js';
import { fillPlaceholders, instantiateTemplate, listHtmlTemplates } from '../src/services/html/templates.js';
import type { HtmlAspect } from '../src/services/html/view.js';
import { makeLanEnv, type LanEnv } from './helpers-lan.js';

const ASPECTS: HtmlAspect[] = ['9:16', '16:9', '1:1'];
const tmps: string[] = [];
let L: LanEnv | null = null;
afterEach(async () => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  await L?.close();
  L = null;
});

describe('mẫu Video HTML', () => {
  it('có đúng 4 mẫu với meta hợp lệ', () => {
    const list = listHtmlTemplates();
    expect(list.map((t) => t.id)).toEqual(['compare', 'product', 'promo', 'slideshow']);
    for (const t of list) {
      expect(t.aspects).toEqual(['9:16', '16:9', '1:1']);
      expect(t.label.length).toBeGreaterThan(3);
      expect(t.variables.length).toBeGreaterThanOrEqual(4);
    }
  });

  it('chỗ giữ chỗ: {{d}}, {{d:x}}, {{r:x}}, {{w}}/{{h}}/{{aspect}}; chỗ lạ → lỗi', () => {
    expect(fillPlaceholders('{{w}}x{{h}} {{aspect}} {{d}} {{d:0.25}} {{r:0.67}}', '9:16', 7)).toBe('360x640 a-p 7 1.75 2.31');
    expect(fillPlaceholders('{{w}}x{{h}} {{aspect}}', '16:9', 7)).toBe('640x360 a-l');
    expect(() => fillPlaceholders('{{evil}}', '1:1', 5)).toThrow();
    expect(instantiateTemplate('../x', { aspect: '9:16', durationS: 5 })).toBeNull();
    expect(instantiateTemplate('khong-co', { aspect: '9:16', durationS: 5 })).toBeNull();
  });

  for (const id of ['product', 'promo', 'compare', 'slideshow']) {
    for (const aspect of ASPECTS) {
      it(`${id} ${aspect}: qua manifest, biến khớp nội dung và lintComposition (thời lượng 3/6/15 giây)`, async () => {
        for (const durationS of [3, 6, 15]) {
          const t = instantiateTemplate(id, { aspect, durationS })!;
          expect(t, `${id}`).not.toBeNull();
          const checked = validateManifest(t.files);
          checkVariables(checked, t.meta.variables);
          const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-tpl-'));
          tmps.push(dir);
          writeStaging(path.join(dir, 'site'), checked);
          const report = await lintComposition(path.join(dir, 'site'), { aspect, durationS });
          expect(report.errors, JSON.stringify(report.errors)).toEqual([]);
          expect(report.ok).toBe(true);
        }
      }, 60_000);
    }
  }

  it('GET /lan/api/html-templates: không lộ nội dung file', async () => {
    L = await makeLanEnv({ config: {} });
    const r = await L.client().get('/lan/api/html-templates');
    expect(r.status).toBe(200);
    expect(r.body.map((t: any) => t.id)).toEqual(['compare', 'product', 'promo', 'slideshow']);
    expect(Object.keys(r.body[0]).sort()).toEqual(['aspects', 'description', 'id', 'label']);
  });

  // Dựng thật bằng trình duyệt của spike (HTML_RENDERER_BROWSER): chỉ chạy khi có biến môi trường; video 3 giây, 720p.
  it.skipIf(!process.env.HTML_RENDERER_BROWSER)('4 mẫu dựng được MP4 thật (9:16, 3 giây, 720p) bằng engine', async () => {
    L = await makeLanEnv({ config: {} });
    for (const id of ['product', 'promo', 'compare', 'slideshow']) {
      const t = instantiateTemplate(id, { aspect: '9:16', durationS: 3 })!;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-tplr-'));
      tmps.push(dir);
      writeStaging(path.join(dir, 'site'), validateManifest(t.files));
      await materialize(path.join(dir, 'site'), path.join(dir, 'work'), { mode: 'render' });
      const out = path.join(dir, 'out.mp4');
      await runRender(L.env.ctx, { workDir: path.join(dir, 'work'), outPath: out, aspect: '9:16', quality: '720p', durationS: 3, signal: new AbortController().signal, onProgress: () => undefined });
      expect(fs.statSync(out).size, id).toBeGreaterThan(5_000);
    }
  }, 240_000);
});
