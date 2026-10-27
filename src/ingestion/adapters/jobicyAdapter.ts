import { BaseSourceAdapter, type AdapterFetchOptions, type AdapterResult, snapshotPage, stableAdapterIdentity } from "./baseAdapter.js";
import { ExtractedJob, SCHEMA_VERSION, SourceName } from "../../contracts/index.js";
import { normalizeWorkMode } from "../../pipeline/workModeNormalizer.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  // Jobicy's public response is narrowed at the external API boundary.
  return value as Record<string, unknown>;
}

function textValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export class JobicyAdapter extends BaseSourceAdapter {
  sourceName: SourceName = "JOBICY";
  private readonly endpoint: string;

  constructor(endpoint = "https://jobicy.com/api/v2/remote-jobs") {
    super();
    this.endpoint = endpoint;
  }

  private stableExternalId(item: Record<string, unknown>): string | null {
    const candidates = [item.id, item.jobId, item.slug, item.url, item.jobUrl];
    const usable = candidates.find((value) => value !== null && value !== undefined && String(value).trim().length > 0);
    return usable === undefined ? null : String(usable).trim();
  }

  async fetchJobs(options: AdapterFetchOptions = {}): Promise<AdapterResult> {
    this.beginFetch();
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const url = new URL(this.endpoint);
    url.searchParams.set("count", String(limit));
    if (options.cursor && !options.cursor.startsWith("after:")) url.searchParams.set("cursor", options.cursor);
    try {
      const response = await this.fetchWithTimeout(url.toString(), {
        headers: { Accept: "application/json", "User-Agent": "JobDecisionEngine/1.0" }
      });
      if (response.status === 429) return this.errorResult("429 Rate limited", { isRateLimited: true });
      if (!response.ok) return this.errorResult(`HTTP ${response.status}: ${response.statusText}`);

      const payload: unknown = await response.json();
      const data = asRecord(payload);
      const rawJobs: unknown[] = Array.isArray(payload)
        ? payload
        : Array.isArray(data?.jobs)
          ? data.jobs
          : Array.isArray(data?.data)
            ? data.data
            : [];
      const serverCursorValue = data?.nextCursor ?? data?.next_cursor ?? null;
      const serverNextCursor = typeof serverCursorValue === "string" && serverCursorValue.length > 0 ? serverCursorValue : null;
      const page = serverNextCursor !== null || (options.cursor && !options.cursor.startsWith("after:"))
        ? { records: rawJobs.slice(0, limit), nextCursor: serverNextCursor, hasMore: serverNextCursor !== null }
        : snapshotPage(rawJobs, limit, options.cursor, options.page, stableAdapterIdentity);
      const jobs: ExtractedJob[] = [];
      let quarantined = 0;

      for (const rawItem of page.records) {
        const item = asRecord(rawItem);
        if (!item) {
          quarantined++;
          continue;
        }
        const description = this.sanitizeHtml(item.jobDescription ?? item.description);
        const sourceExternalId = this.stableExternalId(item);
        const title = textValue(item.jobTitle ?? item.title, "Unknown Title");
        const locationRaw = item.jobGeo ?? item.location ?? item.locationRaw;
        const location = Array.isArray(locationRaw)
          ? locationRaw.filter((part): part is string => typeof part === "string").join(", ")
          : textValue(locationRaw, "Unknown");
        const employmentRaw = item.jobType;
        const employmentType = Array.isArray(employmentRaw)
          ? employmentRaw.filter((part): part is string => typeof part === "string").join(", ")
          : textValue(employmentRaw, "UNKNOWN");
        const salaryMin = item.annualSalaryMin;
        const salaryMax = item.annualSalaryMax;
        const currency = textValue(item.salaryCurrency, "");
        const compensationRaw = (typeof salaryMin === "number" || typeof salaryMax === "number")
          ? `${salaryMin ?? "?"}-${salaryMax ?? "?"} ${currency} per year`.trim()
          : textValue(item.salary, "UNKNOWN");
        const postingUrl = textValue(item.url ?? item.jobUrl, "");
        const applyUrl = textValue(item.applicationUrl ?? item.applyUrl, postingUrl);
        const workplaceType = normalizeWorkMode(item.workplaceType ?? item.work_mode);
        const published = item.pubDate ?? item.published_at ?? item.datePosted;
        const publishedAt = typeof published === "string" && Number.isFinite(new Date(published).getTime())
          ? new Date(published).toISOString()
          : undefined;
        const candidate = {
          schema_version: SCHEMA_VERSION,
          ...(sourceExternalId ? { source_external_id: sourceExternalId } : {}),
          company_name: textValue(item.companyName ?? item.company_name ?? item.company, "Unknown Company"),
          title,
          location_raw: location,
          workplace_type_raw: workplaceType,
          employment_type_raw: employmentType,
          compensation_raw: compensationRaw,
          employer_posting_url: postingUrl || undefined,
          application_url: applyUrl || undefined,
          canonical_apply_url: applyUrl,
          description_raw: description,
          ...(publishedAt ? { published_at: publishedAt } : {}),
          source_attribution: "Jobicy",
          raw_payload: rawItem,
        };
        const validated = this.validateJob(candidate, sourceExternalId ?? title);
        if (validated) jobs.push(validated); else quarantined++;
      }

      return {
        sourceName: this.sourceName,
        success: page.records.length === 0 || jobs.length > 0,
        jobs,
        totalFetched: page.records.length,
        snapshotTotal: rawJobs.length,
        quarantined,
        quarantinedCandidates: this.getQuarantinedCandidates(),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        error: page.records.length > 0 && jobs.length === 0 ? `All ${quarantined} fetched Jobicy records were quarantined.` : undefined,
      };
    } catch (err: any) {
      const timeout = err?.name === "AbortError";
      return this.errorResult(timeout ? `Timeout after ${this.timeoutMs}ms` : (err.message || String(err)));
    }
  }
}
