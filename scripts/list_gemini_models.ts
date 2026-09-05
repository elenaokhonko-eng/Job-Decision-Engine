import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";

dotenv.config();
dotenv.config({ path: ".env.local", override: true });

function normalizeModelId(modelName: string): string {
  if (modelName.startsWith("models/")) return modelName.slice("models/".length);
  return modelName;
}

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GEMINI_FLASH_API_KEY;
  if (!apiKey || apiKey.trim() === "" || apiKey === "MY_GEMINI_API_KEY") {
    throw new Error(
      "GEMINI_API_KEY is not configured. Set it in .env.local before listing models."
    );
  }

  const apiVersionRaw = (process.env.GEMINI_API_VERSION || "").trim();
  const ai = new GoogleGenAI({
    apiKey,
    apiVersion: apiVersionRaw || undefined,
  });

  const pager = await ai.models.list({ config: { queryBase: true } });

  const models: Array<{
    name: string;
    displayName?: string;
    supportedActions: string[];
  }> = [];

  for await (const model of pager) {
    const name = model.name?.trim();
    if (!name) continue;
    models.push({
      name,
      displayName: model.displayName,
      supportedActions: model.supportedActions || [],
    });
  }

  models.sort((a, b) => a.name.localeCompare(b.name));
  const embeddingModels = models.filter((m) => m.supportedActions.includes("embedContent"));
  const suggestedIds = [
    ...new Set(
      embeddingModels
        .map((m) => normalizeModelId(m.name))
        .filter((id) => id.toLowerCase().includes("embedding"))
    ),
  ];

  console.log(`Gemini API version: ${apiVersionRaw || "(default)"}`);
  console.log(`Total models visible: ${models.length}`);
  console.log(`Models supporting embedContent: ${embeddingModels.length}`);

  if (embeddingModels.length > 0) {
    console.log("\nembedContent-capable models:");
    for (const m of embeddingModels) {
      const actions = m.supportedActions.length ? ` [${m.supportedActions.join(", ")}]` : "";
      const label = m.displayName ? `\t${m.displayName}` : "";
      console.log(`${m.name}${label}${actions}`);
    }
  }

  if (suggestedIds.length > 0) {
    console.log("\nSuggested EMBEDDING_PRIMARY_MODEL values:");
    for (const id of suggestedIds) {
      console.log(`- ${id}`);
    }
  } else {
    console.log(
      "\nNo obvious embedding model IDs found. Pick a model above with supportedActions including embedContent and set EMBEDDING_PRIMARY_MODEL accordingly."
    );
  }
}

main().catch((error) => {
  console.error("Failed to list Gemini models:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});

