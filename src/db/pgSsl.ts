type PgSslConfig = false | { rejectUnauthorized: true };

/**
 * Canonical SSL configuration for all pg.Pool instances.
 *
 * - Local (localhost / 127.0.0.1 / CI container): no SSL needed.
 * - All remote connections (Neon, RDS, Cloud SQL, etc.): require a valid cert.
 *
 * NEVER use rejectUnauthorized: false. It silently bypasses TLS verification
 * and makes database connections vulnerable to MITM attacks.
 */
export function pgSslConfig(connectionString: string | undefined): PgSslConfig {
  if (!connectionString) return false;
  return isLocalPostgresConnectionString(connectionString) ? false : { rejectUnauthorized: true };
}

export function pgConnectionConfig(connectionString: string | undefined): {
  connectionString: string | undefined;
  ssl: PgSslConfig;
} {
  const normalizedConnectionString = normalizePgConnectionString(connectionString);
  return {
    connectionString: normalizedConnectionString,
    ssl: pgSslConfig(normalizedConnectionString),
  };
}

export const pgPoolConfig = pgConnectionConfig;

export function normalizePgConnectionString(connectionString: string | undefined): string | undefined {
  if (!connectionString) return connectionString;

  const trimmed = connectionString.trim();
  if (!trimmed) return connectionString;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return connectionString;
  }

  if (!isPostgresUrl(parsed)) {
    return connectionString;
  }

  const targetSslMode = isLocalPostgresUrl(parsed) ? "disable" : "verify-full";
  if (parsed.searchParams.get("sslmode")?.toLowerCase() !== targetSslMode) {
    parsed.searchParams.set("sslmode", targetSslMode);
  }

  return parsed.toString();
}

export function isLocalPostgresConnectionString(connectionString: string): boolean {
  const trimmed = connectionString.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("/") || trimmed.startsWith("socket:")) return true;

  try {
    const parsed = new URL(trimmed);
    if (!isPostgresUrl(parsed)) return false;
    return isLocalPostgresUrl(parsed);
  } catch {
    const lower = trimmed.toLowerCase();
    return lower.includes("localhost") || lower.includes("127.0.0.1") || lower.includes("::1");
  }
}

/**
 * Session-scoped advisory locks are not safe through a transaction pooler.
 * Neon pooled endpoints conventionally contain "pooler" in their hostname.
 */
export function isPooledPostgresConnectionString(connectionString: string | undefined): boolean {
  const trimmed = String(connectionString || "").trim();
  if (!trimmed) return false;

  try {
    const parsed = new URL(trimmed);
    return isPostgresUrl(parsed) && /(?:^|[-.])pooler(?:[.-]|$)/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

function isPostgresUrl(parsed: URL): boolean {
  const protocol = parsed.protocol.toLowerCase();
  return protocol === "postgres:" || protocol === "postgresql:";
}

function isLocalPostgresUrl(parsed: URL): boolean {
  const host = parsed.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}
