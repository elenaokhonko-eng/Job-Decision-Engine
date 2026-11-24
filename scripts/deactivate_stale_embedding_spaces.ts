/**
 * Deactivates a stale embedding space (src/embeddings/staleSpaces.ts owns the query). Replay branch only.
 * Dry run by default. The function itself also refuses to apply without confirm: true.
 * --apply needs EMBEDDING_SPACE_DEACTIVATE_ALLOWED=true and --confirm-workspace=<id>.
 */
import dotenv from "dotenv";

import { assertDeactivationAllowed } from "../src/embeddings/deactivationGuards.js";
import { deactivateStaleEmbeddingSpaces, embeddingSpacePreflight } from "../src/embeddings/staleSpaces.js";
import { withReplaySession } from "../src/reporting/replaySession.js";

dotenv.config({ path: [".env.local", ".env"], quiet: true });
const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
await withReplaySession({ readOnly: false, commit: apply }, async ({ client, branchId, workspaceId }) => {
  assertDeactivationAllowed({ apply, env: process.env, argv, connectedBranchId: branchId, workspaceId });
  console.log(`branch=${branchId} workspace=${workspaceId} mode=${apply ? "APPLY" : "DRY RUN"}`);
  console.log(JSON.stringify(await embeddingSpacePreflight(client, workspaceId), null, 2));
  console.log(JSON.stringify(await deactivateStaleEmbeddingSpaces(client, { workspaceId, dryRun: !apply, confirm: apply })));
});
