/** Database sessions. The module repositories are in the folders beside this file and are not exported from here. */
import pg from "pg";

export interface SessionQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface SessionIdentity {
  databaseName: string | null;
  branchId: string | null;
}

/**
 * Runs `work` inside one READ ONLY transaction that is always rolled back. `approve` receives the connected database and
 * branch before anything else is read, and throws to refuse them.
 */
export async function withReadOnlySession<T>(
  connection: pg.ClientConfig,
  approve: (identity: SessionIdentity) => void,
  work: (db: SessionQueryable) => Promise<T>,
): Promise<T> {
  const client = new pg.Client(connection);
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      const { rows } = await client.query(
        "SELECT current_database() AS database_name, current_setting('neon.branch_id', TRUE) AS branch_id",
      );
      approve({ databaseName: rows[0]?.database_name ?? null, branchId: rows[0]?.branch_id ?? null });
      return await work(client);
    } finally {
      await client.query("ROLLBACK");
    }
  } finally {
    await client.end();
  }
}
