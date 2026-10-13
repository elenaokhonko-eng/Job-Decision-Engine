import type pg from "pg";
import { describe, expect, it } from "vitest";

import { listRecoveryCandidates } from "../../scripts/recover_zero_manual_review.js";

const context = {
  workspaceId: "workspace-id",
  workspaceKey: "default",
  userId: "user-id",
  userKey: "local_user",
  role: "OWNER" as const,
};

const limits = {
  policyNoMatch: 200,
  technicalDeferred: 50,
  workAuth: 50,
  rawStaged: 100,
};

describe("zero-manual-review recovery candidate discovery", () => {
  it("runs candidate queries serially on a single PostgreSQL client", async () => {
    let activeQueries = 0;
    let maximumConcurrentQueries = 0;
    let queryCount = 0;
    // The mock implements only the PoolClient query surface used by the helper.
    const client = {
      query: async (..._args: readonly unknown[]) => {
        activeQueries += 1;
        maximumConcurrentQueries = Math.max(maximumConcurrentQueries, activeQueries);
        queryCount += 1;
        await Promise.resolve();
        activeQueries -= 1;
        return { rows: [] };
      },
    } as unknown as pg.PoolClient;

    const candidates = await listRecoveryCandidates(client, context, limits);

    expect(queryCount).toBe(4);
    expect(maximumConcurrentQueries).toBe(1);
    expect(candidates).toEqual({
      policyNoMatch: [],
      technicalDeferred: [],
      workAuth: [],
      rawStaged: 0,
    });
  });
});
