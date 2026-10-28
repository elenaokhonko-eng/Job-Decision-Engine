/**
 * generate_cover_letter.ts — Sprint G
 *
 * Generates a tailored cover letter from:
 *  1. canonical_jobs + job_versions (job description + title + company)
 *  2. ai_evaluations.full_evaluation_payload (lane context, ND scores)
 *  3. ai_evaluations.lane_matches + workability_facts
 *  4. active profile facts in PostgreSQL (profile_versions/profile_facts)
 *
 * Invariants:
 *  - Provider failover: Gemini → OpenAI (via generateContent in agent.ts)
 *  - Strict schema validation of the LLM response
 *  - No hallucination: prompt explicitly restricts to evidence in the ledger
 *  - Non-zero exit on any failure (AGENTS.md invariant 7)
 *  - rejectUnauthorized:true via pgConnectionConfig
 */

import pg from "pg";
import crypto from "node:crypto";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import Ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { generateContentAudited, MODEL_REGISTRY } from "../src/services/agent.js";
import { pgConnectionConfig } from "../src/db/pgSsl.js";
import { sourceContentEvidencePredicate } from "../src/pipeline/descriptionQuality.js";
import { generateCoverLetterDocx } from "../src/services/renderers/docx_cl_renderer.js";
import { generatePdf } from "../src/services/renderers/pdf_renderer.js";
import { persistDocumentProvenance, type DocumentClaimInput } from "../src/documents/provenance.js";
import { loadProfileContactInfo, requireDocumentCandidateName } from "../src/documents/contactInfo.js";
import { validateDocumentCurrentContext } from "../src/documents/currentContext.js";
import {
  isCurrentReadyApplicationReadiness,
  loadCurrentApplicationReadiness,
} from "../src/services/currentApplicationReadiness.js";
import { getActiveDocumentTemplatePluginRevision } from "../src/documents/plugins.js";
import {
  loadProfileFactsByIds,
  loadRequirementMatchesForJobVersion,
  selectCoverLetterClaimPlan,
} from "../src/documents/claimSelector.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../src/workspace/context.js";

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
    console.error(`ERROR: ${name} environment variable is missing.`);
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

function collectCoverLetterClaims(finalCl: any): DocumentClaimInput[] {
  const claims: DocumentClaimInput[] = [];
  const bodyParagraphs = Array.isArray(finalCl?.cover_letter?.body_paragraphs)
    ? finalCl.cover_letter.body_paragraphs
    : [];

  for (let idx = 0; idx < bodyParagraphs.length; idx += 1) {
    const paragraph = bodyParagraphs[idx] || {};
    const text = typeof paragraph.text === "string" ? paragraph.text : "";
    const evidenceIds = Array.isArray(paragraph.evidence_ids)
      ? paragraph.evidence_ids.filter((id: unknown): id is string => typeof id === "string" && id.trim().length > 0)
      : [];
    const requirementMatches: string[] = text.match(/R-[0-9]{3}/g)?.map((m: string) => m) || [];
    const requirementKeys: string[] = Array.from(new Set(requirementMatches));

    if (text.trim().length > 0 && evidenceIds.length > 0) {
      claims.push({
        sectionLabel: `body_paragraph_${idx + 1}`,
        claimText: text,
        profileFactIds: evidenceIds,
        requirementKeys,
      });
    }
  }

  return claims;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function generateTailoredCoverLetter(): Promise<void> {
  const jobId = process.argv[2];
  const requestedJobVersionId = process.argv[3];
  const applicationRecordId = process.env.JDEC_APPLICATION_RECORD_ID?.trim() || null;
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
  const pool = new pg.Pool(pgConnectionConfig(databaseUrl));

  try {
    // ── Step 1: Load job data from canonical schema ──────────────────────────
    console.log(`📦 Loading job ${jobId} from canonical schema…`);

    const ctx: WorkspaceContext = await resolveWorkspaceContext(pool as any);
    const jobRes = await pool.query(
      `SELECT
         c.id,
         COALESCE(c.latest_job_version_id, (
           SELECT jv_current.id
           FROM job_versions jv_current
           WHERE jv_current.canonical_job_id = c.id
             AND jv_current.workspace_id = c.workspace_id
           ORDER BY jv_current.observed_at DESC
           LIMIT 1
         )) AS current_job_version_id,
         c.latest_match_run_id,
         c.latest_deterministic_decision_id,
         c.normalized_title   AS title,
         c.company_name,
         current_shortlist.gate_status,
         current_shortlist.recommendation_eligibility,
         current_shortlist.recommendation_outcome,
         c.primary_lane,
         c.secondary_lanes,
         jv.id                AS selected_job_version_id,
         jv.active_requirement_set_id,
         jv.content_hash      AS current_job_content_hash,
         active_profile.id    AS active_profile_version_id,
         mr.id                AS match_run_id,
         mr.job_version_id    AS match_run_job_version_id,
         mr.profile_version_id AS match_run_profile_version_id,
         mr.status            AS match_run_status,
         mr.requirement_set_id AS match_run_requirement_set_id,
         mr.job_content_hash  AS match_run_job_content_hash,
         mr.context_fingerprint AS match_run_context_fingerprint,
         dd.id                AS deterministic_decision_id,
         dd.job_version_id    AS decision_job_version_id,
         dd.match_run_id      AS decision_match_run_id,
         dd.context_fingerprint AS decision_context_fingerprint,
         dd.recommendation_eligibility AS decision_recommendation_eligibility,
         dd.recommendation_outcome AS decision_recommendation_outcome,
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
             AND jv2.workspace_id = c.workspace_id
           ORDER BY jv2.observed_at DESC
           LIMIT 1
         )
       )
        AND jv.workspace_id = c.workspace_id
       LEFT JOIN v_canonical_shortlist_scoped AS current_shortlist
         ON current_shortlist.workspace_id = c.workspace_id
        AND current_shortlist.canonical_job_id = c.id
        AND current_shortlist.job_version_id = jv.id
       LEFT JOIN LATERAL (
         SELECT pv.id
         FROM profile_versions pv
         WHERE pv.workspace_id = c.workspace_id
           AND pv.status = 'ACTIVE'
         ORDER BY pv.created_at DESC
         LIMIT 1
       ) active_profile ON TRUE
       LEFT JOIN match_runs mr
         ON mr.workspace_id = c.workspace_id
        AND mr.id = c.latest_match_run_id
        AND mr.canonical_job_id = c.id
       LEFT JOIN deterministic_decisions dd
         ON dd.workspace_id = c.workspace_id
        AND dd.id = c.latest_deterministic_decision_id
        AND dd.canonical_job_id = c.id
       LEFT JOIN LATERAL (
         SELECT lane_matches, workability_facts, full_evaluation_payload, is_fallback, provider, evaluated_at
         FROM ai_evaluations ae
         WHERE ae.workspace_id = $3
           AND ae.canonical_job_id = c.id
           AND ae.job_version_id = jv.id
           AND ae.profile_version_id = active_profile.id
           AND ae.match_run_id = mr.id
           AND ae.deterministic_decision_id = dd.id
           AND ae.job_content_hash = jv.content_hash
           AND ae.context_fingerprint = dd.context_fingerprint
         ORDER BY ae.evaluated_at DESC
         LIMIT 1
       ) ae ON TRUE
       WHERE c.workspace_id = $3
         AND c.id = $1
         AND jv.canonical_job_id = c.id
         AND c.description_quality_status = 'COMPLETE'
         AND ${sourceContentEvidencePredicate("c.workspace_id", "jv.id")}`,
      [jobId, requestedJobVersionId || null, ctx.workspaceId]
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
    const resolvedJobVersionId = job.selected_job_version_id;
    const latestMatchRunId = job.latest_match_run_id || null;

    // Pull structured fields out of full_evaluation_payload if available
    const evalPayload = job.full_evaluation_payload || {};
    const evaluationSummary: string = evalPayload.evaluation_summary || "";
    const ndScore: number | null = evalPayload.nd_friendly_score ?? evalPayload.nd_score ?? null;
    const recommendedCvVersion: string = evalPayload.recommended_cv_version || primaryLane;
    const nextAction: string = evalPayload.next_action || "REVIEW";
    const laneEvidence: string = evalPayload.lane_evidence || "";
    const strategicValue: string = evalPayload.strategic_value || "";

    const laneMatches = job.lane_matches ?? [];
    const workabilityFacts = job.workability_facts ?? {};

    console.log(`✅ Job loaded: "${jdTitle}" at ${jdCompany} (${primaryLane}, ND=${ndScore ?? "UNKNOWN"})`);
    if (job.is_fallback) {
      console.log(`  ℹ️  AI evaluation used fallback provider: ${job.eval_provider}`);
    }

    // ── Step 2: Resolve document contact info (no master_profile evidence dependency) ──
    const profileNameRes = await pool.query<{ profile_version_id: string; display_name: string }>(
      `SELECT pv.id AS profile_version_id, cp.display_name
       FROM profile_versions pv
       JOIN candidate_profiles cp ON cp.id = pv.candidate_profile_id
       WHERE pv.workspace_id = $1
         AND pv.status = 'ACTIVE'
         AND pv.id = $2
       ORDER BY pv.created_at DESC
       LIMIT 1`,
      [ctx.workspaceId, job.active_profile_version_id]
    );
    const selectedProfileVersionId = profileNameRes.rows[0]?.profile_version_id ?? null;
    const readiness = await loadCurrentApplicationReadiness(
      pool,
      ctx.workspaceId,
      job.canonical_job_id,
      resolvedJobVersionId,
    );
    if (!isCurrentReadyApplicationReadiness(readiness)) {
      throw new Error("Document generation rejected: a current READY assessment is required.");
    }
    const currentness = validateDocumentCurrentContext({
      readiness_status: readiness?.readiness_status ?? null,
      readiness_fingerprint: readiness?.readiness_fingerprint ?? null,
      readiness_expires_at: readiness?.readiness_expires_at ?? null,
      readiness_reason_codes: readiness?.readiness_reason_codes ?? null,
      current_job_version_id: job.current_job_version_id,
      selected_job_version_id: job.selected_job_version_id,
      active_profile_version_id: job.active_profile_version_id,
      selected_profile_version_id: selectedProfileVersionId,
      latest_match_run_id: job.latest_match_run_id,
      match_run_id: job.match_run_id,
      match_run_job_version_id: job.match_run_job_version_id,
      match_run_profile_version_id: job.match_run_profile_version_id,
      match_run_status: job.match_run_status,
      match_run_requirement_set_id: job.match_run_requirement_set_id,
      active_requirement_set_id: job.active_requirement_set_id,
      match_run_job_content_hash: job.match_run_job_content_hash,
      current_job_content_hash: job.current_job_content_hash,
      match_run_context_fingerprint: job.match_run_context_fingerprint,
      latest_deterministic_decision_id: job.latest_deterministic_decision_id,
      deterministic_decision_id: job.deterministic_decision_id,
      decision_job_version_id: job.decision_job_version_id,
      decision_match_run_id: job.decision_match_run_id,
      decision_context_fingerprint: job.decision_context_fingerprint,
      decision_recommendation_eligibility: job.decision_recommendation_eligibility,
      decision_recommendation_outcome: job.decision_recommendation_outcome,
      gate_status: job.gate_status,
      recommendation_eligibility: job.recommendation_eligibility,
      recommendation_outcome: job.recommendation_outcome,
    });
    if (!currentness.ok) {
      throw new Error(`Document generation rejected stale context: ${currentness.reason}.`);
    }
    if (!latestMatchRunId) {
      throw new Error(
        "No latest_match_run_id found for this job. Run deterministic matching before generating documents."
      );
    }
    if (!['PRIORITY', 'REVIEW'].includes(String(job.recommendation_outcome || ''))) {
      throw new Error(
        `Deterministic recommendation_outcome=${job.recommendation_outcome || 'NULL'}; documents require PRIORITY or REVIEW.`
      );
    }

    if (!selectedProfileVersionId) {
      throw new Error("An active profile version is required to resolve document contact information.");
    }
    const candidateName = String(profileNameRes.rows[0]?.display_name || "").trim();
    const contactInfo = await loadProfileContactInfo(
      pool,
      ctx.workspaceId,
      selectedProfileVersionId,
      candidateName,
    );

    // ── Step 3: Load cover letter schema ─────────────────────────────────────
    const schemaDir = path.join(process.cwd(), "scripts", "schemas");
    const clSchemaPath = path.join(schemaDir, "cover_letter_schema.json");
    if (!fs.existsSync(clSchemaPath)) {
      console.error(`❌ ERROR: cover_letter_schema.json not found at ${clSchemaPath}`);
      process.exit(1);
    }
    const coverLetterSchema = JSON.parse(fs.readFileSync(clSchemaPath, "utf8"));

    // ── Step 3.5: Deterministic claim selection (least-data prompt) ──────────
    let selectedClaims: Array<{
      requirementKey: string;
      importance: string;
      requirementText: string;
      profileFactIds: string[];
      matchType: string;
      matchScore: number;
    }> = [];
    let allowedFactIds: string[] = [];

    if (!latestMatchRunId) {
      throw new Error(
        "No latest_match_run_id found for this job. Run deterministic matching before generating documents."
      );
    }

    const matchRows = await loadRequirementMatchesForJobVersion(
      resolvedJobVersionId,
      latestMatchRunId,
      pool,
      { context: ctx }
    );
    selectedClaims = selectCoverLetterClaimPlan(matchRows, { maxRequirements: 3 }).map((claim) => ({
      requirementKey: claim.requirementKey,
      importance: claim.importance,
      requirementText: claim.requirementText,
      profileFactIds: claim.profileFactIds,
      matchType: claim.matchType,
      matchScore: claim.matchScore,
    }));
    allowedFactIds = Array.from(new Set(selectedClaims.flatMap((claim) => claim.profileFactIds)));

    if (allowedFactIds.length === 0) {
      throw new Error(
        "No grounded requirement-evidence matches are available for this job/version. Ensure embeddings are published and deterministic matching has produced matches."
      );
    }

    const allowedFactSet = new Set(allowedFactIds);
    const selectedFacts = await loadProfileFactsByIds(allowedFactIds, pool, { context: ctx });
    const selectedFactIdSet = new Set(selectedFacts.map((f) => f.id));
    const missingFactIds = allowedFactIds.filter((id) => !selectedFactIdSet.has(id));
    if (missingFactIds.length > 0) {
      throw new Error(`Selected profile facts were not found in the database: ${missingFactIds.join(", ")}`);
    }

    if (selectedFacts.length === 0) {
      throw new Error("No profile facts available to ground the cover letter.");
    }

    // ── Step 3.6: Optional document template plugin revision ─────────────────
    const pluginRevision = await getActiveDocumentTemplatePluginRevision("COVER_LETTER", pool, {
      context: ctx,
    });
    const pluginPreamble = (pluginRevision?.content?.prompt_preamble || "").trim();
    const pluginSystemInstruction = (pluginRevision?.content?.system_instruction || "").trim();
    const pluginRouteKey = (pluginRevision?.content?.model_route_key || "").trim();

    // ── Step 4: Build prompt ─────────────────────────────────────────────────
    console.log("STAGE 1: Requesting AI cover letter draft...");

    const clPrompt = `You are an expert cover letter writer generating a professional cover letter for the candidate.

ROLE: ${jdTitle} at ${jdCompany}
LANE: ${primaryLane}
AI EVALUATION SUMMARY: ${evaluationSummary || "(not yet evaluated)"}
STRATEGIC VALUE: ${strategicValue}
LANE EVIDENCE: ${laneEvidence}
NEXT ACTION: ${nextAction}

WORKABILITY FACTS (use these to ground the letter; unknown = NEEDS_VERIFICATION):
${JSON.stringify(workabilityFacts, null, 2)}

DETERMINISTIC CLAIM PLAN (requirements + allowed evidence ids):
${JSON.stringify(selectedClaims, null, 2)}

ALLOWED EVIDENCE FACTS (only cite facts from this list; do not invent or cite other ids):
${JSON.stringify(selectedFacts, null, 2)}

INSTRUCTIONS:
- Maximum 1 page (3–4 tight, professional paragraphs)
- Opening: name the role and company; state clear interest and fit signal
- Body: each paragraph must cite 1–2 evidence_ids from the allowed facts above; do not use any other evidence_ids
- Closing: clear, confident call to action
- NEVER invent experience, credentials, companies, degrees, or metrics not present in the evidence ledger
- DO NOT disclose or discuss neurodivergence or personal health accommodations in the letter
- If possible, mention the requirement_key(s) (e.g., R-001) you are addressing in each paragraph text for provenance
${pluginPreamble ? `\nPLUGIN PREAMBLE (additional constraints):\n${pluginPreamble}\n` : ""}
- Return ONLY valid JSON matching this exact schema:
${JSON.stringify(coverLetterSchema)}`;

    const generation = await generateContentAudited({
      model: MODEL_REGISTRY.DOCUMENT_PRIMARY_MODEL,
      contents: clPrompt,
      responseMimeType: "application/json",
      systemInstruction:
        pluginSystemInstruction ||
        "You are an expert cover letter writer. Return only valid JSON conforming strictly to the schema. Do not hallucinate evidence not in the ledger.",
      purpose: "DOCUMENT",
      routeKey: pluginRouteKey || undefined,
      clientOrPool: pool,
      context: ctx,
      seedRoute: true,
    });
    const rawResponse = generation.text;

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
        if (!allowedFactSet.has(evId)) {
          unknownEvidence.push(`body_paragraphs[${idx}].evidence_ids used non-selected id '${evId}'`);
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
    const candidateFullName = requireDocumentCandidateName(contactInfo);
    const safeCandidate = candidateFullName
      .replace(/[^a-zA-Z0-9]/g, "_")
      .substring(0, 20);
    const baseFilename = `${safeCandidate}_CL_${safeCompany}_${safeTitle}`;
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
    if (!fs.existsSync(docxPath)) {
      throw new Error("Cover letter renderer completed without creating the required DOCX artifact.");
    }

    // PDF is optional when no local converter exists.
    const pdfPath = path.join(exportDir, `${baseFilename}.pdf`);
    await generatePdf(docxPath, pdfPath);

    const pdfCreated = fs.existsSync(pdfPath);
    const claims = collectCoverLetterClaims(finalCl);
    const outputManifest = {
      schema_version: "document_output_manifest_v1",
      json_path: jsonPath,
      docx_path: docxPath,
      docx_sha256: crypto.createHash("sha256").update(fs.readFileSync(docxPath)).digest("hex"),
      pdf_path: pdfCreated ? pdfPath : null,
      pdf_sha256: pdfCreated ? crypto.createHash("sha256").update(fs.readFileSync(pdfPath)).digest("hex") : null,
    };
    const provenance = await persistDocumentProvenance(
      {
        applicationRecordId,
        canonicalJobId: jobId,
        jobVersionId: resolvedJobVersionId,
        matchRunId: latestMatchRunId,
        profileVersionId: selectedProfileVersionId,
        deterministicDecisionId: job.deterministic_decision_id,
        contextFingerprint: job.decision_context_fingerprint,
        documentType: 'COVER_LETTER',
        policyVersion: 'documents_v2',
        generatorVersion: 'cover_letter_generator_v2',
        modelRouteInvocationId: generation.invocationId ?? null,
        documentTemplatePluginRevisionId: pluginRevision?.revisionId ?? null,
        documentTemplatePluginKey: pluginRevision?.pluginKey ?? null,
        outputManifest,
        claims,
      },
      pool,
      { context: ctx }
    );

    console.log(`\n✅ Cover Letter Generation Complete!
  JSON : ${jsonPath}
  DOCX : ${docxPath}
  PDF  : ${pdfCreated ? pdfPath : "NOT CREATED (no Word/LibreOffice in environment)"}
  document_run_id: ${provenance.documentRunId} (claims: ${provenance.claimCount})`);
    console.log(JSON.stringify({
      event: "DOCUMENT_GENERATION_COMPLETED",
      documentType: "COVER_LETTER",
      applicationRecordId,
      documentRunId: provenance.documentRunId,
      canonicalJobId: jobId,
      jobVersionId: resolvedJobVersionId,
      profileVersionId: selectedProfileVersionId,
      deterministicDecisionId: job.deterministic_decision_id,
      contextFingerprint: job.decision_context_fingerprint,
      templateRevisionId: pluginRevision?.revisionId ?? null,
      outputManifest: { ...outputManifest, manifest_hash: provenance.outputManifestHash },
      outputs: {
        json: { path: jsonPath },
        docx: {
          path: docxPath,
          sha256: crypto.createHash("sha256").update(fs.readFileSync(docxPath)).digest("hex"),
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
        pdf: pdfCreated ? {
          path: pdfPath,
          sha256: crypto.createHash("sha256").update(fs.readFileSync(pdfPath)).digest("hex"),
          mimeType: "application/pdf",
        } : null,
      },
    }));

  } catch (error: any) {
    console.error("❌ ERROR during Cover Letter generation:", error.message || error);
    if (error.stack) console.error(error.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

generateTailoredCoverLetter();
