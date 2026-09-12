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

  it("does not auto-repair an unrelated manual-review failure", () => {
    expect(
      classifyRepairCategory({
        processing_state: "NEEDS_MANUAL_REVIEW",
        gate_decision: "PASS",
        primary_lane: "CORE_AI_DATA",
        rejection_reason: "Task ROUTE_LANE exhausted retries: provider unavailable",
      }),
    ).toBeNull();
  });
});
