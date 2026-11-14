import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSupportIssuesRouter } from "../../api/v2/supportIssuesRouter.js";
import { createApiV2Router } from "../../api/v2/router.js";
import {
  JobSupportActionRequestSchema,
  JobSupportIssuesResponseSchema,
  type JobSupportActionResult,
} from "../../contracts/jobStatus.js";
import { SupportActionError } from "../../services/jobSupportIssues.js";
import type { WorkspaceContext } from "../../workspace/context.js";

const context: WorkspaceContext = {
  workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  workspaceKey: "default",
  userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  userKey: "local_user",
  role: "OWNER",
};
const JOB_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const VERSION_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RESULT: JobSupportActionResult = {
  schema_version: "job_support_action_v1",
  ok: true,
  canonical_job_id: JOB_ID,
  action: "RETRY",
  outcome: "APPLIED",
  audit_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  message: "Queued 1 failed pipeline step(s) to run again.",
  task_ids: ["ffffffff-ffff-4fff-8fff-ffffffffffff"],
  observation_id: null,
};

let server: Server | null = null;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

async function start(deps: Partial<Parameters<typeof createSupportIssuesRouter>[0]>): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use("/support-issues", createSupportIssuesRouter({
    pool: {} as never,
    resolveContext: () => context,
    ...deps,
  }));
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ ok: false, error: error.message });
  });
  server = createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/support-issues`;
}

async function post(url: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

describe("support issues router", () => {
  it("lists issues with the read-model contract", async () => {
    const listIssues = vi.fn(async () => [{
      workspace_id: context.workspaceId,
      canonical_job_id: JOB_ID,
      job_version_id: VERSION_ID,
      title: "Data engineer",
      company: "Example Co",
      canonical_url: "https://example.test/jobs/1",
      source: "GMAIL_ALERT",
      processing_state: "PROCESSING_ERROR",
      recommendation_outcome: "SKIP",
      issue_class: "DESCRIPTION_INCOMPLETE" as const,
      issue_detail: "DESCRIPTION_CONTENT_INCOMPLETE",
      repair_action: "FETCH_OR_PROVIDE_FULL_POSTING",
      task_ids: [],
      task_types: ["ROUTE_LANE"],
      retryable: false,
      fetchable_source: true,
      available_actions: ["FETCH_DESCRIPTION" as const, "PASTE_DESCRIPTION" as const, "DISMISS" as const],
      detected_at: null,
    }]);
    const baseUrl = await start({ listIssues });
    const response = await fetch(baseUrl);
    expect(response.status).toBe(200);
    const body = JobSupportIssuesResponseSchema.parse(await response.json());
    expect(body.issues[0]?.available_actions).toEqual(["FETCH_DESCRIPTION", "PASTE_DESCRIPTION", "DISMISS"]);
    expect(listIssues).toHaveBeenCalledWith(expect.anything(), context);
  });

  it("validates the action body before calling the service", async () => {
    const performAction = vi.fn(async () => RESULT);
    const baseUrl = await start({ performAction });

    expect((await post(`${baseUrl}/not-a-uuid/actions`, {})).status).toBe(400);
    const missingText = await post(`${baseUrl}/${JOB_ID}/actions`, {
      job_version_id: VERSION_ID, issue_class: "DESCRIPTION_INCOMPLETE", action: "PASTE_DESCRIPTION",
    });
    expect(missingText.status).toBe(400);
    expect(missingText.body.error).toBe("INVALID_REQUEST");
    const unknownAction = await post(`${baseUrl}/${JOB_ID}/actions`, {
      job_version_id: VERSION_ID, issue_class: "TASK_DEAD_LETTER", action: "DELETE",
    });
    expect(unknownAction.status).toBe(400);
    const extraField = await post(`${baseUrl}/${JOB_ID}/actions`, {
      job_version_id: VERSION_ID, issue_class: "TASK_DEAD_LETTER", action: "RETRY", force: true,
    });
    expect(extraField.status).toBe(400);
    expect(performAction).not.toHaveBeenCalled();

    const ok = await post(`${baseUrl}/${JOB_ID}/actions`, {
      job_version_id: VERSION_ID, issue_class: "TASK_DEAD_LETTER", action: "RETRY",
    });
    expect(ok.status).toBe(201);
    expect(ok.body).toEqual(RESULT);
    expect(performAction).toHaveBeenCalledWith(expect.anything(), context, JOB_ID, {
      job_version_id: VERSION_ID, issue_class: "TASK_DEAD_LETTER", action: "RETRY",
    });
  });

  it("maps service refusals to their HTTP status and code", async () => {
    const performAction = vi.fn(async () => {
      throw new SupportActionError(409, "ISSUE_NOT_OPEN", "This issue is no longer open. Refresh the list.");
    });
    const retryAll = vi.fn(async () => {
      throw new SupportActionError(403, "FORBIDDEN", "A writable workspace role is required.");
    });
    const baseUrl = await start({ performAction, retryAll });
    const refused = await post(`${baseUrl}/${JOB_ID}/actions`, {
      job_version_id: VERSION_ID, issue_class: "TASK_DEAD_LETTER", action: "DISMISS",
    });
    expect(refused).toEqual({
      status: 409,
      body: { ok: false, error: "ISSUE_NOT_OPEN", message: "This issue is no longer open. Refresh the list." },
    });
    const forbidden = await post(`${baseUrl}/retry-all`, {});
    expect(forbidden.status).toBe(403);
  });

  it("is mounted behind the v2 bearer-token authentication", async () => {
    const previous = process.env.JDEC_API_TOKEN;
    process.env.JDEC_API_TOKEN = "unit-test-token";
    try {
      const app = express();
      app.use("/api/v2", createApiV2Router({ pool: { query: vi.fn() } as never, resolveContext: vi.fn(async () => context) }));
      server = createServer(app);
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/v2/support-issues/retry-all`;
      const response = await fetch(url, { method: "POST" });
      expect(response.status).toBe(401);
    } finally {
      if (previous === undefined) delete process.env.JDEC_API_TOKEN;
      else process.env.JDEC_API_TOKEN = previous;
    }
  });
});

describe("support action request contract", () => {
  it("accepts a pasted description only for PASTE_DESCRIPTION", () => {
    const base = { job_version_id: VERSION_ID, issue_class: "DESCRIPTION_INCOMPLETE" as const };
    expect(JobSupportActionRequestSchema.safeParse({ ...base, action: "PASTE_DESCRIPTION", description: "x".repeat(250) }).success).toBe(true);
    expect(JobSupportActionRequestSchema.safeParse({ ...base, action: "PASTE_DESCRIPTION", description: "x".repeat(50) }).success).toBe(false);
    expect(JobSupportActionRequestSchema.safeParse({ ...base, action: "DISMISS", description: "x".repeat(250) }).success).toBe(false);
    expect(JobSupportActionRequestSchema.safeParse({ ...base, action: "FETCH_DESCRIPTION" }).success).toBe(true);
  });
});
