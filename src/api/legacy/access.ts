import type express from 'express';

export function isLegacyApiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.ALLOW_LEGACY_API ?? '').trim().toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;

  const nodeEnv = String(env.NODE_ENV ?? '').trim().toLowerCase();
  return nodeEnv !== 'production';
}

export function legacyApiGateMiddleware(options?: { env?: NodeJS.ProcessEnv }): express.RequestHandler {
  const env = options?.env ?? process.env;
  const enabled = isLegacyApiEnabled(env);

  return (_req, res, next) => {
    if (!enabled) {
      res.status(410).json({
        ok: false,
        error: 'Legacy /api endpoints are disabled. Use /api/v2 for workspace-scoped access.',
      });
      return;
    }
    next();
  };
}
