import { describe, it, expect } from 'vitest';
import pg from 'pg';
import { runMigrations } from '../../db/migrate.js';
import { runRequirementsExtraction } from '../../pipeline/requirementsExtractor.js';

const DB_URL = process.env.DATABASE_URL || '';
const isCI = DB_URL.includes('localhost') || DB_URL.includes('127.0.0.1');
const skipReal = !DB_URL || !isCI;

describe.skipIf(skipReal)('Requirements extraction integration (temporary schema)', () => {
  it('persists requirement rows, extraction runs, and stage events without duplicates on rerun', async () => {
    const pool = new pg.Pool({ connectionString: DB_URL });
    const client = await pool.connect();
    const schemaName = `req_stage_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

    try {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
      await client.query(`SET search_path TO ${schemaName}`);
      await runMigrations(client);

      const canonicalJobId = '90000000-0000-4000-8000-000000000001';
      const jobVersionId = '90000000-0000-4000-8000-000000000002';

      await client.query(
        `INSERT INTO canonical_jobs (id, company_name, normalized_title, canonical_url, processing_status)
         VALUES ($1, 'Integration Co', 'ml engineer', 'https://integration.example.com/job/1', 'RAW_STAGED')`,
        [canonicalJobId]
      );

      const description = [
        'Hybrid role with 2 days per week in office.',
        'Must have at least 5 years of experience.',
        'Work rights required.',
        'Machine learning engineer for data platform initiatives.',
      ].join(' ');

      await client.query(
        `INSERT INTO job_versions (id, canonical_job_id, content_hash, description_text, observed_at)
         VALUES ($1, $2, 'req-int-hash-1', $3, NOW())`,
        [jobVersionId, canonicalJobId, description]
      );

      await client.query(
        `UPDATE canonical_jobs SET latest_job_version_id = $1, updated_at = NOW() WHERE id = $2`,
        [jobVersionId, canonicalJobId]
      );

      const first = await runRequirementsExtraction(client, {
        quotedExtractor: async () => ({
          provider: 'gemini',
          model: 'gemini-2.5-flash',
          extractorVersion: 'quoted_test_v1',
          attempts: 1,
          errors: [],
          payload: {
            schema_version: '2.0',
            requirements: [
              {
                requirement_key: 'R-001',
                requirement_type: 'WORK_AUTH',
                importance: 'MUST',
                requirement_text: 'Candidate must have work rights.',
                quote_text: 'Work rights required',
                confidence: 0.9,
              },
            ],
          },
        }),
      });

      expect(first.discovered).toBe(1);
      expect(first.processed).toBe(1);
      expect(first.errors).toBe(0);
      expect(first.deterministicInserted).toBeGreaterThanOrEqual(4);
      expect(first.quotedInserted).toBe(1);

      const reqCount = (
        await client.query(
          `SELECT COUNT(*)::int AS n FROM job_requirements WHERE job_version_id = $1`,
          [jobVersionId]
        )
      ).rows[0].n as number;
      expect(reqCount).toBe(first.deterministicInserted + first.quotedInserted);

      const runRows = await client.query(
        `SELECT run_type, status, requirements_extracted
         FROM requirement_extraction_runs
         WHERE job_version_id = $1
         ORDER BY started_at ASC`,
        [jobVersionId]
      );
      expect(runRows.rows.length).toBe(2);
      expect(runRows.rows.some((r: any) => r.run_type === 'DETERMINISTIC' && r.status === 'COMPLETED')).toBe(true);
      expect(runRows.rows.some((r: any) => r.run_type === 'LLM_QUOTED' && r.status === 'COMPLETED')).toBe(true);

      const eventsRows = await client.query(
        `SELECT event_type, transition_to
         FROM pipeline_stage_events
         WHERE job_version_id = $1
         ORDER BY created_at ASC`,
        [jobVersionId]
      );
      expect(eventsRows.rows.length).toBeGreaterThanOrEqual(2);
      expect(eventsRows.rows.some((r: any) => r.event_type === 'STAGE_ENTERED')).toBe(true);
      expect(eventsRows.rows.some((r: any) => r.event_type === 'STAGE_COMPLETED')).toBe(true);

      const pipelineState = await client.query(
        `SELECT current_stage, stage_status
         FROM job_version_pipeline_state
         WHERE job_version_id = $1`,
        [jobVersionId]
      );
      expect(pipelineState.rows).toHaveLength(1);
      expect(pipelineState.rows[0].current_stage).toBe('REQUIREMENTS_EXTRACTED');
      expect(pipelineState.rows[0].stage_status).toBe('COMPLETED');

      const second = await runRequirementsExtraction(client, {
        quotedExtractor: async () => {
          throw new Error('should not run on completed stage');
        },
      });
      expect(second.discovered).toBe(0);
      expect(second.processed).toBe(0);

      const reqCountAfter = (
        await client.query(
          `SELECT COUNT(*)::int AS n FROM job_requirements WHERE job_version_id = $1`,
          [jobVersionId]
        )
      ).rows[0].n as number;
      expect(reqCountAfter).toBe(reqCount);

      const semanticDuplicates = await client.query(
        `SELECT requirement_type, quote_text, COUNT(*)::int AS n
         FROM job_requirements
         WHERE job_version_id = $1
         GROUP BY requirement_type, quote_text
         HAVING COUNT(*) > 1`,
        [jobVersionId]
      );
      expect(semanticDuplicates.rows).toHaveLength(0);
    } finally {
      await client.query('RESET search_path').catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
      await pool.end();
    }
  });
});
