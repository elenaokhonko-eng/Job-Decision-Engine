import { describe, expect, it } from "vitest";

import { assertDeactivationAllowed, type DeactivationGuardInput } from "../../embeddings/deactivationGuards.js";

const base: DeactivationGuardInput = {
  apply: true,
  env: { REPLAY_BRANCH_ID: "br-replay-1", EMBEDDING_SPACE_DEACTIVATE_ALLOWED: "true" },
  argv: ["--apply", "--confirm-workspace=ws-1"],
  connectedBranchId: "br-replay-1",
  workspaceId: "ws-1",
};

describe("deactivate_stale_embedding_spaces guards", () => {
  it("allows apply only when every guard holds", () => {
    expect(() => assertDeactivationAllowed(base)).not.toThrow();
  });
  it("refuses when REPLAY_BRANCH_ID is unset or differs from the connected branch (dry run too)", () => {
    expect(() => assertDeactivationAllowed({ ...base, apply: false, env: {} })).toThrow(/REPLAY_BRANCH_ID/);
    expect(() => assertDeactivationAllowed({ ...base, apply: false, connectedBranchId: "br-production" })).toThrow(/REPLAY_BRANCH_ID/);
    expect(() => assertDeactivationAllowed({ ...base, connectedBranchId: null })).toThrow(/REPLAY_BRANCH_ID/);
  });
  it("refuses apply without EMBEDDING_SPACE_DEACTIVATE_ALLOWED=true", () => {
    expect(() => assertDeactivationAllowed({ ...base, env: { REPLAY_BRANCH_ID: "br-replay-1" } })).toThrow(/EMBEDDING_SPACE_DEACTIVATE_ALLOWED/);
    expect(() => assertDeactivationAllowed({ ...base, env: { REPLAY_BRANCH_ID: "br-replay-1", EMBEDDING_SPACE_DEACTIVATE_ALLOWED: "yes" } })).toThrow(/EMBEDDING_SPACE_DEACTIVATE_ALLOWED/);
  });
  it("refuses apply without a matching --confirm-workspace", () => {
    expect(() => assertDeactivationAllowed({ ...base, argv: ["--apply"] })).toThrow(/--confirm-workspace/);
    expect(() => assertDeactivationAllowed({ ...base, argv: ["--apply", "--confirm-workspace=other"] })).toThrow(/--confirm-workspace/);
  });
  it("a dry run needs neither the env switch nor the confirmation", () => {
    expect(() => assertDeactivationAllowed({ ...base, apply: false, env: { REPLAY_BRANCH_ID: "br-replay-1" }, argv: [] })).not.toThrow();
  });
});
