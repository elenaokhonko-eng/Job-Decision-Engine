import { fileURLToPath } from "node:url";

import pg from "pg";
import dotenv from "dotenv";

import { runEmbeddingBatchWithFallback } from "../src/embeddings/batchCoordinator.js";
import { isPooledPostgresConnectionString, pgPoolConfig } from "../src/db/pgSsl.js";
import { runHardGates } from "../src/pipeline/hardGate.js";
import { runLaneRouting } from "../src/pipeline/laneRouter.js";
import { runPipelineStageTaskWorker } from "../src/tasks/stageTaskWorker.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../src/workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

interface RecoveryLimits {
  policyNoMatch: number;
  technicalDeferred: number;
  workAuth: number;
  rawStaged: number;
}

interface RecoveryCandidates {
  policyNoMatch: Array<{ canonicalJobId: string; jobVersionId: string }>;
  technicalDeferred: Array<{ canonicalJobId: string; jobVersionId: string }>;
  workAuth: Array<{ canonicalJobId: string; jobVersionId: string }>;
  rawStaged: number;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv: readonly string[]): { apply: boolean; limits: RecoveryLimits } {
  return {
    apply: argv.includes("--apply"),
    limits: {
      policyNoMatch: parsePositiveInt(process.env.ZERO_MANUAL_POLICY_NO_MATCH_LIMIT, 200),
      technicalDeferred: parsePositiveInt(process.env.ZERO_MANUAL_TECHNICAL_LIMIT, 50),
      workAuth: parsePositiveInt(process.env.ZERO_MANUAL_WORK_AUTH_LIMIT, 50),
      rawStaged: parsePositiveInt(process.env.ZERO_MANUAL_RAW_LIMIT, 100),
    },
  };
}

export async function listRecoveryCandidates(
  client: pg.PoolClient,
  ctx: WorkspaceContext,
  limits: RecoveryLimits,
): Promise<RecoveryCandidates> {
  // A pg client executes one statement at a time; keep the bounded discovery
  // queries sequential rather than issuing concurrent queries on one session.
  const policyNoMatch = await client.query<{ canonical_job_id: string; job_version_id: string }>(
    `SELECT id AS canonical_job_id, latest_job_version_id AS job_version_id
     FROM canonical_jobs
     WHERE workspace_id = $1
       AND is_test_fixture = FALSE
       AND COALESCE(processing_state, processing_status) = 'ROUTING_DEFERRED'
       AND routing_disposition = 'POLICY_NO_MATCH'
       AND latest_job_version_id IS NOT NULL
     ORDER BY updated_at ASC, id ASC
     LIMIT $2`,
    [ctx.workspaceId, limits.policyNoMatch],
  );
  const technicalDeferred = await client.query<{ canonical_job_id: string; job_version_id: string }>(
    `SELECT id AS canonical_job_id, latest_job_version_id AS job_version_id
     FROM canonical_jobs
     WHERE workspace_id = $1
       AND is_test_fixture = FALSE
       AND COALESCE(processing_state, processing_status) = 'ROUTING_DEFERRED'
       AND routing_disposition = 'TECHNICAL_DEFERRED'
       AND latest_job_version_id IS NOT NULL
     ORDER BY updated_at ASC, id ASC
     LIMIT $2`,
    [ctx.workspaceId, limits.technicalDeferred],
  );
  const workAuth = await client.query<{ canonical_job_id: string; job_version_id: string }>(
    `WITH latest_gates AS (
       SELECT DISTINCT ON (canonical_job_id, job_version_id)
         canonical_job_id,
         job_version_id,
         rejection_codes
       FROM gate_decisions
       WHERE workspace_id = $1
       ORDER BY canonical_job_id, job_version_id, created_at DESC, id DESC
     )
     SELECT c.id AS canonical_job_id, c.latest_job_version_id AS job_version_id
     FROM canonical_jobs c
     JOIN latest_gates gate
       ON gate.canonical_job_id = c.id
      AND gate.job_version_id = c.latest_job_version_id
     WHERE c.workspace_id = $1
       AND c.is_test_fixture = FALSE
       AND COALESCE(c.processing_state, c.processing_status) = 'NEEDS_VERIFICATION'
       AND gate.rejection_codes @> '["NEEDS_VERIFICATION_WORK_AUTH"]'::jsonb
       AND c.latest_job_version_id IS NOT NULL
     ORDER BY c.updated_at ASC, c.id ASC
     LIMIT $2`,
    [ctx.workspaceId, limits.workAuth],
  );
  const rawStaged = await client.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
     FROM canonical_jobs
     WHERE workspace_id = $1
       AND is_test_fixture = FALSE
       AND COALESCE(processing_state, processing_status) = 'RAW_STAGED'`,
    [ctx.workspaceId],
  );

  const normalizeJobRows = (rows: Array<{ canonical_job_id: string; job_version_id: string }>) =>
    rows.map((row) => ({
      canonicalJobId: row.canonical_job_id,
      jobVersionId: row.job_version_id,
    }));

  return {
    policyNoMatch: normalizeJobRows(policyNoMatch.rows),
    technicalDeferred: normalizeJobRows(technicalDeferred.rows),
    workAuth: normalizeJobRows(workAuth.rows),
    rawStaged: Math.min(rawStaged.rows[0]?.count ?? 0, limits.rawStaged),
  };
}

async function stateDistribution(client: pg.PoolClient, ctx: WorkspaceContext): Promise<Record<string, number>> {
  const result = await client.query<{ state: string; count: number }>(
    `SELECT COALESCE(processing_state, processing_status) AS state, COUNT(*)::int AS count
     FROM canonical_jobs
     WHERE workspace_id = $1
       AND is_test_fixture = FALSE
     GROUP BY COALESCE(processing_state, processing_status)
     ORDER BY state`,
    [ctx.workspaceId],
  );
  return Object.fromEntries(result.rows.map((row) => [row.state, row.count]));
}

async function run(): Promise<void> {
  const databaseUrl = String(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL is required.");
  if (isPooledPostgresConnectionString(databaseUrl)) {
    throw new Error("Zero-manual-review recovery requires an unpooled direct PostgreSQL connection.");
  }

  const { apply, limits } = parseArgs(process.argv.slice(2));
  const pool = new pg.Pool(pgPoolConfig(databaseUrl));
  const client = await pool.connect();

  try {
    const ctx = await resolveWorkspaceContext(client as unknown as pg.PoolClient);
    const before = await stateDistribution(client, ctx);
    const candidates = await listRecoveryCandidates(client, ctx, limits);

    console.log("ZERO-MANUAL-REVIEW recovery candidates:", {
      mode: apply ? "APPLY" : "DRY_RUN",
      policyNoMatch: candidates.policyNoMatch.length,
      technicalDeferred: candidates.technicalDeferred.length,
      workAuthVerification: candidates.workAuth.length,
      rawStaged: candidates.rawStaged,
      before,
    });

    if (!apply) {
      console.log("Dry run only. Re-run with --apply after deployment to execute the bounded recovery.");
      return;
    }

    // A. Re-run the normal lane router for policy no-match records. The router
    // now emits terminal UNMATCHED + NO_ACTIVE_LANE_MATCH, or a lane route when
    // the active registry now qualifies the job.
    if (candidates.policyNoMatch.length > 0) {
      await runLaneRouting(pool, {
        context: ctx,
        canonicalJobIds: candidates.policyNoMatch.map((row) => row.canonicalJobId),
        limit: candidates.policyNoMatch.length,
      });
    }

    // B. Repair technical dependencies with bounded publication and reroute.
    for (const candidate of candidates.technicalDeferred) {
      try {
        await runEmbeddingBatchWithFallback(50, pool, {
          context: ctx,
          jobVersionIds: [candidate.jobVersionId],
          includeProfileFacts: true,
          includeLanePrototypes: true,
        });
        await runLaneRouting(pool, {
          context: ctx,
          canonicalJobIds: [candidate.canonicalJobId],
          limit: 1,
        });
      } catch (error) {
        console.warn(
          `Technical recovery remains automatic for ${candidate.canonicalJobId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // C. Re-run only current work-auth verification records under the explicit
    // evidence rule. The hard gate now resolves remote metadata automatically.
    if (candidates.workAuth.length > 0) {
      await runHardGates(pool, {
        context: ctx,
        canonicalJobIds: candidates.workAuth.map((row) => row.canonicalJobId),
        reprocess: true,
      });
    }

    // D. Seed and advance bounded raw-stage work. The worker derives each next
    // task from durable current artifacts rather than requiring a user click.
    if (candidates.rawStaged > 0) {
      await runPipelineStageTaskWorker(pool, {
        context: ctx,
        seed: true,
        includeRoutingDeferred: true,
        maxSeedPerType: candidates.rawStaged,
        maxTasks: candidates.rawStaged * 8,
        claimBatchSize: 1,
        leaseSeconds: 300,
        heartbeatSeconds: 30,
        claimedBy: `zero-manual-recovery:${process.pid}`,
      });
    }

    const after = await stateDistribution(client, ctx);
    const remaining = await listRecoveryCandidates(client, ctx, limits);
    console.log("ZERO-MANUAL-REVIEW recovery result:", {
      after,
      policyNoMatchRemaining: remaining.policyNoMatch.length,
      technicalDeferredRemaining: remaining.technicalDeferred.length,
      workAuthVerificationRemaining: remaining.workAuth.length,
      rawStagedRemaining: remaining.rawStaged,
    });
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void run().catch((error) => {
    console.error("Zero-manual-review recovery failed:", error);
    process.exit(1);
  });
}
