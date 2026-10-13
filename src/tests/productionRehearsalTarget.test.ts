import { describe, expect, it } from "vitest";

import {
  getProductionDatabaseUrl,
  getRehearsalDatabaseTarget,
  PRODUCTION_WRITE_CONFIRMATION_FLAG,
  requireProductionWriteConfirmation,
  requireRehearsalWriteConfirmation,
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

  it("uses a direct staging target without production confirmation", () => {
    const stagingUrl = "postgresql://test_user:test_password@ep-staging-123.us-east-2.aws.neon.tech/neondb?sslmode=require";
    const target = getRehearsalDatabaseTarget({ STAGING_DB_URL: stagingUrl });

    expect(target).toEqual({ databaseUrl: stagingUrl, environment: "STAGING" });
    expect(() => requireRehearsalWriteConfirmation(target, [])).not.toThrow();
  });

  it("continues to require explicit confirmation when no staging target is supplied", () => {
    const productionUrl = "postgresql://test_user:test_password@ep-production-123.us-east-2.aws.neon.tech/neondb?sslmode=require";
    const target = getRehearsalDatabaseTarget({ DATABASE_URL: productionUrl });

    expect(target.environment).toBe("PRODUCTION");
    expect(() => requireRehearsalWriteConfirmation(target, [])).toThrow(PRODUCTION_WRITE_CONFIRMATION_FLAG);
  });
});
