import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { verifyArchiveApplyActivation } from "../../../scripts/archive_jobs.js";

const pilotJobId = "10000000-0000-4000-8000-000000000001";
const runStartedAt = new Date("2026-10-28T03:15:00.000Z");

describe("daily job archiving workflow and activation gates", () => {
  it("restricts production archive execution to reviewed main before accessing secrets", () => {
    const workflow = readFileSync(resolve(".github/workflows/daily-job-archiving.yml"), "utf8");
    const validationJob = workflow.indexOf("validate-manual-dispatch:");
    const archiveJob = workflow.indexOf("archive_jobs:");

    expect(validationJob).toBeGreaterThan(-1);
    expect(archiveJob).toBeGreaterThan(validationJob);
    expect(workflow).toContain("needs: validate-manual-dispatch");
    expect(workflow).toContain("REQUESTED_REF: ${{ github.ref }}");
    expect(workflow).toContain('if [[ "$REQUESTED_REF" != "refs/heads/main" ]]; then');
    expect(workflow).toContain("Production archive workflows may only run reviewed code from main.");
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(workflow).toContain("vars.WORKFLOW_KILL_SWITCH != 'true'");
    expect(workflow).toContain("vars.JOB_ARCHIVING_ENABLED == 'true' && vars.JOB_ARCHIVING_PILOT_COMPLETE == 'true' && 'APPLY' || 'DRY_RUN'");

    const validationSection = workflow.slice(validationJob, archiveJob);
    expect(validationSection).not.toContain("secrets.DATABASE_URL");
    expect(validationSection).not.toContain("secrets.DATABASE_URL_UNPOOLED");
  });

  it("separates initial APPLY pilot-hold activation from ongoing daily operation after hold expiry", async () => {
    const initialPool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM job_archive_runs")) {
          return { rows: [{ completed: false }] };
        }
        if (sql.includes("FROM job_archive_holds")) {
          return { rows: [{ held: true }] };
        }
        return { rows: [] };
      }),
    } as unknown as pg.Pool;

    const initialResult = await verifyArchiveApplyActivation(initialPool, {
      runStartedAt,
      env: {
        WORKFLOW_KILL_SWITCH: "false",
        JOB_ARCHIVING_ENABLED: "true",
        JOB_ARCHIVING_PILOT_COMPLETE: "true",
        JOB_ARCHIVE_PILOT_CANONICAL_JOB_ID: pilotJobId,
      },
    });
    expect(initialResult).toEqual({ activationState: "INITIAL_ACTIVATION_VERIFIED" });

    const missingHoldPool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM job_archive_runs")) {
          return { rows: [{ completed: false }] };
        }
        return { rows: [{ held: false }] };
      }),
    } as unknown as pg.Pool;

    await expect(
      verifyArchiveApplyActivation(missingHoldPool, {
        runStartedAt,
        env: {
          WORKFLOW_KILL_SWITCH: "false",
          JOB_ARCHIVING_ENABLED: "true",
          JOB_ARCHIVING_PILOT_COMPLETE: "true",
          JOB_ARCHIVE_PILOT_CANONICAL_JOB_ID: pilotJobId,
        },
      }),
    ).rejects.toThrow(/Initial APPLY activation requires an active AGENT2_PILOT archive hold/i);

    const ongoingPoolQuery = vi.fn(async (sql: string) => {
      if (sql.includes("FROM job_archive_runs")) {
        return { rows: [{ completed: true }] };
      }
      throw new Error("Ongoing daily operation must not require an unexpired AGENT2_PILOT hold");
    });
    const ongoingPool = { query: ongoingPoolQuery } as unknown as pg.Pool;

    const ongoingResult = await verifyArchiveApplyActivation(ongoingPool, {
      runStartedAt: new Date("2026-12-01T03:15:00.000Z"),
      env: {
        WORKFLOW_KILL_SWITCH: "false",
        JOB_ARCHIVING_ENABLED: "true",
        JOB_ARCHIVING_PILOT_COMPLETE: "true",
        JOB_ARCHIVE_PILOT_CANONICAL_JOB_ID: pilotJobId,
      },
    });
    expect(ongoingResult).toEqual({ activationState: "ONGOING_DAILY_OPERATION" });
    expect(ongoingPoolQuery).toHaveBeenCalledTimes(1);
  });
});
