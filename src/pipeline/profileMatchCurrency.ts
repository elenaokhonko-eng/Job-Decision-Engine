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
 * SQL predicate: the canonical job's latest match run (alias `mr`, joined on
 * c.latest_match_run_id) was made for the latest job version against a profile version that is no
 * longer the unique active one. Lane routing and hard gates are not part of this check: a
 * re-match never replays them.
 */
export function profileMatchSupersededSql(canonicalAlias: string, matchAlias: string): string {
  const c = alias(canonicalAlias, "canonical alias");
  const mr = alias(matchAlias, "match alias");
  return `(
    ${mr}.id IS NOT NULL
    AND ${mr}.id = ${c}.latest_match_run_id
    AND ${mr}.job_version_id = ${c}.latest_job_version_id
    AND ${uniqueActiveProfileSql(c)} IS NOT NULL
    AND ${mr}.profile_version_id IS DISTINCT FROM ${uniqueActiveProfileSql(c)}
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
