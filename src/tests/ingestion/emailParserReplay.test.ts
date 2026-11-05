import { describe, expect, it } from "vitest";
import {
  buildEmailAlertSelectionQuery,
  emailReplayCommand,
  parseEmailParseArguments,
} from "../../ingestion/emailParserReplay.js";

describe("Gmail parser replay", () => {
  it("selects only unprocessed alerts unless replay is explicitly requested", () => {
    const normalQuery = buildEmailAlertSelectionQuery(false);
    expect(normalQuery).toContain("processed = FALSE");
    expect(normalQuery).not.toContain("SOURCE_BLOCKED");

    const replayQuery = buildEmailAlertSelectionQuery(true);
    expect(replayQuery).toContain("processed = FALSE");
    expect(replayQuery).toContain("lifecycle_status = 'SOURCE_BLOCKED'");
    expect(replayQuery).toContain("MISSING_POSTING_URL:%");
    expect(replayQuery).toContain("EMAIL_EXTRACTION_FAILED:%");
    expect(replayQuery).toContain("fairness_rank ASC");
    expect(replayQuery).toContain("LIMIT $2");
  });

  it("parses bounded, explicit replay options", () => {
    expect(parseEmailParseArguments([
      "--workspace-key", "primary",
      "--user-key", "owner",
      "--replay-blocked",
      "--limit", "12",
    ])).toEqual({
      workspaceKey: "primary",
      userKey: "owner",
      replayBlocked: true,
      limit: 12,
    });
    expect(() => parseEmailParseArguments(["--limit", "21"])).toThrow("--limit must be an integer");
  });

  it("prints a scoped replay command without shell injection", () => {
    expect(emailReplayCommand("workspace's", "user's", 5)).toBe(
      "npm run email:parse -- --workspace-key 'workspace''s' --user-key 'user''s' --replay-blocked --limit 5",
    );
  });
});
