import { describe, expect, it } from 'vitest';
import { applyVariables, checkVariables, decodeEntities, scanTags, variablesSchema } from '../src/services/html/variables.js';
import type { HtmlVariable } from '../src/services/html/view.js';

const html = (body: string, head = '') => `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
const idx = (body: string, head?: string) => ({ path: 'index.html', content: html(body, head) });
const v = (o: Partial<HtmlVariable> & { id: string; type: HtmlVariable['type']; value: string }): HtmlVariable => ({ label: o.id, target: o.id, ...o });
const assetPath = (id: number) => (id === 7 ? 'assets/u/7.png' : id === 8 ? 'assets/u/8.mp4' : null);
const err = (fn: () => unknown): any => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('đáng lẽ phải ném lỗi');
};

describe('applyVariables: chữ', () => {
  it('thay chữ tiếng Việt của phần tử data-hf-var, giữ nguyên mọi thứ khác', () => {
    const files = [idx('<h1 class="t" data-hf-var="title">Cũ</h1><p>Giữ nguyên</p>')];
    const out = applyVariables(files, [v({ id: 'title', type: 'text', value: 'Giảm giá 50% hôm nay' })], assetPath);
    expect(out[0]!.content).toContain('<h1 class="t" data-hf-var="title">Giảm giá 50% hôm nay</h1><p>Giữ nguyên</p>');
    expect(files[0]!.content).toContain('>Cũ<'); // không sửa đầu vào
  });

  it('escape &, <, >, nháy: không thể chèn thẻ/script/thuộc tính', () => {
    const attack = `</h1><script>alert(1)</script><img src=x onerror="alert('x')"> & "q" 'a'`;
    const out = applyVariables([idx('<h1 data-hf-var="t">a</h1>')], [v({ id: 't', type: 'text', value: attack, maxLength: 300 })], assetPath);
    const c = out[0]!.content;
    expect(c).not.toContain('<script>alert');
    expect(c).not.toContain('<img src=x');
    expect(c).toContain('&lt;/h1&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(c).toContain('&amp; &quot;q&quot; &#39;a&#39;');
    expect(scanTags(c).filter((t) => t.name === 'script' || t.name === 'img')).toHaveLength(0); // cấu trúc thẻ không đổi
    expect(decodeEntities(c.slice(c.indexOf('data-hf-var="t">') + 16, c.indexOf('</h1>')))).toBe(attack);
  });

  it('idempotent và áp được cho nhiều phần tử/nhiều file', () => {
    const files = [idx('<p data-hf-var="a">1</p><span data-hf-var="a">2</span>'), { path: 'compositions/c.html', content: '<div data-hf-var=a>3</div>' }];
    const vars = [v({ id: 'a', type: 'text', value: 'Xin chào' })];
    const once = applyVariables(files, vars, assetPath);
    expect(once[0]!.content).toContain('<p data-hf-var="a">Xin chào</p><span data-hf-var="a">Xin chào</span>');
    expect(once[1]!.content).toBe('<div data-hf-var=a>Xin chào</div>'); // thuộc tính không nháy
    expect(applyVariables(once, vars, assetPath)).toEqual(once);
  });

  it('chỉ nhận phần tử không có thẻ con; từ chối con/void/raw-text/chưa đóng', () => {
    const t = (body: string) => err(() => applyVariables([idx(body)], [v({ id: 'x', type: 'text', value: 'a' })], assetPath));
    expect(t('<p data-hf-var="x">Một <b>đậm</b> chữ</p>').code).toBe('VARIABLE_TARGET_INVALID');
    expect(t('<p data-hf-var="x"><!-- chú thích --></p>').code).toBe('VARIABLE_TARGET_INVALID');
    expect(t('<img data-hf-var="x" src="a.png">').code).toBe('VARIABLE_TARGET_INVALID');
    expect(t('<script data-hf-var="x">var a=1</script>').code).toBe('VARIABLE_TARGET_INVALID');
    expect(t('<p data-hf-var="x">không đóng').code).toBe('VARIABLE_TARGET_INVALID');
    expect(t('<p>không có biến</p>').code).toBe('VARIABLE_TARGET_NOT_FOUND');
  });

  it('không bị đánh lừa bởi data-hf-var nằm trong chú thích, script, style hoặc giá trị thuộc tính khác', () => {
    const body = `<!-- <h1 data-hf-var="t">trong chú thích</h1> --><script>var s='<h1 data-hf-var="t">x</h1>';</script><style>/* <p data-hf-var="t"> */</style><div title='data-hf-var="t"'>giữ</div><h2 data-hf-var="t">Thật</h2>`;
    const out = applyVariables([idx(body)], [v({ id: 't', type: 'text', value: 'Mới' })], assetPath)[0]!.content;
    expect(out).toContain('<h2 data-hf-var="t">Mới</h2>');
    expect(out).toContain('<!-- <h1 data-hf-var="t">trong chú thích</h1> -->');
    expect(out).toContain(`var s='<h1 data-hf-var="t">x</h1>';`);
    expect(out).toContain(`<div title='data-hf-var="t"'>giữ</div>`);
  });

  it('chỉ chỉnh file HTML (index.html, compositions/*.html), không đụng css/js', () => {
    const files = [idx('<p data-hf-var="a">x</p>'), { path: 'assets/js/a.js', content: '<p data-hf-var="a">x</p>' }];
    const out = applyVariables(files, [v({ id: 'a', type: 'text', value: 'y' })], assetPath);
    expect(out[1]!.content).toBe('<p data-hf-var="a">x</p>');
  });

  it('giới hạn độ dài (theo ký tự), ký tự điều khiển/xuống dòng bị từ chối', () => {
    const t = (value: string, maxLength?: number) => err(() => applyVariables([idx('<p data-hf-var="a">x</p>')], [v({ id: 'a', type: 'text', value, maxLength })], assetPath));
    expect(t('a'.repeat(301)).code).toBe('VARIABLE_INVALID');
    expect(t('ế'.repeat(11), 10).code).toBe('VARIABLE_INVALID');
    expect(() => applyVariables([idx('<p data-hf-var="a">x</p>')], [v({ id: 'a', type: 'text', value: 'ế'.repeat(10), maxLength: 10 })], assetPath)).not.toThrow();
    expect(t('dòng 1\ndòng 2').code).toBe('VARIABLE_INVALID');
    expect(t('a\u0000b').code).toBe('VARIABLE_INVALID');
  });
});

describe('applyVariables: màu và asset', () => {
  it('màu: khối :root --hf-<id>, tạo mới → thay thế → xoá, chỉ nhận #rrggbb', () => {
    const files = [idx('<p>x</p>')];
    const a = applyVariables(files, [v({ id: 'brand', type: 'color', value: '#FF8800' })], assetPath)[0]!.content;
    expect(a).toContain('<style data-hf-vars>:root{--hf-brand:#ff8800;}</style>');
    expect(a.indexOf('data-hf-vars')).toBeLessThan(a.indexOf('</head>'));
    const b = applyVariables([{ path: 'index.html', content: a }], [v({ id: 'brand', type: 'color', value: '#00aa11' }), v({ id: 'bg', type: 'color', value: '#101010' })], assetPath)[0]!.content;
    expect(b.match(/data-hf-vars/g)).toHaveLength(1);
    expect(b).toContain(':root{--hf-brand:#00aa11;--hf-bg:#101010;}');
    const c = applyVariables([{ path: 'index.html', content: b }], [], assetPath)[0]!.content;
    expect(c).not.toContain('data-hf-vars');
    for (const bad of ['red', '#fff', '#12345g', 'url(javascript:1)', '#ff8800;}</style><script>', 'rgb(1,2,3)', '#ff88000'])
      expect(err(() => applyVariables(files, [v({ id: 'brand', type: 'color', value: bad })], assetPath)).code, bad).toBe('VARIABLE_INVALID');
  });

  it('asset: đặt src theo asset đã duyệt (img/video/audio/source), thêm src nếu thiếu, từ chối URL/asset lạ/phần tử khác', () => {
    const files = [idx('<img data-hf-var="logo" src="https://evil.example/x.png" alt="logo"><video data-hf-var="clip"></video>')];
    const out = applyVariables(files, [v({ id: 'logo', type: 'asset', value: '7' }), v({ id: 'clip', type: 'asset', value: '8' })], assetPath)[0]!.content;
    expect(out).toContain('<img data-hf-var="logo" src="assets/u/7.png" alt="logo">');
    expect(out).toContain('<video data-hf-var="clip" src="assets/u/8.mp4"></video>');
    expect(out).not.toContain('evil.example');
    for (const val of ['9', 'https://evil.example/a.png', '../../x', '7; x', '']) expect(err(() => applyVariables(files, [v({ id: 'logo', type: 'asset', value: val })], assetPath)).code, val).toBe('VARIABLE_INVALID');
    expect(err(() => applyVariables([idx('<div data-hf-var="logo"></div>')], [v({ id: 'logo', type: 'asset', value: '7' })], assetPath)).code).toBe('VARIABLE_TARGET_INVALID');
  });
});

describe('checkVariables: biến khai báo phải khớp nội dung thực tế', () => {
  const files = [idx('<h1 data-hf-var="t">Giảm   giá &amp; quà &quot;tặng&quot;\n</h1><img data-hf-var="logo" src="assets/u/7.png">')];
  it('khớp sau khi giải mã thực thể và gộp khoảng trắng', () => {
    expect(() => checkVariables(files, [v({ id: 't', type: 'text', value: 'Giảm giá & quà "tặng"' }), v({ id: 'logo', type: 'asset', value: '7' }), v({ id: 'c', type: 'color', value: '#ffffff' })])).not.toThrow();
  });
  it('lệch nội dung, thiếu phần tử, sai loại phần tử', () => {
    expect(err(() => checkVariables(files, [v({ id: 't', type: 'text', value: 'Khác' })])).code).toBe('VARIABLE_MISMATCH');
    expect(err(() => checkVariables(files, [v({ id: 'zz', type: 'text', value: 'a' })])).code).toBe('VARIABLE_TARGET_NOT_FOUND');
    expect(err(() => checkVariables(files, [v({ id: 't', type: 'asset', value: '7' })])).code).toBe('VARIABLE_TARGET_INVALID');
  });
});

describe('variablesSchema', () => {
  it('id hợp lệ, không trùng, tối đa 30, loại hợp lệ', () => {
    const ok = [{ id: 'title', type: 'text', label: 'Tiêu đề', value: 'Xin chào' }];
    expect(variablesSchema.safeParse(ok).success).toBe(true);
    expect(variablesSchema.safeParse([...ok, ...ok]).success).toBe(false); // trùng id
    expect(variablesSchema.safeParse([{ ...ok[0], id: 'Title' }]).success).toBe(false);
    expect(variablesSchema.safeParse([{ ...ok[0], id: 'a b' }]).success).toBe(false);
    expect(variablesSchema.safeParse([{ ...ok[0], target: 'a"><script>' }]).success).toBe(false);
    expect(variablesSchema.safeParse([{ ...ok[0], type: 'html' }]).success).toBe(false);
    expect(variablesSchema.safeParse(Array.from({ length: 31 }, (_, i) => ({ ...ok[0], id: `v${i}` }))).success).toBe(false);
  });
});
