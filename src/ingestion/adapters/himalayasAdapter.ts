import { BaseSourceAdapter, AdapterResult } from "./baseAdapter.js";
import { ExtractedJob, SCHEMA_VERSION } from "../../contracts/index.js";
import crypto from "node:crypto";

export class HimalayasAdapter extends BaseSourceAdapter {
  sourceName = "HIMALAYAS" as const;
  private readonly endpoint: string;

  constructor(endpoint = "https://himalayas.app/jobs/api") {
    super();
    this.endpoint = endpoint;
    this.timeoutMs = 15_000;
  }

  private stableExternalId(item: any): string {
    const candidates = [item?.id, item?.slug, item?.jobUrl, item?.applicationUrl, item?.url];
    const usable = candidates.find((value) => value !== null && value !== undefined && String(value).trim().length > 0);
    if (usable !== undefined) return String(usable).trim();
    return crypto
      .createHash("sha256")
      .update(`${item?.companyName ?? item?.company_name ?? ""}|${item?.title ?? ""}|${item?.jobUrl ?? item?.applicationUrl ?? item?.url ?? ""}`)
      .digest("hex")
      .slice(0, 24);
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
      const rawJobs: any[] = Array.isArray(data)
        ? data
        : Array.isArray(data?.jobs)
          ? data.jobs
          : Array.isArray(data?.data)
            ? data.data
            : [];
      const jobs: ExtractedJob[] = [];
      let quarantined = 0;

      for (const item of rawJobs.slice(0, limit)) {
        const sourceExternalId = this.stableExternalId(item);
        const candidate = {
          schema_version: SCHEMA_VERSION,
          source_external_id: sourceExternalId,
          company_name: String(item.companyName ?? item.company_name ?? item.company ?? "Unknown Company").trim(),
          title: String(item.title ?? item.jobTitle ?? "Unknown Title").trim(),
          location_raw: Array.isArray(item.location ?? item.locationRaw)
            ? (item.location ?? item.locationRaw).join(", ")
            : String(item.location ?? item.locationRaw ?? "Remote"),
          workplace_type_raw: typeof (item.workplaceType ?? item.work_mode) === "string" ? (item.workplaceType ?? item.work_mode) : "REMOTE",
          employment_type_raw: Array.isArray(item.employmentType)
            ? item.employmentType.join(", ")
            : typeof item.employmentType === "string"
              ? item.employmentType
              : "FULL_TIME",
          compensation_raw: item.salary ?? item.compensation ?? "UNKNOWN",
          canonical_apply_url: item.applicationUrl || item.applicationUrlRaw || item.jobUrl || item.url || `https://himalayas.app/jobs/${encodeURIComponent(sourceExternalId)}`,
          description_raw: item.description || item.jobDescription || item.title || "Remote position.",
        };

        const validated = this.validateJob(candidate, sourceExternalId);
        if (validated) {
          jobs.push(validated);
        } else {
          quarantined++;
        }
      }

      return {
        sourceName: this.sourceName,
        success: rawJobs.length === 0 || jobs.length > 0,
        jobs,
        totalFetched: rawJobs.length,
        quarantined,
        error: rawJobs.length > 0 && jobs.length === 0 ? `All ${quarantined} fetched Himalayas records were quarantined.` : undefined,
      };
    } catch (err: any) {
      const isTimeout = err?.name === "AbortError";
      return this.errorResult(
        isTimeout ? `Timeout after ${this.timeoutMs}ms` : (err.message || String(err))
      );
    }
  }
}
