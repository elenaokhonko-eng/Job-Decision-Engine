import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createStagingDatabaseIdentityDiagnostic,
  isApprovedStagingDatabaseIdentity,
  STAGE1_3_STAGING_IDENTITY_EXPECTATIONS,
} from "../../db/stagingDatabaseIdentity.js";

const expectations = STAGE1_3_STAGING_IDENTITY_EXPECTATIONS;
const stagingHost = expectations.approvedStagingHostnames[0];
const productionHost = expectations.knownProductionHostnames[0];

describe("staging database identity guard", () => {
  it("accepts the approved staging branch ID", () => {
    expect(isApprovedStagingDatabaseIdentity({
      databaseName: expectations.expectedDatabaseName,
      branchId: expectations.expectedBranchId,
      hostname: stagingHost,
    }, expectations)).toBe(true);
    expect(isApprovedStagingDatabaseIdentity({
      databaseName: expectations.expectedDatabaseName,
      branchId: expectations.expectedBranchId,
      hostname: "ep-other-compute.c-3.ap-southeast-1.aws.neon.tech",
    }, expectations)).toBe(true);
  });

  it("rejects the known production branch and endpoint", () => {
    expect(isApprovedStagingDatabaseIdentity({
      databaseName: expectations.expectedDatabaseName,
      branchId: expectations.knownProductionBranchId,
      hostname: stagingHost,
    }, expectations)).toBe(false);
    expect(isApprovedStagingDatabaseIdentity({
      databaseName: expectations.expectedDatabaseName,
      branchId: expectations.expectedBranchId,
      hostname: productionHost,
    }, expectations)).toBe(false);
  });

  it("rejects unknown branch IDs and hosts", () => {
    expect(isApprovedStagingDatabaseIdentity({
      databaseName: expectations.expectedDatabaseName,
      branchId: "br-unknown-branch",
      hostname: stagingHost,
    }, expectations)).toBe(false);
    expect(isApprovedStagingDatabaseIdentity({
      databaseName: expectations.expectedDatabaseName,
      branchId: "br-unknown-branch",
      hostname: "ep-unknown-host.c-3.ap-southeast-1.aws.neon.tech",
    }, expectations)).toBe(false);
    expect(isApprovedStagingDatabaseIdentity({
      databaseName: "other_database",
      branchId: expectations.expectedBranchId,
      hostname: stagingHost,
    }, expectations)).toBe(false);
  });

  it("accepts a null branch ID only for an exact approved staging hostname", () => {
    expect(isApprovedStagingDatabaseIdentity({
      databaseName: expectations.expectedDatabaseName,
      branchId: null,
      hostname: stagingHost,
    }, expectations)).toBe(true);
    expect(isApprovedStagingDatabaseIdentity({
      databaseName: expectations.expectedDatabaseName,
      branchId: null,
      hostname: `${stagingHost}.attacker.example`,
    }, expectations)).toBe(false);
  });

  it("prints only non-secret connection identity fields", () => {
    const diagnostic = createStagingDatabaseIdentityDiagnostic(
      `postgresql://user-marker:pass-marker@${stagingHost}/neondb?token=query-marker`,
      { databaseName: expectations.expectedDatabaseName, branchId: null },
      expectations,
    );
    const serialized = JSON.stringify(diagnostic);
    const script = readFileSync(resolve("scripts/run_stage1_3_staging_evaluation_smoke.ts"), "utf8");

    expect(Object.keys(diagnostic).sort()).toEqual([
      "connectedBranchId",
      "connectedDatabase",
      "connectionHost",
      "expectedBranchId",
      "expectedDatabase",
    ]);
    expect(serialized).not.toContain("user-marker");
    expect(serialized).not.toContain("pass-marker");
    expect(serialized).not.toContain("query-marker");
    expect(script).toContain("console.log(identityDiagnostic)");
    expect(script).not.toContain("console.log(databaseUrl)");
  });
});
