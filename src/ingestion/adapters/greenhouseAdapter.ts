import { BaseSourceAdapter, type AdapterFetchOptions, type AdapterResult, snapshotPage, stableAdapterIdentity } from "./baseAdapter.js";
import { ExtractedJob, SCHEMA_VERSION } from "../../contracts/index.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  // Greenhouse's public response is narrowed at the external API boundary.
  return value as Record<string, unknown>;
}

function textValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export class GreenhouseAdapter extends BaseSourceAdapter {
  sourceName = "GREENHOUSE" as const;
  private boardToken: string;

  constructor(boardToken: string = "databricks") {
    super();
    this.boardToken = boardToken;
    this.timeoutMs = 15_000;
  }

  async fetchJobs(options: AdapterFetchOptions = {}): Promise<AdapterResult> {
    this.beginFetch();
    const url = `https://boards-api.greenhouse.io/v1/boards/${this.boardToken}/jobs?content=true`;
    try {
      const response = await this.fetchWithTimeout(url);

      if (response.status === 429) {
        return this.errorResult("429 Rate limited", { isRateLimited: true });
      }
      if (!response.ok) {
        return this.errorResult(`HTTP ${response.status}: ${response.statusText}`);
      }

      const payload = await this.readJsonResponse(response);
      const data = asRecord(payload);
      const rawJobs = Array.isArray(data?.jobs) ? data.jobs : [];
      this.assertRecordCount(rawJobs);
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
        const location = asRecord(item.location);
        const stableId = item.id === null || item.id === undefined ? null : String(item.id);
        const title = textValue(item.title, "Unknown Title");
        const candidate = {
          schema_version: SCHEMA_VERSION,
          ...(stableId ? { source_external_id: stableId } : {}),
          company_name: this.boardToken.toUpperCase(),
          title,
          location_raw: textValue(location?.name, "Unknown"),
          workplace_type_raw: "UNKNOWN",
          employment_type_raw: "FULL_TIME",
          compensation_raw: "UNKNOWN",
          employer_posting_url: textValue(item.absolute_url, url),
          application_url: textValue(item.absolute_url, url),
          canonical_apply_url: textValue(item.absolute_url, url),
          description_raw: textValue(item.content, title),
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
