import { GoogleGenAI } from "@google/genai";
import { readJsonResponseBounded, readResponseTextBounded } from "../../security/boundedResponse.js";
import { publicErrorSummary } from "../../security/publicErrorSummary.js";
import {
  geminiBackend,
  geminiConfigProblem,
  isGeminiConfigured,
  resolveGeminiClientConfig,
  type GeminiBackend,
  type GeminiClientConfig,
  type GeminiCredentialScope,
} from "../config/index.js";
import {
  backoffOptionsFromEnv,
  estimateTokens,
  fullJitterBackoffMs,
  GEMINI_FLEX_PROVIDER_LABEL,
  geminiFlexCallDeadlineMs,
  geminiFlexRequestTimeoutMs,
  getModelLimiter,
  interactiveCallDeadlineMs,
  ModelCallDeadlineError,
  ModelRateLimitedError,
  pipelineCallDeadlineMs,
  rateLimitMaxAttempts,
  recordProviderCall,
  serverSuggestedDelayMs,
  type ModelFailureKind,
} from "./resilience.js";
import { ensureFetchDispatcherTimeouts } from "./fetchDispatcherTimeouts.js";
import { classifyGeminiErrorForBackend, FETCH_TIMEOUT_CAUSE_CODES, type GeminiErrorClassification } from "./errors.js";
import { extractTokenUsage, finiteUsageNumber, type ModelTokenUsage } from "./usage.js";
import { geminiResponseSchema, openAiStrictSchema } from "./schema.js";

export const MAX_MODEL_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
export const MODEL_MAX_OUTPUT_TOKENS = 8_192;

function classifyGeminiError(error: any, backend: GeminiBackend = currentGeminiBackend()): GeminiErrorClassification {
  return classifyGeminiErrorForBackend(error, backend);
}

/** Provider call functions (Gemini, OpenAI, OpenAI-compatible) and the per-call option helpers. Moved from src/services/agent.ts unchanged. */

export type TextProvider = "gemini" | "openai";

export function modelRequestMaxRetries(): number {
  const parsed = Number.parseInt(String(process.env.MODEL_REQUEST_MAX_RETRIES || "3"), 10);
  if (!Number.isFinite(parsed)) return 3;
  return Math.max(1, Math.min(5, parsed));
}

export function modelRequestTimeoutMs(): number {
  const parsed = Number.parseInt(String(process.env.MODEL_REQUEST_TIMEOUT_MS || "60000"), 10);
  if (!Number.isFinite(parsed)) return 60000;
  return Math.max(5000, Math.min(300000, parsed));
}

/** Per-call attempt limit: an explicit override (clamped like the env value) or the env default. */
export function effectiveMaxRetries(override: unknown): number {
  if (typeof override === "number" && Number.isFinite(override)) {
    return Math.max(1, Math.min(5, Math.floor(override)));
  }
  return modelRequestMaxRetries();
}

/** Per-call request timeout: an explicit override (clamped like the env value) or the env default. */
export function effectiveTimeoutMs(override: unknown): number {
  if (typeof override === "number" && Number.isFinite(override)) {
    return Math.max(5000, Math.min(300000, Math.floor(override)));
  }
  return modelRequestTimeoutMs();
}

export function currentGeminiBackend(): GeminiBackend {
  try {
    return geminiBackend();
  } catch {
    return "studio";
  }
}

export function geminiFailureKind(classification: GeminiErrorClassification): ModelFailureKind {
  if (classification.dailyQuota) return "DAILY_QUOTA";
  if (classification.rateLimit) return "RATE_LIMITED";
  if (classification.timeout) return "TIMEOUT";
  if (classification.serverError) return "SERVER_ERROR";
  return "OTHER";
}

/** Which Gemini billing path one request used. */
export type GeminiPath = "FLEX" | "STANDARD";

export interface ModelProviderAttemptTelemetry extends ModelTokenUsage {
  provider: TextProvider | "kimi";
  /** Gemini only: FLEX when the request carried Vertex Flex PayGo headers. */
  path?: GeminiPath;
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

export function recordProviderAttempt(options: any, attempt: ModelProviderAttemptTelemetry): void {
  if (Array.isArray(options?.__providerAttemptTelemetry)) {
    options.__providerAttemptTelemetry.push(attempt);
  }
}

export function isRetryableModelRequestError(error: any): boolean {
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

// Lazily initialised Gemini SDK clients, one per backend and credential scope, rebuilt when that
// slot's configuration changes. Credentials are compared directly and never hashed or used as a
// map key. A missing or incomplete configuration throws ("loud fail") instead of silently skipping
// the provider.
export const geminiClients = new Map<string, { config: GeminiClientConfig; client: GoogleGenAI }>();

export function sameGeminiClientConfig(a: GeminiClientConfig, b: GeminiClientConfig): boolean {
  if (a.backend === "vertex" && b.backend === "vertex") return a.project === b.project && a.location === b.location;
  if (a.backend === "studio" && b.backend === "studio") return a.apiKey === b.apiKey && a.apiVersion === b.apiVersion;
  return false;
}

/**
 * The Gemini client for this environment.
 * - GEMINI_BACKEND=studio (default): AI Studio API key (GEMINI_API_KEY / GEMINI_FLASH_API_KEY, or
 *   DOCUMENT_GEMINI_API_KEY for scope "document"), unchanged behaviour.
 * - GEMINI_BACKEND=vertex: Vertex AI with Application Default Credentials (a service-account file
 *   in GOOGLE_APPLICATION_CREDENTIALS locally, Workload Identity Federation in Actions), the
 *   configured project and location (default "global"). No AI Studio headers or apiVersion.
 */
export function getGeminiClient(options: { scope?: GeminiCredentialScope } = {}): GoogleGenAI {
  const scope = options.scope ?? "default";
  const config = resolveGeminiClientConfig(process.env, scope);
  const slot = `${config.backend}:${scope}`;
  const cached = geminiClients.get(slot);
  if (cached && sameGeminiClientConfig(cached.config, config)) return cached.client;
  const client = config.backend === "vertex"
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
  geminiClients.set(slot, { config, client });
  return client;
}

/** Tests only: drop cached clients so a changed backend configuration builds a new one. */
export function resetGeminiClientsForTests(): void {
  geminiClients.clear();
}

/**
 * True when a call starts on Vertex Flex PayGo: a pipeline call flagged `flex`, with
 * GEMINI_PIPELINE_FLEX=true and the Vertex backend (global endpoint only). Never for interactive
 * document calls: Flex trades latency for price.
 */
export function geminiFlexEligible(options: any): boolean {
  if (options?.interactive === true || options?.flex !== true) return false;
  if (process.env.GEMINI_PIPELINE_FLEX !== "true") return false;
  return currentGeminiBackend() === "vertex";
}

/**
 * The Gemini path of one request: FLEX for a Flex-eligible call unless the caller asked for the
 * standard retry (`__geminiPath: "STANDARD"`); STANDARD otherwise.
 */
export function geminiRequestPath(options: any): GeminiPath {
  if (options?.__geminiPath === "STANDARD") return "STANDARD";
  return geminiFlexEligible(options) ? "FLEX" : "STANDARD";
}

/**
 * Vertex Flex PayGo headers (Flex-only mode: "shared" request type plus "flex" shared request
 * type) for a FLEX request. The server-side timeout header (X-Server-Timeout, seconds) is added by
 * `@google/genai` from httpOptions.timeout, so it is not repeated here: a second copy would be
 * appended to the same header.
 */
export function geminiFlexHeaders(options: any): Record<string, string> | undefined {
  if (geminiRequestPath(options) !== "FLEX") return undefined;
  return {
    "X-Vertex-AI-LLM-Request-Type": "shared",
    "X-Vertex-AI-LLM-Shared-Request-Type": "flex",
  };
}

/**
 * A Flex failure that the standard PayGo retry may absorb: timeout, 429 / RESOURCE_EXHAUSTED, or
 * the service being unavailable (5xx, UNAVAILABLE, dropped connection, call deadline).
 */
export function isFlexCapacityFailure(error: unknown): boolean {
  if (error instanceof ModelRateLimitedError || error instanceof ModelCallDeadlineError) return true;
  const classification = classifyGeminiError(error, "vertex");
  return classification.rateLimit || classification.timeout || classification.serverError;
}

/** The per-call deadline a pipeline call of this kind gets by default (for run time budgets). */
export function defaultModelCallDeadlineMs(options: { interactive?: boolean; flex?: boolean } = {}): number {
  if (options.interactive === true) return interactiveCallDeadlineMs();
  return geminiFlexEligible(options) ? geminiFlexCallDeadlineMs() : pipelineCallDeadlineMs();
}

/** The absolute deadline for one model call: options.deadlineAt, else interactive/pipeline default. */
export function callDeadlineAt(options: any, startedAt = Date.now()): number {
  if (typeof options?.deadlineAt === "number" && Number.isFinite(options.deadlineAt)) return options.deadlineAt;
  if (typeof options?.deadlineMs === "number" && Number.isFinite(options.deadlineMs) && options.deadlineMs > 0) {
    return startedAt + options.deadlineMs;
  }
  return startedAt + defaultModelCallDeadlineMs(options ?? {});
}

/** Headroom on the fetch dispatcher above a Flex request timeout, so the request timeout fires first. */
export const FLEX_DISPATCHER_HEADROOM_MS = 30_000;

export function sleepMs(ms: number): Promise<void> {
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
 * - `singleAttempt` (the Flex request and the standard retry after it): exactly one HTTP attempt;
 *   any failure is thrown to the caller, which decides the next path.
 * A FLEX request uses the Flex request timeout (GEMINI_FLEX_REQUEST_TIMEOUT_MS, default 600 s);
 * every other request keeps MODEL_REQUEST_TIMEOUT_MS or the per-call `timeoutMs`.
 * Every request first takes a slot from the process-wide per-model limiter.
 */
export async function tryGemini(options: any, defaultModel: string): Promise<string> {
  const scope: GeminiCredentialScope = options.geminiCredentialScope === "document" ? "document" : "default";
  const ai = getGeminiClient({ scope });
  const backend = currentGeminiBackend();
  const singleAttempt = options.singleAttempt === true;
  const maxRetries = singleAttempt ? 1 : effectiveMaxRetries(options.maxRetries);
  const maxRateLimitAttempts = singleAttempt ? 1 : rateLimitMaxAttempts();
  const path = geminiRequestPath(options);
  const timeoutMs = path === "FLEX" ? geminiFlexRequestTimeoutMs() : effectiveTimeoutMs(options.timeoutMs);
  const model = options.model || defaultModel;
  const deadlineAt = callDeadlineAt(options);
  const deadlineMs = Math.max(0, deadlineAt - Date.now());
  const limiter = getModelLimiter(model);
  const estimatedTokens = estimateTokens(options.contents, options.systemInstruction) +
    (options.maxOutputTokens ?? MODEL_MAX_OUTPUT_TOKENS);
  const flexHeaders = geminiFlexHeaders(options);
  const statsProvider = path === "FLEX" ? GEMINI_FLEX_PROVIDER_LABEL : "gemini";
  if (path === "FLEX") {
    // Node's fetch would otherwise stop waiting for the response headers after 300 s.
    await ensureFetchDispatcherTimeouts(timeoutMs + FLEX_DISPATCHER_HEADROOM_MS);
  }
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
        `[model:gemini] backend=${backend} path=${path} model=${model} attempt=${attempt} starting timeout=${Math.round(callTimeoutMs / 1000)}s`
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
        `[model:gemini] path=${path} model=${model} attempt=${attempt} completed elapsed_ms=${Date.now() - startedAt}`
      );
      recordProviderCall({ provider: statsProvider, model, outcome: "OK", retry: attempt > 1 });
      recordProviderAttempt(options, {
        provider: "gemini",
        path,
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
      if (singleAttempt && classification.timeout) {
        console.warn(`[model:gemini] path=${path} model=${model} TIMEOUT attempt=${attempt} after ${Math.round(callTimeoutMs / 1000)}s.`);
      }
      const willRetry = classification.retryable && !exhausted;
      recordProviderCall({ provider: statsProvider, model, outcome: kind, retry: attempt > 1 });
      recordProviderAttempt(options, {
        provider: "gemini",
        path,
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
        const reason = singleAttempt
          ? "single-attempt path; the caller picks the next path"
          : options.switchModelOnRateLimit === true ? "switching model after the first 429" : `${rateLimitFailures} rate-limited attempt(s)`;
        console.warn(`[model:gemini] path=${path} model=${model} rate limited (429); ${reason}.`);
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

/** The failure kind of one OpenAI-compatible HTTP attempt (for telemetry and the provider mix). */
export function openAiCompatibleFailureKind(error: any): ModelFailureKind {
  const status = Number(error?.status);
  if (status === 429) return "RATE_LIMITED";
  const causeCode = String(error?.cause?.code ?? error?.code ?? "");
  if (
    error?.name === "AbortError" ||
    error?.name === "TimeoutError" ||
    FETCH_TIMEOUT_CAUSE_CODES.has(causeCode) ||
    /timeout|timed out/i.test(String(error?.message ?? ""))
  ) {
    return "TIMEOUT";
  }
  if (Number.isFinite(status) && status >= 500) return "SERVER_ERROR";
  return "OTHER";
}

export async function tryOpenAICompatible(apiKey: string, baseUrl: string, model: string, options: any, isKimi: boolean = false): Promise<string> {
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
        errorKind: openAiCompatibleFailureKind(err),
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

export async function tryOpenAI(openaiKey: string, options: any, defaultModel: string): Promise<string> {
  const baseUrl = "https://api.openai.com/v1";
  const requestedModel = typeof options.model === "string" ? options.model : "";
  const model = requestedModel && !requestedModel.toLowerCase().startsWith("gemini")
    ? requestedModel
    : defaultModel;
  return tryOpenAICompatible(openaiKey, baseUrl, model, options, false);
}


