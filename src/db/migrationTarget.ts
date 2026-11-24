import type pg from "pg";
import { isPooledPostgresConnectionString } from "./pgSsl.js";
import { STAGE1_3_STAGING_IDENTITY_EXPECTATIONS } from "./stagingDatabaseIdentity.js";

/**
 * Which database a migration command may touch. The command must be told explicitly (`--target replay|production`);
 * it never falls back to DATABASE_URL for a replay target and never falls back from DATABASE_URL_UNPOOLED to
 * DATABASE_URL for production. A replay target is gated by the replay branch id; a production target is gated by the
 * known production branch id AND the typed workspace id, plus `--confirm-production`. The gate is the identity check
 * made BEFORE any change; the check after the run only detects a connection that changed underneath.
 * The decision logic is pure (argument, environment and identity handling) so it is unit-testable; scripts/run_migration.ts
 * only wires real dependencies into executeMigrationCommand.
 */

export type MigrationTargetName = "replay" | "production";

/** The known production Neon branch (one definition: src/db/stagingDatabaseIdentity.ts). */
export const KNOWN_PRODUCTION_BRANCH_ID = STAGE1_3_STAGING_IDENTITY_EXPECTATIONS.knownProductionBranchId;

export interface ResolvedMigrationTarget {
  readonly target: MigrationTargetName;
  readonly databaseUrl: string;
  /** The branch the connection must report: REPLAY_BRANCH_ID, or the production branch for a production target. */
  readonly expectedBranchId: string;
  /** Production only: the workspace id the caller typed; compared with the resolved workspace before any write. */
  readonly confirmWorkspaceId: string | null;
}

export class MigrationTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationTargetError";
  }
}

const BRANCH_ID = /^br-[a-z0-9-]{5,}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function flagValue(argv: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length).trim() || null;
  const index = argv.indexOf(`--${name}`);
  const next = index >= 0 ? argv[index + 1] : undefined;
  return next !== undefined && !next.startsWith("--") ? next.trim() || null : null;
}

export function resolveMigrationTarget(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): ResolvedMigrationTarget {
  const target = flagValue(argv, "target")?.toLowerCase() ?? null;
  if (target !== "replay" && target !== "production") {
    throw new MigrationTargetError("--target replay|production is required; the migration command never chooses a database for you.");
  }

  if (target === "replay") {
    const databaseUrl = env.REPLAY_DATABASE_URL?.trim();
    if (!databaseUrl) throw new MigrationTargetError("--target replay needs REPLAY_DATABASE_URL (DATABASE_URL is never used for a replay target).");
    const branchId = env.REPLAY_BRANCH_ID?.trim();
    if (!branchId || !BRANCH_ID.test(branchId)) {
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
  if (!confirmWorkspaceId || !UUID.test(confirmWorkspaceId)) {
    throw new MigrationTargetError("--target production needs --confirm-workspace=<workspace uuid>.");
  }
  // No silent fallback: production runs on the direct endpoint named explicitly, never on whatever DATABASE_URL holds.
  const databaseUrl = env.DATABASE_URL_UNPOOLED?.trim();
  if (!databaseUrl) throw new MigrationTargetError("--target production needs DATABASE_URL_UNPOOLED (no fallback to DATABASE_URL).");
  if (isPooledPostgresConnectionString(databaseUrl)) {
    throw new MigrationTargetError("DATABASE_URL_UNPOOLED points at a pooled endpoint; migrations need the direct endpoint.");
  }
  const override = env.PRODUCTION_BRANCH_ID?.trim();
  if (override !== undefined && override !== "" && override !== KNOWN_PRODUCTION_BRANCH_ID) {
    throw new MigrationTargetError("PRODUCTION_BRANCH_ID does not match the known production branch; refusing.");
  }
  return { target, databaseUrl, expectedBranchId: KNOWN_PRODUCTION_BRANCH_ID, confirmWorkspaceId };
}

/** The direct endpoint of the same replay branch (advisory locks are session scoped); host only, never printed. */
export function directReplayUrl(databaseUrl: string): string {
  if (!isPooledPostgresConnectionString(databaseUrl)) return databaseUrl;
  const url = new URL(databaseUrl);
  // The pooled test accepts "-pooler" and ".pooler" (and "pooler" as a whole label); remove the word and its leading separator.
  url.hostname = url.hostname.replace(/[-.]pooler(?=[.-]|$)/i, "");
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

/** Throws unless the connection reports exactly the expected branch; a replay target also must not be production. */
export function assertExpectedIdentity(identity: ConnectedIdentity, resolved: Pick<ResolvedMigrationTarget, "target" | "expectedBranchId">): void {
  const branch = identity.branchId?.trim().toLowerCase() ?? null;
  const expected = resolved.expectedBranchId.toLowerCase();
  if (branch !== expected) {
    throw new MigrationTargetError(`The connected database is not the ${resolved.target} branch; stopping before any change.`);
  }
  if (resolved.target === "replay" && branch === KNOWN_PRODUCTION_BRANCH_ID) {
    throw new MigrationTargetError("The connected database is the production branch; refusing a replay target.");
  }
}

/** The error text that is safe to print: our own refusals verbatim, anything else as class and code only (no host, no URL). */
export function safeErrorText(error: unknown): string {
  if (error instanceof MigrationTargetError) return error.message;
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return `${error.name}${typeof code === "string" ? ` (${code})` : ""}`;
  }
  return "unknown error";
}

export interface MigrationCommandClient {
  query: Pick<pg.Client, "query">["query"];
  end(): Promise<void>;
}

export interface MigrationCommandDependencies {
  connect(url: string): Promise<MigrationCommandClient>;
  pendingMigrations(client: MigrationCommandClient): Promise<{ applied: number; pending: string[] }>;
  runPending(client: MigrationCommandClient): Promise<string[]>;
  resolveWorkspaceId(client: MigrationCommandClient): Promise<string>;
  /** Replay only: the repository's replay-target guard (throws when the identity is not an approved replay branch). */
  approveReplayTarget(url: string, identity: ConnectedIdentity, expectedBranchId: string): void;
}

export interface MigrationCommandResult {
  exitCode: 0 | 1;
  /** Lines safe to print: counts and the pending file names, never a URL or a host. */
  lines: string[];
}

/**
 * The whole command with its dependencies injected. Never throws: a refusal or failure is exit code 1 and a safe line.
 * The identity check before any change is the gate; the check after the run only detects a connection that moved.
 */
export async function executeMigrationCommand(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: MigrationCommandDependencies,
): Promise<MigrationCommandResult> {
  const lines: string[] = [];
  let client: MigrationCommandClient | null = null;
  try {
    const resolved = resolveMigrationTarget(argv, env);
    const url = resolved.target === "replay" ? directReplayUrl(resolved.databaseUrl) : resolved.databaseUrl;
    client = await deps.connect(url);
    const identity = await readConnectedIdentity(client);
    assertExpectedIdentity(identity, resolved);
    if (resolved.target === "replay") {
      deps.approveReplayTarget(url, identity, resolved.expectedBranchId);
    } else {
      const workspaceId = await deps.resolveWorkspaceId(client);
      if (workspaceId.toLowerCase() !== resolved.confirmWorkspaceId!.toLowerCase()) {
        throw new MigrationTargetError("Refusing to migrate production: --confirm-workspace must equal the resolved workspace id.");
      }
    }
    lines.push(`target=${resolved.target} database=${identity.databaseName} branch=${identity.branchId}`);
    const before = await deps.pendingMigrations(client);
    lines.push(JSON.stringify({ applied: before.applied, pending: before.pending }));
    const applied = await deps.runPending(client);
    assertExpectedIdentity(await readConnectedIdentity(client), resolved);
    lines.push(`Migration runner finished. Applied ${applied.length} migration(s).`);
    return { exitCode: 0, lines };
  } catch (error) {
    lines.push(`Migration refused or failed: ${safeErrorText(error)}`);
    return { exitCode: 1, lines };
  } finally {
    await client?.end().catch(() => undefined);
  }
}
