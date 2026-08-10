import dotenv from 'dotenv';
import { runAgent } from '../src/services/agent.ts';

dotenv.config({ path: '.env.local' });
dotenv.config();

async function run() {
  console.log("=== Testing runAgent on BJAK Technical Product Manager ===");
  console.log(`GEMINI_API_KEY: ${process.env.GEMINI_API_KEY ? 'SET' : 'MISSING'}`);
  console.log(`OPENAI_API_KEY: ${process.env.OPENAI_API_KEY ? 'SET' : 'MISSING'}`);
  console.log(`KIMI_API_KEY: ${process.env.KIMI_API_KEY ? 'SET' : 'MISSING'}`);
  
  const evalQuery = `Evaluate job advertisement: "Technical Product Manager" at "BJAK". 
  Location: Singapore (Hybrid). 
  Salary Range: SGD 8,000 - SGD 12,000. 
  Description: About BJAK. BJAK is building a Neobank Superapp for Southeast Asia. We are looking for a hands-on TPM who loves building next-generation products.`;

  try {
    const res = await runAgent(evalQuery);
    console.log("\n=== Success! Result: ===");
    console.log(JSON.stringify(res.result, null, 2));
    console.log("\n=== Trace: ===");
    res.trace.forEach(t => console.log(`- ${t}`));
  } catch (err: any) {
    console.error(`\n❌ runAgent failed: ${err.message || err}`);
    if (err.stack) console.error(err.stack);
  }
}

run();
