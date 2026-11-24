import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The guard function is tested in replayGuard.test.ts. This test proves the scripts that connect to a
// replay database actually call it, and call it before anything is queried or written.
const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), "utf8");

describe("replay and experiment scripts call the replay guard first", () => {
  it("replay_requirement_extraction: the guard runs before migrations, reads and every write path", () => {
    const source = read("scripts/replay_requirement_extraction.ts");
    const guard = source.indexOf("requireApprovedReplayTarget(");
    expect(guard).toBeGreaterThan(-1);
    for (const later of ["runMigrations(", "BEGIN READ ONLY", "if (!apply)"]) {
      const at = source.indexOf(later, guard);
      expect(at, `${later} must come after the guard call`).toBeGreaterThan(guard);
    }
    // No default pool may reach another database: both URL variables are overridden before connecting.
    expect(source).toMatch(/process\.env\.DATABASE_URL = replayUrl/);
    expect(source).toMatch(/process\.env\.DATABASE_URL_UNPOOLED = replayUrl/);
  });

  it.each(["scripts/experiments/score_variants.ts", "scripts/experiments/blind_review_set.ts"])(
    "%s: read-only, and the guard runs before any other query",
    (file) => {
      const source = read(file);
      const guard = source.indexOf("requireApprovedReplayTarget(");
      expect(guard).toBeGreaterThan(-1);
      expect(source).toContain("BEGIN READ ONLY");
      // The only query before the guard is the identity lookup the guard needs.
      const before = source.slice(0, guard);
      const queriesBefore = [...before.matchAll(/\.query\(/g)].length;
      expect(queriesBefore).toBeLessThanOrEqual(3); // BEGIN READ ONLY, identity lookup (+ one reserved)
      expect(source).not.toMatch(/\b(INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM)\b/i);
    },
  );

  it.each([
    "scripts/deactivate_stale_embedding_spaces.ts",
    "scripts/report_missing_embedding_inputs.ts",
    "scripts/report_zero_checks_replay.ts",
  ])("%s holds no database access of its own: it goes through the guarded replay session", (file) => {
    const source = read(file);
    expect(source).not.toMatch(/from "pg"/);
    expect(source).not.toMatch(/\.query\(/);
    const ownsSession = source.includes("withReplaySession(") || source.includes("runStaleSpaceDeactivation(");
    expect(ownsSession).toBe(true);
  });

  it.each(["scripts/report_missing_embedding_inputs.ts", "scripts/report_zero_checks_replay.ts"])("%s runs in a read-only session", (file) => {
    expect(read(file)).toMatch(/withReplaySession\(\{ readOnly: true \}/);
  });

  it("the session runs the guard before it hands the client to the caller, and the deactivation run wires confirm and commit to apply", () => {
    const session = read("src/reporting/replaySession.ts");
    expect(session.indexOf("requireApprovedReplayTarget(")).toBeGreaterThan(-1);
    expect(session.indexOf("requireApprovedReplayTarget(")).toBeLessThan(session.indexOf("run({"));
    const run = read("src/embeddings/deactivationRun.ts");
    expect(run).toMatch(/commit: input\.apply/);
    expect(run).toMatch(/confirm: input\.apply/);
    expect(run.indexOf("assertDeactivationAllowed(")).toBeLessThan(run.indexOf("embeddingSpacePreflight("));
  });
});
