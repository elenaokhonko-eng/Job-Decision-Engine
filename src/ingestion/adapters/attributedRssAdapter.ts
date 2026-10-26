import { XMLParser } from "fast-xml-parser";
import { BaseSourceAdapter, type AdapterFetchOptions, type AdapterResult, snapshotPage, stableAdapterIdentity } from "./baseAdapter.js";
import { ExtractedJob, SCHEMA_VERSION, SourceName } from "../../contracts/index.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  // RSS parser output is narrowed at the public-feed boundary.
  return value as Record<string, unknown>;
}

function textValue(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  const text = record?.["#text"];
  return typeof text === "string" ? text : fallback;
}

export interface AttributedRssConfig {
  sourceName: SourceName;
  feedUrl: string;
  attribution: string;
  defaultCompany?: string;
}

export class AttributedRssAdapter extends BaseSourceAdapter {
  sourceName: SourceName;
  private readonly config: AttributedRssConfig;

  constructor(config: AttributedRssConfig) {
    super();
    this.config = config;
    this.sourceName = config.sourceName;
  }

  async fetchJobs(options: AdapterFetchOptions = {}): Promise<AdapterResult> {
    this.beginFetch();
    const limit = Math.min(200, Math.max(1, options.limit ?? 50));
    try {
      const response = await this.fetchWithTimeout(this.config.feedUrl, {
        headers: { Accept: "application/rss+xml, application/xml, text/xml", "User-Agent": "JobDecisionEngine/1.0" }
      });
      if (response.status === 429) return this.errorResult("429 Rate limited", { isRateLimited: true });
      if (!response.ok) return this.errorResult(`HTTP ${response.status}: ${response.statusText}`);

      const xml = await response.text();
      const parsed: unknown = new XMLParser({ ignoreAttributes: false, trimValues: true }).parse(xml);
      const root = asRecord(parsed);
      const rss = asRecord(root?.rss);
      const channel = asRecord(rss?.channel);
      const feed = asRecord(root?.feed);
      const rawItems = channel?.item ?? feed?.entry;
      const items: unknown[] = Array.isArray(rawItems) ? rawItems : rawItems === null || rawItems === undefined ? [] : [rawItems];
      const identity = (rawItem: unknown): string => {
        const item = asRecord(rawItem);
        if (!item) return stableAdapterIdentity(rawItem);
        const linkValue = item.link;
        const linkRecord = asRecord(linkValue);
        return textValue(item.guid) || textValue(item.id) || textValue(linkValue) || textValue(linkRecord?.["@_href"]) || stableAdapterIdentity(item);
      };
      const page = snapshotPage(items, limit, options.cursor, options.page, identity);
      const jobs: ExtractedJob[] = [];
      let quarantined = 0;

      for (const rawItem of page.records) {
        const item = asRecord(rawItem);
        if (!item) {
          quarantined++;
          continue;
        }
        const linkValue = item.link;
        const linkRecord = asRecord(linkValue);
        const link = textValue(linkValue) || textValue(linkRecord?.["@_href"]);
        const titleText = textValue(item.title).trim();
        const titleParts = titleText.split(":");
        const author = asRecord(item.author);
        const sourceExternalId = identity(rawItem);
        const companyName = textValue(item.company)
          || textValue(author?.name)
          || (titleParts.length > 1 ? titleParts[0].trim() : this.config.defaultCompany || "Unknown Company");
        const title = titleParts.length > 1 ? titleParts.slice(1).join(":").trim() || titleText : titleText;
        const published = item.pubDate ?? item.published;
        const publishedAt = typeof published === "string" && Number.isFinite(new Date(published).getTime())
          ? new Date(published).toISOString()
          : undefined;
        const candidate = {
          schema_version: SCHEMA_VERSION,
          ...(sourceExternalId ? { source_external_id: sourceExternalId } : {}),
          company_name: companyName,
          title: title || "Unknown Title",
          location_raw: textValue(item.region ?? item.location, "Unknown"),
          workplace_type_raw: "REMOTE",
          employment_type_raw: textValue(item.type, "UNKNOWN"),
          compensation_raw: "UNKNOWN",
          employer_posting_url: link,
          application_url: link,
          canonical_apply_url: link,
          description_raw: this.sanitizeHtml(textValue(item.description ?? item.summary ?? item.content)),
          ...(publishedAt ? { published_at: publishedAt } : {}),
          source_attribution: this.config.attribution,
          raw_payload: rawItem,
        };
        const validated = this.validateJob(candidate, sourceExternalId || title || "unknown");
        if (validated) jobs.push(validated); else quarantined++;
      }

      return {
        sourceName: this.sourceName,
        success: page.records.length === 0 || jobs.length > 0,
        jobs,
        totalFetched: page.records.length,
        snapshotTotal: items.length,
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

export function createWeWorkRemotelyAdapter(feedUrl: string): AttributedRssAdapter {
  return new AttributedRssAdapter({
    sourceName: "WE_WORK_REMOTELY",
    feedUrl,
    attribution: "We Work Remotely - canonical source link required",
    defaultCompany: "Unknown Company"
  });
}
