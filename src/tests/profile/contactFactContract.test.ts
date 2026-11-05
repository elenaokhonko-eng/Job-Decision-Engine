import { describe, expect, it } from "vitest";
import { FactJsonSchema, ProfileFactSchema } from "../../profile/contracts.js";
import { FactOperationPayloadSchema } from "../../profile/updateSession.js";

const validContactFact = {
  fact_type: "CONTACT",
  fact_key: "contact_phone",
  statement: "Candidate contact phone",
  structured_value: { kind: "phone", value: "+6500000000" },
  evidence_tier: "PROFESSIONAL_PRODUCTION",
  verification_status: "SELF_ATTESTED",
  is_current: true,
  confidentiality: "PRIVATE_INTERNAL",
};

describe("profile CONTACT fact write contract", () => {
  it("accepts a private, typed, self-attested contact fact", () => {
    expect(FactOperationPayloadSchema.safeParse(validContactFact).success).toBe(true);
  });

  it("applies the same contract to database profile-fact rows", () => {
    const validRow = {
      id: "10000000-0000-4000-8000-000000000001",
      profile_version_id: "20000000-0000-4000-8000-000000000002",
      engagement_id: null,
      ...validContactFact,
      start_date: null,
      end_date: null,
      created_at: new Date("2026-01-01T00:00:00.000Z"),
    };

    expect(ProfileFactSchema.safeParse(validRow).success).toBe(true);
    expect(ProfileFactSchema.safeParse({ ...validRow, confidentiality: "PUBLIC" }).success).toBe(false);
  });

  it("applies the same contract to local profile fact files", () => {
    const validProfile = { profile_key: "test_candidate", facts: [validContactFact] };
    const invalidProfile = {
      profile_key: "test_candidate",
      facts: [{ ...validContactFact, confidentiality: "PUBLIC" }],
    };

    expect(FactJsonSchema.safeParse(validProfile).success).toBe(true);
    expect(FactJsonSchema.safeParse(invalidProfile).success).toBe(false);
  });

  it("rejects contact values with unsupported keys, mismatched kinds, or non-private classification", () => {
    const invalidFacts = [
      { ...validContactFact, fact_key: "contact_secret" },
      { ...validContactFact, structured_value: { kind: "email", value: "person@example.invalid" } },
      { ...validContactFact, confidentiality: "PUBLIC" },
      { ...validContactFact, verification_status: "UNVERIFIED" },
      { ...validContactFact, structured_value: { phone: "+6500000000" } },
    ];

    for (const fact of invalidFacts) {
      expect(FactOperationPayloadSchema.safeParse(fact).success).toBe(false);
    }
  });
});
