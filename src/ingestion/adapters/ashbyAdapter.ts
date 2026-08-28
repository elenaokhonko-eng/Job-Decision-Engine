import { BaseSourceAdapter, AdapterResult } from "./baseAdapter.js";
import { ExtractedJob, SCHEMA_VERSION } from "../../contracts/index.js";

export class AshbyAdapter extends BaseSourceAdapter {
  sourceName = "ASHBY";
  private orgSlug: string;

  constructor(orgSlug: string = "anthropic") {
    super();
    this.orgSlug = orgSlug;
  }

  async fetchJobs(options: { limit?: number; page?: number } = {}): Promise<AdapterResult> {
    const url = `https://api.ashbyhq.com/posting-api/job-board/${this.orgSlug}`;
    try {
      const response = await fetch(url);
      if (response.status === 429) {
        return { sourceName: this.sourceName, success: false, jobs: [], totalFetched: 0, error: "429 Rate limited", isRateLimited: true };
      }
      if (!response.ok) {
        return { sourceName: this.sourceName, success: false, jobs: [], totalFetched: 0, error: `HTTP ${response.status}: ${response.statusText}` };
      }

      const data = await response.json();
      const rawJobs = data.jobs || [];
      const jobs: ExtractedJob[] = [];

      for (const item of rawJobs.slice(0, options.limit || 50)) {
        jobs.push({
          schema_version: SCHEMA_VERSION,
          company_name: this.orgSlug.toUpperCase(),
          title: item.title || "Unknown Title",
          location_raw: item.location || "Unknown",
          workplace_type_raw: item.isRemote ? "REMOTE" : "HYBRID",
          employment_type_raw: item.employmentType || "FULL_TIME",
          compensation_raw: item.compensation?.text || "UNKNOWN",
          canonical_apply_url: item.jobUrl || url,
          description_raw: item.descriptionHtml || item.title || "No description."
        });
      }

      return { sourceName: this.sourceName, success: true, jobs, totalFetched: jobs.length };
    } catch (err: any) {
      return { sourceName: this.sourceName, success: false, jobs: [], totalFetched: 0, error: err.message || String(err) };
    }
  }
}
