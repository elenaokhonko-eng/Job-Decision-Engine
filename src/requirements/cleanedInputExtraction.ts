/**
 * Runs the deterministic extractor on cleaned posting text, then ties every
 * stored quote back to the stored raw text.
 *
 * The rules read cleaned text so markup (real or escaped) cannot leak into a
 * requirement. Evidence must still be checkable: `quote_text` has to be a
 * substring of `job_versions.description_text` and `quote_start_offset` /
 * `quote_end_offset` have to index that same text, in UTF-16 code units.
 *
 * The cleaner records, for every character it keeps, the raw span it came from
 * (src/security/trackedText.ts). A quote found at cleaned offsets [s, e) is
 * therefore stored as exactly `raw.slice(rawStart, rawEnd)`: no search, no
 * guessing, and the right occurrence when a phrase repeats. The raw span can
 * contain markup; the clean wording stays in `requirement_text`, and
 * {@link readableQuote} gives the cleaned wording of a stored quote to code that
 * reads it with regular expressions. A quote that cannot be tied to the raw text
 * (it spans a dropped script, style or comment block, or the extractor's offsets
 * do not match its text) is stored as absent, never as text that is not in the
 * posting.
 *
 * Copies of a quote inside `structured_value` (for example `degree_reference`)
 * are the cleaned strings, not raw spans: they are descriptive values, not
 * evidence.
 *
 * This wraps the extractor; it does not change any extractor rule.
 */
import { cleanPostingText, cleanPostingTextWithOffsets, type PostingCleaningReport } from "../security/postingText.js";
import { rawSpanOf } from "../security/trackedText.js";
import {
  extractDeterministicRequirements,
  type DeterministicExtractorInput,
  type DeterministicExtractorResult,
} from "./deterministicExtractors.js";

const MIN_QUOTE_CHARS = 5;
const MAX_QUOTE_CHARS = 4000;

export interface QuoteAnchoringCounts {
  /** Quotes that were already identical to their raw span. */
  readonly verbatim: number;
  /** Quotes replaced by the raw span they came from (it differs from the cleaned wording). */
  readonly remapped: number;
  /** Quotes stored as absent because they cannot be tied to the raw text. */
  readonly dropped: number;
}

export type PostingExtractionResult = DeterministicExtractorResult & {
  readonly quoteAnchoring: QuoteAnchoringCounts;
  /** What the cleaner did to this posting. Counts only. */
  readonly cleaning: PostingCleaningReport;
};

/** The cleaned wording of a stored quote: what the rules saw. Pure; use before matching it with a regular expression. */
export function readableQuote(quote: string | null | undefined): string {
  return quote ? cleanPostingText(quote).text : "";
}

/** Offset of `quote` in `cleaned` when the extractor's own offsets do not match its text (nearest to `hint`). */
function locateInCleaned(cleaned: string, quote: string, hint: number): number {
  let best = -1;
  for (let at = cleaned.indexOf(quote), seen = 0; at !== -1 && seen < 1000; at = cleaned.indexOf(quote, at + 1), seen += 1) {
    if (best === -1 || Math.abs(at - hint) < Math.abs(best - hint)) best = at;
  }
  return best;
}

export function extractDeterministicRequirementsFromPosting(
  input: DeterministicExtractorInput,
): PostingExtractionResult {
  const raw = input.description_text;
  const cleaning = cleanPostingTextWithOffsets(raw);
  const cleaned = cleaning.text;
  const result = extractDeterministicRequirements({ ...input, description_text: cleaned });

  let verbatim = 0;
  let remapped = 0;
  let dropped = 0;
  const requirements = result.requirements.map((requirement) => {
    const quote = requirement.quote_text;
    if (quote === null || quote === undefined) return requirement;

    let start = requirement.quote_start_offset ?? -1;
    let end = requirement.quote_end_offset ?? -1;
    if (start < 0 || end <= start || cleaned.slice(start, end) !== quote) {
      start = locateInCleaned(cleaned, quote, Math.max(0, start));
      end = start === -1 ? -1 : start + quote.length;
    }
    const span = start === -1 ? null : rawSpanOf(cleaning.origin, start, end);
    const rawQuote = span ? raw.slice(span.start, span.end) : "";
    if (!span || rawQuote.length < MIN_QUOTE_CHARS || rawQuote.length > MAX_QUOTE_CHARS) {
      dropped += 1;
      return { ...requirement, quote_text: null, quote_start_offset: null, quote_end_offset: null };
    }
    if (rawQuote === quote) verbatim += 1;
    else remapped += 1;
    return { ...requirement, quote_text: rawQuote, quote_start_offset: span.start, quote_end_offset: span.end };
  });

  const warnings = cleaning.report.truncatedChars > 0
    ? [...result.warnings, `POSTING_TRUNCATED: ${cleaning.report.truncatedChars} characters after the first ${cleaning.report.inputLength - cleaning.report.truncatedChars} were not read.`]
    : result.warnings;
  return { ...result, requirements, warnings, quoteAnchoring: { verbatim, remapped, dropped }, cleaning: cleaning.report };
}
