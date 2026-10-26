import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import pg from "pg";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { persistDocumentProvenance } from "../../documents/provenance.js";
import { reconcileStalePendingPipelineTasks } from "../../tasks/pipelineTaskCurrentness.js";
import { seedRecoverablePipelineTasks } from "../../tasks/stageTaskWorker.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;

function getClient(): pg.PoolClient {
  if (!client) throw new Error("The document provenance test client is not initialized.");
  return client;
}

function getContext(): WorkspaceContext {
  if (!context) throw new Error("The document provenance test workspace is not initialized.");
  return context;
}

describe.skipIf(skipReal)("current READY document provenance (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `document_pair_${crypto.randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
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

  it("persists CV and cover letter for one draft only with a current READY assessment", async ({ skip }) => {
    const database = getClient();
    const workspace = getContext();
    const { rows: viewRows } = await database.query<{ available: boolean }>(
      "SELECT to_regclass('v_application_readiness_current') IS NOT NULL AS available",
    );
    if (viewRows[0]?.available !== true) skip();

    const profile = await database.query<{ id: string }>(
      `INSERT INTO candidate_profiles (workspace_id, profile_key, display_name)
       VALUES ($1, $2, 'Current Readiness Document Fixture')
       RETURNING id`,
      [workspace.workspaceId, `document-pair-${crypto.randomUUID()}`],
    );
    const profileVersion = await database.query<{ id: string }>(
      `INSERT INTO profile_versions (
         workspace_id, candidate_profile_id, version_number, schema_version,
         source_hash, status, effective_at
       ) VALUES ($1, $2, 1, '2.2.0', $3, 'ACTIVE', NOW())
       RETURNING id`,
      [workspace.workspaceId, profile.rows[0]?.id, `profile-${crypto.randomUUID()}`],
    );
    const canonical = await database.query<{ id: string }>(
      `INSERT INTO canonical_jobs (
         workspace_id, company_name, normalized_title, canonical_url,
         location_summary, workplace_type, employment_type, primary_lane,
         processing_state, processing_status, gate_decision,
         recommendation_eligibility, recommendation_outcome
       ) VALUES ($1, 'Current Readiness Fixture', 'Data Engineer', $2,
         'Remote', 'REMOTE', 'PERMANENT', 'CORE_AI_DATA', 'MATCHED', 'MATCHED',
         'PASS', 'ELIGIBLE', 'REVIEW')
       RETURNING id`,
      [workspace.workspaceId, `https://example.test/document-pair/${crypto.randomUUID()}`],
    );
    const canonicalJobId = canonical.rows[0]?.id;
    const jobContentHash = `job-content-${crypto.randomUUID()}`;
    const evidenceRevisionHash = "e".repeat(64);
    const jobVersion = await database.query<{ id: string }>(
      `INSERT INTO job_versions (
         workspace_id, canonical_job_id, version_number, content_hash,
         description_text, observed_at, evidence_revision_hash,
         availability_status, availability_evidence, availability_verified_at,
         availability_recheck_at
       ) VALUES ($1, $2, 1, $3, 'Build reliable data products.', NOW(), $4,
         'OPEN', $5::jsonb, '2098-01-01T00:00:00Z', '2099-01-01T00:00:00Z')
       RETURNING id`,
      [
        workspace.workspaceId,
        canonicalJobId,
        jobContentHash,
        evidenceRevisionHash,
        JSON.stringify({ status: "OPEN", verification_method: "TEST_FIXTURE", reason_code: "SOURCE_CONFIRMED", evidence: [] }),
      ],
    );
    const jobVersionId = jobVersion.rows[0]?.id;
    const requirementIdentity = await database.query<{ id: string }>(
      `INSERT INTO requirement_set_identities (
         workspace_id, canonical_job_id, identity_hash, job_content_hash,
         deterministic_extractor_version, quoted_extractor_version,
         quoted_prompt_hash, normalizer_hash, quoted_enabled
       ) VALUES ($1, $2, $3, $4, 'deterministic-test-v1', 'quoted-test-v1',
         'quoted-prompt-test-v1', 'normalizer-test-v1', FALSE)
       RETURNING id`,
      [workspace.workspaceId, canonicalJobId, `identity-${crypto.randomUUID()}`, jobContentHash],
    );
    const requirementSet = await database.query<{ id: string }>(
      `INSERT INTO requirement_sets (
         workspace_id, requirement_identity_id, canonical_job_id, job_version_id,
         revision_number, source_type, created_by_user_id
       ) VALUES ($1, $2, $3, $4, 1, 'EXTRACTED', $5)
       RETURNING id`,
      [workspace.workspaceId, requirementIdentity.rows[0]?.id, canonicalJobId, jobVersionId, workspace.userId],
    );
    const requirementSetId = requirementSet.rows[0]?.id;
    await database.query(
      `UPDATE job_versions SET active_requirement_set_id = $1 WHERE workspace_id = $2 AND id = $3`,
      [requirementSetId, workspace.workspaceId, jobVersionId],
    );
    const matchRun = await database.query<{ id: string }>(
      `INSERT INTO match_runs (
         workspace_id, canonical_job_id, job_version_id, profile_version_id,
         requirement_set_id, job_content_hash, context_fingerprint, status,
         requirement_count, matched_count, completed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'COMPLETED', 1, 1, NOW())
       RETURNING id`,
      [
        workspace.workspaceId,
        canonicalJobId,
        jobVersionId,
        profileVersion.rows[0]?.id,
        requirementSetId,
        jobContentHash,
        `match-context-${crypto.randomUUID()}`,
      ],
    );
    const matchRunId = matchRun.rows[0]?.id;
    await database.query(
      `INSERT INTO gate_decisions (
         workspace_id, canonical_job_id, job_version_id, decision,
         rejection_codes, evidence_quotes, workability_facts
       ) VALUES ($1, $2, $3, 'PASS', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)`,
      [workspace.workspaceId, canonicalJobId, jobVersionId],
    );
    await database.query(
      `UPDATE canonical_jobs
       SET latest_job_version_id = $1, latest_match_run_id = $2
       WHERE workspace_id = $3 AND id = $4`,
      [jobVersionId, matchRunId, workspace.workspaceId, canonicalJobId],
    );
    const policyRevisions = await database.query<{
      config_key: string;
      config_revision_id: string;
    }>(
      `SELECT definition.config_key, active.config_revision_id
       FROM config_active_revisions active
       JOIN config_definitions definition ON definition.id = active.config_definition_id
       WHERE definition.workspace_id = $1
         AND definition.config_key IN ('decision_policy', 'evidence_strength')`,
      [workspace.workspaceId],
    );
    const policySnapshot = await database.query<{ id: string }>(
      `INSERT INTO workspace_policy_snapshots (
         workspace_id, snapshot_hash, decision_policy_config_revision_id,
         evidence_strength_policy_config_revision_id, resolved_snapshot
       ) VALUES ($1, $2, $3, $4, '{}'::jsonb)
       RETURNING id`,
      [
        workspace.workspaceId,
        `policy-${crypto.randomUUID()}`,
        policyRevisions.rows.find((row) => row.config_key === "decision_policy")?.config_revision_id ?? null,
        policyRevisions.rows.find((row) => row.config_key === "evidence_strength")?.config_revision_id ?? null,
      ],
    );
    const policySnapshotId = policySnapshot.rows[0]?.id;
    const availabilityReference = await database.query<{ value: string }>(
      `SELECT 'availability_verification_v1:'
        || to_char(availability_verified_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        || ':'
        || to_char(availability_recheck_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS value
       FROM job_versions WHERE workspace_id = $1 AND id = $2`,
      [workspace.workspaceId, jobVersionId],
    );
    const readinessFingerprint = "f".repeat(64);
    const expiresAt = "2099-01-01T00:00:00.000Z";
    const contextFingerprint = `decision-context-${crypto.randomUUID()}`;
    const readiness = {
      schema_version: "application_readiness_v1",
      status: "READY",
      reason_codes: [],
      checks: [{
        key: "AVAILABILITY",
        status: "MET",
        importance: "MUST",
        reason_code: null,
        rationale: "Fixture availability evidence is current.",
        evidence_keys: [],
        policy_reference: availabilityReference.rows[0]?.value,
        assessed_at: "2098-01-01T00:00:00.000Z",
        expires_at: expiresAt,
      }],
      canonical_job_id: canonicalJobId,
      job_version_id: jobVersionId,
      profile_version_id: profileVersion.rows[0]?.id,
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
       ) VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, 'ELIGIBLE', 'REVIEW',
         $7, $8, NULL, NULL, $9::jsonb, $10, $11)
       RETURNING id`,
      [
        workspace.workspaceId,
        canonicalJobId,
        jobVersionId,
        matchRunId,
        policySnapshotId,
        `decision-hash-${crypto.randomUUID()}`,
        contextFingerprint,
        workspace.userId,
        JSON.stringify(readiness),
        evidenceRevisionHash,
        readinessFingerprint,
      ],
    );
    const deterministicDecisionId = decision.rows[0]?.id;
    await database.query(
      `UPDATE canonical_jobs SET latest_deterministic_decision_id = $1 WHERE workspace_id = $2 AND id = $3`,
      [deterministicDecisionId, workspace.workspaceId, canonicalJobId],
    );
    const currentReadiness = await database.query<{ readiness_status: string; readiness_reason_codes: string[] }>(
      `SELECT readiness_status, readiness_reason_codes
       FROM v_application_readiness_current
       WHERE workspace_id = $1 AND canonical_job_id = $2 AND job_version_id = $3`,
      [workspace.workspaceId, canonicalJobId, jobVersionId],
    );
    expect(currentReadiness.rows[0]?.readiness_status).toBe("READY");
    expect(currentReadiness.rows[0]?.readiness_reason_codes).toEqual([]);
    const application = await database.query<{ id: string }>(
      `INSERT INTO application_records (workspace_id, user_id, canonical_job_id, job_version_id, status)
       VALUES ($1, $2, $3, $4, 'INTENT')
       RETURNING id`,
      [workspace.workspaceId, workspace.userId, canonicalJobId, jobVersionId],
    );
    const applicationRecordId = application.rows[0]?.id;

    const cv = await persistDocumentProvenance({
      applicationRecordId,
      canonicalJobId: canonicalJobId ?? "",
      jobVersionId: jobVersionId ?? "",
      matchRunId,
      profileVersionId: profileVersion.rows[0]?.id,
      deterministicDecisionId,
      contextFingerprint,
      documentType: "CV",
      policyVersion: "documents-test-v1",
      generatorVersion: "cv-test-v1",
      documentTemplatePluginRevisionId: null,
      outputManifest: { docx_path: "test/cv.docx", docx_sha256: "a".repeat(64) },
      claims: [],
    }, database, { context: workspace });
    const letter = await persistDocumentProvenance({
      applicationRecordId,
      canonicalJobId: canonicalJobId ?? "",
      jobVersionId: jobVersionId ?? "",
      matchRunId,
      profileVersionId: profileVersion.rows[0]?.id,
      deterministicDecisionId,
      contextFingerprint,
      documentType: "COVER_LETTER",
      policyVersion: "documents-test-v1",
      generatorVersion: "cover-letter-test-v1",
      documentTemplatePluginRevisionId: null,
      outputManifest: { docx_path: "test/cover-letter.docx", docx_sha256: "b".repeat(64) },
      claims: [],
    }, database, { context: workspace });

    expect(cv.documentRunId).not.toBe(letter.documentRunId);
    const persisted = await database.query<{
      cv_document_run_id: string | null;
      cover_letter_document_run_id: string | null;
    }>(
      `SELECT cv_document_run_id, cover_letter_document_run_id
       FROM application_records WHERE workspace_id = $1 AND id = $2`,
      [workspace.workspaceId, applicationRecordId],
    );
    expect(persisted.rows[0]?.cv_document_run_id).toBe(cv.documentRunId);
    expect(persisted.rows[0]?.cover_letter_document_run_id).toBe(letter.documentRunId);
    const runs = await database.query<{ document_type: string; status: string }>(
      `SELECT document_type, status FROM document_runs
       WHERE workspace_id = $1 AND id = ANY($2::uuid[])
       ORDER BY document_type`,
      [workspace.workspaceId, [cv.documentRunId, letter.documentRunId]],
    );
    expect(runs.rows).toEqual([
      { document_type: "COVER_LETTER", status: "COMPLETED" },
      { document_type: "CV", status: "COMPLETED" },
    ]);

    const expiredVerifiedAt = "2024-12-01T00:00:00.000Z";
    const expiredAt = "2025-01-01T00:00:00.000Z";
    await database.query(
      `UPDATE job_versions
       SET availability_verified_at = $1::timestamptz,
           availability_recheck_at = $2::timestamptz
       WHERE workspace_id = $3 AND id = $4`,
      [expiredVerifiedAt, expiredAt, workspace.workspaceId, jobVersionId],
    );
    const expiredAvailabilityReference = await database.query<{ value: string }>(
      `SELECT 'availability_verification_v1:'
        || to_char(availability_verified_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        || ':'
        || to_char(availability_recheck_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS value
       FROM job_versions WHERE workspace_id = $1 AND id = $2`,
      [workspace.workspaceId, jobVersionId],
    );
    const expiredReadinessFingerprint = "d".repeat(64);
    const expiredReadiness = {
      ...readiness,
      readiness_fingerprint: expiredReadinessFingerprint,
      evaluated_at: "2024-12-31T00:00:00.000Z",
      expires_at: expiredAt,
      checks: [{
        key: "AVAILABILITY",
        status: "MET",
        importance: "MUST",
        reason_code: null,
        rationale: "The source check was current when this assessment was made.",
        evidence_keys: [],
        policy_reference: expiredAvailabilityReference.rows[0]?.value,
        assessed_at: "2024-12-31T00:00:00.000Z",
        expires_at: expiredAt,
      }],
    };
    const expiredDecisionContext = `expired-decision-context-${crypto.randomUUID()}`;
    const expiredDecision = await database.query<{ id: string }>(
      `INSERT INTO deterministic_decisions (
         workspace_id, canonical_job_id, job_version_id, match_run_id,
         policy_snapshot_id, decision_hash, decision_json,
         recommendation_eligibility, recommendation_outcome, context_fingerprint,
         created_by_user_id, preference_user_id, preference_context_id,
         readiness_json, evidence_revision_hash, readiness_fingerprint
       ) VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, 'ELIGIBLE', 'REVIEW',
         $7, $8, NULL, NULL, $9::jsonb, $10, $11)
       RETURNING id`,
      [
        workspace.workspaceId,
        canonicalJobId,
        jobVersionId,
        matchRunId,
        policySnapshotId,
        `expired-decision-hash-${crypto.randomUUID()}`,
        expiredDecisionContext,
        workspace.userId,
        JSON.stringify(expiredReadiness),
        evidenceRevisionHash,
        expiredReadinessFingerprint,
      ],
    );
    await database.query(
      `UPDATE canonical_jobs SET latest_deterministic_decision_id = $1 WHERE workspace_id = $2 AND id = $3`,
      [expiredDecision.rows[0]?.id, workspace.workspaceId, canonicalJobId],
    );
    const expiredView = await database.query<{ readiness_status: string; readiness_reason_codes: string[] }>(
      `SELECT readiness_status, readiness_reason_codes
       FROM v_application_readiness_current
       WHERE workspace_id = $1 AND canonical_job_id = $2 AND job_version_id = $3`,
      [workspace.workspaceId, canonicalJobId, jobVersionId],
    );
    expect(expiredView.rows[0]?.readiness_status).toBe("NEEDS_VERIFICATION");
    expect(expiredView.rows[0]?.readiness_reason_codes).toContain("READINESS_EVIDENCE_EXPIRED");

    const seeded = await seedRecoverablePipelineTasks(database, {
      context: workspace,
      taskTypes: ["DECIDE_RECOMMENDATION"],
      jobVersionIds: [jobVersionId],
      routingDeferredReplayVersion: "availability-expiry-test",
      maxSeedPerType: 10,
    });
    expect(seeded.inserted).toBe(1);
    const refreshTask = await database.query<{ id: string; status: string; payload: Record<string, unknown> }>(
      `SELECT id, status, payload FROM pipeline_tasks
       WHERE workspace_id = $1 AND task_type = 'DECIDE_RECOMMENDATION'
         AND payload->>'canonical_job_id' = $2 AND payload->>'job_version_id' = $3
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [workspace.workspaceId, canonicalJobId, jobVersionId],
    );
    expect(refreshTask.rows[0]?.payload).toMatchObject({
      reprocess_existing_state: true,
      reassessment_reason: "APPLICATION_READINESS_REFRESH",
      deterministic_decision_id: expiredDecision.rows[0]?.id,
    });

    const reconciliation = await reconcileStalePendingPipelineTasks(database, workspace, {
      apply: true,
      taskTypes: ["DECIDE_RECOMMENDATION"],
      jobVersionIds: [jobVersionId],
      limit: 10,
    });
    expect(reconciliation.reconciled).toBe(0);
    expect(reconciliation.byClassification.PROVEN_SATISFIED ?? 0).toBe(0);
    const pendingRefreshTask = await database.query<{ status: string }>(
      `SELECT status FROM pipeline_tasks WHERE id = $1`,
      [refreshTask.rows[0]?.id],
    );
    expect(pendingRefreshTask.rows[0]?.status).toBe("PENDING");
  });
});
