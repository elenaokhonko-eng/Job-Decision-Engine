import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { ManualPersistedFetchReceiptSchema } from "../../contracts/manualApplication.js";
import { isPooledPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { validateManualArtifactPair } from "../../documents/manualPreparation.js";

const testDatabaseUrl = process.env.JDEC_MANUAL_PREPARATION_TEST_DATABASE_URL || "";
if (!testDatabaseUrl) throw new Error("JDEC_MANUAL_PREPARATION_TEST_DATABASE_URL must point to the disposable PostgreSQL CI service.");
if (isPooledPostgresConnectionString(testDatabaseUrl)) throw new Error("Manual preparation PostgreSQL integration requires a direct connection.");

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.resolve(here, "../../../migrations/082_manual_application_preparation.sql");
const migration = fs.readFileSync(migrationPath, "utf8");
const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherWorkspaceId = "abababab-abab-4bab-8bab-abababababab";
const userId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const otherUserId = "bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc";
const jobId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const jobVersionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const otherJobVersionId = "dcdcdcdc-dcdc-4cdc-8cdc-dcdcdcdcdcdc";
const observationId = "dededede-dede-4ede-8ede-dededededede";
const profileId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const candidateId = "e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1";
const otherCandidateId = "e2e2e2e2-e2e2-42e2-82e2-e2e2e2e2e2e2";
const requirementSetId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const contactFactId = "11111111-1111-4111-8111-111111111111";
const fetchReceiptId = "15151515-1515-4515-8515-151515151515";
const fingerprint = "a".repeat(64);
const contactFingerprint = "b".repeat(64);
const preferenceFingerprint = "c".repeat(64);
const contextFingerprint = "d".repeat(64);
const descriptionHash = "e".repeat(64);

describe("manual application preparation PostgreSQL integration", () => {
  let client: pg.Client;
  let schema: string;
  let draftId: string;
  let approvalId: string;
  let cvRunId: string;
  let letterRunId: string;

  async function expectConstraintFailure(sql: string, values: unknown[]): Promise<void> {
    await client.query("BEGIN");
    await expect(client.query(sql, values)).rejects.toThrow();
    await client.query("ROLLBACK");
  }

  beforeAll(async () => {
    client = new pg.Client(pgConnectionConfig(testDatabaseUrl));
    await client.connect();
    schema = `manual_prepare_it_${process.pid}_${crypto.randomBytes(4).toString("hex")}`;
    if (!/^manual_prepare_it_[a-z0-9_]+$/.test(schema)) throw new Error("Unsafe integration schema identifier.");
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}", public`);
    await client.query(`
      CREATE TABLE workspaces (id UUID PRIMARY KEY);
      CREATE TABLE workspace_users (id UUID PRIMARY KEY);
      CREATE TABLE workspace_memberships (
        workspace_id UUID NOT NULL, user_id UUID NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE',
        UNIQUE (workspace_id, user_id)
      );
      CREATE TABLE candidate_profiles (
        workspace_id UUID NOT NULL, id UUID NOT NULL, PRIMARY KEY (workspace_id, id)
      );
      CREATE TABLE canonical_jobs (
        workspace_id UUID NOT NULL, id UUID NOT NULL, latest_job_version_id UUID,
        PRIMARY KEY (workspace_id, id)
      );
      CREATE TABLE job_versions (
        workspace_id UUID NOT NULL, canonical_job_id UUID NOT NULL, id UUID NOT NULL,
        observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), content_hash TEXT NOT NULL,
        PRIMARY KEY (workspace_id, canonical_job_id, id)
      );
      CREATE TABLE raw_job_observations (
        workspace_id UUID NOT NULL, id UUID NOT NULL, job_version_id UUID,
        PRIMARY KEY (workspace_id, id)
      );
      CREATE TABLE profile_versions (
        workspace_id UUID NOT NULL, candidate_profile_id UUID NOT NULL, id UUID NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, candidate_profile_id, id)
      );
      CREATE TABLE profile_facts (
        workspace_id UUID NOT NULL, profile_version_id UUID NOT NULL, id UUID NOT NULL,
        fact_type TEXT NOT NULL DEFAULT 'CONTACT', fact_key TEXT NOT NULL DEFAULT 'contact_phone',
        structured_value JSONB NOT NULL DEFAULT '{}'::jsonb, verification_status TEXT NOT NULL DEFAULT 'SELF_ATTESTED',
        confidentiality TEXT NOT NULL DEFAULT 'PRIVATE_INTERNAL', is_current BOOLEAN NOT NULL DEFAULT TRUE,
        statement TEXT NOT NULL DEFAULT 'Phone contact fact', PRIMARY KEY (workspace_id, profile_version_id, id)
      );
      CREATE TABLE profile_credentials (
        workspace_id UUID NOT NULL, profile_version_id UUID NOT NULL, id UUID NOT NULL,
        PRIMARY KEY (workspace_id, profile_version_id, id)
      );
      CREATE TABLE profile_engagements (
        workspace_id UUID NOT NULL, profile_version_id UUID NOT NULL, id UUID NOT NULL,
        PRIMARY KEY (workspace_id, profile_version_id, id)
      );
      CREATE TABLE requirement_sets (
        workspace_id UUID NOT NULL, canonical_job_id UUID NOT NULL, job_version_id UUID NOT NULL, id UUID NOT NULL,
        PRIMARY KEY (workspace_id, canonical_job_id, job_version_id, id)
      );
      CREATE TABLE job_requirements (
        workspace_id UUID NOT NULL, canonical_job_id UUID NOT NULL, job_version_id UUID NOT NULL,
        requirement_set_id UUID NOT NULL, id UUID NOT NULL,
        PRIMARY KEY (workspace_id, canonical_job_id, job_version_id, requirement_set_id, id)
      );
    `);
    await client.query(migration);
    await client.query(migration); // The additive migration must safely replay.

    await client.query("INSERT INTO workspaces (id) VALUES ($1),($2)", [workspaceId, otherWorkspaceId]);
    await client.query("INSERT INTO workspace_users (id) VALUES ($1),($2)", [userId, otherUserId]);
    await client.query("INSERT INTO workspace_memberships (workspace_id,user_id,role) VALUES ($1,$2,'OWNER'),($3,$4,'OWNER')",
      [workspaceId, userId, otherWorkspaceId, otherUserId]);
    await client.query(
      `INSERT INTO manual_application_fetch_receipts (
        id,workspace_id,user_id,requested_url,resolved_url,canonical_url,expected_title,expected_company,
        expected_requisition_id,description_hash,content_hash,provider,source_evidence
       ) VALUES ($1,$2,$3,'https://careers.example.test/role','https://careers.example.test/role',
        'https://careers.example.test/role','Data Architect','Example',NULL,$4,$5,'EMPLOYER_WEBSITE',$6::jsonb)`,
      [fetchReceiptId, workspaceId, userId, "9".repeat(64), "8".repeat(64), JSON.stringify({
        requestedUrl: "https://careers.example.test/role",
        resolvedUrl: "https://careers.example.test/role",
        redirectHistory: [],
        retrievedAt: "2026-10-28T00:00:00.000Z",
        httpStatus: 200,
        contentType: "text/html",
        responseHash: "7".repeat(64),
      })],
    );
    await client.query("INSERT INTO candidate_profiles (workspace_id,id) VALUES ($1,$2),($1,$3)", [workspaceId, candidateId, otherCandidateId]);
    await client.query("INSERT INTO canonical_jobs (workspace_id,id,latest_job_version_id) VALUES ($1,$2,$3)", [workspaceId, jobId, jobVersionId]);
    await client.query("INSERT INTO job_versions (workspace_id,canonical_job_id,id,content_hash) VALUES ($1,$2,$3,$4),($1,$2,$5,$6)",
      [workspaceId, jobId, jobVersionId, descriptionHash, otherJobVersionId, "f".repeat(64)]);
    await client.query("INSERT INTO raw_job_observations (workspace_id,id,job_version_id) VALUES ($1,$2,$3),($1,$4,$5)",
      [workspaceId, observationId, jobVersionId, "12121212-1212-4212-8212-121212121212", otherJobVersionId]);
    await client.query("INSERT INTO profile_versions (workspace_id,candidate_profile_id,id) VALUES ($1,$2,$3),($1,$4,$5)",
      [workspaceId, candidateId, profileId, otherCandidateId, "13131313-1313-4313-8313-131313131313"]);
    await client.query("INSERT INTO profile_facts (workspace_id,profile_version_id,id) VALUES ($1,$2,$3)", [workspaceId, profileId, contactFactId]);
    await client.query("INSERT INTO requirement_sets (workspace_id,canonical_job_id,job_version_id,id) VALUES ($1,$2,$3,$4)",
      [workspaceId, jobId, jobVersionId, requirementSetId]);
    await client.query("INSERT INTO job_requirements (workspace_id,canonical_job_id,job_version_id,requirement_set_id,id) VALUES ($1,$2,$3,$4,$5)",
      [workspaceId, jobId, jobVersionId, requirementSetId, "14141414-1414-4414-8414-141414141414"]);

    const draft = await client.query<{ id: string }>(
      `INSERT INTO manual_application_drafts (
        workspace_id,user_id,candidate_profile_id,canonical_job_id,job_version_id,source_observation_id,job_content_hash,
        profile_version_id,profile_contact_fact_ids,profile_contact_fingerprint,preference_context_fingerprint,
        requirement_set_id,comparator_version,context_fingerprint,comparison_fingerprint,comparison_payload,suitability_warnings
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::uuid[],$10,$11,$12,'literal-overlap-v1',$13,$14,'{"kind":"manual-comparison"}'::jsonb,'["NEEDS_VERIFICATION"]'::jsonb)
      RETURNING id`,
      [workspaceId, userId, candidateId, jobId, jobVersionId, observationId, descriptionHash, profileId,
        [contactFactId], contactFingerprint, preferenceFingerprint, requirementSetId, contextFingerprint, fingerprint],
    );
    draftId = draft.rows[0].id;
    await client.query(
      `INSERT INTO manual_application_draft_contact_facts (workspace_id,user_id,draft_id,profile_version_id,profile_contact_fact_id)
       VALUES ($1,$2,$3,$4,$5)`, [workspaceId, userId, draftId, profileId, contactFactId]);

    const approval = await client.query<{ id: string }>(
      `INSERT INTO manual_application_preparation_approvals (
        workspace_id,user_id,draft_id,candidate_profile_id,canonical_job_id,job_version_id,source_observation_id,
        job_content_hash,profile_version_id,profile_contact_fact_ids,profile_contact_fingerprint,
        preference_context_fingerprint,requirement_set_id,comparator_version,context_fingerprint,comparison_fingerprint,approved
       ) SELECT workspace_id,user_id,id,candidate_profile_id,canonical_job_id,job_version_id,source_observation_id,
         job_content_hash,profile_version_id,profile_contact_fact_ids,profile_contact_fingerprint,
         preference_context_fingerprint,requirement_set_id,comparator_version,context_fingerprint,comparison_fingerprint,TRUE
         FROM manual_application_drafts WHERE id=$1 RETURNING id`, [draftId]);
    approvalId = approval.rows[0].id;
    await client.query(
      `INSERT INTO manual_application_approval_contact_facts (workspace_id,user_id,approval_id,draft_id,profile_version_id,profile_contact_fact_id)
       SELECT workspace_id,user_id,$1,draft_id,profile_version_id,profile_contact_fact_id
       FROM manual_application_draft_contact_facts WHERE draft_id=$2`, [approvalId, draftId]);

    const insertRun = async (type: "CV" | "COVER_LETTER"): Promise<string> => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO manual_application_document_runs (
          workspace_id,user_id,approval_id,canonical_job_id,job_version_id,source_observation_id,job_content_hash,
          candidate_profile_id,profile_version_id,profile_contact_fact_ids,profile_contact_fingerprint,
          preference_context_fingerprint,requirement_set_id,comparator_version,context_fingerprint,comparison_fingerprint,
          document_type,status,generator_version,output_manifest
         ) SELECT workspace_id,user_id,id,canonical_job_id,job_version_id,source_observation_id,job_content_hash,
           candidate_profile_id,profile_version_id,profile_contact_fact_ids,profile_contact_fingerprint,
           preference_context_fingerprint,requirement_set_id,comparator_version,context_fingerprint,comparison_fingerprint,
           $2,'COMPLETED','manual_test','{"automatic_readiness_mutated":false}'::jsonb
           FROM manual_application_preparation_approvals WHERE id=$1 RETURNING id`, [approvalId, type]);
      return result.rows[0].id;
    };
    cvRunId = await insertRun("CV");
    letterRunId = await insertRun("COVER_LETTER");
  }, 120_000);

  afterAll(async () => {
    if (!client) return;
    if (schema) await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  });

  it("applies and replays the migration, persists exact approval/context, and retains only private artifacts", async () => {
    const receipt = await client.query(
      `SELECT id,workspace_id,user_id,requested_url,resolved_url,canonical_url,expected_title,expected_company,
        expected_requisition_id,description_hash,content_hash,provider,source_evidence,
        to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at
       FROM manual_application_fetch_receipts WHERE workspace_id=$1 AND user_id=$2 AND id=$3 AND expires_at > NOW()`,
      [workspaceId, userId, fetchReceiptId]);
    expect(receipt.rows).toHaveLength(1);
    expect(ManualPersistedFetchReceiptSchema.parse(receipt.rows[0]).source_evidence.responseHash).toBe("7".repeat(64));
    const crossWorkspaceReceipt = await client.query(
      `SELECT id FROM manual_application_fetch_receipts WHERE id=$1 AND workspace_id=$2 AND user_id=$3`,
      [fetchReceiptId, workspaceId, otherUserId]);
    expect(crossWorkspaceReceipt.rowCount).toBe(0);
    const approval = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM manual_application_preparation_approvals WHERE workspace_id=$1 AND id=$2 AND approved IS TRUE",
      [workspaceId, approvalId]);
    expect(approval.rows[0].count).toBe("1");
    const contactLinks = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM manual_application_approval_contact_facts WHERE workspace_id=$1 AND approval_id=$2",
      [workspaceId, approvalId]);
    expect(contactLinks.rows[0].count).toBe("1");

    const artifacts = [
      { type: "CV" as const, format: "DOCX" as const, run: cvRunId, bytes: Buffer.from("PK\\u0003\\u0004 test docx") },
      { type: "CV" as const, format: "PDF" as const, run: cvRunId, bytes: Buffer.from("%PDF-1.4\\nprivate cv\\n%%EOF") },
      { type: "COVER_LETTER" as const, format: "DOCX" as const, run: letterRunId, bytes: Buffer.from("PK\\u0003\\u0004 test letter") },
      { type: "COVER_LETTER" as const, format: "PDF" as const, run: letterRunId, bytes: Buffer.from("%PDF-1.4\\nprivate letter\\n%%EOF") },
    ];
    for (const artifact of artifacts) {
      const mime = artifact.format === "PDF" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      await client.query(
        `INSERT INTO manual_application_document_artifacts (
          workspace_id,user_id,approval_id,document_run_id,document_type,format,filename,mime_type,content,sha256
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [workspaceId, userId, approvalId, artifact.run, artifact.type, artifact.format,
          `${artifact.type}-${artifact.format}.${artifact.format.toLowerCase()}`, mime, artifact.bytes,
          crypto.createHash("sha256").update(artifact.bytes).digest("hex")],
      );
    }
    const rows = await client.query<{ document_type: "CV" | "COVER_LETTER"; format: "DOCX" | "PDF"; document_run_id: string; sha256: string; content: Buffer }>(
      `SELECT document_type,format,document_run_id,sha256,content FROM manual_application_document_artifacts
       WHERE workspace_id=$1 AND user_id=$2 AND approval_id=$3`, [workspaceId, userId, approvalId]);
    validateManualArtifactPair(rows.rows);
    expect(rows.rows).toHaveLength(4);
    for (const row of rows.rows) expect(crypto.createHash("sha256").update(row.content).digest("hex")).toBe(row.sha256);

    const automaticTables = await client.query<{ name: string | null }>(
      "SELECT to_regclass($1)::text AS name", [`${schema}.document_runs`]);
    expect(automaticTables.rows[0].name).toBeNull();
  });

  it("keeps an exact comparison retry idempotent for the same workspace, user, fingerprint, and contact facts", async () => {
    const duplicate = await client.query<{ id: string }>(
      `INSERT INTO manual_application_drafts (
        workspace_id,user_id,candidate_profile_id,canonical_job_id,job_version_id,source_observation_id,job_content_hash,
        profile_version_id,profile_contact_fact_ids,profile_contact_fingerprint,preference_context_fingerprint,
        requirement_set_id,comparator_version,context_fingerprint,comparison_fingerprint,comparison_payload,suitability_warnings
       ) SELECT workspace_id,user_id,candidate_profile_id,canonical_job_id,job_version_id,source_observation_id,job_content_hash,
         profile_version_id,profile_contact_fact_ids,profile_contact_fingerprint,preference_context_fingerprint,
         requirement_set_id,comparator_version,context_fingerprint,comparison_fingerprint,comparison_payload,suitability_warnings
         FROM manual_application_drafts WHERE id=$1
       ON CONFLICT (workspace_id,user_id,comparison_fingerprint,profile_contact_fact_ids) DO NOTHING
       RETURNING id`,
      [draftId],
    );
    expect(duplicate.rows).toHaveLength(0);
    const count = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM manual_application_drafts
       WHERE workspace_id=$1 AND user_id=$2 AND comparison_fingerprint=$3 AND profile_contact_fact_ids=$4::uuid[]`,
      [workspaceId, userId, fingerprint, [contactFactId]],
    );
    expect(count.rows[0].count).toBe("1");
  });

  it("rejects cross-workspace, wrong job/source/profile, altered approval, and mismatched document-pair relationships", async () => {
    await expectConstraintFailure(
      `INSERT INTO manual_application_fetch_receipts (
        workspace_id,user_id,requested_url,resolved_url,canonical_url,expected_title,expected_company,
        description_hash,content_hash,provider,source_evidence
       ) VALUES ($1,$2,'https://careers.example.test/role','https://careers.example.test/role',
        'https://careers.example.test/role','Data Architect','Example',$3,$4,'EMPLOYER_WEBSITE','{}'::jsonb)`,
      [workspaceId, otherUserId, "6".repeat(64), "5".repeat(64)],
    );
    await expectConstraintFailure(
      `INSERT INTO manual_application_drafts (
        workspace_id,user_id,candidate_profile_id,canonical_job_id,job_version_id,source_observation_id,job_content_hash,
        profile_version_id,profile_contact_fact_ids,profile_contact_fingerprint,preference_context_fingerprint,
        requirement_set_id,comparator_version,context_fingerprint,comparison_fingerprint,comparison_payload
       ) SELECT $1,$2,candidate_profile_id,canonical_job_id,job_version_id,source_observation_id,job_content_hash,
         profile_version_id,profile_contact_fact_ids,profile_contact_fingerprint,preference_context_fingerprint,
         requirement_set_id,comparator_version,context_fingerprint,$3,comparison_payload
         FROM manual_application_drafts WHERE id=$4`,
      [otherWorkspaceId, otherUserId, "1".repeat(64), draftId],
    );
    await expectConstraintFailure(
      `INSERT INTO manual_application_drafts (
        workspace_id,user_id,candidate_profile_id,canonical_job_id,job_version_id,source_observation_id,job_content_hash,
        profile_version_id,profile_contact_fact_ids,profile_contact_fingerprint,preference_context_fingerprint,
        requirement_set_id,comparator_version,context_fingerprint,comparison_fingerprint,comparison_payload
       ) SELECT workspace_id,user_id,$2,canonical_job_id,job_version_id,source_observation_id,job_content_hash,
         profile_version_id,profile_contact_fact_ids,profile_contact_fingerprint,preference_context_fingerprint,
         requirement_set_id,comparator_version,context_fingerprint,$3,comparison_payload
         FROM manual_application_drafts WHERE id=$1`,
      [draftId, otherCandidateId, "2".repeat(64)],
    );
    await expectConstraintFailure(
      `INSERT INTO manual_application_preparation_approvals (
        workspace_id,user_id,draft_id,candidate_profile_id,canonical_job_id,job_version_id,source_observation_id,
        job_content_hash,profile_version_id,profile_contact_fact_ids,profile_contact_fingerprint,
        preference_context_fingerprint,requirement_set_id,comparator_version,context_fingerprint,comparison_fingerprint,approved
       ) SELECT workspace_id,user_id,id,candidate_profile_id,canonical_job_id,job_version_id,source_observation_id,
         job_content_hash,profile_version_id,profile_contact_fact_ids,profile_contact_fingerprint,
         preference_context_fingerprint,requirement_set_id,comparator_version,context_fingerprint,$2,TRUE
         FROM manual_application_drafts WHERE id=$1`,
      [draftId, "3".repeat(64)],
    );
    await expectConstraintFailure(
      `INSERT INTO manual_application_document_artifacts (
        workspace_id,user_id,approval_id,document_run_id,document_type,format,filename,mime_type,content,sha256
       ) VALUES ($1,$2,$3,$4,'COVER_LETTER','DOCX','cross.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',$5,$6)`,
      [workspaceId, userId, approvalId, cvRunId, Buffer.from("PK test"), "4".repeat(64)],
    );
  });
});
