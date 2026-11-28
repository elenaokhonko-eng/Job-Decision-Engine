import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import crypto from "crypto";
import { DEFAULT_GEMINI_EVALUATION_MODEL } from "./modelDefaults.js";
import pg from "pg";
import { extractWithFallback } from "./llmFallback.js";
import { EvaluationResultSchema, EvaluationResult, SCHEMA_VERSION } from "../contracts/index.js";
import { stableStringify, sha256Hex } from "../config/structuredLoader.js";
import { readJsonResponseBounded, readResponseTextBounded } from "../security/boundedResponse.js";
import { publicErrorSummary } from "../security/publicErrorSummary.js";
import {
  CULTURE_SCORE_DERIVATION_VERSION,
  scoreCultureEvidenceFromQuote,
} from "./cultureEvidenceScoring.js";
import {
  ensureModelRouteActiveRevision,
  getActiveModelRouteRevision,
  recordModelRouteInvocation,
  type ModelRoutePurpose,
  type ModelRouteRevisionContent,
} from "../modelRoutes/registry.js";
import type { WorkspaceContext } from "../workspace/context.js";
import {
  geminiBackend,
  geminiConfigProblem,
  isGeminiConfigured,
  resolveGeminiClientConfig,
  type GeminiBackend,
  type GeminiClientConfig,
  type GeminiCredentialScope,
} from "./geminiConfig.js";
import {
  backoffOptionsFromEnv,
  estimateTokens,
  fullJitterBackoffMs,
  GEMINI_FLEX_PROVIDER_LABEL,
  geminiFlexCallDeadlineMs,
  geminiFlexRequestTimeoutMs,
  getModelLimiter,
  interactiveCallDeadlineMs,
  isRateLimitedFailure,
  ModelCallDeadlineError,
  ModelRateLimitedError,
  pipelineCallDeadlineMs,
  rateLimitMaxAttempts,
  rateLimitRetryAfterMs,
  recordModelCallRoute,
  recordProviderCall,
  serverSuggestedDelayMs,
  type ModelFailureKind,
  type ModelServedPath,
} from "./modelCallResilience.js";
import { ensureFetchDispatcherTimeouts } from "./fetchDispatcherTimeouts.js";
import { documentOpenAiModel, evaluationOpenAiModel } from "./openAiModelRoles.js";
import {
  MULTI_LANE_SCORECARDS,
  ND_FRIENDLY_DIMENSIONS,
  POLITICS_STRESS_RISK_DIMENSIONS
} from "./criteria.ts";
import { TARGET_LANE_KEYS } from "../policy/laneIntentContracts.js";
import {
  classifyGeminiErrorForBackend,
  estimateCostUsd as estimateCostUsdFromPricing,
  extractTokenUsage,
  FETCH_TIMEOUT_CAUSE_CODES,
  finiteUsageNumber,
  geminiResponseSchema,
  openAiStrictSchema,
  summarizeSuccessfulUsage,
  callDeadlineAt,
  currentGeminiBackend,
  defaultModelCallDeadlineMs,
  effectiveMaxRetries,
  effectiveTimeoutMs,
  geminiFailureKind,
  geminiFlexEligible,
  getGeminiClient,
  isFlexCapacityFailure,
  modelRequestMaxRetries,
  resetGeminiClientsForTests,
  sleepMs,
  tryGemini as providerTryGemini,
  tryOpenAI as providerTryOpenAI,
  MAX_MODEL_PROVIDER_RESPONSE_BYTES,
  MODEL_MAX_OUTPUT_TOKENS,
  type GeminiPath,
  type ModelProviderAttemptTelemetry,
  type TextProvider,
  type GeminiErrorClassification,
  type ModelCallUsage,
  type ModelTokenUsage,
} from "../platform/llm/index.js";
export { geminiResponseSchema, openAiStrictSchema, getGeminiClient, resetGeminiClientsForTests, defaultModelCallDeadlineMs };

const tryGemini = (options: any): Promise<string> => providerTryGemini(options, MODEL_REGISTRY.EVALUATION_PRIMARY_MODEL);
const tryOpenAI = (openaiKey: string, options: any): Promise<string> =>
  providerTryOpenAI(openaiKey, options, evaluationOpenAiModel());
export type { GeminiErrorClassification, ModelCallUsage };

/**
 * Lane vocabulary for the evaluation prompts: every lane in config/lanes/registry.yml
 * (TARGET_LANE_KEYS is pinned to the registry by tests). The model's lane is advisory;
 * the deterministic router's lane is the one persisted (invariant 11).
 */
export const PROMPT_LANE_KEYS: readonly string[] = TARGET_LANE_KEYS;

export function promptLaneUnion(terminal: "null" | "None"): string {
  return [...PROMPT_LANE_KEYS, terminal].join(" | ");
}

function promptLaneQuotedList(): string {
  return PROMPT_LANE_KEYS.map((laneKey) => `"${laneKey}"`).join(", ");
}

function promptLaneCriteriaLines(): string {
  return TARGET_LANE_KEYS.map((laneKey) => `- ${laneKey}: ${MULTI_LANE_SCORECARDS[laneKey].criteria}`).join("\n");
}

const ADVISORY_LANE_INSTRUCTION =
  "The pre-routed candidate lane was assigned by deterministic routing and is the lane of record; your primary_lane is advisory only. Every listed lane is a target lane: never set next_action to \"REJECTED\" because the job belongs to a lane other than CORE_AI_DATA. Base next_action on fit evidence.";

dotenv.config();
dotenv.config({ path: ".env.local" });

export const MODEL_REGISTRY = {
  EVALUATION_PRIMARY_MODEL: process.env.EVALUATION_PRIMARY_MODEL || process.env.GEMINI_MODEL || DEFAULT_GEMINI_EVALUATION_MODEL,
  /** Import-time snapshot; call sites resolve evaluationOpenAiModel() when the call is made. */
  EVALUATION_FALLBACK_MODEL: evaluationOpenAiModel(),
  EMBEDDING_PRIMARY_MODEL: process.env.EMBEDDING_PRIMARY_MODEL || "gemini-embedding-001",
  EMBEDDING_FALLBACK_MODEL: process.env.EMBEDDING_FALLBACK_MODEL || "text-embedding-3-small",
  DOCUMENT_PRIMARY_MODEL: process.env.DOCUMENT_PRIMARY_MODEL || "gemini-3.8-flash",
  /** Import-time snapshot; call sites resolve documentOpenAiModel() when the call is made. */
  DOCUMENT_FALLBACK_MODEL: documentOpenAiModel(),
  EXTRACTION_GEMINI_MODEL: process.env.REQUIREMENTS_GEMINI_MODEL || process.env.EXTRACTION_GEMINI_MODEL || "gemini-3.1-flash-lite",
  /** Interactive document calls switch to this Gemini model after a 429 or failure on the primary. */
  DOCUMENT_SECONDARY_GEMINI_MODEL: process.env.DOCUMENT_SECONDARY_GEMINI_MODEL || "gemini-3.1-flash-lite",
  EXTRACTION_OPENAI_MODEL: process.env.REQUIREMENTS_OPENAI_MODEL || process.env.EXTRACTION_OPENAI_MODEL || "gpt-5.6-luna",
} as const;

function resolveProviderOrder(primaryProviderRaw: string | undefined): TextProvider[] {
  const normalized = (primaryProviderRaw || "").trim().toLowerCase();
  if (normalized === "openai") return ["openai", "gemini"];
  if (normalized === "gemini") return ["gemini", "openai"];
  // Backward compatibility with existing env behavior.
  if (process.env.FORCE_OPENAI === "true") return ["openai", "gemini"];
  return ["gemini", "openai"];
}

function extractionPrimaryProvider(): string {
  return process.env.REQUIREMENTS_PRIMARY_PROVIDER || process.env.EXTRACTION_PRIMARY_PROVIDER || "openai";
}

function extractionGeminiModel(): string {
  return (
    process.env.REQUIREMENTS_GEMINI_MODEL ||
    process.env.EXTRACTION_GEMINI_MODEL ||
    MODEL_REGISTRY.EXTRACTION_GEMINI_MODEL
  );
}

function extractionOpenAIModel(): string {
  return (
    process.env.REQUIREMENTS_OPENAI_MODEL ||
    process.env.EXTRACTION_OPENAI_MODEL ||
    MODEL_REGISTRY.EXTRACTION_OPENAI_MODEL
  );
}

export function classifyGeminiError(error: any, backend: GeminiBackend = currentGeminiBackend()): GeminiErrorClassification {
  return classifyGeminiErrorForBackend(error, backend);
}

function estimateCostUsd(provider: string, model: string, usage: ModelCallUsage | null): number | null {
  return estimateCostUsdFromPricing(provider, model, usage, process.env.MODEL_PRICING_JSON);
}

function embeddingRequestTimeoutMs(): number {
  const parsed = Number.parseInt(
    String(process.env.EMBEDDING_REQUEST_TIMEOUT_MS || process.env.MODEL_REQUEST_TIMEOUT_MS || "30000"),
    10
  );
  if (!Number.isFinite(parsed)) return 30000;
  return Math.max(5000, Math.min(120000, parsed));
}

export function checkModelRegistryPreflight(
  scope: GeminiCredentialScope = "default",
): { ok: boolean; warnings: string[]; primaryAvailable: boolean; fallbackAvailable: boolean } {
  const openaiKey = process.env.OPENAI_API_KEY;
  const evalOrder = resolveProviderOrder(process.env.EVALUATION_PRIMARY_PROVIDER);
  const primaryProvider = evalOrder[0];
  const fallbackProvider = evalOrder[1];
  const warnings: string[] = [];
  const hasGemini = isGeminiConfigured(process.env, scope);
  const hasOpenAI = !!(openaiKey && openaiKey.trim() !== "");
  const primaryAvailable = primaryProvider === "openai" ? hasOpenAI : hasGemini;
  const fallbackAvailable = fallbackProvider === "openai" ? hasOpenAI : hasGemini;
  if (!primaryAvailable) {
    warnings.push(`Primary provider (${primaryProvider}) credentials are missing or placeholder.`);
  }
  if (!fallbackAvailable) {
    warnings.push(`Fallback provider (${fallbackProvider}) credentials are missing or placeholder.`);
  }
  return {
    ok: primaryAvailable || fallbackAvailable,
    warnings,
    primaryAvailable,
    fallbackAvailable
  };
}

export type Provider = "local" | "gemini" | "openai";

/**
 * Unified LLM call helper that selects provider based on workflow stage.
 */
export async function callLLM(
  stage: "extract" | "evaluate" | "cv",
  prompt: string,
  extra?: any
): Promise<string> {
  // Resolve provider for the given stage
  let provider: Provider;
  if (stage === "extract") {
    provider = "local"; // Ollama LLaMA
  } else if (stage === "evaluate") {
    provider = "gemini"; // Primary, fallback handled internally
  } else {
    provider = "openai"; // CV customization
  }

  switch (provider) {
    case "local": {
      const baseUrl = process.env.OLLAMA_API_BASE?.replace(/\/+$/, "");
      const model = process.env.OLLAMA_MODEL;
      if (!baseUrl || !model) {
        throw new Error("Ollama configuration missing in .env.local (OLLAMA_API_BASE or OLLAMA_MODEL)");
      }
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 1,
          ...(extra?.schema ? { format: extra.schema } : {}),
          ...(extra?.options ?? {})
        })
      });
      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Ollama request failed: ${response.status} ${err}`);
      }
      const data = await response.json();
      return data.choices?.[0]?.message?.content ?? "";
    }
    case "gemini":
      throw new Error("The legacy Gemini agent path was removed; evaluate through generateContentAudited.");
    case "openai": {
      const openaiKey = process.env.OPENAI_API_KEY || "";
      return await tryOpenAI(openaiKey, {
        contents: prompt,
        model: documentOpenAiModel(),
        responseMimeType: "application/json"
      });
    }
    default:
      throw new Error("Invalid provider");
  }
}


export async function generateContent(options: {
  model: string;
  contents: any;
  responseMimeType?: string;
  responseSchema?: any;
  systemInstruction?: string;
}): Promise<string> {
  return (await generateContentAudited({ ...options })).text;

  const geminiKey = isGeminiConfigured();
  const openaiKey = process.env.OPENAI_API_KEY;
  const isDocumentRoute =
    options.model === MODEL_REGISTRY.DOCUMENT_PRIMARY_MODEL ||
    options.model === documentOpenAiModel();
  const primaryProvider = isDocumentRoute
    ? (process.env.DOCUMENT_PRIMARY_PROVIDER || process.env.EVALUATION_PRIMARY_PROVIDER)
    : process.env.EVALUATION_PRIMARY_PROVIDER;
  const order = resolveProviderOrder(primaryProvider);

  const tried = new Set<string>();

  for (const provider of order) {
    if (provider === "gemini" && geminiKey && !tried.has("gemini")) {
      tried.add("gemini");
      try {
        const text = await tryGemini(options);
        if (text) return text;
      } catch (err: any) {
        console.warn(`⚠️ ${publicErrorSummary(err, "gemini")}.`);
      }
    }

    if (provider === "openai" && openaiKey && !tried.has("openai")) {
      tried.add("openai");
      try {
        const text = await tryOpenAI(openaiKey as string, options);
        if (text) return text;
      } catch (err: any) {
        console.warn(`⚠️ ${publicErrorSummary(err, "openai")}.`);
      }
    }
  }

  throw new Error("All model API calls failed or no API keys were configured.");
}

export interface GenerateContentAuditedResult {
  text: string;
  provider: "gemini" | "openai";
  model: string;
  fallbackUsed: boolean;
  attempts: number;
  errors: Array<{ provider: string; model: string; error: string }>;
  latencyMs: number;
  routeKey?: string;
  routeRevisionId?: string;
  invocationId?: string | null;
  validatedPayload?: unknown;
  /** Token usage of the successful call, when the provider reported it. */
  usage?: ModelCallUsage | null;
  /** Which path served the call: FLEX, STANDARD, OPENAI (primary) or OPENAI_FALLBACK. */
  servedPath?: ModelServedPath;
}

export type ModelCallFailureKind =
  | "RATE_LIMITED" | "DEADLINE" | "NOT_CONFIGURED" | "CORRECTED" | "FLEX_CAPACITY" | "VALIDATION" | "OTHER";

/**
 * Every provider/model of a call failed. `failures` lists each one with its kind (VALIDATION for
 * an answer that failed schema or identity validation) and a public error summary only.
 */
export class ModelCallFailedError extends Error {
  constructor(
    message: string,
    readonly failures: ReadonlyArray<{ provider: string; model: string; kind: ModelCallFailureKind | null; error: string }>,
  ) {
    super(message);
    this.name = "ModelCallFailedError";
  }
}

/** Marks an error thrown by a response validator so it is told apart from a provider error. */
const VALIDATION_FAILURE = Symbol("modelResponseValidationFailure");

function markValidationFailure(error: unknown): unknown {
  if (error && typeof error === "object") {
    (error as Record<symbol, unknown>)[VALIDATION_FAILURE] = true;
    return error;
  }
  const wrapped = new Error(String(error));
  (wrapped as unknown as Record<symbol, unknown>)[VALIDATION_FAILURE] = true;
  return wrapped;
}

function isValidationFailure(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as Record<symbol, unknown>)[VALIDATION_FAILURE] === true);
}

export interface GenerateContentResponseValidationContext {
  provider: "gemini" | "openai";
  model: string;
  purpose: ModelRoutePurpose;
  routeKey: string;
}

export type GenerateContentResponseValidator<T = unknown> = (
  text: string,
  context: GenerateContentResponseValidationContext
) => T | Promise<T>;

function inferPurposeFromModel(model: string): ModelRoutePurpose {
  if (
    model === MODEL_REGISTRY.DOCUMENT_PRIMARY_MODEL ||
    model === documentOpenAiModel()
  ) {
    return "DOCUMENT";
  }
  return "EVALUATION";
}

function buildRouteDefaults(purpose: ModelRoutePurpose): {
  primaryProviderRaw: string | undefined;
  geminiModel: string;
  openaiModel: string;
} {
  if (purpose === "DOCUMENT") {
    return {
      primaryProviderRaw:
        process.env.DOCUMENT_PRIMARY_PROVIDER || process.env.EVALUATION_PRIMARY_PROVIDER,
      geminiModel: MODEL_REGISTRY.DOCUMENT_PRIMARY_MODEL,
      openaiModel: documentOpenAiModel(),
    };
  }
  if (purpose === "EMBEDDING") {
    return {
      primaryProviderRaw: process.env.EMBEDDING_PRIMARY_PROVIDER,
      geminiModel: MODEL_REGISTRY.EMBEDDING_PRIMARY_MODEL,
      openaiModel: MODEL_REGISTRY.EMBEDDING_FALLBACK_MODEL,
    };
  }
  if (purpose === "EXTRACTION") {
    return {
      primaryProviderRaw: extractionPrimaryProvider(),
      geminiModel: extractionGeminiModel(),
      openaiModel: extractionOpenAIModel(),
    };
  }
  return {
    primaryProviderRaw: process.env.EVALUATION_PRIMARY_PROVIDER,
    geminiModel: MODEL_REGISTRY.EVALUATION_PRIMARY_MODEL,
    openaiModel: evaluationOpenAiModel(),
  };
}

function safeText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return stableStringify(value);
  } catch {
    return String(value);
  }
}

function cleanJsonResponseText(rawText: string): string {
  let cleaned = rawText.trim();
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.replace(/^```json\s*/i, "").replace(/\s*```$/, "");
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```\s*/, "").replace(/\s*```$/, "");
  }

  const objectStart = cleaned.indexOf("{");
  const arrayStart = cleaned.indexOf("[");
  const startCandidates = [objectStart, arrayStart].filter((idx) => idx >= 0);
  const startIdx = startCandidates.length > 0 ? Math.min(...startCandidates) : -1;
  if (startIdx < 0) {
    return cleaned;
  }

  const endIdx = cleaned[startIdx] === "{"
    ? cleaned.lastIndexOf("}")
    : cleaned.lastIndexOf("]");
  if (endIdx > startIdx) {
    return cleaned.substring(startIdx, endIdx + 1);
  }
  return cleaned;
}

const MAX_CORRECTION_REASON_CHARS = 4000;
const MAX_CORRECTION_PREVIOUS_ANSWER_CHARS = 20000;

/** The original request plus why its answer was rejected and the answer itself, for one correction round. */
export function validationCorrectionContents(original: string, reasons: string, previousAnswer: string): string {
  return [
    original,
    "",
    "Your previous answer was rejected for these reasons:",
    reasons.slice(0, MAX_CORRECTION_REASON_CHARS),
    "",
    "Your previous answer:",
    previousAnswer.slice(0, MAX_CORRECTION_PREVIOUS_ANSWER_CHARS),
    "",
    "Return a corrected answer that fixes every reason and follows every rule above.",
  ].join("\n");
}

async function validateGeneratedResponseText(
  text: string,
  context: GenerateContentResponseValidationContext,
  validator?: GenerateContentResponseValidator
): Promise<unknown> {
  if (!text || text.trim().length === 0) {
    throw new Error(`Model ${context.provider}:${context.model} returned empty response text.`);
  }
  if (!validator) {
    return undefined;
  }
  return validator(text, context);
}

export async function generateContentAudited(options: {
  model: string;
  contents: any;
  responseMimeType?: string;
  responseSchema?: any;
  systemInstruction?: string;
  purpose?: ModelRoutePurpose;
  routeKey?: string;
  clientOrPool?: pg.Pool | pg.PoolClient;
  context?: WorkspaceContext;
  seedRoute?: boolean;
  validateResponseText?: GenerateContentResponseValidator;
  /** Per-call request timeout; overrides MODEL_REQUEST_TIMEOUT_MS for this call only. */
  timeoutMs?: number;
  /** Per-call attempts per model; overrides MODEL_REQUEST_MAX_RETRIES for this call only. */
  maxRetries?: number;
  /**
   * When a response fails validateResponseText, ask the same model once more with the validator's
   * reasons before moving on. Only for string contents; provider errors never trigger it.
   */
  correctOnValidationFailure?: boolean;
  /** A second Gemini model tried once when the route's Gemini model fails, before the next provider. */
  secondaryGeminiModel?: string;
  /**
   * Interactive (user-waiting) call: a 60 s default deadline (MODEL_INTERACTIVE_CALL_DEADLINE_MS)
   * and, after the first 429 on a Gemini model, an immediate switch to the secondary model.
   */
  interactive?: boolean;
  /** Per-call deadline across every attempt, wait, model and provider; defaults by `interactive`. */
  deadlineMs?: number;
  /** "document" lets manual document generation use DOCUMENT_GEMINI_API_KEY (AI Studio only). */
  geminiCredentialScope?: GeminiCredentialScope;
  /**
   * Pipeline extraction/evaluation only: start on Vertex Flex PayGo when GEMINI_PIPELINE_FLEX=true
   * and the backend is Vertex. Order: Gemini Flex (GEMINI_FLEX_REQUEST_TIMEOUT_MS, one attempt);
   * on a Flex timeout, 429 or unavailability, one standard PayGo attempt on the same model; only
   * then the fallback provider. The call deadline defaults to GEMINI_FLEX_CALL_DEADLINE_MS.
   */
  flex?: boolean;
  /**
   * Offline model comparison only: call just this provider (with the requested model), with no
   * fallback provider, so each result is that model's own answer.
   */
  onlyProvider?: "gemini" | "openai";
}): Promise<GenerateContentAuditedResult> {
  const startedAt = Date.now();
  const geminiScope: GeminiCredentialScope = options.geminiCredentialScope === "document" ? "document" : "default";
  const geminiProblem = geminiConfigProblem(process.env, geminiScope);
  const openaiKey = process.env.OPENAI_API_KEY;
  const flexEligible = geminiFlexEligible(options);
  // Validate the Flex settings before any request: a malformed value is a configuration error.
  const flexRequestTimeoutMs = flexEligible ? geminiFlexRequestTimeoutMs() : null;
  const deadlineAt = callDeadlineAt(options, startedAt);

  const purpose = options.purpose ?? inferPurposeFromModel(options.model);
  const routeKey = (options.routeKey || purpose.toLowerCase()).trim();

  const { primaryProviderRaw, geminiModel, openaiModel } = buildRouteDefaults(purpose);
  const order = resolveProviderOrder(primaryProviderRaw);
  const explicitModel = String(options.model || "").trim();
  const explicitIsGemini = explicitModel.toLowerCase().startsWith("gemini");
  const geminiModelForCall = explicitIsGemini && explicitModel.length > 0 ? explicitModel : geminiModel;
  const openaiModelForCall = !explicitIsGemini && explicitModel.length > 0 ? explicitModel : openaiModel;
  const defaultContent: ModelRouteRevisionContent = {
    primary_provider: order[0],
    primary_model: order[0] === "gemini" ? geminiModelForCall : openaiModelForCall,
    fallback_provider: order[1],
    fallback_model: order[1] === "gemini" ? geminiModelForCall : openaiModelForCall,
  };

  let routeId: string | null = null;
  let routeRevisionId: string | null = null;
  let routeContent: ModelRouteRevisionContent = defaultContent;

  if (options.clientOrPool) {
    try {
      const ctx = options.context;
      if (ctx && options.seedRoute === true) {
        const ensured = await ensureModelRouteActiveRevision(
          {
            routeKey,
            purpose,
            description: `Auto-seeded from environment for ${purpose.toLowerCase()} route`,
            content: defaultContent,
          },
          options.clientOrPool,
          { context: ctx }
        );
        routeId = ensured.routeId;
        routeRevisionId = ensured.revisionId;
        routeContent = ensured.content;
      } else {
        const active = await getActiveModelRouteRevision(
          routeKey,
          options.clientOrPool as any,
          ctx ? { context: ctx } : undefined
        );
        if (active) {
          routeId = active.routeId;
          routeRevisionId = active.revisionId;
          routeContent = active.content;
        }
      }
    } catch (error: any) {
      if (error?.code !== "42P01") {
        throw error;
      }
    }
  }

  if (options.onlyProvider) {
    const onlyModel = options.onlyProvider === "gemini" ? geminiModelForCall : openaiModelForCall;
    routeContent = {
      primary_provider: options.onlyProvider,
      primary_model: onlyModel,
      fallback_provider: options.onlyProvider,
      fallback_model: onlyModel,
    };
  }

  const attemptedErrors: Array<{
    provider: string;
    model: string;
    error: string;
    publicError?: string;
    /** Why this provider/model failed; drives the rate-limit outcome of the whole call. */
    kind?: ModelCallFailureKind;
    /** Gemini only: the path this failure happened on. */
    path?: GeminiPath;
    retryAfterMs?: number | null;
  }> = [];
  const failureKindOf = (err: unknown): ModelCallFailureKind =>
    isValidationFailure(err)
      ? "VALIDATION"
      : isRateLimitedFailure(err) ? "RATE_LIMITED" : err instanceof ModelCallDeadlineError ? "DEADLINE" : "OTHER";
  const providers: Array<"gemini" | "openai"> = [
    routeContent.primary_provider,
    routeContent.fallback_provider,
  ].filter((value, idx, arr) => arr.indexOf(value) === idx) as Array<"gemini" | "openai">;

  const contentsText = safeText(options.contents);
  const systemText = safeText(options.systemInstruction || "");
  const schemaText = options.responseSchema ? safeText(options.responseSchema) : "";
  const requestHash = sha256Hex(
    stableStringify({
      purpose,
      routeKey,
      contents_sha256: sha256Hex(contentsText),
      system_sha256: sha256Hex(systemText),
      schema_sha256: schemaText ? sha256Hex(schemaText) : null,
      response_mime_type: options.responseMimeType ?? null,
    })
  );

  const requestMetadata: Record<string, unknown> = {
    purpose,
    route_key: routeKey,
    response_mime_type: options.responseMimeType ?? null,
    has_schema: !!options.responseSchema,
    contents_length: contentsText.length,
    system_length: systemText.length,
    model_request_max_retries: effectiveMaxRetries(options.maxRetries),
    model_request_timeout_ms: effectiveTimeoutMs(options.timeoutMs),
    call_deadline_ms: deadlineAt - startedAt,
    interactive: options.interactive === true,
    gemini_flex: flexEligible,
    ...(flexRequestTimeoutMs !== null ? { gemini_flex_request_timeout_ms: flexRequestTimeoutMs } : {}),
  };
  const secondaryGeminiModel = String(options.secondaryGeminiModel || "").trim();
  if (secondaryGeminiModel) {
    requestMetadata.secondary_gemini_model = secondaryGeminiModel;
  }

  let successText: string | null = null;
  let successValidatedPayload: unknown = undefined;
  let successProvider: "gemini" | "openai" = "gemini";
  let successModel = options.model;
  let successGeminiPath: GeminiPath | null = null;
  let flexFailedForCapacity = false;
  let attempts = 0;
  const providerAttemptTelemetry: ModelProviderAttemptTelemetry[] = [];
  const correctionRounds =
    options.correctOnValidationFailure && options.validateResponseText && typeof options.contents === "string" ? 1 : 0;
  if (correctionRounds > 0) {
    requestMetadata.correct_on_validation_failure = true;
  }

  // One model: call it, validate, and on a validation failure (never a provider error) ask the same
  // model to correct its answer, up to correctionRounds times. The last failure is thrown.
  const callAndValidate = async (
    provider: "gemini" | "openai",
    model: string,
    call: (contents: any) => Promise<string>
  ): Promise<{ text: string; validatedPayload: unknown }> => {
    let contents = options.contents;
    for (let round = 0; ; round++) {
      attempts++;
      const text = await call(contents);
      try {
        const validatedPayload = await validateGeneratedResponseText(
          text,
          { provider, model, purpose, routeKey },
          options.validateResponseText
        );
        return { text, validatedPayload };
      } catch (err: any) {
        if (round >= correctionRounds) throw markValidationFailure(err);
        const message = err?.message || String(err);
        console.warn(`[model:${provider}] model=${model} response failed validation; asking it to correct once.`);
        attemptedErrors.push({
          provider,
          model,
          error: message,
          publicError: publicErrorSummary(err, provider),
          kind: "CORRECTED",
        });
        contents = validationCorrectionContents(options.contents, message, text);
      }
    }
  };

  for (const provider of providers) {
    const isFallbackAttempt = provider !== routeContent.primary_provider;
    const modelForProvider =
      provider === routeContent.primary_provider
        ? routeContent.primary_model
        : routeContent.fallback_model;

    if (provider === "gemini") {
      if (geminiProblem) {
        attemptedErrors.push({
          provider,
          model: modelForProvider,
          error: geminiProblem,
          publicError: geminiProblem,
          kind: "NOT_CONFIGURED",
        });
        continue;
      }
      // The route's Gemini model first; then, when configured and different, one secondary
      // Gemini model before moving on to the next provider.
      const geminiModels = [modelForProvider];
      if (secondaryGeminiModel && secondaryGeminiModel !== modelForProvider) {
        geminiModels.push(secondaryGeminiModel);
      }
      for (const [geminiIndex, geminiModel] of geminiModels.entries()) {
        // A Flex-eligible call tries the route's Gemini model on Flex first and, only after a Flex
        // capacity failure, once on standard PayGo. Each of those is a single HTTP attempt.
        const paths: GeminiPath[] = flexEligible && geminiIndex === 0 ? ["FLEX", "STANDARD"] : ["STANDARD"];
        const flexSequence = paths.length > 1;
        for (const path of paths) {
          if (Date.now() >= deadlineAt) {
            attemptedErrors.push({ provider, model: geminiModel, error: "Call deadline passed before this model was tried.",
              publicError: "Call deadline passed before this model was tried.", kind: "DEADLINE", path });
            break;
          }
          if (flexSequence && path === "STANDARD") {
            console.warn(`[model:gemini] model=${geminiModel} Flex PayGo failed for capacity; retrying once on standard PayGo.`);
          }
          try {
            const { text, validatedPayload } = await callAndValidate(provider, geminiModel, (contents) => tryGemini({
              ...options,
              contents,
              model: geminiModel,
              deadlineAt,
              geminiCredentialScope: geminiScope,
              __geminiPath: path,
              singleAttempt: flexSequence,
              // Interactive calls move to the secondary model on the first 429 instead of waiting.
              switchModelOnRateLimit: options.interactive === true && geminiIndex < geminiModels.length - 1,
              __providerAttemptTelemetry: providerAttemptTelemetry,
            }));
            successText = text;
            successValidatedPayload = validatedPayload;
            successProvider = "gemini";
            successModel = geminiModel;
            successGeminiPath = path;
            break;
          } catch (err: any) {
            const message = err?.message || String(err);
            const safeMessage = publicErrorSummary(err, "gemini");
            const flexCapacity = path === "FLEX" && !isValidationFailure(err) && isFlexCapacityFailure(err);
            console.warn(`Gemini model request failed (path=${path}): ${safeMessage}.`);
            attemptedErrors.push({
              provider,
              model: geminiModel,
              error: message,
              publicError: safeMessage,
              kind: flexCapacity ? "FLEX_CAPACITY" : failureKindOf(err),
              path,
              retryAfterMs: rateLimitRetryAfterMs(err),
            });
            if (path === "FLEX") {
              flexFailedForCapacity = flexCapacity;
              // Only a capacity failure moves to standard PayGo; anything else goes to the next provider.
              if (!flexCapacity) break;
            }
          }
        }
        if (successText !== null) break;
      }
      if (successText !== null) break;
    }

    if (provider === "openai") {
      if (!openaiKey) {
        attemptedErrors.push({
          provider,
          model: modelForProvider,
          error: "OPENAI_API_KEY not configured",
          publicError: "OPENAI_API_KEY not configured",
          kind: "NOT_CONFIGURED",
        });
        continue;
      }
      if (Date.now() >= deadlineAt) {
        attemptedErrors.push({ provider, model: modelForProvider, error: "Call deadline passed before this model was tried.",
          publicError: "Call deadline passed before this model was tried.", kind: "DEADLINE" });
        continue;
      }
      try {
        const { text, validatedPayload } = await callAndValidate(provider, modelForProvider, (contents) => tryOpenAI(openaiKey, {
          ...options,
          contents,
          model: modelForProvider,
          __providerAttemptTelemetry: providerAttemptTelemetry,
        }));
        successText = text;
        successValidatedPayload = validatedPayload;
        successProvider = "openai";
        successModel = modelForProvider;
        break;
      } catch (err: any) {
        const message = err?.message || String(err);
        const safeMessage = publicErrorSummary(err, "openai");
        console.warn(`OpenAI model request failed: ${safeMessage}.`);
        const openAiRateLimited = Number(err?.status) === 429 && !isValidationFailure(err);
        attemptedErrors.push({
          provider,
          model: modelForProvider,
          error: message,
          publicError: safeMessage,
          kind: openAiRateLimited ? "RATE_LIMITED" : failureKindOf(err),
          retryAfterMs: openAiRateLimited && typeof err?.retryAfterSecs === "number" ? err.retryAfterSecs * 1000 : null,
        });
      }
    }

    if (isFallbackAttempt) {
      // fall through
    }
  }

  const latencyMs = Date.now() - startedAt;
  // A secondary Gemini model counts as a fallback too; for callers without one, a success on the
  // primary provider always used the primary model, so this matches the provider-only check.
  const fallbackUsed =
    successText !== null &&
    (successProvider !== routeContent.primary_provider || successModel !== routeContent.primary_model);
  const successfulUsage = summarizeSuccessfulUsage(providerAttemptTelemetry, successProvider, successModel);
  const costUsd = estimateCostUsd(successProvider, successModel, successfulUsage);
  const safeAttemptedErrors = attemptedErrors.map(({ provider, model, error, publicError, kind, path }) => ({
    provider,
    model,
    error: publicError ?? publicErrorSummary(error, provider),
    ...(kind ? { kind } : {}),
    ...(path ? { path } : {}),
  }));
  const servedPath: ModelServedPath | null = successText === null
    ? null
    : successProvider === "gemini"
      ? (successGeminiPath ?? "STANDARD")
      : successProvider === routeContent.primary_provider ? "OPENAI" : "OPENAI_FALLBACK";
  const flexRecoveredByStandard = servedPath === "STANDARD" && flexFailedForCapacity;
  const attemptCount = (predicate: (attempt: ModelProviderAttemptTelemetry) => boolean) =>
    providerAttemptTelemetry.filter(predicate).length;
  const isTimeoutAttempt = (attempt: ModelProviderAttemptTelemetry) =>
    attempt.errorKind === "TIMEOUT" || attempt.errorKind === "DEADLINE";
  const isRateLimitedAttempt = (attempt: ModelProviderAttemptTelemetry) => attempt.errorKind === "RATE_LIMITED";
  recordModelCallRoute({
    servedPath,
    fallbackUsed,
    flexAttempted: attemptCount((attempt) => attempt.path === "FLEX") > 0,
    flexRecoveredByStandard,
    timeouts: attemptCount(isTimeoutAttempt),
    rateLimited: attemptCount(isRateLimitedAttempt),
    flexTimeouts: attemptCount((attempt) => attempt.path === "FLEX" && isTimeoutAttempt(attempt)),
    flexRateLimited: attemptCount((attempt) => attempt.path === "FLEX" && isRateLimitedAttempt(attempt)),
  });
  if (flexRecoveredByStandard) {
    console.log(`[model:gemini] model=${successModel} served by standard PayGo after a Flex capacity failure (not degraded).`);
  }
  // The whole call failed only for capacity reasons when at least one model was rate limited and
  // every other model was rate limited, ran out of call deadline, or was not configured. Such a
  // failure is an operational one: callers reschedule it and never count it as a job failure.
  const rateLimitedOutcome =
    successText === null &&
    attemptedErrors.some((entry) => entry.kind === "RATE_LIMITED") &&
    attemptedErrors.every((entry) =>
      entry.kind === "RATE_LIMITED" || entry.kind === "DEADLINE" || entry.kind === "NOT_CONFIGURED" ||
      entry.kind === "CORRECTED" || entry.kind === "FLEX_CAPACITY");

  if (successText === null) {
    const errorMessage = `All model API calls failed. Purpose=${purpose}, route=${routeKey}, errors=${attemptedErrors
      .map((e) => `${e.provider}:${e.model}:${e.error}`)
      .join(" | ")}`;
    const safeErrorMessage = `All model API calls failed. Purpose=${purpose}, route=${routeKey}, errors=${safeAttemptedErrors
      .map((e) => `${e.provider}:${e.model}:${e.error}`)
      .join(" | ")}`;

    if (options.clientOrPool && options.context) {
      await recordModelRouteInvocation(
        {
          routeId,
          revisionId: routeRevisionId,
          purpose,
          provider: attemptedErrors[attemptedErrors.length - 1]?.provider ?? null,
          model: attemptedErrors[attemptedErrors.length - 1]?.model ?? null,
          status: "FAILED",
          fallbackUsed: attemptedErrors.length > 1,
          servedPath: null,
          requestHash,
          requestMetadata,
          responseMetadata: {
            served_path: null,
            flex_to_standard_recovery: false,
            errors: safeAttemptedErrors,
            provider_attempts: providerAttemptTelemetry,
            internal_http_attempts: providerAttemptTelemetry.length,
          },
          latencyMs,
          tokensPrompt: successfulUsage?.promptTokens ?? null,
          tokensCompletion: successfulUsage?.completionTokens ?? null,
          tokensTotal: successfulUsage?.totalTokens ?? null,
          costUsd,
          errorMessage: safeErrorMessage,
        },
        options.clientOrPool,
        { context: options.context }
      );
    }

    if (rateLimitedOutcome) {
      const suggested = attemptedErrors
        .map((entry) => entry.retryAfterMs)
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
      throw new ModelRateLimitedError(errorMessage, {
        provider: attemptedErrors.find((entry) => entry.kind === "RATE_LIMITED")?.provider ?? "gemini",
        model: attemptedErrors.find((entry) => entry.kind === "RATE_LIMITED")?.model ?? null,
        retryAfterMs: suggested.length > 0 ? Math.max(...suggested) : null,
        attempts: providerAttemptTelemetry.length,
      });
    }
    throw new ModelCallFailedError(
      errorMessage,
      safeAttemptedErrors.map(({ provider, model, kind, error }) => ({ provider, model, kind: kind ?? null, error })),
    );
  }

  let invocationId: string | null | undefined = null;
  if (options.clientOrPool && options.context) {
    invocationId = await recordModelRouteInvocation(
      {
        routeId,
        revisionId: routeRevisionId,
        purpose,
        provider: successProvider,
        model: successModel,
        status: "COMPLETED",
        fallbackUsed,
        servedPath,
        requestHash,
        requestMetadata,
        responseMetadata: {
          served_path: servedPath,
          flex_to_standard_recovery: flexRecoveredByStandard,
          response_length: successText.length,
          validated_payload: successValidatedPayload !== undefined,
          errors: safeAttemptedErrors,
          provider_attempts: providerAttemptTelemetry,
          internal_http_attempts: providerAttemptTelemetry.length,
        },
        latencyMs,
        tokensPrompt: successfulUsage?.promptTokens ?? null,
        tokensCompletion: successfulUsage?.completionTokens ?? null,
        tokensTotal: successfulUsage?.totalTokens ?? null,
        costUsd,
      },
      options.clientOrPool,
      { context: options.context }
    );
  }

  return {
    text: successText,
    provider: successProvider,
    model: successModel,
    fallbackUsed,
    attempts,
    errors: attemptedErrors.map(({ provider, model, error }) => ({ provider, model, error })),
    latencyMs,
    routeKey,
    routeRevisionId: routeRevisionId ?? undefined,
    invocationId,
    validatedPayload: successValidatedPayload,
    usage: successfulUsage,
    servedPath: servedPath ?? undefined,
  };
}

export type EmbeddingProvider = "gemini" | "openai";

type GeminiEmbeddingDisableState = { reason: string; logged: boolean };
const geminiEmbeddingDisableByModel = new Map<string, GeminiEmbeddingDisableState>();

function geminiEmbeddingDisableKey(model: string): string {
  const apiVersion = (process.env.GEMINI_API_VERSION || "default").trim() || "default";
  return `${apiVersion}:${model}`;
}

function rawErrorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function describeError(error: unknown): string {
  return publicErrorSummary(error, "embedding");
}

function isGeminiEmbeddingModelNotFound(error: unknown): boolean {
  const message = rawErrorText(error);
  try {
    const parsed = JSON.parse(message) as any;
    const code = parsed?.error?.code;
    const status = parsed?.error?.status;
    if (code === 404 || status === "NOT_FOUND") {
      return true;
    }
  } catch {
    // ignore
  }

  const lowered = message.toLowerCase();
  return (
    lowered.includes("not found for api version") ||
    (lowered.includes("not found") && lowered.includes("text-embedding")) ||
    lowered.includes("not supported for embedcontent") ||
    lowered.includes("status\":\"not_found\"")
  );
}

async function embedWithGemini(text: string): Promise<number[]> {
  return embedWithGeminiModel(text, MODEL_REGISTRY.EMBEDDING_PRIMARY_MODEL);
}

async function embedWithGeminiModel(text: string, model: string): Promise<number[]> {
  const [vector] = await embedGeminiRequest([text], model);
  return vector;
}

/**
 * Inputs per Gemini embedContent request. AI Studio accepts up to 100 per batch request; Vertex AI
 * documents gemini-embedding-001 as one input per request, so Vertex defaults to 1 until
 * EMBEDDING_GEMINI_BATCH_SIZE raises it for a model that accepts more.
 */
export function geminiEmbeddingBatchSize(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(String(env.EMBEDDING_GEMINI_BATCH_SIZE ?? ""), 10);
  if (Number.isFinite(parsed) && parsed > 0) return Math.min(parsed, 250);
  return currentGeminiBackend() === "vertex" ? 1 : 100;
}

/** Inputs per provider embedding request: Gemini as above, OpenAI up to 100. */
export function embeddingRequestBatchSize(provider: EmbeddingProvider, env: NodeJS.ProcessEnv = process.env): number {
  return provider === "gemini" ? geminiEmbeddingBatchSize(env) : 100;
}

/**
 * One embedContent request for `texts` (in order), with the same rate-limit handling as text
 * generation: limiter slot first; 429 retried with jittered backoff or the server's RetryInfo;
 * timeouts/5xx retried up to MODEL_REQUEST_MAX_RETRIES; nothing waits past the pipeline deadline.
 * Returns exactly one vector per input or throws.
 */
async function embedGeminiRequest(texts: string[], model: string): Promise<number[][]> {
  const normalizedModel = (model || "").trim();
  if (!normalizedModel) {
    throw new Error("Gemini embedding requested but model is empty.");
  }

  const disabled = geminiEmbeddingDisableByModel.get(geminiEmbeddingDisableKey(normalizedModel));
  if (disabled?.reason) {
    throw new Error(`Gemini embedding disabled for ${normalizedModel}: ${disabled.reason}`);
  }

  const ai = getGeminiClient();
  const backend = currentGeminiBackend();
  const timeoutMs = embeddingRequestTimeoutMs();
  const configuredDimensions = Number(process.env.EMBEDDING_PRIMARY_DIMENSIONS || 768);
  const outputDimensionality = Number.isInteger(configuredDimensions) && configuredDimensions > 0
    ? configuredDimensions
    : undefined;
  const deadlineAt = Date.now() + pipelineCallDeadlineMs();
  const limiter = getModelLimiter(normalizedModel);
  const maxRetries = modelRequestMaxRetries();
  const maxRateLimitAttempts = rateLimitMaxAttempts();
  let otherFailures = 0;
  let rateLimitFailures = 0;
  let lastWasRateLimit = false;

  for (let attempt = 1; ; attempt++) {
    if (Date.now() >= deadlineAt) {
      throw new ModelCallDeadlineError(`Gemini embedding ${normalizedModel} call deadline passed.`, {
        model: normalizedModel, deadlineMs: pipelineCallDeadlineMs(), rateLimited: lastWasRateLimit, retryAfterMs: null,
      });
    }
    const permit = await limiter.acquire(estimateTokens(...texts), deadlineAt);
    const callTimeoutMs = Math.max(1, Math.min(timeoutMs, deadlineAt - Date.now()));
    try {
      const response = await ai.models.embedContent({
        model: normalizedModel,
        contents: texts.length === 1 ? texts[0] : texts,
        config: {
          ...(outputDimensionality ? { outputDimensionality } : {}),
          abortSignal: AbortSignal.timeout(callTimeoutMs),
          httpOptions: { timeout: callTimeoutMs },
        },
      });
      permit.release();
      recordProviderCall({ provider: "gemini", model: normalizedModel, outcome: "OK", retry: attempt > 1 });
      const embeddings = response.embeddings ?? [];
      if (embeddings.length !== texts.length) {
        throw new EmbeddingResponseShapeError(
          `Gemini embedding returned ${embeddings.length} vector(s) for ${texts.length} input(s).`
        );
      }
      return embeddings.map((embedding, index) => {
        const vals = embedding?.values;
        if (!vals || vals.length === 0) {
          throw new EmbeddingResponseShapeError(`Gemini embedding returned empty values for input ${index + 1}.`);
        }
        return vals;
      });
    } catch (error: any) {
      permit.release();
      if (error instanceof EmbeddingResponseShapeError) throw error;
      if (isGeminiEmbeddingModelNotFound(error)) {
        recordProviderCall({ provider: "gemini", model: normalizedModel, outcome: "OTHER", retry: attempt > 1 });
        const reason = `model not found/unsupported; set GEMINI_API_VERSION or configure EMBEDDING_PRIMARY_MODEL to one that supports embedContent`;
        const disableKey = geminiEmbeddingDisableKey(normalizedModel);
        const prior = geminiEmbeddingDisableByModel.get(disableKey) || { reason: "", logged: false };
        geminiEmbeddingDisableByModel.set(disableKey, { reason, logged: prior.logged });
        if (!prior.logged) {
          geminiEmbeddingDisableByModel.set(disableKey, { reason, logged: true });
          console.warn(`⚠️ Gemini embedding disabled for ${normalizedModel}: ${reason}`);
        }
        throw error;
      }
      const classification = classifyGeminiError(error, backend);
      const kind = geminiFailureKind(classification);
      recordProviderCall({ provider: "gemini", model: normalizedModel, outcome: kind, retry: attempt > 1 });
      lastWasRateLimit = classification.rateLimit;
      if (classification.rateLimit) rateLimitFailures += 1;
      else if (classification.retryable) otherFailures += 1;
      const exhausted = classification.rateLimit ? rateLimitFailures >= maxRateLimitAttempts : otherFailures >= maxRetries;
      const suggestedMs = serverSuggestedDelayMs(error);
      if (classification.rateLimit && exhausted) {
        throw new ModelRateLimitedError(
          `Gemini embedding ${normalizedModel} rate limited (429) after ${rateLimitFailures} attempt(s): ${publicErrorSummary(error, "embedding")}`,
          { provider: "gemini", model: normalizedModel, retryAfterMs: suggestedMs, attempts: attempt },
        );
      }
      if (!classification.retryable || exhausted) throw error;
      const backoffMs = suggestedMs ?? fullJitterBackoffMs(classification.rateLimit ? rateLimitFailures : otherFailures, backoffOptionsFromEnv());
      if (backoffMs >= deadlineAt - Date.now()) {
        throw new ModelCallDeadlineError(
          `Gemini embedding ${normalizedModel} ${kind} and the retry wait would pass the call deadline.`,
          { model: normalizedModel, deadlineMs: pipelineCallDeadlineMs(), rateLimited: classification.rateLimit, retryAfterMs: backoffMs },
        );
      }
      console.warn(`[embeddings:gemini] model=${normalizedModel} ${kind} attempt=${attempt}; retrying in ${Math.round(backoffMs)}ms.`);
      await sleepMs(backoffMs);
    }
  }
}

class EmbeddingResponseShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingResponseShapeError";
  }
}

export type EmbeddingOutcome = { ok: true; vector: number[] } | { ok: false; error: unknown };

/**
 * Embeds many inputs with as few requests as the provider allows (Gemini: up to
 * geminiEmbeddingBatchSize() per request; OpenAI: up to 100). Returns one outcome per input, in
 * order: a failed request fails every input it carried with that request's error, so callers keep
 * per-input validation and outcomes. Never fabricates a vector.
 */
export async function generateEmbeddingsWithProviderAndModel(
  texts: readonly string[],
  provider: EmbeddingProvider,
  model: string,
): Promise<EmbeddingOutcome[]> {
  if (texts.length === 0) return [];
  if (provider === "gemini") {
    const geminiProblem = geminiConfigProblem();
    if (geminiProblem) {
      const error = new Error(`Gemini embedding requested but Gemini is not configured: ${geminiProblem}`);
      return texts.map(() => ({ ok: false as const, error }));
    }
  }
  const chunkSize = embeddingRequestBatchSize(provider);
  const outcomes: EmbeddingOutcome[] = [];
  for (let start = 0; start < texts.length; start += chunkSize) {
    const chunk = texts.slice(start, start + chunkSize);
    try {
      const vectors = provider === "gemini"
        ? await embedGeminiRequest(chunk, model)
        : await embedOpenAIRequest(chunk, model);
      for (const vector of vectors) outcomes.push({ ok: true, vector });
    } catch (error) {
      for (let index = 0; index < chunk.length; index += 1) outcomes.push({ ok: false, error });
    }
  }
  return outcomes;
}

async function embedWithOpenAI(text: string): Promise<number[]> {
  return embedWithOpenAIModel(text, MODEL_REGISTRY.EMBEDDING_FALLBACK_MODEL);
}

async function embedWithOpenAIModel(text: string, model: string): Promise<number[]> {
  const [vector] = await embedOpenAIRequest([text], model);
  return vector;
}

/** One OpenAI embeddings request for `texts`; returns one vector per input (in order) or throws. */
async function embedOpenAIRequest(texts: readonly string[], model: string): Promise<number[][]> {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    throw new Error("OpenAI embedding requested but OPENAI_API_KEY is not configured.");
  }

  const normalizedModel = (model || "").trim();
  if (!normalizedModel) {
    throw new Error("OpenAI embedding requested but model is empty.");
  }

  const configuredDimensions = Number(process.env.EMBEDDING_FALLBACK_DIMENSIONS || 0);
  const supportsConfigurableDimensions = normalizedModel.startsWith("text-embedding-3-");
  const requestBody: Record<string, unknown> = {
    input: texts.length === 1 ? texts[0] : [...texts],
    model: normalizedModel,
  };
  if (supportsConfigurableDimensions && Number.isInteger(configuredDimensions) && configuredDimensions > 0) {
    requestBody.dimensions = configuredDimensions;
  }

  const timeoutMs = embeddingRequestTimeoutMs();
  const oResponse = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${openaiKey}`,
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!oResponse.ok) {
    recordProviderCall({
      provider: "openai", model: normalizedModel, outcome: oResponse.status === 429 ? "RATE_LIMITED" : "OTHER", retry: false,
    });
    const errText = await oResponse.text();
    const error: any = new Error(`OpenAI embedding HTTP ${oResponse.status}: ${errText}`);
    error.status = oResponse.status;
    if (oResponse.status === 429) error.rateLimited = true;
    throw error;
  }
  recordProviderCall({ provider: "openai", model: normalizedModel, outcome: "OK", retry: false });
  const oData = await oResponse.json();
  const rows: Array<{ index?: number; embedding?: number[] }> = Array.isArray(oData.data) ? oData.data : [];
  if (rows.length !== texts.length) {
    throw new Error(`OpenAI embedding returned ${rows.length} vector(s) for ${texts.length} input(s).`);
  }
  const ordered = [...rows].sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
  return ordered.map((row, index) => {
    const vals = row.embedding;
    if (!vals || vals.length === 0) throw new Error(`OpenAI embedding returned empty values for input ${index + 1}.`);
    return vals;
  });
}

export async function generateEmbeddingWithProvider(
  text: string,
  provider: EmbeddingProvider
): Promise<number[]> {
  return generateEmbeddingWithProviderAndModel(
    text,
    provider,
    provider === "gemini" ? MODEL_REGISTRY.EMBEDDING_PRIMARY_MODEL : MODEL_REGISTRY.EMBEDDING_FALLBACK_MODEL
  );
}

export async function generateEmbeddingWithProviderAndModel(
  text: string,
  provider: EmbeddingProvider,
  model: string
): Promise<number[]> {
  if (provider === "gemini") {
    const geminiProblem = geminiConfigProblem();
    if (geminiProblem) {
      throw new Error(`Gemini embedding requested but Gemini is not configured: ${geminiProblem}`);
    }
    return embedWithGeminiModel(text, model);
  }

  return embedWithOpenAIModel(text, model);
}

/**
 * Generate a text embedding vector. Provider order:
 *  1. Gemini gemini-embedding-001 (if Gemini is configured: AI Studio key or Vertex)
 *  2. OpenAI text-embedding-3-small (if OPENAI_API_KEY present)
 * THROWS if both fail or neither key is configured — never fabricates random
 * or zero vectors, which would produce silent mis-classifications in laneRouter.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const geminiKey = isGeminiConfigured();
  const openaiKey = process.env.OPENAI_API_KEY;

  const providerOrder = resolveProviderOrder(process.env.EMBEDDING_PRIMARY_PROVIDER);

  let lastError: unknown = null;

  for (const provider of providerOrder) {
    if (provider === "gemini") {
      const disabled =
        MODEL_REGISTRY.EMBEDDING_PRIMARY_MODEL &&
        geminiEmbeddingDisableByModel.get(
          geminiEmbeddingDisableKey(MODEL_REGISTRY.EMBEDDING_PRIMARY_MODEL)
        )?.reason;
      if (!geminiKey || disabled) {
        continue;
      }
    } else {
      if (!openaiKey) {
        continue;
      }
    }

    try {
      return await generateEmbeddingWithProvider(text, provider);
    } catch (error: unknown) {
      lastError = error;
      const message = describeError(error);
      if (provider === "gemini") {
        console.warn(`⚠️ Gemini embedding failed: ${message}. Trying OpenAI fallback...`);
      } else {
        console.warn(`⚠️ OpenAI embedding failed: ${message}`);
      }
    }
  }

  throw new Error(
    "Embedding generation failed: both Gemini and OpenAI providers unavailable or returned no values. " +
      `Last error: ${describeError(lastError)}`
  );
}

export interface ModelRoutePreflight {
  evaluation: boolean;
  embedding: boolean;
  document: boolean;
  extraction: boolean;
  errors: string[];
  checks: Array<{
    route: "evaluation" | "document" | "extraction" | "embedding";
    purpose: ModelRoutePurpose;
    provider: "gemini" | "openai";
    model: string;
    role: "primary" | "fallback";
    ok: boolean;
    degraded: boolean;
    latencyMs: number;
    error?: string;
  }>;
  degradedRoutes: string[];
}

/** Perform minimal live calls so invalid configured model IDs fail before ingestion. */
export async function preflightModelRoutes(): Promise<ModelRoutePreflight> {
  const geminiKey = isGeminiConfigured();
  const openaiKey = process.env.OPENAI_API_KEY;
  const errors: string[] = [];
  const checks: ModelRoutePreflight["checks"] = [];
  const degradedRoutes: string[] = [];

  const jsonOkSchema = {
    type: "object",
    additionalProperties: false,
    required: ["ok"],
    properties: {
      ok: { type: "string" },
    },
  };

  const checkTextRoute = async (
    label: "evaluation" | "document" | "extraction",
    purpose: ModelRoutePurpose,
    geminiModel: string,
    openaiModel: string,
    primaryProviderRaw: string | undefined
  ): Promise<boolean> => {
    const order = resolveProviderOrder(primaryProviderRaw);
    let routeOk = false;
    for (const [providerIndex, provider] of order.entries()) {
      const role = providerIndex === 0 ? "primary" : "fallback";
      const startedAt = Date.now();
      if (provider === "gemini") {
        if (!geminiKey) {
          checks.push({
            route: label,
            purpose,
            provider,
            model: geminiModel,
            role,
            ok: false,
            degraded: role === "primary",
            latencyMs: 0,
            error: geminiConfigProblem() ?? "Gemini not configured",
          });
          continue;
        }
        try {
          await tryGemini({
            model: geminiModel,
            contents: purpose === "EXTRACTION" ? 'Return {"ok":"OK"}.' : "Reply with OK.",
            responseMimeType: purpose === "EXTRACTION" ? "application/json" : "text/plain",
            responseSchema: purpose === "EXTRACTION" ? jsonOkSchema : undefined,
          });
          checks.push({
            route: label,
            purpose,
            provider,
            model: geminiModel,
            role,
            ok: true,
            degraded: role === "fallback",
            latencyMs: Date.now() - startedAt,
          });
          routeOk = true;
        } catch (err: any) {
          checks.push({
            route: label,
            purpose,
            provider,
            model: geminiModel,
            role,
            ok: false,
            degraded: role === "primary",
            latencyMs: Date.now() - startedAt,
            error: publicErrorSummary(err, provider),
          });
        }
      }

      if (provider === "openai") {
        if (!openaiKey) {
          checks.push({
            route: label,
            purpose,
            provider,
            model: openaiModel,
            role,
            ok: false,
            degraded: role === "primary",
            latencyMs: 0,
            error: "OPENAI_API_KEY not configured",
          });
          continue;
        }
        try {
          await tryOpenAI(openaiKey, {
            model: openaiModel,
            contents: purpose === "EXTRACTION" ? 'Return {"ok":"OK"}.' : "Reply with OK.",
            responseMimeType: purpose === "EXTRACTION" ? "application/json" : "text/plain",
            responseSchema: purpose === "EXTRACTION" ? jsonOkSchema : undefined,
          });
          checks.push({
            route: label,
            purpose,
            provider,
            model: openaiModel,
            role,
            ok: true,
            degraded: role === "fallback",
            latencyMs: Date.now() - startedAt,
          });
          routeOk = true;
        } catch (err: any) {
          checks.push({
            route: label,
            purpose,
            provider,
            model: openaiModel,
            role,
            ok: false,
            degraded: role === "primary",
            latencyMs: Date.now() - startedAt,
            error: publicErrorSummary(err, provider),
          });
        }
      }
    }

    const routeChecks = checks.filter((check) => check.route === label);
    const primaryCheck = routeChecks.find((check) => check.role === "primary");
    const fallbackCheck = routeChecks.find((check) => check.role === "fallback");
    if (!routeOk) {
      errors.push(
        `${label}: no usable provider. ${routeChecks
          .map((check) => `${check.provider}(${check.model}): ${check.error || "failed"}`)
          .join(" | ")}`
      );
    } else if (primaryCheck && !primaryCheck.ok && fallbackCheck?.ok) {
      degradedRoutes.push(`${label}: primary ${primaryCheck.provider} failed; fallback ${fallbackCheck.provider} passed`);
    } else if (primaryCheck?.ok && fallbackCheck && !fallbackCheck.ok) {
      degradedRoutes.push(`${label}: fallback ${fallbackCheck.provider} unavailable`);
    }
    return routeOk;
  };

  const evaluation = await checkTextRoute(
    "evaluation",
    "EVALUATION",
    MODEL_REGISTRY.EVALUATION_PRIMARY_MODEL,
    evaluationOpenAiModel(),
    process.env.EVALUATION_PRIMARY_PROVIDER
  );
  const document = await checkTextRoute(
    "document",
    "DOCUMENT",
    MODEL_REGISTRY.DOCUMENT_PRIMARY_MODEL,
    documentOpenAiModel(),
    process.env.DOCUMENT_PRIMARY_PROVIDER || process.env.EVALUATION_PRIMARY_PROVIDER
  );
  const extraction = await checkTextRoute(
    "extraction",
    "EXTRACTION",
    extractionGeminiModel(),
    extractionOpenAIModel(),
    extractionPrimaryProvider()
  );
  let embedding = false;
  const embeddingStartedAt = Date.now();
  try {
    await generateEmbedding("preflight");
    embedding = true;
    checks.push({
      route: "embedding",
      purpose: "EMBEDDING",
      provider: resolveProviderOrder(process.env.EMBEDDING_PRIMARY_PROVIDER)[0],
      model: resolveProviderOrder(process.env.EMBEDDING_PRIMARY_PROVIDER)[0] === "gemini"
        ? MODEL_REGISTRY.EMBEDDING_PRIMARY_MODEL
        : MODEL_REGISTRY.EMBEDDING_FALLBACK_MODEL,
      role: "primary",
      ok: true,
      degraded: false,
      latencyMs: Date.now() - embeddingStartedAt,
    });
  } catch (err: any) {
    errors.push(publicErrorSummary(err, "embedding"));
    checks.push({
      route: "embedding",
      purpose: "EMBEDDING",
      provider: resolveProviderOrder(process.env.EMBEDDING_PRIMARY_PROVIDER)[0],
      model: resolveProviderOrder(process.env.EMBEDDING_PRIMARY_PROVIDER)[0] === "gemini"
        ? MODEL_REGISTRY.EMBEDDING_PRIMARY_MODEL
        : MODEL_REGISTRY.EMBEDDING_FALLBACK_MODEL,
      role: "primary",
      ok: false,
      degraded: false,
      latencyMs: Date.now() - embeddingStartedAt,
      error: publicErrorSummary(err, "embedding"),
    });
  }

  return { evaluation, embedding, document, extraction, errors, checks, degradedRoutes };
}

export interface SingleEvaluationJobInput {
  canonicalJobId: string;
  jobVersionId: string;
  normalizedTitle: string;
  companyName: string;
  canonicalUrl: string;
  descriptionText: string;
  gateDecisionId?: string | null;
  gateDecision?: string;
  candidateLane?: string;
  priorityScore?: number;
  workabilityFacts?: any;
  /** Serialized active database-backed profile/policy context for this evaluation. */
  candidateProfileContext: string;
}

export interface SingleEvaluationExecutionResult {
  evaluatedJob: EvaluationResult;
  provider: "gemini" | "openai" | "ollama";
  model: string;
  fallbackUsed: boolean;
  attempts: number;
  errors: string[];
  degraded: boolean;
  trace: string[];
  /** Token usage of the successful call, when the provider reported it. */
  usage?: ModelCallUsage | null;
  /** Which path served the evaluation (FLEX, STANDARD, OPENAI, OPENAI_FALLBACK). */
  servedPath?: ModelServedPath;
}

interface ValidatedSingleEvaluationPayload {
  root: Record<string, any>;
  jobPayload: Record<string, any>;
}

export const MAX_SINGLE_EVALUATION_RESPONSE_BYTES = 256 * 1024;
const EVALUATION_ARRAY_LIMITS = {
  secondary_lanes: 6,
  rejection_codes: 50,
  culture_evidence: 4,
  strengths: 50,
  gaps: 50,
  risk_flags: 50,
  policy_conflicts: 25,
} as const;

function assertEvaluationPayloadBounds(root: Record<string, any>): void {
  for (const [field, limit] of Object.entries(EVALUATION_ARRAY_LIMITS)) {
    const collection = root[field];
    if (Array.isArray(collection) && collection.length > limit) {
      throw new RangeError(`Evaluation output field "${field}" exceeds the ${limit}-item limit.`);
    }
  }
}

function hasOwnField(value: Record<string, any>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function requireStringField(value: Record<string, any>, field: string): string {
  if (!hasOwnField(value, field) || typeof value[field] !== "string" || value[field].trim().length === 0) {
    throw new Error(`Evaluation output missing required string field "${field}".`);
  }
  return value[field];
}

function requirePresentField(value: Record<string, any>, field: string): void {
  if (!hasOwnField(value, field)) {
    throw new Error(`Evaluation output missing required field "${field}".`);
  }
}

function requireScoreField(value: Record<string, any>, field: string): void {
  if (!hasOwnField(value, field)) {
    throw new Error(`Evaluation output missing required score field "${field}".`);
  }
  if (value[field] === null) {
    return;
  }

  const score = value[field];
  if (!Number.isInteger(score) || score < 0 || score > 100) {
    throw new Error(`Evaluation output field "${field}" must be null or an integer from 0 to 100.`);
  }
}

function requireFiniteMeasurementField(value: Record<string, any>, field: string): void {
  if (!hasOwnField(value, field)) {
    throw new Error(`Evaluation output missing required measurement field "${field}".`);
  }
  if (value[field] === null) {
    return;
  }

  const measurement = value[field];
  if (typeof measurement !== "number" || !Number.isFinite(measurement) || measurement < 0 || measurement > 100) {
    throw new Error(`Evaluation output field "${field}" must be null or a finite number from 0 to 100.`);
  }
}

function parseStrictSingleEvaluationPayload(
  rawText: string,
  job: SingleEvaluationJobInput
): ValidatedSingleEvaluationPayload {
  if (Buffer.byteLength(rawText, "utf8") > MAX_SINGLE_EVALUATION_RESPONSE_BYTES) {
    throw new RangeError(`Evaluation response exceeds the ${MAX_SINGLE_EVALUATION_RESPONSE_BYTES}-byte limit.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleanJsonResponseText(rawText));
  } catch {
    throw new Error("Evaluation provider returned invalid JSON; response content omitted.");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Evaluation output must be a single JSON object.");
  }

  const root = parsed as Record<string, any>;
  const evaluatedJobs = root.evaluated_jobs;
  if (Array.isArray(evaluatedJobs) && evaluatedJobs.length !== 1) {
    throw new Error(`Evaluation output must contain exactly one evaluated job; received ${evaluatedJobs.length}.`);
  }
  const jobPayload = Array.isArray(evaluatedJobs) ? evaluatedJobs[0] : root;
  if (!jobPayload || typeof jobPayload !== "object" || Array.isArray(jobPayload)) {
    throw new Error("Evaluation output contained no valid job payload.");
  }
  assertEvaluationPayloadBounds(jobPayload);

  const reportedCanonicalJobId = requireStringField(jobPayload, "canonical_job_id");
  if (reportedCanonicalJobId !== job.canonicalJobId) {
    throw new Error(
      `Evaluation identity mismatch: response canonical_job_id ${reportedCanonicalJobId} does not match request ${job.canonicalJobId}`
    );
  }

  const reportedJobVersionId = requireStringField(jobPayload, "job_version_id");
  if (reportedJobVersionId !== job.jobVersionId) {
    throw new Error(
      `Evaluation identity mismatch: response job_version_id ${reportedJobVersionId} does not match request ${job.jobVersionId}`
    );
  }

  const summary =
    typeof root.evaluation_summary === "string"
      ? root.evaluation_summary
      : typeof jobPayload.evaluation_summary === "string"
        ? jobPayload.evaluation_summary
        : "";
  if (summary.trim().length === 0) {
    throw new Error('Evaluation output missing required string field "evaluation_summary".');
  }

  for (const field of [
    "primary_lane",
    "secondary_lanes",
    "lane_confidence",
    "lane_evidence",
    "rejection_codes",
    "strategic_value",
    "recommended_cv_version",
    "next_action",
  ]) {
    requirePresentField(jobPayload, field);
  }

  if (!Array.isArray(jobPayload.secondary_lanes)) {
    throw new Error('Evaluation output field "secondary_lanes" must be an array.');
  }
  if (!Array.isArray(jobPayload.rejection_codes)) {
    throw new Error('Evaluation output field "rejection_codes" must be an array.');
  }

  for (const field of [
    "nd_score",
    "nd_friendly_score",
    "politics_stress_score",
    "sensory_overload_index",
  ]) {
    requireScoreField(jobPayload, field);
  }
  requireFiniteMeasurementField(jobPayload, "building_research_ratio");
  requireFiniteMeasurementField(jobPayload, "interaction_load");

  return { root, jobPayload: jobPayload as Record<string, any> };
}

function buildEvaluationResultFromValidatedPayload(
  validated: ValidatedSingleEvaluationPayload,
  job: SingleEvaluationJobInput,
  pipelineRunId: string,
  attemptNum: number,
  response: Pick<GenerateContentAuditedResult, "provider" | "model" | "fallbackUsed" | "servedPath">
): EvaluationResult {
  const { root, jobPayload } = validated;
  const evaluationSummary =
    typeof root.evaluation_summary === "string"
      ? root.evaluation_summary
      : jobPayload.evaluation_summary;

  // Safely normalize optional culture_evidence before validation:
  // If an optional culture evidence quote is unsupported (not a verbatim substring of descriptionText,
  // or cannot be derived via scoreCultureEvidenceFromQuote), safely treat it as unmeasured (null score and null quote)
  // so an unsupported optional culture quote never fails the entire job evaluation.
  const rawCultureEvidence = Array.isArray(jobPayload.culture_evidence)
    ? jobPayload.culture_evidence
    : [];

  const sanitizedCultureEvidence = rawCultureEvidence.map((evidence: any) => {
    if (!evidence || typeof evidence !== "object") return evidence;
    const signal = evidence.signal;
    const rawQuote = typeof evidence.quote === "string" ? evidence.quote : null;

    if (!rawQuote || rawQuote.trim().length === 0) {
      return {
        ...evidence,
        score: null,
        quote: null,
        score_derivation_version: CULTURE_SCORE_DERIVATION_VERSION,
      };
    }

    if (!job.descriptionText.includes(rawQuote)) {
      console.warn(
        `[culture_evidence] Optional quote for ${signal} is not a verbatim substring of the job description; safely treating as unmeasured.`
      );
      return {
        ...evidence,
        score: null,
        quote: null,
        score_derivation_version: CULTURE_SCORE_DERIVATION_VERSION,
      };
    }

    const supportedScore = scoreCultureEvidenceFromQuote(signal, rawQuote);
    if (supportedScore === null) {
      console.warn(
        `[culture_evidence] Quote for ${signal} in job description does not match deterministic phrase rules; safely treating as unmeasured.`
      );
      return {
        ...evidence,
        score: null,
        quote: null,
        score_derivation_version: CULTURE_SCORE_DERIVATION_VERSION,
      };
    }

    return {
      ...evidence,
      score: supportedScore,
      quote: rawQuote,
      score_derivation_version: CULTURE_SCORE_DERIVATION_VERSION,
    };
  });

  const result = EvaluationResultSchema.parse({
    schema_version: SCHEMA_VERSION,
    canonical_job_id: jobPayload.canonical_job_id,
    job_version_id: jobPayload.job_version_id,
    pipeline_run_id: pipelineRunId,
    provider: response.provider,
    model: response.model,
    attempt: attemptNum,
    // Only a fallback provider/model is degraded; the standard retry after Flex is not.
    is_fallback: response.fallbackUsed,
    degraded_state: response.fallbackUsed,
    served_path: response.servedPath ?? null,
    evaluation_summary: evaluationSummary,
    primary_lane: jobPayload.primary_lane,
    secondary_lanes: jobPayload.secondary_lanes,
    lane_confidence: jobPayload.lane_confidence,
    lane_evidence: jobPayload.lane_evidence,
    nd_score: jobPayload.nd_score,
    nd_friendly_score: jobPayload.nd_friendly_score,
    politics_stress_score: jobPayload.politics_stress_score,
    sensory_overload_index: jobPayload.sensory_overload_index,
    building_research_ratio: jobPayload.building_research_ratio,
    interaction_load: jobPayload.interaction_load,
    focus_protection_score: jobPayload.focus_protection_score,
    strategic_value_score: jobPayload.strategic_value_score,
    career_trajectory: jobPayload.career_trajectory,
    technical_depth_score: jobPayload.technical_depth_score,
    role_ownership_score: jobPayload.role_ownership_score,
    ambiguity_burden: jobPayload.ambiguity_burden,
    meeting_burden: jobPayload.meeting_burden,
    travel_burden: jobPayload.travel_burden,
    on_call_burden: jobPayload.on_call_burden,
    strengths: jobPayload.strengths,
    gaps: jobPayload.gaps,
    risk_flags: jobPayload.risk_flags,
    policy_conflicts: jobPayload.policy_conflicts,
    culture_score_derivation_version: CULTURE_SCORE_DERIVATION_VERSION,
    culture_evidence: sanitizedCultureEvidence,
    rejection_codes: jobPayload.rejection_codes,
    strategic_value: jobPayload.strategic_value,
    recommended_cv_version: jobPayload.recommended_cv_version,
    next_action: jobPayload.next_action,
    evaluated_at: new Date().toISOString()
  });

  const scoreForSignal = (signal: EvaluationResult["culture_evidence"][number]["signal"]): number | null => {
    const score = result.culture_evidence.find((evidence) => evidence.signal === signal)?.score;
    return typeof score === "number" ? score : null;
  };
  result.nd_friendly_score = scoreForSignal("AUTONOMY");
  result.politics_stress_score = scoreForSignal("POLITICS_RISK");
  result.sensory_overload_index = scoreForSignal("SENSORY_WORKLOAD_RISK");
  result.focus_protection_score = scoreForSignal("FOCUS_PROTECTION");
  result.strategic_value_score = null;
  for (const conflict of result.policy_conflicts) {
    if (!job.descriptionText.includes(conflict.evidence)) {
      throw new Error(
        `Evaluation policy-conflict evidence quote for ${conflict.policy} is not a verbatim substring of the job description.`
      );
    }
  }

  return result;
}

/**
 * Pure evaluation function for a single canonical job version.
 * - No database-query tools
 * - No side-effect database writes
 * - Exactly one result returned
 * - Strict canonical_job_id and job_version_id identity validation
 * - Requires explicit legacy score fields while allowing null for unavailable measurements
 */
export async function evaluateSingleCanonicalJob(
  job: SingleEvaluationJobInput,
  pipelineRunId: string = crypto.randomUUID(),
  attemptNum: number = 1,
  /**
   * Offline comparison only (scripts/compare_evaluation_models.ts): evaluate with this model id,
   * on this provider alone (no fallback provider).
   */
  options: { modelOverride?: string; onlyProvider?: "gemini" | "openai" } = {},
): Promise<SingleEvaluationExecutionResult> {
  if (!job.candidateProfileContext || job.candidateProfileContext.trim().length === 0) {
    throw new Error(
      "AI evaluation requires an active database-backed candidateProfileContext; refusing fixed in-code profile fallback."
    );
  }
  const geminiKey = isGeminiConfigured();
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!geminiKey && !openaiKey) {
    throw new Error(
      "CRITICAL API KEY CONFLICT: Neither Gemini (GEMINI_API_KEY or GEMINI_BACKEND=vertex) nor OPENAI_API_KEY is configured."
    );
  }

  const trace: string[] = [];
  const prompt = `
You are an expert Executive Career Architect and AI Decision Engine.
Evaluate the single job below strictly against candidate fit, lane classifications, and neurodivergent-friendly metrics.

### ACTIVE DATABASE-BACKED CANDIDATE CONTEXT:
${job.candidateProfileContext}

### JOB DETAILS:
- Canonical Job ID: ${job.canonicalJobId}
- Job Version ID: ${job.jobVersionId}
- Job Title: ${job.normalizedTitle}
- Company: ${job.companyName}
- Careers Portal URL: ${job.canonicalUrl}
- Pre-routed Candidate Lane: ${job.candidateLane || "CORE_AI_DATA"}
- Workability Facts: ${JSON.stringify(job.workabilityFacts || {})}

### DESCRIPTION:
${job.descriptionText}

### MANDATED INSTRUCTIONS:
1. Classify into primary_lane (${promptLaneQuotedList()}, or null). ${ADVISORY_LANE_INSTRUCTION}
2. For every 0-100 score, return null when evidence is unavailable. Never use 0 to mean unknown or unavailable. Use integer scores for the other metrics. For building_research_ratio and interaction_load, return a finite number from 0 to 100 when evidence supports a measurement or null when unavailable; these two measurements need not be integers. A zero is valid only when the evidence supports an actual zero.
3. Use higher focus_protection_score for protected, uninterrupted work. building_research_ratio is the estimated percent of hands-on building/research; higher interaction_load means more interaction. Higher strategic_value_score, technical_depth_score, and role_ownership_score mean stronger value, technical depth, and end-to-end ownership. For ambiguity_burden, meeting_burden, travel_burden, and on_call_burden, 0 is low burden and 100 is high burden.
4. Set career_trajectory to ADVANCING, LATERAL, DETOUR, or UNKNOWN; use UNKNOWN when candidate-profile or role evidence is insufficient. Judge seniority and strategic value against the candidate's experience_by_track for the job's own track, not against the candidate's longest career: a mid-level role in a track where the candidate has under 4 years (for example hands-on AI/ML engineering) is a deliberate transition, not a step down; a mid-level role in a track where the candidate has 8 or more years is a step down. Roles that combine the candidate's senior experience with AI (AI architecture, AI product, forward-deployed or AI solutions engineering, AI governance) are preferred. When experience_by_track is empty, do not infer seniority mismatch from total career length alone. Keep evaluation_summary concise (one or two short sentences) and list evidence-based strengths, gaps, and risk_flags.
5. Return one culture_evidence entry for each signal: AUTONOMY, POLITICS_RISK, SENSORY_WORKLOAD_RISK, and FOCUS_PROTECTION. Each entry has signal, provisional score (0-100, null, or UNKNOWN), and quote. The quote must be an exact verbatim job-description quote; never paraphrase, cite candidate-profile text, or fabricate quotes. When the job description does not support a measurement, set score to null or UNKNOWN and quote to null. Local deterministic phrase rules replace all provisional culture scores; a numeric score requires a direct quote from the job description.
6. Include policy_conflicts only for explicit conflicts between a candidate constraint and a role requirement. Provide the exact constraint, requirement, and a supporting quote that is an exact verbatim substring of the job description; do not infer a conflict from missing information or fabricate quotes.
7. policy_conflicts are advisory only. Do not change next_action, hard gates, recommendation outcome, budget policy, queue eligibility, or persistence behavior because of these signals. Do not change next_action based on policy_conflicts.
8. Set next_action to one of: "PRIORITY_APPLY", "APPLY_AFTER_VERIFICATION", "LOW_STRATEGIC_VALUE", "REJECTED".
9. Echo canonical_job_id and job_version_id exactly as supplied above.
10. Output EXACTLY ONE JSON object conforming to this shape:
{
  "evaluation_summary": "One or two concise sentences",
  "evaluated_jobs": [
    {
      "canonical_job_id": "${job.canonicalJobId}",
      "job_version_id": "${job.jobVersionId}",
      "primary_lane": "${promptLaneUnion("null")}",
      "secondary_lanes": ["string"],
      "lane_confidence": "High | Medium | Low",
      "lane_evidence": "string",
      "nd_score": 78,
      "nd_friendly_score": 80,
      "politics_stress_score": 20,
      "sensory_overload_index": 25,
      "focus_protection_score": 85,
      "building_research_ratio": null,
      "interaction_load": null,
      "strategic_value_score": 82,
      "career_trajectory": "ADVANCING | LATERAL | DETOUR | UNKNOWN",
      "technical_depth_score": 90,
      "role_ownership_score": 80,
      "ambiguity_burden": 30,
      "meeting_burden": 25,
      "travel_burden": 10,
      "on_call_burden": null,
      "strengths": ["string"],
      "gaps": ["string"],
      "risk_flags": ["string"],
      "policy_conflicts": [
        {
          "policy": "RESIDENCY | WORK_AUTHORIZATION | ONSITE | TRAVEL | ON_CALL",
          "candidate_constraint": "Explicit candidate constraint",
          "role_requirement": "Explicit role requirement",
          "evidence": "Exact verbatim job-description quote"
        }
      ],
      "culture_evidence": [
        { "signal": "AUTONOMY", "score": null, "quote": null },
        { "signal": "POLITICS_RISK", "score": null, "quote": null },
        { "signal": "SENSORY_WORKLOAD_RISK", "score": null, "quote": null },
        { "signal": "FOCUS_PROTECTION", "score": null, "quote": null }
      ],
      "rejection_codes": ["string"],
      "strategic_value": "Present-day value of the role",
      "recommended_cv_version": "${promptLaneUnion("None")}",
      "next_action": "PRIORITY_APPLY | APPLY_AFTER_VERIFICATION | LOW_STRATEGIC_VALUE | REJECTED"
    }
  ]
}
`;

  const systemInstruction = `You are an AI decision engine evaluating a single canonical job. Return a single JSON object.`;

  const openaiEvalModelForRoute = evaluationOpenAiModel();
  trace.push("Attempting strict single-job evaluation through audited model routing...");
  const response = await generateContentAudited({
    purpose: "EVALUATION",
    routeKey: "single_job_evaluation",
    model: options.modelOverride?.trim() || openaiEvalModelForRoute,
    flex: true,
    ...(options.onlyProvider ? { onlyProvider: options.onlyProvider } : {}),
    contents: prompt,
    responseMimeType: "application/json",
    systemInstruction,
    validateResponseText: (text, validationContext) => {
      const validated = parseStrictSingleEvaluationPayload(text, job);
      buildEvaluationResultFromValidatedPayload(
        validated,
        job,
        pipelineRunId,
        attemptNum,
        {
          provider: validationContext.provider,
          model: validationContext.model,
          fallbackUsed: false,
        }
      );
      return validated;
    },
  });

  const validatedPayload =
    (response.validatedPayload as ValidatedSingleEvaluationPayload | undefined) ??
    parseStrictSingleEvaluationPayload(response.text, job);
  const validatedResult = buildEvaluationResultFromValidatedPayload(
    validatedPayload,
    job,
    pipelineRunId,
    attemptNum,
    response
  );

  trace.push(
    `Strict single-job evaluation completed via ${response.provider} (${response.model}); fallback_used=${response.fallbackUsed}.`
  );

  return {
    evaluatedJob: validatedResult,
    provider: response.provider,
    model: response.model,
    fallbackUsed: response.fallbackUsed,
    attempts: response.attempts,
    errors: response.errors.map((error) => `${error.provider}:${error.model}: ${error.error}`),
    degraded: response.fallbackUsed,
    trace,
    usage: response.usage ?? null,
    servedPath: response.servedPath,
  };

}


