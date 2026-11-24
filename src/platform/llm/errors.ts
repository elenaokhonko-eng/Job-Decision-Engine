/** Provider error classification. Pure: no environment, no clock, no I/O. */

/** The Gemini API surface a call went to. Mirrors `GeminiBackend` in src/services/geminiConfig.ts. */
export type GeminiBackend = "studio" | "vertex";

export interface GeminiErrorClassification {
  dailyQuota: boolean;
  rateLimit: boolean;
  timeout: boolean;
  serverError: boolean;
  retryable: boolean;
}

const GEMINI_RETRYABLE_HTTP_STATUSES = new Set([500, 502, 503, 504]);
/** undici/Node error codes for a request that ran out of time (headers, body or connect). */
export const FETCH_TIMEOUT_CAUSE_CODES = new Set([
  "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT", "ETIMEDOUT",
]);
/** undici/Node error codes for a dropped or refused connection: the service is unavailable. */
const FETCH_CONNECTION_CAUSE_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "UND_ERR_SOCKET"]);

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
export function classifyGeminiErrorForBackend(error: any, backend: GeminiBackend): GeminiErrorClassification {
  const message = String(error?.message ?? error ?? "");
  const status = Number(error?.status);
  const rateLimit = status === 429 || message.includes("RESOURCE_EXHAUSTED") || /"code"\s*:\s*429\b/.test(message);
  const dailyQuota = backend === "studio" && rateLimit && GEMINI_DAILY_QUOTA_PATTERN.test(message);
  // Node's fetch reports transport failures as TypeError("fetch failed") with the reason in `cause`.
  const causeCode = String(error?.cause?.code ?? error?.code ?? "");
  const timeout =
    error?.name === "AbortError" ||
    error?.name === "TimeoutError" ||
    FETCH_TIMEOUT_CAUSE_CODES.has(causeCode) ||
    /timeout|timed out|aborted/i.test(message);
  const serverError =
    FETCH_CONNECTION_CAUSE_CODES.has(causeCode) ||
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
