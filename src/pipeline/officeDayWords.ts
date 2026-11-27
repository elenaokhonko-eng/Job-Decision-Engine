/**
 * Office-day counts written in words (gate-2026-11.10). The office-days rule read
 * "4 days in the office" but not "four days in the office". This rewrites such a
 * count to digits, so the same patterns and the same thresholds
 * (max_office_days_per_week, max_office_days_hard_fail) judge both spellings.
 *
 * The result has the same length as the input, so a match offset in it quotes the
 * posting's own words from the original text.
 *
 * A count is rewritten only when:
 * - it is spelled with a word and its highest number is four to seven (lower
 *   word counts are left unread, as before);
 * - an office or on-site phrase follows it in a form the digit patterns read, so
 *   "four-day work week", "five days of annual leave", "within five working days"
 *   and "four days remote" are untouched;
 * - it is not a count per month, quarter or year, and not "N of five days";
 * - it is not negated or hedged ("not", "no more", "may"), limited to a starting
 *   period ("during onboarding"), dismissed ("gone are the days", "forget") or
 *   asked as a question, the same exceptions as for counts after the office
 *   (officeFirstDays.ts).
 *
 * Counts written in digits are never changed. All quantifiers are bounded.
 */

import { isNegatedOrHedged, isTemporaryDismissedOrAsked } from "./officeFirstDays.js";

const WORD_VALUES: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };

const NUMBER = String.raw`(?:one|two|three|four|five|six|seven|[1-7])`;
/** A count, optionally repeated in brackets: "four (4)". */
const COUNT = String.raw`\b${NUMBER}\b(?:[ \t]{0,3}\([ \t]?[1-7][ \t]?\))?`;
const RANGE_SEPARATOR = String.raw`(?:\s{0,3}[-–]\s{0,3}|\s{1,3}(?:to|or)\s{1,3})`;
/** What the digit patterns accept after a count: "days [per week] [in|at] [the] office", "days on-site", "office days". */
const OFFICE_PHRASE = String.raw`\s{1,3}(?:(?:office|on-?site)\s{1,3}days?\b|days?(?:\s{1,3}(?:per|a)\s{0,3}week|\s{0,3}\/\s{0,3}week)?(?:\s{1,3}(?:in|at))?(?:\s{1,3}the)?\s{0,3}(?:office|on-?site|in-?office)\b)`;

// Not after a hyphen or a tens word, so "twenty-four days" is not read as four.
const COUNT_BEFORE_OFFICE = new RegExp(
  String.raw`(?<![\w-])(?<!\b(?:twenty|thirty|forty|fifty)[ \t])${COUNT}(?:${RANGE_SEPARATOR}${COUNT})?(?=${OFFICE_PHRASE})`,
  "gi",
);
const OFFICE_PHRASE_AT_START = new RegExp(`^${OFFICE_PHRASE}`, "i");
/** "... in the office per month", "... on-site each quarter", "... in the office monthly". */
const OTHER_PERIOD_AFTER = /^\s{0,3},?\s{0,3}(?:(?:(?:in|during)\s{1,3})?(?:per|a|an|each|every)\s{1,3}(?:calendar\s{1,3})?(?:month|quarter|year)\b|(?:monthly|quarterly|annually|yearly)\b)/i;
/** The weekly marker may follow the phrase: "four days on-site per week". */
const WEEKLY_AT_START = /^\s{0,3},?\s{0,3}(?:(?:per|a|each|every)\s{1,3}week\b|weekly\b|\/\s{0,3}week\b)/i;
/** "per month, four days in the office". */
const OTHER_PERIOD_BEFORE = /\b(?:per|each|every)\s{1,3}(?:calendar\s{1,3})?(?:month|quarter|year)\s{0,3}[,:]?\s{0,3}$/i;
/** "two of the five days in the office" counts a part of the week, not the week. */
const PART_OF_BEFORE = /\bof\s{1,3}(?:(?:the|your|a)\s{1,3})?$/i;
/** The digit patterns backtrack over long blank runs, so a count next to one is left unread. */
const LONG_BLANK_RUN = /\s{12}/;

export function readOfficeDayWords(text: string): string {
  return text.replace(COUNT_BEFORE_OFFICE, (count: string, offset: number) => {
    const words = count.toLowerCase().match(/[a-z]+/g)?.filter((word) => word in WORD_VALUES) ?? [];
    if (words.length === 0) return count;
    const values = (count.toLowerCase().match(new RegExp(NUMBER, "g")) ?? []).map((value) => WORD_VALUES[value] ?? Number(value));
    if (Math.max(...values) < 4) return count;
    const before = text.slice(Math.max(0, offset - 40), offset);
    if (PART_OF_BEFORE.test(before) || OTHER_PERIOD_BEFORE.test(before)) return count;
    const rest = text.slice(offset + count.length, offset + count.length + 120);
    const phrase = OFFICE_PHRASE_AT_START.exec(rest)?.[0] ?? "";
    if (OTHER_PERIOD_AFTER.test(rest.slice(phrase.length)) || LONG_BLANK_RUN.test(rest)) return count;
    const weekly = WEEKLY_AT_START.exec(rest.slice(phrase.length))?.[0] ?? "";
    const end = offset + count.length + phrase.length + weekly.length;
    if (isNegatedOrHedged(text, offset, end) || isTemporaryDismissedOrAsked(text, offset, end)) return count;
    // "four (4)" is one count: the bracketed repeat is blanked.
    return count
      .replace(/\([ \t]?[1-7][ \t]?\)/g, (repeat) => " ".repeat(repeat.length))
      .replace(/\b(?:one|two|three|four|five|six|seven)\b/gi, (word) => String(WORD_VALUES[word.toLowerCase()]).padEnd(word.length));
  });
}
