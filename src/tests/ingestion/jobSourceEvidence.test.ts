import { describe, expect, it } from "vitest";
import { buildEvidenceRevisionHash, buildJobSourceEvidence } from "../../ingestion/jobSourceEvidence.js";

const baseInput = {
  sourceName: "GREENHOUSE",
  sourcePluginKey: "greenhouse",
  sourcePluginRevisionId: null,
  sourceExternalId: "job-42",
  sourceUrl: "https://boards.greenhouse.io/acme/jobs/42",
  canonicalApplyUrl: "https://boards.greenhouse.io/acme/jobs/42",
  retrievedAt: "2026-10-24T00:00:00.000Z",
  rawPayloadHash: "a".repeat(64),
  rawPayload: {
    id: 42,
    publishedAt: 1790812800,
    updatedAt: "2026-10-20T00:00:00Z",
    validThrough: "2026-12-31T23:59:59Z",
    status: "active",
  },
  companyName: "Acme",
  title: "Technical Delivery Lead",
  locationRaw: "Singapore",
  workplaceTypeRaw: "ASSUMED_HYBRID",
  employmentTypeRaw: "FULL_TIME",
  compensationRaw: "UNKNOWN",
  descriptionText: "<h2>Responsibilities</h2><ul><li>Design and deliver technical platform changes.</li><li>Coordinate engineering release work.</li></ul><h2>Qualifications</h2><p>Experience with data systems and technical delivery.</p>",
} as const;

describe("job source evidence builder", () => {
  it("preserves description structure, exact normalized offsets, dates and unknown pay", () => {
    const evidence = buildJobSourceEvidence(baseInput);
    const { normalized_text: normalizedText, segments } = evidence.description;

    expect(segments.map((segment) => segment.kind)).toEqual([
      "HEADING", "LIST_ITEM", "LIST_ITEM", "HEADING", "PARAGRAPH",
    ]);
    for (const segment of segments) {
      expect(normalizedText.slice(segment.normalized_start_offset, segment.normalized_end_offset)).toBe(segment.text);
    }
    expect(evidence.dates.published_at).toMatchObject({
      status: "SUPPORTED",
      basis: "PUBLISHED_AT",
      timestamp_unit: "UNIX_SECONDS",
    });
    expect(evidence.dates.source_updated_at.basis).toBe("SOURCE_UPDATED_AT");
    expect(evidence.dates.expires_at.value).toBe("2026-12-31T23:59:59.000Z");
    expect(evidence.availability).toMatchObject({ status: "OPEN", verification_method: "EMPLOYER_ATS_LISTING" });
    expect(evidence.workability.work_mode).toMatchObject({ status: "UNKNOWN", value: "HYBRID" });
    expect(evidence.compensation).toMatchObject({ status: "UNKNOWN", components: [] });
    expect(evidence.opportunity_category).toMatchObject({ status: "UNKNOWN", value: null });
  });

  it("does not infer USD from a bare dollar sign or a research category from job-description keywords", () => {
    const evidence = buildJobSourceEvidence({
      ...baseInput,
      sourceName: "HIMALAYAS",
      companyName: "Acme",
      compensationRaw: "$120k–$150k per year; university research is one of our customer domains",
      rawPayload: {},
    });

    expect(evidence.compensation.status).toBe("UNKNOWN");
    expect(evidence.compensation.components[0]?.currency).toBeNull();
    expect(evidence.opportunity_category).toMatchObject({ status: "UNKNOWN", value: null });
    expect(evidence.availability.status).toBe("UNKNOWN");
  });

  it("preserves separate base, variable, and equity compensation components with k notation", () => {
    const evidence = buildJobSourceEvidence({
      ...baseInput,
      compensationRaw: "USD 120k–150k gross base salary per year plus USD 30k–50k gross OTE per year and RSU 100k gross annually",
    });

    expect(evidence.compensation.components).toHaveLength(3);
    expect(evidence.compensation.components.map((component) => component.component_type)).toEqual([
      "BASE_CASH",
      "VARIABLE_CASH",
      "EQUITY",
    ]);
    expect(evidence.compensation.components[0]).toMatchObject({
      amount_min: 120000,
      amount_max: 150000,
      currency: "USD",
      period: "ANNUAL",
      pay_basis: "GROSS",
    });
    expect(evidence.compensation.components[1]).toMatchObject({ amount_min: 30000, amount_max: 50000 });
    expect(evidence.compensation.components[2]).toMatchObject({ amount_min: 100000, amount_max: 100000 });
  });

  it("removes script and style content with malformed closing-tag attributes", () => {
    const evidence = buildJobSourceEvidence({
      ...baseInput,
      descriptionText: "<p>Visible role details.</p><script>untrusted()</script\t\n trailing><style>hidden</style extra>Still visible.",
    });

    expect(evidence.description.normalized_text).toContain("Visible role details.");
    expect(evidence.description.normalized_text).toContain("Still visible.");
    expect(evidence.description.normalized_text).not.toContain("untrusted");
    expect(evidence.description.normalized_text).not.toContain("hidden");
  });

  it("preserves structured hourly assumptions and can parse k-valued source fields", () => {
    const evidence = buildJobSourceEvidence({
      ...baseInput,
      compensationRaw: "UNKNOWN",
      rawPayload: {
        salaryMin: "100k",
        salaryMax: "120k",
        salaryCurrency: "SGD",
        salaryPeriod: "ANNUAL",
        salaryBasis: "GROSS",
        guaranteedHoursPerWeek: 40,
        paidWeeksPerYear: 52,
      },
    });

    expect(evidence.compensation).toMatchObject({
      status: "SUPPORTED",
      components: [{
        component_type: "BASE_CASH",
        amount_min: 100000,
        amount_max: 120000,
        currency: "SGD",
        period: "ANNUAL",
        guaranteed_hours_per_week: 40,
        paid_weeks_per_year: 52,
        pay_basis: "GROSS",
      }],
    });
  });

  it("keeps semantic evidence revisions stable across retrieval-only timestamp changes", () => {
    const first = buildJobSourceEvidence(baseInput);
    const retrievedAgain = buildJobSourceEvidence({
      ...baseInput,
      retrievedAt: "2026-10-25T00:00:00.000Z",
    });

    expect(buildEvidenceRevisionHash(first)).toBe(buildEvidenceRevisionHash(retrievedAgain));
  });

  it("extracts salary from the full description when the adapter compensation field is undisclosed", () => {
    const evidence = buildJobSourceEvidence({
      ...baseInput,
      compensationRaw: "UNKNOWN",
      descriptionText: "<h2>Compensation</h2><p>SGD250,000 gross base salary per year.</p>",
      rawPayload: {},
    });

    expect(evidence.compensation).toMatchObject({
      status: "SUPPORTED",
      components: [{
        component_type: "BASE_CASH",
        amount_min: 250000,
        amount_max: 250000,
        currency: "SGD",
        period: "ANNUAL",
        pay_basis: "GROSS",
      }],
    });
    expect(evidence.compensation.evidence[0]?.quote_text).toContain("SGD250,000 gross base salary per year");
  });

  it("extracts only worker-hiring territory clauses and normalizes explicit alternatives", () => {
    const alternative = buildJobSourceEvidence({
      ...baseInput,
      descriptionText: "Candidates must be authorized to work in Singapore or Australia. The team serves customers in the United States.",
      rawPayload: {},
    });
    const unrelatedMention = buildJobSourceEvidence({
      ...baseInput,
      descriptionText: "The team has a Singapore office or a US office. The role builds data products for customers.",
      rawPayload: {},
    });

    expect(alternative.workability.hiring_territories).toMatchObject({
      status: "SUPPORTED",
      operator: "ANY",
      countries: ["SINGAPORE", "AUSTRALIA"],
    });
    expect(alternative.workability.hiring_territories.evidence.map((span) => span.quote_text))
      .toEqual(["Candidates must be authorized to work in Singapore or Australia"]);
    expect(unrelatedMention.workability.hiring_territories).toMatchObject({
      status: "UNKNOWN",
      operator: "UNKNOWN",
      countries: [],
    });

    const separateConditions = buildJobSourceEvidence({
      ...baseInput,
      descriptionText: "Must reside in the U.S. Must be authorized to work in Singapore. U.S. citizenship is required.",
      rawPayload: {},
    });
    expect(separateConditions.workability.hiring_territories.requirements.map((requirement) => ({
      operator: requirement.operator,
      countries: requirement.countries,
      quote: requirement.evidence[0]?.quote_text,
    }))).toEqual([
      { operator: "ANY", countries: ["UNITED_STATES"], quote: "Must reside in the U.S" },
      { operator: "ANY", countries: ["SINGAPORE"], quote: "Must be authorized to work in Singapore" },
      { operator: "ANY", countries: ["UNITED_STATES"], quote: "U.S. citizenship is required" },
    ]);
  });

  it("parses ranges, minimum-only, frequent and explicitly negated travel separately", () => {
    const makeEvidence = (descriptionText: string) => buildJobSourceEvidence({
      ...baseInput,
      descriptionText,
      rawPayload: {},
    }).workability.travel_pct;

    expect(makeEvidence("Travel is required 20-30% of the time.")).toMatchObject({
      status: "SUPPORTED", minimum: 20, maximum: 30,
    });
    expect(makeEvidence("A minimum of 25% travel is required.")).toMatchObject({
      status: "SUPPORTED", minimum: 25, maximum: null,
    });
    expect(makeEvidence("Frequent travel is required.")).toMatchObject({
      status: "UNKNOWN", minimum: null, maximum: null,
    });
    expect(makeEvidence("No travel is required.")).toMatchObject({
      status: "SUPPORTED", minimum: 0, maximum: 0,
    });
    const mixedNegation = makeEvidence("No regular travel is required, but 30% travel is required for client deployments.");
    expect(mixedNegation).toMatchObject({ status: "SUPPORTED", minimum: 30, maximum: 30 });
    expect(mixedNegation.evidence[0]?.quote_text).toContain("No regular travel is required");
    expect(mixedNegation.evidence[0]?.quote_text).toContain("30% travel is required for client deployments");
    expect(makeEvidence("Minimal travel is required.")).toMatchObject({
      status: "UNKNOWN", minimum: null, maximum: null,
    });
  });

  it("uses explicit employer organization evidence for discounted opportunity categories", () => {
    const evidence = buildJobSourceEvidence({
      ...baseInput,
      companyName: "National University of Singapore",
      rawPayload: { organizationType: "university" },
    });

    expect(evidence.opportunity_category).toMatchObject({
      status: "SUPPORTED",
      value: "UNIVERSITY_RESEARCH",
    });
  });
});
