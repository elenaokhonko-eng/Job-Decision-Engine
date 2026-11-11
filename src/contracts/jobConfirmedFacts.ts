import { z } from "zod";

/**
 * Employer-confirmed job facts (migration 110, `job_confirmed_facts`).
 *
 * The user records what the employer told them about one exact job version. A confirmed fact fills a
 * workability fact the posting leaves unknown; it never replaces a fact the posting states.
 */
export const JOB_CONFIRMED_FACT_SCHEMA_VERSION = "job_confirmed_fact_v1" as const;
export const JOB_VERIFICATION_CHECKS_SCHEMA_VERSION = "job_verification_checks_v1" as const;

export const ConfirmedFactTypeSchema = z.enum([
  "WORK_MODE",
  "OFFICE_DAYS",
  "TRAVEL_PCT",
  "ON_CALL",
  "EMPLOYMENT_TYPE",
  "LOCATION",
]);
export type ConfirmedFactType = z.infer<typeof ConfirmedFactTypeSchema>;

export const ConfirmedFactSourceTypeSchema = z.enum([
  "RECRUITER_EMAIL",
  "RECRUITER_CALL",
  "EMPLOYER_CAREERS_PAGE",
  "HIRING_MANAGER",
  "OTHER",
]);
export type ConfirmedFactSourceType = z.infer<typeof ConfirmedFactSourceTypeSchema>;

export const CONFIRMED_FACT_SOURCE_LABELS: Readonly<Record<ConfirmedFactSourceType, string>> = {
  RECRUITER_EMAIL: "recruiter email",
  RECRUITER_CALL: "recruiter call",
  EMPLOYER_CAREERS_PAGE: "employer careers page",
  HIRING_MANAGER: "hiring manager",
  OTHER: "other",
};

// Control characters (other than ordinary spaces) are rejected in free text.
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export const WorkModeFactValueSchema = z.object({
  work_mode: z.enum(["ONSITE", "HYBRID", "REMOTE"]),
}).strict();

export const OfficeDaysFactValueSchema = z.object({
  office_days_min: z.number().int().min(0).max(7),
  office_days_max: z.number().int().min(0).max(7),
}).strict().refine((value) => value.office_days_min <= value.office_days_max, {
  message: "office_days_min must not exceed office_days_max.",
  path: ["office_days_min"],
});

export const TravelPctFactValueSchema = z.object({
  travel_pct_max: z.number().min(0).max(100),
}).strict();

export const OnCallFactValueSchema = z.object({
  on_call_required: z.boolean(),
}).strict();

export const EmploymentTypeFactValueSchema = z.object({
  employment_type: z.enum(["PERMANENT", "CONTRACT"]),
}).strict();

/** The request carries the location text; the server derives the normalized territories. */
export const LocationFactRequestValueSchema = z.object({
  location: z.string().trim().min(1).max(200)
    .refine((value) => !CONTROL_CHARACTERS.test(value), "location must not contain control characters."),
}).strict();

export const LocationFactValueSchema = LocationFactRequestValueSchema.extend({
  territories: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/)).max(20),
}).strict();

/**
 * A source URL is an absolute http(s) URL without credentials. It is shown to the user as a link, so
 * anything else (javascript:, data:, user:password@host) is rejected here.
 */
export function isSafeSourceUrl(value: string): boolean {
  if (value.length > 2048 || /\s/.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === "https:" || url.protocol === "http:")
    && url.hostname.length > 0
    && url.username === ""
    && url.password === "";
}

const SourceNoteSchema = z.string().trim().max(500)
  .refine((value) => !CONTROL_CHARACTERS.test(value), "source_note must not contain control characters.")
  .transform((value) => (value === "" ? null : value));

const SourceUrlSchema = z.string().trim()
  .transform((value) => (value === "" ? null : value))
  .refine((value) => value === null || isSafeSourceUrl(value), "source_url must be an http(s) URL without credentials.");

const requestBase = {
  job_version_id: z.string().uuid(),
  source_type: ConfirmedFactSourceTypeSchema,
  source_note: SourceNoteSchema.nullish().transform((value) => value ?? null),
  source_url: SourceUrlSchema.nullish().transform((value) => value ?? null),
};

export const JobConfirmedFactRequestSchema = z.discriminatedUnion("fact_type", [
  z.object({ ...requestBase, fact_type: z.literal("WORK_MODE"), value: WorkModeFactValueSchema }).strict(),
  z.object({ ...requestBase, fact_type: z.literal("OFFICE_DAYS"), value: OfficeDaysFactValueSchema }).strict(),
  z.object({ ...requestBase, fact_type: z.literal("TRAVEL_PCT"), value: TravelPctFactValueSchema }).strict(),
  z.object({ ...requestBase, fact_type: z.literal("ON_CALL"), value: OnCallFactValueSchema }).strict(),
  z.object({ ...requestBase, fact_type: z.literal("EMPLOYMENT_TYPE"), value: EmploymentTypeFactValueSchema }).strict(),
  z.object({ ...requestBase, fact_type: z.literal("LOCATION"), value: LocationFactRequestValueSchema }).strict(),
]);
export type JobConfirmedFactRequest = z.infer<typeof JobConfirmedFactRequestSchema>;

/** Stored fact values, by fact type, as the gate and readiness read them. */
export const ConfirmedFactValueSchemas = {
  WORK_MODE: WorkModeFactValueSchema,
  OFFICE_DAYS: OfficeDaysFactValueSchema,
  TRAVEL_PCT: TravelPctFactValueSchema,
  ON_CALL: OnCallFactValueSchema,
  EMPLOYMENT_TYPE: EmploymentTypeFactValueSchema,
  LOCATION: LocationFactValueSchema,
} as const;

const TimestampSchema = z.string().datetime({ offset: true });

export const ConfirmedJobFactSchema = z.object({
  confirmed_fact_id: z.string().uuid(),
  fact_type: ConfirmedFactTypeSchema,
  fact_value: z.record(z.string(), z.unknown()),
  source_type: ConfirmedFactSourceTypeSchema,
  source_note: z.string().nullable(),
  source_url: z.string().nullable(),
  supersedes_fact_id: z.string().uuid().nullable(),
  recorded_by_user_id: z.string().uuid(),
  recorded_at: TimestampSchema,
}).strict();
export type ConfirmedJobFact = z.infer<typeof ConfirmedJobFactSchema>;

export const JobVerificationChecksSchema = z.object({
  schema_version: z.literal(JOB_VERIFICATION_CHECKS_SCHEMA_VERSION),
  workspace_id: z.string().uuid(),
  canonical_job_id: z.string().uuid(),
  job_version_id: z.string().uuid(),
  gate_decision: z.enum(["PASS", "NEEDS_VERIFICATION", "HARD_REJECT"]).nullable(),
  gate_rejection_codes: z.array(z.string()),
  gate_evidence_quotes: z.array(z.string()),
  gate_workability_facts: z.record(z.string(), z.unknown()).nullable(),
  gate_decided_at: TimestampSchema.nullable(),
  open_checks: z.array(ConfirmedFactTypeSchema),
  confirmed_facts: z.array(ConfirmedJobFactSchema),
  confirmed_fact_history_count: z.number().int().min(0),
  rerun_pending: z.boolean(),
}).strict();
export type JobVerificationChecks = z.infer<typeof JobVerificationChecksSchema>;

export const JobConfirmedFactResponseSchema = z.object({
  ok: z.literal(true),
  schema_version: z.literal(JOB_CONFIRMED_FACT_SCHEMA_VERSION),
  fact: ConfirmedJobFactSchema,
  superseded_fact_id: z.string().uuid().nullable(),
  rerun: z.object({
    task_type: z.literal("APPLY_HARD_GATES"),
    task_id: z.string().uuid(),
    task_key: z.string().min(1),
    inserted: z.boolean(),
  }).strict(),
}).strict();
export type JobConfirmedFactResponse = z.infer<typeof JobConfirmedFactResponseSchema>;

export const JobConfirmedFactsListResponseSchema = z.object({
  ok: z.literal(true),
  checks: JobVerificationChecksSchema.nullable(),
  history: z.array(ConfirmedJobFactSchema),
}).strict();
export type JobConfirmedFactsListResponse = z.infer<typeof JobConfirmedFactsListResponseSchema>;
