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

/**
 * Synthetic LinkedIn-style digest. Each card links the same job three times
 * (logo, title, "View job") with different tracking parameters, links the
 * company page, and is followed by the navigation a real digest carries:
 * job search, alert management, Job Alert Manager, help, premium, a search
 * URL that names a `currentJobId`, and unsubscribe. A text/plain alternative
 * repeats every job link once more with yet another tracking variant.
 */
export const LINKEDIN_NON_JOB_LINKS_PER_DIGEST = [
  "https://www.linkedin.com/comm/jobs/search?keywords=synthetic%20architect&trk=eml",
  "https://www.linkedin.com/comm/jobs/alerts?trk=eml",
  "https://www.linkedin.com/help/linkedin/answer/67?trk=eml",
  "https://www.linkedin.com/comm/premium/products/?upsellOrderOrigin=email",
  "https://www.linkedin.com/jobs/jam/manage?trk=eml",
  "https://www.linkedin.com/comm/jobs/jam?trk=eml",
  "https://www.linkedin.com/jobs/search/?currentJobId=4300000999&trk=eml",
  "https://www.linkedin.com/comm/psettings/email-unsubscribe?trk=eml",
] as const;

export function linkedInJobId(digestIndex: number, cardIndex: number): string {
  return String(4_300_000_000 + digestIndex * 1_000 + cardIndex);
}

function linkedInJobLink(jobId: string, variant: string): string {
  return `https://www.linkedin.com/comm/jobs/view/${jobId}/?trackingId=${variant}%3D%3D&amp;refId=ref-${variant}&amp;lipi=urn%3Ali%3Apage%3Aemail&amp;midToken=tok-${variant}`;
}

function linkedInCardHtml(digestIndex: number, cardIndex: number): string {
  const jobId = linkedInJobId(digestIndex, cardIndex);
  return [
    "<tr><td><table role=\"presentation\"><tr><td>",
    `<a href="${linkedInJobLink(jobId, "logo" + cardIndex)}"><img src="https://media.example.com/logo-${cardIndex}.png" alt=""></a>`,
    `<a href="${linkedInJobLink(jobId, "title" + cardIndex)}">Synthetic LinkedIn Architect ${digestIndex}-${cardIndex}</a>`,
    `<p><a href="https://www.linkedin.com/comm/company/${7_000 + cardIndex}/?trk=eml">Example Analytics ${cardIndex}</a> &middot; Example City</p>`,
    `<a href="${linkedInJobLink(jobId, "button" + cardIndex)}">View job</a>`,
    "</td></tr></table></td></tr>",
  ].join("");
}

export function linkedInDigestAlertRaw(options: DigestFixtureOptions): string {
  const cards = Array.from({ length: options.cardsPerDigest }, (_, cardIndex) => linkedInCardHtml(options.digestIndex, cardIndex));
  const navigation = LINKEDIN_NON_JOB_LINKS_PER_DIGEST.map((url, index) => `<a href="${url.replaceAll("&", "&amp;")}">Footer link ${index}</a>`);
  const html = [
    "<html><body><table>",
    `<tr><td><h2>${options.cardsPerDigest} new synthetic jobs for you</h2></td></tr>`,
    ...cards,
    `<tr><td>${navigation.join(" ")}</td></tr>`,
    "</table></body></html>",
  ].join("\n");
  const text = [
    `${options.cardsPerDigest} new synthetic jobs for you`,
    ...Array.from({ length: options.cardsPerDigest }, (_, cardIndex) => {
      const jobId = linkedInJobId(options.digestIndex, cardIndex);
      return [
        `Synthetic LinkedIn Architect ${options.digestIndex}-${cardIndex}`,
        `Example Analytics ${cardIndex} - Example City`,
        `View job: https://www.linkedin.com/comm/jobs/view/${jobId}/?trackingId=text${cardIndex}&refId=text`,
      ].join("\n");
    }),
    "",
    "Search for more jobs: " + LINKEDIN_NON_JOB_LINKS_PER_DIGEST[0],
    "Unsubscribe: " + LINKEDIN_NON_JOB_LINKS_PER_DIGEST[7],
  ].join("\n");
  const mime = [
    "MIME-Version: 1.0",
    `Subject: ${options.cardsPerDigest} new synthetic jobs for you`,
    "From: jobalerts@example.com",
    "To: candidate@example.com",
    'Content-Type: multipart/alternative; boundary="digest"',
    "",
    "--digest",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(text, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n"),
    "--digest",
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(html, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n"),
    "--digest--",
    "",
  ].join("\r\n");
  return Buffer.from(mime, "utf8").toString("base64url");
}
