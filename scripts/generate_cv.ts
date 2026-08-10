import pg from "pg";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { generateContent } from "../src/services/agent.ts";

dotenv.config();
dotenv.config({ path: ".env.local" });

const databaseUrl = process.env.DATABASE_URL;

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

  // 1. Fetch job description from Postgres database
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
    const jdLocation = job.location || "Singapore";

    // 2. Read master profile from my_profile.md
    const profilePath = path.join(process.cwd(), "my_profile.md");
    if (!fs.existsSync(profilePath)) {
      console.error("❌ ERROR: 'my_profile.md' not found in workspace root. Please create it first.");
      process.exit(1);
    }

    const masterProfile = fs.readFileSync(profilePath, "utf8");

    // 2b. Read CV Response Schema from cv_response_schema.json
    const schemaPath = path.join(process.cwd(), "scripts", "cv_response_schema.json");
    if (!fs.existsSync(schemaPath)) {
      console.error("❌ ERROR: 'cv_response_schema.json' not found in scripts directory.");
      process.exit(1);
    }
    const cvResponseSchema = fs.readFileSync(schemaPath, "utf8");

    // 3. Construct the comprehensive single prompt for structured JSON CV response
    const prompt = `You are a professional, honest, and high-fidelity CV writer and alignment agent.
Your task is to analyze the user's master professional profile against the target Job Description (JD) and output a JSON object containing both the analysis and the tailored CV.

### STRICT RULES:
1. **ABSOLUTELY NO FABRICATIONS OR LYING**: Do not invent jobs, certifications, projects, or accomplishments. Keep everything 100% factual to the master profile.
2. **HONEST GAP REPORTING**: Call out key mismatches/gaps where the user lacks direct experience. Under each mismatch:
   - Provide factual parallel exposure (e.g. if the JD asks for Kubernetes and the user only has Docker/ECS, state that).
   - Outline a brief, realistic learning plan to master it fast.
3. **ATS FORMATTING AND COMPLIANCE RULES**:
   - The output Markdown resume MUST be single-column.
   - Do NOT use tables, markdown tables, HTML containers, text boxes, graphics, icons, or visual shapes. These break typical parser algorithms (e.g. Workday, Taleo).
   - Use standard headers: "# [Name]", "## Summary", "## Skills", "## Work Experience", "## Education", "## Certifications". Do not use creative section titles.
   - Place all contact details (email, phone, location, LinkedIn/GitHub) in plain text at the very top of the document. Do not place them in headers/footers.
4. **STAR METHOD BULLET POINTS**:
   - Every bullet point in the "Work Experience" section MUST follow the STAR method (Situation/Task, Action, Result) factually mapped from the user's master profile.
   - Quantify results using metrics, percentages, or numbers where factually available.
5. **ATS SCORING METRICS**:
   - In the "ats_scoring_metrics" JSON property, perform a realistic estimation of keyword match %, formatting compliance (no tables/shapes, standard sections), and STAR method coverage.
6. **TAILORED CV MARKDOWN**: In the "tailored_cv_markdown" property, write the fully customized resume in clean Markdown format incorporating all the ATS formatting rules above.

### JSON RESPONSE SCHEMA:
You MUST output a JSON object conforming exactly to this schema:
${cvResponseSchema}

---
### TARGET JOB SPECIFICATION:
- **Title**: ${jdTitle}
- **Company**: ${jdCompany}
- **Location**: ${jdLocation}
- **Job Description**:
${jdDescription}

---
### USER MASTER PROFILE:
${masterProfile}

---
Ensure the output is clean JSON. Do not prepend or append markdown code blocks around the JSON object.`;

    // 4. Run LLM generation with JSON output configuration
    const model = process.env.KIMI_API_KEY ? (process.env.KIMI_MODEL || "moonshot-v1-8k") : (process.env.GEMINI_MODEL || "gemini-2.0-flash");
    const jsonResponse = await generateContent({
      model,
      contents: prompt,
      responseMimeType: "application/json",
      systemInstruction: "You are a professional CV tailoring system. You analyze profiles and output strictly structured JSON conforming to the requested schema."
    });

    console.log("CV_GENERATION_SUCCESS_START");
    console.log(jsonResponse.trim());
    console.log("CV_GENERATION_SUCCESS_END");

  } catch (err: any) {
    console.error("❌ Error generating tailored CV:", err.message || err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

generateTailoredCV();
