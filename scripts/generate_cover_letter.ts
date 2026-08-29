/**
 * generate_cover_letter.ts — Sprint G
 *
 * Generates a tailored cover letter from:
 *  1. canonical_jobs + job_versions (job description + title + company)
 *  2. ai_evaluations.full_evaluation_payload (lane context, ND scores)
 *  3. ai_evaluations.lane_matches + workability_facts
 *  4. master_profile.json (committed factual evidence ledger)
 *
 * Invariants:
 *  - Provider failover: Gemini → OpenAI (via generateContent in agent.ts)
 *  - Strict schema validation of the LLM response
 *  - No hallucination: prompt explicitly restricts to evidence in the ledger
 *  - Non-zero exit on any failure (AGENTS.md invariant 7)
 *  - rejectUnauthorized:true via pgSslConfig
 */

import pg from "pg";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { generateContent } from "../src/services/agent.js";
import { pgSslConfig } from "../src/db/pgSsl.js";
import { generateCoverLetterDocx } from "../src/services/renderers/docx_cl_renderer.js";
import { generatePdf } from "../src/services/renderers/pdf_renderer.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Helpers ──────────────────────────────────────────────────────────────────

function cleanJsonResponse(rawText: string): string {
  let cleaned = rawText.trim();
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.replace(/^```json\s*/, "").replace(/\s*```$/, "");
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```\s*/, "").replace(/\s*```$/, "");
  }
  return cleaned;
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`❌ ERROR: ${name} environment variable is missing.`);
    process.exit(1);
  }
  return val;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function generateTailoredCoverLetter(): Promise<void> {
  const jobId = process.argv[2];
  if (!jobId) {
    console.error("❌ ERROR: Job ID must be provided as the first argument.");
    console.error("  Usage: npx tsx scripts/generate_cover_letter.ts <canonical_job_id>");
    process.exit(1);
  }

  const databaseUrl = requireEnv("DATABASE_URL");

  // Check at least one LLM key is present before we bother hitting the DB
  const hasGemini = !!(process.env.GEMINI_API_KEY || process.env.GEMINI_FLASH_API_KEY);
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  if (!hasGemini && !hasOpenAI) {
    console.error("❌ ERROR: Neither GEMINI_API_KEY nor OPENAI_API_KEY is configured.");
    process.exit(1);
  }

  // Pool declared outside try so finally can end it safely
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: pgSslConfig(databaseUrl),
  });

  try {
    // ── Step 1: Load job data from canonical schema ──────────────────────────
    console.log(`📦 Loading job ${jobId} from canonical schema…`);

    const jobRes = await pool.query(
      `SELECT
         c.id,
         c.normalized_title   AS title,
         c.company_name,
         c.primary_lane,
         c.secondary_lanes,
         jv.description_text  AS raw_description,
         ae.lane_matches,
         ae.workability_facts,
         ae.full_evaluation_payload,
         ae.is_fallback,
         ae.provider          AS eval_provider,
         ae.evaluated_at
       FROM canonical_jobs c
       JOIN LATERAL (
         SELECT id, description_text
         FROM job_versions
         WHERE canonical_job_id = c.id
         ORDER BY observed_at DESC
         LIMIT 1
       ) jv ON TRUE
       LEFT JOIN LATERAL (
         SELECT lane_matches, workability_facts, full_evaluation_payload, is_fallback, provider, evaluated_at
         FROM ai_evaluations
         WHERE canonical_job_id = c.id
         ORDER BY evaluated_at DESC
         LIMIT 1
       ) ae ON TRUE
       WHERE c.id = $1`,
      [jobId]
    );

    if (jobRes.rows.length === 0) {
      console.error(`❌ ERROR: No canonical job found with ID ${jobId}.`);
      process.exit(1);
    }

    const job = jobRes.rows[0];
    const jdTitle = job.title || "Unknown Role";
    const jdCompany = job.company_name || "Unknown Company";
    const jdDescription = job.raw_description || "";
    const primaryLane = job.primary_lane || "UNKNOWN";

    // Pull structured fields out of full_evaluation_payload if available
    const evalPayload = job.full_evaluation_payload || {};
    const evaluationSummary: string = evalPayload.evaluation_summary || "";
    const ndScore: number = evalPayload.nd_score ?? evalPayload.nd_friendly_score ?? 0;
    const recommendedCvVersion: string = evalPayload.recommended_cv_version || primaryLane;
    const nextAction: string = evalPayload.next_action || "REVIEW";
    const laneEvidence: string = evalPayload.lane_evidence || "";
    const strategicValue: string = evalPayload.strategic_value || "";

    const laneMatches = job.lane_matches ?? [];
    const workabilityFacts = job.workability_facts ?? {};

    console.log(`✅ Job loaded: "${jdTitle}" at ${jdCompany} (${primaryLane}, ND=${ndScore})`);
    if (job.is_fallback) {
      console.log(`  ℹ️  AI evaluation used fallback provider: ${job.eval_provider}`);
    }

    // ── Step 2: Load master profile (evidence ledger) ────────────────────────
    const profilePath = path.join(process.cwd(), "master_profile.json");
    if (!fs.existsSync(profilePath)) {
      console.error("❌ ERROR: 'master_profile.json' not found. Run build_ledger.ts first.");
      process.exit(1);
    }
    const masterProfile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
    const profileFacts: any[] = masterProfile.profile_facts || [];
    const contactInfo: any = masterProfile.contact || {};

    console.log(`📋 Profile loaded: ${profileFacts.length} evidence items`);

    // ── Step 3: Load cover letter schema ─────────────────────────────────────
    const schemaDir = path.join(process.cwd(), "scripts", "schemas");
    const clSchemaPath = path.join(schemaDir, "cover_letter_schema.json");
    if (!fs.existsSync(clSchemaPath)) {
      console.error(`❌ ERROR: cover_letter_schema.json not found at ${clSchemaPath}`);
      process.exit(1);
    }
    const coverLetterSchema = fs.readFileSync(clSchemaPath, "utf8");

    // ── Step 4: Build prompt ─────────────────────────────────────────────────
    console.log("🤖 STAGE 1: Requesting AI cover letter draft…");

    const clPrompt = `You are an expert cover letter writer generating a cover letter for Elena Okhonko.

ROLE: ${jdTitle} at ${jdCompany}
LANE: ${primaryLane}
AI EVALUATION SUMMARY: ${evaluationSummary || "(not yet evaluated)"}
ND SCORE: ${ndScore}/100
STRATEGIC VALUE: ${strategicValue}
LANE EVIDENCE: ${laneEvidence}
NEXT ACTION: ${nextAction}

WORKABILITY FACTS (use these to ground the letter; unknown = NEEDS_VERIFICATION):
${JSON.stringify(workabilityFacts, null, 2)}

JOB DESCRIPTION:
${jdDescription.substring(0, 4000)}

EVIDENCE LEDGER (only cite facts from this list; do not invent):
${JSON.stringify(profileFacts.slice(0, 40), null, 2)}

INSTRUCTIONS:
- Maximum 1 page (4–5 tight paragraphs)
- Opening: name the role and company; state clear interest and fit signal
- Body: cite 2–3 specific evidence items from the ledger that directly match the JD requirements
- Body: briefly address the ND workability picture only if nd_score >= 75
- Closing: clear call to action
- NEVER invent experience, credentials, or metrics not present in the evidence ledger
- Return ONLY valid JSON matching this exact schema:
${coverLetterSchema}`;

    const rawResponse = await generateContent({
      model: process.env.GEMINI_MODEL || "gemini-2.0-flash",
      contents: clPrompt,
      responseMimeType: "application/json",
      systemInstruction:
        "You are an expert cover letter writer. Return only valid JSON. Do not hallucinate evidence not in the ledger.",
    });

    // ── Step 5: Validate the response ────────────────────────────────────────
    let finalCl: any;
    try {
      finalCl = JSON.parse(cleanJsonResponse(rawResponse));
    } catch (parseErr) {
      console.error("❌ ERROR: AI returned invalid JSON for cover letter. Aborting.");
      console.error("Raw response:", rawResponse.substring(0, 500));
      process.exit(1);
    }

    // Validate required top-level fields per the schema
    const required = ["opening_paragraph", "body_paragraphs", "closing_paragraph"];
    for (const field of required) {
      if (!finalCl[field]) {
        console.error(`❌ ERROR: Cover letter JSON missing required field: '${field}'`);
        process.exit(1);
      }
    }

    console.log("✅ Cover letter draft validated.");

    // ── Step 6: Render and export ─────────────────────────────────────────────
    console.log("📄 STAGE 2: Rendering DOCX and PDF…");

    const exportDir = path.join(process.cwd(), "scripts", "exports");
    if (!fs.existsSync(exportDir)) {
      fs.mkdirSync(exportDir, { recursive: true });
    }

    const safeTitle = jdTitle.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 20);
    const safeCompany = jdCompany.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 20);
    const baseFilename = `Elena_Okhonko_CL_${safeCompany}_${safeTitle}`;

    // JSON
    const jsonPath = path.join(exportDir, `${baseFilename}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(finalCl, null, 2));

    // DOCX
    const docxPath = path.join(exportDir, `${baseFilename}.docx`);
    await generateCoverLetterDocx(finalCl, docxPath, contactInfo);

    // PDF (Word COM automation)
    const pdfPath = path.join(exportDir, `${baseFilename}.pdf`);
    await generatePdf(docxPath, pdfPath);

    console.log(`\n✅ Cover Letter Generation Complete!
  JSON : ${jsonPath}
  DOCX : ${docxPath}
  PDF  : ${pdfPath}`);

  } catch (error: any) {
    console.error("❌ ERROR during Cover Letter generation:", error.message || error);
    if (error.stack) console.error(error.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

generateTailoredCoverLetter();
