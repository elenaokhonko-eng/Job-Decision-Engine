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

export const MAX_POSTING_REQUIREMENT_LINES = 14;
const MIN_POSTING_LINE_CHARS = 15;
const MAX_POSTING_LINE_CHARS = 300;

const REQUIREMENT_HEADING = /^(requirements?|qualifications?|minimum qualifications|basic qualifications|preferred qualifications|what you(?:'|’)ll bring|what we(?:'|’)re looking for|who you are|about you|you have|you will have|skills(?: and experience)?|experience|must[- ]haves?|nice[- ]to[- ]haves?)\b/i;
const RESPONSIBILITY_HEADING = /^(responsibilities|key responsibilities|what you(?:'|’)ll do|what you will do|the role|your role|role overview|duties|day[- ]to[- ]day|in this role)\b/i;
const OTHER_HEADING = /^(about (?:us|the company|the team)|benefits|what we offer|perks|compensation|salary|how to apply|equal opportunity|our culture|why join)\b/i;
const PREFERRED_CUE = /\b(preferred|nice[- ]to[- ]have|a plus|is a bonus|desirable|advantageous|ideally)\b/i;

/**
 * Requirements the documents may match against. AI-quoted requirements are the job's own words, so
 * they are used when present. Deterministic rows carry fixed labels ("Role specifies an employment
 * type.") meant for gating, not for documents, so without quoted rows the posting's own
 * responsibility and requirement lines are used instead.
 */
export function documentRequirements(rows: StoredRequirementRow[], descriptionText: string | null): DocumentRequirement[] {
  const quoted = rows.filter((row) => row.extractor_type === "LLM_QUOTED");
  if (quoted.length > 0) {
    return quoted.map(({ requirement_key, requirement_type, importance, requirement_text }) =>
      ({ requirement_key, requirement_type, importance, requirement_text }));
  }
  return postingRequirementLines(descriptionText ?? "");
}

/** Lines under the posting's responsibility and requirement headings, in the posting's own words. */
export function postingRequirementLines(descriptionText: string): DocumentRequirement[] {
  const lines: Array<{ text: string; section: "REQUIREMENT" | "RESPONSIBILITY" }> = [];
  let section: "REQUIREMENT" | "RESPONSIBILITY" | null = null;
  for (const rawLine of descriptionText.split(/\r?\n/)) {
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
      // An unrecognised short heading ends the current section.
      section = null;
      continue;
    }
    if (!section) continue;
    const content = heading && (REQUIREMENT_HEADING.test(headingText) || RESPONSIBILITY_HEADING.test(headingText)) ? heading[2].trim() : line;
    if (content.length < MIN_POSTING_LINE_CHARS || content.length > MAX_POSTING_LINE_CHARS) continue;
    lines.push({ text: content, section });
  }
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
