import crypto from "crypto";
import { ScrapedJob } from "./greenhouse.js";

export async function fetchLeverJobs(companyName: string, boardSlug: string): Promise<ScrapedJob[]> {
  const url = `https://api.lever.co/v0/postings/${boardSlug}`;
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`Failed to fetch Lever board for ${companyName} (${boardSlug}): ${response.status}`);
    return [];
  }
  
  const data = await response.json();
  const jobs: ScrapedJob[] = [];
  
  for (const job of (data || [])) {
    // Construct full description from lists if necessary, or just use description
    let rawDesc = job.description || job.text || "";
    if (job.lists && job.lists.length > 0) {
      for (const list of job.lists) {
        rawDesc += "\\n\\n" + (list.text || "") + "\\n" + list.content;
      }
    }

    const hash = crypto.createHash("sha256").update(rawDesc).digest("hex");
    
    jobs.push({
      company_name: companyName,
      title: job.text,
      source: "lever",
      raw_description: rawDesc,
      location: job.categories?.location || "",
      careers_portal_url: job.hostedUrl,
      posted_date: job.createdAt ? new Date(job.createdAt).toISOString() : undefined,
      content_hash: hash
    });
  }
  
  return jobs;
}
