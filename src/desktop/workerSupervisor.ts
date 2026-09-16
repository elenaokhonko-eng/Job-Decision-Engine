import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const DESKTOP_WORKER_KINDS = ["pipeline", "evaluation", "recovery"] as const;
export type DesktopWorkerKind = (typeof DESKTOP_WORKER_KINDS)[number];

export type DesktopWorkerState =
  | "not_started"
  | "starting"
  | "running"
  | "backoff"
  | "disabled"
  | "misconfigured"
  | "stopped";

export type DesktopWorkerSupervisorState =
  | "not_started"
  | "starting"
  | "running"
  | "misconfigured"
  | "disabled"
  | "stopping"
  | "stopped";

export interface WorkerStatus {
  kind: DesktopWorkerKind;
  state: DesktopWorkerState;
  pid: number | null;
  lastStartAt: string | null;
  lastExitAt: string | null;
  restartCount: number;
  reason: string | null;
}

export interface WorkerSupervisorStatus {
  enabled: boolean;
  state: DesktopWorkerSupervisorState;
  reason: string | null;
  workers: Record<DesktopWorkerKind, WorkerStatus>;
}

export interface WorkerCommand {
  executable: string;
  args: string[];
  cwd: string;
  source: "bundled" | "development-ts";
  entrypoint: string;
}

export interface WorkerProcess {
  readonly pid?: number;
  on(event: string, listener: (...args: any[]) => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface WorkerCommandResolutionOptions {
  isPackaged: boolean;
  bundledDir?: string;
  projectRoot?: string;
  fileExists?: (filePath: string) => boolean;
  nodeExecutable?: string;
  tsxCliPath?: string;
}

export type WorkerCommandResolver = (
  kind: DesktopWorkerKind,
  options: WorkerCommandResolutionOptions
) => WorkerCommand | null;

export type WorkerSpawner = (command: WorkerCommand, env: NodeJS.ProcessEnv) => WorkerProcess;

export interface WorkerSupervisorOptions {
  env?: NodeJS.ProcessEnv;
  isPackaged?: boolean;
  bundledDir?: string;
  projectRoot?: string;
  resolveCommand?: WorkerCommandResolver;
  spawn?: WorkerSpawner;
  now?: () => Date;
  restartBaseMs?: number;
  restartMaxMs?: number;
  stableRunMs?: number;
  shutdownGraceMs?: number;
  logger?: (message: string) => void;
}

interface WorkerDefinition {
  kind: DesktopWorkerKind;
  bundledFile: string;
  developmentScript: string;
  args: string[];
}

const WORKER_DEFINITIONS: readonly WorkerDefinition[] = [
  {
    kind: "pipeline",
    bundledFile: "process_pipeline_tasks.cjs",
    developmentScript: "process_pipeline_tasks.ts",
    args: [],
  },
  {
    kind: "evaluation",
    bundledFile: "evaluate_queue.cjs",
    developmentScript: "evaluate_queue.ts",
    args: [],
  },
  {
    kind: "recovery",
    bundledFile: "reconcile_pipeline.cjs",
    developmentScript: "reconcile_pipeline.ts",
    args: ["--json"],
  },
];

const DEFAULT_RESTART_BASE_MS = 1000;
const DEFAULT_RESTART_MAX_MS = 60_000;
const DEFAULT_STABLE_RUN_MS = 60_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 5000;

function definitionFor(kind: DesktopWorkerKind): WorkerDefinition {
  const definition = WORKER_DEFINITIONS.find((candidate) => candidate.kind === kind);
  if (!definition) throw new Error(`Unsupported desktop worker kind: ${kind}`);
  return definition;
}

function defaultFileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

function isElectronRuntime(): boolean {
  return Boolean(process.versions.electron);
}

export function desktopWorkersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.JDEC_DESKTOP_ENABLE_WORKERS || "").trim().toLowerCase() !== "false";
}

export function resolveWorkerCommand(
  kind: DesktopWorkerKind,
  options: WorkerCommandResolutionOptions
): WorkerCommand | null {
  const definition = definitionFor(kind);
  const fileExists = options.fileExists ?? defaultFileExists;
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const bundledDir = options.bundledDir;
  const bundledEntrypoint = bundledDir ? path.join(bundledDir, definition.bundledFile) : null;
  const projectRoot = options.projectRoot ?? (options.isPackaged ? null : process.cwd());
  const developmentEntrypoint = projectRoot
    ? path.join(projectRoot, "scripts", definition.developmentScript)
    : null;
  const tsxCliPath = options.tsxCliPath ?? (projectRoot
    ? path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs")
    : null);
  const developmentAvailable = !options.isPackaged &&
    Boolean(projectRoot && developmentEntrypoint && tsxCliPath) &&
    fileExists(developmentEntrypoint as string) &&
    fileExists(tsxCliPath as string);

  // Development keeps the existing script entrypoints and local tsx runtime so
  // source changes are immediately reflected. Packaged mode never falls back
  // to a shell, global tsx, or the current working directory.
  if (developmentAvailable && projectRoot && developmentEntrypoint && tsxCliPath) {
    return {
      executable: nodeExecutable,
      args: [tsxCliPath, developmentEntrypoint, ...definition.args],
      cwd: projectRoot,
      source: "development-ts",
      entrypoint: developmentEntrypoint,
    };
  }

  if (bundledEntrypoint && fileExists(bundledEntrypoint)) {
    return {
      executable: nodeExecutable,
      args: [bundledEntrypoint],
      cwd: bundledDir as string,
      source: "bundled",
      entrypoint: bundledEntrypoint,
    };
  }

  return null;
}

function emptyWorkerStatus(kind: DesktopWorkerKind): WorkerStatus {
  return {
    kind,
    state: "not_started",
    pid: null,
    lastStartAt: null,
    lastExitAt: null,
    restartCount: 0,
    reason: null,
  };
}

function parsePositiveNumber(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.floor(value as number) : fallback;
}

function isActiveState(state: DesktopWorkerState): boolean {
  return state === "starting" || state === "running" || state === "backoff";
}

function exitReason(code: number | null | undefined, signal: NodeJS.Signals | null | undefined): string {
  return `worker_exit: exit_code=${code ?? "null"} signal=${signal ?? "null"}`;
}

interface WorkerRuntime {
  status: WorkerStatus;
  process: WorkerProcess | null;
  restartTimer: NodeJS.Timeout | null;
  startedAtMs: number | null;
  consecutiveRestarts: number;
  stopResolve: (() => void) | null;
}

export interface WorkerSupervisor {
  start(): Promise<void>;
  refresh(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): WorkerSupervisorStatus;
}

export class DesktopWorkerSupervisor implements WorkerSupervisor {
  private readonly env: NodeJS.ProcessEnv;
  private readonly isPackaged: boolean;
  private readonly bundledDir?: string;
  private readonly projectRoot?: string;
  private readonly resolveCommand: WorkerCommandResolver;
  private readonly spawn: WorkerSpawner;
  private readonly now: () => Date;
  private readonly restartBaseMs: number;
  private readonly restartMaxMs: number;
  private readonly stableRunMs: number;
  private readonly shutdownGraceMs: number;
  private readonly logger: (message: string) => void;
  private desiredRunning = false;
  private lifecycleState: DesktopWorkerSupervisorState = "not_started";
  private globalReason: string | null = null;
  private readonly runtimes: Record<DesktopWorkerKind, WorkerRuntime>;

  constructor(options: WorkerSupervisorOptions = {}) {
    this.env = options.env ?? process.env;
    this.isPackaged = options.isPackaged ?? Boolean(process.versions.electron && process.defaultApp === false);
    this.bundledDir = options.bundledDir;
    this.projectRoot = options.projectRoot;
    this.resolveCommand = options.resolveCommand ?? ((kind, resolutionOptions) =>
      resolveWorkerCommand(kind, resolutionOptions));
    this.spawn = options.spawn ?? ((command, env) => this.spawnChild(command, env));
    this.now = options.now ?? (() => new Date());
    this.restartBaseMs = parsePositiveNumber(options.restartBaseMs, DEFAULT_RESTART_BASE_MS);
    this.restartMaxMs = Math.max(
      this.restartBaseMs,
      parsePositiveNumber(options.restartMaxMs, DEFAULT_RESTART_MAX_MS)
    );
    this.stableRunMs = parsePositiveNumber(options.stableRunMs, DEFAULT_STABLE_RUN_MS);
    this.shutdownGraceMs = parsePositiveNumber(options.shutdownGraceMs, DEFAULT_SHUTDOWN_GRACE_MS);
    this.logger = options.logger ?? ((message) => console.warn(message));
    this.runtimes = Object.fromEntries(
      DESKTOP_WORKER_KINDS.map((kind) => [
        kind,
        {
          status: emptyWorkerStatus(kind),
          process: null,
          restartTimer: null,
          startedAtMs: null,
          consecutiveRestarts: 0,
          stopResolve: null,
        },
      ])
    ) as Record<DesktopWorkerKind, WorkerRuntime>;
  }

  async start(): Promise<void> {
    if (this.desiredRunning && this.lifecycleState !== "stopped") return;
    this.desiredRunning = true;
    this.lifecycleState = "starting";
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.desiredRunning) return;

    if (!desktopWorkersEnabled(this.env)) {
      this.globalReason = "disabled_by_env";
      this.lifecycleState = "disabled";
      this.stopWorkersForConfiguration("disabled", this.globalReason);
      return;
    }

    if (!String(this.env.DATABASE_URL || "").trim()) {
      this.globalReason = "DATABASE_URL is required for desktop workers.";
      this.lifecycleState = "misconfigured";
      this.stopWorkersForConfiguration("misconfigured", this.globalReason);
      return;
    }

    this.globalReason = null;
    for (const kind of DESKTOP_WORKER_KINDS) {
      const runtime = this.runtimes[kind];
      if (runtime.process || runtime.restartTimer || isActiveState(runtime.status.state)) continue;
      this.launch(kind);
    }
    this.recomputeLifecycleState();
  }

  async stop(): Promise<void> {
    if (!this.desiredRunning && this.lifecycleState === "stopped") return;
    this.desiredRunning = false;
    this.lifecycleState = "stopping";
    this.globalReason = "shutdown";

    const waits: Promise<void>[] = [];
    for (const runtime of Object.values(this.runtimes)) {
      if (runtime.restartTimer) {
        clearTimeout(runtime.restartTimer);
        runtime.restartTimer = null;
      }
      if (!runtime.process) {
        runtime.status = {
          ...runtime.status,
          state: "stopped",
          pid: null,
          reason: "shutdown",
        };
        continue;
      }

      const child = runtime.process;
      waits.push(new Promise<void>((resolve) => {
        let forceTimer: NodeJS.Timeout | null = null;
        const finishStop = () => {
          if (forceTimer) clearTimeout(forceTimer);
          forceTimer = null;
          runtime.stopResolve = null;
          resolve();
        };
        runtime.stopResolve = finishStop;
        forceTimer = setTimeout(() => {
          if (runtime.process) {
            try {
              runtime.process.kill("SIGKILL");
            } catch {
              // The child may have exited between the graceful and forced stop.
            }
          }
          finishStop();
        }, this.shutdownGraceMs);
        forceTimer?.unref?.();
        try {
          child.kill("SIGTERM");
        } catch {
          finishStop();
        }
      }));
    }

    await Promise.all(waits);
    for (const runtime of Object.values(this.runtimes)) {
      runtime.process = null;
      runtime.status = {
        ...runtime.status,
        state: "stopped",
        pid: null,
        reason: "shutdown",
      };
    }
    this.lifecycleState = "stopped";
  }

  getStatus(): WorkerSupervisorStatus {
    const workers = Object.fromEntries(
      DESKTOP_WORKER_KINDS.map((kind) => {
        const status = this.runtimes[kind].status;
        return [kind, { ...status }];
      })
    ) as Record<DesktopWorkerKind, WorkerStatus>;
    return {
      enabled: desktopWorkersEnabled(this.env),
      state: this.lifecycleState,
      reason: this.globalReason,
      workers,
    };
  }

  private spawnChild(command: WorkerCommand, env: NodeJS.ProcessEnv): WorkerProcess {
    const childEnv: NodeJS.ProcessEnv = { ...env };
    if (isElectronRuntime()) childEnv.ELECTRON_RUN_AS_NODE = "1";
    const child = nodeSpawn(command.executable, command.args, {
      cwd: command.cwd,
      env: childEnv,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.resume();
    child.stderr?.resume();
    return child;
  }

  private launch(kind: DesktopWorkerKind): void {
    if (!this.desiredRunning || !desktopWorkersEnabled(this.env) || !String(this.env.DATABASE_URL || "").trim()) {
      return;
    }

    const runtime = this.runtimes[kind];
    const command = this.resolveCommand(kind, {
      isPackaged: this.isPackaged,
      bundledDir: this.bundledDir,
      projectRoot: this.projectRoot,
    });
    if (!command) {
      runtime.status = {
        ...runtime.status,
        state: "misconfigured",
        pid: null,
        reason: this.isPackaged
          ? "bundled_worker_entrypoint_missing"
          : "development_worker_entrypoint_unavailable",
      };
      this.globalReason = runtime.status.reason;
      this.recomputeLifecycleState();
      return;
    }

    const startedAt = this.now();
    runtime.startedAtMs = startedAt.getTime();
    runtime.status = {
      ...runtime.status,
      state: "starting",
      pid: null,
      lastStartAt: startedAt.toISOString(),
      reason: `starting:${command.source}`,
    };
    this.recomputeLifecycleState();

    let child: WorkerProcess;
    try {
      child = this.spawn(command, {
        ...this.env,
        JDEC_DESKTOP_WORKER_KIND: kind,
      });
    } catch (error) {
      this.handleFailure(kind, error instanceof Error ? error.message : String(error));
      return;
    }

    runtime.process = child;
    runtime.status = {
      ...runtime.status,
      state: "running",
      pid: child.pid ?? null,
      reason: `running:${command.source}`,
    };
    this.recomputeLifecycleState();

    let handled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null, reason?: string) => {
      if (handled) return;
      handled = true;
      this.handleExit(kind, child, code, signal, reason);
    };
    child.once("error", (error: Error) => finish(null, null, `worker_error: ${error.message}`));
    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => finish(code, signal));
  }

  private handleFailure(kind: DesktopWorkerKind, reason: string): void {
    const runtime = this.runtimes[kind];
    runtime.consecutiveRestarts += 1;
    runtime.status = {
      ...runtime.status,
      state: "backoff",
      pid: null,
      lastExitAt: this.now().toISOString(),
      restartCount: runtime.status.restartCount + 1,
      reason,
    };
    this.scheduleRestart(kind);
  }

  private handleExit(
    kind: DesktopWorkerKind,
    child: WorkerProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
    explicitReason?: string
  ): void {
    const runtime = this.runtimes[kind];
    if (runtime.process !== child) return;
    runtime.process = null;
    runtime.stopResolve?.();
    runtime.stopResolve = null;

    const endedAt = this.now();
    const duration = runtime.startedAtMs === null ? 0 : endedAt.getTime() - runtime.startedAtMs;
    if (duration >= this.stableRunMs) runtime.consecutiveRestarts = 0;
    runtime.consecutiveRestarts += 1;
    runtime.status = {
      ...runtime.status,
      state: this.desiredRunning && desktopWorkersEnabled(this.env) && String(this.env.DATABASE_URL || "").trim()
        ? "backoff"
        : !this.desiredRunning
          ? "stopped"
          : !desktopWorkersEnabled(this.env)
            ? "disabled"
            : "misconfigured",
      pid: null,
      lastExitAt: endedAt.toISOString(),
      restartCount: runtime.status.restartCount + 1,
      reason: explicitReason ?? exitReason(code, signal),
    };

    if (runtime.status.state === "backoff") {
      this.scheduleRestart(kind);
    } else {
      this.recomputeLifecycleState();
    }
  }

  private scheduleRestart(kind: DesktopWorkerKind): void {
    const runtime = this.runtimes[kind];
    if (!this.desiredRunning || !desktopWorkersEnabled(this.env) || !String(this.env.DATABASE_URL || "").trim()) {
      this.recomputeLifecycleState();
      return;
    }
    if (runtime.restartTimer) clearTimeout(runtime.restartTimer);
    const exponent = Math.max(0, runtime.consecutiveRestarts - 1);
    const delay = Math.min(this.restartMaxMs, this.restartBaseMs * Math.pow(2, exponent));
    runtime.status = { ...runtime.status, state: "backoff" };
    this.logger(`Desktop ${kind} worker exited; restarting in ${delay}ms.`);
    runtime.restartTimer = setTimeout(() => {
      runtime.restartTimer = null;
      this.launch(kind);
    }, delay);
    runtime.restartTimer.unref?.();
    this.recomputeLifecycleState();
  }

  private stopWorkersForConfiguration(state: "disabled" | "misconfigured", reason: string): void {
    for (const runtime of Object.values(this.runtimes)) {
      if (runtime.restartTimer) {
        clearTimeout(runtime.restartTimer);
        runtime.restartTimer = null;
      }
      if (runtime.process) {
        try {
          runtime.process.kill("SIGTERM");
        } catch {
          // Configuration status must remain observable even if a child already exited.
        }
        runtime.process = null;
      }
      runtime.status = {
        ...runtime.status,
        state,
        pid: null,
        reason,
      };
    }
  }

  private recomputeLifecycleState(): void {
    if (!this.desiredRunning) return;
    if (!desktopWorkersEnabled(this.env)) {
      this.lifecycleState = "disabled";
      return;
    }
    if (!String(this.env.DATABASE_URL || "").trim()) {
      this.lifecycleState = "misconfigured";
      return;
    }
    const statuses = Object.values(this.runtimes).map((runtime) => runtime.status);
    if (statuses.some((status) => isActiveState(status.state))) {
      this.lifecycleState = "running";
      return;
    }
    if (statuses.some((status) => status.state === "misconfigured")) {
      this.lifecycleState = "misconfigured";
      return;
    }
    this.lifecycleState = "starting";
  }
}

export function createWorkerSupervisor(options: WorkerSupervisorOptions = {}): WorkerSupervisor {
  return new DesktopWorkerSupervisor(options);
}
