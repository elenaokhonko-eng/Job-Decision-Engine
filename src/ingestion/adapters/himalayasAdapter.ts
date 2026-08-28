import { BaseSourceAdapter, AdapterResult } from "./baseAdapter.js";
import { ExtractedJob, SCHEMA_VERSION } from "../../contracts/index.js";

export class HimalayasAdapter extends BaseSourceAdapter {
  sourceName = "HIMALAYAS";

  async fetchJobs(options: { limit?: number; page?: number } = {}): Promise<AdapterResult> {
    const url = `https://himalayas.app/jobs/api?limit=${options.limit || 50}`;
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
          company_name: item.companyName || "Unknown Company",
          title: item.title || "Unknown Title",
          location_raw: item.location || "Remote",
          workplace_type_raw: "REMOTE",
          employment_type_raw: "FULL_TIME",
          compensation_raw: item.salary || "UNKNOWN",
          canonical_apply_url: item.applicationUrl || url,
          description_raw: item.description || item.title || "Remote position."
        });
      }

      return { sourceName: this.sourceName, success: true, jobs, totalFetched: jobs.length };
    } catch (err: any) {
      return { sourceName: this.sourceName, success: false, jobs: [], totalFetched: 0, error: err.message || String(err) };
    }
  }
}
