import { BaseSourceAdapter, AdapterResult } from "./baseAdapter.js";
import { ExtractedJob, SCHEMA_VERSION } from "../../contracts/index.js";

export class LeverAdapter extends BaseSourceAdapter {
  sourceName = "LEVER" as const;
  private siteToken: string;

  constructor(siteToken: string = "spotify") {
    super();
    this.siteToken = siteToken;
    this.timeoutMs = 15_000;
  }

  async fetchJobs(options: { limit?: number; page?: number } = {}): Promise<AdapterResult> {
    const url = `https://api.lever.co/v0/postings/${this.siteToken}?mode=json`;
    try {
      const response = await this.fetchWithTimeout(url);

      if (response.status === 429) {
        return this.errorResult("429 Rate limited", { isRateLimited: true });
      }
      if (!response.ok) {
        return this.errorResult(`HTTP ${response.status}: ${response.statusText}`);
      }

      const rawJobs = await response.json();
      const jobs: ExtractedJob[] = [];
      let quarantined = 0;

      for (const item of (Array.isArray(rawJobs) ? rawJobs : []).slice(0, options.limit || 50)) {
        const candidate = {
          schema_version: SCHEMA_VERSION,
          company_name: this.siteToken.toUpperCase(),
          title: item.text || "Unknown Title",
          location_raw: item.categories?.location || "Unknown",
          workplace_type_raw: item.workplaceType || "UNKNOWN",
          employment_type_raw: item.categories?.commitment || "FULL_TIME",
          compensation_raw: "UNKNOWN",
          canonical_apply_url: item.hostedUrl || url,
          description_raw: item.descriptionPlain || item.text || "No description.",
        };

        const validated = this.validateJob(candidate, item.id || item.text);
        if (validated) {
          jobs.push(validated);
        } else {
          quarantined++;
        }
      }

      return { sourceName: this.sourceName, success: true, jobs, totalFetched: jobs.length, quarantined };
    } catch (err: any) {
      const isTimeout = err?.name === "AbortError";
      return this.errorResult(
        isTimeout ? `Timeout after ${this.timeoutMs}ms` : (err.message || String(err))
      );
    }
  }
}
