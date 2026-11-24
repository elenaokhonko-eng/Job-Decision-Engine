import { describe, expect, it } from "vitest";
import { STAGE1_3_STAGING_IDENTITY_EXPECTATIONS as EXPECTED } from "../../db/stagingDatabaseIdentity.js";
import { requireRepairApply, requireRepairTarget, runZeroCheckRepairCommand } from "../../tasks/zeroCheckRepair.js";

const url = "postgresql://u:hunter2@ep-other.c-3.ap-southeast-1.aws.neon.tech/neondb";
const identity = { databaseName: "neondb", branchId: "br-replay-1" };

describe("zero-check repair target guard", () => {
  it("accepts only --target replay on the REPLAY_BRANCH_ID branch", () => {
    expect(() => requireRepairTarget({ target: "replay", databaseUrl: url, identity, replayBranchId: "br-replay-1" })).not.toThrow();
    expect(() => requireRepairTarget({ target: undefined, databaseUrl: url, identity, replayBranchId: "br-replay-1" })).toThrow(/--target replay/);
    expect(() => requireRepairTarget({ target: "production", databaseUrl: url, identity, replayBranchId: "br-replay-1" })).toThrow(/--target replay/);
    expect(() => requireRepairTarget({ target: "replay", databaseUrl: "", identity, replayBranchId: "br-replay-1" })).toThrow(/REPLAY_DATABASE_URL/);
  });

  it("refuses an unset or different REPLAY_BRANCH_ID, the production branch, and never echoes the URL", () => {
    expect(() => requireRepairTarget({ target: "replay", databaseUrl: url, identity, replayBranchId: undefined })).toThrow(/REPLAY_BRANCH_ID/);
    expect(() => requireRepairTarget({ target: "replay", databaseUrl: url, identity, replayBranchId: "br-other" })).toThrow(/not REPLAY_BRANCH_ID/);
    const production = { databaseName: "neondb", branchId: EXPECTED.knownProductionBranchId };
    try {
      requireRepairTarget({ target: "replay", databaseUrl: url, identity: production, replayBranchId: EXPECTED.knownProductionBranchId });
      throw new Error("should have refused");
    } catch (error) {
      expect(String(error)).toMatch(/production branch|Refusing/);
      expect(String(error)).not.toContain("hunter2");
    }
  });

  it("apply needs the env gate and the confirmed workspace id", () => {
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    expect(() => requireRepairApply({ allowedEnv: undefined, confirmWorkspace: workspaceId, workspaceId })).toThrow(/ZERO_CHECK_REPAIR_ALLOWED/);
    expect(() => requireRepairApply({ allowedEnv: "yes", confirmWorkspace: workspaceId, workspaceId })).toThrow(/ZERO_CHECK_REPAIR_ALLOWED/);
    expect(() => requireRepairApply({ allowedEnv: "true", confirmWorkspace: undefined, workspaceId })).toThrow(/--confirm-workspace/);
    expect(() => requireRepairApply({ allowedEnv: "true", confirmWorkspace: "22222222-2222-4222-8222-222222222222", workspaceId })).toThrow(/--confirm-workspace/);
    expect(() => requireRepairApply({ allowedEnv: "true", confirmWorkspace: workspaceId, workspaceId })).not.toThrow();
  });

  it("the command refuses a non-replay target before it connects anywhere", async () => {
    await expect(runZeroCheckRepairCommand({ DATABASE_URL: url }, { target: undefined, apply: false })).rejects.toThrow(/--target replay/);
    await expect(runZeroCheckRepairCommand({}, { target: "replay", apply: false })).rejects.toThrow(/REPLAY_DATABASE_URL/);
  });
});
