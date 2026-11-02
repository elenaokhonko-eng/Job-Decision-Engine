import { z } from "zod";

export const MANUAL_APPLICATION_SCHEMA_VERSION = "manual_application_v1" as const;
const Uuid = z.string().uuid();
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/i);
const HttpUrl = z.string().trim().url().max(2048).refine((value) => {
  const parsed = new URL(value);
  return (parsed.protocol === "https:" || parsed.protocol === "http:") && !parsed.username && !parsed.password;
}, "A credential-free HTTP(S) posting URL is required.");

export const ManualFetchSourceEvidenceSchema = z.object({
  requestedUrl: HttpUrl,
  resolvedUrl: HttpUrl,
  redirectHistory: z.array(HttpUrl).max(5),
  retrievedAt: z.string().datetime(),
  httpStatus: z.number().int().min(100).max(599),
  contentType: z.string().max(255).nullable(),
  responseHash: Sha256,
}).strict();
export type ManualFetchSourceEvidence = z.infer<typeof ManualFetchSourceEvidenceSchema>;

const ManualPostingBase = {
  schema_version: z.literal(MANUAL_APPLICATION_SCHEMA_VERSION),
  candidate_profile_id: Uuid,
  title: z.string().trim().min(2).max(300),
  company: z.string().trim().min(1).max(300),
  url: HttpUrl,
  requisition_id: z.string().trim().max(160).nullable().optional(),
  description: z.string().trim().min(100).max(100_000),
  location: z.string().trim().max(300).default("Unknown"),
};

export const ManualPostingInputSchema = z.discriminatedUnion("source_kind", [
  z.object({ ...ManualPostingBase, source_kind: z.literal("PASTED") }).strict(),
  z.object({ ...ManualPostingBase, source_kind: z.literal("UPLOAD") }).strict(),
  z.object({ ...ManualPostingBase, source_kind: z.literal("FETCHED"), fetch_receipt_id: Uuid }).strict(),
]);
export type ManualPostingInput = z.infer<typeof ManualPostingInputSchema>;

export const ManualStagedPostingIdentitySchema = z.object({
  schema_version: z.literal(MANUAL_APPLICATION_SCHEMA_VERSION),
  canonicalJobId: Uuid,
  jobVersionId: Uuid,
  sourceObservationId: Uuid,
  contentHash: z.string().min(1).max(255),
}).strict();
export type ManualStagedPostingIdentity = z.infer<typeof ManualStagedPostingIdentitySchema>;

export const ManualCandidateProfileOptionSchema = z.object({
  candidate_profile_id: Uuid,
  display_name: z.string().min(1).max(300),
}).strict();

export const ManualCandidateProfilesResponseSchema = z.object({
  schema_version: z.literal(MANUAL_APPLICATION_SCHEMA_VERSION),
  ok: z.literal(true),
  profiles: z.array(ManualCandidateProfileOptionSchema).max(50),
}).strict();

export const ManualComparisonSourceSchema = z.discriminatedUnion("source_kind", [
  z.object({
    source_kind: z.enum(["PASTED", "UPLOAD"]),
    source_content_status: z.literal("USER_PROVIDED"),
    provider: z.null(),
    fetched_content_hash: z.null(),
    source_evidence: z.null(),
  }).strict(),
  z.object({
    source_kind: z.literal("FETCHED"),
    source_content_status: z.enum(["COMPLETE", "USER_EDITED"]),
    provider: z.enum(["ASHBY", "GREENHOUSE", "LEVER", "EMPLOYER_WEBSITE"]),
    fetched_content_hash: Sha256,
    source_evidence: ManualFetchSourceEvidenceSchema,
  }).strict(),
]);

export const ManualRequirementSchema = z.object({
  requirement_key: z.string().min(1),
  requirement_type: z.string().min(1),
  importance: z.enum(["MUST", "PREFERRED", "NICE_TO_HAVE"]),
  requirement_text: z.string().min(1),
}).strict();

export const ManualEvidenceSchema = z.object({
  id: z.string().min(1),
  evidence_type: z.enum(["FACT", "CREDENTIAL", "ENGAGEMENT"]),
  label: z.string().min(1),
  statement: z.string().min(1),
  // The profile engagement a fact belongs to (an ENGAGEMENT row carries its own id), for grouping CV experience.
  engagement_id: z.string().min(1).optional(),
  // Profile attributes that decide where an item appears in a document; absent on older comparisons.
  fact_type: z.string().min(1).optional(),
  credential_type: z.enum(["CERTIFICATION", "DEGREE", "COURSE", "LICENSE"]).optional(),
  engagement_type: z.enum(["EMPLOYEE", "FOUNDER_OPERATOR", "CONTRACTOR", "RESEARCHER"]).optional(),
  experience_class: z.string().min(1).optional(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // Candidate preferences from the profile: a role's default CV layout, and a credential pinned to every document.
  document_layout: z.enum(["FULL", "ONE_LINE", "HIDDEN"]).optional(),
  always_include: z.boolean().optional(),
}).strict();

export const ManualComparisonRowSchema = z.object({
  requirement_key: z.string().min(1),
  requirement_type: z.string().min(1),
  importance: z.enum(["MUST", "PREFERRED", "NICE_TO_HAVE"]),
  requirement: z.string().min(1),
  evidence: z.array(z.object({
    id: z.string().min(1),
    type: z.enum(["FACT", "CREDENTIAL", "ENGAGEMENT"]),
    label: z.string().min(1),
    statement: z.string().min(1),
    // Present when a model proposed the pair: its confidence (0-1) and one-line reason.
    confidence: z.number().min(0).max(1).optional(),
    justification: z.string().min(1).optional(),
  }).strict()),
  gap: z.string().nullable(),
  comparison_method: z.enum([
    "literal-term overlap; potential evidence only",
    "distinctive-term overlap; potential evidence only",
    "model-judged pairing; advisory evidence only",
  ]),
}).strict();

// How many MUST requirements have direct evidence; advisory, never a suitability decision.
export const ManualFitCheckSchema = z.object({
  must_total: z.number().int().min(0),
  must_covered: z.number().int().min(0),
  uncovered_must: z.array(z.object({ requirement_key: z.string().min(1), requirement: z.string().min(1) }).strict()),
  verdict: z.enum(["NO_MUST_REQUIREMENTS", "MOST_MUSTS_EVIDENCED", "FEWER_THAN_HALF_MUSTS_EVIDENCED"]),
  message: z.string().min(1),
  advisory: z.string().min(1),
}).strict();

export const ManualComparisonSchema = z.object({
  schema_version: z.literal(MANUAL_APPLICATION_SCHEMA_VERSION),
  comparator_version: z.string().min(1),
  canonical_job_id: Uuid,
  job_version_id: Uuid,
  source_observation_id: Uuid,
  source_evidence_fingerprint: Sha256,
  job_content_hash: z.string().min(1),
  profile_version_id: Uuid,
  candidate_profile_id: Uuid,
  requirement_set_id: Uuid,
  profile_contact_fact_ids: z.array(Uuid),
  profile_contact_fingerprint: Sha256,
  preference_context_fingerprint: Sha256,
  context_fingerprint: Sha256,
  title: z.string().min(1),
  company: z.string().min(1),
  canonical_url: z.string().url().nullable(),
  requirements: z.array(ManualRequirementSchema),
  evidence: z.array(ManualEvidenceSchema),
  rows: z.array(ManualComparisonRowSchema),
  // Absent on comparisons made before the fit check existed.
  fit: ManualFitCheckSchema.optional(),
  suitability_warnings: z.array(z.string()),
  evidence_notice: z.string().min(1),
}).strict();
export type ManualComparison = z.infer<typeof ManualComparisonSchema>;

export const ManualRoleLayoutSchema = z.enum(["FULL", "ONE_LINE", "HIDDEN"]);

export const ManualRolePlanSchema = z.object({
  engagement_id: z.string().min(1),
  label: z.string().min(1),
  period: z.string().min(1).nullable(),
  kind: z.enum(["EMPLOYMENT", "VENTURE"]),
  // SUMMARISED: older than 20 years, folded into one shared earlier-career line.
  default_layout: z.enum(["FULL", "ONE_LINE", "SUMMARISED", "HIDDEN"]),
  default_source: z.enum(["PROFILE", "AUTOMATIC"]),
}).strict();

export const ManualCompareResponseSchema = z.object({
  schema_version: z.literal(MANUAL_APPLICATION_SCHEMA_VERSION),
  ok: z.literal(true),
  draft_id: Uuid,
  comparison_id: Uuid,
  comparison_fingerprint: Sha256,
  selected_job: ManualStagedPostingIdentitySchema.extend({
    title: z.string().min(1),
    company: z.string().min(1),
    url: z.string().url().nullable(),
    source: ManualComparisonSourceSchema,
  }).strict(),
  comparison: ManualComparisonSchema,
  document_contact_ready: z.boolean(),
  missing_contact_fields: z.array(z.enum(["full_name", "phone"])),
  requirements_extracted: z.boolean(),
  // The CV's roles, newest first, with the layout each gets unless the candidate chooses otherwise.
  role_plan: z.array(ManualRolePlanSchema).optional(),
}).strict();

export const ManualPersistedDraftSchema = z.object({
  id: Uuid,
  workspace_id: Uuid,
  user_id: Uuid,
  candidate_profile_id: Uuid,
  canonical_job_id: Uuid,
  job_version_id: Uuid,
  source_observation_id: Uuid,
  job_content_hash: z.string().min(1).max(255),
  profile_version_id: Uuid,
  profile_contact_fact_ids: z.array(Uuid),
  profile_contact_fingerprint: Sha256,
  preference_context_fingerprint: Sha256,
  requirement_set_id: Uuid,
  comparator_version: z.string().min(1).max(80),
  context_fingerprint: Sha256,
  comparison_fingerprint: Sha256,
  comparison_payload: ManualComparisonSchema,
  suitability_warnings: z.array(z.string()),
}).strict();

export const ManualApprovalRequestSchema = z.object({
  approved: z.literal(true),
  comparison_fingerprint: Sha256,
}).strict();

export const ManualApprovalResponseSchema = z.object({
  schema_version: z.literal(MANUAL_APPLICATION_SCHEMA_VERSION),
  ok: z.literal(true),
  approval_id: Uuid,
  approved: z.literal(true),
  comparison_fingerprint: Sha256,
}).strict();

/** In-memory identity used to compare persisted approval with current inputs. */
export const ManualApprovalIdentitySchema = z.object({
  canonicalJobId: Uuid,
  jobVersionId: Uuid,
  sourceObservationId: Uuid,
  jobContentHash: z.string().min(1).max(255),
  profileVersionId: Uuid,
  candidateProfileId: Uuid,
  profileContactFactIdsFingerprint: Sha256,
  profileContactFingerprint: Sha256,
  preferenceContextFingerprint: Sha256,
  requirementSetId: Uuid,
  comparatorVersion: z.string().min(1).max(80),
  comparisonFingerprint: Sha256,
}).strict();

/** Exact PostgreSQL row projection used by approval, generation, and download. */
export const ManualPersistedApprovalSchema = z.object({
  id: Uuid,
  workspace_id: Uuid,
  user_id: Uuid,
  draft_id: Uuid,
  candidate_profile_id: Uuid,
  canonical_job_id: Uuid,
  job_version_id: Uuid,
  source_observation_id: Uuid,
  job_content_hash: z.string().min(1).max(255),
  profile_version_id: Uuid,
  profile_contact_fact_ids: z.array(Uuid),
  profile_contact_fingerprint: Sha256,
  preference_context_fingerprint: Sha256,
  requirement_set_id: Uuid,
  comparator_version: z.string().min(1).max(80),
  context_fingerprint: Sha256,
  comparison_fingerprint: Sha256,
  approved: z.literal(true),
}).strict();

export const ManualGenerateRequestSchema = z.object({
  approval_id: Uuid,
  // The candidate's per-role choice, keyed by engagement id from role_plan; unlisted roles keep their default.
  role_layout: z.record(z.string().min(1), ManualRoleLayoutSchema).optional(),
}).strict();

export const ManualArtifactSchema = z.object({
  type: z.enum(["CV", "COVER_LETTER"]),
  format: z.enum(["DOCX", "PDF"]),
  filename: z.string().min(1).max(160),
  mime_type: z.string().min(1),
}).strict();

/** How the cover letter was written, and the approved evidence behind each sentence, for review before download. */
export const ManualCoverLetterReviewSchema = z.object({
  mode: z.enum(["AI_WRITTEN", "DETERMINISTIC"]),
  reason: z.string().min(1).max(2000).nullable(),
  sentences: z.array(z.object({
    text: z.string().min(1),
    evidence: z.array(z.object({ id: z.string().min(1), label: z.string(), statement: z.string() }).strict()).min(1),
    requirement_keys: z.array(z.string().min(1)),
  }).strict()),
}).strict();

export const ManualDocumentsResponseSchema = z.object({
  schema_version: z.literal(MANUAL_APPLICATION_SCHEMA_VERSION),
  ok: z.literal(true),
  draft_id: Uuid,
  approval_id: Uuid,
  comparison_fingerprint: Sha256,
  preview: z.object({ cv: z.string().min(1), cover_letter: z.string().min(1) }).strict(),
  artifacts: z.array(ManualArtifactSchema).length(4),
  cover_letter: ManualCoverLetterReviewSchema.optional(),
  // How the CV summary was written, and the evidence behind each sentence; same shape as cover_letter.
  summary: ManualCoverLetterReviewSchema.optional(),
}).strict();

export const ManualDownloadResponseSchema = z.object({
  schema_version: z.literal(MANUAL_APPLICATION_SCHEMA_VERSION),
  ok: z.literal(true),
  filename: z.string().min(1).max(160),
  mime_type: z.enum([
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ]),
  sha256: Sha256,
  content_base64: z.string().min(1),
}).strict();

export const ManualApiErrorSchema = z.object({
  schema_version: z.literal(MANUAL_APPLICATION_SCHEMA_VERSION),
  ok: z.literal(false),
  error: z.string().min(1),
  code: z.enum([
    "INVALID_REQUEST", "DESCRIPTION_INSUFFICIENT", "FORBIDDEN", "NOT_FOUND",
    "JOB_VERSION_CHANGED", "IDENTITY_CONFLICT", "APPROVAL_STALE", "DEPENDENCY_UNAVAILABLE", "INTERNAL_ERROR",
  ]),
  message: z.string().min(1),
  retry_after: z.string().datetime().optional(),
}).strict();

export const ManualFetchDescriptionRequestSchema = z.object({
  url: HttpUrl,
  title: z.string().trim().min(2).max(300),
  company: z.string().trim().min(1).max(300),
  requisition_id: z.string().trim().max(160).nullable().optional(),
}).strict();

export const ManualFetchDescriptionResponseSchema = z.object({
  schema_version: z.literal(MANUAL_APPLICATION_SCHEMA_VERSION),
  ok: z.literal(true),
  fetch_receipt_id: Uuid,
  description: z.string().min(100).max(100_000),
  final_url: HttpUrl,
  provider: z.enum(["ASHBY", "GREENHOUSE", "LEVER", "EMPLOYER_WEBSITE"]),
  content_hash: Sha256,
  source_evidence: ManualFetchSourceEvidenceSchema,
}).strict();

export const ManualPersistedFetchReceiptSchema = z.object({
  id: Uuid,
  workspace_id: Uuid,
  user_id: Uuid,
  requested_url: HttpUrl,
  resolved_url: HttpUrl,
  canonical_url: HttpUrl,
  expected_title: z.string().min(2).max(300),
  expected_company: z.string().min(1).max(300),
  expected_requisition_id: z.string().max(160).nullable(),
  description_hash: Sha256,
  content_hash: Sha256,
  provider: z.enum(["ASHBY", "GREENHOUSE", "LEVER", "EMPLOYER_WEBSITE"]),
  source_evidence: ManualFetchSourceEvidenceSchema,
  expires_at: z.string().datetime(),
}).strict();

export const ManualFetchDescriptionOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("COMPLETE"), posting: ManualFetchDescriptionResponseSchema }).strict(),
  z.object({ status: z.enum(["RETRYABLE_FAILURE", "BLOCKED", "IDENTITY_CONFLICT", "UNAVAILABLE"]), code: z.string().min(1), message: z.string().min(1), retry_after_ms: z.number().int().nonnegative().optional() }).strict(),
]);
