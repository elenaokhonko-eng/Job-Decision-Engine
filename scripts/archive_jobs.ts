import dotenv from "dotenv";
import pg from "pg";

import { ArchiveRuleSelectionSchema, type ArchiveRuleSelection } from "../src/contracts/archive.js";
import { pgPoolConfig } from "../src/db/pgSsl.js";
import { MAX_ARCHIVES_PER_RUN, runJobArchive } from "../src/services/jobArchive.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

/**
 * Archive rules (see src/services/jobArchive.ts):
 *   age            JOB_OLDER_THAN_THREE_CALENDAR_MONTHS
 *   hard-rejected  HARD_REJECTED_PERMANENT
 *   all            both (default)
 *
 * Activation safety for APPLY:
 *   - Every APPLY needs WORKFLOW_KILL_SWITCH != true and JOB_ARCHIVING_ENABLED=true.
 *   - When the age rule runs (age or all), APPLY also needs JOB_ARCHIVING_PILOT_COMPLETE=true and,
 *     until an APPLY run that included the age rule has succeeded, an active AGENT2_PILOT hold on
 *     JOB_ARCHIVE_PILOT_CANONICAL_JOB_ID. A hard-rejected-only APPLY run never counts as that
 *     initial activation, so it cannot bypass the age rule's pilot.
 *   - A hard-rejected-only APPLY does not need the live-job pilot: the rule only takes jobs the
 *     deterministic gate already rejected with stored reason codes, never the owner's saved jobs,
 *     and every archive protection (including any AGENT2_PILOT or USER_PRESERVE hold) still applies.
 */

const DEFAULT_PAGE_SIZE = 250;
const DEFAULT_MAX_ARCHIVES = 500;

interface ArchiveCliOptions {
  readonly mode: "DRY_RUN" | "APPLY";
  readonly rule: ArchiveRuleSelection;
  readonly pageSize: number;
  readonly maxArchives: number;
  readonly workspaceId: string | null;
}

function positiveInteger(value: string | undefined, fallback: number, flag: string, max?: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value.trim())) throw new Error(`${flag} must be a positive integer.`);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer.`);
  if (max !== undefined && parsed > max) throw new Error(`${flag} must be at most ${max}.`);
  return parsed;
}

function argumentValue(args: readonly string[], flag: string): string | undefined {
  const flagIndex = args.indexOf(flag);
  if (flagIndex >= 0) return args[flagIndex + 1];
  const prefixed = args.find((argument) => argument.startsWith(`${flag}=`));
  return prefixed?.slice(flag.length + 1);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ArchiveApplyActivationStatus {
  readonly activationState: "INITIAL_ACTIVATION_VERIFIED" | "ONGOING_DAILY_OPERATION" | "HARD_REJECTED_RULE_ONLY";
}

export function ruleIncludesAge(rule: ArchiveRuleSelection): boolean {
  return rule === "age" || rule === "all";
}

export function parseArchiveCliOptions(args: readonly string[]): ArchiveCliOptions {
  const rawMode = argumentValue(args, "--mode")?.toUpperCase() ?? "DRY_RUN";
  if (rawMode !== "DRY_RUN" && rawMode !== "APPLY") {
    throw new Error("--mode must be DRY_RUN or APPLY.");
  }
  const rawRule = argumentValue(args, "--rule")?.trim().toLowerCase() ?? "all";
  const rule = ArchiveRuleSelectionSchema.safeParse(rawRule);
  if (!rule.success) throw new Error("--rule must be age, hard-rejected or all.");
  const workspaceId = argumentValue(args, "--workspace-id")?.trim() || null;
  if (workspaceId !== null && !UUID_PATTERN.test(workspaceId)) {
    throw new Error("--workspace-id must be a UUID.");
  }
  return {
    mode: rawMode,
    rule: rule.data,
    pageSize: positiveInteger(argumentValue(args, "--page-size"), DEFAULT_PAGE_SIZE, "--page-size", 1000),
    maxArchives: positiveInteger(
      argumentValue(args, "--max-archives"), DEFAULT_MAX_ARCHIVES, "--max-archives", MAX_ARCHIVES_PER_RUN,
    ),
    workspaceId,
  };
}

/** Whether an APPLY run that included the age rule has succeeded (legacy runs had only the age rule). */
async function hasCompletedInitialApplyRun(
  pool: pg.Pool,
  workspaceId: string | null,
): Promise<boolean> {
  const result = await pool.query<{ completed: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM job_archive_runs
       WHERE mode = 'APPLY'
         AND status = 'SUCCEEDED'
         AND COALESCE(report_summary->>'rule', 'age') IN ('age', 'all')
         AND ($1::uuid IS NULL OR report_summary->>'workspace_id' = ($1::uuid)::text)
     ) AS completed`,
    [workspaceId],
  );
  return result.rows[0]?.completed === true;
}

async function requireActivePilotHoldForInitialActivation(
  pool: pg.Pool,
  pilotJobId: string,
  runStartedAt: Date,
  workspaceId: string | null,
): Promise<void> {
  if (!UUID_PATTERN.test(pilotJobId)) {
    throw new Error("JOB_ARCHIVE_PILOT_CANONICAL_JOB_ID must be a UUID.");
  }
  const result = await pool.query<{ held: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM job_archive_holds
       WHERE canonical_job_id = $1::uuid
         AND ($3::uuid IS NULL OR workspace_id = $3::uuid)
         AND hold_type = 'AGENT2_PILOT'
         AND released_at IS NULL
         AND expires_at > $2::timestamptz
     ) AS held`,
    [pilotJobId, runStartedAt, workspaceId],
  );
  if (result.rows[0]?.held !== true) {
    throw new Error(
      "Initial APPLY activation requires an active AGENT2_PILOT archive hold for JOB_ARCHIVE_PILOT_CANONICAL_JOB_ID.",
    );
  }
}

/** Environment switches every APPLY run needs before it touches the database. */
export function requireApplyEnvironment(rule: ArchiveRuleSelection, env: NodeJS.ProcessEnv = process.env): void {
  if (env.WORKFLOW_KILL_SWITCH?.trim().toLowerCase() === "true") {
    throw new Error("Archive apply is disabled by WORKFLOW_KILL_SWITCH.");
  }
  if (env.JOB_ARCHIVING_ENABLED?.trim().toLowerCase() !== "true") {
    throw new Error("Archive apply requires JOB_ARCHIVING_ENABLED=true.");
  }
  if (ruleIncludesAge(rule) && env.JOB_ARCHIVING_PILOT_COMPLETE?.trim().toLowerCase() !== "true") {
    throw new Error("Archive apply requires JOB_ARCHIVING_PILOT_COMPLETE=true after the live-job pilot.");
  }
}

export async function verifyArchiveApplyActivation(
  pool: pg.Pool,
  options: {
    readonly runStartedAt: Date;
    readonly workspaceId?: string | null;
    readonly env?: NodeJS.ProcessEnv;
    /** Rules the APPLY run will evaluate; defaults to all. */
    readonly rule?: ArchiveRuleSelection;
  },
): Promise<ArchiveApplyActivationStatus> {
  const env = options.env ?? process.env;
  const workspaceId = options.workspaceId ?? null;
  const rule = options.rule ?? "all";
  requireApplyEnvironment(rule, env);
  const pilotJobId = env.JOB_ARCHIVE_PILOT_CANONICAL_JOB_ID?.trim() || "";
  if (pilotJobId !== "" && !UUID_PATTERN.test(pilotJobId)) {
    throw new Error("JOB_ARCHIVE_PILOT_CANONICAL_JOB_ID must be a UUID.");
  }
  if (!ruleIncludesAge(rule)) {
    return { activationState: "HARD_REJECTED_RULE_ONLY" };
  }
  if (await hasCompletedInitialApplyRun(pool, workspaceId)) {
    return { activationState: "ONGOING_DAILY_OPERATION" };
  }
  if (!pilotJobId) {
    throw new Error(
      "Initial APPLY activation requires JOB_ARCHIVE_PILOT_CANONICAL_JOB_ID and its active AGENT2_PILOT hold.",
    );
  }
  await requireActivePilotHoldForInitialActivation(pool, pilotJobId, options.runStartedAt, workspaceId);
  return { activationState: "INITIAL_ACTIVATION_VERIFIED" };
}

export async function run(
  args: readonly string[] = process.argv.slice(2),
  runStartedAt: Date = new Date(),
): Promise<void> {
  const options = parseArchiveCliOptions(args);
  if (options.mode === "APPLY") requireApplyEnvironment(options.rule);

  const databaseUrl = String(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL must be configured.");

  const pool = new pg.Pool(pgPoolConfig(databaseUrl));
  try {
    if (options.mode === "APPLY") {
      await verifyArchiveApplyActivation(pool, {
        runStartedAt,
        workspaceId: options.workspaceId,
        rule: options.rule,
      });
    }
    const report = await runJobArchive(pool, {
      mode: options.mode,
      rule: options.rule,
      workspaceId: options.workspaceId ?? undefined,
      pageSize: options.pageSize,
      maxArchives: options.maxArchives,
      runStartedAt,
      actor: `workflow:${process.env.GITHUB_ACTOR?.trim() || "local"}`,
    });
    if (report.run_status === "FAILED" || report.failed_count > 0 || report.hard_rejected.failed_count > 0) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.includes("archive_jobs")) {
  void run().catch((error: unknown) => {
    console.error("Daily job archiving failed:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
