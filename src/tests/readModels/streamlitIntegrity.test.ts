import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('streamlit read-model integrity', () => {
  it('fetches active shortlist from canonical read view', () => {
    const appPath = path.resolve(process.cwd(), 'streamlit_app.py');
    const content = fs.readFileSync(appPath, 'utf8');

    expect(content).toContain('FROM v_canonical_shortlist');
  });

  it('fetches rejected audit rows from canonical rejected audit view', () => {
    const appPath = path.resolve(process.cwd(), 'streamlit_app.py');
    const content = fs.readFileSync(appPath, 'utf8');

    expect(content).toContain('FROM v_rejected_jobs_audit');
  });
});
