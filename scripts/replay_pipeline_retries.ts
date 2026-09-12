import dotenv from "dotenv";
import pg from "pg";
import { pgPoolConfig } from "../src/db/pgSsl.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../src/workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const REPLAYABLE_TASK_TYPES = [
  "APPLY_HARD_GATES",
  "EXTRACT_DETERMINISTIC_REQUIREMENTS",
  "EXTRACT_QUOTED_REQUIREMENTS",
  "PUBLISH_EMBEDDING",
  "ROUTE_LANE",
  "MATCH_PROFILE_EVIDENCE",
  "DECIDE_RECOMMENDATION",
  "ENQUEUE_EXPLANATION",
] as const;

type ReplayableTaskType = (typeof REPLAYABLE_TASK_TYPES)[number];

interface RetryCandidate {
  id: string;
  task_type: ReplayableTaskType;
  task_key: string;
  status: "RETRY_WAIT" | "DEAD_LETTER" | "BLOCKED_DEPENDENCY";
  attempt_count: number;
  last_error: string | null;
}

function parseArgs(argv: string[]): { apply: boolean; workspaceKey?: string; userKey?: string } {
  const args: { apply: boolean; workspaceKey?: string; userKey?: string } = { apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    if (arg === "--workspace-key" && argv[i + 1]) args.workspaceKey = argv[++i];
    if (arg === "--user-key" && argv[i + 1]) args.userKey = argv[++i];
  }
  return args;
}

async function loadCandidates(client: pg.PoolClient, context: WorkspaceContext): Promise<RetryCandidate[]> {
  const { rows } = await client.query<RetryCandidate>(
    `
      SELECT id, task_type, task_key, status, attempt_count, last_error
      FROM pipeline_tasks
      WHERE workspace_id = $1
        AND task_type = ANY($2::text[])
        AND status IN ('RETRY_WAIT', 'DEAD_LETTER', 'BLOCKED_DEPENDENCY')
      ORDER BY status, task_type, created_at, id
    `,
    [context.workspaceId, REPLAYABLE_TASK_TYPES]
  );
  return rows;
}

async function replayCandidates(
  client: pg.PoolClient,
  context: WorkspaceContext,
  candidates: RetryCandidate[]
): Promise<number> {
  if (candidates.length === 0) return 0;

  await client.query("BEGIN");
  try {
    const { rowCount } = await client.query(
      `
        UPDATE pipeline_tasks
        SET status = 'PENDING',
            available_at = NOW(),
            lease_id = NULL,
            lease_expires_at = NULL,
            heartbeat_at = NULL,
            claimed_by = NULL,
            attempt_count = CASE WHEN status = 'DEAD_LETTER' THEN 0 ELSE attempt_count END,
            last_error = NULL,
            dead_letter_reason = NULL,
            blocked_on = NULL,
            blocked_reason = NULL,
            repair_action = NULL,
            completed_at = NULL,
            updated_at = NOW()
        WHERE workspace_id = $1
          AND id = ANY($2::uuid[])
          AND status IN ('RETRY_WAIT', 'DEAD_LETTER', 'BLOCKED_DEPENDENCY')
        RETURNING id
      `,
      [context.workspaceId, candidates.map((candidate) => candidate.id)]
    );
    await client.query("COMMIT");
    return rowCount ?? 0;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = (process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");

  const pool = new pg.Pool(pgPoolConfig(databaseUrl));
  const client = await pool.connect();
  try {
    const context = await resolveWorkspaceContext(client, {
      workspaceKey: args.workspaceKey || undefined,
      userKey: args.userKey || undefined,
    });
    const candidates = await loadCandidates(client, context);
    const counts = candidates.reduce<Record<string, number>>((result, candidate) => {
      const key = `${candidate.status}:${candidate.task_type}`;
      result[key] = (result[key] || 0) + 1;
      return result;
    }, {});

    console.log(JSON.stringify({
      mode: args.apply ? "apply" : "dry_run",
      workspace_id: context.workspaceId,
      candidate_count: candidates.length,
      candidate_counts: counts,
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        task_type: candidate.task_type,
        task_key: candidate.task_key,
        status: candidate.status,
        attempt_count: candidate.attempt_count,
        last_error: candidate.last_error,
      })),
    }, null, 2));

    if (!args.apply) {
      console.log("No rows changed. Re-run with --apply after reviewing the bounded pre-AI task list.");
      return;
    }

    const replayed = await replayCandidates(client, context, candidates);
    console.log(JSON.stringify({ replayed }, null, 2));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Pipeline retry replay failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
