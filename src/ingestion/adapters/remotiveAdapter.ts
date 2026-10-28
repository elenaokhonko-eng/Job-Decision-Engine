import { BaseSourceAdapter, type AdapterFetchOptions, type AdapterResult, snapshotPage, stableAdapterIdentity } from "./baseAdapter.js";
import { ExtractedJob, SCHEMA_VERSION, SourceName } from "../../contracts/index.js";
import { normalizeWorkMode } from "../../pipeline/workModeNormalizer.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  // Remotive's public response is narrowed at the external API boundary.
  return value as Record<string, unknown>;
}

function textValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export class RemotiveAdapter extends BaseSourceAdapter {
  sourceName: SourceName = "REMOTIVE";
  private readonly endpoint: string;

  constructor(endpoint = "https://remotive.com/api/remote-jobs") {
    super();
    this.endpoint = endpoint;
  }

  async fetchJobs(options: AdapterFetchOptions = {}): Promise<AdapterResult> {
    this.beginFetch();
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const requestLimit = 100;
    try {
      const endpoint = new URL(this.endpoint);
      endpoint.searchParams.set("limit", String(requestLimit));
      const response = await this.fetchWithTimeout(endpoint.toString(), {
        headers: { Accept: "application/json", "User-Agent": "JobDecisionEngine/1.0" }
      });
      if (response.status === 429) return this.errorResult("429 Rate limited", { isRateLimited: true });
      if (!response.ok) return this.errorResult(`HTTP ${response.status}: ${response.statusText}`);

      const payload = await this.readJsonResponse(response);
      const payloadRecord = asRecord(payload);
      const rawJobs: unknown[] = Array.isArray(payloadRecord?.jobs) ? payloadRecord.jobs : [];
      this.assertRecordCount(rawJobs, requestLimit);
      const page = snapshotPage(rawJobs, limit, options.cursor, options.page, stableAdapterIdentity);
      const jobs: ExtractedJob[] = [];
      let quarantined = 0;

      for (const rawItem of page.records) {
        const item = asRecord(rawItem);
        if (!item) {
          quarantined++;
          continue;
        }
        const stableId = item.id === null || item.id === undefined ? null : String(item.id);
        const title = textValue(item.title, "Unknown Title");
        const postingUrl = textValue(item.job_url ?? item.url, "");
        const applyUrl = textValue(item.apply_url ?? item.url, postingUrl);
        const structuredMode = item.workplace_type ?? item.workplaceType;
        const workplace = item.is_remote === true ? "REMOTE" : normalizeWorkMode(structuredMode);
        const publicationDate = item.publication_date;
        const publishedAt = typeof publicationDate === "string" && Number.isFinite(new Date(publicationDate).getTime())
          ? new Date(publicationDate).toISOString()
          : undefined;
        const candidate = {
          schema_version: SCHEMA_VERSION,
          ...(stableId ? { source_external_id: stableId } : {}),
          company_name: textValue(item.company_name, "Unknown Company"),
          title,
          location_raw: textValue(item.candidate_required_location, "Unknown"),
          workplace_type_raw: workplace,
          employment_type_raw: textValue(item.job_type, "UNKNOWN"),
          compensation_raw: textValue(item.salary, "UNKNOWN"),
          employer_posting_url: postingUrl || undefined,
          application_url: applyUrl || undefined,
          canonical_apply_url: applyUrl,
          description_raw: this.sanitizeHtml(item.description ?? title),
          ...(publishedAt ? { published_at: publishedAt } : {}),
          feed_delay_hours: 24,
          source_attribution: "Remotive - remote jobs delayed by up to 24 hours; link back required",
          raw_payload: rawItem,
        };
        const validated = this.validateJob(candidate, stableId ?? title);
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
      };
    } catch (err: any) {
      const timeout = err?.name === "AbortError";
      return this.errorResult(timeout ? `Timeout after ${this.timeoutMs}ms` : (err.message || String(err)));
    }
  }
}
