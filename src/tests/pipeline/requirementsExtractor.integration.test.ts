import { describe, it, expect } from 'vitest';
import pg from 'pg';
import { runMigrations } from '../../db/migrate.js';
import { isLocalPostgresConnectionString, pgConnectionConfig } from '../../db/pgSsl.js';
import { runRequirementsExtraction } from '../../pipeline/requirementsExtractor.js';

const DB_URL = process.env.DATABASE_URL || '';
const isCI = isLocalPostgresConnectionString(DB_URL);
const skipReal = !DB_URL || !isCI;
const REAL_DB_TEST_TIMEOUT_MS = 30_000;

describe.skipIf(skipReal)('Requirements extraction integration (temporary schema)', () => {
  it('persists requirement rows, extraction runs, and stage events without duplicates on rerun', async () => {
    const pool = new pg.Pool(pgConnectionConfig(DB_URL));
    const client = await pool.connect();
    const schemaName = `req_stage_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

    try {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
      await client.query(`SET search_path TO ${schemaName}, public`);
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

      const sparseCanonicalJobId = '90000000-0000-4000-8000-000000000003';
      const sparseJobVersionId = '90000000-0000-4000-8000-000000000004';
      await client.query(
        `INSERT INTO canonical_jobs (id, company_name, normalized_title, canonical_url, processing_status)
         VALUES ($1, 'Sparse Integration Co', 'collaboration lead', 'https://integration.example.com/job/empty', 'RAW_STAGED')`,
        [sparseCanonicalJobId]
      );
      await client.query(
        `INSERT INTO job_versions (id, canonical_job_id, content_hash, description_text, observed_at)
         VALUES ($1, $2, 'req-int-empty-hash-1', 'Collaborative team role with broad impact across programs.', NOW())`,
        [sparseJobVersionId, sparseCanonicalJobId]
      );
      await client.query(
        `UPDATE canonical_jobs SET latest_job_version_id = $1, updated_at = NOW() WHERE id = $2`,
        [sparseJobVersionId, sparseCanonicalJobId]
      );

      const { resolveWorkspaceContext } = await import('../../workspace/context.js');
      const { enqueuePipelineTask } = await import('../../tasks/pipelineTasks.js');
      const { runPipelineStageTaskWorker } = await import('../../tasks/stageTaskWorker.js');
      const context = await resolveWorkspaceContext(client as any);
      const sparseTaskKey = `EXTRACT_DETERMINISTIC_REQUIREMENTS:${sparseJobVersionId}:deterministic_v1`;
      await enqueuePipelineTask(
        {
          taskType: 'EXTRACT_DETERMINISTIC_REQUIREMENTS',
          taskKey: sparseTaskKey,
          payload: {
            canonical_job_id: sparseCanonicalJobId,
            job_version_id: sparseJobVersionId,
          },
          maxAttempts: 8,
        },
        client as any,
        { context }
      );

      const workerSummary = await runPipelineStageTaskWorker(
        client as any,
        {
          context,
          seed: false,
          taskTypes: ['EXTRACT_DETERMINISTIC_REQUIREMENTS'],
          maxTasks: 1,
          claimBatchSize: 1,
          heartbeatSeconds: 0,
          claimedBy: 'requirements-integration-empty',
        }
      );
      expect(workerSummary.completed).toBe(1);
      expect(workerSummary.failed).toBe(0);
      expect(workerSummary.errors).toEqual([]);

      const sparseRequirements = await client.query(
        `SELECT COUNT(*)::int AS n
         FROM job_requirements
         WHERE job_version_id = $1
           AND extractor_type = 'DETERMINISTIC'
           AND status = 'VALIDATED'`,
        [sparseJobVersionId]
      );
      expect(sparseRequirements.rows[0].n).toBe(0);

      const sparseRun = await client.query(
        `SELECT status, requirements_extracted
         FROM requirement_extraction_runs
         WHERE job_version_id = $1
           AND run_type = 'DETERMINISTIC'
         ORDER BY started_at DESC
         LIMIT 1`,
        [sparseJobVersionId]
      );
      expect(sparseRun.rows[0]).toEqual({
        status: 'COMPLETED',
        requirements_extracted: 0,
      });

      const sparseTask = await client.query(
        `SELECT status
         FROM pipeline_tasks
         WHERE task_key = $1`,
        [sparseTaskKey]
      );
      expect(sparseTask.rows[0].status).toBe('COMPLETED');

      const nextTask = await client.query(
        `SELECT COUNT(*)::int AS n
         FROM pipeline_tasks
         WHERE task_type = 'APPLY_HARD_GATES'
           AND task_key = $1`,
        [`APPLY_HARD_GATES:${sparseJobVersionId}:hard_gate_v1`]
      );
      expect(nextTask.rows[0].n).toBe(1);

      const lateCanonicalJobId = '90000000-0000-4000-8000-000000000005';
      const lateJobVersionId = '90000000-0000-4000-8000-000000000006';
      await client.query(
        `INSERT INTO canonical_jobs (
           id, company_name, normalized_title, canonical_url,
           processing_state, processing_status, primary_lane
         )
         VALUES (
           $1, 'Late State Integration Co', 'data platform engineer',
           'https://integration.example.com/job/late', 'MATCHED', 'MATCHED', 'CORE_AI_DATA'
         )`,
        [lateCanonicalJobId]
      );
      await client.query(
        `INSERT INTO job_versions (id, canonical_job_id, content_hash, description_text, observed_at)
         VALUES ($1, $2, 'req-int-late-hash-1', 'Must have Python experience and work authorization.', NOW())`,
        [lateJobVersionId, lateCanonicalJobId]
      );
      await client.query(
        `UPDATE canonical_jobs SET latest_job_version_id = $1, updated_at = NOW() WHERE id = $2`,
        [lateJobVersionId, lateCanonicalJobId]
      );

      const { seedRecoverablePipelineTasks } = await import('../../tasks/stageTaskWorker.js');
      const seededRepair = await seedRecoverablePipelineTasks(client as any, {
        context,
        maxSeedPerType: 10,
      });
      expect(seededRepair.byType.EXTRACT_DETERMINISTIC_REQUIREMENTS?.inserted).toBe(1);

      const repairTask = await client.query(
        `SELECT payload
         FROM pipeline_tasks
         WHERE task_key = $1`,
        [`EXTRACT_DETERMINISTIC_REQUIREMENTS:${lateJobVersionId}:deterministic_v1:repair`]
      );
      expect(repairTask.rows[0].payload).toMatchObject({
        canonical_job_id: lateCanonicalJobId,
        job_version_id: lateJobVersionId,
        repair_existing_state: true,
      });
    } finally {
      await client.query('RESET search_path').catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
      await pool.end();
    }
  }, REAL_DB_TEST_TIMEOUT_MS);
});
