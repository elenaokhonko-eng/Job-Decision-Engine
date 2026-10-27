import { createHash } from "node:crypto";

import pg from "pg";

import { ExtractedJobSchema, type ExtractedJob } from "../contracts/index.js";
import {
  JobSourceEvidenceSchema,
  type AvailabilityEvidence,
  type JobSourceEvidence,
} from "../contracts/jobSourceEvidence.js";
import { generateContentHash } from "../services/criteria.js";
import { runRecommendationDecider } from "../pipeline/recommendationDecider.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../workspace/context.js";
import {
  buildEvidenceRevisionHash,
  buildJobSourceEvidence,
} from "./jobSourceEvidence.js";
import { normalizePostingUrl } from "./postingIdentity.js";
import { SourceBroker } from "./sourceBroker.js";
import type { BaseSourceAdapter, QuarantinedSourceCandidate } from "./adapters/baseAdapter.js";

const PAGE_SIZE = 200;
const DEFAULT_MAX_PAGES = 20;

export type SourceEvidenceRefreshStatus =
  | "REFRESHED"
  | "READINESS_REFRESH_PENDING"
  | "UNAVAILABLE"
  | "CONFLICT"
  | "UNSUPPORTED"
  | "FETCH_FAILED"
  | "STALE_VERSION"
  | "NOT_LINKED";

export interface SourceEvidenceRefreshRequest {
  readonly canonicalJobId: string;
  readonly jobVersionId: string;
  readonly observationId: string;
}

export interface SourceEvidenceRefreshOptions {
  readonly adapter: BaseSourceAdapter | null;
  readonly context?: WorkspaceContext;
  readonly maxPages?: number;
  readonly now?: () => Date;
}

export interface SourceEvidenceRefreshResult {
  readonly status: SourceEvidenceRefreshStatus;
  readonly canonicalJobId: string;
  readonly jobVersionId: string;
  readonly observationId: string;
  readonly reasonCode?: string;
  readonly evidenceRevisionHash?: string;
  readonly readinessRecomputed?: boolean;
}

interface RefreshTarget extends pg.QueryResultRow {
  readonly canonical_job_id: string;
  readonly job_version_id: string;
  readonly latest_job_version_id: string | null;
  readonly content_hash: string;
  readonly source_posting_identity_hash: string | null;
  readonly company_name: string;
  readonly normalized_title: string;
  readonly description_text: string;
  readonly observation_id: string;
  readonly source_name: string;
  readonly source_plugin_key: string | null;
  readonly source_plugin_revision_id: string | null;
  readonly source_external_id: string | null;
  readonly source_url: string | null;
  readonly canonical_apply_url: string | null;
  readonly retrieved_at: Date | string;
  readonly company_name_raw: string;
  readonly title_raw: string;
  readonly description_raw: string;
  readonly location_raw: string | null;
  readonly workplace_type_raw: string | null;
  readonly employment_type_raw: string | null;
  readonly compensation_raw: string | null;
  readonly raw_payload: unknown;
  readonly raw_payload_hash: string;
  readonly normalized_evidence: unknown;
}

export interface RefreshCandidateTarget {
  readonly adapterSourceName: string;
  readonly observedSourceName: string;
  readonly sourceExternalId: string | null;
  readonly sourceUrl: string | null;
  readonly expectedContentHash: string;
}

export type RefreshCandidateAssessment =
  | { readonly kind: "MATCHED"; readonly job: ExtractedJob }
  | { readonly kind: "UNAVAILABLE"; readonly reason: string }
  | { readonly kind: "CONFLICT"; readonly reason: string; readonly sourcePayload?: unknown }
  | { readonly kind: "UNSUPPORTED"; readonly reason: string; readonly sourcePayload?: unknown };

export interface SupportedVersionEvidence {
  readonly publishedAt: string | null;
  readonly sourceUpdatedAt: string | null;
  readonly expiresAt: string | null;
  readonly availability: AvailabilityEvidence | null;
}

function postingUrl(job: ExtractedJob): string | null {
  return job.employer_posting_url ?? job.canonical_apply_url ?? job.application_url ?? null;
}

function isHttpUrl(value: string | null): boolean {
  if (value === null) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function expectedPostingUrl(
  sourceExternalId: string | null,
  sourceUrl: string | null,
  sourceName: string,
): string | null {
  const externalIdUrl = isHttpUrl(sourceExternalId) ? sourceExternalId : null;
  if (externalIdUrl !== null && sourceUrl !== null &&
      normalizePostingUrl(externalIdUrl, sourceName) !== normalizePostingUrl(sourceUrl, sourceName)) {
    return null;
  }
  const url = sourceUrl ?? externalIdUrl;
  return url ? normalizePostingUrl(url, sourceName) : null;
}

function providerIdFromPostingUrl(value: string | null): string | null {
  if (!isHttpUrl(value)) return null;
  try {
    const segments = new URL(value as string).pathname.split("/").filter(Boolean);
    return segments.at(-1) ?? null;
  } catch {
    return null;
  }
}

function sourceIdentityMatches(
  externalId: string | null,
  sourceUrl: string | null,
  candidate: ExtractedJob,
  sourceName: string,
): boolean {
  if (externalId !== null && !isHttpUrl(externalId)) {
    return candidate.source_external_id?.trim() === externalId.trim();
  }
  const expectedUrl = expectedPostingUrl(externalId, sourceUrl, sourceName);
  const candidateUrl = postingUrl(candidate);
  if (expectedUrl === null || candidateUrl === null) return false;
  if (normalizePostingUrl(candidateUrl, sourceName) === expectedUrl) return true;

  const legacyProviderId = providerIdFromPostingUrl(externalId ?? sourceUrl);
  return legacyProviderId !== null && candidate.source_external_id?.trim() === legacyProviderId;
}

function rawPostingUrl(rawPayload: unknown, sourceName: string): string | null {
  const urlKeys = [
    "jobUrl",
    "job_url",
    "absolute_url",
    "hostedUrl",
    "hosted_url",
    "employer_posting_url",
    "canonical_apply_url",
    "application_url",
    "source_url",
    "url",
  ];
  for (const record of payloadRecords(rawPayload)) {
    for (const key of urlKeys) {
      const value = record[key];
      if (typeof value === "string" && normalizePostingUrl(value, sourceName) !== null) return value;
    }
  }
  return null;
}

function rawIdentityMatches(
  identity: string,
  sourceExternalId: string | null,
  sourceUrl: string | null,
  sourceName: string,
  rawPayload?: unknown,
): boolean {
  if (sourceExternalId !== null && !isHttpUrl(sourceExternalId) &&
      identity.trim() === sourceExternalId.trim()) return true;
  const expectedUrl = expectedPostingUrl(sourceExternalId, sourceUrl, sourceName);
  const candidateUrl = isHttpUrl(identity) ? identity : rawPostingUrl(rawPayload, sourceName);
  return expectedUrl !== null && candidateUrl !== null &&
    normalizePostingUrl(candidateUrl, sourceName) === expectedUrl;
}

function payloadRecords(value: unknown): Record<string, unknown>[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  const root = Object.fromEntries(Object.entries(value));
  const records = [root];
  for (const key of ["job", "posting", "data", "result"]) {
    const nested = root[key];
    if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
      records.push(Object.fromEntries(Object.entries(nested)));
    }
  }
  return records;
}

export function hasConflictingAvailabilitySignals(rawPayload: unknown): boolean {
  let hasOpenSignal = false;
  let hasClosedSignal = false;
  for (const record of payloadRecords(rawPayload)) {
    for (const key of ["status", "jobStatus", "applicationStatus"]) {
      const status = String(record[key] ?? "").trim().toLowerCase();
      if (["open", "active", "published", "live"].includes(status)) hasOpenSignal = true;
      if (["closed", "expired", "filled", "inactive", "not accepting applications"].includes(status)) hasClosedSignal = true;
    }
    if (record.isOpen === true || record.active === true) hasOpenSignal = true;
    if (record.isClosed === true || record.closed === true) hasClosedSignal = true;
  }
  return hasOpenSignal && hasClosedSignal;
}

export function clearConflictingAvailability(
  evidence: JobSourceEvidence,
  rawPayload: unknown,
): JobSourceEvidence {
  if (!hasConflictingAvailabilitySignals(rawPayload)) return evidence;
  return JobSourceEvidenceSchema.parse({
    ...evidence,
    availability: {
      status: "UNKNOWN",
      verified_at: null,
      expires_at: null,
      verification_method: "NONE",
      reason_code: "AVAILABILITY_CONFLICTING_SOURCE_STATUS",
      evidence: [],
    },
  });
}

export function assessSourceEvidenceCandidate(
  target: RefreshCandidateTarget,
  candidates: readonly unknown[],
  quarantinedCandidates: readonly QuarantinedSourceCandidate[] = [],
): RefreshCandidateAssessment {
  if (target.adapterSourceName.toUpperCase() !== target.observedSourceName.toUpperCase()) {
    return { kind: "UNSUPPORTED", reason: "The configured adapter does not match the observation source." };
  }
  if (target.sourceExternalId === null &&
      (!target.sourceUrl || normalizePostingUrl(target.sourceUrl, target.observedSourceName) === null)) {
    return { kind: "UNSUPPORTED", reason: "The observation has no stable source posting identity." };
  }

  const matchingQuarantine = quarantinedCandidates.find((candidate) =>
    rawIdentityMatches(
      candidate.identity,
      target.sourceExternalId,
      target.sourceUrl,
      target.observedSourceName,
      candidate.rawPayload,
    ),
  );
  if (matchingQuarantine) {
    return {
      kind: "UNSUPPORTED",
      reason: `The matching source record failed adapter validation: ${matchingQuarantine.error}`,
      sourcePayload: matchingQuarantine.rawPayload,
    };
  }

  const matches: ExtractedJob[] = [];
  for (const candidate of candidates) {
    const parsed = ExtractedJobSchema.safeParse(candidate);
    if (!parsed.success) {
      // Narrow an invalid adapter record only to test whether its source identity targets this observation.
      const rawRecord = candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
        ? candidate as Record<string, unknown>
        : null;
      const rawId = rawRecord?.source_external_id ?? rawRecord?.id;
      const candidateIdentity = typeof rawId === "string" || typeof rawId === "number" ? String(rawId) : "";
      if (candidateIdentity && rawIdentityMatches(
        candidateIdentity,
        target.sourceExternalId,
        target.sourceUrl,
        target.observedSourceName,
        candidate,
      )) {
        return {
          kind: "UNSUPPORTED",
          reason: "The matching source record failed ExtractedJob validation.",
          sourcePayload: candidate,
        };
      }
      continue;
    }
    if (sourceIdentityMatches(target.sourceExternalId, target.sourceUrl, parsed.data, target.observedSourceName)) {
      matches.push(parsed.data);
    }
  }

  if (matches.length === 0) {
    return { kind: "UNAVAILABLE", reason: "The source snapshot did not contain the linked posting." };
  }
  if (matches.length !== 1) {
    return {
      kind: "CONFLICT",
      reason: "The source snapshot contains multiple records for the linked posting identity.",
      sourcePayload: matches.map((candidate) => candidate.raw_payload ?? candidate),
    };
  }

  const job = matches[0];
  const expectedUrl = target.sourceUrl ? normalizePostingUrl(target.sourceUrl, target.observedSourceName) : null;
  const actualUrl = postingUrl(job);
  const actualNormalizedUrl = actualUrl ? normalizePostingUrl(actualUrl, target.observedSourceName) : null;
  if (expectedUrl !== null && actualNormalizedUrl !== null && expectedUrl !== actualNormalizedUrl) {
    return {
      kind: "CONFLICT",
      reason: "The linked source identifier now points to a different posting URL.",
      sourcePayload: job.raw_payload ?? job,
    };
  }
  if (generateContentHash(job.company_name, job.title, job.description_raw) !== target.expectedContentHash) {
    return {
      kind: "CONFLICT",
      reason: "The fetched posting content differs from the linked job version.",
      sourcePayload: job.raw_payload ?? job,
    };
  }
  return { kind: "MATCHED", job };
}

function candidateAuditPayload(
  assessment: RefreshCandidateAssessment,
  pagesFetched: number,
  totalFetched: number,
): unknown {
  if (assessment.kind === "MATCHED") return assessment.job.raw_payload ?? assessment.job;
  if ("sourcePayload" in assessment && assessment.sourcePayload !== undefined) return assessment.sourcePayload;
  return {
    refresh_status: assessment.kind,
    pages_fetched: pagesFetched,
    total_fetched: totalFetched,
    detail: assessment.reason,
  };
}

export function supportedVersionEvidence(evidence: JobSourceEvidence): SupportedVersionEvidence {
  return {
    publishedAt: evidence.dates.published_at.status === "SUPPORTED" ? evidence.dates.published_at.value : null,
    sourceUpdatedAt: evidence.dates.source_updated_at.status === "SUPPORTED" ? evidence.dates.source_updated_at.value : null,
    expiresAt: evidence.dates.expires_at.status === "SUPPORTED" ? evidence.dates.expires_at.value : null,
    availability: evidence.availability.status === "OPEN" || evidence.availability.status === "CLOSED"
      ? evidence.availability
      : null,
  };
}

function payloadHash(payload: unknown): string {
  const serialized = typeof payload === "string" ? payload : JSON.stringify(payload ?? null);
  if (typeof serialized !== "string") throw new Error("Source refresh payload could not be serialized for hashing.");
  return createHash("sha256").update(serialized).digest("hex");
}

function isPool(value: pg.Pool | pg.PoolClient): value is pg.Pool {
  return "connect" in value && typeof value.connect === "function" && !("release" in value);
}

async function loadRefreshTarget(
  client: pg.PoolClient,
  workspaceId: string,
  request: SourceEvidenceRefreshRequest,
  lock = false,
): Promise<RefreshTarget | null> {
  const lockClause = lock ? "FOR UPDATE OF canonical, version, observation" : "";
  const { rows } = await client.query<RefreshTarget>(
    `SELECT canonical.id::text AS canonical_job_id,
            version.id::text AS job_version_id,
            canonical.latest_job_version_id::text AS latest_job_version_id,
            version.content_hash,
            version.source_posting_identity_hash,
            canonical.company_name,
            canonical.normalized_title,
            version.description_text,
            observation.id::text AS observation_id,
            observation.source_name,
            observation.source_plugin_key,
            observation.source_plugin_revision_id::text AS source_plugin_revision_id,
            observation.source_external_id,
            observation.source_url,
            observation.canonical_apply_url,
            observation.retrieved_at,
            observation.company_name AS company_name_raw,
            observation.title AS title_raw,
            observation.description_raw,
            observation.location_raw,
            observation.workplace_type_raw,
            observation.employment_type_raw,
            observation.compensation_raw,
            observation.raw_payload,
            observation.raw_payload_hash,
            observation.normalized_evidence
     FROM canonical_jobs canonical
     JOIN job_versions version
       ON version.workspace_id = canonical.workspace_id
      AND version.canonical_job_id = canonical.id
     JOIN raw_job_observations observation
       ON observation.workspace_id = version.workspace_id
      AND observation.job_version_id = version.id
     WHERE canonical.workspace_id = $1
       AND canonical.id = $2::uuid
       AND version.id = $3::uuid
       AND observation.id = $4::uuid
     LIMIT 1
     ${lockClause}`,
    [workspaceId, request.canonicalJobId, request.jobVersionId, request.observationId],
  );
  return rows[0] ?? null;
}

function refreshResult(
  request: SourceEvidenceRefreshRequest,
  status: SourceEvidenceRefreshStatus,
  reasonCode?: string,
  extra: Pick<SourceEvidenceRefreshResult, "evidenceRevisionHash" | "readinessRecomputed"> = {},
): SourceEvidenceRefreshResult {
  return { ...request, status, ...(reasonCode ? { reasonCode } : {}), ...extra };
}

async function recordRefreshAudit(
  broker: SourceBroker,
  request: SourceEvidenceRefreshRequest,
  target: RefreshTarget,
  rawPayload: unknown,
  rawPayloadHash: string,
  options: {
    readonly status: SourceEvidenceRefreshStatus;
    readonly reasonCode: string;
    readonly reason: string;
    readonly evidence?: JobSourceEvidence;
    readonly completedRunStatus?: "COMPLETED" | "DEGRADED" | "FAILED";
  },
): Promise<void> {
  const isRefreshed = options.status === "REFRESHED";
  if (!isRefreshed) broker.recordError(`${options.reasonCode}: ${options.reason}`);
  await broker.recordCandidateDisposition({
    sourcePluginKey: target.source_plugin_key ?? target.source_name.toLowerCase(),
    planKey: `source-evidence-refresh:${request.jobVersionId}`,
    laneKey: null,
    sourceExternalId: target.source_external_id,
    sourceUrl: target.source_url,
    rawPayloadHash,
    rawPayload,
    normalizedEvidence: options.evidence ?? null,
    disposition: isRefreshed ? "DUPLICATE" : "ERROR",
    reasonCode: options.reasonCode,
    reasonDetail: `job_version_id=${request.jobVersionId}; observation_id=${request.observationId}; ${options.reason}`,
    canonicalJobId: request.canonicalJobId,
    observationId: request.observationId,
  }, null);
  await broker.endRun(options.completedRunStatus ?? (isRefreshed ? "COMPLETED" : "DEGRADED"));
}

async function appendReadinessRefreshError(
  client: pg.PoolClient,
  request: SourceEvidenceRefreshRequest,
  workspaceId: string,
  error: string,
  occurredAt: string,
): Promise<void> {
  await client.query(
    `UPDATE raw_job_observations
     SET error_history = COALESCE(error_history, '[]'::jsonb) || jsonb_build_array($1::jsonb)
     WHERE workspace_id = $2 AND id = $3::uuid AND job_version_id = $4::uuid`,
    [JSON.stringify({ stage: "SOURCE_EVIDENCE_READINESS_REFRESH", error, occurred_at: occurredAt }), workspaceId, request.observationId, request.jobVersionId],
  );
}

export async function refreshCanonicalJobSourceEvidence(
  clientOrPool: pg.Pool | pg.PoolClient,
  request: SourceEvidenceRefreshRequest,
  options: SourceEvidenceRefreshOptions,
): Promise<SourceEvidenceRefreshResult> {
  const ownsClient = isPool(clientOrPool);
  const client = ownsClient ? await clientOrPool.connect() : clientOrPool;
  try {
    const context = options.context ?? await resolveWorkspaceContext(client);
    const target = await loadRefreshTarget(client, context.workspaceId, request);
    if (!target) return refreshResult(request, "NOT_LINKED", "CANONICAL_VERSION_OBSERVATION_NOT_LINKED");
    if (target.latest_job_version_id !== request.jobVersionId) {
      return refreshResult(request, "STALE_VERSION", "JOB_VERSION_IS_NOT_CURRENT");
    }

    const broker = new SourceBroker(client, context);
    await broker.startRun("SOURCE_EVIDENCE_REFRESH");

    if (!options.adapter) {
      const payload = { refresh_status: "UNSUPPORTED", detail: "No source adapter was configured." };
      await recordRefreshAudit(broker, request, target, payload, payloadHash(payload), {
        status: "UNSUPPORTED",
        reasonCode: "SOURCE_ADAPTER_UNSUPPORTED",
        reason: "No source adapter was configured for the linked observation.",
      });
      return refreshResult(request, "UNSUPPORTED", "SOURCE_ADAPTER_UNSUPPORTED");
    }
    if (options.adapter.sourceName.toUpperCase() !== target.source_name.toUpperCase()) {
      const payload = { refresh_status: "UNSUPPORTED", adapter_source_name: options.adapter.sourceName };
      await recordRefreshAudit(broker, request, target, payload, payloadHash(payload), {
        status: "UNSUPPORTED",
        reasonCode: "SOURCE_ADAPTER_MISMATCH",
        reason: "The configured adapter does not match the linked observation source.",
      });
      return refreshResult(request, "UNSUPPORTED", "SOURCE_ADAPTER_MISMATCH");
    }
    if (target.source_external_id === null &&
        (!target.source_url || normalizePostingUrl(target.source_url, target.source_name) === null)) {
      const payload = { refresh_status: "UNSUPPORTED", detail: "The observation has no stable source posting identity." };
      await recordRefreshAudit(broker, request, target, payload, payloadHash(payload), {
        status: "UNSUPPORTED",
        reasonCode: "SOURCE_POSTING_IDENTITY_MISSING",
        reason: "The observation has no stable source posting identity.",
      });
      return refreshResult(request, "UNSUPPORTED", "SOURCE_POSTING_IDENTITY_MISSING");
    }

    const now = (options.now ?? (() => new Date()))();
    const retrievedAt = now.toISOString();
    const maxPages = Number.isInteger(options.maxPages) && Number(options.maxPages) > 0
      ? Number(options.maxPages)
      : DEFAULT_MAX_PAGES;
    const candidateTarget: RefreshCandidateTarget = {
      adapterSourceName: options.adapter.sourceName,
      observedSourceName: target.source_name,
      sourceExternalId: target.source_external_id,
      sourceUrl: target.source_url,
      expectedContentHash: target.content_hash,
    };

    let cursor: string | null = null;
    let pagesFetched = 0;
    let totalFetched = 0;
    let assessment: RefreshCandidateAssessment = { kind: "UNAVAILABLE", reason: "The source snapshot did not contain the linked posting." };
    let fetchedPayload: unknown = { refresh_status: "UNAVAILABLE", pages_fetched: 0, total_fetched: 0 };
    let fetchedPayloadHash = payloadHash(fetchedPayload);
    let morePagesRemain = false;
    const seenCursors = new Set<string>();

    try {
      while (pagesFetched < maxPages) {
        const page = await options.adapter.fetchJobs({ limit: PAGE_SIZE, cursor });
        pagesFetched++;
        if (!page.success) {
          assessment = { kind: "UNSUPPORTED", reason: page.error ?? "The source adapter did not complete successfully." };
          fetchedPayload = { refresh_status: "FETCH_FAILED", error: page.error ?? null, pages_fetched: pagesFetched };
          fetchedPayloadHash = payloadHash(fetchedPayload);
          broker.recordFetched(page.totalFetched);
          await recordRefreshAudit(broker, request, target, fetchedPayload, fetchedPayloadHash, {
            status: "FETCH_FAILED",
            reasonCode: "SOURCE_FETCH_FAILED",
            reason: assessment.reason,
            completedRunStatus: "FAILED",
          });
          return refreshResult(request, "FETCH_FAILED", "SOURCE_FETCH_FAILED");
        }

        totalFetched += page.totalFetched;
        broker.recordFetched(page.totalFetched);
        assessment = assessSourceEvidenceCandidate(candidateTarget, page.jobs, page.quarantinedCandidates);
        if (assessment.kind === "UNAVAILABLE" && (page.quarantined ?? 0) > 0 &&
            (page.quarantinedCandidates ?? []).length === 0) {
          assessment = {
            kind: "UNSUPPORTED",
            reason: "The adapter quarantined records without identities, so source absence cannot be verified.",
          };
        }
        fetchedPayload = candidateAuditPayload(assessment, pagesFetched, totalFetched);
        fetchedPayloadHash = payloadHash(fetchedPayload);
        if (assessment.kind !== "UNAVAILABLE") break;
        if (!page.hasMore) {
          morePagesRemain = false;
          break;
        }
        morePagesRemain = true;
        const nextCursor = page.nextCursor ?? null;
        if (nextCursor === null || seenCursors.has(nextCursor)) {
          assessment = { kind: "UNSUPPORTED", reason: "The source adapter returned an incomplete or repeating pagination cursor." };
          fetchedPayload = { refresh_status: "SOURCE_SNAPSHOT_INCOMPLETE", pages_fetched: pagesFetched, total_fetched: totalFetched };
          fetchedPayloadHash = payloadHash(fetchedPayload);
          break;
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }

      if (pagesFetched >= maxPages && morePagesRemain && assessment.kind === "UNAVAILABLE") {
        assessment = { kind: "UNSUPPORTED", reason: "The source snapshot exceeded the configured page limit before the posting was found." };
        fetchedPayload = { refresh_status: "SOURCE_SNAPSHOT_LIMIT_REACHED", pages_fetched: pagesFetched, total_fetched: totalFetched };
        fetchedPayloadHash = payloadHash(fetchedPayload);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const payload = { refresh_status: "FETCH_FAILED", error: detail, pages_fetched: pagesFetched, total_fetched: totalFetched };
      await recordRefreshAudit(broker, request, target, payload, payloadHash(payload), {
        status: "FETCH_FAILED",
        reasonCode: "SOURCE_FETCH_FAILED",
        reason: detail,
        completedRunStatus: "FAILED",
      });
      return refreshResult(request, "FETCH_FAILED", "SOURCE_FETCH_FAILED");
    }

    if (assessment.kind !== "MATCHED") {
      const status = assessment.kind;
      const reasonCode = status === "UNAVAILABLE"
        ? "SOURCE_POSTING_UNAVAILABLE"
        : status === "CONFLICT" ? "SOURCE_POSTING_CONFLICT" : "SOURCE_DATA_UNSUPPORTED";
      await recordRefreshAudit(broker, request, target, fetchedPayload, fetchedPayloadHash, {
        status,
        reasonCode,
        reason: assessment.reason,
      });
      return refreshResult(request, status, reasonCode);
    }

    const matchedJob = assessment.job;
    const rawPayload = matchedJob.raw_payload ?? matchedJob;
    const rawPayloadHash = payloadHash(rawPayload);
    const sourceUrl = target.source_url ?? postingUrl(matchedJob);
    let evidence: JobSourceEvidence;
    try {
      evidence = clearConflictingAvailability(JobSourceEvidenceSchema.parse(buildJobSourceEvidence({
        sourceName: target.source_name,
        sourcePluginKey: target.source_plugin_key,
        sourcePluginRevisionId: target.source_plugin_revision_id,
        sourceExternalId: target.source_external_id,
        sourceUrl,
        canonicalApplyUrl: target.canonical_apply_url ?? matchedJob.application_url ?? matchedJob.canonical_apply_url,
        retrievedAt,
        rawPayloadHash,
        rawPayload,
        companyName: matchedJob.company_name,
        title: matchedJob.title,
        locationRaw: matchedJob.location_raw,
        workplaceTypeRaw: matchedJob.workplace_type_raw,
        employmentTypeRaw: matchedJob.employment_type_raw,
        compensationRaw: matchedJob.compensation_raw,
        descriptionText: matchedJob.description_raw,
      })), rawPayload);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const payload = { refresh_status: "SOURCE_EVIDENCE_UNSUPPORTED", raw_payload: rawPayload, detail };
      await recordRefreshAudit(broker, request, target, payload, payloadHash(payload), {
        status: "UNSUPPORTED",
        reasonCode: "SOURCE_EVIDENCE_INVALID",
        reason: detail,
      });
      return refreshResult(request, "UNSUPPORTED", "SOURCE_EVIDENCE_INVALID");
    }

    const freshnessIdentity = sourceIdentityMatches(
      target.source_external_id,
      target.source_url,
      matchedJob,
      target.source_name,
    );
    if (!freshnessIdentity) {
      await recordRefreshAudit(broker, request, target, rawPayload, rawPayloadHash, {
        status: "CONFLICT",
        reasonCode: "SOURCE_POSTING_IDENTITY_CONFLICT",
        reason: "The fetched record no longer matches the linked source identity.",
        evidence,
      });
      return refreshResult(request, "CONFLICT", "SOURCE_POSTING_IDENTITY_CONFLICT");
    }

    const revisionHash = buildEvidenceRevisionHash(evidence);
    const supported = supportedVersionEvidence(evidence);
    const versionEvidenceIdentity = evidence.source_identity_hash;
    if (versionEvidenceIdentity === null) {
      await recordRefreshAudit(broker, request, target, rawPayload, rawPayloadHash, {
        status: "CONFLICT",
        reasonCode: "SOURCE_POSTING_IDENTITY_UNRESOLVED",
        reason: "The fetched record matched the source URL, but a stable posting identity fingerprint could not be derived.",
        evidence,
      });
      return refreshResult(request, "CONFLICT", "SOURCE_POSTING_IDENTITY_UNRESOLVED");
    }
    const identityFingerprintRekeyed = target.source_posting_identity_hash !== null &&
      versionEvidenceIdentity !== target.source_posting_identity_hash;

    await client.query("BEGIN");
    try {
      const lockedTarget = await loadRefreshTarget(client, context.workspaceId, request, true);
      if (!lockedTarget || lockedTarget.latest_job_version_id !== request.jobVersionId) {
        await client.query("ROLLBACK");
        const payload = { refresh_status: "STALE_VERSION", raw_payload_hash: rawPayloadHash };
        await recordRefreshAudit(broker, request, target, payload, payloadHash(payload), {
          status: "STALE_VERSION",
          reasonCode: "JOB_VERSION_CHANGED_DURING_REFRESH",
          reason: "The canonical job version or observation linkage changed during source refresh.",
        });
        return refreshResult(request, "STALE_VERSION", "JOB_VERSION_CHANGED_DURING_REFRESH");
      }
      if (lockedTarget.raw_payload_hash !== target.raw_payload_hash ||
          lockedTarget.source_external_id !== target.source_external_id ||
          lockedTarget.source_url !== target.source_url) {
        await client.query("ROLLBACK");
        const payload = { refresh_status: "CONFLICT", raw_payload_hash: rawPayloadHash };
        await recordRefreshAudit(broker, request, target, payload, payloadHash(payload), {
          status: "CONFLICT",
          reasonCode: "SOURCE_OBSERVATION_CHANGED_DURING_REFRESH",
          reason: "The linked observation changed while the source was being fetched.",
        });
        return refreshResult(request, "CONFLICT", "SOURCE_OBSERVATION_CHANGED_DURING_REFRESH");
      }

      if (lockedTarget.raw_payload_hash !== rawPayloadHash || lockedTarget.normalized_evidence !== null) {
        const baselinePayload = {
          source_evidence_refresh_baseline: {
            raw_payload: lockedTarget.raw_payload ?? null,
            raw_payload_hash: lockedTarget.raw_payload_hash,
            normalized_evidence: lockedTarget.normalized_evidence ?? null,
          },
        };
        await broker.recordCandidateDisposition({
          sourcePluginKey: target.source_plugin_key ?? target.source_name.toLowerCase(),
          planKey: `source-evidence-refresh:${request.jobVersionId}:baseline`,
          laneKey: null,
          sourceExternalId: target.source_external_id,
          sourceUrl: target.source_url,
          rawPayloadHash: payloadHash(baselinePayload),
          rawPayload: baselinePayload,
          disposition: "DUPLICATE",
          reasonCode: "SOURCE_EVIDENCE_REFRESH_BASELINE",
          reasonDetail: `Preserved the prior observation payload and evidence before refreshing job_version_id=${request.jobVersionId}.`,
          canonicalJobId: request.canonicalJobId,
          observationId: request.observationId,
        }, null);
      }

      await client.query(
        `UPDATE raw_job_observations
         SET retrieved_at = $1,
             company_name = $2,
             title = $3,
             description_raw = $4,
             location_raw = $5,
             workplace_type_raw = $6,
             employment_type_raw = $7,
             compensation_raw = $8,
             raw_payload = $9::jsonb,
             raw_payload_hash = $10,
             normalized_evidence = $11::jsonb,
             evidence_schema_version = $12
         WHERE workspace_id = $13
           AND id = $14::uuid
           AND job_version_id = $15::uuid`,
        [
          retrievedAt,
          matchedJob.company_name,
          matchedJob.title,
          matchedJob.description_raw,
          matchedJob.location_raw,
          matchedJob.workplace_type_raw,
          matchedJob.employment_type_raw,
          matchedJob.compensation_raw,
          JSON.stringify(rawPayload),
          rawPayloadHash,
          JSON.stringify(evidence),
          evidence.schema_version,
          context.workspaceId,
          request.observationId,
          request.jobVersionId,
        ],
      );

      await client.query(
        `UPDATE job_versions
         SET source_published_at = COALESCE($1::timestamptz, source_published_at),
             source_updated_at = COALESCE($2::timestamptz, source_updated_at),
             source_expires_at = COALESCE($3::timestamptz, source_expires_at),
             availability_status = CASE
               WHEN $4::text IN ('OPEN', 'CLOSED') THEN $4
               ELSE availability_status
             END,
             availability_evidence = CASE
               WHEN $5::jsonb IS NOT NULL THEN $5::jsonb
               ELSE availability_evidence
             END,
             availability_verified_at = CASE
               WHEN $4::text IN ('OPEN', 'CLOSED') THEN $6::timestamptz
               ELSE availability_verified_at
             END,
             availability_recheck_at = CASE
               WHEN $4::text IN ('OPEN', 'CLOSED') THEN $7::timestamptz
               ELSE availability_recheck_at
             END,
             evidence_revision_hash = $8,
             source_posting_identity_hash = $9
         WHERE workspace_id = $10
           AND canonical_job_id = $11::uuid
           AND id = $12::uuid`,
        [
          supported.publishedAt,
          supported.sourceUpdatedAt,
          supported.expiresAt,
          supported.availability?.status ?? null,
          supported.availability ? JSON.stringify(supported.availability) : null,
          supported.availability?.verified_at ?? null,
          supported.availability?.expires_at ?? null,
          revisionHash,
          versionEvidenceIdentity,
          context.workspaceId,
          request.canonicalJobId,
          request.jobVersionId,
        ],
      );

      await recordRefreshAudit(broker, request, target, rawPayload, rawPayloadHash, {
        status: "REFRESHED",
        reasonCode: identityFingerprintRekeyed
          ? "SOURCE_IDENTITY_FINGERPRINT_REKEYED"
          : "SOURCE_EVIDENCE_REFRESHED",
        reason: identityFingerprintRekeyed
          ? `Validated the current source URL and unchanged content, then refreshed the legacy identity fingerprint. evidence_revision_hash=${revisionHash}`
          : `evidence_revision_hash=${revisionHash}`,
        evidence,
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      const detail = error instanceof Error ? error.message : String(error);
      const payload = { refresh_status: "PERSISTENCE_FAILED", error: detail, raw_payload_hash: rawPayloadHash };
      await recordRefreshAudit(broker, request, target, payload, payloadHash(payload), {
        status: "FETCH_FAILED",
        reasonCode: "SOURCE_EVIDENCE_PERSISTENCE_FAILED",
        reason: detail,
        completedRunStatus: "FAILED",
      });
      throw error;
    }

    try {
      const readiness = await runRecommendationDecider(client, {
        context,
        canonicalJobIds: [request.canonicalJobId],
        jobVersionIds: [request.jobVersionId],
      });
      const persistedReadiness = await client.query<{ available: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM deterministic_decisions decision
           JOIN canonical_jobs canonical
             ON canonical.workspace_id = decision.workspace_id
            AND canonical.id = decision.canonical_job_id
           WHERE decision.workspace_id = $1
             AND decision.canonical_job_id = $2::uuid
             AND decision.job_version_id = $3::uuid
             AND decision.evidence_revision_hash = $4
             AND decision.readiness_json IS NOT NULL
             AND canonical.latest_job_version_id = decision.job_version_id
         ) AS available`,
        [context.workspaceId, request.canonicalJobId, request.jobVersionId, revisionHash],
      );
      if (readiness.errors > 0 || persistedReadiness.rows[0]?.available !== true) {
        const detail = readiness.errors > 0
          ? `${readiness.errors} targeted readiness recomputation error(s).`
          : "No current readiness decision was persisted for the refreshed version.";
        await appendReadinessRefreshError(client, request, context.workspaceId, detail, retrievedAt);
        return refreshResult(request, "READINESS_REFRESH_PENDING", "READINESS_RECOMPUTATION_FAILED", {
          evidenceRevisionHash: revisionHash,
          readinessRecomputed: false,
        });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await appendReadinessRefreshError(client, request, context.workspaceId, detail, retrievedAt);
      return refreshResult(request, "READINESS_REFRESH_PENDING", "READINESS_RECOMPUTATION_FAILED", {
        evidenceRevisionHash: revisionHash,
        readinessRecomputed: false,
      });
    }

    return refreshResult(request, "REFRESHED", undefined, {
      evidenceRevisionHash: revisionHash,
      readinessRecomputed: true,
    });
  } finally {
    if (ownsClient) client.release();
  }
}
