import { describe, expect, it } from "vitest";
import { buildRepairJobContentCommands, buildResumeCommand, parseRepairJobContentArguments } from "../../../scripts/repair_job_content.js";

describe("repair job content command arguments", () => {
  it("prints separate explicit dry-run and enqueue commands before the scoped worker command", () => {
    const observationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    expect(buildRepairJobContentCommands("jobs", observationId)).toEqual({
      dryRun: `npm run pipeline:repair-content -- --workspace-key 'jobs' --observation-id '${observationId}'`,
      enqueue: `npm run pipeline:repair-content -- --workspace-key 'jobs' --observation-id '${observationId}' --apply`,
    });
    expect(buildRepairJobContentCommands("candidate's jobs", observationId).enqueue)
      .toContain("--workspace-key 'candidate''s jobs'");
    expect(buildResumeCommand(observationId)).toContain("PIPELINE_TASK_WORKER_TASK_TYPES='FETCH_JOB_CONTENT,NORMALIZE_OBSERVATION,EXTRACT_DETERMINISTIC_REQUIREMENTS,APPLY_HARD_GATES'");
    expect(buildResumeCommand(observationId)).toContain("PIPELINE_TASK_WORKER_MAX_TASKS='4'");
    expect(buildResumeCommand(observationId)).toContain("PIPELINE_TASK_WORKER_SEED='false'");
  });

  it("defaults to dry-run and requires one explicitly scoped target", () => {
    expect(parseRepairJobContentArguments([
      "--workspace-key", "jobs",
      "--canonical-job-id", "6ebe6407-09ef-46c7-b547-72cb23450ba0",
    ])).toEqual({
      workspaceKey: "jobs",
      canonicalJobId: "6ebe6407-09ef-46c7-b547-72cb23450ba0",
      apply: false,
      forceRefetch: false,
    });
  });

  it("requires an explicit apply flag and supports an observation-scoped forced refresh", () => {
    expect(parseRepairJobContentArguments([
      "--workspace-key", "jobs",
      "--observation-id", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "--force-refetch",
      "--apply",
    ])).toMatchObject({
      workspaceKey: "jobs",
      observationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      apply: true,
      forceRefetch: true,
    });
  });

  it("rejects a missing workspace, an ambiguous target, and malformed IDs", () => {
    expect(() => parseRepairJobContentArguments([
      "--canonical-job-id", "6ebe6407-09ef-46c7-b547-72cb23450ba0",
    ])).toThrow("--workspace-key is required");
    expect(() => parseRepairJobContentArguments([
      "--workspace-key", "jobs",
      "--observation-id", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "--canonical-job-id", "6ebe6407-09ef-46c7-b547-72cb23450ba0",
    ])).toThrow("exactly one");
    expect(() => parseRepairJobContentArguments([
      "--workspace-key", "jobs",
      "--observation-id", "not-a-uuid",
    ])).toThrow("must be a UUID");
  });
});
