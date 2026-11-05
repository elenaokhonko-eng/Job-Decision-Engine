const PUBLIC_PROVIDER_NAMES = new Set([
  "gemini",
  "openai",
  "ollama",
  "kimi",
  "embedding",
  "evaluation",
  "pipeline",
  "external",
]);

const PUBLIC_ERROR_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EPIPE",
  "ECANCELED",
  "INVALID_ARGUMENT",
  "RESOURCE_EXHAUSTED",
  "PERMISSION_DENIED",
  "UNAUTHENTICATED",
  "NOT_FOUND",
  "INTERNAL",
  "UNAVAILABLE",
  "DEADLINE_EXCEEDED",
  "RATE_LIMITED",
]);

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  const record = recordValue(error);
  return typeof record?.message === "string" ? record.message : "";
}

function safeHttpStatus(error: unknown): number | null {
  const record = recordValue(error);
  const response = recordValue(record?.response);
  const status = record?.status ?? record?.statusCode ?? response?.status;
  const parsed = typeof status === "number" ? status : Number(status);
  return Number.isInteger(parsed) && parsed >= 100 && parsed <= 599 ? parsed : null;
}

function safeErrorCode(error: unknown): string | null {
  const record = recordValue(error);
  const response = recordValue(record?.response);
  const candidates: unknown[] = [record?.code, record?.status];
  const nestedError = recordValue(record?.error) ?? recordValue(response?.error);
  candidates.push(nestedError?.code, nestedError?.status);
  const responseData = recordValue(response?.data);
  const responseError = recordValue(responseData?.error);
  candidates.push(responseError?.code, responseError?.status);

  const rawBody = [record?.message, record?.body, response?.body]
    .find((value): value is string => typeof value === "string" && value.length <= 4096);
  if (rawBody) {
    try {
      const parsed = recordValue(JSON.parse(rawBody));
      const parsedError = recordValue(parsed?.error);
      candidates.push(parsedError?.code, parsedError?.status);
    } catch {
      // Provider error text is untrusted; parsing only extracts allow-listed codes.
    }
  }

  for (const candidate of candidates) {
    const code = typeof candidate === "string" ? candidate.toUpperCase() : "";
    if (PUBLIC_ERROR_CODES.has(code)) return code;
  }
  return null;
}

function failureCategory(text: string, status: number | null): string {
  const normalized = text.toLowerCase();
  if (status === 429 || /rate.?limit|too many requests|quota|resource_exhausted/.test(normalized)) {
    return "rate or quota limit";
  }
  if (status === 401 || status === 403 || /unauthori[sz]ed|authentication|permission denied|invalid api key/.test(normalized)) {
    return "authentication or permission failure";
  }
  if (/timeout|timed out|deadline|etimedout|aborterror/.test(normalized)) {
    return "request timed out";
  }
  if (/econnreset|econnrefused|enotfound|eai_again|network|socket|connection|fetch failed/.test(normalized)) {
    return "network request failed";
  }
  if (status !== null && status >= 500 || /internal server|service unavailable|overload|provider unavailable/.test(normalized)) {
    return "provider unavailable";
  }
  if (status !== null && status >= 400 || /invalid argument|bad request|request rejected/.test(normalized)) {
    return "request rejected";
  }
  if (/json|schema|validation|parse|response/.test(normalized)) {
    return "response validation failed";
  }
  return "details redacted";
}

/**
 * Summarize an untrusted provider/evaluator error without rendering its message,
 * request/response body, prompt, profile facts, or contact details in public logs.
 */
export function publicErrorSummary(error: unknown, provider: string = "external"): string {
  const providerKey = provider.trim().toLowerCase();
  const safeProvider = PUBLIC_PROVIDER_NAMES.has(providerKey) ? providerKey : "external";
  const rawText = errorText(error);
  const status = safeHttpStatus(error);
  const code = safeErrorCode(error);
  const details = [
    status === null ? null : `HTTP ${status}`,
    code,
    failureCategory(rawText, status),
  ].filter((part): part is string => Boolean(part));
  return `${safeProvider} request failed (${details.join("; ")})`.slice(0, 240);
}
