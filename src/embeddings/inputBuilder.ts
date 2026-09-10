import crypto from 'crypto';
import pg from 'pg';
import dotenv from 'dotenv';
import { pgPoolConfig } from '../db/pgSsl.js';
import { resolveWorkspaceContext, type WorkspaceContext } from '../workspace/context.js';
import { listActiveLaneRevisions } from '../lanes/registry.js';
import type { LaneFileConfig } from '../lanes/contracts.js';

dotenv.config();
dotenv.config({ path: '.env.local' });

const defaultPool = new pg.Pool(pgPoolConfig(process.env.DATABASE_URL));

export interface EmbeddingInputBuildSummary {
  inserted: number;
  fromRequirements: number;
  fromProfileFacts: number;
  fromJobVersions?: number;
  fromLanePrototypes?: number;
}

function hashText(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function buildRequirementInputText(row: {
  requirement_type: string;
  requirement_text: string;
  quote_text: string | null;
  structured_value: unknown;
}): string {
  const quote = row.quote_text ? ` Quote: ${row.quote_text}` : '';
  const structured = row.structured_value ? ` Structured: ${JSON.stringify(row.structured_value)}` : '';
  return `${row.requirement_type}: ${row.requirement_text}${quote}${structured}`.trim();
}

function buildProfileFactInputText(row: {
  fact_type: string;
  statement: string;
  structured_value: unknown;
  evidence_tier: string;
}): string {
  const structured = row.structured_value ? ` Structured: ${JSON.stringify(row.structured_value)}` : '';
  return `${row.fact_type} (${row.evidence_tier}): ${row.statement}${structured}`.trim();
}

function buildLanePrototypeInputText(lane: LaneFileConfig): string {
  const prototypeTexts = (lane.prototypes || [])
    .map((p) => (typeof p?.text === 'string' ? p.text.trim() : ''))
    .filter((p) => p.length > 0);
  return (prototypeTexts.join(' ') || lane.description || lane.display_name || lane.lane_key).trim();
}

function buildJobVersionInputText(row: { normalized_title: string; description_text: string }): string {
  return `${row.normalized_title}: ${row.description_text}`.trim().slice(0, 12000);
}

export async function buildEmbeddingInputs(
  clientOrPool?: pg.Pool | pg.PoolClient,
  maxPerSource = 200,
  options?: {
    context?: WorkspaceContext;
    jobVersionIds?: string[];
    includeProfileFacts?: boolean;
    includeLanePrototypes?: boolean;
  }
): Promise<EmbeddingInputBuildSummary> {
  const pool = clientOrPool || defaultPool;
  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === 'function' && !('release' in value);
  const ownsClient = isPool(pool);
  const client = ownsClient ? await pool.connect() : pool;

  let inserted = 0;
  let fromRequirements = 0;
  let fromProfileFacts = 0;
  let fromJobVersions = 0;
  let fromLanePrototypes = 0;

  try {
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));
    const jobVersionIds = options?.jobVersionIds?.filter(Boolean) ?? [];
    const scopedToJobVersions = jobVersionIds.length > 0;
    const includeProfileFacts = options?.includeProfileFacts ?? !scopedToJobVersions;
    const includeLanePrototypes = options?.includeLanePrototypes ?? true;

    await client.query('BEGIN');

    const requirementParams: unknown[] = [ctx.workspaceId, maxPerSource];
    const requirementScope = scopedToJobVersions
      ? `AND jv.id = ANY($${requirementParams.push(jobVersionIds)}::uuid[])`
      : '';
    const reqRows = await client.query<{
      id: string;
      requirement_type: string;
      requirement_text: string;
      quote_text: string | null;
      structured_value: unknown;
    }>(
      `SELECT jr.id, jr.requirement_type, jr.requirement_text, jr.quote_text, jr.structured_value
       FROM job_requirements jr
       JOIN job_versions jv
         ON jv.workspace_id = jr.workspace_id
        AND jv.id = jr.job_version_id
       WHERE jr.workspace_id = $1
         AND jr.status = 'VALIDATED'
         ${requirementScope}
         AND (
           jv.active_requirement_set_id IS NULL
           OR jr.requirement_set_id = jv.active_requirement_set_id
         )
         AND NOT EXISTS (
           SELECT 1
           FROM embedding_inputs ei
           WHERE ei.workspace_id = $1
             AND ei.source_type = 'JOB_REQUIREMENT'
             AND ei.source_id = jr.id
         )
       ORDER BY jr.created_at ASC
       LIMIT $2`,
      requirementParams
    );

    for (const row of reqRows.rows) {
      const contentText = buildRequirementInputText(row);
      const contentHash = hashText(contentText);
      const inputKey = `req:${row.id}:${contentHash.slice(0, 16)}`;

      await client.query(
        `INSERT INTO embedding_inputs (
           workspace_id,
           input_key,
           source_type,
           source_id,
           content_text,
           content_hash
         )
         VALUES ($1, $2, 'JOB_REQUIREMENT', $3, $4, $5)
         ON CONFLICT (workspace_id, input_key) DO NOTHING`,
        [ctx.workspaceId, inputKey, row.id, contentText, contentHash]
      );

      inserted += 1;
      fromRequirements += 1;
    }

    if (includeProfileFacts) {
      const factRows = await client.query<{
        id: string;
        embedding_node_id?: string;
        fact_type: string;
        statement: string;
        structured_value: unknown;
        evidence_tier: string;
      }>(
        `SELECT pf.id, COALESCE(pf.fact_revision_id, pf.id) AS embedding_node_id,
                pf.fact_type, pf.statement, pf.structured_value, pf.evidence_tier
         FROM profile_facts pf
         JOIN profile_versions pv
           ON pv.workspace_id = pf.workspace_id
          AND pv.id = pf.profile_version_id
          AND pv.status = 'ACTIVE'
         WHERE pf.workspace_id = $1
           AND NOT EXISTS (
             SELECT 1
             FROM embedding_inputs ei
             WHERE ei.workspace_id = $1
               AND ei.source_type = 'PROFILE_FACT'
               AND ei.source_id = COALESCE(pf.fact_revision_id, pf.id)
         )
         ORDER BY pf.created_at ASC
         LIMIT $2`,
        [ctx.workspaceId, maxPerSource]
      );

      for (const row of factRows.rows) {
        const contentText = buildProfileFactInputText(row);
        const contentHash = hashText(contentText);
        const embeddingNodeId = row.embedding_node_id || row.id;
        const inputKey = `fact:${embeddingNodeId}:${contentHash.slice(0, 16)}`;

        await client.query(
          `INSERT INTO embedding_inputs (
             workspace_id,
             input_key,
             source_type,
             source_id,
             content_text,
             content_hash
           )
           VALUES ($1, $2, 'PROFILE_FACT', $3, $4, $5)
           ON CONFLICT (workspace_id, input_key) DO NOTHING`,
          [ctx.workspaceId, inputKey, embeddingNodeId, contentText, contentHash]
        );

        inserted += 1;
        fromProfileFacts += 1;
      }
    }

    const jobParams: unknown[] = [ctx.workspaceId, maxPerSource];
    const jobScope = scopedToJobVersions
      ? `AND jv.id = ANY($${jobParams.push(jobVersionIds)}::uuid[])`
      : '';
    const jobRows = await client.query<{
      id: string;
      normalized_title: string;
      description_text: string;
    }>(
      `SELECT
              jv.id,
              c.normalized_title,
              jv.description_text
       FROM canonical_jobs c
       JOIN job_versions jv
         ON jv.workspace_id = c.workspace_id
        AND jv.canonical_job_id = c.id
        AND jv.id = COALESCE(
          c.latest_job_version_id,
          (
            SELECT jv2.id
            FROM job_versions jv2
            WHERE jv2.workspace_id = c.workspace_id
              AND jv2.canonical_job_id = c.id
            ORDER BY jv2.observed_at DESC
            LIMIT 1
          )
       )
       WHERE c.workspace_id = $1
          AND (
            $${jobParams.length + 1}::boolean = TRUE
            OR COALESCE(c.processing_state, c.processing_status) IN ('RAW_STAGED', 'PREQUALIFIED', 'LANE_ROUTED', 'ROUTING_DEFERRED', 'MATCHED')
          )
         ${jobScope}
         AND jv.description_text IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
           FROM embedding_inputs ei
           WHERE ei.workspace_id = $1
             AND ei.source_type = 'JOB_VERSION'
             AND ei.source_id = jv.id
         )
       ORDER BY jv.observed_at DESC
       LIMIT $2`,
      [...jobParams, scopedToJobVersions]
    );

    for (const row of jobRows.rows) {
      const contentText = buildJobVersionInputText(row);
      const contentHash = hashText(contentText);
      const inputKey = `job:${row.id}:${contentHash.slice(0, 16)}`;
      await client.query(
        `INSERT INTO embedding_inputs (
           workspace_id, input_key, source_type, source_id, content_text, content_hash
         ) VALUES ($1, $2, 'JOB_VERSION', $3, $4, $5)
         ON CONFLICT (workspace_id, input_key) DO NOTHING`,
        [ctx.workspaceId, inputKey, row.id, contentText, contentHash]
      );
      inserted += 1;
      fromJobVersions += 1;
    }

    await client.query('COMMIT');

    // Lane prototypes are optional and depend on dynamic-lanes migrations.
    // Never let missing lane registry tables abort the entire embedding-input build.
    if (!includeLanePrototypes) {
      return {
        inserted,
        fromRequirements,
        fromProfileFacts,
        fromJobVersions,
        fromLanePrototypes,
      };
    }

    try {
      const activeLanes = await listActiveLaneRevisions(client as any, { context: ctx });
      for (const lane of activeLanes) {
        const contentText = buildLanePrototypeInputText(lane.content);
        const contentHash = hashText(contentText);
        const inputKey = `lane:${lane.laneRevisionId}:${contentHash.slice(0, 16)}`;

        await client.query(
          `INSERT INTO embedding_inputs (
             workspace_id,
             input_key,
             source_type,
             source_id,
             content_text,
             content_hash
           )
           VALUES ($1, $2, 'LANE_PROTOTYPE', $3, $4, $5)
           ON CONFLICT (workspace_id, input_key) DO NOTHING`,
          [ctx.workspaceId, inputKey, lane.laneRevisionId, contentText, contentHash]
        );

        inserted += 1;
        fromLanePrototypes += 1;
      }
    } catch (err: any) {
      // Allow running against pre-migration databases.
      if (err?.code !== '42P01') {
        throw err;
      }
    }

    return {
      inserted,
      fromRequirements,
      fromProfileFacts,
      fromJobVersions,
      fromLanePrototypes,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    if (ownsClient && typeof client.release === 'function') {
      client.release();
    }
  }
}
