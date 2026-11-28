/**
 * Builds the review lists from the stored posting records. Reads only: no decision, state or table changes, and nothing
 * is rejected. A job is a candidate when it is live, passed the gates, has the full posting text (v_job_content_state,
 * the rule under which no job is decided) and a link, is not a lead
 * (the catalog's lead definition, also before migration 123 is applied), is not known closed and was not rated before.
 * A posting rated, removed or known closed under any of its records stays out; one saved under any record is saved.
 * Only a confirmed closure counts: one read from page wording alone (to be checked by hand) is not verified.
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
import { classifyJob, roleKindOfTitle, type CompanyIndustryTags, type KnownWorkMode } from "../domain/jobClassifier.js";
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

/** In the order they are tried. Missing text is tried before the gates: no job is decided without it. */
export const REVIEW_EXCLUSIONS = [
  "ARCHIVED_OR_FIXTURE", "MANUALLY_REMOVED_OR_REJECTED", "NO_LINK", "LEAD", "KNOWN_CLOSED", "NO_FULL_TEXT",
  "NOT_GATE_PASSED",
] as const;
export type ReviewExclusion = (typeof REVIEW_EXCLUSIONS)[number];

export interface ReviewListResult {
  /** Records left out only because the full posting text is not stored, by role type and by saved or not. */
  readonly withoutFullText: {
    readonly byRoleType: Readonly<Record<string, number>>;
    readonly saved: number;
    readonly unsaved: number;
  };
  /** Candidates stored as closed from page wording alone: listed as not verified, for the coordinator to open. */
  readonly checkByHandIds: readonly string[];
  /** Records confirmed closed, and those left out with a removed or closed record of their posting. */
  readonly closedIds: readonly string[];
  readonly lists: ReviewLists;
  readonly eligible: number;
  readonly excluded: Record<ReviewExclusion, number>;
  readonly dropped: { rated: number; dismissed: number; duplicate: number; neverRole: number; neverSector: number };
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

/** The stored availability, except that a closure read from page wording alone is not a confirmed one. */
const availabilityOf = (job: ReviewJobRow): string | null =>
  job.closed_by_page_wording_only ? "UNKNOWN" : job.availability_state;

function exclusionOf(job: ReviewJobRow, leads: ReadonlySet<string>): ReviewExclusion | null {
  if (job.archived || job.test_fixture) return "ARCHIVED_OR_FIXTURE";
  if (job.processing_state === "MANUALLY_REMOVED" || job.processing_state === "HARD_REJECTED") return "MANUALLY_REMOVED_OR_REJECTED";
  if (safePostingLink(job.canonical_url) === null) return "NO_LINK";
  if (leads.has(job.id)) return "LEAD";
  if (availabilityOf(job) === "CLOSED") return "KNOWN_CLOSED";
  if (!job.content_complete || !job.description?.trim()) return "NO_FULL_TEXT";
  if (job.gate_decision !== "PASS") return "NOT_GATE_PASSED";
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
        dismissed: false,
        saved: true,
        candidate: null,
      });
    }
  }

  const excluded = Object.fromEntries(REVIEW_EXCLUSIONS.map((reason) => [reason, 0])) as Record<ReviewExclusion, number>;
  let withoutTopK = 0;
  const withoutFullText = { byRoleType: {} as Record<string, number>, saved: 0, unsaved: 0 };
  for (const job of jobs) {
    const own = seen.get(job.id) ?? [];
    const urls = [job.canonical_url, ...own.flatMap((s) => [s.source_url, s.canonical_apply_url])];
    const exclusion = exclusionOf(job, leadIds);
    const savedRecord = own.some((s) => isSaved(s.source_name));
    if (exclusion === "NO_FULL_TEXT" && !rated.has(job.id)) {
      withoutFullText[savedRecord ? "saved" : "unsaved"] += 1;
      // The role type comes from the title alone: there is no full text to read.
      const kind = roleKindOfTitle(job.title ?? "") ?? rules.fallbackKind(job.title ?? "");
      const type = design.role_types.find((entry) => kind !== null && entry.kinds.includes(kind))?.key ?? "UNKNOWN";
      withoutFullText.byRoleType[type] = (withoutFullText.byRoleType[type] ?? 0) + 1;
    }
    // Archived records are read to recognise their postings; only live and rated ones are counted.
    if (exclusion && (!job.archived || rated.has(job.id))) excluded[exclusion] += 1;
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
        description,
        workMode: knownWorkMode(job.workplace_type),
        classification: classifyJob(design, input.companyTags, {
          title,
          company: job.company_name,
          employerUnknown: rules.isUnknownEmployer(job.company_name),
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
      dismissed: job.processing_state === "MANUALLY_REMOVED" || availabilityOf(job) === "CLOSED",
      saved: savedRecord,
      candidate,
    });
  }

  const found = new Set(jobs.map((job) => job.id));
  const pool = collapsePool(records);
  return {
    withoutFullText,
    closedIds: [...jobs.filter((job) => availabilityOf(job) === "CLOSED").map((job) => job.id), ...pool.dismissedIds],
    checkByHandIds: jobs.filter((job) => job.closed_by_page_wording_only).map((job) => job.id),
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
