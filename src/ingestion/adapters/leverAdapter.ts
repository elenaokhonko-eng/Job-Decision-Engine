import { BaseSourceAdapter, type AdapterFetchOptions, type AdapterResult } from "./baseAdapter.js";
import { ExtractedJob, SCHEMA_VERSION } from "../../contracts/index.js";
import { normalizeWorkMode } from "../../pipeline/workModeNormalizer.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  // Lever's public response is narrowed at the external API boundary.
  return value as Record<string, unknown>;
}

function textValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export class LeverAdapter extends BaseSourceAdapter {
  sourceName = "LEVER" as const;
  private siteToken: string;

  constructor(siteToken: string = "spotify") {
    super();
    this.siteToken = siteToken;
    this.timeoutMs = 15_000;
  }

  async fetchJobs(options: AdapterFetchOptions = {}): Promise<AdapterResult> {
    this.beginFetch();
    const limit = Math.min(200, Math.max(1, options.limit ?? 50));
    const cursorSkip = options.cursor?.startsWith("skip:") ? Number(options.cursor.slice(5)) : null;
    const skip = Number.isInteger(cursorSkip) && Number(cursorSkip) >= 0
      ? Number(cursorSkip)
      : Math.max(0, options.page ?? 0) * limit;
    const url = new URL(`https://api.lever.co/v0/postings/${encodeURIComponent(this.siteToken)}`);
    url.searchParams.set("mode", "json");
    url.searchParams.set("skip", String(skip));
    url.searchParams.set("limit", String(limit));
    try {
      const response = await this.fetchWithTimeout(url.toString());

      if (response.status === 429) {
        return this.errorResult("429 Rate limited", { isRateLimited: true });
      }
      if (!response.ok) {
        return this.errorResult(`HTTP ${response.status}: ${response.statusText}`);
      }

      const rawPayload = await this.readJsonResponse(response);
      const rawJobs = Array.isArray(rawPayload) ? rawPayload : [];
      this.assertRecordCount(rawJobs, limit);
      const jobs: ExtractedJob[] = [];
      let quarantined = 0;

      for (const rawItem of rawJobs) {
        const item = asRecord(rawItem);
        if (!item) {
          quarantined++;
          continue;
        }
        const categories = asRecord(item.categories);
        const stableId = item.id === null || item.id === undefined ? null : String(item.id);
        const title = textValue(item.text, "Unknown Title");
        const postingUrl = textValue(item.hostedUrl, url.toString());
        const applyUrl = textValue(item.applyUrl, postingUrl);
        const candidate = {
          schema_version: SCHEMA_VERSION,
          ...(stableId ? { source_external_id: stableId } : {}),
          company_name: this.siteToken.toUpperCase(),
          title,
          location_raw: textValue(categories?.location, "Unknown"),
          workplace_type_raw: normalizeWorkMode(item.workplaceType),
          employment_type_raw: textValue(categories?.commitment, "FULL_TIME"),
          compensation_raw: textValue(item.salaryRange, "UNKNOWN"),
          employer_posting_url: postingUrl,
          application_url: applyUrl,
          canonical_apply_url: applyUrl,
          description_raw: this.sanitizeHtml(item.descriptionPlain ?? item.description ?? title),
          published_at: typeof item.createdAt === "number" ? new Date(item.createdAt).toISOString() : undefined,
          raw_payload: rawItem,
        };

        const validated = this.validateJob(candidate, stableId ?? title);
        if (validated) jobs.push(validated);
        else quarantined++;
      }

      const hasMore = rawJobs.length === limit;
      return {
        sourceName: this.sourceName,
        success: rawJobs.length === 0 || jobs.length > 0,
        jobs,
        totalFetched: rawJobs.length,
        quarantined,
        quarantinedCandidates: this.getQuarantinedCandidates(),
        nextCursor: hasMore ? `skip:${skip + rawJobs.length}` : null,
        hasMore,
      };
    } catch (err: any) {
      const isTimeout = err?.name === "AbortError";
      return this.errorResult(
        isTimeout ? `Timeout after ${this.timeoutMs}ms` : (err.message || String(err))
      );
    }
  }
}
