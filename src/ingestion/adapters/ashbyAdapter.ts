import { BaseSourceAdapter, type AdapterFetchOptions, type AdapterResult, snapshotPage, stableAdapterIdentity } from "./baseAdapter.js";
import { ExtractedJob, SCHEMA_VERSION } from "../../contracts/index.js";
import { normalizeWorkMode } from "../../pipeline/workModeNormalizer.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  // Ashby's public response is narrowed at the external API boundary.
  return value as Record<string, unknown>;
}

function textValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export class AshbyAdapter extends BaseSourceAdapter {
  sourceName = "ASHBY" as const;
  private orgSlug: string;

  constructor(orgSlug: string = "anthropic") {
    super();
    this.orgSlug = orgSlug;
    this.timeoutMs = 15_000;
  }

  async fetchJobs(options: AdapterFetchOptions = {}): Promise<AdapterResult> {
    this.beginFetch();
    const url = `https://api.ashbyhq.com/posting-api/job-board/${this.orgSlug}`;
    try {
      const response = await this.fetchWithTimeout(url);

      if (response.status === 429) {
        return this.errorResult("429 Rate limited", { isRateLimited: true });
      }
      if (!response.ok) {
        return this.errorResult(`HTTP ${response.status}: ${response.statusText}`);
      }

      const payload: unknown = await response.json();
      const data = asRecord(payload);
      const rawJobs = Array.isArray(data?.jobs) ? data.jobs : [];
      const limit = Math.min(200, Math.max(1, options.limit ?? 50));
      const page = snapshotPage(rawJobs, limit, options.cursor, options.page, stableAdapterIdentity);
      const jobs: ExtractedJob[] = [];
      let quarantined = 0;

      for (const rawItem of page.records) {
        const item = asRecord(rawItem);
        if (!item) {
          quarantined++;
          continue;
        }
        const compensation = asRecord(item.compensation);
        const structuredMode = item.workplaceType ?? item.workplace_type ?? item.workplaceTypeRaw;
        const workplaceType = item.isRemote === true ? "REMOTE" : normalizeWorkMode(structuredMode);
        const title = textValue(item.title, "Unknown Title");
        const stableId = item.id === null || item.id === undefined ? null : String(item.id);
        const postingUrl = textValue(item.jobUrl, url);
        const applyUrl = textValue(item.applyUrl, postingUrl);
        const candidate = {
          schema_version: SCHEMA_VERSION,
          ...(stableId ? { source_external_id: stableId } : {}),
          company_name: this.orgSlug.toUpperCase(),
          title,
          location_raw: textValue(item.location, "Unknown"),
          workplace_type_raw: workplaceType,
          employment_type_raw: textValue(item.employmentType, "FULL_TIME"),
          compensation_raw: textValue(compensation?.text, "UNKNOWN"),
          employer_posting_url: postingUrl,
          application_url: applyUrl,
          canonical_apply_url: applyUrl,
          description_raw: this.sanitizeHtml(item.descriptionHtml ?? item.description ?? title),
          raw_payload: rawItem,
        };

        const validated = this.validateJob(candidate, stableId ?? title);
        if (validated) jobs.push(validated);
        else quarantined++;
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
      };
    } catch (err: any) {
      const isTimeout = err?.name === "AbortError";
      return this.errorResult(
        isTimeout ? `Timeout after ${this.timeoutMs}ms` : (err.message || String(err))
      );
    }
  }
}
