import { describe, expect, it } from "vitest";

import { runStaleSpaceDeactivation, type SessionRunner } from "../../embeddings/deactivationRun.js";

// A session whose client must never be queried: the guards have to refuse first.
function recordingSession() {
  const calls: Array<{ readOnly: boolean; commit?: boolean }> = [];
  const session: SessionRunner = async (options, run) => {
    calls.push(options);
    const client = { query: async () => { throw new Error("the client must not be queried before the guards pass"); } };
    return run({ client: client as never, branchId: "br-replay-1", workspaceId: "ws-1" });
  };
  return { calls, session };
}
const env = { REPLAY_BRANCH_ID: "br-replay-1", EMBEDDING_SPACE_DEACTIVATE_ALLOWED: "true" };

describe("scripts/deactivate_stale_embedding_spaces wiring", () => {
  it("passes commit equal to apply, and the session is never read-only (a dry run rolls back)", async () => {
    for (const apply of [false, true]) {
      const { calls, session } = recordingSession();
      await runStaleSpaceDeactivation({ apply, argv: apply ? ["--apply"] : [], env: { REPLAY_BRANCH_ID: "br-other" } }, session, () => undefined).catch(() => undefined);
      expect(calls).toEqual([{ readOnly: false, commit: apply }]);
    }
  });
  it("apply without the env switch or --confirm-workspace is refused before any query", async () => {
    const noEnv = recordingSession();
    await expect(runStaleSpaceDeactivation({ apply: true, argv: ["--apply", "--confirm-workspace=ws-1"], env: { REPLAY_BRANCH_ID: "br-replay-1" } }, noEnv.session, () => undefined)).rejects.toThrow(/EMBEDDING_SPACE_DEACTIVATE_ALLOWED/);
    const noConfirm = recordingSession();
    await expect(runStaleSpaceDeactivation({ apply: true, argv: ["--apply"], env }, noConfirm.session, () => undefined)).rejects.toThrow(/--confirm-workspace/);
  });
  it("a connected branch that differs from REPLAY_BRANCH_ID is refused, dry run included", async () => {
    const { session } = recordingSession();
    await expect(runStaleSpaceDeactivation({ apply: false, argv: [], env: { REPLAY_BRANCH_ID: "br-other" } }, session, () => undefined)).rejects.toThrow(/REPLAY_BRANCH_ID/);
  });
});
