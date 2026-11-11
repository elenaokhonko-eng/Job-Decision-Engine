/**
 * Replay the 2026-11 hard-gate policy over stored HARD_REJECTED decisions.
 *
 * Default is a DRY RUN inside `BEGIN READ ONLY`: it recomputes each job's gate
 * with the same pure evaluation runHardGates uses (`evaluateHardGatesForJob`)
 * and the same effective workability policy (`resolveEffectiveWorkabilityPolicy`),
 * then prints aggregate counts. It writes nothing.
 *
 * Scope: canonical jobs whose latest gate decision is HARD_REJECT and carries a
 * code this policy changed (see AFFECTED_CODES). `--all-hard-rejected` widens it
 * to every HARD_REJECT row, so you can confirm that nothing else changes.
 *
 * Output prints counts and canonical job ids only. Employer names and titles
 * appear only with `--show-titles`, which is for local terminals, never for
 * public CI logs.
 *
 * APPLY (guarded; run only with the owner's approval):
 *   REGATE_APPLY_ALLOWED=true npx tsx scripts/replay_hard_gate_policy_2026_11.ts \
 *     --apply --confirm-workspace=<workspace uuid>
 * This calls runHardGates({ canonicalJobIds, reprocess: true }) in batches for the
 * jobs whose outcome changes. That appends new gate_decisions rows. Earlier rows
 * stay, so a rollback can select them by gate_version or pipeline_run_id.
 *
 * Options: --source=LINKEDIN_SAVED  --limit=N  --all-hard-rejected  --show-titles
 *          --include-non-rejected  (also replays PASS / NEEDS_VERIFICATION rows, to prove
 *          that nothing newly hard-rejects; implies --all-hard-rejected)
 */
import pg from "pg";
import dotenv from "dotenv";
import { pgPoolConfig } from "../src/db/pgSsl.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../src/workspace/context.js";
import {
  evaluateHardGatesForJob,
  remoteTerritoryScopeForPolicy,
  runHardGates,
  type PersistedRequirement,
} from "../src/pipeline/hardGate.js";
import { loadActiveStage3Preferences, resolveEffectiveWorkabilityPolicy } from "../src/pipeline/effectiveWorkabilityPolicy.js";
import type { ComparableFact } from "../src/pipeline/requirementComparators.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

/** Stored codes whose meaning this policy change altered. */
export const AFFECTED_CODES: readonly string[] = [
  "NON_TECHNICAL_FUNCTION",
  "GATE_OUT_OF_SCOPE_DOMAIN",
  "GATE_NOT_AI_DATA",
  "UNWORKABLE_LOCATION_MODEL",
  "GATE_HIGH_OFFICE_DAYS",
  "GATE_LIFESTYLE_INCOMPATIBLE",
  "WORK_AUTHORIZATION_INCOMPATIBLE",
  "GATE_REMOTE_TERRITORY_RESTRICTED",
];

export interface ReplayOptions {
  readonly apply: boolean;
  readonly confirmWorkspace: string | null;
  readonly source: string | null;
  readonly limit: number | null;
  readonly allHardRejected: boolean;
  readonly includeNonRejected: boolean;
  readonly showTitles: boolean;
}

export function parseReplayArgs(argv: readonly string[]): ReplayOptions {
  const value = (name: string): string | null => {
    const hit = argv.find((arg) => arg.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3).trim() || null : null;
  };
  const limit = value("limit");
  const parsedLimit = limit ? Number.parseInt(limit, 10) : NaN;
  return {
    apply: argv.includes("--apply"),
    confirmWorkspace: value("confirm-workspace"),
    source: value("source"),
    limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : null,
    allHardRejected: argv.includes("--all-hard-rejected") || argv.includes("--include-non-rejected"),
    includeNonRejected: argv.includes("--include-non-rejected"),
    showTitles: argv.includes("--show-titles"),
  };
}

export interface ReplayRow {
  readonly canonicalJobId: string;
  readonly oldDecision: "PASS" | "NEEDS_VERIFICATION" | "HARD_REJECT";
  readonly oldCodes: readonly string[];
  readonly newStatus: "PASS" | "NEEDS_VERIFICATION" | "HARD_REJECT";
  readonly newCodes: readonly string[];
  readonly label: string | null;
}

export interface ReplayReport {
  readonly scanned: number;
  readonly transitions: Record<string, number>;
  readonly byOldCode: Record<string, Record<string, number>>;
  readonly renamedOnly: number;
  /** Jobs that were not HARD_REJECT and now are. Must be 0 for this policy. */
  readonly newlyRejected: number;
  readonly changedJobIds: readonly string[];
  readonly rows: readonly ReplayRow[];
}

/** Summarize replay rows. Exported for tests; pure. */
export function summarizeReplay(rows: readonly ReplayRow[]): ReplayReport {
  const transitions: Record<string, number> = {};
  const byOldCode: Record<string, Record<string, number>> = {};
  let renamedOnly = 0;
  let newlyRejected = 0;
  const changedJobIds: string[] = [];
  for (const row of rows) {
    const key = `${row.oldDecision} -> ${row.newStatus}`;
    if (row.oldDecision !== "HARD_REJECT" && row.newStatus === "HARD_REJECT") newlyRejected += 1;
    transitions[key] = (transitions[key] ?? 0) + 1;
    for (const code of row.oldCodes) {
      const bucket = (byOldCode[code] ??= {});
      bucket[row.newStatus] = (bucket[row.newStatus] ?? 0) + 1;
    }
    const sameCodes = JSON.stringify([...row.oldCodes].sort()) === JSON.stringify([...row.newCodes].sort());
    if (row.newStatus !== row.oldDecision) changedJobIds.push(row.canonicalJobId);
    else if (!sameCodes) {
      if (row.oldDecision === "HARD_REJECT") renamedOnly += 1;
      changedJobIds.push(row.canonicalJobId);
    }
  }
  return { scanned: rows.length, transitions, byOldCode, renamedOnly, newlyRejected, changedJobIds, rows };
}

async function computeReplayRows(client: pg.PoolClient, ctx: WorkspaceContext, options: ReplayOptions): Promise<ReplayRow[]> {
  const stage3 = (await loadActiveStage3Preferences(client, ctx)) ?? {};
  const resolution = await resolveEffectiveWorkabilityPolicy(client, { context: ctx, stage3 });
  const territoryScope = remoteTerritoryScopeForPolicy(resolution.policy);
  console.log(`Effective workability policy: ${resolution.source} hash=${resolution.policyHash.slice(0, 12)} on-site exception employers=${(resolution.policy.onsiteExceptionEmployers ?? []).length}`);

  const params: unknown[] = [ctx.workspaceId];
  const sourceFilter = options.source
    ? `AND EXISTS (SELECT 1 FROM raw_job_observations so JOIN job_versions sv ON sv.id = so.job_version_id
         WHERE so.workspace_id = c.workspace_id AND sv.canonical_job_id = c.id AND so.source_name = $${params.push(options.source)})`
    : "";
  const codeFilter = options.allHardRejected ? "" : `AND g.rejection_codes ?| $${params.push([...AFFECTED_CODES])}::text[]`;
  const limitClause = options.limit ? `LIMIT $${params.push(options.limit)}` : "";
  const { rows: jobs } = await client.query(
    `WITH latest AS (
       SELECT DISTINCT ON (g.canonical_job_id) g.canonical_job_id, g.decision, g.rejection_codes
       FROM gate_decisions g WHERE g.workspace_id = $1
       ORDER BY g.canonical_job_id, g.created_at DESC, g.id DESC
     )
     SELECT c.id, c.company_name, c.normalized_title, c.location, c.workplace_type, c.employment_type,
            jv.description_text, jv.id AS job_version_id, jv.active_requirement_set_id,
            jv.source_published_at AS posted_at, jv.reposted_at, jv.source_updated_at, jv.freshness_basis,
            g.decision AS old_decision, g.rejection_codes AS old_codes,
            so.compensation_raw, so.source_name AS source_observation_name, so.location_raw AS source_location_raw
     FROM latest g
     JOIN canonical_jobs c ON c.id = g.canonical_job_id AND c.workspace_id = $1 AND c.archived_at IS NULL
     JOIN job_versions jv ON jv.id = c.latest_job_version_id
     LEFT JOIN LATERAL (
       SELECT o.compensation_raw, o.source_name, o.location_raw FROM raw_job_observations o
       WHERE o.workspace_id = jv.workspace_id AND o.job_version_id = jv.id
       ORDER BY o.retrieved_at DESC, o.id DESC LIMIT 1) so ON TRUE
     WHERE ${options.includeNonRejected ? "TRUE" : "g.decision = 'HARD_REJECT'"}
       ${codeFilter}
       ${sourceFilter}
     ORDER BY c.created_at ASC, c.id ASC
     ${limitClause}`,
    params,
  );

  const { rows: profileFacts } = await client.query<ComparableFact>(
    `SELECT pf.id, pf.statement, pf.structured_value FROM profile_facts pf
     WHERE pf.workspace_id = $1 AND pf.fact_type <> 'CONTACT'
       AND pf.profile_version_id = (SELECT id FROM profile_versions WHERE workspace_id = $1 AND status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1)`,
    [ctx.workspaceId],
  );

  const out: ReplayRow[] = [];
  for (const job of jobs) {
    const { rows: requirements } = await client.query<PersistedRequirement>(
      `SELECT jr.requirement_key, jr.requirement_type, jr.importance, jr.requirement_text, jr.quote_text, jr.structured_value
       FROM job_requirements jr
       WHERE jr.workspace_id = $1 AND jr.status = 'VALIDATED'
         AND (($2::uuid IS NOT NULL AND jr.requirement_set_id = $2) OR ($2::uuid IS NULL AND jr.job_version_id = $3))
       ORDER BY jr.requirement_key ASC`,
      [ctx.workspaceId, job.active_requirement_set_id, job.job_version_id],
    );
    const result = evaluateHardGatesForJob({
      job: {
        title: job.normalized_title,
        company_name: job.company_name,
        description: job.description_text,
        location: job.location,
        workplace_type: job.workplace_type,
        employment_type: job.employment_type,
        compensation_raw: job.compensation_raw,
        posted_at: job.posted_at,
        reposted_at: job.reposted_at,
        source_updated_at: job.source_updated_at,
        freshness_basis: job.freshness_basis,
        source_observation_name: job.source_observation_name,
        source_location_raw: job.source_location_raw,
      },
      requirements,
      profileFacts: requirements.some((r) => r.requirement_type === "WORK_AUTH") ? profileFacts : [],
      policy: resolution.policy,
      stage3Preferences: stage3,
      territoryScope,
    });
    out.push({
      canonicalJobId: job.id,
      oldDecision: job.old_decision,
      oldCodes: Array.isArray(job.old_codes) ? job.old_codes : [],
      newStatus: result.status,
      newCodes: result.rejection_codes,
      label: options.showTitles ? `${job.company_name} | ${job.normalized_title}` : null,
    });
  }
  return out;
}

function printReport(report: ReplayReport): void {
  console.log(`Scanned jobs: ${report.scanned}`);
  for (const [key, count] of Object.entries(report.transitions).sort()) console.log(`  ${key}: ${count}`);
  console.log(`  HARD_REJECT with renamed codes only: ${report.renamedOnly}`);
  console.log(`  Newly HARD_REJECT (must be 0): ${report.newlyRejected}`);
  console.log("By stored code -> new status:");
  for (const [code, buckets] of Object.entries(report.byOldCode).sort()) {
    console.log(`  ${code}: ${Object.entries(buckets).map(([status, n]) => `${status}=${n}`).join(" ")}`);
  }
  for (const row of report.rows) {
    if (row.newStatus === row.oldDecision && JSON.stringify(row.oldCodes) === JSON.stringify(row.newCodes)) continue;
    console.log(`  - ${row.canonicalJobId} ${row.oldDecision} ${JSON.stringify(row.oldCodes)} -> ${row.newStatus} ${JSON.stringify(row.newCodes)}${row.label ? ` | ${row.label}` : ""}`);
  }
}

export async function replayHardGatePolicy(options: ReplayOptions): Promise<ReplayReport> {
  const databaseUrl = String(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const pool = new pg.Pool(pgPoolConfig(databaseUrl));
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    let report: ReplayReport;
    let ctx: WorkspaceContext;
    try {
      ctx = await resolveWorkspaceContext(client as any);
      report = summarizeReplay(await computeReplayRows(client, ctx, options));
    } finally {
      await client.query("ROLLBACK");
    }
    console.log(options.apply ? "[APPLY] dry-run summary before re-gating:" : "[DRY RUN] nothing was written.");
    printReport(report);

    if (!options.apply) return report;
    if (process.env.REGATE_APPLY_ALLOWED !== "true") {
      throw new Error("Refusing to apply: set REGATE_APPLY_ALLOWED=true after owner approval.");
    }
    if (!options.confirmWorkspace || options.confirmWorkspace !== ctx.workspaceId) {
      throw new Error("Refusing to apply: --confirm-workspace must equal the resolved workspace id.");
    }
    const batchSize = 50;
    for (let index = 0; index < report.changedJobIds.length; index += batchSize) {
      const batch = report.changedJobIds.slice(index, index + batchSize);
      const summary = await runHardGates(pool, { context: ctx, canonicalJobIds: batch, reprocess: true });
      if (summary.errors > 0) throw new Error(`Re-gate batch failed for ${summary.errors} job(s); stopping.`);
    }
    console.log(`[APPLY] re-gated ${report.changedJobIds.length} job(s).`);
    return report;
  } finally {
    client.release();
    await pool.end();
  }
}

const isDirectRun = process.argv[1] && /replay_hard_gate_policy_2026_11\.ts$/.test(process.argv[1].replace(/\\/g, "/"));
if (isDirectRun) {
  replayHardGatePolicy(parseReplayArgs(process.argv.slice(2))).catch((error: unknown) => {
    console.error("Hard-gate policy replay failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
