import pg from "pg";

import {
  CURRENT_APPLY_NOW_CONTEXT_QUERY,
  scoreApplyNowRow,
  type ApplyNowContextRow,
  type ScoredApplyNowRow,
} from "../services/applicationRankingMaterializer.js";
import {
  calculateStage3PriorityScore,
  type RankingAiLabels,
  type RankingComponents,
} from "../services/applicationRanking.js";
import type { ResolvedWorkspacePreferenceContext } from "../policy/workspacePreferenceRegistry.js";

/**
 * Report-only comparison of two ranking policy versions. It never writes: it reads the current
 * Apply Now context under each policy version inside a READ ONLY transaction and scores in memory,
 * so the live job_ranking_snapshots rows are not touched.
 *
 * The retired formula (AI terms weighted) lives here only so the "old" side of a comparison can be
 * reproduced; nothing in the live pipeline calls it.
 */

export type RankingRating = "YES" | "NO";

export interface ComparedJob {
  readonly canonicalJobId: string;
  readonly jobVersionId: string;
  readonly rank: number;
  readonly compositeScore: number;
  readonly finalPriorityScore: number;
  readonly laneConfidence: string | null;
  readonly aiNotesPending: boolean;
  readonly rating: RankingRating | null;
}

export interface LaneConfidenceEffect {
  readonly laneConfidence: string;
  readonly jobs: number;
  /** Mean composite points lost against the same job with a High (100) lane confidence. */
  readonly meanCompositePointsBelowHigh: number;
  readonly maxCompositePointsBelowHigh: number;
}

export interface RankingPolicyComparison {
  readonly oldPolicyVersion: number;
  readonly newPolicyVersion: number;
  readonly eligibleJobs: number;
  readonly oldTopTen: readonly ComparedJob[];
  readonly newTopTen: readonly ComparedJob[];
  readonly enteredTopTen: readonly string[];
  readonly leftTopTen: readonly string[];
  readonly laneConfidenceEffect: readonly LaneConfidenceEffect[];
  readonly elapsedMs: number;
}

const LEGACY_WEIGHT_NAMES = [
  "requirementFit",
  "requirementCoverage",
  "evidenceCompleteness",
  "laneConfidence",
  "autonomy",
  "politicsRisk",
  "sensoryWorkloadRisk",
  "strategicValue",
  "culturePriorityFit",
] as const;
type LegacyWeightName = (typeof LEGACY_WEIGHT_NAMES)[number];

function legacyWeights(raw: unknown): Record<LegacyWeightName, number> {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const weights = {} as Record<LegacyWeightName, number>;
  for (const name of LEGACY_WEIGHT_NAMES) {
    const value = source[name];
    weights[name] = typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  }
  return weights;
}

/** The retired composite, reproduced for comparison: AI terms weighted, culture priorities move the AI budget. */
export function legacyCompositeScore(
  components: RankingComponents,
  aiLabels: RankingAiLabels,
  rawWeights: unknown,
  cultureConfigured: boolean,
): number | null {
  const weights = legacyWeights(rawWeights);
  if (cultureConfigured) {
    const budget = weights.autonomy + weights.politicsRisk + weights.sensoryWorkloadRisk + weights.culturePriorityFit;
    weights.autonomy = 0;
    weights.politicsRisk = 0;
    weights.sensoryWorkloadRisk = 0;
    weights.culturePriorityFit = budget;
  }
  const terms: Array<[number | null, number, boolean]> = [
    [components.requirementFit, weights.requirementFit, false],
    [components.requirementCoverage, weights.requirementCoverage, false],
    [components.evidenceCompleteness, weights.evidenceCompleteness, false],
    [components.laneConfidence, weights.laneConfidence, false],
    [aiLabels.autonomy, weights.autonomy, false],
    [aiLabels.politicsRisk, weights.politicsRisk, true],
    [aiLabels.sensoryWorkloadRisk, weights.sensoryWorkloadRisk, true],
    [null, weights.strategicValue, false],
    [aiLabels.culturePriorityFit, weights.culturePriorityFit, false],
  ];
  let available = 0;
  let weighted = 0;
  for (const [score, weight, inverse] of terms) {
    if (score === null) continue;
    available += weight;
    weighted += (inverse ? 100 - score : score) * weight;
  }
  return available === 0 ? null : weighted / available;
}

interface PolicySide {
  readonly policyVersion: number;
  readonly rows: ReadonlyArray<{ row: ApplyNowContextRow; scored: ScoredApplyNowRow }>;
}

async function readSide(
  client: pg.PoolClient,
  workspaceId: string,
  policyVersion: number,
  preferenceContext: ResolvedWorkspacePreferenceContext | null,
): Promise<PolicySide> {
  const { rows } = await client.query<ApplyNowContextRow>(CURRENT_APPLY_NOW_CONTEXT_QUERY, [
    workspaceId,
    [],
    policyVersion,
  ]);
  const scoredRows: Array<{ row: ApplyNowContextRow; scored: ScoredApplyNowRow }> = [];
  for (const row of rows) {
    if (
      row.application_readiness_status !== "READY" ||
      !row.application_readiness_fingerprint ||
      row.application_readiness_fingerprint !== row.decision_readiness_fingerprint ||
      !row.current_evidence_revision_hash ||
      row.decision_evidence_revision_hash !== row.current_evidence_revision_hash
    ) continue;
    // The retired policy rows carry AI weights, which the live parser rejects; score the shared
    // deterministic parts under the current weights and re-weight below for the old side.
    const scored = scoreApplyNowRow(row, preferenceContext, { requirementFit: 37.5, requirementCoverage: 15, evidenceCompleteness: 10, laneConfidence: 10 });
    scoredRows.push({ row, scored });
  }
  return { policyVersion, rows: scoredRows };
}

function toCompared(
  entries: Array<{ job: Omit<ComparedJob, "rank" | "rating">; confidence: number }>,
  ratings: ReadonlyMap<string, RankingRating>,
  topN: number,
): ComparedJob[] {
  return entries
    .sort((a, b) =>
      b.job.finalPriorityScore - a.job.finalPriorityScore || b.confidence - a.confidence)
    .slice(0, topN)
    .map((entry, index) => ({
      ...entry.job,
      rank: index + 1,
      rating: ratings.get(entry.job.canonicalJobId) ?? null,
    }));
}

function priorityFor(scored: ScoredApplyNowRow, composite: number): number {
  return calculateStage3PriorityScore(
    composite,
    {
      freshnessScore: scored.freshness.status === "UNKNOWN" ? null : scored.freshness.freshness_score,
      remoteFreedomScore: scored.mobility.remote_freedom_score,
    },
    {
      baseRankWeight: scored.priorityWeights.base_rank_pct / 100,
      freshnessWeight: scored.priorityWeights.freshness_pct / 100,
      remoteFreedomWeight: scored.priorityWeights.remote_freedom_pct / 100,
    },
  ) ?? 0;
}

export async function compareRankingPolicies(
  pool: pg.Pool,
  workspaceId: string,
  options: {
    readonly oldPolicyVersion: number;
    readonly newPolicyVersion: number;
    readonly preferenceContext?: ResolvedWorkspacePreferenceContext | null;
    readonly ratings?: ReadonlyMap<string, RankingRating>;
    readonly topN?: number;
    readonly minimumRankingConfidence?: number;
  },
): Promise<RankingPolicyComparison> {
  const started = Date.now();
  const topN = options.topN ?? 10;
  const ratings = options.ratings ?? new Map<string, RankingRating>();
  const preferenceContext = options.preferenceContext ?? null;
  const minimumConfidence = options.minimumRankingConfidence ?? 90;
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ");
    const oldSide = await readSide(client, workspaceId, options.oldPolicyVersion, preferenceContext);
    const newSide = await readSide(client, workspaceId, options.newPolicyVersion, preferenceContext);
    await client.query("ROLLBACK");

    // Old side: AI terms weighted, and a Top 10 row needs a current AI evaluation.
    const oldEntries = oldSide.rows.flatMap(({ row, scored }) => {
      if (scored.evaluation === null) return [];
      const composite = legacyCompositeScore(
        scored.components,
        scored.aiLabels,
        row.ranking_weights,
        scored.culturePriority.configured,
      );
      if (composite === null) return [];
      return [{
        job: {
          canonicalJobId: row.canonical_job_id,
          jobVersionId: row.job_version_id,
          compositeScore: Number(composite.toFixed(3)),
          finalPriorityScore: priorityFor(scored, composite),
          laneConfidence: row.lane_confidence,
          aiNotesPending: false,
        },
        confidence: scored.ranking.rankingConfidence,
      }];
    });
    const newEntries = newSide.rows.flatMap(({ row, scored }) => {
      if (scored.ranking.overallRankScore === null || scored.finalPriorityScore === null) return [];
      if (scored.ranking.rankingConfidence < minimumConfidence) return [];
      return [{
        job: {
          canonicalJobId: row.canonical_job_id,
          jobVersionId: row.job_version_id,
          compositeScore: Number(scored.ranking.overallRankScore.toFixed(3)),
          finalPriorityScore: scored.finalPriorityScore,
          laneConfidence: row.lane_confidence,
          aiNotesPending: scored.evaluation === null,
        },
        confidence: scored.ranking.rankingConfidence,
      }];
    });
    const oldTopTen = toCompared(oldEntries, ratings, topN);
    const newTopTen = toCompared(newEntries, ratings, topN);
    const oldIds = new Set(oldTopTen.map((job) => job.canonicalJobId));
    const newIds = new Set(newTopTen.map((job) => job.canonicalJobId));

    // Lane confidence effect on the new composite: same job with a High (100) lane confidence.
    const effectBuckets = new Map<string, number[]>();
    for (const { row, scored } of newSide.rows) {
      const lane = scored.components.laneConfidence;
      if (lane === null || scored.ranking.overallRankScore === null) continue;
      const high = scoreApplyNowRow(
        { ...row, lane_confidence: "high" },
        preferenceContext,
        { requirementFit: 37.5, requirementCoverage: 15, evidenceCompleteness: 10, laneConfidence: 10 },
      ).ranking.overallRankScore;
      if (high === null) continue;
      const label = (row.lane_confidence ?? "unknown").toLowerCase();
      const bucket = effectBuckets.get(label) ?? [];
      bucket.push(high - scored.ranking.overallRankScore);
      effectBuckets.set(label, bucket);
    }
    const laneConfidenceEffect: LaneConfidenceEffect[] = [...effectBuckets.entries()]
      .map(([laneConfidence, deltas]) => ({
        laneConfidence,
        jobs: deltas.length,
        meanCompositePointsBelowHigh: Number((deltas.reduce((a, b) => a + b, 0) / deltas.length).toFixed(3)),
        maxCompositePointsBelowHigh: Number(Math.max(...deltas).toFixed(3)),
      }))
      .sort((a, b) => a.laneConfidence.localeCompare(b.laneConfidence));

    return {
      oldPolicyVersion: options.oldPolicyVersion,
      newPolicyVersion: options.newPolicyVersion,
      eligibleJobs: newSide.rows.length,
      oldTopTen,
      newTopTen,
      enteredTopTen: [...newIds].filter((id) => !oldIds.has(id)),
      leftTopTen: [...oldIds].filter((id) => !newIds.has(id)),
      laneConfidenceEffect,
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
