import { describe, expect, it } from "vitest";
import {
  decodeGmailRawEmail,
  extractEmailJobCards,
  extractEmailJobCardsWithLinkSummary,
  isEmailAlertPostingLink,
  type EmailJobCard,
} from "../../ingestion/emailAlertExtractor.js";
import {
  LINKEDIN_ALERT_MANAGEMENT_LINKS,
  linkedInDigestAlertRaw,
  linkedInJobId,
  linkedInLayoutAlertRaw,
  type LinkedInLayoutCard,
} from "../fixtures/gmailDigestAlerts.js";
import { isUnknownEmployerName } from "../../ingestion/postingIdentity.js";

function gmailRaw(mime: string): string {
  return Buffer.from(mime, "utf8").toString("base64url");
}

describe("decodeGmailRawEmail", () => {
  it("decodes multipart alternatives, base64 HTML, quoted-printable breaks, and encoded Unicode", async () => {
    const html = '<table><tr><td><a href="https://careers.example.com/jobs/42">Café – AI Architect—SG</a><p>Location: Singapore</p></td></tr></table>';
    const encodedHtml = Buffer.from(html, "utf8").toString("base64");
    const raw = gmailRaw([
      "MIME-Version: 1.0",
      'Content-Type: multipart/alternative; boundary="alt"',
      "",
      "--alt",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Position: Caf=C3=A9 Architect",
      "Location: Singapore",
      "https://careers.example.com/jobs/42",
      "--alt",
      'Content-Type: text/html; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      encodedHtml,
      "--alt--",
      "",
    ].join("\r\n"));

    const decoded = await decodeGmailRawEmail(raw);
    expect(decoded.text).toContain("Café Architect");
    expect(decoded.html).toContain("Café");
    expect(decoded.html).toContain("AI Architect");
    expect(decoded.html).toContain("Singapore");
  });

  it("extracts every real card after 15,000 characters and ignores unsubscribe links", async () => {
    const filler = "Alert details and introductory copy. ".repeat(600);
    const html = [
      "<html><body>",
      '<a href="https://careers.example.com/jobs/100">Senior Data Engineer</a>',
      '<a href="https://careers.example.com/jobs/101">Senior Data Engineer</a>',
      '<a href="https://example.com/unsubscribe">Unsubscribe</a>',
      filler,
      '<a href="https://careers.example.com/jobs/102?source=email&amp;slot=3">AI Platform Lead</a>',
      "</body></html>",
    ].join("");
    const cards = await extractEmailJobCards(gmailRaw(
      "MIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n" + html
    ));

    expect(cards.map((card) => card.sourceUrl)).toEqual([
      "https://careers.example.com/jobs/100",
      "https://careers.example.com/jobs/101",
      "https://careers.example.com/jobs/102?source=email&slot=3",
    ]);
    expect(cards[0]?.title).toBe("Senior Data Engineer");
    expect(cards[1]?.title).toBe("Senior Data Engineer");
    expect(cards[2]?.title).toBe("AI Platform Lead");
  });

  it("keeps a plain-text vacancy link and decodes QP soft line breaks and entities", async () => {
    const raw = gmailRaw([
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=ISO-8859-1",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Role: Data Analyst &amp; AI",
      "Territory: Singa=",
      "pore",
      "https://jobs.lever.co/example/abc123",
      "",
    ].join("\r\n"));
    const decoded = await decodeGmailRawEmail(raw);
    const cards: EmailJobCard[] = await extractEmailJobCards(raw);

    expect(decoded.text).toContain("Territory: Singapore");
    expect(cards).toHaveLength(1);
    expect(cards[0]?.sourceUrl).toBe("https://jobs.lever.co/example/abc123");
  });

  it("decodes named and numeric HTML entities in card titles", async () => {
    const raw = gmailRaw(
      'MIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<a href="https://careers.example.com/jobs/42">Caf&eacute; &amp; AI &#x2014; Architect</a>',
    );
    const cards = await extractEmailJobCards(raw);
    expect(cards[0]?.title).toBe("Caf\u00e9 & AI \u2014 Architect");
  });

  it("recovers the role heading when a card link only says Apply now", async () => {
    const html = '<table><tr><td><h2>Director, AI Solution Architect</h2><p>Location: Singapore</p><a href="https://careers.example.com/job/1441267233">Apply now</a></td></tr></table>';
    const cards = await extractEmailJobCards(gmailRaw(
      "MIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n" + html
    ));
    expect(cards).toHaveLength(1);
    expect(cards[0]?.title).toBe("Director, AI Solution Architect");
    expect(cards[0]?.location).toBe("Singapore");
  });

  it("rejects oversized or empty input explicitly rather than truncating", async () => {
    await expect(extractEmailJobCards("")).rejects.toThrow(/no raw RFC 5322/i);
    const oversized = "A".repeat(10 * 1024 * 1024 + 1);
    await expect(extractEmailJobCards(oversized)).rejects.toThrow(/bounded input limit|10 MiB/i);
  });
});

describe("job-card link classification and collapsing", () => {
  // An HTML-only email is decoded with a generated text alternative that
  // repeats each link once, so every anchor is seen twice.
  function htmlRaw(html: string): string {
    return gmailRaw(["MIME-Version: 1.0", "Content-Type: text/html; charset=utf-8", "", html].join("\r\n"));
  }

  it("stages one canonical card per LinkedIn job id and accounts for every skipped or collapsed link", async () => {
    const { cards, links } = await extractEmailJobCardsWithLinkSummary(linkedInDigestAlertRaw({ digestIndex: 4, cardsPerDigest: 3 }));

    expect(cards.map((card) => card.sourceUrl)).toEqual([0, 1, 2].map(
      (card) => `https://www.linkedin.com/jobs/view/${linkedInJobId(4, card)}`,
    ));
    expect(cards.map((card) => card.title)).toEqual([0, 1, 2].map((card) => `Synthetic LinkedIn Architect 4-${card}`));
    // Logo, title and "View job" links in HTML plus the text/plain link.
    expect(cards.map((card) => card.linkCount)).toEqual([4, 4, 4]);
    expect(links).toEqual({
      // 3 cards x (3 job + 1 company) + 8 footer links in HTML; 3 job + 2 footer links in text.
      linksSeen: 25,
      jobCards: 3,
      // 3 company pages + 8 footer links + 2 text footer links.
      nonJobLinksSkipped: 13,
      duplicateLinksCollapsed: 9,
    });
    expect(links.linksSeen).toBe(links.jobCards + links.nonJobLinksSkipped + links.duplicateLinksCollapsed);
  });

  it("never treats LinkedIn search, alert, help, premium or Job Alert Manager links as jobs", async () => {
    const urls = [
      "https://www.linkedin.com/comm/jobs/search?keywords=architect",
      "https://www.linkedin.com/comm/jobs/alerts",
      "https://www.linkedin.com/help/linkedin/answer/67",
      "https://www.linkedin.com/comm/premium/products/",
      "https://www.linkedin.com/jobs/jam/manage",
      "https://www.linkedin.com/comm/jobs/jam",
      "https://www.linkedin.com/jobs/search/?currentJobId=4300000999",
      "https://www.linkedin.com/jobs/collections/recommended/",
    ];
    const html = urls.map((url) => `<p>New job for you: <a href="${url}">View jobs</a></p>`).join("");
    const { cards, links } = await extractEmailJobCardsWithLinkSummary(htmlRaw(html));

    expect(cards).toEqual([]);
    expect(links.jobCards).toBe(0);
    expect(links.nonJobLinksSkipped).toBe(links.linksSeen);
  });

  describe("LinkedIn alert layout (logo cell, title, \"Company · Location\" subtitle)", () => {
    const CARDS: LinkedInLayoutCard[] = [
      { jobId: "4400000101", title: "Synthetic AI COE Lead", subtitle: "Example Charter Holdings &middot; Example City (Hybrid)", logoAlt: "Example Charter Holdings" },
      { jobId: "4400000102", title: "Research Engineer II (Computer Science / Data)", subtitle: "Example Technological University &middot; Example City (On-site)", logoAlt: "Example Technological University" },
      { jobId: "4400000103", title: "Synthetic AI Product Owner", subtitle: "Example Bet &amp; Co &middot; Example City", logoAlt: "Example Bet &amp; Co" },
      { jobId: "4400000104", title: "Synthetic Platform Architect", subtitle: null, logoAlt: "Example Alt Text Pte Ltd" },
      { jobId: "4400000105", title: "Synthetic Data Steward", subtitle: null, logoAlt: "" },
    ];

    it("stores the employer named by the card, never a logo URL or attribute fragment", async () => {
      const { cards } = await extractEmailJobCardsWithLinkSummary(linkedInLayoutAlertRaw(CARDS));

      expect(cards.map((card) => [card.sourceUrl, card.title, card.companyName, card.companySource])).toEqual([
        ["https://www.linkedin.com/jobs/view/4400000101", "Synthetic AI COE Lead", "Example Charter Holdings", "EMAIL_CARD"],
        ["https://www.linkedin.com/jobs/view/4400000102", "Research Engineer II (Computer Science / Data)", "Example Technological University", "EMAIL_CARD"],
        ["https://www.linkedin.com/jobs/view/4400000103", "Synthetic AI Product Owner", "Example Bet & Co", "EMAIL_CARD"],
        // No subtitle: the company-logo alt text names the employer.
        ["https://www.linkedin.com/jobs/view/4400000104", "Synthetic Platform Architect", "Example Alt Text Pte Ltd", "EMAIL_CARD"],
        // Neither: unknown (""), never a placeholder or a URL.
        ["https://www.linkedin.com/jobs/view/4400000105", "Synthetic Data Steward", "", null],
      ]);
      for (const card of cards) {
        expect(card.companyName).not.toMatch(/_logo|company-logo|https?:|[?&]\w+=|["<>]|=/i);
        expect(card.companyName === "" || !isUnknownEmployerName(card.companyName)).toBe(true);
      }
    });

    it("never stages alert-management, Job Alert Manager or MyCareersFuture remove-alert links as postings", async () => {
      const { cards, links } = await extractEmailJobCardsWithLinkSummary(linkedInLayoutAlertRaw(CARDS));

      expect(cards).toHaveLength(CARDS.length);
      expect(cards.every((card) => /^https:\/\/www\.linkedin\.com\/jobs\/view\/\d+$/.test(card.sourceUrl))).toBe(true);
      expect(cards.map((card) => card.title)).not.toContain(LINKEDIN_ALERT_MANAGEMENT_LINKS[0].text);
      expect(links.nonJobLinksSkipped).toBeGreaterThanOrEqual(LINKEDIN_ALERT_MANAGEMENT_LINKS.length);
      expect(links.linksSeen).toBe(links.jobCards + links.nonJobLinksSkipped + links.duplicateLinksCollapsed);
      for (const link of LINKEDIN_ALERT_MANAGEMENT_LINKS) {
        expect(isEmailAlertPostingLink(link.url, link.text)).toBe(false);
      }
    });

    it("yields no card at all for an alert that only carries management links", async () => {
      const html = LINKEDIN_ALERT_MANAGEMENT_LINKS
        .map((link) => `<p><a href="${link.url.replace(/&/g, "&amp;")}">${link.text}</a></p>`).join("");
      const { cards, links } = await extractEmailJobCardsWithLinkSummary(htmlRaw(html));

      expect(cards).toEqual([]);
      expect(links.nonJobLinksSkipped).toBe(links.linksSeen);
    });
  });

  it("does not read a company label out of a logo URL next to a plain-text job link", async () => {
    const text = [
      "Synthetic Analyst",
      "Logo: https://media.example.com/dms/image/v2/C4E0BAQ/company-logo_100_100/0/1631425624819/x_logo?e=1&t=2\" alt=\"Exa",
      "View job: https://careers.example.com/jobs/4200000777",
    ].join("\n");
    const raw = gmailRaw(["MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", text].join("\r\n"));
    const { cards } = await extractEmailJobCardsWithLinkSummary(raw);

    expect(cards.map((card) => card.sourceUrl)).toEqual(["https://careers.example.com/jobs/4200000777"]);
    expect(cards[0]?.companyName).toBe("");
    expect(cards[0]?.companySource).toBeNull();
  });

  it("still reads an explicit Company: label", async () => {
    const html = '<table><tr><td><a href="https://careers.example.com/jobs/4200000778">Synthetic Analyst</a>'
      + "<p>Company: Example Analytics</p></td></tr></table>";
    const { cards } = await extractEmailJobCardsWithLinkSummary(htmlRaw(html));

    expect(cards[0]?.companyName).toBe("Example Analytics");
  });

  it("recognises a LinkedIn job link behind a Google redirect and slugged job paths", async () => {
    const wrapped = "https://www.google.com/url?q=" + encodeURIComponent("https://www.linkedin.com/comm/jobs/view/4300000123/?trackingId=a");
    const html = `<a href="${wrapped}">Synthetic Platform Lead</a>`
      + '<a href="https://sg.linkedin.com/jobs/view/synthetic-platform-lead-at-example-4300000123?trk=b">View job</a>';
    const { cards, links } = await extractEmailJobCardsWithLinkSummary(htmlRaw(html));

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      sourceUrl: "https://www.linkedin.com/jobs/view/4300000123",
      title: "Synthetic Platform Lead",
      linkCount: 4,
    });
    expect(links).toEqual({ linksSeen: 4, jobCards: 1, nonJobLinksSkipped: 0, duplicateLinksCollapsed: 3 });
  });

  it("drops non-LinkedIn navigation by whole path segment while keeping posting slugs", async () => {
    const html = [
      '<a href="https://careers.example.com/jobs/customer-support-lead-77">Customer Support Lead</a>',
      '<a href="https://careers.example.com/jobs/research-scientist-78">Research Scientist</a>',
      '<a href="https://careers.example.com/help/jobs">Job help</a>',
      '<a href="https://careers.example.com/jobs/search?q=data">Search jobs</a>',
      '<a href="https://careers.example.com/account/settings/job-alerts">Job alert settings</a>',
      '<a href="https://careers.example.com/premium/jobs">Premium jobs</a>',
    ].join("");
    const { cards, links } = await extractEmailJobCardsWithLinkSummary(htmlRaw(html));

    expect(cards.map((card) => card.sourceUrl)).toEqual([
      "https://careers.example.com/jobs/customer-support-lead-77",
      "https://careers.example.com/jobs/research-scientist-78",
    ]);
    expect(links).toMatchObject({ linksSeen: 12, jobCards: 2, nonJobLinksSkipped: 8, duplicateLinksCollapsed: 2 });
  });

  it("keeps only MyCareersFuture posting links and unwraps SES click tracking", async () => {
    const ses = (destination: string) =>
      `https://abc123.r.ap-southeast-1.awstrack.me/L0/${encodeURIComponent(destination)}/1/0100-synthetic-signature`;
    const html = [
      '<a href="https://www.mycareersfuture.gov.sg/job/information-technology/synthetic-data-architect-example-0123456789abcdef0123456789abcdef">Synthetic Data Architect</a>',
      '<a href="https://www.mycareersfuture.gov.sg/job/banking-finance/synthetic-risk-lead-example-fedcba9876543210fedcba9876543210?source=alert">Synthetic Risk Lead</a>',
      '<a href="https://www.mycareersfuture.gov.sg/">MyCareersFuture job portal</a>',
      '<a href="https://www.mycareersfuture.gov.sg/search?search=architect&amp;sortBy=new_posting_date">View more jobs</a>',
      '<a href="https://www.mycareersfuture.gov.sg/jobalert/remove/0123456789abcdef0123456789abcdef">synthetic alert, IT Project Manager</a>',
      `<a href="${ses("https://www.mycareersfuture.gov.sg/jobalert/remove/0123456789abcdef0123456789abcdef")}">Remove this job alert</a>`,
      `<a href="${ses("https://service-portal.example.gov.sg/s/feedback")}">contact us</a>`,
      `<a href="${ses("https://careers.example.com/jobs/synthetic-quant-lead-91")}">Synthetic Quant Lead</a>`,
    ].join("");
    const { cards, links } = await extractEmailJobCardsWithLinkSummary(htmlRaw(html));

    expect(cards.map((card) => card.sourceUrl)).toEqual([
      "https://www.mycareersfuture.gov.sg/job/information-technology/synthetic-data-architect-example-0123456789abcdef0123456789abcdef",
      "https://www.mycareersfuture.gov.sg/job/banking-finance/synthetic-risk-lead-example-fedcba9876543210fedcba9876543210",
      "https://careers.example.com/jobs/synthetic-quant-lead-91",
    ]);
    expect(links).toMatchObject({ linksSeen: 16, jobCards: 3, nonJobLinksSkipped: 10, duplicateLinksCollapsed: 3 });
  });

  it("collapses campaign-tagged variants of one posting and keeps the richest title", async () => {
    const html = [
      '<table><tr><td><a href="https://careers.example.com/jobs/55?utm_source=alert&amp;utm_campaign=a">Apply now</a></td></tr></table>',
      '<table><tr><td><a href="https://careers.example.com/jobs/55?utm_source=alert&amp;utm_campaign=b">Principal Data Engineer</a>'
        + "<p>Company: Example Analytics</p><p>Location: Example City</p></td></tr></table>",
    ].join("");
    const { cards, links } = await extractEmailJobCardsWithLinkSummary(htmlRaw(html));

    expect(cards).toEqual([expect.objectContaining({
      sourceUrl: "https://careers.example.com/jobs/55",
      title: "Principal Data Engineer",
      companyName: "Example Analytics",
      location: "Example City",
      linkCount: 4,
    })]);
    expect(links).toEqual({ linksSeen: 4, jobCards: 1, nonJobLinksSkipped: 0, duplicateLinksCollapsed: 3 });
  });
});
