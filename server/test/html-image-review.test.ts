import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeLanEnv, type LanEnv } from './helpers-lan.js';
import { defaultMigrations, openDb, runMigrations } from '../src/db/index.js';
import { imageDescriptionSchema } from '../src/services/html/asset-analysis.js';

let L: LanEnv;
let id: number;
beforeEach(async () => { L = await makeLanEnv(); id = (await L.client().post('/lan/api/html-projects', { name: 'Ảnh chờ nhãn' })).body.id; });
afterEach(async () => { await L.close(); });
const failedAsset = (pid = id) => Number(L.env.ctx.db.prepare("INSERT INTO html_assets(project_id,original_name,stored_path,content_hash,kind,media_type,bytes,scan_error_code,created_at) VALUES(?,'ảnh.png','a.png','hash','image','image/png',10,'SCAN_FAILED','x')").run(pid).lastInsertRowid);

describe('xác nhận nhãn ảnh', () => {
  it('bắt buộc xác nhận đủ ảnh, chặn ID ngoài dự án, sau xác nhận lưu nhãn nhưng không đổi tên file', async () => {
    const a = failedAsset();
    const b = failedAsset();
    const c = L.client();
    const url = `/lan/api/html-projects/${id}/image-labels/confirm`;
    expect((await c.post(url, { confirmed: true, labels: [{ id: a, label: 'Nhãn A' }] })).status).toBe(409);
    expect((await c.post(url, { confirmed: true, labels: [{ id: a, label: ' ' }, { id: b, label: 'B' }] })).status).toBe(400);
    const other = (await c.post('/lan/api/html-projects', { name: 'Khác' })).body.id;
    expect((await c.post(url, { confirmed: true, labels: [{ id: a, label: 'A' }, { id: failedAsset(other), label: 'Khác' }] })).status).toBe(409);
    expect((await c.post(url, { confirmed: true, labels: [{ id: a, label: 'Hộp 110ml' }, { id: b, label: 'Hộp 180ml' }] })).body).toMatchObject({ ok: true, resumed: 0 });
    const asset = (await c.get(`/lan/api/html-projects/${id}/assets`)).body[0];
    expect(asset).toMatchObject({ name: 'ảnh.png', manual_label: 'Hộp 110ml', label_confirmed: true, description: { summary: 'Hộp 110ml', uncertain: false } });
  });
  it('cắt chuỗi ngay ở schema phía server; giữ kiểm tra JSON sai kiểu', () => {
    const out = imageDescriptionSchema.parse({ summary: 's'.repeat(900), text: 't'.repeat(900), details: 'd'.repeat(900), uncertain: true });
    expect([out.summary.length, out.text.length, out.details.length]).toEqual([600, 600, 400]);
    expect(() => imageDescriptionSchema.parse({ summary: 3, uncertain: true })).toThrow();
    expect(() => imageDescriptionSchema.parse({ summary: 'x', uncertain: 'yes' })).toThrow();
  });
  it('nâng DB 017 lên 018 không thay dữ liệu voice/ảnh, khóa ngoại và integrity sạch', () => {
    const db = openDb(':memory:');
    try {
      const all = defaultMigrations();
      runMigrations(db, all.filter((m) => m.version < '018_html_asset_review'));
      db.prepare("INSERT INTO projects(slug,name,kind,created_at,updated_at) VALUES('old','Cũ','html','x','x')").run();
      db.prepare("INSERT INTO html_assets(project_id,original_name,stored_path,content_hash,kind,media_type,bytes,created_at,description_json) VALUES(1,'old.png','old.png','h','image','image/png',10,'x','{\"summary\":\"cũ\"}')").run();
      db.prepare("INSERT INTO html_voice(project_id,asset_id,status,transcript_json,updated_at) VALUES(1,1,'ready','{}','x')").run();
      expect(runMigrations(db, all)).toEqual(all.filter((m) => m.version >= '018_html_asset_review').map((m) => m.version));
      expect(db.prepare('SELECT original_name,description_json,label_confirmed,scan_error_code FROM html_assets').get()).toEqual({ original_name: 'old.png', description_json: '{"summary":"cũ"}', label_confirmed: 0, scan_error_code: null });
      expect(db.prepare('SELECT status,transcript_json,request_id FROM html_voice').get()).toEqual({ status: 'ready', transcript_json: '{}', request_id: null });
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    } finally { db.close(); }
  });
});
