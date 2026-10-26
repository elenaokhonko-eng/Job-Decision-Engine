import fs from "node:fs";
import dotenv from "dotenv";
import pg from "pg";
import { pgPoolConfig } from "../src/db/pgSsl.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";
import {
  buildPostingDuplicateAuditReport,
  type PostingDuplicateRecord,
} from "../src/ingestion/postingDuplicateAudit.js";

dotenv.config();
dotenv.config({ path: ".env.local", override: true });

interface DuplicateCandidateRow extends pg.QueryResultRow {
  workspace_id: string;
  canonical_job_id: string;
  job_version_id: string;
  source_posting_identity_hash: string;
  company_name: string;
  location: string | null;
  canonical_created_at: Date | string;
  current_version_observation_count: number | string;
}

function optionValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function parseWorkspaceId(value: string | null): string | null {
  if (value === null) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("--workspace-id must be a UUID.");
  }
  return value;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for this read-only duplicate audit.");
  const workspaceOption = optionValue("--workspace-id");
  const outputOption = optionValue("--output");
  if (process.argv.includes("--workspace-id") && !workspaceOption) throw new Error("--workspace-id requires a UUID value.");
  if (process.argv.includes("--output") && !outputOption) throw new Error("--output requires a file path.");
  const requestedWorkspaceId = parseWorkspaceId(workspaceOption);
  const allWorkspaces = process.argv.includes("--all-workspaces");
  if (requestedWorkspaceId && allWorkspaces) {
    throw new Error("Use either --workspace-id or --all-workspaces, not both.");
  }

  const pool = new pg.Pool(pgPoolConfig(databaseUrl));
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const workspaceId = requestedWorkspaceId
      ?? (allWorkspaces ? null : (await resolveWorkspaceContext(client)).workspaceId);
    const { rows } = await client.query<DuplicateCandidateRow>(
      `WITH duplicate_identities AS (
         SELECT workspace_id, source_posting_identity_hash
         FROM job_versions
         WHERE source_posting_identity_hash IS NOT NULL
           AND ($1::uuid IS NULL OR workspace_id = $1::uuid)
         GROUP BY workspace_id, source_posting_identity_hash
         HAVING COUNT(DISTINCT canonical_job_id) > 1
       )
       SELECT
         canonical.workspace_id::text AS workspace_id,
         canonical.id::text AS canonical_job_id,
         version.id::text AS job_version_id,
         version.source_posting_identity_hash,
         canonical.company_name,
         COALESCE(canonical.location, canonical.location_summary) AS location,
         canonical.created_at AS canonical_created_at,
         COUNT(observation.id)::integer AS current_version_observation_count
       FROM duplicate_identities duplicate
       JOIN canonical_jobs canonical
         ON canonical.workspace_id = duplicate.workspace_id
       JOIN job_versions version
         ON version.workspace_id = canonical.workspace_id
        AND version.canonical_job_id = canonical.id
        AND version.id = canonical.latest_job_version_id
        AND version.source_posting_identity_hash = duplicate.source_posting_identity_hash
       LEFT JOIN raw_job_observations observation
         ON observation.workspace_id = version.workspace_id
        AND observation.job_version_id = version.id
       GROUP BY
         canonical.workspace_id, canonical.id, version.id,
         version.source_posting_identity_hash, canonical.company_name,
         canonical.location, canonical.location_summary, canonical.created_at
       ORDER BY canonical.workspace_id, version.source_posting_identity_hash,
                canonical.company_name, canonical.location, canonical.id`,
      [workspaceId],
    );
    await client.query("ROLLBACK");

    const records: PostingDuplicateRecord[] = rows.map((row) => ({
      ...row,
      canonical_created_at: row.canonical_created_at instanceof Date
        ? row.canonical_created_at.toISOString()
        : String(row.canonical_created_at),
      current_version_observation_count: Number(row.current_version_observation_count),
    }));
    const report = buildPostingDuplicateAuditReport(records);
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (outputOption) fs.writeFileSync(outputOption, output, { encoding: "utf8", flag: "wx" });
    process.stdout.write(output);
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The transaction may already be closed; preserve the original failure.
    }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`Posting duplicate audit failed: ${detail}`);
  process.exitCode = 1;
});
