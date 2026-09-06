import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

describe("Phase 11 backfill/parity scripts", () => {
  it("exposes v22 backfill command in package scripts", () => {
    const pkgPath = path.resolve(process.cwd(), "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    expect(pkg.scripts["backfill:v22"]).toBe("tsx scripts/v22_backfill.ts");
  });

  it("includes migration 035 cutover tracking", () => {
    const migrationPath = path.resolve(
      process.cwd(),
      "migrations",
      "035_v22_read_models_and_cutover.sql"
    );
    expect(fs.existsSync(migrationPath)).toBe(true);
  });
});

