import { describe, expect, it, vi } from "vitest";
import {
  aggregateVerificationQuestions,
  answerVerificationQuestion,
  dismissVerificationQuestion,
  getPendingVerificationQuestions,
} from "../../services/verificationQuestionService.js";
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
              rejection_codes: ["NEEDS_VERIFICATION_OFFICE_DAYS"],
              evidence_quotes: ["Hybrid work environment"],
            },
            {
              id: "job-2",
              title: "Staff ML Engineer",
              workplace_type: "HYBRID",
              gate_decision: "NEEDS_VERIFICATION",
              rejection_codes: ["NEEDS_VERIFICATION_OFFICE_DAYS"],
              evidence_quotes: ["Hybrid office model"],
            },
            {
              id: "job-3",
              title: "Bioinformatics Scientist",
              workplace_type: "REMOTE",
              gate_decision: "NEEDS_VERIFICATION",
              rejection_codes: ["NEEDS_VERIFICATION_DEGREE"],
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

  it("answers a verification question and resumes linked jobs to RAW_STAGED", async () => {
    const executedQueries: string[] = [];
    const taskParams: unknown[][] = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      executedQueries.push(sql);
      if (sql.includes("SELECT *") && sql.includes("FROM verification_questions")) {
        return {
          rows: [
            {
              id: "vq-1",
              workspace_id: context.workspaceId,
              question_key: "workplace:office_days",
              category: "WORKPLACE_MODEL",
              status: "PENDING",
              linked_job_ids: ["job-1", "job-2"],
            },
          ],
        };
      }
      if (sql.includes("INSERT INTO config_definitions")) return { rows: [{ id: "def-1" }] };
      if (sql.includes("SELECT id, revision_number") && sql.includes("FROM config_revisions")) {
        return { rows: [] };
      }
      if (sql.includes("SELECT COALESCE(MAX(revision_number)")) return { rows: [{ next: 1 }] };
      if (sql.includes("INSERT INTO config_revisions")) return { rows: [{ id: "rev-1" }] };
      if (sql.includes("SELECT config_revision_id") && sql.includes("FROM config_active_revisions")) {
        return { rows: [] };
      }
      if (sql.includes("SELECT c.id AS canonical_job_id")) {
        return {
          rows: [
            { canonical_job_id: "job-1", job_version_id: "version-1" },
            { canonical_job_id: "job-2", job_version_id: "version-2" },
          ],
        };
      }
      if (sql.includes("INSERT INTO pipeline_tasks")) {
        taskParams.push(params || []);
        return { rows: [{ id: "task-1" }], rowCount: 1 };
      }
      if (sql.includes("UPDATE canonical_jobs")) {
        return { rows: [], rowCount: 2 };
      }
      return { rows: [], rowCount: 1 };
    });

    const fakeClient = { query, release: vi.fn() } as any;

    const res = await answerVerificationQuestion(fakeClient, "workplace:office_days", 3, { context });
    expect(res.ok).toBe(true);
    expect(res.resumedJobCount).toBe(2);

    const updateJobSql = executedQueries.find((q) => q.includes("UPDATE canonical_jobs"));
    expect(updateJobSql).toBeDefined();
    expect(updateJobSql).toContain("SET processing_state = 'RAW_STAGED'");
    expect(executedQueries.some((q) => q.includes("change_summary"))).toBe(false);
    expect(executedQueries.some((q) => q.includes("FROM config_revisions") && q.includes("updated_at"))).toBe(false);
    expect(executedQueries.filter((q) => q === "BEGIN")).toHaveLength(1);
    expect(executedQueries.filter((q) => q === "COMMIT")).toHaveLength(1);
    expect(taskParams).toHaveLength(2);
    expect(taskParams[0][3]).toBeTruthy();
    expect(JSON.parse(String(taskParams[0][2]))).toMatchObject({
      verification_answer_revision_id: "rev-1",
    });
  });

  it("dismisses a verification question", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      return { rows: [], rowCount: 1 };
    });

    const fakeClient = { query, release: vi.fn() } as any;

    const res = await dismissVerificationQuestion(fakeClient, "workplace:office_days", { context });
    expect(res.ok).toBe(true);
  });
});
