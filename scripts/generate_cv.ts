/**
 * generate_cv.ts
 *
 * Deterministic, evidence-grounded CV generator.
 *
 * Inputs:
 *  - canonical_jobs + job_versions (job context)
 *  - latest deterministic match map (match_runs + requirement_evidence_matches)
 *  - active profile in PostgreSQL (profile_versions/profile_facts/profile_engagements)
 *
 * Notes:
 *  - No dependency on master_profile.json for evidence.
 *  - Contact info is resolved from the active profile graph; legacy local sources only fill missing fields.
 */

import pg from "pg";
import crypto from "node:crypto";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import Ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { pgConnectionConfig } from "../src/db/pgSsl.js";
import { generateDocx } from "../src/services/renderers/docx_renderer.js";
import { generatePdf } from "../src/services/renderers/pdf_renderer.js";
import { persistDocumentProvenance, type DocumentClaimInput } from "../src/documents/provenance.js";
import { loadProfileContactInfo, requireCvContactInfo } from "../src/documents/contactInfo.js";
import { validateDocumentCurrentContext, type DocumentCurrentContext } from "../src/documents/currentContext.js";
import {
  isCurrentReadyApplicationReadiness,
  loadCurrentApplicationReadiness,
} from "../src/services/currentApplicationReadiness.js";
import { getActiveDocumentTemplatePluginRevision } from "../src/documents/plugins.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../src/workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const Ajv2020 = (Ajv2020Import as any).default || Ajv2020Import;
const addFormats = (addFormatsImport as any).default || addFormatsImport;
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

function validateAgainstSchema(payload: unknown, schema: any, schemaName: string): void {
  const validate = ajv.compile(schema);
  const ok = validate(payload);
  if (!ok) {
    const details = (validate.errors || []).map((e: any) => `${e.instancePath || "/"} ${e.message}`).join("; ");
    throw new Error(`${schemaName} validation failed: ${details}`);
  }
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return val;
}

function safeSegment(value: string, maxLen: number): string {
  const cleaned = String(value || "")
    .replace(/[^a-zA-Z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .trim();
  return (cleaned || "Unknown").substring(0, maxLen);
}

function toDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  return null;
}

function formatMonthYear(value: unknown): string {
  const date = toDate(value);
  if (!date) return "";
  return new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric" }).format(date);
}

function formatDateDisplay(params: { start: unknown; end: unknown; isCurrent: boolean }): string {
  const start = formatMonthYear(params.start);
  const end = params.isCurrent ? "Present" : formatMonthYear(params.end);
  if (start && end) return `${start} – ${end}`;
  if (start) return `${start} – ${params.isCurrent ? "Present" : "Unknown"}`;
  return "Unknown";
}

function collectStringLeaves(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringLeaves(item, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectStringLeaves(item, out);
    }
  }
}

function labelizeToken(raw: string): string {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  const normalized = trimmed.replace(/[^a-zA-Z0-9_\\-\\s]/g, " ").trim();
  const parts = normalized.split(/[_\\-\\s]+/).filter(Boolean);
  if (parts.length === 0) return "";
  return parts
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(" ");
}

function importanceRank(value: string): number {
  if (value === "MUST") return 0;
  if (value === "PREFERRED") return 1;
  return 2;
}

function matchTypeRank(value: string): number {
  if (value === "EXACT") return 0;
  if (value === "SEMANTIC") return 1;
  if (value === "UNKNOWN") return 2;
  return 3;
}

function evidenceTierRank(value: string): number {
  if (value === "PROFESSIONAL_PRODUCTION") return 0;
  if (value === "DEPLOYED_OPEN_SOURCE") return 1;
  if (value === "APPLIED_PROJECT") return 2;
  if (value === "COURSE_PROJECT") return 3;
  return 4;
}

function pickDisplayMatchLabel(matchType: string, evidenceTier: string): string {
  if (matchType === "EXACT" && (evidenceTier === "PROFESSIONAL_PRODUCTION" || evidenceTier === "DEPLOYED_OPEN_SOURCE")) {
    return "Demonstrated at scale";
  }
  if (matchType === "EXACT") {
    return "Direct evidence";
  }
  return "Transferable evidence";
}

function clampText(value: string, maxLen: number): string {
  const text = String(value || "").trim();
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 1)).trim()}…`;
}

function ensureKnownEvidenceIds(finalCv: any, knownFactIds: Set<string>): void {
  const unknown: string[] = [];
  const collect = (ids: any, where: string) => {
    if (!Array.isArray(ids)) return;
    for (const id of ids) {
      if (typeof id !== "string" || !knownFactIds.has(id)) {
        unknown.push(`${where}: ${String(id)}`);
      }
    }
  };

  collect(finalCv?.strategy?.signature_fact_ids, "strategy.signature_fact_ids");
  for (const [idx, kw] of (finalCv?.strategy?.keyword_plan || []).entries()) {
    collect(kw?.profile_fact_ids, `strategy.keyword_plan[${idx}].profile_fact_ids`);
  }
  for (const [idx, item] of (finalCv?.cv?.role_alignment_snapshot?.items || []).entries()) {
    collect(item?.profile_fact_ids, `cv.role_alignment_snapshot.items[${idx}].profile_fact_ids`);
  }
  for (const [expIdx, exp] of (finalCv?.cv?.experience || []).entries()) {
    for (const [achIdx, ach] of (exp?.achievements || []).entries()) {
      collect(ach?.profile_fact_ids, `cv.experience[${expIdx}].achievements[${achIdx}].profile_fact_ids`);
    }
  }

  if (unknown.length > 0) {
    throw new Error(`Unknown profile_fact_ids in CV payload: ${unknown.join(" | ")}`);
  }
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

function collectCvClaims(finalCv: any): DocumentClaimInput[] {
  const claims: DocumentClaimInput[] = [];
  const snapshotItems = finalCv?.cv?.role_alignment_snapshot?.items || [];

  for (const item of snapshotItems) {
    claims.push({
      sectionLabel: "role_alignment_snapshot",
      claimText: String(item?.evidence_statement || ""),
      profileFactIds: stringArray(item?.profile_fact_ids),
      requirementKeys: stringArray([item?.requirement_id]),
    });
  }

  const experienceSections = [
    ...(Array.isArray(finalCv?.cv?.experience) ? finalCv.cv.experience : []),
    ...(Array.isArray(finalCv?.cv?.selected_ventures_and_research) ? finalCv.cv.selected_ventures_and_research : []),
  ];

  for (const section of experienceSections) {
    const achievements = Array.isArray(section?.achievements) ? section.achievements : [];
    for (const achievement of achievements) {
      claims.push({
        sectionLabel: "experience_achievement",
        claimText: String(achievement?.text || ""),
        profileFactIds: stringArray(achievement?.profile_fact_ids),
        requirementKeys: stringArray(achievement?.requirement_ids),
      });
    }
  }

  return claims.filter((claim) => claim.claimText.trim().length > 0 && claim.profileFactIds.length > 0);
}

type JobRow = Omit<DocumentCurrentContext, "selected_profile_version_id"> & {
  canonical_job_id: string;
  title: string | null;
  company_name: string | null;
  raw_description: string | null;
  location: string | null;
};

type ProfileRow = {
  profile_version_id: string;
  version_number: number | string;
  display_name: string | null;
};

type RequirementRow = {
  id: string;
  requirement_key: string;
  importance: string;
  requirement_text: string;
};

type MatchRow = {
  requirement_id: string;
  requirement_key: string;
  importance: string;
  requirement_text: string;
  profile_fact_id: string | null;
  match_type: string;
  match_score: number;
};

type ProfileFactRow = {
  id: string;
  engagement_id: string | null;
  fact_type: string;
  statement: string;
  structured_value: unknown;
  evidence_tier: string;
  verification_status: string;
  confidentiality: string;
  created_at: string;
};

type EngagementRow = {
  id: string;
  engagement_key: string;
  organization_legal_name: string;
  brand_or_program_name: string | null;
  role_title: string;
  operating_model: string | null;
  start_date: unknown;
  end_date: unknown;
  is_current: boolean;
  summary: string;
};

async function generateTailoredCV(): Promise<void> {
  const jobId = process.argv[2];
  const requestedJobVersionId = process.argv[3];
  const applicationRecordId = process.env.JDEC_APPLICATION_RECORD_ID?.trim() || null;
  if (!jobId) {
    throw new Error("Usage: npx tsx scripts/generate_cv.ts <canonical_job_id> [job_version_id]");
  }

  const databaseUrl = requireEnv("DATABASE_URL");

  const pool = new pg.Pool(pgConnectionConfig(databaseUrl));

  try {
    const ctx: WorkspaceContext = await resolveWorkspaceContext(pool as any);
    const jobRes = await pool.query<JobRow>(
      `SELECT
         c.id AS canonical_job_id,
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
         current_shortlist.gate_status,
         current_shortlist.recommendation_eligibility,
         current_shortlist.recommendation_outcome,
         c.normalized_title as title,
         c.company_name,
         v.id AS selected_job_version_id,
         v.active_requirement_set_id,
         v.content_hash AS current_job_content_hash,
         active_profile.id AS active_profile_version_id,
         mr.id AS match_run_id,
         mr.job_version_id AS match_run_job_version_id,
         mr.profile_version_id AS match_run_profile_version_id,
         mr.status AS match_run_status,
         mr.requirement_set_id AS match_run_requirement_set_id,
         mr.job_content_hash AS match_run_job_content_hash,
         mr.context_fingerprint AS match_run_context_fingerprint,
         dd.id AS deterministic_decision_id,
         dd.job_version_id AS decision_job_version_id,
         dd.match_run_id AS decision_match_run_id,
         dd.context_fingerprint AS decision_context_fingerprint,
         dd.recommendation_eligibility AS decision_recommendation_eligibility,
         dd.recommendation_outcome AS decision_recommendation_outcome,
         v.description_text as raw_description,
         COALESCE(c.location, c.location_summary, '') as location
       FROM canonical_jobs c
       JOIN job_versions v ON v.id = COALESCE(
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
        AND v.workspace_id = c.workspace_id
       LEFT JOIN v_canonical_shortlist_scoped AS current_shortlist
         ON current_shortlist.workspace_id = c.workspace_id
        AND current_shortlist.canonical_job_id = c.id
        AND current_shortlist.job_version_id = v.id
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
       WHERE c.workspace_id = $3
         AND c.id = $1
         AND v.canonical_job_id = c.id
       LIMIT 1`,
      [jobId, requestedJobVersionId || null, ctx.workspaceId]
    );

    if (jobRes.rows.length === 0) {
      throw new Error(
        `Canonical job/version not found for job ${jobId}${requestedJobVersionId ? ` and version ${requestedJobVersionId}` : ""}.`
      );
    }

    const job = jobRes.rows[0];
    const jdTitle = job.title || "Unknown Role";
    const jdCompany = job.company_name || "Unknown Company";

    const profileRes = await pool.query<ProfileRow>(
      `SELECT
         pv.id AS profile_version_id,
         pv.version_number,
         cp.display_name
       FROM profile_versions pv
       JOIN candidate_profiles cp
         ON cp.id = pv.candidate_profile_id
        AND cp.workspace_id = pv.workspace_id
       WHERE pv.workspace_id = $1
         AND pv.status = 'ACTIVE'
         AND pv.id = $2
       ORDER BY pv.created_at DESC
       LIMIT 1`,
      [ctx.workspaceId, job.active_profile_version_id]
    );

    if (profileRes.rows.length === 0) {
      throw new Error("No ACTIVE profile version found. Import and activate a profile before generating documents.");
    }

    const profile = profileRes.rows[0];
    if (!job.selected_job_version_id) {
      throw new Error("Document generation rejected a missing selected job version.");
    }
    const resolvedJobVersionId = job.selected_job_version_id;
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
      ...job,
      readiness_status: readiness?.readiness_status ?? null,
      readiness_fingerprint: readiness?.readiness_fingerprint ?? null,
      readiness_expires_at: readiness?.readiness_expires_at ?? null,
      readiness_reason_codes: readiness?.readiness_reason_codes ?? null,
      selected_profile_version_id: profile.profile_version_id,
    });
    if (!currentness.ok) {
      throw new Error(`Document generation rejected stale context: ${currentness.reason}.`);
    }

    const matchRunId = job.latest_match_run_id;
    if (!matchRunId) {
      throw new Error(
        "No latest_match_run_id found for this job. Run deterministic matching before generating documents."
      );
    }
    if (!['PRIORITY', 'REVIEW'].includes(String(job.recommendation_outcome || ''))) {
      throw new Error(
        `Deterministic recommendation_outcome=${job.recommendation_outcome || 'NULL'}; documents require PRIORITY or REVIEW.`
      );
    }

    const profileVersionId = profile.profile_version_id;
    const candidateName = String(profile.display_name || "").trim();
    const profileVersionNumber = String(profile.version_number || "").trim() || "unknown";

    const contactInfo = requireCvContactInfo(await loadProfileContactInfo(
      pool,
      ctx.workspaceId,
      profileVersionId,
      candidateName,
    ));

    const schemaDir = path.join(process.cwd(), "scripts", "schemas");
    const tailoredCvSchemaPath = path.join(schemaDir, "tailored_cv.schema.json");
    const tailoredCvSchema = JSON.parse(fs.readFileSync(tailoredCvSchemaPath, "utf8"));

    const requirementsRes = await pool.query<RequirementRow>(
      `SELECT jr.id, jr.requirement_key, jr.importance, jr.requirement_text
       FROM job_versions jv
       JOIN job_requirements jr
         ON jr.workspace_id = jv.workspace_id
        AND (
          (jv.active_requirement_set_id IS NOT NULL AND jr.requirement_set_id = jv.active_requirement_set_id)
          OR (jv.active_requirement_set_id IS NULL AND jr.job_version_id = jv.id)
        )
       WHERE jv.workspace_id = $1
         AND jv.id = $2
         AND jr.status = 'VALIDATED'
       ORDER BY jr.requirement_key ASC`,
      [ctx.workspaceId, resolvedJobVersionId]
    );
    if (requirementsRes.rows.length === 0) {
      throw new Error(`No VALIDATED job_requirements found for job_version_id=${resolvedJobVersionId}.`);
    }

    const matchesRes = await pool.query<MatchRow>(
      `SELECT
         jr.id AS requirement_id,
         jr.requirement_key,
         jr.importance,
         jr.requirement_text,
         rem.profile_fact_id,
         rem.match_type,
         rem.match_score
       FROM job_versions jv
       JOIN job_requirements jr
         ON jr.workspace_id = jv.workspace_id
        AND (
          (jv.active_requirement_set_id IS NOT NULL AND jr.requirement_set_id = jv.active_requirement_set_id)
          OR (jv.active_requirement_set_id IS NULL AND jr.job_version_id = jv.id)
        )
       JOIN requirement_evidence_matches rem
         ON rem.workspace_id = jr.workspace_id
        AND rem.requirement_id = jr.id
       WHERE jv.workspace_id = $1
         AND jv.id = $2
         AND rem.match_run_id = $3
       ORDER BY jr.requirement_key ASC`,
      [ctx.workspaceId, resolvedJobVersionId, matchRunId]
    );

    const allFactsRes = await pool.query<ProfileFactRow>(
      `SELECT
         pf.id,
         pf.engagement_id,
         pf.fact_type,
         pf.statement,
         pf.structured_value,
         pf.evidence_tier,
         pf.verification_status,
         pf.confidentiality,
         pf.created_at::text AS created_at
       FROM profile_facts pf
       WHERE pf.workspace_id = $1
         AND pf.profile_version_id = $2
         AND pf.fact_type <> 'CONTACT'
         AND pf.confidentiality IN ('PUBLIC', 'PRIVATE_REUSABLE')
       ORDER BY pf.created_at ASC`,
      [ctx.workspaceId, profileVersionId]
    );

    const knownFactIds = new Set(allFactsRes.rows.map((f) => f.id));
    if (knownFactIds.size === 0) {
      throw new Error("Active profile contains no reusable facts (profile_facts).");
    }

    const factById = new Map(allFactsRes.rows.map((f) => [f.id, f] as const));

    const factRequirementRes = await pool.query<{ profile_fact_id: string; requirement_key: string }>(
      `SELECT rem.profile_fact_id, jr.requirement_key
       FROM requirement_evidence_matches rem
       JOIN job_requirements jr
         ON jr.workspace_id = rem.workspace_id
        AND jr.id = rem.requirement_id
       JOIN job_versions jv
         ON jv.workspace_id = jr.workspace_id
        AND jv.id = $2
       WHERE rem.workspace_id = $1
         AND rem.match_run_id = $3
         AND rem.profile_fact_id IS NOT NULL
         AND (
           (jv.active_requirement_set_id IS NOT NULL AND jr.requirement_set_id = jv.active_requirement_set_id)
           OR (jv.active_requirement_set_id IS NULL AND jr.job_version_id = jv.id)
         )`,
      [ctx.workspaceId, resolvedJobVersionId, matchRunId]
    );

    const requirementKeysByFactId = new Map<string, Set<string>>();
    for (const row of factRequirementRes.rows) {
      const set = requirementKeysByFactId.get(row.profile_fact_id) || new Set<string>();
      set.add(row.requirement_key);
      requirementKeysByFactId.set(row.profile_fact_id, set);
    }

    const eligibleMatches = matchesRes.rows
      .map((row) => ({
        ...row,
        match_score: Number(row.match_score),
      }))
      .filter((row) => !!row.profile_fact_id && row.match_type !== "NO_MATCH")
      .filter((row) => row.profile_fact_id != null && factById.has(row.profile_fact_id));

    eligibleMatches.sort((a, b) => {
      const imp = importanceRank(a.importance) - importanceRank(b.importance);
      if (imp !== 0) return imp;
      const mt = matchTypeRank(a.match_type) - matchTypeRank(b.match_type);
      if (mt !== 0) return mt;
      const score = Number(b.match_score) - Number(a.match_score);
      if (score !== 0) return score;
      const ea = factById.get(a.profile_fact_id as string);
      const eb = factById.get(b.profile_fact_id as string);
      return evidenceTierRank(ea?.evidence_tier || "") - evidenceTierRank(eb?.evidence_tier || "");
    });

    const snapshotItems = [];
    for (const row of eligibleMatches) {
      if (snapshotItems.length >= 4) break;
      const fact = factById.get(row.profile_fact_id as string);
      if (!fact) continue;
      const statement = String(fact.statement || "").trim();
      if (statement.length < 40) continue;
      snapshotItems.push({
        requirement_id: row.requirement_key,
        requirement_label: row.requirement_key,
        display_match_label: pickDisplayMatchLabel(row.match_type, fact.evidence_tier),
        evidence_statement: clampText(statement, 280),
        profile_fact_ids: [fact.id],
        keywords_used: [],
      });
    }

    if (snapshotItems.length < 4) {
      throw new Error(
        `Insufficient grounded matches for Role Alignment Snapshot (need 4 items, have ${snapshotItems.length}). Ensure embeddings are published and deterministic matching has high-quality matches.`
      );
    }

    const engagementsRes = await pool.query<EngagementRow>(
      `SELECT
         pe.id,
         pe.engagement_key,
         pe.organization_legal_name,
         pe.brand_or_program_name,
         pe.role_title,
         pe.operating_model,
         pe.start_date,
         pe.end_date,
         pe.is_current,
         pe.summary
       FROM profile_engagements pe
       WHERE pe.workspace_id = $1
         AND pe.profile_version_id = $2
       ORDER BY pe.start_date DESC, pe.created_at DESC`,
      [ctx.workspaceId, profileVersionId]
    );

    const factsByEngagementId = new Map<string, ProfileFactRow[]>();
    for (const fact of allFactsRes.rows) {
      if (!fact.engagement_id) continue;
      const list = factsByEngagementId.get(fact.engagement_id) || [];
      list.push(fact);
      factsByEngagementId.set(fact.engagement_id, list);
    }

    const experience = engagementsRes.rows.map((engagement) => {
      const employerPrimary = (engagement.brand_or_program_name || "").trim() || engagement.organization_legal_name;
      const employerContext =
        engagement.brand_or_program_name && engagement.brand_or_program_name.trim() !== engagement.organization_legal_name.trim()
          ? engagement.organization_legal_name
          : null;

      const facts = factsByEngagementId.get(engagement.id) || [];
      facts.sort((a, b) => {
        const tier = evidenceTierRank(a.evidence_tier) - evidenceTierRank(b.evidence_tier);
        if (tier !== 0) return tier;
        return String(a.created_at).localeCompare(String(b.created_at));
      });

      const achievements = facts.slice(0, 6).map((fact) => ({
        text: String(fact.statement || "").trim(),
        profile_fact_ids: [fact.id],
        requirement_ids: Array.from(requirementKeysByFactId.get(fact.id) || []),
        keywords_used: [],
      }));

      return {
        role_id: engagement.engagement_key,
        employer: employerPrimary,
        ...(employerContext ? { employer_context: employerContext } : {}),
        title: engagement.role_title,
        date_display: formatDateDisplay({
          start: engagement.start_date,
          end: engagement.end_date,
          isCurrent: Boolean(engagement.is_current),
        }),
        scope_statement: String(engagement.summary || "").trim(),
        achievements,
      };
    });

    const conceptRes = await pool.query<{ canonical_label: string; n: number }>(
      `SELECT tc.canonical_label, COUNT(*)::int AS n
       FROM profile_fact_concepts pfc
       JOIN profile_facts pf
         ON pf.workspace_id = pfc.workspace_id
        AND pf.id = pfc.profile_fact_id
       JOIN taxonomy_concepts tc
         ON tc.id = pfc.concept_id
       WHERE pfc.workspace_id = $1
         AND pf.profile_version_id = $2
         AND pf.fact_type <> 'CONTACT'
         AND pf.confidentiality IN ('PUBLIC', 'PRIVATE_REUSABLE')
         AND tc.active = TRUE
       GROUP BY tc.canonical_label
       ORDER BY n DESC, tc.canonical_label ASC
       LIMIT 20`,
      [ctx.workspaceId, profileVersionId]
    );

    const expertiseCandidates: string[] = [];
    for (const row of conceptRes.rows) {
      const label = String(row.canonical_label || "").trim();
      if (label) expertiseCandidates.push(label);
    }

    const structuredTokens: string[] = [];
    for (const fact of allFactsRes.rows) {
      collectStringLeaves(fact.structured_value, structuredTokens);
    }
    for (const token of structuredTokens) {
      const label = labelizeToken(token);
      if (label) expertiseCandidates.push(label);
    }

    const coreExpertise = Array.from(new Set(expertiseCandidates)).slice(0, 14);
    if (coreExpertise.length < 8) {
      throw new Error(
        `Insufficient core_expertise terms derived from profile facts (need >=8, have ${coreExpertise.length}). Add taxonomy concept links or structured_value tags to profile facts.`
      );
    }

    const signatureFactIds = Array.from(
      new Set(snapshotItems.flatMap((item) => item.profile_fact_ids))
    ).slice(0, 5);
    if (signatureFactIds.length < 3) {
      throw new Error("Insufficient signature_fact_ids derived from the role alignment snapshot.");
    }

    const leadershipThemes = coreExpertise.slice(0, 4);
    if (leadershipThemes.length < 2) {
      throw new Error("Insufficient leadership_themes derived from profile expertise.");
    }

    const keywordPlan = coreExpertise.slice(0, 8).map((term) => ({
      term,
      profile_fact_ids: signatureFactIds,
    }));

    const requirementCoverage = requirementsRes.rows.map((req) => {
      const match = matchesRes.rows.find((m) => m.requirement_id === req.id);
      const matchType = String(match?.match_type || "NO_MATCH");
      const status =
        matchType === "EXACT" || matchType === "SEMANTIC"
          ? "covered"
          : matchType === "UNKNOWN"
            ? "partially_covered"
            : "gap";
      return { requirement_id: req.requirement_key, status };
    });

    const exportDir = path.join(process.cwd(), "scripts", "exports");
    fs.mkdirSync(exportDir, { recursive: true });

    const safeTitle = safeSegment(jdTitle, 20);
    const safeCompany = safeSegment(jdCompany, 20);
    const safeCandidate = safeSegment(contactInfo.full_name, 20);
    const baseFilename = `${safeCandidate}_${safeCompany}_${safeTitle}`;

    const finalCv = {
      metadata: {
        schema_version: "2.2.0",
        job_id: jobId,
        job_version_id: resolvedJobVersionId,
        target_title: jdTitle,
        target_company: jdCompany,
        profile_version: profileVersionNumber,
        document_variant: "ats_application",
        page_target: 2,
        output_basename: baseFilename,
      },
      strategy: {
        positioning_statement: `Evidence-grounded CV tailored for ${jdTitle} at ${jdCompany}.`,
        leadership_themes: leadershipThemes.slice(0, 4),
        signature_fact_ids: signatureFactIds,
        keyword_plan: keywordPlan,
        prohibited_claims: [],
      },
      cv: {
        contact: {
          full_name: contactInfo.full_name,
          location: contactInfo.location,
          email: contactInfo.email,
          phone: contactInfo.phone,
          ...(typeof contactInfo.linkedin === "string" && contactInfo.linkedin.trim().length > 0 ? { linkedin: contactInfo.linkedin } : {}),
          ...(typeof contactInfo.work_authorisation === "string" && contactInfo.work_authorisation.trim().length > 0
            ? { work_authorisation: contactInfo.work_authorisation }
            : {}),
        },
        headline: `${jdTitle} — Evidence-grounded application CV`,
        executive_summary: clampText(
          `This CV is generated from validated profile facts and an explicit requirement-to-evidence match map for ${jdCompany}. It highlights verified evidence for the role’s highest-signal requirements.`,
          800
        ),
        core_expertise: coreExpertise,
        role_alignment_snapshot: {
          heading: "Role Alignment Snapshot",
          target_role: jdTitle,
          target_company: jdCompany,
          items: snapshotItems,
        },
        experience,
        education: [],
      },
      validation: {
        unsupported_claims: [],
        grounding_coverage_percentage: 100,
        chronology_issues: [],
        requirement_coverage: requirementCoverage,
        human_review_questions: [
          "Confirm contact details are correct.",
          "Confirm no PRIVATE_INTERNAL facts were included.",
          "Confirm the Role Alignment Snapshot items are appropriate for this role.",
        ],
      },
    };

    validateAgainstSchema(finalCv, tailoredCvSchema, "tailored_cv.schema.json");
    ensureKnownEvidenceIds(finalCv, knownFactIds);

    const jsonPath = path.join(exportDir, `${baseFilename}.cv.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(finalCv, null, 2));

    const docxPath = path.join(exportDir, `${baseFilename}.docx`);
    await generateDocx(finalCv, docxPath);
    if (!fs.existsSync(docxPath)) {
      throw new Error("CV DOCX renderer completed without creating the required DOCX artifact.");
    }

    const pdfPath = path.join(exportDir, `${baseFilename}.pdf`);
    await generatePdf(docxPath, pdfPath);
    const pdfCreated = fs.existsSync(pdfPath);

    const pluginRevision = await getActiveDocumentTemplatePluginRevision("CV", pool, { context: ctx });
    const claims = collectCvClaims(finalCv);
    const provenance = await persistDocumentProvenance(
      {
        applicationRecordId,
        canonicalJobId: jobId,
        jobVersionId: resolvedJobVersionId,
        matchRunId: matchRunId,
        profileVersionId: profileVersionId,
        deterministicDecisionId: job.deterministic_decision_id,
        contextFingerprint: job.decision_context_fingerprint,
        documentType: "CV",
        policyVersion: "documents_v2",
        generatorVersion: "cv_generator_deterministic_v1",
        modelRouteInvocationId: null,
        documentTemplatePluginRevisionId: pluginRevision?.revisionId ?? null,
        documentTemplatePluginKey: pluginRevision?.pluginKey ?? null,
        outputManifest: {
          schema_version: "document_output_manifest_v1",
          json_path: jsonPath,
          docx_path: docxPath,
          docx_sha256: crypto.createHash("sha256").update(fs.readFileSync(docxPath)).digest("hex"),
          pdf_path: pdfCreated ? pdfPath : null,
          pdf_sha256: pdfCreated ? crypto.createHash("sha256").update(fs.readFileSync(pdfPath)).digest("hex") : null,
        },
        claims,
      },
      pool,
      { context: ctx }
    );

    console.log(`CV Generation Complete:
  JSON : ${jsonPath}
  DOCX : ${docxPath}
  PDF  : ${pdfCreated ? pdfPath : "NOT CREATED (no Word/LibreOffice in environment)"}
  document_run_id: ${provenance.documentRunId} (claims: ${provenance.claimCount})`);
    console.log(JSON.stringify({
      event: "DOCUMENT_GENERATION_COMPLETED",
      documentType: "CV",
      applicationRecordId,
      documentRunId: provenance.documentRunId,
      canonicalJobId: jobId,
      jobVersionId: resolvedJobVersionId,
      profileVersionId,
      deterministicDecisionId: job.deterministic_decision_id,
      contextFingerprint: job.decision_context_fingerprint,
      templateRevisionId: pluginRevision?.revisionId ?? null,
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
  } finally {
    await pool.end();
  }
}

generateTailoredCV().catch((err: any) => {
  console.error("Error generating tailored CV:", err?.message || err);
  process.exit(1);
});
