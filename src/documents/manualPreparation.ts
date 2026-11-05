import crypto from "node:crypto";
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import {
  assertNoInternalAssessmentText,
  domainQualifiers,
  isInternalAssessmentStatement,
  isSelfDescriptionStatement,
  namesCertification,
  requiredYears,
} from "./manualDocumentPolicy.js";

export const MANUAL_COMPARATOR_VERSION = "evidence-pairing-v6";

export interface ManualRequirement {
  requirement_key: string;
  requirement_type: string;
  importance: string;
  requirement_text: string;
}

export interface ManualEvidence {
  id: string;
  evidence_type: "FACT" | "CREDENTIAL" | "ENGAGEMENT";
  label: string;
  statement: string;
  engagement_id?: string;
  fact_type?: string;
  credential_type?: "CERTIFICATION" | "DEGREE" | "COURSE" | "LICENSE";
  engagement_type?: "EMPLOYEE" | "FOUNDER_OPERATOR" | "CONTRACTOR" | "RESEARCHER";
  experience_class?: string;
  start_date?: string;
  end_date?: string;
  /** The candidate's profile-level layout for this role; replaces the automatic choice. */
  document_layout?: "FULL" | "ONE_LINE" | "HIDDEN";
  /** The candidate pinned this credential to appear in every document. */
  always_include?: boolean;
}

export interface ManualComparisonInput {
  canonical_job_id: string;
  job_version_id: string;
  source_observation_id: string;
  source_evidence_fingerprint: string;
  job_content_hash: string;
  title: string;
  company: string;
  canonical_url: string | null;
  profile_version_id: string;
  candidate_profile_id: string;
  requirement_set_id: string;
  profile_contact_fact_ids: string[];
  profile_contact_fingerprint: string;
  preference_context_fingerprint: string;
  context_fingerprint: string;
  requirements: ManualRequirement[];
  evidence: ManualEvidence[];
  suitability_warnings: string[];
  /** The stored model pairing for this job version, requirement set and profile version, if one completed. */
  pairing?: ManualEvidencePairing | null;
}

export interface ManualApprovalIdentity {
  canonicalJobId: string;
  jobVersionId: string;
  sourceObservationId: string;
  jobContentHash: string;
  profileVersionId: string;
  candidateProfileId: string;
  profileContactFactIdsFingerprint: string;
  profileContactFingerprint: string;
  preferenceContextFingerprint: string;
  requirementSetId: string;
  comparatorVersion: string;
  comparisonFingerprint: string;
}

export type ManualApprovalCurrentness =
  | { ok: true }
  | { ok: false; reason: keyof ManualApprovalIdentity };

export function validateManualApprovalCurrentness(
  pinned: ManualApprovalIdentity,
  current: ManualApprovalIdentity,
): ManualApprovalCurrentness {
  for (const key of [
    "canonicalJobId", "jobVersionId", "sourceObservationId", "jobContentHash", "profileVersionId",
    "candidateProfileId", "profileContactFactIdsFingerprint", "profileContactFingerprint",
    "preferenceContextFingerprint", "requirementSetId", "comparatorVersion", "comparisonFingerprint",
  ] as const) {
    if (!pinned[key] || !current[key] || pinned[key] !== current[key]) return { ok: false, reason: key };
  }
  return { ok: true };
}

const TOKEN = /[a-z0-9+#]+/gi;
// Words that carry no evidence on their own: function words, posting boilerplate and generic CV vocabulary.
const GENERIC = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can", "for", "from", "has", "have", "in", "into", "is", "it",
  "its", "of", "on", "or", "our", "such", "that", "the", "their", "this", "to", "up", "we", "who", "will", "with", "within", "you",
  "your", "across", "all", "also", "any", "both", "other", "over", "per", "more", "most", "new", "well", "using", "use", "via",
  "role", "roles", "type", "types", "domain", "domains", "target", "specific", "specifies", "specify", "include", "includes",
  "including", "require", "requires", "required", "requirement", "requirements", "preferred", "plus", "ideally", "must", "should",
  "work", "working", "team", "teams", "year", "years", "strong", "ability", "able", "experience", "experienced", "skill", "skills",
  "knowledge", "understanding", "good", "excellent", "proven", "track", "record", "level", "minimum", "least", "relevant", "related",
  "candidate", "position", "job", "company", "business", "help", "make", "ensure", "support", "deliver", "key", "high",
  "management", "manage", "manag", "lead", "led",
]);
const MIN_MATCHING_TERMS = 2;
// A word shared by more than this share of the profile's matchable evidence ("workflows",
// "portfolio", "architecture" in a long career) says nothing about any one requirement.
const MAX_DISTINCTIVE_DOCUMENT_SHARE = 0.05;
const MIN_DISTINCTIVE_DOCUMENT_COUNT = 2;
// At equal overlap a specific fact is better evidence than a credential.
const EVIDENCE_TYPE_RANK: Record<ManualEvidence["evidence_type"], number> = { FACT: 0, CREDENTIAL: 1, ENGAGEMENT: 2 };
// Facts that record work done; skill, domain and education statements describe the person instead.
const EXPERIENCE_FACT_TYPES = new Set(["ACHIEVEMENT", "RESPONSIBILITY", "PROJECT", "PUBLICATION"]);
const MODEL_PAIRING_METHOD = "model-judged pairing; advisory evidence only";
const LEXICAL_PAIRING_METHOD = "distinctive-term overlap; potential evidence only";

// A technology fact tied to a role that opens with what was done ("Architected a master data
// layer ...") records work, unlike "Python: independently usable ...".
const WORK_RECORD_OPENING = /^(?:[A-Z][a-z]+ed|Built|Led|Ran|Wrote|Set up|Made|Drove|Grew|Won|Taught|Brought|Took)\b/;

/** Work done: the only kind of fact a document prints as a claim. */
function isExperienceFact(evidence: ManualEvidence): boolean {
  if (evidence.evidence_type !== "FACT") return false;
  if (evidence.fact_type === undefined || EXPERIENCE_FACT_TYPES.has(evidence.fact_type)) return true;
  return evidence.fact_type === "TECHNOLOGY" && Boolean(evidence.engagement_id) && WORK_RECORD_OPENING.test(evidence.statement.trim());
}

// A fact may back at most this many requirements, so one strong result cannot answer the whole posting.
export const MAX_REQUIREMENTS_PER_EVIDENCE = 2;
const MAX_EVIDENCE_PER_REQUIREMENT = 3;
// Evidence this many years older than the profile's newest work starts losing rank, a little per year.
const RECENCY_GRACE_YEARS = 5;
const RECENCY_PENALTY_PER_YEAR = 0.01;
const MAX_RECENCY_PENALTY = 0.15;

function evidenceYear(date: string | undefined | null): number | null {
  const year = date ? Number(date.slice(0, 4)) : NaN;
  return Number.isFinite(year) ? year : null;
}

/**
 * Years between each item's role and the profile's newest work: 0 for current roles and for items
 * without a role. Measured from the profile, not today, so the same profile version always yields
 * the same comparison (and the same approval fingerprint).
 */
export function evidenceAgeYears(evidence: ManualEvidence[]): Map<string, number> {
  const engagements = evidence.filter((item) => item.evidence_type === "ENGAGEMENT");
  const lastYear = new Map(engagements.map((item) => [item.id, item.end_date ? evidenceYear(item.end_date) : null]));
  const newest = Math.max(...engagements.map((item) => evidenceYear(item.end_date ?? item.start_date) ?? -Infinity), -Infinity);
  const ages = new Map<string, number>();
  for (const item of evidence) {
    const engagementId = item.evidence_type === "ENGAGEMENT" ? item.id : item.engagement_id;
    const year = engagementId ? lastYear.get(engagementId) : null;
    ages.set(item.id, year != null && Number.isFinite(newest) ? Math.max(0, newest - year) : 0);
  }
  return ages;
}

function recencyPenalty(ageYears: number): number {
  return Math.min(MAX_RECENCY_PENALTY, Math.max(0, ageYears - RECENCY_GRACE_YEARS) * RECENCY_PENALTY_PER_YEAR);
}

/**
 * Chooses each requirement's evidence from its ranked candidates, MUST requirements first: at most
 * three items, different roles before a second item from the same role, and no item backing more
 * than MAX_REQUIREMENTS_PER_EVIDENCE requirements.
 */
function allocateEvidence<T extends { id: string }>(
  rows: Array<{ importance: string; candidates: T[] }>,
  engagementOf: (id: string) => string,
): T[][] {
  const uses = new Map<string, number>();
  const chosen: T[][] = rows.map(() => []);
  const order = rows.map((row, index) => ({ row, index }))
    .sort((left, right) => (IMPORTANCE_RANK[left.row.importance] ?? 3) - (IMPORTANCE_RANK[right.row.importance] ?? 3) || left.index - right.index);
  for (const { row, index } of order) {
    const available = row.candidates.filter((item) => (uses.get(item.id) ?? 0) < MAX_REQUIREMENTS_PER_EVIDENCE);
    const picked: T[] = [];
    const roles = new Set<string>();
    for (const item of available) {
      if (picked.length < MAX_EVIDENCE_PER_REQUIREMENT && !roles.has(engagementOf(item.id))) { picked.push(item); roles.add(engagementOf(item.id)); }
    }
    for (const item of available) {
      if (picked.length < MAX_EVIDENCE_PER_REQUIREMENT && !picked.includes(item)) picked.push(item);
    }
    const ranked = available.filter((item) => picked.includes(item));
    for (const item of ranked) uses.set(item.id, (uses.get(item.id) ?? 0) + 1);
    chosen[index] = ranked;
  }
  return chosen;
}

const IMPORTANCE_RANK: Record<string, number> = { MUST: 0, PREFERRED: 1, NICE_TO_HAVE: 2 };

/**
 * Evidence a requirement may be paired with: work-done facts and credentials, minus internal
 * assessments and self-descriptions. Role summaries and skill statements are not printed as
 * evidence, so they are not offered for pairing either, and neither are facts from roles the
 * profile hides from documents: citing one would put the hidden role back on the CV.
 */
export function matchableEvidence(evidence: ManualEvidence[]): ManualEvidence[] {
  const hiddenRoles = new Set(evidence.filter((item) => item.evidence_type === "ENGAGEMENT" && item.document_layout === "HIDDEN").map((item) => item.id));
  return evidence.filter((item) => (isExperienceFact(item) || item.evidence_type === "CREDENTIAL")
    && !(item.engagement_id && hiddenRoles.has(item.engagement_id))
    && !isInternalAssessmentStatement(item.statement) && !(item.evidence_type === "FACT" && isSelfDescriptionStatement(item.statement)));
}

/** Why a person should check a row before approving: the places the matcher is least reliable. */
export interface RowAttention {
  code: "DOMAIN_QUALIFIER" | "YEARS_THRESHOLD" | "NAMED_CERTIFICATION";
  detail: string;
}

// "ML", "machine learning", "AI" and "data science" name one field in tenure statements and postings.
const AI_ML_TERMS = /\b(?:machine[- ]learning|artificial intelligence|data science|deep learning|ML|AI)\b/g;
// Words a years requirement and a tenure statement share without being about the same field.
const TENURE_GENERIC = new Set(["production", "hand", "hands", "professional", "overall", "industry", "direct", "total", "build", "building"]);

function fieldTerms(text: string): Set<string> {
  return new Set([...terms(text.replace(AI_ML_TERMS, " aiml "))].filter((term) => !TENURE_GENERIC.has(term)));
}

/** Profile-level tenure statements ("Has 2 years of direct AI ... experience") with their years. */
export function tenureStatements(evidence: ManualEvidence[]): Array<{ item: ManualEvidence; years: number; fields: Set<string> }> {
  return evidence.flatMap((item) => {
    if (item.evidence_type !== "FACT" || item.engagement_id) return [];
    const match = /\b(\d{1,2})\+?\s+years?\b/i.exec(item.statement);
    return match ? [{ item, years: Number(match[1]), fields: fieldTerms(item.statement) }] : [];
  });
}

/**
 * Flags a paired row for a human check, and suggests PARTIAL where the record visibly falls short:
 * the requirement names a market or product (commodities, Azure) that none of its evidence names,
 * or asks for more years than the profile's own tenure statement for that field. Model confidence
 * is not calibrated, so a confident pair is never taken as proof of these.
 */
export function rowAttention(
  requirementText: string,
  paired: ManualEvidence[],
  tenure: ReturnType<typeof tenureStatements>,
): { attention: RowAttention[]; suggestedStatus: "PARTIAL" | null } {
  const attention: RowAttention[] = [];
  let partial = false;
  const pairedQualifiers = new Set(paired.flatMap((item) => domainQualifiers(`${item.label} ${item.statement}`)));
  const missing = domainQualifiers(requirementText).filter((qualifier) => !pairedQualifiers.has(qualifier));
  if (missing.length > 0) {
    partial = true;
    attention.push({ code: "DOMAIN_QUALIFIER", detail: `The requirement names ${missing.join(", ")}; none of the proposed evidence does.` });
  }
  const years = requiredYears(requirementText);
  if (years !== null) {
    const fields = fieldTerms(requirementText);
    const related = tenure.filter((entry) => [...entry.fields].some((term) => fields.has(term)));
    const most = related.reduce<(typeof related)[number] | null>((best, entry) => (!best || entry.years > best.years ? entry : best), null);
    if (most && most.years < years) {
      partial = true;
      attention.push({ code: "YEARS_THRESHOLD", detail: `The posting asks for ${years} years; your profile states ${most.years} ("${most.item.statement.trim()}").` });
    } else {
      attention.push({ code: "YEARS_THRESHOLD", detail: `The posting asks for ${years} years; check that the evidence covers them.` });
    }
  }
  if (namesCertification(requirementText) && !paired.some((item) => item.evidence_type === "CREDENTIAL")) {
    attention.push({ code: "NAMED_CERTIFICATION", detail: "The requirement names a certification; only a credential can evidence it." });
  }
  return { attention, suggestedStatus: partial ? "PARTIAL" : null };
}

function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith("es") && !word.endsWith("ses")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function terms(value: string): Set<string> {
  return new Set((value.match(TOKEN) ?? [])
    .map((part) => part.toLowerCase())
    .filter((part) => part.length >= 2 && !GENERIC.has(part) && !/^\d+$/.test(part))
    .map(stem)
    .filter((part) => !GENERIC.has(part)));
}

/** A stored, validated model pairing for this comparison (see manualEvidencePairing.ts). */
export interface ManualEvidencePairing {
  pairs: Array<{ requirement_key: string; evidence_id: string; confidence: number; justification: string }>;
}

type RowEvidence = { id: string; type: ManualEvidence["evidence_type"]; label: string; statement: string; confidence?: number; justification?: string };

/**
 * Without a model pairing: up to three items sharing at least two distinctive words with the
 * requirement. Words common across the profile do not count, so a long career's recurring
 * vocabulary cannot pair unrelated work.
 */
function lexicalPairs(requirementText: string, candidates: ManualEvidence[], evidenceTerms: Map<string, Set<string>>, distinctive: (term: string) => boolean, ages: Map<string, number>): RowEvidence[] {
  const requirementTerms = [...terms(requirementText)].filter(distinctive);
  return candidates
    .map((evidence) => ({ evidence, overlap: requirementTerms.filter((term) => evidenceTerms.get(evidence.id)?.has(term)) }))
    .filter((entry) => entry.overlap.length >= MIN_MATCHING_TERMS)
    .sort((left, right) => right.overlap.length - left.overlap.length
      || EVIDENCE_TYPE_RANK[left.evidence.evidence_type] - EVIDENCE_TYPE_RANK[right.evidence.evidence_type]
      || (ages.get(left.evidence.id) ?? 0) - (ages.get(right.evidence.id) ?? 0)
      || left.evidence.id.localeCompare(right.evidence.id))
    .map(({ evidence }) => ({ id: evidence.id, type: evidence.evidence_type, label: evidence.label, statement: evidence.statement }));
}

/**
 * Pairs each requirement with evidence: the stored model pairing when there is one, otherwise strict
 * distinctive-word overlap. A requirement with no pair is a gap, never filled with the nearest
 * words. Model pairs are ranked by confidence less a small penalty for old work, then allocated so
 * no fact backs more than two requirements. Also summarises how many MUST requirements have
 * evidence, as an advisory fit check.
 */
export function buildManualComparison(input: ManualComparisonInput): Record<string, unknown> {
  const candidates = matchableEvidence(input.evidence);
  const candidateById = new Map(candidates.map((item) => [item.id, item]));
  const evidenceTerms = new Map(candidates.map((evidence) => [evidence.id, terms(evidence.statement)]));
  const documentFrequency = new Map<string, number>();
  for (const termSet of evidenceTerms.values()) for (const term of termSet) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  const maxFrequency = Math.max(MIN_DISTINCTIVE_DOCUMENT_COUNT, Math.floor(candidates.length * MAX_DISTINCTIVE_DOCUMENT_SHARE));
  const distinctive = (term: string) => (documentFrequency.get(term) ?? 0) <= maxFrequency;
  const method = input.pairing ? MODEL_PAIRING_METHOD : LEXICAL_PAIRING_METHOD;
  const ages = evidenceAgeYears(input.evidence);

  const ranked = input.requirements.map((requirement): { importance: string; candidates: RowEvidence[] } => ({
    importance: requirement.importance,
    candidates: input.pairing
      ? input.pairing.pairs
        .filter((pair) => pair.requirement_key === requirement.requirement_key && candidateById.has(pair.evidence_id))
        .map((pair) => ({ pair, rank: pair.confidence - recencyPenalty(ages.get(pair.evidence_id) ?? 0) }))
        .sort((left, right) => right.rank - left.rank || left.pair.evidence_id.localeCompare(right.pair.evidence_id))
        .map(({ pair }) => {
          const item = candidateById.get(pair.evidence_id)!;
          return { id: item.id, type: item.evidence_type, label: item.label, statement: item.statement, confidence: pair.confidence, justification: pair.justification };
        })
      : lexicalPairs(requirement.requirement_text, candidates, evidenceTerms, distinctive, ages),
  }));
  const allocated = allocateEvidence(ranked, (id) => candidateById.get(id)?.engagement_id ?? id);
  const tenure = tenureStatements(input.evidence);

  const rows = input.requirements.map((requirement, index) => {
    const evidence = allocated[index];
    const check = evidence.length > 0
      ? rowAttention(requirement.requirement_text, evidence.map((item) => candidateById.get(item.id)!), tenure)
      : { attention: [], suggestedStatus: null };
    return {
      requirement_key: requirement.requirement_key,
      requirement_type: requirement.requirement_type,
      importance: requirement.importance,
      requirement: requirement.requirement_text,
      evidence,
      gap: evidence.length === 0
        ? "No direct evidence was found in your profile. It stays unmatched in your documents; absence is not proof of inability."
        : null,
      comparison_method: method,
      ...(check.attention.length > 0 ? { attention: check.attention } : {}),
      ...(check.suggestedStatus ? { suggested_status: check.suggestedStatus } : {}),
    };
  });

  const fit = manualFitCheck(rows);
  return {
    schema_version: "manual_application_v1",
    comparator_version: MANUAL_COMPARATOR_VERSION,
    canonical_job_id: input.canonical_job_id,
    job_version_id: input.job_version_id,
    source_observation_id: input.source_observation_id,
    source_evidence_fingerprint: input.source_evidence_fingerprint,
    job_content_hash: input.job_content_hash,
    profile_version_id: input.profile_version_id,
    candidate_profile_id: input.candidate_profile_id,
    requirement_set_id: input.requirement_set_id,
    profile_contact_fact_ids: [...input.profile_contact_fact_ids],
    profile_contact_fingerprint: input.profile_contact_fingerprint,
    preference_context_fingerprint: input.preference_context_fingerprint,
    context_fingerprint: input.context_fingerprint,
    title: input.title,
    company: input.company,
    canonical_url: input.canonical_url,
    requirements: input.requirements,
    evidence: input.evidence,
    rows,
    fit,
    suitability_warnings: [...input.suitability_warnings],
    evidence_notice: "Pairs are proposed evidence for your review, not a suitability decision. Check each source statement and every gap yourself.",
  };
}

/** Gap sentences the candidate wrote on the review screen, in row order: framing for the letter, never claims. */
export function candidateGapNotes(comparison: Record<string, any>): Array<{ text: string; requirement_keys: string[] }> {
  const rows = Array.isArray(comparison.rows) ? comparison.rows as Array<Record<string, any>> : [];
  return rows.filter((row) => typeof row.candidate_gap_note === "string" && row.candidate_gap_note.trim())
    .map((row) => ({ text: String(row.candidate_gap_note).trim(), requirement_keys: [String(row.requirement_key)] }));
}

/** How many MUST requirements have evidence: an advisory coverage check, never a suitability decision. */
export function manualFitCheck(rows: Array<{ requirement_key: string; importance: string; requirement: string; evidence: unknown[] }>) {
  const mustRows = rows.filter((row) => row.importance === "MUST");
  const uncoveredMust = mustRows.filter((row) => row.evidence.length === 0);
  const covered = mustRows.length - uncoveredMust.length;
  const weak = mustRows.length > 0 && covered * 2 < mustRows.length;
  return {
    must_total: mustRows.length,
    must_covered: covered,
    uncovered_must: uncoveredMust.map((row) => ({ requirement_key: row.requirement_key, requirement: row.requirement })),
    verdict: mustRows.length === 0 ? "NO_MUST_REQUIREMENTS" : weak ? "FEWER_THAN_HALF_MUSTS_EVIDENCED" : "MOST_MUSTS_EVIDENCED",
    message: mustRows.length === 0
      ? "The posting states no MUST requirements, so there is no coverage check."
      : weak
        ? `Only ${covered} of ${mustRows.length} MUST requirements have direct evidence in your profile. This looks like a poor fit; documents will not claim the uncovered requirements.`
        : `${covered} of ${mustRows.length} MUST requirements have direct evidence in your profile.`,
    advisory: "Evidence coverage only, not a hiring or suitability decision.",
  };
}

export interface ManualArtifactIdentity {
  document_type: "CV" | "COVER_LETTER";
  format: "DOCX" | "PDF";
  document_run_id: string;
}

export function validateManualArtifactPair(rows: readonly ManualArtifactIdentity[]): void {
  const expected = new Set(["CV:DOCX", "CV:PDF", "COVER_LETTER:DOCX", "COVER_LETTER:PDF"]);
  const actual = new Set(rows.map((row) => `${row.document_type}:${row.format}`));
  const cvRuns = new Set(rows.filter((row) => row.document_type === "CV").map((row) => row.document_run_id));
  const coverLetterRuns = new Set(rows.filter((row) => row.document_type === "COVER_LETTER").map((row) => row.document_run_id));
  if (rows.length !== 4 || actual.size !== expected.size || [...expected].some((key) => !actual.has(key)) ||
      cvRuns.size !== 1 || coverLetterRuns.size !== 1 || [...cvRuns][0] === [...coverLetterRuns][0]) {
    throw new Error("Generated document pair validation failed.");
  }
}

export function fingerprintManualComparison(comparison: Record<string, unknown>): string {
  return crypto.createHash("sha256").update(stableStringify(comparison)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface ControlledDocuments {
  cv: string;
  coverLetter: string;
  claims: Array<{ section: string; text: string; evidenceIds: string[]; requirementKeys: string[] }>;
}

const IMPORTANCE_WEIGHT: Record<string, number> = { MUST: 3, PREFERRED: 2, NICE_TO_HAVE: 1 };
const MAX_REQUIREMENT_LINES = 8;
const MAX_COVER_LETTER_POINTS = 3;
const MAX_FACTS_PER_ENGAGEMENT = 5;
const UNLINKED_FACTS_PER_FULL_ENGAGEMENT = 2;
const MAX_SUMMARY_STATEMENTS = 3;
const MAX_FULL_VENTURES = 2;
const MAX_CERTIFICATIONS = 6;
const FULL_ENTRY_YEARS = 10;
const ONE_LINE_YEARS = 20;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const CERTIFICATION_ORDER: Record<string, number> = { CERTIFICATION: 0, LICENSE: 1, COURSE: 2 };
const FACT_TYPE_IMPACT: Record<string, number> = { ACHIEVEMENT: 3, PROJECT: 2, PUBLICATION: 2, RESPONSIBILITY: 1 };
// Employment shorter than this gets one line by default: a brief engagement should not outrank long tenure.
const MIN_FULL_ENTRY_MONTHS = 12;
// Credential words that say nothing about the subject ("Health Insurance Certification" is not about cloud).
const CREDENTIAL_GENERIC = new Set(["certification", "certificate", "certified", "professional", "program", "programme", "course",
  "level", "practitioner", "associate", "foundational", "advanced", "issued", "status", "active", "paper", "papers", "module", "rule",
  "regulation", "standard"]);

type ComparisonRow = { requirement_key: string; importance: string; requirement: string; evidence?: Array<{ id: string }> };
type Claim = ControlledDocuments["claims"][number];

/** How a role appears on the CV: a full entry with bullets, a single line, or not at all. */
export type RoleLayout = "FULL" | "ONE_LINE" | "HIDDEN";

export interface ControlledDocumentOptions {
  /** The date the 10- and 20-year windows are measured from; defaults to today. */
  asOf?: Date;
  /** The candidate's per-role choice, keyed by engagement evidence id; overrides the default layout. */
  roleLayout?: Record<string, RoleLayout>;
  /** A validated, model-written summary; each sentence cites approved evidence. Replaces the plain summary. */
  writtenSummary?: Array<{ text: string; evidence_ids: string[]; requirement_keys: string[] }>;
  /** Whether the letter includes the candidate's own gap sentences from the review; default true. */
  includeGapNotes?: boolean;
}

function formatMonth(isoDate: string): string {
  const [year, month] = isoDate.split("-");
  return `${MONTHS[Number(month) - 1] ?? ""} ${year}`.trim();
}

/** Reads the "(YYYY-MM-DD–YYYY-MM-DD|present)" period the router writes into engagement statements. */
export function engagementPeriod(statement: string): string | null {
  const match = /\((\d{4}-\d{2}-\d{2})(?:–(present|\d{4}-\d{2}-\d{2}))?\)/.exec(statement);
  if (!match) return null;
  const end = match[2] === "present" ? "Present" : match[2] ? formatMonth(match[2]) : null;
  return end ? `${formatMonth(match[1])} – ${end}` : formatMonth(match[1]);
}

function engagementDates(engagement: ManualEvidence): { start: string | null; end: string | null } {
  if (engagement.start_date) return { start: engagement.start_date, end: engagement.end_date ?? null };
  const match = /\((\d{4}-\d{2}-\d{2})(?:–(present|\d{4}-\d{2}-\d{2}))?\)/.exec(engagement.statement);
  return { start: match?.[1] ?? null, end: match?.[2] && match[2] !== "present" ? match[2] : null };
}

function withoutTrailingPeriod(text: string): string {
  return text.trim().replace(/[.;:]+$/, "");
}

function monthsBetween(start: string, end: string): number {
  const [startYear, startMonth] = start.split("-").map(Number);
  const [endYear, endMonth] = end.split("-").map(Number);
  return (endYear - startYear) * 12 + (endMonth - startMonth) + 1;
}

function yearsBefore(asOf: Date, years: number): string {
  const date = new Date(asOf);
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date.toISOString().slice(0, 10);
}

/** Courses and certification sprints are never jobs; founder, venture and current research work is listed apart from employment. */
function engagementKind(engagement: ManualEvidence): "EMPLOYMENT" | "VENTURE" | "COURSE" {
  if (engagement.experience_class === "COURSE_PROJECT") return "COURSE";
  const current = !engagementDates(engagement).end;
  if (engagement.engagement_type === "FOUNDER_OPERATOR" || engagement.experience_class === "APPLIED_PROJECT") return "VENTURE";
  if (engagement.engagement_type === "RESEARCHER" && current) return "VENTURE";
  return "EMPLOYMENT";
}

function organisationOf(engagement: ManualEvidence): string {
  const index = engagement.label.lastIndexOf(" at ");
  return index >= 0 ? engagement.label.slice(index + 4) : engagement.label;
}

function credentialType(item: ManualEvidence): string {
  return item.credential_type ?? /, (certification|degree|course|license) issued by/i.exec(item.statement)?.[1].toUpperCase() ?? "CERTIFICATION";
}

/** Approved evidence a document may use: work done, no internal assessments or self-descriptions, no courses. */
function documentEvidence(comparison: Record<string, any>): ManualEvidence[] {
  const approved = (Array.isArray(comparison.evidence) ? comparison.evidence as ManualEvidence[] : [])
    .filter((item) => !isInternalAssessmentStatement(item.statement) && !(item.evidence_type === "FACT" && isSelfDescriptionStatement(item.statement)))
    // Facts are printed only when they record work done, or state tenure for the plain summary.
    .filter((item) => item.evidence_type !== "FACT" || isExperienceFact(item) || (!item.engagement_id && /\b\d+\+?\s+years?\b/i.test(item.statement)));
  // Courses are not jobs: neither they nor their facts are offered as evidence of meeting a job requirement.
  const courseIds = new Set(approved.filter((item) => item.evidence_type === "ENGAGEMENT" && engagementKind(item) === "COURSE").map((item) => item.id));
  return approved.filter((item) => !courseIds.has(item.id) && !(item.engagement_id && courseIds.has(item.engagement_id)));
}

/** Relevance of each evidence item = summed importance of the requirements it supports. */
function evidenceRelevance(rows: ComparisonRow[]): Map<string, number> {
  const relevance = new Map<string, number>();
  for (const row of rows) {
    for (const { id } of row.evidence ?? []) relevance.set(id, (relevance.get(id) ?? 0) + (IMPORTANCE_WEIGHT[row.importance] ?? 1));
  }
  return relevance;
}

/** A role the CV can show, with the layout it gets unless the candidate chooses otherwise. */
export interface RolePlan {
  engagement_id: string;
  label: string;
  period: string | null;
  kind: "EMPLOYMENT" | "VENTURE";
  default_layout: RoleLayout | "SUMMARISED";
  /** PROFILE when the layout comes from the candidate's profile setting, AUTOMATIC otherwise. */
  default_source: "PROFILE" | "AUTOMATIC";
}

/**
 * Default role layout, newest first. A layout set on the role in the profile wins. Otherwise
 * employment from the last 10 years lasting a year or more gets a full entry (shorter engagements
 * get one line); ventures only when relevant to this job (at
 * most two); older employment becomes one line, and anything over 20 years old is summarised in
 * one shared line. Courses are left out.
 */
export function planRoles(
  comparison: Record<string, any>,
  options: Pick<ControlledDocumentOptions, "asOf"> & { citedEvidenceIds?: Iterable<string> } = {},
): RolePlan[] {
  const asOf = options.asOf ?? new Date();
  const cited = new Set(options.citedEvidenceIds ?? []);
  const evidence = documentEvidence(comparison);
  const relevance = evidenceRelevance(Array.isArray(comparison.rows) ? comparison.rows as ComparisonRow[] : []);
  const score = (id: string) => relevance.get(id) ?? 0;
  const engagements = evidence.filter((item) => item.evidence_type === "ENGAGEMENT");
  const roleScore = (engagement: ManualEvidence) => score(engagement.id) + evidence
    .filter((item) => item.evidence_type === "FACT" && item.engagement_id === engagement.id)
    .reduce((total, item) => total + score(item.id), 0);
  const fullEntryCutoff = yearsBefore(asOf, FULL_ENTRY_YEARS);
  const oneLineCutoff = yearsBefore(asOf, ONE_LINE_YEARS);
  const relevantVentures = new Set(engagements
    .filter((item) => engagementKind(item) === "VENTURE" && !item.document_layout && roleScore(item) > 0)
    .sort((left, right) => roleScore(right) - roleScore(left))
    .slice(0, MAX_FULL_VENTURES)
    .map((item) => item.id));
  // A role whose work backs a requirement pair or a summary sentence is a full entry, whatever its
  // age or tenure: a recruiter must find the role behind every claim.
  // Ventures keep their cap on relevance-only promotion, but one the summary cites is shown in full.
  const summaryCited = (engagement: ManualEvidence) => cited.has(engagement.id)
    || evidence.some((item) => item.engagement_id === engagement.id && cited.has(item.id));
  const isCited = (engagement: ManualEvidence) => roleScore(engagement) > 0 || summaryCited(engagement);
  return [...engagements]
    .sort((left, right) => (engagementDates(right).end ?? "9999").localeCompare(engagementDates(left).end ?? "9999")
      || (engagementDates(right).start ?? "").localeCompare(engagementDates(left).start ?? ""))
    .map((engagement) => {
      const kind = engagementKind(engagement) as "EMPLOYMENT" | "VENTURE";
      const { start, end } = engagementDates(engagement);
      const tenureMonths = start ? monthsBetween(start, end ?? asOf.toISOString().slice(0, 10)) : Infinity;
      const automatic: RolePlan["default_layout"] = kind === "EMPLOYMENT" && isCited(engagement) ? "FULL"
        : kind === "VENTURE"
        ? (relevantVentures.has(engagement.id) || summaryCited(engagement) ? "FULL" : "ONE_LINE")
        : !end || end >= fullEntryCutoff
          ? (tenureMonths >= MIN_FULL_ENTRY_MONTHS ? "FULL" : "ONE_LINE")
          : start && start >= oneLineCutoff ? "ONE_LINE" : "SUMMARISED";
      return {
        engagement_id: engagement.id, label: engagement.label, period: engagementPeriod(engagement.statement), kind,
        default_layout: engagement.document_layout ?? automatic,
        default_source: engagement.document_layout ? "PROFILE" : "AUTOMATIC",
      };
    });
}

/**
 * The summary without a model: tenure statements ("Has 15 years of ...", "Has 2 years of ...") are
 * joined into one sentence ("Brings 15 years of ...; and 2 years of ..."), so the summary reads as
 * a profile rather than a list of "Has" lines. Each statement keeps its own words; any statement not
 * in the "Has ..." form stays a sentence of its own.
 */
function plainSummary(statements: ManualEvidence[]): Array<{ text: string; ids: string[] }> {
  const tenure = statements.filter((item) => /^has\s+\S/i.test(item.statement.trim()));
  const parts = tenure.map((item) => withoutTrailingPeriod(item.statement.trim().replace(/^has\s+/i, "")));
  const joined = parts.length === 0 ? []
    : [{ text: `Brings ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join("; ")}; and ${parts[parts.length - 1]}`}.`, ids: tenure.map((item) => item.id) }];
  return [...joined, ...statements.filter((item) => !tenure.includes(item)).map((item) => ({ text: item.statement.trim(), ids: [item.id] }))];
}

/**
 * Builds a CV and cover letter from the approved comparison only. Every line is a verbatim
 * profile statement or the job's own requirement text, so no claim exists outside the evidence.
 */
export function buildControlledDocuments(
  comparison: Record<string, any>,
  contact: { full_name: string; location?: string; email?: string; phone?: string; linkedin?: string },
  options: ControlledDocumentOptions = {},
): ControlledDocuments {
  if (!contact.phone?.trim()) throw new Error("The active private contact graph has no current phone fact; document preparation is blocked.");
  const asOf = options.asOf ?? new Date();
  const evidence = documentEvidence(comparison);
  const rows = Array.isArray(comparison.rows) ? comparison.rows as ComparisonRow[] : [];
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const weight = (row: ComparisonRow) => IMPORTANCE_WEIGHT[row.importance] ?? 1;
  const relevance = evidenceRelevance(rows);
  const requirementKeysById = new Map<string, string[]>();
  for (const row of rows) {
    for (const { id } of row.evidence ?? []) requirementKeysById.set(id, [...(requirementKeysById.get(id) ?? []), row.requirement_key]);
  }
  const score = (id: string) => relevance.get(id) ?? 0;
  // Impact of a fact for picking unmatched bullets: quantified results first, then achievements over projects over duties.
  const impact = (item: ManualEvidence) =>
    (/\d|%|\$/.test(item.statement) ? 10 : 0) + (FACT_TYPE_IMPACT[item.fact_type ?? ""] ?? 0);
  const claims: Claim[] = [];
  const claim = (section: string, text: string, evidenceIds: string[], requirementKeys?: string[]) => {
    claims.push({
      section, text, evidenceIds,
      requirementKeys: requirementKeys ?? [...new Set(evidenceIds.flatMap((id) => requirementKeysById.get(id) ?? []))],
    });
    return text;
  };

  // Requirements the profile can evidence, most important first; each paired with its strongest fact
  // not already used for a more important requirement, so no statement is repeated.
  const usedForRequirement = new Set<string>();
  const matchedRows = rows
    .map((row, index) => ({
      row, index,
      linked: (row.evidence ?? []).map(({ id }) => evidenceById.get(id)).filter((item): item is ManualEvidence => Boolean(item))
        .sort((left, right) => EVIDENCE_TYPE_RANK[left.evidence_type] - EVIDENCE_TYPE_RANK[right.evidence_type]),
    }))
    .sort((left, right) => weight(right.row) - weight(left.row) || left.index - right.index)
    .map(({ row, index, linked }) => {
      const best = linked.find((item) => !usedForRequirement.has(item.id));
      if (best) usedForRequirement.add(best.id);
      return { row, index, best };
    })
    .filter((entry): entry is { row: ComparisonRow; index: number; best: ManualEvidence } => Boolean(entry.best));
  const requirementLines = matchedRows.slice(0, MAX_REQUIREMENT_LINES).map(({ row, best }) =>
    `- ${claim("Role requirements", `${withoutTrailingPeriod(row.requirement)}: ${best.statement.trim()}`, [best.id], [row.requirement_key])}`);

  // Summary: one paragraph of the most relevant profile-level statements, then tenure statements,
  // each verbatim so hands-on coding and architecture years are never combined.
  const tenureFacts = evidence.filter((item) => item.evidence_type === "FACT" &&
    /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+years?\b/i.test(item.statement) &&
    /(coding|software development|hands-on|technical-functional|architecture)/i.test(item.statement));
  const tenureIds = new Set(tenureFacts.map((item) => item.id));
  // Study and credential statements already appear under Education and Certifications, and
  // "foundational knowledge" statements describe a learning level, not a strength to lead with.
  const isStudyStatement = (item: ManualEvidence) => /^(completed|earned|passed|graduated|holds|foundational)\b/i.test(item.statement.trim());
  const profileFacts = evidence.filter((item) => item.evidence_type === "FACT" && !item.engagement_id && !isStudyStatement(item));
  const overviewFacts = profileFacts.filter((item) => !tenureIds.has(item.id) && /\b\d+\+?\s+years?\b/i.test(item.statement));
  const relevantProfileFacts = profileFacts
    .map((item, order) => ({ item, order }))
    .filter(({ item }) => !tenureIds.has(item.id) && score(item.id) > 0)
    .sort((left, right) => score(right.item.id) - score(left.item.id) || left.order - right.order)
    .map(({ item }) => item);
  const summaryStatements = [...new Set([...overviewFacts, ...relevantProfileFacts, ...tenureFacts])].slice(0, MAX_SUMMARY_STATEMENTS);
  const summaryParagraph = options.writtenSummary?.length
    ? options.writtenSummary.map((sentence) => claim("Summary", sentence.text.trim(), [...sentence.evidence_ids], [...sentence.requirement_keys])).join(" ")
    : plainSummary(summaryStatements).map(({ text, ids }) => claim("Summary", text, ids)).join(" ");

  // Roles: the default layout comes from planRoles; the candidate's choice overrides it.
  const summaryEvidenceIds = (options.writtenSummary ?? []).flatMap((sentence) => sentence.evidence_ids);
  const plans = new Map(planRoles(comparison, { asOf, citedEvidenceIds: summaryEvidenceIds }).map((plan) => [plan.engagement_id, plan]));
  const engagements = evidence.filter((item) => item.evidence_type === "ENGAGEMENT" && plans.has(item.id));
  const factsFor = (engagement: ManualEvidence) => evidence
    .map((item, order) => ({ item, order }))
    .filter(({ item }) => item.evidence_type === "FACT" && item.engagement_id === engagement.id && !tenureIds.has(item.id));
  const defaultLayout = (engagement: ManualEvidence): RoleLayout | "SUMMARISED" => plans.get(engagement.id)?.default_layout ?? "ONE_LINE";

  const sections: Record<"EMPLOYMENT" | "VENTURE", string[]> = { EMPLOYMENT: [], VENTURE: [] };
  const ventureOneLiners: ManualEvidence[] = [];
  const earlierLines: string[] = [];
  const summarised: ManualEvidence[] = [];
  const byNewest = [...engagements].sort((left, right) =>
    (engagementDates(right).end ?? "9999").localeCompare(engagementDates(left).end ?? "9999")
    || (engagementDates(right).start ?? "").localeCompare(engagementDates(left).start ?? ""));
  for (const engagement of byNewest) {
    const kind = engagementKind(engagement) as "EMPLOYMENT" | "VENTURE";
    const layout = options.roleLayout?.[engagement.id] ?? defaultLayout(engagement);
    if (layout === "HIDDEN") continue;
    const period = engagementPeriod(engagement.statement);
    const facts = factsFor(engagement);
    const linked = facts.filter(({ item }) => score(item.id) > 0)
      .sort((left, right) => score(right.item.id) - score(left.item.id) || impact(right.item) - impact(left.item) || left.order - right.order);
    // Unmatched bullets fill out a role with its highest-impact work, not the first facts in file order.
    const unlinked = facts.filter(({ item }) => score(item.id) === 0 && isExperienceFact(item))
      .sort((left, right) => impact(right.item) - impact(left.item) || left.order - right.order)
      .slice(0, UNLINKED_FACTS_PER_FULL_ENGAGEMENT);
    const shown = [...linked, ...unlinked].slice(0, MAX_FACTS_PER_ENGAGEMENT);
    if (layout === "FULL" && shown.length > 0) {
      const section = kind === "VENTURE" ? "Ventures and research" : "Experience";
      sections[kind].push(`### ${claim(section, `${engagement.label}${period ? ` | ${period}` : ""}`, [engagement.id])}`);
      for (const { item } of shown) sections[kind].push(`- ${claim(section, item.statement.trim(), [item.id])}`);
      sections[kind].push("");
    } else if (layout === "SUMMARISED") {
      summarised.push(engagement);
    } else if (kind === "VENTURE") {
      ventureOneLiners.push(engagement);
    } else {
      earlierLines.push(`- ${claim("Earlier career", `${engagement.label}${period ? ` (${period})` : ""}`, [engagement.id])}`);
    }
  }
  if (ventureOneLiners.length > 0) {
    sections.VENTURE.push(`- ${claim("Ventures and research", `Also: ${ventureOneLiners.map((item) => {
      const period = engagementPeriod(item.statement);
      return `${item.label}${period ? ` (${period})` : ""}`;
    }).join("; ")}`, ventureOneLiners.map((item) => item.id))}`, "");
  }
  if (summarised.length > 0) {
    const years = summarised.flatMap((item) => Object.values(engagementDates(item))).filter((date): date is string => Boolean(date)).map((date) => date.slice(0, 4)).sort();
    const organisations = [...new Set(summarised.map(organisationOf))];
    earlierLines.push(`- ${claim("Earlier career", `Earlier roles (${years[0]}–${years[years.length - 1]}): ${organisations.join("; ")}`, summarised.map((item) => item.id))}`);
  }

  // Education lists every degree; certifications, licences and courses are ranked by relevance to this job.
  const jobTerms = terms(`${comparison.title ?? ""} ${rows.map((row) => row.requirement).join(" ")}`);
  const credentials = evidence.filter((item) => item.evidence_type === "CREDENTIAL");
  const educationLines = credentials.filter((item) => credentialType(item) === "DEGREE")
    .map((item) => `- ${claim("Education", item.label, [item.id])}`);
  const credentialRelevance = (item: ManualEvidence) =>
    score(item.id) * 10 + [...terms(item.label)].filter((term) => !CREDENTIAL_GENERIC.has(term) && jobTerms.has(term)).length;
  const rankedCertifications = credentials
    .map((item, order) => ({ item, order }))
    .filter(({ item }) => credentialType(item) !== "DEGREE")
    .sort((left, right) => credentialRelevance(right.item) - credentialRelevance(left.item)
      || (CERTIFICATION_ORDER[credentialType(left.item)] ?? 3) - (CERTIFICATION_ORDER[credentialType(right.item)] ?? 3)
      || left.order - right.order);
  // Pinned credentials always appear and count toward the cap; the rest only when relevant to this
  // job (paired with a requirement, or naming its subject). Output keeps rank order.
  const pinned = rankedCertifications.filter(({ item }) => item.always_include);
  const chosenCertifications = new Set(pinned.map(({ item }) => item.id));
  for (const { item } of rankedCertifications) {
    if (chosenCertifications.size >= Math.max(MAX_CERTIFICATIONS, pinned.length)) break;
    if (credentialRelevance(item) > 0) chosenCertifications.add(item.id);
  }
  const certificationLines = rankedCertifications
    .filter(({ item }) => chosenCertifications.has(item.id))
    .map(({ item }) => `- ${claim("Certifications", item.label, [item.id])}`);

  const header = documentHeader(contact);
  const cv = [
    ...header,
    `## Target role: ${comparison.title} — ${comparison.company}`,
    "",
    ...(summaryParagraph ? ["## Summary", summaryParagraph, ""] : []),
    ...(requirementLines.length ? ["## How my experience matches this role", ...requirementLines, ""] : []),
    ...(sections.EMPLOYMENT.length ? ["## Experience", ...sections.EMPLOYMENT] : []),
    ...(sections.VENTURE.length ? ["## Ventures and research", ...sections.VENTURE] : []),
    ...(earlierLines.length ? ["## Earlier career", ...earlierLines, ""] : []),
    ...(educationLines.length ? ["## Education", ...educationLines, ""] : []),
    ...(certificationLines.length ? ["## Certifications", ...certificationLines] : []),
  ].join("\n").trimEnd();

  const letterPoints = matchedRows.slice(0, MAX_COVER_LETTER_POINTS).map(({ row, best }) =>
    claim("Cover letter", `On "${withoutTrailingPeriod(row.requirement)}": ${best.statement.trim()}`, [best.id], [row.requirement_key]));
  const coverLetter = [
    ...header,
    `## Application for ${comparison.title} at ${comparison.company}`,
    "",
    `Dear ${comparison.company} Hiring Team,`,
    "",
    `I am applying for the ${comparison.title} role at ${comparison.company}. Below, I set the role's main requirements against what I have done.`,
    "",
    ...letterPoints.flatMap((point) => [point, ""]),
    ...(options.includeGapNotes !== false && candidateGapNotes(comparison).length > 0
      ? [candidateGapNotes(comparison).map((note) => note.text).join(" "), ""] : []),
    "Everything above comes from my recorded experience. Where the role asks for something not covered here, I would be glad to discuss it directly.",
    "",
    "I would welcome the opportunity to talk about the role.",
    "",
    "Sincerely,",
    contact.full_name,
  ].join("\n");

  assertNoInternalAssessmentText("The CV", cv);
  assertNoInternalAssessmentText("The cover letter", coverLetter);
  return { cv, coverLetter, claims };
}

/** The name and contact lines shared by the CV and the cover letter. */
export function documentHeader(contact: { full_name: string; location?: string; email?: string; phone?: string; linkedin?: string }): string[] {
  return [`# ${contact.full_name}`, [contact.location, contact.email, contact.phone, contact.linkedin].filter(Boolean).join(" | "), ""];
}

export async function renderControlledDocx(markdown: string): Promise<Buffer> {
  const paragraphs: Paragraph[] = [];
  for (const [index, line] of markdown.split(/\r?\n/).entries()) {
    if (!line.trim()) { paragraphs.push(new Paragraph({ text: "" })); continue; }
    if (line.startsWith("# ")) paragraphs.push(new Paragraph({ text: line.slice(2), heading: HeadingLevel.TITLE }));
    else if (line.startsWith("## ")) paragraphs.push(new Paragraph({ text: line.slice(3), heading: HeadingLevel.HEADING_1 }));
    else if (line.startsWith("### ")) paragraphs.push(new Paragraph({ text: line.slice(4), heading: HeadingLevel.HEADING_2 }));
    else if (line.startsWith("- ")) paragraphs.push(new Paragraph({ text: line.slice(2), bullet: { level: 0 } }));
    else paragraphs.push(new Paragraph({
      spacing: { after: index === 1 ? 260 : 120, line: 276 },
      children: [new TextRun({ text: line, ...(index === 1 ? { size: 19, color: "5B6573" } : {}) })],
    }));
  }
  const document = new Document({
    styles: {
      default: {
        document: {
          run: { font: "Arial", size: 21, color: "202833" },
          paragraph: { spacing: { after: 120, line: 276 } },
        },
      },
      paragraphStyles: [
        { id: "Title", name: "Title", basedOn: "Normal", next: "Normal", run: { font: "Arial", size: 36, bold: true, color: "111827" }, paragraph: { spacing: { before: 0, after: 100 }, keepNext: true } },
        { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", run: { font: "Arial", size: 26, bold: true, color: "174A6E" }, paragraph: { spacing: { before: 220, after: 100 }, keepNext: true } },
        { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", run: { font: "Arial", size: 22, bold: true, color: "202833" }, paragraph: { spacing: { before: 160, after: 60 }, keepNext: true } },
      ],
    },
    sections: [{ properties: { page: { margin: { top: 720, right: 780, bottom: 720, left: 780 } } }, children: paragraphs }],
  });
  return Packer.toBuffer(document);
}

// The Windows-1252 positions 0x80-0x9F that WinAnsiEncoding assigns to typographic characters.
const WIN_ANSI_EXTRAS: Record<string, number> = {
  "\u20ac": 0x80, "\u201a": 0x82, "\u0192": 0x83, "\u201e": 0x84, "\u2026": 0x85, "\u2020": 0x86, "\u2021": 0x87, "\u02c6": 0x88, "\u2030": 0x89, "\u0160": 0x8a, "\u2039": 0x8b,
  "\u0152": 0x8c, "\u017d": 0x8e, "\u2018": 0x91, "\u2019": 0x92, "\u201c": 0x93, "\u201d": 0x94, "\u2022": 0x95, "\u2013": 0x96, "\u2014": 0x97, "\u02dc": 0x98, "\u2122": 0x99,
  "\u0161": 0x9a, "\u203a": 0x9b, "\u0153": 0x9c, "\u017e": 0x9e, "\u0178": 0x9f,
};

function winAnsiByte(character: string): number | null {
  const code = character.codePointAt(0)!;
  if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) return code;
  return WIN_ANSI_EXTRAS[character] ?? null;
}

/**
 * PDF string text in the fonts' WinAnsiEncoding, one byte per character: apostrophes, quotes,
 * dashes, bullets and Latin accents print as written. Anything else loses its accent ("\u0113" \u2192 "e"),
 * or becomes "?" when it has no Latin form.
 */
export function winAnsiPdfText(value: string): string {
  let encoded = "";
  for (const character of value) {
    let code = winAnsiByte(character);
    if (code === null) {
      const base = character.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
      code = base.length === 1 ? winAnsiByte(base) : null;
    }
    const byte = String.fromCharCode(code ?? 0x3f);
    encoded += byte === "\\" || byte === "(" || byte === ")" ? `\\${byte}` : byte;
  }
  return encoded;
}

export function renderControlledPdf(markdown: string): Buffer {
  type PdfLine = { text: string; style: "title" | "heading" | "subheading" | "contact" | "body" };
  const wrapped: PdfLine[] = [];
  const sourceLines = markdown.split(/\r?\n/);
  sourceLines.forEach((sourceLine, index) => {
    const style: PdfLine["style"] = sourceLine.startsWith("# ") ? "title"
      : sourceLine.startsWith("## ") ? "heading"
        : sourceLine.startsWith("### ") ? "subheading"
          : index === 1 ? "contact" : "body";
    const cleaned = sourceLine.replace(/^#{1,3}\s+/, "").replace(/^-\s+/, "• ");
    const words = cleaned.trim().split(/\s+/).filter(Boolean);
    if (!words.length) { wrapped.push({ text: "", style: "body" }); return; }
    const maxChars = style === "title" ? 62 : style === "heading" ? 76 : 92;
    let current = "";
    for (const word of words) {
      if (current && `${current} ${word}`.length > maxChars) {
        wrapped.push({ text: current, style });
        current = word;
      } else current = current ? `${current} ${word}` : word;
    }
    wrapped.push({ text: current, style });
  });
  const pages: PdfLine[][] = [];
  let page: PdfLine[] = [];
  let verticalSpace = 790;
  for (const line of wrapped) {
    const height = line.style === "title" ? 30 : line.style === "heading" ? 23 : line.style === "subheading" ? 18 : line.style === "contact" ? 16 : 15;
    if (verticalSpace - height < 48 && page.length) { pages.push(page); page = []; verticalSpace = 790; }
    page.push(line);
    verticalSpace -= height;
  }
  if (page.length || pages.length === 0) pages.push(page);
  const objects: string[] = [];
  const pageRefs = pages.map((_, index) => `${3 + index * 2} 0 R`).join(" ");
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${pageRefs}] /Count ${pages.length} >>`);
  const regularFontObject = 3 + pages.length * 2;
  const boldFontObject = regularFontObject + 1;
  pages.forEach((lines) => {
    const pageObject = objects.length + 1;
    const contentObject = pageObject + 1;
    let y = 790;
    const commands = lines.flatMap((line) => {
      const title = line.style === "title";
      const heading = line.style === "heading";
      const subheading = line.style === "subheading";
      const contact = line.style === "contact";
      const size = title ? 21 : heading ? 13 : subheading ? 11 : contact ? 9 : 10;
      const height = title ? 30 : heading ? 23 : subheading ? 18 : contact ? 16 : 15;
      const font = title || heading || subheading ? "F2" : "F1";
      const color = title || heading ? "0.09 0.27 0.39 rg" : contact ? "0.34 0.39 0.45 rg" : "0.13 0.16 0.20 rg";
      const command = `${color}\n/${font} ${size} Tf\n1 0 0 1 50 ${y} Tm\n(${winAnsiPdfText(line.text)}) Tj`;
      y -= height;
      return [command];
    });
    const content = ["BT", ...commands, "ET"].join("\n");
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 ${regularFontObject} 0 R /F2 ${boldFontObject} 0 R >> >> /Contents ${contentObject} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
  });
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf, "latin1")); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

export function sha256Buffer(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}
