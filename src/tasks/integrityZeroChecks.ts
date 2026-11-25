/**
 * Must-be-zero checks for the rehearsal and for every reconcile run. Each check returns a count and a
 * short sample of ids (never titles or employers); any count above zero is an error. Read only.
 * Wired into scripts/reconcile_pipeline.ts and scripts/check_integrity.ts, so the scripts hold no SQL.
 */
import type pg from "pg";

import { OWNER_SAVED_SOURCE_NAMES } from "../services/jobArchiveHardRejectedPolicy.js";
import { GATE_VERSION } from "../contracts/version.js";
import { deciderVersionRefreshSql } from "../pipeline/deciderVersion.js";
import { sourceContentEvidencePredicate } from "../pipeline/descriptionQuality.js";
import { LANE_ROUTER_RULE_VERSION } from "../pipeline/laneRouter.js";
import { DETERMINISTIC_EXTRACTOR_VERSION } from "../requirements/deterministicExtractors.js";
import { routableWorkabilityVerificationSql } from "../pipeline/verificationRouting.js";
import { ROUTABLE_VERIFICATION_SQL, supersededProfileMatchSql } from "./stageTaskWorker.js";
import { findTasksCompletedWithoutResult } from "./completedWithoutResult.js";

type Queryable = Pick<pg.PoolClient, "query">;

export interface ZeroCheckResult {
  readonly name: string;
  readonly total: number;
  readonly sample: readonly string[];
  readonly detail?: Record<string, number>;
}

const SAMPLE = 10;

function result(name: string, ids: readonly string[], detail?: Record<string, number>): ZeroCheckResult {
  return { name, total: ids.length, sample: ids.slice(0, SAMPLE), ...(detail ? { detail } : {}) };
}

/** A job whose latest gate result is HARD_REJECT still carries a recommendation. */
export async function rejectedJobsWithRecommendation(db: Queryable, workspaceId: string): Promise<ZeroCheckResult> {
  const { rows } = await db.query<{ id: string }>(
    `WITH latest AS (
       SELECT DISTINCT ON (canonical_job_id) canonical_job_id, decision
         FROM gate_decisions WHERE workspace_id = $1::uuid
        ORDER BY canonical_job_id, created_at DESC, id DESC)
     SELECT c.id::text AS id
       FROM canonical_jobs c JOIN latest l ON l.canonical_job_id = c.id
      WHERE c.workspace_id = $1::uuid AND l.decision = 'HARD_REJECT' AND c.archived_at IS NULL AND NOT c.is_test_fixture
        AND (c.recommendation_outcome IN ('PRIORITY', 'REVIEW', 'TRACK') OR c.recommendation_eligibility IN ('ELIGIBLE', 'VERIFY'))
      ORDER BY c.id`,
    [workspaceId],
  );
  return result("rejected_job_with_recommendation", rows.map((row) => row.id));
}

/** A job in the Apply Now or Top 10 list whose current version is not confirmed open (v_job_availability_current). */
export const LISTED_JOB_VIEWS: Readonly<Record<string, string>> = {
  apply_now: "v_apply_now_jobs_stage3_scoped",
  top_10: "v_top_ten_ready_jobs_stage3_scoped",
};

export async function listedJobsNotCurrentlyOpen(
  db: Queryable,
  workspaceId: string,
  lists: Readonly<Record<string, string>> = LISTED_JOB_VIEWS,
): Promise<ZeroCheckResult> {
  for (const view of Object.values(lists)) {
    if (!/^[a-z_][a-z0-9_]*$/.test(view)) throw new Error("A listed-job view name must be a plain identifier.");
  }
  const ids: string[] = [];
  const detail: Record<string, number> = {};
  for (const [label, view] of Object.entries(lists)) {
    const { rows } = await db.query<{ id: string }>(
      `SELECT DISTINCT listed.canonical_job_id::text AS id
         FROM ${view} listed
         LEFT JOIN v_job_availability_current availability
           ON availability.workspace_id = listed.workspace_id
          AND availability.canonical_job_id = listed.canonical_job_id
          AND availability.job_version_id::text = listed.job_version_id::text
        WHERE listed.workspace_id = $1::uuid
          AND NOT COALESCE(availability.availability_current, FALSE)
        ORDER BY 1`,
      [workspaceId],
    );
    detail[label] = rows.length;
    ids.push(...rows.map((row) => `${label}:${row.id}`));
  }
  return result("listed_job_not_currently_open", ids, detail);
}

/** A task COMPLETED with no result row, including RECHECK_AVAILABILITY. */
export async function completedTasksWithoutResult(db: Queryable, workspaceId: string): Promise<ZeroCheckResult> {
  const report = await findTasksCompletedWithoutResult(db, workspaceId, { sampleLimit: SAMPLE });
  return { name: "task_completed_without_result", total: report.total, sample: report.sample.map((row) => row.taskId), detail: report.byTaskType };
}

/** A routable NEEDS_VERIFICATION job with no active task and no match run: nothing will carry it on. */
export async function routableVerificationJobsStranded(db: Queryable, workspaceId: string): Promise<ZeroCheckResult> {
  // Active task targets are collected once; each job is then matched by equality (two hashed semi-joins),
  // not by an OR over JSON keys inside a per-job scan.
  const { rows } = await db.query<{ id: string }>(
    `WITH active AS (
       SELECT task.payload->>'canonical_job_id' AS canonical_job_id, task.payload->>'job_version_id' AS job_version_id
         FROM pipeline_tasks task
        WHERE task.workspace_id = $1::uuid AND task.status IN ('PENDING', 'RUNNING', 'RETRY_WAIT', 'BLOCKED_DEPENDENCY'))
     SELECT c.id::text AS id
       FROM canonical_jobs c
      WHERE c.workspace_id = $1::uuid AND c.archived_at IS NULL AND NOT c.is_test_fixture
        AND ${routableWorkabilityVerificationSql("c")}
        AND c.latest_match_run_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM active a WHERE a.canonical_job_id = c.id::text)
        AND NOT EXISTS (SELECT 1 FROM active a WHERE a.job_version_id = c.latest_job_version_id::text)
      ORDER BY c.id`,
    [workspaceId],
  );
  return result("routable_verification_job_stranded", rows.map((row) => row.id));
}

/**
 * A job the owner saved, applied to or held BEFORE any automatic archive rule archived it (age rule, hard-reject
 * rule, snippet expiry, availability re-check, link repair). Any archive whose reason is not a manual one counts,
 * and the protection must predate the archive and have been in force at that moment (a hold counts only if not
 * released and not expired then). A job saved or held after a legitimate archive is not a violation. The detail
 * counts violations per archive reason (POSTING_NOT_CONFIRMABLE is always present).
 */
export async function protectedJobsAutoArchived(db: Queryable, workspaceId: string): Promise<ZeroCheckResult> {
  const { rows } = await db.query<{ id: string; archive_reason: string | null }>(
    `SELECT c.id::text AS id, c.archive_reason
       FROM canonical_jobs c
      WHERE c.workspace_id = $1::uuid AND c.archived_at IS NOT NULL
        AND UPPER(COALESCE(c.archive_reason, '')) NOT LIKE 'MANUAL%'
        AND (
          EXISTS (SELECT 1 FROM job_versions v JOIN raw_job_observations o
                    ON o.workspace_id = v.workspace_id AND o.job_version_id = v.id
                   WHERE v.workspace_id = c.workspace_id AND v.canonical_job_id = c.id
                     AND UPPER(o.source_name) = ANY($2::text[]) AND o.retrieved_at < c.archived_at)
          OR EXISTS (SELECT 1 FROM application_records a
                      WHERE a.workspace_id = c.workspace_id AND a.canonical_job_id = c.id
                        AND a.created_at < c.archived_at AND a.status NOT IN ('REJECTED', 'WITHDRAWN', 'CLOSED'))
          OR EXISTS (SELECT 1 FROM job_archive_holds h
                      WHERE h.workspace_id = c.workspace_id AND h.canonical_job_id = c.id
                        AND h.hold_type = 'USER_PRESERVE' AND h.created_at < c.archived_at
                        AND h.expires_at > c.archived_at AND (h.released_at IS NULL OR h.released_at > c.archived_at))
        )
      ORDER BY c.id`,
    [workspaceId, [...OWNER_SAVED_SOURCE_NAMES]],
  );
  const detail: Record<string, number> = { POSTING_NOT_CONFIRMABLE: 0 };
  for (const row of rows) detail[row.archive_reason ?? "UNKNOWN"] = (detail[row.archive_reason ?? "UNKNOWN"] ?? 0) + 1;
  return result("protected_job_auto_archived", rows.map((row) => row.id), detail);
}

/**
 * Live jobs (alias c) the DECIDE seed can reach AND the DECIDE handler can stamp: an outcome, a complete posting with source
 * content, a state past lane routing, and either a state the seed always selects (HARD_REJECTED, NEEDS_VERIFICATION,
 * ROUTING_DEFERRED) or a current completed match run. Equal to the seed's own WHERE (stageTaskWorker.ts), so the check can
 * be zero after a drain. Jobs outside it (UNMATCHED without a match run, LANE_ROUTED without a match) are reported by
 * `reportedDecisionCounts`, never failed.
 */
const DECIDER_REACHABLE_SQL = `COALESCE(c.processing_state, c.processing_status) NOT IN ('RAW_STAGED', 'PREQUALIFIED', 'MANUALLY_REMOVED')
             AND c.recommendation_outcome IS NOT NULL
             AND c.latest_job_version_id IS NOT NULL
             AND c.description_quality_status = 'COMPLETE'
             AND ${sourceContentEvidencePredicate("c.workspace_id", "c.latest_job_version_id")}
             AND (
               COALESCE(c.processing_state, c.processing_status) IN ('HARD_REJECTED', 'NEEDS_VERIFICATION', 'ROUTING_DEFERRED')
               OR EXISTS (
                 SELECT 1
                   FROM job_versions target_jv
                   JOIN profile_versions current_profile
                     ON current_profile.workspace_id = target_jv.workspace_id AND current_profile.status = 'ACTIVE'
                   JOIN match_runs current_match
                     ON current_match.workspace_id = c.workspace_id AND current_match.canonical_job_id = c.id
                    AND current_match.id = c.latest_match_run_id AND current_match.job_version_id = target_jv.id
                    AND current_match.profile_version_id = current_profile.id
                    AND current_match.requirement_set_id = target_jv.active_requirement_set_id
                    AND current_match.job_content_hash = target_jv.content_hash
                    AND current_match.context_fingerprint IS NOT NULL AND current_match.status = 'COMPLETED'
                  WHERE target_jv.workspace_id = c.workspace_id AND target_jv.id = c.latest_job_version_id
               )
             )`;

export interface ReportedDecisionCounts {
  /** Live jobs with an outcome and a stale or unstamped latest decision that no seed reaches, by state. Never an error. */
  readonly unseeded_stale_decisions: Record<string, number>;
  /** Live jobs with an outcome but no latest decision at all, by state. The decider-version seed needs a decision to compare. Never an error. */
  readonly outcome_without_latest_decision: Record<string, number>;
}

/** Visibility only: states the decider-version seed cannot reach must not stay invisible, and must not fail a reconcile. */
export async function reportedDecisionCounts(db: Queryable, workspaceId: string): Promise<ReportedDecisionCounts> {
  const count = async (extra: string): Promise<Record<string, number>> => {
    const { rows } = await db.query<{ state: string; n: number }>(
      `SELECT COALESCE(c.processing_state, c.processing_status) AS state, COUNT(*)::int AS n
         FROM canonical_jobs c
        WHERE c.workspace_id = $1::uuid AND c.archived_at IS NULL AND NOT c.is_test_fixture
          AND COALESCE(c.processing_state, c.processing_status) <> 'MANUALLY_REMOVED'
          AND c.recommendation_outcome IS NOT NULL
          ${extra}
        GROUP BY 1 ORDER BY 1`,
      [workspaceId],
    );
    return Object.fromEntries(rows.map((row) => [row.state, row.n]));
  };
  return {
    unseeded_stale_decisions: await count(`AND ${deciderVersionRefreshSql("c")} AND NOT (${DECIDER_REACHABLE_SQL})`),
    outcome_without_latest_decision: await count("AND c.latest_deterministic_decision_id IS NULL"),
  };
}

/**
 * A stage result the version-reopen seeds in stageTaskWorker.ts would reopen, per stage: narrower than "any
 * older version", it equals the seed conditions (the matcher check reuses supersededProfileMatchSql, the lane
 * router check lists only the states a rule-version bump reopens, the extractor check leaves out versions
 * blocked on JOB_CONTENT). A job no seed reopens is never counted, so the strict post-drain reconcile cannot
 * stay red on it. After the seeds have drained it must be zero. */
export async function staleStageResults(db: Queryable, workspaceId: string): Promise<ZeroCheckResult> {
  const stages: Record<string, { sql: string; params: unknown[] }> = {
    extractor: {
      sql: `SELECT c.id::text AS id
              FROM canonical_jobs c
              JOIN job_versions jv ON jv.workspace_id = c.workspace_id AND jv.id = c.latest_job_version_id
              JOIN requirement_sets rs ON rs.workspace_id = jv.workspace_id AND rs.id = jv.active_requirement_set_id
              JOIN requirement_set_identities ri ON ri.workspace_id = rs.workspace_id AND ri.id = rs.requirement_identity_id
             WHERE c.workspace_id = $1::uuid AND c.archived_at IS NULL AND NOT c.is_test_fixture
               AND COALESCE(c.processing_state, c.processing_status) IN
                   ('RAW_STAGED', 'PREQUALIFIED', 'LANE_ROUTED', 'ROUTING_DEFERRED', 'MATCHED', 'QUEUED_FOR_AI', 'EVALUATING', 'AI_EVALUATED', 'EVALUATED')
               AND ri.deterministic_extractor_version IS DISTINCT FROM $2
               -- The seed leaves a version blocked on missing posting content alone: it resumes when the content arrives.
               AND NOT EXISTS (
                 SELECT 1 FROM pipeline_tasks blocked
                  WHERE blocked.workspace_id = c.workspace_id AND blocked.task_type = 'EXTRACT_DETERMINISTIC_REQUIREMENTS'
                    AND blocked.status = 'BLOCKED_DEPENDENCY' AND blocked.blocked_on = 'JOB_CONTENT'
                    AND blocked.payload->>'job_version_id' = jv.id::text)`,
      params: [DETERMINISTIC_EXTRACTOR_VERSION],
    },
    // Exactly the jobs the MATCH_PROFILE_EVIDENCE re-match seed selects: the seed's own predicates
    // (eligible, routed, PRIORITY/REVIEW/TRACK, unique active profile, complete description with source
    // content, latest match under another profile or policy version). Not a filter of its own.
    matcher: {
      sql: `SELECT c.id::text AS id
              FROM canonical_jobs c
              JOIN match_runs mr ON mr.workspace_id = c.workspace_id AND mr.id = c.latest_match_run_id
             WHERE c.workspace_id = $1::uuid AND NOT c.is_test_fixture
               AND ${supersededProfileMatchSql()}`,
      params: [],
    },
    // Only what a router RULE-version bump reopens in the ROUTE_LANE seed: PREQUALIFIED, routable
    // verification, ROUTING_DEFERRED (technical) and UNMATCHED with POLICY_NO_MATCH, each with a published
    // job-version embedding and not blocked on missing content. LANE_ROUTED, MATCHED and DEFERRED_BUDGET are
    // reopened only when the lane routing CONTENT changes (SUPERSEDED_LANE_ROUTING_SQL), never by rule version.
    lane_router: {
      sql: `SELECT c.id::text AS id
              FROM canonical_jobs c
              JOIN job_versions jv ON jv.workspace_id = c.workspace_id AND jv.id = c.latest_job_version_id
              JOIN lane_decisions ld ON ld.workspace_id = c.workspace_id AND ld.id = c.latest_lane_decision_id
             WHERE c.workspace_id = $1::uuid AND c.archived_at IS NULL AND NOT c.is_test_fixture
               AND (
                 COALESCE(c.processing_state, c.processing_status) = 'PREQUALIFIED'
                 OR ${ROUTABLE_VERIFICATION_SQL}
                 OR (COALESCE(c.processing_state, c.processing_status) = 'ROUTING_DEFERRED'
                     AND COALESCE(c.routing_disposition, 'TECHNICAL_DEFERRED') = 'TECHNICAL_DEFERRED')
                 OR (COALESCE(c.processing_state, c.processing_status) = 'UNMATCHED' AND c.routing_disposition = 'POLICY_NO_MATCH')
               )
               AND EXISTS (
                 SELECT 1 FROM embedding_inputs ei
                   JOIN v_published_semantic_embeddings se ON se.workspace_id = ei.workspace_id AND se.embedding_input_id = ei.id
                  WHERE ei.workspace_id = c.workspace_id AND ei.source_type = 'JOB_VERSION' AND ei.source_id = jv.id)
               AND NOT EXISTS (
                 SELECT 1 FROM pipeline_tasks blocked
                  WHERE blocked.workspace_id = c.workspace_id AND blocked.task_type = 'ROUTE_LANE'
                    AND blocked.status = 'BLOCKED_DEPENDENCY' AND blocked.blocked_on = 'JOB_CONTENT'
                    AND blocked.payload->>'job_version_id' = jv.id::text)
               AND LEFT(ld.model_version, LENGTH($2)) IS DISTINCT FROM $2`,
      params: [LANE_ROUTER_RULE_VERSION],
    },
  };
  // Seed-equal, like the stages above. decider: the DECIDE seed's decider-version arm (a live job whose latest decision
  // has another or no decider_version), limited to what the decider itself processes (complete description with source
  // content). gate: the gate version seed (latest gate decision older than the running version, no gate task in flight).
  stages.decider = {
    sql: `SELECT c.id::text AS id
            FROM canonical_jobs c
           WHERE c.workspace_id = $1::uuid AND c.archived_at IS NULL AND NOT c.is_test_fixture
             AND ${DECIDER_REACHABLE_SQL}
             AND ${deciderVersionRefreshSql("c")}`,
    params: [],
  };
  stages.gate = {
    sql: `SELECT c.id::text AS id
            FROM canonical_jobs c
            JOIN job_versions jv ON jv.workspace_id = c.workspace_id AND jv.id = c.latest_job_version_id
            JOIN LATERAL (
              SELECT gate.gate_version FROM gate_decisions gate
               WHERE gate.workspace_id = c.workspace_id AND gate.job_version_id = jv.id
               ORDER BY gate.created_at DESC, gate.id DESC LIMIT 1
            ) latest_gate ON TRUE
           WHERE c.workspace_id = $1::uuid AND c.archived_at IS NULL AND NOT c.is_test_fixture
             AND COALESCE(c.processing_state, c.processing_status) NOT IN ('RAW_STAGED', 'MANUALLY_REMOVED')
             AND c.description_quality_status = 'COMPLETE'
             AND ${sourceContentEvidencePredicate("c.workspace_id", "jv.id")}
             AND CASE WHEN latest_gate.gate_version ~ '^(gate-)?[0-9]{1,17}([-.][0-9]{1,17})*$'
                 THEN regexp_split_to_array(regexp_replace(latest_gate.gate_version, '^gate-', ''), '[-.]')::bigint[]
                      < regexp_split_to_array(regexp_replace($2::text, '^gate-', ''), '[-.]')::bigint[]
                 ELSE TRUE END
             AND NOT EXISTS (
               SELECT 1 FROM pipeline_tasks inflight
                WHERE inflight.workspace_id = c.workspace_id AND inflight.task_type = 'APPLY_HARD_GATES'
                  AND inflight.status IN ('PENDING', 'RUNNING', 'RETRY_WAIT', 'BLOCKED_DEPENDENCY')
                  AND inflight.payload->>'job_version_id' = jv.id::text)`,
    params: [GATE_VERSION],
  };
  const ids: string[] = [];
  const detail: Record<string, number> = {};
  for (const [stage, query] of Object.entries(stages)) {
    const { rows } = await db.query<{ id: string }>(query.sql, [workspaceId, ...query.params]);
    detail[stage] = rows.length;
    ids.push(...rows.map((row) => `${stage}:${row.id}`));
  }
  return result("stage_result_older_than_rule_version", ids, detail);
}

/**
 * `phase` "pre" is for a run BEFORE a drain: it leaves out the stale-stage check, which is non-zero by design
 * right after a rule-version change until the reopen seeds have drained. The default, "post", is strict
 * and runs every check.
 */
export async function runZeroChecks(
  db: Queryable,
  workspaceId: string,
  options: { phase?: "pre" | "post" } = {},
): Promise<ZeroCheckResult[]> {
  const stale = options.phase === "pre" ? [] : [await staleStageResults(db, workspaceId)];
  return [
    await rejectedJobsWithRecommendation(db, workspaceId),
    await listedJobsNotCurrentlyOpen(db, workspaceId),
    await completedTasksWithoutResult(db, workspaceId),
    await routableVerificationJobsStranded(db, workspaceId),
    await protectedJobsAutoArchived(db, workspaceId),
    ...stale,
  ];
}

export function zeroChecksExitCode(results: readonly Pick<ZeroCheckResult, "total">[]): 0 | 1 {
  return results.some((check) => check.total > 0) ? 1 : 0;
}
