import { XMLParser } from "fast-xml-parser";
import { AdapterResult, BaseSourceAdapter } from "./baseAdapter.js";
import { ExtractedJob, SCHEMA_VERSION, SourceName } from "../../contracts/index.js";

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

  async fetchJobs(options: { limit?: number; page?: number } = {}): Promise<AdapterResult> {
    const limit = options.limit ?? 50;
    try {
      const response = await this.fetchWithTimeout(this.config.feedUrl, {
        headers: { Accept: "application/rss+xml, application/xml, text/xml", "User-Agent": "JobDecisionEngine/1.0" }
      });
      if (response.status === 429) return this.errorResult("429 Rate limited", { isRateLimited: true });
      if (!response.ok) return this.errorResult(`HTTP ${response.status}: ${response.statusText}`);

      const xml = await response.text();
      const parsed = new XMLParser({ ignoreAttributes: false, trimValues: true }).parse(xml) as any;
      const itemsRaw = parsed?.rss?.channel?.item ?? parsed?.feed?.entry ?? [];
      const items = Array.isArray(itemsRaw) ? itemsRaw : (itemsRaw ? [itemsRaw] : []);
      const jobs: ExtractedJob[] = [];
      let quarantined = 0;

      for (const item of items.slice(0, limit)) {
        const link = typeof item.link === "string" ? item.link : item.link?.["@_href"];
        const titleText = String(item.title?.["#text"] ?? item.title ?? "").trim();
        const titleParts = titleText.split(":");
        const candidate = {
          schema_version: SCHEMA_VERSION,
          source_external_id: String(item.guid?.["#text"] ?? item.guid ?? item.id ?? link ?? ""),
          company_name: item.company ?? item.author?.name ?? (titleParts.length > 1 ? titleParts.shift()?.trim() : this.config.defaultCompany) ?? "Unknown Company",
          title: titleParts.join(":").trim() || titleText,
          location_raw: item.region ?? item.location ?? "Remote",
          workplace_type_raw: "REMOTE",
          employment_type_raw: item.type ?? "UNKNOWN",
          compensation_raw: "UNKNOWN",
          canonical_apply_url: link,
          description_raw: this.sanitizeHtml(item.description ?? item.summary ?? item.content),
          published_at: item.pubDate || item.published ? new Date(item.pubDate ?? item.published).toISOString() : undefined,
          source_attribution: this.config.attribution,
          raw_payload: item
        };
        const validated = this.validateJob(candidate, String(candidate.source_external_id || titleText || "unknown"));
        if (validated) jobs.push(validated); else quarantined++;
      }

      return { sourceName: this.sourceName, success: true, jobs, totalFetched: items.length, quarantined };
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
