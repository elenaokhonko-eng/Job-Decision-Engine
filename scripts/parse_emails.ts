import pg from "pg";
import dotenv from "dotenv";
import crypto from "node:crypto";
import { SourceBroker } from "../src/ingestion/sourceBroker.js";
import { extractEmailJobCards, EmailExtractionError } from "../src/ingestion/emailAlertExtractor.js";
import { ExtractedJobSchema, SCHEMA_VERSION } from "../src/contracts/index.js";
import { enqueuePipelineTask } from "../src/tasks/pipelineTasks.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";
import { pgConnectionConfig } from "../src/db/pgSsl.js";
import {
  buildEmailAlertSelectionQuery,
  parseEmailParseArguments,
  type EmailParseArguments,
} from "../src/ingestion/emailParserReplay.js";

dotenv.config();
dotenv.config({ path: ".env.local", override: true });

const pool = new pg.Pool(pgConnectionConfig(process.env.DATABASE_URL));

export interface ParseEmailsSummary {
  parsedEmails: number;
  extractedJobs: number;
  failedEmails: number;
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

export async function parseEmails(options: Partial<EmailParseArguments> = {}): Promise<ParseEmailsSummary> {
  console.log("Starting deterministic Gmail job-card extraction.");

  const ctx = await resolveWorkspaceContext(pool as any, {
    ...(options.workspaceKey ? { workspaceKey: options.workspaceKey } : {}),
    ...(options.userKey ? { userKey: options.userKey } : {}),
  });
  const { rows: emails } = await pool.query(
    buildEmailAlertSelectionQuery(options.replayBlocked === true),
    [ctx.workspaceId, options.limit ?? 20],
  );

  if (emails.length === 0) {
    console.log("No eligible email alerts found.");
    return { parsedEmails: 0, extractedJobs: 0, failedEmails: 0 };
  }

  const broker = new SourceBroker(pool, ctx);
  await broker.startRun("EMAIL_DISCOVERY_PARSE");
  let parsedEmails = 0;
  let extractedJobs = 0;
  let failedEmails = 0;

  for (const email of emails) {
    const alertId = String(email.id);
    let cards;
    try {
      cards = await extractEmailJobCards(String(email.body ?? ""));
      if (cards.length === 0) {
        throw new EmailExtractionError(
          "MISSING_POSTING_URL",
          "MISSING_POSTING_URL: no genuine vacancy link was found in the decoded email.",
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
      broker.recordError(message);
      failedEmails += 1;
      continue;
    }

    const client = await pool.connect();
    let stagedForEmail = 0;
    try {
      await client.query("BEGIN");
      for (const card of cards) {
        const messageIdentity = String(email.gmail_message_id || alertId);
        const sourceExternalId = "gmail-" + messageIdentity + "-" + stableLinkId(card.sourceUrl);
        const validated = ExtractedJobSchema.safeParse({
          schema_version: SCHEMA_VERSION,
          company_name: card.companyName || "Unknown Company",
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
            gmailMessageId: email.gmail_message_id ? String(email.gmail_message_id) : null,
            rawPayload: {
              source_content_status: "DISCOVERY_ONLY",
              raw_email_alert_id: alertId,
              gmail_message_id: email.gmail_message_id ? String(email.gmail_message_id) : null,
              source_url: card.sourceUrl,
              discovered_title: job.title,
              discovered_company: job.company_name,
              email_context: job.description_raw,
            },
          },
          {
            ...job,
            source_content_status: "DISCOVERY_ONLY",
            raw_email_alert_id: alertId,
            gmail_message_id: email.gmail_message_id ? String(email.gmail_message_id) : null,
            source_url: card.sourceUrl,
          },
          client,
        );
        if (!staged.observationId) {
          throw new Error("Gmail discovery observation did not receive a durable id.");
        }

        await client.query(
          "UPDATE raw_job_observations SET processing_status = 'FETCH_PENDING' WHERE workspace_id = $1 AND id = $2",
          [ctx.workspaceId, staged.observationId],
        );

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
        stagedForEmail += 1;
      }

      await client.query(
        "UPDATE raw_email_alerts SET processed = TRUE, lifecycle_status = 'SOURCE_PENDING', last_error = NULL WHERE workspace_id = $1 AND id = $2",
        [ctx.workspaceId, alertId],
      );
      await client.query("COMMIT");
      parsedEmails += 1;
      extractedJobs += stagedForEmail;
    } catch (error) {
      await client.query("ROLLBACK");
      const message = error instanceof Error ? error.message : String(error);
      await client.query(
        "UPDATE raw_email_alerts SET last_error = $1 WHERE workspace_id = $2 AND id = $3",
        [message, ctx.workspaceId, alertId],
      );
      broker.recordError("Email discovery staging failed: " + message);
      failedEmails += 1;
    } finally {
      client.release();
    }
  }

  await broker.endRun(failedEmails === 0 ? "COMPLETED" : parsedEmails > 0 ? "DEGRADED" : "FAILED");
  console.log("Email discovery complete. Parsed alerts: " + parsedEmails + ", vacancy links staged: " + extractedJobs + ", failed alerts: " + failedEmails);
  return { parsedEmails, extractedJobs, failedEmails };
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
        if (summary.failedEmails > 0) process.exitCode = 1;
      })
      .catch((error) => {
        console.error("Fatal email discovery failure:", error instanceof Error ? error.message : "unknown error");
        process.exitCode = 1;
      })
      .finally(() => pool.end());
  }
}
