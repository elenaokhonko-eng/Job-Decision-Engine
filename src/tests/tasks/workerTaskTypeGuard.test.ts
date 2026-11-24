import { describe, expect, it } from "vitest";

import { PIPELINE_STAGE_TASK_TYPES } from "../../tasks/stageTaskWorker.js";
import { DEFAULT_WORKER_TASK_TYPES, checkWorkerTaskTypes, missingDefaultTaskTypes } from "../../tasks/workerTaskTypeGuard.js";

describe("worker task-type guard", () => {
  it("the default types are every stage type except the optional quoted extraction", () => {
    expect(DEFAULT_WORKER_TASK_TYPES).toEqual(PIPELINE_STAGE_TASK_TYPES.filter((type) => type !== "EXTRACT_QUOTED_REQUIREMENTS"));
    expect(DEFAULT_WORKER_TASK_TYPES).toContain("PUBLISH_EMBEDDING");
    expect(DEFAULT_WORKER_TASK_TYPES).toContain("RECHECK_AVAILABILITY");
  });

  it("an unset, empty or complete list misses nothing", () => {
    expect(missingDefaultTaskTypes(undefined)).toEqual([]);
    expect(missingDefaultTaskTypes("  ")).toEqual([]);
    expect(missingDefaultTaskTypes(DEFAULT_WORKER_TASK_TYPES.join(","))).toEqual([]);
  });

  it("a list without the embedding or re-check stage is reported", () => {
    const withoutEmbed = DEFAULT_WORKER_TASK_TYPES.filter((type) => type !== "PUBLISH_EMBEDDING").join(",");
    expect(missingDefaultTaskTypes(withoutEmbed)).toEqual(["PUBLISH_EMBEDDING"]);
    expect(missingDefaultTaskTypes("APPLY_HARD_GATES,ROUTE_LANE")).toContain("RECHECK_AVAILABILITY");
  });

  it("a scheduled run fails, a local run only warns, and a complete list is fine in both", () => {
    const partial = "APPLY_HARD_GATES,ROUTE_LANE";
    expect(checkWorkerTaskTypes(partial, { GITHUB_ACTIONS: "true" }).action).toBe("FAIL");
    expect(checkWorkerTaskTypes(partial, {}).action).toBe("WARN");
    expect(checkWorkerTaskTypes(DEFAULT_WORKER_TASK_TYPES.join(","), { GITHUB_ACTIONS: "true" }).action).toBe("OK");
    expect(checkWorkerTaskTypes(undefined, { GITHUB_ACTIONS: "true" }).action).toBe("OK");
  });
});
