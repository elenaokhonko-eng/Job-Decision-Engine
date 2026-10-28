import dotenv from "dotenv";
import pg from "pg";

import { pgPoolConfig } from "../src/db/pgSsl.js";
import { runJobArchive } from "../src/services/jobArchive.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

interface ArchiveCliOptions {
  readonly mode: "DRY_RUN" | "APPLY";
  readonly pageSize: number;
  readonly maxArchives: number;
  readonly workspaceId: string | null;
}

function positiveInteger(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer.`);
  return parsed;
}

function argumentValue(args: readonly string[], flag: string): string | undefined {
  const flagIndex = args.indexOf(flag);
  if (flagIndex >= 0) return args[flagIndex + 1];
  const prefixed = args.find((argument) => argument.startsWith(`${flag}=`));
  return prefixed?.slice(flag.length + 1);
}

function parseOptions(args: readonly string[]): ArchiveCliOptions {
  const rawMode = argumentValue(args, "--mode")?.toUpperCase() ?? "DRY_RUN";
  if (rawMode !== "DRY_RUN" && rawMode !== "APPLY") {
    throw new Error("--mode must be DRY_RUN or APPLY.");
  }
  const workspaceId = argumentValue(args, "--workspace-id")?.trim() || null;
  if (workspaceId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workspaceId)) {
    throw new Error("--workspace-id must be a UUID.");
  }
  return {
    mode: rawMode,
    pageSize: positiveInteger(argumentValue(args, "--page-size"), 250, "--page-size"),
    maxArchives: positiveInteger(argumentValue(args, "--max-archives"), 500, "--max-archives"),
    workspaceId,
  };
}

async function requireActivePilotHold(
  pool: pg.Pool,
  pilotJobId: string,
  runStartedAt: Date,
): Promise<void> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pilotJobId)) {
    throw new Error("JOB_ARCHIVE_PILOT_CANONICAL_JOB_ID must be a UUID.");
  }
  const result = await pool.query<{ held: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM job_archive_holds
       WHERE canonical_job_id = $1
         AND hold_type = 'AGENT2_PILOT'
         AND released_at IS NULL
         AND expires_at > $2
     ) AS held`,
    [pilotJobId, runStartedAt],
  );
  if (result.rows[0]?.held !== true) {
    throw new Error("APPLY requires an active AGENT2_PILOT archive hold for JOB_ARCHIVE_PILOT_CANONICAL_JOB_ID.");
  }
}

export async function run(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const runStartedAt = new Date();
  if (options.mode === "APPLY") {
    if (process.env.WORKFLOW_KILL_SWITCH?.trim().toLowerCase() === "true") {
      throw new Error("Archive apply is disabled by WORKFLOW_KILL_SWITCH.");
    }
    if (process.env.JOB_ARCHIVING_ENABLED?.trim().toLowerCase() !== "true") {
      throw new Error("Archive apply requires JOB_ARCHIVING_ENABLED=true.");
    }
    if (process.env.JOB_ARCHIVING_PILOT_COMPLETE?.trim().toLowerCase() !== "true") {
      throw new Error("Archive apply requires JOB_ARCHIVING_PILOT_COMPLETE=true after the live-job pilot.");
    }
  }

  const databaseUrl = String(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL must be configured.");

  const pool = new pg.Pool(pgPoolConfig(databaseUrl));
  try {
    if (options.mode === "APPLY") {
      const pilotJobId = process.env.JOB_ARCHIVE_PILOT_CANONICAL_JOB_ID?.trim();
      if (!pilotJobId) {
        throw new Error("APPLY requires JOB_ARCHIVE_PILOT_CANONICAL_JOB_ID and its active AGENT2_PILOT hold.");
      }
      await requireActivePilotHold(pool, pilotJobId, runStartedAt);
    }
    const report = await runJobArchive(pool, {
      mode: options.mode,
      workspaceId: options.workspaceId ?? undefined,
      pageSize: options.pageSize,
      maxArchives: options.maxArchives,
      runStartedAt,
      actor: `workflow:${process.env.GITHUB_ACTOR?.trim() || "local"}`,
    });
    if (report.run_status === "FAILED" || report.failed_count > 0) {
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
