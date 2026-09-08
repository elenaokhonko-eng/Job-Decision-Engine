import { describe, expect, it, vi } from "vitest";
import { createJobDecisionMcpTools } from "../../mcp/tools.js";

describe("job decision MCP tool descriptors", () => {
  it("exposes application handoff and status tools over a client adapter", async () => {
    const client = {
      listShortlist: vi.fn(),
      createManualObservation: vi.fn(),
      createApplication: vi.fn(async (input) => ({ ok: true, application: input })),
      updateApplication: vi.fn(),
      listApplicationEvents: vi.fn(),
      listTasks: vi.fn(),
    } as any;

    const tools = createJobDecisionMcpTools(client);
    const createTool = tools.find((tool) => tool.name === "job_decision.create_application_handoff");
    expect(createTool).toBeTruthy();
    expect(createTool?.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });

    await createTool?.handler({
      canonical_job_id: "22222222-2222-4222-8222-222222222222",
      status: "READY_TO_APPLY",
      notes: "Ready",
    });

    expect(client.createApplication).toHaveBeenCalledWith({
      canonical_job_id: "22222222-2222-4222-8222-222222222222",
      job_version_id: undefined,
      status: "READY_TO_APPLY",
      submission_url: null,
      cv_document_run_id: null,
      cover_letter_document_run_id: null,
      notes: "Ready",
      handoff_payload: undefined,
      target_submit_at: null,
      follow_up_at: null,
    });
  });

  it("validates required MCP arguments before calling the API client", async () => {
    const tools = createJobDecisionMcpTools({} as any);
    const createTool = tools.find((tool) => tool.name === "job_decision.create_application_handoff");

    await expect(createTool?.handler({})).rejects.toThrow(/canonical_job_id is required/);
  });
});
