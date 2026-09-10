import crypto from "crypto";
import express from "express";
import pg from "pg";
import { pgPoolConfig } from "../../db/pgSsl.js";
import {
  DEFAULT_USER_KEY,
  DEFAULT_WORKSPACE_KEY,
  resolveWorkspaceContext,
  type WorkspaceContext,
} from "../../workspace/context.js";
import { enqueuePipelineTask } from "../../tasks/pipelineTasks.js";
import { loadWorkabilityPolicy, mergeWorkabilityPreferenceContent } from "../../pipeline/workabilityPolicy.js";
import { stableStringify } from "../../config/structuredLoader.js";
import { apiAuthMiddleware } from "./auth.js";
import { decodeCursor, encodeCursor } from "./cursor.js";

type QueryClient = {
  query: pg.PoolClient["query"];
};

type ResolveContextFn = typeof resolveWorkspaceContext;

function asyncHandler(
  handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<void> | void
): express.RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function requiredDatabaseUrl(): string {
  const url = (process.env.DATABASE_URL || "").trim();
  if (!url) {
    throw new Error("DATABASE_URL is not configured.");
  }
  return url;
}

function workspaceKeyFromRequest(req: express.Request): string {
  const header = String(req.header("x-workspace-key") || "").trim();
  return header || (process.env.WORKSPACE_KEY || DEFAULT_WORKSPACE_KEY).trim();
}

function userKeyFromRequest(req: express.Request): string {
  const header = String(req.header("x-user-key") || "").trim();
  return header || (process.env.WORKSPACE_USER_KEY || process.env.USER_KEY || DEFAULT_USER_KEY).trim();
}

function sha256Hex(payload: string): string {
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function previewWorkabilityPolicy(content: unknown): { policy: unknown; policy_hash: string } {
  const policy = mergeWorkabilityPreferenceContent(loadWorkabilityPolicy(), content);
  return { policy, policy_hash: sha256Hex(stableStringify(policy)) };
}

function parsePositiveInt(value: unknown, fallback: number, options?: { min?: number; max?: number }): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  const candidate = Number.isFinite(parsed) ? parsed : fallback;
  const min = options?.min ?? 1;
  const max = options?.max ?? 1000;
  return Math.max(min, Math.min(max, candidate));
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

const APPLICATION_STATUSES = [
  "INTENT",
  "READY_TO_APPLY",
  "SUBMITTED",
  "FOLLOW_UP",
  "INTERVIEW",
  "OFFER",
  "REJECTED",
  "WITHDRAWN",
  "CLOSED",
] as const;

type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

function parseApplicationStatus(value: unknown, fallback: ApplicationStatus = "INTENT"): ApplicationStatus | null {
  const normalized = String(value ?? fallback).trim().toUpperCase();
  return APPLICATION_STATUSES.includes(normalized as ApplicationStatus)
    ? normalized as ApplicationStatus
    : null;
}

function parseOptionalIsoDate(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function jsonObjectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
  } finally {
    client.release();
  }
}

export interface ApiV2RouterDeps {
  pool?: pg.Pool;
  resolveContext?: ResolveContextFn;
}

export function createApiV2Router(deps: ApiV2RouterDeps = {}): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: "1mb" }));

  const pool =
    deps.pool ??
    new pg.Pool(pgPoolConfig(requiredDatabaseUrl()));

  const resolveContext: ResolveContextFn = deps.resolveContext ?? resolveWorkspaceContext;

  router.use(apiAuthMiddleware());

  router.use(
    asyncHandler(async (req, _res, next) => {
      const ctx = await resolveContext(pool as unknown as QueryClient, {
        workspaceKey: workspaceKeyFromRequest(req),
        userKey: userKeyFromRequest(req),
      });
      (req as any).workspaceContext = ctx;
      next();
    })
  );

  router.get(
    "/health",
    asyncHandler(async (req, res) => {
      const ctx = (req as any).workspaceContext as WorkspaceContext;
      res.json({
        ok: true,
        timestamp: new Date().toISOString(),
        workspace_key: ctx.workspaceKey,
        user_key: ctx.userKey,
      });
    })
  );

  router.get(
    "/shortlist",
    asyncHandler(async (req, res) => {
      const ctx = (req as any).workspaceContext as WorkspaceContext;
      const limit = parsePositiveInt(req.query.limit, 250, { min: 1, max: 500 });
      const cursor = decodeCursor(typeof req.query.cursor === "string" ? req.query.cursor : null);

      const params: any[] = [ctx.workspaceId];
      let cursorClause = "";
      if (cursor) {
        params.push(cursor.t, cursor.id);
        cursorClause = "AND (s.observed_at, s.canonical_job_id) < ($2::timestamptz, $3::uuid)";
      }
      params.push(limit);

      const { rows } = await pool.query(
        `
          SELECT
            s.canonical_job_id,
            s.job_version_id,
            s.title,
            s.company,
            s.canonical_url,
            s.source,
            s.location,
            s.workplace_type,
            s.employment_type,
            s.description,
            s.gate_status,
            s.rejection_codes,
            s.gate_evidence_quotes,
            s.primary_lane,
            s.secondary_lanes,
            s.lane_confidence,
            s.priority_score,
            s.deterministic_match_score,
            s.deterministic_match_coverage,
            s.processing_state,
            s.processing_status,
            s.recommendation_eligibility,
            s.recommendation_outcome,
            s.recommendation_requirement_score,
            s.recommendation_coverage_score,
            s.recommendation_evidence_completeness,
            s.recommendation_decided_at,
            s.nd_friendly_score,
            s.politics_stress_score,
            s.sensory_overload_index,
            s.next_action,
            s.strategic_value,
            s.recommended_cv_version,
            s.evaluation_summary,
            s.eval_provider,
            s.eval_is_fallback,
            s.version_mismatch,
            s.observed_at,
            s.evaluated_at,
            s.lane_matches,
            s.workability_facts,
            s.queue_status,
            s.latest_match_run_id,
            s.cv_document_run_id,
            s.cover_letter_document_run_id,
            s.document_ready,
            s.current_artifact_status,
            s.current_artifact_reason,
            s.blocked_task_count
          FROM v_canonical_shortlist_scoped s
          WHERE s.workspace_id = $1
          ${cursorClause}
          ORDER BY s.observed_at DESC, s.canonical_job_id DESC
          LIMIT $${params.length}
        `,
        params
      );

      const last = rows.length > 0 ? rows[rows.length - 1] : null;
      const next_cursor =
        rows.length === limit && last?.observed_at && last?.canonical_job_id
          ? encodeCursor({ t: new Date(last.observed_at).toISOString(), id: String(last.canonical_job_id) })
          : null;

      res.json({ ok: true, jobs: rows, next_cursor });
    })
  );

  router.get(
    "/rejected",
    asyncHandler(async (req, res) => {
      const ctx = (req as any).workspaceContext as WorkspaceContext;
      const limit = parsePositiveInt(req.query.limit, 50, { min: 1, max: 200 });

      const { rows } = await pool.query(
        `
          SELECT
            a.id AS canonical_job_id,
            a.job_version_id,
            a.title,
            a.company,
            a.careers_portal_url AS canonical_url,
            a.source,
            a.status AS processing_state,
            a.rejection_reason,
            a.gate_status,
            a.rejection_codes,
            a.gate_evidence_quotes,
            a.description,
            a.nd_friendly_score,
            a.politics_stress_score,
            a.sensory_overload_index,
            a."postedDate"::timestamptz AS observed_at
          FROM v_rejected_jobs_audit_scoped a
          WHERE a.workspace_id = $1
          ORDER BY observed_at DESC, a.id DESC
          LIMIT $2
        `,
        [ctx.workspaceId, limit]
      );

      res.json({ ok: true, jobs: rows });
    })
  );

  router.delete(
    "/jobs/:id",
    asyncHandler(async (req, res) => {
      const ctx = (req as any).workspaceContext as WorkspaceContext;
      const jobId = String(req.params.id || "").trim();
      if (!jobId) {
        res.status(400).json({ ok: false, error: "job id is required" });
        return;
      }

      const result = await pool.query(
        `
          UPDATE canonical_jobs
          SET processing_state = 'MANUALLY_REMOVED',
              processing_status = 'MANUALLY_REMOVED',
              rejection_reason = 'Manually removed via /api/v2',
              updated_at = NOW()
          WHERE workspace_id = $1
            AND id = $2::uuid
        `,
        [ctx.workspaceId, jobId]
      );

      res.json({ ok: true, updated: (result.rowCount ?? 0) > 0 });
    })
  );

  router.post(
    "/observations/manual",
    asyncHandler(async (req, res) => {
      const ctx = (req as any).workspaceContext as WorkspaceContext;
      const title = String(req.body?.title || "").trim();
      const company = String(req.body?.company || "").trim();
      const source = String(req.body?.source || "MANUAL_STREAMLIT").trim();
      const description = String(req.body?.description || "").trim();
      const salaryRange = String(req.body?.salaryRange || "UNKNOWN").trim();
      const location = String(req.body?.location || "Singapore").trim();
      const careersUrl = String(req.body?.careers_portal_url || "").trim();

      if (!title || !company || !description) {
        res.status(400).json({ ok: false, error: "Missing required fields: title, company, description." });
        return;
      }

      const payload = {
        company_name: company,
        title,
        description,
        source,
        careers_portal_url: careersUrl,
      };
      const rawPayload = JSON.stringify(payload);
      const rawPayloadHash = sha256Hex(rawPayload);

      try {
        const insertedRow = await withTransaction(pool, async (tx) => {
          const runRes = await tx.query<{ id: string }>(
            `INSERT INTO source_runs (workspace_id, status)
             VALUES ($1, 'MANUAL_STREAMLIT')
             RETURNING id`,
            [ctx.workspaceId]
          );
          const sourceRunId = runRes.rows[0].id;

          const extId = `manual-${rawPayloadHash.slice(0, 16)}`;

          const ins = await tx.query<{ id: string }>(
            `
              INSERT INTO raw_job_observations (
                workspace_id,
                source_run_id,
                source_name,
                source_external_id,
                source_url,
                retrieved_at,
                company_name,
                title,
                description_raw,
                location_raw,
                workplace_type_raw,
                employment_type_raw,
                compensation_raw,
                canonical_apply_url,
                source_lane,
                search_plan_version,
                raw_payload,
                raw_payload_hash
              )
              VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8, $9, 'UNKNOWN', 'UNKNOWN', $10, $5, 'UNKNOWN', '1.0', $11::jsonb, $12)
              ON CONFLICT (workspace_id, raw_payload_hash) DO NOTHING
              RETURNING id
            `,
            [
              ctx.workspaceId,
              sourceRunId,
              source,
              extId,
              careersUrl,
              company,
              title,
              description,
              location,
              salaryRange,
              rawPayload,
              rawPayloadHash,
            ]
          );

          return ins.rows[0] ?? null;
        });

        res.json({ ok: true, inserted: !!insertedRow, raw_observation_id: insertedRow?.id ?? null });
      } catch (err) {
        throw err;
      }
    })
  );

  router.post(
    "/observations/linkedin",
    asyncHandler(async (req, res) => {
      const ctx = (req as any).workspaceContext as WorkspaceContext;
      const jobs = Array.isArray(req.body?.jobs) ? req.body.jobs : Array.isArray(req.body) ? req.body : [];
      if (!Array.isArray(jobs) || jobs.length === 0) {
        res.status(400).json({ ok: false, error: "Body must be { jobs: [...] } (or an array of jobs)." });
        return;
      }

      try {
        const result = await withTransaction(pool, async (tx) => {
          const runRes = await tx.query<{ id: string }>(
            `INSERT INTO source_runs (workspace_id, status)
             VALUES ($1, 'LINKEDIN_IMPORT')
             RETURNING id`,
            [ctx.workspaceId]
          );
          const sourceRunId = runRes.rows[0].id;

          let inserted = 0;
          let skipped = 0;

          for (const job of jobs) {
            const title = String(job?.title || "").trim();
            const company = String(job?.company || "").trim();
            const url = String(job?.url || "").trim();
            const description = String(job?.description || "").trim();
            const location = String(job?.location || "Singapore").trim();

            if (!title || !company || !url || !description) {
              skipped += 1;
              continue;
            }

            const rawPayload = JSON.stringify(job);
            const rawPayloadHash = sha256Hex(rawPayload);
            const extId = `linkedin-${rawPayloadHash.slice(0, 16)}`;

            const ins = await tx.query<{ id: string }>(
              `
                INSERT INTO raw_job_observations (
                  workspace_id,
                  source_run_id,
                  source_name,
                  source_external_id,
                  source_url,
                  retrieved_at,
                  company_name,
                  title,
                  description_raw,
                  location_raw,
                  workplace_type_raw,
                  employment_type_raw,
                  compensation_raw,
                  canonical_apply_url,
                  source_lane,
                  search_plan_version,
                  raw_payload,
                  raw_payload_hash
                )
                VALUES ($1, $2, 'LINKEDIN', $3, $4, NOW(), $5, $6, $7, $8, 'UNKNOWN', 'PERMANENT', 'UNKNOWN', $4, 'UNKNOWN', '1.0', $9::jsonb, $10)
                ON CONFLICT (workspace_id, raw_payload_hash) DO NOTHING
                RETURNING id
              `,
              [ctx.workspaceId, sourceRunId, extId, url, company, title, description, location, rawPayload, rawPayloadHash]
            );

            if (ins.rows.length > 0) {
              inserted += 1;
            } else {
              skipped += 1;
            }
          }

          return { inserted, skipped };
        });

        res.json({ ok: true, inserted: result.inserted, skipped: result.skipped });
      } catch (err) {
        throw err;
      }
    })
  );

  router.get(
    "/analytics/companies",
    asyncHandler(async (_req, res) => {
      const { rows } = await pool.query(
        `
          SELECT
            name as "Company",
            industry as "Industry",
            nd_friendly_avg_score as "Avg Autonomy Score",
            politics_stress_avg_score as "Avg Politics Score",
            sensory_overload_avg_index as "Avg Sensory Index",
            focus_protection_avg_score as "Avg Focus Score",
            is_neurodivergent_approved as "Approved",
            is_toxic_culture_blacklisted as "Toxic"
          FROM companies
          ORDER BY nd_friendly_avg_score DESC
        `
      );
      res.json({ ok: true, companies: rows });
    })
  );

  router.get(
    "/sources/health",
    asyncHandler(async (req, res) => {
      const ctx = (req as any).workspaceContext as WorkspaceContext;
      const { rows } = await pool.query(
        `
          SELECT
            sp.source_key,
            sp.display_name,
            sp.kind,
            sp.status,
            spr.revision_number AS active_revision_number,
            spr.content->'compliance'->>'access_basis' AS access_basis,
            spr.content->'compliance'->>'terms_url' AS terms_url,
            spr.content->'compliance'->>'attribution_required' AS attribution_required,
            COUNT(rjo.id)::int AS observation_count,
            MAX(rjo.retrieved_at) AS last_observed_at
          FROM source_plugins sp
          LEFT JOIN source_plugin_active_revisions spar
            ON spar.source_plugin_id = sp.id
          LEFT JOIN source_plugin_revisions spr
            ON spr.id = spar.source_plugin_revision_id
          LEFT JOIN raw_job_observations rjo
            ON rjo.workspace_id = sp.workspace_id
           AND rjo.source_plugin_key = sp.source_key
          WHERE sp.workspace_id = $1
          GROUP BY
            sp.source_key,
            sp.display_name,
            sp.kind,
            sp.status,
            spr.revision_number,
            access_basis,
            terms_url,
            attribution_required
          ORDER BY last_observed_at DESC NULLS LAST, sp.source_key ASC
        `,
        [ctx.workspaceId]
      );

      res.json({ ok: true, sources: rows });
    })
  );

  router.get(
    "/tasks",
    asyncHandler(async (req, res) => {
      const ctx = (req as any).workspaceContext as WorkspaceContext;
      const limit = parsePositiveInt(req.query.limit, 100, { min: 1, max: 250 });
      const cursor = decodeCursor(typeof req.query.cursor === "string" ? req.query.cursor : null);

      const params: any[] = [ctx.workspaceId];
      let cursorClause = "";
      if (cursor) {
        params.push(cursor.t, cursor.id);
        cursorClause = "AND (t.created_at, t.id) < ($2::timestamptz, $3::uuid)";
      }
      params.push(limit);

      const { rows } = await pool.query(
        `
          SELECT
            t.id,
            t.task_type,
            t.task_key,
            t.context_fingerprint,
            t.status,
            t.available_at,
            t.lease_id,
            t.lease_expires_at,
            t.heartbeat_at,
            t.claimed_by,
            t.attempt_count,
            t.max_attempts,
            t.last_error,
            t.dead_letter_reason,
            t.blocked_on,
            t.blocked_reason,
            t.repair_action,
            t.created_at,
            t.updated_at,
            t.completed_at
          FROM pipeline_tasks t
          WHERE t.workspace_id = $1
          ${cursorClause}
          ORDER BY t.created_at DESC, t.id DESC
          LIMIT $${params.length}
        `,
        params
      );

      const last = rows.length > 0 ? rows[rows.length - 1] : null;
      const next_cursor =
        rows.length === limit && last?.created_at && last?.id
          ? encodeCursor({ t: new Date(last.created_at).toISOString(), id: String(last.id) })
          : null;

      res.json({ ok: true, tasks: rows, next_cursor });
    })
  );

  router.post(
    "/tasks",
    asyncHandler(async (req, res) => {
      const ctx = (req as any).workspaceContext as WorkspaceContext;
      const taskType = String(req.body?.task_type || "").trim();
      const payload = req.body?.payload;
      const maxAttempts = req.body?.max_attempts;
      const availableAtRaw = req.body?.available_at;

      if (!taskType) {
        res.status(400).json({ ok: false, error: "task_type is required." });
        return;
      }

      const providedTaskKey = String(req.body?.task_key || "").trim();
      let taskKey = providedTaskKey;
      if (!taskKey) {
        const idempotencyKey = String(req.header("idempotency-key") || "").trim();
        if (!idempotencyKey) {
          res.status(400).json({ ok: false, error: "Provide task_key or Idempotency-Key header." });
          return;
        }
        taskKey = `${taskType}:${idempotencyKey}`;
      }

      const availableAt =
        typeof availableAtRaw === "string" && availableAtRaw.trim()
          ? new Date(availableAtRaw.trim())
          : undefined;
      if (availableAt && Number.isNaN(availableAt.getTime())) {
        res.status(400).json({ ok: false, error: "available_at must be an ISO datetime string." });
        return;
      }

      const maxAttemptsNumber =
        typeof maxAttempts === "number" ? Math.max(1, Math.min(20, Math.floor(maxAttempts))) : undefined;

      const queued = await enqueuePipelineTask(
        {
          taskType,
          taskKey,
          payload,
          maxAttempts: maxAttemptsNumber,
          availableAt,
        },
        pool,
        { context: ctx }
      );

      res.status(201).json({ ok: true, task_id: queued.taskId, inserted: queued.inserted });
    })
  );

  router.get(
    "/applications",
    asyncHandler(async (req, res) => {
      const ctx = (req as any).workspaceContext as WorkspaceContext;
      const limit = parsePositiveInt(req.query.limit, 100, { min: 1, max: 250 });
      const status = req.query.status !== undefined
        ? parseApplicationStatus(req.query.status)
        : null;
      if (req.query.status !== undefined && !status) {
        res.status(400).json({ ok: false, error: `status must be one of: ${APPLICATION_STATUSES.join(", ")}.` });
        return;
      }

      const { rows } = await pool.query(
        `
          SELECT
            application_record_id,
            canonical_job_id,
            job_version_id,
            title,
            company,
            canonical_url,
            processing_state,
            processing_status,
            recommendation_eligibility,
            recommendation_outcome,
            primary_lane,
            secondary_lanes,
            application_status,
            submission_url,
            cv_document_run_id,
            cover_letter_document_run_id,
            notes,
            handoff_payload,
            target_submit_at,
            submitted_at,
            follow_up_at,
            last_action_at,
            created_at,
            updated_at
          FROM v_application_tracker
          WHERE workspace_id = $1
            AND user_id = $2
            AND ($3::text IS NULL OR application_status = $3)
          ORDER BY updated_at DESC, application_record_id DESC
          LIMIT $4
        `,
        [ctx.workspaceId, ctx.userId, status, limit]
      );

      res.json({ ok: true, applications: rows });
    })
  );

  router.post(
    "/applications",
    asyncHandler(async (req, res) => {
      const ctx = (req as any).workspaceContext as WorkspaceContext;
      const canonicalJobId = String(req.body?.canonical_job_id || "").trim();
      const requestedJobVersionId = String(req.body?.job_version_id || "").trim() || null;
      const status = parseApplicationStatus(req.body?.status, "INTENT");
      const hasTargetSubmitAt = Object.prototype.hasOwnProperty.call(req.body ?? {}, "target_submit_at");
      const hasFollowUpAt = Object.prototype.hasOwnProperty.call(req.body ?? {}, "follow_up_at");
      const targetSubmitAt = parseOptionalIsoDate(req.body?.target_submit_at);
      const followUpAt = parseOptionalIsoDate(req.body?.follow_up_at);
      const handoffPayload = jsonObjectOrEmpty(req.body?.handoff_payload);
      const notes = req.body?.notes != null ? String(req.body.notes).trim() || null : null;
      const submissionUrl = req.body?.submission_url != null ? String(req.body.submission_url).trim() || null : null;
      const cvDocumentRunId = req.body?.cv_document_run_id != null ? String(req.body.cv_document_run_id).trim() || null : null;
      const coverLetterDocumentRunId = req.body?.cover_letter_document_run_id != null
        ? String(req.body.cover_letter_document_run_id).trim() || null
        : null;

      if (!canonicalJobId) {
        res.status(400).json({ ok: false, error: "canonical_job_id is required." });
        return;
      }
      if (!isUuid(canonicalJobId) || (requestedJobVersionId !== null && !isUuid(requestedJobVersionId))) {
        res.status(400).json({ ok: false, error: "canonical_job_id and job_version_id must be UUID strings." });
        return;
      }
      if (!status) {
        res.status(400).json({ ok: false, error: `status must be one of: ${APPLICATION_STATUSES.join(", ")}.` });
        return;
      }
      if ((hasTargetSubmitAt && targetSubmitAt === undefined) || (hasFollowUpAt && followUpAt === undefined)) {
        res.status(400).json({ ok: false, error: "target_submit_at and follow_up_at must be ISO datetime strings when provided." });
        return;
      }

      const record = await withTransaction(pool, async (client) => {
        const jobRes = await client.query<{
          canonical_job_id: string;
          job_version_id: string;
          canonical_url: string | null;
          current_artifact_status: string | null;
          current_artifact_reason: string | null;
          recommendation_eligibility: string | null;
        }>(
          `
            SELECT c.id AS canonical_job_id,
                   jv.id AS job_version_id,
                   c.canonical_url,
                   current_shortlist.current_artifact_status,
                   current_shortlist.current_artifact_reason,
                   current_shortlist.recommendation_eligibility
            FROM canonical_jobs c
            JOIN job_versions jv
              ON jv.workspace_id = c.workspace_id
             AND jv.id = COALESCE(
               $3::uuid,
               c.latest_job_version_id,
               (
                 SELECT jv2.id
                 FROM job_versions jv2
                 WHERE jv2.workspace_id = c.workspace_id
                   AND jv2.canonical_job_id = c.id
                 ORDER BY jv2.observed_at DESC
                 LIMIT 1
               )
             )
            LEFT JOIN v_canonical_shortlist_scoped current_shortlist
              ON current_shortlist.workspace_id = c.workspace_id
             AND current_shortlist.canonical_job_id = c.id
             AND current_shortlist.job_version_id = jv.id
            WHERE c.workspace_id = $1
              AND c.id = $2::uuid
            LIMIT 1
          `,
          [ctx.workspaceId, canonicalJobId, requestedJobVersionId]
        );
        const job = jobRes.rows[0];
        if (!job) return null;
        if (job.current_artifact_status !== "CURRENT_OR_NOT_APPLICABLE") {
          return {
            handoffBlocked: true,
            error: "The job does not have a current decision artifact. Re-run the pipeline before creating an application handoff.",
            reason: job.current_artifact_reason ?? job.current_artifact_status ?? "CURRENT_ARTIFACT_UNAVAILABLE",
          };
        }
        if (job.recommendation_eligibility !== "ELIGIBLE") {
          return {
            handoffBlocked: true,
            error: "The job is not deterministically eligible for application handoff.",
            reason: job.recommendation_eligibility ?? "RECOMMENDATION_NOT_ELIGIBLE",
          };
        }

        const existing = await client.query<{ id: string; status: ApplicationStatus }>(
          `
            SELECT id, status
            FROM application_records
            WHERE workspace_id = $1
              AND user_id = $2
              AND canonical_job_id = $3
              AND job_version_id = $4
            LIMIT 1
          `,
          [ctx.workspaceId, ctx.userId, job.canonical_job_id, job.job_version_id]
        );
        const previous = existing.rows[0] ?? null;

        const upserted = await client.query<{ id: string }>(
          `
            INSERT INTO application_records (
              workspace_id,
              user_id,
              canonical_job_id,
              job_version_id,
              status,
              submission_url,
              cv_document_run_id,
              cover_letter_document_run_id,
              notes,
              handoff_payload,
              target_submit_at,
              submitted_at,
              follow_up_at,
              last_action_at,
              updated_at
            )
            VALUES (
              $1, $2, $3, $4, $5, COALESCE($6, $7), $8, $9, $10, $11::jsonb,
              $12::timestamptz,
              CASE WHEN $5 = 'SUBMITTED' THEN NOW() ELSE NULL END,
              $13::timestamptz,
              NOW(),
              NOW()
            )
            ON CONFLICT (workspace_id, user_id, canonical_job_id, job_version_id)
            DO UPDATE SET
              status = EXCLUDED.status,
              submission_url = EXCLUDED.submission_url,
              cv_document_run_id = COALESCE(EXCLUDED.cv_document_run_id, application_records.cv_document_run_id),
              cover_letter_document_run_id = COALESCE(EXCLUDED.cover_letter_document_run_id, application_records.cover_letter_document_run_id),
              notes = COALESCE(EXCLUDED.notes, application_records.notes),
              handoff_payload = CASE
                WHEN EXCLUDED.handoff_payload = '{}'::jsonb THEN application_records.handoff_payload
                ELSE EXCLUDED.handoff_payload
              END,
              target_submit_at = COALESCE(EXCLUDED.target_submit_at, application_records.target_submit_at),
              submitted_at = CASE
                WHEN EXCLUDED.status = 'SUBMITTED' THEN COALESCE(application_records.submitted_at, NOW())
                ELSE application_records.submitted_at
              END,
              follow_up_at = COALESCE(EXCLUDED.follow_up_at, application_records.follow_up_at),
              last_action_at = NOW(),
              updated_at = NOW()
            RETURNING id
          `,
          [
            ctx.workspaceId,
            ctx.userId,
            job.canonical_job_id,
            job.job_version_id,
            status,
            submissionUrl,
            job.canonical_url,
            cvDocumentRunId,
            coverLetterDocumentRunId,
            notes,
            JSON.stringify(handoffPayload),
            targetSubmitAt ?? null,
            followUpAt ?? null,
          ]
        );

        const applicationRecordId = upserted.rows[0].id;
        await client.query(
          `
            INSERT INTO application_events (
              workspace_id,
              application_record_id,
              event_type,
              from_status,
              to_status,
              note,
              event_payload,
              created_by_user_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
          `,
          [
            ctx.workspaceId,
            applicationRecordId,
            previous ? "STATUS_CHANGED" : "CREATED",
            previous?.status ?? null,
            status,
            notes,
            JSON.stringify({
              ...handoffPayload,
              submission_url: submissionUrl ?? job.canonical_url,
              cv_document_run_id: cvDocumentRunId,
              cover_letter_document_run_id: coverLetterDocumentRunId,
            }),
            ctx.userId,
          ]
        );

        const { rows } = await client.query(
          `
            SELECT
              application_record_id,
              canonical_job_id,
              job_version_id,
              title,
              company,
              canonical_url,
              processing_state,
              processing_status,
              recommendation_eligibility,
              recommendation_outcome,
              primary_lane,
              secondary_lanes,
              application_status,
              submission_url,
              cv_document_run_id,
              cover_letter_document_run_id,
              notes,
              handoff_payload,
              target_submit_at,
              submitted_at,
              follow_up_at,
              last_action_at,
              created_at,
              updated_at
            FROM v_application_tracker
            WHERE workspace_id = $1
              AND user_id = $2
              AND application_record_id = $3
            LIMIT 1
          `,
          [ctx.workspaceId, ctx.userId, applicationRecordId]
        );
        return rows[0] ?? null;
      });

      if (!record) {
        res.status(404).json({ ok: false, error: "Canonical job/version not found." });
        return;
      }
      if ("handoffBlocked" in record && record.handoffBlocked) {
        res.status(409).json({ ok: false, error: record.error, reason: record.reason });
        return;
      }

      res.status(201).json({ ok: true, application: record });
    })
  );

  router.patch(
    "/applications/:id",
    asyncHandler(async (req, res) => {
      const ctx = (req as any).workspaceContext as WorkspaceContext;
      const applicationRecordId = String(req.params.id || "").trim();
      const requestedStatus = req.body?.status !== undefined ? parseApplicationStatus(req.body.status) : undefined;
      const notes = req.body?.notes !== undefined ? String(req.body.notes || "").trim() || null : undefined;
      const followUpAt = parseOptionalIsoDate(req.body?.follow_up_at);
      const eventPayload = jsonObjectOrEmpty(req.body?.event_payload);

      if (!applicationRecordId) {
        res.status(400).json({ ok: false, error: "application id is required." });
        return;
      }
      if (!isUuid(applicationRecordId)) {
        res.status(400).json({ ok: false, error: "application id must be a UUID string." });
        return;
      }
      if (requestedStatus === null) {
        res.status(400).json({ ok: false, error: `status must be one of: ${APPLICATION_STATUSES.join(", ")}.` });
        return;
      }
      if (followUpAt === undefined && req.body?.follow_up_at !== undefined) {
        res.status(400).json({ ok: false, error: "follow_up_at must be an ISO datetime string when provided." });
        return;
      }

      const updated = await withTransaction(pool, async (client) => {
        const existing = await client.query<{ id: string; status: ApplicationStatus }>(
          `
            SELECT id, status
            FROM application_records
            WHERE workspace_id = $1
              AND user_id = $2
              AND id = $3::uuid
            LIMIT 1
          `,
          [ctx.workspaceId, ctx.userId, applicationRecordId]
        );
        const current = existing.rows[0];
        if (!current) return null;
        const nextStatus = requestedStatus ?? current.status;

        await client.query(
          `
            UPDATE application_records
            SET status = $4,
                notes = COALESCE($5, notes),
                follow_up_at = COALESCE($6::timestamptz, follow_up_at),
                submitted_at = CASE
                  WHEN $4 = 'SUBMITTED' THEN COALESCE(submitted_at, NOW())
                  ELSE submitted_at
                END,
                last_action_at = NOW(),
                updated_at = NOW()
            WHERE workspace_id = $1
              AND user_id = $2
              AND id = $3::uuid
          `,
          [ctx.workspaceId, ctx.userId, applicationRecordId, nextStatus, notes ?? null, followUpAt ?? null]
        );

        await client.query(
          `
            INSERT INTO application_events (
              workspace_id,
              application_record_id,
              event_type,
              from_status,
              to_status,
              note,
              event_payload,
              created_by_user_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
          `,
          [
            ctx.workspaceId,
            applicationRecordId,
            current.status === nextStatus ? "NOTE_ADDED" : "STATUS_CHANGED",
            current.status,
            nextStatus,
            notes ?? null,
            JSON.stringify(eventPayload),
            ctx.userId,
          ]
        );

        const { rows } = await client.query(
          `
            SELECT
              application_record_id,
              canonical_job_id,
              job_version_id,
              title,
              company,
              canonical_url,
              processing_state,
              processing_status,
              recommendation_eligibility,
              recommendation_outcome,
              primary_lane,
              secondary_lanes,
              application_status,
              submission_url,
              cv_document_run_id,
              cover_letter_document_run_id,
              notes,
              handoff_payload,
              target_submit_at,
              submitted_at,
              follow_up_at,
              last_action_at,
              created_at,
              updated_at
            FROM v_application_tracker
            WHERE workspace_id = $1
              AND user_id = $2
              AND application_record_id = $3
            LIMIT 1
          `,
          [ctx.workspaceId, ctx.userId, applicationRecordId]
        );
        return rows[0] ?? null;
      });

      if (!updated) {
        res.status(404).json({ ok: false, error: "Application record not found." });
        return;
      }

      res.json({ ok: true, application: updated });
    })
  );

  router.get(
    "/applications/:id/events",
    asyncHandler(async (req, res) => {
      const ctx = (req as any).workspaceContext as WorkspaceContext;
      const applicationRecordId = String(req.params.id || "").trim();
      const limit = parsePositiveInt(req.query.limit, 100, { min: 1, max: 250 });

      if (!isUuid(applicationRecordId)) {
        res.status(400).json({ ok: false, error: "application id must be a UUID string." });
        return;
      }

      const ownership = await pool.query(
        `
          SELECT id
          FROM application_records
          WHERE workspace_id = $1
            AND user_id = $2
            AND id = $3::uuid
          LIMIT 1
        `,
        [ctx.workspaceId, ctx.userId, applicationRecordId]
      );
      if (ownership.rows.length === 0) {
        res.status(404).json({ ok: false, error: "Application record not found." });
        return;
      }

      const { rows } = await pool.query(
        `
          SELECT
            id,
            application_record_id,
            event_type,
            from_status,
            to_status,
            note,
            event_payload,
            created_at
          FROM application_events
          WHERE workspace_id = $1
            AND application_record_id = $2::uuid
          ORDER BY created_at DESC, id DESC
          LIMIT $3
        `,
        [ctx.workspaceId, applicationRecordId, limit]
      );

      res.json({ ok: true, events: rows });
    })
  );

  router.get(
    "/accessibility",
    asyncHandler(async (req, res) => {
      const ctx = (req as any).workspaceContext as WorkspaceContext;
      const { rows } = await pool.query<{
        quiet_mode: boolean;
        reduced_motion: boolean;
        high_contrast: boolean;
        density: string;
        font_scale: number;
        show_emojis: boolean;
        updated_at: string;
      }>(
        `
          SELECT
            quiet_mode,
            reduced_motion,
            high_contrast,
            density,
            font_scale,
            show_emojis,
            updated_at
          FROM workspace_user_accessibility_settings
          WHERE workspace_id = $1
            AND user_id = $2
          LIMIT 1
        `,
        [ctx.workspaceId, ctx.userId]
      );

      const defaults = {
        quiet_mode: false,
        reduced_motion: false,
        high_contrast: false,
        density: "comfortable",
        font_scale: 1.0,
        show_emojis: true,
      };

      res.json({ ok: true, settings: rows[0] ? { ...defaults, ...rows[0] } : defaults });
    })
  );

  router.put(
    "/accessibility",
    asyncHandler(async (req, res) => {
      const ctx = (req as any).workspaceContext as WorkspaceContext;
      const body = req.body ?? {};

      const boolKeys = ["quiet_mode", "reduced_motion", "high_contrast", "show_emojis"] as const;
      for (const key of boolKeys) {
        if (body[key] !== undefined && typeof body[key] !== "boolean") {
          res.status(400).json({ ok: false, error: `${key} must be boolean.` });
          return;
        }
      }
      if (body.density !== undefined && body.density !== "comfortable" && body.density !== "compact") {
        res.status(400).json({ ok: false, error: "density must be one of: comfortable, compact." });
        return;
      }
      if (body.font_scale !== undefined) {
        if (typeof body.font_scale !== "number" || Number.isNaN(body.font_scale)) {
          res.status(400).json({ ok: false, error: "font_scale must be a number." });
          return;
        }
        if (body.font_scale < 0.8 || body.font_scale > 1.5) {
          res.status(400).json({ ok: false, error: "font_scale must be between 0.80 and 1.50." });
          return;
        }
      }

      const updated = await withTransaction(pool, async (client) => {
        const { rows: existingRows } = await client.query<{
          quiet_mode: boolean;
          reduced_motion: boolean;
          high_contrast: boolean;
          density: string;
          font_scale: number;
          show_emojis: boolean;
        }>(
          `
            SELECT quiet_mode, reduced_motion, high_contrast, density, font_scale, show_emojis
            FROM workspace_user_accessibility_settings
            WHERE workspace_id = $1 AND user_id = $2
            LIMIT 1
          `,
          [ctx.workspaceId, ctx.userId]
        );

        const base = existingRows[0] || {
          quiet_mode: false,
          reduced_motion: false,
          high_contrast: false,
          density: "comfortable",
          font_scale: 1.0,
          show_emojis: true,
        };

        const next = {
          quiet_mode: body.quiet_mode ?? base.quiet_mode,
          reduced_motion: body.reduced_motion ?? base.reduced_motion,
          high_contrast: body.high_contrast ?? base.high_contrast,
          density: body.density ?? base.density,
          font_scale: body.font_scale ?? base.font_scale,
          show_emojis: body.show_emojis ?? base.show_emojis,
        };

        const { rows } = await client.query(
          `
            INSERT INTO workspace_user_accessibility_settings (
              workspace_id,
              user_id,
              quiet_mode,
              reduced_motion,
              high_contrast,
              density,
              font_scale,
              show_emojis
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (workspace_id, user_id)
            DO UPDATE SET
              quiet_mode = EXCLUDED.quiet_mode,
              reduced_motion = EXCLUDED.reduced_motion,
              high_contrast = EXCLUDED.high_contrast,
              density = EXCLUDED.density,
              font_scale = EXCLUDED.font_scale,
              show_emojis = EXCLUDED.show_emojis,
              updated_at = NOW()
            RETURNING quiet_mode, reduced_motion, high_contrast, density, font_scale, show_emojis, updated_at
          `,
          [
            ctx.workspaceId,
            ctx.userId,
            next.quiet_mode,
            next.reduced_motion,
            next.high_contrast,
            next.density,
            next.font_scale,
            next.show_emojis,
          ]
        );

        return rows[0];
      });

      res.json({ ok: true, settings: updated });
    })
  );

  router.get(
    "/consents",
    asyncHandler(async (req, res) => {
      const ctx = (req as any).workspaceContext as WorkspaceContext;
      const { rows } = await pool.query<{
        consent_key: string;
        granted: boolean;
        granted_at: string | null;
        revoked_at: string | null;
        updated_at: string;
      }>(
        `
          SELECT consent_key, granted, granted_at, revoked_at, updated_at
          FROM workspace_user_consents
          WHERE workspace_id = $1 AND user_id = $2
          ORDER BY updated_at DESC
        `,
        [ctx.workspaceId, ctx.userId]
      );
      res.json({ ok: true, consents: rows });
    })
  );

  router.put(
    "/consents",
    asyncHandler(async (req, res) => {
      const ctx = (req as any).workspaceContext as WorkspaceContext;
      const consents = req.body?.consents;
      if (!consents || typeof consents !== "object" || Array.isArray(consents)) {
        res.status(400).json({ ok: false, error: "Body must include consents object." });
        return;
      }

      const entries = Object.entries(consents as Record<string, unknown>);
      for (const [key, val] of entries) {
        if (!key.trim()) {
          res.status(400).json({ ok: false, error: "consent_key must be non-empty." });
          return;
        }
        if (typeof val !== "boolean") {
          res.status(400).json({ ok: false, error: `consents.${key} must be boolean.` });
          return;
        }
      }

      const updated = await withTransaction(pool, async (client) => {
        for (const [key, val] of entries) {
          const granted = Boolean(val);
          await client.query(
            `
              INSERT INTO workspace_user_consents (
                workspace_id,
                user_id,
                consent_key,
                granted,
                granted_at,
                revoked_at,
                updated_at
              )
              VALUES ($1, $2, $3, $4, CASE WHEN $4 THEN NOW() ELSE NULL END, CASE WHEN $4 THEN NULL ELSE NOW() END, NOW())
              ON CONFLICT (workspace_id, user_id, consent_key)
              DO UPDATE SET
                granted = EXCLUDED.granted,
                granted_at = EXCLUDED.granted_at,
                revoked_at = EXCLUDED.revoked_at,
                updated_at = NOW()
            `,
            [ctx.workspaceId, ctx.userId, key, granted]
          );
        }

        const { rows } = await client.query(
          `
            SELECT consent_key, granted, granted_at, revoked_at, updated_at
            FROM workspace_user_consents
            WHERE workspace_id = $1 AND user_id = $2
            ORDER BY updated_at DESC
          `,
          [ctx.workspaceId, ctx.userId]
        );
        return rows;
      });

      res.json({ ok: true, consents: updated });
    })
  );

  router.get(
    "/preference-modes",
    asyncHandler(async (req, res) => {
      const ctx = (req as any).workspaceContext as WorkspaceContext;
      const { rows } = await pool.query(
        `
          SELECT
            mode_key,
            display_name,
            description,
            is_active,
            content,
            updated_at
          FROM workspace_user_preference_modes
          WHERE workspace_id = $1
            AND user_id = $2
          ORDER BY is_active DESC, updated_at DESC
        `,
        [ctx.workspaceId, ctx.userId]
      );
      res.json({ ok: true, modes: rows });
    })
  );

  router.post(
    "/preference-modes",
    asyncHandler(async (req, res) => {
      const ctx = (req as any).workspaceContext as WorkspaceContext;
      const modeKey = String(req.body?.mode_key || "").trim();
      const displayName = String(req.body?.display_name || "").trim();
      const description = req.body?.description != null ? String(req.body?.description || "").trim() : null;
      const content = req.body?.content ?? {};

      if (!modeKey || !modeKey.match(/^[a-z][a-z0-9_]{2,63}$/)) {
        res.status(400).json({ ok: false, error: "mode_key must match ^[a-z][a-z0-9_]{2,63}$." });
        return;
      }
      if (!displayName) {
        res.status(400).json({ ok: false, error: "display_name is required." });
        return;
      }
      if (!content || typeof content !== "object" || Array.isArray(content)) {
        res.status(400).json({ ok: false, error: "content must be a JSON object." });
        return;
      }

      const mode = await withTransaction(pool, async (client) => {
        const { rows } = await client.query(
          `
            INSERT INTO workspace_user_preference_modes (
              workspace_id,
              user_id,
              mode_key,
              display_name,
              description,
              content,
              is_active
            )
            VALUES ($1, $2, $3, $4, $5, $6::jsonb, FALSE)
            ON CONFLICT (workspace_id, user_id, mode_key)
            DO UPDATE SET
              display_name = EXCLUDED.display_name,
              description = EXCLUDED.description,
              content = EXCLUDED.content,
              updated_at = NOW()
            RETURNING mode_key, display_name, description, is_active, content, updated_at
          `,
          [ctx.workspaceId, ctx.userId, modeKey, displayName, description, JSON.stringify(content)]
        );
        return rows[0];
      });

      res.status(201).json({ ok: true, mode });
    })
  );

  router.post(
    "/preference-modes/preview",
    asyncHandler(async (req, res) => {
      const content = req.body?.content ?? {};
      if (!content || typeof content !== "object" || Array.isArray(content)) {
        res.status(400).json({ ok: false, error: "content must be a JSON object." });
        return;
      }
      const preview = previewWorkabilityPolicy(content);
      res.json({ ok: true, ...preview });
    })
  );

  router.post(
    "/preference-modes/activate",
    asyncHandler(async (req, res) => {
      const ctx = (req as any).workspaceContext as WorkspaceContext;
      const modeKey = String(req.body?.mode_key || "").trim();
      if (!modeKey) {
        res.status(400).json({ ok: false, error: "mode_key is required." });
        return;
      }

      const activation = await withTransaction(pool, async (client) => {
        await client.query(
          `
            UPDATE workspace_user_preference_modes
            SET is_active = FALSE, updated_at = NOW()
            WHERE workspace_id = $1
              AND user_id = $2
              AND is_active = TRUE
              AND mode_key <> $3
          `,
          [ctx.workspaceId, ctx.userId, modeKey]
        );

        const { rows } = await client.query(
          `
            UPDATE workspace_user_preference_modes
            SET is_active = TRUE, updated_at = NOW()
            WHERE workspace_id = $1
              AND user_id = $2
              AND mode_key = $3
            RETURNING mode_key, display_name, description, is_active, content, updated_at
          `,
          [ctx.workspaceId, ctx.userId, modeKey]
        );

        const mode = rows[0] || null;
        if (!mode) {
          return { mode: null, recalculationEnqueued: 0, recalculationExisting: 0 };
        }

        const recalculationCandidates = await client.query<{
          canonical_job_id: string;
          job_version_id: string;
        }>(
          `
            SELECT
              c.id AS canonical_job_id,
              COALESCE(c.latest_job_version_id, lv.id) AS job_version_id
            FROM canonical_jobs c
            LEFT JOIN LATERAL (
              SELECT id
              FROM job_versions
              WHERE workspace_id = c.workspace_id
                AND canonical_job_id = c.id
              ORDER BY observed_at DESC
              LIMIT 1
            ) lv ON TRUE
            WHERE c.workspace_id = $1
              AND COALESCE(c.processing_state, c.processing_status) <> 'MANUALLY_REMOVED'
              AND COALESCE(c.latest_job_version_id, lv.id) IS NOT NULL
            ORDER BY c.created_at ASC, c.id ASC
          `,
          [ctx.workspaceId]
        );

        let recalculationEnqueued = 0;
        let recalculationExisting = 0;
        const modeRevision = Number.isFinite(Date.parse(String(mode.updated_at)))
          ? String(Date.parse(String(mode.updated_at)))
          : crypto.randomUUID();

        for (const candidate of recalculationCandidates.rows) {
          const result = await enqueuePipelineTask(
            {
              taskType: "APPLY_HARD_GATES",
              taskKey: `APPLY_HARD_GATES:${candidate.job_version_id}:preference:${mode.mode_key}:${modeRevision}`,
              payload: {
                canonical_job_id: candidate.canonical_job_id,
                job_version_id: candidate.job_version_id,
                force_policy_recalculation: true,
                preference_mode_key: mode.mode_key,
                preference_mode_updated_at: mode.updated_at,
              },
              maxAttempts: 8,
            },
            client,
            { context: ctx }
          );
          if (result.inserted) {
            recalculationEnqueued += 1;
          } else {
            recalculationExisting += 1;
          }
        }

        return { mode, recalculationEnqueued, recalculationExisting };
      });

      if (!activation.mode) {
        res.status(404).json({ ok: false, error: "Mode not found." });
        return;
      }

      res.json({
        ok: true,
        mode: activation.mode,
        recalculation_enqueued: activation.recalculationEnqueued,
        recalculation_existing: activation.recalculationExisting,
      });
    })
  );

  router.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("Unhandled /api/v2 error:", err);
    if (res.headersSent) {
      return;
    }
    res.status(500).json({ ok: false, error: err?.message || "Unexpected server error." });
  });

  return router;
}
