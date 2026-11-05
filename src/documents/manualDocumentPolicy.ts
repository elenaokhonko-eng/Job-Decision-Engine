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
// Question headings run longer: "What qualifications or skills should you possess in this role?"
const MAX_QUESTION_HEADING_WORDS = 14;

const REQUIREMENT_HEADING = /^(requirements?|qualifications?|minimum qualifications|basic qualifications|preferred qualifications|what you(?:'|’)ll bring|what you will bring|what you bring|what (?:will|can|do|should) you bring|what we(?:'|’)re looking for|what we are looking for|what (?:are we|we are) looking for|what (?:qualifications|skills|experience)\b|what (?:do )?you need|what you(?:'|’)ll need|what you will need|who you are|about you|you have|you will have|(?:your )?background|your (?:experience|profile|skills)|(?:the )?ideal candidate|skills(?: and experience)?|experience|must[- ]haves?|nice[- ]to[- ]haves?)\b/i;
const RESPONSIBILITY_HEADING = /^(responsibilities|key responsibilities|your responsibilities|(?:key )?accountabilities|what you(?:'|’)ll do|what you will do|what will you (?:do|be doing)|what you(?:'|’)ll be doing|what (?:does|will) the role (?:involve|entail)|the role|your role|your mission|role overview|duties|day[- ]to[- ]day|in this role)\b/i;
// Checked after the requirement heading, so "About you" still opens requirements.
const OTHER_HEADING = /^(about|why|benefits|what we offer|what (?:can|do) we offer|our offer|perks|package|compensation|salary|location|how to apply|equal opportunity|our (?:culture|values|team)|the opportunity|life at|who we are|who are we|diversity)\b/i;
// Lines that describe the team or the employer rather than ask anything of the candidate:
// "You will be part of a team of data scientists ...", "As the Center of Excellence for ...".
const NARRATIVE_LINE = /^(?:you(?:'|’)?ll be (?:part of|joining)|you will be (?:part of|joining)|you will join\b|as (?:the|part of|a member of)\b|we are\b|we(?:'|’)re\b|our (?:team|group|department|mission)\b|the (?:team|group|department)\b|join (?:us|our|a)\b|this (?:role|position) (?:is|sits|reports|will report)\b|reporting (?:to|into)\b)/i;
const PREFERRED_CUE = /\b(preferred|nice[- ]to[- ]have|a (?:strong |big |definite |real |significant )?(?:plus|bonus)|desirable|advantageous|ideally|preferably)\b/i;
// "..., ideally Unity Catalog" or "(preferably Python)": the qualifier softens only its own clause.
const TRAILING_QUALIFIER = /\s*(?:[,;:(]|\s[–—-])\s*(?:and\s+)?(?:ideally|preferably)\b[^;)]*\)?/gi;
const MIN_QUALIFIED_REQUIREMENT_WORDS = 3;
// Where and how the work happens, not what the candidate has done: location, office attendance,
// permits, language fluency and travel belong to the workability checks and are never paired with
// achievements, so they can never produce a gap sentence either.
const COUNT = "(?:\\d+|one|two|three|four|five)";
const WORKABILITY_REQUIREMENT = [
  /\b(?:based|located|living|residing) (?:in|at|near)\b/i,
  /\brelocat\w*|\bcommut\w*|\bon[- ]?site\b|\bin[- ]office\b|\bhybrid (?:work\w*|model|arrangement|role|position|setup|schedule|basis)\b|\bwork(?:ing)? (?:from home|remotely)\b|\bremote(?:[- ]first)? (?:work\w*|role|position|basis)\b/i,
  new RegExp(`\\b(?:come|coming|be|work|working) (?:in(?:to)?|from|at) (?:the |our )?office\\b|\\b${COUNT}\\s*(?:or more\\s*)?days?\\s*(?:a|per|each|every)\\s*week\\b|\\bdays? (?:a week )?in (?:the )?office\\b`, "i"),
  /\bright to work\b|\bwork(?:ing)? (?:permit|visa|authori[sz]ation|rights)\b|\bvisa sponsorship\b|\beligib\w* to work\b|\bcitizen\w*\b|\bpermanent resident\w*\b|\bsecurity clearance\b/i,
  /\bwilling(?:ness)? to travel\b|\btravel (?:up to|is required|required|of up)\b|\b\d{1,2}\s*%\s*(?:of\s+)?travel\b/i,
  /\b(?:fluen(?:t|cy)|native|business[- ]level|proficien\w*|written and (?:spoken|verbal)|spoken and written)\b[^.;]{0,40}\b(?:english|german|french|mandarin|chinese|cantonese|japanese|korean|spanish|italian|dutch|portuguese|russian|arabic|hindi|malay|bahasa|thai|vietnamese|languages?)\b/i,
  /\b(?:english|german|french|mandarin|chinese|cantonese|japanese|korean|spanish|italian|dutch|portuguese|russian|arabic)\b[^.;]{0,20}\b(?:fluen(?:t|cy)|native|proficien\w*|language skills)\b/i,
];

/** Location, office-attendance, work-permit, language-fluency and travel lines: workability facts, not matchable skills. */
export function isWorkabilityRequirement(text: string): boolean {
  return WORKABILITY_REQUIREMENT.some((pattern) => pattern.test(text));
}

// Words that narrow a requirement to a market, asset class, sector or product. Evidence of
// "derivatives" is not evidence of "commodity derivatives", so these are checked word for word.
const DOMAIN_QUALIFIERS: Array<[string, RegExp]> = [
  ["commodities", /\bcommodit(?:y|ies)\b/i], ["energy", /\benergy\b/i], ["power markets", /\bpower (?:markets?|trading)\b/i],
  ["oil and gas", /\boil\b|\bgas\b|\bLNG\b/], ["metals", /\bmetals?\b/i], ["agriculture", /\bagricultur\w*/i],
  ["futures", /\bfutures\b/i], ["equities", /\bequit(?:y|ies)\b/i], ["FX", /\bFX\b|\bforeign exchange\b/i],
  ["crypto", /\bcrypto\w*|\bdigital assets?\b|\bblockchain\b/i], ["insurance", /\b(?:re)?insurance\b/i],
  ["healthcare", /\bhealth ?care\b|\bclinical\b|\bpharma\w*/i], ["private equity", /\bprivate (?:equity|markets?)\b/i],
  ["real estate", /\breal estate\b/i], ["Azure", /\bAzure\b/i], ["AWS", /\bAWS\b|\bAmazon Web Services\b/i],
  ["GCP", /\bGCP\b|\bGoogle Cloud\b/i], ["Snowflake", /\bSnowflake\b/i], ["Databricks", /\bDatabricks\b/i],
  ["Unity Catalog", /\bUnity Catalog\b/i], ["Kafka", /\bKafka\b/i], ["Spark", /\bSpark\b/], ["Kubernetes", /\bKubernetes\b|\bk8s\b/i],
  ["Murex", /\bMurex\b/i], ["Bloomberg", /\bBloomberg\b/i], ["Refinitiv", /\bRefinitiv\b|\bLSEG\b/i], ["Tableau", /\bTableau\b/i],
  ["Power BI", /\bPower ?BI\b/i], ["Java", /\bJava\b(?!Script)/], ["C++", /\bC\+\+/], ["Scala", /\bScala\b/], ["SAS", /\bSAS\b/],
];

/** Market, sector or product words in a text ("commodities", "Azure"): evidence must name them too. */
export function domainQualifiers(text: string): string[] {
  return DOMAIN_QUALIFIERS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

const YEARS_THRESHOLD = /\b(?:at least|minimum(?: of)?|min\.?|over|more than)?\s*(\d{1,2})\s*\+?\s*(?:or more\s+)?years?\b/i;

/** The years a requirement asks for ("at least 3 years of ..."), or null. */
export function requiredYears(text: string): number | null {
  const match = YEARS_THRESHOLD.exec(text);
  return match ? Number(match[1]) : null;
}

const NAMED_CERTIFICATION = /\b(?:certifi\w+|CFA|FRM|CAIA|CPA|ACCA|PMP|PRINCE2|CISSP|CISA|chartered)\b/i;

/** A requirement that names a certification or charter, which only a credential can evidence. */
export function namesCertification(text: string): boolean {
  return NAMED_CERTIFICATION.test(text);
}

/** A line describing the team or employer ("You will be part of a team ...") rather than asking anything. */
export function isNarrativeLine(text: string): boolean {
  return NARRATIVE_LINE.test(text.trim());
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
  const kept = [
    ...quoted.map(({ requirement_key, requirement_type, importance, requirement_text }) => ({
      requirement_key, requirement_type, requirement_text,
      // The extractor marks a whole line PREFERRED for a trailing "ideally ..." clause; only an
      // optional line as a whole is PREFERRED.
      importance: importance === "PREFERRED" && postingImportance(requirement_text) === "MUST" ? "MUST" : importance,
    })),
    ...uncovered,
  ].filter((requirement) => !isWorkabilityRequirement(requirement.requirement_text) && !isNarrativeLine(requirement.requirement_text));
  return mergeOptionalThemes(kept);
}

export const MAX_OPTIONAL_THEMES = 6;
const THEME_SIMILARITY = 0.3;
const THEME_STOPWORDS = new Set(["with", "and", "the", "for", "from", "into", "across", "your", "their", "that", "this", "will",
  "work", "working", "team", "teams", "ensure", "support", "including", "within", "other", "such", "where", "when", "role"]);

function themeWords(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z][a-z+#]{3,}/g) ?? []).filter((word) => !THEME_STOPWORDS.has(word))
    .map((word) => word.replace(/(?:ing|ed|es|s)$/, "")));
}

function similarity(left: Set<string>, right: Set<string>): number {
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared === 0 ? 0 : shared / (left.size + right.size - shared);
}

/**
 * MUST requirements are kept as they are. Optional rows (PREFERRED, NICE_TO_HAVE: mostly the
 * posting's list of duties) that say much the same thing are merged into one theme, and at most
 * MAX_OPTIONAL_THEMES themes are kept, in posting order, so a long duty list does not bury the
 * review under rows nobody needs to check one by one.
 */
export function mergeOptionalThemes(requirements: DocumentRequirement[]): DocumentRequirement[] {
  const themes: Array<{ requirement: DocumentRequirement; words: Set<string> }> = [];
  const result: Array<DocumentRequirement | { theme: number }> = [];
  for (const requirement of requirements) {
    if (requirement.importance === "MUST") { result.push(requirement); continue; }
    const words = themeWords(requirement.requirement_text);
    const match = themes.findIndex((theme) => similarity(theme.words, words) >= THEME_SIMILARITY);
    if (match >= 0) {
      const theme = themes[match];
      const merged = `${withoutEndPunctuation(theme.requirement.requirement_text)}; ${lowerFirst(requirement.requirement_text)}`;
      if (merged.length <= MAX_POSTING_LINE_CHARS) theme.requirement = { ...theme.requirement, requirement_text: merged };
      for (const word of words) theme.words.add(word);
      continue;
    }
    if (themes.length >= MAX_OPTIONAL_THEMES) continue;
    themes.push({ requirement, words });
    result.push({ theme: themes.length - 1 });
  }
  return result.map((entry) => ("theme" in entry ? themes[entry.theme].requirement : entry));
}

function withoutEndPunctuation(text: string): string {
  return text.trim().replace(/[.;:,]+$/, "");
}

function lowerFirst(text: string): string {
  const trimmed = withoutEndPunctuation(text);
  return /^[A-Z][a-z]/.test(trimmed) ? `${trimmed[0].toLowerCase()}${trimmed.slice(1)}` : trimmed;
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
    const words = line.split(/\s+/).length;
    const isHeadingOnly = !heading && !bulleted && !/[.;]$/.test(line)
      && (line.length <= 60 && words <= MAX_HEADING_WORDS || /\?$/.test(line) && line.length <= 100 && words <= MAX_QUESTION_HEADING_WORDS);
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
    if (content.length < MIN_POSTING_LINE_CHARS || content.length > MAX_POSTING_LINE_CHARS || isNarrativeLine(content)) continue;
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
