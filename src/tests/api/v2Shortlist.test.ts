import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";

import { createApiV2Router } from "../../api/v2/router.js";
import type { WorkspaceContext } from "../../workspace/context.js";

const context: WorkspaceContext = {
  workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  workspaceKey: "default",
  userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  userKey: "local_user",
  role: "OWNER",
};

async function startApp(pool: object): Promise<{ baseUrl: string; server: Server }> {
  const app = express();
  app.use("/api/v2", createApiV2Router({
    pool: pool as never,
    resolveContext: vi.fn(async () => context),
  }));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}/api/v2`, server };
}

describe("api/v2 shortlist readiness projection", () => {
  it("returns the current readiness fields consumed by Streamlit eligibility", async () => {
    const readinessExpiresAt = new Date("2099-01-01T00:00:00.000Z");
    const availabilityRecheckAt = new Date("2099-01-01T00:00:00.000Z");
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("to_regclass('v_application_readiness_current')")) {
        return { rows: [{ available: true }] };
      }
      return {
        rows: [{
          canonical_job_id: "22222222-2222-4222-8222-222222222222",
          job_version_id: "33333333-3333-4333-8333-333333333333",
          title: "Data Engineer",
          company: "Example Co",
          canonical_url: "https://example.test/jobs/1",
          source: "TEST",
          location: "Remote",
          workplace_type: "REMOTE",
          employment_type: "PERMANENT",
          description: null,
          gate_status: "PASS",
          rejection_codes: [],
          gate_evidence_quotes: [],
          primary_lane: "CORE_AI_DATA",
          secondary_lanes: [],
          lane_confidence: null,
          priority_score: null,
          deterministic_match_score: null,
          deterministic_match_coverage: null,
          processing_state: "MATCHED",
          processing_status: "MATCHED",
          recommendation_eligibility: "ELIGIBLE",
          recommendation_outcome: "REVIEW",
          recommendation_requirement_score: null,
          recommendation_coverage_score: null,
          recommendation_evidence_completeness: null,
          recommendation_decided_at: null,
          nd_friendly_score: null,
          politics_stress_score: null,
          sensory_overload_index: null,
          version_mismatch: false,
          observed_at: new Date("2026-10-26T00:00:00.000Z"),
          evaluated_at: null,
          current_artifact_status: "EVALUATION_MISSING",
          current_artifact_reason: "NO_CURRENT_AI_EVALUATION",
          readiness_status: "READY",
          readiness_fingerprint: "a".repeat(64),
          readiness_expires_at: readinessExpiresAt,
          readiness_reason_codes: [],
          availability_status: "OPEN",
          availability_recheck_at: availabilityRecheckAt,
        }],
      };
    });
    const { baseUrl, server } = await startApp({ query });

    try {
      const response = await fetch(`${baseUrl}/shortlist`);
      const body = await response.json() as { jobs: Array<Record<string, unknown>> };

      expect(response.status).toBe(200);
      expect(body.jobs[0]).toMatchObject({
        readiness_status: "READY",
        readiness_fingerprint: "a".repeat(64),
        readiness_reason_codes: [],
        availability_status: "OPEN",
      });
      expect(body.jobs[0]?.readiness_expires_at).toBe("2099-01-01T00:00:00.000Z");
      expect(query.mock.calls.some(([sql]) => String(sql).includes("v_application_readiness_current"))).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
