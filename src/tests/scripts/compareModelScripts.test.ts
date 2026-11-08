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
  billableOutputTokens,
  classifyRunFailure,
  EVALUATION_SAMPLE_SQL,
  parseArgs,
  parsePrices,
  perJobReport,
  providerForModel,
  runModelComparison,
  summarizeModelComparisons,
  type EvaluationExecutionLike,
  type ModelRun,
  type SampleRow,
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

function sampleRow(index: number): SampleRow {
  return {
    canonical_job_id: `00000000-0000-4000-8000-00000000000${index}`,
    job_version_id: `10000000-0000-4000-8000-00000000000${index}`,
    normalized_title: `Synthetic role ${index}`,
    company_name: "Example Co",
    canonical_url: `https://jobs.example.test/${index}`,
    description_text: "Synthetic description.",
    primary_lane: "CORE_AI_DATA",
    workability_facts: {},
  };
}

function evaluation(model: string, nextAction: string, lane: string, usage: EvaluationExecutionLike["usage"], servedPath: string): EvaluationExecutionLike {
  return { model, servedPath, usage, evaluatedJob: { next_action: nextAction, primary_lane: lane, nd_score: 70 } };
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
  it("defaults to a dry run of 20 jobs comparing two Gemini models", () => {
    expect(parseArgs([], {})).toMatchObject({ run: false, limit: 20, models: ["gemini-3.6-flash", "gemini-2.5-flash"], noFlex: false });
    expect(parseArgs(["--run", "--limit", "5", "--model-b", "gemini-3.1-flash-lite"], {}))
      .toMatchObject({ run: true, limit: 5, models: ["gemini-3.6-flash", "gemini-3.1-flash-lite"] });
    expect(() => parseArgs(["--limit", "0"], {})).toThrow("--limit");
  });

  it("parses --models for Gemini and OpenAI models, with the first as the baseline", () => {
    const args = parseArgs(["--run", "--models", "gemini-3.6-flash,gpt-6.1-terra,gpt-6-luna", "--no-flex"], {});
    expect(args).toMatchObject({ run: true, models: ["gemini-3.6-flash", "gpt-6.1-terra", "gpt-6-luna"], noFlex: true, prices: {} });
    expect(args.models.map(providerForModel)).toEqual(["gemini", "openai", "openai"]);
    expect(() => parseArgs(["--models", "gemini-3.6-flash"], {})).toThrow("at least two");
    expect(() => parseArgs(["--models", "a,a"], {})).toThrow("more than once");
    expect(() => parseArgs(["--models", "a,b", "--model-a", "c"], {})).toThrow("not both");
    expect(() => parseArgs(["--models", "a,b c"], {})).toThrow("not valid");
    expect(() => parseArgs(["--models"], {})).toThrow("needs a value");
  });

  it("reads prices from flags or MODEL_PRICING_JSON and refuses incomplete entries", () => {
    expect(parsePrices('{"gemini:gemini-3.6-flash":{"input_per_1m":1,"output_per_1m":4},"openai:gpt-6-luna":{"inputPer1M":2,"outputPer1M":8}}'))
      .toEqual({ "gemini-3.6-flash": { inputPer1M: 1, outputPer1M: 4 }, "gpt-6-luna": { inputPer1M: 2, outputPer1M: 8 } });
    expect(() => parsePrices('{"gpt-6-luna":{"input_per_1m":1}}')).toThrow("output_per_1m");
    expect(() => parsePrices("not json")).toThrow("not valid JSON");
    expect(parseArgs(["--models", "a,b"], { MODEL_PRICING_JSON: '{"a":{"input_per_1m":1,"output_per_1m":2}}' }).prices)
      .toEqual({ a: { inputPer1M: 1, outputPer1M: 2 } });
    expect(() => parseArgs(["--prices", "{}", "--prices-file", "x.json"], {})).toThrow("not both");
  });

  it("counts Gemini thoughts as billable output but not OpenAI reasoning twice", () => {
    expect(billableOutputTokens({ ...run("REJECTED", {}, [10, 100]), reasoningTokens: 40, reasoningIncludedInCompletion: false })).toBe(140);
    expect(billableOutputTokens({ ...run("REJECTED", {}, [10, 100]), reasoningTokens: 40, reasoningIncludedInCompletion: true })).toBe(100);
    expect(billableOutputTokens(run(null, {}, null, false))).toBeNull();
  });

  it("runs every model on every job with fake providers and reports agreement, failures, tokens and cost", async () => {
    const calls: string[] = [];
    const schemaFailure = Object.assign(new Error("All model API calls failed."), {
      failures: [{ provider: "openai", model: "gpt-6-luna", kind: "VALIDATION", error: "next_action invalid" }],
    });
    const providerFailure = Object.assign(new Error("All model API calls failed."), {
      failures: [{ provider: "openai", model: "gpt-6.1-terra", kind: "OTHER", error: "HTTP 500" }],
    });
    const fakeEvaluate = async (row: SampleRow, model: string, provider: string) => {
      calls.push(`${row.canonical_job_id.slice(-1)}:${model}:${provider}`);
      const job = row.canonical_job_id.slice(-1);
      if (model === "gemini-3.6-flash") {
        return evaluation(model, job === "1" ? "PRIORITY_APPLY" : "REJECTED", "CORE_AI_DATA",
          { promptTokens: 1000, completionTokens: 200, reasoningTokens: 50, reasoningIncludedInCompletion: false }, "FLEX");
      }
      if (model === "gpt-6.1-terra") {
        if (job === "3") throw providerFailure;
        return evaluation(model, "PRIORITY_APPLY", job === "1" ? "CORE_AI_DATA" : "LEGAL_REGTECH",
          { promptTokens: 1000, completionTokens: 300, reasoningTokens: 100, reasoningIncludedInCompletion: true }, "OPENAI");
      }
      if (job === "2") throw schemaFailure;
      return evaluation(model, job === "1" ? "PRIORITY_APPLY" : "REJECTED", "CORE_AI_DATA",
        { promptTokens: 1000, completionTokens: 100, reasoningTokens: 20, reasoningIncludedInCompletion: true }, "OPENAI");
    };
    const models = ["gemini-3.6-flash", "gpt-6.1-terra", "gpt-6-luna"];
    const comparisons = await runModelComparison([sampleRow(1), sampleRow(2), sampleRow(3)], models, fakeEvaluate);
    expect(calls).toEqual([
      "1:gemini-3.6-flash:gemini", "1:gpt-6.1-terra:openai", "1:gpt-6-luna:openai",
      "2:gemini-3.6-flash:gemini", "2:gpt-6.1-terra:openai", "2:gpt-6-luna:openai",
      "3:gemini-3.6-flash:gemini", "3:gpt-6.1-terra:openai", "3:gpt-6-luna:openai",
    ]);

    const prices = {
      "gemini-3.6-flash": { inputPer1M: 1, outputPer1M: 10 },
      "gpt-6-luna": { inputPer1M: 2, outputPer1M: 4 },
    };
    const summary = summarizeModelComparisons(comparisons, models, prices);
    expect(summary).toMatchObject({ jobs: 3, baseline_model: "gemini-3.6-flash", unpriced_models: ["gpt-6.1-terra"] });
    const [gemini, terra, luna] = summary.models;
    expect(gemini).toMatchObject({
      provider: "gemini", is_baseline: true, succeeded: 3, failed: 0, next_action_agreement: 1, primary_lane_agreement: 1,
      prompt_tokens: 3000, completion_tokens: 600, reasoning_tokens: 150, billable_output_tokens: 750,
      served_paths: { FLEX: 3 }, priced: true,
    });
    // 3 x (1000 x $1 + 250 x $10) / 1M
    expect(gemini.cost_usd).toBeCloseTo(0.0105, 6);
    expect(terra).toMatchObject({
      provider: "openai", succeeded: 2, failed: 1, provider_failures: 1, schema_failures: 0,
      compared_with_baseline: 2, next_action_agreement: 0.5, primary_lane_agreement: 0.5,
      reasoning_tokens: 200, billable_output_tokens: 600, priced: false, cost_usd: null,
    });
    // One schema failure: the cost of the remaining calls is not presented as the model's cost.
    expect(luna).toMatchObject({
      succeeded: 2, failed: 1, schema_failures: 1, provider_failures: 0, compared_with_baseline: 2,
      next_action_agreement: 1, primary_lane_agreement: 1, priced: false, cost_usd: null,
    });

    const perJob = perJobReport(comparisons, models);
    expect(perJob[1]).toEqual({
      canonical_job_id: sampleRow(2).canonical_job_id,
      next_action: { "gemini-3.6-flash": "REJECTED", "gpt-6.1-terra": "PRIORITY_APPLY", "gpt-6-luna": null },
      primary_lane: { "gemini-3.6-flash": "CORE_AI_DATA", "gpt-6.1-terra": "LEGAL_REGTECH", "gpt-6-luna": null },
      failures: { "gpt-6-luna": { kind: "SCHEMA", error: expect.any(String) } },
    });
    // The report carries ids, outcomes and failure kinds only: no description or title text.
    expect(JSON.stringify({ summary, perJob })).not.toContain("Synthetic description");
    expect(JSON.stringify({ summary, perJob })).not.toContain("Synthetic role");
  });

  it("treats an answer from a different model as that model's failure", async () => {
    const comparisons = await runModelComparison([sampleRow(1)], ["gemini-3.6-flash", "gpt-6-luna"], async (_row, model) =>
      evaluation(model === "gpt-6-luna" ? "gpt-4o-mini" : model, "REJECTED", "CORE_AI_DATA", null, "OPENAI"));
    expect(comparisons[0].runs["gpt-6-luna"]).toMatchObject({ ok: false, failureKind: "ANSWERED_BY_OTHER_MODEL" });
    expect(classifyRunFailure(new Error("socket hang up"))).toBe("PROVIDER");
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
