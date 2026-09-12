export type RepairCategory =
  | "LEGACY_BUDGET_CAP"
  | "QUOTED_PROVIDER_FAILURE"
  | "ROUTING_TASK_IDEMPOTENCY_RACE"
  | "GATE_NULL"
  | "RAW_STAGED_HARD_REJECT"
  | "FALSE_NEGATIVE_NEGATED_LIFESTYLE"
  | "UNPROVABLE_MATCH_EMBEDDING_PENDING"
  | "TRUNCATED_VERSION_MASKING";

export interface RepairClassificationInput {
  processing_state: string;
  gate_decision: string | null;
  primary_lane: string | null;
  rejection_reason: string | null;
  evidence_quotes?: string[] | null;
  rejection_reason_codes?: string[] | null;
  profile_match_status?: string | null;
  has_complete_prior_version?: boolean;
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

  // Detect false-negative lifestyle rejection caused by negated keywords ("no on-call", "zero travel", etc.)
  const evidenceText = (row.evidence_quotes || []).join(" ").toLowerCase();
  const codes = (row.rejection_reason_codes || []).map((c) => c.toUpperCase());
  const isLifestyleRejection =
    codes.includes("GATE_LIFESTYLE_INCOMPATIBLE") ||
    (row.rejection_reason || "").includes("GATE_LIFESTYLE_INCOMPATIBLE");

  if (
    (row.processing_state === "HARD_REJECTED" || row.gate_decision === "HARD_REJECT") &&
    isLifestyleRejection &&
    (/\b(?:no|not|never|without|zero|0)\s+(?:on-?call|travel|weekend|overtime|shift)\b/i.test(evidenceText) ||
     /\b(?:on-?call|travel|weekend|overtime|shift)\s+(?:is\s+)?(?:not|never|optional|zero)\b/i.test(evidenceText))
  ) {
    return "FALSE_NEGATIVE_NEGATED_LIFESTYLE";
  }

  // Detect unprovable matches that were falsely marked NO_PROFILE_MATCH when embeddings were pending
  if (
    row.gate_decision === "PASS" &&
    row.profile_match_status === "NO_PROFILE_MATCH" &&
    (row.processing_state === "MATCHED" || row.processing_state === "DECIDED" || row.processing_state === "LANE_ROUTED")
  ) {
    return "UNPROVABLE_MATCH_EMBEDDING_PENDING";
  }

  // Detect truncated version masking where a short snippet overwrote a complete job description
  if (row.has_complete_prior_version) {
    return "TRUNCATED_VERSION_MASKING";
  }

  return null;
}
