import { describe, expect, it } from "vitest";
import { classifyRepairCategory } from "../../pipeline/repairClassification.js";

describe("classifyRepairCategory", () => {
  it("recognizes only the persisted route idempotency race", () => {
    expect(
      classifyRepairCategory({
        processing_state: "NEEDS_MANUAL_REVIEW",
        gate_decision: "PASS",
        primary_lane: "CORE_AI_DATA",
        rejection_reason:
          "Task ROUTE_LANE:version exhausted retries: Lane routing did not advance job_version_id=version; state=MATCHED.",
      }),
    ).toBe("ROUTING_TASK_IDEMPOTENCY_RACE");
  });

  it("recognizes false-negative lifestyle rejection when evidence has negated on-call or travel", () => {
    expect(
      classifyRepairCategory({
        processing_state: "HARD_REJECTED",
        gate_decision: "HARD_REJECT",
        primary_lane: null,
        rejection_reason: "Disqualified by lifestyle criteria: GATE_LIFESTYLE_INCOMPATIBLE",
        rejection_reason_codes: ["GATE_LIFESTYLE_INCOMPATIBLE"],
        evidence_quotes: ["There is no on-call rotation for this role."],
      }),
    ).toBe("FALSE_NEGATIVE_NEGATED_LIFESTYLE");
  });

  it("recognizes unprovable match when profile_match_status is NO_PROFILE_MATCH with pending embeddings", () => {
    expect(
      classifyRepairCategory({
        processing_state: "LANE_ROUTED",
        gate_decision: "PASS",
        primary_lane: "CORE_AI_DATA",
        rejection_reason: null,
        profile_match_status: "NO_PROFILE_MATCH",
      }),
    ).toBe("UNPROVABLE_MATCH_EMBEDDING_PENDING");
  });

  it("recognizes truncated version masking when a complete prior version exists", () => {
    expect(
      classifyRepairCategory({
        processing_state: "HARD_REJECTED",
        gate_decision: "HARD_REJECT",
        primary_lane: null,
        rejection_reason: "Too short",
        has_complete_prior_version: true,
      }),
    ).toBe("TRUNCATED_VERSION_MASKING");
  });
});
