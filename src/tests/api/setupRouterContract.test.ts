import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("setup router database contracts", () => {
  it("keeps historical migration compatibility without exposing consent setup behavior", () => {
    const migration = readFileSync(resolve("migrations/034_preference_modes_and_consents.sql"), "utf8");
    const router = readFileSync(resolve("src/api/v2/setupRouter.ts"), "utf8");

    expect(migration).toContain("consent_key TEXT NOT NULL");
    expect(migration).toContain("granted BOOLEAN NOT NULL");
    expect(router).toContain('"/routes"');
    expect(router).not.toContain('"/api/v2/setup/routes"');
    expect(router).not.toContain("workspace_user_consents");
    expect(router).not.toContain("/consents");
    expect(router).toContain("onDatabaseInitialized");
    expect(router).toContain("getPool?: () => pg.Pool | null");
  });
});
