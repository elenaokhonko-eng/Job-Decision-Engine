import pg from "pg";
import dotenv from "dotenv";

import { pgPoolConfig } from "../src/db/pgSsl.js";
import { materializeApplicationRankings } from "../src/services/applicationRankingMaterializer.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is required.");

  const pool = new pg.Pool(pgPoolConfig(databaseUrl));
  try {
    const context = await resolveWorkspaceContext(pool);
    const dryRun = process.argv.includes("--dry-run");
    const result = await materializeApplicationRankings(pool, context.workspaceId, { dryRun });
    console.log(JSON.stringify(result, null, 2));
    if (result.missingCurrentEvaluations > 0 || result.incompleteRequiredInputs > 0) {
      console.warn(
        "Some Apply Now jobs remain outside Top 10 until their exact current evaluation and required ranking inputs are available."
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error("Application ranking materialization failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
