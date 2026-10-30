import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  buildPlan,
  buildScenePlans,
  buildStoryboardMessage,
  extractFrameLines,
  fenceFor,
  planToMarkdown,
  settingsLine,
  type PlanInput,
  type PlanSceneInput,
} from '../src/services/plan.js';
import { buildZip, crc32 } from '../src/services/zip.js';

const STYLE = 'Style: bright morning lifestyle recipe footage, locked-off camera, soft golden sun from a window on the left, vertical 9:16';
const SUBJECT = "A woman's hands with a thin gold bracelet on the right wrist, the cocoa box from image 1 and the stick from image 2 on a white stone counter";
const PROMPT = `${STYLE}\n\n${SUBJECT}\n\nAction: she tears the stick open.\n\nShot 1: 0-10 s, close-up: the stick opens.\n\nCut: none\nCamera: locked-off\nMood: warm\n\nNo dialogue. Avoid text.`;

const refs = [
  { id: 11, label: 'Hộp 3/4', url: '/lan/files/refs/1/hop.png', file_name: 'hop.png' },
  { id: 12, label: 'Stick', url: '/lan/files/refs/1/stick.png', file_name: 'stick.png' },
  { id: 13, label: 'Ly', url: '/lan/files/refs/1/ly.png', file_name: 'ly.png' },
];

const scene = (over: Partial<PlanSceneInput> = {}): PlanSceneInput => ({
  code: 'C1',
  title: 'Mở gói',
  prompt: PROMPT,
  first_frame_desc: 'Hộp và stick đặt trên mặt bếp đá trắng, tay phải đang cầm stick.',
  upload_refs: [11, 12],
  use_prev_storyboard: false,
  storyboard: null,
  ...over,
});

const input = (scenes: PlanSceneInput[], over: Partial<PlanInput> = {}): PlanInput => ({
  name: 'Cacao Actiso',
  created_by_name: 'Lan',
  style_lock: 'Ánh sáng ấm buổi sáng, mặt bếp đá trắng',
  credit_per_video: 15,
  refs,
  scenes,
  ...over,
});

describe('extractFrameLines: dòng Style và dòng chủ thể của prompt', () => {
  it('lấy dòng Style và đoạn chủ thể liền sau, bỏ qua Action/Shot', () => {
    expect(extractFrameLines(PROMPT)).toEqual({ style: STYLE, subject: SUBJECT });
  });
  it('không có đoạn chủ thể (sau Style là Action) → subject null', () => {
    expect(extractFrameLines(`${STYLE}\n\nAction: x\nShot 1: y`)).toEqual({ style: STYLE, subject: null });
  });
  it('đoạn chủ thể nhiều dòng được nối thành một dòng; khoảng trắng thừa được gọn lại', () => {
    expect(extractFrameLines('Style: a\n\nA hand  holds\nthe box\n\nAction: z').subject).toBe('A hand holds the box');
    expect(extractFrameLines('Style:   a   b\n\nA hand').style).toBe('Style: a b');
  });
  it('prompt không có dòng Style → cả hai null', () => {
    expect(extractFrameLines('Một đoạn văn bất kỳ\n\nAction: x')).toEqual({ style: null, subject: null });
  });
});

describe('buildStoryboardMessage: template WORKER.md 4.2', () => {
  it('cảnh có ảnh tham chiếu, không dùng storyboard cảnh đầu: đúng từng dòng của template', () => {
    const msg = buildStoryboardMessage({
      sceneCode: 'C1',
      firstFrameDesc: 'Hộp và stick đặt trên mặt bếp.',
      prompt: PROMPT,
      refLabels: ['Hộp 3/4', 'Stick'],
      prevStoryboardCode: null,
    });
    expect(msg.split('\n')).toEqual([
      'Tạo 1 ảnh tĩnh duy nhất, khung dọc 9:16, phủ kín khung hình từ mép này sang mép kia, ảnh chụp thật (photorealistic).',
      'Đây là khung hình MỞ ĐẦU (giây 0) của clip C1.',
      'Ảnh tham chiếu: ảnh 1 = Hộp 3/4, ảnh 2 = Stick. Sản phẩm phải giữ ĐÚNG như ảnh tham chiếu: không vẽ lại nhãn, chữ, logo, màu, hình dạng.',
      `Nội dung khung hình: Hộp và stick đặt trên mặt bếp. — chi tiết theo mô tả sau: ${STYLE} ${SUBJECT}`,
      'Không có chữ, phụ đề, khung viền, ảnh lồng trong ảnh, và không chia thành nhiều ô.',
    ]);
  });

  it('use_prev_storyboard: thêm storyboard cảnh đầu vào danh sách (đánh số cuối cùng) và dòng "Giữ cùng…"', () => {
    const msg = buildStoryboardMessage({ sceneCode: 'C2', firstFrameDesc: 'd', prompt: PROMPT, refLabels: ['Hộp 3/4', 'Stick'], prevStoryboardCode: 'C1' });
    const lines = msg.split('\n');
    expect(lines[2]).toContain('ảnh 1 = Hộp 3/4, ảnh 2 = Stick, ảnh 3 = storyboard cảnh C1 (chỉ để giữ cùng bối cảnh, không phải sản phẩm).');
    expect(lines[3]).toBe('Giữ cùng mặt bếp, ánh sáng, bố cục đồ vật và bàn tay như ảnh storyboard cảnh đầu (ảnh 3).');
    expect(lines[1]).toBe('Đây là khung hình MỞ ĐẦU (giây 0) của clip C2.');
  });

  it('không có use_prev thì KHÔNG có dòng "Giữ cùng…"', () => {
    const msg = buildStoryboardMessage({ sceneCode: 'C2', firstFrameDesc: 'd', prompt: PROMPT, refLabels: ['A'], prevStoryboardCode: null });
    expect(msg).not.toContain('Giữ cùng');
    expect(msg).not.toContain('storyboard cảnh');
  });

  it('không có ảnh tham chiếu: không viết câu "Sản phẩm phải giữ ĐÚNG…"', () => {
    const msg = buildStoryboardMessage({ sceneCode: 'C1', firstFrameDesc: 'd', prompt: PROMPT, refLabels: [], prevStoryboardCode: null });
    expect(msg).toContain('Không có ảnh tham chiếu đính kèm.');
    expect(msg).not.toContain('Sản phẩm phải giữ ĐÚNG');
  });

  it('chỉ có storyboard cảnh đầu (không có ảnh sản phẩm): vẫn không có câu giữ sản phẩm', () => {
    const msg = buildStoryboardMessage({ sceneCode: 'C2', firstFrameDesc: 'd', prompt: PROMPT, refLabels: [], prevStoryboardCode: 'C1' });
    expect(msg).toContain('ảnh 1 = storyboard cảnh C1');
    expect(msg).not.toContain('Sản phẩm phải giữ ĐÚNG');
    expect(msg).toContain('(ảnh 1).');
  });

  it('first_frame_desc rỗng hoặc prompt không có Style: các nhánh dự phòng', () => {
    const noDesc = buildStoryboardMessage({ sceneCode: 'C1', firstFrameDesc: '', prompt: PROMPT, refLabels: [], prevStoryboardCode: null });
    expect(noDesc).toContain(`Nội dung khung hình theo mô tả sau: ${STYLE} ${SUBJECT}`);
    const noStyle = buildStoryboardMessage({ sceneCode: 'C1', firstFrameDesc: 'Tay cầm hộp', prompt: 'Một mô tả tự do', refLabels: [], prevStoryboardCode: null });
    expect(noStyle).toContain('Nội dung khung hình: Tay cầm hộp\n');
    expect(noStyle).not.toContain('chi tiết theo mô tả');
    const nothing = buildStoryboardMessage({ sceneCode: 'C1', firstFrameDesc: '', prompt: 'Đoạn một\nvẫn đoạn một\n\nĐoạn hai', refLabels: [], prevStoryboardCode: null });
    expect(nothing).toContain('Nội dung khung hình theo mô tả sau: Đoạn một vẫn đoạn một');
    expect(nothing).not.toContain('Đoạn hai');
  });

  it('nhãn và mô tả nhiều dòng được gọn thành một dòng (tin nhắn giữ đúng 5 dòng)', () => {
    const msg = buildStoryboardMessage({ sceneCode: 'C1', firstFrameDesc: 'dòng 1\n\ndòng 2', prompt: PROMPT, refLabels: ['Hộp\n3/4'], prevStoryboardCode: null });
    expect(msg.split('\n')).toHaveLength(5);
    expect(msg).toContain('ảnh 1 = Hộp 3/4');
    expect(msg).toContain('Nội dung khung hình: dòng 1 dòng 2 —');
  });
});

describe('buildScenePlans: ảnh đính kèm và thứ tự', () => {
  it('Bước 1 và Bước 2: ảnh theo upload_refs đúng thứ tự (không theo thứ tự ảnh của dự án); storyboard của chính cảnh ở CUỐI bước 2', () => {
    const [c1] = buildScenePlans(input([scene({ upload_refs: [13, 11] })]));
    expect(c1!.storyboard.attachments.map((a) => [a.order, a.label, a.prompt_label])).toEqual([
      [1, 'Ly', 'ảnh 1'],
      [2, 'Hộp 3/4', 'ảnh 2'],
    ]);
    expect(c1!.video.attachments.map((a) => [a.order, a.kind, a.label, a.prompt_label])).toEqual([
      [1, 'ref', 'Ly', 'image 1'],
      [2, 'ref', 'Hộp 3/4', 'image 2'],
      [3, 'storyboard_self', 'Storyboard của C1', null],
    ]);
    expect(c1!.video.prompt).toBe(PROMPT); // nguyên văn
    expect(c1!.video.attachments.at(-1)).toMatchObject({ available: false, url: null, note: 'Ảnh storyboard bạn vừa tạo ở Bước 1 (chưa tải lên trang này).' });
  });

  it('storyboard đã tải lên: có url, tên file, available; stale kèm cảnh báo', () => {
    const [c1] = buildScenePlans(input([scene({ storyboard: { url: '/lan/files/output/p/storyboard/C1.png', file_name: 'C1.png', stale: false } })]));
    expect(c1!.video.attachments.at(-1)).toMatchObject({ available: true, url: '/lan/files/output/p/storyboard/C1.png', file_name: 'C1.png', note: null });
    const [stale] = buildScenePlans(input([scene({ storyboard: { url: '/u', file_name: 'a.png', stale: true } })]));
    expect(stale!.video.attachments.at(-1)!.note).toMatch(/Prompt cảnh đã đổi/);
  });

  it('use_prev_storyboard: cảnh sau đính kèm storyboard của CẢNH ĐẦU ở cuối bước 1; cảnh đầu không tự đính kèm chính nó', () => {
    const c1 = scene({ code: 'C1', use_prev_storyboard: true /* AI đặt nhầm cho cảnh đầu */ });
    const c2 = scene({ code: 'C2', use_prev_storyboard: true, upload_refs: [11] });
    const c3 = scene({ code: 'C3', use_prev_storyboard: false, upload_refs: [12] });
    const [p1, p2, p3] = buildScenePlans(input([c1, c2, c3]));
    expect(p1!.storyboard.attachments.map((a) => a.kind)).toEqual(['ref', 'ref']);
    expect(p1!.storyboard.message).not.toContain('Giữ cùng');
    expect(p2!.storyboard.attachments.map((a) => [a.order, a.kind, a.label])).toEqual([
      [1, 'ref', 'Hộp 3/4'],
      [2, 'storyboard_prev', 'Storyboard của C1'],
    ]);
    expect(p2!.storyboard.attachments[1]).toMatchObject({ available: false, scene_code: 'C1' });
    expect(p2!.storyboard.attachments[1]!.note).toContain('Chưa có');
    expect(p2!.storyboard.message).toContain('ảnh 2 = storyboard cảnh C1');
    expect(p3!.storyboard.attachments.map((a) => a.kind)).toEqual(['ref']);
    // bước 2 của C2 vẫn là ref rồi storyboard CỦA C2 (không phải của C1)
    expect(p2!.video.attachments.map((a) => [a.kind, a.scene_code])).toEqual([['ref', null], ['storyboard_self', 'C2']]);
  });

  it('storyboard cảnh đầu đã tải lên thì cảnh sau thấy thumbnail/tải được', () => {
    const c1 = scene({ code: 'C1', storyboard: { url: '/lan/files/output/p/storyboard/C1.png', file_name: 'C1.png', stale: false } });
    const c2 = scene({ code: 'C2', use_prev_storyboard: true, upload_refs: [] });
    const [, p2] = buildScenePlans(input([c1, c2]));
    expect(p2!.storyboard.attachments).toEqual([
      expect.objectContaining({ order: 1, kind: 'storyboard_prev', url: '/lan/files/output/p/storyboard/C1.png', file_name: 'C1.png', available: true, note: null }),
    ]);
  });

  it('ảnh bị xóa khỏi dự án và ảnh trùng: bỏ qua kèm cảnh báo, không làm vỡ thứ tự', () => {
    const [c1] = buildScenePlans(input([scene({ upload_refs: [11, 99, 11, 12] })]));
    expect(c1!.video.attachments.map((a) => a.label)).toEqual(['Hộp 3/4', 'Stick', 'Storyboard của C1']);
    expect(c1!.video.warnings[0]).toContain('#99');
    expect(c1!.storyboard.warnings[0]).toContain('#99');
  });

  it('cảnh báo khi prompt nhắc image N vượt số ảnh đính kèm', () => {
    const [ok] = buildScenePlans(input([scene()]));
    expect(ok!.video.warnings).toEqual([]); // prompt nhắc image 1, image 2 và có đúng 2 ảnh
    const [bad] = buildScenePlans(input([scene({ upload_refs: [11] })]));
    expect(bad!.video.warnings.join(' ')).toContain('image 2');
  });

  it('cài đặt Flow: 9:16, 10 giây, x1, 720p, credit lấy từ dự án', () => {
    const [c1] = buildScenePlans(input([scene()], { credit_per_video: 20 }));
    expect(c1!.video.settings).toEqual({ aspect: '9:16', duration_s: 10, count: 1, resolution: '720p', estimated_credits: 20 });
    expect(settingsLine(c1!.video.settings)).toBe('9:16 · 10 giây · x1 · 720p · ước tính 20 credit mỗi video');
    expect(c1!.video.notes.join(' ')).toMatch(/ĐÍNH KÈM từng ảnh vào ô prompt/);
  });
});

describe('planToMarkdown', () => {
  const plan = buildPlan(
    input([
      scene({ storyboard: { url: '/x', file_name: 'C1.png', stale: false } }),
      scene({ code: 'C2', title: 'Rót nước', use_prev_storyboard: true, upload_refs: [12, 13] }),
    ]),
  );
  const md = planToMarkdown(plan);

  it('có đủ mọi cảnh, khóa nhất quán, danh sách ảnh và cài đặt', () => {
    expect(md).toMatch(/^# Kế hoạch prompt: Cacao Actiso\n/);
    expect(md).toContain('- Người tạo: Lan');
    expect(md).toContain('- Số cảnh: 2');
    expect(md).toContain('## Khóa nhất quán');
    expect(md).toContain('Ánh sáng ấm buổi sáng, mặt bếp đá trắng');
    expect(md).toContain('1. Hộp 3/4 — hop.png\n2. Stick — stick.png\n3. Ly — ly.png');
    expect(md).toContain('## C1 — Mở gói');
    expect(md).toContain('## C2 — Rót nước');
    expect(md.match(/### Bước 1: Storyboard \(ChatGPT\)/g)).toHaveLength(2);
    expect(md.match(/### Bước 2: Video \(Google Flow\)/g)).toHaveLength(2);
    expect(md).toContain('9:16 · 10 giây · x1 · 720p · ước tính 15 credit mỗi video');
  });

  it('danh sách ảnh đính kèm theo thứ tự, kèm nhãn "image N" ở bước 2 và "không đánh số" cho storyboard', () => {
    expect(md).toContain('1. [ảnh 1] Hộp 3/4 — hop.png');
    expect(md).toContain('1. [image 1] Hộp 3/4 — hop.png\n2. [image 2] Stick — stick.png\n3. [không đánh số trong prompt] Storyboard của C1 — C1.png');
    expect(md).toContain('3. [không đánh số trong prompt] Storyboard của C1 — C1.png');
    expect(md).toContain('3. [ảnh 3] Storyboard của C1 — C1.png'); // bước 1 của C2: storyboard cảnh đầu, đánh số "ảnh 3" như trong tin nhắn
  });

  it('prompt video và tin nhắn ChatGPT có mặt nguyên văn trong khối code', () => {
    expect(md).toContain('```text\n' + PROMPT + '\n```');
    expect(md).toContain('```text\n' + plan.scenes[1]!.storyboard.message + '\n```');
  });

  it('nội dung có ``` thì hàng rào dài hơn, khối không bị đóng sớm', () => {
    expect(fenceFor('abc')).toBe('```');
    expect(fenceFor('a ``` b')).toBe('````');
    expect(fenceFor('a ````` b ``` c')).toBe('``````');
    const evil = buildPlan(input([scene({ prompt: 'Style: x\n\n```\nrm -rf\n```\nend' })]));
    const out = planToMarkdown(evil);
    expect(out).toContain('````text\nStyle: x\n\n```\nrm -rf\n```\nend\n````');
  });

  it('kế hoạch trống / không có khóa nhất quán / không có ảnh vẫn hợp lệ', () => {
    const empty = planToMarkdown(buildPlan(input([], { style_lock: '  ', refs: [], created_by_name: null })));
    expect(empty).toContain('## Khóa nhất quán\n\n(không có)');
    expect(empty).toContain('## Ảnh tham chiếu\n\n(không có)');
    expect(empty).not.toContain('Người tạo');
    expect(empty).toContain('- Số cảnh: 0');
  });
});

describe('zip store thuần Node', () => {
  it('crc32 đúng giá trị chuẩn và khớp zlib.crc32 khi có', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
    const z = zlib as unknown as { crc32?: (b: Buffer) => number };
    if (z.crc32) {
      const data = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 31) % 251));
      expect(crc32(data)).toBe(z.crc32(data));
    }
  });

  it('gói đọc lại được từ thư mục trung tâm: tên, nội dung, crc và số mục', () => {
    const a = Buffer.from('xin chào');
    const b = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
    const zip = buildZip(
      [
        { name: '01-hop.png', read: () => b },
        { name: '02-ghi-chu.txt', read: () => a },
      ],
      new Date(2026, 9, 22, 10, 30, 0),
    );
    const eocd = zip.length - 22;
    expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
    expect(zip.readUInt16LE(eocd + 10)).toBe(2);
    let off = zip.readUInt32LE(eocd + 16);
    const got: { name: string; data: Buffer; crc: number }[] = [];
    for (let i = 0; i < 2; i++) {
      expect(zip.readUInt32LE(off)).toBe(0x02014b50);
      const crc = zip.readUInt32LE(off + 16);
      const size = zip.readUInt32LE(off + 24);
      const nameLen = zip.readUInt16LE(off + 28);
      const lho = zip.readUInt32LE(off + 42);
      const name = zip.subarray(off + 46, off + 46 + nameLen).toString('utf8');
      expect(zip.readUInt32LE(lho)).toBe(0x04034b50);
      const dataStart = lho + 30 + zip.readUInt16LE(lho + 26) + zip.readUInt16LE(lho + 28);
      got.push({ name, data: zip.subarray(dataStart, dataStart + size), crc });
      off += 46 + nameLen;
    }
    expect(got.map((g) => g.name)).toEqual(['01-hop.png', '02-ghi-chu.txt']);
    expect(got[0]!.data.equals(b)).toBe(true);
    expect(got[1]!.data.equals(a)).toBe(true);
    expect(got.map((g) => g.crc)).toEqual([crc32(b), crc32(a)]);
  });

  it('gói rỗng vẫn là ZIP hợp lệ (chỉ có EOCD)', () => {
    const z = buildZip([]);
    expect(z.length).toBe(22);
    expect(z.readUInt32LE(0)).toBe(0x06054b50);
  });
});
