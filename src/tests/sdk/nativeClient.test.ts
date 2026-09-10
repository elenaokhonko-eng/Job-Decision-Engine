import { describe, expect, it, vi } from "vitest";
import { JobDecisionClient } from "../../sdk/client.js";

describe("JobDecisionClient native API bridge", () => {
  it("routes authenticated desktop requests through the native bridge", async () => {
    const nativeRequest = vi.fn(async (path: string, init: { headers?: Record<string, string> }, context: unknown) => {
      expect(path).toBe("/health");
      expect(init.headers?.authorization).toBeUndefined();
      expect(init.headers?.["x-workspace-key"]).toBe("default");
      expect(context).toEqual({
        apiBaseUrl: "https://api.example.test/api/v2",
        workspaceKey: "default",
        userKey: "local_user",
      });
      return {
        status: 200,
        body: JSON.stringify({ ok: true, timestamp: "2026-09-10T00:00:00.000Z", workspace_key: "default", user_key: "local_user" }),
      };
    });

    const client = new JobDecisionClient({
      baseUrl: "https://api.example.test/api/v2",
      token: "renderer-must-not-forward-this",
      workspaceKey: "default",
      userKey: "local_user",
      nativeApiRequest: nativeRequest,
    });

    await expect(client.getHealth()).resolves.toMatchObject({ ok: true, workspace_key: "default" });
    expect(nativeRequest).toHaveBeenCalledTimes(1);
  });
});

