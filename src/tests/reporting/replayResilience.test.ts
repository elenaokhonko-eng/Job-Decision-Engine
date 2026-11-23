import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type pg from "pg";
import { describe, expect, it } from "vitest";

import {
  ResilientClient,
  assessReplay,
  attachPoolErrorHandler,
  emptyReplayTotals,
  isTransientConnectionError,
  retryOnConnectionLoss,
} from "../../reporting/replayResilience.js";

const noSleep = async (): Promise<void> => undefined;

type Script = Array<"ok" | "drop" | "statement-error">;

/** A fake pg.Client. `script` says what each query does; a drop also emits the 'error' event the real client emits. */
class FakeClient extends EventEmitter {
  queries: string[] = [];
  ended = false;
  constructor(private readonly script: Script) {
    super();
  }
  async connect(): Promise<void> {}
  async end(): Promise<void> {
    this.ended = true;
  }
  async query(text: string): Promise<{ rows: unknown[]; rowCount: number }> {
    this.queries.push(text);
    const step = this.script.shift() ?? "ok";
    if (step === "drop") {
      const error = new Error("Connection terminated unexpectedly");
      // pg emits 'error' on the client for a dropped connection; with no listener Node throws it unhandled.
      this.emit("error", error);
      throw error;
    }
    if (step === "statement-error") throw Object.assign(new Error('relation "nope" does not exist'), { code: "42P01" });
    return { rows: [{ n: this.queries.length }], rowCount: 1 };
  }
}

function clientOver(...scripts: Script[]): { client: ResilientClient; fakes: FakeClient[]; logs: string[] } {
  const fakes: FakeClient[] = [];
  const logs: string[] = [];
  const client = new ResilientClient(
    () => {
      const fake = new FakeClient(scripts[fakes.length] ?? []);
      fakes.push(fake);
      return fake as unknown as pg.Client;
    },
    { sleep: noSleep, log: (message) => logs.push(message) },
  );
  return { client, fakes, logs };
}

describe("isTransientConnectionError", () => {
  it("recognises dropped connections and nothing else", () => {
    expect(isTransientConnectionError(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(isTransientConnectionError(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(true);
    expect(isTransientConnectionError(Object.assign(new Error("x"), { code: "57P01" }))).toBe(true);
    expect(isTransientConnectionError(Object.assign(new Error("syntax"), { code: "42601" }))).toBe(false);
    expect(isTransientConnectionError(new Error("null value in column"))).toBe(false);
    expect(isTransientConnectionError(undefined)).toBe(false);
  });
});

describe("ResilientClient failure injection", () => {
  it("handles the 'error' event (no unhandled crash), reconnects and retries a statement outside a transaction", async () => {
    const { client, fakes, logs } = clientOver(["drop"], ["ok"]);
    await client.connect();
    const result = await client.query<{ n: number }>("SELECT 1");
    expect(result.rows[0].n).toBe(1);
    expect(fakes).toHaveLength(2);
    expect(fakes[0].ended).toBe(true);
    expect(client.reconnects).toBeGreaterThanOrEqual(1);
    expect(logs.some((line) => line.includes("Connection terminated unexpectedly"))).toBe(true);
  });

  it("an idle 'error' event marks the client broken and the next query uses a new connection", async () => {
    const { client, fakes } = clientOver([], ["ok"]);
    await client.connect();
    fakes[0].emit("error", new Error("Connection terminated unexpectedly"));
    await client.query("SELECT 1");
    expect(fakes).toHaveLength(2);
    expect(fakes[1].queries).toEqual(["SELECT 1"]);
  });

  it("does not retry a statement error", async () => {
    const { client, fakes } = clientOver(["statement-error"]);
    await client.connect();
    await expect(client.query("SELECT * FROM nope")).rejects.toThrow(/does not exist/);
    expect(fakes).toHaveLength(1);
  });

  it("gives up and throws when the connection keeps dropping", async () => {
    const { client } = clientOver(["drop"], ["drop"], ["drop"], ["drop"], ["drop"], ["drop"]);
    await client.connect();
    await expect(client.query("SELECT 1")).rejects.toThrow(/Connection terminated/);
  });

  it("a drop inside a transaction throws (the transaction is lost) and the caller redoes the whole unit", async () => {
    const { client, fakes } = clientOver(["ok", "drop"], ["ok", "ok", "ok"]);
    await client.connect();
    let runs = 0;
    const unit = async (): Promise<number> => {
      runs += 1;
      await client.query("BEGIN READ ONLY");
      try {
        const result = await client.query<{ n: number }>("SELECT 1");
        return result.rows[0].n;
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
      }
    };
    const value = await retryOnConnectionLoss(unit, { sleep: noSleep });
    expect(runs).toBe(2);
    expect(value).toBeGreaterThan(0);
    expect(fakes).toHaveLength(2);
    // The retried unit begins its own transaction on the new connection.
    expect(fakes[1].queries).toContain("BEGIN READ ONLY");
  });
});

describe("retryOnConnectionLoss", () => {
  it("retries only connection errors, then surfaces the last one", async () => {
    let calls = 0;
    await expect(
      retryOnConnectionLoss(async () => {
        calls += 1;
        throw new Error("Connection terminated unexpectedly");
      }, { attempts: 3, sleep: noSleep }),
    ).rejects.toThrow(/Connection terminated/);
    expect(calls).toBe(3);

    calls = 0;
    await expect(
      retryOnConnectionLoss(async () => {
        calls += 1;
        throw new Error("boom");
      }, { sleep: noSleep }),
    ).rejects.toThrow("boom");
    expect(calls).toBe(1);
  });
});

describe("attachPoolErrorHandler", () => {
  it("gives a pool 'error' event a listener so it cannot crash the process", () => {
    const pool = new EventEmitter() as unknown as pg.Pool;
    const logs: string[] = [];
    attachPoolErrorHandler(pool, (line) => logs.push(line));
    expect(() => (pool as unknown as EventEmitter).emit("error", new Error("Connection terminated unexpectedly"))).not.toThrow();
    expect(logs).toHaveLength(1);
  });
});

describe("assessReplay: any failed or incomplete stage fails the run", () => {
  const complete = { ...emptyReplayTotals(), extracted: 10, embeddingsOk: 30, matched: 8, matchHeldBack: 2 };
  const counts = { extractionDiscovered: 10, rematchOnly: false };

  it("passes a complete run", () => {
    expect(assessReplay(complete, counts)).toEqual([]);
  });

  it.each([
    ["extraction error", { extractionErrors: 1 }],
    ["embedding failure", { embeddingsFailed: 1 }],
    ["match error", { matchErrors: 1 }],
    ["decision error", { decisionErrors: 1 }],
  ])("fails on a %s", (_name, patch) => {
    expect(assessReplay({ ...complete, ...patch }, counts).length).toBeGreaterThan(0);
  });

  it("fails when fewer jobs were extracted than the stage selected", () => {
    expect(assessReplay({ ...complete, extracted: 7 }, counts).join()).toMatch(/extraction incomplete: 7 of 10/);
  });

  it("rematch-only does not expect extraction", () => {
    expect(assessReplay({ ...complete, extracted: 0 }, { extractionDiscovered: 0, rematchOnly: true })).toEqual([]);
  });
});

describe("replay script wiring", () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), "scripts/replay_requirement_extraction.ts"), "utf8");

  it("keeps the guard and the replay-branch variables", () => {
    expect(source).toContain("requireApprovedReplayTarget(");
    expect(source).toContain("REPLAY_BRANCH_ID");
    expect(source).toContain("REPLAY_DATABASE_URL");
  });

  it("handles connection errors, resumes, fails on incomplete stages and prints totals only on success", () => {
    expect(source).toContain("ResilientClient");
    expect(source).toContain("attachPoolErrorHandler(pool)");
    expect(source).toContain("loadJobsOnExtractorVersion");
    expect(source).toMatch(/process\.on\(event,/);
    expect(source).toContain("assessReplay(");
    const failureBranch = source.indexOf("if (failures.length > 0)");
    const successTotals = source.indexOf("console.log(`\\nReplay totals:");
    expect(failureBranch).toBeGreaterThan(-1);
    expect(successTotals).toBeGreaterThan(failureBranch);
    expect(source).toMatch(/process\.exit\(1\)/);
    expect(source).not.toMatch(/\|\| true|process\.exit\(0\)/);
  });
});
