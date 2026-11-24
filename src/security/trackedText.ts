/**
 * A string that remembers where every character came from.
 *
 * Cleaning edits posting text (drops tags, decodes entities, collapses blanks).
 * A quote found in the cleaned text must still point at the stored raw text, so
 * each UTF-16 code unit of the cleaned text carries the half-open span
 * [start, end) of raw code units it came from. Offsets are UTF-16 code units
 * throughout, the same unit as `String.prototype.slice` and the stored
 * `quote_start_offset` / `quote_end_offset`.
 *
 * A unit that stands for a dropped script, style or comment block is marked
 * `hidden`: text a reader never saw must not be shown as the quote.
 *
 * Pure and linear in the text length.
 */

export interface TrackedText {
  readonly text: string;
  /** Per code unit of `text`: first raw code unit it came from. */
  readonly start: Int32Array;
  /** Per code unit of `text`: one past the last raw code unit it came from. */
  readonly end: Int32Array;
  /** Per code unit of `text`: 1 when it stands for a dropped block. */
  readonly hidden: Uint8Array;
}

export function trackedFrom(text: string): TrackedText {
  const start = new Int32Array(text.length);
  const end = new Int32Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    start[i] = i;
    end[i] = i + 1;
  }
  return { text, start, end, hidden: new Uint8Array(text.length) };
}

export class TrackedBuilder {
  private readonly parts: string[] = [];
  private readonly starts: number[] = [];
  private readonly ends: number[] = [];
  private readonly hiddens: number[] = [];

  /** Copies code units [from, to) of `source`, keeping their origin. */
  copy(source: TrackedText, from: number, to: number): void {
    if (to <= from) return;
    this.parts.push(source.text.slice(from, to));
    for (let i = from; i < to; i += 1) {
      this.starts.push(source.start[i]!);
      this.ends.push(source.end[i]!);
      this.hiddens.push(source.hidden[i]!);
    }
  }

  /** Adds new text whose every unit came from raw span [start, end). */
  put(text: string, start: number, end: number, hidden: boolean): void {
    if (text.length === 0) return;
    this.parts.push(text);
    for (let i = 0; i < text.length; i += 1) {
      this.starts.push(start);
      this.ends.push(end);
      this.hiddens.push(hidden ? 1 : 0);
    }
  }

  build(): TrackedText {
    return {
      text: this.parts.join(""),
      start: Int32Array.from(this.starts),
      end: Int32Array.from(this.ends),
      hidden: Uint8Array.from(this.hiddens),
    };
  }
}

function anyHidden(source: TrackedText, from: number, to: number): boolean {
  for (let i = from; i < to; i += 1) if (source.hidden[i]) return true;
  return false;
}

/**
 * Replaces every match of `pattern` (global) with `replace(match)`. Returning
 * null keeps the matched text as it is. Each replacement unit takes the raw span
 * of the whole matched text. An empty replacement removes the match.
 */
export function replaceTracked(
  source: TrackedText,
  pattern: RegExp,
  replace: (match: RegExpExecArray) => string | null,
): TrackedText {
  const builder = new TrackedBuilder();
  const { text } = source;
  pattern.lastIndex = 0;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const length = match[0].length;
    if (length === 0) {
      pattern.lastIndex += 1;
      continue;
    }
    const replacement = replace(match);
    if (replacement === null) continue;
    builder.copy(source, last, match.index);
    builder.put(
      replacement,
      source.start[match.index]!,
      source.end[match.index + length - 1]!,
      anyHidden(source, match.index, match.index + length),
    );
    last = match.index + length;
  }
  builder.copy(source, last, text.length);
  return builder.build();
}

/** Removes leading and trailing whitespace. */
export function trimTracked(source: TrackedText): TrackedText {
  const { text } = source;
  let from = 0;
  let to = text.length;
  while (from < to && /\s/.test(text[from]!)) from += 1;
  while (to > from && /\s/.test(text[to - 1]!)) to -= 1;
  if (from === 0 && to === text.length) return source;
  return {
    text: text.slice(from, to),
    start: source.start.slice(from, to),
    end: source.end.slice(from, to),
    hidden: source.hidden.slice(from, to),
  };
}

export interface RawSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * The raw span behind cleaned code units [from, to), or null when the range is
 * empty or out of bounds, or when any unit stands for a dropped block.
 */
export function rawSpanOf(source: TrackedText, from: number, to: number): RawSpan | null {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > source.text.length || to <= from) return null;
  if (anyHidden(source, from, to)) return null;
  let start = source.start[from]!;
  let end = source.end[to - 1]!;
  for (let i = from; i < to; i += 1) {
    if (source.start[i]! < start) start = source.start[i]!;
    if (source.end[i]! > end) end = source.end[i]!;
  }
  return end > start ? { start, end } : null;
}
