/**
 * Guards of scripts/deactivate_stale_embedding_spaces.ts, kept here so the refusal cases are unit-testable.
 * Pure functions: no I/O, and they never echo a connection string.
 */
export interface DeactivationGuardInput {
  readonly apply: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly argv: readonly string[];
  readonly connectedBranchId: string | null;
  readonly workspaceId: string;
}

export function argValue(argv: readonly string[], name: string): string | undefined {
  return argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

/** Replay branch only; apply additionally needs the env switch and an explicit workspace confirmation. */
export function assertDeactivationAllowed(input: DeactivationGuardInput): void {
  const expectedBranch = input.env.REPLAY_BRANCH_ID?.trim();
  if (!expectedBranch || input.connectedBranchId !== expectedBranch) {
    throw new Error("Connected branch does not equal REPLAY_BRANCH_ID.");
  }
  if (!input.apply) return;
  if (input.env.EMBEDDING_SPACE_DEACTIVATE_ALLOWED !== "true") {
    throw new Error("Refusing to apply: set EMBEDDING_SPACE_DEACTIVATE_ALLOWED=true after the owner approves the dry-run output.");
  }
  if (argValue(input.argv, "confirm-workspace") !== input.workspaceId) {
    throw new Error("Refusing to apply: --confirm-workspace must equal the resolved workspace id.");
  }
}
