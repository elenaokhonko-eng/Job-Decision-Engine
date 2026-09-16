import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWorkerSupervisor,
  resolveWorkerCommand,
  type DesktopWorkerKind,
  type WorkerCommand,
  type WorkerProcess,
} from "../../desktop/workerSupervisor.js";

class FakeWorkerProcess implements WorkerProcess {
  readonly pid: number;
  readonly killSignals: Array<NodeJS.Signals | undefined> = [];
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>();

  constructor(pid: number) {
    this.pid = pid;
  }

  on(event: string, listener: (...args: any[]) => void): this {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
    return this;
  }

  once(event: string, listener: (...args: any[]) => void): this {
    const wrapped = (...args: any[]) => {
      this.removeListener(event, wrapped);
      listener(...args);
    };
    return this.on(event, wrapped);
  }

  removeListener(event: string, listener: (...args: any[]) => void): this {
    const existing = this.listeners.get(event) ?? [];
    this.listeners.set(event, existing.filter((candidate) => candidate !== listener));
    return this;
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killSignals.push(signal);
    this.emit("exit", null, signal ?? "SIGTERM");
    return true;
  }

  emit(event: string, ...args: any[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }
}

function commandFor(kind: DesktopWorkerKind): WorkerCommand {
  return {
    executable: process.execPath,
    args: [`${kind}.cjs`],
    cwd: process.cwd(),
    source: "bundled",
    entrypoint: `${kind}.cjs`,
  };
}

describe("desktop worker command resolution", () => {
  it("prefers an absolute bundled entrypoint for packaged Electron", () => {
    const bundleDir = path.resolve("/installed", "resources", "app.asar", "desktop", "electron", "dist-backend");
    const result = resolveWorkerCommand("pipeline", {
      isPackaged: true,
      bundledDir: bundleDir,
      fileExists: (filePath) => filePath.endsWith("process_pipeline_tasks.cjs"),
    });

    expect(result).toMatchObject({
      source: "bundled",
      executable: process.execPath,
      cwd: bundleDir,
    });
    expect(result?.entrypoint).toContain("process_pipeline_tasks.cjs");
    expect(result?.args).toContain(result?.entrypoint);
  });

  it("uses the repository tsx entrypoint only in development when bundled output is absent", () => {
    const projectRoot = path.resolve("/repo");
    const result = resolveWorkerCommand("evaluation", {
      isPackaged: false,
      bundledDir: path.join(projectRoot, "desktop", "electron", "dist-backend"),
      projectRoot,
      fileExists: (filePath) => filePath.endsWith("evaluate_queue.ts") || filePath.includes("cli.mjs"),
    });

    expect(result).toMatchObject({ source: "development-ts", cwd: projectRoot });
    expect(result?.args[0]).toContain("cli.mjs");
    expect(result?.args).toContain(path.join(projectRoot, "scripts", "evaluate_queue.ts"));
  });
});

describe("desktop worker supervisor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T00:00:00.000Z"));
  });

  it("reports an explicit opt-out without spawning workers", async () => {
    const spawn = vi.fn(() => new FakeWorkerProcess(100));
    const supervisor = createWorkerSupervisor({
      env: { DATABASE_URL: "postgres://db", JDEC_DESKTOP_ENABLE_WORKERS: "false" },
      resolveCommand: commandFor,
      spawn,
    });

    await supervisor.start();

    expect(spawn).not.toHaveBeenCalled();
    expect(supervisor.getStatus()).toMatchObject({ state: "disabled", enabled: false });
    expect(Object.values(supervisor.getStatus().workers).every((worker) => worker.state === "disabled")).toBe(true);
  });

  it("reports missing DATABASE_URL as misconfigured without fabricating work", async () => {
    const spawn = vi.fn(() => new FakeWorkerProcess(100));
    const supervisor = createWorkerSupervisor({
      env: { JDEC_DESKTOP_ENABLE_WORKERS: "true" },
      resolveCommand: commandFor,
      spawn,
    });

    await supervisor.start();

    expect(spawn).not.toHaveBeenCalled();
    expect(supervisor.getStatus()).toMatchObject({ state: "misconfigured", enabled: true });
    expect(supervisor.getStatus().reason).toContain("DATABASE_URL");
  });

  it("restarts a crashed worker with bounded exponential backoff and visible reason", async () => {
    const processes: FakeWorkerProcess[] = [];
    const spawn = vi.fn(() => {
      const child = new FakeWorkerProcess(100 + processes.length);
      processes.push(child);
      return child;
    });
    const supervisor = createWorkerSupervisor({
      env: { DATABASE_URL: "postgres://db" },
      resolveCommand: commandFor,
      spawn,
      restartBaseMs: 1000,
      restartMaxMs: 2500,
    });

    await supervisor.start();
    const initialCount = spawn.mock.calls.length;
    processes[0].emit("exit", 1, null);

    expect(supervisor.getStatus().workers.pipeline).toMatchObject({
      state: "backoff",
      pid: null,
      restartCount: 1,
    });
    expect(supervisor.getStatus().workers.pipeline.reason).toContain("exit_code=1");

    await vi.advanceTimersByTimeAsync(999);
    expect(spawn).toHaveBeenCalledTimes(initialCount);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawn).toHaveBeenCalledTimes(initialCount + 1);

    processes[3].emit("exit", 1, null);
    expect(supervisor.getStatus().workers.pipeline.restartCount).toBe(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(spawn).toHaveBeenCalledTimes(initialCount + 1);
    await vi.advanceTimersByTimeAsync(501);
    expect(spawn).toHaveBeenCalledTimes(initialCount + 2);
  });

  it("stops cleanly and does not restart after app quit", async () => {
    const processes: FakeWorkerProcess[] = [];
    const spawn = vi.fn(() => {
      const child = new FakeWorkerProcess(200 + processes.length);
      processes.push(child);
      return child;
    });
    const supervisor = createWorkerSupervisor({
      env: { DATABASE_URL: "postgres://db" },
      resolveCommand: commandFor,
      spawn,
      restartBaseMs: 1000,
    });

    await supervisor.start();
    processes[1].emit("exit", 2, null);
    const countBeforeStop = spawn.mock.calls.length;

    await supervisor.stop();
    await vi.advanceTimersByTimeAsync(5000);

    const stoppedChildren = processes.filter((child) => child.killSignals.length > 0);
    expect(stoppedChildren).toHaveLength(2);
    expect(stoppedChildren.every((child) => child.killSignals.includes("SIGTERM"))).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(countBeforeStop);
    expect(supervisor.getStatus().state).toBe("stopped");
    expect(Object.values(supervisor.getStatus().workers).every((worker) => worker.state === "stopped")).toBe(true);
  });
});
