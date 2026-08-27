import { runNormalization } from "../src/pipeline/normalize.js";
import { runHardGates } from "../src/pipeline/hardGate.js";
import { runLaneRouting } from "../src/pipeline/laneRouter.js";
import { runEvaluationBudgeter } from "../src/pipeline/evaluationBudgeter.js";

async function processPipeline() {
  console.log("====================================================");
  console.log("         STAGE 0: DISCOVERY (PROCESS PIPELINE)      ");
  console.log("====================================================");

  try {
    await runNormalization();
    await runHardGates();
    await runLaneRouting();
    await runEvaluationBudgeter();
    
    console.log("\n✅ Pipeline execution completed successfully.");
  } catch (err: any) {
    console.error("❌ Pipeline execution failed:", err.message);
  }
  process.exit(0);
}

processPipeline();
