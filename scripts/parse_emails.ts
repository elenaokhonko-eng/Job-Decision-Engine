import pg from "pg";
import { z } from "zod";
import dotenv from "dotenv";
import crypto from "node:crypto";
import { SourceBroker } from "../src/ingestion/sourceBroker.js";
import {
  extractEmailJobCardsWithLinkSummary,
  EmailExtractionError,
  type CollapsedEmailJobCard,
  type EmailLinkSummary,
} from "../src/ingestion/emailAlertExtractor.js";
import { ExtractedJobSchema, SCHEMA_VERSION } from "../src/contracts/index.js";
import { enqueuePipelineTask } from "../src/tasks/pipelineTasks.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../src/workspace/context.js";
import { pgConnectionConfig } from "../src/db/pgSsl.js";
import {
  buildEmailAlertSelectionQuery,
  DEFAULT_EMAIL_PARSE_MAX_RUNTIME_SECONDS,
  parseEmailParseArguments,
  type EmailParseArguments,
} from "../src/ingestion/emailParserReplay.js";

dotenv.config();
dotenv.config({ path: ".env.local", override: true });

const defaultPool = new pg.Pool(pgConnectionConfig(process.env.DATABASE_URL));

/** A Gmail discovery card is an ExtractedJob whose employer may still be unknown (""). */
const GmailDiscoveryCardSchema = ExtractedJobSchema.extend({ company_name: z.string() });

export interface ParseEmailsSummary {
  parsedEmails: number;
  extractedJobs: number;
  failedEmails: number;
  /**
   * Alerts that decoded but contain no vacancy link (e.g. a non-job email filed under the alerts label).
   * They are recorded as SOURCE_BLOCKED with MISSING_POSTING_URL and do not fail the run on their own.
   */
  noVacancyEmails: number;
  /**
   * True when no-vacancy alerts are at least NO_VACANCY_FUNNEL_MIN_ALERTS and more than half of the decoded
   * alerts: that pattern means the extractor no longer recognises real alerts, so the run fails.
   */
  noVacancyFunnelBroken: boolean;
  /** Link accounting across the alerts that were parsed (staged, blocked or failed); counts only. */
  linksSeen: number;
  nonJobLinksSkipped: number;
  duplicateLinksCollapsed: number;
  /** Selection batches started in this run. */
  batches: number;
  /** Alerts selected but not started because the runtime budget ran out; they stay unprocessed. */
  deferredEmails: number;
  /** Unprocessed alerts left for the next run (includes failed and deferred alerts). */
  remainingBacklog: number;
  stoppedForRuntimeBudget: boolean;
}

export interface ParseEmailsDependencies {
  readonly pool?: pg.Pool;
  readonly log?: (line: string) => void;
  /** Milliseconds clock; injectable so tests can exhaust the runtime budget deterministically. */
  readonly now?: () => number;
}

interface AlertRow {
  readonly id: unknown;
  readonly gmail_message_id: unknown;
  readonly body: unknown;
}

export const NO_VACANCY_FUNNEL_MIN_ALERTS = 3;

/** A run is a broken funnel when most decoded alerts yield no vacancy link (see ParseEmailsSummary). */
export function isNoVacancyFunnelBroken(parsedEmails: number, noVacancyEmails: number): boolean {
  return noVacancyEmails >= NO_VACANCY_FUNNEL_MIN_ALERTS && noVacancyEmails * 2 > parsedEmails + noVacancyEmails;
}

type EmailOutcome =
  | { readonly kind: "STAGED"; readonly links: number; readonly linkSummary: EmailLinkSummary }
  | { readonly kind: "NO_VACANCY"; readonly linkSummary: EmailLinkSummary }
  | { readonly kind: "BLOCKED"; readonly linkSummary: EmailLinkSummary | null }
  | { readonly kind: "FAILED"; readonly linkSummary: EmailLinkSummary };

function linkSummaryPayload(summary: EmailLinkSummary): Record<string, number> {
  return {
    links_seen: summary.linksSeen,
    job_cards: summary.jobCards,
    non_job_links_skipped: summary.nonJobLinksSkipped,
    duplicate_links_collapsed: summary.duplicateLinksCollapsed,
  };
}

function describeLinks(summary: EmailLinkSummary): string {
  return `${summary.linksSeen} link(s) seen, ${summary.jobCards} job card(s), ` +
    `${summary.nonJobLinksSkipped} non-job skipped, ${summary.duplicateLinksCollapsed} duplicate(s) collapsed`;
}

function stableLinkId(url: string): string {
  return crypto.createHash("sha256").update(url, "utf8").digest("hex").slice(0, 32);
}

async function markEmailBlocked(
  client: pg.PoolClient,
  workspaceId: string,
  alertId: string,
  reason: string,
): Promise<void> {
  await client.query(
    "UPDATE raw_email_alerts SET processed = TRUE, lifecycle_status = 'SOURCE_BLOCKED', last_error = $1 WHERE workspace_id = $2 AND id = $3",
    [reason, workspaceId, alertId],
  );
}

/**
 * Stages every vacancy card of one alert in a single transaction. Either all of
 * the alert's observations, their FETCH_PENDING status and fetch tasks commit
 * together with `processed = TRUE`, or nothing does and the alert stays
 * unprocessed for the next run. A process killed mid-alert therefore loses
 * nothing, and re-staging is idempotent (observations conflict on their payload
 * hash and fetch tasks on their task key).
 */
async function stageEmail(
  pool: pg.Pool,
  ctx: WorkspaceContext,
  broker: SourceBroker,
  email: AlertRow,
): Promise<EmailOutcome> {
  const alertId = String(email.id);
  let cards: CollapsedEmailJobCard[];
  let linkSummary: EmailLinkSummary | null = null;
  try {
    const extraction = await extractEmailJobCardsWithLinkSummary(String(email.body ?? ""));
    cards = extraction.cards;
    linkSummary = extraction.links;
    if (cards.length === 0) {
      throw new EmailExtractionError(
        "MISSING_POSTING_URL",
        "MISSING_POSTING_URL: no genuine vacancy link was found in the decoded email (" + describeLinks(extraction.links) + ").",
      );
    }
  } catch (error) {
    const message = error instanceof EmailExtractionError
      ? error.code + ": " + error.message
      : "EMAIL_EXTRACTION_FAILED: " + (error instanceof Error ? error.message : String(error));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await markEmailBlocked(client, ctx.workspaceId, alertId, message);
      await client.query("COMMIT");
    } catch (stageError) {
      await client.query("ROLLBACK");
      throw stageError;
    } finally {
      client.release();
    }
    if (error instanceof EmailExtractionError && error.code === "MISSING_POSTING_URL" && linkSummary) {
      return { kind: "NO_VACANCY", linkSummary };
    }
    broker.recordError(message);
    return { kind: "BLOCKED", linkSummary };
  }
  const extractedLinks: EmailLinkSummary = linkSummary;
  const emailLinkSummary = linkSummaryPayload(extractedLinks);

  const gmailMessageId = email.gmail_message_id ? String(email.gmail_message_id) : null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const observationIds: string[] = [];
    for (const card of cards) {
      const messageIdentity = String(email.gmail_message_id || alertId);
      const sourceExternalId = "gmail-" + messageIdentity + "-" + stableLinkId(card.sourceUrl);
      // A discovery card may not name its employer: it stays "" (never a placeholder)
      // and the posting fetch takes the employer from the employer's own page.
      const validated = GmailDiscoveryCardSchema.safeParse({
        schema_version: SCHEMA_VERSION,
        company_name: card.companyName,
        title: card.title || "Unknown Title",
        location_raw: card.location || "Unknown",
        workplace_type_raw: "UNKNOWN",
        employment_type_raw: "UNKNOWN",
        compensation_raw: "UNKNOWN",
        canonical_apply_url: card.sourceUrl,
        employer_posting_url: card.sourceUrl,
        description_raw: card.descriptionRaw,
      });
      if (!validated.success) {
        throw new Error(
          "Invalid Gmail discovery card: " +
          validated.error.issues.map((issue) => issue.path.join(".") + " " + issue.message).join("; "),
        );
      }

      const job = validated.data;
      const staged = await broker.processObservation(
        {
          sourceName: "GMAIL_ALERT",
          sourceExternalId,
          sourceUrl: card.sourceUrl,
          retrievedAt: new Date().toISOString(),
          companyName: job.company_name,
          title: job.title,
          descriptionRaw: job.description_raw,
          locationRaw: job.location_raw,
          workplaceTypeRaw: job.workplace_type_raw,
          employmentTypeRaw: job.employment_type_raw,
          compensationRaw: job.compensation_raw,
          canonicalApplyUrl: card.sourceUrl,
          sourceLane: "UNKNOWN",
          searchPlanVersion: "1.0",
          rawEmailAlertId: alertId,
          gmailMessageId,
          rawPayload: {
            source_content_status: "DISCOVERY_ONLY",
            raw_email_alert_id: alertId,
            gmail_message_id: gmailMessageId,
            source_url: card.sourceUrl,
            discovered_title: job.title,
            discovered_company: job.company_name,
            ...(card.companySource ? { discovered_company_source: card.companySource } : {}),
            email_context: job.description_raw,
            collapsed_link_count: card.linkCount,
            email_link_summary: emailLinkSummary,
          },
        },
        {
          ...job,
          source_content_status: "DISCOVERY_ONLY",
          raw_email_alert_id: alertId,
          gmail_message_id: gmailMessageId,
          source_url: card.sourceUrl,
          collapsed_link_count: card.linkCount,
          email_link_summary: emailLinkSummary,
          ...(card.companySource ? { discovered_company_source: card.companySource } : {}),
        },
        client,
      );
      if (!staged.observationId) {
        throw new Error("Gmail discovery observation did not receive a durable id.");
      }
      observationIds.push(staged.observationId);

      const taskKey = "FETCH_JOB_CONTENT:" + staged.observationId + ":posting_fetch_v1";
      await enqueuePipelineTask(
        {
          taskType: "FETCH_JOB_CONTENT",
          taskKey,
          payload: { observation_id: staged.observationId },
          maxAttempts: 8,
          producer: "parse_emails",
          stageVersion: "posting_fetch_v1",
          requestId: taskKey,
        },
        client,
        { context: ctx },
      );
    }

    // One status update per alert instead of one database round trip per card.
    const distinctIds = [...new Set(observationIds)];
    const pending = await client.query(
      "UPDATE raw_job_observations SET processing_status = 'FETCH_PENDING' WHERE workspace_id = $1 AND id = ANY($2::uuid[])",
      [ctx.workspaceId, distinctIds],
    );
    if ((pending.rowCount ?? 0) !== distinctIds.length) {
      throw new Error(
        `Gmail discovery marked ${pending.rowCount ?? 0} of ${distinctIds.length} observations FETCH_PENDING.`,
      );
    }

    await client.query(
      "UPDATE raw_email_alerts SET processed = TRUE, lifecycle_status = 'SOURCE_PENDING', last_error = NULL WHERE workspace_id = $1 AND id = $2",
      [ctx.workspaceId, alertId],
    );
    await client.query("COMMIT");
    return { kind: "STAGED", links: observationIds.length, linkSummary: extractedLinks };
  } catch (error) {
    await client.query("ROLLBACK");
    const message = error instanceof Error ? error.message : String(error);
    await client.query(
      "UPDATE raw_email_alerts SET last_error = $1 WHERE workspace_id = $2 AND id = $3",
      [message, ctx.workspaceId, alertId],
    );
    broker.recordError("Email discovery staging failed: " + message);
    return { kind: "FAILED", linkSummary: extractedLinks };
  } finally {
    client.release();
  }
}

/**
 * Runs `worker` over `items` with at most `concurrency` in flight. A thrown
 * (fatal, infrastructure) error stops new items from starting, waits for the
 * in-flight ones to settle, and is then rethrown; it is never swallowed.
 */
async function forEachBounded<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const failures: unknown[] = [];
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (failures.length === 0 && next < items.length) {
      const item = items[next] as T;
      next += 1;
      try {
        await worker(item);
      } catch (error) {
        failures.push(error);
      }
    }
  });
  await Promise.all(lanes);
  if (failures.length > 0) throw failures[0];
}

export async function parseEmails(
  options: Partial<EmailParseArguments> = {},
  dependencies: ParseEmailsDependencies = {},
): Promise<ParseEmailsSummary> {
  const pool = dependencies.pool ?? defaultPool;
  const log = dependencies.log ?? ((line: string) => console.log(line));
  const now = dependencies.now ?? (() => Date.now());
  const replayBlocked = options.replayBlocked === true;
  const batchSize = options.limit ?? 20;
  const concurrency = options.concurrency ?? 4;
  const maxRuntimeSeconds = options.maxRuntimeSeconds ?? DEFAULT_EMAIL_PARSE_MAX_RUNTIME_SECONDS;
  const startedAt = now();
  const deadline = startedAt + maxRuntimeSeconds * 1_000;
  const elapsed = () => ((now() - startedAt) / 1_000).toFixed(1) + "s";

  log(
    "Starting deterministic Gmail job-card extraction " +
    `(batch size ${batchSize}, concurrency ${concurrency}, runtime budget ${maxRuntimeSeconds}s` +
    (replayBlocked ? ", single replay batch" : "") + ").",
  );

  const ctx = await resolveWorkspaceContext(pool as any, {
    ...(options.workspaceKey ? { workspaceKey: options.workspaceKey } : {}),
    ...(options.userKey ? { userKey: options.userKey } : {}),
  });

  const selectionQuery = buildEmailAlertSelectionQuery(replayBlocked, { excludeAttempted: true });
  const attempted: string[] = [];
  let broker: SourceBroker | null = null;
  let batches = 0;
  let parsedEmails = 0;
  let extractedJobs = 0;
  let failedEmails = 0;
  let noVacancyEmails = 0;
  let deferredEmails = 0;
  let linksSeen = 0;
  let nonJobLinksSkipped = 0;
  let duplicateLinksCollapsed = 0;
  let stoppedForRuntimeBudget = false;

  while (true) {
    if (now() >= deadline) {
      stoppedForRuntimeBudget = true;
      break;
    }
    const { rows: emails } = await pool.query<AlertRow>(selectionQuery, [ctx.workspaceId, batchSize, attempted]);
    if (emails.length === 0) break;
    for (const email of emails) attempted.push(String(email.id));

    if (!broker) {
      broker = new SourceBroker(pool, ctx);
      await broker.startRun("EMAIL_DISCOVERY_PARSE");
    }
    const runBroker = broker;
    batches += 1;
    const batch = batches;
    log(`Gmail extraction batch ${batch}: selected ${emails.length} alert(s).`);

    await forEachBounded(emails, concurrency, async (email) => {
      if (now() >= deadline) {
        stoppedForRuntimeBudget = true;
        deferredEmails += 1;
        return;
      }
      const outcome = await stageEmail(pool, ctx, runBroker, email);
      if (outcome.linkSummary) {
        linksSeen += outcome.linkSummary.linksSeen;
        nonJobLinksSkipped += outcome.linkSummary.nonJobLinksSkipped;
        duplicateLinksCollapsed += outcome.linkSummary.duplicateLinksCollapsed;
      }
      const links = outcome.linkSummary ? " [" + describeLinks(outcome.linkSummary) + "]" : "";
      let detail: string;
      if (outcome.kind === "STAGED") {
        parsedEmails += 1;
        extractedJobs += outcome.links;
        detail = `staged ${outcome.links} vacancy link(s)`;
      } else if (outcome.kind === "NO_VACANCY") {
        noVacancyEmails += 1;
        detail = "recorded as SOURCE_BLOCKED (no vacancy link in this email)";
      } else {
        failedEmails += 1;
        detail = outcome.kind === "BLOCKED" ? "blocked (no stageable vacancy link)" : "failed; left unprocessed for retry";
      }
      log(
        `Gmail extraction progress: batch ${batch} alert ${parsedEmails + noVacancyEmails + failedEmails} ${detail}${links}; ` +
        `totals: ${parsedEmails} parsed, ${extractedJobs} links, ${noVacancyEmails} without vacancies, ` +
        `${failedEmails} failed, ${elapsed()} elapsed.`,
      );
    });

    if (replayBlocked || stoppedForRuntimeBudget) break;
  }

  const backlog = await pool.query<{ remaining: number }>(
    "SELECT COUNT(*)::int AS remaining FROM raw_email_alerts WHERE workspace_id = $1 AND processed = FALSE",
    [ctx.workspaceId],
  );
  const remainingBacklog = Number(backlog.rows[0]?.remaining ?? 0);

  if (!broker) {
    log(
      stoppedForRuntimeBudget
        ? `Gmail extraction reached its ${maxRuntimeSeconds}s runtime budget before selecting alerts; ${remainingBacklog} remain queued.`
        : "No eligible email alerts found.",
    );
    return {
      parsedEmails: 0, extractedJobs: 0, failedEmails: 0, noVacancyEmails: 0, noVacancyFunnelBroken: false,
      linksSeen: 0, nonJobLinksSkipped: 0, duplicateLinksCollapsed: 0,
      batches: 0, deferredEmails: 0, remainingBacklog, stoppedForRuntimeBudget,
    };
  }

  const noVacancyFunnelBroken = isNoVacancyFunnelBroken(parsedEmails, noVacancyEmails);
  if (noVacancyFunnelBroken) {
    log(
      `Gmail extraction found no vacancy link in ${noVacancyEmails} of ${parsedEmails + noVacancyEmails} decoded alerts; ` +
      "the extractor may no longer recognise the alert format.",
    );
  }
  await broker.endRun(
    failedEmails === 0 && !noVacancyFunnelBroken ? "COMPLETED" : parsedEmails > 0 ? "DEGRADED" : "FAILED",
  );
  if (stoppedForRuntimeBudget) {
    log(
      `Gmail extraction reached its ${maxRuntimeSeconds}s runtime budget; ${deferredEmails} selected alert(s) were not started. ` +
      "Unprocessed alerts stay queued and the next run resumes them.",
    );
  }
  log(
    "Email discovery complete. Parsed alerts: " + parsedEmails + ", vacancy links staged: " + extractedJobs +
    ", alerts without vacancies: " + noVacancyEmails + ", failed alerts: " + failedEmails + ", links seen: " + linksSeen + ", non-job links skipped: " + nonJobLinksSkipped +
    ", duplicate links collapsed: " + duplicateLinksCollapsed + ", batches: " + batches + ", unprocessed alerts remaining: " + remainingBacklog +
    ", elapsed: " + elapsed(),
  );
  return {
    parsedEmails, extractedJobs, failedEmails, noVacancyEmails, noVacancyFunnelBroken, linksSeen, nonJobLinksSkipped, duplicateLinksCollapsed,
    batches, deferredEmails, remainingBacklog, stoppedForRuntimeBudget,
  };
}

if (process.argv[1] && process.argv[1].includes("parse_emails")) {
  let args: EmailParseArguments | null = null;
  try {
    args = parseEmailParseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
  if (args) {
    void parseEmails(args)
      .then((summary) => {
        if (summary.failedEmails > 0 || summary.noVacancyFunnelBroken) process.exitCode = 1;
      })
      .catch((error) => {
        console.error("Fatal email discovery failure:", error instanceof Error ? error.message : "unknown error");
        process.exitCode = 1;
      })
      .finally(() => defaultPool.end());
  }
}
