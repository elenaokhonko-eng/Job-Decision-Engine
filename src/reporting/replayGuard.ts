import {
  createStagingDatabaseIdentityDiagnostic,
  expectationsForSuppliedStagingBranch,
  STAGE1_3_STAGING_IDENTITY_EXPECTATIONS,
  isApprovedStagingDatabaseIdentity,
} from '../db/stagingDatabaseIdentity.js';

export interface ReplayTargetIdentity {
  databaseName: string | null;
  branchId: string | null;
}

/**
 * Checks REPLAY_DATABASE_URL before any connection is opened: it must be set, be a postgres URL and not name a known
 * production host. The connected branch is still checked by requireApprovedReplayTarget. Throws without echoing the URL.
 */
export function requireReplayDatabaseUrl(value: string | undefined): string {
  const url = value?.trim();
  if (!url) throw new Error('REPLAY_DATABASE_URL is not set (DATABASE_URL is never used for a replay target).');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('REPLAY_DATABASE_URL is not a valid URL.');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('REPLAY_DATABASE_URL is not a postgres URL.');
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || STAGE1_3_STAGING_IDENTITY_EXPECTATIONS.knownProductionHostnames.includes(host)) {
    throw new Error('Refusing to connect: REPLAY_DATABASE_URL has no host or names a known production host.');
  }
  return url;
}

/**
 * A replay writes. It may only run on an approved staging (or an explicitly supplied replay)
 * branch and never on a known production host or branch. Throws without echoing the URL.
 */
export function requireApprovedReplayTarget(
  databaseUrl: string,
  identity: ReplayTargetIdentity,
  suppliedBranchId?: string | null,
): { host: string; branchId: string | null } {
  const expectations = suppliedBranchId?.trim()
    ? expectationsForSuppliedStagingBranch(suppliedBranchId)
    : STAGE1_3_STAGING_IDENTITY_EXPECTATIONS;
  const host = new URL(databaseUrl).hostname.toLowerCase();
  const approved = isApprovedStagingDatabaseIdentity(
    { databaseName: identity.databaseName, branchId: identity.branchId, hostname: host },
    expectations,
  );
  if (!approved) {
    const diagnostic = createStagingDatabaseIdentityDiagnostic(databaseUrl, identity, expectations);
    throw new Error(
      `Refusing to replay: ${diagnostic.connectionHost} is not an approved replay branch ` +
        `(connected branch ${diagnostic.connectedBranchId ?? 'unknown'}, expected ${diagnostic.expectedBranchId}).`,
    );
  }
  return { host, branchId: identity.branchId };
}
