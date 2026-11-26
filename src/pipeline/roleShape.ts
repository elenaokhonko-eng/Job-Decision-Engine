/**
 * Role-shape downranks (W3). A role can fit the lanes and still be shaped in a way the owner does not want as the
 * core of the job: delivering to customers, managing people, contract employment, running infrastructure. These are
 * downranks, never rejections (AGENTS.md invariant 11): each signal lowers the ranking score by a fixed share, every
 * signal carries the posting words that triggered it, and the raw score stays in the decision trace. Pure and
 * deterministic: the same title and description always give the same assessment.
 */
import { createHash } from "node:crypto";

import { findCustomerFacingRoleDuty } from "./customerFacingDuties.js";

export const ROLE_SHAPE_POLICY_VERSION = "role_shape_v3";
// v2 (shipped with gate-2026-11.7): one customer-engagement duty phrase is a downrank.
// v3: contract detection ignores permanent / negated wording; people management needs a strong cue (direct reports, a team
// of N, people or line management) with a management title, so one weak mention ("performance reviews") never flags.
/** The combined downrank never exceeds this share of the score, so a job can lose rank but is never erased by it. */
export const ROLE_SHAPE_MAX_TOTAL_PENALTY = 0.15;
const EVIDENCE_QUOTE_MAX = 160;

export interface RoleShapeInput {
  title: string | null | undefined;
  description: string | null | undefined;
  employmentType?: string | null | undefined;
  /** The posting words of a MUST degree the matcher found the profile short of (null when there is none). */
  degreeGapQuote?: string | null | undefined;
}

export interface RoleShapeSignal {
  code: string;
  /** Share of the score removed by this signal (0.06 = 6%). */
  penalty: number;
  /** Where the words came from, and a short verbatim excerpt of them. */
  source: "TITLE" | "DESCRIPTION" | "EMPLOYMENT_TYPE";
  quote: string;
}

export interface RoleShapeAssessment {
  policy_version: string;
  signals: RoleShapeSignal[];
  /** Sum of the signal penalties, capped at ROLE_SHAPE_MAX_TOTAL_PENALTY. */
  total_penalty: number;
}

export type RoleShapeDetector = (input: { title: string; description: string; employmentType: string; degreeGapQuote: string | null }) => RoleShapeSignal | null;

export function excerpt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 40);
  return text.slice(start, end).replace(/\s+/g, " ").trim().slice(0, EVIDENCE_QUOTE_MAX);
}

// ---------------------------------------------------------------------------------------------------------------
// Customer-facing delivery: the job is to implement, deploy or support a product at customers.
// ---------------------------------------------------------------------------------------------------------------

const CUSTOMER_DELIVERY_TITLE =
  /\b(?:customer success|solutions? (?:engineer|architect|consultant)|forward[- ]deployed|implementation (?:engineer|consultant|manager|specialist)|professional services|technical account (?:manager|executive)|customer engineer|field (?:engineer|ai)|delivery consultant|client (?:partner|delivery)|deployment strategist|pre-?sales)\b/i;
const CUSTOMER_DELIVERY_CUES: RegExp[] = [
  /\bcustomer[- ]facing\b/i,
  /\bclient[- ]facing\b/i,
  /\bembedded (?:with|in) (?:customer|client)s?\b/i,
  /\b(?:on[- ]?site|onsite) (?:with|at) (?:customer|client)s?\b/i,
  /\bimplement(?:ing|ation of)? [^.\n]{0,60} for (?:our )?(?:customer|client)s\b/i,
  /\b(?:customer|client) (?:onboarding|implementations?|deployments?|engagements?)\b/i,
  /\bpost-?sales\b/i,
  /\bprofessional services\b/i,
];

export const detectCustomerFacingDelivery: RoleShapeDetector = ({ title, description }) => {
  const titleHit = title.match(CUSTOMER_DELIVERY_TITLE);
  if (titleHit) {
    return { code: "CUSTOMER_FACING_DELIVERY", penalty: 0.06, source: "TITLE", quote: excerpt(title, titleHit.index ?? 0, titleHit[0].length) };
  }
  const hits = CUSTOMER_DELIVERY_CUES.map((cue) => ({ cue, match: description.match(cue) })).filter((entry) => entry.match);
  if (hits.length >= 2) {
    const first = hits[0]!.match!;
    return { code: "CUSTOMER_FACING_DELIVERY", penalty: 0.06, source: "DESCRIPTION", quote: excerpt(description, first.index ?? 0, first[0].length) };
  }
  // role_shape_v2 (gate-2026-11.7, owner decision 2026-11-25, decision #213): one pre-sales or customer-engagement duty
  // phrase of this role is a downrank here, no longer a gate rejection (src/pipeline/customerFacingDuties.ts).
  const duty = findCustomerFacingRoleDuty(description);
  if (duty) {
    const at = description.toLowerCase().indexOf(duty);
    return { code: "CUSTOMER_FACING_DELIVERY", penalty: 0.06, source: "DESCRIPTION", quote: at >= 0 ? excerpt(description, at, duty.length) : duty.slice(0, EVIDENCE_QUOTE_MAX) };
  }
  return null;
};

// ---------------------------------------------------------------------------------------------------------------
// People management as the core of the role: the job is to run a team, not to do the work.
// ---------------------------------------------------------------------------------------------------------------

const PEOPLE_MANAGEMENT_TITLE =
  /\b(?:head of|director|vp|vice president|chief|engineering manager|team lead|people manager|group manager|manager of)\b/i;
const PEOPLE_MANAGEMENT_CUES: RegExp[] = [
  /\bdirect reports?\b/i,
  /\bline[- ]manag(?:e|er|ement|ing)\b/i,
  /\bpeople[- ]manag(?:e|er|ement|ing)\b/i,
  /\b(?:manage|lead|build|grow) (?:and (?:lead|develop|grow) )?a (?:global |distributed )?team of\b/i,
  /\b(?:hire|hiring) and (?:develop|mentor|coach|retain)\b/i,
  /\bperformance reviews?\b/i,
  /\bcareer (?:development|growth) of (?:your|the) (?:team|reports)\b/i,
];

/** Cues that say the job is to run people. "performance reviews" and "hire and develop" also appear in individual-contributor postings. */
const DIRECT_REPORTS_CUE = /\bdirect reports?\b/i;
const LINE_MANAGEMENT_CUE = /\bline[- ]manag(?:e|er|ement|ing)\b/i;
const PEOPLE_MANAGEMENT_PHRASE_CUE = /\bpeople[- ]manag(?:e|er|ement|ing)\b/i;
const TEAM_OF_CUE = /\b(?:manage|lead|build|grow) (?:and (?:lead|develop|grow) )?a (?:global |distributed )?team of\b/i;
const STRONG_PEOPLE_CUES: RegExp[] = [DIRECT_REPORTS_CUE, LINE_MANAGEMENT_CUE, PEOPLE_MANAGEMENT_PHRASE_CUE, TEAM_OF_CUE];

export const detectPeopleManagementCore: RoleShapeDetector = ({ title, description }) => {
  // Managing a team is the core of the role only when the description says so: two separate cues, or a management title plus
  // one STRONG cue. A senior or director title with a single weak mention ("performance reviews") is an individual role.
  const hits = PEOPLE_MANAGEMENT_CUES.map((cue) => description.match(cue)).filter((match): match is RegExpMatchArray => match !== null);
  const strongHits = STRONG_PEOPLE_CUES.map((cue) => description.match(cue)).filter((match): match is RegExpMatchArray => match !== null);
  const titleHit = title.match(PEOPLE_MANAGEMENT_TITLE);
  if (hits.length >= 2 || (titleHit && strongHits.length >= 1)) {
    const first = (strongHits[0] ?? hits[0])!;
    return { code: "PEOPLE_MANAGEMENT_CORE", penalty: 0.08, source: "DESCRIPTION", quote: excerpt(description, first.index ?? 0, first[0].length) };
  }
  return null;
};


// ---------------------------------------------------------------------------------------------------------------
// Contract employment: kept allowed (the owner accepts contracts), ranked below equivalent permanent roles.
// ---------------------------------------------------------------------------------------------------------------

const CONTRACT_DESCRIPTION =
  /\b(?:(?:\d{1,2}|six|twelve|twelve|nine|three)[- ]months?(?: fixed[- ]term)? contract|fixed[- ]term contract|contract (?:role|position|basis|opportunity)|freelance(?:r)?|independent contractor|contractor position)\b/i;

// A negation counts only when it governs the contract phrase: the negation word, then nothing but the linking words below. Any other
// word, punctuation, dash, bracket or line break ends its reach, so "We offer no relocation, 12-month contract" and "Relocation is
// not offered for this 12-month contract" are still contracts. "non" is not a negation word here ("non-permanent" negates permanent).
const NEGATION_WORD = String.raw`(?:\b(?:not|no|never|without|cannot)|n['’]t)`;
const NEGATION_LINK = String.raw`(?:a|an|the|any|be|being|been|going to be|offer|offered|offering|hire|hired|hiring|engage|engaged|engaging|employ|employed|considered|looking for|on|as|via|through|or|rolling|temporary|(?:short|long|fixed)[- ]term)`;
const WORD_GAP = String.raw`[^\S\r\n]+`;
const CONTRACT_NOT_CONTRACT_BEFORE = new RegExp(`${NEGATION_WORD}${WORD_GAP}(?:${NEGATION_LINK}${WORD_GAP}){0,6}$`, "i");
/** "non-permanent", "not permanent", "not a permanent": a negated "permanent", which says nothing against the contract. */
const NEGATED_PERMANENT = /\b(?:non[- ]?|not (?:an? )?)(?:permanent|open[- ]ended|indefinite)\b/gi;
/** Unicode dashes (hyphen, non-breaking hyphen, en and em dash, minus) become "-", one character for one character so indexes hold. */
const normaliseDashes = (text: string): string => text.replace(/[‐-―−]/g, "-");
// "permanent" only counts when it is not negated ("non-permanent", "not a permanent"): the lookbehinds keep those a contract.
const PERMANENT_WORD = String.raw`(?<!non[- ]?)(?<!not (?:an? )?)(?<!un)\b(?:permanent|open[- ]ended|indefinite)\b`;
/** Permanent wording that modifies the contract itself ("permanent contract basis"): directly before the contract phrase. */
const PERMANENT_BEFORE_CONTRACT = new RegExp(`${PERMANENT_WORD}[\\s,-]*$`, "i");
const PERMANENT_IN_TYPE = new RegExp(PERMANENT_WORD, "i");

export const detectContractEmployment: RoleShapeDetector = ({ description: rawDescription, employmentType: rawEmploymentType }) => {
  const description = normaliseDashes(rawDescription);
  const employmentType = normaliseDashes(rawEmploymentType);
  // "Permanent contract" is a permanent job: an employment type that says permanent is not a contract.
  if (/\b(?:CONTRACT|CONTRACTOR|FIXED[_ -]?TERM|FREELANCE)\b/i.test(employmentType) && !PERMANENT_IN_TYPE.test(employmentType)) {
    return { code: "CONTRACT_EMPLOYMENT", penalty: 0.05, source: "EMPLOYMENT_TYPE", quote: employmentType.slice(0, EVIDENCE_QUOTE_MAX) };
  }
  for (const hit of description.matchAll(new RegExp(CONTRACT_DESCRIPTION.source, "gi"))) {
    const index = hit.index ?? 0;
    const before = description.slice(Math.max(0, index - 40), index);
    // "not a fixed-term contract" is not a contract; "non-permanent" / "not permanent" is a negated permanent, not a negated contract.
    // It is replaced by a full stop so that removing it never joins an earlier negation to the contract phrase.
    const beforeWithoutNegatedPermanent = before.replace(NEGATED_PERMANENT, ".");
    if (CONTRACT_NOT_CONTRACT_BEFORE.test(beforeWithoutNegatedPermanent)) continue;
    // "permanent contract basis" is a permanent job. "contract role, may convert to permanent" is still a contract.
    if (PERMANENT_BEFORE_CONTRACT.test(before)) continue;
    return { code: "CONTRACT_EMPLOYMENT", penalty: 0.05, source: "DESCRIPTION", quote: excerpt(description, index, hit[0].length) };
  }
  return null;
};


// ---------------------------------------------------------------------------------------------------------------
// Infrastructure by description: the title does not say so (title rules reject those), but the duties are operating
// infrastructure. Needs four different cues so a passing mention of one tool does not count.
// ---------------------------------------------------------------------------------------------------------------

const INFRASTRUCTURE_CUES: RegExp[] = [
  /\bkubernetes\b/i,
  /\bterraform\b/i,
  /\bansible\b/i,
  /\bhelm\b/i,
  /\bon[- ]call\b/i,
  /\bci\/cd\b/i,
  /\binfrastructure as code\b/i,
  /\bsite reliability\b|\bSRE\b/,
  /\bdevops\b/i,
  /\bincident (?:response|management)\b/i,
  /\bprometheus\b|\bgrafana\b|\bobservability\b/i,
  /\bcloud infrastructure\b/i,
];

export const detectInfrastructureByDescription: RoleShapeDetector = ({ description }) => {
  const hits = INFRASTRUCTURE_CUES.map((cue) => description.match(cue)).filter((match): match is RegExpMatchArray => match !== null);
  if (hits.length < 4) return null;
  return { code: "INFRASTRUCTURE_BY_DESCRIPTION", penalty: 0.08, source: "DESCRIPTION", quote: excerpt(description, hits[0]!.index ?? 0, hits[0]![0].length) };
};


// ---------------------------------------------------------------------------------------------------------------
// Degree gap: a MUST degree (for example a PhD) the profile does not meet. Ranked lower and flagged, never a block.
// ---------------------------------------------------------------------------------------------------------------

export const detectDegreeGapFlagged: RoleShapeDetector = ({ degreeGapQuote }) => {
  if (!degreeGapQuote) return null;
  return { code: "DEGREE_GAP_FLAGGED", penalty: 0.06, source: "DESCRIPTION", quote: degreeGapQuote.replace(/\s+/g, " ").trim().slice(0, EVIDENCE_QUOTE_MAX) };
};

const DETECTORS: RoleShapeDetector[] = [detectCustomerFacingDelivery, detectPeopleManagementCore, detectContractEmployment, detectInfrastructureByDescription, detectDegreeGapFlagged];

export function assessRoleShape(input: RoleShapeInput, detectors: RoleShapeDetector[] = DETECTORS): RoleShapeAssessment {
  const normalized = {
    title: String(input.title ?? ""),
    description: String(input.description ?? ""),
    employmentType: String(input.employmentType ?? ""),
    degreeGapQuote: input.degreeGapQuote ? String(input.degreeGapQuote) : null,
  };
  const signals = detectors.map((detect) => detect(normalized)).filter((signal): signal is RoleShapeSignal => signal !== null);
  const total = Math.min(ROLE_SHAPE_MAX_TOTAL_PENALTY, signals.reduce((sum, signal) => sum + signal.penalty, 0));
  return { policy_version: ROLE_SHAPE_POLICY_VERSION, signals, total_penalty: Number(total.toFixed(4)) };
}

/** The score the ranking uses: the raw score lowered by the total penalty. A null score stays null. */
export function applyRoleShapePenalty(rawScore: number | null, assessment: RoleShapeAssessment): number | null {
  if (rawScore === null) return null;
  return Number((rawScore * (1 - assessment.total_penalty)).toFixed(3));
}

export function roleShapeFingerprint(assessment: RoleShapeAssessment): string {
  return createHash("sha256").update(JSON.stringify(assessment)).digest("hex");
}
