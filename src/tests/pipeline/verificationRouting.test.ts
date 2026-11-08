import { describe, expect, it } from "vitest";
import { isRoutableWorkabilityVerification, routableWorkabilityVerificationSql } from "../../pipeline/verificationRouting.js";

describe("verification routing eligibility", () => {
  it("routes an unknown work mode through matching while preserving the verification gate", () => {
    // hardGate persists rejection_reason as the specific code; the separate
    // gate_decision column carries NEEDS_VERIFICATION.
    expect(isRoutableWorkabilityVerification("NEEDS_VERIFICATION", ["GATE_UNKNOWN_WORK_MODE"])).toBe(true);
  });

  it.each([
    ["NEEDS_VERIFICATION_OFFICE_DAYS", "Unspecified office days"],
    ["NEEDS_VERIFICATION_TRAVEL", "Travel cap is unknown"],
    ["NEEDS_VERIFICATION_LOCATION_DETAIL", "Location detail is missing"],
    ["NEEDS_VERIFICATION_HIRING_TERRITORY", "Remote hiring territory is unclear"],
  ])("routes unresolved workability fact %s", (code) => {
    expect(isRoutableWorkabilityVerification("NEEDS_VERIFICATION", [
      "NEEDS_VERIFICATION",
      code,
    ])).toBe(true);
  });

  it.each([
    ["NEEDS_VERIFICATION", ["NEEDS_VERIFICATION"]],
    ["NEEDS_VERIFICATION", ["NEEDS_VERIFICATION", "NEEDS_VERIFICATION_WORK_AUTHORIZATION"]],
    ["NEEDS_VERIFICATION", ["NEEDS_VERIFICATION", "GATE_HIGH_INTERACTION"]],
    ["PASS", ["GATE_UNKNOWN_WORK_MODE", "NEEDS_VERIFICATION"]],
  ])("does not route verification outside the workability fact allow-list", (gate, codes) => {
    expect(isRoutableWorkabilityVerification(gate, codes)).toBe(false);
  });

  it("builds a SQL predicate with the same bounded code allow-list", () => {
    const sql = routableWorkabilityVerificationSql("job");
    expect(sql).toContain("job.gate_decision = 'NEEDS_VERIFICATION'");
    expect(sql).toContain("job.rejection_reason");
    expect(sql).toContain("'GATE_UNKNOWN_WORK_MODE'");
    expect(sql).not.toContain("@> ARRAY['NEEDS_VERIFICATION']");
    expect(sql).not.toContain("'NEEDS_VERIFICATION_WORK_AUTHORIZATION'");
  });

  it("rejects an unsafe SQL alias", () => {
    expect(() => routableWorkabilityVerificationSql("c; DROP TABLE jobs")).toThrow("Invalid SQL alias");
  });
});
