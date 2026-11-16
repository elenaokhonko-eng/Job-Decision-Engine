/**
 * Pure maths and classification for the ranking measurement tool
 * (`scripts/measure_ranking.ts`). No database or network access lives here so
 * every figure can be checked against a known fixture.
 */
import { createHash } from "node:crypto";

export type Split = "FIT" | "HOLDOUT";

/** Share of jobs that go to the FIT split. The rest is the held-out report set. */
export const FIT_SPLIT_PERCENT = 80;

/**
 * Stable 80/20 split keyed on the job id alone, so a job never changes side
 * when other jobs are added or removed.
 */
export function assignSplit(jobId: string): Split {
  const digest = createHash("sha256").update(jobId).digest();
  const bucket = digest.readUInt32BE(0) % 100;
  return bucket < FIT_SPLIT_PERCENT ? "FIT" : "HOLDOUT";
}

export type NonFitCategory =
  | "CPP_EMBEDDED_FIRMWARE"
  | "FRONTEND"
  | "MOBILE"
  | "GAME"
  | "QA_TEST"
  | "BACKEND_GENERAL_SOFTWARE";

/**
 * Titles the owner would never take. DevOps, cloud, platform and architect
 * titles are deliberately absent: they sit inside the target lanes.
 */
const NON_FIT_RULES: ReadonlyArray<{ category: NonFitCategory; pattern: RegExp }> = [
  {
    category: "CPP_EMBEDDED_FIRMWARE",
    // "Embedded Finance" is a fintech product term, so "embedded" needs an engineering word after it.
    pattern:
      /(?:\bc\+\+|\bcpp\b|\bfirmware\b|\bembedded\s+(?:\w+\s+)?(?:software|systems?|linux|engineer|developer|c\b))/i,
  },
  { category: "FRONTEND", pattern: /\b(?:front[\s-]?end|ui\s+developer|react\s+developer|angular\s+developer)\b/i },
  // "Mobile Banking Product Manager" is not a mobile developer, so a developer word must follow.
  { category: "MOBILE", pattern: /\b(?:ios|android|mobile)\s+(?:\w+\s+)?(?:developer|engineer|dev)\b/i },
  { category: "GAME", pattern: /\b(?:game\s+(?:developer|engineer|programmer)|gameplay\s+(?:engineer|programmer)|unity\s+developer|unreal\s+(?:engine\s+)?developer)\b/i },
  {
    category: "QA_TEST",
    pattern: /\b(?:qa|quality\s+assurance|test\s+engineer|sdet|software\s+tester|test\s+automation|tester)\b/i,
  },
];

/**
 * Backend and general software titles count as non-fits only when the title
 * carries no signal from a target lane (AI, data, cloud, platform, product,
 * security, compliance, finance and similar).
 */
const BACKEND_GENERAL_PATTERN =
  /\b(?:back[\s-]?end|full[\s-]?stack|software\s+(?:engineer|developer)|java\s+developer|python\s+developer|\.net\s+developer|php\s+developer|golang\s+developer)\b/i;

const LANE_SIGNAL_PATTERN =
  /\b(?:ai|a\.i\.|ml|llm|genai|machine\s+learning|data|analytics?|cloud|devops|sre|platform|infrastructure|architect|product|programme|program|transformation|security|compliance|regtech|legal|risk|quant|trading|fintech|health|bio|pharma|research|investigat|forensic)\b/i;

export function classifyNonFitTitle(title: string): NonFitCategory | null {
  const normalized = title.trim();
  if (!normalized) return null;
  for (const rule of NON_FIT_RULES) {
    if (rule.pattern.test(normalized)) return rule.category;
  }
  if (BACKEND_GENERAL_PATTERN.test(normalized) && !LANE_SIGNAL_PATTERN.test(normalized)) {
    return "BACKEND_GENERAL_SOFTWARE";
  }
  return null;
}

/**
 * Probability that a randomly chosen positive outscores a randomly chosen
 * negative (ties count one half). 0.5 is a coin flip; 1.0 is always right.
 * Returns null when either side is empty, because the figure is undefined.
 */
export function separation(positives: readonly number[], negatives: readonly number[]): number | null {
  if (positives.length === 0 || negatives.length === 0) return null;
  const sortedNegatives = [...negatives].sort((a, b) => a - b);
  let wins = 0;
  for (const positive of positives) {
    const below = lowerBound(sortedNegatives, positive);
    const upTo = upperBound(sortedNegatives, positive);
    wins += below + (upTo - below) * 0.5;
  }
  return wins / (positives.length * negatives.length);
}

function lowerBound(sorted: readonly number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(sorted: readonly number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface RankedItem {
  readonly jobId: string;
  readonly score: number;
  readonly isSaved: boolean;
}

/**
 * Number of saved jobs among the top `n` by score. Ties break on job id so
 * the figure is reproducible.
 */
export function savedInTopN(items: readonly RankedItem[], n: number): { readonly saved: number; readonly size: number } {
  const ordered = [...items].sort((a, b) => b.score - a.score || (a.jobId < b.jobId ? -1 : 1));
  const top = ordered.slice(0, Math.max(0, n));
  return { saved: top.filter((item) => item.isSaved).length, size: top.length };
}

export function share(count: number, total: number): number | null {
  return total === 0 ? null : count / total;
}

/** Outcomes that put a job in front of the owner. */
export function isReviewOrPriority(outcome: string | null | undefined, eligibility: string | null | undefined): boolean {
  return (outcome === "REVIEW" || outcome === "PRIORITY") && eligibility === "ELIGIBLE";
}

export type SavedExclusionReason =
  | "MEASURED"
  | "DUPLICATE_OBSERVATION"
  | "NOT_NORMALIZED"
  | "JOB_ARCHIVED"
  | "NO_COMPLETED_MATCH"
  | "NO_DECISION";

export interface SavedObservationState {
  readonly jobId: string | null;
  readonly jobArchived: boolean;
  readonly hasCompletedMatch: boolean;
  readonly hasDecision: boolean;
}

/**
 * Gives every saved observation exactly one reason, in a fixed priority
 * order, so the reason counts always add up to the observation total.
 */
export function classifySavedObservations(
  observations: readonly SavedObservationState[],
): { readonly reasons: ReadonlyArray<SavedExclusionReason>; readonly counts: Record<SavedExclusionReason, number> } {
  const counts: Record<SavedExclusionReason, number> = {
    MEASURED: 0,
    DUPLICATE_OBSERVATION: 0,
    NOT_NORMALIZED: 0,
    JOB_ARCHIVED: 0,
    NO_COMPLETED_MATCH: 0,
    NO_DECISION: 0,
  };
  const seenMeasured = new Set<string>();
  const reasons: SavedExclusionReason[] = observations.map((observation) => {
    let reason: SavedExclusionReason;
    if (!observation.jobId) reason = "NOT_NORMALIZED";
    else if (observation.jobArchived) reason = "JOB_ARCHIVED";
    else if (!observation.hasCompletedMatch) reason = "NO_COMPLETED_MATCH";
    else if (!observation.hasDecision) reason = "NO_DECISION";
    else if (seenMeasured.has(observation.jobId)) reason = "DUPLICATE_OBSERVATION";
    else {
      seenMeasured.add(observation.jobId);
      reason = "MEASURED";
    }
    counts[reason] += 1;
    return reason;
  });
  return { reasons, counts };
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

export interface MeasuredJobRow {
  readonly jobId: string;
  readonly title: string;
  readonly matchScore: number;
  readonly coverageScore: number | null;
  readonly avgSimilarity: number | null;
  readonly outcome: string | null;
  readonly eligibility: string | null;
}

export interface SavedObservationRow extends SavedObservationState {
  readonly observationId: string;
  readonly job: MeasuredJobRow | null;
  /** canonical_jobs.processing_state; explains why a job has no completed match. */
  readonly processingState?: string | null;
}

export type SavedJobReason = "MEASURED" | "JOB_ARCHIVED" | "NO_COMPLETED_MATCH" | "NO_DECISION";

export interface GroupFigures {
  readonly savedCount: number;
  readonly nonFitCount: number;
  readonly separationMatchScore: number | null;
  readonly separationCoverage: number | null;
  readonly separationAvgSimilarity: number | null;
  readonly medianMatchScoreSaved: number | null;
  readonly medianMatchScoreNonFit: number | null;
  readonly medianCoverageSaved: number | null;
  readonly medianCoverageNonFit: number | null;
  readonly medianAvgSimilaritySaved: number | null;
  readonly medianAvgSimilarityNonFit: number | null;
  readonly savedReviewOrPriority: number;
  readonly nonFitReviewOrPriority: number;
  readonly savedReviewOrPriorityShare: number | null;
  readonly nonFitReviewOrPriorityShare: number | null;
  readonly top10: { readonly saved: number; readonly size: number };
  readonly top50: { readonly saved: number; readonly size: number };
  /** Share of saved jobs in the pool; the Top-N hit rate is read against this. */
  readonly poolSavedShare: number | null;
}

export interface MeasurementReport {
  readonly observationTotal: number;
  readonly exclusionCounts: Record<SavedExclusionReason, number>;
  /** Distinct canonical jobs behind the saved observations (one saved job can have many observations). */
  readonly distinctSavedJobs: number;
  readonly jobReasonCounts: Record<SavedJobReason, number>;
  /** For saved jobs with no completed match: processing_state -> job count. */
  readonly noMatchByState: Record<string, number>;
  readonly nonFitCandidatesExcludedBecauseSaved: number;
  readonly nonFitCategoryCounts: Record<NonFitCategory, number>;
  readonly nonFitTitleSamples: Record<NonFitCategory, string[]>;
  readonly all: GroupFigures;
  readonly fit: GroupFigures;
  readonly holdout: GroupFigures;
}

function numbers(values: ReadonlyArray<number | null>): number[] {
  return values.filter((value): value is number => value !== null && Number.isFinite(value));
}

function figuresFor(saved: readonly MeasuredJobRow[], nonFit: readonly MeasuredJobRow[]): GroupFigures {
  const savedReview = saved.filter((job) => isReviewOrPriority(job.outcome, job.eligibility)).length;
  const nonFitReview = nonFit.filter((job) => isReviewOrPriority(job.outcome, job.eligibility)).length;
  const pool: RankedItem[] = [
    ...saved.map((job) => ({ jobId: job.jobId, score: job.matchScore, isSaved: true })),
    ...nonFit.map((job) => ({ jobId: job.jobId, score: job.matchScore, isSaved: false })),
  ];
  return {
    savedCount: saved.length,
    nonFitCount: nonFit.length,
    separationMatchScore: separation(saved.map((j) => j.matchScore), nonFit.map((j) => j.matchScore)),
    separationCoverage: separation(numbers(saved.map((j) => j.coverageScore)), numbers(nonFit.map((j) => j.coverageScore))),
    separationAvgSimilarity: separation(
      numbers(saved.map((j) => j.avgSimilarity)),
      numbers(nonFit.map((j) => j.avgSimilarity)),
    ),
    medianMatchScoreSaved: median(saved.map((j) => j.matchScore)),
    medianMatchScoreNonFit: median(nonFit.map((j) => j.matchScore)),
    medianCoverageSaved: median(numbers(saved.map((j) => j.coverageScore))),
    medianCoverageNonFit: median(numbers(nonFit.map((j) => j.coverageScore))),
    medianAvgSimilaritySaved: median(numbers(saved.map((j) => j.avgSimilarity))),
    medianAvgSimilarityNonFit: median(numbers(nonFit.map((j) => j.avgSimilarity))),
    savedReviewOrPriority: savedReview,
    nonFitReviewOrPriority: nonFitReview,
    savedReviewOrPriorityShare: share(savedReview, saved.length),
    nonFitReviewOrPriorityShare: share(nonFitReview, nonFit.length),
    top10: savedInTopN(pool, 10),
    top50: savedInTopN(pool, 50),
    poolSavedShare: share(saved.length, saved.length + nonFit.length),
  };
}

/**
 * Builds the full report from already-loaded rows. `candidates` are completed,
 * non-archived jobs; any that are also saved are dropped from the non-fit set.
 */
export function buildMeasurementReport(
  savedObservations: readonly SavedObservationRow[],
  candidates: readonly MeasuredJobRow[],
): MeasurementReport {
  const { reasons, counts } = classifySavedObservations(savedObservations);
  const savedJobs: MeasuredJobRow[] = [];
  savedObservations.forEach((observation, index) => {
    if (reasons[index] === "MEASURED" && observation.job) savedJobs.push(observation.job);
  });
  const savedIds = new Set(
    savedObservations.map((o) => o.jobId).filter((id): id is string => id !== null),
  );

  // Job-level view: one verdict per distinct saved job, using its first observation.
  const jobReasonCounts: Record<SavedJobReason, number> = {
    MEASURED: 0,
    JOB_ARCHIVED: 0,
    NO_COMPLETED_MATCH: 0,
    NO_DECISION: 0,
  };
  const noMatchByState: Record<string, number> = {};
  const seenJobs = new Set<string>();
  for (const observation of savedObservations) {
    if (!observation.jobId || seenJobs.has(observation.jobId)) continue;
    seenJobs.add(observation.jobId);
    if (observation.jobArchived) jobReasonCounts.JOB_ARCHIVED += 1;
    else if (!observation.hasCompletedMatch) {
      jobReasonCounts.NO_COMPLETED_MATCH += 1;
      const state = observation.processingState ?? "UNKNOWN";
      noMatchByState[state] = (noMatchByState[state] ?? 0) + 1;
    } else if (!observation.hasDecision) jobReasonCounts.NO_DECISION += 1;
    else jobReasonCounts.MEASURED += 1;
  }

  const nonFitCategoryCounts: Record<NonFitCategory, number> = {
    CPP_EMBEDDED_FIRMWARE: 0,
    FRONTEND: 0,
    MOBILE: 0,
    GAME: 0,
    QA_TEST: 0,
    BACKEND_GENERAL_SOFTWARE: 0,
  };
  const nonFitTitleSamples: Record<NonFitCategory, string[]> = {
    CPP_EMBEDDED_FIRMWARE: [],
    FRONTEND: [],
    MOBILE: [],
    GAME: [],
    QA_TEST: [],
    BACKEND_GENERAL_SOFTWARE: [],
  };
  const nonFitJobs: MeasuredJobRow[] = [];
  let excludedBecauseSaved = 0;
  for (const candidate of candidates) {
    const category = classifyNonFitTitle(candidate.title);
    if (!category) continue;
    if (savedIds.has(candidate.jobId)) {
      excludedBecauseSaved += 1;
      continue;
    }
    nonFitCategoryCounts[category] += 1;
    if (nonFitTitleSamples[category].length < 5) nonFitTitleSamples[category].push(candidate.title);
    nonFitJobs.push(candidate);
  }

  const bySplit = (rows: readonly MeasuredJobRow[], split: Split) => rows.filter((row) => assignSplit(row.jobId) === split);
  return {
    observationTotal: savedObservations.length,
    exclusionCounts: counts,
    distinctSavedJobs: seenJobs.size,
    jobReasonCounts,
    noMatchByState,
    nonFitCandidatesExcludedBecauseSaved: excludedBecauseSaved,
    nonFitCategoryCounts,
    nonFitTitleSamples,
    all: figuresFor(savedJobs, nonFitJobs),
    fit: figuresFor(bySplit(savedJobs, "FIT"), bySplit(nonFitJobs, "FIT")),
    holdout: figuresFor(bySplit(savedJobs, "HOLDOUT"), bySplit(nonFitJobs, "HOLDOUT")),
  };
}
