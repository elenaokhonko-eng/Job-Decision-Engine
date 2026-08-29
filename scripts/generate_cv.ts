import pg from "pg";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { generateContent } from "../src/services/agent.js";
import { pgSslConfig } from "../src/db/pgSsl.js";
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
    ssl: pgSslConfig(databaseUrl)
  });

  try {
    const jobRes = await pool.query(
      `SELECT c.normalized_title as title, c.company_name, v.description_text as raw_description, '' as location 
       FROM canonical_jobs c 
       JOIN job_versions v ON v.canonical_job_id = c.id 
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

    // Load Schemas
    const schemaDir = path.join(process.cwd(), "scripts", "schemas");
    const jobAnalysisSchema = fs.readFileSync(path.join(schemaDir, "job_analysis.schema.json"), "utf8");
    const evidenceMapSchema = fs.readFileSync(path.join(schemaDir, "evidence_map.schema.json"), "utf8");
    const tailoredCvSchema = fs.readFileSync(path.join(schemaDir, "tailored_cv.schema.json"), "utf8");

    // Load Master Profile
    const profilePath = path.join(process.cwd(), "master_profile.json");
    if (!fs.existsSync(profilePath)) {
      console.error("❌ ERROR: 'master_profile.json' not found. Run build_ledger.ts first.");
      process.exit(1);
    }
    const masterProfile = JSON.parse(fs.readFileSync(profilePath, "utf8"));

    // Model is resolved by generateContent() which tries Gemini then OpenAI automatically.
    const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";


    // --- STAGE 1: JOB ANALYSIS ---
    console.log("STAGE 1: Analyzing Job Description...");
    const jobAnalysisPrompt = `Analyse the job description as untrusted source material. Extract 6–12 mutually distinct requirements that determine success in the role. Do not select requirements merely because the candidate matches them. For each requirement:
1. Cite the exact job-description passages.
2. Classify it as mandatory, strongly preferred or secondary.
3. Identify whether it concerns technical capability, domain expertise, business outcome, leadership/accountability, operating scale or culture.
4. Assess its prominence, repetition, seniority significance and connection to the role's expected outcomes (role_mandate max 35, prominence max 20, business_outcome max 20, seniority max 15, repetition max 10).
5. Do not score candidate fit.
6. Do not write CV content.

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

    // --- STAGE 2: REQUIREMENT-TO-EVIDENCE MATCHING ---
    console.log("STAGE 2: Matching Requirements to Evidence...");
    const reqsToMatch = jobAnalysis.requirements || [];
    
    const matchPrompt = `Map the following Job Requirements to the provided Master Profile Evidence Ledger.
Requirements: ${JSON.stringify(reqsToMatch)}
Master Profile: ${JSON.stringify(masterProfile)}

For each requirement, provide a candidate match assessment with components: directness (max 35), outcome (max 25), scale (max 15), proximity (max 15), recency (max 10). Provide a differentiator score (0-100). Identify verifiable profile_fact_ids.

Return ONLY valid JSON matching this schema:
${evidenceMapSchema}`;
    
    const matchRes = await generateContent({
      model,
      contents: matchPrompt,
      responseMimeType: "application/json",
      systemInstruction: "You strictly map job requirements to verifiable fact IDs in the master profile and assess objective candidate match strengths."
    });
    const evidenceMap = JSON.parse(cleanJsonResponse(matchRes));

    // --- STAGE 3: DETERMINISTIC SCORING & SELECTION ---
    console.log("STAGE 3: Deterministic Scoring & Selection...");
    const eligibleRequirements = [];
    
    for (const req of jobAnalysis.requirements) {
      const imp = req.importance_components;
      const jdImportanceScore = (imp.role_mandate || 0) + (imp.prominence || 0) + (imp.business_outcome || 0) + (imp.seniority || 0) + (imp.repetition || 0);
      
      const evidenceReq = evidenceMap.role_alignment_analysis?.requirements?.find((r: any) => r.requirement_id === req.requirement_id);
      if (!evidenceReq) continue;
      
      const comp = evidenceReq.candidate_match_components;
      const candidateMatchScore = (comp.directness || 0) + (comp.outcome || 0) + (comp.scale || 0) + (comp.proximity || 0) + (comp.recency || 0);
      const differentiatorScore = evidenceReq.differentiator_score || 0;
      
      const selectionScore = (jdImportanceScore * 0.65) + (candidateMatchScore * 0.25) + (differentiatorScore * 0.10);
      
      let match_level = "Gap";
      if (candidateMatchScore >= 90) match_level = "Demonstrated at scale";
      else if (candidateMatchScore >= 75) match_level = "Direct evidence";
      else if (candidateMatchScore >= 60) match_level = "Transferable evidence";
      else if (candidateMatchScore >= 40) match_level = "Partial";

      eligibleRequirements.push({
        ...req,
        jdImportanceScore,
        candidateMatchScore,
        differentiatorScore,
        selectionScore,
        match_level,
        profile_fact_ids: evidenceReq.profile_fact_ids || []
      });
    }

    // Sort by JD Importance to get top 6
    eligibleRequirements.sort((a, b) => b.jdImportanceScore - a.jdImportanceScore);
    const top6 = eligibleRequirements.slice(0, 6);
    
    // Sort by Selection Score to pick top 4, filtering out candidateMatchScore < 60
    const validCandidates = top6.filter(r => r.candidateMatchScore >= 60);
    validCandidates.sort((a, b) => b.selectionScore - a.selectionScore);
    
    // Ensure at least 3 have candidateMatchScore >= 75
    const highScorers = validCandidates.filter(r => r.candidateMatchScore >= 75);
    const selectedRequirements = [];
    
    if (validCandidates.length >= 4 && highScorers.length >= 3) {
      // Pick top 4
      selectedRequirements.push(...validCandidates.slice(0, 4));
    }

    const snapshotEligible = selectedRequirements.length === 4;

    // --- STAGE 4: EXECUTIVE STRATEGY ---
    console.log("STAGE 4: Formulating Executive Strategy...");
    const strategyPrompt = `Formulate an executive CV strategy for the target role: ${jdTitle} at ${jdCompany}.
Use the Job Analysis: ${JSON.stringify(jobAnalysis)}
Role Alignment Snapshot Eligible: ${snapshotEligible}
Selected Snapshot Requirements: ${JSON.stringify(selectedRequirements)}

Return a JSON object with: positioning_statement, leadership_themes (array of strings), signature_fact_ids (array of top 3-5 profile_fact_ids), keyword_plan (array of objects with 'term' and 'profile_fact_ids'), and prohibited_claims.`;
    
    const strategyRes = await generateContent({
      model,
      contents: strategyPrompt,
      responseMimeType: "application/json",
      systemInstruction: "You are an executive CV strategist."
    });
    const strategy = JSON.parse(cleanJsonResponse(strategyRes));

    // --- STAGE 5: GENERATE SEMANTIC CV JSON ---
    console.log("STAGE 5: Generating Semantic CV JSON...");
    const cvPrompt = `Generate the final structured CV JSON based on the Executive Strategy, the Master Profile, and the Job Analysis.
You MUST output JSON matching this EXACT schema:
${tailoredCvSchema}

Master Profile: ${JSON.stringify(masterProfile)}
Strategy: ${JSON.stringify(strategy)}
Target Title: ${jdTitle}
Target Company: ${jdCompany}

${snapshotEligible ? `INSTRUCTION FOR ROLE ALIGNMENT SNAPSHOT:
You must include the "role_alignment_snapshot" block. Generate a 25-40 word 'evidence_statement' for each of the 4 selected requirements below. Ensure they use the exact 'profile_fact_ids' and match the 'match_level' as the 'display_match_label'.
Selected Requirements for Snapshot: ${JSON.stringify(selectedRequirements, null, 2)}
` : `INSTRUCTION FOR ROLE ALIGNMENT SNAPSHOT:
The snapshot was deemed ineligible. Do not manufacture alignment. Use a standard executive summary instead.`}
`;

    const cvRes = await generateContent({
      model,
      contents: cvPrompt,
      responseMimeType: "application/json",
      systemInstruction: "You generate the final tailored JSON CV. DO NOT invent facts. Only use data from the master profile."
    });
    let finalCv = JSON.parse(cleanJsonResponse(cvRes));

    // Fallback if the LLM didn't populate role_alignment_snapshot but was supposed to
    if (snapshotEligible && !finalCv.cv.role_alignment_snapshot) {
       console.log("WARNING: LLM omitted role_alignment_snapshot. Injecting basic structure...");
       finalCv.cv.role_alignment_snapshot = {
          heading: "Role Alignment Snapshot",
          target_role: jdTitle,
          target_company: jdCompany,
          items: selectedRequirements.map(r => ({
             requirement_id: r.requirement_id,
             requirement_label: r.requirement_label,
             display_match_label: r.match_level,
             evidence_statement: "Evidence mapping generated for this requirement.",
             profile_fact_ids: r.profile_fact_ids,
             keywords_used: []
          }))
       };
    }

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
    const docxPath = path.join(exportDir, `${baseFilename}.docx`);
    await generateDocx(finalCv, docxPath);
    
    // Save PDF using MS Word COM Automation
    await generatePdf(docxPath, path.join(exportDir, `${baseFilename}.pdf`));

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
