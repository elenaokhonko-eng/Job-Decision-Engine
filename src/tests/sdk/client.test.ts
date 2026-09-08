import { describe, expect, it, vi } from "vitest";
import { JobDecisionClient } from "../../sdk/client.js";

describe("JobDecisionClient", () => {
  it("sends auth and workspace headers and creates application handoffs", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.test/api/v2/applications");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer token-1");
      expect(headers.get("x-workspace-key")).toBe("default");
      expect(headers.get("x-user-key")).toBe("local_user");
      expect(headers.get("content-type")).toBe("application/json");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        canonical_job_id: "22222222-2222-4222-8222-222222222222",
        status: "READY_TO_APPLY",
      });
      return new Response(JSON.stringify({
        ok: true,
        application: {
          application_record_id: "11111111-1111-4111-8111-111111111111",
          canonical_job_id: "22222222-2222-4222-8222-222222222222",
          job_version_id: "33333333-3333-4333-8333-333333333333",
          title: "AI Platform Engineer",
          company: "Example Co",
          application_status: "READY_TO_APPLY",
          last_action_at: "2026-09-08T00:00:00.000Z",
          created_at: "2026-09-08T00:00:00.000Z",
          updated_at: "2026-09-08T00:00:00.000Z",
        },
      }), { status: 201, headers: { "content-type": "application/json" } });
    });

    const client = new JobDecisionClient({
      baseUrl: "https://api.test/api/v2/",
      token: "token-1",
      workspaceKey: "default",
      userKey: "local_user",
      fetchImpl: fetchMock as any,
    });

    const response = await client.createApplication({
      canonical_job_id: "22222222-2222-4222-8222-222222222222",
      status: "READY_TO_APPLY",
    });

    expect(response.application.application_status).toBe("READY_TO_APPLY");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws API error messages", async () => {
    const client = new JobDecisionClient({
      baseUrl: "https://api.test",
      fetchImpl: vi.fn(async () =>
        new Response(JSON.stringify({ ok: false, error: "bad request" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        })
      ) as any,
    });

    await expect(client.listApplications()).rejects.toThrow(/bad request/);
  });
});
