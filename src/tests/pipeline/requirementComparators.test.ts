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
      [fact("Five years of production experience", { professional_years: 5 })]
    );
    expect(result.status).toBe("MISMATCH");
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
});
