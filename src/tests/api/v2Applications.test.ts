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

  it("creates an APPLIED handoff when the deterministic decision is current but AI evaluation is missing", async () => {
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
                // EVALUATION_MISSING means the read model found current match and decision artifacts.
                current_artifact_status: "EVALUATION_MISSING",
                current_artifact_reason: "NO_CURRENT_AI_EVALUATION",
                gate_status: "PASS",
                recommendation_eligibility: "ELIGIBLE",
                recommendation_outcome: "PRIORITY",
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

  it("requires both exact application document runs to be current and reviewed before document_ready", async () => {
    const applicationId = "11111111-1111-4111-8111-111111111111";
    const canonicalJobId = "22222222-2222-4222-8222-222222222222";
    const jobVersionId = "33333333-3333-4333-8333-333333333333";
    const cvRunId = "44444444-4444-4444-8444-444444444444";
    const letterRunId = "55555555-5555-4555-8555-555555555555";
    const profileVersionId = "66666666-6666-4666-8666-666666666666";
    const matchRunId = "77777777-7777-4777-8777-777777777777";
    const decisionId = "88888888-8888-4888-8888-888888888888";
    const requirementSetId = "99999999-9999-4999-8999-999999999999";
    const contextFingerprint = "current-document-context";
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes("FROM application_records") && sql.includes("cv_document_run_id")) {
          return { rows: [{
            id: applicationId,
            canonical_job_id: canonicalJobId,
            job_version_id: jobVersionId,
            cv_document_run_id: cvRunId,
            cover_letter_document_run_id: letterRunId,
          }] };
        }
        if (sql.includes("FROM document_runs")) {
          const documentType = params?.[4];
          const isCv = documentType === "CV";
          return { rows: [{
            id: isCv ? cvRunId : letterRunId,
            canonical_job_id: canonicalJobId,
            job_version_id: jobVersionId,
            match_run_id: matchRunId,
            profile_version_id: profileVersionId,
            deterministic_decision_id: decisionId,
            context_fingerprint: contextFingerprint,
            document_type: documentType,
            status: "COMPLETED",
            document_template_plugin_revision_id: null,
            output_manifest: { docx_sha256: isCv ? "cv-hash" : "letter-hash" },
          }] };
        }
        if (sql.includes("FROM canonical_jobs AS job")) {
          return { rows: [{
            current_job_version_id: jobVersionId,
            latest_match_run_id: matchRunId,
            latest_deterministic_decision_id: decisionId,
            active_profile_version_id: profileVersionId,
            match_run_id: matchRunId,
            match_run_job_version_id: jobVersionId,
            match_run_profile_version_id: profileVersionId,
            match_run_status: "COMPLETED",
            match_run_requirement_set_id: requirementSetId,
            active_requirement_set_id: requirementSetId,
            match_run_job_content_hash: "job-hash",
            current_job_content_hash: "job-hash",
            match_run_context_fingerprint: contextFingerprint,
            deterministic_decision_id: decisionId,
            decision_job_version_id: jobVersionId,
            decision_match_run_id: matchRunId,
            decision_context_fingerprint: contextFingerprint,
            decision_recommendation_eligibility: "ELIGIBLE",
            decision_recommendation_outcome: "REVIEW",
            gate_status: "PASS",
            recommendation_eligibility: "ELIGIBLE",
            recommendation_outcome: "REVIEW",
          }] };
        }
        if (sql.includes("FROM document_template_plugins")) return { rows: [] };
        if (sql.includes("FROM application_events")) return { rows: [{ created_at: "2026-10-24T01:00:00.000Z" }] };
        return { rows: [] };
      }),
    };
    const { baseUrl, server } = await startApp(pool);
    try {
      const response = await fetch(`${baseUrl}/applications/${applicationId}/documents`);
      const body = await response.json() as any;
      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        ok: true,
        cv_ready: true,
        cover_letter_ready: true,
        pair_current: true,
        reviewed_at: "2026-10-24T01:00:00.000Z",
        document_ready: true,
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });

  it("rate-limits repeated application document readiness reads", async () => {
    const applicationId = "11111111-1111-4111-8111-111111111111";
    const pool = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    const { baseUrl, server } = await startApp(pool);
    try {
      const responses = await Promise.all(Array.from({ length: 31 }, () =>
        fetch(`${baseUrl}/applications/${applicationId}/documents`)
      ));
      const statuses = responses.map((response) => response.status);
      expect(statuses.filter((status) => status === 404)).toHaveLength(30);
      expect(statuses.filter((status) => status === 429)).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });

  it("does not report document_ready for a CV-only application", async () => {
    const applicationId = "11111111-1111-4111-8111-111111111111";
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM application_records") && sql.includes("cv_document_run_id")) {
          return { rows: [{
            id: applicationId,
            canonical_job_id: "22222222-2222-4222-8222-222222222222",
            job_version_id: "33333333-3333-4333-8333-333333333333",
            cv_document_run_id: "44444444-4444-4444-8444-444444444444",
            cover_letter_document_run_id: null,
          }] };
        }
        return { rows: [] };
      }),
    };
    const { baseUrl, server } = await startApp(pool);
    try {
      const response = await fetch(`${baseUrl}/applications/${applicationId}/documents`);
      const body = await response.json() as any;
      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        cv_ready: false,
        cover_letter_ready: false,
        pair_current: false,
        reviewed_at: null,
        document_ready: false,
      });
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
