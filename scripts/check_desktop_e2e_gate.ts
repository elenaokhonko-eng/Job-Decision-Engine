import dotenv from "dotenv";
import pg from "pg";
import { pgPoolConfig } from "../src/db/pgSsl.js";
import { getMigrationStatus } from "../src/db/migrate.js";
import { resolveWorkspaceContext, DEFAULT_WORKSPACE_KEY, DEFAULT_USER_KEY } from "../src/workspace/context.js";
import { verifyDesktopPackaging } from "./verify_desktop_packaging.js";
import { startLocalServer } from "../src/desktop/localServer.js";

dotenv.config();
dotenv.config({ path: ".env.local", override: true });

export interface DesktopE2EGateInput {
  packagingPassed: boolean;
  localApiReachable: boolean;
  databaseConfigured: boolean;
  databaseConnected: boolean;
  schemaInitialized: boolean;
  migrationsPending: number;
  aiProviderConfigured: boolean;
  deadLetterTasks: number;
  blockedTasks: number;
}

export function evaluateDesktopE2EGate(input: DesktopE2EGateInput): string[] {
  const blockers: string[] = [];
  if (!input.packagingPassed) blockers.push("DESKTOP_PACKAGING_VERIFICATION_FAILED");
  if (!input.localApiReachable) blockers.push("LOCAL_COMPANION_API_UNREACHABLE");

  if (input.databaseConfigured) {
    if (!input.databaseConnected) blockers.push("DATABASE_CONNECTION_FAILED");
    if (!input.schemaInitialized) blockers.push("SCHEMA_NOT_INITIALIZED");
    if (input.migrationsPending > 0) blockers.push("SCHEMA_MIGRATIONS_PENDING");
  }

  if (input.deadLetterTasks > 0) blockers.push("PIPELINE_TASKS_DEAD_LETTERED");
  if (input.blockedTasks > 0) blockers.push("PIPELINE_TASKS_BLOCKED");

  return blockers;
}

export async function checkDesktopE2EGate(): Promise<{
  ok: boolean;
  blockers: string[];
  input: DesktopE2EGateInput;
  packagingFailures: string[];
}> {
  console.log("Evaluating Standalone Desktop E2E Gate...");

  // 1. Packaging verification
  const packaging = verifyDesktopPackaging();
  console.log(`Packaging verification: ${packaging.ok ? "PASS" : "FAIL"} (${packaging.checks.length} checks)`);

  // 2. Local companion API test
  let localApiReachable = false;
  let testServer: any = null;
  try {
    testServer = await startLocalServer({ port: 3299 });
    const resp = await fetch(`${testServer.apiBaseUrl}/setup/status`, {
      headers: { Authorization: `Bearer ${testServer.token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (resp.ok) {
      const data: any = await resp.json();
      localApiReachable = Boolean(data.ok);
    }
  } catch (err) {
    console.warn("Local API check failed:", err);
  } finally {
    if (testServer) {
      await testServer.close().catch(() => undefined);
    }
  }
  console.log(`Local companion server: ${localApiReachable ? "PASS" : "FAIL"}`);

  // 3. Database & Migrations
  const dbUrl = (process.env.DATABASE_URL || "").trim();
  const dbConfigured = Boolean(dbUrl);
  let dbConnected = false;
  let schemaInitialized = false;
  let pendingMigrations = 0;
  let deadLetters = 0;
  let blockedTasks = 0;

  if (dbConfigured) {
    let pool: pg.Pool | null = null;
    try {
      pool = new pg.Pool(pgPoolConfig(dbUrl));
      const client = await pool.connect();
      try {
        await client.query("SELECT 1");
        dbConnected = true;

        const status = await getMigrationStatus(client);
        schemaInitialized = status.isInitialized;
        pendingMigrations = status.pendingCount;

        if (schemaInitialized && pendingMigrations === 0) {
          const ctx = await resolveWorkspaceContext(client as any, {
            workspaceKey: DEFAULT_WORKSPACE_KEY,
            userKey: DEFAULT_USER_KEY,
          });

          // Check tasks
          const taskRes = await client.query(
            `SELECT 
               COUNT(*) FILTER (WHERE status = 'DEAD_LETTER') as dead_letters,
               COUNT(*) FILTER (WHERE status = 'BLOCKED') as blocked
             FROM pipeline_tasks WHERE workspace_id = $1`,
            [ctx.workspaceId]
          );
          deadLetters = Number.parseInt(taskRes.rows[0]?.dead_letters || "0", 10);
          blockedTasks = Number.parseInt(taskRes.rows[0]?.blocked || "0", 10);
        }
      } finally {
        client.release();
      }
    } catch (err) {
      console.warn("Database gate check error:", err);
    } finally {
      if (pool) await pool.end().catch(() => undefined);
    }
  }

  const aiConfigured = Boolean(
    process.env.GEMINI_API_KEY || process.env.GEMINI_FLASH_API_KEY || process.env.OPENAI_API_KEY
  );

  const input: DesktopE2EGateInput = {
    packagingPassed: packaging.ok,
    localApiReachable,
    databaseConfigured: dbConfigured,
    databaseConnected: dbConnected,
    schemaInitialized,
    migrationsPending: pendingMigrations,
    aiProviderConfigured: aiConfigured,
    deadLetterTasks: deadLetters,
    blockedTasks,
  };

  const blockers = evaluateDesktopE2EGate(input);
  const ok = blockers.length === 0;

  const report = {
    ok,
    blockers,
    input,
    packagingFailures: packaging.failures,
  };

  if (!ok) {
    console.error("Desktop E2E Gate Blockers:");
    blockers.forEach((b) => console.error(` - ${b}`));
  } else {
    console.log("Desktop E2E Gate PASSED.");
  }

  return report;
}

if (process.argv[1]?.includes("check_desktop_e2e_gate")) {
  checkDesktopE2EGate()
    .then((result) => {
      if (!result.ok) {
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error("Unexpected error checking desktop gate:", err);
      process.exit(1);
    });
}
