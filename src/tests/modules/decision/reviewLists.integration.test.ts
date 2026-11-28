import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadLeadDefinitionSql, REVIEW_LIST_RULES, runReviewListsCommand, uncheckedJobCount } from "../../../app/reviewLists.js";
import { runMigrations } from "../../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../../db/pgSsl.js";
import { buildReviewListsFromStore, parseRankingDesign, type ReviewListResult } from "../../../modules/decision/index.js";
import { planAvailabilityCheck } from "../../../tasks/manualAvailabilityCheck.js";
import { selectReviewJobs } from "../../../platform/persistence/decision/index.js";
import { withReadOnlySession, type SessionIdentity } from "../../../platform/persistence/index.js";
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
// This file tests candidacy and identity, not a design: long lists and no requirement.
raw.lists.size = 20;
raw.lists.overall_size = 20;
delete raw.role_types[1].requires;
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

async function archive(name: string): Promise<void> {
  const archiveRun = crypto.randomUUID();
  await pool.query(
    `INSERT INTO job_archive_runs (id, run_started_at, cutoff_at, mode, status) VALUES ($1, NOW(), NOW() - INTERVAL '1 day', 'DRY_RUN', 'SUCCEEDED')`,
    [archiveRun],
  );
  await pool.query(
    `UPDATE canonical_jobs SET archived_at = NOW(), archive_run_id = $2, archive_reason = 'fixture archive',
        archive_age_basis = 'OBSERVED_AGE_PUBLICATION_UNKNOWN', archive_reference_at = NOW() WHERE id = $1`,
    [ids[name], archiveRun],
  );
}

const close = (name: string) =>
  pool.query(
    `UPDATE job_versions SET availability_status = 'CLOSED' WHERE id = (SELECT latest_job_version_id FROM canonical_jobs WHERE id = $1)`,
    [ids[name]],
  );

let eventClock = Date.now() - 3_600_000;

/** One stored read of a job's current version, later than every earlier one. */
async function checkEvent(name: string, decision: "MARK_CLOSED" | "MARK_OPEN", details: object): Promise<void> {
  eventClock += 1_000;
  await pool.query(
    `INSERT INTO job_availability_recheck_events (workspace_id, canonical_job_id, job_version_id, occurred_at, read_kind,
       outcome, decision, reason_code, consecutive_absent_reads_after, cannot_tell_attempts_after, details)
     SELECT workspace_id, id, latest_job_version_id, $2, 'PAGE', $4, $5, 'INVENTED', 0, 0, $3::jsonb
       FROM canonical_jobs WHERE id = $1`,
    [ids[name], new Date(eventClock), JSON.stringify(details), decision === "MARK_OPEN" ? "OPEN" : "CLOSED_BY_PAGE", decision],
  );
}

/** A closure as a check stores it: the verdict on the version and the event that gave it. */
async function closedByCheck(name: string, checkByHand: boolean): Promise<void> {
  const at = new Date();
  await pool.query(
    `UPDATE job_versions SET availability_status = 'CLOSED', availability_verified_at = $2
      WHERE id = (SELECT latest_job_version_id FROM canonical_jobs WHERE id = $1)`,
    [ids[name], at],
  );
  await pool.query(
    `INSERT INTO job_availability_recheck_events (workspace_id, canonical_job_id, job_version_id, occurred_at, read_kind,
       outcome, decision, reason_code, consecutive_absent_reads_after, cannot_tell_attempts_after, details)
     SELECT workspace_id, id, latest_job_version_id, $2, 'PAGE', 'CLOSED_BY_PAGE', 'MARK_CLOSED', 'PAGE_NO_LONGER_ACCEPTING', 0, 0, $3::jsonb
       FROM canonical_jobs WHERE id = $1`,
    [ids[name], at, JSON.stringify({ trigger: "MANUAL", ...(checkByHand ? { check_by_hand: true } : {}) })],
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

    await seed("best", { company: "Example Orchard", title: "zorblat software engineer", similarity: 0.9 });
    await seed("second", { company: "Example Plain Co", title: "zorblat software developer", similarity: 0.8 });
    await seed("noScore", { company: "Example Plain Co", title: "quindle backend developer", similarity: null });
    await seed("saved", { company: "Example Saved Co", title: "zorblat software engineer" });
    await observe("saved", "LINKEDIN_SAVED", "https://www.linkedin.com/jobs/view/4900000001");
    await seed("linkedIn", { company: "Example Linked Co", title: "zorblat software engineer" });
    await onlySeenOn("linkedIn", "GMAIL_ALERT", "https://www.linkedin.com/jobs/view/4900000002");
    await seed("lead", { company: "Example Board Co", title: "zorblat software engineer", similarity: 1 });
    await onlySeenOn("lead", "HIMALAYAS", "https://himalayas.app/companies/x/jobs/y");
    await seed("closed", { company: "Example Closed Co", title: "zorblat software engineer" });
    await pool.query(
      `UPDATE job_versions SET availability_status = 'CLOSED' WHERE id = (SELECT latest_job_version_id FROM canonical_jobs WHERE id = $1)`,
      [ids.closed],
    );
    await seed("gated", { company: "Example Gated Co", title: "zorblat software engineer" });
    await pool.query("UPDATE canonical_jobs SET gate_decision = 'NEEDS_VERIFICATION' WHERE id = $1", [ids.gated]);
    await seed("incomplete", { company: "Example Short Co", title: "zorblat software engineer" });
    await pool.query("UPDATE canonical_jobs SET description_quality_status = 'INCOMPLETE' WHERE id = $1", [ids.incomplete]);
    await seed("fixture", { company: "Example Fixture Co", title: "zorblat software engineer" });
    await pool.query("UPDATE canonical_jobs SET is_test_fixture = TRUE WHERE id = $1", [ids.fixture]);
    await seed("never", { company: "Example Sparkler", title: "zorblat software engineer" });
    // The same posting twice: a legal suffix and a way of writing the location apart. One record was rated.
    await seed("rated", { company: "Example Twice Pte Ltd", title: "tovrik data scientist" });
    await seed("ratedAgain", { company: "Example Twice", title: "tovrik data scientist" });

    // Each of these postings has a second record that is live and untouched.
    for (const [name, company] of [["removed", "Example Removed Co"], ["shut", "Example Shut Co"], ["longGone", "Example Gone Co"], ["oldSaved", "Example Kept Co"]]) {
      await seed(name!, { company: `${company} Pte Ltd`, title: "zorblat software engineer" });
      await seed(`${name}Twin`, { company: company!, title: "zorblat software engineer" });
    }
    await pool.query("UPDATE canonical_jobs SET processing_state = 'MANUALLY_REMOVED' WHERE id = $1", [ids.removed]);
    await close("shut");
    await close("longGone");
    await archive("longGone");
    await observe("oldSaved", "LINKEDIN_SAVED", "https://www.linkedin.com/jobs/view/4900000003");
    await archive("oldSaved");
    await seed("placeholder", { company: "Unknown Company", title: "glimmet data scientist" });
    await seed("unlisted", { company: "Example Unlisted Co", title: "brumble data scientist" });
    // One job left out for incomplete content was saved; one listed posting keeps only a short extract.
    await seed("incompleteSaved", { company: "Example Short Saved Co", title: "zorblat software engineer" });
    await observe("incompleteSaved", "LINKEDIN_SAVED", "https://www.linkedin.com/jobs/view/4900000004");
    await pool.query("UPDATE canonical_jobs SET description_quality_status = 'INCOMPLETE' WHERE id = $1", [ids.incompleteSaved]);
    await seed("blankText", { company: "Example Blank Co", title: "wibbet data scientist" });
    await pool.query("UPDATE job_versions SET description_text = '   ' WHERE id = (SELECT latest_job_version_id FROM canonical_jobs WHERE id = $1)", [ids.blankText]);
    await seed("checked", { company: "Example Checked Co", title: "zorblat software engineer" });
    await pool.query(
      `UPDATE job_versions SET availability_verified_at = NOW() WHERE id = (SELECT latest_job_version_id FROM canonical_jobs WHERE id = $1)`,
      [ids.checked],
    );
    // Closed from page wording alone, with a live second record; confirmed closed; and by-hand ones that were confirmed since.
    for (const name of ["byHand", "byHandAlone", "confirmed", "byHandThenSource", "byHandExpired", "byHandThenRead", "readThenByHand", "reopened"]) {
      await seed(name, { company: `Example ${name} Co`, title: "zorblat software engineer" });
    }
    await seed("byHandTwin", { company: "Example byHand Co", title: "zorblat software engineer" });
    await closedByCheck("byHand", true);
    await closedByCheck("byHandAlone", true);
    await closedByCheck("confirmed", false);
    // Closed from page wording, then a read that confirms it without a new verdict; and the other way round.
    await closedByCheck("byHandThenRead", true);
    await checkEvent("byHandThenRead", "MARK_CLOSED", {});
    await checkEvent("readThenByHand", "MARK_CLOSED", {});
    await closedByCheck("readThenByHand", true);
    // Confirmed closed, seen open again, then closed from page wording only: the confirmation no longer counts.
    await checkEvent("reopened", "MARK_CLOSED", {});
    await checkEvent("reopened", "MARK_OPEN", {});
    await closedByCheck("reopened", true);
    await closedByCheck("byHandThenSource", true);
    // A later verdict that is not that check's: the source itself said closed.
    await pool.query(
      `UPDATE job_versions SET availability_verified_at = availability_verified_at + INTERVAL '2 hours'
        WHERE id = (SELECT latest_job_version_id FROM canonical_jobs WHERE id = $1)`,
      [ids.byHandThenSource],
    );
    await closedByCheck("byHandExpired", true);
    await pool.query(
      `UPDATE job_versions SET source_expires_at = NOW() - INTERVAL '1 day'
        WHERE id = (SELECT latest_job_version_id FROM canonical_jobs WHERE id = $1)`,
      [ids.byHandExpired],
    );
    // The full text is stored, and almost all of it is a link: the sheet could not show this posting.
    await seed("mostlyLink", {
      company: "Example Link Only Co", title: "tovrik data scientist",
      description: `Apply: https://quindle.example.test/${"a/".repeat(200)}`,
    });
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
    const software = result.lists.byType.find((list) => list.type.key === "ALPHA")!;
    ids.byHandPosting = software.jobs.find((job) => job.id === ids.byHand || job.id === ids.byHandTwin)!.id;
    expect(software.jobs.map((job) => job.id).sort())
      .toEqual(["best", "second", "noScore", "saved", "linkedIn", "oldSavedTwin", "checked", "byHandPosting", "byHandAlone", "reopened"].map((name) => ids[name]).sort());
    // Preferred sector first, then top-K from the stored similarity, then no score.
    expect(software.jobs.slice(0, 2).map((job) => job.id)).toEqual([ids.best, ids.second]);
    expect(software.jobs.at(-1)!.id).toBe(ids.noScore);
    expect(software.jobs[0]!.topK).toBeCloseTo(90, 4);
    expect(software.jobs.at(-1)!.topK).toBeNull();

    const byId = new Map(software.jobs.map((job) => [job.id, job]));
    expect(byId.get(ids.saved!)).toMatchObject({ saved: true, linkedInOnly: false });
    expect(byId.get(ids.linkedIn!)).toMatchObject({ saved: false, linkedInOnly: true });
    expect(result.lists.overall.map((job) => job.id)).toContain(ids.saved);

    expect(result.excluded).toMatchObject({ LEAD: 1, KNOWN_CLOSED: 7, NOT_GATE_PASSED: 1, NO_FULL_TEXT: 3 });
    expect(result.dropped).toMatchObject({ rated: 2, neverSector: 1 });
    expect(result.lists.byType.find((list) => list.type.key === "BETA")!.jobs.map((job) => job.id).sort())
      .toEqual([ids.placeholder, ids.unlisted].sort());
  });

  it("leaves a job without the full posting text out and counts it by role type", async () => {
    const result = await run();
    // incomplete and incompleteSaved (not COMPLETE), and blankText, whose stored text is blank.
    expect(result.excluded.NO_FULL_TEXT).toBe(3);
    expect(result.withoutFullText).toEqual({ byRoleType: { ALPHA: 2, BETA: 1 }, saved: 1, unsaved: 2 });
    for (const name of ["incomplete", "incompleteSaved", "blankText"]) expect(result.postings.map((job) => job.id)).not.toContain(ids[name]);
    // Counted for the text, not for the gate that has not decided it.
    expect(result.excluded.NOT_GATE_PASSED).toBe(1);
  });

  it("leaves a posting off when the sheet could not show its text, and counts it", async () => {
    const result = await run();
    expect(result.excluded.TEXT_CANNOT_BE_SHOWN).toBe(1);
    expect(result.textNotShown).toEqual({ byRoleType: { BETA: 1 }, saved: 0, unsaved: 1 });
    expect(result.postings.map((job) => job.id)).not.toContain(ids.mostlyLink);
    expect(result.postings.find((job) => job.id === ids.best)!.sourceLinks.length).toBeGreaterThan(0);
  });

  it("names the closed records, for the draft to report", async () => {
    const result = await run();
    expect(result.closedIds).toEqual(expect.arrayContaining([ids.closed, ids.shut, ids.shutTwin, ids.longGone, ids.longGoneTwin]));
    expect(result.closedIds).not.toContain(ids.best);
  });

  it("keeps a job closed from page wording alone, as not verified, and drops a confirmed closure", async () => {
    const result = await run();
    const posting = result.postings.find((job) => job.id === ids.byHand || job.id === ids.byHandTwin);
    // The posting with a live second record stays, and so does the one without: neither closure is confirmed.
    expect(posting).toBeDefined();
    expect(result.postings.find((job) => job.id === ids.byHandAlone)).toMatchObject({ availability: "UNKNOWN" });
    expect([...result.checkByHandIds].sort()).toEqual([ids.byHand, ids.byHandAlone, ids.reopened].sort());
    expect(result.closedIds).not.toContain(ids.byHandAlone);
    expect(result.closedIds).not.toContain(ids.byHand);
    expect(result.closedIds).not.toContain(ids.byHandTwin);
    const listed = result.postings.map((job) => job.id);
    for (const name of ["confirmed", "byHandThenSource", "byHandExpired", "byHandThenRead", "readThenByHand"]) {
      expect(listed).not.toContain(ids[name]);
      expect(result.closedIds).toContain(ids[name]);
    }
  });

  it("counts as unchecked only what the check would still read today", async () => {
    await withReadOnlySession(
      { ...pgConnectionConfig(databaseUrl), options: `-c search_path=${schema},public` },
      () => undefined,
      async (db) => {
        const count = (names: string[]) => uncheckedJobCount(db, workspace.workspaceId, names.map((name) => ids[name]!), new Date());
        // The same answer as the check command's own plan, job by job and together.
        const names = ["best", "second", "linkedIn", "lead", "checked", "saved", "noScore"];
        for (const group of [...names.map((name) => [name]), names]) {
          const plan = await planAvailabilityCheck(db as never, workspace, group.map((name) => ids[name]!), { now: new Date() });
          expect(await count(group), group.join()).toBe(plan.reads.length);
        }
        expect(await count(["best", "second"])).toBe(2);
        // A LinkedIn link and a job-board link are never read: they stay as not verified.
        expect(await count(["linkedIn", "lead"])).toBe(0);
        expect(await count(["checked"])).toBe(0);
      },
    );
  });

  it("does not bring a removed or known-closed posting back through its other record", async () => {
    const result = await run();
    const listed = result.postings.map((job) => job.id);
    for (const name of ["removedTwin", "shutTwin", "longGoneTwin"]) expect(listed).not.toContain(ids[name]);
    expect(result.dropped.dismissed).toBe(3);
  });

  it("marks the live copy of a posting saved under an archived record", async () => {
    const result = await run();
    expect(result.postings.find((job) => job.id === ids.oldSavedTwin)).toMatchObject({ saved: true });
    expect(result.lists.overall.map((job) => job.id)).toContain(ids.oldSavedTwin);
  });

  it("collapses the two records of one posting when neither was rated", async () => {
    const result = await run();
    expect(result.lists.byType.find((list) => list.type.key === "BETA")!.jobs.map((job) => job.id))
      .toEqual(expect.arrayContaining([ids.placeholder, ids.unlisted]));
    expect(result.lists.byType.find((list) => list.type.key === "BETA")!.jobs).toHaveLength(3);
    expect(result.dropped.duplicate).toBe(2);
  });

  it("refuses a database that is not the approved replay branch, and writes nothing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jde-review-guard-"));
    try {
      const privateDir = path.join(root, "private");
      const designFile = path.join(privateDir, "ranking_design.json");
      fs.mkdirSync(privateDir, { recursive: true });
      fs.writeFileSync(designFile, JSON.stringify(raw));
      // The test database reports no branch and is not the approved database: only the guard stops the read.
      await expect(runReviewListsCommand(
        [`--private-dir=${privateDir}`, `--design=${designFile}`],
        { REPLAY_DATABASE_URL: databaseUrl, REPLAY_BRANCH_ID: "br-invented-branch" },
        { log: () => undefined },
      )).rejects.toThrow("Refusing to run: REPLAY_DATABASE_URL is not the approved replay branch.");
      expect(fs.existsSync(path.join(privateDir, "review"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("asks for approval of the connected database before any work, and does none when refused", async () => {
    const seenIdentities: SessionIdentity[] = [];
    let worked = false;
    await expect(withReadOnlySession(
      pgConnectionConfig(databaseUrl),
      (identity) => {
        seenIdentities.push(identity);
        throw new Error("not this database");
      },
      async () => {
        worked = true;
      },
    )).rejects.toThrow("not this database");
    expect(worked).toBe(false);
    const { rows } = await admin!.query<{ name: string }>("SELECT current_database() AS name");
    expect(seenIdentities).toEqual([{ databaseName: rows[0]!.name, branchId: null }]);
  });

  it("reads archived records without their description and does not count them as excluded", async () => {
    const records = await selectReviewJobs(pool, workspace.workspaceId, []);
    const byId = new Map(records.map((record) => [record.id, record]));
    expect(byId.get(ids.oldSaved!)).toMatchObject({ archived: true, description: null });
    expect(byId.get(ids.oldSavedTwin!)!.description).toBeTruthy();
    expect((await run()).excluded.ARCHIVED_OR_FIXTURE).toBe(0);
    // A rated record is still counted.
    expect((await run([ids.oldSaved!])).excluded.ARCHIVED_OR_FIXTURE).toBe(1);
  });

  it("tells the classifier that a placeholder employer is unknown", async () => {
    const demanding = structuredClone(raw);
    demanding.role_types[1].requires = { top_technology_employer: true };
    const result = await withReadOnlySession(
      { ...pgConnectionConfig(databaseUrl), options: `-c search_path=${schema},public` },
      () => undefined,
      (db) => buildReviewListsFromStore(db, {
        workspaceId: workspace.workspaceId, design: parseRankingDesign(JSON.stringify(demanding)), companyTags: [],
        ratedIds: [], rules: REVIEW_LIST_RULES, leadDefinitionSql: loadLeadDefinitionSql(),
      }),
    );
    const status = (name: string) => result.postings.find((job) => job.id === ids[name])?.classification.status;
    expect(status("placeholder")).toBe("TARGET");
    // A known employer that is not on the list is still left out.
    expect(status("unlisted")).toBe("NEVER");
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

  it("writes no sheet while a listed job awaits the check, and removes an earlier one (the real read)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jde-review-real-"));
    try {
      const privateDir = path.join(root, "private");
      const designFile = path.join(privateDir, "ranking_design.json");
      fs.mkdirSync(privateDir, { recursive: true });
      fs.writeFileSync(designFile, JSON.stringify(raw));
      const url = new URL(databaseUrl);
      url.searchParams.set("options", `-c search_path=${schema},public`);
      const output: string[] = [];
      const command = (argv: string[]) => runReviewListsCommand(
        [`--private-dir=${privateDir}`, `--design=${designFile}`, "--name=real", ...argv],
        { REPLAY_DATABASE_URL: url.toString(), REPLAY_BRANCH_ID: "br-invented-branch" },
        // The replay-branch check is replaced for this local database only; it has its own test above.
        { log: (line) => output.push(line), approve: () => undefined },
      );
      const sheet = path.join(privateDir, "review", "review_lists_sheet_real.md");
      const key = path.join(privateDir, "review", "review_lists_key_real.json");
      const setVerified = (when: string) => pool.query(
        `UPDATE job_versions SET availability_verified_at = ${when} WHERE availability_status = 'OPEN'`,
      );

      await command([]);
      expect(output.join(" ")).toContain("NOT FINAL");
      expect(fs.existsSync(sheet) || fs.existsSync(key)).toBe(false);

      await setVerified("NOW()");
      output.length = 0;
      await command([]);
      expect(output.join(" ")).not.toContain("NOT FINAL");
      expect(fs.readFileSync(sheet, "utf8")).toContain("Responsibilities: Design data services");
      expect(fs.existsSync(key)).toBe(true);

      // One listed job is unchecked again: the earlier, unfilled sheet and key go.
      await pool.query(
        `UPDATE job_versions SET availability_verified_at = NOW() - INTERVAL '3 days'
          WHERE id = (SELECT latest_job_version_id FROM canonical_jobs WHERE id = $1)`,
        [ids.second],
      );
      output.length = 0;
      await command(["--replace"]);
      expect(output.join(" ")).toContain("NOT FINAL");
      expect(fs.existsSync(sheet)).toBe(false);
      expect(fs.existsSync(key)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
