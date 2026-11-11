import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

// Runs the Streamlit Review, Verify-then-apply, Track and Apply Now read-model
// queries against a migrated schema with seeded jobs. Fixtures are synthetic.
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
const streamlitAppPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../streamlit_app.py");

function streamlitQuery(name: string): string {
  const source = readFileSync(streamlitAppPath, "utf8");
  const pattern = new RegExp(`${name}\\s*=\\s*"""([\\s\\S]*?)"""`);
  const query = pattern.exec(source)?.[1];
  if (!query) throw new Error(`Streamlit read-model query ${name} was not found.`);
  let parameterIndex = 0;
  return query.replace(/%s/g, () => `$${++parameterIndex}`);
}

/** Every field the Streamlit job review panel reads from these queries. */
const REVIEW_PANEL_COLUMNS = [
  "workspace_id", "canonical_job_id", "job_version_id", "title", "company", "canonical_url",
  "source", "primary_lane", "processing_state", "gate_status", "rejection_codes",
  "gate_evidence_quotes", "workability_facts", "recommendation_eligibility",
  "recommendation_outcome", "deterministic_match_score", "deterministic_match_coverage",
  "recommendation_evidence_completeness", "nd_friendly_score", "politics_stress_score",
  "sensory_overload_index", "next_action", "evaluation_summary", "eval_provider",
  "eval_is_fallback", "version_mismatch", "current_artifact_status", "current_artifact_reason",
  "application_readiness", "readiness_status", "readiness_reason_codes",
];

interface SeedOptions {
  readonly title: string;
  readonly gate: "PASS" | "NEEDS_VERIFICATION";
  readonly gateCodes?: readonly string[];
  readonly gateQuotes?: readonly string[];
  readonly eligibility: "ELIGIBLE" | "VERIFY";
  readonly outcome: "REVIEW" | "TRACK";
  readonly readiness: "READY" | "NEEDS_VERIFICATION";
  /** false leaves the job without a current match run (MATCH_STALE). */
  readonly matched?: boolean;
}

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;
let profileVersionId = "";
let policySnapshotId = "";

function db(): pg.PoolClient {
  if (!client) throw new Error("The Streamlit review query test client is not initialized.");
  return client;
}

function workspace(): WorkspaceContext {
  if (!context) throw new Error("The Streamlit review query test workspace is not initialized.");
  return context;
}

async function seedJob(options: SeedOptions): Promise<{ canonicalJobId: string; jobVersionId: string }> {
  const database = db();
  const { workspaceId, userId } = workspace();
  const matched = options.matched ?? true;
  const canonical = await database.query<{ id: string }>(
    `INSERT INTO canonical_jobs (
       workspace_id, company_name, normalized_title, canonical_url,
       location_summary, workplace_type, employment_type, primary_lane,
       processing_state, processing_status, gate_decision,
       recommendation_eligibility, recommendation_outcome
     ) VALUES ($1, 'Review Query Fixture Co', $2, $3, 'Singapore', 'UNKNOWN', 'PERMANENT',
       'CORE_AI_DATA', 'MATCHED', 'MATCHED', $4, $5, $6)
     RETURNING id`,
    [
      workspaceId, options.title, `https://example.test/review-query/${crypto.randomUUID()}`,
      options.gate, options.eligibility, options.outcome,
    ],
  );
  const canonicalJobId = canonical.rows[0]!.id;
  const jobContentHash = `job-content-${crypto.randomUUID()}`;
  const evidenceRevisionHash = "e".repeat(64);
  const jobVersion = await database.query<{ id: string }>(
    `INSERT INTO job_versions (
       workspace_id, canonical_job_id, version_number, content_hash,
       description_text, observed_at, evidence_revision_hash,
       availability_status, availability_evidence, availability_verified_at,
       availability_recheck_at
     ) VALUES ($1, $2, 1, $3, 'Synthetic review-query fixture posting.', NOW(), $4,
       'OPEN', $5::jsonb, '2098-01-01T00:00:00Z', '2099-01-01T00:00:00Z')
     RETURNING id`,
    [
      workspaceId, canonicalJobId, jobContentHash, evidenceRevisionHash,
      JSON.stringify({ status: "OPEN", verification_method: "TEST_FIXTURE", reason_code: "SOURCE_CONFIRMED", evidence: [] }),
    ],
  );
  const jobVersionId = jobVersion.rows[0]!.id;
  await database.query(
    `INSERT INTO gate_decisions (
       workspace_id, canonical_job_id, job_version_id, decision,
       rejection_codes, evidence_quotes, workability_facts
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, '{}'::jsonb)`,
    [
      workspaceId, canonicalJobId, jobVersionId, options.gate,
      JSON.stringify(options.gateCodes ?? []), JSON.stringify(options.gateQuotes ?? []),
    ],
  );
  await database.query(
    `UPDATE canonical_jobs SET latest_job_version_id = $1, description_quality_status = 'COMPLETE'
     WHERE workspace_id = $2 AND id = $3`,
    [jobVersionId, workspaceId, canonicalJobId],
  );
  if (!matched) return { canonicalJobId, jobVersionId };

  const requirementIdentity = await database.query<{ id: string }>(
    `INSERT INTO requirement_set_identities (
       workspace_id, canonical_job_id, identity_hash, job_content_hash,
       deterministic_extractor_version, quoted_extractor_version,
       quoted_prompt_hash, normalizer_hash, quoted_enabled
     ) VALUES ($1, $2, $3, $4, 'deterministic-test-v1', 'quoted-test-v1',
       'quoted-prompt-test-v1', 'normalizer-test-v1', FALSE)
     RETURNING id`,
    [workspaceId, canonicalJobId, `identity-${crypto.randomUUID()}`, jobContentHash],
  );
  const requirementSet = await database.query<{ id: string }>(
    `INSERT INTO requirement_sets (
       workspace_id, requirement_identity_id, canonical_job_id, job_version_id,
       revision_number, source_type, created_by_user_id
     ) VALUES ($1, $2, $3, $4, 1, 'EXTRACTED', $5)
     RETURNING id`,
    [workspaceId, requirementIdentity.rows[0]!.id, canonicalJobId, jobVersionId, userId],
  );
  const requirementSetId = requirementSet.rows[0]!.id;
  await database.query(
    `UPDATE job_versions SET active_requirement_set_id = $1 WHERE workspace_id = $2 AND id = $3`,
    [requirementSetId, workspaceId, jobVersionId],
  );
  const matchRun = await database.query<{ id: string }>(
    `INSERT INTO match_runs (
       workspace_id, canonical_job_id, job_version_id, profile_version_id,
       requirement_set_id, job_content_hash, context_fingerprint, status,
       requirement_count, matched_count, completed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'COMPLETED', 1, 1, NOW())
     RETURNING id`,
    [
      workspaceId, canonicalJobId, jobVersionId, profileVersionId, requirementSetId,
      jobContentHash, `match-context-${crypto.randomUUID()}`,
    ],
  );
  const matchRunId = matchRun.rows[0]!.id;
  await database.query(
    `INSERT INTO raw_job_observations (
       workspace_id, source_name, source_external_id, source_url,
       company_name, title, description_raw, raw_payload, raw_payload_hash, job_version_id
     ) VALUES ($1, 'GREENHOUSE', $2, $3, 'Review Query Fixture Co', $4,
       'Synthetic review-query fixture posting.', '{}'::jsonb, $5, $6)`,
    [
      workspaceId, `review-query-${crypto.randomUUID()}`,
      `https://boards.greenhouse.io/example/jobs/${crypto.randomUUID()}`, options.title,
      crypto.randomBytes(32).toString("hex"), jobVersionId,
    ],
  );
  const availabilityReference = await database.query<{ value: string }>(
    `SELECT 'availability_verification_v1:'
      || to_char(availability_verified_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      || ':'
      || to_char(availability_recheck_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS value
     FROM job_versions WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, jobVersionId],
  );
  const readinessFingerprint = crypto.randomBytes(32).toString("hex");
  const expiresAt = "2099-01-01T00:00:00.000Z";
  const unresolved = options.readiness === "NEEDS_VERIFICATION";
  const readiness = {
    schema_version: "application_readiness_v1",
    status: options.readiness,
    reason_codes: unresolved ? ["WORK_MODE_UNVERIFIED"] : [],
    checks: [
      {
        key: "AVAILABILITY", status: "MET", importance: "MUST", reason_code: null,
        rationale: "Fixture availability evidence is current.", evidence_keys: [],
        policy_reference: availabilityReference.rows[0]?.value,
        assessed_at: "2098-01-01T00:00:00.000Z", expires_at: expiresAt,
      },
      ...(unresolved
        ? [{
          key: "WORKABILITY", status: "NEEDS_VERIFICATION", importance: "MUST",
          reason_code: "WORK_MODE_UNVERIFIED", rationale: "Fixture work mode is not stated.",
          evidence_keys: [], policy_reference: null,
          assessed_at: "2098-01-01T00:00:00.000Z", expires_at: expiresAt,
        }]
        : []),
    ],
    canonical_job_id: canonicalJobId,
    job_version_id: jobVersionId,
    profile_version_id: profileVersionId,
    requirement_set_id: requirementSetId,
    match_run_id: matchRunId,
    preference_context_id: null,
    policy_snapshot_id: policySnapshotId,
    policy_version: "fixture-policy-v1",
    qualification_comparator_version: "experience_scope_v2",
    evidence_revision_hash: evidenceRevisionHash,
    readiness_fingerprint: readinessFingerprint,
    evaluated_at: "2098-01-01T00:00:00.000Z",
    expires_at: expiresAt,
  };
  const decision = await database.query<{ id: string }>(
    `INSERT INTO deterministic_decisions (
       workspace_id, canonical_job_id, job_version_id, match_run_id,
       policy_snapshot_id, decision_hash, decision_json,
       recommendation_eligibility, recommendation_outcome, context_fingerprint,
       created_by_user_id, preference_user_id, preference_context_id,
       readiness_json, evidence_revision_hash, readiness_fingerprint
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, NULL, NULL, $12::jsonb, $13, $14)
     RETURNING id`,
    [
      workspaceId, canonicalJobId, jobVersionId, matchRunId, policySnapshotId,
      `decision-hash-${crypto.randomUUID()}`,
      JSON.stringify({ trace: { notes: ["Synthetic fixture decision."] } }),
      options.eligibility, options.outcome, `decision-context-${crypto.randomUUID()}`, userId,
      JSON.stringify(readiness), evidenceRevisionHash, readinessFingerprint,
    ],
  );
  await database.query(
    `UPDATE canonical_jobs SET latest_match_run_id = $1, latest_deterministic_decision_id = $2
     WHERE workspace_id = $3 AND id = $4`,
    [matchRunId, decision.rows[0]!.id, workspaceId, canonicalJobId],
  );
  return { canonicalJobId, jobVersionId };
}

function rowFor<T extends { canonical_job_id: string }>(rows: readonly T[], canonicalJobId: string): T | undefined {
  return rows.find((row) => row.canonical_job_id === canonicalJobId);
}

describe.skipIf(skipReal)("Streamlit review and verification read-model queries (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `streamlit_review_${crypto.randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);

    const profile = await client.query<{ id: string }>(
      `INSERT INTO candidate_profiles (workspace_id, profile_key, display_name)
       VALUES ($1, $2, 'Review Query Fixture Candidate') RETURNING id`,
      [context.workspaceId, `review-query-${crypto.randomUUID()}`],
    );
    const profileVersion = await client.query<{ id: string }>(
      `INSERT INTO profile_versions (
         workspace_id, candidate_profile_id, version_number, schema_version,
         source_hash, status, effective_at
       ) VALUES ($1, $2, 1, '2.2.0', $3, 'ACTIVE', NOW()) RETURNING id`,
      [context.workspaceId, profile.rows[0]!.id, `profile-${crypto.randomUUID()}`],
    );
    profileVersionId = profileVersion.rows[0]!.id;
    const policyRevisions = await client.query<{ config_key: string; config_revision_id: string }>(
      `SELECT definition.config_key, active.config_revision_id
       FROM config_active_revisions active
       JOIN config_definitions definition ON definition.id = active.config_definition_id
       WHERE definition.workspace_id = $1
         AND definition.config_key IN ('decision_policy', 'evidence_strength')`,
      [context.workspaceId],
    );
    const policySnapshot = await client.query<{ id: string }>(
      `INSERT INTO workspace_policy_snapshots (
         workspace_id, snapshot_hash, decision_policy_config_revision_id,
         evidence_strength_policy_config_revision_id, resolved_snapshot
       ) VALUES ($1, $2, $3, $4, '{}'::jsonb) RETURNING id`,
      [
        context.workspaceId,
        `policy-${crypto.randomUUID()}`,
        policyRevisions.rows.find((row) => row.config_key === "decision_policy")?.config_revision_id ?? null,
        policyRevisions.rows.find((row) => row.config_key === "evidence_strength")?.config_revision_id ?? null,
      ],
    );
    policySnapshotId = policySnapshot.rows[0]!.id;
  });

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
      client = undefined;
    }
    await pool?.end();
    pool = undefined;
  });

  it("returns every REVIEW job with Apply Now membership from the Stage 3 view, and the widened verify/track columns", async () => {
    const database = db();
    const { workspaceId } = workspace();

    const ready = await seedJob({
      title: "Ready Review Fixture", gate: "PASS", eligibility: "ELIGIBLE", outcome: "REVIEW", readiness: "READY",
    });
    const verify = await seedJob({
      title: "Verify Review Fixture",
      gate: "NEEDS_VERIFICATION",
      gateCodes: ["NEEDS_VERIFICATION", "GATE_UNKNOWN_WORK_MODE"],
      gateQuotes: ["Work arrangement to be discussed."],
      eligibility: "VERIFY",
      outcome: "REVIEW",
      readiness: "NEEDS_VERIFICATION",
    });
    const stale = await seedJob({
      title: "Stale Review Fixture", gate: "PASS", eligibility: "ELIGIBLE", outcome: "REVIEW",
      readiness: "READY", matched: false,
    });
    const track = await seedJob({
      title: "Track Fixture", gate: "PASS", eligibility: "VERIFY", outcome: "TRACK", readiness: "NEEDS_VERIFICATION",
    });

    const applyNow = await database.query<{ canonical_job_id: string }>(
      streamlitQuery("APPLY_NOW_JOBS_QUERY"), [workspaceId],
    );
    const applyNowIds = new Set(applyNow.rows.map((row) => row.canonical_job_id));

    const review = await database.query<Record<string, unknown> & { canonical_job_id: string }>(
      streamlitQuery("REVIEW_JOBS_QUERY"), [workspaceId],
    );
    const reviewColumns = review.fields.map((field) => field.name);
    for (const column of [...REVIEW_PANEL_COLUMNS, "in_apply_now", "blocked_task_count"]) {
      expect(reviewColumns).toContain(column);
    }
    expect(review.rows.map((row) => row.canonical_job_id).sort()).toEqual(
      [ready.canonicalJobId, verify.canonicalJobId, stale.canonicalJobId].sort(),
    );
    for (const row of review.rows) {
      expect(row.recommendation_outcome).toBe("REVIEW");
      expect(typeof row.in_apply_now).toBe("boolean");
      // Membership is exactly what the app's Apply Now query returns.
      expect(row.in_apply_now).toBe(applyNowIds.has(row.canonical_job_id));
    }
    expect(rowFor(review.rows, ready.canonicalJobId)?.in_apply_now).toBe(true);
    expect(rowFor(review.rows, ready.canonicalJobId)?.readiness_status).toBe("READY");
    const staleRow = rowFor(review.rows, stale.canonicalJobId);
    expect(staleRow?.current_artifact_status).toBe("MATCH_STALE");
    expect(staleRow?.in_apply_now).toBe(false);
    const verifyReviewRow = rowFor(review.rows, verify.canonicalJobId);
    expect(verifyReviewRow?.in_apply_now).toBe(false);
    expect(verifyReviewRow?.gate_status).toBe("NEEDS_VERIFICATION");
    expect(verifyReviewRow?.rejection_codes).toEqual(["NEEDS_VERIFICATION", "GATE_UNKNOWN_WORK_MODE"]);
    expect(verifyReviewRow?.readiness_reason_codes).toEqual(["WORK_MODE_UNVERIFIED"]);

    const verifyRows = await database.query<Record<string, unknown> & { canonical_job_id: string }>(
      streamlitQuery("VERIFY_THEN_APPLY_JOBS_QUERY"), [workspaceId],
    );
    const verifyColumns = verifyRows.fields.map((field) => field.name);
    for (const column of [...REVIEW_PANEL_COLUMNS, "blocked_task_count"]) {
      expect(verifyColumns).toContain(column);
    }
    expect(verifyRows.rows.map((row) => row.canonical_job_id)).toEqual([verify.canonicalJobId]);
    const verifyRow = verifyRows.rows[0]!;
    expect(verifyRow).toMatchObject({
      processing_state: "MATCHED",
      gate_status: "NEEDS_VERIFICATION",
      gate_evidence_quotes: ["Work arrangement to be discussed."],
      recommendation_eligibility: "VERIFY",
      readiness_status: "NEEDS_VERIFICATION",
      evaluation_summary: null,
    });
    expect(
      (verifyRow.application_readiness as { checks: { key: string }[] }).checks.map((check) => check.key),
    ).toContain("WORKABILITY");

    const trackRows = await database.query<Record<string, unknown> & { canonical_job_id: string }>(
      streamlitQuery("TRACK_JOBS_QUERY"), [workspaceId],
    );
    const trackColumns = trackRows.fields.map((field) => field.name);
    for (const column of [...REVIEW_PANEL_COLUMNS, "deterministic_trace_notes"]) {
      expect(trackColumns).toContain(column);
    }
    expect(trackRows.rows.map((row) => row.canonical_job_id)).toEqual([track.canonicalJobId]);
    expect(trackRows.rows[0]).toMatchObject({
      processing_state: "MATCHED",
      gate_status: "PASS",
      rejection_codes: [],
      recommendation_eligibility: "VERIFY",
      recommendation_outcome: "TRACK",
      readiness_status: "NEEDS_VERIFICATION",
      readiness_reason_codes: ["WORK_MODE_UNVERIFIED"],
    });
  });
});
