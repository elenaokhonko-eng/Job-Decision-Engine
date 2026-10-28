import crypto from "node:crypto";
import express from "express";
import pg from "pg";
import { z, ZodError } from "zod";
import type { WorkspaceContext } from "../../workspace/context.js";
import { runNormalization } from "../../pipeline/normalize.js";
import { runRequirementsExtraction } from "../../pipeline/requirementsExtractor.js";
import { loadProfileContactSnapshot, type DocumentContactInfo } from "../../documents/contactInfo.js";
import {
  buildControlledDocuments,
  buildManualComparison,
  fingerprintManualComparison,
  MANUAL_COMPARATOR_VERSION,
  renderControlledDocx,
  renderControlledPdf,
  sha256Buffer,
  validateManualApprovalCurrentness,
  validateManualArtifactPair,
  type ManualComparisonInput,
  type ManualApprovalIdentity,
  type ManualEvidence,
  type ManualRequirement,
} from "../../documents/manualPreparation.js";
import {
  ManualApiErrorSchema,
  ManualCandidateProfilesResponseSchema,
  ManualApprovalIdentitySchema,
  ManualApprovalRequestSchema,
  ManualApprovalResponseSchema,
  ManualCompareResponseSchema,
  ManualComparisonSchema,
  ManualDocumentsResponseSchema,
  ManualDownloadResponseSchema,
  ManualGenerateRequestSchema,
  ManualFetchDescriptionRequestSchema,
  ManualFetchDescriptionResponseSchema,
  ManualFetchSourceEvidenceSchema,
  ManualPostingInputSchema,
  ManualPersistedFetchReceiptSchema,
  ManualPersistedApprovalSchema,
  ManualPersistedDraftSchema,
  ManualStagedPostingIdentitySchema,
  MANUAL_APPLICATION_SCHEMA_VERSION,
} from "../../contracts/manualApplication.js";
import { fetchJobContent, type JobContentResult } from "../../ingestion/jobContentFetcher.js";

function errorPayload(code: "INVALID_REQUEST" | "DESCRIPTION_INSUFFICIENT" | "FORBIDDEN" | "NOT_FOUND" | "JOB_VERSION_CHANGED" | "IDENTITY_CONFLICT" | "APPROVAL_STALE" | "DEPENDENCY_UNAVAILABLE" | "INTERNAL_ERROR", message: string, retryAfter?: string) {
  return ManualApiErrorSchema.parse({
    schema_version: MANUAL_APPLICATION_SCHEMA_VERSION,
    ok: false,
    code,
    error: code,
    message,
    ...(retryAfter ? { retry_after: retryAfter } : {}),
  });
}

function sendApiError(res: express.Response, status: number, code: Parameters<typeof errorPayload>[0], message: string, retryAfter?: string): void {
  if (retryAfter) {
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) res.setHeader("Retry-After", String(Math.max(0, Math.ceil((retryAt - Date.now()) / 1000))));
  }
  res.status(status).json(errorPayload(code, message, retryAfter));
}

class ManualFlowError extends Error {
  constructor(readonly status: number, readonly code: Parameters<typeof errorPayload>[0], message: string) {
    super(message);
  }
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeIdentity(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function normalizePostingUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

interface SelectedPostingIdentity {
  candidateProfileId: string;
  canonicalJobId: string;
  jobVersionId: string;
  sourceObservationId: string;
  contentHash: string;
}

interface CurrentManualInputs {
  input: ManualComparisonInput;
  contact: DocumentContactInfo;
  contactFactIds: string[];
  contactFingerprint: string;
  preferenceContextFingerprint: string;
}

function profileFactIdsFingerprint(ids: readonly string[]): string {
  return sha256(stableStringify([...ids].sort()));
}

function approvalIdentityFromDraft(draft: ReturnType<typeof ManualPersistedDraftSchema.parse>): ManualApprovalIdentity {
  return {
    canonicalJobId: draft.canonical_job_id,
    jobVersionId: draft.job_version_id,
    sourceObservationId: draft.source_observation_id,
    jobContentHash: draft.job_content_hash,
    profileVersionId: draft.profile_version_id,
    candidateProfileId: draft.candidate_profile_id,
    profileContactFactIdsFingerprint: profileFactIdsFingerprint(draft.profile_contact_fact_ids),
    profileContactFingerprint: draft.profile_contact_fingerprint,
    preferenceContextFingerprint: draft.preference_context_fingerprint,
    requirementSetId: draft.requirement_set_id,
    comparatorVersion: draft.comparator_version,
    comparisonFingerprint: draft.comparison_fingerprint,
  };
}

function approvalIdentityFromCurrent(
  current: CurrentManualInputs,
  comparisonFingerprint: string,
): ManualApprovalIdentity {
  return {
    canonicalJobId: current.input.canonical_job_id,
    jobVersionId: current.input.job_version_id,
    sourceObservationId: current.input.source_observation_id,
    jobContentHash: current.input.job_content_hash,
    profileVersionId: current.input.profile_version_id,
    candidateProfileId: current.input.candidate_profile_id,
    profileContactFactIdsFingerprint: profileFactIdsFingerprint(current.contactFactIds),
    profileContactFingerprint: current.contactFingerprint,
    preferenceContextFingerprint: current.preferenceContextFingerprint,
    requirementSetId: current.input.requirement_set_id,
    comparatorVersion: MANUAL_COMPARATOR_VERSION,
    comparisonFingerprint,
  };
}

function approvalIdentityFromPersisted(approval: ReturnType<typeof ManualPersistedApprovalSchema.parse>): ManualApprovalIdentity {
  return {
    canonicalJobId: approval.canonical_job_id,
    jobVersionId: approval.job_version_id,
    sourceObservationId: approval.source_observation_id,
    jobContentHash: approval.job_content_hash,
    profileVersionId: approval.profile_version_id,
    candidateProfileId: approval.candidate_profile_id,
    profileContactFactIdsFingerprint: profileFactIdsFingerprint(approval.profile_contact_fact_ids),
    profileContactFingerprint: approval.profile_contact_fingerprint,
    preferenceContextFingerprint: approval.preference_context_fingerprint,
    requirementSetId: approval.requirement_set_id,
    comparatorVersion: approval.comparator_version,
    comparisonFingerprint: approval.comparison_fingerprint,
  };
}

function selectedPostingFromApproval(approval: ReturnType<typeof ManualPersistedApprovalSchema.parse>): SelectedPostingIdentity {
  return {
    candidateProfileId: approval.candidate_profile_id,
    canonicalJobId: approval.canonical_job_id,
    jobVersionId: approval.job_version_id,
    sourceObservationId: approval.source_observation_id,
    contentHash: approval.job_content_hash,
  };
}

async function loadPersistedApproval(
  client: pg.Pool | pg.PoolClient,
  ctx: WorkspaceContext,
  draftId: string,
  approvalId: string,
  lock = false,
): Promise<{ approval: ReturnType<typeof ManualPersistedApprovalSchema.parse>; comparison: ReturnType<typeof ManualComparisonSchema.parse> } | null> {
  const result = await client.query(
    `SELECT approval.id,approval.workspace_id,approval.user_id,approval.draft_id,approval.candidate_profile_id,
            approval.canonical_job_id,approval.job_version_id,approval.source_observation_id,approval.job_content_hash,
            approval.profile_version_id,approval.profile_contact_fact_ids,approval.profile_contact_fingerprint,
            approval.preference_context_fingerprint,approval.requirement_set_id,approval.comparator_version,
            approval.context_fingerprint,approval.comparison_fingerprint,approval.approved,draft.comparison_payload
     FROM manual_application_preparation_approvals approval
     JOIN manual_application_drafts draft ON draft.id=approval.draft_id AND draft.workspace_id=approval.workspace_id
       AND draft.user_id=approval.user_id AND draft.comparison_fingerprint=approval.comparison_fingerprint
     WHERE approval.workspace_id=$1 AND approval.user_id=$2 AND approval.id=$3 AND approval.draft_id=$4
       AND approval.approved IS TRUE${lock ? " FOR UPDATE OF approval" : ""}`,
    [ctx.workspaceId, ctx.userId, approvalId, draftId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const approval = ManualPersistedApprovalSchema.parse({
    id: row.id,
    workspace_id: row.workspace_id,
    user_id: row.user_id,
    draft_id: row.draft_id,
    candidate_profile_id: row.candidate_profile_id,
    canonical_job_id: row.canonical_job_id,
    job_version_id: row.job_version_id,
    source_observation_id: row.source_observation_id,
    job_content_hash: row.job_content_hash,
    profile_version_id: row.profile_version_id,
    profile_contact_fact_ids: row.profile_contact_fact_ids,
    profile_contact_fingerprint: row.profile_contact_fingerprint,
    preference_context_fingerprint: row.preference_context_fingerprint,
    requirement_set_id: row.requirement_set_id,
    comparator_version: row.comparator_version,
    context_fingerprint: row.context_fingerprint,
    comparison_fingerprint: row.comparison_fingerprint,
    approved: row.approved,
  });
  const comparison = ManualComparisonSchema.parse(row.comparison_payload);
  if (fingerprintManualComparison(comparison) !== approval.comparison_fingerprint ||
      comparison.canonical_job_id !== approval.canonical_job_id ||
      comparison.job_version_id !== approval.job_version_id ||
      comparison.source_observation_id !== approval.source_observation_id ||
      comparison.job_content_hash !== approval.job_content_hash ||
      comparison.profile_version_id !== approval.profile_version_id ||
      comparison.candidate_profile_id !== approval.candidate_profile_id ||
      comparison.requirement_set_id !== approval.requirement_set_id ||
      comparison.context_fingerprint !== approval.context_fingerprint ||
      comparison.profile_contact_fingerprint !== approval.profile_contact_fingerprint ||
      comparison.preference_context_fingerprint !== approval.preference_context_fingerprint ||
      comparison.comparator_version !== approval.comparator_version ||
      profileFactIdsFingerprint(comparison.profile_contact_fact_ids) !== profileFactIdsFingerprint(approval.profile_contact_fact_ids)) {
    throw new ManualFlowError(500, "INTERNAL_ERROR", "Persisted approval or comparison failed exact-context integrity validation.");
  }
  const linkedContactFacts = await client.query<{ profile_contact_fact_id: string }>(
    `SELECT profile_contact_fact_id FROM manual_application_approval_contact_facts
     WHERE workspace_id=$1 AND user_id=$2 AND approval_id=$3 AND draft_id=$4 AND profile_version_id=$5
     ORDER BY profile_contact_fact_id`,
    [ctx.workspaceId, ctx.userId, approval.id, approval.draft_id, approval.profile_version_id],
  );
  if (stableStringify(linkedContactFacts.rows.map((row) => row.profile_contact_fact_id).sort()) !==
      stableStringify([...approval.profile_contact_fact_ids].sort())) {
    throw new ManualFlowError(500, "INTERNAL_ERROR", "Persisted approval contact facts do not match the private profile contact snapshot.");
  }
  return { approval, comparison };
}

function assertCurrentApproval(
  approval: ReturnType<typeof ManualPersistedApprovalSchema.parse>,
  comparison: ReturnType<typeof ManualComparisonSchema.parse>,
  current: CurrentManualInputs,
): string {
  const currentComparison = ManualComparisonSchema.parse(buildManualComparison(current.input));
  const currentFingerprint = fingerprintManualComparison(currentComparison);
  const currentness = validateManualApprovalCurrentness(
    ManualApprovalIdentitySchema.parse(approvalIdentityFromPersisted(approval)),
    ManualApprovalIdentitySchema.parse(approvalIdentityFromCurrent(current, currentFingerprint)),
  );
  if (!currentness.ok) {
    throw new ManualFlowError(409, "APPROVAL_STALE", `Manual approval is stale (${currentness.reason}); compare and approve the current inputs again.`);
  }
  if (fingerprintManualComparison(comparison) !== currentFingerprint) {
    throw new ManualFlowError(409, "APPROVAL_STALE", "The comparison payload no longer matches current profile, contact, preferences, job or requirements.");
  }
  return currentFingerprint;
}

interface JobRow {
  canonical_job_id: string;
  job_version_id: string;
  source_observation_id: string;
  source_observation_payload_hash: string;
  title: string;
  company: string;
  canonical_url: string | null;
  content_hash: string;
  active_requirement_set_id: string | null;
  gate_status: string | null;
  rejection_codes: string[] | null;
  processing_state: string | null;
  recommendation_outcome: string | null;
  recommendation_eligibility: string | null;
  readiness_status: string | null;
  readiness_reason_codes: string[] | null;
}

interface ProfileRow {
  profile_version_id: string;
  candidate_profile_id: string;
  candidate_name: string;
}

async function loadCurrentInputs(
  client: pg.Pool | pg.PoolClient,
  ctx: WorkspaceContext,
  selected: SelectedPostingIdentity,
): Promise<CurrentManualInputs | null> {
  const jobResult = await client.query<JobRow>(
    `SELECT job.id AS canonical_job_id, version.id AS job_version_id,
            observation.id AS source_observation_id, observation.raw_payload_hash AS source_observation_payload_hash, observation.title,
            observation.company_name AS company, job.canonical_url, version.content_hash,
            version.active_requirement_set_id, gate.decision AS gate_status, gate.rejection_codes,
            job.processing_state, shortlist.recommendation_outcome, shortlist.recommendation_eligibility,
            shortlist.readiness_status, shortlist.readiness_reason_codes
     FROM canonical_jobs job
     JOIN job_versions version ON version.workspace_id = job.workspace_id
       AND version.canonical_job_id = job.id AND version.id = $3 AND version.content_hash = $5
       AND version.id = COALESCE(job.latest_job_version_id, (
         SELECT candidate.id FROM job_versions candidate
         WHERE candidate.workspace_id = job.workspace_id AND candidate.canonical_job_id = job.id
         ORDER BY candidate.observed_at DESC, candidate.id DESC LIMIT 1
       ))
     JOIN raw_job_observations observation ON observation.workspace_id = job.workspace_id
       AND observation.id = $4 AND observation.job_version_id = version.id
     LEFT JOIN v_canonical_shortlist_scoped shortlist
       ON shortlist.workspace_id = job.workspace_id AND shortlist.canonical_job_id = job.id AND shortlist.job_version_id = version.id
     LEFT JOIN LATERAL (
       SELECT decision.decision, decision.rejection_codes
       FROM gate_decisions decision
       WHERE decision.workspace_id = job.workspace_id AND decision.canonical_job_id = job.id
         AND decision.job_version_id = version.id
       ORDER BY decision.created_at DESC, decision.id DESC LIMIT 1
     ) gate ON TRUE
     WHERE job.workspace_id = $1 AND job.id = $2
     LIMIT 1`,
    [ctx.workspaceId, selected.canonicalJobId, selected.jobVersionId, selected.sourceObservationId, selected.contentHash],
  );
  if (!jobResult.rows[0]) return null;
  const job = jobResult.rows[0];
  if (!job.active_requirement_set_id) {
    throw new Error("Deterministic requirement extraction did not produce an active requirement set for this exact job version.");
  }

  const profileResult = await client.query<ProfileRow>(
    `SELECT profile.id AS profile_version_id, profile.candidate_profile_id,
            candidate.display_name AS candidate_name
     FROM profile_versions profile
     JOIN candidate_profiles candidate ON candidate.workspace_id = profile.workspace_id
       AND candidate.id = profile.candidate_profile_id
     WHERE profile.workspace_id = $1 AND profile.candidate_profile_id = $2 AND profile.status = 'ACTIVE'
     ORDER BY profile.created_at DESC, profile.id DESC LIMIT 1`,
    [ctx.workspaceId, selected.candidateProfileId],
  );
  const profile = profileResult.rows[0];
  if (!profile) throw new ManualFlowError(409, "APPROVAL_STALE", "The selected candidate has no active profile version in this workspace. Select an active candidate and compare again.");

  const [requirementResult, factResult, credentialResult, engagementResult, preferenceResult, contactSnapshot] = await Promise.all([
    client.query<ManualRequirement>(
      `SELECT requirement_key, requirement_type, importance, requirement_text
       FROM job_requirements WHERE workspace_id = $1 AND canonical_job_id = $2 AND job_version_id = $3
         AND requirement_set_id = $4 AND status <> 'REJECTED' ORDER BY requirement_key`,
      [ctx.workspaceId, selected.canonicalJobId, selected.jobVersionId, job.active_requirement_set_id]),
    client.query<{ id: string; fact_key: string; statement: string }>(
      `SELECT id::text, fact_key, statement FROM profile_facts
       WHERE workspace_id = $1 AND profile_version_id = $2 AND fact_type <> 'CONTACT'
         AND is_current = TRUE AND verification_status IN ('VERIFIED','SELF_ATTESTED')
         AND confidentiality IN ('PUBLIC','PRIVATE_REUSABLE') ORDER BY fact_key, id`,
      [ctx.workspaceId, profile.profile_version_id]),
    client.query<{ id: string; credential_name: string; issuer: string; credential_type: string; level: string | null; status: string }>(
      `SELECT id::text, credential_name, issuer, credential_type, level, status
       FROM profile_credentials WHERE workspace_id = $1 AND profile_version_id = $2
         AND status = 'ACTIVE' AND verification_status IN ('VERIFIED','SELF_ATTESTED') ORDER BY credential_key, id`,
      [ctx.workspaceId, profile.profile_version_id]),
    client.query<{ id: string; organization_legal_name: string; role_title: string; start_date: string; end_date: string | null; is_current: boolean; summary: string }>(
      `SELECT id::text, organization_legal_name, role_title, start_date, end_date, is_current, summary
       FROM profile_engagements WHERE workspace_id = $1 AND profile_version_id = $2
         AND verification_status IN ('VERIFIED','SELF_ATTESTED') ORDER BY start_date DESC, engagement_key, id`,
      [ctx.workspaceId, profile.profile_version_id]),
    client.query<{ preference_domain: string; revision_id: string; preference_hash: string }>(
      `SELECT active.preference_domain, active.revision_id, revision.preference_hash
       FROM workspace_user_preference_active_versions active
       JOIN workspace_user_preference_revisions revision
         ON revision.workspace_id = active.workspace_id AND revision.user_id = active.user_id
        AND revision.preference_domain = active.preference_domain AND revision.id = active.revision_id
       WHERE active.workspace_id = $1 AND active.user_id = $2
       ORDER BY active.preference_domain`,
      [ctx.workspaceId, ctx.userId]),
    loadProfileContactSnapshot(client, ctx.workspaceId, profile.profile_version_id, profile.candidate_name),
  ]);
  const evidence: ManualEvidence[] = [
    ...factResult.rows.map((row) => ({ id: row.id, evidence_type: "FACT" as const, label: row.fact_key, statement: row.statement })),
    ...credentialResult.rows.map((row) => ({
      id: row.id, evidence_type: "CREDENTIAL" as const, label: row.credential_name,
      statement: `${row.credential_name}${row.level ? ` (${row.level})` : ""}, ${row.credential_type.toLowerCase()} issued by ${row.issuer}; status ${row.status}.`,
    })),
    ...engagementResult.rows.map((row) => ({
      id: row.id, evidence_type: "ENGAGEMENT" as const, label: `${row.role_title} at ${row.organization_legal_name}`,
      statement: `${row.role_title} at ${row.organization_legal_name} (${String(row.start_date).slice(0, 10)}${row.is_current ? "–present" : row.end_date ? `–${String(row.end_date).slice(0, 10)}` : ""}). ${row.summary}`,
    })),
  ];
  const warnings: string[] = [];
  if (job.gate_status) warnings.push(`Automatic suitability gate: ${job.gate_status}${job.rejection_codes?.length ? ` (${job.rejection_codes.join(", ")})` : ""}.`);
  if (job.recommendation_outcome || job.recommendation_eligibility) {
    warnings.push(`Automatic recommendation remains ${job.recommendation_outcome ?? "unknown"} / ${job.recommendation_eligibility ?? "unknown"}. Manual preparation does not change it.`);
  }
  if (job.readiness_status && job.readiness_status !== "READY") {
    warnings.push(`Automatic document readiness remains ${job.readiness_status}${job.readiness_reason_codes?.length ? ` (${job.readiness_reason_codes.join(", ")})` : ""}. Manual preparation does not change it.`);
  }
  if (!job.gate_status) warnings.push("Automatic suitability was not completed for this manual comparison; workability warnings remain unresolved until the normal pipeline evaluates them.");
  if (job.processing_state) warnings.push(`Current pipeline state: ${job.processing_state}.`);

  const preferenceContextFingerprint = sha256(stableStringify(preferenceResult.rows));
  const contactFactIds = [...contactSnapshot.factIds];
  const context = {
    canonical_job_id: job.canonical_job_id,
    job_version_id: job.job_version_id,
    source_observation_id: job.source_observation_id,
    source_evidence_fingerprint: sha256(stableStringify({ source_observation_payload_hash: job.source_observation_payload_hash })),
    job_content_hash: job.content_hash,
    profile_version_id: profile.profile_version_id,
    candidate_profile_id: profile.candidate_profile_id,
    requirement_set_id: job.active_requirement_set_id,
    requirements: requirementResult.rows,
    evidence,
    profile_contact_fact_ids: contactFactIds,
    profile_contact_fingerprint: contactSnapshot.fingerprint,
    preference_context_fingerprint: preferenceContextFingerprint,
    suitability_warnings: warnings,
    comparator_version: MANUAL_COMPARATOR_VERSION,
  };
  const input: ManualComparisonInput = {
    ...context,
    context_fingerprint: sha256(stableStringify(context)),
    title: job.title,
    company: job.company,
    canonical_url: job.canonical_url,
  };
  return {
    input,
    contact: contactSnapshot.contact,
    contactFactIds,
    contactFingerprint: contactSnapshot.fingerprint,
    preferenceContextFingerprint,
  };
}

async function hasWritableMembership(client: pg.Pool | pg.PoolClient, ctx: WorkspaceContext): Promise<boolean> {
  const { rows } = await client.query<{ role: string }>(
    `SELECT role FROM workspace_memberships
     WHERE workspace_id = $1 AND user_id = $2 AND status = 'ACTIVE' FOR SHARE`,
    [ctx.workspaceId, ctx.userId],
  );
  return rows[0]?.role === "OWNER" || rows[0]?.role === "MEMBER";
}
export interface ManualApplicationRouterDeps {
  pool: pg.Pool;
  resolveContext: (req: express.Request) => WorkspaceContext;
}

export function createManualApplicationRouter({ pool, resolveContext }: ManualApplicationRouterDeps): express.Router {
  const router = express.Router();
  const handler = (fn: (req: express.Request, res: express.Response) => Promise<void>): express.RequestHandler =>
    (req, res, next) => {
      void fn(req, res).catch((error: unknown) => {
        if (error instanceof ManualFlowError) {
          sendApiError(res, error.status, error.code, error.message);
          return;
        }
        if (error instanceof ZodError) {
          sendApiError(res, 500, "INTERNAL_ERROR", "Persisted manual application data failed runtime contract validation.");
          return;
        }
        next(error);
      });
    };

  router.get("/candidate-profiles", handler(async (req, res) => {
    const ctx = resolveContext(req);
    if (!(await hasWritableMembership(pool, ctx))) {
      sendApiError(res, 403, "FORBIDDEN", "An active owner or member role is required to prepare application documents.");
      return;
    }
    const { rows } = await pool.query<{ candidate_profile_id: string; display_name: string }>(
      `SELECT DISTINCT ON (candidate.id) candidate.id AS candidate_profile_id, candidate.display_name
       FROM candidate_profiles candidate
       JOIN profile_versions profile ON profile.workspace_id=candidate.workspace_id
         AND profile.candidate_profile_id=candidate.id AND profile.status='ACTIVE'
       WHERE candidate.workspace_id=$1
       ORDER BY candidate.id, profile.created_at DESC, profile.id DESC
       LIMIT 50`,
      [ctx.workspaceId],
    );
    res.json(ManualCandidateProfilesResponseSchema.parse({
      schema_version: MANUAL_APPLICATION_SCHEMA_VERSION,
      ok: true,
      profiles: rows,
    }));
  }));

  router.post("/fetch-description", handler(async (req, res) => {
    const ctx = resolveContext(req);
    if (!(await hasWritableMembership(pool, ctx))) {
      sendApiError(res, 403, "FORBIDDEN", "An active owner or member role is required to fetch a posting for manual preparation.");
      return;
    }
    const parsed = ManualFetchDescriptionRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendApiError(res, 400, "INVALID_REQUEST", "Provide a public posting URL and the expected title and company.");
      return;
    }
    let result: JobContentResult;
    try {
      result = await fetchJobContent(parsed.data.url, {
        title: parsed.data.title,
        companyName: parsed.data.company,
        requisitionId: parsed.data.requisition_id,
      });
    } catch (error) {
      sendApiError(res, 503, "DEPENDENCY_UNAVAILABLE", error instanceof Error ? error.message : "Posting retrieval failed.");
      return;
    }
    if (result.kind === "COMPLETE") {
      const sourceEvidence = ManualFetchSourceEvidenceSchema.parse(result.evidence);
      const client = await pool.connect();
      let receiptId: string;
      try {
        await client.query("BEGIN");
        if (!(await hasWritableMembership(client, ctx))) {
          throw new ManualFlowError(403, "FORBIDDEN", "Workspace membership no longer permits posting retrieval.");
        }
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO manual_application_fetch_receipts (
             workspace_id,user_id,requested_url,resolved_url,canonical_url,expected_title,expected_company,expected_requisition_id,
             description_hash,content_hash,provider,source_evidence
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) RETURNING id`,
          [ctx.workspaceId, ctx.userId, sourceEvidence.requestedUrl, sourceEvidence.resolvedUrl,
            result.posting.canonicalUrl, parsed.data.title, parsed.data.company, parsed.data.requisition_id ?? null,
            sha256(result.posting.description.trim()), result.contentHash, result.provider.key,
            JSON.stringify(sourceEvidence)],
        );
        receiptId = inserted.rows[0]?.id;
        if (!receiptId) throw new Error("Verified posting receipt was not durably persisted.");
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally { client.release(); }
      res.json(ManualFetchDescriptionResponseSchema.parse({
        schema_version: MANUAL_APPLICATION_SCHEMA_VERSION,
        ok: true,
        fetch_receipt_id: receiptId,
        description: result.posting.description,
        final_url: result.posting.canonicalUrl,
        provider: result.provider.key,
        content_hash: result.contentHash,
        source_evidence: sourceEvidence,
      }));
      return;
    }
    if (result.kind === "IDENTITY_CONFLICT") {
      sendApiError(res, 409, "IDENTITY_CONFLICT", result.reason);
      return;
    }
    if (result.kind === "BLOCKED") {
      sendApiError(res, 422, "INVALID_REQUEST", result.reason);
      return;
    }
    sendApiError(res, 503, "DEPENDENCY_UNAVAILABLE", result.reason,
      result.kind === "RETRYABLE_FAILURE" ? result.retryAfter : undefined);
  }));

  router.post("/compare", handler(async (req, res) => {
    const ctx = resolveContext(req);
    if (!(await hasWritableMembership(pool, ctx))) { sendApiError(res, 403, "FORBIDDEN", "An active owner or member role is required to stage a manual application."); return; }
    const parsed = ManualPostingInputSchema.safeParse(req.body);
    if (!parsed.success) { sendApiError(res, 400, "INVALID_REQUEST", "Confirm the posting URL, title and company, and provide at least 100 characters of description."); return; }
    const inputJob = parsed.data;
    let fetchReceipt: ReturnType<typeof ManualPersistedFetchReceiptSchema.parse> | null = null;
    let sourceContentStatus: "COMPLETE" | "USER_EDITED" | "USER_PROVIDED" = "USER_PROVIDED";
    if (inputJob.source_kind === "FETCHED") {
      const receiptResult = await pool.query(
        `SELECT id,workspace_id,user_id,requested_url,resolved_url,canonical_url,expected_title,expected_company,expected_requisition_id,
           description_hash,content_hash,provider,source_evidence,
           to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at
         FROM manual_application_fetch_receipts
         WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND expires_at > NOW()`,
        [inputJob.fetch_receipt_id, ctx.workspaceId, ctx.userId],
      );
      if (!receiptResult.rows[0]) {
        throw new ManualFlowError(409, "JOB_VERSION_CHANGED", "The verified posting receipt expired or is not available in this workspace. Fetch the posting again or use a pasted/uploaded description.");
      }
      fetchReceipt = ManualPersistedFetchReceiptSchema.parse(receiptResult.rows[0]);
      const permittedUrls = [fetchReceipt.requested_url, fetchReceipt.resolved_url, fetchReceipt.canonical_url]
        .map(normalizePostingUrl);
      if (!permittedUrls.includes(normalizePostingUrl(inputJob.url))
        || normalizeIdentity(inputJob.title) !== normalizeIdentity(fetchReceipt.expected_title)
        || normalizeIdentity(inputJob.company) !== normalizeIdentity(fetchReceipt.expected_company)
        || (inputJob.requisition_id ?? null) !== fetchReceipt.expected_requisition_id) {
        throw new ManualFlowError(409, "IDENTITY_CONFLICT", "The confirmed title, company, or URL differs from the verified fetch. Fetch the exact posting again or switch to a pasted description.");
      }
      sourceContentStatus = sha256(inputJob.description.trim()) === fetchReceipt.description_hash
        ? "COMPLETE"
        : "USER_EDITED";
    }
    const rawPayload = JSON.stringify({
      source: "MANUAL_STREAMLIT",
      source_provenance: sourceContentStatus === "COMPLETE" ? "VERIFIED_PUBLIC_FETCH"
        : sourceContentStatus === "USER_EDITED" ? "USER_EDITED_AFTER_FETCH" : "USER_PROVIDED",
      source_content_status: sourceContentStatus,
      ...(fetchReceipt ? {
        fetch_receipt_id: fetchReceipt.id,
        fetch_provider: fetchReceipt.provider,
        fetched_content_hash: fetchReceipt.content_hash,
        submitted_description_hash: sha256(inputJob.description.trim()),
        source_evidence: fetchReceipt.source_evidence,
      } : {}),
      ...inputJob,
    });
    const payloadHash = sha256(rawPayload);
    let observation = (await pool.query<{ id: string; job_version_id: string | null }>(
      `SELECT id, job_version_id FROM raw_job_observations WHERE workspace_id = $1 AND raw_payload_hash = $2 LIMIT 1`,
      [ctx.workspaceId, payloadHash])).rows[0];
    if (!observation) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        if (!(await hasWritableMembership(client, ctx))) throw new ManualFlowError(403, "FORBIDDEN", "Workspace membership no longer permits manual staging.");
        const run = await client.query<{ id: string }>(
          `INSERT INTO source_runs (workspace_id, status, total_fetched, total_new)
           VALUES ($1, 'COMPLETED', 1, 1) RETURNING id`, [ctx.workspaceId]);
        const inserted = await client.query<{ id: string; job_version_id: string | null }>(
          `INSERT INTO raw_job_observations (
             workspace_id, source_run_id, source_name, source_external_id, source_url, retrieved_at,
             company_name, title, description_raw, location_raw, workplace_type_raw, employment_type_raw,
             compensation_raw, canonical_apply_url, source_lane, search_plan_version, raw_payload, raw_payload_hash
           ) VALUES ($1,$2,'MANUAL_STREAMLIT',$3,$4,NOW(),$5,$6,$7,$8,'UNKNOWN','UNKNOWN','UNKNOWN',$4,'UNKNOWN','manual_application_v1',$9::jsonb,$10)
           ON CONFLICT (workspace_id, raw_payload_hash) DO NOTHING RETURNING id, job_version_id`,
          [ctx.workspaceId, run.rows[0].id, `manual-${payloadHash.slice(0, 16)}`, inputJob.url, inputJob.company,
            inputJob.title, inputJob.description, inputJob.location, rawPayload, payloadHash]);
        observation = inserted.rows[0] ?? (await client.query<{ id: string; job_version_id: string | null }>(
          `SELECT id, job_version_id FROM raw_job_observations WHERE workspace_id = $1 AND raw_payload_hash = $2 LIMIT 1`,
          [ctx.workspaceId, payloadHash])).rows[0];
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    }
    if (!observation) throw new Error("Manual observation could not be durably staged.");
    let jobVersionId = observation.job_version_id;
    let canonicalJobId: string | undefined;
    if (!jobVersionId) {
      const normalized = await runNormalization(pool, { context: ctx, observationIds: [observation.id], limit: 1 });
      const detail = normalized.details.find((item) => item.observationId === observation.id);
      if (!detail?.versionId || !detail.canonicalJobId) {
        throw new Error(`Normalization did not produce a job version; the raw observation remains staged for recovery. ${detail?.error ?? ""}`.trim());
      }
      canonicalJobId = detail.canonicalJobId;
      jobVersionId = detail.versionId;
    }
    if (!canonicalJobId) {
      const canonical = await pool.query<{ canonical_job_id: string }>(`SELECT canonical_job_id FROM job_versions WHERE workspace_id = $1 AND id = $2`, [ctx.workspaceId, jobVersionId]);
      canonicalJobId = canonical.rows[0]?.canonical_job_id;
    }
    if (!canonicalJobId) throw new Error("Normalized observation has no canonical job identity; its record remains staged.");
    const selectedVersion = await pool.query<{ canonical_job_id: string; job_version_id: string; content_hash: string }>(
      `SELECT canonical_job_id, id AS job_version_id, content_hash FROM job_versions
       WHERE workspace_id = $1 AND canonical_job_id = $2 AND id = $3`,
      [ctx.workspaceId, canonicalJobId, jobVersionId]);
    const versionRow = selectedVersion.rows[0];
    if (!versionRow) { sendApiError(res, 409, "JOB_VERSION_CHANGED", "The staged posting no longer resolves to its exact current job version. Stage it again."); return; }
    const accepted = ManualStagedPostingIdentitySchema.parse({
      schema_version: MANUAL_APPLICATION_SCHEMA_VERSION,
      canonicalJobId,
      jobVersionId,
      sourceObservationId: observation.id,
      contentHash: versionRow.content_hash,
    });
    const requirementSummary = await runRequirementsExtraction(pool, { context: ctx, jobVersionIds: [jobVersionId], quotedMode: "deterministic_only" });
    const reqDetail = requirementSummary.details.find((item) => item.jobVersionId === jobVersionId);
    if (reqDetail?.error) { sendApiError(res, 503, "DEPENDENCY_UNAVAILABLE", `Deterministic requirement extraction failed; the source observation remains durably staged. ${reqDetail.error}`); return; }

    const selectedIdentity: SelectedPostingIdentity = {
      candidateProfileId: inputJob.candidate_profile_id,
      canonicalJobId: accepted.canonicalJobId,
      jobVersionId: accepted.jobVersionId,
      sourceObservationId: accepted.sourceObservationId,
      contentHash: accepted.contentHash,
    };
    const observedCurrent = await loadCurrentInputs(pool, ctx, selectedIdentity);
    if (!observedCurrent) { sendApiError(res, 409, "JOB_VERSION_CHANGED", "This posting version is no longer current. Compare the current posting again."); return; }
    const observedComparison = ManualComparisonSchema.parse(buildManualComparison(observedCurrent.input));
    const comparisonFingerprint = fingerprintManualComparison(observedComparison);
    const draftClient = await pool.connect();
    let current: CurrentManualInputs;
    let comparison: ReturnType<typeof ManualComparisonSchema.parse>;
    let draftId: string;
    try {
      await draftClient.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      if (!(await hasWritableMembership(draftClient, ctx))) throw new ManualFlowError(403, "FORBIDDEN", "Workspace membership no longer permits comparison staging.");
      const latest = await loadCurrentInputs(draftClient, ctx, selectedIdentity);
      if (!latest) throw new ManualFlowError(409, "JOB_VERSION_CHANGED", "This posting version is no longer current. Compare the current posting again.");
      comparison = ManualComparisonSchema.parse(buildManualComparison(latest.input));
      if (fingerprintManualComparison(comparison) !== comparisonFingerprint) {
        throw new ManualFlowError(409, "APPROVAL_STALE", "The selected job or profile inputs changed while this comparison was being created. Compare again.");
      }
      current = latest;
      const draftResult = await draftClient.query<{ id: string }>(
        `INSERT INTO manual_application_drafts (
           workspace_id,user_id,candidate_profile_id,canonical_job_id,job_version_id,source_observation_id,
           job_content_hash,profile_version_id,profile_contact_fact_ids,profile_contact_fingerprint,
           preference_context_fingerprint,requirement_set_id,comparator_version,context_fingerprint,
           comparison_fingerprint,comparison_payload,suitability_warnings
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb)
         ON CONFLICT (workspace_id,user_id,comparison_fingerprint,profile_contact_fact_ids) DO NOTHING RETURNING id`,
        [ctx.workspaceId, ctx.userId, comparison.candidate_profile_id, accepted.canonicalJobId, accepted.jobVersionId,
          accepted.sourceObservationId, accepted.contentHash, comparison.profile_version_id, current.contactFactIds,
          current.contactFingerprint, current.preferenceContextFingerprint, comparison.requirement_set_id,
          comparison.comparator_version, comparison.context_fingerprint, comparisonFingerprint,
          JSON.stringify(comparison), JSON.stringify(comparison.suitability_warnings)],
      );
      draftId = draftResult.rows[0]?.id;
      if (!draftId) {
        const existing = await draftClient.query(
          `SELECT id,workspace_id,user_id,candidate_profile_id,canonical_job_id,job_version_id,
                  source_observation_id,job_content_hash,profile_version_id,profile_contact_fact_ids,
                  profile_contact_fingerprint,preference_context_fingerprint,requirement_set_id,
                  comparator_version,context_fingerprint,comparison_fingerprint,comparison_payload,suitability_warnings
           FROM manual_application_drafts
           WHERE workspace_id=$1 AND user_id=$2 AND comparison_fingerprint=$3 AND profile_contact_fact_ids=$4
           FOR UPDATE`,
          [ctx.workspaceId, ctx.userId, comparisonFingerprint, current.contactFactIds],
        );
        const persistedDraft = ManualPersistedDraftSchema.parse(existing.rows[0]);
        if (fingerprintManualComparison(persistedDraft.comparison_payload) !== comparisonFingerprint
            || stableStringify(persistedDraft.comparison_payload) !== stableStringify(comparison)) {
          throw new ManualFlowError(409, "APPROVAL_STALE", "An existing comparison with this fingerprint has different persisted content. Compare again.");
        }
        draftId = persistedDraft.id;
      }
      if (!draftId) throw new Error("Manual comparison draft was not durably staged.");
      await draftClient.query(
        `INSERT INTO manual_application_draft_contact_facts (workspace_id,user_id,draft_id,profile_version_id,profile_contact_fact_id)
         SELECT $1,$2,$3,$4,contact_fact_id FROM unnest($5::uuid[]) AS contact_fact_id
         ON CONFLICT DO NOTHING`,
        [ctx.workspaceId, ctx.userId, draftId, comparison.profile_version_id, current.contactFactIds],
      );
      await draftClient.query("COMMIT");
    } catch (error) {
      await draftClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { draftClient.release(); }
    const contactReady = Boolean(current.contact.full_name && current.contact.phone);
    const missingContactFields = [
      !current.contact.full_name && "full_name",
      !current.contact.phone && "phone",
    ].filter((field): field is "full_name" | "phone" => Boolean(field));
    const response = ManualCompareResponseSchema.parse({
      schema_version: MANUAL_APPLICATION_SCHEMA_VERSION,
      ok: true,
      draft_id: draftId,
      comparison_id: draftId,
      comparison_fingerprint: comparisonFingerprint,
      selected_job: {
        ...accepted,
        title: comparison.title,
        company: comparison.company,
        url: comparison.canonical_url,
        source: fetchReceipt ? {
          source_kind: "FETCHED",
          source_content_status: sourceContentStatus,
          provider: fetchReceipt.provider,
          fetched_content_hash: fetchReceipt.content_hash,
          source_evidence: fetchReceipt.source_evidence,
        } : {
          source_kind: inputJob.source_kind,
          source_content_status: "USER_PROVIDED",
          provider: null,
          fetched_content_hash: null,
          source_evidence: null,
        },
      },
      comparison,
      document_contact_ready: contactReady,
      missing_contact_fields: missingContactFields,
      requirements_extracted: requirementSummary.processed === 1,
    });
    res.json(response);
  }));

  router.post("/:draftId/approve", handler(async (req, res) => {
    const ctx = resolveContext(req);
    const draftId = String(req.params.draftId || "");
    const request = ManualApprovalRequestSchema.safeParse(req.body);
    if (!z.string().uuid().safeParse(draftId).success || !request.success) {
      throw new ManualFlowError(400, "INVALID_REQUEST", "Explicit approval and the exact comparison fingerprint are required.");
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      if (!(await hasWritableMembership(client, ctx))) {
        throw new ManualFlowError(403, "FORBIDDEN", "An active owner or member role is required to approve document preparation.");
      }
      const result = await client.query(
        "SELECT id,workspace_id,user_id,candidate_profile_id,canonical_job_id,job_version_id,\n" +
        "source_observation_id,job_content_hash,profile_version_id,profile_contact_fact_ids,\n" +
        "profile_contact_fingerprint,preference_context_fingerprint,requirement_set_id,\n" +
        "comparator_version,context_fingerprint,comparison_fingerprint,comparison_payload,suitability_warnings\n" +
        "FROM manual_application_drafts WHERE workspace_id=$1 AND user_id=$2 AND id=$3",
        [ctx.workspaceId, ctx.userId, draftId],
      );
      if (!result.rows[0]) throw new ManualFlowError(404, "NOT_FOUND", "Manual comparison draft was not found.");
      const draft = ManualPersistedDraftSchema.parse(result.rows[0]);
      if (request.data.comparison_fingerprint !== draft.comparison_fingerprint) {
        throw new ManualFlowError(409, "APPROVAL_STALE", "The comparison fingerprint changed. Compare again before approving.");
      }
      const storedComparison = ManualComparisonSchema.parse(draft.comparison_payload);
      if (fingerprintManualComparison(storedComparison) !== draft.comparison_fingerprint) {
        throw new ManualFlowError(500, "INTERNAL_ERROR", "The persisted comparison does not match its fingerprint.");
      }
      if (storedComparison.canonical_job_id !== draft.canonical_job_id
          || storedComparison.job_version_id !== draft.job_version_id
          || storedComparison.source_observation_id !== draft.source_observation_id
          || storedComparison.job_content_hash !== draft.job_content_hash
          || storedComparison.profile_version_id !== draft.profile_version_id
          || storedComparison.candidate_profile_id !== draft.candidate_profile_id
          || storedComparison.requirement_set_id !== draft.requirement_set_id
          || storedComparison.context_fingerprint !== draft.context_fingerprint
          || storedComparison.profile_contact_fingerprint !== draft.profile_contact_fingerprint
          || storedComparison.preference_context_fingerprint !== draft.preference_context_fingerprint
          || storedComparison.comparator_version !== draft.comparator_version) {
        throw new ManualFlowError(500, "INTERNAL_ERROR", "The persisted comparison context does not match its database identity.");
      }
      const current = await loadCurrentInputs(client, ctx, {
        candidateProfileId: draft.candidate_profile_id,
        canonicalJobId: draft.canonical_job_id,
        jobVersionId: draft.job_version_id,
        sourceObservationId: draft.source_observation_id,
        contentHash: draft.job_content_hash,
      });
      if (!current) throw new ManualFlowError(409, "JOB_VERSION_CHANGED", "The exact job version is no longer current. Compare the current posting again.");
      const currentComparison = ManualComparisonSchema.parse(buildManualComparison(current.input));
      const currentFingerprint = fingerprintManualComparison(currentComparison);
      const currentness = validateManualApprovalCurrentness(
        ManualApprovalIdentitySchema.parse(approvalIdentityFromDraft(draft)),
        ManualApprovalIdentitySchema.parse(approvalIdentityFromCurrent(current, currentFingerprint)),
      );
      if (!currentness.ok) {
        throw new ManualFlowError(409, "APPROVAL_STALE", "Job, source, profile, contact, preferences, requirements or comparison changed. Compare again before approving.");
      }
      await client.query(
        "INSERT INTO manual_application_preparation_approvals (\n" +
        "workspace_id,user_id,draft_id,candidate_profile_id,canonical_job_id,job_version_id,\n" +
        "source_observation_id,job_content_hash,profile_version_id,profile_contact_fact_ids,\n" +
        "profile_contact_fingerprint,preference_context_fingerprint,requirement_set_id,\n" +
        "comparator_version,context_fingerprint,comparison_fingerprint,approved\n" +
        ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,TRUE)\n" +
        "ON CONFLICT (workspace_id,user_id,draft_id,comparison_fingerprint) DO NOTHING",
        [draft.workspace_id, draft.user_id, draft.id, draft.candidate_profile_id, draft.canonical_job_id,
          draft.job_version_id, draft.source_observation_id, draft.job_content_hash, draft.profile_version_id,
          draft.profile_contact_fact_ids, draft.profile_contact_fingerprint, draft.preference_context_fingerprint,
          draft.requirement_set_id, draft.comparator_version, draft.context_fingerprint, draft.comparison_fingerprint],
      );
      const approvalResult = await client.query(
        "SELECT id,workspace_id,user_id,draft_id,candidate_profile_id,canonical_job_id,job_version_id,\n" +
        "source_observation_id,job_content_hash,profile_version_id,profile_contact_fact_ids,\n" +
        "profile_contact_fingerprint,preference_context_fingerprint,requirement_set_id,\n" +
        "comparator_version,context_fingerprint,comparison_fingerprint,approved\n" +
        "FROM manual_application_preparation_approvals\n" +
        "WHERE workspace_id=$1 AND user_id=$2 AND draft_id=$3 AND comparison_fingerprint=$4",
        [draft.workspace_id, draft.user_id, draft.id, draft.comparison_fingerprint],
      );
      const approval = ManualPersistedApprovalSchema.parse(approvalResult.rows[0]);
      await client.query(
        `INSERT INTO manual_application_approval_contact_facts (workspace_id,user_id,approval_id,draft_id,profile_version_id,profile_contact_fact_id)
         SELECT workspace_id,user_id,$3,draft_id,profile_version_id,profile_contact_fact_id
         FROM manual_application_draft_contact_facts WHERE workspace_id=$1 AND user_id=$2 AND draft_id=$4 AND profile_version_id=$5
         ON CONFLICT DO NOTHING`,
        [draft.workspace_id, draft.user_id, approval.id, draft.id, draft.profile_version_id],
      );
      const persistedIdentity = ManualApprovalIdentitySchema.parse({
        canonicalJobId: approval.canonical_job_id,
        jobVersionId: approval.job_version_id,
        sourceObservationId: approval.source_observation_id,
        jobContentHash: approval.job_content_hash,
        profileVersionId: approval.profile_version_id,
        candidateProfileId: approval.candidate_profile_id,
        profileContactFactIdsFingerprint: profileFactIdsFingerprint(approval.profile_contact_fact_ids),
        profileContactFingerprint: approval.profile_contact_fingerprint,
        preferenceContextFingerprint: approval.preference_context_fingerprint,
        requirementSetId: approval.requirement_set_id,
        comparatorVersion: approval.comparator_version,
        comparisonFingerprint: approval.comparison_fingerprint,
      });
      if (!validateManualApprovalCurrentness(
        ManualApprovalIdentitySchema.parse(approvalIdentityFromDraft(draft)),
        persistedIdentity,
      ).ok) {
        throw new ManualFlowError(500, "INTERNAL_ERROR", "The approval record did not preserve the exact comparison identity.");
      }
      await client.query("COMMIT");
      res.json(ManualApprovalResponseSchema.parse({
        schema_version: MANUAL_APPLICATION_SCHEMA_VERSION,
        ok: true,
        approval_id: approval.id,
        approved: true,
        comparison_fingerprint: approval.comparison_fingerprint,
      }));
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }));
  router.post("/:draftId/documents", handler(async (req, res) => {
    const ctx = resolveContext(req);
    const draftId = String(req.params.draftId || "");
    const request = ManualGenerateRequestSchema.safeParse(req.body);
    if (!z.string().uuid().safeParse(draftId).success || !request.success) {
      throw new ManualFlowError(400, "INVALID_REQUEST", "A valid draft and its explicit approval ID are required.");
    }
    const approvalId = request.data.approval_id;
    if (!(await hasWritableMembership(pool, ctx))) {
      throw new ManualFlowError(403, "FORBIDDEN", "An active owner or member role is required to generate documents.");
    }
    const selected = await loadPersistedApproval(pool, ctx, draftId, approvalId);
    if (!selected) throw new ManualFlowError(403, "FORBIDDEN", "No matching explicit approval exists for this workspace and draft.");
    const current = await loadCurrentInputs(pool, ctx, selectedPostingFromApproval(selected.approval));
    if (!current) throw new ManualFlowError(409, "JOB_VERSION_CHANGED", "The exact approved job version is no longer current. Compare and approve the current posting again.");
    const currentFingerprint = assertCurrentApproval(selected.approval, selected.comparison, current);
    const contact = current.contact;
    const fullName = contact.full_name?.trim();
    const phone = contact.phone?.trim();
    if (!fullName || !phone) {
      throw new ManualFlowError(409, "APPROVAL_STALE", "The current private contact graph must contain a candidate name and phone before documents can be generated.");
    }
    const docs = buildControlledDocuments(selected.comparison, { ...contact, full_name: fullName, phone });
    const cvDocx = await renderControlledDocx(docs.cv);
    const cvPdf = renderControlledPdf(docs.cv);
    const letterDocx = await renderControlledDocx(docs.coverLetter);
    const letterPdf = renderControlledPdf(docs.coverLetter);
    const artifacts = [
      { type: "CV", format: "DOCX", filename: `${safeFilename(current.input.title)}_CV.docx`, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", content: cvDocx },
      { type: "CV", format: "PDF", filename: `${safeFilename(current.input.title)}_CV.pdf`, mime: "application/pdf", content: cvPdf },
      { type: "COVER_LETTER", format: "DOCX", filename: `${safeFilename(current.input.company)}_Cover_Letter.docx`, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", content: letterDocx },
      { type: "COVER_LETTER", format: "PDF", filename: `${safeFilename(current.input.company)}_Cover_Letter.pdf`, mime: "application/pdf", content: letterPdf },
    ];
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      if (!(await hasWritableMembership(client, ctx))) throw new ManualFlowError(403, "FORBIDDEN", "Workspace membership no longer permits document generation.");
      const locked = await loadPersistedApproval(client, ctx, draftId, approvalId, true);
      if (!locked) throw new ManualFlowError(403, "FORBIDDEN", "The approved comparison is no longer available.");
      const lockedCurrent = await loadCurrentInputs(client, ctx, selectedPostingFromApproval(locked.approval));
      if (!lockedCurrent) throw new ManualFlowError(409, "JOB_VERSION_CHANGED", "The exact approved job version is no longer current.");
      const lockedFingerprint = assertCurrentApproval(locked.approval, locked.comparison, lockedCurrent);
      if (lockedFingerprint !== currentFingerprint) throw new ManualFlowError(409, "APPROVAL_STALE", "Approved inputs changed while documents were being prepared.");
      const existing = await client.query<{ document_type: "CV" | "COVER_LETTER"; format: "DOCX" | "PDF"; filename: string; mime_type: string; document_run_id: string }>(
        `SELECT document_type,format,filename,mime_type,document_run_id FROM manual_application_document_artifacts
         WHERE workspace_id=$1 AND user_id=$2 AND approval_id=$3 ORDER BY document_type,format`,
        [ctx.workspaceId, ctx.userId, approvalId],
      );
      if (existing.rows.length !== 0) {
        validateManualArtifactPair(existing.rows);
        await client.query("COMMIT");
        const response = ManualDocumentsResponseSchema.parse({
          schema_version: MANUAL_APPLICATION_SCHEMA_VERSION, ok: true, draft_id: draftId, approval_id: approvalId,
          comparison_fingerprint: currentFingerprint, preview: { cv: docs.cv, cover_letter: docs.coverLetter },
          artifacts: existing.rows.map(({ document_type, format, filename, mime_type }) => ({ type: document_type, format, filename, mime_type })),
        });
        res.setHeader("Cache-Control", "private, no-store");
        res.json(response);
        return;
      }
      const runIds: Record<string, string> = {};
      for (const type of ["CV", "COVER_LETTER"] as const) {
        const content = type === "CV" ? docs.cv : docs.coverLetter;
        const claimSet = docs.claims.filter((claim) => type === "CV" || content.includes(claim.text));
        const run = await client.query<{ id: string }>(
          `INSERT INTO manual_application_document_runs (
            workspace_id,user_id,approval_id,canonical_job_id,job_version_id,source_observation_id,job_content_hash,
            candidate_profile_id,profile_version_id,profile_contact_fact_ids,profile_contact_fingerprint,
            preference_context_fingerprint,requirement_set_id,comparator_version,context_fingerprint,
            comparison_fingerprint,document_type,status,generator_version,output_manifest
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'COMPLETED','manual_preparation_v1',$18::jsonb)
           RETURNING id`,
          [ctx.workspaceId, ctx.userId, approvalId, locked.approval.canonical_job_id, locked.approval.job_version_id,
            locked.approval.source_observation_id, locked.approval.job_content_hash, locked.approval.candidate_profile_id,
            locked.approval.profile_version_id, locked.approval.profile_contact_fact_ids, locked.approval.profile_contact_fingerprint,
            locked.approval.preference_context_fingerprint, locked.approval.requirement_set_id, locked.approval.comparator_version,
            locked.approval.context_fingerprint, currentFingerprint, type,
            JSON.stringify({ manual_preparation: true, draft_id: draftId, approval_id: approvalId,
              requirement_set_id: locked.approval.requirement_set_id, comparison_fingerprint: currentFingerprint,
              factual_template: true, automatic_readiness_mutated: false })]);
        runIds[type] = run.rows[0].id;
        for (const claim of claimSet) {
          await client.query(
            `INSERT INTO manual_application_document_claims (
              workspace_id,manual_document_run_id,section_label,claim_text,evidence_ids,requirement_keys
             ) VALUES ($1,$2,$3,$4,$5,$6)`,
            [ctx.workspaceId, runIds[type], claim.section, claim.text, claim.evidenceIds, claim.requirementKeys]);
        }
      }
      for (const artifact of artifacts) {
        await client.query(
          `INSERT INTO manual_application_document_artifacts (
            workspace_id,user_id,approval_id,document_run_id,document_type,format,filename,mime_type,content,sha256
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (approval_id,document_type,format) DO NOTHING`,
          [ctx.workspaceId, ctx.userId, approvalId, runIds[artifact.type], artifact.type, artifact.format,
            artifact.filename, artifact.mime, artifact.content, sha256Buffer(artifact.content)]);
      }
      const pair = await client.query<{ document_type: "CV" | "COVER_LETTER"; format: "DOCX" | "PDF"; document_run_id: string }>(
        `SELECT document_type,format,document_run_id FROM manual_application_document_artifacts
         WHERE workspace_id=$1 AND user_id=$2 AND approval_id=$3`, [ctx.workspaceId, ctx.userId, approvalId]);
      validateManualArtifactPair(pair.rows);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
    const response = ManualDocumentsResponseSchema.parse({
      schema_version: MANUAL_APPLICATION_SCHEMA_VERSION, ok: true, draft_id: draftId, approval_id: approvalId,
      comparison_fingerprint: currentFingerprint, preview: { cv: docs.cv, cover_letter: docs.coverLetter },
      artifacts: artifacts.map(({ type, format, filename, mime }) => ({ type, format, filename, mime_type: mime })),
    });
    res.setHeader("Cache-Control", "private, no-store");
    res.json(response);
  }));

  router.get("/:draftId/documents/:documentType/:format", handler(async (req, res) => {
    const ctx = resolveContext(req);
    const draftId = String(req.params.draftId || "");
    const type = String(req.params.documentType || "").toUpperCase();
    const format = String(req.params.format || "").toUpperCase();
    if (!z.string().uuid().safeParse(draftId).success || !["CV", "COVER_LETTER"].includes(type) || !["DOCX", "PDF"].includes(format)) {
      res.status(400).json({ ok: false, error: "Invalid document request." }); return;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY");
      if (!(await hasWritableMembership(client, ctx))) throw new ManualFlowError(403, "FORBIDDEN", "An active owner or member role is required to download private documents.");
      const approvalResult = await client.query<{ id: string }>(
        `SELECT id FROM manual_application_preparation_approvals
         WHERE workspace_id=$1 AND user_id=$2 AND draft_id=$3 AND approved IS TRUE LIMIT 1`,
        [ctx.workspaceId, ctx.userId, draftId],
      );
      const approvalId = approvalResult.rows[0]?.id;
      if (!approvalId) throw new ManualFlowError(404, "NOT_FOUND", "Approved private document pair was not found.");
      const artifactResult = await client.query(
        `SELECT artifact.filename,artifact.mime_type,artifact.content,artifact.sha256,artifact.document_type,artifact.format,
                artifact.document_run_id,document_run.status
         FROM manual_application_document_artifacts artifact
         JOIN manual_application_document_runs document_run ON document_run.id=artifact.document_run_id
           AND document_run.workspace_id=artifact.workspace_id AND document_run.user_id=artifact.user_id
           AND document_run.approval_id=artifact.approval_id AND document_run.document_type=artifact.document_type
         WHERE artifact.workspace_id=$1 AND artifact.user_id=$2 AND artifact.approval_id=$3
           AND artifact.document_type=$4 AND artifact.format=$5`,
        [ctx.workspaceId, ctx.userId, approvalId, type, format],
      );
      const row = artifactResult.rows[0];
      if (!row) throw new ManualFlowError(404, "NOT_FOUND", "Private document artifact was not found.");
      const selected = await loadPersistedApproval(client, ctx, draftId, approvalId);
      if (!selected) throw new ManualFlowError(404, "NOT_FOUND", "The matching approved comparison was not found.");
      const pair = await client.query<{ document_type: "CV" | "COVER_LETTER"; format: "DOCX" | "PDF"; document_run_id: string }>(
        `SELECT document_type,format,document_run_id FROM manual_application_document_artifacts
         WHERE workspace_id=$1 AND user_id=$2 AND approval_id=$3`, [ctx.workspaceId, ctx.userId, approvalId]);
      validateManualArtifactPair(pair.rows);
      if (row.document_type !== type || row.format !== format || row.status !== "COMPLETED") {
        throw new ManualFlowError(500, "INTERNAL_ERROR", "Document artifact metadata does not match its validated pair.");
      }
      const current = await loadCurrentInputs(client, ctx, selectedPostingFromApproval(selected.approval));
      if (!current) throw new ManualFlowError(409, "JOB_VERSION_CHANGED", "The exact approved job version is no longer current.");
      assertCurrentApproval(selected.approval, selected.comparison, current);
      const content = Buffer.from(row.content);
      if (sha256Buffer(content) !== row.sha256) throw new ManualFlowError(500, "INTERNAL_ERROR", "Stored private artifact failed its SHA-256 integrity check.");
      const result = ManualDownloadResponseSchema.parse({
        schema_version: MANUAL_APPLICATION_SCHEMA_VERSION, ok: true, filename: row.filename,
        mime_type: row.mime_type, sha256: row.sha256, content_base64: content.toString("base64"),
      });
      await client.query("COMMIT");
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.json(result);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }));

  return router;
}

function safeFilename(value: string): string {
  return value.normalize("NFKD").replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "Application";
}
