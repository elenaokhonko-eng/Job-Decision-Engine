import pg from "pg";
import dotenv from "dotenv";
import { pgPoolConfig } from "../db/pgSsl.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../workspace/context.js";
import { stableStringify, sha256Hex } from "../config/structuredLoader.js";
import { RecommendationDecisionSchema } from "../decision/contracts.js";
import { evaluateDecisionPolicy } from "../policy/decisionPolicy.js";
import { resolveWorkspacePolicySnapshot } from "../policy/policySnapshot.js";
import { buildPipelineTaskContextFingerprint } from "./artifactContext.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const defaultPool = new pg.Pool(pgPoolConfig(process.env.DATABASE_URL));

export interface RecommendationDeciderSummary {
  updated: number;
  decisionsInserted: number;
  errors: number;
  policySnapshotId: string;
  policySnapshotHash: string;
}

type GateDecision = "PASS" | "NEEDS_VERIFICATION" | "HARD_REJECT";

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function normalizeWorkabilityFacts(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object") return value as any;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as any;
    } catch {
      return {};
    }
  }
  return {};
}

function normalizeGateDecision(raw: unknown): GateDecision | null {
  if (raw == null) return null;
  const normalized = String(raw).trim().toUpperCase();
  if (normalized === "PASS") return "PASS";
  if (normalized === "NEEDS_VERIFICATION") return "NEEDS_VERIFICATION";
  if (normalized === "HARD_REJECT") return "HARD_REJECT";

  // Legacy/unknown values (e.g. "FAIL") must not crash the deterministic decider.
  // Treat as unknown so the decision policy defaults to VERIFY/TRACK.
  return null;
}

function inferGateDecisionFromProcessingState(stateRaw: unknown): GateDecision | null {
  const state = typeof stateRaw === "string" ? stateRaw.trim().toUpperCase() : "";
  if (!state) return null;
  if (state === "HARD_REJECTED") return "HARD_REJECT";
  if (state === "NEEDS_VERIFICATION") return "NEEDS_VERIFICATION";
  if (state === "RAW_STAGED") return null;
  return "PASS";
}

function computeEvidenceCompleteness(workplaceTypeRaw: unknown, workabilityFactsRaw: unknown): number {
  const workplaceType = typeof workplaceTypeRaw === "string" ? workplaceTypeRaw : "UNKNOWN";
  const facts = normalizeWorkabilityFacts(workabilityFactsRaw);
  const officeDaysMax = facts["office_days_max"];
  const employmentType = facts["employment_type"];
  const travelPctMax = facts["travel_pct_max"];

  const hasWorkplaceType = ["REMOTE", "HYBRID", "ONSITE"].includes(workplaceType) ? 1 : 0;
  const hasRemoteOrOfficeDays = workplaceType === "REMOTE" || officeDaysMax != null ? 1 : 0;
  const hasEmploymentType =
    employmentType === "PERMANENT" || employmentType === "CONTRACT" ? 1 : 0;
  const dimensions = [
    hasWorkplaceType,
    hasRemoteOrOfficeDays,
    hasEmploymentType,
    travelPctMax != null ? 1 : null,
  ].filter((value): value is number => value !== null);
  const completeness = dimensions.length > 0
    ? dimensions.reduce((total, value) => total + value, 0) / dimensions.length
    : 0;
  return Number(completeness.toFixed(3));
}

export async function runRecommendationDecider(
  clientOrPool?: pg.Pool | pg.PoolClient,
  options?: {
    context?: WorkspaceContext;
    jobVersionIds?: string[];
    canonicalJobIds?: string[];
    limit?: number;
  }
): Promise<RecommendationDeciderSummary> {
  console.log("Starting Deterministic Recommendation Decider...");
  const pool = clientOrPool || defaultPool;

  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === "function" && !("release" in value);
  const ownsClient = isPool(pool);
  const client = ownsClient ? await pool.connect() : pool;

  try {
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));
    const snapshot = await resolveWorkspacePolicySnapshot(client as any, { context: ctx });

    const jobVersionIds = options?.jobVersionIds?.filter(Boolean) ?? [];
    const canonicalJobIds = options?.canonicalJobIds?.filter(Boolean) ?? [];
    const limit = Number.isInteger(options?.limit) && Number(options?.limit) > 0
      ? Number(options?.limit)
      : null;
    const jobParams: unknown[] = [ctx.workspaceId];
    const jobVersionFilter = jobVersionIds.length > 0
      ? `AND COALESCE(c.latest_job_version_id, lv.id) = ANY($${jobParams.push(jobVersionIds)}::uuid[])`
      : "";
    const canonicalJobFilter = canonicalJobIds.length > 0
      ? `AND c.id = ANY($${jobParams.push(canonicalJobIds)}::uuid[])`
      : "";
    const limitClause = limit ? `LIMIT $${jobParams.push(limit)}` : "";

    const { rows: jobs } = await client.query<{
      canonical_job_id: string;
      job_version_id: string | null;
      processing_state: string | null;
      gate_decision: string | null;
      deterministic_match_score: any;
      deterministic_match_coverage: any;
      workplace_type: string | null;
      routing_disposition: string | null;
      profile_match_status: string | null;
      workability_facts: any;
      latest_match_run_id: string | null;
      match_canonical_job_id: string | null;
      match_status: string | null;
      match_matched_count: number | null;
      match_profile_version_id: string | null;
      match_requirement_set_id: string | null;
      match_job_content_hash: string | null;
      match_context_fingerprint: string | null;
      active_profile_version_id: string | null;
      active_requirement_set_id: string | null;
      job_content_hash: string | null;
      match_embedding_space_id: string | null;
      recommendation_eligibility: string | null;
      recommendation_outcome: string | null;
      recommendation_requirement_score: any;
      recommendation_coverage_score: any;
      recommendation_evidence_completeness: any;
      recommendation_decided_at: Date | null;
      latest_deterministic_decision_id: string | null;
    }>(
      `
      SELECT
        c.id AS canonical_job_id,
        COALESCE(c.latest_job_version_id, lv.id) AS job_version_id,
        COALESCE(c.processing_state, c.processing_status) AS processing_state,
        c.gate_decision,
        c.deterministic_match_score,
        c.deterministic_match_coverage,
        c.workplace_type,
        c.routing_disposition,
        c.profile_match_status,
        c.workability_facts,
        c.latest_match_run_id,
        mr.canonical_job_id AS match_canonical_job_id,
        mr.status AS match_status,
        mr.matched_count AS match_matched_count,
        mr.profile_version_id AS match_profile_version_id,
        mr.requirement_set_id AS match_requirement_set_id,
        mr.job_content_hash AS match_job_content_hash,
        mr.context_fingerprint AS match_context_fingerprint,
        active_profile.id AS active_profile_version_id,
        lv.active_requirement_set_id,
        lv.content_hash AS job_content_hash,
        mr.embedding_space_id AS match_embedding_space_id,
        c.recommendation_eligibility,
        c.recommendation_outcome,
        c.recommendation_requirement_score,
        c.recommendation_coverage_score,
        c.recommendation_evidence_completeness,
        c.recommendation_decided_at,
        c.latest_deterministic_decision_id
      FROM canonical_jobs c
      LEFT JOIN match_runs mr
        ON mr.workspace_id = c.workspace_id
       AND mr.id = c.latest_match_run_id
      LEFT JOIN LATERAL (
        SELECT pv.id
        FROM profile_versions pv
        WHERE pv.workspace_id = c.workspace_id
          AND pv.status = 'ACTIVE'
        ORDER BY pv.created_at DESC
        LIMIT 1
      ) active_profile ON TRUE
      LEFT JOIN LATERAL (
        SELECT id, active_requirement_set_id, content_hash
        FROM job_versions
        WHERE canonical_job_id = c.id
          AND workspace_id = $1
        ORDER BY observed_at DESC
        LIMIT 1
      ) lv ON TRUE
      WHERE c.workspace_id = $1
        AND COALESCE(c.processing_state, c.processing_status) <> 'MANUALLY_REMOVED'
        ${jobVersionFilter}
        ${canonicalJobFilter}
      ORDER BY c.created_at ASC, c.id ASC
      ${limitClause}
      `,
      jobParams
    );

    let updated = 0;
    let decisionsInserted = 0;
    let errors = 0;

    for (const job of jobs) {
      if (!job.job_version_id) {
        errors += 1;
        console.warn(
          `⚠️ Recommendation decider skipping canonical job ${job.canonical_job_id}: missing job_version_id.`
        );
        continue;
      }

      await client.query("BEGIN");
      try {
        const normalizedGateDecision =
          normalizeGateDecision(job.gate_decision) ??
          inferGateDecisionFromProcessingState(job.processing_state);

        const currentMatch =
          job.match_status === "COMPLETED" &&
          job.match_canonical_job_id === job.canonical_job_id &&
          job.match_profile_version_id !== null &&
          job.match_profile_version_id === job.active_profile_version_id &&
          job.match_requirement_set_id !== null &&
          job.match_requirement_set_id === job.active_requirement_set_id &&
          job.match_job_content_hash !== null &&
          job.match_job_content_hash === job.job_content_hash &&
          job.match_context_fingerprint !== null;
        const requiresCurrentMatch = normalizedGateDecision === "PASS";
        const matchIsUsable = !requiresCurrentMatch || currentMatch;

        const requirementScorePct = matchIsUsable ? asNumber(job.deterministic_match_score) : null;
        const coverageScorePct = matchIsUsable ? asNumber(job.deterministic_match_coverage) : null;

        const requirementScore =
          requirementScorePct == null ? null : Number((requirementScorePct / 100).toFixed(3));
        const coverageScore =
          coverageScorePct == null ? null : Number((coverageScorePct / 100).toFixed(3));
        const evidenceCompleteness = computeEvidenceCompleteness(
          job.workplace_type,
          job.workability_facts
        );

        const evaluation = evaluateDecisionPolicy(snapshot.decisionPolicy.policy, {
          gate_decision: normalizedGateDecision,
          requirement_score: requirementScore,
          coverage_score: coverageScore,
          evidence_completeness: evidenceCompleteness,
        });

        const semanticReady = Boolean(job.match_embedding_space_id);
        const adjustedNotes = [...evaluation.notes];
        if (requiresCurrentMatch && !currentMatch) {
          adjustedNotes.push("current_match_required_but_missing_or_stale");
        }
        const adjustedSemanticReady = matchIsUsable && semanticReady;
        if (job.gate_decision && normalizedGateDecision !== job.gate_decision) {
          adjustedNotes.push(`legacy_gate_decision:${job.gate_decision}->${normalizedGateDecision ?? "null"}`);
        } else if (!job.gate_decision && normalizedGateDecision) {
          adjustedNotes.push(`gate_decision_inferred_from_state:${normalizedGateDecision}`);
        }
        let adjustedOutcome = evaluation.outcome;
        const noPositiveProfileMatch =
          requiresCurrentMatch &&
          currentMatch &&
          job.profile_match_status === "NO_PROFILE_MATCH" &&
          Number(job.match_matched_count ?? 0) === 0;
        if (noPositiveProfileMatch) {
          adjustedOutcome = "SKIP";
          adjustedNotes.push("no_positive_grounded_profile_match");
        }
        if (job.routing_disposition === "POLICY_NO_MATCH") {
          adjustedOutcome = "SKIP";
          adjustedNotes.push("routing_policy_no_lane_match");
        }
        if (
          (!adjustedSemanticReady || job.profile_match_status === "UNKNOWN") &&
          adjustedOutcome === "PRIORITY"
        ) {
          adjustedOutcome = "REVIEW";
          adjustedNotes.push("priority_downgraded_semantic_pending");
        }

        const decisionJson = RecommendationDecisionSchema.parse({
          canonical_job_id: job.canonical_job_id,
          job_version_id: job.job_version_id,
          match_run_id: job.latest_match_run_id,
          inputs: {
            gate_decision: normalizedGateDecision,
            requirement_score: requirementScore,
            coverage_score: coverageScore,
            evidence_completeness: evidenceCompleteness,
          },
          outputs: {
            eligibility: evaluation.eligibility,
            outcome: adjustedOutcome,
            recommendation_requirement_score: requirementScore,
            recommendation_coverage_score: coverageScore,
            recommendation_evidence_completeness: evidenceCompleteness,
          },
          trace: {
            policy_version: snapshot.decisionPolicy.policy.policy_version,
            policy_hash: snapshot.decisionPolicy.policyHash,
            policy_snapshot_id: snapshot.snapshotId,
            eligibility_rule_id: evaluation.eligibilityRuleId,
            outcome_rule_id: evaluation.outcomeRuleId,
            notes: adjustedNotes,
          },
        });

        const decisionHash = sha256Hex(stableStringify(decisionJson));
        const decisionContextFingerprint = buildPipelineTaskContextFingerprint({
          workspaceId: ctx.workspaceId,
          taskType: "DECIDE_RECOMMENDATION",
          taskVersion: "recommendation_decider_v1",
          payload: {
            canonical_job_id: job.canonical_job_id,
            job_version_id: job.job_version_id,
            content_hash: job.job_content_hash,
            active_requirement_set_id: job.active_requirement_set_id,
            profile_version_id: job.active_profile_version_id,
            match_run_id: job.latest_match_run_id,
            policy_snapshot_id: snapshot.snapshotId,
            policy_hash: snapshot.snapshotHash,
          },
        });

        const decisionRow = await client.query<{ id: string; inserted: boolean }>(
          `
          WITH inserted AS (
            INSERT INTO deterministic_decisions (
              workspace_id,
              canonical_job_id,
              job_version_id,
              match_run_id,
              policy_snapshot_id,
              context_fingerprint,
              decision_hash,
              decision_json,
              recommendation_eligibility,
              recommendation_outcome,
              created_by_user_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            ON CONFLICT (
              workspace_id,
              canonical_job_id,
              job_version_id,
              policy_snapshot_id,
              context_fingerprint
            ) DO NOTHING
            RETURNING id, TRUE AS inserted
          )
          SELECT id, inserted FROM inserted
          UNION ALL
          SELECT id, FALSE AS inserted
          FROM deterministic_decisions
          WHERE workspace_id = $1
            AND canonical_job_id = $2
            AND job_version_id = $3
            AND policy_snapshot_id = $5
            AND context_fingerprint = $6
          ORDER BY inserted DESC
          LIMIT 1
          `,
          [
            ctx.workspaceId,
            job.canonical_job_id,
            job.job_version_id,
            job.latest_match_run_id,
            snapshot.snapshotId,
            decisionContextFingerprint,
            decisionHash,
            JSON.stringify(decisionJson),
            evaluation.eligibility,
            adjustedOutcome,
            ctx.userId,
          ]
        );

        const decisionId = decisionRow.rows[0]?.id;
        const inserted = Boolean(decisionRow.rows[0]?.inserted);
        if (!decisionId) {
          throw new Error("Failed to resolve deterministic_decisions id.");
        }
        if (inserted) {
          decisionsInserted += 1;
        }

        const updateRes = await client.query<{ id: string }>(
          `
          UPDATE canonical_jobs c
          SET recommendation_eligibility = $2,
              recommendation_outcome = $3,
              recommendation_requirement_score = $4,
              recommendation_coverage_score = $5,
              recommendation_evidence_completeness = $6,
              recommendation_decided_at = NOW(),
              latest_deterministic_decision_id = $7,
              updated_at = NOW()
          WHERE c.workspace_id = $1
            AND c.id = $8
            AND (
              c.recommendation_eligibility IS DISTINCT FROM $2
              OR c.recommendation_outcome IS DISTINCT FROM $3
              OR c.recommendation_requirement_score IS DISTINCT FROM $4
              OR c.recommendation_coverage_score IS DISTINCT FROM $5
              OR c.recommendation_evidence_completeness IS DISTINCT FROM $6
              OR c.latest_deterministic_decision_id IS DISTINCT FROM $7
              OR c.recommendation_decided_at IS NULL
            )
          RETURNING c.id
          `,
          [
            ctx.workspaceId,
            evaluation.eligibility,
            adjustedOutcome,
            requirementScore,
            coverageScore,
            evidenceCompleteness,
            decisionId,
            job.canonical_job_id,
          ]
        );

        updated += updateRes.rowCount ?? 0;

        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        errors += 1;
        console.error(
          `❌ Recommendation decider failed for canonical job ${job.canonical_job_id}:`,
          error
        );
      }
    }

    console.log(`Recommendation Decider complete. Updated: ${updated}`);
    return {
      updated,
      decisionsInserted,
      errors,
      policySnapshotId: snapshot.snapshotId,
      policySnapshotHash: snapshot.snapshotHash,
    };
  } finally {
    if (ownsClient && typeof (client as any).release === "function") {
      (client as pg.PoolClient).release();
    }
  }
}

export const runDeterministicDecisions = runRecommendationDecider;
