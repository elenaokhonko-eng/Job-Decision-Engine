import pg from "pg";
import dotenv from "dotenv";
import { getGeminiClient, runAgent } from "../src/services/agent.ts";
import { db } from "../src/db/db.ts";

dotenv.config();
dotenv.config({ path: ".env.local" });

const databaseUrl = process.env.DATABASE_URL;

const pool = new pg.Pool({
  connectionString: databaseUrl,
  ssl: databaseUrl && (databaseUrl.includes("localhost") || databaseUrl.includes("127.0.0.1")) ? false : { rejectUnauthorized: false }
});

async function runPipeline() {
  console.log("====================================================");
  console.log("      JOB DESCRIPTION PARSING & EVALUATION PIPELINE  ");
  console.log("====================================================");

  if (!databaseUrl) {
    console.error("❌ ERROR: DATABASE_URL environment variable is missing.");
    process.exit(1);
  }

  try {
    // 1. Fetch unprocessed raw email alerts
    console.log("Querying database for unprocessed raw email alerts...");
    const emailRes = await pool.query(
      "SELECT id, subject, body FROM raw_email_alerts WHERE processed = FALSE ORDER BY received_at ASC"
    );
    console.log(`Found ${emailRes.rows.length} unprocessed email alerts.`);

    if (emailRes.rows.length > 0) {
      const ai = getGeminiClient();

      for (const alert of emailRes.rows) {
        console.log(`\nParsing email: "${alert.subject}" (ID: ${alert.id})`);
        
        const parsePrompt = `You are a high-fidelity data extraction agent. 
Analyze the following email body (which contains job alerts) and extract every individual job advertisement.

Email Subject: ${alert.subject}
Email Body:
${alert.body}

Format the output as a valid JSON object matching this schema. Make sure you extract all jobs.
Schema:
{
  "jobs": [
    {
      "title": "string",
      "company": "string",
      "source": "LinkedIn | MyCareersFuture | eFinancialCareers | Gmail",
      "salaryRange": "string (optional, e.g. SGD 15,000 - SGD 20,000)",
      "location": "string (optional, e.g. Singapore (Remote))",
      "careers_portal_url": "string (Mandatory. Highly realistic corporate careers page URL if not present in email, e.g. https://www.novartis.com/careers)",
      "description": "Full details, requirements, and responsibilities parsed from the email text."
    }
  ]
}
Return nothing other than the JSON block.`;

        try {
          const response = await ai.models.generateContent({
            model: "gemini-3.5-flash",
            contents: parsePrompt,
            config: {
              responseMimeType: "application/json"
            }
          });

          let rawText = response.text || "{}";
          if (rawText.startsWith("```json")) {
            rawText = rawText.replace(/^```json\s*/, "").replace(/\s*```$/, "");
          } else if (rawText.startsWith("```")) {
            rawText = rawText.replace(/^```\s*/, "").replace(/\s*```$/, "");
          }

          const parsed = JSON.parse(rawText);
          const jobsList = parsed.jobs || [];
          console.log(`Extracted ${jobsList.length} jobs from email alert.`);

          for (const rawJob of jobsList) {
            // Insert job in DB as UNASSIGNED
            const newJob = await db.addJob({
              title: rawJob.title,
              company: rawJob.company,
              source: rawJob.source || "Gmail",
              description: rawJob.description,
              salaryRange: rawJob.salaryRange || undefined,
              location: rawJob.location || "Singapore",
              careers_portal_url: rawJob.careers_portal_url || `https://www.${rawJob.company.toLowerCase().replace(/[^a-z0-9]/g, "")}.com/careers`,
              postedDate: new Date().toISOString().split("T")[0],
              status: "UNASSIGNED"
            });
            console.log(`  -> Inserted unassigned job: "${newJob.title}" at ${newJob.company}`);
          }

          // Mark email alert as processed
          await pool.query(
            "UPDATE raw_email_alerts SET processed = TRUE, processed_at = NOW() WHERE id = $1",
            [alert.id]
          );
          console.log(`Marked email alert ${alert.id} as processed.`);

        } catch (err: any) {
          console.error(`❌ Failed to parse email alert ${alert.id}:`, err.message || err);
        }
      }
    }

    // 2. Fetch and evaluate UNASSIGNED jobs in database
    console.log("\nQuerying database for UNASSIGNED jobs to evaluate...");
    const jobs = await db.queryJobs();
    const unassignedJobs = jobs.filter(j => j.status === "UNASSIGNED");
    console.log(`Found ${unassignedJobs.length} UNASSIGNED jobs.`);

    if (unassignedJobs.length > 0) {
      for (const job of unassignedJobs) {
        console.log(`\nEvaluating job: "${job.title}" at "${job.company}"`);
        
        const evalQuery = `Evaluate job advertisement: "${job.title}" at "${job.company}". 
        Location: ${job.location || "Singapore"}. 
        Salary Range: ${job.salaryRange || "Not specified"}. 
        Description: ${job.description}`;

        try {
          const { result } = await runAgent(evalQuery);
          const evalResult = result.evaluated_jobs?.[0];
          if (evalResult) {
            console.log(`  -> Complete: Score = ${evalResult.total_score}/100, Status = ${evalResult.status}, Track = ${evalResult.assigned_track}`);
          } else {
            console.log("  -> Complete (warnings: no evaluation details returned in payload)");
          }
        } catch (err: any) {
          console.error(`❌ Evaluation failed for job ID ${job.id}:`, err.message || err);
        }
      }
    }

    console.log("\n✅ Pipeline completed successfully!");

  } catch (err: any) {
    console.error("❌ Fatal pipeline failure:", err.message || err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runPipeline();
