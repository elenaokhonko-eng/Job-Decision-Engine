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
      status: "RETRYING",
      retry_wait: 2,
      dead_letter: 0,
      oldest_age_seconds: 0,
      oldest_retry_wait_age_seconds: 30,
      oldest_dead_letter_age_seconds: 0,
    });
    expect(stages.find((stage) => stage.stage === "PROFILE_MATCH")).toMatchObject({
      status: "BLOCKED",
      blocked_dependency: 1,
      dead_letter: 0,
    });
    expect(stages.find((stage) => stage.stage === "NORMALIZATION")).toMatchObject({
      status: "BACKLOG_HEALTHY",
      pending: 4,
    });
  });

  it("keeps stale superseded dead letters visible without marking the stage as an error", () => {
    const stages = summarizeTaskStages([
      {
        task_type: "PUBLISH_EMBEDDING",
        status: "DEAD_LETTER",
        task_count: 8,
        oldest_age_seconds: 120,
        actionable_dead_letter_count: 0,
        stale_historical_dead_letter_count: 8,
      },
    ]);

    expect(stages.find((stage) => stage.stage === "EMBEDDINGS")).toMatchObject({
      status: "BACKLOG_HEALTHY",
      dead_letter: 8,
      actionable_dead_letter: 0,
      stale_historical_dead_letter: 8,
      oldest_age_seconds: 0,
      oldest_retry_wait_age_seconds: 0,
      oldest_dead_letter_age_seconds: 120,
    });
  });

  it("excludes historical dead-letter age from pending-age classification", () => {
    const stages = summarizeTaskStages([
      {
        task_type: "PUBLISH_EMBEDDING",
        status: "PENDING",
        task_count: 139,
        oldest_age_seconds: 1500,
      },
      {
        task_type: "PUBLISH_EMBEDDING",
        status: "DEAD_LETTER",
        task_count: 8,
        oldest_age_seconds: 413320,
        actionable_dead_letter_count: 0,
        stale_historical_dead_letter_count: 8,
      },
    ]);

    expect(stages.find((stage) => stage.stage === "EMBEDDINGS")).toMatchObject({
      status: "BACKLOG_HEALTHY",
      pending: 139,
      dead_letter: 8,
      stale_historical_dead_letter: 8,
      oldest_age_seconds: 1500,
    });
  });

  it("distinguishes aged pending backlog from healthy pending work", () => {
    const stages = summarizeTaskStages([
      {
        task_type: "NORMALIZE_OBSERVATION",
        status: "PENDING",
        task_count: 7,
        oldest_age_seconds: 7201,
      },
      {
        task_type: "PUBLISH_EMBEDDING",
        status: "PENDING",
        task_count: 2,
        oldest_age_seconds: 7200,
      },
    ]);

    expect(stages.find((stage) => stage.stage === "NORMALIZATION")).toMatchObject({
      status: "BACKLOG_AGED",
      pending: 7,
      oldest_age_seconds: 7201,
    });
    expect(stages.find((stage) => stage.stage === "EMBEDDINGS")).toMatchObject({
      status: "BACKLOG_HEALTHY",
      pending: 2,
      oldest_age_seconds: 7200,
    });
  });

  it("marks actionable dead-lettered work as an error stage", () => {
    const stages = summarizeTaskStages([
      {
        task_type: "ROUTE_LANE",
        status: "DEAD_LETTER",
        task_count: 1,
        oldest_age_seconds: 120,
        actionable_dead_letter_count: 1,
        stale_historical_dead_letter_count: 0,
      },
    ]);

    expect(stages.find((stage) => stage.stage === "LANE_ROUTING")).toMatchObject({
      status: "ERROR",
      dead_letter: 1,
      actionable_dead_letter: 1,
      stale_historical_dead_letter: 0,
    });
  });
});
