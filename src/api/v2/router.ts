import crypto from "crypto";
import express from "express";
import pg from "pg";
import { pgSslConfig } from "../../db/pgSsl.js";
import {
  DEFAULT_USER_KEY,
  DEFAULT_WORKSPACE_KEY,
  resolveWorkspaceContext,
  type WorkspaceContext,
} from "../../workspace/context.js";
import { enqueuePipelineTask } from "../../tasks/pipelineTasks.js";
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

function parsePositiveInt(value: unknown, fallback: number, options?: { min?: number; max?: number }): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  const candidate = Number.isFinite(parsed) ? parsed : fallback;
  const min = options?.min ?? 1;
  const max = options?.max ?? 1000;
  return Math.max(min, Math.min(max, candidate));
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
    new pg.Pool({
      connectionString: requiredDatabaseUrl(),
      ssl: pgSslConfig(process.env.DATABASE_URL),
    });

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
            s.document_ready
          FROM v_canonical_shortlist s
          JOIN canonical_jobs c_ws ON c_ws.id = s.canonical_job_id
          WHERE c_ws.workspace_id = $1
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
          FROM v_rejected_jobs_audit a
          JOIN canonical_jobs c_ws ON c_ws.id = a.id
          WHERE c_ws.workspace_id = $1
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

  router.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("Unhandled /api/v2 error:", err);
    if (res.headersSent) {
      return;
    }
    res.status(500).json({ ok: false, error: err?.message || "Unexpected server error." });
  });

  return router;
}
