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

    console.log(`🤖 Starting AI CV Customization for role: "${jdTitle}" at ${jdCompany}...`);

    // 3. Construct prompt
    const prompt = `You are a high-fidelity CV tailoring assistant. Your task is to customize the user's master professional profile for a specific job description (JD).

### MASTER RULES:
1. **ABSOLUTELY NO FABRICATIONS OR LYING**: Do not invent jobs, projects, certifications, skills, or achievements that are not present in the master profile. Staying strictly honest is critical.
2. **HONEST GAP REPORTING**: If there are key requirements in the JD that are not covered by the master profile:
   - Do not hide them.
   - List them explicitly in a "Key Mismatches / Gaps" section at the top.
   - Under each gap, state what parallel/other exposure you have that is related, or state an honest, brief plan to learn it fast.
3. **FRONT-PAGE FIT SUMMARY**: Introduce a summary block at the very top of the CV containing:
   - Overall % Fit to JD requirements (estimate realistically based on overlap)
   - Core Requirements % Match
   - Key Mismatches / Gaps
4. **EXPERIENCE FOCUS**: Retell the experience section focusing heavily on achievements, tools, and projects that align with the JD, but keep all facts and numbers strictly true to the master profile.
5. **KEYWORDS**: Ensure key technical keywords from the JD that match the profile are prominent.

---

### JOB SPECIFICATION:
- **Title**: ${jdTitle}
- **Company**: ${jdCompany}
- **Location**: ${jdLocation}
- **Job Description**:
${jdDescription}

---

### USER MASTER PROFILE:
${masterProfile}

---

Please output the completed tailored CV in clean Markdown format. Focus on professional styling and structure.`;

    // 4. Run LLM generation
    const model = process.env.KIMI_API_KEY ? (process.env.KIMI_MODEL || "moonshot-v1-8k") : (process.env.GEMINI_MODEL || "gemini-2.0-flash");
    const tailoredCV = await generateContent({
      model,
      contents: prompt,
      systemInstruction: "You are a professional, honest, and high-fidelity CV customization assistant. You output perfectly structured resumes in clean Markdown."
    });

    console.log("CV_GENERATION_SUCCESS_START");
    console.log(tailoredCV);
    console.log("CV_GENERATION_SUCCESS_END");

  } catch (err: any) {
    console.error("❌ Error generating tailored CV:", err.message || err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

generateTailoredCV();
