import { afterEach, describe, expect, it, vi } from "vitest";

const saved = { key: process.env.OPENAI_API_KEY, base: process.env.OPENAI_BASE_URL };

afterEach(() => {
  vi.unstubAllGlobals();
  if (saved.key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved.key;
  if (saved.base === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = saved.base;
});

function embeddingsFetch(urls: string[]): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("OpenAI embeddings follow OPENAI_BASE_URL", () => {
  it("calls the configured endpoint", async () => {
    process.env.OPENAI_API_KEY = "sk-test-not-real";
    process.env.OPENAI_BASE_URL = "http://127.0.0.1:11434/v1/";
    const urls: string[] = [];
    vi.stubGlobal("fetch", embeddingsFetch(urls));
    const { generateEmbeddingsWithProviderAndModel } = await import("../../../services/agent.js");

    const outcomes = await generateEmbeddingsWithProviderAndModel(["hello"], "openai", "text-embedding-3-small");

    expect(urls).toEqual(["http://127.0.0.1:11434/v1/embeddings"]);
    expect(outcomes[0]?.ok).toBe(true);
  });

  it("calls api.openai.com when the variable is unset", async () => {
    process.env.OPENAI_API_KEY = "sk-test-not-real";
    delete process.env.OPENAI_BASE_URL;
    const urls: string[] = [];
    vi.stubGlobal("fetch", embeddingsFetch(urls));
    const { generateEmbeddingsWithProviderAndModel } = await import("../../../services/agent.js");

    await generateEmbeddingsWithProviderAndModel(["hello"], "openai", "text-embedding-3-small");

    expect(urls).toEqual(["https://api.openai.com/v1/embeddings"]);
  });

  it("an invalid OPENAI_BASE_URL fails the embedding and sends nothing", async () => {
    process.env.OPENAI_API_KEY = "sk-test-not-real";
    process.env.OPENAI_BASE_URL = "https://user:pw@example.com/v1";
    const urls: string[] = [];
    vi.stubGlobal("fetch", embeddingsFetch(urls));
    const { generateEmbeddingsWithProviderAndModel } = await import("../../../services/agent.js");

    const outcomes = await generateEmbeddingsWithProviderAndModel(["hello"], "openai", "text-embedding-3-small");

    expect(urls).toEqual([]);
    expect(outcomes[0]?.ok).toBe(false);
  });
});
