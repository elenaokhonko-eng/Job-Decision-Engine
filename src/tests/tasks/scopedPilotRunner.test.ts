import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEmployerAtsAdapter,
  createScopedEvaluationOptions,
  createScopedPilotWorkerOptions,
  parseScopedPilotArgs,
  runScopedPilot,
} from "../../../scripts/run_scoped_pilot.js";

const canonicalJobId = "10000000-0000-4000-8000-000000000001";
const jobVersionId = "20000000-0000-4000-8000-000000000002";
const profileVersionId = "30000000-0000-4000-8000-000000000003";

afterEach(() => vi.unstubAllEnvs());

describe("scoped pilot runner", () => {
  it("requires the workflow kill switch before opening database connections", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://pilot:test@db.example.test/jobs");
    vi.stubEnv("DATABASE_URL_UNPOOLED", "postgresql://pilot:test@db.example.test/jobs");
    vi.stubEnv("WORKFLOW_KILL_SWITCH", "false");

    await expect(runScopedPilot({ canonicalJobId, jobVersionId })).rejects.toThrow(/WORKFLOW_KILL_SWITCH=true/);
  });

  it("rejects pooled connections for the singleton worker lock", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://pilot:test@db-pooler.example.test/jobs");
    vi.stubEnv("DATABASE_URL_UNPOOLED", "postgresql://pilot:test@db-pooler.example.test/jobs");
    vi.stubEnv("WORKFLOW_KILL_SWITCH", "true");

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

  it("passes the same version and active profile to evaluation selection and reconciliation", () => {
    expect(createScopedEvaluationOptions(jobVersionId, profileVersionId)).toEqual({
      jobVersionIds: [jobVersionId],
      profileVersionId,
      limit: 1,
    });
  });
});
