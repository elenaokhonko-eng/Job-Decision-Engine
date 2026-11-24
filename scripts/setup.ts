import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";
import dotenv from "dotenv";
import { mergeEnvText } from "../src/config/envFile.js";
import { waitForPostgres, withDirectClient } from "../src/db/directClient.js";
import { runMigrations } from "../src/db/migrate.js";
import { seedEmbeddingSpaces } from "../src/embeddings/spaceRegistry.js";
import { loadWorkspaceLanesConfig } from "../src/pipeline/laneConfigLoader.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";
import { isPooledPostgresConnectionString } from "../src/db/pgSsl.js";
import { deriveDirectConnectionString } from "../src/api/v2/setupRouter.js";

/**
 * One-command setup: database, migrations, embedding spaces, lanes, provider key.
 *
 *   npm run setup             interactive
 *   npm run setup -- --docker start the bundled Postgres container first
 *   npm run setup -- --help
 *
 * Secrets are never taken from the command line (they would sit in shell history and in the
 * process list). Provide DATABASE_URL and the provider key through the environment or answer the
 * prompts. Values are written to the gitignored env file and never printed.
 */

const MIN_NODE_MAJOR = 22;
const ENV_FILE = (process.env.JDEC_ENV_FILE || ".env.local").trim();
const PROVIDERS = {
  gemini: { label: "Google Gemini", envKey: "GEMINI_API_KEY" },
  openai: { label: "OpenAI", envKey: "OPENAI_API_KEY" },
} as const;
type ProviderId = keyof typeof PROVIDERS;

function fail(message: string): never {
  console.error(`\nError: ${message}`);
  process.exit(1);
}

function redact(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return "<unparseable connection string>";
  }
}

function printHelp(): void {
  console.log(`Job Decision Engine setup

  npm run setup                Interactive setup
  npm run setup -- --docker    Start the local Postgres container (docker compose up -d), then set up
  npm run setup -- --yes       Accept defaults; DATABASE_URL and the provider key must be in the environment
  npm run setup -- --provider gemini|openai

Secrets are read from the environment (DATABASE_URL, GEMINI_API_KEY, OPENAI_API_KEY) or prompted for.
They are written to ${ENV_FILE}, which is gitignored, and are never printed.`);
}

function parseArgs(argv: string[]): { docker: boolean; yes: boolean; help: boolean; provider?: ProviderId } {
  const options: { docker: boolean; yes: boolean; help: boolean; provider?: ProviderId } = { docker: false, yes: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--docker") options.docker = true;
    else if (arg === "--yes" || arg === "-y") options.yes = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--provider") {
      const value = argv[index + 1];
      if (value !== "gemini" && value !== "openai") fail(`--provider must be one of: ${Object.keys(PROVIDERS).join(", ")}.`);
      options.provider = value;
      index += 1;
    } else {
      fail(`Unknown argument "${arg}". Run with --help to see the supported flags.`);
    }
  }
  return options;
}

function startDockerPostgres(): string {
  if (!fs.existsSync(path.resolve(process.cwd(), "docker-compose.yml"))) {
    fail("No docker-compose.yml found. Paste a PostgreSQL connection string instead.");
  }
  const probe = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
  if (probe.status !== 0) fail("Docker is not available. Install Docker Desktop or provide a PostgreSQL connection string.");
  const up = spawnSync("docker", ["compose", "up", "-d"], { stdio: "inherit" });
  if (up.status !== 0) fail("docker compose up failed. See the output above.");
  const user = encodeURIComponent(process.env.POSTGRES_USER || "jdec");
  const password = encodeURIComponent(process.env.POSTGRES_PASSWORD || "jdec");
  const db = encodeURIComponent(process.env.POSTGRES_DB || "jdec");
  return `postgresql://${user}:${password}@127.0.0.1:${process.env.POSTGRES_PORT || "5432"}/${db}`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return printHelp();

  dotenv.config({ quiet: true });
  dotenv.config({ path: ENV_FILE, quiet: true });

  const major = Number(process.versions.node.split(".")[0]);
  if (Number.isNaN(major) || major < MIN_NODE_MAJOR) fail(`Node ${MIN_NODE_MAJOR}+ is required; this is Node ${process.versions.node}.`);

  const rl = options.yes ? null : readline.createInterface({ input, output });
  const ask = async (question: string, fallback = ""): Promise<string> => {
    if (!rl) return fallback;
    const answer = (await rl.question(question)).trim();
    return answer || fallback;
  };

  try {
    console.log("\n[1/4] Database");
    let databaseUrl = process.env.DATABASE_URL || "";
    if (options.docker) {
      databaseUrl = startDockerPostgres();
      console.log("  Waiting for Postgres to accept connections...");
      await waitForPostgres(databaseUrl);
    } else if (!databaseUrl) {
      databaseUrl = await ask("  PostgreSQL connection string (any PostgreSQL works; --docker starts a local one): ");
    }
    if (!databaseUrl) fail("A PostgreSQL connection string is required (set DATABASE_URL or answer the prompt).");
    console.log(`  Using ${redact(databaseUrl)}`);

    const directUrl = process.env.DATABASE_URL_UNPOOLED
      || (isPooledPostgresConnectionString(databaseUrl) ? deriveDirectConnectionString(databaseUrl) : databaseUrl);

    console.log("\n[2/4] Migrations, embedding spaces and lanes");
    const result = await withDirectClient(directUrl, async (client) => {
      const applied = await runMigrations(client);
      const spaces = (await seedEmbeddingSpaces(client)) as { seeded?: unknown };
      // Lanes are also seeded on first launch, so a failure here is reported as a warning, not hidden.
      let lanes: { ok: true; active: number; source: string } | { ok: false; reason: string };
      try {
        const context = await resolveWorkspaceContext(client as never, {
          workspaceKey: process.env.WORKSPACE_KEY || "default",
          userKey: process.env.WORKSPACE_USER_KEY || "default",
        });
        const loaded = await loadWorkspaceLanesConfig(client as never, { context, seedIfEmpty: true });
        lanes = { ok: true, active: Object.keys(loaded.config.lanes).length, source: loaded.source };
      } catch (error) {
        lanes = { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
      return { migrationsApplied: applied.length, embeddingSpacesSeeded: typeof spaces.seeded === "number" ? spaces.seeded : null, lanes };
    });
    console.log(`  Applied ${result.migrationsApplied} migration(s); embedding spaces seeded: ${result.embeddingSpacesSeeded ?? "ok"}.`);
    if (result.lanes.ok) console.log(`  Lanes ready: ${result.lanes.active} active (source: ${result.lanes.source}).`);
    else console.warn(`  Warning: lanes were not seeded (${result.lanes.reason}). The app seeds them from config/lanes on first launch.`);


    console.log("\n[3/4] AI provider key");
    let provider: ProviderId = options.provider ?? "gemini";
    if (!options.provider && rl) {
      const choice = await ask("  Provider: 1) Google Gemini  2) OpenAI [1]: ", "1");
      provider = choice === "2" ? "openai" : "gemini";
    }
    const envKey = PROVIDERS[provider].envKey;
    const apiKey = process.env[envKey] || (await ask(`  ${envKey}: `));
    if (!apiKey) console.warn(`  ${envKey} is not set; add it to ${ENV_FILE} before evaluating jobs.`);

    console.log(`\n[4/4] Writing ${ENV_FILE}`);
    const values: Record<string, string> = { DATABASE_URL: databaseUrl, DATABASE_URL_UNPOOLED: directUrl };
    if (apiKey) values[envKey] = apiKey;
    const envPath = path.resolve(process.cwd(), ENV_FILE);
    const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
    fs.writeFileSync(envPath, mergeEnvText(existing, values), "utf8");
    console.log(`  Wrote ${Object.keys(values).join(", ")} to ${ENV_FILE}.`);

    console.log("\nSetup complete. Next: npm run models:check (verifies the configured model IDs), then npm run profile:import.");
  } finally {
    rl?.close();
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
