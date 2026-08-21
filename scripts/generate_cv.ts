import pg from "pg";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { generateContent } from "../src/services/agent.js";
import { generateDocx } from "../src/services/renderers/docx_renderer.js";
import { generatePdf } from "../src/services/renderers/pdf_renderer.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const databaseUrl = process.env.DATABASE_URL;

function cleanJsonResponse(rawText: string) {
  let cleaned = rawText.trim();
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.replace(/^```json\s*/, "").replace(/\s*```$/, "");
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```\s*/, "").replace(/\s*```$/, "");
  }
  return cleaned;
}

async function generateTailoredCV() {
  const jobId = process.argv[2];
  if (!jobId) {
    console.error("❌ ERROR: Job ID must be provided as the first argument.");
    process.exit(1);
  }

  if (!databaseUrl) {
    console.error("❌ ERROR: DATABASE_URL environment variable is missing.");
    process.exit(1);
  }

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("localhost") || databaseUrl.includes("127.0.0.1") ? false : { rejectUnauthorized: false }
  });

  try {
    const jobRes = await pool.query(
      "SELECT title, company_name, raw_description, location FROM jobs WHERE id = $1",
      [jobId]
    );

    if (jobRes.rows.length === 0) {
      console.error(`❌ ERROR: Job with ID ${jobId} not found in evaluated 'jobs' table.`);
      process.exit(1);
    }

    const job = jobRes.rows[0];
    const jdTitle = job.title;
    const jdCompany = job.company_name;
    const jdDescription = job.raw_description;

    // Load Schemas
    const schemaDir = path.join(process.cwd(), "scripts", "schemas");
    const jobAnalysisSchema = fs.readFileSync(path.join(schemaDir, "job_analysis.schema.json"), "utf8");
    const tailoredCvSchema = fs.readFileSync(path.join(schemaDir, "tailored_cv.schema.json"), "utf8");

    // Load Master Profile
    const profilePath = path.join(process.cwd(), "master_profile.json");
    if (!fs.existsSync(profilePath)) {
      console.error("❌ ERROR: 'master_profile.json' not found. Run build_ledger.ts first.");
      process.exit(1);
    }
    const masterProfile = JSON.parse(fs.readFileSync(profilePath, "utf8"));

    const model = process.env.KIMI_API_KEY ? (process.env.KIMI_MODEL || "moonshot-v1-8k") : (process.env.GEMINI_MODEL || "gemini-3.6-flash");

    // --- STAGE 1: JOB ANALYSIS ---
    console.log("STAGE 1: Analyzing Job Description...");
    const jobAnalysisPrompt = `Extract requirements, capabilities, and scale signals from this Job Description.
Return ONLY valid JSON matching this schema:
${jobAnalysisSchema}

Job Description:
${jdDescription}`;

    const analysisRes = await generateContent({
      model,
      contents: jobAnalysisPrompt,
      responseMimeType: "application/json",
      systemInstruction: "You are an analytical engine extracting objective requirements from a job description."
    });
    const jobAnalysis = JSON.parse(cleanJsonResponse(analysisRes));

    // --- STAGE 2: REQUIREMENT-TO-EVIDENCE MATCHING (Deterministic Simulation) ---
    console.log("STAGE 2: Matching Requirements to Evidence...");
    const matchedEvidence = [];
    const allReqs = [...(jobAnalysis.mandatory_requirements || []), ...(jobAnalysis.preferred_requirements || [])];
    
    // In a full implementation, we'd do a vector or semantic search. 
    // Here we use the LLM to map evidence dynamically.
    const matchPrompt = `Map the following Job Requirements to the provided Master Profile Evidence Ledger.
Requirements: ${JSON.stringify(allReqs)}
Master Profile: ${JSON.stringify(masterProfile)}

Output a JSON array of objects with keys: req_id, match_status ("direct_match"|"transferable_match"|"partial_match"|"gap"), and profile_fact_ids (array of fact IDs from the master profile).`;
    
    const matchRes = await generateContent({
      model,
      contents: matchPrompt,
      responseMimeType: "application/json",
      systemInstruction: "You strictly map job requirements to verifiable fact IDs in the master profile."
    });
    const evidenceMap = JSON.parse(cleanJsonResponse(matchRes));

    // --- STAGE 3: EXECUTIVE STRATEGY ---
    console.log("STAGE 3: Formulating Executive Strategy...");
    const strategyPrompt = `Formulate an executive CV strategy for the target role: ${jdTitle} at ${jdCompany}.
Use the Evidence Map: ${JSON.stringify(evidenceMap)}
Use the Job Analysis: ${JSON.stringify(jobAnalysis)}

Return a JSON object with: positioning_statement, leadership_themes (array of strings), signature_fact_ids (array of top 3-5 profile_fact_ids), keyword_plan (array of objects with 'term' and 'profile_fact_ids'), and prohibited_claims.`;
    
    const strategyRes = await generateContent({
      model,
      contents: strategyPrompt,
      responseMimeType: "application/json",
      systemInstruction: "You are an executive CV strategist."
    });
    const strategy = JSON.parse(cleanJsonResponse(strategyRes));

    // --- STAGE 4: GENERATE SEMANTIC CV JSON ---
    console.log("STAGE 4: Generating Semantic CV JSON...");
    const cvPrompt = `Generate the final structured CV JSON based on the Executive Strategy, the Master Profile, and the Job Analysis.
You MUST output JSON matching this EXACT schema:
${tailoredCvSchema}

Master Profile: ${JSON.stringify(masterProfile)}
Strategy: ${JSON.stringify(strategy)}
Target Title: ${jdTitle}
Target Company: ${jdCompany}`;

    const cvRes = await generateContent({
      model,
      contents: cvPrompt,
      responseMimeType: "application/json",
      systemInstruction: "You generate the final tailored JSON CV. DO NOT invent facts. Only use data from the master profile."
    });
    const finalCv = JSON.parse(cleanJsonResponse(cvRes));

    // --- STAGE 5: EXPORT ---
    console.log("STAGE 5: Rendering documents...");
    
    // Create exports dir
    const exportDir = path.join(process.cwd(), "scripts", "exports");
    if (!fs.existsSync(exportDir)) {
      fs.mkdirSync(exportDir, { recursive: true });
    }

    const safeTitle = jdTitle.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 15);
    const safeCompany = jdCompany.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 15);
    const baseFilename = `Elena_Okhonko_${safeCompany}_${safeTitle}`;
    
    // Save JSON
    fs.writeFileSync(path.join(exportDir, `${baseFilename}.cv.json`), JSON.stringify(finalCv, null, 2));
    
    // Save DOCX
    await generateDocx(finalCv, path.join(exportDir, `${baseFilename}.docx`));
    
    // Save PDF
    await generatePdf(finalCv, path.join(exportDir, `${baseFilename}.pdf`));

    console.log(`✅ CV Generation Complete! Files saved to scripts/exports/:
- ${baseFilename}.cv.json
- ${baseFilename}.docx
- ${baseFilename}.pdf`);

  } catch (err: any) {
    console.error("❌ Error generating tailored CV:", err.message || err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

generateTailoredCV();
