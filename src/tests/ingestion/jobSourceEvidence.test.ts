import { describe, expect, it } from "vitest";
import {
  buildEvidenceRevisionHash,
  buildJobSourceEvidence,
  hasCompleteFetchedPostingReceipt,
  isFetchedPostingReceiptBoundToObservation,
} from "../../ingestion/jobSourceEvidence.js";

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
    expect(Date.parse(evidence.availability.expires_at!) - Date.parse(evidence.availability.verified_at!))
      .toBe(24 * 60 * 60 * 1000);
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

  it("marks complete postings OPEN for exact manifest-approved source hosts for seven days", () => {
    const retrievedAt = "2026-10-24T00:00:00.000Z";
    const completeDescription = [
      "The role designs and operates production data and AI platform services for engineering teams.",
      "Responsibilities include building distributed services, maintaining data pipelines, and improving reliability.",
      "Qualifications include professional software engineering experience and a record of delivering production systems.",
    ].join(" ");
    const evidence = buildJobSourceEvidence({
      ...baseInput,
      sourceName: "HIMALAYAS",
      sourcePluginKey: "himalayas",
      sourceUrl: "https://www.himalayas.app/jobs/role-42",
      canonicalApplyUrl: "https://www.himalayas.app/jobs/role-42",
      retrievedAt,
      rawPayload: {},
      descriptionText: completeDescription,
      fullPostingHosts: ["himalayas.app", "www.himalayas.app"],
    });

    expect(evidence.description.completeness_status).toBe("COMPLETE");
    expect(evidence.availability).toMatchObject({
      status: "OPEN",
      verification_method: "VERIFIED_POSTING_RETRIEVAL",
      reason_code: "FULL_POSTING_RETRIEVED",
      verified_at: retrievedAt,
      expires_at: "2026-10-31T00:00:00.000Z",
    });
  });

  it.each(["GREENHOUSE", "LEVER", "ASHBY", "WORKABLE", "SMARTRECRUITERS"])(
    "gives a complete %s ATS posting a seven-day availability window",
    (sourceName) => {
      const completeDescription = [
        "The role designs and operates production data and AI platform services for engineering teams.",
        "Responsibilities include building distributed services, maintaining data pipelines, and improving reliability.",
        "Qualifications include professional software engineering experience and a record of delivering production systems.",
      ].join(" ");
      const evidence = buildJobSourceEvidence({
        ...baseInput,
        sourceName,
        retrievedAt: "2026-10-24T00:00:00.000Z",
        rawPayload: { id: "job-42", status: "active" },
        descriptionText: completeDescription,
      });

      expect(evidence.description.completeness_status).toBe("COMPLETE");
      expect(evidence.availability).toMatchObject({ status: "OPEN", reason_code: "FULL_POSTING_RETRIEVED" });
      expect(Date.parse(evidence.availability.expires_at!) - Date.parse(evidence.availability.verified_at!))
        .toBe(7 * 24 * 60 * 60 * 1000);
    },
  );

  it("keeps an incomplete ATS listing on the one-day window", () => {
    const retrievedAt = "2026-10-24T00:00:00.000Z";
    const evidence = buildJobSourceEvidence({
      ...baseInput,
      sourceName: "LEVER",
      retrievedAt,
      rawPayload: { id: "job-42", status: "active" },
      descriptionText: "A short role teaser.",
    });

    expect(evidence.description.completeness_status).not.toBe("COMPLETE");
    expect(evidence.availability.status).toBe("OPEN");
    expect(Date.parse(evidence.availability.expires_at!) - Date.parse(evidence.availability.verified_at!))
      .toBe(24 * 60 * 60 * 1000);
  });

  it("keeps board postings UNKNOWN when the URL host is not manifest-approved or the description is incomplete", () => {
    const notApproved = buildJobSourceEvidence({
      ...baseInput,
      sourceName: "JOBICY",
      sourcePluginKey: "jobicy",
      sourceUrl: "https://attacker.example/jobs/role-42",
      rawPayload: {},
      fullPostingHosts: ["jobicy.com", "www.jobicy.com"],
    });
    const incomplete = buildJobSourceEvidence({
      ...baseInput,
      sourceName: "JOBICY",
      sourcePluginKey: "jobicy",
      sourceUrl: "https://jobicy.com/jobs/role-42",
      descriptionText: "A short role teaser.",
      rawPayload: {},
      fullPostingHosts: ["jobicy.com", "www.jobicy.com"],
    });

    expect(notApproved.availability.status).toBe("UNKNOWN");
    expect(incomplete.description.completeness_status).not.toBe("COMPLETE");
    expect(incomplete.availability.status).toBe("UNKNOWN");
  });

  it("requires a safe HTTP(S) URL and exact manifest host before treating a board posting as retrieved", () => {
    const completeDescription = [
      "The role designs and operates production data and AI platform services for engineering teams.",
      "Responsibilities include building distributed services, maintaining data pipelines, and improving reliability.",
      "Qualifications include professional software engineering experience and a record of delivering production systems.",
    ].join(" ");
    const hosts = ["jobicy.com", "www.jobicy.com"];
    for (const sourceUrl of [
      "ftp://jobicy.com/jobs/role-42",
      "https://user:secret@jobicy.com/jobs/role-42",
      "https://careers.jobicy.com/jobs/role-42",
    ]) {
      const evidence = buildJobSourceEvidence({
        ...baseInput,
        sourceName: "JOBICY",
        sourcePluginKey: "jobicy",
        sourceUrl,
        rawPayload: {},
        descriptionText: completeDescription,
        fullPostingHosts: hosts,
      });
      expect(evidence.description.completeness_status).toBe("COMPLETE");
      expect(evidence.availability.status).toBe("UNKNOWN");
    }
  });

  it("binds Gmail fetch receipts to the exact discovery observation, URL, and staged posting", () => {
    const retrievedAt = "2026-10-24T00:00:00.000Z";
    const completeDescription = [
      "The role designs and operates production data and AI platform services for engineering teams.",
      "Responsibilities include building distributed services, maintaining data pipelines, and improving reliability.",
      "Qualifications include professional software engineering experience and a record of delivering production systems.",
    ].join(" ");
    const discoveryObservationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const postingUrl = "https://careers.example.test/jobs/role-42";
    const receiptPayload = {
      source_content_status: "COMPLETE",
      discovery_observation_id: discoveryObservationId,
      requested_url: postingUrl,
      canonical_url: postingUrl,
      source_evidence: {
        requestedUrl: postingUrl,
        resolvedUrl: "https://api.lever.co/v0/postings/acme/role-42?mode=json",
        redirectHistory: [],
        retrievedAt,
        httpStatus: 200,
        contentType: "application/json",
        responseHash: "a".repeat(64),
      },
      posting: { title: baseInput.title, companyName: baseInput.companyName, description: completeDescription, canonicalUrl: postingUrl },
    };
    const lineage = {
      discoveryObservationId,
      discoverySourceUrl: postingUrl,
      postingSourceUrl: postingUrl,
      companyName: baseInput.companyName,
      title: baseInput.title,
      description: completeDescription,
    };
    const fetched = buildJobSourceEvidence({
      ...baseInput,
      sourceName: "EMPLOYER_WEBSITE",
      sourcePluginKey: "employer_website",
      sourceUrl: postingUrl,
      canonicalApplyUrl: postingUrl,
      rawPayload: receiptPayload,
      retrievedAt,
      descriptionText: completeDescription,
      fetchedPostingLineage: lineage,
    });
    const alertOnly = buildJobSourceEvidence({
      ...baseInput,
      sourceName: "GMAIL_ALERT",
      sourcePluginKey: "gmail_alert",
      rawPayload: { body_text: "Open the position and apply online." },
      retrievedAt,
      descriptionText: completeDescription,
    });

    expect(fetched.availability).toMatchObject({
      status: "OPEN",
      verification_method: "VERIFIED_POSTING_RETRIEVAL",
      reason_code: "FULL_POSTING_RETRIEVED",
      expires_at: "2026-10-31T00:00:00.000Z",
    });
    expect(alertOnly.availability).toMatchObject({
      status: "UNKNOWN",
      verification_method: "NONE",
      reason_code: "AVAILABILITY_NOT_VERIFIED",
    });
    expect(isFetchedPostingReceiptBoundToObservation(receiptPayload, lineage)).toBe(true);
    const incompleteReceipt = {
      ...receiptPayload,
      source_evidence: { ...receiptPayload.source_evidence, redirectHistory: undefined },
    };
    expect(hasCompleteFetchedPostingReceipt(incompleteReceipt)).toBe(false);
    const incompleteEvidence = buildJobSourceEvidence({
      ...baseInput,
      sourceName: "EMPLOYER_WEBSITE",
      sourcePluginKey: "employer_website",
      sourceUrl: postingUrl,
      canonicalApplyUrl: postingUrl,
      rawPayload: incompleteReceipt,
      retrievedAt,
      descriptionText: completeDescription,
      fetchedPostingLineage: lineage,
    });
    expect(incompleteEvidence.availability.status).toBe("UNKNOWN");
    expect(isFetchedPostingReceiptBoundToObservation({ ...receiptPayload, discovery_observation_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, lineage)).toBe(false);
    expect(isFetchedPostingReceiptBoundToObservation({
      ...receiptPayload,
      requested_url: "https://careers.example.test/jobs/other",
      source_evidence: { ...receiptPayload.source_evidence, requestedUrl: "https://careers.example.test/jobs/other" },
    }, lineage)).toBe(false);
    expect(isFetchedPostingReceiptBoundToObservation({
      ...receiptPayload,
      canonical_url: "https://careers.example.test/jobs/other",
    }, lineage)).toBe(false);
    expect(isFetchedPostingReceiptBoundToObservation({
      ...receiptPayload,
      posting: { ...receiptPayload.posting, canonicalUrl: "https://careers.example.test/jobs/other" },
    }, lineage)).toBe(false);
    expect(isFetchedPostingReceiptBoundToObservation({
      ...receiptPayload,
      posting: { ...receiptPayload.posting, title: "Different role" },
    }, lineage)).toBe(false);

    const mismatchedReceipts = [
      { ...receiptPayload, discovery_observation_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      {
        ...receiptPayload,
        requested_url: "https://careers.example.test/jobs/other",
        source_evidence: { ...receiptPayload.source_evidence, requestedUrl: "https://careers.example.test/jobs/other" },
      },
      { ...receiptPayload, canonical_url: "https://careers.example.test/jobs/other" },
      { ...receiptPayload, posting: { ...receiptPayload.posting, canonicalUrl: "https://careers.example.test/jobs/other" } },
      { ...receiptPayload, posting: { ...receiptPayload.posting, title: "Different role" } },
      { ...receiptPayload, posting: { ...receiptPayload.posting, companyName: "Different company" } },
      { ...receiptPayload, posting: { ...receiptPayload.posting, description: "Different description" } },
    ];
    for (const mismatchedReceipt of mismatchedReceipts) {
      const evidence = buildJobSourceEvidence({
        ...baseInput,
        sourceName: "EMPLOYER_WEBSITE",
        sourcePluginKey: "employer_website",
        sourceUrl: postingUrl,
        canonicalApplyUrl: postingUrl,
        rawPayload: mismatchedReceipt,
        retrievedAt,
        descriptionText: completeDescription,
        fetchedPostingLineage: lineage,
      });
      expect(evidence.availability.status).toBe("UNKNOWN");
    }
  });

  it("keeps pasted and uploaded manual postings UNKNOWN without independent availability evidence", () => {
    const pasted = buildJobSourceEvidence({
      ...baseInput,
      sourceName: "MANUAL_STREAMLIT",
      sourcePluginKey: "manual_streamlit",
      rawPayload: {
        source: "MANUAL_STREAMLIT",
        source_content_status: "USER_PROVIDED",
        source_provenance: "USER_PROVIDED",
      },
    });
    const uploaded = buildJobSourceEvidence({
      ...baseInput,
      sourceName: "MANUAL_IMPORT",
      sourcePluginKey: "manual_import",
      rawPayload: { source: "MANUAL_IMPORT", user_confirmed_posting: true },
    });

    expect(pasted.availability.status).toBe("UNKNOWN");
    expect(uploaded.availability.status).toBe("UNKNOWN");
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

  it("uses explicit employer organization evidence for opportunity categories", () => {
    const evidence = buildJobSourceEvidence({
      ...baseInput,
      companyName: "National University of Singapore",
      rawPayload: { organizationType: "university" },
    });
    const commercialEvidence = buildJobSourceEvidence({
      ...baseInput,
      companyName: "Readiness Commercial Fixture Labs",
      rawPayload: { organizationType: "commercial" },
    });

    expect(evidence.opportunity_category).toMatchObject({
      status: "SUPPORTED",
      value: "UNIVERSITY_RESEARCH",
    });
    expect(commercialEvidence.opportunity_category).toMatchObject({
      status: "SUPPORTED",
      value: "COMMERCIAL",
    });
  });
});
