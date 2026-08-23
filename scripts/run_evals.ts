import fs from "fs";
import path from "path";
import * as yaml from "js-yaml";
import dotenv from "dotenv";
import { runAgent } from "../src/services/agent.ts";
import { db } from "../src/db/db.ts";

// Load environment variables
dotenv.config();

interface Assertion {
  type: "valid_json" | "must_contain" | "must_not_contain" | "min_score" | "max_score";
  value?: any;
}

interface GoldenQuestion {
  id: number;
  input: string;
  assertions: Assertion[];
}

async function runEvals() {
  console.log("====================================================");
  console.log("            AI DECISION ENGINE EVAL HARNESS         ");
  console.log("====================================================");

  // Check API Key
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "MY_GEMINI_API_KEY" || apiKey.trim() === "") {
    console.error("❌ ERROR: GEMINI_API_KEY is not configured.");
    console.error("   Cannot run LLM evaluations without a valid API key.");
    console.error("   Configure your key in Secrets first.");
    process.exit(1);
  }

  // Load Golden Questions
  const yamlPath = path.join(process.cwd(), "golden_questions.yaml");
  if (!fs.existsSync(yamlPath)) {
    console.error(`❌ ERROR: Golden questions file not found at ${yamlPath}`);
    process.exit(1);
  }

  const questions = yaml.load(fs.readFileSync(yamlPath, "utf-8")) as GoldenQuestion[];
  console.log(`Loaded ${questions.length} golden questions. Beginning evaluation run...\n`);

  // Reset database to ensure predictable state
  await db.resetToDefaults();

  const results: Array<{ id: number; question: string; status: "PASS" | "FAIL"; errors: string[] }> = [];
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  let index = 0;
  for (const q of questions) {
    if (index > 0) {
      console.log("Waiting 12 seconds to avoid Gemini Free Tier RPM limits (5 requests/min)...");
      await delay(12000);
    }
    index++;
    
    console.log(`[Eval ${q.id}/10] Question: "${q.input}"`);
    const errors: string[] = [];

    try {
      // Call the live agent core loop
      const response = await runAgent(q.input);
      const resultObj = response.result;
      const resultStr = JSON.stringify(resultObj);

      // Verify each assertion
      for (const ast of q.assertions) {
        if (ast.type === "valid_json") {
          if (!resultObj || typeof resultObj !== "object") {
            errors.push("Assertion failed: Output is not a valid JSON object.");
          }
        } else if (ast.type === "must_contain") {
          const val = String(ast.value).toLowerCase();
          if (!resultStr.toLowerCase().includes(val)) {
            errors.push(`Assertion failed: Expected output to contain string "${ast.value}".`);
          }
        } else if (ast.type === "must_not_contain") {
          const val = String(ast.value).toLowerCase();
          if (resultStr.toLowerCase().includes(val)) {
            errors.push(`Assertion failed: Expected output to NOT contain string "${ast.value}".`);
          }
        } else if (ast.type === "min_score") {
          const targetMin = Number(ast.value);
          const maxScoreInResponse = Math.max(...(resultObj.evaluated_jobs?.map(j => j.core_fit_score || 0) || [0]));
          if (maxScoreInResponse < targetMin) {
            errors.push(`Assertion failed: Expected at least one job with score >= ${targetMin}, but max was ${maxScoreInResponse}.`);
          }
        } else if (ast.type === "max_score") {
          const targetMax = Number(ast.value);
          const maxScoreInResponse = Math.max(...(resultObj.evaluated_jobs?.map(j => j.core_fit_score || 0) || [0]));
          if (maxScoreInResponse > targetMax) {
            errors.push(`Assertion failed: Expected all jobs to have score <= ${targetMax}, but max was ${maxScoreInResponse}.`);
          }
        }
      }
    } catch (err: any) {
      errors.push(`Execution error: ${err.message || err}`);
    }

    const status = errors.length === 0 ? "PASS" : "FAIL";
    results.push({ id: q.id, question: q.input, status, errors });

    if (status === "PASS") {
      console.log(`🟢 PASS\n`);
    } else {
      console.log(`🔴 FAIL`);
      errors.forEach(e => console.log(`   - ${e}`));
      console.log("");
    }
  }

  // Print scorecard
  console.log("====================================================");
  console.log("                EVALUATION SCORECARD                ");
  console.log("====================================================");
  let passes = 0;
  results.forEach(r => {
    const icon = r.status === "PASS" ? "🟢" : "🔴";
    if (r.status === "PASS") passes++;
    console.log(`${icon} Eval #${r.id}: ${r.status.padEnd(4)} | "${r.question.substring(0, 45)}..."`);
  });

  const finalScore = (passes / results.length) * 100;
  console.log("----------------------------------------------------");
  console.log(`TOTAL SCORE: ${passes}/${results.length} (${finalScore}%)`);
  console.log("====================================================");

  if (passes === results.length) {
    console.log("🎉 SUCCESS: All golden questions passed their assertions!");
    process.exit(0);
  } else {
    console.error("⚠️  WARNING: Some assertions failed. Review the LLM output logic.");
    process.exit(1);
  }
}

runEvals().catch(err => {
  console.error("Fatal exception in eval runner:", err);
  process.exit(1);
});
