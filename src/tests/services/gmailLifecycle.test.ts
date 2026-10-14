import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, it, expect, vi } from "vitest";
import { GmailApiClient } from "../../services/gmailApi.js";
import {
  classifyLineage,
  reconcileTerminalGmailAlerts,
} from "../../services/gmailLifecycle.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("Gmail Alert Lifecycle & Terminal Reconciliation", () => {
  describe("GmailApiClient methods", () => {
    it("calls trashMessage on the correct REST endpoint", async () => {
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
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
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
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

    it("1. raw staging: moves Jobs-Alerts -> Jobs-Alerts-In-Processing, remains UNREAD, and marked_read_at IS NULL", async () => {
      const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes("/token")) {
          return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }));
        }
        if (url.includes("/labels") && init?.method === "GET") {
          return new Response(
            JSON.stringify({
              labels: [{ id: "label-in-proc", name: "Jobs-Alerts-In-Processing" }],
            })
          );
        }
        if (url.includes("/messages/msg-staged/modify")) {
          return new Response(JSON.stringify({ id: "msg-staged" }));
        }
        return new Response("Not Found", { status: 404 });
      });

      const client = new GmailApiClient(
        { clientId: "cid", clientSecret: "csec", refreshToken: "refr" },
        { fetchImpl: mockFetch as any }
      );

      // Raw staging MUST pass markAsRead: false so message remains unread in Gmail
      await client.moveToInProcessing("msg-staged", {
        sourceLabelId: "source-label",
        markAsRead: false,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/messages/msg-staged/modify"),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            addLabelIds: ["label-in-proc"],
            removeLabelIds: ["source-label"],
          }),
        })
      );
    });
  });

  describe("Lifecycle classification & reconciliation rules", () => {
    it("2. terminal single-job email: marks read, removes In-Processing, trashes, and persists timestamps", async () => {
      const mockRows = [
        {
          id: 101,
          gmail_message_id: "msg-terminal-single",
          subject: "Single Job Alert",
          lifecycle_status: "IN_PROCESSING",
          processed: true,
          has_error: false,
          total_observations: "1",
          total_canonical_jobs: "1",
          terminal_jobs_count: "1",
          in_flight_jobs_count: "0",
        },
      ];

      const executedQueries: string[] = [];
      const mockPool: any = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          executedQueries.push(sql);
          if (sql.includes("FROM workspaces")) {
            return { rows: [{ id: "ws-test", name: "test" }] };
          }
          if (sql.includes("FROM raw_email_alerts rea")) {
            return { rows: mockRows };
          }
          return { rows: [], rowCount: 1 };
        }),
      };

      const mockMarkRead = vi.fn().mockResolvedValue(undefined);
      const mockModifyLabels = vi.fn().mockResolvedValue(undefined);
      const mockTrash = vi.fn().mockResolvedValue(undefined);
      const mockGmailClient: any = {
        listLabels: vi.fn().mockResolvedValue([
          { id: "lbl-in-proc", name: "Jobs-Alerts-In-Processing" },
        ]),
        markRead: mockMarkRead,
        modifyMessageLabels: mockModifyLabels,
        trashMessage: mockTrash,
      };

      const result = await reconcileTerminalGmailAlerts({
        pool: mockPool,
        gmailClient: mockGmailClient,
        dryRun: false,
      });

      expect(result.eligibleTerminalAlerts).toBe(1);
      expect(result.trashedAlerts).toBe(1);
      expect(mockMarkRead).toHaveBeenCalledWith("msg-terminal-single");
      expect(mockModifyLabels).toHaveBeenCalledWith("msg-terminal-single", {
        removeLabelIds: ["lbl-in-proc"],
      });
      expect(mockTrash).toHaveBeenCalledWith("msg-terminal-single");

      // Verify DB updates for marked_read_at and trashed_at
      const updateQueries = executedQueries.filter((q) => q.includes("UPDATE raw_email_alerts"));
      expect(updateQueries.length).toBeGreaterThanOrEqual(2);
      expect(updateQueries.some((q) => q.includes("marked_read_at"))).toBe(true);
      expect(updateQueries.some((q) => q.includes("lifecycle_status = 'TRASHED'"))).toBe(true);
    });

    it("3. multi-job email with one in-flight: retained in In-Processing and unread", () => {
      const row = {
        total_observations: 2,
        total_canonical_jobs: 2,
        terminal_jobs_count: 1,
        in_flight_jobs_count: 1,
        has_error: false,
      };
      const result = classifyLineage(row);
      expect(result.classification).toBe("IN_FLIGHT");
      expect(result.isEligibleForTrash).toBe(false);
    });

    it("4. zero observations: retained and never automatically trashed", () => {
      const row = {
        total_observations: 0,
        total_canonical_jobs: 0,
        terminal_jobs_count: 0,
        in_flight_jobs_count: 0,
        has_error: false,
      };
      const result = classifyLineage(row);
      expect(result.classification).toBe("NO_DERIVED_OBSERVATIONS");
      expect(result.isEligibleForTrash).toBe(false);
    });

    it("5. missing canonical lineage: retained when canonical count < observation count", () => {
      const row = {
        total_observations: 3,
        total_canonical_jobs: 2,
        terminal_jobs_count: 2,
        in_flight_jobs_count: 0,
        has_error: false,
      };
      const result = classifyLineage(row);
      expect(result.classification).toBe("MISSING_CANONICAL_LINEAGE");
      expect(result.isEligibleForTrash).toBe(false);
    });

    it("6. already-read terminal email: cleanup is idempotent", async () => {
      const mockRows = [
        {
          id: 102,
          gmail_message_id: "msg-already-read",
          subject: "Read Job Alert",
          lifecycle_status: "IN_PROCESSING",
          processed: true,
          has_error: false,
          total_observations: "1",
          total_canonical_jobs: "1",
          terminal_jobs_count: "1",
          in_flight_jobs_count: "0",
        },
      ];

      const mockPool: any = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes("FROM workspaces")) return { rows: [{ id: "ws-test", name: "test" }] };
          if (sql.includes("FROM raw_email_alerts rea")) return { rows: mockRows };
          return { rows: [], rowCount: 1 };
        }),
      };

      // Gmail API returns already read / no unread label
      const mockMarkRead = vi.fn().mockRejectedValueOnce(new Error("Message is already read"));
      const mockTrash = vi.fn().mockResolvedValue(undefined);
      const mockGmailClient: any = {
        listLabels: vi.fn().mockResolvedValue([]),
        markRead: mockMarkRead,
        modifyMessageLabels: vi.fn().mockResolvedValue(undefined),
        trashMessage: mockTrash,
      };

      const result = await reconcileTerminalGmailAlerts({
        pool: mockPool,
        gmailClient: mockGmailClient,
        dryRun: false,
      });

      expect(result.eligibleTerminalAlerts).toBe(1);
      expect(result.trashedAlerts).toBe(1);
      expect(mockTrash).toHaveBeenCalledWith("msg-already-read");
    });

    it("7. already-trashed message: cleanup is idempotent", async () => {
      const mockRows = [
        {
          id: 103,
          gmail_message_id: "msg-already-trashed",
          subject: "Trashed Job Alert",
          lifecycle_status: "IN_PROCESSING",
          processed: true,
          has_error: false,
          total_observations: "1",
          total_canonical_jobs: "1",
          terminal_jobs_count: "1",
          in_flight_jobs_count: "0",
        },
      ];

      const mockPool: any = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes("FROM workspaces")) return { rows: [{ id: "ws-test", name: "test" }] };
          if (sql.includes("FROM raw_email_alerts rea")) return { rows: mockRows };
          return { rows: [], rowCount: 1 };
        }),
      };

      const mockMarkRead = vi.fn().mockResolvedValue(undefined);
      const mockTrash = vi.fn().mockRejectedValueOnce(new Error("Message not found or already trashed (404)"));
      const mockGmailClient: any = {
        listLabels: vi.fn().mockResolvedValue([]),
        markRead: mockMarkRead,
        modifyMessageLabels: vi.fn().mockResolvedValue(undefined),
        trashMessage: mockTrash,
      };

      const result = await reconcileTerminalGmailAlerts({
        pool: mockPool,
        gmailClient: mockGmailClient,
        dryRun: false,
      });

      expect(result.eligibleTerminalAlerts).toBe(1);
      expect(result.trashedAlerts).toBe(1);
      expect(result.errors.length).toBe(0);
    });

    it("8. legacy Processed + nonterminal: migrated to In-Processing and remains in Gmail", async () => {
      const mockPool: any = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes("FROM workspaces")) return { rows: [{ id: "ws-test", name: "test" }] };
          if (sql.includes("FROM raw_email_alerts rea") && sql.includes("rea.gmail_message_id = $2")) {
            return {
              rows: [
                {
                  id: 201,
                  gmail_message_id: "msg-legacy-inflight",
                  subject: "Legacy Alert",
                  lifecycle_status: "PROCESSED",
                  processed: true,
                  has_error: false,
                  total_observations: "2",
                  total_canonical_jobs: "2",
                  terminal_jobs_count: "1",
                  in_flight_jobs_count: "1",
                },
              ],
            };
          }
          return { rows: [], rowCount: 1 };
        }),
      };

      const mockModifyLabels = vi.fn().mockResolvedValue(undefined);
      const mockGmailClient: any = {
        listLabels: vi.fn().mockResolvedValue([
          { id: "lbl-legacy", name: "Jobs-Alerts-Processed" },
          { id: "lbl-inproc", name: "Jobs-Alerts-In-Processing" },
        ]),
        listMessageIdsByLabel: vi.fn().mockResolvedValue(["msg-legacy-inflight"]),
        modifyMessageLabels: mockModifyLabels,
        trashMessage: vi.fn(),
        markRead: vi.fn(),
      };

      const result = await reconcileTerminalGmailAlerts({
        pool: mockPool,
        gmailClient: mockGmailClient,
        dryRun: false,
      });

      expect(result.legacyProcessedInspected).toBe(1);
      expect(result.legacyProcessedToInProcessing).toBe(1);
      expect(mockModifyLabels).toHaveBeenCalledWith("msg-legacy-inflight", {
        addLabelIds: ["lbl-inproc"],
        removeLabelIds: ["lbl-legacy"],
      });
      expect(mockGmailClient.trashMessage).not.toHaveBeenCalled();
    });

    it("9. legacy Processed + terminal: marks read and moves to Trash", async () => {
      const mockPool: any = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes("FROM workspaces")) return { rows: [{ id: "ws-test", name: "test" }] };
          if (sql.includes("FROM raw_email_alerts rea") && sql.includes("rea.gmail_message_id = $2")) {
            return {
              rows: [
                {
                  id: 202,
                  gmail_message_id: "msg-legacy-terminal",
                  subject: "Legacy Alert Terminal",
                  lifecycle_status: "PROCESSED",
                  processed: true,
                  has_error: false,
                  total_observations: "1",
                  total_canonical_jobs: "1",
                  terminal_jobs_count: "1",
                  in_flight_jobs_count: "0",
                },
              ],
            };
          }
          return { rows: [], rowCount: 1 };
        }),
      };

      const mockMarkRead = vi.fn().mockResolvedValue(undefined);
      const mockModifyLabels = vi.fn().mockResolvedValue(undefined);
      const mockTrash = vi.fn().mockResolvedValue(undefined);
      const mockGmailClient: any = {
        listLabels: vi.fn().mockResolvedValue([
          { id: "lbl-legacy", name: "Jobs-Alerts-Processed" },
        ]),
        listMessageIdsByLabel: vi.fn().mockResolvedValue(["msg-legacy-terminal"]),
        markRead: mockMarkRead,
        modifyMessageLabels: mockModifyLabels,
        trashMessage: mockTrash,
      };

      const result = await reconcileTerminalGmailAlerts({
        pool: mockPool,
        gmailClient: mockGmailClient,
        dryRun: false,
      });

      expect(result.legacyProcessedInspected).toBe(1);
      expect(result.legacyProcessedTerminalEligible).toBe(1);
      expect(result.legacyProcessedTrashed).toBe(1);
      expect(mockMarkRead).toHaveBeenCalledWith("msg-legacy-terminal");
      expect(mockModifyLabels).toHaveBeenCalledWith("msg-legacy-terminal", {
        removeLabelIds: ["lbl-legacy"],
      });
      expect(mockTrash).toHaveBeenCalledWith("msg-legacy-terminal");
    });

    it("10. both scheduled workflows invoke terminal Gmail reconciliation", () => {
      const ingestWorkflowPath = path.resolve(__dirname, "../../../.github/workflows/ingest.yml");
      const backlogWorkflowPath = path.resolve(__dirname, "../../../.github/workflows/process_backlog.yml");

      expect(fs.existsSync(ingestWorkflowPath)).toBe(true);
      expect(fs.existsSync(backlogWorkflowPath)).toBe(true);

      const ingestYml = fs.readFileSync(ingestWorkflowPath, "utf-8");
      const backlogYml = fs.readFileSync(backlogWorkflowPath, "utf-8");

      expect(ingestYml).toContain("Reconcile terminal Gmail job alerts");
      expect(ingestYml).toContain("npx tsx scripts/cleanup_gmail.ts");
      expect(ingestYml).toContain("GMAIL_IN_PROCESSING_FOLDER");

      expect(backlogYml).toContain("Reconcile terminal Gmail job alerts");
      expect(backlogYml).toContain("npx tsx scripts/cleanup_gmail.ts");
      expect(backlogYml).toContain("GMAIL_IN_PROCESSING_FOLDER");
    });
  });
});
