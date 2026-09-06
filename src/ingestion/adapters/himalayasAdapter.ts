import { BaseSourceAdapter, AdapterResult } from "./baseAdapter.js";
import { ExtractedJob, SCHEMA_VERSION } from "../../contracts/index.js";

export class HimalayasAdapter extends BaseSourceAdapter {
  sourceName = "HIMALAYAS" as const;
  private readonly endpoint: string;

  constructor(endpoint = "https://himalayas.app/jobs/api") {
    super();
    this.endpoint = endpoint;
    this.timeoutMs = 15_000;
  }

  async fetchJobs(options: { limit?: number; page?: number } = {}): Promise<AdapterResult> {
    const limit = typeof options.limit === "number" && options.limit > 0 ? options.limit : 50;
    const separator = this.endpoint.includes("?") ? "&" : "?";
    const url = `${this.endpoint}${separator}limit=${limit}`;
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

      for (const item of rawJobs.slice(0, limit)) {
        const candidate = {
          schema_version: SCHEMA_VERSION,
          source_external_id: String(item.id ?? ""),
          company_name: item.companyName || "Unknown Company",
          title: item.title || "Unknown Title",
          location_raw: item.location || "Remote",
          workplace_type_raw: typeof item.workplaceType === "string" ? item.workplaceType : "REMOTE",
          employment_type_raw: typeof item.employmentType === "string" ? item.employmentType : "FULL_TIME",
          compensation_raw: item.salary || "UNKNOWN",
          canonical_apply_url: item.applicationUrl || item.jobUrl || url,
          description_raw: item.description || item.title || "Remote position.",
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
