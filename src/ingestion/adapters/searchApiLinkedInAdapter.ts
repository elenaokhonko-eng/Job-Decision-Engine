/**
 * LinkedIn discovery through SearchAPI.
 *
 * One search per (lane query x location), then one job-details call per job id we have not
 * already observed, so every staged LinkedIn posting carries the full description. Ids already
 * present (from this source or from email alerts) cost no details credit. Ids beyond the
 * per-run details budget are left for a later run rather than staged with a snippet.
 */
import fs from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { z } from "zod";
import { BaseSourceAdapter, type AdapterFetchOptions, type AdapterResult } from "./baseAdapter.js";
import { ExtractedJob, SCHEMA_VERSION } from "../../contracts/index.js";
import { stripHtmlToText } from "../../security/sanitize.js";
import {
  linkedInJobUrl,
  type LinkedInJobSummary,
  type LinkedInTimePeriod,
  type SearchApiClient,
} from "../searchApi/searchApiClient.js";

const SearchApiLinkedInPlanSchema = z.object({
  schema_version: z.string().min(1),
  plan_version: z.string().min(1),
  time_period: z.enum(["last_hour", "last_day", "last_week", "last_month"]),
  max_details_per_run: z.number().int().min(0).max(500),
  locations: z.array(z.object({
    key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
    location: z.string().min(1).max(200),
    keyword_suffix: z.string().min(1).max(50).nullable(),
  })).min(1).max(5),
  lane_queries: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/), z.string().min(1).max(440)),
}).strict();

export type SearchApiLinkedInPlan = z.infer<typeof SearchApiLinkedInPlanSchema>;

export function loadSearchApiLinkedInPlan(
  filePath = path.resolve(process.cwd(), "config/source-plans/searchapi_linkedin.yml"),
): SearchApiLinkedInPlan {
  return SearchApiLinkedInPlanSchema.parse(load(fs.readFileSync(filePath, "utf8")));
}

export interface LinkedInSearchQuery {
  readonly queryId: string;
  readonly laneKey: string;
  readonly q: string;
  readonly location: string;
}

/** Expands the plan into one query per configured lane and location, in a stable order. */
export function linkedInSearchQueries(plan: SearchApiLinkedInPlan, laneKeys: readonly string[]): LinkedInSearchQuery[] {
  const queries: LinkedInSearchQuery[] = [];
  for (const laneKey of [...laneKeys].sort()) {
    const keywords = plan.lane_queries[laneKey];
    if (!keywords) continue;
    for (const location of plan.locations) {
      queries.push({
        queryId: `${laneKey}:${location.key}`,
        laneKey,
        q: location.keyword_suffix ? `(${keywords}) ${location.keyword_suffix}` : keywords,
        location: location.location,
      });
    }
  }
  return queries;
}

export interface SearchApiLinkedInRunStats {
  readonly searchesSent: number;
  readonly searchesFailed: number;
  readonly candidates: number;
  readonly alreadyObserved: number;
  readonly detailsFetched: number;
  readonly detailsFailed: number;
  readonly deferredForBudget: number;
  readonly budgetExhausted: boolean;
}

export interface SearchApiLinkedInAdapterOptions {
  readonly client: SearchApiClient;
  readonly queries: readonly LinkedInSearchQuery[];
  readonly timePeriod: LinkedInTimePeriod;
  readonly maxDetailsPerRun: number;
  /** Returns the subset of the given LinkedIn job ids that already have an observation. */
  readonly findObservedJobIds: (jobIds: readonly string[]) => Promise<ReadonlySet<string>>;
}

/** Work mode only when LinkedIn states it in the location label, e.g. "Singapore (Hybrid)". */
function workplaceTypeFromLocation(location: string | undefined): string {
  const match = location?.match(/\((remote|hybrid|on-?site)\)/i)?.[1]?.toLowerCase();
  if (match === "remote") return "REMOTE";
  if (match === "hybrid") return "HYBRID";
  if (match === "onsite" || match === "on-site") return "ONSITE";
  return "UNKNOWN";
}

export class SearchApiLinkedInAdapter extends BaseSourceAdapter {
  sourceName = "LINKEDIN" as const;
  private stats: SearchApiLinkedInRunStats | null = null;

  constructor(private readonly options: SearchApiLinkedInAdapterOptions) {
    super();
  }

  get lastRunStats(): SearchApiLinkedInRunStats | null {
    return this.stats;
  }

  async fetchJobs(_options: AdapterFetchOptions = {}): Promise<AdapterResult> {
    this.beginFetch();
    const failures: string[] = [];
    const candidates = new Map<string, { summary: LinkedInJobSummary; queryIds: string[] }>();
    let budgetExhausted = false;
    let searchesSent = 0;
    let searchesFailed = 0;

    for (const query of this.options.queries) {
      const result = await this.options.client.searchLinkedInJobs(
        { q: query.q, location: query.location, timePeriod: this.options.timePeriod },
        "DISCOVERY",
      );
      if (result.kind === "BUDGET_EXHAUSTED") {
        budgetExhausted = true;
        break;
      }
      searchesSent += 1;
      if (result.kind === "FAILED") {
        searchesFailed += 1;
        failures.push(`search ${query.queryId}: ${result.reason}`);
        continue;
      }
      for (const summary of result.data.jobs) {
        const existing = candidates.get(summary.job_id);
        if (existing) existing.queryIds.push(query.queryId);
        else candidates.set(summary.job_id, { summary, queryIds: [query.queryId] });
      }
    }

    const candidateIds = [...candidates.keys()];
    const observed = candidateIds.length > 0 ? await this.options.findObservedJobIds(candidateIds) : new Set<string>();
    const unseen = candidateIds.filter((jobId) => !observed.has(jobId));
    const jobs: ExtractedJob[] = [];
    let quarantined = 0;
    let detailsFetched = 0;
    let detailsFailed = 0;
    let attempted = 0;

    for (const jobId of unseen) {
      if (budgetExhausted || attempted >= this.options.maxDetailsPerRun) break;
      const result = await this.options.client.linkedInJobDetails(jobId, "DISCOVERY");
      if (result.kind === "BUDGET_EXHAUSTED") {
        budgetExhausted = true;
        break;
      }
      attempted += 1;
      if (result.kind === "FAILED") {
        detailsFailed += 1;
        failures.push(`details ${jobId}: ${result.reason}`);
        continue;
      }
      detailsFetched += 1;
      const detail = result.data;
      const { summary, queryIds } = candidates.get(jobId)!;
      const postingUrl = linkedInJobUrl(jobId);
      const rawPayload = {
        provider: "searchapi",
        matched_query_ids: queryIds,
        search_result: summary,
        job: detail,
        searchapi_evidence: result.evidence,
      };
      const candidate = {
        schema_version: SCHEMA_VERSION,
        source_external_id: postingUrl,
        company_name: detail.company_name,
        title: detail.title,
        location_raw: detail.location ?? summary.location ?? "Unknown",
        workplace_type_raw: workplaceTypeFromLocation(detail.location ?? summary.location),
        employment_type_raw: detail.employment_type ?? "UNKNOWN",
        compensation_raw: detail.salary ?? "UNKNOWN",
        employer_posting_url: postingUrl,
        application_url: postingUrl,
        canonical_apply_url: postingUrl,
        description_raw: stripHtmlToText(detail.description),
        source_attribution: "LinkedIn via SearchAPI",
        raw_payload: rawPayload,
      };
      const validated = this.validateJob(candidate, jobId);
      if (validated) jobs.push(validated);
      else quarantined += 1;
    }

    this.stats = {
      searchesSent,
      searchesFailed,
      candidates: candidateIds.length,
      alreadyObserved: candidateIds.length - unseen.length,
      detailsFetched,
      detailsFailed,
      deferredForBudget: unseen.length - attempted,
      budgetExhausted,
    };

    return {
      sourceName: this.sourceName,
      // A provider failure fails the plan run even when other queries staged jobs; a spent
      // budget does not, because the remaining ids are picked up by the next run.
      success: failures.length === 0,
      jobs,
      totalFetched: attempted,
      snapshotTotal: candidateIds.length,
      quarantined,
      quarantinedCandidates: this.getQuarantinedCandidates(),
      nextCursor: null,
      hasMore: false,
      ...(failures.length > 0 ? { error: failures.join("; ").slice(0, 2000) } : {}),
    };
  }
}
