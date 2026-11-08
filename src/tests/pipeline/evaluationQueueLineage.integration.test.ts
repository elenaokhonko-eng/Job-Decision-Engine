import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import pg from "pg";
import dotenv from "dotenv";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { COMPLETE_TEST_POSTING_DESCRIPTION, insertCompletePostingEvidence } from "../fixtures/completePostingEvidence.js";
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
  const canonicalUrl = `https://example.test/${canonicalJobId}`;

  await database.query(
    `INSERT INTO canonical_jobs (
       id, workspace_id, company_name, normalized_title, canonical_url,
       processing_state, processing_status, gate_decision, primary_lane
     ) VALUES ($1, $2, 'Lineage Test Co', 'Evaluation Lineage Fixture', $3,
               'QUEUED_FOR_AI', 'QUEUED_FOR_AI', 'PASS', 'CORE_AI_DATA')`,
    [canonicalJobId, workspaceId, canonicalUrl],
  );
  await database.query(
    `INSERT INTO job_versions (
       id, workspace_id, canonical_job_id, content_hash, description_text, observed_at
     ) VALUES ($1, $2, $3, $4, $5, NOW())`,
    [jobVersionId, workspaceId, canonicalJobId, contentHash, COMPLETE_TEST_POSTING_DESCRIPTION],
  );
  await insertCompletePostingEvidence(database, {
    workspaceId,
    jobVersionId,
    companyName: "Lineage Test Co",
    title: "Evaluation Lineage Fixture",
    sourceUrl: canonicalUrl,
    description: COMPLETE_TEST_POSTING_DESCRIPTION,
  });
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
  it("reschedules a rate-limited (429) evaluation without spending its last attempt or sending it to manual review", async () => {
    const fixture = bulkFixtures[0];
    const priorDatabaseUrl = process.env.DATABASE_URL;
    const priorUnpooledDatabaseUrl = process.env.DATABASE_URL_UNPOOLED;
    let closeQueuePool: (() => Promise<void>) | undefined;
    const evaluatorUrl = new URL(databaseUrl);
    evaluatorUrl.searchParams.set("options", `-c search_path=${schemaName},public`);
    process.env.DATABASE_URL = evaluatorUrl.toString();
    process.env.DATABASE_URL_UNPOOLED = evaluatorUrl.toString();
    const evaluateMock = vi.fn(async () => {
      const { ModelRateLimitedError } = await import("../../services/modelCallResilience.js");
      throw new ModelRateLimitedError("All model API calls failed. gemini rate limited (429 RESOURCE_EXHAUSTED)",
        { provider: "gemini", model: "gemini-3.6-flash", retryAfterMs: 120_000, attempts: 5 });
    });
    // A fresh evaluate_queue module (its pool was closed by the previous test) that sees the mock.
    vi.resetModules();
    vi.doMock("../../services/agent.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../services/agent.js")>()),
      evaluateSingleCanonicalJob: evaluateMock,
      checkModelRegistryPreflight: () => ({ ok: true, warnings: [], primaryAvailable: true, fallbackAvailable: true }),
    }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      // This is the queue row's last allowed attempt.
      const before = await getClient().query<{ max_attempts: number }>(
        `UPDATE evaluation_queue SET attempt_count = COALESCE(max_attempts, 3) - 1
         WHERE workspace_id = $1 AND id = $2 RETURNING COALESCE(max_attempts, 3) AS max_attempts`,
        [getContext().workspaceId, fixture.queueId],
      );
      const maxAttempts = before.rows[0].max_attempts;
      const { evaluateQueue, closeEvaluationQueuePool } = await import("../../../scripts/evaluate_queue.js");
      closeQueuePool = closeEvaluationQueuePool;

      const result = await evaluateQueue({ context: getContext(), profileVersionId, jobVersionIds: [fixture.jobVersionId] });

      expect(evaluateMock).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ eligible: 1, processed: 0, failed: 0, manualReview: 0, rateLimited: 1 });
      const queue = await getClient().query<{ status: string; attempt_count: number; max_attempts: number; available_at: Date; last_error: string }>(
        `SELECT status, attempt_count, max_attempts, available_at, last_error FROM evaluation_queue WHERE workspace_id = $1 AND id = $2`,
        [getContext().workspaceId, fixture.queueId],
      );
      expect(queue.rows[0]).toMatchObject({ status: "RETRY_WAIT", attempt_count: maxAttempts, max_attempts: maxAttempts + 1 });
      expect(queue.rows[0].last_error).toMatch(/^RATE_LIMITED: /);
      // The provider's 120 s RetryInfo is honoured.
      expect(new Date(queue.rows[0].available_at).getTime()).toBeGreaterThan(Date.now() + 115_000);
      const attempts = await getClient().query<{ provider: string; status: string }>(
        `SELECT provider, status FROM evaluation_attempts WHERE workspace_id = $1 AND canonical_job_id = $2`,
        [getContext().workspaceId, fixture.canonicalJobId],
      );
      expect(attempts.rows).toEqual([{ provider: "rate-limited", status: "FAILED" }]);
      const canonical = await getClient().query<{ processing_state: string | null }>(
        `SELECT processing_state FROM canonical_jobs WHERE id = $1`, [fixture.canonicalJobId]);
      expect(canonical.rows[0].processing_state).not.toBe("NEEDS_MANUAL_REVIEW");
      await closeEvaluationQueuePool();
      closeQueuePool = undefined;
    } finally {
      vi.doUnmock("../../services/agent.js");
      if (closeQueuePool) await closeQueuePool();
      if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = priorDatabaseUrl;
      if (priorUnpooledDatabaseUrl === undefined) delete process.env.DATABASE_URL_UNPOOLED;
      else process.env.DATABASE_URL_UNPOOLED = priorUnpooledDatabaseUrl;
    }
  });

  async function withMockedEvaluator<T>(
    evaluateMock: ReturnType<typeof vi.fn>,
    body: (evaluateQueue: typeof import("../../../scripts/evaluate_queue.js").evaluateQueue) => Promise<T>,
  ): Promise<T> {
    const priorDatabaseUrl = process.env.DATABASE_URL;
    const priorUnpooledDatabaseUrl = process.env.DATABASE_URL_UNPOOLED;
    let closeQueuePool: (() => Promise<void>) | undefined;
    const evaluatorUrl = new URL(databaseUrl);
    evaluatorUrl.searchParams.set("options", `-c search_path=${schemaName},public`);
    process.env.DATABASE_URL = evaluatorUrl.toString();
    process.env.DATABASE_URL_UNPOOLED = evaluatorUrl.toString();
    vi.resetModules();
    vi.doMock("../../services/agent.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../services/agent.js")>()),
      evaluateSingleCanonicalJob: evaluateMock,
      checkModelRegistryPreflight: () => ({ ok: true, warnings: [], primaryAvailable: true, fallbackAvailable: true }),
    }));
    try {
      const { evaluateQueue, closeEvaluationQueuePool } = await import("../../../scripts/evaluate_queue.js");
      closeQueuePool = closeEvaluationQueuePool;
      const result = await body(evaluateQueue);
      await closeEvaluationQueuePool();
      closeQueuePool = undefined;
      return result;
    } finally {
      vi.doUnmock("../../services/agent.js");
      if (closeQueuePool) await closeQueuePool();
      if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = priorDatabaseUrl;
      if (priorUnpooledDatabaseUrl === undefined) delete process.env.DATABASE_URL_UNPOOLED;
      else process.env.DATABASE_URL_UNPOOLED = priorUnpooledDatabaseUrl;
    }
  }

  /** A synthetic, schema-valid evaluation as evaluateSingleCanonicalJob returns it for one path. */
  function syntheticEvaluation(
    input: { canonicalJobId: string; jobVersionId: string },
    pipelineRunId: string,
    attempt: number,
    path: "STANDARD" | "OPENAI_FALLBACK",
  ) {
    const fallback = path === "OPENAI_FALLBACK";
    const evaluatedJob = {
      canonical_job_id: input.canonicalJobId,
      job_version_id: input.jobVersionId,
      pipeline_run_id: pipelineRunId,
      provider: fallback ? "openai" : "gemini",
      model: fallback ? "gpt-test-fallback" : "gemini-3.6-flash",
      attempt,
      is_fallback: fallback,
      degraded_state: fallback,
      served_path: path,
      evaluation_summary: "Synthetic evaluation.",
      primary_lane: "CORE_AI_DATA",
      lane_confidence: "High",
      nd_score: null,
      nd_friendly_score: null,
      politics_stress_score: null,
      sensory_overload_index: null,
      building_research_ratio: null,
      interaction_load: null,
      next_action: "PRIORITY_APPLY",
      evaluated_at: new Date().toISOString(),
    };
    return {
      evaluatedJob, provider: evaluatedJob.provider, model: evaluatedJob.model, fallbackUsed: fallback,
      attempts: 1, errors: [], degraded: fallback, trace: [], usage: null, servedPath: path,
    };
  }

  it("persists the served path: a standard retry after Flex is not degraded, the OpenAI fallback is", async () => {
    const standardFixture = bulkFixtures[1];
    const fallbackFixture = bulkFixtures[2];
    const evaluateMock = vi.fn(async (input: { canonicalJobId: string; jobVersionId: string }, runId: string, attempt: number) =>
      syntheticEvaluation(input, runId, attempt, input.jobVersionId === fallbackFixture.jobVersionId ? "OPENAI_FALLBACK" : "STANDARD"));

    const result = await withMockedEvaluator(evaluateMock, (evaluateQueue) => evaluateQueue({
      context: getContext(), profileVersionId, jobVersionIds: [standardFixture.jobVersionId, fallbackFixture.jobVersionId],
    }));

    expect(result).toMatchObject({ eligible: 2, processed: 2, failed: 0, notStarted: 0 });
    expect(result.providerMix).toMatchObject({ ai_calls: 0, stop_rule_triggered: false });
    const rows = await getClient().query<{ job_version_id: string; provider: string; served_path: string; is_fallback: boolean; degraded_state: boolean; payload_path: string }>(
      `SELECT job_version_id::text, provider, served_path, is_fallback, degraded_state,
              full_evaluation_payload->>'served_path' AS payload_path
       FROM ai_evaluations WHERE workspace_id = $1 AND job_version_id::text = ANY($2::text[])`,
      [getContext().workspaceId, [standardFixture.jobVersionId, fallbackFixture.jobVersionId]],
    );
    const byVersion = new Map(rows.rows.map((row) => [row.job_version_id, row]));
    expect(byVersion.get(standardFixture.jobVersionId)).toMatchObject({
      provider: "gemini", served_path: "STANDARD", is_fallback: false, degraded_state: false, payload_path: "STANDARD",
    });
    expect(byVersion.get(fallbackFixture.jobVersionId)).toMatchObject({
      provider: "openai", served_path: "OPENAI_FALLBACK", is_fallback: true, degraded_state: true, payload_path: "OPENAI_FALLBACK",
    });

    // The column only accepts the four paths.
    await expect(getClient().query(
      `UPDATE ai_evaluations SET served_path = 'SOMETHING_ELSE' WHERE workspace_id = $1 AND job_version_id::text = $2`,
      [getContext().workspaceId, standardFixture.jobVersionId],
    )).rejects.toThrow(/ai_evaluations_served_path_check/);
  });

  it("records the served path on model_route_invocations and rejects unknown paths", async () => {
    const { recordModelRouteInvocation } = await import("../../modelRoutes/registry.js");
    const invocationId = await recordModelRouteInvocation({
      purpose: "EXTRACTION", provider: "gemini", model: "gemini-3.1-flash-lite", status: "COMPLETED",
      fallbackUsed: false, servedPath: "STANDARD", requestHash: `synthetic-${crypto.randomUUID()}`,
      responseMetadata: { served_path: "STANDARD", flex_to_standard_recovery: true },
    }, getClient(), { context: getContext() });
    const failedId = await recordModelRouteInvocation({
      purpose: "EXTRACTION", status: "FAILED", servedPath: null, requestHash: `synthetic-${crypto.randomUUID()}`,
    }, getClient(), { context: getContext() });

    const rows = await getClient().query<{ id: string; served_path: string | null; fallback_used: boolean }>(
      `SELECT id::text, served_path, fallback_used FROM model_route_invocations WHERE id::text = ANY($1::text[])`,
      [[invocationId, failedId]],
    );
    const byId = new Map(rows.rows.map((row) => [row.id, row]));
    expect(byId.get(invocationId!)).toMatchObject({ served_path: "STANDARD", fallback_used: false });
    expect(byId.get(failedId!)).toMatchObject({ served_path: null });
    await expect(getClient().query(
      `UPDATE model_route_invocations SET served_path = 'GEMINI' WHERE id = $1`, [invocationId],
    )).rejects.toThrow(/model_route_invocations_served_path_check/);
  });

  it("stops starting evaluations when the run budget is spent and leaves the rest queued, untouched", async () => {
    const first = bulkFixtures[3];
    const second = bulkFixtures[4];
    let clock = 1_000_000;
    const evaluateMock = vi.fn(async (input: { canonicalJobId: string; jobVersionId: string }, runId: string, attempt: number) => {
      clock += 120_000; // one slow (Flex) evaluation uses up the 60 s budget
      return syntheticEvaluation(input, runId, attempt, "STANDARD");
    });
    const before = await getClient().query<{ id: string; status: string; attempt_count: number }>(
      `SELECT id::text, status, attempt_count FROM evaluation_queue WHERE workspace_id = $1 AND id::text = ANY($2::text[])`,
      [getContext().workspaceId, [first.queueId, second.queueId]],
    );

    const result = await withMockedEvaluator(evaluateMock, (evaluateQueue) => evaluateQueue({
      context: getContext(), profileVersionId, jobVersionIds: [first.jobVersionId, second.jobVersionId],
      wallClockMs: 60_000, now: () => clock,
    }));

    expect(evaluateMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ eligible: 2, processed: 1, failed: 0, notStarted: 1 });
    const after = await getClient().query<{ id: string; status: string; attempt_count: number }>(
      `SELECT id::text, status, attempt_count FROM evaluation_queue WHERE workspace_id = $1 AND id::text = ANY($2::text[])`,
      [getContext().workspaceId, [first.queueId, second.queueId]],
    );
    const statuses = after.rows.map((row) => row.status).sort();
    expect(statuses).toEqual(["COMPLETED", "PENDING"]);
    const untouched = after.rows.find((row) => row.status === "PENDING")!;
    expect(untouched.attempt_count).toBe(before.rows.find((row) => row.id === untouched.id)!.attempt_count);
  });
});

