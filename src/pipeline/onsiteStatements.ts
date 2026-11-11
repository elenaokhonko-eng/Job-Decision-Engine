/**
 * Explicit on-site statements: text that describes where the job is done or
 * how often the worker attends ("This role is on-site", "Location: On-site",
 * "Full-time · On-site"). A noun-modifier use describes something else and is
 * not a statement ("On-site training provided", "on-site client support",
 * "on-site visits", "onsite gym"). Callers pass lowercase text that already
 * went through `neutralizeWorkplacePerkPhrases`, so workplace perks never match.
 *
 * Dependency-free so the gate, work-mode enrichment and the employer-page
 * fetcher share exactly one definition.
 */

const TOKEN = String.raw`(?:on-?site|onsite)`;

/** "On-site" is a work-mode value: end of line or a separator follows, or a role/attendance word. */
const VALUE_END = String.raw`(?=[ \t]*(?:$|[|·•,.;:)(\/\n–—]|-[ \t]|only\b|(?:role|position|job|work|working|basis|based|arrangement|presence|attendance)\b))`;

/** On-site used to describe something other than the job's work location. */
// Workplace perks after a statement ("Work on-site facilities daily") are not
// listed: the statement stands and the perk is ignored.
const NOUN_MODIFIER = String.raw`(?![ \t]+(?:training|trainings|support|client|clients|customer|customers|visits?|meetings?|events?|interviews?|orientation|induction|onboarding|services?|assistance|installations?|inspections?|audits?|assessments?|deployments?|maintenance|troubleshooting|demos?|workshops?|sessions?|activities)\b)`;

/** A 1-3 day attendance count right after the statement is a hybrid fact (Singapore rule). */
const PARTIAL_ATTENDANCE_AFTER = String.raw`(?![^\n.]{0,40}\b[1-3][ \t]*(?:-[ \t]*[1-3][ \t]*)?(?:days?|x)\b)`;

const LABELS = String.raw`(?:location|workplace(?:[ \t]+type)?|work[ \t]*(?:mode|model|type|location|arrangement|setting|style)|working[ \t]+(?:model|arrangement|pattern)|job[ \t]+type|employment[ \t]+type|position|role)`;

function patterns(singapore: boolean, singaporeForms: boolean): RegExp[] {
  const partial = singapore ? PARTIAL_ATTENDANCE_AFTER : "";
  const base = [
    // "fully on-site", "100% onsite", "on-premises only", lab/clinic-based roles
    String.raw`\b(?:100%\s*on-?site|fully\s*on-?site|on-premises\s*only|lab-based|wet\s*lab|clinic-based)\b`,
    // Header value: "Full-time · On-site", "Engineering | Onsite | Full-time"
    String.raw`[|·]\s*${TOKEN}\b${partial}`,
    // Work-mode label: "Location: On-site", "Workplace type: Onsite"
    String.raw`\b${LABELS}\s*:\s*${TOKEN}\b${partial}`,
    // A value at the start of the text, after a bullet or a colon: "• On-site", "Arrangement: on-site."
    String.raw`(?:^|[•:])\s*${TOKEN}${VALUE_END}${partial}`,
    // "This role is on-site", "work on-site at", "based onsite in", "located on-site"
    String.raw`\b(?:role|position|job|work|working|works|presence|based|located)\s+(?:(?:is|are)\s+)?${TOKEN}\b${NOUN_MODIFIER}${partial}`,
  ].map((source) => new RegExp(source, "i"));
  if (!singaporeForms) return base;
  const singaporeOnly = [
    // A line that starts with an on-site value: "On-site, facilities based."
    String.raw`^[ \t]*${TOKEN}${VALUE_END}${PARTIAL_ATTENDANCE_AFTER}`,
    // "an on-site role", "on-site position"
    String.raw`\b${TOKEN}[ \t]+(?:role|position|job)\b${PARTIAL_ATTENDANCE_AFTER}`,
    // "must be on-site", "required to be onsite"
    String.raw`\b(?:must|required[ \t]+to|need[ \t]+to|needs[ \t]+to|expected[ \t]+to)[ \t]+be[ \t]+${TOKEN}\b${NOUN_MODIFIER}${PARTIAL_ATTENDANCE_AFTER}`,
    // "office-based role", "the position is office-based"
    String.raw`\boffice[- ]based[ \t]+(?:role|position|job)\b${PARTIAL_ATTENDANCE_AFTER}`,
    String.raw`\b(?:role|position|job)[ \t]+is[ \t]+office[- ]based\b${PARTIAL_ATTENDANCE_AFTER}`,
  ].map((source) => new RegExp(source, "im"));
  return [...base, ...singaporeOnly];
}

const BASE_PATTERNS = patterns(false, false);
/** Singapore job that also states hybrid/remote work: the shared forms only, with the 1-3 day guard. */
const SINGAPORE_FLEXIBLE_PATTERNS = patterns(true, false);
const SINGAPORE_PATTERNS = patterns(true, true);

/** A hybrid or remote statement makes the Singapore-only forms ambiguous; they are then not read. */
const FLEXIBLE_WORK_STATEMENT = /\bhybrid\b|\bwork(?:ing)?\s+from\s+home\b|\bwfh\b|\bremote(?:ly)?\b/i;
const NEGATED_FLEXIBLE = /\b(?:no|not|non)[- ]?(?:remote|hybrid)\b|\b(?:remote|hybrid)\s*:\s*no\b/gi;

// Work-mode text extraction stores these as ON-SITE with 5 office days, so a
// 1-3 day count right after is partial attendance and is not read as a value.
const HEADER_VALUE = new RegExp(String.raw`[|·]\s*${TOKEN}\b${PARTIAL_ATTENDANCE_AFTER}`, "i");
const LABEL_VALUE = new RegExp(String.raw`\b${LABELS}\s*:\s*${TOKEN}\b${PARTIAL_ATTENDANCE_AFTER}`, "i");
const LISTED_VALUE = new RegExp(String.raw`(?:^|[•:,])\s*${TOKEN}${VALUE_END}${PARTIAL_ATTENDANCE_AFTER}`, "i");

/**
 * "On-site" as a work-mode value after a header separator, a work-mode label,
 * a bullet, a colon or a comma ("Full-time · On-site", "Location: On-site",
 * "• On-site", "Arrangement: on-site."). "• On-site training provided" is a
 * noun modifier, not a value.
 */
export function hasOnsiteWorkModeValue(workModeText: string): boolean {
  return HEADER_VALUE.test(workModeText) || LABEL_VALUE.test(workModeText) || LISTED_VALUE.test(workModeText);
}

/** A Singapore-located job: Singapore in the location, or a stated Singapore base. */
export function isSingaporeLocatedJob(location: string | null | undefined, description: string | null | undefined): boolean {
  return /\b(?:singapore|sg)\b/i.test(String(location || ""))
    || /\b(?:based\s+in\s+singapore|location\s*:\s*singapore|office\s+in\s+singapore)\b/i.test(String(description || ""));
}

/**
 * The first explicit on-site statement in `workModeText` (lowercase,
 * perk-neutralised, same length as `originalText`), quoted from
 * `originalText`; null when there is none.
 *
 * Owner rule (2026-11): for a Singapore-located job without an un-negated
 * hybrid/remote statement, the Singapore-only forms are read too, and a 1-3
 * day count right after any statement is partial attendance, not on-site.
 */
export function findExplicitOnsiteStatement(
  workModeText: string,
  originalText: string,
  options: { singapore: boolean },
): string | null {
  const flexible = FLEXIBLE_WORK_STATEMENT.test(workModeText.replace(NEGATED_FLEXIBLE, " "));
  const list = !options.singapore ? BASE_PATTERNS : flexible ? SINGAPORE_FLEXIBLE_PATTERNS : SINGAPORE_PATTERNS;
  for (const pattern of list) {
    const match = pattern.exec(workModeText);
    if (match) {
      const start = match.index;
      return originalText.slice(start, start + match[0].length).replace(/^[\s|·•:]+/, "").trim() || match[0].trim();
    }
  }
  return null;
}
