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
      concurrency: 4,
      maxRuntimeSeconds: 420,
    });
    expect(() => parseEmailParseArguments(["--limit", "21"])).toThrow("--limit must be an integer");
  });

  it("bounds extraction concurrency and the run's wall-clock budget", () => {
    expect(parseEmailParseArguments(["--concurrency", "8", "--max-runtime-seconds", "300"])).toEqual({
      replayBlocked: false,
      limit: 20,
      concurrency: 8,
      maxRuntimeSeconds: 300,
    });
    expect(() => parseEmailParseArguments(["--concurrency", "0"])).toThrow("--concurrency must be an integer from 1 to 8.");
    expect(() => parseEmailParseArguments(["--concurrency", "9"])).toThrow("--concurrency must be an integer from 1 to 8.");
    expect(() => parseEmailParseArguments(["--max-runtime-seconds", "1.5"])).toThrow("--max-runtime-seconds must be an integer");
    expect(() => parseEmailParseArguments(["--max-runtime-seconds", "3601"])).toThrow("--max-runtime-seconds must be an integer");
  });

  it("excludes alerts already attempted in this run only when asked", () => {
    expect(buildEmailAlertSelectionQuery(false)).not.toContain("$3");
    expect(buildEmailAlertSelectionQuery(true)).not.toContain("$3");
    expect(buildEmailAlertSelectionQuery(false, { excludeAttempted: true })).toContain("AND NOT (id = ANY($3::uuid[]))");
    expect(buildEmailAlertSelectionQuery(true, { excludeAttempted: true })).toContain("AND NOT (id = ANY($3::uuid[]))");
  });

  it("prints a scoped replay command without shell injection", () => {
    expect(emailReplayCommand("workspace's", "user's", 5)).toBe(
      "npm run email:parse -- --workspace-key 'workspace''s' --user-key 'user''s' --replay-blocked --limit 5",
    );
  });
});
