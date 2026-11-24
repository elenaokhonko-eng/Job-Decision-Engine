/** Read-only replay report: every must-be-zero check (counts, sample ids) plus a diagnosis of the violators. Replay branch only. */
import dotenv from "dotenv";
import pg from "pg";

import { pgConnectionConfig } from "../src/db/pgSsl.js";
import { requireApprovedReplayTarget } from "../src/reporting/replayGuard.js";
import { runZeroChecks } from "../src/tasks/integrityZeroChecks.js";
import { diagnoseViolations } from "../src/tasks/zeroCheckRepair.js";
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
  const checks = await runZeroChecks(client, context.workspaceId, { phase: "pre" });
  console.log(`branch=${id.rows[0]!.b}`);
  for (const check of checks) console.log(JSON.stringify({ name: check.name, total: check.total, detail: check.detail }));
  const diagnoses = await diagnoseViolations(client, context.workspaceId, checks, ["rejected_job_with_recommendation", "routable_verification_job_stranded"]);
  for (const diagnosis of diagnoses) console.log(JSON.stringify(diagnosis));
} finally {
  await client.query("ROLLBACK").catch(() => undefined);
  await client.end();
}
