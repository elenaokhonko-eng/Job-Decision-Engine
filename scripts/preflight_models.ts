import dotenv from "dotenv";

dotenv.config();
dotenv.config({ path: ".env.local", override: true });

async function main(): Promise<void> {
  const { preflightModelRoutes } = await import("../src/services/agent.js");
  const { assertQuotedRequirementProviderSchemaCompatible } = await import("../src/requirements/quotedProvider.js");
  assertQuotedRequirementProviderSchemaCompatible();

  const result = await preflightModelRoutes();
  console.log("Model preflight:", JSON.stringify(result, null, 2));
  const quotedRequirementsEnabled = process.env.REQUIREMENTS_ENABLE_QUOTED === "true";
  if (!result.evaluation || !result.embedding || (quotedRequirementsEnabled && !result.extraction)) {
    throw new Error(
      "No usable required model route. Source ingestion was not started."
    );
  }
}

main().catch((error) => {
  console.error("Model preflight failed:", error.message || error);
  process.exit(1);
});
