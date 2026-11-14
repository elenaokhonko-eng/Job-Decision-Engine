import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import dotenv from "dotenv";
import pg from "pg";
import { isPooledPostgresConnectionString, pgConnectionConfig } from "../src/db/pgSsl.js";
import { deriveDirectConnectionString } from "../src/api/v2/setupRouter.js";
import { runMigrations } from "../src/db/migrate.js";
import { seedEmbeddingSpaces } from "../src/embeddings/spaceRegistry.js";
import { loadWorkspaceLanesConfig } from "../src/pipeline/laneConfigLoader.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";
import {
  AI_PROVIDERS,
  listAiProviderIds,
  listProviderModels,
  normalizeAiProviderId,
  type AiProviderId,
} from "../src/services/aiProviders.js";

/**
 * One-command setup for the forkable repository.
 *
 * The documented path used to be: clone, `npm ci`, copy the env file, hand-edit
 * it, run `npm run migrate` (a script that does not exist), run
 * `npm run embeddings:registry:init` (also does not exist), then launch. That is
 * five manual steps with two dead ends. This script does the whole sequence and
 * refuses to continue on the first thing that does not work.
 *
 * Any PostgreSQL works: Neon, Supabase, Railway, RDS, a self-hosted server, or
 * the local Docker container this script can start for you. Neon is not
 * privileged — it is simply one of the URLs you can paste.
 *
 * Usage:
 *   npm run setup                 interactive
 *   npm run setup -- --docker     start the bundled Postgres container first
 *   npm run setup -- --database-url postgres://... --provider gemini --api-key ...
 *   npm run setup -- --help
 */

const MIN_NODE_MAJOR = 22;
const ENV_FILE = (process.env.JDEC_ENV_FILE || ".env.local").trim();
const DOCKER_COMPOSE_FILE = "docker-compose.yml";
// Matches docker-compose.yml: user/password/db default to `jdec`, port to 5432.
const DEFAULT_DOCKER_URL =
  `postgresql://${process.env.POSTGRES_USER || "jdec"}:${process.env.POSTGRES_PASSWORD || "jdec"}` +
  `@127.0.0.1:${process.env.POSTGRES_PORT || "5432"}/${process.env.POSTGRES_DB || "jdec"}`;

type ProviderId = AiProviderId;

interface CliOptions {
  databaseUrl?: string;
  directUrl?: string;
  provider?: ProviderId;
  apiKey?: string;
  baseUrl?: string;
  docker: boolean;
  yes: boolean;
  skipProviderCheck: boolean;
  help: boolean;
}

// Derived from the provider registry so there is exactly one source of truth
// for what a provider is called and which env var holds its key.
const PROVIDER_LABELS: Record<ProviderId, string> = Object.fromEntries(
  listAiProviderIds().map((id) => [id, AI_PROVIDERS[id].label])
) as Record<ProviderId, string>;

const PROVIDER_ENV_KEY: Record<ProviderId, string> = Object.fromEntries(
  listAiProviderIds().map((id) => [id, AI_PROVIDERS[id].apiKeyEnv])
) as Record<ProviderId, string>;

const PROVIDER_DEFAULT_BASE_URL = Object.fromEntries(
  listAiProviderIds()
    .filter((id) => Boolean(AI_PROVIDERS[id].defaultBaseUrl))
    .map((id) => [id, AI_PROVIDERS[id].defaultBaseUrl as string])
) as Partial<Record<ProviderId, string>>;

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    docker: false,
    yes: false,
    skipProviderCheck: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} needs a value.`);
      index += 1;
      return value;
    };

    switch (arg) {
      case "--database-url":
        options.databaseUrl = next();
        break;
      case "--direct-url":
        options.directUrl = next();
        break;
      case "--provider": {
        const raw = next();
        const value = normalizeAiProviderId(raw);
        if (!value) {
          throw new Error(`Unknown provider "${raw}". Use one of: ${listAiProviderIds().join(", ")}.`);
        }
        options.provider = value;
        break;
      }
      case "--api-key":
        options.apiKey = next();
        break;
      case "--base-url":
        options.baseUrl = next();
        break;
      case "--docker":
        options.docker = true;
        break;
      case "--yes":
      case "-y":
        options.yes = true;
        break;
      case "--skip-provider-check":
        options.skipProviderCheck = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument "${arg}". Run with --help to see the supported flags.`);
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`Job Decision Engine setup

  npm run setup                         Interactive setup (recommended)
  npm run setup -- --docker             Start local Postgres in Docker, then set up
  npm run setup -- --database-url <url> Skip the database prompt
  npm run setup -- --provider <id>      gemini | openai | openai-compatible (aliases: ollama, groq,
                                        together, openrouter, kimi, deepseek, vllm, lmstudio, google)
  npm run setup -- --api-key <key>      Skip the API key prompt
  npm run setup -- --base-url <url>     Base URL for an OpenAI-compatible provider
  npm run setup -- --yes                Accept defaults without confirming
  npm run setup -- --skip-provider-check  Do not verify the API key against the provider

Any PostgreSQL server works: Neon, Supabase, Railway, RDS, self-hosted, or Docker.
The connection string is written to ${ENV_FILE}, which is gitignored.`);
}

function fail(message: string): never {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

function step(index: number, total: number, message: string): void {
  console.log(`\n[${index}/${total}] ${message}`);
}

function checkNodeVersion(): void {
  const major = Number(process.versions.node.split(".")[0]);
  if (Number.isNaN(major) || major < MIN_NODE_MAJOR) {
    fail(`Node ${MIN_NODE_MAJOR}+ is required; this is Node ${process.versions.node}.`);
  }
  console.log(`  Node ${process.versions.node} OK`);
}

function redactConnectionString(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return "<unparseable connection string>";
  }
}

function readEnvFile(): Record<string, string> {
  const filePath = path.resolve(process.cwd(), ENV_FILE);
  if (!fs.existsSync(filePath)) return {};
  return dotenv.parse(fs.readFileSync(filePath, "utf8"));
}

/**
 * Merge new values into `.env.local` without discarding anything the user
 * already set. Values are written once each; comments and ordering survive.
 */
function writeEnvValues(values: Record<string, string>): void {
  const filePath = path.resolve(process.cwd(), ENV_FILE);
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const lines = existing.length > 0 ? existing.split(/\r?\n/) : [];
  const pending = new Map(Object.entries(values));

  const updated = lines.map((line) => {
    const match = /^([A-Z0-9_]+)=/.exec(line);
    if (!match) return line;
    const key = match[1];
    if (!pending.has(key)) return line;
    const value = pending.get(key)!;
    pending.delete(key);
    return `${key}=${quoteEnvValue(value)}`;
  });

  for (const [key, value] of pending) {
    updated.push(`${key}=${quoteEnvValue(value)}`);
  }

  fs.writeFileSync(filePath, `${updated.join("\n").replace(/\n+$/, "")}\n`, "utf8");
}

function quoteEnvValue(value: string): string {
  if (value === "" || /[\s#"']/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

async function startDockerPostgres(): Promise<string> {
  const composePath = path.resolve(process.cwd(), DOCKER_COMPOSE_FILE);
  if (!fs.existsSync(composePath)) {
    fail(
      `No ${DOCKER_COMPOSE_FILE} found, so the local database container cannot be started. ` +
        `Paste a PostgreSQL connection string instead.`
    );
  }

  const { spawnSync } = await import("node:child_process");
  const probe = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
  if (probe.status !== 0) {
    fail("Docker is not available. Install Docker Desktop, or paste an existing PostgreSQL connection string.");
  }

  console.log("  Starting the local Postgres container (docker compose up -d)...");
  const up = spawnSync("docker", ["compose", "up", "-d"], { stdio: "inherit" });
  if (up.status !== 0) {
    fail("docker compose up failed. See the output above.");
  }

  console.log("  Waiting for Postgres to accept connections...");
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const client = new pg.Client({ ...pgConnectionConfig(DEFAULT_DOCKER_URL), connectionTimeoutMillis: 3000 });
    try {
      await client.connect();
      await client.end();
      return DEFAULT_DOCKER_URL;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  fail("The Postgres container did not become ready within 60 seconds.");
}

async function verifyProvider(provider: ProviderId, apiKey: string, baseUrl?: string): Promise<string[]> {
  try {
    return await listProviderModels({ provider, apiKey, baseUrl });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

function printNextSteps(provider: ProviderId, modelCount: number): void {
  console.log("\n──────────────────────────────────────────────");
  console.log("Setup complete.");
  if (modelCount > 0) {
    console.log(`  Provider verified: ${modelCount} model(s) available.`);
  }
  console.log("\nNext steps:");
  console.log("  npm run desktop:dev      launch the desktop app in development");
  console.log("  npm run dev              run the local API + web UI");
  console.log("  npm run profile:import   load your CV / career facts from a file");
  console.log("  npm run test:streamlit   check the Streamlit dashboard wiring");
  console.log(`\nConfiguration lives in ${ENV_FILE} (gitignored).`);
  console.log(`Provider selected: ${PROVIDER_LABELS[provider]}`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  dotenv.config({ quiet: true });
  dotenv.config({ path: ENV_FILE, quiet: true });

  const totalSteps = 5;
  const rl = options.yes
    ? null
    : readline.createInterface({ input, output });
  const ask = async (question: string, fallback?: string): Promise<string> => {
    if (!rl) return fallback ?? "";
    const answer = (await rl.question(question)).trim();
    return answer.length > 0 ? answer : fallback ?? "";
  };

  try {
    step(1, totalSteps, "Checking Node version");
    checkNodeVersion();

    step(2, totalSteps, "Choosing a database");
    let databaseUrl = options.databaseUrl || process.env.DATABASE_URL || "";
    if (options.docker) {
      databaseUrl = await startDockerPostgres();
    } else if (!databaseUrl) {
      console.log("  Any PostgreSQL server works. Examples:");
      console.log("    Neon      postgresql://user:pass@ep-xxx-pooler.region.aws.neon.tech/db?sslmode=require");
      console.log("    Supabase  postgresql://postgres:pass@db.xxx.supabase.co:5432/postgres");
      console.log("    Docker    postgresql://jdec:jdec@127.0.0.1:5432/jdec");
      console.log("  No database yet? Re-run with --docker to start one locally.");
      databaseUrl = await ask("  PostgreSQL connection string: ");
      if (!databaseUrl) fail("A database connection string is required.");
    }
    console.log(`  Using ${redactConnectionString(databaseUrl)}`);

    const pooled = isPooledPostgresConnectionString(databaseUrl);
    const directUrl = options.directUrl
      || process.env.DATABASE_URL_UNPOOLED
      || (pooled ? deriveDirectConnectionString(databaseUrl) : databaseUrl);
    if (pooled) {
      console.log(`  Pooled host detected; migrations will use ${redactConnectionString(directUrl)}`);
    }

    step(3, totalSteps, "Connecting and applying migrations");
    const client = new pg.Client({ ...pgConnectionConfig(directUrl), connectionTimeoutMillis: 20000 });
    try {
      await client.connect();
    } catch (err) {
      fail(`Could not connect to PostgreSQL: ${err instanceof Error ? err.message : String(err)}`);
    }

    let provider: ProviderId = options.provider ?? "gemini";
    let modelCount = 0;

    try {
      const applied = await runMigrations(client);
      console.log(`  Applied ${applied.length} migration(s).`);

      const spaces = await seedEmbeddingSpaces(client);
      console.log(`  Embedding spaces seeded (${(spaces as { seeded?: number }).seeded ?? "ok"}).`);

      // Lane seeding is not fatal here: the app seeds from config/lanes on first
      // launch through the same `seedIfEmpty` path, so a workspace that is not
      // resolvable yet must not block an otherwise working install.
      try {
        const context = await resolveWorkspaceContext(client as never, {
          workspaceKey: process.env.WORKSPACE_KEY || "default",
          userKey: process.env.WORKSPACE_USER_KEY || "default",
        });
        const lanes = await loadWorkspaceLanesConfig(client as never, { context, seedIfEmpty: true });
        console.log(`  Lanes ready: ${Object.keys(lanes.config.lanes).length} active (source: ${lanes.source}).`);
      } catch (err) {
        console.warn(
          `  ⚠ Could not seed lanes yet (${err instanceof Error ? err.message : String(err)}). ` +
            `The app seeds them from config/lanes on first launch.`
        );
      }

      step(4, totalSteps, "Configuring the AI provider");
      if (!options.provider) {
        console.log("  Which provider will you use?");
        (Object.keys(PROVIDER_LABELS) as ProviderId[]).forEach((id, index) => {
          console.log(`    ${index + 1}. ${PROVIDER_LABELS[id]}`);
        });
        const choice = await ask("  Provider [1]: ", "1");
        const ids = Object.keys(PROVIDER_LABELS) as ProviderId[];
        provider = ids[Number(choice) - 1] ?? "gemini";
      }

      const baseUrl = options.baseUrl
        || process.env.OPENAI_COMPATIBLE_BASE_URL
        || (provider === "openai-compatible" ? await ask(`  Base URL [${PROVIDER_DEFAULT_BASE_URL["openai-compatible"]}]: `, PROVIDER_DEFAULT_BASE_URL["openai-compatible"]) : undefined);

      const envKeyName = PROVIDER_ENV_KEY[provider];
      let apiKey = options.apiKey || process.env[envKeyName] || "";
      if (!apiKey && provider !== "openai-compatible") {
        apiKey = await ask(`  ${envKeyName}: `);
      }
      if (!apiKey && provider === "openai-compatible") {
        // Local servers such as Ollama accept any non-empty token.
        apiKey = await ask("  API key (press Enter for local servers): ", "local");
      }

      if (!options.skipProviderCheck && apiKey) {
        try {
          const models = await verifyProvider(provider, apiKey, baseUrl);
          modelCount = models.length;
          console.log(`  Provider OK: ${modelCount} model(s) visible.`);
        } catch (err) {
          console.warn(
            `  ⚠ Could not verify the provider key: ${err instanceof Error ? err.message : String(err)}. ` +
              `Continuing; re-run with a valid key before evaluating jobs.`
          );
        }
      }

      step(5, totalSteps, `Writing ${ENV_FILE}`);
      const values: Record<string, string> = {
        DATABASE_URL: databaseUrl,
        DATABASE_URL_UNPOOLED: directUrl,
        [envKeyName]: apiKey,
      };
      if (provider === "openai-compatible" && baseUrl) {
        values.OPENAI_COMPATIBLE_BASE_URL = baseUrl;
      }
      writeEnvValues(values);
      console.log(`  Wrote ${Object.keys(values).join(", ")} to ${ENV_FILE}.`);
    } finally {
      await client.end().catch(() => undefined);
    }

    printNextSteps(provider, modelCount);
  } finally {
    rl?.close();
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
