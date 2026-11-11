/**
 * Re-gate an explicit list of canonical job ids. Used for the scoped re-gate and
 * for rollback.
 *
 * Default is a DRY RUN inside `BEGIN READ ONLY`. It reports, for each id,
 * whether `runHardGates` would select it, and the reasons when it would not.
 * It writes nothing.
 *
 * APPLY (guarded; run only with the owner's approval):
 *   REGATE_APPLY_ALLOWED=true npx tsx scripts/regate_job_ids.ts \
 *     --ids-file=private/rollout/ids.txt --apply --confirm-workspace=<workspace uuid>
 *
 * Apply re-gates eligible ids in batches with runHardGates({ canonicalJobIds,
 * reprocess: true }). It reports re-gated, skipped (with reasons) and errored
 * counts, and exits non-zero when the number of processed jobs differs from
 * the number of eligible ids or any job errors.
 *
 * Rollback-safe: this file imports only APIs that existed before PR #173
 * (runHardGates, sourceContentEvidencePredicate, resolveWorkspaceContext,
 * pgPoolConfig). After reverting #173, restore just this file with
 * `git checkout <#173 merge sha> -- scripts/regate_job_ids.ts` and run it under
 * the reverted gate code.
 *
 * The ids file holds one canonical job uuid per line; blank lines and lines
 * starting with # are ignored. Output prints ids and counts only, never
 * employer names or titles.
 */
import fs from "node:fs";
import pg from "pg";
import dotenv from "dotenv";
import { pgPoolConfig } from "../src/db/pgSsl.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../src/workspace/context.js";
import { runHardGates } from "../src/pipeline/hardGate.js";
import { sourceContentEvidencePredicate } from "../src/pipeline/descriptionQuality.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RegateSkipReason =
  | "NOT_FOUND"
  | "ARCHIVED"
  | "MANUALLY_REMOVED"
  | "NO_JOB_VERSION"
  | "DESCRIPTION_NOT_COMPLETE"
  | "NO_SOURCE_CONTENT_EVIDENCE";

export interface RegateEligibility {
  readonly eligible: readonly string[];
  readonly skipped: ReadonlyArray<{ readonly id: string; readonly reasons: readonly RegateSkipReason[] }>;
}

export interface RegateOutcome {
  readonly requested: number;
  readonly eligible: number;
  readonly regated: number;
  readonly errors: number;
  readonly skipped: RegateEligibility["skipped"];
  /** Jobs that were eligible but not processed (runHardGates selected fewer than expected). */
  readonly unprocessed: number;
  readonly ok: boolean;
}

/** Parse an ids file: one uuid per line; blank lines and `#` comments ignored. Invalid lines throw. */
export function parseJobIds(text: string): string[] {
  const ids: string[] = [];
  const invalid: number[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    if (!UUID_RE.test(line)) invalid.push(index + 1);
    else ids.push(line.toLowerCase());
  });
  if (invalid.length > 0) throw new Error(`Ids file has ${invalid.length} invalid line(s): ${invalid.slice(0, 10).join(", ")}`);
  return [...new Set(ids)];
}

/**
 * The same selection runHardGates applies with `reprocess: true`, per id, with reasons.
 * Read-only.
 */
export async function checkRegateEligibility(
  client: pg.Pool | pg.PoolClient,
  workspaceId: string,
  ids: readonly string[],
): Promise<RegateEligibility> {
  if (ids.length === 0) return { eligible: [], skipped: [] };
  const { rows } = await client.query<{
    id: string;
    archived: boolean;
    manually_removed: boolean;
    has_version: boolean;
    description_complete: boolean;
    has_source_evidence: boolean;
  }>(
    `SELECT c.id::text AS id,
            c.archived_at IS NOT NULL AS archived,
            COALESCE(c.processing_state, c.processing_status) = 'MANUALLY_REMOVED' AS manually_removed,
            jv.id IS NOT NULL AS has_version,
            COALESCE(c.description_quality_status = 'COMPLETE', FALSE) AS description_complete,
            CASE WHEN jv.id IS NULL THEN FALSE ELSE ${sourceContentEvidencePredicate("c.workspace_id", "jv.id")} END AS has_source_evidence
     FROM canonical_jobs c
     LEFT JOIN job_versions jv ON jv.workspace_id = c.workspace_id AND jv.id = COALESCE(
       c.latest_job_version_id,
       (SELECT jv2.id FROM job_versions jv2
         WHERE jv2.workspace_id = c.workspace_id AND jv2.canonical_job_id = c.id
         ORDER BY jv2.observed_at DESC LIMIT 1)
     )
     WHERE c.workspace_id = $1 AND c.id = ANY($2::uuid[])`,
    [workspaceId, [...ids]],
  );
  const byId = new Map(rows.map((row) => [row.id.toLowerCase(), row]));
  const eligible: string[] = [];
  const skipped: Array<{ id: string; reasons: RegateSkipReason[] }> = [];
  for (const id of ids) {
    const row = byId.get(id.toLowerCase());
    const reasons: RegateSkipReason[] = [];
    if (!row) reasons.push("NOT_FOUND");
    else {
      if (row.archived) reasons.push("ARCHIVED");
      if (row.manually_removed) reasons.push("MANUALLY_REMOVED");
      if (!row.has_version) reasons.push("NO_JOB_VERSION");
      if (!row.description_complete) reasons.push("DESCRIPTION_NOT_COMPLETE");
      if (row.has_version && !row.has_source_evidence) reasons.push("NO_SOURCE_CONTENT_EVIDENCE");
    }
    if (reasons.length === 0) eligible.push(id);
    else skipped.push({ id, reasons });
  }
  return { eligible, skipped };
}

/** Count skip reasons for reporting. */
export function summarizeSkips(skipped: RegateEligibility["skipped"]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of skipped) for (const reason of entry.reasons) counts[reason] = (counts[reason] ?? 0) + 1;
  return counts;
}

/**
 * Re-gate eligible ids in batches and verify that runHardGates processed every one.
 * Writes: appends gate_decisions rows through runHardGates.
 */
export async function regateJobIds(
  db: pg.Pool | pg.PoolClient,
  context: WorkspaceContext,
  ids: readonly string[],
  options: { batchSize?: number } = {},
): Promise<RegateOutcome> {
  const batchSize = options.batchSize ?? 50;
  let eligibleTotal = 0;
  let regated = 0;
  let errors = 0;
  let unprocessed = 0;
  const skipped: Array<{ id: string; reasons: readonly RegateSkipReason[] }> = [];
  for (let index = 0; index < ids.length; index += batchSize) {
    const batch = ids.slice(index, index + batchSize);
    const eligibility = await checkRegateEligibility(db, context.workspaceId, batch);
    skipped.push(...eligibility.skipped);
    eligibleTotal += eligibility.eligible.length;
    if (eligibility.eligible.length === 0) continue;
    const summary = await runHardGates(db, { context, canonicalJobIds: [...eligibility.eligible], reprocess: true });
    const processed = summary.passed + summary.hardRejected + summary.needsVerification;
    regated += processed;
    errors += summary.errors;
    unprocessed += Math.max(0, eligibility.eligible.length - processed - summary.errors);
    if (summary.errors > 0 || processed + summary.errors !== eligibility.eligible.length) {
      console.error(`Batch ${index / batchSize + 1}: expected ${eligibility.eligible.length} job(s), processed ${processed}, errors ${summary.errors}; stopping.`);
      break;
    }
  }
  const ok = errors === 0 && unprocessed === 0 && regated === eligibleTotal;
  return { requested: ids.length, eligible: eligibleTotal, regated, errors, skipped, unprocessed, ok };
}

export function printRegateOutcome(outcome: RegateOutcome): void {
  console.log(`Requested: ${outcome.requested}  eligible: ${outcome.eligible}  re-gated: ${outcome.regated}  errors: ${outcome.errors}  unprocessed: ${outcome.unprocessed}`);
  console.log(`Skipped: ${outcome.skipped.length} ${JSON.stringify(summarizeSkips(outcome.skipped))}`);
  for (const entry of outcome.skipped) console.log(`  - skipped ${entry.id}: ${entry.reasons.join(", ")}`);
}

function argValue(argv: readonly string[], name: string): string | null {
  const hit = argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).trim() || null : null;
}

async function main(argv: readonly string[]): Promise<void> {
  const idsFile = argValue(argv, "ids-file");
  if (!idsFile) throw new Error("--ids-file=<path> is required.");
  const ids = parseJobIds(fs.readFileSync(idsFile, "utf8"));
  const apply = argv.includes("--apply");
  const databaseUrl = String(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const pool = new pg.Pool(pgPoolConfig(databaseUrl));
  try {
    const client = await pool.connect();
    let context: WorkspaceContext;
    try {
      await client.query("BEGIN READ ONLY");
      context = await resolveWorkspaceContext(client as any);
      const eligibility = await checkRegateEligibility(client, context.workspaceId, ids);
      await client.query("ROLLBACK");
      console.log(`${apply ? "[APPLY] pre-check" : "[DRY RUN] nothing was written."} ids=${ids.length} eligible=${eligibility.eligible.length} skipped=${eligibility.skipped.length} ${JSON.stringify(summarizeSkips(eligibility.skipped))}`);
      for (const entry of eligibility.skipped) console.log(`  - skipped ${entry.id}: ${entry.reasons.join(", ")}`);
    } finally {
      client.release();
    }
    if (!apply) return;
    if (process.env.REGATE_APPLY_ALLOWED !== "true") throw new Error("Refusing to apply: set REGATE_APPLY_ALLOWED=true after owner approval.");
    if (argValue(argv, "confirm-workspace") !== context.workspaceId) {
      throw new Error("Refusing to apply: --confirm-workspace must equal the resolved workspace id.");
    }
    const outcome = await regateJobIds(pool, context, ids);
    printRegateOutcome(outcome);
    if (!outcome.ok) throw new Error("Re-gate incomplete: processed count differs from eligible ids or a job errored.");
  } finally {
    await pool.end();
  }
}

const isDirectRun = process.argv[1] && /regate_job_ids\.ts$/.test(process.argv[1].replace(/\\/g, "/"));
if (isDirectRun) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error("Re-gate failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
