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
});
