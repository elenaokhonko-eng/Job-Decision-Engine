import pg from "pg";
import dotenv from "dotenv";
import { pgConnectionConfig } from "../src/db/pgSsl.js";
import { repairProfileEmbeddings } from "../src/embeddings/profileEmbeddingRepair.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const unknownArgs = [...args].filter((arg) => !["--apply", "--dry-run", "--help"].includes(arg));
  if (unknownArgs.length > 0) throw new Error(`Unknown argument(s): ${unknownArgs.join(", ")}`);
  if (args.has("--help")) {
    console.log("Usage: npm run embeddings:repair-profile [--dry-run | --apply]");
    return;
  }
  if (args.has("--apply") && args.has("--dry-run")) {
    throw new Error("Choose either --dry-run or --apply; the flags cannot be combined.");
  }
  if (!process.env.DATABASE_URL?.trim()) throw new Error("DATABASE_URL is required.");

  const pool = new pg.Pool(pgConnectionConfig(process.env.DATABASE_URL));
  try {
    const result = await repairProfileEmbeddings(pool, { apply: args.has("--apply") });
    console.log(JSON.stringify(result, null, 2));
    if (result.dryRun) {
      console.log("Dry run only. Re-run with --apply to build and publish missing primary profile embeddings.");
    }
    if (result.status !== "READY" && args.has("--apply")) {
      throw new Error(`Profile embedding repair ended with status ${result.status}.`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error("Profile embedding repair failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
