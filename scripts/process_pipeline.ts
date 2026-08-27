import { runNormalization } from "../src/pipeline/normalize.js";
import { runHardGates } from "../src/pipeline/hardGate.js";
import { runLaneRouting } from "../src/pipeline/laneRouter.js";
import { runEvaluationBudgeter } from "../src/pipeline/evaluationBudgeter.js";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config();
dotenv.config({ path: ".env.local" });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && (process.env.DATABASE_URL.includes("localhost") || process.env.DATABASE_URL.includes("127.0.0.1")) ? false : { rejectUnauthorized: false }
});

const LOCK_ID = 1001; // Arbitrary ID for pipeline lock

async function processPipeline() {
  console.log("====================================================");
  console.log("         STAGE 0: DISCOVERY (PROCESS PIPELINE)      ");
  console.log("====================================================");

  const client = await pool.connect();
  try {
    // Attempt to acquire an exclusive session-level advisory lock
    const { rows } = await client.query(`SELECT pg_try_advisory_lock($1) as locked`, [LOCK_ID]);
    if (!rows[0].locked) {
      console.log("⚠️ Another instance of the pipeline is currently running. Exiting.");
      process.exit(0);
    }
    
    await runNormalization();
    await runHardGates();
    await runLaneRouting();
    await runEvaluationBudgeter();
    
    console.log("\n✅ Pipeline execution completed successfully.");
  } catch (err: any) {
    console.error("❌ Pipeline execution failed:", err.message);
  } finally {
    await client.query(`SELECT pg_advisory_unlock($1)`, [LOCK_ID]);
    client.release();
    await pool.end();
  }
  process.exit(0);
}

processPipeline();
