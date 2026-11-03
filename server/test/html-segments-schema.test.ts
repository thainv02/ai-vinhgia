import { expect, it } from 'vitest';
import { defaultMigrations, openDb, runMigrations } from '../src/db/index.js';
import { createHtmlProjectBody } from '../src/services/html/projects.js';
import { HTML_MAX_DURATION_S, HTML_MAX_TOTAL_S } from '../src/services/html/config.js';
it('nâng DB 019 giữ nguyên bản cũ; ràng buộc đoạn và tổng 420s', () => {
  const db = openDb(':memory:');
  try {
    const all = defaultMigrations();
    runMigrations(
      db,
      all.filter((x) => x.version < '020_html_segments'),
    );
    db.prepare("INSERT INTO projects(slug,name,kind,created_at,updated_at) VALUES('x','X','html','x','x')").run();
    db.prepare("INSERT INTO html_versions(project_id,version,status,created_at) VALUES(1,1,'ready','x')").run();
    expect(runMigrations(db, all)).toEqual(['020_html_segments']);
    expect(db.prepare('SELECT status,is_segmented,segment_owner_id FROM html_versions').get()).toEqual({
      status: 'ready',
      is_segmented: 0,
      segment_owner_id: null,
    });
    db.prepare("INSERT INTO html_segments(version_id,idx,start_s,end_s,updated_at) VALUES(1,1,0,50,'x')").run();
    expect(() => db.prepare("INSERT INTO html_segments(version_id,idx,start_s,end_s,updated_at) VALUES(1,2,50,111,'x')").run()).toThrow(
      /CHECK/,
    );
    expect(HTML_MAX_DURATION_S).toBe(60);
    expect(HTML_MAX_TOTAL_S).toBe(420);
    expect(createHtmlProjectBody.safeParse({ name: 'x', duration_s: 420 }).success).toBe(true);
    expect(createHtmlProjectBody.safeParse({ name: 'x', duration_s: 421 }).success).toBe(false);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    db.prepare('DELETE FROM projects WHERE id=1').run();
    expect(db.prepare('SELECT * FROM html_segments').all()).toEqual([]);
  } finally {
    db.close();
  }
});
