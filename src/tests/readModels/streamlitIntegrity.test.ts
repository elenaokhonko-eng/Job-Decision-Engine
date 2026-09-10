import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('streamlit read-model integrity', () => {
  it('uses API v2 shortlist/rejected endpoints as the primary boundary', () => {
    const appPath = path.resolve(process.cwd(), 'streamlit_app.py');
    const content = fs.readFileSync(appPath, 'utf8');

    expect(content).toContain('/api/v2/shortlist');
    expect(content).toContain('/api/v2/rejected');
    expect(content).toContain('/api/v2/preference-modes/preview');
  });

  it('uses only canonical read-model views for the hosted read-only fallback', () => {
    const appPath = path.resolve(process.cwd(), 'streamlit_app.py');
    const content = fs.readFileSync(appPath, 'utf8');

    expect(content).toContain('FROM v_canonical_shortlist_scoped');
    expect(content).toContain('FROM v_rejected_jobs_audit_scoped');
    expect(content).toContain('set_session(readonly=True, autocommit=True)');
    expect(content).toContain('DATABASE_URL');
    expect(content).not.toContain('INSERT INTO canonical_jobs');
    expect(content).not.toContain('UPDATE canonical_jobs');
    expect(content).not.toContain('DELETE FROM canonical_jobs');
    expect(content).not.toContain('JOIN canonical_jobs');
    expect(content).toContain('JDEC_API_BASE_URL');
    expect(content).toContain('current_artifact_status');
    expect(content).not.toContain('http://localhost:3000');
  });

  it('api v2 reads from canonical PostgreSQL views', () => {
    const routerPath = path.resolve(process.cwd(), 'src', 'api', 'v2', 'router.ts');
    const content = fs.readFileSync(routerPath, 'utf8');

    expect(content).toContain('FROM v_canonical_shortlist_scoped');
    expect(content).toContain('FROM v_rejected_jobs_audit_scoped');
  });
});
