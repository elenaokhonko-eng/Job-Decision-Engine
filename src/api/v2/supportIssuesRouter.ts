/**
 * Technical-error support actions over the authenticated v2 API (migration 112).
 *
 *   GET  /api/v2/support-issues
 *   POST /api/v2/support-issues/retry-all
 *   POST /api/v2/support-issues/:canonical_job_id/actions
 *     { job_version_id, issue_class, action, description?, note? }
 *
 * The available actions come from `v_job_support_issues_scoped.available_actions` (driven by the
 * issue class), so a new technical error gets the same actions without code changes. Mounted after
 * authentication and workspace resolution; every query is scoped to the workspace.
 */
import express from "express";
import pg from "pg";

import {
  JOB_STATUS_SCHEMA_VERSION,
  JobSupportActionRequestSchema,
  type JobSupportIssuesResponse,
} from "../../contracts/jobStatus.js";
import {
  SupportActionError,
  listSupportIssues,
  performSupportAction,
  retryAllRetryable,
} from "../../services/jobSupportIssues.js";
import type { WorkspaceContext } from "../../workspace/context.js";

export interface SupportIssuesRouterDeps {
  readonly pool: pg.Pool;
  readonly resolveContext: (req: express.Request) => WorkspaceContext;
  /** Injection points for route tests; default to the database-backed service. */
  readonly listIssues?: typeof listSupportIssues;
  readonly performAction?: typeof performSupportAction;
  readonly retryAll?: typeof retryAllRetryable;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function asyncRoute(
  handler: (req: express.Request, res: express.Response) => Promise<void>,
): express.RequestHandler {
  return (req, res, next) => {
    handler(req, res).catch((error: unknown) => {
      if (error instanceof SupportActionError) {
        res.status(error.status).json({ ok: false, error: error.code, message: error.message });
        return;
      }
      next(error);
    });
  };
}

export function createSupportIssuesRouter(deps: SupportIssuesRouterDeps): express.Router {
  const router = express.Router();
  const listIssues = deps.listIssues ?? listSupportIssues;
  const performAction = deps.performAction ?? performSupportAction;
  const retryAll = deps.retryAll ?? retryAllRetryable;
  // Bodies are parsed by the v2 router's shared 1 MB JSON parser; the request contract caps a
  // pasted description at SUPPORT_PASTED_DESCRIPTION_MAX_CHARS.

  router.get(
    "/",
    asyncRoute(async (req, res) => {
      const ctx = deps.resolveContext(req);
      const issues = await listIssues(deps.pool, ctx);
      const response: JobSupportIssuesResponse = { schema_version: JOB_STATUS_SCHEMA_VERSION, ok: true, issues };
      res.json(response);
    }),
  );

  router.post(
    "/retry-all",
    asyncRoute(async (req, res) => {
      const ctx = deps.resolveContext(req);
      res.json(await retryAll(deps.pool, ctx));
    }),
  );

  router.post(
    "/:canonical_job_id/actions",
    asyncRoute(async (req, res) => {
      const ctx = deps.resolveContext(req);
      const canonicalJobId = String(req.params.canonical_job_id || "");
      if (!UUID_PATTERN.test(canonicalJobId)) {
        res.status(400).json({ ok: false, error: "INVALID_JOB_ID", message: "canonical_job_id must be a UUID." });
        return;
      }
      const parsed = JobSupportActionRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          ok: false,
          error: "INVALID_REQUEST",
          message: "Body must be { job_version_id, issue_class, action, description?, note? }; PASTE_DESCRIPTION needs at least 200 characters of description.",
          details: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        });
        return;
      }
      res.status(201).json(await performAction(deps.pool, ctx, canonicalJobId, parsed.data));
    }),
  );

  return router;
}
