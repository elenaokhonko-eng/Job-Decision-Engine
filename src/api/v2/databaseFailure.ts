/**
 * What to tell an API caller when the workspace check against PostgreSQL fails. A missing schema
 * means setup is incomplete; anything else (a deleted host, a wrong password, a timeout) means the
 * configured database cannot be used, and the caller needs to know which host to check.
 */

// undefined_table, invalid_schema_name: the database answers but has no schema yet.
const SCHEMA_MISSING_CODES = new Set(["42P01", "3F000"]);
const MAX_DETAIL_CHARS = 240;

export interface DatabaseFailureResponse {
  ok: false;
  error: "DATABASE_NOT_INITIALIZED" | "DATABASE_UNAVAILABLE";
  message: string;
}

/** The host part of a connection string, never its credentials; null when it cannot be parsed. */
export function databaseHost(databaseUrl: string | undefined): string | null {
  if (!databaseUrl) return null;
  try {
    return new URL(databaseUrl).hostname || null;
  } catch {
    return null;
  }
}

export function describeDatabaseFailure(error: unknown, databaseUrl: string | undefined): DatabaseFailureResponse {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  if (SCHEMA_MISSING_CODES.has(code)) {
    return {
      ok: false,
      error: "DATABASE_NOT_INITIALIZED",
      message: "Database schema is not initialized yet. Complete the desktop setup wizard to install the schema.",
    };
  }
  const raw = error instanceof Error ? error.message : String(error);
  // Connection strings can carry passwords; drop any that an error message quotes.
  const detail = raw.replace(/postgres(?:ql)?:\/\/\S+/gi, "[connection string]").split("\n")[0].slice(0, MAX_DETAIL_CHARS);
  const host = databaseHost(databaseUrl);
  return {
    ok: false,
    error: "DATABASE_UNAVAILABLE",
    message: `The database${host ? ` at ${host}` : ""} could not be used: ${detail || code || "no detail"}. `
      + "Check DATABASE_URL (and DATABASE_URL_UNPOOLED) in .env.local, then restart the API.",
  };
}
