/**
 * Employer-confirmed job facts over the authenticated v2 API.
 *
 *   POST /api/v2/jobs/:canonical_job_id/confirmed-facts
 *     { job_version_id, fact_type, value, source_type, source_note?, source_url? }
 *   POST /api/v2/jobs/:canonical_job_id/confirmed-facts/:confirmed_fact_id/withdraw
 *     { job_version_id, reason? }
 *   GET  /api/v2/jobs/:canonical_job_id/confirmed-facts
 *
 * POST appends the fact for the job's current version (superseding the current fact of that type),
 * stores how it compares with the posting (a confirmation that contradicts the posting is kept as a
 * conflict and never applied) and enqueues the hard-gate re-run in the same transaction; the stage
 * worker does the rest. Withdraw supersedes the current confirmation with an audited WITHDRAWAL. GET
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
  JobConfirmedFactWithdrawRequestSchema,
  type JobConfirmedFactResponse,
  type JobConfirmedFactsListResponse,
} from "../../contracts/jobConfirmedFacts.js";
import {
  ConfirmedFactRequestError,
  canWriteConfirmedFacts,
  loadConfirmedFactHistory,
  loadJobVerificationChecks,
  recordConfirmedJobFact,
  withdrawConfirmedJobFact,
  type RecordConfirmedFactResult,
} from "../../services/jobConfirmedFactService.js";
import type { WorkspaceContext } from "../../workspace/context.js";

export interface JobConfirmedFactsRouterDeps {
  readonly pool: pg.Pool;
  readonly resolveContext: (req: express.Request) => WorkspaceContext;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A database CHECK or trigger rejection of client input is a 400, not a server error. */
function isInputRejection(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "23514" || code === "22P02";
}

function factResponse(result: RecordConfirmedFactResult): JobConfirmedFactResponse {
  return {
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
}

async function respond(
  res: express.Response,
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<RecordConfirmedFactResult>,
): Promise<void> {
  const client = await pool.connect();
  try {
    res.status(201).json(factResponse(await work(client)));
  } catch (error) {
    if (error instanceof ConfirmedFactRequestError) {
      res.status(error.status).json({ ok: false, error: error.code, message: error.message });
      return;
    }
    if (isInputRejection(error)) {
      res.status(400).json({ ok: false, error: "INVALID_REQUEST", message: "The confirmed fact was rejected by the database constraints." });
      return;
    }
    throw error;
  } finally {
    client.release();
  }
}

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
      if (!canWriteConfirmedFacts(ctx)) {
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
      await respond(res, deps.pool, (client) => recordConfirmedJobFact(client, ctx, canonicalJobId, parsed.data));
    }),
  );

  router.post(
    "/:canonical_job_id/confirmed-facts/:confirmed_fact_id/withdraw",
    asyncRoute(async (req, res) => {
      const ctx = deps.resolveContext(req);
      if (!canWriteConfirmedFacts(ctx)) {
        res.status(403).json({ ok: false, error: "FORBIDDEN", message: "A writable workspace role is required to withdraw a confirmed fact." });
        return;
      }
      const canonicalJobId = String(req.params.canonical_job_id || "");
      const confirmedFactId = String(req.params.confirmed_fact_id || "");
      if (!UUID_PATTERN.test(canonicalJobId) || !UUID_PATTERN.test(confirmedFactId)) {
        res.status(400).json({ ok: false, error: "INVALID_ID", message: "canonical_job_id and confirmed_fact_id must be UUIDs." });
        return;
      }
      const parsed = JobConfirmedFactWithdrawRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          ok: false,
          error: "INVALID_REQUEST",
          message: "Body must be { job_version_id, reason? }.",
          details: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        });
        return;
      }
      await respond(res, deps.pool, (client) =>
        withdrawConfirmedJobFact(client, ctx, canonicalJobId, confirmedFactId, parsed.data));
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
