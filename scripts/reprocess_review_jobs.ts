import dotenv from "dotenv";
import pg from "pg";
import { pgPoolConfig } from "../src/db/pgSsl.js";
import { buildPipelineTaskContextFingerprint } from "../src/pipeline/artifactContext.js";
import { enqueuePipelineTask } from "../src/tasks/pipelineTasks.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

type Candidate = {
  canonical_job_id: string;
  job_version_id: string;
  processing_state: string;
  gate_decision: string | null;
  rejection_reason: string | null;
};

function parseArgs(argv: string[]): { apply: boolean; limit?: number } {
  const result: { apply: boolean; limit?: number } = { apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--apply") result.apply = true;
    if (argv[i] === "--limit" && argv[i + 1]) result.limit = Number(argv[++i]);
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
const pool = new pg.Pool(pgPoolConfig(String(process.env.DATABASE_URL || "")));
const client = await pool.connect();
try {
  const context = await resolveWorkspaceContext(client as any);
  const activeMode = await client.query<{ mode_key: string; updated_at: string }>(
    `SELECT mode_key, updated_at::text
       FROM workspace_user_preference_modes
      WHERE workspace_id = $1 AND user_id = $2 AND is_active = TRUE
      ORDER BY updated_at DESC
      LIMIT 1`,
    [context.workspaceId, context.userId]
  );
  const modeKey = activeMode.rows[0]?.mode_key ?? "profile_defaults";
  const modeRevision = activeMode.rows[0]?.updated_at
    ? String(Date.parse(activeMode.rows[0].updated_at))
    : String(Date.now());

  const limitClause = args.limit && args.limit > 0 ? "LIMIT $2" : "";
  const params: unknown[] = [context.workspaceId];
  if (limitClause) params.push(Math.floor(args.limit as number));
  const candidates = await client.query<Candidate>(
    `SELECT c.id AS canonical_job_id,
            COALESCE(c.latest_job_version_id, latest.id) AS job_version_id,
            COALESCE(c.processing_state, c.processing_status) AS processing_state,
            c.gate_decision, c.rejection_reason
       FROM canonical_jobs c
       LEFT JOIN LATERAL (
         SELECT jv.id
           FROM job_versions jv
          WHERE jv.workspace_id = c.workspace_id AND jv.canonical_job_id = c.id
          ORDER BY jv.observed_at DESC, jv.id DESC
          LIMIT 1
       ) latest ON TRUE
      WHERE c.workspace_id = $1
        AND COALESCE(c.processing_state, c.processing_status) IN ('NEEDS_VERIFICATION', 'NEEDS_MANUAL_REVIEW')
        AND COALESCE(c.latest_job_version_id, latest.id) IS NOT NULL
      ORDER BY c.updated_at ASC, c.id ASC
      ${limitClause}`,
    params
  );

  console.log(JSON.stringify({
    modeKey,
    modeRevision,
    workspaceId: context.workspaceId,
    candidateCount: candidates.rows.length,
    apply: args.apply,
    candidates: candidates.rows,
  }, null, 2));
  if (args.apply) {
    let inserted = 0;
    let existing = 0;
    for (const candidate of candidates.rows) {
    const payload = {
      canonical_job_id: candidate.canonical_job_id,
      job_version_id: candidate.job_version_id,
      force_policy_recalculation: true,
      reprocess: true,
      review_replay: true,
      preference_mode_key: modeKey,
      preference_mode_revision: modeRevision,
    };
    const result = await enqueuePipelineTask({
      taskType: "APPLY_HARD_GATES",
      taskKey: `APPLY_HARD_GATES:${candidate.job_version_id}:review-replay:${modeKey}:${modeRevision}`,
      payload,
      maxAttempts: 8,
      contextFingerprint: buildPipelineTaskContextFingerprint({
        workspaceId: context.workspaceId,
        taskType: "APPLY_HARD_GATES",
        taskVersion: "hard_gate_v1",
        payload,
      }),
    }, client as any, { context });
      if (result.inserted || result.reactivated) inserted += 1;
      else existing += 1;
    }
    console.log(JSON.stringify({ inserted, existing }, null, 2));
  }
} finally {
  client.release();
  await pool.end();
}
