import { describe, expect, it } from "vitest";

import {
  getProductionDatabaseUrl,
  PRODUCTION_WRITE_CONFIRMATION_FLAG,
  requireProductionWriteConfirmation,
} from "../../scripts/productionRehearsalTarget.js";

describe("production rehearsal target", () => {
  it("accepts an explicit direct production database URL", () => {
    const databaseUrl = "postgresql://user:password@ep-production-123.us-east-2.aws.neon.tech/neondb?sslmode=require";

    expect(getProductionDatabaseUrl({ DATABASE_URL: databaseUrl })).toBe(databaseUrl);
  });

  it("rejects a missing, legacy staging, or pooled database URL", () => {
    const directUrl = "postgresql://user:password@ep-production-123.us-east-2.aws.neon.tech/neondb?sslmode=require";

    expect(() => getProductionDatabaseUrl({})).toThrow("Missing DATABASE_URL");
    expect(() => getProductionDatabaseUrl({ STAGING_DB_URL: directUrl })).toThrow("Missing DATABASE_URL");
    expect(() => getProductionDatabaseUrl({
      DATABASE_URL: "postgresql://user:password@ep-production-123-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require",
    })).toThrow("direct, non-pooler DATABASE_URL");
  });

  it("requires an explicit flag before production writes", () => {
    expect(() => requireProductionWriteConfirmation([])).toThrow(PRODUCTION_WRITE_CONFIRMATION_FLAG);
    expect(() => requireProductionWriteConfirmation([PRODUCTION_WRITE_CONFIRMATION_FLAG])).not.toThrow();
  });
});
