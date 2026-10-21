import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, client, type Env } from './helpers.js';
import { createAccount, listAccounts } from '../src/services/ai/accounts.js';
import { parseAntigravityQuota, parseCodexQuota, parseCodexSignals, refreshQuota } from '../src/services/ai/quota.js';
import { managementKey } from '../src/services/ai/management-key.js';

let env: Env;
const servers: http.Server[] = [];
beforeEach(async () => { env = await makeEnv(); });
afterEach(async () => { for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r())); await env.close(); });

describe('provider quota normalization', () => {
  it('Antigravity: giữ 0% và 100%, không đoán số còn lại khi thiếu quotaInfo', () => {
    const w = parseAntigravityQuota({ models: {
      empty: { quotaInfo: { remainingFraction: 0, resetTime: '2026-10-21T12:00:00Z' } },
      full: { quotaInfo: { remainingFraction: 1 } },
      unknown: { quotaInfo: {} }, context: { maxTokens: 100000 }, invalid: { quotaInfo: { remainingFraction: -1 } },
    } });
    expect(w.map((x) => [x.model, x.remaining_percent])).toEqual([['empty', 0], ['full', 100]]);
    expect(w[0].resets_at).toBe('2026-10-21T12:00:00.000Z'); expect(w[1].resets_at).toBeNull();
  });
  it('Codex: đổi usedPercent sang remaining; cửa sổ theo dữ liệu provider', () => {
    const w = parseCodexQuota({ rateLimitsByLimitId: { codex: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1792584000 }, secondary: { usedPercent: 100, windowDurationMins: 10080 } } } });
    expect(w.map((x) => [x.label, x.remaining_percent])).toEqual([['5 giờ', 75], ['7 ngày', 0]]);
    expect(w[0].resets_at).not.toBeNull();
    expect(parseCodexQuota({ primary: { usedPercent: null, windowDurationMins: 300 } })).toEqual([]);
    expect(parseCodexQuota({ rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 3600 } } })[0]).toMatchObject({ label: '60 phút', remaining_percent: 100 });
  });
  it('Codex passive headers: đọc không phân biệt chữ hoa, không tạo dữ liệu từ trường trống', () => {
    expect(parseCodexSignals({ 'X-Codex-Primary-Used-Percent': '17.5', 'X-Codex-Primary-Window-Minutes': '300' })[0]).toMatchObject({ remaining_percent: 82.5, label: '5 giờ' });
    expect(parseCodexSignals({ 'x-codex-primary-used-percent': '' })).toEqual([]);
  });
});

describe('quota collector', () => {
  it('chỉ gọi quota endpoint cố định qua proxy; cache, không lộ raw body/token, không ảnh hưởng routing state', async () => {
    let calls = 0;
    const s = http.createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      expect(req.headers.authorization).toMatch(/^Bearer /);
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v0/management/auth-files') { res.end(JSON.stringify({ files: [{ provider: 'antigravity', auth_index: 'one', project_id: 'project' }] })); return; }
      expect(req.url).toBe('/v0/management/api-call'); calls++;
      const parsed = JSON.parse(body);
      expect(parsed.url).toBe('https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels');
      expect(parsed.header.Authorization).toBe('Bearer $TOKEN$');
      expect(JSON.parse(parsed.data)).toEqual({ project: 'project' });
      res.end(JSON.stringify({ status_code: 200, body: JSON.stringify({ secret: 'raw-upstream-not-for-ui', models: { gemini: { quotaInfo: { remainingFraction: 0.42 } } } }) }));
    });
    servers.push(s); await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const a = createAccount(env.ctx, { alias: 'A', provider: 'antigravity', model: 'gemini', priority: 1, capabilities: ['text'], base_url: `http://127.0.0.1:${(s.address() as any).port}/v1` });
    await refreshQuota(env.ctx, a.id); await refreshQuota(env.ctx, a.id);
    expect(calls).toBe(1);
    const pub = listAccounts(env.ctx)[0];
    expect(pub.quota).toMatchObject({ windows: [{ remaining_percent: 42 }] });
    expect(JSON.stringify(pub)).not.toContain('raw-upstream-not-for-ui');
    expect(pub.state).toBe('unknown');
    const key = fs.readFileSync(path.join(env.ctx.config.aiHome, String(a.id), 'management-key'), 'utf8');
    expect(JSON.stringify(pub)).not.toContain(key);
  });
  it('external gateway thiếu telemetry → unknown, không phải 100%', async () => {
    const a = createAccount(env.ctx, { alias: 'Claude', provider: 'claude', model: 'claude', priority: 1, capabilities: ['text'], base_url: 'http://127.0.0.1:19999/v1', key_env: 'DUMMY_KEY' });
    await refreshQuota(env.ctx, a.id);
    expect(listAccounts(env.ctx)[0]).toMatchObject({ quota: null, quota_error: 'unsupported' });
    expect((await client(env.app).post(`/api/ai/accounts/${a.id}/quota`, {})).status).toBe(403);
  });
  it('nâng cấp management key local không chạm OAuth hoặc access key', () => {
    const dir = path.join(env.root, 'upgrade'); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'management:\n  secret-key: "$2a$hashed-old"\n');
    fs.writeFileSync(path.join(dir, 'access-key'), 'unchanged');
    const key = managementKey(dir);
    expect(key.length).toBe(64); expect(managementKey(dir)).toBe(key);
    expect(fs.readFileSync(path.join(dir, 'access-key'), 'utf8')).toBe('unchanged');
    expect(fs.existsSync(path.join(dir, 'config.before-quota.yaml'))).toBe(true);
    expect(fs.statSync(path.join(dir, 'management-key')).mode & 0o777).toBe(0o600);
  });
});
