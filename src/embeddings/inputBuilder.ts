import crypto from 'crypto';
import pg from 'pg';
import dotenv from 'dotenv';
import { pgSslConfig } from '../db/pgSsl.js';

dotenv.config();
dotenv.config({ path: '.env.local' });

const defaultPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: pgSslConfig(process.env.DATABASE_URL),
});

export interface EmbeddingInputBuildSummary {
  inserted: number;
  fromRequirements: number;
  fromProfileFacts: number;
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

export async function buildEmbeddingInputs(
  clientOrPool?: pg.Pool | pg.PoolClient,
  maxPerSource = 200
): Promise<EmbeddingInputBuildSummary> {
  const pool = clientOrPool || defaultPool;
  const client = 'connect' in pool ? await pool.connect() : pool;

  let inserted = 0;
  let fromRequirements = 0;
  let fromProfileFacts = 0;

  try {
    await client.query('BEGIN');

    const reqRows = await client.query<{
      id: string;
      requirement_type: string;
      requirement_text: string;
      quote_text: string | null;
      structured_value: unknown;
    }>(
      `SELECT jr.id, jr.requirement_type, jr.requirement_text, jr.quote_text, jr.structured_value
       FROM job_requirements jr
       WHERE jr.status = 'VALIDATED'
         AND NOT EXISTS (
           SELECT 1
           FROM embedding_inputs ei
           WHERE ei.source_type = 'JOB_REQUIREMENT'
             AND ei.source_id = jr.id
         )
       ORDER BY jr.created_at ASC
       LIMIT $1`,
      [maxPerSource]
    );

    for (const row of reqRows.rows) {
      const contentText = buildRequirementInputText(row);
      const contentHash = hashText(contentText);
      const inputKey = `req:${row.id}:${contentHash.slice(0, 16)}`;

      await client.query(
        `INSERT INTO embedding_inputs (
           input_key,
           source_type,
           source_id,
           content_text,
           content_hash
         )
         VALUES ($1, 'JOB_REQUIREMENT', $2, $3, $4)
         ON CONFLICT (input_key) DO NOTHING`,
        [inputKey, row.id, contentText, contentHash]
      );

      inserted += 1;
      fromRequirements += 1;
    }

    const factRows = await client.query<{
      id: string;
      fact_type: string;
      statement: string;
      structured_value: unknown;
      evidence_tier: string;
    }>(
      `SELECT pf.id, pf.fact_type, pf.statement, pf.structured_value, pf.evidence_tier
       FROM profile_facts pf
       WHERE NOT EXISTS (
           SELECT 1
           FROM embedding_inputs ei
           WHERE ei.source_type = 'PROFILE_FACT'
             AND ei.source_id = pf.id
       )
       ORDER BY pf.created_at ASC
       LIMIT $1`,
      [maxPerSource]
    );

    for (const row of factRows.rows) {
      const contentText = buildProfileFactInputText(row);
      const contentHash = hashText(contentText);
      const inputKey = `fact:${row.id}:${contentHash.slice(0, 16)}`;

      await client.query(
        `INSERT INTO embedding_inputs (
           input_key,
           source_type,
           source_id,
           content_text,
           content_hash
         )
         VALUES ($1, 'PROFILE_FACT', $2, $3, $4)
         ON CONFLICT (input_key) DO NOTHING`,
        [inputKey, row.id, contentText, contentHash]
      );

      inserted += 1;
      fromProfileFacts += 1;
    }

    await client.query('COMMIT');

    return {
      inserted,
      fromRequirements,
      fromProfileFacts,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    if ('release' in client && typeof client.release === 'function') {
      client.release();
    }
  }
}
