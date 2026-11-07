import { BaseSourceAdapter, type AdapterFetchOptions, type AdapterResult } from "./baseAdapter.js";
import { ExtractedJob, SCHEMA_VERSION } from "../../contracts/index.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  // SmartRecruiters' public Posting API response is narrowed at the external API boundary.
  return value as Record<string, unknown>;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function identifierText(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return optionalText(value);
}

/** SmartRecruiters company identifiers are case-sensitive (e.g. `Grab`, `Wise`). */
const SMARTRECRUITERS_COMPANY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const POSTING_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

/** The Posting API caps `limit` at 100 per list request. */
export const SMARTRECRUITERS_MAX_PAGE_SIZE = 100;
/** One posting's detail (four HTML sections) is small; bound it well below the list bound. */
export const SMARTRECRUITERS_DETAIL_MAX_BYTES = 2 * 1024 * 1024;

const SECTION_ORDER = ["companyDescription", "jobDescription", "qualifications", "additionalInformation"] as const;

export interface SmartRecruitersAdapterOptions {
  /** Pause between sequential posting-detail requests (courtesy rate limit). */
  readonly detailDelayMs?: number;
  /** Wall-clock budget for one page (list + details); exceeding it fails the page. */
  readonly pageBudgetMs?: number;
}

class SourceRunFailure extends Error {
  constructor(message: string, readonly isRateLimited = false) {
    super(message);
  }
}

/**
 * SmartRecruiters public Posting API.
 *
 * One `fetchJobs` call reads one list page (`limit` <= 100, `offset` from the cursor) and then
 * fetches each listed posting's detail sequentially for its full description, so a run makes at
 * most `limit + 1` requests per company. Any list or detail failure fails the whole page (the
 * checkpoint does not advance) instead of dropping or rejecting postings.
 *
 * An unknown company identifier returns HTTP 200 with `totalFound: 0`; that is reported as
 * "board not found", never as an empty success.
 */
export class SmartRecruitersAdapter extends BaseSourceAdapter {
  sourceName = "SMARTRECRUITERS" as const;
  private companyIdentifier: string;
  private detailDelayMs: number;
  private pageBudgetMs: number;

  constructor(companyIdentifier: string, options: SmartRecruitersAdapterOptions = {}) {
    super();
    if (!SMARTRECRUITERS_COMPANY_PATTERN.test(companyIdentifier)) {
      throw new Error(`Invalid SmartRecruiters company identifier: ${companyIdentifier}`);
    }
    this.companyIdentifier = companyIdentifier;
    this.timeoutMs = 15_000;
    this.detailDelayMs = Math.max(0, options.detailDelayMs ?? 1_000);
    this.pageBudgetMs = Math.max(1_000, options.pageBudgetMs ?? 300_000);
  }

  private companyBaseUrl(): string {
    return `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(this.companyIdentifier)}/postings`;
  }

  private async getJson(url: string, maxBytes: number | undefined, what: string): Promise<unknown> {
    const response = await this.fetchWithTimeout(url, { headers: { Accept: "application/json" } });
    if (response.status === 429) throw new SourceRunFailure(`429 Rate limited (${what})`, true);
    if (!response.ok) throw new SourceRunFailure(`HTTP ${response.status}: ${response.statusText} (${what})`);
    return this.readJsonResponse(response, maxBytes);
  }

  async fetchJobs(options: AdapterFetchOptions = {}): Promise<AdapterResult> {
    this.beginFetch();
    const startedAt = Date.now();
    const limit = Math.min(SMARTRECRUITERS_MAX_PAGE_SIZE, Math.max(1, options.limit ?? 50));
    const cursorOffset = options.cursor?.startsWith("offset:") ? Number(options.cursor.slice("offset:".length)) : null;
    const offset = Number.isInteger(cursorOffset) && Number(cursorOffset) >= 0
      ? Number(cursorOffset)
      : Math.max(0, options.page ?? 0) * limit;
    const listUrl = new URL(this.companyBaseUrl());
    listUrl.searchParams.set("limit", String(limit));
    listUrl.searchParams.set("offset", String(offset));

    try {
      const list = asRecord(await this.getJson(listUrl.toString(), undefined, "posting list"));
      const totalFound = list?.totalFound;
      if (!list || typeof totalFound !== "number" || !Number.isInteger(totalFound) || !Array.isArray(list.content)) {
        return this.errorResult("SmartRecruiters posting list is missing totalFound or content.");
      }
      if (totalFound === 0) {
        return this.errorResult(
          `SmartRecruiters company not found or has no public postings: ${this.companyIdentifier} (totalFound 0; identifiers are case-sensitive).`,
        );
      }
      const listed: unknown[] = list.content;
      this.assertRecordCount(listed, limit);

      const jobs: ExtractedJob[] = [];
      let quarantined = 0;
      for (const [index, rawListing] of listed.entries()) {
        if (Date.now() - startedAt > this.pageBudgetMs) {
          return this.errorResult(`SmartRecruiters page exceeded its ${this.pageBudgetMs}ms budget after ${index} of ${listed.length} posting details.`);
        }
        const listing = asRecord(rawListing);
        const postingId = listing ? identifierText(listing.id) : null;
        if (!listing || !postingId || !POSTING_ID_PATTERN.test(postingId)) {
          this.quarantine(postingId ?? `smartrecruiters:offset:${offset + index}`, rawListing, "SmartRecruiters listing has no valid posting id.");
          quarantined++;
          continue;
        }
        if (index > 0 && this.detailDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.detailDelayMs));
        const detail = asRecord(await this.getJson(
          `${this.companyBaseUrl()}/${encodeURIComponent(postingId)}`,
          SMARTRECRUITERS_DETAIL_MAX_BYTES,
          `posting ${postingId} detail`,
        ));
        if (!detail || identifierText(detail.id) !== postingId) {
          // A detail that does not belong to the listed posting is a provider contract failure.
          return this.errorResult(`SmartRecruiters detail for posting ${postingId} returned a different or missing posting id.`);
        }
        const job = this.mapPosting(listing, detail, postingId);
        if (job) jobs.push(job);
        else quarantined++;
      }

      const consumed = offset + listed.length;
      const hasMore = listed.length > 0 && consumed < totalFound;
      return {
        sourceName: this.sourceName,
        success: listed.length === 0 || jobs.length > 0,
        jobs,
        totalFetched: listed.length,
        snapshotTotal: totalFound,
        quarantined,
        quarantinedCandidates: this.getQuarantinedCandidates(),
        nextCursor: hasMore ? `offset:${consumed}` : null,
        hasMore,
      };
    } catch (err: any) {
      if (err instanceof SourceRunFailure) return this.errorResult(err.message, { isRateLimited: err.isRateLimited });
      const isTimeout = err?.name === "AbortError";
      return this.errorResult(
        isTimeout ? `Timeout after ${this.timeoutMs}ms` : (err.message || String(err))
      );
    }
  }

  private mapPosting(listing: Record<string, unknown>, detail: Record<string, unknown>, postingId: string): ExtractedJob | null {
    const title = optionalText(detail.name) ?? optionalText(listing.name);
    const sections = asRecord(asRecord(detail.jobAd)?.sections);
    const descriptionParts = SECTION_ORDER.flatMap((key) => {
      const section = asRecord(sections?.[key]);
      const body = this.sanitizeHtml(section?.text);
      if (!body) return [];
      const heading = optionalText(section?.title);
      return [heading ? `${heading}: ${body}` : body];
    });
    const description = descriptionParts.join("\n\n");
    if (!title || !description) {
      this.quarantine(postingId, detail, `SmartRecruiters posting is missing ${!title ? "a title" : "job ad sections"}.`);
      return null;
    }
    const company = asRecord(detail.company) ?? asRecord(listing.company);
    const location = asRecord(detail.location) ?? asRecord(listing.location);
    const locationLabel = optionalText(location?.fullLocation)
      ?.split(",").map((part) => part.trim()).filter(Boolean).join(", ")
      ?? [optionalText(location?.city), optionalText(location?.region), optionalText(location?.country)]
        .filter((part): part is string => part !== null).join(", ");
    // Only explicit flags count as evidence; absent or false flags stay UNKNOWN for verification.
    const workplaceType = location?.remote === true ? "REMOTE" : location?.hybrid === true ? "HYBRID" : "UNKNOWN";
    const employment = asRecord(detail.typeOfEmployment) ?? asRecord(listing.typeOfEmployment);
    const postingUrl = optionalText(detail.postingUrl)
      ?? `https://jobs.smartrecruiters.com/${encodeURIComponent(this.companyIdentifier)}/${encodeURIComponent(postingId)}`;
    const applyUrl = optionalText(detail.applyUrl) ?? postingUrl;
    const released = optionalText(detail.releasedDate) ?? optionalText(listing.releasedDate);
    const releasedAt = released && Number.isFinite(new Date(released).getTime()) ? new Date(released).toISOString() : undefined;
    const candidate = {
      schema_version: SCHEMA_VERSION,
      source_external_id: postingId,
      company_name: optionalText(company?.name) ?? this.companyIdentifier,
      title,
      location_raw: locationLabel || "Unknown",
      workplace_type_raw: workplaceType,
      employment_type_raw: optionalText(employment?.label) ?? "UNKNOWN",
      compensation_raw: "UNKNOWN",
      employer_posting_url: postingUrl,
      application_url: applyUrl,
      canonical_apply_url: applyUrl,
      description_raw: description,
      published_at: releasedAt,
      raw_payload: detail,
    };
    return this.validateJob(candidate, postingId);
  }
}
