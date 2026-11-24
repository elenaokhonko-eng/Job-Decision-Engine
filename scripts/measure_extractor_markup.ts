/**
 * Read-only: how many requirement quotes contain markup before and after the
 * posting cleaner is put in front of the deterministic extractor. Prints counts
 * only. One BEGIN READ ONLY transaction (opened in src/reporting), always rolled
 * back. Run it on a copy.
 *
 *   npx tsx scripts/measure_extractor_markup.ts
 */
import dotenv from "dotenv";

import { STAGE1_3_STAGING_IDENTITY_EXPECTATIONS } from "../src/db/stagingDatabaseIdentity.js";
import { measureQuoteMarkupFromDatabase } from "../src/reporting/extractorInputMarkup.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set. Set it in the environment or .env.local.");
    process.exit(1);
  }
  const host = new URL(databaseUrl).hostname.toLowerCase();
  const knownProduction = STAGE1_3_STAGING_IDENTITY_EXPECTATIONS.knownProductionHostnames.some(
    (candidate) => host === candidate || host.replace("-pooler", "") === candidate,
  );
  console.error(`Database host: ${host}${knownProduction ? " (production branch: read-only transaction enforced)" : ""}`);
  console.log(JSON.stringify(await measureQuoteMarkupFromDatabase(databaseUrl), null, 2));
}

main().catch((error) => {
  console.error(`Measurement failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
