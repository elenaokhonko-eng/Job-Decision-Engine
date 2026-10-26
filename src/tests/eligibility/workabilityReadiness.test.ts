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
  minimalTravelAllowed: true,
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
    const result = assessHiringTerritoryReadiness(
      "Candidates must be authorized to work in Singapore or Australia.",
      {
        status: "SUPPORTED",
        operator: "ANY",
        countries: ["Singapore", "Australia"],
        evidence: [{ evidence_key: "hiring-countries" }],
      },
      "REMOTE",
      policy,
    );

    expect(result).toMatchObject({ status: "MET", reasonCode: null });
  });

  it("requires verification when a territory list does not establish alternatives", () => {
    const ambiguous = assessHiringTerritoryReadiness(
      "Candidates must be authorized to work in Singapore, Australia.",
      {
        status: "UNKNOWN",
        operator: "UNKNOWN",
        countries: ["SINGAPORE", "AUSTRALIA"],
        evidence: [{ evidence_key: "scoped-hiring-clause" }],
      },
      "REMOTE",
      policy,
    );

    expect(ambiguous).toMatchObject({
      status: "NEEDS_VERIFICATION",
      reasonCode: "WORK_AUTHORIZATION_OPERATOR_UNKNOWN",
    });
  });

  it.each([
    "Must reside in the U.S.",
    "U.S. citizenship is required.",
  ])("does not lose abbreviated country restrictions: %s", (description) => {
    const result = assessHiringTerritoryReadiness(description, null, "REMOTE", policy);

    expect(result).toMatchObject({
      status: "BLOCKED",
      reasonCode: "WORK_AUTHORIZATION_INCOMPATIBLE",
    });
  });

  it("evaluates each separate mandatory territory condition independently", () => {
    const result = assessHiringTerritoryReadiness(
      "Must reside in the United States. Must be authorized to work in Singapore.",
      null,
      "REMOTE",
      policy,
    );

    expect(result).toMatchObject({
      status: "BLOCKED",
      reasonCode: "WORK_AUTHORIZATION_INCOMPATIBLE",
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
    const mixed = assessTravelReadiness("No regular travel is required, but 30% travel is required for client deployments.", {
      status: "SUPPORTED", minimum: 30, maximum: 30, evidence: [{ evidence_key: "positive-travel" }],
    }, policy);
    const minimal = assessTravelReadiness("Minimal travel is required.", {
      status: "UNKNOWN", minimum: null, maximum: null, evidence: [{ evidence_key: "minimal-travel" }],
    }, policy);
    const minimalUnaccepted = assessTravelReadiness("Minimal travel is required.", {
      status: "UNKNOWN", minimum: null, maximum: null, evidence: [{ evidence_key: "minimal-travel" }],
    }, { ...policy, minimalTravelAllowed: false });

    expect(frequent.status).toBe("BLOCKED");
    expect(negated).toMatchObject({ status: "NOT_APPLICABLE", policyReferenceRequired: true });
    expect(unrelated.status).toBe("NOT_APPLICABLE");
    expect(occasional.status).toBe("NEEDS_VERIFICATION");
    expect(mixed).toMatchObject({ status: "BLOCKED", reasonCode: "TRAVEL_EXCEEDS_POLICY" });
    expect(minimal).toMatchObject({ status: "MET", policyReferenceRequired: true });
    expect(minimal.rationale).toContain("no numeric travel percentage is inferred");
    expect(minimal.evidenceKeys).toContain("travel_policy_assumption:minimal_qualitative:Minimal travel is required");
    expect(minimalUnaccepted).toMatchObject({
      status: "NEEDS_VERIFICATION",
      reasonCode: "MINIMAL_TRAVEL_POLICY_UNCONFIRMED",
    });
  });
});
