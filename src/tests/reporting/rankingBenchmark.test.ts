import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  compareToBaseline,
  formatBenchmarkMarkdown,
  runRankingBenchmark,
  type RankingBenchmarkReport,
} from "../../reporting/rankingBenchmark.js";

function job(id: string, label: "FIT" | "NON_FIT", matchScore: number, outcome: string | null = null) {
  return { id, label, matchScore, coverageScore: matchScore, outcome, eligibility: outcome ? "ELIGIBLE" : null };
}

function fixture(jobs: ReturnType<typeof job>[]) {
  return { fixture_notice: "Synthetic data only.", version: 1, jobs };
}

// Expected figures below are worked out by hand from the definitions.
describe("runRankingBenchmark", () => {
  it("is perfect when every fit outscores every non-fit", () => {
    const report = runRankingBenchmark(
      fixture([job("a", "FIT", 90), job("b", "FIT", 80), job("c", "NON_FIT", 20), job("d", "NON_FIT", 10)]),
    );
    expect(report.separationMatchScore).toBe(1);
    expect(report.precisionAt5).toBe(0.5); // 2 fit among 4 jobs in the top 5
    expect(report.firstFitReciprocalRank).toBe(1);
  });

  it("counts one inversion as 3 of 4 pairs won", () => {
    // fit 90, 30 vs non-fit 50, 10: pairs (90>50, 90>10, 30<50, 30>10) -> 3/4.
    const report = runRankingBenchmark(
      fixture([job("a", "FIT", 90), job("b", "FIT", 30), job("c", "NON_FIT", 50), job("d", "NON_FIT", 10)]),
    );
    expect(report.separationMatchScore).toBe(0.75);
  });

  it("reports the reciprocal rank of the first fit job", () => {
    const report = runRankingBenchmark(
      fixture([job("n1", "NON_FIT", 90), job("n2", "NON_FIT", 80), job("f1", "FIT", 70), job("f2", "FIT", 10)]),
    );
    expect(report.firstFitReciprocalRank).toBeCloseTo(1 / 3, 10);
  });

  it("breaks score ties on id, so precision does not depend on input order", () => {
    const a = runRankingBenchmark(fixture([job("b", "NON_FIT", 5), job("a", "FIT", 5)]));
    const b = runRankingBenchmark(fixture([job("a", "FIT", 5), job("b", "NON_FIT", 5)]));
    expect(a).toEqual(b);
    expect(a.firstFitReciprocalRank).toBe(1);
  });

  it("measures Review or Priority shares for both labels", () => {
    const report = runRankingBenchmark(
      fixture([
        job("a", "FIT", 90, "PRIORITY"),
        job("b", "FIT", 80, "SKIP"),
        job("c", "NON_FIT", 70, "REVIEW"),
        job("d", "NON_FIT", 10, "SKIP"),
      ]),
    );
    expect(report.fitInReviewOrPriorityShare).toBe(0.5);
    expect(report.nonFitInReviewOrPriorityShare).toBe(0.5);
  });

  it("rejects a fixture with a duplicate id, one label only, or an unknown field", () => {
    expect(() => runRankingBenchmark(fixture([job("a", "FIT", 1), job("a", "NON_FIT", 2)]))).toThrow(/duplicate/);
    expect(() => runRankingBenchmark(fixture([job("a", "FIT", 1), job("b", "FIT", 2)]))).toThrow(/FIT and one NON_FIT/);
    const extra = { ...fixture([job("a", "FIT", 1), job("b", "NON_FIT", 2)]), surprise: true };
    expect(() => runRankingBenchmark(extra)).toThrow();
  });
});

describe("compareToBaseline", () => {
  const base = runRankingBenchmark(
    fixture([job("a", "FIT", 90), job("b", "FIT", 80), job("c", "NON_FIT", 20), job("d", "NON_FIT", 10)]),
  );

  it("says NO_BASELINE without one", () => {
    expect(compareToBaseline(base, null).verdict).toBe("NO_BASELINE");
  });

  it("says SAME for identical figures", () => {
    expect(compareToBaseline(base, base).verdict).toBe("SAME");
  });

  it("says WORSE and names the figure when ranking degrades", () => {
    const worse = runRankingBenchmark(
      fixture([job("a", "FIT", 90), job("b", "FIT", 15), job("c", "NON_FIT", 20), job("d", "NON_FIT", 10)]),
    );
    const result = compareToBaseline(worse, base);
    expect(result.verdict).toBe("WORSE");
    expect(result.worse).toContain("separationMatchScore");
    expect(result.deltas.separationMatchScore).toBe(-0.25);
  });

  it("treats a rise in non-fit jobs reaching Review as worse", () => {
    const before: RankingBenchmarkReport = { ...base, nonFitInReviewOrPriorityShare: 0.1 };
    const after: RankingBenchmarkReport = { ...base, nonFitInReviewOrPriorityShare: 0.4 };
    expect(compareToBaseline(after, before).worse).toEqual(["nonFitInReviewOrPriorityShare"]);
  });

  it("ignores movement inside the tolerance", () => {
    const nudged: RankingBenchmarkReport = { ...base, separationMatchScore: 0.995 };
    expect(compareToBaseline(nudged, base).verdict).toBe("SAME");
  });

  it("formats a Markdown table with the verdict", () => {
    const markdown = formatBenchmarkMarkdown(base, compareToBaseline(base, base));
    expect(markdown).toContain("Ranking benchmark (information only)");
    expect(markdown).toContain("**SAME**");
    expect(markdown).toContain("| Separation (match score) | 1.000 |");
  });
});

describe("committed benchmark fixture", () => {
  const read = (name: string): unknown => JSON.parse(readFileSync(path.resolve("fixtures", name), "utf8"));

  it("is valid, synthetic, and matches the recorded baseline", () => {
    const raw = read("ranking_benchmark.json") as { fixture_notice: string };
    expect(raw.fixture_notice).toMatch(/Synthetic data only/);
    const report = runRankingBenchmark(raw);
    const baseline = read("ranking_benchmark_baseline.json") as RankingBenchmarkReport;
    expect(compareToBaseline(report, baseline, 1e-9).verdict).toBe("SAME");
  });
});
