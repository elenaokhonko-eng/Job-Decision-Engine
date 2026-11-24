/**
 * Deactivates a stale embedding space (src/embeddings/staleSpaces.ts owns the query). Replay branch only.
 * Dry run by default. --apply needs EMBEDDING_SPACE_DEACTIVATE_ALLOWED=true and --confirm-workspace=<id>.
 */
import dotenv from "dotenv";
import pg from "pg";

import { pgConnectionConfig } from "../src/db/pgSsl.js";
import { deactivateStaleEmbeddingSpaces, embeddingSpacePreflight } from "../src/embeddings/staleSpaces.js";
import { requireApprovedReplayTarget } from "../src/reporting/replayGuard.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";

dotenv.config({ path: [".env.local", ".env"], quiet: true });
const argv = process.argv.slice(2);
const argValue = (name: string): string | undefined => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const apply = argv.includes("--apply");
const url = process.env.REPLAY_DATABASE_URL?.trim();
if (!url) throw new Error("REPLAY_DATABASE_URL is not set");

const client = new pg.Client(pgConnectionConfig(url));
await client.connect();
try {
  await client.query("BEGIN");
  const id = await client.query<{ d: string; b: string | null }>(`SELECT current_database() AS d, current_setting('neon.branch_id', TRUE) AS b`);
  requireApprovedReplayTarget(url, { databaseName: id.rows[0]!.d, branchId: id.rows[0]!.b }, process.env.REPLAY_BRANCH_ID);
  if (!process.env.REPLAY_BRANCH_ID || id.rows[0]!.b !== process.env.REPLAY_BRANCH_ID) throw new Error("Connected branch does not equal REPLAY_BRANCH_ID.");
  const context = await resolveWorkspaceContext(client as unknown as pg.PoolClient);
  if (apply) {
    if (process.env.EMBEDDING_SPACE_DEACTIVATE_ALLOWED !== "true") throw new Error("Refusing to apply: set EMBEDDING_SPACE_DEACTIVATE_ALLOWED=true after the owner approves the dry-run output.");
    if (argValue("confirm-workspace") !== context.workspaceId) throw new Error("Refusing to apply: --confirm-workspace must equal the resolved workspace id.");
  }
  console.log(`branch=${id.rows[0]!.b} workspace=${context.workspaceId} mode=${apply ? "APPLY" : "DRY RUN"}`);
  console.log(JSON.stringify(await embeddingSpacePreflight(client, context.workspaceId), null, 2));
  console.log(JSON.stringify(await deactivateStaleEmbeddingSpaces(client, { workspaceId: context.workspaceId, dryRun: !apply })));
  await client.query(apply ? "COMMIT" : "ROLLBACK");
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
