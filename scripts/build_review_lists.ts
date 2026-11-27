/**
 * Builds the next review lists from a replay copy, read only, and scores a filled sheet. No environment file is loaded.
 * Rules: src/modules/decision/. Wiring and guard: src/app/reviewLists.ts.
 *
 *   npx tsx scripts/build_review_lists.ts [--private-dir=<dir named private>] [--design=<file>] [--name=<label>]
 *     [--seed=<text>] [--replace]              # needs REPLAY_DATABASE_URL and REPLAY_BRANCH_ID
 *   npx tsx scripts/build_review_lists.ts --score --sheet=<filled sheet> --key=<key file>
 */
import { ReviewListsRefusal, runReviewListsCommand } from "../src/app/reviewLists.js";
import { publicErrorSummary } from "../src/security/publicErrorSummary.js";

try {
  await runReviewListsCommand(process.argv.slice(2), process.env);
} catch (error) {
  // Our own refusals and file errors are written for the owner; anything else is reduced so no host or setting is printed.
  const readable = error instanceof ReviewListsRefusal ||
    (error instanceof Error && /^(Refusing|The ranking design|Key file|Rows with|The filled sheet|REPLAY_)/.test(error.message));
  console.error(readable ? (error as Error).message : publicErrorSummary(error, "pipeline"));
  process.exitCode = 1;
}
