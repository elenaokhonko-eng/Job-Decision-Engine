import { GoogleGenAI, Type, FunctionDeclaration } from "@google/genai";
import dotenv from "dotenv";
import crypto from "crypto";
import pg from "pg";
import { db, Job } from "../db/db.ts";
import { fetchGmailAlerts } from "./gmail.js";
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
  type GeminiCredentialScope,
} from "./geminiConfig.js";
import {
  backoffOptionsFromEnv,
  estimateTokens,
  fullJitterBackoffMs,
  getModelLimiter,
  interactiveCallDeadlineMs,
  isRateLimitedFailure,
  ModelCallDeadlineError,
  ModelRateLimitedError,
  pipelineCallDeadlineMs,
  rateLimitMaxAttempts,
  rateLimitRetryAfterMs,
  recordProviderCall,
  serverSuggestedDelayMs,
  type ModelFailureKind,
} from "./modelCallResilience.js";
import {
  MULTI_LANE_SCORECARDS,
  ND_FRIENDLY_DIMENSIONS,
  POLITICS_STRESS_RISK_DIMENSIONS
} from "./criteria.ts";

dotenv.config();
dotenv.config({ path: ".env.local" });

export const MODEL_REGISTRY = {
  EVALUATION_PRIMARY_MODEL: process.env.EVALUATION_PRIMARY_MODEL || process.env.GEMINI_MODEL || "gemini-3.6-flash",
  EVALUATION_FALLBACK_MODEL: process.env.EVALUATION_FALLBACK_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini",
  EMBEDDING_PRIMARY_MODEL: process.env.EMBEDDING_PRIMARY_MODEL || "gemini-embedding-001",
  EMBEDDING_FALLBACK_MODEL: process.env.EMBEDDING_FALLBACK_MODEL || "text-embedding-3-small",
  DOCUMENT_PRIMARY_MODEL: process.env.DOCUMENT_PRIMARY_MODEL || "gemini-3.8-flash",
  DOCUMENT_FALLBACK_MODEL: process.env.DOCUMENT_FALLBACK_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini",
  EXTRACTION_GEMINI_MODEL: process.env.REQUIREMENTS_GEMINI_MODEL || process.env.EXTRACTION_GEMINI_MODEL || "gemini-3.1-flash-lite",
  /** Interactive document calls switch to this Gemini model after a 429 or failure on the primary. */
  DOCUMENT_SECONDARY_GEMINI_MODEL: process.env.DOCUMENT_SECONDARY_GEMINI_MODEL || "gemini-3.1-flash-lite",
  EXTRACTION_OPENAI_MODEL: process.env.REQUIREMENTS_OPENAI_MODEL || process.env.EXTRACTION_OPENAI_MODEL || "gpt-5.6-luna",
} as const;

type TextProvider = "gemini" | "openai";

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

function modelRequestMaxRetries(): number {
  const parsed = Number.parseInt(String(process.env.MODEL_REQUEST_MAX_RETRIES || "3"), 10);
  if (!Number.isFinite(parsed)) return 3;
  return Math.max(1, Math.min(5, parsed));
}

function modelRequestTimeoutMs(): number {
  const parsed = Number.parseInt(String(process.env.MODEL_REQUEST_TIMEOUT_MS || "60000"), 10);
  if (!Number.isFinite(parsed)) return 60000;
  return Math.max(5000, Math.min(300000, parsed));
}

/** Per-call attempt limit: an explicit override (clamped like the env value) or the env default. */
function effectiveMaxRetries(override: unknown): number {
  if (typeof override === "number" && Number.isFinite(override)) {
    return Math.max(1, Math.min(5, Math.floor(override)));
  }
  return modelRequestMaxRetries();
}

/** Per-call request timeout: an explicit override (clamped like the env value) or the env default. */
function effectiveTimeoutMs(override: unknown): number {
  if (typeof override === "number" && Number.isFinite(override)) {
    return Math.max(5000, Math.min(300000, Math.floor(override)));
  }
  return modelRequestTimeoutMs();
}

export interface GeminiErrorClassification {
  dailyQuota: boolean;
  rateLimit: boolean;
  timeout: boolean;
  serverError: boolean;
  retryable: boolean;
}

const GEMINI_RETRYABLE_HTTP_STATUSES = new Set([500, 502, 503, 504]);

/**
 * A per-day quota metric named in a 429 body (AI Studio free tier and per-day request caps). The
 * word "quota" alone is not enough: every Gemini 429 says "check quota" or "Quota exceeded for
 * metric ...", including the per-minute limits that clear within seconds.
 */
const GEMINI_DAILY_QUOTA_PATTERN = /PerDay|per[_ ]day|_daily|daily[_ ]limit/i;

/**
 * Classifies an error thrown by `@google/genai` `models.generateContent`/`embedContent`.
 *
 * For a non-2xx response the SDK (v2.x) throws `ApiError` (name "ApiError") whose numeric
 * `status` is the HTTP status and whose `message` is the JSON error body, e.g. for a 504:
 * `{"error":{"code":504,"message":"Deadline expired before operation could complete.","status":"DEADLINE_EXCEEDED"}}`.
 *
 * - 429 / RESOURCE_EXHAUSTED is a rate limit, retried with jittered backoff (honouring RetryInfo).
 * - It is a daily quota only on the AI Studio backend and only when the body names a per-day
 *   quota metric; that will not clear within a backoff window, so it is never retried. Vertex AI
 *   has no daily request quota for pay-as-you-go traffic, so a Vertex 429 is never a daily quota.
 * - Server-side failures (5xx, DEADLINE_EXCEEDED, UNAVAILABLE, INTERNAL, "overloaded") and
 *   client-side timeouts are transient and retried.
 */
export function classifyGeminiError(error: any, backend: GeminiBackend = currentGeminiBackend()): GeminiErrorClassification {
  const message = String(error?.message ?? error ?? "");
  const status = Number(error?.status);
  const rateLimit = status === 429 || message.includes("RESOURCE_EXHAUSTED") || /"code"\s*:\s*429\b/.test(message);
  const dailyQuota = backend === "studio" && rateLimit && GEMINI_DAILY_QUOTA_PATTERN.test(message);
  const timeout =
    error?.name === "AbortError" ||
    error?.name === "TimeoutError" ||
    /timeout|timed out|aborted/i.test(message);
  const serverError =
    GEMINI_RETRYABLE_HTTP_STATUSES.has(status) ||
    message.includes("DEADLINE_EXCEEDED") ||
    message.includes("UNAVAILABLE") ||
    /\bINTERNAL\b/.test(message) ||
    /overloaded/i.test(message);
  return {
    dailyQuota,
    rateLimit: rateLimit && !dailyQuota,
    timeout: timeout && !rateLimit,
    serverError: serverError && !rateLimit,
    retryable: !dailyQuota && (rateLimit || timeout || serverError),
  };
}

function currentGeminiBackend(): GeminiBackend {
  try {
    return geminiBackend();
  } catch {
    return "studio";
  }
}

function geminiFailureKind(classification: GeminiErrorClassification): ModelFailureKind {
  if (classification.dailyQuota) return "DAILY_QUOTA";
  if (classification.rateLimit) return "RATE_LIMITED";
  if (classification.timeout) return "TIMEOUT";
  if (classification.serverError) return "SERVER_ERROR";
  return "OTHER";
}

interface ModelTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

interface ModelProviderAttemptTelemetry extends ModelTokenUsage {
  provider: TextProvider | "kimi";
  model: string;
  attempt: number;
  maxAttempts: number;
  status: "COMPLETED" | "FAILED";
  httpStatus?: number | null;
  retryable?: boolean;
  latencyMs: number;
  error?: string;
  /** RATE_LIMITED, TIMEOUT, ... for a failed attempt (no prompt text). */
  errorKind?: ModelFailureKind;
  /** Vertex billing path reported by the response (ON_DEMAND, ON_DEMAND_FLEX, ...), when present. */
  trafficType?: string;
}

function finiteUsageNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined;
}

function finiteMoneyNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function extractTokenUsage(value: any): ModelTokenUsage {
  const usage = value?.usage || value?.usageMetadata || value?.response_metadata?.token_usage || {};
  const promptTokens = finiteUsageNumber(
    usage.prompt_tokens ?? usage.promptTokenCount ?? usage.input_tokens ?? usage.inputTokenCount
  );
  const completionTokens = finiteUsageNumber(
    usage.completion_tokens ?? usage.candidatesTokenCount ?? usage.output_tokens ?? usage.outputTokenCount
  );
  const totalTokens = finiteUsageNumber(
    usage.total_tokens ?? usage.totalTokenCount ?? usage.total_tokens_count
  );
  return { promptTokens, completionTokens, totalTokens };
}

function recordProviderAttempt(options: any, attempt: ModelProviderAttemptTelemetry): void {
  if (Array.isArray(options?.__providerAttemptTelemetry)) {
    options.__providerAttemptTelemetry.push(attempt);
  }
}

function summarizeSuccessfulUsage(
  attempts: ModelProviderAttemptTelemetry[],
  provider: TextProvider,
  model: string
): Required<ModelTokenUsage> | null {
  const success = [...attempts]
    .reverse()
    .find((attempt) =>
      attempt.status === "COMPLETED" &&
      attempt.provider === provider &&
      attempt.model === model
    );
  if (!success) return null;
  const promptTokens = success.promptTokens ?? 0;
  const completionTokens = success.completionTokens ?? 0;
  const totalTokens = success.totalTokens ?? promptTokens + completionTokens;
  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) return null;
  return { promptTokens, completionTokens, totalTokens };
}

function configuredModelPricing(provider: string, model: string): { inputPer1M: number; outputPer1M: number } | null {
  const raw = process.env.MODEL_PRICING_JSON;
  if (!raw || raw.trim() === "") return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, any>;
    const keys = [
      `${provider}:${model}`,
      model,
      provider,
    ];
    for (const key of keys) {
      const pricing = parsed[key];
      const inputPer1M = finiteMoneyNumber(
        pricing?.input_per_1m ?? pricing?.inputPer1M ?? pricing?.prompt_per_1m ?? pricing?.promptPer1M
      );
      const outputPer1M = finiteMoneyNumber(
        pricing?.output_per_1m ?? pricing?.outputPer1M ?? pricing?.completion_per_1m ?? pricing?.completionPer1M
      );
      if (inputPer1M !== undefined && outputPer1M !== undefined) {
        return { inputPer1M, outputPer1M };
      }
    }
  } catch {
    return null;
  }
  return null;
}

function estimateCostUsd(
  provider: string,
  model: string,
  usage: Required<ModelTokenUsage> | null
): number | null {
  if (!usage) return null;
  const pricing = configuredModelPricing(provider, model);
  if (!pricing) return null;
  const cost =
    (usage.promptTokens / 1_000_000) * pricing.inputPer1M +
    (usage.completionTokens / 1_000_000) * pricing.outputPer1M;
  return Number(cost.toFixed(6));
}

function embeddingRequestTimeoutMs(): number {
  const parsed = Number.parseInt(
    String(process.env.EMBEDDING_REQUEST_TIMEOUT_MS || process.env.MODEL_REQUEST_TIMEOUT_MS || "30000"),
    10
  );
  if (!Number.isFinite(parsed)) return 30000;
  return Math.max(5000, Math.min(120000, parsed));
}

function isRetryableModelRequestError(error: any): boolean {
  const status = Number(error?.status);
  if (Number.isFinite(status)) {
    return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  }

  const message = String(error?.message || error || "").toLowerCase();
  return (
    error?.name === "AbortError" ||
    error?.name === "TimeoutError" ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("fetch failed") ||
    message.includes("network")
  );
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

// Lazily initialised Gemini SDK clients, one per backend configuration. A missing or incomplete
// configuration throws ("loud fail") instead of silently skipping the provider.
const geminiClients = new Map<string, GoogleGenAI>();

/**
 * The Gemini client for this environment.
 * - GEMINI_BACKEND=studio (default): AI Studio API key (GEMINI_API_KEY / GEMINI_FLASH_API_KEY, or
 *   DOCUMENT_GEMINI_API_KEY for scope "document"), unchanged behaviour.
 * - GEMINI_BACKEND=vertex: Vertex AI with Application Default Credentials (a service-account file
 *   in GOOGLE_APPLICATION_CREDENTIALS locally, Workload Identity Federation in Actions), the
 *   configured project and location (default "global"). No AI Studio headers or apiVersion.
 */
export function getGeminiClient(options: { scope?: GeminiCredentialScope } = {}): GoogleGenAI {
  const config = resolveGeminiClientConfig(process.env, options.scope ?? "default");
  const cacheKey = config.backend === "vertex"
    ? `vertex\u0000${config.project}\u0000${config.location}`
    : `studio\u0000${sha256Hex(config.apiKey)}\u0000${config.apiVersion ?? ""}`;
  let client = geminiClients.get(cacheKey);
  if (!client) {
    client = config.backend === "vertex"
      ? new GoogleGenAI({
          vertexai: true,
          project: config.project,
          location: config.location,
          httpOptions: { timeout: 45000 },
        })
      : new GoogleGenAI({
          apiKey: config.apiKey,
          apiVersion: config.apiVersion,
          httpOptions: {
            headers: {
              "User-Agent": "aistudio-build",
            },
            timeout: 45000,
          },
        });
    geminiClients.set(cacheKey, client);
  }
  return client;
}

/** Tests only: drop cached clients so a changed backend configuration builds a new one. */
export function resetGeminiClientsForTests(): void {
  geminiClients.clear();
}

/**
 * Vertex Flex PayGo headers for pipeline calls when GEMINI_PIPELINE_FLEX=true and the backend is
 * Vertex (global endpoint only). Flex-only mode: "shared" request type plus "flex" shared request
 * type. Never applied to interactive document calls: Flex trades latency for price.
 */
function geminiFlexHeaders(options: any): Record<string, string> | undefined {
  if (options?.interactive === true || options?.flex !== true) return undefined;
  if (process.env.GEMINI_PIPELINE_FLEX !== "true") return undefined;
  if (currentGeminiBackend() !== "vertex") return undefined;
  return {
    "X-Vertex-AI-LLM-Request-Type": "shared",
    "X-Vertex-AI-LLM-Shared-Request-Type": "flex",
  };
}

// Defining our tools as FunctionDeclarations
const queryDatabaseForJobsTool: FunctionDeclaration = {
  name: "queryDatabaseForJobs",
  description: "Search or fetch job advertisements from the local Postgres simulation database.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      searchTerm: {
        type: Type.STRING,
        description: "Optional search query to filter jobs by title, company, or description keywords.",
      },
    },
  },
};
// Tool implementations
async function executeQueryDatabaseForJobs(args: { searchTerm?: string }): Promise<Job[]> {
  return await db.queryJobs(args.searchTerm);
}



export interface AgentResult {
  evaluation_summary?: string;
  evaluated_jobs: Array<{
    job_id?: string;
    job_title: string;
    company: string;
    careers_portal_url: string;
    primary_lane: string | null;
    secondary_lanes: string[];
    lane_confidence: "High" | "Medium" | "Low";
    lane_evidence: string;
    nd_gate_status: string;
    nd_score: number;
    nd_evidence: string;
    nd_risk_flags: string[];
    work_mode_status: string;
    office_days: number;
    interaction_load: number | null;
    building_research_ratio: number | null;
    rejection_codes: string[];
    nd_friendly_score: number;
    politics_stress_score: number;
    sensory_overload_index: number;
    biological_and_stress_risk_assessment: string;
    strategic_value: string;
    recommended_cv_version: string;
    next_action: string;
  }>;
}

// NEW: Unified agent execution result with fallback tracking
export interface AgentWithFallbackResult<T> {
  payload: T;
  provider: 'gemini' | 'openai';
  model: string;
  fallbackUsed: boolean;
  attempts: number;
  errors: Array<{ provider: string; model: string; error: string }>;
  degraded: boolean;
}

/**
 * Execute an agent prompt with fallback from Gemini to OpenAI.
 * Persists accurate provider audit trail for model selection verification.
 */
export async function runAgentWithFallback<T>(
  prompt: string,
  schema: any,
  systemInstruction?: string
): Promise<AgentWithFallbackResult<T>> {
  const errors: Array<{ provider: string; model: string; error: string }> = [];
  let attempts = 0;

  const order = resolveProviderOrder(process.env.EVALUATION_PRIMARY_PROVIDER);
  const openaiEvalModel = process.env.OPENAI_MODEL || MODEL_REGISTRY.EVALUATION_FALLBACK_MODEL;
  const geminiEvalModel = MODEL_REGISTRY.EVALUATION_PRIMARY_MODEL;
  const PRIMARY_MODEL = order[0] === "openai"
    ? openaiEvalModel
    : geminiEvalModel;
  const FALLBACK_MODEL = order[0] === "openai"
    ? geminiEvalModel
    : openaiEvalModel;

  // 1. Attempt Primary
  const geminiApiKey = isGeminiConfigured();
  const openaiApiKey = process.env.OPENAI_API_KEY;
  if (order[0] === "gemini" && geminiApiKey) {
    try {
      attempts++;
      const text = await tryGemini({
        model: PRIMARY_MODEL,
        contents: prompt,
        responseMimeType: 'application/json',
        responseSchema: schema,
        systemInstruction
      });

      const parsed = JSON.parse(text || '{}') as T;
      return {
        payload: parsed,
        provider: 'gemini',
        model: PRIMARY_MODEL,
        fallbackUsed: false,
        attempts,
        errors: [],
        degraded: false
      };
    } catch (err: any) {
      const error = publicErrorSummary(err, "gemini");
      console.warn(`[Gemini Error] Primary model failed: ${error}. Triggering fallback...`);
      errors.push({ provider: 'gemini', model: PRIMARY_MODEL, error });
    }
  } else if (order[0] === "openai" && openaiApiKey) {
    try {
      attempts++;
      const text = await tryOpenAI(openaiApiKey, {
        model: PRIMARY_MODEL,
        contents: prompt,
        responseMimeType: 'application/json',
        responseSchema: schema,
        systemInstruction
      });

      const parsed = JSON.parse(text || '{}') as T;
      return {
        payload: parsed,
        provider: 'openai',
        model: PRIMARY_MODEL,
        fallbackUsed: false,
        attempts,
        errors: [],
        degraded: false
      };
    } catch (err: any) {
      const error = publicErrorSummary(err, "openai");
      console.warn(`[OpenAI Error] Primary model failed: ${error}. Triggering fallback...`);
      errors.push({ provider: 'openai', model: PRIMARY_MODEL, error });
    }
  } else if (order[0] === "gemini") {
    errors.push({ provider: 'gemini', model: PRIMARY_MODEL, error: geminiConfigProblem() ?? 'Gemini not configured' });
  } else {
    errors.push({ provider: 'openai', model: PRIMARY_MODEL, error: 'OPENAI_API_KEY not configured' });
  }

  // 2. Attempt Fallback
  if (order[0] === "gemini" && openaiApiKey) {
    try {
      attempts++;
      const text = await tryOpenAI(openaiApiKey, {
        model: FALLBACK_MODEL,
        contents: prompt,
        responseMimeType: 'application/json',
        responseSchema: schema,
        systemInstruction
      });

      const parsed = JSON.parse(text || '{}') as T;
      return {
        payload: parsed,
        provider: 'openai',
        model: FALLBACK_MODEL,
        fallbackUsed: true,
        attempts,
        errors,
        degraded: true
      };
    } catch (err: any) {
      const error = publicErrorSummary(err, "openai");
      console.error(`[OpenAI Error] Fallback model failed: ${error}`);
      errors.push({ provider: 'openai', model: FALLBACK_MODEL, error });
    }
  } else if (order[0] === "openai" && geminiApiKey) {
    try {
      attempts++;
      const text = await tryGemini({
        model: FALLBACK_MODEL,
        contents: prompt,
        responseMimeType: 'application/json',
        responseSchema: schema,
        systemInstruction
      });

      const parsed = JSON.parse(text || '{}') as T;
      return {
        payload: parsed,
        provider: 'gemini',
        model: FALLBACK_MODEL,
        fallbackUsed: true,
        attempts,
        errors,
        degraded: true
      };
    } catch (err: any) {
      const error = publicErrorSummary(err, "gemini");
      console.error(`[Gemini Error] Fallback model failed: ${error}`);
      errors.push({ provider: 'gemini', model: FALLBACK_MODEL, error });
    }
  } else if (order[0] === "gemini") {
    errors.push({ provider: 'openai', model: FALLBACK_MODEL, error: 'OPENAI_API_KEY not configured' });
  } else {
    errors.push({ provider: 'gemini', model: FALLBACK_MODEL, error: geminiConfigProblem() ?? 'Gemini not configured' });
  }

  throw new Error(`All model providers failed: ${JSON.stringify(errors)}`);
}

/**
 * The response schema as sent to Gemini. Gemini rejects schemas whose constraint state is too
 * large with 400 INVALID_ARGUMENT; an array cap such as maxItems: 25 over items with enum fields is
 * enough to trigger it. Array caps are therefore left out of the request; callers still enforce
 * them when they validate the response locally.
 */
export function geminiResponseSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(geminiResponseSchema);
  if (!schema || typeof schema !== "object") return schema;
  return Object.fromEntries(
    Object.entries(schema as Record<string, unknown>)
      .filter(([key]) => key !== "maxItems")
      .map(([key, value]) => {
        if (key === "enum") return [key, value];
        // Keys under "properties" are field names, so only their schemas are rewritten.
        if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
          return [key, Object.fromEntries(Object.entries(value).map(([name, child]) => [name, geminiResponseSchema(child)]))];
        }
        return [key, geminiResponseSchema(value)];
      })
  );
}

// OpenAI strict structured outputs reject string length bounds; callers still enforce them when
// they validate the response locally. Array bounds, number ranges, pattern and enum are supported.
const OPENAI_STRICT_UNSUPPORTED_KEYWORDS = new Set(["minLength", "maxLength"]);

function nullableSchema(schema: unknown): unknown {
  const record = schema && typeof schema === "object" && !Array.isArray(schema) ? schema as Record<string, unknown> : null;
  if (record && Array.isArray(record.anyOf)) {
    const hasNull = record.anyOf.some((option) => (option as Record<string, unknown> | null)?.type === "null");
    return hasNull ? record : { ...record, anyOf: [...record.anyOf, { type: "null" }] };
  }
  return { anyOf: [schema, { type: "null" }] };
}

/**
 * The response schema as sent to OpenAI with strict: true. Strict mode requires every object to
 * list all of its properties in `required` and to forbid additional properties, so a property the
 * caller left optional is sent as required-but-nullable, and unsupported keywords are dropped.
 */
export function openAiStrictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(openAiStrictSchema);
  if (!schema || typeof schema !== "object") return schema;
  const source = schema as Record<string, unknown>;
  const converted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (OPENAI_STRICT_UNSUPPORTED_KEYWORDS.has(key) || key === "required" || key === "properties" || key === "additionalProperties") continue;
    converted[key] = key === "enum" ? value : openAiStrictSchema(value);
  }
  const properties = source.properties && typeof source.properties === "object" && !Array.isArray(source.properties)
    ? source.properties as Record<string, unknown>
    : null;
  if (properties || source.type === "object") {
    const required = new Set(Array.isArray(source.required) ? source.required as string[] : []);
    // Keys under "properties" are field names, so only their schemas are rewritten.
    converted.properties = Object.fromEntries(Object.entries(properties ?? {}).map(([name, child]) => {
      const strictChild = openAiStrictSchema(child);
      return [name, required.has(name) ? strictChild : nullableSchema(strictChild)];
    }));
    converted.required = Object.keys(properties ?? {});
    converted.additionalProperties = false;
  }
  return converted;
}

/** The absolute deadline for one model call: options.deadlineAt, else interactive/pipeline default. */
function callDeadlineAt(options: any, startedAt = Date.now()): number {
  if (typeof options?.deadlineAt === "number" && Number.isFinite(options.deadlineAt)) return options.deadlineAt;
  if (typeof options?.deadlineMs === "number" && Number.isFinite(options.deadlineMs) && options.deadlineMs > 0) {
    return startedAt + options.deadlineMs;
  }
  return startedAt + (options?.interactive === true ? interactiveCallDeadlineMs() : pipelineCallDeadlineMs());
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One Gemini model, with bounded retries inside a per-call deadline:
 * - 429 / RESOURCE_EXHAUSTED: up to GEMINI_RATE_LIMIT_MAX_ATTEMPTS (5) attempts with truncated
 *   exponential backoff and full jitter (1 s base, x2, 32 s cap), or the server's RetryInfo /
 *   Retry-After delay when present. With `switchModelOnRateLimit` (interactive calls that have a
 *   secondary model) the first 429 ends this model at once. Exhausted 429s throw
 *   ModelRateLimitedError.
 * - Timeouts and 5xx: up to `maxRetries` attempts with the same jittered backoff.
 * - A per-day quota (AI Studio only) is thrown immediately.
 * - No attempt or wait runs past the deadline: ModelCallDeadlineError is thrown instead.
 * Every request first takes a slot from the process-wide per-model limiter.
 */
async function tryGemini(options: any): Promise<string> {
  const scope: GeminiCredentialScope = options.geminiCredentialScope === "document" ? "document" : "default";
  const ai = getGeminiClient({ scope });
  const backend = currentGeminiBackend();
  const maxRetries = effectiveMaxRetries(options.maxRetries);
  const maxRateLimitAttempts = rateLimitMaxAttempts();
  const timeoutMs = effectiveTimeoutMs(options.timeoutMs);
  const model = options.model || MODEL_REGISTRY.EVALUATION_PRIMARY_MODEL;
  const deadlineAt = callDeadlineAt(options);
  const deadlineMs = Math.max(0, deadlineAt - Date.now());
  const limiter = getModelLimiter(model);
  const estimatedTokens = estimateTokens(options.contents, options.systemInstruction) +
    (options.maxOutputTokens ?? MODEL_MAX_OUTPUT_TOKENS);
  const flexHeaders = geminiFlexHeaders(options);
  // Telemetry keeps maxAttempts as the non-429 attempt limit; 429 attempts are marked by errorKind.
  const maxAttempts = maxRetries;
  let otherFailures = 0;
  let rateLimitFailures = 0;
  let lastWasRateLimit = false;

  for (let attempt = 1; ; attempt++) {
    if (Date.now() >= deadlineAt) {
      throw new ModelCallDeadlineError(
        `Gemini ${model} call deadline of ${Math.round(deadlineMs / 1000)}s passed after ${attempt - 1} attempt(s).`,
        { model, deadlineMs, rateLimited: lastWasRateLimit, retryAfterMs: null },
      );
    }
    const permit = await limiter.acquire(estimatedTokens, deadlineAt);
    const callTimeoutMs = Math.max(1, Math.min(timeoutMs, deadlineAt - Date.now()));
    const startedAt = Date.now();
    try {
      console.log(
        `[model:gemini] backend=${backend} model=${model} attempt=${attempt} starting timeout=${Math.round(callTimeoutMs / 1000)}s`
      );
      const response = await ai.models.generateContent({
        model,
        contents: options.contents,
        config: {
          abortSignal: AbortSignal.timeout(callTimeoutMs),
          httpOptions: { timeout: callTimeoutMs, ...(flexHeaders ? { headers: flexHeaders } : {}) },
          responseMimeType: options.responseMimeType as any,
          responseSchema: options.responseSchema ? geminiResponseSchema(options.responseSchema) as any : undefined,
          maxOutputTokens: options.maxOutputTokens ?? MODEL_MAX_OUTPUT_TOKENS,
          systemInstruction: options.systemInstruction
        }
      });
      const usage = extractTokenUsage(response);
      permit.release(usage.totalTokens ?? null);
      console.log(
        `[model:gemini] model=${model} attempt=${attempt} completed elapsed_ms=${Date.now() - startedAt}`
      );
      recordProviderCall({ provider: "gemini", model, outcome: "OK", retry: attempt > 1 });
      recordProviderAttempt(options, {
        provider: "gemini",
        model,
        attempt,
        maxAttempts,
        status: "COMPLETED",
        latencyMs: Date.now() - startedAt,
        ...usage,
        ...(response.usageMetadata?.trafficType ? { trafficType: String(response.usageMetadata.trafficType) } : {}),
      });
      return response.text || "";
    } catch (gErr: any) {
      permit.release();
      const classification = classifyGeminiError(gErr, backend);
      const kind = geminiFailureKind(classification);
      lastWasRateLimit = classification.rateLimit;
      if (classification.rateLimit) rateLimitFailures += 1;
      else if (classification.retryable) otherFailures += 1;
      const exhausted = classification.rateLimit
        ? rateLimitFailures >= maxRateLimitAttempts || options.switchModelOnRateLimit === true
        : otherFailures >= maxRetries;
      const willRetry = classification.retryable && !exhausted;
      recordProviderCall({ provider: "gemini", model, outcome: kind, retry: attempt > 1 });
      recordProviderAttempt(options, {
        provider: "gemini",
        model,
        attempt,
        maxAttempts,
        status: "FAILED",
        httpStatus: finiteUsageNumber(gErr.status) ?? null,
        retryable: willRetry,
        latencyMs: Date.now() - startedAt,
        error: publicErrorSummary(gErr, "gemini"),
        errorKind: kind,
      });

      const suggestedMs = serverSuggestedDelayMs(gErr);
      if (classification.rateLimit && !willRetry) {
        const reason = options.switchModelOnRateLimit === true ? "switching model after the first 429" : `${rateLimitFailures} rate-limited attempt(s)`;
        console.warn(`[model:gemini] model=${model} rate limited (429); ${reason}.`);
        throw new ModelRateLimitedError(
          `Gemini ${model} rate limited (429 RESOURCE_EXHAUSTED) after ${rateLimitFailures} attempt(s): ${publicErrorSummary(gErr, "gemini")}`,
          { provider: "gemini", model, retryAfterMs: suggestedMs, attempts: attempt },
        );
      }
      if (!willRetry) throw gErr; // Daily quota, non-retryable, or retries exhausted: next model/provider.

      const failureNumber = classification.rateLimit ? rateLimitFailures : otherFailures;
      const backoffMs = suggestedMs ?? fullJitterBackoffMs(failureNumber, backoffOptionsFromEnv());
      const remainingMs = deadlineAt - Date.now();
      if (backoffMs >= remainingMs) {
        console.warn(
          `[model:gemini] model=${model} ${kind} and the ${Math.round(backoffMs / 1000)}s wait would pass the call deadline; stopping.`
        );
        throw new ModelCallDeadlineError(
          `Gemini ${model} ${kind === "RATE_LIMITED" ? "rate limited" : "failed"} and the retry wait would pass the ${Math.round(deadlineMs / 1000)}s call deadline: ${publicErrorSummary(gErr, "gemini")}`,
          { model, deadlineMs, rateLimited: classification.rateLimit, retryAfterMs: backoffMs },
        );
      }
      console.warn(
        `[model:gemini] model=${model} ${kind} attempt=${attempt}; retrying in ${Math.round(backoffMs)}ms${suggestedMs !== null ? " (server-suggested)" : ""}.`
      );
      await sleepMs(backoffMs);
    }
  }
}

async function tryOpenAICompatible(apiKey: string, baseUrl: string, model: string, options: any, isKimi: boolean = false): Promise<string> {
  const messages: any[] = [];
  if (options.systemInstruction) {
    messages.push({ role: "system", content: options.systemInstruction });
  }
  messages.push({ role: "user", content: options.contents });

  const maxRetries = effectiveMaxRetries(options.maxRetries);
  const timeoutMs = effectiveTimeoutMs(options.timeoutMs);
  const providerLabel = isKimi ? "kimi" : "openai";
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const startedAt = Date.now();
    try {
      console.log(
        `[model:${providerLabel}] model=${model} attempt=${attempt}/${maxRetries} starting timeout=${Math.round(timeoutMs / 1000)}s`
      );
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
          "User-Agent": "Claude-Code"
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 1,
          max_completion_tokens: options.maxOutputTokens ?? MODEL_MAX_OUTPUT_TOKENS,
          response_format: options.responseSchema && !isKimi
            ? { type: "json_schema", json_schema: { name: "extraction", strict: true, schema: openAiStrictSchema(options.responseSchema) } }
            : (options.responseMimeType === "application/json" ? { type: "json_object" } : undefined)
        }),
        signal: AbortSignal.timeout(timeoutMs)
      });

      if (!response.ok) {
        const errorText = await readResponseTextBounded(response, 64 * 1024, "Model API error response");
        const err: any = new Error(`API request failed with status ${response.status}: ${errorText}`);
        err.status = response.status;
        
        // Extract Retry-After header if present
        const retryAfterStr = response.headers.get("Retry-After");
        if (retryAfterStr) {
           const parsed = parseInt(retryAfterStr, 10);
           if (!isNaN(parsed)) err.retryAfterSecs = parsed;
        }
        
        throw err;
      }

      const responsePayload = await readJsonResponseBounded(
        response,
        MAX_MODEL_PROVIDER_RESPONSE_BYTES,
        "Model API response",
      );
      if (!responsePayload || typeof responsePayload !== "object" || Array.isArray(responsePayload)) {
        throw new Error("Model API response must be a JSON object.");
      }
      // The provider response shape is narrowed at this external API boundary.
      const data = responsePayload as {
        choices?: Array<{ message?: { content?: string | null } }>;
      };
      const usage = extractTokenUsage(data);
      console.log(
        `[model:${providerLabel}] model=${model} attempt=${attempt}/${maxRetries} completed elapsed_ms=${Date.now() - startedAt}`
      );
      recordProviderAttempt(options, {
        provider: providerLabel,
        model,
        attempt,
        maxAttempts: maxRetries,
        status: "COMPLETED",
        httpStatus: response.status,
        latencyMs: Date.now() - startedAt,
        ...usage,
      });
      return data.choices?.[0]?.message?.content || "";
    } catch (err: any) {
      const retryable = isRetryableModelRequestError(err);
      recordProviderAttempt(options, {
        provider: providerLabel,
        model,
        attempt,
        maxAttempts: maxRetries,
        status: "FAILED",
        httpStatus: finiteUsageNumber(err.status) ?? null,
        retryable: retryable && attempt < maxRetries,
        latencyMs: Date.now() - startedAt,
        error: publicErrorSummary(err, providerLabel),
      });
      if (attempt === maxRetries || !retryable) throw err;
      
      // Exponential backoff: 5s, 15s or explicitly requested Retry-After
      const baseBackoff = Math.pow(3, attempt - 1) * 5000;
      const backoffMs = err.retryAfterSecs ? err.retryAfterSecs * 1000 : baseBackoff;
      
      console.warn(`⏳ ${publicErrorSummary(err, providerLabel)}. Attempt ${attempt}/${maxRetries}. Retrying in ${backoffMs/1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  return "";
}

async function tryOpenAI(openaiKey: string, options: any): Promise<string> {
  const baseUrl = "https://api.openai.com/v1";
  const requestedModel = typeof options.model === "string" ? options.model : "";
  const model = requestedModel && !requestedModel.toLowerCase().startsWith("gemini")
    ? requestedModel
    : (process.env.OPENAI_MODEL || MODEL_REGISTRY.EVALUATION_FALLBACK_MODEL);
  return tryOpenAICompatible(openaiKey, baseUrl, model, options, false);
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
    case "gemini": {
      const result = await runAgent(prompt, {
        candidateProfileContext: typeof extra?.candidateProfileContext === "string"
          ? extra.candidateProfileContext
          : "",
      });
      // Return the result object as a JSON string for consistency
      return JSON.stringify(result.result);
    }
    case "openai": {
      const openaiKey = process.env.OPENAI_API_KEY || "";
      return await tryOpenAI(openaiKey, {
        contents: prompt,
        model: MODEL_REGISTRY.DOCUMENT_FALLBACK_MODEL,
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
    options.model === MODEL_REGISTRY.DOCUMENT_FALLBACK_MODEL;
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
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
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
    model === MODEL_REGISTRY.DOCUMENT_FALLBACK_MODEL
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
      openaiModel: MODEL_REGISTRY.DOCUMENT_FALLBACK_MODEL,
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
    openaiModel: process.env.OPENAI_MODEL || MODEL_REGISTRY.EVALUATION_FALLBACK_MODEL,
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
  /** Pipeline extraction/evaluation only: request Vertex Flex PayGo when GEMINI_PIPELINE_FLEX=true. */
  flex?: boolean;
}): Promise<GenerateContentAuditedResult> {
  const startedAt = Date.now();
  const geminiScope: GeminiCredentialScope = options.geminiCredentialScope === "document" ? "document" : "default";
  const geminiProblem = geminiConfigProblem(process.env, geminiScope);
  const openaiKey = process.env.OPENAI_API_KEY;
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

  const attemptedErrors: Array<{
    provider: string;
    model: string;
    error: string;
    publicError?: string;
    /** Why this provider/model failed; drives the rate-limit outcome of the whole call. */
    kind?: "RATE_LIMITED" | "DEADLINE" | "NOT_CONFIGURED" | "CORRECTED" | "OTHER";
    retryAfterMs?: number | null;
  }> = [];
  const failureKindOf = (err: unknown): "RATE_LIMITED" | "DEADLINE" | "OTHER" =>
    isRateLimitedFailure(err) ? "RATE_LIMITED" : err instanceof ModelCallDeadlineError ? "DEADLINE" : "OTHER";
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
  };
  const secondaryGeminiModel = String(options.secondaryGeminiModel || "").trim();
  if (secondaryGeminiModel) {
    requestMetadata.secondary_gemini_model = secondaryGeminiModel;
  }

  let successText: string | null = null;
  let successValidatedPayload: unknown = undefined;
  let successProvider: "gemini" | "openai" = "gemini";
  let successModel = options.model;
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
        if (round >= correctionRounds) throw err;
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
        if (Date.now() >= deadlineAt) {
          attemptedErrors.push({ provider, model: geminiModel, error: "Call deadline passed before this model was tried.",
            publicError: "Call deadline passed before this model was tried.", kind: "DEADLINE" });
          continue;
        }
        try {
          const { text, validatedPayload } = await callAndValidate(provider, geminiModel, (contents) => tryGemini({
            ...options,
            contents,
            model: geminiModel,
            deadlineAt,
            geminiCredentialScope: geminiScope,
            // Interactive calls move to the secondary model on the first 429 instead of waiting.
            switchModelOnRateLimit: options.interactive === true && geminiIndex < geminiModels.length - 1,
            __providerAttemptTelemetry: providerAttemptTelemetry,
          }));
          successText = text;
          successValidatedPayload = validatedPayload;
          successProvider = "gemini";
          successModel = geminiModel;
          break;
        } catch (err: any) {
          const message = err?.message || String(err);
          const safeMessage = publicErrorSummary(err, "gemini");
          console.warn(`Gemini model request failed: ${safeMessage}.`);
          attemptedErrors.push({
            provider,
            model: geminiModel,
            error: message,
            publicError: safeMessage,
            kind: failureKindOf(err),
            retryAfterMs: rateLimitRetryAfterMs(err),
          });
        }
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
        const openAiRateLimited = Number(err?.status) === 429;
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
  const safeAttemptedErrors = attemptedErrors.map(({ provider, model, error, publicError, kind }) => ({
    provider,
    model,
    error: publicError ?? publicErrorSummary(error, provider),
    ...(kind ? { kind } : {}),
  }));
  // The whole call failed only for capacity reasons when at least one model was rate limited and
  // every other model was rate limited, ran out of call deadline, or was not configured. Such a
  // failure is an operational one: callers reschedule it and never count it as a job failure.
  const rateLimitedOutcome =
    successText === null &&
    attemptedErrors.some((entry) => entry.kind === "RATE_LIMITED") &&
    attemptedErrors.every((entry) =>
      entry.kind === "RATE_LIMITED" || entry.kind === "DEADLINE" || entry.kind === "NOT_CONFIGURED" || entry.kind === "CORRECTED");

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
          requestHash,
          requestMetadata,
          responseMetadata: {
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
    throw new Error(errorMessage);
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
        requestHash,
        requestMetadata,
        responseMetadata: {
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
    process.env.OPENAI_MODEL || MODEL_REGISTRY.EVALUATION_FALLBACK_MODEL,
    process.env.EVALUATION_PRIMARY_PROVIDER
  );
  const document = await checkTextRoute(
    "document",
    "DOCUMENT",
    MODEL_REGISTRY.DOCUMENT_PRIMARY_MODEL,
    process.env.OPENAI_MODEL || MODEL_REGISTRY.DOCUMENT_FALLBACK_MODEL,
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

// Core execution loop
/**
 * Parse agent JSON output. THROWS on failure — callers must catch and route
 * to RETRY_WAIT so provider failover (Gemini → OpenAI) can occur on the next
 * attempt. Never return a synthetic empty result that silently halts failover.
 */
function parseResultJson(rawText: string, trace: string[]): AgentResult {
  let cleaned = rawText.trim();
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.replace(/^```json\s*/, "").replace(/\s*```$/, "");
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```\s*/, "").replace(/\s*```$/, "");
  }
  const startIdx = cleaned.indexOf("{");
  const endIdx = cleaned.lastIndexOf("}");
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    cleaned = cleaned.substring(startIdx, endIdx + 1);
  }
  // Throws SyntaxError on bad JSON — evaluate_queue.ts catches → RETRY_WAIT
  const parsed: AgentResult = JSON.parse(cleaned);
  trace.push(`Step ${trace.length + 1}: Agent JSON output parsed successfully.`);
  return parsed;
}

async function runGeminiAgentInternal(
  userQuestion: string,
  systemInstruction: string,
  trace: string[],
  toolsUsed: string[]
): Promise<AgentResult> {
  trace.push(`Step ${trace.length + 1}: Initiated agent connection to Gemini using customizable weights criteria.`);
  
  const ai = getGeminiClient();
  let response: any;
  try {
    response = await ai.models.generateContent({
      model: MODEL_REGISTRY.EVALUATION_PRIMARY_MODEL,
      contents: userQuestion,
      config: {
        systemInstruction,
        tools: [{ functionDeclarations: [queryDatabaseForJobsTool] }],
      },
    });
  } catch (gErr: any) {
    if (gErr.message?.includes("RESOURCE_EXHAUSTED") || gErr.status === 429) {
      console.warn("⏳ Gemini rate limit reached. Waiting 60s before retrying...");
      await new Promise((resolve) => setTimeout(resolve, 60000));
      response = await ai.models.generateContent({
        model: MODEL_REGISTRY.EVALUATION_PRIMARY_MODEL,
        contents: userQuestion,
        config: {
          systemInstruction,
          tools: [{ functionDeclarations: [queryDatabaseForJobsTool] }],
        },
      });
    } else {
      throw gErr;
    }
  }

  let functionCalls = response.functionCalls;
  let conversationHistory: any[] = [
    { role: "user", parts: [{ text: userQuestion }] },
    { role: "model", parts: response.candidates?.[0]?.content?.parts || [] }
  ];

  let loopCount = 0;
  while (functionCalls && functionCalls.length > 0 && loopCount < 5) {
    loopCount++;
    const functionResponsesParts: any[] = [];

    for (const call of functionCalls) {
      trace.push(`Step ${trace.length + 1}: Agent triggered tool call: "${call.name}" with arguments: ${JSON.stringify(call.args)}`);
      toolsUsed.push(call.name || "");

      let resultData: any;
      if (call.name === "queryDatabaseForJobs") {
        const args = (call.args as any) || {};
        resultData = await executeQueryDatabaseForJobs(args);
        trace.push(`Step ${trace.length + 1}: Query database returned ${resultData.length} records.`);
      } else {
        resultData = { error: "Unknown tool name" };
      }

      functionResponsesParts.push({
        functionResponse: {
          name: call.name,
          response: { result: resultData }
        }
      });
    }

    conversationHistory.push({
      role: "user",
      parts: functionResponsesParts
    });

    trace.push(`Step ${trace.length + 1}: Sending tool results back to Gemini for final assessment and ranking.`);
    
    response = await ai.models.generateContent({
      model: MODEL_REGISTRY.EVALUATION_PRIMARY_MODEL,
      contents: conversationHistory,
      config: {
        systemInstruction,
        tools: [{ functionDeclarations: [queryDatabaseForJobsTool] }],
      },
    });

    functionCalls = response.functionCalls;
    if (response.candidates?.[0]?.content?.parts) {
      conversationHistory.push({
        role: "model",
        parts: response.candidates[0].content.parts
      });
    }
  }

  trace.push(`Step ${trace.length + 1}: Enforcing strict JSON formatting with builder culture metrics.`);
  const formattingPrompt = "Now, please compile all findings, evaluate each job description, and output ONLY a valid, parseable JSON object matching the requested schema. Make sure you score the workplace cultural factors (nd_friendly_score, politics_stress_score, sensory_overload_index) and ensure every job has a direct careers_portal_url link. Return nothing other than the JSON block.";
  conversationHistory.push({ role: "user", parts: [{ text: formattingPrompt }] });

  const finalResponse = await ai.models.generateContent({
    model: MODEL_REGISTRY.EVALUATION_PRIMARY_MODEL,
    contents: conversationHistory,
    config: {
      systemInstruction,
      responseMimeType: "application/json",
    }
  });

  const rawText = finalResponse.text || "{}";
  return parseResultJson(rawText, trace);
}

export interface AgentExecutionResult {
  result: AgentResult;
  provider: "gemini" | "openai" | "ollama";
  model: string;
  fallbackUsed: boolean;
  attempts: number;
  errors: string[];
  degraded: boolean;
  trace: string[];
  toolsUsed: string[];
}

export interface LegacyAgentContext {
  /** Serialized, immutable candidate context loaded from the active database profile. */
  candidateProfileContext: string;
}

// Core execution loop
export async function runAgent(
  userQuestion: string,
  options: LegacyAgentContext
): Promise<AgentExecutionResult> {
  const geminiKey = isGeminiConfigured();
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!geminiKey && !openaiKey) {
    throw new Error(
      "CRITICAL API KEY CONFLICT: Neither Gemini (GEMINI_API_KEY or GEMINI_BACKEND=vertex) nor OPENAI_API_KEY is configured."
    );
  }

  const candidateProfileContext = options?.candidateProfileContext?.trim();
  if (!candidateProfileContext) {
    throw new Error(
      "Legacy agent evaluation requires an explicit database-backed candidateProfileContext; refusing the fixed in-code profile path."
    );
  }

  const trace: string[] = [];
  const toolsUsed: string[] = [];

  const systemInstruction = `You are an expert Executive Career Architect and AI Decision Engine. Your objective is to evaluate job descriptions for a highly specialized executive technologist.

### ACTIVE DATABASE-BACKED CANDIDATE CONTEXT:
${candidateProfileContext}

### EVALUATION WORKFLOW (3 STAGES)

#### STAGE 1: MULTI-LANE CLASSIFICATION
You must categorize the job into one PRIMARY lane and zero or more SECONDARY lanes.
Lanes:
- HEALTH_BIO_PHARMA: ${MULTI_LANE_SCORECARDS.HEALTH_BIO_PHARMA.criteria}
- LEGAL_REGTECH: ${MULTI_LANE_SCORECARDS.LEGAL_REGTECH.criteria}
- INVESTMENT_MARKETS_FINTECH: ${MULTI_LANE_SCORECARDS.INVESTMENT_MARKETS_FINTECH.criteria}
- CORE_AI_DATA: ${MULTI_LANE_SCORECARDS.CORE_AI_DATA.criteria}

Assign lane_confidence (High, Medium, Low) based on explicit evidence in the job description. Do NOT rely on exact keyword matching alone; read the semantic context. Output the verbatim quotes as lane_evidence. If no lane matches (e.g., standard SWE without data/ML), set primary_lane to null.

**IMPORTANT CALIBRATION RULE:** "Platform Architect" must not automatically qualify for CORE_AI_DATA. The job must contain substantive evidence of building AI, ML, data platforms or technical systems—not merely governing a vendor platform. If the role is dominated by governance, stakeholder influence, or is an architect role without hands-on building:
- set primary_lane to null
- set next_action to "REJECTED"
- set rejection_codes to include "ROLE_DOMINATED_BY_GOVERNANCE_AND_STAKEHOLDER_INFLUENCE", "PRIMARY_CUSTOMER_ADVISORY", "BUILD_RESEARCH_RATIO_BELOW_70", "LOW_HANDS_ON_AI_ML", or "HIGH_ORGANISATIONAL_POLITICS_EXPOSURE"
- evaluate interaction_load as high (e.g., > 30) and building_research_ratio as low (e.g., < 70) only when evidence supports those measurements; otherwise return null, never zero for unknown.

#### STAGE 2: INDEPENDENT RISK METRICS (0-100 each)
- nd_friendly_score (Target >= 70): Evidence of safe focus, async comms. Matches: ${ND_FRIENDLY_DIMENSIONS.highSupportiveFactors.join(", ")}
- politics_stress_score (Target < 50): Evidence of corporate alignment, fast-paced chaos, matrixed stakeholders. Matches: ${POLITICS_STRESS_RISK_DIMENSIONS.highRiskFactors.join(", ")}
- sensory_overload_index (Target < 50): Evidence of open offices, constant video, high travel.
- building_research_ratio and interaction_load: finite numbers from 0 to 100 when supported by evidence; use null when either measurement is unavailable.

#### STAGE 3: ACTION PLAN
- strategic_value: Summary of the present-day value of the role for the candidate.
- recommended_cv_version: "HEALTH_BIO_PHARMA", "LEGAL_REGTECH", "INVESTMENT_MARKETS_FINTECH", "CORE_AI_DATA" or "None".
- next_action: "PRIORITY_APPLY" (High confidence lane, high ND friendly, low politics), "APPLY_AFTER_VERIFICATION", "LOW_STRATEGIC_VALUE", or "REJECTED" (if primary_lane is null).

### MANDATED TYPED OUTPUT FORMAT:
You MUST return a JSON object matching this schema exactly.
{
  "evaluation_summary": "Overall synthesis",
  "evaluated_jobs": [
    {
      "job_id": "string",
      "job_title": "string",
      "company": "string",
      "careers_portal_url": "string",
      "primary_lane": "CORE_AI_DATA | LEGAL_REGTECH | HEALTH_BIO_PHARMA | INVESTMENT_MARKETS_FINTECH | null",
      "secondary_lanes": ["string"],
      "lane_confidence": "High | Medium | Low",
      "lane_evidence": "string",
      "nd_gate_status": "string",
      "nd_score": integer (0-100),
      "nd_evidence": "string",
      "nd_risk_flags": ["string"],
      "work_mode_status": "string",
      "office_days": integer,
      "interaction_load": finite number (0-100) or null,
      "building_research_ratio": finite number (0-100) or null,
      "rejection_codes": ["string"],
      "nd_friendly_score": integer (0-100),
      "politics_stress_score": integer (0-100),
      "sensory_overload_index": integer (0-100),
      "biological_and_stress_risk_assessment": "string",
      "strategic_value": "string",
      "recommended_cv_version": "string",
      "next_action": "string"
    }
  ]
}`;

  const order = resolveProviderOrder(process.env.EVALUATION_PRIMARY_PROVIDER);
  const openaiEvalModel = process.env.OPENAI_MODEL || MODEL_REGISTRY.EVALUATION_FALLBACK_MODEL;

  const tried = new Set<string>();
  let parsedResult: AgentResult | null = null;
  let successProvider: "gemini" | "openai" | "ollama" = "gemini";
  let successModel = MODEL_REGISTRY.EVALUATION_PRIMARY_MODEL;
  let fallbackUsed = false;
  let attempts = 0;
  const errors: string[] = [];

  for (const provider of order) {
    if (provider === "gemini" && geminiKey && !tried.has("gemini")) {
      tried.add("gemini");
      attempts++;
      try {
        trace.push(`Step ${trace.length + 1}: Running evaluation agent with Gemini API...`);
        const result = await runGeminiAgentInternal(userQuestion, systemInstruction, trace, toolsUsed);
        parsedResult = result;
        successProvider = "gemini";
        successModel = MODEL_REGISTRY.EVALUATION_PRIMARY_MODEL;
        fallbackUsed = false;
        if (parsedResult) break;
      } catch (geminiErr: any) {
        const msg = publicErrorSummary(geminiErr, "gemini");
        console.warn(`⚠️ Gemini agent run failed: ${msg}.`);
        trace.push(`Step ${trace.length + 1}: Gemini agent run failed: ${msg}`);
        errors.push(`Gemini: ${msg}`);
      }
    }
    if (provider === "openai" && openaiKey && !tried.has("openai")) {
      tried.add("openai");
      attempts++;
      try {
        trace.push(`Step ${trace.length + 1}: Running evaluation agent with OpenAI API...`);
        const modelToUse = openaiEvalModel;
        const text = await tryOpenAI(openaiKey, {
          model: modelToUse,
          contents: userQuestion,
          responseMimeType: "application/json",
          systemInstruction
        });
        parsedResult = parseResultJson(text, trace);
        successProvider = "openai";
        successModel = modelToUse;
        fallbackUsed = tried.has("gemini");
        if (parsedResult) break;
      } catch (err: any) {
        const msg = publicErrorSummary(err, "openai");
        console.warn(`⚠️ OpenAI agent run failed: ${msg}`);
        trace.push(`Step ${trace.length + 1}: OpenAI agent run failed: ${msg}`);
        errors.push(`OpenAI: ${msg}`);
      }
    }
  }

  if (!parsedResult) {
    throw new Error(`All model API calls failed during agent execution. Attempts: ${attempts}, Errors: ${errors.join("; ")}`);
  }

  trace.push(`Step ${trace.length + 1}: Multi-stage decision engine completed successfully via ${successProvider} (${successModel}).`);

  // Write evaluation results BACK to the persistent database
  if (parsedResult.evaluated_jobs && parsedResult.evaluated_jobs.length > 0) {
    const dbJobs = await db.queryJobs();
    for (const job of parsedResult.evaluated_jobs) {
      let matchedJob = dbJobs.find(
        (j) => j.id === job.job_id || (j.title === job.job_title && j.company_name === job.company)
      );
      
      if (matchedJob) {
        await db.updateJobEvaluation(matchedJob.id, {
          processing_status: "EVALUATED",
          primary_lane: job.primary_lane,
          secondary_lanes: job.secondary_lanes,
          lane_confidence: job.lane_confidence,
          lane_evidence: job.lane_evidence,
          source_lane: "LLM",
          nd_gate_status: job.nd_gate_status || undefined,
          nd_score: job.nd_score || undefined,
          nd_evidence: job.nd_evidence || undefined,
          nd_risk_flags: job.nd_risk_flags || undefined,
          work_mode_status: job.work_mode_status || undefined,
          office_days: job.office_days || undefined,
          interaction_load: job.interaction_load || undefined,
          building_research_ratio: job.building_research_ratio || undefined,
          rejection_codes: job.rejection_codes || undefined,
          nd_friendly_score: job.nd_friendly_score || 50,
          politics_stress_score: job.politics_stress_score || 50,
          sensory_overload_index: job.sensory_overload_index || 50,
          biological_stress_risk: job.biological_and_stress_risk_assessment || undefined,
          strategic_value: job.strategic_value,
          recommended_cv_version: job.recommended_cv_version,
          next_action: job.next_action,
          careers_portal_url: job.careers_portal_url || matchedJob.careers_portal_url
        });
        trace.push(`Step ${trace.length + 1}: Recorded persistent ND culture metrics for ${job.company} in database.`);
      }
    }
  }

  await db.logInteraction(userQuestion, toolsUsed, parsedResult, trace);

  return {
    result: parsedResult,
    provider: successProvider,
    model: successModel,
    fallbackUsed,
    attempts,
    errors,
    degraded: fallbackUsed,
    trace,
    toolsUsed
  };
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
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
}

interface ValidatedSingleEvaluationPayload {
  root: Record<string, any>;
  jobPayload: Record<string, any>;
}

export const MAX_SINGLE_EVALUATION_RESPONSE_BYTES = 256 * 1024;
const MAX_MODEL_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
const MODEL_MAX_OUTPUT_TOKENS = 8_192;
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
  response: Pick<GenerateContentAuditedResult, "provider" | "model" | "fallbackUsed">
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
    is_fallback: response.fallbackUsed,
    degraded_state: response.fallbackUsed,
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
  /** Offline comparison only (scripts/compare_evaluation_models.ts): evaluate with this model id. */
  options: { modelOverride?: string } = {},
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
1. Classify into primary_lane ("CORE_AI_DATA", "LEGAL_REGTECH", "HEALTH_BIO_PHARMA", "INVESTMENT_MARKETS_FINTECH", or null).
2. For every 0-100 score, return null when evidence is unavailable. Never use 0 to mean unknown or unavailable. Use integer scores for the other metrics. For building_research_ratio and interaction_load, return a finite number from 0 to 100 when evidence supports a measurement or null when unavailable; these two measurements need not be integers. A zero is valid only when the evidence supports an actual zero.
3. Use higher focus_protection_score for protected, uninterrupted work. building_research_ratio is the estimated percent of hands-on building/research; higher interaction_load means more interaction. Higher strategic_value_score, technical_depth_score, and role_ownership_score mean stronger value, technical depth, and end-to-end ownership. For ambiguity_burden, meeting_burden, travel_burden, and on_call_burden, 0 is low burden and 100 is high burden.
4. Set career_trajectory to ADVANCING, LATERAL, DETOUR, or UNKNOWN; use UNKNOWN when candidate-profile or role evidence is insufficient. Keep evaluation_summary concise (one or two short sentences) and list evidence-based strengths, gaps, and risk_flags.
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
      "primary_lane": "CORE_AI_DATA | LEGAL_REGTECH | HEALTH_BIO_PHARMA | INVESTMENT_MARKETS_FINTECH | null",
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
      "recommended_cv_version": "HEALTH_BIO_PHARMA | LEGAL_REGTECH | INVESTMENT_MARKETS_FINTECH | CORE_AI_DATA | None",
      "next_action": "PRIORITY_APPLY | APPLY_AFTER_VERIFICATION | LOW_STRATEGIC_VALUE | REJECTED"
    }
  ]
}
`;

  const systemInstruction = `You are an AI decision engine evaluating a single canonical job. Return a single JSON object.`;

  const openaiEvalModelForRoute = process.env.OPENAI_MODEL || MODEL_REGISTRY.EVALUATION_FALLBACK_MODEL;
  trace.push("Attempting strict single-job evaluation through audited model routing...");
  const response = await generateContentAudited({
    purpose: "EVALUATION",
    routeKey: "single_job_evaluation",
    model: options.modelOverride?.trim() || openaiEvalModelForRoute,
    flex: true,
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
  };

}


