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
import Ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { generateContent } from "../src/services/agent.js";
import { pgSslConfig } from "../src/db/pgSsl.js";
import { generateCoverLetterDocx } from "../src/services/renderers/docx_cl_renderer.js";
import { generatePdf } from "../src/services/renderers/pdf_renderer.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const Ajv2020 = (Ajv2020Import as any).default || Ajv2020Import;
const addFormats = (addFormatsImport as any).default || addFormatsImport;
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

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

function validateAgainstSchema(payload: unknown, schema: any, schemaName: string): void {
  const validate = ajv.compile(schema);
  const ok = validate(payload);
  if (!ok) {
    const details = (validate.errors || []).map((e: any) => `${e.instancePath || "/"} ${e.message}`).join("; ");
    throw new Error(`${schemaName} validation failed: ${details}`);
  }
}

function profileFactIds(masterProfile: any): Set<string> {
  const facts: any[] = masterProfile.profile_facts || masterProfile.facts || [];
  return new Set(facts.map((f) => f?.id).filter((id: any) => typeof id === "string" && id.trim().length > 0));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function generateTailoredCoverLetter(): Promise<void> {
  const jobId = process.argv[2];
  const requestedJobVersionId = process.argv[3];
  if (!jobId) {
    console.error("❌ ERROR: Job ID must be provided as the first argument.");
    console.error("  Usage: npx tsx scripts/generate_cover_letter.ts <canonical_job_id> [job_version_id]");
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
         jv.id                AS job_version_id,
         jv.description_text  AS raw_description,
         ae.lane_matches,
         ae.workability_facts,
         ae.full_evaluation_payload,
         ae.is_fallback,
         ae.provider          AS eval_provider,
         ae.evaluated_at
       FROM canonical_jobs c
       JOIN job_versions jv ON jv.id = COALESCE(
         $2::uuid,
         c.latest_job_version_id,
         (
           SELECT jv2.id
           FROM job_versions jv2
           WHERE jv2.canonical_job_id = c.id
           ORDER BY jv2.observed_at DESC
           LIMIT 1
         )
       )
       LEFT JOIN LATERAL (
         SELECT lane_matches, workability_facts, full_evaluation_payload, is_fallback, provider, evaluated_at
         FROM ai_evaluations
         WHERE canonical_job_id = c.id
           AND job_version_id = jv.id
         ORDER BY evaluated_at DESC
         LIMIT 1
       ) ae ON TRUE
       WHERE c.id = $1
         AND jv.canonical_job_id = c.id`,
      [jobId, requestedJobVersionId || null]
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
    const resolvedJobVersionId = job.job_version_id;

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
    let masterProfile: any;
    if (process.env.MASTER_PROFILE_JSON) {
      try {
        masterProfile = JSON.parse(process.env.MASTER_PROFILE_JSON);
      } catch (err: any) {
        console.error("❌ ERROR: Failed to parse MASTER_PROFILE_JSON environment variable:", err.message);
        process.exit(1);
      }
    } else {
      const profilePath = path.join(process.cwd(), "master_profile.json");
      if (!fs.existsSync(profilePath)) {
        console.error("❌ ERROR: Neither MASTER_PROFILE_JSON env secret nor local 'master_profile.json' found.");
        process.exit(1);
      }
      masterProfile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
    }
    const profileFacts: any[] = masterProfile.profile_facts || masterProfile.facts || [];
    const knownFactIds = profileFactIds(masterProfile);
    const contactInfo: any = masterProfile.contact || {};

    console.log(`📋 Profile loaded: ${profileFacts.length} evidence items`);

    // ── Step 3: Load cover letter schema ─────────────────────────────────────
    const schemaDir = path.join(process.cwd(), "scripts", "schemas");
    const clSchemaPath = path.join(schemaDir, "cover_letter_schema.json");
    if (!fs.existsSync(clSchemaPath)) {
      console.error(`❌ ERROR: cover_letter_schema.json not found at ${clSchemaPath}`);
      process.exit(1);
    }
    const coverLetterSchema = JSON.parse(fs.readFileSync(clSchemaPath, "utf8"));

    // ── Step 4: Build prompt ─────────────────────────────────────────────────
    console.log("🤖 STAGE 1: Requesting AI cover letter draft…");

    const clPrompt = `You are an expert cover letter writer generating a professional cover letter for Elena Okhonko.

ROLE: ${jdTitle} at ${jdCompany}
LANE: ${primaryLane}
AI EVALUATION SUMMARY: ${evaluationSummary || "(not yet evaluated)"}
STRATEGIC VALUE: ${strategicValue}
LANE EVIDENCE: ${laneEvidence}
NEXT ACTION: ${nextAction}

WORKABILITY FACTS (use these to ground the letter; unknown = NEEDS_VERIFICATION):
${JSON.stringify(workabilityFacts, null, 2)}

JOB DESCRIPTION:
${jdDescription.substring(0, 4000)}

EVIDENCE LEDGER (only cite professional facts from this list; do not invent):
${JSON.stringify(profileFacts.slice(0, 40), null, 2)}

INSTRUCTIONS:
- Maximum 1 page (3–4 tight, professional paragraphs)
- Opening: name the role and company; state clear interest and fit signal
- Body: cite 2–3 specific technical evidence items and achievements from the ledger that directly address the JD requirements
- Closing: clear, confident call to action
- NEVER invent experience, credentials, companies, degrees, or metrics not present in the evidence ledger
- DO NOT disclose or discuss neurodivergence or personal health accommodations in the letter
- Return ONLY valid JSON matching this exact schema:
${JSON.stringify(coverLetterSchema)}`;

    const rawResponse = await generateContent({
      model: process.env.GEMINI_MODEL || "gemini-2.0-flash",
      contents: clPrompt,
      responseMimeType: "application/json",
      systemInstruction:
        "You are an expert cover letter writer. Return only valid JSON conforming strictly to the schema. Do not hallucinate evidence not in the ledger.",
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

    validateAgainstSchema(finalCl, coverLetterSchema, "cover_letter_schema.json");

    const cl = finalCl.cover_letter;
    const unknownEvidence: string[] = [];
    for (const [idx, para] of cl.body_paragraphs.entries()) {
      for (const evId of para.evidence_ids || []) {
        if (!knownFactIds.has(evId)) {
          unknownEvidence.push(`body_paragraphs[${idx}].evidence_ids contains unknown id '${evId}'`);
        }
      }
    }
    if (unknownEvidence.length > 0) {
      throw new Error(`Cover letter evidence grounding failed: ${unknownEvidence.join(" | ")}`);
    }

    console.log("✅ Cover letter draft validated with strict schema enforcement.");

    // ── Step 6: Render and export ─────────────────────────────────────────────
    console.log("📄 STAGE 2: Rendering DOCX and PDF…");

    const exportDir = path.join(process.cwd(), "scripts", "exports");
    if (!fs.existsSync(exportDir)) {
      fs.mkdirSync(exportDir, { recursive: true });
    }

    const safeTitle = jdTitle.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 20);
    const safeCompany = jdCompany.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 20);
    const baseFilename = `Elena_Okhonko_CL_${safeCompany}_${safeTitle}`;
    finalCl.metadata = {
      canonical_job_id: jobId,
      job_version_id: resolvedJobVersionId
    };

    // JSON
    const jsonPath = path.join(exportDir, `${baseFilename}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(finalCl, null, 2));

    // DOCX
    const docxPath = path.join(exportDir, `${baseFilename}.docx`);
    await generateCoverLetterDocx(finalCl, docxPath, contactInfo);

    // PDF (Word COM automation)
    const pdfPath = path.join(exportDir, `${baseFilename}.pdf`);
    await generatePdf(docxPath, pdfPath);

    const pdfCreated = fs.existsSync(pdfPath);

    console.log(`\n✅ Cover Letter Generation Complete!
  JSON : ${jsonPath}
  DOCX : ${docxPath}
  PDF  : ${pdfCreated ? pdfPath : "NOT CREATED (no Word/LibreOffice in environment)"}`);

  } catch (error: any) {
    console.error("❌ ERROR during Cover Letter generation:", error.message || error);
    if (error.stack) console.error(error.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

generateTailoredCoverLetter();
