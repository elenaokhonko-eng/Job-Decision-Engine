/**
 * Same-day availability check of a chosen job list. Replay copy only (REPLAY_DATABASE_URL, REPLAY_BRANCH_ID).
 * Each posting link is read once; LinkedIn, aggregator and job-board links are left out and counted.
 * Rules: src/tasks/manualAvailabilityCheck.ts.
 *
 *   npx tsx scripts/check_availability_now.ts --jobs=<file>            # PLAN (default): no request, no write
 *
 * APPLY (only after the owner confirms the plan):
 *   AVAILABILITY_CHECK_APPLY_ALLOWED=true npx tsx scripts/check_availability_now.ts --jobs=<file> --apply \
 *     --confirm-workspace=<workspace uuid>
 */
import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });

// DATABASE_URL is never used: whatever the code underneath reads can only be the replay copy.
const replayUrl = process.env.REPLAY_DATABASE_URL?.trim() ?? "";
process.env.DATABASE_URL = replayUrl;
process.env.DATABASE_URL_UNPOOLED = replayUrl;

const { AvailabilityCheckRefusal, runAvailabilityCheckCommand } = await import("../src/tasks/manualAvailabilityCheck.js");
const { publicErrorSummary } = await import("../src/security/publicErrorSummary.js");
try {
  process.exitCode = await runAvailabilityCheckCommand(process.argv.slice(2), process.env);
} catch (error) {
  // Our refusals are printed as written; anything else is reduced so no host name or setting is printed.
  console.error(error instanceof AvailabilityCheckRefusal ? error.message : publicErrorSummary(error, "pipeline"));
  process.exitCode = 1;
}
