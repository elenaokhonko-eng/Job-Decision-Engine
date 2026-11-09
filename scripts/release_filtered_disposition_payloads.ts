/**
 * Retention for FILTERED discovery dispositions (migration 105).
 *
 *   npx tsx scripts/release_filtered_disposition_payloads.ts            # dry run (default)
 *   npx tsx scripts/release_filtered_disposition_payloads.ts --apply    # release payloads
 *   options: --older-than-days 30 (minimum 30), --batch-size 500
 *
 * A FILTERED disposition is a posting the adapter runner chose not to stage. After the retention
 * window its raw payload is no longer needed for audit: the row keeps its payload hash, source
 * URL, external id, lane, reason code and detail. --apply sets raw_payload to NULL and stamps
 * raw_payload_released_at on FILTERED rows older than the window, in batches. STAGED, DUPLICATE,
 * QUARANTINED and ERROR rows and raw_job_observations are never touched (a table constraint also
 * forbids a NULL payload on them).
 *
 * The dry run runs in a READ ONLY transaction and only reports row counts and payload sizes.
 */
import pg from "pg";
import dotenv from "dotenv";

import { pgPoolConfig } from "../src/db/pgSsl.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

export const MINIMUM_RETENTION_DAYS = 30;

export interface ReleaseOptions {
  readonly apply: boolean;
  readonly olderThanDays: number;
  readonly batchSize: number;
}

export interface ReleaseSummary {
  readonly mode: "DRY_RUN" | "APPLY";
  readonly older_than_days: number;
  readonly eligible_rows: number;
  readonly eligible_payload_bytes: number;
  readonly eligible_by_source: ReadonlyArray<{ source_plugin_key: string; rows: number; payload_bytes: number }>;
  readonly filtered_rows_total: number;
  readonly filtered_rows_with_payload: number;
  readonly released_rows: number;
}

export function parseReleaseArgs(argv: readonly string[]): ReleaseOptions {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const olderThanDays = Number.parseInt(value("--older-than-days") ?? String(MINIMUM_RETENTION_DAYS), 10);
  if (!Number.isInteger(olderThanDays) || olderThanDays < MINIMUM_RETENTION_DAYS) {
    throw new Error(`--older-than-days must be a whole number of at least ${MINIMUM_RETENTION_DAYS}.`);
  }
  const batchSize = Number.parseInt(value("--batch-size") ?? "500", 10);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) {
    throw new Error("--batch-size must be a whole number between 1 and 5000.");
  }
  return { apply: argv.includes("--apply"), olderThanDays, batchSize };
}

const ELIGIBLE = `
  workspace_id = $1
  AND disposition = 'FILTERED'
  AND raw_payload IS NOT NULL
  AND fetched_at < NOW() - make_interval(days => $2::int)
`;

export async function releaseFilteredDispositionPayloads(
  client: pg.PoolClient,
  options: ReleaseOptions,
): Promise<ReleaseSummary> {
  if (!options.apply) await client.query("BEGIN READ ONLY");
  try {
    const workspace = await resolveWorkspaceContext(client);
    const bySource = await client.query<{ source_plugin_key: string; rows: number; payload_bytes: string }>(
      `SELECT source_plugin_key, COUNT(*)::int AS rows, COALESCE(SUM(pg_column_size(raw_payload)), 0)::bigint AS payload_bytes
       FROM source_candidate_dispositions
       WHERE ${ELIGIBLE}
       GROUP BY source_plugin_key
       ORDER BY source_plugin_key`,
      [workspace.workspaceId, options.olderThanDays],
    );
    const totals = await client.query<{ filtered_rows_total: number; filtered_rows_with_payload: number }>(
      `SELECT COUNT(*)::int AS filtered_rows_total,
              COUNT(*) FILTER (WHERE raw_payload IS NOT NULL)::int AS filtered_rows_with_payload
       FROM source_candidate_dispositions
       WHERE workspace_id = $1 AND disposition = 'FILTERED'`,
      [workspace.workspaceId],
    );
    const eligibleBySource = bySource.rows.map((row) => ({
      source_plugin_key: row.source_plugin_key,
      rows: Number(row.rows),
      payload_bytes: Number(row.payload_bytes),
    }));
    let released = 0;
    if (options.apply) {
      for (;;) {
        const batch = await client.query(
          `UPDATE source_candidate_dispositions
           SET raw_payload = NULL, raw_payload_released_at = NOW()
           WHERE id IN (
             SELECT id FROM source_candidate_dispositions
             WHERE ${ELIGIBLE}
             ORDER BY fetched_at, id
             LIMIT $3
           )`,
          [workspace.workspaceId, options.olderThanDays, options.batchSize],
        );
        released += batch.rowCount ?? 0;
        if ((batch.rowCount ?? 0) < options.batchSize) break;
      }
    } else {
      await client.query("ROLLBACK");
    }
    return {
      mode: options.apply ? "APPLY" : "DRY_RUN",
      older_than_days: options.olderThanDays,
      eligible_rows: eligibleBySource.reduce((total, row) => total + row.rows, 0),
      eligible_payload_bytes: eligibleBySource.reduce((total, row) => total + row.payload_bytes, 0),
      eligible_by_source: eligibleBySource,
      filtered_rows_total: Number(totals.rows[0]?.filtered_rows_total ?? 0),
      filtered_rows_with_payload: Number(totals.rows[0]?.filtered_rows_with_payload ?? 0),
      released_rows: released,
    };
  } catch (error) {
    if (!options.apply) await client.query("ROLLBACK");
    throw error;
  }
}

async function main(): Promise<void> {
  const options = parseReleaseArgs(process.argv.slice(2));
  const databaseUrl = String(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const pool = new pg.Pool(pgPoolConfig(databaseUrl));
  const client = await pool.connect();
  try {
    const summary = await releaseFilteredDispositionPayloads(client, options);
    console.log(JSON.stringify({
      ...summary,
      eligible_payload_mb: Number((summary.eligible_payload_bytes / 1024 / 1024).toFixed(1)),
      note: summary.mode === "DRY_RUN" ? "Dry run: nothing was changed. Re-run with --apply to release these payloads." : undefined,
    }, null, 2));
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1]?.includes("release_filtered_disposition_payloads")) {
  main().catch((error: unknown) => {
    console.error("FILTERED payload retention failed:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
