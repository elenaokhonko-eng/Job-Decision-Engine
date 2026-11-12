/**
 * Explicit on-site statements: affirmative text that describes where the job
 * is done or how often the worker attends ("This role is on-site",
 * "Location: On-site", "Full-time · On-site"). Not a statement:
 * - a noun-modifier use ("On-site training provided", "on-site client support");
 * - a workplace perk (callers pass text that already went through
 *   `neutralizeWorkplacePerkPhrases`, so "· On-site gym" never matches);
 * - a negated, hedged or temporary clause ("You are not required to be
 *   on-site", "You may need to be on-site daily during onboarding",
 *   "On-site: No");
 * - a list that names more than one work mode ("remote, on-site, and hybrid",
 *   "Work mode: On-site / Hybrid");
 * - a 1-3 day attendance count right after the statement, in digits or words
 *   ("On-site, two days a week"), which is partial attendance (hybrid).
 *
 * Dependency-free so the gate, work-mode enrichment and the employer-page
 * fetcher share exactly one definition. All input is lowercase.
 */

const TOKEN = String.raw`(?:on-?site|onsite)`;
const ONE_TO_THREE = String.raw`(?:[1-3]|one|two|three)`;

/** A 1-3 day count right after a statement: "2 days", "two days a week", "1-3 days", "one to three days", "2x". */
const PARTIAL_COUNT = String.raw`\b${ONE_TO_THREE}(?:\s*(?:-|–|to)\s*${ONE_TO_THREE})?\s*(?:days?|x|times)\b`;
const PARTIAL_ATTENDANCE_AFTER = String.raw`(?![^\n.]{0,40}${PARTIAL_COUNT})`;

/**
 * "On-site" is a work-mode value only when what follows ends the value: end of
 * segment or punctuation, "only", an attendance or location word, or a day
 * count. A noun ("training", "support", a perk) is not in this list.
 */
const VALUE_END = String.raw`(?=[ \t]*(?:$|[|·•,.;:)(\/\n–—!]|-[ \t]|(?:only|role|position|job|basis|arrangement|presence|attendance|required|mandatory|daily|every|full[- ]?time|at|in|within|with|from)\b|\d))`;

/** On-site used to describe something other than the job's work location. */
const NOUN_MODIFIER = String.raw`(?![ \t]+(?:training|trainings|support|client|clients|customer|customers|visits?|meetings?|events?|interviews?|orientation|induction|onboarding|services?|assistance|installations?|inspections?|audits?|assessments?|deployments?|maintenance|troubleshooting|demos?|workshops?|sessions?|activities)\b)`;

const LABELS = String.raw`(?:location|workplace(?:[ \t]+type)?|work[ \t]*(?:mode|model|type|location|arrangement|setting|style)s?|working[ \t]+(?:model|arrangement|pattern)s?|job[ \t]+type|employment[ \t]+type|position|role)`;

const FOUR_PLUS = String.raw`(?:[45]|four|five)(?:\s*(?:-|–|to)\s*(?:5|five))?\s*(?:days?|x)\b|daily\b|every[ \t]+(?:work[ \t]*)?day\b`;

interface StatementForm {
  readonly pattern: RegExp;
  /** A form main did not read; it is skipped when the posting or its fields name hybrid/remote work. */
  readonly added: boolean;
  readonly singaporeOnly: boolean;
}

function form(source: string, options: { added?: boolean; singaporeOnly?: boolean; flags?: string } = {}): StatementForm {
  return {
    pattern: new RegExp(source, options.flags ?? "i"),
    added: options.added ?? false,
    singaporeOnly: options.singaporeOnly ?? false,
  };
}

/** Header, label and listed on-site values (shared with work-mode text extraction). */
const VALUE_SOURCES = {
  header: String.raw`[|·]\s*${TOKEN}${VALUE_END}${PARTIAL_ATTENDANCE_AFTER}`,
  label: String.raw`\b${LABELS}\s*:\s*${TOKEN}${VALUE_END}${PARTIAL_ATTENDANCE_AFTER}`,
  listed: String.raw`(?:^|[•:])\s*${TOKEN}${VALUE_END}${PARTIAL_ATTENDANCE_AFTER}`,
  commaListed: String.raw`,\s*${TOKEN}${VALUE_END}${PARTIAL_ATTENDANCE_AFTER}`,
};

const STATEMENT_FORMS: readonly StatementForm[] = [
  // "fully on-site", "100% onsite", "on-premises only"
  form(String.raw`\b(?:100%\s*on-?site|fully\s*on-?site|on-premises\s*only)\b`),
  // "Full-time · On-site", "Location: On-site", "• On-site", "Arrangement: on-site."
  form(VALUE_SOURCES.header),
  form(VALUE_SOURCES.label),
  form(VALUE_SOURCES.listed),
  // "This role is on-site", "work on-site at", "based onsite in", "located on-site"
  form(String.raw`\b(?:role|position|job|work|working|works|presence|based|located)\s+(?:(?:is|are)\s+)?${TOKEN}\b${NOUN_MODIFIER}${PARTIAL_ATTENDANCE_AFTER}`),
  // 4+ days is on-site: "You'll be on-site with clients 4 days a week", "work on-site daily"
  form(String.raw`\b(?:be|work|working|works|based|located)\s+(?:(?:is|are)\s+)?${TOKEN}\b${NOUN_MODIFIER}[^\n.]{0,40}?\b(?:${FOUR_PLUS})`, { added: true }),
  // Singapore owner rule (2026-11)
  form(String.raw`^[ \t]*${TOKEN}${VALUE_END}${PARTIAL_ATTENDANCE_AFTER}`, { added: true, singaporeOnly: true, flags: "im" }),
  form(String.raw`\b${TOKEN}[ \t]+(?:role|position|job)\b${PARTIAL_ATTENDANCE_AFTER}`, { added: true, singaporeOnly: true }),
  form(String.raw`\b(?:must|required[ \t]+to|need[ \t]+to|needs[ \t]+to|expected[ \t]+to)[ \t]+be[ \t]+${TOKEN}\b${NOUN_MODIFIER}${PARTIAL_ATTENDANCE_AFTER}`, { added: true, singaporeOnly: true }),
  form(String.raw`\boffice[- ]based[ \t]+(?:role|position|job)\b${PARTIAL_ATTENDANCE_AFTER}`, { added: true, singaporeOnly: true }),
  form(String.raw`\b(?:role|position|job)[ \t]+is[ \t]+office[- ]based\b${PARTIAL_ATTENDANCE_AFTER}`, { added: true, singaporeOnly: true }),
];

/** Lab and clinic roles keep their main-branch treatment (no clause check). */
const LAB_OR_CLINIC = /\b(?:lab-based|wet\s*lab|clinic-based)\b/i;

const NEGATION = /\b(?:not|no|never|without|none|optional|n\/a)\b|n['’]t\b|\bneed\s+not\b|\bno\s+need\b/i;
const HEDGE = /\b(?:may|might|can|could|occasionally|occasional|sometimes|periodically|from\s+time\s+to\s+time|at\s+times|on\s+occasion|ad[- ]hoc|as\s+and\s+when|(?:when|as|if)\s+(?:needed|required|necessary|requested))\b/i;
const TEMPORARY = /\b(?:during\s+(?:the\s+|your\s+)?(?:onboarding|induction|training|probation|first|initial)|(?:first|initial)\s+(?:week|weeks|month|months|few|\d+|days?)|for\s+onboarding|onboarding\s+period|training\s+period|probation(?:ary)?\s+period|initially|at\s+the\s+start)\b/i;
const NEGATED_FLEXIBLE = /\b(?:no|not|non)[- ]?(?:remote|hybrid)\b|\b(?:remote|hybrid)\s*:\s*no\b/gi;
const OTHER_WORK_MODE = /\bhybrid\b|\bremote(?:ly)?\b|\bwfh\b|\bwork(?:ing)?\s+from\s+home\b/i;

/** The sentence or line around a match: bounded by . ! ? ; or a newline. */
function clauseAround(text: string, start: number, end: number): string {
  let from = start;
  while (from > 0 && !/[.!?;\n]/.test(text[from - 1] ?? "")) from -= 1;
  let to = end;
  while (to < text.length && !/[.!?;\n]/.test(text[to] ?? "")) to += 1;
  return text.slice(from, to);
}

/**
 * True when the clause around a match is an affirmative, unhedged, permanent
 * statement that names on-site as the only work mode.
 */
function isAffirmativeOnsiteClause(text: string, start: number, end: number): boolean {
  const clause = clauseAround(text, start, end);
  if (NEGATION.test(clause) || HEDGE.test(clause) || TEMPORARY.test(clause)) return false;
  return !OTHER_WORK_MODE.test(clause.replace(NEGATED_FLEXIBLE, " "));
}

function firstAffirmativeMatch(pattern: RegExp, text: string): RegExpExecArray | null {
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  for (const match of text.matchAll(global)) {
    if (isAffirmativeOnsiteClause(text, match.index ?? 0, (match.index ?? 0) + match[0].length)) return match as RegExpExecArray;
  }
  return null;
}

const VALUE_FORMS = [VALUE_SOURCES.header, VALUE_SOURCES.label, VALUE_SOURCES.listed, VALUE_SOURCES.commaListed]
  .map((source) => new RegExp(source, "i"));

/**
 * "On-site" as an affirmative work-mode value after a header separator, a
 * work-mode label, a bullet, a colon or a comma ("Full-time · On-site",
 * "Location: On-site", "• On-site", "Arrangement: on-site."), for work-mode
 * text extraction and the employer-page fetcher.
 */
export function hasOnsiteWorkModeValue(workModeText: string): boolean {
  return VALUE_FORMS.some((pattern) => firstAffirmativeMatch(pattern, workModeText) !== null);
}

/**
 * Partial on-site attendance: an on-site statement followed by a 1-3 day count
 * ("Location: On-site, two days a week", "on-site 2-3 days a week"). Work-mode
 * text extraction reads it as HYBRID with the stated office days.
 */
export function findPartialOnsiteAttendance(workModeText: string): { officeDaysMin: number; officeDaysMax: number; quote: string } | null {
  const words: Record<string, number> = { one: 1, two: 2, three: 3 };
  const toNumber = (value: string | undefined): number | null => (value === undefined ? null : words[value] ?? Number(value));
  const pattern = new RegExp(
    String.raw`\b${TOKEN}\b${NOUN_MODIFIER}[^\n.]{0,40}?\b(${ONE_TO_THREE})(?:\s*(?:-|–|to)\s*(${ONE_TO_THREE}))?\s*(?:days?|x|times)\b`,
    "gi",
  );
  for (const match of workModeText.matchAll(pattern)) {
    const start = match.index ?? 0;
    const clause = clauseAround(workModeText, start, start + match[0].length);
    if (NEGATION.test(clause) || HEDGE.test(clause) || TEMPORARY.test(clause)) continue;
    const first = toNumber(match[1]);
    const second = toNumber(match[2]) ?? first;
    if (first === null || second === null) continue;
    return { officeDaysMin: Math.min(first, second), officeDaysMax: Math.max(first, second), quote: match[0].trim() };
  }
  return null;
}

/** A Singapore-located job: Singapore in the location, or a stated Singapore base. */
export function isSingaporeLocatedJob(location: string | null | undefined, description: string | null | undefined): boolean {
  return /\b(?:singapore|sg)\b/i.test(String(location || ""))
    || /\b(?:based\s+in\s+singapore|location\s*:\s*singapore|office\s+in\s+singapore)\b/i.test(String(description || ""));
}

/**
 * The first explicit, affirmative on-site statement in `workModeText`
 * (lowercase, perk-neutralised, same length as `originalText`), quoted from
 * `originalText`; null when there is none.
 *
 * Owner rule (2026-11): for a Singapore-located job the Singapore-only forms
 * are read too. The forms main did not read (4+ days, Singapore-only) are
 * skipped when the posting names hybrid/remote/work-from-home work anywhere,
 * or when its location or structured work mode is remote or hybrid.
 */
export function findExplicitOnsiteStatement(
  workModeText: string,
  originalText: string,
  options: { singapore: boolean; location?: string | null; structuredWorkMode?: string | null },
): string | null {
  const flexible = OTHER_WORK_MODE.test(workModeText.replace(NEGATED_FLEXIBLE, " "))
    || /\b(?:remote|hybrid|anywhere|worldwide)\b/i.test(String(options.location ?? ""))
    || /^(?:remote|hybrid)$/i.test(String(options.structuredWorkMode ?? "").trim());
  const quote = (match: RegExpExecArray): string => {
    const start = match.index ?? 0;
    return originalText.slice(start, start + match[0].length).replace(/^[\s|·•:,]+/, "").trim() || match[0].trim();
  };
  const lab = LAB_OR_CLINIC.exec(workModeText);
  if (lab) return quote(lab);
  for (const statement of STATEMENT_FORMS) {
    if (statement.singaporeOnly && !options.singapore) continue;
    if (statement.added && flexible) continue;
    const match = firstAffirmativeMatch(statement.pattern, workModeText);
    if (match) return quote(match);
  }
  return null;
}
