import { describe, expect, it } from "vitest";
import {
  buildPostingDuplicateAuditReport,
  type PostingDuplicateRecord,
} from "../../ingestion/postingDuplicateAudit.js";

function record(overrides: Partial<PostingDuplicateRecord> = {}): PostingDuplicateRecord {
  return {
    workspace_id: "workspace-1",
    canonical_job_id: "job-1",
    job_version_id: "version-1",
    source_posting_identity_hash: "source-identity-1",
    company_name: "Example AI",
    location: "Singapore, Remote",
    canonical_created_at: "2026-01-01T00:00:00.000Z",
    current_version_observation_count: 2,
    ...overrides,
  };
}

describe("read-only posting duplicate audit", () => {
  it("proposes exact-source-identity candidates only when normalized employer and location agree", () => {
    const report = buildPostingDuplicateAuditReport([
      record({ canonical_job_id: "job-1", current_version_observation_count: 2 }),
      record({
        canonical_job_id: "job-2",
        job_version_id: "version-2",
        company_name: "Example-AI",
        location: "Remote Singapore",
        canonical_created_at: "2026-02-01T00:00:00.000Z",
        current_version_observation_count: 5,
      }),
      record({
        canonical_job_id: "job-3",
        job_version_id: "version-3",
        location: "New York, United States",
      }),
      record({
        canonical_job_id: "job-4",
        job_version_id: "version-4",
        source_posting_identity_hash: "different-source-id",
      }),
    ]);

    expect(report.candidate_groups).toBe(1);
    expect(report.candidate_canonical_jobs).toBe(2);
    expect(report.proposed_duplicate_links).toBe(1);
    expect(report.identity_collision_groups).toBe(1);
    expect(report.mappings[0]).toMatchObject({
      proposed_survivor_canonical_job_id: "job-2",
      duplicate_canonical_job_ids: ["job-1"],
      disposition: "REVIEW_REQUIRED_NO_DATA_MERGED",
    });
  });

  it("does not map candidates with unknown location or fuzzy title-only similarity", () => {
    const report = buildPostingDuplicateAuditReport([
      record({ canonical_job_id: "job-1", location: "Unknown" }),
      record({ canonical_job_id: "job-2", job_version_id: "version-2", location: null }),
      record({
        canonical_job_id: "job-3",
        job_version_id: "version-3",
        source_posting_identity_hash: "unrelated-source-id",
        location: "Singapore, Remote",
      }),
    ]);

    expect(report.candidate_groups).toBe(0);
    expect(report.insufficient_identity_groups).toBe(1);
    expect(report.mappings).toEqual([]);
  });
});
