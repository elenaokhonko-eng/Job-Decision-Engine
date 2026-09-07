import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GmailApiClient,
  extractEmailSubject,
  loadGmailApiCredentials,
} from "../../services/gmailApi.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Gmail API client", () => {
  it("reads labeled raw messages and applies a processed label only when requested", async () => {
    const rawMessage = "Subject: Job alert\r\nX-Test: yes\r\n\r\nBuild data systems.";
    const rawBase64Url = Buffer.from(rawMessage, "utf8")
      .toString("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://oauth.test/token") {
        return jsonResponse({ access_token: "access-token", expires_in: 3600 });
      }
      if (url.endsWith("/labels") && init?.method === "GET") {
        return jsonResponse({ labels: [{ id: "label-jobs", name: "Jobs-Alerts" }] });
      }
      if (url.includes("/messages?") && init?.method === "GET") {
        return jsonResponse({ messages: [{ id: "message-1" }] });
      }
      if (url.endsWith("/messages/message-1?format=raw") && init?.method === "GET") {
        return jsonResponse({ id: "message-1", raw: rawBase64Url, internalDate: "1770000000000" });
      }
      if (url.endsWith("/labels") && init?.method === "POST") {
        return jsonResponse({ id: "label-processed", name: "Jobs-Alerts-Processed" });
      }
      if (url.endsWith("/messages/message-1/modify") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({
          addLabelIds: ["label-processed"],
          removeLabelIds: ["label-jobs"],
        });
        return jsonResponse({});
      }
      if (url.endsWith("/messages/message-1") && init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected Gmail API request: ${init?.method || "GET"} ${url}`);
    });

    const client = new GmailApiClient(
      { clientId: "client-id", clientSecret: "client-secret", refreshToken: "refresh-token" },
      {
        fetchImpl: fetchMock,
        apiRoot: "https://gmail.test/gmail/v1/users/me",
        tokenEndpoint: "https://oauth.test/token",
        retryBaseDelayMs: 0,
      }
    );

    const result = await client.readMessagesByLabel("Jobs-Alerts");
    expect(result.label).toEqual({ id: "label-jobs", name: "Jobs-Alerts" });
    expect(result.messages).toEqual([
      {
        id: "message-1",
        raw: rawMessage,
        subject: "Job alert",
        internalDate: "1770000000000",
      },
    ]);

    await client.markProcessed("message-1", "label-jobs", "Jobs-Alerts-Processed");
    await client.deleteMessage("message-1");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("preserves folded subject headers and rejects incomplete OAuth configuration", () => {
    expect(extractEmailSubject("From: sender@example.com\r\nSubject: Long\r\n subject\r\n\r\nbody")).toBe(
      "Long subject"
    );
    expect(() => loadGmailApiCredentials({ GMAIL_OAUTH_CLIENT_ID: "only-id" })).toThrow(
      "GMAIL_OAUTH_CLIENT_SECRET, GMAIL_OAUTH_REFRESH_TOKEN"
    );
  });
});
