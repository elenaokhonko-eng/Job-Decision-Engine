import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../services/agent.js", () => ({
  checkModelRegistryPreflight: vi.fn(),
  generateContentAudited: vi.fn(),
  MODEL_REGISTRY: { DOCUMENT_PRIMARY_MODEL: "document-model", EXTRACTION_GEMINI_MODEL: "extraction-gemini", DOCUMENT_SECONDARY_GEMINI_MODEL: "document-secondary" },
}));

import { generateContentAudited } from "../../services/agent.js";
import { writeCoverLetterWithModel, writeSummaryWithModel } from "../../documents/manualCoverLetter.js";

const mockedGenerate = vi.mocked(generateContentAudited);
const ENV_KEYS = ["MANUAL_SUMMARY_TIMEOUT_MS", "MANUAL_COVER_LETTER_TIMEOUT_MS", "DOCUMENT_SECONDARY_GEMINI_MODEL"] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const input = { title: "Role", company: "Example", pairs: [], allowedEvidence: [], requirements: [], uncoveredMust: [], jobDescriptionExcerpt: "" };

/** The writers' own parsing is covered in manualCoverLetter.test.ts; stop right after the call. */
async function callOptions(write: () => Promise<unknown>): Promise<Record<string, unknown>> {
  mockedGenerate.mockRejectedValueOnce(new Error("stop after capturing options"));
  await expect(write()).rejects.toThrow("stop after capturing options");
  return mockedGenerate.mock.calls.at(-1)![0] as unknown as Record<string, unknown>;
}

describe("manual document writers pass their own model-call settings", () => {
  afterEach(() => {
    mockedGenerate.mockReset();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("uses 45 s for the summary, 90 s for the letter, 2 attempts, the document secondary model, interactive mode and the document key scope by default", async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const summary = await callOptions(() => writeSummaryWithModel(input as any));
    expect(summary).toMatchObject({
      routeKey: "manual_cv_summary", timeoutMs: 45000, maxRetries: 2, secondaryGeminiModel: "document-secondary",
      interactive: true, geminiCredentialScope: "document",
    });
    const letter = await callOptions(() => writeCoverLetterWithModel(input as any));
    expect(letter).toMatchObject({
      routeKey: "manual_cover_letter", timeoutMs: 90000, maxRetries: 2, secondaryGeminiModel: "document-secondary",
      interactive: true, geminiCredentialScope: "document",
    });
  });

  it("reads the timeout env vars (clamped to 5..300 s) and DOCUMENT_SECONDARY_GEMINI_MODEL", async () => {
    process.env.MANUAL_SUMMARY_TIMEOUT_MS = "1000";
    process.env.MANUAL_COVER_LETTER_TIMEOUT_MS = "999999";
    process.env.DOCUMENT_SECONDARY_GEMINI_MODEL = "gemini-secondary";
    expect(await callOptions(() => writeSummaryWithModel(input as any))).toMatchObject({ timeoutMs: 5000, secondaryGeminiModel: "gemini-secondary" });
    expect(await callOptions(() => writeCoverLetterWithModel(input as any))).toMatchObject({ timeoutMs: 300000 });

    process.env.MANUAL_SUMMARY_TIMEOUT_MS = "not-a-number";
    process.env.MANUAL_COVER_LETTER_TIMEOUT_MS = "120000";
    expect(await callOptions(() => writeSummaryWithModel(input as any))).toMatchObject({ timeoutMs: 45000 });
    expect(await callOptions(() => writeCoverLetterWithModel(input as any))).toMatchObject({ timeoutMs: 120000 });
  });
});
