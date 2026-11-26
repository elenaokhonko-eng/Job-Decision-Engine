import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isLocalPostgresConnectionString } from "../../db/pgSsl.js";
import { runDeterministicMatcher } from "../../pipeline/deterministicMatcher.js";
import { runLaneRouter } from "../../pipeline/laneRouter.js";
import { supersededProfileMatchSql } from "../../tasks/stageTaskWorker.js";
import { openPipelineStack, type PipelineStack, type StackJob } from "../fixtures/pipelineStackFixture.js";
import { currentMatcherPolicyVersion } from "../../pipeline/profileMatchCurrency.js";

// The UNMATCHED re-match seed (supersededProfileMatchSql) and the matcher select must agree: every row the seed reaches is
// selected by the matcher (so its task can finish), and the matcher takes no UNMATCHED job the seed does not reach.
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the UNMATCHED seed/select equality test against its PostgreSQL service.");
}

type Shape = "ok" | "fixture" | "noLane" | "incomplete" | "archived" | "currentPolicy" | "policyNoMatch" | "policyOldRun";
const SHAPES: Shape[] = ["ok", "fixture", "noLane", "incomplete", "archived", "currentPolicy", "policyNoMatch", "policyOldRun"];

let stack: PipelineStack | undefined;
const s = (): PipelineStack => { if (!stack) throw new Error("not initialised"); return stack; };
const jobs = {} as Record<Shape, StackJob>;

async function parkedRun(job: StackJob, policy: string): Promise<string> {
  const space = await s().db.query<{ id: string }>(
    `SELECT id::text AS id FROM embedding_spaces WHERE workspace_id = $1 AND active = TRUE AND is_fallback_space = FALSE ORDER BY created_at LIMIT 1`,
    [s().ctx.workspaceId]);
  const run = await s().db.query<{ id: string }>(
    `INSERT INTO match_runs (workspace_id, canonical_job_id, job_version_id, profile_version_id, requirement_set_id, status, requirement_count,
                             matched_count, coverage_score, overall_match_score, policy_version, job_content_hash, context_fingerprint, embedding_space_id, completed_at)
     VALUES ($1, $2, $3, $4, $5, 'COMPLETED', 1, 0, 0, 0, $6, $7, $8, $9, NOW()) RETURNING id`,
    [s().ctx.workspaceId, job.canonicalJobId, job.jobVersionId, s().profileVersionId, job.requirementSetId, policy, job.contentHash,
     `eq-${job.canonicalJobId}-${policy}`, space.rows[0]?.id ?? null]);
  return run.rows[0]!.id;
}

async function seedRows(): Promise<string[]> {
  const { rows } = await s().db.query<{ id: string }>(
    `SELECT c.latest_job_version_id::text AS id FROM canonical_jobs c
       JOIN match_runs mr ON mr.workspace_id = c.workspace_id AND mr.id = c.latest_match_run_id
      WHERE c.workspace_id = $1 AND ${supersededProfileMatchSql()}`,
    [s().ctx.workspaceId]);
  return rows.map((row) => row.id).sort();
}

async function latestRuns(): Promise<Record<string, string | null>> {
  const { rows } = await s().db.query<{ id: string; run: string | null }>(
    `SELECT latest_job_version_id::text AS id, latest_match_run_id::text AS run FROM canonical_jobs WHERE workspace_id = $1`, [s().ctx.workspaceId]);
  return Object.fromEntries(rows.map((row) => [row.id, row.run]));
}

describe.skipIf(skipReal)("UNMATCHED re-match: seed predicate equals the matcher select (PostgreSQL)", () => {
  beforeAll(async () => {
    stack = await openPipelineStack(databaseUrl, "unmatched_equality");
    for (const shape of SHAPES) jobs[shape] = await s().seedRoutableJob(shape);
    await s().publishEmbeddings();
    await runLaneRouter(s().db, { context: s().ctx, jobVersionIds: SHAPES.map((shape) => jobs[shape].jobVersionId) });
    for (const shape of SHAPES) {
      const job = jobs[shape];
      const runId = shape === "policyNoMatch" ? null : await parkedRun(job, shape === "currentPolicy" ? currentMatcherPolicyVersion() : "deterministic_v1");
      await s().db.query(
        `UPDATE canonical_jobs SET processing_state = 'UNMATCHED', processing_status = 'UNMATCHED',
                routing_disposition = $3, latest_match_run_id = $4, recommendation_eligibility = 'INELIGIBLE', recommendation_outcome = 'SKIP'
          WHERE workspace_id = $1 AND id = $2`,
        [s().ctx.workspaceId, job.canonicalJobId, shape === "policyNoMatch" || shape === "policyOldRun" ? "POLICY_NO_MATCH" : "ROUTED", runId]);
    }
    const q = (sql: string, id: string) => s().db.query(sql, [s().ctx.workspaceId, jobs[id as Shape].canonicalJobId]);
    await q(`UPDATE canonical_jobs SET is_test_fixture = TRUE WHERE workspace_id = $1 AND id = $2`, "fixture");
    await q(`UPDATE canonical_jobs SET primary_lane = NULL WHERE workspace_id = $1 AND id = $2`, "noLane");
    await q(`UPDATE canonical_jobs SET description_quality_status = 'INCOMPLETE' WHERE workspace_id = $1 AND id = $2`, "incomplete");
    const run = await s().db.query<{ id: string }>(
      `INSERT INTO job_archive_runs (run_started_at, cutoff_at, mode, status) VALUES (NOW(), NOW() - INTERVAL '1 second', 'APPLY', 'RUNNING') RETURNING id::text`);
    await s().db.query(
      `UPDATE canonical_jobs SET archived_at = NOW(), archive_reason = 'JOB_OLDER_THAN_THREE_CALENDAR_MONTHS',
              archive_age_basis = 'AUTHORITATIVE_PUBLICATION_DATE', archive_reference_at = NOW(), archive_run_id = $3
        WHERE workspace_id = $1 AND id = $2`, [s().ctx.workspaceId, jobs.archived.canonicalJobId, run.rows[0]!.id]);
  }, 180_000);
  afterAll(async () => { await stack?.close(); });

  it("every seed row is selected by the matcher, and the matcher takes no UNMATCHED job the seed does not reach", async () => {
    const expectedSeed = [jobs.ok.jobVersionId, jobs.fixture.jobVersionId].sort();
    expect(await seedRows()).toEqual(expectedSeed);
    const before = await latestRuns();
    // Feed EVERY job version (not only the seed rows) through the matcher select as an explicit target.
    const summary = await runDeterministicMatcher(s().db, { context: s().ctx, jobVersionIds: SHAPES.map((shape) => jobs[shape].jobVersionId) });
    expect(summary.errors).toBe(0);
    const after = await latestRuns();
    const rematched = Object.keys(after).filter((id) => after[id] !== before[id]).sort();
    expect(rematched).toEqual(expectedSeed);
  }, 120_000);

  it("without a unique active profile the seed reaches nothing", async () => {
    await s().db.query(`UPDATE profile_versions SET status = 'DRAFT' WHERE workspace_id = $1 AND id = $2`, [s().ctx.workspaceId, s().profileVersionId]);
    // Re-park the first job so a row would be eligible but for the profile.
    await s().db.query(`UPDATE match_runs SET policy_version = 'deterministic_v1' WHERE workspace_id = $1 AND job_version_id = $2`, [s().ctx.workspaceId, jobs.currentPolicy.jobVersionId]);
    expect(await seedRows()).toEqual([]);
  });
});
