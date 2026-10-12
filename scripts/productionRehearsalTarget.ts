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
