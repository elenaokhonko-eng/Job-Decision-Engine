import pg from "pg";
import dotenv from "dotenv";
import { SourceBroker } from "../src/ingestion/sourceBroker.js";
import { generateContent, MODEL_REGISTRY } from "../src/services/agent.js";
import { ExtractedJobSchema, SCHEMA_VERSION } from "../src/contracts/index.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.DATABASE_URL &&
    (process.env.DATABASE_URL.includes("localhost") || process.env.DATABASE_URL.includes("127.0.0.1"))
      ? false
      : { rejectUnauthorized: true }
});

export async function parseEmails(): Promise<{ parsedEmails: number; extractedJobs: number; failedEmails: number }> {
  console.log("====================================================");
  console.log("         STAGE 0: EMAIL PARSING SCOUT               ");
  console.log("====================================================");

  const { rows: emails } = await pool.query(
    `SELECT id, gmail_message_id, subject, body FROM raw_email_alerts WHERE processed = FALSE ORDER BY id ASC LIMIT 20`
  );

  if (emails.length === 0) {
    console.log("No unprocessed email alerts found.");
    return { parsedEmails: 0, extractedJobs: 0, failedEmails: 0 };
  }

  console.log(`Found ${emails.length} unprocessed email alerts. Parsing via LLM...`);

  const broker = new SourceBroker();
  await broker.startRun("EMAIL_PARSER_RUN");

  let parsedEmails = 0;
  let extractedJobs = 0;
  let failedEmails = 0;

  for (const email of emails) {
    console.log(`\nParsing email #${email.id} (${email.gmail_message_id || "no-uid"}): "${email.subject}"`);

    const prompt = `
      You are an expert recruitment parser. Extract all individual job listings from this job alert email.
      Return the output strictly as a JSON object matching this schema:
      {
        "jobs": [
          {
            "company_name": "Name of the company",
            "title": "Job title",
            "location_raw": "Location string if specified or 'Unknown'",
            "workplace_type_raw": "REMOTE | HYBRID | ONSITE | UNKNOWN",
            "employment_type_raw": "FULL_TIME | CONTRACT | UNKNOWN",
            "compensation_raw": "Compensation string if specified or 'UNKNOWN'",
            "canonical_apply_url": "Direct application or view URL",
            "description_raw": "Full text snippet or description of the role"
          }
        ]
      }
      If no jobs are found, return {"jobs": []}.

      Email Subject: ${email.subject}
      Email Body:
      ${email.body.substring(0, 15000)}
    `;

    const dbClient = await pool.connect();
    let emailSucceeded = false;
    let emailJobsStaged = 0;
    const emailErrors: string[] = [];

    try {
      const responseText = await generateContent({
        model: MODEL_REGISTRY.DOCUMENT_PRIMARY_MODEL,
        contents: prompt,
        responseMimeType: "application/json"
      });

      let cleaned = responseText.trim();
      if (cleaned.startsWith("```json")) {
        cleaned = cleaned.replace(/^```json\s*/, "").replace(/\s*```$/, "");
      } else if (cleaned.startsWith("```")) {
        cleaned = cleaned.replace(/^```\s*/, "").replace(/\s*```$/, "");
      }

      const parsed = JSON.parse(cleaned);
      const rawJobs = parsed.jobs || [];
      console.log(`-> Extracted ${rawJobs.length} raw jobs from email #${email.id}.`);

      // Stage ALL jobs in a single transaction; roll back if ANY fail
      await dbClient.query("BEGIN");

      try {
        for (const rawJob of rawJobs) {
          const validated = ExtractedJobSchema.safeParse({
            schema_version: SCHEMA_VERSION,
            company_name: rawJob.company_name || rawJob.companyName || "Unknown Company",
            title: rawJob.title || "Unknown Title",
            location_raw: rawJob.location_raw || rawJob.locationRaw || "Unknown",
            workplace_type_raw: rawJob.workplace_type_raw || rawJob.workplaceTypeRaw || "UNKNOWN",
            employment_type_raw: rawJob.employment_type_raw || rawJob.employmentTypeRaw || "UNKNOWN",
            compensation_raw: rawJob.compensation_raw || rawJob.compensationRaw || "UNKNOWN",
            canonical_apply_url: rawJob.canonical_apply_url || rawJob.url || `https://email-alert.internal/${email.id}`,
            description_raw: rawJob.description_raw || rawJob.descriptionRaw || email.subject
          });

          if (!validated.success) {
            // Schema validation failure is a structured error — accumulate it
            const msg = `Schema validation failed for job "${rawJob.title}": ${validated.error.message}`;
            console.warn(`⚠️ ${msg}`);
            emailErrors.push(msg);
            broker.recordError(msg);
            continue;
          }

          const job = validated.data;
          // processObservation now executes on dbClient — rolled back if transaction fails
          await broker.processObservation(
            {
              sourceName: "GMAIL_ALERT",
              sourceExternalId: `gmail-${email.gmail_message_id || email.id}-${job.title}`,
              sourceUrl: job.canonical_apply_url,
              retrievedAt: new Date().toISOString(),
              companyName: job.company_name,
              title: job.title,
              descriptionRaw: job.description_raw,
              locationRaw: job.location_raw,
              workplaceTypeRaw: job.workplace_type_raw,
              employmentTypeRaw: job.employment_type_raw,
              compensationRaw: job.compensation_raw,
              canonicalApplyUrl: job.canonical_apply_url,
              sourceLane: "UNKNOWN",
              searchPlanVersion: "1.0",
              rawPayload: job
            },
            job,
            dbClient
          );
          emailJobsStaged++;
        }

        if (emailErrors.length > 0) {
          throw new Error(`Schema validation failed for ${emailErrors.length} extracted job(s).`);
        }

        // Only mark processed = TRUE when all staging succeeded
        await dbClient.query(
          `UPDATE raw_email_alerts SET processed = TRUE, last_error = NULL WHERE id = $1`,
          [email.id]
        );

        await dbClient.query("COMMIT");
        emailSucceeded = true;
        extractedJobs += emailJobsStaged;
        parsedEmails++;
      } catch (stageErr: any) {
        await dbClient.query("ROLLBACK");
        // Mark with error but do NOT set processed = TRUE — email will be retried
        await dbClient.query(
          `UPDATE raw_email_alerts SET last_error = $1 WHERE id = $2`,
          [stageErr.message, email.id]
        );
        throw stageErr;
      }
    } catch (err: any) {
      if (!emailSucceeded) {
        failedEmails++;
        const message = err.message || String(err);
        broker.recordError(`Email ${email.id}: ${message}`);
        console.error(`❌ Failed to parse or stage email ${email.id}:`, message);
      }
    } finally {
      dbClient.release();
    }
  }

  await broker.endRun(
    failedEmails === 0 ? "COMPLETED" : parsedEmails > 0 ? "DEGRADED" : "FAILED"
  );
  console.log(`\n✅ Email parsing complete. Parsed: ${parsedEmails}, Jobs: ${extractedJobs}, Failed: ${failedEmails}`);
  return { parsedEmails, extractedJobs, failedEmails };
}

if (process.argv[1] && process.argv[1].includes("parse_emails")) {
  parseEmails()
    .then((res) => {
      if (res.failedEmails > 0) {
        process.exit(1);
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error("Fatal email parsing error:", err);
      process.exit(1);
    });
}
