import crypto from "node:crypto";

import dotenv from "dotenv";
import pg from "pg";

import { pgConnectionConfig } from "../src/db/pgSsl.js";
import { isProfileFactModelShareable } from "../src/profile/privacy.js";
import { publicErrorSummary } from "../src/security/publicErrorSummary.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

/**
 * Offline A/B of two evaluation models on the same current evaluated jobs.
 *
 *   npx tsx scripts/compare_evaluation_models.ts                 # dry run: lists the sample only
 *   npx tsx scripts/compare_evaluation_models.ts --run [--limit 20]
 *     [--model-a gemini-3.6-flash] [--model-b gemini-2.5-flash]
 *     [--prices '{"gemini-3.6-flash":{"input_per_1m":0.3,"output_per_1m":2.5}, ...}']
 *
 * Reads the database inside a READ ONLY transaction and writes nothing: no ai_evaluations rows,
 * no queue changes, no model-route invocation records. Both models are called through the normal
 * strict evaluation path (schema + job-identity validation) with OpenAI fallback disabled, so a
 * model failure is reported as such. The report holds ids, outcomes, score deltas, token counts and
 * cost estimates; never prompts, descriptions or profile text.
 */

const SCORE_FIELDS = [
  "nd_score", "nd_friendly_score", "politics_stress_score", "focus_protection_score",
  "strategic_value_score", "technical_depth_score", "role_ownership_score",
] as const;

export interface ModelPrice {
  inputPer1M: number;
  outputPer1M: number;
}

export interface ModelRun {
  ok: boolean;
  nextAction: string | null;
  primaryLane: string | null;
  scores: Record<string, number | null>;
  promptTokens: number | null;
  completionTokens: number | null;
  error?: string;
}

export interface JobComparison {
  canonicalJobId: string;
  jobVersionId: string;
  a: ModelRun;
  b: ModelRun;
}

export function parseArgs(argv: string[]) {
  const value = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const limit = Number.parseInt(value("--limit") ?? "20", 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("--limit must be an integer from 1 to 200.");
  return {
    run: argv.includes("--run"),
    limit,
    modelA: value("--model-a") ?? "gemini-3.6-flash",
    modelB: value("--model-b") ?? "gemini-2.5-flash",
    prices: parsePrices(value("--prices") ?? process.env.MODEL_PRICING_JSON ?? ""),
  };
}

export function parsePrices(raw: string): Record<string, ModelPrice> {
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as Record<string, Record<string, unknown>>;
  const prices: Record<string, ModelPrice> = {};
  for (const [model, entry] of Object.entries(parsed)) {
    const input = Number(entry?.input_per_1m ?? entry?.inputPer1M);
    const output = Number(entry?.output_per_1m ?? entry?.outputPer1M);
    if (Number.isFinite(input) && Number.isFinite(output)) {
      prices[model.replace(/^gemini:/, "")] = { inputPer1M: input, outputPer1M: output };
    }
  }
  return prices;
}

function costUsd(run: ModelRun, price: ModelPrice | undefined): number | null {
  if (!price || run.promptTokens === null || run.completionTokens === null) return null;
  return (run.promptTokens / 1e6) * price.inputPer1M + (run.completionTokens / 1e6) * price.outputPer1M;
}

/** Agreement on the recommendation outcome, mean absolute score deltas, tokens and cost. */
export function summarizeComparisons(
  comparisons: JobComparison[],
  models: { a: string; b: string },
  prices: Record<string, ModelPrice>,
) {
  const both = comparisons.filter((item) => item.a.ok && item.b.ok);
  const agree = both.filter((item) => item.a.nextAction === item.b.nextAction).length;
  const laneAgree = both.filter((item) => item.a.primaryLane === item.b.primaryLane).length;
  const scoreDeltas: Record<string, { compared: number; mean_abs_delta: number | null; max_abs_delta: number | null }> = {};
  for (const field of SCORE_FIELDS) {
    const deltas = both
      .map((item) => [item.a.scores[field], item.b.scores[field]] as const)
      .filter((pair): pair is readonly [number, number] => typeof pair[0] === "number" && typeof pair[1] === "number")
      .map(([a, b]) => Math.abs(a - b));
    scoreDeltas[field] = {
      compared: deltas.length,
      mean_abs_delta: deltas.length ? Math.round((deltas.reduce((sum, d) => sum + d, 0) / deltas.length) * 100) / 100 : null,
      max_abs_delta: deltas.length ? Math.max(...deltas) : null,
    };
  }
  const totals = (side: "a" | "b") => {
    const runs = comparisons.map((item) => item[side]);
    const promptTokens = runs.reduce((sum, run) => sum + (run.promptTokens ?? 0), 0);
    const completionTokens = runs.reduce((sum, run) => sum + (run.completionTokens ?? 0), 0);
    const costs = runs.map((run) => costUsd(run, prices[models[side]]));
    const priced = costs.every((cost) => cost !== null) && runs.length > 0;
    return {
      model: models[side],
      succeeded: runs.filter((run) => run.ok).length,
      failed: runs.filter((run) => !run.ok).length,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      cost_usd: priced ? Math.round(costs.reduce((sum: number, cost) => sum + (cost ?? 0), 0) * 1e6) / 1e6 : null,
    };
  };
  const a = totals("a");
  const b = totals("b");
  return {
    jobs: comparisons.length,
    compared_both_ok: both.length,
    next_action_agreement: both.length ? Math.round((agree / both.length) * 10000) / 10000 : null,
    primary_lane_agreement: both.length ? Math.round((laneAgree / both.length) * 10000) / 10000 : null,
    score_deltas: scoreDeltas,
    model_a: a,
    model_b: b,
    cost_difference_usd_b_minus_a: a.cost_usd !== null && b.cost_usd !== null ? Math.round((b.cost_usd - a.cost_usd) * 1e6) / 1e6 : null,
    cost_per_job_usd: {
      [models.a]: a.cost_usd !== null && comparisons.length ? a.cost_usd / comparisons.length : null,
      [models.b]: b.cost_usd !== null && comparisons.length ? b.cost_usd / comparisons.length : null,
    },
  };
}

/** The latest evaluation of each current, unarchived, non-fixture job version. */
export const EVALUATION_SAMPLE_SQL = `
SELECT DISTINCT ON (cj.id)
          cj.id::text AS canonical_job_id, jv.id::text AS job_version_id, cj.normalized_title, cj.company_name,
          cj.canonical_url, jv.description_text, ae.full_evaluation_payload->>'primary_lane' AS primary_lane,
          ae.workability_facts
   FROM ai_evaluations ae
   JOIN canonical_jobs cj ON cj.id = ae.canonical_job_id AND cj.workspace_id = $1
   JOIN job_versions jv ON jv.id = cj.latest_job_version_id AND jv.id::text = ae.job_version_id::text
   WHERE cj.archived_at IS NULL AND COALESCE(cj.is_test_fixture, FALSE) = FALSE
   ORDER BY cj.id, ae.evaluated_at DESC
   LIMIT $2`;

interface SampleRow {
  canonical_job_id: string;
  job_version_id: string;
  normalized_title: string;
  company_name: string;
  canonical_url: string;
  description_text: string | null;
  primary_lane: string | null;
  workability_facts: Record<string, unknown> | null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pool = new pg.Pool(pgConnectionConfig(process.env.DATABASE_URL));
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const ctx = await resolveWorkspaceContext(client as any);
    const sample = await client.query<SampleRow>(EVALUATION_SAMPLE_SQL, [ctx.workspaceId, args.limit]);
    console.log(JSON.stringify({
      mode: args.run ? "run" : "dry-run",
      model_a: args.modelA,
      model_b: args.modelB,
      sample: sample.rows.map((row) => ({ canonical_job_id: row.canonical_job_id, job_version_id: row.job_version_id })),
      writes: "none (READ ONLY transaction; no ai_evaluations rows)",
    }, null, 2));
    if (!args.run) {
      console.log("Dry run: pass --run to call both models on this sample.");
      await client.query("ROLLBACK");
      return;
    }

    const profileVersion = await client.query<{ id: string; source_hash: string }>(
      `SELECT id, source_hash FROM profile_versions WHERE workspace_id = $1 AND status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1`,
      [ctx.workspaceId],
    );
    if (!profileVersion.rows[0]) throw new Error("AI evaluation requires an ACTIVE database-backed profile version.");
    const facts = await client.query(
      `SELECT fact_key, fact_type, statement, structured_value, evidence_tier, verification_status, confidentiality
       FROM profile_facts
       WHERE workspace_id = $1 AND profile_version_id = $2
         AND verification_status IN ('VERIFIED', 'SELF_ATTESTED') AND fact_type <> 'CONTACT'
         AND confidentiality IN ('PUBLIC', 'PRIVATE_REUSABLE')
       ORDER BY fact_key`,
      [ctx.workspaceId, profileVersion.rows[0].id],
    );
    const candidateProfileContext = JSON.stringify({
      profile_version_id: profileVersion.rows[0].id,
      profile_source_hash: profileVersion.rows[0].source_hash,
      verified_profile_facts: facts.rows.filter(isProfileFactModelShareable),
    });
    await client.query("ROLLBACK");

    // Gemini first and no OpenAI fallback, so each column is the named model's own answer.
    process.env.EVALUATION_PRIMARY_PROVIDER = "gemini";
    delete process.env.OPENAI_API_KEY;
    const { evaluateSingleCanonicalJob } = await import("../src/services/agent.js");

    const evaluate = async (row: SampleRow, model: string): Promise<ModelRun> => {
      try {
        const result = await evaluateSingleCanonicalJob({
          canonicalJobId: row.canonical_job_id,
          jobVersionId: row.job_version_id,
          normalizedTitle: row.normalized_title,
          companyName: row.company_name,
          canonicalUrl: row.canonical_url,
          descriptionText: row.description_text || "No description provided.",
          candidateLane: row.primary_lane ?? undefined,
          workabilityFacts: row.workability_facts ?? {},
          candidateProfileContext,
        }, crypto.randomUUID(), 1, { modelOverride: model });
        const job = result.evaluatedJob as unknown as Record<string, unknown>;
        return {
          ok: result.model === model,
          nextAction: String(job.next_action ?? ""),
          primaryLane: (job.primary_lane as string | null) ?? null,
          scores: Object.fromEntries(SCORE_FIELDS.map((field) => [field, typeof job[field] === "number" ? job[field] as number : null])),
          promptTokens: result.usage?.promptTokens ?? null,
          completionTokens: result.usage?.completionTokens ?? null,
          ...(result.model === model ? {} : { error: `answered by ${result.model}` }),
        };
      } catch (error) {
        return {
          ok: false, nextAction: null, primaryLane: null, scores: {}, promptTokens: null, completionTokens: null,
          error: publicErrorSummary(error, "evaluation"),
        };
      }
    };

    const comparisons: JobComparison[] = [];
    for (const row of sample.rows) {
      const a = await evaluate(row, args.modelA);
      const b = await evaluate(row, args.modelB);
      comparisons.push({ canonicalJobId: row.canonical_job_id, jobVersionId: row.job_version_id, a, b });
      console.log(`[compare] ${row.canonical_job_id} ${args.modelA}=${a.nextAction ?? "FAILED"} ${args.modelB}=${b.nextAction ?? "FAILED"}`);
    }
    console.log(JSON.stringify({
      summary: summarizeComparisons(comparisons, { a: args.modelA, b: args.modelB }, args.prices),
      per_job: comparisons.map((item) => ({
        canonical_job_id: item.canonicalJobId,
        next_action: { [args.modelA]: item.a.nextAction, [args.modelB]: item.b.nextAction },
        errors: [item.a.error, item.b.error].filter(Boolean),
      })),
    }, null, 2));
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1]?.includes("compare_evaluation_models")) {
  main().catch((error) => {
    console.error("Evaluation model comparison failed:", publicErrorSummary(error, "evaluation"));
    process.exitCode = 1;
  });
}
