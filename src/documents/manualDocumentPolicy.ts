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
const MAX_HEADING_WORDS = 8;

const REQUIREMENT_HEADING = /^(requirements?|qualifications?|minimum qualifications|basic qualifications|preferred qualifications|what you(?:'|’)ll bring|what you will bring|what you bring|what we(?:'|’)re looking for|what we are looking for|who you are|about you|you have|you will have|(?:your )?background|your (?:experience|profile|skills)|(?:the )?ideal candidate|skills(?: and experience)?|experience|must[- ]haves?|nice[- ]to[- ]haves?)\b/i;
const RESPONSIBILITY_HEADING = /^(responsibilities|key responsibilities|your responsibilities|(?:key )?accountabilities|what you(?:'|’)ll do|what you will do|what you(?:'|’)ll be doing|the role|your role|your mission|role overview|duties|day[- ]to[- ]day|in this role)\b/i;
// Checked after the requirement heading, so "About you" still opens requirements.
const OTHER_HEADING = /^(about|why|benefits|what we offer|our offer|perks|package|compensation|salary|location|how to apply|equal opportunity|our (?:culture|values|team)|the opportunity|life at|who we are|diversity)\b/i;
const PREFERRED_CUE = /\b(preferred|nice[- ]to[- ]have|a (?:strong |big |definite |real |significant )?(?:plus|bonus)|desirable|advantageous|ideally|preferably)\b/i;
// "..., ideally Unity Catalog" or "(preferably Python)": the qualifier softens only its own clause.
const TRAILING_QUALIFIER = /\s*(?:[,;:(]|\s[–—-])\s*(?:and\s+)?(?:ideally|preferably)\b[^;)]*\)?/gi;
const MIN_QUALIFIED_REQUIREMENT_WORDS = 3;
// Where and how the work happens, not what the candidate has done: location, permits, language
// fluency and travel belong to the workability checks and are never paired with achievements.
const WORKABILITY_REQUIREMENT = [
  /\b(?:based|located|living|residing) (?:in|at|near)\b/i,
  /\brelocat\w*|\bcommut\w*|\bon[- ]?site (?:in|at)\b|\bin[- ]office\b/i,
  /\bright to work\b|\bwork(?:ing)? (?:permit|visa|authori[sz]ation|rights)\b|\bvisa sponsorship\b|\beligib\w* to work\b|\bcitizen\w*\b|\bpermanent resident\w*\b|\bsecurity clearance\b/i,
  /\bwilling(?:ness)? to travel\b|\btravel (?:up to|is required|required|of up)\b|\b\d{1,2}\s*%\s*(?:of\s+)?travel\b/i,
  /\b(?:fluen(?:t|cy)|native|business[- ]level|proficien\w*|written and (?:spoken|verbal)|spoken and written)\b[^.;]{0,40}\b(?:english|german|french|mandarin|chinese|cantonese|japanese|korean|spanish|italian|dutch|portuguese|russian|arabic|hindi|malay|bahasa|thai|vietnamese|languages?)\b/i,
  /\b(?:english|german|french|mandarin|chinese|cantonese|japanese|korean|spanish|italian|dutch|portuguese|russian|arabic)\b[^.;]{0,20}\b(?:fluen(?:t|cy)|native|proficien\w*|language skills)\b/i,
];

/** Location, work-permit, language-fluency and travel lines: workability facts, not matchable skills. */
export function isWorkabilityRequirement(text: string): boolean {
  return WORKABILITY_REQUIREMENT.some((pattern) => pattern.test(text));
}

/**
 * MUST unless the line itself is optional ("X is a plus", "Nice to have: X"). A trailing "ideally
 * Y" or "(preferably Y)" makes only Y optional, so a substantive requirement before it stays MUST.
 */
export function postingImportance(text: string): "MUST" | "PREFERRED" {
  if (!PREFERRED_CUE.test(text)) return "MUST";
  const core = text.replace(TRAILING_QUALIFIER, " ").trim();
  const coreWords = core.split(/\s+/).filter((word) => /\p{L}/u.test(word)).length;
  return coreWords >= MIN_QUALIFIED_REQUIREMENT_WORDS && !PREFERRED_CUE.test(core) ? "MUST" : "PREFERRED";
}
// Sentences in an unstructured posting that state a requirement, or a duty of the role.
const PROSE_REQUIREMENT_CUE = /\b(\d+\+?\s+years|experience (?:in|with|of|across)|knowledge of|proficien\w*|familiar\w* with|degree in|you (?:have|bring)|must have|required)\b/i;
const PROSE_RESPONSIBILITY_CUE = /\b(you will|you'll|responsible for|your role)\b/i;

/**
 * Requirements the documents may match against. AI-quoted requirements are the job's own words, so
 * they come first. The model may quote only a few of the posting's bullets, so every requirement or
 * responsibility line no quote covers is added too, in the posting's words. Deterministic rows carry
 * fixed labels ("Role specifies an employment type.") meant for gating, not for documents, so they
 * are never used here. Workability lines (location, permits, language, travel) are left out: the
 * gates judge them, and no achievement can evidence them.
 */
export function documentRequirements(rows: StoredRequirementRow[], descriptionText: string | null): DocumentRequirement[] {
  const posting = postingRequirementLines(descriptionText ?? "");
  const quoted = rows.filter((row) => row.extractor_type === "LLM_QUOTED");
  const quotes = quoted.map((row) => comparableText(row.quote_text ?? row.requirement_text)).filter((quote) => quote.length > 0);
  const uncovered = posting.filter((line) => {
    const text = comparableText(line.requirement_text);
    return !quotes.some((quote) => text.includes(quote) || quote.includes(text));
  });
  return [
    ...quoted.map(({ requirement_key, requirement_type, importance, requirement_text }) => ({
      requirement_key, requirement_type, requirement_text,
      // The extractor marks a whole line PREFERRED for a trailing "ideally ..." clause; only an
      // optional line as a whole is PREFERRED.
      importance: importance === "PREFERRED" && postingImportance(requirement_text) === "MUST" ? "MUST" : importance,
    })),
    ...uncovered,
  ].filter((requirement) => !isWorkabilityRequirement(requirement.requirement_text));
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
    // A bullet is content, so "- Experience with Kafka is a plus" is never the "Experience" heading.
    const bulleted = /^\s*(?:[\-–—*•·●▪◦>]|\d+[.)]\s)/u.test(rawLine);
    const heading = /^([^:]{2,60}):\s*(.*)$/.exec(line);
    const headingText = (heading ? heading[1] : line).trim();
    const isHeadingOnly = !heading && !bulleted && line.length <= 60 && line.split(/\s+/).length <= MAX_HEADING_WORDS && !/[.;]$/.test(line);
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
    importance: line.section === "RESPONSIBILITY" ? "PREFERRED" : postingImportance(line.text),
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

// Self-descriptions: an evaluative opening ("Strong ... capability", "Expert in", "Proven
// capability", "Conceptual and developing ... knowledge") or a statement of intent ("actively
// pursuing"). They describe the person rather than work done, so documents never print them.
const SELF_DESCRIPTION = /^(?:proven|capable|(?:(?:exceptionally|very|highly)\s+)?(?:strong|advanced|deep|solid|conceptual|foundational|developing|basic|working|expert|proficient|good|excellent|emerging|growing|skilled|seasoned|accomplished))\b|\b(?:proven|strong|demonstrated|deep) (?:capability|capabilities|ability|expertise|track record)\b|\bexpert (?:in|at)\b|\bactively pursuing\b|\bconceptual and developing\b/i;

/** A statement that rates or describes the candidate instead of recording work done. */
export function isSelfDescriptionStatement(statement: string): boolean {
  return SELF_DESCRIPTION.test(statement.trim());
}

/** A sentence anywhere in a written section that rates the candidate ("I am an expert in ..."). */
export function containsSelfDescription(text: string): boolean {
  return /\b(?:proven|strong|demonstrated) (?:capability|capabilities|ability)\b|\bexpert (?:in|at)\b|\bconceptual and developing\b/i.test(text);
}

const FORBIDDEN_DOCUMENT_TEXT = /self[- ]?rating|\b\d(?:\.\d)?\s*\/\s*5\b|not a target|conceptual and developing|actively pursuing|\bproven (?:capability|capabilities|ability)\b/i;

/** Last check before rendering: no internal assessment text may reach an application document. */
export function assertNoInternalAssessmentText(documentName: string, text: string): void {
  const match = FORBIDDEN_DOCUMENT_TEXT.exec(text);
  if (match) {
    throw new Error(`${documentName} contains internal assessment text ("${match[0]}"); document generation is blocked.`);
  }
}
