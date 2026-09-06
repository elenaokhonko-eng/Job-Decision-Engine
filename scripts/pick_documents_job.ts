import pg from "pg";
import dotenv from "dotenv";
import { pgSslConfig } from "../src/db/pgSsl.js";
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

type CandidateRow = {
  canonical_job_id: string;
  job_version_id: string;
  company_name: string | null;
  normalized_title: string | null;
  observed_at: string | null;
  grounded_match_facts: number;
};

async function main(): Promise<void> {
  const databaseUrl = requireEnv("DATABASE_URL");
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: pgSslConfig(databaseUrl),
  });

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
          c.latest_match_run_id
        FROM canonical_jobs c
        WHERE c.workspace_id = $1
          AND c.latest_match_run_id IS NOT NULL
          AND COALESCE(c.recommendation_outcome, '') <> 'SKIP'
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
      JOIN job_versions jv
        ON jv.workspace_id = $1
       AND jv.id = r.job_version_id
      JOIN job_requirements jr
        ON jr.workspace_id = jv.workspace_id
       AND (
         (jv.active_requirement_set_id IS NOT NULL AND jr.requirement_set_id = jv.active_requirement_set_id)
         OR (jv.active_requirement_set_id IS NULL AND jr.job_version_id = jv.id)
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
      console.log("Requirements:");
      console.log("- canonical_jobs.latest_match_run_id must be set");
      console.log("- match_runs.profile_version_id must equal the ACTIVE profile_version");
      console.log("- VALIDATED job_requirements must exist");
      console.log("- >= 4 grounded matches to non-private profile facts must exist");
      process.exitCode = 1;
      return;
    }

    const [best] = candidates.rows;
    console.log("Recommended Documents Generator inputs:");
    console.log(`canonical_job_id: ${best.canonical_job_id}`);
    console.log(`job_version_id:   ${best.job_version_id}`);
    console.log("");
    console.log("Other eligible jobs:");
    for (const row of candidates.rows) {
      const title = row.normalized_title || "Unknown Role";
      const company = row.company_name || "Unknown Company";
      const observed = row.observed_at || "unknown";
      console.log(
        `- ${row.canonical_job_id}  ${row.job_version_id}  (${row.grounded_match_facts} facts)  ${company} — ${title}  @ ${observed}`
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

