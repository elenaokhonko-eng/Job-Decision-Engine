/**
 * Must-be-zero checks for the rehearsal and for every reconcile run. Each check returns a count and a
 * short sample of ids (never titles or employers); any count above zero is an error. Read only.
 * Wired into scripts/reconcile_pipeline.ts and scripts/check_integrity.ts, so the scripts hold no SQL.
 */
import type pg from "pg";

import { AVAILABILITY_RECHECK_ARCHIVE_RULE } from "../services/jobArchive.js";
import { OWNER_SAVED_SOURCE_NAMES } from "../services/jobArchiveHardRejectedPolicy.js";
import { routableWorkabilityVerificationSql } from "../pipeline/verificationRouting.js";
import { GATE_VERSION } from "../contracts/version.js";
import { currentMatcherPolicyVersion } from "../pipeline/profileMatchCurrency.js";
import { LANE_ROUTER_RULE_VERSION } from "../pipeline/laneRouter.js";
import { DETERMINISTIC_EXTRACTOR_VERSION } from "../requirements/deterministicExtractors.js";
import { findTasksCompletedWithoutResult } from "./completedWithoutResult.js";
import { reportAggregatorLeadsInRanking } from "../ingestion/leadRankingCheck.js";

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
 * A job the owner saved, applied to or held BEFORE the availability re-check archived it as not
 * confirmable. Only archives made by that rule (latest ARCHIVED event details.rule) count, and the
 * protection must predate the archive and have been in force at that moment (a hold counts only if not
 * released and not expired then). A job saved or held after a legitimate archive is not a violation.
 */
export async function protectedJobsAutoArchived(db: Queryable, workspaceId: string): Promise<ZeroCheckResult> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT c.id::text AS id
       FROM canonical_jobs c
       JOIN LATERAL (
         SELECT event.details->>'rule' AS rule
           FROM job_archive_events event
          WHERE event.workspace_id = c.workspace_id AND event.canonical_job_id = c.id AND event.action = 'ARCHIVED'
          ORDER BY event.event_at DESC, event.id DESC
          LIMIT 1
       ) archived_by ON archived_by.rule = $3
      WHERE c.workspace_id = $1::uuid AND c.archived_at IS NOT NULL AND c.archive_reason = 'POSTING_NOT_CONFIRMABLE'
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
    [workspaceId, [...OWNER_SAVED_SOURCE_NAMES], AVAILABILITY_RECHECK_ARCHIVE_RULE],
  );
  return result("protected_job_auto_archived", rows.map((row) => row.id), { POSTING_NOT_CONFIRMABLE: rows.length });
}

/**
 * A stage result older than the current rule version, per stage, for live jobs: the extractor (requirement
 * set made by an older extractor version), the gate (latest gate decision under an older GATE_VERSION),
 * the matcher (latest match run under an older policy version) and the lane router (latest lane decision
 * not stamped with the current router rule version). The decider joins when it stores its version.
 * Staleness is visible after a run: after the version-reopen seeds have drained it must be zero.
 */
export async function staleStageResults(db: Queryable, workspaceId: string): Promise<ZeroCheckResult> {
  const stages: Record<string, { sql: string; params: unknown[] }> = {
    extractor: {
      sql: `SELECT c.id::text AS id
              FROM canonical_jobs c
              JOIN job_versions jv ON jv.workspace_id = c.workspace_id AND jv.id = c.latest_job_version_id
              JOIN requirement_sets rs ON rs.workspace_id = jv.workspace_id AND rs.id = jv.active_requirement_set_id
              JOIN requirement_set_identities ri ON ri.workspace_id = rs.workspace_id AND ri.id = rs.requirement_identity_id
             WHERE c.workspace_id = $1::uuid AND c.archived_at IS NULL AND NOT c.is_test_fixture
               AND ri.deterministic_extractor_version IS DISTINCT FROM $2`,
      params: [DETERMINISTIC_EXTRACTOR_VERSION],
    },
    gate: {
      sql: `SELECT c.id::text AS id
              FROM canonical_jobs c
              JOIN LATERAL (SELECT g.gate_version FROM gate_decisions g
                             WHERE g.workspace_id = c.workspace_id AND g.job_version_id = c.latest_job_version_id
                             ORDER BY g.created_at DESC, g.id DESC LIMIT 1) latest_gate ON TRUE
             WHERE c.workspace_id = $1::uuid AND c.archived_at IS NULL AND NOT c.is_test_fixture
               AND COALESCE(c.processing_state, c.processing_status) NOT IN ('RAW_STAGED', 'MANUALLY_REMOVED')
               AND latest_gate.gate_version IS DISTINCT FROM $2`,
      params: [GATE_VERSION],
    },
    matcher: {
      sql: `SELECT c.id::text AS id
              FROM canonical_jobs c
              JOIN match_runs mr ON mr.workspace_id = c.workspace_id AND mr.id = c.latest_match_run_id
             WHERE c.workspace_id = $1::uuid AND c.archived_at IS NULL AND NOT c.is_test_fixture
               AND mr.policy_version IS DISTINCT FROM $2`,
      params: [currentMatcherPolicyVersion()],
    },
    lane_router: {
      sql: `SELECT c.id::text AS id
              FROM canonical_jobs c
              JOIN lane_decisions ld ON ld.workspace_id = c.workspace_id AND ld.id = c.latest_lane_decision_id
             WHERE c.workspace_id = $1::uuid AND c.archived_at IS NULL AND NOT c.is_test_fixture
               AND LEFT(ld.model_version, LENGTH($2)) IS DISTINCT FROM $2`,
      params: [LANE_ROUTER_RULE_VERSION],
    },
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

/** A ranked job backed only by an aggregator lead (src/ingestion/leadRankingCheck.ts owns the rule and the query). */
export async function aggregatorLeadsInRanking(db: Queryable, workspaceId: string): Promise<ZeroCheckResult> {
  const report = await reportAggregatorLeadsInRanking(db, workspaceId);
  return { name: "aggregator_lead_in_ranking", total: report.count, sample: report.sample.slice(0, SAMPLE) };
}

export async function runZeroChecks(db: Queryable, workspaceId: string): Promise<ZeroCheckResult[]> {
  return [
    await rejectedJobsWithRecommendation(db, workspaceId),
    await listedJobsNotCurrentlyOpen(db, workspaceId),
    await completedTasksWithoutResult(db, workspaceId),
    await routableVerificationJobsStranded(db, workspaceId),
    await protectedJobsAutoArchived(db, workspaceId),
    await staleStageResults(db, workspaceId),
    await aggregatorLeadsInRanking(db, workspaceId),
  ];
}

export function zeroChecksExitCode(results: readonly Pick<ZeroCheckResult, "total">[]): 0 | 1 {
  return results.some((check) => check.total > 0) ? 1 : 0;
}
