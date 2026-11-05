import { z } from "zod";

export const ARCHIVE_CONTRACT_SCHEMA_VERSION = "job_archive_v1" as const;

export const ArchiveAgeBasisSchema = z.enum([
  "GENUINE_REPOST_DATE",
  "AUTHORITATIVE_PUBLICATION_DATE",
  "OBSERVED_AGE_PUBLICATION_UNKNOWN",
]);
export type ArchiveAgeBasis = z.infer<typeof ArchiveAgeBasisSchema>;

export const ArchiveEventActionSchema = z.enum([
  "ARCHIVED",
  "RESTORED",
  "REPOST_REACTIVATED",
]);
export type ArchiveEventAction = z.infer<typeof ArchiveEventActionSchema>;

export const ArchiveJobRowSchema = z.object({
  schema_version: z.literal(ARCHIVE_CONTRACT_SCHEMA_VERSION),
  workspace_id: z.string().uuid(),
  canonical_job_id: z.string().uuid(),
  job_version_id: z.string().uuid().nullable(),
  title: z.string().min(1),
  company: z.string().min(1),
  canonical_url: z.string().nullable(),
  description: z.string().nullable(),
  source: z.string().nullable(),
  location: z.string().nullable(),
  workplace_type: z.string().nullable(),
  processing_state: z.string().nullable(),
  recommendation_outcome: z.string().nullable(),
  archived_at: z.string().datetime(),
  archive_reason: z.string().min(1),
  archive_age_basis: ArchiveAgeBasisSchema,
  archive_reference_at: z.string().datetime(),
  application_status: z.string().nullable(),
  active_hold_until: z.string().datetime().nullable(),
});
export type ArchiveJobRow = z.infer<typeof ArchiveJobRowSchema>;

export const ArchiveHoldCreateRequestSchema = z.object({
  canonical_job_id: z.string().uuid(),
  hold_reason: z.string().trim().min(1).max(1000),
  hold_type: z.enum(["USER_PRESERVE", "AGENT2_PILOT"]),
  expires_at: z.string().datetime(),
});
export type ArchiveHoldCreateRequest = z.infer<typeof ArchiveHoldCreateRequestSchema>;

export const ArchiveHoldReleaseRequestSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
});
export type ArchiveHoldReleaseRequest = z.infer<typeof ArchiveHoldReleaseRequestSchema>;

export const ArchiveRestoreRequestSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
});
export type ArchiveRestoreRequest = z.infer<typeof ArchiveRestoreRequestSchema>;

export const ArchiveHoldSchema = z.object({
  schema_version: z.literal(ARCHIVE_CONTRACT_SCHEMA_VERSION),
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  canonical_job_id: z.string().uuid(),
  hold_reason: z.string().min(1).max(1000),
  hold_type: z.enum(["USER_PRESERVE", "AGENT2_PILOT", "RESTORE_REASSESSMENT"]),
  created_by: z.string().min(1),
  created_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  released_at: z.string().datetime().nullable(),
  release_reason: z.string().nullable(),
});
export type ArchiveHold = z.infer<typeof ArchiveHoldSchema>;

export const ArchiveCandidateSchema = z.object({
  canonical_job_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  title: z.string().min(1),
  company: z.string().min(1),
  reference_at: z.string().datetime(),
  age_basis: ArchiveAgeBasisSchema,
  archive_reason: z.literal("JOB_OLDER_THAN_THREE_CALENDAR_MONTHS"),
  publication_date_unknown: z.boolean(),
});
export type ArchiveCandidate = z.infer<typeof ArchiveCandidateSchema>;

export const ArchiveRunReportSchema = z.object({
  schema_version: z.literal(ARCHIVE_CONTRACT_SCHEMA_VERSION),
  run_id: z.string().uuid().nullable(),
  mode: z.enum(["DRY_RUN", "APPLY"]),
  workspace_id: z.string().uuid().nullable(),
  run_status: z.enum(["DRY_RUN", "RUNNING", "SUCCEEDED", "FAILED"]),
  completed_at: z.string().datetime().nullable(),
  archive_schema_ready: z.boolean(),
  run_started_at: z.string().datetime(),
  cutoff_at: z.string().datetime(),
  scanned_count: z.number().int().min(0),
  eligible_count: z.number().int().min(0),
  archived_count: z.number().int().min(0),
  protected_count: z.number().int().min(0),
  invalid_date_count: z.number().int().min(0),
  failed_count: z.number().int().min(0),
  deferred_count: z.number().int().min(0),
  observed_age_publication_unknown_count: z.number().int().min(0),
  candidates: z.array(ArchiveCandidateSchema),
  invalid_date_jobs: z.array(z.object({
    canonical_job_id: z.string().uuid(),
    reason_code: z.string().min(1),
  })),
  failed_jobs: z.array(z.object({
    canonical_job_id: z.string().uuid(),
    reason: z.string().min(1),
  })),

});
export type ArchiveRunReport = z.infer<typeof ArchiveRunReportSchema>;

export const ArchiveOperationsStatusSchema = z.object({
  schema_version: z.literal(ARCHIVE_CONTRACT_SCHEMA_VERSION),
  last_success_at: z.string().datetime().nullable(),
  latest_run_id: z.string().uuid().nullable(),
  latest_run_status: z.string().nullable(),
  latest_run_mode: z.string().nullable(),
  latest_run_started_at: z.string().datetime().nullable(),
  latest_run_scanned_count: z.number().int().min(0).nullable(),
  latest_run_eligible_count: z.number().int().min(0).nullable(),
  latest_run_archived_count: z.number().int().min(0).nullable(),
  latest_run_protected_count: z.number().int().min(0).nullable(),
  latest_run_invalid_date_count: z.number().int().min(0).nullable(),
  latest_run_failed_count: z.number().int().min(0).nullable(),
  latest_run_observed_age_publication_unknown_count: z.number().int().min(0).nullable(),
});
export type ArchiveOperationsStatus = z.infer<typeof ArchiveOperationsStatusSchema>;
