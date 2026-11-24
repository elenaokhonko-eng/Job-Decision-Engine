import type pg from "pg";
import { isPooledPostgresConnectionString } from "./pgSsl.js";

/**
 * Which database a migration command may touch. The command must be told explicitly (`--target replay|production`);
 * it never falls back to DATABASE_URL, which is production. A replay target is guarded by the replay branch id; a
 * production target is refused without `--confirm-production` and `--confirm-workspace=<resolved workspace id>`.
 * Pure: argument and environment handling only, so it is unit-testable. scripts/run_migration.ts applies the result.
 */

export type MigrationTargetName = "replay" | "production";

/** The known production Neon branch; a replay target must never be this. */
export const KNOWN_PRODUCTION_BRANCH_ID = "br-sweet-lab-azucfmoz";

export interface ResolvedMigrationTarget {
  readonly target: MigrationTargetName;
  readonly databaseUrl: string;
  /** Replay only: the branch the connection must report (REPLAY_BRANCH_ID). */
  readonly expectedBranchId: string | null;
  /** Production only: the workspace id the caller typed; compared with the resolved workspace before any write. */
  readonly confirmWorkspaceId: string | null;
}

export class MigrationTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationTargetError";
  }
}

function flagValue(argv: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length).trim() || null;
  const index = argv.indexOf(`--${name}`);
  const next = index >= 0 ? argv[index + 1] : undefined;
  return next !== undefined && !next.startsWith("--") ? next.trim() || null : null;
}

export function resolveMigrationTarget(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): ResolvedMigrationTarget {
  const target = flagValue(argv, "target");
  if (target !== "replay" && target !== "production") {
    throw new MigrationTargetError("--target replay|production is required; the migration command never chooses a database for you.");
  }

  if (target === "replay") {
    const databaseUrl = env.REPLAY_DATABASE_URL?.trim();
    if (!databaseUrl) throw new MigrationTargetError("--target replay needs REPLAY_DATABASE_URL (DATABASE_URL is never used for a replay target).");
    const branchId = env.REPLAY_BRANCH_ID?.trim();
    if (!branchId || !/^br-[a-z0-9-]{5,}$/i.test(branchId)) {
      throw new MigrationTargetError("--target replay needs REPLAY_BRANCH_ID, a Neon branch id beginning with br-.");
    }
    if (branchId === KNOWN_PRODUCTION_BRANCH_ID) {
      throw new MigrationTargetError("REPLAY_BRANCH_ID is the known production branch; refusing.");
    }
    return { target, databaseUrl, expectedBranchId: branchId, confirmWorkspaceId: null };
  }

  if (!argv.includes("--confirm-production")) {
    throw new MigrationTargetError("--target production needs --confirm-production.");
  }
  const confirmWorkspaceId = flagValue(argv, "confirm-workspace");
  if (!confirmWorkspaceId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(confirmWorkspaceId)) {
    throw new MigrationTargetError("--target production needs --confirm-workspace=<workspace uuid>.");
  }
  const databaseUrl = env.DATABASE_URL_UNPOOLED?.trim() || env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new MigrationTargetError("--target production needs DATABASE_URL (or DATABASE_URL_UNPOOLED).");
  if (isPooledPostgresConnectionString(databaseUrl)) {
    throw new MigrationTargetError("Migrations need a direct (unpooled) connection: set DATABASE_URL_UNPOOLED.");
  }
  return { target, databaseUrl, expectedBranchId: null, confirmWorkspaceId };
}

/** The direct endpoint of the same replay branch (advisory locks are session scoped), host only, never printed. */
export function directReplayUrl(databaseUrl: string): string {
  if (!isPooledPostgresConnectionString(databaseUrl)) return databaseUrl;
  const url = new URL(databaseUrl);
  url.hostname = url.hostname.replace("-pooler", "");
  return url.toString();
}

export interface ConnectedIdentity {
  readonly databaseName: string | null;
  readonly branchId: string | null;
}

export async function readConnectedIdentity(client: Pick<pg.Client, "query">): Promise<ConnectedIdentity> {
  const result = await client.query<{ d: string | null; b: string | null }>(
    `SELECT current_database() AS d, current_setting('neon.branch_id', TRUE) AS b`,
  );
  return { databaseName: result.rows[0]?.d ?? null, branchId: result.rows[0]?.b ?? null };
}

/** Throws unless the connection is the replay branch and not production. Call before and after every step. */
export function assertReplayIdentity(identity: ConnectedIdentity, expectedBranchId: string): void {
  if (identity.branchId !== expectedBranchId || identity.branchId === KNOWN_PRODUCTION_BRANCH_ID) {
    throw new MigrationTargetError("The connected database is not the replay branch; stopping before any change.");
  }
}
