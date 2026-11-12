/**
 * Explicit on-site statements: affirmative text about this job's work location
 * or the applicant's attendance ("This role is on-site", "Location: On-site",
 * "Full-time · On-site", "You must be on-site"). Not a statement:
 * - a noun-modifier use ("On-site training provided", "on-site client support");
 * - a workplace perk (callers pass text that already went through
 *   `neutralizeWorkplacePerkPhrases`, so "· On-site gym" never matches);
 * - a sentence about something or someone else ("Parking is located on-site",
 *   "Our platform works on-site and in the cloud", "Our nurses work on-site");
 * - a negation or modal hedge that governs the statement ("You are not
 *   required to be on-site", "On-site: No", "You may be required to be
 *   on-site"); an unrelated negation does not ("no exceptions", "No visa
 *   sponsorship"), and a negated other work mode reinforces on-site ("not
 *   eligible for remote work", "No hybrid, no remote: this role is on-site");
 * - a frequency hedge or a temporary or project-phase scope in the same clause
 *   ("occasionally", "during onboarding", "during the go-live period");
 * - a list that names more than one work mode ("remote, on-site, and hybrid");
 * - partial attendance right after the statement: 1-3 days in digits or words,
 *   "N out of 5 days" with N <= 3, a percentage below 80%, or half the time.
 *
 * Dependency-free so the gate, work-mode enrichment and the employer-page
 * fetcher share exactly one definition. All input is lowercase.
 */

const TOKEN = String.raw`(?:on-?site|onsite)`;
const ONE_TO_THREE = String.raw`(?:[1-3]|one|two|three)`;
const FOUR_PLUS_COUNT = String.raw`\b(?:[45]|four|five)(?:\s*(?:-|–|to)\s*(?:5|five))?\s*(?:days?|x)\b`;

/** Partial attendance: "2 days", "two days a week", "1-3 days", "2x", "3 out of 5 days", "60%", "half the time". */
const PARTIAL_COUNT = String.raw`(?:\b${ONE_TO_THREE}(?:\s*(?:-|–|to)\s*${ONE_TO_THREE})?\s*(?:days?|x|times)\b|\b${ONE_TO_THREE}\s+(?:out\s+)?of\s+(?:5|five)\b|(?<!\d)[1-7]?\d\s*%|\bhalf\s+(?:of\s+)?(?:the\s+)?(?:time|week)\b)`;
/** No partial count within 40 characters, unless a 4-5 day count comes first ("on-site 4 days a week, 1 day WFH"). */
const PARTIAL_ATTENDANCE_AFTER = String.raw`(?!(?:(?!${FOUR_PLUS_COUNT})[^\n.]){0,40}?${PARTIAL_COUNT})`;

/**
 * "On-site" is a work-mode value only when what follows ends the value: end of
 * segment or punctuation, "only", an attendance or location word, or a digit.
 * A noun ("training", "support", a perk) is not in this list.
 */
const VALUE_END = String.raw`(?=[ \t]*(?:$|[|·•,.;:)(\/\n–—!]|-[ \t]|(?:only|role|position|job|basis|arrangement|presence|attendance|required|mandatory|daily|every|full[- ]?time|at|in|within|from)\b|\d))`;

/** On-site used to describe something other than the job's work location. */
const NOUN_MODIFIER = String.raw`(?![ \t]+(?:training|trainings|support|client|clients|customer|customers|visits?|meetings?|events?|interviews?|orientation|induction|onboarding|services?|assistance|installations?|inspections?|audits?|assessments?|deployments?|maintenance|troubleshooting|demos?|workshops?|sessions?|activities|coaching|mentoring|learning|surveys?|testing|tests?)\b)`;

const LABELS = String.raw`(?:location|workplace(?:[ \t]+type)?|work[ \t]*(?:mode|model|type|location|arrangement|setting|style)s?|working[ \t]+(?:model|arrangement|pattern)s?|job[ \t]+type|employment[ \t]+type|position|role)`;

/** Work-mode labels only (no location, position or role label): "Work Type:", "Work model:", "Workplace type:". */
const WORK_MODE_LABELS = String.raw`(?:workplace(?:[ \t]+type)?|work[ \t]*(?:mode|model|type|arrangement|setting|style)s?|working[ \t]+(?:model|arrangement|pattern)s?)`;

/**
 * An office value of a work-mode label is full on-site (gate-2026-11.4): "Work Type: Office
 * Working", "Work type: Office-based working", "Work model: In-office". Office or in-office with
 * a working/work suffix ends at a word boundary; a bare "office-based" or "in-office" value must
 * end the value (VALUE_END). Partial attendance after it ("Office Working, 3 days a week") is not.
 */
const OFFICE_WORK_MODE_VALUE = String.raw`(?:(?:office(?:[- ]based)?|in[- ]office)[ \t]+work(?:ing)?\b|(?:office[- ]based|in[- ]office)${VALUE_END})`;

const FOUR_PLUS = String.raw`${FOUR_PLUS_COUNT}|\bdaily\b|\bevery[ \t]+(?:work[ \t]*)?day\b`;

/** How a form decides that it is about this job. */
type Subject =
  /** The form names the job itself ("On-site role", "Location: On-site"). */
  | "inherent"
  /** A verb form: the subject before it must be the role or the applicant, or absent (an imperative or a bullet). */
  | "role-or-applicant";

interface StatementForm {
  readonly pattern: RegExp;
  /** Main did not read this form; it is skipped when the posting or its fields offer hybrid/remote work. */
  readonly added: boolean;
  readonly singaporeOnly: boolean;
  readonly subject: Subject;
  /** Fully/100%/on-premises only: read as on main, without the clause check. */
  readonly unconditional: boolean;
}

function form(
  source: string,
  options: { added?: boolean; singaporeOnly?: boolean; subject?: Subject; unconditional?: boolean; flags?: string } = {},
): StatementForm {
  return {
    pattern: new RegExp(source, `${options.flags ?? "i"}g`),
    added: options.added ?? false,
    singaporeOnly: options.singaporeOnly ?? false,
    subject: options.subject ?? "inherent",
    unconditional: options.unconditional ?? false,
  };
}

/** Header, label and listed on-site values (shared with work-mode text extraction). */
const VALUE_SOURCES = {
  header: String.raw`[|·]\s*${TOKEN}${VALUE_END}${PARTIAL_ATTENDANCE_AFTER}`,
  label: String.raw`\b${LABELS}\s*:\s*${TOKEN}${VALUE_END}${PARTIAL_ATTENDANCE_AFTER}`,
  listed: String.raw`(?:^|[•:])\s*${TOKEN}${VALUE_END}${PARTIAL_ATTENDANCE_AFTER}`,
  commaListed: String.raw`,\s*${TOKEN}${VALUE_END}${PARTIAL_ATTENDANCE_AFTER}`,
  officeLabel: String.raw`\b${WORK_MODE_LABELS}\s*:\s*${OFFICE_WORK_MODE_VALUE}${PARTIAL_ATTENDANCE_AFTER}`,
};

const VERBS = String.raw`(?:role|position|job|work|working|works|presence|based|located)`;

const STATEMENT_FORMS: readonly StatementForm[] = [
  // "fully on-site", "100% onsite", "on-premises only"
  form(String.raw`\b(?:100%\s*on-?site|fully\s*on-?site|on-premises\s*only)\b`, { unconditional: true }),
  // "Full-time · On-site", "Location: On-site", "• On-site", "Arrangement: on-site."
  form(VALUE_SOURCES.header),
  form(VALUE_SOURCES.label),
  // "Work Type: Office Working", "Work type: Office-based working"
  form(VALUE_SOURCES.officeLabel),
  form(VALUE_SOURCES.listed),
  // "This role is on-site", "you will work on-site at", "be based onsite in", "Work on-site daily"
  form(String.raw`\b${VERBS}\s+(?:(?:is|are)\s+)?${TOKEN}\b${NOUN_MODIFIER}${PARTIAL_ATTENDANCE_AFTER}`, { subject: "role-or-applicant" }),
  // 4+ days is on-site: "You'll be on-site with clients 4 days a week", "work on-site daily"
  form(String.raw`\b(?:be|work|working|works|based|located)\s+(?:(?:is|are)\s+)?${TOKEN}\b${NOUN_MODIFIER}[^\n.]{0,40}?(?:${FOUR_PLUS})`, { added: true, subject: "role-or-applicant" }),
  // Singapore owner rule (2026-11)
  form(String.raw`^[ \t]*${TOKEN}${VALUE_END}${PARTIAL_ATTENDANCE_AFTER}`, { added: true, singaporeOnly: true, flags: "im" }),
  form(String.raw`\b${TOKEN}[ \t]+(?:role|position|job)\b${PARTIAL_ATTENDANCE_AFTER}`, { added: true, singaporeOnly: true }),
  form(String.raw`\b(?:must|required[ \t]+to|need[ \t]+to|needs[ \t]+to|expected[ \t]+to)[ \t]+be[ \t]+${TOKEN}\b${NOUN_MODIFIER}${PARTIAL_ATTENDANCE_AFTER}`, { added: true, singaporeOnly: true, subject: "role-or-applicant" }),
  form(String.raw`\boffice[- ]based[ \t]+(?:role|position|job)\b${PARTIAL_ATTENDANCE_AFTER}`, { added: true, singaporeOnly: true }),
  form(String.raw`\b(?:role|position|job)[ \t]+is[ \t]+office[- ]based\b${PARTIAL_ATTENDANCE_AFTER}`, { added: true, singaporeOnly: true }),
];

/** Lab and clinic roles keep their main-branch treatment (no clause check). */
const LAB_OR_CLINIC = /\b(?:lab-based|wet\s*lab|clinic-based)\b/i;

/**
 * Mentions of another work mode that do not offer it: a negated mode reinforces
 * on-site ("not eligible for remote work", "no remote option", "WFH is not
 * available", "cannot be done remotely"), and "remote" naming a thing is not a
 * work mode ("remote sensing", "remote patient monitoring").
 */
const NOT_OFFERED_MODE: readonly RegExp[] = [
  /\b(?:no|not|non|never)[- ]?(?:an?\s+)?(?:remote|hybrid|wfh)\b(?:\s+(?:work(?:ing)?|options?|roles?|positions?|arrangements?|possible|available|eligible))*/gi,
  /\b(?:not|isn['’]t|aren['’]t)\s+(?:eligible|available|offered|possible|an\s+option|suitable)\s+(?:for\s+)?(?:remote|hybrid|wfh)(?:\s+work(?:ing)?)?/gi,
  /\b(?:remote|hybrid|wfh|work(?:ing)?\s+from\s+home)(?:\s+work(?:ing)?)?\s+(?:is|are)\s+(?:not|n['’]t)\s+(?:available|offered|possible|an\s+option|supported|permitted|allowed)\b/gi,
  /\b(?:remote|hybrid|wfh|work(?:ing)?\s+from\s+home)(?:\s+work(?:ing)?)?\s+(?:isn['’]t|aren['’]t)\s+(?:available|offered|possible|an\s+option|supported|permitted|allowed)\b/gi,
  /\b(?:cannot|can['’]t|can\s+not)\s+be\s+(?:done|performed|carried\s+out)\s+remotely\b/gi,
  /\b(?:won['’]t|will\s+not|cannot|can['’]t|not)\s+be\s+able\s+to\s+(?:wfh|work\s+(?:from\s+home|remotely))\b/gi,
  /\b(?:(?:do|does|will)\s+not|don['’]t|doesn['’]t|won['’]t)\s+offer\s+(?:remote|hybrid)(?:\s+(?:or|and)\s+(?:remote|hybrid))?(?:\s+work(?:ing)?)?/gi,
  /\b(?:remote|hybrid)\s*:\s*no\b/gi,
  /\bremote\s+(?:sensing|monitoring|patients?|access|control|devices?|desktop|diagnostics|management|server|servers|areas?|locations?|sites?)\b/gi,
];

/** Sentences that describe the company or its policy, not this job's work mode. */
const NOT_ABOUT_THIS_JOB = /equal\s+opportunit|regardless\s+of|whether\s+(?:they|you)\s+(?:are\s+)?(?:work|working)|all\s+qualified\s+applicants|\b(?:founded|started(?:\s+out)?|began|launched)\s+as\b/i;

const MODAL_HEDGE = /\b(?:may|might|can|could)\b/i;
const FREQUENCY_HEDGE = /\b(?:occasionally|sometimes|periodically|from\s+time\s+to\s+time|at\s+times|on\s+occasion|ad[- ]hoc|as\s+and\s+when|(?:when|as|if)\s+(?:needed|required|necessary|requested)|as[- ]needed|some\s+days|part\s+of\s+the\s+(?:week|time)|not\s+(?:every\s+day|daily|full[- ]?time|always)|but\s+only|(?:once|twice)\s+(?:a|per)\s+(?:week|month)|for\s+(?:[\w-]+\s+){1,4}only)\b/i;
const TEMPORARY = /\b(?:during\s+(?:the\s+|your\s+)?(?:onboarding|induction|training|probation|first|initial|go[- ]live|cutover|launch|implementation|audit|project|deployment|roll-?out|migration|hypercare|transition)|(?:first|initial)\s+(?:week|weeks|month|months|few|\d+|days?)|for\s+onboarding|(?:onboarding|training|probation(?:ary)?|implementation|project|transition)\s+(?:period|phase)|initially|at\s+the\s+start|go[- ]live|cutover|hypercare|launch\s+(?:period|phase|week)|for\s+the\s+duration\s+of)\b/i;
const NEGATION_BEFORE = /\b(?:not|never|without|no\s+need|need\s+not|no|optional)\b|n['’]t\b/i;
/**
 * A negation right after the statement, optionally after a short attendance
 * noun: "is not required", "On-site attendance is optional", "On-site
 * presence isn't mandatory", "On-site attendance: not required", "On-site: No".
 */
const NEGATION_AFTER = /^\s*(?:(?:attendance|presence|work(?:ing)?|requirements?)\s+)?(?:(?:is|are)\s+)?(?:not\b|n['’]t\b|optional\b|n\/a\b|none\b)|^\s*(?:(?:attendance|presence|work(?:ing)?|requirements?)\s+)?(?:isn['’]t|aren['’]t)\b|^\s*(?:attendance|presence|requirements?|required|work|working)?\s*:\s*(?:no|not|n\/a|none|optional|false)\b/i;
const OTHER_WORK_MODE = /\bhybrid\b|\bremote(?:ly)?\b|\bwfh\b|\bwork(?:ing)?\s+from\s+home\b/i;
const ROLE_OR_APPLICANT = /\byou(?:['’](?:ll|re|d|ve))?\b|\byour\s+(?:[\w-]+\s+){0,3}?(?:role|position|job)\b|\b(?:this|the)\s+(?:[\w-]+\s+){0,6}?(?:role|position|job|opportunity|candidate|incumbent|hire|post)\b|\b(?:successful|ideal|selected)\s+(?:candidate|applicant)s?\b|\bcandidates?\b|\bapplicants?\b|\bnew\s+hires?\b/i;
const RELATIVE_CLAUSE = /\b(?:who|which|that|whose)\b/i;
const IMPERATIVE_START = /^(?:expect|plan|be\s+(?:prepared|ready|willing|able)|must|will|need)\b/i;

/** Replace each match with spaces of the same length, so offsets stay valid. */
function blank(text: string, patterns: readonly RegExp[]): string {
  let result = text;
  for (const pattern of patterns) result = result.replace(pattern, (match) => " ".repeat(match.length));
  return result;
}

function clauseBounds(text: string, start: number, end: number): [number, number] {
  let from = start;
  while (from > 0 && !/[.!?;\n]/.test(text[from - 1] ?? "")) from -= 1;
  let to = end;
  while (to < text.length && !/[.!?;\n]/.test(text[to] ?? "")) to += 1;
  return [from, to];
}

/** Blank sentences that describe the company or its policy rather than this job. */
function withoutCompanySentences(text: string): string {
  return text.replace(/[^.!?;\n]+/g, (sentence) => {
    const trigger = NOT_ABOUT_THIS_JOB.exec(sentence);
    if (!trigger) return sentence;
    // Scraped text often has no sentence breaks; blank only the span around the trigger then.
    if (sentence.length <= 200) return " ".repeat(sentence.length);
    const from = Math.max(0, trigger.index - 40);
    const to = Math.min(sentence.length, trigger.index + 120);
    return sentence.slice(0, from) + " ".repeat(to - from) + sentence.slice(to);
  });
}

/** The text the checks read: not-offered modes blanked, same length as the input. */
function checkText(text: string): string {
  return blank(text, NOT_OFFERED_MODE);
}

/**
 * The text hybrid/remote detectors should read (same length as the input):
 * negated or not-offered modes, "remote" naming a thing, equal-opportunity
 * lines and company history are blanked, so they never read as this job
 * offering hybrid or remote work.
 */
export function withoutNonOfferedWorkModes(text: string): string {
  return withoutCompanySentences(checkText(text));
}

/**
 * True when a match is an affirmative, unhedged, permanent statement about
 * this job that names on-site as its only work mode.
 */
function isAffirmativeStatement(text: string, start: number, end: number, subject: Subject): boolean {
  const [from, to] = clauseBounds(text, start, end);
  const clause = text.slice(from, to);
  const before = text.slice(Math.max(from, start - 45), start);
  const after = text.slice(end, Math.min(to, end + 30));
  if (NEGATION_BEFORE.test(before) || NEGATION_AFTER.test(after)) return false;
  if (MODAL_HEDGE.test(before) || FREQUENCY_HEDGE.test(clause) || TEMPORARY.test(clause)) return false;
  if (OTHER_WORK_MODE.test(clause) || NOT_ABOUT_THIS_JOB.test(clause)) return false;
  // A question ("Is this role on-site?") is a statement only when answered yes.
  if (text[to] === "?" && !/^\?\s*(?:yes|required|mandatory)\b/i.test(text.slice(to, to + 20))) return false;
  if (subject === "role-or-applicant") return subjectOwnsVerb(text, from, start, text.slice(start, end));
  return true;
}

/** Words that may stand right before a participle verb that the subject still owns ("you will be working on-site", "role based onsite"). */
// A gerund after a verb or an adjective still belongs to the subject ("this
// role requires working onsite", "you're happy working onsite"); only a
// participle after another noun ("engineers working on-site") does not.
const PARTICIPLE_OWNER = /^(?:be|been|being|is|are|am|was|were|will|to|and|or|then|currently|also|primarily|mainly|fully|usually|you|role|position|job|we|i|candidate|applicant|hire|requires?|required|involves?|includes?|means|entails?|enjoys?|loves?|likes?|prefers?|starts?|begins?|happy|comfortable|willing|open|keen|able|available|ready|prepared|eager|used|accustomed|fine|ok|okay|interested)$/i;

/**
 * The subject before a verb at `verbStart` is the role or the applicant, the
 * verb is role/position/job itself, or there is no subject (a bullet or an
 * imperative). A relative clause ("clinicians who work on-site") or a
 * participle after another noun ("supports field engineers working on-site",
 * "manages vendors based on-site") belongs to someone else.
 */
function subjectOwnsVerb(text: string, from: number, verbStart: number, verbText: string): boolean {
  if (/^(?:role|position|job)\b/i.test(verbText)) return true;
  const subjectText = text.slice(from, verbStart).replace(/^[\s•·|:,\-–—*]+/, "").replace(/^(?:and|then)\s+/i, "");
  // No subject: a bullet or an imperative addressed to the applicant ("Work on-site daily", "Expect to be on-site daily").
  if (subjectText.trim() === "" || IMPERATIVE_START.test(subjectText)) return true;
  if (RELATIVE_CLAUSE.test(text.slice(Math.max(from, verbStart - 40), verbStart))) return false;
  if (/^(?:working|based|located)\b/i.test(verbText)) {
    const previousWord = /([\w'’-]+)\s*$/.exec(text.slice(from, verbStart))?.[1] ?? "";
    if (previousWord && !PARTICIPLE_OWNER.test(previousWord)) return false;
  }
  return ROLE_OR_APPLICANT.test(subjectText);
}

/** The work/be/based verb right before an on-site token ("work onsite 4 days"), if any. */
const VERB_BEFORE_TOKEN = /\b(?:be|work|working|works|based|located)\s+(?:(?:is|are)\s+)?$/i;

function firstStatement(pattern: RegExp, text: string, subject: Subject): RegExpExecArray | null {
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (isAffirmativeStatement(text, start, start + match[0].length, subject)) return match as RegExpExecArray;
  }
  return null;
}

const VALUE_FORMS = [VALUE_SOURCES.header, VALUE_SOURCES.label, VALUE_SOURCES.officeLabel, VALUE_SOURCES.listed, VALUE_SOURCES.commaListed]
  .map((source) => new RegExp(source, "gi"));

/**
 * "On-site" as an affirmative work-mode value after a header separator, a
 * work-mode label, a bullet, a colon or a comma ("Full-time · On-site",
 * "Location: On-site", "• On-site", "Arrangement: on-site."), or an office value of a
 * work-mode label ("Work Type: Office Working"), for work-mode
 * text extraction and the employer-page fetcher.
 */
export function hasOnsiteWorkModeValue(workModeText: string): boolean {
  const text = checkText(workModeText);
  return VALUE_FORMS.some((pattern) => firstStatement(pattern, text, "inherent") !== null);
}

/**
 * The office days of an affirmative on-site statement that is followed by a
 * day count ("Location: On-site, two days a week" -> 2-2, "On-site 4 days a
 * week, 1 day WFH" -> 4-4). Work-mode text extraction stores 1-3 as HYBRID and
 * 4-5 as ONSITE. The first count after the token is the office-day count.
 */
export function findOnsiteDayCount(workModeText: string): { officeDaysMin: number; officeDaysMax: number; quote: string } | null {
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
  const toNumber = (value: string | undefined): number | null => (value === undefined ? null : words[value] ?? Number(value));
  const count = String.raw`([1-5]|one|two|three|four|five)`;
  const pattern = new RegExp(
    String.raw`\b${TOKEN}\b${NOUN_MODIFIER}[^\n.\d]{0,30}?\b${count}(?:\s*(?:-|–|to)\s*${count})?\s*(?:days?|x|times)\b`,
    "gi",
  );
  const text = checkText(workModeText);
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    const first = toNumber(match[1]);
    const second = toNumber(match[2]) ?? first;
    if (first === null || second === null) continue;
    // A 4-5 day count makes the row ONSITE, so it needs the gate's subject rule too.
    if (!isAffirmativeDayCount(text, start, start + match[0].length, Math.max(first, second) >= 4)) continue;
    return { officeDaysMin: Math.min(first, second), officeDaysMax: Math.max(first, second), quote: workModeText.slice(start, start + match[0].length).trim() };
  }
  return null;
}

/** A day count after on-site: the same negation, hedge and temporary checks; a WFH/remote day may follow. */
function isAffirmativeDayCount(text: string, start: number, end: number, onsiteCount: boolean): boolean {
  const [from, to] = clauseBounds(text, start, end);
  const clause = text.slice(from, to);
  const before = text.slice(Math.max(from, start - 45), start);
  if (NEGATION_BEFORE.test(before) || MODAL_HEDGE.test(before)) return false;
  if (FREQUENCY_HEDGE.test(clause) || TEMPORARY.test(clause) || NOT_ABOUT_THIS_JOB.test(clause)) return false;
  // The same subject rule as the gate's verb forms, so enrichment and the gate
  // agree ("Employees are expected to work onsite four days" is third-party).
  const verb = onsiteCount ? VERB_BEFORE_TOKEN.exec(text.slice(from, start)) : null;
  if (verb) return subjectOwnsVerb(text, from, from + verb.index, verb[0]);
  return !RELATIVE_CLAUSE.test(text.slice(Math.max(from, start - 40), start));
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
 * skipped when the posting offers hybrid/remote/work-from-home work (a negated
 * mode, an equal-opportunity line or company history does not count), or when
 * its location or structured work mode is remote or hybrid.
 */
export function findExplicitOnsiteStatement(
  workModeText: string,
  originalText: string,
  options: { singapore: boolean; location?: string | null; structuredWorkMode?: string | null },
): string | null {
  const text = checkText(workModeText);
  const flexible = OTHER_WORK_MODE.test(withoutNonOfferedWorkModes(workModeText))
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
    if (statement.unconditional) {
      statement.pattern.lastIndex = 0;
      const match = statement.pattern.exec(workModeText);
      statement.pattern.lastIndex = 0;
      if (match) return quote(match);
      continue;
    }
    const match = firstStatement(statement.pattern, text, statement.subject);
    if (match) return quote(match);
  }
  return null;
}
