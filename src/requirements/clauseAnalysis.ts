/**
 * Clause-level boundary, polarity, and importance analysis.
 * Provides unified, deterministic extraction and gating logic for job descriptions.
 */

export interface ClauseInfo {
  clauseText: string;
  clausePrefix: string;
  clauseSuffix: string;
  startOffset: number;
  endOffset: number;
}

export interface MatchSpan {
  quote_text: string;
  quote_start_offset: number;
  quote_end_offset: number;
}

/**
 * Finds the enclosing sentence, bullet point, or delimited clause around a match span.
 */
export function findEnclosingClause(
  text: string,
  matchStart: number,
  matchEnd: number
): ClauseInfo {
  const safeStart = Math.max(0, Math.min(matchStart, text.length));
  const safeEnd = Math.max(safeStart, Math.min(matchEnd, text.length));

  // Scan backwards for sentence/bullet start
  let startOffset = safeStart;
  while (startOffset > 0) {
    const prevChar = text[startOffset - 1];
    if (prevChar === '\n' || prevChar === '\r' || prevChar === '•' || prevChar === '\t') {
      break;
    }
    if (
      (prevChar === '.' || prevChar === '!' || prevChar === '?' || prevChar === ';') &&
      startOffset < safeStart &&
      /\s/.test(text[startOffset] || '')
    ) {
      break;
    }
    startOffset--;
  }

  // Scan forwards for sentence/bullet end
  let endOffset = safeEnd;
  while (endOffset < text.length) {
    const char = text[endOffset];
    if (char === '\n' || char === '\r' || char === '•') {
      break;
    }
    if (
      (char === '.' || char === '!' || char === '?' || char === ';') &&
      (endOffset + 1 >= text.length || /\s/.test(text[endOffset + 1]))
    ) {
      endOffset++; // Include punctuation
      break;
    }
    endOffset++;
  }

  const clauseText = text.slice(startOffset, endOffset).trim();
  const clausePrefix = text.slice(startOffset, safeStart);
  const clauseSuffix = text.slice(safeEnd, endOffset);

  return {
    clauseText,
    clausePrefix,
    clauseSuffix,
    startOffset,
    endOffset,
  };
}

/**
 * Negation prefixes within the same clause (supports 0-4 intervening modifier words).
 * Note: 'support an' is explicitly affirmative and NOT a negator.
 */
const CLAUSE_NEGATION_PREFIX_REGEX = /(?:^|[\s,;:(])(?:no|not|never|without|zero|0|free\s+of|neither|nor|doesn't|does\s+not|don't|do\s+not|won't|will\s+not|isn't|is\s+not|aren't|are\s+not|no\s+requirement\s+for)(?:\s+[\w'-]+){0,4}\s*$/i;

/**
 * Negation suffixes within the same clause.
 */
const CLAUSE_NEGATION_SUFFIX_REGEX = /^\s*(?:is|are|will\s+be)?\s*(?:not\s+required|optional|not\s+expected|not\s+needed|not\s+mandatory|not\s+a\s+requirement|not\s+necessary|none|0%|zero)\b/i;

/**
 * Checks whether an occurrence at the specified offsets is negated within its enclosing clause.
 */
export function isOccurrenceNegated(
  text: string,
  matchStart: number,
  matchLengthOrEnd: number
): boolean {
  const matchEnd = matchLengthOrEnd > matchStart ? matchLengthOrEnd : matchStart + matchLengthOrEnd;
  const clause = findEnclosingClause(text, matchStart, matchEnd);

  if (CLAUSE_NEGATION_PREFIX_REGEX.test(clause.clausePrefix)) {
    return true;
  }
  if (CLAUSE_NEGATION_SUFFIX_REGEX.test(clause.clauseSuffix)) {
    return true;
  }
  return false;
}

const PREFERENCE_REGEX = /\b(preferred|preference|preferable|nice\s+to\s+have|bonus|plus|optional|desired|desirable|advantageous)\b/i;
const NICE_TO_HAVE_REGEX = /\b(nice\s+to\s+have|bonus|optional)\b/i;
const MANDATORY_OVERRIDE_REGEX = /\b(required|mandatory|must\s+have|essential|strictly\s+required)\b/i;
const QUALIFICATION_HEADING_REGEX = /^\s*(required|minimum|basic|preferred|nice\s+to\s+have|bonus|optional|desired)\b[^\n:]{0,80}:?\s*$/i;

const SUBCLAUSE_BOUNDARY_REGEX = /(?:;\s*|\(\s*|\)\s*|,\s*(?:but|however|although|whereas|while|yet|though|except|and|or)\s+|\b(?:but|however|although|whereas|while|yet|though|except)\s+)/gi;

/**
 * Finds the enclosing subclause delimited by conjunctions, semicolons, or parentheses
 * within a sentence/bullet.
 */
export function findEnclosingSubclause(
  text: string,
  matchStart: number,
  matchEnd: number
): ClauseInfo {
  const clause = findEnclosingClause(text, matchStart, matchEnd);
  const safeStart = Math.max(clause.startOffset, Math.min(matchStart, clause.endOffset));
  const safeEnd = Math.max(safeStart, Math.min(matchEnd, clause.endOffset));

  let subclauseStart = clause.startOffset;
  let subclauseEnd = clause.endOffset;

  // Scan backwards from safeStart within clause
  const prefixText = text.slice(clause.startOffset, safeStart);
  const prefixMatches = [...prefixText.matchAll(SUBCLAUSE_BOUNDARY_REGEX)];
  if (prefixMatches.length > 0) {
    const lastMatch = prefixMatches[prefixMatches.length - 1];
    subclauseStart = clause.startOffset + (lastMatch.index ?? 0) + lastMatch[0].length;
  }

  // Scan forwards from safeEnd within clause
  const suffixText = text.slice(safeEnd, clause.endOffset);
  const suffixMatches = [...suffixText.matchAll(SUBCLAUSE_BOUNDARY_REGEX)];
  if (suffixMatches.length > 0) {
    const firstMatch = suffixMatches[0];
    if (firstMatch.index !== undefined) {
      subclauseEnd = safeEnd + firstMatch.index;
    }
  }

  const clauseText = text.slice(subclauseStart, subclauseEnd).trim();
  const clausePrefix = text.slice(subclauseStart, safeStart);
  const clauseSuffix = text.slice(safeEnd, subclauseEnd);

  return {
    clauseText,
    clausePrefix,
    clauseSuffix,
    startOffset: subclauseStart,
    endOffset: subclauseEnd,
  };
}

function importanceFromHeading(text: string, matchStart: number): 'MUST' | 'PREFERRED' | 'NICE_TO_HAVE' | null {
  const precedingLines = text.slice(0, matchStart).split(/\r?\n/).slice(-13, -1);
  let blankLines = 0;
  for (let index = precedingLines.length - 1; index >= 0; index -= 1) {
    const line = precedingLines[index].replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim();
    if (!line) {
      blankLines += 1;
      if (blankLines > 1) return null;
      continue;
    }
    if (QUALIFICATION_HEADING_REGEX.test(line)) {
      const normalized = line.toLowerCase();
      if (/\b(nice\s+to\s+have|bonus|optional)\b/.test(normalized)) return 'NICE_TO_HAVE';
      if (/\b(preferred|desired)\b/.test(normalized)) return 'PREFERRED';
      if (/\b(required|minimum|basic)\b/.test(normalized)) return 'MUST';
      return null;
    }
    if (/^[^.!?]{1,100}:$/.test(line) || /^\s*(?:[-*•]|\d+[.)])\s*/.test(precedingLines[index])) {
      continue;
    }
    return null;
  }
  return null;
}

/** Infers importance from the requirement clause and its nearest qualification heading. */
export function inferClauseImportance(
  text: string,
  matchStart: number,
  matchEnd: number,
): 'MUST' | 'PREFERRED' | 'NICE_TO_HAVE' {
  const subclause = findEnclosingSubclause(text, matchStart, matchEnd);
  const subclauseLower = subclause.clauseText.toLowerCase();
  const directPreferenceIndex = subclauseLower.search(PREFERENCE_REGEX);
  const directMandatoryIndex = subclauseLower.search(MANDATORY_OVERRIDE_REGEX);
  const matchOffset = Math.max(0, matchStart - subclause.startOffset);

  if (directPreferenceIndex >= 0 && directPreferenceIndex <= matchOffset) {
    if (NICE_TO_HAVE_REGEX.test(subclauseLower.slice(0, matchOffset + 1))) return 'NICE_TO_HAVE';
    return 'PREFERRED';
  }
  if (directMandatoryIndex >= 0 && directMandatoryIndex <= matchOffset) return 'MUST';

  const headingImportance = importanceFromHeading(text, matchStart);
  if (headingImportance) return headingImportance;

  if (directPreferenceIndex >= 0) {
    if (NICE_TO_HAVE_REGEX.test(subclauseLower)) return 'NICE_TO_HAVE';
    return 'PREFERRED';
  }
  if (MANDATORY_OVERRIDE_REGEX.test(subclauseLower)) return 'MUST';
  return 'MUST';
}

/**
 * Finds all non-overlapping matches for a set of regex patterns, respecting clause negation.
 */
export function findAllMatches(
  text: string,
  patterns: RegExp[]
): MatchSpan[] {
  const matches: MatchSpan[] = [];
  for (const pattern of patterns) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    const regex = new RegExp(pattern.source, flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      if (match[0].length === 0) {
        regex.lastIndex++;
        continue;
      }
      matches.push({
        quote_text: match[0],
        quote_start_offset: match.index,
        quote_end_offset: match.index + match[0].length,
      });
    }
  }
  return matches.sort((a, b) => a.quote_start_offset - b.quote_start_offset);
}

/**
 * Finds the first non-negated match across a set of regex patterns.
 */
export function findFirstNonNegatedMatch(
  text: string,
  patterns: RegExp[]
): MatchSpan | null {
  const allMatches = findAllMatches(text, patterns);
  for (const match of allMatches) {
    if (!isOccurrenceNegated(text, match.quote_start_offset, match.quote_end_offset)) {
      return match;
    }
  }
  return null;
}
