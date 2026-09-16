import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { buildPipelineTaskContextFingerprint } from "../../pipeline/artifactContext.js";
import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import {
  answerVerificationQuestion,
} from "../../services/verificationQuestionService.js";
import type { WorkspaceContext } from "../../workspace/context.js";

const DB_URL = process.env.DATABASE_URL || "";
const skipReal = !DB_URL || !isLocalPostgresConnectionString(DB_URL);

let pool: pg.Pool;
let client: pg.PoolClient;
let schemaName = "";
let context: WorkspaceContext;

const JOB_ID = "c1000000-0000-4000-8000-000000000001";
const VERSION_ID = "c2000000-0000-4000-8000-000000000001";

async function q(sql: string, params?: unknown[]): Promise<pg.QueryResult> {
  return client.query(sql, params);
}

describe.skipIf(skipReal)("verification question answers: immutable registry integration", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(DB_URL));
    client = await pool.connect();
    schemaName = `verification_answer_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    await q(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
    await q(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);

    const workspace = await q(
      `INSERT INTO workspaces (workspace_key, display_name)
       VALUES ($1, 'Verification Answer Test')
       RETURNING id, workspace_key`,
      [`verification-answer-${Date.now()}`]
    );
    const user = await q(
      `INSERT INTO workspace_users (user_key, display_name)
       VALUES ($1, 'Verification Answer User')
       RETURNING id, user_key`,
      [`verification-answer-user-${Date.now()}`]
    );
    const workspaceId = workspace.rows[0].id as string;
    const userId = user.rows[0].id as string;
    await q(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
       VALUES ($1, $2, 'OWNER', 'ACTIVE')`,
      [workspaceId, userId]
    );
    context = {
      workspaceId,
      workspaceKey: workspace.rows[0].workspace_key || "verification-answer",
      userId,
      userKey: user.rows[0].user_key || "verification-answer-user",
      role: "OWNER",
    };
  });

  afterAll(async () => {
    try {
      await q("SET search_path TO public");
      if (schemaName) await q(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    } finally {
      client.release();
      await pool.end();
    }
  });

  it("writes, reuses, and revises answers without mutating immutable rows", async () => {
    await q(
      `INSERT INTO canonical_jobs (
         id, workspace_id, company_name, normalized_title, canonical_url,
         processing_state, processing_status, gate_decision
       )
       VALUES ($1, $2, 'Config Test Co', 'Verification Test', 'https://example.test/verification',
               'NEEDS_VERIFICATION', 'NEEDS_VERIFICATION', 'NEEDS_VERIFICATION')`,
      [JOB_ID, context.workspaceId]
    );
    await q(
      `INSERT INTO job_versions (
         id, workspace_id, canonical_job_id, version_number, content_hash, description_text, observed_at
       )
       VALUES ($1, $2, $3, 1, 'verification-answer-content-1', 'A sufficiently grounded job description.', NOW())`,
      [VERSION_ID, context.workspaceId, JOB_ID]
    );
    await q(`UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE id = $2`, [VERSION_ID, JOB_ID]);
    await q(
      `INSERT INTO verification_questions (
         workspace_id, question_key, category, question_text, linked_job_ids, status
       )
       VALUES ($1, 'workplace:office_days', 'WORKPLACE_MODEL', 'How many office days?', $2::jsonb, 'PENDING')`,
      [context.workspaceId, JSON.stringify([JOB_ID])]
    );

    const first = await answerVerificationQuestion(client, "workplace:office_days", 3, { context });
    expect(first).toEqual({ ok: true, resumedJobCount: 1 });

    const firstRevision = await q(
      `SELECT cr.id, cr.revision_number, cr.content, car.config_revision_id AS active_revision_id
       FROM config_revisions cr
       JOIN config_definitions cd ON cd.id = cr.config_definition_id
       LEFT JOIN config_active_revisions car ON car.config_definition_id = cd.id
       WHERE cd.workspace_id = $1 AND cd.config_key = 'verification_answers'`,
      [context.workspaceId]
    );
    expect(firstRevision.rows).toHaveLength(1);
    expect(firstRevision.rows[0].revision_number).toBe(1);
    expect(firstRevision.rows[0].content).toEqual({ "workplace:office_days": 3 });
    expect(firstRevision.rows[0].active_revision_id).toBe(firstRevision.rows[0].id);

    const task = await q(
      `SELECT payload, context_fingerprint
       FROM pipeline_tasks
       WHERE workspace_id = $1 AND task_key = $2`,
      [context.workspaceId, `APPLY_HARD_GATES:${VERSION_ID}:hard_gate_v2`]
    );
    expect(task.rows).toHaveLength(1);
    const taskPayload = task.rows[0].payload as Record<string, unknown>;
    expect(taskPayload.verification_answer_revision_id).toBe(firstRevision.rows[0].id);
    expect(task.rows[0].context_fingerprint).toBe(
      buildPipelineTaskContextFingerprint({
        workspaceId: context.workspaceId,
        taskType: "APPLY_HARD_GATES",
        taskVersion: "hard_gate_v2",
        payload: taskPayload,
      })
    );

    const sameAnswer = await answerVerificationQuestion(client, "workplace:office_days", 3, { context });
    expect(sameAnswer).toEqual({ ok: true, resumedJobCount: 0 });
    const reusedCount = await q(
      `SELECT COUNT(*)::int AS count
       FROM config_revisions cr
       JOIN config_definitions cd ON cd.id = cr.config_definition_id
       WHERE cd.workspace_id = $1 AND cd.config_key = 'verification_answers'`,
      [context.workspaceId]
    );
    expect(reusedCount.rows[0].count).toBe(1);

    await answerVerificationQuestion(client, "workplace:office_days", 4, { context });
    const revised = await q(
      `SELECT cr.revision_number, cr.content, car.config_revision_id AS active_revision_id
       FROM config_revisions cr
       JOIN config_definitions cd ON cd.id = cr.config_definition_id
       JOIN config_active_revisions car ON car.config_definition_id = cd.id
       WHERE cd.workspace_id = $1 AND cd.config_key = 'verification_answers'
       ORDER BY cr.revision_number`,
      [context.workspaceId]
    );
    expect(revised.rows).toHaveLength(2);
    expect(revised.rows[0].revision_number).toBe(1);
    expect(revised.rows[1].revision_number).toBe(2);
    expect(revised.rows[1].content).toEqual({ "workplace:office_days": 4 });
    expect(revised.rows[1].active_revision_id).toBe(revised.rows[1].id);
  });

  it("rolls back the answer and revision when scheduling fails", async () => {
    const atomicJobId = "c3000000-0000-4000-8000-000000000001";
    const atomicVersionId = "c4000000-0000-4000-8000-000000000001";
    await q(
      `INSERT INTO canonical_jobs (
         id, workspace_id, company_name, normalized_title, canonical_url,
         processing_state, processing_status, gate_decision
       )
       VALUES ($1, $2, 'Atomic Test Co', 'Atomic Verification Test', 'https://example.test/atomic',
               'NEEDS_VERIFICATION', 'NEEDS_VERIFICATION', 'NEEDS_VERIFICATION')`,
      [atomicJobId, context.workspaceId]
    );
    await q(
      `INSERT INTO job_versions (
         id, workspace_id, canonical_job_id, version_number, content_hash, description_text, observed_at
       )
       VALUES ($1, $2, $3, 1, 'verification-answer-atomic-content', 'Atomic test job description.', NOW())`,
      [atomicVersionId, context.workspaceId, atomicJobId]
    );
    await q(`UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE id = $2`, [atomicVersionId, atomicJobId]);
    await q(
      `INSERT INTO verification_questions (
         workspace_id, question_key, category, question_text, linked_job_ids, status
       )
       VALUES ($1, 'atomic:office_days', 'WORKPLACE_MODEL', 'How many office days?', $2::jsonb, 'PENDING')`,
      [context.workspaceId, JSON.stringify([atomicJobId])]
    );
    await q(`
      CREATE OR REPLACE FUNCTION fail_verification_task_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'intentional scheduling failure';
      END;
      $$;
    `);
    await q(`
      CREATE TRIGGER trg_fail_verification_task_insert
      BEFORE INSERT ON pipeline_tasks
      FOR EACH ROW EXECUTE FUNCTION fail_verification_task_insert();
    `);

    await expect(
      answerVerificationQuestion(client, "atomic:office_days", 2, { context })
    ).rejects.toThrow("intentional scheduling failure");

    await q(`DROP TRIGGER trg_fail_verification_task_insert ON pipeline_tasks`);
    await q(`DROP FUNCTION fail_verification_task_insert()`);

    const question = await q(
      `SELECT status, answer_value FROM verification_questions
       WHERE workspace_id = $1 AND question_key = 'atomic:office_days'`,
      [context.workspaceId]
    );
    expect(question.rows[0].status).toBe("PENDING");
    expect(question.rows[0].answer_value).toBeNull();

    const definition = await q(
      `SELECT COUNT(*)::int AS count
       FROM config_definitions
       WHERE workspace_id = $1 AND config_key = 'verification_answers'`,
      [context.workspaceId]
    );
    expect(definition.rows[0].count).toBe(1);
  });
});
