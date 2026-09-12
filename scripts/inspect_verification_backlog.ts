import dotenv from "dotenv";
import pg from "pg";
import { pgPoolConfig } from "../src/db/pgSsl.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const pool = new pg.Pool(pgPoolConfig(process.env.DATABASE_URL || ""));
const client = await pool.connect();
try {
  const ctx = await resolveWorkspaceContext(client as any);
  const queries: Record<string, pg.QueryResult> = {};

  queries.jobStates = await client.query(
    `SELECT COALESCE(c.processing_state, c.processing_status) AS state, count(*)::int AS count
       FROM canonical_jobs c
      WHERE c.workspace_id = $1
      GROUP BY 1 ORDER BY 1`,
    [ctx.workspaceId],
  );

  queries.verificationQuality = await client.query(
    `SELECT COALESCE(c.description_quality_status, CASE
              WHEN length(BTRIM(jv.description_text)) >= 1000 THEN 'COMPLETE'
              WHEN NULLIF(BTRIM(jv.description_text), '') IS NULL THEN 'UNKNOWN'
              ELSE 'INCOMPLETE' END) AS description_quality,
            count(*)::int AS jobs,
            round(avg(length(jv.description_text)))::int AS average_description_chars,
            min(length(jv.description_text))::int AS shortest_description_chars,
            max(length(jv.description_text))::int AS longest_description_chars
       FROM canonical_jobs c
       JOIN job_versions jv ON jv.workspace_id = c.workspace_id AND jv.id = c.latest_job_version_id
      WHERE c.workspace_id = $1
        AND COALESCE(c.processing_state, c.processing_status) = 'NEEDS_VERIFICATION'
      GROUP BY 1 ORDER BY 1`,
    [ctx.workspaceId],
  );

  queries.verificationReasons = await client.query(
    `SELECT gd.decision,
            code.value AS reason_code,
            count(DISTINCT c.id)::int AS jobs
       FROM canonical_jobs c
       JOIN job_versions jv ON jv.workspace_id = c.workspace_id AND jv.id = c.latest_job_version_id
       LEFT JOIN LATERAL (
         SELECT decision, rejection_codes
           FROM gate_decisions gd0
          WHERE gd0.workspace_id = c.workspace_id
            AND gd0.canonical_job_id = c.id
            AND gd0.job_version_id = jv.id
          ORDER BY gd0.created_at DESC, gd0.id DESC
          LIMIT 1
       ) gd ON TRUE
       LEFT JOIN LATERAL jsonb_array_elements_text(
         CASE WHEN jsonb_typeof(COALESCE(gd.rejection_codes, '[]'::jsonb)) = 'array'
              THEN COALESCE(gd.rejection_codes, '[]'::jsonb)
              ELSE '[]'::jsonb END
       ) code ON TRUE
      WHERE c.workspace_id = $1
        AND COALESCE(c.processing_state, c.processing_status) = 'NEEDS_VERIFICATION'
      GROUP BY gd.decision, code.value
      ORDER BY jobs DESC, reason_code`,
    [ctx.workspaceId],
  );

  queries.verificationRequirements = await client.query(
    `SELECT jr.requirement_type,
            jr.status,
            count(DISTINCT c.id)::int AS jobs,
            count(*)::int AS requirements
       FROM canonical_jobs c
       JOIN job_versions jv ON jv.workspace_id = c.workspace_id AND jv.id = c.latest_job_version_id
       JOIN job_requirements jr
         ON jr.workspace_id = jv.workspace_id
        AND jr.requirement_set_id = jv.active_requirement_set_id
      WHERE c.workspace_id = $1
        AND COALESCE(c.processing_state, c.processing_status) = 'NEEDS_VERIFICATION'
      GROUP BY jr.requirement_type, jr.status
      ORDER BY jr.requirement_type, jr.status`,
    [ctx.workspaceId],
  );

  queries.routingDeferred = await client.query(
    `SELECT COALESCE(c.routing_disposition, '<null>') AS routing_disposition,
            COALESCE(c.description_quality_status, '<null>') AS description_quality_status,
            count(*)::int AS jobs
       FROM canonical_jobs c
      WHERE c.workspace_id = $1
        AND COALESCE(c.processing_state, c.processing_status) = 'ROUTING_DEFERRED'
      GROUP BY 1, 2 ORDER BY jobs DESC`,
    [ctx.workspaceId],
  );

  queries.matchedCurrent = await client.query(
    `WITH active_profile AS (
      SELECT id FROM profile_versions
       WHERE workspace_id = $1 AND status = 'ACTIVE'
       ORDER BY created_at DESC LIMIT 1
    )
    SELECT COALESCE(c.processing_state, c.processing_status) AS state,
           count(*)::int AS jobs,
           count(*) FILTER (WHERE mr.status = 'COMPLETED' AND COALESCE(mr.matched_count, 0) > 0)::int AS latest_run_with_matches,
           count(*) FILTER (WHERE mr.profile_version_id = ap.id)::int AS latest_run_active_profile,
           count(*) FILTER (WHERE mr.profile_version_id = ap.id AND mr.job_version_id = jv.id AND mr.requirement_set_id = jv.active_requirement_set_id AND mr.job_content_hash = jv.content_hash AND mr.status = 'COMPLETED' AND COALESCE(mr.matched_count, 0) > 0)::int AS current_matches
      FROM canonical_jobs c
      JOIN job_versions jv ON jv.workspace_id = c.workspace_id AND jv.id = c.latest_job_version_id
      LEFT JOIN match_runs mr ON mr.workspace_id = c.workspace_id AND mr.id = c.latest_match_run_id
      CROSS JOIN active_profile ap
     WHERE c.workspace_id = $1
       AND COALESCE(c.processing_state, c.processing_status) = 'MATCHED'
     GROUP BY 1`,
    [ctx.workspaceId],
  );

  queries.profileEmbeddingCoverage = await client.query(
    `WITH active_profile AS (
      SELECT id FROM profile_versions
       WHERE workspace_id = $1 AND status = 'ACTIVE'
       ORDER BY created_at DESC LIMIT 1
    )
    SELECT es.space_key, es.provider, es.model, es.is_fallback_space,
           count(DISTINCT pf.id)::int AS profile_facts,
           count(DISTINCT ei.id)::int AS embedding_inputs,
           count(DISTINCT se.embedding_input_id)::int AS stored_embeddings,
           count(DISTINCT CASE WHEN eb.status = 'COMPLETED' AND ebi.status = 'COMPLETED' THEN se.embedding_input_id END)::int AS published_embeddings
      FROM embedding_spaces es
      CROSS JOIN active_profile ap
      LEFT JOIN profile_facts pf
        ON pf.workspace_id = es.workspace_id AND pf.profile_version_id = ap.id
      LEFT JOIN embedding_inputs ei
        ON ei.workspace_id = es.workspace_id AND ei.source_type = 'PROFILE_FACT' AND ei.source_id = pf.id
      LEFT JOIN semantic_embeddings se
        ON se.workspace_id = es.workspace_id AND se.embedding_space_id = es.id AND se.embedding_input_id = ei.id
      LEFT JOIN embedding_batches eb ON eb.workspace_id = se.workspace_id AND eb.id = se.embedding_batch_id
      LEFT JOIN embedding_batch_items ebi ON ebi.workspace_id = se.workspace_id AND ebi.embedding_batch_id = eb.id AND ebi.embedding_input_id = se.embedding_input_id
     WHERE es.workspace_id = $1 AND es.active = TRUE
     GROUP BY es.space_key, es.provider, es.model, es.is_fallback_space
     ORDER BY es.is_fallback_space, es.space_key`,
    [ctx.workspaceId],
  );

  console.log(JSON.stringify({
    workspace_id: ctx.workspaceId,
    active_profile_version_id: (await client.query(`SELECT id FROM profile_versions WHERE workspace_id = $1 AND status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1`, [ctx.workspaceId])).rows[0]?.id,
    job_states: queries.jobStates.rows,
    verification_description_quality: queries.verificationQuality.rows,
    verification_gate_reasons: queries.verificationReasons.rows,
    verification_requirement_types: queries.verificationRequirements.rows,
    routing_deferred: queries.routingDeferred.rows,
    matched_currentness: queries.matchedCurrent.rows,
    profile_embedding_coverage: queries.profileEmbeddingCoverage.rows,
  }, null, 2));
} finally {
  client.release();
  await pool.end();
}
