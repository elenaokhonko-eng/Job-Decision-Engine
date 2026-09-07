import { AdapterResult, BaseSourceAdapter } from "./baseAdapter.js";
import { ExtractedJob, SCHEMA_VERSION, SourceName } from "../../contracts/index.js";
import crypto from "node:crypto";

export class JobicyAdapter extends BaseSourceAdapter {
  sourceName: SourceName = "JOBICY";
  private readonly endpoint: string;

  constructor(endpoint = "https://jobicy.com/api/v2/remote-jobs") {
    super();
    this.endpoint = endpoint;
  }

  private stableExternalId(item: any): string {
    const candidates = [item?.id, item?.jobId, item?.slug, item?.url, item?.jobUrl];
    const usable = candidates.find((value) => value !== null && value !== undefined && String(value).trim().length > 0);
    if (usable !== undefined) return String(usable).trim();
    return crypto
      .createHash("sha256")
      .update(`${item?.companyName ?? ""}|${item?.jobTitle ?? item?.title ?? ""}|${item?.url ?? item?.jobUrl ?? ""}`)
      .digest("hex")
      .slice(0, 24);
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
      const rawJobs = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.jobs)
          ? payload.jobs
          : Array.isArray(payload?.data)
            ? payload.data
            : [];
      const jobs: ExtractedJob[] = [];
      let quarantined = 0;

      for (const item of rawJobs.slice(0, limit)) {
        const description = this.sanitizeHtml(item.jobDescription ?? item.description);
        const sourceExternalId = this.stableExternalId(item);
        const candidate = {
          schema_version: SCHEMA_VERSION,
          source_external_id: sourceExternalId,
          company_name: String(item.companyName ?? item.company_name ?? item.company ?? "Unknown Company").trim(),
          title: String(item.jobTitle ?? item.title ?? "Unknown Title").trim(),
          location_raw: Array.isArray(item.jobGeo ?? item.location ?? item.locationRaw)
            ? (item.jobGeo ?? item.location ?? item.locationRaw).join(", ")
            : String(item.jobGeo ?? item.location ?? item.locationRaw ?? "Remote"),
          workplace_type_raw: typeof (item.workplaceType ?? item.work_mode) === "string"
            ? (item.workplaceType ?? item.work_mode)
            : "REMOTE",
          employment_type_raw: Array.isArray(item.jobType)
            ? item.jobType.join(", ")
            : String(item.jobType ?? "UNKNOWN"),
          compensation_raw: item.annualSalaryMin || item.annualSalaryMax
            ? `${item.annualSalaryMin ?? "?"}-${item.annualSalaryMax ?? "?"} ${item.salaryCurrency ?? ""}`.trim()
            : "UNKNOWN",
          canonical_apply_url: item.url ?? item.jobUrl ?? item.applicationUrl ?? `https://jobicy.com/jobs/${encodeURIComponent(sourceExternalId)}`,
          description_raw: description,
          published_at: item.pubDate ? new Date(item.pubDate).toISOString() : undefined,
          source_attribution: "Jobicy",
          raw_payload: item
        };
        const validated = this.validateJob(candidate, sourceExternalId);
        if (validated) jobs.push(validated); else quarantined++;
      }

      return {
        sourceName: this.sourceName,
        success: rawJobs.length === 0 || jobs.length > 0,
        jobs,
        totalFetched: rawJobs.length,
        quarantined,
        error: rawJobs.length > 0 && jobs.length === 0 ? `All ${quarantined} fetched Jobicy records were quarantined.` : undefined,
      };
    } catch (err: any) {
      const timeout = err?.name === "AbortError";
      return this.errorResult(timeout ? `Timeout after ${this.timeoutMs}ms` : (err.message || String(err)));
    }
  }
}
