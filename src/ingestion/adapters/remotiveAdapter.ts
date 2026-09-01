import { AdapterResult, BaseSourceAdapter } from "./baseAdapter.js";
import { ExtractedJob, SCHEMA_VERSION, SourceName } from "../../contracts/index.js";

export class RemotiveAdapter extends BaseSourceAdapter {
  sourceName: SourceName = "REMOTIVE";
  private readonly endpoint: string;

  constructor(endpoint = "https://remotive.com/api/remote-jobs") {
    super();
    this.endpoint = endpoint;
  }

  async fetchJobs(options: { limit?: number; page?: number } = {}): Promise<AdapterResult> {
    const limit = Math.min(options.limit ?? 50, 100);
    try {
      const response = await this.fetchWithTimeout(`${this.endpoint}?limit=${limit}`, {
        headers: { Accept: "application/json", "User-Agent": "JobDecisionEngine/1.0" }
      });
      if (response.status === 429) return this.errorResult("429 Rate limited", { isRateLimited: true });
      if (!response.ok) return this.errorResult(`HTTP ${response.status}: ${response.statusText}`);

      const payload = await response.json() as any;
      const rawJobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
      const jobs: ExtractedJob[] = [];
      let quarantined = 0;

      for (const item of rawJobs.slice(0, limit)) {
        const candidate = {
          schema_version: SCHEMA_VERSION,
          source_external_id: String(item.id ?? ""),
          company_name: item.company_name,
          title: item.title,
          location_raw: item.candidate_required_location ?? "Remote",
          workplace_type_raw: "REMOTE",
          employment_type_raw: item.job_type ?? "UNKNOWN",
          compensation_raw: item.salary || "UNKNOWN",
          canonical_apply_url: item.url,
          description_raw: this.sanitizeHtml(item.description),
          published_at: item.publication_date ? new Date(item.publication_date).toISOString() : undefined,
          feed_delay_hours: 24,
          source_attribution: "Remotive - remote jobs delayed by up to 24 hours; link back required",
          raw_payload: item
        };
        const validated = this.validateJob(candidate, String(item.id ?? item.title ?? "unknown"));
        if (validated) jobs.push(validated); else quarantined++;
      }

      return { sourceName: this.sourceName, success: true, jobs, totalFetched: rawJobs.length, quarantined };
    } catch (err: any) {
      const timeout = err?.name === "AbortError";
      return this.errorResult(timeout ? `Timeout after ${this.timeoutMs}ms` : (err.message || String(err)));
    }
  }
}
