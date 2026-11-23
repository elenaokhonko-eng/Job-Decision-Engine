import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import pg from "pg";

import { classifyContentCompleteness, reportAwaitingContentOutputs } from "../../ingestion/contentCompleteness.js";
import { sourceContentEvidencePredicate } from "../../pipeline/descriptionQuality.js";
import { archiveJobsAsPostingNotConfirmable } from "../../services/jobArchive.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AwaitingContentCountsSchema, AwaitingContentRowSchema } from "../../contracts/jobStatus.js";
import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

// "Awaiting content": a job without a complete description has no gate result, lane or recommendation in any
// list. The rule exists in TypeScript (classifyContentCompleteness, sourceContentEvidencePredicate) and in SQL
// (v_job_content_state, migration 117); this test runs the same synthetic cases through both.
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the awaiting-content integration tests against its PostgreSQL service.");
}

describe("classifyContentCompleteness (pure rule)", () => {
  it("is complete only with a COMPLETE description and no alert-only evidence", () => {
    expect(classifyContentCompleteness({ descriptionQualityStatus: "COMPLETE", hasObservation: true, hasRetrievedPostingEvidence: true }).complete).toBe(true);
    expect(classifyContentCompleteness({ descriptionQualityStatus: "INCOMPLETE", hasObservation: true, hasRetrievedPostingEvidence: true })).toEqual({ complete: false, reason: "DESCRIPTION_NOT_COMPLETE" });
    expect(classifyContentCompleteness({ descriptionQualityStatus: null, hasObservation: false, hasRetrievedPostingEvidence: false })).toEqual({ complete: false, reason: "DESCRIPTION_NOT_COMPLETE" });
    expect(classifyContentCompleteness({ descriptionQualityStatus: "COMPLETE", hasObservation: true, hasRetrievedPostingEvidence: false })).toEqual({ complete: false, reason: "NO_RETRIEVED_POSTING_EVIDENCE" });
  });
});

interface Case {
  readonly name: string;
  readonly quality: "COMPLETE" | "INCOMPLETE" | "UNKNOWN";
  readonly observations: readonly { readonly source: string; readonly contentStatus?: string }[];
  readonly decisions: boolean;
  readonly archived?: boolean;
  /** The job carries a HARD_REJECTED state (it stays in the Rejected bucket, not in awaiting content). */
  readonly hardRejected?: boolean;
  readonly expectAwaiting: boolean;
  readonly expectViolation: boolean;
}

const CASES: readonly Case[] = [
  { name: "complete employer posting", quality: "COMPLETE", observations: [{ source: "GREENHOUSE" }], decisions: true, expectAwaiting: false, expectViolation: false },
  { name: "alert snippet with stale decisions", quality: "INCOMPLETE", observations: [{ source: "GMAIL_ALERT" }], decisions: true, expectAwaiting: true, expectViolation: true },
  { name: "alert snippet without decisions", quality: "INCOMPLETE", observations: [{ source: "GMAIL_ALERT" }], decisions: false, expectAwaiting: true, expectViolation: false },
  { name: "unknown quality with stale decisions", quality: "UNKNOWN", observations: [{ source: "GREENHOUSE" }], decisions: true, expectAwaiting: true, expectViolation: true },
  { name: "complete text but only a bare alert", quality: "COMPLETE", observations: [{ source: "GMAIL_ALERT" }], decisions: true, expectAwaiting: true, expectViolation: true },
  { name: "alert completed by a retrieved posting", quality: "COMPLETE", observations: [{ source: "GMAIL_ALERT", contentStatus: "COMPLETE" }], decisions: true, expectAwaiting: false, expectViolation: false },
  { name: "alert plus a later employer observation", quality: "COMPLETE", observations: [{ source: "GMAIL_ALERT" }, { source: "EMPLOYER_WEBSITE" }], decisions: true, expectAwaiting: false, expectViolation: false },
  { name: "stale hard rejection on a snippet", quality: "INCOMPLETE", observations: [{ source: "GMAIL_ALERT" }], decisions: true, hardRejected: true, expectAwaiting: true, expectViolation: true },
  { name: "archived snippet is not live", quality: "INCOMPLETE", observations: [{ source: "GMAIL_ALERT" }], decisions: true, archived: true, expectAwaiting: true, expectViolation: false },
];

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let context: WorkspaceContext | undefined;
const seeded = new Map<string, { canonicalJobId: string; jobVersionId: string }>();

function db(): pg.PoolClient {
  if (!client) throw new Error("The awaiting-content test client is not initialized.");
  return client;
}

describe.skipIf(skipReal)("awaiting content: read models and reconciliation (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    const schemaName = `awaiting_content_${crypto.randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
    const workspaceId = context.workspaceId;

    for (const testCase of CASES) {
      const canonical = await client.query<{ id: string }>(
        `INSERT INTO canonical_jobs (
           workspace_id, company_name, normalized_title, canonical_url, location_summary, workplace_type, employment_type,
           processing_state, processing_status, gate_decision, primary_lane, recommendation_eligibility, recommendation_outcome,
           description_quality_status
         ) VALUES ($1, 'Awaiting Content Fixture Co', $2, $3, 'Singapore', 'UNKNOWN', 'PERMANENT',
           $4, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          workspaceId, testCase.name, `https://example.test/awaiting/${crypto.randomUUID()}`,
          testCase.hardRejected ? "HARD_REJECTED" : testCase.decisions ? "MATCHED" : "RAW_STAGED",
          testCase.hardRejected ? "HARD_REJECT" : testCase.decisions ? "PASS" : null,
          testCase.decisions ? "CORE_AI_DATA" : null,
          testCase.decisions ? "ELIGIBLE" : null,
          testCase.decisions ? "REVIEW" : null,
          testCase.quality,
        ],
      );
      const canonicalJobId = canonical.rows[0]!.id;
      const version = await client.query<{ id: string }>(
        `INSERT INTO job_versions (
           workspace_id, canonical_job_id, version_number, content_hash, description_text, observed_at,
           evidence_revision_hash, availability_status, availability_evidence, availability_verified_at, availability_recheck_at
         ) VALUES ($1, $2, 1, $3, 'Synthetic awaiting-content fixture posting.', NOW(), $4,
           'OPEN', $5::jsonb, '2098-01-01T00:00:00Z', '2099-01-01T00:00:00Z') RETURNING id`,
        [
          workspaceId, canonicalJobId, `awaiting-${crypto.randomUUID()}`, "e".repeat(64),
          JSON.stringify({ status: "OPEN", verification_method: "TEST_FIXTURE", reason_code: "SOURCE_CONFIRMED", evidence: [] }),
        ],
      );
      const jobVersionId = version.rows[0]!.id;
      for (const [index, observation] of testCase.observations.entries()) {
        await client.query(
          `INSERT INTO raw_job_observations (
             id, workspace_id, source_name, source_external_id, source_url, retrieved_at,
             company_name, title, description_raw, raw_payload, raw_payload_hash, processing_status, job_version_id
           ) VALUES ($1, $2, $3, $4, $5, NOW(), 'Awaiting Content Fixture Co', $6, 'Synthetic.', $7::jsonb, $8, 'PROCESSED', $9)`,
          [
            crypto.randomUUID(), workspaceId, observation.source, `awaiting-${canonicalJobId}-${index}`,
            `https://example.test/awaiting/${canonicalJobId}/${index}`, testCase.name,
            JSON.stringify(observation.contentStatus ? { source_content_status: observation.contentStatus } : {}),
            `raw-${canonicalJobId}-${index}`, jobVersionId,
          ],
        );
      }
      if (testCase.decisions) {
        await client.query(
          `INSERT INTO gate_decisions (workspace_id, canonical_job_id, job_version_id, decision, rejection_codes, evidence_quotes, workability_facts)
           VALUES ($1, $2, $3, $4, $5::jsonb, '[]'::jsonb, '{}'::jsonb)`,
          [workspaceId, canonicalJobId, jobVersionId, testCase.hardRejected ? "HARD_REJECT" : "PASS", JSON.stringify(testCase.hardRejected ? ["SYNTHETIC_CODE"] : [])],
        );
      }
      await client.query(
        `UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE workspace_id = $2 AND id = $3`,
        [jobVersionId, workspaceId, canonicalJobId],
      );
      if (testCase.archived) {
        await archiveJobsAsPostingNotConfirmable(client, {
          workspaceId, canonicalJobIds: [canonicalJobId], actor: "test:awaiting_content", details: { rule: "test" },
        });
      }
      seeded.set(testCase.name, { canonicalJobId, jobVersionId });
    }
  }, 180_000);

  afterAll(async () => {
    client?.release();
    await pool?.end();
  });

  it("v_job_content_state agrees with the TypeScript rule and the hard-gate SQL predicate", async () => {
    const database = db();
    for (const testCase of CASES) {
      const { canonicalJobId, jobVersionId } = seeded.get(testCase.name)!;
      const view = await database.query<{ content_complete: boolean; awaiting_reason: string | null }>(
        `SELECT content_complete, awaiting_reason FROM v_job_content_state WHERE canonical_job_id = $1`,
        [canonicalJobId],
      );
      const facts = await database.query<{ has_observation: boolean; has_evidence: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM raw_job_observations WHERE job_version_id = target.version_id) AS has_observation,
                ${sourceContentEvidencePredicate("target.workspace_id", "target.version_id")} AS has_evidence
           FROM (SELECT $1::uuid AS workspace_id, $2::uuid AS version_id) target`,
        [context!.workspaceId, jobVersionId],
      );
      const expected = classifyContentCompleteness({
        descriptionQualityStatus: testCase.quality,
        hasObservation: facts.rows[0]!.has_observation,
        hasRetrievedPostingEvidence: facts.rows[0]!.has_evidence,
      });
      expect(view.rows[0]?.content_complete, testCase.name).toBe(expected.complete);
      expect(view.rows[0]?.awaiting_reason, testCase.name).toBe(expected.reason);
      expect(!expected.complete, testCase.name).toBe(testCase.expectAwaiting);
    }
  });

  it("keeps awaiting-content jobs out of the shortlist and lists them as waiting", async () => {
    const database = db();
    const shortlist = await database.query<{ canonical_job_id: string }>(
      `SELECT canonical_job_id FROM v_canonical_shortlist_scoped WHERE workspace_id = $1`, [context!.workspaceId]);
    const shown = new Set(shortlist.rows.map((row) => row.canonical_job_id));
    const waiting = await database.query<{ canonical_job_id: string; awaiting_reason: string }>(
      `SELECT canonical_job_id, awaiting_reason FROM v_job_awaiting_content_scoped WHERE workspace_id = $1`, [context!.workspaceId]);
    const waitingIds = new Set(waiting.rows.map((row) => row.canonical_job_id));
    for (const testCase of CASES) {
      const { canonicalJobId } = seeded.get(testCase.name)!;
      if (testCase.archived) {
        expect(shown.has(canonicalJobId), testCase.name).toBe(false);
        expect(waitingIds.has(canonicalJobId), testCase.name).toBe(false);
      } else if (testCase.hardRejected) {
        // A rejection is not a recommendation: it stays in the Rejected list, not in awaiting content.
        expect(shown.has(canonicalJobId), testCase.name).toBe(false);
        expect(waitingIds.has(canonicalJobId), testCase.name).toBe(false);
      } else if (testCase.expectAwaiting) {
        expect(shown.has(canonicalJobId), testCase.name).toBe(false);
        expect(waitingIds.has(canonicalJobId), testCase.name).toBe(true);
      } else {
        expect(shown.has(canonicalJobId), testCase.name).toBe(true);
        expect(waitingIds.has(canonicalJobId), testCase.name).toBe(false);
      }
    }
    // The stored decision is kept: the job returns to the lists when its content is complete.
    const stale = seeded.get("alert snippet with stale decisions")!;
    const stored = await database.query<{ gate_decision: string; recommendation_outcome: string }>(
      `SELECT gate_decision, recommendation_outcome FROM canonical_jobs WHERE id = $1`, [stale.canonicalJobId]);
    expect(stored.rows[0]).toEqual({ gate_decision: "PASS", recommendation_outcome: "REVIEW" });
  });

  it("the status buckets exclude awaiting-content jobs", async () => {
    const database = db();
    const buckets = await database.query<{ canonical_job_id: string }>(
      `SELECT canonical_job_id FROM v_job_status_buckets_scoped WHERE workspace_id = $1`, [context!.workspaceId]);
    const bucketed = new Set(buckets.rows.map((row) => row.canonical_job_id));
    expect(bucketed.has(seeded.get("alert snippet with stale decisions")!.canonicalJobId)).toBe(false);
    expect(bucketed.has(seeded.get("complete employer posting")!.canonicalJobId)).toBe(true);
  });

  it("reconciliation reports exactly the live awaiting-content jobs that carry outputs", async () => {
    const report = await reportAwaitingContentOutputs(db(), context!.workspaceId);
    const expectedViolations = CASES.filter((c) => c.expectViolation).map((c) => seeded.get(c.name)!.canonicalJobId).sort();
    expect(report.violations.map((v) => v.canonicalJobId).sort()).toEqual(expectedViolations);
    expect(report.awaitingContentJobs).toBe(CASES.filter((c) => c.expectAwaiting && !c.archived).length);
    expect(report.byOutput).toEqual({ GATE_DECISION: 4, LANE: 4, RECOMMENDATION: 4 });
    for (const violation of report.violations) expect(violation.outputs).toEqual(["GATE_DECISION", "LANE", "RECOMMENDATION"]);
  });

  it("each live job is in exactly one bucket or in awaiting content, and the counts add up", async () => {
    const database = db();
    const workspaceId = context!.workspaceId;
    const buckets = await database.query<{ canonical_job_id: string; status_bucket: string }>(
      `SELECT canonical_job_id, status_bucket FROM v_job_status_buckets_scoped WHERE workspace_id = $1`, [workspaceId]);
    const waiting = await database.query<{ canonical_job_id: string }>(
      `SELECT canonical_job_id FROM v_job_awaiting_content_scoped WHERE workspace_id = $1`, [workspaceId]);
    const bucketIds = buckets.rows.map((row) => row.canonical_job_id);
    expect(new Set(bucketIds).size).toBe(bucketIds.length);
    const waitingIds = waiting.rows.map((row) => row.canonical_job_id);
    expect(bucketIds.filter((id) => waitingIds.includes(id))).toEqual([]);

    const live = await database.query<{ id: string }>(
      `SELECT id FROM canonical_jobs WHERE workspace_id = $1 AND is_test_fixture = FALSE AND archived_at IS NULL`, [workspaceId]);
    expect([...bucketIds, ...waitingIds].sort()).toEqual(live.rows.map((row) => row.id).sort());

    const hardRejected = seeded.get("stale hard rejection on a snippet")!.canonicalJobId;
    expect(buckets.rows.find((row) => row.canonical_job_id === hardRejected)?.status_bucket).toBe("REJECTED");

    const counts = await database.query(`SELECT * FROM v_job_status_bucket_counts_scoped WHERE workspace_id = $1`, [workspaceId]);
    const waitingCounts = await database.query(`SELECT * FROM v_job_awaiting_content_counts_scoped WHERE workspace_id = $1`, [workspaceId]);
    expect(counts.rows[0].total_jobs + waitingCounts.rows[0].awaiting_count).toBe(live.rows.length);
    expect(AwaitingContentCountsSchema.parse(waitingCounts.rows[0]).awaiting_count).toBe(waitingIds.length);
    const rows = await database.query(`SELECT * FROM v_job_awaiting_content_scoped WHERE workspace_id = $1`, [workspaceId]);
    for (const row of rows.rows) AwaitingContentRowSchema.parse(row);
  });

  it("a stale output is cleared only by archiving the job through the audited archive, which leaves the live report", async () => {
    const database = db();
    const stale = seeded.get("alert snippet with stale decisions")!.canonicalJobId;
    await archiveJobsAsPostingNotConfirmable(database, {
      workspaceId: context!.workspaceId, canonicalJobIds: [stale], actor: "test:awaiting_content", details: { rule: "test" },
    });
    const report = await reportAwaitingContentOutputs(database, context!.workspaceId);
    expect(report.violations.map((v) => v.canonicalJobId)).not.toContain(stale);
  });

  it("the documented rollback restores the 093 shortlist and drops the three views", async () => {
    const database = db();
    const migrations = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../migrations");
    const text = readFileSync(path.join(migrations, "093_reversible_job_archiving.sql"), "utf8").split(String.fromCharCode(13)).join("");
    const start = text.indexOf("CREATE OR REPLACE VIEW v_canonical_shortlist_scoped AS");
    const end = text.indexOf("AND canonical.archived_at IS NULL;", start) + "AND canonical.archived_at IS NULL;".length;
    await database.query(text.slice(start, end));
    await database.query("DROP VIEW IF EXISTS v_job_awaiting_content_counts_scoped");
    await database.query("DROP VIEW IF EXISTS v_job_awaiting_content_scoped");
    await database.query("DROP VIEW IF EXISTS v_job_content_state");
    const views = await database.query(
      `SELECT COUNT(*)::int AS n FROM information_schema.views WHERE table_schema = current_schema() AND table_name IN ('v_job_content_state', 'v_job_awaiting_content_scoped', 'v_job_awaiting_content_counts_scoped')`);
    expect(views.rows[0].n).toBe(0);
    const shortlist = await database.query<{ canonical_job_id: string }>(
      `SELECT canonical_job_id FROM v_canonical_shortlist_scoped WHERE workspace_id = $1`, [context!.workspaceId]);
    // The awaiting-content job (still live) is visible again under the 093 definition.
    expect(shortlist.rows.map((row) => row.canonical_job_id)).toContain(seeded.get("alert snippet without decisions")!.canonicalJobId);
  });
});
