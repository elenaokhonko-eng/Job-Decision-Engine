import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "crypto";
import pg from "pg";

import { JobConfirmedFactRequestSchema } from "../../contracts/jobConfirmedFacts.js";
import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { upsertLaneRevision } from "../../lanes/registry.js";
import { loadWorkspaceLanesConfig } from "../../pipeline/laneConfigLoader.js";
import {
  loadConfirmedFactHistory,
  loadJobVerificationChecks,
  recordConfirmedJobFact,
  withdrawConfirmedJobFact,
} from "../../services/jobConfirmedFactService.js";
import { enqueuePipelineTask } from "../../tasks/pipelineTasks.js";
import { runPipelineStageTaskWorker, type PipelineStageTaskType } from "../../tasks/stageTaskWorker.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";
import { batchEmbeddingFromPerInput } from "../fixtures/embeddingBatchMock.js";
import { insertCompletePostingEvidence } from "../fixtures/completePostingEvidence.js";
import { buildEvidenceRevisionHash, buildJobSourceEvidence } from "../../ingestion/jobSourceEvidence.js";

// Real PostgreSQL: the confirmed-fact table and views, the hard gate, embedding publication, the lane
// router, the deterministic matcher, the recommendation decider and the stage task worker all run
// against migrated tables. Only the embedding provider is a deterministic synthetic vector function.
// Every job, employer and profile fact is synthetic.
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the confirmed-fact pipeline integration tests against its PostgreSQL service.");
}

const TEST_LANE = "ZEBRA_CONFIRMED_FACT_TEST";
const ENV_KEYS = [
  "REQUIREMENTS_ENABLE_QUOTED",
  "EMBEDDING_PRIMARY_PROVIDER",
  "EMBEDDING_PRIMARY_DIMENSIONS",
  "EMBEDDING_FALLBACK_DIMENSIONS",
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const STAGES: PipelineStageTaskType[] = [
  "APPLY_HARD_GATES",
  "PUBLISH_EMBEDDING",
  "ROUTE_LANE",
  "MATCH_PROFILE_EVIDENCE",
  "DECIDE_RECOMMENDATION",
];

interface FixtureJob {
  canonicalJobId: string;
  jobVersionId: string;
}

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;
const jobs: Record<"hybrid" | "onsite" | "statedRemote", FixtureJob> = {} as never;

function db(): pg.PoolClient {
  if (!client) throw new Error("The integration test database client is not initialized.");
  return client;
}

function ctx(): WorkspaceContext {
  if (!context) throw new Error("The integration test workspace context is not initialized.");
  return context;
}

async function syntheticEmbedding(text: string): Promise<number[]> {
  return text.toLowerCase().includes("zebra") ? [1, 0, 0, 0] : [0, 1, 0, 0];
}

/**
 * A Singapore job whose posting never states a work mode (stored as the SG policy assumption), or,
 * with `statedRemote`, one whose description says it is fully remote.
 */
async function seedUnknownWorkModeJob(key: string, options: { statedRemote?: boolean } = {}): Promise<FixtureJob> {
  const workspaceId = ctx().workspaceId;
  const title = `Zebra Telemetry Platform Engineer ${key}`;
  const company = `Synthetic Zebra Confirmed Fixture ${key}`;
  const url = `https://example.test/zebra-confirmed-${key}`;
  const description = [
    `About the role: zebra telemetry platform engineer (${key}) at a synthetic fixture employer in Singapore.`,
    "Responsibilities: build and operate zebra telemetry ingestion services, write software, review designs and support releases.",
    "Requirements: production platform engineering experience with streaming telemetry systems and Python.",
    ...(options.statedRemote ? ["This position is fully remote within Singapore."] : []),
  ].join(" ");
  const canonical = await db().query<{ id: string }>(
    `INSERT INTO canonical_jobs (
       workspace_id, company_name, normalized_title, canonical_url,
       location, location_summary, workplace_type, employment_type,
       processing_status, processing_state
     ) VALUES ($1, $2, $3, $4, 'Singapore', 'Singapore', $5, 'PERMANENT', 'RAW_STAGED', 'RAW_STAGED')
     RETURNING id`,
    [workspaceId, company, title, url, options.statedRemote ? "UNKNOWN" : "ASSUMED_HYBRID"],
  );
  const canonicalJobId = canonical.rows[0].id;
  const contentHash = `zebra-confirmed-content-${key}`;
  const version = await db().query<{ id: string }>(
    `INSERT INTO job_versions (workspace_id, canonical_job_id, version_number, content_hash, description_text)
     VALUES ($1, $2, 1, $3, $4) RETURNING id`,
    [workspaceId, canonicalJobId, contentHash, description],
  );
  const jobVersionId = version.rows[0].id;
  await db().query(
    `UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE workspace_id = $2 AND id = $3`,
    [jobVersionId, workspaceId, canonicalJobId],
  );
  const observationId = await insertCompletePostingEvidence(db(), { workspaceId, jobVersionId, companyName: company, title, sourceUrl: url, description });
  // Normalized source evidence as the source broker stores it: the posting states no work mode.
  const evidence = buildJobSourceEvidence({
    sourceName: "EMPLOYER_WEBSITE",
    sourcePluginKey: null,
    sourcePluginRevisionId: null,
    sourceExternalId: `fixture-${observationId}`,
    sourceUrl: url,
    canonicalApplyUrl: url,
    retrievedAt: new Date().toISOString(),
    rawPayloadHash: crypto.createHash("sha256").update(description).digest("hex"),
    rawPayload: { source_content_status: "COMPLETE" },
    companyName: company,
    title,
    locationRaw: "Singapore",
    workplaceTypeRaw: null,
    employmentTypeRaw: "Permanent",
    compensationRaw: null,
    descriptionText: description,
  });
  if (!options.statedRemote) expect(evidence.workability.work_mode.status).not.toBe("SUPPORTED");
  await db().query(
    `UPDATE raw_job_observations SET normalized_evidence = $1::jsonb WHERE workspace_id = $2 AND id = $3`,
    [JSON.stringify(evidence), workspaceId, observationId],
  );
  await db().query(
    `UPDATE job_versions SET evidence_revision_hash = $1 WHERE workspace_id = $2 AND id = $3`,
    [buildEvidenceRevisionHash(evidence), workspaceId, jobVersionId],
  );

  const identity = await db().query<{ id: string }>(
    `INSERT INTO requirement_set_identities (
       workspace_id, canonical_job_id, identity_hash, job_content_hash,
       deterministic_extractor_version, quoted_extractor_version,
       quoted_prompt_hash, normalizer_hash, quoted_enabled
     ) VALUES ($1, $2, $3, $4, 'deterministic-fixture-v1', 'quoted-fixture-v1',
               'quoted-prompt-fixture-v1', 'normalizer-fixture-v1', FALSE)
     RETURNING id`,
    [workspaceId, canonicalJobId, `zebra-confirmed-identity-${key}`, contentHash],
  );
  const requirementSet = await db().query<{ id: string }>(
    `INSERT INTO requirement_sets (
       workspace_id, requirement_identity_id, canonical_job_id, job_version_id, revision_number, source_type
     ) VALUES ($1, $2, $3, $4, 1, 'EXTRACTED') RETURNING id`,
    [workspaceId, identity.rows[0].id, canonicalJobId, jobVersionId],
  );
  const requirementSetId = requirementSet.rows[0].id;
  await db().query(
    `UPDATE job_versions SET active_requirement_set_id = $1 WHERE workspace_id = $2 AND id = $3`,
    [requirementSetId, workspaceId, jobVersionId],
  );
  await db().query(
    `INSERT INTO job_requirements (
       workspace_id, canonical_job_id, job_version_id, requirement_set_id,
       requirement_key, requirement_type, importance, requirement_text,
       extractor_type, extractor_version, confidence, status
     ) VALUES ($1, $2, $3, $4, 'function-1', 'FUNCTION', 'MUST',
               'Zebra telemetry platform engineering experience',
               'DETERMINISTIC', 'deterministic-fixture-v1', 1, 'VALIDATED')`,
    [workspaceId, canonicalJobId, jobVersionId, requirementSetId],
  );
  await db().query(
    `INSERT INTO requirement_extraction_runs (
       workspace_id, canonical_job_id, job_version_id, requirement_set_id,
       run_type, status, requirements_extracted, completed_at
     ) VALUES ($1, $2, $3, $4, 'DETERMINISTIC', 'COMPLETED', 1, NOW())`,
    [workspaceId, canonicalJobId, jobVersionId, requirementSetId],
  );
  await db().query(
    `INSERT INTO job_version_pipeline_state (
       workspace_id, canonical_job_id, job_version_id, current_stage, stage_status
     ) VALUES ($1, $2, $3, 'REQUIREMENTS_EXTRACTED', 'COMPLETED')`,
    [workspaceId, canonicalJobId, jobVersionId],
  );
  return { canonicalJobId, jobVersionId };
}

async function runStages(job: FixtureJob) {
  const summary = await runPipelineStageTaskWorker(db(), {
    context: ctx(),
    taskTypes: STAGES,
    jobVersionIds: [job.jobVersionId],
    seed: false,
    includeTestFixtures: true,
    reconcileStalePending: false,
    heartbeatSeconds: 0,
    minTimeToStartTaskMs: 0,
    maxTasks: 40,
  });
  expect(summary.errors).toEqual([]);
  expect(summary.failed).toBe(0);
  expect(summary.deadLettered).toBe(0);
  return summary;
}

async function jobState(job: FixtureJob) {
  const { rows } = await db().query<{
    processing_state: string;
    gate_decision: string;
    recommendation_eligibility: string | null;
    recommendation_outcome: string | null;
    workplace_type: string | null;
    readiness_json: { checks?: Array<{ key: string; status: string; reason_code: string | null; evidence_keys: string[] }> } | null;
    decision_job_version_id: string | null;
  }>(
    `SELECT c.processing_state, c.gate_decision, c.recommendation_eligibility, c.recommendation_outcome,
            c.workplace_type, dd.readiness_json, dd.job_version_id::text AS decision_job_version_id
     FROM canonical_jobs c
     LEFT JOIN deterministic_decisions dd ON dd.id = c.latest_deterministic_decision_id
     WHERE c.workspace_id = $1 AND c.id = $2`,
    [ctx().workspaceId, job.canonicalJobId],
  );
  return rows[0];
}

async function latestGate(job: FixtureJob) {
  const { rows } = await db().query<{ decision: string; rejection_codes: string[]; evidence_quotes: string[] }>(
    `SELECT decision, rejection_codes, evidence_quotes
     FROM gate_decisions
     WHERE workspace_id = $1 AND job_version_id = $2
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [ctx().workspaceId, job.jobVersionId],
  );
  return rows[0];
}

function readinessCheck(state: Awaited<ReturnType<typeof jobState>>, key: string) {
  return state.readiness_json?.checks?.find((check) => check.key === key);
}

async function confirm(job: FixtureJob, body: Record<string, unknown>) {
  return recordConfirmedJobFact(
    db(),
    ctx(),
    job.canonicalJobId,
    JobConfirmedFactRequestSchema.parse({ job_version_id: job.jobVersionId, ...body }),
  );
}

describe.skipIf(skipReal)("employer-confirmed job facts through the gate, matching and readiness", () => {
  beforeAll(async () => {
    process.env.REQUIREMENTS_ENABLE_QUOTED = "false";
    process.env.EMBEDDING_PRIMARY_PROVIDER = "gemini";
    process.env.EMBEDDING_PRIMARY_DIMENSIONS = "4";
    process.env.EMBEDDING_FALLBACK_DIMENSIONS = "4";
    const agent = await import("../../services/agent.js");
    vi.spyOn(agent, "generateEmbedding").mockImplementation(syntheticEmbedding);
    vi.spyOn(agent, "generateEmbeddingWithProvider").mockImplementation(syntheticEmbedding as any);
    vi.spyOn(agent, "generateEmbeddingWithProviderAndModel").mockImplementation(syntheticEmbedding as any);
    vi.spyOn(agent, "generateEmbeddingsWithProviderAndModel")
      .mockImplementation(batchEmbeddingFromPerInput(syntheticEmbedding));

    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `confirmed_facts_${Date.now()}_${crypto.randomInt(100000, 999999)}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);

    await loadWorkspaceLanesConfig(db(), { context: ctx(), seedIfEmpty: true });
    await upsertLaneRevision(
      {
        laneKey: TEST_LANE,
        content: {
          schema_version: "2.2.0",
          lane_key: TEST_LANE,
          display_name: "Zebra confirmed-fact test lane",
          description: "Synthetic lane for zebra telemetry platform engineering fixtures.",
          scope: {
            included_domain_concepts: { any: ["zebra telemetry"] },
            required_function_concepts: { any: ["platform engineer"] },
          },
          prototypes: [{ prototype_key: "zebra-platform", text: "Zebra telemetry platform engineer." }],
          routing: { minimum_semantic_score: 0.35 },
        },
      },
      db(),
      { context: ctx(), note: "confirmed-fact fixture" },
    );

    const profile = await db().query<{ id: string }>(
      `INSERT INTO candidate_profiles (workspace_id, profile_key, display_name)
       VALUES ($1, 'zebra_confirmed_profile', 'Zebra Confirmed Profile') RETURNING id`,
      [ctx().workspaceId],
    );
    const version = await db().query<{ id: string }>(
      `INSERT INTO profile_versions (
         workspace_id, candidate_profile_id, version_number, schema_version, source_hash, status, effective_at
       ) VALUES ($1, $2, 1, '2.2.0', 'zebra-confirmed-profile-v1', 'ACTIVE', NOW()) RETURNING id`,
      [ctx().workspaceId, profile.rows[0].id],
    );
    await db().query(
      `INSERT INTO profile_facts (
         workspace_id, profile_version_id, fact_key, fact_type, statement,
         structured_value, evidence_tier, verification_status
       ) VALUES ($1, $2, 'zebra-platform', 'SKILL',
         'Zebra telemetry platform engineering for production streaming systems',
         '{}'::jsonb, 'PROFESSIONAL_PRODUCTION', 'VERIFIED')`,
      [ctx().workspaceId, version.rows[0].id],
    );

    jobs.hybrid = await seedUnknownWorkModeJob("verify-a");
    jobs.onsite = await seedUnknownWorkModeJob("verify-b");
    jobs.statedRemote = await seedUnknownWorkModeJob("stated-remote", { statedRemote: true });

    // The first pipeline pass: the gate cannot establish the work mode, so the job is routed and
    // matched as a workability verification and the decision is VERIFY.
    for (const job of Object.values(jobs)) {
      const taskKey = `APPLY_HARD_GATES:${job.jobVersionId}:hard_gate_v1`;
      await enqueuePipelineTask({
        taskType: "APPLY_HARD_GATES",
        taskKey,
        payload: { canonical_job_id: job.canonicalJobId, job_version_id: job.jobVersionId },
        producer: "confirmed-fact-fixture",
        stageVersion: "hard_gate_v1",
        requestId: taskKey,
      }, db(), { context: ctx() });
      await runStages(job);
    }
  }, 240_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
      client = undefined;
    }
    if (pool) {
      await pool.end();
      pool = undefined;
    }
  });

  it("starts as a VERIFY job with an open work-mode check and no confirmed facts", async () => {
    for (const job of [jobs.hybrid, jobs.onsite]) {
      const state = await jobState(job);
      expect(state.gate_decision).toBe("NEEDS_VERIFICATION");
      expect(state.recommendation_eligibility).toBe("VERIFY");
      expect(state.decision_job_version_id).toBe(job.jobVersionId);
      expect(readinessCheck(state, "WORK_MODE")).toMatchObject({ status: "NEEDS_VERIFICATION", reason_code: "WORK_MODE_UNVERIFIED" });
      const gate = await latestGate(job);
      expect(gate.rejection_codes).toContain("GATE_UNKNOWN_WORK_MODE");

      const checks = await loadJobVerificationChecks(db(), ctx(), job.canonicalJobId);
      expect(checks).toMatchObject({
        job_version_id: job.jobVersionId,
        gate_decision: "NEEDS_VERIFICATION",
        confirmed_facts: [],
        confirmed_fact_history_count: 0,
        rerun_pending: false,
      });
      expect(checks?.open_checks).toContain("WORK_MODE");
      expect(checks?.gate_workability_facts).toMatchObject({ employment_type: "PERMANENT" });
    }
  });

  it("records a confirmed fact append-only and enqueues a forced gate re-run in the same transaction", async () => {
    const first = await confirm(jobs.hybrid, {
      fact_type: "WORK_MODE",
      value: { work_mode: "ONSITE" },
      source_type: "RECRUITER_EMAIL",
      source_note: "Initial reply, later corrected",
    });
    expect(first.supersededFactId).toBeNull();
    // The recruiter corrected themselves: the corrected fact supersedes the first one.
    const corrected = await confirm(jobs.hybrid, {
      fact_type: "WORK_MODE",
      value: { work_mode: "HYBRID" },
      source_type: "RECRUITER_CALL",
      source_url: "https://careers.example.test/zebra/hybrid-policy",
    });
    expect(corrected.supersededFactId).toBe(first.fact.confirmed_fact_id);
    expect(corrected.fact).toMatchObject({ fact_type: "WORK_MODE", fact_value: { work_mode: "HYBRID" }, recorded_by_user_id: ctx().userId });

    const { rows: history } = await db().query<{ id: string; supersedes_fact_id: string | null }>(
      `SELECT id, supersedes_fact_id FROM job_confirmed_facts
       WHERE workspace_id = $1 AND job_version_id = $2 ORDER BY recorded_at, id`,
      [ctx().workspaceId, jobs.hybrid.jobVersionId],
    );
    expect(history).toEqual([
      { id: first.fact.confirmed_fact_id, supersedes_fact_id: null },
      { id: corrected.fact.confirmed_fact_id, supersedes_fact_id: first.fact.confirmed_fact_id },
    ]);
    await expect(db().query(`UPDATE job_confirmed_facts SET source_note = 'edited' WHERE id = $1`, [first.fact.confirmed_fact_id]))
      .rejects.toThrow(/append-only/);
    await expect(db().query(`DELETE FROM job_confirmed_facts WHERE id = $1`, [first.fact.confirmed_fact_id]))
      .rejects.toThrow(/append-only/);
    // A second root for the same chain is refused by the database, not only by the service.
    await expect(db().query(
      `INSERT INTO job_confirmed_facts (workspace_id, canonical_job_id, job_version_id, fact_type, fact_value, source_type,
                                        posting_assessment, posting_evidence, recorded_by_user_id)
       VALUES ($1, $2, $3, 'WORK_MODE', '{"work_mode":"REMOTE"}'::jsonb, 'OTHER', 'FILLS_UNKNOWN', '{}'::jsonb, $4)`,
      [ctx().workspaceId, jobs.hybrid.canonicalJobId, jobs.hybrid.jobVersionId, ctx().userId],
    )).rejects.toThrow(/uq_job_confirmed_facts_chain_root/);
    await expect(db().query("TRUNCATE job_confirmed_facts")).rejects.toThrow(/append-only/);
    expect(corrected.fact.posting_assessment).toBe("FILLS_UNKNOWN");
    expect(corrected.fact.posting_evidence).toMatchObject({ state: "UNKNOWN" });

    const { rows: tasks } = await db().query<{ task_key: string; status: string; payload: Record<string, any> }>(
      `SELECT task_key, status, payload FROM pipeline_tasks
       WHERE workspace_id = $1 AND task_type = 'APPLY_HARD_GATES' AND payload->>'job_version_id' = $2
         AND task_key LIKE '%confirmed-fact%'
       ORDER BY created_at, id`,
      [ctx().workspaceId, jobs.hybrid.jobVersionId],
    );
    expect(tasks.map((task) => task.task_key)).toEqual([
      `APPLY_HARD_GATES:${jobs.hybrid.jobVersionId}:hard_gate_v1:confirmed-fact:${first.fact.confirmed_fact_id}`,
      `APPLY_HARD_GATES:${jobs.hybrid.jobVersionId}:hard_gate_v1:confirmed-fact:${corrected.fact.confirmed_fact_id}`,
    ]);
    for (const task of tasks) {
      expect(task.status).toBe("PENDING");
      expect(task.payload).toMatchObject({
        canonical_job_id: jobs.hybrid.canonicalJobId,
        reprocess: true,
        reprocess_existing_state: true,
        task_intent: { mode: "FORCE_RECOMPUTE", producer: "api.job_confirmed_fact" },
      });
    }

    const checks = await loadJobVerificationChecks(db(), ctx(), jobs.hybrid.canonicalJobId);
    expect(checks?.open_checks).not.toContain("WORK_MODE");
    expect(checks?.confirmed_facts.map((fact) => fact.confirmed_fact_id)).toEqual([corrected.fact.confirmed_fact_id]);
    expect(checks?.confirmed_fact_history_count).toBe(2);
    expect(checks?.rerun_pending).toBe(true);
    // Recording a fact changes no pipeline state by itself.
    expect((await jobState(jobs.hybrid)).recommendation_eligibility).toBe("VERIFY");
  });

  it("a confirmed hybrid work mode passes the gate and clears the VERIFY eligibility and work-mode readiness", async () => {
    const summary = await runStages(jobs.hybrid);
    expect(summary.byType.APPLY_HARD_GATES?.completed).toBe(2);
    expect(summary.byType.DECIDE_RECOMMENDATION?.completed).toBeGreaterThanOrEqual(1);

    const gate = await latestGate(jobs.hybrid);
    expect(gate.decision).toBe("PASS");
    expect(gate.rejection_codes).toEqual([]);
    expect(gate.evidence_quotes).toContain("User-confirmed (source: recruiter call): work mode is hybrid");

    const state = await jobState(jobs.hybrid);
    expect(state.recommendation_eligibility).toBe("ELIGIBLE");
    expect(state.recommendation_outcome).not.toBe("SKIP");
    // The posting fact is unchanged; only the evidence used by the gate and readiness changed.
    expect(state.workplace_type).toBe("ASSUMED_HYBRID");
    const workMode = readinessCheck(state, "WORK_MODE");
    expect(workMode).toMatchObject({ status: "MET", reason_code: null });
    expect(workMode?.evidence_keys.some((key) => key.startsWith("user_confirmed:WORK_MODE:"))).toBe(true);
    expect(readinessCheck(state, "EMPLOYER_POLICY")).toMatchObject({ status: "MET" });
    expect(state.readiness_json?.checks?.filter((check) => check.status === "BLOCKED")).toEqual([]);
    // No workability check is left open; what remains (if anything) is source availability,
    // freshness or compensation evidence, which an employer workability fact does not settle.
    const stillOpen = (state.readiness_json?.checks ?? [])
      .filter((check) => check.status === "NEEDS_VERIFICATION")
      .map((check) => check.key);
    console.info(`confirmed-hybrid remaining readiness checks: ${stillOpen.join(", ") || "none"}`);
    for (const key of ["WORK_MODE", "TRAVEL", "WORK_AUTHORIZATION", "EMPLOYMENT_ROUTE", "EMPLOYER_POLICY"]) {
      expect(stillOpen).not.toContain(key);
    }

    const checks = await loadJobVerificationChecks(db(), ctx(), jobs.hybrid.canonicalJobId);
    expect(checks).toMatchObject({ gate_decision: "PASS", rerun_pending: false });
    expect(checks?.open_checks).not.toContain("WORK_MODE");
  }, 120_000);

  it("a confirmed on-site role without an exception becomes HARD_REJECTED with the user-confirmed evidence", async () => {
    await confirm(jobs.onsite, {
      fact_type: "WORK_MODE",
      value: { work_mode: "ONSITE" },
      source_type: "HIRING_MANAGER",
    });
    await runStages(jobs.onsite);

    const gate = await latestGate(jobs.onsite);
    expect(gate.decision).toBe("HARD_REJECT");
    expect(gate.rejection_codes).toContain("GATE_HIGH_OFFICE_DAYS");
    expect(gate.evidence_quotes).toContain("User-confirmed (source: hiring manager): work mode is on-site only");

    const state = await jobState(jobs.onsite);
    expect(state.processing_state).toBe("HARD_REJECTED");
    expect(state.recommendation_eligibility).toBe("INELIGIBLE");
    expect(readinessCheck(state, "WORK_MODE")).toMatchObject({ status: "BLOCKED" });
  }, 120_000);

  it("records a confirmation that contradicts a stated remote posting as a conflict and leaves the gate unchanged", async () => {
    const before = await latestGate(jobs.statedRemote);
    expect(before.decision).toBe("PASS");
    const recorded = await confirm(jobs.statedRemote, {
      fact_type: "WORK_MODE",
      value: { work_mode: "ONSITE" },
      source_type: "RECRUITER_EMAIL",
    });
    expect(recorded.fact.posting_assessment).toBe("CONFLICTS_WITH_POSTING");
    expect(recorded.fact.posting_evidence).toMatchObject({ state: "STATED", value: { work_mode: "REMOTE" } });
    await runStages(jobs.statedRemote);

    const after = await latestGate(jobs.statedRemote);
    expect(after.decision).toBe("PASS");
    expect(after.rejection_codes).toEqual(before.rejection_codes);
    expect(after.evidence_quotes.some((quote) => quote.startsWith("User confirmation not applied (source: recruiter email): work mode is on-site only; the posting states work mode remote"))).toBe(true);
    expect((await jobState(jobs.statedRemote)).processing_state).not.toBe("HARD_REJECTED");

    const checks = await loadJobVerificationChecks(db(), ctx(), jobs.statedRemote.canonicalJobId);
    expect(checks?.conflicts).toEqual([
      expect.objectContaining({
        confirmed_fact_id: recorded.fact.confirmed_fact_id,
        fact_type: "WORK_MODE",
        confirmed_value: { work_mode: "ONSITE" },
        confirmed_source_type: "RECRUITER_EMAIL",
        // The first gate run's enrichment stored the description's remote statement as the workplace type.
        posting_evidence: expect.objectContaining({ state: "STATED", source: "STRUCTURED_FIELD", summary: "work mode remote" }),
      }),
    ]);
  }, 120_000);

  it("withdrawing a confirmation restores the unknown fact and re-runs the gate, with the withdrawal audited", async () => {
    const current = await loadJobVerificationChecks(db(), ctx(), jobs.hybrid.canonicalJobId);
    const hybridFact = current?.confirmed_facts.find((fact) => fact.fact_type === "WORK_MODE");
    expect(hybridFact).toBeDefined();
    const withdrawn = await withdrawConfirmedJobFact(db(), ctx(), jobs.hybrid.canonicalJobId, hybridFact!.confirmed_fact_id, {
      job_version_id: jobs.hybrid.jobVersionId,
      reason: "Recorded for the wrong job",
    });
    expect(withdrawn.fact).toMatchObject({
      entry_kind: "WITHDRAWAL",
      fact_type: "WORK_MODE",
      source_type: null,
      source_note: "Recorded for the wrong job",
      supersedes_fact_id: hybridFact!.confirmed_fact_id,
      recorded_by_user_id: ctx().userId,
    });
    expect(withdrawn.rerun.taskKey).toContain(`confirmed-fact:${withdrawn.fact.confirmed_fact_id}`);
    // A withdrawn fact cannot be withdrawn again.
    await expect(withdrawConfirmedJobFact(db(), ctx(), jobs.hybrid.canonicalJobId, hybridFact!.confirmed_fact_id, {
      job_version_id: jobs.hybrid.jobVersionId,
      reason: null,
    })).rejects.toMatchObject({ status: 409, code: "FACT_NOT_CURRENT" });

    await runStages(jobs.hybrid);
    const gate = await latestGate(jobs.hybrid);
    expect(gate.decision).toBe("NEEDS_VERIFICATION");
    expect(gate.rejection_codes).toContain("GATE_UNKNOWN_WORK_MODE");
    expect((await jobState(jobs.hybrid)).recommendation_eligibility).toBe("VERIFY");

    const checks = await loadJobVerificationChecks(db(), ctx(), jobs.hybrid.canonicalJobId);
    expect(checks?.confirmed_facts).toEqual([]);
    expect(checks?.open_checks).toContain("WORK_MODE");
    expect(checks?.rerun_pending).toBe(false);
    const history = await loadConfirmedFactHistory(db(), ctx(), jobs.hybrid.canonicalJobId, jobs.hybrid.jobVersionId);
    expect(history.map((entry) => entry.entry_kind)).toEqual(["WITHDRAWAL", "CONFIRMATION", "CONFIRMATION"]);
  }, 120_000);

  it("refuses a fact for a job version that is not the job's current version", async () => {
    const otherVersion = await db().query<{ id: string }>(
      `INSERT INTO job_versions (workspace_id, canonical_job_id, version_number, content_hash, description_text)
       VALUES ($1, $2, 2, 'zebra-confirmed-content-verify-a-v2', 'A synthetic repost of the zebra telemetry role.')
       RETURNING id`,
      [ctx().workspaceId, jobs.hybrid.canonicalJobId],
    );
    await expect(recordConfirmedJobFact(db(), ctx(), jobs.hybrid.canonicalJobId, JobConfirmedFactRequestSchema.parse({
      job_version_id: otherVersion.rows[0].id,
      fact_type: "TRAVEL_PCT",
      value: { travel_pct_max: 5 },
      source_type: "OTHER",
    }))).rejects.toMatchObject({ status: 409, code: "JOB_VERSION_NOT_CURRENT" });
    // The database itself refuses a fact whose job version belongs to another job.
    await expect(db().query(
      `INSERT INTO job_confirmed_facts (workspace_id, canonical_job_id, job_version_id, fact_type, fact_value, source_type,
                                        posting_assessment, posting_evidence, recorded_by_user_id)
       VALUES ($1, $2, $3, 'TRAVEL_PCT', '{"travel_pct_max":5}'::jsonb, 'OTHER', 'FILLS_UNKNOWN', '{}'::jsonb, $4)`,
      [ctx().workspaceId, jobs.onsite.canonicalJobId, otherVersion.rows[0].id, ctx().userId],
    )).rejects.toThrow(/does not belong/);
  });
});
