import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEmployerAtsAdapter,
  assertScopedPilotMode,
  createScopedEvaluationOptions,
  canResumeScopedPilotState,
  createScopedPilotWorkerOptions,
  hasScopedPilotHistory,
  isScopedEvaluationReadyForDocuments,
  parseScopedPilotArgs,
  runScopedPilot,
} from "../../../scripts/run_scoped_pilot.js";

const canonicalJobId = "10000000-0000-4000-8000-000000000001";
const jobVersionId = "20000000-0000-4000-8000-000000000002";
const profileVersionId = "30000000-0000-4000-8000-000000000003";

afterEach(() => vi.unstubAllEnvs());

describe("scoped pilot runner", () => {
  it("requires PILOT_MODE before opening database connections", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://pilot:test@db.example.test/jobs");
    vi.stubEnv("DATABASE_URL_UNPOOLED", "postgresql://pilot:test@db.example.test/jobs");
    vi.stubEnv("WORKFLOW_KILL_SWITCH", "false");
    vi.stubEnv("PILOT_MODE", "false");

    await expect(runScopedPilot({ canonicalJobId, jobVersionId })).rejects.toThrow(/PILOT_MODE=true/);
  });

  it("allows scoped pilot mode only while the global kill switch is off", () => {
    expect(() => assertScopedPilotMode({ PILOT_MODE: "true", WORKFLOW_KILL_SWITCH: "false" })).not.toThrow();
    expect(() => assertScopedPilotMode({ PILOT_MODE: "true", WORKFLOW_KILL_SWITCH: "true" }))
      .toThrow(/prevents all pipeline processing/i);
    expect(() => assertScopedPilotMode({ PILOT_MODE: " true ", WORKFLOW_KILL_SWITCH: "false" }))
      .toThrow(/exactly true, false, or unset/i);
    expect(() => assertScopedPilotMode({ PILOT_MODE: "true", WORKFLOW_KILL_SWITCH: " false " }))
      .toThrow(/exactly true, false, or unset/i);
    expect(() => assertScopedPilotMode({ PILOT_MODE: "yes", WORKFLOW_KILL_SWITCH: "false" }))
      .toThrow(/exactly true, false, or unset/i);
    expect(() => assertScopedPilotMode({ PILOT_MODE: "true", WORKFLOW_KILL_SWITCH: "on" }))
      .toThrow(/exactly true, false, or unset/i);
  });

  it("rejects pooled connections for the singleton worker lock", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://pilot:test@db-pooler.example.test/jobs");
    vi.stubEnv("DATABASE_URL_UNPOOLED", "postgresql://pilot:test@db-pooler.example.test/jobs");
    vi.stubEnv("WORKFLOW_KILL_SWITCH", "false");
    vi.stubEnv("PILOT_MODE", "true");

    await expect(runScopedPilot({ canonicalJobId, jobVersionId })).rejects.toThrow(/direct connection/i);
  });

  it("creates adapters only for official ATS posting hosts", () => {
    expect(createEmployerAtsAdapter("ashby", "https://jobs.ashbyhq.com/cohere/role-123")?.sourceName)
      .toBe("ASHBY");
    expect(createEmployerAtsAdapter("jobicy", "https://jobicy.com/jobs/role-123")).toBeNull();
  });

  it("requires both canonical job and version identifiers", () => {
    expect(parseScopedPilotArgs([
      "--canonical-job-id", canonicalJobId,
      "--job-version-id", jobVersionId,
    ])).toEqual({ canonicalJobId, jobVersionId });
    expect(() => parseScopedPilotArgs(["--job-version-id", jobVersionId]))
      .toThrow(/canonical-job-id/i);
    expect(() => parseScopedPilotArgs(["--canonical-job-id", canonicalJobId]))
      .toThrow(/job-version-id/i);
  });

  it("passes the selected version to seeding, reconciliation, and task execution", () => {
    const options = createScopedPilotWorkerOptions(jobVersionId);

    expect(options.jobVersionIds).toEqual([jobVersionId]);
    expect(options.seed).toBe(true);
    expect(options.reconcileStalePending).toBe(true);
    expect(options.includeTestFixtures).toBe(false);
    expect(options.maxTasks).toBeGreaterThan(1);
    expect(options.claimBatchSize).toBe(1);
  });

  it("recognizes prior match, decision, evaluation, or task history as resumable", () => {
    expect(hasScopedPilotHistory({
      hasCurrentMatchRun: true,
      hasCurrentDeterministicDecision: false,
      hasEvaluation: false,
      hasPipelineHistory: false,
    })).toBe(true);
    expect(hasScopedPilotHistory({
      hasCurrentMatchRun: false,
      hasCurrentDeterministicDecision: false,
      hasEvaluation: false,
      hasPipelineHistory: true,
    })).toBe(true);
    expect(hasScopedPilotHistory({
      hasCurrentMatchRun: false,
      hasCurrentDeterministicDecision: false,
      hasEvaluation: false,
      hasPipelineHistory: false,
    })).toBe(false);
  });

  it("ignores match and decision pointers from a different version", () => {
    expect(hasScopedPilotHistory({
      hasCurrentMatchRun: false,
      hasCurrentDeterministicDecision: false,
      hasEvaluation: false,
      hasPipelineHistory: false,
    })).toBe(false);
  });

  it("allows resuming operational errors with history but blocks terminal decisions", () => {
    const history = {
      hasCurrentMatchRun: false,
      hasCurrentDeterministicDecision: false,
      hasEvaluation: false,
      hasPipelineHistory: true,
    };

    expect(canResumeScopedPilotState("PROCESSING_ERROR", history)).toBe(true);
    expect(canResumeScopedPilotState("PROCESSING_ERROR", { ...history, hasPipelineHistory: false })).toBe(false);
    expect(canResumeScopedPilotState("HARD_REJECTED", history)).toBe(false);
    expect(canResumeScopedPilotState("MANUALLY_REMOVED", history)).toBe(false);
  });

  it("accepts a persisted current evaluation when a resumed queue processes no new item", () => {
    expect(isScopedEvaluationReadyForDocuments({
      processed: 0,
      failed: 0,
      manualReview: 0,
      eligible: 1,
    }, true)).toBe(true);
    expect(isScopedEvaluationReadyForDocuments({
      processed: 0,
      failed: 0,
      manualReview: 0,
      eligible: 1,
    }, false)).toBe(false);
    expect(isScopedEvaluationReadyForDocuments({
      processed: 0,
      failed: 1,
      manualReview: 0,
      eligible: 1,
    }, true)).toBe(false);
  });

  it("passes the same version and active profile to evaluation selection and reconciliation", () => {
    expect(createScopedEvaluationOptions(jobVersionId, profileVersionId)).toEqual({
      jobVersionIds: [jobVersionId],
      profileVersionId,
      limit: 1,
    });
  });
});
