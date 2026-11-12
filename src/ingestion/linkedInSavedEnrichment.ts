/**
 * Adds posting facts (posted date, open/closed status with its check time,
 * application deadline) to LinkedIn saved jobs that were imported before the
 * export snippet captured them.
 *
 * Input is a re-exported (or otherwise enriched) `linkedin_saved_jobs.json`.
 * For every item whose LinkedIn job was already imported, the stored export item
 * is reused as is (title, employer, description, location, salary) and only the
 * posting-fact fields come from the new file. The rebuilt item is staged through
 * the normal saved-jobs importer, so it becomes a new LINKEDIN_SAVED observation
 * with its own raw payload hash and normalized evidence (appended, never
 * replacing the earlier observation). Because the description is unchanged,
 * normalization attaches it to the existing job version, whose dates and
 * availability it updates; readiness is then recomputed by the deterministic
 * recommendation decider. Re-running with the same file stages nothing new.
 *
 * Nothing here contacts LinkedIn. Items without any posting fact, and jobs that
 * were never imported, are reported and left alone.
 */
import type pg from "pg";
import { z } from "zod";
import type { SourcePlugin } from "../contracts/sourcePlugin.js";
import { runRecommendationDecider } from "../pipeline/recommendationDecider.js";
import { runNormalization } from "../pipeline/normalize.js";
import type { WorkspaceContext } from "../workspace/context.js";
import { linkedInSavedExternalId } from "./linkedInSavedContent.js";
import {
  LINKEDIN_SAVED_MAX_ITEMS,
  LINKEDIN_SAVED_SOURCE_NAME,
  LinkedInSavedExportFileError,
  LinkedInSavedJobItemSchema,
  linkedInSavedPostingFacts,
  parseLinkedInSavedJobItem,
  type LinkedInSavedExportParseResult,
  type LinkedInSavedJob,
} from "./linkedInSavedExport.js";
import { importLinkedInSavedJobs, type LinkedInSavedImportReport } from "./linkedInSavedImport.js";
import { linkedInJobIdFromUrl } from "./searchApi/searchApiClient.js";

/** Item fields that carry posting facts; every other field comes from the stored import. */
export const LINKEDIN_POSTING_FACT_FIELDS = [
  "postedAt",
  "postedAtText",
  "validThrough",
  "availabilityStatus",
  "availabilityEvidence",
  "postingCheckedAt",
  "postingRecheckFailedAt",
  "postingRecheckFailure",
] as const;

/** Stored export-item fields reused unchanged, so the content (and job version) stays the same. */
const STORED_ITEM_FIELDS = ["title", "company", "url", "description", "descriptionStatus", "location", "salary", "postedAt", "linkedinJobId", "sourcePage"] as const;

/** An enrichment item only needs the job id (url or linkedinJobId) and its posting facts. */
const EnrichmentItemSchema = LinkedInSavedJobItemSchema.partial().strict();

export type EnrichmentOutcome =
  | "WOULD_STAGE"
  | "STAGED"
  | "ALREADY_ENRICHED"
  | "NO_POSTING_FACTS"
  | "NOT_PREVIOUSLY_IMPORTED"
  | "INVALID"
  | "FAILED";

export interface EnrichmentItemReport {
  readonly index: number;
  readonly linkedInJobId: string | null;
  readonly outcome: EnrichmentOutcome;
  readonly reason?: string;
  /** Facts found in the file item (never their values' content beyond the kind). */
  readonly facts: {
    readonly published: "ABSOLUTE_SOURCE_DATE" | "RELATIVE_SOURCE_TEXT" | null;
    readonly reposted: "ABSOLUTE_SOURCE_DATE" | "RELATIVE_SOURCE_TEXT" | null;
    readonly expires: boolean;
    readonly availability: "OPEN" | "CLOSED" | "UNKNOWN";
  };
  /** The file's description differs from the stored one; the stored description is kept. */
  readonly descriptionDiffers: boolean;
  readonly observationId: string | null;
  readonly canonicalJobId: string | null;
  readonly readiness?: { readonly availability: string | null; readonly freshness: string | null };
}

export interface LinkedInSavedEnrichmentPlan {
  readonly total: number;
  readonly parsed: LinkedInSavedExportParseResult;
  readonly items: EnrichmentItemReport[];
}

export interface LinkedInSavedEnrichmentReport {
  readonly mode: "DRY_RUN" | "APPLIED";
  readonly items: EnrichmentItemReport[];
  readonly importReport: LinkedInSavedImportReport | null;
  readonly normalized: number;
  readonly normalizationErrors: number;
  readonly decisionsRun: number;
  readonly decisionErrors: number;
  readonly totals: Record<EnrichmentOutcome, number>;
}

interface StoredSavedObservation {
  readonly id: string;
  readonly raw_payload: Record<string, unknown> | null;
}

const emptyFacts: EnrichmentItemReport["facts"] = { published: null, reposted: null, expires: false, availability: "UNKNOWN" };

function issueText(error: z.ZodError): string {
  return error.issues
    .map((issue) => (issue.code === "unrecognized_keys" ? `unknown field(s): ${issue.keys.join(", ")}` : `${issue.path.join(".") || "item"}: ${issue.message}`))
    .join("; ");
}

function factKinds(job: LinkedInSavedJob): EnrichmentItemReport["facts"] {
  const derivations = (job.postingFacts.payload.date_derivations ?? {}) as Record<string, { basis?: EnrichmentItemReport["facts"]["published"] }>;
  return {
    published: job.postingFacts.publishedAt ? derivations.posted_at?.basis ?? null : null,
    reposted: job.postingFacts.repostedAt ? derivations.reposted_at?.basis ?? null : null,
    expires: job.postingFacts.expiresAt !== null,
    availability: job.postingFacts.availability,
  };
}

async function latestStoredObservation(client: pg.PoolClient, workspaceId: string, linkedInJobId: string): Promise<StoredSavedObservation | null> {
  const { rows } = await client.query<StoredSavedObservation>(
    `SELECT id::text AS id, raw_payload
     FROM raw_job_observations
     WHERE workspace_id = $1
       AND source_name = $2
       AND source_external_id = $3
       AND derived_from_observation_id IS NULL
     ORDER BY retrieved_at DESC, id DESC
     LIMIT 1`,
    [workspaceId, LINKEDIN_SAVED_SOURCE_NAME, linkedInSavedExternalId(linkedInJobId)],
  );
  return rows[0] ?? null;
}

/**
 * Builds the items to stage: each file item's posting facts on top of the
 * latest stored export item for the same LinkedIn job. Read-only.
 */
export async function planLinkedInSavedEnrichment(
  client: pg.PoolClient,
  ctx: WorkspaceContext,
  document: unknown,
): Promise<LinkedInSavedEnrichmentPlan> {
  if (!Array.isArray(document)) throw new LinkedInSavedExportFileError("The enrichment file must be a JSON array of saved jobs.");
  if (document.length === 0) throw new LinkedInSavedExportFileError("The enrichment file contains no saved jobs.");
  if (document.length > LINKEDIN_SAVED_MAX_ITEMS) {
    throw new LinkedInSavedExportFileError(`The enrichment file has ${document.length} items; the limit is ${LINKEDIN_SAVED_MAX_ITEMS}.`);
  }
  const items: EnrichmentItemReport[] = [];
  const valid: LinkedInSavedJob[] = [];
  const invalid: LinkedInSavedExportParseResult["invalid"] = [];
  const seen = new Set<string>();
  for (const [index, value] of document.entries()) {
    const base = { index, descriptionDiffers: false, observationId: null, canonicalJobId: null } as const;
    const parsed = EnrichmentItemSchema.safeParse(value);
    if (!parsed.success) {
      const reason = issueText(parsed.error);
      invalid.push({ index, reason });
      items.push({ ...base, linkedInJobId: null, outcome: "INVALID", reason, facts: emptyFacts });
      continue;
    }
    const item = parsed.data;
    const linkedInJobId = (item.url ? linkedInJobIdFromUrl(item.url) : null) ?? item.linkedinJobId ?? null;
    if (!linkedInJobId || !/^\d{5,20}$/.test(linkedInJobId)) {
      const reason = "no LinkedIn job id: url must contain /jobs/view/<id>, or linkedinJobId must be set";
      invalid.push({ index, reason });
      items.push({ ...base, linkedInJobId: null, outcome: "INVALID", reason, facts: emptyFacts });
      continue;
    }
    if (seen.has(linkedInJobId)) {
      const reason = `LinkedIn job ${linkedInJobId} appears more than once in the file`;
      invalid.push({ index, reason });
      items.push({ ...base, linkedInJobId, outcome: "INVALID", reason, facts: emptyFacts });
      continue;
    }
    seen.add(linkedInJobId);

    const hasFacts = LINKEDIN_POSTING_FACT_FIELDS.some((field) => item[field] !== null && item[field] !== undefined && item[field] !== "UNKNOWN");
    if (!hasFacts) {
      items.push({ ...base, linkedInJobId, outcome: "NO_POSTING_FACTS", reason: "the item has no posted date, deadline or open/closed status", facts: emptyFacts });
      continue;
    }
    const stored = await latestStoredObservation(client, ctx.workspaceId, linkedInJobId);
    const storedItem = stored?.raw_payload && typeof stored.raw_payload.exported_item === "object" && stored.raw_payload.exported_item !== null
      ? stored.raw_payload.exported_item as Record<string, unknown>
      : null;
    if (!stored || !storedItem) {
      items.push({
        ...base,
        linkedInJobId,
        outcome: "NOT_PREVIOUSLY_IMPORTED",
        reason: "no imported LinkedIn saved job with this id; import the file with npm run import:linkedin-saved instead",
        facts: emptyFacts,
      });
      continue;
    }

    const rebuilt: Record<string, unknown> = {};
    for (const field of STORED_ITEM_FIELDS) {
      if (storedItem[field] !== undefined) rebuilt[field] = storedItem[field];
    }
    // The earlier snippet's items had no descriptionStatus; keep reading them as that legacy shape.
    if (stored.raw_payload?.legacy_export_shape === true) delete rebuilt.descriptionStatus;
    for (const field of LINKEDIN_POSTING_FACT_FIELDS) {
      if (item[field] !== null && item[field] !== undefined) rebuilt[field] = item[field];
    }
    const descriptionDiffers = typeof item.description === "string" && item.description.trim() !== ""
      && item.description.trim() !== String(storedItem.description ?? "").trim();

    const job = parseLinkedInSavedJobItem(rebuilt, index);
    if (typeof job === "string") {
      invalid.push({ index, reason: job });
      items.push({ ...base, linkedInJobId, outcome: "INVALID", reason: job, facts: emptyFacts, descriptionDiffers });
      continue;
    }
    const facts = factKinds(job);
    if (Object.keys(job.postingFacts.payload).length === 0) {
      const reason = job.postingFacts.ignored.join("; ") || "no usable posting fact";
      items.push({ ...base, linkedInJobId, outcome: "NO_POSTING_FACTS", reason, facts, descriptionDiffers });
      continue;
    }
    valid.push(job);
    items.push({ ...base, linkedInJobId, outcome: "WOULD_STAGE", facts, descriptionDiffers, observationId: stored.id });
  }
  return {
    total: document.length,
    parsed: { total: document.length, valid, invalid, duplicatesInFile: [] },
    items,
  };
}

async function canonicalJobsForObservations(client: pg.PoolClient, workspaceId: string, observationIds: readonly string[]): Promise<Map<string, string>> {
  if (observationIds.length === 0) return new Map();
  const { rows } = await client.query<{ observation_id: string; canonical_job_id: string }>(
    `SELECT observation.id::text AS observation_id, version.canonical_job_id::text AS canonical_job_id
     FROM raw_job_observations observation
     JOIN job_versions version ON version.workspace_id = observation.workspace_id AND version.id = observation.job_version_id
     WHERE observation.workspace_id = $1 AND observation.id = ANY($2::uuid[])`,
    [workspaceId, observationIds],
  );
  return new Map(rows.map((row) => [row.observation_id, row.canonical_job_id]));
}

async function latestReadiness(client: pg.PoolClient, workspaceId: string, canonicalJobIds: readonly string[]) {
  const result = new Map<string, { availability: string | null; freshness: string | null }>();
  if (canonicalJobIds.length === 0) return result;
  const { rows } = await client.query<{ canonical_job_id: string; availability: string | null; freshness: string | null }>(
    `SELECT DISTINCT ON (decision.canonical_job_id)
            decision.canonical_job_id::text AS canonical_job_id,
            (SELECT check_item->>'status' FROM jsonb_array_elements(decision.readiness_json->'checks') check_item WHERE check_item->>'key' = 'AVAILABILITY' LIMIT 1) AS availability,
            (SELECT check_item->>'status' FROM jsonb_array_elements(decision.readiness_json->'checks') check_item WHERE check_item->>'key' = 'FRESHNESS' LIMIT 1) AS freshness
     FROM deterministic_decisions decision
     WHERE decision.workspace_id = $1 AND decision.canonical_job_id = ANY($2::uuid[])
     ORDER BY decision.canonical_job_id, decision.created_at DESC, decision.id DESC`,
    [workspaceId, canonicalJobIds],
  );
  for (const row of rows) result.set(row.canonical_job_id, { availability: row.availability, freshness: row.freshness });
  return result;
}

/**
 * Dry run (default): reports what would be staged and writes nothing. Applied:
 * stages through the saved-jobs importer, normalizes the staged observations
 * onto their job versions and recomputes readiness for those canonical jobs.
 */
export async function runLinkedInSavedEnrichment(
  client: pg.PoolClient,
  ctx: WorkspaceContext,
  plan: LinkedInSavedEnrichmentPlan,
  options: { readonly dryRun: boolean; readonly plugin: SourcePlugin; readonly now?: () => Date },
): Promise<LinkedInSavedEnrichmentReport> {
  let items = plan.items;
  let importReport: LinkedInSavedImportReport | null = null;
  let normalized = 0;
  let normalizationErrors = 0;
  let decisionsRun = 0;
  let decisionErrors = 0;

  if (plan.parsed.valid.length > 0) {
    importReport = await importLinkedInSavedJobs(client, ctx, plan.parsed, {
      dryRun: options.dryRun,
      plugin: options.plugin,
      ...(options.now ? { now: options.now } : {}),
    });
    const byIndex = new Map(importReport.items.map((item) => [item.index, item]));
    items = items.map((item) => {
      const staged = byIndex.get(item.index);
      if (!staged || item.outcome !== "WOULD_STAGE") return item;
      if (staged.outcome === "FAILED") return { ...item, outcome: "FAILED", reason: staged.error ?? "staging failed", observationId: null };
      if (staged.outcome === "ALREADY_IMPORTED" || staged.outcome === "WOULD_SKIP_ALREADY_IMPORTED") {
        return { ...item, outcome: "ALREADY_ENRICHED", observationId: staged.observationId };
      }
      return { ...item, outcome: options.dryRun ? "WOULD_STAGE" : "STAGED", observationId: staged.observationId ?? item.observationId };
    });
  }

  if (!options.dryRun && importReport) {
    const observationIds = items
      .filter((item) => (item.outcome === "STAGED" || item.outcome === "ALREADY_ENRICHED") && item.observationId)
      .map((item) => item.observationId as string);
    if (observationIds.length > 0) {
      // The importer also seeded NORMALIZE_OBSERVATION tasks; once this run maps the
      // observations to their versions, those tasks complete as no-ops in the worker.
      const summary = await runNormalization(client, { context: ctx, observationIds, limit: observationIds.length });
      normalized = summary.totalProcessed;
      normalizationErrors = summary.totalErrors;
      const canonicalByObservation = await canonicalJobsForObservations(client, ctx.workspaceId, observationIds);
      const canonicalJobIds = [...new Set(canonicalByObservation.values())];
      if (canonicalJobIds.length > 0) {
        const decided = await runRecommendationDecider(client, { context: ctx, canonicalJobIds });
        decisionsRun = decided.updated;
        decisionErrors = decided.errors;
      }
      const readiness = await latestReadiness(client, ctx.workspaceId, canonicalJobIds);
      items = items.map((item) => {
        const canonicalJobId = item.observationId ? canonicalByObservation.get(item.observationId) ?? null : null;
        return canonicalJobId ? { ...item, canonicalJobId, readiness: readiness.get(canonicalJobId) ?? { availability: null, freshness: null } } : item;
      });
    }
  }

  const totals = Object.fromEntries(
    (["WOULD_STAGE", "STAGED", "ALREADY_ENRICHED", "NO_POSTING_FACTS", "NOT_PREVIOUSLY_IMPORTED", "INVALID", "FAILED"] as const)
      .map((outcome) => [outcome, items.filter((item) => item.outcome === outcome).length]),
  ) as Record<EnrichmentOutcome, number>;
  return {
    mode: options.dryRun ? "DRY_RUN" : "APPLIED",
    items,
    importReport,
    normalized,
    normalizationErrors,
    decisionsRun,
    decisionErrors,
    totals,
  };
}

/** Invariant 7: invalid or failed items, normalization errors or decider errors fail the command. */
export function linkedInSavedEnrichmentExitCode(report: LinkedInSavedEnrichmentReport): number {
  return report.totals.INVALID > 0
    || report.totals.FAILED > 0
    || report.normalizationErrors > 0
    || report.decisionErrors > 0
    || (report.importReport?.normalizeSeedError ?? null) !== null
    ? 1
    : 0;
}
