import { describe, expect, it } from "vitest";
import { evaluateDesktopE2EGate, type DesktopE2EGateInput } from "../../../scripts/check_desktop_e2e_gate.js";

describe("evaluateDesktopE2EGate", () => {
  const basePassingInput: DesktopE2EGateInput = {
    packagingPassed: true,
    localApiReachable: true,
    databaseConfigured: true,
    databaseConnected: true,
    schemaInitialized: true,
    migrationsPending: 0,
    aiProviderConfigured: true,
    consentGranted: true,
    deadLetterTasks: 0,
    blockedTasks: 0,
  };

  it("passes when all desktop requirements and invariants are satisfied", () => {
    const blockers = evaluateDesktopE2EGate(basePassingInput);
    expect(blockers).toEqual([]);
  });

  it("flags packaging verification failure", () => {
    const blockers = evaluateDesktopE2EGate({
      ...basePassingInput,
      packagingPassed: false,
    });
    expect(blockers).toContain("DESKTOP_PACKAGING_VERIFICATION_FAILED");
  });

  it("flags local loopback companion API unreachability", () => {
    const blockers = evaluateDesktopE2EGate({
      ...basePassingInput,
      localApiReachable: false,
    });
    expect(blockers).toContain("LOCAL_COMPANION_API_UNREACHABLE");
  });

  it("flags database connection failures when configured", () => {
    const blockers = evaluateDesktopE2EGate({
      ...basePassingInput,
      databaseConnected: false,
    });
    expect(blockers).toContain("DATABASE_CONNECTION_FAILED");
  });

  it("flags pending migrations on configured database", () => {
    const blockers = evaluateDesktopE2EGate({
      ...basePassingInput,
      migrationsPending: 3,
    });
    expect(blockers).toContain("SCHEMA_MIGRATIONS_PENDING");
  });

  it("flags dead-lettered and blocked tasks", () => {
    const blockers = evaluateDesktopE2EGate({
      ...basePassingInput,
      deadLetterTasks: 2,
      blockedTasks: 1,
    });
    expect(blockers).toContain("PIPELINE_TASKS_DEAD_LETTERED");
    expect(blockers).toContain("PIPELINE_TASKS_BLOCKED");
  });
});
