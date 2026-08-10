import pg from "pg";
import dotenv from "dotenv";
import { db } from "../src/db/db.ts";
import { runDeduplication } from "./deduplicate.ts";

dotenv.config();
dotenv.config({ path: ".env.local" });

const databaseUrl = process.env.DATABASE_URL;

async function ingest65labs() {
  console.log("====================================================");
  console.log("            65LABS AI JOBS INGESTION                ");
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
    const url = "https://www.65labs.org/jobs";
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
    const sections = html.split(/<section class="border-b border-brand-line/);
    sections.shift(); // Remove the page header chunk

    console.log(`Found ${sections.length} company blocks in 65labs HTML.`);
    let insertedCount = 0;

    for (const section of sections) {
      // 1. Extract Company Name
      const companyMatch = section.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
      if (!companyMatch) continue;
      const company = companyMatch[1].trim();

      // 2. Extract Job segments inside this company block
      const jobSegments = section.split(/<div class="grid gap-3 border-t border-brand-line|md:grid-cols-\[minmax\(0,1fr\)_auto\] md:items-center/);
      jobSegments.shift(); // Skip the company description segment

      for (const segment of jobSegments) {
        const titleMatch = segment.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
        const linkMatch = segment.match(/href="([^"]+)"/);
        const locMatch = segment.match(/<p class="mt-1 text-sm text-brand-muted">([\s\S]*?)<\/p>/);

        if (titleMatch && linkMatch) {
          const title = titleMatch[1].trim();
          const applyUrl = linkMatch[1].trim();
          const location = locMatch ? locMatch[1].trim() : "Singapore";

          // Only insert if it is a Singapore-focused role (contains Singapore or is Remote for APAC/Global)
          const isSingapore = location.toLowerCase().includes("singapore") || 
                              location.toLowerCase().includes("remote") ||
                              location.toLowerCase() === "asia" ||
                              location.toLowerCase().includes("apac");

          if (!isSingapore) {
            continue;
          }

          // Use the db singleton helper to add the raw job
          await db.addRawJob({
            company_name: company,
            title: title,
            source: "65labs",
            raw_description: JSON.stringify({
              job_description: `Role sourced from 65labs: ${title} at ${company}. Direct Apply URL: ${applyUrl}`,
              key_responsibilities: [],
              technical_skills: [],
              qualifications_education: [],
              nice_to_haves: []
            }),
            salary_range: undefined,
            location: location,
            posted_date: new Date().toISOString().split("T")[0],
            careers_portal_url: applyUrl
          });
          insertedCount++;
        }
      }
    }

    console.log(`✅ Successfully processed 65labs jobs. Staged ${insertedCount} raw jobs.`);
    
    // Run database deduplication checks to instantly delete duplicate entries
    await runDeduplication();
    
    console.log("\n✅ 65labs Ingestion completed successfully!");
  } catch (err: any) {
    console.error("❌ 65labs ingestion error:", err.message || err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

ingest65labs();
