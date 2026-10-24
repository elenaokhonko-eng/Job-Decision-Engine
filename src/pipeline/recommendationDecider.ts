import pg from "pg";
import dotenv from "dotenv";
import { pgPoolConfig } from "../db/pgSsl.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../workspace/context.js";
import { stableStringify, sha256Hex } from "../config/structuredLoader.js";
import { RecommendationDecisionSchema } from "../decision/contracts.js";
import { evaluateDecisionPolicy } from "../policy/decisionPolicy.js";
import { resolveWorkspacePolicySnapshot } from "../policy/policySnapshot.js";
import { resolveWorkspacePreferenceContext } from "../policy/workspacePreferenceRegistry.js";
import {
  evaluateCompensationPolicy,
  evaluateJobFreshness,
  inferOpportunityCategory,
  parseCompensationEvidence,
  type CompensationEvaluationResult,
  type JobCompensationInput,
} from "../policy/stage3PolicyEngine.js";
import { resolveFrankfurterSgdRate } from "../policy/fxRateService.js";
import { JobSourceEvidenceSchema, type JobSourceEvidence } from "../contracts/jobSourceEvidence.js";
import type { MaterialReadinessCheck } from "../contracts/applicationReadiness.js";
import { assessApplicationReadiness, buildApplicationReadinessFingerprint, QUALIFICATION_COMPARATOR_VERSION } from "../eligibility/applicationReadiness.js";
import { buildEvidenceRevisionHash } from "../ingestion/jobSourceEvidence.js";
import { resolveWorkspaceWorkabilityPolicy } from "./workabilityPolicy.js";
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

function jsonRecord(value: unknown): Record<string, unknown> | null {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return null;
    }
  }
  return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : null;
}

function parseSourceEvidence(value: unknown): JobSourceEvidence | null {
  const record = jsonRecord(value);
  if (!record) return null;
  const parsed = JobSourceEvidenceSchema.safeParse(record);
  return parsed.success ? parsed.data : null;
}

function readinessCheck(
  key: MaterialReadinessCheck["key"],
  status: MaterialReadinessCheck["status"],
  rationale: string,
  assessedAt: string,
  options: {
    readonly reasonCode?: string | null;
    readonly evidenceKeys?: string[];
    readonly importance?: MaterialReadinessCheck["importance"];
    readonly policyReference?: string | null;
    readonly expiresAt?: string | null;
  } = {},
): MaterialReadinessCheck {
  return {
    key,
    status,
    importance: options.importance ?? "MUST",
    reason_code: options.reasonCode ?? null,
    rationale,
    evidence_keys: options.evidenceKeys ?? [],
    policy_reference: options.policyReference ?? null,
    assessed_at: assessedAt,
    expires_at: options.expiresAt ?? null,
  };
}

function sha256Json(value: unknown): string {
  return sha256Hex(stableStringify(value));
}

function availabilityEvidenceHash(value: unknown): string | null {
  const record = jsonRecord(value);
  if (!record) return null;
  const spans = Array.isArray(record.evidence)
    ? record.evidence.flatMap((item) => {
        const span = jsonRecord(item);
        return span ? [{
          evidence_key: span.evidence_key ?? null,
          quote_text: span.quote_text ?? null,
          source_name: span.source_name ?? null,
          source_external_id: span.source_external_id ?? null,
          source_url: span.source_url ?? null,
        }] : [];
      })
    : [];
  return sha256Json({
    status: record.status ?? null,
    verification_method: record.verification_method ?? null,
    reason_code: record.reason_code ?? null,
    evidence: spans,
  });
}

function availabilityEvidenceHashForJob(sourceEvidence: JobSourceEvidence | null, stored: unknown): string | null {
  return availabilityEvidenceHash(sourceEvidence?.availability ?? stored);
}

function asIso(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function compensationInputForJob(raw: string | null, evidence: JobSourceEvidence | null): JobCompensationInput | null {
  if (evidence?.compensation.status === "CONFLICTING") return null;
  const baseCashComponents = evidence?.compensation.components.filter((component) => component.component_type === "BASE_CASH") ?? [];
  if (baseCashComponents.length === 0) return parseCompensationEvidence(raw);
  if (baseCashComponents.length !== 1) return null;
  const baseCash = baseCashComponents[0];
  if (!baseCash) return null;
  const salaryPeriod = baseCash.period === "ANNUAL" || baseCash.period === "MONTHLY" || baseCash.period === "HOURLY"
    ? baseCash.period
    : "UNKNOWN";
  const quote = baseCash.evidence.map((span) => span.quote_text).join(" ");
  return parseCompensationEvidence(quote, {
    salary_min: baseCash.amount_min,
    salary_max: baseCash.amount_max,
    salary_currency: baseCash.currency,
    salary_period: salaryPeriod,
    salary_basis: baseCash.pay_basis,
    component_type: baseCash.component_type,
    guaranteed_hours_per_week: baseCash.guaranteed_hours_per_week,
    paid_weeks_per_year: baseCash.paid_weeks_per_year,
  });
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
    const preferenceContext = await resolveWorkspacePreferenceContext(client as pg.PoolClient, ctx, ['lane_intent', 'stage3']);
    const workabilityPolicyResolution = await resolveWorkspaceWorkabilityPolicy(client as any, { context: ctx });
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
      canonical_latest_job_version_id: string | null;
      processing_state: string | null;
      gate_decision: string | null;
      deterministic_match_score: any;
      deterministic_match_coverage: any;
      workplace_type: string | null;
      employment_type: string | null;
      routing_disposition: string | null;
      profile_match_status: string | null;
      workability_facts: any;
      latest_match_run_id: string | null;
      match_canonical_job_id: string | null;
      match_job_version_id: string | null;
      match_status: string | null;
      match_matched_count: number | null;
      match_profile_version_id: string | null;
      match_requirement_set_id: string | null;
      match_job_content_hash: string | null;
      match_context_fingerprint: string | null;
      active_profile_version_id: string | null;
      active_profile_source_hash: string | null;
      active_requirement_set_id: string | null;
      job_content_hash: string | null;
      source_posting_identity_hash: string | null;
      evidence_revision_hash: string | null;
      source_published_at: Date | string | null;
      source_updated_at: Date | string | null;
      source_expires_at: Date | string | null;
      reposted_at: Date | string | null;
      freshness_basis: string | null;
      availability_status: "OPEN" | "CLOSED" | "UNKNOWN" | null;
      availability_evidence: unknown;
      availability_verified_at: Date | string | null;
      availability_recheck_at: Date | string | null;
      description_quality_status: string | null;
      normalized_source_evidence: unknown;
      latest_observation_raw_payload_hash: string | null;
      match_embedding_space_id: string | null;
      recommendation_eligibility: string | null;
      recommendation_outcome: string | null;
      recommendation_requirement_score: any;
      recommendation_coverage_score: any;
      recommendation_evidence_completeness: any;
      recommendation_decided_at: Date | null;
      latest_deterministic_decision_id: string | null;
      company_name: string;
      normalized_title: string;
      description_text: string | null;
      compensation_raw: string | null;
    }>(
      `
      SELECT
        c.id AS canonical_job_id,
        COALESCE(c.latest_job_version_id, lv.id) AS job_version_id,
        c.latest_job_version_id AS canonical_latest_job_version_id,
        COALESCE(c.processing_state, c.processing_status) AS processing_state,
        c.gate_decision,
        c.deterministic_match_score,
        c.deterministic_match_coverage,
        c.workplace_type,
        c.employment_type,
        c.routing_disposition,
        c.profile_match_status,
        c.workability_facts,
        c.latest_match_run_id,
        mr.canonical_job_id AS match_canonical_job_id,
        mr.job_version_id AS match_job_version_id,
        mr.status AS match_status,
        mr.matched_count AS match_matched_count,
        mr.profile_version_id AS match_profile_version_id,
        mr.requirement_set_id AS match_requirement_set_id,
        mr.job_content_hash AS match_job_content_hash,
        mr.context_fingerprint AS match_context_fingerprint,
        active_profile.id AS active_profile_version_id,
        active_profile.source_hash AS active_profile_source_hash,
        lv.active_requirement_set_id,
        lv.content_hash AS job_content_hash,
        lv.source_posting_identity_hash,
        lv.evidence_revision_hash,
        lv.source_published_at,
        lv.source_updated_at,
        lv.source_expires_at,
        lv.reposted_at,
        lv.freshness_basis,
        lv.availability_status,
        lv.availability_evidence,
        lv.availability_verified_at,
        lv.availability_recheck_at,
        c.description_quality_status,
        mr.embedding_space_id AS match_embedding_space_id,
        c.recommendation_eligibility,
        c.recommendation_outcome,
        c.recommendation_requirement_score,
        c.recommendation_coverage_score,
        c.recommendation_evidence_completeness,
        c.recommendation_decided_at,
        c.latest_deterministic_decision_id,
        c.company_name,
        c.normalized_title,
        lv.description_text,
        source_observation.compensation_raw,
        source_evidence.normalized_evidence AS normalized_source_evidence,
        source_observation.raw_payload_hash AS latest_observation_raw_payload_hash
      FROM canonical_jobs c
      LEFT JOIN match_runs mr
        ON mr.workspace_id = c.workspace_id
       AND mr.id = c.latest_match_run_id
      LEFT JOIN LATERAL (
        SELECT pv.id, pv.source_hash
        FROM profile_versions pv
        WHERE pv.workspace_id = c.workspace_id
          AND pv.status = 'ACTIVE'
        ORDER BY pv.created_at DESC
        LIMIT 1
      ) active_profile ON TRUE
      LEFT JOIN LATERAL (
        SELECT id, active_requirement_set_id, content_hash, description_text,
               source_posting_identity_hash, evidence_revision_hash,
               source_published_at, source_updated_at, source_expires_at, reposted_at, freshness_basis,
               availability_status, availability_evidence, availability_verified_at, availability_recheck_at
        FROM job_versions
        WHERE canonical_job_id = c.id
          AND workspace_id = $1
          AND (c.latest_job_version_id IS NULL OR id = c.latest_job_version_id)
        ORDER BY observed_at DESC
        LIMIT 1
      ) lv ON TRUE
      LEFT JOIN LATERAL (
        SELECT observation.compensation_raw,
               observation.raw_payload_hash
        FROM raw_job_observations AS observation
        WHERE observation.workspace_id = c.workspace_id
          AND observation.job_version_id = lv.id
        ORDER BY observation.retrieved_at DESC, observation.id DESC
        LIMIT 1
      ) AS source_observation ON TRUE
      LEFT JOIN LATERAL (
        SELECT evidence_event.normalized_evidence
        FROM (
          SELECT observation.normalized_evidence,
                 observation.retrieved_at AS observed_at,
                 observation.id AS event_id
          FROM raw_job_observations AS observation
          WHERE observation.workspace_id = c.workspace_id
            AND observation.job_version_id = lv.id
            AND observation.normalized_evidence IS NOT NULL
          UNION ALL
          SELECT disposition.normalized_evidence,
                 disposition.fetched_at AS observed_at,
                 disposition.id AS event_id
          FROM source_candidate_dispositions AS disposition
          JOIN raw_job_observations AS observation
            ON observation.workspace_id = disposition.workspace_id
           AND observation.id = disposition.job_observation_id
           AND observation.job_version_id = lv.id
          WHERE disposition.workspace_id = c.workspace_id
            AND disposition.normalized_evidence IS NOT NULL
        ) evidence_event
        ORDER BY evidence_event.observed_at DESC, evidence_event.event_id DESC
        LIMIT 1
      ) AS source_evidence ON TRUE
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
      const sourceEvidence = parseSourceEvidence(job.normalized_source_evidence);
      const compensationInput = compensationInputForJob(job.compensation_raw, sourceEvidence);
      let fxRateObservationId: string | null = null;
      let fxRateFailure: string | null = null;
      if (
        compensationInput
        && compensationInput.salary_currency
        && compensationInput.salary_currency.toUpperCase() !== "SGD"
        && preferenceContext.stage3?.compensation?.target_salary_basis
        && compensationInput.salary_basis === preferenceContext.stage3.compensation.target_salary_basis
      ) {
        try {
          const fxObservation = await resolveFrankfurterSgdRate(client, compensationInput.salary_currency, {
            maxAgeDays: preferenceContext.stage3.compensation.fx_rate_max_age_days ?? 7,
          });
          compensationInput.currency_to_sgd_rate = fxObservation.rate;
          compensationInput.fx_rate_date = fxObservation.rateDate;
          compensationInput.fx_rate_source = fxObservation.sourceName;
          compensationInput.fx_rate_observation_id = fxObservation.id;
          fxRateObservationId = fxObservation.id;
        } catch (error) {
          fxRateFailure = error instanceof Error ? error.message : String(error);
        }
      }
      const evidenceCategory = sourceEvidence?.opportunity_category.status === "SUPPORTED"
        ? sourceEvidence.opportunity_category.value
        : inferOpportunityCategory(job.company_name, job.normalized_title, "");
      const compensationAssessment = compensationInput && preferenceContext.stage3?.compensation
        ? evaluateCompensationPolicy(compensationInput, evidenceCategory, preferenceContext.stage3.compensation)
        : null;
      await client.query("BEGIN");
      try {
        const normalizedGateDecision =
          normalizeGateDecision(job.gate_decision) ??
          inferGateDecisionFromProcessingState(job.processing_state);

        const currentMatch =
          job.canonical_latest_job_version_id !== null &&
          job.canonical_latest_job_version_id === job.job_version_id &&
          job.match_status === "COMPLETED" &&
          job.match_canonical_job_id === job.canonical_job_id &&
          job.match_job_version_id === job.job_version_id &&
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
        let adjustedEligibility = evaluation.eligibility;
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
        const exactFullySatisfied =
          job.profile_match_status === "POSITIVE_MATCH" &&
          coverageScore !== null &&
          coverageScore >= 1.0 &&
          requirementScore !== null &&
          requirementScore >= 0.9;
        if (
          !exactFullySatisfied &&
          (!adjustedSemanticReady || job.profile_match_status === "UNKNOWN") &&
          adjustedOutcome === "PRIORITY"
        ) {
          adjustedOutcome = "REVIEW";
          adjustedNotes.push("priority_downgraded_semantic_pending");
        }

        if (fxRateFailure) adjustedNotes.push("FX_RATE_RETRIEVAL_INCOMPLETE");
        if (compensationAssessment?.is_hard_reject) {
          adjustedEligibility = "INELIGIBLE";
          adjustedOutcome = "SKIP";
          adjustedNotes.push(compensationAssessment.rejection_code || "COMPENSATION_BELOW_USER_FLOOR");
        } else if (compensationAssessment?.prevents_apply_now) {
          adjustedOutcome = "TRACK";
          adjustedNotes.push(compensationAssessment.rejection_code || "COMPENSATION_REQUIRES_VERIFICATION");
        }

        const readinessAssessedAt = new Date().toISOString();
        const evidenceRevisionHash = typeof job.evidence_revision_hash === "string" && /^[a-f0-9]{64}$/i.test(job.evidence_revision_hash)
          ? job.evidence_revision_hash.toLowerCase()
          : sourceEvidence
            ? buildEvidenceRevisionHash(sourceEvidence)
            : sha256Json({ schema_version: "legacy_evidence_unknown", job_version_id: job.job_version_id, content_hash: job.job_content_hash });
        const availabilityEvidenceHash = availabilityEvidenceHashForJob(sourceEvidence, job.availability_evidence);
        const readinessChecks: MaterialReadinessCheck[] = [];
        const sourceIdentityPresent = Boolean(
          job.source_posting_identity_hash
          || sourceEvidence?.source_identity_hash
          || sourceEvidence?.source_external_id
          || sourceEvidence?.employer_posting_url
        );
        readinessChecks.push(readinessCheck(
          "SOURCE_IDENTITY",
          sourceIdentityPresent ? "MET" : "NEEDS_VERIFICATION",
          sourceIdentityPresent ? "Stable source posting identity is recorded." : "No stable source posting ID or canonical employer posting URL is recorded.",
          readinessAssessedAt,
          { reasonCode: sourceIdentityPresent ? null : "SOURCE_IDENTITY_MISSING", evidenceKeys: sourceEvidence?.source_identity_hash ? [sourceEvidence.source_identity_hash] : [] },
        ));

        const descriptionStatus = sourceEvidence?.description.completeness_status ?? "UNKNOWN";
        readinessChecks.push(readinessCheck(
          "DESCRIPTION_COMPLETENESS",
          descriptionStatus === "COMPLETE" ? "MET" : "NEEDS_VERIFICATION",
          descriptionStatus === "COMPLETE"
            ? "Normalized description has a complete, structured evidence assessment."
            : "Description completeness is not established; enrich the employer source before application readiness.",
          readinessAssessedAt,
          { reasonCode: descriptionStatus === "COMPLETE" ? null : "DESCRIPTION_EVIDENCE_INCOMPLETE", evidenceKeys: sourceEvidence?.description.completeness_reasons ?? [] },
        ));

        const now = new Date();
        const availabilityStatus = sourceEvidence
          ? sourceEvidence.availability.status
          : job.availability_status;
        const availabilityVerifiedAt = sourceEvidence
          ? sourceEvidence.availability.verified_at
          : asIso(job.availability_verified_at);
        const availabilityExpiresAt = sourceEvidence
          ? sourceEvidence.availability.expires_at
          : asIso(job.availability_recheck_at);
        const postingExpiry = asIso(job.source_expires_at);
        const postingExpired = postingExpiry !== null && new Date(postingExpiry).getTime() <= now.getTime();
        const availabilityCurrent = availabilityStatus === "OPEN"
          && availabilityVerifiedAt !== null
          && availabilityExpiresAt !== null
          && new Date(availabilityExpiresAt).getTime() > now.getTime()
          && !postingExpired;
        const availabilityVerificationRevision = availabilityVerifiedAt
          ? sha256Json({
              status: availabilityStatus,
              verified_at: availabilityVerifiedAt,
              expires_at: availabilityExpiresAt,
              verification_method: sourceEvidence?.availability.verification_method ?? null,
            })
          : null;
        readinessChecks.push(readinessCheck(
          "AVAILABILITY",
          postingExpired || availabilityStatus === "CLOSED" ? "BLOCKED" : availabilityCurrent ? "MET" : "NEEDS_VERIFICATION",
          postingExpired
            ? "The authoritative source expiry date has passed."
            : availabilityStatus === "CLOSED"
              ? "The source currently marks this posting closed."
              : availabilityCurrent
                ? "Employer/source availability evidence is current."
                : "Open status is missing or its verification TTL has expired.",
          readinessAssessedAt,
          {
            reasonCode: postingExpired || availabilityStatus === "CLOSED" ? "JOB_NOT_OPEN" : availabilityCurrent ? null : "AVAILABILITY_NOT_VERIFIED",
            evidenceKeys: [
              ...(sourceEvidence?.availability.evidence.map((item) => item.evidence_key) ?? []),
              ...(availabilityVerificationRevision ? [`availability_verification_revision:${availabilityVerificationRevision}`] : []),
            ],
            policyReference: `availability_verification_v1:${availabilityVerifiedAt ?? "unknown"}:${availabilityExpiresAt ?? "unknown"}`,
            expiresAt: availabilityExpiresAt,
          },
        ));

        const freshnessPolicy = preferenceContext.stage3?.freshness;
        const freshness = evaluateJobFreshness({
          posted_at: job.source_published_at,
          reposted_at: job.reposted_at,
          source_updated_at: job.source_updated_at,
          freshness_basis: job.freshness_basis,
          is_repost: job.freshness_basis === "REPOSTED_AT",
        }, freshnessPolicy);
        const freshnessStatus = !freshnessPolicy?.max_posting_age_days
          ? "NEEDS_VERIFICATION"
          : freshness.status === "STALE"
            ? freshness.is_hard_reject ? "BLOCKED" : "NEEDS_VERIFICATION"
            : freshness.status === "UNKNOWN" ? "NEEDS_VERIFICATION" : "MET";
        const freshnessExpiry = asIso(job.source_published_at ?? job.reposted_at)
          && freshnessPolicy?.max_posting_age_days
          ? new Date(new Date(asIso(job.reposted_at ?? job.source_published_at) as string).getTime() + freshnessPolicy.max_posting_age_days * 24 * 60 * 60 * 1000).toISOString()
          : null;
        readinessChecks.push(readinessCheck(
          "FRESHNESS",
          freshnessStatus,
          freshnessStatus === "MET" ? freshness.evidence : freshnessPolicy?.max_posting_age_days
            ? freshness.evidence : "No active, versioned maximum-posting-age policy is available.",
          readinessAssessedAt,
          {
            reasonCode: freshnessStatus === "BLOCKED" ? freshness.rejection_code ?? "POSTING_STALE" : freshnessStatus === "MET" ? null : "FRESHNESS_UNVERIFIED",
            evidenceKeys: freshnessPolicy?.max_posting_age_days ? [`posting_age_days:${freshness.job_age_days ?? "unknown"}`] : [],
            expiresAt: freshnessExpiry,
          },
        ));

        const workabilityEvidence = sourceEvidence?.workability;
        const territoryEvidence = workabilityEvidence?.hiring_territories;
        const workerTerritories = territoryEvidence?.countries ?? [];
        const authorizedRegions = workabilityPolicyResolution.policy.authorizedRegions;
        const territoryAllowed = territoryEvidence?.operator === "ALL"
          ? workerTerritories.every((territory) => authorizedRegions.length === 0 || authorizedRegions.includes(territory))
          : workerTerritories.some((territory) => authorizedRegions.length === 0 || authorizedRegions.includes(territory));
        const remotePolicyAllowsUnknownTerritory = workabilityEvidence?.work_mode.value === "REMOTE"
          && workabilityPolicyResolution.policy.remoteWithoutTerritoryAllowed;
        const workAuthStatus = territoryEvidence?.status === "SUPPORTED" && workerTerritories.length > 0
          ? territoryAllowed ? "MET" : "BLOCKED"
          : remotePolicyAllowsUnknownTerritory || !workabilityPolicyResolution.policy.unknownWorkAuthorizationNeedsVerification
            ? "NOT_APPLICABLE" : "NEEDS_VERIFICATION";
        readinessChecks.push(readinessCheck(
          "WORK_AUTHORIZATION",
          workAuthStatus,
          workAuthStatus === "MET"
            ? `Explicit worker-territory alternatives are compatible with ${authorizedRegions.join(", ") || "the configured policy"}.`
            : workAuthStatus === "BLOCKED"
              ? "Explicit worker-territory restrictions conflict with the active authorized regions."
              : workAuthStatus === "NOT_APPLICABLE"
                ? "The active policy does not require separate work-authorization evidence for this posting context."
                : "Hiring-country or work-authorization evidence is unresolved.",
          readinessAssessedAt,
          {
            reasonCode: workAuthStatus === "BLOCKED" ? "WORK_AUTHORIZATION_INCOMPATIBLE" : workAuthStatus === "NEEDS_VERIFICATION" ? "WORK_AUTHORIZATION_UNKNOWN" : null,
            evidenceKeys: territoryEvidence?.evidence.map((item) => item.evidence_key) ?? [],
            policyReference: workAuthStatus === "NOT_APPLICABLE" ? `workability_policy:${workabilityPolicyResolution.policyHash}` : null,
          },
        ));

        const modeEvidence = workabilityEvidence?.work_mode;
        const modeValue = modeEvidence?.value ?? "UNKNOWN";
        const officeDaysMax = modeEvidence?.office_days_max ?? normalizeWorkabilityFacts(job.workability_facts)["office_days_max"];
        const modeAllowed = modeValue !== "UNKNOWN" && workabilityPolicyResolution.policy.allowedWorkModes.includes(modeValue);
        const officeDaysAllowed = officeDaysMax === null || officeDaysMax === undefined
          ? modeValue === "REMOTE"
          : Number(officeDaysMax) <= workabilityPolicyResolution.policy.maxOfficeDaysPerWeek
            && Number(officeDaysMax) < workabilityPolicyResolution.policy.hardFailOfficeDaysPerWeek;
        const workModeStatus = normalizedGateDecision === "HARD_REJECT" && (modeValue === "UNKNOWN" || !modeAllowed)
          ? "BLOCKED"
          : modeEvidence?.status === "SUPPORTED" && modeAllowed && officeDaysAllowed
            ? "MET"
            : modeEvidence?.status === "SUPPORTED" && (!modeAllowed || !officeDaysAllowed)
              ? "BLOCKED" : "NEEDS_VERIFICATION";
        readinessChecks.push(readinessCheck(
          "WORK_MODE",
          workModeStatus,
          workModeStatus === "MET"
            ? `Employer-confirmed ${modeValue.toLowerCase()} work mode fits the active office-day policy.`
            : workModeStatus === "BLOCKED"
              ? "Employer-confirmed work mode or attendance exceeds the active preference."
              : "Work mode or office-day requirements are not established by employer evidence.",
          readinessAssessedAt,
          { reasonCode: workModeStatus === "BLOCKED" ? "WORK_MODE_INCOMPATIBLE" : workModeStatus === "MET" ? null : "WORK_MODE_UNVERIFIED", evidenceKeys: modeEvidence?.evidence.map((item) => item.evidence_key) ?? [] },
        ));

        const travelEvidence = workabilityEvidence?.travel_pct;
        const travelMentioned = /\\b(travel|traveling|travelling)\\b/i.test(job.description_text ?? "");
        const travelMaximum = travelEvidence?.maximum;
        const travelStatus = travelEvidence?.status === "SUPPORTED" && typeof travelMaximum === "number"
          ? travelMaximum > workabilityPolicyResolution.policy.maxTravelPct && !workabilityPolicyResolution.policy.frequentTravelAllowed ? "BLOCKED" : "MET"
          : travelMentioned ? "NEEDS_VERIFICATION" : "NOT_APPLICABLE";
        readinessChecks.push(readinessCheck(
          "TRAVEL",
          travelStatus,
          travelStatus === "BLOCKED"
            ? `Employer travel maximum ${travelMaximum}% exceeds the active ${workabilityPolicyResolution.policy.maxTravelPct}% cap.`
            : travelStatus === "MET" ? "Disclosed travel requirement fits the active cap." : travelStatus === "NEEDS_VERIFICATION" ? "Travel is mentioned without a supported numeric upper bound." : "No travel obligation is stated; the numeric travel cap is not applicable.",
          readinessAssessedAt,
          {
            reasonCode: travelStatus === "BLOCKED" ? "TRAVEL_EXCEEDS_POLICY" : travelStatus === "NEEDS_VERIFICATION" ? "TRAVEL_PERCENTAGE_UNKNOWN" : null,
            evidenceKeys: travelEvidence?.evidence.map((item) => item.evidence_key) ?? [],
            policyReference: travelStatus === "NOT_APPLICABLE" ? `workability_policy:${workabilityPolicyResolution.policyHash}` : null,
          },
        ));

        const workabilityFacts = normalizeWorkabilityFacts(job.workability_facts);
        const employmentType = String(workabilityFacts["employment_type"] ?? job.employment_type ?? "UNKNOWN").toUpperCase();
        const employmentStatus = employmentType === "CONTRACT" && !workabilityPolicyResolution.policy.contractAllowed
          ? "BLOCKED"
          : employmentType === "PERMANENT" || employmentType === "CONTRACT" ? "MET" : "NEEDS_VERIFICATION";
        readinessChecks.push(readinessCheck(
          "EMPLOYMENT_ROUTE",
          employmentStatus,
          employmentStatus === "MET" ? `Employment type ${employmentType} is permitted by the active preference.` : employmentStatus === "BLOCKED" ? "Contract employment conflicts with the active employment preference." : "Employment type or hiring route is unknown.",
          readinessAssessedAt,
          { reasonCode: employmentStatus === "BLOCKED" ? "CONTRACT_EMPLOYMENT_NOT_ALLOWED" : employmentStatus === "NEEDS_VERIFICATION" ? "EMPLOYMENT_ROUTE_UNKNOWN" : null },
        ));

        let mandatoryQualificationCheck: MaterialReadinessCheck;
        if (!currentMatch || !job.active_requirement_set_id || !job.latest_match_run_id) {
          mandatoryQualificationCheck = readinessCheck(
            "MANDATORY_QUALIFICATIONS", "PROCESSING", "Current requirement matching has not completed against the active profile and requirement set.", readinessAssessedAt,
            { reasonCode: "CURRENT_MATCH_PENDING" },
          );
        } else {
          const { rows: qualificationRows } = await client.query<{
            total_mandatory: number | string;
            matched_mandatory: number | string;
            blocked_mandatory: number | string;
            unresolved_mandatory: number | string;
          }>(
            `SELECT COUNT(jr.id) AS total_mandatory,
                    COUNT(jr.id) FILTER (WHERE current_match.match_type = 'MATCH') AS matched_mandatory,
                    COUNT(jr.id) FILTER (WHERE current_match.match_type = 'NO_MATCH') AS blocked_mandatory,
                    COUNT(jr.id) FILTER (WHERE current_match.match_type IS DISTINCT FROM 'MATCH' AND current_match.match_type IS DISTINCT FROM 'NO_MATCH') AS unresolved_mandatory
             FROM job_requirements jr
             LEFT JOIN LATERAL (
               SELECT rem.match_type
               FROM requirement_evidence_matches rem
               WHERE rem.workspace_id = jr.workspace_id
                 AND rem.match_run_id = $3
                 AND rem.requirement_id = jr.id
               ORDER BY rem.created_at DESC, rem.id DESC
               LIMIT 1
             ) current_match ON TRUE
             WHERE jr.workspace_id = $1 AND jr.canonical_job_id = $2
               AND jr.job_version_id = $4 AND jr.requirement_set_id = $5
               AND jr.importance = 'MUST'`,
            [ctx.workspaceId, job.canonical_job_id, job.latest_match_run_id, job.job_version_id, job.active_requirement_set_id],
          );
          const qualificationSummary = qualificationRows[0];
          const totalMandatory = asNumber(qualificationSummary?.total_mandatory) ?? 0;
          const blockedMandatory = asNumber(qualificationSummary?.blocked_mandatory) ?? 0;
          const unresolvedMandatory = asNumber(qualificationSummary?.unresolved_mandatory) ?? 0;
          mandatoryQualificationCheck = totalMandatory === 0
            ? readinessCheck("MANDATORY_QUALIFICATIONS", "NOT_APPLICABLE", "The current requirement set contains no MUST qualifications.", readinessAssessedAt, { policyReference: `requirement_set:${job.active_requirement_set_id}` })
            : blockedMandatory > 0
              ? readinessCheck("MANDATORY_QUALIFICATIONS", "BLOCKED", `${blockedMandatory} mandatory qualification(s) have supported mismatching evidence.`, readinessAssessedAt, { reasonCode: "MANDATORY_QUALIFICATION_MISMATCH" })
              : unresolvedMandatory > 0
                ? readinessCheck("MANDATORY_QUALIFICATIONS", "NEEDS_VERIFICATION", `${unresolvedMandatory} mandatory qualification(s) remain unknown or unresolved.`, readinessAssessedAt, { reasonCode: "MANDATORY_QUALIFICATION_UNKNOWN" })
                : readinessCheck("MANDATORY_QUALIFICATIONS", "MET", `${totalMandatory} mandatory qualification(s) have matching evidence.`, readinessAssessedAt);
        }
        readinessChecks.push(mandatoryQualificationCheck);

        const compensationPolicy = preferenceContext.stage3?.compensation;
        const hasCompensationFloor = Boolean(compensationPolicy && [
          compensationPolicy.commercial_min_annual_sgd,
          compensationPolicy.university_research_min_annual_sgd,
          compensationPolicy.mission_multilateral_min_annual_sgd,
          compensationPolicy.startup_min_cash_salary_monthly_sgd,
        ].some((value) => typeof value === "number" && value > 0));
        const compensationStatus = !hasCompensationFloor
          ? "NOT_APPLICABLE"
          : compensationAssessment === null || compensationAssessment.status === "UNKNOWN"
            ? "NEEDS_VERIFICATION"
            : compensationAssessment.status === "BELOW_FLOOR" ? "BLOCKED" : "MET";
        readinessChecks.push(readinessCheck(
          "COMPENSATION",
          compensationStatus,
          compensationStatus === "NOT_APPLICABLE"
            ? "No active compensation floor is configured."
            : compensationStatus === "NEEDS_VERIFICATION"
              ? fxRateFailure ? "Compensation conversion or source evidence is unavailable and requires retry/verification." : "Guaranteed base compensation, salary basis, period, currency, or category is unresolved."
              : compensationStatus === "BLOCKED"
                ? compensationAssessment?.evidence ?? "Guaranteed base compensation is below the active floor."
                : compensationAssessment?.evidence ?? "Guaranteed base compensation meets the active floor.",
          readinessAssessedAt,
          {
            reasonCode: compensationStatus === "BLOCKED" ? "COMPENSATION_BELOW_USER_FLOOR" : compensationStatus === "NEEDS_VERIFICATION" ? "COMPENSATION_UNKNOWN" : null,
            importance: compensationStatus === "NOT_APPLICABLE" ? "PREFERRED" : "MUST",
            evidenceKeys: fxRateObservationId ? [`fx_rate_observation:${fxRateObservationId}`] : [],
            policyReference: compensationStatus === "NOT_APPLICABLE" ? `stage3_compensation:${preferenceContext.revisionsByDomain.stage3 ?? "unconfigured"}` : null,
          },
        ));

        const employerPolicyStatus = normalizedGateDecision === "HARD_REJECT"
          ? "BLOCKED"
          : normalizedGateDecision === "PASS" ? "MET" : normalizedGateDecision === "NEEDS_VERIFICATION" ? "NEEDS_VERIFICATION" : "PROCESSING";
        readinessChecks.push(readinessCheck(
          "EMPLOYER_POLICY",
          employerPolicyStatus,
          employerPolicyStatus === "MET" ? "Current deterministic employer exclusion and operating-model checks passed." : employerPolicyStatus === "BLOCKED" ? "A deterministic active employer or workability policy blocked this job." : employerPolicyStatus === "NEEDS_VERIFICATION" ? "An employer/workability policy fact remains unresolved." : "Current deterministic gate decision is not available.",
          readinessAssessedAt,
          { reasonCode: employerPolicyStatus === "BLOCKED" ? "DETERMINISTIC_POLICY_BLOCK" : employerPolicyStatus === "NEEDS_VERIFICATION" ? "POLICY_FACT_UNRESOLVED" : employerPolicyStatus === "PROCESSING" ? "GATE_DECISION_PENDING" : null },
        ));

        const roleShape = sourceEvidence?.role_shape;
        const roleShapeStatus = roleShape?.status === "SUPPORTED" && roleShape.role_families.length > 0
          ? "MET"
          : normalizedGateDecision === "HARD_REJECT" ? "BLOCKED" : "NEEDS_VERIFICATION";
        readinessChecks.push(readinessCheck(
          "ROLE_SHAPE",
          roleShapeStatus,
          roleShapeStatus === "MET" ? "Source evidence identifies a target technical or technical-delivery role shape." : roleShapeStatus === "BLOCKED" ? "Deterministic function gates rejected the role shape." : "Role-function and technical-ownership evidence is incomplete.",
          readinessAssessedAt,
          { reasonCode: roleShapeStatus === "BLOCKED" ? "ROLE_SHAPE_OUT_OF_SCOPE" : roleShapeStatus === "NEEDS_VERIFICATION" ? "ROLE_SHAPE_UNVERIFIED" : null, evidenceKeys: roleShape?.evidence.map((item) => item.evidence_key) ?? [] },
        ));

        const evidenceContextStatus = currentMatch && job.active_profile_version_id && job.active_requirement_set_id
          ? "MET" : "PROCESSING";
        readinessChecks.push(readinessCheck(
          "EVIDENCE_CONTEXT",
          evidenceContextStatus,
          evidenceContextStatus === "MET" ? "Current job, profile, requirement set, and match context are lineage-pinned." : "Current profile/match/requirement artifacts are pending or stale.",
          readinessAssessedAt,
          { reasonCode: evidenceContextStatus === "PROCESSING" ? "DECISION_CONTEXT_PENDING" : null },
        ));

        const readinessFingerprint = buildApplicationReadinessFingerprint({
          workspace_id: ctx.workspaceId,
          canonical_job_id: job.canonical_job_id,
          job_version_id: job.job_version_id,
          job_content_hash: job.job_content_hash ?? "legacy-content-unknown",
          evidence_revision_hash: evidenceRevisionHash,
          profile_version_id: job.active_profile_version_id,
          profile_evidence_hash: job.active_profile_source_hash ?? null,
          requirement_set_id: job.active_requirement_set_id,
          requirements_hash: job.match_context_fingerprint,
          match_run_id: job.latest_match_run_id,
          match_context_fingerprint: job.match_context_fingerprint,
          embedding_space_id: job.match_embedding_space_id,
          preference_context_id: preferenceContext.contextId,
          workability_policy_hash: workabilityPolicyResolution.policyHash,
          decision_policy_hash: snapshot.snapshotHash,
          fx_rate_observation_ids: fxRateObservationId ? [fxRateObservationId] : [],
          comparator_version: QUALIFICATION_COMPARATOR_VERSION,
          evidence_schema_version: sourceEvidence?.schema_version ?? "legacy_unknown",
          availability_evidence_hash: availabilityEvidenceHash,
          availability_verification_revision: availabilityVerificationRevision,
        });
        const readiness = assessApplicationReadiness({
          canonicalJobId: job.canonical_job_id,
          jobVersionId: job.job_version_id,
          profileVersionId: job.active_profile_version_id,
          requirementSetId: job.active_requirement_set_id,
          matchRunId: job.latest_match_run_id,
          preferenceContextId: preferenceContext.contextId,
          policySnapshotId: snapshot.snapshotId,
          policyVersion: snapshot.decisionPolicy.policy.policy_version,
          evidenceRevisionHash,
          readinessFingerprint,
          checks: readinessChecks,
          evaluatedAt: readinessAssessedAt,
          artifactsCurrent: currentMatch,
        });
        if (readiness.status === "BLOCKED") {
          adjustedEligibility = "INELIGIBLE";
          adjustedOutcome = "SKIP";
          adjustedNotes.push("application_readiness_blocked");
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
            eligibility: adjustedEligibility,
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
            evidence_revision_hash: evidenceRevisionHash,
            readiness_fingerprint: readiness.readiness_fingerprint,
            availability_evidence_hash: availabilityEvidenceHash,
            fx_rate_observation_id: fxRateObservationId,
            qualification_comparator_version: QUALIFICATION_COMPARATOR_VERSION,
            notes: adjustedNotes,
          },
        });

        const decisionHash = sha256Hex(stableStringify({
          decision: decisionJson,
          application_readiness: readiness,
          evidence_revision_hash: evidenceRevisionHash,
          preference_context_id: preferenceContext.contextId,
        }));
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
            preference_context_id: preferenceContext.contextId,
            evidence_revision_hash: evidenceRevisionHash,
            readiness_fingerprint: readiness.readiness_fingerprint,
            availability_evidence_hash: availabilityEvidenceHash,
            fx_rate_observation_id: fxRateObservationId,
            qualification_comparator_version: QUALIFICATION_COMPARATOR_VERSION,
            workability_policy_hash: workabilityPolicyResolution.policyHash,
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
              created_by_user_id,
              preference_user_id,
              preference_context_id,
              readiness_json,
              evidence_revision_hash,
              readiness_fingerprint
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
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
            adjustedEligibility,
            adjustedOutcome,
            ctx.userId,
            preferenceContext.contextId ? ctx.userId : null,
            preferenceContext.contextId,
            JSON.stringify(readiness),
            evidenceRevisionHash,
            readiness.readiness_fingerprint,
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
            AND c.latest_job_version_id = $9
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
            adjustedEligibility,
            adjustedOutcome,
            requirementScore,
            coverageScore,
            evidenceCompleteness,
            decisionId,
            job.canonical_job_id,
            job.job_version_id,
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
