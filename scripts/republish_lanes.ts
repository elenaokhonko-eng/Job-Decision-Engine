import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import dotenv from "dotenv";
import * as yaml from "js-yaml";
import { pgPoolConfig } from "../src/db/pgSsl.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";
import { LaneFileConfigSchema, type LaneFileConfig } from "../src/lanes/contracts.js";
import { upsertLaneRevision, listActiveLaneRevisions } from "../src/lanes/registry.js";
import { buildEmbeddingInputs } from "../src/embeddings/inputBuilder.js";
import { runEmbeddingBatchWithFallback } from "../src/embeddings/batchCoordinator.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface LaneRegistryEntry {
  lane_key: string;
  config_file: string;
  enabled_by_default?: boolean;
}

interface LaneRegistryFile {
  lanes: LaneRegistryEntry[];
}

function parseYamlFile<T>(filePath: string): T {
  const loadFn = (yaml as any).load || (yaml as any).default?.load || yaml;
  return loadFn(fs.readFileSync(filePath, "utf-8")) as T;
}

export async function republishLanes(): Promise<{
  republished: Array<{ laneKey: string; revisionId: string; revisionNumber: number; contentHash: string }>;
  verifiedVectors: Array<{ laneKey: string; dimensions: number; provider: string; model: string }>;
}> {
  const databaseUrl = String(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");

  console.log("====================================================");
  console.log("    REPUBLISH ALL SIX LANES & GENERATE PROTOTYPES   ");
  console.log("====================================================");

  const pool = new pg.Pool(pgPoolConfig(databaseUrl));
  const ctx = await resolveWorkspaceContext(pool as any);
  console.log("Workspace ID:", ctx.workspaceId);

  const registryPath = path.resolve(__dirname, "../config/lanes/registry.yml");
  const registry = parseYamlFile<LaneRegistryFile>(registryPath);

  const republished: Array<{ laneKey: string; revisionId: string; revisionNumber: number; contentHash: string }> = [];

  // 1. Create fresh immutable revisions for all six lanes
  for (const entry of registry.lanes) {
    if (entry.enabled_by_default === false) continue;

    const lanePath = path.resolve(__dirname, `../config/lanes/${entry.config_file}`);
    const laneConfig = LaneFileConfigSchema.parse(parseYamlFile<LaneFileConfig>(lanePath));

    const result = await upsertLaneRevision(
      { laneKey: entry.lane_key, content: laneConfig },
      pool,
      { context: ctx, activate: true, note: `v4.2 calibration republish from ${entry.config_file}` }
    );

    republished.push({
      laneKey: entry.lane_key,
      revisionId: result.laneRevisionId,
      revisionNumber: result.revisionNumber,
      contentHash: result.contentHash,
    });
    console.log(`-> Lane ${entry.lane_key}: Revision #${result.revisionNumber} (${result.laneRevisionId.slice(0, 8)}) [hash: ${result.contentHash.slice(0, 10)}]`);
  }

  // 2. Build embedding inputs for active lane prototypes
  console.log("\nBuilding prototype embedding inputs...");
  const inputsSummary = await buildEmbeddingInputs(pool, 50, {
    context: ctx,
    includeLanePrototypes: true,
    includeProfileFacts: false,
  });
  console.log("Embedding inputs built:", inputsSummary);

  // 3. Generate prototype vectors in active embedding space
  console.log("\nGenerating prototype embeddings in active space...");
  try {
    const embedSummary = await runEmbeddingBatchWithFallback(50, pool, {
      context: ctx,
      includeLanePrototypes: true,
    });
    console.log("Embedding batch summary:", embedSummary);
  } catch (embedError: any) {
    console.warn("Embedding generation warning:", embedError?.message || embedError);
  }

  // 4. Verify all active lane revisions and vector availability
  console.log("\nVerifying active lane vectors in PostgreSQL...");
  const activeLanes = await listActiveLaneRevisions(pool, { context: ctx });

  const vectorQuery = `
    SELECT
      v.node_id AS lane_revision_id,
      es.provider,
      es.model,
      v.vector_dimensions
    FROM v_matchable_nodes v
    JOIN embedding_spaces es ON es.id = v.embedding_space_id
    WHERE v.workspace_id = $1
      AND v.node_type = 'LANE_PROTOTYPE'
      AND v.node_id = ANY($2::uuid[])
      AND es.active = TRUE
  `;
  const { rows: vectorRows } = await pool.query(vectorQuery, [
    ctx.workspaceId,
    activeLanes.map((l) => l.laneRevisionId),
  ]);

  const vectorByRevision = new Map(vectorRows.map((r) => [r.lane_revision_id, r]));
  const verifiedVectors: Array<{ laneKey: string; dimensions: number; provider: string; model: string }> = [];

  for (const lane of activeLanes) {
    const v = vectorByRevision.get(lane.laneRevisionId);
    if (!v) {
      console.warn(`⚠️ Warning: No vector found in active space for lane ${lane.laneKey} (revision ${lane.laneRevisionId})`);
    } else {
      verifiedVectors.push({
        laneKey: lane.laneKey,
        dimensions: Number(v.vector_dimensions),
        provider: String(v.provider),
        model: String(v.model),
      });
      console.log(`✅ Lane ${lane.laneKey}: Vector dimensions=${v.vector_dimensions}, provider=${v.provider}, model=${v.model}`);
    }
  }

  await pool.end();
  return { republished, verifiedVectors };
}

if (process.argv[1] && process.argv[1].includes("republish_lanes")) {
  republishLanes().catch((err) => {
    console.error("Republish lanes failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
