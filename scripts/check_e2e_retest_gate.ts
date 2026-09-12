import dotenv from "dotenv";
import pg from "pg";
import { pgPoolConfig } from "../src/db/pgSsl.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local", override: true });

export interface ManagedApiConfig {
  baseUrl: string;
  token: string;
  workspaceKey: string;
  userKey: string;
}

export interface RetestGateFunnel {
  gatePassed: number;
  prequalified: number;
  routingDeferred: number;
  currentRequirements: number;
  currentMatches: number;
  currentDecisions: number;
  currentEvaluations: number;
  activeEvaluationQueue: number;
  eligibleWithoutCurrentMatch: number;
  mandatoryPendingTasks: number;
  blockedTasks: number;
  retryingTasks: number;
  deadLetterTasks: number;
}

export interface RetestGateInput {
  managedApiConfigured: boolean;
  managedApiReachable: boolean;
  funnel: RetestGateFunnel;
}

export function validateManagedApiConfig(config: ManagedApiConfig): string[] {
  const blockers: string[] = [];
  if (!config.baseUrl) {
    blockers.push("MANAGED_API_BASE_URL_MISSING");
  } else {
    try {
      const parsed = new URL(config.baseUrl);
      const loopback = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
      if (parsed.protocol !== "https:" || loopback) {
        blockers.push("MANAGED_API_MUST_USE_PUBLIC_HTTPS");
      }
    } catch {
      blockers.push("MANAGED_API_BASE_URL_INVALID");
    }
  }
  if (!config.token) blockers.push("MANAGED_API_TOKEN_MISSING");
  if (!config.workspaceKey) blockers.push("WORKSPACE_KEY_MISSING");
  if (!config.userKey) blockers.push("WORKSPACE_USER_KEY_MISSING");
  return blockers;
}

export function evaluateRetestGate(input: RetestGateInput): string[] {
  const blockers: string[] = [];
  if (input.managedApiConfigured && !input.managedApiReachable) {
    blockers.push("MANAGED_API_HEALTH_CHECK_FAILED");
  }
  const funnel = input.funnel;
  if (funnel.currentRequirements < funnel.gatePassed) blockers.push("CURRENT_REQUIREMENTS_INCOMPLETE");
  if (funnel.eligibleWithoutCurrentMatch > 0) blockers.push("CURRENT_PROFILE_MATCHES_INCOMPLETE");
  if (funnel.prequalified > 0) blockers.push("PREQUALIFIED_JOBS_AWAITING_LANE_ROUTING");
  if (funnel.mandatoryPendingTasks > 0) blockers.push("MANDATORY_PIPELINE_TASKS_PENDING");
  if (funnel.blockedTasks > 0) blockers.push("PIPELINE_TASKS_BLOCKED");
  if (funnel.retryingTasks > 0) blockers.push("PIPELINE_TASKS_RETRYING");
  if (funnel.deadLetterTasks > 0) blockers.push("PIPELINE_TASKS_DEAD_LETTERED");
  return blockers;
}

function apiHealthUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  const basePath = parsed.pathname.replace(/\/+$/, "");
  return new URL(`${basePath}/health`, parsed.origin).toString();
}

async function checkManagedApi(config: ManagedApiConfig): Promise<{ configured: boolean; reachable: boolean; error?: string }> {
  const configBlockers = validateManagedApiConfig(config);
  if (configBlockers.length > 0) return { configured: false, reachable: false, error: configBlockers.join(",") };

  try {
    const response = await fetch(apiHealthUrl(config.baseUrl), {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${config.token}`,
        "x-workspace-key": config.workspaceKey,
        "x-user-key": config.userKey,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { configured: true, reachable: false, error: `HTTP_${response.status}` };
    const body = await response.json() as { ok?: boolean };
    return body.ok === true
      ? { configured: true, reachable: true }
      : { configured: true, reachable: false, error: "HEALTH_BODY_NOT_OK" };
  } catch (error: any) {
    return { configured: true, reachable: false, error: String(error?.message ?? error) };
  }
}

async function readProductionGate(pool: pg.Pool): Promise<{ funnel: RetestGateFunnel; workspaceId: string; userId: string }> {
  const client = await pool.connect();
  try {
    const context = await resolveWorkspaceContext(client as any);
    const funnel = await client.query<RetestGateFunnel>(
      `WITH latest_versions AS (
             SELECT DISTINCT ON (jv.canonical_job_id)
                    jv.canonical_job_id, jv.id AS job_version_id,
                    jv.active_requirement_set_id, jv.content_hash
               FROM job_versions jv
              WHERE jv.workspace_id = $1
              ORDER BY jv.canonical_job_id, jv.observed_at DESC, jv.id DESC
           ), current_requirements AS (
             SELECT lv.canonical_job_id
               FROM latest_versions lv
              WHERE EXISTS (
                SELECT 1
                  FROM job_version_pipeline_state ps
                  JOIN requirement_extraction_runs rer
                    ON rer.workspace_id = ps.workspace_id
                   AND rer.job_version_id = ps.job_version_id
                   AND rer.run_type = 'DETERMINISTIC'
                   AND rer.status = 'COMPLETED'
                   AND rer.requirement_set_id = lv.active_requirement_set_id
                 WHERE ps.workspace_id = $1
                   AND ps.job_version_id = lv.job_version_id
                   AND ps.current_stage = 'REQUIREMENTS_EXTRACTED'
                   AND ps.stage_status = 'COMPLETED'
              )
           ), current_matches AS (
             SELECT c.id AS canonical_job_id
               FROM canonical_jobs c
               JOIN latest_versions lv ON lv.canonical_job_id = c.id
               JOIN match_runs mr
                 ON mr.workspace_id = $1
                AND mr.id = c.latest_match_run_id
                AND mr.canonical_job_id = c.id
                AND mr.job_version_id = lv.job_version_id
                AND mr.profile_version_id = $2
                AND mr.requirement_set_id = lv.active_requirement_set_id
                AND mr.job_content_hash = lv.content_hash
                AND mr.status = 'COMPLETED'
                AND mr.context_fingerprint IS NOT NULL
                AND COALESCE(mr.matched_count, 0) > 0
              WHERE c.workspace_id = $1
           ), current_decisions AS (
             SELECT c.id AS canonical_job_id
               FROM canonical_jobs c
               JOIN latest_versions lv ON lv.canonical_job_id = c.id
               JOIN current_matches cm ON cm.canonical_job_id = c.id
               JOIN deterministic_decisions dd
                 ON dd.workspace_id = $1
                AND dd.id = c.latest_deterministic_decision_id
                AND dd.canonical_job_id = c.id
                AND dd.job_version_id = lv.job_version_id
                AND dd.match_run_id = c.latest_match_run_id
                AND dd.context_fingerprint IS NOT NULL
              WHERE c.workspace_id = $1
           ), task_counts AS (
             SELECT
               COUNT(*) FILTER (WHERE status = 'BLOCKED_DEPENDENCY')::int AS blocked_tasks,
               COUNT(*) FILTER (WHERE status = 'RETRY_WAIT')::int AS retrying_tasks,
               COUNT(*) FILTER (WHERE status = 'DEAD_LETTER')::int AS dead_letter_tasks,
               COUNT(*) FILTER (
                 WHERE status NOT IN ('COMPLETED')
                   AND task_type <> 'EXTRACT_QUOTED_REQUIREMENTS'
               )::int AS mandatory_pending_tasks
               FROM pipeline_tasks
              WHERE workspace_id = $1
           )
           SELECT
             COUNT(*) FILTER (WHERE c.gate_decision = 'PASS')::int AS "gatePassed",
             COUNT(*) FILTER (WHERE c.processing_state = 'PREQUALIFIED')::int AS prequalified,
             COUNT(*) FILTER (WHERE c.processing_state = 'ROUTING_DEFERRED')::int AS "routingDeferred",
             (SELECT COUNT(*) FROM current_requirements)::int AS "currentRequirements",
             (SELECT COUNT(*) FROM current_matches)::int AS "currentMatches",
             (SELECT COUNT(*) FROM current_decisions)::int AS "currentDecisions",
             (SELECT COUNT(*) FROM ai_evaluations ae WHERE ae.workspace_id = $1 AND ae.profile_version_id = $2)::int AS "currentEvaluations",
             (SELECT COUNT(*) FROM evaluation_queue eq WHERE eq.workspace_id = $1 AND eq.status IN ('PENDING', 'RETRY_WAIT', 'EVALUATING'))::int AS "activeEvaluationQueue",
             COUNT(*) FILTER (
               WHERE c.gate_decision = 'PASS'
                 AND c.processing_state <> 'ROUTING_DEFERRED'
                 AND COALESCE(c.profile_match_status, 'UNKNOWN') <> 'NO_PROFILE_MATCH'
                 AND NOT EXISTS (SELECT 1 FROM current_matches cm WHERE cm.canonical_job_id = c.id)
             )::int AS "eligibleWithoutCurrentMatch",
             task_counts.mandatory_pending_tasks AS "mandatoryPendingTasks",
             task_counts.blocked_tasks AS "blockedTasks",
             task_counts.retrying_tasks AS "retryingTasks",
             task_counts.dead_letter_tasks AS "deadLetterTasks"
             FROM canonical_jobs c
             CROSS JOIN task_counts
            WHERE c.workspace_id = $1
            GROUP BY task_counts.mandatory_pending_tasks, task_counts.blocked_tasks,
                     task_counts.retrying_tasks, task_counts.dead_letter_tasks`,
      [context.workspaceId, (await client.query<{ id: string }>(
        `SELECT id FROM profile_versions WHERE workspace_id = $1 AND status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1`,
        [context.workspaceId]
      )).rows[0]?.id]
    );
    const row = funnel.rows[0];
    if (!row) throw new Error("Production funnel query returned no row.");
    return {
      funnel: row,
      workspaceId: context.workspaceId,
      userId: context.userId,
    };
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  if (process.env.JDEC_MANAGED_API_REQUIRED !== "true") {
    const { checkDesktopE2EGate } = await import("./check_desktop_e2e_gate.js");
    const res = await checkDesktopE2EGate();
    if (!res.ok) process.exitCode = 1;
    return;
  }

  const config: ManagedApiConfig = {
    baseUrl: String(process.env.JDEC_API_BASE_URL || process.env.JDEC_DESKTOP_API_BASE_URL || "").trim().replace(/\/+$/, ""),
    token: String(process.env.JDEC_API_TOKEN || "").trim(),
    workspaceKey: String(process.env.WORKSPACE_KEY || "").trim(),
    userKey: String(process.env.WORKSPACE_USER_KEY || "").trim(),
  };
  const api = await checkManagedApi(config);
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required for the E2E retest gate.");

  const pool = new pg.Pool(pgPoolConfig(databaseUrl));
  try {
    const production = await readProductionGate(pool);
    const blockers = [
      ...validateManagedApiConfig(config),
      ...(api.configured && !api.reachable
        ? [api.error ? `MANAGED_API_${api.error}` : "MANAGED_API_HEALTH_CHECK_FAILED"]
        : []),
      ...evaluateRetestGate({
        managedApiConfigured: api.configured,
        managedApiReachable: api.reachable,
        funnel: production.funnel,
      }),
    ].filter((value, index, all) => all.indexOf(value) === index);
    const report = {
      gate: "MANAGED_API_DESKTOP_E2E_RETEST",
      ready: blockers.length === 0,
      workspace_id: production.workspaceId,
      user_id: production.userId,
      api: { configured: api.configured, reachable: api.reachable },
      funnel: production.funnel,
      blockers,
    };
    console.log(JSON.stringify(report, null, 2));
    if (blockers.length > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.includes("check_e2e_retest_gate")) {
  main().catch((error) => {
    console.error("E2E retest gate failed:", error?.message ?? error);
    process.exitCode = 1;
  });
}
