import crypto from "crypto";
import { ScrapedJob } from "./greenhouse.js";

export async function fetchStartupJobs(): Promise<ScrapedJob[]> {
  const url = `https://startup.jobs/api/jobs`; // Assumed endpoint
  const headers: Record<string, string> = {
    "Accept": "application/json"
  };
  
  if (process.env.STARTUP_JOBS_API_KEY) {
    headers["Authorization"] = `Bearer ${process.env.STARTUP_JOBS_API_KEY}`;
  }

  try {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      console.error(`Failed to fetch Startup Jobs: ${response.status}`);
      return [];
    }
    
    const data = await response.json();
    const jobs: ScrapedJob[] = [];
    
    for (const job of (data || [])) { // Structure may vary
      const rawDesc = job.description || job.title || "";
      const hash = crypto.createHash("sha256").update(rawDesc).digest("hex");
      
      jobs.push({
        company_name: job.company?.name || "Unknown Startup",
        title: job.title,
        source: "startupjobs",
        raw_description: rawDesc,
        location: job.location || "Remote",
        careers_portal_url: job.url || job.application_url,
        posted_date: job.created_at || job.published_at,
        content_hash: hash
      });
    }
    
    return jobs;
  } catch (e: any) {
    console.error(`StartupJobs fetch failed: ${e.message}`);
    return [];
  }
}
