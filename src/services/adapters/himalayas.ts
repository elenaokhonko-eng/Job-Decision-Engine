import crypto from "crypto";
import { ScrapedJob } from "./greenhouse.js";

export async function fetchHimalayasJobs(): Promise<ScrapedJob[]> {
  const url = `https://himalayas.app/jobs/api?limit=100`; // Adjust parameters as needed
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`Failed to fetch Himalayas jobs: ${response.status}`);
    return [];
  }
  
  const data = await response.json();
  const jobs: ScrapedJob[] = [];
  
  for (const job of (data.jobs || [])) {
    const rawDesc = job.description || job.title || "";
    const hash = crypto.createHash("sha256").update(rawDesc).digest("hex");
    
    jobs.push({
      company_name: job.companyName,
      title: job.title,
      source: "himalayas",
      raw_description: rawDesc,
      location: job.location || "Remote",
      careers_portal_url: job.applicationLink,
      posted_date: job.pubDate ? new Date(job.pubDate).toISOString() : undefined,
      content_hash: hash
    });
  }
  
  return jobs;
}
