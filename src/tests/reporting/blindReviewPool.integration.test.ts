import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { drawBlindReview, labelledIdsFromKeys, renderBlindReviewKey } from "../../reporting/blindReviewDraw.js";
import { loadBlindReviewPool, type BlindReviewPool } from "../../reporting/blindReviewPool.js";
import { BLIND_REVIEW_EXCLUSIONS, type BlindReviewExclusion } from "../../reporting/blindReviewRules.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

// The blind review pool against the real read models (v_job_content_state, v_job_availability_current). Synthetic jobs only.
// Each test runs in a rolled-back transaction, so it sees only its own jobs.
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the blind review pool integration test against its PostgreSQL service.");
}

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;
let profileVersionId = "";
const db = (): pg.PoolClient => {
  if (!client) throw new Error("The test database is not initialized.");
  return client;
};
const ctx = (): WorkspaceContext => {
  if (!context) throw new Error("The test workspace is not initialized.");
  return context;
};

interface JobOptions {
  company?: string;
  title?: string;
  location?: string;
  url?: string;
  quality?: "COMPLETE" | "INCOMPLETE";
  availability?: "OPEN" | "CLOSED";
  verifiedAt?: Date;
  recheckAt?: Date;
  gate?: string;
  state?: string;
  outcome?: string | null;
  fixture?: boolean;
  archived?: boolean;
  policy?: string | null;
  score?: number | null;
  identityHash?: string;
}

interface Seeded {
  jobId: string;
  versionId: string;
  url: string;
}

const DAY = 24 * 3_600_000;

async function seedJob(options: JobOptions = {}): Promise<Seeded> {
  const jobId = randomUUID();
  const versionId = randomUUID();
  const url = options.url ?? `https://careers.example.test/jobs/${jobId}`;
  await db().query(
    `INSERT INTO canonical_jobs (id, workspace_id, company_name, normalized_title, canonical_url, location, processing_state, processing_status,
                                 gate_decision, description_quality_status, recommendation_requirement_score, recommendation_outcome, is_test_fixture)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10, $11, $12)`,
    [jobId, ctx().workspaceId, options.company ?? `Company ${jobId}`, options.title ?? "fixture role", url, options.location ?? "Singapore",
      options.state ?? "MATCHED", options.gate ?? "PASS", options.quality ?? "COMPLETE", options.score === undefined ? 0.7 : options.score,
      options.outcome === undefined ? "REVIEW" : options.outcome, options.fixture === true],
  );
  await db().query(
    `INSERT INTO job_versions (id, workspace_id, canonical_job_id, content_hash, description_text, observed_at,
                               availability_status, availability_verified_at, availability_recheck_at, source_posting_identity_hash)
     VALUES ($1, $2, $3, $4, 'fixture', NOW(), $5, $6, $7, $8)`,
    [versionId, ctx().workspaceId, jobId, `hash-${versionId}`, options.availability ?? "OPEN", options.verifiedAt ?? new Date(),
      options.recheckAt ?? new Date(Date.now() + 7 * DAY), options.identityHash ?? null],
  );
  await db().query(`UPDATE canonical_jobs SET latest_job_version_id = $2 WHERE id = $1`, [jobId, versionId]);
  if (options.policy !== null) {
    const run = await db().query<{ id: string }>(
      `INSERT INTO match_runs (workspace_id, canonical_job_id, job_version_id, profile_version_id, job_content_hash, context_fingerprint, status,
                               requirement_count, matched_count, policy_version, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'COMPLETED', 5, 3, $7, NOW()) RETURNING id`,
      [ctx().workspaceId, jobId, versionId, profileVersionId, `hash-${versionId}`, `ctx-${versionId}`,
        options.policy ?? "deterministic_v3_topk_capability_semantic_v1"],
    );
    await db().query(`UPDATE canonical_jobs SET latest_match_run_id = $2 WHERE id = $1`, [jobId, run.rows[0]!.id]);
  }
  if (options.archived) {
    const archiveRun = randomUUID();
    await db().query(
      `INSERT INTO job_archive_runs (id, run_started_at, cutoff_at, mode, status) VALUES ($1, NOW(), NOW() - INTERVAL '1 day', 'DRY_RUN', 'SUCCEEDED')`,
      [archiveRun],
    );
    await db().query(
      `UPDATE canonical_jobs SET archived_at = NOW(), archive_run_id = $2, archive_reason = 'fixture archive',
              archive_age_basis = 'HARD_REJECTED_DECISION', archive_reference_at = NOW() WHERE id = $1`,
      [jobId, archiveRun],
    );
  }
  return { jobId, versionId, url };
}

async function observe(
  job: Seeded | null,
  options: { source: string; url?: string; applyUrl?: string; company?: string; derivedFrom?: string },
): Promise<string> {
  const id = randomUUID();
  await db().query(
    `INSERT INTO raw_job_observations (id, workspace_id, source_name, source_url, canonical_apply_url, company_name, title, description_raw,
                                       location_raw, raw_payload_hash, job_version_id, derived_from_observation_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'fixture role', 'fixture', 'Singapore', $7, $8, $9)`,
    [id, ctx().workspaceId, options.source, options.url ?? job?.url ?? null, options.applyUrl ?? null, options.company ?? "Fixture Co",
      createHash("sha256").update(id).digest("hex"), job?.versionId ?? null, options.derivedFrom ?? null],
  );
  return id;
}

async function apply(job: Seeded, status: string): Promise<void> {
  const userId = randomUUID();
  await db().query(`INSERT INTO workspace_users (id, user_key, display_name) VALUES ($1, $2, 'Fixture')`, [userId, `blind-${userId}`]);
  await db().query(
    `INSERT INTO application_records (workspace_id, user_id, canonical_job_id, job_version_id, status) VALUES ($1, $2, $3, $4, $5)`,
    [ctx().workspaceId, userId, job.jobId, job.versionId, status],
  );
}

const load = (excludedIds: string[] = [], now = new Date()): Promise<BlindReviewPool> =>
  loadBlindReviewPool(db(), { workspaceId: ctx().workspaceId, excludedIds, now });

const counts = (only: Partial<Record<BlindReviewExclusion, number>>) => ({
  ...Object.fromEntries(BLIND_REVIEW_EXCLUSIONS.map((reason) => [reason, 0])),
  ...only,
});

/** Beside the eligible control job: exactly the control is drawn, and every other seeded job is counted under its reason. */
async function expectOnly(good: Seeded, expected: Partial<Record<BlindReviewExclusion, number>>, excludedIds: string[] = [], now = new Date()) {
  const result = await load(excludedIds, now);
  expect(result.rows.map((row) => row.id)).toEqual([good.jobId]);
  expect(result.excluded).toEqual(counts(expected));
  expect(result.scored).toBe(1 + Object.values(result.excluded).reduce((a, b) => a + b, 0));
  return result;
}

describe.skipIf(skipReal)("blind review pool (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `blind_pool_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
    const profile = await client.query<{ id: string }>(
      `INSERT INTO candidate_profiles (workspace_id, profile_key, display_name) VALUES ($1, $2, 'Blind Fixture') RETURNING id`,
      [ctx().workspaceId, `blind-${randomUUID()}`],
    );
    const version = await client.query<{ id: string }>(
      `INSERT INTO profile_versions (workspace_id, candidate_profile_id, version_number, schema_version, source_hash, status, effective_at)
       VALUES ($1, $2, 1, '2.2.0', $3, 'ACTIVE', NOW()) RETURNING id`,
      [ctx().workspaceId, profile.rows[0]!.id, `profile-${randomUUID()}`],
    );
    profileVersionId = version.rows[0]!.id;
  }, 120_000);

  beforeEach(async () => { await db().query("BEGIN"); });
  afterEach(async () => { await db().query("ROLLBACK"); });

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  it("leaves out archived, fixture, gate, removed, content, link, match, stale and closed jobs, one reason each", async () => {
    const good = await seedJob();
    await seedJob({ archived: true });
    await seedJob({ fixture: true });
    await seedJob({ gate: "HARD_REJECT", state: "HARD_REJECTED", outcome: null });
    await seedJob({ state: "MANUALLY_REMOVED" });
    await seedJob({ quality: "INCOMPLETE" });
    await seedJob({ url: "https://himalayas.app/jobs/0123456789abcdef0123" });
    await seedJob({ url: "javascript:alert(1)" });
    await seedJob({ policy: null });
    await seedJob({ policy: "deterministic_v3_other_policy" });
    await seedJob({ state: "PREQUALIFIED" });
    await seedJob({ availability: "CLOSED" });
    await seedJob({ recheckAt: new Date(Date.now() - 60_000) });
    await seedJob({ score: null }); // never scored: reported separately
    const result = await expectOnly(good, {
      ARCHIVED: 1, TEST_FIXTURE: 1, NOT_GATE_PASSED: 1, MANUALLY_REMOVED: 1, AWAITING_CONTENT: 1, NO_POSTING_LINK: 2,
      NO_CURRENT_TOPK_MATCH: 2, AWAITING_RECOMPUTE: 1, NOT_CONFIRMED_OPEN: 2,
    });
    expect(result.notYetDecided).toBe(1);
  });

  it("draws only postings verified open on the Singapore date of the given clock", async () => {
    const now = new Date("2026-01-11T01:00:00Z"); // 11 Jan, 09:00 in Singapore
    const recheckAt = new Date("2100-01-01T00:00:00Z");
    // 11 Jan 00:30 in Singapore, still 10 Jan in UTC.
    const good = await seedJob({ verifiedAt: new Date("2026-01-10T16:30:00Z"), recheckAt });
    // 10 Jan 23:30 in Singapore: less than two hours before `now`, but the day before.
    await seedJob({ verifiedAt: new Date("2026-01-10T15:30:00Z"), recheckAt });
    const result = await expectOnly(good, { NOT_VERIFIED_OPEN_ON_DRAW_DATE: 1 }, [], now);
    expect([result.drawDate, result.timeZone]).toEqual(["2026-01-11", "Asia/Singapore"]);
    // The next day neither is eligible.
    expect((await load([], new Date("2026-01-12T01:00:00Z"))).excluded.NOT_VERIFIED_OPEN_ON_DRAW_DATE).toBe(2);
  });

  it.each(["LINKEDIN_SAVED", "MCF_SAVED"])("leaves out a job the owner saved (%s)", async (source) => {
    const good = await seedJob();
    const saved = await seedJob();
    await observe(saved, { source });
    await expectOnly(good, { SAVED_BY_USER: 1 });
  });

  it("recognises a saved alert card behind the retrieved posting, and a saved posting not linked to any job", async () => {
    const good = await seedJob();
    const viaParent = await seedJob();
    const parent = await observe(null, { source: "MCF_SAVED", url: "https://www.mycareersfuture.gov.sg/job/x/parent", company: "Elsewhere" });
    await observe(viaParent, { source: "EMPLOYER_WEBSITE", derivedFrom: parent });
    const unlinked = await seedJob({ company: "Unlinked Saved Co" });
    await observe(null, { source: "MCF_SAVED", url: unlinked.url, company: "Unlinked Saved Co" });
    await expectOnly(good, { SAVED_BY_USER: 1, SAME_POSTING_AS_SAVED_APPLIED_OR_LABELLED: 1 });
  });

  it("leaves out a job with an application record, whatever its status", async () => {
    const good = await seedJob();
    await apply(await seedJob(), "WITHDRAWN");
    await apply(await seedJob(), "INTENT");
    await expectOnly(good, { HAS_APPLICATION: 2 });
  });

  it("leaves out a job labelled in an earlier sheet, read from its key file as --exclude does", async () => {
    const good = await seedJob();
    const labelled = await seedJob();
    const ids = labelledIdsFromKeys(["earlier.json"], () => JSON.stringify({ items: [{ id: labelled.jobId }, { id: randomUUID() }] }));
    const result = await expectOnly(good, { ALREADY_LABELLED: 1 }, ids);
    expect(result.labelledNotFound).toBe(1);
  });

  it("leaves out the same posting held under a second canonical record, by each existing dedupe key", async () => {
    const good = await seedJob({ company: "Acme Pte", title: "other role" });
    const labelled = await seedJob({ company: "Acme Pte", title: "data lead", identityHash: "ashby:abc", url: "https://jobs.example.test/1?utm_source=a" });
    await seedJob({ company: "ACME  PTE.", title: "data lead" }); // company + title + location
    await seedJob({ company: "Acme Pte", title: "renamed", location: "Remote", identityHash: "ashby:abc" }); // source identity
    await seedJob({ company: "Acme Pte", title: "data lead", location: "Elsewhere", url: "https://jobs.example.test/1" }); // URL + title
    await seedJob({ company: "Acme Pte", title: "renamed too", url: "https://jobs.example.test/1?utm_source=b" }); // URL + location
    // Another employer with the same title and location is a different posting.
    const other = await seedJob({ company: "Different", title: "data lead" });
    const result = await load([labelled.jobId]);
    expect(result.rows.map((row) => row.id).sort()).toEqual([good.jobId, other.jobId].sort());
    expect(result.excluded).toEqual(counts({ ALREADY_LABELLED: 1, SAME_POSTING_AS_SAVED_APPLIED_OR_LABELLED: 4 }));
  });

  it("leaves out every job with a LinkedIn link or LinkedIn observation, also when an employer board has it too", async () => {
    const good = await seedJob();
    await seedJob({ url: "https://www.linkedin.com/jobs/view/1234567" }); // posting link
    const alert = await seedJob(); // Gmail alert linking to LinkedIn; the posting link is the employer's
    await observe(alert, { source: "GMAIL_ALERT", url: "https://sg.linkedin.com/comm/jobs/view/7654321?trk=x" });
    await observe(alert, { source: "GREENHOUSE" });
    const bySource = await seedJob();
    await observe(bySource, { source: "LINKEDIN" });
    const viaParent = await seedJob();
    const parent = await observe(null, { source: "GMAIL_ALERT", url: "https://www.linkedin.com/jobs/view/999999" });
    await observe(viaParent, { source: "EMPLOYER_WEBSITE", derivedFrom: parent });
    const applyLink = await seedJob();
    await observe(applyLink, { source: "HIMALAYAS", applyUrl: "https://lnkd.in/abc" });
    await expectOnly(good, { LINKEDIN: 5 });
  });

  it("draws 15 top and 15 middle from a pool of 100 read from the database", async () => {
    for (let i = 0; i < 100; i += 1) await seedJob({ score: (1000 - i) / 1000 });
    const result = await load();
    expect(result.rows.map((row) => row.score)).toEqual([...result.rows.map((row) => row.score)].sort((a, b) => b - a));
    const picked = drawBlindReview(result, "seed");
    expect(picked.filter((j) => j.group === "TOP")).toHaveLength(15);
    expect(picked.filter((j) => j.group === "MIDDLE")).toHaveLength(15);
    expect(JSON.parse(renderBlindReviewKey(picked, result, "seed"))).toMatchObject({ pool: 100, timeZone: "Asia/Singapore" });
  }, 60_000);
});
