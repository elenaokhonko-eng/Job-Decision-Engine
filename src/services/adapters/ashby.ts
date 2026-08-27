import crypto from "crypto";
import { ScrapedJob } from "./greenhouse.js";

export async function fetchAshbyJobs(companyName: string, boardSlug: string): Promise<ScrapedJob[]> {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${boardSlug}`;
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`Failed to fetch Ashby board for ${companyName} (${boardSlug}): ${response.status}`);
    return [];
  }
  
  const data = await response.json();
  const jobs: ScrapedJob[] = [];
  
  for (const job of (data.jobs || [])) {
    const rawDesc = job.descriptionHtml || job.title || "";
    const hash = crypto.createHash("sha256").update(rawDesc).digest("hex");
    
    jobs.push({
      company_name: companyName,
      title: job.title,
      source: "ashby",
      raw_description: rawDesc,
      location: job.location || "",
      careers_portal_url: job.jobUrl,
      posted_date: job.publishedAt,
      content_hash: hash
    });
  }
  
  return jobs;
}
