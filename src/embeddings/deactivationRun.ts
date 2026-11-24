/**
 * Body of scripts/deactivate_stale_embedding_spaces.ts, kept in src/ so the wiring is testable: the replay
 * session is never read-only (a dry run rolls back), and `commit` and `confirm` are both exactly `apply`.
 *
 * Layering: deactivateStaleEmbeddingSpaces enforces only `confirm: true` at library level. The branch and
 * environment guards (REPLAY_BRANCH_ID match, EMBEDDING_SPACE_DEACTIVATE_ALLOWED, --confirm-workspace) live
 * here, in the script path, and run before any space is read.
 */
import { withReplaySession, type ReplaySession } from "../reporting/replaySession.js";
import { assertDeactivationAllowed } from "./deactivationGuards.js";
import { deactivateStaleEmbeddingSpaces, embeddingSpacePreflight, type DeactivateStaleSpacesResult } from "./staleSpaces.js";

export type SessionRunner = <T>(options: { readOnly: boolean; commit?: boolean }, run: (session: ReplaySession) => Promise<T>) => Promise<T>;

export async function runStaleSpaceDeactivation(
  input: { apply: boolean; argv: readonly string[]; env: Readonly<Record<string, string | undefined>> },
  session: SessionRunner = (options, run) => withReplaySession(options, run, input.env),
  log: (line: string) => void = console.log,
): Promise<DeactivateStaleSpacesResult> {
  return session({ readOnly: false, commit: input.apply }, async ({ client, branchId, workspaceId }) => {
    assertDeactivationAllowed({ apply: input.apply, env: input.env, argv: input.argv, connectedBranchId: branchId, workspaceId });
    log(`branch=${branchId} workspace=${workspaceId} mode=${input.apply ? "APPLY" : "DRY RUN"}`);
    log(JSON.stringify(await embeddingSpacePreflight(client, workspaceId), null, 2));
    const result = await deactivateStaleEmbeddingSpaces(client, { workspaceId, dryRun: !input.apply, confirm: input.apply });
    log(JSON.stringify(result));
    return result;
  });
}
