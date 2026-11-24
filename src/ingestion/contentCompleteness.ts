import type pg from "pg";

/**
 * "Awaiting content": a live job whose posting text has not reached the completeness rule.
 *
 * Such a job has no gate result, lane or recommendation. The hard gate, lane router and matcher already refuse to
 * start for it (src/pipeline/hardGate.ts requires description_quality_status = 'COMPLETE' and
 * sourceContentEvidencePredicate). This module is the other half: it finds outputs that exist anyway (left by an
 * older rule or by a description that changed), so a reconciliation can fail loudly instead of the owner finding
 * them in Review. It only reads. The read models hide the same jobs through v_job_content_state (migration 120).
 */

export type AwaitingContentReason = "DESCRIPTION_NOT_COMPLETE" | "NO_RETRIEVED_POSTING_EVIDENCE";

/**
 * Pure statement of the rule (a version with no observation at all is a different defect, not a content wait); v_job_content_state states it in SQL and a parity test compares the two.
 */
export function classifyContentCompleteness(input: {
  descriptionQualityStatus: string | null;
  /** The current version has at least one stored observation. */
  hasObservation: boolean;
  /** At least one observation is not a bare Gmail alert, or records source_content_status COMPLETE. */
  hasRetrievedPostingEvidence: boolean;
}): { complete: true; reason: null } | { complete: false; reason: AwaitingContentReason } {
  if (input.descriptionQualityStatus !== "COMPLETE") return { complete: false, reason: "DESCRIPTION_NOT_COMPLETE" };
  if (input.hasObservation && !input.hasRetrievedPostingEvidence) return { complete: false, reason: "NO_RETRIEVED_POSTING_EVIDENCE" };
  return { complete: true, reason: null };
}

export type AwaitingContentOutput = "GATE_DECISION" | "LANE" | "RECOMMENDATION";

export interface AwaitingContentViolation {
  canonicalJobId: string;
  reason: AwaitingContentReason;
  outputs: AwaitingContentOutput[];
}

export interface AwaitingContentReport {
  /** Live jobs that wait for their posting text. */
  awaitingContentJobs: number;
  /** Of those, how many carry a gate decision, a lane or a recommendation (each is a violation). */
  violations: AwaitingContentViolation[];
  byOutput: Record<AwaitingContentOutput, number>;
}

/** Live, awaiting-content jobs that still carry a gate decision, lane or recommendation. Read only; ids only. */
/** Anything with a pg `query`: a Pool, a Client or a PoolClient. */
export type Queryable = Pick<pg.Pool, "query">;

export async function reportAwaitingContentOutputs(
  client: Queryable,
  workspaceId: string,
): Promise<AwaitingContentReport> {
  const result = await client.query<{
    canonical_job_id: string;
    awaiting_reason: AwaitingContentReason;
    has_gate: boolean;
    has_lane: boolean;
    has_recommendation: boolean;
  }>(
    `SELECT canonical.id::text AS canonical_job_id,
            state.awaiting_reason,
            (canonical.gate_decision IS NOT NULL) AS has_gate,
            (canonical.primary_lane IS NOT NULL) AS has_lane,
            (canonical.recommendation_outcome IS NOT NULL OR canonical.recommendation_eligibility IS NOT NULL) AS has_recommendation
       FROM canonical_jobs canonical
       JOIN v_job_content_state state
         ON state.workspace_id = canonical.workspace_id AND state.canonical_job_id = canonical.id
      WHERE canonical.workspace_id = $1::uuid
        AND canonical.is_test_fixture = FALSE
        AND canonical.archived_at IS NULL
        AND COALESCE(canonical.processing_state, canonical.processing_status) NOT IN ('MANUALLY_REMOVED', 'HARD_REJECTED')
        AND NOT state.content_complete
      ORDER BY canonical.id`,
    [workspaceId],
  );
  const violations: AwaitingContentViolation[] = [];
  const byOutput: Record<AwaitingContentOutput, number> = { GATE_DECISION: 0, LANE: 0, RECOMMENDATION: 0 };
  for (const row of result.rows) {
    const outputs: AwaitingContentOutput[] = [];
    if (row.has_gate) outputs.push("GATE_DECISION");
    if (row.has_lane) outputs.push("LANE");
    if (row.has_recommendation) outputs.push("RECOMMENDATION");
    for (const output of outputs) byOutput[output] += 1;
    if (outputs.length > 0) violations.push({ canonicalJobId: row.canonical_job_id, reason: row.awaiting_reason, outputs });
  }
  return { awaitingContentJobs: result.rows.length, violations, byOutput };
}

/**
 * The read models the owner's lists read (Review, Priority and Apply Now, Track, Top 10, the shortlist and the status buckets).
 * A name is only a literal in a query: the list is fixed here, never taken from input. A view that does not exist in
 * the connected schema is reported in `viewsMissing`, not silently treated as clean.
 */
export const LIST_READ_MODELS = [
  "v_canonical_shortlist_scoped",
  "v_canonical_shortlist_actions_scoped",
  "v_canonical_shortlist_readiness_scoped",
  "v_job_status_buckets_scoped",
  "v_apply_now_jobs_scoped",
  "v_apply_now_jobs_stage3_scoped",
  "v_track_jobs_scoped",
  "v_top_ten_ready_jobs_scoped",
  "v_top_ten_ready_jobs_stage3_scoped",
] as const;

/**
 * Every other `v_*_scoped` view and why check 8 does not test it. A test enumerates the schema's views: a view that is in
 * neither LIST_READ_MODELS nor this record fails the test until someone classifies it.
 */
export const NON_LIST_READ_MODELS: Readonly<Record<string, string>> = {
  v_application_workspace_scoped: "application history built on application_records: it shows a job the owner applied to whatever its content state",
  v_application_workspace_summary_scoped: "workspace counts, no per-job rows",
  v_archived_jobs_scoped: "archived jobs are not live",
  v_company_culture_analytics_scoped: "company-level analytics, not a list of jobs",
  v_company_culture_evidence_scoped: "company-level evidence, not a list of jobs",
  v_job_awaiting_content_counts_scoped: "the awaiting-content counts themselves",
  v_job_awaiting_content_scoped: "the awaiting-content read model itself",
  v_job_engine_dashboard_summary_scoped: "aggregate dashboard counts, no per-job rows",
  // KNOWN GAPS found by the classification test: both views return a row for awaiting-content jobs (they select from canonical_jobs without the
  // content gate). Migration 123 gates them with v_job_content_state; move them into LIST_READ_MODELS in that PR so check 8 covers them.
  v_job_ranking_scoped: "KNOWN GAP: one row per live job with its stored ranking score, not gated by content_complete yet; migration 123 gates it and moves it into LIST_READ_MODELS",
  v_job_verification_checks_scoped: "KNOWN GAP: owner verification questions per job version, not gated by content_complete yet; migration 123 gates it and moves it into LIST_READ_MODELS",
  v_job_profile_evidence_scoped: "per-job evidence detail for the review panel, not a list",
  v_job_status_bucket_counts_scoped: "bucket counts, no per-job rows",
  v_job_support_issues_scoped: "support issues, built on the shortlist actions view; awaiting jobs are added deliberately by the support-issues migration so the owner can paste a description",
  v_profile_coverage_scoped: "profile-level coverage, not a list of jobs",
  v_rejected_jobs_audit_scoped: "hard-rejected and removed jobs: a rejection is not a recommendation, and the awaiting-content view excludes them by design",
};
// v_application_workspace_scoped is deliberately not listed: it is built on application_records, so it shows a job the owner
// already applied to whatever its content state is (application history, not a list of candidates). The other lists are
// built on v_canonical_shortlist_scoped, which migration 120 gates with content_complete.

export interface AwaitingContentVisibilityReport {
  /** Awaiting-content jobs shown by at least one list read model (each is a violation). */
  visible: { canonicalJobId: string; views: string[] }[];
  viewsChecked: string[];
  /** Expected list read models that are absent or lack workspace_id and canonical_job_id; check 8 fails on any. */
  viewsMissing: string[];
}

/**
 * Check 8's verdict: a failure when a list shows an awaiting job, when an expected list read model is missing, or when
 * nothing could be checked (an empty check must never read as a pass). Returns the failure lines, empty when it passes.
 */
export function awaitingVisibilityFailures(report: AwaitingContentVisibilityReport): string[] {
  const failures: string[] = [];
  if (report.viewsMissing.length > 0 || report.viewsChecked.length === 0) {
    failures.push(`could not verify the lists: ${report.viewsChecked.length} checked, missing: ${report.viewsMissing.join(", ") || "all"}`);
  }
  if (report.visible.length > 0) {
    failures.push(
      `${report.visible.length} awaiting-content job(s) shown by a list read model; first: `
      + report.visible.slice(0, 5).map((entry) => `${entry.canonicalJobId} (${entry.views.join(", ")})`).join("; "),
    );
  }
  return failures;
}

/**
 * The invariant that matters for "awaiting content": no list shows such a job. Stored gate, lane and recommendation on an
 * awaiting job are kept as evidence and reported by reportAwaitingContentOutputs as information only. Read only; ids only.
 */
export async function reportAwaitingContentVisibility(client: Queryable, workspaceId: string): Promise<AwaitingContentVisibilityReport> {
  // to_regclass follows the connection's search_path like the lists do, and pg_attribute needs no extra privilege on the
  // view, so a permissions problem does not read as "missing" (the view query below would then fail loudly instead).
  const present = await client.query<{ name: string }>(
    `SELECT candidate AS name
       FROM UNNEST($1::text[]) AS candidate
      WHERE to_regclass(candidate) IS NOT NULL
        AND (SELECT COUNT(*) FROM pg_attribute attribute
              WHERE attribute.attrelid = to_regclass(candidate) AND attribute.attname IN ('workspace_id', 'canonical_job_id') AND NOT attribute.attisdropped) = 2`,
    [[...LIST_READ_MODELS]],
  );
  const available = new Set(present.rows.map((row) => row.name));
  const viewsChecked = LIST_READ_MODELS.filter((name) => available.has(name));
  const viewsMissing = LIST_READ_MODELS.filter((name) => !available.has(name));
  const byJob = new Map<string, string[]>();
  for (const view of viewsChecked) {
    const result = await client.query<{ canonical_job_id: string }>(
      `SELECT DISTINCT list.canonical_job_id::text AS canonical_job_id
         FROM ${view} list
         JOIN v_job_awaiting_content_scoped awaiting
           ON awaiting.workspace_id = list.workspace_id AND awaiting.canonical_job_id = list.canonical_job_id
        WHERE list.workspace_id = $1::uuid`,
      [workspaceId],
    );
    for (const row of result.rows) byJob.set(row.canonical_job_id, [...(byJob.get(row.canonical_job_id) ?? []), view]);
  }
  return {
    visible: [...byJob.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([canonicalJobId, views]) => ({ canonicalJobId, views })),
    viewsChecked,
    viewsMissing,
  };
}
