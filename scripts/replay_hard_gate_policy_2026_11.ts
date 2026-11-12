/**
 * Replay the 2026-11 hard-gate policy over stored gate decisions.
 *
 * Default is a DRY RUN inside `BEGIN READ ONLY`. It recomputes each job's gate with:
 * - the same pure evaluation that runHardGates uses (`evaluateHardGatesForJob`);
 * - the same effective workability policy (`resolveEffectiveWorkabilityPolicy`);
 * - the same employer-confirmed facts (`v_job_confirmed_facts_current`) and latest normalized
 *   source evidence of the version, so a gate result that rests on a confirmed fact replays
 *   identically and a conflicting confirmation stays unapplied;
 * - the same work-mode enrichment, in read-only preview mode (no writes, no page
 *   fetch). Jobs whose enrichment would fetch a page are counted as
 *   `enrichment fetch skipped`; their applied result can differ.
 *
 * It only considers each job's latest version and the latest gate decision for
 * that version. It writes nothing.
 *
 * Scope:
 * - Default: jobs whose latest decision is HARD_REJECT with a code this policy
 *   changed (AFFECTED_CODES).
 * - `--all-hard-rejected`: every HARD_REJECT row.
 * - `--include-non-rejected`: also PASS / NEEDS_VERIFICATION rows, to prove that
 *   nothing newly hard-rejects.
 * - `--ids-file=<path>`: exactly the listed canonical job ids, whatever their
 *   decision. This is the rollback / targeted re-gate mode.
 *
 * Output prints counts and canonical job ids only. Employer names and titles appear
 * only with `--show-titles`, which is for local terminals, never for public CI logs.
 *
 * APPLY (guarded; run only with the owner's approval):
 *   REGATE_APPLY_ALLOWED=true npx tsx scripts/replay_hard_gate_policy_2026_11.ts \
 *     --apply --confirm-workspace=<workspace uuid> [--source=...] [--ids-file=...]
 * - Refuses when any job would newly become HARD_REJECT, unless
 *   `--allow-new-rejections=<n>` equals that exact count.
 * - With `--include-non-rejected` or `--ids-file`, the flag is always required,
 *   even when the count is 0.
 * - Re-gates through scripts/regate_job_ids.ts (runHardGates, reprocess) and
 *   reports re-gated, skipped (with reasons) and unchanged counts.
 * - Exits non-zero when processed != eligible, a job errors, or the applied
 *   new rejections exceed the allowance.
 * - Compares applied outcomes with the dry run and reports any difference.
 *
 * Earlier gate_decisions rows stay, so a rollback can select the new rows by
 * gate_version or pipeline_run_id and re-gate them with scripts/regate_job_ids.ts.
 */
import fs from "node:fs";
import pg from "pg";
import dotenv from "dotenv";
import { pgPoolConfig } from "../src/db/pgSsl.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../src/workspace/context.js";
import {
  evaluateHardGatesForJob,
  remoteTerritoryScopeForPolicy,
  type PersistedRequirement,
} from "../src/pipeline/hardGate.js";
import { loadActiveStage3Preferences, resolveEffectiveWorkabilityPolicy } from "../src/pipeline/effectiveWorkabilityPolicy.js";
import { normalizeWorkMode } from "../src/pipeline/workModeNormalizer.js";
import { enrichWorkModeIfNeeded } from "../src/services/workModeEnrichment.js";
import type { ComparableFact } from "../src/pipeline/requirementComparators.js";
import { loadCurrentConfirmedJobFacts } from "../src/pipeline/confirmedJobFacts.js";
import { postingSourceEvidence } from "../src/pipeline/postingStatedFacts.js";
import { parseJobIds, printRegateOutcome, regateJobIds } from "./regate_job_ids.js";

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
  readonly idsFile: string | null;
  readonly allowNewRejections: number | null;
  readonly showTitles: boolean;
}

export function parseReplayArgs(argv: readonly string[]): ReplayOptions {
  const value = (name: string): string | null => {
    const hit = argv.find((arg) => arg.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3).trim() || null : null;
  };
  const integer = (raw: string | null, min: number): number | null => {
    if (raw === null || !/^\d+$/.test(raw)) return null;
    const parsed = Number.parseInt(raw, 10);
    return parsed >= min ? parsed : null;
  };
  return {
    apply: argv.includes("--apply"),
    confirmWorkspace: value("confirm-workspace"),
    source: value("source"),
    limit: integer(value("limit"), 1),
    allHardRejected: argv.includes("--all-hard-rejected") || argv.includes("--include-non-rejected"),
    includeNonRejected: argv.includes("--include-non-rejected"),
    idsFile: value("ids-file"),
    allowNewRejections: integer(value("allow-new-rejections"), 0),
    showTitles: argv.includes("--show-titles"),
  };
}

export type GateStatus = "PASS" | "NEEDS_VERIFICATION" | "HARD_REJECT";

export interface ReplayRow {
  readonly canonicalJobId: string;
  /** The stored latest decision for the job's latest version; NONE when it has none. */
  readonly oldDecision: GateStatus | "NONE";
  readonly oldCodes: readonly string[];
  readonly newStatus: GateStatus;
  readonly newCodes: readonly string[];
  /** True when work-mode enrichment would fetch a page in a real run (skipped in the dry run). */
  readonly enrichmentFetchSkipped?: boolean;
  readonly label: string | null;
}

export interface ReplayReport {
  readonly scanned: number;
  readonly transitions: Record<string, number>;
  readonly byOldCode: Record<string, Record<string, number>>;
  readonly renamedOnly: number;
  /** Jobs that were not HARD_REJECT and now are. */
  readonly newlyRejected: number;
  readonly enrichmentFetchSkipped: number;
  readonly changedJobIds: readonly string[];
  readonly unchanged: number;
  readonly rows: readonly ReplayRow[];
}

/** Summarize replay rows. Exported for tests; pure. */
export function summarizeReplay(rows: readonly ReplayRow[]): ReplayReport {
  const transitions: Record<string, number> = {};
  const byOldCode: Record<string, Record<string, number>> = {};
  let renamedOnly = 0;
  let newlyRejected = 0;
  let enrichmentFetchSkipped = 0;
  const changedJobIds: string[] = [];
  for (const row of rows) {
    const key = `${row.oldDecision} -> ${row.newStatus}`;
    transitions[key] = (transitions[key] ?? 0) + 1;
    if (row.oldDecision !== "HARD_REJECT" && row.newStatus === "HARD_REJECT") newlyRejected += 1;
    if (row.enrichmentFetchSkipped) enrichmentFetchSkipped += 1;
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
  return {
    scanned: rows.length,
    transitions,
    byOldCode,
    renamedOnly,
    newlyRejected,
    enrichmentFetchSkipped,
    changedJobIds,
    unchanged: rows.length - changedJobIds.length,
    rows,
  };
}

/**
 * Guard for --apply. Throws unless every new HARD_REJECT is explicitly allowed with
 * the exact count; with --include-non-rejected or --ids-file the flag is always required.
 */
export function assertApplyAllowed(report: Pick<ReplayReport, "newlyRejected">, options: Pick<ReplayOptions, "includeNonRejected" | "idsFile" | "allowNewRejections">): void {
  const explicitRequired = options.includeNonRejected || options.idsFile !== null;
  if (explicitRequired && options.allowNewRejections === null) {
    throw new Error(`Refusing to apply: --include-non-rejected / --ids-file require --allow-new-rejections=<n> (dry run found ${report.newlyRejected}).`);
  }
  if (report.newlyRejected > 0 && options.allowNewRejections !== report.newlyRejected) {
    throw new Error(`Refusing to apply: ${report.newlyRejected} job(s) would newly become HARD_REJECT; pass --allow-new-rejections=${report.newlyRejected} only after reviewing them.`);
  }
  if (options.allowNewRejections !== null && options.allowNewRejections !== report.newlyRejected) {
    throw new Error(`Refusing to apply: --allow-new-rejections=${options.allowNewRejections} does not match the dry run (${report.newlyRejected}).`);
  }
}

/** Compare applied latest decisions with the dry-run expectation. Pure. */
export function compareApplied(
  rows: readonly ReplayRow[],
  applied: ReadonlyMap<string, { decision: GateStatus; codes: readonly string[] }>,
): { matched: number; differed: string[]; missing: string[]; appliedNewlyRejected: number } {
  let matched = 0;
  let appliedNewlyRejected = 0;
  const differed: string[] = [];
  const missing: string[] = [];
  for (const row of rows) {
    const actual = applied.get(row.canonicalJobId);
    if (!actual) {
      missing.push(row.canonicalJobId);
      continue;
    }
    if (row.oldDecision !== "HARD_REJECT" && actual.decision === "HARD_REJECT") appliedNewlyRejected += 1;
    const sameCodes = JSON.stringify([...actual.codes].sort()) === JSON.stringify([...row.newCodes].sort());
    if (actual.decision === row.newStatus && sameCodes) matched += 1;
    else differed.push(`${row.canonicalJobId} expected ${row.newStatus} ${JSON.stringify(row.newCodes)} applied ${actual.decision} ${JSON.stringify(actual.codes)}`);
  }
  return { matched, differed, missing, appliedNewlyRejected };
}

const LATEST_VERSION_SQL = `COALESCE(c.latest_job_version_id, (
  SELECT jv2.id FROM job_versions jv2
  WHERE jv2.workspace_id = c.workspace_id AND jv2.canonical_job_id = c.id
  ORDER BY jv2.observed_at DESC LIMIT 1))`;

export async function computeReplayRows(client: pg.PoolClient, ctx: WorkspaceContext, options: ReplayOptions, ids: readonly string[] | null): Promise<ReplayRow[]> {
  const stage3 = (await loadActiveStage3Preferences(client, ctx)) ?? {};
  const resolution = await resolveEffectiveWorkabilityPolicy(client, { context: ctx, stage3 });
  const territoryScope = remoteTerritoryScopeForPolicy(resolution.policy);
  console.log(`Effective workability policy: ${resolution.source} hash=${resolution.policyHash.slice(0, 12)} on-site exception employers=${(resolution.policy.onsiteExceptionEmployers ?? []).length}`);

  const params: unknown[] = [ctx.workspaceId];
  const filters: string[] = [];
  if (ids) {
    filters.push(`c.id = ANY($${params.push([...ids])}::uuid[])`);
  } else {
    if (!options.includeNonRejected) filters.push(`g.decision = 'HARD_REJECT'`);
    else filters.push(`g.decision IS NOT NULL`);
    if (!options.allHardRejected) filters.push(`g.rejection_codes ?| $${params.push([...AFFECTED_CODES])}::text[]`);
  }
  if (options.source) {
    filters.push(`EXISTS (SELECT 1 FROM raw_job_observations so JOIN job_versions sv ON sv.id = so.job_version_id
      WHERE so.workspace_id = c.workspace_id AND sv.canonical_job_id = c.id AND so.source_name = $${params.push(options.source)})`);
  }
  const limitClause = options.limit ? `LIMIT $${params.push(options.limit)}` : "";
  const { rows: jobs } = await client.query(
    `SELECT c.id, c.company_name, c.normalized_title, c.location, c.workplace_type, c.employment_type, c.canonical_url,
            jv.description_text, jv.id AS job_version_id, jv.active_requirement_set_id,
            jv.source_published_at AS posted_at, jv.reposted_at, jv.source_updated_at, jv.freshness_basis,
            g.decision AS old_decision, g.rejection_codes AS old_codes,
            so.compensation_raw, so.source_name AS source_observation_name, so.location_raw AS source_location_raw,
            se.normalized_evidence AS source_normalized_evidence
     FROM canonical_jobs c
     JOIN job_versions jv ON jv.workspace_id = c.workspace_id AND jv.id = ${LATEST_VERSION_SQL}
     LEFT JOIN LATERAL (
       -- The latest gate decision for the job's latest version only.
       SELECT gd.decision, gd.rejection_codes FROM gate_decisions gd
       WHERE gd.workspace_id = c.workspace_id AND gd.canonical_job_id = c.id AND gd.job_version_id = jv.id
       ORDER BY gd.created_at DESC, gd.id DESC LIMIT 1) g ON TRUE
     LEFT JOIN LATERAL (
       SELECT o.compensation_raw, o.source_name, o.location_raw FROM raw_job_observations o
       WHERE o.workspace_id = jv.workspace_id AND o.job_version_id = jv.id
       ORDER BY o.retrieved_at DESC, o.id DESC LIMIT 1) so ON TRUE
     LEFT JOIN LATERAL (
       SELECT o.normalized_evidence FROM raw_job_observations o
       WHERE o.workspace_id = jv.workspace_id AND o.job_version_id = jv.id AND o.normalized_evidence IS NOT NULL
       ORDER BY o.retrieved_at DESC, o.id DESC LIMIT 1) se ON TRUE
     WHERE c.workspace_id = $1 AND c.archived_at IS NULL
       ${filters.map((filter) => `AND ${filter}`).join("\n       ")}
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
    // The same work-mode enrichment runHardGates performs, previewed without writes or fetches.
    let workplaceType: string | null = job.workplace_type;
    let enrichmentFetchSkipped = false;
    if (normalizeWorkMode(workplaceType) === "UNKNOWN") {
      const enriched = await enrichWorkModeIfNeeded(client, ctx, {
        canonical_job_id: job.id,
        job_version_id: job.job_version_id,
        canonical_url: job.canonical_url,
        workplace_type: job.workplace_type,
        location: job.location,
        description_text: job.description_text,
      }, { readOnly: true });
      if (enriched.workplace_type !== "UNKNOWN") workplaceType = enriched.workplace_type;
      enrichmentFetchSkipped = enriched.fetch_skipped === true;
    }
    const result = evaluateHardGatesForJob({
      job: {
        title: job.normalized_title,
        company_name: job.company_name,
        description: job.description_text,
        location: job.location,
        workplace_type: workplaceType,
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
      confirmedFacts: await loadCurrentConfirmedJobFacts(client, ctx.workspaceId, job.job_version_id),
      sourceEvidence: postingSourceEvidence(job.source_normalized_evidence),
    });
    out.push({
      canonicalJobId: job.id,
      oldDecision: job.old_decision ?? "NONE",
      oldCodes: Array.isArray(job.old_codes) ? job.old_codes : [],
      newStatus: result.status,
      newCodes: result.rejection_codes,
      enrichmentFetchSkipped,
      label: options.showTitles ? `${job.company_name} | ${job.normalized_title}` : null,
    });
  }
  return out;
}

function printReport(report: ReplayReport): void {
  console.log(`Scanned jobs: ${report.scanned}`);
  for (const [key, count] of Object.entries(report.transitions).sort()) console.log(`  ${key}: ${count}`);
  console.log(`  HARD_REJECT with renamed codes only: ${report.renamedOnly}`);
  console.log(`  Newly HARD_REJECT: ${report.newlyRejected}`);
  console.log(`  Changed: ${report.changedJobIds.length}  unchanged: ${report.unchanged}`);
  console.log(`  Enrichment fetch skipped in dry run (applied result may differ): ${report.enrichmentFetchSkipped}`);
  console.log("By stored code -> new status:");
  for (const [code, buckets] of Object.entries(report.byOldCode).sort()) {
    console.log(`  ${code}: ${Object.entries(buckets).map(([status, n]) => `${status}=${n}`).join(" ")}`);
  }
  for (const row of report.rows) {
    if (row.newStatus === row.oldDecision && JSON.stringify(row.oldCodes) === JSON.stringify(row.newCodes)) continue;
    console.log(`  - ${row.canonicalJobId} ${row.oldDecision} ${JSON.stringify(row.oldCodes)} -> ${row.newStatus} ${JSON.stringify(row.newCodes)}${row.enrichmentFetchSkipped ? " (fetch skipped)" : ""}${row.label ? ` | ${row.label}` : ""}`);
  }
}

async function loadAppliedDecisions(pool: pg.Pool, workspaceId: string, ids: readonly string[]): Promise<Map<string, { decision: GateStatus; codes: string[] }>> {
  const applied = new Map<string, { decision: GateStatus; codes: string[] }>();
  if (ids.length === 0) return applied;
  const { rows } = await pool.query<{ id: string; decision: GateStatus; rejection_codes: string[] }>(
    `SELECT DISTINCT ON (g.canonical_job_id) g.canonical_job_id::text AS id, g.decision, g.rejection_codes
     FROM gate_decisions g
     WHERE g.workspace_id = $1 AND g.canonical_job_id = ANY($2::uuid[])
     ORDER BY g.canonical_job_id, g.created_at DESC, g.id DESC`,
    [workspaceId, [...ids]],
  );
  for (const row of rows) applied.set(row.id, { decision: row.decision, codes: Array.isArray(row.rejection_codes) ? row.rejection_codes : [] });
  return applied;
}

export async function replayHardGatePolicy(options: ReplayOptions): Promise<ReplayReport> {
  const databaseUrl = String(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const ids = options.idsFile ? parseJobIds(fs.readFileSync(options.idsFile, "utf8")) : null;
  const pool = new pg.Pool(pgPoolConfig(databaseUrl));
  try {
    const client = await pool.connect();
    let report: ReplayReport;
    let ctx: WorkspaceContext;
    try {
      await client.query("BEGIN READ ONLY");
      try {
        ctx = await resolveWorkspaceContext(client as any);
        report = summarizeReplay(await computeReplayRows(client, ctx, options, ids));
      } finally {
        await client.query("ROLLBACK");
      }
    } finally {
      client.release();
    }
    console.log(options.apply ? "[APPLY] dry-run summary before re-gating:" : "[DRY RUN] nothing was written.");
    printReport(report);
    if (!options.apply) return report;

    assertApplyAllowed(report, options);
    if (process.env.REGATE_APPLY_ALLOWED !== "true") {
      throw new Error("Refusing to apply: set REGATE_APPLY_ALLOWED=true after owner approval.");
    }
    if (!options.confirmWorkspace || options.confirmWorkspace !== ctx.workspaceId) {
      throw new Error("Refusing to apply: --confirm-workspace must equal the resolved workspace id.");
    }
    const targets = report.changedJobIds;
    const outcome = await regateJobIds(pool, ctx, targets);
    console.log(`[APPLY] unchanged (not re-gated): ${report.unchanged}`);
    printRegateOutcome(outcome);

    const skippedIds = new Set(outcome.skipped.map((entry) => entry.id));
    const appliedRows = report.rows.filter((row) => targets.includes(row.canonicalJobId) && !skippedIds.has(row.canonicalJobId));
    const comparison = compareApplied(appliedRows, await loadAppliedDecisions(pool, ctx.workspaceId, appliedRows.map((row) => row.canonicalJobId)));
    console.log(`[APPLY] applied outcome matches dry run: ${comparison.matched}; differs: ${comparison.differed.length}; missing: ${comparison.missing.length}; applied newly HARD_REJECT: ${comparison.appliedNewlyRejected}`);
    for (const line of comparison.differed) console.log(`  ~ ${line}`);

    if (!outcome.ok) throw new Error("Re-gate incomplete: processed count differs from eligible ids or a job errored.");
    const allowed = options.allowNewRejections ?? 0;
    if (comparison.appliedNewlyRejected > allowed) {
      throw new Error(`Applied re-gate produced ${comparison.appliedNewlyRejected} new HARD_REJECT job(s), above the allowed ${allowed}; roll back with scripts/regate_job_ids.ts.`);
    }
    return report;
  } finally {
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
