import dotenv from "dotenv";
import pg from "pg";
import { pgSslConfig } from "../src/db/pgSsl.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

type Args = {
  dryRun: boolean;
  resume: boolean;
  runKey: string;
  workspaceKey?: string;
  userKey?: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, resume: false, runKey: "v22_backfill" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") {
      args.dryRun = true;
    } else if (a === "--resume") {
      args.resume = true;
    } else if (a === "--run-key" && argv[i + 1]) {
      args.runKey = String(argv[i + 1]).trim();
      i++;
    } else if (a === "--workspace-key" && argv[i + 1]) {
      args.workspaceKey = String(argv[i + 1]).trim();
      i++;
    } else if (a === "--user-key" && argv[i + 1]) {
      args.userKey = String(argv[i + 1]).trim();
      i++;
    }
  }
  return args;
}

async function upsertCheckpoint(
  client: pg.PoolClient,
  params: { workspaceId: string; runId: string; stepKey: string; checkpoint: any }
): Promise<void> {
  await client.query(
    `
    INSERT INTO backfill_checkpoints (workspace_id, backfill_run_id, step_key, checkpoint)
    VALUES ($1, $2, $3, $4::jsonb)
    ON CONFLICT (backfill_run_id, step_key)
    DO UPDATE SET checkpoint = EXCLUDED.checkpoint, updated_at = NOW()
    `,
    [params.workspaceId, params.runId, params.stepKey, JSON.stringify(params.checkpoint ?? {})]
  );
}

async function isStepComplete(
  client: pg.PoolClient,
  params: { runId: string; stepKey: string }
): Promise<boolean> {
  const { rows } = await client.query<{ checkpoint: any }>(
    `
    SELECT checkpoint
    FROM backfill_checkpoints
    WHERE backfill_run_id = $1
      AND step_key = $2
    LIMIT 1
    `,
    [params.runId, params.stepKey]
  );
  const cp = rows[0]?.checkpoint;
  return Boolean(cp && typeof cp === "object" && cp.status === "COMPLETED");
}

async function ensureBackfillTablesExist(client: pg.PoolClient): Promise<void> {
  const { rows } = await client.query<{ exists: boolean }>(
    `
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'backfill_runs'
    ) AS exists
    `
  );
  if (!rows[0]?.exists) {
    throw new Error(
      "backfill_runs table is missing. Apply migrations first (expecting migration 035_v22_read_models_and_cutover.sql)."
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const databaseUrl = (process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not configured.");
  }

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: pgSslConfig(databaseUrl),
  });

  const client = await pool.connect();
  let runId: string | null = null;

  try {
    await ensureBackfillTablesExist(client);

    const ctx = await resolveWorkspaceContext(client as any, {
      workspaceKey: args.workspaceKey,
      userKey: args.userKey,
    });

    if (args.resume) {
      const existing = await client.query<{ id: string; dry_run: boolean }>(
        `
        SELECT id, dry_run
        FROM backfill_runs
        WHERE workspace_id = $1
          AND run_key = $2
          AND status = 'RUNNING'
        ORDER BY started_at DESC
        LIMIT 1
        `,
        [ctx.workspaceId, args.runKey]
      );
      if (existing.rows.length > 0) {
        runId = existing.rows[0].id;
        if (existing.rows[0].dry_run !== args.dryRun) {
          throw new Error("Cannot resume a backfill run with a different --dry-run setting.");
        }
      }
    }

    if (!runId) {
      const inserted = await client.query<{ id: string }>(
        `
        INSERT INTO backfill_runs (workspace_id, run_key, status, dry_run, created_by_user_id)
        VALUES ($1, $2, 'RUNNING', $3, $4)
        RETURNING id
        `,
        [ctx.workspaceId, args.runKey, args.dryRun, ctx.userId]
      );
      runId = inserted.rows[0]?.id ?? null;
      if (!runId) {
        throw new Error("Failed to create backfill run.");
      }
    }

    console.log("=== v2.2 Backfill (resumable) ===");
    console.log(`workspace_key=${ctx.workspaceKey} user_key=${ctx.userKey}`);
    console.log(`run_id=${runId} run_key=${args.runKey} dry_run=${args.dryRun}`);

    const steps: Array<{
      key: string;
      label: string;
      run: () => Promise<{ checked: number; updated: number }>;
    }> = [
      {
        key: "processing_state_backfill",
        label: "Backfill canonical_jobs.processing_state from processing_status",
        run: async () => {
          const { rows } = await client.query<{ n: number }>(
            `
            SELECT COUNT(*)::int AS n
            FROM canonical_jobs
            WHERE workspace_id = $1
              AND processing_state IS NULL
              AND processing_status IS NOT NULL
            `,
            [ctx.workspaceId]
          );
          const checked = rows[0]?.n ?? 0;
          let updated = 0;
          if (!args.dryRun && checked > 0) {
            const res = await client.query(
              `
              UPDATE canonical_jobs
              SET processing_state = processing_status,
                  updated_at = NOW()
              WHERE workspace_id = $1
                AND processing_state IS NULL
                AND processing_status IS NOT NULL
              `,
              [ctx.workspaceId]
            );
            updated = res.rowCount ?? 0;
          }
          return { checked, updated };
        },
      },
      {
        key: "latest_job_version_backfill",
        label: "Backfill canonical_jobs.latest_job_version_id when missing",
        run: async () => {
          const { rows } = await client.query<{ n: number }>(
            `
            SELECT COUNT(*)::int AS n
            FROM canonical_jobs c
            WHERE c.workspace_id = $1
              AND c.latest_job_version_id IS NULL
              AND EXISTS (
                SELECT 1
                FROM job_versions v
                WHERE v.workspace_id = c.workspace_id
                  AND v.canonical_job_id = c.id
              )
            `,
            [ctx.workspaceId]
          );
          const checked = rows[0]?.n ?? 0;
          let updated = 0;
          if (!args.dryRun && checked > 0) {
            const res = await client.query(
              `
              WITH latest AS (
                SELECT
                  c.id AS canonical_job_id,
                  lv.id AS version_id
                FROM canonical_jobs c
                JOIN LATERAL (
                  SELECT id
                  FROM job_versions v
                  WHERE v.workspace_id = c.workspace_id
                    AND v.canonical_job_id = c.id
                  ORDER BY v.observed_at DESC
                  LIMIT 1
                ) lv ON TRUE
                WHERE c.workspace_id = $1
                  AND c.latest_job_version_id IS NULL
              )
              UPDATE canonical_jobs c
              SET latest_job_version_id = latest.version_id,
                  updated_at = NOW()
              FROM latest
              WHERE c.id = latest.canonical_job_id
              `,
              [ctx.workspaceId]
            );
            updated = res.rowCount ?? 0;
          }
          return { checked, updated };
        },
      },
      {
        key: "active_requirement_set_backfill",
        label: "Backfill job_versions.active_requirement_set_id when missing",
        run: async () => {
          const { rows } = await client.query<{ n: number }>(
            `
            SELECT COUNT(*)::int AS n
            FROM job_versions jv
            WHERE jv.workspace_id = $1
              AND jv.active_requirement_set_id IS NULL
              AND EXISTS (
                SELECT 1
                FROM requirement_sets rs
                WHERE rs.workspace_id = jv.workspace_id
                  AND rs.job_version_id = jv.id
              )
            `,
            [ctx.workspaceId]
          );
          const checked = rows[0]?.n ?? 0;
          let updated = 0;
          if (!args.dryRun && checked > 0) {
            const res = await client.query(
              `
              WITH latest AS (
                SELECT DISTINCT ON (rs.job_version_id)
                  rs.job_version_id,
                  rs.id AS requirement_set_id
                FROM requirement_sets rs
                WHERE rs.workspace_id = $1
                  AND rs.job_version_id IS NOT NULL
                ORDER BY rs.job_version_id, rs.revision_number DESC, rs.created_at DESC
              )
              UPDATE job_versions jv
              SET active_requirement_set_id = latest.requirement_set_id
              FROM latest
              WHERE jv.workspace_id = $1
                AND jv.id = latest.job_version_id
                AND jv.active_requirement_set_id IS NULL
              `,
              [ctx.workspaceId]
            );
            updated = res.rowCount ?? 0;
          }
          return { checked, updated };
        },
      },
      {
        key: "latest_decision_link_backfill",
        label: "Backfill canonical_jobs.latest_deterministic_decision_id when missing",
        run: async () => {
          const { rows } = await client.query<{ n: number }>(
            `
            SELECT COUNT(*)::int AS n
            FROM canonical_jobs c
            WHERE c.workspace_id = $1
              AND c.latest_deterministic_decision_id IS NULL
              AND EXISTS (
                SELECT 1
                FROM deterministic_decisions dd
                WHERE dd.workspace_id = c.workspace_id
                  AND dd.canonical_job_id = c.id
              )
            `,
            [ctx.workspaceId]
          );
          const checked = rows[0]?.n ?? 0;
          let updated = 0;
          if (!args.dryRun && checked > 0) {
            const res = await client.query(
              `
              WITH latest AS (
                SELECT DISTINCT ON (dd.canonical_job_id)
                  dd.canonical_job_id,
                  dd.id AS decision_id
                FROM deterministic_decisions dd
                WHERE dd.workspace_id = $1
                ORDER BY dd.canonical_job_id, dd.created_at DESC
              )
              UPDATE canonical_jobs c
              SET latest_deterministic_decision_id = latest.decision_id,
                  updated_at = NOW()
              FROM latest
              WHERE c.workspace_id = $1
                AND c.id = latest.canonical_job_id
                AND c.latest_deterministic_decision_id IS NULL
              `,
              [ctx.workspaceId]
            );
            updated = res.rowCount ?? 0;
          }
          return { checked, updated };
        },
      },
    ];

    for (const step of steps) {
      if (await isStepComplete(client, { runId, stepKey: step.key })) {
        console.log(`- ${step.key}: SKIPPED (checkpoint complete)`);
        continue;
      }

      console.log(`- ${step.key}: ${step.label}`);
      const startedAt = new Date().toISOString();
      const result = await step.run();
      const checkpoint = {
        status: "COMPLETED",
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        dry_run: args.dryRun,
        checked: result.checked,
        updated: result.updated,
      };
      await upsertCheckpoint(client, {
        workspaceId: ctx.workspaceId,
        runId,
        stepKey: step.key,
        checkpoint,
      });
      console.log(`  checked=${result.checked} updated=${result.updated}`);
    }

    await client.query(
      `
      UPDATE backfill_runs
      SET status = 'COMPLETED',
          completed_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
      `,
      [runId]
    );

    console.log("Backfill run completed.");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (runId) {
      await client
        .query(
          `
          UPDATE backfill_runs
          SET status = 'FAILED',
              last_error = $2,
              updated_at = NOW()
          WHERE id = $1
          `,
          [runId, message]
        )
        .catch(() => undefined);
    }
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("v2.2 backfill failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});

