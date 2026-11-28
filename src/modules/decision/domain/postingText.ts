/**
 * Posting fields as the blind sheet shows them. The text is untrusted, and nothing here has to make it harmless: the
 * sheet indents every posting line, so none can be a fence, a heading, markup or an answer. This file only keeps the
 * rater from seeing where a record came from before the rating, and keeps what she rates intact:
 *  - real links go (a scheme, "www.", a known short-link or form host, an e-mail address, the job's own addresses and
 *    ids); a bare company domain or a technology name stays;
 *  - a stored line that is only job-board page or status wording goes; no sentence is ever dropped;
 *  - company, location and work mode are written one way, and every posting gets the same paragraph layout.
 * How much was removed is measured, so a posting that cannot be shown whole enough is left out, never shown empty.
 * Every pattern is bounded so that long input stays fast. Pure.
 */

const LINE_WIDTH = 100;
const SENTENCES_PER_PARAGRAPH = 3;
/** A header field longer than this is cut: no title, company or location needs more. */
const HEADER_CHARACTERS = 300;
const REMOVED = "[removed]";
/** A posting that loses more of its text than this share cannot be rated from the sheet. */
export const MAX_REMOVED_SHARE = 0.1;

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

/** One line of plain text: compatibility forms folded, no format (zero-width) or control characters, no line breaks. */
export function plainLine(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\p{Cf}+/gu, "")
    .replace(/[\p{Cc}\u2028\u2029]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Any scheme with "//", and the schemes written without it in the forms that open something. */
const SCHEME_LINK =
  /\b(?:[a-z][a-z0-9+.-]{1,20}:\/\/|file:\/|mailto:(?=\S)|javascript:(?=\S)|data:[a-z]{1,20}\/|(?:tel|sms):(?=\+?\d))\S*/gi;
const WWW_LINK = /\bwww\d?\.\S+/gi;
const EMAIL = /[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63}){1,8}/gu;
/** Hosts that only shorten links or collect applications. */
const SHORT_OR_FORM_HOSTS = [
  "lnkd.in", "bit.ly", "tinyurl.com", "t.co", "goo.gl", "forms.gle", "forms.office.com", "forms.microsoft.com",
  "docs.google.com", "rb.gy", "ow.ly", "buff.ly", "rebrand.ly", "shorturl.at", "cutt.ly", "is.gd", "typeform.com",
  "go.gov.sg", "form.gov.sg",
];

// "-" is left alone: outside a character class it needs no escape, and with the "u" flag escaping it is an error.
const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
/** A host (or one under it) that starts a token. */
const hostPattern = (hosts: readonly string[], path: "optional" | "required") =>
  new RegExp(
    `(?<![\\p{L}\\p{N}.@-])(?:[a-z0-9-]{1,63}\\.){0,5}(?:${hosts.map(escaped).join("|")})(?![\\p{L}\\p{N}-])` +
      (path === "required" ? "/\\S*" : "(?:/\\S*)?"),
    "giu",
  );
const SHORT_LINK = hostPattern(SHORT_OR_FORM_HOSTS, "optional");

/** What identifies this job's own pages: the hosts of its links, the links and the ids in them. */
export interface OwnAddresses {
  readonly hostWithPath: RegExp | null;
  readonly literals: readonly string[];
}

export function ownAddresses(links: ReadonlyArray<string | null | undefined>): OwnAddresses {
  const hosts = new Set<string>();
  const literals = new Set<string>();
  for (const link of links) {
    let url: URL;
    try {
      url = new URL((link ?? "").trim());
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    hosts.add(url.hostname.toLowerCase().replace(/^www\./, ""));
    literals.add(`${url.hostname}${url.pathname}`.replace(/\/$/, ""));
    // Ids: long path parts and query values that carry digits.
    for (const part of [...url.pathname.split("/"), ...url.searchParams.values()]) {
      for (const id of part.match(/[A-Za-z0-9-]{0,40}\d{5,}[A-Za-z0-9-]{0,40}|[0-9a-f]{8}-[0-9a-f-]{27}/gi) ?? []) literals.add(id);
    }
  }
  return {
    hostWithPath: hosts.size ? hostPattern([...hosts].slice(0, 12), "required") : null,
    literals: [...literals].filter((value) => value.length >= 5).sort((a, b) => b.length - a.length),
  };
}

const NO_ADDRESSES: OwnAddresses = { hostWithPath: null, literals: [] };

/** Replaces real links, addresses and this job's own ids. The input must already be plain (see plainLine). */
function withoutLinks(line: string, own: OwnAddresses = NO_ADDRESSES): string {
  let current = line.replace(SCHEME_LINK, REMOVED).replace(WWW_LINK, REMOVED).replace(EMAIL, REMOVED).replace(SHORT_LINK, REMOVED);
  if (own.hostWithPath) current = current.replace(own.hostWithPath, REMOVED);
  for (const literal of own.literals) {
    if (current.toLowerCase().includes(literal.toLowerCase())) current = current.replace(new RegExp(escaped(literal), "gi"), REMOVED);
  }
  return current;
}

/** One piece of job-board page or status wording, standing alone. */
const CHROME =
  "(?:save|saved|apply|applied|apply now|apply for this job|easy apply|show more|show less|see more|see less|about the job|promoted by hirer|" +
  "actively recruiting|actively reviewing applicants|application (?:submitted|viewed)|(?:saved|applied|(?:re)?posted) \\d{1,3} ?(?:minute|hour|day|week|month|h|d|w|mo)s?(?: ago)?|" +
  "(?:over )?\\d[\\d,]{0,8}\\+? (?:applicants?|people clicked apply)|applied on [\\w ,]{3,20})";
/** A whole line of nothing but such wording, alone or several joined by separators. */
const CHROME_LINE = new RegExp(`^(?:${CHROME})(?:\\s{0,3}[·|•–-]\\s{0,3}(?:${CHROME})){0,5}\\s{0,3}\\.?$`, "i");

function wrap(paragraph: string): string {
  const lines: string[] = [""];
  for (const word of paragraph.split(" ")) {
    const last = lines[lines.length - 1]!;
    if (last && last.length + word.length + 1 > LINE_WIDTH) lines.push(word);
    else lines[lines.length - 1] = last ? `${last} ${word}` : word;
  }
  return lines.join("\n");
}

const visible = (value: string): number => value.replace(/\s+/g, "").length;

export interface SheetPosting {
  /** Empty when nothing is left to show. */
  readonly text: string;
  /** Share of the posting's characters (markup and spacing apart) that cleaning removed. */
  readonly removedShare: number;
}

/** The posting text laid out the same way whatever shape it was stored in, and how much of it was removed. */
export function sheetPosting(description: string | null | undefined, links: ReadonlyArray<string | null> = []): SheetPosting {
  const own = ownAddresses(links);
  let total = 0;
  let removed = 0;
  const lines: string[] = [];
  for (const stored of withoutMarkup(description ?? "").split(/\r\n|[\r\n\u2028\u2029]/)) {
    const plain = plainLine(stored).replace(/^(?:#{1,6}\s+|[•·▪●*\-–]\s+)/, "");
    if (!plain) continue;
    total += visible(plain);
    if (CHROME_LINE.test(plain)) {
      removed += visible(plain);
      continue;
    }
    const clean = withoutLinks(plain, own);
    // The placeholder is not posting text.
    removed += Math.max(0, visible(plain) - visible(clean.replaceAll(REMOVED, "")));
    lines.push(clean);
  }
  // A line that ends without punctuation (a heading or a list item) ends like a sentence, so stored line breaks leave no trace.
  const text = lines.map((line) => (/[.!?:;,]["”’)]?$/.test(line) ? line : `${line}.`)).join(" ");
  const sentences = text ? text.split(/(?<=[.!?]["”’)]?)\s+(?=[\p{Lu}\p{N}“"([])/u) : [];
  const paragraphs: string[] = [];
  for (let at = 0; at < sentences.length; at += SENTENCES_PER_PARAGRAPH) {
    paragraphs.push(wrap(sentences.slice(at, at + SENTENCES_PER_PARAGRAPH).join(" ")));
  }
  return { text: paragraphs.join("\n\n"), removedShare: total === 0 ? 1 : removed / total };
}

/** False for a posting that cleaning leaves empty or cuts by more than MAX_REMOVED_SHARE. */
export function postingCanBeShown(description: string | null | undefined, links: ReadonlyArray<string | null> = []): boolean {
  const posting = sheetPosting(description, links);
  return posting.text.replaceAll(REMOVED, "").trim() !== "" && posting.removedShare <= MAX_REMOVED_SHARE;
}

/** Names of the places postings are collected from: taken out of header fields only. */
const JOB_SITES = "linkedin|my ?careers ?future|jobstreet|jobsdb|glassdoor|efinancialcareers|ziprecruiter|simplyhired";
const SITE_IN_HEADER = new RegExp(`(?:\\b(?:via|from|on) )?(?:${JOB_SITES})`, "gi");
const CHROME_IN_HEADER = new RegExp(`(?:^|\\s{0,3}[·|•–,-]\\s{0,3})(?:${CHROME})(?=\\s{0,3}(?:$|[·|•–,-]))`, "gi");

/** A header field: one line, without markup, links, job-site names or listing status set apart by a separator. */
export function headerLine(value: string, links: ReadonlyArray<string | null> = []): string {
  const plain = plainLine(withoutMarkup(value.slice(0, HEADER_CHARACTERS * 4))).slice(0, HEADER_CHARACTERS);
  return withoutLinks(plain, ownAddresses(links))
    .replace(CHROME_IN_HEADER, "")
    .replace(SITE_IN_HEADER, "")
    .replace(/\(\s*\)|\[\s*\]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s,|:;–-]+|[\s,|:;–-]+$/g, "");
}

const capitalised = (value: string): string =>
  value.toLowerCase().replace(/(^|[\s(/.\-*&+])(\p{L})/gu, (_, before: string, letter: string) => `${before}${letter.toUpperCase()}`);

const LEGAL_SUFFIX = /(?:[\s,]+(?:pte|pty|ltd|limited|llc|llp|inc|incorporated|plc|gmbh|private|sdn|bhd)\.?)+$/i;

/** A company name in one casing. `boardNames` maps a board's slug to the employer's written name. */
export function sheetCompany(
  company: string,
  boardNames: ReadonlyMap<string, string> = new Map(),
  links: ReadonlyArray<string | null> = [],
): string {
  const line = headerLine(company, links);
  const written = headerLine(boardNames.get(line.toLowerCase()) ?? line, links);
  return capitalised(plainLine(written.replace(/\([^)]*\)/g, " ")).replace(LEGAL_SUFFIX, "")) || "Not Stated";
}

const WORK_MODE_WORDS = /\((?:[^()]{0,60}?\b(?:on-?site|hybrid|remote)\b[^()]{0,60})\)|\b(?:on-?site|hybrid|remote)\b/gi;

/** A location as a list of places in one casing, without work-mode words, postal codes or repeats. */
export function sheetLocation(location: string, links: ReadonlyArray<string | null> = []): string {
  const places = headerLine(location, links)
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
