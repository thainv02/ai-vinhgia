import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp, type App, type BuildAppOptions } from '../src/app.js';
import { FakeClock } from '../src/lib/clock.js';

export const WORKER_TOKEN = 'test-worker-token';
export const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
export const JPG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);

export interface Env {
  app: App;
  ctx: App['ctx'];
  root: string;
  dbPath: string;
  clock: FakeClock;
  close(): Promise<void>;
  /** Tạo app thứ hai trên cùng DB/ROOT (mô phỏng 2 tiến trình). */
  second(overrides?: Partial<BuildAppOptions>): Promise<App>;
}

export async function makeEnv(opts: Partial<BuildAppOptions> = {}): Promise<Env> {
  const root = opts.rootDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'autovideo-test-'));
  const dbPath = opts.dbPath ?? path.join(root, 'data', 'test.db');
  const clock = new FakeClock();
  const extra: App[] = [];
  const app = await buildApp({
    ...opts,
    rootDir: root,
    dbPath,
    clock,
    logger: false,
    config: { workerToken: WORKER_TOKEN, aiHome: path.join(root, 'private-ai'), ...opts.config },
  });
  return {
    app,
    ctx: app.ctx,
    root,
    dbPath,
    clock,
    async second(overrides: Partial<BuildAppOptions> = {}) {
      const a = await buildApp({
        ...opts,
        ...overrides,
        rootDir: root,
        dbPath,
        clock,
        logger: false,
        config: { workerToken: WORKER_TOKEN, ...opts.config, ...overrides.config },
      });
      extra.push(a);
      return a;
    },
    async close() {
      await app.close();
      for (const a of extra) await a.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export interface Res<T = any> {
  status: number;
  body: T;
  headers: Record<string, any>;
  raw: string;
}

const LOCAL_HEADERS = { host: 'localhost:8787' };

export function client(app: App, extraHeaders: Record<string, string> = {}) {
  async function call(method: string, url: string, payload?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const res = await app.inject({
      method: method as 'GET',
      url,
      payload: payload === undefined ? undefined : (payload as object),
      headers: { ...LOCAL_HEADERS, ...extraHeaders, ...headers },
    });
    let body: any = res.body;
    if (String(res.headers['content-type'] ?? '').includes('application/json')) {
      try {
        body = JSON.parse(res.body);
      } catch {
        /* giữ nguyên */
      }
    }
    return { status: res.statusCode, body, headers: res.headers, raw: res.body };
  }
  return {
    get: (url: string, headers?: Record<string, string>) => call('GET', url, undefined, headers),
    post: (url: string, payload?: unknown, headers?: Record<string, string>) => call('POST', url, payload ?? {}, headers),
    patch: (url: string, payload?: unknown, headers?: Record<string, string>) => call('PATCH', url, payload ?? {}, headers),
    del: (url: string, headers?: Record<string, string>) => call('DELETE', url, undefined, headers),
  };
}

export const userClient = (app: App) => client(app);
export const workerClient = (app: App, token = WORKER_TOKEN) => client(app, { authorization: `Bearer ${token}` });

/** Ghi một file mẫu dưới ROOT (tạo thư mục cha). */
export function writeFile(root: string, rel: string, content: Buffer | string = 'x'): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return rel;
}

export function multipart(parts: { name: string; value?: string; filename?: string; data?: Buffer; type?: string }[]) {
  const boundary = '----testboundary' + Math.random().toString(16).slice(2);
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (p.filename !== undefined) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\nContent-Type: ${p.type ?? 'application/octet-stream'}\r\n\r\n`,
        ),
      );
      chunks.push(p.data ?? Buffer.alloc(0));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n${p.value ?? ''}`));
    }
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

// ---------------------------------------------------------------- kịch bản dùng chung

export interface Scenario {
  env: Env;
  user: ReturnType<typeof client>;
  worker: ReturnType<typeof client>;
  project: any;
  scenes: any[];
}

/** Tạo dự án + n cảnh (qua worker/scenes), mặc định ngân sách 120, 2 lượt, 15 credit/video. */
export async function setupProject(
  env: Env,
  opts: { scenes?: number; project?: Record<string, unknown>; usePrev?: boolean } = {},
): Promise<Scenario> {
  const user = userClient(env.app);
  const worker = workerClient(env.app);
  const created = await user.post('/api/projects', { name: 'Cacao Actiso Plus', brief: 'Quảng cáo sinh tố cacao', ...opts.project });
  if (created.status !== 201) throw new Error('tạo dự án lỗi: ' + created.raw);
  const project = created.body;
  const n = opts.scenes ?? 3;
  const scenes = Array.from({ length: n }, (_, i) => ({
    code: `C${i + 1}`,
    order_index: i,
    title: `Cảnh ${i + 1}`,
    prompt: `Prompt gốc của cảnh ${i + 1}`,
    first_frame_desc: `Khung đầu ${i + 1}`,
    upload_refs: [],
    use_prev_storyboard: opts.usePrev ? i > 0 : false,
  }));
  const r = await worker.post('/api/worker/scenes', { project_id: project.id, scenes });
  if (r.status !== 200) throw new Error('tạo cảnh lỗi: ' + r.raw);
  return { env, user, worker, project, scenes: r.body.scenes };
}

/** Scenario chưa có dự án/cảnh (chỉ có client). */
export function bareScenario(env: Env): Scenario {
  return { env, user: userClient(env.app), worker: workerClient(env.app), project: null, scenes: [] };
}

/** Claim job tiếp theo; ném lỗi nếu không có. */
export async function claim(sc: Scenario, workerId = 'w1') {
  const r = await sc.worker.get(`/api/worker/next?worker=${workerId}`);
  if (r.status !== 200) throw new Error(`next trả ${r.status}: ${r.raw}`);
  return r.body;
}

/** Hoàn thành job (đã claim) bằng cách ghi file mẫu đúng theo payload.output. */
export async function finish(sc: Scenario, job: any, extra: { verdict?: string; verdict_note?: string; credits_cost?: number } = {}) {
  const { root } = sc.env;
  const p = job.payload;
  if (job.type === 'storyboard') {
    writeFile(root, p.output.storyboard_path, PNG_BYTES);
    return sc.worker.post(`/api/worker/jobs/${job.id}/complete`, {
      result: { note: 'ok' },
      assets: [{ kind: 'storyboard', file_path: p.output.storyboard_path, meta: { width: 1, height: 1 } }],
    });
  }
  if (job.type === 'video') {
    writeFile(root, p.output.video_path, 'fake-mp4');
    writeFile(root, p.output.grid_path, JPG_BYTES);
    return sc.worker.post(`/api/worker/jobs/${job.id}/complete`, {
      result: { verdict: extra.verdict ?? 'pass', verdict_note: extra.verdict_note ?? 'không thấy lỗi' },
      assets: [
        { kind: 'video', file_path: p.output.video_path, meta: { duration_s: 10, width: 720, height: 1280 } },
        { kind: 'grid', file_path: p.output.grid_path },
      ],
      credits_cost: extra.credits_cost,
    });
  }
  if (job.type === 'revise_prompt') {
    return sc.worker.post(`/api/worker/jobs/${job.id}/complete`, {
      result: {
        prompt: p.scene.prompt + '\nThêm: kéo cắt gói.',
        reason: 'Theo comment của người dùng',
        resolved_comment_ids: p.comments.map((c: any) => c.id),
      },
    });
  }
  return sc.worker.post(`/api/worker/jobs/${job.id}/complete`, { result: {} });
}

export async function scene(sc: Scenario, id: number) {
  const r = await sc.user.get(`/api/scenes/${id}`);
  return r.body;
}

/** Duyệt storyboard → worker làm xong → cảnh ở storyboard_review. */
export async function toStoryboardReview(sc: Scenario, sceneId: number) {
  const a = await sc.user.post(`/api/scenes/${sceneId}/approve`, { stage: 'storyboard' });
  if (a.status !== 200) throw new Error('approve storyboard lỗi: ' + a.raw);
  const job = await claim(sc);
  const f = await finish(sc, job);
  if (f.status !== 200) throw new Error('complete storyboard lỗi: ' + f.raw);
  return job;
}

/** Từ storyboard_review → approve video → worker xong → video_review. */
export async function toVideoReview(sc: Scenario, sceneId: number, extra: Parameters<typeof finish>[2] = {}) {
  const a = await sc.user.post(`/api/scenes/${sceneId}/approve`, { stage: 'video' });
  if (a.status !== 200) throw new Error('approve video lỗi: ' + a.raw);
  const job = await claim(sc);
  const f = await finish(sc, job, extra);
  if (f.status !== 200) throw new Error('complete video lỗi: ' + f.raw);
  return job;
}

// ---------------------------------------------------------------- bản dựng hoàn chỉnh (final cut)

/** Đưa MỌI cảnh tới `done` (storyboard → video → chọn video). Chọn video cảnh cuối sẽ tự kích hoạt bản dựng + job edit_plan. */
export async function setupAllDone(
  env: Env,
  opts: { scenes?: number; project?: Record<string, unknown> } = {},
): Promise<Scenario> {
  const sc = await setupProject(env, { scenes: opts.scenes ?? 2, project: opts.project });
  for (const s of sc.scenes) {
    await toStoryboardReview(sc, s.id);
    await toVideoReview(sc, s.id, { verdict_note: `ổn ${s.code}` });
    const r = await sc.user.post(`/api/scenes/${s.id}/select-video`, {});
    if (r.status !== 200) throw new Error('select-video lỗi: ' + r.raw);
  }
  return sc;
}

/** EDL hợp lệ: mỗi cảnh một đoạn [from, to] (mặc định 0.5 → 9.5 trên video nguồn 10 giây). */
export function edlFor(_sc: Scenario, cut: any, seg: [number, number] = [0.5, 9.5]) {
  return {
    scenes: cut.selection.map((s: any) => ({
      scene_id: s.scene_id,
      asset_id: s.asset_id,
      segments: [{ in_s: seg[0], out_s: seg[1] }],
      removed: [
        { from_s: 0, to_s: seg[0], reason: 'Đầu chưa có hành động (0–0,5s)' },
        { from_s: seg[1], to_s: 10, reason: 'Cuối khung đứng yên' },
      ],
      note: `ghi chú ${s.code}`,
    })),
  };
}

/** Claim job edit_plan tiếp theo và trả về job. */
export async function claimEditPlan(sc: Scenario, workerId = 'w1') {
  const job = await claim(sc, workerId);
  if (job.type !== 'edit_plan') throw new Error(`mong job edit_plan, nhận ${job.type}`);
  return job;
}
