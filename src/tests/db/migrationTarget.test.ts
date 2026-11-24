import { describe, expect, it, vi } from "vitest";

import {
  assertExpectedIdentity,
  directReplayUrl,
  executeMigrationCommand,
  KNOWN_PRODUCTION_BRANCH_ID,
  MigrationTargetError,
  resolveMigrationTarget,
  safeErrorText,
  type MigrationCommandClient,
  type MigrationCommandDependencies,
} from "../../db/migrationTarget.js";
import { STAGE1_3_STAGING_IDENTITY_EXPECTATIONS } from "../../db/stagingDatabaseIdentity.js";

const REPLAY_URL = "postgres://example:example@ep-replay-example.c-3.ap-southeast-1.aws.neon.tech/neondb";
const DIRECT_URL = "postgres://example:example@ep-direct-example.c-3.ap-southeast-1.aws.neon.tech/neondb";
const POOLED_URL = "postgres://example:example@ep-pooled-example-pooler.c-3.ap-southeast-1.aws.neon.tech/neondb";
const WORKSPACE = "c1a11527-67a2-4d0b-8be2-3a4061462756";
const REPLAY_BRANCH = "br-wild-term-az1umm80";
const env = { REPLAY_DATABASE_URL: REPLAY_URL, REPLAY_BRANCH_ID: REPLAY_BRANCH, DATABASE_URL: DIRECT_URL, DATABASE_URL_UNPOOLED: DIRECT_URL };
const productionFlags = ["--target", "production", "--confirm-production", `--confirm-workspace=${WORKSPACE}`];

describe("resolveMigrationTarget", () => {
  it("has one definition of the production branch id", () => {
    expect(KNOWN_PRODUCTION_BRANCH_ID).toBe(STAGE1_3_STAGING_IDENTITY_EXPECTATIONS.knownProductionBranchId);
  });

  it("requires an explicit target and never defaults to DATABASE_URL", () => {
    expect(() => resolveMigrationTarget([], env)).toThrow(MigrationTargetError);
    expect(() => resolveMigrationTarget([], { DATABASE_URL: DIRECT_URL })).toThrow(/--target replay\|production is required/);
    expect(() => resolveMigrationTarget(["--target", "staging"], env)).toThrow(/is required/);
    expect(() => resolveMigrationTarget(["--target="], env)).toThrow(/is required/);
    expect(() => resolveMigrationTarget(["--target"], env)).toThrow(/is required/);
  });

  it("accepts the target in any case and with spaces", () => {
    expect(resolveMigrationTarget(["--target=REPLAY "], env).target).toBe("replay");
    expect(resolveMigrationTarget(["--target", " Replay"], env).target).toBe("replay");
  });

  it("replay reads only REPLAY_DATABASE_URL and needs the branch id", () => {
    expect(resolveMigrationTarget(["--target", "replay"], env)).toEqual({
      target: "replay", databaseUrl: REPLAY_URL, expectedBranchId: REPLAY_BRANCH, confirmWorkspaceId: null,
    });
    expect(resolveMigrationTarget(["--target", "replay"], { ...env, REPLAY_DATABASE_URL: ` ${REPLAY_URL} `, REPLAY_BRANCH_ID: ` ${REPLAY_BRANCH} ` }).databaseUrl).toBe(REPLAY_URL);
    expect(() => resolveMigrationTarget(["--target", "replay"], { DATABASE_URL: DIRECT_URL, REPLAY_BRANCH_ID: REPLAY_BRANCH })).toThrow(/REPLAY_DATABASE_URL/);
    expect(() => resolveMigrationTarget(["--target", "replay"], { REPLAY_DATABASE_URL: REPLAY_URL })).toThrow(/REPLAY_BRANCH_ID/);
    expect(() => resolveMigrationTarget(["--target", "replay"], { REPLAY_DATABASE_URL: REPLAY_URL, REPLAY_BRANCH_ID: "not-a-branch" })).toThrow(/REPLAY_BRANCH_ID/);
  });

  it("replay refuses the known production branch id", () => {
    expect(() => resolveMigrationTarget(["--target", "replay"], { ...env, REPLAY_BRANCH_ID: KNOWN_PRODUCTION_BRANCH_ID })).toThrow(/production/);
  });

  it("production needs --confirm-production, a workspace uuid and DATABASE_URL_UNPOOLED, with no fallback", () => {
    expect(() => resolveMigrationTarget(["--target", "production"], env)).toThrow(/--confirm-production/);
    expect(() => resolveMigrationTarget(["--target", "production", "--confirm-production"], env)).toThrow(/--confirm-workspace/);
    expect(() => resolveMigrationTarget(["--target", "production", "--confirm-production", "--confirm-workspace=not-a-uuid"], env)).toThrow(/--confirm-workspace/);
    expect(() => resolveMigrationTarget(["--target", "production", `--confirm-workspace=${WORKSPACE}`], env)).toThrow(/--confirm-production/);
    // DATABASE_URL alone is never enough.
    expect(() => resolveMigrationTarget(productionFlags, { DATABASE_URL: DIRECT_URL })).toThrow(/DATABASE_URL_UNPOOLED/);
    expect(() => resolveMigrationTarget(productionFlags, { DATABASE_URL: DIRECT_URL, DATABASE_URL_UNPOOLED: "  " })).toThrow(/DATABASE_URL_UNPOOLED/);
    expect(() => resolveMigrationTarget(productionFlags, { DATABASE_URL_UNPOOLED: POOLED_URL })).toThrow(/pooled/);
    expect(resolveMigrationTarget(productionFlags, env)).toEqual({
      target: "production", databaseUrl: DIRECT_URL, expectedBranchId: KNOWN_PRODUCTION_BRANCH_ID, confirmWorkspaceId: WORKSPACE,
    });
    expect(resolveMigrationTarget(["--target=PRODUCTION", "--confirm-production", `--confirm-workspace=${WORKSPACE.toUpperCase()}`], env).confirmWorkspaceId).toBe(WORKSPACE.toUpperCase());
  });

  it("an explicit PRODUCTION_BRANCH_ID must equal the known production branch", () => {
    expect(resolveMigrationTarget(productionFlags, { ...env, PRODUCTION_BRANCH_ID: KNOWN_PRODUCTION_BRANCH_ID }).expectedBranchId).toBe(KNOWN_PRODUCTION_BRANCH_ID);
    expect(() => resolveMigrationTarget(productionFlags, { ...env, PRODUCTION_BRANCH_ID: REPLAY_BRANCH })).toThrow(/known production branch/);
  });
});

describe("identity", () => {
  it("accepts only the expected branch, ignoring case and whitespace", () => {
    const replay = { target: "replay", expectedBranchId: REPLAY_BRANCH } as const;
    expect(() => assertExpectedIdentity({ databaseName: "neondb", branchId: REPLAY_BRANCH }, replay)).not.toThrow();
    expect(() => assertExpectedIdentity({ databaseName: "neondb", branchId: ` ${REPLAY_BRANCH.toUpperCase()} ` }, replay)).not.toThrow();
    expect(() => assertExpectedIdentity({ databaseName: "neondb", branchId: "br-other-branch-12345" }, replay)).toThrow(MigrationTargetError);
    expect(() => assertExpectedIdentity({ databaseName: "neondb", branchId: null }, replay)).toThrow(MigrationTargetError);
    expect(() => assertExpectedIdentity({ databaseName: "neondb", branchId: KNOWN_PRODUCTION_BRANCH_ID }, { target: "replay", expectedBranchId: KNOWN_PRODUCTION_BRANCH_ID })).toThrow(/production/);
    const production = { target: "production", expectedBranchId: KNOWN_PRODUCTION_BRANCH_ID } as const;
    expect(() => assertExpectedIdentity({ databaseName: "neondb", branchId: KNOWN_PRODUCTION_BRANCH_ID }, production)).not.toThrow();
    expect(() => assertExpectedIdentity({ databaseName: "neondb", branchId: REPLAY_BRANCH }, production)).toThrow(MigrationTargetError);
  });

  it("derives the direct endpoint for a '-pooler' and a '.pooler' host and leaves a direct one alone", () => {
    expect(directReplayUrl(POOLED_URL)).toContain("ep-pooled-example.c-3");
    expect(directReplayUrl("postgres://u:p@ep-example.pooler.c-3.ap-southeast-1.aws.neon.tech/neondb")).toContain("ep-example.c-3");
    expect(directReplayUrl(REPLAY_URL)).toBe(REPLAY_URL);
  });

  it("prints our refusals verbatim and anything else as class and code only, never a host", () => {
    expect(safeErrorText(new MigrationTargetError("--target is required"))).toBe("--target is required");
    const network = Object.assign(new Error("getaddrinfo ENOTFOUND ep-secret-host.c-3.neon.tech"), { code: "ENOTFOUND" });
    expect(safeErrorText(network)).toBe("Error (ENOTFOUND)");
    expect(safeErrorText("a string")).toBe("unknown error");
  });
});

interface Harness {
  deps: MigrationCommandDependencies;
  calls: string[];
  ended: () => number;
}

function harness(options: { branch: string | null; secondBranch?: string | null; workspace?: string; runError?: Error; connectError?: Error } ): Harness {
  const calls: string[] = [];
  let ends = 0;
  let identityReads = 0;
  const client: MigrationCommandClient = {
    query: (async () => {
      identityReads += 1;
      const branch = identityReads > 1 && options.secondBranch !== undefined ? options.secondBranch : options.branch;
      return { rows: [{ d: "neondb", b: branch }] };
    }) as unknown as MigrationCommandClient["query"],
    end: async () => { ends += 1; },
  };
  const deps: MigrationCommandDependencies = {
    connect: async () => {
      if (options.connectError) throw options.connectError;
      calls.push("connect");
      return client;
    },
    pendingMigrations: async () => { calls.push("status"); return { applied: 118, pending: ["120_x.sql"] }; },
    runPending: async () => {
      calls.push("run");
      if (options.runError) throw options.runError;
      return ["120_x.sql"];
    },
    resolveWorkspaceId: async () => { calls.push("workspace"); return options.workspace ?? WORKSPACE; },
    approveReplayTarget: vi.fn(() => { calls.push("approve"); }),
  };
  return { deps, calls, ended: () => ends };
}

describe("executeMigrationCommand", () => {
  it("replay on the replay branch runs, prints counts and exits 0", async () => {
    const h = harness({ branch: REPLAY_BRANCH });
    const result = await executeMigrationCommand(["--target", "replay"], env, h.deps);
    expect(result.exitCode).toBe(0);
    expect(h.calls).toEqual(["connect", "approve", "status", "run"]);
    expect(result.lines.join("\\n")).not.toMatch(/postgres:|ep-/);
    expect(h.ended()).toBe(1);
  });

  it("replay on any other branch (including production) stops before any change", async () => {
    for (const branch of ["br-other-branch-12345", KNOWN_PRODUCTION_BRANCH_ID, null]) {
      const h = harness({ branch });
      const result = await executeMigrationCommand(["--target", "replay"], env, h.deps);
      expect(result.exitCode).toBe(1);
      expect(h.calls).toEqual(["connect"]);
      expect(h.ended()).toBe(1);
    }
  });

  it("production refuses a connection that is not the production branch, even with the right workspace (a replay clone has the same workspace)", async () => {
    const h = harness({ branch: REPLAY_BRANCH });
    const result = await executeMigrationCommand(productionFlags, env, h.deps);
    expect(result.exitCode).toBe(1);
    expect(h.calls).toEqual(["connect"]);
    expect(result.lines.join(" ")).toMatch(/not the production branch/);
  });

  it("production refuses a workspace mismatch before running anything", async () => {
    const h = harness({ branch: KNOWN_PRODUCTION_BRANCH_ID, workspace: "00000000-0000-4000-8000-000000000000" });
    const result = await executeMigrationCommand(productionFlags, env, h.deps);
    expect(result.exitCode).toBe(1);
    expect(h.calls).toEqual(["connect", "workspace"]);
    expect(result.lines.join(" ")).toMatch(/--confirm-workspace must equal/);
  });

  it("production on the production branch with the matching workspace runs", async () => {
    const h = harness({ branch: KNOWN_PRODUCTION_BRANCH_ID });
    const result = await executeMigrationCommand(productionFlags, env, h.deps);
    expect(result.exitCode).toBe(0);
    expect(h.calls).toEqual(["connect", "workspace", "status", "run"]);
  });

  it("a refusal needs no connection: missing target, production without flags", async () => {
    for (const argv of [[], ["--target", "production"], ["--target", "nope"]]) {
      const h = harness({ branch: REPLAY_BRANCH });
      const result = await executeMigrationCommand(argv, env, h.deps);
      expect(result.exitCode).toBe(1);
      expect(h.calls).toEqual([]);
    }
  });

  it("a failure prints class and code only, never the host in the error message, and exits 1", async () => {
    const failure = Object.assign(new Error("getaddrinfo ENOTFOUND ep-secret-host.c-3.neon.tech"), { code: "ENOTFOUND" });
    const connectFailure = await executeMigrationCommand(["--target", "replay"], env, harness({ branch: REPLAY_BRANCH, connectError: failure }).deps);
    expect(connectFailure.exitCode).toBe(1);
    expect(connectFailure.lines.join(" ")).not.toMatch(/ep-secret-host|neon\.tech/);
    const runFailure = await executeMigrationCommand(["--target", "replay"], env, harness({ branch: REPLAY_BRANCH, runError: failure }).deps);
    expect(runFailure.exitCode).toBe(1);
    expect(runFailure.lines.join(" ")).toContain("Error (ENOTFOUND)");
    expect(runFailure.lines.join(" ")).not.toMatch(/ep-secret-host|neon\.tech/);
  });

  it("detects a connection that moved to another branch during the run (exit 1)", async () => {
    const h = harness({ branch: REPLAY_BRANCH, secondBranch: KNOWN_PRODUCTION_BRANCH_ID });
    const result = await executeMigrationCommand(["--target", "replay"], env, h.deps);
    expect(result.exitCode).toBe(1);
    expect(h.calls).toContain("run");
  });
});
