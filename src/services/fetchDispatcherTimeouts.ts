/**
 * Long-request support for Node's built-in fetch.
 *
 * `@google/genai` sends requests with the global `fetch`, which Node backs with undici. undici's
 * default dispatcher stops waiting for response headers after 300 s (headersTimeout) and between
 * body chunks after 300 s (bodyTimeout), whatever AbortSignal or SDK `httpOptions.timeout` the
 * request carries. A Vertex Flex PayGo request may legitimately wait 10 minutes or more before the
 * response starts, so without this a 600 s Flex timeout would end at 300 s with "fetch failed"
 * (cause UND_ERR_HEADERS_TIMEOUT). The SDK tries to raise these limits itself, but on Node 22/24
 * the global Agent keeps them on per-origin clients it creates later, so that attempt has no effect.
 *
 * ensureFetchDispatcherTimeouts(ms) replaces Node's global dispatcher with a new instance of the
 * same Agent class whose headers/body timeouts are at least `ms`. Request-level timeouts
 * (AbortSignal.timeout, the SDK timeout) still end every request; this only removes the hidden
 * 300 s ceiling. It never shortens a timeout and never replaces a dispatcher it does not recognise
 * (for example a proxy agent installed by the operator).
 */

const GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.1");

export type DispatcherTimeoutOutcome = "ALREADY_SUFFICIENT" | "REPLACED" | "UNSUPPORTED";

let ensuredTimeoutMs = 0;

type AgentConstructor = new (options: { headersTimeout: number; bodyTimeout: number }) => unknown;

function globalDispatcher(): unknown {
  return (globalThis as Record<PropertyKey, unknown>)[GLOBAL_DISPATCHER];
}

async function createDefaultDispatcher(): Promise<void> {
  // Node creates its global dispatcher lazily inside the first fetch. A fetch with an already
  // aborted signal creates it and rejects with AbortError without opening any connection.
  try {
    await fetch("http://127.0.0.1/", { signal: AbortSignal.abort() });
  } catch (error) {
    if ((error as { name?: unknown } | null)?.name !== "AbortError") throw error;
  }
}

/** Makes sure the global fetch dispatcher allows requests that wait at least `minTimeoutMs`. */
export async function ensureFetchDispatcherTimeouts(minTimeoutMs: number): Promise<DispatcherTimeoutOutcome> {
  if (!Number.isFinite(minTimeoutMs) || minTimeoutMs <= 0) {
    throw new RangeError("ensureFetchDispatcherTimeouts needs a positive timeout.");
  }
  const timeoutMs = Math.ceil(minTimeoutMs);
  if (ensuredTimeoutMs >= timeoutMs) return "ALREADY_SUFFICIENT";
  if (!globalDispatcher()) await createDefaultDispatcher();
  const current = globalDispatcher() as { constructor?: unknown } | undefined;
  const Agent = current?.constructor as (AgentConstructor & { name?: string }) | undefined;
  if (!current || typeof Agent !== "function" || Agent.name !== "Agent") {
    console.warn(
      "[model:gemini] The global fetch dispatcher is not Node's default Agent; long Flex requests are " +
        "limited by that dispatcher's own headers/body timeouts.",
    );
    return "UNSUPPORTED";
  }
  (globalThis as Record<PropertyKey, unknown>)[GLOBAL_DISPATCHER] = new Agent({
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  });
  ensuredTimeoutMs = timeoutMs;
  return "REPLACED";
}

/** Tests only: forget what was ensured so the next call inspects the dispatcher again. */
export function resetFetchDispatcherTimeoutsForTests(): void {
  ensuredTimeoutMs = 0;
}
