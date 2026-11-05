import { describe, expect, it } from "vitest";
import {
  duplicateMigrationPrefixes,
  invalidNewMigrationNames,
  migrationNumericPrefix,
  migrationsAtOrBelowBaseline,
} from "../../db/migrationOrdering.js";

describe("migration numbering policy", () => {
  it("compares numeric prefixes instead of suffix ordering", () => {
    expect(migrationsAtOrBelowBaseline(
      ["086_reused_number.sql", "087_new_change.sql"],
      ["086_pin_ai_evaluation_budget_lane_config.sql"],
    )).toEqual(["086_reused_number.sql"]);
    expect(migrationNumericPrefix("014b_legacy_migration.sql")).toBe(14);
    expect(migrationsAtOrBelowBaseline(
      ["014_new_migration.sql", "087_new_migration.sql"],
      ["014b_legacy_migration.sql", "086b_legacy_migration.sql"],
    )).toEqual(["014_new_migration.sql"]);
  });

  it("rejects duplicate numeric prefixes and malformed migration names", () => {
    expect(duplicateMigrationPrefixes([
      "087_first.sql",
      "087_second.sql",
      "088_next.sql",
    ])).toEqual(["087_first.sql", "087_second.sql"]);
    expect(() => migrationNumericPrefix("next_migration.sql")).toThrow(/three-digit numeric prefix/i);
    expect(invalidNewMigrationNames([
      "087_new.sql",
      "087b_legacy_style.sql",
      "next_migration.sql",
    ])).toEqual(["087b_legacy_style.sql", "next_migration.sql"]);
  });

  it("requires a non-empty target baseline", () => {
    expect(() => migrationsAtOrBelowBaseline(["001_initial.sql"], [])).toThrow(/target-branch baseline/i);
  });
});
