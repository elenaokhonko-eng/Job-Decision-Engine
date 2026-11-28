import { AWAITING_REMATCH_NOTE, STORED_SCORE_CARRIED_NOTE } from "../modules/decision/index.js";
import { sourceContentEvidencePredicate } from "./descriptionQuality.js";
import { activeScoringPolicy, matcherPolicyVersionFor } from "./scoringPolicy.js";

/**
 * Which deterministic outcomes are AI-evaluated, and when a job's profile match is current.
 *
 * AI evaluation is reserved for the Apply Now outcomes, PRIORITY and REVIEW. A TRACK outcome is
 * the policy fallback when the deterministic fit evidence is too weak or incomplete for Apply Now
 * (missing requirement/coverage scores, requirement score below the REVIEW threshold, or
 * compensation that blocks Apply Now; see src/policy/decisionPolicy.ts and
 * src/pipeline/recommendationDecider.ts). AI output is advisory (AGENTS.md invariant 11) and cannot
 * promote a TRACK job into Apply Now, and documents for TRACK jobs do not need an AI evaluation
 * (streamlit_application_workflow.py), so TRACK jobs are never sent to the AI queue. They still
 * get a deterministic re-match when the active profile changes, because new profile evidence can
 * move them to PRIORITY or REVIEW, after which the normal DECIDE_RECOMMENDATION successor queues
 * them for AI evaluation.
 */
export const AI_EVALUATION_OUTCOMES = ["PRIORITY", "REVIEW"] as const;

/** Deterministic outcomes that are re-matched when the active profile version changes. */
export const PROFILE_REMATCH_OUTCOMES = ["PRIORITY", "REVIEW", "TRACK"] as const;

/** Processing states the explanation enqueuer accepts; re-matching keeps a job inside them. */
export const AI_ENQUEUE_PROCESSING_STATES = ["LANE_ROUTED", "MATCHED", "QUEUED_FOR_AI", "DEFERRED_BUDGET"] as const;

export type AiEvaluationOutcome = (typeof AI_EVALUATION_OUTCOMES)[number];

export function isAiEvaluationOutcome(outcome: string | null | undefined): outcome is AiEvaluationOutcome {
  return (AI_EVALUATION_OUTCOMES as readonly string[]).includes(outcome ?? "");
}

const TRUSTED_ALIAS = /^[a-z_][a-z0-9_]*$/i;

function alias(value: string, label: string): string {
  if (!TRUSTED_ALIAS.test(value)) throw new Error(`Profile match SQL ${label} must be a trusted alias.`);
  return value;
}

function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

/** SQL list of AI-evaluated outcomes, for `IN (...)`. */
export const AI_EVALUATION_OUTCOMES_SQL = sqlList(AI_EVALUATION_OUTCOMES);

/**
 * SQL predicate: canonical job (alias `c`) is an eligible, routed job in one of the given
 * deterministic outcomes and in a state the explanation enqueuer accepts.
 */
export function eligibleRoutedJobSql(
  canonicalAlias: string,
  outcomes: readonly string[] = AI_EVALUATION_OUTCOMES,
): string {
  const c = alias(canonicalAlias, "canonical alias");
  return `(
    ${c}.archived_at IS NULL
    AND COALESCE(${c}.processing_state, ${c}.processing_status) IN (${sqlList(AI_ENQUEUE_PROCESSING_STATES)})
    AND ${c}.primary_lane IS NOT NULL
    AND ${c}.primary_lane <> 'UNCLASSIFIED'
    AND COALESCE(${c}.recommendation_eligibility, 'VERIFY') = 'ELIGIBLE'
    AND ${c}.recommendation_outcome IN (${sqlList(outcomes)})
  )`;
}

/**
 * SQL subquery returning the single ACTIVE profile version id of the canonical job's workspace,
 * or NULL when there is not exactly one (matching then blocks on PROFILE_VERSION_ACTIVE instead).
 */
export function uniqueActiveProfileSql(canonicalAlias: string): string {
  const c = alias(canonicalAlias, "canonical alias");
  return `(
    SELECT CASE WHEN COUNT(*) = 1 THEN MIN(active_pv.id::text)::uuid END
    FROM profile_versions active_pv
    WHERE active_pv.workspace_id = ${c}.workspace_id
      AND active_pv.status = 'ACTIVE'
  )`;
}

/**
 * Scoring rules version of the deterministic matcher, stored on match_runs.policy_version.
 *
 * Bump it whenever the matcher's scoring changes for the same job, profile and evidence-strength
 * policy. A match run made under another version is superseded when the matcher can re-match the
 * job (complete description with source-content evidence): the stage-task seeder re-matches every
 * such eligible PRIORITY/REVIEW/TRACK job once (see profileMatchSupersededSql), and a
 * MATCH_PROFILE_EVIDENCE task does not treat the older-rules match as current. A job the matcher
 * cannot select keeps its older-rules match rather than getting a re-match task that cannot finish.
 *
 * deterministic_v2: the best fact is chosen by credited contribution (score x evidence strength)
 * instead of raw similarity, and a structured DEGREE/CREDENTIAL match is credited by verification
 * status only, not by the hands-on evidence tier.
 *
 * deterministic_v3: a MUST DEGREE gap is no longer a mandatory-qualification failure (it no longer persists
 * UNMATCHED / INELIGIBLE / SKIP with a rejection reason); the job is ranked lower and flagged instead (#247).
 */
export const DETERMINISTIC_MATCHER_POLICY_VERSION = "deterministic_v3";

/**
 * matcher_version written into the MATCH_PROFILE_EVIDENCE context fingerprint. It moves with
 * DETERMINISTIC_MATCHER_POLICY_VERSION so task currentness (src/tasks/pipelineTaskCurrentness.ts)
 * also treats an older-rules match as not current. The stage task version used in task keys
 * (deterministic_matcher_v1) is deliberately unchanged.
 */
export const DETERMINISTIC_MATCHER_FINGERPRINT_VERSION = "deterministic_matcher_v3";

/**
 * The matcher policy version in force: the legacy version, or the legacy version plus the top-K
 * scoring policy when SCORING_POLICY selects it (see scoringPolicy.ts). Read at call time so the
 * flag moves the matcher, the match-run stamp and task currentness together.
 */
export function currentMatcherPolicyVersion(env: NodeJS.ProcessEnv = process.env): string {
  return matcherPolicyVersionFor(activeScoringPolicy(env), DETERMINISTIC_MATCHER_POLICY_VERSION);
}

export function currentMatcherFingerprintVersion(env: NodeJS.ProcessEnv = process.env): string {
  return matcherPolicyVersionFor(activeScoringPolicy(env), DETERMINISTIC_MATCHER_FINGERPRINT_VERSION);
}

/** SQL predicate: match run (alias `mr`) was scored under the current matcher rules. */
export function currentMatcherPolicySql(matchAlias: string): string {
  const mr = alias(matchAlias, "match alias");
  return `(${mr}.policy_version = '${currentMatcherPolicyVersion()}')`;
}

/**
 * SQL predicate: the canonical job's latest match run (alias `mr`, joined on
 * c.latest_match_run_id) was made for the latest job version against a profile version that is no
 * longer the unique active one, or under superseded matcher scoring rules
 * (DETERMINISTIC_MATCHER_POLICY_VERSION) for a job the matcher can select (the same
 * description-quality and source-content conditions as src/pipeline/deterministicMatcher.ts).
 * Lane routing and hard gates are not part of this check: a re-match never replays them.
 */
export function profileMatchSupersededSql(canonicalAlias: string, matchAlias: string): string {
  const c = alias(canonicalAlias, "canonical alias");
  const mr = alias(matchAlias, "match alias");
  return `(
    ${mr}.id IS NOT NULL
    AND ${mr}.id = ${c}.latest_match_run_id
    AND ${mr}.job_version_id = ${c}.latest_job_version_id
    AND ${uniqueActiveProfileSql(c)} IS NOT NULL
    AND (
      ${mr}.profile_version_id IS DISTINCT FROM ${uniqueActiveProfileSql(c)}
      OR (
        ${mr}.policy_version IS DISTINCT FROM '${currentMatcherPolicyVersion()}'
        AND ${c}.description_quality_status = 'COMPLETE'
        AND ${sourceContentEvidencePredicate(`${c}.workspace_id`, `${c}.latest_job_version_id`)}
      )
    )
  )`;
}

/**
 * SQL predicate: an UNMATCHED job that was parked by the matcher (routing_disposition ROUTED: lane routing found a lane, a
 * match run then failed a mandatory qualification) whose latest match run was made under another matcher policy version, for a
 * job the matcher can select. A version change reopens work for every stage (a rule that no longer fails the job removes the
 * parking), so the job is re-matched once under the current rules. A job parked by the CURRENT matcher policy stays UNMATCHED and
 * is not selected. Not a POLICY_NO_MATCH job (the lane router owns those: routing_disposition is not ROUTED, there is no match
 * run). Selectable means what the matcher and its handler need to finish: a lane, a complete description with source content,
 * and an active requirement set whose deterministic extraction completed. The re-match never replays hard gates or lane
 * routing and changes neither.
 */
export function unmatchedParkedByOtherMatcherSql(
  canonicalAlias: string,
  matchAlias: string,
  /** The caller has already resolved the unique ACTIVE profile (the matcher does and throws without one). */
  options: { activeProfileResolved?: boolean } = {},
): string {
  const c = alias(canonicalAlias, "canonical alias");
  const mr = alias(matchAlias, "match alias");
  return `(
    ${c}.archived_at IS NULL
    AND COALESCE(${c}.processing_state, ${c}.processing_status) = 'UNMATCHED'
    AND ${c}.routing_disposition = 'ROUTED'
    AND ${c}.primary_lane IS NOT NULL
    AND ${c}.primary_lane <> 'UNCLASSIFIED'
    AND ${mr}.id IS NOT NULL
    AND ${mr}.id = ${c}.latest_match_run_id
    AND ${mr}.job_version_id = ${c}.latest_job_version_id
    ${options.activeProfileResolved ? "" : `AND ${uniqueActiveProfileSql(c)} IS NOT NULL`}
    AND ${mr}.policy_version IS DISTINCT FROM '${currentMatcherPolicyVersion()}'
    AND ${c}.description_quality_status = 'COMPLETE'
    AND ${sourceContentEvidencePredicate(`${c}.workspace_id`, `${c}.latest_job_version_id`)}
    AND EXISTS (
      SELECT 1
      FROM job_versions parked_jv
      JOIN job_version_pipeline_state parked_ps
        ON parked_ps.workspace_id = parked_jv.workspace_id AND parked_ps.job_version_id = parked_jv.id
       AND parked_ps.current_stage = 'REQUIREMENTS_EXTRACTED' AND parked_ps.stage_status = 'COMPLETED'
      JOIN requirement_extraction_runs parked_rer
        ON parked_rer.workspace_id = parked_jv.workspace_id AND parked_rer.job_version_id = parked_jv.id
       AND parked_rer.run_type = 'DETERMINISTIC' AND parked_rer.status = 'COMPLETED'
       AND parked_rer.requirement_set_id = parked_jv.active_requirement_set_id
      WHERE parked_jv.workspace_id = ${c}.workspace_id AND parked_jv.id = ${c}.latest_job_version_id
        AND parked_jv.active_requirement_set_id IS NOT NULL
    )
  )`;
}

/**
 * SQL predicate: the latest match run (alias `mr`) is current for the latest job version (alias
 * `jv`) and the unique active profile. Same conditions as the explanation enqueuer's match join.
 */
export function currentProfileMatchSql(canonicalAlias: string, matchAlias: string, jobVersionAlias: string): string {
  const c = alias(canonicalAlias, "canonical alias");
  const mr = alias(matchAlias, "match alias");
  const jv = alias(jobVersionAlias, "job version alias");
  return `(
    ${mr}.id IS NOT NULL
    AND ${mr}.id = ${c}.latest_match_run_id
    AND ${mr}.job_version_id = ${jv}.id
    AND ${jv}.id = ${c}.latest_job_version_id
    AND ${mr}.profile_version_id = ${uniqueActiveProfileSql(c)}
    AND ${mr}.requirement_set_id = ${jv}.active_requirement_set_id
    AND ${mr}.job_content_hash = ${jv}.content_hash
    AND ${mr}.status = 'COMPLETED'
  )`;
}

/**
 * SQL predicate: the latest deterministic decision (alias `dd`, joined on
 * c.latest_deterministic_decision_id) was made from the latest match run, as the explanation
 * enqueuer requires.
 */
export function decisionOnLatestMatchSql(canonicalAlias: string, decisionAlias: string): string {
  const c = alias(canonicalAlias, "canonical alias");
  const dd = alias(decisionAlias, "decision alias");
  return `(
    ${dd}.id IS NOT NULL
    AND ${dd}.id = ${c}.latest_deterministic_decision_id
    AND ${dd}.canonical_job_id = ${c}.id
    AND ${dd}.job_version_id = ${c}.latest_job_version_id
    AND ${dd}.match_run_id = ${c}.latest_match_run_id
    AND ${dd}.context_fingerprint IS NOT NULL
  )`;
}

/**
 * SQL predicate: the decision (alias `dd`) carried a stored score forward instead of computing one. An old score never
 * sends a job to AI, so such a decision is never enqueued for evaluation.
 */
export function carriedScoreDecisionSql(decisionAlias: string): string {
  const dd = alias(decisionAlias, "decision alias");
  return `COALESCE(${dd}.decision_json->'trace'->'notes' ?| ARRAY['${STORED_SCORE_CARRIED_NOTE}', '${AWAITING_REMATCH_NOTE}'], FALSE)`;
}

/**
 * SQL predicate: the job (alias `c` = canonical_jobs) was restored from the archive and no match has completed since.
 * Until then it keeps the result it had before, whatever match run is still on record, and is never sent to AI.
 */
export function restoredAwaitingRematchSql(canonicalAlias: string): string {
  const c = alias(canonicalAlias, "canonical alias");
  return `EXISTS (
    SELECT 1 FROM job_archive_events restore_event
     WHERE restore_event.workspace_id = ${c}.workspace_id AND restore_event.canonical_job_id = ${c}.id
       AND restore_event.action IN ('RESTORED', 'REPOST_REACTIVATED')
       AND NOT EXISTS (
         SELECT 1 FROM match_runs rematch
          WHERE rematch.workspace_id = ${c}.workspace_id AND rematch.canonical_job_id = ${c}.id
            AND rematch.status = 'COMPLETED' AND rematch.started_at > restore_event.event_at))`;
}
