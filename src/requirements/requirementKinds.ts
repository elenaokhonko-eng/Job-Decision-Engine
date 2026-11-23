/**
 * Requirement kinds shared by the extractor and the matcher.
 *
 * Kept free of database and provider imports so both sides can use it without
 * a cycle.
 */

/** Workability requirements are decided by the hard gates, not scored as capability. */
export const NON_CAPABILITY_REQUIREMENT_TYPES: ReadonlySet<string> = new Set([
  'OFFICE_DAYS',
  'WORK_MODE',
  'EMPLOYMENT_TYPE',
  'TRAVEL',
  'WORK_AUTH',
  'ON_CALL',
  'SHIFT_WORK',
]);

export function isCapabilityRequirementType(requirementType: string): boolean {
  return !NON_CAPABILITY_REQUIREMENT_TYPES.has(requirementType);
}

/**
 * Fewer confirmed capability requirements than this means the description is too
 * thin to judge. The job is marked "needs description"; it is never a "no match".
 */
export const MIN_CONFIRMED_REQUIREMENTS = 3;

/** Below this many posting items the quoted (AI) extractor may be asked to help. */
export const AI_FALLBACK_BELOW_ITEMS = 5;

/** Marks a requirement taken from a posting bullet (extractor `deterministic_v4` and later). */
export const POSTING_ITEM_EXTRACTION = 'POSTING_ITEM_V1';

interface OwnTextInput {
  requirement_type: string;
  requirement_text: string;
  quote_text: string | null;
  structured_value: unknown;
}

function isPostingItem(structured: unknown): boolean {
  return (
    typeof structured === 'object' &&
    structured !== null &&
    (structured as Record<string, unknown>).extraction === POSTING_ITEM_EXTRACTION
  );
}

/**
 * The text that stands for a requirement when it is compared with profile facts.
 *
 * A requirement taken from a posting item is its own exact sentence: no type
 * label, no template sentence, no repeated quote and no structured JSON. Older
 * requirements keep the previous composition so existing data is unchanged.
 */
export function requirementOwnText(row: OwnTextInput): string | null {
  if (!isPostingItem(row.structured_value)) return null;
  return row.requirement_text.trim();
}

/**
 * Whether the rules came up short and the quoted (AI) extractor may be asked to help.
 *
 * Rules decide first: years, degrees, credentials and every posting item come from rules, and
 * the AI never sets a score. The AI is asked only when the rules found fewer than
 * AI_FALLBACK_BELOW_ITEMS items in the posting.
 */
export function shouldRequestAiFallback(input: { postingItemCount: number }): boolean {
  return input.postingItemCount < AI_FALLBACK_BELOW_ITEMS;
}
