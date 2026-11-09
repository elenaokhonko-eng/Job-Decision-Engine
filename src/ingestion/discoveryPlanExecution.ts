import type { ExtractedJob } from "../contracts/index.js";
import type { GlobalLanesConfig } from "../pipeline/laneConfigLoader.js";
import type { ScoutSearchPlan } from "./scouts/discoveryScouts.js";
import { excludedConceptTerms, PRESCREEN_ROLE_LEAD_CHARS } from "./discoveryPrescreen.js";

export interface LaneDisposition {
  readonly laneKey: string;
  readonly matched: boolean;
  readonly reasonCode: "LANE_MATCHED" | "LANE_DOMAIN_MISS" | "TARGET_FUNCTION_MISS"
    | "LANE_EXCLUDED_DOMAIN" | "PRESCREEN_ROLE_OUTSIDE_LEAD";
  readonly reason: string;
}

/** Tier 1 discovery pre-screen options; absent means the original (pre-screen off) behaviour. */
export interface LanePrescreenOptions {
  /** The lane role term must appear in the title (true) or the title / description opening (false). */
  readonly roleInTitleOnly: boolean;
  /** Where lane negative terms are read (default TITLE_AND_DESCRIPTION). */
  readonly negativeScope?: "TITLE" | "TITLE_AND_LEAD" | "TITLE_AND_DESCRIPTION";
  /** Also accept a generic technical-role word (engineer, developer, scientist ...) in the lead. */
  readonly technicalRoleWords?: boolean;
}

const TECHNICAL_ROLE_WORDS = /\b(?:engineer(?:s|ing)?|developers?|architects?|scientists?|programmers?|researchers?|research staff|technical staff|analysts?|machine learning|ml|ai|genai|llms?|data|software|platform|technical|technology|bioinformatic(?:s|ian)|computational|quant(?:itative)?)\b/i;

function normalizedText(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9+#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstWholeTerm(text: string, terms: readonly string[]): string | null {
  const padded = ` ${text} `;
  for (const term of terms) {
    const normalized = normalizedText(term);
    if (normalized.length > 0 && padded.includes(` ${normalized} `)) return term;
  }
  return null;
}

function containsAny(text: string, terms: readonly string[]): boolean {
  return terms.some((term) => {
    const normalized = normalizedText(term);
    return normalized.length > 0 && text.includes(normalized);
  });
}

export function assessCandidateLanes(
  job: Pick<ExtractedJob, "company_name" | "title" | "description_raw" | "location_raw" | "workplace_type_raw">,
  candidateLaneKeys: readonly string[],
  plans: Readonly<Record<string, ScoutSearchPlan>>,
  lanes: GlobalLanesConfig["lanes"],
  employerLaneKeys: readonly string[] = [],
  prescreen?: LanePrescreenOptions,
): LaneDisposition[] {
  const title = normalizedText(job.title);
  const text = normalizedText([
    job.company_name,
    job.title,
    job.description_raw,
    job.location_raw,
    job.workplace_type_raw,
  ].join(" "));
  const employerLaneSet = new Set(employerLaneKeys);
  // Tier 1: the role term must lead the posting (title or description opening), and lane
  // negatives are read from the title and the whole description.
  const roleLead = prescreen
    ? prescreen.roleInTitleOnly
      ? title
      : normalizedText([job.title, String(job.description_raw ?? "").slice(0, PRESCREEN_ROLE_LEAD_CHARS)].join(" "))
    : null;
  const lead = String(job.description_raw ?? "").slice(0, PRESCREEN_ROLE_LEAD_CHARS);
  const negativeScope = prescreen?.negativeScope ?? "TITLE_AND_DESCRIPTION";
  const negativeText = !prescreen
    ? null
    : negativeScope === "TITLE"
      ? title
      : normalizedText([job.title, negativeScope === "TITLE_AND_LEAD" ? lead : job.description_raw].join(" "));
  const technicalLead = Boolean(prescreen?.technicalRoleWords && roleLead !== null && TECHNICAL_ROLE_WORDS.test(roleLead));

  return candidateLaneKeys.map((laneKey): LaneDisposition => {
    const plan = plans[laneKey];
    const lane = lanes[laneKey];
    if (!plan || !lane) {
      return {
        laneKey,
        matched: false,
        reasonCode: "LANE_DOMAIN_MISS",
        reason: `No active, validated source plan exists for ${laneKey}.`,
      };
    }
    const domainTerms = [...plan.domainTerms, ...(lane.keywords ?? []), ...(lane.positive_concepts ?? [])];
    const roleTerms = [...plan.targetFunctions, ...plan.roleTerms, ...(lane.title_families ?? []), ...(lane.required_function_concepts ?? [])];
    const domainMatched = containsAny(text, domainTerms);
    const baselineRoleMatched = containsAny(title, roleTerms) || containsAny(text, roleTerms);
    // With the pre-screen the lead must carry a lane role term (or, when enabled, a generic
    // technical-role word); the lane must still match its role terms somewhere, as before.
    const roleMatched = roleLead !== null
      ? (containsAny(roleLead, roleTerms) || technicalLead) && baselineRoleMatched
      : baselineRoleMatched;
    if (negativeText !== null) {
      const excluded = firstWholeTerm(negativeText, excludedConceptTerms(lane.excluded_domain_concepts));
      if (excluded) {
        return {
          laneKey,
          matched: false,
          reasonCode: "LANE_EXCLUDED_DOMAIN",
          reason: `Posting mentions "${excluded}", an excluded domain concept of ${laneKey}.`,
        };
      }
    }
    const investmentOnlyRole = laneKey === "INVESTMENT_MARKETS_FINTECH"
      && /\b(quantitative researcher|quant researcher|investment banking analyst|private equity analyst|deal advisory)\b/i.test(title)
      && !/\b(software|engineer(?:ing)?|architect(?:ure)?|platform|technical project|technical programme|technical program|technical delivery|technical product|data infrastructure|market data engineering|coding|developer)\b/i.test(text);
    if (investmentOnlyRole) {
      return {
        laneKey,
        matched: false,
        reasonCode: "TARGET_FUNCTION_MISS",
        reason: "Pure quantitative research or traditional finance role lacks supported investment-technology/technical-ownership evidence.",
      };
    }
    const companyLaneEvidence = employerLaneSet.has(laneKey);
    if (roleMatched && (domainMatched || companyLaneEvidence)) {
      return {
        laneKey,
        matched: true,
        reasonCode: "LANE_MATCHED",
        reason: companyLaneEvidence && !domainMatched
          ? `Target technical function matched an explicitly configured employer lane (${laneKey}).`
          : `Target function and lane-domain evidence matched ${laneKey}.`,
      };
    }
    if (roleLead !== null && !roleMatched && baselineRoleMatched && (domainMatched || companyLaneEvidence)) {
      return {
        laneKey,
        matched: false,
        reasonCode: "PRESCREEN_ROLE_OUTSIDE_LEAD",
        reason: prescreen?.roleInTitleOnly
          ? `No configured ${laneKey} target function is in the title (this source requires it).`
          : `No configured ${laneKey} target function is in the title or the first ${PRESCREEN_ROLE_LEAD_CHARS} description characters.`,
      };
    }
    if (!domainMatched) {
      return {
        laneKey,
        matched: false,
        reasonCode: "LANE_DOMAIN_MISS",
        reason: `No configured ${laneKey} domain term matched the fetched posting.`,
      };
    }
    return {
      laneKey,
      matched: false,
      reasonCode: "TARGET_FUNCTION_MISS",
      reason: `Domain evidence matched ${laneKey}, but no configured target function matched.`,
    };
  });
}
