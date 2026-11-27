import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { rankingIntegrityExitCode, reportRankingIntegrity, summarizeScorePolicies } from "../../pipeline/rankingIntegrity.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

// Migration 121: one stored adjusted score (canonical_jobs.recommendation_requirement_score) that every list orders by,
// the role-shape evidence next to it, and the must-be-zero checks on it. Synthetic jobs only.
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the ranking read model integration tests against its PostgreSQL service.");
}

const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), "utf8");

describe("no list orders by the raw match score (static)", () => {
  it("the Top 10 materializer ranks on the stored adjusted score", () => {
    const source = read("src/services/applicationRankingMaterializer.ts");
    expect(source).toContain("requirementFit: adjustedScoreToPercent(row.recommendation_requirement_score)");
    expect(source).not.toMatch(/requirementFit:\s*toFiniteNumber\(row\.deterministic_match_score\)/);
  });

  it("the review-sheet script orders and filters by the stored adjusted score", () => {
    // The pool query moved from the script into src/reporting/blindReviewPool.ts (the function owns the query).
    const source = read("src/reporting/blindReviewPool.ts") + read("scripts/experiments/blind_review_set.ts");
    expect(source).toContain("(cj.recommendation_requirement_score * 100)::float AS score");
    expect(source).toContain("ORDER BY score DESC");
    expect(source).not.toMatch(/ORDER BY[^`]*deterministic_match_score/);
    expect(source).not.toMatch(/deterministic_match_score/);
  });

  it("Streamlit lists order by the stored adjusted score, never by the raw score", () => {
    const source = read("streamlit_app.py");
    const orderByClauses = [...source.matchAll(/ORDER BY([^"]*?)(?:\n\s*"""|LIMIT|\n\s*\)|$)/gim)].map((match) => match[1] ?? "");
    expect(orderByClauses.filter((clause) => /deterministic_match_score|raw_match_score/.test(clause))).toEqual([]);
    for (const name of ["APPLY_NOW_JOBS_QUERY", "VERIFY_THEN_APPLY_JOBS_QUERY", "REVIEW_JOBS_QUERY", "TRACK_JOBS_QUERY"]) {
      const query = new RegExp(`${name}\\s*=\\s*"""([\\s\\S]*?)"""`).exec(source)?.[1] ?? "";
      expect(query, `${name} reads v_job_ranking_scoped`).toContain("v_job_ranking_scoped");
      expect(query, `${name} orders by ranking_score`).toMatch(/ORDER BY[^"]*ranking_score DESC/i);
    }
  });
});

describe("every UPDATE that clears the stored score also clears its evidence (static)", () => {
  const STORED = ["recommendation_score_policy", "recommendation_degree_asked_for", "recommendation_role_signals", "recommendation_evidence_confidence"];
  it.each(["src/pipeline/hardGate.ts", "src/pipeline/deterministicMatcher.ts"])("%s clears the four evidence columns wherever it clears the adjusted score", (file) => {
    const source = read(file);
    const clears = source.match(/recommendation_requirement_score = CASE WHEN [^\n]*THEN NULL/g) ?? [];
    expect(clears.length).toBeGreaterThan(0);
    for (const column of STORED) {
      const columnClears = source.match(new RegExp(column + String.raw` = CASE WHEN [^
]*THEN (?:NULL|'\[\]'::jsonb)`, 'g')) ?? [];
      expect(columnClears.length, file + " must clear " + column + " in every UPDATE that clears the score").toBe(clears.length);
    }
  });
});

describe("rankingIntegrity pure helpers", () => {
  it("one policy is fine; a split reports the minority; an even split reports all", () => {
    expect(summarizeScorePolicies([{ policy: "a|r1", count: 5 }]).mixedScorePolicyJobs).toBe(0);
    expect(summarizeScorePolicies([{ policy: "a|r1", count: 5 }, { policy: "b|r1", count: 2 }]).mixedScorePolicyJobs).toBe(2);
    expect(summarizeScorePolicies([{ policy: "a|r1", count: 3 }, { policy: "b|r1", count: 3 }]).mixedScorePolicyJobs).toBe(6);
    expect(summarizeScorePolicies([{ policy: null, count: 4 }]).listedWithoutScorePolicy).toBe(4);
    // Three policies [5, 3, 3]: the majority is the single maximum (5), so 6 jobs are outside it, not all 11.
    expect(summarizeScorePolicies([{ policy: "a", count: 5 }, { policy: "b", count: 3 }, { policy: "c", count: 3 }]).mixedScorePolicyJobs).toBe(6);
    expect(summarizeScorePolicies([{ policy: "a", count: 4 }, { policy: "b", count: 4 }, { policy: "c", count: 1 }]).mixedScorePolicyJobs).toBe(9);
  });

  it("fails the reconciler on any violation and passes a clean report", () => {
    const clean = { listedWithoutAdjustedScore: 0, evidenceWithoutScore: 0, listedWithoutScorePolicy: 0, scorePolicies: {}, mixedScorePolicyJobs: 0 };
    expect(rankingIntegrityExitCode(clean)).toBe(0);
    expect(rankingIntegrityExitCode({ ...clean, listedWithoutAdjustedScore: 1 })).toBe(1);
    expect(rankingIntegrityExitCode({ ...clean, evidenceWithoutScore: 1 })).toBe(1);
    expect(rankingIntegrityExitCode({ ...clean, mixedScorePolicyJobs: 1 })).toBe(1);
    expect(rankingIntegrityExitCode({ ...clean, listedWithoutScorePolicy: 1 })).toBe(1);
  });
});

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let context: WorkspaceContext | undefined;

function db(): pg.PoolClient {
  if (!client) throw new Error("The ranking read model test client is not initialized.");
  return client;
}

async function seedJob(options: {
  title: string;
  outcome: string;
  adjusted: number | null;
  raw: number | null;
  policy?: string | null;
  decision?: boolean;
  degree?: string | null;
  signals?: unknown[];
  confidence?: string | null;
}): Promise<string> {
  const id = crypto.randomUUID();
  await db().query(
    `INSERT INTO canonical_jobs (id, workspace_id, company_name, normalized_title, canonical_url, is_test_fixture,
                                 recommendation_outcome, recommendation_requirement_score, deterministic_match_score,
                                 recommendation_score_policy, recommendation_degree_asked_for, recommendation_role_signals,
                                 recommendation_evidence_confidence)
     VALUES ($1, $2, 'Fixture Co', $3, $4, FALSE, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
    [id, context!.workspaceId, options.title, `https://example.invalid/${id}`, options.outcome, options.adjusted, options.raw,
      options.policy ?? null, options.degree ?? null, JSON.stringify(options.signals ?? []), options.confidence ?? null],
  );
  if (options.decision) {
    const version = crypto.randomUUID();
    await db().query(
      `INSERT INTO job_versions (id, workspace_id, canonical_job_id, content_hash, description_text) VALUES ($1, $2, $3, $4, 'fixture')`,
      [version, context!.workspaceId, id, `hash-${version}`],
    );
    await db().query(`UPDATE canonical_jobs SET latest_job_version_id = $2 WHERE id = $1`, [id, version]);
    const snapshot = await db().query<{ id: string }>(
      `INSERT INTO workspace_policy_snapshots (workspace_id, snapshot_hash, resolved_snapshot) VALUES ($1, $2, '{}'::jsonb) RETURNING id`,
      [context!.workspaceId, `snap-${id}`],
    );
    const decision = await db().query<{ id: string }>(
      `INSERT INTO deterministic_decisions (workspace_id, canonical_job_id, job_version_id, policy_snapshot_id, decision_hash, decision_json,
                                            recommendation_eligibility, recommendation_outcome)
       VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, 'ELIGIBLE', $6) RETURNING id`,
      [context!.workspaceId, id, version, snapshot.rows[0].id, `decision-${id}`, options.outcome],
    );
    await db().query(`UPDATE canonical_jobs SET latest_deterministic_decision_id = $2 WHERE id = $1`, [id, decision.rows[0].id]);
  }
  return id;
}

describe.skipIf(skipReal)("ranking read model, ordering consistency, must-be-zero checks and rollback (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    const schemaName = `ranking_read_${crypto.randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
  }, 60_000);

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  it("exposes the stored adjusted score as ranking_score, the raw score beside it, and the evidence columns", async () => {
    const id = await seedJob({
      title: "Research Scientist", outcome: "REVIEW", adjusted: 0.658, raw: 70, policy: "m1|role_shape_v1",
      degree: "A doctoral degree is required.", signals: [{ code: "DEGREE_GAP_FLAGGED", penalty: 0.06, source: "DESCRIPTION", quote: "A doctoral degree is required." }],
      confidence: "LOW",
    });
    const row = (await db().query(`SELECT * FROM v_job_ranking_scoped WHERE canonical_job_id = $1`, [id])).rows[0];
    expect(Number(row.ranking_score)).toBeCloseTo(0.658, 3);
    expect(Number(row.raw_match_score)).toBe(70);
    expect(row).toMatchObject({ score_policy: "m1|role_shape_v1", degree_asked_for: "A doctoral degree is required.", evidence_confidence: "LOW" });
    expect(row.role_signals).toEqual([expect.objectContaining({ code: "DEGREE_GAP_FLAGGED", penalty: 0.06 })]);
  });

  it("every list orders the same jobs the same way: by ranking_score, which can differ from the raw order", async () => {
    // The adjusted order reverses the raw order for these two jobs.
    const highRaw = await seedJob({ title: "High Raw, Penalised", outcome: "REVIEW", adjusted: 0.6, raw: 75, policy: "m1|role_shape_v1" });
    const lowRaw = await seedJob({ title: "Lower Raw, Clean", outcome: "REVIEW", adjusted: 0.7, raw: 70, policy: "m1|role_shape_v1" });
    const ids = [highRaw, lowRaw];
    const byView = await db().query(`SELECT canonical_job_id FROM v_job_ranking_scoped WHERE canonical_job_id = ANY($1::uuid[]) ORDER BY ranking_score DESC, canonical_job_id`, [ids]);
    const byReviewSheet = await db().query(`SELECT id AS canonical_job_id FROM canonical_jobs cj WHERE id = ANY($1::uuid[]) AND cj.recommendation_requirement_score IS NOT NULL ORDER BY cj.recommendation_requirement_score DESC, cj.id`, [ids]);
    expect(byView.rows.map((r) => r.canonical_job_id)).toEqual([lowRaw, highRaw]);
    expect(byReviewSheet.rows.map((r) => r.canonical_job_id)).toEqual(byView.rows.map((r) => r.canonical_job_id));
    const rawOrder = await db().query(`SELECT canonical_job_id FROM v_job_ranking_scoped WHERE canonical_job_id = ANY($1::uuid[]) ORDER BY raw_match_score DESC`, [ids]);
    expect(rawOrder.rows.map((r) => r.canonical_job_id)).toEqual([highRaw, lowRaw]); // proves the two orders differ, so the check above is not vacuous
  });

  it("reconciler check: a listed job with a decision and no adjusted score is counted; a TRACK job with no score is not", async () => {
    const before = await reportRankingIntegrity(db(), context!.workspaceId);
    await seedJob({ title: "Listed, No Score", outcome: "REVIEW", adjusted: null, raw: null, decision: true });
    await seedJob({ title: "Track, No Score", outcome: "TRACK", adjusted: null, raw: null, decision: true });
    const after = await reportRankingIntegrity(db(), context!.workspaceId);
    expect(after.listedWithoutAdjustedScore).toBe(before.listedWithoutAdjustedScore + 1);
    expect(rankingIntegrityExitCode(after)).toBe(1);
  });

  it("reconciler check: a job with no adjusted score that still holds role evidence is counted", async () => {
    const before = await reportRankingIntegrity(db(), context!.workspaceId);
    await seedJob({ title: "Cleared Score, Stale Evidence", outcome: "TRACK", adjusted: null, raw: null, policy: "m1|role_shape_v1", signals: [{ code: "CONTRACT_EMPLOYMENT", penalty: 0.05, source: "TITLE", quote: "x" }] });
    const after = await reportRankingIntegrity(db(), context!.workspaceId);
    expect(after.evidenceWithoutScore).toBe(before.evidenceWithoutScore + 1);
    expect(rankingIntegrityExitCode(after)).toBe(1);
  });

  it("reconciler check: listed jobs on two score policies are reported", async () => {
    await seedJob({ title: "Other Policy", outcome: "REVIEW", adjusted: 0.5, raw: 55, policy: "legacy|role_shape_v1" });
    const report = await reportRankingIntegrity(db(), context!.workspaceId);
    expect(Object.keys(report.scorePolicies).length).toBeGreaterThan(1);
    expect(report.mixedScorePolicyJobs).toBeGreaterThan(0);
  });

  it("the documented rollback drops the view and the four columns", async () => {
    const migration = fs.readFileSync(path.resolve(process.cwd(), "migrations/121_ranking_read_model.sql"), "utf8");
    const rollback = migration.slice(migration.indexOf("-- Rollback (exact"), migration.indexOf("ALTER TABLE canonical_jobs\n  ADD COLUMN"));
    const statements = rollback
      .split("\n")
      .filter((line) => line.startsWith("--   "))
      .map((line) => line.slice(5))
      .join("\n")
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean);
    expect(statements.length).toBe(3);
    for (const statement of statements) await db().query(statement);
    const deciderColumn = await db().query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'deterministic_decisions' AND column_name = 'decider_version'`,
    );
    expect(deciderColumn.rows).toEqual([]);
    const view = await db().query(`SELECT to_regclass(current_schema() || '.v_job_ranking_scoped') AS name`);
    expect(view.rows[0].name).toBeNull();
    const columns = await db().query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'canonical_jobs' AND column_name LIKE 'recommendation_%'
          AND column_name IN ('recommendation_score_policy', 'recommendation_degree_asked_for', 'recommendation_role_signals', 'recommendation_evidence_confidence')`,
    );
    expect(columns.rows).toEqual([]);
  });
});
