import { BaseSourceAdapter, AdapterResult } from "./baseAdapter.js";
import { ExtractedJob, SCHEMA_VERSION } from "../../contracts/index.js";

export class GreenhouseAdapter extends BaseSourceAdapter {
  sourceName = "GREENHOUSE";
  private boardToken: string;

  constructor(boardToken: string = "databricks") {
    super();
    this.boardToken = boardToken;
  }

  async fetchJobs(options: { limit?: number; page?: number } = {}): Promise<AdapterResult> {
    const url = `https://boards-api.greenhouse.io/v1/boards/${this.boardToken}/jobs?content=true`;
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
          company_name: this.boardToken.toUpperCase(),
          title: item.title || "Unknown Title",
          location_raw: item.location?.name || "Unknown",
          workplace_type_raw: "UNKNOWN",
          employment_type_raw: "FULL_TIME",
          compensation_raw: "UNKNOWN",
          canonical_apply_url: item.absolute_url || url,
          description_raw: item.content || item.title || "No description provided."
        });
      }

      return { sourceName: this.sourceName, success: true, jobs, totalFetched: jobs.length };
    } catch (err: any) {
      return { sourceName: this.sourceName, success: false, jobs: [], totalFetched: 0, error: err.message || String(err) };
    }
  }
}
