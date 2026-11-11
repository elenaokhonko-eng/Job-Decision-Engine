/**
 * Employer-confirmed job facts over the authenticated v2 API.
 *
 *   POST /api/v2/jobs/:canonical_job_id/confirmed-facts
 *     { job_version_id, fact_type, value, source_type, source_note?, source_url? }
 *   GET  /api/v2/jobs/:canonical_job_id/confirmed-facts
 *
 * POST appends the fact for the job's current version (superseding the current fact of that type)
 * and enqueues the hard-gate re-run in the same transaction; the stage worker does the rest. GET
 * returns the job's verification read model (open checks, confirmed facts, the gate's workability
 * facts) and the fact history of its current version.
 *
 * Mounted after authentication and workspace resolution; every query is scoped to the workspace.
 */
import express from "express";
import pg from "pg";

import {
  JOB_CONFIRMED_FACT_SCHEMA_VERSION,
  JobConfirmedFactRequestSchema,
  type JobConfirmedFactResponse,
  type JobConfirmedFactsListResponse,
} from "../../contracts/jobConfirmedFacts.js";
import {
  ConfirmedFactRequestError,
  loadConfirmedFactHistory,
  loadJobVerificationChecks,
  recordConfirmedJobFact,
} from "../../services/jobConfirmedFactService.js";
import type { WorkspaceContext } from "../../workspace/context.js";

export interface JobConfirmedFactsRouterDeps {
  readonly pool: pg.Pool;
  readonly resolveContext: (req: express.Request) => WorkspaceContext;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function asyncRoute(
  handler: (req: express.Request, res: express.Response) => Promise<void>,
): express.RequestHandler {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

export function createJobConfirmedFactsRouter(deps: JobConfirmedFactsRouterDeps): express.Router {
  const router = express.Router();

  router.post(
    "/:canonical_job_id/confirmed-facts",
    asyncRoute(async (req, res) => {
      const ctx = deps.resolveContext(req);
      if (ctx.role === "READER") {
        res.status(403).json({ ok: false, error: "FORBIDDEN", message: "A writable workspace role is required to record a confirmed fact." });
        return;
      }
      const canonicalJobId = String(req.params.canonical_job_id || "");
      if (!UUID_PATTERN.test(canonicalJobId)) {
        res.status(400).json({ ok: false, error: "INVALID_JOB_ID", message: "canonical_job_id must be a UUID." });
        return;
      }
      const parsed = JobConfirmedFactRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          ok: false,
          error: "INVALID_REQUEST",
          message: "Body must be { job_version_id, fact_type, value, source_type, source_note?, source_url? } with a value matching the fact type.",
          details: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        });
        return;
      }
      const client = await deps.pool.connect();
      try {
        const result = await recordConfirmedJobFact(client, ctx, canonicalJobId, parsed.data);
        const response: JobConfirmedFactResponse = {
          ok: true,
          schema_version: JOB_CONFIRMED_FACT_SCHEMA_VERSION,
          fact: result.fact,
          superseded_fact_id: result.supersededFactId,
          rerun: {
            task_type: result.rerun.taskType,
            task_id: result.rerun.taskId,
            task_key: result.rerun.taskKey,
            inserted: result.rerun.inserted,
          },
        };
        res.status(201).json(response);
      } catch (error) {
        if (error instanceof ConfirmedFactRequestError) {
          res.status(error.status).json({ ok: false, error: error.code, message: error.message });
          return;
        }
        throw error;
      } finally {
        client.release();
      }
    }),
  );

  router.get(
    "/:canonical_job_id/confirmed-facts",
    asyncRoute(async (req, res) => {
      const ctx = deps.resolveContext(req);
      const canonicalJobId = String(req.params.canonical_job_id || "");
      if (!UUID_PATTERN.test(canonicalJobId)) {
        res.status(400).json({ ok: false, error: "INVALID_JOB_ID", message: "canonical_job_id must be a UUID." });
        return;
      }
      const checks = await loadJobVerificationChecks(deps.pool, ctx, canonicalJobId);
      const history = checks
        ? await loadConfirmedFactHistory(deps.pool, ctx, canonicalJobId, checks.job_version_id)
        : [];
      const response: JobConfirmedFactsListResponse = { ok: true, checks, history };
      res.json(response);
    }),
  );

  return router;
}
