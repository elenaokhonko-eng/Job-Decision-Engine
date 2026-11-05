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

  function readinessRow(readinessStatus: string | null, reasonCodes: string[] = []) {
    const expiresAt = "2099-01-01T00:00:00.000Z";
    const fingerprint = "a".repeat(64);
    const status = readinessStatus ?? "READY";
    const nonReadyCheckStatus = status === "BLOCKED" || status === "NEEDS_VERIFICATION" || status === "PROCESSING"
      ? status
      : "MET";
    const readinessReason = reasonCodes[0] ?? null;
    const applicationReadiness = {
      schema_version: "application_readiness_v1",
      status,
      reason_codes: reasonCodes,
      checks: [{
        key: "COMPENSATION",
        status: nonReadyCheckStatus,
        importance: status === "READY" ? "PREFERRED" : "MUST",
        reason_code: status === "READY" ? null : readinessReason,
        rationale: "Deterministic application readiness fixture.",
        evidence_keys: [],
        policy_reference: null,
        assessed_at: "2098-01-01T00:00:00.000Z",
        expires_at: null,
      }],
      canonical_job_id: "22222222-2222-4222-8222-222222222222",
      job_version_id: "33333333-3333-4333-8333-333333333333",
      profile_version_id: null,
      requirement_set_id: null,
      match_run_id: null,
      preference_context_id: null,
      policy_snapshot_id: null,
      policy_version: "test-policy-v1",
      qualification_comparator_version: "test-comparator-v1",
      evidence_revision_hash: "b".repeat(64),
      readiness_fingerprint: fingerprint,
      evaluated_at: "2098-01-01T00:00:00.000Z",
      expires_at: expiresAt,
    };
    return {
      application_readiness: applicationReadiness,
      readiness_status: readinessStatus,
      readiness_fingerprint: fingerprint,
      readiness_expires_at: new Date(expiresAt),
      readiness_reason_codes: reasonCodes,
      canonical_job_id: "22222222-2222-4222-8222-222222222222",
      job_version_id: "33333333-3333-4333-8333-333333333333",
      profile_version_id: null,
      requirement_set_id: null,
      match_run_id: null,
      evidence_revision_hash: "b".repeat(64),
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

  it("creates an APPLIED handoff when the deterministic decision is current but AI evaluation is missing", async () => {
    const txQueries: Array<{ sql: string; params?: any[] }> = [];
    const tx = {
      query: vi.fn(async (sql: string, params?: any[]) => {
        txQueries.push({ sql, params });
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
          return { rows: [] };
        }
        if (sql.includes("to_regclass('v_application_readiness_current')")) {
          return { rows: [{ available: true }] };
        }
        if (sql.includes("FROM v_application_readiness_current")) {
          return { rows: [readinessRow("READY")] };
        }
        if (sql.includes("FROM canonical_jobs c") && sql.includes("JOIN job_versions jv")) {
          return {
            rows: [
              {
                canonical_job_id: "22222222-2222-4222-8222-222222222222",
                job_version_id: "33333333-3333-4333-8333-333333333333",
                canonical_url: "https://example.test/apply",
                // EVALUATION_MISSING means the read model found current match and decision artifacts.
                current_artifact_status: "EVALUATION_MISSING",
                current_artifact_reason: "NO_CURRENT_AI_EVALUATION",
                gate_status: "PASS",
                recommendation_eligibility: "ELIGIBLE",
                recommendation_outcome: "PRIORITY",
                readiness_status: "READY",
                readiness_fingerprint: "a".repeat(64),
                readiness_expires_at: new Date("2099-01-01T00:00:00.000Z"),
                readiness_reason_codes: [],
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
          return { rows: [trackerRow({
            application_status: "APPLIED",
            submitted_at: "2026-09-08T01:00:00.000Z",
          })] };
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
          status: "APPLIED",
          notes: "Submitted via company portal",
          handoff_payload: { checklist: ["cv", "cover_letter"] },
        }),
      });
      const body = await response.json() as any;

      expect(response.status).toBe(201);
      expect(body.application.application_status).toBe("APPLIED");
      expect(body.application.submitted_at).toBe("2026-09-08T01:00:00.000Z");
      const insertCall = txQueries.find((call) => call.sql.includes("INSERT INTO application_records"));
      expect(insertCall?.sql).toContain("CASE WHEN $5 IN ('SUBMITTED', 'APPLIED') THEN NOW() ELSE NULL END");
      const eventCall = txQueries.find((call) => call.sql.includes("INSERT INTO application_events"));
      expect(eventCall?.params?.[2]).toBe("CREATED");
      expect(eventCall?.params?.[4]).toBe("APPLIED");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });

  it.each(["NEEDS_VERIFICATION", "PROCESSING", "BLOCKED", null])(
    "blocks application handoff when current readiness is %s",
    async (readinessStatus) => {
      const txQueries: string[] = [];
      const tx = {
        query: vi.fn(async (sql: string) => {
          txQueries.push(sql);
          if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
            return { rows: [] };
          }
          if (sql.includes("to_regclass('v_application_readiness_current')")) {
            return { rows: [{ available: true }] };
          }
          if (sql.includes("FROM v_application_readiness_current")) {
            const reasons = readinessStatus === "NEEDS_VERIFICATION" ? ["SALARY_BASIS_UNRESOLVED"] : [];
            return { rows: [readinessRow(readinessStatus, reasons)] };
          }
          if (sql.includes("FROM canonical_jobs c") && sql.includes("JOIN job_versions jv")) {
            return {
              rows: [{
                canonical_job_id: "22222222-2222-4222-8222-222222222222",
                job_version_id: "33333333-3333-4333-8333-333333333333",
                canonical_url: "https://example.test/apply",
                current_artifact_status: "EVALUATION_MISSING",
                current_artifact_reason: "NO_CURRENT_AI_EVALUATION",
                gate_status: "PASS",
                recommendation_eligibility: "ELIGIBLE",
                recommendation_outcome: "PRIORITY",
                readiness_status: readinessStatus,
                readiness_fingerprint: "a".repeat(64),
                readiness_expires_at: new Date("2099-01-01T00:00:00.000Z"),
                readiness_reason_codes: readinessStatus === "READY" ? [] : ["SALARY_BASIS_UNRESOLVED"],
              }],
            };
          }
          return { rows: [] };
        }),
        release: vi.fn(),
      };
      const pool = { connect: vi.fn(async () => tx), query: vi.fn(async () => ({ rows: [] })) };
      const { baseUrl, server } = await startApp(pool);
      try {
        const response = await fetch(`${baseUrl}/applications`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            canonical_job_id: "22222222-2222-4222-8222-222222222222",
            status: "APPLIED",
          }),
        });
        const body = await response.json() as any;

        expect(response.status).toBe(409);
        expect(body.reason).toBe(readinessStatus === "NEEDS_VERIFICATION"
          ? "SALARY_BASIS_UNRESOLVED"
          : readinessStatus ? `READINESS_${readinessStatus}` : "READINESS_NOT_COMPUTED");
        expect(txQueries.some((sql) => sql.includes("INSERT INTO application_records"))).toBe(false);
      } finally {
        await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
      }
    },
  );

  it.each([
    { artifactStatus: "MATCH_STALE", reason: "MATCH_PROFILE_VERSION_STALE" },
    { artifactStatus: "DECISION_STALE", reason: "DECISION_MATCH_RUN_STALE" },
  ])("rejects APPLIED handoff when the decision artifact is $artifactStatus", async ({ artifactStatus, reason }) => {
    const txQueries: string[] = [];
    const tx = {
      query: vi.fn(async (sql: string) => {
        txQueries.push(sql);
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
          return { rows: [] };
        }
        if (sql.includes("FROM canonical_jobs c") && sql.includes("JOIN job_versions jv")) {
          return {
            rows: [{
              canonical_job_id: "22222222-2222-4222-8222-222222222222",
              job_version_id: "33333333-3333-4333-8333-333333333333",
              canonical_url: "https://example.test/apply",
              current_artifact_status: artifactStatus,
              current_artifact_reason: reason,
              recommendation_eligibility: "ELIGIBLE",
            }],
          };
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
          status: "APPLIED",
        }),
      });
      const body = await response.json() as any;

      expect(response.status).toBe(409);
      expect(body.reason).toBe(reason);
      expect(txQueries.some((sql) => sql.includes("INSERT INTO application_records"))).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });

  it.each([
    { gate_status: "HARD_REJECT", recommendation_outcome: "PRIORITY", reason: "HARD_REJECT" },
    { gate_status: "PASS", recommendation_outcome: "TRACK", reason: "TRACK" },
  ])("rejects application handoffs outside current Apply Now outcomes", async ({ gate_status, recommendation_outcome, reason }) => {
    const txQueries: string[] = [];
    const tx = {
      query: vi.fn(async (sql: string) => {
        txQueries.push(sql);
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
          return { rows: [] };
        }
        if (sql.includes("to_regclass('v_application_readiness_current')")) {
          return { rows: [{ available: true }] };
        }
        if (sql.includes("FROM v_application_readiness_current")) {
          return { rows: [readinessRow("READY")] };
        }
        if (sql.includes("FROM canonical_jobs c") && sql.includes("JOIN job_versions jv")) {
          return {
            rows: [{
              canonical_job_id: "22222222-2222-4222-8222-222222222222",
              job_version_id: "33333333-3333-4333-8333-333333333333",
              canonical_url: "https://example.test/apply",
              current_artifact_status: "EVALUATION_MISSING",
              current_artifact_reason: "NO_CURRENT_AI_EVALUATION",
              gate_status,
              recommendation_eligibility: "ELIGIBLE",
              recommendation_outcome,
              readiness_status: "READY",
              readiness_fingerprint: "a".repeat(64),
              readiness_expires_at: new Date("2099-01-01T00:00:00.000Z"),
              readiness_reason_codes: [],
            }],
          };
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
          status: "INTENT",
        }),
      });
      // HTTP JSON is an external boundary; narrow to the response field under test.
      const body = await response.json() as { reason?: string };

      expect(response.status).toBe(409);
      expect(body.reason).toBe(reason);
      expect(txQueries.some((sql) => sql.includes("INSERT INTO application_records"))).toBe(false);
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

  it.each(["SUBMITTED", "APPLIED"])("updates an application to %s and appends a status-change event", async (status) => {
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
          return { rows: [trackerRow({ application_status: status, submitted_at: "2026-09-08T01:00:00.000Z" })] };
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
          status,
          notes: "Submitted via company portal",
        }),
      });
      const body = await response.json() as any;

      expect(response.status).toBe(200);
      expect(body.application.application_status).toBe(status);
      expect(body.application.submitted_at).toBe("2026-09-08T01:00:00.000Z");
      const updateCall = txQueries.find((call) => call.sql.includes("UPDATE application_records"));
      expect(updateCall?.sql).toContain("WHEN $4 IN ('SUBMITTED', 'APPLIED') THEN COALESCE(submitted_at, NOW())");
      expect(updateCall?.params?.[3]).toBe(status);
      const eventCall = txQueries.find((call) => call.sql.includes("INSERT INTO application_events"));
      expect(eventCall?.params?.[2]).toBe("STATUS_CHANGED");
      expect(eventCall?.params?.[3]).toBe("READY_TO_APPLY");
      expect(eventCall?.params?.[4]).toBe(status);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });
});
