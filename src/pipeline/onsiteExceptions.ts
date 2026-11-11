import type { WorkabilityPolicy } from "./workabilityPolicy.js";

/**
 * On-site exceptions to the global "full-time on-site is rejected" rule.
 *
 * - RESEARCH_ROLE: a university/research-institute employer, a hospital or health
 *   body's research unit, or a research title. Researchers' on-site attendance is
 *   effectively hybrid. The lists are public repo config (config/policies/workability.yml).
 * - PREFERRED_EMPLOYER: an employer the user listed in the stage3 preference
 *   `mobility.onsite_exception_employers`. No list means no exception.
 *
 * An exception only lifts on-site / office-day rejections. It never resolves an
 * unknown fact (that stays NEEDS_VERIFICATION) or any other gate.
 */
export type OnsiteExceptionKind = "RESEARCH_ROLE" | "PREFERRED_EMPLOYER";

export interface OnsiteException {
  readonly kind: OnsiteExceptionKind;
  /** What matched: the employer name or the title phrase. */
  readonly matched: string;
  /** Persisted evidence quote explaining the exception. */
  readonly evidence: string;
}

export const ONSITE_EXCEPTION_EVIDENCE_PREFIX = "ON-SITE EXCEPTION";

function words(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compact(value: unknown): string {
  return words(value).replace(/\s+/g, "");
}

function containsWords(text: string, phrase: string): boolean {
  const needle = words(phrase);
  return needle.length > 0 && ` ${text} `.includes(` ${needle} `);
}

/**
 * Whole-word match ("Example Bank" in "Example Bank Singapore"), or a
 * name prefix of at least five letters ("ExampleBank" for "ExampleBankGroup").
 */
export function employerNameMatches(companyName: string, configuredName: string): boolean {
  const company = words(companyName);
  if (!company) return false;
  if (containsWords(company, configuredName)) return true;
  const prefix = compact(configuredName);
  return prefix.length >= 5 && compact(companyName).startsWith(prefix);
}

function exception(kind: OnsiteExceptionKind, matched: string, reason: string): OnsiteException {
  return {
    kind,
    matched,
    evidence: `${ONSITE_EXCEPTION_EVIDENCE_PREFIX} (${kind}): ${reason}; on-site attendance is accepted for this role.`,
  };
}

export function findOnsiteException(
  job: { title?: string | null; company_name?: string | null; description?: string | null },
  policy: Pick<WorkabilityPolicy, "researchOnsiteExceptions" | "onsiteExceptionEmployers">,
): OnsiteException | null {
  const company = String(job.company_name ?? "").trim();
  const title = words(job.title);
  const research = policy.researchOnsiteExceptions;

  if (company) {
    const preferred = (policy.onsiteExceptionEmployers ?? []).find((name) => employerNameMatches(company, name));
    if (preferred) {
      return exception("PREFERRED_EMPLOYER", company, `employer "${company}" is on the user's on-site exception list`);
    }
  }
  if (!research) return null;

  if (company) {
    const researchEmployer = research.employers.find((name) => employerNameMatches(company, name))
      ?? research.employerNameTerms.find((term) => containsWords(words(company), term));
    if (researchEmployer) {
      return exception("RESEARCH_ROLE", company, `employer "${company}" is a university or research institute`);
    }
    const healthEmployer = research.healthResearchEmployers.find((name) => employerNameMatches(company, name));
    if (healthEmployer) {
      const unitText = words(`${company} ${job.title ?? ""} ${job.description ?? ""}`);
      const unitTerm = research.healthResearchUnitTerms.find((term) => containsWords(unitText, term));
      if (unitTerm) {
        return exception(
          "RESEARCH_ROLE",
          company,
          `employer "${company}" is a health research body and the posting names a research unit ("${unitTerm}")`,
        );
      }
    }
  }

  let researchTitleText = ` ${title} `;
  for (const excluded of research.titleExclusions) {
    const needle = words(excluded);
    if (needle) researchTitleText = researchTitleText.split(` ${needle} `).join(" ");
  }
  const titleTerm = research.titleTerms.find((term) => containsWords(researchTitleText.trim(), term));
  if (titleTerm) {
    return exception("RESEARCH_ROLE", titleTerm, `title "${job.title}" is a research role ("${titleTerm}")`);
  }
  return null;
}
