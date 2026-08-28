/**
 * Canonical SSL configuration for all pg.Pool instances.
 *
 * - Local (localhost / 127.0.0.1 / CI container): no SSL needed.
 * - All remote connections (Neon, RDS, Cloud SQL …): require valid cert.
 *
 * NEVER use rejectUnauthorized: false — it silently bypasses TLS verification
 * and makes all database connections vulnerable to MITM attacks.
 */
export function pgSslConfig(connectionString: string | undefined): false | { rejectUnauthorized: true } {
  if (!connectionString) return false;
  const isLocal =
    connectionString.includes("localhost") ||
    connectionString.includes("127.0.0.1") ||
    connectionString.includes("::1");
  return isLocal ? false : { rejectUnauthorized: true };
}
