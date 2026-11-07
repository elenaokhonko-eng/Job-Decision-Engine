/**
 * Deterministic, synthetic Gmail job-alert digests shaped like a multi-card
 * "N new jobs for you" email: each card has a title link, a logo link and a
 * "View job" button pointing at the same vacancy, plus navigation, tracking
 * and unsubscribe links that must be ignored. No real people, companies or
 * mailbox data are used.
 */

export interface DigestFixtureOptions {
  /** Distinguishes digests so their vacancy links do not collide. */
  readonly digestIndex: number;
  readonly cardsPerDigest: number;
}

export function digestVacancyUrl(digestIndex: number, cardIndex: number): string {
  const jobId = 4_200_000_000 + digestIndex * 1_000 + cardIndex;
  return `https://careers.example.com/jobs/${jobId}`;
}

function cardHtml(digestIndex: number, cardIndex: number): string {
  const url = digestVacancyUrl(digestIndex, cardIndex);
  return [
    "<tr><td>",
    `<table role="presentation"><tr><td>`,
    `<a href="${url}"><img src="https://static.example.com/logo-${cardIndex}.png" alt="logo"></a>`,
    `<h3><a href="${url}">Synthetic Data Architect ${digestIndex}-${cardIndex}</a></h3>`,
    `<p>Company: Example Analytics ${cardIndex}</p>`,
    `<p>Location: Example City</p>`,
    `<p>${"Synthetic role summary for a deterministic fixture. ".repeat(6)}</p>`,
    `<a href="${url}">View job</a>`,
    "</td></tr></table>",
    "</td></tr>",
  ].join("");
}

export function digestAlertHtml(options: DigestFixtureOptions): string {
  const cards = Array.from({ length: options.cardsPerDigest }, (_, cardIndex) => cardHtml(options.digestIndex, cardIndex));
  return [
    "<html><head><style>td{font-family:sans-serif}</style></head><body>",
    `<table><tr><td><h2>${options.cardsPerDigest} new synthetic jobs for you</h2></td></tr>`,
    ...cards,
    '<tr><td><a href="https://www.example.com/email-settings">Manage preferences</a> ',
    '<a href="https://www.example.com/unsubscribe">Unsubscribe</a> ',
    '<img src="https://www.example.com/tracking-pixel.gif" alt=""></td></tr>',
    "</table></body></html>",
  ].join("\n");
}

/** Returns a base64url RFC 5322 message, matching what Gmail's `raw` format stores. */
export function digestAlertRaw(options: DigestFixtureOptions): string {
  const html = digestAlertHtml(options);
  const mime = [
    "MIME-Version: 1.0",
    `Subject: ${options.cardsPerDigest} new synthetic jobs for you`,
    "From: alerts@example.com",
    "To: candidate@example.com",
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(html, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n"),
    "",
  ].join("\r\n");
  return Buffer.from(mime, "utf8").toString("base64url");
}
