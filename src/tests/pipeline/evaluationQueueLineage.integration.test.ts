import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import pg from "pg";
import dotenv from "dotenv";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import {
  selectEligibleEvaluationQueueRows,
  supersedeStaleEvaluationQueueRows,
} from "../../pipeline/evaluationQueueLineage.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const databaseUrl = process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;

interface LineageFixture {
  readonly canonicalJobId: string;
  readonly jobVersionId: string;
  readonly currentMatchRunId: string;
  readonly currentDecisionId: string;
  readonly queueId: string;
  readonly contentHash: string;
  readonly requirementSetId: string;
  readonly queueFingerprint: string;
  readonly currentDecisionFingerprint: string;
}

function getClient(): pg.PoolClient {
  if (!client) throw new Error("The evaluation queue lineage test client is not initialized.");
  return client;
}

function getContext(): WorkspaceContext {
  if (!context) throw new Error("The evaluation queue lineage workspace is not initialized.");
  return context;
}

async function createFixture(
  profileVersionId: string,
  policySnapshotId: string,
  variant: "valid-different-match-fingerprint" | "stale-match"
): Promise<LineageFixture> {
  const database = getClient();
  const workspaceId = getContext().workspaceId;
  const canonicalJobId = crypto.randomUUID();
  const jobVersionId = crypto.randomUUID();
  const contentHash = `queue-lineage-${crypto.randomUUID()}`;
  const queueId = crypto.randomUUID();
  const requirementIdentityId = crypto.randomUUID();
  const requirementSetId = crypto.randomUUID();
  const staleMatchRunId = crypto.randomUUID();
  const currentMatchRunId = variant === "stale-match" ? crypto.randomUUID() : staleMatchRunId;
  const staleDecisionId = crypto.randomUUID();
  const currentDecisionId = variant === "stale-match" ? crypto.randomUUID() : staleDecisionId;
  const matchFingerprint = `match-${crypto.randomUUID()}`;
  const queueFingerprint = `decision-${crypto.randomUUID()}`;

  await database.query(
    `INSERT INTO canonical_jobs (
       id, workspace_id, company_name, normalized_title, canonical_url,
       processing_state, processing_status, gate_decision, primary_lane
     ) VALUES ($1, $2, 'Lineage Test Co', 'Evaluation Lineage Fixture', $3,
               'QUEUED_FOR_AI', 'QUEUED_FOR_AI', 'PASS', 'CORE_AI_DATA')`,
    [canonicalJobId, workspaceId, `https://example.test/${canonicalJobId}`],
  );
  await database.query(
    `INSERT INTO job_versions (
       id, workspace_id, canonical_job_id, content_hash, description_text, observed_at
     ) VALUES ($1, $2, $3, $4, 'Deterministic integration fixture', NOW())`,
    [jobVersionId, workspaceId, canonicalJobId, contentHash],
  );
  await database.query(
    `INSERT INTO requirement_set_identities (
       id, workspace_id, canonical_job_id, identity_hash, job_content_hash,
       deterministic_extractor_version, quoted_extractor_version,
       quoted_prompt_hash, normalizer_hash
     ) VALUES ($1, $2, $3, $4, $5, 'deterministic-test-v1', 'quoted-test-v1',
              'quoted-prompt-test-v1', 'normalizer-test-v1')`,
    [requirementIdentityId, workspaceId, canonicalJobId, `identity-${crypto.randomUUID()}`, contentHash],
  );
  await database.query(
    `INSERT INTO requirement_sets (
       id, workspace_id, requirement_identity_id, canonical_job_id, job_version_id,
       revision_number, source_type
     ) VALUES ($1, $2, $3, $4, $5, 1, 'EXTRACTED')`,
    [requirementSetId, workspaceId, requirementIdentityId, canonicalJobId, jobVersionId],
  );
  await database.query(
    `UPDATE job_versions SET active_requirement_set_id = $1 WHERE workspace_id = $2 AND id = $3`,
    [requirementSetId, workspaceId, jobVersionId],
  );

  const matchRuns = variant === "stale-match"
    ? [
        { id: staleMatchRunId, contextFingerprint: matchFingerprint },
        { id: currentMatchRunId, contextFingerprint: `current-match-${crypto.randomUUID()}` },
      ]
    : [{ id: currentMatchRunId, contextFingerprint: matchFingerprint }];
  for (const matchRun of matchRuns) {
    await database.query(
      `INSERT INTO match_runs (
         id, workspace_id, canonical_job_id, job_version_id, profile_version_id,
         requirement_set_id, job_content_hash, context_fingerprint, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'COMPLETED')`,
      [
        matchRun.id,
        workspaceId,
        canonicalJobId,
        jobVersionId,
        profileVersionId,
        requirementSetId,
        contentHash,
        matchRun.contextFingerprint,
      ],
    );
  }

  const staleDecisionFingerprint = queueFingerprint;
  const currentDecisionFingerprint = variant === "stale-match"
    ? `current-decision-${crypto.randomUUID()}`
    : queueFingerprint;
  const decisions = variant === "stale-match"
    ? [
        { id: staleDecisionId, matchRunId: staleMatchRunId, contextFingerprint: staleDecisionFingerprint },
        { id: currentDecisionId, matchRunId: currentMatchRunId, contextFingerprint: currentDecisionFingerprint },
      ]
    : [{ id: currentDecisionId, matchRunId: currentMatchRunId, contextFingerprint: currentDecisionFingerprint }];
  for (const decision of decisions) {
    await database.query(
      `INSERT INTO deterministic_decisions (
         id, workspace_id, canonical_job_id, job_version_id, match_run_id,
         policy_snapshot_id, decision_hash, decision_json,
         recommendation_eligibility, recommendation_outcome, context_fingerprint
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb, 'ELIGIBLE', 'REVIEW', $8)`,
      [
        decision.id,
        workspaceId,
        canonicalJobId,
        jobVersionId,
        decision.matchRunId,
        policySnapshotId,
        `decision-${crypto.randomUUID()}`,
        decision.contextFingerprint,
      ],
    );
  }

  await database.query(
    `UPDATE canonical_jobs
     SET latest_job_version_id = $1,
         latest_match_run_id = $2,
         latest_deterministic_decision_id = $3
     WHERE workspace_id = $4 AND id = $5`,
    [jobVersionId, currentMatchRunId, currentDecisionId, workspaceId, canonicalJobId],
  );
  await database.query(
    `INSERT INTO evaluation_queue (
       id, workspace_id, canonical_job_id, job_version_id, lane, priority_score,
       status, profile_version_id, match_run_id, deterministic_decision_id,
       job_content_hash, context_fingerprint, enqueued_at
     ) VALUES ($1, $2, $3, $4, 'CORE_AI_DATA', 1, 'PENDING', $5, $6, $7, $8, $9, NOW())`,
    [
      queueId,
      workspaceId,
      canonicalJobId,
      jobVersionId,
      profileVersionId,
      staleMatchRunId,
      staleDecisionId,
      contentHash,
      queueFingerprint,
    ],
  );

  return {
    canonicalJobId,
    jobVersionId,
    currentMatchRunId,
    currentDecisionId,
    queueId,
    contentHash,
    requirementSetId,
    queueFingerprint,
    currentDecisionFingerprint,
  };
}

async function insertGateDecisionHistory(
  fixture: LineageFixture,
  decisionCount: number,
): Promise<string | null> {
  let latestId: string | null = null;
  for (let offset = 0; offset < decisionCount; offset += 1) {
    const id = crypto.randomUUID();
    await getClient().query(
      `INSERT INTO gate_decisions (
         id, workspace_id, canonical_job_id, job_version_id, decision, created_at
       ) VALUES ($1, $2, $3, $4, 'PASS', $5)`,
      [
        id,
        getContext().workspaceId,
        fixture.canonicalJobId,
        fixture.jobVersionId,
        new Date(Date.now() - offset * 60_000),
      ],
    );
    if (offset === 0) latestId = id;
  }
  return latestId;
}

describe.skipIf(skipReal)("evaluation queue lineage reconciliation (PostgreSQL)", () => {
  let profileVersionId = "";
  let policySnapshotId = "";
  let validFixture: LineageFixture;
  let staleFixture: LineageFixture;
  let unrelatedStaleFixture: LineageFixture;
  let bulkFixtures: LineageFixture[] = [];
  let latestGateDecisionId = "";

  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `eval_lineage_${crypto.randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);

    const candidateProfile = await client.query<{ id: string }>(
      `INSERT INTO candidate_profiles (workspace_id, profile_key, display_name)
       VALUES ($1, $2, 'Evaluation Queue Lineage Test')
       RETURNING id`,
      [getContext().workspaceId, `evaluation-lineage-${crypto.randomUUID()}`],
    );
    const profileVersion = await client.query<{ id: string }>(
      `INSERT INTO profile_versions (
         workspace_id, candidate_profile_id, version_number, schema_version,
         source_hash, status, effective_at
       ) VALUES ($1, $2, 6, '2.2.0', $3, 'ACTIVE', NOW())
       RETURNING id`,
      [getContext().workspaceId, candidateProfile.rows[0].id, `profile-${crypto.randomUUID()}`],
    );
    profileVersionId = profileVersion.rows[0].id;
    const policySnapshot = await client.query<{ id: string }>(
      `INSERT INTO workspace_policy_snapshots (workspace_id, snapshot_hash, resolved_snapshot)
       VALUES ($1, $2, '{}'::jsonb)
       RETURNING id`,
      [getContext().workspaceId, `policy-${crypto.randomUUID()}`],
    );
    policySnapshotId = policySnapshot.rows[0].id;

    validFixture = await createFixture(profileVersionId, policySnapshotId, "valid-different-match-fingerprint");
    staleFixture = await createFixture(profileVersionId, policySnapshotId, "stale-match");
    unrelatedStaleFixture = await createFixture(profileVersionId, policySnapshotId, "stale-match");
    latestGateDecisionId = (await insertGateDecisionHistory(validFixture, 9)) ?? "";
    if (!latestGateDecisionId) throw new Error("The gate-decision fan-out fixture was not seeded.");

    const gateDecisionCounts = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 2, 5];
    for (const gateDecisionCount of gateDecisionCounts) {
      const fixture = await createFixture(profileVersionId, policySnapshotId, "valid-different-match-fingerprint");
      await insertGateDecisionHistory(fixture, gateDecisionCount);
      bulkFixtures.push(fixture);
    }
  });

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  it("keeps a valid queue row eligible when the match fingerprint differs from the decision fingerprint", async () => {
    const database = getClient();
    const before = await database.query<{ status: string }>(
      `SELECT status FROM evaluation_queue WHERE id = $1`,
      [validFixture.queueId],
    );
    expect(before.rows[0]?.status).toBe("PENDING");

    const eligible = await selectEligibleEvaluationQueueRows(database, {
      workspaceId: getContext().workspaceId,
      profileVersionId,
      jobVersionIds: [validFixture.jobVersionId],
      limit: 1,
    });

    expect(eligible).toHaveLength(1);
    expect(new Set(eligible.map((row) => row.id)).size).toBe(1);
    expect(new Set(eligible.map((row) => row.job_version_id)).size).toBe(1);
    expect(eligible[0]?.id).toBe(validFixture.queueId);
    expect(eligible[0]?.context_fingerprint).toBe(validFixture.queueFingerprint);
    expect(eligible[0]?.resolved_gate_decision_id).toBe(latestGateDecisionId);
  });

  it("supersedes stale queue rows without deleting them or creating manual-review debt", async () => {
    const database = getClient();
    const superseded = await supersedeStaleEvaluationQueueRows(database, {
      workspaceId: getContext().workspaceId,
      profileVersionId,
      jobVersionIds: [staleFixture.jobVersionId],
    });

    expect(superseded).toBe(1);
    const unrelated = await database.query<{ status: string }>(
      `SELECT status FROM evaluation_queue WHERE id = $1`,
      [unrelatedStaleFixture.queueId],
    );
    expect(unrelated.rows[0]?.status).toBe("PENDING");
    const preserved = await database.query<{
      status: string;
      last_error: string | null;
      pending_count: number;
      retry_wait_count: number;
      manual_review_count: number;
      current_error_count: number;
    }>(
      `SELECT queue.status, queue.last_error,
             (SELECT COUNT(*)::INTEGER FROM evaluation_queue pending
              WHERE pending.id = queue.id AND pending.status = 'PENDING') AS pending_count,
             (SELECT COUNT(*)::INTEGER FROM evaluation_queue retrying
              WHERE retrying.id = queue.id AND retrying.status = 'RETRY_WAIT') AS retry_wait_count,
             (SELECT COUNT(*)::INTEGER FROM evaluation_queue manual
               WHERE manual.id = queue.id AND manual.status = 'NEEDS_MANUAL_REVIEW') AS manual_review_count,
              (SELECT COUNT(*)::INTEGER FROM v_current_evaluation_errors error
               WHERE error.id = queue.id) AS current_error_count
       FROM evaluation_queue queue
       WHERE queue.id = $1`,
      [staleFixture.queueId],
    );
    expect(preserved.rows[0]).toMatchObject({
      status: "SUPERSEDED",
      pending_count: 0,
      retry_wait_count: 0,
      manual_review_count: 0,
      current_error_count: 0,
    });
    expect(preserved.rows[0]?.last_error).toContain("SUPERSEDED");

    const eligible = await selectEligibleEvaluationQueueRows(database, {
      workspaceId: getContext().workspaceId,
      profileVersionId,
      limit: 10,
    });
    expect(eligible.map((row) => row.id)).toContain(validFixture.queueId);
    expect(eligible.map((row) => row.id)).not.toContain(staleFixture.queueId);

    await database.query(
      `INSERT INTO evaluation_queue (
         workspace_id, canonical_job_id, job_version_id, lane, priority_score,
         status, profile_version_id, match_run_id, deterministic_decision_id,
         job_content_hash, context_fingerprint
       ) VALUES ($1, $2, $3, 'CORE_AI_DATA', 1, 'PENDING', $4, $5, $6, $7, $8)`,
      [
        getContext().workspaceId,
        staleFixture.canonicalJobId,
        staleFixture.jobVersionId,
        profileVersionId,
        staleFixture.currentMatchRunId,
        staleFixture.currentDecisionId,
        staleFixture.contentHash,
        staleFixture.currentDecisionFingerprint,
      ],
    );
    expect(
      await database.query<{ count: number }>(
        `SELECT COUNT(*)::INTEGER AS count FROM evaluation_queue
         WHERE workspace_id = $1 AND canonical_job_id = $2 AND status = 'PENDING'`,
        [getContext().workspaceId, staleFixture.canonicalJobId],
      ).then((result) => result.rows[0]?.count),
    ).toBe(1);
  });

  it("returns 12 selector rows across heterogeneous gate-decision history", async () => {
    const jobVersionIds = bulkFixtures.map((fixture) => fixture.jobVersionId);
    const eligible = await selectEligibleEvaluationQueueRows(getClient(), {
      workspaceId: getContext().workspaceId,
      profileVersionId,
      jobVersionIds,
      limit: 20,
    });
    const uniqueQueueIds = new Set(eligible.map((row) => row.id));
    const uniqueJobVersions = new Set(eligible.map((row) => row.job_version_id));

    expect(eligible).toHaveLength(12);
    expect(uniqueQueueIds.size).toBe(12);
    expect(uniqueJobVersions.size).toBe(12);
    expect(eligible.length - uniqueJobVersions.size).toBe(0);
  });

  it("evaluates one queue row once with nine historical gate decisions", async () => {
    const priorDatabaseUrl = process.env.DATABASE_URL;
    const priorUnpooledDatabaseUrl = process.env.DATABASE_URL_UNPOOLED;
    const priorGeminiKey = process.env.GEMINI_API_KEY;
    let closeQueuePool: (() => Promise<void>) | undefined;
    const evaluatorUrl = new URL(databaseUrl);
    evaluatorUrl.searchParams.set("options", `-c search_path=${schemaName},public`);
    process.env.DATABASE_URL = evaluatorUrl.toString();
    process.env.DATABASE_URL_UNPOOLED = evaluatorUrl.toString();
    process.env.GEMINI_API_KEY = priorGeminiKey || "gate-fanout-test-unused-key";

    try {
      const { evaluateQueue, closeEvaluationQueuePool } = await import("../../../scripts/evaluate_queue.js");
      closeQueuePool = closeEvaluationQueuePool;
      await getClient().query(
        `UPDATE evaluation_queue
         SET attempt_count = max_attempts
         WHERE workspace_id = $1 AND id = $2`,
        [getContext().workspaceId, validFixture.queueId],
      );

      const result = await evaluateQueue({
        context: getContext(),
        profileVersionId,
        jobVersionIds: [validFixture.jobVersionId],
      });

      expect(result).toMatchObject({ eligible: 1, processed: 0, failed: 0, manualReview: 1 });
      const queue = await getClient().query<{ status: string }>(
        `SELECT status FROM evaluation_queue WHERE workspace_id = $1 AND id = $2`,
        [getContext().workspaceId, validFixture.queueId],
      );
      expect(queue.rows[0]?.status).toBe("NEEDS_MANUAL_REVIEW");
      const unrelatedQueue = await getClient().query<{ status: string }>(
        `SELECT status FROM evaluation_queue WHERE workspace_id = $1 AND id = $2`,
        [getContext().workspaceId, unrelatedStaleFixture.queueId],
      );
      expect(unrelatedQueue.rows[0]?.status).toBe("PENDING");
      await closeEvaluationQueuePool();
      closeQueuePool = undefined;
    } finally {
      if (closeQueuePool) await closeQueuePool();
      if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = priorDatabaseUrl;
      if (priorUnpooledDatabaseUrl === undefined) delete process.env.DATABASE_URL_UNPOOLED;
      else process.env.DATABASE_URL_UNPOOLED = priorUnpooledDatabaseUrl;
      if (priorGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = priorGeminiKey;
    }
  });
});
