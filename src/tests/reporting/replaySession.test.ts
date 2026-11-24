import { describe, expect, it } from "vitest";

import { withReplaySession, type ReplayConnection, type ReplaySessionDependencies } from "../../reporting/replaySession.js";

const PRODUCTION_BRANCH = "br-sweet-lab-azucfmoz";
const REPLAY_BRANCH = "br-replay-branch-1";
const SECRET = "s3cr3t-pw-do-not-print";
// An unapproved host (not a known production or staging host); the connected branch id decides.
const URL_OTHER = `postgresql://user:${SECRET}@ep-some-replay.c-3.ap-southeast-1.aws.neon.tech/neondb`;
// The approved staging host: with a null branch id and no REPLAY_BRANCH_ID the guard alone would accept it.
const URL_STAGING_HOST = `postgresql://user:${SECRET}@ep-lingering-frog-azbw8weo.c-3.ap-southeast-1.aws.neon.tech/neondb`;

function fake(identity: { d: string; b: string | null }) {
  const statements: string[] = [];
  let ended = 0;
  let connected = 0;
  const connection: ReplayConnection = {
    async query(sql) {
      statements.push(sql.trim().split(/\s+/).slice(0, 2).join(" "));
      return { rows: [identity] };
    },
    async end() { ended += 1; },
  };
  const dependencies: ReplaySessionDependencies = {
    connect: async () => { connected += 1; return connection; },
    resolveWorkspaceId: async () => "ws-1",
  };
  return { statements, dependencies, ended: () => ended, connected: () => connected };
}
const lastStatement = (statements: string[]) => statements.at(-1);

describe("withReplaySession fails closed", () => {
  it("refuses a missing URL before connecting", async () => {
    const f = fake({ d: "neondb", b: REPLAY_BRANCH });
    await expect(withReplaySession({ readOnly: true }, async () => 1, { REPLAY_BRANCH_ID: REPLAY_BRANCH }, f.dependencies)).rejects.toThrow(/REPLAY_DATABASE_URL is not set/);
    expect(f.connected()).toBe(0);
  });

  it("refuses to commit a read-only session before connecting", async () => {
    const f = fake({ d: "neondb", b: REPLAY_BRANCH });
    await expect(withReplaySession({ readOnly: true, commit: true }, async () => 1, { REPLAY_DATABASE_URL: URL_OTHER, REPLAY_BRANCH_ID: REPLAY_BRANCH }, f.dependencies)).rejects.toThrow(/read-only replay session cannot commit/);
    expect(f.connected()).toBe(0);
  });

  it("refuses when REPLAY_BRANCH_ID is unset, even on the approved staging host", async () => {
    const f = fake({ d: "neondb", b: null });
    let ran = false;
    await expect(withReplaySession({ readOnly: true }, async () => { ran = true; }, { REPLAY_DATABASE_URL: URL_STAGING_HOST }, f.dependencies)).rejects.toThrow(/REPLAY_BRANCH_ID/);
    expect(ran).toBe(false);
    expect(lastStatement(f.statements)).toBe("ROLLBACK");
    expect(f.ended()).toBe(1);
  });

  it("refuses a null connected branch id on an unapproved host, and on the approved host when REPLAY_BRANCH_ID is set", async () => {
    for (const url of [URL_OTHER, URL_STAGING_HOST]) {
      const f = fake({ d: "neondb", b: null });
      let ran = false;
      await expect(withReplaySession({ readOnly: true }, async () => { ran = true; }, { REPLAY_DATABASE_URL: url, REPLAY_BRANCH_ID: REPLAY_BRANCH }, f.dependencies)).rejects.toThrow();
      expect(ran).toBe(false);
      expect(lastStatement(f.statements)).toBe("ROLLBACK");
    }
  });

  it("refuses the production branch, connected or supplied as REPLAY_BRANCH_ID", async () => {
    const connected = fake({ d: "neondb", b: PRODUCTION_BRANCH });
    let ran = false;
    await expect(withReplaySession({ readOnly: true }, async () => { ran = true; }, { REPLAY_DATABASE_URL: URL_OTHER, REPLAY_BRANCH_ID: REPLAY_BRANCH }, connected.dependencies)).rejects.toThrow(/not an approved replay branch/);
    const supplied = fake({ d: "neondb", b: PRODUCTION_BRANCH });
    await expect(withReplaySession({ readOnly: true }, async () => { ran = true; }, { REPLAY_DATABASE_URL: URL_OTHER, REPLAY_BRANCH_ID: PRODUCTION_BRANCH }, supplied.dependencies)).rejects.toThrow(/known production branch/);
    expect(ran).toBe(false);
    expect(lastStatement(connected.statements)).toBe("ROLLBACK");
  });

  it("refuses when the connected branch differs from REPLAY_BRANCH_ID", async () => {
    const f = fake({ d: "neondb", b: "br-another-branch-9" });
    let ran = false;
    await expect(withReplaySession({ readOnly: true }, async () => { ran = true; }, { REPLAY_DATABASE_URL: URL_OTHER, REPLAY_BRANCH_ID: REPLAY_BRANCH }, f.dependencies)).rejects.toThrow(/not an approved replay branch/);
    expect(ran).toBe(false);
  });

  it("refuses a wrong database name", async () => {
    const f = fake({ d: "postgres", b: REPLAY_BRANCH });
    await expect(withReplaySession({ readOnly: true }, async () => 1, { REPLAY_DATABASE_URL: URL_OTHER, REPLAY_BRANCH_ID: REPLAY_BRANCH }, f.dependencies)).rejects.toThrow(/not an approved replay branch/);
  });

  it("never puts the password in an error message", async () => {
    const f = fake({ d: "neondb", b: PRODUCTION_BRANCH });
    const error = await withReplaySession({ readOnly: true }, async () => 1, { REPLAY_DATABASE_URL: URL_OTHER, REPLAY_BRANCH_ID: REPLAY_BRANCH }, f.dependencies).catch((e: Error) => e);
    expect((error as Error).message).not.toContain(SECRET);
  });
});

describe("withReplaySession on the matching replay branch", () => {
  const env = { REPLAY_DATABASE_URL: URL_OTHER, REPLAY_BRANCH_ID: REPLAY_BRANCH };

  it("runs read-only and rolls back", async () => {
    const f = fake({ d: "neondb", b: REPLAY_BRANCH });
    const result = await withReplaySession({ readOnly: true }, async (session) => `${session.branchId}/${session.workspaceId}`, env, f.dependencies);
    expect(result).toBe(`${REPLAY_BRANCH}/ws-1`);
    expect(f.statements[0]).toBe("BEGIN READ");
    expect(lastStatement(f.statements)).toBe("ROLLBACK");
    expect(f.ended()).toBe(1);
  });

  it("commits only when asked, and rolls back when the body throws", async () => {
    const committed = fake({ d: "neondb", b: REPLAY_BRANCH });
    await withReplaySession({ readOnly: false, commit: true }, async () => 1, env, committed.dependencies);
    expect(committed.statements[0]).toBe("BEGIN");
    expect(lastStatement(committed.statements)).toBe("COMMIT");
    const failing = fake({ d: "neondb", b: REPLAY_BRANCH });
    await expect(withReplaySession({ readOnly: false, commit: true }, async () => { throw new Error("body failed"); }, env, failing.dependencies)).rejects.toThrow(/body failed/);
    expect(failing.statements).not.toContain("COMMIT");
    expect(lastStatement(failing.statements)).toBe("ROLLBACK");
    expect(failing.ended()).toBe(1);
  });
});
