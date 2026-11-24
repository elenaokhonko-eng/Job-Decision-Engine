/**
 * One database session on the approved replay branch for replay scripts. Owns the connection so scripts
 * hold no database access of their own: it reads REPLAY_DATABASE_URL, runs the replay guard before anything
 * else, checks the connected branch equals REPLAY_BRANCH_ID, and rolls back unless `commit` is set.
 * Never prints or throws the connection string.
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

export async function withReplaySession<T>(
  options: { readOnly: boolean; commit?: boolean },
  run: (session: ReplaySession) => Promise<T>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<T> {
  const url = env.REPLAY_DATABASE_URL?.trim();
  if (!url) throw new Error("REPLAY_DATABASE_URL is not set");
  if (options.readOnly && options.commit) throw new Error("A read-only replay session cannot commit.");
  const client = new pg.Client(pgConnectionConfig(url));
  await client.connect();
  try {
    await client.query(options.readOnly ? "BEGIN READ ONLY" : "BEGIN");
    const id = await client.query<{ d: string; b: string | null }>(`SELECT current_database() AS d, current_setting('neon.branch_id', TRUE) AS b`);
    const branchId = id.rows[0]!.b;
    requireApprovedReplayTarget(url, { databaseName: id.rows[0]!.d, branchId }, env.REPLAY_BRANCH_ID);
    if (!env.REPLAY_BRANCH_ID || branchId !== env.REPLAY_BRANCH_ID) throw new Error("Connected branch does not equal REPLAY_BRANCH_ID.");
    const context = await resolveWorkspaceContext(client as unknown as pg.PoolClient);
    const result = await run({ client: client as unknown as pg.PoolClient, branchId, workspaceId: context.workspaceId });
    await client.query(options.commit ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}
