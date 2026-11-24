import pg from "pg";
import { pgConnectionConfig } from "./pgSsl.js";

/** Connection helpers for one-off commands such as `npm run setup`. No queries beyond `SELECT 1`. */

/** Polls until a connection succeeds. Throws after `timeoutMs`; never reports a database as ready that is not. */
export async function waitForPostgres(connectionString: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const client = new pg.Client({ ...pgConnectionConfig(connectionString), connectionTimeoutMillis: 3000 });
    try {
      await client.connect();
      await client.query("SELECT 1");
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    } finally {
      await client.end().catch(() => undefined);
    }
  }
  throw new Error(
    `PostgreSQL did not accept connections within ${Math.round(timeoutMs / 1000)} seconds` +
      `${lastError instanceof Error ? `: ${lastError.message}` : "."}`,
  );
}

/** Runs `work` with a connected client on the given (direct, unpooled) connection and always closes it. */
export async function withDirectClient<T>(connectionString: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ ...pgConnectionConfig(connectionString), connectionTimeoutMillis: 20_000 });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}
