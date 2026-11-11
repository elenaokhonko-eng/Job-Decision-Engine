/**
 * Saved-jobs posting facts through the real pipeline (PostgreSQL): import ->
 * source evidence -> normalization onto job_versions -> deterministic
 * recommendation decider -> AVAILABILITY and FRESHNESS readiness.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadStructuredFile } from "../../config/structuredLoader.js";
import { SourcePluginSchema, type SourcePlugin } from "../../contracts/index.js";
import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { parseLinkedInSavedExport } from "../../ingestion/linkedInSavedExport.js";
import { importLinkedInSavedJobs } from "../../ingestion/linkedInSavedImport.js";
import {
  linkedInSavedEnrichmentExitCode,
  planLinkedInSavedEnrichment,
  runLinkedInSavedEnrichment,
} from "../../ingestion/linkedInSavedEnrichment.js";
import { parseMcfSavedExport } from "../../ingestion/mcfSavedExport.js";
import { importMcfSavedJobs } from "../../ingestion/mcfSavedImport.js";
import { runNormalization } from "../../pipeline/normalize.js";
import { runRecommendationDecider } from "../../pipeline/recommendationDecider.js";
import { saveWorkspacePreferenceRevision } from "../../policy/workspacePreferenceRegistry.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the saved-jobs posting-facts integration tests against its PostgreSQL service.");
}

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;
let linkedInPlugin: SourcePlugin | undefined;
let mcfPlugin: SourcePlugin | undefined;

function db(): pg.PoolClient {
  if (!client) throw new Error("The integration database is not initialized.");
  return client;
}
function ctx(): WorkspaceContext {
  if (!context) throw new Error("The integration workspace is not initialized.");
  return context;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const isoDate = (offsetMs: number) => iso(offsetMs).slice(0, 10);

// Synthetic fixtures only.
const DESCRIPTION = [
  "About the role: Example Synthetic Robotics is hiring an analytics engineer for its synthetic platform team.",
  "Responsibilities: you will design data models, build reporting pipelines and coordinate delivery with product squads.",
  "Requirements: experience with SQL, Python, cloud warehouses and clear written communication with stakeholders.",
].join("\n");

function linkedInItem(jobId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: `Synthetic Analytics Engineer ${jobId.slice(-3)}`,
    company: "Example Synthetic Robotics",
    url: `https://www.linkedin.com/jobs/view/${jobId}/`,
    description: DESCRIPTION,
    descriptionStatus: "OK",
    location: null,
    linkedinJobId: jobId,
    exportedAt: iso(-2 * HOUR),
    sourcePage: "https://www.linkedin.com/jobs-tracker/",
    ...overrides,
  };
}

async function importLinkedIn(items: unknown[]): Promise<string[]> {
  const report = await importLinkedInSavedJobs(db(), ctx(), parseLinkedInSavedExport(items), { dryRun: false, plugin: linkedInPlugin as SourcePlugin });
  const ids = report.items.map((item) => item.observationId).filter((id): id is string => typeof id === "string");
  expect(ids).toHaveLength(items.length);
  return ids;
}

async function normalizeAndDecide(observationIds: string[]): Promise<Map<string, { canonicalJobId: string; jobVersionId: string }>> {
  const normalized = await runNormalization(db(), { context: ctx(), observationIds, limit: observationIds.length });
  expect(normalized.totalErrors).toBe(0);
  const { rows } = await db().query<{ observation_id: string; canonical_job_id: string; job_version_id: string }>(
    `SELECT observation.id::text AS observation_id, version.canonical_job_id::text AS canonical_job_id, version.id::text AS job_version_id
     FROM raw_job_observations observation JOIN job_versions version ON version.id = observation.job_version_id
     WHERE observation.workspace_id = $1 AND observation.id = ANY($2::uuid[])`,
    [ctx().workspaceId, observationIds],
  );
  const decided = await runRecommendationDecider(db(), { context: ctx(), canonicalJobIds: rows.map((row) => row.canonical_job_id) });
  expect(decided.errors).toBe(0);
  return new Map(rows.map((row) => [row.observation_id, { canonicalJobId: row.canonical_job_id, jobVersionId: row.job_version_id }]));
}

async function readiness(canonicalJobId: string): Promise<{ AVAILABILITY: string; FRESHNESS: string }> {
  const { rows } = await db().query<{ readiness_json: { checks: Array<{ key: string; status: string }> } }>(
    `SELECT readiness_json FROM deterministic_decisions
     WHERE workspace_id = $1 AND canonical_job_id = $2::uuid
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [ctx().workspaceId, canonicalJobId],
  );
  const checks = rows[0]?.readiness_json.checks ?? [];
  const status = (key: string) => checks.find((check) => check.key === key)?.status ?? "MISSING";
  return { AVAILABILITY: status("AVAILABILITY"), FRESHNESS: status("FRESHNESS") };
}

async function version(jobVersionId: string) {
  const { rows } = await db().query<{
    source_published_at: Date | null;
    reposted_at: Date | null;
    source_expires_at: Date | null;
    freshness_basis: string | null;
    availability_status: string | null;
    availability_verified_at: Date | null;
    availability_recheck_at: Date | null;
  }>(
    `SELECT source_published_at, reposted_at, source_expires_at, freshness_basis,
            availability_status, availability_verified_at, availability_recheck_at
     FROM job_versions WHERE id = $1::uuid`,
    [jobVersionId],
  );
  const row = rows[0];
  if (!row) throw new Error("job version not found");
  return row;
}

async function observationCount(): Promise<number> {
  const { rows } = await db().query<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM raw_job_observations WHERE workspace_id = $1",
    [ctx().workspaceId],
  );
  return rows[0]?.count ?? 0;
}

describe.skipIf(skipReal)("saved-jobs posting facts -> readiness (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `saved_posting_facts_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
    linkedInPlugin = (await loadStructuredFile(path.resolve(process.cwd(), "config", "source-plugins", "linkedin_saved.yml"), SourcePluginSchema)).data;
    mcfPlugin = (await loadStructuredFile(path.resolve(process.cwd(), "config", "source-plugins", "mcf_saved.yml"), SourcePluginSchema)).data;
    await saveWorkspacePreferenceRevision(client, context, {
      preferenceDomain: "stage3",
      schemaVersion: "3.0.0",
      activate: true,
      preferenceValue: {
        schema_version: "3.0.0",
        freshness: { max_posting_age_days: 60, stale_gate_disposition: "HARD_REJECT" },
      },
    });
  }, 120_000);

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  it("re-enriches a saved job imported without posting facts onto the same job version, idempotently", async () => {
    // The production state: an earlier export without dates or status.
    const [legacyObservationId] = await importLinkedIn([linkedInItem("4300000201")]);
    const first = await normalizeAndDecide([legacyObservationId as string]);
    const target = first.get(legacyObservationId as string);
    if (!target) throw new Error("legacy saved job was not normalized");
    expect(await version(target.jobVersionId)).toMatchObject({ source_published_at: null, availability_verified_at: null });
    expect(await readiness(target.canonicalJobId)).toEqual({ AVAILABILITY: "NEEDS_VERIFICATION", FRESHNESS: "NEEDS_VERIFICATION" });

    // The re-export: same job with a different (re-fetched) description, plus posting facts.
    const checkedAt = iso(-HOUR);
    const reExport = [
      { ...linkedInItem("4300000201"), description: `${DESCRIPTION}\nRe-fetched text.`, postedAtText: "2 weeks ago", availabilityStatus: "OPEN", availabilityEvidence: "Apply button shown", postingCheckedAt: checkedAt },
      { ...linkedInItem("4300000299"), postedAtText: "1 week ago", availabilityStatus: "OPEN", postingCheckedAt: checkedAt },
      // An enrichment item without any posting fact is reported and left alone.
      { url: "https://www.linkedin.com/jobs/view/4300000298/" },
    ];

    const before = await observationCount();
    const dryPlan = await planLinkedInSavedEnrichment(db(), ctx(), reExport);
    const dry = await runLinkedInSavedEnrichment(db(), ctx(), dryPlan, { dryRun: true, plugin: linkedInPlugin as SourcePlugin });
    expect(dry.items.map((item) => item.outcome)).toEqual(["WOULD_STAGE", "NOT_PREVIOUSLY_IMPORTED", "NO_POSTING_FACTS"]);
    expect(dry.items[0]).toMatchObject({ descriptionDiffers: true, facts: { published: "RELATIVE_SOURCE_TEXT", availability: "OPEN" } });
    expect(await observationCount()).toBe(before);

    const applied = await runLinkedInSavedEnrichment(db(), ctx(), await planLinkedInSavedEnrichment(db(), ctx(), reExport), { dryRun: false, plugin: linkedInPlugin as SourcePlugin });
    expect(linkedInSavedEnrichmentExitCode(applied)).toBe(0);
    expect(applied.items[0]).toMatchObject({
      outcome: "STAGED",
      canonicalJobId: target.canonicalJobId,
      readiness: { availability: "MET", freshness: "MET" },
    });
    expect(applied.normalizationErrors).toBe(0);
    expect(await observationCount()).toBe(before + 1);

    // The new observation is appended, the stored description is kept, and the existing version is updated.
    const appended = await db().query<{ job_version_id: string; description_raw: string; count: number }>(
      `SELECT job_version_id::text AS job_version_id, description_raw, COUNT(*) OVER ()::int AS count
       FROM raw_job_observations WHERE workspace_id = $1 AND source_external_id = 'linkedin-job:4300000201'`,
      [ctx().workspaceId],
    );
    expect(appended.rows[0]?.count).toBe(2);
    for (const row of appended.rows) {
      expect(row.job_version_id).toBe(target.jobVersionId);
      expect(row.description_raw).toBe(DESCRIPTION);
    }
    const updated = await version(target.jobVersionId);
    expect(updated.source_published_at?.toISOString()).toBe(new Date(new Date(checkedAt).getTime() - 14 * DAY).toISOString());
    // The date came from "2 weeks ago": stored as the newest possible date with an approximate basis.
    expect(updated).toMatchObject({ freshness_basis: "POSTED_AT_APPROXIMATE_WEEK", availability_status: "OPEN" });
    expect(updated.availability_verified_at?.toISOString()).toBe(checkedAt);
    expect(updated.availability_recheck_at?.toISOString()).toBe(new Date(new Date(checkedAt).getTime() + DAY).toISOString());
    expect(await readiness(target.canonicalJobId)).toEqual({ AVAILABILITY: "MET", FRESHNESS: "MET" });

    // Same file again: nothing new is staged.
    const again = await runLinkedInSavedEnrichment(db(), ctx(), await planLinkedInSavedEnrichment(db(), ctx(), reExport), { dryRun: false, plugin: linkedInPlugin as SourcePlugin });
    expect(again.items[0]?.outcome).toBe("ALREADY_ENRICHED");
    expect(await observationCount()).toBe(before + 1);
  });

  it("blocks availability for a saved job whose posting page showed the closed banner", async () => {
    const [observationId] = await importLinkedIn([linkedInItem("4300000202", {
      postedAtText: "3 days ago",
      availabilityStatus: "CLOSED",
      availabilityEvidence: "No longer accepting applications",
      postingCheckedAt: iso(-HOUR),
    })]);
    const target = (await normalizeAndDecide([observationId as string])).get(observationId as string);
    if (!target) throw new Error("closed saved job was not normalized");
    expect((await version(target.jobVersionId)).availability_status).toBe("CLOSED");
    expect(await readiness(target.canonicalJobId)).toEqual({ AVAILABILITY: "BLOCKED", FRESHNESS: "MET" });
  });

  it("keeps freshness unverified when an approximate age straddles the limit, and stale only past it", async () => {
    // "8 weeks ago" means 56-62 days against the 60-day limit; "9 weeks ago" is at least 63.
    const [straddleId, staleId] = await importLinkedIn([
      linkedInItem("4300000204", { postedAtText: "8 weeks ago", availabilityStatus: "OPEN", postingCheckedAt: iso(-HOUR) }),
      linkedInItem("4300000205", { postedAtText: "9 weeks ago", availabilityStatus: "OPEN", postingCheckedAt: iso(-HOUR) }),
    ]);
    const mapped = await normalizeAndDecide([straddleId as string, staleId as string]);
    const straddle = mapped.get(straddleId as string);
    const stale = mapped.get(staleId as string);
    if (!straddle || !stale) throw new Error("approximate saved jobs were not normalized");
    expect((await version(straddle.jobVersionId)).freshness_basis).toBe("POSTED_AT_APPROXIMATE_WEEK");
    expect(await readiness(straddle.canonicalJobId)).toEqual({ AVAILABILITY: "MET", FRESHNESS: "NEEDS_VERIFICATION" });
    expect(await readiness(stale.canonicalJobId)).toEqual({ AVAILABILITY: "MET", FRESHNESS: "BLOCKED" });
  });

  it("blocks freshness for a stale posting date and leaves an expired check unverified", async () => {
    const [observationId] = await importLinkedIn([linkedInItem("4300000203", {
      postedAt: iso(-120 * DAY),
      availabilityStatus: "OPEN",
      postingCheckedAt: iso(-3 * DAY),
      exportedAt: iso(-3 * DAY),
    })]);
    const target = (await normalizeAndDecide([observationId as string])).get(observationId as string);
    if (!target) throw new Error("stale saved job was not normalized");
    // The open status was read three days ago: past its one-day window.
    expect(await readiness(target.canonicalJobId)).toEqual({ AVAILABILITY: "NEEDS_VERIFICATION", FRESHNESS: "BLOCKED" });
  });

  it("persists MyCareersFuture dates and status to the job version and blocks a passed expiry", async () => {
    const UUID_OPEN = "0123456789abcdef0123456789abc001";
    const UUID_EXPIRED = "0123456789abcdef0123456789abc002";
    const mcfItem = (uuid: string, overrides: Record<string, unknown>) => ({
      title: `Synthetic Data Engineer ${uuid.slice(-3)}`,
      company: "EXAMPLE SYNTHETIC ANALYTICS PTE. LTD.",
      url: `https://www.mycareersfuture.gov.sg/job/information-technology/synthetic-data-engineer-${uuid}`,
      description: DESCRIPTION,
      descriptionStatus: "OK",
      location: null,
      salary: null,
      employmentType: "Permanent",
      mcfJobUuid: uuid,
      exportedAt: iso(-HOUR),
      sourcePage: "https://www.mycareersfuture.gov.sg/saved-jobs",
      ...overrides,
    });
    const report = await importMcfSavedJobs(db(), ctx(), parseMcfSavedExport([
      mcfItem(UUID_OPEN, { postedAt: isoDate(-5 * DAY), expiresAt: isoDate(25 * DAY), availabilityStatus: "OPEN", availabilityEvidence: "MyCareersFuture job status: Open", postingCheckedAt: iso(-HOUR) }),
      // An older export: dates only, the deadline already passed.
      mcfItem(UUID_EXPIRED, { postedAt: isoDate(-40 * DAY), expiresAt: isoDate(-2 * DAY) }),
    ]), { dryRun: false, plugin: mcfPlugin as SourcePlugin });
    const ids = report.items.map((item) => item.observationId as string);
    const mapped = await normalizeAndDecide(ids);
    const open = mapped.get(ids[0] as string);
    const expired = mapped.get(ids[1] as string);
    if (!open || !expired) throw new Error("MCF saved jobs were not normalized");

    const openVersion = await version(open.jobVersionId);
    expect(openVersion.source_published_at?.toISOString()).toBe(`${isoDate(-5 * DAY)}T00:00:00.000Z`);
    expect(openVersion.source_expires_at?.toISOString()).toBe(`${isoDate(25 * DAY)}T00:00:00.000Z`);
    expect(openVersion.availability_status).toBe("OPEN");
    expect(await readiness(open.canonicalJobId)).toEqual({ AVAILABILITY: "MET", FRESHNESS: "MET" });

    expect((await version(expired.jobVersionId)).source_expires_at?.toISOString()).toBe(`${isoDate(-2 * DAY)}T00:00:00.000Z`);
    expect(await readiness(expired.canonicalJobId)).toEqual({ AVAILABILITY: "BLOCKED", FRESHNESS: "MET" });
  });
});
