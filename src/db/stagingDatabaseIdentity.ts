export interface StagingDatabaseIdentity {
  readonly databaseName: string | null | undefined;
  readonly branchId: string | null | undefined;
  readonly hostname: string;
}

export interface StagingDatabaseIdentityExpectations {
  readonly expectedDatabaseName: string;
  readonly expectedBranchId: string;
  readonly approvedStagingHostnames: readonly string[];
  readonly knownProductionBranchId: string;
  readonly knownProductionHostnames: readonly string[];
}

export interface StagingDatabaseIdentityDiagnostic {
  readonly connectedDatabase: string | null | undefined;
  readonly connectedBranchId: string | null | undefined;
  readonly expectedDatabase: string;
  readonly expectedBranchId: string;
  readonly connectionHost: string;
}

export const STAGE1_3_STAGING_IDENTITY_EXPECTATIONS: StagingDatabaseIdentityExpectations = {
  expectedDatabaseName: "neondb",
  expectedBranchId: "br-orange-boat-azehba7u",
  approvedStagingHostnames: [
    "ep-lingering-frog-azbw8weo.c-3.ap-southeast-1.aws.neon.tech",
    "ep-lingering-frog-azbw8weo-jns.c-3.ap-southeast-1.aws.neon.tech",
  ],
  knownProductionBranchId: "br-sweet-lab-azucfmoz",
  knownProductionHostnames: [
    "ep-damp-glade-az7npbae.c-3.ap-southeast-1.aws.neon.tech",
    "ep-damp-glade-az7npbae-wf3.c-3.ap-southeast-1.aws.neon.tech",
  ],
};

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "");
}

export function createStagingDatabaseIdentityDiagnostic(
  databaseUrl: string,
  identity: Pick<StagingDatabaseIdentity, "databaseName" | "branchId"> | null | undefined,
  expectations: StagingDatabaseIdentityExpectations,
): StagingDatabaseIdentityDiagnostic {
  return {
    connectedDatabase: identity?.databaseName,
    connectedBranchId: identity?.branchId,
    expectedDatabase: expectations.expectedDatabaseName,
    expectedBranchId: expectations.expectedBranchId,
    connectionHost: new URL(databaseUrl).hostname,
  };
}

export function isApprovedStagingDatabaseIdentity(
  identity: StagingDatabaseIdentity,
  expectations: StagingDatabaseIdentityExpectations,
): boolean {
  const hostname = normalizeHostname(identity.hostname);
  const branchId = identity.branchId?.trim() || null;
  const knownProductionHostnames = new Set(expectations.knownProductionHostnames.map(normalizeHostname));

  if (
    identity.databaseName?.trim() !== expectations.expectedDatabaseName ||
    branchId === expectations.knownProductionBranchId ||
    knownProductionHostnames.has(hostname)
  ) {
    return false;
  }

  if (branchId === expectations.expectedBranchId) return true;
  if (branchId !== null) return false;

  const approvedStagingHostnames = new Set(expectations.approvedStagingHostnames.map(normalizeHostname));
  return approvedStagingHostnames.has(hostname);
}
