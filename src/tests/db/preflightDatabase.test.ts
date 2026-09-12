import { describe, expect, it } from "vitest";
import {
  resolveMigrationDatabaseUrl,
} from "../../../scripts/preflight_database.js";

describe("database preflight configuration", () => {
  it("requires a direct URL when the application URL is a Neon pooler", () => {
    expect(() =>
      resolveMigrationDatabaseUrl({
        DATABASE_URL: "postgresql://user:password@ep-example-pooler.ap-southeast-1.aws.neon.tech/db",
      })
    ).toThrow("DATABASE_URL_UNPOOLED is missing");
  });

  it("rejects a pooler URL supplied as the migration URL", () => {
    expect(() =>
      resolveMigrationDatabaseUrl({
        DATABASE_URL: "postgresql://user:password@ep-example-pooler.ap-southeast-1.aws.neon.tech/db",
        DATABASE_URL_UNPOOLED:
          "postgresql://user:password@ep-example-pooler.ap-southeast-1.aws.neon.tech/db",
      })
    ).toThrow("DATABASE_URL_UNPOOLED points to a Neon pooler");
  });

  it("prefers the direct URL while keeping the application URL separate", () => {
    const direct =
      "postgresql://user:password@ep-example.ap-southeast-1.aws.neon.tech/db";
    expect(
      resolveMigrationDatabaseUrl({
        DATABASE_URL: "postgresql://user:password@ep-example-pooler.ap-southeast-1.aws.neon.tech/db",
        DATABASE_URL_UNPOOLED: direct,
      })
    ).toBe(direct);
  });

  it("keeps the underlying causes when PostgreSQL returns an aggregate connection error", async () => {
    const { preflightDatabase } = await import("../../../scripts/preflight_database.js");
    const originalConnect = (await import("pg")).default.Client.prototype.connect;
    const originalEnd = (await import("pg")).default.Client.prototype.end;
    (await import("pg")).default.Client.prototype.connect = async function connect() {
      throw Object.assign(new Error("AggregateError"), {
        errors: [new Error("getaddrinfo ENOTFOUND db.example"), new Error("ECONNREFUSED 127.0.0.1:5432")],
      });
    };
    (await import("pg")).default.Client.prototype.end = async function end() {};

    try {
      await expect(
        preflightDatabase({
          DATABASE_URL: "postgresql://user:password@db.example/database",
        })
      ).rejects.toThrow("getaddrinfo ENOTFOUND db.example | ECONNREFUSED 127.0.0.1:5432");
    } finally {
      (await import("pg")).default.Client.prototype.connect = originalConnect;
      (await import("pg")).default.Client.prototype.end = originalEnd;
    }
  });
});
