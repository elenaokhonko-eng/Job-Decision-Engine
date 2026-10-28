import { describe, expect, it, vi } from "vitest";
import pg from "pg";
import { preflightApplicationDocumentDraft } from "../../documents/applicationDocumentPreflight.js";

describe("application document source-content barrier", () => {
  it("rejects an otherwise ready draft without verified posting evidence for its current version", async () => {
    const query = vi.fn(async (_sql: string) => ({
      rows: [{
        id: "application-1",
        status: "INTENT",
        latest_job_version_id: "version-1",
        gate_status: "PASS",
        recommendation_eligibility: "ELIGIBLE",
        recommendation_outcome: "REVIEW",
        description_quality_status: "COMPLETE",
        has_source_content_evidence: false,
      }],
      rowCount: 1,
    }));
    const client = { query } as unknown as pg.PoolClient;

    await expect(preflightApplicationDocumentDraft(client, {
      workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      workspaceKey: "default",
      userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      userKey: "local_user",
      role: "OWNER",
    }, {
      applicationRecordId: "application-1",
      canonicalJobId: "canonical-1",
      jobVersionId: "version-1",
    })).rejects.toThrow("complete description quality and verified posting-source evidence");

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain("source_content_observation.source_name <> 'GMAIL_ALERT'");
  });
});
