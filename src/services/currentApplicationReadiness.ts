import pg from "pg";

import { ApplicationReadinessSchema } from "../contracts/applicationReadiness.js";

export interface CurrentApplicationReadiness {
  readonly application_readiness: unknown;
  readonly readiness_status: string | null;
  readonly readiness_fingerprint: string | null;
  readonly readiness_expires_at: Date | string | null;
  readonly readiness_reason_codes: string[] | null;
  readonly canonical_job_id: string;
  readonly job_version_id: string;
  readonly profile_version_id: string | null;
  readonly requirement_set_id: string | null;
  readonly match_run_id: string | null;
  readonly evidence_revision_hash: string | null;
}

interface ReadinessPayload {
  readonly status?: unknown;
  readonly readiness_fingerprint?: unknown;
  readonly canonical_job_id?: unknown;
  readonly job_version_id?: unknown;
  readonly profile_version_id?: unknown;
  readonly requirement_set_id?: unknown;
  readonly match_run_id?: unknown;
  readonly evidence_revision_hash?: unknown;
  readonly evaluated_at?: unknown;
  readonly expires_at?: unknown;
}

function record(value: unknown): ReadinessPayload | null {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return null;
  // The payload comes from JSONB and its fields are narrowed by readiness identity checks below.
  return candidate as ReadinessPayload;
}

function timestamp(value: Date | string | null | undefined): number | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sameNullable(left: unknown, right: string | null): boolean {
  return right === null ? left === null : left === right;
}

function identityMatches(readiness: CurrentApplicationReadiness, payload: ReadinessPayload): boolean {
  return payload.canonical_job_id === readiness.canonical_job_id &&
    payload.job_version_id === readiness.job_version_id &&
    sameNullable(payload.profile_version_id, readiness.profile_version_id) &&
    sameNullable(payload.requirement_set_id, readiness.requirement_set_id) &&
    sameNullable(payload.match_run_id, readiness.match_run_id) &&
    sameNullable(payload.evidence_revision_hash, readiness.evidence_revision_hash) &&
    payload.readiness_fingerprint === readiness.readiness_fingerprint;
}

function hasReason(readiness: CurrentApplicationReadiness, reason: string): boolean {
  return readiness.readiness_reason_codes?.includes(reason) === true;
}

export async function applicationReadinessViewAvailable(
  client: pg.Pool | pg.PoolClient,
): Promise<boolean> {
  const view = await client.query<{ available: boolean }>(
    "SELECT to_regclass('v_application_readiness_current') IS NOT NULL AS available",
  );
  return view.rows[0]?.available === true;
}

export async function loadCurrentApplicationReadiness(
  client: pg.Pool | pg.PoolClient,
  workspaceId: string,
  canonicalJobId: string,
  jobVersionId: string,
  viewAvailable?: boolean,
): Promise<CurrentApplicationReadiness | null> {
  const available = viewAvailable ?? await applicationReadinessViewAvailable(client);
  if (!available) return null;

  const { rows } = await client.query<CurrentApplicationReadiness>(
    `SELECT application_readiness,
            readiness_status,
            readiness_fingerprint,
            readiness_expires_at,
            readiness_reason_codes,
            canonical_job_id::text AS canonical_job_id,
            job_version_id::text AS job_version_id,
            active_profile_version_id::text AS profile_version_id,
            requirement_set_id::text AS requirement_set_id,
            match_run_id::text AS match_run_id,
            evidence_revision_hash
     FROM v_application_readiness_current
     WHERE workspace_id = $1
       AND canonical_job_id = $2::uuid
       AND job_version_id = $3::uuid
     LIMIT 1`,
    [workspaceId, canonicalJobId, jobVersionId],
  );
  return rows[0] ?? null;
}

export function isCurrentReadyApplicationReadiness(
  readiness: CurrentApplicationReadiness | null,
  now = Date.now(),
): boolean {
  if (!readiness || readiness.readiness_status !== "READY" ||
      !/^[a-f0-9]{64}$/.test(readiness.readiness_fingerprint ?? "") ||
      readiness.readiness_reason_codes?.length !== 0) return false;

  const payloadCandidate = record(readiness.application_readiness);
  if (!payloadCandidate) return false;
  const parsed = ApplicationReadinessSchema.safeParse(payloadCandidate);
  if (!parsed.success) return false;
  const payload = parsed.data;
  const expiry = timestamp(readiness.readiness_expires_at);
  const payloadExpiry = Date.parse(payload.expires_at ?? "");
  return payload.status === "READY" &&
    identityMatches(readiness, payload) &&
    expiry !== null && expiry > now &&
    Number.isFinite(payloadExpiry) && payloadExpiry === expiry;
}

export function isCurrentReadinessAssessment(
  readiness: CurrentApplicationReadiness | null,
  now = Date.now(),
): boolean {
  if (!readiness || !readiness.readiness_fingerprint || readiness.readiness_status === null ||
      readiness.readiness_status === "PROCESSING") return false;

  const payload = record(readiness.application_readiness);
  if (!payload || !identityMatches(readiness, payload) ||
      (payload.status !== readiness.readiness_status && readiness.readiness_status !== "BLOCKED")) return false;
  if (["READINESS_EVIDENCE_STALE", "READINESS_FINGERPRINT_STALE", "READINESS_CONTEXT_STALE"]
    .some((reason) => hasReason(readiness, reason))) return false;

  if (!hasReason(readiness, "READINESS_EVIDENCE_EXPIRED")) return true;

  const expiry = timestamp(readiness.readiness_expires_at);
  const assessedAt = typeof payload.evaluated_at === "string" ? Date.parse(payload.evaluated_at) : Number.NaN;
  return payload.status !== "READY" && expiry !== null &&
    Number.isFinite(assessedAt) && assessedAt >= expiry && assessedAt <= now;
}
