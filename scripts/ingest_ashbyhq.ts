import pg from "pg";
import dotenv from "dotenv";
import { db } from "../src/db/db.ts";
import { runDeduplication } from "./deduplicate.ts";

dotenv.config();
dotenv.config({ path: ".env.local" });

const databaseUrl = process.env.DATABASE_URL;

async function ingestAshbyHQ() {
  console.log("====================================================");
  console.log("            ASHBYHQ (PROTEGE) JOBS INGESTION        ");
  console.log("====================================================");

  if (!databaseUrl) {
    console.error("❌ ERROR: Missing DATABASE_URL environment variable.");
    process.exit(1);
  }

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("localhost") ? false : { rejectUnauthorized: false }
  });

  try {
    const url = "https://jobs.ashbyhq.com/protege";
    console.log(`Fetching from ${url}...`);

    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });

    if (!res.ok) {
      throw new Error(`HTTP Error fetching page: ${res.status}`);
    }

    const html = await res.text();
    
    // Extract the window.__appData JSON object
    const appDataMatch = html.match(/window\.__appData\s*=\s*(\{.*?\});/);
    if (!appDataMatch) {
      throw new Error("Could not find window.__appData in the HTML source.");
    }
    
    let appData;
    try {
      appData = JSON.parse(appDataMatch[1]);
    } catch (e) {
      throw new Error("Failed to parse window.__appData JSON");
    }

    const jobPostings = appData?.jobBoard?.jobPostings || [];
    console.log(`Found ${jobPostings.length} total jobs on AshbyHQ (Protege).`);
    
    let insertedCount = 0;

    for (const job of jobPostings) {
      const title = job.title || "Unknown Title";
      const locationName = job.locationName || "Unknown Location";
      const applyUrl = `https://jobs.ashbyhq.com/protege/${job.id}`;
      const company = "Protege"; // Hardcoded as this is Protege's specific Ashby board
      
      // Filter for Singapore or Remote roles
      const isSingapore = locationName.toLowerCase().includes("singapore") || 
                          locationName.toLowerCase().includes("remote") ||
                          locationName.toLowerCase() === "asia" ||
                          locationName.toLowerCase().includes("apac");

      if (!isSingapore) {
        continue;
      }

      // Use the db singleton helper to add the raw job
      await db.addRawJob({
        company_name: company,
        title: title,
        source: "ashbyhq",
        raw_description: JSON.stringify({
          job_description: `Role sourced from AshbyHQ (Protege): ${title}. Location: ${locationName}. Direct Apply URL: ${applyUrl}`,
          key_responsibilities: [],
          technical_skills: [],
          qualifications_education: [],
          nice_to_haves: []
        }),
        salary_range: undefined,
        location: locationName,
        posted_date: new Date().toISOString().split("T")[0],
        careers_portal_url: applyUrl
      });
      insertedCount++;
    }

    console.log(`✅ Successfully processed AshbyHQ (Protege) jobs. Staged ${insertedCount} raw jobs.`);
    
    // Run database deduplication checks to instantly delete duplicate entries
    await runDeduplication();
    
    console.log("\n✅ AshbyHQ Ingestion completed successfully!");
  } catch (err: any) {
    console.error("❌ AshbyHQ ingestion error:", err.message || err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

ingestAshbyHQ();
