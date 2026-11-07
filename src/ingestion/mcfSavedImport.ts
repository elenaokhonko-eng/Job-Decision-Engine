/**
 * Stages a validated MyCareersFuture saved-jobs export into the canonical pipeline.
 *
 * Each saved job becomes an `MCF_SAVED` raw observation through
 * `SourceBroker.processObservation` (source identity, raw payload + hash,
 * processing state, normalized evidence) and gets its NORMALIZE_OBSERVATION task
 * from the standard scoped seeder. Re-importing the same file is idempotent on the
 * observation payload hash and the task keys.
 *
 * When a Gmail MCF alert card for the same MCF job UUID is waiting on posting
 * content (FETCH_PENDING / FETCH_BLOCKED / FETCH_FAILED, including cards parked
 * with repair action IMPORT_SAVED_JOB_EXPORT), its FETCH_JOB_CONTENT task is made
 * runnable again; the worker then uses the stored export as the posting content
 * (see mcfSavedContent.ts) instead of fetching the MCF page.
 */
import { createHash } from "node:crypto";
import type pg from "pg";
import type { SourcePlugin } from "../contracts/sourcePlugin.js";
import { classifyDescriptionQuality } from "../pipeline/descriptionQuality.js";
import { seedRecoverablePipelineTasks } from "../tasks/stageTaskWorker.js";
import type { WorkspaceContext } from "../workspace/context.js";
import { savedPostingMatchesDiscovery } from "./linkedInSavedExport.js";
import {
  WAITING_FETCH_STATUSES,
  inTransaction,
  queueContentAttach,
  type GmailMatchOutcome,
  type GmailMatchReport,
  type SavedItemOutcome,
} from "./linkedInSavedImport.js";
import { mcfSavedExternalId } from "./mcfSavedContent.js";
import {
  MCF_SAVED_EXPORT_SCHEMA,
  MCF_SAVED_PLUGIN_KEY,
  MCF_SAVED_SOURCE_NAME,
  mcfJobUuidFromUrl,
  type McfSavedExportParseResult,
  type McfSavedItemError,
  type McfSavedJob,
} from "./mcfSavedExport.js";
import { SourceBroker } from "./sourceBroker.js";

export interface McfSavedItemReport {
  readonly index: number;
  readonly mcfJobUuid: string;
  readonly outcome: SavedItemOutcome;
  readonly observationId: string | null;
  readonly descriptionQuality: string;
  readonly existingCanonicalJobs: number;
  readonly gmailMatches: GmailMatchReport[];
  readonly error?: string;
}

export interface McfSavedImportReport {
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
    readonly normalizeTasksSeeded: number;
    readonly normalizeTasksAlreadyQueued: number;
    readonly normalizeSeedDeferred: number;
    readonly existingCanonicalJobs: number;
  };
  /** Set when NORMALIZE_OBSERVATION seeding failed; the observations stay PENDING for the worker. */
  readonly normalizeSeedError: string | null;
  readonly invalid: McfSavedItemError[];
  readonly duplicatesInFile: McfSavedExportParseResult["duplicatesInFile"];
  readonly items: McfSavedItemReport[];
}

/** Invariant 7: any invalid or failed item makes the command fail after the valid ones are staged. */
export function mcfSavedImportExitCode(report: McfSavedImportReport): number {
  return report.totals.invalid > 0 || report.totals.failed > 0 || report.normalizeSeedError !== null ? 1 : 0;
}

function payloadHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function savedObservation(job: McfSavedJob, retrievedAt: string) {
  return {
    sourceName: MCF_SAVED_SOURCE_NAME,
    sourcePluginKey: MCF_SAVED_PLUGIN_KEY,
    sourceExternalId: mcfSavedExternalId(job.mcfJobUuid),
    sourceUrl: job.canonicalUrl,
    canonicalApplyUrl: job.canonicalUrl,
    retrievedAt,
    companyName: job.company,
    title: job.title,
    descriptionRaw: job.description,
    ...(job.location ? { locationRaw: job.location } : {}),
    workplaceTypeRaw: "UNKNOWN",
    employmentTypeRaw: job.employmentTypeRaw,
    ...(job.compensation ? { compensationRaw: job.compensation } : {}),
    sourceLane: "UNKNOWN",
    searchPlanVersion: MCF_SAVED_EXPORT_SCHEMA,
    rawPayload: job.rawPayload,
  } as const;
}

interface DiscoveryRow {
  id: string;
  title: string;
  company_name: string;
  source_url: string;
  processing_status: string | null;
  raw_email_alert_id: string | null;
  gmail_message_id: string | null;
}

/**
 * Gmail alert cards whose link names this MCF job. The SQL narrows on the UUID
 * text (hex survives URL encoding, so SES-wrapped links are found too) and the
 * exact identity is then decided by `mcfJobUuidFromUrl`.
 */
async function findGmailDiscoveries(client: pg.PoolClient, workspaceId: string, mcfJobUuid: string): Promise<DiscoveryRow[]> {
  const { rows } = await client.query<DiscoveryRow>(
    `SELECT id::text AS id, title, company_name, source_url, processing_status,
            raw_email_alert_id::text AS raw_email_alert_id, gmail_message_id
     FROM raw_job_observations
     WHERE workspace_id = $1
       AND source_name = 'GMAIL_ALERT'
       AND strpos(lower(source_url), $2) > 0
     ORDER BY retrieved_at ASC, id ASC`,
    [workspaceId, mcfJobUuid],
  );
  return rows.filter((row) => mcfJobUuidFromUrl(row.source_url) === mcfJobUuid);
}

async function countCanonicalJobs(client: pg.PoolClient, workspaceId: string, canonicalUrl: string): Promise<number> {
  const { rows } = await client.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM canonical_jobs WHERE workspace_id = $1 AND canonical_url = $2`,
    [workspaceId, canonicalUrl],
  );
  return rows[0]?.count ?? 0;
}

function classifyDiscovery(job: McfSavedJob, discovery: DiscoveryRow): GmailMatchOutcome | "ATTACHABLE" {
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

const CONTENT_ATTACH_SOURCE = { producer: "import_mcf_saved", pluginKey: MCF_SAVED_PLUGIN_KEY } as const;

export async function importMcfSavedJobs(
  client: pg.PoolClient,
  ctx: WorkspaceContext,
  parsed: McfSavedExportParseResult,
  options: { readonly dryRun: boolean; readonly plugin: SourcePlugin; readonly now?: () => Date },
): Promise<McfSavedImportReport> {
  if (options.plugin.source_key !== MCF_SAVED_PLUGIN_KEY) {
    throw new Error(`The MyCareersFuture saved-jobs import requires the ${MCF_SAVED_PLUGIN_KEY} source plugin.`);
  }
  const items: McfSavedItemReport[] = [];
  const broker = new SourceBroker(client, ctx);
  let sourceRunId: string | null = null;
  if (!options.dryRun) {
    await broker.ensureSourcePluginRevision(options.plugin);
    sourceRunId = await broker.startRun("MCF_SAVED_IMPORT");
  }

  for (const job of parsed.valid) {
    const descriptionQuality = classifyDescriptionQuality(job.description).status;
    if (options.dryRun) {
      const existing = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM raw_job_observations WHERE workspace_id = $1 AND raw_payload_hash = $2 LIMIT 1`,
        [ctx.workspaceId, payloadHash(job.rawPayload)],
      );
      const discoveries = await findGmailDiscoveries(client, ctx.workspaceId, job.mcfJobUuid);
      items.push({
        index: job.index,
        mcfJobUuid: job.mcfJobUuid,
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
      const report = await inTransaction(client, async (): Promise<McfSavedItemReport> => {
        const retrievedAt = (options.now?.() ?? new Date()).toISOString();
        const staged = await broker.processObservation(savedObservation(job, retrievedAt), job.rawPayload, client);
        if (!staged.observationId) throw new Error("The saved job did not receive a durable observation id.");
        const gmailMatches: GmailMatchReport[] = [];
        for (const discovery of await findGmailDiscoveries(client, ctx.workspaceId, job.mcfJobUuid)) {
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
          const queued = await queueContentAttach(client, ctx, discovery, CONTENT_ATTACH_SOURCE);
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
          mcfJobUuid: job.mcfJobUuid,
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
      broker.recordError(`MCF saved job at index ${job.index} (${job.mcfJobUuid}): ${message}`);
      items.push({
        index: job.index,
        mcfJobUuid: job.mcfJobUuid,
        outcome: "FAILED",
        observationId: null,
        descriptionQuality,
        existingCanonicalJobs: 0,
        gmailMatches: [],
        error: message,
      });
    }
  }

  // Normalization tasks come from the standard scoped seeder after the observations
  // have committed. Observations it does not reach stay PENDING for the worker.
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
  const report: McfSavedImportReport = {
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
