import { describe, expect, it } from "vitest";
import { companyMatches } from "../../ingestion/jobContentFetcher.js";
import { savedPostingMatchesDiscovery } from "../../ingestion/linkedInSavedExport.js";
import { isUnknownEmployerName, normalizePostingUrl, stableSourcePostingIdentity } from "../../ingestion/postingIdentity.js";

// Synthetic shapes of the LinkedIn logo URL tails older Gmail cards stored as the employer.
const LOGO_LIKE_EMPLOYERS = [
  "logo_100_100/company-logo_100_100/0/1631425624819/example_holdings_logo?e=2147483647&v=beta&t=abc",
  "logo_100_100/B56ZexampleQ-/0/1750812406096?e=2147483647&t=abc\" alt=\"Exa",
  "https://media.example.com/dms/image/v2/C4E0BAQ/company-logo_100_100/0/1/example_logo.png",
  "<img src=\"x\">",
  "src=\"https://media.example.com/x\"",
];

describe("unknown employer values", () => {
  it.each(["", "   ", "Unknown", "Unknown Company", ...LOGO_LIKE_EMPLOYERS])("treats %j as no employer", (value) => {
    expect(isUnknownEmployerName(value)).toBe(true);
  });

  it.each([
    "Example Holdings",
    "Example Analytics Pte. Ltd.",
    "Booking.com",
    "AT&T",
    "Example A/S",
    "Example Research (Asia) / Example Labs",
    "Example Technological University",
  ])("keeps %j as a real employer name", (value) => {
    expect(isUnknownEmployerName(value)).toBe(false);
  });

  it.each([
    ["a letter run", "a".repeat(1_000_000)],
    ["a scheme-like run", "a".repeat(1_000_000) + ":/"],
    ["an attribute-like run", "a-".repeat(500_000) + " = "],
    ["a slash-free token run", "x/".repeat(1) + "y".repeat(1_000_000)],
  ])("checks 1 MB of adversarial text (%s) in linear time", (_label, value) => {
    const started = performance.now();
    expect(isUnknownEmployerName(value)).toBe(true);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("checks name-sized adversarial text quickly through every pattern", () => {
    const values = ["a".repeat(199), "a-".repeat(99), "a".repeat(198) + ":/", "a ".repeat(99)];
    const started = performance.now();
    for (let round = 0; round < 200; round += 1) {
      for (const value of values) isUnknownEmployerName(value);
    }
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("matches on the posting alone when the card employer is a logo URL, but never on an empty posting employer", () => {
    for (const expected of LOGO_LIKE_EMPLOYERS) {
      expect(companyMatches(expected, "Example Holdings", "linkedin.com")).toBe(true);
      expect(companyMatches(expected, "", "linkedin.com")).toBe(false);
    }
  });

  it("still requires a real card employer to match", () => {
    expect(companyMatches("Example Holdings", "Example Holdings", "linkedin.com")).toBe(true);
    expect(companyMatches("Example Holdings", "Other Analytics", "linkedin.com")).toBe(false);
  });

  it("lets a saved export attach to a logo-employer card on the title alone, and only on the title", () => {
    const discovery = { title: "Synthetic Data Architect", companyName: LOGO_LIKE_EMPLOYERS[0]! };
    expect(savedPostingMatchesDiscovery(discovery, { title: "Synthetic Data Architect", companyName: "Example Holdings" }))
      .toEqual({ matches: true });
    expect(savedPostingMatchesDiscovery(discovery, { title: "Different Role", companyName: "Example Holdings" }))
      .toEqual({ matches: false, reason: "TITLE_MISMATCH" });
    expect(savedPostingMatchesDiscovery(
      { title: "Synthetic Data Architect", companyName: "Example Holdings" },
      { title: "Synthetic Data Architect", companyName: "Other Analytics" },
    )).toEqual({ matches: false, reason: "COMPANY_MISMATCH" });
  });
});

describe("stable posting identity normalization", () => {
  it("normalizes LinkedIn jobs/view and comm/jobs/view variants to the stable posting ID", () => {
    const regular = normalizePostingUrl("https://www.linkedin.com/jobs/view/123456789/?trackingId=mail&utm_source=alert", "LINKEDIN");
    const community = normalizePostingUrl("https://www.linkedin.com/comm/jobs/view/123456789?refId=another", "LINKEDIN");

    expect(regular).toBe("linkedin-job:123456789");
    expect(community).toBe(regular);
    expect(stableSourcePostingIdentity("LINKEDIN", null, "https://www.linkedin.com/jobs/view/123456789/?trk=mail")).toBe("linkedin:linkedin-job:123456789");
    expect(stableSourcePostingIdentity("LINKEDIN", "123456789", null)).toBe("linkedin:linkedin-job:123456789");
  });

  it("does not treat a host with a LinkedIn-like suffix as a LinkedIn host", () => {
    expect(normalizePostingUrl("https://notlinkedin.com/jobs/view/123456789/", "GREENHOUSE"))
      .toBe("notlinkedin.com/jobs/view/123456789");
  });

  it("strips tracking parameters and trailing slashes without merging different ATS postings", () => {
    expect(normalizePostingUrl("https://boards.example/jobs/42/?utm_campaign=email&gh_src=abc", "GREENHOUSE"))
      .toBe("boards.example/jobs/42");
    expect(stableSourcePostingIdentity("GREENHOUSE", "42", "https://boards.example/jobs/42")).not.toBe(
      stableSourcePostingIdentity("GREENHOUSE", "43", "https://boards.example/jobs/43"),
    );
  });
});
