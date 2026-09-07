import { describe, expect, it, vi } from "vitest";
import pg from "pg";
import {
  isLocalPostgresConnectionString,
  normalizePgConnectionString,
  pgConnectionConfig,
  pgSslConfig,
} from "../../db/pgSsl.js";

describe("pg SSL connection configuration", () => {
  it.each(["prefer", "require", "verify-ca", "no-verify", "disable"])(
    "normalizes remote sslmode=%s to verify-full",
    (sslmode) => {
      const input = `postgresql://user:pass@db.example.com:5432/app?sslmode=${sslmode}&application_name=jde`;

      const normalized = normalizePgConnectionString(input);
      const url = new URL(normalized || "");

      expect(url.searchParams.get("sslmode")).toBe("verify-full");
      expect(url.searchParams.get("application_name")).toBe("jde");
      expect(pgConnectionConfig(input).ssl).toEqual({ rejectUnauthorized: true });
    }
  );

  it("keeps libpq compatibility explicit while preserving remote verify-full", () => {
    const input = "postgresql://user:pass@db.example.com/app?uselibpqcompat=true&sslmode=require";

    const normalized = normalizePgConnectionString(input);
    const url = new URL(normalized || "");

    expect(url.searchParams.get("uselibpqcompat")).toBe("true");
    expect(url.searchParams.get("sslmode")).toBe("verify-full");
  });

  it("normalizes local database URLs to sslmode=disable", () => {
    const input = "postgresql://postgres:postgres@localhost:5432/postgres?sslmode=require";

    const normalized = normalizePgConnectionString(input);
    const url = new URL(normalized || "");

    expect(isLocalPostgresConnectionString(input)).toBe(true);
    expect(url.searchParams.get("sslmode")).toBe("disable");
    expect(pgSslConfig(normalized)).toBe(false);
    expect(pgConnectionConfig(input).ssl).toBe(false);
  });

  it("leaves non-URL connection strings unchanged", () => {
    expect(normalizePgConnectionString("postgres")).toBe("postgres");
    expect(pgConnectionConfig(undefined)).toEqual({ connectionString: undefined, ssl: false });
  });

  it("constructs pg clients without deprecated sslmode warnings", () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    try {
      new pg.Client(pgConnectionConfig("postgresql://user:pass@db.example.com/app?sslmode=require"));
      expect(emitWarning).not.toHaveBeenCalled();
    } finally {
      emitWarning.mockRestore();
    }
  });
});
