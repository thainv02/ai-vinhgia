import { describe, expect, it } from 'vitest';
import { makeLanEnv } from './helpers-lan.js';
import { defaultMigrations, openDb, runMigrations } from '../src/db/index.js';
import { withVoice } from '../src/services/html/voice-overlay.js';
import { validateManifest, MANIFEST_LIMITS } from '../src/services/html/safe-path.js';
import { buildTranscript } from '../src/services/clips/transcript.js';
import { securityLint } from '../src/services/html/engine/security-lint.js';

describe('Video HTML dài', () => {
  it('API cho phép 300/420 giây, chặn vượt trần; nâng DB cũ giữ meta và foreign key', async () => {
    const L=await makeLanEnv();
    try {
      for(const duration_s of [300,420]) expect((await L.client().post('/lan/api/html-projects',{name:`Dài ${duration_s}`,duration_s})).status).toBe(201);
      expect((await L.client().post('/lan/api/html-projects',{name:'Quá dài',duration_s:421})).status).toBe(400);
    } finally { await L.close(); }
    const db=openDb(':memory:');
    try {
      const all=defaultMigrations();runMigrations(db,all.filter(m=>m.version<'019_html_long_video'));
      db.prepare("INSERT INTO projects(slug,name,kind,created_at,updated_at) VALUES('old','Cũ','html','x','x')").run();
      db.prepare("INSERT INTO html_project_meta(project_id,aspect,duration_s,quality,created_at) VALUES(1,'16:9',60,'720p','x')").run();
      const before=db.prepare('SELECT * FROM html_project_meta').all();
      expect(runMigrations(db,all)).toEqual(['019_html_long_video', '020_html_segments']);
      expect(db.prepare('SELECT * FROM html_project_meta').all()).toEqual(before);
      db.prepare('UPDATE html_project_meta SET duration_s=300.025 WHERE project_id=1').run();
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('integrity_check')).toEqual([{integrity_check:'ok'}]);
    }finally{db.close();}
  });
  it('2000 từ/5 phút không vượt giới hạn file, phụ đề tạo tất định và không chứa HTML từ lời đọc',()=>{
    const transcript=buildTranscript({text:'',segments:[],duration:300,words:Array.from({length:2000},(_,i)=>({word:i===100?'</script>':`núi${i}`,start:i*.15,end:(i+1)*.15}))},{contentHash:'x',durationHintS:300});
    const files=[{path:'index.html',content:'<!doctype html><html><head></head><body><div data-composition-id="main" data-start="0" data-duration="300" data-width="640" data-height="360"></div><script>window.__timelines={main:gsap.timeline({paused:true})};</script></body></html>'}];
    const voice={asset_id:1,path:'assets/u/1.wav',duration_s:300,captions:true,transcript};
    const decorated=withVoice(files,voice,'16:9');
    expect(decorated).toHaveLength(2);
    expect(decorated.some(f=>f.path==='assets/js/hv-voice-captions.js')).toBe(true);
    expect(validateManifest(decorated).every(f=>f.bytes<=MANIFEST_LIMITS.maxFileBytes)).toBe(true);
    expect(withVoice(decorated,voice,'16:9')).toEqual(decorated);
    expect(securityLint(decorated)).toEqual([]);
    expect(decorated.find(f=>f.path.endsWith('.js'))!.content).not.toContain('</script>');
  });
});
