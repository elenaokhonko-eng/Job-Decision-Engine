import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  assignSplit,
  buildMeasurementReport,
  classifyNonFitTitle,
  classifySavedObservations,
  hasMixedScorePolicies,
  median,
  savedInTopN,
  separation,
  type MeasuredJobRow,
  type SavedObservationRow,
} from "../../reporting/rankingMeasurement.js";

// Expected values below are worked out by hand from the definition of separation
// (P[saved > non-fit] + 0.5 * P[tie]); none come from running the code under test.
describe("separation", () => {
  it("is 1 when every saved job outscores every non-fit", () => {
    expect(separation([3, 4], [1, 2])).toBe(1);
  });

  it("is 0 when every non-fit outscores every saved job", () => {
    expect(separation([1, 2], [3, 4])).toBe(0);
  });

  it("is 0.5 when all scores tie (a coin flip)", () => {
    expect(separation([5, 5, 5], [5, 5])).toBe(0.5);
  });

  it("counts ties as half: saved [2] vs non-fit [1,2,3] is (1 + 0.5 + 0) / 3", () => {
    expect(separation([2], [1, 2, 3])).toBeCloseTo(0.5, 10);
  });

  it("matches a hand-counted mixed case: saved [1,4] vs non-fit [2,3]", () => {
    // pairs: 1>2 no, 1>3 no, 4>2 yes, 4>3 yes -> 2 of 4
    expect(separation([1, 4], [2, 3])).toBe(0.5);
  });

  it("is undefined when either side is empty", () => {
    expect(separation([], [1])).toBeNull();
    expect(separation([1], [])).toBeNull();
  });
});

describe("median", () => {
  it("handles odd, even and empty inputs", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("assignSplit", () => {
  it("is stable for the same id and independent of other ids", () => {
    const id = "6f1c1d57-6a29-4c6c-9f4a-0a1b2c3d4e5f";
    expect(assignSplit(id)).toBe(assignSplit(id));
  });

  it("puts about 80% of ids in FIT", () => {
    const total = 5000;
    let fit = 0;
    for (let i = 0; i < total; i += 1) if (assignSplit(randomUUID()) === "FIT") fit += 1;
    expect(fit / total).toBeGreaterThan(0.77);
    expect(fit / total).toBeLessThan(0.83);
  });
});

describe("classifyNonFitTitle", () => {
  it.each([
    ["Senior C++ Developer", "CPP_EMBEDDED_FIRMWARE"],
    ["Embedded Software Engineer", "CPP_EMBEDDED_FIRMWARE"],
    ["Firmware Engineer", "CPP_EMBEDDED_FIRMWARE"],
    ["Frontend Developer", "FRONTEND"],
    ["Front-End Engineer", "FRONTEND"],
    ["iOS Engineer", "MOBILE"],
    ["Android Developer", "MOBILE"],
    ["Game Developer", "GAME"],
    ["QA Engineer", "QA_TEST"],
    ["Software Test Engineer", "QA_TEST"],
    ["Backend Engineer", "BACKEND_GENERAL_SOFTWARE"],
    ["Software Engineer", "BACKEND_GENERAL_SOFTWARE"],
    ["Full Stack Developer", "BACKEND_GENERAL_SOFTWARE"],
  ])("treats %s as a non-fit (%s)", (title, category) => {
    expect(classifyNonFitTitle(title)).toBe(category);
  });

  it.each([
    "DevOps Lead",
    "Cloud Architect",
    "Platform Engineer",
    "Solutions Architect",
    "Data Engineer",
    "Software Engineer, AI Platform",
    "Senior Backend Engineer, Data Platform",
    "Embedded Finance Product Lead",
    "Mobile Banking Product Manager",
    "Game Theory Researcher",
    "Programme Manager, Transformation",
    "",
  ])("never treats %s as a non-fit", (title) => {
    expect(classifyNonFitTitle(title)).toBeNull();
  });
});

describe("savedInTopN", () => {
  it("counts saved jobs among the highest scores and breaks ties by id", () => {
    const items = [
      { jobId: "a", score: 90, isSaved: true },
      { jobId: "b", score: 80, isSaved: false },
      { jobId: "c", score: 70, isSaved: true },
      { jobId: "d", score: 60, isSaved: true },
    ];
    expect(savedInTopN(items, 2)).toEqual({ saved: 1, size: 2 });
    expect(savedInTopN(items, 10)).toEqual({ saved: 3, size: 4 });
    const tied = [
      { jobId: "z", score: 50, isSaved: true },
      { jobId: "a", score: 50, isSaved: false },
    ];
    expect(savedInTopN(tied, 1)).toEqual({ saved: 0, size: 1 });
  });
});

describe("classifySavedObservations", () => {
  it("gives every observation one reason so the counts add up to the total", () => {
    const observations = [
      { jobId: "j1", jobArchived: false, hasCompletedMatch: true, hasDecision: true },
      { jobId: "j1", jobArchived: false, hasCompletedMatch: true, hasDecision: true },
      { jobId: null, jobArchived: false, hasCompletedMatch: false, hasDecision: false },
      { jobId: "j2", jobArchived: true, hasCompletedMatch: true, hasDecision: true },
      { jobId: "j3", jobArchived: false, hasCompletedMatch: false, hasDecision: false },
      { jobId: "j4", jobArchived: false, hasCompletedMatch: true, hasDecision: false },
    ];
    const { reasons, counts } = classifySavedObservations(observations);
    expect(reasons).toEqual([
      "MEASURED",
      "DUPLICATE_OBSERVATION",
      "NOT_NORMALIZED",
      "JOB_ARCHIVED",
      "NO_COMPLETED_MATCH",
      "NO_DECISION",
    ]);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(observations.length);
  });
});

function job(jobId: string, title: string, score: number, outcome: string | null = "REVIEW"): MeasuredJobRow {
  return { jobId, title, matchScore: score, coverageScore: score, avgSimilarity: score / 100, outcome, eligibility: "ELIGIBLE" };
}

function savedObs(row: MeasuredJobRow): SavedObservationRow {
  return {
    observationId: `obs-${row.jobId}`,
    jobId: row.jobId,
    jobArchived: false,
    hasCompletedMatch: true,
    hasDecision: true,
    job: row,
  };
}

describe("buildMeasurementReport job-level counts", () => {
  it("counts distinct saved jobs once and explains jobs with no completed match by pipeline state", () => {
    const measured = job("j1", "Programme Lead", 60);
    const base = { jobArchived: false, hasCompletedMatch: true, hasDecision: true };
    const observations: SavedObservationRow[] = [
      { observationId: "o1", jobId: "j1", ...base, job: measured },
      { observationId: "o2", jobId: "j1", ...base, job: measured }, // same job saved twice
      { observationId: "o3", jobId: null, jobArchived: false, hasCompletedMatch: false, hasDecision: false, job: null },
      { observationId: "o4", jobId: "j2", jobArchived: false, hasCompletedMatch: false, hasDecision: false, job: null, processingState: "HARD_REJECTED" },
      { observationId: "o5", jobId: "j3", jobArchived: false, hasCompletedMatch: false, hasDecision: false, job: null, processingState: "HARD_REJECTED" },
      { observationId: "o6", jobId: "j4", jobArchived: false, hasCompletedMatch: false, hasDecision: false, job: null },
    ];
    const report = buildMeasurementReport(observations, []);
    expect(report.observationTotal).toBe(6);
    expect(report.distinctSavedJobs).toBe(4);
    expect(report.jobReasonCounts).toEqual({ MEASURED: 1, JOB_ARCHIVED: 0, NO_COMPLETED_MATCH: 3, NO_DECISION: 0 });
    expect(report.noMatchByState).toEqual({ HARD_REJECTED: 2, UNKNOWN: 1 });
    expect(report.all.savedCount).toBe(1);
  });
});

describe("buildMeasurementReport", () => {
  it("measures a perfectly separated fixture as 1.0 and drops saved jobs from the non-fit set", () => {
    const saved = [job("s1", "Head of AI Governance", 80), job("s2", "Programme Lead", 70)];
    const candidates = [
      ...saved,
      job("n1", "C++ Developer", 20, "TRACK"),
      job("n2", "iOS Engineer", 10, "SKIP"),
      job("x1", "Chief of Staff", 99), // neither saved nor a non-fit title: ignored
      job("s1b", "Backend Engineer", 5), // not saved: counted as a non-fit
    ];
    // a saved job whose title matches a non-fit rule must not count against the engine
    const savedWithNonFitTitle = job("s3", "Backend Engineer", 60);
    const report = buildMeasurementReport([...saved, savedWithNonFitTitle].map(savedObs), [...candidates, savedWithNonFitTitle]);

    expect(report.observationTotal).toBe(3);
    expect(report.all.savedCount).toBe(3);
    expect(report.all.nonFitCount).toBe(3);
    expect(report.nonFitCandidatesExcludedBecauseSaved).toBe(1);
    expect(report.all.separationMatchScore).toBe(1);
    expect(report.all.savedReviewOrPriority).toBe(3);
    expect(report.all.nonFitReviewOrPriority).toBe(1); // only "s1b" is REVIEW
    expect(report.all.top10).toEqual({ saved: 3, size: 6 });
    expect(report.fit.savedCount + report.holdout.savedCount).toBe(report.all.savedCount);
    expect(report.fit.nonFitCount + report.holdout.nonFitCount).toBe(report.all.nonFitCount);
  });
});

describe("score policy and gate-rejection checks", () => {
  const withPolicy = (row: MeasuredJobRow, policyVersion: string | null, gateDecision: string | null = "PASS"): MeasuredJobRow => ({ ...row, policyVersion, gateDecision });

  it("counts measured jobs by score policy and flags a mixed set", () => {
    const legacy = withPolicy(job("a", "Head of AI Governance", 80), "deterministic_v2");
    const topk = withPolicy(job("b", "C++ Developer", 20, "TRACK"), "deterministic_v2+topk_capability_semantic_v1");
    const report = buildMeasurementReport([savedObs(legacy)], [legacy, topk]);
    expect(report.scorePolicyCounts).toEqual({ deterministic_v2: 1, "deterministic_v2+topk_capability_semantic_v1": 1 });
    expect(hasMixedScorePolicies(report)).toBe(true);
  });

  it("is not mixed when every measured job has the same policy, and reports a missing policy as UNKNOWN", () => {
    const a = withPolicy(job("a", "Head of AI Governance", 80), "deterministic_v2");
    const b = withPolicy(job("b", "C++ Developer", 20, "TRACK"), "deterministic_v2");
    expect(hasMixedScorePolicies(buildMeasurementReport([savedObs(a)], [a, b]))).toBe(false);
    const unknown = buildMeasurementReport([savedObs(job("c", "Head of AI Governance", 80))], [job("c", "Head of AI Governance", 80)]);
    expect(unknown.scorePolicyCounts).toEqual({ UNKNOWN: 1 });
  });

  it("counts a gate-rejected job that sits in Review or Priority, and nothing else", () => {
    const rejectedInReview = withPolicy(job("r1", "C++ Developer", 20, "REVIEW"), "deterministic_v2", "HARD_REJECT");
    const rejectedSkipped = withPolicy(job("r2", "iOS Engineer", 10, "SKIP"), "deterministic_v2", "HARD_REJECT");
    const passedInReview = withPolicy(job("p1", "Head of AI Governance", 80, "REVIEW"), "deterministic_v2", "PASS");
    const report = buildMeasurementReport([savedObs(passedInReview)], [passedInReview, rejectedInReview, rejectedSkipped]);
    expect(report.rejectedInReviewOrPriority).toBe(1);
  });
});
