import { describe, it, expect } from 'vitest';
import pg from 'pg';
import { runMigrations } from '../../db/migrate.js';
import { isLocalPostgresConnectionString, pgConnectionConfig } from '../../db/pgSsl.js';
import { runRequirementsExtraction } from '../../pipeline/requirementsExtractor.js';
import { COMPLETE_TEST_POSTING_DESCRIPTION, insertCompletePostingEvidence } from '../fixtures/completePostingEvidence.js';

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
        COMPLETE_TEST_POSTING_DESCRIPTION,
        'Hybrid role with 2 days per week in office.',
        'Must have at least 5 years of experience.',
        'Work rights required.',
      ].join(' ');
      // Fewer than 5 capability items, so the rules came up short and the quoted (AI) step is asked.

      await client.query(
        `INSERT INTO job_versions (id, canonical_job_id, content_hash, description_text, observed_at)
         VALUES ($1, $2, 'req-int-hash-1', $3, NOW())`,
        [jobVersionId, canonicalJobId, description]
      );

      const workspace = await client.query<{ workspace_id: string }>(
        `SELECT workspace_id::text AS workspace_id FROM canonical_jobs WHERE id = $1`,
        [canonicalJobId],
      );
      await insertCompletePostingEvidence(client, {
        workspaceId: workspace.rows[0]!.workspace_id,
        jobVersionId,
        companyName: 'Integration Co',
        title: 'ml engineer',
        sourceUrl: 'https://integration.example.com/job/1',
        description,
      });

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
      const sparseTaskKey = `EXTRACT_DETERMINISTIC_REQUIREMENTS:${sparseJobVersionId}:deterministic_v7`;
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
          reconcileStalePending: false,
          taskTypes: ['EXTRACT_DETERMINISTIC_REQUIREMENTS'],
          maxTasks: 1,
          claimBatchSize: 1,
          heartbeatSeconds: 0,
          claimedBy: 'requirements-integration-empty',
        }
      );
      expect(workerSummary.completed).toBe(0);
      expect(workerSummary.blocked).toBe(1);
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
      expect(sparseRun.rows).toHaveLength(0);

      const sparseTask = await client.query(
        `SELECT status
         FROM pipeline_tasks
         WHERE task_key = $1`,
        [sparseTaskKey]
      );
      expect(sparseTask.rows[0].status).toBe('BLOCKED_DEPENDENCY');

      const nextTask = await client.query(
        `SELECT COUNT(*)::int AS n
         FROM pipeline_tasks
         WHERE task_type = 'APPLY_HARD_GATES'
           AND task_key = $1`,
        [`APPLY_HARD_GATES:${sparseJobVersionId}:hard_gate_v1`]
      );
      expect(nextTask.rows[0].n).toBe(0);

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
      // The sparse version stays blocked on its posting content instead of being re-seeded.
      const sparseExtractionTasks = await client.query(
        `SELECT status, blocked_on
         FROM pipeline_tasks
         WHERE task_type = 'EXTRACT_DETERMINISTIC_REQUIREMENTS'
           AND payload->>'job_version_id' = $1`,
        [sparseJobVersionId]
      );
      expect(sparseExtractionTasks.rows).toEqual([{ status: 'BLOCKED_DEPENDENCY', blocked_on: 'JOB_CONTENT' }]);

      const repairTask = await client.query(
        `SELECT payload
         FROM pipeline_tasks
         WHERE task_key = $1`,
        [`EXTRACT_DETERMINISTIC_REQUIREMENTS:${lateJobVersionId}:deterministic_v7:repair`]
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

  it('asks the AI only when the rules found too few items, and does not re-queue jobs that skipped it', async () => {
    const pool = new pg.Pool(pgConnectionConfig(DB_URL));
    const client = await pool.connect();
    const schemaName = `req_ai_gate_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

    try {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
      await client.query(`SET search_path TO ${schemaName}, public`);
      await runMigrations(client);

      const rich = [
        COMPLETE_TEST_POSTING_DESCRIPTION,
        '',
        'Requirements',
        '- Strong SQL and Python',
        '- Experience with cloud platforms',
        '- Clear written communication',
        '- Stakeholder management across business units',
        '- Experience running delivery programmes',
      ].join('\n');
      const jobId = '92000000-0000-4000-8000-000000000001';
      const versionId = '92000000-0000-4000-8000-000000000002';
      await client.query(
        `INSERT INTO canonical_jobs (id, company_name, normalized_title, canonical_url, processing_status)
         VALUES ($1, 'Gate Co', 'programme lead', 'https://integration.example.com/gate/1', 'RAW_STAGED')`,
        [jobId],
      );
      await client.query(
        `INSERT INTO job_versions (id, canonical_job_id, content_hash, description_text, observed_at)
         VALUES ($1, $2, 'gate-hash-1', $3, NOW())`,
        [versionId, jobId, rich],
      );
      const workspace = await client.query<{ workspace_id: string }>(
        `SELECT workspace_id::text AS workspace_id FROM canonical_jobs WHERE id = $1`,
        [jobId],
      );
      await insertCompletePostingEvidence(client, {
        workspaceId: workspace.rows[0]!.workspace_id,
        jobVersionId: versionId,
        companyName: 'Gate Co',
        title: 'programme lead',
        sourceUrl: 'https://integration.example.com/gate/1',
        description: rich,
      });
      await client.query(`UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE id = $2`, [versionId, jobId]);

      let aiCalls = 0;
      const quotedExtractor = async () => {
        aiCalls += 1;
        return null;
      };
      const first = await runRequirementsExtraction(client, { quotedExtractor });
      expect(first.processed).toBe(1);
      expect(aiCalls).toBe(0);

      const skipped = await client.query(
        `SELECT provider, model, status FROM requirement_extraction_runs
         WHERE job_version_id = $1 AND run_type = 'LLM_QUOTED'`,
        [versionId],
      );
      expect(skipped.rows).toEqual([{ provider: 'RULES', model: 'AI_NOT_NEEDED', status: 'COMPLETED' }]);

      const second = await runRequirementsExtraction(client, { quotedExtractor });
      expect(second.discovered).toBe(0);
      expect(aiCalls).toBe(0);
    } finally {
      await client.query('RESET search_path').catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
      await pool.end();
    }
  }, REAL_DB_TEST_TIMEOUT_MS);

  it('stores each posting bullet as its own requirement, and records when a posting is too thin', async () => {
    const pool = new pg.Pool(pgConnectionConfig(DB_URL));
    const client = await pool.connect();
    const schemaName = `req_items_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

    try {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
      await client.query(`SET search_path TO ${schemaName}, public`);
      await runMigrations(client);

      const sectioned = [
        COMPLETE_TEST_POSTING_DESCRIPTION,
        '',
        'Responsibilities',
        '- Lead delivery of the enterprise data platform roadmap',
        '',
        'Requirements',
        '- Strong SQL and Python',
        '- Experience with AWS, Azure or GCP',
        '',
        'Nice to have',
        '- Familiarity with Snowflake',
      ].join('\n');
      // The fixture text alone yields two items: too thin to judge.
      const thin = COMPLETE_TEST_POSTING_DESCRIPTION;

      const jobs = [
        { canonical: '91000000-0000-4000-8000-000000000001', version: '91000000-0000-4000-8000-000000000002', text: sectioned, hash: 'items-hash-1' },
        { canonical: '91000000-0000-4000-8000-000000000003', version: '91000000-0000-4000-8000-000000000004', text: thin, hash: 'items-hash-2' },
      ];
      for (const job of jobs) {
        await client.query(
          `INSERT INTO canonical_jobs (id, company_name, normalized_title, canonical_url, processing_status)
           VALUES ($1, 'Items Co', 'programme lead', $2, 'RAW_STAGED')`,
          [job.canonical, `https://integration.example.com/items/${job.hash}`],
        );
        await client.query(
          `INSERT INTO job_versions (id, canonical_job_id, content_hash, description_text, observed_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [job.version, job.canonical, job.hash, job.text],
        );
        const workspace = await client.query<{ workspace_id: string }>(
          `SELECT workspace_id::text AS workspace_id FROM canonical_jobs WHERE id = $1`,
          [job.canonical],
        );
        await insertCompletePostingEvidence(client, {
          workspaceId: workspace.rows[0]!.workspace_id,
          jobVersionId: job.version,
          companyName: 'Items Co',
          title: 'programme lead',
          sourceUrl: `https://integration.example.com/items/${job.hash}`,
          description: job.text,
        });
        await client.query(`UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE id = $2`, [job.version, job.canonical]);
      }

      const summary = await runRequirementsExtraction(client, { quotedMode: 'deterministic_only' });
      expect(summary.errors).toBe(0);
      expect(summary.processed).toBe(2);

      const items = await client.query(
        `SELECT requirement_type, importance, requirement_text, quote_text, extractor_version, structured_value
         FROM job_requirements
         WHERE job_version_id = $1 AND requirement_type = 'CUSTOM'
         ORDER BY requirement_key`,
        [jobs[0].version],
      );
      // The shared fixture text is itself a (flattened) posting, so it contributes its own sentences;
      // the bullets added here must all be present, in order, with their exact quote.
      const texts = items.rows.map((row: any) => row.requirement_text as string);
      const bullets = [
        'Lead delivery of the enterprise data platform roadmap',
        'Strong SQL and Python',
        'Experience with AWS, Azure or GCP',
        'Familiarity with Snowflake',
      ];
      expect(texts.filter((text) => bullets.includes(text))).toEqual(bullets);
      for (const row of items.rows as any[]) {
        expect(row.quote_text).toBe(row.requirement_text);
        expect(row.extractor_version).toBe('deterministic_v7');
        expect(sectioned).toContain(row.quote_text);
      }
      expect((items.rows as any[]).find((row) => row.requirement_text === 'Familiarity with Snowflake').importance).toBe('NICE_TO_HAVE');

      const payloads = await client.query(
        `SELECT job_version_id::text AS job_version_id, response_payload
         FROM requirement_extraction_runs
         WHERE run_type = 'DETERMINISTIC' AND status = 'COMPLETED'`,
      );
      const byVersion = new Map((payloads.rows as any[]).map((row) => [row.job_version_id, row.response_payload]));
      expect(byVersion.get(jobs[0].version)).toMatchObject({ needs_description: false, has_requirements_section: true });
      expect(byVersion.get(jobs[1].version)).toMatchObject({ needs_description: true, confirmed_requirement_count: 2 });
      expect(String(byVersion.get(jobs[1].version).warning)).toContain('NEEDS_DESCRIPTION');
    } finally {
      await client.query('RESET search_path').catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
      await pool.end();
    }
  }, REAL_DB_TEST_TIMEOUT_MS);
});
