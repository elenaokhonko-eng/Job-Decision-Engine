import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import pg from "pg";
import dotenv from "dotenv";

import {
  cosineSimilarity,
  EMBEDDING_SAMPLE_SQL,
  summarizeEmbeddingComparisons,
} from "../../../scripts/compare_embedding_backends.js";
import {
  EVALUATION_SAMPLE_SQL,
  parseArgs,
  parsePrices,
  summarizeComparisons,
  type JobComparison,
  type ModelRun,
} from "../../../scripts/compare_evaluation_models.js";
import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { resolveWorkspaceContext } from "../../workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

function run(nextAction: string | null, scores: Record<string, number | null>, tokens: [number, number] | null, ok = true): ModelRun {
  return {
    ok, nextAction, primaryLane: "CORE_AI_DATA", scores,
    promptTokens: tokens ? tokens[0] : null, completionTokens: tokens ? tokens[1] : null,
  };
}

describe("compare_embedding_backends", () => {
  it("computes cosine similarity and flags anything under 0.999", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 12);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 12);
    expect(() => cosineSimilarity([1], [1, 2])).toThrow("lengths differ");
    expect(() => cosineSimilarity([0, 0], [1, 2])).toThrow("zero length");
    const summary = summarizeEmbeddingComparisons([
      { embedding_input_id: "a", cosine: 0.9999, flagged: false },
      { embedding_input_id: "b", cosine: 0.99, flagged: true },
      { embedding_input_id: "c", cosine: null, flagged: false, error: "HTTP 429" },
    ]);
    expect(summary).toMatchObject({ compared: 3, embedded: 2, failed: 1, flagged_below_threshold: 1, min_cosine: 0.99, ok: false });
    expect(summarizeEmbeddingComparisons([]).ok).toBe(false);
  });
});

describe("compare_evaluation_models", () => {
  it("is a dry run of 20 jobs comparing gemini-3.6-flash with gemini-2.5-flash unless told otherwise", () => {
    expect(parseArgs([])).toMatchObject({ run: false, limit: 20, modelA: "gemini-3.6-flash", modelB: "gemini-2.5-flash" });
    expect(parseArgs(["--run", "--limit", "5", "--model-b", "gemini-3.1-flash-lite"])).toMatchObject({ run: true, limit: 5, modelB: "gemini-3.1-flash-lite" });
    expect(() => parseArgs(["--limit", "0"])).toThrow("--limit");
    expect(parsePrices('{"gemini:gemini-3.6-flash":{"input_per_1m":1,"output_per_1m":4}}')).toEqual({ "gemini-3.6-flash": { inputPer1M: 1, outputPer1M: 4 } });
  });

  it("reports outcome agreement, score deltas, tokens and the cost difference", () => {
    const comparisons: JobComparison[] = [
      { canonicalJobId: "j1", jobVersionId: "v1", a: run("PRIORITY_APPLY", { nd_score: 80 }, [1000, 200]), b: run("PRIORITY_APPLY", { nd_score: 70 }, [1000, 100]) },
      { canonicalJobId: "j2", jobVersionId: "v2", a: run("REJECTED", { nd_score: 20 }, [1000, 200]), b: run("LOW_STRATEGIC_VALUE", { nd_score: 30 }, [1000, 100]) },
      { canonicalJobId: "j3", jobVersionId: "v3", a: run("REJECTED", {}, [1000, 200]), b: run(null, {}, null, false) },
    ];
    const prices = { a: { inputPer1M: 1, outputPer1M: 10 }, b: { inputPer1M: 0.5, outputPer1M: 2 } };
    const summary = summarizeComparisons(comparisons, { a: "a", b: "b" }, prices);
    expect(summary).toMatchObject({ jobs: 3, compared_both_ok: 2, next_action_agreement: 0.5, primary_lane_agreement: 1 });
    expect(summary.score_deltas.nd_score).toEqual({ compared: 2, mean_abs_delta: 10, max_abs_delta: 10 });
    expect(summary.model_a).toMatchObject({ succeeded: 3, failed: 0, prompt_tokens: 3000, completion_tokens: 600, cost_usd: 0.009 });
    // One model-b call failed, so its cost is not claimed.
    expect(summary.model_b).toMatchObject({ succeeded: 2, failed: 1, cost_usd: null });
    expect(summary.cost_difference_usd_b_minus_a).toBeNull();
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);

describe.skipIf(skipReal)("comparison scripts read the current schema (PostgreSQL)", () => {
  let pool: pg.Pool | undefined;
  let client: pg.PoolClient | undefined;
  let schemaName = "";

  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `compare_scripts_${crypto.randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
  }, 120_000);

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  it("runs both sample queries inside a READ ONLY transaction", async () => {
    const database = client!;
    const context = await resolveWorkspaceContext(database);
    await database.query("BEGIN READ ONLY");
    try {
      const embeddings = await database.query(EMBEDDING_SAMPLE_SQL, [context.workspaceId, "gemini-embedding-001", 768, 20]);
      const evaluations = await database.query(EVALUATION_SAMPLE_SQL, [context.workspaceId, 20]);
      expect(Array.isArray(embeddings.rows)).toBe(true);
      expect(Array.isArray(evaluations.rows)).toBe(true);
    } finally {
      await database.query("ROLLBACK");
    }
  });
});
