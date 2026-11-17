import { describe, expect, it } from "vitest";

import { assessCareerTrack, capOutcome, type TrackExperience, type TrackRequirement } from "../../pipeline/careerTrack.js";
import {
  activeScoringPolicy,
  isRankingRequirementType,
  LEGACY_SCORING_POLICY,
  matcherPolicyVersionFor,
  TOPK_K,
  TOPK_SCORING_POLICY,
  topKCapabilityScore,
  unmatchedMustHaves,
  type RankingEvidenceRow,
} from "../../pipeline/scoringPolicy.js";
import {
  currentMatcherFingerprintVersion,
  currentMatcherPolicySql,
  currentMatcherPolicyVersion,
  DETERMINISTIC_MATCHER_POLICY_VERSION,
} from "../../pipeline/profileMatchCurrency.js";

const row = (
  semanticScore: number | null,
  over: Partial<RankingEvidenceRow> = {},
): RankingEvidenceRow => ({
  requirementType: "CUSTOM",
  importance: "MUST",
  matchType: "SEMANTIC",
  semanticScore,
  ...over,
});

describe("scoring policy flag", () => {
  it("keeps the legacy score unless the top-K policy is named", () => {
    expect(activeScoringPolicy({} as NodeJS.ProcessEnv)).toBe(LEGACY_SCORING_POLICY);
    expect(activeScoringPolicy({ SCORING_POLICY: "nonsense" } as unknown as NodeJS.ProcessEnv)).toBe(LEGACY_SCORING_POLICY);
    expect(activeScoringPolicy({ SCORING_POLICY: TOPK_SCORING_POLICY } as unknown as NodeJS.ProcessEnv)).toBe(TOPK_SCORING_POLICY);
  });

  it("gives the top-K score its own matcher policy version, so turning it on supersedes older matches", () => {
    const off = {} as NodeJS.ProcessEnv;
    const on = { SCORING_POLICY: TOPK_SCORING_POLICY } as unknown as NodeJS.ProcessEnv;
    expect(currentMatcherPolicyVersion(off)).toBe(DETERMINISTIC_MATCHER_POLICY_VERSION);
    expect(currentMatcherPolicyVersion(on)).not.toBe(DETERMINISTIC_MATCHER_POLICY_VERSION);
    expect(currentMatcherPolicyVersion(on)).toContain(TOPK_SCORING_POLICY);
    expect(currentMatcherFingerprintVersion(on)).not.toBe(currentMatcherFingerprintVersion(off));
    expect(matcherPolicyVersionFor(LEGACY_SCORING_POLICY, "x")).toBe("x");
  });

  it("builds the currency SQL from the version in force", () => {
    const before = process.env.SCORING_POLICY;
    try {
      delete process.env.SCORING_POLICY;
      expect(currentMatcherPolicySql("mr")).toContain(`'${DETERMINISTIC_MATCHER_POLICY_VERSION}'`);
      process.env.SCORING_POLICY = TOPK_SCORING_POLICY;
      expect(currentMatcherPolicySql("mr")).toContain(TOPK_SCORING_POLICY);
    } finally {
      if (before === undefined) delete process.env.SCORING_POLICY;
      else process.env.SCORING_POLICY = before;
    }
  });
});

describe("top-K capability score", () => {
  it("fixes K at 7, the middle of the measured 3-12 plateau", () => {
    expect(TOPK_K).toBe(7);
  });

  it("is the mean semantic similarity of the K best capability requirements, scaled to 0..100", () => {
    const rows = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.1, 0.05].map((value) => row(value));
    const result = topKCapabilityScore(rows);
    expect(result.contributing).toBe(7);
    expect(result.considered).toBe(9);
    expect(result.score).toBeCloseTo(((0.9 + 0.8 + 0.7 + 0.6 + 0.5 + 0.4 + 0.3) / 7) * 100, 4);
  });

  it("is not dragged down by unmatched bullets: a long posting scores like a short one with the same best matches", () => {
    const best = [0.8, 0.8, 0.7, 0.7, 0.6, 0.6, 0.6];
    const short = topKCapabilityScore(best.map((value) => row(value)));
    const long = topKCapabilityScore([...best.map((value) => row(value)), ...Array.from({ length: 30 }, () => row(0.1, { matchType: "NO_MATCH" }))]);
    expect(long.score).toBeCloseTo(short.score, 6);
  });

  it("uses fewer than K requirements when a posting has fewer, and scores an empty posting 0", () => {
    expect(topKCapabilityScore([row(0.5), row(0.7)]).score).toBeCloseTo(60, 4);
    expect(topKCapabilityScore([])).toEqual({ score: 0, contributing: 0, considered: 0 });
  });

  it("treats a missing or non-finite similarity as 0 and clamps to 0..1", () => {
    expect(topKCapabilityScore([row(null), row(Number.NaN), row(2)]).score).toBeCloseTo((1 / 3) * 100, 4);
  });
});

describe("years, degrees and credentials leave the ranking score but stay checks", () => {
  const capability = [0.8, 0.75, 0.7, 0.7, 0.65, 0.6, 0.6].map((value) => row(value));
  const checks = [
    row(1, { requirementType: "EXPERIENCE_YEARS", matchType: "EXACT" }),
    row(1, { requirementType: "DEGREE", matchType: "EXACT" }),
    row(1, { requirementType: "CREDENTIAL", matchType: "EXACT" }),
  ];

  it("never counts years, degree, credential or workability rows in the score", () => {
    for (const type of ["EXPERIENCE_YEARS", "DEGREE", "CREDENTIAL", "WORK_AUTH", "WORK_MODE", "EMPLOYMENT_TYPE", "OFFICE_DAYS"]) {
      expect(isRankingRequirementType(type)).toBe(false);
    }
    expect(isRankingRequirementType("CUSTOM")).toBe(true);
    expect(topKCapabilityScore([...capability, ...checks]).score).toBe(topKCapabilityScore(capability).score);
  });

  // The synthetic split used across the career-track tests: a short hands-on AI/data track.
  const EXPERIENCE: TrackExperience[] = [
    { track: "DATA_MANAGEMENT", years: 16 },
    { track: "ARCHITECTURE", years: 10 },
    { track: "PRODUCT", years: 6 },
    { track: "HANDS_ON_AI_DATA", years: 1.5 },
  ];
  const years = (minimum: number): TrackRequirement => ({
    requirement_type: "EXPERIENCE_YEARS",
    importance: "MUST",
    requirement_text: "Role requires minimum years of experience.",
    structured_value: { minimum_years: minimum, experience_scope: "machine learning" },
  });

  it("a role demanding more hands-on years than the candidate has ranks the same, yet is still capped", () => {
    const title = "Senior Machine Learning Engineer";
    // Same posting, same capability evidence. One adds a MUST 5-year hands-on ML requirement.
    const lowBar = assessCareerTrack({ title, requirements: [years(2)], experience: EXPERIENCE });
    const highBar = assessCareerTrack({ title, requirements: [years(5)], experience: EXPERIENCE });
    const rankingWithLowBar = topKCapabilityScore([...capability, row(1, { requirementType: "EXPERIENCE_YEARS", matchType: "EXACT" })]).score;
    const rankingWithHighBar = topKCapabilityScore([...capability, row(0, { requirementType: "EXPERIENCE_YEARS", matchType: "NO_MATCH" })]).score;

    // The ranking score does not move with the years requirement ...
    expect(rankingWithHighBar).toBe(rankingWithLowBar);
    // ... but the career-track cap, which reads the requirement rows, does.
    expect(highBar.outcome_cap).toBe("REVIEW");
    expect(capOutcome("PRIORITY", highBar.outcome_cap)).toBe("REVIEW");
    expect(lowBar.outcome_cap).toBeNull();
    expect(capOutcome("PRIORITY", lowBar.outcome_cap)).toBe("PRIORITY");
  });
});

describe("unmatched must-haves are reported, not scored", () => {
  it("counts MUST capability requirements without a counted match", () => {
    const rows = [
      row(0.8, { matchType: "SEMANTIC" }),
      row(0.7, { matchType: "EXACT" }),
      row(0.2, { matchType: "NO_MATCH" }),
      row(0, { matchType: "UNKNOWN" }),
      row(0.1, { matchType: "NO_MATCH", importance: "PREFERRED" }),
      row(1, { requirementType: "EXPERIENCE_YEARS", matchType: "NO_MATCH" }),
    ];
    expect(unmatchedMustHaves(rows)).toEqual({ unmatched: 2, total: 4 });
  });

  it("does not change the score", () => {
    const matched = [0.8, 0.7, 0.7, 0.6, 0.6, 0.5, 0.5].map((value) => row(value));
    const withGaps = [...matched, ...Array.from({ length: 10 }, () => row(0.1, { matchType: "NO_MATCH" }))];
    expect(topKCapabilityScore(withGaps).score).toBe(topKCapabilityScore(matched).score);
  });
});
