/**
 * Read-only replay report: live jobs whose active requirement set has a VALIDATED requirement not embedded
 * in the primary space, by outcome and state (counts only). Replay branch only; the guard runs first.
 */
import dotenv from "dotenv";

import { reportJobsMissingRequirementInputs } from "../src/embeddings/missingInputReport.js";
import { withReplaySession } from "../src/reporting/replaySession.js";

dotenv.config({ path: [".env.local", ".env"], quiet: true });
await withReplaySession({ readOnly: true }, async ({ client, branchId, workspaceId }) => {
  console.log(`branch=${branchId} workspace=${workspaceId}`);
  console.log(JSON.stringify(await reportJobsMissingRequirementInputs(client, workspaceId), null, 2));
});
