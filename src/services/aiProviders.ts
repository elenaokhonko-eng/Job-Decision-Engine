/**
 * Provider registry for AI model access.
 *
 * The setup API used to hardcode two providers behind an
 * `if (provider === "gemini") ... else if (provider === "openai") ... else throw`
 * ladder, and the model-route contract was typed `"gemini" | "openai"`. That made
 * "any open source or closed LLM" impossible without editing source: Ollama,
 * LM Studio, vLLM, Groq, Together, OpenRouter, Moonshot/Kimi, DeepSeek and
 * self-hosted gateways all speak the OpenAI wire protocol but none of them is
 * literally OpenAI.
 *
 * A provider here is a *transport*, not a vendor. There are three:
 *
 *   gemini            native Google Generative Language API
 *   openai            native OpenAI, with an optional base-URL override
 *   openai-compatible any endpoint that implements the OpenAI API shape
 *
 * `openai-compatible` is what covers the long tail. The runtime resolves its
 * base URL and key through `resolveOpenAiBaseUrl()` / `resolveOpenAiApiKey()`,
 * so configuring it once is enough for evaluation, extraction, documents and
 * embeddings.
 */

export type AiProviderId = "gemini" | "openai" | "openai-compatible";

export type AiProviderProtocol = "gemini" | "openai";

export interface AiProviderDefinition {
  id: AiProviderId;
  label: string;
  /** Wire protocol the runtime speaks to this provider. */
  protocol: AiProviderProtocol;
  /** Environment variable holding the API key. */
  apiKeyEnv: string;
  /** Environment variables that can override the base URL, highest priority first. */
  baseUrlEnvs: string[];
  defaultBaseUrl?: string;
  /** Local servers (Ollama, LM Studio) ignore auth, so a key is optional there. */
  requiresApiKey: boolean;
}

export const AI_PROVIDERS: Record<AiProviderId, AiProviderDefinition> = {
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    protocol: "gemini",
    apiKeyEnv: "GEMINI_API_KEY",
    baseUrlEnvs: [],
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    requiresApiKey: true,
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    protocol: "openai",
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrlEnvs: ["OPENAI_BASE_URL"],
    defaultBaseUrl: "https://api.openai.com/v1",
    requiresApiKey: true,
  },
  "openai-compatible": {
    id: "openai-compatible",
    label: "Any OpenAI-compatible endpoint",
    protocol: "openai",
    apiKeyEnv: "OPENAI_COMPATIBLE_API_KEY",
    baseUrlEnvs: ["OPENAI_COMPATIBLE_BASE_URL", "OPENAI_BASE_URL"],
    defaultBaseUrl: "http://127.0.0.1:11434/v1",
    requiresApiKey: false,
  },
};

const PROVIDER_ORDER: AiProviderId[] = ["gemini", "openai", "openai-compatible"];

export function listAiProviderIds(): AiProviderId[] {
  return [...PROVIDER_ORDER];
}

/** Accepts the ids plus the common aliases people actually type. */
export function normalizeAiProviderId(value: unknown): AiProviderId | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized in AI_PROVIDERS) return normalized as AiProviderId;
  if (normalized === "google" || normalized === "google-ai" || normalized === "google-gemini") return "gemini";
  if (normalized === "openai-compatible" || normalized === "compatible") return "openai-compatible";
  // Anything else that speaks the OpenAI protocol is treated as compatible:
  // ollama, groq, together, openrouter, vllm, lmstudio, moonshot/kimi, deepseek...
  if (normalized !== "openai" && normalized !== "gemini") return "openai-compatible";
  return null;
}

function firstEnvValue(names: string[]): string {
  for (const name of names) {
    const value = (process.env[name] || "").trim();
    if (value) return value;
  }
  return "";
}

/**
 * Trim trailing slashes without a regex.
 *
 * `value.replace(/\/+$/, "")` is polynomial-time on attacker-controlled input,
 * because a failing run of slashes backtracks across every starting position.
 * A reverse scan is linear and does the same thing.
 */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47 /* "/" */) {
    end -= 1;
  }
  return value.slice(0, end);
}

export class ProviderBaseUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderBaseUrlError";
  }
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
}

/**
 * Validate a base URL that came from a request rather than from configuration.
 *
 * A caller-supplied base URL decides where an API key is sent, so it must not be
 * able to point at an arbitrary host over plain HTTP. HTTPS anywhere, or HTTP on
 * loopback only (Ollama and LM Studio listen on 127.0.0.1).
 *
 * Base URLs from the environment are deliberately *not* passed through this
 * check: the operator set those, and a self-hosted endpoint on a LAN address
 * over plain HTTP is a legitimate configuration.
 */
export function assertAllowedProviderBaseUrl(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return "";

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ProviderBaseUrlError(`baseUrl is not a valid URL: ${trimmed}`);
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol === "https:") return stripTrailingSlashes(trimmed);
  if (protocol === "http:" && isLoopbackHost(parsed.hostname)) return stripTrailingSlashes(trimmed);

  throw new ProviderBaseUrlError(
    `baseUrl must use https, or http on localhost only. Received: ${protocol}//${parsed.hostname}`
  );
}

export interface ProviderCallAuthorization {
  ok: boolean;
  apiKey: string;
  baseUrl?: string;
  error?: string;
}

/**
 * Decide which key may be used for a request that also supplies a base URL.
 *
 * The dangerous combination is a *server-held* key paired with a *caller-chosen*
 * URL: any authenticated caller could then have the stored key sent to a host
 * they control. So a caller-supplied `baseUrl` is only honoured together with a
 * caller-supplied `apiKey`. Without one, the request is refused before any
 * outbound call is made.
 */
export function authorizeProviderCall(options: {
  bodyApiKey?: string;
  bodyBaseUrl?: string;
  serverApiKey: string;
}): ProviderCallAuthorization {
  const bodyApiKey = String(options.bodyApiKey ?? "").trim();
  const bodyBaseUrl = String(options.bodyBaseUrl ?? "").trim();

  if (bodyBaseUrl && !bodyApiKey) {
    return {
      ok: false,
      apiKey: "",
      error:
        "A custom baseUrl requires the apiKey to be supplied in the same request. " +
        "A stored key is never sent to a caller-supplied URL.",
    };
  }

  let baseUrl: string | undefined;
  if (bodyBaseUrl) {
    try {
      baseUrl = assertAllowedProviderBaseUrl(bodyBaseUrl);
    } catch (err) {
      return {
        ok: false,
        apiKey: "",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const apiKey = bodyApiKey || options.serverApiKey;
  return { ok: true, apiKey, baseUrl };
}

/** Base URL for a provider, honouring env overrides then its default. */
export function resolveProviderBaseUrl(provider: AiProviderId, override?: string): string {
  const explicit = String(override ?? "").trim();
  if (explicit) return stripTrailingSlashes(explicit);
  const definition = AI_PROVIDERS[provider];
  const fromEnv = firstEnvValue(definition.baseUrlEnvs);
  if (fromEnv) return stripTrailingSlashes(fromEnv);
  return stripTrailingSlashes(definition.defaultBaseUrl ?? "");
}

/**
 * Base URL the OpenAI-protocol runtime should call.
 *
 * `OPENAI_COMPATIBLE_BASE_URL` wins so that configuring a local or third-party
 * endpoint redirects every OpenAI-protocol call without touching source.
 */
export function resolveOpenAiBaseUrl(): string {
  return (
    stripTrailingSlashes(firstEnvValue(["OPENAI_COMPATIBLE_BASE_URL", "OPENAI_BASE_URL"])) ||
    stripTrailingSlashes(AI_PROVIDERS.openai.defaultBaseUrl as string)
  );
}

/** API key for the OpenAI-protocol runtime, accepting the compatible-endpoint key. */
export function resolveOpenAiApiKey(): string {
  return firstEnvValue(["OPENAI_API_KEY", "OPENAI_COMPATIBLE_API_KEY"]);
}

export function resolveProviderApiKey(provider: AiProviderId): string {
  const definition = AI_PROVIDERS[provider];
  const own = firstEnvValue([definition.apiKeyEnv]);
  if (own) return own;
  // A single key is often reused across the OpenAI family.
  if (definition.protocol === "openai") return resolveOpenAiApiKey();
  return "";
}

export function isAiProviderConfigured(provider: AiProviderId): boolean {
  const definition = AI_PROVIDERS[provider];
  if (!definition.requiresApiKey) {
    // A local endpoint is usable once a base URL is known.
    return Boolean(resolveProviderBaseUrl(provider));
  }
  return Boolean(resolveProviderApiKey(provider));
}

export function configuredAiProviderIds(): AiProviderId[] {
  return PROVIDER_ORDER.filter((provider) => isAiProviderConfigured(provider));
}

export class ProviderModelListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderModelListError";
  }
}

export interface ListProviderModelsOptions {
  provider: AiProviderId;
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Ask the provider which models this key can actually use.
 *
 * This is the behaviour the setup wizard needs in order to populate a model
 * dropdown from the account rather than from a hardcoded list, and it is what
 * lets `/setup/routes` reject a model id that does not exist.
 */
export async function listProviderModels(options: ListProviderModelsOptions): Promise<string[]> {
  const { provider, apiKey } = options;
  const definition = AI_PROVIDERS[provider];
  const timeoutMs = options.timeoutMs ?? 10000;
  const fetchImpl = options.fetchImpl ?? fetch;
    // Defence in depth: an explicit baseUrl is caller-supplied, so it is checked
    // here as well as at the route. This runs before any network access.
    const explicitBaseUrl = String(options.baseUrl ?? "").trim()
      ? assertAllowedProviderBaseUrl(String(options.baseUrl))
      : undefined;
    const baseUrl = explicitBaseUrl ?? resolveProviderBaseUrl(provider);

  const url = definition.protocol === "gemini"
    ? `${baseUrl}/models?key=${encodeURIComponent(apiKey)}`
    : `${baseUrl}/models`;

  const headers: Record<string, string> = {};
  if (definition.protocol === "openai" && apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  let response: Response;
  try {
    response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new ProviderModelListError(
      `Could not reach ${definition.label} at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    const detail = body?.error?.message || `HTTP ${response.status}`;
    throw new ProviderModelListError(`${definition.label} rejected the request: ${detail}`);
  }

  const payload = (await response.json().catch(() => null)) as
    | { models?: Array<{ name?: string }>; data?: Array<{ id?: string }> }
    | null;

  if (definition.protocol === "gemini") {
    const models = Array.isArray(payload?.models) ? payload.models : [];
    return models
      .map((model) => (typeof model?.name === "string" ? model.name.replace(/^models\//, "") : ""))
      .filter((id) => id.length > 0);
  }

  const models = Array.isArray(payload?.data) ? payload.data : [];
  return models
    .map((model) => (typeof model?.id === "string" ? model.id : ""))
    .filter((id) => id.length > 0);
}
