import pg from "pg";
import { sourceContentEvidencePredicate } from "../pipeline/descriptionQuality.js";

import {
  isCurrentReadyApplicationReadiness,
  loadCurrentApplicationReadiness,
} from "../services/currentApplicationReadiness.js";
import type { WorkspaceContext } from "../workspace/context.js";

export interface ApplicationDocumentPreflightInput {
  readonly applicationRecordId: string;
  readonly canonicalJobId: string;
  readonly jobVersionId: string;
}

export interface ApplicationDocumentPreflightResult {
  readonly applicationRecordId: string;
  readonly applicationStatus: "INTENT";
  readonly canonicalJobId: string;
  readonly jobVersionId: string;
  readonly readinessStatus: "READY";
  readonly readinessReasonCodes: readonly string[];
}

export async function preflightApplicationDocumentDraft(
  client: pg.PoolClient,
  context: WorkspaceContext,
  input: ApplicationDocumentPreflightInput,
): Promise<ApplicationDocumentPreflightResult> {
  const { rows } = await client.query<{
    readonly id: string;
    readonly status: string;
    readonly latest_job_version_id: string | null;
    readonly gate_status: string | null;
    readonly recommendation_eligibility: string | null;
    readonly recommendation_outcome: string | null;
    readonly description_quality_status: string | null;
    readonly has_source_content_evidence: boolean;
  }>(
    `SELECT application.id::text AS id,
            application.status,
            canonical.latest_job_version_id::text AS latest_job_version_id,
            shortlist.gate_status,
            shortlist.recommendation_eligibility,
            shortlist.recommendation_outcome,
            canonical.description_quality_status,
            ${sourceContentEvidencePredicate("canonical.workspace_id", "application.job_version_id")} AS has_source_content_evidence
     FROM application_records application
     JOIN canonical_jobs canonical
       ON canonical.workspace_id = application.workspace_id
      AND canonical.id = application.canonical_job_id
     LEFT JOIN v_canonical_shortlist_scoped shortlist
       ON shortlist.workspace_id = canonical.workspace_id
      AND shortlist.canonical_job_id = canonical.id
      AND shortlist.job_version_id = application.job_version_id
     WHERE application.workspace_id = $1
       AND application.user_id = $2
       AND application.id = $3::UUID
       AND application.canonical_job_id = $4::UUID
       AND application.job_version_id = $5::UUID
     LIMIT 1`,
    [context.workspaceId, context.userId, input.applicationRecordId, input.canonicalJobId, input.jobVersionId],
  );
  const application = rows[0];
  if (!application) throw new Error("The application record does not match this user, job, and version.");
  if (application.status !== "INTENT") {
    throw new Error(`Document generation requires an INTENT draft; received ${application.status}.`);
  }
  if (application.latest_job_version_id !== input.jobVersionId) {
    throw new Error("The application draft does not reference the current job version.");
  }
  if (application.description_quality_status !== "COMPLETE" || !application.has_source_content_evidence) {
    throw new Error("Document generation requires complete description quality and verified posting-source evidence.");
  }
  if (application.gate_status !== "PASS" ||
      application.recommendation_eligibility !== "ELIGIBLE" ||
      !["PRIORITY", "REVIEW"].includes(application.recommendation_outcome ?? "")) {
    throw new Error("The current deterministic decision does not permit application documents.");
  }

  const readiness = await loadCurrentApplicationReadiness(
    client,
    context.workspaceId,
    input.canonicalJobId,
    input.jobVersionId,
  );
  if (!readiness || !isCurrentReadyApplicationReadiness(readiness)) {
    throw new Error(`The selected job lacks current READY application evidence: ${readiness?.readiness_reason_codes?.[0] ?? "READINESS_NOT_READY"}.`);
  }

  return {
    applicationRecordId: input.applicationRecordId,
    applicationStatus: "INTENT",
    canonicalJobId: input.canonicalJobId,
    jobVersionId: input.jobVersionId,
    readinessStatus: "READY",
    readinessReasonCodes: readiness.readiness_reason_codes ?? [],
  };
}
