import { describe, expect, it, vi } from "vitest";
import {
  cloneLane,
  deactivateLane,
  listActiveLaneRevisions,
  upsertLaneRevision,
} from "../../lanes/registry.js";
import { sha256Hex, stableStringify } from "../../config/structuredLoader.js";

describe("lanes/registry", () => {
  const ctx = {
    workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    workspaceKey: "default",
    userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    userKey: "local_user",
    role: "OWNER" as const,
  };

  const laneConfig = {
    schema_version: "2.2.0",
    lane_key: "CORE_AI_DATA",
    display_name: "Core AI & Data Engineering",
    description: "Lane description",
  };

  it("upsertLaneRevision inserts a new revision, activates it, and returns a stable content hash", async () => {
    const calls: Array<{ sql: string; params?: any[] }> = [];

    const query = vi.fn(async (sql: string, params?: any[]) => {
      calls.push({ sql, params });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO lane_identities")) {
        return { rows: [{ id: "lane-identity-1" }] };
      }
      if (sql.includes("SELECT id, revision_number") && sql.includes("FROM lane_revisions")) {
        return { rows: [] };
      }
      if (sql.includes("SELECT COALESCE(MAX(revision_number)")) {
        return { rows: [{ next: 1 }] };
      }
      if (sql.includes("INSERT INTO lane_revisions")) {
        return { rows: [{ id: "lane-rev-1" }] };
      }
      if (sql.includes("SELECT lane_revision_id") && sql.includes("FROM lane_active_revisions")) {
        return { rows: [] };
      }
      return { rows: [], rowCount: 1 };
    });

    const fakeClient = { query, release: vi.fn() } as any;
    const fakePool = { connect: vi.fn().mockResolvedValue(fakeClient) } as any;

    const expectedHash = sha256Hex(stableStringify(laneConfig));

    const result = await upsertLaneRevision(
      { laneKey: "CORE_AI_DATA", content: laneConfig },
      fakePool,
      { context: ctx }
    );

    expect(result.laneIdentityId).toBe("lane-identity-1");
    expect(result.laneRevisionId).toBe("lane-rev-1");
    expect(result.revisionNumber).toBe(1);
    expect(result.contentHash).toBe(expectedHash);
    expect(result.activated).toBe(true);
    expect(result.inserted).toBe(true);

    expect(calls.some((c) => c.sql.includes("INSERT INTO lane_active_revisions"))).toBe(true);
    expect(calls.some((c) => c.sql.includes("INSERT INTO lane_activation_events"))).toBe(true);
  });

  it("upsertLaneRevision can skip activation when activate=false", async () => {
    const calls: string[] = [];

    const query = vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO lane_identities")) {
        return { rows: [{ id: "lane-identity-2" }] };
      }
      if (sql.includes("SELECT id, revision_number") && sql.includes("FROM lane_revisions")) {
        return { rows: [{ id: "lane-rev-existing", revision_number: 2 }] };
      }
      return { rows: [], rowCount: 1 };
    });

    const fakeClient = { query, release: vi.fn() } as any;
    const fakePool = { connect: vi.fn().mockResolvedValue(fakeClient) } as any;

    const result = await upsertLaneRevision(
      { laneKey: "CORE_AI_DATA", content: laneConfig },
      fakePool,
      { context: ctx, activate: false }
    );

    expect(result.laneRevisionId).toBe("lane-rev-existing");
    expect(result.revisionNumber).toBe(2);
    expect(result.activated).toBe(false);
    expect(result.inserted).toBe(false);

    expect(calls.some((sql) => sql.includes("lane_active_revisions"))).toBe(false);
    expect(calls.some((sql) => sql.includes("lane_activation_events"))).toBe(false);
  });

  it("listActiveLaneRevisions parses content and returns active lanes", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM lane_identities")) {
        return {
          rows: [
            {
              lane_identity_id: "lane-identity-1",
              lane_revision_id: "lane-rev-1",
              lane_key: "CORE_AI_DATA",
              status: "ACTIVE",
              revision_number: 1,
              content_hash: "hash",
              content: laneConfig,
              activated_at: new Date().toISOString(),
            },
          ],
        };
      }
      return { rows: [] };
    });
    const fakeClient = { query, release: vi.fn() } as any;
    const fakePool = { connect: vi.fn().mockResolvedValue(fakeClient) } as any;

    const lanes = await listActiveLaneRevisions(fakePool, { context: ctx });
    expect(lanes).toHaveLength(1);
    expect(lanes[0].laneKey).toBe("CORE_AI_DATA");
    expect(lanes[0].revisionNumber).toBe(1);
    expect(lanes[0].content.display_name).toBe("Core AI & Data Engineering");
  });

  it("cloneLane throws when source lane is missing", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const fakeClient = { query, release: vi.fn() } as any;
    const fakePool = { connect: vi.fn().mockResolvedValue(fakeClient) } as any;

    await expect(
      cloneLane("MISSING", "NEW_LANE", fakePool, { context: ctx })
    ).rejects.toThrow(/no ACTIVE lane found/i);
  });

  it("deactivateLane returns true when lane was active", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("UPDATE lane_identities")) {
        return { rowCount: 1, rows: [] };
      }
      return { rows: [] };
    });
    const fakeClient = { query, release: vi.fn() } as any;
    const fakePool = { connect: vi.fn().mockResolvedValue(fakeClient) } as any;

    const changed = await deactivateLane("CORE_AI_DATA", fakePool, { context: ctx });
    expect(changed).toBe(true);
  });
});

