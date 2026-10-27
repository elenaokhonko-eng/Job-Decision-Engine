import { describe, expect, it } from "vitest";
import { compareStructuredRequirement } from "../../pipeline/requirementComparators.js";

const fact = (statement: string, structured_value: Record<string, unknown> | null = null) => ({
  id: "fact-1",
  statement,
  structured_value,
});

describe("structured requirement comparators", () => {
	it("does not treat insufficient experience as a semantic match", () => {
    const result = compareStructuredRequirement(
      { requirement_type: "EXPERIENCE_YEARS", requirement_text: "At least 8 years experience", quote_text: null, structured_value: { minimum_years: 8 } },
      [fact("Five years of production experience", {
        professional_years: 5,
        scope_complete_for_profile: true,
        evidence_basis: "ATTESTED_TOTAL_DURATION",
        attestation_status: "SELF_ATTESTED",
      })]
    );
		expect(result.status).toBe("MISMATCH");
	});

	it("does not use overall experience for a role-specific experience requirement", () => {
		const result = compareStructuredRequirement(
			{
				requirement_type: "EXPERIENCE_YEARS",
				requirement_text: "At least 10 years of AI engineering experience",
				quote_text: null,
				structured_value: { minimum_years: 10, experience_scope: "AI engineering" },
			},
			[
				fact("20 years of overall professional experience", { professional_years: 20, experience_scope: "overall" }),
				fact("15 years of software industry experience", { professional_years: 15, experience_scope: "software industry" }),
				fact("2 years of AI software coding experience", { professional_years: 2, experience_scope: "AI software coding" }),
			]
		);

		expect(result.status).toBe("UNKNOWN");
		expect(result.rationale).toContain("ledger is not attested complete");
	});

	it("uses scoped software experience when the requirement is role-specific", () => {
		const result = compareStructuredRequirement(
			{
				requirement_type: "EXPERIENCE_YEARS",
				requirement_text: "At least 10 years of software engineering experience",
				quote_text: null,
				structured_value: { minimum_years: 10, experience_scope: "software engineering" },
			},
			[
				fact("15 years of software industry experience", { professional_years: 15, experience_scope: "software industry" }),
				fact("2 years of AI software coding experience", { professional_years: 2, experience_scope: "AI software coding" }),
			]
		);

		expect(result.status).toBe("UNKNOWN");
	});

  it("unions overlapping scoped engagement intervals instead of double-counting them", () => {
    const facts = [
      fact("AI engineering role", {
        experience_years: 2,
        experience_scope: "AI engineering",
        duration_basis: "PROFESSIONAL_PRODUCTION",
        scope_complete_for_profile: true,
        experience_start_date: "2020-01-01",
        experience_end_date: "2022-01-01",
      }),
      fact("AI platform engineering role", {
        experience_years: 2,
        experience_scope: "AI engineering",
        duration_basis: "PROFESSIONAL_PRODUCTION",
        scope_complete_for_profile: true,
        experience_start_date: "2021-01-01",
        experience_end_date: "2023-01-01",
      }),
      fact("Overall professional experience", {
        professional_years: 6,
        experience_scope: "overall professional production",
      }),
    ];

    const threeYearResult = compareStructuredRequirement(
      {
        requirement_type: "EXPERIENCE_YEARS",
        requirement_text: "At least 3 years of AI engineering experience",
        quote_text: null,
        structured_value: { minimum_years: 3, experience_scope: "AI engineering" },
      },
      facts
    );
    const fourYearResult = compareStructuredRequirement(
      {
        requirement_type: "EXPERIENCE_YEARS",
        requirement_text: "At least 4 years of AI engineering experience",
        quote_text: null,
        structured_value: { minimum_years: 4, experience_scope: "AI engineering" },
      },
      facts
    );

    expect(threeYearResult.status).toBe("MATCH");
    expect(fourYearResult.status).toBe("MISMATCH");
    expect(fourYearResult.rationale).toContain("3.0 years");
  });

  it("does not add broad software-industry tenure to attested direct-coding years", () => {
    const result = compareStructuredRequirement(
      {
        requirement_type: "EXPERIENCE_YEARS",
        requirement_text: "At least 8 years of software engineering experience",
        quote_text: "8 years of software engineering experience",
        structured_value: {
          minimum_years: 8,
          scope_schema_version: "experience_scope_v2",
          role_families: ["HANDS_ON_SOFTWARE_ENGINEERING"],
          domain_families: ["SOFTWARE"],
          operator: "ANY",
          duration_basis: "PROFESSIONAL_PRODUCTION",
        },
      },
      [
        fact("15 years of software industry experience", { professional_years: 15, experience_scope: "software industry" }),
        fact("2 years of direct AI-assisted coding", {
          professional_years: 2,
          scope_schema_version: "experience_scope_v2",
          role_families: ["HANDS_ON_SOFTWARE_ENGINEERING"],
          domain_families: ["SOFTWARE", "AI"],
          duration_basis: "PROFESSIONAL_PRODUCTION",
          years_lower_bound: 2,
          years_upper_bound: 2,
          aggregation_kind: "AGGREGATE_TOTAL",
          scope_complete_for_profile: true,
          evidence_basis: "ATTESTED_TOTAL_DURATION",
          attestation_status: "SELF_ATTESTED",
        }),
      ]
    );

    expect(result.status).toBe("MISMATCH");
    expect(result.evidencedYears).toBe(2);
    expect(result.rationale).toContain("2.0 years");
  });

  it("accepts an OR-scoped architecture alternative without requiring coding tenure", () => {
    const result = compareStructuredRequirement(
      {
        requirement_type: "EXPERIENCE_YEARS",
        requirement_text: "At least 8 years of architecture or engineering experience",
        quote_text: "8 years of experience in architecture or engineering",
        structured_value: {
          minimum_years: 8,
          scope_schema_version: "experience_scope_v2",
          role_families: ["ARCHITECTURE", "HANDS_ON_SOFTWARE_ENGINEERING"],
          domain_families: [],
          operator: "ANY",
          duration_basis: "PROFESSIONAL_PRODUCTION",
        },
      },
      [fact("12 years of architecture and solutioning", {
        professional_years: 12,
        scope_schema_version: "experience_scope_v2",
        role_families: ["ARCHITECTURE"],
        domain_families: ["SOFTWARE"],
        duration_basis: "PROFESSIONAL_PRODUCTION",
      })]
    );

    expect(result.status).toBe("MATCH");
    expect(result.evidencedYears).toBe(12);
  });

  it("keeps an incomplete lower-bound experience ledger unresolved", () => {
    const result = compareStructuredRequirement(
      {
        requirement_type: "EXPERIENCE_YEARS",
        requirement_text: "At least 8 years of software engineering experience",
        quote_text: null,
        structured_value: { minimum_years: 8, experience_scope: "software engineering" },
      },
      [fact("2 years of coding experience", {
        professional_years: 2,
        experience_scope: "software coding",
      })]
    );

    expect(result.status).toBe("UNKNOWN");
    expect(result.coverage).toBe(0.25);
  });

  it("requires the explicit degree level", () => {
    const result = compareStructuredRequirement(
      { requirement_type: "DEGREE", requirement_text: "Master's degree required", quote_text: null, structured_value: null },
      [fact("Bachelor of Science in Computer Science")]
    );
    expect(result.status).toBe("MISMATCH");
  });

  it("keeps unverifiable work authorization unknown", () => {
    const result = compareStructuredRequirement(
      { requirement_type: "WORK_AUTH", requirement_text: "Authorized to work in the United States", quote_text: null, structured_value: null },
      [fact("Led production data platforms in Singapore")]
    );
    expect(result.status).toBe("UNKNOWN");
  });

  it("matches credentials by normalized credential identity instead of the whole sentence", () => {
    const result = compareStructuredRequirement(
      {
        requirement_type: "CREDENTIAL",
        requirement_text: "Role requires certification.",
        quote_text: "AWS Certified Solutions Architect certification required",
        structured_value: { credential_reference: "AWS Certified Solutions Architect" },
      },
      [fact("AWS Certified Solutions Architect", { credential_name: "AWS Certified Solutions Architect" })]
    );
    expect(result.status).toBe("MATCH");
  });

  it("requires both degree level and explicit subject when the posting specifies a subject", () => {
    const result = compareStructuredRequirement(
      {
        requirement_type: "DEGREE",
        requirement_text: "Master's degree in computer science required",
        quote_text: null,
        structured_value: null,
      },
      [fact("Master of Business Administration")]
    );
    expect(result.status).toBe("MISMATCH");
  });

  it("does not call an unspecified degree subject a mismatch", () => {
    const result = compareStructuredRequirement(
      {
        requirement_type: "DEGREE",
        requirement_text: "Master's degree in computer science required",
        quote_text: null,
        structured_value: null,
      },
      [fact("Master's degree")]
    );
    expect(result.status).toBe("UNKNOWN");
  });

  it("matches work authorization only from explicit authorization evidence", () => {
    const result = compareStructuredRequirement(
      {
        requirement_type: "WORK_AUTH",
        requirement_text: "Authorized to work in Singapore",
        quote_text: null,
        structured_value: null,
      },
      [fact("Authorized to work in Singapore", { jurisdiction: "Singapore", work_authorized: true })]
    );
    expect(result.status).toBe("MATCH");
  });

  it("does not match unrelated engineering or supply-chain domains to AI engineering experience", () => {
    const aiRequirement = {
      requirement_type: "EXPERIENCE_YEARS" as const,
      requirement_text: "At least 4 years of AI engineering experience required",
      quote_text: "4 years of AI engineering experience",
      structured_value: { minimum_years: 4, experience_scope: "AI engineering" },
    };

    // Civil engineering has 'engineering' token, but different domain family
    const civilResult = compareStructuredRequirement(
      aiRequirement,
      [fact("Ten years of civil engineering", { professional_years: 10, experience_scope: "civil engineering" })]
    );
    expect(civilResult.status).toBe("UNKNOWN");
    expect(civilResult.rationale).toContain("No profile duration with positive evidence for the required role/domain scope");

    // Supply-chain operations has 'chain' containing substring 'ai', but different domain family
    const supplyChainResult = compareStructuredRequirement(
      aiRequirement,
      [fact("Ten years of supply-chain operations", { professional_years: 10, experience_scope: "supply-chain operations" })]
    );
    expect(supplyChainResult.status).toBe("UNKNOWN");

    // Relevant machine learning / deep learning experience correctly matches
    const mlResult = compareStructuredRequirement(
      aiRequirement,
      [fact("Five years of machine learning engineering", { professional_years: 5, experience_scope: "machine learning engineering" })]
    );
    expect(mlResult.status).toBe("MATCH");
  });
});
