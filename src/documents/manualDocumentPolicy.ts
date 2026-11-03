/**
 * Rules for what manual application documents may contain: which job requirements are worth
 * matching against, and which profile statements are internal notes that must never be shown.
 */

/** A requirement row as stored, with what the manual route needs to choose document requirements. */
export interface StoredRequirementRow {
  requirement_key: string;
  requirement_type: string;
  importance: string;
  requirement_text: string;
  extractor_type: string;
  quote_text: string | null;
}

export interface DocumentRequirement {
  requirement_key: string;
  requirement_type: string;
  importance: string;
  requirement_text: string;
}

export const MAX_POSTING_REQUIREMENT_LINES = 30;
const MIN_POSTING_LINE_CHARS = 15;
const MAX_POSTING_LINE_CHARS = 300;

const REQUIREMENT_HEADING = /^(requirements?|qualifications?|minimum qualifications|basic qualifications|preferred qualifications|what you(?:'|’)ll bring|what you bring|what we(?:'|’)re looking for|what we are looking for|who you are|about you|you have|you will have|(?:your )?background|your (?:experience|profile|skills)|(?:the )?ideal candidate|skills(?: and experience)?|experience|must[- ]haves?|nice[- ]to[- ]haves?)\b/i;
const RESPONSIBILITY_HEADING = /^(responsibilities|key responsibilities|your responsibilities|(?:key )?accountabilities|what you(?:'|’)ll do|what you will do|what you(?:'|’)ll be doing|the role|your role|your mission|role overview|duties|day[- ]to[- ]day|in this role)\b/i;
// Checked after the requirement heading, so "About you" still opens requirements.
const OTHER_HEADING = /^(about|why|benefits|what we offer|our offer|perks|package|compensation|salary|location|how to apply|equal opportunity|our (?:culture|values|team)|the opportunity|life at|who we are|diversity)\b/i;
const PREFERRED_CUE = /\b(preferred|nice[- ]to[- ]have|a (?:strong |big |definite |real |significant )?(?:plus|bonus)|desirable|advantageous|ideally)\b/i;
// Sentences in an unstructured posting that state a requirement, or a duty of the role.
const PROSE_REQUIREMENT_CUE = /\b(\d+\+?\s+years|experience (?:in|with|of|across)|knowledge of|proficien\w*|familiar\w* with|degree in|you (?:have|bring)|must have|required)\b/i;
const PROSE_RESPONSIBILITY_CUE = /\b(you will|you'll|responsible for|your role)\b/i;

/**
 * Requirements the documents may match against. AI-quoted requirements are the job's own words, so
 * they come first. The model may quote only a few of the posting's bullets, so every requirement or
 * responsibility line no quote covers is added too, in the posting's words. Deterministic rows carry
 * fixed labels ("Role specifies an employment type.") meant for gating, not for documents, so they
 * are never used here.
 */
export function documentRequirements(rows: StoredRequirementRow[], descriptionText: string | null): DocumentRequirement[] {
  const posting = postingRequirementLines(descriptionText ?? "");
  const quoted = rows.filter((row) => row.extractor_type === "LLM_QUOTED");
  if (quoted.length === 0) return posting;
  const quotes = quoted.map((row) => comparableText(row.quote_text ?? row.requirement_text)).filter((quote) => quote.length > 0);
  const uncovered = posting.filter((line) => {
    const text = comparableText(line.requirement_text);
    return !quotes.some((quote) => text.includes(quote) || quote.includes(text));
  });
  return [
    ...quoted.map(({ requirement_key, requirement_type, importance, requirement_text }) =>
      ({ requirement_key, requirement_type, importance, requirement_text })),
    ...uncovered,
  ];
}

function comparableText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * Lines under the posting's responsibility and requirement headings, in the posting's own words.
 * Text copied from job sites often loses its line breaks and keeps runs of spaces instead, so those
 * runs also separate lines. A posting with no recognised headings falls back to its sentences that
 * state a requirement or a duty.
 */
export function postingRequirementLines(descriptionText: string): DocumentRequirement[] {
  const lines: Array<{ text: string; section: "REQUIREMENT" | "RESPONSIBILITY" }> = [];
  let section: "REQUIREMENT" | "RESPONSIBILITY" | null = null;
  for (const rawLine of descriptionText.split(/\r?\n|[ \t ]{3,}/)) {
    const line = rawLine.replace(/^[\s\-–—*•·●▪◦>]+|^\d+[.)]\s+/u, "").trim();
    if (!line) continue;
    const heading = /^([^:]{2,60}):\s*(.*)$/.exec(line);
    const headingText = (heading ? heading[1] : line).trim();
    const isHeadingOnly = !heading && line.length <= 60 && !/[.;]$/.test(line);
    if (REQUIREMENT_HEADING.test(headingText) && (heading || isHeadingOnly)) {
      section = "REQUIREMENT";
      if (isHeadingOnly) continue;
    } else if (RESPONSIBILITY_HEADING.test(headingText) && (heading || isHeadingOnly)) {
      section = "RESPONSIBILITY";
      if (isHeadingOnly) continue;
    } else if (OTHER_HEADING.test(headingText) && (heading || isHeadingOnly)) {
      section = null;
      continue;
    } else if (isHeadingOnly && /^[A-Z][^.]*$/.test(line) && line.split(/\s+/).length <= 6) {
      // An unrecognised short heading inside a section is a sub-heading ("Stakeholder Management");
      // sections end only at a recognised heading.
      continue;
    }
    if (!section) continue;
    const content = heading && (REQUIREMENT_HEADING.test(headingText) || RESPONSIBILITY_HEADING.test(headingText)) ? heading[2].trim() : line;
    if (content.length < MIN_POSTING_LINE_CHARS || content.length > MAX_POSTING_LINE_CHARS) continue;
    lines.push({ text: content, section });
  }
  if (lines.length === 0) lines.push(...proseRequirementSentences(descriptionText));
  const unique = lines.filter((line, index) => lines.findIndex((other) => other.text === line.text) === index);
  // Requirements first, then responsibilities, each in posting order.
  const ordered = [...unique.filter((line) => line.section === "REQUIREMENT"), ...unique.filter((line) => line.section === "RESPONSIBILITY")]
    .slice(0, MAX_POSTING_REQUIREMENT_LINES);
  return ordered.map((line, index) => ({
    requirement_key: `P-${String(index + 1).padStart(3, "0")}`,
    requirement_type: line.section === "REQUIREMENT" ? "POSTING_REQUIREMENT" : "POSTING_RESPONSIBILITY",
    importance: PREFERRED_CUE.test(line.text) || line.section === "RESPONSIBILITY" ? "PREFERRED" : "MUST",
    requirement_text: line.text,
  }));
}

function proseRequirementSentences(descriptionText: string): Array<{ text: string; section: "REQUIREMENT" | "RESPONSIBILITY" }> {
  return descriptionText.replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= MIN_POSTING_LINE_CHARS && sentence.length <= MAX_POSTING_LINE_CHARS)
    .flatMap((text): Array<{ text: string; section: "REQUIREMENT" | "RESPONSIBILITY" }> =>
      PROSE_REQUIREMENT_CUE.test(text) ? [{ text, section: "REQUIREMENT" }]
        : PROSE_RESPONSIBILITY_CUE.test(text) ? [{ text, section: "RESPONSIBILITY" }] : []);
}

const INTERNAL_ASSESSMENT = /self[- ]?rat(?:ing|ed)|self[- ]?assess|\b\d(?:\.\d)?\s*\/\s*5\b|\bnot a target\b|career[- ]preference|preference note|application[- ]screening purposes/i;

/** Internal self-assessments, preference and screening notes: used for matching jobs, never shown in documents. */
export function isInternalAssessmentStatement(statement: string): boolean {
  return INTERNAL_ASSESSMENT.test(statement);
}

// Self-descriptions: an evaluative opening ("Strong ... capability", "Expert in", "Conceptual and
// developing ... knowledge") or a statement of intent ("actively pursuing"). They describe the
// person rather than work done, so documents never print them.
const SELF_DESCRIPTION = /^(?:proven\s+|exceptionally\s+|very\s+)?(?:strong|advanced|deep|solid|conceptual|foundational|developing|basic|working|expert|proficient|good|excellent|emerging|growing)\b|\bactively pursuing\b|\bconceptual and developing\b/i;

/** A statement that rates or describes the candidate instead of recording work done. */
export function isSelfDescriptionStatement(statement: string): boolean {
  return SELF_DESCRIPTION.test(statement.trim());
}

const FORBIDDEN_DOCUMENT_TEXT = /self[- ]?rating|\b\d(?:\.\d)?\s*\/\s*5\b|not a target|conceptual and developing|actively pursuing/i;

/** Last check before rendering: no internal assessment text may reach an application document. */
export function assertNoInternalAssessmentText(documentName: string, text: string): void {
  const match = FORBIDDEN_DOCUMENT_TEXT.exec(text);
  if (match) {
    throw new Error(`${documentName} contains internal assessment text ("${match[0]}"); document generation is blocked.`);
  }
}
