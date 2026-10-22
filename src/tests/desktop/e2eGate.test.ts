import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
    deadLetterTasks: 0,
    actionableDeadLetterTasks: 0,
    staleHistoricalDeadLetterTasks: 0,
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

  it("flags unconfigured database when databaseConfigured is false", () => {
    const blockers = evaluateDesktopE2EGate({
      ...basePassingInput,
      databaseConfigured: false,
    });
    expect(blockers).toContain("DATABASE_NOT_CONFIGURED");
  });

  it("flags unconfigured AI provider when aiProviderConfigured is false", () => {
    const blockers = evaluateDesktopE2EGate({
      ...basePassingInput,
      aiProviderConfigured: false,
    });
    expect(blockers).toContain("AI_PROVIDER_NOT_CONFIGURED");
  });

  it("does not block on stale historical dead letters but blocks actionable dead letters", () => {
    expect(evaluateDesktopE2EGate({
      ...basePassingInput,
      deadLetterTasks: 8,
      staleHistoricalDeadLetterTasks: 8,
    })).toEqual([]);

    const blockers = evaluateDesktopE2EGate({
      ...basePassingInput,
      deadLetterTasks: 1,
      actionableDeadLetterTasks: 1,
      blockedTasks: 1,
    });
    expect(blockers).toContain("PIPELINE_TASKS_DEAD_LETTERED");
    expect(blockers).toContain("PIPELINE_TASKS_BLOCKED");
  });

  it("uses the actual blocked dependency state in its database query", () => {
    const source = readFileSync(resolve("scripts/check_desktop_e2e_gate.ts"), "utf8");
    expect(source).toContain("task.status = 'BLOCKED_DEPENDENCY'");
    expect(source).not.toContain("task.status = 'BLOCKED'");
  });
});
