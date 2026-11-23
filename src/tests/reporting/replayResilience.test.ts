import { EventEmitter } from "node:events";
import type pg from "pg";
import { describe, expect, it } from "vitest";

import {
  ResilientClient,
  assessReplay,
  attachPoolErrorHandler,
  emptyReplayTotals,
  addChunkTotals,
  assertFirstChunkReachedMatcher,
  countGatePassedLeftBeforeMatching,
  isTransientConnectionError,
  retryOnConnectionLoss,
  runReplayChunk,
  type ReplayStages,
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

describe("ResilientClient: a connection lost inside a transaction", () => {
  it("throws from the next statement (the transaction is gone), reconnects, and lets ROLLBACK succeed", async () => {
    const { client, fakes } = clientOver(["ok", "ok"], ["ok", "ok"]);
    await client.connect();
    await client.query("BEGIN READ ONLY");
    // The server drops the connection while the transaction is open: only the 'error' event tells us.
    fakes[0].emit("error", new Error("Connection terminated unexpectedly"));
    await expect(client.query("SELECT 1")).rejects.toThrow(/lost inside a transaction/);
    expect(fakes).toHaveLength(2);
    await expect(client.query("ROLLBACK")).resolves.toBeDefined();
    // After the unit is abandoned the client works normally on the new connection.
    await expect(client.query("SELECT 1")).resolves.toBeDefined();
    expect(fakes[1].queries).toEqual(["ROLLBACK", "SELECT 1"]);
  });
});

describe("assessReplay: matchHeldBack semantics", () => {
  it("held-back matches are not failures", () => {
    const totals = { ...emptyReplayTotals(), extracted: 5, matched: 3, matchHeldBack: 2 };
    expect(assessReplay(totals, { extractionDiscovered: 5, rematchOnly: false })).toEqual([]);
  });
});

describe("runReplayChunk", () => {
  const chunk = { canonicalJobIds: ["c1", "c2"], jobVersionIds: ["v1", "v2"], extractJobVersionIds: ["v1", "v2"] };
  const options = { rematchOnly: false, maxRetries: 2, sleep: noSleep, log: () => undefined };
  const stages = (overrides: Partial<ReplayStages> = {}): ReplayStages => ({
    extract: async () => ({ discovered: 2, processed: 2, errors: 0 }),
    embed: async () => ({ succeeded: 5, failed: 0 }),
    match: async () => ({ matchedJobs: 2, skippedJobs: 0, errors: 0 }),
    decide: async () => ({ errors: 0 }),
    ...overrides,
  });

  it("a transient error once re-runs the chunk and the totals are not doubled", async () => {
    let extractCalls = 0;
    const result = await runReplayChunk(
      stages({
        extract: async () => {
          extractCalls += 1;
          if (extractCalls === 1) throw new Error("Connection terminated unexpectedly");
          return { discovered: 2, processed: 2, errors: 0 };
        },
      }),
      chunk,
      options,
    );
    expect(result.retries).toBe(1);
    expect(result.totals).toMatchObject({ extracted: 2, embeddingsOk: 5, matched: 2 });
    expect(result.extractionDiscovered).toBe(2);
  });

  it("a failure after earlier stages succeeded still counts each stage once", async () => {
    let decideCalls = 0;
    const result = await runReplayChunk(
      stages({ decide: async () => { decideCalls += 1; if (decideCalls === 1) throw new Error("Connection terminated unexpectedly"); return { errors: 0 }; } }),
      chunk,
      options,
    );
    expect(result.retries).toBe(1);
    expect(result.totals).toMatchObject({ extracted: 2, embeddingsOk: 5, matched: 2 });
  });

  it("rethrows when the retry cap is hit", async () => {
    let calls = 0;
    await expect(
      runReplayChunk(stages({ match: async () => { calls += 1; throw new Error("Connection terminated unexpectedly"); } }), chunk, options),
    ).rejects.toThrow(/Connection terminated/);
    expect(calls).toBe(3);
  });

  it("rethrows a non-transient error without retrying", async () => {
    let calls = 0;
    await expect(
      runReplayChunk(stages({ extract: async () => { calls += 1; throw new Error("null value in column x"); } }), chunk, options),
    ).rejects.toThrow("null value");
    expect(calls).toBe(1);
  });

  it("skips extraction and embedding for rematch-only, and extraction for fully resumed chunks", async () => {
    const calls: string[] = [];
    const tracking = stages({
      extract: async () => { calls.push("extract"); return { discovered: 0, processed: 0, errors: 0 }; },
      embed: async () => { calls.push("embed"); return { succeeded: 0, failed: 0 }; },
    });
    await runReplayChunk(tracking, chunk, { ...options, rematchOnly: true });
    expect(calls).toEqual([]);
    await runReplayChunk(tracking, { ...chunk, extractJobVersionIds: [] }, options);
    expect(calls).toEqual(["embed"]);
  });

  it("routes only when a route stage is given and counts held-back matches", async () => {
    const routed = await runReplayChunk(
      stages({ route: async () => ({ routed: 2 }), match: async () => ({ matchedJobs: 1, skippedJobs: 1, errors: 0 }) }),
      chunk,
      options,
    );
    expect(routed.totals).toMatchObject({ routed: 2, matched: 1, matchHeldBack: 1 });
  });
});

describe("addChunkTotals and the first-chunk guard", () => {
  it("adds chunk totals but leaves the resume and retry counters to the caller", () => {
    const run = { ...emptyReplayTotals(), resumedSkipped: 7, chunksRetried: 1 };
    addChunkTotals(run, { ...emptyReplayTotals(), matched: 3, resumedSkipped: 99, chunksRetried: 99 });
    expect(run).toMatchObject({ matched: 3, resumedSkipped: 7, chunksRetried: 1 });
  });

  it("stops when the first chunk matched nothing and held nothing back", () => {
    expect(() => assertFirstChunkReachedMatcher(emptyReplayTotals(), true)).toThrow(/matched 0 jobs/);
    expect(() => assertFirstChunkReachedMatcher(emptyReplayTotals(), false)).not.toThrow();
    expect(() => assertFirstChunkReachedMatcher({ ...emptyReplayTotals(), matchHeldBack: 1 }, true)).not.toThrow();
  });
});

describe("countGatePassedLeftBeforeMatching", () => {
  it("returns the count the query reports and skips the query for an empty scope", async () => {
    const seen: unknown[][] = [];
    const client = { query: async (_text: string, values?: unknown[]) => { seen.push(values ?? []); return { rows: [{ n: 4 }] }; } };
    expect(await countGatePassedLeftBeforeMatching(client, "w", ["a", "b"])).toBe(4);
    expect(await countGatePassedLeftBeforeMatching(client, "w", [])).toBe(0);
    expect(seen).toHaveLength(1);
  });
});
