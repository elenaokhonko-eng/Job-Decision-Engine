import pg from "pg";
import dotenv from "dotenv";
import { pgSslConfig } from "../db/pgSsl.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../workspace/context.js";
import { stableStringify, sha256Hex } from "../config/structuredLoader.js";
import { RecommendationDecisionSchema } from "../decision/contracts.js";
import { evaluateDecisionPolicy } from "../policy/decisionPolicy.js";
import { resolveWorkspacePolicySnapshot } from "../policy/policySnapshot.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const defaultPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: pgSslConfig(process.env.DATABASE_URL),
});

export interface RecommendationDeciderSummary {
  updated: number;
  decisionsInserted: number;
  errors: number;
  policySnapshotId: string;
  policySnapshotHash: string;
}

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
  const hasTravel = travelPctMax != null ? 1 : 0;

  const completeness = (hasWorkplaceType + hasRemoteOrOfficeDays + hasEmploymentType + hasTravel) / 4.0;
  return Number(completeness.toFixed(3));
}

export async function runRecommendationDecider(
  clientOrPool?: pg.Pool | pg.PoolClient,
  options?: { context?: WorkspaceContext }
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

    const { rows: jobs } = await client.query<{
      canonical_job_id: string;
      job_version_id: string | null;
      gate_decision: string | null;
      deterministic_match_score: any;
      deterministic_match_coverage: any;
      workplace_type: string | null;
      workability_facts: any;
      latest_match_run_id: string | null;
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
        c.gate_decision,
        c.deterministic_match_score,
        c.deterministic_match_coverage,
        c.workplace_type,
        c.workability_facts,
        c.latest_match_run_id,
        c.recommendation_eligibility,
        c.recommendation_outcome,
        c.recommendation_requirement_score,
        c.recommendation_coverage_score,
        c.recommendation_evidence_completeness,
        c.recommendation_decided_at,
        c.latest_deterministic_decision_id
      FROM canonical_jobs c
      LEFT JOIN LATERAL (
        SELECT id
        FROM job_versions
        WHERE canonical_job_id = c.id
          AND workspace_id = $1
        ORDER BY observed_at DESC
        LIMIT 1
      ) lv ON TRUE
      WHERE c.workspace_id = $1
        AND COALESCE(c.processing_state, c.processing_status) <> 'MANUALLY_REMOVED'
      `,
      [ctx.workspaceId]
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
        const requirementScorePct = asNumber(job.deterministic_match_score);
        const coverageScorePct = asNumber(job.deterministic_match_coverage);

        const requirementScore =
          requirementScorePct == null ? null : Number((requirementScorePct / 100).toFixed(3));
        const coverageScore =
          coverageScorePct == null ? null : Number((coverageScorePct / 100).toFixed(3));
        const evidenceCompleteness = computeEvidenceCompleteness(
          job.workplace_type,
          job.workability_facts
        );

        const evaluation = evaluateDecisionPolicy(snapshot.decisionPolicy.policy, {
          gate_decision: job.gate_decision,
          requirement_score: requirementScore,
          coverage_score: coverageScore,
          evidence_completeness: evidenceCompleteness,
        });

        const decisionJson = RecommendationDecisionSchema.parse({
          canonical_job_id: job.canonical_job_id,
          job_version_id: job.job_version_id,
          match_run_id: job.latest_match_run_id,
          inputs: {
            gate_decision: job.gate_decision,
            requirement_score: requirementScore,
            coverage_score: coverageScore,
            evidence_completeness: evidenceCompleteness,
          },
          outputs: {
            eligibility: evaluation.eligibility,
            outcome: evaluation.outcome,
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
            notes: evaluation.notes,
          },
        });

        const decisionHash = sha256Hex(stableStringify(decisionJson));

        const decisionRow = await client.query<{ id: string; inserted: boolean }>(
          `
          WITH inserted AS (
            INSERT INTO deterministic_decisions (
              workspace_id,
              canonical_job_id,
              job_version_id,
              match_run_id,
              policy_snapshot_id,
              decision_hash,
              decision_json,
              recommendation_eligibility,
              recommendation_outcome,
              created_by_user_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (workspace_id, canonical_job_id, job_version_id, policy_snapshot_id) DO NOTHING
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
          ORDER BY inserted DESC
          LIMIT 1
          `,
          [
            ctx.workspaceId,
            job.canonical_job_id,
            job.job_version_id,
            job.latest_match_run_id,
            snapshot.snapshotId,
            decisionHash,
            JSON.stringify(decisionJson),
            evaluation.eligibility,
            evaluation.outcome,
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
            evaluation.outcome,
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
