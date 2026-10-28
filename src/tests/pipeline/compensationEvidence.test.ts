import { describe, expect, it } from "vitest";
import {
  CompensationEvidenceSchema,
  type CompensationComponent,
} from "../../contracts/jobSourceEvidence.js";
import { resolveCompensationEvidence } from "../../pipeline/compensationEvidence.js";

const evidenceSpan = (evidenceKey: string, quote: string) => ({
  evidence_key: evidenceKey,
  source_name: "TEST_ATS",
  source_plugin_key: "greenhouse",
  source_external_id: "role-123",
  source_url: "https://jobs.example.test/roles/123",
  raw_payload_hash: "a".repeat(64),
  quote_text: quote,
  normalized_start_offset: null,
  normalized_end_offset: null,
  raw_start_offset: null,
  raw_end_offset: null,
  observed_at: "2026-10-27T08:00:00.000Z",
  confidence: "HIGH" as const,
});

function baseComponent(
  evidenceKey: string,
  quote: string,
  period: "MONTHLY" | "ANNUAL",
  amount: number,
  payBasis: "GROSS" | "NET" = "GROSS",
): CompensationComponent {
  return {
    component_type: "BASE_CASH",
    amount_min: amount,
    amount_max: amount,
    currency: "SGD",
    period,
    guaranteed_hours_per_week: null,
    paid_weeks_per_year: null,
    pay_basis: payBasis,
    evidence: [evidenceSpan(evidenceKey, quote)],
  };
}

describe("resolveCompensationEvidence", () => {
  it("returns undisclosed rather than a zero salary when no base salary is available", () => {
    const resolution = resolveCompensationEvidence(null, null);

    expect(resolution).toMatchObject({ kind: "UNDISCLOSED", input: null });
    expect(resolution.reason).toContain("Salary undisclosed");
  });

  it("keeps variable compensation separate from an undisclosed guaranteed base", () => {
    const evidence = CompensationEvidenceSchema.parse({
      status: "SUPPORTED",
      components: [{
        component_type: "VARIABLE_CASH",
        amount_min: 50000,
        amount_max: 50000,
        currency: "SGD",
        period: "ANNUAL",
        guaranteed_hours_per_week: null,
        paid_weeks_per_year: null,
        pay_basis: "GROSS",
        evidence: [evidenceSpan("comp.bonus", "Annual bonus target S$50,000")],
      }],
      evidence: [],
    });

    const resolution = resolveCompensationEvidence("SGD 50,000 annual bonus", evidence);

    expect(resolution).toMatchObject({ kind: "UNDISCLOSED", input: null });
  });

  it("uses one annualized value when monthly and annual base disclosures agree", () => {
    const evidence = CompensationEvidenceSchema.parse({
      status: "SUPPORTED",
      components: [
        baseComponent("comp.annual", "Base salary S$250,000 per year gross", "ANNUAL", 250000),
        baseComponent("comp.monthly", "Base salary S$20,833.33 per month gross", "MONTHLY", 20833.33),
      ],
      evidence: [],
    });

    const resolution = resolveCompensationEvidence(null, evidence);

    expect(resolution.kind).toBe("SUPPORTED");
    expect(resolution.input).toMatchObject({
      salary_min: 250000,
      salary_max: 250000,
      salary_currency: "SGD",
      salary_period: "ANNUAL",
      salary_basis: "GROSS",
      component_type: "BASE_CASH",
    });
  });

  it("requires verification when monthly and annual base disclosures conflict", () => {
    const evidence = CompensationEvidenceSchema.parse({
      status: "SUPPORTED",
      components: [
        baseComponent("comp.annual", "Base salary S$250,000 per year gross", "ANNUAL", 250000),
        baseComponent("comp.monthly", "Base salary S$20,000 per month gross", "MONTHLY", 20000),
      ],
      evidence: [],
    });

    const resolution = resolveCompensationEvidence(null, evidence);

    expect(resolution).toMatchObject({ kind: "UNRESOLVED", input: null });
    expect(resolution.reason).toMatch(/conflict|inconsistent/i);
  });

  it("classifies a competitive base salary as undisclosed despite a disclosed bonus", () => {
    const resolution = resolveCompensationEvidence(
      "Base salary competitive; annual bonus SGD 50,000",
      null,
    );

    expect(resolution).toMatchObject({ kind: "UNDISCLOSED", input: null });
  });

  it("accepts consistent raw monthly and annual base disclosures without double-counting", () => {
    const resolution = resolveCompensationEvidence(
      "Base salary SGD 250,000 per year gross; base salary SGD 20,833.33 per month gross",
      null,
    );

    expect(resolution.kind).toBe("SUPPORTED");
    expect(resolution.input).toMatchObject({
      salary_min: 250000,
      salary_max: 250000,
      salary_period: "ANNUAL",
      salary_basis: "GROSS",
    });
  });

  it("requires verification when raw base-salary segments conflict", () => {
    const resolution = resolveCompensationEvidence(
      "Base salary SGD 250,000 per year gross; base salary SGD 180,000 per year gross",
      null,
    );

    expect(resolution).toMatchObject({ kind: "UNRESOLVED", input: null });
    expect(resolution.reason).toMatch(/conflict|multiple|verify/i);
  });

  it("does not accept multiple components unless compensation evidence is supported", () => {
    const evidence = CompensationEvidenceSchema.parse({
      status: "UNKNOWN",
      components: [
        baseComponent("comp.annual", "Base salary SGD 250,000 per year gross", "ANNUAL", 250000),
        baseComponent("comp.monthly", "Base salary SGD 20,833.33 per month gross", "MONTHLY", 20833.33),
      ],
      evidence: [],
    });

    const resolution = resolveCompensationEvidence(null, evidence);

    expect(resolution).toMatchObject({ kind: "UNRESOLVED", input: null });
  });

  it("preserves an explicitly disclosed net basis without converting it to gross", () => {
    const evidence = CompensationEvidenceSchema.parse({
      status: "SUPPORTED",
      components: [baseComponent("comp.net", "Net base salary S$300,000 per year", "ANNUAL", 300000, "NET")],
      evidence: [],
    });

    const resolution = resolveCompensationEvidence(null, evidence);

    expect(resolution.kind).toBe("SUPPORTED");
    expect(resolution.input?.salary_basis).toBe("NET");
  });
});
