import fs from "fs";
import path from "path";
import * as yaml from "js-yaml";
import { fileURLToPath } from "url";
import { SCHEMA_VERSION } from "../contracts/version.js";
import pg from "pg";
import { resolveWorkspaceContext, type WorkspaceContext } from "../workspace/context.js";
import { stableStringify, sha256Hex } from "../config/structuredLoader.js";
import { LaneFileConfigSchema, type LaneFileConfig } from "../lanes/contracts.js";
import { listActiveLaneRevisions, upsertLaneRevision, type ActiveLaneRevision } from "../lanes/registry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface LaneDefinition {
  title: string;
  description: string;
  threshold: number;
  semantic_threshold?: number;
  enabled_sources?: string[];
  title_families?: string[];
  keywords: string[];
  positive_concepts?: string[];
  negative_concepts?: string[];
  prototype_query: string;
}

export interface GlobalLanesConfig {
  version?: string;
  description?: string;
  lanes: Record<string, LaneDefinition>;
  unclassified_policy: {
    label: string;
    fallback_behavior: string;
    min_similarity_floor: number;
  };
}

interface LaneRegistryEntry {
  lane_key: string;
  config_file: string;
  enabled_by_default?: boolean;
}

interface LaneRegistryFile {
  schema_version?: string;
  config_version?: string;
  lanes: LaneRegistryEntry[];
}

function parseYamlFile<T>(filePath: string): T {
  const loadFn = (yaml as any).load || (yaml as any).default?.load || yaml;
  return loadFn(fs.readFileSync(filePath, "utf-8")) as T;
}

function normalizeConcept(concept: string): string {
  return concept.toLowerCase().replace(/_/g, " ").trim();
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.trim().length > 0))];
}

function laneConfigToDefinition(laneConfig: LaneFileConfig): LaneDefinition {
  const concepts = laneConfig.scope?.included_domain_concepts?.any || [];
  const requiredFunctions = laneConfig.scope?.required_function_concepts?.any || [];
  const excludedConcepts = laneConfig.scope?.excluded_domain_concepts?.any || [];

  const prototypeTexts = (laneConfig.prototypes || [])
    .map((p) => p.text.trim())
    .filter((p) => p.length > 0);

  const positiveConcepts = dedupe(
    (laneConfig.positive_concepts || concepts.map(normalizeConcept))
      .map((c) => c.trim())
  );
  const negativeConcepts = dedupe(
    (laneConfig.negative_concepts || excludedConcepts.map(normalizeConcept))
      .map((c) => c.trim())
  );

  return {
    title: laneConfig.display_name,
    description: laneConfig.description,
    threshold: laneConfig.routing?.minimum_semantic_score ?? laneConfig.semantic_threshold ?? 0.35,
    semantic_threshold: laneConfig.routing?.minimum_semantic_score ?? laneConfig.semantic_threshold ?? 0.35,
    enabled_sources: (laneConfig.sourcing?.enabled_sources || []).map((s) => s.toLowerCase()),
    title_families: dedupe(requiredFunctions.map(normalizeConcept)),
    keywords: dedupe(concepts.map(normalizeConcept)),
    positive_concepts: positiveConcepts,
    negative_concepts: negativeConcepts,
    prototype_query: prototypeTexts.join(" ") || laneConfig.description,
  };
}

export function loadGlobalLanesConfig(): GlobalLanesConfig {
  const registryPath = path.resolve(__dirname, "../../config/lanes/registry.yml");
  if (!fs.existsSync(registryPath)) {
    throw new Error(`Lane registry not found at ${registryPath}`);
  }

  const registry = parseYamlFile<LaneRegistryFile>(registryPath);
  if (!registry.lanes || registry.lanes.length === 0) {
    throw new Error("Lane registry contains no lanes.");
  }

  const lanes: Record<string, LaneDefinition> = {};

  for (const entry of registry.lanes) {
    if (entry.enabled_by_default === false) {
      continue;
    }

    const lanePath = path.resolve(__dirname, `../../config/lanes/${entry.config_file}`);
    if (!fs.existsSync(lanePath)) {
      throw new Error(`Lane config file not found for ${entry.lane_key}: ${lanePath}`);
    }

    const laneConfig = LaneFileConfigSchema.parse(parseYamlFile<LaneFileConfig>(lanePath));
    lanes[entry.lane_key] = laneConfigToDefinition(laneConfig);
  }

  return {
    version: registry.config_version || registry.schema_version || SCHEMA_VERSION,
    description: "Authoritative multi-lane definition and semantic threshold registry",
    lanes,
    unclassified_policy: {
      label: "UNCLASSIFIED",
      fallback_behavior: "DEFER_ROUTING",
      min_similarity_floor: 0.25,
    },
  };
}

export const loadLanesConfig = loadGlobalLanesConfig;

export async function loadWorkspaceLanesConfig(
  clientOrPool: pg.Pool | pg.PoolClient,
  options?: { context?: WorkspaceContext; seedIfEmpty?: boolean }
): Promise<{
  config: GlobalLanesConfig;
  source: "LANE_REGISTRY_DB" | "FILES";
  activeLaneRevisions?: ActiveLaneRevision[];
}> {
  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === "function" && !("release" in value);
  const ownsClient = isPool(clientOrPool);
  const client = ownsClient ? await clientOrPool.connect() : clientOrPool;

  try {
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));

    try {
      let active = await listActiveLaneRevisions(client as any, { context: ctx });

      if (active.length === 0 && options?.seedIfEmpty) {
        try {
          const registryPath = path.resolve(__dirname, "../../config/lanes/registry.yml");
          if (!fs.existsSync(registryPath)) {
            throw new Error(`Lane registry not found at ${registryPath}`);
          }

          const registry = parseYamlFile<LaneRegistryFile>(registryPath);
          for (const entry of registry.lanes || []) {
            if (entry.enabled_by_default === false) {
              continue;
            }

            const lanePath = path.resolve(__dirname, `../../config/lanes/${entry.config_file}`);
            if (!fs.existsSync(lanePath)) {
              throw new Error(`Lane config file not found for ${entry.lane_key}: ${lanePath}`);
            }

            const laneConfig = LaneFileConfigSchema.parse(parseYamlFile<LaneFileConfig>(lanePath));
            await upsertLaneRevision(
              { laneKey: entry.lane_key, content: laneConfig },
              client as any,
              { context: ctx, note: `seed from ${entry.config_file}` }
            );
          }

          active = await listActiveLaneRevisions(client as any, { context: ctx });
        } catch (seedErr: unknown) {
          console.warn(
            `⚠️ Failed to seed workspace lane registry from files; falling back to FILES. ` +
              `${seedErr instanceof Error ? seedErr.message : String(seedErr)}`
          );
          return { source: "FILES", config: loadGlobalLanesConfig() };
        }
      }

      if (active.length > 0) {
        const lanes: Record<string, LaneDefinition> = {};
        for (const lane of active) {
          const content = lane.content;
          // Prefer stable identity lane_key over editable content.lane_key.
          const key = lane.laneKey;
          lanes[key] = laneConfigToDefinition({
            ...content,
            lane_key: key,
          });
        }

        const versionSeed = active
          .map((l) => `${l.laneKey}:${l.revisionNumber}:${l.contentHash}`)
          .sort()
          .join("|");
        const version = `lanes_db_${sha256Hex(stableStringify(versionSeed)).slice(0, 12)}`;

        return {
          source: "LANE_REGISTRY_DB",
          activeLaneRevisions: active,
          config: {
            version,
            description: "Workspace lane revisions (registry-backed)",
            lanes,
            unclassified_policy: {
              label: "UNCLASSIFIED",
              fallback_behavior: "DEFER_ROUTING",
              min_similarity_floor: 0.25,
            },
          },
        };
      }
    } catch (err: any) {
      // Allow running against pre-migration databases.
      if (err?.code !== "42P01") {
        throw err;
      }
    }

    return { source: "FILES", config: loadGlobalLanesConfig() };
  } finally {
    if (ownsClient && typeof (client as any).release === "function") {
      (client as any).release();
    }
  }
}
