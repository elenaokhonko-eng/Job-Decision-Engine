/**
 * The review lists: one per role type, an overall list drawn from them, and comparison jobs from the middle of the same
 * pool. Records of one posting are collapsed first. Deterministic for a given design, pool and seed. Pure.
 */
import { createHash } from "node:crypto";

import type { JobClassification } from "./jobClassifier.js";
import type { RankingDesign, RoleType } from "./rankingDesign.js";

export interface Candidate {
  readonly title: string;
  readonly company: string;
  readonly location: string;
  readonly link: string;
  readonly linkedInOnly: boolean;
  readonly availability: "OPEN" | "UNKNOWN";
  /** Top-K capability score, 0 to 100; null when the match holds no similarity. */
  readonly topK: number | null;
  readonly classification: JobClassification;
  /** The stored posting text. */
  readonly description: string;
  /** Every address the job was seen at: taken out of the text before the rating. */
  readonly sourceLinks: ReadonlyArray<string | null>;
  readonly workMode: "REMOTE" | "HYBRID" | "ONSITE" | null;
}

/** One stored record of a posting, as far as the lists need it. */
export interface PostingRecordEntry {
  readonly id: string;
  /** Keys under which two records are one posting. */
  readonly keys: readonly string[];
  /** Rated before: no record of the same posting is listed again. */
  readonly rated: boolean;
  /** Removed by the owner or known closed: the posting stays out under every record. */
  readonly dismissed: boolean;
  readonly saved: boolean;
  /** null when the record only identifies a posting (not a candidate itself). */
  readonly candidate: Candidate | null;
}

export interface PoolJob extends Candidate {
  readonly id: string;
  readonly saved: boolean;
}

export interface CollapsedPool {
  /** One entry per unrated, undismissed posting with a candidate record, without never roles and never sectors. */
  readonly eligible: PoolJob[];
  /** The same before never roles and never sectors are left out. */
  readonly postings: PoolJob[];
  readonly dropped: { rated: number; dismissed: number; duplicate: number; neverRole: number; neverSector: number };
  /** The candidate records of postings left out as removed or closed. */
  readonly dismissedIds: string[];
}

/** Records that share any key are one posting (transitively). */
function groupByKeys(records: readonly PostingRecordEntry[]): PostingRecordEntry[][] {
  const parent = records.map((_, index) => index);
  const find = (index: number): number => (parent[index] === index ? index : (parent[index] = find(parent[index]!)));
  const owner = new Map<string, number>();
  records.forEach((record, index) => {
    for (const key of record.keys) {
      const first = owner.get(key);
      if (first === undefined) owner.set(key, index);
      else parent[find(index)] = find(first);
    }
  });
  const groups = new Map<number, PostingRecordEntry[]>();
  records.forEach((record, index) => {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(record);
    groups.set(root, group);
  });
  return [...groups.values()];
}

export function collapsePool(records: readonly PostingRecordEntry[]): CollapsedPool {
  const eligible: PoolJob[] = [];
  const postings: PoolJob[] = [];
  const dismissedIds: string[] = [];
  const dropped = { rated: 0, dismissed: 0, duplicate: 0, neverRole: 0, neverSector: 0 };
  for (const group of groupByKeys(records)) {
    const candidates = group.filter((record) => record.candidate !== null);
    if (candidates.length === 0) continue;
    if (group.some((record) => record.rated)) {
      dropped.rated += candidates.length;
      continue;
    }
    if (group.some((record) => record.dismissed)) {
      dropped.dismissed += candidates.length;
      dismissedIds.push(...candidates.map((record) => record.id));
      continue;
    }
    dropped.duplicate += candidates.length - 1;
    // The record shown: one with a link beyond LinkedIn before a LinkedIn-only one, then the best score.
    const best = [...candidates].sort((a, b) =>
      Number(a.candidate!.linkedInOnly) - Number(b.candidate!.linkedInOnly)
      || (b.candidate!.topK ?? -1) - (a.candidate!.topK ?? -1)
      || a.id.localeCompare(b.id))[0]!;
    const job: PoolJob = {
      ...best.candidate!,
      id: best.id,
      saved: group.some((record) => record.saved),
      linkedInOnly: candidates.every((record) => record.candidate!.linkedInOnly),
    };
    postings.push(job);
    if (job.classification.status === "NEVER") dropped.neverRole += 1;
    else if (job.classification.sector === "NEVER") dropped.neverSector += 1;
    else eligible.push(job);
  }
  return { eligible, postings, dropped, dismissedIds };
}

export const seededHash = (seed: string, purpose: string, id: string): string =>
  createHash("sha256").update(`${seed}:${purpose}:${id}`).digest("hex");

const statusRank = (job: PoolJob) => (job.classification.status === "TARGET" ? 0 : 1);
const sectorRank = (job: PoolJob) => (job.classification.sector === "PREFERRED" ? 0 : 1);

type Order = (a: PoolJob, b: PoolJob) => number;

/** Target before neutral and transition, then preferred sector, then top-K (no score last). */
function standardOrder(seed: string): Order {
  return (a, b) =>
    statusRank(a) - statusRank(b)
    || sectorRank(a) - sectorRank(b)
    || (b.topK ?? -1) - (a.topK ?? -1)
    || seededHash(seed, "tie", a.id).localeCompare(seededHash(seed, "tie", b.id));
}

/** Heavy stakeholder load last, hands-on work first, then remote or hybrid in a preferred sector, then the standard order. */
function loadAwareOrder(seed: string): Order {
  const flexible = (job: PoolJob) => (job.classification.remoteOrHybrid && job.classification.sector === "PREFERRED" ? 0 : 1);
  const standard = standardOrder(seed);
  return (a, b) =>
    Number(a.classification.stakeholderHeavy) - Number(b.classification.stakeholderHeavy)
    || Number(b.classification.handsOn) - Number(a.classification.handsOn)
    || flexible(a) - flexible(b)
    || standard(a, b);
}

export interface RoleList {
  readonly type: RoleType;
  readonly eligible: number;
  readonly jobs: PoolJob[];
}

export interface ReviewLists {
  /** In priority order; a type with no eligible job has an empty list. */
  readonly byType: RoleList[];
  readonly overall: PoolJob[];
  readonly comparison: PoolJob[];
}

export function buildReviewLists(design: RankingDesign, eligible: readonly PoolJob[]): ReviewLists {
  const { size, overall_size, comparison_size, comparison_unknown_role_size, comparison_band, seed } = design.lists;
  const byType = [...design.role_types]
    .sort((a, b) => a.priority - b.priority)
    .map((type): RoleList => {
      const order = type.ordering === "LOAD_AWARE" ? loadAwareOrder(seed) : standardOrder(seed);
      const jobs = eligible.filter((job) => job.classification.roleType === type.key).sort(order);
      return { type, eligible: jobs.length, jobs: jobs.slice(0, size) };
    });

  // Round robin over the role-type lists: the best of each in priority order, then the second best.
  const overall: PoolJob[] = [];
  for (let rank = 0; rank < size; rank += 1) {
    for (const source of byType) {
      const job = source.jobs[rank];
      if (job && overall.length < overall_size) overall.push(job);
    }
  }

  // The comparison jobs: the design's band of the whole pool in the standard order, saved jobs included, listed jobs
  // not. A set number has an unknown role type and the rest a known one; a short group is never filled from the other.
  const ranked = [...eligible].sort(standardOrder(seed));
  const listed = new Set(byType.flatMap((list) => list.jobs.map((job) => job.id)));
  const band = ranked
    .slice(Math.floor(ranked.length * comparison_band[0]), Math.ceil(ranked.length * comparison_band[1]))
    .filter((job) => !listed.has(job.id))
    .sort((a, b) => seededHash(seed, "comparison", a.id).localeCompare(seededHash(seed, "comparison", b.id)));
  const comparison = [
    ...band.filter((job) => job.classification.roleType === null).slice(0, comparison_unknown_role_size),
    ...band.filter((job) => job.classification.roleType !== null).slice(0, comparison_size - comparison_unknown_role_size),
  ];
  return { byType, overall, comparison };
}

/** Every listed job once, in an order that says nothing about list or rank. */
export function sheetJobs(lists: ReviewLists, seed: string): PoolJob[] {
  const unique = new Map<string, PoolJob>();
  for (const job of [...lists.byType.flatMap((list) => list.jobs), ...lists.overall, ...lists.comparison]) unique.set(job.id, job);
  return [...unique.values()].sort((a, b) => seededHash(seed, "sheet", a.id).localeCompare(seededHash(seed, "sheet", b.id)));
}

/**
 * The same jobs in an order of their own, for the availability check: its output names lines and why a link was left
 * out, which must not point at rows of the sheet.
 */
export function jobIdOrder(lists: ReviewLists, seed: string): string[] {
  return sheetJobs(lists, seed)
    .map((job) => job.id)
    .sort((a, b) => seededHash(seed, "job-ids", a).localeCompare(seededHash(seed, "job-ids", b)));
}
