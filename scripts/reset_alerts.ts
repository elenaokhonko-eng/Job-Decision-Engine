import pg from "pg";
import dotenv from "dotenv";
import { resolveWorkspaceContext } from "../src/workspace/context.js";
import { pgConnectionConfig } from "../src/db/pgSsl.js";
dotenv.config();
dotenv.config({ path: ".env.local" });

const pool = new pg.Pool(pgConnectionConfig(process.env.DATABASE_URL));

async function main() {
  const ctx = await resolveWorkspaceContext(pool as any);
  await pool.query(
    "UPDATE raw_email_alerts SET processed = FALSE WHERE workspace_id = $1 AND processed_at >= NOW() - INTERVAL '1 hour'",
    [ctx.workspaceId]
  );
  console.log("Reset processed flag.");
  process.exit(0);
}
main();
