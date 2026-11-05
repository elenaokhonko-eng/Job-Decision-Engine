import { describe, expect, it } from "vitest";
import {
  decodeGmailRawEmail,
  extractEmailJobCards,
  type EmailJobCard,
} from "../../ingestion/emailAlertExtractor.js";

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
