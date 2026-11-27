/**
 * Builds the review lists from the stored posting records. Reads only: no decision, state or table changes, and nothing
 * is rejected. A job is a candidate when it is live, passed the gates, has complete content and a link, is not a lead
 * (the catalog's lead definition, also before migration 123 is applied), is not known closed and was not rated before.
 */
import {
  selectJobSightings,
  selectMatchSimilarities,
  selectReviewJobs,
  type DecisionQueryable,
  type ReviewJobRow,
  type SightingRow,
  type SimilarityRow,
} from "../../../platform/persistence/decision/index.js";
import { listLeadJobsByDefinition, normalizeJobIdentity, type LeadJobs } from "../../catalog/index.js";
import { classifyJob, type CompanyIndustryTags, type KnownWorkMode } from "../domain/jobClassifier.js";
import { requireApprovedDesign, type RankingDesign, type RoleKind } from "../domain/rankingDesign.js";
import {
  buildReviewLists,
  collapsePool,
  type Candidate,
  type PoolJob,
  type PostingRecordEntry,
  type ReviewLists,
} from "../domain/reviewLists.js";
import { safePostingLink } from "../domain/reviewSheet.js";

export interface RankingEvidence {
  requirementType: string;
  importance: string;
  matchType: "EXACT" | "SEMANTIC" | "NO_MATCH" | "UNKNOWN";
  semanticScore: number | null;
}

/** Rules that live outside the module today; the composition root passes them in. */
export interface ReviewListRules {
  topKScore(rows: readonly RankingEvidence[]): number;
  externalClientFacing(description: string): boolean;
  peopleManagementCore(title: string, description: string): boolean;
  fallbackKind(title: string): RoleKind | null;
  normalizePostingUrl(url: string): string | null;
  isUnknownEmployer(name: string | null): boolean;
  readonly savedSourceNames: readonly string[];
}

export interface ReviewListInput {
  readonly workspaceId: string;
  readonly design: RankingDesign;
  readonly companyTags: readonly CompanyIndustryTags[];
  readonly ratedIds: readonly string[];
  readonly rules: ReviewListRules;
  /** The text of the lead definition migration, used when its view is not installed. */
  readonly leadDefinitionSql: string;
}

export const REVIEW_EXCLUSIONS = [
  "ARCHIVED_OR_FIXTURE", "MANUALLY_REMOVED_OR_REJECTED", "NOT_GATE_PASSED", "AWAITING_CONTENT", "NO_LINK", "LEAD",
  "KNOWN_CLOSED",
] as const;
export type ReviewExclusion = (typeof REVIEW_EXCLUSIONS)[number];

export interface ReviewListResult {
  readonly lists: ReviewLists;
  readonly eligible: number;
  readonly excluded: Record<ReviewExclusion, number>;
  readonly dropped: { rated: number; duplicate: number; neverRole: number; neverSector: number };
  /** Rated ids this database does not hold, so their other records cannot be recognised. */
  readonly ratedNotFound: number;
  /** Candidate records with no stored similarity: ordered after the scored ones. */
  readonly withoutTopK: number;
  /** One per unrated candidate posting, never roles and sectors included: for counting. */
  readonly postings: readonly PoolJob[];
  /** All lead records of the workspace, whatever else would also leave them out. */
  readonly leads: { readonly total: number; readonly source: LeadJobs["source"] };
}

/** A link on LinkedIn's site or short link, also when a redirect wrapper carries it. */
function linkedInLink(value: string): boolean {
  let text = value;
  for (let round = 0; round < 3; round += 1) {
    text = text.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  }
  return /\/\/(?:[a-z0-9-]+\.)*(?:linkedin\.com|lnkd\.in)(?::\d+)?\//i.test(text);
}

function knownWorkMode(value: string | null): KnownWorkMode {
  const mode = (value ?? "").trim().toUpperCase().replace(/[-_ ]/g, "");
  return mode === "REMOTE" || mode === "HYBRID" || mode === "ONSITE" ? mode : null;
}

const words = (value: string | null | undefined) => (value ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

interface PostingFacts {
  company: string | null;
  title: string | null;
  location: string | null;
  urls: ReadonlyArray<string | null>;
  hashes: ReadonlyArray<string | null>;
}

/**
 * The keys under which two records are one posting: the employer (as normalizeJobIdentity compares it) with the source
 * posting identity, with the link and the location or title, or with the title and location. No known employer, no key.
 */
function postingKeys(record: PostingFacts, rules: ReviewListRules): string[] {
  const names = normalizeJobIdentity(record);
  const company = rules.isUnknownEmployer(record.company) ? "" : names.employer;
  if (!company) return [];
  const title = words(record.title);
  const keys: string[] = [];
  for (const hash of record.hashes) if (hash?.trim()) keys.push(JSON.stringify(["id", company, hash.trim()]));
  for (const value of record.urls) {
    const url = value ? rules.normalizePostingUrl(value) : null;
    if (!url) continue;
    keys.push(JSON.stringify(["url-location", company, url, names.location]));
    if (title) keys.push(JSON.stringify(["url-title", company, url, title]));
  }
  if (title) keys.push(JSON.stringify(["company-title-location", company, title, names.location]));
  return keys;
}

function exclusionOf(job: ReviewJobRow, leads: ReadonlySet<string>): ReviewExclusion | null {
  if (job.archived || job.test_fixture) return "ARCHIVED_OR_FIXTURE";
  if (job.processing_state === "MANUALLY_REMOVED" || job.processing_state === "HARD_REJECTED") return "MANUALLY_REMOVED_OR_REJECTED";
  if (job.gate_decision !== "PASS") return "NOT_GATE_PASSED";
  if (!job.content_complete) return "AWAITING_CONTENT";
  if (safePostingLink(job.canonical_url) === null) return "NO_LINK";
  if (leads.has(job.id)) return "LEAD";
  if (job.availability_state === "CLOSED") return "KNOWN_CLOSED";
  return null;
}

function topKByJob(rows: readonly SimilarityRow[], rules: ReviewListRules): Map<string, number> {
  const byJob = new Map<string, RankingEvidence[]>();
  for (const row of rows) {
    const list = byJob.get(row.job_id) ?? [];
    list.push({
      requirementType: row.requirement_type,
      importance: row.importance,
      matchType: row.match_type as RankingEvidence["matchType"],
      semanticScore: row.semantic_score,
    });
    byJob.set(row.job_id, list);
  }
  // A match with no similarity at all has no score; it is never shown as zero.
  return new Map([...byJob]
    .filter(([, list]) => list.some((row) => row.semanticScore !== null))
    .map(([id, list]) => [id, rules.topKScore(list)]));
}

export async function buildReviewListsFromStore(db: DecisionQueryable, input: ReviewListInput): Promise<ReviewListResult> {
  const { workspaceId, design, rules } = input;
  requireApprovedDesign(design);
  // Job-board and aggregator jobs stay out, also on a database without migration 123.
  const leads = await listLeadJobsByDefinition(db, workspaceId, input.leadDefinitionSql);
  const leadIds = new Set(leads.ids);
  const rated = new Set(input.ratedIds.map((id) => id.toLowerCase()));

  const jobs = await selectReviewJobs(db, workspaceId, [...rated]);
  const sightings = await selectJobSightings(db, workspaceId, rules.savedSourceNames);
  const topK = topKByJob(await selectMatchSimilarities(db, workspaceId), rules);

  const isSaved = (source: string | null) => rules.savedSourceNames.includes((source ?? "").trim().toUpperCase());
  const seen = new Map<string, SightingRow[]>();
  const records: PostingRecordEntry[] = [];
  for (const sighting of sightings) {
    if (sighting.job_id) {
      const list = seen.get(sighting.job_id) ?? [];
      list.push(sighting);
      seen.set(sighting.job_id, list);
    } else if (isSaved(sighting.source_name)) {
      // A saved posting counts even when it is linked to no canonical job.
      records.push({
        id: "",
        keys: postingKeys({
          company: sighting.company_name, title: sighting.title, location: sighting.location_raw,
          urls: [sighting.source_url, sighting.canonical_apply_url], hashes: [],
        }, rules),
        rated: false,
        saved: true,
        candidate: null,
      });
    }
  }

  const excluded = Object.fromEntries(REVIEW_EXCLUSIONS.map((reason) => [reason, 0])) as Record<ReviewExclusion, number>;
  let withoutTopK = 0;
  for (const job of jobs) {
    const own = seen.get(job.id) ?? [];
    const urls = [job.canonical_url, ...own.flatMap((s) => [s.source_url, s.canonical_apply_url])];
    const exclusion = exclusionOf(job, leadIds);
    if (exclusion) excluded[exclusion] += 1;
    let candidate: Candidate | null = null;
    if (!exclusion) {
      const title = job.title ?? "";
      const description = job.description ?? "";
      candidate = {
        title,
        company: job.company_name ?? "not stated",
        location: job.location?.trim() || "not stated",
        link: safePostingLink(job.canonical_url)!,
        linkedInOnly: urls.filter((url): url is string => safePostingLink(url) !== null).every((url) => linkedInLink(url!)),
        availability: job.availability_state === "OPEN" ? "OPEN" : "UNKNOWN",
        topK: topK.get(job.id) ?? null,
        classification: classifyJob(design, input.companyTags, {
          title,
          company: job.company_name,
          description,
          workMode: knownWorkMode(job.workplace_type),
          externalClientFacing: rules.externalClientFacing(description),
          peopleManagementCore: rules.peopleManagementCore(title, description),
          fallbackKind: rules.fallbackKind(title),
        }),
      };
      if (candidate.topK === null) withoutTopK += 1;
    }
    records.push({
      id: job.id,
      keys: [
        JSON.stringify(["record", job.id]),
        ...postingKeys({ company: job.company_name, title: job.title, location: job.location, urls, hashes: job.identity_hashes ?? [] }, rules),
      ],
      rated: rated.has(job.id),
      saved: own.some((s) => isSaved(s.source_name)),
      candidate,
    });
  }

  const found = new Set(jobs.map((job) => job.id));
  const pool = collapsePool(records);
  return {
    lists: buildReviewLists(design, pool.eligible),
    eligible: pool.eligible.length,
    excluded,
    dropped: pool.dropped,
    ratedNotFound: [...rated].filter((id) => !found.has(id)).length,
    withoutTopK,
    postings: pool.postings,
    leads: { total: leadIds.size, source: leads.source },
  };
}
