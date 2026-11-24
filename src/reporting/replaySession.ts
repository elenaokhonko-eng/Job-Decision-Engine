/**
 * One database session on the approved replay branch for replay scripts. Owns the connection so scripts
 * hold no database access of their own: it reads REPLAY_DATABASE_URL, runs the replay guard before anything
 * else, checks the connected branch equals REPLAY_BRANCH_ID, and rolls back unless `commit` is set.
 * Never prints or throws the connection string (errors name the host only).
 *
 * Known limits, by design:
 * - The guard checks IDENTITY only (database name, Neon branch id, host against known production hosts). It
 *   does not reject a pooled URL; a pooled endpoint that resolves to the approved branch is accepted, because
 *   the branch id comes from the server, not from the URL.
 * - Fail closed: an unset REPLAY_BRANCH_ID, a null connected branch id, a connected branch that differs from
 *   REPLAY_BRANCH_ID, and the known production branch are all refused, and a refusal rolls the session back.
 */
import pg from "pg";

import { pgConnectionConfig } from "../db/pgSsl.js";
import { resolveWorkspaceContext } from "../workspace/context.js";
import { requireApprovedReplayTarget } from "./replayGuard.js";

export interface ReplaySession {
  readonly client: pg.PoolClient;
  readonly branchId: string | null;
  readonly workspaceId: string;
}

/** The slice of a pg client the session needs; tests inject a fake. */
export interface ReplayConnection {
  query(sql: string): Promise<{ rows: Array<{ d: string; b: string | null }> }>;
  end(): Promise<void>;
}

export interface ReplaySessionDependencies {
  readonly connect: (url: string) => Promise<ReplayConnection>;
  readonly resolveWorkspaceId: (connection: ReplayConnection) => Promise<string>;
}

const defaultDependencies: ReplaySessionDependencies = {
  connect: async (url) => {
    const client = new pg.Client(pgConnectionConfig(url));
    await client.connect();
    return client as unknown as ReplayConnection;
  },
  resolveWorkspaceId: async (connection) => (await resolveWorkspaceContext(connection as unknown as pg.PoolClient)).workspaceId,
};

export async function withReplaySession<T>(
  options: { readOnly: boolean; commit?: boolean },
  run: (session: ReplaySession) => Promise<T>,
  env: Readonly<Record<string, string | undefined>> = process.env,
  dependencies: ReplaySessionDependencies = defaultDependencies,
): Promise<T> {
  const url = env.REPLAY_DATABASE_URL?.trim();
  if (!url) throw new Error("REPLAY_DATABASE_URL is not set");
  if (options.readOnly && options.commit) throw new Error("A read-only replay session cannot commit.");
  const connection = await dependencies.connect(url);
  try {
    await connection.query(options.readOnly ? "BEGIN READ ONLY" : "BEGIN");
    const id = await connection.query(`SELECT current_database() AS d, current_setting('neon.branch_id', TRUE) AS b`);
    const branchId = id.rows[0]!.b;
    requireApprovedReplayTarget(url, { databaseName: id.rows[0]!.d, branchId }, env.REPLAY_BRANCH_ID);
    if (!env.REPLAY_BRANCH_ID || branchId !== env.REPLAY_BRANCH_ID) throw new Error("Connected branch does not equal REPLAY_BRANCH_ID.");
    const workspaceId = await dependencies.resolveWorkspaceId(connection);
    const result = await run({ client: connection as unknown as pg.PoolClient, branchId, workspaceId });
    await connection.query(options.commit ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (error) {
    await connection.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await connection.end();
  }
}
