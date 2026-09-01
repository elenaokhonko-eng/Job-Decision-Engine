import dotenv from "dotenv";

dotenv.config();
dotenv.config({ path: ".env.local", override: true });

async function main(): Promise<void> {
  const { preflightModelRoutes } = await import("../src/services/agent.js");
  const result = await preflightModelRoutes();
  console.log("Model preflight:", JSON.stringify(result, null, 2));
  if (!result.evaluation || !result.embedding) {
    throw new Error("No usable evaluation or embedding route. Source ingestion was not started.");
  }
}

main().catch((error) => {
  console.error("Model preflight failed:", error.message || error);
  process.exit(1);
});
