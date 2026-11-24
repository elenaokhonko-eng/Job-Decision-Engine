/**
 * Where OpenAI-protocol calls go.
 *
 * Ollama, LM Studio, vLLM, Groq, Together, OpenRouter and self-hosted gateways speak the OpenAI
 * wire protocol, so one operator-set variable, `OPENAI_BASE_URL`, redirects every OpenAI-protocol
 * call (evaluation, extraction, documents, embeddings, model listing). Unset or blank means the
 * official endpoint.
 *
 * The base URL is configuration, never request input: no API route or script argument may set it,
 * so a caller cannot make the server send a stored key to a host of their choosing. A set but
 * invalid value is an error. It never falls back to the official endpoint, because that would
 * silently send traffic to a different provider than the operator chose.
 */

export const OPENAI_BASE_URL_ENV = "OPENAI_BASE_URL";
export const OPENAI_ALLOW_INSECURE_ENV = "OPENAI_ALLOW_INSECURE_BASE_URL";
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

export class OpenAiBaseUrlError extends Error {
  constructor(reason: string) {
    // The URL itself is never put in the message: it may carry credentials.
    super(`${OPENAI_BASE_URL_ENV} is not usable: ${reason}`);
    this.name = "OpenAiBaseUrlError";
  }
}

type Env = Readonly<Record<string, string | undefined>>;

/** Linear-time trailing-slash trim (a regex such as /\/+$/ backtracks on long runs of slashes). */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Validates a configured base URL and returns it without trailing slashes.
 * https is accepted anywhere; http only on loopback unless `allowInsecure` is set (a self-hosted
 * gateway on a private network). Credentials, query strings and fragments are rejected.
 */
export function parseOpenAiBaseUrl(raw: string, allowInsecure = false): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new OpenAiBaseUrlError("it is not a valid URL");
  }
  if (parsed.username || parsed.password) throw new OpenAiBaseUrlError("it must not contain credentials");
  if (parsed.search || parsed.hash) throw new OpenAiBaseUrlError("it must not contain a query string or fragment");
  if (parsed.protocol === "https:") return stripTrailingSlashes(parsed.href);
  if (parsed.protocol === "http:") {
    if (isLoopbackHost(parsed.hostname) || allowInsecure) return stripTrailingSlashes(parsed.href);
    throw new OpenAiBaseUrlError(`plain http is allowed only on loopback; set ${OPENAI_ALLOW_INSECURE_ENV}=true for a private-network gateway`);
  }
  throw new OpenAiBaseUrlError("the scheme must be https (or http on loopback)");
}

/** The base URL OpenAI-protocol calls use. Reads the environment it is given, at call time. */
export function resolveOpenAiBaseUrl(env: Env = process.env): string {
  const raw = (env[OPENAI_BASE_URL_ENV] ?? "").trim();
  if (!raw) return DEFAULT_OPENAI_BASE_URL;
  return parseOpenAiBaseUrl(raw, (env[OPENAI_ALLOW_INSECURE_ENV] ?? "").trim().toLowerCase() === "true");
}
