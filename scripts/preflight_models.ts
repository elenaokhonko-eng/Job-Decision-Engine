import dotenv from "dotenv";
import { preflightModelRoutes } from "../src/services/agent.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

async function main(): Promise<void> {
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
