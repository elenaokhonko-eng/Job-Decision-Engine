import pg from "pg";

import {
  evaluateJobFreshness,
  evaluateMobilityMatch,
  type FreshnessEvaluationResult,
  type MobilityEvaluationResult,
} from "../policy/stage3PolicyEngine.js";
import { resolveWorkspacePreferenceContext, type ResolvedWorkspacePreferenceContext } from "../policy/workspacePreferenceRegistry.js";
import type { WorkspaceContext } from "../workspace/context.js";
import type { Stage3ApplicationPriorityWeights } from "../policy/stage3Contracts.js";
import {
  calculateRanking,
  INITIAL_RANKING_WEIGHTS,
  calculateStage3PriorityScore,
  type RankingComponents,
  type RankingWeights,
} from "./applicationRanking.js";
import {
  CULTURE_SCORE_DERIVATION_VERSION,
  scoreCultureEvidenceFromQuote,
  type CultureEvidenceSignal,
} from "./cultureEvidenceScoring.js";

interface ApplyNowContextRow extends pg.QueryResultRow {
  workspace_id: string;
  canonical_job_id: string;
  job_version_id: string;
  profile_version_id: string;
  match_run_id: string;
  deterministic_decision_id: string;
  deterministic_context_fingerprint: string;
  match_job_content_hash: string;
  current_job_content_hash: string;
  current_job_description: string;
  company_name: string;
  location: string | null;
  workplace_type: string | null;
  posted_at: Date | string | null;
  reposted_at: Date | string | null;
  source_updated_at: Date | string | null;
  freshness_basis: string | null;
  first_seen_at: Date | string | null;
  last_seen_at: Date | string | null;
  current_artifact_status: string;
  version_mismatch: boolean;
  gate_status: string;
  primary_lane: string | null;
  lane_confidence: string | null;
  recommendation_outcome: string;
  recommendation_requirement_score: string | number | null;
  recommendation_coverage_score: string | number | null;
  recommendation_evidence_completeness: string | number | null;
  deterministic_match_score: string | number | null;
  deterministic_match_coverage: string | number | null;
  evaluation_id: string | null;
  evaluation_context_fingerprint: string | null;
  evaluation_job_content_hash: string | null;
  evaluation_payload: Record<string, unknown> | null;
  ranking_policy_version: number;
  ranking_weights: RankingWeights;
  minimum_ranking_confidence: string | number;
  policy_recheck_required: boolean;
}

export interface RankingMaterializationResult {
  readonly dryRun: boolean;
  readonly eligibleApplyNowJobs: number;
  readonly snapshotsWouldInsert: number;
  readonly snapshotsInserted: number;
  readonly snapshotsAlreadyCurrent: number;
  readonly missingCurrentEvaluations: number;
  readonly incompleteRequiredInputs: number;
}

const CURRENT_APPLY_NOW_CONTEXT_QUERY = `
  SELECT
    shortlist.workspace_id,
    shortlist.canonical_job_id,
    shortlist.job_version_id::uuid AS job_version_id,
    active_profile.id AS profile_version_id,
    current_match.id AS match_run_id,
    current_decision.id AS deterministic_decision_id,
    current_decision.context_fingerprint AS deterministic_context_fingerprint,
    current_match.job_content_hash AS match_job_content_hash,
    job_version.content_hash AS current_job_content_hash,
    job_version.description_text AS current_job_description,
    job.company_name,
    job.location,
    job.workplace_type,
    job_version.source_published_at AS posted_at,
    job_version.reposted_at,
    job_version.source_updated_at,
    job_version.freshness_basis,
    job_version.first_seen_at,
    job_version.last_seen_at,
    shortlist.current_artifact_status,
    shortlist.version_mismatch,
    shortlist.gate_status,
    shortlist.primary_lane,
    shortlist.lane_confidence,
    shortlist.recommendation_outcome,
    shortlist.recommendation_requirement_score,
    shortlist.recommendation_coverage_score,
    shortlist.recommendation_evidence_completeness,
    shortlist.deterministic_match_score,
    shortlist.deterministic_match_coverage,
    current_evaluation.id AS evaluation_id,
    current_evaluation.context_fingerprint AS evaluation_context_fingerprint,
    current_evaluation.job_content_hash AS evaluation_job_content_hash,
    current_evaluation.full_evaluation_payload AS evaluation_payload,
    current_policy.policy_version AS ranking_policy_version,
    current_policy.weights AS ranking_weights,
    current_policy.minimum_ranking_confidence,
    shortlist.policy_recheck_required
  FROM v_apply_now_jobs_scoped AS shortlist
  JOIN canonical_jobs AS job
    ON job.workspace_id = shortlist.workspace_id
   AND job.id = shortlist.canonical_job_id
   AND job.latest_job_version_id = shortlist.job_version_id::uuid
  JOIN job_versions AS job_version
    ON job_version.workspace_id = job.workspace_id
   AND job_version.canonical_job_id = job.id
   AND job_version.id = job.latest_job_version_id
  JOIN LATERAL (
    SELECT profile.id
    FROM profile_versions AS profile
    WHERE profile.workspace_id = job.workspace_id
      AND profile.status = 'ACTIVE'
    ORDER BY profile.created_at DESC, profile.id DESC
    LIMIT 1
  ) AS active_profile ON TRUE
  JOIN match_runs AS current_match
    ON current_match.workspace_id = job.workspace_id
   AND current_match.id = job.latest_match_run_id
   AND current_match.canonical_job_id = job.id
   AND current_match.job_version_id = job_version.id
   AND current_match.profile_version_id = active_profile.id
   AND current_match.status = 'COMPLETED'
   AND job_version.active_requirement_set_id IS NOT NULL
   AND current_match.requirement_set_id = job_version.active_requirement_set_id
   AND current_match.job_content_hash = job_version.content_hash
   AND current_match.context_fingerprint IS NOT NULL
  JOIN deterministic_decisions AS current_decision
    ON current_decision.workspace_id = job.workspace_id
   AND current_decision.id = job.latest_deterministic_decision_id
   AND current_decision.canonical_job_id = job.id
   AND current_decision.job_version_id = job_version.id
   AND current_decision.match_run_id = current_match.id
   AND current_decision.context_fingerprint IS NOT NULL
  LEFT JOIN LATERAL (
    SELECT evaluation.id, evaluation.context_fingerprint,
           evaluation.job_content_hash, evaluation.full_evaluation_payload
    FROM ai_evaluations AS evaluation
    WHERE evaluation.workspace_id = job.workspace_id
      AND evaluation.canonical_job_id = job.id
      AND evaluation.job_version_id = job_version.id
      AND evaluation.profile_version_id = active_profile.id
      AND evaluation.match_run_id = current_match.id
      AND evaluation.deterministic_decision_id = current_decision.id
      AND evaluation.job_content_hash = job_version.content_hash
      AND evaluation.context_fingerprint = current_decision.context_fingerprint
    ORDER BY evaluation.evaluated_at DESC, evaluation.id DESC
    LIMIT 1
  ) AS current_evaluation ON TRUE
  JOIN LATERAL (
    SELECT policy.policy_version, policy.weights, policy.minimum_ranking_confidence
    FROM ranking_policies AS policy
    WHERE policy.workspace_id = job.workspace_id
    ORDER BY policy.policy_version DESC
    LIMIT 1
  ) AS current_policy ON TRUE
  WHERE shortlist.workspace_id = $1
    AND shortlist.gate_status = 'PASS'
    AND shortlist.recommendation_eligibility = 'ELIGIBLE'
    AND shortlist.recommendation_outcome IN ('PRIORITY', 'REVIEW')
    AND shortlist.current_artifact_status IN (
      'CURRENT_OR_NOT_APPLICABLE', 'EVALUATION_MISSING', 'EVALUATION_STALE'
    )
`;

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function scoreFromFraction(value: unknown): number | null {
  const score = toFiniteNumber(value);
  if (score === null) return null;
  if (score >= 0 && score <= 1) return score * 100;
  return score >= 0 && score <= 100 ? score : null;
}

function laneConfidenceScore(value: string | null): number | null {
  switch (value?.toLowerCase()) {
    case "high": return 100;
    case "medium": return 65;
    case "low": return 30;
    default: return null;
  }
}

const CULTURE_EVIDENCE_SIGNALS: ReadonlySet<string> = new Set([
  "AUTONOMY",
  "POLITICS_RISK",
  "SENSORY_WORKLOAD_RISK",
  "FOCUS_PROTECTION",
]);

function isCultureEvidenceSignal(value: unknown): value is CultureEvidenceSignal {
  return typeof value === "string" && CULTURE_EVIDENCE_SIGNALS.has(value);
}

function normalizedCultureEvidence(row: ApplyNowContextRow): Array<{
  signal: CultureEvidenceSignal;
  score: number | null;
  quote: string | null;
  score_derivation_version: string;
}> {
  const rawEvidence = row.evaluation_payload?.culture_evidence;
  if (!Array.isArray(rawEvidence)) return [];
  const evidence = rawEvidence.filter(
    (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)
  );
  const signalCounts = new Map<CultureEvidenceSignal, number>();
  for (const item of evidence) {
    if (!isCultureEvidenceSignal(item.signal)) continue;
    signalCounts.set(item.signal, (signalCounts.get(item.signal) ?? 0) + 1);
  }

  return evidence.flatMap((item) => {
    if (!isCultureEvidenceSignal(item.signal)) return [];
    const signal = item.signal;
    const rawQuote = item.quote;
    const quote =
      signalCounts.get(signal) === 1 &&
      typeof rawQuote === "string" &&
      rawQuote.length > 0 &&
      row.current_job_description.includes(rawQuote)
        ? rawQuote
        : null;
    const score = quote === null ? null : scoreCultureEvidenceFromQuote(signal, quote);

    return [{
      signal,
      score,
      quote: score === null ? null : quote,
      score_derivation_version: CULTURE_SCORE_DERIVATION_VERSION,
    }];
  });
}

function parseRankingWeights(value: unknown): RankingWeights {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The active ranking policy weights are not a JSON object.");
  }
  const weights = value as Record<string, unknown>;
  const names = Object.keys(INITIAL_RANKING_WEIGHTS) as Array<keyof RankingWeights>;
  const parsed = {} as Record<keyof RankingWeights, number>;
  for (const name of names) {
    const weight = toFiniteNumber(weights[name]);
    if (weight === null || weight < 0) {
      throw new Error(`The active ranking policy has an invalid ${name} weight.`);
    }
    parsed[name] = weight;
  }
  if (Object.keys(weights).length !== names.length) {
    throw new Error("The active ranking policy contains unsupported ranking weights.");
  }
  return parsed;
}

function buildComponents(row: ApplyNowContextRow): RankingComponents {
  const cultureEvidence = normalizedCultureEvidence(row);
  const cultureScore = (signal: CultureEvidenceSignal) =>
    cultureEvidence.find((evidence) => evidence.signal === signal)?.score ?? null;

  return {
    requirementFit: toFiniteNumber(row.deterministic_match_score),
    requirementCoverage: toFiniteNumber(row.deterministic_match_coverage),
    evidenceCompleteness: scoreFromFraction(row.recommendation_evidence_completeness),
    laneConfidence: laneConfidenceScore(row.lane_confidence),
    autonomy: cultureScore("AUTONOMY"),
    politicsRisk: cultureScore("POLITICS_RISK"),
    sensoryWorkloadRisk: cultureScore("SENSORY_WORKLOAD_RISK"),
    strategicValue: null,
  };
}

function componentAvailability(
  components: RankingComponents,
  freshness: FreshnessEvaluationResult,
  mobility: MobilityEvaluationResult,
): Record<string, boolean> {
  return {
    ...Object.fromEntries(Object.entries(components).map(([name, score]) => [name, score !== null])),
    freshness: freshness.status !== 'UNKNOWN',
    remote_from_home_base: mobility.remote_from_home_base_score !== null,
    temporary_abroad: mobility.temporary_abroad_score !== null,
    country_flexibility: mobility.country_flexibility_score !== null,
    office_requirement: mobility.office_requirement_score !== null,
    timezone_compatibility: mobility.timezone_compatibility_score !== null,
  };
}

function componentProvenance(
  row: ApplyNowContextRow,
  preferenceContext: ResolvedWorkspacePreferenceContext | null,
  freshness: FreshnessEvaluationResult,
  mobility: MobilityEvaluationResult,
  priorityWeights: Stage3ApplicationPriorityWeights,
): Record<string, unknown> {
  return {
    schema_version: "5.3.0",
    stage3_priority_derivation_version: "base_freshness_remote_v1",
    stage3_preference_context_id: preferenceContext?.contextId ?? null,
    stage3_preference_revisions: preferenceContext?.revisionsByDomain ?? {},
    application_priority_weights: priorityWeights,
    freshness: {
      score: freshness.status === 'UNKNOWN' ? null : freshness.freshness_score,
      job_age_days: freshness.job_age_days,
      basis: freshness.freshness_basis,
      confidence: freshness.freshness_confidence,
      status: freshness.status,
      evidence: freshness.evidence,
    },
    mobility: {
      remote_from_home_base_status: mobility.remote_from_home_base_status,
      temporary_work_abroad_status: mobility.temporary_work_abroad_status,
      work_from_anywhere_status: mobility.work_from_anywhere_status,
      remote_from_home_base_score: mobility.remote_from_home_base_score,
      temporary_abroad_score: mobility.temporary_abroad_score,
      country_flexibility_score: mobility.country_flexibility_score,
      office_requirement_score: mobility.office_requirement_score,
      timezone_compatibility_score: mobility.timezone_compatibility_score,
      remote_freedom_score: mobility.remote_freedom_score,
      evidence: mobility.evidence,
    },
    culture_score_derivation_version: CULTURE_SCORE_DERIVATION_VERSION,
    requirement_fit: "canonical_jobs.deterministic_match_score",
    requirement_coverage: "canonical_jobs.deterministic_match_coverage",
    evidence_completeness: "canonical_jobs.recommendation_evidence_completeness",
    lane_confidence: {
      source: "canonical_jobs.lane_confidence",
      mapping_version: "lane_confidence_ordinal_v1",
    },
    ai_evaluation_id: row.evaluation_id,
    context_fingerprint: row.evaluation_context_fingerprint,
    culture_evidence: normalizedCultureEvidence(row),
    policy_recheck_required: row.policy_recheck_required,
  };
}

export async function materializeApplicationRankings(
  pool: pg.Pool,
  workspaceId: string,
  options: {
    readonly dryRun?: boolean;
    readonly context?: WorkspaceContext;
    readonly preferenceContext?: ResolvedWorkspacePreferenceContext | null;
  } = {}
): Promise<RankingMaterializationResult> {
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    if (options.context && options.context.workspaceId !== workspaceId) {
      throw new Error(`Ranking workspace mismatch: expected ${workspaceId}, received ${options.context.workspaceId}.`);
    }
    const preferenceContext = options.preferenceContext !== undefined
      ? options.preferenceContext
      : options.context
        ? await resolveWorkspacePreferenceContext(client, options.context, ['stage3'])
        : null;
    const { rows } = await client.query<ApplyNowContextRow>(CURRENT_APPLY_NOW_CONTEXT_QUERY, [workspaceId]);
    const result = {
      dryRun: options.dryRun === true,
      eligibleApplyNowJobs: rows.length,
      snapshotsWouldInsert: 0,
      snapshotsInserted: 0,
      snapshotsAlreadyCurrent: 0,
      missingCurrentEvaluations: 0,
      incompleteRequiredInputs: 0,
    };

    for (const row of rows) {
      if (!row.evaluation_id || !row.evaluation_payload || !row.evaluation_context_fingerprint) {
        result.missingCurrentEvaluations += 1;
        continue;
      }
      if (
        row.evaluation_context_fingerprint !== row.deterministic_context_fingerprint ||
        row.evaluation_job_content_hash !== row.current_job_content_hash
      ) {
        result.missingCurrentEvaluations += 1;
        continue;
      }

      const components = buildComponents(row);
      if (
        components.requirementFit === null ||
        components.requirementCoverage === null ||
        components.evidenceCompleteness === null ||
        components.laneConfidence === null
      ) {
        result.incompleteRequiredInputs += 1;
      }
      const stage3Preferences = preferenceContext?.stage3;
      const freshness = evaluateJobFreshness({
        posted_at: row.posted_at,
        reposted_at: row.reposted_at,
        source_updated_at: row.source_updated_at,
        first_seen_at: row.first_seen_at,
        freshness_basis: row.freshness_basis,
        is_repost: row.freshness_basis === 'REPOSTED_AT',
        posting_identity_is_new: row.freshness_basis === 'NEW_POSTING_ID',
      }, stage3Preferences?.freshness);
      const mobility = evaluateMobilityMatch({
        workplace_type: row.workplace_type ?? undefined,
        location: row.location ?? undefined,
        description: row.current_job_description,
      }, stage3Preferences?.mobility);
      const configuredPriorityWeights = stage3Preferences?.application_priority_weights;
      const priorityWeights: Stage3ApplicationPriorityWeights = configuredPriorityWeights ?? {
        base_rank_pct: 75,
        freshness_pct: 12.5,
        remote_freedom_pct: 12.5,
      };
      const weights = parseRankingWeights(row.ranking_weights);
      const minConfidence = toFiniteNumber(row.minimum_ranking_confidence);
      if (minConfidence === null) throw new Error("The active ranking policy has an invalid confidence threshold.");
      const currentContext =
        row.current_artifact_status === "CURRENT_OR_NOT_APPLICABLE" ||
        row.current_artifact_status === "EVALUATION_MISSING" ||
        row.current_artifact_status === "EVALUATION_STALE";
      const ranking = calculateRanking(
        components,
        {
          gatePassed: row.gate_status === "PASS",
          laneCurrent: Boolean(row.primary_lane?.trim()),
          matchCurrent: row.match_job_content_hash === row.current_job_content_hash,
          deterministicDecisionCurrent: Boolean(row.deterministic_decision_id && row.deterministic_context_fingerprint),
          aiEvaluationCurrent: true,
          contextVersionMismatch: row.version_mismatch,
          policyRecheckRequired: row.policy_recheck_required,
        },
        { weights, minimumRankingConfidence: minConfidence }
      );
      const finalPriorityScore = calculateStage3PriorityScore(
        ranking.overallRankScore,
        {
          freshnessScore: freshness.status === 'UNKNOWN' ? null : freshness.freshness_score,
          remoteFreedomScore: mobility.remote_freedom_score,
        },
        {
          baseRankWeight: priorityWeights.base_rank_pct / 100,
          freshnessWeight: priorityWeights.freshness_pct / 100,
          remoteFreedomWeight: priorityWeights.remote_freedom_pct / 100,
        }
      );
      if (ranking.overallRankScore === null || finalPriorityScore === null) {
        result.incompleteRequiredInputs += 1;
        continue;
      }
      if (options.dryRun === true) {
        result.snapshotsWouldInsert += 1;
        continue;
      }

      const insert = await client.query(
        `INSERT INTO job_ranking_snapshots (
           workspace_id, canonical_job_id, job_version_id, profile_version_id,
           match_run_id, deterministic_decision_id, ai_evaluation_id,
           ranking_policy_version, context_fingerprint,
           requirement_fit_score, requirement_coverage_score,
           evidence_completeness_score, lane_confidence_score, autonomy_score,
           politics_risk_score, sensory_workload_risk_score, strategic_value_score,
           focus_protection_score, building_ratio_score, interaction_burden_score,
           overall_rank_score, ranking_confidence, is_top_ten_ready,
           policy_recheck_required, component_availability, component_provenance,
           base_rank_score, freshness_score, remote_freedom_score,
           final_application_priority_score, remote_from_home_base_score,
           temporary_abroad_score, country_flexibility_score, office_requirement_score,
           timezone_compatibility_score, employment_verifiability_score,
           preference_user_id, preference_context_id
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9,
           $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
           $21, $22, $23, $24, $25::jsonb, $26::jsonb,
           $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38
         ) ON CONFLICT (
           workspace_id, canonical_job_id, job_version_id, profile_version_id,
           match_run_id, deterministic_decision_id, ai_evaluation_id,
           ranking_policy_version, preference_context_id, context_fingerprint
         ) DO NOTHING`,
        [
          row.workspace_id,
          row.canonical_job_id,
          row.job_version_id,
          row.profile_version_id,
          row.match_run_id,
          row.deterministic_decision_id,
          row.evaluation_id,
          row.ranking_policy_version,
          row.deterministic_context_fingerprint,
          components.requirementFit,
          components.requirementCoverage,
          components.evidenceCompleteness,
          components.laneConfidence,
          components.autonomy,
          components.politicsRisk,
          components.sensoryWorkloadRisk,
          components.strategicValue,
          normalizedCultureEvidence(row).find((evidence) => evidence.signal === "FOCUS_PROTECTION")?.score ?? null,
          toFiniteNumber(row.evaluation_payload.building_research_ratio),
          toFiniteNumber(row.evaluation_payload.interaction_load),
          finalPriorityScore,
          ranking.rankingConfidence,
          ranking.topTenReady && currentContext,
          row.policy_recheck_required,
          JSON.stringify(componentAvailability(components, freshness, mobility)),
          JSON.stringify(componentProvenance(row, preferenceContext, freshness, mobility, priorityWeights)),
          ranking.overallRankScore,
          freshness.status === 'UNKNOWN' ? null : freshness.freshness_score,
          mobility.remote_freedom_score,
          finalPriorityScore,
          mobility.remote_from_home_base_score,
          mobility.temporary_abroad_score,
          mobility.country_flexibility_score,
          mobility.office_requirement_score,
          mobility.timezone_compatibility_score,
          null,
          preferenceContext?.contextId ? preferenceContext.userId : null,
          preferenceContext?.contextId ?? null,
        ]
      );
      if ((insert.rowCount ?? 0) > 0) result.snapshotsInserted += 1;
      else result.snapshotsAlreadyCurrent += 1;
    }

    if (options.dryRun === true) {
      await client.query("ROLLBACK");
    } else {
      await client.query("COMMIT");
    }
    committed = true;
    return result;
  } catch (error) {
    if (!committed) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
