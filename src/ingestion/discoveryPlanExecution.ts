import type { ExtractedJob } from "../contracts/index.js";
import type { GlobalLanesConfig } from "../pipeline/laneConfigLoader.js";
import type { ScoutSearchPlan } from "./scouts/discoveryScouts.js";

export interface LaneDisposition {
  readonly laneKey: string;
  readonly matched: boolean;
  readonly reasonCode: "LANE_MATCHED" | "LANE_DOMAIN_MISS" | "TARGET_FUNCTION_MISS";
  readonly reason: string;
}

function normalizedText(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9+#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
    const roleMatched = containsAny(title, roleTerms) || containsAny(text, roleTerms);
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
