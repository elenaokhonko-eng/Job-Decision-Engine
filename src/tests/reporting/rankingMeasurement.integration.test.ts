import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { buildMeasurementReport } from "../../reporting/rankingMeasurement.js";
import { loadCandidateJobs, loadSavedObservations } from "../../reporting/rankingMeasurementQueries.js";

// Runs the real measurement SQL against a migrated, disposable local Postgres
// (the CI service or `docker run pgvector/pgvector:pg15`). It refuses any
// non-local URL and rolls back everything it seeds.
const DB_URL = process.env.DATABASE_URL || "";
const enabled = Boolean(DB_URL) && isLocalPostgresConnectionString(DB_URL);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && !enabled) {
  throw new Error("REQUIRE_POSTGRES_INTEGRATION is set but DATABASE_URL is not a local Postgres.");
}

const SOURCE = "LINKEDIN_SAVED";

describe.skipIf(!enabled)("ranking measurement queries (Postgres)", () => {
  let client: pg.Client;
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const archiveRunId = randomUUID();
  let profileVersionId: string;
  let policySnapshotId: string;
  let otherPolicySnapshotId: string;

  beforeAll(async () => {
    client = new pg.Client(pgConnectionConfig(DB_URL));
    await client.connect();
    await client.query("BEGIN");
    for (const [id, key] of [
      [workspaceId, `measure-${workspaceId}`],
      [otherWorkspaceId, `measure-${otherWorkspaceId}`],
    ]) {
      await client.query(`INSERT INTO workspaces (id, workspace_key, display_name) VALUES ($1, $2, 'fixture')`, [id, key]);
    }
    const profile = await client.query<{ id: string }>(
      `INSERT INTO candidate_profiles (workspace_id, profile_key, display_name) VALUES ($1, 'fixture', 'fixture') RETURNING id`,
      [workspaceId],
    );
    const version = await client.query<{ id: string }>(
      `INSERT INTO profile_versions (workspace_id, candidate_profile_id, version_number, source_hash, status)
       VALUES ($1, $2, 1, 'fixture-hash', 'ACTIVE') RETURNING id`,
      [workspaceId, profile.rows[0].id],
    );
    profileVersionId = version.rows[0].id;
    const snapshot = await client.query<{ id: string }>(
      `INSERT INTO workspace_policy_snapshots (workspace_id, snapshot_hash, resolved_snapshot)
       VALUES ($1, 'fixture-snapshot', '{}'::jsonb) RETURNING id`,
      [workspaceId],
    );
    policySnapshotId = snapshot.rows[0].id;
    const otherSnapshot = await client.query<{ id: string }>(
      `INSERT INTO workspace_policy_snapshots (workspace_id, snapshot_hash, resolved_snapshot)
       VALUES ($1, 'fixture-snapshot-other', '{}'::jsonb) RETURNING id`,
      [otherWorkspaceId],
    );
    otherPolicySnapshotId = otherSnapshot.rows[0].id;
    await client.query(
      `INSERT INTO job_archive_runs (id, run_started_at, cutoff_at, mode, status)
       VALUES ($1, NOW(), NOW() - INTERVAL '1 day', 'DRY_RUN', 'SUCCEEDED')`,
      [archiveRunId],
    );
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  });

  interface SeedOptions {
    readonly workspace?: string;
    readonly title: string;
    readonly score: number | null; // null: no completed match run
    readonly outcome?: string; // omit: no decision
    readonly eligibility?: string;
    readonly source?: string; // omit: no observation
    readonly archived?: boolean;
    readonly similarity?: number;
  }

  async function seedJob(options: SeedOptions): Promise<{ jobId: string; observationId: string | null }> {
    const workspace = options.workspace ?? workspaceId;
    const jobId = randomUUID();
    const versionId = randomUUID();
    await client.query(
      `INSERT INTO canonical_jobs (id, workspace_id, company_name, normalized_title, canonical_url, is_test_fixture,
                                   archived_at, archive_run_id, archive_reason, archive_age_basis, archive_reference_at)
       VALUES ($1, $2, 'Fixture Co', $3, $4, TRUE,
               $5::timestamptz,
               CASE WHEN $5::timestamptz IS NULL THEN NULL ELSE $6::uuid END,
               CASE WHEN $5::timestamptz IS NULL THEN NULL ELSE 'fixture archive' END,
               CASE WHEN $5::timestamptz IS NULL THEN NULL ELSE 'HARD_REJECTED_DECISION' END,
               $5::timestamptz)`,
      [jobId, workspace, options.title, `https://example.invalid/${jobId}`, options.archived ? new Date() : null, archiveRunId],
    );
    await client.query(
      `INSERT INTO job_versions (id, workspace_id, canonical_job_id, content_hash, description_text)
       VALUES ($1, $2, $3, $4, 'fixture description')`,
      [versionId, workspace, jobId, `hash-${versionId}`],
    );
    await client.query(`UPDATE canonical_jobs SET latest_job_version_id = $2 WHERE id = $1`, [jobId, versionId]);

    if (options.score !== null) {
      const runId = randomUUID();
      await client.query(
        `INSERT INTO match_runs (id, workspace_id, canonical_job_id, job_version_id, profile_version_id, status,
                                 coverage_score, overall_match_score)
         VALUES ($1, $2, $3, $4, $5, 'COMPLETED', $6, $6)`,
        [runId, workspace, jobId, versionId, profileVersionId, options.score],
      );
      await client.query(`UPDATE canonical_jobs SET latest_match_run_id = $2 WHERE id = $1`, [jobId, runId]);
      if (options.similarity !== undefined) {
        const identity = await client.query<{ id: string }>(
          `INSERT INTO requirement_set_identities (workspace_id, canonical_job_id, identity_hash, job_content_hash,
                                                   deterministic_extractor_version, quoted_extractor_version,
                                                   quoted_prompt_hash, normalizer_hash)
           VALUES ($1, $2, $3, 'h', 'v', 'v', 'p', 'n') RETURNING id`,
          [workspace, jobId, `identity-${jobId}`],
        );
        const set = await client.query<{ id: string }>(
          `INSERT INTO requirement_sets (workspace_id, requirement_identity_id, canonical_job_id, job_version_id,
                                         revision_number, source_type)
           VALUES ($1, $2, $3, $4, 1, 'EXTRACTED') RETURNING id`,
          [workspace, identity.rows[0].id, jobId, versionId],
        );
        const requirement = await client.query<{ id: string }>(
          `INSERT INTO job_requirements (workspace_id, canonical_job_id, job_version_id, requirement_set_id,
                                         requirement_key, requirement_type, importance, requirement_text,
                                         extractor_type, extractor_version, confidence)
           VALUES ($1, $2, $3, $4, 'fixture', 'DOMAIN', 'MUST', 'fixture text', 'DETERMINISTIC', 'v', 1)
           RETURNING id`,
          [workspace, jobId, versionId, set.rows[0].id],
        );
        await client.query(
          `INSERT INTO requirement_evidence_matches (match_run_id, requirement_id, match_type, match_score)
           VALUES ($1, $2, 'SEMANTIC', $3)`,
          [runId, requirement.rows[0].id, options.similarity],
        );
      }
      if (options.outcome) {
        const decisionId = randomUUID();
        await client.query(
          `INSERT INTO deterministic_decisions (id, workspace_id, canonical_job_id, job_version_id, match_run_id,
                                                policy_snapshot_id, decision_hash, decision_json,
                                                recommendation_eligibility, recommendation_outcome)
           VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb, $8, $9)`,
          [
            decisionId,
            workspace,
            jobId,
            versionId,
            runId,
            workspace === workspaceId ? policySnapshotId : otherPolicySnapshotId,
            `decision-${decisionId}`,
            options.eligibility ?? "ELIGIBLE",
            options.outcome,
          ],
        );
        await client.query(`UPDATE canonical_jobs SET latest_deterministic_decision_id = $2 WHERE id = $1`, [jobId, decisionId]);
      }
    }

    let observationId: string | null = null;
    if (options.source) {
      observationId = randomUUID();
      await client.query(
        `INSERT INTO raw_job_observations (id, workspace_id, job_version_id, source_name, company_name, title,
                                           description_raw, raw_payload_hash)
         VALUES ($1, $2, $3, $4, 'Fixture Co', $5, 'fixture', $6)`,
        [observationId, workspace, versionId, options.source, options.title, `payload-${observationId}`],
      );
    }
    return { jobId, observationId };
  }

  it("loads saved observations with exactly one reason each and keeps workspaces apart", async () => {
    const measured = await seedJob({
      title: "Head of AI Governance",
      score: 62,
      outcome: "REVIEW",
      source: SOURCE,
      similarity: 0.7,
    });
    const archived = await seedJob({ title: "Archived Saved Role", score: 40, outcome: "TRACK", source: SOURCE, archived: true });
    const noMatch = await seedJob({ title: "Gated Saved Role", score: null, source: SOURCE });
    const noDecision = await seedJob({ title: "Matched No Decision", score: 30, source: SOURCE });
    await seedJob({ title: "Other Workspace Saved", score: 90, outcome: "PRIORITY", source: SOURCE, workspace: otherWorkspaceId });
    await seedJob({ title: "Not Saved Source", score: 50, outcome: "REVIEW", source: "GMAIL" });

    const rows = await loadSavedObservations(client, workspaceId, SOURCE);
    expect(rows).toHaveLength(4);
    const byObservation = new Map(rows.map((row) => [row.observationId, row]));

    const measuredRow = byObservation.get(measured.observationId!)!;
    expect(measuredRow.jobId).toBe(measured.jobId);
    expect(measuredRow.hasCompletedMatch).toBe(true);
    expect(measuredRow.hasDecision).toBe(true);
    expect(measuredRow.job).toMatchObject({
      matchScore: 62,
      outcome: "REVIEW",
      eligibility: "ELIGIBLE",
      avgSimilarity: 0.7,
    });

    expect(byObservation.get(archived.observationId!)!.jobArchived).toBe(true);
    expect(byObservation.get(noMatch.observationId!)!.hasCompletedMatch).toBe(false);
    expect(byObservation.get(noMatch.observationId!)!.job).toBeNull();
    const noDecisionRow = byObservation.get(noDecision.observationId!)!;
    expect(noDecisionRow.hasCompletedMatch).toBe(true);
    expect(noDecisionRow.hasDecision).toBe(false);

    const report = buildMeasurementReport(rows, []);
    expect(report.exclusionCounts).toMatchObject({
      MEASURED: 1,
      JOB_ARCHIVED: 1,
      NO_COMPLETED_MATCH: 1,
      NO_DECISION: 1,
    });
    expect(Object.values(report.exclusionCounts).reduce((a, b) => a + b, 0)).toBe(rows.length);
  });

  it("loads candidate jobs only when they are complete, current and in this workspace", async () => {
    const complete = await seedJob({ title: "Candidate Complete", score: 20, outcome: "SKIP" });
    await seedJob({ title: "Candidate Archived", score: 20, outcome: "SKIP", archived: true });
    await seedJob({ title: "Candidate No Decision", score: 20 });
    await seedJob({ title: "Candidate Other Workspace", score: 20, outcome: "SKIP", workspace: otherWorkspaceId });

    const candidates = await loadCandidateJobs(client, workspaceId);
    const titles = candidates.map((candidate) => candidate.title);
    expect(titles).toContain("Candidate Complete");
    expect(titles).not.toContain("Candidate Archived");
    expect(titles).not.toContain("Candidate No Decision");
    expect(titles).not.toContain("Candidate Other Workspace");
    expect(candidates.find((candidate) => candidate.jobId === complete.jobId)?.matchScore).toBe(20);
  });

  it("cannot write: the measurement runs inside a READ ONLY transaction in the script", async () => {
    const readOnly = new pg.Client(pgConnectionConfig(DB_URL));
    await readOnly.connect();
    try {
      await readOnly.query("BEGIN READ ONLY");
      await expect(
        readOnly.query(`INSERT INTO workspaces (workspace_key, display_name) VALUES ('should-fail', 'x')`),
      ).rejects.toThrow(/read-only transaction/i);
    } finally {
      await readOnly.query("ROLLBACK").catch(() => undefined);
      await readOnly.end();
    }
  });
});
