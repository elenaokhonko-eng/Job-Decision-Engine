import { describe, expect, it, vi } from "vitest";
import { aggregateVerificationQuestions } from "../../services/verificationQuestionService.js";
import type { WorkspaceContext } from "../../workspace/context.js";

const context: WorkspaceContext = {
  workspaceId: "workspace-id-1",
  workspaceKey: "default",
  userId: "user-id-1",
  userKey: "local_user",
  role: "OWNER",
};

describe("verificationQuestionService", () => {
  it("aggregates pending verification jobs into deduplicated prioritized questions", async () => {
    const executedQueries: string[] = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      executedQueries.push(sql);
      if (sql.includes("FROM canonical_jobs c") && sql.includes("NEEDS_VERIFICATION")) {
        return {
          rows: [
            {
              id: "job-1",
              title: "Senior AI Engineer",
              workplace_type: "HYBRID",
              gate_decision: "NEEDS_VERIFICATION",
              rejection_reason_codes: ["NEEDS_VERIFICATION_OFFICE_DAYS"],
              evidence_quotes: ["Hybrid work environment"],
            },
            {
              id: "job-2",
              title: "Staff ML Engineer",
              workplace_type: "HYBRID",
              gate_decision: "NEEDS_VERIFICATION",
              rejection_reason_codes: ["NEEDS_VERIFICATION_OFFICE_DAYS"],
              evidence_quotes: ["Hybrid office model"],
            },
            {
              id: "job-3",
              title: "Bioinformatics Scientist",
              workplace_type: "REMOTE",
              gate_decision: "NEEDS_VERIFICATION",
              rejection_reason_codes: ["NEEDS_VERIFICATION_DEGREE"],
              evidence_quotes: ["Master's degree in computational biology"],
            },
          ],
        };
      }
      if (sql.includes("INSERT INTO verification_questions")) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [] };
    });

    const fakeClient = { query, release: vi.fn() } as any;

    const summary = await aggregateVerificationQuestions(fakeClient, { context });

    expect(summary.discoveredPendingJobs).toBe(3);
    expect(summary.generatedQuestions).toBe(2);
    expect(summary.topQuestions[0].category).toBe("WORKPLACE_MODEL");
    expect(summary.topQuestions[0].impactJobCount).toBe(2);
    expect(summary.topQuestions[1].category).toBe("DEGREE_SUBJECT");
    expect(summary.topQuestions[1].impactJobCount).toBe(1);
  });
});
