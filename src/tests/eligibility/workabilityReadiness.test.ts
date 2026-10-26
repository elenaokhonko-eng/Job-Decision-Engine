import { describe, expect, it } from "vitest";
import { assessHiringTerritoryReadiness, assessTravelReadiness, assessWorkModeReadiness } from "../../eligibility/workabilityReadiness.js";
import type { WorkabilityPolicy } from "../../pipeline/workabilityPolicy.js";

const policy: WorkabilityPolicy = {
  unknownWorkModeDisposition: "HARD_REJECT",
  allowedWorkModes: ["REMOTE", "HYBRID"],
  onsiteOnlyAllowed: false,
  maxOfficeDaysPerWeek: 3,
  hardFailOfficeDaysPerWeek: 4,
  hybridWithoutOfficeDaysAllowed: true,
  authorizedRegions: ["SINGAPORE"],
  remoteWithoutTerritoryAllowed: true,
  rejectExplicitForeignTerritory: true,
  unknownWorkAuthorizationNeedsVerification: false,
  maxTravelPct: 20,
  contractAllowed: false,
  minimumBuildingResearchPct: 60,
  maximumInteractionPct: 40,
  regularOnCallAllowed: false,
  shiftWorkAllowed: false,
  frequentTravelAllowed: false,
  externalClientPrimaryAllowed: false,
  peopleManagementPrimaryAllowed: false,
  blacklistedCompanies: [],
};

describe("readiness workability evidence", () => {
  it("normalizes employer and preference country names before evaluating alternatives", () => {
    const result = assessHiringTerritoryReadiness({
      status: "SUPPORTED",
      operator: "ANY",
      countries: ["Singapore", "Australia"],
      evidence: [{ evidence_key: "hiring-countries" }],
    }, "REMOTE", {
      ...policy,
      authorizedRegions: ["SINGAPORE"],
    });

    expect(result).toMatchObject({ status: "MET", reasonCode: null });
  });

  it("does not let an unrelated country or ambiguous operator establish work authorization", () => {
    const ambiguous = assessHiringTerritoryReadiness({
      status: "SUPPORTED",
      operator: "UNKNOWN",
      countries: ["SINGAPORE", "UNITED_STATES"],
      evidence: [{ evidence_key: "scoped-hiring-clause" }],
    }, "REMOTE", policy);

    expect(ambiguous).toMatchObject({
      status: "NEEDS_VERIFICATION",
      reasonCode: "WORK_AUTHORIZATION_OPERATOR_UNKNOWN",
    });
  });

  it("accepts the configured assumed Singapore hybrid default without claiming employer confirmation", () => {
    const result = assessWorkModeReadiness(
      { status: "UNKNOWN", value: "HYBRID", office_days_max: null, evidence: [{ evidence_key: "assumed-hybrid" }] },
      "ASSUMED_HYBRID",
      null,
      "POLICY_HYBRID_3_2",
      "PASS",
      policy,
    );

    expect(result).toMatchObject({ status: "MET", policyReferenceRequired: true });
    expect(result.rationale).toContain("policy assumption, not employer-confirmed evidence");
    expect(result.evidenceKeys).toContain("policy_assumption:POLICY_HYBRID_3_2");
  });

  it("does not accept an assumed hybrid office requirement beyond the active cap", () => {
    const result = assessWorkModeReadiness(
      { status: "UNKNOWN", value: "HYBRID", office_days_max: null, evidence: [] },
      "ASSUMED_HYBRID",
      4,
      "POLICY_HYBRID_3_2",
      "PASS",
      policy,
    );

    expect(result.status).toBe("BLOCKED");
    expect(result.policyReferenceRequired).toBe(true);
  });

  it("uses range upper bounds and treats minimum-only travel disclosures conservatively", () => {
    const range = assessTravelReadiness("Travel is required 20-30% of the time.", {
      status: "SUPPORTED",
      minimum: 20,
      maximum: 30,
      evidence: [{ evidence_key: "travel-range" }],
    }, policy);
    const minimumBelowCap = assessTravelReadiness("At least 10% travel is required.", {
      status: "SUPPORTED",
      minimum: 10,
      maximum: null,
      evidence: [{ evidence_key: "travel-minimum" }],
    }, policy);
    const minimumAboveCap = assessTravelReadiness("At least 25% travel is required.", {
      status: "SUPPORTED",
      minimum: 25,
      maximum: null,
      evidence: [{ evidence_key: "travel-minimum" }],
    }, policy);

    expect(range.status).toBe("BLOCKED");
    expect(minimumBelowCap.status).toBe("NEEDS_VERIFICATION");
    expect(minimumAboveCap.status).toBe("BLOCKED");
  });

  it("distinguishes frequent travel, a negated travel requirement, and unrelated text", () => {
    const frequent = assessTravelReadiness("Frequent travel is required.", {
      status: "UNKNOWN", minimum: null, maximum: null, evidence: [{ evidence_key: "frequent-travel" }],
    }, policy);
    const negated = assessTravelReadiness("No travel is required.", {
      status: "SUPPORTED", minimum: 0, maximum: 0, evidence: [{ evidence_key: "no-travel" }],
    }, policy);
    const unrelated = assessTravelReadiness("Travel analytics are part of our product.", null, policy);
    const occasional = assessTravelReadiness("Occasional travel is required.", {
      status: "UNKNOWN", minimum: null, maximum: null, evidence: [{ evidence_key: "occasional-travel" }],
    }, policy);

    expect(frequent.status).toBe("BLOCKED");
    expect(negated).toMatchObject({ status: "NOT_APPLICABLE", policyReferenceRequired: true });
    expect(unrelated.status).toBe("NOT_APPLICABLE");
    expect(occasional.status).toBe("NEEDS_VERIFICATION");
  });
});
