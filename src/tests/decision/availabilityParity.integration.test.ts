import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import pg from "pg";

import { assessAvailability, type AvailabilityStatus } from "../../decision/availability.js";
import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

// The rule "is this posting currently open" exists in TypeScript (src/decision/availability.ts)
// and in SQL (v_job_availability_current, migration 114). This test runs the same cases through
// both and fails on any difference. Fixtures are synthetic.
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface Case {
  readonly name: string;
  readonly status: AvailabilityStatus | null;
  /** Offsets from now, in ms; null = column empty. */
  readonly verifiedOffset: number | null;
  readonly recheckOffset: number | null;
  readonly sourceExpiresOffset: number | null;
  readonly expectState: "OPEN" | "CLOSED" | "UNKNOWN";
}

const CASES: readonly Case[] = [
  { name: "open and current", status: "OPEN", verifiedOffset: -DAY, recheckOffset: 3 * DAY, sourceExpiresOffset: null, expectState: "OPEN" },
  { name: "open but the window ran out", status: "OPEN", verifiedOffset: -8 * DAY, recheckOffset: -HOUR, sourceExpiresOffset: null, expectState: "UNKNOWN" },
  { name: "closed with a valid window", status: "CLOSED", verifiedOffset: -DAY, recheckOffset: 3 * DAY, sourceExpiresOffset: null, expectState: "CLOSED" },
  { name: "status unknown", status: "UNKNOWN", verifiedOffset: -DAY, recheckOffset: 3 * DAY, sourceExpiresOffset: null, expectState: "UNKNOWN" },
  { name: "status missing", status: null, verifiedOffset: null, recheckOffset: null, sourceExpiresOffset: null, expectState: "UNKNOWN" },
  { name: "open without a verified time", status: "OPEN", verifiedOffset: null, recheckOffset: 3 * DAY, sourceExpiresOffset: null, expectState: "UNKNOWN" },
  { name: "open without a window end", status: "OPEN", verifiedOffset: -DAY, recheckOffset: null, sourceExpiresOffset: null, expectState: "UNKNOWN" },
  { name: "open and current but the source expiry has passed", status: "OPEN", verifiedOffset: -DAY, recheckOffset: 3 * DAY, sourceExpiresOffset: -HOUR, expectState: "CLOSED" },
  { name: "open and current with a future source expiry", status: "OPEN", verifiedOffset: -DAY, recheckOffset: 3 * DAY, sourceExpiresOffset: 5 * DAY, expectState: "OPEN" },
];

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let context: WorkspaceContext | undefined;

function db(): pg.PoolClient {
  if (!client) throw new Error("The availability parity test client is not initialized.");
  return client;
}

describe("assessAvailability (pure rule)", () => {
  const now = new Date();
  for (const testCase of CASES) {
    it(`${testCase.name} -> ${testCase.expectState}`, () => {
      const at = (offset: number | null) => (offset === null ? null : new Date(now.getTime() + offset));
      const result = assessAvailability({
        status: testCase.status,
        verifiedAt: at(testCase.verifiedOffset),
        expiresAt: at(testCase.recheckOffset),
        sourceExpiresAt: at(testCase.sourceExpiresOffset),
      }, now);
      expect(result.state).toBe(testCase.expectState);
      expect(result.current).toBe(testCase.expectState === "OPEN");
    });
  }

  it("treats an unparseable date as missing, never as open", () => {
    const result = assessAvailability({ status: "OPEN", verifiedAt: "not a date", expiresAt: "2099-01-01T00:00:00Z" }, new Date());
    expect(result.state).toBe("UNKNOWN");
  });
});

describe.skipIf(skipReal)("availability rule: TypeScript and v_job_availability_current agree (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    const schemaName = `availability_parity_${crypto.randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
  });

  afterAll(async () => {
    client?.release();
    await pool?.end();
  });

  it("gives the same state and current flag for every case", async () => {
    const database = db();
    const workspaceId = context!.workspaceId;
    const now = new Date();
    for (const testCase of CASES) {
      const canonical = await database.query<{ id: string }>(
        `INSERT INTO canonical_jobs (workspace_id, company_name, normalized_title, canonical_url)
         VALUES ($1, 'Parity Fixture Co', $2, $3) RETURNING id`,
        [workspaceId, testCase.name, `https://example.test/parity/${crypto.randomUUID()}`],
      );
      const canonicalJobId = canonical.rows[0]!.id;
      const version = await database.query<{ id: string }>(
        `INSERT INTO job_versions (
           workspace_id, canonical_job_id, version_number, content_hash, description_text, observed_at,
           availability_status, availability_verified_at, availability_recheck_at, source_expires_at
         ) VALUES ($1, $2, 1, $3, 'Synthetic parity fixture.', NOW(), $4,
           CASE WHEN $5::bigint IS NULL THEN NULL ELSE NOW() + ($5::bigint * INTERVAL '1 millisecond') END,
           CASE WHEN $6::bigint IS NULL THEN NULL ELSE NOW() + ($6::bigint * INTERVAL '1 millisecond') END,
           CASE WHEN $7::bigint IS NULL THEN NULL ELSE NOW() + ($7::bigint * INTERVAL '1 millisecond') END)
         RETURNING id, availability_verified_at, availability_recheck_at, source_expires_at`,
        [workspaceId, canonicalJobId, `parity-${crypto.randomUUID()}`, testCase.status,
          testCase.verifiedOffset, testCase.recheckOffset, testCase.sourceExpiresOffset],
      );
      await database.query(
        `UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE workspace_id = $2 AND id = $3`,
        [version.rows[0]!.id, workspaceId, canonicalJobId],
      );

      const stored = version.rows[0]!;
      const expected = assessAvailability({
        status: testCase.status,
        verifiedAt: stored.availability_verified_at,
        expiresAt: stored.availability_recheck_at,
        sourceExpiresAt: stored.source_expires_at,
      }, now);
      const view = await database.query<{ availability_state: string; availability_current: boolean }>(
        `SELECT availability_state, availability_current FROM v_job_availability_current
         WHERE workspace_id = $1 AND canonical_job_id = $2`,
        [workspaceId, canonicalJobId],
      );
      expect(view.rows, testCase.name).toHaveLength(1);
      expect(view.rows[0]!.availability_state, testCase.name).toBe(expected.state);
      expect(view.rows[0]!.availability_current, testCase.name).toBe(expected.current);
      expect(expected.state, testCase.name).toBe(testCase.expectState);
    }
  });
});
