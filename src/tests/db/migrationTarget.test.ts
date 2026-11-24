import { describe, expect, it } from "vitest";

import {
  assertReplayIdentity,
  directReplayUrl,
  KNOWN_PRODUCTION_BRANCH_ID,
  MigrationTargetError,
  resolveMigrationTarget,
} from "../../db/migrationTarget.js";

const REPLAY_URL = "postgres://user:pw@ep-replay-example.c-3.ap-southeast-1.aws.neon.tech/neondb";
const PROD_URL = "postgres://user:pw@ep-prod-example.c-3.ap-southeast-1.aws.neon.tech/neondb";
const WORKSPACE = "c1a11527-67a2-4d0b-8be2-3a4061462756";
const env = { REPLAY_DATABASE_URL: REPLAY_URL, REPLAY_BRANCH_ID: "br-wild-term-az1umm80", DATABASE_URL: PROD_URL };

describe("resolveMigrationTarget", () => {
  it("requires an explicit target and never defaults to DATABASE_URL", () => {
    expect(() => resolveMigrationTarget([], env)).toThrow(MigrationTargetError);
    expect(() => resolveMigrationTarget([], { DATABASE_URL: PROD_URL })).toThrow(/--target replay\|production is required/);
    expect(() => resolveMigrationTarget(["--target", "staging"], env)).toThrow(/is required/);
    expect(() => resolveMigrationTarget(["--target="], env)).toThrow(/is required/);
  });

  it("replay reads only REPLAY_DATABASE_URL and needs the branch id", () => {
    const resolved = resolveMigrationTarget(["--target", "replay"], env);
    expect(resolved).toEqual({ target: "replay", databaseUrl: REPLAY_URL, expectedBranchId: "br-wild-term-az1umm80", confirmWorkspaceId: null });
    expect(resolveMigrationTarget(["--target=replay"], env).databaseUrl).toBe(REPLAY_URL);
    // DATABASE_URL set, REPLAY_DATABASE_URL missing: refused, never used instead.
    expect(() => resolveMigrationTarget(["--target", "replay"], { DATABASE_URL: PROD_URL, REPLAY_BRANCH_ID: "br-wild-term-az1umm80" })).toThrow(/REPLAY_DATABASE_URL/);
    expect(() => resolveMigrationTarget(["--target", "replay"], { REPLAY_DATABASE_URL: REPLAY_URL })).toThrow(/REPLAY_BRANCH_ID/);
    expect(() => resolveMigrationTarget(["--target", "replay"], { REPLAY_DATABASE_URL: REPLAY_URL, REPLAY_BRANCH_ID: "not-a-branch" })).toThrow(/REPLAY_BRANCH_ID/);
  });

  it("replay refuses the known production branch id", () => {
    expect(() => resolveMigrationTarget(["--target", "replay"], { ...env, REPLAY_BRANCH_ID: KNOWN_PRODUCTION_BRANCH_ID })).toThrow(/production/);
  });

  it("production needs --confirm-production and --confirm-workspace", () => {
    expect(() => resolveMigrationTarget(["--target", "production"], env)).toThrow(/--confirm-production/);
    expect(() => resolveMigrationTarget(["--target", "production", "--confirm-production"], env)).toThrow(/--confirm-workspace/);
    expect(() => resolveMigrationTarget(["--target", "production", "--confirm-production", "--confirm-workspace=not-a-uuid"], env)).toThrow(/--confirm-workspace/);
    expect(() => resolveMigrationTarget(["--target", "production", "--confirm-workspace=" + WORKSPACE], env)).toThrow(/--confirm-production/);
    const resolved = resolveMigrationTarget(["--target", "production", "--confirm-production", `--confirm-workspace=${WORKSPACE}`], env);
    expect(resolved).toEqual({ target: "production", databaseUrl: PROD_URL, expectedBranchId: null, confirmWorkspaceId: WORKSPACE });
  });

  it("production prefers the unpooled URL and refuses a pooled one", () => {
    const flags = ["--target", "production", "--confirm-production", `--confirm-workspace=${WORKSPACE}`];
    const direct = "postgres://user:pw@ep-direct-example.c-3.ap-southeast-1.aws.neon.tech/neondb";
    expect(resolveMigrationTarget(flags, { ...env, DATABASE_URL_UNPOOLED: direct }).databaseUrl).toBe(direct);
    expect(() => resolveMigrationTarget(flags, { DATABASE_URL: "postgres://user:pw@ep-x-pooler.c-3.ap-southeast-1.aws.neon.tech/neondb" })).toThrow(/unpooled/);
    expect(() => resolveMigrationTarget(flags, {})).toThrow(/DATABASE_URL/);
  });
});

describe("replay identity", () => {
  it("accepts only the expected replay branch", () => {
    expect(() => assertReplayIdentity({ databaseName: "neondb", branchId: "br-wild-term-az1umm80" }, "br-wild-term-az1umm80")).not.toThrow();
    expect(() => assertReplayIdentity({ databaseName: "neondb", branchId: "br-other-branch-12345" }, "br-wild-term-az1umm80")).toThrow(MigrationTargetError);
    expect(() => assertReplayIdentity({ databaseName: "neondb", branchId: null }, "br-wild-term-az1umm80")).toThrow(MigrationTargetError);
    expect(() => assertReplayIdentity({ databaseName: "neondb", branchId: KNOWN_PRODUCTION_BRANCH_ID }, KNOWN_PRODUCTION_BRANCH_ID)).toThrow(MigrationTargetError);
  });

  it("derives the direct endpoint of a pooled replay URL and leaves a direct one alone", () => {
    expect(directReplayUrl("postgres://u:p@ep-replay-pooler.c-3.ap-southeast-1.aws.neon.tech/neondb")).toContain("ep-replay.c-3");
    expect(directReplayUrl(REPLAY_URL)).toBe(REPLAY_URL);
  });
});
