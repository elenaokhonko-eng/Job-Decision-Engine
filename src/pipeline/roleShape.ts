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
/** Cues that say the job is to run people. */
const STRONG_PEOPLE_CUES: RegExp[] = [
  /\bdirect reports?\b/i,
  /\bline[- ]manag(?:e|er|ement|ing)\b/i,
  /\bpeople[- ]manag(?:e|er|ement|ing)\b/i,
  /\b(?:(?:manage|lead|build|grow) (?:and (?:lead|develop|grow) )?a|(?:manage|lead) (?:our|the)) (?:global |distributed )?team of\b/i,
  /\b(?:manage|lead)(?: and develop)? engineering managers\b/i,
];
/** "performance reviews", "hire and develop" and the like also appear in individual-contributor postings. */
const WEAK_PEOPLE_CUES: RegExp[] = [
  /\b(?:hire|hiring) and (?:develop|mentor|coach|retain)\b/i,
  /\bperformance reviews?\b/i,
  /\bcareer (?:development|growth) (?:of|for) (?:your|the) (?:team|reports|engineers)\b/i,
  /\b(?:lead|manage) the team\b/i,
];
// A cue the posting denies ("no direct reports") or only advises others about is not this role's duty. Both patterns must end
// where the cue starts, so any other word or punctuation in between leaves the cue counted.
const PEOPLE_CUE_DENIED_BEFORE = /\b(?:no|without|not have(?: any)?)\s+$/i;
const PEOPLE_CUE_ADVISED_BEFORE = /\badvis(?:e|es|ing)(?: [\w-]+)? on (?:(?:line|people)[- ]management(?: and|,) )?$/i;

/** The first mention of the cue that is this role's own duty. */
function ownCueMatch(description: string, cue: RegExp): RegExpMatchArray | null {
  for (const match of description.matchAll(new RegExp(cue.source, "gi"))) {
    const before = description.slice(Math.max(0, (match.index ?? 0) - 60), match.index ?? 0);
    if (!PEOPLE_CUE_DENIED_BEFORE.test(before) && !PEOPLE_CUE_ADVISED_BEFORE.test(before)) return match;
  }
  return null;
}

export const detectPeopleManagementCore: RoleShapeDetector = ({ title, description }) => {
  // Managing a team is the core of the role only when the description says so: two separate cues, or a management title plus
  // one STRONG cue. A senior or director title with a single weak mention ("performance reviews") is an individual role.
  const own = (cues: RegExp[]) => cues.map((cue) => ownCueMatch(description, cue)).filter((match): match is RegExpMatchArray => match !== null);
  const strongHits = own(STRONG_PEOPLE_CUES);
  const hits = [...strongHits, ...own(WEAK_PEOPLE_CUES)];
  if (hits.length >= 2 || (PEOPLE_MANAGEMENT_TITLE.test(title) && strongHits.length >= 1)) {
    const first = hits[0]!; // a strong cue when there is one
    return { code: "PEOPLE_MANAGEMENT_CORE", penalty: 0.08, source: "DESCRIPTION", quote: excerpt(description, first.index ?? 0, first[0].length) };
  }
  return null;
};


// ---------------------------------------------------------------------------------------------------------------
// Contract employment: kept allowed (the owner accepts contracts), ranked below equivalent permanent roles.
// ---------------------------------------------------------------------------------------------------------------

const CONTRACT_DESCRIPTION =
  /\b(?:(?:\d{1,2}|six|twelve|twelve|nine|three)[- ]months?(?: fixed[- ]term)? contract|fixed[- ]term contract|contract (?:role|position|basis|opportunity)|freelance(?:r)?|independent contractor|contractor position)\b/i;

// A contract mention is ignored only for these fixed forms of "this job is not a contract", each ending where the contract phrase
// starts. Anything else ("not offered on a 12-month contract", "Relocation: No 6-month contract", "Why not be a freelancer") stays
// a contract: posting text is often whitespace-collapsed, and a missed contract is worse than a 5% downrank too many.
const CONTRACT_NOT_CONTRACT_BEFORE = new RegExp(
  "(?:" +
    [
      String.raw`(?:(?<!\bor )\b(?:not|never)|n['’]t)\s+an?(?:\s+short[- ]term or)?`, // "is not a ...", "isn't a ..."
      String.raw`\bthere (?:is|are) no`,
      String.raw`(?:^|[.!]\s+)no`, // "No 6-month contract here", at the start of a sentence only
      String.raw`\bnot be (?:hired|employed|engaged) (?:on|as) an?`,
      String.raw`\bcannot engage an?`,
      String.raw`\bdo not offer`,
    ].join("|") +
    String.raw`)\s+$`,
  "i",
);
/** Unicode dashes (hyphen, non-breaking hyphen, en and em dash, minus) become "-", one character for one character so indexes hold. */
const normaliseDashes = (text: string): string => text.replace(/[‐-―−]/g, "-");
/** Permanent wording directly before the contract phrase ("permanent contract basis"). */
const PERMANENT_BEFORE_CONTRACT = /\b(?:permanent|open[- ]ended|indefinite)[\s,-]*$/i;
/** What stands before that permanent word when it is negated or only a prospect ("isn't a permanent", "temp-to-permanent"). */
const PERMANENT_DENIED_BEFORE = /(?:(?:\b(?:not|no|never|instead of|rather than)|n['’]t)(?:\s+(?:a|an|the|strictly))*\s+|\bnon-|\bto[\s-]+)$/i;
/** An employment type is permanent only when it holds nothing but these words: "Contract to permanent" or "no permanent headcount" is not. */
const PERMANENT_TYPE_WORDS = /\b(?:permanent|open[- ]ended|indefinite|contract|employment|full[- ]time)\b/gi;

function isPermanentType(employmentType: string): boolean {
  return /\b(?:permanent|open[- ]ended|indefinite)\b/i.test(employmentType) && !/[a-z]/i.test(employmentType.replace(PERMANENT_TYPE_WORDS, ""));
}

function saysPermanentContract(before: string): boolean {
  const permanent = PERMANENT_BEFORE_CONTRACT.exec(before);
  return permanent !== null && !PERMANENT_DENIED_BEFORE.test(before.slice(0, permanent.index));
}

export const detectContractEmployment: RoleShapeDetector = ({ description: rawDescription, employmentType: rawEmploymentType }) => {
  const description = normaliseDashes(rawDescription);
  const employmentType = normaliseDashes(rawEmploymentType);
  // "Permanent contract" is a permanent job.
  if (/\b(?:CONTRACT|CONTRACTOR|FIXED[_ -]?TERM|FREELANCE)\b/i.test(employmentType) && !isPermanentType(employmentType)) {
    return { code: "CONTRACT_EMPLOYMENT", penalty: 0.05, source: "EMPLOYMENT_TYPE", quote: employmentType.slice(0, EVIDENCE_QUOTE_MAX) };
  }
  for (const hit of description.matchAll(new RegExp(CONTRACT_DESCRIPTION.source, "gi"))) {
    const index = hit.index ?? 0;
    const start = Math.max(0, index - 60);
    // The "_" keeps a cut-off window from looking like the start of the text.
    const before = (start > 0 ? "_" : "") + description.slice(start, index);
    if (CONTRACT_NOT_CONTRACT_BEFORE.test(before) || saysPermanentContract(before)) continue;
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
