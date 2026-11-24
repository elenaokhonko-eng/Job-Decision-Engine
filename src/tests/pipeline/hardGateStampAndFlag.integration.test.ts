import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GATE_VERSION } from "../../contracts/version.js";
import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { runHardGates, flagNeedsVerification, FLAGGABLE_REASON_CODES } from "../../pipeline/hardGate.js";
import { enqueuePipelineTask } from "../../tasks/pipelineTasks.js";
import { runPipelineStageTaskWorker } from "../../tasks/stageTaskWorker.js";
import { aggregateVerificationQuestions, getPendingVerificationQuestions } from "../../services/verificationQuestionService.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";
import { COMPLETE_TEST_POSTING_DESCRIPTION, insertCompletePostingEvidence } from "../fixtures/completePostingEvidence.js";

// Gate side of the version-refresh stamp and of flagNeedsVerification (real PostgreSQL, synthetic jobs only).
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the hard-gate stamp and flag integration tests against its PostgreSQL service.");
}

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;

const db = (): pg.PoolClient => {
  if (!client) throw new Error("The integration database is not initialized.");
  return client;
};
const ctx = (): WorkspaceContext => {
  if (!context) throw new Error("The integration workspace is not initialized.");
  return context;
};

async function seedJob(state: string, options: { gateDecision?: string | null } = {}): Promise<{ jobId: string; versionId: string }> {
  const jobId = randomUUID();
  const versionId = randomUUID();
  const url = `https://example.test/gate-flag/${jobId}`;
  await db().query(
    `INSERT INTO canonical_jobs (id, workspace_id, company_name, normalized_title, canonical_url, location, workplace_type,
                                 employment_type, processing_state, processing_status, gate_decision, description_quality_status)
     VALUES ($1, $2, 'Gate Flag Fixture', 'Machine Learning Engineer', $3, 'Remote', 'REMOTE', 'FULL_TIME', $4, $4, $5, 'COMPLETE')`,
    [jobId, ctx().workspaceId, url, state, options.gateDecision === undefined ? "PASS" : options.gateDecision],
  );
  await db().query(
    `INSERT INTO job_versions (id, workspace_id, canonical_job_id, content_hash, description_text, observed_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [versionId, ctx().workspaceId, jobId, `hash-${versionId}`, COMPLETE_TEST_POSTING_DESCRIPTION],
  );
  await db().query(`UPDATE canonical_jobs SET latest_job_version_id = $2 WHERE id = $1`, [jobId, versionId]);
  await insertCompletePostingEvidence(db(), {
    workspaceId: ctx().workspaceId, jobVersionId: versionId, companyName: "Gate Flag Fixture", title: "Machine Learning Engineer",
    sourceUrl: url, description: COMPLETE_TEST_POSTING_DESCRIPTION,
  });
  // Real gate facts: flagNeedsVerification validates the audit envelope, so the job must carry a complete workability_facts object.
  // Run the gate once to produce it, drop that audit row, then put the job in the state and gate decision the test wants.
  if (state !== "RAW_STAGED" && state !== "HARD_REJECTED") {
    await db().query(`UPDATE canonical_jobs SET processing_state = 'RAW_STAGED', processing_status = 'RAW_STAGED', gate_decision = NULL WHERE id = $1`, [jobId]);
    await runHardGates(db(), { context: ctx(), canonicalJobIds: [jobId] });
    await db().query(`DELETE FROM gate_decisions WHERE canonical_job_id = $1`, [jobId]);
    await db().query(`UPDATE canonical_jobs SET processing_state = $2, processing_status = $2, gate_decision = $3 WHERE id = $1`, [jobId, state, options.gateDecision === undefined ? "PASS" : options.gateDecision]);
  }
  return { jobId, versionId };
}

async function auditRows(jobId: string): Promise<Array<{ decision: string; gate_version: string; rejection_codes: string[] }>> {
  return (await db().query(
    `SELECT decision, gate_version, rejection_codes FROM gate_decisions WHERE canonical_job_id = $1 ORDER BY created_at, id`,
    [jobId],
  )).rows;
}

describe.skipIf(skipReal)("hard gate: version-refresh stamp and flagNeedsVerification (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `gate_flag_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
  }, 120_000);

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  describe("version-refresh re-gate", () => {
    async function gatedJobWithDownstream(state: string): Promise<{ jobId: string; before: Record<string, unknown> }> {
      const { jobId } = await seedJob("RAW_STAGED", { gateDecision: null });
      await runHardGates(db(), { context: ctx(), canonicalJobIds: [jobId] });
      await db().query(
        `UPDATE canonical_jobs
            SET processing_state = $2, processing_status = $2, primary_lane = 'CORE_AI_DATA', lane_confidence = 0.9,
                deterministic_match_score = 70, deterministic_match_coverage = 55, recommendation_eligibility = 'ELIGIBLE',
                recommendation_outcome = 'REVIEW', recommendation_requirement_score = 0.658, recommendation_coverage_score = 0.55,
                recommendation_evidence_completeness = 0.9, recommendation_score_policy = 'm|role_shape_v2',
                recommendation_degree_asked_for = 'A doctoral degree is required.',
                recommendation_role_signals = '[{"code":"X","penalty":0.06,"source":"TITLE","quote":"x"}]'::jsonb,
                recommendation_evidence_confidence = 'LOW'
          WHERE id = $1`,
        [jobId, state],
      );
      const before = (await db().query(`SELECT * FROM canonical_jobs WHERE id = $1`, [jobId])).rows[0];
      return { jobId, before };
    }

    const DOWNSTREAM = [
      "processing_state", "primary_lane", "lane_confidence", "deterministic_match_score", "deterministic_match_coverage",
      "recommendation_eligibility", "recommendation_outcome", "recommendation_requirement_score", "recommendation_coverage_score",
      "recommendation_evidence_completeness", "recommendation_score_policy", "recommendation_degree_asked_for",
      "recommendation_role_signals", "recommendation_evidence_confidence",
    ];

    it.each(["MATCHED", "EVALUATED"])("an unchanged outcome only stamps the audit row: a %s job keeps lane, match, decision, score and the four ranking columns", async (state) => {
      const { jobId, before } = await gatedJobWithDownstream(state);
      const rowsBefore = await auditRows(jobId);
      expect(rowsBefore).toHaveLength(1);

      const summary = await runHardGates(db(), { context: ctx(), canonicalJobIds: [jobId], reprocess: true, versionRefresh: true });
      expect(summary.errors).toBe(0);

      const after = (await db().query(`SELECT * FROM canonical_jobs WHERE id = $1`, [jobId])).rows[0];
      for (const column of DOWNSTREAM) expect(after[column], column).toEqual(before[column]);
      const rowsAfter = await auditRows(jobId);
      expect(rowsAfter).toHaveLength(2);
      expect(rowsAfter[1]).toMatchObject({ decision: rowsBefore[0]!.decision, gate_version: GATE_VERSION });
      expect(rowsAfter[1]!.rejection_codes).toEqual(rowsBefore[0]!.rejection_codes);
    });

    it("a changed outcome takes the normal reset path (downstream cleared)", async () => {
      const { jobId } = await gatedJobWithDownstream("MATCHED");
      // A posting that now states an on-site Singapore role changes the gate outcome.
      await db().query(`UPDATE canonical_jobs SET workplace_type = 'ONSITE', location = 'London' WHERE id = $1`, [jobId]);
      const stored = (await db().query(`SELECT gate_decision FROM canonical_jobs WHERE id = $1`, [jobId])).rows[0].gate_decision;

      await runHardGates(db(), { context: ctx(), canonicalJobIds: [jobId], reprocess: true, versionRefresh: true });
      const after = (await db().query(`SELECT * FROM canonical_jobs WHERE id = $1`, [jobId])).rows[0];
      const rows = await auditRows(jobId);
      expect(rows).toHaveLength(2);
      expect(rows[1]!.decision, `stored decision was ${stored}`).not.toBe(rows[0]!.decision);
      for (const column of ["primary_lane", "deterministic_match_score", "recommendation_outcome", "recommendation_requirement_score", "recommendation_score_policy", "recommendation_degree_asked_for", "recommendation_evidence_confidence"]) {
        expect(after[column], column).toBeNull();
      }
      expect(after.recommendation_role_signals).toEqual([]);
    });

    it("without versionRefresh a forced re-gate still resets downstream even when the outcome is unchanged", async () => {
      const { jobId } = await gatedJobWithDownstream("MATCHED");
      await runHardGates(db(), { context: ctx(), canonicalJobIds: [jobId], reprocess: true });
      const after = (await db().query(`SELECT primary_lane, recommendation_outcome FROM canonical_jobs WHERE id = $1`, [jobId])).rows[0];
      expect(after).toEqual({ primary_lane: null, recommendation_outcome: null });
    });
  });

  describe("flagNeedsVerification", () => {
    const evidence = { quote: "The page says the role is hybrid, three days in the office.", source: "RECHECK_AVAILABILITY", facts: { known: "REMOTE", seen: "HYBRID" } };

    it("flags a PASS job: state, gate_decision, rejection codes, quotes and an audit row; the verification question appears", async () => {
      const { jobId } = await seedJob("PREQUALIFIED");
      const result = await flagNeedsVerification(db(), { workspaceId: ctx().workspaceId, jobId, reasonCode: "GATE_UNKNOWN_WORK_MODE", evidence });
      expect(result).toMatchObject({ applied: true, stateKept: false });

      const job = (await db().query(`SELECT gate_decision, processing_state, rejection_reason, gate_evidence_quotes, workability_facts FROM canonical_jobs WHERE id = $1`, [jobId])).rows[0];
      expect(job).toMatchObject({ gate_decision: "NEEDS_VERIFICATION", processing_state: "NEEDS_VERIFICATION" });
      expect(job.rejection_reason).toContain("GATE_UNKNOWN_WORK_MODE");
      expect(job.gate_evidence_quotes).toContain(evidence.quote);
      expect(job.workability_facts.facts_conflict).toMatchObject({ reason_code: "GATE_UNKNOWN_WORK_MODE", source: "RECHECK_AVAILABILITY" });
      const rows = await auditRows(jobId);
      expect(rows.at(-1)).toMatchObject({ decision: "NEEDS_VERIFICATION", gate_version: GATE_VERSION });
      expect(rows.at(-1)!.rejection_codes).toEqual(expect.arrayContaining(["GATE_UNKNOWN_WORK_MODE", "NEEDS_VERIFICATION"]));

      const summary = await aggregateVerificationQuestions(db(), { context: ctx() });
      expect(summary.discoveredPendingJobs).toBeGreaterThanOrEqual(1);
      expect(summary.generatedQuestions).toBeGreaterThanOrEqual(1);
      const pending = await getPendingVerificationQuestions(db(), { context: ctx() });
      expect(JSON.stringify(pending)).toContain(jobId);
    });

    it("is idempotent for the same code and quote", async () => {
      const { jobId } = await seedJob("PREQUALIFIED");
      await flagNeedsVerification(db(), { workspaceId: ctx().workspaceId, jobId, reasonCode: "NEEDS_VERIFICATION_LOCATION_DETAIL", evidence });
      const second = await flagNeedsVerification(db(), { workspaceId: ctx().workspaceId, jobId, reasonCode: "NEEDS_VERIFICATION_LOCATION_DETAIL", evidence });
      expect(second).toEqual({ applied: false, reason: "ALREADY_FLAGGED" });
      expect(await auditRows(jobId)).toHaveLength(1);
    });

    it.each([
      ["HARD_REJECTED", "HARD_REJECT", "HARD_REJECTED"],
      ["MANUALLY_REMOVED", "PASS", "MANUALLY_REMOVED"],
      ["RAW_STAGED", null, "RAW_STAGED"],
    ] as const)("is a no-op for a %s job", async (state, gateDecision, reason) => {
      const { jobId } = await seedJob(state, { gateDecision });
      const result = await flagNeedsVerification(db(), { workspaceId: ctx().workspaceId, jobId, reasonCode: "GATE_UNKNOWN_WORK_MODE", evidence });
      expect(result).toEqual({ applied: false, reason });
      expect(await auditRows(jobId)).toHaveLength(0);
      const job = (await db().query(`SELECT gate_decision, processing_state FROM canonical_jobs WHERE id = $1`, [jobId])).rows[0];
      expect(job.processing_state).toBe(state);
      expect(job.gate_decision).toBe(gateDecision);
    });

    it("flags an in-flight or evaluated job without moving its processing state", async () => {
      for (const state of ["QUEUED_FOR_AI", "EVALUATING", "EVALUATED"]) {
        const { jobId } = await seedJob(state);
        const result = await flagNeedsVerification(db(), { workspaceId: ctx().workspaceId, jobId, reasonCode: "GATE_UNKNOWN_WORK_MODE", evidence });
        expect(result).toMatchObject({ applied: true, stateKept: true });
        const job = (await db().query(`SELECT gate_decision, processing_state FROM canonical_jobs WHERE id = $1`, [jobId])).rows[0];
        expect(job).toEqual({ gate_decision: "NEEDS_VERIFICATION", processing_state: state });
      }
    });

    it("refuses a reason code that is not flaggable, and a missing quote", async () => {
      const { jobId } = await seedJob("PREQUALIFIED");
      await expect(flagNeedsVerification(db(), { workspaceId: ctx().workspaceId, jobId, reasonCode: "GATE_HARD_REJECT" as never, evidence })).rejects.toThrow(/not a flaggable/);
      await expect(flagNeedsVerification(db(), { workspaceId: ctx().workspaceId, jobId, reasonCode: "GATE_UNKNOWN_WORK_MODE", evidence: { quote: "  " } })).rejects.toThrow(/quote is required/);
      expect(FLAGGABLE_REASON_CODES).toEqual(["GATE_UNKNOWN_WORK_MODE", "NEEDS_VERIFICATION_LOCATION_DETAIL"]);
    });

    it("a later normal re-gate replaces the flag with its own result", async () => {
      const { jobId } = await seedJob("PREQUALIFIED");
      await flagNeedsVerification(db(), { workspaceId: ctx().workspaceId, jobId, reasonCode: "GATE_UNKNOWN_WORK_MODE", evidence });
      await runHardGates(db(), { context: ctx(), canonicalJobIds: [jobId], reprocess: true });
      const rows = await auditRows(jobId);
      expect(rows).toHaveLength(2);
      expect(rows[1]!.decision).not.toBe("HARD_REJECT");
      const job = (await db().query(`SELECT gate_decision FROM canonical_jobs WHERE id = $1`, [jobId])).rows[0];
      expect(job.gate_decision).toBe(rows[1]!.decision);
    });
  });

  describe("version refresh details", () => {
    async function gate(jobId: string, options: { reprocess?: boolean; versionRefresh?: boolean } = {}) {
      return runHardGates(db(), { context: ctx(), canonicalJobIds: [jobId], ...options });
    }

    it("a stamp refreshes the gate-owned columns (quotes, facts, rejection reason) and leaves downstream state alone", async () => {
      const { jobId } = await seedJob("RAW_STAGED", { gateDecision: null });
      await gate(jobId);
      await db().query(`UPDATE canonical_jobs SET gate_evidence_quotes = '["old quote"]'::jsonb, workability_facts = '{"stale":true}'::jsonb, processing_state = 'MATCHED', processing_status = 'MATCHED', primary_lane = 'CORE_AI_DATA' WHERE id = $1`, [jobId]);
      const summary = await gate(jobId, { reprocess: true, versionRefresh: true });
      expect(summary.stamped).toBe(1);
      const job = (await db().query(`SELECT gate_evidence_quotes, workability_facts, processing_state, primary_lane FROM canonical_jobs WHERE id = $1`, [jobId])).rows[0];
      expect(JSON.stringify(job.gate_evidence_quotes)).not.toContain("old quote");
      expect(job.workability_facts.stale).toBeUndefined();
      expect(job).toMatchObject({ processing_state: "MATCHED", primary_lane: "CORE_AI_DATA" });
    });

    it("a changed workability policy hash with the same decision is stamped with the new hash", async () => {
      const { jobId } = await seedJob("RAW_STAGED", { gateDecision: null });
      await gate(jobId);
      await db().query(`UPDATE gate_decisions SET workability_policy_hash = $2 WHERE canonical_job_id = $1`, [jobId, "a".repeat(64)]);
      await db().query(`UPDATE canonical_jobs SET processing_state = 'MATCHED', processing_status = 'MATCHED' WHERE id = $1`, [jobId]);
      expect((await gate(jobId, { reprocess: true, versionRefresh: true })).stamped).toBe(1);
      const hashes = (await db().query(`SELECT workability_policy_hash FROM gate_decisions WHERE canonical_job_id = $1 ORDER BY created_at, id`, [jobId])).rows.map((row) => row.workability_policy_hash);
      expect(hashes).toHaveLength(2);
      expect(hashes[1]).not.toBe("a".repeat(64));
    });

    it("code order and duplicates in the stored row do not make an unchanged outcome look changed", async () => {
      const { jobId } = await seedJob("RAW_STAGED", { gateDecision: null });
      await gate(jobId);
      const first = (await auditRows(jobId))[0]!;
      const reordered = [...first.rejection_codes, ...first.rejection_codes].reverse();
      await db().query(`UPDATE gate_decisions SET rejection_codes = $2::jsonb WHERE canonical_job_id = $1`, [jobId, JSON.stringify(reordered)]);
      await db().query(`UPDATE canonical_jobs SET processing_state = 'MATCHED', processing_status = 'MATCHED' WHERE id = $1`, [jobId]);
      expect((await gate(jobId, { reprocess: true, versionRefresh: true })).stamped).toBe(1);
    });

    it("a hard-rejected job is stamped too (nothing downstream to keep or reset)", async () => {
      const { jobId } = await seedJob("RAW_STAGED", { gateDecision: null });
      await db().query(`UPDATE canonical_jobs SET workplace_type = 'ONSITE', location = 'London' WHERE id = $1`, [jobId]);
      await gate(jobId);
      const first = (await auditRows(jobId))[0]!;
      const summary = await gate(jobId, { reprocess: true, versionRefresh: true });
      expect(summary.stamped).toBe(1);
      const rows = await auditRows(jobId);
      expect(rows).toHaveLength(2);
      expect(rows[1]!.decision).toBe(first.decision);
    });

    it("a flag cleared by a passing re-gate is stamped, not reset: an EVALUATED job keeps its state and downstream", async () => {
      const { jobId } = await seedJob("EVALUATED");
      await db().query(`UPDATE canonical_jobs SET primary_lane = 'CORE_AI_DATA', recommendation_outcome = 'REVIEW', recommendation_requirement_score = 0.6 WHERE id = $1`, [jobId]);
      await flagNeedsVerification(db(), { workspaceId: ctx().workspaceId, jobId, reasonCode: "GATE_UNKNOWN_WORK_MODE", evidence: { quote: "The page says hybrid." } });
      expect((await db().query(`SELECT gate_decision FROM canonical_jobs WHERE id = $1`, [jobId])).rows[0].gate_decision).toBe("NEEDS_VERIFICATION");
      const summary = await gate(jobId, { reprocess: true, versionRefresh: true });
      expect(summary.stamped).toBe(1);
      const job = (await db().query(`SELECT gate_decision, processing_state, primary_lane, recommendation_outcome, recommendation_requirement_score::float AS score, workability_facts FROM canonical_jobs WHERE id = $1`, [jobId])).rows[0];
      expect(job).toMatchObject({ gate_decision: "PASS", processing_state: "EVALUATED", primary_lane: "CORE_AI_DATA", recommendation_outcome: "REVIEW", score: 0.6 });
      expect(job.workability_facts.facts_conflict).toBeUndefined();
    });

    it("a changed outcome resets exactly the downstream columns and nothing is stamped", async () => {
      const { jobId } = await seedJob("RAW_STAGED", { gateDecision: null });
      await gate(jobId);
      await db().query(`UPDATE canonical_jobs SET processing_state = 'MATCHED', processing_status = 'MATCHED', primary_lane = 'CORE_AI_DATA', deterministic_match_score = 70, recommendation_outcome = 'REVIEW', recommendation_score_policy = 'p', recommendation_role_signals = '[{"code":"X"}]'::jsonb, workplace_type = 'ONSITE', location = 'London' WHERE id = $1`, [jobId]);
      const summary = await gate(jobId, { reprocess: true, versionRefresh: true });
      expect(summary.stamped).toBe(0);
      const job = (await db().query(`SELECT processing_state, primary_lane, deterministic_match_score, recommendation_outcome, recommendation_score_policy, recommendation_role_signals FROM canonical_jobs WHERE id = $1`, [jobId])).rows[0];
      expect(job).toMatchObject({ primary_lane: null, deterministic_match_score: null, recommendation_outcome: null, recommendation_score_policy: null, recommendation_role_signals: [] });
      expect(job.processing_state).not.toBe("MATCHED");
    });

    it("flagNeedsVerification inside the callers transaction commits or rolls back the lock, the job update and the audit row together", async () => {
      const { jobId } = await seedJob("PREQUALIFIED");
      await db().query("BEGIN");
      const result = await flagNeedsVerification(db(), { workspaceId: ctx().workspaceId, jobId, reasonCode: "NEEDS_VERIFICATION_LOCATION_DETAIL", evidence: { quote: "Office in a different city than listed." } });
      expect(result).toMatchObject({ applied: true });
      await db().query("ROLLBACK");
      expect((await db().query(`SELECT gate_decision FROM canonical_jobs WHERE id = $1`, [jobId])).rows[0].gate_decision).toBe("PASS");
      expect(await auditRows(jobId)).toHaveLength(0);
    });

    it("the APPLY_HARD_GATES handler accepts version_refresh: a stamped MATCHED job keeps its state and gets no downstream task", async () => {
      const { jobId, versionId } = await seedJob("RAW_STAGED", { gateDecision: null });
      await gate(jobId);
      await db().query(`UPDATE canonical_jobs SET processing_state = 'MATCHED', processing_status = 'MATCHED', primary_lane = 'CORE_AI_DATA' WHERE id = $1`, [jobId]);
      const task = await enqueuePipelineTask({
        taskType: "APPLY_HARD_GATES",
        taskKey: `APPLY_HARD_GATES:${versionId}:gate-refresh-test`,
        payload: { canonical_job_id: jobId, job_version_id: versionId, version_refresh: true },
      }, db(), { context: ctx() });
      const run = await runPipelineStageTaskWorker(db(), { context: ctx(), seed: false, reconcileStalePending: false, taskTypes: ["APPLY_HARD_GATES"], maxTasks: 1, heartbeatSeconds: 0 });
      expect(run).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
      expect((await db().query(`SELECT status FROM pipeline_tasks WHERE id = $1`, [task.taskId])).rows[0].status).toBe("COMPLETED");
      expect((await db().query(`SELECT processing_state, primary_lane FROM canonical_jobs WHERE id = $1`, [jobId])).rows[0]).toEqual({ processing_state: "MATCHED", primary_lane: "CORE_AI_DATA" });
      const successors = await db().query(`SELECT task_type FROM pipeline_tasks WHERE payload->>'job_version_id' = $1 AND id <> $2`, [versionId, task.taskId]);
      expect(successors.rows).toEqual([]);
      expect(await auditRows(jobId)).toHaveLength(2);
    });
  });
});
