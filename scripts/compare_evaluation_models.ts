import crypto from "node:crypto";
import { readFileSync } from "node:fs";

import dotenv from "dotenv";
import pg from "pg";

import { pgConnectionConfig } from "../src/db/pgSsl.js";
import { isProfileFactModelShareable } from "../src/profile/privacy.js";
import { publicErrorSummary } from "../src/security/publicErrorSummary.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

/**
 * Offline comparison of evaluation models (Gemini and OpenAI) on the same current evaluated jobs.
 *
 *   npx tsx scripts/compare_evaluation_models.ts                  # dry run: lists the sample only
 *   npx tsx scripts/compare_evaluation_models.ts --run [--limit 20]
 *     [--models gemini-3.6-flash,gpt-6.1-terra,gpt-6-luna]       # the first model is the baseline
 *     [--prices-file prices.json | --prices '{"gpt-6-luna":{"input_per_1m":..,"output_per_1m":..}}']
 *     [--no-flex]                                                 # Gemini on standard PayGo only
 *
 * `--model-a X --model-b Y` is still accepted and means `--models X,Y`.
 *
 * Reads the database inside a READ ONLY transaction and writes nothing: no ai_evaluations rows,
 * no queue changes, no model-route invocation records. Every model is called through the normal
 * strict evaluation path (schema + job-identity validation) on its own provider only (a model whose
 * id starts with "gemini" on Gemini, any other on OpenAI) with no fallback provider, so a failure is
 * that model's failure. The report holds ids, outcomes, agreement, token counts and cost estimates;
 * never prompts, descriptions or profile text. Prices are never built in: pass them with
 * --prices / --prices-file (or MODEL_PRICING_JSON); a model without a price has cost null.
 */

const SCORE_FIELDS = [
  "nd_score", "nd_friendly_score", "politics_stress_score", "focus_protection_score",
  "strategic_value_score", "technical_depth_score", "role_ownership_score",
] as const;

export const DEFAULT_COMPARISON_MODELS = ["gemini-3.6-flash", "gemini-2.5-flash"] as const;
const MAX_MODELS = 6;

export interface ModelPrice {
  inputPer1M: number;
  outputPer1M: number;
}

export type ComparisonProvider = "gemini" | "openai";

/** How one model's run on one job failed, when it did. */
export type RunFailureKind = "SCHEMA" | "PROVIDER" | "ANSWERED_BY_OTHER_MODEL";

export interface ModelRun {
  ok: boolean;
  nextAction: string | null;
  primaryLane: string | null;
  scores: Record<string, number | null>;
  promptTokens: number | null;
  completionTokens: number | null;
  /** Reasoning/thinking tokens when the API reported them. */
  reasoningTokens?: number | null;
  /** True when completionTokens already includes reasoningTokens (OpenAI); false for Gemini. */
  reasoningIncludedInCompletion?: boolean | null;
  /** FLEX / STANDARD / OPENAI: which path answered. */
  servedPath?: string | null;
  failureKind?: RunFailureKind;
  error?: string;
}

export interface JobComparison {
  canonicalJobId: string;
  jobVersionId: string;
  runs: Record<string, ModelRun>;
}

export interface ComparisonArgs {
  run: boolean;
  limit: number;
  models: string[];
  prices: Record<string, ModelPrice>;
  noFlex: boolean;
}

/** The provider a model id is called on: "gemini*" on Gemini, anything else on OpenAI. */
export function providerForModel(model: string): ComparisonProvider {
  return model.trim().toLowerCase().startsWith("gemini") ? "gemini" : "openai";
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ComparisonArgs {
  const value = (name: string) => {
    const index = argv.indexOf(name);
    if (index < 0) return undefined;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`${name} needs a value.`);
    return next;
  };
  const limit = Number.parseInt(value("--limit") ?? "20", 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("--limit must be an integer from 1 to 200.");

  const listed = value("--models");
  const modelA = value("--model-a");
  const modelB = value("--model-b");
  if (listed && (modelA || modelB)) throw new Error("Use either --models or --model-a/--model-b, not both.");
  const models = listed
    ? listed.split(",").map((model) => model.trim()).filter(Boolean)
    : [modelA ?? DEFAULT_COMPARISON_MODELS[0], modelB ?? DEFAULT_COMPARISON_MODELS[1]];
  if (models.length < 2) throw new Error("--models needs at least two comma-separated model ids.");
  if (models.length > MAX_MODELS) throw new Error(`--models accepts at most ${MAX_MODELS} model ids.`);
  if (new Set(models).size !== models.length) throw new Error("--models lists a model more than once.");
  for (const model of models) {
    if (!/^[A-Za-z0-9._:-]{1,100}$/.test(model)) throw new Error(`Model id "${model.slice(0, 40)}" is not valid.`);
  }

  const pricesFile = value("--prices-file");
  const pricesInline = value("--prices");
  if (pricesFile && pricesInline) throw new Error("Use either --prices or --prices-file, not both.");
  const rawPrices = pricesFile
    ? readFileSync(pricesFile, "utf8")
    : pricesInline ?? env.MODEL_PRICING_JSON ?? "";

  return {
    run: argv.includes("--run"),
    limit,
    models,
    prices: parsePrices(rawPrices),
    noFlex: argv.includes("--no-flex"),
  };
}

/**
 * Prices per 1M tokens, keyed by model id ("gemini:" / "openai:" prefixes are dropped):
 * {"<model>": {"input_per_1m": <usd>, "output_per_1m": <usd>}}. Entries without both numbers are
 * rejected rather than guessed.
 */
export function parsePrices(raw: string): Record<string, ModelPrice> {
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("The price table is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The price table must be a JSON object.");
  const prices: Record<string, ModelPrice> = {};
  for (const [model, entry] of Object.entries(parsed as Record<string, Record<string, unknown> | null>)) {
    const input = Number(entry?.input_per_1m ?? entry?.inputPer1M);
    const output = Number(entry?.output_per_1m ?? entry?.outputPer1M);
    if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) {
      throw new Error(`Price for "${model.slice(0, 60)}" needs non-negative input_per_1m and output_per_1m.`);
    }
    prices[model.replace(/^(gemini|openai):/, "")] = { inputPer1M: input, outputPer1M: output };
  }
  return prices;
}

/** Output tokens billed for a run: completion plus reasoning when the API reports them apart. */
export function billableOutputTokens(run: ModelRun): number | null {
  if (run.completionTokens === null) return null;
  const separateReasoning = run.reasoningIncludedInCompletion === false ? (run.reasoningTokens ?? 0) : 0;
  return run.completionTokens + separateReasoning;
}

function costUsd(run: ModelRun, price: ModelPrice | undefined): number | null {
  const output = billableOutputTokens(run);
  if (!price || run.promptTokens === null || output === null) return null;
  return (run.promptTokens / 1e6) * price.inputPer1M + (output / 1e6) * price.outputPer1M;
}

const round4 = (value: number) => Math.round(value * 10000) / 10000;
const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

export interface ModelComparisonSummary {
  model: string;
  provider: ComparisonProvider;
  is_baseline: boolean;
  jobs: number;
  succeeded: number;
  failed: number;
  schema_failures: number;
  provider_failures: number;
  answered_by_other_model: number;
  compared_with_baseline: number;
  next_action_agreement: number | null;
  primary_lane_agreement: number | null;
  score_mean_abs_delta: Record<string, number | null>;
  served_paths: Record<string, number>;
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  billable_output_tokens: number;
  priced: boolean;
  cost_usd: number | null;
  cost_per_successful_job_usd: number | null;
}

/**
 * Per model: outcome (next_action) and primary-lane agreement with the first (baseline) model on
 * jobs where both succeeded, schema/provider failures, token totals and cost. Cost is null when
 * the model has no price or any run lacks token counts, so a partial total is never presented.
 */
export function summarizeModelComparisons(
  comparisons: JobComparison[],
  models: string[],
  prices: Record<string, ModelPrice>,
): { jobs: number; baseline_model: string; models: ModelComparisonSummary[]; unpriced_models: string[] } {
  const baseline = models[0];
  const summaries = models.map((model): ModelComparisonSummary => {
    const runs = comparisons.map((item) => item.runs[model]).filter((run): run is ModelRun => Boolean(run));
    const paired = comparisons.filter((item) => item.runs[model]?.ok && item.runs[baseline]?.ok);
    const agree = (field: "nextAction" | "primaryLane") =>
      paired.length ? round4(paired.filter((item) => item.runs[model][field] === item.runs[baseline][field]).length / paired.length) : null;
    const scoreMeanAbsDelta: Record<string, number | null> = {};
    for (const field of SCORE_FIELDS) {
      const deltas = paired
        .map((item) => [item.runs[model].scores[field], item.runs[baseline].scores[field]] as const)
        .filter((pair): pair is readonly [number, number] => typeof pair[0] === "number" && typeof pair[1] === "number")
        .map(([a, b]) => Math.abs(a - b));
      scoreMeanAbsDelta[field] = deltas.length ? Math.round((deltas.reduce((sum, d) => sum + d, 0) / deltas.length) * 100) / 100 : null;
    }
    const servedPaths: Record<string, number> = {};
    for (const run of runs) {
      if (run.ok && run.servedPath) servedPaths[run.servedPath] = (servedPaths[run.servedPath] ?? 0) + 1;
    }
    const sum = (pick: (run: ModelRun) => number | null | undefined) => runs.reduce((total, run) => total + (pick(run) ?? 0), 0);
    const price = prices[model];
    const costs = runs.map((run) => costUsd(run, price));
    const priced = price !== undefined && runs.length > 0 && costs.every((cost) => cost !== null);
    const succeeded = runs.filter((run) => run.ok).length;
    const totalCost = priced ? round6(costs.reduce((total: number, cost) => total + (cost ?? 0), 0)) : null;
    return {
      model,
      provider: providerForModel(model),
      is_baseline: model === baseline,
      jobs: runs.length,
      succeeded,
      failed: runs.length - succeeded,
      schema_failures: runs.filter((run) => run.failureKind === "SCHEMA").length,
      provider_failures: runs.filter((run) => run.failureKind === "PROVIDER").length,
      answered_by_other_model: runs.filter((run) => run.failureKind === "ANSWERED_BY_OTHER_MODEL").length,
      compared_with_baseline: paired.length,
      next_action_agreement: agree("nextAction"),
      primary_lane_agreement: agree("primaryLane"),
      score_mean_abs_delta: scoreMeanAbsDelta,
      served_paths: servedPaths,
      prompt_tokens: sum((run) => run.promptTokens),
      completion_tokens: sum((run) => run.completionTokens),
      reasoning_tokens: sum((run) => run.reasoningTokens),
      billable_output_tokens: sum(billableOutputTokens),
      priced,
      cost_usd: totalCost,
      cost_per_successful_job_usd: totalCost !== null && succeeded > 0 ? round6(totalCost / succeeded) : null,
    };
  });
  return {
    jobs: comparisons.length,
    baseline_model: baseline,
    models: summaries,
    unpriced_models: models.filter((model) => prices[model] === undefined),
  };
}

/** Failure kinds reported by generateContentAudited (ModelCallFailedError.failures). */
interface FailureWithKinds {
  failures?: ReadonlyArray<{ kind?: string | null }>;
}

/** SCHEMA when any provider answer failed schema/identity validation, PROVIDER otherwise. */
export function classifyRunFailure(error: unknown): RunFailureKind {
  const failures = (error as FailureWithKinds | null)?.failures;
  if (Array.isArray(failures) && failures.some((failure) => failure?.kind === "VALIDATION")) return "SCHEMA";
  return "PROVIDER";
}

/** The fields of an evaluation execution result this script reads. */
export interface EvaluationExecutionLike {
  evaluatedJob: unknown;
  model: string;
  servedPath?: string | null;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    reasoningTokens?: number;
    reasoningIncludedInCompletion?: boolean;
  } | null;
}

export function toModelRun(result: EvaluationExecutionLike, model: string): ModelRun {
  const job = result.evaluatedJob as Record<string, unknown>;
  const answeredByModel = result.model === model;
  return {
    ok: answeredByModel,
    nextAction: String(job.next_action ?? ""),
    primaryLane: (job.primary_lane as string | null) ?? null,
    scores: Object.fromEntries(SCORE_FIELDS.map((field) => [field, typeof job[field] === "number" ? job[field] as number : null])),
    promptTokens: result.usage?.promptTokens ?? null,
    completionTokens: result.usage?.completionTokens ?? null,
    reasoningTokens: result.usage?.reasoningTokens ?? null,
    reasoningIncludedInCompletion: result.usage?.reasoningIncludedInCompletion ?? null,
    servedPath: result.servedPath ?? null,
    ...(answeredByModel ? {} : { failureKind: "ANSWERED_BY_OTHER_MODEL" as const, error: `answered by ${result.model}` }),
  };
}

export function failedRun(error: unknown): ModelRun {
  return {
    ok: false, nextAction: null, primaryLane: null, scores: {}, promptTokens: null, completionTokens: null,
    failureKind: classifyRunFailure(error),
    error: publicErrorSummary(error, "evaluation"),
  };
}

export interface SampleRow {
  canonical_job_id: string;
  job_version_id: string;
  normalized_title: string;
  company_name: string;
  canonical_url: string;
  description_text: string | null;
  primary_lane: string | null;
  workability_facts: Record<string, unknown> | null;
}

export type EvaluateWithModel = (row: SampleRow, model: string, provider: ComparisonProvider) => Promise<EvaluationExecutionLike>;

/** Evaluates every sample row with every model, in order; one model's failure never stops the run. */
export async function runModelComparison(
  rows: readonly SampleRow[],
  models: readonly string[],
  evaluate: EvaluateWithModel,
  log: (line: string) => void = () => undefined,
): Promise<JobComparison[]> {
  const comparisons: JobComparison[] = [];
  for (const row of rows) {
    const runs: Record<string, ModelRun> = {};
    for (const model of models) {
      try {
        runs[model] = toModelRun(await evaluate(row, model, providerForModel(model)), model);
      } catch (error) {
        runs[model] = failedRun(error);
      }
    }
    comparisons.push({ canonicalJobId: row.canonical_job_id, jobVersionId: row.job_version_id, runs });
    log(`[compare] ${row.canonical_job_id} ${models.map((model) => `${model}=${runs[model].nextAction ?? `FAILED(${runs[model].failureKind})`}`).join(" ")}`);
  }
  return comparisons;
}

/** The per-job part of the report: ids, outcomes and failure kinds only. */
export function perJobReport(comparisons: JobComparison[], models: readonly string[]) {
  return comparisons.map((item) => ({
    canonical_job_id: item.canonicalJobId,
    next_action: Object.fromEntries(models.map((model) => [model, item.runs[model]?.nextAction ?? null])),
    primary_lane: Object.fromEntries(models.map((model) => [model, item.runs[model]?.ok ? item.runs[model].primaryLane : null])),
    failures: Object.fromEntries(
      models
        .filter((model) => item.runs[model] && !item.runs[model].ok)
        .map((model) => [model, { kind: item.runs[model].failureKind ?? null, error: item.runs[model].error ?? null }]),
    ),
  }));
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pool = new pg.Pool(pgConnectionConfig(process.env.DATABASE_URL));
  // The model calls below take minutes; a server-side close of an idle pooled connection must not
  // crash the process with an unhandled 'error' event.
  pool.on("error", (error) => {
    console.warn("Idle database connection closed:", publicErrorSummary(error, "evaluation"));
  });
  const client = await pool.connect();
  let released = false;
  const releaseClient = () => {
    if (!released) {
      released = true;
      client.release();
    }
  };
  try {
    await client.query("BEGIN READ ONLY");
    const ctx = await resolveWorkspaceContext(client as any);
    const sample = await client.query<SampleRow>(EVALUATION_SAMPLE_SQL, [ctx.workspaceId, args.limit]);
    console.log(JSON.stringify({
      mode: args.run ? "run" : "dry-run",
      models: args.models.map((model) => ({ model, provider: providerForModel(model), priced: args.prices[model] !== undefined })),
      baseline_model: args.models[0],
      gemini_flex: args.noFlex ? "disabled (--no-flex)" : "as configured (GEMINI_PIPELINE_FLEX)",
      sample: sample.rows.map((row) => ({ canonical_job_id: row.canonical_job_id, job_version_id: row.job_version_id })),
      writes: "none (READ ONLY transaction; no ai_evaluations rows)",
    }, null, 2));
    if (!args.run) {
      console.log("Dry run: pass --run to call every model on this sample.");
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
    // Every database read is done; don't hold a connection open across the model calls.
    releaseClient();

    // agent.js loads .env/.env.local on import, so the Flex override must come after the import.
    const { evaluateSingleCanonicalJob } = await import("../src/services/agent.js");
    if (args.noFlex) process.env.GEMINI_PIPELINE_FLEX = "false";

    const comparisons = await runModelComparison(
      sample.rows,
      args.models,
      (row, model, provider) => evaluateSingleCanonicalJob({
        canonicalJobId: row.canonical_job_id,
        jobVersionId: row.job_version_id,
        normalizedTitle: row.normalized_title,
        companyName: row.company_name,
        canonicalUrl: row.canonical_url,
        descriptionText: row.description_text || "No description provided.",
        candidateLane: row.primary_lane ?? undefined,
        workabilityFacts: row.workability_facts ?? {},
        candidateProfileContext,
        // No clientOrPool is passed, so nothing is recorded in the database.
      }, crypto.randomUUID(), 1, { modelOverride: model, onlyProvider: provider }),
      (line) => console.log(line),
    );
    console.log(JSON.stringify({
      summary: summarizeModelComparisons(comparisons, args.models, args.prices),
      per_job: perJobReport(comparisons, args.models),
    }, null, 2));
  } finally {
    releaseClient();
    await pool.end();
  }
}

if (process.argv[1]?.includes("compare_evaluation_models")) {
  main().catch((error) => {
    console.error("Evaluation model comparison failed:", publicErrorSummary(error, "evaluation"));
    process.exitCode = 1;
  });
}
