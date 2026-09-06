import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

type Spawned = {
  name: string;
  proc: ChildProcess;
};

function commandForPlatform(cmd: string): string {
  if (process.platform === "win32") {
    if (cmd === "npx") return "npx.cmd";
    if (cmd === "npm") return "npm.cmd";
    if (cmd === "python") return "python.exe";
  }
  return cmd;
}

async function waitForHttpOk(url: string, timeoutMs = 60_000): Promise<void> {
  const started = Date.now();
  let lastError: unknown = null;

  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const message = (lastError as any)?.message ?? String(lastError);
  throw new Error(`Timed out waiting for ${url}. Last error: ${message}`);
}

function spawnProcess(name: string, cmd: string, args: string[], env: NodeJS.ProcessEnv): Spawned {
  const proc = spawn(cmd, args, {
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  return { name, proc };
}

function stopProcess(p: Spawned): void {
  if (!p.proc.pid) return;
  if (p.proc.killed) return;
  try {
    p.proc.kill("SIGTERM");
  } catch {
    // ignore
  }
}

async function main(): Promise<void> {
  const apiPort = Number.parseInt(String(process.env.JDEC_API_PORT || process.env.PORT || "3000"), 10);
  const streamlitPort = Number.parseInt(String(process.env.STREAMLIT_PORT || "8501"), 10);
  const apiToken = (process.env.JDEC_API_TOKEN || "local-e2e-token").trim();

  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Streamlit E2E.");
  }

  const exportDir = path.join(process.cwd(), "scripts", "exports");
  fs.mkdirSync(exportDir, { recursive: true });
  const reportPath = path.join(exportDir, "streamlit_accessibility_snapshot.json");

  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(apiPort),
    JDEC_API_TOKEN: apiToken,
    JDEC_API_BASE_URL: `http://127.0.0.1:${apiPort}`,
    WORKSPACE_KEY: process.env.WORKSPACE_KEY || "default",
    WORKSPACE_USER_KEY: process.env.WORKSPACE_USER_KEY || "local_user",
  };

  const spawned: Spawned[] = [];

  try {
    const api = spawnProcess(
      "api-v2",
      commandForPlatform("npx"),
      ["tsx", "scripts/start_api_v2.ts"],
      baseEnv
    );
    spawned.push(api);

    await waitForHttpOk(`http://127.0.0.1:${apiPort}/health`, 60_000);

    const pythonCmd = commandForPlatform(process.platform === "win32" ? "python" : "python3");
    const streamlit = spawnProcess(
      "streamlit",
      pythonCmd,
      [
        "-m",
        "streamlit",
        "run",
        "streamlit_app.py",
        "--server.headless=true",
        `--server.port=${streamlitPort}`,
        "--browser.gatherUsageStats=false",
      ],
      baseEnv
    );
    spawned.push(streamlit);

    await waitForHttpOk(`http://127.0.0.1:${streamlitPort}`, 120_000);

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message || String(err)));

    await page.goto(`http://127.0.0.1:${streamlitPort}`, {
      waitUntil: "domcontentloaded",
      timeout: 120_000,
    });
    await page.waitForSelector("text=Job Decision Engine", { timeout: 120_000 });

    const ariaSnapshot = await page.locator("body").ariaSnapshot({ mode: "default", depth: 8 });
    fs.writeFileSync(reportPath, ariaSnapshot);

    if (!ariaSnapshot.includes("Job Decision Engine")) {
      throw new Error("ARIA snapshot did not contain the expected Job Decision Engine heading.");
    }

    if (pageErrors.length) {
      throw new Error(`Streamlit page errors: ${pageErrors.join(" | ")}`);
    }

    await browser.close();
  } finally {
    for (const p of spawned.reverse()) {
      stopProcess(p);
    }
  }
}

main().catch((err) => {
  console.error("❌ Streamlit E2E failed:", err?.message ?? err);
  process.exit(1);
});
