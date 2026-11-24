/**
 * Ranking benchmark: pure maths over a labelled synthetic fixture.
 *
 * Answers one question for a pull request: does the ordering of labelled jobs
 * get better or worse than the recorded baseline? It is information, not a
 * gate. The fixture holds frozen scorer output for fictional jobs; it contains
 * no real titles, employers, salaries or profile data. No database, network or
 * clock is used, so every figure is repeatable and can be checked by hand.
 *
 * Reuses the maths of the live measurement (`rankingMeasurement.ts`) so the two
 * tools agree on what "separation" means.
 */
import { z } from "zod";

import { isReviewOrPriority, median, separation, share } from "./rankingMeasurement.js";

export const BENCHMARK_FIXTURE_VERSION = 1;

const BenchmarkJobSchema = z
  .object({
    id: z.string().min(1),
    label: z.enum(["FIT", "NON_FIT"]),
    matchScore: z.number().finite(),
    coverageScore: z.number().finite().nullable(),
    outcome: z.string().nullable(),
    eligibility: z.string().nullable(),
  })
  .strict();

export const BenchmarkFixtureSchema = z
  .object({
    fixture_notice: z.string().min(1),
    version: z.literal(BENCHMARK_FIXTURE_VERSION),
    jobs: z.array(BenchmarkJobSchema).min(2),
  })
  .strict()
  .superRefine((fixture, ctx) => {
    const ids = new Set<string>();
    for (const job of fixture.jobs) {
      if (ids.has(job.id)) ctx.addIssue({ code: "custom", message: `duplicate job id ${job.id}` });
      ids.add(job.id);
    }
    if (!fixture.jobs.some((j) => j.label === "FIT") || !fixture.jobs.some((j) => j.label === "NON_FIT")) {
      ctx.addIssue({ code: "custom", message: "fixture needs at least one FIT and one NON_FIT job" });
    }
  });

export type BenchmarkFixture = z.infer<typeof BenchmarkFixtureSchema>;
export type BenchmarkJob = BenchmarkFixture["jobs"][number];

export interface RankingBenchmarkReport {
  readonly fitCount: number;
  readonly nonFitCount: number;
  /** Chance a random FIT job outscores a random NON_FIT job (0.5 is a coin flip). */
  readonly separationMatchScore: number | null;
  readonly separationCoverage: number | null;
  /** Share of the top 5 and top 10 by match score that are FIT. */
  readonly precisionAt5: number | null;
  readonly precisionAt10: number | null;
  /** 1 / rank of the first FIT job; 0 when none. */
  readonly firstFitReciprocalRank: number;
  readonly medianMatchScoreFit: number | null;
  readonly medianMatchScoreNonFit: number | null;
  readonly fitInReviewOrPriorityShare: number | null;
  readonly nonFitInReviewOrPriorityShare: number | null;
}

/** Highest score first; ties break on id so the figure is reproducible. */
function rankByScore(jobs: readonly BenchmarkJob[]): BenchmarkJob[] {
  return [...jobs].sort((a, b) => b.matchScore - a.matchScore || (a.id < b.id ? -1 : 1));
}

function precisionAt(ranked: readonly BenchmarkJob[], n: number): number | null {
  const top = ranked.slice(0, n);
  return top.length === 0 ? null : top.filter((j) => j.label === "FIT").length / top.length;
}

function coverageOf(jobs: readonly BenchmarkJob[]): number[] {
  return jobs.flatMap((j) => (j.coverageScore === null ? [] : [j.coverageScore]));
}

export function runRankingBenchmark(input: unknown): RankingBenchmarkReport {
  const fixture = BenchmarkFixtureSchema.parse(input);
  const fit = fixture.jobs.filter((j) => j.label === "FIT");
  const nonFit = fixture.jobs.filter((j) => j.label === "NON_FIT");
  const ranked = rankByScore(fixture.jobs);
  const firstFitIndex = ranked.findIndex((j) => j.label === "FIT");
  const inReview = (jobs: readonly BenchmarkJob[]) =>
    jobs.filter((j) => isReviewOrPriority(j.outcome, j.eligibility)).length;

  return {
    fitCount: fit.length,
    nonFitCount: nonFit.length,
    separationMatchScore: separation(fit.map((j) => j.matchScore), nonFit.map((j) => j.matchScore)),
    separationCoverage: separation(coverageOf(fit), coverageOf(nonFit)),
    precisionAt5: precisionAt(ranked, 5),
    precisionAt10: precisionAt(ranked, 10),
    firstFitReciprocalRank: firstFitIndex < 0 ? 0 : 1 / (firstFitIndex + 1),
    medianMatchScoreFit: median(fit.map((j) => j.matchScore)),
    medianMatchScoreNonFit: median(nonFit.map((j) => j.matchScore)),
    fitInReviewOrPriorityShare: share(inReview(fit), fit.length),
    nonFitInReviewOrPriorityShare: share(inReview(nonFit), nonFit.length),
  };
}

export type BenchmarkVerdict = "SAME" | "BETTER" | "WORSE" | "NO_BASELINE";

export interface BenchmarkComparison {
  readonly verdict: BenchmarkVerdict;
  /** Per-figure change (current minus baseline), only for figures present in both. */
  readonly deltas: Readonly<Record<string, number>>;
  /** Figures that moved the wrong way by more than the tolerance. */
  readonly worse: readonly string[];
  readonly better: readonly string[];
}

/** For each figure: does a higher value mean a better ranking? */
const HIGHER_IS_BETTER: Readonly<Record<string, boolean>> = {
  separationMatchScore: true,
  separationCoverage: true,
  precisionAt5: true,
  precisionAt10: true,
  firstFitReciprocalRank: true,
  fitInReviewOrPriorityShare: true,
  nonFitInReviewOrPriorityShare: false,
};

export const DEFAULT_TOLERANCE = 0.01;

export function compareToBaseline(
  current: RankingBenchmarkReport,
  baseline: RankingBenchmarkReport | null,
  tolerance: number = DEFAULT_TOLERANCE,
): BenchmarkComparison {
  if (!baseline) return { verdict: "NO_BASELINE", deltas: {}, worse: [], better: [] };
  const deltas: Record<string, number> = {};
  const worse: string[] = [];
  const better: string[] = [];
  for (const [key, higherIsBetter] of Object.entries(HIGHER_IS_BETTER)) {
    const now = (current as unknown as Record<string, number | null>)[key];
    const before = (baseline as unknown as Record<string, number | null>)[key];
    if (now === null || now === undefined || before === null || before === undefined) continue;
    const delta = now - before;
    deltas[key] = delta;
    if (Math.abs(delta) <= tolerance) continue;
    if (delta > 0 === higherIsBetter) better.push(key);
    else worse.push(key);
  }
  const verdict: BenchmarkVerdict = worse.length > 0 ? "WORSE" : better.length > 0 ? "BETTER" : "SAME";
  return { verdict, deltas, worse, better };
}

const fmt = (value: number | null, digits = 3): string => (value === null ? "n/a" : value.toFixed(digits));

/** Markdown for a CI step summary. */
export function formatBenchmarkMarkdown(report: RankingBenchmarkReport, comparison: BenchmarkComparison): string {
  const delta = (key: string): string => {
    const d = comparison.deltas[key];
    return d === undefined ? "" : `${d >= 0 ? "+" : ""}${d.toFixed(3)}`;
  };
  const rows: Array<[string, string, string]> = [
    ["Separation (match score)", fmt(report.separationMatchScore), delta("separationMatchScore")],
    ["Separation (coverage)", fmt(report.separationCoverage), delta("separationCoverage")],
    ["Precision at 5", fmt(report.precisionAt5), delta("precisionAt5")],
    ["Precision at 10", fmt(report.precisionAt10), delta("precisionAt10")],
    ["First fit, reciprocal rank", fmt(report.firstFitReciprocalRank), delta("firstFitReciprocalRank")],
    ["Fit jobs at Review or Priority", fmt(report.fitInReviewOrPriorityShare), delta("fitInReviewOrPriorityShare")],
    ["Non-fit jobs at Review or Priority", fmt(report.nonFitInReviewOrPriorityShare), delta("nonFitInReviewOrPriorityShare")],
  ];
  return [
    "### Ranking benchmark (information only)",
    "",
    `Synthetic fixture: ${report.fitCount} fit, ${report.nonFitCount} non-fit. Verdict against baseline: **${comparison.verdict}**` +
      (comparison.worse.length ? ` (worse: ${comparison.worse.join(", ")})` : ""),
    "",
    "| Figure | Now | Change vs baseline |",
    "|---|---|---|",
    ...rows.map(([name, now, change]) => `| ${name} | ${now} | ${change} |`),
    "",
    "Separation is the chance a random fit job outscores a random non-fit job (0.5 is a coin flip).",
  ].join("\n");
}
