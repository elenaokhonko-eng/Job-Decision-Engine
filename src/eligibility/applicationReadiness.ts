import { stableStringify, sha256Hex } from "../config/structuredLoader.js";
import {
  APPLICATION_READINESS_SCHEMA_VERSION,
  ApplicationReadinessSchema,
  type ApplicationReadiness,
  type MaterialReadinessCheck,
} from "../contracts/applicationReadiness.js";

export const APPLICATION_READINESS_POLICY_VERSION = "application_readiness_policy_v1" as const;
export const QUALIFICATION_COMPARATOR_VERSION = "experience_scope_v2" as const;

export const REQUIRED_MATERIAL_READINESS_CHECK_KEYS = [
  "SOURCE_IDENTITY",
  "DESCRIPTION_COMPLETENESS",
  "AVAILABILITY",
  "FRESHNESS",
  "WORK_AUTHORIZATION",
  "WORK_MODE",
  "TRAVEL",
  "EMPLOYMENT_ROUTE",
  "COMPENSATION",
  "MANDATORY_QUALIFICATIONS",
  "EMPLOYER_POLICY",
  "ROLE_SHAPE",
] as const;

export interface ApplicationReadinessFingerprintInput {
  readonly workspace_id: string;
  readonly canonical_job_id: string;
  readonly job_version_id: string;
  readonly job_content_hash: string;
  readonly evidence_revision_hash: string;
  readonly profile_version_id: string | null;
  readonly profile_evidence_hash: string | null;
  readonly requirement_set_id: string | null;
  readonly requirements_hash: string | null;
  readonly match_run_id: string | null;
  readonly match_context_fingerprint: string | null;
  readonly embedding_space_id: string | null;
  readonly preference_context_id: string | null;
  readonly workability_policy_hash: string;
  readonly decision_policy_hash: string;
  readonly fx_rate_observation_ids: readonly string[];
  readonly comparator_version: string;
  readonly evidence_schema_version: string;
  readonly availability_evidence_hash: string | null;
  readonly availability_verification_revision?: string | null;
}

export function buildApplicationReadinessFingerprint(
  input: ApplicationReadinessFingerprintInput,
): string {
  const normalized = {
    schema_version: APPLICATION_READINESS_SCHEMA_VERSION,
    readiness_policy_version: APPLICATION_READINESS_POLICY_VERSION,
    workspace_id: input.workspace_id,
    canonical_job_id: input.canonical_job_id,
    job_version_id: input.job_version_id,
    job_content_hash: input.job_content_hash,
    evidence_revision_hash: input.evidence_revision_hash,
    profile_version_id: input.profile_version_id,
    profile_evidence_hash: input.profile_evidence_hash,
    requirement_set_id: input.requirement_set_id,
    requirements_hash: input.requirements_hash,
    match_run_id: input.match_run_id,
    match_context_fingerprint: input.match_context_fingerprint,
    embedding_space_id: input.embedding_space_id,
    preference_context_id: input.preference_context_id,
    workability_policy_hash: input.workability_policy_hash,
    decision_policy_hash: input.decision_policy_hash,
    fx_rate_observation_ids: [...input.fx_rate_observation_ids].sort(),
    comparator_version: input.comparator_version,
    evidence_schema_version: input.evidence_schema_version,
    availability_evidence_hash: input.availability_evidence_hash,
    availability_verification_revision: input.availability_verification_revision ?? null,
  };
  return sha256Hex(stableStringify(normalized));
}

export interface AssessApplicationReadinessInput {
  readonly canonicalJobId: string;
  readonly jobVersionId: string;
  readonly profileVersionId: string | null;
  readonly requirementSetId: string | null;
  readonly matchRunId: string | null;
  readonly preferenceContextId: string | null;
  readonly policySnapshotId: string | null;
  readonly policyVersion: string;
  readonly evidenceRevisionHash: string;
  readonly readinessFingerprint: string;
  readonly checks: readonly MaterialReadinessCheck[];
  readonly evaluatedAt: string;
  readonly artifactsCurrent?: boolean;
}

function earliestExpiry(checks: readonly MaterialReadinessCheck[]): string | null {
  const expiries = checks
    .map((check) => check.expires_at)
    .filter((value): value is string => value !== null)
    .map((value) => ({ value, timestamp: Date.parse(value) }))
    .filter((entry) => Number.isFinite(entry.timestamp))
    .sort((left, right) => left.timestamp - right.timestamp);
  return expiries[0]?.value ?? null;
}

export function assessApplicationReadiness(
  input: AssessApplicationReadinessInput,
): ApplicationReadiness {
  const checks = [...input.checks];
  const presentKeys = new Set(checks.map((check) => check.key));
  const missingChecks = REQUIRED_MATERIAL_READINESS_CHECK_KEYS.filter((key) => !presentKeys.has(key));
  if (missingChecks.length > 0) {
    const assessmentCheck: MaterialReadinessCheck = {
      key: "EVIDENCE_CONTEXT",
      status: input.artifactsCurrent === false ? "PROCESSING" : "NEEDS_VERIFICATION",
      importance: "MUST",
      reason_code: input.artifactsCurrent === false ? "READINESS_ARTIFACTS_PENDING" : "READINESS_ASSESSMENT_INCOMPLETE",
      rationale: `Required material checks were not produced: ${missingChecks.join(", ")}.`,
      evidence_keys: [],
      policy_reference: null,
      assessed_at: input.evaluatedAt,
      expires_at: null,
    };
    const existingIndex = checks.findIndex((check) => check.key === "EVIDENCE_CONTEXT");
    if (existingIndex >= 0) {
      const existing = checks[existingIndex];
      checks[existingIndex] = existing.status === "BLOCKED" ? existing : assessmentCheck;
    } else {
      checks.push(assessmentCheck);
    }
  }

  const mandatoryChecks = checks.filter((check) => check.importance === "MUST");
  const blockers = mandatoryChecks.filter((check) => check.status === "BLOCKED");
  const processing = mandatoryChecks.filter((check) => check.status === "PROCESSING");
  const unresolved = mandatoryChecks.filter((check) => check.status === "NEEDS_VERIFICATION");
  const status = blockers.length > 0
    ? "BLOCKED"
    : processing.length > 0
      ? "PROCESSING"
      : unresolved.length > 0
        ? "NEEDS_VERIFICATION"
        : "READY";
  const reasonCodes = [...new Set(
    mandatoryChecks
      .filter((check) => check.status === "BLOCKED" || check.status === "NEEDS_VERIFICATION" || check.status === "PROCESSING")
      .map((check) => check.reason_code)
      .filter((reason): reason is string => reason !== null),
  )].sort();

  return ApplicationReadinessSchema.parse({
    schema_version: APPLICATION_READINESS_SCHEMA_VERSION,
    status,
    reason_codes: reasonCodes,
    checks,
    canonical_job_id: input.canonicalJobId,
    job_version_id: input.jobVersionId,
    profile_version_id: input.profileVersionId,
    requirement_set_id: input.requirementSetId,
    match_run_id: input.matchRunId,
    preference_context_id: input.preferenceContextId,
    policy_snapshot_id: input.policySnapshotId,
    policy_version: input.policyVersion,
    qualification_comparator_version: QUALIFICATION_COMPARATOR_VERSION,
    evidence_revision_hash: input.evidenceRevisionHash,
    readiness_fingerprint: input.readinessFingerprint,
    evaluated_at: input.evaluatedAt,
    expires_at: earliestExpiry(checks),
  });
}
