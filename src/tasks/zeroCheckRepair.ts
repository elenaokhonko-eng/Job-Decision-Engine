/**
 * Repair for the must-be-zero checks (src/tasks/integrityZeroChecks.ts). For each violation it enqueues the
 * stage that owns the missing result with a forced recompute, keyed once per job per violation kind per rule
 * version, so running it twice enqueues nothing new. It never writes a result itself: the normal worker runs the
 * queued stage and the check reads zero when that work has completed.
 *
 * Not repaired here (owned elsewhere, reported as unrepairable): a listed job that is not confirmed open
 * (availability re-check), an owner-saved job the re-check archived (a human restores it), a stale stage result
 * (the version-reopen seeds), and a completed APPLY_HARD_GATES or RECHECK_AVAILABILITY task without a result
 * (a forced re-gate resets downstream state; the gate owner re-gates deliberately).
 *
 * The repair target is the replay copy only, for now: see requireRepairTarget and requireRepairApply.
 */
import pg from "pg";

import { pgConnectionConfig } from "../db/pgSsl.js";
import { requireApprovedReplayTarget } from "../reporting/replayGuard.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../workspace/context.js";
import {
  canonicalCopyColumnsDrift,
  matchBlockedOnRequirementEmbedding,
  rejectedJobsWithRecommendation,
  routableVerificationJobsStranded,
} from "./integrityZeroChecks.js";
import { findTasksCompletedWithoutResult } from "./completedWithoutResult.js";
import { enqueuePipelineTask } from "./pipelineTasks.js";
import { pipelineTaskStageVersion } from "./pipelineTaskCurrentness.js";
import { createTaskIntentV2 } from "./taskIntent.js";

type Queryable = Pick<pg.PoolClient, "query">;

/** Bump to repair the same job and violation kind again. */
export const ZERO_CHECK_REPAIR_RULE_VERSION = "zero-check-repair-v1";

export const REPAIRABLE_VIOLATION_KINDS = [
  "rejected_job_with_recommendation",
  "task_completed_without_result",
  "routable_verification_job_stranded",
  "canonical_copy_columns_drift",
  "match_blocked_on_requirement_embedding",
] as const;
export type RepairableViolationKind = (typeof REPAIRABLE_VIOLATION_KINDS)[number];

export type RepairEntryTaskType = "PUBLISH_EMBEDDING" | "ROUTE_LANE" | "MATCH_PROFILE_EVIDENCE" | "DECIDE_RECOMMENDATION";

/** Earlier stage first: when one job violates several checks, the earliest stage runs and carries the rest. */
const ENTRY_RANK: Readonly<Record<RepairEntryTaskType, number>> = {
  PUBLISH_EMBEDDING: 1,
  ROUTE_LANE: 2,
  MATCH_PROFILE_EVIDENCE: 3,
  DECIDE_RECOMMENDATION: 4,
};

export interface ZeroCheckRepairItem {
  readonly kind: RepairableViolationKind;
  readonly canonicalJobId: string;
  readonly jobVersionId: string;
  readonly entry: RepairEntryTaskType;
}

export interface UnrepairableViolation {
  readonly check: string;
  readonly reason: string;
  readonly count: number;
}

export interface ZeroCheckRepairPlan {
  readonly items: readonly ZeroCheckRepairItem[];
  readonly unrepairable: readonly UnrepairableViolation[];
  /** Jobs left out because a task of the entry stage is already active or a repair of that stage is already queued. */
  readonly skippedActive: number;
}

/** Default cap on tasks one apply run inserts. */
export const DEFAULT_MAX_REPAIR_TASKS = 200;

interface LiveJob {
  readonly canonicalJobId: string;
  readonly latestJobVersionId: string;
  readonly state: string | null;
}

async function loadLiveJobs(db: Queryable, workspaceId: string, canonicalJobIds: readonly string[]): Promise<Map<string, LiveJob>> {
  const jobs = new Map<string, LiveJob>();
  if (canonicalJobIds.length === 0) return jobs;
  const { rows } = await db.query<{ id: string; latest_job_version_id: string | null; state: string | null }>(
    `SELECT c.id::text AS id, c.latest_job_version_id::text AS latest_job_version_id,
            COALESCE(c.processing_state, c.processing_status) AS state
       FROM canonical_jobs c
      WHERE c.workspace_id = $1::uuid AND c.id = ANY($2::uuid[]) AND c.archived_at IS NULL AND NOT c.is_test_fixture`,
    [workspaceId, [...canonicalJobIds]],
  );
  for (const row of rows) {
    if (row.latest_job_version_id) jobs.set(row.id, { canonicalJobId: row.id, latestJobVersionId: row.latest_job_version_id, state: row.state });
  }
  return jobs;
}

/** Read only: what the repair would enqueue, one entry task per job, with the violations it came from. */
export async function planZeroCheckRepairs(db: Queryable, workspaceId: string): Promise<ZeroCheckRepairPlan> {
  const candidates: ZeroCheckRepairItem[] = [];
  const unrepairable: UnrepairableViolation[] = [];

  // 1. A hard-rejected job that still recommends: the decider recomputes (HARD_REJECT -> INELIGIBLE / SKIP).
  const rejected = await rejectedJobsWithRecommendation(db, workspaceId, { withIds: true });
  const rejectedJobs = await loadLiveJobs(db, workspaceId, rejected.ids ?? []);
  for (const job of rejectedJobs.values()) {
    candidates.push({ kind: "rejected_job_with_recommendation", canonicalJobId: job.canonicalJobId, jobVersionId: job.latestJobVersionId, entry: "DECIDE_RECOMMENDATION" });
  }

  // 2. A completed task without a result: re-run that stage (a re-match is followed by its decision by the worker).
  {
    // `all: true`: the reporting sample is clamped to 200 rows; the repair needs every row.
    const report = await findTasksCompletedWithoutResult(db, workspaceId, { all: true });
    const versionIds = [...new Set(report.sample.map((row) => row.jobVersionId))];
    const versionOwner = new Map<string, string>();
    if (versionIds.length > 0) {
      const { rows } = await db.query<{ id: string; canonical_job_id: string }>(
        `SELECT v.id::text AS id, v.canonical_job_id::text AS canonical_job_id FROM job_versions v
          WHERE v.workspace_id = $1::uuid AND v.id = ANY($2::uuid[])`,
        [workspaceId, versionIds],
      );
      for (const row of rows) versionOwner.set(row.id, row.canonical_job_id);
    }
    // Archived, fixture and stale-version exclusion happens in loadLiveJobs only.
    const liveJobs = await loadLiveJobs(db, workspaceId, [...new Set(versionOwner.values())]);
    const unsupported: Record<string, number> = {};
    for (const row of report.sample) {
      const entry: RepairEntryTaskType | null =
        row.taskType === "DECIDE_RECOMMENDATION" ? "DECIDE_RECOMMENDATION"
          : row.taskType === "MATCH_PROFILE_EVIDENCE" ? "MATCH_PROFILE_EVIDENCE"
            : row.taskType === "ROUTE_LANE" ? "ROUTE_LANE" : null;
      const canonicalJobId = versionOwner.get(row.jobVersionId);
      if (!entry) { unsupported[row.taskType] = (unsupported[row.taskType] ?? 0) + 1; continue; }
      if (!canonicalJobId) continue;
      const live = liveJobs.get(canonicalJobId);
      if (!live || live.latestJobVersionId !== row.jobVersionId) continue;
      candidates.push({ kind: "task_completed_without_result", canonicalJobId, jobVersionId: row.jobVersionId, entry });
    }
    for (const [taskType, count] of Object.entries(unsupported)) {
      unrepairable.push({ check: "task_completed_without_result", reason: `${taskType} is not repaired here`, count });
    }
  }

  // 3. A stranded routable verification job: re-route it; the worker carries it to a match and a decision.
  const stranded = await routableVerificationJobsStranded(db, workspaceId, { withIds: true });
  for (const job of (await loadLiveJobs(db, workspaceId, stranded.ids ?? [])).values()) {
    candidates.push({ kind: "routable_verification_job_stranded", canonicalJobId: job.canonicalJobId, jobVersionId: job.latestJobVersionId, entry: "ROUTE_LANE" });
  }

  // 4. Copy columns behind the stage results: re-run from the first stage whose copy column is missing.
  const drift = await canonicalCopyColumnsDrift(db, workspaceId, { withIds: true });
  for (const job of (await loadLiveJobs(db, workspaceId, drift.ids ?? [])).values()) {
    const entry: RepairEntryTaskType =
      job.state === "PREQUALIFIED" ? "PUBLISH_EMBEDDING" : job.state === "LANE_ROUTED" ? "MATCH_PROFILE_EVIDENCE" : "DECIDE_RECOMMENDATION";
    candidates.push({ kind: "canonical_copy_columns_drift", canonicalJobId: job.canonicalJobId, jobVersionId: job.latestJobVersionId, entry });
  }

  // 5. A match blocked on a missing requirement embedding past the threshold: queue the embedding repair round again.
  const embeddingBlocked = await matchBlockedOnRequirementEmbedding(db, workspaceId, { withIds: true });
  for (const job of (await loadLiveJobs(db, workspaceId, embeddingBlocked.ids ?? [])).values()) {
    candidates.push({ kind: "match_blocked_on_requirement_embedding", canonicalJobId: job.canonicalJobId, jobVersionId: job.latestJobVersionId, entry: "PUBLISH_EMBEDDING" });
  }

  // One entry task per job: the earliest stage. The kind is deterministic for a given set of violations.
  const chosen = new Map<string, ZeroCheckRepairItem>();
  for (const item of candidates) {
    const current = chosen.get(item.canonicalJobId);
    if (
      !current ||
      ENTRY_RANK[item.entry] < ENTRY_RANK[current.entry] ||
      (ENTRY_RANK[item.entry] === ENTRY_RANK[current.entry] && item.kind < current.kind)
    ) chosen.set(item.canonicalJobId, item);
  }
  const ordered = [...chosen.values()].sort((a, b) => a.canonicalJobId.localeCompare(b.canonicalJobId));

  // A job that already has an active task of the entry stage, or a repair of that stage queued for the same rule
  // version under any kind, gets nothing more: two kinds on one job never queue two forced tasks.
  const busy = new Set<string>();
  if (ordered.length > 0) {
    const { rows } = await db.query<{ task_type: string; job_version_id: string }>(
      `SELECT task.task_type, task.payload->>'job_version_id' AS job_version_id
         FROM pipeline_tasks task
        WHERE task.workspace_id = $1::uuid
          AND task.payload->>'job_version_id' = ANY($2::text[])
          AND (task.status IN ('PENDING', 'RUNNING', 'RETRY_WAIT', 'BLOCKED_DEPENDENCY')
               OR task.payload->'zero_check_repair'->>'rule_version' = $3)`,
      [workspaceId, ordered.map((item) => item.jobVersionId), ZERO_CHECK_REPAIR_RULE_VERSION],
    );
    for (const row of rows) busy.add(`${row.task_type}:${row.job_version_id}`);
  }
  const items = ordered.filter((item) => !busy.has(`${item.entry}:${item.jobVersionId}`));
  return { items, unrepairable, skippedActive: ordered.length - items.length };
}

export function repairTaskKey(item: ZeroCheckRepairItem): string {
  const version = pipelineTaskStageVersion(item.entry);
  if (!version) throw new Error(`No stage version for ${item.entry}.`);
  return `${item.entry}:${item.jobVersionId}:${version}:zero-check-repair:${item.kind}:${ZERO_CHECK_REPAIR_RULE_VERSION}`;
}

export function repairTaskPayload(item: ZeroCheckRepairItem): Record<string, unknown> {
  const base = {
    canonical_job_id: item.canonicalJobId,
    job_version_id: item.jobVersionId,
    zero_check_repair: { kind: item.kind, rule_version: ZERO_CHECK_REPAIR_RULE_VERSION },
  };
  // The decider honours force_policy_recalculation; the router, matcher and embedder honour reprocess_existing_state,
  // which the worker also passes on to the successor stages.
  return item.entry === "DECIDE_RECOMMENDATION"
    ? { ...base, force_policy_recalculation: true }
    : { ...base, reprocess_existing_state: true };
}

export interface ZeroCheckRepairApplyResult {
  readonly inserted: number;
  readonly existing: number;
  readonly skipped: number;
  /** True when the cap stopped the run before every plan item was attempted. */
  readonly truncated: boolean;
  /** Plan items not attempted because of the cap; run again to continue. */
  readonly remaining: number;
}

export async function applyZeroCheckRepairs(
  db: pg.Pool | pg.PoolClient,
  ctx: WorkspaceContext,
  plan: ZeroCheckRepairPlan,
  maxTasks: number = DEFAULT_MAX_REPAIR_TASKS,
): Promise<ZeroCheckRepairApplyResult> {
  if (!Number.isInteger(maxTasks) || maxTasks < 1) throw new Error("The repair cap (--max-tasks) must be a positive integer.");
  let inserted = 0;
  let existing = 0;
  let skipped = 0;
  let attempted = 0;
  for (const item of plan.items) {
    // The cap counts inserted tasks, so a rerun continues past items that are already queued.
    if (inserted >= maxTasks) break;
    attempted += 1;
    const stageVersion = pipelineTaskStageVersion(item.entry);
    if (!stageVersion) throw new Error(`No stage version for ${item.entry}.`);
    const taskKey = repairTaskKey(item);
    const payload = repairTaskPayload(item);
    const result = await enqueuePipelineTask({
      taskType: item.entry,
      taskKey,
      payload,
      maxAttempts: item.entry === "DECIDE_RECOMMENDATION" || item.entry === "MATCH_PROFILE_EVIDENCE" ? 8 : 3,
      intent: createTaskIntentV2({
        workspaceId: ctx.workspaceId, taskType: item.entry, stageVersion, producer: "zeroCheckRepair",
        requestId: taskKey, mode: "FORCE_RECOMPUTE", payload,
      }),
    }, db, { context: ctx });
    if (result.skippedReason) skipped += 1;
    else if (result.inserted) inserted += 1;
    else existing += 1;
  }
  const remaining = plan.items.length - attempted;
  return { inserted, existing, skipped, truncated: remaining > 0, remaining };
}

/* ---------------------------------------------------------------------------------------------------------------
 * Target guard and command
 * ------------------------------------------------------------------------------------------------------------- */

export interface RepairTargetInput {
  readonly target: string | undefined;
  readonly databaseUrl: string | undefined;
  readonly identity: { readonly databaseName: string | null; readonly branchId: string | null };
  readonly replayBranchId: string | undefined;
}

/**
 * The repair writes tasks, so it may only run on the replay copy: --target replay, REPLAY_DATABASE_URL, the
 * replay guard, and a connected branch that equals REPLAY_BRANCH_ID (the guard alone would fall back to the default
 * staging branch when the variable is unset). Throws without echoing the URL.
 */
export function requireRepairTarget(input: RepairTargetInput): void {
  if (input.target !== "replay") throw new Error("Zero-check repair needs --target replay; no other target is supported yet.");
  const url = (input.databaseUrl ?? "").trim();
  if (!url) throw new Error("REPLAY_DATABASE_URL is required for --target replay.");
  const branch = (input.replayBranchId ?? "").trim();
  if (!branch) throw new Error("REPLAY_BRANCH_ID is required: the connected branch must equal it.");
  if (input.identity.branchId !== branch) {
    throw new Error(`Refusing to repair: the connected branch ${input.identity.branchId ?? "unknown"} is not REPLAY_BRANCH_ID.`);
  }
  requireApprovedReplayTarget(url, input.identity, branch);
}

export function requireRepairApply(input: {
  readonly allowedEnv: string | undefined;
  readonly confirmWorkspace: string | undefined;
  readonly workspaceId: string;
}): void {
  if (input.allowedEnv !== "true") throw new Error("Applying the zero-check repair needs ZERO_CHECK_REPAIR_ALLOWED=true.");
  if ((input.confirmWorkspace ?? "").trim().toLowerCase() !== input.workspaceId.toLowerCase()) {
    throw new Error("Applying the zero-check repair needs --confirm-workspace=<the workspace id>.");
  }
}

export interface ZeroCheckRepairReport {
  readonly mode: "dry_run" | "apply";
  readonly workspaceId: string;
  readonly ruleVersion: string;
  readonly planned: number;
  readonly byKind: Record<string, number>;
  readonly byEntry: Record<string, number>;
  /** First ids per kind; ids only. */
  readonly sample: Record<string, string[]>;
  readonly unrepairable: readonly UnrepairableViolation[];
  readonly skippedActive: number;
  readonly maxTasks: number;
  /** True when the apply cap stopped the run, or (dry run) when the plan is larger than the cap. */
  readonly truncated: boolean;
  readonly applied?: ZeroCheckRepairApplyResult;
}

export function summarizeRepairPlan(
  workspaceId: string,
  plan: ZeroCheckRepairPlan,
  mode: "dry_run" | "apply",
  maxTasks: number,
  applied?: ZeroCheckRepairApplyResult,
): ZeroCheckRepairReport {
  const byKind: Record<string, number> = {};
  const byEntry: Record<string, number> = {};
  const sample: Record<string, string[]> = {};
  for (const item of plan.items) {
    byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
    byEntry[item.entry] = (byEntry[item.entry] ?? 0) + 1;
    const kindSample = (sample[item.kind] ??= []);
    if (kindSample.length < 10) kindSample.push(item.canonicalJobId);
  }
  return {
    mode, workspaceId, ruleVersion: ZERO_CHECK_REPAIR_RULE_VERSION, planned: plan.items.length, byKind, byEntry, sample,
    unrepairable: plan.unrepairable, skippedActive: plan.skippedActive, maxTasks,
    truncated: applied ? applied.truncated : plan.items.length > maxTasks,
    ...(applied ? { applied } : {}),
  };
}

export interface ZeroCheckRepairCommandOptions {
  readonly target: string | undefined;
  readonly apply: boolean;
  readonly confirmWorkspace?: string;
  /** Cap on tasks inserted by one apply run; default DEFAULT_MAX_REPAIR_TASKS. */
  readonly maxTasks?: number;
  readonly workspaceKey?: string;
  readonly userKey?: string;
}

/** The whole `--repair` command: guards, a read-only plan by default, and the apply only when every gate is open. */
export async function runZeroCheckRepairCommand(
  env: NodeJS.ProcessEnv,
  options: ZeroCheckRepairCommandOptions,
): Promise<ZeroCheckRepairReport> {
  // The target is checked before any connection is made, so a wrong target never opens one.
  if (options.target !== "replay") throw new Error("Zero-check repair needs --target replay; no other target is supported yet.");
  const url = (env.REPLAY_DATABASE_URL ?? "").trim();
  if (!url) throw new Error("REPLAY_DATABASE_URL is required for --target replay.");
  const maxTasks = options.maxTasks ?? DEFAULT_MAX_REPAIR_TASKS;
  if (!Number.isInteger(maxTasks) || maxTasks < 1) throw new Error("--max-tasks must be a positive integer.");
  const pool = new pg.Pool({ ...pgConnectionConfig(url), max: 2 });
  const client = await pool.connect();
  try {
    const identity = await client.query<{ database_name: string | null; branch_id: string | null }>(
      `SELECT current_database() AS database_name, current_setting('neon.branch_id', TRUE) AS branch_id`,
    );
    requireRepairTarget({
      target: options.target,
      databaseUrl: url,
      identity: { databaseName: identity.rows[0]?.database_name ?? null, branchId: identity.rows[0]?.branch_id ?? null },
      replayBranchId: env.REPLAY_BRANCH_ID,
    });
    const ctx = await resolveWorkspaceContext(client as never, { workspaceKey: options.workspaceKey, userKey: options.userKey });
    if (options.apply) {
      requireRepairApply({ allowedEnv: env.ZERO_CHECK_REPAIR_ALLOWED, confirmWorkspace: options.confirmWorkspace, workspaceId: ctx.workspaceId });
      const plan = await planZeroCheckRepairs(client, ctx.workspaceId);
      const applied = await applyZeroCheckRepairs(client, ctx, plan, maxTasks);
      return summarizeRepairPlan(ctx.workspaceId, plan, "apply", maxTasks, applied);
    }
    await client.query("BEGIN READ ONLY");
    try {
      const plan = await planZeroCheckRepairs(client, ctx.workspaceId);
      return summarizeRepairPlan(ctx.workspaceId, plan, "dry_run", maxTasks);
    } finally {
      await client.query("ROLLBACK");
    }
  } finally {
    client.release();
    await pool.end();
  }
}
