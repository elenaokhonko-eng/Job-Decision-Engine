import { BaseSourceAdapter, AdapterResult } from "./baseAdapter.js";
import { ExtractedJob, SCHEMA_VERSION } from "../../contracts/index.js";

export class AshbyAdapter extends BaseSourceAdapter {
  sourceName = "ASHBY";
  private orgSlug: string;

  constructor(orgSlug: string = "anthropic") {
    super();
    this.orgSlug = orgSlug;
    this.timeoutMs = 15_000;
  }

  async fetchJobs(options: { limit?: number; page?: number } = {}): Promise<AdapterResult> {
    const url = `https://api.ashbyhq.com/posting-api/job-board/${this.orgSlug}`;
    try {
      const response = await this.fetchWithTimeout(url);

      if (response.status === 429) {
        return this.errorResult("429 Rate limited", { isRateLimited: true });
      }
      if (!response.ok) {
        return this.errorResult(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      const rawJobs: any[] = data.jobs || [];
      const jobs: ExtractedJob[] = [];
      let quarantined = 0;

      for (const item of rawJobs.slice(0, options.limit || 50)) {
        const candidate = {
          schema_version: SCHEMA_VERSION,
          company_name: this.orgSlug.toUpperCase(),
          title: item.title || "Unknown Title",
          location_raw: item.location || "Unknown",
          workplace_type_raw: item.isRemote ? "REMOTE" : "HYBRID",
          employment_type_raw: item.employmentType || "FULL_TIME",
          compensation_raw: item.compensation?.text || "UNKNOWN",
          canonical_apply_url: item.jobUrl || url,
          description_raw: item.descriptionHtml || item.title || "No description.",
        };

        const validated = this.validateJob(candidate, item.id || item.title);
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
