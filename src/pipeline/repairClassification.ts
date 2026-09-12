export type RepairCategory =
  | "LEGACY_BUDGET_CAP"
  | "QUOTED_PROVIDER_FAILURE"
  | "ROUTING_TASK_IDEMPOTENCY_RACE"
  | "GATE_NULL"
  | "RAW_STAGED_HARD_REJECT";

export interface RepairClassificationInput {
  processing_state: string;
  gate_decision: string | null;
  primary_lane: string | null;
  rejection_reason: string | null;
}

/**
 * Classify only known, evidence-backed funnel repairs. Operational failures
 * remain quarantined unless their persisted reason identifies the fixed route
 * idempotency race specifically.
 */
export function classifyRepairCategory(
  row: RepairClassificationInput,
): RepairCategory | null {
  if (
    row.processing_state === "NEEDS_MANUAL_REVIEW" &&
    row.gate_decision === "PASS" &&
    (row.rejection_reason || "").toUpperCase().includes("BUDGET_CAP")
  ) {
    return "LEGACY_BUDGET_CAP";
  }

  if (
    row.processing_state === "NEEDS_MANUAL_REVIEW" &&
    row.gate_decision === "PASS" &&
    (row.rejection_reason || "").toUpperCase().includes("EXTRACT_QUOTED_REQUIREMENTS")
  ) {
    return "QUOTED_PROVIDER_FAILURE";
  }

  const reason = row.rejection_reason || "";
  if (
    row.processing_state === "NEEDS_MANUAL_REVIEW" &&
    row.gate_decision === "PASS" &&
    row.primary_lane !== null &&
    row.primary_lane !== "UNCLASSIFIED" &&
    reason.includes("Task ROUTE_LANE") &&
    reason.includes("exhausted retries: Lane routing did not advance") &&
    reason.includes("state=MATCHED")
  ) {
    return "ROUTING_TASK_IDEMPOTENCY_RACE";
  }

  if (
    row.processing_state === "HARD_REJECTED" &&
    row.gate_decision === null
  ) {
    return "GATE_NULL";
  }

  if (
    row.processing_state === "RAW_STAGED" &&
    row.gate_decision === "HARD_REJECT"
  ) {
    return "RAW_STAGED_HARD_REJECT";
  }

  return null;
}
