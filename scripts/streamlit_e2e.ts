import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import pg from "pg";
import { chromium } from "playwright";
import { pgPoolConfig } from "../src/db/pgSsl.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

type Spawned = {
  name: string;
  proc: ChildProcess;
};

interface DashboardSummaryRow extends pg.QueryResultRow {
  workspace_id: string;
  apply_now_count: number;
  track_count: number;
  processing_count: number;
  rejected_unmatched_count: number;
  applied_count: number;
  technical_errors: number;
  top_ten_ready_count: number;
}

interface DashboardMetrics {
  applyNow: number;
  track: number;
  processing: number;
  rejectedUnmatched: number;
  applied: number;
  technicalErrors: number;
  topTenReady: number;
}

async function readDashboardMetrics(
  databaseUrl: string,
  workspaceKey: string,
  userKey: string
): Promise<DashboardMetrics> {
  const client = new pg.Client(pgPoolConfig(databaseUrl));
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const summary = await client.query<DashboardSummaryRow>(
      `
        SELECT summary.workspace_id, summary.apply_now_count, summary.track_count,
               summary.processing_count, summary.rejected_unmatched_count,
               summary.applied_count, summary.technical_errors, summary.top_ten_ready_count
        FROM v_application_workspace_summary_scoped AS summary
        JOIN workspaces AS workspace ON workspace.id = summary.workspace_id
        WHERE workspace.workspace_key = $1 AND summary.user_key = $2
        LIMIT 1
      `,
      [workspaceKey, userKey]
    );
    const row = summary.rows[0];
    if (!row) throw new Error("No SQL dashboard summary exists for the configured workspace member.");
    const topTen = await client.query<{ count: number }>(
      "SELECT COUNT(*)::INTEGER AS count FROM v_top_ten_ready_jobs_scoped WHERE workspace_id = $1",
      [row.workspace_id]
    );
    await client.query("COMMIT");
    return {
      applyNow: row.apply_now_count,
      track: row.track_count,
      processing: row.processing_count,
      rejectedUnmatched: row.rejected_unmatched_count,
      applied: row.applied_count,
      technicalErrors: row.technical_errors,
      topTenReady: topTen.rows[0]?.count ?? 0,
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Dashboard SQL parity transaction and rollback both failed.");
    }
    throw error;
  } finally {
    await client.end();
  }
}

function metricFromAccessibilitySnapshot(snapshot: string, label: string): number {
  const marker = `- paragraph: ${label}`;
  const markerIndex = snapshot.indexOf(marker);
  if (markerIndex === -1) throw new Error(`Dashboard metric ${label} is not rendered.`);
  const value = snapshot.slice(markerIndex + marker.length).match(/^\s+- paragraph: "?([\d,]+)"?/);
  if (!value) throw new Error(`Dashboard metric ${label} has no rendered numeric value.`);
  return Number(value[1].replace(/,/g, ""));
}

function commandForPlatform(cmd: string): string {
  if (process.platform === "win32") {
    if (cmd === "python") {
      const configured = String(process.env.PYTHON_BIN || "").trim();
      if (configured) return configured;
      const projectVenv = path.join(process.cwd(), ".venv", "Scripts", "python.exe");
      if (fs.existsSync(projectVenv)) return projectVenv;
      return "python.exe";
    }
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

  const message = lastError instanceof Error ? lastError.message : String(lastError);
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
  const workspaceKey = process.env.WORKSPACE_KEY || "default";
  const userKey = process.env.WORKSPACE_USER_KEY || "local_user";

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
    WORKSPACE_KEY: workspaceKey,
    WORKSPACE_USER_KEY: userKey,
  };

  const spawned: Spawned[] = [];

  try {
    const api = spawnProcess(
      "api-v2",
      process.execPath,
      [path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), "scripts/start_api_v2.ts"],
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
    await page.getByRole("heading", { name: "Application command centre", exact: true }).waitFor({ timeout: 120_000 });
    await page.getByText("Top 10 — apply first", { exact: true }).waitFor({ timeout: 120_000 });
    await page.getByLabel("Opportunity category").waitFor({ timeout: 120_000 });
    await page.getByText(/Apply Now \(\d+\)/).waitFor({ timeout: 120_000 });

    const ariaSnapshot = await page.locator("body").ariaSnapshot({ mode: "default", depth: 12 });
    if (/Top 10 Ranked is unavailable|read model is unavailable|workspace summary is unavailable/i.test(ariaSnapshot)) {
      throw new Error("A V5 read model reported an error in the browser accessibility snapshot.");
    }
    const sqlMetrics = await readDashboardMetrics(databaseUrl, workspaceKey, userKey);
    const expectedMetrics: Array<[string, number]> = [
      ["Top 10 Ready", sqlMetrics.topTenReady],
      ["Apply Now", sqlMetrics.applyNow],
      ["Track", sqlMetrics.track],
      ["Processing", sqlMetrics.processing],
      ["Rejected / Unmatched", sqlMetrics.rejectedUnmatched],
      ["Applied", sqlMetrics.applied],
      ["Technical Errors", sqlMetrics.technicalErrors],
    ];
    for (const [label, expected] of expectedMetrics) {
      const actual = metricFromAccessibilitySnapshot(ariaSnapshot, label);
      if (actual !== expected) {
        throw new Error(`Dashboard metric ${label} mismatch: UI=${actual}, SQL=${expected}.`);
      }
    }
    fs.writeFileSync(reportPath, ariaSnapshot);
    await page.screenshot({
      path: path.join(exportDir, "application_command_centre_smoke.png"),
      fullPage: true,
    });

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
