import { callLLM, generateContent } from "./agent.js";
import { OpenAI } from "openai";

/** Helper to call OpenAI as the final fallback */
async function callOpenAI(raw: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set – cannot use OpenAI fallback.");
  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const client = new OpenAI({ apiKey });
  const response = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: raw }],
    temperature: 0,
  });
  return response.choices[0].message?.content ?? "";
}

/**
 * Try Ollama → Gemini → OpenAI for extraction.
 * Returns the extracted JSON string (or throws if all providers fail).
 */
export async function extractWithFallback(raw: string): Promise<string> {
  // 1️⃣ Ollama (local)
  try {
    const ollamaRes = await callLLM("extract", raw);
    return ollamaRes;
  } catch (e) {
    console.warn("Ollama extraction failed, falling back to Gemini:", e);
  }

  // 2️⃣ Gemini (requires GEMINI_API_KEY)
  try {
    const geminiRes = await generateContent({
      model: "gemini-2.0-flash",
      contents: raw,
      responseMimeType: "application/json"
    });
    return geminiRes;
  } catch (e) {
    console.warn("Gemini extraction failed, falling back to OpenAI:", e);
  }

  // 3️⃣ OpenAI (requires OPENAI_API_KEY)
  try {
    return await callOpenAI(raw);
  } catch (e) {
    console.error("All extraction providers failed:", e);
    throw new Error("Extraction failed on all providers");
  }
}
