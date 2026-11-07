/**
 * Gemini backend selection: Google AI Studio (API key) or Vertex AI (Application Default
 * Credentials). Every "is Gemini usable?" check goes through isGeminiConfigured() so a Vertex
 * deployment without any AI Studio key is treated as configured.
 *
 * Nothing here reads or logs secret values beyond deciding whether they are present.
 */

export type GeminiBackend = "studio" | "vertex";

/** Which credentials a call may use. "document" lets manual document generation use its own key. */
export type GeminiCredentialScope = "default" | "document";

export const PLACEHOLDER_GEMINI_API_KEY = "MY_GEMINI_API_KEY";
export const DEFAULT_VERTEX_LOCATION = "global";

export type GeminiClientConfig =
  | { backend: "studio"; apiKey: string; apiVersion: string | undefined; keySource: string }
  | { backend: "vertex"; project: string; location: string };

export class GeminiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiConfigError";
  }
}

function clean(value: string | undefined): string {
  return String(value ?? "").trim();
}

function usableKey(value: string | undefined): string | null {
  const key = clean(value);
  if (!key || key === PLACEHOLDER_GEMINI_API_KEY) return null;
  return key;
}

/** GEMINI_BACKEND: "vertex" or "studio" (default). Any other value is a configuration error. */
export function geminiBackend(env: NodeJS.ProcessEnv = process.env): GeminiBackend {
  const raw = clean(env.GEMINI_BACKEND).toLowerCase();
  if (raw === "" || raw === "studio") return "studio";
  if (raw === "vertex") return "vertex";
  throw new GeminiConfigError(`GEMINI_BACKEND must be "studio" or "vertex" (got "${raw.slice(0, 40)}").`);
}

/**
 * The Vertex location. "global" is the default and the only accepted value unless
 * GEMINI_ALLOW_REGIONAL_LOCATION=true: the global endpoint draws on Google's shared capacity
 * across regions (fewer 429s), is required for Flex PayGo, and is where new Gemini models appear
 * first. A single region is accepted only as an explicit, documented override.
 */
export function vertexLocation(env: NodeJS.ProcessEnv = process.env): string {
  const location = clean(env.GOOGLE_CLOUD_LOCATION) || DEFAULT_VERTEX_LOCATION;
  if (location === DEFAULT_VERTEX_LOCATION) return location;
  if (clean(env.GEMINI_ALLOW_REGIONAL_LOCATION).toLowerCase() === "true") return location;
  throw new GeminiConfigError(
    `GOOGLE_CLOUD_LOCATION="${location.slice(0, 40)}" is a regional Vertex endpoint. Use "global" ` +
      "(the default) or set GEMINI_ALLOW_REGIONAL_LOCATION=true to accept a single region deliberately.",
  );
}

function studioKey(env: NodeJS.ProcessEnv, scope: GeminiCredentialScope): { key: string; source: string } | null {
  if (scope === "document") {
    const documentKey = usableKey(env.DOCUMENT_GEMINI_API_KEY);
    if (documentKey) return { key: documentKey, source: "DOCUMENT_GEMINI_API_KEY" };
  }
  const key = usableKey(env.GEMINI_API_KEY);
  if (key) return { key, source: "GEMINI_API_KEY" };
  const flashKey = usableKey(env.GEMINI_FLASH_API_KEY);
  if (flashKey) return { key: flashKey, source: "GEMINI_FLASH_API_KEY" };
  return null;
}

/** Why Gemini cannot be used with this environment, or null when it can. Never includes secrets. */
export function geminiConfigProblem(
  env: NodeJS.ProcessEnv = process.env,
  scope: GeminiCredentialScope = "default",
): string | null {
  let backend: GeminiBackend;
  try {
    backend = geminiBackend(env);
  } catch (error) {
    return (error as Error).message;
  }
  if (backend === "vertex") {
    if (!clean(env.GOOGLE_CLOUD_PROJECT)) {
      return "GEMINI_BACKEND=vertex requires GOOGLE_CLOUD_PROJECT.";
    }
    try {
      vertexLocation(env);
    } catch (error) {
      return (error as Error).message;
    }
    return null;
  }
  return studioKey(env, scope) ? null : "GEMINI_API_KEY is not configured.";
}

/** True when a Gemini call can be made: an AI Studio key, or a complete Vertex configuration. */
export function isGeminiConfigured(
  env: NodeJS.ProcessEnv = process.env,
  scope: GeminiCredentialScope = "default",
): boolean {
  return geminiConfigProblem(env, scope) === null;
}

/** The client configuration for this environment; throws GeminiConfigError when incomplete. */
export function resolveGeminiClientConfig(
  env: NodeJS.ProcessEnv = process.env,
  scope: GeminiCredentialScope = "default",
): GeminiClientConfig {
  const problem = geminiConfigProblem(env, scope);
  if (problem) throw new GeminiConfigError(`${problem} Gemini cannot be called.`);
  if (geminiBackend(env) === "vertex") {
    return { backend: "vertex", project: clean(env.GOOGLE_CLOUD_PROJECT), location: vertexLocation(env) };
  }
  const key = studioKey(env, scope)!;
  return {
    backend: "studio",
    apiKey: key.key,
    apiVersion: clean(env.GEMINI_API_VERSION) || undefined,
    keySource: key.source,
  };
}
