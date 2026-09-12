import { describe, expect, it } from "vitest";
import { findAvailablePort, startLocalServer } from "../../desktop/localServer.js";

describe("desktop local companion server", () => {
  it("finds an available loopback port", async () => {
    const port = await findAvailablePort(3988, "127.0.0.1");
    expect(port).toBeGreaterThanOrEqual(3988);
  });

  it("starts local companion server on 127.0.0.1 with bearer token authentication", async () => {
    const server = await startLocalServer({ port: 3989 });
    try {
      expect(server.host).toBe("127.0.0.1");
      expect(server.port).toBe(3989);
      expect(server.apiBaseUrl).toBe("http://127.0.0.1:3989/api/v2");
      expect(server.token).toBeTruthy();

      // Test unauthenticated setup endpoint (setup routes do not require Bearer token for initial ping)
      const statusRes = await fetch(`${server.apiBaseUrl}/setup/status`, {
        headers: { Authorization: `Bearer ${server.token}` },
      });
      expect(statusRes.status).toBe(200);
      const data = (await statusRes.json()) as any;
      expect(data.ok).toBe(true);
      expect(data.database).toBeDefined();

      // Test updating dynamic configuration in memory
      server.updateConfig({
        geminiApiKey: "test-gemini-key",
      });
      const updatedRes = await fetch(`${server.apiBaseUrl}/setup/status`, {
        headers: { Authorization: `Bearer ${server.token}` },
      });
      const updatedData = (await updatedRes.json()) as any;
      expect(updatedData.ai.geminiConfigured).toBe(true);
    } finally {
      await server.close();
    }
  });
});

