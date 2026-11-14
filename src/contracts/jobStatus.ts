import { z } from "zod";

/**
 * Job status buckets and technical-error support actions (migration 112).
 *
 * - `v_job_status_buckets_scoped` gives every current, non-archived job exactly one status bucket.
 * - `v_job_status_bucket_counts_scoped` counts the buckets per workspace (they sum to total_jobs).
 * - `v_application_workspace_summary_scoped` keeps `rejected_unmatched_count` and adds
 *   `rejected_count`, `unmatched_count` and `removed_count`, which sum to it.
 * - `v_job_support_issues_scoped` lists technical-error jobs per issue class with the actions the
 *   support API (`/api/v2/support-issues`) accepts for that class.
 */
export const JOB_STATUS_SCHEMA_VERSION = "job_status_v1" as const;
export const JOB_SUPPORT_ACTION_SCHEMA_VERSION = "job_support_action_v1" as const;

const CountSchema = z.number().int().min(0);
const UuidSchema = z.string().uuid();

export const JobStatusBucketSchema = z.enum([
  "APPLY_NOW",
  "REVIEW_AWAITING_AI",
  "REVIEW_EVALUATED_NOT_READY",
  "TRACK",
  "NEEDS_VERIFICATION",
  "PROCESSING",
  "SKIP",
  "TECHNICAL_ERROR",
  "REJECTED",
  "UNMATCHED",
  "REMOVED",
]);
export type JobStatusBucket = z.infer<typeof JobStatusBucketSchema>;

export const JobStatusBucketRowSchema = z.object({
  workspace_id: UuidSchema,
  canonical_job_id: UuidSchema,
  job_version_id: UuidSchema.nullable(),
  title: z.string().min(1),
  company: z.string().min(1),
  canonical_url: z.string().nullable(),
  source: z.string().nullable(),
  processing_state: z.string().min(1),
  gate_status: z.string().nullable(),
  recommendation_eligibility: z.string().nullable(),
  recommendation_outcome: z.string().nullable(),
  rejection_codes: z.array(z.string()).nullable(),
  pipeline_display_category: z.string().min(1),
  status_bucket: JobStatusBucketSchema,
  status_reason: z.string().nullable(),
  observed_at: z.coerce.date().nullable(),
});
export type JobStatusBucketRow = z.infer<typeof JobStatusBucketRowSchema>;

export const JobStatusBucketCountsSchema = z.object({
  workspace_id: UuidSchema,
  total_jobs: CountSchema,
  apply_now_count: CountSchema,
  review_awaiting_ai_count: CountSchema,
  review_evaluated_not_ready_count: CountSchema,
  track_count: CountSchema,
  needs_verification_count: CountSchema,
  processing_count: CountSchema,
  skip_count: CountSchema,
  technical_error_count: CountSchema,
  rejected_count: CountSchema,
  unmatched_count: CountSchema,
  removed_count: CountSchema,
}).superRefine((row, ctx) => {
  const bucketTotal = row.apply_now_count + row.review_awaiting_ai_count
    + row.review_evaluated_not_ready_count + row.track_count + row.needs_verification_count
    + row.processing_count + row.skip_count + row.technical_error_count + row.rejected_count
    + row.unmatched_count + row.removed_count;
  if (bucketTotal !== row.total_jobs) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Status buckets sum to ${bucketTotal}, not total_jobs ${row.total_jobs}.`,
      path: ["total_jobs"],
    });
  }
});
export type JobStatusBucketCounts = z.infer<typeof JobStatusBucketCountsSchema>;

export const ApplicationWorkspaceSummarySchema = z.object({
  workspace_id: UuidSchema,
  user_id: UuidSchema,
  user_key: z.string().min(1),
  total_jobs: CountSchema,
  apply_now_count: CountSchema,
  track_count: CountSchema,
  processing_count: CountSchema,
  /** Kept for compatibility: rejected_count + unmatched_count + removed_count. */
  rejected_unmatched_count: CountSchema,
  applied_count: CountSchema,
  technical_errors: CountSchema,
  skip_count: CountSchema,
  top_ten_ready_count: CountSchema,
  rejected_count: CountSchema,
  unmatched_count: CountSchema,
  removed_count: CountSchema,
}).superRefine((row, ctx) => {
  if (row.rejected_count + row.unmatched_count + row.removed_count !== row.rejected_unmatched_count) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "rejected_count + unmatched_count + removed_count must equal rejected_unmatched_count.",
      path: ["rejected_unmatched_count"],
    });
  }
});
export type ApplicationWorkspaceSummary = z.infer<typeof ApplicationWorkspaceSummarySchema>;

export const JobSupportIssueClassSchema = z.enum([
  "DESCRIPTION_INCOMPLETE",
  "TASK_DEAD_LETTER",
  "BLOCKED_DEPENDENCY",
  "EVALUATION_FAILED",
  "PROCESSING_ERROR",
]);
export type JobSupportIssueClass = z.infer<typeof JobSupportIssueClassSchema>;

export const JobSupportActionSchema = z.enum([
  "FETCH_DESCRIPTION",
  "PASTE_DESCRIPTION",
  "RETRY",
  "DISMISS",
]);
export type JobSupportAction = z.infer<typeof JobSupportActionSchema>;

export const JobSupportIssueRowSchema = z.object({
  workspace_id: UuidSchema,
  canonical_job_id: UuidSchema,
  job_version_id: UuidSchema,
  title: z.string().min(1),
  company: z.string().min(1),
  canonical_url: z.string().nullable(),
  source: z.string().nullable(),
  processing_state: z.string().min(1),
  recommendation_outcome: z.string().nullable(),
  issue_class: JobSupportIssueClassSchema,
  issue_detail: z.string().nullable(),
  repair_action: z.string().nullable(),
  task_ids: z.array(UuidSchema),
  task_types: z.array(z.string()),
  retryable: z.boolean(),
  fetchable_source: z.boolean(),
  available_actions: z.array(JobSupportActionSchema).min(1),
  detected_at: z.coerce.date().nullable(),
});
export type JobSupportIssueRow = z.infer<typeof JobSupportIssueRowSchema>;

/** Minimum pasted description length; the description-quality gate decides completeness. */
export const SUPPORT_PASTED_DESCRIPTION_MIN_CHARS = 200;
export const SUPPORT_PASTED_DESCRIPTION_MAX_CHARS = 60_000;

export const JobSupportActionRequestSchema = z.object({
  job_version_id: UuidSchema,
  issue_class: JobSupportIssueClassSchema,
  action: JobSupportActionSchema,
  description: z.string().trim()
    .min(SUPPORT_PASTED_DESCRIPTION_MIN_CHARS)
    .max(SUPPORT_PASTED_DESCRIPTION_MAX_CHARS)
    .optional(),
  note: z.string().trim().min(1).max(500).optional(),
}).strict().superRefine((request, ctx) => {
  if (request.action === "PASTE_DESCRIPTION" && !request.description) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "PASTE_DESCRIPTION requires the full posting description.",
      path: ["description"],
    });
  }
  if (request.action !== "PASTE_DESCRIPTION" && request.description !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Only PASTE_DESCRIPTION accepts a description.",
      path: ["description"],
    });
  }
});
export type JobSupportActionRequest = z.infer<typeof JobSupportActionRequestSchema>;

export const JobSupportActionResultSchema = z.object({
  schema_version: z.literal(JOB_SUPPORT_ACTION_SCHEMA_VERSION),
  ok: z.literal(true),
  canonical_job_id: UuidSchema,
  action: JobSupportActionSchema,
  outcome: z.enum(["APPLIED", "NO_CHANGE"]),
  audit_id: UuidSchema,
  message: z.string().min(1),
  task_ids: z.array(UuidSchema),
  observation_id: UuidSchema.nullable(),
});
export type JobSupportActionResult = z.infer<typeof JobSupportActionResultSchema>;

export const JobSupportIssuesResponseSchema = z.object({
  schema_version: z.literal(JOB_STATUS_SCHEMA_VERSION),
  ok: z.literal(true),
  issues: z.array(JobSupportIssueRowSchema),
});
export type JobSupportIssuesResponse = z.infer<typeof JobSupportIssuesResponseSchema>;

export const JobSupportRetryAllResultSchema = z.object({
  schema_version: z.literal(JOB_SUPPORT_ACTION_SCHEMA_VERSION),
  ok: z.literal(true),
  considered: CountSchema,
  retried: CountSchema,
  unchanged: CountSchema,
  results: z.array(JobSupportActionResultSchema),
});
export type JobSupportRetryAllResult = z.infer<typeof JobSupportRetryAllResultSchema>;
