/**
 * Read-only replay report: live jobs whose active requirement set has a requirement with no embedding
 * input row, by outcome and state (counts only). Replay branch only; the guard runs first.
 */
import dotenv from "dotenv";
import pg from "pg";

import { pgConnectionConfig } from "../src/db/pgSsl.js";
import { reportJobsMissingRequirementInputs } from "../src/embeddings/missingInputReport.js";
import { requireApprovedReplayTarget } from "../src/reporting/replayGuard.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";

dotenv.config({ path: [".env.local", ".env"], quiet: true });
const url = process.env.REPLAY_DATABASE_URL?.trim();
if (!url) throw new Error("REPLAY_DATABASE_URL is not set");
const client = new pg.Client(pgConnectionConfig(url));
await client.connect();
try {
  await client.query("BEGIN READ ONLY");
  const id = await client.query<{ d: string; b: string | null }>(`SELECT current_database() AS d, current_setting('neon.branch_id', TRUE) AS b`);
  requireApprovedReplayTarget(url, { databaseName: id.rows[0]!.d, branchId: id.rows[0]!.b }, process.env.REPLAY_BRANCH_ID);
  if (!process.env.REPLAY_BRANCH_ID || id.rows[0]!.b !== process.env.REPLAY_BRANCH_ID) throw new Error("Connected branch does not equal REPLAY_BRANCH_ID.");
  const context = await resolveWorkspaceContext(client as unknown as pg.PoolClient);
  console.log(`branch=${id.rows[0]!.b} workspace=${context.workspaceId}`);
  console.log(JSON.stringify(await reportJobsMissingRequirementInputs(client, context.workspaceId), null, 2));
} finally {
  await client.query("ROLLBACK").catch(() => undefined);
  await client.end();
}
