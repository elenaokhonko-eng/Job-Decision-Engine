import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_OPENAI_BASE_URL,
  OpenAiBaseUrlError,
  parseOpenAiBaseUrl,
  resolveOpenAiBaseUrl,
} from "../../../platform/config/index.js";
import { checkConfiguredModelIds } from "../../../services/modelIdPreflight.js";

describe("resolveOpenAiBaseUrl", () => {
  it("defaults to the official endpoint when the variable is unset or blank", () => {
    expect(resolveOpenAiBaseUrl({})).toBe(DEFAULT_OPENAI_BASE_URL);
    expect(resolveOpenAiBaseUrl({ OPENAI_BASE_URL: "   " })).toBe(DEFAULT_OPENAI_BASE_URL);
  });

  it("uses the configured endpoint and strips trailing slashes", () => {
    expect(resolveOpenAiBaseUrl({ OPENAI_BASE_URL: "https://openrouter.ai/api/v1///" })).toBe("https://openrouter.ai/api/v1");
  });

  it("accepts plain http on loopback (Ollama, LM Studio)", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]", "model.localhost"]) {
      expect(resolveOpenAiBaseUrl({ OPENAI_BASE_URL: `http://${host}:11434/v1` })).toContain("11434/v1");
    }
  });

  it("rejects plain http off loopback unless the operator opts in", () => {
    const env = { OPENAI_BASE_URL: "http://gateway.internal:8000/v1" };
    expect(() => resolveOpenAiBaseUrl(env)).toThrow(OpenAiBaseUrlError);
    expect(resolveOpenAiBaseUrl({ ...env, OPENAI_ALLOW_INSECURE_BASE_URL: "true" })).toBe("http://gateway.internal:8000/v1");
  });

  it("rejects other schemes, credentials, query strings and fragments, without echoing the URL", () => {
    const cases = [
      "ftp://example.com/v1",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://user:hunter2@example.com/v1",
      "https://example.com/v1?key=hunter2",
      "https://example.com/v1#frag",
      "not a url",
    ];
    for (const value of cases) {
      let message = "";
      try {
        parseOpenAiBaseUrl(value);
      } catch (error) {
        expect(error).toBeInstanceOf(OpenAiBaseUrlError);
        message = (error as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain("hunter2");
      expect(message).not.toContain(value);
    }
  });

  it("an invalid value is an error, never a silent fall back to the official endpoint", () => {
    expect(() => resolveOpenAiBaseUrl({ OPENAI_BASE_URL: "ftp://example.com" })).toThrow(OpenAiBaseUrlError);
  });

  it("trims a very long run of slashes in linear time", () => {
    const started = Date.now();
    expect(resolveOpenAiBaseUrl({ OPENAI_BASE_URL: `https://example.com/v1${"/".repeat(200_000)}` })).toBe("https://example.com/v1");
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("OpenAI-protocol calls follow the configured endpoint", () => {
  it("the model-id preflight lists models from OPENAI_BASE_URL, not from api.openai.com", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ data: [{ id: "gpt-5.6-luna" }] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    await checkConfiguredModelIds({
      env: { OPENAI_API_KEY: "sk-test-not-real", OPENAI_BASE_URL: "http://127.0.0.1:11434/v1" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(seen).toEqual(["http://127.0.0.1:11434/v1/models"]);
  });

  it("an invalid OPENAI_BASE_URL becomes a key-free warning in the preflight and sends no request", async () => {
    const fetchImpl = vi.fn();
    const result = await checkConfiguredModelIds({
      env: { OPENAI_API_KEY: "sk-test-not-real", OPENAI_BASE_URL: "https://u:p@example.com/v1" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.warnings.join(" ")).toContain("OPENAI_BASE_URL");
    expect(result.warnings.join(" ")).not.toContain("sk-test-not-real");
  });
});
