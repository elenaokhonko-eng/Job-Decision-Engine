/**
 * Workplace perks ("onsite gym", "on-site cafe", "in-office snacks", "parking
 * on site") describe the employer's premises, not where the job is done. They
 * are neutral: never evidence of an on-site, hybrid or remote work mode.
 *
 * Every text-based work-mode reader runs its patterns over
 * `neutralizeWorkplacePerkPhrases(text)`. Only the on-site / in-office token of
 * a perk phrase is blanked, with spaces of the same length, so offsets and the
 * rest of the text (including "wet lab", "lab-based", "laboratory-based",
 * "fully on-site", "5 days in office", "hybrid", "remote") are unchanged.
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

/** "Fully on-site" and "100% on-site" stay genuine work-mode statements. */
const NOT_AFTER_FULL = String.raw`(?<!\bfully[ \t]+|100%[ \t]*)`;

// The perk must follow on the same line; a newline, comma or period ends the phrase.
const TOKEN_BEFORE_PERK = new RegExp(
  String.raw`${NOT_AFTER_FULL}\b(${PRESENCE_TOKEN})(?=[ \t]+${PERK_MODIFIERS}(?:${PERK_NOUNS})\b(?!-))`,
  "gi",
);
const PERK_BEFORE_TOKEN = new RegExp(
  String.raw`(?<=\b(?:${PERK_NOUNS})[ \t]+(?:(?:is|are|available|provided)[ \t]+){0,2})(${PRESENCE_TOKEN})\b`,
  "gi",
);

export function neutralizeWorkplacePerkPhrases(text: string): string {
  return String(text ?? "")
    .replace(TOKEN_BEFORE_PERK, (token) => " ".repeat(token.length))
    .replace(PERK_BEFORE_TOKEN, (token) => " ".repeat(token.length));
}
