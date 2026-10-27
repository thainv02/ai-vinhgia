/**
 * Kế hoạch prompt cho một dự án (hàm THUẦN, không đụng DB/file/mạng): với mỗi cảnh sinh ra
 *  - Bước 1 (storyboard, ChatGPT): tin nhắn dán nguyên văn + danh sách ảnh đính kèm theo thứ tự;
 *  - Bước 2 (video, Google Flow): prompt nguyên văn + ảnh đính kèm theo thứ tự + cài đặt.
 *
 * Đây là NGUỒN DUY NHẤT của template tin nhắn storyboard (trước đây nằm trong WORKER.md mục 4.2): trang planner LAN,
 * payload job storyboard (`payload.chatgpt_message`) và worker đều dùng hàm `buildStoryboardMessage` dưới đây.
 */

export const VIDEO_SETTINGS = { aspect: '9:16', duration_s: 10, count: 1, resolution: '720p' } as const;

/** Số ảnh tham chiếu tối đa mỗi kế hoạch trên trang LAN. */
export const MAX_PLAN_REFS = 12;

// ------------------------------------------------------------------ kiểu dữ liệu

export interface PlanRef {
  id: number;
  label: string;
  /** URL để xem/tải ảnh (null: chưa có, vd dùng trong test thuần). */
  url: string | null;
  file_name: string;
}

export interface PlanStoryboardFile {
  url: string;
  file_name: string;
  /** true: prompt cảnh đã đổi sau khi ảnh này được tải lên. */
  stale: boolean;
}

export interface PlanSceneInput {
  code: string;
  title: string;
  prompt: string;
  first_frame_desc: string;
  upload_refs: number[];
  use_prev_storyboard: boolean;
  /** Storyboard người dùng đã tải lên cho cảnh này (mới nhất), nếu có. */
  storyboard: PlanStoryboardFile | null;
}

export interface PlanInput {
  name: string;
  created_by_name: string | null;
  style_lock: string;
  credit_per_video: number;
  /** Mọi ảnh tham chiếu của dự án. */
  refs: PlanRef[];
  /** Các cảnh đã sắp theo thứ tự; cảnh đầu tiên là "cảnh đầu" cho use_prev_storyboard. */
  scenes: PlanSceneInput[];
}

export type AttachmentKind = 'ref' | 'storyboard_prev' | 'storyboard_self';

export interface Attachment {
  /** Thứ tự đính kèm thực tế (bắt đầu từ 1). */
  order: number;
  kind: AttachmentKind;
  label: string;
  ref_id: number | null;
  /** Mã cảnh của storyboard (chỉ với storyboard_*). */
  scene_code: string | null;
  url: string | null;
  file_name: string | null;
  /** false: chưa có file để tải (storyboard chưa được tải lên trang). */
  available: boolean;
  /** Cách tin nhắn/prompt gọi ảnh này ("ảnh 1" ở bước 1, "image 1" ở bước 2); null: không đánh số. */
  prompt_label: string | null;
  note: string | null;
}

export interface StoryboardStep {
  message: string;
  attachments: Attachment[];
  warnings: string[];
}

export interface VideoStep {
  prompt: string;
  attachments: Attachment[];
  settings: { aspect: string; duration_s: number; count: number; resolution: string; estimated_credits: number };
  notes: string[];
  warnings: string[];
}

export interface ScenePlan {
  code: string;
  title: string;
  storyboard: StoryboardStep;
  video: VideoStep;
}

export interface Plan {
  name: string;
  created_by_name: string | null;
  consistency_lock: string;
  settings: VideoStep['settings'];
  refs: PlanRef[];
  scenes: ScenePlan[];
}

// ------------------------------------------------------------------ template tin nhắn storyboard

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Dòng mở đầu của các đoạn sau dòng Style (Action, Shot n, Cut...): chúng KHÔNG phải "dòng chủ thể". */
const KEYWORD_LINE = /^(action|shot\s*\d+|cut|camera|mood|no dialogue|dialogue|focus on|avoid|upload)\b/i;

/**
 * Lấy "dòng Style" và "dòng chủ thể" của prompt cảnh. Prompt có dạng: `Style: …`, dòng trống, đoạn chủ thể (người/vật gắn với
 * "image N"), dòng trống, `Action: …`, `Shot n: …`… Đoạn chủ thể là đoạn liền sau dòng Style, trừ khi nó là Action/Shot/...
 */
export function extractFrameLines(prompt: string): { style: string | null; subject: string | null } {
  const lines = prompt.split(/\r?\n/).map((l) => l.trim());
  const si = lines.findIndex((l) => /^style\s*:/i.test(l));
  if (si < 0) return { style: null, subject: null };
  const style = collapse(lines[si]!);
  let i = si + 1;
  while (i < lines.length && lines[i] === '') i++;
  const para: string[] = [];
  for (; i < lines.length && lines[i] !== ''; i++) para.push(lines[i]!);
  const subject = para.length && !KEYWORD_LINE.test(para[0]!) ? collapse(para.join(' ')) : null;
  return { style, subject };
}

export interface StoryboardMessageInput {
  sceneCode: string;
  firstFrameDesc: string;
  prompt: string;
  /** Nhãn các ảnh tham chiếu theo đúng thứ tự đính kèm. */
  refLabels: string[];
  /** Mã cảnh đầu khi use_prev_storyboard (storyboard của nó được đính kèm CUỐI CÙNG); null: không có. */
  prevStoryboardCode: string | null;
}

/** Tin nhắn dán vào ChatGPT để tạo ảnh storyboard (khung mở đầu, giây 0) của một cảnh. Template từ WORKER.md mục 4.2. */
export function buildStoryboardMessage(i: StoryboardMessageInput): string {
  const items = i.refLabels.map((label, k) => `ảnh ${k + 1} = ${collapse(label) || `ảnh ${k + 1}`}`);
  const prevNo = i.refLabels.length + 1;
  if (i.prevStoryboardCode) items.push(`ảnh ${prevNo} = storyboard cảnh ${i.prevStoryboardCode} (chỉ để giữ cùng bối cảnh, không phải sản phẩm)`);

  const lines: string[] = [
    'Tạo 1 ảnh tĩnh duy nhất, khung dọc 9:16, phủ kín khung hình từ mép này sang mép kia, ảnh chụp thật (photorealistic).',
    `Đây là khung hình MỞ ĐẦU (giây 0) của clip ${i.sceneCode}.`,
  ];
  if (items.length === 0) {
    lines.push('Không có ảnh tham chiếu đính kèm.');
  } else {
    lines.push(
      `Ảnh tham chiếu: ${items.join(', ')}.` +
        (i.refLabels.length ? ' Sản phẩm phải giữ ĐÚNG như ảnh tham chiếu: không vẽ lại nhãn, chữ, logo, màu, hình dạng.' : ''),
    );
  }
  if (i.prevStoryboardCode) {
    lines.push(`Giữ cùng mặt bếp, ánh sáng, bố cục đồ vật và bàn tay như ảnh storyboard cảnh đầu (ảnh ${prevNo}).`);
  }

  const desc = collapse(i.firstFrameDesc);
  const { style, subject } = extractFrameLines(i.prompt);
  let detail = [style, subject].filter(Boolean).join(' ');
  if (!desc && !detail) detail = collapse(i.prompt.split(/\n\s*\n/)[0] ?? '').slice(0, 600); // prompt không theo mẫu: dùng đoạn đầu
  if (desc && detail) lines.push(`Nội dung khung hình: ${desc} — chi tiết theo mô tả sau: ${detail}`);
  else if (desc) lines.push(`Nội dung khung hình: ${desc}`);
  else if (detail) lines.push(`Nội dung khung hình theo mô tả sau: ${detail}`);

  lines.push('Không có chữ, phụ đề, khung viền, ảnh lồng trong ảnh, và không chia thành nhiều ô.');
  return lines.join('\n');
}

// ------------------------------------------------------------------ dựng kế hoạch từng cảnh

const VIDEO_NOTES = [
  'Cài đặt nằm sau biểu tượng thanh trượt cạnh ô prompt: chọn khung 9:16, 10 giây, x1, 720p. Dòng credit hiển thị phải khớp ước tính.',
  'Tải ảnh vào "Tệp tải lên" chưa đủ: giao diện Flow mới chỉ đưa ảnh vào thư viện dự án. Hãy ĐÍNH KÈM từng ảnh vào ô prompt đúng thứ tự bên dưới rồi đếm số ảnh trong ô prompt trước khi bấm "Bắt đầu tạo".',
  'Dán nguyên văn prompt, không thêm bớt chữ nào. Sau khi dán, đọc lại và đối chiếu từng chữ.',
  'Bấm tạo đúng một lần. Nếu sau 20 giây chưa thấy gì chạy, xem thư viện Flow trước khi bấm lại.',
];

function uniqueIds(ids: number[]): number[] {
  return ids.filter((id, k) => ids.indexOf(id) === k);
}

function refAttachment(ref: PlanRef, order: number, promptLabel: string): Attachment {
  return {
    order,
    kind: 'ref',
    label: ref.label,
    ref_id: ref.id,
    scene_code: null,
    url: ref.url,
    file_name: ref.file_name,
    available: true,
    prompt_label: promptLabel,
    note: null,
  };
}

function storyboardAttachment(
  kind: 'storyboard_prev' | 'storyboard_self',
  sceneCode: string,
  sb: PlanStoryboardFile | null,
  order: number,
  promptLabel: string | null = null,
): Attachment {
  let note: string | null;
  if (!sb) {
    note =
      kind === 'storyboard_prev'
        ? `Chưa có: làm Bước 1 của ${sceneCode} và tải storyboard lên, hoặc tự đính kèm ảnh storyboard ${sceneCode} bạn đã tạo.`
        : 'Ảnh storyboard bạn vừa tạo ở Bước 1 (chưa tải lên trang này).';
  } else if (sb.stale) {
    note = 'Prompt cảnh đã đổi sau khi ảnh này được tải lên: kiểm tra ảnh còn khớp trước khi dùng.';
  } else {
    note = null;
  }
  return {
    order,
    kind,
    label: `Storyboard của ${sceneCode}`,
    ref_id: null,
    scene_code: sceneCode,
    url: sb?.url ?? null,
    file_name: sb?.file_name ?? null,
    available: !!sb,
    prompt_label: promptLabel,
    note,
  };
}

/** Kế hoạch của từng cảnh theo thứ tự đầu vào. */
export function buildScenePlans(input: PlanInput): ScenePlan[] {
  const byId = new Map(input.refs.map((r) => [r.id, r]));
  const first = input.scenes[0] ?? null;
  const settings = { ...VIDEO_SETTINGS, estimated_credits: input.credit_per_video };

  return input.scenes.map((scene, idx) => {
    const refs: PlanRef[] = [];
    const missing: number[] = [];
    for (const id of uniqueIds(scene.upload_refs)) {
      const r = byId.get(id);
      if (r) refs.push(r);
      else missing.push(id);
    }
    const sharedWarnings = missing.length ? [`Ảnh tham chiếu #${missing.join(', #')} của cảnh này không còn trong kế hoạch (đã bị xóa).`] : [];
    // Cảnh đầu không tự đính kèm storyboard của chính nó ở bước 1 (giống payload job storyboard).
    const usePrev = scene.use_prev_storyboard && idx > 0 && first !== null;

    const sbAttachments: Attachment[] = refs.map((r, k) => refAttachment(r, k + 1, `ảnh ${k + 1}`));
    if (usePrev) sbAttachments.push(storyboardAttachment('storyboard_prev', first!.code, first!.storyboard, refs.length + 1, `ảnh ${refs.length + 1}`));

    const vAttachments: Attachment[] = refs.map((r, k) => refAttachment(r, k + 1, `image ${k + 1}`));
    vAttachments.push(storyboardAttachment('storyboard_self', scene.code, scene.storyboard, refs.length + 1));

    const videoWarnings = [...sharedWarnings];
    const mentioned = [...scene.prompt.matchAll(/\bimage\s+(\d+)\b/gi)].map((m) => Number(m[1]));
    const maxMentioned = mentioned.length ? Math.max(...mentioned) : 0;
    if (maxMentioned > refs.length) {
      videoWarnings.push(`Prompt nhắc tới image ${maxMentioned} nhưng cảnh chỉ có ${refs.length} ảnh tham chiếu đính kèm. Kiểm tra thứ tự ảnh trước khi tạo.`);
    }

    return {
      code: scene.code,
      title: scene.title,
      storyboard: {
        message: buildStoryboardMessage({
          sceneCode: scene.code,
          firstFrameDesc: scene.first_frame_desc,
          prompt: scene.prompt,
          refLabels: refs.map((r) => r.label),
          prevStoryboardCode: usePrev ? first!.code : null,
        }),
        attachments: sbAttachments,
        warnings: [...sharedWarnings],
      },
      video: { prompt: scene.prompt, attachments: vAttachments, settings, notes: VIDEO_NOTES, warnings: videoWarnings },
    };
  });
}

export function buildPlan(input: PlanInput): Plan {
  return {
    name: input.name,
    created_by_name: input.created_by_name,
    consistency_lock: input.style_lock.trim(),
    settings: { ...VIDEO_SETTINGS, estimated_credits: input.credit_per_video },
    refs: input.refs,
    scenes: buildScenePlans(input),
  };
}

// ------------------------------------------------------------------ Markdown

/** Hàng rào code đủ dài để không bị đóng sớm bởi chuỗi ``` nằm trong nội dung. */
export function fenceFor(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  const longest = runs.reduce((m, r) => Math.max(m, r.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

function block(text: string): string {
  const fence = fenceFor(text);
  return `${fence}text\n${text}\n${fence}`;
}

function attachmentLine(a: Attachment): string {
  const tag = a.prompt_label ? `[${a.prompt_label}] ` : a.kind === 'ref' ? '' : '[không đánh số trong prompt] ';
  const file = a.file_name ?? 'chưa có file';
  return `${a.order}. ${tag}${a.label} — ${file}${a.note ? ` (${a.note})` : ''}`;
}

export const settingsLine = (s: VideoStep['settings']): string =>
  `${s.aspect} · ${s.duration_s} giây · x${s.count} · ${s.resolution} · ước tính ${s.estimated_credits} credit mỗi video`;

/** Markdown gồm mọi cảnh, tin nhắn/prompt nguyên văn và danh sách ảnh đính kèm theo thứ tự. */
export function planToMarkdown(plan: Plan): string {
  const out: string[] = [];
  out.push(`# Kế hoạch prompt: ${plan.name}`, '');
  if (plan.created_by_name) out.push(`- Người tạo: ${plan.created_by_name}`);
  out.push(`- Số cảnh: ${plan.scenes.length}`);
  out.push(`- Cài đặt Flow cho mọi cảnh: ${settingsLine(plan.settings)}`, '');
  out.push('Mỗi cảnh làm hai bước bằng tay: Bước 1 tạo ảnh storyboard trên ChatGPT, Bước 2 tạo video trên Google Flow. Đính kèm ảnh đúng thứ tự ghi dưới đây.', '');

  out.push('## Khóa nhất quán', '');
  out.push(plan.consistency_lock ? block(plan.consistency_lock) : '(không có)', '');

  out.push('## Ảnh tham chiếu', '');
  if (plan.refs.length === 0) out.push('(không có)');
  plan.refs.forEach((r, k) => out.push(`${k + 1}. ${r.label} — ${r.file_name}`));
  out.push('');

  for (const s of plan.scenes) {
    out.push('---', '', `## ${s.code}${s.title ? ` — ${s.title}` : ''}`, '');
    out.push('### Bước 1: Storyboard (ChatGPT)', '');
    out.push('Ảnh đính kèm, theo thứ tự:');
    out.push(...(s.storyboard.attachments.length ? s.storyboard.attachments.map(attachmentLine) : ['(không đính kèm ảnh nào)']), '');
    out.push('Tin nhắn dán vào ChatGPT:', '', block(s.storyboard.message), '');
    for (const w of s.storyboard.warnings) out.push(`> Lưu ý: ${w}`);
    if (s.storyboard.warnings.length) out.push('');

    out.push('### Bước 2: Video (Google Flow)', '');
    out.push(`Cài đặt: ${settingsLine(s.video.settings)}`, '');
    out.push('Ảnh đính kèm vào ô prompt, theo thứ tự:');
    out.push(...s.video.attachments.map(attachmentLine), '');
    out.push('Prompt (dán nguyên văn):', '', block(s.video.prompt), '');
    for (const w of s.video.warnings) out.push(`> Cảnh báo: ${w}`);
    if (s.video.warnings.length) out.push('');
    out.push('Lưu ý khi tạo:');
    out.push(...s.video.notes.map((n) => `- ${n}`), '');
  }
  return out.join('\n').trimEnd() + '\n';
}
