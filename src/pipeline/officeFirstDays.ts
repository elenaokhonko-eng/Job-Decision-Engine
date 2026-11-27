/**
 * Office-day counts that follow the office (gate-2026-11.10, owner decision
 * 2026-11-26): "in the office four days a week", "into our office 4 days per
 * week", "work from office 5 days a week", "on-site four days a week". The same
 * office-days thresholds judge them as judge "4 days in the office".
 *
 * A statement is read only when:
 * - it is weekly ("a week", "per week", "each week", "weekly"), so counts per
 *   month or quarter and counts without a period are not read;
 * - the words before the office say that people attend it (or it opens a
 *   sentence or bullet), so "lunch in the office five days a week" is not;
 * - nothing in its sentence negates or hedges it, it is not a question or a
 *   "gone are the days" / "tired of" / "forget" line, and it is not limited to a starting
 *   period ("during probation", "for your first 90 days", "initially");
 * - for the "on-site" and "in-office" wording, which has its own subject rule
 *   (onsiteStatements.ts): it opens a sentence or bullet, or its subject is the
 *   role or the applicant, so "our team works on-site ..." stays unread.
 *
 * Digit counts written before the office ("4 days in the office") are read by
 * the older patterns and are not touched here. All quantifiers are bounded.
 */

import { ROLE_OR_APPLICANT } from "./onsiteStatements.js";

export interface OfficeFirstDays {
  readonly min: number;
  readonly max: number;
  /** The statement as found in the text given to the reader. */
  readonly quote: string;
}

const WORD_VALUES: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };

// A hyphen may follow a count only as a range ("4-5 days"), never "five-day".
const COUNT = String.raw`(one|two|three|four|five|six|seven|[1-7])(?!\w|-(?![ \t]?(?:[1-7](?!\w)|(?:one|two|three|four|five|six|seven)\b)))(?:[ \t]{0,3}\([ \t]?[1-7][ \t]?\))?`;
const DETERMINER = String.raw`(?:(?:the|our|your|an?)\s{1,3})?`;
/**
 * Up to three words naming the office: "our Singapore office", "the Marina Bay office".
 * Verbs and place prepositions are not name words, so "to be in the office" is read
 * at "in the office", where "be" shows attendance.
 */
const OFFICE = String.raw`${DETERMINER}(?:(?!(?:and|or|of|for|to|with|in|into|at|from|be|come|work)\b)[a-z][a-z'’-]{0,20}\s{1,3}){0,3}?offices?\b`;
const PLACE = [
  String.raw`(?:in|into|at|from|to)\s{1,3}${OFFICE}`,
  String.raw`from[ \t-]office\b`,
  String.raw`(?:on[- ]?site|in[- ]office|office[- ]based)\b`,
].join("|");
/** What may stand between the office and the count: punctuation, "for", "at least", "up to". */
const BEFORE_COUNT = String.raw`\s{0,3}[,:(–-]?\s{0,3}(?:for\s{1,3})?(?:(?:at\s{1,3}least|a\s{1,3}minimum\s{1,3}of|minimum(?:\s{1,3}of)?|no\s{1,3}(?:less|fewer)\s{1,3}than|up\s{1,3}to)\s{1,3})?`;
const RANGE = String.raw`(?:(?:\s{0,3}[-–]\s{0,3}|\s{1,3}(?:to|or)\s{1,3})${COUNT})?`;
const OUT_OF_FIVE = String.raw`(?:\s{1,3}(?:out\s{1,3})?of\s{1,3}(?:five|5)\b)?`;
const DAYS = String.raw`\+?\s{1,3}(?:full\s{1,3}|working\s{1,3})?days\b(?:\s{1,3}or\s{1,3}more\b)?`;
const WEEKLY = String.raw`\s{0,3},?\s{0,3}(?:(?:(?:a|per|each|every|of\s{1,3}the)\s{1,3}(?:working\s{1,3}|work\s{1,3})?week|weekly)\b|\/\s{0,3}week\b)`;

const STATEMENT = new RegExp(
  String.raw`\b(?:${PLACE})${BEFORE_COUNT}\b${COUNT}${RANGE}${OUT_OF_FIVE}${DAYS}${WEEKLY}`,
  "gi",
);

/** The words right before the office that say people attend it. */
const ATTENDANCE_BEFORE = /(?:\b(?:work|works|working|worked|be|being|is|are|am|come|comes|coming|return|returns|returning|report|reports|reporting|based|located|present|presence|attend|attends|attendance|expected|required|time|sit|sits|collaborate|collaborates|collaborating|gather|gathers|meet|meets|operate|operates)|['’](?:re|m))(?:\s{1,3}(?:in|together|fully|physically|primarily|currently|mainly|onsite|on-site)){0,2}\s{0,3}[:,]?\s{0,3}$/i;
/** The statement opens the text, a sentence, a bullet, a label or an HTML element. */
const OPENS_BEFORE = /(?:^|[.!?;:\n•·|>(*]|\s-)\s{0,3}$/;

const NEGATED_OR_HEDGED = /\b(?:not|never|no|nor|without|instead\s+of|rather\s+than|unlike|may|might|can|could|if|whether|optional|option|choose|choice|prefer|welcome\s+to|free\s+to|used\s+to|previously|formerly|occasionally|sometimes)\b|n['’]t\b/i;
/** The subject is a perk or a premises service, not the people hired. */
const PERK_SUBJECT = /\b(?:lunch(?:es)?|breakfast|dinner|meals?|snacks?|food|catering|coffee|barista|yoga|massages?|gym|fitness|class(?:es)?|doctor|nurse|physio(?:therapist)?|clinic|security|reception(?:ist)?|caf[eé]|canteen)\b/i;
const NEGATION_AFTER = /^\s{0,3}[,:(–-]?\s{0,3}(?:(?:is|are)\s{1,3})?(?:not\b|n['’]t\b|optional\b)/i;
/** "Gone are the days of ...", "Tired of ...", "Forget ...": the sentence dismisses the arrangement. */
const DISMISSED = /\b(?:gone\s{1,3}are\s{1,3}the\s{1,3}days|tired\s{1,3}of|forget)\b/i;
/** The rest of the sentence ends in a question mark. */
const QUESTION_AFTER = /^[^.!?;\n•<>]{0,80}\?/;
/** A starting period: "your first 90 days", "the initial three months", "probation", "onboarding". */
const STARTING_PERIOD = String.raw`(?:(?:the|your|a|an)\s{1,3})?(?:(?:first|initial)\s{1,3}(?:(?:couple\s{1,3}of|\d{1,3}|[a-z]{3,12})[ \t-]{1,3})?(?:days?|weeks?|months?|quarter|year|period)\b|(?:[a-z0-9]{1,6}[ -](?:month|week|day)[ -])?probation(?:ary)?\b|onboarding\b|induction\b|training\s{1,3}period\b)`;
/** "For the first three months, ...", "During probation, ...", "Initially, ...". "From your first day" is not a limit. */
const TIME_LIMITED_BEFORE = new RegExp(
  String.raw`\b(?:(?:for|during|in|over|within|throughout)\s{1,3}${STARTING_PERIOD}|initially\b|at\s{1,3}first\b)`,
  "i",
);
/** "... five days a week for your first 90 days", "... five days a week initially". */
const STARTING_PERIOD_AFTER = new RegExp(
  String.raw`^\s{0,3}[,(]?\s{0,3}(?:(?:for|during|in|over|within|throughout)\s{1,3}${STARTING_PERIOD}|initially\b|at\s{1,3}first\b|to\s{1,3}(?:start|begin)\s{1,3}with\b)`,
  "i",
);
/** "... during your first month", "... for one week each quarter". */
const TIME_LIMITED_AFTER = /^\s{0,3}[,(]?\s{0,3}(?:(?:for|during|in|while|until)\b[^.;!?\n]{0,40}?\b(?:weeks?|months?|quarters?|onboarding|induction|training|probation|period)|(?:once|twice|one\s{1,3}week)\s{1,3}(?:a|per|each|every)\s{1,3}(?:month|quarter|year))\b/i;

/** The "on-site" / "in-office" wording, as opposed to a named office. */
const PRESENCE_PLACE = /^(?:on[- ]?site|in[- ]office)(?![a-z])/i;
/** Only an instruction before the on-site wording: "Work on-site ...", "Expected to be on-site ...". */
const INSTRUCTION_ONLY = /^\s{0,3}(?:(?:please|must|expected\s{1,3}to|required\s{1,3}to)\s{1,3}){0,2}(?:(?:work|be|working)\s{0,3})?$/i;

const SENTENCE_BREAK = /[.!?;\n>•]/g;

function countValue(value: string): number {
  return WORD_VALUES[value.toLowerCase()] ?? Number(value);
}

/** The sentence text before `start`, at most `limit` characters. */
function sentenceBefore(text: string, start: number, limit = 80): string {
  const window = text.slice(Math.max(0, start - limit), start);
  return window.split(SENTENCE_BREAK).pop() ?? "";
}

/**
 * Whether the statement at `start`..`end` is limited to a starting period,
 * dismissed ("gone are the days", "tired of") or asked as a question. Shared with
 * the reader of counts spelled in words before the office (officeDayWords.ts).
 */
export function isTemporaryDismissedOrAsked(text: string, start: number, end: number): boolean {
  // A starting period often opens a long sentence, so it is looked for further back.
  const before = sentenceBefore(text, start, 160);
  if (DISMISSED.test(before) || TIME_LIMITED_BEFORE.test(before)) return true;
  const after = text.slice(end, end + 100);
  return TIME_LIMITED_AFTER.test(after) || STARTING_PERIOD_AFTER.test(after) || QUESTION_AFTER.test(after);
}

/** Whether the sentence negates or hedges the statement at `start`..`end`. Shared with officeDayWords.ts. */
export function isNegatedOrHedged(text: string, start: number, end: number): boolean {
  return NEGATED_OR_HEDGED.test(sentenceBefore(text, start)) || NEGATION_AFTER.test(text.slice(end, end + 80));
}

/** The office-first statement with the highest weekly count, or null. */
export function findOfficeFirstDays(text: string): OfficeFirstDays | null {
  let found: OfficeFirstDays | null = null;
  for (const match of text.matchAll(STATEMENT)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const preceding = text.slice(Math.max(0, start - 60), start);
    if (!ATTENDANCE_BEFORE.test(preceding) && !OPENS_BEFORE.test(preceding)) continue;
    const sentence = sentenceBefore(text, start);
    if (PERK_SUBJECT.test(sentence)) continue;
    if (PRESENCE_PLACE.test(match[0]) && !INSTRUCTION_ONLY.test(sentence) && !ROLE_OR_APPLICANT.test(sentence)) continue;
    if (isNegatedOrHedged(text, start, end) || isTemporaryDismissedOrAsked(text, start, end)) continue;
    const first = countValue(match[1] ?? "");
    const second = match[2] === undefined ? first : countValue(match[2]);
    const max = Math.max(first, second);
    if (!found || max > found.max) found = { min: Math.min(first, second), max, quote: match[0] };
  }
  return found;
}
