import { GoogleGenAI } from "@google/genai";

import { readJsonResponseBounded } from "../security/boundedResponse.js";
import { geminiBackend, geminiConfigProblem, resolveGeminiClientConfig } from "./geminiConfig.js";

/**
 * Model-id preflight: compares every configured model id against the ids the provider account
 * actually lists, so a typo in .env.local (e.g. OPENAI_MODEL=gpt-6-Luna) is reported at startup
 * instead of surfacing later as a failed generation.
 *
 * The resolution chains below mirror MODEL_REGISTRY in src/services/agent.ts (first non-empty
 * env var wins, then the code default). src/tests/services/modelIdPreflight.test.ts checks that
 * they resolve to the same ids.
 *
 * With GEMINI_BACKEND=vertex the Gemini ids are checked one by one with the SDK's models.get on
 * Vertex AI (publisher models at GOOGLE_CLOUD_LOCATION, default "global") instead of the AI Studio
 * model list.
 */

export type ModelIdProvider = "gemini" | "openai";

interface ModelIdSetting {
  provider: ModelIdProvider;
  envChain: readonly string[];
  defaultId: string;
  /** Embedding models are verified differently on Vertex (see checkVertexModelIds). */
  kind?: "embedding";
}

const MODEL_ID_SETTINGS: readonly ModelIdSetting[] = [
  { provider: "gemini", envChain: ["EVALUATION_PRIMARY_MODEL", "GEMINI_MODEL"], defaultId: "gemini-3.6-flash" },
  { provider: "openai", envChain: ["EVALUATION_FALLBACK_MODEL", "OPENAI_MODEL"], defaultId: "gpt-4o-mini" },
  { provider: "gemini", envChain: ["EMBEDDING_PRIMARY_MODEL"], defaultId: "gemini-embedding-001", kind: "embedding" },
  { provider: "openai", envChain: ["EMBEDDING_FALLBACK_MODEL"], defaultId: "text-embedding-3-small" },
  { provider: "gemini", envChain: ["DOCUMENT_PRIMARY_MODEL"], defaultId: "gemini-3.8-flash" },
  { provider: "openai", envChain: ["DOCUMENT_FALLBACK_MODEL", "OPENAI_MODEL"], defaultId: "gpt-4o-mini" },
  { provider: "gemini", envChain: ["REQUIREMENTS_GEMINI_MODEL", "EXTRACTION_GEMINI_MODEL"], defaultId: "gemini-3.1-flash-lite" },
  { provider: "openai", envChain: ["REQUIREMENTS_OPENAI_MODEL", "EXTRACTION_OPENAI_MODEL"], defaultId: "gpt-5.6-luna" },
  // Manual document writers' secondary Gemini model (used after a 429 or failure on the primary).
  { provider: "gemini", envChain: ["DOCUMENT_SECONDARY_GEMINI_MODEL"], defaultId: "gemini-3.1-flash-lite" },
];

export const DEFAULT_MODEL_ID_SOURCE = "(default)";

export interface ConfiguredModelId {
  provider: ModelIdProvider;
  id: string;
  /** Env var names that set this id, or "(default)" when it is the code default. */
  sources: string[];
  /** Set when any setting using this id is an embedding model. */
  kind?: "embedding";
}

/** Every distinct configured model id per provider, with the env vars (or default) that set it. */
export function configuredModelIds(env: NodeJS.ProcessEnv = process.env): ConfiguredModelId[] {
  const byKey = new Map<string, ConfiguredModelId>();
  for (const setting of MODEL_ID_SETTINGS) {
    const envName = setting.envChain.find((name) => !!env[name]);
    const id = envName ? String(env[envName]) : setting.defaultId;
    const source = envName ?? DEFAULT_MODEL_ID_SOURCE;
    const key = `${setting.provider}\u0000${id}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { provider: setting.provider, id, sources: [source], ...(setting.kind ? { kind: setting.kind } : {}) });
    } else {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      if (setting.kind) existing.kind = setting.kind;
    }
  }
  return [...byKey.values()];
}

export interface UnknownModelId extends ConfiguredModelId {
  message: string;
}

export interface ModelIdPreflightResult {
  /** Configured ids the provider account does not list. */
  unknown: UnknownModelId[];
  /** "could not check <provider> models: <reason>" for providers whose listing failed. */
  warnings: string[];
  /** Providers whose model list was fetched and compared. */
  checked: ModelIdProvider[];
  /** Providers skipped because no API key is configured. */
  skipped: ModelIdProvider[];
}

/** The part of the @google/genai client the Vertex check uses (injected in tests). */
export interface VertexModelLookup {
  models: {
    get(params: { model: string }): Promise<unknown>;
    embedContent(params: { model: string; contents: string; config?: { outputDimensionality?: number } }): Promise<unknown>;
  };
}

export interface ModelIdPreflightOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Vertex mode only: the client used for models.get; defaults to an ADC-authenticated client. */
  vertexClient?: VertexModelLookup;
  /** Per-request timeout for the model listing calls. */
  timeoutMs?: number;
}

const PROVIDER_LABEL: Record<ModelIdProvider, string> = { gemini: "Gemini", openai: "OpenAI" };
const MAX_MODEL_LIST_BYTES = 8 * 1024 * 1024;
const MAX_GEMINI_PAGES = 50;
const DEFAULT_LIST_TIMEOUT_MS = 15000;

function geminiKey(env: NodeJS.ProcessEnv): string | null {
  const config = geminiConfigProblem(env) === null ? resolveGeminiClientConfig(env) : null;
  return config?.backend === "studio" ? config.apiKey : null;
}

function isVertexBackend(env: NodeJS.ProcessEnv): boolean {
  try {
    return geminiBackend(env) === "vertex";
  } catch {
    return false;
  }
}

function errorStatus(error: unknown): number | null {
  const status = Number((error as { status?: unknown } | null)?.status);
  if (Number.isFinite(status)) return status;
  const message = String((error as { message?: unknown } | null)?.message ?? "");
  if (/"code"\s*:\s*404\b|NOT_FOUND/.test(message)) return 404;
  return null;
}

/**
 * Vertex mode: models.get for each configured Gemini id at the configured location. A 404 means
 * the id is not available there; any other failure stops the check with a warning.
 * Embedding models are probed with one tiny embedContent call instead: on the global endpoint
 * models.get and countTokens both return 404 for gemini-embedding-001 although embedContent
 * serves it (verified 2026-11-07), so models.get would report a false "not available".
 */
async function checkVertexModelIds(
  env: NodeJS.ProcessEnv,
  configured: ConfiguredModelId[],
  result: ModelIdPreflightResult,
  injected: VertexModelLookup | undefined,
): Promise<void> {
  const problem = geminiConfigProblem(env);
  if (problem) {
    result.warnings.push(`could not check Gemini models on Vertex AI: ${problem}`);
    return;
  }
  const config = resolveGeminiClientConfig(env);
  if (config.backend !== "vertex") return;
  const client: VertexModelLookup = injected ??
    new GoogleGenAI({ vertexai: true, project: config.project, location: config.location });
  for (const entry of configured) {
    if (entry.provider !== "gemini") continue;
    try {
      if (entry.kind === "embedding") {
        await client.models.embedContent({ model: entry.id, contents: "model availability check", config: { outputDimensionality: 8 } });
      } else {
        await client.models.get({ model: entry.id });
      }
    } catch (error) {
      if (errorStatus(error) === 404) {
        result.unknown.push({ ...entry, message: unknownVertexModelIdMessage(entry, config.location) });
        continue;
      }
      result.warnings.push(`could not check Gemini models on Vertex AI: ${shortReason(error, "", DEFAULT_LIST_TIMEOUT_MS)}`);
      return;
    }
  }
  result.checked.push("gemini");
}

export function unknownVertexModelIdMessage(entry: ConfiguredModelId, location: string): string {
  return `Model id "${entry.id}" (${entry.sources.join(", ")}) is not available on Vertex AI at location "${location}"; ` +
    "choose a Vertex publisher model id or change GOOGLE_CLOUD_LOCATION.";
}

function openaiKey(env: NodeJS.ProcessEnv): string | null {
  const key = env.OPENAI_API_KEY;
  if (!key || key.trim() === "") return null;
  return key;
}

class ModelListError extends Error {}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<unknown> {
  const response = await fetchImpl(url, { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ModelListError(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
  }
  return readJsonResponseBounded(response, MAX_MODEL_LIST_BYTES, "Model list response");
}

async function listGeminiModelIds(fetchImpl: typeof fetch, key: string, timeoutMs: number): Promise<Set<string>> {
  const ids = new Set<string>();
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_GEMINI_PAGES; page++) {
    const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const payload = (await fetchJson(fetchImpl, url.toString(), { "x-goog-api-key": key }, timeoutMs)) as {
      models?: Array<{ name?: unknown }>;
      nextPageToken?: unknown;
    };
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.models)) {
      throw new ModelListError("response has no models array");
    }
    for (const model of payload.models) {
      if (typeof model?.name !== "string") continue;
      ids.add(model.name.startsWith("models/") ? model.name.slice("models/".length) : model.name);
    }
    pageToken = typeof payload.nextPageToken === "string" && payload.nextPageToken ? payload.nextPageToken : null;
    if (!pageToken) return ids;
  }
  throw new ModelListError(`more than ${MAX_GEMINI_PAGES} pages of models`);
}

async function listOpenAIModelIds(fetchImpl: typeof fetch, key: string, timeoutMs: number): Promise<Set<string>> {
  const payload = (await fetchJson(
    fetchImpl,
    "https://api.openai.com/v1/models",
    { Authorization: `Bearer ${key}` },
    timeoutMs,
  )) as { data?: Array<{ id?: unknown }> };
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.data)) {
    throw new ModelListError("response has no data array");
  }
  return new Set(payload.data.map((model) => model?.id).filter((id): id is string => typeof id === "string"));
}

/** A short, key-free reason for a failed listing. */
function shortReason(error: unknown, key: string, timeoutMs: number): string {
  const err = error as { name?: string; message?: string } | null;
  if (err?.name === "TimeoutError" || err?.name === "AbortError") {
    return `request timed out after ${Math.round(timeoutMs / 1000)}s`;
  }
  let reason = String(err?.message || error || "unknown error").split(/\r?\n/)[0];
  if (key) reason = reason.split(key).join("[redacted]");
  return reason.length > 200 ? `${reason.slice(0, 200)}...` : reason;
}

export function unknownModelIdMessage(entry: ConfiguredModelId): string {
  const label = PROVIDER_LABEL[entry.provider];
  const envSources = entry.sources.filter((source) => source !== DEFAULT_MODEL_ID_SOURCE);
  if (envSources.length === 0) {
    return `Model id "${entry.id}" ${DEFAULT_MODEL_ID_SOURCE} is not available on your ${label} account; set a supported model id in .env.local.`;
  }
  return `Model id "${entry.id}" (${entry.sources.join(", ")}) is not available on your ${label} account; fix it in .env.local or remove the line to use the default.`;
}

/**
 * Lists the model ids of every provider with a configured key and reports each configured id the
 * account does not list. Never throws for a network, auth or response-shape failure: that provider
 * becomes a warning instead. API keys never appear in the result.
 */
export async function checkConfiguredModelIds(options: ModelIdPreflightOptions = {}): Promise<ModelIdPreflightResult> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
  const configured = configuredModelIds(env);
  const result: ModelIdPreflightResult = { unknown: [], warnings: [], checked: [], skipped: [] };

  const vertex = isVertexBackend(env);
  if (vertex) await checkVertexModelIds(env, configured, result, options.vertexClient);

  const providers: Array<{ provider: ModelIdProvider; key: string | null; list: typeof listGeminiModelIds }> = [
    ...(vertex ? [] : [{ provider: "gemini" as const, key: geminiKey(env), list: listGeminiModelIds }]),
    { provider: "openai", key: openaiKey(env), list: listOpenAIModelIds },
  ];

  for (const { provider, key, list } of providers) {
    if (!key) {
      result.skipped.push(provider);
      continue;
    }
    let available: Set<string>;
    try {
      available = await list(fetchImpl, key, timeoutMs);
    } catch (error) {
      result.warnings.push(`could not check ${PROVIDER_LABEL[provider]} models: ${shortReason(error, key, timeoutMs)}`);
      continue;
    }
    result.checked.push(provider);
    for (const entry of configured) {
      if (entry.provider !== provider || available.has(entry.id)) continue;
      result.unknown.push({ ...entry, message: unknownModelIdMessage(entry) });
    }
  }
  return result;
}

/**
 * Runs the preflight and logs one line per unknown id and per warning. Meant to be started
 * without awaiting at server startup; it resolves (never rejects) once logging is done.
 */
export async function logModelIdPreflight(
  options: ModelIdPreflightOptions & { logger?: Pick<Console, "warn"> } = {},
): Promise<ModelIdPreflightResult | null> {
  const logger = options.logger ?? console;
  try {
    const result = await checkConfiguredModelIds(options);
    for (const entry of result.unknown) logger.warn(`[models] ${entry.message}`);
    for (const warning of result.warnings) logger.warn(`[models] ${warning}`);
    return result;
  } catch (error) {
    logger.warn(`[models] model id check failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
