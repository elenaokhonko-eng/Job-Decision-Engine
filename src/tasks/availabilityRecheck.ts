/**
 * RECHECK_AVAILABILITY: one posting read when a job's availability window has run out.
 *
 * The read re-evaluates three facts of the posting: open or closed, work mode, hiring territory.
 * What the read means is decided by the pure rule in src/decision/availabilityRecheck.ts; this module
 * performs the read, stores the verdict and acts on it:
 *
 *   OPEN     -> evidence refreshed (feed: refreshCanonicalJobSourceEvidence; page: a new evidence event),
 *               the 7-day window starts again; a job archived by this rule is restored.
 *   CLOSED   -> availability CLOSED is stored as evidence; the lists hide the job through
 *               v_job_availability_current. Nothing is archived or deleted.
 *   CANNOT TELL / WAIT -> the next read is queued (one day later); after 3 retries, or at day 10 of the
 *               cycle, the job is archived as POSTING_NOT_CONFIRMABLE through the archive service.
 *               A job the owner saved or applied to, or that a hold covers, is never auto-archived.
 *
 * Reads are rate-limited per host, using the source plugin manifest's requests_per_minute when the
 * source has one. A job whose work mode or territory changed is queued for a forced re-gate through
 * the hook the stage worker supplies, so the normal tasks carry it on.
 */
import crypto from "node:crypto";
import path from "node:path";

import pg from "pg";
import { z } from "zod";

import { loadStructuredFile } from "../config/structuredLoader.js";
import { SourcePluginSchema } from "../contracts/index.js";
import { AvailabilityEvidenceSchema, JobSourceEvidenceSchema, type JobSourceEvidence } from "../contracts/jobSourceEvidence.js";
import {
  decideRecheck,
  EMPTY_RECHECK_COUNTERS,
  type CannotTellReason,
  type RecheckAction,
  type RecheckCounters,
  type RecheckDecision,
  type RecheckReadKind,
  type RecheckReadOutcome,
} from "../decision/availabilityRecheck.js";
import { structuredWorkModeFromObservation, workdayRemoteTypeFromPayload } from "../decision/structuredWorkMode.js";
import { AshbyAdapter } from "../ingestion/adapters/ashbyAdapter.js";
import type { BaseSourceAdapter } from "../ingestion/adapters/baseAdapter.js";
import { GreenhouseAdapter } from "../ingestion/adapters/greenhouseAdapter.js";
import { LeverAdapter } from "../ingestion/adapters/leverAdapter.js";
import { WorkdayAdapter } from "../ingestion/adapters/workdayAdapter.js";
import {
  fetchJobContent,
  type JobContentResult,
  type PostingFetcherDependencies,
} from "../ingestion/jobContentFetcher.js";
import { buildEvidenceRevisionHash } from "../ingestion/jobSourceEvidence.js";
import {
  refreshCanonicalJobSourceEvidence,
  type SourceEvidenceRefreshResult,
} from "../ingestion/sourceEvidenceRefresh.js";
import { SourceBroker } from "../ingestion/sourceBroker.js";
import { normalizeWorkMode } from "../pipeline/workModeNormalizer.js";
import { runRecommendationDecider } from "../pipeline/recommendationDecider.js";
import {
  AVAILABILITY_RECHECK_ARCHIVE_RULE,
  archiveJobsAsPostingNotConfirmable,
  readAutomaticArchiveProtection,
} from "../services/jobArchive.js";
import { publicErrorSummary } from "../security/publicErrorSummary.js";
import type { WorkspaceContext } from "../workspace/context.js";
import { pipelineTaskStageVersion } from "./pipelineTaskCurrentness.js";
import { enqueuePipelineTask } from "./pipelineTasks.js";
import { createTaskIntentV2 } from "./taskIntent.js";

export const RECHECK_AVAILABILITY_TASK_TYPE = "RECHECK_AVAILABILITY" as const;
export const RECHECK_AVAILABILITY_STAGE_VERSION = "availability_recheck_v2" as const;

/** OPEN lasts 7 days when the posting itself was read (same rule as the source-evidence builder). */
const OPEN_WINDOW_MS = 7 * 24 * 3_600_000;
const CLOSED_WINDOW_MS = 24 * 3_600_000;
const DEFAULT_PAGE_INTERVAL_MS = 2_000;
const PROTECTED_RECHECK_MS = 7 * 24 * 3_600_000;

type Queryable = Pick<pg.PoolClient, "query">;

export const RecheckTaskPayloadSchema = z.object({
  canonical_job_id: z.string().uuid(),
  job_version_id: z.string().uuid(),
  /** End of the expired window; anchors the day-10 limit. */
  cycle_started_at: z.string().datetime(),
}).passthrough();
export type RecheckTaskPayload = z.infer<typeof RecheckTaskPayloadSchema>;

export interface FactsChange {
  readonly workMode: { readonly before: string; readonly after: string } | null;
  readonly territory: { readonly before: string; readonly after: string } | null;
}

export interface AvailabilityRecheckDependencies {
  readonly fetchJobContent: typeof fetchJobContent;
  readonly pageFetcherDependencies?: PostingFetcherDependencies;
  readonly refreshSourceEvidence: typeof refreshCanonicalJobSourceEvidence;
  readonly createFeedAdapter: (sourcePluginKey: string, sourceUrl: string, posting?: FeedPostingContext) => BaseSourceAdapter | null;
  readonly requestsPerMinute: (sourcePluginKey: string | null) => Promise<number | null>;
  readonly throttle: HostThrottle;
  readonly now: () => Date;
}

export type AvailabilityRecheckResult =
  | { readonly status: "SKIPPED"; readonly reason: "JOB_ARCHIVED" | "JOB_NOT_FOUND" | "STALE_VERSION" | "NOT_ELIGIBLE" }
  | {
      readonly status: "RECORDED";
      readonly readKind: RecheckReadKind;
      readonly outcome: RecheckReadOutcome["kind"];
      readonly action: RecheckAction | "KEPT_PROTECTED";
      readonly reasonCode: string;
      readonly nextTaskQueued: boolean;
      readonly factsChanged: boolean;
    };

/** Minimum gap between two reads of one host, in this process. Injected clock and sleep for tests. */
export class HostThrottle {
  private readonly nextAllowedAt = new Map<string, number>();

  constructor(
    private readonly clock: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async acquire(host: string, intervalMs: number): Promise<void> {
    const key = host.toLowerCase();
    const now = this.clock();
    const allowedAt = Math.max(now, this.nextAllowedAt.get(key) ?? 0);
    this.nextAllowedAt.set(key, allowedAt + intervalMs);
    const wait = allowedAt - now;
    if (wait > 0) await this.sleep(wait);
  }
}

const sharedThrottle = new HostThrottle();

async function loadManifestRequestsPerMinute(sourcePluginKey: string | null): Promise<number | null> {
  if (!sourcePluginKey || !/^[a-z0-9_-]+$/i.test(sourcePluginKey)) return null;
  try {
    const plugin = (await loadStructuredFile(
      path.resolve(process.cwd(), "config", "source-plugins", `${sourcePluginKey.toLowerCase()}.yml`),
      SourcePluginSchema,
    )).data;
    const rpm = plugin.request.rate_limit.requests_per_minute;
    return Number.isFinite(rpm) && rpm > 0 ? rpm : null;
  } catch {
    // A missing or unreadable manifest falls back to the conservative default interval.
    return null;
  }
}

/** What the stored posting says about itself; the Workday listing is rebuilt from it. */
export interface FeedPostingContext {
  readonly rawPayload: unknown;
  readonly companyName: string;
  readonly title: string;
}

function workdayTenantFromPayload(rawPayload: unknown): { host: string; tenant: string; site: string } | null {
  if (rawPayload === null || typeof rawPayload !== "object" || Array.isArray(rawPayload)) return null;
  const workday = (rawPayload as Record<string, unknown>).workday;
  if (workday === null || typeof workday !== "object" || Array.isArray(workday)) return null;
  const record = workday as Record<string, unknown>;
  const { host, tenant, site } = record;
  return typeof host === "string" && typeof tenant === "string" && typeof site === "string" ? { host, tenant, site } : null;
}

/**
 * The employer's Workday listing, searched for this posting's own title, using the tenant stored with
 * the posting. A bounded listing: it is trusted for absence only when its last page was not cut short
 * (see workdayListingComplete).
 */
export function createWorkdayListingAdapter(posting: FeedPostingContext): WorkdayAdapter | null {
  const tenant = workdayTenantFromPayload(posting.rawPayload);
  if (!tenant || posting.title.trim() === "" || posting.companyName.trim() === "") return null;
  try {
    return new WorkdayAdapter({
      config: { ...tenant, companyName: posting.companyName },
      searchTerms: [posting.title],
      limits: { searchTermsPerRun: 1, maxPagesPerTerm: 5 },
    });
  } catch {
    return null;
  }
}

/** True when the listing was read to its end: not stopped for budget and no search term cut short. */
export function workdayListingComplete(adapter: BaseSourceAdapter): boolean {
  if (!(adapter instanceof WorkdayAdapter)) return true;
  const stats = adapter.lastRunStats;
  return stats !== null && !stats.stoppedForBudget && stats.truncatedTerms.length === 0;
}

/** Official ATS board feeds this task can read without a login. Same rules as the scoped pilot. */
export function createFeedAdapterForPosting(sourcePluginKey: string, sourceUrl: string, posting?: FeedPostingContext): BaseSourceAdapter | null {
  if (sourcePluginKey.trim().toLowerCase() === "workday") return posting ? createWorkdayListingAdapter(posting) : null;
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const pathParts = url.pathname.split("/").filter(Boolean);
  const pluginKey = sourcePluginKey.trim().toLowerCase();
  if (pluginKey === "ashby" && url.hostname === "jobs.ashbyhq.com" && pathParts.length >= 2) {
    return new AshbyAdapter(pathParts[0]);
  }
  if (pluginKey === "greenhouse" &&
      ["boards.greenhouse.io", "job-boards.greenhouse.io"].includes(url.hostname) &&
      pathParts.length >= 2) {
    return new GreenhouseAdapter(pathParts[0]);
  }
  if (pluginKey === "lever" && url.hostname === "jobs.lever.co" && pathParts.length >= 2) {
    return new LeverAdapter(pathParts[0]);
  }
  return null;
}

export function defaultAvailabilityRecheckDependencies(): AvailabilityRecheckDependencies {
  return {
    fetchJobContent,
    refreshSourceEvidence: refreshCanonicalJobSourceEvidence,
    createFeedAdapter: createFeedAdapterForPosting,
    requestsPerMinute: loadManifestRequestsPerMinute,
    throttle: sharedThrottle,
    now: () => new Date(),
  };
}

/** Maps a posting page read to the rule's outcome. A page that cannot be read is never "closed". */
export function outcomeFromPageRead(result: JobContentResult): RecheckReadOutcome {
  switch (result.kind) {
    case "COMPLETE":
      return result.posting.availability === "CLOSED"
        ? { kind: "CLOSED_BY_PAGE", reasonCode: "PAGE_STATES_POSTING_CLOSED" }
        : { kind: "OPEN" };
    case "UNAVAILABLE": {
      const notFound = /HTTP (404|410)\b/.test(result.reason);
      return { kind: "CLOSED_BY_PAGE", reasonCode: notFound ? "PAGE_NOT_FOUND" : "PAGE_NO_LONGER_ACCEPTING" };
    }
    case "IDENTITY_CONFLICT":
      return { kind: "CANNOT_TELL", reason: "IDENTITY_CONFLICT" };
    case "RETRYABLE_FAILURE": {
      const reason: CannotTellReason = /rate limit/i.test(result.reason)
        ? "RATE_LIMITED"
        : /HTTP 5\d\d|HTTP 408/.test(result.reason) ? "SERVER_ERROR" : "TIMEOUT_OR_NETWORK";
      return { kind: "CANNOT_TELL", reason };
    }
    case "BLOCKED": {
      const reason: CannotTellReason = result.reason === "AUTH_REQUIRED"
        ? "PAYWALL_OR_LOGIN"
        : result.reason === "BOT_BLOCKED"
          ? "BOT_BLOCKED"
          : result.reason === "MISSING_POSTING_URL" ? "NO_POSTING_LINK" : "UNSUPPORTED_SOURCE";
      return { kind: "CANNOT_TELL", reason };
    }
  }
}

/** Maps a source-feed refresh to the rule's outcome. Only a complete snapshot without the posting is absence. */
export function outcomeFromFeedRefresh(result: SourceEvidenceRefreshResult): RecheckReadOutcome | "STALE" {
  switch (result.status) {
    case "REFRESHED":
    case "READINESS_REFRESH_PENDING":
      return { kind: "OPEN" };
    case "UNAVAILABLE":
      return { kind: "FEED_ABSENT" };
    case "CONFLICT":
      return { kind: "CANNOT_TELL", reason: "FEED_RECORD_CONFLICT" };
    case "FETCH_FAILED":
      return { kind: "CANNOT_TELL", reason: "TIMEOUT_OR_NETWORK" };
    case "UNSUPPORTED":
      return {
        kind: "CANNOT_TELL",
        reason: result.reasonCode === "SOURCE_DATA_UNSUPPORTED" ? "INCOMPLETE_FEED" : "UNSUPPORTED_SOURCE",
      };
    case "STALE_VERSION":
      return "STALE";
    case "NOT_LINKED":
      return { kind: "CANNOT_TELL", reason: "UNSUPPORTED_SOURCE" };
  }
}

interface RecheckTarget extends pg.QueryResultRow {
  canonical_job_id: string;
  latest_job_version_id: string | null;
  archived_at: Date | null;
  is_test_fixture: boolean;
  processing_state: string | null;
  company_name: string;
  normalized_title: string;
  canonical_url: string | null;
  workplace_type: string | null;
  location: string | null;
  availability_recheck_at: Date | null;
}

interface RecheckObservation extends pg.QueryResultRow {
  observation_id: string;
  source_name: string;
  source_plugin_key: string | null;
  source_url: string | null;
  canonical_apply_url: string | null;
  location_raw: string | null;
  workplace_type_raw: string | null;
  raw_payload: unknown;
  derived_from_observation_id: string | null;
}

async function loadTarget(client: Queryable, workspaceId: string, canonicalJobId: string): Promise<RecheckTarget | null> {
  const { rows } = await client.query<RecheckTarget>(
    `SELECT canonical.id::text AS canonical_job_id,
            canonical.latest_job_version_id::text AS latest_job_version_id,
            canonical.archived_at,
            canonical.is_test_fixture,
            COALESCE(canonical.processing_state, canonical.processing_status) AS processing_state,
            canonical.company_name,
            canonical.normalized_title,
            canonical.canonical_url,
            canonical.workplace_type,
            canonical.location,
            version.availability_recheck_at
       FROM canonical_jobs canonical
       LEFT JOIN job_versions version
         ON version.workspace_id = canonical.workspace_id AND version.id = canonical.latest_job_version_id
      WHERE canonical.workspace_id = $1::uuid AND canonical.id = $2::uuid`,
    [workspaceId, canonicalJobId],
  );
  return rows[0] ?? null;
}

async function loadObservation(client: Queryable, workspaceId: string, jobVersionId: string): Promise<RecheckObservation | null> {
  // The retrieved posting is preferred over the alert card that led to it.
  const { rows } = await client.query<RecheckObservation>(
    `SELECT observation.id::text AS observation_id,
            observation.source_name,
            observation.source_plugin_key,
            observation.source_url,
            observation.canonical_apply_url,
            observation.location_raw,
            observation.workplace_type_raw,
            observation.raw_payload,
            observation.derived_from_observation_id::text AS derived_from_observation_id
       FROM raw_job_observations observation
      WHERE observation.workspace_id = $1::uuid AND observation.job_version_id = $2::uuid
      ORDER BY (observation.source_name = 'GMAIL_ALERT') ASC, observation.retrieved_at DESC, observation.id ASC
      LIMIT 1`,
    [workspaceId, jobVersionId],
  );
  return rows[0] ?? null;
}

async function loadCounters(client: Queryable, workspaceId: string, canonicalJobId: string): Promise<RecheckCounters> {
  const { rows } = await client.query<{
    consecutive_absent_reads: number;
    cannot_tell_attempts: number;
    cycle_started_at: Date | null;
  }>(
    `SELECT consecutive_absent_reads, cannot_tell_attempts, cycle_started_at
       FROM job_availability_recheck_state
      WHERE workspace_id = $1::uuid AND canonical_job_id = $2::uuid`,
    [workspaceId, canonicalJobId],
  );
  const row = rows[0];
  return row
    ? {
        consecutiveAbsentReads: row.consecutive_absent_reads,
        cannotTellAttempts: row.cannot_tell_attempts,
        cycleStartedAt: row.cycle_started_at,
      }
    : EMPTY_RECHECK_COUNTERS;
}

async function countEvents(client: Queryable, workspaceId: string, canonicalJobId: string): Promise<number> {
  const { rows } = await client.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM job_availability_recheck_events
      WHERE workspace_id = $1::uuid AND canonical_job_id = $2::uuid`,
    [workspaceId, canonicalJobId],
  );
  return rows[0]?.count ?? 0;
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

const CLOSED_WORK_MODES = ["REMOTE", "HYBRID", "ONSITE"] as const;

/** Two location strings agree when one contains the other after normalising (so "Singapore" and "Singapore, SG" agree). */
function locationsAgree(known: string | null, page: string): boolean {
  const a = normalizedLocation(known);
  const b = normalizedLocation(page);
  return a === b || a.includes(b) || b.includes(a);
}

function normalizedLocation(value: string | null): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Work mode or territory differs between the stored observation and what the read found. An unknown
 * value on either side is never a change: an unreadable fact does not overwrite a known one.
 */
export function compareFacts(
  before: { workplaceTypeRaw: string | null; locationRaw: string | null },
  after: { workplaceTypeRaw: string | null; locationRaw: string | null },
): FactsChange {
  const modeBefore = normalizeWorkMode(before.workplaceTypeRaw);
  const modeAfter = normalizeWorkMode(after.workplaceTypeRaw);
  const workMode = modeAfter !== "UNKNOWN" && modeBefore !== modeAfter
    ? { before: modeBefore, after: modeAfter }
    : null;
  const locBefore = normalizedLocation(before.locationRaw);
  const locAfter = normalizedLocation(after.locationRaw);
  const territory = locAfter !== "" && locAfter !== "unknown" && locBefore !== locAfter
    ? { before: locBefore, after: locAfter }
    : null;
  return { workMode, territory };
}

function evidenceNow(
  status: "OPEN" | "CLOSED",
  now: Date,
  reasonCode: string,
  method: z.infer<typeof AvailabilityEvidenceSchema>["verification_method"],
): z.infer<typeof AvailabilityEvidenceSchema> {
  return AvailabilityEvidenceSchema.parse({
    status,
    verified_at: now.toISOString(),
    expires_at: new Date(now.getTime() + (status === "OPEN" ? OPEN_WINDOW_MS : CLOSED_WINDOW_MS)).toISOString(),
    verification_method: method,
    reason_code: reasonCode,
    evidence: [],
  });
}

/**
 * Stores an availability verdict as a new evidence event (the read model takes the latest event) and
 * on the job version, then recomputes readiness. Used for a page read and for closing on feed absence;
 * a successful feed match is stored by refreshCanonicalJobSourceEvidence itself.
 */
async function storeVerdict(
  client: pg.PoolClient,
  context: WorkspaceContext,
  target: { canonicalJobId: string; jobVersionId: string; observation: RecheckObservation },
  verdict: { status: "OPEN" | "CLOSED"; reasonCode: string; method: z.infer<typeof AvailabilityEvidenceSchema>["verification_method"] },
  now: Date,
): Promise<{ readinessRecomputed: boolean; readinessError: string | null }> {
  const availability = evidenceNow(verdict.status, now, verdict.reasonCode, verdict.method);
  const current = await client.query<{ job_source_evidence: unknown }>(
    `SELECT job_source_evidence
       FROM v_application_readiness_current
      WHERE workspace_id = $1::uuid AND canonical_job_id = $2::uuid`,
    [context.workspaceId, target.canonicalJobId],
  );
  const currentEvidence = current.rows[0]?.job_source_evidence ?? null;
  let evidence: JobSourceEvidence | null = null;
  if (currentEvidence !== null) {
    const parsed = JobSourceEvidenceSchema.safeParse(currentEvidence);
    if (parsed.success) evidence = JobSourceEvidenceSchema.parse({ ...parsed.data, availability });
  }

  await client.query("BEGIN");
  try {
    if (evidence !== null) {
      const broker = new SourceBroker(client, context);
      await broker.startRun("RUNNING");
      const payload = { availability_recheck: { status: verdict.status, reason_code: verdict.reasonCode, verified_at: availability.verified_at } };
      await broker.recordCandidateDisposition({
        sourcePluginKey: target.observation.source_plugin_key ?? target.observation.source_name.toLowerCase(),
        planKey: `availability-recheck:${target.jobVersionId}`,
        laneKey: null,
        sourceExternalId: null,
        sourceUrl: target.observation.source_url,
        rawPayloadHash: crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
        rawPayload: payload,
        normalizedEvidence: evidence,
        disposition: "DUPLICATE",
        reasonCode: verdict.reasonCode,
        reasonDetail: `job_version_id=${target.jobVersionId}; observation_id=${target.observation.observation_id}; availability re-check`,
        canonicalJobId: target.canonicalJobId,
        observationId: target.observation.observation_id,
      }, null);
      await broker.endRun("COMPLETED");
    }
    await client.query(
      `UPDATE job_versions
          SET availability_status = $1,
              availability_evidence = $2::jsonb,
              availability_verified_at = $3::timestamptz,
              availability_recheck_at = $4::timestamptz,
              evidence_revision_hash = COALESCE($5, evidence_revision_hash)
        WHERE workspace_id = $6::uuid AND canonical_job_id = $7::uuid AND id = $8::uuid`,
      [
        verdict.status,
        JSON.stringify(availability),
        availability.verified_at,
        availability.expires_at,
        evidence !== null ? buildEvidenceRevisionHash(evidence) : null,
        context.workspaceId,
        target.canonicalJobId,
        target.jobVersionId,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  try {
    const readiness = await runRecommendationDecider(client, {
      context,
      canonicalJobIds: [target.canonicalJobId],
      jobVersionIds: [target.jobVersionId],
    });
    return {
      readinessRecomputed: readiness.errors === 0,
      readinessError: readiness.errors === 0 ? null : `The recommendation decider reported ${readiness.errors} error(s).`,
    };
  } catch (error) {
    // Not swallowed: the public error summary goes on the event, and the stale readiness is visible as such.
    return { readinessRecomputed: false, readinessError: publicErrorSummary(error, "pipeline") };
  }
}

async function recordEvent(
  client: Queryable,
  context: WorkspaceContext,
  input: {
    canonicalJobId: string;
    jobVersionId: string;
    taskId: string | null;
    readKind: RecheckReadKind;
    outcome: RecheckReadOutcome["kind"];
    decision: RecheckAction | "KEPT_PROTECTED";
    reasonCode: string;
    counters: RecheckCounters;
    nextCheckAt: Date | null;
    details: Record<string, unknown>;
    now: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO job_availability_recheck_events (
       workspace_id, canonical_job_id, job_version_id, task_id, occurred_at, read_kind, outcome, decision,
       reason_code, consecutive_absent_reads_after, cannot_tell_attempts_after, details
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
    [context.workspaceId, input.canonicalJobId, input.jobVersionId, input.taskId, input.now, input.readKind,
      input.outcome, input.decision, input.reasonCode, input.counters.consecutiveAbsentReads,
      input.counters.cannotTellAttempts, JSON.stringify(input.details)],
  );
  await client.query(
    `INSERT INTO job_availability_recheck_state (
       workspace_id, canonical_job_id, job_version_id, consecutive_absent_reads, cannot_tell_attempts,
       cycle_started_at, last_read_at, last_feed_read_at, last_outcome, last_decision, next_check_at, updated_at
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $7)
     ON CONFLICT (workspace_id, canonical_job_id) DO UPDATE
        SET job_version_id = EXCLUDED.job_version_id,
            consecutive_absent_reads = EXCLUDED.consecutive_absent_reads,
            cannot_tell_attempts = EXCLUDED.cannot_tell_attempts,
            cycle_started_at = EXCLUDED.cycle_started_at,
            last_read_at = EXCLUDED.last_read_at,
            last_feed_read_at = COALESCE(EXCLUDED.last_feed_read_at, job_availability_recheck_state.last_feed_read_at),
            last_outcome = EXCLUDED.last_outcome,
            last_decision = EXCLUDED.last_decision,
            next_check_at = EXCLUDED.next_check_at,
            updated_at = EXCLUDED.updated_at`,
    [context.workspaceId, input.canonicalJobId, input.jobVersionId, input.counters.consecutiveAbsentReads,
      input.counters.cannotTellAttempts, input.counters.cycleStartedAt, input.now,
      input.readKind === "FEED" && input.outcome !== "CANNOT_TELL" ? input.now : null,
      input.outcome, input.decision, input.nextCheckAt],
  );
}

/** Queues the next read. The key carries the number of reads so far, so each read is its own task. */
export async function enqueueAvailabilityRecheck(
  client: pg.PoolClient | pg.Pool,
  context: WorkspaceContext,
  input: { canonicalJobId: string; jobVersionId: string; cycleStartedAt: Date; availableAt?: Date },
): Promise<boolean> {
  const sequence = await countEvents(client, context.workspaceId, input.canonicalJobId);
  const taskKey = `${RECHECK_AVAILABILITY_TASK_TYPE}:${input.jobVersionId}:${RECHECK_AVAILABILITY_STAGE_VERSION}:${sequence}`;
  const payload = {
    canonical_job_id: input.canonicalJobId,
    job_version_id: input.jobVersionId,
    cycle_started_at: input.cycleStartedAt.toISOString(),
  };
  const intent = createTaskIntentV2({
    workspaceId: context.workspaceId,
    taskType: RECHECK_AVAILABILITY_TASK_TYPE,
    stageVersion: RECHECK_AVAILABILITY_STAGE_VERSION,
    producer: "availabilityRecheck",
    requestId: taskKey,
    payload,
  });
  const result = await enqueuePipelineTask({
    taskType: RECHECK_AVAILABILITY_TASK_TYPE,
    taskKey,
    payload,
    maxAttempts: 8,
    availableAt: input.availableAt,
    intent,
  }, client, { context });
  return result.inserted;
}

/**
 * Queues a forced re-gate when a read found different work mode or territory, so the changed facts
 * reach the gate and the normal tasks (embedding, route, match, decide) carry the job on. One task
 * per read: the key carries the read's sequence number.
 */
async function enqueueForcedRegate(
  client: pg.PoolClient,
  context: WorkspaceContext,
  input: { canonicalJobId: string; jobVersionId: string; sequence: number },
): Promise<boolean> {
  const taskType = "APPLY_HARD_GATES";
  const stageVersion = pipelineTaskStageVersion(taskType);
  if (stageVersion === null) throw new Error("No registered pipeline stage version for the availability re-gate.");
  const payload = {
    canonical_job_id: input.canonicalJobId,
    job_version_id: input.jobVersionId,
    force_policy_recalculation: true,
    reassessment_reason: `AVAILABILITY_RECHECK:${input.sequence}`,
  };
  const taskKey = `${taskType}:${input.jobVersionId}:AVAILABILITY_RECHECK:${input.sequence}`;
  const intent = createTaskIntentV2({
    workspaceId: context.workspaceId,
    taskType,
    stageVersion,
    producer: "availabilityRecheck",
    requestId: taskKey,
    mode: "FORCE_RECOMPUTE",
    payload,
  });
  const result = await enqueuePipelineTask({ taskType, taskKey, payload, maxAttempts: 8, intent }, client, { context });
  return result.inserted;
}

export interface SeedAvailabilityRechecksSummary {
  readonly candidates: number;
  readonly inserted: number;
  readonly existing: number;
}

/**
 * Queues one re-check for each live job whose verified-open window has run out. Jobs whose
 * availability is CLOSED, still OPEN, or never verified are not candidates: this task re-reads
 * postings that were verified once and went stale. Fixtures, removed jobs and hard-rejected jobs are
 * skipped. Bounded by `limit`; the oldest windows first.
 */
export async function seedAvailabilityRechecks(
  client: pg.PoolClient | pg.Pool,
  context: WorkspaceContext,
  options: { limit?: number; jobVersionIds?: readonly string[]; includeTestFixtures?: boolean } = {},
): Promise<SeedAvailabilityRechecksSummary> {
  const limit = Math.max(1, Math.min(options.limit ?? 200, 2000));
  const scoped = options.jobVersionIds !== undefined;
  const { rows } = await client.query<{ canonical_job_id: string; job_version_id: string; availability_recheck_at: Date }>(
    `SELECT availability.canonical_job_id::text AS canonical_job_id,
            availability.job_version_id::text AS job_version_id,
            availability.availability_recheck_at
       FROM v_job_availability_current availability
       JOIN canonical_jobs canonical
         ON canonical.workspace_id = availability.workspace_id AND canonical.id = availability.canonical_job_id
      WHERE availability.workspace_id = $1::uuid
        AND availability.availability_state = 'UNKNOWN'
        AND availability.availability_status = 'OPEN'
        AND availability.availability_recheck_at <= NOW()
        AND canonical.archived_at IS NULL
        AND ($3::boolean OR canonical.is_test_fixture = FALSE)
        AND COALESCE(canonical.processing_state, canonical.processing_status)
              NOT IN ('MANUALLY_REMOVED', 'HARD_REJECTED')
        AND (NOT $4::boolean OR availability.job_version_id::text = ANY($5::text[]))
      ORDER BY availability.availability_recheck_at ASC, availability.canonical_job_id ASC
      LIMIT $2`,
    [context.workspaceId, limit, options.includeTestFixtures === true, scoped, [...(options.jobVersionIds ?? [])]],
  );
  let inserted = 0;
  let existing = 0;
  for (const row of rows) {
    const queued = await enqueueAvailabilityRecheck(client, context, {
      canonicalJobId: row.canonical_job_id,
      jobVersionId: row.job_version_id,
      cycleStartedAt: new Date(row.availability_recheck_at),
    });
    if (queued) inserted += 1;
    else existing += 1;
  }
  return { candidates: rows.length, inserted, existing };
}

async function readOnce(
  client: pg.PoolClient,
  context: WorkspaceContext,
  target: { canonicalJobId: string; jobVersionId: string; observation: RecheckObservation; titleForIdentity: string; companyForIdentity: string; fallbackUrl: string | null },
  deps: AvailabilityRecheckDependencies,
): Promise<{
  readKind: RecheckReadKind;
  outcome: RecheckReadOutcome | "STALE";
  page: Extract<JobContentResult, { kind: "COMPLETE" }> | null;
  feedFactsAfter: { workplaceTypeRaw: string | null; locationRaw: string | null } | null;
}> {
  const observation = target.observation;
  const sourceUrl = observation.source_url ?? observation.canonical_apply_url ?? target.fallbackUrl;
  const rpm = await deps.requestsPerMinute(observation.source_plugin_key);
  const interval = rpm ? Math.ceil(60_000 / rpm) : DEFAULT_PAGE_INTERVAL_MS;
  const host = hostOf(sourceUrl) ?? "unknown-host";

  const adapter = observation.source_plugin_key && sourceUrl
    ? deps.createFeedAdapter(observation.source_plugin_key, sourceUrl, {
      rawPayload: observation.raw_payload, companyName: target.companyForIdentity, title: target.titleForIdentity,
    })
    : null;
  if (adapter) {
    await deps.throttle.acquire(host, interval);
    const refreshed = await deps.refreshSourceEvidence(client, {
      canonicalJobId: target.canonicalJobId,
      jobVersionId: target.jobVersionId,
      observationId: observation.observation_id,
    }, { adapter, context, now: deps.now });
    let outcome = outcomeFromFeedRefresh(refreshed);
    // A listing that was cut short cannot prove absence: it is cannot-tell, never a count towards closing.
    if (outcome !== "STALE" && outcome.kind === "FEED_ABSENT" && !workdayListingComplete(adapter)) {
      outcome = { kind: "CANNOT_TELL", reason: "INCOMPLETE_FEED" };
    }
    let feedFactsAfter: { workplaceTypeRaw: string | null; locationRaw: string | null } | null = null;
    if (outcome !== "STALE" && outcome.kind === "OPEN") {
      const after = await loadObservation(client, context.workspaceId, target.jobVersionId);
      feedFactsAfter = after ? { workplaceTypeRaw: after.workplace_type_raw, locationRaw: after.location_raw } : null;
    }
    return { readKind: "FEED", outcome, page: null, feedFactsAfter };
  }

  if (!sourceUrl) {
    return { readKind: "NONE", outcome: { kind: "CANNOT_TELL", reason: "NO_POSTING_LINK" }, page: null, feedFactsAfter: null };
  }
  await deps.throttle.acquire(host, interval);
  const result = await deps.fetchJobContent(
    sourceUrl,
    { title: target.titleForIdentity, companyName: target.companyForIdentity, location: observation.location_raw },
    deps.pageFetcherDependencies ?? {},
  );
  return {
    readKind: "PAGE",
    outcome: outcomeFromPageRead(result),
    page: result.kind === "COMPLETE" ? result : null,
    feedFactsAfter: null,
  };
}

/**
 * Performs one availability re-check read for a job and acts on it. Idempotent per task: the event
 * log and counters are written in one step after the read, and the next read is queued only then.
 * `client` must not be inside a transaction.
 */
export async function runAvailabilityRecheck(
  client: pg.PoolClient,
  context: WorkspaceContext,
  rawPayload: unknown,
  taskId: string | null,
  deps: AvailabilityRecheckDependencies = defaultAvailabilityRecheckDependencies(),
): Promise<AvailabilityRecheckResult> {
  const payload = RecheckTaskPayloadSchema.parse(rawPayload);
  const now = deps.now();
  const target = await loadTarget(client, context.workspaceId, payload.canonical_job_id);
  if (!target) return { status: "SKIPPED", reason: "JOB_NOT_FOUND" };
  if (target.archived_at !== null) return { status: "SKIPPED", reason: "JOB_ARCHIVED" };
  if (target.is_test_fixture || target.processing_state === "MANUALLY_REMOVED") {
    return { status: "SKIPPED", reason: "NOT_ELIGIBLE" };
  }
  if (target.latest_job_version_id !== payload.job_version_id) return { status: "SKIPPED", reason: "STALE_VERSION" };
  const observation = await loadObservation(client, context.workspaceId, payload.job_version_id);
  if (!observation) return { status: "SKIPPED", reason: "NOT_ELIGIBLE" };

  const cycleStartedAt = new Date(payload.cycle_started_at);
  const counters = await loadCounters(client, context.workspaceId, payload.canonical_job_id);
  const identity = {
    canonicalJobId: payload.canonical_job_id,
    jobVersionId: payload.job_version_id,
    observation,
    titleForIdentity: target.normalized_title,
    companyForIdentity: target.company_name,
    fallbackUrl: target.canonical_url,
  };
  const beforeFacts = { workplaceTypeRaw: observation.workplace_type_raw, locationRaw: observation.location_raw };

  const read = await readOnce(client, context, identity, deps);
  if (read.outcome === "STALE") return { status: "SKIPPED", reason: "STALE_VERSION" };
  const outcome = read.outcome;
  const decision: RecheckDecision = decideRecheck(counters, outcome, now, cycleStartedAt);

  const details: Record<string, unknown> = { source_name: observation.source_name };
  if (outcome.kind === "CANNOT_TELL") details.cannot_tell_reason = outcome.reason;
  let action = decision.action as RecheckAction | "KEPT_PROTECTED";
  let reasonCode = decision.reasonCode;
  let nextCheckAt = decision.nextCheckAt;

  // Facts: re-evaluated from the same read. A feed match was refreshed in place; a page read is compared.
  let factsChanged = false;
  // Fact and archive writes are collected and run together with the event, counters, next read and
  // re-gate in ONE transaction below: a crash never leaves a changed fact without its event and re-gate.
  const writes: Array<() => Promise<void>> = [];
  if (decision.action === "MARK_OPEN") {
    if (read.page !== null) {
      const stored = await storeVerdict(client, context, identity, {
        status: "OPEN", reasonCode: decision.reasonCode, method: "VERIFIED_POSTING_RETRIEVAL",
      }, now);
      details.readiness_recomputed = stored.readinessRecomputed;
      if (stored.readinessError !== null) details.readiness_error = stored.readinessError;
      // Page text is untrusted. A page may FILL an unknown work mode or location, and only from an explicit
      // statement: work mode must be exactly REMOTE, HYBRID or ONSITE (the closed list the page reader emits;
      // free text such as "remote work possible for some roles" is ignored) and the location a non-empty,
      // non-"unknown" value. A page NEVER overwrites a known value: if it contradicts one, both values and the
      // source are recorded as a conflict on the event, and the job is neither re-gated nor rejected.
      const storedMode = String(target.workplace_type ?? "").trim().toUpperCase();
      const storedModeUnknown = storedMode === "" || storedMode === "UNKNOWN" || storedMode === "ASSUMED_HYBRID";
      const rawPageMode = String(read.page.posting.workplaceType ?? "").trim().toUpperCase();
      const pageMode = (CLOSED_WORK_MODES as readonly string[]).includes(rawPageMode) ? rawPageMode : "UNKNOWN";
      const pageLocation = (read.page.posting.location ?? "").trim();
      const pageLocationClear = pageLocation !== "" && normalizedLocation(pageLocation) !== "unknown";
      const storedLocationUnknown = normalizedLocation(target.location) === "" || normalizedLocation(target.location) === "unknown";
      const applied: Record<string, unknown> = {};
      const conflicts: Record<string, unknown> = {};
      if (pageMode !== "UNKNOWN") {
        if (storedModeUnknown) {
          writes.push(async () => {
            await client.query(
              `UPDATE canonical_jobs SET workplace_type = $3, updated_at = NOW()
                WHERE workspace_id = $1::uuid AND id = $2::uuid AND UPPER(COALESCE(workplace_type, 'UNKNOWN')) IN ('UNKNOWN', '', 'ASSUMED_HYBRID')`,
              [context.workspaceId, payload.canonical_job_id, pageMode],
            );
          });
          applied.work_mode = { before: storedMode === "" ? "UNKNOWN" : storedMode, after: pageMode };
        } else if (normalizeWorkMode(storedMode) !== pageMode) {
          conflicts.work_mode = { known: storedMode, page: pageMode };
        }
      }
      if (pageLocationClear) {
        if (storedLocationUnknown) {
          writes.push(async () => {
            await client.query(
              `UPDATE canonical_jobs SET location = $3, updated_at = NOW()
                WHERE workspace_id = $1::uuid AND id = $2::uuid AND LOWER(BTRIM(COALESCE(location, ''))) IN ('', 'unknown')`,
              [context.workspaceId, payload.canonical_job_id, pageLocation],
            );
          });
          applied.territory = { before: normalizedLocation(target.location), after: normalizedLocation(pageLocation) };
        } else if (!locationsAgree(target.location, pageLocation)) {
          conflicts.territory = { known: normalizedLocation(target.location), page: normalizedLocation(pageLocation) };
        }
      }
      if (Object.keys(applied).length > 0) {
        factsChanged = true;
        details.facts_applied_from_page = { ...applied, source_name: observation.source_name, observation_id: observation.observation_id };
      }
      if (Object.keys(conflicts).length > 0) {
        // No change and no re-gate: the conflict is stored with both values and the evidence for a person to verify.
        details.facts_conflict = { ...conflicts, source_name: observation.source_name, observation_id: observation.observation_id, evidence: "page read" };
      }
    } else if (read.feedFactsAfter !== null) {
      const change = compareFacts(beforeFacts, read.feedFactsAfter);
      if (change.workMode || change.territory) {
        factsChanged = true;
        details.facts_changed = change;
      }
    }
    // A work mode the older ingest left unknown, stated by a structured field of the stored payload.
    const storedMode = String(target.workplace_type ?? "").trim().toUpperCase();
    if (storedMode === "" || storedMode === "UNKNOWN" || storedMode === "ASSUMED_HYBRID") {
      const structured = structuredWorkModeFromObservation(observation.source_name, observation.raw_payload);
      if (structured !== "UNKNOWN") {
        writes.push(async () => {
          await client.query(
            `UPDATE canonical_jobs SET workplace_type = $3, updated_at = NOW()
              WHERE workspace_id = $1::uuid AND id = $2::uuid
                AND UPPER(COALESCE(workplace_type, 'UNKNOWN')) IN ('UNKNOWN', '', 'ASSUMED_HYBRID')`,
            [context.workspaceId, payload.canonical_job_id, structured],
          );
        });
        factsChanged = true;
        // Durable provenance: the field, its stored value, the observation it came from, and the value replaced.
        details.work_mode_from_structured_field = {
          value: structured,
          source_name: observation.source_name,
          observation_id: observation.observation_id,
          field: "detail.jobPostingInfo.remoteType",
          remote_type_raw: workdayRemoteTypeFromPayload(observation.raw_payload),
          replaced: storedMode === "" ? "UNKNOWN" : storedMode,
        };
      }
    }
    // A job archived by this rule comes back once the posting is seen open again.
    // (An archived job does not reach here; restore happens where the new observation is normalized.)
  } else if (decision.action === "MARK_CLOSED") {
    const stored = await storeVerdict(client, context, identity, {
      status: "CLOSED",
      reasonCode: decision.reasonCode,
      method: outcome.kind === "CLOSED_BY_PAGE" ? "EXPLICIT_SOURCE_STATUS" : "EMPLOYER_ATS_LISTING",
    }, now);
    details.readiness_recomputed = stored.readinessRecomputed;
      if (stored.readinessError !== null) details.readiness_error = stored.readinessError;
  } else if (decision.action === "ARCHIVE_NOT_CONFIRMABLE") {
    // Protection is read INSIDE the write transaction with the job row locked, so a save, application or hold
    // made between the decision and the archive cannot be missed. A protected job is never archived; it is read
    // again in 7 days (it stays hidden from the lists meanwhile because its availability is unconfirmed).
    writes.push(async () => {
      const protection = await readAutomaticArchiveProtection(client, {
        workspaceId: context.workspaceId,
        canonicalJobId: payload.canonical_job_id,
        now,
        lock: true,
      });
      if (protection.protected) {
        action = "KEPT_PROTECTED";
        reasonCode = `${decision.reasonCode}|PROTECTED:${protection.reasons.join("+")}`;
        nextCheckAt = new Date(now.getTime() + PROTECTED_RECHECK_MS);
        details.protection = protection.reasons;
        return;
      }
      const archived = await archiveJobsAsPostingNotConfirmable(client, {
        workspaceId: context.workspaceId,
        canonicalJobIds: [payload.canonical_job_id],
        actor: "system:availability-recheck",
        details: {
          rule: AVAILABILITY_RECHECK_ARCHIVE_RULE,
          reason_code: decision.reasonCode,
          cannot_tell_attempts: decision.counters.cannotTellAttempts,
          cycle_started_at: cycleStartedAt.toISOString(),
        },
      });
      details.archived = archived.length === 1;
    });
  }

  let nextTaskQueued = false;
  await client.query("BEGIN");
  try {
    for (const write of writes) await write();
    await recordEvent(client, context, {
      canonicalJobId: payload.canonical_job_id,
      jobVersionId: payload.job_version_id,
      taskId,
      readKind: read.readKind,
      outcome: outcome.kind,
      decision: action,
      reasonCode,
      counters: decision.counters,
      nextCheckAt,
      details,
      now,
    });

    if (nextCheckAt !== null && (action === "WAIT_NEXT_READ" || action === "RETRY_LATER" || action === "KEPT_PROTECTED")) {
      nextTaskQueued = await enqueueAvailabilityRecheck(client, context, {
        canonicalJobId: payload.canonical_job_id,
        jobVersionId: payload.job_version_id,
        cycleStartedAt: decision.counters.cycleStartedAt ?? cycleStartedAt,
        availableAt: nextCheckAt,
      });
    }
    if (factsChanged) {
      await enqueueForcedRegate(client, context, {
        canonicalJobId: payload.canonical_job_id,
        jobVersionId: payload.job_version_id,
        sequence: await countEvents(client, context.workspaceId, payload.canonical_job_id),
      });
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  return {
    status: "RECORDED",
    readKind: read.readKind,
    outcome: outcome.kind,
    action,
    reasonCode,
    nextTaskQueued,
    factsChanged,
  };
}
