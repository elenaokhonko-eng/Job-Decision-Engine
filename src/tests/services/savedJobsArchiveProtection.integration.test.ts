import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { runMigrations } from "../../db/migrate.js";
import { findExpiredSnippetOnlyJobs } from "../../ingestion/snippetExpiry.js";
import {
  archiveJobsAsPostingNotConfirmable,
  readAutomaticArchiveProtection,
  runJobArchive,
} from "../../services/jobArchive.js";

// Owner rule: a job the owner saved (LINKEDIN_SAVED or MCF_SAVED observation) is never archived by an automatic
// rule. Synthetic fixtures only; real PostgreSQL.
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the saved-job archive protection tests against its PostgreSQL service.");
}

const runStartedAt = new Date("2026-10-27T19:15:00.000Z");
const oldDate = "2026-04-01T00:00:00.000Z";
const longDescription = "A hands-on role building and maintaining production systems. ".repeat(8);

let pool: pg.Pool;

async function newWorkspace(): Promise<string> {
  const row = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (workspace_key, display_name) VALUES ($1, 'Saved archive protection') RETURNING id::text`,
    [`saved-archive-${randomUUID()}`],
  );
  return row.rows[0]!.id;
}

async function observation(ws: string, jobVersionId: string, sourceName: string, retrievedAt: string): Promise<void> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO raw_job_observations (id, workspace_id, source_name, source_external_id, source_url, retrieved_at, company_name, title,
       description_raw, raw_payload, raw_payload_hash, processing_status, job_version_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'Saved Fixture Co', 'fixture role', 'Short snippet.', '{}'::jsonb, $7, 'PROCESSED', $8)`,
    [id, ws, sourceName, `o-${id}`, `https://example.test/o/${id}`, retrievedAt, `raw-${id}`, jobVersionId],
  );
}

/** An old job. `sources` are the observation source names (all retrieved long ago). */
async function oldJob(ws: string, sources: readonly string[]): Promise<{ id: string; versionId: string }> {
  const id = randomUUID();
  const versionId = randomUUID();
  await pool.query(
    `INSERT INTO canonical_jobs (id, workspace_id, company_name, normalized_title, canonical_url, processing_state, processing_status, is_test_fixture,
       description_quality_status)
     VALUES ($1, $2, 'Saved Fixture Co', 'fixture role', $3, 'RAW_STAGED', 'RAW_STAGED', FALSE, 'INCOMPLETE')`,
    [id, ws, `https://example.test/saved/${id}`],
  );
  await pool.query(
    `INSERT INTO job_versions (id, workspace_id, canonical_job_id, content_hash, description_text, observed_at, source_published_at, first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, $6)`,
    [versionId, ws, id, `h-${id}`, longDescription, oldDate],
  );
  await pool.query(`UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE id = $2`, [versionId, id]);
  for (const source of sources) await observation(ws, versionId, source, oldDate);
  return { id, versionId };
}

async function archivedAt(id: string): Promise<Date | null> {
  const row = await pool.query<{ archived_at: Date | null }>(`SELECT archived_at FROM canonical_jobs WHERE id = $1`, [id]);
  return row.rows[0]!.archived_at;
}

describe.skipIf(skipReal)("saved jobs are never archived automatically (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    await runMigrations(pool);
  }, 180_000);

  afterAll(async () => {
    await pool.end();
  });

  it("the age rule skips a saved job older than three months (either saved source) and still archives an unsaved control", async () => {
    const ws = await newWorkspace();
    const savedLinkedIn = await oldJob(ws, ["GREENHOUSE", "LINKEDIN_SAVED"]);
    const savedMcf = await oldJob(ws, ["GREENHOUSE", "MCF_SAVED"]);
    const control = await oldJob(ws, ["GREENHOUSE"]);

    const dry = await runJobArchive(pool, { mode: "DRY_RUN", workspaceId: ws, runStartedAt, maxArchives: 10 });
    expect(dry.protected_count).toBe(2);
    expect(dry.eligible_count).toBe(1);

    const applied = await runJobArchive(pool, { mode: "APPLY", workspaceId: ws, runStartedAt, maxArchives: 10 });
    expect(applied.protected_count).toBe(2);
    expect(applied.archived_count).toBe(1);
    expect(await archivedAt(control.id)).not.toBeNull();
    expect(await archivedAt(savedLinkedIn.id)).toBeNull();
    expect(await archivedAt(savedMcf.id)).toBeNull();
  });

  it("the shared protection read reports SAVED_BY_OWNER for a saved job only", async () => {
    const ws = await newWorkspace();
    const saved = await oldJob(ws, ["LINKEDIN_SAVED"]);
    const control = await oldJob(ws, ["GREENHOUSE"]);
    const client = await pool.connect();
    try {
      const now = new Date();
      expect(await readAutomaticArchiveProtection(client, { workspaceId: ws, canonicalJobId: saved.id, now }))
        .toEqual({ protected: true, reasons: ["SAVED_BY_OWNER"] });
      expect(await readAutomaticArchiveProtection(client, { workspaceId: ws, canonicalJobId: control.id, now }))
        .toEqual({ protected: false, reasons: [] });
    } finally {
      client.release();
    }
  });

  it("the not-confirmable archive (snippet expiry, availability re-check, link repair) skips a saved job whatever the caller selected", async () => {
    const ws = await newWorkspace();
    const saved = await oldJob(ws, ["GMAIL_ALERT", "LINKEDIN_SAVED"]);
    const control = await oldJob(ws, ["GMAIL_ALERT"]);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const archived = await archiveJobsAsPostingNotConfirmable(client, {
        workspaceId: ws, canonicalJobIds: [saved.id, control.id], actor: "test:saved", details: { rule: "test" },
      });
      await client.query("COMMIT");
      expect(archived).toEqual([control.id]);
    } finally {
      client.release();
    }
    expect(await archivedAt(saved.id)).toBeNull();
    expect(await archivedAt(control.id)).not.toBeNull();
  });

  it("snippet expiry: a saved snippet-only job is not a candidate, a plain snippet-only job is", async () => {
    const ws = await newWorkspace();
    const saved = await oldJob(ws, ["GMAIL_ALERT", "LINKEDIN_SAVED"]);
    const control = await oldJob(ws, ["GMAIL_ALERT"]);
    const client = await pool.connect();
    try {
      const found = await findExpiredSnippetOnlyJobs(client, { workspaceId: ws, now: runStartedAt });
      const ids = found.filter((candidate) => !candidate.protected).map((candidate) => candidate.canonicalJobId);
      expect(ids).toEqual([control.id]);
      expect(found.some((candidate) => candidate.canonicalJobId === saved.id && !candidate.protected)).toBe(false);
    } finally {
      client.release();
    }
  });
});
