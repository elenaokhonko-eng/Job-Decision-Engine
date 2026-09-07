import { describe, expect, it, vi } from "vitest";
import { ensureModelRouteActiveRevision } from "../../modelRoutes/registry.js";
import { sha256Hex, stableStringify } from "../../config/structuredLoader.js";

describe("modelRoutes/registry", () => {
  const ctx = {
    workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    workspaceKey: "default",
    userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    userKey: "local_user",
    role: "OWNER" as const,
  };

  it("ensureModelRouteActiveRevision inserts a revision and activates it", async () => {
    const calls: Array<{ sql: string; params?: any[] }> = [];

    const content = {
      primary_provider: "gemini" as const,
      primary_model: "gemini-3.6-flash",
      fallback_provider: "openai" as const,
      fallback_model: "gpt-4o-mini",
    };
    const expectedHash = sha256Hex(stableStringify(content));

    const query = vi.fn(async (sql: string, params?: any[]) => {
      calls.push({ sql, params });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO model_routes")) {
        return { rows: [{ id: "route-1" }] };
      }
      if (sql.includes("FROM model_route_revisions") && sql.includes("content_hash")) {
        return { rows: [] };
      }
      if (sql.includes("SELECT COALESCE(MAX(revision_number)")) {
        return { rows: [{ next: 1 }] };
      }
      if (sql.includes("INSERT INTO model_route_revisions")) {
        return { rows: [{ id: "rev-1" }] };
      }
      if (sql.includes("FROM model_route_active_revisions")) {
        return { rows: [] };
      }
      return { rows: [], rowCount: 1 };
    });

    const fakeClient = { query, release: vi.fn() } as any;
    const fakePool = { connect: vi.fn().mockResolvedValue(fakeClient) } as any;

    const result = await ensureModelRouteActiveRevision(
      {
        routeKey: "document",
        purpose: "DOCUMENT",
        description: "doc route",
        content,
        note: "seed",
      },
      fakePool,
      { context: ctx }
    );

    expect(result.routeId).toBe("route-1");
    expect(result.revisionId).toBe("rev-1");
    expect(result.revisionNumber).toBe(1);
    expect(result.contentHash).toBe(expectedHash);
    expect(result.content.primary_provider).toBe("gemini");
    expect(result.content.fallback_provider).toBe("openai");

    expect(calls.some((c) => c.sql.includes("INSERT INTO model_route_active_revisions"))).toBe(true);
    expect(calls.some((c) => c.sql.includes("INSERT INTO model_route_activation_events"))).toBe(true);
  });
});
