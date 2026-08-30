import { callLLM, generateContent } from "./agent.js";
import { OpenAI } from "openai";

/** Helper to call OpenAI as the final fallback */
async function callOpenAI(raw: string, schema?: any): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set – cannot use OpenAI fallback.");
  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const client = new OpenAI({ apiKey });
  
  const payload: any = {
    model,
    messages: [{ role: "user", content: raw }],
    temperature: 0,
  };

  if (schema) {
    payload.response_format = {
      type: "json_schema",
      json_schema: { name: "extraction", strict: true, schema }
    };
  } else {
    payload.response_format = { type: "json_object" };
  }

  const response = await client.chat.completions.create(payload);
  return response.choices[0].message?.content ?? "";
}

/**
 * Try Ollama → Gemini → OpenAI for extraction.
 * Returns the extracted JSON string (or throws if all providers fail).
 */
export async function extractWithFallback(raw: string, schema?: any): Promise<string> {
  // 1️⃣ Ollama (local)
  try {
    let ollamaRes = await callLLM("extract", raw, { schema });
    
    // Robust JSON extraction: find the first { or [ and last } or ]
    const firstBrace = ollamaRes.indexOf('{');
    const firstBracket = ollamaRes.indexOf('[');
    const lastBrace = ollamaRes.lastIndexOf('}');
    const lastBracket = ollamaRes.lastIndexOf(']');
    
    let startIndex = -1;
    let endIndex = -1;
    
    if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
      startIndex = firstBrace;
      endIndex = lastBrace;
    } else if (firstBracket !== -1) {
      startIndex = firstBracket;
      endIndex = lastBracket;
    }
    
    if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
      ollamaRes = ollamaRes.substring(startIndex, endIndex + 1);
    }
    
    JSON.parse(ollamaRes); // Validate
    return ollamaRes;
  } catch (e) {
    console.warn("Ollama extraction failed or returned invalid JSON, falling back to Gemini:", e);
  }

  // 2️⃣ Gemini (requires GEMINI_API_KEY)
  try {
    let geminiRes = await generateContent({
      model: process.env.GEMINI_MODEL || "gemini-2.0-flash",
      contents: raw,
      responseMimeType: "application/json",
      responseSchema: schema
    });
    if (geminiRes.startsWith("```json")) {
      geminiRes = geminiRes.replace(/^```json\s*/, "").replace(/\s*```$/, "");
    } else if (geminiRes.startsWith("```")) {
      geminiRes = geminiRes.replace(/^```\s*/, "").replace(/\s*```$/, "");
    }
    JSON.parse(geminiRes); // Validate
    return geminiRes;
  } catch (e) {
    console.warn("Gemini extraction failed or returned invalid JSON, falling back to OpenAI:", e);
  }

  // 3️⃣ OpenAI (requires OPENAI_API_KEY)
  try {
    let openAIRes = await callOpenAI(raw, schema);
    if (openAIRes.startsWith("```json")) {
      openAIRes = openAIRes.replace(/^```json\s*/, "").replace(/\s*```$/, "");
    } else if (openAIRes.startsWith("```")) {
      openAIRes = openAIRes.replace(/^```\s*/, "").replace(/\s*```$/, "");
    }
    JSON.parse(openAIRes); // Validate
    return openAIRes;
  } catch (e) {
    console.error("All extraction providers failed:", e);
    throw new Error("Extraction failed on all providers");
  }
}
