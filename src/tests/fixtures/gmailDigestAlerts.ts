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

/** Synthetic employer career-site host used by the career-site alert fixture. */
export const CAREER_SITE_HOST = "careers.examplegroupbank.example";

export function careerSitePostingUrl(slug: string, jobId: number): string {
  return `http://${CAREER_SITE_HOST}/EGB/job/${slug}/${jobId}/`;
}

/**
 * Synthetic employer career-site job alert shaped like a SAP SuccessFactors
 * Career Site Builder email: each posting link carries per-recipient email
 * tracking parameters, the title is followed by a location suffix, and no
 * card names the employer. The footer carries the navigation those emails
 * carry: "Manage your Job Alerts" and "here" portal links, the careers home
 * page, a "Careers website" landing page and an "Employee Stories" page.
 * Every name, title and host is invented.
 */
export const CAREER_SITE_NAVIGATION_LINKS = [
  "https://career9.successfactors.eu/careers?company=EGBSYNTH&career_ns=job_alert&navBarLevel=JOB_MGMT&locale=en_US",
  "https://career9.successfactors.eu/careers?company=EGBSYNTH&loginFlowRequired=true",
  `http://${CAREER_SITE_HOST}/?from=email&refid=synthrefid01&source=2&eid=synthetic01&locale=en_US`,
  "https://www.examplegroupbank.example/en/global-careers/",
  "https://www.examplegroupbank.example/en/global-careers/our-employee-stories/",
] as const;

export function careerSiteAlertRaw(options: { readonly senderName: string }): string {
  const tracking = "?from=email&refid=synthrefid01&source=2&eid=synthetic01&locale=en_US";
  const postings = [
    { url: careerSitePostingUrl("Synthetic-Platform-Lead", 4_100_000_001), title: "Synthetic Platform Lead - Example City" },
    { url: careerSitePostingUrl("Synthetic-Risk-Analyst", 4_100_000_002), title: "Synthetic Risk Analyst - Example City, EC (EC)" },
  ];
  const html = [
    "<html><body><table>",
    "<tr><td><h2>New jobs matching your alert</h2></td></tr>",
    ...postings.map((posting) =>
      `<tr><td><a href="${posting.url}${tracking.replace(/&/g, "&amp;")}">${posting.title}</a></td></tr>`),
    `<tr><td><a href="${CAREER_SITE_NAVIGATION_LINKS[0].replace(/&/g, "&amp;")}">Manage your Job Alerts</a></td></tr>`,
    `<tr><td>To stop receiving these emails, click <a href="${CAREER_SITE_NAVIGATION_LINKS[1].replace(/&/g, "&amp;")}">here</a>.</td></tr>`,
    `<tr><td><a href="${CAREER_SITE_NAVIGATION_LINKS[2].replace(/&/g, "&amp;")}">${CAREER_SITE_HOST}</a></td></tr>`,
    `<tr><td>Find more jobs on our <a href="${CAREER_SITE_NAVIGATION_LINKS[3]}">Careers website</a></td></tr>`,
    `<tr><td>Read our <a href="${CAREER_SITE_NAVIGATION_LINKS[4]}">Employee Stories</a> about life on the job.</td></tr>`,
    "</table></body></html>",
  ].join("\n");
  const mime = [
    "MIME-Version: 1.0",
    "Subject: New synthetic jobs matching your alert",
    `From: "${options.senderName}" <noreply@successfactors.example>`,
    "To: candidate@example.com",
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(html, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n"),
    "",
  ].join("\r\n");
  return Buffer.from(mime, "utf8").toString("base64url");
}

/** One card of the LinkedIn-layout fixture; every name is invented. */
export interface LinkedInLayoutCard {
  readonly jobId: string;
  readonly title: string;
  /** The "Company · Location" subtitle line, or null when the card has none. */
  readonly subtitle: string | null;
  /** The company-logo image's alt text ("" for an empty alt). */
  readonly logoAlt: string;
}

/**
 * Non-posting links a LinkedIn or MyCareersFuture alert carries: the alert
 * itself ("Your job alert for ..."), Job Alert Manager with an alert id,
 * search results and a MyCareersFuture "remove this alert" link. None of them
 * names one posting.
 */
export const LINKEDIN_ALERT_MANAGEMENT_LINKS = [
  { url: "https://www.linkedin.com/comm/jobs/alerts?trk=eml-jobalert", text: "Your job alert for synthetic legal technology" },
  { url: "https://www.linkedin.com/jobs/jam/manage/7300000001?trk=eml", text: "Synthetic legal technology" },
  { url: "https://www.linkedin.com/comm/jobs/jam/manage/7300000002?trk=eml", text: "Synthetic pharma data AI architect" },
  { url: "https://www.linkedin.com/comm/jobs/search-results/?currentJobId=4400000001&keywords=synthetic", text: "See all jobs" },
  { url: "https://www.mycareersfuture.gov.sg/jobalert/remove/0123456789abcdef0123456789abcdef", text: "Synthetic pharma data AI architect" },
] as const;

/** A long per-recipient tracking value, so each link is close to a real one (~900 characters). */
function linkedInTracking(variant: string): string {
  return `?trackingId=${variant}%3D%3D&amp;refId=${variant}&amp;lipi=urn%3Ali%3Apage%3Aemail_email_job_alert_digest_01`
    + `&amp;midToken=${"AQ" + "x".repeat(120)}&amp;midSig=${"0" + "y".repeat(40)}&amp;trk=eml-email_job_alert_digest_01-job_card-0-${variant}`
    + `&amp;trkEmail=eml-email_job_alert_digest_01-job_card-0-${variant}-null-${"z".repeat(30)}&amp;eid=${"e".repeat(40)}`
    + `&amp;otpToken=${"0123456789abcdef".repeat(14)}`;
}

function linkedInLayoutCardHtml(card: LinkedInLayoutCard, index: number): string {
  const link = (variant: string) => `https://www.linkedin.com/comm/jobs/view/${card.jobId}/${linkedInTracking(variant + index)}`;
  const style = "-webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; mso-table-lspace: 0pt; mso-table-rspace: 0pt; ";
  const logo = `https://media.example.com/dms/image/v2/C4E0BAQsynthetic${index}/company-logo_100_100/company-logo_100_100/0/16314256248${index}/synthetic_${index}_logo`
    + `?e=2147483647&amp;v=beta&amp;t=${"Tq".repeat(20)}`;
  return [
    `<tr><td><table width="100%" style="${style}"><tbody><tr>`,
    `<td width="56" style="${style}width: 56px;"><a href="${link("logo")}" target="_blank" style="${style}color: #0a66c2;">`,
    `<img class="inline-block relative bg-color-entity-ghost-background clip-path-circle-8" src="${logo}" alt="${card.logoAlt}" style="${style.repeat(3)}height: 48px; width: 48px;" width="48" height="48"></a></td>`,
    `<td style="${style}"><a href="${link("card")}" target="_blank" style="${style}color: #0a66c2;"><table width="100%"><tbody>`,
    `<tr><td style="${style}"><a href="${link("title")}" target="_blank" style="${style}">${card.title}</a></td></tr>`,
    card.subtitle === null ? "" : `<tr><td style="${style}"><p style="${style}">${card.subtitle}</p></td></tr>`,
    "<tr><td><p>SGD 9K-12K / month</p></td></tr>",
    `<tr><td><table><tbody><tr><td width="16"><img src="https://static.example.com/badge-${index}.png" alt="" width="16" height="16"></td><td><p>Actively recruiting</p></td></tr></tbody></table></td></tr>`,
    "</tbody></table></a></td>",
    "</tr></tbody></table></td></tr>",
  ].join("\n");
}

/**
 * Synthetic LinkedIn job-alert email in the layout LinkedIn sends: a logo
 * cell (a company-logo image with a long licdn-style `src`) and a card cell
 * holding the title link and a "Company · Location" subtitle, all wrapped in
 * long tracking links, followed by alert-management links. HTML only: the
 * card markup is what carries the employer.
 */
export function linkedInLayoutAlertRaw(cards: readonly LinkedInLayoutCard[]): string {
  const html = [
    "<html><body><table><tbody>",
    `<tr><td><h2>Your job alert for synthetic legal technology</h2><p>${cards.length} new jobs match your preferences.</p></td></tr>`,
    ...cards.map(linkedInLayoutCardHtml),
    `<tr><td>${LINKEDIN_ALERT_MANAGEMENT_LINKS.map((link) => `<a href="${link.url.replace(/&/g, "&amp;")}">${link.text}</a>`).join(" ")}</td></tr>`,
    "</tbody></table></body></html>",
  ].join("\n");
  const mime = [
    "MIME-Version: 1.0",
    "Subject: Synthetic legal technology: new jobs",
    "From: LinkedIn Job Alerts <jobalerts@example.com>",
    "To: candidate@example.com",
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(html, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n"),
    "",
  ].join("\r\n");
  return Buffer.from(mime, "utf8").toString("base64url");
}
