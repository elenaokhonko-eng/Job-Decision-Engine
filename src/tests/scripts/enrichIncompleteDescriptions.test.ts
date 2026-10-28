import { beforeEach, describe, expect, it, vi } from "vitest";

const repair = vi.hoisted(() => ({
  parseArguments: vi.fn((argv: readonly string[]) => ({
    workspaceKey: "jobs",
    canonicalJobId: "6ebe6407-09ef-46c7-b547-72cb23450ba0",
    apply: false,
    forceRefetch: false,
    argv,
  })),
  repairJobContent: vi.fn(async () => undefined),
}));

vi.mock("../../../scripts/repair_job_content.js", () => ({
  parseRepairJobContentArguments: repair.parseArguments,
  repairJobContent: repair.repairJobContent,
}));

import { runIncompleteDescriptionEnrichmentCommand } from "../../../scripts/enrich_incomplete_descriptions.js";

describe("legacy incomplete-description command", () => {
  beforeEach(() => {
    repair.parseArguments.mockClear();
    repair.repairJobContent.mockClear();
  });

  it("delegates retrieval and persistence to the scoped repair implementation", async () => {
    const argv = [
      "--workspace-key", "jobs",
      "--canonical-job-id", "6ebe6407-09ef-46c7-b547-72cb23450ba0",
    ];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await runIncompleteDescriptionEnrichmentCommand(argv);

    expect(repair.parseArguments).toHaveBeenCalledWith(argv);
    expect(repair.repairJobContent).toHaveBeenCalledWith(expect.objectContaining({
      workspaceKey: "jobs",
      canonicalJobId: "6ebe6407-09ef-46c7-b547-72cb23450ba0",
      apply: false,
    }));
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
