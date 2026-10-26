import { z } from "zod";

export const APPLICATION_READINESS_SCHEMA_VERSION = "application_readiness_v1" as const;

export const ApplicationReadinessStatusSchema = z.enum(["READY", "BLOCKED", "NEEDS_VERIFICATION", "PROCESSING"]);
export type ApplicationReadinessStatus = z.infer<typeof ApplicationReadinessStatusSchema>;

export const MaterialReadinessCheckStatusSchema = z.enum([
  "MET",
  "BLOCKED",
  "NEEDS_VERIFICATION",
  "PROCESSING",
  "NOT_APPLICABLE",
]);
export type MaterialReadinessCheckStatus = z.infer<typeof MaterialReadinessCheckStatusSchema>;

export const MaterialReadinessCheckSchema = z.object({
  key: z.enum([
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
    "EVIDENCE_CONTEXT",
  ]),
  status: MaterialReadinessCheckStatusSchema,
  importance: z.enum(["MUST", "PREFERRED", "NICE_TO_HAVE"]),
  reason_code: z.string().regex(/^[A-Z][A-Z0-9_]{2,127}$/).nullable(),
  rationale: z.string().min(1).max(2000),
  evidence_keys: z.array(z.string().min(1)).default([]),
  policy_reference: z.string().min(1).nullable().default(null),
  assessed_at: z.string().datetime(),
  expires_at: z.string().datetime().nullable().default(null),
}).superRefine((check, context) => {
  if (check.status === "NOT_APPLICABLE" && !check.policy_reference) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["policy_reference"],
      message: "A not-applicable material check must cite the policy that makes it not applicable.",
    });
  }
});
export type MaterialReadinessCheck = z.infer<typeof MaterialReadinessCheckSchema>;

export const ApplicationReadinessSchema = z.object({
  schema_version: z.literal(APPLICATION_READINESS_SCHEMA_VERSION),
  status: ApplicationReadinessStatusSchema,
  reason_codes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{2,127}$/)).default([]),
  checks: z.array(MaterialReadinessCheckSchema).min(1),
  canonical_job_id: z.string().uuid(),
  job_version_id: z.string().uuid(),
  profile_version_id: z.string().uuid().nullable(),
  requirement_set_id: z.string().uuid().nullable(),
  match_run_id: z.string().uuid().nullable(),
  preference_context_id: z.string().uuid().nullable(),
  policy_snapshot_id: z.string().uuid().nullable(),
  policy_version: z.string().min(1),
  qualification_comparator_version: z.string().min(1),
  evidence_revision_hash: z.string().regex(/^[a-f0-9]{64}$/),
  readiness_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  evaluated_at: z.string().datetime(),
  expires_at: z.string().datetime().nullable(),
}).superRefine((readiness, context) => {
  const mandatoryChecks = readiness.checks.filter((check) => check.importance === "MUST");
  const hasBlocker = mandatoryChecks.some((check) => check.status === "BLOCKED");
  const hasUnknown = mandatoryChecks.some((check) => check.status === "NEEDS_VERIFICATION");
  const hasProcessing = mandatoryChecks.some((check) => check.status === "PROCESSING");

  if (readiness.status === "BLOCKED" && !hasBlocker) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "BLOCKED readiness requires at least one mandatory blocking check.",
    });
  }
  if (readiness.status === "NEEDS_VERIFICATION" && (hasBlocker || hasProcessing || !hasUnknown)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "NEEDS_VERIFICATION requires a mandatory unknown and no blocker or processing dependency.",
    });
  }
  if (readiness.status === "PROCESSING" && (hasBlocker || !hasProcessing)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "PROCESSING requires an active mandatory artifact dependency and no blocker.",
    });
  }
  if (readiness.status === "READY" && (hasBlocker || hasUnknown || hasProcessing)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "READY cannot include a blocker, unresolved mandatory check, or processing dependency.",
    });
  }
  const expectedReasons = mandatoryChecks
    .filter((check) => check.status === "BLOCKED" || check.status === "NEEDS_VERIFICATION" || check.status === "PROCESSING")
    .map((check) => check.reason_code)
    .filter((reason): reason is string => reason !== null);
  for (const reason of expectedReasons) {
    if (!readiness.reason_codes.includes(reason)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason_codes"],
        message: `Readiness reason ${reason} is missing from the top-level reason list.`,
      });
    }
  }
});
export type ApplicationReadiness = z.infer<typeof ApplicationReadinessSchema>;
