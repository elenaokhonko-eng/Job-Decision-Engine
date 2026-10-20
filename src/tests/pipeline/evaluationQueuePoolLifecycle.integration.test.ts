import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import pg from "pg";
import dotenv from "dotenv";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const databaseUrl = process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);

let databasePool: pg.Pool | undefined;
let databaseClient: pg.PoolClient | undefined;
let context: WorkspaceContext | undefined;

function getDatabaseClient(): pg.PoolClient {
  if (!databaseClient) throw new Error("The evaluation queue lifecycle database client is not initialized.");
  return databaseClient;
}

function getContext(): WorkspaceContext {
  if (!context) throw new Error("The evaluation queue lifecycle workspace is not initialized.");
  return context;
}

describe.skipIf(skipReal)("evaluation queue pool lifecycle (PostgreSQL)", () => {
  beforeAll(async () => {
    databasePool = new pg.Pool(pgConnectionConfig(databaseUrl));
    databaseClient = await databasePool.connect();
    await runMigrations(databaseClient);
    context = await resolveWorkspaceContext(databaseClient);
  });

  afterAll(async () => {
    databaseClient?.release();
    await databasePool?.end();
  });

  it("reuses the worker pool across retry passes and closes it once from the caller", async () => {
    const previousGeminiKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = previousGeminiKey || "pool-lifecycle-test-key";
    const poolEndSpy = vi.spyOn(pg.Pool.prototype, "end");
    let closePool: (() => Promise<void>) | undefined;

    try {
      const [{ evaluateQueue, closeEvaluationQueuePool }, { runEvaluationQueueWithExitPolicy }] = await Promise.all([
        import("../../../scripts/evaluate_queue.js"),
        import("../../pipeline/evaluationQueueExitPolicy.js"),
      ]);
      closePool = closeEvaluationQueuePool;
      const options = {
        context: getContext(),
        profileVersionId: crypto.randomUUID(),
        jobVersionIds: [crypto.randomUUID()],
        limit: 1,
      };

      for (let retryPass = 0; retryPass < 2; retryPass += 1) {
        const outcome = await runEvaluationQueueWithExitPolicy(
          () => evaluateQueue(options),
          false,
        );
        expect(outcome.ok).toBe(true);
        if (outcome.ok) {
          expect(outcome.stats).toMatchObject({ processed: 0, failed: 0, eligible: 0 });
        }
        expect(poolEndSpy).not.toHaveBeenCalled();
      }

      await expect(Promise.all([
        closeEvaluationQueuePool(),
        closeEvaluationQueuePool(),
      ])).resolves.toEqual([undefined, undefined]);
      expect(poolEndSpy).toHaveBeenCalledTimes(1);
      await expect(closeEvaluationQueuePool()).resolves.toBeUndefined();
      expect(poolEndSpy).toHaveBeenCalledTimes(1);
    } finally {
      if (closePool) await closePool();
      if (previousGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousGeminiKey;
      vi.restoreAllMocks();
    }
  });
});
