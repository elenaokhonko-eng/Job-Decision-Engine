import { AdapterResult, BaseSourceAdapter } from "./baseAdapter.js";
import { ExtractedJob, SCHEMA_VERSION, SourceName } from "../../contracts/index.js";

export class JobicyAdapter extends BaseSourceAdapter {
  sourceName: SourceName = "JOBICY";
  private readonly endpoint: string;

  constructor(endpoint = "https://jobicy.com/api/v2/remote-jobs") {
    super();
    this.endpoint = endpoint;
  }

  async fetchJobs(options: { limit?: number; page?: number } = {}): Promise<AdapterResult> {
    const limit = Math.min(options.limit ?? 50, 200);
    const url = `${this.endpoint}?count=${limit}`;
    try {
      const response = await this.fetchWithTimeout(url, {
        headers: { Accept: "application/json", "User-Agent": "JobDecisionEngine/1.0" }
      });
      if (response.status === 429) return this.errorResult("429 Rate limited", { isRateLimited: true });
      if (!response.ok) return this.errorResult(`HTTP ${response.status}: ${response.statusText}`);

      const payload = await response.json() as any;
      const rawJobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
      const jobs: ExtractedJob[] = [];
      let quarantined = 0;

      for (const item of rawJobs.slice(0, limit)) {
        const description = this.sanitizeHtml(item.jobDescription ?? item.description);
        const candidate = {
          schema_version: SCHEMA_VERSION,
          source_external_id: String(item.id ?? item.jobId ?? ""),
          company_name: item.companyName,
          title: item.jobTitle,
          location_raw: item.jobGeo ?? "Remote",
          workplace_type_raw: "REMOTE",
          employment_type_raw: item.jobType ?? "UNKNOWN",
          compensation_raw: item.annualSalaryMin || item.annualSalaryMax
            ? `${item.annualSalaryMin ?? "?"}-${item.annualSalaryMax ?? "?"} ${item.salaryCurrency ?? ""}`.trim()
            : "UNKNOWN",
          canonical_apply_url: item.url ?? item.jobUrl,
          description_raw: description,
          published_at: item.pubDate ? new Date(item.pubDate).toISOString() : undefined,
          source_attribution: "Jobicy",
          raw_payload: item
        };
        const validated = this.validateJob(candidate, String(item.id ?? item.jobTitle ?? "unknown"));
        if (validated) jobs.push(validated); else quarantined++;
      }

      return { sourceName: this.sourceName, success: true, jobs, totalFetched: rawJobs.length, quarantined };
    } catch (err: any) {
      const timeout = err?.name === "AbortError";
      return this.errorResult(timeout ? `Timeout after ${this.timeoutMs}ms` : (err.message || String(err)));
    }
  }
}
