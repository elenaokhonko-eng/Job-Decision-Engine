import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { isLocalPostgresConnectionString } from "../../db/pgSsl.js";
import { findTasksCompletedWithoutResult } from "../../tasks/completedWithoutResult.js";
import { applyZeroCheckRepairs, planZeroCheckRepairs } from "../../tasks/zeroCheckRepair.js";
import { insertCompletePostingEvidence } from "../fixtures/completePostingEvidence.js";
import { openPipelineStack, type PipelineStack } from "../fixtures/pipelineStackFixture.js";

// The reporting sample of the completed-without-result check is clamped to 200 rows; the repair must see every
// row, and one apply run inserts at most the cap and says so.
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the zero-check repair cap tests against its PostgreSQL service.");
}

const TOTAL = 205;
let stack: PipelineStack | undefined;
const s = (): PipelineStack => { if (!stack) throw new Error("not initialised"); return stack; };
const jobVersions: Array<{ canonicalJobId: string; jobVersionId: string }> = [];

async function routedJobWithCompletedMatch(): Promise<{ canonicalJobId: string; jobVersionId: string }> {
  const canonicalJobId = randomUUID();
  const jobVersionId = randomUUID();
  const { db, ctx } = s();
  await db.query(
    `INSERT INTO canonical_jobs (id, workspace_id, company_name, normalized_title, canonical_url, processing_state, processing_status, description_quality_status)
     VALUES ($1, $2, 'Cap Fixture Co', 'fixture role', $3, 'LANE_ROUTED', 'LANE_ROUTED', 'COMPLETE')`,
    [canonicalJobId, ctx.workspaceId, `https://example.test/cap/${canonicalJobId}`],
  );
  await db.query(
    `INSERT INTO job_versions (id, workspace_id, canonical_job_id, content_hash, description_text, observed_at) VALUES ($1, $2, $3, $4, 'Synthetic.', NOW())`,
    [jobVersionId, ctx.workspaceId, canonicalJobId, `h-${jobVersionId}`],
  );
  await db.query(`UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE id = $2`, [jobVersionId, canonicalJobId]);
  await insertCompletePostingEvidence(db, {
    workspaceId: ctx.workspaceId, jobVersionId, companyName: "Cap Fixture Co", title: "fixture role",
    sourceUrl: `https://example.test/cap/${jobVersionId}`, description: "Synthetic decidable posting text.",
  });
  await db.query(
    `INSERT INTO pipeline_tasks (id, workspace_id, task_type, task_key, payload, status, completed_at)
     VALUES ($1, $2, 'MATCH_PROFILE_EVIDENCE', $3, $4::jsonb, 'COMPLETED', NOW())`,
    [randomUUID(), ctx.workspaceId, `MATCH_PROFILE_EVIDENCE:${jobVersionId}:seed`, JSON.stringify({ canonical_job_id: canonicalJobId, job_version_id: jobVersionId })],
  );
  return { canonicalJobId, jobVersionId };
}

describe.skipIf(skipReal)("zero-check repair cap and completeness (PostgreSQL)", () => {
  beforeAll(async () => {
    stack = await openPipelineStack(databaseUrl, "zero_repair_cap");
    for (let i = 0; i < TOTAL; i += 1) jobVersions.push(await routedJobWithCompletedMatch());
  }, 240_000);
  afterAll(async () => { await stack?.close(); });

  it("the reporting sample stays clamped at 200 but the repair path sees every row", async () => {
    const clamped = await findTasksCompletedWithoutResult(s().db, s().ctx.workspaceId, { sampleLimit: 1000 });
    expect(clamped.total).toBe(TOTAL);
    expect(clamped.sample).toHaveLength(200);
    const all = await findTasksCompletedWithoutResult(s().db, s().ctx.workspaceId, { all: true });
    expect(all.sample).toHaveLength(TOTAL);
    const plan = await planZeroCheckRepairs(s().db, s().ctx.workspaceId);
    expect(plan.items).toHaveLength(TOTAL);
  });

  it("an apply run inserts at most the cap, reports the truncation, and a rerun continues without duplicates", async () => {
    const first = await applyZeroCheckRepairs(s().db, s().ctx, await planZeroCheckRepairs(s().db, s().ctx.workspaceId), 100);
    expect(first).toMatchObject({ inserted: 100, truncated: true, remaining: TOTAL - 100 });
    const second = await applyZeroCheckRepairs(s().db, s().ctx, await planZeroCheckRepairs(s().db, s().ctx.workspaceId), 100);
    expect(second.inserted).toBe(100);
    expect(second.truncated).toBe(true);
    const third = await applyZeroCheckRepairs(s().db, s().ctx, await planZeroCheckRepairs(s().db, s().ctx.workspaceId), 100);
    expect(third).toMatchObject({ inserted: TOTAL - 200, truncated: false, remaining: 0 });
    const fourth = await applyZeroCheckRepairs(s().db, s().ctx, await planZeroCheckRepairs(s().db, s().ctx.workspaceId), 100);
    expect(fourth.inserted).toBe(0);
    const { rows } = await s().db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pipeline_tasks WHERE workspace_id = $1 AND task_key LIKE '%zero-check-repair%'`, [s().ctx.workspaceId]);
    expect(rows[0]!.n).toBe(TOTAL);
  });

  it("rejects a cap that is not a positive integer", async () => {
    const plan = await planZeroCheckRepairs(s().db, s().ctx.workspaceId);
    await expect(applyZeroCheckRepairs(s().db, s().ctx, plan, 0)).rejects.toThrow(/positive integer/);
  });

  it("a job with an active task of the entry stage is left out, and archived or stale-version jobs are never planned", async () => {
    const fresh = await routedJobWithCompletedMatch();
    await s().db.query(
      `INSERT INTO pipeline_tasks (id, workspace_id, task_type, task_key, payload, status)
       VALUES ($1, $2, 'MATCH_PROFILE_EVIDENCE', $3, $4::jsonb, 'PENDING')`,
      [randomUUID(), s().ctx.workspaceId, `MATCH_PROFILE_EVIDENCE:${fresh.jobVersionId}:active`, JSON.stringify({ canonical_job_id: fresh.canonicalJobId, job_version_id: fresh.jobVersionId })],
    );
    const stale = await routedJobWithCompletedMatch();
    // A newer version makes the completed task's version stale.
    const newer = randomUUID();
    await s().db.query(`INSERT INTO job_versions (id, workspace_id, canonical_job_id, content_hash, description_text, observed_at) VALUES ($1, $2, $3, $4, 'Newer.', NOW())`, [newer, s().ctx.workspaceId, stale.canonicalJobId, `h-${newer}`]);
    await s().db.query(`UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE id = $2`, [newer, stale.canonicalJobId]);
    const plan = await planZeroCheckRepairs(s().db, s().ctx.workspaceId);
    const planned = new Set(plan.items.map((item) => item.canonicalJobId));
    expect(planned.has(fresh.canonicalJobId)).toBe(false);
    expect(planned.has(stale.canonicalJobId)).toBe(false);
  });
});
