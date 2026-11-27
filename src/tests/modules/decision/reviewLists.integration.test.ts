import crypto from "node:crypto";
import fs from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadLeadDefinitionSql, REVIEW_LIST_RULES } from "../../../app/reviewLists.js";
import { runMigrations } from "../../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../../db/pgSsl.js";
import { buildReviewListsFromStore, parseRankingDesign, type ReviewListResult } from "../../../modules/decision/index.js";
import { withReadOnlySession } from "../../../platform/persistence/index.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../../workspace/context.js";
import { createProfile, createReadyJob } from "../../fixtures/readyJobFixture.js";

// The review lists against the real read models (v_job_lead_state, v_job_content_state, v_job_availability_current).
// Real PostgreSQL, private schema, invented data only.
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the review list integration tests against its PostgreSQL service.");
}

const raw = JSON.parse(fs.readFileSync("fixtures/ranking_design.example.json", "utf8"));
raw.employer_override.approved = true;
const design = parseRankingDesign(JSON.stringify(raw));

let admin: pg.Pool | undefined;
let pool: pg.Pool;
let workspace: WorkspaceContext;
let profileVersionId: string;
const schema = `review_lists_${crypto.randomUUID().replaceAll("-", "")}`;
const ids: Record<string, string> = {};

interface Seed {
  readonly company: string;
  readonly title: string;
  readonly similarity?: number | null;
  readonly description?: string;
}

async function seed(name: string, spec: Seed): Promise<string> {
  const job = await createReadyJob(pool, workspace, profileVersionId, { laneConfidence: "HIGH", matchScore: 50, withEvaluation: false });
  const ws = workspace.workspaceId;
  await pool.query(
    "UPDATE canonical_jobs SET company_name = $3, normalized_title = $4 WHERE workspace_id = $1 AND id = $2",
    [ws, job.canonicalJobId, spec.company, spec.title],
  );
  if (spec.description) {
    await pool.query("UPDATE job_versions SET description_text = $3 WHERE workspace_id = $1 AND id = $2", [ws, job.jobVersionId, spec.description]);
  }
  const requirement = await pool.query<{ id: string }>(
    `INSERT INTO job_requirements (workspace_id, canonical_job_id, job_version_id, requirement_set_id, requirement_key,
       requirement_type, importance, requirement_text, extractor_type, extractor_version, confidence, status)
     SELECT $1, $2, $3, active_requirement_set_id, 'function-1', 'FUNCTION', 'MUST', 'Invented duty',
       'DETERMINISTIC', 'deterministic-test-v1', 1, 'VALIDATED' FROM job_versions WHERE id = $3
     RETURNING id`,
    [ws, job.canonicalJobId, job.jobVersionId],
  );
  await pool.query(
    `INSERT INTO requirement_evidence_matches (workspace_id, match_run_id, requirement_id, match_type, match_score, rationale, evidence)
     VALUES ($1, $2, $3, 'SEMANTIC', 0.5, 'fixture', $4::jsonb)`,
    [ws, job.matchRunId, requirement.rows[0]!.id, JSON.stringify({ semantic_score: spec.similarity === undefined ? 0.5 : spec.similarity })],
  );
  ids[name] = job.canonicalJobId;
  return job.canonicalJobId;
}

async function observe(name: string, source: string, url: string): Promise<void> {
  await pool.query(
    `INSERT INTO raw_job_observations (workspace_id, source_name, source_external_id, source_url, company_name, title,
       description_raw, raw_payload, raw_payload_hash, job_version_id)
     SELECT workspace_id, $3, $4, $5, company_name, normalized_title, 'Invented.',
       '{"source_content_status":"COMPLETE"}'::jsonb, $4, latest_job_version_id
       FROM canonical_jobs WHERE workspace_id = $1 AND id = $2`,
    [workspace.workspaceId, ids[name], source, crypto.randomUUID(), url],
  );
}

/** Replaces the job's only sighting and link (the fixture's employer-board one). */
async function onlySeenOn(name: string, source: string, url: string): Promise<void> {
  await pool.query(
    `UPDATE raw_job_observations SET source_name = $3, source_url = $4
      WHERE workspace_id = $1 AND job_version_id = (SELECT latest_job_version_id FROM canonical_jobs WHERE id = $2)`,
    [workspace.workspaceId, ids[name], source, url],
  );
  await pool.query("UPDATE canonical_jobs SET canonical_url = $2 WHERE id = $1", [ids[name], url]);
}

const run = (ratedIds: string[] = []): Promise<ReviewListResult> =>
  withReadOnlySession(
    { ...pgConnectionConfig(databaseUrl), options: `-c search_path=${schema},public` },
    () => undefined,
    (db) => buildReviewListsFromStore(db, {
      workspaceId: workspace.workspaceId, design, companyTags: [], ratedIds, rules: REVIEW_LIST_RULES,
      leadDefinitionSql: loadLeadDefinitionSql(),
    }),
  );

describe.skipIf(skipReal)("review lists on the read models", () => {
  beforeAll(async () => {
    admin = new pg.Pool(pgConnectionConfig(databaseUrl));
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...pgConnectionConfig(databaseUrl), options: `-c search_path=${schema},public` });
    const client = await pool.connect();
    try {
      await runMigrations(client);
      workspace = await resolveWorkspaceContext(client);
    } finally {
      client.release();
    }
    profileVersionId = await createProfile(pool, workspace);

    await seed("best", { company: "Example Orchard", title: "software engineer", similarity: 0.9 });
    await seed("second", { company: "Example Plain Co", title: "software developer", similarity: 0.8 });
    await seed("noScore", { company: "Example Plain Co", title: "backend developer", similarity: null });
    await seed("saved", { company: "Example Saved Co", title: "software engineer" });
    await observe("saved", "LINKEDIN_SAVED", "https://www.linkedin.com/jobs/view/4900000001");
    await seed("linkedIn", { company: "Example Linked Co", title: "software engineer" });
    await onlySeenOn("linkedIn", "GMAIL_ALERT", "https://www.linkedin.com/jobs/view/4900000002");
    await seed("lead", { company: "Example Board Co", title: "software engineer", similarity: 1 });
    await onlySeenOn("lead", "HIMALAYAS", "https://himalayas.app/companies/x/jobs/y");
    await seed("closed", { company: "Example Closed Co", title: "software engineer" });
    await pool.query(
      `UPDATE job_versions SET availability_status = 'CLOSED' WHERE id = (SELECT latest_job_version_id FROM canonical_jobs WHERE id = $1)`,
      [ids.closed],
    );
    await seed("gated", { company: "Example Gated Co", title: "software engineer" });
    await pool.query("UPDATE canonical_jobs SET gate_decision = 'NEEDS_VERIFICATION' WHERE id = $1", [ids.gated]);
    await seed("incomplete", { company: "Example Short Co", title: "software engineer" });
    await pool.query("UPDATE canonical_jobs SET description_quality_status = 'INCOMPLETE' WHERE id = $1", [ids.incomplete]);
    await seed("fixture", { company: "Example Fixture Co", title: "software engineer" });
    await pool.query("UPDATE canonical_jobs SET is_test_fixture = TRUE WHERE id = $1", [ids.fixture]);
    await seed("never", { company: "Example Sparkler", title: "software engineer" });
    // The same posting twice: a legal suffix and a way of writing the location apart. One record was rated.
    await seed("rated", { company: "Example Twice Pte Ltd", title: "data engineer" });
    await seed("ratedAgain", { company: "Example Twice", title: "data engineer" });
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  it("lists only live, gate-passed, complete, open-or-unknown, non-lead, unrated postings", async () => {
    const result = await run([ids.rated!]);
    const software = result.lists.byType.find((list) => list.type.key === "SOFTWARE")!;
    expect(software.jobs.map((job) => job.id).sort())
      .toEqual(["best", "second", "noScore", "saved", "linkedIn"].map((name) => ids[name]).sort());
    // Preferred sector first, then top-K from the stored similarity, then no score.
    expect(software.jobs.slice(0, 2).map((job) => job.id)).toEqual([ids.best, ids.second]);
    expect(software.jobs.at(-1)!.id).toBe(ids.noScore);
    expect(software.jobs[0]!.topK).toBeCloseTo(90, 4);
    expect(software.jobs.at(-1)!.topK).toBeNull();

    const byId = new Map(software.jobs.map((job) => [job.id, job]));
    expect(byId.get(ids.saved!)).toMatchObject({ saved: true, linkedInOnly: false });
    expect(byId.get(ids.linkedIn!)).toMatchObject({ saved: false, linkedInOnly: true });
    expect(result.lists.overall.map((job) => job.id)).not.toContain(ids.saved);

    expect(result.excluded).toMatchObject({ LEAD: 1, KNOWN_CLOSED: 1, NOT_GATE_PASSED: 1, AWAITING_CONTENT: 1 });
    expect(result.dropped).toMatchObject({ rated: 2, neverSector: 1 });
    expect(result.lists.byType.find((list) => list.type.key === "DATA")!.jobs).toEqual([]);
  });

  it("collapses the two records of one posting when neither was rated", async () => {
    const result = await run();
    expect(result.lists.byType.find((list) => list.type.key === "DATA")!.jobs).toHaveLength(1);
    expect(result.dropped.duplicate).toBe(1);
  });

  it("changes nothing: the session is read only", async () => {
    await expect(withReadOnlySession(
      { ...pgConnectionConfig(databaseUrl), options: `-c search_path=${schema},public` },
      () => undefined,
      (db) => db.query("UPDATE canonical_jobs SET updated_at = NOW()"),
    )).rejects.toThrow(/read-only/);
  });

  it("leaves the same leads out when migration 123 is not installed", async () => {
    const withView = await run();
    expect(withView.leads).toEqual({ total: 1, source: "READ_MODEL" });
    // The views are dropped inside a transaction that is rolled back: a database that never had the migration.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Only this schema: another schema of the test database may hold the views.
      await client.query(`SET LOCAL search_path TO ${schema}`);
      await client.query("DROP VIEW v_job_lead_state CASCADE");
      await client.query("DROP VIEW v_job_lead_rules");
      const without = await buildReviewListsFromStore(client, {
        workspaceId: workspace.workspaceId, design, companyTags: [], ratedIds: [], rules: REVIEW_LIST_RULES,
        leadDefinitionSql: loadLeadDefinitionSql(),
      });
      expect(without.leads).toEqual({ total: 1, source: "MIGRATION_TEXT" });
      expect(without.excluded.LEAD).toBe(1);
      expect(without.postings.map((job) => job.id)).not.toContain(ids.lead);
      expect(without.postings.map((job) => job.id).sort()).toEqual(withView.postings.map((job) => job.id).sort());
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("refuses when the lead definition cannot be read", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Only this schema: another schema of the test database may hold the views.
      await client.query(`SET LOCAL search_path TO ${schema}`);
      await client.query("DROP VIEW v_job_lead_state CASCADE");
      await expect(buildReviewListsFromStore(client, {
        workspaceId: workspace.workspaceId, design, companyTags: [], ratedIds: [], rules: REVIEW_LIST_RULES,
        leadDefinitionSql: "-- no views here",
      })).rejects.toThrow(/was not found/);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
