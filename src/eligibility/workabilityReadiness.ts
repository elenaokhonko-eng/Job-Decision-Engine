import {
  evaluateWorkerTerritoryRequirements,
  extractExplicitWorkerTerritoryRequirements,
  splitWorkabilityClauses,
} from "../pipeline/workabilityPolicy.js";

export type WorkabilityReadinessStatus = "MET" | "BLOCKED" | "NEEDS_VERIFICATION" | "NOT_APPLICABLE";

export interface WorkabilityReadinessPolicy {
  readonly allowedWorkModes: readonly string[];
  readonly maxOfficeDaysPerWeek: number;
  readonly hardFailOfficeDaysPerWeek: number;
  readonly hybridWithoutOfficeDaysAllowed: boolean;
  readonly authorizedRegions: readonly string[];
  readonly remoteWithoutTerritoryAllowed: boolean;
  readonly rejectExplicitForeignTerritory: boolean;
  readonly unknownWorkAuthorizationNeedsVerification: boolean;
  readonly maxTravelPct: number;
  readonly minimalTravelAllowed: boolean;
  readonly frequentTravelAllowed: boolean;
}

export interface WorkabilityReadinessResult {
  readonly status: WorkabilityReadinessStatus;
  readonly reasonCode: string | null;
  readonly rationale: string;
  readonly evidenceKeys: readonly string[];
  readonly policyReferenceRequired: boolean;
}

export interface TravelReadinessEvidence {
  readonly status: string;
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly evidence: readonly { readonly evidence_key: string }[];
}

export interface HiringTerritoryReadinessEvidence {
  readonly status: string;
  readonly operator: string;
  readonly countries: readonly string[];
  readonly evidence: readonly { readonly evidence_key: string }[];
}

export interface WorkModeReadinessEvidence {
  readonly status: string;
  readonly value: string;
  readonly office_days_max: number | null;
  readonly evidence: readonly { readonly evidence_key: string }[];
}

const TRAVEL_NEGATION_RE = /\b(?:no|without)\s+(?:required\s+|regular\s+|business\s+)?(?:travel|business trips?)\b|\b(?:travel|business trips?)\b[^;\n]{0,40}\b(?:not required|not expected|not needed|isn't required|is not required|is not expected)\b/i;
const TRAVEL_OBLIGATION_RE = /\d{1,3}\s*%|\b(?:required|expected|occasionally|occasional|minimal|frequent|frequently|extensive|regular|substantial|significant|willing(?:ness)?|must|may need|up to|no more than|at least|minimum)\b/i;

function clauses(description: string): string[] {
  return splitWorkabilityClauses(description);
}

function explicitTravelNegation(description: string): string | null {
  return clauses(description).find((clause) => TRAVEL_NEGATION_RE.test(clause)) ?? null;
}

function hasPositiveTravelObligation(description: string): boolean {
  return clauses(description).some((clause) =>
    /\b(?:travel|traveling|travelling|business trips?)\b/i.test(clause)
      && !TRAVEL_NEGATION_RE.test(clause)
      && TRAVEL_OBLIGATION_RE.test(clause)
  );
}

function explicitFrequentTravel(description: string): string | null {
  return clauses(description).find((clause) =>
    !TRAVEL_NEGATION_RE.test(clause)
      && /\b(?:frequent|frequently|extensive|regular|substantial|significant)\b[^;\n]{0,40}\b(?:travel|traveling|travelling|business trips?)\b|\b(?:travel|traveling|travelling|business trips?)\b[^;\n]{0,40}\b(?:frequent|extensive|regular|substantial|significant)\b/i.test(clause)
  ) ?? null;
}

function explicitMinimalTravel(description: string): string | null {
  return clauses(description).find((clause) =>
    !TRAVEL_NEGATION_RE.test(clause)
      && /\bminimal\s+(?:business\s+)?travel\b|\b(?:business\s+)?travel\b[^;\n]{0,30}\bminimal\b/i.test(clause)
      && TRAVEL_OBLIGATION_RE.test(clause)
  ) ?? null;
}

export function assessHiringTerritoryReadiness(
  description: string,
  evidence: HiringTerritoryReadinessEvidence | null,
  workMode: string | null,
  policy: Pick<WorkabilityReadinessPolicy, "authorizedRegions" | "remoteWithoutTerritoryAllowed" | "rejectExplicitForeignTerritory" | "unknownWorkAuthorizationNeedsVerification">,
): WorkabilityReadinessResult {
  const requirements = extractExplicitWorkerTerritoryRequirements(description);
  const evidenceKeys = evidence?.evidence.map((item) => item.evidence_key) ?? [];
  const requirementKeys = requirements.map((requirement) => `worker_territory_requirement:${requirement.evidenceText}`);
  if (requirements.length > 0) {
    const evaluation = evaluateWorkerTerritoryRequirements(
      requirements,
      policy.authorizedRegions,
      policy.rejectExplicitForeignTerritory,
    );
    if (evaluation.status === "INCOMPATIBLE") {
      return {
        status: "BLOCKED",
        reasonCode: "WORK_AUTHORIZATION_INCOMPATIBLE",
        rationale: `At least one separate worker-territory restriction is incompatible with the active authorized regions: ${evaluation.incompatibleTerritories.join(", ")}.`,
        evidenceKeys: [...evidenceKeys, ...requirementKeys],
        policyReferenceRequired: false,
      };
    }
    if (evaluation.status === "NEEDS_VERIFICATION") {
      return {
        status: "NEEDS_VERIFICATION",
        reasonCode: "WORK_AUTHORIZATION_OPERATOR_UNKNOWN",
        rationale: "The posting lists worker territories but does not establish the alternatives within each separate eligibility condition.",
        evidenceKeys: [...evidenceKeys, ...requirementKeys],
        policyReferenceRequired: false,
      };
    }
    return {
      status: "MET",
      reasonCode: null,
      rationale: `Every worker-territory condition is compatible with ${policy.authorizedRegions.join(", ") || "the configured policy"}.`,
      evidenceKeys: [...evidenceKeys, ...requirementKeys],
      policyReferenceRequired: false,
    };
  }

  const remotePolicyAllowsUnknownTerritory = workMode === "REMOTE" && policy.remoteWithoutTerritoryAllowed;
  if (evidence?.status === "CONFLICTING") {
    return {
      status: "NEEDS_VERIFICATION",
      reasonCode: "WORK_AUTHORIZATION_EVIDENCE_CONFLICTING",
      rationale: "The posting contains conflicting worker-territory restrictions that require clarification.",
      evidenceKeys,
      policyReferenceRequired: false,
    };
  }
  if (remotePolicyAllowsUnknownTerritory || !policy.unknownWorkAuthorizationNeedsVerification) {
    return {
      status: "NOT_APPLICABLE",
      reasonCode: null,
      rationale: "The active policy does not require separate work-authorization evidence for this posting context.",
      evidenceKeys,
      policyReferenceRequired: true,
    };
  }
  return {
    status: "NEEDS_VERIFICATION",
    reasonCode: "WORK_AUTHORIZATION_UNKNOWN",
    rationale: "Hiring-country or work-authorization evidence is unresolved.",
    evidenceKeys,
    policyReferenceRequired: false,
  };
}

export function assessTravelReadiness(
  description: string,
  evidence: TravelReadinessEvidence | null,
  policy: Pick<WorkabilityReadinessPolicy, "maxTravelPct" | "minimalTravelAllowed" | "frequentTravelAllowed">,
): WorkabilityReadinessResult {
  const negation = hasPositiveTravelObligation(description) ? null : explicitTravelNegation(description);
  const travelEvidence = evidence?.evidence.map((item) => item.evidence_key) ?? [];
  if (negation && evidence?.status !== "CONFLICTING") {
    return {
      status: "NOT_APPLICABLE",
      reasonCode: null,
      rationale: "The employer explicitly states that travel is not required.",
      evidenceKeys: [...travelEvidence, `travel_negation:${negation}`],
      policyReferenceRequired: true,
    };
  }

  if (evidence?.status === "CONFLICTING") {
    return {
      status: "NEEDS_VERIFICATION",
      reasonCode: "TRAVEL_EVIDENCE_CONFLICTING",
      rationale: "The posting contains conflicting travel statements that require clarification.",
      evidenceKeys: travelEvidence,
      policyReferenceRequired: false,
    };
  }

  const frequent = explicitFrequentTravel(description);
  if (frequent && !policy.frequentTravelAllowed) {
    return {
      status: "BLOCKED",
      reasonCode: "FREQUENT_TRAVEL_NOT_ALLOWED",
      rationale: "The posting explicitly requires frequent travel, which conflicts with the active workability policy.",
      evidenceKeys: [...travelEvidence, `frequent_travel:${frequent}`],
      policyReferenceRequired: false,
    };
  }

  if (evidence?.status === "SUPPORTED") {
    if (evidence.minimum !== null && evidence.minimum > policy.maxTravelPct) {
      return {
        status: "BLOCKED",
        reasonCode: "TRAVEL_EXCEEDS_POLICY",
        rationale: `The disclosed minimum travel of ${evidence.minimum}% exceeds the active ${policy.maxTravelPct}% cap.`,
        evidenceKeys: travelEvidence,
        policyReferenceRequired: false,
      };
    }
    if (evidence.maximum === null) {
      return {
        status: "NEEDS_VERIFICATION",
        reasonCode: "TRAVEL_MAXIMUM_UNKNOWN",
        rationale: "A minimum travel percentage is stated, but the maximum is not established.",
        evidenceKeys: travelEvidence,
        policyReferenceRequired: false,
      };
    }
    if (evidence.maximum > policy.maxTravelPct && !policy.frequentTravelAllowed) {
      return {
        status: "BLOCKED",
        reasonCode: "TRAVEL_EXCEEDS_POLICY",
        rationale: `Employer travel maximum ${evidence.maximum}% exceeds the active ${policy.maxTravelPct}% cap.`,
        evidenceKeys: travelEvidence,
        policyReferenceRequired: false,
      };
    }
    return {
      status: "MET",
      reasonCode: null,
      rationale: `Disclosed travel maximum ${evidence.maximum}% fits the active ${policy.maxTravelPct}% cap.`,
      evidenceKeys: travelEvidence,
      policyReferenceRequired: false,
    };
  }

  const minimalTravel = explicitMinimalTravel(description);
  if (minimalTravel) {
    return policy.minimalTravelAllowed
      ? {
          status: "MET",
          reasonCode: null,
          rationale: "The active policy accepts qualitative minimal travel as an assumption; no numeric travel percentage is inferred.",
          evidenceKeys: [...travelEvidence, `travel_policy_assumption:minimal_qualitative:${minimalTravel}`],
          policyReferenceRequired: true,
        }
      : {
          status: "NEEDS_VERIFICATION",
          reasonCode: "MINIMAL_TRAVEL_POLICY_UNCONFIRMED",
          rationale: "The active workability policy does not accept qualitative minimal travel without an explicit percentage.",
          evidenceKeys: travelEvidence,
          policyReferenceRequired: true,
        };
  }

  const obligationMentioned = clauses(description).some((clause) =>
    /\b(?:travel|traveling|travelling|business trips?)\b/i.test(clause)
      && (/\d{1,3}\s*%/.test(clause)
        || /\b(?:required|expected|occasionally|occasional|minimal|frequent|frequently|extensive|regular|substantial|significant|willing(?:ness)?|must|may need|up to|no more than|at least|minimum)\b/i.test(clause))
  );
  if (frequent || obligationMentioned) {
    return {
      status: "NEEDS_VERIFICATION",
      reasonCode: "TRAVEL_PERCENTAGE_UNKNOWN",
      rationale: "Travel is mentioned without a supported numeric upper bound.",
      evidenceKeys: [...travelEvidence, ...(frequent ? [`frequent_travel:${frequent}`] : [])],
      policyReferenceRequired: false,
    };
  }

  return {
    status: "NOT_APPLICABLE",
    reasonCode: null,
    rationale: "No travel obligation is stated; the numeric travel cap is not applicable.",
    evidenceKeys: [],
    policyReferenceRequired: true,
  };
}

export function assessWorkModeReadiness(
  evidence: WorkModeReadinessEvidence | null,
  workplaceType: string | null,
  officeDaysFact: unknown,
  attendanceBasis: unknown,
  gateDecision: string | null,
  policy: Pick<WorkabilityReadinessPolicy, "allowedWorkModes" | "maxOfficeDaysPerWeek" | "hardFailOfficeDaysPerWeek" | "hybridWithoutOfficeDaysAllowed">,
): WorkabilityReadinessResult {
  const mode = evidence?.value ?? (workplaceType === "ASSUMED_HYBRID" ? "HYBRID" : "UNKNOWN");
  const assumedHybrid = mode === "HYBRID"
    && evidence?.status !== "SUPPORTED"
    && (workplaceType === "ASSUMED_HYBRID" || attendanceBasis === "POLICY_HYBRID_3_2");
  const officeDays = evidence?.office_days_max
    ?? (typeof officeDaysFact === "number" && Number.isFinite(officeDaysFact) ? officeDaysFact : null)
    ?? (assumedHybrid && policy.hybridWithoutOfficeDaysAllowed ? policy.maxOfficeDaysPerWeek : null);
  const modeAllowed = mode !== "UNKNOWN" && policy.allowedWorkModes.includes(mode);
  const officeDaysAllowed = officeDays === null
    ? mode === "REMOTE"
    : officeDays <= policy.maxOfficeDaysPerWeek && officeDays < policy.hardFailOfficeDaysPerWeek;
  const assumedHybridAllowed = assumedHybrid
    && policy.hybridWithoutOfficeDaysAllowed
    && modeAllowed
    && officeDaysAllowed;
  if (assumedHybridAllowed) {
    return {
      status: "MET",
      reasonCode: null,
      rationale: `The active policy accepts the ${officeDays ?? policy.maxOfficeDaysPerWeek}-day hybrid default; this is a policy assumption, not employer-confirmed evidence.`,
      evidenceKeys: [...(evidence?.evidence.map((item) => item.evidence_key) ?? []), "policy_assumption:POLICY_HYBRID_3_2"],
      policyReferenceRequired: true,
    };
  }
  if (assumedHybrid && (!modeAllowed || !officeDaysAllowed)) {
    return {
      status: "BLOCKED",
      reasonCode: "WORK_MODE_INCOMPATIBLE",
      rationale: "The persisted hybrid policy assumption exceeds the active work-mode or office-day preference.",
      evidenceKeys: [...(evidence?.evidence.map((item) => item.evidence_key) ?? []), "policy_assumption:POLICY_HYBRID_3_2"],
      policyReferenceRequired: true,
    };
  }

  if (gateDecision === "HARD_REJECT" && (mode === "UNKNOWN" || !modeAllowed || !officeDaysAllowed)) {
    return {
      status: "BLOCKED",
      reasonCode: "WORK_MODE_INCOMPATIBLE",
      rationale: "Deterministic workability policy rejected the unknown or incompatible work mode.",
      evidenceKeys: evidence?.evidence.map((item) => item.evidence_key) ?? [],
      policyReferenceRequired: false,
    };
  }
  if (evidence?.status === "SUPPORTED" && modeAllowed && officeDaysAllowed) {
    return {
      status: "MET",
      reasonCode: null,
      rationale: `Employer-confirmed ${mode.toLowerCase()} work mode fits the active office-day policy.`,
      evidenceKeys: evidence.evidence.map((item) => item.evidence_key),
      policyReferenceRequired: false,
    };
  }
  if (evidence?.status === "SUPPORTED" && (!modeAllowed || !officeDaysAllowed)) {
    return {
      status: "BLOCKED",
      reasonCode: "WORK_MODE_INCOMPATIBLE",
      rationale: "Employer-confirmed work mode or attendance exceeds the active preference.",
      evidenceKeys: evidence.evidence.map((item) => item.evidence_key),
      policyReferenceRequired: false,
    };
  }
  return {
    status: "NEEDS_VERIFICATION",
    reasonCode: "WORK_MODE_UNVERIFIED",
    rationale: "Work mode or office-day requirements are not established by employer evidence or an accepted policy assumption.",
    evidenceKeys: evidence?.evidence.map((item) => item.evidence_key) ?? [],
    policyReferenceRequired: false,
  };
}
