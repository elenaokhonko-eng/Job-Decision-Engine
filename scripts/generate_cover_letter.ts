import pg from "pg";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { generateContent } from "../src/services/agent.js";
import { generateCoverLetterDocx } from "../src/services/renderers/docx_cl_renderer.js";
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

async function generateTailoredCoverLetter() {
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
      `SELECT c.normalized_title as title, c.company_name, v.description_text as raw_description, a.lane_matches, a.workability_facts
       FROM canonical_jobs c 
       JOIN job_versions v ON v.canonical_job_id = c.id 
       LEFT JOIN ai_evaluations a ON a.canonical_job_id = c.id
       WHERE c.id = $1 ORDER BY v.observed_at DESC LIMIT 1`,
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
    const laneMatches = job.lane_matches;

    // Load Schemas
    const schemaDir = path.join(process.cwd(), "scripts", "schemas");
    const coverLetterSchema = fs.readFileSync(path.join(schemaDir, "cover_letter_schema.json"), "utf8");

    // Load Master Profile
    const profilePath = path.join(process.cwd(), "master_profile.json");
    if (!fs.existsSync(profilePath)) {
      console.error("❌ ERROR: 'master_profile.json' not found. Run build_ledger.ts first.");
      process.exit(1);
    }
    const masterProfile = JSON.parse(fs.readFileSync(profilePath, "utf8"));

    const model = process.env.KIMI_API_KEY ? (process.env.KIMI_MODEL || "moonshot-v1-8k") : (process.env.GEMINI_MODEL || "gemini-3.6-flash");

    // --- STAGE 1: DRAFT COVER LETTER ---
    console.log("STAGE 1: Drafting Cover Letter...");
    const clPrompt = `You are Elena Okhonko, a highly skilled professional applying for the role of ${jdTitle} at ${jdCompany}. 
    Draft a concise, compelling cover letter (max 1 page) based on the Job Description, your verified Master Profile facts, and the AI Evaluation's lane matches.
    Do not hallucinate any experience. Use a direct, analytical, yet enthusiastic tone.

    AI Evaluation Context:
    Lane Matches: ${JSON.stringify(laneMatches)}

    Job Description:
    ${jdDescription}

    Candidate Profile Ledger:
    ${JSON.stringify(masterProfile.profile_facts)}

    Return ONLY valid JSON matching this schema:
    ${coverLetterSchema}`;

    const clRes = await generateContent({
      model,
      contents: clPrompt,
      responseMimeType: "application/json",
      systemInstruction: "You are an expert cover letter writer who crafts highly targeted, deterministic cover letters based purely on factual evidence."
    });
    const finalCl = JSON.parse(cleanJsonResponse(clRes));

    // --- STAGE 2: EXPORT ---
    console.log("STAGE 2: Rendering documents...");
    
    // Create exports dir
    const exportDir = path.join(process.cwd(), "scripts", "exports");
    if (!fs.existsSync(exportDir)) {
      fs.mkdirSync(exportDir, { recursive: true });
    }

    const safeTitle = jdTitle.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 15);
    const safeCompany = jdCompany.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 15);
    const baseFilename = `Elena_Okhonko_CL_${safeCompany}_${safeTitle}`;
    
    // Save JSON
    fs.writeFileSync(path.join(exportDir, `${baseFilename}.json`), JSON.stringify(finalCl, null, 2));
    
    // Save DOCX
    const docxPath = path.join(exportDir, `${baseFilename}.docx`);
    await generateCoverLetterDocx(finalCl, docxPath, masterProfile.contact);
    
    // Save PDF using MS Word COM Automation
    await generatePdf(docxPath, path.join(exportDir, `${baseFilename}.pdf`));

    console.log(`✅ Cover Letter Generation Complete! Files saved to scripts/exports/:
- ${baseFilename}.json
- ${baseFilename}.docx
- ${baseFilename}.pdf`);

  } catch (error: any) {
    console.error("❌ ERROR during Cover Letter generation:", error.message || error);
    if (error.stack) console.error(error.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

generateTailoredCoverLetter();
