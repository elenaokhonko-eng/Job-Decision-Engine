/**
 * Saved-jobs export imports over the authenticated v2 API.
 *
 *   POST /api/v2/imports/linkedin-saved   { items: unknown[], dryRun: boolean }
 *   POST /api/v2/imports/mcf-saved        { items: unknown[], dryRun: boolean }
 *
 * Both routes hand the parsed export array to the canonical importers
 * (`importLinkedInSavedJobs`, `importMcfSavedJobs`), the same functions the
 * `npm run import:*-saved` commands use. The response carries counts, job ids,
 * per-item outcomes and the invalid items with their reasons; it never echoes
 * titles, employers or descriptions.
 *
 * This router is mounted after authentication and workspace resolution, and it
 * parses its own (larger) JSON body there, so an unauthenticated caller never
 * gets a multi-megabyte body parsed.
 */
import path from "node:path";
import express from "express";
import pg from "pg";
import { z } from "zod";
import { loadStructuredFile } from "../../config/structuredLoader.js";
import { SourcePluginSchema, type SourcePlugin } from "../../contracts/index.js";
import {
  LINKEDIN_SAVED_PLUGIN_KEY,
  LinkedInSavedExportFileError,
  parseLinkedInSavedExport,
} from "../../ingestion/linkedInSavedExport.js";
import {
  importLinkedInSavedJobs,
  linkedInSavedImportExitCode,
  type GmailMatchReport,
  type LinkedInSavedImportReport,
} from "../../ingestion/linkedInSavedImport.js";
import { MCF_SAVED_PLUGIN_KEY, McfSavedExportFileError, parseMcfSavedExport } from "../../ingestion/mcfSavedExport.js";
import { importMcfSavedJobs, mcfSavedImportExitCode, type McfSavedImportReport } from "../../ingestion/mcfSavedImport.js";
import type { WorkspaceContext } from "../../workspace/context.js";

/** Largest accepted request body. A saved-jobs export with full descriptions is a few hundred KB per hundred jobs. */
export const SAVED_IMPORT_MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Largest accepted export per request; the CLI importers accept larger files. */
export const SAVED_IMPORT_MAX_ITEMS = 500;
export const SAVED_IMPORT_RESPONSE_SCHEMA = "saved_jobs_import_v1" as const;

const ImportRequestSchema = z.object({
  items: z.array(z.unknown()),
  dryRun: z.boolean(),
}).strict();

export type SavedImportSource = "LINKEDIN_SAVED" | "MCF_SAVED";

export interface SavedImportGmailMatch {
  readonly observation_id: string;
  readonly processing_status: string | null;
  readonly outcome: string;
  readonly fetch_tasks_reactivated: number;
  readonly fetch_task_enqueued: boolean;
}

export interface SavedImportItem {
  readonly index: number;
  readonly job_id: string;
  readonly outcome: string;
  readonly observation_id: string | null;
  readonly description_quality: string;
  readonly existing_canonical_jobs: number;
  readonly gmail_matches: SavedImportGmailMatch[];
  readonly error: string | null;
}

export interface SavedImportResponse {
  readonly ok: true;
  readonly schema_version: typeof SAVED_IMPORT_RESPONSE_SCHEMA;
  readonly source: SavedImportSource;
  readonly mode: "DRY_RUN" | "APPLIED";
  /** False when any item was invalid or failed, or normalization seeding failed (the CLI exits 1 then). */
  readonly complete: boolean;
  readonly source_run_id: string | null;
  readonly totals: LinkedInSavedImportReport["totals"];
  readonly normalize_seed_error: string | null;
  readonly invalid: { readonly index: number; readonly reason: string }[];
  readonly duplicates_in_file: { readonly index: number; readonly first_index: number; readonly job_id: string }[];
  readonly items: SavedImportItem[];
}

function gmailMatches(matches: readonly GmailMatchReport[]): SavedImportGmailMatch[] {
  return matches.map((match) => ({
    observation_id: match.observationId,
    processing_status: match.processingStatus,
    outcome: match.outcome,
    fetch_tasks_reactivated: match.fetchTasksReactivated,
    fetch_task_enqueued: match.fetchTaskEnqueued,
  }));
}

export function linkedInImportResponse(report: LinkedInSavedImportReport): SavedImportResponse {
  return {
    ok: true,
    schema_version: SAVED_IMPORT_RESPONSE_SCHEMA,
    source: "LINKEDIN_SAVED",
    mode: report.mode,
    complete: linkedInSavedImportExitCode(report) === 0,
    source_run_id: report.sourceRunId,
    totals: report.totals,
    normalize_seed_error: report.normalizeSeedError,
    invalid: report.invalid.map((item) => ({ index: item.index, reason: item.reason })),
    duplicates_in_file: report.duplicatesInFile.map((item) => ({
      index: item.index,
      first_index: item.firstIndex,
      job_id: item.linkedInJobId,
    })),
    items: report.items.map((item) => ({
      index: item.index,
      job_id: item.linkedInJobId,
      outcome: item.outcome,
      observation_id: item.observationId,
      description_quality: item.descriptionQuality,
      existing_canonical_jobs: item.existingCanonicalJobs,
      gmail_matches: gmailMatches(item.gmailMatches),
      error: item.error ?? null,
    })),
  };
}

export function mcfImportResponse(report: McfSavedImportReport): SavedImportResponse {
  return {
    ok: true,
    schema_version: SAVED_IMPORT_RESPONSE_SCHEMA,
    source: "MCF_SAVED",
    mode: report.mode,
    complete: mcfSavedImportExitCode(report) === 0,
    source_run_id: report.sourceRunId,
    totals: report.totals,
    normalize_seed_error: report.normalizeSeedError,
    invalid: report.invalid.map((item) => ({ index: item.index, reason: item.reason })),
    duplicates_in_file: report.duplicatesInFile.map((item) => ({
      index: item.index,
      first_index: item.firstIndex,
      job_id: item.mcfJobUuid,
    })),
    items: report.items.map((item) => ({
      index: item.index,
      job_id: item.mcfJobUuid,
      outcome: item.outcome,
      observation_id: item.observationId,
      description_quality: item.descriptionQuality,
      existing_canonical_jobs: item.existingCanonicalJobs,
      gmail_matches: gmailMatches(item.gmailMatches),
      error: item.error ?? null,
    })),
  };
}

export interface SavedJobsImportRouterDeps {
  readonly pool: pg.Pool;
  readonly resolveContext: (req: express.Request) => WorkspaceContext;
  /** Defaults to reading config/source-plugins/<key>.yml from the working directory, as the CLI does. */
  readonly loadPlugin?: (pluginKey: string) => Promise<SourcePlugin>;
}

async function loadPluginFromDisk(pluginKey: string): Promise<SourcePlugin> {
  return (await loadStructuredFile(
    path.resolve(process.cwd(), "config", "source-plugins", `${pluginKey}.yml`),
    SourcePluginSchema,
  )).data;
}

/**
 * A dry run executes inside a READ ONLY transaction that is always rolled back,
 * so PostgreSQL itself guarantees it writes nothing.
 */
async function withReadOnlyTransaction<T>(client: pg.PoolClient, work: () => Promise<T>): Promise<T> {
  await client.query("BEGIN TRANSACTION READ ONLY");
  try {
    return await work();
  } finally {
    await client.query("ROLLBACK");
  }
}

interface ImportSpec {
  readonly pluginKey: string;
  readonly label: string;
  run(client: pg.PoolClient, ctx: WorkspaceContext, items: unknown[], dryRun: boolean, plugin: SourcePlugin): Promise<SavedImportResponse>;
}

const SPECS: Record<string, ImportSpec> = {
  "linkedin-saved": {
    pluginKey: LINKEDIN_SAVED_PLUGIN_KEY,
    label: "LinkedIn",
    run: async (client, ctx, items, dryRun, plugin) =>
      linkedInImportResponse(await importLinkedInSavedJobs(client, ctx, parseLinkedInSavedExport(items), { dryRun, plugin })),
  },
  "mcf-saved": {
    pluginKey: MCF_SAVED_PLUGIN_KEY,
    label: "MyCareersFuture",
    run: async (client, ctx, items, dryRun, plugin) =>
      mcfImportResponse(await importMcfSavedJobs(client, ctx, parseMcfSavedExport(items), { dryRun, plugin })),
  },
};

export function createSavedJobsImportRouter(deps: SavedJobsImportRouterDeps): express.Router {
  const router = express.Router();
  const loadPlugin = deps.loadPlugin ?? loadPluginFromDisk;
  router.use(express.json({ limit: SAVED_IMPORT_MAX_BODY_BYTES }));

  for (const [routeKey, spec] of Object.entries(SPECS)) {
    router.post(`/${routeKey}`, (req, res, next) => {
      void (async () => {
        const ctx = deps.resolveContext(req);
        if (ctx.role === "READER") {
          res.status(403).json({ ok: false, error: "FORBIDDEN", message: "A writable workspace role is required to import saved jobs." });
          return;
        }
        const request = ImportRequestSchema.safeParse(req.body);
        if (!request.success) {
          res.status(400).json({
            ok: false,
            error: "INVALID_REQUEST",
            message: "Body must be { items: [...the exported JSON array...], dryRun: true|false }.",
            details: request.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
          });
          return;
        }
        const { items, dryRun } = request.data;
        if (items.length > SAVED_IMPORT_MAX_ITEMS) {
          res.status(413).json({
            ok: false,
            error: "TOO_MANY_ITEMS",
            message: `The export has ${items.length} items; this route accepts at most ${SAVED_IMPORT_MAX_ITEMS} per request. Use npm run import:${routeKey} for a larger file.`,
            limit: SAVED_IMPORT_MAX_ITEMS,
          });
          return;
        }
        const plugin = await loadPlugin(spec.pluginKey);
        const client = await deps.pool.connect();
        try {
          const response = dryRun
            ? await withReadOnlyTransaction(client, () => spec.run(client, ctx, items, true, plugin))
            : await spec.run(client, ctx, items, false, plugin);
          res.json(response);
        } catch (error) {
          if (error instanceof LinkedInSavedExportFileError || error instanceof McfSavedExportFileError) {
            res.status(400).json({ ok: false, error: "INVALID_EXPORT", message: `${spec.label} export: ${error.message}` });
            return;
          }
          throw error;
        } finally {
          client.release();
        }
      })().catch(next);
    });
  }

  router.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    const type = (err as { type?: unknown } | null)?.type;
    if (type === "entity.too.large") {
      res.status(413).json({
        ok: false,
        error: "PAYLOAD_TOO_LARGE",
        message: `The request body is larger than ${SAVED_IMPORT_MAX_BODY_BYTES} bytes.`,
        limit_bytes: SAVED_IMPORT_MAX_BODY_BYTES,
      });
      return;
    }
    if (type === "entity.parse.failed") {
      res.status(400).json({ ok: false, error: "INVALID_JSON", message: "The request body is not valid JSON." });
      return;
    }
    next(err);
  });

  return router;
}
