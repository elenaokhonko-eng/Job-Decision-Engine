/**
 * Posting fields as the blind sheet shows them. Where a record came from must not show in its formatting, so every
 * record gets the same casing, location shape and paragraph layout. Links, addresses, job-site names and saved or
 * applied status lines are removed from the text and from every header field, after the characters that could split
 * them. The text is untrusted: markup and control characters are removed, it is only ever shown inside a fence, and
 * every pattern here is bounded so that long input stays fast. Content differences (what an employer writes, where a
 * job is) cannot be removed. Pure.
 */

const LINE_WIDTH = 100;
const SENTENCES_PER_PARAGRAPH = 3;
/** A header field longer than this is cut: no title, company or location needs more. */
const HEADER_CHARACTERS = 300;
const REMOVED = "[removed]";

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  ndash: "–", mdash: "—", bull: "•", hellip: "…", middot: "·", period: ".", sol: "/", colon: ":",
};

const decodeEntities = (text: string): string =>
  text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (match, entity: string) => {
    if (entity[0] !== "#") return ENTITIES[entity.toLowerCase()] ?? match;
    const code = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
  });

/** Entities first (some sources store markup escaped), then tags: block tags end a line. */
function withoutMarkup(text: string): string {
  let current = decodeEntities(decodeEntities(text));
  current = current.replace(/<\/?(?:p|div|li|ul|ol|br|h[1-6]|tr|table|section)\b[^<>]*>/gi, "\n").replace(/<\/?[a-z!][^<>]*>/gi, " ");
  return decodeEntities(current);
}

/**
 * One line of plain text: compatibility forms folded, no control or format characters (zero-width included), no markdown
 * emphasis or escape characters, and so nothing that splits a link or closes a fence.
 */
export function plainLine(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\p{Cf}+/gu, "")
    .replace(/[\p{Cc}\u2028\u2029]+/gu, " ")
    .replace(/[*`\\]+|__+|~{2,}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Any scheme with an authority, and the schemes that need none. */
const SCHEME_LINK = /\b(?:[a-z][a-z0-9+.-]{1,20}:\/\/|(?:file|mailto|tel|data|javascript|skype|sip):(?=\S))\S*/gi;
const WWW_LINK = /\bwww\d?\.\S+/gi;
const EMAIL = /[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63}){1,8}/gu;
const IP_ADDRESS = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?:\/\S*)?/g;
/** A dotted name followed by a path, query or port: a link whatever its ending is. */
const HOST_WITH_PATH = /(?:[\p{L}\p{N}-]{1,63}\.){1,8}\p{L}{2,24}(?::\d{1,5})?[/?#]\S*/gu;
/** A dotted name with no path counts as a host only with an ending that is used as one. */
const HOST_ENDINGS =
  "com|org|net|edu|gov|int|io|ai|co|app|dev|jobs|careers|work|works|team|tech|info|biz|xyz|online|site|me|ly|gle|gl|link|page|so|to|cc|tv|" +
  "sg|my|in|id|ph|th|vn|hk|cn|tw|jp|kr|au|nz|uk|ie|de|fr|nl|be|ch|at|es|it|pt|se|no|dk|fi|pl|cz|us|ca|br|mx|za|ae|il|eu|asia|cloud|digital|global";
const BARE_HOST = new RegExp(`(?:[\\p{L}\\p{N}-]{1,63}\\.){1,8}(?:${HOST_ENDINGS})(?![\\p{L}\\p{N}-])`, "giu");
/** Technology names written like hosts. */
const NOT_HOSTS = new Set(["asp.net", "vb.net", "ado.net", "socket.io"]);

/**
 * Stored text often lacks the space after a full stop ("done.In"), which is not a host. A bare name counts as one when
 * its ending is in lower case or the whole of it is in capitals.
 */
const writtenAsHost = (token: string): boolean =>
  /\.\p{Ll}+$/u.test(token) || token === token.toUpperCase();

/** Replaces every link and address. The input must already be plain (see plainLine). */
function withoutLinks(line: string, bareHost: (host: string) => string = () => REMOVED, isHost = writtenAsHost): string {
  return line
    .replace(SCHEME_LINK, REMOVED)
    .replace(WWW_LINK, REMOVED)
    .replace(EMAIL, REMOVED)
    .replace(IP_ADDRESS, REMOVED)
    .replace(HOST_WITH_PATH, REMOVED)
    .replace(BARE_HOST, (host) => (NOT_HOSTS.has(host.toLowerCase()) || !isHost(host) ? host : bareHost(host)));
}

/** Names of the places postings are collected from. "linked in" as two words is ordinary English and stays. */
const SOURCE_MENTION =
  /linkedin|my ?careers ?future|jobstreet|jobsdb|glassdoor|efinancialcareers|ziprecruiter|simplyhired|greenhouse\.io|ashbyhq|lever\.co/i;
/** What a job page says about the reader or about the listing, never about the work. */
const LISTING_STATUS =
  /^(?:saved|applied)(?: (?:\d{1,3} \w{3,7} ago|on [\w ,]{0,30}))?\.?$|\b(?:you(?:'ve| have)? (?:saved|applied)|easy apply|promoted by hirer|actively (?:recruiting|reviewing applicants)|application (?:submitted|viewed)|\d[\d,]{0,8}\+? applicants?|(?:re)?posted \d{1,3} (?:minute|hour|day|week|month)s? ago)\b/i;
const PAGE_CHROME = /^(?:show (?:more|less)|see (?:more|less)|apply(?: now| for this job)?|save|about the job)\s*$/i;

function wrap(paragraph: string): string {
  const lines: string[] = [""];
  for (const word of paragraph.split(" ")) {
    const last = lines[lines.length - 1]!;
    if (last && last.length + word.length + 1 > LINE_WIDTH) lines.push(word);
    else lines[lines.length - 1] = last ? `${last} ${word}` : word;
  }
  return lines.join("\n");
}

const headerText = (value: string): string => plainLine(withoutMarkup(value.slice(0, HEADER_CHARACTERS * 4))).slice(0, HEADER_CHARACTERS);

const withoutSiteWords = (line: string): string =>
  line
    .replace(new RegExp(`\\b(?:via|from|on) (?=(?:${SOURCE_MENTION.source}))`, "gi"), "")
    .replace(new RegExp(SOURCE_MENTION.source, "gi"), "")
    .replace(new RegExp(LISTING_STATUS.source, "gi"), "")
    .replace(/\(\s*\)|\[\s*\]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s,|:;–-]+|[\s,|:;–-]+$/g, "");

/** A header field: one line, without markup, links, addresses, job-site names or listing status. */
export const headerLine = (value: string): string => withoutSiteWords(withoutLinks(headerText(value)));

/** The posting text laid out the same way whatever shape it was stored in. */
export function sheetPostingText(description: string | null | undefined): string {
  const lines = withoutMarkup(description ?? "")
    .split(/\r?\n|\u2028|\u2029/)
    .map((line) => plainLine(withoutLinks(plainLine(line)).replace(/^\s*(?:#{1,6}\s+|[•·▪●\-–]\s+)/, "")))
    .filter((line) => line !== "" && !PAGE_CHROME.test(line) && !LISTING_STATUS.test(line));
  // A line that ends without punctuation (a heading or a list item) ends like a sentence, so stored line breaks leave no trace.
  const text = lines.map((line) => (/[.!?:;,]["”’)]?$/.test(line) ? line : `${line}.`)).join(" ");
  const sentences = text
    .split(/(?<=[.!?]["”’)]?)\s+(?=[\p{Lu}\p{N}“"([])/u)
    .filter((sentence) => !SOURCE_MENTION.test(sentence) && !LISTING_STATUS.test(sentence));
  const paragraphs: string[] = [];
  for (let at = 0; at < sentences.length; at += SENTENCES_PER_PARAGRAPH) {
    paragraphs.push(wrap(sentences.slice(at, at + SENTENCES_PER_PARAGRAPH).join(" ")));
  }
  return paragraphs.join("\n\n");
}

const capitalised = (value: string): string =>
  value.toLowerCase().replace(/(^|[\s(/.\-*&+])(\p{L})/gu, (_, before: string, letter: string) => `${before}${letter.toUpperCase()}`);

const LEGAL_SUFFIX = /(?:[\s,]+(?:pte|pty|ltd|limited|llc|llp|inc|incorporated|plc|gmbh|private|sdn|bhd)\.?)+$/i;

/**
 * A company name in one casing. `boardNames` maps a board's slug to the employer's written name. A name written like a
 * host ("Name.ai") keeps its words with the dot gone, so it names the employer and links nowhere.
 */
export function sheetCompany(company: string, boardNames: ReadonlyMap<string, string> = new Map()): string {
  const text = headerText(company);
  const written = headerText(boardNames.get(text.toLowerCase()) ?? text);
  // A company name is one short field, so a dotted name in any casing is taken for a host.
  const unlinked = withoutSiteWords(withoutLinks(written, (host) => host.replaceAll(".", " "), () => true));
  return capitalised(plainLine(unlinked.replace(/\([^)]*\)/g, " ")).replace(LEGAL_SUFFIX, "")) || "Not Stated";
}

const WORK_MODE_WORDS = /\((?:[^()]{0,60}?\b(?:on-?site|hybrid|remote)\b[^()]{0,60})\)|\b(?:on-?site|hybrid|remote)\b/gi;

/** A location as a list of places in one casing, without work-mode words, postal codes or repeats. */
export function sheetLocation(location: string): string {
  const places = headerLine(location)
    .replace(WORK_MODE_WORDS, " ")
    .split(/[;,|/]| - | – /)
    .map((part) => part.replace(/\b\d{5,6}\b/g, " ").replace(/\b(?:greater|metropolitan|metro|area)\b/gi, " ").replace(/\s+/g, " ").replace(/^[\s\-–]+|[\s\-–]+$/g, ""))
    .map((part) => (/^(?:singapore|sg|sgp|republic of singapore|central singapore)$/i.test(part) ? "Singapore" : capitalised(part)))
    .filter((part) => part !== "" && !/^(?:not stated|unknown|unspecified)$/i.test(part));
  return [...new Set(places)].join(", ") || "not stated";
}

export function sheetWorkMode(mode: "REMOTE" | "HYBRID" | "ONSITE" | null): string {
  return mode === "REMOTE" ? "Remote" : mode === "HYBRID" ? "Hybrid" : mode === "ONSITE" ? "On-site" : "not stated";
}
