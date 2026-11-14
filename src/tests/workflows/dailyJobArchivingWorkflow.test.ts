import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { parseArchiveCliOptions, verifyArchiveApplyActivation } from "../../../scripts/archive_jobs.js";

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
    expect(workflow).toContain(
      "vars.JOB_ARCHIVING_ENABLED == 'true' && (vars.JOB_ARCHIVING_PILOT_COMPLETE == 'true' || vars.JOB_ARCHIVING_RULE == 'hard-rejected') && 'APPLY' || 'DRY_RUN'",
    );
    expect(workflow).toContain("ARCHIVE_RULE: ${{ github.event_name == 'schedule' && (vars.JOB_ARCHIVING_RULE || 'all') || inputs.rule }}");
    // Scheduled runs keep the bounded daily cap; only a manual dispatch may raise it.
    expect(workflow).toContain("ARCHIVE_MAX_ARCHIVES: ${{ github.event_name == 'schedule' && '500' || inputs.max_archives }}");
    expect(workflow).toContain('--rule "${ARCHIVE_RULE}"');
    expect(workflow).toContain('if [[ "$INPUT_RULE" != "hard-rejected" && "$JOB_ARCHIVING_PILOT_COMPLETE" != "true" ]]; then');

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

  it("counts only APPLY runs that included the age rule as the age rule's initial activation", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM job_archive_runs")) return { rows: [{ completed: false }] };
      return { rows: [{ held: true }] };
    });
    await verifyArchiveApplyActivation({ query } as unknown as pg.Pool, {
      runStartedAt,
      rule: "all",
      env: {
        JOB_ARCHIVING_ENABLED: "true",
        JOB_ARCHIVING_PILOT_COMPLETE: "true",
        JOB_ARCHIVE_PILOT_CANONICAL_JOB_ID: pilotJobId,
      },
    });
    const runQuery = query.mock.calls.map(([sql]) => sql).find((sql) => sql.includes("FROM job_archive_runs"));
    expect(runQuery).toContain("COALESCE(report_summary->>'rule', 'age') IN ('age', 'all')");
  });

  it("lets a hard-rejected-only APPLY run without the age rule's live-job pilot, but never without the master switches", async () => {
    const query = vi.fn(async () => {
      throw new Error("A hard-rejected-only run must not consult the age rule's pilot state.");
    });
    const pool = { query } as unknown as pg.Pool;
    await expect(verifyArchiveApplyActivation(pool, {
      runStartedAt,
      rule: "hard-rejected",
      env: { JOB_ARCHIVING_ENABLED: "true" },
    })).resolves.toEqual({ activationState: "HARD_REJECTED_RULE_ONLY" });
    expect(query).not.toHaveBeenCalled();

    await expect(verifyArchiveApplyActivation(pool, {
      runStartedAt,
      rule: "hard-rejected",
      env: { JOB_ARCHIVING_ENABLED: "false" },
    })).rejects.toThrow(/JOB_ARCHIVING_ENABLED=true/);
    await expect(verifyArchiveApplyActivation(pool, {
      runStartedAt,
      rule: "hard-rejected",
      env: { JOB_ARCHIVING_ENABLED: "true", WORKFLOW_KILL_SWITCH: "true" },
    })).rejects.toThrow(/WORKFLOW_KILL_SWITCH/);
    // The age rule still needs the pilot-complete switch.
    for (const rule of ["age", "all"] as const) {
      await expect(verifyArchiveApplyActivation(pool, {
        runStartedAt,
        rule,
        env: { JOB_ARCHIVING_ENABLED: "true" },
      })).rejects.toThrow(/JOB_ARCHIVING_PILOT_COMPLETE=true/);
    }
  });

  it("parses --rule and allows a raised --max-archives for a one-off backfill", () => {
    expect(parseArchiveCliOptions([])).toMatchObject({ mode: "DRY_RUN", rule: "all", maxArchives: 500, pageSize: 250 });
    expect(parseArchiveCliOptions(["--mode", "APPLY", "--rule", "hard-rejected", "--max-archives", "6000"]))
      .toMatchObject({ mode: "APPLY", rule: "hard-rejected", maxArchives: 6000 });
    expect(parseArchiveCliOptions(["--rule=age"])).toMatchObject({ rule: "age" });
    expect(() => parseArchiveCliOptions(["--rule", "everything"])).toThrow(/--rule must be/);
    expect(() => parseArchiveCliOptions(["--max-archives", "10001"])).toThrow(/at most 10000/);
    expect(() => parseArchiveCliOptions(["--max-archives", "12abc"])).toThrow(/positive integer/);
  });
});
