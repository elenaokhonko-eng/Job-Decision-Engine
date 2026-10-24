import { describe, expect, it } from "vitest";
import { normalizePostingUrl, stableSourcePostingIdentity } from "../../ingestion/postingIdentity.js";

describe("stable posting identity normalization", () => {
  it("normalizes LinkedIn jobs/view and comm/jobs/view variants to the stable posting ID", () => {
    const regular = normalizePostingUrl("https://www.linkedin.com/jobs/view/123456789/?trackingId=mail&utm_source=alert", "LINKEDIN");
    const community = normalizePostingUrl("https://www.linkedin.com/comm/jobs/view/123456789?refId=another", "LINKEDIN");

    expect(regular).toBe("linkedin-job:123456789");
    expect(community).toBe(regular);
    expect(stableSourcePostingIdentity("LINKEDIN", null, "https://www.linkedin.com/jobs/view/123456789/?trk=mail")).toBe("linkedin:linkedin-job:123456789");
    expect(stableSourcePostingIdentity("LINKEDIN", "123456789", null)).toBe("linkedin:linkedin-job:123456789");
  });

  it("strips tracking parameters and trailing slashes without merging different ATS postings", () => {
    expect(normalizePostingUrl("https://boards.example/jobs/42/?utm_campaign=email&gh_src=abc", "GREENHOUSE"))
      .toBe("boards.example/jobs/42");
    expect(stableSourcePostingIdentity("GREENHOUSE", "42", "https://boards.example/jobs/42")).not.toBe(
      stableSourcePostingIdentity("GREENHOUSE", "43", "https://boards.example/jobs/43"),
    );
  });
});
