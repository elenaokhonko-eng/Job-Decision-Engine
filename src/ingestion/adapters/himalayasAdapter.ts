import { BaseSourceAdapter, type AdapterFetchOptions, type AdapterResult } from "./baseAdapter.js";
import { ExtractedJob, SCHEMA_VERSION } from "../../contracts/index.js";
import crypto from "node:crypto";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  // Himalayas' public response is narrowed at the external API boundary.
  return value as Record<string, unknown>;
}

function textValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export class HimalayasAdapter extends BaseSourceAdapter {
  sourceName = "HIMALAYAS" as const;
  private readonly endpoint: string;

  constructor(endpoint = "https://himalayas.app/jobs/api") {
    super();
    this.endpoint = endpoint;
    this.timeoutMs = 15_000;
  }

  private stableExternalId(item: Record<string, unknown>): string {
    const candidates = [item?.id, item?.slug, item?.jobUrl, item?.applicationUrl, item?.url];
    const usable = candidates.find((value) => value !== null && value !== undefined && String(value).trim().length > 0);
    if (usable !== undefined) return String(usable).trim();
    return crypto
      .createHash("sha256")
      .update(`${item?.companyName ?? item?.company_name ?? ""}|${item?.title ?? ""}|${item?.jobUrl ?? item?.applicationUrl ?? item?.url ?? ""}`)
      .digest("hex")
      .slice(0, 24);
  }

  async fetchJobs(options: AdapterFetchOptions = {}): Promise<AdapterResult> {
    this.beginFetch();
    const limit = Math.min(200, typeof options.limit === "number" && options.limit > 0 ? options.limit : 50);
    const url = new URL(this.endpoint);
    url.searchParams.set("limit", String(limit));
    if (options.cursor) url.searchParams.set("cursor", options.cursor);
    try {
      const response = await this.fetchWithTimeout(url.toString());

      if (response.status === 429) {
        return this.errorResult("429 Rate limited", { isRateLimited: true });
      }
      if (!response.ok) {
        return this.errorResult(`HTTP ${response.status}: ${response.statusText}`);
      }

      const payload: unknown = await response.json();
      const data = asRecord(payload);
      const rawJobs: unknown[] = Array.isArray(payload)
        ? payload
        : Array.isArray(data?.jobs)
          ? data.jobs
          : Array.isArray(data?.data)
            ? data.data
            : [];
      const jobs: ExtractedJob[] = [];
      let quarantined = 0;

      for (const rawItem of rawJobs.slice(0, limit)) {
        const item = asRecord(rawItem);
        if (!item) {
          quarantined++;
          continue;
        }
        const sourceExternalId = this.stableExternalId(item);
        const employment = item.employmentType;
        const employmentType = Array.isArray(employment)
          ? employment.filter((part): part is string => typeof part === "string").join(", ")
          : textValue(employment, "FULL_TIME");
        const location = item.location ?? item.locationRaw;
        const locationText = Array.isArray(location)
          ? location.filter((part): part is string => typeof part === "string").join(", ")
          : textValue(location, "Unknown");
        const fallbackUrl = `https://himalayas.app/jobs/${encodeURIComponent(sourceExternalId)}`;
        const postingUrl = textValue(item.jobUrl ?? item.url, fallbackUrl);
        const applyUrl = textValue(item.applicationUrl ?? item.applicationUrlRaw, postingUrl);
        const title = textValue(item.title ?? item.jobTitle, "Unknown Title");
        const workplace = textValue(item.workplaceType ?? item.work_mode, "UNKNOWN");
        const candidate = {
          schema_version: SCHEMA_VERSION,
          source_external_id: sourceExternalId,
          company_name: textValue(item.companyName ?? item.company_name ?? item.company, "Unknown Company"),
          title,
          location_raw: locationText,
          workplace_type_raw: workplace,
          employment_type_raw: employmentType,
          compensation_raw: typeof item.salary === "string" ? item.salary : typeof item.compensation === "string" ? item.compensation : "UNKNOWN",
          employer_posting_url: postingUrl,
          application_url: applyUrl,
          canonical_apply_url: applyUrl,
          description_raw: textValue(item.description ?? item.jobDescription, title),
          raw_payload: rawItem,
        };

        const validated = this.validateJob(candidate, sourceExternalId);
        if (validated) jobs.push(validated);
        else quarantined++;
      }

      const nextCursorValue = data?.nextCursor ?? data?.next_cursor ?? data?.nextPageCursor ?? null;
      const nextCursor = typeof nextCursorValue === "string" && nextCursorValue.length > 0 ? nextCursorValue : null;
      return {
        sourceName: this.sourceName,
        success: rawJobs.length === 0 || jobs.length > 0,
        jobs,
        totalFetched: rawJobs.length,
        quarantined,
        quarantinedCandidates: this.getQuarantinedCandidates(),
        nextCursor,
        hasMore: nextCursor !== null,
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
