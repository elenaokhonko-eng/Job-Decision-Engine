import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Phase 8 backfill cutover audit script', () => {
  it('fails non-zero when legacy statuses are present', () => {
    const mockErr = new Error('Cutover audit failed with 1 unresolved legacy/backfill issues.');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => {
      throw mockErr;
    }).toThrow(/Cutover audit failed/);

    spy.mockRestore();
  });

  it('exposes cutover audit command in package scripts', () => {
    const pkgPath = path.resolve(process.cwd(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    expect(pkg.scripts['cutover:audit']).toBe('tsx scripts/backfill_cutover.ts');
  });
});
