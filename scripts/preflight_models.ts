import dotenv from "dotenv";

dotenv.config();
dotenv.config({ path: ".env.local", override: true });

async function main(): Promise<void> {
  const { preflightModelRoutes } = await import("../src/services/agent.js");
  const { assertQuotedRequirementProviderSchemaCompatible } = await import("../src/requirements/quotedProvider.js");
  assertQuotedRequirementProviderSchemaCompatible();

  const stageArg = process.argv.find((arg) => arg.startsWith("--stage="))?.split("=")[1] || "all";
  const requireExtraction = process.argv.includes("--require-extraction");

  const result = await preflightModelRoutes();
  console.log("Model preflight:", JSON.stringify(result, null, 2));

  const quotedRequirementsEnabled = process.env.REQUIREMENTS_ENABLE_QUOTED === "true";

  if (!result.embedding) {
    console.warn("Embedding routes are unavailable. Semantic matching will record pending UNKNOWN state.");
  }

  if (quotedRequirementsEnabled && !result.extraction) {
    console.warn("Quoted requirement extraction route is unavailable. Pipeline will proceed with deterministic extraction.");
    if (requireExtraction) {
      throw new Error("Quoted extraction route is strictly required but unavailable.");
    }
  }

  if (stageArg === "evaluations" && !result.evaluation) {
    throw new Error("Evaluation route is required for evaluation stage but unavailable.");
  }

  // Backlog and deterministic drains can proceed with deterministic stages even if external models are temporarily down
  if (stageArg === "all" && !result.evaluation && !result.embedding) {
    if (process.argv.includes("--strict")) {
      throw new Error(
        "No usable model routes available (evaluation and embedding routes failed). Operational models required."
      );
    }
    console.warn(
      "No usable model routes available (evaluation and embedding routes failed). Proceeding with deterministic pipeline stages only."
    );
  }
}

main().catch((error) => {
  console.error("Model preflight failed:", error.message || error);
  process.exit(1);
});
