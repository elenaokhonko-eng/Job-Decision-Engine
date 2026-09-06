import { describe, expect, it } from "vitest";
import { selectCoverLetterClaimPlan, type RequirementMatchRow } from "../../documents/claimSelector.js";

describe("documents/claimSelector", () => {
  it("selectCoverLetterClaimPlan prioritizes MUST requirements over higher-scoring NICE_TO_HAVE", () => {
    const rows: RequirementMatchRow[] = [
      {
        requirement_id: "req-nice",
        requirement_key: "R-003",
        importance: "NICE_TO_HAVE",
        requirement_text: "Nice requirement",
        profile_fact_id: "fact-nice",
        match_type: "SEMANTIC",
        match_score: 0.99,
      },
      {
        requirement_id: "req-must",
        requirement_key: "R-001",
        importance: "MUST",
        requirement_text: "Must requirement",
        profile_fact_id: "fact-must",
        match_type: "EXACT",
        match_score: 0.5,
      },
      {
        requirement_id: "req-pref",
        requirement_key: "R-002",
        importance: "PREFERRED",
        requirement_text: "Preferred requirement",
        profile_fact_id: "fact-pref",
        match_type: "SEMANTIC",
        match_score: 0.9,
      },
      {
        requirement_id: "req-unknown",
        requirement_key: "R-004",
        importance: "MUST",
        requirement_text: "Unknown match should be filtered",
        profile_fact_id: "fact-unknown",
        match_type: "UNKNOWN",
        match_score: 0.9,
      },
      {
        requirement_id: "req-nomatch",
        requirement_key: "R-005",
        importance: "MUST",
        requirement_text: "No match should be filtered",
        profile_fact_id: "fact-nomatch",
        match_type: "NO_MATCH",
        match_score: 0.9,
      },
    ];

    const selected = selectCoverLetterClaimPlan(rows, { maxRequirements: 3 });
    expect(selected.map((s) => s.requirementKey)).toEqual(["R-001", "R-002", "R-003"]);
    expect(selected[0].profileFactIds).toEqual(["fact-must"]);
  });

  it("selectCoverLetterClaimPlan returns empty when no eligible rows exist", () => {
    const rows: RequirementMatchRow[] = [
      {
        requirement_id: "req-1",
        requirement_key: "R-001",
        importance: "MUST",
        requirement_text: "Must requirement",
        profile_fact_id: null,
        match_type: "UNKNOWN",
        match_score: 0,
      },
    ];

    const selected = selectCoverLetterClaimPlan(rows);
    expect(selected).toEqual([]);
  });
});

