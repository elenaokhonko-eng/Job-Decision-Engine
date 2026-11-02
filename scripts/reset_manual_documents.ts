/**
 * Test-database tool: deletes the stored documents of the manual application route so the same
 * approval can generate them again (for example after a generator change). Drafts, approvals,
 * postings and profiles are kept.
 *
 *   npm run manual:reset-documents -- --confirm-database=<name of the database DATABASE_URL points at>
 *   npm run manual:reset-documents -- --confirm-database=<name> --draft=<draft id>   (one draft only)
 *
 * It refuses to run unless --confirm-database matches current_database(), so it cannot be pointed
 * at the wrong database by accident.
 */
import dotenv from "dotenv";
import pg from "pg";
import { pathToFileURL } from "node:url";

import { pgConnectionConfig } from "../src/db/pgSsl.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../src/workspace/context.js";

export interface ManualDocumentResetSummary {
  claims: number;
  artifacts: number;
  runs: number;
}

/** Deletes claims, artifacts and runs (in that order, as the foreign keys require) in one transaction. */
export async function resetManualDocuments(
  client: pg.PoolClient,
  ctx: WorkspaceContext,
  options: { draftId?: string } = {},
): Promise<ManualDocumentResetSummary> {
  const scope = `workspace_id = $1 AND approval_id IN (
    SELECT id FROM manual_application_preparation_approvals WHERE workspace_id = $1 AND ($2::uuid IS NULL OR draft_id = $2::uuid))`;
  const params = [ctx.workspaceId, options.draftId ?? null];
  await client.query("BEGIN");
  try {
    const claims = await client.query(
      `DELETE FROM manual_application_document_claims WHERE workspace_id = $1 AND manual_document_run_id IN (
         SELECT id FROM manual_application_document_runs WHERE ${scope})`, params);
    const artifacts = await client.query(`DELETE FROM manual_application_document_artifacts WHERE ${scope}`, params);
    const runs = await client.query(`DELETE FROM manual_application_document_runs WHERE ${scope}`, params);
    await client.query("COMMIT");
    return { claims: claims.rowCount ?? 0, artifacts: artifacts.rowCount ?? 0, runs: runs.rowCount ?? 0 };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

async function main(): Promise<void> {
  dotenv.config();
  dotenv.config({ path: ".env.local" });
  const confirmed = argument("confirm-database");
  const draftId = argument("draft");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set.");
  const pool = new pg.Pool(pgConnectionConfig(process.env.DATABASE_URL));
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ name: string }>("SELECT current_database() AS name");
    const database = rows[0].name;
    if (confirmed !== database) {
      throw new Error(`Refusing to delete: DATABASE_URL points at database "${database}". Re-run with --confirm-database=${database} if that is your test database.`);
    }
    const ctx = await resolveWorkspaceContext(client);
    const summary = await resetManualDocuments(client, ctx, { draftId });
    console.log(`Deleted stored manual documents in "${database}"${draftId ? ` for draft ${draftId}` : ""}: `
      + `${summary.runs} runs, ${summary.artifacts} files, ${summary.claims} claims. Drafts and approvals are kept; press Generate again.`);
  } finally {
    client.release();
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
