import { BaseSourceAdapter, AdapterResult } from "./baseAdapter.js";
import { ExtractedJob, SCHEMA_VERSION } from "../../contracts/index.js";

export class LeverAdapter extends BaseSourceAdapter {
  sourceName = "LEVER";
  private siteToken: string;

  constructor(siteToken: string = "spotify") {
    super();
    this.siteToken = siteToken;
  }

  async fetchJobs(options: { limit?: number; page?: number } = {}): Promise<AdapterResult> {
    const url = `https://api.lever.co/v0/postings/${this.siteToken}?mode=json`;
    try {
      const response = await fetch(url);
      if (response.status === 429) {
        return { sourceName: this.sourceName, success: false, jobs: [], totalFetched: 0, error: "429 Rate limited", isRateLimited: true };
      }
      if (!response.ok) {
        return { sourceName: this.sourceName, success: false, jobs: [], totalFetched: 0, error: `HTTP ${response.status}: ${response.statusText}` };
      }

      const rawJobs = await response.json();
      const jobs: ExtractedJob[] = [];

      for (const item of (Array.isArray(rawJobs) ? rawJobs : []).slice(0, options.limit || 50)) {
        jobs.push({
          schema_version: SCHEMA_VERSION,
          company_name: this.siteToken.toUpperCase(),
          title: item.text || "Unknown Title",
          location_raw: item.categories?.location || "Unknown",
          workplace_type_raw: item.workplaceType || "UNKNOWN",
          employment_type_raw: item.categories?.commitment || "FULL_TIME",
          compensation_raw: "UNKNOWN",
          canonical_apply_url: item.hostedUrl || url,
          description_raw: item.descriptionPlain || item.text || "No description."
        });
      }

      return { sourceName: this.sourceName, success: true, jobs, totalFetched: jobs.length };
    } catch (err: any) {
      return { sourceName: this.sourceName, success: false, jobs: [], totalFetched: 0, error: err.message || String(err) };
    }
  }
}
