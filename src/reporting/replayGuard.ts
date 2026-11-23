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
