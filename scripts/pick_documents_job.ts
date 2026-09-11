import pg from "pg";
import dotenv from "dotenv";
import { pgConnectionConfig } from "../src/db/pgSsl.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function parseBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

type CandidateRow = {
  canonical_job_id: string;
  job_version_id: string;
  company_name: string | null;
  normalized_title: string | null;
  observed_at: string | null;
  grounded_match_facts: number;
};

type DiagnosticsRow = {
  canonical_total: number;
  lane_routed: number;
  matched: number;
  canonical_with_match: number;
  match_runs_for_active_profile: number;
  current_matches_for_active_profile: number;
  validated_requirements: number;
  active_profile_facts_total: number;
  active_profile_facts_public_long: number;
  grounded_match_rows_for_active_profile: number;
};

async function main(): Promise<void> {
  const databaseUrl = requireEnv("DATABASE_URL");
  const allowEmptyAutoPick = parseBooleanEnv("PICK_DOCUMENTS_ALLOW_EMPTY", false);
  const pool = new pg.Pool(pgConnectionConfig(databaseUrl));

  try {
    const ctx = await resolveWorkspaceContext(pool as any);

    const activeProfileRes = await pool.query<{ id: string }>(
      `SELECT pv.id
       FROM profile_versions pv
       WHERE pv.workspace_id = $1
         AND pv.status = 'ACTIVE'
       ORDER BY pv.created_at DESC
       LIMIT 1`,
      [ctx.workspaceId]
    );
    const activeProfileVersionId = activeProfileRes.rows[0]?.id;
    if (!activeProfileVersionId) {
      throw new Error(
        "No ACTIVE profile_versions row found. Import and activate a profile before generating documents."
      );
    }

    const candidates = await pool.query<CandidateRow>(
      `
      WITH resolved_jobs AS (
        SELECT
          c.id AS canonical_job_id,
          COALESCE(
            c.latest_job_version_id,
            (
              SELECT jv2.id
              FROM job_versions jv2
              WHERE jv2.workspace_id = c.workspace_id
                AND jv2.canonical_job_id = c.id
              ORDER BY jv2.observed_at DESC
              LIMIT 1
            )
          ) AS job_version_id,
          c.company_name,
          c.normalized_title,
          c.latest_match_run_id,
          c.recommendation_eligibility,
          c.recommendation_outcome
        FROM canonical_jobs c
        WHERE c.workspace_id = $1
          AND c.latest_match_run_id IS NOT NULL
          AND c.recommendation_eligibility = 'ELIGIBLE'
          AND c.recommendation_outcome IN ('PRIORITY', 'REVIEW')
      )
      SELECT
        r.canonical_job_id,
        r.job_version_id,
        r.company_name,
        r.normalized_title,
        jv.observed_at::text AS observed_at,
        COUNT(DISTINCT pf.id)::int AS grounded_match_facts
      FROM resolved_jobs r
      JOIN match_runs mr
        ON mr.workspace_id = $1
       AND mr.id = r.latest_match_run_id
       AND mr.profile_version_id = $2
       AND mr.job_version_id = r.job_version_id
       AND mr.requirement_set_id = jv.active_requirement_set_id
       AND mr.job_content_hash = jv.content_hash
       AND mr.status = 'COMPLETED'
       AND COALESCE(mr.matched_count, 0) > 0
      JOIN job_versions jv
        ON jv.workspace_id = $1
       AND jv.id = r.job_version_id
      JOIN job_requirements jr
        ON jr.workspace_id = jv.workspace_id
       AND (
         jv.active_requirement_set_id IS NOT NULL
         AND jr.requirement_set_id = jv.active_requirement_set_id
       )
       AND jr.status = 'VALIDATED'
      JOIN requirement_evidence_matches rem
        ON rem.workspace_id = jr.workspace_id
       AND rem.match_run_id = mr.id
       AND rem.requirement_id = jr.id
       AND rem.profile_fact_id IS NOT NULL
       AND rem.match_type <> 'NO_MATCH'
      JOIN profile_facts pf
        ON pf.workspace_id = $1
       AND pf.profile_version_id = $2
       AND pf.id = rem.profile_fact_id
       AND pf.confidentiality <> 'PRIVATE_INTERNAL'
       AND length(pf.statement) >= 40
      GROUP BY
        r.canonical_job_id,
        r.job_version_id,
        r.company_name,
        r.normalized_title,
        jv.observed_at
      HAVING COUNT(DISTINCT pf.id) >= 4
      ORDER BY jv.observed_at DESC NULLS LAST
      LIMIT 10
      `,
      [ctx.workspaceId, activeProfileVersionId]
    );

    if (candidates.rows.length === 0) {
      console.log("No eligible jobs found for documents generation.");

      try {
        const diagnostics = await pool.query<DiagnosticsRow>(
          `
          SELECT
            (SELECT COUNT(*)::int FROM canonical_jobs c WHERE c.workspace_id = $1) AS canonical_total,
            (SELECT COUNT(*)::int FROM canonical_jobs c WHERE c.workspace_id = $1 AND COALESCE(c.processing_state, c.processing_status) = 'LANE_ROUTED') AS lane_routed,
            (SELECT COUNT(*)::int
             FROM canonical_jobs c
             JOIN match_runs mr ON mr.workspace_id = c.workspace_id AND mr.id = c.latest_match_run_id
             WHERE c.workspace_id = $1
               AND COALESCE(c.processing_state, c.processing_status) = 'MATCHED'
               AND COALESCE(mr.matched_count, 0) > 0) AS matched,
            (SELECT COUNT(*)::int FROM canonical_jobs c WHERE c.workspace_id = $1 AND c.latest_match_run_id IS NOT NULL) AS canonical_with_match,
            (SELECT COUNT(*)::int FROM match_runs mr WHERE mr.workspace_id = $1 AND mr.profile_version_id = $2) AS match_runs_for_active_profile,
            (SELECT COUNT(*)::int
             FROM canonical_jobs c
             JOIN job_versions jv ON jv.workspace_id = c.workspace_id AND jv.id = c.latest_job_version_id
             JOIN match_runs mr
               ON mr.workspace_id = c.workspace_id
              AND mr.id = c.latest_match_run_id
              AND mr.profile_version_id = $2
              AND mr.job_version_id = jv.id
              AND mr.requirement_set_id = jv.active_requirement_set_id
              AND mr.job_content_hash = jv.content_hash
              AND mr.status = 'COMPLETED'
              AND COALESCE(mr.matched_count, 0) > 0
             WHERE c.workspace_id = $1) AS current_matches_for_active_profile,
            (SELECT COUNT(*)::int FROM job_requirements jr WHERE jr.workspace_id = $1 AND jr.status = 'VALIDATED') AS validated_requirements,
            (SELECT COUNT(*)::int FROM profile_facts pf WHERE pf.workspace_id = $1 AND pf.profile_version_id = $2) AS active_profile_facts_total,
            (SELECT COUNT(*)::int FROM profile_facts pf WHERE pf.workspace_id = $1 AND pf.profile_version_id = $2 AND pf.confidentiality <> 'PRIVATE_INTERNAL' AND length(pf.statement) >= 40) AS active_profile_facts_public_long,
            (SELECT COUNT(*)::int
             FROM requirement_evidence_matches rem
             JOIN match_runs mr
               ON mr.workspace_id = rem.workspace_id
              AND mr.id = rem.match_run_id
              AND mr.profile_version_id = $2
             WHERE rem.workspace_id = $1
               AND rem.profile_fact_id IS NOT NULL
               AND rem.match_type <> 'NO_MATCH'
            ) AS grounded_match_rows_for_active_profile
          `,
          [ctx.workspaceId, activeProfileVersionId]
        );

        const row = diagnostics.rows[0];
        console.log("\nDiagnostics:");
        console.log(
          JSON.stringify(
            {
              workspace_id: ctx.workspaceId,
              active_profile_version_id: activeProfileVersionId,
              canonical_total: row?.canonical_total ?? 0,
              lane_routed: row?.lane_routed ?? 0,
              matched: row?.matched ?? 0,
              canonical_with_latest_match_run_id: row?.canonical_with_match ?? 0,
              match_runs_for_active_profile: row?.match_runs_for_active_profile ?? 0,
              current_matches_for_active_profile: row?.current_matches_for_active_profile ?? 0,
              validated_job_requirements: row?.validated_requirements ?? 0,
              active_profile_facts_total: row?.active_profile_facts_total ?? 0,
              active_profile_facts_non_private_len_ge_40: row?.active_profile_facts_public_long ?? 0,
              grounded_match_rows_for_active_profile: row?.grounded_match_rows_for_active_profile ?? 0,
            },
            null,
            2
          )
        );
      } catch (diagErr: any) {
        console.warn(
          `Diagnostics query failed (non-fatal): ${diagErr?.message || diagErr}`
        );
      }

      console.log("Requirements:");
      console.log("- canonical_jobs.latest_match_run_id must be set");
      console.log("- match_runs.profile_version_id must equal the ACTIVE profile_version");
      console.log("- latest match run must use the current job version, active requirement set, and content hash");
      console.log("- VALIDATED job_requirements must exist");
      console.log("- >= 4 grounded matches to non-private profile facts must exist");
      console.log("documents_job_found: false");
      process.exitCode = allowEmptyAutoPick ? 0 : 1;
      return;
    }

    const [best] = candidates.rows;
    console.log("Recommended Documents Generator inputs:");
    console.log("documents_job_found: true");
    console.log(`canonical_job_id: ${best.canonical_job_id}`);
    console.log(`job_version_id:   ${best.job_version_id}`);
    console.log("");
    console.log("Other eligible jobs:");
    for (const row of candidates.rows) {
      const title = row.normalized_title || "Unknown Role";
      const company = row.company_name || "Unknown Company";
      const observed = row.observed_at || "unknown";
      console.log(
        `- ${row.canonical_job_id}  ${row.job_version_id}  (${row.grounded_match_facts} facts)  ${company} - ${title}  @ ${observed}`
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: any) => {
  console.error(err?.message || err);
  process.exit(1);
});
