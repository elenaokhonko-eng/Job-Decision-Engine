/**
 * One-command local workspace: the managed API plus Streamlit, started and stopped together.
 *
 *   npm run workspace
 *
 * 1. Uses JDEC_API_TOKEN from the environment or .env.local; without one it generates an
 *    ephemeral token for this session. The token is passed to both child processes through their
 *    environment and is never printed.
 * 2. Starts the API (scripts/start_api_v2.ts) bound to 127.0.0.1 and waits for its authenticated
 *    /api/v2/health to answer.
 * 3. Starts Streamlit (python -m streamlit run streamlit_app.py) with JDEC_API_BASE_URL and
 *    JDEC_API_TOKEN set, so "Add to tracker", "Prepare application documents" and the
 *    technical-error actions work.
 * 4. When either process exits, or on Ctrl+C, stops the other and exits non-zero unless the user
 *    asked to stop.
 *
 * Options (environment): JDEC_WORKSPACE_API_PORT (default 3000), JDEC_WORKSPACE_STREAMLIT_PORT
 * (default 8501), JDEC_PYTHON (default "python" on Windows, else "python3").
 */
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export const API_HOST = "127.0.0.1";
export const DEFAULT_API_PORT = 3000;
export const DEFAULT_STREAMLIT_PORT = 8501;
export const HEALTH_TIMEOUT_MS = 90_000;

export type TokenSource = "ENVIRONMENT" | "ENV_FILE" | "EPHEMERAL";

export interface WorkspaceLaunchPlan {
  readonly apiPort: number;
  readonly streamlitPort: number;
  readonly apiBaseUrl: string;
  readonly tokenSource: TokenSource;
  readonly apiEnv: NodeJS.ProcessEnv;
  readonly streamlitEnv: NodeJS.ProcessEnv;
  readonly pythonCommand: string;
  readonly streamlitArgs: readonly string[];
}

function parsePort(raw: string | undefined, fallback: number, name: string): number {
  const value = String(raw ?? "").trim();
  if (!value) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a port number.`);
  const port = Number.parseInt(value, 10);
  if (port < 1 || port > 65535) throw new Error(`${name} must be between 1 and 65535.`);
  return port;
}

/**
 * Builds the launch plan without side effects. The token comes from the process environment, then
 * .env.local, then `generateToken`; it is placed only in the child environments.
 */
export function buildWorkspaceLaunchPlan(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly envFile: Readonly<Record<string, string>>;
  readonly platform: NodeJS.Platform;
  readonly generateToken?: () => string;
}): WorkspaceLaunchPlan {
  const { env, envFile } = input;
  const apiPort = parsePort(env.JDEC_WORKSPACE_API_PORT, DEFAULT_API_PORT, "JDEC_WORKSPACE_API_PORT");
  const streamlitPort = parsePort(env.JDEC_WORKSPACE_STREAMLIT_PORT, DEFAULT_STREAMLIT_PORT, "JDEC_WORKSPACE_STREAMLIT_PORT");
  if (apiPort === streamlitPort) throw new Error("The API and Streamlit need different ports.");

  const environmentToken = String(env.JDEC_API_TOKEN ?? "").trim();
  const fileToken = String(envFile.JDEC_API_TOKEN ?? "").trim();
  let token: string;
  let tokenSource: TokenSource;
  if (environmentToken) {
    token = environmentToken;
    tokenSource = "ENVIRONMENT";
  } else if (fileToken) {
    token = fileToken;
    tokenSource = "ENV_FILE";
  } else {
    token = (input.generateToken ?? (() => crypto.randomBytes(32).toString("hex")))();
    tokenSource = "EPHEMERAL";
  }
  if (!token) throw new Error("Could not determine an API token for the local workspace.");

  const apiBaseUrl = `http://${API_HOST}:${apiPort}`;
  const shared: NodeJS.ProcessEnv = {
    ...env,
    JDEC_API_TOKEN: token,
    // The API's legacy alias must not hold a different token than the one Streamlit sends.
    API_TOKEN: token,
  };
  const apiEnv: NodeJS.ProcessEnv = {
    ...shared,
    API_HOST,
    PORT: String(apiPort),
    // The API binds to loopback only; NODE_ENV=production would default to 0.0.0.0.
    NODE_ENV: env.NODE_ENV === "production" ? "development" : env.NODE_ENV,
  };
  const streamlitEnv: NodeJS.ProcessEnv = {
    ...shared,
    JDEC_API_BASE_URL: apiBaseUrl,
    API_BASE_URL: apiBaseUrl,
    JDEC_RUNTIME_MODE: "local",
  };
  const pythonCommand = String(env.JDEC_PYTHON ?? "").trim() || (input.platform === "win32" ? "python" : "python3");
  const streamlitArgs = [
    "-m", "streamlit", "run", "streamlit_app.py",
    "--server.address", API_HOST,
    "--server.port", String(streamlitPort),
  ];
  return { apiPort, streamlitPort, apiBaseUrl, tokenSource, apiEnv, streamlitEnv, pythonCommand, streamlitArgs };
}

export function describeLaunchPlan(plan: WorkspaceLaunchPlan): string[] {
  const tokenNote = {
    ENVIRONMENT: "API token: from the environment (not shown)",
    ENV_FILE: "API token: from .env.local (not shown)",
    EPHEMERAL: "API token: generated for this session only (not shown)",
  }[plan.tokenSource];
  return [
    `API:       ${plan.apiBaseUrl}`,
    `Streamlit: http://${API_HOST}:${plan.streamlitPort}`,
    tokenNote,
  ];
}

export type FetchLike = (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Polls the authenticated API health route until it answers { ok: true } or the deadline passes.
 * A 401 means a different process owns the port with another token: that fails at once.
 */
export async function waitForApiHealth(options: {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetchImpl: FetchLike;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly isAlive?: () => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? HEALTH_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? 500;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  let lastProblem = "no response yet";
  while (now() < deadline) {
    if (options.isAlive && !options.isAlive()) {
      throw new Error("The API process exited before it became healthy. See its output above.");
    }
    try {
      const response = await options.fetchImpl(`${options.baseUrl}/api/v2/health`, {
        headers: { Authorization: `Bearer ${options.token}`, Accept: "application/json" },
      });
      if (response.status === 401) {
        throw new Error(`Another server on ${options.baseUrl} rejected this session's API token. Stop it or set JDEC_WORKSPACE_API_PORT.`);
      }
      if (response.ok) {
        const body = await response.json() as { ok?: unknown } | null;
        if (body && body.ok === true) return;
        lastProblem = "health response was not ok";
      } else {
        const body = await response.json().catch(() => null) as { message?: unknown; error?: unknown } | null;
        lastProblem = `HTTP ${response.status}${body?.message ? `: ${String(body.message)}` : body?.error ? `: ${String(body.error)}` : ""}`;
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Another server")) throw error;
      lastProblem = error instanceof Error ? error.message : String(error);
    }
    await sleep(intervalMs);
  }
  throw new Error(`The API did not become healthy within ${Math.round(timeoutMs / 1000)}s (${lastProblem}).`);
}

function readEnvFile(repoRoot: string): Record<string, string> {
  const file = path.join(repoRoot, ".env.local");
  if (!fs.existsSync(file)) return {};
  return dotenv.parse(fs.readFileSync(file));
}

function stopChild(child: ChildProcess | null): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    // Streamlit and tsx start their own children; end the whole tree on Windows.
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  child.kill("SIGTERM");
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const plan = buildWorkspaceLaunchPlan({
    env: process.env,
    envFile: readEnvFile(repoRoot),
    platform: process.platform,
  });
  for (const line of describeLaunchPlan(plan)) console.log(line);

  const require = createRequire(import.meta.url);
  const tsxCli = require.resolve("tsx/cli");
  let stopping = false;
  let streamlit: ChildProcess | null = null;
  const api = spawn(process.execPath, [tsxCli, "scripts/start_api_v2.ts"], {
    cwd: repoRoot,
    env: plan.apiEnv,
    stdio: "inherit",
  });

  const finish = (code: number) => {
    stopping = true;
    stopChild(streamlit);
    stopChild(api);
    process.exitCode = code;
  };
  process.on("SIGINT", () => finish(0));
  process.on("SIGTERM", () => finish(0));
  api.on("exit", (code) => {
    if (!stopping) {
      console.error(`The API stopped (exit code ${code ?? "unknown"}); stopping Streamlit.`);
      finish(code && code !== 0 ? code : 1);
    }
  });

  try {
    await waitForApiHealth({
      baseUrl: plan.apiBaseUrl,
      token: String(plan.apiEnv.JDEC_API_TOKEN),
      fetchImpl: (url, init) => fetch(url, init),
      isAlive: () => api.exitCode === null && api.signalCode === null,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    finish(1);
    return;
  }
  if (stopping) return;
  console.log("API is healthy; starting Streamlit.");

  streamlit = spawn(plan.pythonCommand, [...plan.streamlitArgs], {
    cwd: repoRoot,
    env: plan.streamlitEnv,
    stdio: "inherit",
  });
  streamlit.on("error", (error) => {
    console.error(`Could not start Streamlit with "${plan.pythonCommand}": ${error.message}. Set JDEC_PYTHON to your Python executable.`);
    finish(1);
  });
  streamlit.on("exit", (code) => {
    if (!stopping) {
      console.log(`Streamlit stopped (exit code ${code ?? "unknown"}); stopping the API.`);
      finish(code ?? 1);
    }
  });
}

if (process.argv[1]?.includes("start_local_workspace")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
