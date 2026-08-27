import crypto from "crypto";

export interface ScrapedJob {
  company_name: string;
  title: string;
  source: string;
  raw_description: string;
  location?: string;
  careers_portal_url: string;
  posted_date?: string;
  content_hash?: string;
}

export async function fetchGreenhouseJobs(companyName: string, boardSlug: string): Promise<ScrapedJob[]> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${boardSlug}/jobs?content=true`;
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`Failed to fetch Greenhouse board for ${companyName} (${boardSlug}): ${response.status}`);
    return [];
  }
  
  const data = await response.json();
  const jobs: ScrapedJob[] = [];
  
  for (const job of (data.jobs || [])) {
    // Strip HTML from description if possible, or leave raw
    const rawDesc = job.content || job.title || "";
    const hash = crypto.createHash("sha256").update(rawDesc).digest("hex");
    
    jobs.push({
      company_name: companyName,
      title: job.title,
      source: "greenhouse",
      raw_description: rawDesc,
      location: job.location?.name || "",
      careers_portal_url: job.absolute_url,
      posted_date: job.updated_at,
      content_hash: hash
    });
  }
  
  return jobs;
}
