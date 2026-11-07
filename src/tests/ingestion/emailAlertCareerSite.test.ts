import { describe, expect, it } from "vitest";
import {
  decodeGmailRawEmail,
  employerFromSender,
  extractEmailJobCards,
  extractEmailJobCardsWithLinkSummary,
  isEmailAlertPostingLink,
} from "../../ingestion/emailAlertExtractor.js";
import {
  CAREER_SITE_HOST,
  CAREER_SITE_NAVIGATION_LINKS,
  careerSiteAlertRaw,
  careerSitePostingUrl,
} from "../fixtures/gmailDigestAlerts.js";

function htmlRaw(html: string, from = "alerts@example.com"): string {
  return Buffer.from(
    ["MIME-Version: 1.0", `From: ${from}`, "Content-Type: text/html; charset=utf-8", "", html].join("\r\n"),
    "utf8",
  ).toString("base64url");
}

describe("employer career-site alert extraction", () => {
  it("keeps the postings, strips email tracking parameters and drops every navigation link", async () => {
    const { cards, links } = await extractEmailJobCardsWithLinkSummary(careerSiteAlertRaw({ senderName: "Synthetic Sender" }));

    expect(cards.map((card) => card.sourceUrl)).toEqual([
      careerSitePostingUrl("Synthetic-Platform-Lead", 4_100_000_001) + "?locale=en_US",
      careerSitePostingUrl("Synthetic-Risk-Analyst", 4_100_000_002) + "?locale=en_US",
    ]);
    expect(cards.map((card) => card.title)).toEqual([
      "Synthetic Platform Lead - Example City",
      "Synthetic Risk Analyst - Example City, EC (EC)",
    ]);
    const stagedUrls = cards.map((card) => card.sourceUrl).join(" ");
    for (const navigation of CAREER_SITE_NAVIGATION_LINKS) expect(stagedUrls).not.toContain(navigation);
    expect(links.jobCards).toBe(2);
    expect(links.linksSeen).toBe(links.jobCards + links.nonJobLinksSkipped + links.duplicateLinksCollapsed);
    expect(links.nonJobLinksSkipped).toBeGreaterThanOrEqual(CAREER_SITE_NAVIGATION_LINKS.length);
  });

  it("leaves the employer empty instead of inventing a placeholder", async () => {
    const cards = await extractEmailJobCards(careerSiteAlertRaw({ senderName: "Synthetic Sender" }));
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card.companyName).toBe("");
      expect(JSON.stringify(card)).not.toContain("Unknown Company");
    }
    const { cards: collapsed } = await extractEmailJobCardsWithLinkSummary(careerSiteAlertRaw({ senderName: "Synthetic Sender" }));
    expect(collapsed.map((card) => card.companySource)).toEqual([null, null]);
  });

  it("takes the employer from the sender only when the posting host corroborates it", async () => {
    const { cards } = await extractEmailJobCardsWithLinkSummary(careerSiteAlertRaw({ senderName: "Example Group Bank Careers" }));
    expect(cards.map((card) => [card.companyName, card.companySource])).toEqual([
      ["Example Group Bank", "EMAIL_SENDER"],
      ["Example Group Bank", "EMAIL_SENDER"],
    ]);

    const posting = careerSitePostingUrl("Synthetic-Platform-Lead", 4_100_000_001);
    expect(employerFromSender("Careers at Example Group Bank", posting)).toBe("Example Group Bank");
    expect(employerFromSender("Unrelated Insurer", posting)).toBe("");
    expect(employerFromSender("Careers", posting)).toBe("");
    expect(employerFromSender("no-reply", posting)).toBe("");
    expect(employerFromSender("", posting)).toBe("");
    expect(employerFromSender("Example Group Bank", "https://www.linkedin.com/jobs/view/4300000001")).toBe("");
  });

  it("keeps an employer the card itself names over the sender", async () => {
    const html = `<table><tr><td><a href="${careerSitePostingUrl("Synthetic-Data-Lead", 4_100_000_009)}">Synthetic Data Lead</a>`
      + "<p>Company: Example Card Employer</p></td></tr></table>";
    const { cards } = await extractEmailJobCardsWithLinkSummary(htmlRaw(html, '"Example Group Bank" <jobs@example.com>'));
    expect(cards[0]).toMatchObject({ companyName: "Example Card Employer", companySource: "EMAIL_CARD" });
  });

  it("exposes the sender display name from the decoded message", async () => {
    const decoded = await decodeGmailRawEmail(careerSiteAlertRaw({ senderName: "Example Group Bank" }));
    expect(decoded.senderName).toBe("Example Group Bank");
    const anonymous = await decodeGmailRawEmail(htmlRaw("<p>hello</p>"));
    expect(anonymous.senderName).toBe("");
  });

  it("classifies stored discovery links with the same rules", () => {
    expect(isEmailAlertPostingLink(careerSitePostingUrl("Synthetic-Platform-Lead", 4_100_000_001), "Synthetic Platform Lead - Example City")).toBe(true);
    expect(isEmailAlertPostingLink(CAREER_SITE_NAVIGATION_LINKS[0], "Manage your Job Alerts")).toBe(false);
    expect(isEmailAlertPostingLink(CAREER_SITE_NAVIGATION_LINKS[1], "here")).toBe(false);
    expect(isEmailAlertPostingLink(CAREER_SITE_NAVIGATION_LINKS[2], CAREER_SITE_HOST)).toBe(false);
    expect(isEmailAlertPostingLink(CAREER_SITE_NAVIGATION_LINKS[3], "Careers website")).toBe(false);
    expect(isEmailAlertPostingLink(CAREER_SITE_NAVIGATION_LINKS[4], "Employee Stories")).toBe(false);
    // Navigation wording does not drop a link that names one posting.
    expect(isEmailAlertPostingLink("https://careers.example.com/jobs/4200000123", "here")).toBe(true);
    expect(isEmailAlertPostingLink("https://career9.successfactors.eu/career?career_job_req_id=12345&company=EGBSYNTH", "Synthetic Role")).toBe(true);
    expect(isEmailAlertPostingLink("not a url", "Synthetic Role")).toBe(false);
  });
});
