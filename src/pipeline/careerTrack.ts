/**
 * Track-aware seniority policy.
 *
 * A candidate's experience differs by career track (for example 20 years in data management
 * but under two years of hands-on ML engineering), so one global seniority floor would demote
 * exactly the transition roles the candidate is moving into. This module classifies a job into a
 * track from its title (and, for generic engineering titles, its requirements), reads the job's
 * level from the title and stated minimum years, and compares that level with the candidate's
 * years in the same track. The years come from the active profile; nothing here is
 * candidate-specific.
 *
 * The result only ever lowers a deterministic outcome (PRIORITY -> REVIEW, or out to SKIP). It
 * never raises one and never sets a hard gate.
 */

import { ExperienceByTrackSchema } from "../profile/contracts.js";

export const CAREER_TRACK_POLICY_VERSION = "career_track_v2";

export const CAREER_TRACKS = [
  "DATA_MANAGEMENT",
  "ARCHITECTURE",
  "PRODUCT",
  "HANDS_ON_AI_DATA",
  "AI_BRIDGE",
  "GENERIC_SOFTWARE",
] as const;
export type CareerTrack = (typeof CAREER_TRACKS)[number];
export type ClassifiedTrack = CareerTrack | "UNCLASSIFIED";

export type JobLevel = "ENTRY" | "MID" | "SENIOR" | "LEADERSHIP";
export type LevelFit = "OUT" | "STEP_DOWN" | "FIT" | "STRETCH";
export type CareerTrackTag = "BRIDGE" | "TRANSITION" | "STRETCH" | "STEP_DOWN" | "OFF_TRACK" | "TRACK_UNCLASSIFIED" | "TRACK_EXPERIENCE_MISSING";

export interface TrackExperience {
  readonly track: CareerTrack;
  readonly years: number;
}

export interface TrackRequirement {
  readonly requirement_type: string;
  readonly importance?: string | null;
  readonly requirement_text?: string | null;
  readonly structured_value?: Record<string, unknown> | null;
}

export interface CareerTrackAssessment {
  readonly policy_version: typeof CAREER_TRACK_POLICY_VERSION;
  readonly track: ClassifiedTrack;
  readonly track_basis: string;
  readonly level: JobLevel;
  readonly level_basis: string;
  readonly candidate_years: number | null;
  readonly required_min_years: number | null;
  readonly fit: LevelFit | null;
  readonly tags: readonly CareerTrackTag[];
  /** The highest outcome this assessment permits; null means no cap. */
  readonly outcome_cap: "REVIEW" | "SKIP" | null;
  readonly rationale: string;
}

const AI_TERM = String.raw`(?:ai|a\.i\.|artificial intelligence|gen ?ai|generative ai|llms?|machine learning|ml|agentic|ai agents?|nlp|computer vision|deep learning|mlops|foundation models?)`;
const AI = new RegExp(String.raw`\b${AI_TERM}\b`, "i");
const DATA_SCIENCE = /\b(?:data scien(?:ce|tists?)|applied scien(?:ce|tists?)|research scien(?:ce|tists?)|decision scien(?:ce|tists?)|research engineer|quant(?:itative)? (?:researcher|developer))\b/i;
const BRIDGE_ROLE = /\b(?:architect(?:ure)?|solutions?|product (?:manager|owner|lead|director|management)|governance|consult(?:ant|ing)|advis(?:or|ory)|strateg(?:y|ist)|transformation|enablement|adoption|success|evangelist|risk|ethics|policy|program(?:me)? manager|delivery|engagement)\b/i;
const FORWARD_DEPLOYED = /\bforward[- ]deployed\b/i;
const RESPONSIBLE_AI = /\b(?:responsible ai|ai governance|ai risk|ai ethics|ai assurance|model risk)\b/i;
const DATA_MANAGEMENT = /\b(?:data governance|master data|mdm|reference data|data management|data quality|data stewards?(?:hip)?|data strategy|data office|chief data|data operating model|operating model|data product (?:owner|manager)|data analysts?|data analytics|analytics (?:manager|lead|director)|business intelligence|bi (?:analyst|developer|consult\w*|lead)|reporting analyst|data lead|head of data|data (?:director|manager)|data & analytics|data and analytics|chief analytics)\b/i;
const DATA_ENGINEERING = /\b(?:data engineer(?:ing)?|analytics engineer|data platform|data infrastructure|data integration|lakehouse|etl|big data|spark|data pipeline)\b/i;
const DATA_GOVERNANCE = /\b(?:data governance|master data|mdm|reference data|data quality|data stewards?(?:hip)?|data strategy|data office|chief data|operating model)\b/i;
const AI_DATA_GIG = /\b(?:ai trainers?|ai tutors?|annotators?|data label+ers?|data label+ing|raters?|evaluators?)\b/i;
const ARCHITECTURE = /\barchitect(?:ure)?\b/i;
const PRODUCT = /\b(?:product (?:manager|owner|lead|director|management|head)|head of product|chief product officer|cpo|group product manager)\b/i;
// A data or platform product is a bridge into AI work for a senior product career.
const PRODUCT_BRIDGE_SCOPE = /\b(?:data|analytics|platforms?)\b/i;
const ENGINEERING = /\b(?:engineer(?:ing)?|developer|programmer|swe|sre|devops|dev ops|site reliability|full[- ]?stack|front[- ]?end|back[- ]?end|mobile|ios|android|qa|quality assurance|tester|coder)\b/i;

const LEADERSHIP_LEVEL = /\b(?:director|head of|head,|vice president|vp|chief|cto|cdo|cio|cao|cpo|svp|evp|managing director|executive director)\b/i;
const SENIOR_DOWNGRADE = /\b(?:associate director|assistant vice president|avp|deputy director)\b/i;
// "Product manager" or "programme manager" names a role, not a level; other managers lead people.
const SENIOR_LEVEL = /\b(?:senior|sr\.?|lead|staff|principal|expert|distinguished|fellow|(?<!product |program |programme |project )manager|iii|iv|level [3-9]|l[5-9])\b/i;
const ENTRY_LEVEL = /\b(?:intern(?:ship)?|graduate|grad|new grad|junior|jr\.?|entry[- ]level|trainee|apprentice|early careers?|accelerator program(?:me)?|campus|level 1|l[12])\b/i;
const ENTRY_ASSOCIATE = /^\s*associate\b(?!\s+(?:director|vice president|partner))/i;
const ENTRY_NUMERAL = /\b(?:[a-z]+)\s+(?:i|1)\s*(?:$|[,(\-–—|/])/i;
const MID_LEVEL = /\b(?:ii|2|intermediate|mid[- ]?level|mid[- ]?senior|level 2)\b/i;

function normalizedTitle(title: string): string {
  return String(title ?? "").replace(/\s+/g, " ").trim();
}

function mustRequirements(requirements: readonly TrackRequirement[]): TrackRequirement[] {
  return requirements.filter((requirement) => {
    const importance = String(requirement.importance ?? requirement.structured_value?.importance ?? "MUST").toUpperCase();
    return importance === "MUST" || importance === "REQUIRED";
  });
}

function requirementCorpus(requirement: TrackRequirement): string {
  return [requirement.requirement_text ?? "", JSON.stringify(requirement.structured_value ?? {})].join(" ");
}

/** Classify the career track from the title, using MUST requirements only to lift a generic engineering title. */
export function classifyCareerTrack(title: string, requirements: readonly TrackRequirement[] = []): { track: ClassifiedTrack; basis: string } {
  const text = normalizedTitle(title);
  const hasAi = AI.test(text) || DATA_SCIENCE.test(text);
  const leadership = LEADERSHIP_LEVEL.test(text) && !SENIOR_DOWNGRADE.test(text);

  // Data-labelling and model-rating gigs mention AI but are not AI engineering.
  if (AI_DATA_GIG.test(text)) return { track: "UNCLASSIFIED", basis: "AI training-data or rating gig" };
  if (FORWARD_DEPLOYED.test(text)) return { track: "AI_BRIDGE", basis: "title names a forward-deployed role" };
  if (RESPONSIBLE_AI.test(text)) return { track: "AI_BRIDGE", basis: "title names AI governance or risk" };
  if (hasAi && (BRIDGE_ROLE.test(text) || leadership)) {
    return { track: "AI_BRIDGE", basis: leadership ? "AI title at leadership level" : "AI title with an architecture, product, consulting or governance function" };
  }
  if (hasAi) return { track: "HANDS_ON_AI_DATA", basis: "AI, ML or data-science title" };
  if (ARCHITECTURE.test(text)) return { track: "ARCHITECTURE", basis: "architect title" };
  if (PRODUCT.test(text) && PRODUCT_BRIDGE_SCOPE.test(text)) return { track: "PRODUCT", basis: "data or platform product management title" };
  // "Analytics engineer" and "data engineer" are hands-on coding even with "data analytics" in the title.
  if (DATA_ENGINEERING.test(text) && !DATA_GOVERNANCE.test(text)) return { track: "HANDS_ON_AI_DATA", basis: "data engineering title" };
  if (DATA_MANAGEMENT.test(text)) return { track: "DATA_MANAGEMENT", basis: "data management, governance or analytics title" };
  if (PRODUCT.test(text)) return { track: "PRODUCT", basis: "product management title" };
  if (ENGINEERING.test(text)) {
    const aiRequirements = mustRequirements(requirements)
      .filter((requirement) => !["EXPERIENCE_YEARS", "WORK_AUTH", "OFFICE_DAYS", "WORK_MODE", "TRAVEL", "EMPLOYMENT_TYPE"].includes(requirement.requirement_type))
      .filter((requirement) => AI.test(requirementCorpus(requirement)) || DATA_SCIENCE.test(requirementCorpus(requirement)));
    if (aiRequirements.length >= 2) {
      return { track: "HANDS_ON_AI_DATA", basis: `engineering title with ${aiRequirements.length} mandatory AI/ML requirements` };
    }
    return { track: "GENERIC_SOFTWARE", basis: "engineering title without AI, ML or data scope" };
  }
  return { track: "UNCLASSIFIED", basis: "title matches no career track" };
}

/** The largest stated MUST minimum years, or null when none is stated. */
export function requiredMinimumYears(requirements: readonly TrackRequirement[]): number | null {
  const years = mustRequirements(requirements)
    .filter((requirement) => requirement.requirement_type === "EXPERIENCE_YEARS")
    .map((requirement) => Number(requirement.structured_value?.minimum_years))
    .filter((value) => Number.isFinite(value) && value > 0 && value <= 40);
  return years.length > 0 ? Math.max(...years) : null;
}

/** Read the job level from the title; stated minimum years decide only an unmarked title. */
export function classifyJobLevel(title: string, minimumYears: number | null): { level: JobLevel; basis: string } {
  const text = normalizedTitle(title);
  // "Senior / Software Engineer" or "Assistant / Manager" offers both levels; the highest one is used.
  if (LEADERSHIP_LEVEL.test(text) && !SENIOR_DOWNGRADE.test(text)) return { level: "LEADERSHIP", basis: "leadership title" };
  if (SENIOR_DOWNGRADE.test(text)) return { level: "SENIOR", basis: "senior title" };
  if (ENTRY_LEVEL.test(text) || ENTRY_ASSOCIATE.test(text) || ENTRY_NUMERAL.test(text)) return { level: "ENTRY", basis: "entry-level title" };
  if (SENIOR_LEVEL.test(text)) return { level: "SENIOR", basis: "senior title" };
  if (MID_LEVEL.test(text)) return { level: "MID", basis: "mid-level title" };
  if (minimumYears !== null && minimumYears >= 8) return { level: "SENIOR", basis: `unmarked title requiring ${minimumYears}+ years` };
  if (minimumYears !== null && minimumYears <= 1) return { level: "ENTRY", basis: `unmarked title requiring ${minimumYears} year(s)` };
  return { level: "MID", basis: minimumYears !== null ? `unmarked title requiring ${minimumYears} years` : "unmarked title" };
}

/** How a job level compares with the candidate's years in that track. */
export function levelFit(years: number, level: JobLevel): LevelFit {
  if (years >= 8) {
    return level === "ENTRY" ? "OUT" : level === "MID" ? "STEP_DOWN" : "FIT";
  }
  if (years >= 4) {
    return level === "ENTRY" ? "STEP_DOWN" : level === "LEADERSHIP" ? "STRETCH" : "FIT";
  }
  return level === "ENTRY" ? "OUT" : level === "MID" ? "FIT" : "STRETCH";
}

function yearsFor(experience: readonly TrackExperience[], track: CareerTrack): number | null {
  const match = experience.filter((entry) => entry.track === track && Number.isFinite(entry.years));
  return match.length > 0 ? Math.max(...match.map((entry) => entry.years)) : null;
}

/** Bridge roles draw on the candidate's senior non-AI experience, so they use the strongest of those tracks. */
function bridgeYears(experience: readonly TrackExperience[]): number | null {
  const candidates = (["DATA_MANAGEMENT", "ARCHITECTURE", "PRODUCT"] as const)
    .map((track) => yearsFor(experience, track))
    .filter((value): value is number => value !== null);
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

export function assessCareerTrack(input: {
  title: string;
  requirements?: readonly TrackRequirement[];
  experience: readonly TrackExperience[];
}): CareerTrackAssessment {
  const requirements = input.requirements ?? [];
  const { track, basis: trackBasis } = classifyCareerTrack(input.title, requirements);
  const requiredMinYears = requiredMinimumYears(requirements);
  const { level, basis: levelBasis } = classifyJobLevel(input.title, requiredMinYears);
  const base = {
    policy_version: CAREER_TRACK_POLICY_VERSION,
    track,
    track_basis: trackBasis,
    level,
    level_basis: levelBasis,
    required_min_years: requiredMinYears,
  } as const;

  if (track === "UNCLASSIFIED") {
    return {
      ...base,
      candidate_years: null,
      fit: null,
      tags: ["TRACK_UNCLASSIFIED"],
      outcome_cap: "REVIEW",
      rationale: "The title matches none of the candidate's career tracks, so it cannot be a priority match.",
    };
  }

  const years = track === "AI_BRIDGE"
    ? bridgeYears(input.experience)
    : track === "GENERIC_SOFTWARE"
      ? yearsFor(input.experience, "HANDS_ON_AI_DATA")
      : yearsFor(input.experience, track);
  if (years === null) {
    return {
      ...base,
      candidate_years: null,
      fit: null,
      tags: ["TRACK_EXPERIENCE_MISSING"],
      outcome_cap: null,
      rationale: `The active profile states no years of experience for ${track}; no seniority floor is applied.`,
    };
  }

  // A mid-level product role is a bridge when the product is AI, data or a platform; an
  // associate or junior product role is out at any product tenure.
  const productTitle = PRODUCT.test(normalizedTitle(input.title));
  const productBridge = level === "MID" && productTitle && (track === "AI_BRIDGE" || (track === "PRODUCT" && PRODUCT_BRIDGE_SCOPE.test(input.title)));
  const fit = track === "PRODUCT" && level === "ENTRY"
    ? "OUT"
    : (track === "AI_BRIDGE" && level === "MID") || productBridge ? "FIT" : levelFit(years, level);
  const tags: CareerTrackTag[] = [];
  let cap: "REVIEW" | "SKIP" | null = null;
  const reasons: string[] = [];

  if (fit === "OUT") {
    cap = "SKIP";
    reasons.push(`${level.toLowerCase()} ${track} role is below the candidate's ${years} years in this track`);
  } else if (fit === "STEP_DOWN") {
    cap = "REVIEW";
    tags.push("STEP_DOWN");
    reasons.push(`${level.toLowerCase()} level is a step down from ${years} years in ${track}`);
  } else if (fit === "STRETCH") {
    tags.push("STRETCH");
    // A stretch stays reviewable; it is held below PRIORITY only when the stated hands-on
    // experience bar is clearly beyond the candidate's years in this track.
    if (requiredMinYears !== null && requiredMinYears >= years + 3) {
      cap = "REVIEW";
      reasons.push(`requires ${requiredMinYears}+ years against the candidate's ${years} in ${track}`);
    } else {
      reasons.push(`${level.toLowerCase()} level is a stretch from ${years} years in ${track}`);
    }
  } else {
    reasons.push(`${level.toLowerCase()} level fits ${years} years in ${track}`);
  }

  if (track === "AI_BRIDGE" || productBridge) tags.push("BRIDGE");
  if (productBridge) tags.push("TRANSITION");
  if (track === "HANDS_ON_AI_DATA" && years < 4 && fit !== "OUT") tags.push("TRANSITION");
  if (track === "GENERIC_SOFTWARE") {
    tags.push("OFF_TRACK");
    if (cap === null) cap = "REVIEW";
    reasons.push("generic software engineering without AI or data scope");
  }

  return {
    ...base,
    candidate_years: years,
    fit,
    tags: [...new Set(tags)],
    outcome_cap: cap,
    rationale: reasons.join("; "),
  };
}

const OUTCOME_RANK: Record<string, number> = { SKIP: 0, TRACK: 1, REVIEW: 2, PRIORITY: 3 };

/** Apply a cap: lower the outcome to the cap, never raise it. */
export function capOutcome<T extends string>(outcome: T, cap: "REVIEW" | "SKIP" | null): T | "REVIEW" | "SKIP" {
  if (cap === null) return outcome;
  const current = OUTCOME_RANK[outcome];
  if (current === undefined) return outcome;
  return current > OUTCOME_RANK[cap]! ? cap : outcome;
}

/**
 * Read the active profile's stored experience_by_track. NULL means none was stated; a malformed
 * value throws, because silently dropping it would remove every seniority floor.
 */
export function parseTrackExperience(value: unknown): TrackExperience[] {
  if (value === null || value === undefined) return [];
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return ExperienceByTrackSchema.parse(parsed).map((entry) => ({ track: entry.track, years: entry.years }));
}
