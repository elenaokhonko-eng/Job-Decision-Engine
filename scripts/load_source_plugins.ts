import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import pg from "pg";
import { pgSslConfig } from "../src/db/pgSsl.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";
import { loadStructuredFile } from "../src/config/structuredLoader.js";
import { SourcePluginSchema } from "../src/contracts/index.js";
import { upsertSourcePluginRevision } from "../src/ingestion/sourcePluginRegistry.js";

dotenv.config();
dotenv.config({ path: ".env.local", override: true });

async function main(): Promise<void> {
  const databaseUrl = (process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required.");
  }

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: pgSslConfig(databaseUrl),
  });

  try {
    const ctx = await resolveWorkspaceContext(pool as any);

    const pluginsDir = path.resolve(process.cwd(), "config", "source-plugins");
    if (!fs.existsSync(pluginsDir)) {
      throw new Error(`Source plugin directory not found: ${pluginsDir}`);
    }

    const pluginFiles = fs
      .readdirSync(pluginsDir)
      .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
      .sort()
      .map((f) => path.join(pluginsDir, f));

    if (pluginFiles.length === 0) {
      console.warn(`No source plugin YAML files found under ${pluginsDir}`);
      return;
    }

    let activatedCount = 0;
    for (const filePath of pluginFiles) {
      const loaded = await loadStructuredFile(filePath, SourcePluginSchema);
      const result = await upsertSourcePluginRevision(loaded.data, pool, { context: ctx, activate: true });
      activatedCount += result.activated ? 1 : 0;
      console.log(
        `- ${loaded.data.source_key}: revision ${result.revisionNumber} (hash ${result.contentHash.slice(0, 12)}...)`
      );
    }

    console.log("Source plugin sync complete.");
    console.log(`- workspace: ${ctx.workspaceKey} (${ctx.workspaceId})`);
    console.log(`- plugins activated: ${activatedCount}/${pluginFiles.length}`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && process.argv[1].includes("load_source_plugins")) {
  main().catch((err) => {
    console.error("load_source_plugins failed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

