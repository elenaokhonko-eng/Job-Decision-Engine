/**
 * Role-shape downranks (W3). A role can fit the lanes and still be shaped in a way the owner does not want as the
 * core of the job: delivering to customers, managing people, contract employment, running infrastructure. These are
 * downranks, never rejections (AGENTS.md invariant 11): each signal lowers the ranking score by a fixed share, every
 * signal carries the posting words that triggered it, and the raw score stays in the decision trace. Pure and
 * deterministic: the same title and description always give the same assessment.
 */
import { createHash } from "node:crypto";

export const ROLE_SHAPE_POLICY_VERSION = "role_shape_v1";
/** The combined downrank never exceeds this share of the score, so a job can lose rank but is never erased by it. */
export const ROLE_SHAPE_MAX_TOTAL_PENALTY = 0.15;
const EVIDENCE_QUOTE_MAX = 160;

export interface RoleShapeInput {
  title: string | null | undefined;
  description: string | null | undefined;
  employmentType?: string | null | undefined;
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

export type RoleShapeDetector = (input: { title: string; description: string; employmentType: string }) => RoleShapeSignal | null;

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

export const detectPeopleManagementCore: RoleShapeDetector = ({ title, description }) => {
  // A management-sounding title alone is not evidence: "Lead" and "Manager" are often individual roles. Managing a team
  // is the core of the role only when the description says so: two separate cues, or a management title plus one cue.
  const hits = PEOPLE_MANAGEMENT_CUES.map((cue) => description.match(cue)).filter((match): match is RegExpMatchArray => match !== null);
  const titleHit = title.match(PEOPLE_MANAGEMENT_TITLE);
  if (hits.length >= 2 || (titleHit && hits.length >= 1)) {
    const first = hits[0]!;
    return { code: "PEOPLE_MANAGEMENT_CORE", penalty: 0.08, source: "DESCRIPTION", quote: excerpt(description, first.index ?? 0, first[0].length) };
  }
  return null;
};


// ---------------------------------------------------------------------------------------------------------------
// Contract employment: kept allowed (the owner accepts contracts), ranked below equivalent permanent roles.
// ---------------------------------------------------------------------------------------------------------------

const CONTRACT_DESCRIPTION =
  /\b(?:(?:\d{1,2}|six|twelve|twelve|nine|three)[- ]months?(?: fixed[- ]term)? contract|fixed[- ]term contract|contract (?:role|position|basis|opportunity)|freelance(?:r)?|independent contractor|contractor position)\b/i;

export const detectContractEmployment: RoleShapeDetector = ({ description, employmentType }) => {
  if (/\b(?:CONTRACT|CONTRACTOR|FIXED[_ -]?TERM|FREELANCE)\b/i.test(employmentType)) {
    return { code: "CONTRACT_EMPLOYMENT", penalty: 0.05, source: "EMPLOYMENT_TYPE", quote: employmentType.slice(0, EVIDENCE_QUOTE_MAX) };
  }
  const hit = description.match(CONTRACT_DESCRIPTION);
  if (hit) return { code: "CONTRACT_EMPLOYMENT", penalty: 0.05, source: "DESCRIPTION", quote: excerpt(description, hit.index ?? 0, hit[0].length) };
  return null;
};

const DETECTORS: RoleShapeDetector[] = [detectCustomerFacingDelivery, detectPeopleManagementCore, detectContractEmployment];

export function assessRoleShape(input: RoleShapeInput, detectors: RoleShapeDetector[] = DETECTORS): RoleShapeAssessment {
  const normalized = {
    title: String(input.title ?? ""),
    description: String(input.description ?? ""),
    employmentType: String(input.employmentType ?? ""),
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
