import type pg from "pg";
import { z } from "zod";

import { checkModelRegistryPreflight, generateContentAudited, MODEL_REGISTRY } from "../services/agent.js";
import type { WorkspaceContext } from "../workspace/context.js";
import type { ManualEvidence, ManualRequirement } from "./manualPreparation.js";

/**
 * Model-judged pairing of job requirements with profile evidence. The model only proposes pairs;
 * every requirement key and evidence id is checked against the inputs, pairs below the confidence
 * threshold are dropped, and a requirement with no pair stays unmatched ("no direct evidence")
 * rather than being filled with the nearest words. The result is advisory evidence for the
 * candidate's review, never a suitability decision.
 */

export const MANUAL_PAIRING_SCHEMA_VERSION = "manual_evidence_pairing_v1";
export const MANUAL_PAIRING_METHOD = "model_pairing_v3";
export const PAIRING_CONFIDENCE_THRESHOLD = 0.6;
// More than the three a row shows, so a requirement still has evidence once a fact reaches its reuse cap.
export const MAX_PAIRS_PER_REQUIREMENT = 5;
const MAX_PAIRING_RESPONSE_BYTES = 128 * 1024;
const MAX_JUSTIFICATION_CHARS = 240;

export interface EvidencePair {
  requirement_key: string;
  evidence_id: string;
  confidence: number;
  justification: string;
}

export interface EvidencePairingInput {
  title: string;
  company: string;
  requirements: ManualRequirement[];
  evidence: ManualEvidence[];
  /** Role label per engagement id, so the model sees which job each fact comes from. */
  roleLabels?: Record<string, string>;
  clientOrPool?: pg.Pool | pg.PoolClient;
  context?: WorkspaceContext;
}

export interface EvidencePairingResult {
  pairs: EvidencePair[];
  provider: string;
  model: string;
}

export type EvidencePairer = (input: EvidencePairingInput) => Promise<EvidencePairingResult>;

const PairSchema = z.object({
  requirement_key: z.string().min(1),
  evidence_id: z.string().min(1),
  confidence: z.number().min(0).max(1),
  justification: z.string().trim().min(5).max(MAX_JUSTIFICATION_CHARS),
}).strict();

export const PairingPayloadSchema = z.object({
  schema_version: z.literal(MANUAL_PAIRING_SCHEMA_VERSION),
  pairs: z.array(PairSchema).max(400),
}).strict();

export const pairingProviderSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "pairs"],
  properties: {
    schema_version: { type: "string", enum: [MANUAL_PAIRING_SCHEMA_VERSION] },
    pairs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["requirement_key", "evidence_id", "confidence", "justification"],
        properties: {
          requirement_key: { type: "string" },
          evidence_id: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          justification: { type: "string", minLength: 5, maxLength: MAX_JUSTIFICATION_CHARS },
        },
      },
    },
  },
} as const;

export type PairingValidation = { valid: true; pairs: EvidencePair[] } | { valid: false; issues: string[] };

/**
 * Accepts the model's pairs only if every requirement key and evidence id exists. Then keeps, per
 * requirement, the strongest pairs at or above the threshold, so weak guesses never become evidence.
 */
export function validatePairingPayload(payload: unknown, requirements: ManualRequirement[], evidence: ManualEvidence[]): PairingValidation {
  const parsed = PairingPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return { valid: false, issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`) };
  }
  const requirementKeys = new Set(requirements.map((requirement) => requirement.requirement_key));
  const evidenceIds = new Set(evidence.map((item) => item.id));
  const issues = parsed.data.pairs.flatMap((pair, index) => [
    ...(requirementKeys.has(pair.requirement_key) ? [] : [`pair ${index + 1}: unknown requirement ${pair.requirement_key}.`]),
    ...(evidenceIds.has(pair.evidence_id) ? [] : [`pair ${index + 1}: unknown evidence ${pair.evidence_id}.`]),
  ]);
  if (issues.length > 0) return { valid: false, issues };
  return { valid: true, pairs: strongestPairs(parsed.data.pairs) };
}

/** Per requirement: pairs at or above the threshold, strongest first, one per evidence item, at most five. */
export function strongestPairs(pairs: EvidencePair[]): EvidencePair[] {
  const byRequirement = new Map<string, EvidencePair[]>();
  for (const pair of pairs) {
    if (pair.confidence < PAIRING_CONFIDENCE_THRESHOLD) continue;
    const list = byRequirement.get(pair.requirement_key) ?? [];
    if (!list.some((existing) => existing.evidence_id === pair.evidence_id)) list.push({ ...pair, justification: pair.justification.trim() });
    byRequirement.set(pair.requirement_key, list);
  }
  return [...byRequirement.values()].flatMap((list) => list
    .sort((left, right) => right.confidence - left.confidence || left.evidence_id.localeCompare(right.evidence_id))
    .slice(0, MAX_PAIRS_PER_REQUIREMENT));
}

export function buildPairingPrompt(input: EvidencePairingInput): string {
  return [
    `Pair each requirement of the ${input.title} role at ${input.company} with the candidate's evidence that directly demonstrates it.`,
    "Return STRICT JSON matching the provided schema.",
    "Rules:",
    `- schema_version must be "${MANUAL_PAIRING_SCHEMA_VERSION}".`,
    "- Use only the requirement keys and evidence ids listed below.",
    "- Pair on substance, not shared words: \"workflows\" in retail CRM is not evidence of trading workflows; a derivatives portfolio operating model is evidence of portfolio management systems work.",
    "- confidence: 0.9+ the evidence plainly demonstrates the requirement; 0.6-0.8 clearly related and relevant; below 0.6 a stretch.",
    "- Leave a requirement without pairs when nothing directly demonstrates it. An honest gap is better than a stretched match.",
    "- justification: one short sentence saying why the evidence demonstrates the requirement.",
    "- At most 5 pairs per requirement, strongest first. Prefer evidence from different roles, and recent work over old work of the same strength.",
    "- Use any one evidence item for at most 2 requirements; find the next-best direct evidence for the others.",
    "",
    "Requirements:",
    ...input.requirements.map((requirement) => `- [${requirement.requirement_key}] (${requirement.importance}) ${requirement.requirement_text}`),
    "",
    "Evidence:",
    ...input.evidence.map((item) => {
      const role = item.engagement_id ? input.roleLabels?.[item.engagement_id] : undefined;
      return `- [${item.id}] (${item.evidence_type}${role ? `, ${role}` : ""}) ${item.statement}`;
    }),
  ].join("\n");
}

function parsePairingResponse(input: EvidencePairingInput, rawText: string): EvidencePair[] {
  if (Buffer.byteLength(rawText, "utf8") > MAX_PAIRING_RESPONSE_BYTES) {
    throw new RangeError(`Evidence pairing response exceeds the ${MAX_PAIRING_RESPONSE_BYTES}-byte limit.`);
  }
  let cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) cleaned = cleaned.slice(start, end + 1);
  let payload: unknown;
  try {
    payload = JSON.parse(cleaned);
  } catch (error: any) {
    throw new Error(`Evidence pairing returned invalid JSON: ${error.message || String(error)}`);
  }
  const validated = validatePairingPayload(payload, input.requirements, input.evidence);
  if (!validated.valid) throw new Error(`Evidence pairing validation failed: ${validated.issues.join(" ")}`);
  return validated.pairs;
}

/** Calls the extraction model route; throws unless the response passes validatePairingPayload. */
export const pairEvidenceWithModel: EvidencePairer = async (input) => {
  const response = await generateContentAudited({
    purpose: "EXTRACTION",
    routeKey: "manual_evidence_pairing",
    model: MODEL_REGISTRY.EXTRACTION_GEMINI_MODEL,
    // The candidate is waiting on the comparison: interactive deadline, no Flex PayGo.
    interactive: true,
    contents: buildPairingPrompt(input),
    responseMimeType: "application/json",
    responseSchema: pairingProviderSchema,
    systemInstruction: "You pair job requirements with directly supporting evidence. Return valid JSON only.",
    validateResponseText: (text) => parsePairingResponse(input, text),
    clientOrPool: input.clientOrPool,
    context: input.context,
  });
  return {
    pairs: (response.validatedPayload as EvidencePair[] | undefined) ?? parsePairingResponse(input, response.text),
    provider: response.provider,
    model: response.model,
  };
};

/** "model" when a model key is configured and MANUAL_EVIDENCE_PAIRING_AI is not "false". */
export function manualPairingMode(): "model" | "lexical" {
  if (process.env.MANUAL_EVIDENCE_PAIRING_AI === "false") return "lexical";
  return checkModelRegistryPreflight().ok ? "model" : "lexical";
}
