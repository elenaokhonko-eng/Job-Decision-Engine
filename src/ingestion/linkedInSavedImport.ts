/**
 * Stages a validated LinkedIn saved-jobs export into the canonical pipeline.
 *
 * Each saved job becomes a `LINKEDIN_SAVED` raw observation through
 * `SourceBroker.processObservation` (source identity, raw payload + hash,
 * processing state, normalized evidence) and gets its NORMALIZE_OBSERVATION task
 * from the standard scoped seeder. Re-importing the same file is idempotent on the
 * observation payload hash and the task keys.
 *
 * When a Gmail LinkedIn alert card for the same LinkedIn job id is waiting on
 * posting content (FETCH_PENDING / FETCH_BLOCKED / FETCH_FAILED), its
 * FETCH_JOB_CONTENT task is made runnable again; the worker then uses the stored
 * export as the posting content (see linkedInSavedContent.ts) instead of a
 * LinkedIn page fetch.
 */
import { createHash } from "node:crypto";
import type pg from "pg";
import type { SourcePlugin } from "../contracts/sourcePlugin.js";
import { classifyDescriptionQuality } from "../pipeline/descriptionQuality.js";
import { enqueuePipelineTask } from "../tasks/pipelineTasks.js";
import { seedRecoverablePipelineTasks } from "../tasks/stageTaskWorker.js";
import type { WorkspaceContext } from "../workspace/context.js";
import { linkedInSavedExternalId } from "./linkedInSavedContent.js";
import {
  LINKEDIN_SAVED_EXPORT_SCHEMA,
  LINKEDIN_SAVED_PLUGIN_KEY,
  LINKEDIN_SAVED_SOURCE_NAME,
  savedPostingMatchesDiscovery,
  type LinkedInSavedExportParseResult,
  type LinkedInSavedItemError,
  type LinkedInSavedJob,
} from "./linkedInSavedExport.js";
import { SourceBroker } from "./sourceBroker.js";

const LINKEDIN_ID_PATTERN = "(?:linkedin\\.com/(?:comm/)?jobs/view/(?:[^/?#]*-)?)(\\d{5,20})";
const WAITING_FETCH_STATUSES = ["FETCH_PENDING", "FETCH_BLOCKED", "FETCH_FAILED"] as const;

export type SavedItemOutcome = "NEW" | "ALREADY_IMPORTED" | "WOULD_STAGE" | "WOULD_SKIP_ALREADY_IMPORTED" | "FAILED";

export type GmailMatchOutcome =
  | "CONTENT_ATTACH_QUEUED"
  | "WOULD_QUEUE_CONTENT_ATTACH"
  | "ALREADY_HAS_CONTENT"
  | "TITLE_MISMATCH"
  | "COMPANY_MISMATCH"
  | "DESCRIPTION_INCOMPLETE";

export interface GmailMatchReport {
  readonly observationId: string;
  readonly processingStatus: string | null;
  readonly outcome: GmailMatchOutcome;
  readonly fetchTasksReactivated: number;
  readonly fetchTaskEnqueued: boolean;
}

export interface SavedItemReport {
  readonly index: number;
  readonly linkedInJobId: string;
  readonly outcome: SavedItemOutcome;
  readonly observationId: string | null;
  readonly descriptionQuality: string;
  readonly existingCanonicalJobs: number;
  readonly gmailMatches: GmailMatchReport[];
  readonly error?: string;
}

export interface LinkedInSavedImportReport {
  readonly mode: "DRY_RUN" | "APPLIED";
  readonly sourceRunId: string | null;
  readonly totals: {
    readonly items: number;
    readonly valid: number;
    readonly invalid: number;
    readonly duplicatesInFile: number;
    readonly staged: number;
    readonly alreadyImported: number;
    readonly failed: number;
    readonly gmailMatches: number;
    readonly contentAttachQueued: number;
    readonly gmailAlreadyComplete: number;
    readonly gmailUnusable: number;
    readonly fetchTasksReactivated: number;
    readonly fetchTasksEnqueued: number;
    /** NORMALIZE_OBSERVATION tasks created now; existing ones are counted as already queued. */
    readonly normalizeTasksSeeded: number;
    readonly normalizeTasksAlreadyQueued: number;
    /** Staged observations left for the worker's own seeding because the seeding time budget ran out. */
    readonly normalizeSeedDeferred: number;
    readonly existingCanonicalJobs: number;
  };
  /** Set when NORMALIZE_OBSERVATION seeding failed; the observations stay PENDING for the worker. */
  readonly normalizeSeedError: string | null;
  readonly invalid: LinkedInSavedItemError[];
  readonly duplicatesInFile: LinkedInSavedExportParseResult["duplicatesInFile"];
  readonly items: SavedItemReport[];
}

/** Invariant 7: any invalid or failed item makes the command fail after the valid ones are staged. */
export function linkedInSavedImportExitCode(report: LinkedInSavedImportReport): number {
  return report.totals.invalid > 0 || report.totals.failed > 0 || report.normalizeSeedError !== null ? 1 : 0;
}

function payloadHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function savedObservation(job: LinkedInSavedJob, retrievedAt: string) {
  return {
    sourceName: LINKEDIN_SAVED_SOURCE_NAME,
    sourcePluginKey: LINKEDIN_SAVED_PLUGIN_KEY,
    sourceExternalId: linkedInSavedExternalId(job.linkedInJobId),
    sourceUrl: job.canonicalUrl,
    canonicalApplyUrl: job.canonicalUrl,
    retrievedAt,
    companyName: job.company,
    title: job.title,
    descriptionRaw: job.description,
    ...(job.location ? { locationRaw: job.location } : {}),
    workplaceTypeRaw: job.workplaceType,
    employmentTypeRaw: "UNKNOWN",
    ...(job.salary ? { compensationRaw: job.salary } : {}),
    sourceLane: "UNKNOWN",
    searchPlanVersion: LINKEDIN_SAVED_EXPORT_SCHEMA,
    rawPayload: job.rawPayload,
  } as const;
}

interface DiscoveryRow {
  id: string;
  title: string;
  company_name: string;
  processing_status: string | null;
  raw_email_alert_id: string | null;
  gmail_message_id: string | null;
}

async function findGmailDiscoveries(client: pg.PoolClient, workspaceId: string, linkedInJobId: string): Promise<DiscoveryRow[]> {
  const { rows } = await client.query<DiscoveryRow>(
    `SELECT id::text AS id, title, company_name, processing_status,
            raw_email_alert_id::text AS raw_email_alert_id, gmail_message_id
     FROM raw_job_observations
     WHERE workspace_id = $1
       AND source_name = 'GMAIL_ALERT'
       AND source_url ILIKE '%linkedin%'
       AND (regexp_match(lower(source_url), $3))[1] = $2
     ORDER BY retrieved_at ASC, id ASC`,
    [workspaceId, linkedInJobId, LINKEDIN_ID_PATTERN],
  );
  return rows;
}

async function countCanonicalJobs(client: pg.PoolClient, workspaceId: string, canonicalUrl: string): Promise<number> {
  const { rows } = await client.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM canonical_jobs WHERE workspace_id = $1 AND canonical_url = $2`,
    [workspaceId, canonicalUrl],
  );
  return rows[0]?.count ?? 0;
}

function classifyDiscovery(job: LinkedInSavedJob, discovery: DiscoveryRow): GmailMatchOutcome | "ATTACHABLE" {
  if (!WAITING_FETCH_STATUSES.includes((discovery.processing_status ?? "") as typeof WAITING_FETCH_STATUSES[number])) {
    return "ALREADY_HAS_CONTENT";
  }
  const identity = savedPostingMatchesDiscovery(
    { title: discovery.title, companyName: discovery.company_name },
    { title: job.title, companyName: job.company },
  );
  if (!identity.matches) return identity.reason;
  if (classifyDescriptionQuality(job.description).status !== "COMPLETE") return "DESCRIPTION_INCOMPLETE";
  return "ATTACHABLE";
}

/** Makes the discovery card's content fetch runnable again so the worker attaches the stored export. */
async function queueContentAttach(
  client: pg.PoolClient,
  ctx: WorkspaceContext,
  discovery: DiscoveryRow,
): Promise<{ reactivated: number; enqueued: boolean }> {
  await client.query(
    `UPDATE raw_job_observations
     SET processing_status = 'FETCH_PENDING'
     WHERE workspace_id = $1 AND id = $2::uuid AND source_name = 'GMAIL_ALERT'
       AND processing_status IN ('FETCH_BLOCKED', 'FETCH_FAILED')`,
    [ctx.workspaceId, discovery.id],
  );
  await client.query(
    `UPDATE raw_email_alerts
     SET lifecycle_status = 'SOURCE_PENDING', last_error = NULL
     WHERE workspace_id = $1
       AND lifecycle_status = 'SOURCE_BLOCKED'
       AND (($2::uuid IS NOT NULL AND id = $2::uuid)
         OR ($3::text IS NOT NULL AND gmail_message_id = $3::text))`,
    [ctx.workspaceId, discovery.raw_email_alert_id, discovery.gmail_message_id],
  );
  const reactivated = await client.query(
    `UPDATE pipeline_tasks
     SET status = 'PENDING',
         available_at = NOW(),
         lease_id = NULL,
         lease_expires_at = NULL,
         heartbeat_at = NULL,
         claimed_by = NULL,
         last_error = NULL,
         blocked_on = NULL,
         blocked_reason = NULL,
         repair_action = NULL,
         completed_at = NULL,
         updated_at = NOW()
     WHERE workspace_id = $1
       AND task_type = 'FETCH_JOB_CONTENT'
       AND status = 'BLOCKED_DEPENDENCY'
       AND blocked_on = 'JOB_CONTENT'
       AND payload->>'observation_id' = $2`,
    [ctx.workspaceId, discovery.id],
  );
  const active = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM pipeline_tasks
     WHERE workspace_id = $1
       AND task_type = 'FETCH_JOB_CONTENT'
       AND status IN ('PENDING', 'RUNNING', 'RETRY_WAIT')
       AND payload->>'observation_id' = $2
     LIMIT 1`,
    [ctx.workspaceId, discovery.id],
  );
  let enqueued = false;
  if (active.rows.length === 0) {
    // Dead-lettered or missing fetch task: queue one dedicated content-attach fetch.
    const taskKey = `FETCH_JOB_CONTENT:${discovery.id}:posting_fetch_v1:linkedin_saved`;
    const task = await enqueuePipelineTask({
      taskType: "FETCH_JOB_CONTENT",
      taskKey,
      payload: { observation_id: discovery.id },
      maxAttempts: 8,
      producer: "import_linkedin_saved",
      stageVersion: "posting_fetch_v1",
      requestId: taskKey,
    }, client, { context: ctx });
    enqueued = task.inserted || task.reactivated === true;
  }
  return { reactivated: reactivated.rowCount ?? 0, enqueued };
}

async function inTransaction<T>(client: pg.PoolClient, work: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    const result = await work();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function importLinkedInSavedJobs(
  client: pg.PoolClient,
  ctx: WorkspaceContext,
  parsed: LinkedInSavedExportParseResult,
  options: { readonly dryRun: boolean; readonly plugin: SourcePlugin; readonly now?: () => Date },
): Promise<LinkedInSavedImportReport> {
  if (options.plugin.source_key !== LINKEDIN_SAVED_PLUGIN_KEY) {
    throw new Error(`The LinkedIn saved-jobs import requires the ${LINKEDIN_SAVED_PLUGIN_KEY} source plugin.`);
  }
  const items: SavedItemReport[] = [];
  const broker = new SourceBroker(client, ctx);
  let sourceRunId: string | null = null;
  if (!options.dryRun) {
    await broker.ensureSourcePluginRevision(options.plugin);
    sourceRunId = await broker.startRun("LINKEDIN_SAVED_IMPORT");
  }

  for (const job of parsed.valid) {
    const descriptionQuality = classifyDescriptionQuality(job.description).status;
    if (options.dryRun) {
      const existing = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM raw_job_observations WHERE workspace_id = $1 AND raw_payload_hash = $2 LIMIT 1`,
        [ctx.workspaceId, payloadHash(job.rawPayload)],
      );
      const discoveries = await findGmailDiscoveries(client, ctx.workspaceId, job.linkedInJobId);
      items.push({
        index: job.index,
        linkedInJobId: job.linkedInJobId,
        outcome: existing.rows[0] ? "WOULD_SKIP_ALREADY_IMPORTED" : "WOULD_STAGE",
        observationId: existing.rows[0]?.id ?? null,
        descriptionQuality,
        existingCanonicalJobs: await countCanonicalJobs(client, ctx.workspaceId, job.canonicalUrl),
        gmailMatches: discoveries.map((discovery) => {
          const classified = classifyDiscovery(job, discovery);
          return {
            observationId: discovery.id,
            processingStatus: discovery.processing_status,
            outcome: classified === "ATTACHABLE" ? "WOULD_QUEUE_CONTENT_ATTACH" : classified,
            fetchTasksReactivated: 0,
            fetchTaskEnqueued: false,
          };
        }),
      });
      continue;
    }

    try {
      const report = await inTransaction(client, async (): Promise<SavedItemReport> => {
        const retrievedAt = (options.now?.() ?? new Date()).toISOString();
        const staged = await broker.processObservation(savedObservation(job, retrievedAt), job.rawPayload, client);
        if (!staged.observationId) throw new Error("The saved job did not receive a durable observation id.");
        const gmailMatches: GmailMatchReport[] = [];
        for (const discovery of await findGmailDiscoveries(client, ctx.workspaceId, job.linkedInJobId)) {
          const classified = classifyDiscovery(job, discovery);
          if (classified !== "ATTACHABLE") {
            gmailMatches.push({
              observationId: discovery.id,
              processingStatus: discovery.processing_status,
              outcome: classified,
              fetchTasksReactivated: 0,
              fetchTaskEnqueued: false,
            });
            continue;
          }
          const queued = await queueContentAttach(client, ctx, discovery);
          gmailMatches.push({
            observationId: discovery.id,
            processingStatus: discovery.processing_status,
            outcome: "CONTENT_ATTACH_QUEUED",
            fetchTasksReactivated: queued.reactivated,
            fetchTaskEnqueued: queued.enqueued,
          });
        }
        return {
          index: job.index,
          linkedInJobId: job.linkedInJobId,
          outcome: staged.inserted ? "NEW" : "ALREADY_IMPORTED",
          observationId: staged.observationId,
          descriptionQuality,
          existingCanonicalJobs: await countCanonicalJobs(client, ctx.workspaceId, job.canonicalUrl),
          gmailMatches,
        };
      });
      items.push(report);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      broker.recordError(`LinkedIn saved job at index ${job.index} (${job.linkedInJobId}): ${message}`);
      items.push({
        index: job.index,
        linkedInJobId: job.linkedInJobId,
        outcome: "FAILED",
        observationId: null,
        descriptionQuality,
        existingCanonicalJobs: 0,
        gmailMatches: [],
        error: message,
      });
    }
  }

  // Normalization tasks come from the standard scoped seeder, after the observations
  // have committed. Observations it does not reach stay PENDING and are seeded by the
  // pipeline worker's own pass, so nothing is lost when the budget runs out.
  let normalizeSeed = { inserted: 0, existing: 0, deferred: 0 };
  const stagedObservationIds = items
    .filter((item) => item.outcome === "NEW" || item.outcome === "ALREADY_IMPORTED")
    .map((item) => item.observationId)
    .filter((id): id is string => typeof id === "string");
  let normalizeSeedError: string | null = null;
  if (!options.dryRun && stagedObservationIds.length > 0) {
    try {
      const seeded = await seedRecoverablePipelineTasks(client, {
        context: ctx,
        taskTypes: ["NORMALIZE_OBSERVATION"],
        observationIds: stagedObservationIds,
        maxSeedPerType: stagedObservationIds.length,
        timeBudgetMs: 60_000,
      });
      const counts = seeded.byType.NORMALIZE_OBSERVATION ?? { inserted: 0, existing: 0 };
      normalizeSeed = { inserted: counts.inserted, existing: counts.existing, deferred: seeded.deferredByBudget };
    } catch (error) {
      normalizeSeedError = error instanceof Error ? error.message : String(error);
      broker.recordError(`Normalization task seeding failed: ${normalizeSeedError}`);
    }
  }

  const failed = items.filter((item) => item.outcome === "FAILED").length;
  const allMatches = items.flatMap((item) => item.gmailMatches);
  const report: LinkedInSavedImportReport = {
    mode: options.dryRun ? "DRY_RUN" : "APPLIED",
    sourceRunId,
    totals: {
      items: parsed.total,
      valid: parsed.valid.length,
      invalid: parsed.invalid.length,
      duplicatesInFile: parsed.duplicatesInFile.length,
      staged: items.filter((item) => item.outcome === "NEW" || item.outcome === "WOULD_STAGE").length,
      alreadyImported: items.filter((item) => item.outcome === "ALREADY_IMPORTED" || item.outcome === "WOULD_SKIP_ALREADY_IMPORTED").length,
      failed,
      gmailMatches: allMatches.length,
      contentAttachQueued: allMatches.filter((match) => match.outcome === "CONTENT_ATTACH_QUEUED" || match.outcome === "WOULD_QUEUE_CONTENT_ATTACH").length,
      gmailAlreadyComplete: allMatches.filter((match) => match.outcome === "ALREADY_HAS_CONTENT").length,
      gmailUnusable: allMatches.filter((match) => ["TITLE_MISMATCH", "COMPANY_MISMATCH", "DESCRIPTION_INCOMPLETE"].includes(match.outcome)).length,
      fetchTasksReactivated: allMatches.reduce((sum, match) => sum + match.fetchTasksReactivated, 0),
      fetchTasksEnqueued: allMatches.filter((match) => match.fetchTaskEnqueued).length,
      normalizeTasksSeeded: normalizeSeed.inserted,
      normalizeTasksAlreadyQueued: normalizeSeed.existing,
      normalizeSeedDeferred: normalizeSeed.deferred,
      existingCanonicalJobs: items.filter((item) => item.existingCanonicalJobs > 0).length,
    },
    normalizeSeedError,
    invalid: parsed.invalid,
    duplicatesInFile: parsed.duplicatesInFile,
    items,
  };

  if (!options.dryRun) {
    for (const invalid of parsed.invalid) broker.recordError(`Invalid export item at index ${invalid.index}: ${invalid.reason}`);
    const status = failed > 0 && failed === parsed.valid.length
      ? "FAILED"
      : failed > 0 || parsed.invalid.length > 0 || normalizeSeedError !== null ? "DEGRADED" : "COMPLETED";
    await broker.endRun(status);
  }
  return report;
}
