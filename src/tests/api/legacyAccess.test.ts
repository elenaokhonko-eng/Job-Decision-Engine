import { describe, expect, it, vi } from 'vitest';

import { isLegacyApiEnabled, legacyApiGateMiddleware } from '../../api/legacy/access.js';

describe('legacy api access', () => {
  it('defaults disabled in production', () => {
    expect(isLegacyApiEnabled({ NODE_ENV: 'production' } as any)).toBe(false);
  });

  it('defaults enabled outside production', () => {
    expect(isLegacyApiEnabled({ NODE_ENV: 'development' } as any)).toBe(true);
    expect(isLegacyApiEnabled({} as any)).toBe(true);
  });

  it('respects ALLOW_LEGACY_API overrides', () => {
    expect(isLegacyApiEnabled({ NODE_ENV: 'production', ALLOW_LEGACY_API: 'true' } as any)).toBe(true);
    expect(isLegacyApiEnabled({ NODE_ENV: 'development', ALLOW_LEGACY_API: 'false' } as any)).toBe(false);
  });

  it('middleware returns 410 when disabled', () => {
    const handler = legacyApiGateMiddleware({ env: { NODE_ENV: 'production' } as any });
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as any;
    const next = vi.fn();

    handler({} as any, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(410);
    expect(res.json).toHaveBeenCalled();
  });

  it('middleware calls next when enabled', () => {
    const handler = legacyApiGateMiddleware({ env: { NODE_ENV: 'production', ALLOW_LEGACY_API: 'true' } as any });
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as any;
    const next = vi.fn();

    handler({} as any, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});
