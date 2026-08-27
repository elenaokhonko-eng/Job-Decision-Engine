import { db } from "../src/db/db.js";
import pg from "pg";
import dotenv from "dotenv";
import { SourceBroker } from "../src/ingestion/sourceBroker.js";
import { callLLM } from "../src/services/agent.js"; // or getGeminiClient directly

dotenv.config();
dotenv.config({ path: ".env.local" });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && (process.env.DATABASE_URL.includes("localhost") || process.env.DATABASE_URL.includes("127.0.0.1")) ? false : { rejectUnauthorized: false }
});

async function parseEmails() {
  console.log("====================================================");
  console.log("         STAGE 0: EMAIL PARSING SCOUT               ");
  console.log("====================================================");

  const { rows: emails } = await pool.query(
    `SELECT id, subject, body FROM raw_email_alerts WHERE processed = FALSE ORDER BY id ASC LIMIT 20`
  );

  if (emails.length === 0) {
    console.log("No unprocessed email alerts found.");
    process.exit(0);
  }

  console.log(`Found ${emails.length} unprocessed email alerts. Parsing via LLM...`);

  const broker = new SourceBroker();
  await broker.startRun("EMAIL_PARSER_RUN");

  for (const email of emails) {
    console.log(`\nParsing email: "${email.subject}"`);
    
    const prompt = `
      You are an expert recruitment parser. Extract all individual job listings from this job alert email.
      Return the output strictly as a JSON object matching this schema:
      {
        "jobs": [
          {
            "companyName": "Name of the company",
            "title": "Job title",
            "descriptionRaw": "A brief summary or the raw text snippet provided for the job",
            "url": "The link to apply or view the job"
          }
        ]
      }
      If no jobs are found, return {"jobs": []}.
      
      Email Subject: ${email.subject}
      Email Body:
      ${email.body}
    `;

    try {
      // Use callLLM("evaluate") which routes to gemini.
      const responseText = await callLLM("evaluate", prompt);
      
      // Clean up json formatting if present
      let cleaned = responseText.trim();
      if (cleaned.startsWith("```json")) {
        cleaned = cleaned.replace(/^```json\s*/, "").replace(/\s*```$/, "");
      } else if (cleaned.startsWith("```")) {
        cleaned = cleaned.replace(/^```\s*/, "").replace(/\s*```$/, "");
      }
      
      const parsed = JSON.parse(cleaned);
      const jobs = parsed.jobs || [];
      
      console.log(`-> Extracted ${jobs.length} jobs.`);
      
      for (const job of jobs) {
        if (!job.companyName || !job.title) continue;
        
        await broker.processObservation({
          sourceName: "email_alert",
          sourceExternalId: `email-${email.id}-${job.title}`,
          sourceUrl: job.url || "",
          retrievedAt: new Date().toISOString(),
          companyName: job.companyName,
          title: job.title,
          descriptionRaw: job.descriptionRaw || email.subject,
          sourceLane: "UNKNOWN",
          searchPlanVersion: "1.0",
          rawPayload: job
        }, job);
      }

      await pool.query(
        `UPDATE raw_email_alerts SET processed = TRUE WHERE id = $1`,
        [email.id]
      );

    } catch (err: any) {
      console.error(`❌ Failed to parse email ${email.id}:`, err.message);
    }
  }

  await broker.endRun();
  console.log("\n✅ Email parsing complete.");
  process.exit(0);
}

parseEmails();
