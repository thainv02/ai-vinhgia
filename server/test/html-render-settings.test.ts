import fs from 'node:fs';
import path from 'node:path';
import {expect,it} from 'vitest';
import {makeLanEnv} from './helpers-lan.js';
it('lưu render auto/1–4, trả số luồng máy này và chặn giá trị ngoài phạm vi',async()=>{
 const l=await makeLanEnv();try{
  l.env.ctx.config.envFile=path.join(l.env.root,'render-test.env');const c=l.client();
  const initial=await c.get('/lan/api/settings/render');expect(initial.status).toBe(200);expect(initial.body.auto_concurrency).toBeGreaterThanOrEqual(1);expect(initial.body.auto_concurrency).toBeLessThanOrEqual(4);
  expect((await c.put('/lan/api/settings/render',{concurrency:3})).body.effective_concurrency).toBe(3);
  expect(fs.readFileSync(l.env.ctx.config.envFile,'utf8')).toContain('RENDER_CONCURRENCY=3');
  expect((await c.put('/lan/api/settings/render',{concurrency:5})).status).toBe(400);
  expect((await c.put('/lan/api/settings/render',{concurrency:'auto'})).body.concurrency).toBe('auto');
  expect(fs.readFileSync(l.env.ctx.config.envFile,'utf8')).toContain('RENDER_CONCURRENCY=auto');
 }finally{await l.close();}
});
