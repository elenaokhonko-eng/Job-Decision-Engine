import { describe, expect, it } from "vitest";
import {
  MAX_REPAIR_BACKLOG_BATCH_SIZE,
  parseRepairBacklogArguments,
} from "../../../scripts/repair_job_content_backlog.js";

describe("repair Gmail posting backlog arguments", () => {
  it("defaults to a dry-run of a bounded, resumable batch", () => {
    expect(parseRepairBacklogArguments(["--workspace-key", "default"])).toEqual({
      workspaceKey: "default",
      runKey: "gmail_posting_retrieval_v1",
      batchSize: MAX_REPAIR_BACKLOG_BATCH_SIZE,
      apply: false,
    });
  });

  it("supports an explicit dry-run flag and rejects mixed execution modes", () => {
    expect(parseRepairBacklogArguments(["--workspace-key", "default", "--dry-run"]).apply).toBe(false);
    expect(() => parseRepairBacklogArguments(["--workspace-key", "default", "--dry-run", "--apply"]))
      .toThrow("--apply and --dry-run cannot be combined");
  });

  it("accepts explicit apply and resume coordinates", () => {
    expect(parseRepairBacklogArguments([
      "--workspace-key", "primary",
      "--user-key", "owner",
      "--run-key", "gmail-repair-2026-10",
      "--batch-size", "12",
      "--apply",
    ])).toEqual({
      workspaceKey: "primary",
      userKey: "owner",
      runKey: "gmail-repair-2026-10",
      batchSize: 12,
      apply: true,
    });
  });

  it("rejects unbounded batch sizes and repeated flags", () => {
    expect(() => parseRepairBacklogArguments(["--workspace-key", "default", "--batch-size", "26"]))
      .toThrow("--batch-size must be an integer");
    expect(() => parseRepairBacklogArguments(["--workspace-key", "default", "--workspace-key", "other"]))
      .toThrow("may only be provided once");
  });
});
