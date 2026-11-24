/**
 * Finds the span of the stored (raw) posting text that a quote taken from the
 * cleaned text came from, so a stored quote and its offsets can always be
 * checked against the stored text (`quote === raw.slice(start, end)`).
 *
 * The cleaned text differs from the raw text only by what the cleaner removes:
 * known tags and comments (replaced by a space or newline), entities, invisible
 * and control characters, and runs of blank space. The scan below walks the raw
 * text forward once per candidate start and tolerates exactly those
 * differences. It never guesses: if no span matches, the result is null and the
 * caller stores no quote.
 *
 * Pure and deterministic. Work is bounded by the number of candidate starts
 * (capped) times the quote length.
 */
import { decodeHtmlEntities } from "./sanitize.js";
import { matchKnownTagAt } from "./postingText.js";

const MAX_CANDIDATES = 20_000;
export const MAX_ANCHORED_QUOTE_CHARS = 4000;

export interface AnchoredQuote {
  readonly quote: string;
  readonly start: number;
  readonly end: number;
}

const ENTITY_AT = /&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});/y;
const INVISIBLE_OR_CONTROL =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB]/;
const BLANK = /\s/;

function entityAt(raw: string, index: number): { char: string; length: number } | null {
  if (raw.charCodeAt(index) !== 38) return null;
  ENTITY_AT.lastIndex = index;
  const match = ENTITY_AT.exec(raw);
  if (!match) return null;
  const decoded = decodeHtmlEntities(match[0]);
  return decoded === match[0] ? null : { char: decoded, length: match[0].length };
}

/** Length of a comment or known tag at `index`, or 0. */
function markupLengthAt(raw: string, index: number): number {
  if (raw.startsWith("<!--", index)) {
    const end = raw.indexOf("-->", index + 4);
    return end === -1 ? 0 : end + 3 - index;
  }
  return matchKnownTagAt(raw, index);
}

/** Consumes at least one blank, tag, comment, blank entity or invisible character; returns the new index or -1. */
function consumeBlankRun(raw: string, from: number): number {
  let i = from;
  let consumed = false;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (BLANK.test(ch) || INVISIBLE_OR_CONTROL.test(ch)) {
      i += 1;
    } else if (ch === "<") {
      const length = markupLengthAt(raw, i);
      if (length === 0) break;
      i += length;
    } else if (ch === "&") {
      const entity = entityAt(raw, i);
      if (!entity || !BLANK.test(entity.char)) break;
      i += entity.length;
    } else {
      break;
    }
    consumed = true;
  }
  return consumed ? i : -1;
}

function scanFrom(raw: string, quote: string, start: number): number {
  let i = start;
  let j = 0;
  while (j < quote.length) {
    const wanted = quote[j]!;
    if (BLANK.test(wanted)) {
      const next = consumeBlankRun(raw, i);
      if (next === -1) return -1;
      i = next;
      while (j < quote.length && BLANK.test(quote[j]!)) j += 1;
      continue;
    }
    while (i < raw.length && INVISIBLE_OR_CONTROL.test(raw[i]!)) i += 1;
    if (i >= raw.length) return -1;
    // Entity first: the cleaner decodes "&amp;" to "&", so a wanted "&" may be a whole entity.
    const entity = entityAt(raw, i);
    if (entity && entity.char === wanted) {
      i += entity.length;
      j += 1;
      continue;
    }
    if (raw[i] === wanted) {
      i += 1;
      j += 1;
      continue;
    }
    return -1;
  }
  return i;
}

function closest(candidates: readonly number[], hint: number): number {
  let best = candidates[0]!;
  for (const candidate of candidates) {
    if (Math.abs(candidate - hint) < Math.abs(best - hint)) best = candidate;
  }
  return best;
}

/**
 * @param raw   the stored posting text
 * @param quote a quote found in the cleaned text
 * @param hint  where the quote started in the cleaned text (used only to choose between repeats)
 */
export function anchorQuoteToRaw(raw: string, quote: string, hint: number): AnchoredQuote | null {
  if (quote.length === 0) return null;

  const exact: number[] = [];
  for (let at = raw.indexOf(quote); at !== -1 && exact.length < MAX_CANDIDATES; at = raw.indexOf(quote, at + 1)) {
    exact.push(at);
  }
  if (exact.length > 0) {
    const start = closest(exact, hint);
    return { quote, start, end: start + quote.length };
  }

  const first = quote[0]!;
  const spans: Array<{ start: number; end: number }> = [];
  let evaluated = 0;
  for (let i = 0; i < raw.length && evaluated < MAX_CANDIDATES; i += 1) {
    const ch = raw[i]!;
    if (ch !== first && ch !== "&") continue;
    evaluated += 1;
    const end = scanFrom(raw, quote, i);
    if (end !== -1) spans.push({ start: i, end });
  }
  if (spans.length === 0) return null;
  const startIndex = closest(spans.map((s) => s.start), hint);
  const span = spans.find((s) => s.start === startIndex)!;
  if (span.end - span.start > MAX_ANCHORED_QUOTE_CHARS) return null;
  return { quote: raw.slice(span.start, span.end), start: span.start, end: span.end };
}
