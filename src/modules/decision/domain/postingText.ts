/**
 * Posting fields as the blind sheet shows them. Where a record came from must not show in its formatting, so every
 * record gets the same casing, location shape and paragraph layout, and links, addresses and job-site mentions are
 * removed. The text is untrusted: markup and control characters are removed, and it is only ever shown inside a fence.
 * Content differences (what an employer writes, where a job is) cannot be removed. Pure.
 */

const LINE_WIDTH = 100;
const SENTENCES_PER_PARAGRAPH = 3;

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  ndash: "–", mdash: "—", bull: "•", hellip: "…", middot: "·",
};

const decodeEntities = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
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

const LINK_OR_ADDRESS =
  /\b(?:https?:\/\/|www\.)\S+|\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+|\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|ai|co|gov|edu|sg|uk)(?:\.[a-z]{2})?\/\S*/gi;
/** Names of the places postings are collected from. */
const SOURCE_MENTION = /linked ?in|my ?careers ?future|greenhouse\.io|ashbyhq|lever\.co/i;
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

/** One line of plain text: no markup, control or format characters, and nothing that can close a fence. */
export function plainLine(value: string): string {
  return value.replace(/[\p{Cc}\u2028\u2029]+/gu, " ").replace(/\p{Cf}+/gu, "").replace(/~{3,}|`{3,}/g, "-").replace(/\s+/g, " ").trim();
}

/** A header field: one line, without markup, links or addresses. */
export const headerLine = (value: string): string =>
  plainLine(withoutMarkup(value).replace(LINK_OR_ADDRESS, "[removed]"));

/** The posting text laid out the same way whatever shape it was stored in. */
export function sheetPostingText(description: string | null | undefined): string {
  const lines = withoutMarkup(description ?? "")
    .split(/\r?\n|\u2028|\u2029/)
    .map((line) => plainLine(line.replace(LINK_OR_ADDRESS, "[removed]").replace(/^\s*(?:#{1,6}\s+|[•·▪●*\-–]\s+)/, "").replace(/\*\*|__/g, "")))
    .filter((line) => line !== "" && !PAGE_CHROME.test(line));
  // A line that ends without punctuation (a heading or a list item) ends like a sentence, so stored line breaks leave no trace.
  const text = lines.map((line) => (/[.!?:;,]["”’)]?$/.test(line) ? line : `${line}.`)).join(" ");
  const sentences = text.split(/(?<=[.!?]["”’)]?)\s+(?=[\p{Lu}\p{N}“"(\[])/u).filter((sentence) => !SOURCE_MENTION.test(sentence));
  const paragraphs: string[] = [];
  for (let at = 0; at < sentences.length; at += SENTENCES_PER_PARAGRAPH) {
    paragraphs.push(wrap(sentences.slice(at, at + SENTENCES_PER_PARAGRAPH).join(" ")));
  }
  return paragraphs.join("\n\n");
}

const capitalised = (value: string): string =>
  value.toLowerCase().replace(/(^|[\s(/.\-*&+])(\p{L})/gu, (_, before: string, letter: string) => `${before}${letter.toUpperCase()}`);

const LEGAL_SUFFIX = /(?:[\s,]+(?:pte|pty|ltd|limited|llc|llp|inc|incorporated|plc|gmbh|private|sdn|bhd)\.?)+$/i;

/** A company name in one casing. `boardNames` maps a board's slug to the employer's written name. */
export function sheetCompany(company: string, boardNames: ReadonlyMap<string, string> = new Map()): string {
  const line = headerLine(company);
  const written = boardNames.get(line.toLowerCase()) ?? line;
  return capitalised(plainLine(written.replace(/\([^)]*\)/g, " ")).replace(LEGAL_SUFFIX, "")) || "Not Stated";
}

const WORK_MODE_WORDS = /\((?:[^()]*\b(?:on-?site|hybrid|remote)\b[^()]*)\)|\b(?:on-?site|hybrid|remote)\b/gi;

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
