/**
 * Job aggregators: sites that list other employers' postings. An alert from one of them is a lead, not a job:
 * its card carries a title, an employer and a snippet, and its page cannot be fetched without a signed-in
 * browser. A lead becomes a rankable job only when the employer's own posting is resolved and verified open
 * (the employer-board lookup, or a saved-jobs export that carries the full text).
 *
 * Only a company alert with a full posting link on the employer's own site (or its applicant-tracking site) is
 * ingested as a job from Gmail. See src/ingestion/emailAlertExtractor.ts and scripts/parse_emails.ts.
 */
export const AGGREGATOR_HOSTS = [
  "linkedin.com",
  "mycareersfuture.gov.sg",
  "swda.gov.sg",
  "indeed.com",
  "glassdoor.com",
  "jobstreet.com",
  "jobsdb.com",
  "ziprecruiter.com",
  "monster.com",
  "simplyhired.com",
  "efinancialcareers.com",
  "jobbank.gov.sg",
] as const;

/**
 * A case-insensitive POSIX regex (Postgres ~*) that matches a URL whose host is an aggregator or a subdomain of one.
 * "[.]" matches a literal dot without a backslash escape.
 */
export function aggregatorUrlPattern(): string {
  const hosts = AGGREGATOR_HOSTS.map((host) => host.split(".").join("[.]"));
  return `^https?://([^/@]*[.])?(${hosts.join("|")})([:/?#]|$)`;
}

export type AlertLeadKind = "COMPANY_POSTING" | "AGGREGATOR_LEAD";

/** The aggregator a hostname belongs to (the host itself or a subdomain of it), or null for an employer site. */
export function aggregatorHostOf(hostname: string): string | null {
  const host = hostname.toLowerCase();
  return AGGREGATOR_HOSTS.find((aggregator) => host === aggregator || host.endsWith(`.${aggregator}`)) ?? null;
}
