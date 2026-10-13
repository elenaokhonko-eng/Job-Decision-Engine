type Environment = Readonly<Record<string, string | undefined>>;

export const PRODUCTION_WRITE_CONFIRMATION_FLAG = "--confirm-production-write";

export function getProductionDatabaseUrl(environment: Environment = process.env): string {
  const databaseUrl = environment.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("Missing DATABASE_URL for the production rehearsal target.");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL.");
  }

  if (parsedUrl.protocol !== "postgres:" && parsedUrl.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use the postgres or postgresql protocol.");
  }

  if (parsedUrl.hostname.includes("-pooler")) {
    throw new Error("Production migrations and replays require a direct, non-pooler DATABASE_URL.");
  }

  return databaseUrl;
}

export function requireProductionWriteConfirmation(
  args: readonly string[] = process.argv.slice(2),
): void {
  if (!args.includes(PRODUCTION_WRITE_CONFIRMATION_FLAG)) {
    throw new Error(
      `Refusing to mutate production without ${PRODUCTION_WRITE_CONFIRMATION_FLAG}.`,
    );
  }
}

export interface RehearsalDatabaseTarget {
  databaseUrl: string;
  environment: "STAGING" | "PRODUCTION";
}

/**
 * A supplied STAGING_DB_URL is an explicit isolated target. Production is the
 * fallback and retains an explicit command-line write confirmation.
 */
export function getRehearsalDatabaseTarget(environment: Environment = process.env): RehearsalDatabaseTarget {
  const stagingUrl = environment.STAGING_DB_URL?.trim();
  if (stagingUrl) {
    if (isPooled(stagingUrl)) {
      throw new Error("Staging migrations and replays require a direct, non-pooler STAGING_DB_URL.");
    }
    return { databaseUrl: stagingUrl, environment: "STAGING" };
  }
  return { databaseUrl: getProductionDatabaseUrl(environment), environment: "PRODUCTION" };
}

export function requireRehearsalWriteConfirmation(
  target: RehearsalDatabaseTarget,
  args: readonly string[] = process.argv.slice(2),
): void {
  if (target.environment === "PRODUCTION") {
    requireProductionWriteConfirmation(args);
  }
}

function isPooled(value: string): boolean {
  try {
    return new URL(value).hostname.includes("-pooler");
  } catch {
    throw new Error("STAGING_DB_URL must be a valid PostgreSQL connection URL.");
  }
}
