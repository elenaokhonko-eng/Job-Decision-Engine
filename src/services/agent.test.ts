import { runAgent } from './agent.ts';
import { db } from '../db/db.ts';

async function testAgent() {
  console.log("Running edge cases against the new evaluation schema...");

  const testCases = [
    {
      name: "Hard Disqualifier - AIA Insurance",
      prompt: "Evaluate this job: Senior Architect at AIA. Requires 5 years experience in Python and architecture."
    },
    {
      name: "Hard Disqualifier - Scrum Master",
      prompt: "Evaluate this job: We are looking for an Agile Scrum Master for our team. Must be highly collaborative."
    },
    {
      name: "Toxic Buzzwords (High Stress / Politics Penalty)",
      prompt: "Evaluate this job: AI Engineer at generic company. Fast-paced, dynamic environment. Must wear many hats and thrive under pressure in a highly matrixed organization."
    },
    {
      name: "Ideal AI Role (Priority Apply)",
      prompt: "Evaluate this job: Senior AI Architect at Bioinformatics Institute. Remote, asynchronous communication, protected focus blocks. Working on LLMs and agentic workflows."
    },
    {
      name: "High Fit, High Risk",
      prompt: "Evaluate this job: Senior AI Engineer at tech company. Excellent salary SGD 25000. Working on ML pipelines. However, fast-paced environment where you must wear many hats and manage stakeholders."
    }
  ];

  for (const tc of testCases) {
    console.log(`\n\n--- Running Test: ${tc.name} ---`);
    try {
      const result = await runAgent(tc.prompt);
      console.log(JSON.stringify(result.result.evaluated_jobs[0], null, 2));
    } catch (e: any) {
      console.error(`Error in test ${tc.name}:`, e.message);
    }
  }

  console.log("\n\nAll tests executed.");
}

testAgent().catch(console.error);
