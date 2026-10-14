import { describe, it, expect, vi } from "vitest";
import { GmailApiClient } from "../../services/gmailApi.js";
import { reconcileTerminalGmailAlerts } from "../../services/gmailLifecycle.js";

describe("Gmail Alert Lifecycle & Terminal Reconciliation", () => {
  describe("GmailApiClient methods", () => {
    it("calls trashMessage on the correct REST endpoint", async () => {
      const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes("/token")) {
          return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }));
        }
        if (url.includes("/messages/msg-123/trash")) {
          return new Response(JSON.stringify({ id: "msg-123" }));
        }
        return new Response("Not Found", { status: 404 });
      });

      const client = new GmailApiClient(
        { clientId: "cid", clientSecret: "csec", refreshToken: "refr" },
        { fetchImpl: mockFetch as any }
      );

      await client.trashMessage("msg-123");
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/messages/msg-123/trash"),
        expect.objectContaining({ method: "POST" })
      );
    });

    it("calls markRead by removing the UNREAD label", async () => {
      const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes("/token")) {
          return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }));
        }
        if (url.includes("/messages/msg-456/modify")) {
          return new Response(JSON.stringify({ id: "msg-456" }));
        }
        return new Response("Not Found", { status: 404 });
      });

      const client = new GmailApiClient(
        { clientId: "cid", clientSecret: "csec", refreshToken: "refr" },
        { fetchImpl: mockFetch as any }
      );

      await client.markRead("msg-456");
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/messages/msg-456/modify"),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ removeLabelIds: ["UNREAD"] }),
        })
      );
    });

    it("moves message to in-processing label", async () => {
      const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes("/token")) {
          return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }));
        }
        if (url.includes("/labels") && init?.method === "GET") {
          return new Response(
            JSON.stringify({
              labels: [{ id: "label-in-processing", name: "Jobs-Alerts-In-Processing" }],
            })
          );
        }
        if (url.includes("/messages/msg-789/modify")) {
          return new Response(JSON.stringify({ id: "msg-789" }));
        }
        return new Response("Not Found", { status: 404 });
      });

      const client = new GmailApiClient(
        { clientId: "cid", clientSecret: "csec", refreshToken: "refr" },
        { fetchImpl: mockFetch as any }
      );

      await client.moveToInProcessing("msg-789", {
        sourceLabelId: "source-label",
        markAsRead: true,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/messages/msg-789/modify"),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            addLabelIds: ["label-in-processing"],
            removeLabelIds: ["source-label", "UNREAD"],
          }),
        })
      );
    });
  });

  describe("reconcileTerminalGmailAlerts", () => {
    it("skips alerts that have in-flight derived jobs and trashes terminal ones", async () => {
      const mockRows = [
        {
          id: 1,
          gmail_message_id: "msg-terminal-all-rejected",
          subject: "Daily Alert - 2 Jobs",
          lifecycle_status: "IN_PROCESSING",
          processed: true,
          total_observations: "2",
          total_canonical_jobs: "2",
          terminal_jobs_count: "2",
          in_flight_jobs_count: "0",
        },
        {
          id: 2,
          gmail_message_id: "msg-in-flight",
          subject: "Daily Alert - 1 In Flight",
          lifecycle_status: "IN_PROCESSING",
          processed: true,
          total_observations: "1",
          total_canonical_jobs: "1",
          terminal_jobs_count: "0",
          in_flight_jobs_count: "1",
        },
        {
          id: 3,
          gmail_message_id: "msg-empty-alert",
          subject: "Daily Alert - No matches today",
          lifecycle_status: "IN_PROCESSING",
          processed: true,
          total_observations: "0",
          total_canonical_jobs: "0",
          terminal_jobs_count: "0",
          in_flight_jobs_count: "0",
        },
      ];

      const executedQueries: string[] = [];
      const mockPool: any = {
        query: vi.fn().mockImplementation(async (sql: string, params?: any[]) => {
          executedQueries.push(sql);
          if (sql.includes("FROM workspaces")) {
            return { rows: [{ id: "ws-default", name: "default" }] };
          }
          if (sql.includes("FROM raw_email_alerts rea")) {
            return { rows: mockRows };
          }
          if (sql.includes("UPDATE raw_email_alerts")) {
            return { rowCount: 1 };
          }
          return { rows: [] };
        }),
      };

      const mockTrash = vi.fn().mockResolvedValue(undefined);
      const mockMarkRead = vi.fn().mockResolvedValue(undefined);
      const mockGmailClient: any = {
        trashMessage: mockTrash,
        markRead: mockMarkRead,
      };

      const result = await reconcileTerminalGmailAlerts({
        pool: mockPool,
        gmailClient: mockGmailClient,
        dryRun: false,
      });

      expect(result.inspectedAlerts).toBe(3);
      expect(result.inFlightAlerts).toBe(1); // id 2 skipped
      expect(result.eligibleTerminalAlerts).toBe(2); // ids 1 and 3 eligible
      expect(result.trashedAlerts).toBe(2);

      // Verify trash was called for terminal messages
      expect(mockTrash).toHaveBeenCalledWith("msg-terminal-all-rejected");
      expect(mockTrash).toHaveBeenCalledWith("msg-empty-alert");
      expect(mockTrash).not.toHaveBeenCalledWith("msg-in-flight");
    });
  });
});
