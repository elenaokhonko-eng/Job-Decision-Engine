import { describe, expect, it } from "vitest";
import { compareMigrationLedger } from "../../../scripts/verify_migration_status.js";

describe("compareMigrationLedger", () => {
  it("reports pending repository migrations and unknown ledger entries", () => {
    expect(compareMigrationLedger(
      ["001_foundation.sql", "002_contact.sql"],
      ["001_foundation.sql", "999_removed.sql"],
    )).toEqual({
      pending: ["002_contact.sql"],
      unknown: ["999_removed.sql"],
    });
  });

  it("accepts an exact applied migration set", () => {
    expect(compareMigrationLedger(["001_foundation.sql"], ["001_foundation.sql"])).toEqual({
      pending: [],
      unknown: [],
    });
  });
});
