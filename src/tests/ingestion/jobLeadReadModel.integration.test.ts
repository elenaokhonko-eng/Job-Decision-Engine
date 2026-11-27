import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SourceNameSchema } from "../../contracts/index.js";
import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { AGGREGATOR_HOSTS } from "../../ingestion/aggregatorHosts.js";
import { createApiV2Router } from "../../api/v2/router.js";
import { preflightApplicationDocumentDraft } from "../../documents/applicationDocumentPreflight.js";
import { validatePersistedDocumentCurrentness } from "../../documents/provenanceCurrentness.js";
import { isLeadJobVersion, JOB_IS_LEAD_MESSAGE, JOB_IS_LEAD_REASON, listLeadJobIds } from "../../modules/catalog/index.js";
import { materializeApplicationRankings } from "../../services/applicationRankingMaterializer.js";
import { describeZeroCheck, LEAD_FREE_MEMBERSHIPS, leadsInListsOrQueue, runZeroChecks } from "../../tasks/integrityZeroChecks.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";
import { createProfile, createReadyJob, type JobIds } from "../fixtures/readyJobFixture.js";

// Migration 123: job-board and aggregator jobs are stored as leads and leave every ranked list. v_job_lead_state is
// the one definition. Real PostgreSQL, private schema, synthetic data only.
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the job lead read model tests against its PostgreSQL service.");
}

interface Sighting {
  readonly source: string;
  readonly url: string;
  /** Index of the sighting this one was derived from. */
  readonly derivedFrom?: number;
  /** Stored but linked to no job version (an alert whose posting was fetched into a derived observation). */
  readonly unversioned?: boolean;
  /** Stored on an older version of the job. */
  readonly olderVersion?: boolean;
}

interface Case {
  readonly name: string;
  readonly canonicalUrl?: string;
  readonly sightings: readonly Sighting[];
  readonly lead: "JOB_BOARD" | "AGGREGATOR" | null;
}

const BOARD = { source: "HIMALAYAS", url: "https://himalayas.app/companies/x/jobs/y" };
const EMPLOYER_URL = "https://careers.example.com/jobs/1";
const INDEED = "https://sg.indeed.com/viewjob?jk=abc";
const LINKEDIN = "https://www.linkedin.com/jobs/view/4900000001";
const MCF = "https://www.mycareersfuture.gov.sg/job/a/b";

const CASES: readonly Case[] = [
  // Job boards.
  { name: "himalayas only", sightings: [BOARD], lead: "JOB_BOARD" },
  { name: "jobicy only", sightings: [{ source: "JOBICY", url: "https://jobicy.com/jobs/1" }], lead: "JOB_BOARD" },
  { name: "remotive only", sightings: [{ source: "REMOTIVE", url: "https://remotive.com/remote-jobs/1" }], lead: "JOB_BOARD" },
  { name: "we work remotely only", sightings: [{ source: "WE_WORK_REMOTELY", url: "https://weworkremotely.com/remote-jobs/1" }], lead: "JOB_BOARD" },
  { name: "hacker news only", sightings: [{ source: "HACKER_NEWS", url: "https://news.ycombinator.com/item?id=1" }], lead: "JOB_BOARD" },
  { name: "hacker news comment linking the employer page", canonicalUrl: EMPLOYER_URL, sightings: [{ source: "HACKER_NEWS", url: EMPLOYER_URL }], lead: "JOB_BOARD" },
  { name: "board canonical link without any observation", canonicalUrl: "https://jobicy.com/jobs/2", sightings: [], lead: "JOB_BOARD" },
  // Aggregators.
  { name: "indeed subdomain alert", sightings: [{ source: "GMAIL_ALERT", url: INDEED }], lead: "AGGREGATOR" },
  { name: "indeed alert behind click tracking", sightings: [{ source: "GMAIL_ALERT", url: "https://x.r.us-east-1.awstrack.me/L0/https:%2F%2Fwww.indeed.com%2Fviewjob%3Fjk=1/1/abc" }], lead: "AGGREGATOR" },
  { name: "lookalike host", sightings: [{ source: "GMAIL_ALERT", url: "https://notindeed.com/jobs/1" }], lead: null },
  // Never a lead.
  { name: "linkedin alert", sightings: [{ source: "GMAIL_ALERT", url: LINKEDIN }], lead: null },
  { name: "linkedin alert behind click tracking", sightings: [{ source: "GMAIL_ALERT", url: "https://x.r.us-east-1.awstrack.me/L0/https:%2F%2Fwww.linkedin.com%2Fjobs%2Fview%2F1/1/abc" }], lead: null },
  { name: "board job also seen on linkedin", sightings: [BOARD, { source: "LINKEDIN", url: LINKEDIN }], lead: null },
  { name: "mycareersfuture alert (owner decision pending)", sightings: [{ source: "GMAIL_ALERT", url: MCF }], lead: null },
  { name: "company alert", sightings: [{ source: "GMAIL_ALERT", url: EMPLOYER_URL }], lead: null },
  { name: "employer feed only", sightings: [{ source: "GREENHOUSE", url: "https://boards.greenhouse.io/x/jobs/1" }], lead: null },
  // An employer or owner-provided observation ends the lead.
  { name: "board plus employer feed", sightings: [BOARD, { source: "GREENHOUSE", url: "https://boards.greenhouse.io/x/jobs/2" }], lead: null },
  { name: "board plus fetched employer page", sightings: [BOARD, { source: "EMPLOYER_WEBSITE", url: EMPLOYER_URL, derivedFrom: 0 }], lead: null },
  { name: "an EMPLOYER source on a board page is not the employer's posting", sightings: [BOARD, { source: "EMPLOYER_WEBSITE", url: "https://himalayas.app/companies/x/jobs/z", derivedFrom: 0 }], lead: "JOB_BOARD" },
  { name: "employer observation on an older version", sightings: [{ source: "LEVER", url: "https://jobs.lever.co/x/1", olderVersion: true }, BOARD], lead: null },
  { name: "aggregator alert completed by the employer page", sightings: [{ source: "GMAIL_ALERT", url: INDEED, unversioned: true }, { source: "EMPLOYER_WEBSITE", url: EMPLOYER_URL, derivedFrom: 0 }], lead: null },
  { name: "unversioned aggregator parent still counts as a sighting", canonicalUrl: EMPLOYER_URL, sightings: [{ source: "GMAIL_ALERT", url: INDEED, unversioned: true }, { source: "GMAIL_ALERT", url: EMPLOYER_URL, derivedFrom: 0 }], lead: "AGGREGATOR" },
  { name: "board plus linkedin saved export", sightings: [BOARD, { source: "LINKEDIN_SAVED", url: LINKEDIN }], lead: null },
  { name: "board plus mycareersfuture saved export", sightings: [BOARD, { source: "MCF_SAVED", url: MCF }], lead: null },
  { name: "board plus manual import", sightings: [BOARD, { source: "MANUAL_IMPORT", url: "https://example.test/m" }], lead: null },
  { name: "board plus pasted description", sightings: [BOARD, { source: "MANUAL_STREAMLIT", url: BOARD.url }], lead: null },
];

let admin: pg.Pool | undefined;
const schemas: string[] = [];

async function freshSchema(prefix: string): Promise<{ pool: pg.Pool; ctx: WorkspaceContext; schema: string }> {
  const schema = `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin!.query(`CREATE SCHEMA ${schema}`);
  schemas.push(schema);
  const pool = new pg.Pool({ ...pgConnectionConfig(databaseUrl), options: `-c search_path=${schema},public` });
  const client = await pool.connect();
  try {
    await runMigrations(client);
    return { pool, ctx: await resolveWorkspaceContext(client), schema };
  } finally {
    client.release();
  }
}

async function addObservation(
  pool: pg.Pool, workspaceId: string, jobVersionId: string | null, sighting: Sighting, derivedFromId: string | null = null,
): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO raw_job_observations (id, workspace_id, source_name, source_external_id, source_url, retrieved_at,
       company_name, title, description_raw, raw_payload, raw_payload_hash, processing_status, job_version_id,
       derived_from_observation_id)
     VALUES ($1, $2, $3, $4, $5, NOW(), 'Lead Fixture Co', 'Analyst', 'Synthetic.',
       '{"source_content_status":"COMPLETE"}'::jsonb, $6, 'PROCESSED', $7, $8)`,
    [id, workspaceId, sighting.source, `lead-${id}`, sighting.url, `raw-${id}`, jobVersionId, derivedFromId],
  );
  return id;
}

async function seedCase(pool: pg.Pool, workspaceId: string, testCase: Case): Promise<string> {
  const canonical = await pool.query<{ id: string }>(
    `INSERT INTO canonical_jobs (workspace_id, company_name, normalized_title, canonical_url, processing_state, processing_status)
     VALUES ($1, 'Lead Fixture Co', $2, $3, 'MATCHED', 'MATCHED') RETURNING id`,
    [workspaceId, testCase.name, testCase.canonicalUrl ?? testCase.sightings.at(-1)?.url ?? EMPLOYER_URL],
  );
  const canonicalJobId = canonical.rows[0]!.id;
  const version = async (number: number) => (await pool.query<{ id: string }>(
    `INSERT INTO job_versions (workspace_id, canonical_job_id, version_number, content_hash, description_text, observed_at)
     VALUES ($1, $2, $3, $4, 'Synthetic posting.', NOW()) RETURNING id`,
    [workspaceId, canonicalJobId, number, `lead-${crypto.randomUUID()}`],
  )).rows[0]!.id;
  const older = testCase.sightings.some((sighting) => sighting.olderVersion) ? await version(1) : null;
  const latest = await version(older ? 2 : 1);
  await pool.query(`UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE id = $2`, [latest, canonicalJobId]);
  const ids: string[] = [];
  for (const sighting of testCase.sightings) {
    const jobVersionId = sighting.unversioned ? null : sighting.olderVersion ? older : latest;
    ids.push(await addObservation(pool, workspaceId, jobVersionId, sighting,
      sighting.derivedFrom === undefined ? null : ids[sighting.derivedFrom]!));
  }
  return canonicalJobId;
}

async function leadState(pool: pg.Pool, canonicalJobId: string): Promise<{ is_lead: boolean; lead_kind: string | null }> {
  const { rows } = await pool.query<{ is_lead: boolean; lead_kind: string | null }>(
    `SELECT is_lead, lead_kind FROM v_job_lead_state WHERE canonical_job_id = $1`, [canonicalJobId]);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

beforeAll(() => {
  if (!skipReal) admin = new pg.Pool(pgConnectionConfig(databaseUrl));
});

afterAll(async () => {
  if (!admin) return;
  for (const schema of schemas) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
});

describe.skipIf(skipReal)("the lead definition (v_job_lead_state)", () => {
  let pool: pg.Pool;
  let ctx: WorkspaceContext;
  const ids = new Map<string, string>();

  beforeAll(async () => {
    ({ pool, ctx } = await freshSchema("lead_definition"));
    for (const testCase of CASES) ids.set(testCase.name, await seedCase(pool, ctx.workspaceId, testCase));
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
  });

  it.each(CASES)("$name", async (testCase) => {
    expect(await leadState(pool, ids.get(testCase.name)!)).toEqual({ is_lead: testCase.lead !== null, lead_kind: testCase.lead });
  });

  it("has an entry for every aggregator host and every source name", async () => {
    const { rows } = await pool.query<{ rule_kind: string; match_value: string; treatment: string }>(`SELECT * FROM v_job_lead_rules`);
    const host = new Map(rows.filter((r) => r.rule_kind === "HOST").map((r) => [r.match_value, r.treatment]));
    // LinkedIn by owner decision; MyCareersFuture until the owner decides. Every other aggregator makes a lead.
    const expected = Object.fromEntries(AGGREGATOR_HOSTS.map((name) =>
      [name, name === "linkedin.com" || name === "mycareersfuture.gov.sg" ? "NOT_LEAD" : "AGGREGATOR"]));
    expect(Object.fromEntries(AGGREGATOR_HOSTS.map((name) => [name, host.get(name)]))).toEqual(expected);
    const sources = rows.filter((r) => r.rule_kind === "SOURCE").map((r) => r.match_value).sort();
    expect(sources).toEqual([...SourceNameSchema.options].sort());
    expect(new Set(rows.map((r) => `${r.rule_kind}:${r.match_value}`)).size).toBe(rows.length);
  });

  it("flips MyCareersFuture by changing its one entry; saved exports stay ranked either way", async () => {
    const alert = ids.get("mycareersfuture alert (owner decision pending)")!;
    const savedMcf: Case = { name: "mycareersfuture saved only", sightings: [{ source: "MCF_SAVED", url: MCF }], lead: null };
    const saved = await seedCase(pool, ctx.workspaceId, savedMcf);
    const { rows } = await pool.query<{ definition: string }>(`SELECT pg_get_viewdef('v_job_lead_rules'::regclass) AS definition`);
    const original = rows[0]!.definition;
    const flipped = original.replace(/('mycareersfuture\.gov\.sg'::text,\s*)'NOT_LEAD'::text/, "$1'AGGREGATOR'::text");
    expect(flipped).not.toBe(original);
    try {
      await pool.query(`CREATE OR REPLACE VIEW v_job_lead_rules AS ${flipped}`);
      expect(await leadState(pool, alert)).toEqual({ is_lead: true, lead_kind: "AGGREGATOR" });
      expect((await leadState(pool, saved)).is_lead).toBe(false);
    } finally {
      await pool.query(`CREATE OR REPLACE VIEW v_job_lead_rules AS ${original}`);
    }
    expect((await leadState(pool, alert)).is_lead).toBe(false);
  });

  it("answers by job version for the AI enqueue", async () => {
    const version = async (name: string) => (await pool.query<{ id: string }>(
      `SELECT latest_job_version_id::text AS id FROM canonical_jobs WHERE id = $1`, [ids.get(name)])).rows[0]!.id;
    expect(await isLeadJobVersion(pool, ctx.workspaceId, await version("himalayas only"))).toBe(true);
    expect(await isLeadJobVersion(pool, ctx.workspaceId, await version("employer feed only"))).toBe(false);
    expect(await listLeadJobIds(pool, ctx.workspaceId)).toContain(ids.get("himalayas only"));
  });
});

describe.skipIf(skipReal)("leads leave every list and keep their history", () => {
  let pool: pg.Pool;
  let ctx: WorkspaceContext;
  let schema = "";
  let employer: JobIds;
  let board: JobIds;
  let aggregator: JobIds;
  let boardTrack: JobIds;
  let employerTrack: JobIds;

  /** Turns a ready job into one known only from the given link. */
  async function knownOnlyFrom(job: JobIds, source: string, url: string): Promise<void> {
    await pool.query(`UPDATE raw_job_observations SET source_name = $2, source_url = $3 WHERE job_version_id = $1`, [job.jobVersionId, source, url]);
    await pool.query(`UPDATE canonical_jobs SET canonical_url = $2 WHERE id = $1`, [job.canonicalJobId, `${url}?${job.canonicalJobId}`]);
  }

  async function members(sql: string): Promise<string[]> {
    const { rows } = await pool.query<{ canonical_job_id: string }>(sql, [ctx.workspaceId]);
    return [...new Set(rows.map((row) => row.canonical_job_id))].sort();
  }

  async function history(job: JobIds): Promise<unknown> {
    const { rows } = await pool.query(
      `SELECT c.processing_state, c.recommendation_outcome, c.recommendation_eligibility, c.rejection_reason, c.archived_at,
              (SELECT COUNT(*)::int FROM deterministic_decisions d WHERE d.canonical_job_id = c.id) AS decisions,
              (SELECT COUNT(*)::int FROM match_runs m WHERE m.canonical_job_id = c.id) AS match_runs,
              (SELECT COUNT(*)::int FROM raw_job_observations o JOIN job_versions v ON v.id = o.job_version_id WHERE v.canonical_job_id = c.id) AS observations
         FROM canonical_jobs c WHERE c.id = $1`, [job.canonicalJobId]);
    return rows[0];
  }

  beforeAll(async () => {
    ({ pool, ctx, schema } = await freshSchema("lead_lists"));
    const profile = await createProfile(pool, ctx);
    const ready = (outcome: "REVIEW" | "TRACK" = "REVIEW") =>
      createReadyJob(pool, ctx, profile, { laneConfidence: "High", matchScore: 80, withEvaluation: false, outcome });
    employer = await ready();
    board = await ready();
    aggregator = await ready();
    boardTrack = await ready("TRACK");
    employerTrack = await ready("TRACK");
    await knownOnlyFrom(board, "HIMALAYAS", BOARD.url);
    await knownOnlyFrom(boardTrack, "JOBICY", "https://jobicy.com/jobs/9");
    await knownOnlyFrom(aggregator, "GMAIL_ALERT", INDEED);
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
  });

  const view = (name: string) => `SELECT canonical_job_id FROM ${name} WHERE workspace_id = $1`;

  it("keeps leads out of the shortlist, Review, Apply Now, Top 10, Track, the status buckets and the rankings", async () => {
    const result = await materializeApplicationRankings(pool, ctx.workspaceId, { preferenceContext: null });
    expect(result).toMatchObject({ eligibleApplyNowJobs: 1, snapshotsInserted: 1 });
    const applyNowOnly = [employer.canonicalJobId];
    const listed = [employer.canonicalJobId, employerTrack.canonicalJobId].sort();
    expect(await members(view("v_canonical_shortlist_scoped"))).toEqual(listed);
    expect(await members(view("v_canonical_shortlist_actions_scoped"))).toEqual(listed);
    expect(await members(view("v_job_status_buckets_scoped"))).toEqual(listed);
    expect(await members(view("v_apply_now_jobs_stage3_scoped"))).toEqual(applyNowOnly);
    expect(await members(view("v_top_ten_ready_jobs_stage3_scoped"))).toEqual(applyNowOnly);
    expect(await members(view("v_track_jobs_scoped"))).toEqual([employerTrack.canonicalJobId]);
    const zero = await leadsInListsOrQueue(pool, ctx.workspaceId);
    expect(zero).toMatchObject({ name: "lead_in_list_or_queue", total: 0 });
    expect(Object.keys(zero.detail!).sort()).toEqual(Object.keys(LEAD_FREE_MEMBERSHIPS).sort());
  });

  it("stores every lead with its history, in the lead view, and a live job is in exactly one place", async () => {
    const leads = [board, aggregator, boardTrack].map((job) => job.canonicalJobId).sort();
    expect(await members(view("v_job_leads_scoped"))).toEqual(leads);
    const everywhere = await pool.query<{ memberships: number; live: number }>(
      `SELECT (SELECT COUNT(*) FROM v_job_status_buckets_scoped WHERE workspace_id = $1)::int
            + (SELECT COUNT(*) FROM v_job_awaiting_content_scoped WHERE workspace_id = $1)::int
            + (SELECT COUNT(*) FROM v_job_leads_scoped WHERE workspace_id = $1)::int AS memberships,
              (SELECT COUNT(*) FROM canonical_jobs WHERE workspace_id = $1 AND archived_at IS NULL)::int AS live`,
      [ctx.workspaceId]);
    expect(everywhere.rows[0]).toEqual({ memberships: 5, live: 5 });
    expect(await history(board)).toMatchObject({
      processing_state: "MATCHED", recommendation_outcome: "REVIEW", recommendation_eligibility: "ELIGIBLE",
      rejection_reason: null, archived_at: null, decisions: 1, match_runs: 1, observations: 1,
    });
  });

  it("keeps a lead the owner saved to the tracker visible there, marked", async () => {
    await pool.query(
      `INSERT INTO application_records (workspace_id, user_id, canonical_job_id, job_version_id, status)
       VALUES ($1, $2, $3, $4, 'INTENT')`, [ctx.workspaceId, ctx.userId, board.canonicalJobId, board.jobVersionId]);
    expect(await members(view("v_application_workspace_scoped"))).toEqual([board.canonicalJobId]);
    expect(await members(view("v_application_tracker"))).toEqual([board.canonicalJobId]);
    const marked = await pool.query(`SELECT in_application_tracker FROM v_job_leads_scoped WHERE canonical_job_id = $1`, [board.canonicalJobId]);
    expect(marked.rows).toEqual([{ in_application_tracker: true }]);
  });

  it("refuses an application handoff and new documents for a lead by saying it is a lead", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/v2", createApiV2Router({ pool, resolveContext: async () => ctx }));
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/api/v2/applications`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ canonical_job_id: board.canonicalJobId, job_version_id: board.jobVersionId }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: JOB_IS_LEAD_MESSAGE, reason: JOB_IS_LEAD_REASON });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    const record = await pool.query<{ id: string }>(
      `SELECT id::text FROM application_records WHERE canonical_job_id = $1`, [board.canonicalJobId]);
    const client = await pool.connect();
    try {
      await expect(preflightApplicationDocumentDraft(client, ctx, {
        applicationRecordId: record.rows[0]!.id, canonicalJobId: board.canonicalJobId, jobVersionId: board.jobVersionId,
      })).rejects.toThrow(JOB_IS_LEAD_MESSAGE);
      expect(await validatePersistedDocumentCurrentness(client, ctx.workspaceId, {
        canonicalJobId: board.canonicalJobId, jobVersionId: board.jobVersionId, matchRunId: board.matchRunId,
        profileVersionId: null, deterministicDecisionId: board.decisionId, contextFingerprint: board.decisionFingerprint,
      })).toEqual({ current: false, reason: JOB_IS_LEAD_REASON });
    } finally {
      client.release();
    }
  });

  it("returns the job to the lists, with the same artifacts, once the employer's posting is observed", async () => {
    const before = await history(board);
    const added = await addObservation(pool, ctx.workspaceId, board.jobVersionId, { source: "GREENHOUSE", url: "https://boards.greenhouse.io/x/jobs/3" });
    expect(await members(view("v_apply_now_jobs_stage3_scoped"))).toContain(board.canonicalJobId);
    expect(await members(view("v_job_leads_scoped"))).not.toContain(board.canonicalJobId);
    expect(await history(board)).toMatchObject({ ...(before as object), observations: 2 });
    await pool.query(`DELETE FROM raw_job_observations WHERE id = $1`, [added]);
  });

  it("fails the zero check for a lead in the AI queue, in the post-drain phase only", async () => {
    await pool.query(
      `INSERT INTO evaluation_queue (workspace_id, canonical_job_id, job_version_id, lane, priority_score, status)
       VALUES ($1, $2, $3, 'CORE_AI_DATA', 1, 'PENDING')`, [ctx.workspaceId, board.canonicalJobId, board.jobVersionId]);
    const check = await leadsInListsOrQueue(pool, ctx.workspaceId);
    expect(check).toMatchObject({ total: 1, sample: [board.canonicalJobId], detail: { evaluation_queue: 1, shortlist: 0 } });
    const names = async (phase: "pre" | "post") => (await runZeroChecks(pool, ctx.workspaceId, { phase })).map((entry) => entry.name);
    expect(await names("post")).toContain("lead_in_list_or_queue");
    expect(await names("pre")).not.toContain("lead_in_list_or_queue");
    await pool.query(`DELETE FROM evaluation_queue WHERE workspace_id = $1`, [ctx.workspaceId]);
  });

  // Last: it removes migration 123 from this schema.
  it("rolls back exactly; the check then reports the leads, and without the view the code says it cannot tell", async () => {
    const previous = fs.readFileSync(path.resolve("migrations/120_awaiting_content_read_model.sql"), "utf8").replaceAll("\r\n", "\n");
    // Anchored to line starts: the rollback comments of both migrations quote these words too.
    const start = previous.search(/^CREATE OR REPLACE VIEW v_canonical_shortlist_scoped AS$/m);
    const end = previous.search(/^COMMENT ON VIEW v_canonical_shortlist_scoped IS$/m);
    const shortlist = previous.slice(start, end);
    const columns = async () => (await pool.query(
      `SELECT attname FROM pg_attribute WHERE attrelid = to_regclass('v_canonical_shortlist_scoped') AND attnum > 0 ORDER BY attnum`)).rows;
    const columnsWith = await columns();

    await pool.query(shortlist);
    // The definition still exists, so the check sees the leads that are back in the lists.
    const back = await leadsInListsOrQueue(pool, ctx.workspaceId);
    expect(back.total).toBe(3);
    expect(back.detail).toMatchObject({ shortlist: 3, apply_now: 2, track: 1, evaluation_queue: 0 });

    await pool.query("DROP VIEW IF EXISTS v_job_leads_scoped");
    await pool.query("DROP VIEW IF EXISTS v_job_lead_state");
    await pool.query("DROP VIEW IF EXISTS v_job_lead_rules");
    expect(await columns()).toEqual(columnsWith);
    // This schema only: another test may have applied the migrations to public, which the search path also reads.
    const alone = new pg.Pool({ ...pgConnectionConfig(databaseUrl), options: `-c search_path=${schema}` });
    try {
      expect(await listLeadJobIds(alone, ctx.workspaceId)).toEqual([]);
      expect(await isLeadJobVersion(alone, ctx.workspaceId, board.jobVersionId)).toBe(false);
      const unevaluated = await leadsInListsOrQueue(alone, ctx.workspaceId);
      expect(unevaluated).toMatchObject({ total: 0, detail: { not_evaluated_migration_123_missing: 1 } });
      expect(describeZeroCheck(unevaluated)).toEqual({
        status: "NOT_EVALUATED", line: "NOT EVALUATED: lead_in_list_or_queue (migration 123 is not applied).",
      });
    } finally {
      await alone.end();
    }
  });
});
