/**
 * Workplace perks ("onsite gym", "on-site cafe", "in-office snacks", "parking
 * on site") describe the employer's premises, not where the job is done. They
 * are neutral: never evidence of an on-site, hybrid or remote work mode.
 *
 * Every text-based work-mode reader runs its patterns over
 * `neutralizeWorkplacePerkPhrases(text)`. Only an on-site / in-office token that
 * directly modifies a perk noun is blanked, with spaces of the same length, so
 * offsets and the rest of the text (including "wet lab", "lab-based",
 * "laboratory-based", "hybrid", "remote") are unchanged. A token that is itself
 * a work-mode statement ("fully on-site", "5 days in office", "role is onsite",
 * "Location: On-site") is kept even when a perk follows on the same line.
 */

const PRESENCE_TOKEN = String.raw`on[- ]?site|in[- ]?office`;

/** Optional modifiers between the token and the perk noun ("onsite free parking"). */
const PERK_MODIFIERS = String.raw`(?:(?:free|complimentary|subsidi[sz]ed|staff|employee|fully[- ]equipped|state[- ]of[- ]the[- ]art|modern|24\/7|private|dedicated)[ \t]+){0,2}`;

const PERK_NOUNS = [
  String.raw`gym(?:s|nasiums?)?`,
  String.raw`fitness(?:[ \t]+(?:cent(?:er|re)s?|studios?|rooms?|facilit(?:y|ies)))?`,
  String.raw`caf(?:e|é)s?`,
  String.raw`cafeterias?`,
  String.raw`canteens?`,
  String.raw`restaurants?`,
  String.raw`kitchens?`,
  String.raw`pantr(?:y|ies)`,
  String.raw`dining`,
  String.raw`meals?`,
  String.raw`lunch(?:es)?`,
  String.raw`snacks?`,
  String.raw`coffee`,
  String.raw`baristas?`,
  String.raw`parking`,
  String.raw`car[ \t]?parks?`,
  String.raw`child[ \t]?care`,
  String.raw`day[ \t]?care`,
  String.raw`cr[eè]ches?`,
  String.raw`nurser(?:y|ies)`,
  String.raw`(?:medical|health)[ \t]+(?:clinics?|cent(?:er|re)s?|services|facilit(?:y|ies))`,
  String.raw`clinics?`,
  String.raw`physio(?:therapy)?`,
  String.raw`massages?`,
  String.raw`wellness`,
  String.raw`well[- ]?being`,
  String.raw`amenit(?:y|ies)`,
  String.raw`facilit(?:y|ies)`,
  String.raw`showers?`,
  String.raw`bike[ \t]+(?:storage|parking|racks?)`,
  String.raw`laundry`,
  String.raw`dry[ \t]+cleaning`,
  String.raw`(?:prayer|nursing|lactation|game|games|mothers?['’]?)[ \t]+rooms?`,
  String.raw`perks?`,
].join("|");

/** A workplace perk phrase ("free parking", "gym", "perks") as a regex source fragment. */
export const WORKPLACE_PERK_PHRASE_SOURCE = String.raw`${PERK_MODIFIERS}(?:${PERK_NOUNS})\b(?!-)`;

/**
 * A token that already forms a work-mode statement is never blanked, even when
 * a perk follows on the same line ("5 days on-site meals provided",
 * "Location: On-site Parking available", "Full-time · On-site Free parking",
 * "This role is on-site facilities based", "Work on-site facilities daily").
 */
const STATEMENT_BEFORE_TOKEN = [
  // "fully on-site", "100% onsite", "strictly onsite"
  String.raw`\b(?:fully|entirely|strictly|exclusively|completely|only)[ \t]+`,
  String.raw`\b100[ \t]*%[ \t]*`,
  // "5 days on-site", "4-5 days per week in office", "3 days a week at the on-site"
  String.raw`\b\d+(?:\s*(?:-|–|to)\s*\d+)?\s*(?:days?|d|x)\b\s*(?:(?:per|a)\s+week\s*|\/\s*week\s*)?(?:(?:in|at)\s+(?:the\s+)?)?`,
  // Header separators: "Full-time · On-site", "Remote | On-site"
  String.raw`[|·][ \t]*`,
  // Work-mode labels: "Location: On-site", "Workplace type: Onsite"
  String.raw`\b(?:location|workplace|position|role|work[ \t]*mode|work(?:place)?[ \t]+(?:type|model|mode|location|arrangement|setting|style)|working[ \t]+(?:model|arrangement|pattern)|job[ \t]+type|employment[ \t]+type)[ \t]*:[ \t]*`,
  // "role is on-site", "work on-site", "working onsite", "based onsite"
  String.raw`\b(?:role|position|job|work|works|working|presence|based)[ \t]+(?:(?:is|are|will[ \t]+be|must[ \t]+be|required)[ \t]+)?`,
].join("|");

const NOT_A_STATEMENT = String.raw`(?<!${STATEMENT_BEFORE_TOKEN})`;

// The perk must follow on the same line; a newline, comma or period ends the phrase.
const TOKEN_BEFORE_PERK = new RegExp(
  String.raw`${NOT_A_STATEMENT}\b(${PRESENCE_TOKEN})(?=[ \t]+${PERK_MODIFIERS}(?:${PERK_NOUNS})\b(?!-))`,
  "gi",
);
// "parking on-site", "gym is available onsite"; never "... on-site only" or "... on-site 5 days".
const PERK_BEFORE_TOKEN = new RegExp(
  String.raw`(?<=\b(?:${PERK_NOUNS})[ \t]+(?:(?:is|are|available|provided)[ \t]+){0,2})(${PRESENCE_TOKEN})\b(?![ \t]*(?:only\b|\d))`,
  "gi",
);

export function neutralizeWorkplacePerkPhrases(text: string): string {
  return String(text ?? "")
    .replace(TOKEN_BEFORE_PERK, (token) => " ".repeat(token.length))
    .replace(PERK_BEFORE_TOKEN, (token) => " ".repeat(token.length));
}
