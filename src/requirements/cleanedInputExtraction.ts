/**
 * Runs the deterministic extractor on cleaned posting text, then ties every
 * stored quote back to the stored raw text.
 *
 * The rules read cleaned text so markup (real or escaped) cannot leak into a
 * requirement. Evidence must still be checkable: `quote_text` has to be a
 * substring of `job_versions.description_text` and `quote_start_offset` /
 * `quote_end_offset` have to index that same text. So each quote is re-anchored
 * to the raw span it came from (which may contain markup), and the clean wording
 * stays in `requirement_text`. A quote that cannot be anchored is stored as
 * absent (null), never as text that is not in the posting.
 *
 * This wraps the extractor; it does not change any extractor rule.
 */
import { anchorQuoteToRaw, MAX_ANCHORED_QUOTE_CHARS } from "../security/quoteAnchor.js";
import { cleanPostingText } from "../security/postingText.js";
import {
  extractDeterministicRequirements,
  type DeterministicExtractorInput,
  type DeterministicExtractorResult,
} from "./deterministicExtractors.js";

export interface QuoteAnchoringCounts {
  /** Quotes already a substring of the raw text (offsets re-based on it). */
  readonly verbatim: number;
  /** Quotes replaced by the raw span they came from. */
  readonly remapped: number;
  /** Quotes that could not be anchored and were stored as absent. */
  readonly dropped: number;
}

export type PostingExtractionResult = DeterministicExtractorResult & {
  readonly quoteAnchoring: QuoteAnchoringCounts;
};

export function extractDeterministicRequirementsFromPosting(
  input: DeterministicExtractorInput,
): PostingExtractionResult {
  const raw = input.description_text;
  const cleaned = cleanPostingText(raw).text;
  const result = extractDeterministicRequirements({ ...input, description_text: cleaned });

  let verbatim = 0;
  let remapped = 0;
  let dropped = 0;
  const requirements = result.requirements.map((requirement) => {
    const quote = requirement.quote_text;
    if (quote === null || quote === undefined) return requirement;
    const anchored = anchorQuoteToRaw(raw, quote, requirement.quote_start_offset ?? 0);
    if (!anchored || anchored.quote.length > MAX_ANCHORED_QUOTE_CHARS || anchored.quote.length < 5) {
      dropped += 1;
      return { ...requirement, quote_text: null, quote_start_offset: null, quote_end_offset: null };
    }
    if (anchored.quote === quote) verbatim += 1;
    else remapped += 1;
    return {
      ...requirement,
      quote_text: anchored.quote,
      quote_start_offset: anchored.start,
      quote_end_offset: anchored.end,
    };
  });

  return { ...result, requirements, quoteAnchoring: { verbatim, remapped, dropped } };
}
