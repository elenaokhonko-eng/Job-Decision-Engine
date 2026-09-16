import crypto from "crypto";
import express from "express";
import http from "http";
import net from "net";
import { createApiV2Router } from "../api/v2/router.js";
import {
  createWorkerSupervisor,
  type WorkerSupervisor,
  type WorkerSupervisorOptions,
  type WorkerSupervisorStatus,
} from "./workerSupervisor.js";

export interface LocalServerOptions {
  port?: number;
  host?: string;
  token?: string;
  databaseUrl?: string;
  databaseUrlDirect?: string;
  geminiApiKey?: string;
  openaiApiKey?: string;
  workerBundleDir?: string;
  workerProjectRoot?: string;
  workerPackaged?: boolean;
  workerSupervisor?: WorkerSupervisor;
}

export interface LocalServerStatus {
  ok: true;
  timestamp: string;
  api: {
    state: "running";
    host: string;
    port: number;
    apiBaseUrl: string;
  };
  workers: WorkerSupervisorStatus;
}

export interface LocalServerInstance {
  server: http.Server;
  port: number;
  host: string;
  token: string;
  apiBaseUrl: string;
  workerSupervisor: WorkerSupervisor;
  getStatus: () => LocalServerStatus;
  close: () => Promise<void>;
  updateConfig: (config: {
    databaseUrl?: string;
    databaseUrlDirect?: string;
    geminiApiKey?: string;
    openaiApiKey?: string;
  }) => void;
}

export async function findAvailablePort(preferredPort: number, host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const tester = net.createServer();
    tester.once("error", (err: any) => {
      if (err.code === "EADDRINUSE") {
        // Try next port
        resolve(findAvailablePort(preferredPort + 1, host));
      } else {
        reject(err);
      }
    });
    tester.once("listening", () => {
      tester.close(() => resolve(preferredPort));
    });
    tester.listen(preferredPort, host);
  });
}

export async function startLocalServer(options: LocalServerOptions = {}): Promise<LocalServerInstance> {
  const host = options.host || "127.0.0.1";
  const preferredPort = options.port || 3217;
  const actualPort = await findAvailablePort(preferredPort, host);

  // Auto-generate high-entropy internal loopback token if not supplied
  const token = options.token || process.env.JDEC_API_TOKEN || crypto.randomBytes(32).toString("hex");
  process.env.JDEC_API_TOKEN = token;

  if (options.databaseUrl) {
    process.env.DATABASE_URL = options.databaseUrl;
  }
  if (options.databaseUrlDirect) {
    process.env.DATABASE_URL_UNPOOLED = options.databaseUrlDirect;
  }
  if (options.geminiApiKey) {
    process.env.GEMINI_API_KEY = options.geminiApiKey;
  }
  if (options.openaiApiKey) {
    process.env.OPENAI_API_KEY = options.openaiApiKey;
  }

  const app = express();
  const workerSupervisor = options.workerSupervisor ?? createWorkerSupervisor({
    env: process.env,
    isPackaged: options.workerPackaged ?? false,
    bundledDir: options.workerBundleDir,
    projectRoot: options.workerProjectRoot,
  } satisfies WorkerSupervisorOptions);

  // Defense-in-depth: Reject non-loopback Host header
  app.use((req, res, next) => {
    const rawHost = String(req.headers.host || "").split(":")[0].toLowerCase();
    if (rawHost !== "127.0.0.1" && rawHost !== "localhost") {
      res.status(403).json({ ok: false, error: "Loopback access only" });
      return;
    }
    next();
  });

  const getStatus = (): LocalServerStatus => ({
    ok: true,
    timestamp: new Date().toISOString(),
    api: {
      state: "running",
      host,
      port: actualPort,
      apiBaseUrl: `http://${host}:${actualPort}/api/v2`,
    },
    workers: workerSupervisor.getStatus(),
  });

  // The native shell uses these loopback endpoints before workspace/database
  // setup is complete, so they intentionally do not depend on API v2 context.
  app.get(["/health", "/status", "/api/v2/status"], (_req, res) => {
    res.json(getStatus());
  });

  // Setup routes can establish DATABASE_URL during the first-run wizard. A
  // lightweight refresh lets workers begin without requiring an app restart.
  app.use((_req, _res, next) => {
    void workerSupervisor.refresh();
    next();
  });

  // Mount API v2
  app.use("/api/v2", createApiV2Router());

  const server = http.createServer(app);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(actualPort, host, () => {
      resolve();
    });
  });

  const apiBaseUrl = `http://${host}:${actualPort}/api/v2`;

  const instance: LocalServerInstance = {
    server,
    port: actualPort,
    host,
    token,
    apiBaseUrl,
    workerSupervisor,
    getStatus,
    close: async () => {
      await workerSupervisor.stop();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
    updateConfig: (config) => {
      if (config.databaseUrl !== undefined) {
        process.env.DATABASE_URL = config.databaseUrl;
      }
      if (config.databaseUrlDirect !== undefined) {
        process.env.DATABASE_URL_UNPOOLED = config.databaseUrlDirect;
      }
      if (config.geminiApiKey !== undefined) {
        process.env.GEMINI_API_KEY = config.geminiApiKey;
      }
      if (config.openaiApiKey !== undefined) {
        process.env.OPENAI_API_KEY = config.openaiApiKey;
      }
      void workerSupervisor.refresh();
    },
  };

  await workerSupervisor.start();
  return instance;
}

// Allow direct execution for CLI or background testing
if (process.argv[1]?.includes("localServer")) {
  startLocalServer()
    .then((inst) => {
      console.log(`Local Job Decision Engine server listening at ${inst.apiBaseUrl}`);
    })
    .catch((err) => {
      console.error("Failed to start local server:", err);
      process.exit(1);
    });
}

