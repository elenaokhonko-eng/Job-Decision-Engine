import { BaseSourceAdapter, type AdapterFetchOptions, type AdapterResult, snapshotPage } from "./baseAdapter.js";
import { ExtractedJob, SCHEMA_VERSION } from "../../contracts/index.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  // Workable's public widget response is narrowed at the external API boundary.
  return value as Record<string, unknown>;
}

function textValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Workable account subdomains: letters, digits and hyphens (e.g. `luminance-1`). */
const WORKABLE_ACCOUNT_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/i;

function workableLocation(item: Record<string, unknown>): string {
  const listed = Array.isArray(item.locations) ? item.locations : [];
  const parts = listed
    .map(asRecord)
    .filter((location): location is Record<string, unknown> => location !== null && location.hidden !== true)
    .map((location) => [optionalText(location.city), optionalText(location.region), optionalText(location.country)]
      .filter((part): part is string => part !== null)
      .join(", "))
    .filter((label) => label.length > 0);
  if (parts.length > 0) return [...new Set(parts)].join(" | ");
  const single = [optionalText(item.city), optionalText(item.state), optionalText(item.country)]
    .filter((part): part is string => part !== null)
    .join(", ");
  return single || "Unknown";
}

function workableDate(value: unknown): string | undefined {
  const text = optionalText(value);
  if (!text) return undefined;
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00.000Z` : text);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

/**
 * Workable public job widget: `GET /api/v1/widget/accounts/{account}?details=true`
 * returns `{ name, description, jobs[] }` with every posting's HTML description in one
 * response. The full snapshot is paged locally with a stable cursor (like Greenhouse/Ashby).
 */
export class WorkableAdapter extends BaseSourceAdapter {
  sourceName = "WORKABLE" as const;
  private account: string;

  constructor(account: string) {
    super();
    if (!WORKABLE_ACCOUNT_PATTERN.test(account)) throw new Error(`Invalid Workable account slug: ${account}`);
    this.account = account;
    this.timeoutMs = 15_000;
  }

  async fetchJobs(options: AdapterFetchOptions = {}): Promise<AdapterResult> {
    this.beginFetch();
    const url = `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(this.account)}?details=true`;
    try {
      const response = await this.fetchWithTimeout(url, { headers: { Accept: "application/json" } });

      if (response.status === 429) {
        return this.errorResult("429 Rate limited", { isRateLimited: true });
      }
      if (response.status === 404) {
        return this.errorResult(`Workable account not found: ${this.account} (HTTP 404)`);
      }
      if (!response.ok) {
        return this.errorResult(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = asRecord(await this.readJsonResponse(response));
      if (!data || !Array.isArray(data.jobs)) {
        return this.errorResult("Workable response is missing its jobs array.");
      }
      const rawJobs: unknown[] = data.jobs;
      this.assertRecordCount(rawJobs);
      const companyName = textValue(data.name, this.account.toUpperCase());
      const limit = Math.min(200, Math.max(1, options.limit ?? 50));
      const identity = (record: unknown): string => {
        const shortcode = asRecord(record)?.shortcode;
        return typeof shortcode === "string" && shortcode.trim() ? shortcode.trim() : JSON.stringify(record ?? null);
      };
      const page = snapshotPage(rawJobs, limit, options.cursor, options.page, identity);
      const jobs: ExtractedJob[] = [];
      let quarantined = 0;

      for (const rawItem of page.records) {
        const item = asRecord(rawItem);
        const shortcode = item ? optionalText(item.shortcode) : null;
        const title = item ? optionalText(item.title) : null;
        const postingUrl = item ? optionalText(item.url) ?? optionalText(item.shortlink) : null;
        const description = item ? this.sanitizeHtml(item.description) : "";
        if (!item || !shortcode || !title || !postingUrl || !description) {
          // Without identity, title, URL and description the posting cannot be evaluated;
          // quarantine it with its raw payload instead of inventing placeholder text.
          const missing = !item ? ["record"] : [
            ...(!shortcode ? ["shortcode"] : []),
            ...(!title ? ["title"] : []),
            ...(!postingUrl ? ["url"] : []),
            ...(!description ? ["description"] : []),
          ];
          this.quarantine(shortcode ?? title ?? "workable:unidentified", rawItem, `Workable posting is missing ${missing.join(", ")}.`);
          quarantined++;
          continue;
        }
        const applyUrl = textValue(item.application_url, postingUrl);
        const candidate = {
          schema_version: SCHEMA_VERSION,
          source_external_id: shortcode,
          company_name: companyName,
          title,
          location_raw: workableLocation(item),
          // Workable exposes only a remote flag; its absence is not on-site evidence.
          workplace_type_raw: item.telecommuting === true ? "REMOTE" : "UNKNOWN",
          employment_type_raw: textValue(item.employment_type, "UNKNOWN"),
          compensation_raw: "UNKNOWN",
          employer_posting_url: postingUrl,
          application_url: applyUrl,
          canonical_apply_url: applyUrl,
          description_raw: description,
          published_at: workableDate(item.published_on ?? item.created_at),
          raw_payload: rawItem,
        };

        const validated = this.validateJob(candidate, shortcode);
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
