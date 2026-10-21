import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AppContext } from '../context.js';
import type { AssetKind, ProjectRow, RefRow, SceneRow, SceneStatus, Verdict } from '../db/types.js';
import { slugify } from '../lib/paths.js';
import { attemptsUsed, budgetNumbers } from './budget.js';
import { finalPaths, selectionSignature, type Edl, type SelectionItem } from './final-cuts.js';
import { hashBuffer } from './refs.js';
import { detectImageType, sanitizeBaseName, type ImageType } from './refs.js';
import { getProject, getScene, logEvent, type NewEvent } from './repo.js';
import { transition } from './transition.js';

/**
 * Nhập dữ liệu của lần chạy tay đầu tiên (decisions §H): `output/cacao-smoothie/`, `cacao-smoothie-prompts.md`, `MOCKUP_BOX/`.
 * Idempotent: mọi bản ghi nhập có `ext_key` (UNIQUE) hoặc khóa tự nhiên; chạy lại không tạo thêm hàng nào.
 * Không bao giờ ghi vào thư mục dữ liệu cũ (không copy/move video, không append log.md).
 */

export const LEGACY_PROJECT_NAME = 'Cacao Actiso Plus';
export const DEFAULT_LEGACY_DIR = 'output/cacao-smoothie';
export const PROMPTS_FILE = 'cacao-smoothie-prompts.md';
export const MOCKUP_DIR = 'MOCKUP_BOX';
export const LEGACY_PROMPT_DIR = 'legacy';
export const IMPORT_REASON = 'Nhập dữ liệu cũ';

/**
 * Bản dựng thử đã có của Cacao (người dùng duyệt): `output/cacao-smoothie/final/cacao-smoothie_final_v1.*`.
 * Điểm cắt (giây) theo từng cảnh; đặt tay, chưa qua Claude phân tích.
 */
export const LEGACY_TRIAL_FINAL = {
  slug: 'cacao-smoothie',
  version: 1,
  note: 'Bản thử Shotcut MCP, điểm cắt đặt tay (chưa qua Claude phân tích)',
  cuts: {
    C1: { in_s: 0, out_s: 9.5 }, // C1 dùng v2 (video được chọn)
    C2: { in_s: 0.3, out_s: 9.6 },
    C3: { in_s: 0, out_s: 9.7 },
    C4: { in_s: 0.2, out_s: 9.8 },
  } as Record<string, { in_s: number; out_s: number }>,
};

/** Ảnh tham chiếu được copy vào refs/<projectId>/ (theo thứ tự). `aliases` = tên file kịch bản có thể nhắc tới. */
const LEGACY_REFS = [
  { key: 'box', file: '2.png', label: 'Hộp 3/4', aliases: ['2.png'] },
  { key: 'stick', file: 'MOCKUP-STICK.png', label: 'Gói stick (2 mặt)', aliases: ['mockup-stick.png', 'mockup-stick-front.png'] },
] as const;

// ------------------------------------------------------------------ parse cacao-smoothie-prompts.md

export interface ParsedScene {
  code: string;
  title: string;
  order_index: number;
  /** Tên file (basename) trong dòng `**Upload:**`, theo thứ tự ảnh 1, 2, … */
  upload_files: string[];
  first_frame_desc: string;
  /** Khối ``` đầu tiên của mục, NGUYÊN VĂN. */
  prompt: string;
  /** Vị trí [start, end) của prompt trong nội dung file (để kiểm tra nguyên văn). */
  prompt_range: [number, number];
}

export interface ParsedPrompts {
  /** Phần đầu file, trước mục `## C1`. */
  brief: string;
  /** Nội dung mục "Khóa nhất quán". */
  style_lock: string;
  scenes: ParsedScene[];
}

const nfc = (s: string): string => s.normalize('NFC');

/** Tìm khối ``` đầu tiên trong text[from, to). Trả về vị trí nội dung (không gồm newline sau ``` mở và trước ``` đóng). */
function firstFencedBlock(text: string, from: number, to: number): { start: number; end: number } | null {
  let pos = from;
  let contentStart = -1;
  while (pos < to) {
    let nl = text.indexOf('\n', pos);
    if (nl === -1 || nl > to) nl = to;
    const line = text.slice(pos, nl);
    if (contentStart === -1) {
      if (line.startsWith('```')) contentStart = nl + 1;
    } else if (/^```\s*$/.test(line)) {
      let end = pos - 1; // bỏ đúng một newline ngay trước ``` đóng
      if (end > contentStart && text[end - 1] === '\r') end -= 1;
      return { start: contentStart, end: Math.max(contentStart, end) };
    }
    pos = nl + 1;
  }
  return null;
}

export function parsePromptsMarkdown(text: string): ParsedPrompts {
  const headers = [...text.matchAll(/^## .*$/gm)].map((m) => ({ index: m.index ?? 0, line: m[0].replace(/\r$/, '') }));
  const bodyEnd = (i: number): number => (i + 1 < headers.length ? headers[i + 1]!.index : text.length);

  const scenes: ParsedScene[] = [];
  let firstSceneAt = -1;
  let styleLock = '';
  headers.forEach((h, i) => {
    const m = /^## (C\d+):\s*(.+?)(?:\s*\(([^()]*)\))?\s*$/.exec(nfc(h.line));
    if (m) {
      if (firstSceneAt === -1) firstSceneAt = h.index;
      const from = h.index + h.line.length;
      const to = bodyEnd(i);
      const body = text.slice(from, to);
      const upload = /^\*\*Upload:\*\*[ \t]*(.*)$/m.exec(body)?.[1] ?? '';
      const frame = /^\*\*Khung đầu:\*\*[ \t]*(.*)$/m.exec(nfc(body))?.[1] ?? '';
      const fence = firstFencedBlock(text, from, to);
      if (!fence) throw new Error(`Mục ${m[1]} không có khối \`\`\` chứa prompt`);
      scenes.push({
        code: m[1]!,
        title: m[2]!.trim(),
        order_index: scenes.length,
        upload_files: [...upload.matchAll(/`([^`]+)`/g)].map((u) => path.posix.basename(u[1]!.trim())),
        first_frame_desc: frame.trim(),
        prompt: text.slice(fence.start, fence.end),
        prompt_range: [fence.start, fence.end],
      });
    } else if (/^## Khóa nhất quán\b/.test(nfc(h.line))) {
      styleLock = text.slice(h.index + h.line.length, bodyEnd(i)).trim();
    }
  });
  const brief = (firstSceneAt === -1 ? text : text.slice(0, firstSceneAt)).trim();
  return { brief, style_lock: styleLock, scenes };
}

/**
 * Kiểm tra prompt đã parse đúng là chuỗi con NGUYÊN VĂN của file: bằng đúng text.slice(range) và nằm kẹp giữa
 * dòng ``` mở và dòng ``` đóng. Ném lỗi nếu sai.
 */
export function assertPromptVerbatim(text: string, scene: ParsedScene): void {
  const [start, end] = scene.prompt_range;
  if (text.slice(start, end) !== scene.prompt) throw new Error(`${scene.code}: prompt đã parse không khớp nguyên văn với file`);
  if (!/(^|\n)```[^\n]*\n$/.test(text.slice(Math.max(0, start - 200), start))) {
    throw new Error(`${scene.code}: prompt không đứng ngay sau dòng \`\`\` mở`);
  }
  if (!/^\r?\n```/.test(text.slice(end, end + 8))) throw new Error(`${scene.code}: prompt không đứng ngay trước dòng \`\`\` đóng`);
  if (scene.prompt.trim() === '') throw new Error(`${scene.code}: prompt rỗng`);
}

// ------------------------------------------------------------------ parse log.md

export interface LogEntry {
  clip: string;
  attempt: number;
  type: string;
  kind: 'storyboard' | 'video' | 'other';
  issue: string;
  conclusion: string;
  verdict: Verdict | null;
}

/** "Đạt…" → pass, "Sửa khi dựng…" → fix_in_edit, "Tạo lại…" → redo. */
export function verdictFromConclusion(conclusion: string): Verdict | null {
  const s = nfc(conclusion).trim().toLowerCase();
  if (s.startsWith('đạt')) return 'pass';
  if (s.startsWith('sửa khi dựng')) return 'fix_in_edit';
  if (s.startsWith('tạo lại')) return 'redo';
  return null;
}

export function parseLogMd(text: string): { entries: LogEntry[]; warnings: string[] } {
  const entries: LogEntry[] = [];
  const warnings: string[] = [];
  text.split(/\r?\n/).forEach((raw, idx) => {
    const line = raw.trim();
    if (!line.startsWith('|')) return;
    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.length < 5) {
      warnings.push(`log.md dòng ${idx + 1}: ít hơn 5 cột, bỏ qua`);
      return;
    }
    if (cells.every((c) => /^:?-{3,}:?$/.test(c))) return; // dòng phân cách
    if (nfc(cells[0]!).toLowerCase() === 'clip') return; // dòng tiêu đề
    const attempt = Number(cells[1]);
    if (!/^C\d+$/i.test(cells[0]!) || !Number.isInteger(attempt) || attempt < 1) {
      warnings.push(`log.md dòng ${idx + 1}: không đọc được clip/lần (${cells[0]} | ${cells[1]}), bỏ qua`);
      return;
    }
    // Nếu có dấu | thừa trong ô, gộp phần giữa vào "lỗi thấy được".
    const type = cells[2]!;
    const conclusion = cells[cells.length - 1]!;
    const issue = cells.slice(3, cells.length - 1).join(' / ');
    const t = nfc(type).toLowerCase();
    entries.push({
      clip: cells[0]!.toUpperCase(),
      attempt,
      type,
      kind: t.startsWith('storyboard') ? 'storyboard' : t.startsWith('video') ? 'video' : 'other',
      issue,
      conclusion,
      verdict: verdictFromConclusion(conclusion),
    });
  });
  return { entries, warnings };
}

// ------------------------------------------------------------------ quét file dữ liệu cũ + ffprobe

export interface LegacyFile {
  kind: AssetKind;
  code: string;
  attempt: number;
  /** Đường dẫn tương đối từ ROOT (posix). */
  rel: string;
  abs: string;
  size: number;
  mtime: string;
}

const KIND_ORDER: Record<AssetKind, number> = { storyboard: 0, video: 1, grid: 2 };
const codeNum = (code: string): number => Number(code.replace(/\D/g, '')) || 0;

export function scanLegacyFiles(rootDir: string, dirAbs: string): LegacyFile[] {
  const out: LegacyFile[] = [];
  const scan = (sub: string, patterns: { re: RegExp; kind: AssetKind; attempt: (m: RegExpExecArray) => number }[]) => {
    const dir = path.join(dirAbs, sub);
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir).sort()) {
      const nm = nfc(name);
      for (const p of patterns) {
        const m = p.re.exec(nm);
        if (!m) continue;
        const abs = path.join(dir, name);
        const st = fs.statSync(abs);
        if (!st.isFile()) continue;
        out.push({
          kind: p.kind,
          code: m[1]!.toUpperCase(),
          attempt: p.attempt(m),
          rel: path.relative(rootDir, abs).split(path.sep).join('/'),
          abs,
          size: st.size,
          mtime: st.mtime.toISOString(),
        });
        break;
      }
    }
  };
  scan('storyboard', [{ re: /^(C\d+)_storyboard(?:_v(\d+))?\.(?:png|jpe?g|webp)$/i, kind: 'storyboard', attempt: (m) => Number(m[2] ?? 1) }]);
  scan('video', [
    { re: /^(C\d+)_v(\d+)_grid\.jpe?g$/i, kind: 'grid', attempt: (m) => Number(m[2]) },
    { re: /^(C\d+)_v(\d+)\.mp4$/i, kind: 'video', attempt: (m) => Number(m[2]) },
  ]);
  return out.sort(
    (a, b) => codeNum(a.code) - codeNum(b.code) || a.attempt - b.attempt || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.rel.localeCompare(b.rel),
  );
}

export interface ProbeMeta {
  width?: number;
  height?: number;
  duration_s?: number;
}
export type ProbeFn = (absPath: string, kind: AssetKind) => ProbeMeta | null;

export function hasFfprobe(): boolean {
  try {
    return spawnSync('ffprobe', ['-version'], { stdio: 'ignore', timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}

/** Đọc width/height (và duration_s cho video) bằng ffprobe; null nếu lỗi. */
export const ffprobeMeta: ProbeFn = (abs, kind) => {
  try {
    const r = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', abs], {
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (r.status !== 0) return null;
    const j = JSON.parse(r.stdout) as { streams?: { codec_type?: string; width?: number; height?: number }[]; format?: { duration?: string } };
    const v = j.streams?.find((s) => s.codec_type === 'video');
    const meta: ProbeMeta = {};
    if (v?.width && v?.height) {
      meta.width = v.width;
      meta.height = v.height;
    }
    if (kind === 'video') {
      const d = Number(j.format?.duration);
      if (Number.isFinite(d) && d > 0) meta.duration_s = Math.round(d * 100) / 100;
    }
    return Object.keys(meta).length ? meta : null;
  } catch {
    return null;
  }
};

// ------------------------------------------------------------------ nhập vào DB

export interface LegacyImportOptions {
  /** Thư mục dữ liệu cũ, tương đối từ ROOT hoặc tuyệt đối; phải nằm dưới ROOT/output. Mặc định output/cacao-smoothie. */
  dir?: string;
  /** File prompts (mặc định ROOT/cacao-smoothie-prompts.md). */
  promptsFile?: string;
  /** Thư mục ảnh mockup (mặc định ROOT/MOCKUP_BOX). */
  mockupDir?: string;
  /** Thư mục chứa C<n>_prompt_v<k>.txt tùy chọn (mặc định ROOT/legacy). */
  legacyPromptDir?: string;
  /** Hàm đọc meta media. Mặc định: ffprobe nếu có. `false` = không đọc meta. */
  probe?: ProbeFn | false;
}

export interface LegacyImportSummary {
  project: { id: number; slug: string; name: string; created: boolean };
  /** Tổng số bản ghi hiện có của dự án sau khi nhập. */
  counts: {
    scenes: number;
    storyboards: number;
    videos: number;
    grids: number;
    refs: number;
    prompt_versions: number;
    comments: number;
    events: number;
    ledger_entries: number;
    final_cuts: number;
  };
  /** Số hàng MỚI trong mỗi bảng của lần chạy này (lần chạy lặp lại = toàn 0). */
  created: Record<string, number>;
  credits: { used: number; reserved: number; per_video: number };
  scenes: {
    code: string;
    status: SceneStatus;
    attempts_used: number;
    max_attempts: number;
    selected_attempt: number | null;
    prompt_version: number;
  }[];
  prompts_verbatim: boolean;
  warnings: string[];
}

const COUNTED_TABLES = ['projects', 'project_refs', 'scenes', 'scene_prompt_versions', 'jobs', 'assets', 'comments', 'events', 'credit_ledger', 'final_cuts'] as const;

export function tableCounts(ctx: AppContext): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of COUNTED_TABLES) out[t] = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  return out;
}

const isoOrNow = (ctx: AppContext, iso: string | undefined): string => iso ?? ctx.now();

interface LegacyPromptFile {
  code: string;
  version: number;
  file: string;
  text: string;
}

/** `legacy/C1_prompt_v2.txt`: prompt bản k ≥ 2 do người dùng dán lại (nguyên văn, chỉ bỏ BOM và khoảng trắng cuối file). */
function readLegacyPromptFiles(dir: string): LegacyPromptFile[] {
  if (!fs.existsSync(dir)) return [];
  const out: LegacyPromptFile[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const m = /^(C\d+)_prompt_v(\d+)\.txt$/i.exec(name);
    if (!m || Number(m[2]) < 2) continue;
    const text = fs.readFileSync(path.join(dir, name), 'utf8').replace(/^\uFEFF/, '').trimEnd();
    if (text.trim() === '') continue;
    out.push({ code: m[1]!.toUpperCase(), version: Number(m[2]), file: name, text });
  }
  return out.sort((a, b) => codeNum(a.code) - codeNum(b.code) || a.version - b.version);
}

/** Copy một ảnh mockup vào refs/<projectId>/ (dùng lại file cùng nội dung nếu đã có, không thì thêm hậu tố -2, -3…). */
function copyRefFile(rootDir: string, projectId: number, source: string): string {
  const buf = fs.readFileSync(source);
  const ext = path.extname(source).slice(1).toLowerCase();
  const type: ImageType | null = detectImageType(buf) ?? (ext === 'png' || ext === 'webp' ? ext : ext === 'jpg' || ext === 'jpeg' ? 'jpg' : null);
  if (!type) throw new Error(`Ảnh tham chiếu không phải png/jpg/webp: ${source}`);
  const base = sanitizeBaseName(path.basename(source));
  const dir = path.join(rootDir, 'refs', String(projectId));
  fs.mkdirSync(dir, { recursive: true });
  let name = `${base}.${type}`;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) {
    if (fs.readFileSync(path.join(dir, name)).equals(buf)) return `refs/${projectId}/${name}`;
    name = `${base}-${i}.${type}`;
  }
  fs.writeFileSync(path.join(dir, name), buf);
  return `refs/${projectId}/${name}`;
}

export function importLegacy(ctx: AppContext, opts: LegacyImportOptions = {}): LegacyImportSummary {
  const rootDir = ctx.config.rootDir;
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);

  // ---- đường dẫn nguồn
  const dirAbs = path.resolve(rootDir, opts.dir ?? DEFAULT_LEGACY_DIR);
  const relDir = path.relative(path.join(rootDir, 'output'), dirAbs);
  if (relDir === '' || relDir.startsWith('..') || path.isAbsolute(relDir) || relDir.includes(path.sep)) {
    throw new Error(`--dir phải là một thư mục con trực tiếp của ${path.join(rootDir, 'output')} (nhận được ${dirAbs})`);
  }
  if (!fs.existsSync(dirAbs) || !fs.statSync(dirAbs).isDirectory()) throw new Error(`Không thấy thư mục dữ liệu cũ: ${dirAbs}`);
  const slug = path.basename(dirAbs);
  if (slug !== slugify(slug)) throw new Error(`Tên thư mục "${slug}" không phải slug hợp lệ (a-z, 0-9, dấu -)`);

  const promptsPath = path.resolve(rootDir, opts.promptsFile ?? PROMPTS_FILE);
  if (!fs.existsSync(promptsPath)) throw new Error(`Không thấy file prompt: ${promptsPath}`);
  const promptsText = fs.readFileSync(promptsPath, 'utf8');
  const parsed = parsePromptsMarkdown(promptsText);
  if (parsed.scenes.length === 0) throw new Error(`Không tìm thấy mục "## C<n>: …" nào trong ${promptsPath}`);
  for (const s of parsed.scenes) assertPromptVerbatim(promptsText, s);

  const logPath = path.join(dirAbs, 'log.md');
  let logEntries: LogEntry[] = [];
  if (fs.existsSync(logPath)) {
    const lg = parseLogMd(fs.readFileSync(logPath, 'utf8'));
    logEntries = lg.entries;
    lg.warnings.forEach(warn);
  } else {
    warn(`Không thấy ${path.relative(rootDir, logPath)}: video/storyboard sẽ không có kết luận`);
  }

  const files = scanLegacyFiles(rootDir, dirAbs);
  const promptFiles = readLegacyPromptFiles(path.resolve(rootDir, opts.legacyPromptDir ?? LEGACY_PROMPT_DIR));
  const mockupDir = path.resolve(rootDir, opts.mockupDir ?? MOCKUP_DIR);

  let probe: ProbeFn | null = null;
  if (opts.probe === false) probe = null;
  else if (opts.probe) probe = opts.probe;
  else if (hasFfprobe()) probe = ffprobeMeta;
  else warn('Không có ffprobe: bỏ qua meta (độ phân giải, thời lượng) của asset');

  const before = tableCounts(ctx);
  const key = (suffix: string): string => `legacy:${slug}:${suffix}`;
  const db = ctx.db;

  const result = ctx.tx(() => {
    const ensureEvent = (ev: NewEvent & { ext_key: string }): void => {
      if (!db.prepare('SELECT 1 FROM events WHERE ext_key = ?').get(ev.ext_key)) logEvent(ctx, ev);
    };

    // ---- dự án (theo slug)
    let project = db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug) as ProjectRow | undefined;
    const projectCreated = !project;
    if (!project) {
      const now = ctx.now();
      const info = db
        .prepare(
          `INSERT INTO projects (slug, name, brief, style_lock, max_attempts_per_scene, credit_per_video, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 2, 15, 'active', ?, ?)`,
        )
        .run(slug, LEGACY_PROJECT_NAME, parsed.brief, parsed.style_lock, now, now);
      project = getProject(ctx, Number(info.lastInsertRowid));
    }
    const pid = project.id;
    ensureEvent({
      project_id: pid,
      type: 'project.created',
      message: `${IMPORT_REASON}: tạo dự án "${project.name}" từ ${path.relative(rootDir, dirAbs)}`,
      ext_key: key('project'),
    });

    // ---- ảnh tham chiếu (theo (project_id, label)); file copy vào refs/<projectId>/
    const refIds: Record<string, number> = {};
    const refByAlias = new Map<string, (typeof LEGACY_REFS)[number]>();
    for (const r of LEGACY_REFS) for (const a of r.aliases) refByAlias.set(a, r);
    for (const r of LEGACY_REFS) {
      const existing = db.prepare('SELECT * FROM project_refs WHERE project_id = ? AND label = ?').get(pid, r.label) as RefRow | undefined;
      const source = path.join(mockupDir, r.file);
      if (existing) {
        refIds[r.key] = existing.id;
        if (!fs.existsSync(path.join(rootDir, existing.file_path)) && fs.existsSync(source)) {
          fs.mkdirSync(path.dirname(path.join(rootDir, existing.file_path)), { recursive: true });
          fs.copyFileSync(source, path.join(rootDir, existing.file_path));
          warn(`Ảnh tham chiếu "${r.label}" bị mất file, đã copy lại ${existing.file_path}`);
        }
        if (!existing.content_hash && fs.existsSync(path.join(rootDir, existing.file_path))) {
          db.prepare('UPDATE project_refs SET content_hash = ? WHERE id = ?').run(
            hashBuffer(fs.readFileSync(path.join(rootDir, existing.file_path))),
            existing.id,
          );
        }
        continue;
      }
      if (!fs.existsSync(source)) {
        warn(`Không thấy ${path.relative(rootDir, source)}: bỏ qua ảnh tham chiếu "${r.label}"`);
        continue;
      }
      const rel = copyRefFile(rootDir, pid, source);
      const order = (db.prepare('SELECT COALESCE(MAX(order_index), -1) + 1 AS n FROM project_refs WHERE project_id = ?').get(pid) as { n: number }).n;
      const info = db
        .prepare(
          'INSERT INTO project_refs (project_id, label, file_path, original_name, order_index, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(pid, r.label, rel, path.basename(source), order, hashBuffer(fs.readFileSync(path.join(rootDir, rel))), ctx.now());
      refIds[r.key] = Number(info.lastInsertRowid);
    }

    // ---- cảnh + phiên bản prompt
    const sceneByCode = new Map<string, SceneRow>();
    const newScenes = new Set<string>();
    const warnedAlias = new Set<string>();
    for (const ps of parsed.scenes) {
      const uploadRefs: number[] = [];
      for (const f of ps.upload_files) {
        const r = refByAlias.get(f.toLowerCase());
        if (!r) {
          warn(`${ps.code}: ảnh "${f}" trong dòng Upload không khớp ảnh tham chiếu nào, bỏ qua`);
          continue;
        }
        if (f.toLowerCase() !== r.file.toLowerCase() && !warnedAlias.has(f)) {
          warnedAlias.add(f);
          warn(`Kịch bản nhắc tới ${f} nhưng file này không tồn tại; dùng ${r.file} (theo log.md)`);
        }
        const id = refIds[r.key];
        if (id !== undefined && !uploadRefs.includes(id)) uploadRefs.push(id);
      }
      let scene = db.prepare('SELECT * FROM scenes WHERE project_id = ? AND code = ?').get(pid, ps.code) as SceneRow | undefined;
      if (!scene) {
        const now = ctx.now();
        const info = db
          .prepare(
            `INSERT INTO scenes (project_id, code, order_index, title, prompt, first_frame_desc, upload_refs, use_prev_storyboard, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
          )
          .run(pid, ps.code, ps.order_index, ps.title, ps.prompt, ps.first_frame_desc, JSON.stringify(uploadRefs), ps.order_index > 0 ? 1 : 0, now, now);
        scene = getScene(ctx, Number(info.lastInsertRowid));
        newScenes.add(ps.code);
        logEvent(ctx, {
          project_id: pid,
          scene_id: scene.id,
          type: 'scene.created',
          message: `${ps.code}: ${IMPORT_REASON} từ ${path.basename(promptsPath)} ("${ps.title}")`,
          ext_key: key(`scene:${ps.code}`),
        });
      }
      sceneByCode.set(ps.code, scene);

      // version 1 = bản gốc (nguyên văn); không tạo nếu cảnh đã có version 1 từ nguồn khác
      const v1Key = key(`prompt:${ps.code}:v1`);
      const hasV1 =
        db.prepare('SELECT 1 FROM scene_prompt_versions WHERE ext_key = ?').get(v1Key) ||
        db.prepare('SELECT 1 FROM scene_prompt_versions WHERE scene_id = ? AND version = 1').get(scene.id);
      if (!hasV1) {
        db.prepare('INSERT INTO scene_prompt_versions (scene_id, version, prompt, reason, created_by, created_at, ext_key) VALUES (?, 1, ?, ?, ?, ?, ?)').run(
          scene.id,
          ps.prompt,
          `Bản gốc nhập từ ${path.basename(promptsPath)}`,
          'claude',
          ctx.now(),
          v1Key,
        );
      }
    }

    // prompt bản k ≥ 2 từ legacy/<code>_prompt_v<k>.txt (nếu có)
    const promptFileKeys = new Set<string>();
    for (const pf of promptFiles) {
      const scene = sceneByCode.get(pf.code);
      if (!scene) {
        warn(`legacy/${pf.file}: không có cảnh ${pf.code}, bỏ qua`);
        continue;
      }
      promptFileKeys.add(`${pf.code}|${pf.version}`);
      const vKey = key(`prompt:${pf.code}:v${pf.version}`);
      if (db.prepare('SELECT 1 FROM scene_prompt_versions WHERE ext_key = ?').get(vKey)) continue;
      if (db.prepare('SELECT 1 FROM scene_prompt_versions WHERE scene_id = ? AND version = ?').get(scene.id, pf.version)) {
        warn(`${pf.code}: đã có prompt version ${pf.version} (nguồn khác), bỏ qua legacy/${pf.file}`);
        continue;
      }
      const row = logEntries.find((e) => e.clip === pf.code && e.attempt === pf.version && e.kind === 'video');
      const prev = db
        .prepare('SELECT version, prompt FROM scene_prompt_versions WHERE scene_id = ? ORDER BY version DESC LIMIT 1')
        .get(scene.id) as { version: number; prompt: string } | undefined;
      db.prepare('INSERT INTO scene_prompt_versions (scene_id, version, prompt, reason, created_by, created_at, ext_key) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        scene.id,
        pf.version,
        pf.text,
        row?.type || `${IMPORT_REASON} từ ${LEGACY_PROMPT_DIR}/${pf.file}`,
        'user',
        ctx.now(),
        vKey,
      );
      const current = getScene(ctx, scene.id);
      // chỉ đặt làm prompt hiện tại khi người dùng chưa tự sửa (mọi version đang có đều do import) và prompt hiện tại là bản mới nhất
      const userEdited = !!db
        .prepare("SELECT 1 FROM scene_prompt_versions WHERE scene_id = ? AND (ext_key IS NULL OR ext_key NOT LIKE 'legacy:%')")
        .get(scene.id);
      if (prev && !userEdited && current.prompt === prev.prompt && pf.version > prev.version) {
        db.prepare('UPDATE scenes SET prompt = ?, updated_at = ? WHERE id = ?').run(pf.text, ctx.now(), scene.id);
        sceneByCode.set(pf.code, getScene(ctx, scene.id));
      } else {
        warn(`${pf.code}: prompt hiện tại đã được sửa tay, giữ nguyên; version ${pf.version} chỉ nằm trong lịch sử`);
      }
      logEvent(ctx, {
        project_id: pid,
        scene_id: scene.id,
        type: 'scene.prompt',
        message: `${pf.code}: ${IMPORT_REASON} prompt version ${pf.version} từ ${LEGACY_PROMPT_DIR}/${pf.file}`,
        ext_key: `${vKey}:event`,
      });
    }

    // ---- assets + kết luận từ log.md + sổ cái
    const logByKey = new Map<string, LogEntry>();
    for (const e of logEntries) {
      if (e.kind === 'other') {
        warn(`log.md: dòng ${e.clip} lần ${e.attempt} có loại lạ ("${e.type}"), bỏ qua`);
        continue;
      }
      const k = `${e.clip}|${e.attempt}|${e.kind}`;
      if (logByKey.has(k)) warn(`log.md: trùng dòng ${e.clip} lần ${e.attempt} ${e.kind}; dùng dòng đầu`);
      else logByKey.set(k, e);
    }
    const matchedLog = new Set<string>();
    const assetIds = new Map<string, number>(); // "C1|video|2" → asset id
    for (const f of files) {
      const scene = sceneByCode.get(f.code);
      if (!scene) {
        warn(`${f.rel}: không có cảnh ${f.code} trong file prompt, bỏ qua`);
        continue;
      }
      const aKey = key(`asset:${f.kind}:${f.code}:${f.attempt}`);
      const existing = db.prepare('SELECT id FROM assets WHERE ext_key = ?').get(aKey) as { id: number } | undefined;
      if (existing) {
        assetIds.set(`${f.code}|${f.kind}|${f.attempt}`, existing.id);
        if (f.kind !== 'grid') matchedLog.add(`${f.code}|${f.attempt}|${f.kind}`);
        continue;
      }
      const meta: Record<string, unknown> = { legacy: true };
      const probed = probe ? probe(f.abs, f.kind) : null;
      if (probe && !probed) warn(`${f.rel}: ffprobe không đọc được meta`);
      Object.assign(meta, probed ?? {});
      meta.size_bytes = f.size;
      let verdict: Verdict | null = null;
      let note: string | null = null;
      if (f.kind !== 'grid') {
        const k = `${f.code}|${f.attempt}|${f.kind}`;
        const entry = logByKey.get(k);
        if (entry) {
          matchedLog.add(k);
          verdict = entry.verdict;
          note = entry.issue;
          meta.legacy_type = entry.type;
          meta.legacy_conclusion = entry.conclusion;
          if (!entry.verdict) warn(`${f.code} lần ${f.attempt} ${f.kind}: không nhận ra kết luận "${entry.conclusion}"`);
        } else {
          warn(`${f.rel}: không có dòng tương ứng trong log.md (không có kết luận)`);
        }
      }
      const info = db
        .prepare(
          `INSERT INTO assets (scene_id, job_id, kind, file_path, attempt, meta, verdict, verdict_note, created_at, ext_key)
           VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(scene.id, f.kind, f.rel, f.attempt, JSON.stringify(meta), verdict, note, isoOrNow(ctx, f.mtime), aKey);
      assetIds.set(`${f.code}|${f.kind}|${f.attempt}`, Number(info.lastInsertRowid));
    }
    for (const [k, e] of logByKey) {
      if (!matchedLog.has(k)) warn(`log.md: dòng ${e.clip} lần ${e.attempt} ${e.kind} không có file tương ứng`);
    }

    // sổ cái: mỗi video −credit_per_video
    for (const f of files) {
      if (f.kind !== 'video') continue;
      const scene = sceneByCode.get(f.code);
      if (!scene) continue;
      const lKey = key(`ledger:${f.code}:${f.attempt}`);
      if (db.prepare('SELECT 1 FROM credit_ledger WHERE ext_key = ?').get(lKey)) continue;
      db.prepare('INSERT INTO credit_ledger (project_id, scene_id, job_id, delta, note, created_at, ext_key) VALUES (?, ?, NULL, ?, ?, ?, ?)').run(
        pid,
        scene.id,
        -project.credit_per_video,
        `Nhập từ log.md: ${f.code} lượt ${f.attempt}`,
        isoOrNow(ctx, f.mtime),
        lKey,
      );
    }

    // ---- ghi chú "prompt chưa được lưu" cho lượt dùng prompt đã sửa
    for (const e of logEntries) {
      if (e.kind !== 'video' || e.attempt < 2 || !/prompt\s+(đã\s+)?sửa/i.test(nfc(e.type))) continue;
      const scene = sceneByCode.get(e.clip);
      if (!scene) continue;
      const cKey = key(`comment:${e.clip}:prompt-v${e.attempt}-missing`);
      const have = db.prepare('SELECT id, resolved FROM comments WHERE ext_key = ?').get(cKey) as { id: number; resolved: number } | undefined;
      if (promptFileKeys.has(`${e.clip}|${e.attempt}`)) {
        if (have && !have.resolved) db.prepare('UPDATE comments SET resolved = 1 WHERE id = ?').run(have.id); // đã có prompt → ghi chú hết tác dụng
        continue;
      }
      const variant = /kéo/i.test(nfc(e.type)) ? 'có kéo' : 'đã sửa';
      warn(
        `${e.clip}: lượt ${e.attempt} dùng bản prompt ${variant} nhưng nguyên văn không được lưu ở đâu (không tự bịa). ` +
          `Đặt prompt vào ${LEGACY_PROMPT_DIR}/${e.clip}_prompt_v${e.attempt}.txt rồi chạy lại import, hoặc dán bằng trình sửa prompt.`,
      );
      if (have) continue;
      const body =
        `Lượt ${e.attempt} dùng bản prompt ${variant} (theo log.md) nhưng nguyên văn chưa được lưu; ` +
        `hãy dán lại bằng trình sửa prompt hoặc đặt vào ${LEGACY_PROMPT_DIR}/${e.clip}_prompt_v${e.attempt}.txt rồi chạy lại import.`;
      db.prepare('INSERT INTO comments (scene_id, asset_id, author, body, timecode, action, resolved, created_at, ext_key) VALUES (?, ?, ?, ?, NULL, ?, 0, ?, ?)').run(
        scene.id,
        assetIds.get(`${e.clip}|video|${e.attempt}`) ?? null,
        'claude',
        body,
        'note',
        ctx.now(),
        cKey,
      );
      logEvent(ctx, {
        project_id: pid,
        scene_id: scene.id,
        type: 'comment.created',
        message: `${e.clip}: Claude comment: ${body.slice(0, 120)}`,
        ext_key: `${cKey}:event`,
      });
    }

    // ---- video được chọn + trạng thái (chỉ với cảnh vừa tạo ở lần chạy này)
    const selectedAttempt = new Map<string, number>();
    for (const ps of parsed.scenes) {
      const scene = sceneByCode.get(ps.code)!;
      const videos = files.filter((f) => f.kind === 'video' && f.code === ps.code).sort((a, b) => a.attempt - b.attempt);
      // Ưu tiên: lựa chọn ghi trong log.md ("chọn v2") > bản mới nhất Đạt/Sửa khi dựng > bản mới nhất
      let chosen: number | undefined;
      for (const e of logEntries) {
        const m = e.clip === ps.code && e.kind === 'video' ? /chọn\s+v(\d+)/i.exec(nfc(e.conclusion)) : null;
        if (m && videos.some((v) => v.attempt === Number(m[1]))) chosen = Number(m[1]);
      }
      if (chosen === undefined) {
        const ok = videos.filter((v) => {
          const verdict = logByKey.get(`${ps.code}|${v.attempt}|video`)?.verdict;
          return verdict === 'pass' || verdict === 'fix_in_edit';
        });
        chosen = (ok.length ? ok : videos).at(-1)?.attempt;
      }
      const chosenId = chosen !== undefined ? assetIds.get(`${ps.code}|video|${chosen}`) : undefined;
      if (!newScenes.has(ps.code)) {
        const cur = getScene(ctx, scene.id);
        const sel = cur.selected_video_id ? (db.prepare('SELECT attempt FROM assets WHERE id = ?').get(cur.selected_video_id) as { attempt: number } | undefined) : undefined;
        if (sel) selectedAttempt.set(ps.code, sel.attempt);
        continue;
      }
      let status: SceneStatus = 'awaiting_approval';
      if (chosenId !== undefined) {
        db.prepare('UPDATE scenes SET selected_video_id = ?, updated_at = ? WHERE id = ?').run(chosenId, ctx.now(), scene.id);
        selectedAttempt.set(ps.code, chosen!);
        logEvent(ctx, {
          project_id: pid,
          scene_id: scene.id,
          type: 'scene.video_selected',
          message: `${ps.code}: chọn video lượt ${chosen} (asset #${chosenId}) — ${IMPORT_REASON}`,
          ext_key: key(`select:${ps.code}`),
        });
        status = 'done';
      } else if (files.some((f) => f.kind === 'storyboard' && f.code === ps.code)) {
        status = 'storyboard_review';
      }
      transition(ctx, scene.id, status, IMPORT_REASON, { force: true });
    }

    // ---- kiểm tra nguyên văn trong DB: prompt version 1 == chuỗi con của file
    for (const ps of parsed.scenes) {
      const scene = sceneByCode.get(ps.code)!;
      const v1 = db.prepare('SELECT prompt, ext_key FROM scene_prompt_versions WHERE scene_id = ? AND version = 1').get(scene.id) as
        | { prompt: string; ext_key: string | null }
        | undefined;
      if (v1?.ext_key === key(`prompt:${ps.code}:v1`) && v1.prompt !== promptsText.slice(ps.prompt_range[0], ps.prompt_range[1])) {
        throw new Error(`${ps.code}: prompt lưu trong DB không khớp nguyên văn với file`);
      }
    }

    // ---- bản dựng thử có sẵn (final cut v1). KHÔNG kích hoạt edit_plan: lựa chọn video đã có final_cut.
    registerTrialFinalCut();

    return { project: getProject(ctx, pid), projectCreated, selectedAttempt };

    function registerTrialFinalCut(): void {
      if (slug !== LEGACY_TRIAL_FINAL.slug) return;
      const rel = finalPaths(slug, LEGACY_TRIAL_FINAL.version);
      const videoAbs = path.join(rootDir, rel.video_path);
      if (!fs.existsSync(videoAbs)) return; // chỉ đăng ký nếu file tồn tại
      const extKey = key('final:v1');
      if (db.prepare('SELECT 1 FROM final_cuts WHERE ext_key = ?').get(extKey)) return;
      if (db.prepare('SELECT 1 FROM final_cuts WHERE project_id = ? AND version = ?').get(pid, LEGACY_TRIAL_FINAL.version)) {
        warn(`Dự án đã có bản dựng v${LEGACY_TRIAL_FINAL.version}: bỏ qua việc đăng ký bản thử`);
        return;
      }
      const rows = db
        .prepare(
          `SELECT s.id AS scene_id, s.code, s.selected_video_id, a.attempt, a.meta
           FROM scenes s LEFT JOIN assets a ON a.id = s.selected_video_id WHERE s.project_id = ? ORDER BY s.order_index, s.id`,
        )
        .all(pid) as { scene_id: number; code: string; selected_video_id: number | null; attempt: number | null; meta: string | null }[];
      if (rows.length === 0 || rows.some((r) => r.selected_video_id === null)) {
        warn('Bỏ qua bản dựng thử: có cảnh chưa chọn video');
        return;
      }
      const selection: SelectionItem[] = rows.map((r) => ({ scene_id: r.scene_id, code: r.code, asset_id: r.selected_video_id!, attempt: r.attempt ?? 1 }));
      const edl: Edl = {
        scenes: rows.map((r) => {
          const cp = LEGACY_TRIAL_FINAL.cuts[r.code] ?? { in_s: 0, out_s: 0 };
          let dur: number | null = null;
          try {
            const m = JSON.parse(r.meta ?? '{}') as { duration_s?: unknown };
            if (typeof m.duration_s === 'number') dur = m.duration_s;
          } catch {
            /* meta hỏng */
          }
          const removed: Edl['scenes'][number]['removed'] = [];
          if (cp.in_s > 0) removed.push({ from_s: 0, to_s: cp.in_s, reason: 'cắt thử' });
          if (dur !== null && dur - cp.out_s > 0.0005) removed.push({ from_s: cp.out_s, to_s: Math.round(dur * 1000) / 1000, reason: 'cắt thử' });
          return { scene_id: r.scene_id, asset_id: r.selected_video_id!, segments: [{ in_s: cp.in_s, out_s: cp.out_s }], removed, note: '' };
        }),
      };
      const exists = (p: string) => fs.existsSync(path.join(rootDir, p));
      const duration = probe ? probe(videoAbs, 'video')?.duration_s : undefined;
      const now = ctx.now();
      db.prepare(
        `INSERT INTO final_cuts (project_id, version, status, selection, selection_signature, edl, renderer, video_path, project_file_path, contact_sheet_path,
                                 duration_s, progress, created_by, note, summary, ext_key, created_at, finished_at)
         VALUES (?, ?, 'ready', ?, ?, ?, 'shotcut', ?, ?, ?, ?, 100, 'user', ?, NULL, ?, ?, ?)`,
      ).run(
        pid,
        LEGACY_TRIAL_FINAL.version,
        JSON.stringify(selection),
        selectionSignature(rows.map((r) => [r.scene_id, r.selected_video_id])),
        JSON.stringify(edl),
        rel.video_path,
        exists(rel.project_file_path) ? rel.project_file_path : null,
        exists(rel.contact_sheet_path) ? rel.contact_sheet_path : null,
        typeof duration === 'number' ? Math.round(duration * 1000) / 1000 : null,
        LEGACY_TRIAL_FINAL.note,
        extKey,
        now,
        now,
      );
      ensureEvent({
        project_id: pid,
        type: 'final_cut.created',
        message: `${IMPORT_REASON}: đăng ký bản dựng thử v${LEGACY_TRIAL_FINAL.version} (Shotcut MCP, điểm cắt đặt tay)`,
        ext_key: key('final:v1:event'),
      });
    }
  });

  // ---- tổng kết
  const { project, projectCreated, selectedAttempt } = result;
  const pid = project.id;
  const scalar = (sql: string): number => (db.prepare(sql).get(pid) as { n: number }).n;
  const after = tableCounts(ctx);
  const created: Record<string, number> = {};
  for (const t of COUNTED_TABLES) created[t] = (after[t] ?? 0) - (before[t] ?? 0);
  const { used, reserved } = budgetNumbers(ctx, project);
  const sceneRows = db.prepare('SELECT * FROM scenes WHERE project_id = ? ORDER BY order_index, id').all(pid) as SceneRow[];
  return {
    project: { id: pid, slug: project.slug, name: project.name, created: projectCreated },
    counts: {
      scenes: sceneRows.length,
      storyboards: scalar("SELECT COUNT(*) AS n FROM assets a JOIN scenes s ON s.id = a.scene_id WHERE s.project_id = ? AND a.kind = 'storyboard'"),
      videos: scalar("SELECT COUNT(*) AS n FROM assets a JOIN scenes s ON s.id = a.scene_id WHERE s.project_id = ? AND a.kind = 'video'"),
      grids: scalar("SELECT COUNT(*) AS n FROM assets a JOIN scenes s ON s.id = a.scene_id WHERE s.project_id = ? AND a.kind = 'grid'"),
      refs: scalar('SELECT COUNT(*) AS n FROM project_refs WHERE project_id = ?'),
      prompt_versions: scalar('SELECT COUNT(*) AS n FROM scene_prompt_versions v JOIN scenes s ON s.id = v.scene_id WHERE s.project_id = ?'),
      comments: scalar('SELECT COUNT(*) AS n FROM comments c JOIN scenes s ON s.id = c.scene_id WHERE s.project_id = ?'),
      events: scalar('SELECT COUNT(*) AS n FROM events WHERE project_id = ?'),
      ledger_entries: scalar('SELECT COUNT(*) AS n FROM credit_ledger WHERE project_id = ?'),
      final_cuts: scalar('SELECT COUNT(*) AS n FROM final_cuts WHERE project_id = ?'),
    },
    created,
    credits: { used, reserved, per_video: project.credit_per_video },
    scenes: sceneRows.map((s) => ({
      code: s.code,
      status: s.status,
      attempts_used: attemptsUsed(ctx, s.id),
      max_attempts: project.max_attempts_per_scene,
      selected_attempt: selectedAttempt.get(s.code) ?? null,
      prompt_version: (db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM scene_prompt_versions WHERE scene_id = ?').get(s.id) as { v: number }).v,
    })),
    prompts_verbatim: true, // assertPromptVerbatim + kiểm tra DB ở trên ném lỗi nếu sai
    warnings,
  };
}

/** Văn bản tóm tắt (tiếng Việt) để in ra console. */
export function formatSummary(s: LegacyImportSummary, dbLabel: string): string {
  const c = s.counts;
  const nonZero = Object.entries(s.created).filter(([, n]) => n !== 0);
  const lines = [
    `Nhập dữ liệu cũ: "${s.project.name}" (slug ${s.project.slug}, id ${s.project.id}) — ${s.project.created ? 'tạo mới' : 'dự án đã có, cập nhật bổ sung'}`,
    `DB: ${dbLabel}`,
    `Hiện có: ${c.scenes} cảnh, ${c.storyboards} storyboard, ${c.videos} video, ${c.grids} ảnh lưới, ${c.refs} ảnh tham chiếu, ${c.prompt_versions} version prompt, ${c.comments} comment, ${c.ledger_entries} dòng sổ cái, ${c.final_cuts} bản dựng hoàn chỉnh, ${c.events} sự kiện`,
    nonZero.length
      ? `Hàng mới ở lần chạy này: ${nonZero.map(([t, n]) => `${t} ${n > 0 ? '+' : ''}${n}`).join(', ')}`
      : 'Hàng mới ở lần chạy này: không có (dữ liệu đã được nhập trước đó)',
    `Credit: đã dùng ${s.credits.used}, đặt trước ${s.credits.reserved} (${s.credits.per_video} credit/video)`,
    ...s.scenes.map(
      (sc) =>
        `  ${sc.code}: ${sc.status}, lượt ${sc.attempts_used}/${sc.max_attempts}, video chọn ${sc.selected_attempt ? 'v' + sc.selected_attempt : '(chưa)'}, prompt v${sc.prompt_version}`,
    ),
    `Prompt nguyên văn: ${s.prompts_verbatim ? 'đã kiểm tra khớp 100% với file' : 'KHÔNG khớp'}`,
  ];
  if (s.warnings.length) lines.push(`Cảnh báo (${s.warnings.length}):`, ...s.warnings.map((w) => `  - ${w}`));
  return lines.join('\n');
}

