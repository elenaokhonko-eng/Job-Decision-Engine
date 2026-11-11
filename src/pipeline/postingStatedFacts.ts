/**
 * What the posting itself states about each workability fact a user can confirm.
 *
 * A confirmed fact may fill only a fact that is unknown in every kind of posting evidence the gate
 * and readiness read: structured fields, extracted requirement rows, the description (through the
 * same extractors the gate uses: `evaluateWorkability`, `extractWorkModeFromText`,
 * `extractHybridAttendance`, `extractTravelRequirement`, the territory extractors) and, when
 * available, the normalized source evidence readiness uses. A CONFLICTING source statement counts
 * as stated: the posting contradicts itself and the user is shown the conflict instead.
 */
import type { ConfirmedFactType } from "../contracts/jobConfirmedFacts.js";
import { evaluateWorkability, extractHybridAttendance, extractTravelRequirement } from "../services/criteria.js";
import { extractWorkModeFromText } from "../services/workModeEnrichment.js";
import { normalizeWorkMode } from "./workModeNormalizer.js";
import {
  extractExplicitWorkerTerritoryRequirements,
  extractTerritories,
  normalizeTerritories,
  type WorkabilityPolicy,
} from "./workabilityPolicy.js";

export type PostingFactState = "UNKNOWN" | "STATED" | "CONFLICTING";
export type PostingFactSource = "STRUCTURED_FIELD" | "EXTRACTED_REQUIREMENT" | "DESCRIPTION" | "SOURCE_EVIDENCE";

/** The posting's side of one fact. `value` uses the confirmed-fact value shape where it is known. */
export interface PostingFactEvidence {
  readonly state: PostingFactState;
  readonly value: Record<string, unknown> | null;
  readonly source: PostingFactSource | null;
  readonly evidence: string | null;
}

export interface PostingRequirementRow {
  readonly requirement_type: string;
  readonly requirement_text: string;
  readonly quote_text: string | null;
  readonly structured_value: Record<string, unknown> | null;
}

/** Normalized source evidence fields readiness reads (job_source_evidence workability block). */
export interface PostingSourceEvidence {
  readonly work_mode?: { readonly status: string; readonly value?: string | null; readonly office_days_max?: number | null } | null;
  readonly travel_pct?: { readonly status: string; readonly maximum?: number | null } | null;
  readonly hiring_territories?: { readonly status: string; readonly countries?: readonly string[] } | null;
}

export interface PostingFactInput {
  readonly workplaceType: string | null | undefined;
  readonly employmentType: string | null | undefined;
  readonly location: string | null | undefined;
  readonly sourceLocation?: string | null | undefined;
  readonly description: string | null | undefined;
  readonly companyName?: string | null | undefined;
  readonly requirements: readonly PostingRequirementRow[];
  readonly sourceEvidence?: PostingSourceEvidence | null;
  readonly policy: WorkabilityPolicy;
}

export type PostingFacts = Readonly<Record<ConfirmedFactType, PostingFactEvidence>>;

const UNKNOWN: PostingFactEvidence = { state: "UNKNOWN", value: null, source: null, evidence: null };

function stated(value: Record<string, unknown> | null, source: PostingFactSource, evidence: string | null): PostingFactEvidence {
  return { state: "STATED", value, source, evidence: evidence ? evidence.slice(0, 300) : null };
}

function conflicting(evidence: string): PostingFactEvidence {
  return { state: "CONFLICTING", value: null, source: "SOURCE_EVIDENCE", evidence };
}

function text(requirement: PostingRequirementRow): string {
  return requirement.quote_text || requirement.requirement_text || "";
}

function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function structuredNumber(requirement: PostingRequirementRow, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = numeric(requirement.structured_value?.[key]);
    if (value !== null) return value;
  }
  return null;
}

type Mode = "ONSITE" | "HYBRID" | "REMOTE";

function workModeOf(input: PostingFactInput): PostingFactEvidence {
  const raw = String(input.workplaceType ?? "").trim();
  const structured = normalizeWorkMode(raw);
  // ASSUMED_HYBRID is a policy assumption stored by enrichment, not employer evidence.
  if (raw.toUpperCase() !== "ASSUMED_HYBRID" && structured !== "UNKNOWN") {
    return stated({ work_mode: structured }, "STRUCTURED_FIELD", `workplace type: ${raw}`);
  }
  for (const requirement of input.requirements) {
    if (requirement.requirement_type !== "WORK_MODE") continue;
    const mode = normalizeWorkMode(text(requirement));
    if (mode !== "UNKNOWN") return stated({ work_mode: mode }, "EXTRACTED_REQUIREMENT", text(requirement));
  }
  const source = input.sourceEvidence?.work_mode;
  if (source?.status === "CONFLICTING") return conflicting("The posting's work-mode statements conflict.");
  if (source?.status === "SUPPORTED" && source.value && source.value !== "UNKNOWN") {
    return stated({ work_mode: source.value }, "SOURCE_EVIDENCE", `normalized source evidence: ${source.value}`);
  }
  const description = String(input.description ?? "");
  const fromText = extractWorkModeFromText(description);
  if (fromText.workplace_type !== "UNKNOWN") {
    return stated({ work_mode: fromText.workplace_type }, "DESCRIPTION", fromText.evidence_quote);
  }
  // The gate's own work-mode evaluation, with territory and agency rules neutralized so only the
  // work-mode signals decide. Anything other than "unknown work mode" means the posting states one.
  const probe = evaluateWorkability(
    input.location ?? "",
    // No structured mode is stated here (an ASSUMED_HYBRID value is a policy assumption).
    "",
    description,
    input.employmentType ?? "",
    {
      ...input.policy,
      authorizedRegions: [],
      rejectExplicitForeignTerritory: false,
      unknownWorkAuthorizationNeedsVerification: false,
      remoteWithoutTerritoryAllowed: true,
      rejectAgencyContractPlacements: false,
    },
    null,
    input.companyName ?? "",
  );
  if (probe.reasonCode === "GATE_UNKNOWN_WORK_MODE") return UNKNOWN;
  if (probe.reasonCode === "WORK_AUTHORIZATION_INCOMPATIBLE") return UNKNOWN;
  const facts = probe.facts ?? {};
  const mode: Mode | null = probe.reasonCode === "GATE_HIGH_OFFICE_DAYS"
    ? "ONSITE"
    : facts.attendance_basis === "REMOTE" || facts.office_days_max === 0
      ? "REMOTE"
      : facts.attendance_basis === "POLICY_HYBRID_3_2" || facts.attendance_basis === "EMPLOYER_STATED"
        ? "HYBRID"
        : null;
  if (mode === null) return UNKNOWN;
  return stated({ work_mode: mode }, "DESCRIPTION", probe.reason ?? `work mode ${mode.toLowerCase()} in the posting text`);
}

function officeDaysOf(input: PostingFactInput, workMode: PostingFactEvidence): PostingFactEvidence {
  for (const requirement of input.requirements) {
    if (requirement.requirement_type !== "OFFICE_DAYS" && requirement.requirement_type !== "WORK_MODE") continue;
    const days = requirement.requirement_type === "OFFICE_DAYS"
      ? structuredNumber(requirement, ["office_days_per_week", "max_office_days_per_week", "office_days_max", "office_days_min"])
      : null;
    if (days !== null) {
      return stated({ office_days_min: days, office_days_max: days }, "EXTRACTED_REQUIREMENT", text(requirement));
    }
    const attendance = extractHybridAttendance(text(requirement));
    if (attendance) {
      return stated(
        { office_days_min: attendance.office_days_min, office_days_max: attendance.office_days_max },
        "EXTRACTED_REQUIREMENT",
        text(requirement),
      );
    }
  }
  const source = input.sourceEvidence?.work_mode;
  if (source?.status === "CONFLICTING") return conflicting("The posting's work-mode statements conflict.");
  if (source?.status === "SUPPORTED" && typeof source.office_days_max === "number") {
    return stated({ office_days_min: null, office_days_max: source.office_days_max }, "SOURCE_EVIDENCE", "normalized source evidence");
  }
  const attendance = extractHybridAttendance(String(input.description ?? ""));
  if (attendance) {
    return stated(
      { office_days_min: attendance.office_days_min, office_days_max: attendance.office_days_max },
      "DESCRIPTION",
      attendance.evidence.join("; "),
    );
  }
  // A stated remote role states zero office days; a stated on-site role states a full week.
  const mode = workMode.state === "STATED" ? workMode.value?.work_mode : null;
  if (mode === "REMOTE") return stated({ office_days_min: 0, office_days_max: 0 }, workMode.source ?? "DESCRIPTION", workMode.evidence);
  if (mode === "ONSITE") return stated({ office_days_min: 4, office_days_max: 5 }, workMode.source ?? "DESCRIPTION", workMode.evidence);
  return UNKNOWN;
}

const TRAVEL_NEGATION = /\b(?:no|without)\s+(?:required\s+|regular\s+|business\s+)?(?:travel|business trips?)\b|\b(?:travel|business trips?)\b[^;\n]{0,40}\b(?:not required|not expected|not needed|isn't required|is not required|is not expected)\b/i;
const FREQUENT_TRAVEL = /\b(?:frequent(?:ly)?\s+travel|travel(?:ling|ing)?\s+(?:extensively|frequently)|extensive\s+travel)\b/i;

function travelOf(input: PostingFactInput): PostingFactEvidence {
  for (const requirement of input.requirements) {
    if (requirement.requirement_type !== "TRAVEL") continue;
    const pct = structuredNumber(requirement, ["max_travel_pct", "travel_pct_max", "travel_percentage", "maximum_travel_pct"])
      ?? extractTravelRequirement(text(requirement))?.max_pct
      ?? null;
    if (pct !== null) return stated({ travel_pct_max: pct }, "EXTRACTED_REQUIREMENT", text(requirement));
  }
  const source = input.sourceEvidence?.travel_pct;
  if (source?.status === "CONFLICTING") return conflicting("The posting's travel statements conflict.");
  if (source?.status === "SUPPORTED" && typeof source.maximum === "number") {
    return stated({ travel_pct_max: source.maximum }, "SOURCE_EVIDENCE", "normalized source evidence");
  }
  const description = String(input.description ?? "");
  const pct = extractTravelRequirement(description);
  if (pct) return stated({ travel_pct_max: pct.max_pct }, "DESCRIPTION", pct.evidence);
  const frequent = description.match(FREQUENT_TRAVEL);
  if (frequent) return stated({ travel: "FREQUENT" }, "DESCRIPTION", frequent[0]);
  const negation = description.match(TRAVEL_NEGATION);
  if (negation) return stated({ travel_pct_max: 0 }, "DESCRIPTION", negation[0]);
  return UNKNOWN;
}

const ON_CALL = /\bon[- ]call\b|\b24\/7 support\b/i;
const ON_CALL_NEGATION = /\b(?:no|without)\s+(?:regular\s+)?on[- ]call\b|\bon[- ]call\b[^.;\n]{0,30}\bnot required\b/i;

function onCallOf(input: PostingFactInput): PostingFactEvidence {
  const requirement = input.requirements.find((row) => row.requirement_type === "ON_CALL");
  if (requirement) return stated({ on_call_required: true }, "EXTRACTED_REQUIREMENT", text(requirement));
  const description = String(input.description ?? "");
  const negation = description.match(ON_CALL_NEGATION);
  if (negation) return stated({ on_call_required: false }, "DESCRIPTION", negation[0]);
  const mention = description.match(ON_CALL);
  if (mention) return stated({ on_call_required: true }, "DESCRIPTION", mention[0]);
  return UNKNOWN;
}

function employmentValue(raw: string): string {
  const upper = raw.trim().toUpperCase();
  if (upper.includes("CONTRACT")) return "CONTRACT";
  if (upper.includes("PERMANENT") || /FULL[-_ ]?TIME/.test(upper) || upper === "FTE") return "PERMANENT";
  return upper.replace(/[\s-]+/g, "_");
}

const NON_STANDARD_EMPLOYMENT = /\b(?:intern(?:ship)?|part[- ]time|apprentice(?:ship)?|freelance|casual|temporary|temp)\b/i;

function employmentOf(input: PostingFactInput): PostingFactEvidence {
  const requirement = input.requirements.find((row) => row.requirement_type === "EMPLOYMENT_TYPE");
  if (requirement) return stated({ employment_type: employmentValue(text(requirement)) }, "EXTRACTED_REQUIREMENT", text(requirement));
  const raw = String(input.employmentType ?? "").trim();
  if (raw !== "" && raw.toUpperCase() !== "UNKNOWN") {
    return stated({ employment_type: employmentValue(raw) }, "STRUCTURED_FIELD", `employment type: ${raw}`);
  }
  const description = String(input.description ?? "");
  // The gate's own employment inference from the description (contract, fixed-term, full-time ...).
  const inferred = evaluateWorkability("", "UNKNOWN", description, "", input.policy).facts?.employment_type;
  if (inferred === "PERMANENT" || inferred === "CONTRACT") {
    return stated({ employment_type: inferred }, "DESCRIPTION", `employment inferred from the description: ${inferred.toLowerCase()}`);
  }
  const other = description.match(NON_STANDARD_EMPLOYMENT);
  if (other) return stated({ employment_type: employmentValue(other[0]) }, "DESCRIPTION", other[0]);
  return UNKNOWN;
}

function locationOf(input: PostingFactInput): PostingFactEvidence {
  const structured = extractTerritories(input.location ?? "");
  if (structured.length > 0) return stated({ territories: structured }, "STRUCTURED_FIELD", `location: ${input.location}`);
  const sourceLocation = extractTerritories(input.sourceLocation ?? "");
  if (sourceLocation.length > 0) return stated({ territories: sourceLocation }, "STRUCTURED_FIELD", `location: ${input.sourceLocation}`);
  const source = input.sourceEvidence?.hiring_territories;
  if (source?.status === "CONFLICTING") return conflicting("The posting's hiring-territory statements conflict.");
  if (source?.status === "SUPPORTED" && (source.countries?.length ?? 0) > 0) {
    return stated({ territories: normalizeTerritories([...(source.countries ?? [])]) }, "SOURCE_EVIDENCE", "normalized source evidence");
  }
  const requirements = extractExplicitWorkerTerritoryRequirements(String(input.description ?? ""));
  if (requirements.length > 0) {
    const territories = [...new Set(requirements.flatMap((requirement) => normalizeTerritories([...requirement.territories])))];
    return stated({ territories }, "DESCRIPTION", requirements[0].evidenceText);
  }
  return UNKNOWN;
}

export function assessPostingFacts(input: PostingFactInput): PostingFacts {
  const workMode = workModeOf(input);
  return {
    WORK_MODE: workMode,
    OFFICE_DAYS: officeDaysOf(input, workMode),
    TRAVEL_PCT: travelOf(input),
    ON_CALL: onCallOf(input),
    EMPLOYMENT_TYPE: employmentOf(input),
    LOCATION: locationOf(input),
  };
}

export type ConfirmedFactAssessmentOutcome = "FILLS_UNKNOWN" | "MATCHES_POSTING" | "CONFLICTS_WITH_POSTING";

/** Compare a confirmed value with the posting's side of the same fact. */
export function assessConfirmedValue(
  factType: ConfirmedFactType,
  confirmed: Record<string, unknown>,
  posting: PostingFactEvidence,
): ConfirmedFactAssessmentOutcome {
  if (posting.state === "UNKNOWN") return "FILLS_UNKNOWN";
  if (posting.state === "CONFLICTING" || !posting.value) return "CONFLICTS_WITH_POSTING";
  const value = posting.value;
  switch (factType) {
    case "WORK_MODE":
      return value.work_mode === confirmed.work_mode ? "MATCHES_POSTING" : "CONFLICTS_WITH_POSTING";
    case "OFFICE_DAYS": {
      const low = numeric(value.office_days_min) ?? numeric(value.office_days_max);
      const high = numeric(value.office_days_max);
      const cLow = numeric(confirmed.office_days_min);
      const cHigh = numeric(confirmed.office_days_max);
      if (high === null || cLow === null || cHigh === null) return "CONFLICTS_WITH_POSTING";
      return cLow >= (low ?? high) && cHigh <= high ? "MATCHES_POSTING" : "CONFLICTS_WITH_POSTING";
    }
    case "TRAVEL_PCT": {
      const max = numeric(value.travel_pct_max);
      const cMax = numeric(confirmed.travel_pct_max);
      if (max === null || cMax === null) return "CONFLICTS_WITH_POSTING";
      return cMax <= max ? "MATCHES_POSTING" : "CONFLICTS_WITH_POSTING";
    }
    case "ON_CALL":
      return value.on_call_required === confirmed.on_call_required ? "MATCHES_POSTING" : "CONFLICTS_WITH_POSTING";
    case "EMPLOYMENT_TYPE":
      return value.employment_type === confirmed.employment_type ? "MATCHES_POSTING" : "CONFLICTS_WITH_POSTING";
    case "LOCATION": {
      const postingTerritories = new Set(Array.isArray(value.territories) ? value.territories.map(String) : []);
      const confirmedTerritories = Array.isArray(confirmed.territories) ? confirmed.territories.map(String) : [];
      return confirmedTerritories.length > 0 && confirmedTerritories.every((territory) => postingTerritories.has(territory))
        ? "MATCHES_POSTING"
        : "CONFLICTS_WITH_POSTING";
    }
  }
}

/** A short description of the posting's side, for evidence lines and the conflict display. */
export function describePostingValue(posting: PostingFactEvidence): string {
  if (posting.state === "CONFLICTING") return "conflicting statements";
  if (!posting.value) return "unknown";
  const value = posting.value;
  if (typeof value.work_mode === "string") return `work mode ${String(value.work_mode).toLowerCase()}`;
  if ("office_days_max" in value) {
    const low = value.office_days_min ?? value.office_days_max;
    return low === value.office_days_max ? `${value.office_days_max} office days per week` : `${low}-${value.office_days_max} office days per week`;
  }
  if (value.travel === "FREQUENT") return "frequent travel";
  if ("travel_pct_max" in value) return Number(value.travel_pct_max) === 0 ? "no travel" : `travel up to ${value.travel_pct_max}%`;
  if ("on_call_required" in value) return value.on_call_required ? "on-call required" : "no on-call";
  if (typeof value.employment_type === "string") return `${String(value.employment_type).toLowerCase().replaceAll("_", " ")} employment`;
  if (Array.isArray(value.territories)) return `location ${value.territories.join(", ")}`;
  return "stated in the posting";
}
