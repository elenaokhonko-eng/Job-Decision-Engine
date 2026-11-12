import { createServer, type Server } from "node:http";
import express from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createSetupRouter } from "../../api/v2/setupRouter.js";
import {
  authorizeProviderCall,
  listProviderModels,
  ProviderBaseUrlError,
  resolveProviderBaseUrl,
} from "../../services/aiProviders.js";

/**
 * A stored API key must never be sent to a URL chosen by the caller.
 *
 * `/setup/ai/test` and `/setup/routes` both fall back to the server's
 * environment key when the request has no `apiKey`, and both accepted a
 * `baseUrl` from the request body. Together that let any authenticated caller
 * POST `{ provider, baseUrl: "https://attacker.example" }` and receive the
 * stored key at a host they controlled — for Gemini, in the query string.
 */
describe("provider base URL authorization", () => {
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  let server: Server;
  let baseUrl: string;
  const outbound: string[] = [];

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/v2/setup", createSetupRouter({}));
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;

    // Record anything that leaves the process so "no outbound call" is asserted
    // rather than assumed.
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input?.url ?? String(input);
      if (!url.startsWith(baseUrl)) outbound.push(url);
      return realFetch(input, init);
    });
  });

  afterEach(() => {
    outbound.length = 0;
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (originalGeminiKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = originalGeminiKey;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function postAiTest(payload: Record<string, unknown>): Promise<{ status: number; body: any }> {
    const response = await fetch(`${baseUrl}/api/v2/setup/ai/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }

  it("refuses a custom baseUrl without an apiKey, without calling out", async () => {
    process.env.GEMINI_API_KEY = "server-held-key";

    const { status, body } = await postAiTest({
      provider: "gemini",
      baseUrl: "https://attacker.example",
    });

    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/apiKey/);
    expect(outbound).toEqual([]);
  });

  it("refuses plain HTTP to a non-loopback host, without calling out", async () => {
    const { status, body } = await postAiTest({
      provider: "gemini",
      apiKey: "caller-key",
      baseUrl: "http://attacker.example",
    });

    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/https/);
    expect(outbound).toEqual([]);
  });

  it("keeps honouring the stored key against the configured base URL", async () => {
    const authorization = authorizeProviderCall({
      serverApiKey: "server-held-key",
      bodyApiKey: "",
      bodyBaseUrl: "",
    });

    expect(authorization.ok).toBe(true);
    expect(authorization.apiKey).toBe("server-held-key");
    expect(authorization.baseUrl).toBeUndefined();
  });

  it("uses the caller's key, never the stored one, when a baseUrl is supplied", () => {
    const authorization = authorizeProviderCall({
      serverApiKey: "server-held-key",
      bodyApiKey: "caller-key",
      bodyBaseUrl: "https://gateway.example/v1",
    });

    expect(authorization.ok).toBe(true);
    expect(authorization.apiKey).toBe("caller-key");
    expect(authorization.baseUrl).toBe("https://gateway.example/v1");
  });

  it("allows http on loopback so Ollama and LM Studio still work", () => {
    const authorization = authorizeProviderCall({
      serverApiKey: "server-held-key",
      bodyApiKey: "local",
      bodyBaseUrl: "http://127.0.0.1:11434/v1/",
    });

    expect(authorization.ok).toBe(true);
    expect(authorization.baseUrl).toBe("http://127.0.0.1:11434/v1");
  });

  it("rejects a disallowed base URL before any network access", async () => {
    const fetchImpl = vi.fn();

    await expect(
      listProviderModels({
        provider: "openai",
        apiKey: "caller-key",
        baseUrl: "http://attacker.example/v1",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toBeInstanceOf(ProviderBaseUrlError);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("strips trailing slashes without a backtracking regex", () => {
    // A long run of slashes is what makes /\/+$/ polynomial.
    const slashes = "/".repeat(20000);
    expect(resolveProviderBaseUrl("openai", `https://gateway.example${slashes}`)).toBe(
      "https://gateway.example"
    );
  });
});
