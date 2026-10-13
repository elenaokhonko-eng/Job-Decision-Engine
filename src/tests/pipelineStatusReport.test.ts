import { describe, expect, it } from "vitest";

import { summarizeTaskStages } from "../../scripts/report_pipeline_status.js";

describe("pipeline status report", () => {
  it("reports recoverable retry and dependency waits without failing source ingestion", () => {
    const stages = summarizeTaskStages([
      {
        task_type: "PUBLISH_EMBEDDING",
        status: "RETRY_WAIT",
        task_count: 2,
        oldest_age_seconds: 30,
      },
      {
        task_type: "MATCH_PROFILE_EVIDENCE",
        status: "BLOCKED_DEPENDENCY",
        task_count: 1,
        oldest_age_seconds: 10,
      },
      {
        task_type: "NORMALIZE_OBSERVATION",
        status: "PENDING",
        task_count: 4,
        oldest_age_seconds: 4,
      },
    ]);

    expect(stages.find((stage) => stage.stage === "SOURCE_INGESTION")).toMatchObject({
      status: "IDLE",
      retry_wait: 0,
      blocked_dependency: 0,
    });
    expect(stages.find((stage) => stage.stage === "EMBEDDINGS")).toMatchObject({
      status: "WARNING",
      retry_wait: 2,
      dead_letter: 0,
    });
    expect(stages.find((stage) => stage.stage === "PROFILE_MATCH")).toMatchObject({
      status: "WARNING",
      blocked_dependency: 1,
      dead_letter: 0,
    });
    expect(stages.find((stage) => stage.stage === "NORMALIZATION")).toMatchObject({
      status: "SUCCESS",
      pending: 4,
    });
  });

  it("marks only dead-lettered work as an error stage", () => {
    const stages = summarizeTaskStages([
      {
        task_type: "ROUTE_LANE",
        status: "DEAD_LETTER",
        task_count: 1,
        oldest_age_seconds: 120,
      },
    ]);

    expect(stages.find((stage) => stage.stage === "LANE_ROUTING")).toMatchObject({
      status: "ERROR",
      dead_letter: 1,
    });
  });
});
