import pg from "pg";
import { pgPoolConfig } from "../src/db/pgSsl.js";
import { preflightApplicationDocumentDraft } from "../src/documents/applicationDocumentPreflight.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requiredUuid(value: string | undefined, name: string): string {
  if (!value || !UUID_PATTERN.test(value)) throw new Error(`A valid ${name} UUID is required.`);
  return value;
}

async function main(): Promise<void> {
  const applicationRecordId = requiredUuid(process.argv[2], "application record");
  const canonicalJobId = requiredUuid(process.argv[3], "canonical job");
  const jobVersionId = requiredUuid(process.argv[4], "job version");
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required for application draft validation.");

  const pool = new pg.Pool(pgPoolConfig(databaseUrl));
  const client = await pool.connect();
  let transactionStarted = false;
  try {
    const context = await resolveWorkspaceContext(client);
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query("SET TRANSACTION READ ONLY");

    const result = await preflightApplicationDocumentDraft(client, context, {
      applicationRecordId,
      canonicalJobId,
      jobVersionId,
    });
    await client.query("COMMIT");
    transactionStarted = false;
    console.log(JSON.stringify({ event: "APPLICATION_DOCUMENT_PREFLIGHT_PASSED", ...result }));
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error("Application draft preflight failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
