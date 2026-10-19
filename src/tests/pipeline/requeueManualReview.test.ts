import { describe, expect, it, vi } from "vitest";
import {
  findCultureQuoteManualReviewCandidates,
  requeueManualReviewEvaluations,
} from "../../pipeline/requeueManualReview.js";
import type pg from "pg";

describe("requeueManualReviewEvaluations", () => {
  it("finds candidates failing on culture evidence quotes and handles dry-run without writes", async () => {
    const mockCandidates = [
      {
        queue_id: "q-1",
        canonical_job_id: "job-1",
        job_version_id: "jv-1",
        company_name: "Quincus",
        normalized_title: "machine learning engineer",
        last_error: "Evaluation culture evidence quote for SENSORY_WORKLOAD_RISK is not a verbatim substring of the job description.",
        attempt_count: 3,
        max_attempts: 3,
      },
      {
        queue_id: "q-2",
        canonical_job_id: "job-2",
        job_version_id: "jv-2",
        company_name: "Foundever",
        normalized_title: "ai product manager",
        last_error: "Evaluation culture evidence quote for AUTONOMY is not a verbatim substring of the job description.",
        attempt_count: 3,
        max_attempts: 3,
      },
    ];

    const queryMock = vi.fn().mockResolvedValue({ rows: mockCandidates });
    const mockClient = { query: queryMock } as unknown as pg.PoolClient;

    const dryRunResult = await requeueManualReviewEvaluations(mockClient, "workspace-1", {
      dryRun: true,
    });

    expect(dryRunResult.dryRun).toBe(true);
    expect(dryRunResult.candidatesFound).toBe(2);
    expect(dryRunResult.requeuedCount).toBe(0);
    expect(dryRunResult.candidates[0].companyName).toBe("Quincus");
    expect(dryRunResult.candidates[1].companyName).toBe("Foundever");

    // In dry-run, only the SELECT discovery query was executed
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("executes an audited update only for explicitly selected candidates", async () => {
    const mockCandidates = [
      {
        queue_id: "q-1",
        canonical_job_id: "job-1",
        job_version_id: "jv-1",
        company_name: "Quincus",
        normalized_title: "machine learning engineer",
        last_error: "Evaluation culture evidence quote for SENSORY_WORKLOAD_RISK is not a verbatim substring of the job description.",
        attempt_count: 3,
        max_attempts: 3,
      },
      {
        queue_id: "q-2",
        canonical_job_id: "job-2",
        job_version_id: "jv-2",
        company_name: "Foundever",
        normalized_title: "ai product manager",
        last_error: "Evaluation culture evidence quote for AUTONOMY is not a verbatim substring of the job description.",
        attempt_count: 3,
        max_attempts: 3,
      },
    ];

    const queriesExecuted: string[] = [];
    const queryMock = vi.fn().mockImplementation(async (sql: string) => {
      queriesExecuted.push(sql);
      if (sql.includes("SELECT")) {
        return { rows: mockCandidates };
      }
      return { rowCount: 1 };
    });
    const mockClient = { query: queryMock } as unknown as pg.PoolClient;

    const result = await requeueManualReviewEvaluations(mockClient, "workspace-1", {
      dryRun: false,
      queueIds: ["q-1", "q-2"],
    });

    expect(result.dryRun).toBe(false);
    expect(result.candidatesFound).toBe(2);
    expect(result.requeuedCount).toBe(2);

    // Verify SQL commands: 1 SELECT, 1 evaluation_queue UPDATE, 1 evaluation_attempts INSERT, 1 canonical_jobs UPDATE
    expect(queriesExecuted.some((q) => q.includes("UPDATE evaluation_queue") && q.includes("status = 'PENDING'"))).toBe(true);
    expect(queriesExecuted.some((q) => q.includes("INSERT INTO evaluation_attempts") && q.includes("'REQUEUED'"))).toBe(true);
    expect(queriesExecuted.some((q) => q.includes("UPDATE canonical_jobs") && q.includes("QUEUED_FOR_AI"))).toBe(true);
  });

  it("requires explicit candidate IDs before applying any requeue", async () => {
    const queryMock = vi.fn();
    const mockClient = { query: queryMock } as unknown as pg.PoolClient;

    await expect(
      requeueManualReviewEvaluations(mockClient, "workspace-1", { dryRun: false })
    ).rejects.toThrow("explicit queue IDs");

    expect(queryMock).not.toHaveBeenCalled();
  });

  it("rejects requested queue IDs that are no longer eligible", async () => {
    const queryMock = vi.fn().mockResolvedValue({ rows: [] });
    const mockClient = { query: queryMock } as unknown as pg.PoolClient;

    await expect(
      requeueManualReviewEvaluations(mockClient, "workspace-1", {
        dryRun: false,
        queueIds: ["q-stale-1", "q-stale-2"],
      })
    ).rejects.toThrow("not eligible culture-quote candidates");

    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});
