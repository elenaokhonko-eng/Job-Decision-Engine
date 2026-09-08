import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createApiV2Router } from "../../api/v2/router.js";
import type { WorkspaceContext } from "../../workspace/context.js";

describe("api/v2 application tracker", () => {
  const ctx: WorkspaceContext = {
    workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    workspaceKey: "default",
    userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    userKey: "local_user",
    role: "OWNER",
  };

  function trackerRow(overrides: Record<string, unknown> = {}) {
    return {
      application_record_id: "11111111-1111-4111-8111-111111111111",
      canonical_job_id: "22222222-2222-4222-8222-222222222222",
      job_version_id: "33333333-3333-4333-8333-333333333333",
      title: "AI Platform Engineer",
      company: "Example Co",
      canonical_url: "https://example.test/jobs/1",
      processing_state: "MATCHED",
      processing_status: "MATCHED",
      recommendation_eligibility: "ELIGIBLE",
      recommendation_outcome: "PRIORITY",
      primary_lane: "CORE_AI_DATA",
      secondary_lanes: [],
      application_status: "READY_TO_APPLY",
      submission_url: "https://example.test/apply",
      cv_document_run_id: null,
      cover_letter_document_run_id: null,
      notes: "Ready",
      handoff_payload: {},
      target_submit_at: null,
      submitted_at: null,
      follow_up_at: null,
      last_action_at: "2026-09-08T00:00:00.000Z",
      created_at: "2026-09-08T00:00:00.000Z",
      updated_at: "2026-09-08T00:00:00.000Z",
      ...overrides,
    };
  }

  async function startApp(pool: any): Promise<{ baseUrl: string; server: Server }> {
    const app = express();
    app.use("/api/v2", createApiV2Router({
      pool,
      resolveContext: vi.fn(async () => ctx),
    }));
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    return { baseUrl: `http://127.0.0.1:${address.port}/api/v2`, server };
  }

  it("creates a human application handoff with an event trail", async () => {
    const txQueries: Array<{ sql: string; params?: any[] }> = [];
    const tx = {
      query: vi.fn(async (sql: string, params?: any[]) => {
        txQueries.push({ sql, params });
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
          return { rows: [] };
        }
        if (sql.includes("FROM canonical_jobs c") && sql.includes("JOIN job_versions jv")) {
          return {
            rows: [
              {
                canonical_job_id: "22222222-2222-4222-8222-222222222222",
                job_version_id: "33333333-3333-4333-8333-333333333333",
                canonical_url: "https://example.test/apply",
              },
            ],
          };
        }
        if (sql.includes("FROM application_records") && sql.includes("canonical_job_id")) {
          return { rows: [] };
        }
        if (sql.includes("INSERT INTO application_records")) {
          return { rows: [{ id: "11111111-1111-4111-8111-111111111111" }] };
        }
        if (sql.includes("INSERT INTO application_events")) {
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("FROM v_application_tracker")) {
          return { rows: [trackerRow()] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => tx),
      query: vi.fn(async () => ({ rows: [] })),
    };
    const { baseUrl, server } = await startApp(pool);
    try {
      const response = await fetch(`${baseUrl}/applications`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          canonical_job_id: "22222222-2222-4222-8222-222222222222",
          status: "READY_TO_APPLY",
          notes: "Ready",
          handoff_payload: { checklist: ["cv", "cover_letter"] },
        }),
      });
      const body = await response.json() as any;

      expect(response.status).toBe(201);
      expect(body.application.application_status).toBe("READY_TO_APPLY");
      expect(txQueries.some((call) => call.sql.includes("INSERT INTO application_records"))).toBe(true);
      const eventCall = txQueries.find((call) => call.sql.includes("INSERT INTO application_events"));
      expect(eventCall?.params?.[2]).toBe("CREATED");
      expect(eventCall?.params?.[4]).toBe("READY_TO_APPLY");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });

  it("rejects invalid application handoff inputs before opening a transaction", async () => {
    const pool = {
      connect: vi.fn(),
      query: vi.fn(async () => ({ rows: [] })),
    };
    const { baseUrl, server } = await startApp(pool);
    try {
      const response = await fetch(`${baseUrl}/applications`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          canonical_job_id: "not-a-uuid",
          target_submit_at: "not-a-date",
        }),
      });
      const body = await response.json() as any;

      expect(response.status).toBe(400);
      expect(body.ok).toBe(false);
      expect(pool.connect).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });

  it("updates an application status and appends a status-change event", async () => {
    const txQueries: Array<{ sql: string; params?: any[] }> = [];
    const tx = {
      query: vi.fn(async (sql: string, params?: any[]) => {
        txQueries.push({ sql, params });
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
          return { rows: [] };
        }
        if (sql.includes("FROM application_records") && sql.includes("id = $3::uuid")) {
          return { rows: [{ id: "11111111-1111-4111-8111-111111111111", status: "READY_TO_APPLY" }] };
        }
        if (sql.includes("UPDATE application_records")) {
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO application_events")) {
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("FROM v_application_tracker")) {
          return { rows: [trackerRow({ application_status: "SUBMITTED", submitted_at: "2026-09-08T01:00:00.000Z" })] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => tx),
      query: vi.fn(async () => ({ rows: [] })),
    };
    const { baseUrl, server } = await startApp(pool);
    try {
      const response = await fetch(`${baseUrl}/applications/11111111-1111-4111-8111-111111111111`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "SUBMITTED",
          notes: "Submitted via company portal",
        }),
      });
      const body = await response.json() as any;

      expect(response.status).toBe(200);
      expect(body.application.application_status).toBe("SUBMITTED");
      const eventCall = txQueries.find((call) => call.sql.includes("INSERT INTO application_events"));
      expect(eventCall?.params?.[2]).toBe("STATUS_CHANGED");
      expect(eventCall?.params?.[3]).toBe("READY_TO_APPLY");
      expect(eventCall?.params?.[4]).toBe("SUBMITTED");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });
});
