import { describe, expect, it } from "vitest";

import { countConsecutiveOldestTaskSnapshots } from "../../tasks/pipelineWorkerProgress.js";

describe("pipeline worker progress trend", () => {
  it("counts only consecutive runs with the same oldest pending task", () => {
    expect(countConsecutiveOldestTaskSnapshots([
      { oldest_pending_task_id: "task-a" },
      { oldest_pending_task_id: "task-a" },
      { oldest_pending_task_id: "task-b" },
      { oldest_pending_task_id: "task-a" },
    ], "task-a")).toBe(2);
  });

  it("resets the streak when there is no pending task", () => {
    expect(countConsecutiveOldestTaskSnapshots([
      { oldest_pending_task_id: null },
      { oldest_pending_task_id: "task-a" },
    ], null)).toBe(0);
  });
});
