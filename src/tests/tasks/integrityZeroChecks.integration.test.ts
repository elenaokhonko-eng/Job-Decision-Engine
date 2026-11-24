import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { LANE_ROUTER_RULE_VERSION } from "../../pipeline/laneRouter.js";
import { currentMatcherPolicyVersion } from "../../pipeline/profileMatchCurrency.js";
import { DETERMINISTIC_EXTRACTOR_VERSION } from "../../requirements/deterministicExtractors.js";
import { AVAILABILITY_RECHECK_ARCHIVE_RULE } from "../../services/jobArchive.js";
import {
  completedTasksWithoutResult,
  listedJobsNotCurrentlyOpen,
  protectedJobsAutoArchived,
  rejectedJobsWithRecommendation,
  routableVerificationJobsStranded,
  runZeroChecks,
  staleStageResults,
  zeroChecksExitCode,
} from "../../tasks/integrityZeroChecks.js";

// Each must-be-zero check is shown to be zero on a clean workspace, to fail on a seeded violation, and
// to stay zero on a near miss. Every test makes its own workspace, so tests do not depend on each
// other or on their order. Synthetic data only.
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the zero-check tests against its PostgreSQL service.");
}

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
const db = (): pg.PoolClient => { if (!client) throw new Error("not initialised"); return client; };

async function newWorkspace(): Promise<string> {
  const row = await db().query<{ id: string }>(
    `INSERT INTO workspaces (workspace_key, display_name) VALUES ($1, 'Zero check workspace') RETURNING id::text`,
    [`zero-${randomUUID()}`],
  );
  return row.rows[0]!.id;
}

interface JobFields { gate?: string | null; reason?: string | null; outcome?: string | null; state?: string }

async function job(ws: string, fields: JobFields = {}): Promise<{ canonicalJobId: string; jobVersionId: string }> {
  const canonicalJobId = randomUUID();
  const jobVersionId = randomUUID();
  await db().query(
    `INSERT INTO canonical_jobs (id, workspace_id, company_name, normalized_title, canonical_url, processing_state, processing_status,
       gate_decision, rejection_reason, recommendation_outcome)
     VALUES ($1, $2, 'Zero Check Co', 'fixture role', $3, $4, $4, $5, $6, $7)`,
    [canonicalJobId, ws, `https://example.test/z/${canonicalJobId}`, fields.state ?? "MATCHED", fields.gate ?? null, fields.reason ?? null, fields.outcome ?? null],
  );
  await db().query(
    `INSERT INTO job_versions (id, workspace_id, canonical_job_id, content_hash, description_text, observed_at) VALUES ($1, $2, $3, $4, 'Synthetic.', NOW())`,
    [jobVersionId, ws, canonicalJobId, `h-${jobVersionId}`],
  );
  await db().query(`UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE id = $2`, [jobVersionId, canonicalJobId]);
  return { canonicalJobId, jobVersionId };
}

async function observation(ws: string, jobVersionId: string, sourceName: string, retrievedAtSql = "NOW()"): Promise<void> {
  await db().query(
    `INSERT INTO raw_job_observations (workspace_id, source_name, source_external_id, source_url, retrieved_at, company_name, title, description_raw,
       raw_payload, raw_payload_hash, processing_status, job_version_id)
     VALUES ($1, $2, $3, $4, ${retrievedAtSql}, 'Zero Check Co', 'fixture role', 'x', '{}'::jsonb, $5, 'PROCESSED', $6)`,
    [ws, sourceName, `o-${randomUUID()}`, `https://example.test/o/${randomUUID()}`, randomUUID().replaceAll("-", "").padEnd(64, "0"), jobVersionId],
  );
}

/** Archives a job as POSTING_NOT_CONFIRMABLE; `rule` is the re-check marker or null (another rule), `daysAgo` sets archived_at. */
async function archive(ws: string, canonicalJobId: string, rule: string | null, daysAgo = 1): Promise<void> {
  const run = await db().query<{ id: string }>(
    `INSERT INTO job_archive_runs (run_started_at, cutoff_at, mode, status) VALUES (NOW(), NOW() - INTERVAL '1 second', 'APPLY', 'RUNNING') RETURNING id::text`,
  );
  await db().query(
    `UPDATE canonical_jobs SET archived_at = NOW() - make_interval(days => $4::int), archive_reason = 'POSTING_NOT_CONFIRMABLE',
            archive_age_basis = 'POSTING_LINK_UNVERIFIABLE', archive_reference_at = NOW(), archive_run_id = $3 WHERE workspace_id = $2 AND id = $1`,
    [canonicalJobId, ws, run.rows[0]!.id, daysAgo],
  );
  await db().query(
    `INSERT INTO job_archive_events (workspace_id, canonical_job_id, archive_run_id, action, actor, reason, reference_at, age_basis, details, event_at)
     VALUES ($1, $2, $3, 'ARCHIVED', 'test', 'POSTING_NOT_CONFIRMABLE', NOW(), 'POSTING_LINK_UNVERIFIABLE', $4::jsonb, NOW() - make_interval(days => $5::int))`,
    [ws, canonicalJobId, run.rows[0]!.id, JSON.stringify(rule ? { rule } : {}), daysAgo],
  );
}

async function hold(ws: string, canonicalJobId: string, createdDaysAgo: number, expiresInDays: number): Promise<void> {
  await db().query(
    `INSERT INTO job_archive_holds (workspace_id, canonical_job_id, hold_reason, hold_type, created_by, created_at, expires_at)
     VALUES ($1, $2, 'owner keeps it', 'USER_PRESERVE', 'test', NOW() - make_interval(days => $3::int), NOW() + make_interval(days => $4::int))`,
    [ws, canonicalJobId, createdDaysAgo, expiresInDays],
  );
}

describe.skipIf(skipReal)("must-be-zero checks (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `zero_checks_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
  }, 60_000);

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  it("every check is zero on a clean workspace, and the exit code follows the totals", async () => {
    const ws = await newWorkspace();
    const results = await runZeroChecks(db(), ws);
    expect(results.map((check) => check.name)).toEqual([
      "rejected_job_with_recommendation", "unmatched_job_with_recommendation", "listed_job_not_currently_open", "task_completed_without_result",
      "routable_verification_job_stranded", "canonical_copy_columns_drift", "match_blocked_on_requirement_embedding", "protected_job_auto_archived", "stage_result_older_than_rule_version",
    ]);
    expect(results.map((check) => check.total)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(zeroChecksExitCode(results)).toBe(0);
    expect(zeroChecksExitCode([{ total: 0 }, { total: 2 }])).toBe(1);
  });

  it("rejected job with a recommendation: reported; a rejected job without one, and a recommended job that was not rejected, are not", async () => {
    const ws = await newWorkspace();
    const rejectedWithRecommendation = await job(ws, { outcome: "REVIEW" });
    const rejectedClean = await job(ws, { outcome: null });
    const recommendedNotRejected = await job(ws, { outcome: "REVIEW" });
    const rejectedWithEligibility = await job(ws, { outcome: null });
    await db().query(`UPDATE canonical_jobs SET recommendation_eligibility = 'ELIGIBLE' WHERE id = $1`, [rejectedWithEligibility.canonicalJobId]);
    const rejectedArchived = await job(ws, { outcome: "REVIEW" });
    await db().query(`UPDATE canonical_jobs SET archived_at = NOW(), archive_reason = 'JOB_OLDER_THAN_THREE_CALENDAR_MONTHS', archive_age_basis = 'AUTHORITATIVE_PUBLICATION_DATE', archive_reference_at = NOW(), archive_run_id = (SELECT id FROM job_archive_runs LIMIT 1) WHERE id = $1`, [rejectedArchived.canonicalJobId]).catch(() => undefined);
    const reGatedToPass = await job(ws, { outcome: "REVIEW" });
    const gate = (j: { canonicalJobId: string; jobVersionId: string }, decision: string) => db().query(
      `INSERT INTO gate_decisions (canonical_job_id, job_version_id, decision, workspace_id) VALUES ($1, $2, $3, $4)`,
      [j.canonicalJobId, j.jobVersionId, decision, ws]);
    await gate(rejectedWithRecommendation, "HARD_REJECT");
    await gate(rejectedClean, "HARD_REJECT");
    await gate(recommendedNotRejected, "PASS");
    await gate(rejectedWithEligibility, "HARD_REJECT");
    // Latest gate result is what counts: rejected first, then passed again, so the job is not a violation.
    await gate(reGatedToPass, "HARD_REJECT");
    await db().query(`INSERT INTO gate_decisions (canonical_job_id, job_version_id, decision, workspace_id, created_at) VALUES ($1, $2, 'PASS', $3, NOW() + INTERVAL '1 minute')`,
      [reGatedToPass.canonicalJobId, reGatedToPass.jobVersionId, ws]);
    const check = await rejectedJobsWithRecommendation(db(), ws);
    expect([...check.sample].sort()).toEqual([rejectedWithRecommendation.canonicalJobId, rejectedWithEligibility.canonicalJobId].sort());
    expect(check.total).toBe(2);
    expect(rejectedArchived.canonicalJobId).not.toBe(rejectedClean.canonicalJobId);
  });

  it("listed job not currently open: reported for a closed job in the list; an open one is not (stand-in list view); the real views run clean", async () => {
    const ws = await newWorkspace();
    expect((await listedJobsNotCurrentlyOpen(db(), ws)).total).toBe(0);
    const open = await job(ws);
    const closed = await job(ws);
    const windowRanOut = await job(ws);
    await db().query(`UPDATE job_versions SET availability_status = 'OPEN', availability_verified_at = NOW(), availability_recheck_at = NOW() + INTERVAL '3 days' WHERE id = $1`, [open.jobVersionId]);
    await db().query(`UPDATE job_versions SET availability_status = 'CLOSED', availability_verified_at = NOW(), availability_recheck_at = NOW() + INTERVAL '3 days' WHERE id = $1`, [closed.jobVersionId]);
    await db().query(`UPDATE job_versions SET availability_status = 'OPEN', availability_verified_at = NOW() - INTERVAL '9 days', availability_recheck_at = NOW() - INTERVAL '1 day' WHERE id = $1`, [windowRanOut.jobVersionId]);
    const view = `zero_check_listed_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await db().query(
      `CREATE VIEW ${view} AS SELECT c.workspace_id, c.id AS canonical_job_id, c.latest_job_version_id AS job_version_id
         FROM canonical_jobs c WHERE c.workspace_id = '${ws}'::uuid`);
    const check = await listedJobsNotCurrentlyOpen(db(), ws, { stand_in: view });
    expect([...check.sample].sort()).toEqual([`stand_in:${closed.canonicalJobId}`, `stand_in:${windowRanOut.canonicalJobId}`].sort());
    await expect(listedJobsNotCurrentlyOpen(db(), ws, { bad: "x; DROP TABLE y" })).rejects.toThrow(/plain identifier/);
  });

  it("completed task with no result: reported incl. RECHECK_AVAILABILITY; a re-check with an event, and a legitimately skipped re-check, are not", async () => {
    const ws = await newWorkspace();
    const taskFor = async (j: { canonicalJobId: string; jobVersionId: string }) => {
      const id = randomUUID();
      await db().query(
        `INSERT INTO pipeline_tasks (id, workspace_id, task_type, task_key, payload, status, completed_at)
         VALUES ($1, $2, 'RECHECK_AVAILABILITY', $3, $4::jsonb, 'COMPLETED', NOW())`,
        [id, ws, `RECHECK_AVAILABILITY:${j.jobVersionId}:${id}`, JSON.stringify({ canonical_job_id: j.canonicalJobId, job_version_id: j.jobVersionId })],
      );
      return id;
    };
    const missing = await job(ws);
    await observation(ws, missing.jobVersionId, "GREENHOUSE");
    const missingTask = await taskFor(missing);

    const recorded = await job(ws);
    await observation(ws, recorded.jobVersionId, "GREENHOUSE");
    const recordedTask = await taskFor(recorded);
    await db().query(
      `INSERT INTO job_availability_recheck_events (workspace_id, canonical_job_id, job_version_id, task_id, read_kind, outcome, decision, reason_code,
         consecutive_absent_reads_after, cannot_tell_attempts_after) VALUES ($1, $2, $3, $4, 'PAGE', 'OPEN', 'MARK_OPEN', 'TEST', 0, 0)`,
      [ws, recorded.canonicalJobId, recorded.jobVersionId, recordedTask]);

    const skipped = await job(ws); // no observation to read: the re-check skips it and records nothing, by design
    await taskFor(skipped);

    const check = await completedTasksWithoutResult(db(), ws);
    expect(check.sample).toEqual([missingTask]);
    expect(check.detail).toEqual({ RECHECK_AVAILABILITY: 1 });
  });

  it("routable verification job stranded: reported with no task and no match run; one with a task, one with a match run, and a non-routable one are not", async () => {
    const ws = await newWorkspace();
    const routable = { gate: "NEEDS_VERIFICATION", reason: "GATE_UNKNOWN_WORK_MODE", state: "NEEDS_VERIFICATION" } as const;
    const stranded = await job(ws, routable);
    const waiting = await job(ws, routable);
    const matched = await job(ws, routable);
    const notRoutable = await job(ws, { gate: "NEEDS_VERIFICATION", reason: "GATE_WORK_AUTH", state: "NEEDS_VERIFICATION" });
    await db().query(
      `INSERT INTO pipeline_tasks (workspace_id, task_type, task_key, payload, status) VALUES ($1, 'PUBLISH_EMBEDDING', $2, $3::jsonb, 'PENDING')`,
      [ws, `PUBLISH_EMBEDDING:${waiting.jobVersionId}:x`, JSON.stringify({ canonical_job_id: waiting.canonicalJobId, job_version_id: waiting.jobVersionId })]);
    const profile = await db().query<{ id: string }>(
      `INSERT INTO candidate_profiles (workspace_id, profile_key, display_name) VALUES ($1, $2, 'Fixture') RETURNING id`, [ws, `fixture-${randomUUID()}`]);
    const version = await db().query<{ id: string }>(
      `INSERT INTO profile_versions (workspace_id, candidate_profile_id, version_number, schema_version, source_hash, status, effective_at)
       VALUES ($1, $2, 1, '2.2.0', $3, 'DRAFT', NOW()) RETURNING id`, [ws, profile.rows[0]!.id, `fixture-${randomUUID()}`]);
    const run = await db().query<{ id: string }>(
      `INSERT INTO match_runs (workspace_id, canonical_job_id, job_version_id, profile_version_id, status, requirement_count, matched_count, policy_version, job_content_hash, context_fingerprint)
       VALUES ($1, $2, $3, $4, 'COMPLETED', 1, 1, 'fixture', 'h', 'fp') RETURNING id`, [ws, matched.canonicalJobId, matched.jobVersionId, version.rows[0]!.id]);
    await db().query(`UPDATE canonical_jobs SET latest_match_run_id = $1 WHERE id = $2`, [run.rows[0]!.id, matched.canonicalJobId]);
    const check = await routableVerificationJobsStranded(db(), ws);
    expect(check.sample).toEqual([stranded.canonicalJobId]);
    expect(notRoutable.canonicalJobId).not.toBe(stranded.canonicalJobId);
  });

  it("protected job auto-archived: only an archive by the re-check rule, with the protection in force before it, is reported", async () => {
    const ws = await newWorkspace();
    // Violation: saved before the re-check archived it.
    const savedThenArchived = await job(ws);
    await observation(ws, savedThenArchived.jobVersionId, "LINKEDIN_SAVED", "NOW() - INTERVAL '5 days'");
    await archive(ws, savedThenArchived.canonicalJobId, AVAILABILITY_RECHECK_ARCHIVE_RULE, 1);
    // Violation: held (unexpired) before the archive.
    const heldThenArchived = await job(ws);
    await hold(ws, heldThenArchived.canonicalJobId, 5, 20);
    await archive(ws, heldThenArchived.canonicalJobId, AVAILABILITY_RECHECK_ARCHIVE_RULE, 1);
    // Near misses.
    const unsaved = await job(ws);
    await archive(ws, unsaved.canonicalJobId, AVAILABILITY_RECHECK_ARCHIVE_RULE, 1);
    const savedAfter = await job(ws);
    await archive(ws, savedAfter.canonicalJobId, AVAILABILITY_RECHECK_ARCHIVE_RULE, 3);
    await observation(ws, savedAfter.jobVersionId, "LINKEDIN_SAVED", "NOW()");
    const expiredHold = await job(ws);
    await hold(ws, expiredHold.canonicalJobId, 10, -4); // created 10 days ago, expired 4 days ago: not in force at the archive
    await archive(ws, expiredHold.canonicalJobId, AVAILABILITY_RECHECK_ARCHIVE_RULE, 1);
    const appliedThenArchived = await job(ws);
    await db().query(
      `INSERT INTO application_records (workspace_id, user_id, canonical_job_id, job_version_id, status, created_at)
       SELECT $1, u.id, $2, $3, 'APPLIED', NOW() - INTERVAL '5 days' FROM workspace_users u LIMIT 1`,
      [ws, appliedThenArchived.canonicalJobId, appliedThenArchived.jobVersionId]);
    await archive(ws, appliedThenArchived.canonicalJobId, AVAILABILITY_RECHECK_ARCHIVE_RULE, 1);
    const appliedAfter = await job(ws);
    await archive(ws, appliedAfter.canonicalJobId, AVAILABILITY_RECHECK_ARCHIVE_RULE, 3);
    await db().query(
      `INSERT INTO application_records (workspace_id, user_id, canonical_job_id, job_version_id, status, created_at)
       SELECT $1, u.id, $2, $3, 'APPLIED', NOW() FROM workspace_users u LIMIT 1`,
      [ws, appliedAfter.canonicalJobId, appliedAfter.jobVersionId]);
    const releasedHold = await job(ws);
    await hold(ws, releasedHold.canonicalJobId, 5, 20);
    await db().query(`UPDATE job_archive_holds SET released_at = NOW() - INTERVAL '3 days', released_by = 'test', release_reason = 'done' WHERE canonical_job_id = $1`, [releasedHold.canonicalJobId]);
    await archive(ws, releasedHold.canonicalJobId, AVAILABILITY_RECHECK_ARCHIVE_RULE, 1);
    const otherRule = await job(ws); // e.g. the Himalayas link repair: saved, archived by another rule
    await observation(ws, otherRule.jobVersionId, "LINKEDIN_SAVED", "NOW() - INTERVAL '5 days'");
    await archive(ws, otherRule.canonicalJobId, null, 1);
    const check = await protectedJobsAutoArchived(db(), ws);
    expect([...check.sample].sort()).toEqual([savedThenArchived.canonicalJobId, heldThenArchived.canonicalJobId, appliedThenArchived.canonicalJobId].sort());
  });
  async function matchRun(ws: string, j: { canonicalJobId: string; jobVersionId: string }, profileVersionId: string, policy: string): Promise<void> {
    const run = await db().query<{ id: string }>(
      `INSERT INTO match_runs (workspace_id, canonical_job_id, job_version_id, profile_version_id, status, requirement_count, matched_count, policy_version, job_content_hash, context_fingerprint)
       VALUES ($1, $2, $3, $4, 'COMPLETED', 1, 1, $5, 'h', 'fp') RETURNING id`, [ws, j.canonicalJobId, j.jobVersionId, profileVersionId, policy]);
    await db().query(`UPDATE canonical_jobs SET latest_match_run_id = $1 WHERE id = $2`, [run.rows[0]!.id, j.canonicalJobId]);
  }
  async function laneDecision(ws: string, j: { canonicalJobId: string; jobVersionId: string }, model: string): Promise<void> {
    const decision = await db().query<{ id: string }>(
      `INSERT INTO lane_decisions (workspace_id, canonical_job_id, job_version_id, decision_hash, model_version, lane_snapshot, decision_json)
       VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, '{}'::jsonb) RETURNING id`, [ws, j.canonicalJobId, j.jobVersionId, randomUUID(), model]);
    await db().query(`UPDATE canonical_jobs SET latest_lane_decision_id = $1 WHERE id = $2`, [decision.rows[0]!.id, j.canonicalJobId]);
  }
  async function publishJobVersionEmbedding(ws: string, jobVersionId: string): Promise<void> {
    const space = await db().query<{ id: string }>(
      `INSERT INTO embedding_spaces (workspace_id, space_key, provider, model, dimensions, is_fallback_space, active)
       VALUES ($1, $2, 'fixture', 'zero-check-fixture', 4, FALSE, TRUE) RETURNING id`, [ws, `zero-space-${randomUUID()}`]);
    const input = await db().query<{ id: string }>(
      `INSERT INTO embedding_inputs (workspace_id, input_key, source_type, source_id, content_text, content_hash)
       VALUES ($1, $2, 'JOB_VERSION', $3, 'Synthetic', $4) RETURNING id`, [ws, `zero-input-${randomUUID()}`, jobVersionId, randomUUID()]);
    const batch = await db().query<{ id: string }>(
      `INSERT INTO embedding_batches (workspace_id, embedding_space_id, batch_key, run_type, status, item_count, success_count, failure_count, completed_at)
       VALUES ($1, $2, $3, 'PRIMARY', 'COMPLETED', 1, 1, 0, NOW()) RETURNING id`, [ws, space.rows[0]!.id, `zero-batch-${randomUUID()}`]);
    await db().query(
      `INSERT INTO embedding_batch_items (workspace_id, embedding_batch_id, embedding_input_id, status) VALUES ($1, $2, $3, 'COMPLETED')`,
      [ws, batch.rows[0]!.id, input.rows[0]!.id]);
    await db().query(
      `INSERT INTO semantic_embeddings (workspace_id, embedding_space_id, embedding_input_id, embedding_batch_id, vector_dimensions, embedding_values, vector_checksum)
       VALUES ($1, $2, $3, $4, 4, ARRAY[0.1, 0.2, 0.3, 0.4]::DOUBLE PRECISION[], $5)`,
      [ws, space.rows[0]!.id, input.rows[0]!.id, batch.rows[0]!.id, randomUUID()]);
  }

  it("stale matcher check equals the re-match seed: only an eligible, routed PRIORITY/REVIEW/TRACK job with a complete description matched under an older policy counts", async () => {
    const ws = await newWorkspace();
    const profile = await db().query<{ id: string }>(
      `INSERT INTO candidate_profiles (workspace_id, profile_key, display_name) VALUES ($1, $2, 'Fixture') RETURNING id`, [ws, `fixture-${randomUUID()}`]);
    const version = await db().query<{ id: string }>(
      `INSERT INTO profile_versions (workspace_id, candidate_profile_id, version_number, schema_version, source_hash, status, effective_at)
       VALUES ($1, $2, 1, '2.2.0', $3, 'ACTIVE', NOW()) RETURNING id`, [ws, profile.rows[0]!.id, `fixture-${randomUUID()}`]);
    const profileVersionId = version.rows[0]!.id;
    const make = async (over: { state?: string; outcome?: string; eligibility?: string; quality?: string; policy?: string; lane?: string | null; content?: boolean }) => {
      const j = await job(ws, { state: over.state ?? "MATCHED", outcome: over.outcome ?? "REVIEW" });
      await db().query(
        `UPDATE canonical_jobs SET primary_lane = $2, recommendation_eligibility = $3, description_quality_status = $4 WHERE id = $1`,
        [j.canonicalJobId, over.lane === undefined ? "CORE_AI_DATA" : over.lane, over.eligibility ?? "ELIGIBLE", over.quality ?? "COMPLETE"]);
      if (over.content !== false) await observation(ws, j.jobVersionId, "LEVER");
      await matchRun(ws, j, profileVersionId, over.policy ?? "matcher-old");
      return j.canonicalJobId;
    };
    const counted = [
      await make({}),
      await make({ outcome: "TRACK" }),
      await make({ state: "QUEUED_FOR_AI", outcome: "PRIORITY" }), // eligible and routed: the seed re-matches it
    ];
    await make({ policy: currentMatcherPolicyVersion() });
    await make({ outcome: "SKIP" });
    await make({ eligibility: "VERIFY" });
    await make({ state: "HARD_REJECTED" });
    await make({ lane: "UNCLASSIFIED" });
    await make({ quality: "INCOMPLETE" });
    await make({ content: false });
    const check = await staleStageResults(db(), ws);
    expect(check.detail?.matcher).toBe(3);
    expect([...check.sample].filter((id) => id.startsWith("matcher:")).sort())
      .toEqual(counted.map((id) => `matcher:${id}`).sort());
  });

  it("stale lane router check counts only what a rule-version bump reopens, with a published job embedding; LANE_ROUTED, MATCHED and other UNMATCHED never count (DEFERRED_BUDGET is not a stored state)", async () => {
    const ws = await newWorkspace();
    const old = "lane_router_old|lanes_x|";
    const make = async (state: string, over: { disposition?: string | null; model?: string; embedded?: boolean; blocked?: boolean } = {}) => {
      const j = await job(ws, { state });
      if (over.disposition !== undefined) await db().query(`UPDATE canonical_jobs SET routing_disposition = $2 WHERE id = $1`, [j.canonicalJobId, over.disposition]);
      await laneDecision(ws, j, over.model ?? old);
      if (over.embedded !== false) await publishJobVersionEmbedding(ws, j.jobVersionId);
      if (over.blocked) {
        await db().query(
          `INSERT INTO pipeline_tasks (workspace_id, task_type, task_key, payload, status, blocked_on) VALUES ($1, 'ROUTE_LANE', $2, $3::jsonb, 'BLOCKED_DEPENDENCY', 'JOB_CONTENT')`,
          [ws, `ROUTE_LANE:${j.jobVersionId}:blocked`, JSON.stringify({ canonical_job_id: j.canonicalJobId, job_version_id: j.jobVersionId })]);
      }
      return j.canonicalJobId;
    };
    const counted = [
      await make("PREQUALIFIED"),
      await make("ROUTING_DEFERRED", { disposition: "TECHNICAL_DEFERRED" }),
      await make("UNMATCHED", { disposition: "POLICY_NO_MATCH" }),
    ];
    await make("PREQUALIFIED", { model: `${LANE_ROUTER_RULE_VERSION}|lanes_x|` }); // current version
    await make("PREQUALIFIED", { embedded: false }); // the seed needs a published embedding
    await make("PREQUALIFIED", { blocked: true }); // blocked on missing content
    await make("UNMATCHED", { disposition: "ROUTED" }); // not POLICY_NO_MATCH
    await make("LANE_ROUTED");
    await make("MATCHED");
    await make("HARD_REJECTED");
    const check = await staleStageResults(db(), ws);
    expect(check.detail?.lane_router).toBe(3);
    expect([...check.sample].filter((id) => id.startsWith("lane_router:")).sort())
      .toEqual(counted.map((id) => `lane_router:${id}`).sort());
  });

  it("stale extractor check leaves out a version blocked on JOB_CONTENT, as the seed does", async () => {
    const ws = await newWorkspace();
    const blocked = await job(ws, { state: "PREQUALIFIED" });
    const open = await job(ws, { state: "PREQUALIFIED" });
    for (const j of [blocked, open]) {
      const identity = await db().query<{ id: string }>(
        `INSERT INTO requirement_set_identities (workspace_id, canonical_job_id, identity_hash, job_content_hash, deterministic_extractor_version, quoted_extractor_version,
           quoted_prompt_hash, normalizer_hash, quoted_enabled) VALUES ($1, $2, $3, 'c', 'deterministic_v0', 'q', 'p', 'n', FALSE) RETURNING id`, [ws, j.canonicalJobId, randomUUID()]);
      const set = await db().query<{ id: string }>(
        `INSERT INTO requirement_sets (workspace_id, requirement_identity_id, canonical_job_id, job_version_id, revision_number, source_type)
         VALUES ($1, $2, $3, $4, 1, 'EXTRACTED') RETURNING id`, [ws, identity.rows[0]!.id, j.canonicalJobId, j.jobVersionId]);
      await db().query(`UPDATE job_versions SET active_requirement_set_id = $1 WHERE id = $2`, [set.rows[0]!.id, j.jobVersionId]);
    }
    await db().query(
      `INSERT INTO pipeline_tasks (workspace_id, task_type, task_key, payload, status, blocked_on) VALUES ($1, 'EXTRACT_DETERMINISTIC_REQUIREMENTS', $2, $3::jsonb, 'BLOCKED_DEPENDENCY', 'JOB_CONTENT')`,
      [ws, `EXTRACT:${blocked.jobVersionId}:b`, JSON.stringify({ canonical_job_id: blocked.canonicalJobId, job_version_id: blocked.jobVersionId })]);
    const check = await staleStageResults(db(), ws);
    expect(check.sample).toEqual([`extractor:${open.canonicalJobId}`]);
  });

  it("stage result older than the rule version: the extractor is reported when its requirement set came from an older version; phase pre leaves the stale check out", async () => {
    const ws = await newWorkspace();
    const staleExtract = await job(ws, { state: "PREQUALIFIED" });
    const currentExtract = await job(ws, { state: "PREQUALIFIED" });
    for (const [j, version] of [[staleExtract, "deterministic_v0"], [currentExtract, DETERMINISTIC_EXTRACTOR_VERSION]] as const) {
      const identity = await db().query<{ id: string }>(
        `INSERT INTO requirement_set_identities (workspace_id, canonical_job_id, identity_hash, job_content_hash, deterministic_extractor_version, quoted_extractor_version,
           quoted_prompt_hash, normalizer_hash, quoted_enabled) VALUES ($1, $2, $3, 'c', $4, 'q', 'p', 'n', FALSE) RETURNING id`, [ws, j.canonicalJobId, randomUUID(), version]);
      const set = await db().query<{ id: string }>(
        `INSERT INTO requirement_sets (workspace_id, requirement_identity_id, canonical_job_id, job_version_id, revision_number, source_type)
         VALUES ($1, $2, $3, $4, 1, 'EXTRACTED') RETURNING id`, [ws, identity.rows[0]!.id, j.canonicalJobId, j.jobVersionId]);
      await db().query(`UPDATE job_versions SET active_requirement_set_id = $1 WHERE id = $2`, [set.rows[0]!.id, j.jobVersionId]);
    }
    const check = await staleStageResults(db(), ws);
    expect(check.sample).toEqual([`extractor:${staleExtract.canonicalJobId}`]);
    expect((await runZeroChecks(db(), ws)).map((entry) => entry.name)).toContain("stage_result_older_than_rule_version");
    const pre = await runZeroChecks(db(), ws, { phase: "pre" });
    expect(pre.map((entry) => entry.name)).not.toContain("stage_result_older_than_rule_version");
    expect(zeroChecksExitCode(pre)).toBe(0);
  });
});

describe("process_backlog.yml wiring", () => {
  it("the reconcile step before the drain passes --phase=pre, the one after does not (strict)", async () => {
    const { readFileSync } = await import("node:fs");
    const { load } = await import("js-yaml");
    const workflow = load(readFileSync(".github/workflows/process_backlog.yml", "utf8")) as { jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }> };
    const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
    const before = steps.find((step) => step.name === "Reconcile pipeline before drain");
    const after = steps.find((step) => step.name === "Reconcile pipeline after drain");
    expect(before?.run).toContain("reconcile_pipeline.ts");
    expect(before?.run).toContain("--phase=pre");
    expect(after?.run).toContain("reconcile_pipeline.ts");
    expect(after?.run).not.toContain("--phase=pre");
    const drain = steps.findIndex((step) => step.name === "Process saved discovery backlog");
    expect(steps.indexOf(before!)).toBeLessThan(drain);
    expect(steps.indexOf(after!)).toBeGreaterThan(drain);
  });
});
